import { Plugin, Notice, requestUrl } from "obsidian";
import { decryptSession, parseSession, type Session } from "./credentials";
import { ConnectModal } from "./connect-modal";
import { safeFolder } from "./paths";
import type { BooxSettings } from "./types";
import { BooxClient, type HttpTransport } from "./client";
import { BooxSettingTab } from "./settings";
import { restorePreferences } from "./preferences";
import type { VaultIO } from "./ports";
import { planSync, executeSync, healMissingFiles } from "./sync";
import { parseState, serializeState, emptyState, STATE_FILENAME } from "./state";

// Secret-storage id for the BOOX session (OS keychain, never in data.json).
const SESSION_SECRET = "boox-cloud-sync-session";

export default class BooxSyncPlugin extends Plugin {
  settings!: BooxSettings;
  syncing = false;
  status = "Ready to connect.";
  private session: Session | null = null;
  private unloaded = false;
  get connected() { return !!this.session; }
  private intervalId: number | null = null;
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
    this.status = this.connected ? "Connected. Ready to sync." : this.settings.encryptedSession ? "Enter your old passphrase once in BOOX settings to finish the upgrade." : "Ready to connect.";
    this.rescheduleInterval();
    // Startup sync after a short delay so the vault is ready.
    this.startupTimeout = window.setTimeout(() => {
      this.startupTimeout = null;
      if (this.connected && this.settings.syncOnStartup) this.runSync("startup");
    }, 4000);
  }

  onunload() {
    this.unloaded = true; this.session = null;
    if (this.startupTimeout !== null) window.clearTimeout(this.startupTimeout);
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async loadSettings() {
    const data = await this.loadData();
    const restored = restorePreferences(data, parseSession(this.app.secretStorage.getSecret(SESSION_SECRET)));
    this.settings = restored.settings;
    this.session = restored.session;
    // A plaintext token from an old version moves into secret storage.
    if (this.session && restored.removeLegacy) this.app.secretStorage.setSecret(SESSION_SECRET, JSON.stringify(this.session));
    if (restored.removeLegacy || (this.session && data?.encryptedSession)) await this.saveSettings();
    if (restored.removeLegacy && !this.session) new Notice("BOOX Sync now connects directly. Sign in again in plugin settings; your existing vault files are kept.");
    else if (this.settings.encryptedSession) new Notice("BOOX Sync no longer needs a passphrase. Enter your old one once in BOOX settings to finish the upgrade.", 10000);
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
        if (this.connected) this.runSync("interval");
      }, mins * 60_000);
      this.registerInterval(this.intervalId);
    }
  }

  private client(): BooxClient {
    if (!this.session) throw new Error("Unlock your BOOX session first.");
    return new BooxClient(this.session.region, this.transport, this.session.token, message => { this.status = message; });
  }
  async connectWith(session: Session) {
    if (this.syncing) throw new Error("Wait for the current sync to finish.");
    if (this.unloaded) return;
    if (!session.uid) session.uid = String((await new BooxClient(session.region, this.transport, session.token).me()).uid);
    this.app.secretStorage.setSecret(SESSION_SECRET, JSON.stringify(session));
    this.settings.encryptedSession = null;
    this.settings.region = session.region;
    this.settings.account = { uid: session.uid, email: session.email };
    await this.saveSettings();
    this.session = session; this.status = "Connected. Ready to sync.";
  }
  // One-time upgrade from the 0.3.x passphrase lock to secret storage.
  async unlockLegacy(passphrase: string) {
    if (!this.settings.encryptedSession) throw new Error("No saved session. Connect again.");
    const session = await decryptSession(this.settings.encryptedSession, passphrase);
    await this.connectWith(session);
  }
  async disconnect() {
    if (this.syncing) throw new Error("Wait for the current sync to finish.");
    this.session = null;
    this.app.secretStorage.setSecret(SESSION_SECRET, "");
    this.settings.encryptedSession = null; this.settings.account = null;
    await this.saveSettings(); this.status = "Disconnected. Local files are kept.";
  }

  private io(root: string): VaultIO {
    const adapter = this.app.vault.adapter;
    const checked = (path: string) => {
      if (this.unloaded) throw new Error("Plugin unloaded; sync stopped.");
      if (path !== safeFolder(path) || (path !== root && !path.startsWith(`${root}/`))) throw new Error("Sync path is outside the configured BOOX folder.");
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

  async runSync(trigger: "startup" | "interval" | "manual") {
    if (this.syncing) return; // mutex — no overlapping runs
    if (!this.connected) {
      if (trigger === "manual") new Notice("BOOX: connect first (Settings → BOOX Sync).");
      return;
    }
    this.syncing = true; this.status = "Starting sync…";
    try {
      const settings = { ...this.settings, syncFolder: safeFolder(this.settings.syncFolder) };
      const client = this.client();
      const manifest = await client.sources();
      const io = this.io(settings.syncFolder);
      const statePath = `${settings.syncFolder}/${STATE_FILENAME}`;
      const loaded = (await io.exists(statePath)) ? parseState(await io.read(statePath)) : emptyState();
      if (loaded.accountUid && loaded.accountUid !== manifest.account.uid) throw new Error("This sync folder belongs to another BOOX account. Choose a different sync folder.");
      // Re-arm items whose vault files vanished since we wrote them — the
      // cloud is the source of truth, so they re-download this run.
      const prev = await healMissingFiles(loaded, io);
      const syncedAt = new Date().toISOString();
      const actions = planSync(manifest, prev, settings, syncedAt);
      const { state, summary } = await executeSync(actions, prev, io, { object: async key => {
        if (this.unloaded) throw new Error("Plugin unloaded; sync stopped.");
        return client.object(key);
      } }, state => io.write(statePath, serializeState({ ...state, accountUid: manifest.account.uid || undefined })));
      state.lastSync = syncedAt;
      state.accountUid = manifest.account.uid || undefined;
      await io.write(statePath, serializeState(state));

      const parts = [`${summary.written} notes`, `${summary.downloaded} files`];
      if (summary.deleted) parts.push(`${summary.deleted} removed`);
      if (summary.adopted) parts.push(`${summary.adopted} confirmed unchanged`);
      if (summary.skippedUserEdited.length) parts.push(`${summary.skippedUserEdited.length} kept (edited or unverified)`);
      const docName = (path: string) => path.split("/").pop()!;
      const updated = summary.updated.length
        ? ` Updated: ${summary.updated.slice(0, 5).map(docName).join(", ")}${summary.updated.length > 5 ? ` and ${summary.updated.length - 5} more` : ""}.` : "";
      if (summary.updated.length) console.info("BOOX sync updated", summary.updated);
      this.status = `Last sync: ${new Date().toLocaleString()} — ${parts.join(", ")}${summary.errors.length ? `; ${summary.errors.length} error(s)` : ""}.${updated}`;
      if (trigger === "manual" || summary.written || summary.downloaded || summary.deleted) {
        new Notice(`BOOX sync: ${parts.join(", ")}.${updated}`, summary.updated.length ? 10000 : undefined);
      }
      if (summary.errors.length) {
        console.error("BOOX sync errors", summary.errors);
        new Notice(`BOOX sync: ${summary.errors.length} error(s) — see console.`);
      }
    } catch (e: any) {
      this.status = `Sync failed: ${e?.message || e}`;
      new Notice(`BOOX sync failed: ${e?.message || e}`);
    } finally {
      this.syncing = false;
    }
  }
}
