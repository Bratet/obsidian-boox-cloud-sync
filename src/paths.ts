import type { BooxFolder } from "./types";

// Characters Obsidian / the OS reject in note titles or that have wiki-link meaning.
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

// Vaults live on case-insensitive (and Unicode-normalization-insensitive)
// filesystems by default — APFS, NTFS. Two paths that fold equal are the SAME
// file there. Every path comparison in the sync must go through this; writes
// never do (the vault keeps the display case).
export function foldPath(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

export function sanitizeName(name: string): string {
  let cleaned = (name || "").replace(ILLEGAL, " ").replace(/[\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned.slice(0, 140) || "Untitled";
}

export function safeFolder(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || parts.some(p => p === "." || p === ".." || p.trim().toLowerCase() === ".obsidian"))
    throw new Error("Use a vault-relative folder without dot segments or the .obsidian folder.");
  return parts.filter(Boolean).map(sanitizeName).join("/");
}
export function formatDate(date: string | null | undefined, pattern = "YYYYMMDD"): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  return pattern.replace(/YYYY|MM|DD/g, token => token === "YYYY" ? date.slice(0, 4) : token === "MM" ? date.slice(5, 7) : date.slice(8, 10));
}
export function nameFromTemplate(pattern: string, values: Record<string, string | number>): string {
  const unknown = [...pattern.matchAll(/\{([^}]+)\}/g)].filter(m => !(m[1] in values));
  if (unknown.length) throw new Error(`Unknown filename placeholder: ${unknown[0][0]}`);
  return sanitizeName(pattern.replace(/\{([^}]+)\}/g, (_, key) => String(values[key] ?? "")));
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

// Notebooks live as bare images, one folder per notebook nested in its device
// folder chain: a page is `Notebooks/<chain>/<Title>/<Title>_<n>.png`.
export function notebookDir(title: string, subdirs: string[] = []): string {
  const mid = subdirs.length ? `${subdirs.join("/")}/` : "";
  return `${mid}${sanitizeName(title)}`;
}

export function notebookImagePath(folder: string, dir: string, base: string, page: number): string {
  return `${folder}/Notebooks/${dir}/${base}_${page}.png`;
}

// A single-page notebook skips the folder — its one image sits directly in
// the chain as `Notebooks/<chain>/<Title>.png`.
export function notebookSingleImagePath(folder: string, dir: string): string {
  return `${folder}/Notebooks/${dir}.png`;
}

// A notebook served as one bound PDF sits directly in the chain as
// `Notebooks/<chain>/<Title>.pdf` — no per-notebook folder at all.
export function notebookPdfPath(folder: string, dir: string): string {
  return `${folder}/Notebooks/${dir}.pdf`;
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

// A memo served as one bound PDF sits directly as `Calendar memo/<day>.pdf` —
// no per-date folder at all.
export function memoPdfPath(folder: string, dir: string): string {
  return `${folder}/Calendar memo/${dir}.pdf`;
}

export function filePath(folder: string, name: string): string {
  return `${folder}/Files/${sanitizeName(name)}`;
}

export function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}
