// The BOOX session lives in Obsidian's secret storage, never in data.json.
export interface Session { region: string; token: string; uid: string; email: string }
// Validate a serialized session from secret storage.
export function parseSession(raw: string | null | undefined): Session | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const s = value as Record<string, unknown>;
    if (typeof s.token !== "string" || !s.token || !s.uid || (s.region !== "eur" && s.region !== "push")) return null;
    const uid = s.uid as string;
    return { region: s.region, token: s.token, uid: String(uid), email: typeof s.email === "string" ? s.email : "" };
  } catch { return null; }
}
