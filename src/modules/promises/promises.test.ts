import { describe, expect, it } from "vitest";
import { clearPromise, setPromise, type PromiseDeps } from "./promises.js";
import { endOfDayNewYork, isPromiseActive, promiseDateError } from "./promise-state.js";
import type { RecordActivityInput } from "../crm/activity-ingester.js";

const NOW = new Date("2026-11-19T14:00:00Z");

type Row = {
  id: string;
  displayName: string;
  promisedPayBy: string | null;
  promiseNote: string | null;
  promiseSetBy: string | null;
  promiseSetAt: Date | null;
};

function fakeDeps(row: Row | null, held: Array<{ id: string; holdLadderPausedUntil: Date | null }> = []) {
  const calls = {
    saved: [] as Array<Record<string, unknown>>,
    paused: [] as Array<{ orderId: string; until: Date | null; note: string | null }>,
    activities: [] as RecordActivityInput[],
    audits: [] as Array<{ action: string; after: Record<string, unknown> }>,
  };
  const deps: PromiseDeps = {
    loadCustomer: async (id) => (row && row.id === id ? row : null),
    saveCustomer: async (_id, fields) => {
      calls.saved.push(fields);
    },
    listHeldOrders: async () => held,
    pauseOrder: async (orderId, _userId, until, note) => {
      calls.paused.push({ orderId, until, note });
      return { ok: true };
    },
    recordActivity: async (input) => {
      calls.activities.push(input);
      return "act1";
    },
    writeAudit: async (r) => {
      calls.audits.push({ action: r.action, after: r.after });
    },
    userIdFor: async () => "user-josh",
    now: () => NOW,
  };
  return { deps, calls };
}

const customer = (over: Partial<Row> = {}): Row => ({
  id: "cust1",
  displayName: "Keter Judaica",
  promisedPayBy: null,
  promiseNote: null,
  promiseSetBy: null,
  promiseSetAt: null,
  ...over,
});

describe("promise-state", () => {
  it("is active through the promised day and stops the day after", () => {
    expect(isPromiseActive("2026-11-19", NOW)).toBe(true);
    expect(isPromiseActive("2026-11-30", NOW)).toBe(true);
    expect(isPromiseActive("2026-11-18", NOW)).toBe(false);
    expect(isPromiseActive(null, NOW)).toBe(false);
  });

  it("validates dates: real, YYYY-MM-DD, not before today (UTC)", () => {
    expect(promiseDateError("2026-11-19", NOW)).toBeNull();
    expect(promiseDateError("2026-11-18", NOW)).toBe("date is in the past");
    expect(promiseDateError("2026-02-30", NOW)).toMatch(/real calendar date/);
    expect(promiseDateError("19/11/2026", NOW)).toMatch(/real calendar date/);
    expect(promiseDateError(20261119, NOW)).toMatch(/real calendar date/);
  });
});

describe("setPromise", () => {
  it("saves the promise, pauses each held order, and writes the timeline note + audit", async () => {
    const { deps, calls } = fakeDeps(customer(), [
      { id: "o1", holdLadderPausedUntil: null },
      { id: "o2", holdLadderPausedUntil: null },
    ]);
    const res = await setPromise(
      { customerId: "cust1", date: "2026-11-21", note: " wire  Friday ", actorEmail: "Josh@X.com", source: "hub" },
      deps,
    );
    expect(res).toEqual({
      ok: true,
      changed: true,
      promise: { customerId: "cust1", promisedBy: "2026-11-21", note: "wire Friday", setBy: "josh@x.com" },
    });
    expect(calls.saved).toEqual([
      { promisedPayBy: "2026-11-21", promiseNote: "wire Friday", promiseSetBy: "josh@x.com", promiseSetAt: NOW },
    ]);
    expect(calls.paused).toEqual([
      { orderId: "o1", until: endOfDayNewYork("2026-11-21"), note: "wire Friday" },
      { orderId: "o2", until: endOfDayNewYork("2026-11-21"), note: "wire Friday" },
    ]);
    expect(calls.activities).toHaveLength(1);
    expect(calls.activities[0]).toMatchObject({
      customerId: "cust1",
      kind: "manual_note",
      userId: "user-josh",
      body: "Promise: pay by 2026-11-21 — wire Friday (via hub, josh@x.com)",
      meta: { source: "hub", promisedBy: "2026-11-21", setBy: "josh@x.com" },
    });
    expect(calls.audits.map((a) => a.action)).toEqual(["customer.promise_set"]);
    expect(calls.audits[0]!.after.pausedOrders).toEqual(["o1", "o2"]);
  });

  it("is a no-op when the same date + note is saved again", async () => {
    const { deps, calls } = fakeDeps(
      customer({ promisedPayBy: "2026-11-21", promiseNote: "wire Friday", promiseSetBy: "shaya@x.com" }),
    );
    const res = await setPromise({ customerId: "cust1", date: "2026-11-21", note: "wire Friday", actorEmail: "josh@x.com", source: "hub" }, deps);
    expect(res).toEqual({
      ok: true,
      changed: false,
      promise: { customerId: "cust1", promisedBy: "2026-11-21", note: "wire Friday", setBy: "shaya@x.com" },
    });
    expect(calls.saved).toHaveLength(0);
    expect(calls.activities).toHaveLength(0);
    expect(calls.audits).toHaveLength(0);
  });

  it("allows today, rejects a past date and an unknown customer", async () => {
    const ok = fakeDeps(customer());
    expect((await setPromise({ customerId: "cust1", date: "2026-11-19", actorEmail: "j@x.com", source: "hub" }, ok.deps)).ok).toBe(true);
    const past = fakeDeps(customer());
    expect(await setPromise({ customerId: "cust1", date: "2026-11-18", actorEmail: "j@x.com", source: "hub" }, past.deps)).toEqual({
      ok: false,
      reason: "bad_date",
      error: "date is in the past",
    });
    expect(past.calls.saved).toHaveLength(0);
    const missing = fakeDeps(null);
    expect(await setPromise({ customerId: "nope", date: "2026-11-20", actorEmail: "j@x.com", source: "hub" }, missing.deps)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("omits the dash when there's no note", async () => {
    const { deps, calls } = fakeDeps(customer());
    await setPromise({ customerId: "cust1", date: "2026-11-20", actorEmail: "j@x.com", source: "hub" }, deps);
    expect(calls.activities[0]!.body).toBe("Promise: pay by 2026-11-20 (via hub, j@x.com)");
  });
});

describe("clearPromise", () => {
  it("clears the promise and resumes only the order pauses it created", async () => {
    const { deps, calls } = fakeDeps(customer({ promisedPayBy: "2026-11-21", promiseNote: "wire Friday" }), [
      { id: "o1", holdLadderPausedUntil: endOfDayNewYork("2026-11-21") },
      { id: "o2", holdLadderPausedUntil: endOfDayNewYork("2026-11-28") },
    ]);
    const res = await clearPromise({ customerId: "cust1", actorEmail: "josh@x.com", source: "finance", userId: "u1" }, deps);
    expect(res).toEqual({ ok: true, changed: true, promise: null });
    expect(calls.saved).toEqual([{ promisedPayBy: null, promiseNote: null, promiseSetBy: null, promiseSetAt: null }]);
    expect(calls.paused).toEqual([{ orderId: "o1", until: null, note: null }]);
    expect(calls.activities[0]!.body).toBe("Promise cleared (was: pay by 2026-11-21 — wire Friday) (via finance, josh@x.com)");
    expect(calls.audits.map((a) => a.action)).toEqual(["customer.promise_cleared"]);
  });

  it("is a no-op without a promise", async () => {
    const { deps, calls } = fakeDeps(customer());
    expect(await clearPromise({ customerId: "cust1", actorEmail: "j@x.com", source: "finance" }, deps)).toEqual({
      ok: true,
      changed: false,
      promise: null,
    });
    expect(calls.saved).toHaveLength(0);
  });
});
