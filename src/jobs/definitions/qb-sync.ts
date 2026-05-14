// QB sync job processor.
//
// Composes syncCustomers + syncInvoices + syncPayments + syncCreditMemos in
// series (invoices reference customers, payments reference invoices,
// credit memos reference customers; credit-memo recompute updates the
// customers.unapplied_credit_balance column so it needs an authoritative
// memo list each cycle). Writes a sync_runs row at start, updates it at
// end with stats + status. On error the row is marked failed and the
// error is rethrown so BullMQ records the attempt and applies its retry
// policy.
//
// Shadow mode: this job is read-only against QBO and write-only against our
// own DB, so it runs identically in shadow and live modes. The flag is
// intentionally NOT checked here.

import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { syncRuns } from "../../db/schema/audit.js";
import {
  syncCreditMemos,
  syncCustomers,
  syncInvoices,
  syncPayments,
  type SyncStats,
} from "../../integrations/qb/sync.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.qb-sync" });

export type QbSyncJobData = {
  // Reserved — the repeatable job runs without args. Kept as an explicit type
  // so future ad-hoc enqueues (e.g. "sync this one customer") can be typed.
  trigger?: "scheduled" | "manual";
};

export type QbSyncJobResult = {
  syncRunId: string;
  customers: SyncStats;
  invoices: SyncStats;
  payments: SyncStats;
  creditMemos: SyncStats;
  durationMs: number;
};

export async function processQbSync(
  job: Job<QbSyncJobData>,
): Promise<QbSyncJobResult> {
  const startedAt = Date.now();
  const syncRunId = nanoid(24);
  const jobLog = log.child({ jobId: job.id, syncRunId });

  await db.insert(syncRuns).values({
    id: syncRunId,
    kind: "qb_full",
    status: "running",
  });

  jobLog.info({ stage: "started", trigger: job.data.trigger ?? "scheduled" }, "qb-sync job started");

  try {
    // Order matters: invoices FK customers; payments resolve via invoice resync;
    // credit memos run last because the recompute reads the freshly-synced
    // customer set when matching CustomerRef → customer row.
    const customerStats = await syncCustomers();
    const invoiceStats = await syncInvoices();
    const paymentStats = await syncPayments();
    const creditMemoStats = await syncCreditMemos();

    const durationMs = Date.now() - startedAt;
    const totalFailed =
      customerStats.failed +
      invoiceStats.failed +
      paymentStats.failed +
      creditMemoStats.failed;
    // If individual rows failed but the run completed, mark partial — neither
    // a clean ok nor a hard failure. Helps the dashboard surface drift.
    const status: "ok" | "partial" = totalFailed > 0 ? "partial" : "ok";

    await db
      .update(syncRuns)
      .set({
        completedAt: new Date(),
        status,
        stats: {
          customers: customerStats,
          invoices: invoiceStats,
          payments: paymentStats,
          creditMemos: creditMemoStats,
          durationMs,
        },
      })
      .where(eq(syncRuns.id, syncRunId));

    jobLog.info(
      {
        stage: "completed",
        status,
        customers: customerStats,
        invoices: invoiceStats,
        payments: paymentStats,
        creditMemos: creditMemoStats,
        durationMs,
      },
      "qb-sync job completed",
    );

    return {
      syncRunId,
      customers: customerStats,
      invoices: invoiceStats,
      payments: paymentStats,
      creditMemos: creditMemoStats,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({
        completedAt: new Date(),
        status: "failed",
        errorMessage: message.slice(0, 1000),
      })
      .where(eq(syncRuns.id, syncRunId))
      .catch((updateErr) => {
        // Don't let the bookkeeping failure mask the original error.
        jobLog.error({ err: updateErr }, "failed to mark sync_run as failed");
      });
    jobLog.error({ err, stage: "failed" }, "qb-sync job failed");
    throw err;
  }
}
