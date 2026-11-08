// Minimal DOM harness for exercising native Obsidian controls in a real browser.
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.createEl = function (tag, options = {}) {
  const el = document.createElement(tag); el.textContent = options.text || "";
  for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
  this.append(el); return el;
};
export class Notice { constructor(message) { window.notices.push(message); } }
export const Platform = { isAndroidApp: false };
export class Modal {
  constructor(app) { this.app = app; this.contentEl = document.createElement("section"); this.contentEl.className = "modal"; }
  open() { document.body.append(this.contentEl); this.onOpen(); }
  close() { this.onClose(); this.contentEl.remove(); }
}
const evaluate = v => typeof v === "function" ? v() : v ?? true;
// Renders getSettingDefinitions() the way Obsidian 1.13+ does: control rows bind
// through get/setControlValue, validate shows an inline error and blocks the
// write, and refreshDomState re-evaluates `disabled`/`visible` in place.
export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.querySelector("#settings"); this.rendered = []; }
  getControlValue(key) { return this.plugin.settings[key]; }
  async setControlValue(key, value) { this.plugin.settings[key] = value; await this.plugin.saveSettings(); }
  hide() { for (const r of this.rendered) r.cleanup?.(); this.rendered = []; }
  update() { this.hide(); this.containerEl.replaceChildren(); for (const item of this.getSettingDefinitions()) this.renderItem(item); this.refreshDomState(); }
  refreshDomState() {
    for (const { def, setting } of this.rendered) {
      setting.el.hidden = evaluate(def.visible) === false;
      if (def.control) for (const el of setting.controls.querySelectorAll("input,select,textarea")) el.disabled = evaluate(def.control.disabled) === true;
    }
  }
  renderItem(def) {
    if (def.type === "group") { new Setting(this.containerEl).setName(def.heading).setHeading(); for (const item of def.items) this.renderItem(item); return; }
    const setting = new Setting(this.containerEl).setName(def.name).setDesc(def.desc ?? "");
    const entry = { def, setting }; this.rendered.push(entry);
    if (def.render) entry.cleanup = def.render(setting);
    if (!def.control) return;
    const c = def.control, value = this.getControlValue(c.key) ?? c.defaultValue;
    const commit = async v => { const error = await c.validate?.(v); setting.setError(error || ""); if (!error) { await this.setControlValue(c.key, v); this.refreshDomState(); } };
    if (c.type === "toggle") setting.addToggle(t => t.setValue(Boolean(value)).onChange(commit));
    else if (c.type === "dropdown") setting.addDropdown(d => { for (const [k, v] of Object.entries(c.options)) d.addOption(k, v); d.setValue(value).onChange(commit); });
    else if (c.type === "textarea") setting.addTextArea(t => t.setValue(value ?? "").onChange(commit));
    else if (c.type === "number") setting.addText(t => { t.setValue(String(value)); t.inputEl.addEventListener("change", () => void commit(Number(t.getValue()))); });
    else setting.addText(t => t.setValue(value ?? "").onChange(commit));
  }
}
class Control {
  constructor(el) { this.inputEl = el; }
  setValue(v) { if (this.inputEl.type === "checkbox") this.inputEl.checked = v; else this.inputEl.value = v; return this; }
  getValue() { return this.inputEl.value; }
  setDisabled(v) { this.inputEl.disabled = v; return this; }
  onChange(fn) { this.inputEl.addEventListener(this.inputEl.tagName === "SELECT" || this.inputEl.type === "checkbox" ? "change" : "input", () => fn(this.inputEl.type === "checkbox" ? this.inputEl.checked : this.inputEl.value)); return this; }
  addOption(value, text) { this.inputEl.add(new Option(text, value)); return this; }
  setButtonText(t) { this.inputEl.removeAttribute("aria-label"); this.inputEl.textContent = t; return this; }
  onClick(fn) { this.inputEl.addEventListener("click", fn); return this; }
  setCta() { this.inputEl.classList.add("cta"); return this; }
}
export class Setting {
  constructor(parent) {
    this.el = document.createElement("div"); this.el.className = "setting";
    this.info = document.createElement("div"); this.name = document.createElement("div"); this.name.className = "name";
    this.desc = document.createElement("div"); this.desc.className = "desc";
    this.error = document.createElement("div"); this.error.className = "error";
    this.info.append(this.name, this.desc, this.error); this.controls = document.createElement("div"); this.controls.className = "controls";
    this.el.append(this.info, this.controls); parent.append(this.el);
  }
  setName(t) { this.name.textContent = t; return this; }
  setDesc(t) { this.desc.textContent = t; return this; }
  setError(t) { this.error.textContent = t; return this; }
  setHeading() { this.el.classList.add("heading"); return this; }
  add(tag, fn, type) { const el = document.createElement(tag); if (type) el.type = type; el.setAttribute("aria-label", this.name.textContent); this.controls.append(el); fn(new Control(el)); return this; }
  addText(fn) { return this.add("input", fn, "text"); }
  addTextArea(fn) { return this.add("textarea", fn); }
  addDropdown(fn) { return this.add("select", fn); }
  addToggle(fn) { return this.add("input", fn, "checkbox"); }
  addButton(fn) { return this.add("button", fn); }
}
