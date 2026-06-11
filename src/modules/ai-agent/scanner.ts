// Autopilot scanner. Runs deterministic SQL across the 5 v0 candidate
// categories, dedupes against in-flight / snoozed / recently-rejected
// proposals, and inserts new ai_proposals rows in status='pending' for
// each fresh candidate. NO AI calls during scan — drafting happens
// later when the operator clicks "Draft for selected" on /autopilot.

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  AI_PROPOSAL_CATEGORIES,
  aiProposals,
  type AiProposalCategory,
} from "../../db/schema/ai-proposals.js";
import { aiScans } from "../../db/schema/ai-scans.js";
import { notifications } from "../../db/schema/notifications.js";
import { createLogger } from "../../lib/logger.js";
import { findCandidates as chaseNext } from "./candidates/chase-next.js";
import { findCandidates as cadenceStatement } from "./candidates/cadence-statement.js";
import { findCandidates as cadenceCold } from "./candidates/cadence-cold.js";
import { findCandidates as opsRmaStalled } from "./candidates/ops-rma-stalled.js";
import { findCandidates as opsCronFail } from "./candidates/ops-cron-fail.js";
import { findCandidates as tjChase } from "./candidates/tj-chase.js";
import { findCandidates as tjDisputeNudge } from "./candidates/tj-dispute-nudge.js";

const log = createLogger({ module: "ai-agent.scanner" });

type Candidate = {
  entityType: string;
  entityId: string;
  // Which book the candidate belongs to. Chase finders stamp it
  // ('feldart'/'tj'); book-agnostic categories (cadence_*, ops_*) leave it
  // unset → ai_proposals.origin NULL.
  origin?: "feldart" | "tj";
  summary: Record<string, unknown>;
};

// Partial so a category can be registered in AI_PROPOSAL_CATEGORIES before
// its finder lands — the scan loop warn-logs and skips those (see below).
// All 7 current categories have finders wired.
// Categories that never have a finder: chat_action proposals are created
// by the agent loop, not the scanner.
const FINDERLESS_CATEGORIES = new Set<string>(["chat_action"]);

const FINDERS: Partial<
  Record<AiProposalCategory, () => Promise<Candidate[]>>
> = {
  chase_next: chaseNext as () => Promise<Candidate[]>,
  cadence_statement: cadenceStatement as () => Promise<Candidate[]>,
  cadence_cold: cadenceCold as () => Promise<Candidate[]>,
  ops_rma_stalled: opsRmaStalled as () => Promise<Candidate[]>,
  ops_cron_fail: opsCronFail as () => Promise<Candidate[]>,
  tj_chase: tjChase as () => Promise<Candidate[]>,
  tj_dispute_nudge: tjDisputeNudge as () => Promise<Candidate[]>,
};

const PROPOSAL_TTL_DAYS = 7;
const REJECT_THROTTLE_HOURS = 48;

export async function runScan(
  trigger: "cron" | "manual",
  userId?: string,
): Promise<{ scanId: string; proposalsGenerated: number; totalCandidates: number }> {
  const scanId = nanoid(24);
  await db.insert(aiScans).values({
    id: scanId,
    trigger,
    triggeredByUserId: userId ?? null,
  });

  let totalCandidates = 0;
  let proposalsGenerated = 0;

  for (const category of AI_PROPOSAL_CATEGORIES) {
    if (FINDERLESS_CATEGORIES.has(category)) continue;
    const finder = FINDERS[category];
    if (!finder) {
      // Should not happen in steady state — every registered category ought
      // to have a finder. Warn (not silent-skip) so a category added to
      // AI_PROPOSAL_CATEGORIES without scanner wiring is visible in logs.
      log.warn(
        { category },
        "proposal category registered but no candidate finder wired; skipping",
      );
      continue;
    }
    let candidates: Candidate[] = [];
    try {
      candidates = await finder();
    } catch (err) {
      log.error({ err, category }, "candidate finder failed");
      continue;
    }
    totalCandidates += candidates.length;
    if (candidates.length === 0) continue;

    const entityIds = candidates.map((c) => c.entityId);
    const blocked = await db
      .select({ entityId: aiProposals.entityId })
      .from(aiProposals)
      .where(
        and(
          inArray(aiProposals.entityId, entityIds),
          eq(aiProposals.entityType, candidates[0]!.entityType),
          // Scope the block to THIS category. Without it, any active proposal
          // of one category (e.g. chase_next) for a customer suppressed every
          // other category (e.g. cadence_statement) for that same customer —
          // distinct, both-valid actions were silently lost.
          eq(aiProposals.category, category),
          or(
            inArray(aiProposals.status, ["pending", "drafting", "drafted"]),
            and(
              eq(aiProposals.status, "snoozed"),
              sql`${aiProposals.snoozedUntil} > NOW()`,
            ),
            and(
              eq(aiProposals.status, "rejected"),
              sql`${aiProposals.createdAt} > NOW() - INTERVAL ${REJECT_THROTTLE_HOURS} HOUR`,
            ),
          ),
        ),
      );
    const blockedIds = new Set(blocked.map((b) => b.entityId));

    const fresh = candidates.filter((c) => !blockedIds.has(c.entityId));

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PROPOSAL_TTL_DAYS * 86400 * 1000,
    );

    for (const c of fresh) {
      const proposalId = nanoid(24);
      await db.insert(aiProposals).values({
        id: proposalId,
        category,
        origin: c.origin ?? null,
        entityType: c.entityType,
        entityId: c.entityId,
        status: "pending",
        candidateSummary: c.summary,
        scanId,
        expiresAt,
      });

      if (userId) {
        await db
          .insert(notifications)
          .values({
            id: nanoid(24),
            userId,
            kind: "ai_proposal",
            refType: "ai_proposal",
            refId: proposalId,
          } as never);
      }
      proposalsGenerated++;
    }
  }

  await db
    .update(aiScans)
    .set({
      finishedAt: sql`CURRENT_TIMESTAMP`,
      totalCandidates,
      proposalsGenerated,
    })
    .where(eq(aiScans.id, scanId));

  log.info(
    { scanId, trigger, totalCandidates, proposalsGenerated },
    "autopilot scan complete",
  );
  return { scanId, proposalsGenerated, totalCandidates };
}
