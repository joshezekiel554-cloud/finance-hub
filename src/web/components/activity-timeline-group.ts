// Pure helpers for the customer activity timeline — kept React-free so they
// can be unit-tested in isolation. The component (activity-timeline.tsx)
// imports these to render day-grouped events on a vertical timeline.

// Groups items into day buckets keyed by their LOCAL calendar date
// (YYYY-MM-DD). Buckets are returned newest-day-first, and items within each
// bucket newest-first — matching the timeline's reverse-chronological order.
export function groupActivitiesByDay<T extends { occurredAt: string }>(
  items: T[],
): { dayKey: string; items: T[] }[] {
  const sorted = [...items].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const it of sorted) {
    const d = new Date(it.occurredAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
      order.push(key);
    }
    bucket.push(it);
  }
  return order.map((dayKey) => ({ dayKey, items: map.get(dayKey)! }));
}

// Human day header. `now` is injectable for deterministic tests. Day boundaries
// are local-timezone (consistent with groupActivitiesByDay).
export function formatDayLabel(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const that = new Date(d);
  that.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: that.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}
