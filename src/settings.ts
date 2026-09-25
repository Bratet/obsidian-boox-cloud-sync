import { App, PluginSettingTab, Setting, Notice, type ButtonComponent } from "obsidian";
import type BooxSyncPlugin from "./main";
import type { BooxSettings } from "./types";
import { ConnectModal } from "./connect-modal";
import { safeFolder, nameFromTemplate, formatDate } from "./paths";

import { DEFAULT_SETTINGS } from "./preferences";
export { DEFAULT_SETTINGS } from "./preferences";
export class BooxSettingTab extends PluginSettingTab {
  private statusTimer: number | null = null;
  constructor(app: App, private plugin: BooxSyncPlugin) { super(app, plugin); }
  hide(): void { if (this.statusTimer !== null) window.clearInterval(this.statusTimer); this.statusTimer = null; }
  display(): void {
    this.hide();
    const el = this.containerEl; el.empty(); const s = this.plugin.settings;
    const heading = (text: string) => new Setting(el).setName(text).setHeading();
    heading("BOOX account");
    const status = this.plugin.connected ? `Connected as ${s.account?.email || s.account?.uid}` : s.encryptedSession ? "Upgrade pending: enter your old passphrase once. No more unlocking after that." : "Not connected";
    const account = new Setting(el).setName("Connection").setDesc(status);
    if (s.encryptedSession && !this.plugin.connected) account.addButton(b => b.setButtonText("Finish upgrade").setCta().onClick(() => new ConnectModal(this.app, this.plugin, () => this.display(), true).open()));
    account.addButton(b => b.setButtonText(s.account ? "Connect again" : "Connect").setDisabled(this.plugin.syncing).onClick(() => new ConnectModal(this.app, this.plugin, () => this.display()).open()));
    if (this.plugin.connected || s.encryptedSession) account.addButton(b => b.setButtonText("Disconnect").setDisabled(this.plugin.syncing).onClick(async () => { await this.plugin.disconnect(); this.display(); }));
    let syncButton: ButtonComponent;
    const syncStatus = new Setting(el).setName("Sync status").setDesc(this.plugin.status)
      .addButton(b => { syncButton = b; b.setButtonText(this.plugin.syncing ? "Syncing…" : "Sync now").setDisabled(!this.plugin.connected || this.plugin.syncing).setCta().onClick(async () => {
        const run = this.plugin.runSync("manual"); this.display(); await run; this.display();
      }); });
    this.statusTimer = window.setInterval(() => {
      syncStatus.setDesc(this.plugin.status);
      syncButton.setButtonText(this.plugin.syncing ? "Syncing…" : "Sync now").setDisabled(!this.plugin.connected || this.plugin.syncing);
    }, 500);
    heading("Sync");
    const text = (key: keyof BooxSettings, title: string, desc: string, validate?: (v: string) => string) => {
      new Setting(el).setName(title).setDesc(desc).addText(t => {
        t.setValue(String(s[key] ?? ""));
        t.inputEl.addEventListener("change", async () => {
          if (this.plugin.syncing) { new Notice("Wait for the current sync before changing settings."); t.setValue(String(s[key] ?? "")); return; }
          try { const value = validate ? validate(t.getValue().trim()) : t.getValue().trim(); (s as any)[key] = value; await this.plugin.saveSettings(); }
          catch (e: any) { new Notice(e.message); t.setValue(String(s[key] ?? "")); }
        });
      });
    };
    const toggle = (key: keyof BooxSettings, title: string, desc = "") => new Setting(el).setName(title).setDesc(desc).addToggle(t => t.setValue(Boolean(s[key])).setDisabled(this.plugin.syncing).onChange(async v => { (s as any)[key] = v; await this.plugin.saveSettings(); }));
    text("syncFolder", "Sync folder", "Vault folder for BOOX content. Changing it starts a separate mirror; existing files stay in the old folder.", v => {
      const path = safeFolder(v); if (!path) throw new Error("Choose a non-empty sync folder."); return path;
    });
    new Setting(el).setName("Sync interval (minutes)").setDesc("0 disables scheduled sync. Obsidian must be open. Unchanged notebooks and memos are skipped, so a sync with nothing new is quick.").addText(t => {
      t.setValue(String(s.intervalMinutes)); t.inputEl.type = "number"; t.inputEl.min = "0";
      t.inputEl.addEventListener("change", async () => { const n = Number(t.getValue());
        if (!Number.isInteger(n) || n < 0 || n > 1440) { new Notice("Enter a whole number from 0 to 1440."); return; }
        s.intervalMinutes = n; await this.plugin.saveSettings(); this.plugin.rescheduleInterval();
      });
    });
    toggle("syncOnStartup", "Sync on startup", "Start syncing a few seconds after Obsidian opens.");
    for (const [key, title] of [["syncHighlights", "Book highlights"], ["syncNotebooks", "Notebooks"], ["syncMemos", "Calendar memos"], ["syncFiles", "Attachments"]] as const) toggle(key, title);
    toggle("deleteRemoved", "Remove files deleted from BOOX", "Only unchanged files previously written by this plugin are removed. Off by default.");
    heading("Folders and file names");
    el.createEl("p", { text: "File extensions are added automatically. New naming settings take effect on the next sync; edited files are kept." });
    for (const [key, title] of [["highlightsFolder", "Highlights folder"], ["notebooksFolder", "Notebooks folder"], ["memosFolder", "Memos folder"], ["filesFolder", "Attachments folder"]] as const)
      text(key, title, "Relative to the sync folder; nested folders are supported.", v => { const p = safeFolder(v); if (!p) throw new Error("Enter a folder name."); return p; });
    toggle("preserveFolders", "Keep device folder hierarchy", "Place notebooks inside their BOOX folders, including empty folders.");
    const naming = (key: keyof BooxSettings, title: string, desc: string, values: Record<string, string | number>) => text(key, title, `${desc} Example: ${nameFromTemplate(String(s[key]), values)}`, v => {
      if (!v) throw new Error("Enter a naming template."); nameFromTemplate(v, values);
      if (key === "pageName" && !v.includes("{page}")) throw new Error("Page names must include {page}."); return v;
    });
    naming("notebookName", "Notebook name", "Use {title}, {id}, {date} (last update).", { title: "Meeting notes", id: "notebook-id", date: "20260920" });
    naming("highlightName", "Highlights note name", "Use {title}, {id}.", { title: "My book", id: "book-id" });
    naming("memoName", "Memo name", "Use {date}, {id}, {title}.", { date: formatDate("2026-09-20", s.dateFormat), id: "memo-id", title: "Memo" });
    naming("attachmentName", "Attachment name", "Use {title} (without extension), {id}, {ext}.", { title: "Reading", id: "file-id", ext: "pdf" });
    naming("pageName", "PNG page name", "For multi-page exports: {title}, {id}, {page}. Include {page} to keep names unique.", { title: "Meeting notes", id: "notebook-id", page: 2 });
    text("dateFormat", "Date format", "Use YYYY, MM and DD, for example YYYY-MM-DD or YYYYMMDD.", v => {
      if (!v.includes("YYYY") || !v.includes("MM") || !v.includes("DD") || /[\\/]/.test(v)) throw new Error("Include YYYY, MM and DD without slashes."); return v;
    });
    heading("Export");
    new Setting(el).setName("Handwriting format").setDesc("PDF binds each notebook or memo in device page order. PNG exports individual pages.")
      .addDropdown(d => d.addOption("pdf", "PDF document").addOption("png", "PNG pages").setValue(s.exportFormat || "pdf").setDisabled(this.plugin.syncing)
        .onChange(async v => { s.exportFormat = v as "pdf" | "png"; await this.plugin.saveSettings(); }));
    new Setting(el).setName("Highlight block template").setDesc("Leave empty for quote callouts. Use {quote}, {note}, {chapter}, {page}, {id}; one block per highlight.")
      .addTextArea(t => { t.setValue(s.highlightTemplate || ""); t.inputEl.rows = 5; t.inputEl.addEventListener("change", async () => { s.highlightTemplate = t.getValue(); await this.plugin.saveSettings(); }); });
  }
}
