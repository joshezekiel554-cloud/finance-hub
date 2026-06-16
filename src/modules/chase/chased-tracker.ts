// Chase log writes + cooldown lookup.
//
// 1.0's `markChased(mondayItemId)` was a single-column write with timestamp;
// 2.0's `chase_log` is richer (method, severity, optional ai_digest_id), so
// callers should pass severity + method when known. Cooldown filtering uses
// `chased_at` exclusively — same semantics as 1.0's `getRecentlyChasedIds`.

import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { chaseLog, type NewChaseLog } from "../../db/schema/audit.js";
import { emailLog } from "../../db/schema/crm.js";
import type { ChaseMethod, ChaseSeverityLevel, ChaseTier } from "./types.js";

const DEFAULT_RECENT_DAYS = 3;
// How recently a NON-automated outbound email to a customer suppresses the
// automated chaser. "A human (or the Inbox app) just emailed this customer,
// so don't auto-dun them on top of it." See spec §3.6 / Phase 4.
const HUMAN_CONTACT_COOLDOWN_DAYS = 3;

export type MarkChasedOptions = {
  customerId: string;
  userId?: string | null;
  method?: ChaseMethod;
  severity?: ChaseTier | ChaseSeverityLevel;
  aiDigestId?: string | null;
  notes?: string | null;
};

export async function markChased(opts: MarkChasedOptions): Promise<string> {
  const id = nanoid(24);
  const row: NewChaseLog = {
    id,
    customerId: opts.customerId,
    userId: opts.userId ?? null,
    method: opts.method ?? "email",
    severity: normalizeSeverity(opts.severity),
    aiDigestId: opts.aiDigestId ?? null,
    notes: opts.notes ?? null,
  };
  await db.insert(chaseLog).values(row);
  return id;
}

export async function wasRecentlyChased(
  customerId: string,
  withinDays: number = DEFAULT_RECENT_DAYS,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: chaseLog.id })
    .from(chaseLog)
    .where(
      and(eq(chaseLog.customerId, customerId), gte(chaseLog.chasedAt, cutoff)),
    )
    .limit(1);
  return rows.length > 0;
}

// Customers (from the supplied set) who have had a recent NON-AUTOMATED
// outbound email — i.e. a human reply from Finance OR a reply the Inbox app
// sent that Finance's poller mirrored into email_log. We treat
// `direction = 'outbound' AND ai_proposal_id IS NULL` as "not one of our own
// AI/proposer chase sends", so the automated chaser won't pile a dunning email
// on top of a personal touch.
//
// COVERAGE CAVEAT (v1): this only catches outbound emails present in Finance's
// own email_log. Whether an Inbox-originated reply lands here depends on
// Finance's Gmail poller ingesting SENT messages. The robust cross-app version
// is the Phase-2 "last-human-contact" signal from Inbox. This guard is the best
// finance-only v1 and strictly improves on today's zero suppression.
export async function loadRecentHumanContact(
  customerIds: string[],
  withinDays: number = HUMAN_CONTACT_COOLDOWN_DAYS,
): Promise<Set<string>> {
  if (customerIds.length === 0) return new Set();
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);
  // groupBy customerId gives the distinct set of customers with such contact.
  const rows = await db
    .select({ customerId: emailLog.customerId })
    .from(emailLog)
    .where(
      and(
        inArray(emailLog.customerId, customerIds),
        eq(emailLog.direction, "outbound"),
        isNull(emailLog.aiProposalId),
        gte(emailLog.emailDate, cutoff),
      ),
    )
    .groupBy(emailLog.customerId);
  return new Set(rows.map((r) => r.customerId).filter((id): id is string => !!id));
}

// Tier comes off scoring.ts as uppercase ('CRITICAL'); the schema enum is
// lowercase ('critical'). Accept either, normalize to schema.
function normalizeSeverity(
  v: ChaseTier | ChaseSeverityLevel | undefined,
): ChaseSeverityLevel {
  if (!v) return "medium";
  const lower = v.toLowerCase();
  if (lower === "critical" || lower === "high" || lower === "medium" || lower === "low") {
    return lower;
  }
  return "medium";
}
