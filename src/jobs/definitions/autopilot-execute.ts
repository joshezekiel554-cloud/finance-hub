// Autopilot approve-execute worker. Picks up an `approved` ai_proposal,
// looks up the tool from the registry, validates args with the tool's
// canonical Zod schema, calls execute(), and marks the proposal as
// executed or execution_failed.

import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";
import { getToolByName } from "../../modules/ai-agent/tools.js";
import {
  markProposalExecuted,
  markProposalExecutionFailed,
} from "../../modules/ai-agent/proposal-store.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.autopilot-execute" });

export type AutopilotExecuteJobData = {
  proposalId: string;
  userId: string;
};

export type AutopilotExecuteJobResult = { ok: boolean; error?: string };

export async function autopilotExecuteHandler(
  job: Job<AutopilotExecuteJobData>,
): Promise<AutopilotExecuteJobResult> {
  const { proposalId, userId } = job.data;
  log.info({ jobId: job.id, proposalId }, "autopilot execute starting");

  const rows = await db
    .select()
    .from(aiProposals)
    .where(eq(aiProposals.id, proposalId))
    .limit(1);
  const proposal = rows[0];
  if (!proposal) {
    await markProposalExecutionFailed(proposalId, "proposal not found");
    return { ok: false, error: "proposal not found" };
  }
  if (!proposal.draftedAction) {
    await markProposalExecutionFailed(
      proposalId,
      "proposal has no drafted_action — cannot execute",
    );
    return { ok: false, error: "no drafted_action" };
  }

  const action = proposal.draftedAction as {
    tool: string;
    args: Record<string, unknown>;
  };
  const tool = getToolByName(action.tool);
  if (!tool) {
    await markProposalExecutionFailed(
      proposalId,
      `tool '${action.tool}' not in registry`,
    );
    return { ok: false, error: `unknown tool: ${action.tool}` };
  }

  const parse = tool.argsSchema.safeParse(action.args);
  if (!parse.success) {
    const msg = `args validation failed: ${JSON.stringify(parse.error.flatten())}`;
    await markProposalExecutionFailed(proposalId, msg);
    return { ok: false, error: msg };
  }

  const result = await tool.execute(parse.data, { userId, proposalId });
  if (result.ok) {
    await markProposalExecuted(proposalId);
    // note = degraded success: the email went out but a post-send
    // bookkeeping write failed (the tool already error-logged the detail).
    log.info(
      { proposalId, tool: action.tool, note: result.note ?? null },
      "autopilot execute ok",
    );
    return { ok: true };
  } else {
    await markProposalExecutionFailed(proposalId, result.error);
    log.error(
      { proposalId, tool: action.tool, err: result.error },
      "autopilot execute failed",
    );
    return { ok: false, error: result.error };
  }
}
