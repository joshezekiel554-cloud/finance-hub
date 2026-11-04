// Feldart AI ops tools, wave 2: finance CHANGES through the hub's Confirm
// card. A tool call never acts — it validates, builds a plain-words preview
// and stores an ai_proposals row (source chat, via "hub", 15-min TTL). The
// hub shows the card; Confirm arrives at POST /api/ext/proposals/:id/confirm
// (routes/ext-tools.ts), which claims the row and runs it through the SAME
// BullMQ executor + audit trail as the in-app agent's approve queue
// (ai-agent/tools.ts). Voiding in QuickBooks is never offered from chat.

import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/auth.js";
import { customers } from "../../db/schema/customers.js";
import { invoices } from "../../db/schema/invoices.js";
import { extensivReceipts, rmas } from "../../db/schema/returns.js";
import { buildAgentWriteToolDeclarations } from "../agent/tools/write-tools.js";
import { createChatProposal, validateEntityRefs } from "../agent/chat-proposals.js";
import { getToolByName } from "../ai-agent/tools.js";
import { resolveRecipients } from "../customer-emails/recipients.js";
import { env } from "../../lib/env.js";
import { isEmailAllowed } from "../../server/lib/hub-handoff.js";
import { HOLD_LABEL, ToolInputError, type ToolContext, type ToolDef } from "./finance-tools.js";

export const HUB_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const CONFIRM_NOTE = " Nothing happens until the user presses Confirm on the card the hub shows.";

/** Tools offered (in-app agent declarations + save_rma_tracking). create_task is the inbox's. */
export const HUB_WRITE_TOOLS = [
  "send_chase_email",
  "send_statement",
  "send_check_in_email",
  "send_bookkeeper_email",
  "nudge_warehouse_email",
  "set_hold_status",
  "set_payment_terms",
  "update_customer_context",
  "record_interaction",
  "dispute_transition",
  "create_admin_notification",
] as const;

const TITLES: Record<string, string> = {
  send_chase_email: "Send payment chase email",
  send_statement: "Send statement",
  send_check_in_email: "Send check-in email",
  send_bookkeeper_email: "Email the Torah Judaica bookkeeper",
  nudge_warehouse_email: "Email the warehouse about an RMA",
  set_hold_status: "Change account status",
  set_payment_terms: "Change payment terms",
  update_customer_context: "Add to customer's AI notes",
  record_interaction: "Log an interaction",
  dispute_transition: "Move a Torah Judaica dispute",
  create_admin_notification: "Raise a team notification",
  save_rma_tracking: "Save return tracking on RMA",
  send_invoice_qbo: "Email invoice from QuickBooks",
  dismiss_email_review: "Dismiss from Email review",
  update_customer_emails: "Change customer email addresses",
  rma_set_warehouse_number: "Record warehouse return number",
  rma_mark_received: "Mark return received at warehouse",
  rma_cancel: "Cancel RMA",
  receipt_confirm: "Confirm warehouse receipt → RMA",
  receipt_dismiss: "Dismiss warehouse receipt",
};

const CUSTOMER_ID_PROP_W = { type: "string", description: "Finance customer id from find_customer." };

const SAVE_RMA_TRACKING_SCHEMA = {
  type: "object",
  properties: {
    rmaId: { type: "string", description: "Finance RMA id (from open_rmas / rma_tracking_status / get_rmas url)." },
    trackingNumber: { type: "string", description: "The customer's return tracking number." },
    trackingCarrier: { type: "string", description: "Carrier if known, e.g. UPS, FedEx, USPS." },
  },
  required: ["rmaId", "trackingNumber"],
  additionalProperties: false,
};

const SEND_INVOICE_SCHEMA = {
  type: "object",
  properties: {
    invoiceId: { type: "string", description: "Finance invoice id — the `id` from invoice_email_issues or find_invoice (not the QuickBooks number)." },
  },
  required: ["invoiceId"],
  additionalProperties: false,
};

const DISMISS_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    invoiceId: { type: "string", description: "Finance invoice id from invoice_email_issues." },
    reason: { type: "string", enum: ["sent_elsewhere", "no_invoice_needed", "other"], description: "sent_elsewhere = the customer got it another way; no_invoice_needed = e.g. paid upfront / internal; other = explain in reasonNote." },
    reasonNote: { type: "string", description: "Short note; required when reason is other." },
  },
  required: ["invoiceId", "reason"],
  additionalProperties: false,
};

const EMAIL_LIST_PROP = (what: string) => ({
  type: "array",
  items: { type: "string" },
  description: `The FULL new ${what} list (replaces it). Omit to leave unchanged; [] clears it.`,
});
const UPDATE_EMAILS_SCHEMA = {
  type: "object",
  properties: {
    customerId: CUSTOMER_ID_PROP_W,
    invoiceTo: EMAIL_LIST_PROP("invoice To"),
    invoiceCc: EMAIL_LIST_PROP("invoice Cc"),
    invoiceBcc: EMAIL_LIST_PROP("invoice Bcc"),
    statementTo: EMAIL_LIST_PROP("statement/chase To"),
    statementCc: EMAIL_LIST_PROP("statement/chase Cc"),
    statementBcc: EMAIL_LIST_PROP("statement/chase Bcc"),
  },
  required: ["customerId"],
  additionalProperties: false,
};

const EMAIL_LIST_LABEL: Record<string, string> = {
  invoiceTo: "Invoice To",
  invoiceCc: "Invoice Cc",
  invoiceBcc: "Invoice Bcc",
  statementTo: "Statement To",
  statementCc: "Statement Cc",
  statementBcc: "Statement Bcc",
};

export const NEW_DOMAIN_ROW = "⚠ New domain";
export const NEW_DOMAIN_ADMIN_ONLY =
  "Sending this customer's invoices or statements to an email domain they've never used is a classic invoice-redirect fraud, so only a finance admin (Josh or Shaya) can make that change from chat. Fixing an address at the customer's existing domain is fine.";

/** Business-email-compromise guard: card rows that need a finance admin to confirm. */
export function needsAdmin(tool: string, preview: PreviewRow[]): boolean {
  return tool === "update_customer_emails" && preview.some((r) => r.field === NEW_DOMAIN_ROW);
}

export function isFinanceAdmin(email: string | undefined, adminCsv: string = env.ADMIN_EMAILS): boolean {
  return !!email && isEmailAllowed(email, adminCsv);
}

/** Domains in `next` that none of the customer's current addresses use. */
// Free-mail providers: sharing "@gmail.com" proves nothing, so for these
// the FULL address must already be on the customer to count as known.
const FREE_MAIL = /^(gmail\.com|googlemail\.com|yahoo\.[a-z.]+|ymail\.com|hotmail\.[a-z.]+|outlook\.[a-z.]+|live\.[a-z.]+|msn\.com|aol\.com|icloud\.com|me\.com|mac\.com|protonmail\.com|proton\.me|gmx\.[a-z.]+|zoho\.com|mail\.com)$/;

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.test(domain.toLowerCase());
}

/**
 * Destinations in `next` the customer has never used: a new company domain,
 * or — on free-mail providers — any address not already on the customer.
 */
export function newDomains(current: string[], next: string[]): string[] {
  const norm = (e: string) => e.trim().toLowerCase();
  const dom = (e: string) => norm(e).split("@")[1] ?? "";
  const knownDomains = new Set(current.map(dom).filter(Boolean));
  const knownAddresses = new Set(current.map(norm));
  const out = new Set<string>();
  for (const e of next) {
    const d = dom(e);
    if (!d) continue;
    if (isFreeMailDomain(d)) {
      if (!knownAddresses.has(norm(e))) out.add(norm(e));
    } else if (!knownDomains.has(d)) {
      out.add(d);
    }
  }
  return [...out];
}

const RMA_ID_PROP = { type: "string", description: "Finance RMA id (rmaId from open_rmas / open_returns / rma_tracking_status)." };
const RECEIPT_ID_PROP = { type: "string", description: "receiptId from open_returns.warehouseReceiptsToReview." };
const RMA_WAREHOUSE_SCHEMA = {
  type: "object",
  properties: { rmaId: RMA_ID_PROP, txNumber: { type: "string", description: "The warehouse's (Extensiv) return/receiver number." } },
  required: ["rmaId", "txNumber"],
  additionalProperties: false,
};
const RMA_ONLY_SCHEMA = { type: "object", properties: { rmaId: RMA_ID_PROP }, required: ["rmaId"], additionalProperties: false };
const RMA_CANCEL_SCHEMA = {
  type: "object",
  properties: { rmaId: RMA_ID_PROP, reason: { type: "string", description: "Why it's being cancelled (kept on the RMA)." } },
  required: ["rmaId", "reason"],
  additionalProperties: false,
};
const RECEIPT_ONLY_SCHEMA = { type: "object", properties: { receiptId: RECEIPT_ID_PROP }, required: ["receiptId"], additionalProperties: false };
const RECEIPT_DISMISS_SCHEMA = {
  type: "object",
  properties: {
    receiptId: RECEIPT_ID_PROP,
    reason: { type: "string", enum: ["done", "not_return", "other"], description: "done = already dealt with; not_return = it isn't a customer return; other = explain in reasonText." },
    reasonText: { type: "string", description: "Up to 50 chars; required for other." },
  },
  required: ["receiptId", "reason"],
  additionalProperties: false,
};

export type PreviewRow = { field: string; value: string };

async function customerFor(id: string) {
  const [c] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return c ?? null;
}

async function recipientsLine(c: NonNullable<Awaited<ReturnType<typeof customerFor>>>): Promise<string> {
  const r = await resolveRecipients("statement", {
    primaryEmail: c.primaryEmail,
    billingEmails: c.billingEmails as string[] | null,
    invoiceToEmails: c.invoiceToEmails as string[] | null,
    invoiceCcEmails: c.invoiceCcEmails as string[] | null,
    invoiceBccEmails: c.invoiceBccEmails as string[] | null,
    statementToEmails: c.statementToEmails as string[] | null,
    statementCcEmails: c.statementCcEmails as string[] | null,
    statementBccEmails: c.statementBccEmails as string[] | null,
    tags: c.tags as string[] | null,
  });
  const to = r.to.length ? r.to.join(", ") : c.primaryEmail ?? "(no address on file — the send will fail)";
  return r.cc.length ? `${to} (cc ${r.cc.join(", ")})` : to;
}

async function overdueLine(customerId: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ origin: invoices.origin, balance: invoices.balance, dueDate: invoices.dueDate })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), sql`${invoices.balance} > 0`, sql`${invoices.status} <> 'void'`));
  const sum = { feldart: 0, tj: 0 };
  for (const r of rows) {
    const due = r.dueDate ? new Date(r.dueDate).toISOString().slice(0, 10) : null;
    if (due && due < today) sum[r.origin] += Number(r.balance);
  }
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  return `Feldart ${fmt(sum.feldart)} · Torah Judaica ${fmt(sum.tj)}`;
}

/** First field that differs between the card the user saw and the data now. */
export function previewDrift(shown: PreviewRow[], now: PreviewRow[]): string | null {
  const before = new Map(shown.map((r) => [r.field, r.value]));
  const after = new Map(now.map((r) => [r.field, r.value]));
  for (const field of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(field) !== after.get(field)) {
      return `${field}: "${before.get(field) ?? "—"}" → "${after.get(field) ?? "—"}"`;
    }
  }
  return null;
}

/** Plain-words What/Value rows for the card. Throws ToolInputError on bad refs. */
export async function buildPreview(tool: string, args: Record<string, unknown>): Promise<PreviewRow[]> {
  const rows: PreviewRow[] = [];
  const push = (field: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    rows.push({ field, value: Array.isArray(value) ? value.join(", ") : String(value) });
  };
  const cid = typeof args.customerId === "string" ? args.customerId : null;
  const c = cid ? await customerFor(cid) : null;
  if (cid && !c) throw new ToolInputError(`customerId "${cid}" does not exist — look it up with find_customer.`);
  if (c) push("Customer", c.displayName);

  switch (tool) {
    case "send_chase_email":
    case "send_check_in_email":
      push("To", await recipientsLine(c!));
      if (tool === "send_chase_email") {
        push("Tone", { MEDIUM: "1 — gentle", HIGH: "2 — firmer", CRITICAL: "3 — firm" }[String(args.tier)] ?? args.tier);
        push("Overdue now", await overdueLine(c!.id));
      }
      push("Book", args.origin === "tj" ? "Torah Judaica" : args.origin === "feldart" ? "Feldart" : undefined);
      push("Subject", args.subject);
      push("Message", args.body);
      push("Attach invoices", args.attachInvoiceDocNumbers);
      if (args.attachStatement) push("Attach statement", "Yes — open-items statement PDF");
      break;
    case "send_statement":
      push("To", await recipientsLine(c!));
      push("Book", args.origin === "tj" ? "Torah Judaica" : "Feldart");
      push("Cover note", args.coverNote);
      break;
    case "set_hold_status":
      push("Status now", HOLD_LABEL[c!.holdStatus] ?? c!.holdStatus);
      push("Change to", HOLD_LABEL[String(args.targetState)] ?? args.targetState);
      push("Also", "Updates the customer's Shopify tags (ordering is blocked while on hold)");
      break;
    case "set_payment_terms":
      push("Terms now", c!.paymentTerms ?? "(none)");
      push("Change to", args.terms);
      break;
    case "update_customer_context":
      push("Add note", args.append);
      break;
    case "record_interaction":
      push("Channel", args.channel);
      push("When", args.occurredAtIso ?? "now");
      push("Summary", args.summary);
      break;
    case "send_bookkeeper_email":
    case "dispute_transition": {
      const [inv] = await db
        .select({ docNumber: invoices.docNumber, customer: customers.displayName, balance: invoices.balance, origin: invoices.origin })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(eq(invoices.id, String(args.invoiceId)))
        .limit(1);
      if (!inv) throw new ToolInputError(`invoiceId "${String(args.invoiceId)}" does not exist — look it up first.`);
      push("Invoice", `${inv.docNumber ?? "?"} — ${inv.customer} — balance $${inv.balance}`);
      if (tool === "send_bookkeeper_email") {
        push("To", "Torah Judaica bookkeeper (from finance settings)");
        push("Subject", args.subject);
        push("Message", args.body);
      } else {
        push("Change", { claims_paid: "Customer says it's paid — park it while we verify", not_paid: "Confirmed NOT paid — resume chasing" }[String(args.action)] ?? args.action);
        push("Note", args.note);
      }
      break;
    }
    case "rma_set_warehouse_number":
    case "rma_mark_received":
    case "rma_cancel": {
      const [r] = await db
        .select({ rmaNumber: rmas.rmaNumber, status: rmas.status, customer: customers.displayName, value: rmas.totalValue, extensivTx: rmas.extensivTxNumber })
        .from(rmas)
        .innerJoin(customers, eq(customers.id, rmas.customerId))
        .where(eq(rmas.id, String(args.rmaId)))
        .limit(1);
      if (!r) throw new ToolInputError(`rmaId "${String(args.rmaId)}" does not exist — look it up with open_rmas or get_rmas.`);
      push("RMA", `${r.rmaNumber ?? "(unnumbered)"} — ${r.customer} — $${r.value}`);
      push("Status now", r.status.replace(/_/g, " "));
      if (tool === "rma_set_warehouse_number") {
        push("Warehouse number now", r.extensivTx ?? "(none)");
        push("Set to", args.txNumber);
      } else if (tool === "rma_mark_received") {
        push("Change", "Goods received at the warehouse — ready for credit / closing");
      } else {
        push("Change", "Cancel this RMA (it stays on record, marked cancelled)");
        push("Reason", args.reason);
      }
      break;
    }
    case "receipt_confirm":
    case "receipt_dismiss": {
      const [rc] = await db
        .select({ tx: extensivReceipts.txNumber, ref: extensivReceipts.refString, who: extensivReceipts.inferredCustomerName, rmaId: extensivReceipts.rmaId, rmaNumber: rmas.rmaNumber, dismissedAt: extensivReceipts.dismissedAt, confirmedAt: extensivReceipts.confirmedAt })
        .from(extensivReceipts)
        .leftJoin(rmas, eq(rmas.id, extensivReceipts.rmaId))
        .where(eq(extensivReceipts.id, String(args.receiptId)))
        .limit(1);
      if (!rc) throw new ToolInputError(`receiptId "${String(args.receiptId)}" does not exist — use open_returns.`);
      if (rc.dismissedAt || rc.confirmedAt) throw new ToolInputError("That receipt has already been confirmed or dismissed.");
      push("Warehouse receipt", `tx ${rc.tx ?? "?"}${rc.who ? ` — ${rc.who}` : ""}${rc.ref ? ` — ref ${rc.ref}` : ""}`);
      push("Matched RMA", rc.rmaId ? rc.rmaNumber ?? "(unnumbered)" : "none");
      if (tool === "receipt_confirm") {
        if (!rc.rmaId) throw new ToolInputError("That receipt isn't matched to an RMA yet — it can only be dismissed, or matched on the Returns page.");
        push("Change", "Confirm the match — the RMA moves to received at warehouse");
      } else {
        push("Reason", { done: "Already dealt with", not_return: "Not a customer return", other: `Other: ${String(args.reasonText ?? "")}` }[String(args.reason)] ?? args.reason);
      }
      break;
    }
    case "nudge_warehouse_email":
    case "save_rma_tracking": {
      const [r] = await db
        .select({ rmaNumber: rmas.rmaNumber, status: rmas.status, customer: customers.displayName, tracking: rmas.trackingNumber })
        .from(rmas)
        .innerJoin(customers, eq(customers.id, rmas.customerId))
        .where(eq(rmas.id, String(args.rmaId)))
        .limit(1);
      if (!r) throw new ToolInputError(`rmaId "${String(args.rmaId)}" does not exist — look it up with open_rmas or get_rmas.`);
      push("RMA", `${r.rmaNumber ?? "(unnumbered)"} — ${r.customer} — ${r.status.replace(/_/g, " ")}`);
      if (tool === "save_rma_tracking") {
        if (r.status !== "sent_to_warehouse" && r.status !== "awaiting_warehouse_number") {
          throw new ToolInputError(`RMA ${r.rmaNumber ?? ""} is "${r.status}" — tracking can only be saved while it's awaiting the return.`);
        }
        push("Tracking now", r.tracking ?? "(none)");
        push("Save", `${args.trackingCarrier ? `${String(args.trackingCarrier)} ` : ""}${String(args.trackingNumber)}`);
        push("Also", "Emails the warehouse team to expect the parcel");
      } else {
        push("To", "Warehouse team (from finance settings)");
        push("Subject", args.subject);
        push("Message", args.body);
      }
      break;
    }
    case "send_invoice_qbo":
    case "dismiss_email_review": {
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, String(args.invoiceId))).limit(1);
      if (!inv) throw new ToolInputError(`invoiceId "${String(args.invoiceId)}" does not exist — use the id from invoice_email_issues or find_invoice.`);
      const ic = await customerFor(inv.customerId);
      push("Invoice", `${inv.docNumber ?? "?"} — ${ic?.displayName ?? "?"} — total $${inv.total}, balance $${inv.balance}`);
      push("QuickBooks email status", inv.deliveryError ? `bounced (${inv.deliveryError})` : inv.emailStatus ?? "not emailed");
      if (tool === "send_invoice_qbo") {
        if (inv.status === "void") throw new ToolInputError("That invoice is void — nothing to send.");
        if (ic) {
          const r = await resolveRecipients("invoice", {
            primaryEmail: ic.primaryEmail,
            billingEmails: ic.billingEmails as string[] | null,
            invoiceToEmails: ic.invoiceToEmails as string[] | null,
            invoiceCcEmails: ic.invoiceCcEmails as string[] | null,
            invoiceBccEmails: ic.invoiceBccEmails as string[] | null,
            statementToEmails: ic.statementToEmails as string[] | null,
            statementCcEmails: ic.statementCcEmails as string[] | null,
            statementBccEmails: ic.statementBccEmails as string[] | null,
            tags: ic.tags as string[] | null,
          });
          if (r.to.length === 0) throw new ToolInputError("This customer has no invoice email address on file — add one on their finance record first.");
          push("Sends to", r.cc.length ? `${r.to.join(", ")} (cc ${r.cc.join(", ")})` : r.to.join(", "));
        }
        push("Also", "QuickBooks emails it from its own system; this goes out as soon as you Confirm");
      } else {
        push("Reason", { sent_elsewhere: "Customer got it another way", no_invoice_needed: "No invoice email needed", other: "Other" }[String(args.reason)] ?? args.reason);
        push("Note", args.reasonNote);
      }
      break;
    }
    case "update_customer_emails": {
      const cols = { invoiceTo: c!.invoiceToEmails, invoiceCc: c!.invoiceCcEmails, invoiceBcc: c!.invoiceBccEmails, statementTo: c!.statementToEmails, statementCc: c!.statementCcEmails, statementBcc: c!.statementBccEmails } as Record<string, unknown>;
      const asList = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
      const allCurrent = [c!.primaryEmail ?? "", ...asList(c!.billingEmails), ...Object.values(cols).flatMap(asList)].filter(Boolean);
      const allNext: string[] = [];
      for (const key of Object.keys(EMAIL_LIST_LABEL)) {
        const next = args[key];
        if (next === undefined) continue;
        const list = (next as string[]).map((e) => e.trim().toLowerCase());
        allNext.push(...list);
        push(EMAIL_LIST_LABEL[key]!, `${asList(cols[key]).join(", ") || "(none)"}  →  ${list.join(", ") || "(none — cleared)"}`);
      }
      const fresh = newDomains(allCurrent, allNext);
      if (fresh.length) rows.unshift({ field: NEW_DOMAIN_ROW, value: `${fresh.join(", ")} — this customer has never used it (free-mail addresses count one by one). Check it's really theirs before confirming.` });
      if (args.invoiceTo !== undefined) push("Also", "Updates the customer's email in QuickBooks (invoices QuickBooks sends on its own)");
      break;
    }
    case "create_admin_notification":
      push("Title", args.title);
      push("Message", args.message);
      push("Severity", args.severity ?? "info");
      break;
  }
  return rows;
}

/** Map the hub member to their finance user row (the executor needs a real actor). */
export async function financeUserIdFor(email: string): Promise<string | null> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return u?.id ?? null;
}

function hubWriteTool(name: string, description: string, input_schema: Record<string, unknown>): ToolDef {
  return {
    name,
    ops: true,
    write: true,
    description: description + CONFIRM_NOTE,
    input_schema,
    async run(input, ctx: ToolContext) {
      if (!ctx.actorEmail) throw new ToolInputError("This change needs a signed-in member.");
      const args = (input ?? {}) as Record<string, unknown>;
      const exec = getToolByName(name);
      if (!exec) throw new ToolInputError(`"${name}" isn't available.`);
      const parsed = exec.argsSchema.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ToolInputError(issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "invalid input");
      }
      if (name === "dispute_transition" && args.action === "paid_void") {
        throw new ToolInputError("Voiding an invoice in QuickBooks can't be done from chat — do it on the invoice in finance.feldart.com (it needs a typed confirmation).");
      }
      const refs = await validateEntityRefs(args);
      if (!refs.ok) throw new ToolInputError(refs.error);
      const userId = await financeUserIdFor(ctx.actorEmail);
      if (!userId) throw new ToolInputError("You don't have a finance login yet, so finance can't record this change under your name. Sign in to finance.feldart.com once, then ask again.");

      const preview = await buildPreview(name, args);
      if (needsAdmin(name, preview) && !isFinanceAdmin(ctx.actorEmail)) {
        throw new ToolInputError(NEW_DOMAIN_ADMIN_ONLY);
      }
      const created = await createChatProposal({
        tool: name,
        args,
        userId,
        conversationId: nanoid(24),
        ttlMs: HUB_PROPOSAL_TTL_MS,
        // preview = what the card showed; confirm re-builds it and refuses
        // if anything moved (paid since, hold changed, recipients edited).
        extraSummary: { via: "hub", hubActor: ctx.actorEmail.toLowerCase(), preview },
      });
      return {
        proposal: {
          id: created.proposalId,
          title: TITLES[name] ?? name,
          summary: preview.map((r) => `${r.field}: ${r.value}`).join(" · ").slice(0, 300),
          preview: { columns: [{ key: "field", label: "What" }, { key: "value", label: "Value" }], rows: preview },
          expiresAt: created.expiresAt.toISOString(),
        },
      };
    },
  };
}

const declarations = new Map(buildAgentWriteToolDeclarations().map((d) => [d.name, d]));

export const OPS_FINANCE_WRITES: ToolDef[] = [
  ...HUB_WRITE_TOOLS.map((n) => {
    const d = declarations.get(n);
    if (!d) throw new Error(`missing write declaration ${n}`);
    const schema =
      n === "dispute_transition"
        ? {
            ...d.inputSchema,
            properties: {
              ...(d.inputSchema.properties as Record<string, unknown>),
              action: { type: "string", enum: ["claims_paid", "not_paid"], description: "claims_paid = customer says paid, park it; not_paid = confirmed unpaid, resume chasing. (Voids aren't possible from chat.)" },
            },
          }
        : d.inputSchema;
    const description = n === "dispute_transition" ? "Propose moving a Torah Judaica invoice through the dispute flow: claims_paid (park while we verify) or not_paid (resume chasing)." : d.description;
    return hubWriteTool(n, description, schema as Record<string, unknown>);
  }),
  hubWriteTool(
    "update_customer_emails",
    "Propose changing where a customer's invoices and statements/chase emails go: replace any of the invoice To/Cc/Bcc and statement To/Cc/Bcc address lists (give the FULL new list; omitted lists stay as they are). Use get_customer first to see the current lists. Use to fix a bounced address before resending. The card warns if a new address uses a domain the customer has never used.",
    UPDATE_EMAILS_SCHEMA,
  ),
  hubWriteTool(
    "send_invoice_qbo",
    "Propose (re)sending one invoice to the customer from QuickBooks, to the customer's invoice email addresses on file. Use for invoices that bounced or were never emailed (invoice_email_issues) or when a customer says they didn't get it. If the address is wrong, fix the customer's email first.",
    SEND_INVOICE_SCHEMA,
  ),
  hubWriteTool(
    "dismiss_email_review",
    "Propose hiding an invoice from finance's Email review lists (bounced / never emailed) when it doesn't need sending — e.g. the customer got it another way or no invoice email is needed.",
    DISMISS_REVIEW_SCHEMA,
  ),
  hubWriteTool(
    "rma_set_warehouse_number",
    "Propose recording the warehouse's return (receiver) number on an RMA that's waiting for one.",
    RMA_WAREHOUSE_SCHEMA,
  ),
  hubWriteTool(
    "rma_mark_received",
    "Propose marking an RMA's goods as received at the warehouse (when the warehouse confirmed it some other way than a matched receipt). After this the RMA is ready for its credit.",
    RMA_ONLY_SCHEMA,
  ),
  hubWriteTool("rma_cancel", "Propose cancelling an in-flight RMA, with the reason.", RMA_CANCEL_SCHEMA),
  hubWriteTool(
    "receipt_confirm",
    "Propose confirming that a warehouse return receipt (open_returns.warehouseReceiptsToReview, already matched to an RMA) is that RMA's parcel — moves the RMA to received.",
    RECEIPT_ONLY_SCHEMA,
  ),
  hubWriteTool(
    "receipt_dismiss",
    "Propose dismissing a warehouse return receipt from the review queue (already dealt with / not a customer return / other).",
    RECEIPT_DISMISS_SCHEMA,
  ),
  hubWriteTool(
    "save_rma_tracking",
    "Propose saving the customer's return tracking number on an RMA that's awaiting the parcel (status sent to warehouse / awaiting warehouse number). Saving also emails the warehouse team so they expect it. Use rma_tracking_status to find RMAs missing tracking.",
    SAVE_RMA_TRACKING_SCHEMA,
  ),
];

