// Autopilot routes.
//
//   POST /api/autopilot/scan                          — enqueue a manual scan
//   GET  /api/autopilot/proposals                     — list active proposals
//   GET  /api/autopilot/proposals/:id                 — single proposal detail (for AI badge popover + page)
//   POST /api/autopilot/proposals/draft               — bulk AI draft for selected pending proposals
//   POST /api/autopilot/proposals/:id/approve         — enqueue execution of a drafted proposal (with stale-data guard)
//   POST /api/autopilot/proposals/:id/dismiss         — soft skip (re-pickup on next scan if still eligible)
//   POST /api/autopilot/proposals/:id/snooze          — silence for N hours regardless of state changes

import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db/index.js";
import { auditLog, chaseLog } from "../../db/schema/audit.js";
import {
  AI_PROPOSAL_CATEGORIES,
  aiProposals,
  type AiProposalCategory,
} from "../../db/schema/ai-proposals.js";
import {
  AUTOPILOT_EXECUTE_JOB,
  AUTOPILOT_SCAN_JOB,
  getQueues,
} from "../../jobs/queues.js";
import type { AutopilotScanJobData } from "../../jobs/definitions/autopilot-scan.js";
import type { AutopilotExecuteJobData } from "../../jobs/definitions/autopilot-execute.js";
import { requireAuth } from "../lib/auth.js";
import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { getToolByName } from "../../modules/ai-agent/tools.js";
import { createLogger } from "../../lib/logger.js";
import {
  buildDraftContext,
  type BuiltPrompt,
  type DraftContext,
} from "../../modules/ai-agent/voice.js";
import { toSystemParam } from "../../modules/ai-agent/prompts/system-param.js";

import {
  buildPrompt as buildChaseNextPrompt,
  TOOL_NAME as CHASE_NEXT_TOOL,
} from "../../modules/ai-agent/prompts/chase-next.js";
import {
  buildPrompt as buildCadenceStatementPrompt,
  TOOL_NAME as CADENCE_STATEMENT_TOOL,
} from "../../modules/ai-agent/prompts/cadence-statement.js";
import {
  buildPrompt as buildCadenceColdPrompt,
  TOOL_NAME as CADENCE_COLD_TOOL,
} from "../../modules/ai-agent/prompts/cadence-cold.js";
import {
  buildPrompt as buildOpsRmaStalledPrompt,
} from "../../modules/ai-agent/prompts/ops-rma-stalled.js";
import {
  buildPrompt as buildOpsCronFailPrompt,
  TOOL_NAME as OPS_CRON_FAIL_TOOL,
} from "../../modules/ai-agent/prompts/ops-cron-fail.js";
import {
  buildPrompt as buildTjChasePrompt,
  TOOL_NAME as TJ_CHASE_TOOL,
} from "../../modules/ai-agent/prompts/tj-chase.js";
import {
  buildPrompt as buildTjDisputeNudgePrompt,
  TOOL_NAME as TJ_DISPUTE_NUDGE_TOOL,
} from "../../modules/ai-agent/prompts/tj-dispute-nudge.js";

import { isStillEligible as isStillEligibleChase } from "../../modules/ai-agent/candidates/chase-next.js";
import { isStillEligible as isStillEligibleStatement } from "../../modules/ai-agent/candidates/cadence-statement.js";
import { isStillEligible as isStillEligibleCold } from "../../modules/ai-agent/candidates/cadence-cold.js";
import { isStillEligible as isStillEligibleRma } from "../../modules/ai-agent/candidates/ops-rma-stalled.js";
import { isStillEligible as isStillEligibleCronFail } from "../../modules/ai-agent/candidates/ops-cron-fail.js";
import { isStillEligible as isStillEligibleTjChase } from "../../modules/ai-agent/candidates/tj-chase.js";
import { isStillEligible as isStillEligibleTjDisputeNudge } from "../../modules/ai-agent/candidates/tj-dispute-nudge.js";

const log = createLogger({ module: "routes.autopilot" });

// Per-category prompt builders. ops-rma-stalled exports TOOL_NAMES (array)
// since the AI may choose between two tools; for the toolSchema passed to
// Anthropic we include both tools and let the AI pick.
// Partial so a category can register before its prompt lands — the draft
// loop skips those. All 7 current categories have prompts wired.
const PROMPTS: Partial<
  Record<
    AiProposalCategory,
    {
      build: (s: Record<string, unknown>, ctx: DraftContext) => BuiltPrompt;
      toolNames: string[];
    }
  >
> = {
  chase_next: { build: buildChaseNextPrompt, toolNames: [CHASE_NEXT_TOOL] },
  cadence_statement: {
    build: buildCadenceStatementPrompt,
    toolNames: [CADENCE_STATEMENT_TOOL],
  },
  cadence_cold: { build: buildCadenceColdPrompt, toolNames: [CADENCE_COLD_TOOL] },
  ops_rma_stalled: {
    build: buildOpsRmaStalledPrompt,
    toolNames: ["nudge_warehouse_email", "create_admin_notification"],
  },
  ops_cron_fail: { build: buildOpsCronFailPrompt, toolNames: [OPS_CRON_FAIL_TOOL] },
  // TJ book: tj_chase reuses the chase send tool (origin "tj" in the
  // drafted args); tj_dispute_nudge drafts a bookkeeper email — the
  // recipient is resolved from settings at execution, never by the AI.
  tj_chase: { build: buildTjChasePrompt, toolNames: [TJ_CHASE_TOOL] },
  tj_dispute_nudge: {
    build: buildTjDisputeNudgePrompt,
    toolNames: [TJ_DISPUTE_NUDGE_TOOL],
  },
};

// Partial so a category can register before its eligibility check lands —
// the approve path treats a missing entry as "no staleness check".
const STILL_ELIGIBLE: Partial<
  Record<AiProposalCategory, (id: string) => Promise<boolean>>
> = {
  chase_next: isStillEligibleChase,
  cadence_statement: isStillEligibleStatement,
  cadence_cold: isStillEligibleCold,
  ops_rma_stalled: isStillEligibleRma,
  ops_cron_fail: isStillEligibleCronFail,
  tj_chase: isStillEligibleTjChase,
  tj_dispute_nudge: isStillEligibleTjDisputeNudge,
};

const SONNET = "claude-sonnet-4-6";
const DRAFT_CONCURRENCY = 4;

const autopilotRoute: FastifyPluginAsync = async (app) => {
  // ── POST /scan ────────────────────────────────────────────────────────
  app.post("/scan", async (req, reply) => {
    const user = await requireAuth(req);
    const queues = getQueues();
    const job = await queues.autopilotScan.add(AUTOPILOT_SCAN_JOB, {
      trigger: "manual",
      triggeredByUserId: user.id,
    } as AutopilotScanJobData);
    return reply.send({ jobId: job.id });
  });

  // ── GET /proposals ────────────────────────────────────────────────────
  app.get("/proposals", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select()
      .from(aiProposals)
      .where(
        and(
          sql`${aiProposals.status} NOT IN ('executed', 'expired', 'superseded')`,
          or(
            sql`${aiProposals.status} != 'snoozed'`,
            sql`${aiProposals.snoozedUntil} <= NOW()`,
          ),
          sql`${aiProposals.expiresAt} > NOW()`,
        ),
      )
      .orderBy(desc(aiProposals.createdAt))
      .limit(500);
    return reply.send({ rows });
  });

  // ── GET /proposals/:id ────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/proposals/:id",
    async (req, reply) => {
      await requireAuth(req);
      const rows = await db
        .select()
        .from(aiProposals)
        .where(eq(aiProposals.id, req.params.id))
        .limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "not found" });
      return reply.send({ proposal: rows[0] });
    },
  );

  // ── POST /proposals/draft ─────────────────────────────────────────────
  // AI-draft for N selected pending proposals. Concurrency-capped to 4.
  app.post("/proposals/draft", async (req, reply) => {
    const user = await requireAuth(req);
    const schema = z.object({
      proposalIds: z.array(z.string().min(1).max(24)).min(1).max(50),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }

    const proposals = await db
      .select()
      .from(aiProposals)
      .where(inArray(aiProposals.id, parse.data.proposalIds));

    const results: Array<{ proposalId: string; status: string; error?: string }> = [];
    const anthropic = getAnthropicClient();

    for (let i = 0; i < proposals.length; i += DRAFT_CONCURRENCY) {
      const batch = proposals.slice(i, i + DRAFT_CONCURRENCY);
      await Promise.all(
        batch.map(async (p) => {
          if (p.status !== "pending") {
            results.push({ proposalId: p.id, status: `skipped (status=${p.status})` });
            return;
          }
          const cat = p.category as AiProposalCategory;
          const prompt = PROMPTS[cat];
          if (!prompt) {
            results.push({ proposalId: p.id, status: "skipped (no prompt for category)" });
            return;
          }

          await db
            .update(aiProposals)
            .set({ status: "drafting" })
            .where(eq(aiProposals.id, p.id));

          try {
            // Build the tool schema(s) for this category. We hand Anthropic
            // a minimal schema; the actual Zod validation happens in the
            // execute worker. AI is instructed (via prompt) to fill the
            // required args.
            const tools = prompt.toolNames.map((name) => ({
              name,
              description: `Execute ${name}`,
              // input_schema is intentionally permissive — the prompt is the
              // contract, and the execute worker validates with the canonical
              // Zod schema from tools.ts.
              input_schema: {
                type: "object" as const,
                additionalProperties: true,
                properties: {},
              },
            }));

            const customerId =
              p.entityType === "customer" ? p.entityId : null;
            const context = await buildDraftContext(
              cat,
              p.candidateSummary as Record<string, unknown>,
              customerId,
            );
            const built = prompt.build(
              p.candidateSummary as Record<string, unknown>,
              context,
            );
            const systemParam = toSystemParam(built.system);

            const response = await anthropic.messages.create({
              model: SONNET,
              max_tokens: 2000,
              tools,
              ...(systemParam ? { system: systemParam } : {}),
              messages: [{ role: "user", content: built.user }],
            });

            // Cost tracking (writes ai_interactions row).
            await trackUsage(response, {
              surface: "background_proposing",
              userId: user.id,
            });

            // Extract tool_use OR plain-text skip.
            let toolCall: { name: string; args: Record<string, unknown> } | null = null;
            let skipReason: string | null = null;
            for (const block of response.content) {
              if (block.type === "tool_use") {
                toolCall = {
                  name: block.name,
                  args: block.input as Record<string, unknown>,
                };
                break;
              }
              if (block.type === "text") {
                const text = block.text.trim();
                if (text.includes('"skip"')) {
                  try {
                    const parsed = JSON.parse(text);
                    if (parsed?.skip) {
                      skipReason = String(parsed.reason ?? "AI skip");
                    }
                  } catch {
                    // not JSON; ignore
                  }
                }
              }
            }

            if (toolCall) {
              const preview = JSON.stringify(toolCall.args).slice(0, 2000);
              await db
                .update(aiProposals)
                .set({
                  status: "drafted",
                  draftedAction: { tool: toolCall.name, args: toolCall.args },
                  draftedPreview: preview,
                  reasoning: null,
                  draftedAt: sql`CURRENT_TIMESTAMP`,
                })
                .where(eq(aiProposals.id, p.id));
              results.push({ proposalId: p.id, status: "drafted" });
            } else if (skipReason) {
              await db
                .update(aiProposals)
                .set({
                  status: "dismissed",
                  decidedAt: sql`CURRENT_TIMESTAMP`,
                  decidedByUserId: user.id,
                  reasoning: skipReason,
                })
                .where(eq(aiProposals.id, p.id));
              results.push({ proposalId: p.id, status: "ai-skipped" });
            } else {
              await db
                .update(aiProposals)
                .set({ status: "pending" })
                .where(eq(aiProposals.id, p.id));
              results.push({
                proposalId: p.id,
                status: "error",
                error: "AI returned neither tool_use nor skip",
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg, proposalId: p.id }, "AI draft failed");
            await db
              .update(aiProposals)
              .set({ status: "pending" })
              .where(eq(aiProposals.id, p.id));
            results.push({ proposalId: p.id, status: "error", error: msg });
          }
        }),
      );
    }

    return reply.send({ results });
  });

  // ── POST /proposals/:id/approve ───────────────────────────────────────
  // Body (all optional):
  //   editedArgs: Record<string, unknown>
  //     — if present, REPLACES drafted_action.args before execution.
  //       Lets the operator tweak the AI-drafted subject/body in the UI
  //       and have the edited values fire (instead of the original draft).
  //       Tool name stays the same (operator can't switch tools mid-approve).
  app.post<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/proposals/:id/approve",
    async (req, reply) => {
      const user = await requireAuth(req);
      const force = req.query.force === "true";

      const bodySchema = z
        .object({
          editedArgs: z.record(z.string(), z.unknown()).optional(),
        })
        .optional();
      const parse = bodySchema.safeParse(req.body ?? {});
      if (!parse.success) {
        return reply
          .code(400)
          .send({ error: "invalid body", details: parse.error.flatten() });
      }
      const editedArgs = parse.data?.editedArgs;

      const rows = await db
        .select()
        .from(aiProposals)
        .where(eq(aiProposals.id, req.params.id))
        .limit(1);
      const p = rows[0];
      if (!p) return reply.code(404).send({ error: "not found" });
      if (p.status !== "drafted" && p.status !== "pending") {
        return reply
          .code(409)
          .send({ error: `cannot approve from status ${p.status}` });
      }

      if (!force) {
        const stillEligibleFn = STILL_ELIGIBLE[p.category as AiProposalCategory];
        if (stillEligibleFn) {
          const ok = await stillEligibleFn(p.entityId);
          if (!ok) {
            return reply.code(409).send({
              stale: true,
              reason: "conditions changed since drafted; pass ?force=true to send anyway",
            });
          }
        }
      }

      // If operator edited the draft, persist the new args + preview
      // before queueing execution. Audit trail: ai_proposals.drafted_action
      // becomes the OPERATOR-APPROVED version; the original AI output is
      // overwritten (a follow-up could keep an edit history).
      if (editedArgs && p.draftedAction) {
        const existing = p.draftedAction as { tool: string; args: Record<string, unknown> };
        await db
          .update(aiProposals)
          .set({
            draftedAction: { tool: existing.tool, args: editedArgs },
            draftedPreview: JSON.stringify(editedArgs).slice(0, 2000),
          })
          .where(eq(aiProposals.id, p.id));
      }

      await db
        .update(aiProposals)
        .set({
          status: "approved",
          decidedAt: sql`CURRENT_TIMESTAMP`,
          decidedByUserId: user.id,
        })
        .where(eq(aiProposals.id, p.id));

      const queues = getQueues();
      await queues.autopilotExecute.add(AUTOPILOT_EXECUTE_JOB, {
        proposalId: p.id,
        userId: user.id,
      } as AutopilotExecuteJobData);

      return reply.send({ ok: true });
    },
  );

  // ── POST /proposals/:id/mark-executed ─────────────────────────────────
  // Used by the "Edit & Send" flow: the operator sent the email via the
  // full compose modal (/api/send), so the underlying action already
  // happened — we just close out the proposal WITHOUT running the tool
  // (avoids a double-send). For chase categories we still write the
  // chase_log row the tool would have written, so the 7-day re-propose
  // dedup keeps working.
  app.post<{ Params: { id: string } }>(
    "/proposals/:id/mark-executed",
    async (req, reply) => {
      const user = await requireAuth(req);
      const rows = await db
        .select()
        .from(aiProposals)
        .where(eq(aiProposals.id, req.params.id))
        .limit(1);
      const p = rows[0];
      if (!p) return reply.code(404).send({ error: "not found" });

      await db.transaction(async (tx) => {
        await tx
          .update(aiProposals)
          .set({
            status: "executed",
            decidedAt: sql`CURRENT_TIMESTAMP`,
            decidedByUserId: user.id,
            executedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(aiProposals.id, p.id));

        // Replicate the chase tool's chase_log side effect for chase
        // categories so dedup holds even when sent via the composer.
        if (
          (p.category === "chase_next" ||
            p.category === "cadence_cold" ||
            p.category === "tj_chase") &&
          p.entityType === "customer"
        ) {
          const tier = (p.candidateSummary as { tier?: string }).tier;
          const severity =
            tier === "CRITICAL"
              ? "critical"
              : tier === "HIGH"
                ? "high"
                : tier === "MEDIUM"
                  ? "medium"
                  : "low";
          await tx.insert(chaseLog).values({
            id: nanoid(24),
            customerId: p.entityId,
            userId: user.id,
            method: "email",
            severity,
            aiProposalId: p.id,
            notes: "Autopilot proposal sent via composer",
          });
        }
      });

      return reply.send({ ok: true });
    },
  );

  // ── POST /proposals/:id/dismiss ───────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/proposals/:id/dismiss",
    async (req, reply) => {
      const user = await requireAuth(req);
      const result = await db
        .update(aiProposals)
        .set({
          status: "dismissed",
          decidedAt: sql`CURRENT_TIMESTAMP`,
          decidedByUserId: user.id,
        })
        .where(eq(aiProposals.id, req.params.id));
      void result;
      return reply.send({ ok: true });
    },
  );

  // ── POST /proposals/:id/snooze ────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/proposals/:id/snooze",
    async (req, reply) => {
      const user = await requireAuth(req);
      const schema = z.object({ hours: z.number().int().min(1).max(24 * 90) });
      const parse = schema.safeParse(req.body);
      if (!parse.success) {
        return reply.code(400).send({ error: "invalid body" });
      }
      await db
        .update(aiProposals)
        .set({
          status: "snoozed",
          decidedAt: sql`CURRENT_TIMESTAMP`,
          decidedByUserId: user.id,
          snoozedUntil: sql`NOW() + INTERVAL ${parse.data.hours} HOUR`,
        })
        .where(eq(aiProposals.id, req.params.id));
      return reply.send({ ok: true });
    },
  );

  // ── POST /proposals/clear ─────────────────────────────────────────────
  // Bulk-clear the active suggestion queue so a fresh scan starts clean.
  // Removes all NON-executed proposals; executed ones are kept so their
  // audit trail + the AI badge on already-sent emails stay intact.
  app.post("/proposals/clear", async (req, reply) => {
    const user = await requireAuth(req);
    const counted = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(aiProposals)
      .where(sql`${aiProposals.status} <> 'executed'`);
    const deleted = Number(counted[0]?.n ?? 0);
    await db
      .delete(aiProposals)
      .where(sql`${aiProposals.status} <> 'executed'`);
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "ai_proposal.bulk_clear",
      entityType: "ai_proposal",
      entityId: "*",
      before: { deleted },
      after: null,
    });
    log.info({ userId: user.id, deleted }, "autopilot suggestions cleared");
    return reply.send({ ok: true, deleted });
  });

  // Reference unused imports so tsc doesn't complain about ops_rma_stalled
  // not having TOOL_NAME — it exports TOOL_NAMES instead, which is used
  // via the PROMPTS map above.
  void AI_PROPOSAL_CATEGORIES;
};

export default autopilotRoute;
