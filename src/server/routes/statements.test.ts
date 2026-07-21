import { describe, expect, it } from "vitest";
import { sendBodySchema } from "./statements.js";
import { batchBodySchema, downloadBodySchema } from "./chase.js";

// Schema-level route tests (no Fastify harness in repo — the handlers
// 400 on safeParse failure, so the schema IS the rejection contract).
// origin became required on every statement path in origin-split-2 W1 T5.
// 'both' (the combined two-box statement) was reinstated by operator
// request 2026-07-14 — it renders the books as separate sections, not
// the old blended single table.

describe("statement send body schema (POST /:id/statement-send)", () => {
  it("rejects a body with no origin", () => {
    const r = sendBodySchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.flatten().fieldErrors.origin?.[0]).toMatch(
        /origin is required/,
      );
    }
  });

  it("rejects an unknown origin value", () => {
    const r = sendBodySchema.safeParse({ origin: "blended" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.flatten().fieldErrors.origin?.[0]).toMatch(
        /origin is required/,
      );
    }
  });

  it("accepts 'feldart', 'tj' and 'both'", () => {
    expect(sendBodySchema.safeParse({ origin: "feldart" }).success).toBe(true);
    expect(sendBodySchema.safeParse({ origin: "tj" }).success).toBe(true);
    expect(sendBodySchema.safeParse({ origin: "both" }).success).toBe(true);
  });

  it("still accepts operator overrides alongside origin", () => {
    const r = sendBodySchema.safeParse({
      origin: "tj",
      subject: "Statement of account",
      body: "<p>Hi</p>",
      userSignatureId: null,
    });
    expect(r.success).toBe(true);
  });
});

describe("chase batch statement body schema (POST /batch-statement)", () => {
  const ids = ["cust_1", "cust_2"];

  it("rejects a body with no origin (old default 'both' removed)", () => {
    const r = batchBodySchema.safeParse({ customerIds: ids });
    expect(r.success).toBe(false);
  });

  it("rejects origin 'both'", () => {
    const r = batchBodySchema.safeParse({ customerIds: ids, origin: "both" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.flatten().fieldErrors.origin?.[0]).toMatch(
        /blended statements are no longer supported/,
      );
    }
  });

  it("accepts 'feldart' and 'tj'", () => {
    expect(
      batchBodySchema.safeParse({ customerIds: ids, origin: "feldart" })
        .success,
    ).toBe(true);
    expect(
      batchBodySchema.safeParse({ customerIds: ids, origin: "tj" }).success,
    ).toBe(true);
  });
});

describe("chase download-statements body schema (POST /download-statements)", () => {
  const ids = ["cust_1", "cust_2"];

  it("mirrors the batch-send shape: origin required, 'both' rejected", () => {
    expect(downloadBodySchema.safeParse({ customerIds: ids }).success).toBe(false);
    expect(
      downloadBodySchema.safeParse({ customerIds: ids, origin: "both" }).success,
    ).toBe(false);
    expect(
      downloadBodySchema.safeParse({ customerIds: ids, origin: "feldart" }).success,
    ).toBe(true);
    expect(
      downloadBodySchema.safeParse({ customerIds: ids, origin: "tj" }).success,
    ).toBe(true);
  });

  it("rejects an empty selection", () => {
    expect(
      downloadBodySchema.safeParse({ customerIds: [], origin: "feldart" }).success,
    ).toBe(false);
  });
});
