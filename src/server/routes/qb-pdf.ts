// Auth-gated PDF proxy for QBO invoice + credit-memo PDFs.
//
// QBO's /v3/company/{realm}/invoice/{id}/pdf endpoint returns the rendered
// PDF directly. We don't cache or persist anything — the route just streams
// the bytes back so the user's browser can open/download as a normal PDF
// link. Auth gates the proxy so only signed-in app users can pull
// customer financial documents.
//
// Mounted at /api/qb-pdf so the URL is `/api/qb-pdf/invoice/{qbId}` and
// `/api/qb-pdf/creditmemo/{qbId}`. Activity-timeline links to these
// directly via `<a href target="_blank">`.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { QboClient } from "../../integrations/qb/client.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.qb-pdf" });

const paramsSchema = z.object({
  kind: z.enum(["invoice", "creditmemo"]),
  qbId: z.string().regex(/^\d+$/, "qbId must be a numeric QBO id").max(32),
});

const qbPdfRoute: FastifyPluginAsync = async (app) => {
  app.get("/:kind/:qbId", async (req, reply) => {
    await requireAuth(req);
    const parse = paramsSchema.safeParse(req.params);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid params", details: parse.error.flatten() });
    }
    const { kind, qbId } = parse.data;

    try {
      const qb = new QboClient();
      const buffer = await qb.getPdf(kind, qbId);
      // Inline so the browser renders the PDF in a new tab rather than
      // forcing a download. Filename suggests a sensible download name
      // if the user clicks "Save".
      const filename = `${kind}-${qbId}.pdf`;
      reply
        .code(200)
        .header("Content-Type", "application/pdf")
        .header("Content-Length", buffer.byteLength.toString())
        .header(
          "Content-Disposition",
          `inline; filename="${filename}"`,
        );
      return reply.send(buffer);
    } catch (err) {
      log.error({ err, kind, qbId }, "qb pdf proxy failed");
      return reply.code(502).send({ error: "qb pdf fetch failed" });
    }
  });
};

export default qbPdfRoute;
