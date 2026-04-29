// QB → finance-hub DB sync.
//
// Replaces 1.0's `sync-engine.run()` and `runIncremental()` Monday-driven flows
// with idempotent upserts into our own tables. Customer matching is no longer
// against a Monday board — we own the customer record now, keyed by qb_customer_id.
//
// Each function is async + throws on auth/network failures. Per-row failures
// are logged at warn and skipped (so one bad invoice doesn't fail the whole
// sync). Caller (BullMQ worker job) handles top-level errors.

import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { activities } from "../../db/schema/crm.js";
import { customers, type Customer } from "../../db/schema/customers.js";
import {
  invoiceLines,
  invoices,
  type Invoice,
  type NewInvoice,
  type NewInvoiceLine,
} from "../../db/schema/invoices.js";
import { createLogger } from "../../lib/logger.js";
import { recordActivity } from "../../modules/crm/index.js";
import { QboClient } from "./client.js";
import type {
  QboCreditMemo,
  QboCustomer,
  QboInvoice,
  QboInvoiceLine,
  QboPayment,
} from "./types.js";

const log = createLogger({ component: "qb-sync" });

export type SyncStats = {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
};

const emptyStats = (): SyncStats => ({
  fetched: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
});

// -------- syncCustomers --------

export async function syncCustomers(client?: QboClient): Promise<SyncStats> {
  const qb = client ?? new QboClient();
  const stats = emptyStats();
  log.info("starting QB customer sync");

  const qboCustomers = await qb.getCustomers();
  stats.fetched = qboCustomers.length;
  log.info({ count: stats.fetched }, "fetched QB customers");

  for (const qboCustomer of qboCustomers) {
    try {
      const result = await upsertCustomer(qboCustomer);
      if (result === "created") stats.created++;
      else if (result === "updated") stats.updated++;
      else stats.skipped++;
    } catch (err) {
      stats.failed++;
      log.warn(
        { qb_customer_id: qboCustomer.Id, err: (err as Error).message },
        "customer upsert failed",
      );
    }
  }

  log.info({ stats }, "QB customer sync complete");
  return stats;
}

// Single-customer sync. Replaces 1.0's `syncSingleCustomer(mondayItemId, ...)`.
// No Monday IDs needed — the customer record is identified by qb_customer_id.
export async function syncCustomer(
  qbCustomerId: string,
  client?: QboClient,
): Promise<Customer | null> {
  const qb = client ?? new QboClient();
  const qboCustomer = await qb.getCustomerById(qbCustomerId);
  if (!qboCustomer) {
    log.warn({ qb_customer_id: qbCustomerId }, "customer not found in QBO");
    return null;
  }
  await upsertCustomer(qboCustomer);
  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.qbCustomerId, qbCustomerId))
    .limit(1);
  return rows[0] ?? null;
}

type UpsertResult = "created" | "updated" | "noop";

// Idempotent upsert keyed by qb_customer_id. Always writes an audit_log entry
// for create/update so we have provenance for every state change.
async function upsertCustomer(qboCustomer: QboCustomer): Promise<UpsertResult> {
  const customerLog = log.child({ qb_customer_id: qboCustomer.Id });

  const billingEmails = parseBillingEmails(qboCustomer.PrimaryEmailAddr?.Address);
  const primaryEmail = billingEmails[0] ?? null;

  const desired = {
    qbCustomerId: qboCustomer.Id,
    displayName: qboCustomer.DisplayName,
    primaryEmail,
    // Multiple emails is rare but supported (1.0 stored comma-separated strings).
    billingEmails: billingEmails.length > 1 ? billingEmails : null,
    paymentTerms: qboCustomer.SalesTermRef?.name ?? null,
    balance: formatMoney(qboCustomer.Balance ?? 0),
    lastSyncedAt: new Date(),
  };

  const existing = await db
    .select()
    .from(customers)
    .where(eq(customers.qbCustomerId, qboCustomer.Id))
    .limit(1);

  const before = existing[0];

  if (!before) {
    const id = nanoid(24);
    const inserted = {
      id,
      qbCustomerId: desired.qbCustomerId,
      displayName: desired.displayName,
      primaryEmail: desired.primaryEmail,
      billingEmails: desired.billingEmails,
      paymentTerms: desired.paymentTerms,
      balance: desired.balance,
      lastSyncedAt: desired.lastSyncedAt,
    };
    await db.insert(customers).values(inserted);
    await db.insert(auditLog).values({
      id: nanoid(24),
      action: "qb_sync.customer.create",
      entityType: "customer",
      entityId: id,
      before: null,
      after: inserted as unknown as Record<string, unknown>,
    });
    customerLog.info({ customer_id: id }, "customer created");
    return "created";
  }

  const drift =
    before.displayName !== desired.displayName ||
    before.primaryEmail !== desired.primaryEmail ||
    before.paymentTerms !== desired.paymentTerms ||
    before.balance !== desired.balance ||
    !arraysEqual(before.billingEmails ?? null, desired.billingEmails);

  if (!drift) {
    // Bump lastSyncedAt only — a no-audit touch.
    await db
      .update(customers)
      .set({ lastSyncedAt: desired.lastSyncedAt })
      .where(eq(customers.id, before.id));
    return "noop";
  }

  await db
    .update(customers)
    .set({
      displayName: desired.displayName,
      primaryEmail: desired.primaryEmail,
      billingEmails: desired.billingEmails,
      paymentTerms: desired.paymentTerms,
      balance: desired.balance,
      lastSyncedAt: desired.lastSyncedAt,
    })
    .where(eq(customers.id, before.id));

  await db.insert(auditLog).values({
    id: nanoid(24),
    action: "qb_sync.customer.update",
    entityType: "customer",
    entityId: before.id,
    before: serializableCustomer(before),
    after: {
      ...serializableCustomer(before),
      displayName: desired.displayName,
      primaryEmail: desired.primaryEmail,
      billingEmails: desired.billingEmails,
      paymentTerms: desired.paymentTerms,
      balance: desired.balance,
    },
  });

  // Activity: balance_change (only when the balance specifically moved). Other
  // drift (display name, email) is captured in audit_log already; the activity
  // timeline is for events the team cares about, and balance changes are the
  // load-bearing one for chase prioritization.
  if (before.balance !== desired.balance) {
    const fromAmt = Number(before.balance);
    const toAmt = Number(desired.balance);
    if (Number.isFinite(fromAmt) && Number.isFinite(toAmt)) {
      try {
        await recordActivity({
          customerId: before.id,
          kind: "balance_change",
          source: "qbo_sync",
          refType: "qb_customer",
          refId: qboCustomer.Id,
          meta: {
            from: fromAmt,
            to: toAmt,
            delta: Math.round((toAmt - fromAmt) * 100) / 100,
          },
        });
      } catch (err) {
        customerLog.warn(
          { err: (err as Error).message },
          "balance_change activity emission failed",
        );
      }
    }
  }

  customerLog.info({ customer_id: before.id }, "customer updated");
  return "updated";
}

// -------- syncInvoices --------

export async function syncInvoices(client?: QboClient): Promise<SyncStats> {
  const qb = client ?? new QboClient();
  const stats = emptyStats();
  log.info("starting QB invoice sync");

  const [qboInvoices, customerIdMap] = await Promise.all([
    qb.getInvoices(),
    loadCustomerIdMap(),
  ]);
  stats.fetched = qboInvoices.length;
  log.info({ count: stats.fetched }, "fetched QB invoices");

  for (const qboInvoice of qboInvoices) {
    try {
      const result = await upsertInvoice(qboInvoice, customerIdMap);
      if (result === "created") stats.created++;
      else if (result === "updated") stats.updated++;
      else stats.skipped++;
    } catch (err) {
      stats.failed++;
      log.warn(
        { qb_invoice_id: qboInvoice.Id, err: (err as Error).message },
        "invoice upsert failed",
      );
    }
  }

  // Recompute customers.overdue_balance from the now-current invoices
  // table. QBO's Customer.Balance gives us open AR (which we sync
  // directly) but doesn't expose overdue separately — we derive it from
  // invoice rows where due_date is past and balance is still positive.
  // Done as one bulk UPDATE...JOIN rather than per-customer to keep the
  // sync end-time bounded as the customer count grows.
  await recomputeOverdueBalances();

  log.info({ stats }, "QB invoice sync complete");
  return stats;
}

// One bulk UPDATE that sets customers.overdue_balance to the sum of
// invoice.balance for invoices that are overdue (due_date < today AND
// balance > 0). Customers without overdue invoices get 0. Run this at
// the end of every invoice sync so the denormalized field stays in
// step with the invoice table.
async function recomputeOverdueBalances(): Promise<void> {
  // MySQL UPDATE...JOIN with a derived table — one statement covers
  // both "set to sum" and "reset to 0 when no overdue rows" via the
  // LEFT JOIN + COALESCE. Drizzle doesn't expose UPDATE...JOIN
  // directly, so this goes through the sql tagged template.
  await db.execute(sql`
    UPDATE customers c
    LEFT JOIN (
      SELECT customer_id, SUM(balance) AS overdue
      FROM invoices
      WHERE balance > 0 AND due_date IS NOT NULL AND due_date < CURRENT_DATE
      GROUP BY customer_id
    ) i ON i.customer_id = c.id
    SET c.overdue_balance = COALESCE(i.overdue, 0)
  `);
}

async function upsertInvoice(
  qboInvoice: QboInvoice,
  customerIdMap: Map<string, string>,
): Promise<UpsertResult> {
  const invoiceLog = log.child({ qb_invoice_id: qboInvoice.Id });
  const customerId = customerIdMap.get(qboInvoice.CustomerRef.value);
  if (!customerId) {
    invoiceLog.warn(
      { qb_customer_id: qboInvoice.CustomerRef.value },
      "skipping invoice — customer not yet synced",
    );
    return "noop";
  }

  const status = deriveInvoiceStatus(qboInvoice);
  const issueDate = parseQboDate(qboInvoice.TxnDate);
  const dueDate = parseQboDate(qboInvoice.DueDate);
  const desired: Omit<NewInvoice, "id"> & { id?: string } = {
    qbInvoiceId: qboInvoice.Id,
    customerId,
    docNumber: qboInvoice.DocNumber ?? null,
    issueDate,
    dueDate,
    total: formatMoney(qboInvoice.TotalAmt ?? 0),
    balance: formatMoney(qboInvoice.Balance ?? 0),
    status,
    syncToken: qboInvoice.SyncToken ?? null,
    lastSyncedAt: new Date(),
  };

  const existing = await db
    .select()
    .from(invoices)
    .where(eq(invoices.qbInvoiceId, qboInvoice.Id))
    .limit(1);

  if (!existing[0]) {
    const id = nanoid(24);
    await db.insert(invoices).values({ id, ...desired });
    await syncInvoiceLines(id, qboInvoice.Line ?? []);

    // Activity: qbo_invoice_sent — emit when QBO indicates this invoice has
    // been sent (EmailStatus === 'EmailSent'). Only on the create path; the
    // refType+refId keys to qb_invoice so a subsequent sync that re-creates
    // the row (shouldn't happen — UNIQUE constraint) wouldn't double-emit.
    if (qboInvoice.EmailStatus === "EmailSent") {
      try {
        await recordActivity({
          customerId,
          kind: "qbo_invoice_sent",
          source: "qbo_sync",
          occurredAt: issueDate ?? undefined,
          refType: "qb_invoice",
          refId: qboInvoice.Id,
          // Normalized meta shape across qbo_* activities so the UI can
          // render { amount, currency } uniformly. qbId enables the PDF
          // link route. doc_number kept for display ("Invoice #18307").
          meta: {
            qbId: qboInvoice.Id,
            docNumber: qboInvoice.DocNumber ?? null,
            amount: Number(desired.total),
            currency: qboInvoice.CurrencyRef?.value ?? null,
          },
        });
      } catch (err) {
        invoiceLog.warn(
          { err: (err as Error).message },
          "qbo_invoice_sent activity emission failed",
        );
      }
    }

    return "created";
  }

  const before = existing[0];
  const drift =
    before.docNumber !== desired.docNumber ||
    isoDateOrNull(before.issueDate) !== isoDateOrNull(desired.issueDate) ||
    isoDateOrNull(before.dueDate) !== isoDateOrNull(desired.dueDate) ||
    before.total !== desired.total ||
    before.balance !== desired.balance ||
    before.status !== desired.status ||
    before.syncToken !== desired.syncToken;

  if (!drift) {
    await db
      .update(invoices)
      .set({ lastSyncedAt: desired.lastSyncedAt })
      .where(eq(invoices.id, before.id));
    return "noop";
  }

  // Crucially do NOT touch sent_at / sentVia — those are local fields the app
  // owns. The team-lead brief calls this out explicitly.
  await db
    .update(invoices)
    .set({
      docNumber: desired.docNumber,
      issueDate: desired.issueDate,
      dueDate: desired.dueDate,
      total: desired.total,
      balance: desired.balance,
      status: desired.status,
      syncToken: desired.syncToken,
      lastSyncedAt: desired.lastSyncedAt,
    })
    .where(eq(invoices.id, before.id));

  await syncInvoiceLines(before.id, qboInvoice.Line ?? []);
  return "updated";
}

// Replace strategy: delete + reinsert lines on each update. Cheaper than
// diffing and the row count per invoice is small. FK is ON DELETE CASCADE.
async function syncInvoiceLines(
  invoiceId: string,
  qboLines: QboInvoiceLine[],
): Promise<void> {
  await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));

  const rows: NewInvoiceLine[] = [];
  for (const line of qboLines) {
    if (line.DetailType !== "SalesItemLineDetail") continue; // skip subtotals/discounts
    const detail = line.SalesItemLineDetail;
    const qty = detail?.Qty ?? null;
    const unitPrice = detail?.UnitPrice ?? null;
    rows.push({
      id: nanoid(24),
      invoiceId,
      sku: detail?.ItemRef?.name ?? null,
      description: line.Description ?? null,
      qty: qty !== null ? qty.toString() : null,
      unitPrice: unitPrice !== null ? unitPrice.toString() : null,
      lineTotal: line.Amount !== undefined ? formatMoney(line.Amount) : null,
      position: line.LineNum ?? null,
    });
  }
  if (rows.length > 0) {
    await db.insert(invoiceLines).values(rows);
  }
}

// -------- syncPayments --------
//
// Payments don't have their own table in 2.0's schema (per current Drizzle
// setup). The sync surfaces them by re-fetching invoices and recalculating
// balance — getInvoices() picks up the new balance after a payment posts.
// We expose a stub here so the worker can call it explicitly; it just
// triggers an invoice re-sync. If a `payments` table is added later, this
// is where the upsert logic lands.

export async function syncPayments(client?: QboClient): Promise<SyncStats> {
  const qb = client ?? new QboClient();
  log.info("starting QB payment sync (via invoice resync)");
  const payments = await qb.getPayments();
  log.info({ count: payments.length }, "fetched QB payments");

  // Emit per-payment activities for any payments we haven't seen before.
  // Without a payments table the activities row itself is the dedup key:
  // (refType='qb_payment', refId=payment.Id) is unique per emission.
  await emitPaymentActivities(payments);

  return syncInvoices(qb);
}

export async function syncCreditMemos(client?: QboClient): Promise<SyncStats> {
  const qb = client ?? new QboClient();
  const stats = emptyStats();
  log.info("starting QB credit memo sync");
  const memos = await qb.getCreditMemos();
  stats.fetched = memos.length;
  log.info({ count: memos.length }, "fetched QB credit memos");

  await emitCreditMemoActivities(memos);
  // No dedicated credit_memos table yet — the activity row is the trace.
  return stats;
}

async function emitPaymentActivities(payments: QboPayment[]): Promise<void> {
  if (payments.length === 0) return;
  const customerIdMap = await loadCustomerIdMap();

  for (const payment of payments) {
    const customerId = customerIdMap.get(payment.CustomerRef.value);
    if (!customerId) continue; // customer not yet synced — skip silently

    if (await activityAlreadyEmitted("qb_payment", payment.Id)) continue;

    try {
      await recordActivity({
        customerId,
        kind: "qbo_payment",
        source: "qbo_sync",
        occurredAt: parseQboDate(payment.TxnDate) ?? undefined,
        refType: "qb_payment",
        refId: payment.Id,
        meta: {
          qbId: payment.Id,
          amount: payment.TotalAmt ?? 0,
          currency: payment.CurrencyRef?.value ?? null,
          txnDate: payment.TxnDate ?? null,
        },
      });
    } catch (err) {
      log.warn(
        { err: (err as Error).message, payment_id: payment.Id },
        "qbo_payment activity emission failed",
      );
    }
  }
}

async function emitCreditMemoActivities(memos: QboCreditMemo[]): Promise<void> {
  if (memos.length === 0) return;
  const customerIdMap = await loadCustomerIdMap();

  for (const memo of memos) {
    const customerId = customerIdMap.get(memo.CustomerRef.value);
    if (!customerId) continue;

    if (await activityAlreadyEmitted("qb_credit_memo", memo.Id)) continue;

    try {
      await recordActivity({
        customerId,
        kind: "qbo_credit_memo",
        source: "qbo_sync",
        occurredAt: parseQboDate(memo.TxnDate) ?? undefined,
        refType: "qb_credit_memo",
        refId: memo.Id,
        meta: {
          qbId: memo.Id,
          docNumber: memo.DocNumber ?? null,
          amount: memo.TotalAmt ?? 0,
          currency: memo.CurrencyRef?.value ?? null,
          txnDate: memo.TxnDate ?? null,
        },
      });
    } catch (err) {
      log.warn(
        { err: (err as Error).message, credit_memo_id: memo.Id },
        "qbo_credit_memo activity emission failed",
      );
    }
  }
}

// Cross-run dedup: did we already write an activity for this (refType, refId)?
// Cheaper than a payments table for now; the activities index on (ref_type,
// ref_id) makes this a key-only lookup. Move this off-table once payments
// land in their own schema.
async function activityAlreadyEmitted(
  refType: string,
  refId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.refType, refType), eq(activities.refId, refId)))
    .limit(1);
  return rows.length > 0;
}

// -------- helpers --------

async function loadCustomerIdMap(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: customers.id, qbCustomerId: customers.qbCustomerId })
    .from(customers);
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.qbCustomerId) map.set(row.qbCustomerId, row.id);
  }
  return map;
}

function deriveInvoiceStatus(qboInvoice: QboInvoice): Invoice["status"] {
  const total = qboInvoice.TotalAmt ?? 0;
  const balance = qboInvoice.Balance ?? 0;
  if (balance <= 0) return "paid";
  if (balance < total) return "partial";
  if (qboInvoice.DueDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (qboInvoice.DueDate < today) return "overdue";
  }
  if (qboInvoice.EmailStatus === "EmailSent") return "sent";
  return "sent";
}

function parseBillingEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0 && e.includes("@"));
}

// MySQL DECIMAL(12,2) is stored as a string in mysql2; coerce numbers consistently.
function formatMoney(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function arraysEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Drizzle's date column returns a Date in our config. Normalize to a
// YYYY-MM-DD string for stable comparisons.
function isoDateOrNull(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

// QBO returns dates as 'YYYY-MM-DD' strings. Drizzle date column expects Date.
// Construct as UTC to keep date-only semantics — local timezone shifts could
// roll the day over for users east of UTC.
function parseQboDate(v: string | undefined | null): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
}

function serializableCustomer(c: Customer): Record<string, unknown> {
  return {
    id: c.id,
    qbCustomerId: c.qbCustomerId,
    displayName: c.displayName,
    primaryEmail: c.primaryEmail,
    billingEmails: c.billingEmails,
    paymentTerms: c.paymentTerms,
    balance: c.balance,
    holdStatus: c.holdStatus,
  };
}
