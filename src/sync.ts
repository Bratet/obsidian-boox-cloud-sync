import type { Manifest, SyncState, BooxSettings, SyncItem } from "./types";
import { hashHighlights, hashNotebook, hashMemo, hashString } from "./hash";
import { renderHighlightBook, renderNotebook, renderMemo } from "./render";
import { highlightPath, notebookPath, memoPath, filePath, assetPath } from "./paths";
import { bookKey, notebookKey, memoKey, fileKey, groupByBook } from "./state";
import type { VaultIO, ObjectFetcher } from "./ports";

export interface AssetDownload {
  ossKey: string;
  path: string;
}

export type SyncAction =
  | { kind: "note"; itemKey: string; path: string; content: string; hash: string; assets: AssetDownload[] }
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
    for (const nb of manifest.notebooks) {
      const key = notebookKey(nb.id);
      seen.add(key);
      const hash = hashNotebook(nb);
      const path = notebookPath(folder, nb.title);
      const assets: AssetDownload[] = nb.images.map((ossKey) => ({ ossKey, path: assetPath(folder, nb.id, ossKey) }));
      if (prev.items[key]?.hash === hash) continue;
      const content = renderNotebook(nb, assets.map((a) => a.path), hash, syncedAt);
      actions.push({ kind: "note", itemKey: key, path, content, hash, assets });
    }
  }

  if (settings.syncMemos) {
    for (const m of manifest.memos) {
      const key = memoKey(m.id);
      seen.add(key);
      const hash = hashMemo(m);
      const path = memoPath(folder, m.id);
      const assets: AssetDownload[] = m.images.map((ossKey) => ({ ossKey, path: assetPath(folder, m.id, ossKey) }));
      if (prev.items[key]?.hash === hash) continue;
      const content = renderMemo(m, assets.map((a) => a.path), hash, syncedAt);
      actions.push({ kind: "note", itemKey: key, path, content, hash, assets });
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
      } else if (a.kind === "file") {
        const bytes = await fetcher.object(a.ossKey);
        await io.writeBinary(a.path, bytes);
        items[a.itemKey] = { hash: a.hash, path: a.path, size: a.size };
        summary.downloaded++;
      } else {
        // delete
        if (await io.exists(a.path)) await io.remove(a.path);
        for (const assetPath of (a.assets ?? [])) {
          if (await io.exists(assetPath)) await io.remove(assetPath);
        }
        delete items[a.itemKey];
        summary.deleted++;
      }
    } catch (e: any) {
      summary.errors.push({ itemKey: a.itemKey, message: e?.message || String(e) });
    }
  }

  return { state: { version: prev.version, lastSync: prev.lastSync, items }, summary };
}
