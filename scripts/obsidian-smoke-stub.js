// Minimal DOM harness for exercising native Obsidian controls in a real browser.
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.createEl = function (tag, options = {}) {
  const el = document.createElement(tag); el.textContent = options.text || "";
  for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
  this.append(el); return el;
};
export class Notice { constructor(message) { window.notices.push(message); } }
export class Modal {
  constructor(app) { this.app = app; this.contentEl = document.createElement("section"); this.contentEl.className = "modal"; }
  open() { document.body.append(this.contentEl); this.onOpen(); }
  close() { this.onClose(); this.contentEl.remove(); }
}
export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.containerEl = document.querySelector("#settings"); }
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
    this.info.append(this.name, this.desc); this.controls = document.createElement("div"); this.controls.className = "controls";
    this.el.append(this.info, this.controls); parent.append(this.el);
  }
  setName(t) { this.name.textContent = t; return this; }
  setDesc(t) { this.desc.textContent = t; return this; }
  setHeading() { this.el.classList.add("heading"); return this; }
  add(tag, fn, type) { const el = document.createElement(tag); if (type) el.type = type; el.setAttribute("aria-label", this.name.textContent); this.controls.append(el); fn(new Control(el)); return this; }
  addText(fn) { return this.add("input", fn, "text"); }
  addTextArea(fn) { return this.add("textarea", fn); }
  addDropdown(fn) { return this.add("select", fn); }
  addToggle(fn) { return this.add("input", fn, "checkbox"); }
  addButton(fn) { return this.add("button", fn); }
}
