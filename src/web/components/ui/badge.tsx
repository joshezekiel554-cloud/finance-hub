import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Tone = "critical" | "high" | "medium" | "low" | "neutral" | "info" | "success";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

const toneClass: Record<Tone, string> = {
  critical: "bg-accent-danger/15 text-accent-danger ring-accent-danger/30",
  high: "bg-accent-warning/15 text-accent-warning ring-accent-warning/30",
  medium: "bg-accent-info/15 text-accent-info ring-accent-info/30",
  low: "bg-accent-success/15 text-accent-success ring-accent-success/30",
  neutral: "bg-elevated text-secondary ring-default",
  info: "bg-accent-info/15 text-accent-info ring-accent-info/30",
  success: "bg-accent-success/15 text-accent-success ring-accent-success/30",
};

export function Badge({ className, tone = "neutral", ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        toneClass[tone],
        className,
      )}
      {...rest}
    />
  );
}
