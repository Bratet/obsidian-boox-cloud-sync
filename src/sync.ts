import type { Manifest, SyncState, BooxSettings, SyncItem } from "./types";
import { hashHighlights, hashNotebook, hashMemo, hashString } from "./hash";
import { renderHighlightBook } from "./render";
import { folderChain, sanitizeName, safeFolder, nameFromTemplate, formatDate, notebookDir, parentFolder } from "./paths";
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
    // set. A file `T.png`/`T.pdf` and a folder `T/` coexist, so the shapes
    // never collide with each other.
    const naturalDir = (nb: (typeof manifest.notebooks)[number]) =>
      notebookDir(nbName(nb), folderChain(folders, nb.folderId));
    const targetOf = (nb: (typeof manifest.notebooks)[number]) =>
      usePdf(nb) ? `${naturalDir(nb)}.pdf`
        : nb.images.length === 1 ? `${naturalDir(nb)}.png` : naturalDir(nb);
    const targetCount = new Map<string, number>();
    for (const nb of manifest.notebooks) {
      const t = targetOf(nb);
      targetCount.set(t.toLowerCase(), (targetCount.get(t.toLowerCase()) ?? 0) + 1);
    }
    for (const nb of manifest.notebooks) {
      const key = notebookKey(nb.id);
      seen.add(key);
      const hash = hashNotebook(nb);
      let dir = naturalDir(nb);
      if ((targetCount.get(targetOf(nb).toLowerCase()) ?? 0) > 1) {
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
      const t = targetOf(m);
      targetCount.set(t.toLowerCase(), (targetCount.get(t.toLowerCase()) ?? 0) + 1);
    }
    for (const m of manifest.memos) {
      const key = memoKey(m.id);
      seen.add(key);
      const hash = hashMemo(m);
      const base = memoName(m);
      const dir = (targetCount.get(targetOf(m).toLowerCase()) ?? 0) > 1 ? `${base} (${shortId(m.id, manifest.memos.map(n => n.id))})` : base;
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
    for (const key of Object.keys(prev.items)) {
      if (seen.has(key)) continue;
      if (!managedByEnabledType(key, settings)) continue;
      actions.push({ kind: "delete", itemKey: key, path: prev.items[key].path, assets: prev.items[key].assets ?? [] });
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
    if (path) owners.set(path.toLowerCase(), key);
  }
  const claimed = new Map<string, string>();
  for (const a of actions) {
    if (a.kind === "delete" || a.kind === "folder") continue;
    for (const path of a.kind === "images" ? a.assets.map(x => x.path) : [a.path, ...(a.kind === "note" ? a.assets.map(x => x.path) : [])]) claimed.set(path.toLowerCase(), a.itemKey);
  }
  for (const a of actions) {
    try {
      const old = prev.items[a.itemKey];
      const destinations = a.kind === "images" ? a.assets.map(x => x.path) : a.kind === "note" ? [a.path, ...a.assets.map(x => x.path)] : a.kind === "file" ? [a.path] : [];
      const previousPaths = old ? [old.path, ...(old.assets || [])].filter(Boolean) : [];
      let blocked = false;
      for (const path of destinations) {
        const owner = owners.get(path.toLowerCase());
        if ((owner && owner !== a.itemKey) || (!previousPaths.includes(path) && await io.exists(path))) {
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
        if (a.kind === "delete" && claimed.has(path.toLowerCase()) && claimed.get(path.toLowerCase()) !== a.itemKey) blocked = true;
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
        if (!previousPaths.includes(path) && await io.exists(path)) {
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
        await io.write(a.path, a.content);
        // GC stale assets: remove any previously-written asset not in the new set
        const newAssetPaths = new Set(a.assets.map((x) => x.path));
        for (const oldAssetPath of (prevItem?.assets ?? [])) {
          if (!newAssetPaths.has(oldAssetPath) && (await io.exists(oldAssetPath))) {
            await io.remove(oldAssetPath);
          }
        }
        // Rename cleanup: if the title changed, remove the now-orphaned old-path note
        if (prevItem && prevItem.path !== a.path && (await io.exists(prevItem.path))) {
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
        for (const asset of a.assets) {
          const bytes = staged.get(asset.path);
          if (!bytes) {
            if (await io.exists(asset.path)) { await io.remove(asset.path); emptied.add(parentFolder(asset.path)); }
            continue;
          }
          await io.writeBinary(asset.path, bytes);
          summary.downloaded++;
        }
        // GC assets that fell out of the set — deleted pages, or the whole
        // item moving folders (rename, collision suffix, old layout).
        const newAssetPaths = new Set(a.assets.map((x) => x.path));
        if (!keepOldNote) {
          for (const oldAssetPath of (prevItem?.assets ?? [])) {
            if (!newAssetPaths.has(oldAssetPath) && (await io.exists(oldAssetPath))) {
              await io.remove(oldAssetPath);
              emptied.add(parentFolder(oldAssetPath));
            }
          }
          // Migration from the note layout: the .md this item used to be.
          if (prevItem?.path && (await io.exists(prevItem.path))) {
            await io.remove(prevItem.path);
            emptied.add(parentFolder(prevItem.path));
          }
        }
        for (const dir of emptied) await rmdirIfEmpty(dir);
        items[a.itemKey] = { hash: a.hash, path: "", binaryHashes, assets: a.assets.map((x) => x.path) };
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

  return { state: { version: prev.version, lastSync: prev.lastSync, items }, summary };
}
