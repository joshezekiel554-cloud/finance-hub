// Tests for the finance gatherer. The Drizzle query builder is mocked with a
// table-aware thenable: each `db.select().from(table)…` chain resolves to the
// canned rows registered for that table. This lets us assert the normalization
// (outbound-email filter is enforced by the WHERE we trust; here we verify the
// shaping + counts + active markers + extension-driven call attribution) with
// no real database.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Registry of rows keyed by the drizzle table object identity.
const rowsByTable = vi.hoisted(() => new Map<unknown, unknown[]>());

vi.mock("../../db/index.js", () => {
  function makeChain(table: unknown) {
    const chain: Record<string, unknown> = {};
    chain.from = (t: unknown) => {
      // The first .from() establishes the table for this chain.
      (chain as { _table: unknown })._table = t;
      return chain;
    };
    chain.leftJoin = () => chain;
    chain.where = () => chain;
    chain.limit = () => chain;
    // Thenable — awaiting the chain resolves the canned rows for its table.
    chain.then = (resolve: (v: unknown) => void) => {
      const t = (chain as { _table: unknown })._table ?? table;
      resolve(rowsByTable.get(t) ?? []);
    };
    return chain;
  }
  return { db: { select: () => makeChain(undefined) } };
});

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { gatherFinanceActivity, buildActiveMarkers } from "./gather-finance.js";
import { emailLog, statementSends } from "../../db/schema/crm.js";
import { auditLog } from "../../db/schema/audit.js";
import { phoneCommunications } from "../../db/schema/vocatech.js";
import { invoiceChases } from "../../db/schema/invoices.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { userActiveMinutes } from "../../db/schema/user-active-minutes.js";

const FROM = "2026-06-29T00:00:00.000Z";
const TO = "2026-06-30T00:00:00.000Z";

function setRows() {
  rowsByTable.clear();
  rowsByTable.set(appSettings, [{ value: '{"102":"u1","999":"someone-else"}' }]);
  rowsByTable.set(emailLog, [
    {
      id: "em1",
      emailDate: new Date("2026-06-29T09:00:00.000Z"),
      subject: "Re: Invoice",
      threadId: "t-9",
      customerId: "c1",
      customerName: "Acme",
    },
  ]);
  rowsByTable.set(phoneCommunications, [
    {
      id: "ph1",
      kind: "call_out",
      direction: "outbound",
      startedAt: new Date("2026-06-29T10:00:00.000Z"),
      durationSeconds: 372,
      remoteNumber: "+447700900000",
      extensionNumber: "102",
      transcription: "hello",
      recordingMediaId: null,
      customerId: "c2",
      customerName: "Jones",
    },
  ]);
  rowsByTable.set(auditLog, [
    {
      id: "au1",
      occurredAt: new Date("2026-06-29T10:40:00.000Z"),
      action: "order.hold_started",
      entityType: "order",
      entityId: "ord-18672",
      before: null,
      after: null,
    },
    {
      id: "au2",
      occurredAt: new Date("2026-06-29T11:20:00.000Z"),
      action: "statement.send",
      entityType: "statement",
      entityId: "stmt-xyz",
      before: null,
      after: null,
    },
  ]);
  // statement_sends with the SAME entity id as the audit row → must dedupe.
  rowsByTable.set(statementSends, [
    {
      id: "stmt-xyz",
      sentAt: new Date("2026-06-29T11:20:00.000Z"),
      statementNumber: 2049,
      statementType: "open_items",
      customerId: "c3",
      customerName: "Berko",
    },
  ]);
  rowsByTable.set(invoiceChases, []);
  rowsByTable.set(userActiveMinutes, [
    { minuteUtc: Math.floor(Date.parse("2026-06-29T09:00:00.000Z") / 60_000) },
    { minuteUtc: Math.floor(Date.parse("2026-06-29T15:40:00.000Z") / 60_000) },
  ]);
}

beforeEach(() => {
  setRows();
});

describe("gatherFinanceActivity", () => {
  it("normalizes emails, calls, audit actions; counts them", async () => {
    const res = await gatherFinanceActivity("u1", FROM, TO);

    expect(res.counts.emailsSent).toBe(1);
    expect(res.counts.calls).toBe(1);
    expect(res.counts.totalTalkSeconds).toBe(372);
    expect(res.counts.holds).toBe(1);
    // statement counted once despite appearing in BOTH audit + statement_sends.
    expect(res.counts.statements).toBe(1);

    const email = res.events.find((e) => e.id === "email-em1");
    expect(email?.title).toBe('Emailed Acme — "Re: Invoice"');
    expect(email?.type).toBe("email_sent");

    const call = res.events.find((e) => e.id === "call-ph1");
    expect(call?.type).toBe("call");
    expect(call?.title).toContain("Outbound call · Jones · 6:12");
    expect(call?.detail).toContain("transcript");

    const hold = res.events.find((e) => e.id === "audit-au1");
    expect(hold?.title).toBe("Placed hold on order");
    expect(hold?.type).toBe("action");

    const stmt = res.events.find((e) => e.id === "audit-au2");
    expect(stmt?.type).toBe("send");
    // No duplicate stmt-* event (the statement_sends row was deduped away).
    expect(res.events.some((e) => e.id === "stmt-stmt-xyz")).toBe(false);
  });

  it("only attributes calls on extensions the user owns", async () => {
    // ext 999 belongs to someone else; give the user a call on it.
    rowsByTable.set(phoneCommunications, []);
    const res = await gatherFinanceActivity("u1", FROM, TO);
    // user u1 owns ext 102 only; with no 102 rows there are no calls.
    expect(res.counts.calls).toBe(0);
  });

  it("collects distinct active minutes and emits start/last markers", async () => {
    const res = await gatherFinanceActivity("u1", FROM, TO);
    expect(res.activeMinuteStampsUtc).toHaveLength(2);
    const markers = res.events.filter((e) => e.type === "active_marker");
    // first-seen + last-seen on the same day.
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.title)).toContain("Started working — first activity of the day");
    expect(markers.map((m) => m.title)).toContain("Last activity");
  });
});

describe("buildActiveMarkers", () => {
  it("returns nothing for an empty set", () => {
    expect(buildActiveMarkers([])).toEqual([]);
  });

  it("returns a single start marker for a one-minute day", () => {
    const m = Math.floor(Date.parse("2026-06-29T09:00:00.000Z") / 60_000);
    const markers = buildActiveMarkers([m]);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.title).toContain("Started working");
  });

  it("splits start/last across multiple London days", () => {
    const d1a = Math.floor(Date.parse("2026-06-28T09:00:00.000Z") / 60_000);
    const d1b = Math.floor(Date.parse("2026-06-28T17:00:00.000Z") / 60_000);
    const d2a = Math.floor(Date.parse("2026-06-29T08:00:00.000Z") / 60_000);
    const markers = buildActiveMarkers([d1a, d1b, d2a]);
    // day1: start+last (2), day2: start only (1).
    expect(markers).toHaveLength(3);
  });
});
