import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  userId: string;
  orgId: string;
  email: string;
  exp: number;
}

/**
 * Signed session cookie. HMAC over a compact payload — no dependency, no server-side
 * session store, and tampering fails the signature check.
 */
function secret(): Buffer {
  const value = process.env.SESSION_SECRET ?? process.env.MASTER_KEY_B64;
  if (!value) throw new Error("SESSION_SECRET (or MASTER_KEY_B64) must be set");
  return Buffer.from(value, "base64").length >= 16
    ? Buffer.from(value, "base64")
    : Buffer.from(value, "utf8");
}

export function signSession(payload: Omit<SessionPayload, "exp">, ttlDays = 30): string {
  const body = { ...payload, exp: Date.now() + ttlDays * 86_400_000 };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [encoded, mac] = token.split(".");
  if (!encoded || !mac) return null;

  const expected = createHmac("sha256", secret()).update(encoded).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString()) as SessionPayload;
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
