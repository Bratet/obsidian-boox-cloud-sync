import type { BooxFolder } from "./types";

// Characters Obsidian / the OS reject in note titles or that have wiki-link meaning.
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

export function sanitizeName(name: string): string {
  const cleaned = (name || "").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Untitled";
}

// Root→leaf directory names for a notebook's containing folder, sanitized for
// the vault. An unknown folderId means the folder doc hasn't synced (or was
// deleted) — fall back to the root rather than invent a directory. A missing
// parent link truncates the chain there; a corrupt parent cycle terminates.
export function folderChain(
  folders: BooxFolder[] | undefined,
  folderId: string | null | undefined,
): string[] {
  if (!folderId || !folders?.length) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(folderId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(sanitizeName(cur.title));
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

export function highlightPath(folder: string, bookTitle: string): string {
  return `${folder}/Highlights/${sanitizeName(bookTitle)}.md`;
}

export function notebookPath(folder: string, title: string, subdirs: string[] = []): string {
  const mid = subdirs.length ? `${subdirs.join("/")}/` : "";
  return `${folder}/Notebooks/${mid}${sanitizeName(title)}.md`;
}

// Calendar memos live as bare images, one folder per memo: the folder and the
// file prefix are the compact calendar day (20260611), so a page is
// `Calendar memo/20260611/20260611_2.png`. A memo whose CALENDAR_TREE doc
// hasn't mirrored yet has no date — its id names the folder until it does.
export function memoFolderName(date: string | null | undefined, id: string): string {
  const compact = (date ?? "").replace(/-/g, "");
  return compact || sanitizeName(id);
}

export function memoImagePath(folder: string, dir: string, base: string, page: number): string {
  return `${folder}/Calendar memo/${dir}/${base}_${page}.png`;
}

export function filePath(folder: string, name: string): string {
  return `${folder}/Files/${sanitizeName(name)}`;
}

export function assetPath(folder: string, id: string, ossKey: string): string {
  const last = ossKey.split("/").pop() || "asset.png";
  // `render:<id>/<page>` refs (server-rendered handwriting) carry no file
  // extension; Obsidian only embeds files with a recognized image extension,
  // so name the asset `<page>.png`. OSS keys already end in their extension.
  const base = ossKey.startsWith("render:") ? `${sanitizeName(last)}.png` : sanitizeName(last);
  return `${folder}/_assets/${sanitizeName(id)}/${base}`;
}

export function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}
