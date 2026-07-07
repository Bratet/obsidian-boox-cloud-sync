import { describe, it, expect } from "vitest";
import { hashString, hashHighlights, hashNotebook, hashMemo } from "./hash";
import type { Highlight, Notebook, Memo } from "./types";

const hl = (over: Partial<Highlight>): Highlight => ({
  id: "h1", bookId: "b1", book: "Book", quote: "q", note: "", chapter: "", page: 1, ...over,
});

describe("hashString", () => {
  it("is deterministic and 8 hex chars", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
  it("differs for different input", () => {
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});

describe("hashHighlights", () => {
  it("is independent of input order", () => {
    const a = [hl({ id: "h1" }), hl({ id: "h2" })];
    const b = [hl({ id: "h2" }), hl({ id: "h1" })];
    expect(hashHighlights(a)).toBe(hashHighlights(b));
  });
  it("changes when a quote changes", () => {
    const a = [hl({ id: "h1", quote: "one" })];
    const b = [hl({ id: "h1", quote: "two" })];
    expect(hashHighlights(a)).not.toBe(hashHighlights(b));
  });
});

describe("hashNotebook / hashMemo", () => {
  const nb: Notebook = { id: "n1", pages: 2, previewKey: "k", images: ["a", "b"], title: "T", updatedAt: 5 };
  it("notebook hash changes when an image is added", () => {
    expect(hashNotebook(nb)).not.toBe(hashNotebook({ ...nb, images: ["a", "b", "c"] }));
  });
  it("notebook hash changes with page ORDER — pages are named by position", () => {
    expect(hashNotebook(nb)).not.toBe(hashNotebook({ ...nb, images: ["b", "a"] }));
  });
  it("notebook hash changes when the title changes — files are named by title", () => {
    expect(hashNotebook(nb)).not.toBe(hashNotebook({ ...nb, title: "Renamed" }));
  });
  it("notebook hash changes with the content signature — stroke edits don't change refs", () => {
    expect(hashNotebook({ ...nb, sig: "aaaa" })).not.toBe(hashNotebook({ ...nb, sig: "bbbb" }));
  });
  it("memo hash changes with the content signature — stroke edits don't change refs", () => {
    const m: Memo = { id: "m1", pages: 1, images: ["render:m1/a"], date: "2026-06-11", sig: "aaaa" };
    expect(hashMemo(m)).not.toBe(hashMemo({ ...m, sig: "bbbb" }));
  });
  it("memo hash changes with page count", () => {
    const m: Memo = { id: "m1", pages: 1, images: [] };
    expect(hashMemo(m)).not.toBe(hashMemo({ ...m, pages: 2 }));
  });
  it("memo hash changes with the calendar date", () => {
    const m: Memo = { id: "m1", pages: 1, images: ["render:m1/a"], date: "2026-06-11" };
    expect(hashMemo(m)).not.toBe(hashMemo({ ...m, date: "2026-06-12" }));
    expect(hashMemo(m)).not.toBe(hashMemo({ ...m, date: null }));
  });
  it("memo hash changes with page ORDER — pages are named by position", () => {
    const m: Memo = { id: "m1", pages: 2, images: ["render:m1/a", "render:m1/b"], date: "2026-06-11" };
    expect(hashMemo(m)).not.toBe(hashMemo({ ...m, images: ["render:m1/b", "render:m1/a"] }));
  });
});
