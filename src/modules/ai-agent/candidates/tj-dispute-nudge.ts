// tj_dispute_nudge candidate finder (origin-split-2 W2 T3).
//
// Scope: TJ invoices parked in disputeState='verifying' with balance > 0 —
// the invoices the operator is checking with the Torah Judaica bookkeeper.
// Two flavours, one category:
//   - invoice HAS a linked bookkeeper thread (invoices.bookkeeper_thread_id,
//     recorded by the W2 T2 dispute compose flow): the latest email_log row
//     on that thread (either direction) is the silence clock. Silent for
//     ≥ NUDGE_SILENCE_DAYS → propose a follow-up nudge to the bookkeeper.
//   - invoice has NO linked thread → propose the FIRST bookkeeper email
//     (needsFirstEmail in the summary; the drafting prompt branches on it).
// A linked thread with NO email_log rows yields NO candidate: the just-sent
// email may simply not have been ingested by the gmail poller yet — absence
// of rows is not evidence of silence.
//
// Entity level: INVOICE (entityType "invoice", entityId = invoices.id) — the
// dispute lives on the invoice, and the scanner's dedupe is generic over
// (entityType, entityId, category), so two verifying invoices on one
// customer correctly produce two independent nudges. Non-customer entity
// types are precedented (ops_rma_stalled uses "rma"); the drafting flow's
// buildDraftContext simply gets a null customerId for non-customer entities.
//
// The bookkeeper contact (app_settings tj_bookkeeper_email/_name) is read at
// scan time and carried in the summary so the drafting prompt + /autopilot
// UI can surface that the recipient is the BOOKKEEPER, not the customer.
// An unset address still proposes (the gap should be visible, and execution
// fails with a clear "setting not configured" error rather than silently
// skipping the dispute).

import { and, eq, gt, inArray, max } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { customers } from "../../../db/schema/customers.js";
import { invoices, type Invoice } from "../../../db/schema/invoices.js";
import { emailLog } from "../../../db/schema/crm.js";
import { loadAppSettings } from "../../statements/settings.js";

export type Candidate = {
  entityType: "invoice";
  entityId: string;
  origin: "tj";
  summary: Record<string, unknown>;
};

// Silence threshold (spec §3): a bookkeeper thread quiet for ≥ 7 days is a
// nudge candidate. Constant for now; configurable later if needed.
export const NUDGE_SILENCE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

// The slice of the verifying-invoice join the finder needs.
export type VerifyingInvoiceRow = {
  invoiceId: string;
  docNumber: string | null;
  customerId: string;
  customerName: string;
  balance: string | number;
  disputeClaimedAt: Date | string | null;
  disputeNote: string | null;
  bookkeeperThreadId: string | null;
};

export type BookkeeperContact = {
  email: string | null;
  name: string | null;
};

// Test/injection seams — winddown.ts pattern.
export type TjDisputeNudgeDeps = {
  // Open TJ invoices in disputeState='verifying', joined to customer identity.
  loadVerifyingInvoices?: () => Promise<VerifyingInvoiceRow[]>;
  // threadId → latest email_log emailDate (either direction) for the given
  // bookkeeper threads. Threads with no email_log rows are absent.
  loadLatestThreadEmailDates?: (threadIds: string[]) => Promise<Map<string, Date>>;
  // app_settings tj_bookkeeper_email / tj_bookkeeper_name (trimmed; null when unset).
  loadBookkeeperContact?: () => Promise<BookkeeperContact>;
  now?: Date;
};

export async function findCandidates(
  deps: TjDisputeNudgeDeps = {},
): Promise<Candidate[]> {
  const now = deps.now ?? new Date();
  const loadVerifyingInvoices =
    deps.loadVerifyingInvoices ?? loadVerifyingInvoicesFromDb;
  const loadLatestThreadEmailDates =
    deps.loadLatestThreadEmailDates ?? loadLatestThreadEmailDatesFromDb;
  const loadBookkeeperContact =
    deps.loadBookkeeperContact ?? loadBookkeeperContactFromDb;

  const rows = (await loadVerifyingInvoices()).filter(
    (r) => parseMoney(r.balance) > 0, // query contract; defensive
  );
  if (rows.length === 0) return [];

  const threadIds = rows
    .map((r) => r.bookkeeperThreadId)
    .filter((t): t is string => t != null && t !== "");
  const latestByThread =
    threadIds.length > 0
      ? await loadLatestThreadEmailDates(threadIds)
      : new Map<string, Date>();

  const contact = await loadBookkeeperContact();

  const candidates: Candidate[] = [];
  for (const row of rows) {
    let needsFirstEmail = false;
    let daysSilent: number | null = null;
    let lastThreadEmailAt: string | null = null;

    if (row.bookkeeperThreadId) {
      const latest = latestByThread.get(row.bookkeeperThreadId);
      // Linked thread but no email_log rows yet → skip (see header comment).
      if (!latest) continue;
      const silentMs = now.getTime() - latest.getTime();
      if (silentMs < NUDGE_SILENCE_DAYS * DAY_MS) continue; // thread active
      daysSilent = Math.floor(silentMs / DAY_MS);
      lastThreadEmailAt = latest.toISOString();
    } else {
      needsFirstEmail = true;
    }

    candidates.push({
      entityType: "invoice",
      entityId: row.invoiceId,
      origin: "tj",
      summary: {
        invoiceId: row.invoiceId,
        docNumber: row.docNumber,
        customerId: row.customerId,
        customerName: row.customerName,
        balance: parseMoney(row.balance),
        claimedAt: toIso(row.disputeClaimedAt),
        disputeNote: row.disputeNote,
        hasBookkeeperThread: !needsFirstEmail,
        needsFirstEmail,
        daysSilent,
        lastThreadEmailAt,
        // The drafted email goes to the TJ bookkeeper, NOT the customer —
        // surfaced here so the queue UI + drafting prompt make that plain.
        recipient: "bookkeeper",
        bookkeeperEmail: contact.email,
        bookkeeperName: contact.name,
      },
    });
  }

  return candidates;
}

export type TjDisputeNudgeEligibilityDeps = {
  loadInvoice?: (invoiceId: string) => Promise<{
    id: string;
    origin: Invoice["origin"];
    disputeState: Invoice["disputeState"];
    balance: string | number;
  } | null>;
};

// Approve-time staleness check: the invoice must still be a verifying TJ
// dispute with money on it. (Dispute resolved / voided / paid → stale.)
export async function isStillEligible(
  entityId: string,
  deps: TjDisputeNudgeEligibilityDeps = {},
): Promise<boolean> {
  const loadInvoice = deps.loadInvoice ?? loadInvoiceFromDb;
  const invoice = await loadInvoice(entityId);
  if (!invoice) return false;
  if (invoice.origin !== "tj") return false;
  if (invoice.disputeState !== "verifying") return false;
  if (parseMoney(invoice.balance) <= 0) return false;
  return true;
}

// ---------- default DB loaders ----------

async function loadVerifyingInvoicesFromDb(): Promise<VerifyingInvoiceRow[]> {
  return db
    .select({
      invoiceId: invoices.id,
      docNumber: invoices.docNumber,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      balance: invoices.balance,
      disputeClaimedAt: invoices.disputeClaimedAt,
      disputeNote: invoices.disputeNote,
      bookkeeperThreadId: invoices.bookkeeperThreadId,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.origin, "tj"),
        eq(invoices.disputeState, "verifying"),
        gt(invoices.balance, "0"),
      ),
    );
}

async function loadLatestThreadEmailDatesFromDb(
  threadIds: string[],
): Promise<Map<string, Date>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db
    .select({
      threadId: emailLog.threadId,
      latest: max(emailLog.emailDate),
    })
    .from(emailLog)
    .where(inArray(emailLog.threadId, threadIds))
    .groupBy(emailLog.threadId);
  const map = new Map<string, Date>();
  for (const r of rows) {
    if (!r.threadId || r.latest == null) continue;
    const d = r.latest instanceof Date ? r.latest : new Date(r.latest);
    if (!Number.isNaN(d.getTime())) map.set(r.threadId, d);
  }
  return map;
}

async function loadBookkeeperContactFromDb(): Promise<BookkeeperContact> {
  const settings = await loadAppSettings();
  return {
    email: settings.tj_bookkeeper_email.trim() || null,
    name: settings.tj_bookkeeper_name.trim() || null,
  };
}

async function loadInvoiceFromDb(invoiceId: string) {
  const rows = await db
    .select({
      id: invoices.id,
      origin: invoices.origin,
      disputeState: invoices.disputeState,
      balance: invoices.balance,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------- helpers ----------

function parseMoney(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
