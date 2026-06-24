import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals, type AiProposal } from "../../db/schema/ai-proposals.js";
import {
  AUTOPILOT_EXECUTE_JOB,
  getQueues,
} from "../../jobs/queues.js";
import type { AutopilotExecuteJobData } from "../../jobs/definitions/autopilot-execute.js";
import { isDangerousAction } from "../agent/chat-proposals.js";

export type ProposalActionResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "wrong_status" | "confirmation_required";
      status?: string;
    };

// Shared approve path (used by the autopilot route AND the inbox board's
// /api/ext task-card action). Sets status=approved + enqueues the same execute
// job. The dangerous-action typed-VOID gate + editedArgs + stale guard live in
// the autopilot HTTP route (operator UI). This shared helper is the plain
// enqueue path used by surfaces that CAN'T collect a typed confirmation (the
// board), so it FAILS CLOSED on a dangerous proposal: an irreversible action
// (e.g. paid_void) is never approvable from here — only the confirming UI may
// approve it. userId must be a real finance user id (the AI execute tool + cost
// tracking require a non-null actor).
export async function approveProposalAndEnqueue(
  proposalId: string,
  userId: string,
): Promise<ProposalActionResult> {
  const rows = await db
    .select()
    .from(aiProposals)
    .where(eq(aiProposals.id, proposalId))
    .limit(1);
  const p: AiProposal | undefined = rows[0];
  if (!p) return { ok: false, reason: "not_found" };
  if (p.status !== "drafted" && p.status !== "pending") {
    return { ok: false, reason: "wrong_status", status: p.status };
  }
  // Defense in depth (this helper has no typed-confirmation channel): a
  // dangerous/irreversible proposal can NEVER be approved through the board.
  if (
    p.draftedAction &&
    isDangerousAction(p.draftedAction.tool, p.draftedAction.args)
  ) {
    return { ok: false, reason: "confirmation_required" };
  }

  await db
    .update(aiProposals)
    .set({
      status: "approved",
      decidedAt: sql`CURRENT_TIMESTAMP`,
      decidedByUserId: userId,
    })
    .where(eq(aiProposals.id, p.id));

  const queues = getQueues();
  await queues.autopilotExecute.add(AUTOPILOT_EXECUTE_JOB, {
    proposalId: p.id,
    userId,
  } as AutopilotExecuteJobData);

  return { ok: true };
}

// Shared reject path (mirrors the autopilot route's dismiss, but sets the
// terminal 'rejected' status the board uses). userId nullable: a board action
// whose actor has no finance account still rejects, attribution captured in a
// separate audit row by the caller. decided_by_user_id is a nullable FK.
export async function rejectProposal(
  proposalId: string,
  userId: string | null,
): Promise<ProposalActionResult> {
  const rows = await db
    .select({ id: aiProposals.id })
    .from(aiProposals)
    .where(eq(aiProposals.id, proposalId))
    .limit(1);
  if (!rows[0]) return { ok: false, reason: "not_found" };

  await db
    .update(aiProposals)
    .set({
      status: "rejected",
      decidedAt: sql`CURRENT_TIMESTAMP`,
      decidedByUserId: userId,
    })
    .where(eq(aiProposals.id, proposalId));
  return { ok: true };
}

export async function markProposalExecuted(
  proposalId: string,
): Promise<void> {
  await db
    .update(aiProposals)
    .set({ status: "executed", executedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(aiProposals.id, proposalId));
}

export async function markProposalExecutionFailed(
  proposalId: string,
  error: string,
): Promise<void> {
  await db
    .update(aiProposals)
    .set({
      status: "execution_failed",
      executionError: error,
    })
    .where(eq(aiProposals.id, proposalId));
}
