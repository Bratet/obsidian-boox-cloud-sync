import type { Manifest, SyncState, BooxSettings } from "./types";
import { hashHighlights, hashNotebook, hashMemo } from "./hash";
import { renderHighlightBook, renderNotebook, renderMemo } from "./render";
import { highlightPath, notebookPath, memoPath, filePath, assetPath } from "./paths";
import { bookKey, notebookKey, memoKey, fileKey, groupByBook } from "./state";

export interface AssetDownload {
  ossKey: string;
  path: string;
}

export type SyncAction =
  | { kind: "note"; itemKey: string; path: string; content: string; hash: string; assets: AssetDownload[] }
  | { kind: "file"; itemKey: string; ossKey: string; path: string; size: number | null; hash: string }
  | { kind: "delete"; itemKey: string; path: string };

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
      actions.push({ kind: "delete", itemKey: key, path: prev.items[key].path });
    }
  }

  return actions;
}
