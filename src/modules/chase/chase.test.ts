import { describe, expect, it, vi } from "vitest";
import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import { computeScore, computeSeverity, tierForScore } from "./scoring.js";
import { buildDailyDigest, toChaseAccount } from "./digest.js";
import type { generateChaseDigest } from "../../integrations/anthropic/chase-digest.js";
import type { OverdueCustomer } from "./types.js";

type GenerateFn = typeof generateChaseDigest;

// ---------- helpers ----------

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  const now = new Date();
  return {
    id: "cust-test",
    qbCustomerId: "QB-1",
    displayName: "Test Customer",
    primaryEmail: "test@example.com",
    billingEmails: null,
    phone: null,
    paymentTerms: "Net 30",
    holdStatus: "active",
    shopifyCustomerId: null,
    mondayItemId: null,
    customerType: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingAddressCity: null,
    billingAddressRegion: null,
    billingAddressPostal: null,
    billingAddressCountry: null,
    balance: "1000.00",
    overdueBalance: "0.00",
    internalNotes: null,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date();
  return {
    id: "inv-test",
    qbInvoiceId: "QB-INV-1",
    customerId: "cust-test",
    docNumber: "1001",
    issueDate: null,
    dueDate: null,
    total: "100.00",
    balance: "0.00",
    status: "paid",
    sentAt: null,
    sentVia: null,
    syncToken: "0",
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function daysAgoIso(n: number): string {
  return daysAgo(n).toISOString().slice(0, 10);
}

// ---------- computeScore ----------

describe("computeScore", () => {
  it("returns 0 when overdue is 0", () => {
    expect(computeScore(0, 60)).toBe(0);
  });

  it("returns 0 for negative overdue (credit balance)", () => {
    expect(computeScore(-500, 60)).toBe(0);
  });

  it("returns 0 at boundary day 0", () => {
    expect(computeScore(10000, 0)).toBe(0);
  });

  it("scales linearly under the 30-day pivot", () => {
    // 6000 * 15/30 = 3000
    expect(computeScore(6000, 15)).toBe(3000);
  });

  it("equals overdue at exactly 30 days (formula pivot)", () => {
    expect(computeScore(6000, 30)).toBe(6000);
  });

  it("just-below-pivot at 29 days produces fractional rounding", () => {
    // 6000 * 29/30 = 5800
    expect(computeScore(6000, 29)).toBe(5800);
  });

  it("caps days at 365 — 365 and 366 produce identical scores", () => {
    expect(computeScore(3000, 365)).toBe(computeScore(3000, 366));
  });

  it("does not exceed the 365-day cap for very stale debt", () => {
    // 3000 * 365/30 = 36500
    expect(computeScore(3000, 5_000)).toBe(36500);
  });

  it("clamps negative daysOverdue to 0", () => {
    expect(computeScore(10_000, -10)).toBe(0);
  });
});

// ---------- tierForScore ----------

describe("tierForScore", () => {
  it("LOW below 5000", () => {
    expect(tierForScore(0)).toBe("LOW");
    expect(tierForScore(4999)).toBe("LOW");
  });

  it("MEDIUM at 5000 boundary", () => {
    expect(tierForScore(5000)).toBe("MEDIUM");
    expect(tierForScore(19_999)).toBe("MEDIUM");
  });

  it("HIGH at 20000 boundary", () => {
    expect(tierForScore(20_000)).toBe("HIGH");
    expect(tierForScore(49_999)).toBe("HIGH");
  });

  it("CRITICAL at 50000 boundary", () => {
    expect(tierForScore(50_000)).toBe("CRITICAL");
    expect(tierForScore(1_000_000)).toBe("CRITICAL");
  });
});

// ---------- computeSeverity ----------

describe("computeSeverity", () => {
  it("returns zeros for an empty invoice list", () => {
    const sev = computeSeverity(makeCustomer(), []);
    expect(sev.score).toBe(0);
    expect(sev.tier).toBe("LOW");
    expect(sev.daysOverdue).toBe(0);
    expect(sev.totalOverdue).toBe(0);
    expect(sev.oldestUnpaidDate).toBeNull();
  });

  it("ignores invoices with zero or negative balance", () => {
    const invoices = [
      makeInvoice({ balance: "0.00", dueDate: daysAgo(60) }),
      makeInvoice({ balance: "-50.00", dueDate: daysAgo(60) }),
    ];
    const sev = computeSeverity(makeCustomer(), invoices);
    expect(sev.totalOverdue).toBe(0);
    expect(sev.daysOverdue).toBe(0);
    expect(sev.oldestUnpaidDate).toBeNull();
  });

  it("ignores invoices not yet past due", () => {
    const future = new Date();
    future.setUTCHours(0, 0, 0, 0);
    future.setUTCDate(future.getUTCDate() + 10);
    const invoices = [makeInvoice({ balance: "5000.00", dueDate: future })];
    const sev = computeSeverity(
      makeCustomer({ overdueBalance: "0.00" }),
      invoices,
    );
    expect(sev.totalOverdue).toBe(0);
    expect(sev.score).toBe(0);
  });

  it("picks oldest unpaid invoice as the days-overdue anchor", () => {
    const invoices = [
      makeInvoice({ id: "i1", balance: "1000.00", dueDate: daysAgo(10) }),
      makeInvoice({ id: "i2", balance: "1000.00", dueDate: daysAgo(60) }),
      makeInvoice({ id: "i3", balance: "1000.00", dueDate: daysAgo(30) }),
    ];
    const sev = computeSeverity(
      makeCustomer({ overdueBalance: "3000.00" }),
      invoices,
    );
    expect(sev.daysOverdue).toBe(60);
    expect(sev.oldestUnpaidDate).toBe(daysAgoIso(60));
  });

  it("prefers denormalized customer overdueBalance over invoice sum", () => {
    const invoices = [
      makeInvoice({ balance: "100.00", dueDate: daysAgo(45) }),
    ];
    const sev = computeSeverity(
      makeCustomer({ overdueBalance: "5000.00" }),
      invoices,
    );
    // Denormalized 5000 wins over sum-of-invoices 100
    expect(sev.totalOverdue).toBe(5000);
  });

  it("falls back to invoice sum when overdueBalance is 0", () => {
    const invoices = [
      makeInvoice({ balance: "750.00", dueDate: daysAgo(40) }),
      makeInvoice({ balance: "250.00", dueDate: daysAgo(20) }),
    ];
    const sev = computeSeverity(
      makeCustomer({ overdueBalance: "0.00" }),
      invoices,
    );
    expect(sev.totalOverdue).toBe(1000);
  });

  it("produces a CRITICAL tier for a large, aged account", () => {
    const invoices = [
      makeInvoice({ balance: "60000.00", dueDate: daysAgo(120) }),
    ];
    const sev = computeSeverity(
      makeCustomer({ overdueBalance: "60000.00" }),
      invoices,
    );
    // 60000 * 120/30 = 240000 → CRITICAL
    expect(sev.score).toBe(240_000);
    expect(sev.tier).toBe("CRITICAL");
  });

  it("produces LOW tier for small, recently-overdue account", () => {
    const invoices = [
      makeInvoice({ balance: "200.00", dueDate: daysAgo(5) }),
    ];
    const sev = computeSeverity(
      makeCustomer({ overdueBalance: "200.00" }),
      invoices,
    );
    // 200 * 5/30 ≈ 33 → LOW
    expect(sev.tier).toBe("LOW");
  });
});

// ---------- buildDailyDigest ----------

describe("buildDailyDigest", () => {
  it("returns no-overdue error when nothing is open", async () => {
    const generate: GenerateFn = vi.fn(async () => ({ digest: null, error: null }));
    const result = await buildDailyDigest({
      loadOverdue: async () => [],
      generateDigest: generate,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(result.digest).toBeNull();
    expect(result.accounts).toEqual([]);
    expect(result.error).toBe("No overdue customers");
  });

  it("orchestrates lookup → top-N slice → AI call and returns digest", async () => {
    const fakeRow: OverdueCustomer = {
      customerId: "c1",
      customer: makeCustomer({
        id: "c1",
        displayName: "Acme",
        balance: "12345.67",
        overdueBalance: "5000.00",
      }),
      invoices: [],
      severity: {
        score: 5000,
        tier: "MEDIUM",
        daysOverdue: 30,
        totalOverdue: 5000,
        oldestUnpaidDate: daysAgoIso(30),
      },
    };
    const generate: GenerateFn = vi.fn(async () => ({
      digest: "AI digest body",
      error: null,
    }));
    const result = await buildDailyDigest({
      topN: 5,
      userId: "user-1",
      loadOverdue: async () => [fakeRow],
      generateDigest: generate,
    });

    expect(result.digest).toBe("AI digest body");
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.name).toBe("Acme");
    expect(result.accounts[0]?.tier).toBe("MEDIUM");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.any(Array), { userId: "user-1" });
  });

  it("propagates AI errors without throwing", async () => {
    const fakeRow: OverdueCustomer = {
      customerId: "c1",
      customer: makeCustomer({ id: "c1" }),
      invoices: [],
      severity: {
        score: 100,
        tier: "LOW",
        daysOverdue: 5,
        totalOverdue: 100,
        oldestUnpaidDate: daysAgoIso(5),
      },
    };
    const result = await buildDailyDigest({
      loadOverdue: async () => [fakeRow],
      generateDigest: async () => ({ digest: null, error: "API key missing" }),
    });
    expect(result.digest).toBeNull();
    expect(result.error).toBe("API key missing");
    expect(result.accounts).toHaveLength(1);
  });

  it("slices to topN before passing to AI", async () => {
    const rows: OverdueCustomer[] = Array.from({ length: 10 }).map((_, i) => ({
      customerId: `c${i}`,
      customer: makeCustomer({ id: `c${i}`, displayName: `Cust ${i}` }),
      invoices: [],
      severity: {
        score: 1000 - i,
        tier: "LOW",
        daysOverdue: 5,
        totalOverdue: 1000 - i,
        oldestUnpaidDate: daysAgoIso(5),
      },
    }));
    const generate: GenerateFn = vi.fn(async () => ({ digest: "ok", error: null }));
    const result = await buildDailyDigest({
      topN: 3,
      loadOverdue: async () => rows,
      generateDigest: generate,
    });
    expect(result.accounts).toHaveLength(3);
    expect(result.overdueCustomers).toHaveLength(10);
    expect(generate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "Cust 0" })]),
      expect.any(Object),
    );
    const firstArg = (generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(firstArg).toHaveLength(3);
  });
});

// ---------- toChaseAccount ----------

describe("toChaseAccount", () => {
  it("maps DB shape to anthropic ChaseAccount contract", () => {
    const row: OverdueCustomer = {
      customerId: "c1",
      customer: makeCustomer({
        id: "c1",
        displayName: "Bob's Bricks",
        balance: "9999.99",
        holdStatus: "hold",
      }),
      invoices: [],
      severity: {
        score: 21_000,
        tier: "HIGH",
        daysOverdue: 75,
        totalOverdue: 8400,
        oldestUnpaidDate: "2026-01-15",
      },
    };
    const account = toChaseAccount(row);
    expect(account.name).toBe("Bob's Bricks");
    expect(account.tier).toBe("HIGH");
    expect(account.score).toBe(21_000);
    expect(account.overdue_balance).toBe(8400);
    expect(account.current_balance).toBe(9999.99);
    expect(account.days_overdue).toBe(75);
    expect(account.oldest_unpaid_invoice).toBe("2026-01-15");
    expect(account.hold_status).toBe("hold");
  });
});
