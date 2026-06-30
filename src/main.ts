import { Plugin, Notice, requestUrl } from "obsidian";
import type { BooxSettings } from "./types";
import { BooxClient, type HttpTransport } from "./client";
import { DEFAULT_SETTINGS, BooxSettingTab } from "./settings";
import type { VaultIO } from "./ports";
import { planSync, executeSync } from "./sync";
import { parseState, serializeState, emptyState, STATE_FILENAME } from "./state";

export default class BooxSyncPlugin extends Plugin {
  settings!: BooxSettings;
  private syncing = false;
  private intervalId: number | null = null;

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
    this.addSettingTab(new BooxSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.runSync("manual") });
    this.rescheduleInterval();
    // Startup sync after a short delay so the vault is ready.
    window.setTimeout(() => {
      if (this.settings.apiKey) this.runSync("startup");
    }, 4000);
  }

  onunload() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
        if (this.settings.apiKey) this.runSync("interval");
      }, mins * 60_000);
      this.registerInterval(this.intervalId);
    }
  }

  private client(): BooxClient {
    return new BooxClient(this.settings.backendUrl, this.transport, this.settings.apiKey);
  }

  async connectWith(apiKey: string, account: { uid: string | null; email: string }) {
    this.settings.apiKey = apiKey;
    this.settings.account = account;
    await this.saveSettings();
  }

  async disconnect() {
    try {
      await this.client().revoke();
    } catch {
      /* best-effort: revoke server-side, but always clear locally */
    }
    this.settings.apiKey = "";
    this.settings.account = null;
    await this.saveSettings();
  }

  private io(): VaultIO {
    const adapter = this.app.vault.adapter;
    const ensureParent = async (path: string) => {
      const i = path.lastIndexOf("/");
      if (i > 0) {
        const dir = path.slice(0, i);
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      }
    };
    return {
      exists: (p) => adapter.exists(p),
      read: (p) => adapter.read(p),
      write: async (p, c) => {
        await ensureParent(p);
        await adapter.write(p, c);
      },
      writeBinary: async (p, d) => {
        await ensureParent(p);
        await adapter.writeBinary(p, d);
      },
      remove: (p) => adapter.remove(p),
    };
  }

  async runSync(trigger: "startup" | "interval" | "manual") {
    if (this.syncing) return; // mutex — no overlapping runs
    if (!this.settings.apiKey) {
      if (trigger === "manual") new Notice("BOOX: connect first (Settings → BOOX Sync).");
      return;
    }
    this.syncing = true;
    try {
      const client = this.client();
      const manifest = await client.sources();
      const io = this.io();
      const statePath = `${this.settings.syncFolder}/${STATE_FILENAME}`;
      const prev = (await io.exists(statePath)) ? parseState(await io.read(statePath)) : emptyState();
      const syncedAt = new Date().toISOString();
      const actions = planSync(manifest, prev, this.settings, syncedAt);
      const { state, summary } = await executeSync(actions, prev, io, client);
      state.lastSync = syncedAt;
      await io.write(statePath, serializeState(state));

      const parts = [`${summary.written} notes`, `${summary.downloaded} files`];
      if (summary.deleted) parts.push(`${summary.deleted} removed`);
      if (summary.skippedUserEdited.length) parts.push(`${summary.skippedUserEdited.length} kept (edited)`);
      if (trigger === "manual" || summary.written || summary.downloaded || summary.deleted) {
        new Notice(`BOOX sync: ${parts.join(", ")}.`);
      }
      if (summary.errors.length) {
        console.error("BOOX sync errors", summary.errors);
        new Notice(`BOOX sync: ${summary.errors.length} error(s) — see console.`);
      }
    } catch (e: any) {
      console.error("BOOX sync failed", e);
      new Notice(`BOOX sync failed: ${e?.message || e}`);
    } finally {
      this.syncing = false;
    }
  }
}
