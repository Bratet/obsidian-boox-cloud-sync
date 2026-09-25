import { describe, it, expect, vi } from "vitest";
import { BooxClient, BooxApiError, ossSignature, type HttpRequest, type HttpResponse } from "./client";
import { createHmac } from "node:crypto";
function fake(handler: (r: HttpRequest) => Partial<HttpResponse>) {
  const calls: HttpRequest[] = [];
  return { calls, transport: async (r: HttpRequest): Promise<HttpResponse> => { calls.push(r); return { status: 200, text: "{}", arrayBuffer: new ArrayBuffer(0), ...handler(r) }; } };
}
const response = (data: unknown) => ({ text: JSON.stringify({ data }) });
async function storageClient(keys: string[], storage: (req: HttpRequest) => Partial<HttpResponse>) {
  const f = fake(r => {
    if (r.url.endsWith("users/me")) return response({ uid: "u" });
    if (r.url.endsWith("users/syncToken")) return response({ session_id: "cookie" });
    if (r.url.includes("_changes")) return { text: JSON.stringify({ last_seq: "1", results:
      new URL(r.url).searchParams.get("channels") === "u-MESSAGE"
        ? keys.map(key => ({ id: key, doc: { content: JSON.stringify({ name: key, formats: ["bin"], storage: { bin: { oss: { key } } } }) } })) : [],
    }) };
    if (r.url.endsWith("config/buckets")) return response({ "onyx-cloud": { bucket: "b", aliEndpoint: "oss-eu-central-1.aliyuncs.com" } });
    if (r.url.endsWith("config/stss")) return response({ AccessKeyId: "key", AccessKeySecret: "secret", SecurityToken: "sts" });
    if (new URL(r.url).pathname === "/") return { text: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' };
    return storage(r);
  });
  const client = new BooxClient("eur", f.transport);
  await client.sources();
  return { ...f, client };
}
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
  it("stops waiting when a BOOX request never completes", async () => {
    vi.useFakeTimers();
    try {
      const client = new BooxClient("eur", () => new Promise(() => {}));
      const request = expect(client.me()).rejects.toThrow("timed out after two minutes");
      await vi.advanceTimersByTimeAsync(120_000);
      await request;
    } finally {
      vi.useRealTimers();
    }
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
  it("keeps recently reused data when the cache fills", async () => {
    const bytes = new ArrayBuffer(10 * 1024 * 1024);
    const { client, calls } = await storageClient(["A", "B", "C", "D"], () => ({ arrayBuffer: bytes }));
    for (const key of ["A", "B", "C", "A", "D", "A", "C", "B"]) await client.object(key);
    const downloads = calls.filter(r => /aliyuncs.com\/[A-D]$/.test(r.url));
    expect(downloads.map(r => new URL(r.url).pathname)).toEqual(["/A", "/B", "/C", "/D", "/B"]);
  });
  it("does not flush reusable data when downloading an oversized attachment", async () => {
    const { client, calls } = await storageClient(["small", "large"], r => ({
      arrayBuffer: new ArrayBuffer(r.url.endsWith("large") ? 33 * 1024 * 1024 : 100),
    }));
    await client.object("small"); await client.object("large"); await client.object("small");
    expect(calls.filter(r => r.url.endsWith("/small"))).toHaveLength(1);
  });
  it("shares in-flight downloads and refreshes expired credentials only once", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = await storageClient(["A", "B"], () => ({ arrayBuffer: new ArrayBuffer(1) }));
      vi.setSystemTime(Date.now() + 26 * 60_000);
      const [a, sameA] = await Promise.all([client.object("A"), client.object("A"), client.object("B")]);
      expect(a).toBe(sameA);
      expect(calls.filter(r => r.url.endsWith("/A"))).toHaveLength(1);
      expect(calls.filter(r => r.url.endsWith("config/stss"))).toHaveLength(2);
      expect(calls.filter(r => r.url.endsWith("config/buckets"))).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});
