import { describe, it, expect } from "vitest";
import { planSync, executeSync, type SyncAction } from "./sync";
import { emptyState } from "./state";
import { safeFolder, sanitizeName } from "./paths";
import type { Manifest, BooxSettings } from "./types";
import type { VaultIO } from "./ports";
const settings: BooxSettings = { account: null, syncFolder: "BOOX", intervalMinutes: 30, syncHighlights: true, syncNotebooks: true, syncMemos: true, syncFiles: true, deleteRemoved: false };
const manifest: Manifest = { account: { uid: "u" }, highlights: [], files: [], memos: [], notebooks: [{ id: "n", title: "Notes", updatedAt: null, pages: 2, previewKey: null, pdf: "pdf:n", images: ["render:n/A", "render:n/B"] }] };
const binary = (s: string) => new TextEncoder().encode(s).buffer;
function vault(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [k, binary(v)]));
  const io: VaultIO = { exists: async p => files.has(p), read: async p => new TextDecoder().decode(files.get(p)), readBinary: async p => files.get(p)!,
    write: async (p, t) => { files.set(p, binary(t)); }, writeBinary: async (p, b) => { files.set(p, b); }, remove: async p => { files.delete(p); } };
  return { files, io };
}
describe("customization and safe sync", () => {
  it("disambiguates notebook IDs sharing a UUID timestamp prefix", () => {
    const m = { ...manifest, notebooks: ["019abcde-1111", "019abcde-2222"].map(id => ({ ...manifest.notebooks[0], id, pdf: `pdf:${id}` })) };
    const actions = planSync(m, emptyState(), settings, "now");
    const paths = actions.flatMap(a => a.kind === "images" ? a.assets.map(x => x.path) : []);
    expect(new Set(paths).size).toBe(2);
  });
  it("applies custom naming and switches PDF exports to individually named PNG pages", () => {
    const a = planSync(manifest, emptyState(), { ...settings, notebooksFolder: "Writing/Notes", notebookName: "{title} - {id}", pageName: "Page {page}", exportFormat: "png" }, "now");
    expect(a[0]).toMatchObject({ kind: "images", assets: [{ path: "BOOX/Writing/Notes/Notes - n/Page 1.png" }, { path: "BOOX/Writing/Notes/Notes - n/Page 2.png" }] });
  });
  it("rejects templates that map multiple pages to one file", () => {
    expect(() => planSync(manifest, emptyState(), { ...settings, exportFormat: "png", pageName: "Same" }, "now")).toThrow("duplicate path");
  });
  it("renames highlights even when their content is unchanged", () => {
    const m = { ...manifest, notebooks: [], highlights: [{ id: "h", bookId: "b", book: "Book", quote: "q", note: "", chapter: "", page: 1 }] };
    const first = planSync(m, emptyState(), settings, "now")[0];
    if (first.kind !== "note") throw new Error();
    const previous = emptyState(); previous.items[first.itemKey] = { hash: first.hash, path: first.path };
    expect(planSync(m, previous, { ...settings, highlightName: "{title} highlights" }, "now")[0]).toMatchObject({ path: "BOOX/Highlights/Book highlights.md" });
  });
  it("rejects path traversal and handles Windows reserved names", () => {
    expect(() => safeFolder("../outside")).toThrow(); expect(() => safeFolder(".obsidian/plugins")).toThrow();
    expect(sanitizeName("CON")).toBe("_CON"); expect(sanitizeName(".. ")).toBe("Untitled");
  });
  it("does not overwrite or erase untracked vault files", async () => {
    const { files, io } = vault({ "BOOX/Notes.pdf": "personal" });
    const a: SyncAction = { kind: "images", itemKey: "notebook:n", hash: "h", assets: [{ path: "BOOX/Notes.pdf", ossKey: "pdf:n" }] };
    const { summary } = await executeSync([a], emptyState(), io, { object: async () => binary("cloud") });
    expect(new TextDecoder().decode(files.get("BOOX/Notes.pdf"))).toBe("personal"); expect(summary.skippedUserEdited).toHaveLength(1);
  });
  it("protects annotated PDFs during update and delete", async () => {
    const { files, io } = vault();
    const a: SyncAction = { kind: "images", itemKey: "notebook:n", hash: "h", assets: [{ path: "BOOX/Notes.pdf", ossKey: "pdf:n" }] };
    const fetcher = { object: async () => binary("cloud") };
    const first = await executeSync([a], emptyState(), io, fetcher);
    files.set("BOOX/Notes.pdf", binary("annotated"));
    const update = await executeSync([a], first.state, io, fetcher);
    expect(update.summary.skippedUserEdited).toEqual(["BOOX/Notes.pdf"]);
    const deletion: SyncAction = { kind: "delete", itemKey: "notebook:n", path: "", assets: ["BOOX/Notes.pdf"] };
    const removed = await executeSync([deletion], first.state, io, fetcher);
    expect(removed.summary.deleted).toBe(0); expect(files.has("BOOX/Notes.pdf")).toBe(true);
  });
  it("downloads all pages successfully before replacing any existing page", async () => {
    const { files, io } = vault();
    const a: SyncAction = { kind: "images", itemKey: "notebook:n", hash: "h", assets: [{ path: "BOOX/A.png", ossKey: "a" }, { path: "BOOX/B.png", ossKey: "b" }] };
    const first = await executeSync([a], emptyState(), io, { object: async () => binary("original") });
    const failed = await executeSync([a], first.state, io, { object: async k => { if (k === "b") throw new Error("download failed"); return binary("new"); } });
    expect(failed.summary.errors).toHaveLength(1); expect(new TextDecoder().decode(files.get("BOOX/A.png"))).toBe("original");
  });
  it("does not interpret a cloud 404 as an erased page", async () => {
    const { files, io } = vault();
    const a: SyncAction = { kind: "images", itemKey: "notebook:n", hash: "h", assets: [{ path: "BOOX/A.png", ossKey: "a" }] };
    const first = await executeSync([a], emptyState(), io, { object: async () => binary("original") });
    const failed = await executeSync([a], first.state, io, { object: async () => { throw Object.assign(new Error("missing object"), { status: 404 }); } });
    expect(failed.summary.errors).toHaveLength(1); expect(files.has("BOOX/A.png")).toBe(true);
  });
  it("protects edits made while the replacement is downloading", async () => {
    const { files, io } = vault();
    const action: SyncAction = { kind: "images", itemKey: "notebook:n", hash: "h", assets: [{ path: "BOOX/A.png", ossKey: "a" }] };
    const first = await executeSync([action], emptyState(), io, { object: async () => binary("original") });
    const updated = await executeSync([action], first.state, io, { object: async () => {
      files.set("BOOX/A.png", binary("edited during sync"));
      return binary("new cloud image");
    } });
    expect(updated.summary.skippedUserEdited).toEqual(["BOOX/A.png"]);
    expect(new TextDecoder().decode(files.get("BOOX/A.png"))).toBe("edited during sync");
  });
});
