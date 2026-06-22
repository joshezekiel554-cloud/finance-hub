// Card-assembly tests for getTaskCards(). Each underlying feed module is mocked
// so we exercise the SHAPE of the cards (id scheme, actions, column, meta)
// without a DB. The ai_proposal feed reads `db` directly, so we mock the db
// query chain too.

import { beforeEach, describe, expect, it, vi } from "vitest";

const listHoldableHoldOrders = vi.hoisted(() => vi.fn());
const listFlaggedOverdueOrders = vi.hoisted(() => vi.fn());
const getOverdueCustomers = vi.hoisted(() => vi.fn());
const findStalledRmas = vi.hoisted(() => vi.fn());
const proposalRows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock("../orders/hold-alerts.js", () => ({
  listHoldableHoldOrders,
}));
vi.mock("../orders/overdue-alerts.js", () => ({
  listFlaggedOverdueOrders,
}));
vi.mock("../chase/lookups.js", () => ({
  getOverdueCustomers,
}));
vi.mock("../ai-agent/candidates/ops-rma-stalled.js", () => ({
  findCandidates: findStalledRmas,
}));

// db.select()...limit() resolves to proposalRows.value. Chainable thenable.
vi.mock("../../db/index.js", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "leftJoin", "where", "orderBy"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(proposalRows.value));
  return { db: chain };
});

import { getTaskCards, TASK_CARD_COLUMN } from "./task-cards.js";

beforeEach(() => {
  vi.clearAllMocks();
  listHoldableHoldOrders.mockResolvedValue([]);
  listFlaggedOverdueOrders.mockResolvedValue([]);
  getOverdueCustomers.mockResolvedValue([]);
  findStalledRmas.mockResolvedValue([]);
  proposalRows.value = [];
});

describe("getTaskCards — hold", () => {
  it("maps an on_hold order to a hold card with Good-to-send/Cancel api + Chase link", async () => {
    listHoldableHoldOrders.mockResolvedValue([
      {
        orderId: "ord-1",
        orderNumber: "#18672",
        orderDate: "2026-06-10T00:00:00.000Z",
        orderTotal: "250.00",
        customerId: "cust-1",
        customerName: "Igal",
        reason: "payment_upfront_unpaid",
        heldDays: 4,
      },
    ]);
    const cards = await getTaskCards();
    const c = cards.find((x) => x.type === "hold");
    expect(c).toBeDefined();
    expect(c!.id).toBe("hold:ord-1");
    expect(c!.customerId).toBe("cust-1");
    expect(c!.column).toBe(TASK_CARD_COLUMN);
    expect(c!.meta.heldDays).toBe(4);
    const apis = c!.actions.filter((a) => a.kind === "api");
    expect(apis.map((a) => a.label).sort()).toEqual(["Cancel", "Good to send"]);
    expect(apis[0]).toMatchObject({ method: "POST" });
    expect(
      (apis.find((a) => a.label === "Good to send") as { endpoint: string })
        .endpoint,
    ).toBe("/api/ext/task-cards/hold/ord-1/good-to-send");
    const link = c!.actions.find((a) => a.kind === "link") as { url: string };
    expect(link.url).toBe("/customers/cust-1");
  });
});

describe("getTaskCards — overdue_review", () => {
  it("maps a flagged overdue order to Place-on-hold/Dismiss api actions", async () => {
    listFlaggedOverdueOrders.mockResolvedValue([
      {
        orderId: "ord-2",
        orderNumber: "#18700",
        orderDate: "2026-06-11T00:00:00.000Z",
        orderTotal: "999.00",
        customerId: "cust-2",
        customerName: "Brown & Co",
        overdueBalance: "4200.00",
        alerted: true,
      },
    ]);
    const cards = await getTaskCards();
    const c = cards.find((x) => x.type === "overdue_review")!;
    expect(c.id).toBe("overdue_review:ord-2");
    expect(c.meta.overdueBalance).toBe("4200.00");
    const labels = c.actions.map((a) => a.label).sort();
    expect(labels).toEqual(["Dismiss", "Place on hold"]);
    expect(c.actions.every((a) => a.kind === "api")).toBe(true);
    expect(
      (c.actions.find((a) => a.label === "Dismiss") as { endpoint: string })
        .endpoint,
    ).toBe("/api/ext/task-cards/overdue_review/ord-2/dismiss");
  });
});

describe("getTaskCards — ai_proposal", () => {
  it("maps a pending proposal to Approve/Reject api + carries context in meta", async () => {
    proposalRows.value = [
      {
        id: "prop-1",
        category: "chase_next",
        origin: "feldart",
        status: "drafted",
        entityType: "customer",
        entityId: "cust-3",
        candidateSummary: { subject: "Overdue reminder", tier: "HIGH" },
        draftedPreview: "{\"to\":\"x\"}",
        reasoning: "owed for 60 days",
        confidence: "0.80",
        customerName: "Acme Ltd",
      },
    ];
    const cards = await getTaskCards();
    const c = cards.find((x) => x.type === "ai_proposal")!;
    expect(c.id).toBe("ai_proposal:prop-1");
    expect(c.customerId).toBe("cust-3");
    expect(c.customerName).toBe("Acme Ltd");
    expect(c.meta.category).toBe("chase_next");
    expect(c.meta.subject).toBe("Overdue reminder");
    expect(c.meta.preview).toBe("{\"to\":\"x\"}");
    const labels = c.actions.map((a) => a.label).sort();
    expect(labels).toEqual(["Approve", "Reject"]);
    expect(
      (c.actions.find((a) => a.label === "Approve") as { endpoint: string })
        .endpoint,
    ).toBe("/api/ext/task-cards/ai_proposal/prop-1/approve");
  });
});

describe("getTaskCards — ai_proposal danger gate", () => {
  it("EXCLUDES a dangerous (paid_void) proposal from the board feed", async () => {
    proposalRows.value = [
      {
        id: "safe-1",
        category: "chase_next",
        origin: "feldart",
        status: "drafted",
        entityType: "customer",
        entityId: "cust-a",
        draftedAction: { tool: "send_chase_email", args: {} },
        candidateSummary: null,
        draftedPreview: null,
        reasoning: null,
        confidence: "0.5",
        customerName: "Safe Co",
      },
      {
        id: "danger-1",
        category: "chat_action",
        origin: "feldart",
        status: "drafted",
        entityType: "customer",
        entityId: "cust-b",
        // dispute_transition + paid_void is an irreversible QBO void — must NOT
        // get a one-click board Approve (no typed-confirmation channel here).
        draftedAction: { tool: "dispute_transition", args: { action: "paid_void" } },
        candidateSummary: null,
        draftedPreview: null,
        reasoning: null,
        confidence: "0.9",
        customerName: "Danger Co",
      },
    ];
    const cards = await getTaskCards();
    const proposalIds = cards
      .filter((c) => c.type === "ai_proposal")
      .map((c) => c.id);
    expect(proposalIds).toContain("ai_proposal:safe-1");
    expect(proposalIds).not.toContain("ai_proposal:danger-1");
  });
});

describe("getTaskCards — chase + rma are link-only", () => {
  it("chase cards carry only a deep-link action", async () => {
    getOverdueCustomers.mockResolvedValue([
      {
        customerId: "cust-4",
        customer: { displayName: "Delinquent Co" },
        invoices: [],
        severity: { score: 50, tier: "HIGH", daysOverdue: 40, totalOverdue: 1234.5, oldestUnpaidDate: null },
      },
    ]);
    const cards = await getTaskCards();
    const c = cards.find((x) => x.type === "chase")!;
    expect(c.id).toBe("chase:cust-4");
    expect(c.actions).toHaveLength(1);
    expect(c.actions[0]).toMatchObject({ kind: "link", url: "/customers/cust-4" });
    expect(c.meta.tier).toBe("HIGH");
  });

  it("rma cards carry only a deep-link action", async () => {
    findStalledRmas.mockResolvedValue([
      {
        entityType: "rma",
        entityId: "rma-9",
        summary: { rmaNumber: "RMA-9", customerName: "Returns R Us", status: "received", daysInState: 20 },
      },
    ]);
    const cards = await getTaskCards();
    const c = cards.find((x) => x.type === "rma")!;
    expect(c.id).toBe("rma:rma-9");
    expect(c.actions).toHaveLength(1);
    expect(c.actions[0]).toMatchObject({ kind: "link", url: "/rmas/rma-9" });
    expect(c.meta.daysInState).toBe(20);
  });
});

describe("getTaskCards — resilience", () => {
  it("a failing feed does not blank the rest of the board", async () => {
    listHoldableHoldOrders.mockRejectedValue(new Error("db down"));
    listFlaggedOverdueOrders.mockResolvedValue([
      {
        orderId: "ord-x",
        orderNumber: "#1",
        orderDate: null,
        orderTotal: "1.00",
        customerId: "c",
        customerName: "n",
        overdueBalance: "1.00",
        alerted: false,
      },
    ]);
    const cards = await getTaskCards();
    expect(cards.some((x) => x.type === "hold")).toBe(false);
    expect(cards.some((x) => x.type === "overdue_review")).toBe(true);
  });
});
