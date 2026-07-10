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

  it("emits file actions and per-page image downloads for notebooks", () => {
    const m = manifest({
      highlights: [],
      notebooks: [{ id: "n1", pages: 2, previewKey: "uid/note/n1/n1.png", images: ["render:n1/pA", "render:n1/pB"], title: "J", updatedAt: 1 }],
      files: [{ name: "p.pdf", size: 10, fmt: "pdf", key: "uid/msg/p" }],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const nb = a.find((x) => x.itemKey === notebookKey("n1"));
    expect(nb?.kind).toBe("images");
    expect(nb && nb.kind === "images" && nb.assets.map((x) => x.path)).toEqual([
      "BOOX/Notebooks/J/J_1.png",
      "BOOX/Notebooks/J/J_2.png",
    ]);
    // device page order is preserved: page 1 is the first image ref
    expect(nb && nb.kind === "images" && nb.assets[0].ossKey).toBe("render:n1/pA");
    const file = a.find((x) => x.kind === "file");
    expect(file && file.kind === "file" && file.path).toBe("BOOX/Files/p.pdf");
  });

  it("re-syncs notebooks stored under the previous note layout (migration)", () => {
    // A vault synced before notebooks became bare image folders holds items keyed
    // by the OLD hash formula (v2 note + _assets layout). The layout bump must make
    // planSync re-emit so pages land in the new folder and the .md + assets get GC'd.
    const oldNotebookHash = hashString("v2|T|5|1|render:n1/pA"); // pre-bump hashNotebook formula
    const m = manifest({
      highlights: [],
      notebooks: [{ id: "n1", pages: 1, previewKey: "uid/note/n1/n1.png", images: ["render:n1/pA"], title: "T", updatedAt: 5 }],
    });
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: {
        [notebookKey("n1")]: { hash: oldNotebookHash, path: "BOOX/Notebooks/T.md", assets: ["BOOX/_assets/n1/pA.png"] },
      },
    };
    const a = planSync(m, prev, settings(), SYNC);
    expect(a.find((x) => x.itemKey === notebookKey("n1"))?.kind).toBe("images");
  });

  it("re-syncs memos stored under the previous asset layout (migration)", () => {
    const oldMemoHash = hashString("m1|1|render:m1/0"); // pre-bump hashMemo formula
    const m = manifest({
      highlights: [],
      memos: [{ id: "m1", pages: 1, images: ["render:m1/0"] }],
    });
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: { [memoKey("m1")]: { hash: oldMemoHash, path: "BOOX/Memos/m1.md" } },
    };
    const a = planSync(m, prev, settings(), SYNC);
    expect(a.find((x) => x.itemKey === memoKey("m1"))?.kind).toBe("images");
  });

  it("skips an unchanged notebook (hash and image paths match)", () => {
    const m = manifest({
      highlights: [],
      notebooks: [{ id: "n1", pages: 1, previewKey: null, images: ["render:n1/pA"], title: "J", updatedAt: 1 }],
    });
    const first = planSync(m, emptyState(), settings(), SYNC);
    const nb = first.find((x) => x.itemKey === notebookKey("n1"));
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: {
        [notebookKey("n1")]: {
          hash: (nb as any).hash, path: "",
          assets: (nb as any).assets.map((x: any) => x.path),
        },
      },
    };
    expect(planSync(m, prev, settings(), SYNC)).toHaveLength(0);
  });

  it("emits per-date image downloads for calendar memos", () => {
    const m = manifest({
      highlights: [],
      memos: [{ id: "m1", pages: 2, images: ["render:m1/layA", "render:m1/layB"], date: "2026-06-11" }],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const memo = a.find((x) => x.itemKey === memoKey("m1"));
    expect(memo?.kind).toBe("images");
    expect(memo && memo.kind === "images" && memo.assets.map((x) => x.path)).toEqual([
      "BOOX/Calendar memo/20260611/20260611_1.png",
      "BOOX/Calendar memo/20260611/20260611_2.png",
    ]);
    // device page order is preserved: page 1 is the first image ref
    expect(memo && memo.kind === "images" && memo.assets[0].ossKey).toBe("render:m1/layA");
  });

  it("falls back to the memo id folder when the date is unknown", () => {
    const m = manifest({ highlights: [], memos: [{ id: "m9", pages: 1, images: ["render:m9/l"], date: null }] });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const memo = a.find((x) => x.itemKey === memoKey("m9"));
    expect(memo && memo.kind === "images" && memo.assets[0].path).toBe("BOOX/Calendar memo/m9/m9_1.png");
  });

  it("disambiguates two memos on the same date with an id suffix", () => {
    const m = manifest({
      highlights: [],
      memos: [
        { id: "aaaa1111bbbb", pages: 1, images: ["render:a/l"], date: "2026-06-11" },
        { id: "cccc2222dddd", pages: 1, images: ["render:c/l"], date: "2026-06-11" },
      ],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const path = (id: string) => {
      const x = a.find((y) => y.itemKey === memoKey(id));
      return x && x.kind === "images" ? x.assets[0].path : null;
    };
    expect(path("aaaa1111bbbb")).toBe("BOOX/Calendar memo/20260611 (aaaa1111)/20260611_1.png");
    expect(path("cccc2222dddd")).toBe("BOOX/Calendar memo/20260611 (cccc2222)/20260611_1.png");
  });

  it("skips an unchanged memo (hash and image paths match)", () => {
    const m = manifest({
      highlights: [],
      memos: [{ id: "m1", pages: 1, images: ["render:m1/l"], date: "2026-06-11" }],
    });
    const first = planSync(m, emptyState(), settings(), SYNC);
    const memo = first.find((x) => x.itemKey === memoKey("m1"));
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: {
        [memoKey("m1")]: {
          hash: (memo as any).hash, path: "",
          assets: (memo as any).assets.map((x: any) => x.path),
        },
      },
    };
    expect(planSync(m, prev, settings(), SYNC)).toHaveLength(0);
  });

  it("re-emits a memo whose content is unchanged but whose date folder moved", () => {
    // Same strokes, but the memo doc mirrored later and now carries a date —
    // the images must move from the id folder to the date folder.
    const undated = manifest({ highlights: [], memos: [{ id: "m1", pages: 1, images: ["render:m1/l"], date: null }] });
    const first = planSync(undated, emptyState(), settings(), SYNC);
    const memo = first.find((x) => x.itemKey === memoKey("m1"));
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: {
        [memoKey("m1")]: {
          hash: (memo as any).hash, path: "",
          assets: (memo as any).assets.map((x: any) => x.path),
        },
      },
    };
    const dated = manifest({ highlights: [], memos: [{ id: "m1", pages: 1, images: ["render:m1/l"], date: "2026-06-11" }] });
    const after = planSync(dated, prev, settings(), SYNC);
    const moved = after.find((x) => x.itemKey === memoKey("m1"));
    expect(moved && moved.kind === "images" && moved.assets[0].path)
      .toBe("BOOX/Calendar memo/20260611/20260611_1.png");
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
        { id: "n1", pages: 1, previewKey: null, images: ["render:n1/p"], title: "Week 2", updatedAt: 1, folderId: "fA" },
        { id: "n2", pages: 1, previewKey: null, images: ["render:n2/p"], title: "Loose", updatedAt: 1, folderId: null },
        { id: "n3", pages: 1, previewKey: null, images: ["render:n3/p"], title: "Orphan", updatedAt: 1, folderId: "gone" },
      ],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const path = (id: string) => { const x = a.find((y) => y.itemKey === notebookKey(id)); return x && x.kind === "images" ? x.assets[0].path : null; };
    // all single-page -> the one image sits directly in the chain, no folder
    expect(path("n1")).toBe("BOOX/Notebooks/Startup & SaaS/Alif Sessions/Week 2.png");
    expect(path("n2")).toBe("BOOX/Notebooks/Loose.png");
    expect(path("n3")).toBe("BOOX/Notebooks/Orphan.png"); // folder doc not synced -> root
  });

  it("single-page notebooks skip the folder; multi-page ones keep it", () => {
    const m = manifest({
      highlights: [],
      notebooks: [
        { id: "n1", pages: 1, previewKey: null, images: ["render:n1/p"], title: "Solo", updatedAt: 1 },
        { id: "n2", pages: 2, previewKey: null, images: ["render:n2/pA", "render:n2/pB"], title: "Duo", updatedAt: 1 },
      ],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const assets = (id: string) => { const x = a.find((y) => y.itemKey === notebookKey(id)); return x && x.kind === "images" ? x.assets.map((z) => z.path) : null; };
    expect(assets("n1")).toEqual(["BOOX/Notebooks/Solo.png"]);
    expect(assets("n2")).toEqual(["BOOX/Notebooks/Duo/Duo_1.png", "BOOX/Notebooks/Duo/Duo_2.png"]);
  });

  it("a single-page and a multi-page notebook with the same title don't collide", () => {
    // `J.png` (file) and `J/` (folder) coexist — no suffix needed on either.
    const m = manifest({
      highlights: [],
      notebooks: [
        { id: "aaaa1111bbbb", pages: 1, previewKey: null, images: ["render:a/p"], title: "J", updatedAt: 1 },
        { id: "cccc2222dddd", pages: 2, previewKey: null, images: ["render:c/pA", "render:c/pB"], title: "J", updatedAt: 1 },
      ],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const assets = (id: string) => { const x = a.find((y) => y.itemKey === notebookKey(id)); return x && x.kind === "images" ? x.assets.map((z) => z.path) : null; };
    expect(assets("aaaa1111bbbb")).toEqual(["BOOX/Notebooks/J.png"]);
    expect(assets("cccc2222dddd")).toEqual(["BOOX/Notebooks/J/J_1.png", "BOOX/Notebooks/J/J_2.png"]);
  });

  it("re-emits a notebook that grows past one page — image moves into a folder", () => {
    const one = manifest({
      highlights: [],
      notebooks: [{ id: "n1", pages: 1, previewKey: null, images: ["render:n1/pA"], title: "J", updatedAt: 1 }],
    });
    const first = planSync(one, emptyState(), settings(), SYNC);
    const nb = first.find((x) => x.itemKey === notebookKey("n1"));
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: {
        [notebookKey("n1")]: {
          hash: (nb as any).hash, path: "",
          assets: (nb as any).assets.map((x: any) => x.path),
        },
      },
    };
    const two = manifest({
      highlights: [],
      notebooks: [{ id: "n1", pages: 2, previewKey: null, images: ["render:n1/pA", "render:n1/pB"], title: "J", updatedAt: 2 }],
    });
    const after = planSync(two, prev, settings(), SYNC);
    const grown = after.find((x) => x.itemKey === notebookKey("n1"));
    expect(grown && grown.kind === "images" && grown.assets.map((x) => x.path)).toEqual([
      "BOOX/Notebooks/J/J_1.png",
      "BOOX/Notebooks/J/J_2.png",
    ]);
  });

  it("disambiguates same-folder title collisions with an id suffix", () => {
    // Two "Notebook-1"s in one device folder must not fight over a single image
    // folder; the same title in a DIFFERENT folder keeps its clean name.
    const nb = (id: string, folderId: string | null) =>
      ({ id, pages: 1, previewKey: null, images: [`render:${id}/p`], title: "Notebook-1", updatedAt: 1, folderId });
    const m = manifest({
      highlights: [],
      folders: [{ id: "f1", title: "Starter story", parentId: null }],
      notebooks: [nb("aaaa1111bbbb", "f1"), nb("cccc2222dddd", "f1"), nb("eeee3333ffff", null)],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const path = (id: string) => { const x = a.find((y) => y.itemKey === notebookKey(id)); return x && x.kind === "images" ? x.assets[0].path : null; };
    // single-page colliders: the id suffix lands on the image file itself
    expect(path("aaaa1111bbbb")).toBe("BOOX/Notebooks/Starter story/Notebook-1 (aaaa1111).png");
    expect(path("cccc2222dddd")).toBe("BOOX/Notebooks/Starter story/Notebook-1 (cccc2222).png");
    expect(path("eeee3333ffff")).toBe("BOOX/Notebooks/Notebook-1.png");
  });

  it("re-emits a notebook whose content is unchanged but whose folder moved", () => {
    // A pure move changes no content (same hash) — only the target paths. The
    // plan must still emit so the pages land in the new folder and executeSync's
    // asset GC removes the old ones.
    const nb = { id: "n1", pages: 1, previewKey: null, images: ["render:n1/p"], title: "T", updatedAt: 5 };
    const before = planSync(
      manifest({ highlights: [], notebooks: [{ ...nb, folderId: null }] }),
      emptyState(), settings(), SYNC);
    const prevItem = before.find((x) => x.itemKey === notebookKey("n1"));
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: {
        [notebookKey("n1")]: {
          hash: (prevItem as any).hash, path: "",
          assets: (prevItem as any).assets.map((x: any) => x.path),
        },
      },
    };
    const after = planSync(
      manifest({
        highlights: [],
        folders: [{ id: "f1", title: "New home", parentId: null }],
        notebooks: [{ ...nb, folderId: "f1" }],
      }),
      prev, settings(), SYNC);
    const moved = after.find((x) => x.itemKey === notebookKey("n1"));
    expect(moved && moved.kind === "images" && moved.assets[0].path)
      .toBe("BOOX/Notebooks/New home/T.png");
  });

  it("emits folder actions so empty device folders exist in the vault", () => {
    const m = manifest({
      highlights: [],
      folders: [
        { id: "fA", title: "Empty", parentId: null },
        { id: "fB", title: "Child", parentId: "fA" },
      ],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const path = (id: string) => {
      const x = a.find((y) => y.itemKey === `folder:${id}`);
      return x && x.kind === "folder" ? x.path : null;
    };
    expect(path("fA")).toBe("BOOX/Notebooks/Empty");
    expect(path("fB")).toBe("BOOX/Notebooks/Empty/Child");
  });

  it("skips an unchanged folder (prev path matches)", () => {
    const m = manifest({ highlights: [], folders: [{ id: "fA", title: "Empty", parentId: null }] });
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: { "folder:fA": { hash: "", path: "BOOX/Notebooks/Empty" } },
    };
    expect(planSync(m, prev, settings(), SYNC)).toHaveLength(0);
  });

  it("re-emits a folder whose title changed on the device", () => {
    const m = manifest({ highlights: [], folders: [{ id: "fA", title: "Renamed", parentId: null }] });
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: { "folder:fA": { hash: "", path: "BOOX/Notebooks/Old name" } },
    };
    const a = planSync(m, prev, settings(), SYNC);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("folder");
    expect(a[0].kind === "folder" && a[0].path).toBe("BOOX/Notebooks/Renamed");
  });

  it("folder actions follow the notebooks toggle", () => {
    const m = manifest({ highlights: [], folders: [{ id: "fA", title: "Empty", parentId: null }] });
    expect(planSync(m, emptyState(), settings({ syncNotebooks: false }), SYNC)).toHaveLength(0);
  });

  it("a device-deleted folder gets a delete action when deleteRemoved is on", () => {
    const prev: SyncState = {
      version: 1, lastSync: null,
      items: { "folder:gone": { hash: "", path: "BOOX/Notebooks/Gone" } },
    };
    const m = manifest({ highlights: [] });
    const del = planSync(m, prev, settings({ deleteRemoved: true }), SYNC);
    expect(del).toHaveLength(1);
    expect(del[0].kind).toBe("delete");
    expect(del[0].itemKey).toBe("folder:gone");
    // notebooks toggle off -> folder items are unmanaged, nothing is deleted
    expect(planSync(m, prev, settings({ deleteRemoved: true, syncNotebooks: false }), SYNC)).toHaveLength(0);
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
