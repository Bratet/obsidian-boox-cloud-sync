import type { Manifest } from "./types";
import { hashString } from "./hash";

export interface CloudObject { key: string; size: number; etag?: string; modified?: string }
export type CloudDoc = Record<string, any>;
export interface Snapshot { notes: CloudDoc[]; library: CloudDoc[]; messages: CloudDoc[]; calendar: CloudDoc[] }

// Port of the companion's assemble_sources, including device page order and recycle-bin semantics.
export function assembleSources(uid: string, docs: Snapshot, objects: CloudObject[]): Manifest {
  const live = docs.notes.filter(d => d.uniqueId && d.status !== 0 && !d._deleted);
  const liveIds = new Set(live.map(d => d.uniqueId));
  const meta = new Map(live.filter(d => d.title).map(d => [d.uniqueId, d]));
  const calendar = new Map(docs.calendar.filter(d => d.uniqueId && d.associateDate && !d._deleted).map(d => [d.uniqueId, d]));
  const groups = new Map<string, { id: string; kind: string; objects: CloudObject[] }>();
  for (const obj of objects) {
    const [owner, kind, id] = obj.key.split("/");
    if (owner !== uid || !id || !["note", "calendar"].includes(kind)) continue;
    if (kind === "note" && !liveIds.has(id)) continue;
    if (kind === "calendar" && calendar.get(id)?.status === 0) continue;
    const group = groups.get(`${kind}/${id}`) ?? { id, kind, objects: [] };
    group.objects.push(obj);
    groups.set(`${kind}/${id}`, group);
  }
  const result: Manifest = { account: { uid }, folders: live.filter(d => d.title && d.type === 0 && !("commitId" in d) && !("modeType" in d))
    .map(d => ({ id: d.uniqueId, title: d.title, parentId: d.parentUniqueId || null })), notebooks: [], memos: [], files: [], highlights: [] };
  for (const { id, kind, objects: objs } of groups.values()) {
    const d = (kind === "note" ? meta.get(id) : calendar.get(id)) ?? {};
    const pnl: string[] = d.pageNameList?.pageNameList ?? [];
    const pids = objs.filter(o => o.key.includes("/pageModel/pb/")).map(o => o.key.split("/").pop()!);
    const layers = new Map<string, { points: boolean; ts: number }>();
    for (const { key } of objs) {
      const p = key.split("/");
      if (!p[4] || !["point", "shape"].includes(p[3])) continue;
      const lid = p[4].split("#")[0];
      const l = layers.get(lid) ?? { points: false, ts: Infinity };
      if (p[3] === "point") l.points = true;
      else { const ts = Number(p[4].split("#").pop()?.replace(/\.zip$/, "")); if (Number.isFinite(ts)) l.ts = Math.min(l.ts, ts); }
      layers.set(lid, l);
    }
    const position = (id: string) => pnl.includes(id) ? pnl.indexOf(id) : Infinity;
    let pages: string[];
    if (kind === "note") {
      pages = pnl.length && d.activeScene !== 4 && !pnl.some(p => pids.includes(p))
        ? pnl.filter(p => layers.get(p)?.points)
        : pids.sort((a, b) => (position(a) - position(b)) || a.localeCompare(b));
    } else {
      pages = [...layers.keys()].filter(l => layers.get(l)!.points).sort((a, b) =>
        (position(a) - position(b)) || (layers.get(a)!.ts - layers.get(b)!.ts) || a.localeCompare(b));
    }
    const sig = hashString(JSON.stringify(objs.slice().sort((a, b) => a.key.localeCompare(b.key))));
    const times = objs.map(o => Date.parse(o.modified ?? "")).filter(Number.isFinite);
    const common = { id, images: pages.map(p => `render:${id}/${p}`), pages: pages.length, sig, pdf: `pdf:${id}`,
      modified: times.length ? Math.max(...times) : null };
    if (kind === "note") result.notebooks.push({ ...common, title: d.title || "Untitled", updatedAt: d.updatedAt ?? null,
      folderId: d.parentUniqueId || null, previewKey: objs.find(o => o.key.endsWith(`/${id}.png`))?.key ?? null });
    else { const raw = String(d.associateDate ?? ""); result.memos.push({ ...common,
      date: /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : null }); }
  }
  for (const d of docs.messages) {
    if (d._deleted || d.status === 0 || typeof d.content !== "string") continue;
    let c; try { c = JSON.parse(d.content); } catch { continue; }
    const fmt = c.formats?.[0]; const oss = c.storage?.[fmt]?.oss;
    if (oss?.key) result.files.push({ name: c.name || oss.key.split("/").pop(), size: c.size ?? null, fmt,
      key: oss.key, bucket: oss.bucket || "onyx-cloud", sig: objects.find(o => o.key === oss.key)?.etag });
  }
  const books = new Map(docs.library.filter(d => d.name).map(d => [d.uniqueId, d.name]));
  result.highlights = docs.library.filter(d => !d._deleted && d.status !== 0 && (d.quote || d.note)).map(d => ({
    id: d.uniqueId || d._id, bookId: d.documentId || d.uniqueId || d._id, book: books.get(d.documentId) || "Book",
    quote: d.quote || "", note: d.note || "", chapter: d.chapter || "", page: d.pageNumber ?? null,
  }));
  result.notebooks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  result.memos.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id));
  return result;
}
