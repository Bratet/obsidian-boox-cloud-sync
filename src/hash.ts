import type { Highlight, Notebook, Memo } from "./types";

// FNV-1a 32-bit — deterministic, fast, non-cryptographic. Used only for change
// detection, so collision risk is irrelevant at our scale.
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function hashHighlights(items: Highlight[]): string {
  const norm = [...items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((h) => `${h.id}|${h.chapter}|${h.page}|${h.quote}|${h.note}`)
    .join("");
  return hashString(norm);
}

// Bump when the on-disk notebook layout changes so already-synced notebooks
// are seen as changed and get rewritten (new files placed, old ones GC'd).
// v3: notebooks moved from a .md note + _assets/ images to bare per-notebook
// image folders (`Notebooks/<chain>/<Title>/<Title>_<n>.png`).
const NOTEBOOK_LAYOUT = "v3";

export function hashNotebook(nb: Notebook): string {
  // Images in device order, NOT sorted — pages are named by position, so a
  // reorder must re-emit even when the set of refs is unchanged. The content
  // sig catches stroke edits on existing pages, which change no ref at all.
  // The pdf ref joins the hash only when the backend sends one, so vaults on
  // the legacy image layout keep their hashes (no pointless re-download).
  return hashString(`${NOTEBOOK_LAYOUT}|${nb.title}|${nb.updatedAt}|${nb.pages}|${nb.sig ?? ""}|${nb.pdf ? `${nb.pdf}|` : ""}${nb.images.join(",")}`);
}

// Memos have their own layout version: v3 moved them from a .md note +
// _assets/ images to bare per-date image folders. Kept separate from
// NOTEBOOK_LAYOUT so bumping one doesn't force a re-download of the other.
const MEMO_LAYOUT = "v3";

export function hashMemo(m: Memo): string {
  // Images in device order, NOT sorted — pages are named by position, so a
  // reorder must re-emit even when the set of refs is unchanged. The content
  // sig catches stroke edits on existing pages, which change no ref at all.
  // The pdf ref joins the hash only when the backend sends one, so vaults on
  // the legacy image layout keep their hashes (no pointless re-download).
  return hashString(`${MEMO_LAYOUT}|${m.id}|${m.date ?? ""}|${m.pages}|${m.sig ?? ""}|${m.pdf ? `${m.pdf}|` : ""}${m.images.join(",")}`);
}
