import { Plugin, Notice, Platform, requestUrl } from "obsidian";
import { parseSession, type Session } from "./credentials";
import { safeFolder } from "./paths";
import type { BooxSettings, Manifest } from "./types";
import { BooxClient, type HttpTransport } from "./client";
import { TabletSource, type TabletFiles } from "./tablet";
import { BooxSettingTab } from "./settings";
import { restorePreferences } from "./preferences";
import type { VaultIO } from "./ports";
import { planSync, executeSync, healMissingFiles } from "./sync";
import { parseState, serializeState, emptyState, STATE_FILENAME } from "./state";

// Secret-storage id for the BOOX session (OS keychain, never in data.json).
const SESSION_SECRET = "boox-cloud-sync-session";
const TABLET_ELSEWHERE = "The BOOX tablet syncs this vault's BOOX notes. Nothing to do on this device.";

export default class BooxSyncPlugin extends Plugin {
  settings!: BooxSettings;
  syncing = false;
  status = "Ready to connect.";
  private session: Session | null = null;
  private unloaded = false;
  // Each source has its own readiness. Local sources need no BOOX login; the
  // tablet source only runs on Android (Obsidian Sync copies its settings to
  // desktops, which must stay idle even with an old cloud session stored).
  get connected() {
    const s = this.settings;
    if (s.source === "tablet") return Platform.isAndroidApp;
    return !!this.session;
  }
  private intervalId: number | null = null;
  private lastRun = 0;
  private startupTimeout: number | null = null;

  // Uses Obsidian's requestUrl so requests bypass browser CORS in the Electron renderer.
  transport: HttpTransport = async (req) => {
    const r = await requestUrl({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      throw: false,
    });
    return { status: r.status, text: r.text, arrayBuffer: r.arrayBuffer };
  };

  async onload() {
    await this.loadSettings();
    const settingTab = new BooxSettingTab(this.app, this);
    this.addSettingTab(settingTab);
    this.register(() => settingTab.hide());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.runSync("manual") });
    this.status = this.settings.source === "tablet" ? (Platform.isAndroidApp ? "Ready to read notes from this tablet." : TABLET_ELSEWHERE)
      : this.connected ? "Connected. Ready to sync." : "Ready to connect.";
    this.rescheduleInterval();
    // Startup sync after a short delay so the vault is ready.
    this.startupTimeout = window.setTimeout(() => {
      this.startupTimeout = null;
      if (this.connected && this.settings.syncOnStartup) void this.runSync("startup");
    }, 4000);
    // Android keeps Obsidian alive in the background: returning to it after
    // writing in the BOOX apps should pick up the new ink without a restart.
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (activeDocument.visibilityState === "visible" && this.settings.source === "tablet" && Date.now() - this.lastRun > 60_000) void this.runSync("resume");
    });
  }

  onunload() {
    this.unloaded = true; this.session = null;
    if (this.startupTimeout !== null) window.clearTimeout(this.startupTimeout);
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async loadSettings() {
    const data: unknown = await this.loadData();
    const restored = restorePreferences(data, parseSession(this.app.secretStorage?.getSecret(SESSION_SECRET) ?? null));
    this.settings = restored.settings;
    // On the tablet itself, read its own BOOX files unless told otherwise.
    if (Platform.isAndroidApp && !(data && typeof data === "object" && "source" in data && data.source)) this.settings.source = "tablet";
    this.session = restored.session;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  rescheduleInterval() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const mins = this.settings.intervalMinutes;
    if (mins && mins > 0) {
      this.intervalId = window.setInterval(() => {
        if (this.connected) void this.runSync("interval");
      }, mins * 60_000);
      this.registerInterval(this.intervalId);
    }
  }

  private source(): { sources(): Promise<Manifest>; object(ref: string): Promise<ArrayBuffer> } {
    const progress = (message: string) => { this.status = message; };
    if (this.settings.source === "tablet") {
      if (!Platform.isAndroidApp) throw new Error("Reading notes from the tablet works only in Obsidian on the BOOX tablet.");
      return new TabletSource(capacitorFiles(), progress);
    }
    if (!this.session) throw new Error("Unlock your BOOX session first.");
    return new BooxClient(this.session.region, this.transport, this.session.token, progress);
  }
  async connectWith(session: Session) {
    if (this.syncing) throw new Error("Wait for the current sync to finish.");
    if (this.unloaded) return;
    if (!session.uid) session.uid = String((await new BooxClient(session.region, this.transport, session.token).me()).uid);
    this.app.secretStorage.setSecret(SESSION_SECRET, JSON.stringify(session));
    this.settings.region = session.region;
    this.settings.account = { uid: session.uid, email: session.email };
    await this.saveSettings();
    this.session = session; this.status = "Connected. Ready to sync.";
  }
  async disconnect() {
    if (this.syncing) throw new Error("Wait for the current sync to finish.");
    this.session = null;
    this.app.secretStorage.setSecret(SESSION_SECRET, "");
    this.settings.account = null;
    await this.saveSettings(); this.status = "Disconnected. Local files are kept.";
  }

  private io(root: string): VaultIO {
    const adapter = this.app.vault.adapter;
    const checked = (path: string) => {
      if (this.unloaded) throw new Error("Plugin unloaded; sync stopped.");
      if (path !== safeFolder(path, this.app.vault.configDir) || (path !== root && !path.startsWith(`${root}/`))) throw new Error("Sync path is outside the configured BOOX folder.");
      return path;
    };
    // Create a directory and any missing ancestors (adapter.mkdir is single-level).
    const ensureDir = async (dir: string) => {
      let accumulated = "";
      for (const part of dir.split("/")) {
        if (!part) continue;
        accumulated = accumulated ? `${accumulated}/${part}` : part;
        if (!(await adapter.exists(accumulated))) await adapter.mkdir(accumulated);
      }
    };
    const ensureParent = (path: string) => ensureDir(path.split("/").slice(0, -1).join("/"));
    return {
      exists: (p) => adapter.exists(checked(p)),
      read: (p) => adapter.read(checked(p)),
      readBinary: (p) => adapter.readBinary(checked(p)),
      write: async (p, c) => {
        checked(p);
        await ensureParent(p);
        await adapter.write(checked(p), c);
      },
      writeBinary: async (p, d) => {
        checked(p);
        await ensureParent(p);
        await adapter.writeBinary(checked(p), d);
      },
      remove: (p) => adapter.remove(checked(p)),
      mkdir: p => ensureDir(checked(p)),
      rmdir: (p) => adapter.rmdir(checked(p), false),
      mtime: async (p) => (await adapter.stat(checked(p)))?.mtime ?? null,
    };
  }

  async runSync(trigger: "startup" | "interval" | "manual" | "resume") {
    if (this.syncing) return; // mutex — no overlapping runs
    if (!this.connected) {
      if (trigger === "manual") new Notice(`BOOX: ${this.settings.source === "tablet" ? TABLET_ELSEWHERE : "connect first (Settings → BOOX Notes Sync)."}`);
      return;
    }
    this.syncing = true; this.status = "Starting sync…"; this.lastRun = Date.now();
    try {
      const settings = { ...this.settings, syncFolder: safeFolder(this.settings.syncFolder, this.app.vault.configDir) };
      const client = this.source();
      const manifest = await client.sources();
      const io = this.io(settings.syncFolder);
      const statePath = `${settings.syncFolder}/${STATE_FILENAME}`;
      const loaded = (await io.exists(statePath)) ? parseState(await io.read(statePath)) : emptyState();
      if (loaded.accountUid && loaded.accountUid !== manifest.account.uid) throw new Error("This sync folder belongs to another BOOX account. Choose a different sync folder.");
      // Re-arm items whose vault files vanished since we wrote them — the
      // cloud is the source of truth, so they re-download this run.
      const prev = await healMissingFiles(loaded, io);
      const syncedAt = new Date().toISOString();
      const actions = planSync(manifest, prev, settings, syncedAt, this.app.vault.configDir);
      // Untracked files this run replaces are first copied here (hidden, so
      // Obsidian Sync does not spread the copies to other devices).
      const backupRoot = `${settings.syncFolder}/.boox-sync-replaced/${syncedAt.replace(/[:.]/g, "-")}`;
      const { state, summary } = await executeSync(actions, prev, io, { object: async key => {
        if (this.unloaded) throw new Error("Plugin unloaded; sync stopped.");
        return client.object(key);
      } }, state => io.write(statePath, serializeState({ ...state, accountUid: manifest.account.uid || undefined })),
      path => `${backupRoot}/${path.slice(settings.syncFolder.length + 1)}`);
      state.lastSync = syncedAt;
      state.accountUid = manifest.account.uid || undefined;
      await io.write(statePath, serializeState(state));

      const parts = [`${summary.written} notes`, `${summary.downloaded} files`];
      if (summary.deleted) parts.push(`${summary.deleted} removed`);
      if (summary.skippedUserEdited.length) parts.push(`${summary.skippedUserEdited.length} kept (edited or unverified)`);
      if (summary.backedUp.length) parts.push(`${summary.backedUp.length} earlier exports replaced (originals in ${backupRoot})`);
      const docName = (path: string) => path.split("/").pop()!;
      const updated = summary.updated.length
        ? ` Updated: ${summary.updated.slice(0, 5).map(docName).join(", ")}${summary.updated.length > 5 ? ` and ${summary.updated.length - 5} more` : ""}.` : "";
      this.status = `Last sync: ${new Date().toLocaleString()} — ${parts.join(", ")}${summary.errors.length ? `; ${summary.errors.length} error(s)` : ""}.${updated}`;
      if (trigger === "manual" || summary.written || summary.downloaded || summary.deleted) {
        new Notice(`BOOX sync: ${parts.join(", ")}.${updated}`, summary.updated.length ? 10000 : undefined);
      }
      if (summary.errors.length) {
        console.error("BOOX sync errors", summary.errors);
        new Notice(`BOOX sync: ${summary.errors.length} error(s) — see console.`);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.status = `Sync failed: ${message}`;
      new Notice(`BOOX sync failed: ${message}`);
    } finally {
      this.syncing = false;
    }
  }
}

// Files on the tablet's shared storage, through Obsidian mobile's Capacitor
// bridge. Obsidian holds Android's "All files access", so it can read the
// hidden folder where the BOOX apps keep notes.
interface CapacitorBridge {
  convertFileSrc(fileUri: string): string;
  Plugins?: { Filesystem?: { readdir(options: { path: string }): Promise<{ files: { name: string; type: string; size: number; mtime: number }[] }> } };
}
function capacitorFiles(): TabletFiles {
  // Obsidian mobile's runtime global; absent on desktop. Its members are checked below.
  const cap = "Capacitor" in window ? window.Capacitor as CapacitorBridge : undefined;
  const fs = cap?.Plugins?.Filesystem;
  if (!cap || !fs || typeof cap.convertFileSrc !== "function") throw new Error("This Obsidian app cannot read files outside the vault.");
  return {
    async list(path) {
      try {
        const { files } = await fs.readdir({ path: `file://${path}` });
        return files.map(f => ({ name: f.name, type: f.type === "directory" ? "directory" : "file", size: Number(f.size) || 0, mtime: Number(f.mtime) || 0 }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/does not exist/i.test(message)) return [];
        throw new Error(`Cannot read ${path}: ${message}. Allow Obsidian "All files access" in Android settings.`);
      }
    },
    async read(path) {
      // Stroke file names contain '#'; encode each segment so it stays in the path.
      const response = await window.fetch(cap.convertFileSrc(`file://${path.split("/").map(encodeURIComponent).join("/")}`));
      if (!response.ok) throw new Error(`Cannot read ${path} (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
