import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env.js", () => ({
  env: { INBOX_HOLD_RESOLVE_URL: "https://inbox.example/api/svc/holds/resolve", INBOX_SERVICE_TOKEN: "t".repeat(40) },
}));

import {
  decodeCursor,
  humanHoldReason,
  isChasing,
  ladderStage,
  matchesSearch,
  mismatchFor,
  normalizeOrderNumber,
} from "./board-classify.js";
import { describeHoldEvent } from "./timeline.js";
import { buildHoldResolveBody, postHoldResolve } from "./inbox-resolve.js";

const now = new Date("2026-11-24T12:00:00Z");
const held = {
  holdState: "on_hold",
  ladderEnabled: true,
  pausedUntil: null,
  promisedPayBy: null,
  noticeAt: null,
  warnedAt: null,
  cancelNotifiedAt: null,
};

describe("board classification", () => {
  it("ladder stages", () => {
    expect(ladderStage(held, now)).toBe("not_started");
    expect(ladderStage({ ...held, noticeAt: now }, now)).toBe("notice");
    expect(ladderStage({ ...held, noticeAt: now, warnedAt: now }, now)).toBe("warning");
    expect(ladderStage({ ...held, cancelNotifiedAt: now }, now)).toBe("cancel_notice");
    expect(ladderStage({ ...held, pausedUntil: "2026-12-01T00:00:00Z" }, now)).toBe("paused");
    expect(ladderStage({ ...held, promisedPayBy: "2026-11-24" }, now)).toBe("promise");
    expect(ladderStage({ ...held, ladderEnabled: false }, now)).toBe("off");
    expect(isChasing("notice")).toBe(true);
    expect(isChasing("paused")).toBe(false);
  });

  it("mismatch is a flag only: shipped while held / released but account on hold", () => {
    const shipped = { source: "extensiv" as const, trackingNumber: "1Z", shipDate: "2026-11-20", carrier: "UPS" };
    expect(mismatchFor({ holdState: "on_hold", shipped, customerHoldStatus: "active" })).toBe("shipped_while_held");
    expect(mismatchFor({ holdState: "released", shipped: null, customerHoldStatus: "hold" })).toBe("released_but_account_on_hold");
    expect(mismatchFor({ holdState: "on_hold", shipped: null, customerHoldStatus: "hold" })).toBeNull();
  });

  it("why-held text", () => {
    expect(humanHoldReason("customer_rule", "Rule: VIP 90/110 — invoice 19310 at 112 days")).toBe(
      "Rule: VIP 90/110 — invoice 19310 at 112 days",
    );
    expect(humanHoldReason("manual", "credit check")).toBe("Manual hold — credit check");
  });

  it("order numbers, search, cursor", () => {
    expect(normalizeOrderNumber(" #18926 ")).toBe("18926");
    expect(matchesSearch({ orderNumber: "#18926", customerName: "Meoros" }, "#1892")).toBe(true);
    expect(matchesSearch({ orderNumber: "#18926", customerName: "Meoros" }, "meor")).toBe(true);
    expect(matchesSearch({ orderNumber: "#18926", customerName: "Meoros" }, "zz")).toBe(false);
    expect(decodeCursor("50")).toBe(50);
    expect(decodeCursor("-1")).toBe(0);
    expect(decodeCursor(undefined)).toBe(0);
  });
});

describe("timeline lines", () => {
  it("says record-only and paid-outside-QBO plainly", () => {
    expect(describeHoldEvent("order.hold_released", { mode: "record_only", paidOutsideQbo: { method: "cheque", note: "chq 9" } })).toBe(
      "Released — paid outside QBO (cheque): chq 9 (recorded only — nobody emailed)",
    );
    expect(describeHoldEvent("order.hold_started", { holdReason: "customer_rule", why: "Rule: VIP 90/110" })).toBe(
      "Put on hold (customer rule) — Rule: VIP 90/110",
    );
  });
});

describe("inbox hold-resolve hook", () => {
  const input = {
    orderId: "o1",
    customerId: "c1",
    orderNumber: "#18926",
    action: "recorded" as const,
    note: "Recorded only",
    actingEmail: "sales@feldart.com",
    idempotencyKey: "k1",
  };
  it("builds the agreed body", () => {
    expect(buildHoldResolveBody(input)).toEqual({
      customerId: "c1",
      orderNumber: "#18926",
      action: "recorded",
      note: "Recorded only",
      actingEmail: "sales@feldart.com",
      idempotencyKey: "k1",
    });
    expect(buildHoldResolveBody({ ...input, customerId: null })).toBeNull();
  });
  it("POSTs with the inbox svc bearer and swallows failures", async () => {
    const fetchOk = vi.fn(async () => new Response(JSON.stringify({ matched: true, closed: 1, threadIds: ["t"] }), { status: 200 }));
    expect(await postHoldResolve(input, fetchOk as unknown as typeof fetch)).toBe("ok");
    const [url, init] = fetchOk.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://inbox.example/api/svc/holds/resolve");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"t".repeat(40)}`);
    const fetchBoom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await postHoldResolve(input, fetchBoom as unknown as typeof fetch)).toBe("failed");
  });
});
