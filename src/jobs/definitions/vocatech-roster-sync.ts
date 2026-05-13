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
// After each successful batch we stamp vocatech_last_pushed_at = NOW() only
// for the contacts that succeeded (not failed ones, so they retry next delta).
//
// Customers with zero non-empty phone numbers are skipped — Vocatech matches
// by phone and the push would waste an API slot.
//
// 429 handling: let VocatechApiError propagate and rely on BullMQ's 3-attempt
// exponential backoff. Roster sync is not latency-sensitive.
//
// SSE events: none. Roster pushes don't affect the in-app timeline.

import type { Job } from "bullmq";
import { getContactFields, upsertContacts } from "../../integrations/vocatech/client.js";
import type { VocatechContactField } from "../../integrations/vocatech/client.js";
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
  errors: number;
};

const BATCH_SIZE = 500;

// Field selection heuristic:
//
// 1. phoneField   — first field with is_phone === true (required)
// 2. nameField    — first non-phone, non-integration field. Among those,
//                   prefer one whose name contains "name", "company", or
//                   "contact" (case-insensitive) as that's the most likely
//                   display-name field; otherwise fall back to lowest order.
// 3. externalIdField (optional) — first is_match, non-phone, non-integration
//                   field that is NOT the same field as nameField. Used for
//                   stable dedup keyed on our internal customer.id.
function selectFields(fields: VocatechContactField[]): {
  phoneField: VocatechContactField;
  nameField: VocatechContactField;
  externalIdField: VocatechContactField | null;
} {
  const sorted = [...fields].sort((a, b) => a.order - b.order);

  const phoneField = sorted.find((f) => f.is_phone);
  const textCandidates = sorted.filter((f) => !f.is_phone && !f.is_integration);

  const nameKeywords = /name|company|contact/i;
  const nameField =
    textCandidates.find((f) => nameKeywords.test(f.name)) ?? textCandidates[0];

  if (!phoneField || !nameField) {
    throw new Error(
      "Vocatech tenant has no usable contact fields configured. " +
      "Please define at least one phone field (is_phone=true) and one text field in Vocatech's admin UI. " +
      "Recommended: 'Company' (text, is_match=true), 'Phone' (is_phone=true, is_match=true), 'External ID' (text, is_match=true).",
    );
  }

  const externalIdField =
    sorted.find(
      (f) =>
        f.is_match &&
        !f.is_phone &&
        !f.is_integration &&
        f.id !== nameField.id,
    ) ?? null;

  return { phoneField, nameField, externalIdField };
}

export async function vocatechRosterSyncHandler(
  job: Job<VocatechRosterSyncJobData>,
): Promise<VocatechRosterSyncJobResult> {
  const { mode } = job.data;
  log.info({ mode, ...(mode === "full" ? { scope: (job.data as { scope: string }).scope } : {}) }, "roster sync starting");

  // --- Field discovery / precondition check ----------------------------------

  const { fields: allFields } = await getContactFields();
  const { phoneField, nameField, externalIdField } = selectFields(allFields);

  log.info(
    {
      phone_field: phoneField.name,
      name_field: nameField.name,
      external_id_field: externalIdField?.name ?? null,
      all_field_names: allFields.map((f) => f.name),
    },
    "vocatech field mapping selected",
  );

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
  let errors = 0;

  // Process in batches of BATCH_SIZE.
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);

    // Build contact payloads and track which batch index maps to which customer id.
    const contacts: Array<{ fields: Record<string, string> }> = [];
    const batchCustomerIds: string[] = []; // parallel array — same index as contacts[]

    for (const row of batch) {
      const allPhones: string[] = [];
      if (row.phone && row.phone.trim().length > 0) {
        allPhones.push(row.phone.trim());
      }
      if (Array.isArray(row.additionalPhones)) {
        for (const p of row.additionalPhones) {
          if (p.number && p.number.trim().length > 0) {
            allPhones.push(p.number.trim());
          }
        }
      }

      if (allPhones.length === 0) {
        skipped++;
        continue;
      }

      const displayName = row.displayName.trim();
      if (displayName.length === 0) {
        skipped++;
        continue;
      }

      const fieldMap: Record<string, string> = {
        [phoneField.name]: allPhones.join(";"),
        [nameField.name]: displayName,
      };
      if (externalIdField) {
        fieldMap[externalIdField.name] = row.id;
      }

      contacts.push({ fields: fieldMap });
      batchCustomerIds.push(row.id);
    }

    if (contacts.length === 0) continue;

    const response = await upsertContacts(contacts);

    // Build a set of failed indices so we only stamp customers that succeeded.
    // We intentionally skip failed indices — they keep vocatech_last_pushed_at
    // unset/stale so the next delta run will retry them automatically.
    const failedIndices = new Set(response.errors.map((e) => e.index));
    const toStampIds: string[] = [];

    for (let i = 0; i < batchCustomerIds.length; i++) {
      if (!failedIndices.has(i)) {
        toStampIds.push(batchCustomerIds[i]!);
      }
    }

    const errorsThisBatch = response.errors.length;
    const pushedThisBatch = contacts.length - errorsThisBatch;

    if (errorsThisBatch > 0) {
      log.warn(
        {
          errors_this_batch: errorsThisBatch,
          sample: response.errors.slice(0, 5),
        },
        "vocatech upsert returned per-row errors",
      );
    }

    if (toStampIds.length > 0) {
      // Use server-side NOW() so vocatech_last_pushed_at and the ON UPDATE
      // CURRENT_TIMESTAMP on updated_at are computed in the same statement,
      // preventing updated_at > vocatech_last_pushed_at skew that would cause
      // the delta query to re-push the entire roster nightly.
      await db
        .update(customers)
        .set({ vocatechLastPushedAt: sql`NOW()` })
        .where(inArray(customers.id, toStampIds));
    }

    pushed += pushedThisBatch;
    errors += errorsThisBatch;

    await job.updateProgress({ pushed, total });
    log.debug({ pushed, skipped, errors, total }, "roster sync batch done");
  }

  log.info({ pushed, skipped, errors, total }, "roster sync complete");
  return { pushed, skipped, errors };
}
