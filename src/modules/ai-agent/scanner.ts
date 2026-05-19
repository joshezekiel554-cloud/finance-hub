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

const log = createLogger({ module: "ai-agent.scanner" });

type Candidate = {
  entityType: string;
  entityId: string;
  summary: Record<string, unknown>;
};

const FINDERS: Record<AiProposalCategory, () => Promise<Candidate[]>> = {
  chase_next: chaseNext as () => Promise<Candidate[]>,
  cadence_statement: cadenceStatement as () => Promise<Candidate[]>,
  cadence_cold: cadenceCold as () => Promise<Candidate[]>,
  ops_rma_stalled: opsRmaStalled as () => Promise<Candidate[]>,
  ops_cron_fail: opsCronFail as () => Promise<Candidate[]>,
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
    let candidates: Candidate[] = [];
    try {
      candidates = await FINDERS[category]();
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
