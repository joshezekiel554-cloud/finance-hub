// Daily chase digest orchestration.
//
// 1.0 emitted a chase digest by feeding a hand-built `ChaseAccount[]` to the
// summarizer. 2.0 keeps the same shape (the anthropic module's `ChaseAccount`
// type matches 1.0's contract verbatim) but assembles it from the new
// customers/invoices schema. We slice to the top N for the AI call to keep the
// prompt small + costs predictable; the full ranked list is still returned so
// callers (UI, BullMQ digest send job) have access to the long tail.
//
// Origin-split-2 W2 T6: the default (daily cron) digest keeps the books
// separate. The main body is the FELDART severity path; Torah Judaica rides
// along as its own clearly-delimited wind-down block — TJ severity rows
// (verifying disputes excluded, same data the TJ proposers use) plus the
// dispute-pipeline counts from the tj-dispute-nudge finder's helpers. When an
// explicit `origin` is passed the digest stays single-book (no TJ section),
// matching the pre-existing origin-scoped behaviour.

import { generateChaseDigest } from "../../integrations/anthropic/chase-digest.js";
import type { ChaseAccount } from "../../integrations/anthropic/types.js";
import {
  summarizeDisputePipeline,
  type DisputePipelineSummary,
} from "../ai-agent/candidates/tj-dispute-nudge.js";
import type { InvoiceOrigin } from "../invoicing/origin.js";
import { getOverdueCustomers } from "./lookups.js";
import type { OverdueCustomer } from "./types.js";

export type DailyDigestOptions = {
  topN?: number;
  userId?: string | null;
  // Scope the digest to one book ('feldart' | 'tj'); omit for the daily
  // digest (Feldart main body + TJ wind-down section).
  origin?: InvoiceOrigin;
  // Test/injection seam — allows unit tests to mock the AI call without
  // setting ANTHROPIC_API_KEY or stubbing the SDK at the module level.
  generateDigest?: typeof generateChaseDigest;
  // Test/injection seam for DB lookup.
  loadOverdue?: typeof getOverdueCustomers;
  // Test/injection seam for the TJ dispute-pipeline counts.
  loadDisputePipeline?: typeof summarizeDisputePipeline;
};

export type DailyDigestResult = {
  digest: string | null;
  accounts: ChaseAccount[];
  overdueCustomers: OverdueCustomer[];
  // TJ wind-down inputs (default both-books digest only; empty/null for
  // origin-scoped digests).
  tjAccounts: ChaseAccount[];
  tjOverdueCustomers: OverdueCustomer[];
  disputePipeline: DisputePipelineSummary | null;
  error: string | null;
};

const DEFAULT_TOP_N = 25;

export async function buildDailyDigest(
  options: DailyDigestOptions = {},
): Promise<DailyDigestResult> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const loadOverdue = options.loadOverdue ?? getOverdueCustomers;
  const generate = options.generateDigest ?? generateChaseDigest;

  // Explicit single-book digest — pre-W2 behaviour, no TJ section.
  if (options.origin) {
    const overdueCustomers = await loadOverdue(options.origin);
    if (overdueCustomers.length === 0) {
      return emptyResult(null, "No overdue customers");
    }
    const accounts = overdueCustomers.slice(0, topN).map(toChaseAccount);
    const result = await generate(accounts, { userId: options.userId ?? null });
    return {
      digest: result.digest,
      accounts,
      overdueCustomers,
      tjAccounts: [],
      tjOverdueCustomers: [],
      disputePipeline: null,
      error: result.error,
    };
  }

  // Default (daily cron) digest: Feldart main body + TJ wind-down block.
  const loadDisputePipeline =
    options.loadDisputePipeline ?? summarizeDisputePipeline;
  const [overdueCustomers, tjOverdueCustomers, disputePipeline] =
    await Promise.all([
      loadOverdue("feldart"),
      loadOverdue("tj"),
      loadDisputePipeline(),
    ]);

  // TJ content exists when there are TJ severity rows OR disputes in flight
  // (verifying invoices are excluded from severity, so the pipeline counts
  // can be non-zero with zero TJ rows).
  const hasTj = tjOverdueCustomers.length > 0 || disputePipeline.verifying > 0;

  if (overdueCustomers.length === 0 && !hasTj) {
    return emptyResult(disputePipeline, "No overdue customers");
  }

  const accounts = overdueCustomers.slice(0, topN).map(toChaseAccount);
  const tjAccounts = tjOverdueCustomers.slice(0, topN).map(toChaseAccount);

  const result = await generate(accounts, {
    userId: options.userId ?? null,
    // Empty TJ state → no block → the prompt omits the section entirely
    // (matches the digest's existing "nothing to say, say nothing" style).
    tj: hasTj ? { accounts: tjAccounts, pipeline: disputePipeline } : null,
  });

  return {
    digest: result.digest,
    accounts,
    overdueCustomers,
    tjAccounts,
    tjOverdueCustomers,
    disputePipeline,
    error: result.error,
  };
}

function emptyResult(
  disputePipeline: DisputePipelineSummary | null,
  error: string,
): DailyDigestResult {
  return {
    digest: null,
    accounts: [],
    overdueCustomers: [],
    tjAccounts: [],
    tjOverdueCustomers: [],
    disputePipeline,
    error,
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
