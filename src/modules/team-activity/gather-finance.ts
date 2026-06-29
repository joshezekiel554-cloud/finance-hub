// Finance-side activity gatherer for the Team Activity report.
//
// Pulls every finance-app event attributable to one user over [fromIso, toIso)
// and normalizes them into the shared `ActivityEvent` shape, plus the summary
// counts and the raw distinct active-minute set. The merge with inbox happens a
// layer up (report.ts); this module is purely the finance source.
//
// Attribution rules (per spec):
//   - email_sent   : email_log direction='outbound' AND userId=?
//   - call         : phone_communications whose extensionNumber maps to the user
//                    via the phone_extension_user_map app-setting; kind in
//                    (call_in, call_out) only (SMS excluded for v1).
//   - finance action: audit_log userId=? for the action set that matters.
//   - send         : statement_sends / invoices by sentByUserId, deduped against
//                    audit rows by entity id so a send isn't counted twice.
//   - active marker: first + last minuteUtc per day → synthetic rows.

import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { emailLog } from "../../db/schema/crm.js";
import { statementSends } from "../../db/schema/crm.js";
import { auditLog } from "../../db/schema/audit.js";
import { phoneCommunications } from "../../db/schema/vocatech.js";
import { invoiceChases, invoices } from "../../db/schema/invoices.js";
import { customers } from "../../db/schema/customers.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { userActiveMinutes } from "../../db/schema/user-active-minutes.js";
import {
  auditActionTitle,
  auditEventType,
  extensionsForUser,
  formatTalkTime,
  londonDayKeyForMinute,
  parseExtensionUserMap,
} from "./helpers.js";
import type {
  ActivityEvent,
  FinanceActivity,
  FinanceCounts,
} from "./types.js";

// Finance audit actions surfaced on the timeline as discrete "Finance actions".
// Anything outside this set (routine customer edits, bulk ops, settings tweaks)
// is intentionally omitted to keep the stream signal-dense.
const RELEVANT_AUDIT_ACTIONS = [
  "order.hold_started",
  "order.hold_released",
  "order.hold_cancelled",
  "order.review_dismissed",
  "statement.send",
  "issue_credit_memo",
  "rma.completed",
] as const;

function unix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * Gather all finance-side activity for one user across [fromIso, toIso).
 * `from` is inclusive, `to` is exclusive.
 */
export async function gatherFinanceActivity(
  userId: string,
  fromIso: string,
  toIso: string,
): Promise<FinanceActivity> {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const fromMinute = Math.floor(unix(fromIso) / 60);
  const toMinute = Math.floor(unix(toIso) / 60);

  // Pull the extension map once for call attribution.
  const extRows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "phone_extension_user_map"))
    .limit(1);
  const extMap = parseExtensionUserMap(extRows[0]?.value);
  const userExtensions = extensionsForUser(extMap, userId);

  const [emailRows, callRows, auditRows, minuteRows] = await Promise.all([
    // --- outbound emails ----------------------------------------------------
    db
      .select({
        id: emailLog.id,
        emailDate: emailLog.emailDate,
        subject: emailLog.subject,
        threadId: emailLog.threadId,
        customerId: emailLog.customerId,
        customerName: customers.displayName,
      })
      .from(emailLog)
      .leftJoin(customers, eq(emailLog.customerId, customers.id))
      .where(
        and(
          eq(emailLog.userId, userId),
          eq(emailLog.direction, "outbound"),
          gte(emailLog.emailDate, from),
          lt(emailLog.emailDate, to),
        ),
      ),

    // --- calls (only if the user owns at least one extension) ---------------
    userExtensions.length > 0
      ? db
          .select({
            id: phoneCommunications.id,
            kind: phoneCommunications.kind,
            direction: phoneCommunications.direction,
            startedAt: phoneCommunications.startedAt,
            durationSeconds: phoneCommunications.durationSeconds,
            remoteNumber: phoneCommunications.remoteNumber,
            extensionNumber: phoneCommunications.extensionNumber,
            transcription: phoneCommunications.transcription,
            recordingMediaId: phoneCommunications.recordingMediaId,
            customerId: phoneCommunications.customerId,
            customerName: customers.displayName,
          })
          .from(phoneCommunications)
          .leftJoin(customers, eq(phoneCommunications.customerId, customers.id))
          .where(
            and(
              inArray(phoneCommunications.extensionNumber, userExtensions),
              inArray(phoneCommunications.kind, ["call_in", "call_out"]),
              gte(phoneCommunications.startedAt, from),
              lt(phoneCommunications.startedAt, to),
            ),
          )
      : Promise.resolve([]),

    // --- finance audit actions ---------------------------------------------
    db
      .select({
        id: auditLog.id,
        occurredAt: auditLog.occurredAt,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        before: auditLog.before,
        after: auditLog.after,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, userId),
          inArray(auditLog.action, [...RELEVANT_AUDIT_ACTIONS]),
          gte(auditLog.occurredAt, from),
          lt(auditLog.occurredAt, to),
        ),
      ),

    // --- active minutes -----------------------------------------------------
    db
      .select({ minuteUtc: userActiveMinutes.minuteUtc })
      .from(userActiveMinutes)
      .where(
        and(
          eq(userActiveMinutes.userId, userId),
          gte(userActiveMinutes.minuteUtc, fromMinute),
          lt(userActiveMinutes.minuteUtc, toMinute),
        ),
      ),
  ]);

  const events: ActivityEvent[] = [];
  const counts: FinanceCounts = {
    emailsSent: 0,
    calls: 0,
    totalTalkSeconds: 0,
    holds: 0,
    statements: 0,
    invoices: 0,
  };

  // --- emails ---------------------------------------------------------------
  for (const r of emailRows) {
    counts.emailsSent += 1;
    const who = r.customerName ?? "customer";
    const subj = r.subject ?? "(no subject)";
    events.push({
      id: `email-${r.id}`,
      at: r.emailDate.toISOString(),
      source: "finance",
      type: "email_sent",
      title: `Emailed ${who} — "${subj}"`,
      detail: r.threadId ? `outbound · thread ${r.threadId}` : "outbound",
      customerId: r.customerId,
      customerName: r.customerName,
      link: r.customerId ? { kind: "customer", id: r.customerId } : null,
    });
  }

  // --- calls ----------------------------------------------------------------
  for (const r of callRows) {
    counts.calls += 1;
    counts.totalTalkSeconds += r.durationSeconds ?? 0;
    const outbound = r.kind === "call_out";
    const who = r.customerName ?? r.remoteNumber;
    const dur = formatTalkTime(r.durationSeconds);
    const hasTranscript = Boolean(r.transcription || r.recordingMediaId);
    const detailParts = [`ext ${r.extensionNumber ?? "?"}`, r.remoteNumber];
    if (hasTranscript) detailParts.push("transcript");
    events.push({
      id: `call-${r.id}`,
      at: r.startedAt.toISOString(),
      source: "finance",
      type: "call",
      title: `${outbound ? "Outbound" : "Inbound"} call · ${who} · ${dur}`,
      detail: detailParts.join(" · "),
      customerId: r.customerId,
      customerName: r.customerName,
      link: r.customerId ? { kind: "customer", id: r.customerId } : null,
    });
  }

  // --- audit actions --------------------------------------------------------
  // Track which statement/invoice entity ids are already represented here so the
  // direct statement_sends / invoices fold-in below doesn't double-count.
  const auditedStatementEntityIds = new Set<string>();
  for (const r of auditRows) {
    if (r.action === "statement.send") {
      auditedStatementEntityIds.add(r.entityId);
      counts.statements += 1;
    }
    if (r.action === "order.hold_started") counts.holds += 1;

    const type = auditEventType(r.action);
    events.push({
      id: `audit-${r.id}`,
      at: r.occurredAt.toISOString(),
      source: "finance",
      type,
      title: auditActionTitle(r.action),
      detail: auditDetail(r.action, r.entityType, r.entityId),
      customerId: r.entityType === "customer" ? r.entityId : null,
      customerName: null,
      link: { kind: r.entityType, id: r.entityId },
    });
  }

  // --- statement sends not already in audit (dedupe by entity id) -----------
  const stmtRows = await db
    .select({
      id: statementSends.id,
      sentAt: statementSends.sentAt,
      statementNumber: statementSends.statementNumber,
      statementType: statementSends.statementType,
      customerId: statementSends.customerId,
      customerName: customers.displayName,
    })
    .from(statementSends)
    .leftJoin(customers, eq(statementSends.customerId, customers.id))
    .where(
      and(
        eq(statementSends.sentByUserId, userId),
        gte(statementSends.sentAt, from),
        lt(statementSends.sentAt, to),
      ),
    );
  for (const r of stmtRows) {
    if (auditedStatementEntityIds.has(r.id)) continue;
    counts.statements += 1;
    events.push({
      id: `stmt-${r.id}`,
      at: r.sentAt.toISOString(),
      source: "finance",
      type: "send",
      title: `Sent statement to ${r.customerName ?? "customer"}`,
      detail: [
        r.statementType === "balance_forward" ? "balance-forward" : "open-items",
        r.statementNumber ? `statement #${r.statementNumber}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      customerId: r.customerId,
      customerName: r.customerName,
      link: r.customerId ? { kind: "customer", id: r.customerId } : null,
    });
  }

  // --- invoice sends (dunning chases) --------------------------------------
  // The original QBO invoice send isn't user-attributed; the user-attributed
  // signal is `invoice_chases` (operator-driven dunning sends carry
  // sentByUserId). Each chase = an "invoice send" the user performed.
  const invoiceChaseRows = await db
    .select({
      id: invoiceChases.id,
      level: invoiceChases.level,
      sentAt: invoiceChases.sentAt,
      docNumber: invoices.docNumber,
      customerId: invoices.customerId,
      customerName: customers.displayName,
    })
    .from(invoiceChases)
    .leftJoin(invoices, eq(invoiceChases.invoiceId, invoices.id))
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoiceChases.sentByUserId, userId),
        gte(invoiceChases.sentAt, from),
        lt(invoiceChases.sentAt, to),
      ),
    );
  for (const r of invoiceChaseRows) {
    counts.invoices += 1;
    events.push({
      id: `invoice-chase-${r.id}`,
      at: r.sentAt.toISOString(),
      source: "finance",
      type: "send",
      title: `Chased invoice ${r.docNumber ? `#${r.docNumber} ` : ""}· ${
        r.customerName ?? "customer"
      }`,
      detail: `level ${r.level} dunning`,
      customerId: r.customerId,
      customerName: r.customerName,
      link: r.customerId ? { kind: "customer", id: r.customerId } : null,
    });
  }

  // --- active markers (first + last minute per day) -------------------------
  const activeMinuteStampsUtc = [...new Set(minuteRows.map((r) => r.minuteUtc))].sort(
    (a, b) => a - b,
  );
  events.push(...buildActiveMarkers(activeMinuteStampsUtc));

  return { events, counts, activeMinuteStampsUtc };
}

/** Best-effort detail line for a finance audit row. */
function auditDetail(action: string, entityType: string, entityId: string): string {
  if (action.startsWith("order.")) return `order ${entityId}`;
  if (action === "rma.completed") return `RMA ${entityId}`;
  if (action === "issue_credit_memo") return `credit memo ${entityId}`;
  return `${entityType} ${entityId}`;
}

/**
 * Synthetic "Started working" / "Last activity" markers — the first and last
 * active minute of each Europe/London calendar day. A single-minute day yields
 * one marker (start only).
 */
export function buildActiveMarkers(sortedMinutes: number[]): ActivityEvent[] {
  if (sortedMinutes.length === 0) return [];
  const byDay = new Map<string, { first: number; last: number }>();
  for (const m of sortedMinutes) {
    const key = londonDayKeyForMinute(m);
    const cur = byDay.get(key);
    if (!cur) {
      byDay.set(key, { first: m, last: m });
    } else {
      cur.last = m; // sortedMinutes ascending → last write is the max
    }
  }

  const out: ActivityEvent[] = [];
  for (const { first, last } of byDay.values()) {
    out.push({
      id: `active-start-${first}`,
      at: new Date(first * 60_000).toISOString(),
      source: "finance",
      type: "active_marker",
      title: "Started working — first activity of the day",
      detail: "finance hub · first seen",
      link: null,
    });
    if (last !== first) {
      out.push({
        id: `active-end-${last}`,
        at: new Date(last * 60_000).toISOString(),
        source: "finance",
        type: "active_marker",
        title: "Last activity",
        detail: "finance hub · last seen",
        link: null,
      });
    }
  }
  return out;
}
