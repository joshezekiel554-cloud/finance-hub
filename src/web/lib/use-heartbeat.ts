import { useEffect, useRef } from "react";

// App-wide active-time heartbeat. Pings POST /api/heartbeat every 60s ONLY
// while the tab is visible AND the user has produced input (mousemove / keydown
// / scroll) within the last 60s. This keeps "active time" honest — an open-but-
// idle tab, or a backgrounded one, records nothing.
//
// Cheap by design: the server upserts floor(now/60000) with INSERT IGNORE, so a
// duplicate ping inside the same minute is a no-op. We still gate client-side to
// avoid pointless requests.

const INTERVAL_MS = 60_000;
const ACTIVITY_WINDOW_MS = 60_000;

export function useHeartbeat(): void {
  const lastActivityRef = useRef<number>(Date.now());

  useEffect(() => {
    const markActive = () => {
      lastActivityRef.current = Date.now();
    };

    // Passive listeners — we only read the timestamp, never preventDefault.
    window.addEventListener("mousemove", markActive, { passive: true });
    window.addEventListener("keydown", markActive, { passive: true });
    window.addEventListener("scroll", markActive, { passive: true });
    window.addEventListener("pointerdown", markActive, { passive: true });

    function maybePing() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActivityRef.current > ACTIVITY_WINDOW_MS) return;
      // Fire-and-forget; failures are non-fatal (the next tick retries).
      void fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
    }

    // Ping once on mount (the user just navigated → they're active), then on
    // every interval tick.
    maybePing();
    const timer = window.setInterval(maybePing, INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("mousemove", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("scroll", markActive);
      window.removeEventListener("pointerdown", markActive);
    };
  }, []);
}
