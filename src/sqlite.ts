// Minimal read-only SQLite reader: walks rowid-table B-trees in a database
// image, after replaying committed frames from its write-ahead log. Enough to
// read Couchbase Lite's tables without bundling a SQLite engine.
// Format: https://www.sqlite.org/fileformat2.html
export type SqlValue = null | number | bigint | string | Uint8Array;

export class SqliteError extends Error {}

const HEADER = "SQLite format 3\0";
const utf8 = new TextDecoder();

// Committed WAL frames by page number, and the database size they commit.
function replayWal(wal: Uint8Array | undefined, pageSize: number): { pages: Map<number, Uint8Array>; size: number | null } {
  const pages = new Map<number, Uint8Array>();
  if (!wal || wal.length < 32) return { pages, size: null };
  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = view.getUint32(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return { pages, size: null };
  const bigEndian = magic === 0x377f0683;
  if (view.getUint32(8) !== pageSize) throw new SqliteError("WAL page size does not match the database.");
  let s0 = 0, s1 = 0;
  const checksum = (start: number, end: number) => {
    for (let i = start; i < end; i += 8) {
      s0 = (s0 + view.getUint32(i, !bigEndian) + s1) >>> 0;
      s1 = (s1 + view.getUint32(i + 4, !bigEndian) + s0) >>> 0;
    }
  };
  checksum(0, 24);
  if (s0 !== view.getUint32(24) || s1 !== view.getUint32(28)) return { pages, size: null };
  const salt1 = view.getUint32(16), salt2 = view.getUint32(20);
  const pending = new Map<number, Uint8Array>();
  let size: number | null = null;
  for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
    if (view.getUint32(off + 8) !== salt1 || view.getUint32(off + 12) !== salt2) break;
    checksum(off, off + 8); checksum(off + 24, off + 24 + pageSize);
    if (s0 !== view.getUint32(off + 16) || s1 !== view.getUint32(off + 20)) break;
    pending.set(view.getUint32(off), wal.subarray(off + 24, off + 24 + pageSize));
    const commitSize = view.getUint32(off + 4);
    if (commitSize) {
      for (const [page, data] of pending) pages.set(page, data);
      pending.clear(); size = commitSize;
    }
  }
  return { pages, size };
}

export class SqliteReader {
  private pageSize: number;
  private usable: number;
  private pageCount: number;
  private wal: Map<number, Uint8Array>;

  constructor(private db: Uint8Array, wal?: Uint8Array) {
    if (db.length < 100 || utf8.decode(db.subarray(0, 16)) !== HEADER) throw new SqliteError("Not a SQLite database.");
    const raw = new DataView(db.buffer, db.byteOffset, db.byteLength).getUint16(16);
    this.pageSize = raw === 1 ? 65536 : raw;
    const replay = replayWal(wal, this.pageSize);
    this.wal = replay.pages;
    this.pageCount = replay.size ?? Math.floor(db.length / this.pageSize);
    // A freshly created database keeps its whole schema in the WAL; read the
    // header fields from the current page 1, not the stale file image.
    const header = this.page(1);
    this.usable = this.pageSize - header[20];
    const encoding = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(56);
    if (encoding !== 0 && encoding !== 1) throw new SqliteError("Only UTF-8 SQLite databases are supported.");
  }

  private page(n: number): Uint8Array {
    if (n < 1 || n > this.pageCount) throw new SqliteError(`SQLite page ${n} is out of range.`);
    const fromWal = this.wal.get(n);
    if (fromWal) return fromWal;
    const start = (n - 1) * this.pageSize;
    if (start + this.pageSize > this.db.length) throw new SqliteError(`SQLite page ${n} is missing.`);
    return this.db.subarray(start, start + this.pageSize);
  }

  // Rows of a rowid table, in rowid order; each row is its column values.
  *rows(rootPage: number): Generator<SqlValue[]> {
    const stack = [rootPage];
    const seen = new Set<number>();
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) throw new SqliteError("SQLite B-tree contains a cycle.");
      seen.add(n);
      const page = this.page(n);
      const base = n === 1 ? 100 : 0;
      const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
      const type = page[base], cells = view.getUint16(base + 3);
      if (type === 0x05) {
        const children: number[] = [];
        for (let i = 0; i < cells; i++) children.push(view.getUint32(view.getUint16(base + 12 + 2 * i)));
        children.push(view.getUint32(base + 8));
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      } else if (type === 0x0d) {
        for (let i = 0; i < cells; i++) yield this.record(this.leafPayload(page, view.getUint16(base + 8 + 2 * i)));
      } else throw new SqliteError(`Unexpected SQLite page type ${type}.`);
    }
  }

  // Root page of each table, from the schema table on page 1.
  tables(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [type, name, , root] of this.rows(1)) if (type === "table" && typeof name === "string" && typeof root === "number") out.set(name, root);
    return out;
  }

  table(name: string): SqlValue[][] {
    const root = this.tables().get(name);
    if (root === undefined) throw new SqliteError(`SQLite table ${name} not found.`);
    return [...this.rows(root)];
  }

  private leafPayload(page: Uint8Array, cell: number): Uint8Array {
    let [size, pos] = varint(page, cell);
    [, pos] = varint(page, pos); // rowid
    const x = this.usable - 35;
    if (size <= x) return page.subarray(pos, pos + size);
    const m = Math.floor((this.usable - 12) * 32 / 255) - 23;
    const k = m + ((size - m) % (this.usable - 4));
    const local = k <= x ? k : m;
    const out = new Uint8Array(size);
    out.set(page.subarray(pos, pos + local));
    let filled = local;
    let next = new DataView(page.buffer, page.byteOffset).getUint32(pos + local);
    const seen = new Set<number>();
    while (filled < size) {
      if (!next || seen.has(next)) throw new SqliteError("Broken SQLite overflow chain.");
      seen.add(next);
      const overflow = this.page(next);
      const chunk = Math.min(size - filled, this.usable - 4);
      out.set(overflow.subarray(4, 4 + chunk), filled);
      filled += chunk;
      next = new DataView(overflow.buffer, overflow.byteOffset).getUint32(0);
    }
    return out;
  }

  private record(payload: Uint8Array): SqlValue[] {
    const [headerSize, start] = varint(payload, 0);
    const types: number[] = [];
    for (let pos = start; pos < headerSize;) { let t; [t, pos] = varint(payload, pos); types.push(t); }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let pos = headerSize;
    return types.map(t => {
      if (t === 0) return null;
      if (t === 8) return 0;
      if (t === 9) return 1;
      if (t === 7) { const v = view.getFloat64(pos); pos += 8; return v; }
      if (t >= 1 && t <= 6) {
        const size = [0, 1, 2, 3, 4, 6, 8][t];
        let v = 0n;
        for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(payload[pos + i]);
        if (v & (1n << BigInt(size * 8 - 1))) v -= 1n << BigInt(size * 8);
        pos += size;
        return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      if (t >= 12) {
        const size = (t - (t % 2 ? 13 : 12)) / 2;
        const bytes = payload.subarray(pos, pos + size); pos += size;
        return t % 2 ? utf8.decode(bytes) : bytes.slice();
      }
      throw new SqliteError(`Unsupported SQLite serial type ${t}.`);
    });
  }
}

function varint(b: Uint8Array, pos: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 9; i++) {
    const byte = b[pos++];
    if (byte === undefined) throw new SqliteError("Truncated SQLite varint.");
    if (i === 8) return [v * 256 + byte, pos];
    v = v * 128 + (byte & 0x7f);
    if (byte < 0x80) return [v, pos];
  }
  return [v, pos];
}
