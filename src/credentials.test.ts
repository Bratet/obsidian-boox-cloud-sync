import { describe, it, expect } from "vitest";
import { parseSession } from "./credentials";

describe("parseSession", () => {
  it("parses a valid stored session", () => {
    expect(parseSession(JSON.stringify({ region: "push", token: "secret", uid: 123, email: "a@b.com" })))
      .toEqual({ region: "push", token: "secret", uid: "123", email: "a@b.com" });
    expect(parseSession(JSON.stringify({ region: "eur", token: "secret", uid: "u" }))?.email).toBe("");
  });
  it("rejects malformed and incomplete sessions", () => {
    for (const raw of [null, "", "{", "null", JSON.stringify({ region: "bad", token: "t", uid: "u" }), JSON.stringify({ region: "eur", token: "", uid: "u" }), JSON.stringify({ region: "eur", token: "t" })]) {
      expect(parseSession(raw)).toBeNull();
    }
  });
});
