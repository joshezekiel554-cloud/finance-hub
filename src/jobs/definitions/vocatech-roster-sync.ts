// Vocatech roster sync job.
//
// Pushes our customer records into Vocatech's contact directory so the VoIP
// UI can show the customer name when a call comes in. Two modes:
//
//   full (scope: "b2b" | "all")
//     Push all customers matching the scope. Used for first-install hydration
//     or operator-triggered refreshes from the Settings page.
//
//   delta
//     Push only customers where updated_at > vocatech_last_pushed_at (or
//     where vocatech_last_pushed_at IS NULL). Runs nightly at 02:00
//     Europe/London via the cron registered in schedule.ts.
//
// After each successful 500-row batch we stamp vocatech_last_pushed_at = NOW()
// on the batch so a failure mid-way through leaves all prior batches durable.
//
// Customers with zero non-empty phone numbers are skipped — there's no point
// pushing them since Vocatech matches by phone, and the push would waste an
// API slot.
//
// 429 handling: same rationale as backfill — let VocatechApiError propagate
// and rely on BullMQ's 3-attempt exponential backoff. Roster sync is not
// latency-sensitive and the nightly cron fires at 02:00 with no contention.
//
// SSE events: none. Roster pushes don't affect the in-app timeline.

import type { Job } from "bullmq";
import { upsertContacts } from "../../integrations/vocatech/client.js";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { sql } from "drizzle-orm";
import { eq, isNull, or, gt, inArray } from "drizzle-orm";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.vocatech-roster-sync" });

export type VocatechRosterSyncJobData =
  | { mode: "full"; scope: "b2b" | "all" }
  | { mode: "delta" };

export type VocatechRosterSyncJobResult = {
  pushed: number;
  skipped: number;
};

const BATCH_SIZE = 500;

export async function vocatechRosterSyncHandler(
  job: Job<VocatechRosterSyncJobData>,
): Promise<VocatechRosterSyncJobResult> {
  const { mode } = job.data;
  log.info({ mode, ...(mode === "full" ? { scope: (job.data as { scope: string }).scope } : {}) }, "roster sync starting");

  // --- Query customers -------------------------------------------------------

  type CustomerRow = {
    id: string;
    displayName: string;
    phone: string | null;
    additionalPhones: Array<{ label: string; number: string }> | null;
  };

  let rows: CustomerRow[];

  if (mode === "full") {
    const scope = (job.data as { mode: "full"; scope: "b2b" | "all" }).scope;
    if (scope === "b2b") {
      rows = await db
        .select({
          id: customers.id,
          displayName: customers.displayName,
          phone: customers.phone,
          additionalPhones: customers.additionalPhones,
        })
        .from(customers)
        .where(eq(customers.customerType, "b2b"));
    } else {
      rows = await db
        .select({
          id: customers.id,
          displayName: customers.displayName,
          phone: customers.phone,
          additionalPhones: customers.additionalPhones,
        })
        .from(customers);
    }
  } else {
    // delta: push customers not yet pushed, or updated since last push
    rows = await db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        phone: customers.phone,
        additionalPhones: customers.additionalPhones,
      })
      .from(customers)
      .where(
        or(
          isNull(customers.vocatechLastPushedAt),
          gt(customers.updatedAt, customers.vocatechLastPushedAt),
        ),
      );
  }

  const total = rows.length;
  log.info({ total, mode }, "customers loaded");

  let pushed = 0;
  let skipped = 0;

  // Process in batches of BATCH_SIZE.
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);

    const contacts: Array<{ external_id: string; name: string; phone_numbers: string[] }> = [];
    const batchIds: string[] = [];

    for (const row of batch) {
      const phoneNumbers: string[] = [];
      if (row.phone && row.phone.trim().length > 0) {
        phoneNumbers.push(row.phone.trim());
      }
      if (Array.isArray(row.additionalPhones)) {
        for (const p of row.additionalPhones) {
          if (p.number && p.number.trim().length > 0) {
            phoneNumbers.push(p.number.trim());
          }
        }
      }

      if (phoneNumbers.length === 0) {
        skipped++;
        continue;
      }

      if (row.displayName.trim().length === 0) {
        skipped++;
        continue;
      }

      contacts.push({
        external_id: row.id,
        name: row.displayName,
        phone_numbers: phoneNumbers,
      });
      batchIds.push(row.id);
    }

    if (contacts.length > 0) {
      await upsertContacts(contacts);

      // Use server-side NOW() so vocatech_last_pushed_at and the ON UPDATE
      // CURRENT_TIMESTAMP on updated_at are computed in the same statement,
      // preventing updated_at > vocatech_last_pushed_at skew that would cause
      // the delta query to re-push the entire roster nightly.
      await db
        .update(customers)
        .set({ vocatechLastPushedAt: sql`NOW()` })
        .where(inArray(customers.id, batchIds));

      pushed += contacts.length;
    }

    await job.updateProgress({ pushed, total });
    log.debug({ pushed, skipped, total }, "roster sync batch done");
  }

  log.info({ pushed, skipped, total }, "roster sync complete");
  return { pushed, skipped };
}
