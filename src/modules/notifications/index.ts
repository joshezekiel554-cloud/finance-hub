// Bell-notification writer. Single entry point — every part of the app
// that wants to push something to a user's bell calls recordNotification()
// instead of touching the table directly. Keeps three concerns in one
// place:
//   - Persistence (insert into notifications)
//   - Delivery flagging (deliveredInApp=true since the SSE event below
//     IS the in-app delivery; email/push flip later when those land)
//   - Domain-event emit so the SSE plugin can fan out to the recipient's
//     open browser tabs in real time
//
// Dedupe is opt-in via `dedupeOnRefId`: when set, we skip the insert if
// an unread row already exists for (userId, kind, refType, refId). Used
// by the task_overdue cron so we don't spam the bell daily for the same
// stuck task. Once the user reads (or completes the task → row becomes
// stale-but-readable) a future cron firing creates a fresh row only if
// the task is STILL overdue AND there's no existing unread one.
//
// Returns the persisted row id, or null when an insert was skipped due
// to dedupe — callers usually don't care which.

import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  notifications,
  type NewNotification,
  type Notification,
} from "../../db/schema/notifications.js";
import { events } from "../../lib/events.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "notifications" });

export type NotificationKind = NewNotification["kind"];

export type RecordNotificationInput = {
  userId: string;
  kind: NotificationKind;
  customerId?: string | null;
  refType?: string | null;
  refId?: string | null;
  // Free-form payload the bell renderer can use to format a row. By
  // convention we put a `title` string and any kind-specific fields
  // (e.g., taskTitle, byUserName, dueDate). Keep small — a few hundred
  // bytes — since this is read on every bell open.
  payload?: Record<string, unknown>;
  // When true and refId is set: skip the insert if there's already an
  // unread notification with the same (userId, kind, refType, refId).
  // Default false (every call inserts). Used by daily crons.
  dedupeOnRefId?: boolean;
};

export async function recordNotification(
  input: RecordNotificationInput,
): Promise<string | null> {
  const {
    userId,
    kind,
    customerId = null,
    refType = null,
    refId = null,
    payload,
    dedupeOnRefId = false,
  } = input;

  if (dedupeOnRefId && refId) {
    const existing = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.kind, kind),
          refType
            ? eq(notifications.refType, refType)
            : isNull(notifications.refType),
          eq(notifications.refId, refId),
          isNull(notifications.readAt),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      log.debug(
        { userId, kind, refType, refId },
        "notification dedupe — unread row exists",
      );
      return null;
    }
  }

  const id = nanoid(24);
  await db.insert(notifications).values({
    id,
    userId,
    kind,
    customerId,
    refType,
    refId,
    payload: payload ?? null,
    deliveredInApp: true,
  });

  events.emit("notification.created", {
    notificationId: id,
    userId,
    kind,
  });

  log.info(
    { id, userId, kind, refType, refId, customerId },
    "notification recorded",
  );
  return id;
}

export type { Notification };
