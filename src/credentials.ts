// Only ciphertext is persisted. The passphrase and decrypted BOOX session stay in memory.
export interface EncryptedSession { version: 1; salt: string; iv: string; ciphertext: string }
export interface Session { region: string; token: string; uid: string; email: string }
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(Array.from(b, x => String.fromCharCode(x)).join(""));
const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function key(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: new Uint8Array(salt), iterations: 600000, hash: "SHA-256" }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptSession(session: Session, password: string): Promise<EncryptedSession> {
  if (password.length < 12) throw new Error("Use an unlock passphrase of at least 12 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(password, salt), enc.encode(JSON.stringify(session)));
  return { version: 1, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(data)) };
}
export async function decryptSession(value: EncryptedSession, password: string): Promise<Session> {
  try {
    if (value.version !== 1) throw new Error();
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(value.iv) },
      await key(password, bytes(value.salt)), bytes(value.ciphertext));
    const s = JSON.parse(new TextDecoder().decode(data));
    if (!s.token || !s.uid || !["eur", "push"].includes(s.region)) throw new Error();
    return s;
  } catch { throw new Error("Could not unlock the saved session. Check your passphrase or connect again."); }
}
