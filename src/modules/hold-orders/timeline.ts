// Per-order hold history for the drawer — audit_log rows (entity "order"),
// oldest first, with actor names and a plain-English line per event.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { users } from "../../db/schema/auth.js";

export type TimelineEntry = {
  at: string;
  action: string;
  actor: string;
  text: string;
  mode: string | null;
  emailed: Array<{ to: string; role: string; template: string; subject: string }>;
};

type Json = Record<string, unknown> | null;

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function emailedOf(after: Json): TimelineEntry["emailed"] {
  const e = after?.emailed;
  if (!Array.isArray(e)) return [];
  return e
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((x) => ({
      to: String(x.to ?? ""),
      role: String(x.role ?? ""),
      template: String(x.template ?? ""),
      subject: String(x.subject ?? ""),
    }));
}

/** Plain-English line for one audit row. Pure. */
export function describeHoldEvent(action: string, after: Json): string {
  const mode = str(after?.mode);
  const quiet = mode === "record_only" ? " (recorded only — nobody emailed)" : "";
  switch (action) {
    case "order.hold_started": {
      const why = str(after?.why) ?? str(after?.note);
      const reason = str(after?.holdReason) ?? "hold";
      return `Put on hold (${reason.replace(/_/g, " ")})${why ? ` — ${why}` : ""}${quiet}`;
    }
    case "order.hold_released": {
      const paid = after?.paidOutsideQbo as Record<string, unknown> | null | undefined;
      const paidLine = paid ? ` — paid outside QBO (${String(paid.method)}): ${String(paid.note ?? "")}` : "";
      const via = str(after?.via) === "good_to_send" ? " — good to send" : "";
      const note = str(after?.note);
      return `Released${via}${paidLine}${note ? ` — ${note}` : ""}${quiet}`;
    }
    case "order.hold_auto_released":
      return "Auto-released — the hold reason resolved (payment / balance cleared)";
    case "order.hold_ladder_paused": {
      const until = str(after?.holdLadderPausedUntil) ?? "";
      const note = str(after?.note);
      return `Customer emails paused until ${until.slice(0, 10)}${note ? ` — ${note}` : ""}`;
    }
    case "order.hold_ladder_resumed":
      return "Customer emails resumed";
    case "order.hold_note":
      return `Note: ${str(after?.note) ?? ""}`;
    case "order.hold_notice_sent":
      return "Day-0 hold notice emailed to the customer";
    case "order.hold_warning_sent":
      return "Day-7 final warning emailed to the customer";
    case "order.hold_cancel_notified":
      return "Day-10 cancel notice emailed to the warehouse";
    case "order.hold_cancelled":
      return "Order cancelled (Shopify + QBO)";
    case "order.review_dismissed":
      return "Overdue review dismissed";
    default:
      return action.replace(/^order\./, "").replace(/_/g, " ");
  }
}

export async function getHoldTimeline(orderId: string): Promise<TimelineEntry[]> {
  const rows = await db
    .select({
      at: auditLog.occurredAt,
      action: auditLog.action,
      after: auditLog.after,
      userName: users.name,
      userEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(and(eq(auditLog.entityType, "order"), eq(auditLog.entityId, orderId)))
    .orderBy(asc(auditLog.occurredAt))
    .limit(500);
  return rows.map((r) => {
    const after = (r.after ?? null) as Json;
    return {
      at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
      action: r.action,
      actor: r.userName ?? r.userEmail ?? str(after?.actorEmail) ?? "System",
      text: describeHoldEvent(r.action, after),
      mode: str(after?.mode),
      emailed: emailedOf(after),
    };
  });
}
