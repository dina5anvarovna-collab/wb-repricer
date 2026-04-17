import crypto from "node:crypto";
import { createHash } from "node:crypto";

/** Derive 32-byte key from master secret (not for password storage — server-side secret only). */
function deriveKey(masterSecret: string): Buffer {
  return createHash("sha256").update(masterSecret, "utf8").digest();
}

const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

/**
 * AES-256-GCM encryption at rest for WB seller token.
 * Format: base64(iv || ciphertext || authTag)
 */
export function encryptToken(plain: string, masterSecret: string): string {
  const key = deriveKey(masterSecret);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64url");
}

export function decryptToken(payload: string, masterSecret: string): string {
  const key = deriveKey(masterSecret);
  const buf = Buffer.from(payload, "base64url");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - AUTH_TAG_LEN);
  const data = buf.subarray(IV_LEN, buf.length - AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

export function tokenLast4(token: string): string {
  const t = token.replace(/\s/g, "");
  return t.length <= 4 ? "****" : t.slice(-4);
}
