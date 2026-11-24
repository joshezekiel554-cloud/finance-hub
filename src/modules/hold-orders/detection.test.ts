// Rules apply ONLY to customers with an explicit rule: the detection job
// loads rules first and evaluates/holds only those customers' orders.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rules: new Map<string, Record<string, unknown>>(),
  invoiceCalls: [] as string[][],
  orderCalls: [] as string[][],
  updates: [] as Array<Record<string, unknown>>,
  transitions: [] as Array<Record<string, unknown>>,
  sends: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../lib/env.js", () => ({ env: { SHADOW_MODE: false, PUBLIC_URL: "https://finance.example" } }));
vi.mock("../../db/index.js", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (v: unknown) => void) => resolve([{ id: "c-rule", name: "Rule Co" }]),
  };
  return {
    db: {
      select: () => chain,
      update: () => ({
        set: (s: Record<string, unknown>) => {
          h.updates.push(s);
          return { where: () => Promise.resolve() };
        },
      }),
    },
  };
});
vi.mock("../statements/settings.js", () => ({
  loadAppSettings: vi.fn(async () => ({ order_hold_warehouse_recipients: "wh@x.example", order_hold_team_recipients: "" })),
}));
vi.mock("../orders/hold-alerts.js", () => ({
  recordHoldTransition: vi.fn(async (a: Record<string, unknown>) => {
    h.transitions.push(a);
  }),
}));
vi.mock("../../integrations/gmail/send.js", () => ({
  sendEmail: vi.fn(async (a: Record<string, unknown>) => {
    h.sends.push(a);
    return { threadId: "t", messageId: "m" };
  }),
}));
vi.mock("./rules-store.js", () => ({
  loadRulesFor: vi.fn(async () => h.rules),
  loadOpenInvoices: vi.fn(async (ids: string[]) => {
    h.invoiceCalls.push(ids);
    return new Map([
      ["c-rule", [{ docNumber: "19310", issueDate: "2026-07-01", dueDate: null, balance: "900", status: "overdue", origin: "feldart" }]],
    ]);
  }),
  loadCandidateOrders: vi.fn(async (ids: string[]) => {
    h.orderCalls.push(ids);
    const o = { orderNumber: "#1", shopifyOrderId: "1", total: "10", cancelledAt: null, fulfillmentStatus: null, shipmentStatus: null, orderDate: null };
    return new Map([
      ["c-rule", [{ ...o, orderId: "o-new", customerId: "c-rule", holdState: "none" }, { ...o, orderId: "o-rel", customerId: "c-rule", holdState: "released" }]],
    ]);
  }),
}));

import { runCustomerRuleHolds } from "./detection.js";

const now = new Date("2026-11-24T12:00:00Z");
const vip = { preset: "vip_90_110", termsDays: 90, holdWhenInvoiceDaysOver: 110, minBalance: 50, autoStartLadder: true, autoReleaseOnPayment: true, notifyWarehouse: false, note: null };

beforeEach(() => {
  h.rules = new Map();
  h.invoiceCalls.length = 0;
  h.orderCalls.length = 0;
  h.updates.length = 0;
  h.transitions.length = 0;
  h.sends.length = 0;
});

describe("runCustomerRuleHolds", () => {
  it("no explicit rules → touches nothing (defaults are never auto-applied)", async () => {
    const r = await runCustomerRuleHolds(now);
    expect(r).toEqual({ ruleCustomers: 0, held: 0, alerted: 0 });
    expect(h.invoiceCalls).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("'never' rules are not evaluated", async () => {
    h.rules = new Map([["c-never", { ...vip, preset: "never" }]]);
    await runCustomerRuleHolds(now);
    expect(h.invoiceCalls).toEqual([]);
  });

  it("evaluates only rule customers; holds their never-held open orders with reason customer_rule", async () => {
    h.rules = new Map([["c-rule", vip]]);
    const r = await runCustomerRuleHolds(now);
    expect(h.invoiceCalls).toEqual([["c-rule"]]);
    expect(h.orderCalls).toEqual([["c-rule"]]);
    expect(r.held).toBe(1);
    expect(h.updates[0]).toMatchObject({ holdState: "on_hold", holdReason: "customer_rule", holdLadderEnabled: true });
    expect(String(h.updates[0]?.holdNote)).toMatch(/^Rule: VIP 90\/110 — invoice 19310 at \d+ days$/);
    // notify_warehouse=false → nobody emailed
    expect(h.sends).toEqual([]);
    expect(h.transitions[0]).toMatchObject({ orderId: "o-new", after: { mode: "record_only", via: "customer_rule" } });
  });

  it("notify_warehouse=true → standard warehouse alert", async () => {
    h.rules = new Map([["c-rule", { ...vip, notifyWarehouse: true }]]);
    const r = await runCustomerRuleHolds(now);
    expect(r.alerted).toBe(1);
    expect(h.sends[0]).toMatchObject({ to: "wh@x.example", financeSendType: "hold-alert" });
  });
});
