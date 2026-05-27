// Compact tap-target row for the Customers page on mobile. Name + total
// on top, status pills underneath (overdue tier, hold, autopilot off,
// B2B/B2C, unactioned email count). Tap → customer detail. In sweep
// mode, the row grows a checkbox on the left and tap toggles selection.

import { Link } from "@tanstack/react-router";
import { Mail, Pause } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

type Props = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  balance: number;
  overdueBalance: number;
  daysOverdue: number | null;
  holdStatus: "active" | "hold" | "payment_upfront";
  agentModeExcluded: boolean;
  customerType: "b2b" | "b2c" | null;
  unactionedEmailCount: number;
  // When true, the row renders a checkbox and tap toggles selection
  // rather than navigating.
  selectable: boolean;
  selected: boolean;
  onToggleSelect?: (id: string) => void;
};

function formatMoney(n: number): string {
  return `£${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function tierFromDaysOverdue(d: number | null): "critical" | "high" | "medium" | null {
  if (d == null) return null;
  if (d >= 60) return "critical";
  if (d >= 30) return "high";
  if (d > 0) return "medium";
  return null;
}

export function CustomerRowMobile(props: Props) {
  const {
    id,
    displayName,
    balance,
    overdueBalance,
    daysOverdue,
    holdStatus,
    agentModeExcluded,
    customerType,
    unactionedEmailCount,
    selectable,
    selected,
    onToggleSelect,
  } = props;

  const tier = tierFromDaysOverdue(daysOverdue);

  const content = (
    <div
      className={cn(
        "flex gap-3 rounded-md border bg-subtle p-3 transition-colors",
        selectable ? "cursor-pointer" : "hover:border-strong hover:bg-elevated",
        selected ? "border-accent-primary bg-accent-primary/5" : "border-default",
      )}
    >
      {selectable ? (
        <span
          className={cn(
            "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded border",
            selected
              ? "border-accent-primary bg-accent-primary text-base"
              : "border-default bg-base",
          )}
          aria-hidden
        >
          {selected ? "✓" : ""}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold text-primary">
            {displayName}
          </span>
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {formatMoney(balance)}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {tier === "critical" && (
            <Badge tone="critical">
              {overdueBalance > 0 ? `${formatMoney(overdueBalance)} · ` : ""}
              {daysOverdue}d
            </Badge>
          )}
          {tier === "high" && (
            <Badge tone="high">
              {overdueBalance > 0 ? `${formatMoney(overdueBalance)} · ` : ""}
              {daysOverdue}d
            </Badge>
          )}
          {tier === "medium" && (
            <Badge tone="medium">
              {overdueBalance > 0 ? `${formatMoney(overdueBalance)} · ` : ""}
              {daysOverdue}d
            </Badge>
          )}
          {holdStatus === "hold" && (
            <Badge tone="high">
              <Pause className="-ml-0.5 mr-0.5 size-3" />
              Hold
            </Badge>
          )}
          {holdStatus === "payment_upfront" && (
            <Badge tone="medium">Pay upfront</Badge>
          )}
          {customerType === "b2b" && <Badge tone="neutral">B2B</Badge>}
          {customerType === "b2c" && <Badge tone="neutral">B2C</Badge>}
          {!customerType && <Badge tone="neutral">Uncategorized</Badge>}
          {agentModeExcluded && <Badge tone="neutral">🤖 off</Badge>}
          {unactionedEmailCount > 0 && (
            <Badge tone="medium">
              <Mail className="-ml-0.5 mr-0.5 size-3" />
              {unactionedEmailCount}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );

  if (selectable) {
    return (
      <button
        type="button"
        className="w-full text-left"
        onClick={() => onToggleSelect?.(id)}
      >
        {content}
      </button>
    );
  }
  return (
    <Link
      to="/customers/$customerId"
      params={{ customerId: id }}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40 rounded-md"
    >
      {content}
    </Link>
  );
}
