// "Note from hub" — a team-only timeline note the hub's Chief of Staff panel
// attaches to a finance signal (POST /api/ext/signals/note). The customer is
// derived from the signal key (finance.<kind>.<customerId>.<rest>). Notes do
// NOT change chasing; they're context for whoever opens the customer next.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/auth.js";
import { activities } from "../../db/schema/crm.js";
import { customers } from "../../db/schema/customers.js";
import { createLogger } from "../../lib/logger.js";
import { recordActivity, type RecordActivityInput } from "../crm/activity-ingester.js";

const log = createLogger({ component: "promises.hub-notes" });

export const HUB_NOTE_MAX = 1000;
export const HUB_NOTE_REF_TYPE = "hub_note";

/** Customer id from a finance signal key, or null if it isn't one. */
export function customerIdFromSignalKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) return null;
  const parts = key.split(".");
  if (parts.length < 3 || parts[0] !== "finance" || !parts[1]) return null;
  const id = parts[2];
  return id && /^[A-Za-z0-9_-]{1,24}$/.test(id) ? id : null;
}

export type HubNoteResult =
  | { ok: true; changed: boolean; customerId: string; activityId: string | null }
  | { ok: false; reason: "not_found"; error: string };

export type HubNoteDeps = {
  customerExists: (customerId: string) => Promise<boolean>;
  /** Note texts (meta.note) of earlier hub notes on this customer. */
  existingHubNotes: (customerId: string) => Promise<string[]>;
  actorName: (email: string) => Promise<{ userId: string | null; name: string | null }>;
  recordActivity: (input: RecordActivityInput) => Promise<string | null>;
};

export const defaultHubNoteDeps: HubNoteDeps = {
  async customerExists(customerId) {
    const [row] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).limit(1);
    return Boolean(row);
  },
  async existingHubNotes(customerId) {
    const rows = await db
      .select({ meta: activities.meta })
      .from(activities)
      .where(
        and(
          eq(activities.customerId, customerId),
          eq(activities.kind, "manual_note"),
          eq(activities.refType, HUB_NOTE_REF_TYPE),
        ),
      )
      .orderBy(desc(activities.occurredAt))
      .limit(500);
    return rows.map((r) => (typeof r.meta?.note === "string" ? r.meta.note : "")).filter(Boolean);
  },
  async actorName(email) {
    const [u] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return { userId: u?.id ?? null, name: u?.name?.trim() || null };
  },
  recordActivity: (input) => recordActivity(input),
};

/** Trim + validate a hub note; null when empty or too long. */
export function cleanHubNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const t = note.trim();
  return t.length > 0 && t.length <= HUB_NOTE_MAX ? t : null;
}

export async function addHubNote(
  input: { customerId: string; note: string; actorEmail: string; signalKey: string },
  deps: HubNoteDeps = defaultHubNoteDeps,
): Promise<HubNoteResult> {
  if (!(await deps.customerExists(input.customerId))) {
    return { ok: false, reason: "not_found", error: "unknown customer" };
  }
  const existing = await deps.existingHubNotes(input.customerId);
  if (existing.includes(input.note)) {
    return { ok: true, changed: false, customerId: input.customerId, activityId: null };
  }
  const actor = input.actorEmail.trim().toLowerCase();
  const who = await deps.actorName(actor);
  const activityId = await deps.recordActivity({
    customerId: input.customerId,
    kind: "manual_note",
    source: "user_action",
    userId: who.userId,
    subject: "Note from hub",
    body: `Note from hub (${who.name ?? actor}): ${input.note}`,
    refType: HUB_NOTE_REF_TYPE,
    refId: input.signalKey.slice(0, 64),
    meta: { source: "hub", note: input.note, setBy: actor, signalKey: input.signalKey },
  });
  log.info({ customerId: input.customerId, signalKey: input.signalKey }, "hub note recorded");
  return { ok: true, changed: true, customerId: input.customerId, activityId };
}
