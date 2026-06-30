import { describe, it, expect } from "vitest";
import {
  emptyState, parseState, serializeState, STATE_FILENAME,
  bookKey, notebookKey, memoKey, fileKey, groupByBook,
} from "./state";
import type { Highlight } from "./types";

describe("state serialization", () => {
  it("has the expected filename", () => {
    expect(STATE_FILENAME).toBe(".boox-sync.json");
  });
  it("round-trips a state", () => {
    const s = emptyState();
    s.items["notebook:n1"] = { hash: "h", path: "BOOX/Notebooks/x.md" };
    expect(parseState(serializeState(s)).items["notebook:n1"].hash).toBe("h");
  });
  it("returns an empty state for garbage input", () => {
    expect(parseState("not json").items).toEqual({});
    expect(parseState('{"items": null}').items).toEqual({});
  });
  it("forces the current version on parse", () => {
    expect(parseState('{"version": 99, "lastSync": null, "items": {}}').version).toBe(1);
  });
});

describe("key helpers + grouping", () => {
  it("builds namespaced item keys", () => {
    expect(bookKey("b1")).toBe("highlight-book:b1");
    expect(notebookKey("n1")).toBe("notebook:n1");
    expect(memoKey("m1")).toBe("memo:m1");
    expect(fileKey("uid/msg/k")).toBe("file:uid/msg/k");
  });
  it("groups highlights by bookId", () => {
    const hs: Highlight[] = [
      { id: "h1", bookId: "b1", book: "B1", quote: "", note: "n", chapter: "", page: null },
      { id: "h2", bookId: "b2", book: "B2", quote: "q", note: "", chapter: "", page: null },
      { id: "h3", bookId: "b1", book: "B1", quote: "q2", note: "", chapter: "", page: null },
    ];
    const g = groupByBook(hs);
    expect(g.get("b1")!.length).toBe(2);
    expect(g.get("b2")!.length).toBe(1);
  });
});
