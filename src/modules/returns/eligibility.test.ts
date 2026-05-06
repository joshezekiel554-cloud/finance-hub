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
//
// Option A predicate-awareness (added for the excludeRmaId test): the
// captured `where` argument is recursively scanned for "<> " operators
// (drizzle's serialised form for `ne()`) and the trailing operand is
// collected. Rows tagged with `__rmaId` matching one of the collected
// "must not equal" values are filtered out before resolving the queue
// entry. Untagged rows pass through unchanged so existing tests keep
// working without modification.
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

  // Walks a drizzle SQL condition and returns every operand that follows
  // a "<> " chunk (i.e. the right-hand side of a `ne()` comparison).
  // Drizzle stores this in nested `queryChunks` arrays; `and()` wraps
  // multiple conditions in another SQL object with the same shape.
  function collectExcludedValues(node: unknown): string[] {
    const out: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      const obj = n as Record<string, unknown>;
      const chunks = obj.queryChunks;
      if (Array.isArray(chunks)) {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (
            chunk &&
            typeof chunk === "object" &&
            Array.isArray((chunk as Record<string, unknown>).value) &&
            ((chunk as Record<string, unknown>).value as unknown[])[0] === " <> "
          ) {
            // The operand may be either:
            //   - a raw string (drizzle-sql template form), or
            //   - a Param wrapper object { brand: 'Param', value: <raw>, encoder }
            //     (drizzle-orm normal form for prepared parameters).
            // The operand for `ne()` is wrapped as { value, encoder, ... }
            // (drizzle-orm normal form). When the chunk preceding it is the
            // " <> " operator we know the value is the right-hand side of
            // a not-equals comparison, so we collect it.
            const next = chunks[i + 1];
            let raw: unknown = next;
            if (raw && typeof raw === "object" && "value" in raw) {
              raw = (raw as Record<string, unknown>).value;
            }
            if (typeof raw === "string") out.push(raw);
          }
          walk(chunk);
        }
      }
      // and()/or() wrappers nest their inner conditions in `chunks` too
      // but other shapes (e.g. raw values) are safe to ignore.
    };
    walk(node);
    return out;
  }

  const makeNode = (excluded: string[] = []): LazyNode => {
    const filterRows = (rows: unknown[]): unknown[] => {
      if (excluded.length === 0) return rows;
      return rows.filter((r) => {
        if (!r || typeof r !== "object") return true;
        const tag = (r as Record<string, unknown>).__rmaId;
        return typeof tag !== "string" || !excluded.includes(tag);
      });
    };
    const node: LazyNode = {
      then(resolve, reject) {
        const next = selectResultsQueue.shift() ?? [];
        return Promise.resolve(filterRows(next)).then(resolve, reject);
      },
      catch(reject) {
        const next = selectResultsQueue.shift() ?? [];
        return Promise.resolve(filterRows(next)).catch(reject);
      },
      where: (...args: unknown[]) => {
        const found = args.flatMap((a) => collectExcludedValues(a));
        return makeNode([...excluded, ...found]);
      },
      orderBy: (..._args: unknown[]) => makeNode(excluded),
      limit: (..._args: unknown[]) => makeNode(excluded),
      from: (..._args: unknown[]) => makeNode(excluded),
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
    // Option A predicate-aware mock: the queue contains BOTH a row that
    // should be counted ($300) AND a row tagged as the draft RMA being
    // excluded ($999). The mock's `where()` reads the `ne()` predicate
    // out of the drizzle condition tree and filters out any row whose
    // `__rmaId` matches. If the implementation forgot to pass the
    // exclusion to the WHERE clause, the mock would return both rows
    // and `alreadyReturnedThisSeason` would be "1299.00" — making the
    // test fail loudly. Previously the test only enqueued one row, so
    // it asserted nothing about the exclusion behaviour at all.
    setupStandardDb([
      { totalValue: "300.00", eligibleAmount: null }, // counted
      { __rmaId: "rma-draft-1", totalValue: "999.00", eligibleAmount: null }, // excluded
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

    // alreadyReturnedThisSeason must NOT include the $999 draft row.
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
