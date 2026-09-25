import type { Manifest } from "./types";
import type { Session } from "./credentials";
import { assembleSources, type Snapshot, type CloudObject } from "./manifest";
import { XMLParser } from "fast-xml-parser";
import { renderCloudPage, bindPdf } from "./handwriting";

export interface HttpRequest { url: string; method: string; headers: Record<string, string>; body?: string }
export interface HttpResponse { status: number; text: string; arrayBuffer: ArrayBuffer }
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;
export class BooxApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "BooxApiError"; }
}
export const HOSTS: Record<string, string> = { eur: "eur.boox.com", push: "push.boox.com" };
const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: true,
  isArray: name => name === "Contents" });
const encodeKey = (s: string) => s.split("/").map(encodeURIComponent).join("/");
const REQUEST_TIMEOUT_MS = 120_000;
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;
interface StorageCredentials { buckets: any; sts: any; until: number }
export async function ossSignature(secret: string, bucket: string, key: string, date: string, token: string): Promise<string> {
  const bytes = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", bytes.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const data = `GET\n\n\n${date}\nx-oss-security-token:${token}\n/${bucket}/${key}`;
  const signature = await crypto.subtle.sign("HMAC", material, bytes.encode(data));
  return btoa(Array.from(new Uint8Array(signature), b => String.fromCharCode(b)).join(""));
}
export class BooxClient {
  private host: string;
  private cookie = "";
  private credentials: StorageCredentials | null = null;
  private credentialsLoading: Promise<StorageCredentials> | null = null;
  private manifest: Manifest | null = null;
  private objects: CloudObject[] = [];
  private objectsByNotebook = new Map<string, CloudObject[]>();
  private uid = "";
  private blobs = new Map<string, ArrayBuffer>();
  private pendingBlobs = new Map<string, Promise<ArrayBuffer>>();
  private blobBytes = 0;
  constructor(region: string, private transport: HttpTransport, private token = "", private progress: (message: string) => void = () => {}) {
    if (!HOSTS[region]) throw new Error("Choose a supported BOOX region.");
    this.host = HOSTS[region];
  }
  private async request(req: HttpRequest): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // requestUrl has no cancellation API. Bound our wait; a late transport
      // response is ignored and cannot enter the blob cache after this fails.
      const r = await Promise.race([
        this.transport(req),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("BOOX request timed out after two minutes. Try syncing again.")), REQUEST_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (req.method === "GET" && [429, 502, 503, 504].includes(r.status) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); continue;
      }
      if (r.status < 200 || r.status >= 300) throw new BooxApiError(r.status,
        r.status === 401 ? "BOOX session expired. Connect again in settings." : `BOOX request failed (${r.status}). Try syncing again.`);
      return r;
    }
  }
  private async api(path: string, body?: object): Promise<any> {
    const r = await this.request({ url: `https://${this.host}/api/1/${path}`, method: body ? "POST" : "GET",
      headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { "Content-Type": "application/json;charset=utf-8" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    let value; try { value = JSON.parse(r.text); } catch { throw new Error("BOOX returned an unreadable response. Try again later."); }
    if (!value || (value.result_code != null && value.result_code !== 0)) throw new BooxApiError(r.status, "BOOX rejected the request. Check your region and verification code, or try again later.");
    return value;
  }
  async sendCode(email: string): Promise<void> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter your BOOX account email.");
    try { await this.api("users/sendVerifyCode", { mobi: email }); }
    catch (e) { if (e instanceof BooxApiError && [404, 405].includes(e.status)) await this.api("users/sendMobileCode", { mobi: email }); else throw e; }
  }
  async login(email: string, code: string, region: string): Promise<Session> {
    if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit code from your email.");
    const response = await this.api("users/signupByPhoneOrEmail", { mobi: email, code });
    if (!response.data?.token) throw new Error("BOOX did not return a session. Request a new code.");
    this.token = response.data.token;
    const account = await this.me();
    return { region, email, uid: String(account.uid), token: this.token };
  }
  async me(): Promise<{ uid: string; email?: string }> {
    const result = (await this.api("users/me")).data;
    if (!result?.uid) throw new Error("BOOX did not return an account ID.");
    this.uid = String(result.uid); return result;
  }
  private async channel(suffix: string): Promise<any[]> {
    const docs = new Map<string, any>(); let since = "0";
    for (;;) {
      if (!this.cookie) {
        const data = (await this.api("users/syncToken")).data;
        if (!data?.session_id || !/^[\w-]+$/.test(data.cookie_name || "SyncGatewaySession") || /[\r\n;]/.test(data.session_id)) throw new Error("Invalid BOOX sync session.");
        this.cookie = `${data.cookie_name || "SyncGatewaySession"}=${data.session_id}`;
      }
      const q = new URLSearchParams({ filter: "sync_gateway/bychannel", channels: `${this.uid}-${suffix}`, include_docs: "true", style: "all_docs", since, limit: "1000" });
      const req = { url: `https://${this.host}/neocloud/_changes?${q}`, method: "GET", headers: { Cookie: this.cookie, Accept: "application/json" } };
      let r;
      try { r = await this.request(req); } catch (e) {
        if (!(e instanceof BooxApiError) || e.status !== 401) throw e;
        this.cookie = ""; throw new Error("BOOX sync session expired. Retry sync to refresh it.");
      }
      const data = JSON.parse(r.text);
      if (!Array.isArray(data.results) || data.last_seq == null) throw new Error("Incomplete BOOX change feed; sync stopped to protect local files.");
      for (const row of data.results) {
        const id = row.id || row.doc?._id;
        if (!id) throw new Error("Invalid BOOX change record.");
        // Sync Gateway emits principal/access changes with no document or revisions.
        // They advance the sequence but are not missing user content.
        if (/^_(user|role)\//.test(id) && !row.doc && Array.isArray(row.changes) && row.changes.length === 0) continue;
        if (row.deleted || row.removed || row.doc?._deleted) docs.delete(id);
        else if (row.doc) docs.set(id, row.doc);
        else throw new Error("BOOX omitted a document; sync stopped to protect local files.");
      }
      if (data.results.length < 1000) break;
      const next = String(data.last_seq);
      if (next === since) throw new Error("BOOX change feed did not advance.");
      since = next;
    }
    return [...docs.values()];
  }
  private async storageCredentials(): Promise<StorageCredentials> {
    if (this.credentials && this.credentials.until > Date.now()) return this.credentials;
    if (!this.credentialsLoading) {
      this.credentialsLoading = Promise.all([this.api("config/buckets"), this.api("config/stss")])
        .then(([buckets, sts]) => this.credentials = { buckets: buckets.data, sts: sts.data, until: Date.now() + 25 * 60_000 })
        .finally(() => { this.credentialsLoading = null; });
    }
    return this.credentialsLoading;
  }
  private async oss(key: string, query = "", logicalBucket = "onyx-cloud", refresh = true): Promise<HttpResponse> {
    const credentials = await this.storageCredentials();
    const { buckets, sts } = credentials;
    const info = buckets?.[logicalBucket];
    if (!info?.bucket || !info?.aliEndpoint || !sts?.AccessKeySecret || !sts?.SecurityToken) throw new Error("BOOX storage configuration is incomplete.");
    const endpoint = String(info.aliEndpoint).replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!/^[a-z0-9.-]+\.aliyuncs\.com$/i.test(endpoint) || !/^[a-z0-9-]+$/.test(info.bucket)) throw new Error("Unrecognized BOOX storage endpoint.");
    const date = new Date().toUTCString();
    const signature = await ossSignature(sts.AccessKeySecret, info.bucket, key, date, sts.SecurityToken);
    try {
      return await this.request({ url: `https://${info.bucket}.${endpoint}/${encodeKey(key)}${query ? `?${query}` : ""}`, method: "GET",
        headers: { Date: date, "x-oss-security-token": sts.SecurityToken, Authorization: `OSS ${sts.AccessKeyId}:${signature}` } });
    } catch (e) {
      if (refresh && e instanceof BooxApiError && e.status === 403) {
        if (this.credentials === credentials) this.credentials = null;
        return this.oss(key, query, logicalBucket, false);
      }
      throw e;
    }
  }
  private async listObjects(): Promise<CloudObject[]> {
    const out: CloudObject[] = []; let marker = "";
    for (;;) {
      const query = new URLSearchParams({ prefix: `${this.uid}/`, "max-keys": "1000", marker });
      const r = await this.oss("", query.toString());
      if (/<!DOCTYPE|<!ENTITY/i.test(r.text)) throw new Error("Unexpected BOOX storage XML declaration.");
      const root = xml.parse(r.text).ListBucketResult;
      if (!root || !["true", "false"].includes(root.IsTruncated)) throw new Error("Incomplete BOOX storage listing; sync stopped.");
      for (const item of root.Contents ?? []) {
        if (typeof item.Key !== "string" || !Number.isFinite(Number(item.Size))) throw new Error("Invalid BOOX storage entry.");
        out.push({ key: item.Key, size: Number(item.Size), etag: item.ETag, modified: item.LastModified });
      }
      if (root.IsTruncated !== "true") break;
      const next = root.NextMarker || out[out.length - 1]?.key;
      if (!next || next === marker) throw new Error("BOOX storage listing did not advance.");
      marker = next;
    }
    return out;
  }
  async sources(): Promise<Manifest> {
    this.progress("Reading BOOX account…"); await this.me();
    const docs: Snapshot = { notes: [], library: [], messages: [], calendar: [] };
    for (const [kind, suffix] of Object.entries({ notes: "NOTE_TREE", library: "READER_LIBRARY", messages: "MESSAGE", calendar: "CALENDAR_TREE" })) {
      this.progress(`Reading ${kind}…`); docs[kind as keyof Snapshot] = await this.channel(suffix);
    }
    this.progress("Listing cloud files…"); this.objects = await this.listObjects();
    this.objectsByNotebook.clear();
    for (const obj of this.objects) {
      const [owner, kind, id] = obj.key.split("/");
      if (owner !== this.uid || !id || !["note", "calendar"].includes(kind)) continue;
      const key = `${kind}/${id}`;
      const group = this.objectsByNotebook.get(key) ?? [];
      group.push(obj); this.objectsByNotebook.set(key, group);
    }
    this.manifest = assembleSources(this.uid, docs, this.objects);
    return this.manifest;
  }
  private async raw(key: string, bucket = "onyx-cloud"): Promise<ArrayBuffer> {
    const cacheKey = `${bucket}/${key}`;
    const cached = this.blobs.get(cacheKey);
    if (cached) {
      this.blobs.delete(cacheKey); this.blobs.set(cacheKey, cached);
      return cached;
    }
    const pending = this.pendingBlobs.get(cacheKey); if (pending) return pending;
    const download = this.oss(key, "", bucket).then(response => {
      const data = response.arrayBuffer;
      // Evict only the least recently used entries. An oversized attachment
      // bypasses the cache instead of flushing reusable handwriting metadata.
      if (data.byteLength <= BLOB_CACHE_BYTES) {
        while (this.blobBytes + data.byteLength > BLOB_CACHE_BYTES) {
          const oldest = this.blobs.keys().next().value!;
          this.blobBytes -= this.blobs.get(oldest)!.byteLength; this.blobs.delete(oldest);
        }
        this.blobs.set(cacheKey, data); this.blobBytes += data.byteLength;
      }
      return data;
    }).finally(() => { this.pendingBlobs.delete(cacheKey); });
    this.pendingBlobs.set(cacheKey, download);
    return download;
  }
  async object(ref: string): Promise<ArrayBuffer> {
    if (!this.manifest) throw new Error("Read BOOX sources before downloading.");
    if (ref.startsWith("pdf:")) {
      const id = ref.slice(4);
      const item = [...this.manifest.notebooks, ...this.manifest.memos].find(n => n.id === id);
      if (!item) throw new Error("Unknown notebook.");
      return bindPdf(item.images, p => this.object(p), this.progress);
    }
    if (ref.startsWith("render:")) {
      const [id, page] = ref.slice(7).split("/");
      const kind = this.manifest.notebooks.some(n => n.id === id) ? "note" : "calendar";
      const objs = this.objectsByNotebook.get(`${kind}/${id}`) ?? [];
      let files = 0;
      this.progress(`Preparing page ${page}…`);
      return renderCloudPage(objs, kind, page, k => {
        this.progress(`Loading page ${page} data (file ${++files})…`);
        return this.raw(k);
      }, phase => this.progress(`${phase} page ${page}…`));
    }
    const file = this.manifest.files.find(f => f.key === ref);
    if (!file) throw new Error("File is not in the current BOOX inventory.");
    return this.raw(ref, file.bucket);
  }
}
