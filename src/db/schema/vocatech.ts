import {
  mysqlTable,
  varchar,
  text,
  mediumtext,
  json,
  int,
  timestamp,
  mysqlEnum,
  index,
} from "drizzle-orm/mysql-core";

// Raw audit log of every Vocatech webhook event we receive. Source of
// truth for replay/debug. PK on evt_* id makes inserts idempotent —
// duplicate deliveries from Vocatech's at-least-once retries silently
// no-op via the unique-id constraint.
export const vocatechEvents = mysqlTable("vocatech_events", {
  id: varchar("id", { length: 64 }).primaryKey(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  rawPayload: json("raw_payload").notNull(),
  processingError: text("processing_error"),
});

// Normalized record of every phone interaction (calls AND SMS). One
// table with a `kind` discriminator keeps the customer-page timeline
// query trivial. source_event_id links back to the Vocatech event for
// replays / debugging.
export const phoneCommunications = mysqlTable(
  "phone_communications",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    kind: mysqlEnum("kind", ["call_in", "call_out", "sms_in", "sms_out"]).notNull(),
    customerId: varchar("customer_id", { length: 24 }),
    phoneLabelMatched: varchar("phone_label_matched", { length: 64 }),
    remoteNumber: varchar("remote_number", { length: 32 }).notNull(),
    extensionNumber: varchar("extension_number", { length: 32 }),
    extensionName: varchar("extension_name", { length: 128 }),
    direction: mysqlEnum("direction", ["inbound", "outbound"]).notNull(),
    startedAt: timestamp("started_at").notNull(),
    durationSeconds: int("duration_seconds"),
    body: text("body"),
    transcription: mediumtext("transcription"),
    recordingMediaId: varchar("recording_media_id", { length: 64 }),
    smsStatus: mysqlEnum("sms_status", ["sent", "delivered", "read", "failed"]),
    groupNumber: varchar("group_number", { length: 32 }),
    sourceEventId: varchar("source_event_id", { length: 64 }).unique(),
    dismissedAt: timestamp("dismissed_at"),
    dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    customerIdx: index("phone_comm_customer_idx").on(t.customerId, t.startedAt),
    unmatchedIdx: index("phone_comm_unmatched_idx").on(t.customerId, t.dismissedAt, t.startedAt),
    remoteIdx: index("phone_comm_remote_idx").on(t.remoteNumber),
  }),
);

export type VocatechEvent = typeof vocatechEvents.$inferSelect;
export type PhoneCommunication = typeof phoneCommunications.$inferSelect;
