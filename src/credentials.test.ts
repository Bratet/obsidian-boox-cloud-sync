import { describe, it, expect } from "vitest";
import { normalizeBearerToken, parseSession } from "./credentials";

describe("parseSession", () => {
  it("parses a valid stored session", () => {
    expect(parseSession(JSON.stringify({ region: "push", token: "secret", uid: 123, email: "a@b.com" })))
      .toEqual({ region: "push", token: "secret", uid: "123", email: "a@b.com" });
    expect(parseSession(JSON.stringify({ region: "cn", token: "cn-secret", uid: "u2", email: "13800138000" })))
      .toEqual({ region: "cn", token: "cn-secret", uid: "u2", email: "13800138000" });
    expect(parseSession(JSON.stringify({ region: "eur", token: "secret", uid: "u" }))?.email).toBe("");
  });
  it("rejects malformed and incomplete sessions", () => {
    for (const raw of [null, "", "{", "null", JSON.stringify({ region: "bad", token: "t", uid: "u" }), JSON.stringify({ region: "eur", token: "", uid: "u" }), JSON.stringify({ region: "eur", token: "t" })]) {
      expect(parseSession(raw)).toBeNull();
    }
  });
});

describe("normalizeBearerToken", () => {
  it("trims whitespace and strips an optional Bearer prefix", () => {
    expect(normalizeBearerToken("  eyJabc.def.ghi  ")).toBe("eyJabc.def.ghi");
    expect(normalizeBearerToken("Bearer eyJabc.def.ghi")).toBe("eyJabc.def.ghi");
    expect(normalizeBearerToken("bearer   eyJabc.def.ghi")).toBe("eyJabc.def.ghi");
  });
  it("rejects empty tokens and header injection characters", () => {
    for (const raw of ["", "   ", "Bearer ", "tok\nen", "tok\ren"]) {
      expect(() => normalizeBearerToken(raw)).toThrow("bearer token");
    }
  });
});
