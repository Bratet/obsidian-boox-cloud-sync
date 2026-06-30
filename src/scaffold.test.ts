import { describe, it, expect } from "vitest";
import { SYNC_STATE_VERSION } from "./types";

describe("scaffold", () => {
  it("exposes the sync state version", () => {
    expect(SYNC_STATE_VERSION).toBe(1);
  });
});
