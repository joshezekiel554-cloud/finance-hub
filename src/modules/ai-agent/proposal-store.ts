import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";

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
