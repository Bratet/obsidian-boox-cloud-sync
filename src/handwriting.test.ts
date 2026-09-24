import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parsePoints, parseShapes, parseBounds, tileRects, preparePage, EmptyPageError, strokeWidth, bindPdf } from "./handwriting";
import { PDFDocument } from "pdf-lib";
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
});
