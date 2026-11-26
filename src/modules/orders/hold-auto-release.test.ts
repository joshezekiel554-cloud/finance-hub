// releaseResolvedHolds: claim-then-act + the H8 switch (Settings
// holds_auto_release_emails_warehouse, default ON: auto-release emails the
// warehouse "good to send" only when it was alerted about that hold).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  claimable: 1,
  sends: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  resolves: [] as Array<Record<string, unknown>>,
  // Stored H8 value ("" = never set → default).
  h8: "" as string,
}));

vi.mock("../../lib/env.js", () => ({ env: { SHADOW_MODE: false, PUBLIC_URL: "https://finance.example" } }));
vi.mock("../../db/index.js", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(h.rows),
  };
  return {
    db: {
      select: () => chain,
      update: () => ({
        set: () => {
          const n = h.claimable > 0 ? 1 : 0;
          if (n) h.claimable -= 1;
          return { where: () => Promise.resolve([{ affectedRows: n }, []]) };
        },
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.audits.push(v);
          return Promise.resolve();
        },
      }),
    },
  };
});
vi.mock("../statements/settings.js", () => ({
  loadAppSettings: vi.fn(async () => ({
    order_overdue_threshold_gbp: "1000",
    order_hold_warehouse_recipients: "wh@x.example",
    order_hold_team_recipients: "",
    holds_auto_release_emails_warehouse: h.h8,
  })),
}));
vi.mock("../hold-orders/rules-store.js", () => ({
  loadEffectiveRules: vi.fn(async () => new Map()),
  loadOpenInvoices: vi.fn(async () => new Map()),
  loadCustomerTerms: vi.fn(async () => new Map()),
}));
vi.mock("../hold-orders/inbox-resolve.js", () => ({
  onHoldReleased: vi.fn((a: Record<string, unknown>) => {
    h.resolves.push(a);
  }),
}));
vi.mock("../../integrations/gmail/send.js", () => ({
  sendEmail: vi.fn(async (a: Record<string, unknown>) => {
    h.sends.push(a);
    return { threadId: "t", messageId: "m" };
  }),
}));

import { releaseResolvedHolds } from "./hold-alerts.js";

function paidRow(over: Record<string, unknown> = {}) {
  // Overdue hold whose balance is now cleared in QBO → resolves.
  return {
    id: "o1",
    orderNumber: "#18926",
    shopifyOrderId: "1",
    customerId: "c1",
    holdReason: "overdue_non_communicating",
    financialStatus: "pending",
    holdAlertThreadId: "alert-thread",
    holdAlertMessageId: "<a@x>",
    holdStatus: "active",
    overdueBalance: "0",
    customerName: "Meoros",
    ...over,
  };
}

beforeEach(() => {
  h.rows = [];
  h.claimable = 1;
  h.sends.length = 0;
  h.audits.length = 0;
  h.resolves.length = 0;
  h.h8 = "";
});

describe("releaseResolvedHolds", () => {
  it("H8 switched off in Settings: releases silently", async () => {
    h.h8 = "false";
    h.rows = [paidRow()];
    expect(await releaseResolvedHolds()).toEqual({ released: 1 });
    expect(h.sends).toEqual([]);
    expect(h.resolves).toHaveLength(1);
  });

  it("H8 never set → default ON (operator decision C): alerted warehouse gets good-to-send", async () => {
    h.rows = [paidRow()];
    await releaseResolvedHolds();
    expect(h.sends).toHaveLength(1);
  });

  it("H8 on + warehouse was alerted → one in-thread good-to-send", async () => {
    h.h8 = "true";
    h.rows = [paidRow()];
    await releaseResolvedHolds();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({ to: "wh@x.example", threadId: "alert-thread", financeSendType: "hold-release" });
  });

  it("H8 on but the warehouse was never alerted (record-only / no thread) → nobody emailed", async () => {
    h.h8 = "true";
    h.rows = [paidRow({ holdAlertThreadId: null, holdAlertMessageId: null })];
    await releaseResolvedHolds();
    expect(h.sends).toEqual([]);
  });

  it("someone released it between load and update → nothing (no email, audit, inbox call)", async () => {
    h.h8 = "true";
    h.rows = [paidRow()];
    h.claimable = 0;
    expect(await releaseResolvedHolds()).toEqual({ released: 0 });
    expect(h.sends).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.resolves).toEqual([]);
  });
});
