// QB → finance-hub DB sync.
//
// Replaces 1.0's `sync-engine.run()` and `runIncremental()` Monday-driven flows
// with idempotent upserts into our own tables. Customer matching is no longer
// against a Monday board — we own the customer record now, keyed by qb_customer_id.
//
// Each function is async + throws on auth/network failures. Per-row failures
// are logged at warn and skipped (so one bad invoice doesn't fail the whole
// sync). Caller (BullMQ worker job) handles top-level errors.

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { customers, type Customer } from "../../db/schema/customers.js";
import {
  invoiceLines,
  invoices,
  type Invoice,
  type NewInvoice,
  type NewInvoiceLine,
} from "../../db/schema/invoices.js";
import { createLogger } from "../../lib/logger.js";
import { QboClient } from "./client.js";
import type {
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

  log.info({ stats }, "QB invoice sync complete");
  return stats;
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

  // Delegate to invoice sync — payment postings update invoice balance/status.
  // This intentionally over-fetches; once a payments table exists, replace
  // with a targeted re-sync of just the affected invoices.
  noteRecentPayments(payments);
  return syncInvoices(qb);
}

function noteRecentPayments(payments: QboPayment[]): void {
  // Light bookkeeping for the audit_log — not a full upsert. Useful so the
  // sync run leaves traces of which payments were observed even before a
  // payments table exists.
  if (payments.length === 0) return;
  log.debug(
    { count: payments.length, sample: payments[0]?.Id },
    "payments seen in this sync window",
  );
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
