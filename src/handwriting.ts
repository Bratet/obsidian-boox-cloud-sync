import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import type { CloudObject } from "./manifest";

export interface Point { x: number; y: number; pressure: number }
export interface Stroke { id: string; points: Point[] }
export interface Style { color: number; thickness: number; pen: number; matrix?: number[]; reference: boolean; modified: number; status: number }
export interface Page { width: number; height: number; scale: number; strokes: Stroke[]; styles: Map<string, Style> }
const decode = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0.*$/, "").trim();
export class EmptyPageError extends Error { readonly emptyPage = true; constructor() { super("This page contains no ink."); } }
export function parsePoints(buffer: ArrayBuffer): Stroke[] {
  const b = new Uint8Array(buffer); const view = new DataView(buffer);
  if (b.length < 80) throw new Error("Truncated BOOX points file.");
  const index = view.getUint32(b.length - 4);
  if (index < 76 || index > b.length - 4 || (b.length - 4 - index) % 44) throw new Error("Invalid BOOX points index.");
  const strokes: Stroke[] = [];
  for (let i = index; i + 44 <= b.length - 4; i += 44) {
    const id = decode(b.subarray(i, i + 36)); let off = view.getUint32(i + 36); let size = view.getUint32(i + 40);
    if (off < 76 || off + size > index) throw new Error("Invalid BOOX stroke bounds.");
    if (size % 16 === 4 && view.getUint32(off) === 0) { off += 4; size -= 4; }
    if (size % 16) throw new Error("Truncated BOOX stroke.");
    const points: Point[] = [];
    for (let p = off; p < off + size; p += 16) {
      const x = view.getFloat32(p), y = view.getFloat32(p + 4);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid BOOX stroke coordinates.");
      points.push({ x, y, pressure: view.getUint16(p + 10) });
    }
    if (points.length) strokes.push({ id, points });
  }
  return strokes;
}
export function protobuf(b: Uint8Array): [number, number, number | Uint8Array][] {
  let i = 0;
  const varint = () => {
    let value = 0, shift = 0;
    for (let n = 0; n < 10 && i < b.length; n++) {
      const c = b[i++]; value += (c & 127) * 2 ** shift;
      if (!(c & 128)) return value; shift += 7;
    }
    throw new Error("Invalid BOOX protobuf integer.");
  };
  const out: [number, number, number | Uint8Array][] = [];
  while (i < b.length) {
    const tag = varint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field) throw new Error("Invalid BOOX protobuf field.");
    let value: number | Uint8Array;
    if (wire === 0) value = varint();
    else {
      const length = wire === 2 ? varint() : wire === 5 ? 4 : wire === 1 ? 8 : -1;
      if (length < 0 || i + length > b.length) throw new Error("Invalid BOOX protobuf length.");
      value = b.slice(i, i + length); i += length;
    }
    out.push([field, wire, value]);
  }
  return out;
}
const json = (b: number | Uint8Array): any => { try { return b instanceof Uint8Array ? JSON.parse(decode(b)) : null; } catch { return null; } };
export function parseShapes(buffer: ArrayBuffer): Map<string, Style> {
  const files = unzipSync(new Uint8Array(buffer)); const out = new Map<string, Style>();
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    for (const [f, w, v] of protobuf(data)) {
      if (f !== 1 || w !== 2 || !(v instanceof Uint8Array)) continue;
      let id = ""; const s: Style = { color: 0xff000000, thickness: 1, pen: 0, reference: false, modified: 0, status: 0 };
      for (const [field, wire, value] of protobuf(v)) {
        if (field === 1 && value instanceof Uint8Array) id = decode(value);
        if (field === 3 && typeof value === "number") s.modified = value;
        if (field === 4 && typeof value === "number") s.color = value;
        if (field === 5 && wire === 5 && value instanceof Uint8Array) s.thickness = new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat32(0, true);
        if (field === 8) { const m = json(value)?.values; if (Array.isArray(m) && m.length === 9 && m.every(Number.isFinite)) s.matrix = m; }
        if (field === 12 && typeof value === "number") s.pen = value;
        if (field === 15 && typeof value === "number") s.status = value;
        if (field === 25) s.reference = !!json(value)?.shapeReferenceBean;
      }
      if (!Number.isFinite(s.thickness) || s.thickness < 0) throw new Error("Invalid BOOX pen thickness.");
      if (id) out.set(id, s);
    }
  }
  return out;
}
export function parseBounds(buffer: ArrayBuffer): [number, number] {
  for (const [f, w, v] of protobuf(new Uint8Array(buffer))) {
    if (f === 7 && w === 2) { const d = json(v); if (d) {
      const width = Number(d.right) - Number(d.left || 0), height = Number(d.bottom) - Number(d.top || 0);
      if (width > 0 && height > 0 && Number.isFinite(width + height)) return [width, height];
    } }
  }
  return [1860, 2480];
}
export function tileRects(buffer: ArrayBuffer): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [f, w, v] of protobuf(new Uint8Array(buffer))) {
    if (f !== 1 || w !== 2 || !(v instanceof Uint8Array)) continue;
    let id = ""; let rect: number[] | undefined;
    for (const [sf, , sv] of protobuf(v)) {
      if (sf === 1 && sv instanceof Uint8Array) id = decode(sv);
      if (sf === 6) { const d = json(sv); if (d) rect = [d.left || 0, d.top || 0, d.right || 0, d.bottom || 0].map(Number); }
    }
    if (id && rect?.every(Number.isFinite)) out.set(id, rect);
  }
  return out;
}
export function strokeWidth(pen: number, thickness: number, pressure: number): number {
  const p = Math.max(0, Math.min(pressure, 4095)) / 4095;
  if (pen === 5) return Math.max(0.5, thickness * 1.37 * p ** 0.59);
  if (pen === 21) return thickness * 2.35 * p ** 0.43;
  return thickness;
}
const layer = (key: string) => key.split(/\/(?:point|shape)\//)[1]?.split("#")[0] ?? "";
const timestamp = (key: string) => Number(key.split("#").pop()?.split(".")[0]) || 0;
export async function preparePage(objects: CloudObject[], kind: string, page: string, get: (key: string) => Promise<ArrayBuffer>): Promise<Page> {
  const pointKeys = objects.map(o => o.key).filter(k => k.includes("/point/") && k.endsWith("#points"));
  const shapeKeys = objects.map(o => o.key).filter(k => k.includes("/shape/") && k.endsWith(".zip"));
  const virtual = objects.map(o => o.key).filter(k => k.includes("/virtual/page/pb/")).sort();
  let width = 1860, height = 2480; let composite = false;
  const rects = new Map<string, number[]>(); let selected = new Set([page]);
  if (kind === "note") {
    const pm = objects.find(o => o.key.endsWith(`/pageModel/pb/${page}`));
    const layers = new Set([...pointKeys, ...shapeKeys].map(layer));
    if (pm) {
      const data = await get(pm.key); const content = new TextDecoder().decode(data);
      selected = new Set([...layers].filter(l => l && content.includes(l)));
      if (virtual.length) composite = true; else [width, height] = parseBounds(data);
    } else if (!layers.has(page)) throw new Error("BOOX page is missing. Sync the tablet and retry.");
    for (const key of virtual) for (const [id, rect] of tileRects(await get(key))) rects.set(id, rect);
    if (!pm && rects.has(page)) { const r = rects.get(page)!; width = r[2] - r[0]; height = r[3] - r[1]; }
  }
  const styles = new Map<string, Style>();
  for (const key of shapeKeys.filter(k => selected.has(layer(k))).sort((a, b) => timestamp(a) - timestamp(b))) {
    for (const [id, style] of parseShapes(await get(key))) {
      if (!styles.has(id) || style.modified >= styles.get(id)!.modified) styles.set(id, style);
    }
  }
  const strokes: Stroke[] = [];
  for (const key of pointKeys.filter(k => selected.has(layer(k)))) {
    const r = composite ? rects.get(layer(key)) : undefined;
    for (const stroke of parsePoints(await get(key))) {
      const style = styles.get(stroke.id);
      if (style?.reference || style?.status) continue;
      const m = style?.matrix;
      strokes.push({ id: stroke.id, points: stroke.points.map(p => ({ ...p,
        x: (m ? m[0] * p.x + m[1] * p.y + m[2] : p.x) + (r?.[0] ?? 0),
        y: (m ? m[3] * p.x + m[4] * p.y + m[5] : p.y) + (r?.[1] ?? 0),
      })) });
    }
  }
  if (!strokes.length) throw new EmptyPageError();
  let scale = 1;
  if (composite) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) for (const p of s.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    for (const s of strokes) for (const p of s.points) { p.x -= minX - 60; p.y -= minY - 60; }
    width = maxX - minX + 120; height = maxY - minY + 120;
    scale = Math.min(2, 2480 / Math.max(width, height));
  }
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) throw new Error("Invalid BOOX page size.");
  scale = Math.min(scale, 8192 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
  for (const s of styles.values()) if (s.matrix) { const m = s.matrix; const factor = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])); if (factor > 0) s.thickness *= factor; }
  return { width, height, scale, strokes, styles };
}
export async function renderCloudPage(objects: CloudObject[], kind: string, page: string, get: (key: string) => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  const p = await preparePage(objects, kind, page, get);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(p.width * p.scale)); canvas.height = Math.max(1, Math.round(p.height * p.scale));
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Could not create the handwriting renderer.");
  try {
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    let count = 0;
    for (const stroke of p.strokes) {
      const s = p.styles.get(stroke.id); const color = s?.color ?? 0xff000000;
      ctx.strokeStyle = ctx.fillStyle = `rgb(${(color >>> 16) & 255},${(color >>> 8) & 255},${color & 255})`;
      const pts = stroke.points;
      for (let i = 0; i < Math.max(1, pts.length - 1); i++) {
        const a = pts[i], b = pts[i + 1] ?? a;
        const w = Math.max(1, strokeWidth(s?.pen ?? 0, s?.thickness ?? 1, (a.pressure + b.pressure) / 2) * p.scale);
        ctx.beginPath(); ctx.lineWidth = w;
        if (pts.length === 1) { ctx.arc(a.x * p.scale, a.y * p.scale, w / 2, 0, Math.PI * 2); ctx.fill(); }
        else { ctx.moveTo(a.x * p.scale, a.y * p.scale); ctx.lineTo(b.x * p.scale, b.y * p.scale); ctx.stroke(); }
        if (++count % 10000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("PNG rendering failed.")), "image/png"));
    return await blob.arrayBuffer();
  } finally { canvas.width = canvas.height = 0; }
}
export async function bindPdf(refs: string[], render: (ref: string) => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create(); doc.setProducer("BOOX Sync");
  for (const ref of refs) {
    let bytes: ArrayBuffer;
    try { bytes = await render(ref); } catch (e) { if (e instanceof EmptyPageError) continue; throw e; }
    const png = await doc.embedPng(bytes);
    const page = doc.addPage([png.width * 72 / 226, png.height * 72 / 226]);
    page.drawImage(png, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  if (!doc.getPageCount()) throw new EmptyPageError();
  return new Uint8Array(await doc.save()).buffer;
}
