import { App, PluginSettingTab, Notice, Platform, type ButtonComponent, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type BooxSyncPlugin from "./main";
import type { BooxSettings } from "./types";
import { ConnectModal } from "./connect-modal";
import { safeFolder, nameFromTemplate, formatDate } from "./paths";

export { DEFAULT_SETTINGS } from "./preferences";
type TextSetting = "syncFolder" | "highlightsFolder" | "notebooksFolder" | "memosFolder" | "filesFolder" | "notebookName" | "highlightName" | "memoName" | "attachmentName" | "pageName" | "dateFormat";
type ToggleSetting = { [K in keyof BooxSettings]-?: NonNullable<BooxSettings[K]> extends boolean ? K : never }[keyof BooxSettings];
const FOLDERS: Record<string, true> = { syncFolder: true, highlightsFolder: true, notebooksFolder: true, memosFolder: true, filesFolder: true };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
// Adapts a throwing validator to the framework's inline-error contract.
const check = (validate: (v: string) => unknown) => (v: string) => { try { validate(v.trim()); } catch (e: unknown) { return message(e); } };

export class BooxSettingTab extends PluginSettingTab {
  private statusTimer: number | null = null;
  constructor(app: App, private plugin: BooxSyncPlugin) { super(app, plugin); }

  hide(): void { this.stopStatus(); super.hide(); }
  private stopStatus() { if (this.statusTimer !== null) window.clearInterval(this.statusTimer); this.statusTimer = null; }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    s[key] = key === "source" ? (value === "tablet" ? "tablet" : "cloud")
      : FOLDERS[key] ? safeFolder(String(value).trim(), this.app.vault.configDir)
      : typeof value === "string" && key !== "highlightTemplate" ? value.trim() : value;
    try { await this.plugin.saveSettings(); } catch (e: unknown) { new Notice(message(e)); }
    if (key === "intervalMinutes") this.plugin.rescheduleInterval();
    // The connection rows and the source options depend on the source.
    if (key === "source") this.update();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings, syncing = () => this.plugin.syncing;
    const sourceOptions: Record<string, string> = {};
    if (Platform.isAndroidApp) sourceOptions.tablet = "This tablet";
    else if (s.source === "tablet") sourceOptions.tablet = "The BOOX tablet (via vault sync)";
    sourceOptions.cloud = "BOOX cloud";
    const connectButtons: ButtonComponent[] = [];
    const text = (key: TextSetting, name: string, desc: string, validate?: (v: string) => unknown): SettingGroupItem =>
      ({ name, desc, control: { type: "text", key, disabled: syncing, validate: validate && check(validate) } });
    const folder = (key: TextSetting, name: string): SettingGroupItem =>
      text(key, name, "Relative to the sync folder; nested folders are supported.", v => { if (!safeFolder(v, this.app.vault.configDir)) throw new Error("Enter a folder name."); });
    const toggle = (key: ToggleSetting, name: string, desc?: string): SettingGroupItem => ({ name, desc, control: { type: "toggle", key, disabled: syncing } });
    const naming = (key: TextSetting, name: string, desc: string, values: Record<string, string | number>) => text(key, name, `${desc} Example: ${nameFromTemplate(String(s[key]), values)}`, v => {
      if (!v) throw new Error("Enter a naming template."); nameFromTemplate(v, values);
      if (key === "pageName" && !v.includes("{page}")) throw new Error("Page names must include {page}.");
    });
    return [
      { type: "group", heading: "BOOX source", items: [
        { name: "Read notes from",
          desc: Platform.isAndroidApp
            ? "This tablet reads the BOOX apps' own files, including notes the BOOX cloud never received. No login needed."
            : "The BOOX tablet reads its own BOOX files, including notes the BOOX cloud never received, and vault sync brings them here. No login needed.",
          control: { type: "dropdown", key: "source", options: sourceOptions, defaultValue: "cloud", disabled: syncing } },
        { name: "Connection", visible: () => s.source === "cloud", render: setting => {
          setting.setDesc(this.plugin.connected ? `Connected as ${s.account?.email || s.account?.uid}` : "Not connected");
          setting.addButton(b => { connectButtons.push(b); b.setButtonText(s.account ? "Connect again" : "Connect").setDisabled(syncing()).onClick(() => new ConnectModal(this.app, this.plugin, () => this.update()).open()); });
          if (this.plugin.connected) setting.addButton(b => { connectButtons.push(b); b.setButtonText("Disconnect").setDisabled(syncing()).onClick(async () => {
            try { await this.plugin.disconnect(); } catch (e: unknown) { new Notice(message(e)); }
            this.update();
          }); });
        } },
        { name: "Sync status", searchable: false, render: setting => {
          let button!: ButtonComponent, wasSyncing = syncing();
          const refresh = () => {
            setting.setDesc(this.plugin.status);
            button.setButtonText(syncing() ? "Syncing…" : "Sync now").setDisabled(!this.plugin.connected || syncing());
            for (const b of connectButtons) b.setDisabled(syncing());
            if (wasSyncing !== syncing()) { wasSyncing = syncing(); this.refreshDomState(); }
          };
          setting.addButton(b => { button = b; b.setCta().onClick(async () => {
            const run = this.plugin.runSync("manual"); refresh(); await run; this.update();
          }); });
          refresh();
          this.stopStatus(); this.statusTimer = window.setInterval(refresh, 500);
          return () => this.stopStatus();
        } },
      ] },
      { type: "group", heading: "Sync", items: [
        { name: "Sync folder", desc: "Vault folder for BOOX content. Changing it starts a separate mirror; existing files stay in the old folder.",
          control: { type: "folder", key: "syncFolder", disabled: syncing, validate: check(v => { if (!safeFolder(v, this.app.vault.configDir)) throw new Error("Choose a non-empty sync folder."); }) } },
        { name: "Sync interval (minutes)", desc: "0 disables scheduled sync. Obsidian must be open. Unchanged notebooks and memos are skipped, so a sync with nothing new is quick.",
          control: { type: "number", key: "intervalMinutes", min: 0, max: 1440, step: 1, disabled: syncing, validate: v => Number.isInteger(v) ? undefined : "Enter a whole number from 0 to 1440." } },
        toggle("syncOnStartup", "Sync on startup", "Start syncing a few seconds after Obsidian opens."),
        toggle("syncHighlights", "Book highlights"),
        toggle("syncNotebooks", "Notebooks"),
        toggle("syncMemos", "Calendar memos"),
        toggle("syncFiles", "Attachments"),
        toggle("deleteRemoved", "Remove files deleted from BOOX", "Only unchanged files previously written by this plugin are removed. Off by default."),
      ] },
      { type: "group", heading: "Folders and file names", items: [
        { name: "Naming rules", desc: "File extensions are added automatically. New naming settings take effect on the next sync; edited files are kept.", searchable: false },
        folder("highlightsFolder", "Highlights folder"),
        folder("notebooksFolder", "Notebooks folder"),
        folder("memosFolder", "Memos folder"),
        folder("filesFolder", "Attachments folder"),
        toggle("preserveFolders", "Keep device folder hierarchy", "Place notebooks inside their BOOX folders, including empty folders."),
        naming("notebookName", "Notebook name", "Use {title}, {id}, {date} (last update).", { title: "Meeting notes", id: "notebook-id", date: "20260920" }),
        naming("highlightName", "Highlights note name", "Use {title}, {id}.", { title: "My book", id: "book-id" }),
        naming("memoName", "Memo name", "Use {date}, {id}, {title}.", { date: formatDate("2026-09-20", s.dateFormat), id: "memo-id", title: "Memo" }),
        naming("attachmentName", "Attachment name", "Use {title} (without extension), {id}, {ext}.", { title: "Reading", id: "file-id", ext: "pdf" }),
        naming("pageName", "PNG page name", "For multi-page exports: {title}, {id}, {page}. Include {page} to keep names unique.", { title: "Meeting notes", id: "notebook-id", page: 2 }),
        text("dateFormat", "Date format", "Use YYYY, MM and DD, for example YYYY-MM-DD or YYYYMMDD.", v => {
          if (!v.includes("YYYY") || !v.includes("MM") || !v.includes("DD") || /[\\/]/.test(v)) throw new Error("Include YYYY, MM and DD without slashes.");
        }),
      ] },
      { type: "group", heading: "Export", items: [
        { name: "Handwriting format", desc: "PDF binds each notebook or memo in device page order. PNG exports individual pages.",
          control: { type: "dropdown", key: "exportFormat", options: { pdf: "PDF document", png: "PNG pages" }, defaultValue: "pdf", disabled: syncing } },
        { name: "Highlight block template", desc: "Leave empty for quote callouts. Use {quote}, {note}, {chapter}, {page}, {id}; one block per highlight.",
          control: { type: "textarea", key: "highlightTemplate", rows: 5 } },
      ] },
    ];
  }
}
