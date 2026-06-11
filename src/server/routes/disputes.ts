// TJ dispute lifecycle endpoints.
//
// A TJ invoice a customer claims to have paid is parked (dispute_state=
// 'verifying') out of the active chase while we check with the Torah Judaica
// bookkeeper. Resolution is either "confirmed unpaid" (resume chasing) or
// "confirmed paid" (void it in QBO, which zeroes the balance and stamps the
// doc Voided). The transitions themselves live in
// modules/crm/dispute-actions.ts, shared with the AI agent's
// dispute_transition tool; these handlers map results to HTTP.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/auth.js";
import {
  disputeClaimsPaid,
  disputeResolvePaid,
  disputeResolveUnpaid,
  type DisputeActionResult,
} from "../../modules/crm/dispute-actions.js";

const claimsPaidSchema = z.object({
  note: z.string().max(2000).optional(),
});

const ERROR_STATUS: Record<
  Extract<DisputeActionResult, { kind: "error" }>["code"],
  number
> = {
  not_found: 404,
  not_tj: 400,
  already_resolved: 409,
  not_verifying: 409,
  no_sync_token: 409,
  qbo_void_failed: 502,
};

function sendResult(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  result: DisputeActionResult,
) {
  if (result.kind === "ok") {
    return reply.code(200).send({ ok: true, disputeState: result.disputeState });
  }
  return reply
    .code(ERROR_STATUS[result.code])
    .send({ error: result.message, code: result.code });
}

const disputesRoute: FastifyPluginAsync = async (app) => {
  // POST /:id/dispute/claims-paid — park a TJ invoice for verification.
  app.post("/:id/dispute/claims-paid", async (req, reply) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    const parse = claimsPaidSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    return sendResult(reply, await disputeClaimsPaid(id, user.id, parse.data.note));
  });

  // POST /:id/dispute/resolve-unpaid — confirmed still owed; resume chasing.
  app.post("/:id/dispute/resolve-unpaid", async (req, reply) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    return sendResult(reply, await disputeResolveUnpaid(id, user.id));
  });

  // POST /:id/dispute/resolve-paid — confirmed paid to TJ; void in QBO then
  // soft-void locally. QBO failure leaves state untouched (502, retryable).
  app.post("/:id/dispute/resolve-paid", async (req, reply) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    return sendResult(reply, await disputeResolvePaid(id, user.id));
  });
};

export default disputesRoute;
