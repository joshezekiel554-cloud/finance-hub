// Central activity ingester. All callers that need to write a row to the
// `activities` table go through `recordActivity` so audit_log entries are
// uniformly written in the same transaction.
//
// Per the plan §Modules → Activity ingestion: every write to `activities`
// also writes an `audit_log(action='activity_created', entity_type='activity')`
// row capturing the full activity body in `after`. The two writes land
// atomically — partial state (activity without audit) would defeat the point
// of having an audit log at all.
//
// Callers (Gmail poller, QB sync, hold toggle, etc.) should pass the natural
// references they already have (refType + refId) so the activity row links
// back to its source record.

import { nanoid } from "nanoid";
import { db, type DB } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import {
  activities,
  type Activity,
  type NewActivity,
} from "../../db/schema/crm.js";
import { events } from "../../lib/events.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "activity-ingester" });

export type ActivityKind = NewActivity["kind"];
export type ActivitySource = NewActivity["source"];

export type RecordActivityInput = {
  customerId: string | null;
  kind: ActivityKind;
  source: ActivitySource;
  userId?: string | null;
  occurredAt?: Date;
  subject?: string | null;
  body?: string | null;
  bodyHtml?: string | null;
  refType?: string | null;
  refId?: string | null;
  meta?: Record<string, unknown> | null;
};

// Returns the id of the new activity row, or `null` if the call was a no-op
// (e.g. customerId resolved to null and no fallback policy was provided).
//
// Why allow customerId === null here: the resolver may return null for a
// matched email, a QB customer the sync hasn't seen yet, etc. The brief asks
// us to "just don't crash" — bailing out cleanly is the contract. activities
// is FK-NOT-NULL on customer_id so we can't write a row anyway.
export async function recordActivity(
  input: RecordActivityInput,
  database: DB = db,
): Promise<string | null> {
  if (!input.customerId) {
    log.debug(
      { kind: input.kind, source: input.source, refType: input.refType, refId: input.refId },
      "skipping activity — no customer_id resolved",
    );
    return null;
  }

  const id = nanoid(24);
  const occurredAt = input.occurredAt ?? new Date();

  // Build the row up-front so the audit `after` payload matches what we wrote.
  const row: NewActivity = {
    id,
    customerId: input.customerId,
    userId: input.userId ?? null,
    kind: input.kind,
    occurredAt,
    subject: input.subject ?? null,
    body: input.body ?? null,
    bodyHtml: input.bodyHtml ?? null,
    source: input.source,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    meta: input.meta ?? null,
  };

  await database.transaction(async (tx) => {
    await tx.insert(activities).values(row);
    await tx.insert(auditLog).values({
      id: nanoid(24),
      userId: input.userId ?? null,
      action: "activity_created",
      entityType: "activity",
      entityId: id,
      before: null,
      after: serializableActivity(row),
    });
  });

  // Don't log full body — emails routinely contain PII and the audit_log row
  // already carries the full payload for compliance lookups.
  log.info(
    {
      activityId: id,
      customerId: input.customerId,
      kind: input.kind,
      source: input.source,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
    },
    "activity recorded",
  );

  // Fire after the transaction commits so subscribers see committed
  // state. The SSE plugin listens to this and rebroadcasts to all
  // connected clients; the activity timeline component invalidates its
  // query when the customerId matches.
  events.emit("activity.created", {
    activityId: id,
    customerId: input.customerId,
    kind: input.kind,
  });

  return id;
}

// JSON-safe view of the activity row for audit_log.after. occurredAt is a
// Date here; ISO-stringify so `JSON.parse(JSON.stringify(...))` round-trips
// the way readers expect.
function serializableActivity(row: NewActivity): Record<string, unknown> {
  return {
    id: row.id,
    customerId: row.customerId,
    userId: row.userId ?? null,
    kind: row.kind,
    occurredAt:
      row.occurredAt instanceof Date
        ? row.occurredAt.toISOString()
        : (row.occurredAt ?? null),
    subject: row.subject ?? null,
    body: row.body ?? null,
    bodyHtml: row.bodyHtml ?? null,
    source: row.source,
    refType: row.refType ?? null,
    refId: row.refId ?? null,
    meta: row.meta ?? null,
  };
}

// Re-export the row type so callers don't need to reach into the schema.
export type { Activity };
