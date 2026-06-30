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

// Bump when the on-disk asset layout changes so already-synced notebooks/memos
// are seen as changed and get rewritten (new embeds + assets, old ones GC'd).
// v2: render: asset files now carry a `.png` extension so Obsidian embeds them.
const ASSET_LAYOUT = "v2";

export function hashNotebook(nb: Notebook): string {
  return hashString(`${ASSET_LAYOUT}|${nb.title}|${nb.updatedAt}|${nb.pages}|${[...nb.images].sort().join(",")}`);
}

export function hashMemo(m: Memo): string {
  return hashString(`${ASSET_LAYOUT}|${m.id}|${m.pages}|${[...m.images].sort().join(",")}`);
}
