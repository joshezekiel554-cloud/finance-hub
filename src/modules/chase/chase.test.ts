import { describe, expect, it, vi } from "vitest";
import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import {
  computeScore,
  computeSeverity,
  startOfDayUtc,
  tierForScore,
} from "./scoring.js";
import { blendedSeverity, blendedSeverityWithParts } from "./lookups.js";
import { computeOriginBalances } from "./balances.js";
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
    origin: "feldart",
    originSource: "prefix",
    disputeState: null,
    disputeClaimedAt: null,
    disputeNote: null,
    disputeUpdatedBy: null,
    bookkeeperThreadId: null,
    docNumber: "1001",
    issueDate: null,
    dueDate: null,
    total: "100.00",
    balance: "0.00",
    status: "paid",
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

  it("nets unapplied credits when credits equal overdue → severity zero", () => {
    const invoices = [
      makeInvoice({ balance: "1000.00", dueDate: daysAgo(45) }),
    ];
    const sev = computeSeverity(
      makeCustomer({
        overdueBalance: "1000.00",
        unappliedCreditBalance: "1000.00",
      }),
      invoices,
    );
    expect(sev.totalOverdue).toBe(0);
    expect(sev.score).toBe(0);
  });

  it("nets partial unapplied credits", () => {
    const invoices = [
      makeInvoice({ balance: "1000.00", dueDate: daysAgo(30) }),
    ];
    const sev = computeSeverity(
      makeCustomer({
        overdueBalance: "1000.00",
        unappliedCreditBalance: "400.00",
      }),
      invoices,
    );
    // effective overdue = 600; days = 30
    // score = 600 * min(30, 365) / 30 = 600
    expect(sev.totalOverdue).toBe(600);
    expect(sev.score).toBe(600);
  });
});

// ---------- blendedSeverity (audit #12) ----------

describe("blendedSeverity", () => {
  it("derives overdue from the invoice set, not a stale denormalized balance", () => {
    // Denormalized figure is stale at 2000; real exposure is Feldart 500 @ 10d
    // + TJ 15000 @ 180d = 15500 @ 180d.
    const customer = makeCustomer({ overdueBalance: "2000.00" });
    const invoices = [
      makeInvoice({
        id: "f1",
        origin: "feldart",
        balance: "500.00",
        dueDate: daysAgo(10),
      }),
      makeInvoice({
        id: "t1",
        origin: "tj",
        balance: "15000.00",
        dueDate: daysAgo(180),
      }),
    ];

    const sev = blendedSeverity(customer, invoices, { feldart: 0, tj: 0 });
    expect(sev.totalOverdue).toBe(15500);
    expect(sev.daysOverdue).toBe(180);
    // 15500 * 180/30 = 93000 → CRITICAL
    expect(sev.score).toBe(93_000);
    expect(sev.tier).toBe("CRITICAL");

    // Contrast: the old path (no override) trusted the stale 2000 and
    // under-tiered the account.
    const old = computeSeverity(customer, invoices);
    expect(old.totalOverdue).toBe(2000);
    expect(old.tier).not.toBe("CRITICAL");
  });

  it("nets TJ credit against the TJ portion only", () => {
    const customer = makeCustomer({ overdueBalance: "2000.00" });
    const invoices = [
      makeInvoice({
        id: "f1",
        origin: "feldart",
        balance: "500.00",
        dueDate: daysAgo(10),
      }),
      makeInvoice({
        id: "t1",
        origin: "tj",
        balance: "15000.00",
        dueDate: daysAgo(180),
      }),
    ];

    const sev = blendedSeverity(customer, invoices, { feldart: 0, tj: 5000 });
    // TJ netted to 10000 + Feldart 500 untouched.
    expect(sev.totalOverdue).toBe(10500);
    expect(sev.daysOverdue).toBe(180);
    expect(sev.tier).toBe("CRITICAL"); // 10500 * 180/30 = 63000
  });

  it("does not let Feldart credit bleed into the TJ portion (floors per origin)", () => {
    const customer = makeCustomer({ overdueBalance: "0.00" });
    const invoices = [
      makeInvoice({
        id: "f1",
        origin: "feldart",
        balance: "500.00",
        dueDate: daysAgo(10),
      }),
      makeInvoice({
        id: "t1",
        origin: "tj",
        balance: "15000.00",
        dueDate: daysAgo(180),
      }),
    ];

    // Feldart credit exceeds Feldart overdue — floors at 0, TJ stays whole.
    const sev = blendedSeverity(customer, invoices, { feldart: 600, tj: 0 });
    expect(sev.totalOverdue).toBe(15000);
  });

  it("treats an invoice due exactly today as NOT overdue (boundary aligned with scoring)", () => {
    // scoring.ts counts overdue with due < startOfDayUtc(today), so a
    // due-today invoice contributes daysOverdue = 0. The blended override
    // must use the same cutoff — otherwise totalOverdue > 0 pairs with
    // daysOverdue = 0 ⇒ score 0 with a positive amount shown.
    const customer = makeCustomer({ overdueBalance: "0.00" });
    const invoices = [
      makeInvoice({
        id: "f1",
        origin: "feldart",
        balance: "500.00",
        dueDate: daysAgo(10),
      }),
      makeInvoice({
        id: "t1",
        origin: "tj",
        balance: "15000.00",
        dueDate: daysAgo(0), // due today (UTC midnight)
      }),
    ];

    const sev = blendedSeverity(customer, invoices, { feldart: 0, tj: 0 });
    expect(sev.totalOverdue).toBe(500);
    expect(sev.daysOverdue).toBe(10);
  });

  it("excludes not-yet-due invoices from the blended overdue figure", () => {
    const future = new Date();
    future.setUTCHours(0, 0, 0, 0);
    future.setUTCDate(future.getUTCDate() + 30);
    const customer = makeCustomer({ overdueBalance: "9999.00" });
    const invoices = [
      makeInvoice({
        id: "f1",
        origin: "feldart",
        balance: "500.00",
        dueDate: daysAgo(10),
      }),
      makeInvoice({
        id: "t1",
        origin: "tj",
        balance: "15000.00",
        dueDate: future,
      }),
    ];

    const sev = blendedSeverity(customer, invoices, { feldart: 0, tj: 0 });
    expect(sev.totalOverdue).toBe(500);
    expect(sev.daysOverdue).toBe(10);
  });
});

// ---------- blendedSeverityWithParts (origin-split-2 §5) ----------

describe("blendedSeverityWithParts", () => {
  const customer = makeCustomer({ overdueBalance: "2000.00" });
  const invoices = [
    makeInvoice({
      id: "f1",
      origin: "feldart",
      balance: "500.00",
      dueDate: daysAgo(10),
    }),
    makeInvoice({
      id: "f2",
      origin: "feldart",
      balance: "250.00",
      dueDate: daysAgo(0), // due today — NOT overdue, excluded from parts
    }),
    makeInvoice({
      id: "t1",
      origin: "tj",
      balance: "15000.00",
      dueDate: daysAgo(180),
    }),
  ];
  const credit = { feldart: 100, tj: 5000 };

  it("exposes per-origin parts equal to computeOriginBalances output", () => {
    const { feldartOverdue, tjOverdue } = blendedSeverityWithParts(
      customer,
      invoices,
      credit,
    );

    const now = new Date();
    const balances = computeOriginBalances(
      invoices.map((i) => ({
        origin: i.origin,
        balance: i.balance,
        dueDate: i.dueDate,
      })),
      credit,
      now,
      startOfDayUtc(now),
    );
    expect(feldartOverdue).toBe(balances.feldart.overdue);
    expect(tjOverdue).toBe(balances.tj.overdue);
    // Concrete figures: Feldart 500 - 100 credit; TJ 15000 - 5000 credit.
    expect(feldartOverdue).toBe(400);
    expect(tjOverdue).toBe(10_000);
  });

  it("returns a severity identical to blendedSeverity (refactor changes nothing blended)", () => {
    const { severity, feldartOverdue, tjOverdue } = blendedSeverityWithParts(
      customer,
      invoices,
      credit,
    );
    expect(severity).toEqual(blendedSeverity(customer, invoices, credit));
    // The blended total is exactly the sum of the exposed parts.
    expect(severity.totalOverdue).toBe(feldartOverdue + tjOverdue);
    expect(severity.tier).toBe("CRITICAL"); // 10400 * 180/30 = 62400
    expect(severity.daysOverdue).toBe(180);
  });
});

// ---------- buildDailyDigest ----------

// Origin-aware loadOverdue stub: the default (daily) digest loads BOTH books
// separately ("feldart" main body, "tj" wind-down block).
function loadByOrigin(
  feldart: OverdueCustomer[],
  tj: OverdueCustomer[] = [],
): (origin?: "feldart" | "tj") => Promise<OverdueCustomer[]> {
  return async (origin?: "feldart" | "tj") =>
    origin === "tj" ? tj : feldart;
}

const emptyPipeline = {
  verifying: 0,
  awaitingFirstEmail: 0,
  silentThreads: 0,
};

function makeOverdueRow(
  overrides: Partial<OverdueCustomer> & { id?: string; name?: string } = {},
): OverdueCustomer {
  const id = overrides.id ?? "c1";
  return {
    customerId: id,
    customer: makeCustomer({ id, displayName: overrides.name ?? "Acme" }),
    invoices: [],
    severity: {
      score: 5000,
      tier: "MEDIUM",
      daysOverdue: 30,
      totalOverdue: 5000,
      oldestUnpaidDate: daysAgoIso(30),
    },
    ...overrides,
  };
}

describe("buildDailyDigest", () => {
  it("returns no-overdue error when nothing is open in either book", async () => {
    const generate: GenerateFn = vi.fn(async () => ({ digest: null, error: null }));
    const result = await buildDailyDigest({
      loadOverdue: loadByOrigin([], []),
      loadDisputePipeline: async () => emptyPipeline,
      generateDigest: generate,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(result.digest).toBeNull();
    expect(result.accounts).toEqual([]);
    expect(result.tjAccounts).toEqual([]);
    expect(result.error).toBe("No overdue customers");
  });

  it("orchestrates lookup → top-N slice → AI call and returns digest", async () => {
    const fakeRow = makeOverdueRow({
      id: "c1",
      name: "Acme",
      customer: makeCustomer({
        id: "c1",
        displayName: "Acme",
        balance: "12345.67",
        overdueBalance: "5000.00",
      }),
    });
    const generate: GenerateFn = vi.fn(async () => ({
      digest: "AI digest body",
      error: null,
    }));
    const result = await buildDailyDigest({
      topN: 5,
      userId: "user-1",
      loadOverdue: loadByOrigin([fakeRow]),
      loadDisputePipeline: async () => emptyPipeline,
      generateDigest: generate,
    });

    expect(result.digest).toBe("AI digest body");
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.name).toBe("Acme");
    expect(result.accounts[0]?.tier).toBe("MEDIUM");
    expect(generate).toHaveBeenCalledTimes(1);
    // No TJ rows + zero pipeline → no TJ block sent to the AI.
    expect(generate).toHaveBeenCalledWith(expect.any(Array), {
      userId: "user-1",
      tj: null,
    });
  });

  it("propagates AI errors without throwing", async () => {
    const fakeRow = makeOverdueRow({
      severity: {
        score: 100,
        tier: "LOW",
        daysOverdue: 5,
        totalOverdue: 100,
        oldestUnpaidDate: daysAgoIso(5),
      },
    });
    const result = await buildDailyDigest({
      loadOverdue: loadByOrigin([fakeRow]),
      loadDisputePipeline: async () => emptyPipeline,
      generateDigest: async () => ({ digest: null, error: "API key missing" }),
    });
    expect(result.digest).toBeNull();
    expect(result.error).toBe("API key missing");
    expect(result.accounts).toHaveLength(1);
  });

  it("slices to topN before passing to AI", async () => {
    const rows: OverdueCustomer[] = Array.from({ length: 10 }).map((_, i) =>
      makeOverdueRow({
        id: `c${i}`,
        name: `Cust ${i}`,
        severity: {
          score: 1000 - i,
          tier: "LOW",
          daysOverdue: 5,
          totalOverdue: 1000 - i,
          oldestUnpaidDate: daysAgoIso(5),
        },
      }),
    );
    const generate: GenerateFn = vi.fn(async () => ({ digest: "ok", error: null }));
    const result = await buildDailyDigest({
      topN: 3,
      loadOverdue: loadByOrigin(rows),
      loadDisputePipeline: async () => emptyPipeline,
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

  it("TJ rows present → AI receives a separate TJ block with accounts + pipeline", async () => {
    const feldartRow = makeOverdueRow({ id: "f1", name: "Feldart Cust" });
    const tjRow = makeOverdueRow({
      id: "t1",
      name: "TJ Cust",
      severity: {
        score: 9000,
        tier: "HIGH",
        daysOverdue: 90,
        totalOverdue: 9000,
        oldestUnpaidDate: daysAgoIso(90),
      },
    });
    const pipeline = { verifying: 3, awaitingFirstEmail: 1, silentThreads: 2 };
    const generate: GenerateFn = vi.fn(async () => ({ digest: "ok", error: null }));

    const result = await buildDailyDigest({
      loadOverdue: loadByOrigin([feldartRow], [tjRow]),
      loadDisputePipeline: async () => pipeline,
      generateDigest: generate,
    });

    // Feldart main body unchanged; TJ rides along in its own block.
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.name).toBe("Feldart Cust");
    expect(result.tjAccounts).toHaveLength(1);
    expect(result.tjAccounts[0]?.name).toBe("TJ Cust");
    expect(result.tjOverdueCustomers).toHaveLength(1);
    expect(result.disputePipeline).toEqual(pipeline);
    expect(generate).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "Feldart Cust" })],
      {
        userId: null,
        tj: {
          accounts: [expect.objectContaining({ name: "TJ Cust", tier: "HIGH" })],
          pipeline,
        },
      },
    );
  });

  it("dispute pipeline alone (no TJ severity rows) still produces a TJ block", async () => {
    // All TJ invoices verifying → excluded from severity, but the digest
    // must still surface the dispute pipeline.
    const feldartRow = makeOverdueRow({ id: "f1", name: "Feldart Cust" });
    const pipeline = { verifying: 2, awaitingFirstEmail: 2, silentThreads: 0 };
    const generate: GenerateFn = vi.fn(async () => ({ digest: "ok", error: null }));

    await buildDailyDigest({
      loadOverdue: loadByOrigin([feldartRow], []),
      loadDisputePipeline: async () => pipeline,
      generateDigest: generate,
    });

    expect(generate).toHaveBeenCalledWith(expect.any(Array), {
      userId: null,
      tj: { accounts: [], pipeline },
    });
  });

  it("TJ-only state (Feldart clear) still generates a digest", async () => {
    const tjRow = makeOverdueRow({ id: "t1", name: "TJ Cust" });
    const generate: GenerateFn = vi.fn(async () => ({
      digest: "tj only digest",
      error: null,
    }));
    const result = await buildDailyDigest({
      loadOverdue: loadByOrigin([], [tjRow]),
      loadDisputePipeline: async () => emptyPipeline,
      generateDigest: generate,
    });
    expect(result.digest).toBe("tj only digest");
    expect(result.accounts).toEqual([]);
    expect(result.tjAccounts).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("origin-scoped digest skips the TJ section + pipeline entirely", async () => {
    const tjRow = makeOverdueRow({ id: "t1", name: "TJ Cust" });
    const loadDisputePipeline = vi.fn(async () => emptyPipeline);
    const generate: GenerateFn = vi.fn(async () => ({ digest: "ok", error: null }));

    const result = await buildDailyDigest({
      origin: "tj",
      loadOverdue: async (origin) => (origin === "tj" ? [tjRow] : []),
      loadDisputePipeline,
      generateDigest: generate,
    });

    expect(loadDisputePipeline).not.toHaveBeenCalled();
    expect(result.accounts).toHaveLength(1);
    expect(result.tjAccounts).toEqual([]);
    expect(result.disputePipeline).toBeNull();
    // Single-book call shape — no tj key (pre-W2 behaviour).
    expect(generate).toHaveBeenCalledWith(expect.any(Array), { userId: null });
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
