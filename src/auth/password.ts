import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * scrypt from the standard library — no dependency, and deliberately slow so a leaked
 * table of hashes is expensive to attack.
 */
const KEYLEN = 64;
const COST = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, { N: COST });
  return `scrypt$${COST}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, cost, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !cost || !saltB64 || !keyB64) return false;

  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");
  const actual = scryptSync(password, salt, expected.length, { N: Number(cost) });
  // Constant time, so a wrong password cannot be narrowed down by timing.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
