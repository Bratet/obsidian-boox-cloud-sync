import type { Highlight, Notebook } from "./types";

function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

export function renderHighlightBook(
  bookTitle: string,
  items: Highlight[],
  idHash: string,
  syncedAt: string,
): string {
  const fm = frontmatter({
    "boox-id": items[0]?.bookId ?? "",
    "boox-type": "highlight-book",
    "boox-updated": idHash,
    "boox-synced": syncedAt,
  });
  const sorted = [...items].sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  const blocks = sorted.map((h) => {
    const head = [h.chapter, h.page != null ? `p.${h.page}` : ""].filter(Boolean).join(" · ");
    const lines = [`> [!quote] ${head}`.trimEnd()];
    for (const ql of (h.quote || "").split("\n")) lines.push(`> ${ql}`);
    if (h.note) {
      lines.push(">");
      for (const nl of h.note.split("\n")) lines.push(`> ${nl}`);
    }
    return lines.join("\n");
  });
  return `${fm}\n# ${bookTitle}\n\n${blocks.join("\n\n")}\n`;
}

export function renderNotebook(
  nb: Notebook,
  assetVaultPaths: string[],
  hash: string,
  syncedAt: string,
): string {
  const fm = frontmatter({
    "boox-id": nb.id,
    "boox-type": "notebook",
    "boox-updated": hash,
    "boox-synced": syncedAt,
  });
  const embeds = assetVaultPaths.map((p) => `![[${p}]]`).join("\n\n");
  return `${fm}\n# ${nb.title}\n\n**Pages:** ${nb.pages}\n\n${embeds}\n`;
}
