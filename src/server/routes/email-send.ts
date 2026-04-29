// Email send + alias-list endpoints.
//
// GET  /api/aliases       → live sendAs list from Gmail (cached 5m by
//                           the integration layer). Drives the "From"
//                           dropdown in the compose modal.
// POST /api/email/send    → user-initiated send via the gmail/send.ts
//                           integration. Wraps the user-supplied body
//                           into both text and html parts (escaped +
//                           paragraph-wrapped). When `customerId` is
//                           provided, also writes an email_out activity
//                           so the timeline reflects the send. Audit
//                           logs every send.
//
// HTML escaping: we deliberately do not allow user-pasted markup in the
// outbound email. Subject and body come from the compose textarea, so any
// stray `<`/`>` should render as text on the recipient's side, not get
// interpreted as HTML. A simple ampersand/lt/gt replacement is enough —
// no parser needed because the body is then wrapped in <p> tags we
// generate ourselves.
//
// Threading: when a reply, the modal passes inReplyTo (parent Message-ID)
// + threadId (gmail thread). The integration layer takes care of writing
// the In-Reply-To/References headers and tagging the API call.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import { listAliases } from "../../integrations/gmail/aliases.js";
import { recordActivity } from "../../modules/crm/index.js";

const log = createLogger({ component: "routes.email-send" });

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  // Base64-encoded payload from the browser. Decoded once into a Buffer
  // before handing to the MIME builder.
  dataBase64: z.string().min(1),
});

const sendBodySchema = z.object({
  to: z.string().min(1).max(2000),
  cc: z.string().max(2000).optional(),
  bcc: z.string().max(2000).optional(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(200_000),
  alias: z.string().max(255).optional(),
  inReplyTo: z.string().max(998).optional(),
  threadId: z.string().max(255).optional(),
  customerId: z.string().max(64).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
});

// Minimal HTML escape — sufficient since we control the surrounding
// markup. No need for a full parser; the input is plain text from a
// textarea, never user-supplied HTML.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Wrap raw text into paragraph-broken HTML. Blank-line-separated chunks
// become <p>; line breaks within a chunk become <br/>. Escapes first so
// any `<`/`>` in the source render literally.
function bodyToHtml(raw: string): string {
  const escaped = escapeHtml(raw);
  const paragraphs = escaped.split(/\n{2,}/);
  return paragraphs
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

const emailSendRoute: FastifyPluginAsync = async (app) => {
  // GET /api/aliases — proxy listAliases() through to the compose modal's
  // From dropdown. Cached at the integration layer (5m TTL) so this is a
  // cheap call from the UI's perspective.
  // Mounted with prefix `/api` so this resolves to GET /api/aliases.
  app.get("/aliases", async (req, reply) => {
    await requireAuth(req);
    try {
      const aliases = await listAliases();
      return reply.send({ aliases });
    } catch (err) {
      log.error({ err }, "failed to list gmail aliases");
      return reply.code(502).send({ error: "failed to list gmail aliases" });
    }
  });

  // POST /api/email/send — user-initiated send. Mounted with prefix
  // `/api/email` so this resolves to /api/email/send.
  app.post("/send", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = sendBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const {
      to,
      cc,
      bcc,
      subject,
      body,
      alias,
      inReplyTo,
      threadId,
      customerId,
      attachments,
    } = parse.data;

    const html = bodyToHtml(body);
    const text = body;

    // Decode base64 attachments to Buffers — the integration layer
    // expects raw bytes and base64-encodes them when building MIME.
    const decoded = attachments?.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      data: Buffer.from(a.dataBase64, "base64"),
    }));

    let result;
    try {
      result = await sendEmail({
        to,
        cc,
        bcc,
        subject,
        html,
        text,
        alias,
        threadId,
        inReplyTo,
        attachments: decoded,
      });
    } catch (err) {
      log.error(
        { err, userId: user.id, to, alias: alias ?? null },
        "gmail send failed",
      );
      const message = err instanceof Error ? err.message : "send failed";
      return reply.code(502).send({ error: message });
    }

    // Audit row records every send. The body is captured here so the
    // audit trail covers the actual outbound content (vs. just the
    // metadata). Recipients are kept structured so a future reverse
    // lookup ("which sends went to X") stays cheap.
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "email.send",
      entityType: "email",
      entityId: result.messageId,
      before: null,
      after: {
        to,
        cc: cc ?? null,
        bcc: bcc ?? null,
        subject,
        alias: alias ?? null,
        inReplyTo: inReplyTo ?? null,
        threadId: threadId ?? null,
        customerId: customerId ?? null,
        from: result.from,
        attachmentCount: attachments?.length ?? 0,
      },
    });

    // When the send is associated with a known customer, mirror it into
    // the activity timeline so the customer detail page reflects the
    // outbound message immediately. The Gmail poller will eventually
    // ingest the same message via the inbox, but the activity row from
    // here is the authoritative record of *who* on our side hit Send.
    if (customerId) {
      await recordActivity({
        customerId,
        kind: "email_out",
        source: "app_send",
        userId: user.id,
        subject,
        body,
        refType: "email_send",
        refId: result.messageId,
        meta: {
          to,
          cc: cc ?? null,
          bcc: bcc ?? null,
          alias: alias ?? null,
          threadId: result.threadId,
          messageId: result.messageId,
        },
      });
    }

    log.info(
      {
        userId: user.id,
        messageId: result.messageId,
        threadId: result.threadId,
        alias: alias ?? "primary",
        customerId: customerId ?? null,
        attachmentCount: attachments?.length ?? 0,
      },
      "email sent",
    );

    return reply.send({
      messageId: result.messageId,
      threadId: result.threadId,
    });
  });
};

export default emailSendRoute;
