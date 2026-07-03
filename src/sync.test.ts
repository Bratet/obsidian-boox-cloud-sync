import { describe, it, expect } from "vitest";
import { planSync } from "./sync";
import { hashString } from "./hash";
import type { Manifest, SyncState, BooxSettings } from "./types";
import { emptyState, bookKey, notebookKey, memoKey } from "./state";

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

  it("re-syncs notebooks/memos stored under the previous asset layout (migration)", () => {
    // A vault synced before render: refs got a `.png` extension holds items keyed by the
    // OLD hash formula (no layout-version prefix). The layout bump must make planSync
    // re-emit so the broken extensionless embeds get rewritten and old assets GC'd.
    const oldNotebookHash = hashString("T|5|1|render:n1/pA"); // pre-bump hashNotebook formula
    const oldMemoHash = hashString("m1|1|render:m1/0"); // pre-bump hashMemo formula
    const m = manifest({
      highlights: [],
      notebooks: [{ id: "n1", pages: 1, previewKey: "uid/note/n1/n1.png", images: ["render:n1/pA"], title: "T", updatedAt: 5 }],
      memos: [{ id: "m1", pages: 1, images: ["render:m1/0"] }],
    });
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: {
        [notebookKey("n1")]: { hash: oldNotebookHash, path: "BOOX/Notebooks/T.md" },
        [memoKey("m1")]: { hash: oldMemoHash, path: "BOOX/Memos/m1.md" },
      },
    };
    const a = planSync(m, prev, settings(), SYNC);
    expect(a.find((x) => x.itemKey === notebookKey("n1"))?.kind).toBe("note");
    expect(a.find((x) => x.itemKey === memoKey("m1"))?.kind).toBe("note");
  });

  it("skips a file unchanged by size", () => {
    const m = manifest({ highlights: [], files: [{ name: "p.pdf", size: 10, fmt: "pdf", key: "uid/msg/p" }] });
    const prev: SyncState = { version: 1, lastSync: null, items: { "file:uid/msg/p": { hash: "10", path: "BOOX/Files/p.pdf", size: 10 } } };
    expect(planSync(m, prev, settings(), SYNC)).toHaveLength(0);
  });

  it("places notebooks in their device folder hierarchy", () => {
    const m = manifest({
      highlights: [],
      folders: [
        { id: "fB", title: "Startup & SaaS", parentId: null },
        { id: "fA", title: "Alif Sessions", parentId: "fB" },
      ],
      notebooks: [
        { id: "n1", pages: 1, previewKey: null, images: [], title: "Week 2", updatedAt: 1, folderId: "fA" },
        { id: "n2", pages: 1, previewKey: null, images: [], title: "Loose", updatedAt: 1, folderId: null },
        { id: "n3", pages: 1, previewKey: null, images: [], title: "Orphan", updatedAt: 1, folderId: "gone" },
      ],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const path = (id: string) => { const x = a.find((y) => y.itemKey === notebookKey(id)); return x && x.kind === "note" ? x.path : null; };
    expect(path("n1")).toBe("BOOX/Notebooks/Startup & SaaS/Alif Sessions/Week 2.md");
    expect(path("n2")).toBe("BOOX/Notebooks/Loose.md");
    expect(path("n3")).toBe("BOOX/Notebooks/Orphan.md"); // folder doc not synced -> root
  });

  it("disambiguates same-folder title collisions with an id suffix", () => {
    // Two "Notebook-1"s in one device folder must not fight over a single .md;
    // the same title in a DIFFERENT folder keeps its clean name.
    const nb = (id: string, folderId: string | null) =>
      ({ id, pages: 1, previewKey: null, images: [], title: "Notebook-1", updatedAt: 1, folderId });
    const m = manifest({
      highlights: [],
      folders: [{ id: "f1", title: "Starter story", parentId: null }],
      notebooks: [nb("aaaa1111bbbb", "f1"), nb("cccc2222dddd", "f1"), nb("eeee3333ffff", null)],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const path = (id: string) => { const x = a.find((y) => y.itemKey === notebookKey(id)); return x && x.kind === "note" ? x.path : null; };
    expect(path("aaaa1111bbbb")).toBe("BOOX/Notebooks/Starter story/Notebook-1 (aaaa1111).md");
    expect(path("cccc2222dddd")).toBe("BOOX/Notebooks/Starter story/Notebook-1 (cccc2222).md");
    expect(path("eeee3333ffff")).toBe("BOOX/Notebooks/Notebook-1.md");
  });

  it("re-emits a notebook whose content is unchanged but whose folder moved", () => {
    // A pure move changes no content (same hash) — only the target path. The
    // plan must still emit so the note gets rewritten at the new location and
    // executeSync's rename cleanup removes the old file.
    const nb = { id: "n1", pages: 1, previewKey: null, images: [], title: "T", updatedAt: 5 };
    const before = planSync(
      manifest({ highlights: [], notebooks: [{ ...nb, folderId: null }] }),
      emptyState(), settings(), SYNC);
    const prevItem = before.find((x) => x.itemKey === notebookKey("n1"));
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: { [notebookKey("n1")]: { hash: (prevItem as any).hash, path: (prevItem as any).path } },
    };
    const after = planSync(
      manifest({
        highlights: [],
        folders: [{ id: "f1", title: "New home", parentId: null }],
        notebooks: [{ ...nb, folderId: "f1" }],
      }),
      prev, settings(), SYNC);
    const note = after.find((x) => x.itemKey === notebookKey("n1"));
    expect(note && note.kind === "note" && note.path).toBe("BOOX/Notebooks/New home/T.md");
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

  it("planSync delete carries assets", () => {
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: { [bookKey("gone")]: { hash: "h", path: "BOOX/Highlights/Gone.md", assets: ["x.png"] } },
    };
    const m = manifest({ highlights: [] });
    const del = planSync(m, prev, settings({ deleteRemoved: true }), SYNC);
    expect(del).toHaveLength(1);
    const d = del[0];
    expect(d.kind).toBe("delete");
    expect(d.kind === "delete" && d.assets).toEqual(["x.png"]);
  });
});
