// Daily chase digest orchestration.
//
// 1.0 emitted a chase digest by feeding a hand-built `ChaseAccount[]` to the
// summarizer. 2.0 keeps the same shape (the anthropic module's `ChaseAccount`
// type matches 1.0's contract verbatim) but assembles it from the new
// customers/invoices schema. We slice to the top N for the AI call to keep the
// prompt small + costs predictable; the full ranked list is still returned so
// callers (UI, BullMQ digest send job) have access to the long tail.

import { generateChaseDigest } from "../../integrations/anthropic/chase-digest.js";
import type { ChaseAccount } from "../../integrations/anthropic/types.js";
import { getOverdueCustomers } from "./lookups.js";
import type { OverdueCustomer } from "./types.js";

export type DailyDigestOptions = {
  topN?: number;
  userId?: string | null;
  // Test/injection seam — allows unit tests to mock the AI call without
  // setting ANTHROPIC_API_KEY or stubbing the SDK at the module level.
  generateDigest?: typeof generateChaseDigest;
  // Test/injection seam for DB lookup.
  loadOverdue?: typeof getOverdueCustomers;
};

export type DailyDigestResult = {
  digest: string | null;
  accounts: ChaseAccount[];
  overdueCustomers: OverdueCustomer[];
  error: string | null;
};

const DEFAULT_TOP_N = 25;

export async function buildDailyDigest(
  options: DailyDigestOptions = {},
): Promise<DailyDigestResult> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const loadOverdue = options.loadOverdue ?? getOverdueCustomers;
  const generate = options.generateDigest ?? generateChaseDigest;

  const overdueCustomers = await loadOverdue();
  if (overdueCustomers.length === 0) {
    return {
      digest: null,
      accounts: [],
      overdueCustomers: [],
      error: "No overdue customers",
    };
  }

  const top = overdueCustomers.slice(0, topN);
  const accounts = top.map(toChaseAccount);

  const result = await generate(accounts, { userId: options.userId ?? null });

  return {
    digest: result.digest,
    accounts,
    overdueCustomers,
    error: result.error,
  };
}

// Map our DB-shaped OverdueCustomer to the anthropic module's ChaseAccount
// contract. Field names mirror 1.0's payload so the prompt template's variable
// references keep working without modification.
export function toChaseAccount(row: OverdueCustomer): ChaseAccount {
  const { customer, severity } = row;
  return {
    name: customer.displayName,
    tier: severity.tier,
    score: severity.score,
    overdue_balance: severity.totalOverdue,
    current_balance: parseMoney(customer.balance),
    days_overdue: severity.daysOverdue,
    oldest_unpaid_invoice: severity.oldestUnpaidDate,
    last_payment: null,
    last_chased: null,
    hold_status: customer.holdStatus,
    action_plan: null,
  };
}

function parseMoney(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
