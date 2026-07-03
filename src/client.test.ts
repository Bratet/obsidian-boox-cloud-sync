import { describe, it, expect } from "vitest";
import { BooxClient, BooxApiError, type HttpRequest, type HttpResponse } from "./client";

function fakeTransport(handler: (req: HttpRequest) => Partial<HttpResponse>) {
  const calls: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    const r = handler(req);
    return { status: r.status ?? 200, text: r.text ?? "", arrayBuffer: r.arrayBuffer ?? new ArrayBuffer(0) };
  };
  return { transport, calls };
}

describe("BooxClient", () => {
  it("device() posts code and returns the parsed apiKey + account", async () => {
    const { transport, calls } = fakeTransport(() => ({
      status: 200, text: JSON.stringify({ apiKey: "boox_x", account: { uid: "u1", email: "a@b.c" } }),
    }));
    const c = new BooxClient("http://host", transport);
    const res = await c.device("a@b.c", "eur", "123456", "Obsidian");
    expect(res.apiKey).toBe("boox_x");
    expect(res.account.uid).toBe("u1");
    expect(calls[0].url).toBe("http://host/api/auth/device");
    expect(JSON.parse(calls[0].body!)).toMatchObject({ email: "a@b.c", region: "eur", code: "123456", label: "Obsidian" });
  });

  it("sendCode() throws when the backend returns ok:false at HTTP 200", async () => {
    const { transport } = fakeTransport(() => ({ status: 200, text: JSON.stringify({ ok: false, message: "no account" }) }));
    const c = new BooxClient("http://host", transport);
    await expect(c.sendCode("a@b.c", "eur")).rejects.toThrow("no account");
  });

  it("sources() sends the Bearer key and parses the manifest", async () => {
    const { transport, calls } = fakeTransport(() => ({ status: 200, text: JSON.stringify({ account: { uid: "u1" }, notebooks: [], memos: [], files: [], highlights: [] }) }));
    const c = new BooxClient("http://host/", transport, "boox_key");
    const m = await c.sources();
    expect(m.account.uid).toBe("u1");
    expect(calls[0].url).toBe("http://host/api/sources"); // trailing slash on baseUrl stripped
    expect(calls[0].headers["Authorization"]).toBe("Bearer boox_key");
  });

  it("object() returns the raw bytes and url-encodes the key", async () => {
    const buf = new TextEncoder().encode("PNG").buffer;
    const { transport, calls } = fakeTransport(() => ({ status: 200, arrayBuffer: buf }));
    const c = new BooxClient("http://host", transport, "k");
    const out = await c.object("uid/note/n1/n1.png");
    expect(new Uint8Array(out)).toEqual(new Uint8Array(buf));
    expect(calls[0].url).toContain("/api/object?key=uid%2Fnote%2Fn1%2Fn1.png");
  });

  it("me() validates a pasted key and returns the account", async () => {
    const { transport, calls } = fakeTransport(() => ({
      status: 200, text: JSON.stringify({ account: { uid: "u1", email: "a@b.c" } }),
    }));
    const c = new BooxClient("http://host", transport, "boox_pasted");
    const res = await c.me();
    expect(res.account.email).toBe("a@b.c");
    expect(calls[0].url).toBe("http://host/api/me");
    expect(calls[0].headers["Authorization"]).toBe("Bearer boox_pasted");
  });

  it("throws BooxApiError with the detail on a non-2xx", async () => {
    const { transport } = fakeTransport(() => ({ status: 401, text: JSON.stringify({ detail: "invalid api key" }) }));
    const c = new BooxClient("http://host", transport, "bad");
    await expect(c.sources()).rejects.toBeInstanceOf(BooxApiError);
    await expect(c.sources()).rejects.toThrow("invalid api key");
  });
});
