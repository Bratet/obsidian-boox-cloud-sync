import { describe, it, expect } from "vitest";
import { planSync } from "./sync";
import type { Manifest, SyncState, BooxSettings } from "./types";
import { emptyState, bookKey, notebookKey } from "./state";

const SYNC = "2026-06-30T00:00:00.000Z";

const settings = (over: Partial<BooxSettings> = {}): BooxSettings => ({
  backendUrl: "http://h", apiKey: "k", account: null, syncFolder: "BOOX", intervalMinutes: 30,
  syncHighlights: true, syncNotebooks: true, syncMemos: true, syncFiles: true, deleteRemoved: false, ...over,
});

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  account: { uid: "u1" }, notebooks: [], memos: [], files: [],
  highlights: [{ id: "h1", bookId: "b1", book: "My Book", quote: "q", note: "", chapter: "", page: 1 }],
  ...over,
});

describe("planSync", () => {
  it("emits a note action for a new highlight book", () => {
    const a = planSync(manifest(), emptyState(), settings(), SYNC);
    const note = a.find((x) => x.itemKey === bookKey("b1"));
    expect(note?.kind).toBe("note");
    expect(note && note.kind === "note" && note.path).toBe("BOOX/Highlights/My Book.md");
  });

  it("skips an unchanged book (prev hash matches)", () => {
    const first = planSync(manifest(), emptyState(), settings(), SYNC);
    const note = first[0];
    const prev: SyncState = { version: 1, lastSync: null, items: { [note.itemKey]: { hash: (note as any).hash, path: (note as any).path } } };
    expect(planSync(manifest(), prev, settings(), SYNC)).toHaveLength(0);
  });

  it("re-emits a note when the source changed", () => {
    const prev: SyncState = { version: 1, lastSync: null, items: { [bookKey("b1")]: { hash: "stale", path: "BOOX/Highlights/My Book.md" } } };
    expect(planSync(manifest(), prev, settings(), SYNC)).toHaveLength(1);
  });

  it("emits file actions and attaches notebook assets", () => {
    const m = manifest({
      highlights: [],
      notebooks: [{ id: "n1", pages: 1, previewKey: "uid/note/n1/n1.png", images: ["uid/note/n1/n1.png"], title: "J", updatedAt: 1 }],
      files: [{ name: "p.pdf", size: 10, fmt: "pdf", key: "uid/msg/p" }],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const nb = a.find((x) => x.itemKey === notebookKey("n1"));
    expect(nb && nb.kind === "note" && nb.assets[0].path).toBe("BOOX/_assets/n1/n1.png");
    const file = a.find((x) => x.kind === "file");
    expect(file && file.kind === "file" && file.path).toBe("BOOX/Files/p.pdf");
  });

  it("skips a file unchanged by size", () => {
    const m = manifest({ highlights: [], files: [{ name: "p.pdf", size: 10, fmt: "pdf", key: "uid/msg/p" }] });
    const prev: SyncState = { version: 1, lastSync: null, items: { "file:uid/msg/p": { hash: "10", path: "BOOX/Files/p.pdf", size: 10 } } };
    expect(planSync(m, prev, settings(), SYNC)).toHaveLength(0);
  });

  it("honours per-type toggles", () => {
    expect(planSync(manifest(), emptyState(), settings({ syncHighlights: false }), SYNC)).toHaveLength(0);
  });

  it("emits delete actions only when deleteRemoved is on", () => {
    const prev: SyncState = { version: 1, lastSync: null, items: { [bookKey("gone")]: { hash: "h", path: "BOOX/Highlights/Gone.md" } } };
    const m = manifest({ highlights: [] });
    expect(planSync(m, prev, settings({ deleteRemoved: false }), SYNC)).toHaveLength(0);
    const del = planSync(m, prev, settings({ deleteRemoved: true }), SYNC);
    expect(del[0].kind).toBe("delete");
    expect(del[0].itemKey).toBe(bookKey("gone"));
  });
});
