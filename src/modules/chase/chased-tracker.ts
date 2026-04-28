// Chase log writes + cooldown lookup.
//
// 1.0's `markChased(mondayItemId)` was a single-column write with timestamp;
// 2.0's `chase_log` is richer (method, severity, optional ai_digest_id), so
// callers should pass severity + method when known. Cooldown filtering uses
// `chased_at` exclusively — same semantics as 1.0's `getRecentlyChasedIds`.

import { and, eq, gte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { chaseLog, type NewChaseLog } from "../../db/schema/audit.js";
import type { ChaseMethod, ChaseSeverityLevel, ChaseTier } from "./types.js";

const DEFAULT_RECENT_DAYS = 3;

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
