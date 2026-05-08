// Startup seeder for default tag_email_schedules rows.
//
// Called from worker.ts on every boot — fully idempotent. If a row already
// exists for the same (tag, recipientEmail, frequency) combination it is left
// untouched; only genuinely missing rows are inserted.
//
// Add new default schedules here as the feature grows. The pattern is:
//   { tag, recipientEmail, frequency, contentType }
// The seeder assigns a stable id via nanoid and skips insertion if a matching
// row exists.

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { tagEmailSchedules } from "../../db/schema/notifications.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "tag-email.seed" });

type DefaultSchedule = {
  tag: string;
  recipientEmail: string;
  frequency: "daily" | "weekly" | "monthly";
  contentType: "hold_or_upfront_summary";
};

const DEFAULTS: DefaultSchedule[] = [
  {
    tag: "yiddy",
    recipientEmail: "sales@feldart.com",
    frequency: "weekly",
    contentType: "hold_or_upfront_summary",
  },
];

export async function seedDefaultTagEmailSchedules(): Promise<void> {
  for (const def of DEFAULTS) {
    // Check for an existing row matching tag + recipient + frequency.
    const existing = await db
      .select({ id: tagEmailSchedules.id })
      .from(tagEmailSchedules)
      .where(
        and(
          eq(tagEmailSchedules.tag, def.tag),
          eq(tagEmailSchedules.recipientEmail, def.recipientEmail),
          eq(tagEmailSchedules.frequency, def.frequency),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      log.debug(
        { tag: def.tag, recipientEmail: def.recipientEmail, frequency: def.frequency },
        "tag-email seed: row already exists, skipping",
      );
      continue;
    }

    const id = nanoid(24);
    await db.insert(tagEmailSchedules).values({
      id,
      tag: def.tag,
      recipientEmail: def.recipientEmail,
      frequency: def.frequency,
      contentType: def.contentType,
      enabled: true,
    });

    log.info(
      { id, tag: def.tag, recipientEmail: def.recipientEmail, frequency: def.frequency },
      "tag-email seed: inserted default schedule",
    );
  }
}
