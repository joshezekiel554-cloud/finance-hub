// Confirm / cancel for Feldart AI (hub) proposals — the ONE contract every
// app follows (radio 2026-11-03):
//   200 {status:"applied"|"cancelled", message, link?}
//   4xx {error, code}  code: expired 410 | stale 409 | forbidden 403 | failed 502
// Only the member who was shown the card can settle it (hubActor), within
// 15 min. Confirm CLAIMS the row atomically (drafted → approved) before
// enqueueing, so a double click can never send an email twice; then waits
// briefly for the executor so the card can say what actually happened.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiProposals, type AiProposal } from "../../db/schema/ai-proposals.js";
import { AUTOPILOT_EXECUTE_JOB, getQueues } from "../../jobs/queues.js";
import type { AutopilotExecuteJobData } from "../../jobs/definitions/autopilot-execute.js";
import { isDangerousAction } from "../agent/chat-proposals.js";
import { buildPreview, HUB_PROPOSAL_TTL_MS, previewDrift, type PreviewRow } from "./ops-finance-writes.js";

export type SettleReply =
  | { http: 200; body: { status: "applied" | "cancelled"; message: string; link?: string } }
  | { http: 403 | 409 | 410 | 502; body: { error: string; code: "forbidden" | "stale" | "expired" | "failed" } };

const refuse = (http: 403 | 409 | 410 | 502, code: "forbidden" | "stale" | "expired" | "failed", error: string): SettleReply => ({
  http,
  body: { error, code },
});

export type ProposalView = Pick<AiProposal, "status" | "createdAt" | "candidateSummary" | "draftedAction" | "executionError">;

/**
 * What a confirm/cancel may do with this row, before any write. Pure.
 * "proceed" = claim + run (confirm) or claim + reject (cancel).
 */
export function decideSettle(
  p: ProposalView | null,
  action: "confirm" | "cancel",
  actorEmail: string,
  now: Date,
): { kind: "proceed" } | { kind: "wait" } | { kind: "reply"; reply: SettleReply } {
  if (!p || (p.candidateSummary as { via?: unknown }).via !== "hub") {
    return { kind: "reply", reply: refuse(410, "expired", "This proposal isn't known to finance (it may have expired). Ask again.") };
  }
  const creator = String((p.candidateSummary as { hubActor?: unknown }).hubActor ?? "");
  if (creator !== actorEmail.trim().toLowerCase()) {
    return { kind: "reply", reply: refuse(403, "forbidden", "Only the person who asked for this change can confirm or cancel it.") };
  }
  const summary = String((p.candidateSummary as { summary?: unknown }).summary ?? "the change");
  switch (p.status) {
    case "executed":
      return action === "confirm"
        ? { kind: "reply", reply: { http: 200, body: { status: "applied", message: `Already done: ${summary}.` } } }
        : { kind: "reply", reply: refuse(409, "stale", "Too late to cancel — this change has already been made.") };
    case "rejected":
    case "dismissed":
      return action === "cancel"
        ? { kind: "reply", reply: { http: 200, body: { status: "cancelled", message: "Cancelled — nothing was changed." } } }
        : { kind: "reply", reply: refuse(409, "stale", "This proposal was cancelled. Ask again if you still want it.") };
    case "execution_failed":
      return { kind: "reply", reply: refuse(502, "failed", `It failed: ${p.executionError ?? "unknown error"}. Nothing else was changed; ask again to retry.`) };
    case "approved":
      return action === "confirm"
        ? { kind: "wait" }
        : { kind: "reply", reply: refuse(409, "stale", "Too late to cancel — it's already running.") };
    case "drafted":
      break;
    default:
      return { kind: "reply", reply: refuse(410, "expired", "This proposal has expired. Ask again.") };
  }
  if (now.getTime() - new Date(p.createdAt).getTime() > HUB_PROPOSAL_TTL_MS) {
    return { kind: "reply", reply: refuse(410, "expired", "This proposal is more than 15 minutes old. Ask again so it's checked against the latest data.") };
  }
  if (action === "confirm" && p.draftedAction && isDangerousAction(p.draftedAction.tool, p.draftedAction.args)) {
    return { kind: "reply", reply: refuse(403, "forbidden", "This change can only be made in finance.feldart.com.") };
  }
  return { kind: "proceed" };
}

/** Re-build the card from live data; a difference means "ask again". */
async function staleness(p: AiProposal): Promise<string | null> {
  const shown = (p.candidateSummary as { preview?: PreviewRow[] }).preview;
  if (!p.draftedAction || !Array.isArray(shown)) return null;
  try {
    return previewDrift(shown, await buildPreview(p.draftedAction.tool, p.draftedAction.args));
  } catch (err) {
    return err instanceof Error ? err.message : "the record is gone";
  }
}

async function load(id: string): Promise<AiProposal | null> {
  const [p] = await db.select().from(aiProposals).where(eq(aiProposals.id, id)).limit(1);
  return p ?? null;
}

/** drafted → next, only if still drafted. True when this call won the claim. */
async function claim(id: string, next: "approved" | "rejected", userId: string | null): Promise<boolean> {
  const res = await db
    .update(aiProposals)
    .set({ status: next, decidedAt: sql`CURRENT_TIMESTAMP`, decidedByUserId: userId })
    .where(and(eq(aiProposals.id, id), eq(aiProposals.status, "drafted")));
  return ((res as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0) === 1;
}

// Well under the hub's 25 s settle timeout (feldart-hub engine.ts REPORT_TIMEOUT_MS):
// past this we answer "approved, still running" rather than let the hub
// time out and show "failed" while the job finishes.
const WAIT_MS = 15_000;
const POLL_MS = 500;

async function waitForOutcome(id: string, sleep: (ms: number) => Promise<void>): Promise<SettleReply> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const p = await load(id);
    const summary = String((p?.candidateSummary as { summary?: unknown } | undefined)?.summary ?? "the change");
    if (p?.status === "executed") return { http: 200, body: { status: "applied", message: `Done: ${summary}.` } };
    if (p?.status === "execution_failed") {
      return refuse(502, "failed", `It failed: ${p.executionError ?? "unknown error"}. Ask again to retry.`);
    }
    if (Date.now() >= deadline) {
      return { http: 200, body: { status: "applied", message: `Approved and still running in finance: ${summary}. Check the customer in finance in a minute.` } };
    }
    await sleep(POLL_MS);
  }
}

export async function settleHubProposal(input: {
  id: string;
  action: "confirm" | "cancel";
  actorEmail: string;
  userId: string | null;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SettleReply> {
  const sleep = input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const p = await load(input.id);
  const d = decideSettle(p, input.action, input.actorEmail, input.now ?? new Date());
  if (d.kind === "reply") return d.reply;
  if (d.kind === "wait") return waitForOutcome(input.id, sleep);

  if (input.action === "cancel") {
    if (await claim(input.id, "rejected", input.userId)) {
      return { http: 200, body: { status: "cancelled", message: "Cancelled — nothing was changed." } };
    }
  } else {
    if (!input.userId) return refuse(403, "forbidden", "You need a finance login to confirm finance changes.");
    const stale = await staleness(p!);
    if (stale) return refuse(409, "stale", `Things changed since the card was shown (${stale}). Ask again so it's re-checked.`);
    if (await claim(input.id, "approved", input.userId)) {
      try {
        await getQueues().autopilotExecute.add(AUTOPILOT_EXECUTE_JOB, {
          proposalId: input.id,
          userId: input.userId,
        } as AutopilotExecuteJobData);
      } catch (err) {
        // Never leave a claimed row stuck in 'approved' with nothing running.
        const msg = `couldn't start: ${err instanceof Error ? err.message : String(err)}`;
        await db.update(aiProposals).set({ status: "execution_failed", executionError: msg }).where(eq(aiProposals.id, input.id));
        return refuse(502, "failed", `It couldn't start (${msg}). Nothing was changed; ask again.`);
      }
      return waitForOutcome(input.id, sleep);
    }
  }
  // Lost a race with another click — answer from the row as it is now.
  const again = decideSettle(await load(input.id), input.action, input.actorEmail, input.now ?? new Date());
  if (again.kind === "reply") return again.reply;
  return again.kind === "wait" ? waitForOutcome(input.id, sleep) : refuse(409, "stale", "Something else changed this proposal. Ask again.");
}
