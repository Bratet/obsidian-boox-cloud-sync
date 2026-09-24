import { describe, it, expect } from "vitest";
import { BooxClient, BooxApiError, ossSignature, type HttpRequest, type HttpResponse } from "./client";
import { createHmac } from "node:crypto";
function fake(handler: (r: HttpRequest) => Partial<HttpResponse>) {
  const calls: HttpRequest[] = [];
  return { calls, transport: async (r: HttpRequest): Promise<HttpResponse> => { calls.push(r); return { status: 200, text: "{}", arrayBuffer: new ArrayBuffer(0), ...handler(r) }; } };
}
const response = (data: unknown) => ({ text: JSON.stringify({ data }) });
describe("direct BOOX client", () => {
  it("signs in directly with the verification code and validates the account", async () => {
    const f = fake(r => r.url.endsWith("users/me") ? response({ uid: "u", email: "a@b.com" }) : response({ token: "private-token" }));
    const session = await new BooxClient("eur", f.transport).login("a@b.com", "123456", "eur");
    expect(session).toEqual({ uid: "u", email: "a@b.com", region: "eur", token: "private-token" });
    expect(f.calls[0].url).toBe("https://eur.boox.com/api/1/users/signupByPhoneOrEmail");
    expect(JSON.parse(f.calls[0].body!)).toEqual({ mobi: "a@b.com", code: "123456" });
    expect(f.calls[1].headers.Authorization).toBe("Bearer private-token");
  });
  it("rejects unsupported hosts before sending credentials", () => {
    expect(() => new BooxClient("https://other.example", fake(() => ({})).transport)).toThrow("region");
  });
  it("rejects application errors in HTTP 200 without leaking the upstream body", async () => {
    const f = fake(() => ({ text: JSON.stringify({ result_code: 9, message: "private-token" }) }));
    await expect(new BooxClient("push", f.transport).sendCode("a@b.com")).rejects.toThrow("BOOX rejected");
    expect(f.calls).toHaveLength(1);
  });
  it("falls back to the older verification endpoint when unsupported", async () => {
    const f = fake(r => r.url.endsWith("sendVerifyCode") ? { status: 404 } : { text: '{"result_code":0}' });
    await new BooxClient("eur", f.transport).sendCode("a@b.com");
    expect(f.calls[1].url).toContain("sendMobileCode");
  });
  it("surfaces an expired login without exposing response contents", async () => {
    const f = fake(() => ({ status: 401, text: "sensitive upstream content" }));
    await expect(new BooxClient("eur", f.transport, "t").me()).rejects.toBeInstanceOf(BooxApiError);
    await expect(new BooxClient("eur", f.transport, "t").me()).rejects.toThrow("expired");
  });
  it("signs OSS reads with STS headers and the unescaped resource", async () => {
    const canonical = 'GET\n\n\nMon, 01 Jan 2024 00:00:00 GMT\nx-oss-security-token:sts\n/bucket/u/a#b';
    expect(await ossSignature("secret", "bucket", "u/a#b", "Mon, 01 Jan 2024 00:00:00 GMT", "sts"))
      .toBe(createHmac("sha1", "secret").update(canonical).digest("base64"));
  });
  it("paginates cloud documents and OSS listings without forwarding the BOOX token to storage", async () => {
    const f = fake(r => {
      if (r.url.endsWith("users/me")) return response({ uid: "u" });
      if (r.url.endsWith("users/syncToken")) return response({ session_id: "cookie" });
      if (r.url.includes("_changes")) {
        const q = new URL(r.url).searchParams;
        const results = q.get("channels") === "u-NOTE_TREE" && q.get("since") === "0"
          ? Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}`, doc: { _id: `d${i}`, uniqueId: `n${i}`, title: `N${i}`, type: 0 } })) : [];
        return { text: JSON.stringify({ results: results.length ? results : [{ id: "_user/synthetic", changes: [], seq: "1001" }], last_seq: "1000" }) };
      }
      if (r.url.endsWith("config/buckets")) return response({ "onyx-cloud": { bucket: "b", aliEndpoint: "oss-eu-central-1.aliyuncs.com" } });
      if (r.url.endsWith("config/stss")) return response({ AccessKeyId: "key", AccessKeySecret: "secret", SecurityToken: "sts" });
      return { text: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' };
    });
    const m = await new BooxClient("eur", f.transport, "boox-token").sources();
    expect(m.folders).toHaveLength(1000);
    expect(f.calls.filter(r => r.url.includes("_changes"))).toHaveLength(5);
    const storage = f.calls.find(r => r.url.includes("aliyuncs.com"))!;
    expect(storage.headers.Authorization).toMatch(/^OSS key:/);
    expect(JSON.stringify(storage)).not.toContain("boox-token");
  });
  it("fails closed when BOOX sends an incomplete channel", async () => {
    const f = fake(r => r.url.endsWith("users/me") ? response({ uid: "u" }) : r.url.endsWith("users/syncToken") ? response({ session_id: "cookie" }) : { text: "{}" });
    await expect(new BooxClient("eur", f.transport, "t").sources()).rejects.toThrow("Incomplete");
  });
});
