import { describe, it, expect } from "vitest";
import { renderHighlightBook } from "./render";
import type { Highlight } from "./types";

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
