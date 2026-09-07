// Schema-level route tests — same convention as statements.test.ts (no
// Fastify harness in the repo; handlers 400 on safeParse failure, so the
// zod schema is the rejection contract).
import { describe, expect, it } from "vitest";
import { dismissBodySchema, restoreBodySchema } from "./invoicing-email-review.js";

describe("POST /api/invoicing/email-review/dismiss body", () => {
  it("accepts a categorical reason without a note", () => {
    expect(
      dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "sent_elsewhere" }).success,
    ).toBe(true);
  });

  it("requires a non-blank note when reason is other", () => {
    expect(dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "other" }).success).toBe(false);
    expect(
      dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "other", reasonNote: "   " }).success,
    ).toBe(false);
    expect(
      dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "other", reasonNote: "PDF'd by hand" })
        .success,
    ).toBe(true);
  });

  it("rejects unknown reasons and over-long notes", () => {
    expect(dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "b2c_paid_upfront" }).success).toBe(false);
    expect(
      dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "sent_elsewhere", reasonNote: "x".repeat(501) })
        .success,
    ).toBe(false);
  });

  it("rejects a missing invoiceId", () => {
    expect(dismissBodySchema.safeParse({ reason: "sent_elsewhere" }).success).toBe(false);
  });
});

describe("POST /api/invoicing/email-review/restore body", () => {
  it("needs an invoiceId", () => {
    expect(restoreBodySchema.safeParse({}).success).toBe(false);
    expect(restoreBodySchema.safeParse({ invoiceId: "inv_1" }).success).toBe(true);
  });
});
