// Top-level Team Activity report assembly: finance gather + inbox merge.
//
// Fetches the inbox member-activity endpoint, maps its events into the shared
// `ActivityEvent` shape (source:"inbox"), unions the active-minute sets
// (deduping minutes the user was active in both apps), merges + sorts the
// timeline, and groups by Europe/London calendar day. Degrades gracefully when
// inbox is unreachable: finance-only data + `inboxUnavailable: true`.

import { createLogger } from "../../lib/logger.js";
import { inboxFetch } from "../../integrations/inbox/client.js";
import { resolveMemberByEmail } from "../../integrations/inbox/members.js";
import { getClockedActivity } from "../time-clock/service.js";
import { gatherFinanceActivity } from "./gather-finance.js";
import {
  activeMinutesPerDay,
  eventsToSignals,
  groupEventsByDay,
  londonDayKeyForMinute,
  minutesToSignals,
  sessionizedMinutes,
} from "./helpers.js";
import type {
  ActivityEvent,
  InboxMemberActivity,
  ReportCounts,
  TeamActivityReport,
} from "./types.js";

const log = createLogger({ component: "team-activity.report" });

export type ReportSubject = {
  userId: string;
  name: string | null;
  email: string | null;
};

/** Map an inbox-side event onto the shared ActivityEvent shape. */
export function mapInboxEvent(ev: InboxMemberActivity["events"][number]): ActivityEvent {
  return {
    id: `inbox-${ev.id}`,
    at: ev.at,
    source: "inbox",
    type: ev.type,
    title: ev.title,
    detail: ev.detail ?? null,
    customerId: ev.customerFinanceId ?? null,
    customerName: ev.customerName ?? null,
    link: ev.link ?? null,
  };
}

/**
 * Fetch the inbox member-activity payload for a resolved inbox member. Returns
 * null (and logs) on any failure so the caller can degrade to finance-only.
 */
async function fetchInboxActivity(
  inboxMemberId: string,
  fromIso: string,
  toIso: string,
): Promise<InboxMemberActivity | null> {
  const qs = new URLSearchParams({
    memberId: inboxMemberId,
    from: fromIso,
    to: toIso,
  });
  try {
    return await inboxFetch<InboxMemberActivity>(`/api/svc/member-activity?${qs.toString()}`);
  } catch (err) {
    log.warn({ err, inboxMemberId }, "inbox member-activity fetch failed; degrading");
    return null;
  }
}

/**
 * Build the full merged Team Activity report for one finance user over
 * [fromIso, toIso). `from` inclusive, `to` exclusive.
 */
export async function buildTeamActivityReport(
  subject: ReportSubject,
  fromIso: string,
  toIso: string,
): Promise<TeamActivityReport> {
  // Resolve the inbox member by email (matches email + googleEmail). A user
  // with no inbox counterpart simply gets finance-only data.
  let inboxMemberId: string | null = null;
  try {
    const member = subject.email
      ? await resolveMemberByEmail(subject.email)
      : null;
    inboxMemberId = member?.teamMemberId ?? null;
  } catch (err) {
    log.warn({ err, userId: subject.userId }, "inbox member resolve failed");
  }

  const finance = await gatherFinanceActivity(subject.userId, fromIso, toIso);

  // Clocked timesheet (Time Clock). SEPARATE from active-time sessionization —
  // its events join the timeline but its minutes never feed the signal sets.
  const clocked = await getClockedActivity(subject.userId, fromIso, toIso);

  let inbox: InboxMemberActivity | null = null;
  let inboxUnavailable = false;
  if (inboxMemberId) {
    inbox = await fetchInboxActivity(inboxMemberId, fromIso, toIso);
    // Distinguish "no inbox identity" (not unavailable, just nothing to fetch)
    // from "had an identity but the fetch failed" (degraded).
    if (inbox === null) inboxUnavailable = true;
  }

  const inboxEvents = (inbox?.events ?? []).map(mapInboxEvent);
  // Clock rows render on the timeline as amber "action" dots; they do NOT enter
  // the active-time signal sets below.
  const allEvents = [...finance.events, ...inboxEvents, ...clocked.events];

  const inboxMinutes = inbox?.activeMinuteStampsUtc ?? [];

  // Active time = sessionized continuous work. Signals = presence pings (each a
  // 60s interval) + every timestamped event (calls occupy their full duration),
  // across both apps. Sessions bridge gaps ≤15 min and are floored at ~3 min so
  // a momentary one-off still counts. Per-app figures are each sessionized on
  // their own (they may overlap, so the combined total ≤ their sum).
  const financeSignals = [
    ...minutesToSignals(finance.activeMinuteStampsUtc),
    ...eventsToSignals(finance.events),
  ];
  const inboxSignals = [
    ...minutesToSignals(inboxMinutes),
    ...eventsToSignals(inboxEvents),
  ];
  const combinedMinutes = sessionizedMinutes([...financeSignals, ...inboxSignals]);
  const financeMinutes = sessionizedMinutes(financeSignals);
  const inboxActiveMinutes = sessionizedMinutes(inboxSignals);
  const perDayMinutes = activeMinutesPerDay(combinedMinutes);

  // A day is EXACT if it had any presence ping; days that only have event-
  // derived activity (i.e. before the heartbeat existed) are estimates.
  const heartbeatDays = new Set(
    [...finance.activeMinuteStampsUtc, ...inboxMinutes].map(londonDayKeyForMinute),
  );
  const estimatedDays = Object.keys(perDayMinutes).filter(
    (d) => !heartbeatDays.has(d),
  );

  const days = groupEventsByDay(allEvents, perDayMinutes, new Set(estimatedDays));

  const counts: ReportCounts = {
    ...finance.counts,
    inboxEmailsSent: inbox?.counts.emailsSent ?? 0,
    tasksCompleted: inbox?.counts.tasksCompleted ?? 0,
    tasksCreated: inbox?.counts.tasksCreated ?? 0,
  };

  return {
    subject: {
      userId: subject.userId,
      name: subject.name,
      email: subject.email,
      inboxMemberId,
    },
    range: { from: fromIso, to: toIso },
    counts,
    activeTime: {
      totalMinutes: combinedMinutes.length,
      financeMinutes: financeMinutes.length,
      inboxMinutes: inboxActiveMinutes.length,
      perDayMinutes,
      estimatedDays,
    },
    clocked: {
      clockedMinutes: clocked.clockedMinutes,
      perDayMinutes: clocked.perDayMinutes,
      openStale: clocked.openSessionStale,
    },
    days,
    inboxUnavailable,
  };
}
