import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteReader } from "./sqlite";

// Couchbase Lite keeps recent writes in the WAL; the reader must see exactly
// the committed state, as SQLite itself would.
let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

function walDatabase() {
  dir = mkdtempSync(join(tmpdir(), "boox-sqlite-"));
  const path = join(dir, "db.sqlite3");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE kv (key TEXT PRIMARY KEY, n INTEGER, body BLOB)");
  // Read while the connection is open: closing it would checkpoint the WAL.
  const files = () => ({ db: new Uint8Array(readFileSync(path)), wal: new Uint8Array(readFileSync(`${path}-wal`)) });
  return { db, files };
}

describe("SqliteReader", () => {
  it("reads rows that exist only in the WAL, including overflow pages", () => {
    const { db, files } = walDatabase();
    const big = new Uint8Array(20_000).map((_, i) => i % 251);
    const insert = db.prepare("INSERT INTO kv VALUES (?, ?, ?)");
    for (let i = 0; i < 300; i++) insert.run(`doc-${i}`, i * 1_000_000_007, i === 7 ? big : new Uint8Array([i % 256]));
    const { db: image, wal } = files();
    const rows = new SqliteReader(image, wal).table("kv");
    expect(rows).toHaveLength(300);
    expect(rows[7][0]).toBe("doc-7");
    expect(rows[7][2]).toEqual(big);
    expect(rows[299][1]).toBe(299 * 1_000_000_007);
    db.close();
  });

  it("ignores frames of a transaction that never committed", () => {
    const { db, files } = walDatabase();
    db.prepare("INSERT INTO kv VALUES ('first', 1, NULL)").run();
    const committed = files().wal.length;
    db.prepare("INSERT INTO kv VALUES ('second', 2, NULL)").run();
    const { db: image, wal } = files();
    // The second transaction's frames, cut before its commit frame.
    const torn = wal.subarray(0, wal.length - 1);
    expect(new SqliteReader(image, torn).table("kv").map(r => r[0])).toEqual(["first"]);
    expect(new SqliteReader(image, wal.subarray(0, committed)).table("kv").map(r => r[0])).toEqual(["first"]);
    expect(new SqliteReader(image, wal).table("kv").map(r => r[0])).toEqual(["first", "second"]);
    db.close();
  });
});
