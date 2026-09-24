import type { EncryptedSession } from "./credentials";
// Normalized inventory built locally from BOOX cloud documents.
export interface Highlight {
  id: string;
  bookId: string;
  book: string;
  quote: string;
  note: string;
  chapter: string;
  page: number | null;
}

export interface Notebook {
  id: string;
  pages: number;
  previewKey: string | null;
  images: string[];
  title: string;
  updatedAt: number | null;
  folderId?: string | null; // containing device folder; null/absent = root
  sig?: string | null; // content signature of the item's cloud objects — stroke
  // edits change it even when the page refs stay identical
  pdf?: string | null; // local renderer reference (`pdf:<id>`)
}

// A Notes-app folder from the device tree (NOTE_TREE type-0 doc).
export interface BooxFolder {
  id: string;
  title: string;
  parentId: string | null;
}

export interface Memo {
  id: string;
  pages: number;
  images: string[];
  date?: string | null; // calendar day (ISO YYYY-MM-DD); null until the memo's doc mirrors
  sig?: string | null; // content signature — see Notebook.sig
  pdf?: string | null; // local renderer reference (`pdf:<id>`)
}

export interface FileItem {
  name: string;
  size: number | null;
  fmt: string;
  key: string;
  bucket?: string;
  sig?: string;
}

export interface Manifest {
  account: { uid: string | null };
  folders?: BooxFolder[];
  notebooks: Notebook[];
  memos: Memo[];
  files: FileItem[];
  highlights: Highlight[];
}

// Local sync state, persisted as <syncFolder>/.boox-sync.json
export const SYNC_STATE_VERSION = 1;

export interface SyncItem {
  hash: string; // hash of the source data — detects BOOX-side changes
  path: string; // vault-relative path written
  written?: string; // hash of the exact note bytes we wrote — detects user edits
  assets?: string[]; // local asset paths written for this item
  size?: number | null; // for files — change detection by size
  binaryHashes?: Record<string, string>;
}

export interface SyncState {
  version: number;
  lastSync: string | null;
  items: Record<string, SyncItem>;
  accountUid?: string;
}

// Plugin settings, persisted in .obsidian/plugins/boox-cloud-sync/data.json
export interface BooxSettings {
  encryptedSession?: EncryptedSession | null;
  region?: string;
  account: { uid: string | null; email: string | null } | null;
  syncFolder: string;
  intervalMinutes: number;
  syncHighlights: boolean;
  syncNotebooks: boolean;
  syncMemos: boolean;
  syncFiles: boolean;
  deleteRemoved: boolean;
  highlightsFolder?: string;
  notebooksFolder?: string;
  memosFolder?: string;
  filesFolder?: string;
  notebookName?: string;
  highlightName?: string;
  memoName?: string;
  attachmentName?: string;
  pageName?: string;
  dateFormat?: string;
  preserveFolders?: boolean;
  exportFormat?: "pdf" | "png";
  highlightTemplate?: string;
  syncOnStartup?: boolean;
}
