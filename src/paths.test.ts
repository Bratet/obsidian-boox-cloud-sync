import { describe, it, expect } from "vitest";
import {
  sanitizeName, highlightPath, notebookPath, memoPath, filePath, assetPath, parentFolder,
} from "./paths";

describe("sanitizeName", () => {
  it("replaces illegal characters with spaces and collapses them", () => {
    expect(sanitizeName('a/b:c*d?"e<f>g|h')).toBe("a b c d e f g h");
  });
  it("falls back to Untitled for empty/blank names", () => {
    expect(sanitizeName("")).toBe("Untitled");
    expect(sanitizeName("   ")).toBe("Untitled");
  });
  it("keeps dots so extensions survive", () => {
    expect(sanitizeName("My Book.pdf")).toBe("My Book.pdf");
  });
});

describe("path builders", () => {
  it("builds typed vault paths under the sync folder", () => {
    expect(highlightPath("BOOX", "The Idea: A Story")).toBe("BOOX/Highlights/The Idea A Story.md");
    expect(notebookPath("BOOX", "Journal")).toBe("BOOX/Notebooks/Journal.md");
    expect(memoPath("BOOX", "c1abc")).toBe("BOOX/Memos/c1abc.md");
    expect(filePath("BOOX", "paper.pdf")).toBe("BOOX/Files/paper.pdf");
  });
  it("derives a stable asset path from the OSS key basename", () => {
    expect(assetPath("BOOX", "note1", "uid/note/note1/note1.png"))
      .toBe("BOOX/_assets/note1/note1.png");
  });
  it("returns the parent folder of a path", () => {
    expect(parentFolder("BOOX/Files/paper.pdf")).toBe("BOOX/Files");
    expect(parentFolder("toplevel")).toBe("");
  });
});
