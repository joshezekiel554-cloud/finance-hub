import type { AI_SURFACES } from "~/db/schema/audit.js";

export type AnthropicSurface = (typeof AI_SURFACES)[number];

export type EmailDirection = "inbound" | "outbound";

// Lifted from 1.0's ai-summarizer prompt builder. Keep field names matching
// what 1.0 produced from Gmail ingestion so the Gmail porter's payload drops
// straight in without a translation layer.
export type EmailContext = {
  date: string;
  from: string;
  subject: string;
  body: string | null;
  direction: EmailDirection;
};

export type QbTransactionSummary = {
  amount: number;
  date: string;
  docNumber?: string | null;
  balance?: number;
};

export type QbContext = {
  currentBalance?: number | null;
  overdueBalance?: number | null;
  lastPaymentDate?: string | null;
  lastInvoiceDate?: string | null;
  transactions?: {
    payments?: QbTransactionSummary[];
    invoices?: QbTransactionSummary[];
    creditMemos?: QbTransactionSummary[];
  };
};

export type ChaseLastChased = {
  chased_at: string;
  method?: string | null;
};

export type ChaseAccount = {
  name: string;
  tier: string;
  score: number;
  overdue_balance: number;
  current_balance: number;
  days_overdue: number;
  oldest_unpaid_invoice?: string | null;
  last_payment?: string | null;
  last_chased?: ChaseLastChased | null;
  hold_status?: string | null;
  action_plan?: string | null;
};

// Torah Judaica wind-down block for the daily chase digest (origin-split-2
// W2 T6). Pipeline field names mirror the ai-agent module's
// DisputePipelineSummary — structural twins, so the chase digest orchestrator
// can pass the counts straight through without this integration importing
// module code.
export type TjDisputePipeline = {
  verifying: number;
  awaitingFirstEmail: number;
  silentThreads: number;
};

export type TjChaseDigestBlock = {
  // TJ overdue accounts (TJ severity path; verifying disputes excluded).
  accounts: ChaseAccount[];
  pipeline: TjDisputePipeline;
};

// Anthropic's TS SDK 0.30.x doesn't type cache_read/cache_creation tokens, the
// thinking/output_config params, or cache_control on system blocks — those
// fields go through the API as pass-through. Narrow only what we need here.
export type AnthropicUsageWithCache = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AnthropicResponseWithUsage = {
  model?: string;
  content: Array<{ type: string; text?: string }>;
  usage?: AnthropicUsageWithCache;
};

export type GenerateResult<T extends string> = {
  [K in T]: string | null;
} & { error: string | null };
