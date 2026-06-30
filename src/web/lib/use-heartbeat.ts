import { useEffect, useRef } from "react";

// App-wide active-time heartbeat. Records the current minute as "active" both:
//  (a) IMMEDIATELY on any interaction (click / keypress / scroll / pointer /
//      mouse-move) or tab-focus — so even a momentary visit (click into a
//      customer/chase page and leave, skim an email) registers without waiting
//      for a timer tick; and
//  (b) on a 60s tick while the tab is visible AND there was activity in the last
//      minute — so sustained presence keeps recording, but a backgrounded or
//      idle-and-untouched tab stops.
//
// Deduped per-minute client-side (one fetch per active minute at most); the
// server also upserts floor(now/60000) with INSERT IGNORE, so it's idempotent.
// These minute pings are the presence signal the report's session-based active
// time bridges between (a >15-min gap with no signal ends a work session).

const INTERVAL_MS = 60_000;
const ACTIVITY_WINDOW_MS = 60_000;

export function useHeartbeat(): void {
  const lastActivityRef = useRef<number>(Date.now());
  const lastPingedMinuteRef = useRef<number>(-1);

  useEffect(() => {
    function ping() {
      if (document.visibilityState !== "visible") return;
      const minute = Math.floor(Date.now() / 60_000);
      if (minute === lastPingedMinuteRef.current) return; // already recorded
      lastPingedMinuteRef.current = minute;
      void fetch("/api/heartbeat", { method: "POST" }).catch(() => {
        // Let the next signal/tick retry this minute.
        lastPingedMinuteRef.current = -1;
      });
    }

    const onActivity = () => {
      lastActivityRef.current = Date.now();
      ping(); // immediate — momentary interactions still count
    };

    // Passive listeners — we only read timestamps, never preventDefault.
    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("click", onActivity, { passive: true });
    // Opening / re-focusing the tab is presence too (mirrors the inbox side).
    document.addEventListener("visibilitychange", ping);

    function tick() {
      // Sustained presence only — stop if untouched for over a minute.
      if (Date.now() - lastActivityRef.current > ACTIVITY_WINDOW_MS) return;
      ping();
    }

    ping(); // on mount — the user just navigated here
    const timer = window.setInterval(tick, INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("scroll", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("click", onActivity);
      document.removeEventListener("visibilitychange", ping);
    };
  }, []);
}
