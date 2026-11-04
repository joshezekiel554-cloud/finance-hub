// GET /api/files/qb-pdf/:kind/:qbId?exp&name&sig — the signed, short-lived
// PDF links the Feldart AI ops tools hand out (see lib/file-link.ts). No
// session: the signature IS the authorisation, minted only for ops members
// and only for the one document the tool returned. Streams QBO's rendered PDF.
// One QBO company holds both books (Torah Judaica is an origin inside the
// Feldart realm, split by doc-number prefix), so a qbId is unambiguous.

import type { FastifyPluginAsync } from "fastify";
import { hubSecrets } from "../lib/hub-service-auth.js";
import { verifyQbPdfLink, verifyStatementLink } from "../../lib/file-link.js";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { customers } from "../../db/schema/customers.js";
import { SendStatementError } from "../../modules/statements/index.js";
import { buildStatementPdfAttachment } from "../../modules/statements/send.js";
import { statementDownloadFilename } from "./statements.js";
import { createLogger } from "../../lib/logger.js";
import { QboClient } from "../../integrations/qb/client.js";
import { attachmentDisposition } from "./statements.js";

const log = createLogger({ component: "routes.ext-files" });

const extFilesRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { kind: string; qbId: string }; Querystring: Record<string, unknown> }>(
    "/files/qb-pdf/:kind/:qbId",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const link = verifyQbPdfLink({
        secret: hubSecrets(),
        kind: req.params.kind,
        qbId: req.params.qbId,
        exp: req.query.exp,
        name: req.query.name,
        sig: req.query.sig,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (!link) {
        return reply.code(403).type("text/plain").send("This link has expired or is not valid. Ask Feldart AI for a fresh one.");
      }
      try {
        const buffer = await new QboClient().getPdf(link.kind, link.qbId);
        log.info({ kind: link.kind, qbId: link.qbId }, "signed pdf served");
        return reply
          .code(200)
          .header("Content-Type", "application/pdf")
          .header("Content-Length", buffer.byteLength.toString())
          .header("Content-Disposition", attachmentDisposition(link.name).replace(/^attachment/, "inline"))
          .header("Cache-Control", "private, no-store")
          .header("Referrer-Policy", "no-referrer")
          .send(buffer);
      } catch (err) {
        log.error({ err, kind: link.kind, qbId: link.qbId }, "signed pdf fetch failed");
        return reply.code(502).type("text/plain").send("QuickBooks didn't return the PDF. Try again in a minute.");
      }
    },
  );
};

export default extFilesRoute;

// GET /api/files/statement/:customerId/:origin?exp&by&sig — a statement PDF
// from a signed Feldart AI link. Built (and numbered) on open, exactly like
// the customer page's Download statement; audited under the asker.
export const statementFileRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { customerId: string; origin: string }; Querystring: Record<string, unknown> }>(
    "/files/statement/:customerId/:origin",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const link = verifyStatementLink({
        secret: hubSecrets(),
        customerId: req.params.customerId,
        origin: req.params.origin,
        exp: req.query.exp,
        by: req.query.by,
        sig: req.query.sig,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (!link) {
        return reply.code(403).type("text/plain").send("This link has expired or is not valid. Ask Feldart AI for a fresh one.");
      }
      let built: Awaited<ReturnType<typeof buildStatementPdfAttachment>>;
      try {
        built = await buildStatementPdfAttachment(link.customerId, link.origin);
      } catch (err) {
        if (err instanceof SendStatementError) {
          return reply.code(409).type("text/plain").send(`No statement: ${err.message}`);
        }
        log.error({ err, customerId: link.customerId }, "signed statement build failed");
        return reply.code(502).type("text/plain").send("The statement couldn't be built right now. Try again in a minute.");
      }
      const [c] = await db.select({ displayName: customers.displayName }).from(customers).where(eq(customers.id, link.customerId)).limit(1);
      const filename = statementDownloadFilename(c?.displayName ?? "", built.statementNumber);
      try {
        await db.insert(auditLog).values({
          id: nanoid(24),
          userId: link.byUserId,
          action: "statement.download",
          entityType: "customer",
          entityId: link.customerId,
          before: null,
          after: { origin: link.origin, statementNumber: built.statementNumber, bytes: built.buffer.byteLength, via: "feldart_ai" },
        });
      } catch (err) {
        log.error({ err, customerId: link.customerId }, "statement download audit failed");
      }
      return reply
        .code(200)
        .header("Content-Type", "application/pdf")
        .header("Content-Length", built.buffer.byteLength.toString())
        .header("Content-Disposition", attachmentDisposition(filename))
        .header("Cache-Control", "private, no-store")
        .header("Referrer-Policy", "no-referrer")
        .send(built.buffer);
    },
  );
};
