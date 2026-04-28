import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function resolveKey(key?: Buffer | string): Buffer {
  if (key === undefined || key === null) {
    const hex = env.CRYPTO_KEY;
    if (!hex) throw new Error("CRYPTO_KEY is not set");
    return Buffer.from(hex, "hex");
  }
  if (typeof key === "string") {
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error("crypto key must be 64 hex chars (32 bytes)");
    }
    return Buffer.from(key, "hex");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`crypto key must be ${KEY_BYTES} bytes`);
  }
  return key;
}

export function encrypt(plaintext: string | Buffer, key?: Buffer | string): string {
  const k = resolveKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, k, iv);
  const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64");
}

export function decrypt(payload: string, key?: Buffer | string): string {
  const k = resolveKey(key);
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, k, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
