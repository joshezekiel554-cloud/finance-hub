// The ladder runs on the Settings days (order_hold_warn_days /
// order_hold_cancel_days) and its emails say those days, not "3 days" /
// Day 7 / Day 10.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  settings: {} as Record<string, string>,
  sends: [] as Array<{ subject: string; text: string; financeSendType: string }>,
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
      update: () => ({ set: () => ({ where: () => Promise.resolve([{ affectedRows: 1 }, []]) }) }),
    },
  };
});
vi.mock("../statements/settings.js", () => ({
  loadAppSettings: vi.fn(async () => ({
    order_hold_warehouse_recipients: "wh@x.example",
    order_hold_team_recipients: "",
    ...h.settings,
  })),
}));
vi.mock("./hold-alerts.js", () => ({ recordHoldTransition: vi.fn(async () => undefined) }));
vi.mock("./recipients.js", () => ({
  loadInternalHoldRecipients: () => "wh@x.example",
  resolveHoldCustomerRecipients: vi.fn(async () => ({ to: "buyer@x.example", cc: "", bcc: "" })),
}));
vi.mock("../../integrations/gmail/send.js", () => ({
  sendEmail: vi.fn(async (a: { subject: string; text: string; financeSendType: string }) => {
    h.sends.push(a);
    return { threadId: "t", messageId: "m" };
  }),
}));

import { runHoldLadder } from "./hold-ladder.js";
import { ORDER_EMAIL_DEFAULTS, ladderDayVars, ladderTemplatesWithLiteralDays, renderOrderTemplate } from "./templates.js";

const DAY = 86_400_000;
function held(daysAgo: number, over: Record<string, unknown> = {}) {
  return {
    id: "o1",
    orderNumber: "#100",
    shopifyOrderId: "100",
    total: "50",
    holdReason: "customer_rule",
    holdStartedAt: new Date(Date.now() - daysAgo * DAY - 3600_000),
    holdNoticeAt: new Date(Date.now() - daysAgo * DAY),
    holdWarnedAt: null,
    holdCancelNotifiedAt: null,
    holdLadderPausedUntil: null,
    customerId: "c1",
    customerName: "Buyer Co",
    customerPromisedPayBy: null,
    ...over,
  };
}

beforeEach(() => {
  h.rows = [];
  h.settings = {};
  h.sends.length = 0;
});

describe("ladder days from Settings", () => {
  it("warn day 5 / cancel day 12: the warning goes on day 5 and says 7 days", async () => {
    h.settings = { order_hold_warn_days: "5", order_hold_cancel_days: "12" };
    h.rows = [held(5)];
    const r = await runHoldLadder();
    expect(r.warnings).toBe(1);
    expect(h.sends[0]?.text).toContain("within the next 7 days");
    expect(h.sends[0]?.text).not.toContain("3 days");
  });

  it("defaults: nothing on day 5 (warning is day 7)", async () => {
    h.rows = [held(5)];
    expect((await runHoldLadder()).warnings).toBe(0);
  });

  it("cancel notice on the configured day, naming it", async () => {
    h.settings = { order_hold_warn_days: "5", order_hold_cancel_days: "12" };
    h.rows = [held(12, { holdWarnedAt: new Date() })];
    const r = await runHoldLadder();
    expect(r.cancelNotices).toBe(1);
    expect(h.sends[0]?.financeSendType).toBe("hold-cancel");
    expect(h.sends[0]?.text).toContain("the cancel point is day 12");
  });
});

describe("ladder template placeholders", () => {
  it("defaults render the configured days", () => {
    const vars = ladderDayVars({ warnDays: 4, cancelDays: 9 });
    expect(vars).toEqual({ warn_day: "4", cancel_day: "9", days_until_cancel: "5" });
    expect(renderOrderTemplate(ORDER_EMAIL_DEFAULTS.hold_warning, vars).text).toContain("within the next 5 days");
    expect(renderOrderTemplate(ORDER_EMAIL_DEFAULTS.hold_cancel, { ...vars, age_days: "9" }).text).toContain("day 9");
    for (const k of ["hold_notice", "hold_warning", "hold_cancel"] as const) {
      const t = ORDER_EMAIL_DEFAULTS[k];
      expect(`${t.subject}\n${t.body}`).not.toMatch(/\b3\s+days\b|\bday[\s-]*(7|10)\b/i);
    }
  });

  it("flags stored overrides that still have literal days (never the defaults)", () => {
    expect(ladderTemplatesWithLiteralDays({})).toEqual([]);
    expect(
      ladderTemplatesWithLiteralDays({
        order_tpl_hold_warning_body: "Resolve within the next 3 days or we cancel.",
        order_tpl_hold_cancel_subject: "Day-10: cancel {{order_number}}",
        order_tpl_hold_notice_body: "Your order is on hold.",
      }),
    ).toEqual(["hold_warning", "hold_cancel"]);
  });
});
