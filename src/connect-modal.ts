import { App, Modal, Setting, Notice } from "obsidian";
import type BooxSyncPlugin from "./main";
import { BooxClient } from "./client";

export class ConnectModal extends Modal {
  private region: string;
  private email = "";
  private code = "";
  private passphrase = "";
  private remember = true;
  private sent = false;
  private busy = false;
  private closed = false;
  private message = "";
  private passphraseInput: HTMLInputElement | null = null;
  private passphraseError: HTMLElement | null = null;
  constructor(app: App, private plugin: BooxSyncPlugin, private onDone: () => void, private unlock = false, private protect = false) {
    super(app); this.region = plugin.settings.region || "eur";
  }
  onOpen() { this.closed = false; this.render(); }
  onClose() { this.closed = true; this.passphrase = this.code = ""; this.contentEl.empty(); }
  private render() {
    const el = this.contentEl; el.empty();
    this.passphraseInput = null; this.passphraseError = null;
    el.createEl("h2", { text: this.protect ? "Remember BOOX connection" : this.unlock ? "Unlock BOOX sync" : "Connect to BOOX" });
    el.createEl("p", { text: this.protect ? "Encrypt your current connection with a local passphrase. You will unlock it once each time Obsidian starts. Your passphrase is never saved." : this.unlock ? "Enter your local unlock passphrase to resume background sync." : "Sign in directly to the same BOOX region used on your tablet. Enable cloud sync on the tablet first." });
    if (!this.unlock && !this.protect) {
      new Setting(el).setName("Region").addDropdown(d => d.addOption("eur", "Europe (eur.boox.com)").addOption("push", "Global (push.boox.com)")
        .setValue(this.region).setDisabled(this.busy || this.sent).onChange(v => this.region = v));
      new Setting(el).setName("BOOX account email").addText(t => { t.inputEl.type = "email"; t.setValue(this.email).setDisabled(this.busy || this.sent).onChange(v => this.email = v.trim()); });
      if (this.sent) {
        new Setting(el).setName("Verification code").setDesc("The six-digit code sent to your email.").addText(t => {
          t.inputEl.inputMode = "numeric"; t.inputEl.maxLength = 6; t.setValue(this.code).setDisabled(this.busy).onChange(v => this.code = v.trim());
        });
        new Setting(el).setName("Remember this connection").setDesc("Save an encrypted session. Unlock once each time Obsidian starts; your passphrase is never saved.")
          .addToggle(t => t.setValue(this.remember).setDisabled(this.busy).onChange(v => { this.remember = v; this.render(); }));
      }
    }
    if (this.protect || this.unlock || (this.sent && this.remember)) {
      new Setting(el).setName("Local unlock passphrase").setDesc(this.unlock ? "This is the passphrase you chose for this plugin." : "Required to save your connection securely: choose at least 12 characters. This passphrase encrypts your BOOX login on this device and is never saved.")
        .addText(t => { t.inputEl.type = "password"; t.inputEl.autocomplete = this.unlock ? "current-password" : "new-password";
          this.passphraseInput = t.inputEl;
          t.inputEl.setAttribute("aria-describedby", "boox-passphrase-error");
          t.setValue(this.passphrase).setDisabled(this.busy).onChange(v => {
            this.passphrase = v;
            if (v.length >= 12 && this.passphraseError) {
              this.passphraseError.hidden = true;
              t.inputEl.removeAttribute("aria-invalid");
            }
          }); });
      this.passphraseError = el.createEl("p", { attr: { id: "boox-passphrase-error", role: "alert" } });
      this.passphraseError.style.color = "var(--text-error)";
      this.passphraseError.hidden = true;
    }
    if (this.message) el.createEl("p", { text: this.message, attr: { role: "status", "aria-live": "polite" } });
    const controls = new Setting(el);
    controls.addButton(b => b.setButtonText(this.busy ? "Please wait…" : this.protect ? "Save encrypted connection" : this.unlock ? (this.plugin.settings.syncOnStartup ? "Unlock and sync" : "Unlock") : this.sent ? "Connect and sync" : "Send code")
      .setCta().setDisabled(this.busy).onClick(() => this.submit()));
    if (this.sent && !this.unlock) controls.addButton(b => b.setButtonText("Change email or resend").setDisabled(this.busy).onClick(() => { this.sent = false; this.code = ""; this.render(); }));
  }
  private async submit() {
    if (this.busy) return;
    if (!this.unlock && (this.protect || (this.sent && this.remember)) && this.passphrase.length < 12) {
      const message = "For security, enter a passphrase of at least 12 characters to encrypt your saved BOOX login.";
      if (this.passphraseError) { this.passphraseError.textContent = message; this.passphraseError.hidden = false; }
      this.passphraseInput?.setAttribute("aria-invalid", "true");
      this.passphraseInput?.focus();
      new Notice(message, 8000);
      return;
    }
    this.busy = true; this.message = ""; this.render();
    try {
      if (this.protect) {
        await this.plugin.rememberSession(this.passphrase);
      } else if (this.unlock) {
        await this.plugin.unlock(this.passphrase);
      } else if (!this.sent) {
        await new BooxClient(this.region, this.plugin.transport).sendCode(this.email);
        this.sent = true; this.message = "Code sent. Check your inbox."; return;
      } else {
        const session = await new BooxClient(this.region, this.plugin.transport).login(this.email, this.code, this.region);
        if (this.closed) return;
        await this.plugin.connectWith(session, this.remember ? this.passphrase : undefined);
      }
      const sync = !this.protect && (!this.unlock || this.plugin.settings.syncOnStartup);
      new Notice(this.protect ? "BOOX connection saved encrypted." : sync ? "BOOX connected. Starting sync." : "BOOX session unlocked."); this.close(); this.onDone();
      if (sync) void this.plugin.runSync("manual");
    } catch (e: any) { this.message = e.message || "Could not connect. Try again."; }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
}
