// tj_chase candidate finder (origin-split-2 W2 T3).
//
// Mirror of chase-next's gates, scored on the Torah Judaica book ALONE via
// the chase module's origin-scoped severity path:
//   getOverdueCustomers("tj")  → TJ invoices only, disputeState='verifying'
//   EXCLUDED (notVerifyingSql), netted by the customer's unapplied TJ credit
//   (computeOriginBalances). All of that logic lives — and is tested — in
//   chase/lookups.ts; this finder only re-applies chase-next's proposal
//   gates on top.
//
// Tier floor matches chase_next exactly (ACTIONABLE_TIERS): MEDIUM and above
// propose — drafting maps MEDIUM→tj_l1, HIGH→tj_l2, CRITICAL→tj_l3 (see the
// TJ ladder in ai-agent/voice.ts); LOW is never proposed.
//
// Dedupe vs in-flight/snoozed/recently-rejected proposals is scanner-level
// (per-category block in scanner.ts, same as every finder). The 7-day
// chase_log cooldown is finder-level, identical to chase-next. NOTE:
// chase_log has no origin column, so the cooldown is customer-level across
// BOTH books — a Feldart chase this week suppresses a TJ proposal for the
// same customer (and vice versa). Deliberate: at most one chase email per
// customer per week, regardless of book.

import { and, gte, inArray, max } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { chaseLog } from "../../../db/schema/audit.js";
import {
  getOverdueCustomers,
  getOverdueForCustomer,
} from "../../chase/lookups.js";
import type { OverdueCustomer } from "../../chase/types.js";

export type Candidate = {
  entityType: "customer";
  entityId: string;
  origin: "tj";
  summary: Record<string, unknown>;
};

// Same constants as chase-next — keep the two books' proposal gates in step.
const CHASE_COOLDOWN_DAYS = 7;
const ACTIONABLE_TIERS = new Set<string>(["CRITICAL", "HIGH", "MEDIUM"]);

export type RecentChaseRow = {
  customerId: string;
  lastChasedAt: Date | string | null;
};

// Test/injection seams — winddown.ts pattern: every DB touchpoint is a
// replaceable loader so the gate logic is unit-testable without a DB.
export type TjChaseDeps = {
  // TJ-scoped chase severity rows (verifying excluded; TJ credit netted).
  loadOverdue?: () => Promise<OverdueCustomer[]>;
  // chase_log rows within the cooldown window for the given customers.
  loadRecentChases?: (
    customerIds: string[],
    cutoff: Date,
  ) => Promise<RecentChaseRow[]>;
};

export async function findCandidates(
  customerId?: string,
  deps: TjChaseDeps = {},
): Promise<Candidate[]> {
  const loadOverdue = deps.loadOverdue ?? (() => getOverdueCustomers("tj"));
  const loadRecentChases = deps.loadRecentChases ?? loadRecentChasesFromDb;

  const overdueRows = await loadOverdue();
  const actionable = overdueRows.filter(
    (row) =>
      (!customerId || row.customerId === customerId) &&
      !row.customer.agentModeExcluded &&
      ACTIONABLE_TIERS.has(row.severity.tier),
  );
  if (actionable.length === 0) return [];

  const recentChases = await loadRecentChases(
    actionable.map((r) => r.customerId),
    cooldownCutoff(),
  );
  const recentlyChased = new Set(
    recentChases
      .filter((r) => r.lastChasedAt != null)
      .map((r) => r.customerId),
  );

  return actionable
    .filter((row) => !recentlyChased.has(row.customerId))
    .map((row) => ({
      entityType: "customer" as const,
      entityId: row.customerId,
      origin: "tj" as const,
      summary: {
        // Same shape as chase_next's summary (+ customerId, which the
        // drafting prompt needs to instruct the tool call).
        customerId: row.customerId,
        customerName: row.customer.displayName,
        overdueBalance: row.severity.totalOverdue,
        daysOverdue: row.severity.daysOverdue,
        tier: row.severity.tier,
        // By construction null: survivors are exactly the customers with no
        // chase_log row inside the cooldown window (mirrors chase-next).
        lastChaseAt: null,
      },
    }));
}

export type TjChaseEligibilityDeps = {
  // TJ-scoped single-customer severity (null when nothing overdue).
  loadOverdueForCustomer?: (
    customerId: string,
  ) => Promise<OverdueCustomer | null>;
  loadRecentChases?: (
    customerIds: string[],
    cutoff: Date,
  ) => Promise<RecentChaseRow[]>;
};

// Approve-time staleness check: the customer must still have actionable TJ
// overdue (MEDIUM+ on the TJ book, verifying excluded, credit netted), not
// be agent-excluded, and not have been chased within the cooldown.
export async function isStillEligible(
  entityId: string,
  deps: TjChaseEligibilityDeps = {},
): Promise<boolean> {
  const loadOverdueForCustomer =
    deps.loadOverdueForCustomer ??
    ((id: string) => getOverdueForCustomer(id, "tj"));
  const loadRecentChases = deps.loadRecentChases ?? loadRecentChasesFromDb;

  const row = await loadOverdueForCustomer(entityId);
  if (!row) return false;
  if (row.customer.agentModeExcluded) return false;
  if (!ACTIONABLE_TIERS.has(row.severity.tier)) return false;

  const recent = await loadRecentChases([entityId], cooldownCutoff());
  if (recent.some((r) => r.customerId === entityId && r.lastChasedAt != null)) {
    return false;
  }
  return true;
}

function cooldownCutoff(): Date {
  return new Date(Date.now() - CHASE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
}

// Same query as chase-next's recent-chase lookup: latest chase_log row per
// customer inside the cooldown window.
async function loadRecentChasesFromDb(
  customerIds: string[],
  cutoff: Date,
): Promise<RecentChaseRow[]> {
  if (customerIds.length === 0) return [];
  return db
    .select({
      customerId: chaseLog.customerId,
      lastChasedAt: max(chaseLog.chasedAt),
    })
    .from(chaseLog)
    .where(
      and(
        inArray(chaseLog.customerId, customerIds),
        gte(chaseLog.chasedAt, cutoff),
      ),
    )
    .groupBy(chaseLog.customerId);
}
