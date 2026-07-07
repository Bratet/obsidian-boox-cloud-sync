import type { Manifest, SyncState, BooxSettings, SyncItem } from "./types";
import { hashHighlights, hashNotebook, hashMemo, hashString } from "./hash";
import { renderHighlightBook } from "./render";
import {
  highlightPath, filePath, folderChain, sanitizeName,
  memoFolderName, memoImagePath, notebookDir, notebookImagePath,
  notebookSingleImagePath, parentFolder,
} from "./paths";
import { bookKey, notebookKey, memoKey, fileKey, groupByBook } from "./state";
import type { VaultIO, ObjectFetcher } from "./ports";

export interface AssetDownload {
  ossKey: string;
  path: string;
}

export type SyncAction =
  | { kind: "note"; itemKey: string; path: string; content: string; hash: string; assets: AssetDownload[] }
  | { kind: "images"; itemKey: string; hash: string; assets: AssetDownload[] } // bare images, no note
  | { kind: "file"; itemKey: string; ossKey: string; path: string; size: number | null; hash: string }
  | { kind: "delete"; itemKey: string; path: string; assets: string[] };

function managedByEnabledType(key: string, s: BooxSettings): boolean {
  if (key.startsWith("highlight-book:")) return s.syncHighlights;
  if (key.startsWith("notebook:")) return s.syncNotebooks;
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
  const folder = settings.syncFolder;

  if (settings.syncHighlights) {
    for (const [bookId, items] of groupByBook(manifest.highlights)) {
      const key = bookKey(bookId);
      seen.add(key);
      const title = items[0]?.book || "Book";
      const hash = hashHighlights(items);
      const path = highlightPath(folder, title);
      if (prev.items[key]?.hash === hash) continue;
      const content = renderHighlightBook(title, items, hash, syncedAt);
      actions.push({ kind: "note", itemKey: key, path, content, hash, assets: [] });
    }
  }

  if (settings.syncNotebooks) {
    // Notebooks sync as bare images, like memos: one folder per notebook nested
    // in its device folder chain, pages named <Title>_<n>.png in device order.
    // A single-page notebook skips the folder — its one image sits directly in
    // the chain as <Title>.png. Two notebooks landing on the same target (same
    // title, same folder, same shape) get a short id suffix — deterministically,
    // on every member of the colliding set. A file `T.png` and a folder `T/`
    // coexist, so single- and multi-page notebooks never collide with each other.
    const naturalDir = (nb: (typeof manifest.notebooks)[number]) =>
      notebookDir(nb.title, folderChain(manifest.folders, nb.folderId));
    const targetOf = (nb: (typeof manifest.notebooks)[number]) =>
      nb.images.length === 1 ? `${naturalDir(nb)}.png` : naturalDir(nb);
    const targetCount = new Map<string, number>();
    for (const nb of manifest.notebooks) {
      const t = targetOf(nb);
      targetCount.set(t, (targetCount.get(t) ?? 0) + 1);
    }
    for (const nb of manifest.notebooks) {
      const key = notebookKey(nb.id);
      seen.add(key);
      const hash = hashNotebook(nb);
      let dir = naturalDir(nb);
      if ((targetCount.get(targetOf(nb)) ?? 0) > 1) {
        dir = notebookDir(`${nb.title} (${nb.id.slice(0, 8)})`,
          folderChain(manifest.folders, nb.folderId));
      }
      const base = sanitizeName(nb.title);
      const assets: AssetDownload[] = nb.images.length === 1
        ? [{ ossKey: nb.images[0], path: notebookSingleImagePath(folder, dir) }]
        : nb.images.map((ossKey, i) => ({
            ossKey, path: notebookImagePath(folder, dir, base, i + 1),
          }));
      // Content can be unchanged while the target paths move (device folder
      // move, collision suffix) — compare both before skipping.
      const prevItem = prev.items[key];
      if (prevItem?.hash === hash &&
          (prevItem.assets ?? []).join("\n") === assets.map((a) => a.path).join("\n")) continue;
      actions.push({ kind: "images", itemKey: key, hash, assets });
    }
  }

  if (settings.syncMemos) {
    // Calendar memos sync as bare images: one folder per memo named by its
    // calendar day, pages named <day>_<n>.png in device order. Two memos on
    // the same day (shouldn't happen, but cloud data is messy) would collide
    // on a folder — every member of a colliding set gets a short id suffix.
    const dirCount = new Map<string, number>();
    for (const m of manifest.memos) {
      const d = memoFolderName(m.date, m.id);
      dirCount.set(d, (dirCount.get(d) ?? 0) + 1);
    }
    for (const m of manifest.memos) {
      const key = memoKey(m.id);
      seen.add(key);
      const hash = hashMemo(m);
      const base = memoFolderName(m.date, m.id);
      const dir = (dirCount.get(base) ?? 0) > 1 ? `${base} (${m.id.slice(0, 8)})` : base;
      const assets: AssetDownload[] = m.images.map((ossKey, i) => ({
        ossKey, path: memoImagePath(folder, dir, base, i + 1),
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
    for (const f of manifest.files) {
      const key = fileKey(f.key);
      seen.add(key);
      const path = filePath(folder, f.name || f.key.split("/").pop() || "file.bin");
      const p = prev.items[key];
      if (p && p.size === f.size && p.path === path) continue;
      actions.push({ kind: "file", itemKey: key, ossKey: f.key, path, size: f.size, hash: String(f.size ?? "") });
    }
  }

  if (settings.deleteRemoved) {
    for (const key of Object.keys(prev.items)) {
      if (seen.has(key)) continue;
      if (!managedByEnabledType(key, settings)) continue;
      actions.push({ kind: "delete", itemKey: key, path: prev.items[key].path, assets: prev.items[key].assets ?? [] });
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

  for (const a of actions) {
    try {
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
          const bytes = await fetcher.object(asset.ossKey);
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
        for (const asset of a.assets) {
          const bytes = await fetcher.object(asset.ossKey);
          await io.writeBinary(asset.path, bytes);
          summary.downloaded++;
        }
        // GC assets that fell out of the set — deleted pages, or the whole
        // item moving folders (rename, collision suffix, old layout).
        const newAssetPaths = new Set(a.assets.map((x) => x.path));
        const emptied = new Set<string>();
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
        items[a.itemKey] = { hash: a.hash, path: "", assets: a.assets.map((x) => x.path) };
        summary.written++;
      } else if (a.kind === "file") {
        const bytes = await fetcher.object(a.ossKey);
        await io.writeBinary(a.path, bytes);
        items[a.itemKey] = { hash: a.hash, path: a.path, size: a.size };
        summary.downloaded++;
      } else {
        // delete
        if (a.path && (await io.exists(a.path))) await io.remove(a.path);
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
