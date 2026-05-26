import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { emailLog } from "../../db/schema/crm.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "crm.auto-action-emails" });

type Args = {
  customerId: string | null | undefined;
  threadId: string | null | undefined;
  sentAt: Date;
};

// Stamps actionedAt on every prior inbound email_log row in the same thread
// for the same customer when we send an outbound reply. Mirrors a manual
// "Mark as actioned" click but with actionedByUserId NULL so operators can
// tell apart system vs human actions. New customer replies arrive as fresh
// rows and naturally show as unactioned.
export async function autoActionPriorInbounds(
  args: Args,
): Promise<number> {
  const { customerId, threadId, sentAt } = args;
  if (!customerId || !threadId) return 0;

  try {
    const result = await db
      .update(emailLog)
      .set({ actionedAt: sentAt, actionedByUserId: null })
      .where(
        and(
          eq(emailLog.customerId, customerId),
          eq(emailLog.threadId, threadId),
          eq(emailLog.direction, "inbound"),
          isNull(emailLog.actionedAt),
          lt(emailLog.emailDate, sentAt),
        ),
      );
    const affected =
      Array.isArray(result) && result[0] && typeof (result[0] as { affectedRows?: number }).affectedRows === "number"
        ? (result[0] as { affectedRows: number }).affectedRows
        : 0;
    if (affected > 0) {
      log.info(
        { customerId, threadId, sentAt, affected },
        "auto-actioned prior inbounds after outbound reply",
      );
    }
    return affected;
  } catch (err) {
    log.error(
      { err, customerId, threadId },
      "autoActionPriorInbounds failed",
    );
    return 0;
  }
}
