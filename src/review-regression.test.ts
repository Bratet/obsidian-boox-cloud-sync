import { expect, it } from "vitest";
import { executeSync, type SyncAction } from "./sync";
import { emptyState } from "./state";
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
