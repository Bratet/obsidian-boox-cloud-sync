import { describe, it, expect } from "vitest";
import {
  sanitizeName, highlightPath, filePath, parentFolder,
  folderChain, memoFolderName, memoImagePath, notebookDir, notebookImagePath,
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
    expect(filePath("BOOX", "paper.pdf")).toBe("BOOX/Files/paper.pdf");
  });
  it("returns the parent folder of a path", () => {
    expect(parentFolder("BOOX/Files/paper.pdf")).toBe("BOOX/Files");
    expect(parentFolder("toplevel")).toBe("");
  });
});

describe("notebook image layout", () => {
  it("names the notebook folder by sanitized title, nested in the device chain", () => {
    expect(notebookDir("Journal", [])).toBe("Journal");
    expect(notebookDir("Week 2", ["Startup & SaaS", "Alif Sessions"]))
      .toBe("Startup & SaaS/Alif Sessions/Week 2");
    expect(notebookDir("A/B: C", [])).toBe("A B C");
  });
  it("builds <title>_<page>.png paths inside a per-notebook folder under Notebooks", () => {
    expect(notebookImagePath("BOOX", "Journal", "Journal", 1))
      .toBe("BOOX/Notebooks/Journal/Journal_1.png");
    expect(notebookImagePath("BOOX", "Startup & SaaS/Alif Sessions/Week 2", "Week 2", 3))
      .toBe("BOOX/Notebooks/Startup & SaaS/Alif Sessions/Week 2/Week 2_3.png");
    // a collision-suffixed folder keeps the clean title prefix on files
    expect(notebookImagePath("BOOX", "Notebook-1 (aaaa1111)", "Notebook-1", 2))
      .toBe("BOOX/Notebooks/Notebook-1 (aaaa1111)/Notebook-1_2.png");
  });
});

describe("memo image layout", () => {
  it("names the memo folder by compact calendar date", () => {
    expect(memoFolderName("2026-06-11", "c1abc")).toBe("20260611");
  });
  it("falls back to the memo id when the date is unknown", () => {
    expect(memoFolderName(null, "c1abc")).toBe("c1abc");
    expect(memoFolderName(undefined, "c1abc")).toBe("c1abc");
  });
  it("builds <date>_<page>.png paths inside a per-memo folder under Calendar memo", () => {
    expect(memoImagePath("BOOX", "20260611", "20260611", 1))
      .toBe("BOOX/Calendar memo/20260611/20260611_1.png");
    // a collision-suffixed folder keeps the clean date prefix on files
    expect(memoImagePath("BOOX", "20260611 (aaaa1111)", "20260611", 2))
      .toBe("BOOX/Calendar memo/20260611 (aaaa1111)/20260611_2.png");
  });
});

describe("folderChain", () => {
  const folders = [
    { id: "fB", title: "Startup & SaaS", parentId: null },
    { id: "fA", title: "Alif: Sessions", parentId: "fB" },
  ];
  it("builds the sanitized root→leaf directory chain", () => {
    expect(folderChain(folders, "fA")).toEqual(["Startup & SaaS", "Alif Sessions"]);
    expect(folderChain(folders, "fB")).toEqual(["Startup & SaaS"]);
  });
  it("treats an unknown or absent folder as root", () => {
    expect(folderChain(folders, "nope")).toEqual([]);
    expect(folderChain(folders, null)).toEqual([]);
    expect(folderChain(folders, undefined)).toEqual([]);
    expect(folderChain(undefined, "fA")).toEqual([]);
  });
  it("stops at a missing parent link — partial chain, never a crash", () => {
    expect(folderChain([{ id: "fA", title: "A", parentId: "ghost" }], "fA")).toEqual(["A"]);
  });
  it("terminates on a corrupt parent cycle", () => {
    const cyc = [
      { id: "f1", title: "One", parentId: "f2" },
      { id: "f2", title: "Two", parentId: "f1" },
    ];
    expect(folderChain(cyc, "f1")).toEqual(["Two", "One"]);
  });
});
