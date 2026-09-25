import { expect, it, vi } from "vitest";
import { executeSync, type SyncAction } from "./sync";
import { emptyState, parseState, serializeState } from "./state";
import type { SyncState } from "./types";
import type { VaultIO } from "./ports";

it("retries a multi-page update after a transient storage failure", async () => {
  const files = new Map<string, ArrayBuffer>();
  let fail = false;
  const io: VaultIO = {
    exists: async p => files.has(p),
    read: async p => new TextDecoder().decode(files.get(p)),
    readBinary: async p => files.get(p)!,
    write: async (p, s) => { files.set(p, new TextEncoder().encode(s).buffer); },
    writeBinary: async (p, b) => {
      if (fail && p.endsWith("B.png")) throw new Error("Temporary storage failure");
      files.set(p, b);
    },
    remove: async p => { files.delete(p); },
  };
  const action: SyncAction = { kind: "images", itemKey: "notebook:n", hash: "old",
    assets: ["A", "B"].map(p => ({ path: `BOOX/${p}.png`, ossKey: p })) };
  const fetcher = (text: string) => ({ object: async () => new TextEncoder().encode(text).buffer });
  const initial = await executeSync([action], emptyState(), io, fetcher("original"));
  fail = true;
  const update = { ...action, hash: "new" };
  const failed = await executeSync([update], initial.state, io, fetcher("updated"));
  expect(failed.summary.errors).toHaveLength(1);
  fail = false;
  const retry = await executeSync([update], failed.state, io, fetcher("updated"));
  expect(retry.summary.skippedUserEdited).toEqual([]);
  expect(new TextDecoder().decode(files.get("BOOX/B.png"))).toBe("updated");
});

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
function memoryVault() {
  const files = new Map<string, ArrayBuffer>();
  const io: VaultIO = {
    exists: async p => files.has(p),
    read: async p => new TextDecoder().decode(files.get(p)),
    readBinary: async p => files.get(p)!,
    write: async (p, text) => { files.set(p, bytes(text)); },
    writeBinary: async (p, data) => { files.set(p, data); },
    remove: async p => { files.delete(p); },
  };
  return { files, io };
}

it.each([false, true])("recovers a partial first import, preserving later user edits: %s", async edited => {
  const { files, io } = memoryVault();
  const write = io.writeBinary;
  io.writeBinary = async (path, data) => { if (path.endsWith("B.png")) throw new Error("disk full"); await write(path, data); };
  const action: SyncAction = { kind: "images", itemKey: "notebook:n", hash: "new",
    assets: ["A", "B"].map(p => ({ path: `BOOX/${p}.png`, ossKey: p })) };
  let saved = emptyState();
  const first = await executeSync([action], emptyState(), io, { object: async () => bytes("cloud") }, async state => {
    saved = parseState(serializeState(state));
  });
  expect(first.summary.errors).toHaveLength(1);
  expect(saved.items["notebook:n"].pending).toBe(true);
  io.writeBinary = write;
  if (edited) files.set("BOOX/A.png", bytes("user edit"));
  const retry = await executeSync([action], saved, io, { object: async () => bytes("cloud") });
  expect(retry.summary.errors).toEqual([]);
  expect(retry.summary.skippedUserEdited).toEqual(edited ? ["BOOX/A.png"] : []);
  expect(new TextDecoder().decode(files.get("BOOX/A.png"))).toBe(edited ? "user edit" : "cloud");
  expect(files.has("BOOX/B.png")).toBe(!edited);
  expect(retry.state.items["notebook:n"].pending).toBe(edited ? true : undefined);
});

it("retries a note when its asset was saved before the note write failed", async () => {
  const { io, files } = memoryVault();
  const write = io.write;
  io.write = async () => { throw new Error("disk full"); };
  const action: SyncAction = { kind: "note", itemKey: "highlight-book:b", path: "BOOX/Book.md", hash: "h", content: "new note",
    assets: [{ path: "BOOX/A.png", ossKey: "A" }] };
  const fetcher = { object: async () => bytes("cloud") };
  const failed = await executeSync([action], emptyState(), io, fetcher);
  expect(failed.summary.errors).toHaveLength(1);
  io.write = write;
  const retry = await executeSync([action], failed.state, io, fetcher);
  expect(retry.summary.errors).toEqual([]);
  expect(retry.summary.skippedUserEdited).toEqual([]);
  expect(new TextDecoder().decode(files.get("BOOX/Book.md"))).toBe("new note");
});

it("recovers a renamed note when cleanup failed without deleting the new note", async () => {
  const { io, files } = memoryVault();
  const original: SyncAction = { kind: "note", itemKey: "highlight-book:b", path: "BOOX/Old.md", hash: "old", content: "old note", assets: [] };
  const fetcher = { object: async () => bytes("cloud") };
  const initial = await executeSync([original], emptyState(), io, fetcher);
  const remove = io.remove;
  io.remove = async () => { throw new Error("file locked"); };
  const renamed = { ...original, path: "BOOX/New.md", hash: "new", content: "new note" };
  const failed = await executeSync([renamed], initial.state, io, fetcher);
  expect(failed.summary.errors).toHaveLength(1);
  io.remove = remove;
  const retry = await executeSync([renamed], failed.state, io, fetcher);
  expect(retry.summary.errors).toEqual([]);
  expect(retry.summary.skippedUserEdited).toEqual([]);
  expect(files.has("BOOX/Old.md")).toBe(false);
  expect(new TextDecoder().decode(files.get("BOOX/New.md"))).toBe("new note");
});

it("checkpoints completed items before fetching the next item", async () => {
  const { io } = memoryVault();
  const prev = { ...emptyState(), accountUid: "u", lastSync: "previous completed sync" };
  const snapshots: SyncState[] = [];
  const actions: SyncAction[] = ["A", "B"].map(key => ({ kind: "file", itemKey: `file:${key}`, path: `BOOX/${key}`, ossKey: key, hash: key, size: 1 }));
  await executeSync(actions, prev, io, { object: async key => {
    if (key === "B") {
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].items["file:A"].pending).toBeUndefined();
      expect(snapshots[0]).toMatchObject({ accountUid: "u", lastSync: prev.lastSync });
    }
    return bytes(key);
  } }, async state => { snapshots.push(parseState(serializeState(state))); });
  expect(snapshots).toHaveLength(2);
  expect(snapshots[0].items["file:B"]).toBeUndefined();
});

it("stops immediately if saving a checkpoint fails", async () => {
  const { io } = memoryVault();
  const object = vi.fn(async () => bytes("cloud"));
  const actions: SyncAction[] = ["A", "B"].map(key => ({ kind: "file", itemKey: `file:${key}`, path: `BOOX/${key}`, ossKey: key, hash: key, size: 1 }));
  await expect(executeSync(actions, emptyState(), io, { object }, async () => { throw new Error("cannot save sync state"); }))
    .rejects.toThrow("cannot save sync state");
  expect(object).toHaveBeenCalledTimes(1);
});
