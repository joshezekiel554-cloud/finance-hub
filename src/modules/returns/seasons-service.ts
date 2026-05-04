// CRUD service for seasons + seasonal_products.
//
// Follows the same pattern as rma-service.ts:
//   - Drizzle ORM for all DB operations
//   - nanoid(24) for generated IDs
//   - QboClient.getItemById() / getQboItemBySku() to resolve item metadata at add time
//   - Pure functions — no Express/Fastify coupling

import { and, eq, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  seasons,
  seasonalProducts,
  type Season,
  type SeasonalProduct,
} from "../../db/schema/returns.js";
import { QboClient, configFromEnv } from "../../integrations/qb/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getQboClient(): QboClient {
  return new QboClient(configFromEnv());
}

// ---------------------------------------------------------------------------
// listSeasons
// ---------------------------------------------------------------------------

export type ListSeasonsFilters = {
  active?: boolean;
};

export async function listSeasons(
  filters: ListSeasonsFilters = {},
): Promise<Season[]> {
  const wheres: SQL[] = [];
  if (typeof filters.active === "boolean") {
    wheres.push(eq(seasons.isActive, filters.active));
  }
  const where = wheres.length ? and(...wheres) : undefined;
  return db
    .select()
    .from(seasons)
    .where(where)
    .orderBy(seasons.startDate) as unknown as Promise<Season[]>;
}

// ---------------------------------------------------------------------------
// getSeasonById
// ---------------------------------------------------------------------------

export async function getSeasonById(id: string): Promise<Season | null> {
  const rows = await db.select().from(seasons).where(eq(seasons.id, id));
  return (rows[0] as Season) ?? null;
}

// ---------------------------------------------------------------------------
// createSeason
// ---------------------------------------------------------------------------

export type CreateSeasonInput = {
  name: string;
  startDate: string;  // YYYY-MM-DD
  endDate: string;
  isActive: boolean;
  createdByUserId: string;
};

export async function createSeason(input: CreateSeasonInput): Promise<Season> {
  const id = nanoid(24);
  // Drizzle MySQL `date` columns require a Date object for inserts.
  // We parse the YYYY-MM-DD string and append noon UTC to avoid timezone shifts.
  const row = {
    id,
    name: input.name,
    startDate: new Date(`${input.startDate}T12:00:00.000Z`),
    endDate: new Date(`${input.endDate}T12:00:00.000Z`),
    isActive: input.isActive,
    createdByUserId: input.createdByUserId,
  };
  await db.insert(seasons).values(row);
  // Return with string dates matching Season select type
  return { ...row, startDate: input.startDate, endDate: input.endDate } as unknown as Season;
}

// ---------------------------------------------------------------------------
// updateSeason
// ---------------------------------------------------------------------------

export async function updateSeason(
  id: string,
  patch: Partial<CreateSeasonInput>,
): Promise<Season | null> {
  const existing = await getSeasonById(id);
  if (!existing) return null;

  const updated: Record<string, unknown> = {};
  if (patch.name !== undefined) updated.name = patch.name;
  if (patch.startDate !== undefined) {
    updated.startDate = new Date(`${patch.startDate}T12:00:00.000Z`);
  }
  if (patch.endDate !== undefined) {
    updated.endDate = new Date(`${patch.endDate}T12:00:00.000Z`);
  }
  if (patch.isActive !== undefined) updated.isActive = patch.isActive;

  if (Object.keys(updated).length > 0) {
    await db
      .update(seasons)
      .set(updated as Parameters<ReturnType<typeof db.update>["set"]>[0])
      .where(eq(seasons.id, id));
  }

  return getSeasonById(id);
}

// ---------------------------------------------------------------------------
// deleteSeason
// ---------------------------------------------------------------------------

export async function deleteSeason(id: string): Promise<boolean> {
  const existing = await getSeasonById(id);
  if (!existing) return false;
  await db.delete(seasons).where(eq(seasons.id, id));
  return true;
}

// ---------------------------------------------------------------------------
// listSeasonProducts
// ---------------------------------------------------------------------------

export async function listSeasonProducts(
  seasonId: string,
): Promise<SeasonalProduct[]> {
  return db
    .select()
    .from(seasonalProducts)
    .where(eq(seasonalProducts.seasonId, seasonId))
    .orderBy(seasonalProducts.createdAt) as unknown as Promise<SeasonalProduct[]>;
}

// ---------------------------------------------------------------------------
// addSeasonProduct
// ---------------------------------------------------------------------------

export type AddSeasonProductInput = {
  seasonId: string;
  qbItemId: string;
};

export async function addSeasonProduct(
  input: AddSeasonProductInput,
): Promise<SeasonalProduct> {
  const qbo = getQboClient();
  const item = await qbo.getItemById(input.qbItemId);

  const id = nanoid(24);
  const row = {
    id,
    seasonId: input.seasonId,
    qbItemId: input.qbItemId,
    sku: item?.Sku ?? item?.Name ?? input.qbItemId,
    name: item?.Name ?? input.qbItemId,
    description: null as string | null,
  };
  await db.insert(seasonalProducts).values(row);
  return row as unknown as SeasonalProduct;
}

// ---------------------------------------------------------------------------
// bulkAddSeasonProductsBySku
// ---------------------------------------------------------------------------

export type BulkAddResult = {
  added: SeasonalProduct[];
  failed: { sku: string; reason: string }[];
};

export async function bulkAddSeasonProductsBySku(input: {
  seasonId: string;
  skus: string[];
}): Promise<BulkAddResult> {
  const qbo = getQboClient();
  const added: SeasonalProduct[] = [];
  const failed: { sku: string; reason: string }[] = [];

  for (const sku of input.skus) {
    const trimmed = sku.trim();
    if (!trimmed) continue;
    try {
      const item = await qbo.getQboItemBySku(trimmed);
      if (!item) {
        failed.push({ sku: trimmed, reason: "SKU not found in QBO" });
        continue;
      }
      const id = nanoid(24);
      const row = {
        id,
        seasonId: input.seasonId,
        qbItemId: item.Id,
        sku: item.Sku ?? item.Name,
        name: item.Name,
        description: null as string | null,
      };
      await db.insert(seasonalProducts).values(row);
      added.push(row as unknown as SeasonalProduct);
    } catch (err) {
      failed.push({
        sku: trimmed,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { added, failed };
}

// ---------------------------------------------------------------------------
// removeSeasonProduct
// ---------------------------------------------------------------------------

export async function removeSeasonProduct(productId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(seasonalProducts)
    .where(eq(seasonalProducts.id, productId));
  if (rows.length === 0) return false;
  await db.delete(seasonalProducts).where(eq(seasonalProducts.id, productId));
  return true;
}

// ---------------------------------------------------------------------------
// importSeasonProductsCsv
// ---------------------------------------------------------------------------

export type ImportCsvResult = {
  added: number;
  failed: { row: number; reason: string }[];
};

export async function importSeasonProductsCsv(input: {
  seasonId: string;
  csv: string;
}): Promise<ImportCsvResult> {
  const lines = input.csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Strip header row if present (starts with "sku" case-insensitive)
  const dataLines =
    lines.length > 0 && /^sku\b/i.test(lines[0]!) ? lines.slice(1) : lines;

  const failed: { row: number; reason: string }[] = [];
  let added = 0;

  const qbo = getQboClient();

  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i]!;
    const parts = line.split(",").map((p) => p.trim());
    const sku = parts[0];
    const nameOverride = parts[1] ?? "";
    const descriptionOverride = parts[2] ?? "";

    if (!sku) {
      failed.push({ row: i + 1, reason: "Empty SKU" });
      continue;
    }

    try {
      const item = await qbo.getQboItemBySku(sku);
      if (!item) {
        failed.push({ row: i + 1, reason: `SKU '${sku}' not found in QBO` });
        continue;
      }
      const id = nanoid(24);
      await db.insert(seasonalProducts).values({
        id,
        seasonId: input.seasonId,
        qbItemId: item.Id,
        sku: item.Sku ?? item.Name,
        name: nameOverride || item.Name,
        description: descriptionOverride || null,
      });
      added++;
    } catch (err) {
      failed.push({
        row: i + 1,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { added, failed };
}

// ---------------------------------------------------------------------------
// exportSeasonProductsCsv
// ---------------------------------------------------------------------------

export async function exportSeasonProductsCsv(
  seasonId: string,
): Promise<string> {
  const products = await listSeasonProducts(seasonId);
  const header = "sku,name,description";
  const rows = products.map((p) => {
    const sku = csvEscape(p.sku);
    const name = csvEscape(p.name);
    const desc = csvEscape(p.description ?? "");
    return `${sku},${name},${desc}`;
  });
  return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// duplicateSeason
// ---------------------------------------------------------------------------

export type DuplicateSeasonInput = {
  fromSeasonId: string;
  newName: string;
  startDate: string;
  endDate: string;
  createdByUserId: string;
};

export async function duplicateSeason(
  input: DuplicateSeasonInput,
): Promise<Season> {
  // Create the new season
  const newSeason = await createSeason({
    name: input.newName,
    startDate: input.startDate,
    endDate: input.endDate,
    isActive: false,
    createdByUserId: input.createdByUserId,
  });

  // Copy all products from the source season
  const sourceProducts = await listSeasonProducts(input.fromSeasonId);
  for (const product of sourceProducts) {
    await db.insert(seasonalProducts).values({
      id: nanoid(24),
      seasonId: newSeason.id,
      qbItemId: product.qbItemId,
      sku: product.sku,
      name: product.name,
      description: product.description,
    });
  }

  return newSeason;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Simple CSV field escaping: wrap in quotes if it contains comma, quote, or newline
function csvEscape(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
