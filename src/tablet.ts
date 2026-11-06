import type { Manifest } from "./types";
import { assembleSources, type CloudObject, type Snapshot } from "./manifest";
import { readCblDocs } from "./cblite";
import { renderHandwritingRef } from "./handwriting";

// Where BOOX's sync service keeps every notebook and memo on the device:
// note databases under couch/, stroke files under document/ and point/.
export const TABLET_ROOT = "/storage/emulated/0/.ksync";

export interface TabletEntry { name: string; type: "file" | "directory"; size: number; mtime: number }
export interface TabletFiles {
  // Entries of a directory; an empty list when it does not exist.
  list(path: string): Promise<TabletEntry[]>;
  read(path: string): Promise<Uint8Array>;
}

const CHANNELS = { notes: "NOTE_TREE", library: "READER_LIBRARY", calendar: "CALENDAR_TREE" } as const;

// This device has no readable BOOX note store: an Android phone sharing the
// vault, or a tablet without "All files access". Background syncs stay quiet.
export class TabletUnavailableError extends Error {}

// Reads notebooks, memos and highlights from the BOOX apps' own files — the
// same data the BOOX cloud mirrors, including what never uploaded.
export class TabletSource {
  private manifest: Manifest | null = null;
  private objects = new Map<string, CloudObject[]>();
  private paths = new Map<string, string>();

  private root = TABLET_ROOT;

  constructor(private files: TabletFiles, private progress: (message: string) => void = () => {}) {}

  async sources(): Promise<Manifest> {
    this.progress("Reading BOOX note databases…");
    let couch: TabletEntry[];
    try { couch = await this.files.list(`${this.root}/couch`); }
    catch (e) { throw new TabletUnavailableError(e instanceof Error ? e.message : String(e)); }
    const candidates = couch
      .map(e => /^(.+)-NOTE_TREE\.cblite2$/.exec(e.name)?.[1]).filter((u): u is string => !!u && u !== "share_user");
    // Every account ever signed in keeps its databases. The one in use is the
    // one whose notes or memos were edited last.
    let uid = "", docs: Snapshot | null = null, newest = -1;
    for (const candidate of candidates) {
      const snapshot: Snapshot = { notes: [], library: [], messages: [], calendar: [] };
      for (const kind of ["notes", "calendar"] as const) snapshot[kind] = await this.channel(candidate, kind);
      const latest = Math.max(-1, ...[...snapshot.notes, ...snapshot.calendar].map(d => Number(d.updatedAt) || 0));
      if (latest > newest) { uid = candidate; docs = snapshot; newest = latest; }
    }
    if (!docs) throw new TabletUnavailableError(`No BOOX note databases found in ${this.root}/couch. On a BOOX tablet, open the Notes app once.`);
    docs.library = await this.channel(uid, "library");
    const items = [
      ...docs.notes.filter(d => d.uniqueId && d.status !== 0).map(d => ({ id: String(d.uniqueId), kind: "note" })),
      ...docs.calendar.filter(d => d.uniqueId && d.associateDate).map(d => ({ id: String(d.uniqueId), kind: "calendar" })),
    ];
    this.objects.clear(); this.paths.clear();
    const all: CloudObject[] = [];
    let listed = 0;
    await pool(items, 8, async ({ id, kind }) => {
      const objects = await this.listItem(uid, kind, id);
      this.progress(`Listing handwriting files (${++listed}/${items.length})…`);
      if (!objects.length) return;
      this.objects.set(`${kind}/${id}`, objects);
      all.push(...objects);
    });
    this.manifest = assembleSources(uid, docs, all);
    return this.manifest;
  }

  async object(ref: string): Promise<ArrayBuffer> {
    if (!this.manifest) throw new Error("Read the tablet before rendering.");
    const rendered = await renderHandwritingRef(ref, this.manifest, (kind, id) => this.objects.get(`${kind}/${id}`) ?? [], async key => {
      const path = this.paths.get(key);
      if (!path) throw new Error("BOOX page file is missing. Sync again in a moment.");
      const bytes = await this.files.read(path);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }, this.progress);
    if (!rendered) throw new Error("Attachments are only available from the BOOX cloud.");
    return rendered;
  }

  private async channel(uid: string, kind: keyof typeof CHANNELS) {
    return (await this.database(`${uid}-${CHANNELS[kind]}`)).map(d => ({ _id: d.id, ...d.body }));
  }

  // Couchbase Lite writes the WAL continuously and checkpoints it into the
  // database file. Read the WAL on both sides of the database read; a changed
  // WAL header means a checkpoint happened in between, so read again.
  private async database(name: string) {
    const dir = `${this.root}/couch/${name}.cblite2`;
    const names = new Set((await this.files.list(dir)).map(e => e.name));
    if (!names.has("db.sqlite3")) return [];
    const readWal = () => names.has("db.sqlite3-wal") ? this.files.read(`${dir}/db.sqlite3-wal`) : Promise.resolve(undefined);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await readWal();
      const db = await this.files.read(`${dir}/db.sqlite3`);
      const after = await readWal();
      if (sameWalHeader(before, after)) return readCblDocs(db, after);
    }
    throw new Error("BOOX was saving notes during the sync. Sync again in a moment.");
  }

  // Map the tablet's layout onto the cloud key layout the renderer reads:
  // document/<id>/<sub>/<file> → <uid>/<kind>/<id>/<sub>/<file>,
  // point/<id>/<layer>/<file> → <uid>/<kind>/<id>/point/<file>.
  private async listItem(uid: string, kind: string, id: string): Promise<CloudObject[]> {
    const out: CloudObject[] = [];
    const add = (sub: string, dir: string, entries: TabletEntry[]) => {
      for (const e of entries) {
        if (e.type !== "file") continue;
        const key = `${uid}/${kind}/${id}/${sub}/${e.name}`;
        this.paths.set(key, `${dir}/${e.name}`);
        out.push({ key, size: e.size, etag: `${e.size}-${e.mtime}`, modified: new Date(e.mtime).toISOString() });
      }
    };
    for (const sub of ["shape", "pageModel/pb", "virtual/page/pb"]) {
      const dir = `${this.root}/document/${id}/${sub}`;
      add(sub, dir, await this.files.list(dir));
    }
    for (const layer of await this.files.list(`${this.root}/point/${id}`)) {
      if (layer.type !== "directory") continue;
      const dir = `${this.root}/point/${id}/${layer.name}`;
      add("point", dir, await this.files.list(dir));
    }
    return out;
  }
}

function sameWalHeader(a?: Uint8Array, b?: Uint8Array): boolean {
  if (!a || !b) return a === b;
  if (a.length > b.length) return false; // the WAL was reset by a checkpoint
  for (let i = 0; i < Math.min(32, a.length); i++) if (a[i] !== b[i]) return false;
  return true;
}

async function pool<T>(items: T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  }));
}
