import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import type { CloudDoc } from "./manifest";

// NeoReader saves highlights into the PDF itself: a /Highlight annotation
// whose /onyxtag JSON carries the record (uuid, quote, chapter, createdAt).
// Its library database stops receiving them, so for PDF books the file is the
// source of truth, deletions included. Returns library-shaped highlight
// records, or null when the file holds no NeoReader annotations (or cannot be
// decrypted), leaving the library database as the source for that book.
export async function readPdfHighlights(bytes: Uint8Array, documentId: string): Promise<CloudDoc[] | null> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (pdf.isEncrypted) return null;
  let tagged = false;
  const out: CloudDoc[] = [];
  pdf.getPages().forEach((page, index) => {
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      const tag = text(annot.lookup(PDFName.of("onyxtag")));
      if (!tag) continue;
      tagged = true;
      if (annot.get(PDFName.of("Subtype"))?.toString() !== "/Highlight") continue;
      const extra = jsonObject(jsonObject(tag)?.get("extra_attr"));
      if (!extra) continue;
      const field = (key: string) => { const v = extra.get(key); return typeof v === "string" ? v : ""; };
      out.push({
        uniqueId: field("uuid") || `${documentId}:${index}:${i}`, documentId, status: 0, pageNumber: index,
        quote: field("quote"), note: field("note") || text(annot.lookup(PDFName.of("Contents"))), chapter: field("chapterTitle"),
      });
    }
  });
  return tagged ? out : null;
}

function text(value: unknown): string {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "";
}

// Parsed JSON object text as a map, or null for anything else.
function jsonObject(source: unknown): Map<string, unknown> | null {
  if (typeof source !== "string") return null;
  try {
    const value: unknown = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? new Map(Object.entries(value)) : null;
  } catch { return null; }
}
