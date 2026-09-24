import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const dir = resolve(".vault-test"); await mkdir(dir, { recursive: true });
await build({ entryPoints: ["scripts/smoke-entry.js"], bundle: true, outfile: `${dir}/smoke.js`, alias: { obsidian: resolve("scripts/obsidian-smoke-stub.js") } });
await writeFile(`${dir}/smoke.html`, `<!doctype html><html><meta charset="utf-8"><style>
body{font:15px/1.5 system-ui;margin:32px auto;max-width:850px;padding:0 24px;background:#fafafa;color:#222}.setting{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:1px solid #ddd}.info{flex:1}.name{font-weight:550}.desc{font-size:13px;color:#555;max-width:490px}.controls{display:flex;gap:8px;flex-shrink:0}.heading{font-size:19px;margin-top:24px;border:0}.heading .name{font-weight:650}input,select,textarea,button{font:inherit;max-width:240px;padding:6px 10px;border:1px solid #aaa;border-radius:5px;background:white;color:inherit}button{cursor:pointer}.cta{background:#6552b3;color:white;border-color:#6552b3}button:disabled{opacity:.5}input:focus,button:focus,textarea:focus,select:focus{outline:2px solid #6552b3;outline-offset:2px}.modal{position:fixed;inset:8% auto auto 50%;transform:translateX(-50%);width:600px;max-width:calc(100vw - 72px);background:white;padding:28px;box-shadow:0 15px 60px #0004;border-radius:12px}canvas{border:1px solid #ddd}@media(max-width:600px){.setting{align-items:start;flex-direction:column;gap:8px}.controls{max-width:100%}.modal{max-height:80vh;overflow:auto}}
</style><body><main id="settings"></main><section id="render"></section><script src="smoke.js"></script></body></html>`);
const browser = await chromium.launch({ channel: process.env.BOOX_TEST_BROWSER || "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(pathToFileURL(`${dir}/smoke.html`).href);
  await page.getByLabel("Notebook name", { exact: true }).fill("{title} - {id}");
  await page.getByLabel("Notebook name", { exact: true }).blur();
  assert.equal(await page.evaluate(() => window.plugin.settings.notebookName), "{title} - {id}");
  await page.getByLabel("Sync folder", { exact: true }).fill("../outside"); await page.getByLabel("Sync folder", { exact: true }).blur();
  assert.equal(await page.evaluate(() => window.plugin.settings.syncFolder), "BOOX");
  assert.match((await page.evaluate(() => window.notices)).at(-1), /vault-relative/);
  await page.screenshot({ path: `${dir}/settings.png`, fullPage: true });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("BOOX account email", { exact: true }).fill("test@example.com");
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await page.getByLabel("Verification code", { exact: true }).fill("123456");
  await page.getByLabel("Local unlock passphrase", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Connect and sync", exact: true }).click();
  assert.match(await page.getByRole("alert").textContent(), /For security.*at least 12 characters.*encrypt/);
  assert.equal(await page.getByLabel("Local unlock passphrase", { exact: true }).getAttribute("aria-invalid"), "true");
  assert.equal(await page.getByLabel("Local unlock passphrase", { exact: true }).evaluate(el => el === document.activeElement), true);
  assert.match((await page.evaluate(() => window.notices)).at(-1), /at least 12 characters/);
  assert.equal(await page.evaluate(() => window.plugin.connected), false);
  await page.getByLabel("Local unlock passphrase", { exact: true }).fill("synthetic passphrase");
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.screenshot({ path: `${dir}/connect.png` });
  await page.getByRole("button", { name: "Connect and sync", exact: true }).click();
  await page.waitForFunction(() => window.plugin.connected);
  assert.equal(await page.evaluate(() => window.plugin.settings.account.uid), "synthetic");
  const pixels = await page.evaluate(() => window.renderFixture());
  assert.deepEqual(pixels, { width: 1860, height: 2480, ink: [18, 52, 86, 255], blank: [255, 255, 255, 255] });
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed: naming settings, path validation, direct login flow, and actual PNG dimensions/pixels.");
} finally { await browser.close(); }
