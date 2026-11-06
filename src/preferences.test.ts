import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, restorePreferences } from "./preferences";

describe("preference restoration", () => {
  it("uses the keychain session for region and account", () => {
    const session = { region: "push", token: "secret", uid: "u1", email: "a@b.com" };
    const restored = restorePreferences({ region: "eur", account: { uid: "other", email: "other@example.com" } }, session);
    expect(restored.session).toEqual(session);
    expect(restored.settings.region).toBe("push");
    expect(restored.settings.account).toEqual({ uid: "u1", email: "a@b.com" });
    expect(JSON.stringify(restored.settings)).not.toContain("secret");
  });
  it("rejects invalid values", () => {
    const { settings } = restorePreferences({ region: "invalid", intervalMinutes: -1, syncFiles: "false", exportFormat: "exe" });
    expect(settings).toMatchObject({ region: "eur", intervalMinutes: 15, syncFiles: true, exportFormat: "pdf" });
  });
  it("drops unknown keys and clears account without a session", () => {
    const { settings, session } = restorePreferences({ token: "secret", folderPath: "old", unknown: 1, account: { uid: "u" }, syncFolder: "Notes" });
    expect(session).toBeNull();
    expect(settings.account).toBeNull();
    expect(settings.syncFolder).toBe("Notes");
    expect(Object.keys(settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
  it("falls back to cloud for an unsupported source", () => {
    expect(restorePreferences({ source: "other" }).settings.source).toBe("cloud");
    expect(restorePreferences({ source: "tablet" }).settings.source).toBe("tablet");
  });
});
