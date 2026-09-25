import { App, Modal, Setting, Notice } from "obsidian";
import type BooxSyncPlugin from "./main";
import { BooxClient } from "./client";

export class ConnectModal extends Modal {
  private region: string;
  private email = "";
  private code = "";
  private passphrase = "";
  private sent = false;
  private busy = false;
  private closed = false;
  private message = "";
  // `upgrade`: unlock a 0.3.x passphrase-encrypted session once and move it to secret storage.
  constructor(app: App, private plugin: BooxSyncPlugin, private onDone: () => void, private upgrade = false) {
    super(app); this.region = plugin.settings.region || "eur";
  }
  onOpen() { this.closed = false; this.render(); }
  onClose() { this.closed = true; this.passphrase = this.code = ""; this.contentEl.empty(); }
  private render() {
    const el = this.contentEl; el.empty();
    el.createEl("h2", { text: this.upgrade ? "Finish BOOX upgrade" : "Connect to BOOX" });
    el.createEl("p", { text: this.upgrade
      ? "BOOX Sync no longer needs a passphrase. Enter your old one one last time; your login then moves to your system keychain and syncs automatically from now on."
      : "Sign in directly to the same BOOX region used on your tablet. Enable cloud sync on the tablet first. Your login is kept in your system keychain." });
    if (this.upgrade) {
      new Setting(el).setName("Old unlock passphrase").addText(t => {
        t.inputEl.type = "password"; t.inputEl.autocomplete = "current-password";
        t.setValue(this.passphrase).setDisabled(this.busy).onChange(v => this.passphrase = v);
      });
    } else {
      new Setting(el).setName("Region").addDropdown(d => d.addOption("eur", "Europe (eur.boox.com)").addOption("push", "Global (push.boox.com)")
        .setValue(this.region).setDisabled(this.busy || this.sent).onChange(v => this.region = v));
      new Setting(el).setName("BOOX account email").addText(t => { t.inputEl.type = "email"; t.setValue(this.email).setDisabled(this.busy || this.sent).onChange(v => this.email = v.trim()); });
      if (this.sent) {
        new Setting(el).setName("Verification code").setDesc("The six-digit code sent to your email.").addText(t => {
          t.inputEl.inputMode = "numeric"; t.inputEl.maxLength = 6; t.setValue(this.code).setDisabled(this.busy).onChange(v => this.code = v.trim());
        });
      }
    }
    if (this.message) el.createEl("p", { text: this.message, attr: { role: "status", "aria-live": "polite" } });
    const controls = new Setting(el);
    controls.addButton(b => b.setButtonText(this.busy ? "Please wait…" : this.upgrade ? "Upgrade and sync" : this.sent ? "Connect and sync" : "Send code")
      .setCta().setDisabled(this.busy).onClick(() => this.submit()));
    if (this.sent && !this.upgrade) controls.addButton(b => b.setButtonText("Change email or resend").setDisabled(this.busy).onClick(() => { this.sent = false; this.code = ""; this.render(); }));
  }
  private async submit() {
    if (this.busy) return;
    this.busy = true; this.message = ""; this.render();
    try {
      if (this.upgrade) {
        await this.plugin.unlockLegacy(this.passphrase);
      } else if (!this.sent) {
        await new BooxClient(this.region, this.plugin.transport).sendCode(this.email);
        this.sent = true; this.message = "Code sent. Check your inbox."; return;
      } else {
        const session = await new BooxClient(this.region, this.plugin.transport).login(this.email, this.code, this.region);
        if (this.closed) return;
        await this.plugin.connectWith(session);
      }
      new Notice("BOOX connected. Starting sync."); this.close(); this.onDone();
      void this.plugin.runSync("manual");
    } catch (e: any) { this.message = e.message || "Could not connect. Try again."; }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
}
