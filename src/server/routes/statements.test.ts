import { describe, expect, it } from "vitest";
import {
  attachmentDisposition,
  downloadBodySchema as downloadStatementBodySchema,
  sendBodySchema,
  statementDownloadFilename,
} from "./statements.js";
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

describe("statement download (POST /:id/statement-download)", () => {
  it("requires a valid origin", () => {
    expect(downloadStatementBodySchema.safeParse({}).success).toBe(false);
    expect(
      downloadStatementBodySchema.safeParse({ origin: "blended" }).success,
    ).toBe(false);
    for (const origin of ["feldart", "tj", "both"]) {
      expect(downloadStatementBodySchema.safeParse({ origin }).success).toBe(
        true,
      );
    }
  });

  it("names the file '<customer>, <statement number>.pdf'", () => {
    expect(statementDownloadFilename("Acme Judaica", 2051)).toBe(
      "Acme Judaica, 2051.pdf",
    );
  });

  it("strips characters Windows rejects in filenames", () => {
    expect(statementDownloadFilename('A/B: "Shop" <NY>?', 7)).toBe(
      "AB Shop NY, 7.pdf",
    );
    expect(statementDownloadFilename("  ", 7)).toBe("Customer, 7.pdf");
  });

  it("sends an ASCII fallback plus the exact UTF-8 name", () => {
    const cd = attachmentDisposition("Café (NY), 12.pdf");
    expect(cd).toBe(
      `attachment; filename="Caf_ (NY), 12.pdf"; filename*=UTF-8''Caf%C3%A9%20%28NY%29%2C%2012.pdf`,
    );
  });
});
