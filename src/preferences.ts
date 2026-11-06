import type { BooxSettings } from "./types";
import type { Session } from "./credentials";

export const DEFAULT_SETTINGS: BooxSettings = {
  source: "cloud", region: "eur", account: null, syncFolder: "BOOX", intervalMinutes: 15,
  syncHighlights: true, syncNotebooks: true, syncMemos: true, syncFiles: true, deleteRemoved: false,
  highlightsFolder: "Highlights", notebooksFolder: "Notebooks", memosFolder: "Calendar memo", filesFolder: "Files",
  notebookName: "{title}", highlightName: "{title}", memoName: "{date}", attachmentName: "{title}", pageName: "{title}_{page}",
  dateFormat: "YYYYMMDD", preserveFolders: true, exportFormat: "pdf", highlightTemplate: "", syncOnStartup: true,
};

// `stored` is the session from Obsidian's secret storage.
export function restorePreferences(raw: unknown, stored: Session | null = null): { settings: BooxSettings; session: Session | null } {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BooxSettings)[]) {
    const value = data[key], fallback = DEFAULT_SETTINGS[key];
    if (value === undefined) continue;
    if (typeof fallback === "boolean" || typeof fallback === "string" || typeof fallback === "number") {
      if (typeof value === typeof fallback) Object.assign(settings, { [key]: value });
    } else if (value === null || (typeof value === "object" && !Array.isArray(value))) Object.assign(settings, { [key]: value });
  }
  if (!Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 0 || settings.intervalMinutes > 1440) settings.intervalMinutes = DEFAULT_SETTINGS.intervalMinutes;
  if (!["eur", "push"].includes(settings.region || "")) settings.region = "eur";
  if (!["pdf", "png"].includes(settings.exportFormat || "")) settings.exportFormat = "pdf";
  if (!["cloud", "tablet"].includes(settings.source || "")) settings.source = "cloud";
  if (stored) {
    settings.region = stored.region;
    settings.account = { uid: stored.uid || null, email: stored.email || null };
  } else settings.account = null;
  return { settings, session: stored };
}
