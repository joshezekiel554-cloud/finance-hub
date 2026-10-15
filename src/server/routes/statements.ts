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
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import {
  sendStatement,
  SendStatementError,
} from "../../modules/statements/index.js";
import { buildStatementPdfAttachment } from "../../modules/statements/send.js";

const log = createLogger({ component: "routes.statements" });

const paramsSchema = z.object({
  id: z.string().min(1).max(64),
});

const originSchema = z.enum(["feldart", "tj", "both"], {
  errorMap: () => ({
    message: "origin is required and must be 'feldart', 'tj' or 'both'",
  }),
});

// POST /:id/statement-download body. Exported for schema-level tests.
export const downloadBodySchema = z.object({ origin: originSchema });

// Download filename the operator asked for (2026-10-15):
// "<customer name>, <statement number>.pdf". Strips the characters
// Windows refuses in a filename so the browser never mangles it.
export function statementDownloadFilename(
  displayName: string,
  statementNumber: number,
): string {
  const name =
    displayName
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "Customer";
  return `${name}, ${statementNumber}.pdf`;
}

// RFC 6266 attachment header: an ASCII fallback plus the exact UTF-8
// name via filename* (RFC 5987 — encodeURIComponent leaves ' ( ) *
// unescaped, which attr-char forbids).
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Optional overrides from the operator's edits in the send dialog.
// When unset, the module falls back to the rendered template +
// per-channel resolver (the original behaviour). When set, those
// strings are used verbatim — gives the operator final say without
// rebuilding the whole pipeline server-side.
// Exported for schema-level route tests (no Fastify harness in repo).
export const sendBodySchema = z.object({
  // Which book the statement covers. Required. "both" renders the
  // combined two-box statement (Feldart box + Torah Judaica box +
  // overall totals) — reinstated by operator request 2026-07-14.
  origin: originSchema,
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
    const { userSignatureId, origin, ...overrides } = bodyParse.data;

    try {
      const result = await sendStatement({
        customerId,
        userId: user.id,
        origin,
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

  // POST /:id/statement-download — the customer page's one-click
  // "Download" (replaces Invoices → Statement → Preview → Save). Builds
  // the SAME PDF a send would attach (incl. the TJ-balance auto-upgrade
  // to combined) and returns it as an attachment. Nothing is emailed and
  // no statement_sends row is written, but a real statement number IS
  // allocated (it's printed on the PDF), so — like the chase zip
  // download — the allocation gets an audit row. POST, not GET, because
  // it consumes a number.
  app.post("/:id/statement-download", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = paramsSchema.safeParse(req.params);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid params", details: parse.error.flatten() });
    }
    const bodyParse = downloadBodySchema.safeParse(req.body ?? {});
    if (!bodyParse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: bodyParse.error.flatten() });
    }
    const { id: customerId } = parse.data;
    const { origin } = bodyParse.data;

    let built: Awaited<ReturnType<typeof buildStatementPdfAttachment>>;
    try {
      built = await buildStatementPdfAttachment(customerId, origin);
    } catch (err) {
      if (err instanceof SendStatementError) {
        log.warn(
          { err, customerId, userId: user.id, code: err.code },
          "statement download rejected",
        );
        return reply
          .code(mapErrorToStatus(err.code))
          .send({ error: err.message, code: err.code });
      }
      log.error(
        { err, customerId, userId: user.id },
        "statement download failed unexpectedly",
      );
      const message = err instanceof Error ? err.message : "build failed";
      return reply.code(500).send({ error: message });
    }

    const customerRows = await db
      .select({ displayName: customers.displayName })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    const filename = statementDownloadFilename(
      customerRows[0]?.displayName ?? "",
      built.statementNumber,
    );

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "statement.download",
      entityType: "customer",
      entityId: customerId,
      before: null,
      after: {
        origin,
        statementNumber: built.statementNumber,
        bytes: built.buffer.byteLength,
      },
    });
    log.info(
      {
        customerId,
        userId: user.id,
        origin,
        statementNumber: built.statementNumber,
      },
      "statement downloaded",
    );

    return reply
      .code(200)
      .header("Content-Type", "application/pdf")
      .header("Content-Length", built.buffer.byteLength.toString())
      .header("Content-Disposition", attachmentDisposition(filename))
      .send(built.buffer);
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
