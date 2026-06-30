import { describe, it, expect } from "vitest";
import { executeSync, type SyncAction } from "./sync";
import { emptyState } from "./state";
import { hashString } from "./hash";
import type { VaultIO, ObjectFetcher } from "./ports";

function fakeIO(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const bin = new Map<string, ArrayBuffer>();
  const io: VaultIO = {
    exists: async (p) => files.has(p) || bin.has(p),
    read: async (p) => files.get(p) ?? "",
    write: async (p, c) => void files.set(p, c),
    writeBinary: async (p, d) => void bin.set(p, d),
    remove: async (p) => void (files.delete(p) || bin.delete(p)),
  };
  return { io, files, bin };
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
    const action: SyncAction = { kind: "delete", itemKey: "highlight-book:gone", path };
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
});
