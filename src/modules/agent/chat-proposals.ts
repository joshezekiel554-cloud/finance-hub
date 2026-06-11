// Chat-born write proposals (spec 2026-06-11 §3/§4). When the agent loop
// sees a write tool_use, it lands here instead of executing: one
// ai_proposals row, status 'drafted' (the args ARE the draft), source
// 'chat'. The operator approves/edits/dismisses via the SAME autopilot
// endpoints + BullMQ executor as scanner proposals — one queue, one
// execution path.

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { aiProposals } from "../../db/schema/ai-proposals.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { tasks } from "../../db/schema/crm.js";
import { rmas } from "../../db/schema/returns.js";

// Entity-id args are validated BEFORE a proposal is created, so a model
// that invents an id (seen in prod: customerId "gifts-by-gilda" instead
// of the real nanoid) gets an immediate tool error and self-corrects
// in-turn — instead of the operator approving a proposal that fails at
// execution. Only existence is checked; deep validation stays in the
// executor.
export type EntityRefCheck = (id: string) => Promise<boolean>;

async function existsIn(
  table: typeof customers | typeof invoices | typeof tasks | typeof rmas,
  id: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return rows.length > 0;
}

const ENTITY_REF_LOOKUPS: Record<string, EntityRefCheck> = {
  customerId: (id) => existsIn(customers, id),
  invoiceId: (id) => existsIn(invoices, id),
  taskId: (id) => existsIn(tasks, id),
  rmaId: (id) => existsIn(rmas, id),
};

export async function validateEntityRefs(
  args: Record<string, unknown>,
  lookups: Partial<Record<string, EntityRefCheck>> = ENTITY_REF_LOOKUPS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const [key, check] of Object.entries(lookups)) {
    const value = args[key];
    if (typeof value !== "string" || !value || !check) continue;
    const exists = await check(value);
    if (!exists) {
      return {
        ok: false,
        error: `${key} "${value}" does not exist. Never invent or guess ids — look the record up first (e.g. search_customers / get_customer / list_invoices) and use the exact id it returns.`,
      };
    }
  }
  return { ok: true };
}

// Tools whose execution is destructive enough to demand typed
// confirmation in the UI (the docNumber/etc must be typed back).
export const DANGEROUS_CHAT_ACTIONS: ReadonlyArray<{
  tool: string;
  when?: (args: Record<string, unknown>) => boolean;
}> = [
  { tool: "dispute_transition", when: (a) => a.action === "paid_void" },
];

export function isDangerousAction(
  tool: string,
  args: Record<string, unknown>,
): boolean {
  return DANGEROUS_CHAT_ACTIONS.some(
    (d) => d.tool === tool && (d.when ? d.when(args) : true),
  );
}

// Entity linkage for the proposals table — best-effort from args.
export function deriveEntity(
  tool: string,
  args: Record<string, unknown>,
): { entityType: string; entityId: string } {
  if (typeof args.invoiceId === "string" && args.invoiceId) {
    return { entityType: "invoice", entityId: args.invoiceId };
  }
  if (typeof args.taskId === "string" && args.taskId) {
    return { entityType: "task", entityId: args.taskId };
  }
  if (typeof args.customerId === "string" && args.customerId) {
    return { entityType: "customer", entityId: args.customerId };
  }
  if (typeof args.rmaId === "string" && args.rmaId) {
    return { entityType: "rma", entityId: args.rmaId };
  }
  return { entityType: "chat", entityId: tool };
}

// One human line for queue/chip rendering.
export function summarizeAction(
  tool: string,
  args: Record<string, unknown>,
): string {
  const bits: string[] = [tool.replace(/_/g, " ")];
  for (const key of ["title", "subject", "targetState", "action", "terms", "channel"]) {
    const v = args[key];
    if (typeof v === "string" && v) bits.push(`${key}=${v.slice(0, 80)}`);
  }
  return bits.join(" · ");
}

const CHAT_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CreateChatProposalInput = {
  tool: string;
  args: Record<string, unknown>;
  userId: string;
  conversationId: string;
};

export type ChatProposalDeps = {
  insert?: (row: typeof aiProposals.$inferInsert) => Promise<void>;
  now?: () => Date;
};

export async function createChatProposal(
  input: CreateChatProposalInput,
  deps: ChatProposalDeps = {},
): Promise<{ proposalId: string; dangerous: boolean; summary: string }> {
  const now = (deps.now ?? (() => new Date()))();
  const id = nanoid(24);
  const { entityType, entityId } = deriveEntity(input.tool, input.args);
  const dangerous = isDangerousAction(input.tool, input.args);
  const summary = summarizeAction(input.tool, input.args);

  const row: typeof aiProposals.$inferInsert = {
    id,
    category: "chat_action",
    origin: null,
    source: "chat",
    entityType,
    entityId,
    // Drafted immediately: chat proposals arrive with their args.
    status: "drafted",
    candidateSummary: {
      tool: input.tool,
      conversationId: input.conversationId,
      summary,
      dangerous,
      requestedByUserId: input.userId,
    },
    draftedAction: { tool: input.tool, args: input.args },
    draftedPreview: JSON.stringify(input.args).slice(0, 2000),
    draftedAt: now,
    reasoning: null,
    confidence: null,
    // scanId is NOT NULL for scanner provenance; chat proposals carry the
    // conversation id here (both are nanoid(24)) — documented overload.
    scanId: input.conversationId,
    expiresAt: new Date(now.getTime() + CHAT_PROPOSAL_TTL_MS),
  };

  if (deps.insert) await deps.insert(row);
  else await db.insert(aiProposals).values(row);

  return { proposalId: id, dangerous, summary };
}
