import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  overdue: [] as unknown[],
  review: { neverEmailed: [] as unknown[], deliveryFailed: [] as unknown[], dismissed: [], syncedAt: null },
  rmas: new Map<string, unknown[]>(),
  dbRows: [] as unknown[][],
  failChase: false,
}));

vi.mock("../chase/lookups.js", () => ({
  getOverdueCustomers: async () => {
    if (m.failChase) throw new Error("db down");
    return m.overdue;
  },
}));
vi.mock("../invoice-email-review/load.js", () => ({ loadEmailReview: async () => m.review }));
vi.mock("./ops-tools.js", () => ({
  AWAITING_PARCEL_STATUSES: ["approved", "awaiting_warehouse_number", "sent_to_warehouse"],
  loadRmas: async (statuses: string[]) => m.rmas.get(statuses.join(",")) ?? [],
}));
vi.mock("../../db/index.js", () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const k of ["from", "where", "orderBy", "leftJoin", "innerJoin"]) c[k] = () => c;
    c.then = (res: (v: unknown) => unknown) => res(m.dbRows.shift() ?? []);
    return c;
  };
  return { db: { select: () => chain() } };
});

import { loadFinanceAlerts } from "./alerts.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const ctx = { now: NOW, baseUrl: "https://f" };

beforeEach(() => {
  m.overdue = [];
  m.review = { neverEmailed: [], deliveryFailed: [], dismissed: [], syncedAt: null };
  m.rmas = new Map();
  m.failChase = false;
  // db select order: qb-sync (MAX lastSyncedAt), receipts, held orders
  m.dbRows = [[{ last: new Date(NOW.getTime() - 10 * 60_000) }], [], []];
});

describe("finance alerts", () => {
  it("a quiet book returns no alerts", async () => {
    const r = await loadFinanceAlerts(ctx);
    expect(r).toEqual({ alerts: [], checkedAt: NOW.toISOString() });
  });

  it("returns stable ids, high first, with items and links", async () => {
    m.overdue = [
      { customerId: "c1", customer: { displayName: "Acme" }, severity: { tier: "CRITICAL", score: 900, totalOverdue: 5000, daysOverdue: 120 } },
      { customerId: "c2", customer: { displayName: "Beth" }, severity: { tier: "HIGH", score: 100, totalOverdue: 200, daysOverdue: 40 } },
    ];
    m.review.deliveryFailed = [{ docNumber: "10234", customerName: "Acme", customerId: "c1", deliveryError: "Bounced", emailStatus: "EmailSent" }];
    m.rmas.set("approved,awaiting_warehouse_number,sent_to_warehouse", [
      { id: "r1", rmaNumber: "DC1", customer: "Acme", trackingNumber: null, approvedAt: new Date("2026-10-20T00:00:00Z"), createdAt: new Date("2026-10-19T00:00:00Z"), totalValue: "120" },
      { id: "r2", rmaNumber: "DC2", customer: "Beth", trackingNumber: null, approvedAt: new Date("2026-11-03T00:00:00Z"), createdAt: new Date("2026-11-03T00:00:00Z"), totalValue: "50" },
    ]);
    const { alerts } = await loadFinanceAlerts(ctx);
    expect(alerts.map((a) => [a.id, a.severity, a.count])).toEqual([
      ["finance.chase-critical", "high", 1],
      ["finance.invoice-email-bounced", "high", 1],
      ["finance.rma-no-tracking", "medium", 1],
    ]);
    expect(alerts[0]!.items[0]).toEqual({ label: "Acme", detail: "$5,000.00 overdue, 120 days", link: "https://f/customers/c1" });
    expect(alerts[2]!.items[0]!.label).toBe("RMA DC1 — Acme");
  });

  it("a stale QuickBooks sync is a high alert", async () => {
    m.dbRows = [[{ last: new Date(NOW.getTime() - 5 * 3_600_000) }], [], []];
    const { alerts } = await loadFinanceAlerts(ctx);
    expect(alerts[0]).toMatchObject({ id: "finance.qb-sync-stale", severity: "high" });
  });

  it("one failing check degrades to an info alert, the rest still run", async () => {
    m.failChase = true;
    m.review.neverEmailed = [{ docNumber: "1", customerName: "X", customerId: "c9", deliveryError: null, emailStatus: "NeedToSend" }];
    const { alerts } = await loadFinanceAlerts(ctx);
    expect(alerts.map((a) => a.id)).toEqual(["finance.invoice-never-emailed", "finance.check-failed.chase"]);
  });
});
