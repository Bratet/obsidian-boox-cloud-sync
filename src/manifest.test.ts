import { describe, it, expect } from "vitest";
import { assembleSources, type Snapshot } from "./manifest";
const docs = (over: Partial<Snapshot> = {}): Snapshot => ({ notes: [], library: [], messages: [], calendar: [], ...over });
const obj = (keys: string[]) => keys.map(key => ({ key, size: 10, etag: "original" }));
describe("cloud inventory", () => {
  it("uses device tile order, preserves folders and ignores recycled notebooks", () => {
    const d = docs({ notes: [
      { uniqueId: "folder", title: "Work", type: 0 },
      { uniqueId: "n", title: "Notes", type: 1, parentUniqueId: "folder", pageNameList: { pageNameList: ["B", "A"] } },
      { uniqueId: "gone", title: "Deleted", status: 0 },
    ] });
    const m = assembleSources("u", d, obj(["u/note/n/pageModel/pb/container", "u/note/n/point/A#x#points", "u/note/n/point/B#x#points", "u/note/gone/pageModel/pb/a"]));
    expect(m.folders).toEqual([{ id: "folder", title: "Work", parentId: null }]);
    expect(m.notebooks).toHaveLength(1);
    expect(m.notebooks[0]).toMatchObject({ title: "Notes", folderId: "folder", images: ["render:n/B", "render:n/A"], pdf: "pdf:n" });
  });
  it("orders memo pages by device metadata and otherwise earliest stroke batch", () => {
    const objects = obj(["u/calendar/c/point/A#x#points", "u/calendar/c/point/B#x#points", "u/calendar/c/shape/A#x#200.zip", "u/calendar/c/shape/B#x#100.zip", "u/calendar/c/shape/B#x#900.zip"]);
    const fallback = assembleSources("u", docs(), objects);
    expect(fallback.memos[0].images).toEqual(["render:c/B", "render:c/A"]);
    const explicit = assembleSources("u", docs({ calendar: [{ uniqueId: "c", associateDate: "20260920", pageNameList: { pageNameList: ["A", "B"] } }] }), objects);
    expect(explicit.memos[0]).toMatchObject({ date: "2026-09-20", images: ["render:c/A", "render:c/B"] });
  });
  it("detects same-size cloud edits using the object ETag", () => {
    const d = docs({ notes: [{ uniqueId: "n", title: "N" }] });
    const objects = obj(["u/note/n/pageModel/pb/P"]);
    const a = assembleSources("u", d, objects);
    const b = assembleSources("u", d, objects.map(o => ({ ...o, etag: "edited" })));
    expect(a.notebooks[0].sig).not.toBe(b.notebooks[0].sig);
  });
  it("maps book names and retains each attachment's logical storage bucket", () => {
    const m = assembleSources("u", docs({ library: [{ uniqueId: "b", name: "Book" }, { uniqueId: "h", documentId: "b", quote: "Quote", pageNumber: 4 }],
      messages: [{ content: JSON.stringify({ name: "File.pdf", formats: ["pdf"], storage: { pdf: { oss: { key: "k", bucket: "other" } } } }) }] }), []);
    expect(m.highlights[0]).toMatchObject({ id: "h", book: "Book", page: 4 });
    expect(m.files[0]).toMatchObject({ key: "k", bucket: "other" });
  });
});
