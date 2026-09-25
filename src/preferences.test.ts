import { describe, it, expect } from "vitest";
import { restorePreferences } from "./preferences";

describe("standalone settings migration", () => {
  it("keeps an existing direct connection in memory and removes the plaintext token from persisted settings", () => {
    const restored = restorePreferences({ token: "synthetic-secret", region: "eur", account: { uid: "u", email: "test@example.com" }, syncFolder: "99 - Meta/BOOX" });
    expect(restored.session?.token).toBe("synthetic-secret");
    expect(restored.removeLegacy).toBe(true);
    expect(JSON.stringify(restored.settings)).not.toContain("synthetic-secret");
    expect(restored.settings.syncFolder).toBe("99 - Meta/BOOX");
  });
  it("does not reuse a companion-server API key as a BOOX token", () => {
    const restored = restorePreferences({ apiKey: "old-key", backendUrl: "https://example.com", account: { uid: "u" } });
    expect(restored.session).toBeNull();
    expect(restored.settings.account).toBeNull();
    expect(restored.removeLegacy).toBe(true);
    expect(JSON.stringify(restored.settings)).not.toContain("old-key");
  });
  it("prefers an encrypted connection over an old plaintext field", () => {
    const encrypted = { version: 1, salt: "salt", iv: "iv", ciphertext: "encrypted" };
    const restored = restorePreferences({ encryptedSession: encrypted, token: "old-token", region: "eur" });
    expect(restored.session).toBeNull();
    expect(restored.settings.encryptedSession).toEqual(encrypted);
    expect(restored.removeLegacy).toBe(true);
  });
  it("rejects invalid intervals, regions and setting types", () => {
    const restored = restorePreferences({ token: "secret", region: "foreign.example", intervalMinutes: -1, syncFiles: "false", exportFormat: "exe" });
    expect(restored.session).toBeNull();
    expect(restored.settings).toMatchObject({ region: "eur", intervalMinutes: 15, syncFiles: true, exportFormat: "pdf" });
  });
  it("restores a keychain session and drops the legacy encrypted blob", () => {
    const stored = { region: "push", token: "keychain-token", uid: "u1", email: "a@b.com" };
    const encrypted = { version: 1, salt: "salt", iv: "iv", ciphertext: "encrypted" };
    const restored = restorePreferences({ encryptedSession: encrypted, account: null, region: "eur" }, stored);
    expect(restored.session).toEqual(stored);
    expect(restored.settings.encryptedSession).toBeNull();
    expect(restored.settings.region).toBe("push");
    expect(restored.settings.account).toEqual({ uid: "u1", email: "a@b.com" });
    expect(JSON.stringify(restored.settings)).not.toContain("keychain-token");
  });
});
