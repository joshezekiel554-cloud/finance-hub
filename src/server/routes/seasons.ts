// REST routes for seasons + seasonal_products CRUD.
// Registered at /api/seasons by src/server/routes/index.ts.
//
// Conventions: zod body/param validation, requireAuth on every route,
// { error } on failure, 201 on creates, text/csv content-type for exports.
// CSV import uses multer (same pattern as returns-photos.ts).

import type { FastifyPluginAsync } from "fastify";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../lib/auth.js";
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
} from "../../modules/returns/seasons-service.js";

// ---------------------------------------------------------------------------
// Multer — CSV import (text/csv + multipart)
// ---------------------------------------------------------------------------

// Accept both multipart/form-data (browser file picker) and text/csv (direct
// upload). For the multipart path we use multer; for raw text/csv we read the
// body buffer directly.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single("file");

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const idParamSchema = z.object({ id: z.string().min(1) });
const productParamSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
});

const listQuerySchema = z.object({
  active: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

const createBodySchema = z.object({
  name: z.string().min(1).max(255),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD"),
  isActive: z.boolean().default(true),
});

const patchBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  isActive: z.boolean().optional(),
});

const addProductBodySchema = z.object({
  qbItemId: z.string().min(1).max(64),
});

const bulkPasteBodySchema = z.object({
  skus: z.array(z.string().min(1)).min(1).max(500),
});

const duplicateBodySchema = z.object({
  newName: z.string().min(1).max(255),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD"),
});

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const seasonsRoute: FastifyPluginAsync = async (app) => {
  // Allow multipart bodies for the CSV import route scope
  app.addContentTypeParser(
    /^multipart\/form-data/,
    (_req, _payload, done) => done(null),
  );

  // ==========================================================================
  // Seasons CRUD
  // ==========================================================================

  // ---- GET / ---------------------------------------------------------------
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid query", details: parse.error.flatten() };
    }
    const seasons = await listSeasons({ active: parse.data.active });
    return { seasons };
  });

  // ---- GET /:id ------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await requireAuth(req);
    const { id } = req.params;
    const season = await getSeasonById(id);
    if (!season) {
      reply.code(404);
      return { error: "Season not found" };
    }
    return season;
  });

  // ---- POST / --------------------------------------------------------------
  app.post("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = createBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    try {
      const season = await createSeason({
        ...parse.data,
        createdByUserId: user.id,
      });
      reply.code(201);
      return season;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : "Create failed" };
    }
  });

  // ---- PATCH /:id ----------------------------------------------------------
  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await requireAuth(req);
    const paramParse = idParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      reply.code(400);
      return { error: "Invalid params" };
    }
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const updated = await updateSeason(paramParse.data.id, parse.data);
    if (!updated) {
      reply.code(404);
      return { error: "Season not found" };
    }
    return updated;
  });

  // ---- DELETE /:id ---------------------------------------------------------
  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await requireAuth(req);
    const deleted = await deleteSeason(req.params.id);
    if (!deleted) {
      reply.code(404);
      return { error: "Season not found" };
    }
    reply.code(204);
    return null;
  });

  // ==========================================================================
  // Season products
  // ==========================================================================

  // ---- GET /:id/products ---------------------------------------------------
  app.get<{ Params: { id: string } }>("/:id/products", async (req, reply) => {
    await requireAuth(req);
    const products = await listSeasonProducts(req.params.id);
    return { products };
  });

  // ---- POST /:id/products — add single by qbItemId -------------------------
  app.post<{ Params: { id: string } }>("/:id/products", async (req, reply) => {
    await requireAuth(req);
    const paramParse = idParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      reply.code(400);
      return { error: "Invalid params" };
    }
    const parse = addProductBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    try {
      const product = await addSeasonProduct({
        seasonId: paramParse.data.id,
        qbItemId: parse.data.qbItemId,
      });
      reply.code(201);
      return product;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : "Add failed" };
    }
  });

  // ---- POST /:id/products/bulk-paste — add by SKU list ---------------------
  app.post<{ Params: { id: string } }>(
    "/:id/products/bulk-paste",
    async (req, reply) => {
      await requireAuth(req);
      const paramParse = idParamSchema.safeParse(req.params);
      if (!paramParse.success) {
        reply.code(400);
        return { error: "Invalid params" };
      }
      const parse = bulkPasteBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const result = await bulkAddSeasonProductsBySku({
        seasonId: paramParse.data.id,
        skus: parse.data.skus,
      });
      return result;
    },
  );

  // ---- POST /:id/products/import-csv — multipart CSV upload ---------------
  app.post<{ Params: { id: string } }>(
    "/:id/products/import-csv",
    async (req, reply) => {
      await requireAuth(req);
      const paramParse = idParamSchema.safeParse(req.params);
      if (!paramParse.success) {
        reply.code(400);
        return { error: "Invalid params" };
      }
      const seasonId = paramParse.data.id;

      // Use multer to parse the multipart body (same cast pattern as returns-photos.ts)
      await new Promise<void>((resolve, reject) => {
        uploadCsv(
          req.raw as Parameters<typeof uploadCsv>[0],
          reply.raw as Parameters<typeof uploadCsv>[1],
          (err) => (err ? reject(err) : resolve()),
        );
      });

      // multer puts the file on req.raw.file
      const rawReq = req.raw as unknown as {
        file?: { buffer: Buffer; mimetype: string };
      };

      if (!rawReq.file) {
        reply.code(400);
        return { error: "No file uploaded" };
      }

      const csv = rawReq.file.buffer.toString("utf-8");
      const result = await importSeasonProductsCsv({ seasonId, csv });
      return result;
    },
  );

  // ---- GET /:id/products/export-csv — download CSV -------------------------
  app.get<{ Params: { id: string } }>(
    "/:id/products/export-csv",
    async (req, reply) => {
      await requireAuth(req);
      const csv = await exportSeasonProductsCsv(req.params.id);
      void reply.header("Content-Type", "text/csv; charset=utf-8");
      void reply.header(
        "Content-Disposition",
        `attachment; filename="season-${req.params.id}-products.csv"`,
      );
      return csv;
    },
  );

  // ---- DELETE /:id/products/:productId ------------------------------------
  app.delete<{ Params: { id: string; productId: string } }>(
    "/:id/products/:productId",
    async (req, reply) => {
      await requireAuth(req);
      const paramParse = productParamSchema.safeParse(req.params);
      if (!paramParse.success) {
        reply.code(400);
        return { error: "Invalid params" };
      }
      const deleted = await removeSeasonProduct(paramParse.data.productId);
      if (!deleted) {
        reply.code(404);
        return { error: "Product not found" };
      }
      reply.code(204);
      return null;
    },
  );

  // ==========================================================================
  // Duplicate season
  // ==========================================================================

  // ---- POST /:id/duplicate -------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/:id/duplicate",
    async (req, reply) => {
      const user = await requireAuth(req);
      const paramParse = idParamSchema.safeParse(req.params);
      if (!paramParse.success) {
        reply.code(400);
        return { error: "Invalid params" };
      }
      const parse = duplicateBodySchema.safeParse(req.body);
      if (!parse.success) {
        reply.code(400);
        return { error: "Invalid body", details: parse.error.flatten() };
      }
      const season = await duplicateSeason({
        fromSeasonId: paramParse.data.id,
        newName: parse.data.newName,
        startDate: parse.data.startDate,
        endDate: parse.data.endDate,
        createdByUserId: user.id,
      });
      reply.code(201);
      return season;
    },
  );
};

export default seasonsRoute;
