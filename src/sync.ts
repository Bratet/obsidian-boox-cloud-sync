import type { Manifest, SyncState, BooxSettings, SyncItem } from "./types";
import { hashHighlights, hashNotebook, hashMemo, hashString } from "./hash";
import { renderHighlightBook } from "./render";
import { foldPath, folderChain, sanitizeName, safeFolder, nameFromTemplate, formatDate, notebookDir, parentFolder } from "./paths";
import { bookKey, notebookKey, folderKey, memoKey, fileKey, groupByBook } from "./state";
import { EmptyPageError } from "./handwriting";
import type { VaultIO, ObjectFetcher } from "./ports";

export interface AssetDownload {
  ossKey: string;
  path: string;
}

export type SyncAction =
  | { kind: "note"; itemKey: string; path: string; content: string; hash: string; assets: AssetDownload[] }
  | { kind: "images"; itemKey: string; hash: string; assets: AssetDownload[] } // bare images, no note
  | { kind: "folder"; itemKey: string; path: string } // a device folder's directory, even when empty
  | { kind: "file"; itemKey: string; ossKey: string; path: string; size: number | null; hash: string }
  | { kind: "delete"; itemKey: string; path: string; assets: string[] };

function managedByEnabledType(key: string, s: BooxSettings): boolean {
  if (key.startsWith("highlight-book:")) return s.syncHighlights;
  if (key.startsWith("notebook:")) return s.syncNotebooks;
  if (key.startsWith("folder:")) return s.syncNotebooks; // folders are the notebook hierarchy
  if (key.startsWith("memo:")) return s.syncMemos;
  if (key.startsWith("file:")) return s.syncFiles;
  return false;
}

export function planSync(
  manifest: Manifest,
  prev: SyncState,
  settings: BooxSettings,
  syncedAt: string,
): SyncAction[] {
  const actions: SyncAction[] = [];
  const seen = new Set<string>();
  const folder = safeFolder(settings.syncFolder);
  if (!folder) throw new Error("Choose a non-empty sync folder.");
  const category = (name: string, fallback: string) => `${folder}/${safeFolder(name || fallback)}`;
  const roots = {
    highlights: category(settings.highlightsFolder || "", "Highlights"),
    notebooks: category(settings.notebooksFolder || "", "Notebooks"),
    memos: category(settings.memosFolder || "", "Calendar memo"),
    files: category(settings.filesFolder || "", "Files"),
  };
  const nbName = (nb: Manifest["notebooks"][number]) => nameFromTemplate(settings.notebookName || "{title}", {
    title: nb.title, id: nb.id, date: formatDate(nb.updatedAt ? new Date(nb.updatedAt).toISOString().slice(0, 10) : null, settings.dateFormat),
  });
  const memoName = (m: Manifest["memos"][number]) => nameFromTemplate(settings.memoName || "{date}", {
    date: formatDate(m.date, settings.dateFormat) || m.id, id: m.id, title: "Memo",
  });
  const pageName = (title: string, id: string, page: number) => nameFromTemplate(settings.pageName || "{title}_{page}", { title, id, page });
  const folders = settings.preserveFolders === false ? [] : manifest.folders;
  const usePdf = (item: { pdf?: string | null }) => settings.exportFormat !== "png" && item.pdf;
  const shortId = (id: string, ids: string[]) => {
    let length = 8;
    while (length < id.length && ids.some(other => other !== id && other.slice(0, length) === id.slice(0, length))) length += 4;
    return sanitizeName(id.slice(0, length));
  };
  const collisionNames = (pairs: [string, string][]) => {
    const counts = new Map<string, number>();
    for (const [, name] of pairs) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) || 0) + 1);
    return new Map(pairs.map(([id, name]) => [id, counts.get(name.toLowerCase())! > 1 ? `${name} (${hashString(id)})` : name]));
  };
  const bookNames = collisionNames([...groupByBook(manifest.highlights)].map(([id, items]) => [id,
    nameFromTemplate(settings.highlightName || "{title}", { title: items[0]?.book || "Book", id })]));

  if (settings.syncHighlights) {
    for (const [bookId, items] of groupByBook(manifest.highlights)) {
      const key = bookKey(bookId);
      seen.add(key);
      const title = items[0]?.book || "Book";
      const hash = hashString(hashHighlights(items) + (settings.highlightTemplate || ""));
      const path = `${roots.highlights}/${bookNames.get(bookId)}.md`;
      if (prev.items[key]?.hash === hash && prev.items[key]?.path === path) continue;
      const content = renderHighlightBook(title, items, hash, syncedAt, settings.highlightTemplate);
      actions.push({ kind: "note", itemKey: key, path, content, hash, assets: [] });
    }
  }

  if (settings.syncNotebooks) {
    // A notebook whose manifest entry carries a `pdf` ref syncs as ONE bound
    // PDF directly in its device folder chain: <Title>.pdf. Older backends
    // send no ref — those notebooks keep the bare-image layout: one folder per
    // notebook, pages named <Title>_<n>.png in device order, single-page
    // notebooks sitting directly in the chain as <Title>.png. Two notebooks
    // landing on the same target (same title, same folder, same shape) get a
    // short id suffix — deterministically, on every member of the colliding
    // set. Targets are compared case-folded: the vault filesystem is
    // case-insensitive, so `Ideas.pdf` and `ideas.pdf` are one file there.
    // A file `T.png`/`T.pdf` and a folder `T/` coexist, so the shapes
    // never collide with each other.
    const naturalDir = (nb: (typeof manifest.notebooks)[number]) =>
      notebookDir(nbName(nb), folderChain(folders, nb.folderId));
    const targetOf = (nb: (typeof manifest.notebooks)[number]) =>
      usePdf(nb) ? `${naturalDir(nb)}.pdf`
        : nb.images.length === 1 ? `${naturalDir(nb)}.png` : naturalDir(nb);
    const targetCount = new Map<string, number>();
    for (const nb of manifest.notebooks) {
      const t = foldPath(targetOf(nb));
      targetCount.set(t, (targetCount.get(t) ?? 0) + 1);
    }
    for (const nb of manifest.notebooks) {
      const key = notebookKey(nb.id);
      seen.add(key);
      const hash = hashNotebook(nb);
      let dir = naturalDir(nb);
      if ((targetCount.get(foldPath(targetOf(nb))) ?? 0) > 1) {
        dir = notebookDir(`${nbName(nb)} (${shortId(nb.id, manifest.notebooks.map(n => n.id))})`,
          folderChain(folders, nb.folderId));
      }
      const base = nbName(nb);
      const assets: AssetDownload[] = usePdf(nb)
        ? [{ ossKey: nb.pdf!, path: `${roots.notebooks}/${dir}.pdf` }]
        : nb.images.length === 1
        ? [{ ossKey: nb.images[0], path: `${roots.notebooks}/${dir}.png` }]
        : nb.images.map((ossKey, i) => ({
            ossKey, path: `${roots.notebooks}/${dir}/${pageName(base, nb.id, i + 1)}.png`,
          }));
      // Content can be unchanged while the target paths move (device folder
      // move, collision suffix) — compare both before skipping.
      const prevItem = prev.items[key];
      if (prevItem?.hash === hash &&
          (prevItem.assets ?? []).join("\n") === assets.map((a) => a.path).join("\n")) continue;
      actions.push({ kind: "images", itemKey: key, hash, assets });
    }
    // Device folders are items in their own right: a folder holding no
    // notebooks would otherwise never materialize (directories are only
    // created as a side effect of writing files into them). Tracking them
    // also lets deleteRemoved drop the empty shell when the folder goes.
    for (const f of folders ?? []) {
      const key = folderKey(f.id);
      seen.add(key);
      const path = `${roots.notebooks}/${folderChain(folders, f.id).join("/")}`;
      if (prev.items[key]?.path === path) continue;
      actions.push({ kind: "folder", itemKey: key, path });
    }
  }

  if (settings.syncMemos) {
    // A memo whose manifest entry carries a `pdf` ref syncs as ONE bound PDF
    // named by its calendar day, directly in Calendar memo/. Older backends
    // send no ref — those memos keep the bare-image layout: one folder per
    // memo, pages named <day>_<n>.png in device order. Two memos on the same
    // day (shouldn't happen, but cloud data is messy) would collide on a
    // target — every member of a colliding set gets a short id suffix. A file
    // `D.pdf` and a folder `D/` coexist, so the shapes never collide.
    const targetOf = (m: (typeof manifest.memos)[number]) => {
      const d = memoName(m);
      return usePdf(m) ? `${d}.pdf` : d;
    };
    const targetCount = new Map<string, number>();
    for (const m of manifest.memos) {
      const t = foldPath(targetOf(m));
      targetCount.set(t, (targetCount.get(t) ?? 0) + 1);
    }
    for (const m of manifest.memos) {
      const key = memoKey(m.id);
      seen.add(key);
      const hash = hashMemo(m);
      const base = memoName(m);
      const dir = (targetCount.get(foldPath(targetOf(m))) ?? 0) > 1 ? `${base} (${shortId(m.id, manifest.memos.map(n => n.id))})` : base;
      const assets: AssetDownload[] = usePdf(m)
        ? [{ ossKey: m.pdf!, path: `${roots.memos}/${dir}.pdf` }]
        : m.images.map((ossKey, i) => ({
            ossKey, path: `${roots.memos}/${dir}/${pageName(base, m.id, i + 1)}.png`,
          }));
      // Content can be unchanged while the target paths move (a colliding memo
      // appeared and forced the suffix) — compare both before skipping.
      const prevItem = prev.items[key];
      if (prevItem?.hash === hash &&
          (prevItem.assets ?? []).join("\n") === assets.map((a) => a.path).join("\n")) continue;
      actions.push({ kind: "images", itemKey: key, hash, assets });
    }
  }

  if (settings.syncFiles) {
    const fileNames = collisionNames(manifest.files.map(f => {
      const full = f.name || f.key.split("/").pop() || "file.bin";
      const ext = full.includes(".") ? full.split(".").pop()! : f.fmt || "";
      const title = full.includes(".") ? full.slice(0, -(ext.length + 1)) : full;
      return [f.key, nameFromTemplate(settings.attachmentName || "{title}", { title, id: hashString(f.key), ext })];
    }));
    for (const f of manifest.files) {
      const key = fileKey(f.key);
      seen.add(key);
      const full = f.name || f.key.split("/").pop() || "file.bin";
      const ext = full.includes(".") ? full.split(".").pop()! : f.fmt || "";
      const path = `${roots.files}/${fileNames.get(f.key)}${ext ? `.${sanitizeName(ext)}` : ""}`;
      const hash = f.sig || String(f.size ?? "");
      const p = prev.items[key];
      if (p && p.size === f.size && p.path === path && p.hash === hash) continue;
      actions.push({ kind: "file", itemKey: key, ossKey: f.key, path, size: f.size, hash });
    }
  }

  if (settings.deleteRemoved) {
    // Paths the surviving items own, case-folded. A dead item can name the
    // same physical file as a live one on the case-insensitive vault (the
    // device replaced `visa documents` with `Visa documents`) — its delete
    // must not carry that path, or it removes the file the live item's write
    // just produced. Surviving paths come from this run's actions when the
    // item re-emitted, else from its unchanged prev entry.
    const livePaths = new Set<string>();
    for (const a of actions) {
      if (a.kind === "note" || a.kind === "folder" || a.kind === "file") livePaths.add(foldPath(a.path));
      if (a.kind === "note" || a.kind === "images") for (const x of a.assets) livePaths.add(foldPath(x.path));
    }
    for (const key of seen) {
      const p = prev.items[key];
      if (!p) continue;
      if (p.path) livePaths.add(foldPath(p.path));
      for (const x of p.assets ?? []) livePaths.add(foldPath(x));
    }
    for (const key of Object.keys(prev.items)) {
      if (seen.has(key)) continue;
      if (!managedByEnabledType(key, settings)) continue;
      const it = prev.items[key];
      const path = it.path && !livePaths.has(foldPath(it.path)) ? it.path : "";
      const assets = (it.assets ?? []).filter((x) => !livePaths.has(foldPath(x)));
      actions.push({ kind: "delete", itemKey: key, path, assets });
    }
  }

  const destinations = new Map<string, string>();
  for (const a of actions) {
    if (a.kind === "delete" || a.kind === "folder") continue;
    const paths = a.kind === "images" ? a.assets.map(x => x.path) : [a.path, ...(a.kind === "note" ? a.assets.map(x => x.path) : [])];
    for (const path of paths) {
      const prior = destinations.get(path.toLowerCase());
      if (prior) throw new Error(`Naming settings produce duplicate path: ${path}. Include {id} or {page} in the template.`);
      destinations.set(path.toLowerCase(), a.itemKey);
    }
  }
  return actions;
}

export interface SyncSummary {
  written: number;
  downloaded: number;
  deleted: number;
  skippedUserEdited: string[];
  errors: { itemKey: string; message: string }[];
}

export async function executeSync(
  actions: SyncAction[],
  prev: SyncState,
  io: VaultIO,
  fetcher: ObjectFetcher,
): Promise<{ state: SyncState; summary: SyncSummary }> {
  const items: Record<string, SyncItem> = { ...prev.items };
  const summary: SyncSummary = { written: 0, downloaded: 0, deleted: 0, skippedUserEdited: [], errors: [] };

  // Every path the previous state tracked, keyed by case-fold — regardless of
  // which item owned it. A write landing on a case-variant of any old file
  // (device replaced `visa documents` with `Visa documents`: different item,
  // same physical file on the case-insensitive vault) must clear the old
  // directory entry first, or the file keeps the stale name-case forever.
  const prevPathByFold = new Map<string, string>();
  for (const it of Object.values(prev.items)) {
    if (it.path) prevPathByFold.set(foldPath(it.path), it.path);
    for (const p of it.assets ?? []) prevPathByFold.set(foldPath(p), p);
  }

  // Removing the last file from a folder leaves an empty directory in the
  // vault; sweep those best-effort (rmdir throws on non-empty — that's fine)
  // and climb while parents keep emptying, so shells like a drained _assets/
  // vanish too. The climb stops at the sync root: its .boox-sync.json state
  // file keeps it non-empty.
  const rmdirIfEmpty = async (dir: string) => {
    if (!dir || !io.rmdir) return;
    try { await io.rmdir(dir); } catch { return; /* not empty or already gone */ }
    await rmdirIfEmpty(parentFolder(dir));
  };

  const binaryHash = async (bytes: ArrayBuffer) => {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
  };
  // Check every old and new destination before writing any part of an item.
  const owners = new Map<string, string>();
  for (const [key, item] of Object.entries(prev.items)) for (const path of [item.path, ...(item.assets || [])]) {
    if (path) owners.set(foldPath(path), key);
  }
  const claimed = new Map<string, string>();
  // Items this run deletes release their files: a device case-rename arrives
  // as delete(old item) + create(new item) on the same physical file.
  const releasing = new Set<string>();
  for (const a of actions) {
    if (a.kind === "delete") releasing.add(a.itemKey);
    if (a.kind === "delete" || a.kind === "folder") continue;
    for (const path of a.kind === "images" ? a.assets.map(x => x.path) : [a.path, ...(a.kind === "note" ? a.assets.map(x => x.path) : [])]) claimed.set(foldPath(path), a.itemKey);
  }
  for (const a of actions) {
    try {
      const old = prev.items[a.itemKey];
      const destinations = a.kind === "images" ? a.assets.map(x => x.path) : a.kind === "note" ? [a.path, ...a.assets.map(x => x.path)] : a.kind === "file" ? [a.path] : [];
      // A delete only touches what it will remove — planSync already dropped
      // paths a surviving item case-owns.
      const previousPaths = !old ? []
        : a.kind === "delete" ? [a.path, ...(a.assets ?? [])].filter(Boolean)
        : [old.path, ...(old.assets || [])].filter(Boolean);
      const previousFolded = new Set(previousPaths.map(foldPath));
      // A destination that exists is fine when we wrote it: this item's old
      // path (maybe in another case) or a file of an item deleted this run.
      const ours = (path: string) => {
        const owner = owners.get(foldPath(path));
        return previousFolded.has(foldPath(path)) || (!!owner && releasing.has(owner));
      };
      let blocked = false;
      for (const path of destinations) {
        const owner = owners.get(foldPath(path));
        if ((owner && owner !== a.itemKey && !releasing.has(owner)) || (!ours(path) && await io.exists(path))) {
          summary.skippedUserEdited.push(path); blocked = true;
        }
      }
      // Check known checksums before updates, renames, and deletions.
      for (const path of previousPaths) {
        if (!await io.exists(path)) continue;
        if (path === old?.path && old.written && a.kind !== "images") {
          if (hashString(await io.read(path)) !== old.written) { summary.skippedUserEdited.push(path); blocked = true; }
        } else if (old?.binaryHashes?.[path] && io.readBinary) {
          if (await binaryHash(await io.readBinary(path)) !== old.binaryHashes[path]) { summary.skippedUserEdited.push(path); blocked = true; }
        }
        if (a.kind === "delete" && claimed.has(foldPath(path)) && claimed.get(foldPath(path)) !== a.itemKey) blocked = true;
      }
      if (blocked) continue;
      const binaryHashes: Record<string, string> = {};
      const staged = new Map<string, ArrayBuffer | null>();
      const assets = a.kind === "images" || a.kind === "note" ? a.assets : a.kind === "file" ? [{ path: a.path, ossKey: a.ossKey }] : [];
      for (const asset of assets) {
        try {
          const bytes = await fetcher.object(asset.ossKey);
          staged.set(asset.path, bytes); binaryHashes[asset.path] = await binaryHash(bytes);
        } catch (e) {
          if (a.kind === "images" && e instanceof EmptyPageError) staged.set(asset.path, null);
          else throw e;
        }
      }
      // Legacy binary exports have no baseline. Adopt identical bytes, but keep
      // differing files rather than guessing whether the user annotated them.
      if (io.readBinary && old) for (const path of previousPaths) {
        if ((path === old.path && old.written) || a.kind === "folder" || a.itemKey.startsWith("folder:") || old.binaryHashes?.[path] || !await io.exists(path)) continue;
        if (a.kind === "delete" || !staged.get(path) || await binaryHash(await io.readBinary(path)) !== binaryHashes[path]) {
          summary.skippedUserEdited.push(path); blocked = true;
        }
      }
      if (blocked) continue;
      // Rendering/downloading can take minutes. Recheck after it finishes so
      // edits made while the sync was fetching are not overwritten.
      for (const path of destinations) {
        if (!ours(path) && await io.exists(path)) {
          summary.skippedUserEdited.push(path); blocked = true;
        }
      }
      for (const path of previousPaths) {
        if (!await io.exists(path)) continue;
        if (old?.binaryHashes?.[path] && io.readBinary && await binaryHash(await io.readBinary(path)) !== old.binaryHashes[path]) {
          summary.skippedUserEdited.push(path); blocked = true;
        }
        if (a.kind !== "images" && path === old?.path && old.written && hashString(await io.read(path)) !== old.written) {
          summary.skippedUserEdited.push(path); blocked = true;
        }
      }
      if (blocked) continue;
      if (a.kind === "note") {
        const prevItem = prev.items[a.itemKey];
        // Guard against overwriting user edits — check the file we previously wrote (prevItem.path),
        // not a.path, so a title-change (rename) correctly detects edits in the old file.
        if (prevItem?.written && (await io.exists(prevItem.path))) {
          const disk = await io.read(prevItem.path);
          if (hashString(disk) !== prevItem.written) {
            summary.skippedUserEdited.push(prevItem.path); // user edited since we wrote — preserve it
            continue;
          }
        }
        for (const asset of a.assets) {
          const bytes = staged.get(asset.path)!;
          await io.writeBinary(asset.path, bytes);
          summary.downloaded++;
        }
        // A case-only rename targets the SAME file on the case-insensitive
        // vault: clear the old directory entry first so the write creates the
        // new-case name instead of updating the old one — and never remove it
        // afterwards (that would delete the note just written).
        const caseOnlyRename = !!prevItem && prevItem.path !== a.path &&
          foldPath(prevItem.path) === foldPath(a.path);
        if (prevItem && caseOnlyRename && (await io.exists(prevItem.path))) {
          await io.remove(prevItem.path);
        }
        await io.write(a.path, a.content);
        // GC stale assets: remove any previously-written asset not in the new
        // set — compared case-folded, so a case-variant of a freshly written
        // asset is recognized as that same file and kept.
        const newAssetPaths = new Set(a.assets.map((x) => foldPath(x.path)));
        for (const oldAssetPath of (prevItem?.assets ?? [])) {
          if (!newAssetPaths.has(foldPath(oldAssetPath)) && (await io.exists(oldAssetPath))) {
            await io.remove(oldAssetPath);
          }
        }
        // Rename cleanup: if the title changed, remove the now-orphaned old-path note
        if (prevItem && prevItem.path !== a.path && !caseOnlyRename && (await io.exists(prevItem.path))) {
          await io.remove(prevItem.path);
        }
        items[a.itemKey] = {
          hash: a.hash,
          path: a.path,
          written: hashString(a.content),
          binaryHashes,
          assets: a.assets.map((x) => x.path),
        };
        summary.written++;
      } else if (a.kind === "images") {
        const prevItem = prev.items[a.itemKey];
        // Migration off the note layout: if the user edited the old .md since we
        // wrote it, keep it — and the assets it embeds — instead of deleting their
        // work. The new image layout is still written and becomes the managed state.
        let keepOldNote = false;
        if (prevItem?.written && prevItem.path && (await io.exists(prevItem.path))) {
          keepOldNote = hashString(await io.read(prevItem.path)) !== prevItem.written;
          if (keepOldNote) summary.skippedUserEdited.push(prevItem.path);
        }
        const emptied = new Set<string>();
        const missing: string[] = [];
        for (const asset of a.assets) {
          const bytes = staged.get(asset.path);
          if (!bytes) {
            // Nothing to render (every stroke erased on device; stale ref).
            // Any previously-written image here is outdated ink — drop it, and
            // record the gap so healMissingFiles knows it is intentional.
            missing.push(asset.path);
            if (await io.exists(asset.path)) { await io.remove(asset.path); emptied.add(parentFolder(asset.path)); }
            continue;
          }
          // Case-variant of a previously tracked file (any item): clear the
          // old directory entry just before writing so the file takes the
          // new-case name instead of silently keeping the old one.
          const oldCase = prevPathByFold.get(foldPath(asset.path));
          if (!keepOldNote && oldCase !== undefined && oldCase !== asset.path && (await io.exists(oldCase))) {
            await io.remove(oldCase);
          }
          await io.writeBinary(asset.path, bytes);
          summary.downloaded++;
        }
        // GC assets that fell out of the set — deleted pages, or the whole
        // item moving folders (rename, collision suffix, old layout). Compared
        // case-folded so a case-variant of a freshly written asset is
        // recognized as that same file and kept.
        const newAssetPaths = new Set(a.assets.map((x) => foldPath(x.path)));
        if (!keepOldNote) {
          for (const oldAssetPath of (prevItem?.assets ?? [])) {
            if (!newAssetPaths.has(foldPath(oldAssetPath)) && (await io.exists(oldAssetPath))) {
              await io.remove(oldAssetPath);
              emptied.add(parentFolder(oldAssetPath));
            }
          }
          // Migration from the note layout: the .md this item used to be.
          if (prevItem?.path && !newAssetPaths.has(foldPath(prevItem.path)) && (await io.exists(prevItem.path))) {
            await io.remove(prevItem.path);
            emptied.add(parentFolder(prevItem.path));
          }
        }
        for (const dir of emptied) await rmdirIfEmpty(dir);
        items[a.itemKey] = {
          hash: a.hash, path: "", binaryHashes, assets: a.assets.map((x) => x.path),
          ...(missing.length ? { missing } : {}),
        };
        summary.written++;
      } else if (a.kind === "folder") {
        if (io.mkdir && !(await io.exists(a.path))) await io.mkdir(a.path);
        // A rename/move leaves the old directory behind; the notebooks inside
        // move via their own actions — drop the shell once nothing lives there.
        const prevPath = prev.items[a.itemKey]?.path;
        if (prevPath && prevPath !== a.path) await rmdirIfEmpty(prevPath);
        items[a.itemKey] = { hash: "", path: a.path };
      } else if (a.kind === "file") {
        const bytes = staged.get(a.path)!;
        await io.writeBinary(a.path, bytes);
        if (old?.path && old.path !== a.path && await io.exists(old.path)) await io.remove(old.path);
        items[a.itemKey] = { hash: a.hash, path: a.path, size: a.size, binaryHashes };
        summary.downloaded++;
      } else {
        // delete — a folder item's path is a directory that may hold the
        // user's own files: only an empty shell is removed.
        if (a.itemKey.startsWith("folder:")) {
          await rmdirIfEmpty(a.path);
        } else if (a.path && (await io.exists(a.path))) {
          await io.remove(a.path);
        }
        const emptied = new Set<string>();
        for (const assetPath of (a.assets ?? [])) {
          if (await io.exists(assetPath)) await io.remove(assetPath);
          emptied.add(parentFolder(assetPath));
        }
        for (const dir of emptied) await rmdirIfEmpty(dir);
        delete items[a.itemKey];
        summary.deleted++;
      }
    } catch (e: any) {
      summary.errors.push({ itemKey: a.itemKey, message: e?.message || String(e) });
    }
  }

  return { state: { ...prev, items }, summary };
}

// A tracked file can vanish from the vault outside the plugin's control — the
// historic case-collision delete, a user pruning files, another tool. One-way
// sync means the cloud wins: re-arm any item whose files are gone so planSync
// re-emits it. Pages recorded as `missing` (device-erased, renderer 404) are
// intentional gaps, not losses. Folder and file items re-emit on a path
// mismatch rather than a hash mismatch, so they heal by clearing the path.
export async function healMissingFiles(prev: SyncState, io: VaultIO): Promise<SyncState> {
  const items: Record<string, SyncItem> = { ...prev.items };
  for (const [key, it] of Object.entries(prev.items)) {
    const intentional = new Set(it.missing ?? []);
    const expected = [
      ...(it.path ? [it.path] : []),
      ...(it.assets ?? []).filter((p) => !intentional.has(p)),
    ];
    let lost = false;
    for (const p of expected) {
      if (!(await io.exists(p))) { lost = true; break; }
    }
    if (!lost) continue;
    items[key] = key.startsWith("folder:") || key.startsWith("file:")
      ? { ...it, hash: "", path: "" }
      : { ...it, hash: "" };
  }
  return { ...prev, items };
}
