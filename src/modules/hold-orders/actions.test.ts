import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted shared state: the order row the select returns, every update/insert,
// and every Gmail send (the senders are mocked so we can assert exact calls).
const h = vi.hoisted(() => {
  const state: { order: Record<string, unknown> | undefined } = { order: undefined };
  const claim = { rows: 1 };
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const sends: Array<Record<string, unknown>> = [];
  const resolves: Array<Record<string, unknown>> = [];
  const select = () => {
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(state.order ? [state.order] : []),
    };
    return chain;
  };
  const update = () => ({
    set: (set: Record<string, unknown>) => {
      updates.push(set);
      // mysql2 shape: [ResultSetHeader, fields]. Claims (they set holdState)
      // match `claimRows` rows; follow-up stamps always match.
      const n = "holdState" in set ? claim.rows : 1;
      return { where: () => Promise.resolve([{ affectedRows: n }, []]) };
    },
  });
  const insert = () => ({
    values: (v: Record<string, unknown>) => {
      inserts.push(v);
      return Promise.resolve();
    },
  });
  const envState = {
    SHADOW_MODE: false,
    PUBLIC_URL: "https://finance.feldart.com",
  };
  return { state, claim, updates, inserts, sends, resolves, db: { select, update, insert }, envState };
});

vi.mock("../../db/index.js", () => ({ db: h.db }));
vi.mock("../../lib/env.js", () => ({ env: h.envState }));
vi.mock("../statements/settings.js", () => ({
  loadAppSettings: vi.fn(async () => ({
    order_hold_warehouse_recipients: "warehouse@bluechip.example",
    order_hold_team_recipients: "accounts@feldart.example",
  })),
}));
vi.mock("../../integrations/gmail/send.js", () => ({
  sendEmail: vi.fn(async (args: Record<string, unknown>) => {
    h.sends.push(args);
    return { threadId: "thr-1", messageId: "msg-1" };
  }),
}));
vi.mock("./inbox-resolve.js", () => ({
  onHoldReleased: vi.fn((args: Record<string, unknown>) => {
    h.resolves.push(args);
  }),
}));

import { holdOrder, previewAction, releaseOrder } from "./actions.js";

const actor = { userId: "u-sales", email: "sales@feldart.com" };

function baseOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: "o1",
    orderNumber: "#18926",
    shopifyOrderId: "555",
    total: "1234.50",
    holdState: "none",
    holdReason: null,
    holdNote: null,
    holdAlertThreadId: "alert-thread",
    holdAlertMessageId: "<alert@x>",
    holdLadderPausedUntil: null,
    customerId: "c1",
    customerName: "Meoros",
    customerPromisedPayBy: null,
    primaryEmail: "buyer@meoros.example",
    billingEmails: null,
    invoiceToEmails: null,
    invoiceCcEmails: null,
    invoiceBccEmails: null,
    statementToEmails: null,
    statementCcEmails: null,
    statementBccEmails: null,
    tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  h.updates.length = 0;
  h.inserts.length = 0;
  h.sends.length = 0;
  h.resolves.length = 0;
  h.envState.SHADOW_MODE = false;
  h.claim.rows = 1;
});

describe("claim-then-send", () => {
  it("hold: someone changed the order since we loaded it → nothing sent, nothing audited", async () => {
    h.state.order = baseOrder();
    h.claim.rows = 0;
    const r = await holdOrder("o1", actor, { reason: "manual", startLadder: false, mode: "notify" });
    expect(r).toEqual({ ok: false, reason: "changed_concurrently" });
    expect(h.sends).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
  });

  it("release: already released by someone else → no second warehouse email, no inbox call", async () => {
    h.state.order = baseOrder({ holdState: "on_hold" });
    h.claim.rows = 0;
    const r = await releaseOrder("o1", actor, { mode: "notify" });
    expect(r).toEqual({ ok: false, reason: "changed_concurrently" });
    expect(h.sends).toHaveLength(0);
    expect(h.resolves).toHaveLength(0);
  });

  it("hold notify: claim happens before the send, thread stamped after", async () => {
    h.state.order = baseOrder();
    await holdOrder("o1", actor, { reason: "manual", startLadder: false, mode: "notify" });
    expect(h.updates[0]).toMatchObject({ holdState: "on_hold", holdAlertThreadId: null });
    expect(h.updates[1]).toEqual({ holdAlertThreadId: "thr-1", holdAlertMessageId: "msg-1" });
  });
});

describe("preview for the holds role", () => {
  it("hides the finance customer link in the preview body; the sent email keeps it", async () => {
    h.state.order = baseOrder();
    const opts = { reason: "manual" as const, startLadder: false, mode: "notify" as const };
    const admin = await previewAction("o1", { action: "hold", opts });
    const sales = await previewAction("o1", { action: "hold", opts }, { hideFinanceLinks: true });
    expect(admin?.emails[0]?.body).toContain("https://finance.feldart.com/customers/c1");
    expect(sales?.emails[0]?.body).not.toContain("finance.feldart.com/customers");
    expect(sales?.emails[0]?.body).toContain("(finance customer link — not shown)");
    await holdOrder("o1", actor, opts);
    expect(String(h.sends[0]?.text)).toContain("https://finance.feldart.com/customers/c1");
  });
});

function auditAfter(): Record<string, unknown> {
  const row = h.inserts.at(-1) as { after: Record<string, unknown> };
  return row.after;
}

describe("record_only sends nothing", () => {
  it("hold record_only: zero emails, state updated, ladder off, audit says record_only", async () => {
    h.state.order = baseOrder();
    const r = await holdOrder("o1", actor, {
      reason: "manual",
      note: "warehouse already told by phone",
      startLadder: true, // ignored in record_only
      mode: "record_only",
    });
    expect(r).toEqual({ ok: true, emailed: [] });
    expect(h.sends).toHaveLength(0);
    expect(h.updates[0]).toMatchObject({
      holdState: "on_hold",
      holdReason: "manual",
      holdLadderEnabled: false,
    });
    // Stamped so the standard detection pass never alerts for it later.
    expect(h.updates[0]?.holdAlertedAt).toBeInstanceOf(Date);
    expect(auditAfter()).toMatchObject({ mode: "record_only", emailed: [], via: "holdorders", actorEmail: "sales@feldart.com" });
  });

  it("release record_only: zero emails, released, inbox hook told 'recorded'", async () => {
    h.state.order = baseOrder({ holdState: "on_hold", holdReason: "manual" });
    const r = await releaseOrder("o1", actor, { mode: "record_only" });
    expect(r).toEqual({ ok: true, emailed: [] });
    expect(h.sends).toHaveLength(0);
    expect(h.updates[0]).toMatchObject({ holdState: "released", holdReleasedByUserId: "u-sales" });
    expect(h.resolves).toHaveLength(1);
    expect(h.resolves[0]).toMatchObject({
      customerId: "c1",
      orderNumber: "#18926",
      action: "recorded",
      actingEmail: "sales@feldart.com",
    });
  });

  it("preview of record_only is empty", async () => {
    h.state.order = baseOrder({ holdState: "on_hold" });
    const p = await previewAction("o1", { action: "release", mode: "record_only" });
    expect(p?.emails).toEqual([]);
  });
});

describe("preview == what notify sends", () => {
  it("hold notify: preview lists the warehouse alert (now) + customer notice (next sync); only 'now' emails go immediately, identical to the preview", async () => {
    h.state.order = baseOrder();
    const opts = { reason: "manual" as const, note: "credit check", startLadder: true, mode: "notify" as const };
    const preview = await previewAction("o1", { action: "hold", opts });
    expect(preview?.emails.map((e) => [e.role, e.template, e.when])).toEqual([
      ["warehouse", "hold_alert", "now"],
      ["customer", "hold_notice", "next_sync"],
    ]);
    expect(preview?.emails[1]?.to).toBe("buyer@meoros.example");

    const r = await holdOrder("o1", actor, opts);
    expect(r.ok).toBe(true);
    const nowEmails = preview!.emails.filter((e) => e.when === "now");
    expect(h.sends.map((s) => ({ to: s.to, subject: s.subject }))).toEqual(
      nowEmails.map((e) => ({ to: e.to, subject: e.subject })),
    );
    expect(h.sends[0]?.to).toBe("warehouse@bluechip.example,accounts@feldart.example");
    // The action's own record of who it emailed is the same plan.
    if (r.ok) expect(r.emailed).toEqual(preview!.emails.map(({ body: _body, ...e }) => e));
    // Preview body == the body actually sent.
    expect(h.sends[0]?.text).toBe(preview!.emails[0]!.body);
    expect(h.updates[0]).toMatchObject({ holdLadderEnabled: true });
    expect(h.updates[1]).toMatchObject({ holdAlertThreadId: "thr-1" });
  });

  it("release notify: preview == the in-thread warehouse CLEARED email that is sent", async () => {
    h.state.order = baseOrder({ holdState: "on_hold", holdReason: "manual" });
    const preview = await previewAction("o1", { action: "release", mode: "notify" });
    expect(preview?.emails).toHaveLength(1);
    expect(preview?.emails[0]).toMatchObject({ role: "warehouse", template: "hold_release" });

    await releaseOrder("o1", actor, { mode: "notify" });
    expect(h.sends).toHaveLength(1);
    expect({ to: h.sends[0]?.to, subject: h.sends[0]?.subject }).toEqual({
      to: preview!.emails[0]!.to,
      subject: preview!.emails[0]!.subject,
    });
    expect(h.sends[0]).toMatchObject({ threadId: "alert-thread", inReplyTo: "<alert@x>", financeSendType: "hold-release" });
    expect(h.resolves[0]).toMatchObject({ action: "released" });
  });

  it("shadow mode: plan still previewed, nothing sent", async () => {
    h.envState.SHADOW_MODE = true;
    h.state.order = baseOrder({ holdState: "on_hold" });
    const preview = await previewAction("o1", { action: "release", mode: "notify" });
    expect(preview?.shadowMode).toBe(true);
    await releaseOrder("o1", actor, { mode: "notify" });
    expect(h.sends).toHaveLength(0);
  });
});

describe("paid outside QBO release", () => {
  it("records method + note in the audit and the inbox note; record_only sends nothing", async () => {
    h.state.order = baseOrder({ holdState: "on_hold", holdReason: "overdue_non_communicating" });
    const r = await releaseOrder("o1", actor, {
      mode: "record_only",
      paidOutsideQbo: { method: "cheque", note: "Cheque #4411 received 24 Nov" },
    });
    expect(r.ok).toBe(true);
    expect(h.sends).toHaveLength(0);
    expect(auditAfter()).toMatchObject({
      holdState: "released",
      mode: "record_only",
      paidOutsideQbo: { method: "cheque", note: "Cheque #4411 received 24 Nov" },
    });
    expect(String(h.resolves[0]?.note)).toContain("Paid outside QBO (cheque)");
  });

  it("requires a note", async () => {
    h.state.order = baseOrder({ holdState: "on_hold" });
    const r = await releaseOrder("o1", actor, {
      mode: "notify",
      paidOutsideQbo: { method: "stripe", note: "  " },
    });
    expect(r).toEqual({ ok: false, reason: "paid_outside_note_required" });
    expect(h.sends).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });

  it("notify + paid outside: warehouse gets the release email", async () => {
    h.state.order = baseOrder({ holdState: "on_hold" });
    await releaseOrder("o1", actor, {
      mode: "notify",
      paidOutsideQbo: { method: "stripe", note: "Stripe ch_123" },
    });
    expect(h.sends).toHaveLength(1);
  });
});

describe("guards", () => {
  it("refuses to hold an already-held order and to release a non-held one", async () => {
    h.state.order = baseOrder({ holdState: "on_hold" });
    expect(await holdOrder("o1", actor, { reason: "manual", startLadder: false, mode: "notify" })).toEqual({
      ok: false,
      reason: "already_on_hold",
    });
    h.state.order = baseOrder({ holdState: "released" });
    expect(await releaseOrder("o1", actor, { mode: "notify" })).toEqual({ ok: false, reason: "not_on_hold" });
    expect(h.sends).toHaveLength(0);
  });
});
