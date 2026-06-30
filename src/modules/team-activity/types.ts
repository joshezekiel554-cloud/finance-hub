// Shared shapes for the admin Team Activity report.
//
// Everything a teammate did over a date range is normalized into a single
// `ActivityEvent` stream (finance + inbox) plus a set of summary counts and an
// active-minute set. The route layer groups the stream by calendar day in
// Europe/London for rendering; the module here stays timezone-agnostic and
// works purely in ISO-UTC + epoch-minute ints.

/** The categories a timeline row can fall under (drives chip filters + dot color). */
export const ACTIVITY_EVENT_TYPES = [
  "email_sent", // outbound email (finance app send OR inbox reply)
  "call", // inbound/outbound phone call
  "task", // task created / completed / @mention (inbox-sourced or finance audit)
  "action", // finance state-change (hold, return, proposal decision, note edit)
  "send", // statement / invoice send (its own dot per the mockup)
  "active_marker", // synthetic "started working" / "last activity" rows
] as const;

export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/** A single normalized timeline event from either app. */
export type ActivityEvent = {
  id: string;
  at: string; // ISO UTC
  source: "finance" | "inbox";
  type: ActivityEventType | string;
  title: string;
  detail?: string | null;
  customerId?: string | null; // finance customer id
  customerName?: string | null;
  link?: { kind: string; id: string } | null;
  /** Seconds the event itself occupied — set for calls (count full talk-time as
   * active work). Instant events (emails, actions, tasks) omit it / 0. */
  durationSec?: number | null;
};

/** Summary counts for the stat tiles (finance side). */
export type FinanceCounts = {
  emailsSent: number;
  calls: number;
  totalTalkSeconds: number;
  holds: number;
  statements: number;
  invoices: number;
};

/** What `gatherFinanceActivity` returns: normalized events + counts + raw active minutes. */
export type FinanceActivity = {
  events: ActivityEvent[];
  counts: FinanceCounts;
  /** Distinct UTC epoch-minute ints (floor(unixSeconds/60)) the user was active in range. */
  activeMinuteStampsUtc: number[];
};

// --- Inbox contract (GET /api/svc/member-activity?memberId=&from=&to=) -------
// Built by the inbox team in parallel. Finance consumes exactly this shape;
// the merge degrades gracefully if the endpoint is unreachable.

/** A single inbox-side event as returned by the inbox service. */
export type InboxActivityEvent = {
  id: string;
  at: string; // ISO UTC
  type: string; // "email_sent" | "task" | … (inbox vocabulary; passed through)
  title: string;
  detail?: string | null;
  /** Inbox maps its contact → the linked finance customer id when one exists. */
  customerFinanceId?: string | null;
  customerName?: string | null;
  link?: { kind: string; id: string } | null;
};

/** Inbox counts surfaced into the finance tiles (tasks live only in inbox). */
export type InboxCounts = {
  emailsSent: number;
  tasksCompleted: number;
  tasksCreated: number;
};

/** Full response body of the inbox member-activity endpoint. */
export type InboxMemberActivity = {
  events: InboxActivityEvent[];
  counts: InboxCounts;
  /** Distinct UTC epoch-minute ints the member was active in inbox during range. */
  activeMinuteStampsUtc: number[];
};

// --- Merged report (what the /api/team-activity route returns) --------------

export type ActiveTimeSummary = {
  totalMinutes: number;
  financeMinutes: number;
  inboxMinutes: number;
  /** Per-calendar-day (Europe/London) active minute totals, keyed YYYY-MM-DD. */
  perDayMinutes: Record<string, number>;
  /** Days (YYYY-MM-DD London) whose active time is an ESTIMATE — they predate
   * the heartbeat go-live so only event timestamps exist (undercounts quiet
   * stretches). Exact days have ≥1 presence ping. */
  estimatedDays: string[];
};

export type ReportCounts = FinanceCounts & {
  inboxEmailsSent: number;
  tasksCompleted: number;
  tasksCreated: number;
};

export type TimelineDay = {
  /** YYYY-MM-DD in Europe/London. */
  day: string;
  /** Human label, e.g. "Mon 29 Jun". */
  label: string;
  activeMinutes: number;
  /** True when this day's active time is an estimate (pre-heartbeat day). */
  estimated: boolean;
  events: ActivityEvent[];
};

export type TeamActivityReport = {
  subject: { userId: string; name: string | null; email: string | null; inboxMemberId: string | null };
  range: { from: string; to: string };
  counts: ReportCounts;
  activeTime: ActiveTimeSummary;
  days: TimelineDay[];
  /** True when inbox data could not be fetched — UI shows a soft note. */
  inboxUnavailable: boolean;
};
