import { App, Modal, Setting, Notice } from "obsidian";
import type BooxSyncPlugin from "./main";
import { BooxClient } from "./client";

export class ConnectModal extends Modal {
  private region = "eur";
  private email = "";
  private code = "";
  private sent = false;
  private pastedKey = "";

  constructor(app: App, private plugin: BooxSyncPlugin, private onDone: () => void) {
    super(app);
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private client(): BooxClient {
    return new BooxClient(this.plugin.settings.backendUrl, this.plugin.transport);
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Connect to BOOX" });

    contentEl.createEl("p", {
      text: "Recommended: open your BOOX dashboard in the browser, click “Connect Obsidian”, and paste the key here.",
    });
    new Setting(contentEl)
      .setName("API key")
      .addText((t) =>
        t.setPlaceholder("boox_…").setValue(this.pastedKey).onChange((v) => (this.pastedKey = v.trim())),
      )
      .addButton((b) => b.setButtonText("Use key").setCta().onClick(() => this.useKey()));

    contentEl.createEl("h3", { text: "Or log in with your Onyx email" });

    new Setting(contentEl).setName("Region").addDropdown((d) =>
      d
        .addOption("eur", "Europe (eur.boox.com)")
        .addOption("push", "Global (push.boox.com)")
        .setValue(this.region)
        .onChange((v) => (this.region = v)),
    );

    new Setting(contentEl).setName("Email on your Onyx account").addText((t) =>
      t.setPlaceholder("you@example.com").setValue(this.email).onChange((v) => (this.email = v.trim())),
    );

    if (!this.sent) {
      new Setting(contentEl).addButton((b) =>
        b.setButtonText("Send code").setCta().onClick(() => this.sendCode()),
      );
    } else {
      new Setting(contentEl).setName("6-digit code").addText((t) =>
        t.setPlaceholder("123456").setValue(this.code).onChange((v) => (this.code = v.trim())),
      );
      new Setting(contentEl).addButton((b) =>
        b.setButtonText("Connect").setCta().onClick(() => this.connect()),
      );
    }
  }

  private async useKey() {
    if (!this.pastedKey) {
      new Notice("Paste an API key first.");
      return;
    }
    try {
      // Validate against the backend before saving — a typo'd key fails here, not
      // silently on the next background sync.
      const client = new BooxClient(this.plugin.settings.backendUrl, this.plugin.transport, this.pastedKey);
      const res = await client.me();
      await this.plugin.connectWith(this.pastedKey, { uid: res.account.uid, email: res.account.email ?? "" });
      new Notice(`Connected as ${res.account.email ?? res.account.uid}.`);
      this.close();
      this.onDone();
      this.plugin.runSync("manual");
    } catch (e: any) {
      new Notice(`Key check failed: ${e.message}`);
    }
  }

  private async sendCode() {
    try {
      await this.client().sendCode(this.email, this.region);
      this.sent = true;
      new Notice("Code sent — check your email.");
      this.render();
    } catch (e: any) {
      new Notice(`Send failed: ${e.message}`);
    }
  }

  private async connect() {
    try {
      const label = `Obsidian on ${navigator.platform || "device"}`;
      const res = await this.client().device(this.email, this.region, this.code, label);
      await this.plugin.connectWith(res.apiKey, res.account);
      new Notice(`Connected as ${res.account.email}.`);
      this.close();
      this.onDone();
      this.plugin.runSync("manual");
    } catch (e: any) {
      new Notice(`Connect failed: ${e.message}`);
    }
  }
}
