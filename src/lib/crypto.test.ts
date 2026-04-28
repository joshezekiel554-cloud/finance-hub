import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "./crypto.js";

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");

describe("crypto AES-256-GCM", () => {
  it("roundtrips a short string", () => {
    const plaintext = "hello, world";
    const ct = encrypt(plaintext, KEY_A);
    expect(decrypt(ct, KEY_A)).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = encrypt("same input", KEY_A);
    const b = encrypt("same input", KEY_A);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY_A)).toBe("same input");
    expect(decrypt(b, KEY_A)).toBe("same input");
  });

  it("throws when ciphertext is tampered with", () => {
    const ct = encrypt("sensitive token", KEY_A);
    const buf = Buffer.from(ct, "base64");
    // Flip a bit in the ciphertext body (after the 12-byte IV, before the 16-byte tag)
    buf[15] = buf[15]! ^ 0x01;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, KEY_A)).toThrow();
  });

  it("throws when the auth tag is tampered with", () => {
    const ct = encrypt("sensitive token", KEY_A);
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, KEY_A)).toThrow();
  });

  it("throws when decrypting with the wrong key", () => {
    const ct = encrypt("sensitive token", KEY_A);
    expect(() => decrypt(ct, KEY_B)).toThrow();
  });

  it("roundtrips a 10KB payload", () => {
    const big = "x".repeat(10_000);
    const ct = encrypt(big, KEY_A);
    expect(decrypt(ct, KEY_A)).toBe(big);
  });

  it("rejects malformed key strings", () => {
    expect(() => encrypt("data", "not-hex")).toThrow();
    expect(() => encrypt("data", "abc")).toThrow();
  });

  it("rejects keys of wrong byte length", () => {
    expect(() => encrypt("data", Buffer.alloc(16))).toThrow();
    expect(() => encrypt("data", Buffer.alloc(64))).toThrow();
  });

  it("rejects truncated ciphertext", () => {
    expect(() => decrypt("AAAA", KEY_A)).toThrow();
  });

  it("accepts a Buffer plaintext input", () => {
    const ct = encrypt(Buffer.from("buffer in", "utf8"), KEY_A);
    expect(decrypt(ct, KEY_A)).toBe("buffer in");
  });
});
