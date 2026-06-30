import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type BooxSyncPlugin from "./main";
import type { BooxSettings } from "./types";
import { ConnectModal } from "./connect-modal";

export const DEFAULT_SETTINGS: BooxSettings = {
  backendUrl: "http://localhost:8000",
  apiKey: "",
  account: null,
  syncFolder: "BOOX",
  intervalMinutes: 30,
  syncHighlights: true,
  syncNotebooks: true,
  syncMemos: true,
  syncFiles: true,
  deleteRemoved: false,
};

export class BooxSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BooxSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Backend URL")
      .setDesc("Your deployed BOOX backend (e.g. https://boox.example.com).")
      .addText((t) =>
        t.setPlaceholder("https://boox.example.com").setValue(s.backendUrl).onChange(async (v) => {
          s.backendUrl = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    const status = s.account ? `Connected as ${s.account.email ?? s.account.uid ?? "?"}` : "Not connected";
    new Setting(containerEl)
      .setName("Account")
      .setDesc(status)
      .addButton((b) =>
        b.setButtonText(s.apiKey ? "Reconnect" : "Connect").onClick(() => {
          new ConnectModal(this.app, this.plugin, () => this.display()).open();
        }),
      )
      .addButton((b) => {
        if (!s.apiKey) return;
        b.setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            await this.plugin.disconnect();
            new Notice("Disconnected from BOOX.");
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Sync folder")
      .setDesc("Vault folder to mirror BOOX into.")
      .addText((t) =>
        t.setValue(s.syncFolder).onChange(async (v) => {
          s.syncFolder = v.trim() || "BOOX";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to sync in the background. 0 disables periodic sync.")
      .addText((t) =>
        t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
          const n = Number(v);
          s.intervalMinutes = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
          await this.plugin.saveSettings();
          this.plugin.rescheduleInterval();
        }),
      );

    const toggles: [keyof BooxSettings, string][] = [
      ["syncHighlights", "highlights"],
      ["syncNotebooks", "notebooks"],
      ["syncMemos", "memos"],
      ["syncFiles", "files"],
    ];
    for (const [key, label] of toggles) {
      new Setting(containerEl).setName(`Sync ${label}`).addToggle((tg) =>
        tg.setValue(Boolean(s[key])).onChange(async (v) => {
          (s as any)[key] = v;
          await this.plugin.saveSettings();
        }),
      );
    }

    new Setting(containerEl)
      .setName("Delete vault notes removed from BOOX")
      .setDesc("Off by default — your vault keeps notes even if you delete them on the device.")
      .addToggle((tg) =>
        tg.setValue(s.deleteRemoved).onChange(async (v) => {
          s.deleteRemoved = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Sync now").setCta().onClick(() => this.plugin.runSync("manual")),
    );
  }
}
