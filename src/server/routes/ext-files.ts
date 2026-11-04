// GET /api/files/qb-pdf/:kind/:qbId?exp&name&sig — the signed, short-lived
// PDF links the Feldart AI ops tools hand out (see lib/file-link.ts). No
// session: the signature IS the authorisation, minted only for ops members
// and only for the one document the tool returned. Streams QBO's rendered PDF.
// One QBO company holds both books (Torah Judaica is an origin inside the
// Feldart realm, split by doc-number prefix), so a qbId is unambiguous.

import type { FastifyPluginAsync } from "fastify";
import { hubSecrets } from "../lib/hub-service-auth.js";
import { readAiFile } from "../../lib/ai-file-store.js";
import { verifyQbPdfLink, verifyStoredFileLink } from "../../lib/file-link.js";
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

// GET /api/files/stored/:fileId?exp&name&sig — a file a Feldart AI tool
// already generated (e.g. a numbered statement). Streams the stored bytes
// only — no side effects, so prefetch / link scanners / double taps are safe.
export const storedFileRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { fileId: string }; Querystring: Record<string, unknown> }>(
    "/files/stored/:fileId",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const link = verifyStoredFileLink({
        secret: hubSecrets(),
        fileId: req.params.fileId,
        exp: req.query.exp,
        name: req.query.name,
        sig: req.query.sig,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      const bytes = link ? await readAiFile(link.fileId) : null;
      if (!link || !bytes) {
        return reply.code(403).type("text/plain").send("This link has expired or is not valid. Ask Feldart AI for a fresh one.");
      }
      return reply
        .code(200)
        .header("Content-Type", "application/pdf")
        .header("Content-Length", bytes.byteLength.toString())
        .header("Content-Disposition", attachmentDisposition(link.name))
        .header("Cache-Control", "private, no-store")
        .header("Referrer-Policy", "no-referrer")
        .send(bytes);
    },
  );
};
