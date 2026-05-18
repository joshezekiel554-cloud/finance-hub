import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_SIGNATURE_BYTES } from "../../modules/email-compose/signatures.js";

const createUserSigSchema = z.object({
  name: z.string().min(1).max(64),
  html: z.string().min(0).max(MAX_SIGNATURE_BYTES),
  isDefault: z.boolean().optional(),
});

describe("signatures route validation", () => {
  it("rejects empty name", () => {
    const r = createUserSigSchema.safeParse({ name: "", html: "x" });
    expect(r.success).toBe(false);
  });

  it("accepts 32 KB html (boundary)", () => {
    const html = "a".repeat(MAX_SIGNATURE_BYTES);
    const r = createUserSigSchema.safeParse({ name: "x", html });
    expect(r.success).toBe(true);
  });

  it("rejects 32 KB + 1 html with too_big code", () => {
    const html = "a".repeat(MAX_SIGNATURE_BYTES + 1);
    const r = createUserSigSchema.safeParse({ name: "x", html });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === "too_big")).toBe(true);
    }
  });

  it("rejects 65-char name", () => {
    const r = createUserSigSchema.safeParse({
      name: "x".repeat(65),
      html: "x",
    });
    expect(r.success).toBe(false);
  });
});
