import { describe, it, expect } from "vitest";
import { executeSync, planSync, type SyncAction } from "./sync";
import { emptyState } from "./state";
import { assembleSources, type Snapshot } from "./manifest";
import type { BooxSettings, Manifest, SyncState } from "./types";
import type { VaultIO } from "./ports";

// Vaults synced before per-file checksums existed: every item's source hash
// changed with the direct-cloud backend, and the old guard kept each fresh
// render as a "possible user edit" — re-rendering everything on every run.
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const text = (b?: ArrayBuffer) => new TextDecoder().decode(b);
function vault(seed: Record<string, [string, number]>, withMtime = true) {
  const files = new Map<string, { data: ArrayBuffer; mtime: number }>(
    Object.entries(seed).map(([p, [t, mtime]]) => [p, { data: bytes(t), mtime }]));
  const io: VaultIO = {
    exists: async p => files.has(p),
    read: async p => text(files.get(p)?.data),
    readBinary: async p => files.get(p)!.data,
    write: async (p, t) => { files.set(p, { data: bytes(t), mtime: 9e15 }); },
    writeBinary: async (p, d) => { files.set(p, { data: d, mtime: 9e15 }); },
    remove: async p => { files.delete(p); },
    ...(withMtime ? { mtime: async (p: string) => files.get(p)?.mtime ?? null } : {}),
  };
  return { files, io };
}
const legacyState = (items: Record<string, string>): SyncState => ({
  ...emptyState(),
  items: Object.fromEntries(Object.entries(items).map(([key, path]) => [key, { hash: "old-backend", path: "", assets: [path] }])),
});
function fetcher(content: string) {
  const calls: string[] = [];
  return { calls, object: async (key: string) => { calls.push(key); return bytes(content); } };
}
type ImagesAction = Extract<SyncAction, { kind: "images" }>;
const action = (key: string, path: string, modified: number | null): ImagesAction =>
  ({ kind: "images", itemKey: key, hash: "new-hash", assets: [{ path, ossKey: `pdf:${key}` }], modified });

describe("items synced before checksums existed", () => {
  it("adopts an unchanged doc without rendering and records a baseline", async () => {
    const { io, files } = vault({ "BOOX/Memo/20260919.pdf": ["old export", 2_000] });
    const f = fetcher("fresh render");
    const { state, summary } = await executeSync([action("memo:a", "BOOX/Memo/20260919.pdf", 1_000)],
      legacyState({ "memo:a": "BOOX/Memo/20260919.pdf" }), io, f);
    expect(f.calls).toEqual([]);
    expect(summary).toMatchObject({ adopted: 1, updated: [], skippedUserEdited: [], errors: [] });
    expect(text(files.get("BOOX/Memo/20260919.pdf")!.data)).toBe("old export");
    expect(state.items["memo:a"].hash).toBe("new-hash");
    expect(Object.keys(state.items["memo:a"].binaryHashes!)).toEqual(["BOOX/Memo/20260919.pdf"]);
  });

  it("re-renders and overwrites a doc edited in the cloud after it was written, and reports it", async () => {
    const { io, files } = vault({ "BOOX/Notebooks/Resume.pdf": ["old export", 1_000] });
    const f = fetcher("fresh render");
    const { state, summary } = await executeSync([action("notebook:r", "BOOX/Notebooks/Resume.pdf", 5_000)],
      legacyState({ "notebook:r": "BOOX/Notebooks/Resume.pdf" }), io, f);
    expect(f.calls).toEqual(["pdf:notebook:r"]);
    expect(summary).toMatchObject({ adopted: 0, updated: ["BOOX/Notebooks/Resume.pdf"], skippedUserEdited: [] });
    expect(text(files.get("BOOX/Notebooks/Resume.pdf")!.data)).toBe("fresh render");
    expect(state.items["notebook:r"]).toMatchObject({ hash: "new-hash" });
    expect(state.items["notebook:r"].pending).toBeUndefined();
  });

  it("without file times, overwrites its own files instead of keeping them as user edits", async () => {
    const { io, files } = vault({ "BOOX/Memo/20260918.pdf": ["old export", 2_000] }, false);
    const { summary } = await executeSync([action("memo:b", "BOOX/Memo/20260918.pdf", 1_000)],
      legacyState({ "memo:b": "BOOX/Memo/20260918.pdf" }), io, fetcher("fresh render"));
    expect(summary.skippedUserEdited).toEqual([]);
    expect(text(files.get("BOOX/Memo/20260918.pdf")!.data)).toBe("fresh render");
  });

  it("still protects a checksummed file the user changed", async () => {
    const { io, files } = vault({ "BOOX/Memo/1.pdf": ["plugin output", 1_000] });
    const first = await executeSync([action("memo:c", "BOOX/Memo/1.pdf", 5_000)], legacyState({ "memo:c": "BOOX/Memo/1.pdf" }), io, fetcher("render 1"));
    files.set("BOOX/Memo/1.pdf", { data: bytes("user annotated"), mtime: 9e15 });
    const { summary } = await executeSync([{ ...action("memo:c", "BOOX/Memo/1.pdf", 6_000), hash: "newer" }], first.state, io, fetcher("render 2"));
    expect(summary.skippedUserEdited).toEqual(["BOOX/Memo/1.pdf"]);
    expect(text(files.get("BOOX/Memo/1.pdf")!.data)).toBe("user annotated");
  });

  it("settles: once adopted, the next plan has nothing to do", async () => {
    const docs: Snapshot = { notes: [], library: [], messages: [], calendar: [{ uniqueId: "m", associateDate: "20260919" }] };
    const manifest: Manifest = assembleSources("u", docs, [
      { key: "u/calendar/m/point/L#x#points", size: 1, etag: "e", modified: "1970-01-01T00:00:01.000Z" },
    ]);
    expect(manifest.memos[0].modified).toBe(1_000);
    const settings: BooxSettings = { account: null, syncFolder: "BOOX", intervalMinutes: 15, syncHighlights: false, syncNotebooks: false,
      syncMemos: true, syncFiles: false, deleteRemoved: false };
    const path = "BOOX/Calendar memo/20260919.pdf";
    const { io } = vault({ [path]: ["old export", 2_000] });
    const actions = planSync(manifest, legacyState({ "memo:m": path }), settings, "now");
    expect(actions).toHaveLength(1);
    const { state, summary } = await executeSync(actions, legacyState({ "memo:m": path }), io, fetcher("x"));
    expect(summary.adopted).toBe(1);
    expect(planSync(manifest, state, settings, "now")).toEqual([]);
  });
});
