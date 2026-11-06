import { decodeFleece } from "./fleece";
import { SqliteReader } from "./sqlite";

// LiteCore document flag: the current revision is a deletion (tombstone).
const DELETED = 0x01;

export interface CblDoc { id: string; sequence: number; flags: number; body: Record<string, unknown> }

// Live documents of one Couchbase Lite database (`<name>.cblite2/db.sqlite3`
// plus its WAL). Bodies are decoded with the database's shared dict keys.
export function readCblDocs(db: Uint8Array, wal?: Uint8Array): CblDoc[] {
  const sql = new SqliteReader(db, wal);
  const tables = sql.tables();
  const info = tables.has("kv_info") ? sql.table("kv_info") : [];
  const shared = info.find(([key]) => key === "SharedKeys")?.[4];
  const sharedKeys = shared instanceof Uint8Array ? decodeFleece(shared) : [];
  if (!Array.isArray(sharedKeys) || sharedKeys.some(k => typeof k !== "string")) throw new Error("Invalid Couchbase Lite shared keys.");
  const docs: CblDoc[] = [];
  if (!tables.has("kv_default")) return docs;
  for (const [key, sequence, flags, , body] of sql.table("kv_default")) {
    if (typeof key !== "string" || typeof flags !== "number" || flags & DELETED || !(body instanceof Uint8Array) || !body.length) continue;
    const value = decodeFleece(body, sharedKeys as string[]);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    docs.push({ id: key, sequence: Number(sequence), flags, body: value as Record<string, unknown> });
  }
  return docs;
}
