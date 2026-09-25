import { describe, it, expect } from "vitest";
import { encryptSession, decryptSession, parseSession } from "./credentials";
describe("encrypted local sessions", () => {
  it("round-trips and never stores a plaintext token or password", async () => {
    const session = { region: "eur", email: "a@b.com", uid: "u", token: "SECRET-BOOX-TOKEN" };
    const saved = await encryptSession(session, "a long local passphrase");
    expect(JSON.stringify(saved)).not.toContain(session.token);
    expect(JSON.stringify(saved)).not.toContain("a long local passphrase");
    expect(await decryptSession(saved, "a long local passphrase")).toEqual(session);
    await expect(decryptSession(saved, "wrong password")).rejects.toThrow("Could not unlock");
    await expect(decryptSession({ ...saved, ciphertext: saved.ciphertext.slice(0, -4) + "AAAA" }, "a long local passphrase")).rejects.toThrow("Could not unlock");
  });
  it("uses fresh salts and nonces and rejects short passphrases", async () => {
    const s = { region: "eur", email: "a@b.com", uid: "u", token: "t" };
    const a = await encryptSession(s, "long local passphrase"), b = await encryptSession(s, "long local passphrase");
    expect(a.salt).not.toBe(b.salt); expect(a.iv).not.toBe(b.iv);
    await expect(encryptSession(s, "short")).rejects.toThrow("12 characters");
  });
  it("validates sessions read back from secret storage", () => {
    expect(parseSession(JSON.stringify({ region: "eur", token: "t", uid: "u", email: "a@b.com" }))).toEqual({ region: "eur", token: "t", uid: "u", email: "a@b.com" });
    for (const bad of [null, "", "not json", "null", JSON.stringify({ region: "evil", token: "t", uid: "u" }), JSON.stringify({ region: "eur", token: "", uid: "u" })])
      expect(parseSession(bad)).toBeNull();
  });
});
