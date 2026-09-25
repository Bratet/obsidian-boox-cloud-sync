import type { BooxSettings } from "./types";
import type { Session } from "./credentials";

export const DEFAULT_SETTINGS: BooxSettings = {
  encryptedSession: null, region: "eur", account: null, syncFolder: "BOOX", intervalMinutes: 15,
  syncHighlights: true, syncNotebooks: true, syncMemos: true, syncFiles: true, deleteRemoved: false,
  highlightsFolder: "Highlights", notebooksFolder: "Notebooks", memosFolder: "Calendar memo", filesFolder: "Files",
  notebookName: "{title}", highlightName: "{title}", memoName: "{date}", attachmentName: "{title}", pageName: "{title}_{page}",
  dateFormat: "YYYYMMDD", preserveFolders: true, exportFormat: "pdf", highlightTemplate: "", syncOnStartup: true,
};

// `stored` is the session from Obsidian's secret storage; it wins over any
// legacy data.json form (plaintext token or passphrase-encrypted blob).
export function restorePreferences(raw: unknown, stored: Session | null = null): { settings: BooxSettings; session: Session | null; removeLegacy: boolean } {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BooxSettings)[]) {
    const value = data[key], fallback = DEFAULT_SETTINGS[key];
    if (value === undefined) continue;
    if (typeof fallback === "boolean" || typeof fallback === "string" || typeof fallback === "number") {
      if (typeof value === typeof fallback) (settings as any)[key] = value;
    } else if (value === null || (typeof value === "object" && !Array.isArray(value))) (settings as any)[key] = value;
  }
  if (!Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 0 || settings.intervalMinutes > 1440) settings.intervalMinutes = DEFAULT_SETTINGS.intervalMinutes;
  if (!["eur", "push"].includes(settings.region || "")) settings.region = "eur";
  if (!["pdf", "png"].includes(settings.exportFormat || "")) settings.exportFormat = "pdf";
  const removeLegacy = ["token", "apiKey", "backendUrl"].some(key => Object.prototype.hasOwnProperty.call(data, key));
  let session: Session | null = stored;
  if (session) {
    settings.encryptedSession = null;
    settings.region = session.region;
    settings.account = { uid: session.uid || settings.account?.uid || null, email: session.email || settings.account?.email || null };
  }
  if (!session && !settings.encryptedSession && typeof data.token === "string" && data.token && ["eur", "push"].includes(String(data.region))) {
    session = { region: settings.region!, token: data.token, uid: String(settings.account?.uid || ""), email: settings.account?.email || "" };
  }
  if (!session && !settings.encryptedSession) settings.account = null;
  return { settings, session, removeLegacy };
}
