// Tests for the cumulative seasonal eligibility module.
//
// DB + QBO are fully mocked via vi.hoisted so no real DB or HTTP calls
// are made. Each test configures the mock return queues before calling
// runEligibility.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

// DB mock — queue-based select results consumed in order.
const { mockDb, setSelectResults } = vi.hoisted(() => {
  let selectResultsQueue: unknown[][] = [];
  const setSelectResults = (queue: unknown[][]) => {
    selectResultsQueue = queue.slice();
  };

  type LazyNode = {
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise<unknown>;
    catch: (reject: (e: unknown) => unknown) => Promise<unknown>;
    where: (...args: unknown[]) => LazyNode;
    orderBy: (...args: unknown[]) => LazyNode;
    limit: (...args: unknown[]) => LazyNode;
    from: (...args: unknown[]) => LazyNode;
  };

  const makeNode = (): LazyNode => {
    const node: LazyNode = {
      then(resolve, reject) {
        return Promise.resolve(selectResultsQueue.shift() ?? []).then(
          resolve,
          reject,
        );
      },
      catch(reject) {
        return Promise.resolve(selectResultsQueue.shift() ?? []).catch(reject);
      },
      where: (..._args: unknown[]) => makeNode(),
      orderBy: (..._args: unknown[]) => makeNode(),
      limit: (..._args: unknown[]) => makeNode(),
      from: (..._args: unknown[]) => makeNode(),
    };
    return node;
  };

  const select = vi.fn(() => makeNode());
  const mockDb = { select };
  return { mockDb, setSelectResults };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

// QBO mock
const findInvoicesForCustomerMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../../integrations/qb/client.js", () => ({
  QboClient: vi.fn().mockImplementation(() => ({
    findInvoicesForCustomer: findInvoicesForCustomerMock,
  })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
import { runEligibility } from "./eligibility.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEASON = {
  id: "season-1",
  name: "Pesach 2026",
  startDate: "2026-03-01",
  endDate: "2026-04-30",
};

// One seasonal product mapped to QBO item id "ITEM-101"
const SEASONAL_PRODUCTS = [{ qbItemId: "ITEM-101" }];

// Default threshold = 50 (no explicit setting → empty array → default)
const NO_THRESHOLD_SETTING: unknown[] = [];
const THRESHOLD_50_SETTING = [{ value: "50" }];

// Helper: make a QBO invoice with one seasonal line.
function makeQboInvoice(
  docNumber: string,
  txnDate: string,
  seasonalLineAmount: number,
) {
  return {
    Id: `inv-${docNumber}`,
    DocNumber: docNumber,
    TxnDate: txnDate,
    TotalAmt: seasonalLineAmount,
    CustomerRef: { value: "QB-CUST-1" },
    Line: [
      {
        Id: "1",
        DetailType: "SalesItemLineDetail",
        Amount: seasonalLineAmount,
        SalesItemLineDetail: {
          ItemRef: { value: "ITEM-101" },
          Qty: 1,
          UnitPrice: seasonalLineAmount,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

// Standard DB queue: threshold → season → products → no existing RMAs
function setupStandardDb(extraRmaRows: unknown[] = []) {
  setSelectResults([
    THRESHOLD_50_SETTING, // app_settings
    [SEASON], // seasons
    SEASONAL_PRODUCTS, // seasonal_products
    extraRmaRows, // existing approved RMAs
  ]);
}

beforeEach(() => {
  findInvoicesForCustomerMock.mockReset();
  findInvoicesForCustomerMock.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runEligibility", () => {
  // --- Case 1: all current-season items, under threshold ---
  it("passes when proposed current-season items are under threshold", async () => {
    // Customer purchased $1000 seasonal items; proposing $400 return = 40%
    setupStandardDb([]);
    findInvoicesForCustomerMock.mockResolvedValue([
      makeQboInvoice("18001", "2026-03-15", 1000),
    ]);

    const result = await runEligibility({
      customerId: "cust-1",
      qbCustomerId: "QB-CUST-1",
      seasonId: "season-1",
      proposedItems: [
        { lineTotal: "400.00", classification: "seasonal_current" },
      ],
    });

    expect(result.customerSeasonalPurchases).toBe("1000.00");
    expect(result.proposedCurrentSeason).toBe("400.00");
    expect(result.proposedSubtotalCountingTowardThreshold).toBe("400.00");
    expect(result.totalReturnsThisSeason).toBe("400.00");
    expect(result.cumulativeReturnPct).toBe("40.00");
    expect(result.thresholdPct).toBe("50.00");
    expect(result.passesThreshold).toBe(true);
  });

  // --- Case 2: single RMA, over threshold ---
  it("fails when proposed current-season items exceed threshold", async () => {
    // Customer purchased $1000; proposing $600 = 60%
    setupStandardDb([]);
    findInvoicesForCustomerMock.mockResolvedValue([
      makeQboInvoice("18001", "2026-03-15", 1000),
    ]);

    const result = await runEligibility({
      customerId: "cust-1",
      qbCustomerId: "QB-CUST-1",
      seasonId: "season-1",
      proposedItems: [
        { lineTotal: "600.00", classification: "seasonal_current" },
      ],
    });

    expect(result.cumulativeReturnPct).toBe("60.00");
    expect(result.passesThreshold).toBe(false);
  });

  // --- Case 3: cumulative across 2 RMAs pushes over threshold ---
  it("fails cumulatively when a second RMA pushes total over threshold", async () => {
    // Already returned $300 on first RMA; proposing $250 more = $550 / $1000 = 55%
    setupStandardDb([
      { totalValue: "300.00", eligibleAmount: null }, // first approved RMA
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([
      makeQboInvoice("18001", "2026-03-15", 1000),
    ]);

    const result = await runEligibility({
      customerId: "cust-1",
      qbCustomerId: "QB-CUST-1",
      seasonId: "season-1",
      proposedItems: [
        { lineTotal: "250.00", classification: "seasonal_current" },
      ],
    });

    expect(result.alreadyReturnedThisSeason).toBe("300.00");
    expect(result.proposedCurrentSeason).toBe("250.00");
    expect(result.totalReturnsThisSeason).toBe("550.00");
    expect(result.cumulativeReturnPct).toBe("55.00");
    expect(result.passesThreshold).toBe(false);
  });

  // --- Case 4: mixed classifications — only counting items go toward threshold ---
  it("excludes non_seasonal items from threshold but includes them in display", async () => {
    // $1000 purchased; $200 current + $150 prior + $500 non_seasonal
    // counting toward threshold: $200 + $150 = $350 = 35% → passes
    setupStandardDb([]);
    findInvoicesForCustomerMock.mockResolvedValue([
      makeQboInvoice("18001", "2026-03-15", 1000),
    ]);

    const result = await runEligibility({
      customerId: "cust-1",
      qbCustomerId: "QB-CUST-1",
      seasonId: "season-1",
      proposedItems: [
        { lineTotal: "200.00", classification: "seasonal_current" },
        { lineTotal: "150.00", classification: "seasonal_prior" },
        { lineTotal: "500.00", classification: "non_seasonal" },
      ],
    });

    expect(result.proposedCurrentSeason).toBe("200.00");
    expect(result.proposedPriorSeason).toBe("150.00");
    expect(result.proposedNonSeasonal).toBe("500.00");
    expect(result.proposedSubtotalCountingTowardThreshold).toBe("350.00");
    expect(result.cumulativeReturnPct).toBe("35.00");
    expect(result.passesThreshold).toBe(true);
  });

  // --- Edge: excludeRmaId excludes the draft from already-returned ---
  it("excludes the current draft RMA from alreadyReturnedThisSeason", async () => {
    // Two existing RMA rows returned, but one is the current draft (excluded)
    // Only first contributes: $300; propose $100 = 40% → passes
    setupStandardDb([
      { totalValue: "300.00", eligibleAmount: null }, // approved
      // NOTE: excludeRmaId is passed so DB mock won't return the excluded row
      // (the WHERE ne() in the real implementation handles this; our mock
      // just returns whatever we enqueue)
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([
      makeQboInvoice("18001", "2026-03-15", 1000),
    ]);

    const result = await runEligibility({
      customerId: "cust-1",
      qbCustomerId: "QB-CUST-1",
      seasonId: "season-1",
      proposedItems: [
        { lineTotal: "100.00", classification: "seasonal_current" },
      ],
      excludeRmaId: "rma-draft-1",
    });

    expect(result.alreadyReturnedThisSeason).toBe("300.00");
    expect(result.totalReturnsThisSeason).toBe("400.00");
    expect(result.cumulativeReturnPct).toBe("40.00");
    expect(result.passesThreshold).toBe(true);
  });

  // --- Edge: invoices outside season window are excluded ---
  it("ignores QBO invoices outside the season date window", async () => {
    setupStandardDb([]);
    findInvoicesForCustomerMock.mockResolvedValue([
      makeQboInvoice("OLD-1", "2025-12-01", 500), // before season start
      makeQboInvoice("NEW-1", "2026-05-15", 500), // after season end
      makeQboInvoice("IN-1", "2026-03-20", 1000), // in window
    ]);

    const result = await runEligibility({
      customerId: "cust-1",
      qbCustomerId: "QB-CUST-1",
      seasonId: "season-1",
      proposedItems: [
        { lineTotal: "400.00", classification: "seasonal_current" },
      ],
    });

    expect(result.customerSeasonalPurchases).toBe("1000.00");
    expect(result.perInvoice).toHaveLength(1);
    expect(result.perInvoice[0]!.invoiceDocNumber).toBe("IN-1");
  });

  // --- Edge: default threshold = 50 when no setting exists ---
  it("defaults to 50% threshold when no app_setting row exists", async () => {
    setSelectResults([
      NO_THRESHOLD_SETTING, // no threshold setting
      [SEASON],
      SEASONAL_PRODUCTS,
      [],
    ]);
    findInvoicesForCustomerMock.mockResolvedValue([
      makeQboInvoice("18001", "2026-03-15", 1000),
    ]);

    const result = await runEligibility({
      customerId: "cust-1",
      qbCustomerId: "QB-CUST-1",
      seasonId: "season-1",
      proposedItems: [{ lineTotal: "450.00", classification: "seasonal_current" }],
    });

    expect(result.thresholdPct).toBe("50.00");
    expect(result.passesThreshold).toBe(true);
  });

  // --- Edge: perInvoice rollup aggregates multiple lines from same invoice ---
  it("aggregates multiple seasonal lines from the same invoice into one perInvoice entry", async () => {
    setupStandardDb([]);
    // Invoice with two seasonal lines
    findInvoicesForCustomerMock.mockResolvedValue([
      {
        Id: "inv-multi",
        DocNumber: "18050",
        TxnDate: "2026-04-01",
        TotalAmt: 600,
        CustomerRef: { value: "QB-CUST-1" },
        Line: [
          {
            DetailType: "SalesItemLineDetail",
            Amount: 300,
            SalesItemLineDetail: { ItemRef: { value: "ITEM-101" } },
          },
          {
            DetailType: "SalesItemLineDetail",
            Amount: 300,
            SalesItemLineDetail: { ItemRef: { value: "ITEM-101" } },
          },
          // Non-seasonal line should be ignored
          {
            DetailType: "SalesItemLineDetail",
            Amount: 999,
            SalesItemLineDetail: { ItemRef: { value: "ITEM-OTHER" } },
          },
        ],
      },
    ]);

    const result = await runEligibility({
      customerId: "cust-1",
      qbCustomerId: "QB-CUST-1",
      seasonId: "season-1",
      proposedItems: [{ lineTotal: "100.00", classification: "seasonal_current" }],
    });

    expect(result.customerSeasonalPurchases).toBe("600.00");
    expect(result.perInvoice).toHaveLength(1);
    expect(result.perInvoice[0]!.amount).toBe("600.00");
  });
});
