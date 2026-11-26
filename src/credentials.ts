// The BOOX session lives in Obsidian's secret storage, never in data.json.
export const SUPPORTED_REGIONS = ["eur", "push", "cn"] as const;
export type BooxRegion = (typeof SUPPORTED_REGIONS)[number];
export interface Session { region: string; token: string; uid: string; email: string }
export function isSupportedRegion(region: unknown): region is BooxRegion {
  return typeof region === "string" && (SUPPORTED_REGIONS as readonly string[]).includes(region);
}
export function normalizeBearerToken(raw: string): string {
  const token = raw.trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
  if (!token || /[\r\n]/.test(token)) throw new Error("Enter a valid BOOX bearer token.");
  return token;
}
// Validate a serialized session from secret storage.
export function parseSession(raw: string | null | undefined): Session | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const s = value as Record<string, unknown>;
    if (typeof s.token !== "string" || !s.token || !s.uid || !isSupportedRegion(s.region)) return null;
    const uid = s.uid as string;
    return { region: s.region, token: s.token, uid: String(uid), email: typeof s.email === "string" ? s.email : "" };
  } catch { return null; }
}
