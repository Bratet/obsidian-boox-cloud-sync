import type { Manifest } from "./types";

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export class BooxApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "BooxApiError";
  }
}

function detail(text: string, fallback: string): string {
  try {
    const j = JSON.parse(text);
    return j.detail || j.message || fallback;
  } catch {
    return fallback;
  }
}

export class BooxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly transport: HttpTransport,
    private readonly apiKey?: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private ok(r: HttpResponse, fallback: string): void {
    if (r.status < 200 || r.status >= 300) throw new BooxApiError(r.status, detail(r.text, fallback));
  }

  async sendCode(email: string, region: string): Promise<void> {
    const r = await this.transport({
      url: this.url("/api/auth/send-code"),
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ email, region }),
    });
    this.ok(r, "failed to send code");
    let j: any = {};
    try {
      j = JSON.parse(r.text);
    } catch {
      /* tolerate non-JSON 2xx */
    }
    if (j && j.ok === false) throw new BooxApiError(r.status, j.message || "failed to send code");
  }

  async device(
    email: string,
    region: string,
    code: string,
    label?: string,
  ): Promise<{ apiKey: string; account: { uid: string | null; email: string } }> {
    const r = await this.transport({
      url: this.url("/api/auth/device"),
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ email, region, code, label }),
    });
    this.ok(r, "login failed");
    return JSON.parse(r.text);
  }

  async me(): Promise<{ account: { uid: string | null; email: string | null } }> {
    const r = await this.transport({ url: this.url("/api/me"), method: "GET", headers: this.headers(false) });
    this.ok(r, "auth check failed");
    return JSON.parse(r.text);
  }

  async revoke(): Promise<void> {
    const r = await this.transport({ url: this.url("/api/keys/revoke"), method: "POST", headers: this.headers(false) });
    this.ok(r, "revoke failed");
  }

  async sources(): Promise<Manifest> {
    const r = await this.transport({ url: this.url("/api/sources"), method: "GET", headers: this.headers(false) });
    this.ok(r, "failed to load sources");
    return JSON.parse(r.text);
  }

  async object(key: string): Promise<ArrayBuffer> {
    const r = await this.transport({
      url: this.url(`/api/object?key=${encodeURIComponent(key)}`),
      method: "GET",
      headers: this.headers(false),
    });
    this.ok(r, "failed to fetch object");
    return r.arrayBuffer;
  }
}
