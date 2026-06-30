// Dashboard "Time clock" card. Rendered only when GET /api/time-clock/status
// returns enabled=true (Hillel-only via the allow-list). Shows clock state, a
// live running timer while clocked in, today + week totals, an In/Out button
// (optimistic), and a stale warning when an open session crosses midnight / 16h.
//
// Finance design tokens only — no ad-hoc hex.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, LogIn, LogOut, AlertTriangle } from "lucide-react";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";

type ClockStatus = {
  enabled: boolean;
  open: { clockInAt: string } | null;
  stale: boolean;
  todayMinutes: number;
  weekMinutes: number;
};

const STATUS_KEY = ["time-clock", "status"];

function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// h:mm:ss elapsed since an ISO instant, for the live running timer.
function formatElapsed(sinceIso: string, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - new Date(sinceIso).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const londonTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function TimeClockCard() {
  const qc = useQueryClient();

  const { data, isPending } = useQuery<ClockStatus>({
    queryKey: STATUS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/time-clock/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Tick once a second so the running timer updates while clocked in.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isOpen = Boolean(data?.open);
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isOpen]);

  const mutation = useMutation({
    mutationFn: async (action: "in" | "out") => {
      const res = await fetch(`/api/time-clock/${action}`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as ClockStatus;
    },
    // Optimistic toggle of the open state so the button flips instantly.
    onMutate: async (action) => {
      await qc.cancelQueries({ queryKey: STATUS_KEY });
      const prev = qc.getQueryData<ClockStatus>(STATUS_KEY);
      if (prev) {
        qc.setQueryData<ClockStatus>(STATUS_KEY, {
          ...prev,
          open: action === "in" ? { clockInAt: new Date().toISOString() } : null,
          stale: action === "in" ? false : prev.stale,
        });
      }
      return { prev };
    },
    onError: (_err, _action, ctx) => {
      if (ctx?.prev) qc.setQueryData(STATUS_KEY, ctx.prev);
    },
    onSuccess: (status) => {
      qc.setQueryData(STATUS_KEY, status);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });

  // Hidden entirely for non-allow-list users (or before the status loads).
  if (!data?.enabled) return null;

  const clockedIn = Boolean(data.open);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Clock className="size-4 text-muted" />
          Time clock
        </div>
      </CardHeader>
      <CardBody>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            {clockedIn ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="inline-block size-2 rounded-full bg-accent-success" />
                  <span className="text-sm font-medium text-primary">
                    Clocked in since {londonTimeFmt.format(new Date(data.open!.clockInAt))}
                  </span>
                </div>
                <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight">
                  {formatElapsed(data.open!.clockInAt, nowMs)}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="inline-block size-2 rounded-full bg-muted" />
                  <span className="text-sm font-medium text-secondary">Clocked out</span>
                </div>
                <div className="mt-1 text-sm text-muted">Not currently on the clock.</div>
              </>
            )}
          </div>

          <Button
            variant={clockedIn ? "secondary" : "primary"}
            onClick={() => mutation.mutate(clockedIn ? "out" : "in")}
            disabled={mutation.isPending || isPending}
          >
            {clockedIn ? (
              <>
                <LogOut className="size-4" /> Clock out
              </>
            ) : (
              <>
                <LogIn className="size-4" /> Clock in
              </>
            )}
          </Button>
        </div>

        {data.stale && clockedIn && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-xs text-secondary">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-accent-warning" />
            <span>
              Still clocked in from an earlier day — did you forget to clock out?
              Clock out to close it.
            </span>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Totals label="Today" minutes={data.todayMinutes} />
          <Totals label="This week" minutes={data.weekMinutes} />
        </div>
      </CardBody>
    </Card>
  );
}

function Totals({ label, minutes }: { label: string; minutes: number }) {
  return (
    <div className={cn("rounded-md border border-default bg-base px-3 py-2")}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-bold tabular-nums tracking-tight">
        {formatMinutes(minutes)}
      </div>
    </div>
  );
}
