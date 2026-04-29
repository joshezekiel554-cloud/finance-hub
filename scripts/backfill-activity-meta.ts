// One-off: rewrite the meta payload on activities written before the
// normalization commit (16bf467). Old shapes per kind:
//
//   qbo_invoice_sent:  { invoice_id, doc_number, total }
//   qbo_payment:       { payment_id, amount, txn_date }
//   qbo_credit_memo:   { credit_memo_id, amount, txn_date }
//
// New uniform shape:
//   { qbId, docNumber?, amount, currency, txnDate? }
//
// `currency` stays null for backfilled rows — we don't have the source
// data without re-fetching every QB record, and the activity-timeline's
// formatAmount() already falls back to a plain "$X.XX" prefix when
// currency is null. Acceptable cost for a one-shot historical sweep.
//
// Idempotent: rows that already have qbId in their meta are skipped, so
// re-running this is a no-op.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { activities, type Activity } from "../src/db/schema/crm.js";

type OldInvoiceMeta = {
  invoice_id?: string;
  doc_number?: string | null;
  total?: number;
};
type OldPaymentMeta = {
  payment_id?: string;
  amount?: number;
  txn_date?: string | null;
};
type OldCreditMemoMeta = {
  credit_memo_id?: string;
  amount?: number;
  txn_date?: string | null;
};
type NewMeta = {
  qbId: string;
  docNumber?: string | null;
  amount: number;
  currency: string | null;
  txnDate?: string | null;
};

function rebuildMeta(row: Activity): NewMeta | null {
  const m = (row.meta ?? {}) as Record<string, unknown>;
  // Already migrated — skip.
  if (typeof m.qbId === "string") return null;

  if (row.kind === "qbo_invoice_sent") {
    const old = m as OldInvoiceMeta;
    if (!old.invoice_id || old.total === undefined) return null;
    return {
      qbId: old.invoice_id,
      docNumber: old.doc_number ?? null,
      amount: Number(old.total),
      currency: null,
    };
  }
  if (row.kind === "qbo_payment") {
    const old = m as OldPaymentMeta;
    if (!old.payment_id || old.amount === undefined) return null;
    return {
      qbId: old.payment_id,
      amount: Number(old.amount),
      currency: null,
      txnDate: old.txn_date ?? null,
    };
  }
  if (row.kind === "qbo_credit_memo") {
    const old = m as OldCreditMemoMeta;
    if (!old.credit_memo_id || old.amount === undefined) return null;
    return {
      qbId: old.credit_memo_id,
      amount: Number(old.amount),
      currency: null,
      txnDate: old.txn_date ?? null,
    };
  }
  return null;
}

async function main() {
  const t0 = Date.now();
  const KINDS = ["qbo_invoice_sent", "qbo_payment", "qbo_credit_memo"] as const;
  const rows = await db
    .select()
    .from(activities)
    .where(inArray(activities.kind, KINDS as unknown as string[]));

  console.log(`Loaded ${rows.length} candidate activity rows.`);

  let migrated = 0;
  let skipped = 0;
  let invalid = 0;

  // Update one at a time — there's no easy bulk-update with row-specific
  // JSON in MySQL/Drizzle. ~few thousand rows max here so per-row is fine.
  for (const row of rows) {
    const next = rebuildMeta(row);
    if (next === null) {
      // Already migrated OR shape didn't match expected old keys
      const m = (row.meta ?? {}) as Record<string, unknown>;
      if (typeof m.qbId === "string") skipped++;
      else invalid++;
      continue;
    }
    await db
      .update(activities)
      .set({ meta: next as unknown as Record<string, unknown> })
      .where(eq(activities.id, row.id));
    migrated++;
  }

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log("  migrated:        ", migrated);
  console.log("  already migrated:", skipped);
  console.log("  unrecognized:    ", invalid);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
