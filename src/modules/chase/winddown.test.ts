import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import type { OverdueCustomer, Severity } from "./types.js";
import {
  getTjWinddown,
  resetSnapshotUpsertThrottle,
  type TjInvoiceRow,
  type WinddownDeps,
} from "./winddown.js";

// The snapshot-write throttle is a module-level memo — clear it so each test
// observes its own upsert behaviour.
beforeEach(() => {
  resetSnapshotUpsertThrottle();
});

// ---------- helpers ----------

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  const now = new Date();
  return {
    id: "cust-test",
    qbCustomerId: "QB-1",
    displayName: "Test Customer",
    primaryEmail: "test@example.com",
    billingEmails: null,
    invoiceToEmails: null,
    invoiceCcEmails: null,
    invoiceBccEmails: null,
    statementToEmails: null,
    statementCcEmails: null,
    statementBccEmails: null,
    tags: null,
    phone: null,
    additionalPhones: null,
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
    unappliedCreditBalance: "0.00",
    internalNotes: null,
    aiCustomerContext: null,
    lastSyncedAt: now,
    vocatechLastPushedAt: null,
    agentModeExcluded: false,
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
    origin: "tj",
    originSource: "prefix",
    disputeState: null,
    disputeClaimedAt: null,
    disputeNote: null,
    disputeUpdatedBy: null,
    bookkeeperThreadId: null,
    docNumber: "2001",
    issueDate: null,
    dueDate: null,
    total: "100.00",
    balance: "0.00",
    status: "sent",
    sentAt: null,
    sentVia: null,
    customerMemo: null,
    syncToken: "0",
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function tjRow(
  invoice: Partial<Invoice>,
  customerName = "Test Customer",
  primaryEmail: string | null = "test@example.com",
): TjInvoiceRow {
  return { invoice: makeInvoice(invoice), customerName, primaryEmail };
}

function makeSeverity(overrides: Partial<Severity> = {}): Severity {
  return {
    score: 0,
    tier: "LOW",
    daysOverdue: 0,
    totalOverdue: 0,
    oldestUnpaidDate: null,
    ...overrides,
  };
}

function makeOverdueRow(
  customerId: string,
  severity: Partial<Severity>,
): OverdueCustomer {
  return {
    customerId,
    customer: makeCustomer({ id: customerId }),
    invoices: [],
    severity: makeSeverity(severity),
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

// Base deps: no overdue rows, no credit, no prior snapshot, snapshot write is
// a spy-able no-op. Every test overrides what it cares about.
function makeDeps(overrides: Partial<WinddownDeps> = {}): WinddownDeps {
  return {
    loadOverdue: async () => [],
    loadTjInvoices: async () => [],
    loadTjCredit: async () => new Map(),
    upsertSnapshot: async () => {},
    loadDeltaSnapshot: async () => null,
    ...overrides,
  };
}

// ---------- exposure ----------

describe("getTjWinddown — exposure", () => {
  it("sums per-customer net TJ (credit netted per customer, floored at 0), verifying included", async () => {
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          // Customer A: 1000 overdue + 500 verifying — verifying still counts
          // as money owed. Credit 200 nets A to 1300.
          tjRow({ id: "a1", customerId: "ca", balance: "1000.00", dueDate: daysAgo(100) }, "A"),
          tjRow(
            {
              id: "a2",
              customerId: "ca",
              balance: "500.00",
              dueDate: daysAgo(30),
              disputeState: "verifying",
            },
            "A",
          ),
          // Customer B: 400 owed but 1000 credit — floors at 0, never negative.
          tjRow({ id: "b1", customerId: "cb", balance: "400.00", dueDate: daysAgo(50) }, "B"),
        ],
        loadTjCredit: async () =>
          new Map([
            ["ca", 200],
            ["cb", 1000],
          ]),
      }),
    );

    expect(result.exposure).toBe(1300);
  });

  it("includes not-yet-due TJ balances in exposure but in no overdue bucket", async () => {
    const future = daysAgo(-30); // due in 30 days
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({ id: "i1", customerId: "ca", balance: "300.00", dueDate: future }),
        ],
      }),
    );

    expect(result.exposure).toBe(300);
    expect(result.buckets).toEqual({ b90: 0, b180: 0, bOver: 0 });
  });

  it("returns zero exposure and empty customers when there are no open TJ invoices", async () => {
    const result = await getTjWinddown(makeDeps());
    expect(result.exposure).toBe(0);
    expect(result.customers).toEqual([]);
    expect(result.verifyingCount).toBe(0);
    expect(result.buckets).toEqual({ b90: 0, b180: 0, bOver: 0 });
  });
});

// ---------- aging buckets ----------

describe("getTjWinddown — aging buckets", () => {
  it("buckets net invoice balances by days overdue: <90 / 90–180 / >180", async () => {
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({ id: "i1", customerId: "ca", balance: "100.00", dueDate: daysAgo(10) }),
          tjRow({ id: "i2", customerId: "ca", balance: "200.00", dueDate: daysAgo(89) }),
          tjRow({ id: "i3", customerId: "ca", balance: "400.00", dueDate: daysAgo(90) }),
          tjRow({ id: "i4", customerId: "ca", balance: "800.00", dueDate: daysAgo(180) }),
          tjRow({ id: "i5", customerId: "ca", balance: "1600.00", dueDate: daysAgo(181) }),
        ],
      }),
    );

    expect(result.buckets).toEqual({
      b90: 300, // 10d + 89d
      b180: 1200, // 90d + 180d (boundaries inclusive)
      bOver: 1600, // 181d+
    });
  });

  it("treats an invoice due exactly today as NOT overdue (startOfDayUtc convention)", async () => {
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({ id: "i1", customerId: "ca", balance: "500.00", dueDate: daysAgo(0) }),
        ],
      }),
    );

    expect(result.exposure).toBe(500); // still owed
    expect(result.buckets).toEqual({ b90: 0, b180: 0, bOver: 0 });
  });

  it("includes verifying invoices in the buckets (money owed regardless of dispute)", async () => {
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({
            id: "i1",
            customerId: "ca",
            balance: "750.00",
            dueDate: daysAgo(120),
            disputeState: "verifying",
          }),
        ],
      }),
    );

    expect(result.buckets.b180).toBe(750);
  });
});

// ---------- verifying count ----------

describe("getTjWinddown — verifyingCount", () => {
  it("counts only open invoices in disputeState='verifying'", async () => {
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({
            id: "i1",
            customerId: "ca",
            balance: "100.00",
            dueDate: daysAgo(40),
            disputeState: "verifying",
          }),
          tjRow({
            id: "i2",
            customerId: "ca",
            balance: "100.00",
            dueDate: daysAgo(40),
            disputeState: "confirmed_unpaid",
          }),
          tjRow({ id: "i3", customerId: "ca", balance: "100.00", dueDate: daysAgo(40) }),
          tjRow({
            id: "i4",
            customerId: "cb",
            balance: "100.00",
            dueDate: daysAgo(40),
            disputeState: "verifying",
          }),
        ],
      }),
    );

    expect(result.verifyingCount).toBe(2);
  });
});

// ---------- snapshot + delta ----------

describe("getTjWinddown — snapshot upsert + deltaVs28d", () => {
  it("upserts today's snapshot with the computed exposure on every call", async () => {
    const upsertSnapshot = vi.fn(async () => {});
    await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({ id: "i1", customerId: "ca", balance: "1234.56", dueDate: daysAgo(40) }),
        ],
        upsertSnapshot,
      }),
    );

    expect(upsertSnapshot).toHaveBeenCalledTimes(1);
    expect(upsertSnapshot).toHaveBeenCalledWith(daysAgoIso(0), 1234.56);
  });

  it("skips the upsert when one already succeeded for today within the last 15 minutes", async () => {
    const upsertSnapshot = vi.fn(async () => {});
    const deps = makeDeps({
      loadTjInvoices: async () => [
        tjRow({ id: "i1", customerId: "ca", balance: "1000.00", dueDate: daysAgo(40) }),
      ],
      upsertSnapshot,
    });

    await getTjWinddown(deps);
    await getTjWinddown(deps);

    expect(upsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it("upserts again once the 15-minute window has passed (same day)", async () => {
    const upsertSnapshot = vi.fn(async () => {});
    // Anchor both calls to today at 02:00 UTC so +16min stays the same day.
    const t0 = new Date(daysAgo(0).getTime() + 2 * 60 * 60 * 1000);
    const t1 = new Date(t0.getTime() + 16 * 60 * 1000);
    const deps = {
      loadTjInvoices: async () => [
        tjRow({ id: "i1", customerId: "ca", balance: "1000.00", dueDate: daysAgo(40) }),
      ],
      upsertSnapshot,
    };

    await getTjWinddown(makeDeps({ ...deps, now: t0 }));
    await getTjWinddown(makeDeps({ ...deps, now: t1 }));

    expect(upsertSnapshot).toHaveBeenCalledTimes(2);
  });

  it("retries the upsert on the next call when the previous write threw", async () => {
    const upsertSnapshot = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("db down"));
    const deps = makeDeps({
      loadTjInvoices: async () => [
        tjRow({ id: "i1", customerId: "ca", balance: "1000.00", dueDate: daysAgo(40) }),
      ],
      upsertSnapshot,
    });

    await expect(getTjWinddown(deps)).rejects.toThrow("db down");
    await getTjWinddown(deps); // failure must not have armed the throttle

    expect(upsertSnapshot).toHaveBeenCalledTimes(2);
  });

  it("returns deltaVs28d + baselineDate = null when no snapshot is ≥28 days old", async () => {
    const loadDeltaSnapshot = vi.fn(async () => null);
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({ id: "i1", customerId: "ca", balance: "1000.00", dueDate: daysAgo(40) }),
        ],
        loadDeltaSnapshot,
      }),
    );

    expect(result.deltaVs28d).toBeNull();
    expect(result.baselineDate).toBeNull();
    // Cutoff passed to the lookup is today − 28d.
    expect(loadDeltaSnapshot).toHaveBeenCalledWith(daysAgoIso(28));
  });

  it("returns today's exposure minus the baseline snapshot exposure, plus the baseline's date", async () => {
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({ id: "i1", customerId: "ca", balance: "1300.00", dueDate: daysAgo(40) }),
        ],
        loadDeltaSnapshot: async () => ({ snapDate: daysAgoIso(31), exposure: 2000 }),
      }),
    );

    // Wind-down going the right way: 1300 − 2000 = −700.
    expect(result.deltaVs28d).toBe(-700);
    expect(result.baselineDate).toBe(daysAgoIso(31));
  });
});

// ---------- customer rows ----------

describe("getTjWinddown — customer rows", () => {
  it("carries netOwed, openCount, tier and suggested level from the TJ severity path", async () => {
    const result = await getTjWinddown(
      makeDeps({
        loadOverdue: async () => [
          makeOverdueRow("ca", {
            tier: "CRITICAL",
            score: 60000,
            daysOverdue: 200,
            totalOverdue: 9800,
          }),
        ],
        loadTjInvoices: async () => [
          tjRow({ id: "i1", customerId: "ca", balance: "10000.00", dueDate: daysAgo(200) }, "Acme", "acme@x.com"),
        ],
        loadTjCredit: async () => new Map([["ca", 200]]),
      }),
    );

    expect(result.customers).toHaveLength(1);
    const row = result.customers[0];
    expect(row?.customerId).toBe("ca");
    expect(row?.customerName).toBe("Acme");
    expect(row?.primaryEmail).toBe("acme@x.com");
    expect(row?.netOwed).toBe(9800);
    expect(row?.openCount).toBe(1);
    expect(row?.tier).toBe("CRITICAL");
    expect(row?.suggestedLevel).toBe(3);
    expect(row?.daysOverdue).toBe(200);
  });

  it("maps tier → chase level like the chase_l*/tj_l* templates (MEDIUM→1, HIGH→2, CRITICAL→3, LOW→1)", async () => {
    const cases: Array<["LOW" | "MEDIUM" | "HIGH" | "CRITICAL", 1 | 2 | 3]> = [
      ["LOW", 1],
      ["MEDIUM", 1],
      ["HIGH", 2],
      ["CRITICAL", 3],
    ];
    for (const [tier, level] of cases) {
      const result = await getTjWinddown(
        makeDeps({
          loadOverdue: async () => [
            makeOverdueRow("ca", { tier, score: 1, daysOverdue: 10, totalOverdue: 100 }),
          ],
          loadTjInvoices: async () => [
            tjRow({ id: "i1", customerId: "ca", balance: "100.00", dueDate: daysAgo(10) }),
          ],
        }),
      );
      expect(result.customers[0]?.tier).toBe(tier);
      expect(result.customers[0]?.suggestedLevel).toBe(level);
    }
  });

  it("defaults customers outside the actionable-overdue set to LOW / level 1 (e.g. verifying-only)", async () => {
    // All this customer's TJ invoices are parked verifying, so the chase
    // lookup (which excludes verifying) returns nothing — the row must still
    // appear so the dispute loop is operable from the panel.
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({
            id: "i1",
            customerId: "ca",
            balance: "900.00",
            dueDate: daysAgo(95),
            disputeState: "verifying",
          }),
        ],
      }),
    );

    expect(result.customers).toHaveLength(1);
    expect(result.customers[0]?.tier).toBe("LOW");
    expect(result.customers[0]?.suggestedLevel).toBe(1);
    expect(result.customers[0]?.daysOverdue).toBe(0);
    expect(result.customers[0]?.netOwed).toBe(900);
    expect(result.verifyingCount).toBe(1);
  });

  it("embeds per-invoice rows (dispute fields included) and dispute chips", async () => {
    const claimedAt = new Date("2026-06-02T10:00:00.000Z");
    const result = await getTjWinddown(
      makeDeps({
        loadTjInvoices: async () => [
          tjRow({
            id: "i1",
            customerId: "ca",
            docNumber: "2042",
            balance: "450.00",
            dueDate: daysAgo(100),
            disputeState: "verifying",
            disputeClaimedAt: claimedAt,
            disputeNote: "says paid by cheque in March",
          }),
          tjRow({
            id: "i2",
            customerId: "ca",
            docNumber: "2050",
            balance: "550.00",
            dueDate: daysAgo(10),
          }),
        ],
      }),
    );

    const row = result.customers[0];
    expect(row?.openCount).toBe(2);
    expect(row?.invoices).toEqual([
      // Oldest due date first.
      {
        id: "i1",
        docNumber: "2042",
        balance: 450,
        dueDate: daysAgoIso(100),
        daysOverdue: 100,
        disputeState: "verifying",
        disputeClaimedAt: claimedAt.toISOString(),
        disputeNote: "says paid by cheque in March",
      },
      {
        id: "i2",
        docNumber: "2050",
        balance: 550,
        dueDate: daysAgoIso(10),
        daysOverdue: 10,
        disputeState: null,
        disputeClaimedAt: null,
        disputeNote: null,
      },
    ]);
    expect(row?.disputeChips).toEqual([
      { invoiceId: "i1", docNumber: "2042", state: "verifying" },
    ]);
  });

  it("orders customers by severity score desc, unscored ones after by netOwed desc", async () => {
    const result = await getTjWinddown(
      makeDeps({
        loadOverdue: async () => [
          makeOverdueRow("hot", { tier: "HIGH", score: 30000, daysOverdue: 90, totalOverdue: 10000 }),
          makeOverdueRow("warm", { tier: "MEDIUM", score: 6000, daysOverdue: 40, totalOverdue: 4500 }),
        ],
        loadTjInvoices: async () => [
          tjRow({ id: "i1", customerId: "warm", balance: "4500.00", dueDate: daysAgo(40) }, "Warm"),
          tjRow({ id: "i2", customerId: "small-future", balance: "100.00", dueDate: daysAgo(-20) }, "Small Future"),
          tjRow({ id: "i3", customerId: "hot", balance: "10000.00", dueDate: daysAgo(90) }, "Hot"),
          tjRow(
            {
              id: "i4",
              customerId: "big-verifying",
              balance: "5000.00",
              dueDate: daysAgo(60),
              disputeState: "verifying",
            },
            "Big Verifying",
          ),
        ],
      }),
    );

    expect(result.customers.map((c) => c.customerId)).toEqual([
      "hot",
      "warm",
      "big-verifying",
      "small-future",
    ]);
  });
});
