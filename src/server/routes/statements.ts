// POST /api/customers/:id/statement-send — orchestrate a statement-of-
// account send for one customer.
//
// Auth-gated. Delegates everything (data load, QBO calls, Gmail send,
// activity + audit logging) to the statements module — this route is
// the thin HTTP wrapper. SendStatementError.code is mapped to a
// distinct HTTP status so the UI can show a sensible message rather
// than a generic 500.
//
// Mounting: registered by team-lead in src/server/routes/index.ts at
// the same `/api/customers` prefix used by other per-customer routes
// (holds, etc.). The :id segment matches a customers.id.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import {
  sendStatement,
  SendStatementError,
} from "../../modules/statements/index.js";

const log = createLogger({ component: "routes.statements" });

const paramsSchema = z.object({
  id: z.string().min(1).max(64),
});

// Optional overrides from the operator's edits in the send dialog.
// When unset, the module falls back to the rendered template +
// per-channel resolver (the original behaviour). When set, those
// strings are used verbatim — gives the operator final say without
// rebuilding the whole pipeline server-side.
const sendBodySchema = z.object({
  subject: z.string().min(1).max(998).optional(),
  body: z.string().min(1).max(200_000).optional(),
  to: z.string().max(2000).optional(),
  cc: z.string().max(2000).optional(),
  bcc: z.string().max(2000).optional(),
  userSignatureId: z.string().nullable().optional(),
});

const statementsRoute: FastifyPluginAsync = async (app) => {
  app.post("/:id/statement-send", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = paramsSchema.safeParse(req.params);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid params", details: parse.error.flatten() });
    }
    const bodyParse = sendBodySchema.safeParse(req.body ?? {});
    if (!bodyParse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: bodyParse.error.flatten() });
    }
    const { id: customerId } = parse.data;
    const { userSignatureId, ...overrides } = bodyParse.data;

    try {
      const result = await sendStatement({
        customerId,
        userId: user.id,
        overrides:
          Object.values(overrides).some((v) => v !== undefined)
            ? overrides
            : undefined,
        // Tri-state: string = specific signature, null = explicit skip,
        // undefined (key absent from body) = fall back to operator default.
        // Don't collapse undefined → null; AppendContext treats them
        // differently.
        userSignatureId,
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof SendStatementError) {
        // 404: customer or template missing.
        // 400: precondition fail (no email, no open invoices, too many).
        // 502: QBO or Gmail upstream failure.
        const status = mapErrorToStatus(err.code);
        log.warn(
          { err, customerId, userId: user.id, code: err.code },
          "statement send rejected",
        );
        return reply.code(status).send({
          error: err.message,
          code: err.code,
        });
      }
      log.error(
        { err, customerId, userId: user.id },
        "statement send failed unexpectedly",
      );
      const message = err instanceof Error ? err.message : "send failed";
      return reply.code(500).send({ error: message });
    }
  });
};

function mapErrorToStatus(code: SendStatementError["code"]): number {
  switch (code) {
    case "customer_not_found":
    case "template_not_found":
      return 404;
    case "no_primary_email":
    case "no_open_invoices":
    case "too_many_invoices":
      return 400;
    case "qbo_failed":
    case "send_failed":
      return 502;
    default:
      return 500;
  }
}

export default statementsRoute;
