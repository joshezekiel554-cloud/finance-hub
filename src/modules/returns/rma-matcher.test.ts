import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted db mock — must live before any import that loads the db module.
// ---------------------------------------------------------------------------
const { mockSelect, setSelectQueue, resetSelectQueue } = vi.hoisted(() => {
  let queue: unknown[][] = [];

  const setSelectQueue = (rows: unknown[][]) => {
    queue = rows.slice();
  };
  const resetSelectQueue = () => {
    queue = [];
  };

  type LazyNode = {
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
    catch: (reject: (e: unknown) => unknown) => Promise<unknown>;
    where: (...args: unknown[]) => LazyNode;
    orderBy: (...args: unknown[]) => LazyNode;
    limit: (...args: unknown[]) => LazyNode;
    from: (...args: unknown[]) => LazyNode;
    innerJoin: (...args: unknown[]) => LazyNode;
  };

  const makeNode = (): LazyNode => ({
    then(resolve, reject) {
      return Promise.resolve(queue.shift() ?? []).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(queue.shift() ?? []).catch(reject);
    },
    where: () => makeNode(),
    orderBy: () => makeNode(),
    limit: () => makeNode(),
    from: () => makeNode(),
    innerJoin: () => makeNode(),
  });

  const mockSelect = vi.fn(() => makeNode());

  return { mockSelect, setSelectQueue, resetSelectQueue };
});

vi.mock("~/db/index.js", () => ({
  db: {
    select: mockSelect,
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  },
}));

// Schema mock — just needs to exist so imports resolve.
vi.mock("~/db/schema/returns.js", () => ({
  rmas: { id: "id", rmaNumber: "rma_number", extensivTxNumber: "extensiv_tx_number", extensivRef: "extensiv_ref", status: "status", customerId: "customer_id" },
  rmaItems: { rmaId: "rma_id", sku: "sku" },
}));
vi.mock("~/db/schema/customers.js", () => ({
  customers: { id: "id", displayName: "display_name" },
}));

// drizzle operator mocks — return opaque objects; the mock db ignores them.
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
}));

import { matchReceiptToRma } from "./rma-matcher.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetSelectQueue();
  mockSelect.mockClear();
});

describe("matchReceiptToRma", () => {
  describe("exact_tx_number", () => {
    it("returns exact_tx_number when txNumber matches a single active RMA", async () => {
      // Step 1 query returns one row.
      setSelectQueue([[{ id: "rma_abc123" }]]);
      const result = await matchReceiptToRma({ txNumber: "12345" });
      expect(result).toEqual({ kind: "exact_tx_number", rmaId: "rma_abc123" });
    });

    it("falls through when txNumber matches zero RMAs", async () => {
      // Step 1: no rows → step 2: no refString, no fuzzy signals → no_match
      setSelectQueue([[], [], []]);
      const result = await matchReceiptToRma({ txNumber: "99999" });
      expect(result).toEqual({ kind: "no_match" });
    });

    it("falls through when txNumber matches multiple RMAs (ambiguous)", async () => {
      // Two rows returned — falls through.
      setSelectQueue([[{ id: "a" }, { id: "b" }], [], []]);
      const result = await matchReceiptToRma({ txNumber: "12345" });
      expect(result).toEqual({ kind: "no_match" });
    });
  });

  describe("exact_ref_string", () => {
    it("returns exact_ref_string when refString matches a single active RMA", async () => {
      // No txNumber so skip step 1. Step 2 returns one row.
      setSelectQueue([[{ id: "rma_xyz456" }]]);
      const result = await matchReceiptToRma({ refString: "Acme Spring2026 returns" });
      expect(result).toEqual({ kind: "exact_ref_string", rmaId: "rma_xyz456" });
    });

    it("falls through when refString matches zero RMAs", async () => {
      setSelectQueue([[], [], []]);
      const result = await matchReceiptToRma({ refString: "Unknown Ref" });
      expect(result).toEqual({ kind: "no_match" });
    });
  });

  describe("fuzzy_customer_sku", () => {
    it("returns fuzzy_customer_sku when customer name and SKUs overlap strongly", async () => {
      // No txNumber (skip step 1). No refString (skip step 2).
      // Fuzzy: candidateRmas query, then rmaItems query.
      setSelectQueue([
        // candidateRmas
        [
          { id: "rma_fuzzy01", customerId: "c1", customerName: "Acme Company" },
          { id: "rma_fuzzy02", customerId: "c2", customerName: "Totally Different" },
        ],
        // allItems
        [
          { rmaId: "rma_fuzzy01", sku: "SKU-A" },
          { rmaId: "rma_fuzzy01", sku: "SKU-B" },
          { rmaId: "rma_fuzzy02", sku: "SKU-Z" },
        ],
      ]);

      const result = await matchReceiptToRma({
        inferredCustomerName: "Acme",
        parsedItems: [{ sku: "SKU-A" }, { sku: "SKU-B" }],
      });

      expect(result.kind).toBe("fuzzy_customer_sku");
      if (result.kind === "fuzzy_customer_sku") {
        expect(result.rmaId).toBe("rma_fuzzy01");
        expect(result.confidence).toBeGreaterThan(0.5);
      }
    });

    it("returns no_match when score is <= 0.5 for all candidates", async () => {
      setSelectQueue([
        // candidateRmas — customer name and SKUs don't overlap
        [{ id: "rma_poor01", customerId: "c1", customerName: "Other Co" }],
        // allItems
        [{ rmaId: "rma_poor01", sku: "TOTALLY-DIFFERENT" }],
      ]);

      const result = await matchReceiptToRma({
        inferredCustomerName: "Acme",
        parsedItems: [{ sku: "SKU-A" }],
      });

      expect(result).toEqual({ kind: "no_match" });
    });

    it("returns no_match when there are no candidate RMAs in sent_to_warehouse", async () => {
      setSelectQueue([
        // candidateRmas empty
        [],
      ]);

      const result = await matchReceiptToRma({
        inferredCustomerName: "Acme",
        parsedItems: [{ sku: "SKU-A" }],
      });

      expect(result).toEqual({ kind: "no_match" });
    });

    it("populates alternateMatches when multiple candidates score > 0.5", async () => {
      setSelectQueue([
        [
          { id: "rma_first", customerId: "c1", customerName: "Acme Corp" },
          { id: "rma_second", customerId: "c2", customerName: "Acme Stores" },
        ],
        [
          { rmaId: "rma_first", sku: "SKU-A" },
          { rmaId: "rma_first", sku: "SKU-B" },
          { rmaId: "rma_second", sku: "SKU-A" },
          { rmaId: "rma_second", sku: "SKU-B" },
        ],
      ]);

      const result = await matchReceiptToRma({
        inferredCustomerName: "Acme",
        parsedItems: [{ sku: "SKU-A" }, { sku: "SKU-B" }],
      });

      expect(result.kind).toBe("fuzzy_customer_sku");
      if (result.kind === "fuzzy_customer_sku") {
        // Both matched; alternate should contain the runner-up.
        expect(result.alternateMatches.length).toBe(1);
      }
    });
  });

  describe("no_match fallback", () => {
    it("returns no_match when no inputs are provided", async () => {
      const result = await matchReceiptToRma({});
      expect(result).toEqual({ kind: "no_match" });
    });

    it("returns no_match when txNumber + refString both produce zero rows and no fuzzy signals", async () => {
      setSelectQueue([[], []]);
      const result = await matchReceiptToRma({
        txNumber: "00000",
        refString: "Nothing Matches returns",
      });
      expect(result).toEqual({ kind: "no_match" });
    });
  });

  // -----------------------------------------------------------------------
  // Bug I5 — token-based customer-name overlap (no bare-substring boosts)
  // -----------------------------------------------------------------------
  describe("customer-name token overlap (Bug I5)", () => {
    it("does NOT score-boost when inferred name is a short token like 'Co'", async () => {
      // Candidate has "Cohen Family Co" — under the old includes() rule
      // the lowercase "co" would match and award the 0.5 customer-name
      // boost. With token-overlap and a 4-char minimum it must not.
      // SKU Jaccard is 0 here, so the candidate's score stays at 0 and
      // the matcher returns no_match.
      setSelectQueue([
        [
          { id: "rma_co", customerId: "c1", customerName: "Cohen Family Co" },
        ],
        [{ rmaId: "rma_co", sku: "SKU-Z" }],
      ]);

      const result = await matchReceiptToRma({
        inferredCustomerName: "Co",
        parsedItems: [{ sku: "SKU-A" }],
      });

      expect(result).toEqual({ kind: "no_match" });
    });

    it("DOES score-boost when inferred name shares a 4+ char token", async () => {
      // "Cohen" is 5 chars and appears in "Cohen Family Co" → token match.
      // Combined with a strong SKU overlap the score crosses the 0.5
      // threshold and we surface a fuzzy match.
      setSelectQueue([
        [
          { id: "rma_co", customerId: "c1", customerName: "Cohen Family Co" },
        ],
        [
          { rmaId: "rma_co", sku: "SKU-A" },
          { rmaId: "rma_co", sku: "SKU-B" },
        ],
      ]);

      const result = await matchReceiptToRma({
        inferredCustomerName: "Cohen",
        parsedItems: [{ sku: "SKU-A" }, { sku: "SKU-B" }],
      });

      expect(result.kind).toBe("fuzzy_customer_sku");
      if (result.kind === "fuzzy_customer_sku") {
        expect(result.rmaId).toBe("rma_co");
      }
    });
  });
});
