// Slim stacked aging bar for the TJ wind-down panel (origin-split-2 spec
// §1): exposure split by days overdue — ≤90d (info) / 90–180d (warning) /
// >180d (danger). Widths are proportional to the bucket sums; each segment
// carries a title tooltip with the exact figure, and a tiny legend repeats
// the numbers for non-hover (touch) use. Renders nothing when every bucket
// is zero (nothing past due — exposure may still exist in not-yet-due
// invoices, which sit in no bucket by design).

import { cn } from "../../lib/cn";

export type AgingBuckets = { b90: number; b180: number; bOver: number };

const SEGMENTS = [
  { key: "b90", label: "≤90d", color: "bg-accent-info" },
  { key: "b180", label: "90–180d", color: "bg-accent-warning" },
  { key: "bOver", label: ">180d", color: "bg-accent-danger" },
] as const;

export function AgingBar({ buckets }: { buckets: AgingBuckets }) {
  const total = buckets.b90 + buckets.b180 + buckets.bOver;
  if (total <= 0) return null;
  const segments = SEGMENTS.map((s) => ({
    ...s,
    value: buckets[s.key],
  })).filter((s) => s.value > 0);
  return (
    <div className="space-y-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-elevated">
        {segments.map((s) => (
          <div
            key={s.key}
            className={s.color}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label}: $${s.value.toFixed(2)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1 tabular-nums">
            <span className={cn("size-1.5 rounded-full", s.color)} aria-hidden />
            {s.label} ${s.value.toFixed(2)}
          </span>
        ))}
      </div>
    </div>
  );
}
