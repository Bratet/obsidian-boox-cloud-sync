import { describe, it, expect } from "vitest";
import { executeSync, type SyncAction } from "./sync";
import { emptyState } from "./state";
import { hashString } from "./hash";
import type { VaultIO, ObjectFetcher } from "./ports";

function fakeIO(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const bin = new Map<string, ArrayBuffer>();
  const removedDirs: string[] = [];
  const io: VaultIO = {
    exists: async (p) => files.has(p) || bin.has(p),
    read: async (p) => files.get(p) ?? "",
    write: async (p, c) => void files.set(p, c),
    writeBinary: async (p, d) => void bin.set(p, d),
    remove: async (p) => void (files.delete(p) || bin.delete(p)),
    rmdir: async (p) => {
      // like the real adapter: refuses to remove a non-empty directory
      for (const k of [...files.keys(), ...bin.keys()]) {
        if (k.startsWith(`${p}/`)) throw new Error("directory not empty");
      }
      removedDirs.push(p);
    },
  };
  return { io, files, bin, removedDirs };
}

const fetcher: ObjectFetcher = { object: async () => new TextEncoder().encode("BYTES").buffer };

describe("executeSync", () => {
  it("writes a note, downloads its assets, and records the written hash", async () => {
    const { io, files, bin } = fakeIO();
    const action: SyncAction = {
      kind: "note", itemKey: "notebook:n1", path: "BOOX/Notebooks/J.md", content: "# J\n",
      hash: "h", assets: [{ ossKey: "uid/note/n1/n1.png", path: "BOOX/_assets/n1/n1.png" }],
    };
    const { state, summary } = await executeSync([action], emptyState(), io, fetcher);
    expect(files.get("BOOX/Notebooks/J.md")).toBe("# J\n");
    expect(bin.has("BOOX/_assets/n1/n1.png")).toBe(true);
    expect(summary.written).toBe(1);
    expect(summary.downloaded).toBe(1);
    expect(state.items["notebook:n1"].written).toBe(hashString("# J\n"));
  });

  it("preserves a user-edited note instead of overwriting it", async () => {
    const path = "BOOX/Notebooks/J.md";
    const { io, files } = fakeIO({ [path]: "user changed this" });
    const prev = emptyState();
    prev.items["notebook:n1"] = { hash: "old", path, written: hashString("original we wrote") };
    const action: SyncAction = { kind: "note", itemKey: "notebook:n1", path, content: "# new\n", hash: "new", assets: [] };
    const { summary } = await executeSync([action], prev, io, fetcher);
    expect(files.get(path)).toBe("user changed this"); // untouched
    expect(summary.skippedUserEdited).toContain(path);
    expect(summary.written).toBe(0);
  });

  it("downloads a file action as binary", async () => {
    const { io, bin } = fakeIO();
    const action: SyncAction = { kind: "file", itemKey: "file:k", ossKey: "uid/msg/k", path: "BOOX/Files/p.pdf", size: 5, hash: "5" };
    const { state, summary } = await executeSync([action], emptyState(), io, fetcher);
    expect(bin.has("BOOX/Files/p.pdf")).toBe(true);
    expect(summary.downloaded).toBe(1);
    expect(state.items["file:k"].size).toBe(5);
  });

  it("deletes a vanished item and drops it from state", async () => {
    const path = "BOOX/Highlights/Gone.md";
    const { io, files } = fakeIO({ [path]: "x" });
    const prev = emptyState();
    prev.items["highlight-book:gone"] = { hash: "h", path };
    const action: SyncAction = { kind: "delete", itemKey: "highlight-book:gone", path, assets: [] };
    const { state, summary } = await executeSync([action], prev, io, fetcher);
    expect(files.has(path)).toBe(false);
    expect(state.items["highlight-book:gone"]).toBeUndefined();
    expect(summary.deleted).toBe(1);
  });

  it("carries forward unchanged prior items", async () => {
    const prev = emptyState();
    prev.items["notebook:keep"] = { hash: "h", path: "BOOX/Notebooks/Keep.md", written: "w" };
    const { io } = fakeIO();
    const { state } = await executeSync([], prev, io, fetcher);
    expect(state.items["notebook:keep"].hash).toBe("h");
  });

  it("records an error and keeps going", async () => {
    const failing: ObjectFetcher = { object: async () => { throw new Error("boom"); } };
    const { io } = fakeIO();
    const action: SyncAction = { kind: "file", itemKey: "file:k", ossKey: "uid/msg/k", path: "BOOX/Files/p.pdf", size: 5, hash: "5" };
    const { summary } = await executeSync([action], emptyState(), io, failing);
    expect(summary.errors[0].message).toContain("boom");
  });

  it("delete removes assets too", async () => {
    const notePath = "BOOX/Highlights/Gone.md";
    const assetFile = "BOOX/_assets/gone/p.png";
    const { io, files } = fakeIO({ [notePath]: "x", [assetFile]: "img" });
    const prev = emptyState();
    prev.items["highlight-book:gone"] = { hash: "h", path: notePath, assets: [assetFile] };
    // assets field is being added to the delete type — cast until type is updated
    const action = { kind: "delete" as const, itemKey: "highlight-book:gone", path: notePath, assets: [assetFile] } as unknown as SyncAction;
    const { state, summary } = await executeSync([action], prev, io, fetcher);
    expect(files.has(notePath)).toBe(false);
    expect(files.has(assetFile)).toBe(false);
    expect(state.items["highlight-book:gone"]).toBeUndefined();
    expect(summary.deleted).toBe(1);
  });

  it("stale-asset GC on image change", async () => {
    const notePath = "BOOX/Notebooks/N.md";
    const keepAsset = "BOOX/_assets/n1/a.png";
    const staleAsset = "BOOX/_assets/n1/b.png";
    // seed the stale asset on disk; note path does not exist (new note — user-edit guard won't trigger)
    const { io, files, bin } = fakeIO({ [staleAsset]: "old-bytes" });
    const prev = emptyState();
    prev.items["notebook:n1"] = {
      hash: "old", path: notePath, written: hashString("old content"),
      assets: [keepAsset, staleAsset],
    };
    const action: SyncAction = {
      kind: "note", itemKey: "notebook:n1", path: notePath, content: "# N\n", hash: "new",
      assets: [{ ossKey: "uid/note/n1/a.png", path: keepAsset }],
    };
    const { summary } = await executeSync([action], prev, io, fetcher);
    expect(summary.written).toBe(1);
    expect(bin.has(keepAsset)).toBe(true);   // downloaded
    expect(files.has(staleAsset)).toBe(false); // GC'd
    expect(files.get(notePath)).toBe("# N\n");
  });

  it("rename removes the old note", async () => {
    const oldContent = "old content we wrote";
    const oldPath = "BOOX/Notebooks/Old.md";
    const newPath = "BOOX/Notebooks/New.md";
    const { io, files } = fakeIO({ [oldPath]: oldContent });
    const prev = emptyState();
    prev.items["notebook:n1"] = { hash: "old", path: oldPath, written: hashString(oldContent), assets: [] };
    const action: SyncAction = {
      kind: "note", itemKey: "notebook:n1", path: newPath, content: "# New\n", hash: "new", assets: [],
    };
    const { summary } = await executeSync([action], prev, io, fetcher);
    expect(files.has(oldPath)).toBe(false);
    expect(files.get(newPath)).toBe("# New\n");
    expect(summary.written).toBe(1);
  });

  it("downloads memo page images and records them in state", async () => {
    const { io, bin } = fakeIO();
    const action: SyncAction = {
      kind: "images", itemKey: "memo:m1", hash: "h", assets: [
        { ossKey: "render:m1/layA", path: "BOOX/Calendar memo/20260611/20260611_1.png" },
        { ossKey: "render:m1/layB", path: "BOOX/Calendar memo/20260611/20260611_2.png" },
      ],
    };
    const { state, summary } = await executeSync([action], emptyState(), io, fetcher);
    expect(bin.has("BOOX/Calendar memo/20260611/20260611_1.png")).toBe(true);
    expect(bin.has("BOOX/Calendar memo/20260611/20260611_2.png")).toBe(true);
    expect(summary.downloaded).toBe(2);
    expect(state.items["memo:m1"].path).toBe("");
    expect(state.items["memo:m1"].assets).toEqual([
      "BOOX/Calendar memo/20260611/20260611_1.png",
      "BOOX/Calendar memo/20260611/20260611_2.png",
    ]);
  });

  it("migrates a memo from the old note layout — removes the .md and stale assets", async () => {
    const oldNote = "BOOX/Memos/m1.md";
    const oldAsset = "BOOX/_assets/m1/0.png";
    const { io, files, bin, removedDirs } = fakeIO({ [oldNote]: "note", [oldAsset]: "img" });
    const prev = emptyState();
    prev.items["memo:m1"] = { hash: "old", path: oldNote, assets: [oldAsset] };
    const action: SyncAction = {
      kind: "images", itemKey: "memo:m1", hash: "new", assets: [
        { ossKey: "render:m1/layA", path: "BOOX/Calendar memo/20260611/20260611_1.png" },
      ],
    };
    const { state } = await executeSync([action], prev, io, fetcher);
    expect(files.has(oldNote)).toBe(false);
    expect(files.has(oldAsset)).toBe(false);
    expect(bin.has("BOOX/Calendar memo/20260611/20260611_1.png")).toBe(true);
    expect(state.items["memo:m1"].path).toBe("");
    // the emptied old folders are cleaned up
    expect(removedDirs).toContain("BOOX/_assets/m1");
    expect(removedDirs).toContain("BOOX/Memos");
  });

  it("migrates a notebook from the old note layout — removes the .md and stale assets", async () => {
    const oldNote = "BOOX/Notebooks/J.md";
    const oldAsset = "BOOX/_assets/n1/pA.png";
    const { io, files, bin, removedDirs } = fakeIO({ [oldNote]: "note we wrote", [oldAsset]: "img" });
    const prev = emptyState();
    prev.items["notebook:n1"] = {
      hash: "old", path: oldNote, written: hashString("note we wrote"), assets: [oldAsset],
    };
    const action: SyncAction = {
      kind: "images", itemKey: "notebook:n1", hash: "new", assets: [
        { ossKey: "render:n1/pA", path: "BOOX/Notebooks/J/J_1.png" },
      ],
    };
    const { state } = await executeSync([action], prev, io, fetcher);
    expect(files.has(oldNote)).toBe(false);
    expect(files.has(oldAsset)).toBe(false);
    expect(bin.has("BOOX/Notebooks/J/J_1.png")).toBe(true);
    expect(state.items["notebook:n1"].path).toBe("");
    expect(removedDirs).toContain("BOOX/_assets/n1");
    // ...and once the last notebook leaves _assets, the shell folder goes too
    expect(removedDirs).toContain("BOOX/_assets");
  });

  it("images: preserves a user-edited note (and its assets) when migrating off the note layout", async () => {
    const oldNote = "BOOX/Notebooks/J.md";
    const oldAsset = "BOOX/_assets/n1/pA.png";
    const { io, files, bin } = fakeIO({ [oldNote]: "user changed this", [oldAsset]: "img" });
    const prev = emptyState();
    prev.items["notebook:n1"] = {
      hash: "old", path: oldNote, written: hashString("original we wrote"), assets: [oldAsset],
    };
    const action: SyncAction = {
      kind: "images", itemKey: "notebook:n1", hash: "new", assets: [
        { ossKey: "render:n1/pA", path: "BOOX/Notebooks/J/J_1.png" },
      ],
    };
    const { state, summary } = await executeSync([action], prev, io, fetcher);
    // the edited note keeps working: neither it nor the assets it embeds are touched
    expect(files.get(oldNote)).toBe("user changed this");
    expect(files.has(oldAsset)).toBe(true);
    expect(summary.skippedUserEdited).toContain(oldNote);
    // the new image layout is still written and becomes the managed state
    expect(bin.has("BOOX/Notebooks/J/J_1.png")).toBe(true);
    expect(state.items["notebook:n1"].path).toBe("");
    expect(state.items["notebook:n1"].assets).toEqual(["BOOX/Notebooks/J/J_1.png"]);
  });

  it("images: moving to a new date folder removes the old one", async () => {
    const oldImg = "BOOX/Calendar memo/m1/m1_1.png";
    const { io, files, bin, removedDirs } = fakeIO({ [oldImg]: "img" });
    const prev = emptyState();
    prev.items["memo:m1"] = { hash: "old", path: "", assets: [oldImg] };
    const action: SyncAction = {
      kind: "images", itemKey: "memo:m1", hash: "new", assets: [
        { ossKey: "render:m1/layA", path: "BOOX/Calendar memo/20260611/20260611_1.png" },
      ],
    };
    await executeSync([action], prev, io, fetcher);
    expect(files.has(oldImg)).toBe(false);
    expect(bin.has("BOOX/Calendar memo/20260611/20260611_1.png")).toBe(true);
    expect(removedDirs).toContain("BOOX/Calendar memo/m1");
  });

  it("delete removes memo images and their emptied folder", async () => {
    const img1 = "BOOX/Calendar memo/20260611/20260611_1.png";
    const img2 = "BOOX/Calendar memo/20260611/20260611_2.png";
    const { io, files, removedDirs } = fakeIO({ [img1]: "a", [img2]: "b" });
    const prev = emptyState();
    prev.items["memo:m1"] = { hash: "h", path: "", assets: [img1, img2] };
    const action: SyncAction = { kind: "delete", itemKey: "memo:m1", path: "", assets: [img1, img2] };
    const { state, summary } = await executeSync([action], prev, io, fetcher);
    expect(files.has(img1)).toBe(false);
    expect(files.has(img2)).toBe(false);
    expect(removedDirs).toContain("BOOX/Calendar memo/20260611");
    expect(state.items["memo:m1"]).toBeUndefined();
    expect(summary.deleted).toBe(1);
  });

  it("rename + user-edited preserves the old file", async () => {
    const oldPath = "BOOX/Notebooks/Old.md";
    const newPath = "BOOX/Notebooks/New.md";
    const { io, files } = fakeIO({ [oldPath]: "user modified this" });
    const prev = emptyState();
    prev.items["notebook:n1"] = { hash: "old", path: oldPath, written: hashString("original we wrote"), assets: [] };
    const action: SyncAction = {
      kind: "note", itemKey: "notebook:n1", path: newPath, content: "# New\n", hash: "new", assets: [],
    };
    const { summary } = await executeSync([action], prev, io, fetcher);
    expect(files.get(oldPath)).toBe("user modified this"); // untouched
    expect(files.has(newPath)).toBe(false);                // not created
    expect(summary.skippedUserEdited).toContain(oldPath);
  });
});
