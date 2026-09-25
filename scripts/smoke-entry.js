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
window.renderConstantFixture = async () => {
  // A long, constant-width stroke crosses two renderer chunk boundaries.
  const count = 2500, index = 76 + count * 16;
  const buffer = new ArrayBuffer(index + 48), view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    view.setFloat32(76 + i * 16, 10.5 + i * 0.5);
    view.setFloat32(80 + i * 16, 60.5);
    view.setUint16(86 + i * 16, 4095);
  }
  new Uint8Array(buffer).set(new TextEncoder().encode("a".repeat(36)), index);
  view.setUint32(index + 36, 76); view.setUint32(index + 40, count * 16); view.setUint32(index + 44, index);
  const png = await renderCloudPage([{ key: "u/calendar/n/point/P#D#points", size: buffer.byteLength }], "calendar", "P", async () => buffer);
  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
  const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
  const result = { ink: [20, 522, 1034, 1200].map(x => [...ctx.getImageData(x, 60, 1, 1).data]), blank: [...ctx.getImageData(20, 70, 1, 1).data] };
  bitmap.close(); canvas.width = canvas.height = 0;
  return result;
};
