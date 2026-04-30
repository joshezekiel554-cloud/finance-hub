// Statements log. Backs /statements — a cross-customer audit trail of
// every Statement.pdf that's gone out, joined to customer + sender.
//
// Read-only. Re-rendering the same PDF is intentionally NOT offered:
// statement_sends doesn't snapshot the rendered bytes, so a "View PDF"
// button would re-render against current invoice state and lie about
// what the customer actually received. The Gmail thread is the source
// of truth for what was sent.
//
// Filters (all server-side):
//   - Date range chips: 7d / 30d / 90d / All
//   - Sender dropdown — populated from /senders endpoint
// Sorted by sentAt DESC (canonical for an audit log; not user-tunable).
// Pagination via Load more — stays out of the way for the common
// case of "the last few weeks of sends fit on one page."

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText, Filter } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";

type StatementSendRow = {
  id: string;
  sentAt: string;
  statementNumber: number | null;
  statementType: "open_items" | "balance_forward";
  sentToEmail: string | null;
  customerId: string;
  customerName: string | null;
  sentByUserId: string | null;
  sentByName: string | null;
  sentByEmail: string | null;
};

type ListResponse = {
  rows: StatementSendRow[];
  total: number;
  limit: number;
  offset: number;
};

type Sender = {
  id: string;
  name: string | null;
  email: string;
};

type SendersResponse = {
  senders: Sender[];
};

type RangeChip = "7d" | "30d" | "90d" | "all";

const RANGE_LABELS: Record<RangeChip, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

const PAGE_SIZE = 100;

export default function StatementsPage() {
  const [range, setRange] = useState<RangeChip>("30d");
  const [senderId, setSenderId] = useState<string>("all");
  const [offset, setOffset] = useState<number>(0);

  const fromDate = useMemo(() => {
    if (range === "all") return undefined;
    if (range === "7d") return isoDaysAgo(7);
    if (range === "30d") return isoDaysAgo(30);
    return isoDaysAgo(90);
  }, [range]);

  const queryKey = [
    "statement-sends",
    "list",
    { fromDate, senderId, offset },
  ] as const;

  const { data, isPending, isError } = useQuery<ListResponse>({
    queryKey,
    staleTime: 60_000,
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (fromDate) params.set("fromDate", fromDate);
      if (senderId !== "all") params.set("sentByUserId", senderId);
      const res = await fetch(`/api/statement-sends?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const { data: sendersData } = useQuery<SendersResponse>({
    queryKey: ["statement-sends", "senders"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch("/api/statement-sends/senders");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const senders = sendersData?.senders ?? [];

  function setRangeAndReset(next: RangeChip) {
    setRange(next);
    setOffset(0);
  }

  function setSenderAndReset(next: string) {
    setSenderId(next);
    setOffset(0);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Statements log</h1>
          <p className="text-sm text-muted">
            Every statement PDF that's been emailed to a customer. Read-only audit.
          </p>
        </div>
        {data ? (
          <div className="text-sm text-muted">
            {total.toLocaleString()} total
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Filter className="size-4 text-muted" />
            <span className="text-sm font-medium">Filters</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Date range:</span>
            {(Object.keys(RANGE_LABELS) as RangeChip[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setRangeAndReset(k)}
                className={cn(
                  "rounded-md border border-default px-2.5 py-1 text-xs",
                  range === k
                    ? "bg-elevated text-primary font-medium"
                    : "text-secondary hover:bg-elevated",
                )}
              >
                {RANGE_LABELS[k]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Sender:</span>
            <select
              className="rounded-md border border-default bg-base px-2 py-1 text-xs text-primary"
              value={senderId}
              onChange={(e) => setSenderAndReset(e.target.value)}
            >
              <option value="all">All senders</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.email}
                </option>
              ))}
            </select>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {isPending ? (
            <div className="p-6 text-sm text-muted">Loading…</div>
          ) : isError ? (
            <div className="p-6 text-sm text-red-600">
              Couldn't load the statements log.
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-sm text-muted">
              <FileText className="size-6 opacity-50" />
              <div>No statements sent in this window.</div>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-default text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Sent</th>
                  <th className="px-4 py-2 text-left font-medium">Statement #</th>
                  <th className="px-4 py-2 text-left font-medium">Customer</th>
                  <th className="px-4 py-2 text-left font-medium">Sent to</th>
                  <th className="px-4 py-2 text-left font-medium">By</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-default last:border-0 hover:bg-elevated/50"
                  >
                    <td className="px-4 py-2 text-secondary">
                      {formatDateTime(r.sentAt)}
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {r.statementNumber !== null ? `#${r.statementNumber}` : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: r.customerId }}
                        className="text-accent-primary hover:underline"
                      >
                        {r.customerName ?? r.customerId}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {r.sentToEmail ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {r.sentByName ?? r.sentByEmail ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone="neutral" className="text-[10px]">
                        {r.statementType === "open_items"
                          ? "Open items"
                          : "Balance forward"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {rows.length > 0 && offset + rows.length < total ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Load more ({total - offset - rows.length} remaining)
          </Button>
        </div>
      ) : null}
    </div>
  );
}
