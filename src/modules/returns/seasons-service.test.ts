// Tests for the seasons + seasonal_products CRUD service.
//
// DB and QboClient are fully mocked via vi.hoisted — no real DB or HTTP calls.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockDb, insertCalls, setSelectResults, resetMocks } = vi.hoisted(() => {
  type InsertCall = { table: unknown; values: unknown };
  const insertCalls: InsertCall[] = [];

  let selectResultsQueue: unknown[][] = [];
  const setSelectResults = (queue: unknown[][]) => {
    selectResultsQueue = queue.slice();
  };
  const resetMocks = () => {
    selectResultsQueue = [];
    insertCalls.length = 0;
  };

  type LazyNode = {
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
    catch: (reject: (e: unknown) => unknown) => Promise<unknown>;
    where: (...args: unknown[]) => LazyNode;
    orderBy: (...args: unknown[]) => LazyNode;
    limit: (...args: unknown[]) => LazyNode;
    from: (...args: unknown[]) => LazyNode;
  };

  const makeNode = (): LazyNode => ({
    then(resolve, reject) {
      return Promise.resolve(selectResultsQueue.shift() ?? []).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(selectResultsQueue.shift() ?? []).catch(reject);
    },
    where: () => makeNode(),
    orderBy: () => makeNode(),
    limit: () => makeNode(),
    from: () => makeNode(),
  });

  const select = vi.fn(() => makeNode());

  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return Promise.resolve();
    },
  });

  const update = (_table: unknown) => ({
    set: (_values: unknown) => ({
      where: (..._args: unknown[]) => Promise.resolve(),
    }),
  });

  const deleteFn = (_table: unknown) => ({
    where: (..._args: unknown[]) => Promise.resolve(),
  });

  return {
    insertCalls,
    setSelectResults,
    resetMocks,
    mockDb: { insert, update, delete: deleteFn, select },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

// QBO mock — controls getItemById and getQboItemBySku
const { mockGetItemById, mockGetQboItemBySku } = vi.hoisted(() => ({
  mockGetItemById: vi.fn(),
  mockGetQboItemBySku: vi.fn(),
}));

vi.mock("../../integrations/qb/client.js", () => ({
  configFromEnv: vi.fn(() => ({})),
  QboClient: vi.fn().mockImplementation(() => ({
    getItemById: mockGetItemById,
    getQboItemBySku: mockGetQboItemBySku,
  })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
import {
  listSeasons,
  getSeasonById,
  createSeason,
  updateSeason,
  deleteSeason,
  listSeasonProducts,
  addSeasonProduct,
  bulkAddSeasonProductsBySku,
  removeSeasonProduct,
  importSeasonProductsCsv,
  exportSeasonProductsCsv,
  duplicateSeason,
} from "./seasons-service.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEASON = {
  id: "season-abc123456789012",
  name: "Pesach 2026",
  startDate: "2026-03-15",
  endDate: "2026-04-30",
  isActive: true,
  createdByUserId: "user-001",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const PRODUCT = {
  id: "prod-abc1234567890123",
  seasonId: SEASON.id,
  qbItemId: "QB-ITEM-999",
  sku: "MUG-GOLD",
  name: "Gold Passover Mug",
  description: null,
  createdAt: new Date("2026-01-01"),
};

const QBO_ITEM = {
  Id: "QB-ITEM-999",
  Name: "Gold Passover Mug",
  Sku: "MUG-GOLD",
  Active: true,
};

beforeEach(() => {
  resetMocks();
  mockGetItemById.mockReset();
  mockGetQboItemBySku.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listSeasons", () => {
  it("returns all seasons when no filter applied", async () => {
    setSelectResults([[SEASON]]);
    const result = await listSeasons({});
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Pesach 2026");
  });

  it("filters by active=true", async () => {
    setSelectResults([[SEASON]]);
    const result = await listSeasons({ active: true });
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no matching seasons", async () => {
    setSelectResults([[]]);
    const result = await listSeasons({ active: false });
    expect(result).toHaveLength(0);
  });
});

describe("getSeasonById", () => {
  it("returns the season when found", async () => {
    setSelectResults([[SEASON]]);
    const result = await getSeasonById(SEASON.id);
    expect(result?.name).toBe("Pesach 2026");
  });

  it("returns null when not found", async () => {
    setSelectResults([[]]);
    const result = await getSeasonById("nonexistent");
    expect(result).toBeNull();
  });
});

describe("createSeason", () => {
  it("inserts a new season and returns the row", async () => {
    const result = await createSeason({
      name: "Rosh Hashana 2026",
      startDate: "2026-09-01",
      endDate: "2026-10-15",
      isActive: true,
      createdByUserId: "user-001",
    });

    expect(insertCalls).toHaveLength(1);
    const inserted = insertCalls[0]!.values as Record<string, unknown>;
    expect(inserted.name).toBe("Rosh Hashana 2026");
    expect(typeof inserted.id).toBe("string");
    expect((inserted.id as string).length).toBeGreaterThan(0);
    expect(result.name).toBe("Rosh Hashana 2026");
  });
});

describe("updateSeason", () => {
  it("returns null when the season does not exist", async () => {
    setSelectResults([[]]); // getSeasonById call → not found
    const result = await updateSeason("bad-id", { name: "New Name" });
    expect(result).toBeNull();
  });

  it("updates and returns the refreshed season", async () => {
    // First select: existing season check; second select: refreshed row
    const updated = { ...SEASON, name: "Updated Season Name" };
    setSelectResults([[SEASON], [updated]]);
    const result = await updateSeason(SEASON.id, { name: "Updated Season Name" });
    expect(result?.name).toBe("Updated Season Name");
  });
});

describe("deleteSeason", () => {
  it("returns false when season does not exist", async () => {
    setSelectResults([[]]);
    const result = await deleteSeason("nonexistent");
    expect(result).toBe(false);
  });

  it("returns true when season is deleted", async () => {
    setSelectResults([[SEASON]]);
    const result = await deleteSeason(SEASON.id);
    expect(result).toBe(true);
  });
});

describe("addSeasonProduct", () => {
  it("resolves item from QBO and inserts the seasonal product", async () => {
    mockGetItemById.mockResolvedValueOnce(QBO_ITEM);

    const result = await addSeasonProduct({
      seasonId: SEASON.id,
      qbItemId: "QB-ITEM-999",
    });

    expect(insertCalls).toHaveLength(1);
    const inserted = insertCalls[0]!.values as Record<string, unknown>;
    expect(inserted.qbItemId).toBe("QB-ITEM-999");
    expect(inserted.sku).toBe("MUG-GOLD");
    expect(inserted.name).toBe("Gold Passover Mug");
    expect(result.sku).toBe("MUG-GOLD");
  });

  it("falls back to qbItemId as sku/name when item not found in QBO", async () => {
    mockGetItemById.mockResolvedValueOnce(null);

    const result = await addSeasonProduct({
      seasonId: SEASON.id,
      qbItemId: "QB-ITEM-UNKNOWN",
    });

    expect(result.sku).toBe("QB-ITEM-UNKNOWN");
    expect(result.name).toBe("QB-ITEM-UNKNOWN");
  });
});

describe("bulkAddSeasonProductsBySku", () => {
  it("adds found SKUs and records failed ones", async () => {
    // First SKU found, second not found
    mockGetQboItemBySku
      .mockResolvedValueOnce(QBO_ITEM)
      .mockResolvedValueOnce(null);

    const result = await bulkAddSeasonProductsBySku({
      seasonId: SEASON.id,
      skus: ["MUG-GOLD", "NONEXISTENT-SKU"],
    });

    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.sku).toBe("MUG-GOLD");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.sku).toBe("NONEXISTENT-SKU");
    expect(result.failed[0]!.reason).toContain("not found");
  });

  it("records failure when QBO throws for a SKU", async () => {
    mockGetQboItemBySku.mockRejectedValueOnce(new Error("QBO timeout"));

    const result = await bulkAddSeasonProductsBySku({
      seasonId: SEASON.id,
      skus: ["PROBLEM-SKU"],
    });

    expect(result.added).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toBe("QBO timeout");
  });

  it("skips blank SKU entries", async () => {
    const result = await bulkAddSeasonProductsBySku({
      seasonId: SEASON.id,
      skus: ["  ", ""],
    });

    expect(result.added).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(mockGetQboItemBySku).not.toHaveBeenCalled();
  });
});

describe("removeSeasonProduct", () => {
  it("returns false when product does not exist", async () => {
    setSelectResults([[]]);
    const result = await removeSeasonProduct("bad-id");
    expect(result).toBe(false);
  });

  it("returns true when product is deleted", async () => {
    setSelectResults([[PRODUCT]]);
    const result = await removeSeasonProduct(PRODUCT.id);
    expect(result).toBe(true);
  });
});

describe("importSeasonProductsCsv", () => {
  it("imports valid CSV rows and skips the header", async () => {
    mockGetQboItemBySku
      .mockResolvedValueOnce({ Id: "QB-1", Name: "Gold Mug", Sku: "MUG-GOLD" })
      .mockResolvedValueOnce({ Id: "QB-2", Name: "Silver Plate", Sku: "PLATE-SIL" });

    const csv = "sku,name,description\nMUG-GOLD,Gold Mug,Beautiful\nPLATE-SIL,Silver Plate,";
    const result = await importSeasonProductsCsv({ seasonId: SEASON.id, csv });

    expect(result.added).toBe(2);
    expect(result.failed).toHaveLength(0);
    expect(insertCalls).toHaveLength(2);
  });

  it("records failed rows when SKU not found", async () => {
    mockGetQboItemBySku.mockResolvedValueOnce(null);

    const csv = "BAD-SKU,Some Name,";
    const result = await importSeasonProductsCsv({ seasonId: SEASON.id, csv });

    expect(result.added).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.row).toBe(1);
    expect(result.failed[0]!.reason).toContain("not found");
  });

  it("records failed row when SKU column is empty", async () => {
    const csv = ",name only,";
    const result = await importSeasonProductsCsv({ seasonId: SEASON.id, csv });

    expect(result.added).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toBe("Empty SKU");
  });
});

describe("exportSeasonProductsCsv", () => {
  it("returns CSV with header and one row per product", async () => {
    setSelectResults([[PRODUCT, { ...PRODUCT, id: "prod-2", sku: "PLATE-SIL", name: "Silver Plate" }]]);

    const csv = await exportSeasonProductsCsv(SEASON.id);
    const lines = csv.split("\n");

    expect(lines[0]).toBe("sku,name,description");
    expect(lines).toHaveLength(3); // header + 2 products
    expect(lines[1]).toContain("MUG-GOLD");
    expect(lines[2]).toContain("PLATE-SIL");
  });

  it("returns only header when season has no products", async () => {
    setSelectResults([[]]);
    const csv = await exportSeasonProductsCsv(SEASON.id);
    expect(csv).toBe("sku,name,description");
  });
});

describe("duplicateSeason", () => {
  it("creates new season and copies all products", async () => {
    // listSeasonProducts needs one select call returning source products
    setSelectResults([[PRODUCT]]);

    const result = await duplicateSeason({
      fromSeasonId: SEASON.id,
      newName: "Pesach 2027",
      startDate: "2027-03-01",
      endDate: "2027-04-30",
      createdByUserId: "user-001",
    });

    // Should insert 1 season + 1 copied product
    expect(insertCalls).toHaveLength(2);
    expect(result.name).toBe("Pesach 2027");
    expect(result.isActive).toBe(false);

    const productInsert = insertCalls[1]!.values as Record<string, unknown>;
    expect(productInsert.sku).toBe("MUG-GOLD");
    expect(productInsert.seasonId).toBe(result.id);
    // The product ID should be a new nanoid, not the source product's ID
    expect(productInsert.id).not.toBe(PRODUCT.id);
  });

  it("creates a new season with no products when source has none", async () => {
    setSelectResults([[]]);

    const result = await duplicateSeason({
      fromSeasonId: "empty-season-id",
      newName: "Empty Copy",
      startDate: "2027-01-01",
      endDate: "2027-02-28",
      createdByUserId: "user-001",
    });

    // Only the season insert — no product inserts
    expect(insertCalls).toHaveLength(1);
    expect(result.name).toBe("Empty Copy");
  });
});
