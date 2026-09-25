import { describe, it, expect } from "vitest";
import { planSync, executeSync, healMissingFiles, type SyncAction } from "./sync";
import { emptyState, notebookKey } from "./state";
import { hashString } from "./hash";
import type { Manifest, BooxSettings } from "./types";
import type { VaultIO, ObjectFetcher } from "./ports";
import { EmptyPageError } from "./handwriting";

// Obsidian vaults live on case-insensitive filesystems by default (APFS,
// NTFS): paths differing only in case are the SAME file. These are regression
// tests for the real-world wedge where a device-side case-rename made the
// plugin write a notebook's PDF and then delete it in the same run, leaving
// the vault permanently behind the backend.

const SYNC = "2026-07-29T00:00:00.000Z";

const settings = (over: Partial<BooxSettings> = {}): BooxSettings => ({
  account: null, syncFolder: "BOOX", intervalMinutes: 30,
  syncHighlights: true, syncNotebooks: true, syncMemos: true, syncFiles: true, deleteRemoved: false, ...over,
});

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  account: { uid: "u1" }, notebooks: [], memos: [], files: [], highlights: [], ...over,
});

const fetcher: ObjectFetcher = { object: async () => new TextEncoder().encode("BYTES").buffer };

const fold = (p: string) => p.normalize("NFC").toLowerCase();

// Name-preserving, case-insensitive — models the default APFS/NTFS vault
// volume: writing to an existing entry under a different case UPDATES that
// entry and keeps its original name, exactly like the real filesystem.
function apfsIO(seed: Record<string, string> = {}) {
  const files = new Map<string, { name: string; text?: string; bin?: ArrayBuffer }>();
  for (const [p, c] of Object.entries(seed)) files.set(fold(p), { name: p, text: c });
  const dirs = new Map<string, string>();
  const io: VaultIO = {
    exists: async (p) => files.has(fold(p)) || dirs.has(fold(p)),
    read: async (p) => files.get(fold(p))?.text ?? "",
    write: async (p, c) => {
      const cur = files.get(fold(p));
      files.set(fold(p), { name: cur?.name ?? p, text: c });
    },
    writeBinary: async (p, d) => {
      const cur = files.get(fold(p));
      files.set(fold(p), { name: cur?.name ?? p, bin: d });
    },
    remove: async (p) => void files.delete(fold(p)),
    mkdir: async (p) => void (dirs.has(fold(p)) || dirs.set(fold(p), p)),
    rmdir: async (p) => {
      for (const v of files.values()) if (fold(v.name).startsWith(`${fold(p)}/`)) throw new Error("directory not empty");
      dirs.delete(fold(p));
    },
  };
  return { io, names: () => [...files.values()].map((v) => v.name).sort(), get: (p: string) => files.get(fold(p)) };
}

describe("planSync on a case-insensitive vault", () => {
  it("titles differing only in case collide — every member gets an id suffix", () => {
    const m = manifest({
      notebooks: [
        { id: "n1a2b3c4d", pages: 1, previewKey: null, images: ["render:n1/p"], title: "Visa documents", updatedAt: 2, pdf: "pdf:n1" },
        { id: "n2a2b3c4d", pages: 1, previewKey: null, images: ["render:n2/p"], title: "visa documents", updatedAt: 1, pdf: "pdf:n2" },
      ],
    });
    const a = planSync(m, emptyState(), settings(), SYNC);
    const paths = a.filter((x) => x.kind === "images").map((x) => x.kind === "images" && x.assets[0].path);
    expect(paths).toEqual([
      "BOOX/Notebooks/Visa documents (n1a2b3c4).pdf",
      "BOOX/Notebooks/visa documents (n2a2b3c4).pdf",
    ]);
  });

  it("a dead item's delete drops paths a surviving item case-owns", () => {
    // Device: `visa documents` deleted, `Visa documents` created to replace it.
    // The dead item's asset is the SAME physical file as the live target — the
    // delete action must not carry it.
    const m = manifest({
      notebooks: [{ id: "n2", pages: 1, previewKey: null, images: ["render:n2/p"], title: "Visa documents", updatedAt: 2, pdf: "pdf:n2" }],
    });
    const prev = emptyState();
    prev.items[notebookKey("n1")] = { hash: "h", path: "", assets: ["BOOX/Notebooks/visa documents.pdf"] };
    const a = planSync(m, prev, settings({ deleteRemoved: true }), SYNC);
    const del = a.find((x) => x.kind === "delete" && x.itemKey === notebookKey("n1"));
    expect(del).toBeDefined();
    expect(del && del.kind === "delete" && del.assets).toEqual([]);
  });
});

describe("executeSync on a case-insensitive vault", () => {
  it("retries a partial case-rename without mistaking its own output for an edit", async () => {
    const { io, get, names } = apfsIO();
    io.readBinary = async path => get(path)!.bin!;
    const original: SyncAction = { kind: "images", itemKey: "notebook:n", hash: "old", assets: [
      { path: "BOOX/a.png", ossKey: "a" }, { path: "BOOX/b.png", ossKey: "b" },
    ] };
    const initial = await executeSync([original], emptyState(), io, fetcher);
    const write = io.writeBinary;
    io.writeBinary = async (path, bytes) => { if (path === "BOOX/B.png") throw new Error("disk full"); await write(path, bytes); };
    const update: SyncAction = { ...original, hash: "new", assets: [
      { path: "BOOX/A.png", ossKey: "a" }, { path: "BOOX/B.png", ossKey: "b" },
    ] };
    const changed = { object: async () => new TextEncoder().encode("updated").buffer };
    const failed = await executeSync([update], initial.state, io, changed);
    expect(failed.summary.errors).toHaveLength(1);
    io.writeBinary = write;
    const retry = await executeSync([update], await healMissingFiles(failed.state, io), io, changed);
    expect(retry.summary.skippedUserEdited).toEqual([]);
    expect(retry.summary.errors).toEqual([]);
    expect(names()).toEqual(["BOOX/A.png", "BOOX/B.png"]);
    expect(new TextDecoder().decode(get("BOOX/A.png")?.bin)).toBe("updated");
    expect(new TextDecoder().decode(get("BOOX/B.png")?.bin)).toBe("updated");
  });
  it("device case-rename end-to-end: the vault file survives under the new case", async () => {
    // The full July-28 wedge: one sync run sees the old notebook gone and the
    // new case-variant present. Before the fix, the delete removed the file
    // the images action had just written, and the state said "synced".
    const { io, names, get } = apfsIO({ "BOOX/Notebooks/visa documents.pdf": "old pdf" });
    const prev = emptyState();
    prev.items[notebookKey("old1")] = { hash: "h", path: "", assets: ["BOOX/Notebooks/visa documents.pdf"] };
    const m = manifest({
      notebooks: [{ id: "new1", pages: 1, previewKey: null, images: ["render:new1/p"], title: "Visa documents", updatedAt: 2, pdf: "pdf:new1" }],
    });
    const actions = planSync(m, prev, settings({ deleteRemoved: true }), SYNC);
    const { state } = await executeSync(actions, prev, io, fetcher);
    expect(names()).toEqual(["BOOX/Notebooks/Visa documents.pdf"]);
    expect(get("BOOX/Notebooks/Visa documents.pdf")?.bin).toBeDefined(); // the fresh download, not the old text
    expect(state.items[notebookKey("old1")]).toBeUndefined();
    expect(state.items[notebookKey("new1")]?.assets).toEqual(["BOOX/Notebooks/Visa documents.pdf"]);
  });

  it("a case-only title change moves the dir entry to the new case instead of self-deleting", async () => {
    const { io, names } = apfsIO({ "BOOX/Notebooks/ideas.pdf": "old" });
    const prev = emptyState();
    prev.items[notebookKey("n1")] = { hash: "old", path: "", assets: ["BOOX/Notebooks/ideas.pdf"] };
    const action: SyncAction = {
      kind: "images", itemKey: notebookKey("n1"), hash: "new",
      assets: [{ ossKey: "pdf:n1", path: "BOOX/Notebooks/Ideas.pdf" }],
    };
    const { state } = await executeSync([action], prev, io, fetcher);
    expect(names()).toEqual(["BOOX/Notebooks/Ideas.pdf"]);
    expect(state.items[notebookKey("n1")]?.assets).toEqual(["BOOX/Notebooks/Ideas.pdf"]);
  });

  it("a case-only note rename keeps the note", async () => {
    const oldPath = "BOOX/Highlights/my book.md";
    const { io, names, get } = apfsIO({ [oldPath]: "original we wrote" });
    const prev = emptyState();
    prev.items["highlight-book:b1"] = { hash: "old", path: oldPath, written: hashString("original we wrote") };
    const action: SyncAction = {
      kind: "note", itemKey: "highlight-book:b1", path: "BOOX/Highlights/My Book.md",
      content: "# new\n", hash: "new", assets: [],
    };
    await executeSync([action], prev, io, fetcher);
    expect(names()).toEqual(["BOOX/Highlights/My Book.md"]);
    expect(get("BOOX/Highlights/My Book.md")?.text).toBe("# new\n");
  });
});

describe("healMissingFiles", () => {
  it("re-arms an item whose tracked file vanished from disk", async () => {
    const { io } = apfsIO(); // nothing on disk
    const prev = emptyState();
    prev.items[notebookKey("n1")] = { hash: "h1", path: "", assets: ["BOOX/Notebooks/Gone.pdf"] };
    const healed = await healMissingFiles(prev, io);
    expect(healed.items[notebookKey("n1")].hash).toBe("");
  });

  it("leaves items alone when their files exist", async () => {
    const { io } = apfsIO({ "BOOX/Notebooks/Here.pdf": "x" });
    const prev = emptyState();
    prev.items[notebookKey("n1")] = { hash: "h1", path: "", assets: ["BOOX/Notebooks/Here.pdf"] };
    const healed = await healMissingFiles(prev, io);
    expect(healed.items[notebookKey("n1")].hash).toBe("h1");
  });

  it("ignores pages recorded as intentionally missing (device-erased, renderer 404)", async () => {
    const { io } = apfsIO({ "BOOX/Calendar memo/20260607/20260607_1.png": "ink" });
    const prev = emptyState();
    prev.items["memo:m1"] = {
      hash: "h1", path: "",
      assets: ["BOOX/Calendar memo/20260607/20260607_1.png", "BOOX/Calendar memo/20260607/20260607_2.png"],
      missing: ["BOOX/Calendar memo/20260607/20260607_2.png"],
    };
    const healed = await healMissingFiles(prev, io);
    expect(healed.items["memo:m1"].hash).toBe("h1");
  });

  it("heals folder and file items by clearing their path", async () => {
    const { io } = apfsIO();
    const prev = emptyState();
    prev.items["folder:f1"] = { hash: "", path: "BOOX/Notebooks/Gone dir" };
    prev.items["file:k1"] = { hash: "5", path: "BOOX/Files/gone.pdf", size: 5 };
    const healed = await healMissingFiles(prev, io);
    expect(healed.items["folder:f1"].path).toBe("");
    expect(healed.items["file:k1"].path).toBe("");
  });

  it("executeSync records ink-less pages as missing so heal ignores them", async () => {
    const notFound = new EmptyPageError();
    const picky: ObjectFetcher = {
      object: async (key) => {
        if (key === "render:m1/dead") throw notFound;
        return new TextEncoder().encode("BYTES").buffer;
      },
    };
    const { io } = apfsIO();
    const action: SyncAction = {
      kind: "images", itemKey: "memo:m1", hash: "h", assets: [
        { ossKey: "render:m1/live", path: "BOOX/Calendar memo/20260607/20260607_1.png" },
        { ossKey: "render:m1/dead", path: "BOOX/Calendar memo/20260607/20260607_2.png" },
      ],
    };
    const { state } = await executeSync([action], emptyState(), io, picky);
    expect(state.items["memo:m1"].missing).toEqual(["BOOX/Calendar memo/20260607/20260607_2.png"]);
    const healed = await healMissingFiles(state, io);
    expect(healed.items["memo:m1"].hash).toBe("h"); // not re-armed — the gap is intentional
  });
});
