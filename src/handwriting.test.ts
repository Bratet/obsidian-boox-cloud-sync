import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { parsePoints, parseShapes, parseBounds, tileRects, preparePage, EmptyPageError, strokeWidth, bindPdf } from "./handwriting";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/handwriting.json", import.meta.url), "utf8"));
const data = (name: string) => new Uint8Array(Buffer.from(fixture[name], "base64")).buffer;
const id = "a".repeat(36);
const objects = (names: string[]) => names.map(key => ({ key, size: 1 }));
describe("backend handwriting format compatibility", () => {
  it("decodes the backend's synthetic big-endian point fixture", () => {
    expect(parsePoints(data("points"))).toEqual([{ id, points: [{ x: 10, y: 20, pressure: 2048 }, { x: 30, y: 40, pressure: 4095 }] }]);
  });
  it("decodes stroke color, pen, matrix, modification time and erased flags", () => {
    expect(parseShapes(data("shape")).get(id)).toMatchObject({ color: 0xff123456, thickness: 3, pen: 5, modified: 100, matrix: [2, 0, 100, 0, 2, 200, 0, 0, 1] });
    expect(parseShapes(data("erased")).get(id)?.status).toBe(1);
    expect(parseShapes(data("reference")).get(id)?.reference).toBe(true);
  });
  it("decodes page dimensions and infinite-canvas tile offsets", () => {
    expect(parseBounds(data("page"))).toEqual([1860, 2480]);
    expect(tileRects(data("virtual")).get("L1")).toEqual([1860, 0, 3720, 2480]);
  });
  it("applies the latest affine transform and scales ink width", async () => {
    const keys = ["u/note/n/point/L1#D#points", "u/note/n/shape/L1#S#1.zip", "u/note/n/pageModel/pb/P"];
    const p = await preparePage(objects(keys), "note", "P", async k => data(k.includes("point/") ? "points" : k.includes("shape/") ? "shape" : "page"));
    expect(p.strokes[0].points[0]).toEqual({ x: 120, y: 240, pressure: 2048 });
    expect(p.styles.get(id)?.thickness).toBe(6);
  });
  it("suppresses erased strokes using their newest shape revision", async () => {
    const keys = ["u/calendar/n/point/L1#D#points", "u/calendar/n/shape/L1#S#1.zip", "u/calendar/n/shape/L1#S#2.zip"];
    await expect(preparePage(objects(keys), "calendar", "L1", async k => data(k.includes("point/") ? "points" : k.endsWith("2.zip") ? "erased" : "shape"))).rejects.toBeInstanceOf(EmptyPageError);
  });
  it("does not turn failed downloads into empty pages", async () => {
    const keys = ["u/calendar/n/point/L1#D#points"];
    await expect(preparePage(objects(keys), "calendar", "L1", async () => { throw new Error("network failure"); })).rejects.toThrow("network failure");
  });
  it("loads eight handwriting files in two batches of four", async () => {
    vi.useFakeTimers();
    try {
      let active = 0, maxActive = 0;
      const keys = Array.from({ length: 8 }, (_, i) => `u/calendar/n/point/L1#D${i}#points`);
      const ready = preparePage(objects(keys), "calendar", "L1", async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise(resolve => setTimeout(resolve, 100));
        active--; return data("points");
      });
      await vi.advanceTimersByTimeAsync(200);
      expect((await ready).strokes).toHaveLength(8);
      expect(maxActive).toBe(4);
      expect(active).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("applies shape revisions in order even when downloads finish out of order", async () => {
    vi.useFakeTimers();
    try {
      const keys = ["u/calendar/n/shape/L1#S#1.zip", "u/calendar/n/shape/L1#S#2.zip", "u/calendar/n/point/L1#D#points"];
      const ready = expect(preparePage(objects(keys), "calendar", "L1", async key => {
        await new Promise(resolve => setTimeout(resolve, key.endsWith("1.zip") ? 100 : 10));
        return data(key.includes("point/") ? "points" : key.endsWith("2.zip") ? "erased" : "shape");
      })).rejects.toBeInstanceOf(EmptyPageError);
      await vi.advanceTimersByTimeAsync(100); await ready;
    } finally { vi.useRealTimers(); }
  });
  it("drains a failed batch and never schedules the remaining page files", async () => {
    vi.useFakeTimers();
    try {
      let completed = 0;
      const get = vi.fn(async (key: string) => {
        await new Promise(resolve => setTimeout(resolve, key.includes("D0#") ? 10 : 100));
        completed++;
        if (key.includes("D0#")) throw new Error("download failed");
        return data("points");
      });
      const keys = Array.from({ length: 8 }, (_, i) => `u/calendar/n/point/L1#D${i}#points`);
      const ready = expect(preparePage(objects(keys), "calendar", "L1", get)).rejects.toThrow("download failed");
      await vi.advanceTimersByTimeAsync(100); await ready;
      expect(get).toHaveBeenCalledTimes(4);
      expect(completed).toBe(4);
    } finally { vi.useRealTimers(); }
  });
  it("crops and bounds infinite-canvas output", async () => {
    const keys = ["u/note/n/point/L1#D#points", "u/note/n/pageModel/pb/P", "u/note/n/virtual/page/pb/V"];
    const p = await preparePage(objects(keys), "note", "P", async k => data(k.includes("point/") ? "points" : k.includes("virtual/") ? "virtual" : "page"));
    expect(p.width).toBe(140); expect(p.height).toBe(140);
    expect(p.strokes[0].points[0]).toMatchObject({ x: 60, y: 60 });
  });
  it("rejects corrupt binary data rather than producing a partial page", () => {
    expect(() => parsePoints(new ArrayBuffer(4))).toThrow("Truncated");
    expect(() => parseShapes(new ArrayBuffer(4))).toThrow();
  });
  it("uses backend pressure formulas", () => {
    expect(strokeWidth(5, 3, 4095)).toBeCloseTo(4.11);
    expect(strokeWidth(21, 3, 4095)).toBeCloseTo(7.05);
    expect(strokeWidth(2, 3, 20)).toBe(3);
  });
  it("binds PNGs into a valid PDF and only skips explicitly empty pages", async () => {
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN8AAAAASUVORK5CYII=", "base64")).buffer;
    const bytes = await bindPdf(["a", "empty", "b"], async ref => { if (ref === "empty") throw new EmptyPageError(); return png; });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2); expect(pdf.getPage(0).getWidth()).toBeCloseTo(72 / 226);
    await expect(bindPdf(["bad"], async () => { throw new Error("missing blob"); })).rejects.toThrow("missing blob");
  });
  it("compresses each PDF page before rendering the next one", async () => {
    const doc = await PDFDocument.create();
    const create = vi.spyOn(PDFDocument, "create").mockResolvedValue(doc);
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN8AAAAASUVORK5CYII=", "base64")).buffer;
    try {
      const output = await bindPdf(["a", "b"], async ref => {
        if (ref === "b") {
          const embedded = doc.context.enumerateIndirectObjects().filter(([, object]) =>
            object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
          expect(embedded.length).toBeGreaterThan(0);
        }
        return png;
      });
      expect((await PDFDocument.load(output)).getPageCount()).toBe(2);
    } finally { create.mockRestore(); }
  });
});
