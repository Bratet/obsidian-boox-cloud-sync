import { describe, it, expect } from "vitest";
import { renderHighlightBook, renderNotebook, renderMemo } from "./render";
import type { Highlight, Notebook, Memo } from "./types";

const SYNC = "2026-06-30T00:00:00.000Z";

describe("renderHighlightBook", () => {
  const items: Highlight[] = [
    { id: "h1", bookId: "b1", book: "My Book", quote: "first quote", note: "my note", chapter: "Ch 1", page: 12 },
  ];
  it("emits frontmatter, a title and a quote callout with the note", () => {
    const md = renderHighlightBook("My Book", items, "abc123", SYNC);
    expect(md).toContain("boox-type: highlight-book");
    expect(md).toContain("boox-id: b1");
    expect(md).toContain("boox-updated: abc123");
    expect(md).toContain(`boox-synced: ${SYNC}`);
    expect(md).toContain("# My Book");
    expect(md).toContain("> [!quote] Ch 1 · p.12");
    expect(md).toContain("> first quote");
    expect(md).toContain("> my note");
  });
  it("is deterministic for fixed inputs", () => {
    expect(renderHighlightBook("My Book", items, "abc123", SYNC))
      .toBe(renderHighlightBook("My Book", items, "abc123", SYNC));
  });
});

describe("renderNotebook", () => {
  const nb: Notebook = { id: "n1", pages: 3, previewKey: "k", images: [], title: "Journal", updatedAt: 1 };
  it("embeds each asset path and shows the page count", () => {
    const md = renderNotebook(nb, ["BOOX/_assets/n1/n1.png"], "h", SYNC);
    expect(md).toContain("boox-type: notebook");
    expect(md).toContain("# Journal");
    expect(md).toContain("**Pages:** 3");
    expect(md).toContain("![[BOOX/_assets/n1/n1.png]]");
  });
});

describe("renderMemo", () => {
  it("embeds assets and a short id heading", () => {
    const m: Memo = { id: "c1abcdef00", pages: 1, images: [] };
    const md = renderMemo(m, ["BOOX/_assets/c1abcdef00/p.png"], "h", SYNC);
    expect(md).toContain("boox-type: memo");
    expect(md).toContain("# Memo c1abcdef");
    expect(md).toContain("![[BOOX/_assets/c1abcdef00/p.png]]");
  });
});
