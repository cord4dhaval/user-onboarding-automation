import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption. Each tenant gets its own data key, which is itself encrypted under
 * the master key. A leaked document for one tenant is therefore useless against another,
 * and rotation is per-tenant.
 *
 * The master key lives in an environment variable today. That is a launch compromise —
 * move it to a managed KMS before storing a second tenant's credentials.
 */
const ALGO = "aes-256-gcm";
export const KEY_VERSION = 1;

function masterKey(): Buffer {
  const b64 = process.env.MASTER_KEY_B64;
  if (!b64) throw new Error("MASTER_KEY_B64 is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("MASTER_KEY_B64 must decode to 32 bytes");
  return key;
}

function seal(plaintext: Buffer, key: Buffer): { blob: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { blob: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64") };
}

function open(blob: string, key: Buffer): Buffer {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

export interface SealedSecret {
  ciphertext: string;
  encDek: string;
  keyVersion: number;
  nonce: string;
}

export function sealSecret(secret: string): SealedSecret {
  const dek = randomBytes(32);
  const { blob: ciphertext } = seal(Buffer.from(secret, "utf8"), dek);
  const { blob: encDek } = seal(dek, masterKey());
  return { ciphertext, encDek, keyVersion: KEY_VERSION, nonce: "" };
}

export function openSecret(sealed: SealedSecret): string {
  const dek = open(sealed.encDek, masterKey());
  return open(sealed.ciphertext, dek).toString("utf8");
}
