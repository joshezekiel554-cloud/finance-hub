import { describe, expect, it } from "vitest";
import {
  agedDebtorsQuerySchema,
  customersQuerySchema,
  openInvoicesQuerySchema,
  returnsQuerySchema,
} from "./ext-reports.js";
import { checkHubServiceAuth } from "../lib/hub-service-auth.js";
import { mintHubToken } from "../../lib/hub-token.js";

// Schema-level route tests (no Fastify harness in repo — the handlers
// 400 on safeParse failure, so the schema IS the rejection contract).

describe("ext reports query schemas", () => {
  it("returns: needs a valid inclusive date range, defaults to the rmas view", () => {
    const ok = returnsQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-01" });
    expect(ok.success && ok.data.view).toBe("rmas");
    expect(returnsQuerySchema.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
    expect(returnsQuerySchema.safeParse({ from: "2026-13-40", to: "2026-10-01" }).success).toBe(false);
    expect(returnsQuerySchema.safeParse({ from: "1/10/2026", to: "2026-10-01" }).success).toBe(false);
    expect(returnsQuerySchema.safeParse({ to: "2026-10-01" }).success).toBe(false);
    expect(
      returnsQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-31", view: "csv" }).success,
    ).toBe(false);
  });

  it("open-invoices: customerId required, book defaults to both", () => {
    expect(openInvoicesQuerySchema.safeParse({}).success).toBe(false);
    const ok = openInvoicesQuerySchema.safeParse({ customerId: "c1" });
    expect(ok.success && ok.data.book).toBe("both");
    expect(openInvoicesQuerySchema.safeParse({ customerId: "c1", book: "x" }).success).toBe(false);
  });

  it("aged-debtors: book optional", () => {
    const ok = agedDebtorsQuerySchema.safeParse({});
    expect(ok.success && ok.data.book).toBe("both");
    expect(agedDebtorsQuerySchema.safeParse({ book: "tj" }).success).toBe(true);
  });

  it("customers: needs a non-blank query", () => {
    expect(customersQuerySchema.safeParse({ q: "  " }).success).toBe(false);
    expect(customersQuerySchema.safeParse({ q: "acme" }).success).toBe(true);
  });
});

describe("hub service auth", () => {
  const secret = "s3cret";
  const now = 1_800_000_000;
  const opts = { secret, allowedEmails: "staff@feldart.com, boss@feldart.com", nowSeconds: now };
  const mint = (over: Partial<Parameters<typeof mintHubToken>[0]> = {}) =>
    `Bearer ${mintHubToken({ email: "Staff@Feldart.com", aud: "finance", ttlSeconds: 60, secret, nowSeconds: now, scope: "service", ...over })}`;

  it("accepts a staff service token and lowercases the actor", () => {
    const r = checkHubServiceAuth(mint(), opts);
    expect(r).toMatchObject({ ok: true, claims: { email: "staff@feldart.com", scope: "service" } });
  });

  it("refuses user-scope, wrong-aud, expired and missing tokens with 401", () => {
    for (const header of [
      mint({ scope: "user" }),
      mint({ aud: "internal" }),
      mint({ nowSeconds: now - 120 }),
      undefined,
      "Basic abc",
    ]) {
      expect(checkHubServiceAuth(header, opts)).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("refuses non-staff (guests) with 403 and an unconfigured hub with 503", () => {
    expect(checkHubServiceAuth(mint({ email: "guest@gmail.com" }), opts)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(checkHubServiceAuth(mint(), { ...opts, secret: undefined })).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});
