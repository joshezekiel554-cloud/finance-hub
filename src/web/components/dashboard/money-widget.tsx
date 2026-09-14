// Dashboard "Money" section — per book (Feldart / Torah Judaica / total):
// overdue, current due, due in the next 7 days, received in the last 30
// days. One endpoint (/api/dashboard/money); the hub's Finance panel shows
// the same object, so the two never disagree.

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";

type BookMoney = {
  overdue: { amount: string; invoices: number; customers: number };
  currentDue: { amount: string; invoices: number };
  dueNext7: { amount: string; invoices: number };
  received30: { amount: string };
};

export type MoneySummary = {
  feldart: BookMoney;
  tj: BookMoney;
  total: BookMoney & { received30: { amount: string; payments: number; unallocated: string } };
  windowDays: number;
  syncedAt: { invoices: string | null; payments: string | null };
  generatedAt: string;
};

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const money = (s: string) => fmt.format(Number(s) || 0);
const timeOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "—";

export function MoneyWidget() {
  const { data, isPending, isError } = useQuery<MoneySummary>({
    queryKey: ["dashboard", "money"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/money");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const books: Array<{ key: "feldart" | "tj" | "total"; label: string; dot?: string }> = [
    { key: "feldart", label: "Feldart", dot: "bg-accent-primary" },
    { key: "tj", label: "Torah Judaica", dot: "bg-accent-warning" },
    { key: "total", label: "Total" },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-medium text-primary">Money</h2>
            <span className="text-xs text-muted">open invoices by book · received in the last {data?.windowDays ?? 30} days</span>
          </div>
          {data && (
            <span className="text-xs text-muted">
              QB synced {timeOf(data.syncedAt.invoices)} · payments {timeOf(data.syncedAt.payments)}
            </span>
          )}
        </div>
      </CardHeader>
      <CardBody className="p-0">
        {isPending ? (
          <div className="m-4 h-16 rounded bg-subtle animate-pulse" />
        ) : isError || !data ? (
          <div className="p-4 text-xs text-accent-danger">Failed to load money summary.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-default bg-subtle text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 text-left font-semibold">Book</th>
                  <th className="px-4 py-2 text-right font-semibold">Overdue</th>
                  <th className="px-4 py-2 text-right font-semibold">
                    Current due
                    <span className="block text-[10px] font-normal normal-case tracking-normal">not yet past due</span>
                  </th>
                  <th className="px-4 py-2 text-right font-semibold">Due in next 7 days</th>
                  <th className="px-4 py-2 text-right font-semibold">Received · 30 days</th>
                </tr>
              </thead>
              <tbody>
                {books.map((b) => {
                  const m = data[b.key];
                  const isTotal = b.key === "total";
                  return (
                    <tr
                      key={b.key}
                      className={isTotal ? "bg-subtle font-semibold" : "border-b border-default"}
                    >
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-2 font-medium text-primary">
                          {b.dot && <i className={`inline-block size-2 rounded-sm ${b.dot}`} />}
                          {b.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-accent-danger">
                        {money(m.overdue.amount)}
                        {!isTotal && (
                          <span className="block text-[11px] font-normal text-muted">
                            {m.overdue.invoices} invoices · {m.overdue.customers} customers
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-primary">
                        {money(m.currentDue.amount)}
                        {!isTotal && (
                          <span className="block text-[11px] font-normal text-muted">{m.currentDue.invoices} invoices</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-accent-warning">
                        {money(m.dueNext7.amount)}
                        {!isTotal && (
                          <span className="block text-[11px] font-normal text-muted">{m.dueNext7.invoices} invoices</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-accent-success">
                        {money(m.received30.amount)}
                        {isTotal && (
                          <span className="block text-[11px] font-normal text-muted">
                            {data.total.received30.payments} payments
                            {Number(data.total.received30.unallocated) > 0 && ` · ${money(data.total.received30.unallocated)} unapplied`}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-default px-4 py-2 text-[11px] text-muted">
              <span>Overdue = balance past due date · Current due = open balance not yet due · Received = QBO payments by transaction date, attributed to the invoices they paid</span>
              <Link to="/chase" className="ml-auto font-medium text-accent-primary hover:underline">Chase list →</Link>
              <Link to="/statements" className="font-medium text-accent-primary hover:underline">Statements →</Link>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
