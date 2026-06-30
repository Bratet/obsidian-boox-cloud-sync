// Characters Obsidian / the OS reject in note titles or that have wiki-link meaning.
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

export function sanitizeName(name: string): string {
  const cleaned = (name || "").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Untitled";
}

export function highlightPath(folder: string, bookTitle: string): string {
  return `${folder}/Highlights/${sanitizeName(bookTitle)}.md`;
}

export function notebookPath(folder: string, title: string): string {
  return `${folder}/Notebooks/${sanitizeName(title)}.md`;
}

export function memoPath(folder: string, id: string): string {
  return `${folder}/Memos/${sanitizeName(id)}.md`;
}

export function filePath(folder: string, name: string): string {
  return `${folder}/Files/${sanitizeName(name)}`;
}

export function assetPath(folder: string, id: string, ossKey: string): string {
  const base = sanitizeName(ossKey.split("/").pop() || "asset.png");
  return `${folder}/_assets/${sanitizeName(id)}/${base}`;
}

export function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}
