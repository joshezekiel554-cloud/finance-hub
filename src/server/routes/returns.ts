import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createRma,
  getRmaById,
  listRmas,
  updateRma,
} from "../../modules/returns/index.js";
import {
  RMA_RETURN_TYPES,
  RMA_STATUSES,
} from "../../db/schema/returns.js";
import { requireAuth } from "../lib/auth.js";

const listQuerySchema = z.object({
  status: z.enum(RMA_STATUSES).optional(),
  type: z.enum(RMA_RETURN_TYPES).optional(),
  customerId: z.string().max(24).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const createBodySchema = z.object({
  customerId: z.string().min(1).max(24),
  qbCustomerId: z.string().min(1).max(64),
  returnType: z.enum(RMA_RETURN_TYPES),
  seasonId: z.string().max(24).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  originalEmail: z.string().max(50000).optional().nullable(),
});

const patchBodySchema = z.object({
  notes: z.string().max(5000).nullable().optional(),
  totalValue: z.string().optional(),
});

const returnsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const parse = listQuerySchema.safeParse(req.query);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid query", details: parse.error.flatten() };
    }
    const rows = await listRmas(parse.data);
    return { rmas: rows };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await requireAuth(req);
    const rma = await getRmaById(req.params.id);
    if (!rma) {
      reply.code(404);
      return { error: "RMA not found" };
    }
    return rma;
  });

  app.post("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = createBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    const rma = await createRma({
      ...parse.data,
      createdByUserId: user.id,
    });
    reply.code(201);
    return rma;
  });

  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await requireAuth(req);
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "Invalid body", details: parse.error.flatten() };
    }
    try {
      const updated = await updateRma(req.params.id, parse.data);
      if (!updated) {
        reply.code(404);
        return { error: "RMA not found" };
      }
      return updated;
    } catch (err) {
      reply.code(409);
      return { error: err instanceof Error ? err.message : "Update failed" };
    }
  });
};

export default returnsRoute;
