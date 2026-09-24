import { DEFAULT_SETTINGS, BooxSettingTab } from "../src/settings";
import { renderCloudPage } from "../src/handwriting";
import fixture from "../src/__fixtures__/handwriting.json";
window.notices = [];
const settings = structuredClone(DEFAULT_SETTINGS);
const plugin = {
  settings, connected: false, syncing: false, status: "Ready to connect.",
  saveSettings: async () => {}, rescheduleInterval: () => {},
  connectWith: async session => { plugin.connected = true; settings.account = session; },
  disconnect: async () => { plugin.connected = false; settings.account = null; },
  lock: () => { plugin.connected = false; },
  runSync: async () => { plugin.status = "Sync finished."; },
  transport: async req => ({ status: 200, arrayBuffer: new ArrayBuffer(0), text: JSON.stringify(req.url.endsWith("users/me") ? { data: { uid: "synthetic", email: "test@example.com" } } : req.url.endsWith("signupByPhoneOrEmail") ? { data: { token: "synthetic-session" } } : { result_code: 0 }) }),
};
window.plugin = plugin;
new BooxSettingTab({}, plugin).display();
const data = name => Uint8Array.from(atob(fixture[name]), c => c.charCodeAt(0)).buffer;
window.renderFixture = async () => {
  const keys = ["u/note/n/point/L1#D#points", "u/note/n/shape/L1#S#1.zip", "u/note/n/pageModel/pb/P"];
  const bytes = await renderCloudPage(keys.map(key => ({ key, size: 1 })), "note", "P", async key => data(key.includes("point/") ? "points" : key.includes("shape/") ? "shape" : "page"));
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = document.createElement("canvas"); canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext("2d"); ctx.drawImage(bmp, 0, 0);
  document.querySelector("#render").append(canvas); canvas.style.width = "465px"; canvas.style.height = "620px";
  return { width: bmp.width, height: bmp.height, ink: [...ctx.getImageData(120, 240, 1, 1).data], blank: [...ctx.getImageData(10, 20, 1, 1).data] };
};
