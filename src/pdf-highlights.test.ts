import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { readPdfHighlights } from "./pdf-highlights";

// Annotations shaped like NeoReader's: the record lives in /onyxtag JSON.
async function pdf(pages: { subtype: string; extra?: Record<string, unknown> }[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const annots of pages) {
    const page = doc.addPage();
    if (!annots.length) continue;
    page.node.set(PDFName.of("Annots"), doc.context.obj(annots.map(({ subtype, extra }) => doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: subtype, Rect: [0, 0, 10, 10], Contents: PDFString.of(""),
      ...(extra ? { onyxtag: PDFHexString.fromText(JSON.stringify({ type: "highlight", extra_attr: JSON.stringify(extra) })) } : {}),
    })))));
  }
  return doc.save();
}

describe("NeoReader highlights saved in a PDF", () => {
  it("reads quote, chapter and 0-based page from onyx highlights only", async () => {
    const bytes = await pdf([[], [
      { subtype: "Highlight", extra: { uuid: "u1", quote: "Ask about the past", chapterTitle: "Using the mom test" } },
      { subtype: "Stamp", extra: { paintStyle: 1 } },
      { subtype: "Highlight" },
    ]]);
    expect(await readPdfHighlights(bytes, "book")).toEqual([
      { uniqueId: "u1", documentId: "book", status: 0, pageNumber: 1, quote: "Ask about the past", note: "", chapter: "Using the mom test" },
    ]);
  });
  it("returns an empty list once every highlight is deleted but other NeoReader marks remain", async () => {
    expect(await readPdfHighlights(await pdf([[{ subtype: "Stamp", extra: { paintStyle: 1 } }]]), "book")).toEqual([]);
  });
  it("defers to the library database when the file has no NeoReader annotations", async () => {
    expect(await readPdfHighlights(await pdf([[{ subtype: "Highlight" }]]), "book")).toBeNull();
  });
});
