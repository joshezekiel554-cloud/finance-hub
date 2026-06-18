// Customer AI card pipeline. One row per customer in customer_ai_cards;
// generation runs every 5 candidate finders scoped to the customer +
// pulls customer KPIs/recent emails + does a single Anthropic call that
// returns {summary, actions[]} structured JSON. Cache TTL is 24h, but
// reads still return stale rows with an is_stale flag so the page renders
// instantly; the Regenerate button forces a fresh call.

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { activities, emailLog } from "../../db/schema/crm.js";
import { phoneCommunications } from "../../db/schema/vocatech.js";
import { emailMatchForCustomer } from "../crm/email-match.js";
import { invoices } from "../../db/schema/invoices.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import {
  customerAiCards,
  type CardAction,
} from "../../db/schema/customer-ai-cards.js";
import { computeOriginBalances } from "../chase/balances.js";
import { buildDraftContext, type DraftContext } from "./voice.js";
import { findCandidates as findChaseNext } from "./candidates/chase-next.js";
import { findCandidates as findCadenceCold } from "./candidates/cadence-cold.js";
import { findCandidates as findCadenceStatement } from "./candidates/cadence-statement.js";
import { findCandidates as findOpsRmaStalled } from "./candidates/ops-rma-stalled.js";
import { findCandidates as findOpsCronFail } from "./candidates/ops-cron-fail.js";
import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "ai-agent.customer-card" });

const CACHE_TTL_HOURS = 24;
const MODEL = "claude-sonnet-4-6";

export type CardKpis = {
  balance: number;
  overdueBalance: number;
  hasHold: boolean;
};

export type CardCandidate = {
  category: string;
  entityType: string;
  entityId: string;
  summary: Record<string, unknown>;
};

export type CardEmail = {
  direction: "inbound" | "outbound";
  subject: string;
  date: string;
};

export type CardCall = {
  kind: "call_in" | "call_out" | "sms_in" | "sms_out";
  date: string;
  // Short snippet of the SMS body / call transcript (truncated) so the model
  // knows what was discussed without a full transcript dominating the prompt.
  detail: string;
};

// Per-book figures fed to the prompt when the customer has BOTH receivable
// books (osplit2 W2 T5). Balances are net of that origin's unapplied credit —
// same computeOriginBalances convention as the customer-detail KPIs.
export type CardBookFigures = {
  balance: number;
  overdue: number;
  openCount: number;
  oldestOverdueDays: number | null;
};

export type CardTjDispute = {
  docNumber: string | null;
  balance: number;
  claimedAt: string | null; // YYYY-MM-DD
};

export type CardBooks = {
  feldart: CardBookFigures;
  tj: CardBookFigures & {
    verifyingCount: number;
    disputes: CardTjDispute[];
  };
};

export type CardPromptInput = {
  customer: { id: string; name: string };
  kpis: CardKpis;
  candidates: CardCandidate[];
  recentEmails: CardEmail[];
  recentCalls: CardCall[];
  context: DraftContext;
  // Present only for both-books customers — switches the prompt into the
  // two-summary schema. Single-book customers keep the blended schema.
  books?: CardBooks;
};

export type CustomerCardData = {
  summary: string;
  // Per-book reads — non-null only when the customer has both books AND the
  // model returned both fields. `summary` always stays populated (NOT NULL
  // column; blended/single-book fallback).
  summaryFeldart: string | null;
  summaryTj: string | null;
  actions: CardAction[];
};

export function buildCardPrompt(input: CardPromptInput): {
  system: string;
  user: string;
} {
  const system =
    `You produce concise customer summaries and action plans for an ` +
    `accounts assistant. Output strict JSON matching the schema below. ` +
    `Reference specific invoice numbers, amounts, dates, customer state. ` +
    `Stay in voice. Don't invent facts.\n\n` +
    `## Voice\n${input.context.voiceGuide}\n\n` +
    (input.context.globalFacts.length
      ? `## Things to know about Feldart\n${input.context.globalFacts
          .map((f) => `- ${f}`)
          .join("\n")}\n\n`
      : "") +
    (input.context.globalCorrections.length
      ? `## Style corrections\n${input.context.globalCorrections
          .map((c) => `- ${c}`)
          .join("\n")}\n\n`
      : "") +
    `## Output schema (return JSON only — no prose preamble)\n` +
    `{\n` +
    (input.books
      ? `  "summary": string,          // ONE short sentence — the overall read across both books\n` +
        `  "summary_feldart": string,  // 1 short paragraph — the Feldart book only\n` +
        `  "summary_tj": string,       // 1 short paragraph — the Torah Judaica book only (balance net of credits; claims-paid/verifying dispute states with dates)\n`
      : `  "summary": string,   // 1-2 short paragraphs of plain prose\n`) +
    `  "actions": [         // 0 or more recommended actions\n` +
    `    {\n` +
    `      "kind": "send_chase_email" | "send_statement" | "send_check_in_email" | "view_rma" | "view_cron_failure",\n` +
    `      "label": string, // operator-facing button text\n` +
    (input.books
      ? `      "origin": "feldart" | "tj", // REQUIRED on send_chase_email/send_statement — which book the action targets; omit on other kinds\n`
      : "") +
    `      "args": object   // kind-specific args, may be empty\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `Only include actions that are actually warranted. If nothing's needed, return [].`;

  const candidatesBlock = input.candidates.length
    ? input.candidates
        .map(
          (c) =>
            `- ${c.category} (${c.entityType}:${c.entityId}): ${JSON.stringify(c.summary)}`,
        )
        .join("\n")
    : "(no autopilot candidates for this customer right now)";

  const emailBlock = input.recentEmails.length
    ? input.recentEmails
        .map(
          (e) => `- ${e.date} ${e.direction.toUpperCase()}: ${e.subject}`,
        )
        .join("\n")
    : "(no recent emails)";

  const CALL_KIND_LABEL: Record<CardCall["kind"], string> = {
    call_in: "CALL (inbound)",
    call_out: "CALL (outbound)",
    sms_in: "TEXT (inbound)",
    sms_out: "TEXT (outbound)",
  };
  const callBlock = input.recentCalls.length
    ? input.recentCalls
        .map(
          (c) =>
            `- ${c.date} ${CALL_KIND_LABEL[c.kind]}${c.detail ? `: ${c.detail}` : ""}`,
        )
        .join("\n")
    : "(no recent calls or texts)";

  const ctxBlock = input.context.customerContext
    ? `\n\n## Customer-specific context (operator-curated)\n${input.context.customerContext}`
    : "";

  const booksBlock = input.books ? buildBooksBlock(input.books) : "";

  const user =
    `## Customer: ${input.customer.name}\n` +
    `Open balance: $${input.kpis.balance.toFixed(2)} ` +
    `(overdue: $${input.kpis.overdueBalance.toFixed(2)}, ` +
    `on hold: ${input.kpis.hasHold ? "yes" : "no"})` +
    booksBlock +
    `\n\n## Current autopilot candidates for this customer\n${candidatesBlock}\n\n` +
    `## Recent emails (last 5)\n${emailBlock}\n\n` +
    `## Recent calls & texts (last 5)\n${callBlock}` +
    ctxBlock +
    `\n\nReturn JSON matching the schema. ` +
    (input.books
      ? `Read the two books separately — summary_feldart covers Feldart only, ` +
        `summary_tj covers Torah Judaica only; summary is one overall sentence. `
      : `Summary in plain prose; `) +
    `actions cover only what's actually warranted right now.`;

  return { system, user };
}

function fmtBookFigures(f: CardBookFigures): string {
  const oldest =
    f.oldestOverdueDays != null ? `, oldest overdue ${f.oldestOverdueDays}d` : "";
  return (
    `balance $${f.balance.toFixed(2)} (overdue $${f.overdue.toFixed(2)}, ` +
    `${f.openCount} open invoice${f.openCount === 1 ? "" : "s"}${oldest})`
  );
}

function buildBooksBlock(books: CardBooks): string {
  const disputeLines = books.tj.disputes.length
    ? books.tj.disputes
        .map(
          (d) =>
            `- ${d.docNumber ?? "(no doc number)"}: $${d.balance.toFixed(2)}, customer claims paid, verifying with bookkeeper since ${d.claimedAt ?? "(unknown date)"}`,
        )
        .join("\n")
    : "(none)";
  return (
    `\n\n## Receivable books (this customer has BOTH — read them separately)\n` +
    `### Feldart (primary, living book)\n${fmtBookFigures(books.feldart)}\n` +
    `### Torah Judaica (legacy wind-down book; balance net of TJ credits)\n` +
    `${fmtBookFigures(books.tj)}; ${books.tj.verifyingCount} invoice${books.tj.verifyingCount === 1 ? "" : "s"} in claims-paid verification\n` +
    `Claims-paid disputes:\n${disputeLines}`
  );
}

const VALID_KINDS = new Set<CardAction["kind"]>([
  "send_chase_email",
  "send_statement",
  "send_check_in_email",
  "view_rma",
  "view_cron_failure",
]);

// Strip a fenced ```json ... ``` wrapper if present, plus trim. Models
// sometimes ignore "JSON only" and wrap.
function unfence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence?.[1]?.trim() ?? trimmed;
}

// Kinds that target one specific receivable book — these carry an `origin`
// after normalization (default feldart; tj only when the customer actually
// has TJ history, i.e. opts.allowTj).
const BOOK_SPECIFIC_KINDS = new Set<CardAction["kind"]>([
  "send_chase_email",
  "send_statement",
]);

export type ParseCardOptions = {
  // The prompt used the per-book schema (both-books customer) — accept
  // summary_feldart / summary_tj from the model.
  perBook?: boolean;
  // The customer has TJ history; action origin "tj" is legal.
  allowTj?: boolean;
};

export function parseCardResponse(
  raw: string,
  opts: ParseCardOptions = {},
): CustomerCardData {
  try {
    const parsed = JSON.parse(unfence(raw)) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      if (Array.isArray(p.actions)) {
        const summaryRaw =
          typeof p.summary === "string" ? p.summary.trim() : "";
        let summaryFeldart: string | null = null;
        let summaryTj: string | null = null;
        if (opts.perBook) {
          const sf =
            typeof p.summary_feldart === "string"
              ? p.summary_feldart.trim()
              : "";
          const st =
            typeof p.summary_tj === "string" ? p.summary_tj.trim() : "";
          // Both or neither — a lone per-book read renders confusingly.
          if (sf && st) {
            summaryFeldart = sf;
            summaryTj = st;
          }
        }
        // `summary` backs a NOT NULL column — synthesize a combiner when the
        // model returned only the per-book reads.
        const summary =
          summaryRaw ||
          (summaryFeldart && summaryTj
            ? `Feldart: ${summaryFeldart}\n\nTJ: ${summaryTj}`
            : "");
        if (summary) {
          const actions: CardAction[] = [];
          for (const a of p.actions) {
            if (
              typeof a === "object" &&
              a !== null &&
              "kind" in a &&
              "label" in a
            ) {
              const aa = a as {
                kind: unknown;
                label: unknown;
                args?: unknown;
                origin?: unknown;
              };
              if (
                typeof aa.kind === "string" &&
                typeof aa.label === "string" &&
                VALID_KINDS.has(aa.kind as CardAction["kind"])
              ) {
                const kind = aa.kind as CardAction["kind"];
                const args =
                  typeof aa.args === "object" && aa.args !== null
                    ? (aa.args as Record<string, unknown>)
                    : {};
                const action: CardAction = { kind, label: aa.label, args };
                if (BOOK_SPECIFIC_KINDS.has(kind)) {
                  const rawOrigin =
                    typeof aa.origin === "string"
                      ? aa.origin
                      : typeof args.origin === "string"
                        ? args.origin
                        : null;
                  action.origin =
                    rawOrigin === "tj" && opts.allowTj ? "tj" : "feldart";
                }
                actions.push(action);
              }
            }
          }
          return { summary, summaryFeldart, summaryTj, actions };
        }
      }
    }
  } catch {
    // fall through
  }
  return {
    summary: "AI summary unavailable — try Regenerate.",
    summaryFeldart: null,
    summaryTj: null,
    actions: [],
  };
}

export type CardResult = {
  data: CustomerCardData;
  isStale: boolean;
  generatedAt: Date;
};

export async function getCustomerCard(
  customerId: string,
): Promise<CardResult | null> {
  const rows = await db
    .select()
    .from(customerAiCards)
    .where(eq(customerAiCards.customerId, customerId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const ageHours =
    (Date.now() - row.generatedAt.getTime()) / (1000 * 60 * 60);
  return {
    data: {
      summary: row.summary,
      summaryFeldart: row.summaryFeldart ?? null,
      summaryTj: row.summaryTj ?? null,
      actions: row.actions,
    },
    isStale: ageHours > CACHE_TTL_HOURS,
    generatedAt: row.generatedAt,
  };
}

// Has anything the card summarises happened SINCE the card was generated? Used
// by the GET route to auto-regenerate on view when there's newer activity —
// robust even when event-invalidation missed it (e.g. an email orphaned by the
// duplicate-record/shared-address case). Checks, address-aware for email:
//   - newest email to/from the customer's address-set,
//   - newest manual note (activities),
//   - newest call/SMS (phone_communications).
export async function customerHasActivitySince(
  customerId: string,
  since: Date,
): Promise<boolean> {
  const cRows = await db
    .select({
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
      invoiceToEmails: customers.invoiceToEmails,
      statementToEmails: customers.statementToEmails,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const cust = cRows[0] ?? {
    primaryEmail: null,
    billingEmails: null,
    invoiceToEmails: null,
    statementToEmails: null,
  };
  const [email, note, call] = await Promise.all([
    db
      .select({ d: emailLog.emailDate })
      .from(emailLog)
      .where(and(emailMatchForCustomer(customerId, cust), gt(emailLog.emailDate, since)))
      .limit(1),
    db
      .select({ d: activities.occurredAt })
      .from(activities)
      .where(
        and(
          eq(activities.customerId, customerId),
          eq(activities.kind, "manual_note"),
          gt(activities.occurredAt, since),
        ),
      )
      .limit(1),
    db
      .select({ d: phoneCommunications.startedAt })
      .from(phoneCommunications)
      .where(
        and(
          eq(phoneCommunications.customerId, customerId),
          gt(phoneCommunications.startedAt, since),
        ),
      )
      .limit(1),
  ]);
  return email.length > 0 || note.length > 0 || call.length > 0;
}

// Drop a customer's cached card so it regenerates fresh on next view. Called
// by the event-driven invalidator (card-invalidation.ts) when something the
// card summarises changes (new email, note, payment, …). Cheap (a delete, no
// LLM call); the paid regeneration only happens when the customer is next
// opened. No-op if there's no card.
export async function invalidateCustomerCard(customerId: string): Promise<void> {
  await db
    .delete(customerAiCards)
    .where(eq(customerAiCards.customerId, customerId));
}

export async function generateCustomerCard(
  customerId: string,
  opts: { force?: boolean } = {},
): Promise<CardResult> {
  const cRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const customer = cRows[0];
  if (!customer) throw new Error(`customer not found: ${customerId}`);

  const [chase, coldEm, statementEm, rmaStall, cronFail] = await Promise.all([
    findChaseNext(customerId),
    findCadenceCold(customerId),
    findCadenceStatement(customerId),
    findOpsRmaStalled(customerId),
    findOpsCronFail(customerId),
  ]);

  const candidates: CardCandidate[] = [
    ...chase.map((c) => ({ ...c, category: "chase_next" })),
    ...coldEm.map((c) => ({ ...c, category: "cadence_cold" })),
    ...statementEm.map((c) => ({ ...c, category: "cadence_statement" })),
    ...rmaStall.map((c) => ({ ...c, category: "ops_rma_stalled" })),
    ...cronFail.map((c) => ({ ...c, category: "ops_cron_fail" })),
  ];

  const [emails, invoiceRows, creditRows, callRows] = await Promise.all([
    db
      .select({
        direction: emailLog.direction,
        subject: emailLog.subject,
        emailDate: emailLog.emailDate,
      })
      .from(emailLog)
      // Match by address-set OR link — robust to origin-split duplicate records
      // (shared email across two book-records) and ambiguous-link orphaning.
      .where(emailMatchForCustomer(customerId, customer))
      .orderBy(desc(emailLog.emailDate))
      .limit(5),
    // Open invoices across both books — feeds the per-book figures the same
    // way the customer-detail KPI exprs do (net of that origin's credit).
    db
      .select({
        origin: invoices.origin,
        balance: invoices.balance,
        dueDate: invoices.dueDate,
        disputeState: invoices.disputeState,
        docNumber: invoices.docNumber,
        disputeClaimedAt: invoices.disputeClaimedAt,
      })
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), gt(invoices.balance, "0")),
      ),
    db
      .select({ origin: creditMemos.origin, balance: creditMemos.balance })
      .from(creditMemos)
      .where(
        and(
          eq(creditMemos.customerId, customerId),
          gt(creditMemos.balance, "0"),
        ),
      ),
    // Recent calls + texts (Vocatech). Excludes dismissed rows; newest first.
    db
      .select({
        kind: phoneCommunications.kind,
        startedAt: phoneCommunications.startedAt,
        body: phoneCommunications.body,
        transcription: phoneCommunications.transcription,
      })
      .from(phoneCommunications)
      .where(
        and(
          eq(phoneCommunications.customerId, customerId),
          isNull(phoneCommunications.dismissedAt),
        ),
      )
      .orderBy(desc(phoneCommunications.startedAt))
      .limit(5),
  ]);

  // Both-books predicate — same semantics as the customer-detail header
  // pill (hasTjHistory): any TJ exposure, open TJ paper, or verifying
  // dispute. Feldart is the living default book, so TJ history alone flips
  // the card into per-book mode.
  const asOf = new Date();
  const credit = { feldart: 0, tj: 0 };
  for (const c of creditRows) {
    const v = Number(c.balance);
    if (Number.isFinite(v) && v > 0) credit[c.origin] += v;
  }
  const netted = computeOriginBalances(invoiceRows, credit, asOf);
  const openCounts = { feldart: 0, tj: 0 };
  for (const r of invoiceRows) openCounts[r.origin] += 1;
  const tjVerifying = invoiceRows.filter(
    (r) => r.origin === "tj" && r.disputeState === "verifying",
  );
  const hasTjHistory =
    netted.tj.balance !== 0 ||
    netted.tj.overdue !== 0 ||
    openCounts.tj !== 0 ||
    tjVerifying.length !== 0;

  const books: CardBooks | undefined = hasTjHistory
    ? {
        feldart: {
          balance: netted.feldart.balance,
          overdue: netted.feldart.overdue,
          openCount: openCounts.feldart,
          oldestOverdueDays: oldestOverdueDays(invoiceRows, "feldart", asOf),
        },
        tj: {
          balance: netted.tj.balance,
          overdue: netted.tj.overdue,
          openCount: openCounts.tj,
          oldestOverdueDays: oldestOverdueDays(invoiceRows, "tj", asOf),
          verifyingCount: tjVerifying.length,
          disputes: tjVerifying.map((r) => ({
            docNumber: r.docNumber,
            balance: Number(r.balance) || 0,
            claimedAt: toDateStr(r.disputeClaimedAt),
          })),
        },
      }
    : undefined;

  // chase_next as the carrier category — globals are what we use, the
  // category-specific arrays go unused in buildCardPrompt.
  const ctx = await buildDraftContext("chase_next", {}, customerId);

  const prompt = buildCardPrompt({
    customer: { id: customer.id, name: customer.displayName },
    kpis: {
      balance: Number(customer.balance ?? 0),
      overdueBalance: Number(customer.overdueBalance ?? 0),
      hasHold: Boolean(
        customer.holdStatus && customer.holdStatus !== "active",
      ),
    },
    candidates,
    recentEmails: emails.map((e) => ({
      direction: e.direction,
      subject: e.subject ?? "(no subject)",
      date: e.emailDate.toISOString().slice(0, 10),
    })),
    recentCalls: callRows.map((c) => {
      // Prefer the call transcript; fall back to the SMS body. Truncate so a
      // long transcript can't dominate the prompt (or its token budget).
      const text = (c.transcription ?? c.body ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return {
        kind: c.kind,
        date: c.startedAt.toISOString().slice(0, 10),
        detail: text.length > 280 ? `${text.slice(0, 280)}…` : text,
      };
    }),
    context: ctx,
    books,
  });

  const client = getAnthropicClient();
  const start = Date.now();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });
  const tookMs = Date.now() - start;

  const textBlock = res.content.find((b) => b.type === "text");
  const raw =
    textBlock && textBlock.type === "text" && "text" in textBlock
      ? (textBlock as { text: string }).text
      : "";
  const data = parseCardResponse(raw, {
    perBook: hasTjHistory,
    allowTj: hasTjHistory,
  });

  await trackUsage(res, { surface: "customer_summary" });

  const now = new Date();
  await db
    .insert(customerAiCards)
    .values({
      customerId,
      summary: data.summary,
      summaryFeldart: data.summaryFeldart,
      summaryTj: data.summaryTj,
      actions: data.actions,
      generatedAt: now,
      modelUsed: MODEL,
      tokensIn: res.usage?.input_tokens ?? 0,
      tokensOut: res.usage?.output_tokens ?? 0,
    })
    .onDuplicateKeyUpdate({
      set: {
        summary: data.summary,
        // Per-book columns clear on regen when the customer dropped back to
        // a single book — never leave stale per-book reads behind.
        summaryFeldart: data.summaryFeldart,
        summaryTj: data.summaryTj,
        actions: data.actions,
        generatedAt: now,
        modelUsed: MODEL,
        tokensIn: res.usage?.input_tokens ?? 0,
        tokensOut: res.usage?.output_tokens ?? 0,
      },
    });

  log.info(
    {
      customerId,
      tookMs,
      force: opts.force ?? false,
      actions: data.actions.length,
      perBook: hasTjHistory,
    },
    "customer card generated",
  );
  return { data, isStale: false, generatedAt: now };
}

// Age in days of the oldest overdue open invoice on one book; null when
// nothing on that book is past due. Mirrors the detail KPI's
// feldartOldestDays convention.
function oldestOverdueDays(
  rows: { origin: "feldart" | "tj"; dueDate: Date | string | null }[],
  origin: "feldart" | "tj",
  asOf: Date,
): number | null {
  let oldest: number | null = null;
  for (const r of rows) {
    if (r.origin !== origin || r.dueDate == null) continue;
    const due = r.dueDate instanceof Date ? r.dueDate : new Date(r.dueDate);
    if (Number.isNaN(due.getTime()) || due.getTime() >= asOf.getTime()) {
      continue;
    }
    const days = Math.floor(
      (asOf.getTime() - due.getTime()) / (24 * 60 * 60 * 1000),
    );
    if (oldest === null || days > oldest) oldest = days;
  }
  return oldest;
}

function toDateStr(value: Date | string | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
