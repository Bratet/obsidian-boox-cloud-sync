// Mirrors the backend manifest (app/backend/app.py :: assemble_sources).
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
}

export interface Memo {
  id: string;
  pages: number;
  images: string[];
}

export interface FileItem {
  name: string;
  size: number | null;
  fmt: string;
  key: string;
}

export interface Manifest {
  account: { uid: string | null };
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
}

export interface SyncState {
  version: number;
  lastSync: string | null;
  items: Record<string, SyncItem>;
}

// Plugin settings, persisted in .obsidian/plugins/boox-sync/data.json
export interface BooxSettings {
  backendUrl: string;
  apiKey: string;
  account: { uid: string | null; email: string | null } | null;
  syncFolder: string;
  intervalMinutes: number;
  syncHighlights: boolean;
  syncNotebooks: boolean;
  syncMemos: boolean;
  syncFiles: boolean;
  deleteRemoved: boolean;
}
