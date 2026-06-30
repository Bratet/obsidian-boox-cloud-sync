import { SYNC_STATE_VERSION, type SyncState, type Highlight } from "./types";

export const STATE_FILENAME = ".boox-sync.json";

export function emptyState(): SyncState {
  return { version: SYNC_STATE_VERSION, lastSync: null, items: {} };
}

export function parseState(raw: string): SyncState {
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || typeof j.items !== "object" || j.items === null) {
      return emptyState();
    }
    return {
      version: SYNC_STATE_VERSION,
      lastSync: typeof j.lastSync === "string" ? j.lastSync : null,
      items: j.items,
    };
  } catch {
    return emptyState();
  }
}

export function serializeState(state: SyncState): string {
  return JSON.stringify(state, null, 2);
}

export const bookKey = (bookId: string): string => `highlight-book:${bookId}`;
export const notebookKey = (id: string): string => `notebook:${id}`;
export const memoKey = (id: string): string => `memo:${id}`;
export const fileKey = (ossKey: string): string => `file:${ossKey}`;

export function groupByBook(highlights: Highlight[]): Map<string, Highlight[]> {
  const m = new Map<string, Highlight[]>();
  for (const h of highlights) {
    const k = h.bookId || "_";
    const arr = m.get(k);
    if (arr) arr.push(h);
    else m.set(k, [h]);
  }
  return m;
}
