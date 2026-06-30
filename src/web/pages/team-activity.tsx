import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Download,
  Mail,
  Phone,
  CheckSquare,
  Ban,
  FileText,
  MessageSquare,
  StickyNote,
  RotateCcw,
  Lock,
} from "lucide-react";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { cn } from "../lib/cn";

// --- Types mirroring the /api/team-activity response ------------------------

type ActivityEvent = {
  id: string;
  at: string;
  source: "finance" | "inbox";
  type: string;
  title: string;
  detail?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  link?: { kind: string; id: string } | null;
};

type TimelineDay = {
  day: string;
  label: string;
  activeMinutes: number;
  estimated: boolean;
  events: ActivityEvent[];
};

type ReportCounts = {
  emailsSent: number;
  calls: number;
  totalTalkSeconds: number;
  holds: number;
  statements: number;
  invoices: number;
  inboxEmailsSent: number;
  tasksCompleted: number;
  tasksCreated: number;
};

type TeamActivityReport = {
  subject: { userId: string; name: string | null; email: string | null; inboxMemberId: string | null };
  range: { from: string; to: string };
  counts: ReportCounts;
  activeTime: {
    totalMinutes: number;
    financeMinutes: number;
    inboxMinutes: number;
    perDayMinutes: Record<string, number>;
    estimatedDays: string[];
  };
  days: TimelineDay[];
  inboxUnavailable: boolean;
};

type Member = {
  userId: string;
  name: string | null;
  email: string | null;
  inboxMemberId: string | null;
};

// --- Date-range presets -----------------------------------------------------

type RangeKey = "today" | "this_week" | "last_7" | "this_month" | "custom";

const RANGE_LABELS: Record<RangeKey, string> = {
  today: "Today",
  this_week: "This week",
  last_7: "Last 7 days",
  this_month: "This month",
  custom: "Custom",
};

// Compute [from, to) as ISO strings. Boundaries are local-clock based (the
// operator thinks in their own day); the server groups in Europe/London which
// is the same as UK local. `to` is exclusive (end of the last day).
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function computeRange(key: RangeKey, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrowStart = addDays(todayStart, 1);
  switch (key) {
    case "today":
      return { from: todayStart.toISOString(), to: tomorrowStart.toISOString() };
    case "this_week": {
      // Monday-start week.
      const dow = (todayStart.getDay() + 6) % 7; // 0 = Monday
      const monday = addDays(todayStart, -dow);
      return { from: monday.toISOString(), to: tomorrowStart.toISOString() };
    }
    case "last_7":
      return { from: addDays(todayStart, -6).toISOString(), to: tomorrowStart.toISOString() };
    case "this_month": {
      const first = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
      return { from: first.toISOString(), to: tomorrowStart.toISOString() };
    }
    case "custom": {
      const from = customFrom ? startOfDay(new Date(customFrom)) : todayStart;
      const toBase = customTo ? startOfDay(new Date(customTo)) : todayStart;
      return { from: from.toISOString(), to: addDays(toBase, 1).toISOString() };
    }
  }
}

// --- Per-type dot/icon styling (design tokens only) -------------------------
// The timeline merges BOTH finance event types (email_sent, call, send, action,
// active_marker) AND inbox event types (email_reply, thread_status,
// thread_comment, thread_mention, task_created/completed/status/assigned/comment,
// note, return_created). Both streams are normalized into one of six visual
// buckets so the dot colors stay the approved mockup's palette:
//   accent-info=email · accent-success=call · 290-hue=task ·
//   accent-primary=send · accent-warning=action · muted=active marker.
// The 290-hue (task) has no token, so it's an oklch value matching the mockup —
// NOT an ad-hoc hex.

const TASK_HUE = "oklch(62% 0.17 290)";

type Bucket = "email" | "call" | "task" | "send" | "action" | "active";

/** Normalize any finance- or inbox-side event type into a visual/filter bucket. */
function bucketFor(type: string): Bucket {
  if (type === "email_sent" || type === "email_reply") return "email";
  if (type === "call") return "call";
  if (type.startsWith("task")) return "task";
  if (type === "send") return "send";
  if (type === "active_marker") return "active";
  // thread_status / thread_comment / thread_mention / note / return_created /
  // finance audit "action" all fall here.
  return "action";
}

type DotStyle = { className: string; style?: React.CSSProperties; icon: React.ReactNode };

function dotStyleFor(ev: ActivityEvent): DotStyle {
  const iconCls = "size-3.5 text-white";
  // Icon is chosen by the SPECIFIC type (so comments, notes and returns read
  // right even though they share the "action" bucket color).
  const icon = ((): React.ReactNode => {
    const t = ev.type;
    if (t === "email_sent" || t === "email_reply") return <Mail className={iconCls} />;
    if (t === "call") return <Phone className={iconCls} />;
    if (t.startsWith("task")) return <CheckSquare className={iconCls} />;
    if (t === "send") return <FileText className={iconCls} />;
    if (t === "thread_comment" || t === "thread_mention")
      return <MessageSquare className={iconCls} />;
    if (t === "note") return <StickyNote className={iconCls} />;
    if (t === "return_created") return <RotateCcw className={iconCls} />;
    if (t === "active_marker") return <span className="size-2 rounded-full bg-white" />;
    return <Ban className={iconCls} />; // finance holds/cancel + thread_status
  })();

  switch (bucketFor(ev.type)) {
    case "email":
      return { className: "bg-accent-info", icon };
    case "call":
      return { className: "bg-accent-success", icon };
    case "task":
      return { className: "", style: { backgroundColor: TASK_HUE }, icon };
    case "send":
      return { className: "bg-accent-primary", icon };
    case "action":
      return { className: "bg-accent-warning", icon };
    case "active":
    default:
      return { className: "bg-muted", icon };
  }
}

// Which chip a given event belongs under.
type ChipKey = "all" | "emails" | "calls" | "tasks" | "actions";

function chipMatches(chip: ChipKey, ev: ActivityEvent): boolean {
  if (chip === "all") return true;
  // Active markers always show (they're context, not a filterable category).
  if (ev.type === "active_marker") return true;
  const b = bucketFor(ev.type);
  switch (chip) {
    case "emails":
      return b === "email";
    case "calls":
      return b === "call";
    case "tasks":
      return b === "task";
    case "actions":
      return b === "action" || b === "send";
  }
}

function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function formatTalk(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m talk-time`;
}

// --- Time-of-day formatting (Europe/London) ---------------------------------
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// Europe/London YYYY-MM-DD for "is this day header today?" — drives the
// "Today · …" prefix on the current day (matches the mockup).
const londonDayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function isLondonToday(dayKey: string): boolean {
  return dayKey === londonDayKeyFmt.format(new Date());
}

export default function TeamActivityPage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("this_week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [chip, setChip] = useState<ChipKey>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const membersQuery = useQuery<Member[]>({
    queryKey: ["team-activity", "members"],
    queryFn: async () => {
      const res = await fetch("/api/team-activity/members");
      if (!res.ok) throw new Error(`members: ${res.status}`);
      const data = (await res.json()) as { members: Member[] };
      return data.members;
    },
    staleTime: 5 * 60_000,
  });

  const members = membersQuery.data ?? [];
  // Default subject = first member (the picker is admin-facing; everyone listed).
  const activeUserId = selectedUserId ?? members[0]?.userId ?? null;

  const range = useMemo(
    () => computeRange(rangeKey, customFrom, customTo),
    [rangeKey, customFrom, customTo],
  );

  const reportQuery = useQuery<TeamActivityReport>({
    queryKey: ["team-activity", "report", activeUserId, range.from, range.to],
    enabled: Boolean(activeUserId),
    queryFn: async () => {
      const qs = new URLSearchParams({ userId: activeUserId!, from: range.from, to: range.to });
      const res = await fetch(`/api/team-activity?${qs.toString()}`);
      if (!res.ok) throw new Error(`report: ${res.status}`);
      return (await res.json()) as TeamActivityReport;
    },
  });

  const report = reportQuery.data;
  const subjectName =
    report?.subject.name ??
    members.find((m) => m.userId === activeUserId)?.name ??
    members.find((m) => m.userId === activeUserId)?.email ??
    "teammate";

  function exportCsv() {
    if (!activeUserId) return;
    const qs = new URLSearchParams({ userId: activeUserId, from: range.from, to: range.to });
    window.location.href = `/api/team-activity/export.csv?${qs.toString()}`;
  }

  return (
    <div className="mx-auto max-w-[1180px]">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Team Activity</h1>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-default bg-elevated px-2.5 py-1 text-xs font-semibold text-muted">
          <Lock className="size-3" />
          Admins only · Josh &amp; Shaya
        </span>
      </div>
      <p className="mb-5 text-sm text-muted">
        Everything a teammate has done — emails, calls, tasks, finance actions and active time —
        across finance &amp; inbox.
      </p>

      {/* Controls */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="w-60">
          <Select
            aria-label="Teammate"
            value={activeUserId ?? ""}
            onChange={(e) => setSelectedUserId(e.target.value)}
            disabled={membersQuery.isLoading}
          >
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name ?? m.email ?? m.userId}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex rounded-md border border-default bg-base p-0.5">
          {(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setRangeKey(k)}
              className={cn(
                "rounded px-3 py-1.5 text-sm font-medium transition-colors",
                rangeKey === k
                  ? "bg-accent-primary text-white"
                  : "text-secondary hover:text-primary",
              )}
            >
              {RANGE_LABELS[k]}
            </button>
          ))}
        </div>

        {rangeKey === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-9 rounded-md border border-default bg-base px-2 text-sm"
              aria-label="From date"
            />
            <span className="text-muted">→</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-9 rounded-md border border-default bg-base px-2 text-sm"
              aria-label="To date"
            />
          </div>
        )}

        <div className="flex-1" />
        <Button variant="secondary" onClick={exportCsv} disabled={!report}>
          <Download className="size-4" />
          Export CSV
        </Button>
      </div>

      {report?.inboxUnavailable && (
        <div className="mb-4 rounded-md border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-sm text-secondary">
          Inbox data is currently unavailable — showing finance activity only.
        </div>
      )}

      {/* Stat tiles */}
      <StatTiles report={report} loading={reportQuery.isLoading} />

      {/* Filter chips */}
      <div className="mb-3.5 flex flex-wrap gap-2">
        {(["all", "emails", "calls", "tasks", "actions"] as ChipKey[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChip(c)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold capitalize transition-colors",
              chip === c
                ? "border-primary bg-primary text-base"
                : "border-strong bg-base text-secondary hover:text-primary",
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <Timeline report={report} loading={reportQuery.isLoading} chip={chip} subjectName={subjectName} />
    </div>
  );
}

// --- Stat tiles -------------------------------------------------------------

function StatTiles({ report, loading }: { report?: TeamActivityReport; loading: boolean }) {
  if (loading || !report) {
    return (
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-lg border border-default bg-subtle" />
        ))}
      </div>
    );
  }

  const c = report.counts;
  const at = report.activeTime;
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
      <Tile
        hero
        dotClass="bg-accent-primary"
        label="Active time"
        value={formatMinutes(at.totalMinutes)}
        meta={
          `${formatMinutes(at.financeMinutes)} finance · ${formatMinutes(at.inboxMinutes)} inbox` +
          (at.estimatedDays.length > 0 ? " · incl. est. days" : "")
        }
      />
      <Tile
        dotClass="bg-accent-info"
        label="Emails sent"
        value={String(c.emailsSent + c.inboxEmailsSent)}
        meta={`${c.inboxEmailsSent} replies · ${c.emailsSent} finance sends`}
      />
      <Tile
        dotClass="bg-accent-success"
        label="Calls"
        value={String(c.calls)}
        meta={formatTalk(c.totalTalkSeconds)}
      />
      <Tile
        dotStyle={{ backgroundColor: TASK_HUE }}
        label="Tasks done"
        value={String(c.tasksCompleted)}
        meta={`${c.tasksCreated} created`}
      />
      <Tile
        dotClass="bg-accent-warning"
        label="Finance actions"
        value={String(c.holds + c.statements + c.invoices)}
        meta="holds · statements · invoices"
      />
    </div>
  );
}

function Tile({
  hero,
  dotClass,
  dotStyle,
  label,
  value,
  meta,
}: {
  hero?: boolean;
  dotClass?: string;
  dotStyle?: React.CSSProperties;
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <Card className={cn("p-4", hero && "ring-1 ring-accent-primary/30")}>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <span className={cn("size-2 rounded-full", dotClass)} style={dotStyle} />
        {label}
      </div>
      <div className={cn("mt-2 font-bold tracking-tight", hero ? "text-2xl" : "text-xl")}>{value}</div>
      <div className="mt-0.5 text-xs text-secondary">{meta}</div>
    </Card>
  );
}

// --- Timeline ---------------------------------------------------------------

function Timeline({
  report,
  loading,
  chip,
  subjectName,
}: {
  report?: TeamActivityReport;
  loading: boolean;
  chip: ChipKey;
  subjectName: string;
}) {
  if (loading || !report) {
    return (
      <Card className="overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-default px-4 py-3 last:border-0">
            <div className="h-3 w-12 animate-pulse rounded bg-subtle" />
            <div className="size-7 animate-pulse rounded-full bg-subtle" />
            <div className="h-3 flex-1 animate-pulse rounded bg-subtle" />
          </div>
        ))}
      </Card>
    );
  }

  // Apply the chip filter, then drop now-empty days.
  const days = report.days
    .map((d) => ({ ...d, events: d.events.filter((ev) => chipMatches(chip, ev)) }))
    .filter((d) => d.events.length > 0 || d.activeMinutes > 0);

  const totalEvents = days.reduce((n, d) => n + d.events.length, 0);
  if (totalEvents === 0) {
    return (
      <Card className="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center">
        <div className="text-sm font-medium text-secondary">No activity for {subjectName} in this range</div>
        <div className="text-xs text-muted">Try a wider date range or a different filter.</div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      {days.map((day) => (
        <div key={day.day}>
          <div className="sticky top-0 z-10 border-b border-default bg-subtle px-4 py-2 text-xs font-bold uppercase tracking-wide text-secondary">
            {isLondonToday(day.day) ? "Today · " : ""}
            {day.label} · {day.estimated ? "~" : ""}
            {formatMinutes(day.activeMinutes)} active
            {day.estimated && (
              <span className="ml-1.5 font-normal italic normal-case text-muted">
                (est.)
              </span>
            )}
          </div>
          {day.events.map((ev) => (
            <TimelineRow key={ev.id} ev={ev} />
          ))}
        </div>
      ))}
    </Card>
  );
}

function TimelineRow({ ev }: { ev: ActivityEvent }) {
  const dot = dotStyleFor(ev);
  return (
    <div className="flex items-start gap-3.5 border-b border-default px-4 py-2.5 last:border-0 hover:bg-subtle">
      <div className="w-12 shrink-0 pt-0.5 text-right text-xs font-semibold tabular-nums text-muted">
        {timeFmt.format(new Date(ev.at))}
      </div>
      <div
        className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", dot.className)}
        style={dot.style}
      >
        {dot.icon}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-sm">
          {ev.customerId ? (
            <RowTitleWithLink ev={ev} />
          ) : (
            ev.title
          )}
          {ev.source === "inbox" && (
            <span className="ml-1.5 rounded bg-elevated px-1.5 py-0.5 text-[11px] font-semibold text-muted">
              inbox
            </span>
          )}
        </div>
        {ev.detail && <div className="mt-0.5 text-xs text-muted">{ev.detail}</div>}
      </div>
    </div>
  );
}

// When the event is customer-linked, render the title with a click-through to
// the customer detail page. The customer name (if present) is the anchor.
function RowTitleWithLink({ ev }: { ev: ActivityEvent }) {
  if (!ev.customerId) return <>{ev.title}</>;
  return (
    <>
      <span>{ev.title}</span>{" "}
      <Link
        to="/customers/$customerId"
        params={{ customerId: ev.customerId }}
        className="font-semibold text-accent-primary hover:underline"
      >
        {ev.customerName ?? "view customer"}
      </Link>
    </>
  );
}
