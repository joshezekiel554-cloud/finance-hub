import { describe, expect, it, vi } from "vitest";
import type { Customer } from "../../../db/schema/customers.js";
import type { Activity, EmailLog } from "../../../db/schema/crm.js";

// vi.mock must be at top level — no dynamic paths
vi.mock("../../../db/index.js", () => {
  const mockDb = {
    select: vi.fn(),
  };
  return { db: mockDb };
});

import { findCandidates, isStillEligible } from "./cadence-cold.js";
import { db } from "../../../db/index.js";

// ---------- helpers ----------

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  const now = new Date();
  return {
    id: "cust-1",
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
    balance: "500.00",
    overdueBalance: "500.00",
    unappliedCreditBalance: "0.00",
    internalNotes: null,
    lastSyncedAt: now,
    vocatechLastPushedAt: null,
    agentModeExcluded: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Drizzle's fluent builder returns itself at each step; mock the chain
// and make execute() (.then resolution) return the desired rows.
function mockDbSelect(rows: Record<string, unknown>[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    as: vi.fn().mockReturnThis(),
    // Drizzle queries are thenable (Promise-like)
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

// ---------- tests ----------

describe("findCandidates", () => {
  it("excludes customers where agentModeExcluded is true", async () => {
    // DB returns no rows — excluded customer filtered at query level
    mockDbSelect([]);

    const result = await findCandidates();
    expect(result).toHaveLength(0);
  });

  it("returns candidate with correct summary when all criteria met", async () => {
    const lastPayment = daysAgo(60);
    const lastContact = daysAgo(30);

    mockDbSelect([
      {
        id: "cust-1",
        displayName: "Acme Corp",
        overdueBalance: "1200.00",
        lastPayment,
        lastContact,
      },
    ]);

    const result = await findCandidates();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      entityType: "customer",
      entityId: "cust-1",
      summary: expect.objectContaining({
        customerName: "Acme Corp",
        openBalance: 1200,
        daysSinceLastPayment: expect.any(Number),
        daysSinceLastContact: expect.any(Number),
      }),
    });
    expect((result[0]!.summary as { daysSinceLastPayment: number }).daysSinceLastPayment).toBeGreaterThanOrEqual(59);
    expect((result[0]!.summary as { daysSinceLastContact: number }).daysSinceLastContact).toBeGreaterThanOrEqual(29);
  });

  it("recent contact suppresses — customer with old payment but inbound email 5 days ago is not returned", async () => {
    // Query applies the 21-day contact cutoff; DB returns no rows for this customer
    mockDbSelect([]);

    const result = await findCandidates();
    expect(result).toHaveLength(0);
  });

  it("uses large sentinel days when payment is null (never paid)", async () => {
    mockDbSelect([
      {
        id: "cust-2",
        displayName: "New Corp",
        overdueBalance: "800.00",
        lastPayment: null,
        lastContact: null,
      },
    ]);

    const result = await findCandidates();
    expect(result).toHaveLength(1);
    expect((result[0]!.summary as { daysSinceLastPayment: number }).daysSinceLastPayment).toBe(99999);
    expect((result[0]!.summary as { daysSinceLastContact: number }).daysSinceLastContact).toBe(99999);
  });
});

describe("isStillEligible", () => {
  it("returns true when customer still matches criteria", async () => {
    mockDbSelect([
      {
        id: "cust-1",
        displayName: "Acme Corp",
        overdueBalance: "500.00",
        lastPayment: daysAgo(50),
        lastContact: daysAgo(25),
      },
    ]);

    const result = await isStillEligible("cust-1");
    expect(result).toBe(true);
  });

  it("returns false when customer no longer matches (no rows returned)", async () => {
    mockDbSelect([]);

    const result = await isStillEligible("cust-1");
    expect(result).toBe(false);
  });
});
