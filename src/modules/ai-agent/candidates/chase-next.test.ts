import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../db/index.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

// scoring uses no DB — import normally after mocking DB
import { db } from "../../../db/index.js";
import { findCandidates, isStillEligible } from "./chase-next.js";
import type { Customer } from "../../../db/schema/customers.js";
import type { Invoice } from "../../../db/schema/invoices.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeQueryChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "from", "where", "innerJoin", "leftJoin",
    "groupBy", "having", "limit",
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain["then"] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(resolve);
  return chain;
}

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

// findCandidates calls db.select three times:
//   1st → customers (overdueRows)
//   2nd → invoices  } Promise.all
//   3rd → chaseLog  }
function chain(value: unknown) {
  return makeQueryChain(value) as unknown as ReturnType<typeof db.select>;
}

function mockFindCandidatesDB(
  customerRows: unknown[],
  invoiceRows: unknown[],
  chaseLogRows: unknown[],
) {
  vi.mocked(db.select)
    .mockReturnValueOnce(chain(customerRows))
    .mockReturnValueOnce(chain(invoiceRows))
    .mockReturnValueOnce(chain(chaseLogRows));
}

// isStillEligible calls db.select three times:
//   1st → customer by id (limit 1)
//   2nd → open invoices for customer
//   3rd → chaseLog max(chasedAt) within cooldown
function mockIsEligibleDB(
  customerRows: unknown[],
  invoiceRows: unknown[],
  chaseLogRows: unknown[],
) {
  vi.mocked(db.select)
    .mockReturnValueOnce(chain(customerRows))
    .mockReturnValueOnce(chain(invoiceRows))
    .mockReturnValueOnce(chain(chaseLogRows));
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
});

// ── findCandidates ───────────────────────────────────────────────────────────

describe("findCandidates", () => {
  it("excluded customer absent — agentModeExcluded=true filtered by query", async () => {
    // DB returns no overdue rows (WHERE agentModeExcluded=false filters the excluded customer)
    mockFindCandidatesDB([], [], []);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("recent chase (3 days ago) suppresses candidate", async () => {
    const customer = makeCustomer({
      id: "cust-1",
      overdueBalance: "50000.00",
      unappliedCreditBalance: "0.00",
    });
    const inv = makeInvoice({
      id: "inv-1",
      customerId: "cust-1",
      balance: "50000.00",
      dueDate: daysAgo(90),
    });
    // chaseLog shows a row from 3 days ago — within 7-day cooldown
    const recentChase = { customerId: "cust-1", lastChasedAt: daysAgo(3) };

    mockFindCandidatesDB([customer], [inv], [recentChase]);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("CRITICAL overdue with no recent chase returned as candidate", async () => {
    const customer = makeCustomer({
      id: "cust-2",
      displayName: "Big Debtor",
      overdueBalance: "60000.00",
      unappliedCreditBalance: "0.00",
    });
    const inv = makeInvoice({
      id: "inv-2",
      customerId: "cust-2",
      balance: "60000.00",
      dueDate: daysAgo(120),
    });

    mockFindCandidatesDB([customer], [inv], []);

    const results = await findCandidates();
    expect(results).toHaveLength(1);
    const c = results[0]!;
    expect(c.entityType).toBe("customer");
    expect(c.entityId).toBe("cust-2");
    expect(c.summary.customerName).toBe("Big Debtor");
    expect(c.summary.tier).toBe("CRITICAL");
    expect(c.summary.overdueBalance).toBeGreaterThan(0);
    expect(c.summary.daysOverdue).toBeGreaterThan(0);
    expect(c.summary.lastChaseAt).toBeNull();
  });

  it("LOW tier customer not returned even without recent chase", async () => {
    // Small balance, barely overdue → LOW tier → excluded
    const customer = makeCustomer({
      id: "cust-3",
      overdueBalance: "50.00",
      unappliedCreditBalance: "0.00",
    });
    const inv = makeInvoice({
      id: "inv-3",
      customerId: "cust-3",
      balance: "50.00",
      dueDate: daysAgo(2),
    });

    mockFindCandidatesDB([customer], [inv], []);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("empty overdueRows returns early without additional queries", async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([]));

    const results = await findCandidates();
    expect(results).toHaveLength(0);
    // Only one db.select call (the customer query) — no invoice/chaseLog queries
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it("when customerId is passed, result only includes that customer", async () => {
    const customer = makeCustomer({
      id: "cust-scope",
      displayName: "Scoped Co",
      overdueBalance: "60000.00",
      unappliedCreditBalance: "0.00",
    });
    const inv = makeInvoice({
      id: "inv-scope",
      customerId: "cust-scope",
      balance: "60000.00",
      dueDate: daysAgo(120),
    });

    mockFindCandidatesDB([customer], [inv], []);

    const results = await findCandidates("cust-scope");
    expect(results).toHaveLength(1);
    expect(results[0]!.entityId).toBe("cust-scope");
  });

  it("TJ-only overdue customer produces no chase proposal", async () => {
    // Customer's denormalized overdueBalance is blended (it reflects a TJ
    // invoice), but the invoice query is origin-scoped to feldart — so the
    // invoice list returned for this customer is EMPTY (the TJ invoice is
    // filtered out by the query's eq(origin,'feldart')). No Feldart overdue
    // → score 0 → LOW tier → excluded.
    const customer = makeCustomer({
      id: "cust-tj",
      displayName: "Torah Judaica Debtor",
      overdueBalance: "60000.00",
      unappliedCreditBalance: "0.00",
    });

    // The query filters origin='feldart'; a TJ-only customer yields no invoices.
    mockFindCandidatesDB([customer], [], []);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("mixed-book customer scored on Feldart overdue only (Feldart still proposed)", async () => {
    // Customer has both a TJ and a Feldart overdue invoice. Only the Feldart
    // invoice survives the origin-scoped query. Its balance alone is CRITICAL,
    // so the customer is still proposed — driven purely by the Feldart book.
    const customer = makeCustomer({
      id: "cust-mixed",
      displayName: "Mixed Book Co",
      overdueBalance: "120000.00", // blended (Feldart + TJ)
      unappliedCreditBalance: "0.00",
    });
    const feldartInv = makeInvoice({
      id: "inv-feldart",
      customerId: "cust-mixed",
      origin: "feldart",
      balance: "60000.00",
      dueDate: daysAgo(120),
    });
    // TJ invoice would be filtered by the query — not passed in.
    mockFindCandidatesDB([customer], [feldartInv], []);

    const results = await findCandidates();
    expect(results).toHaveLength(1);
    expect(results[0]!.entityId).toBe("cust-mixed");
    expect(results[0]!.summary.tier).toBe("CRITICAL");
  });
});

// ── isStillEligible ──────────────────────────────────────────────────────────

describe("isStillEligible", () => {
  it("returns false when customer not found", async () => {
    mockIsEligibleDB([], [], []);
    expect(await isStillEligible("ghost")).toBe(false);
  });

  it("returns false when agentModeExcluded is true", async () => {
    mockIsEligibleDB(
      [makeCustomer({ id: "cust-x", agentModeExcluded: true, overdueBalance: "5000.00" })],
      [],
      [],
    );
    expect(await isStillEligible("cust-x")).toBe(false);
  });

  it("returns false when overdueBalance is 0", async () => {
    mockIsEligibleDB(
      [makeCustomer({ id: "cust-paid", overdueBalance: "0.00" })],
      [],
      [],
    );
    expect(await isStillEligible("cust-paid")).toBe(false);
  });

  it("returns false when severity is LOW (below MEDIUM threshold)", async () => {
    const inv = makeInvoice({
      customerId: "cust-low",
      balance: "50.00",
      dueDate: daysAgo(2),
    });
    mockIsEligibleDB(
      [makeCustomer({ id: "cust-low", overdueBalance: "50.00", unappliedCreditBalance: "0.00" })],
      [inv],
      [],
    );
    expect(await isStillEligible("cust-low")).toBe(false);
  });

  it("returns false when chased within last 7 days", async () => {
    const inv = makeInvoice({
      customerId: "cust-chased",
      balance: "60000.00",
      dueDate: daysAgo(120),
    });
    mockIsEligibleDB(
      [makeCustomer({ id: "cust-chased", overdueBalance: "60000.00", unappliedCreditBalance: "0.00" })],
      [inv],
      [{ lastChasedAt: daysAgo(3) }],
    );
    expect(await isStillEligible("cust-chased")).toBe(false);
  });

  it("returns true for CRITICAL customer with no recent chase", async () => {
    const inv = makeInvoice({
      customerId: "cust-eligible",
      balance: "60000.00",
      dueDate: daysAgo(120),
    });
    mockIsEligibleDB(
      [makeCustomer({ id: "cust-eligible", overdueBalance: "60000.00", unappliedCreditBalance: "0.00" })],
      [inv],
      [{ lastChasedAt: null }],
    );
    expect(await isStillEligible("cust-eligible")).toBe(true);
  });

  it("returns false for a TJ-only overdue customer", async () => {
    // overdueBalance is blended/non-zero, but the origin-scoped invoice query
    // returns no Feldart invoices → no Feldart overdue → LOW tier → ineligible.
    mockIsEligibleDB(
      [makeCustomer({ id: "cust-tj", overdueBalance: "60000.00", unappliedCreditBalance: "0.00" })],
      [], // origin='feldart' filter yields no rows for a TJ-only customer
      [{ lastChasedAt: null }],
    );
    expect(await isStillEligible("cust-tj")).toBe(false);
  });
});
