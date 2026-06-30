// Service tests for the Time Clock. The Drizzle query builder is mocked with a
// table-aware chain: selects resolve canned rows per table; inserts/updates are
// captured + applied to an in-memory session store so clockIn/clockOut/getStatus
// observe each other. nanoid is stubbed to deterministic ids.

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- in-memory stores -------------------------------------------------------
type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({
  sessions: [] as Row[], // time_clock_sessions
  audit: [] as Row[], // audit_log
  allowList: "" as string, // app_settings time_clock_user_ids value
  idSeq: 0,
}));

vi.mock("nanoid", () => ({
  nanoid: () => `id-${++store.idSeq}`,
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Minimal drizzle mock. We don't replay WHERE predicates faithfully — instead we
// resolve the right rows by inspecting which table the chain selected from and a
// few captured filter hints the service sets via its query shape. To stay
// robust, selects on time_clock_sessions return ALL session rows and the service
// re-filters in JS for status/activity; for the open-session + by-id lookups the
// chain remembers the captured eq() ids.
vi.mock("../../db/index.js", () => {
  return { db: makeDb() };

  function makeDb() {
    return {
      select: (_proj?: unknown) => makeSelectChain(),
      insert: (table: unknown) => ({
        values: (vals: Row | Row[]) => {
          const rows = Array.isArray(vals) ? vals : [vals];
          for (const v of rows) applyInsert(table, v);
          return Promise.resolve();
        },
      }),
      update: (_table: unknown) => ({
        set: (patch: Row) => ({
          where: (pred: unknown) => {
            applyUpdate(patch, pred);
            return Promise.resolve();
          },
        }),
      }),
    };
  }

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    let table: unknown;
    const eqIds: string[] = [];
    chain.from = (t: unknown) => {
      table = t;
      return chain;
    };
    chain.where = (pred: unknown) => {
      collectEqStrings(pred, eqIds);
      return chain;
    };
    chain.orderBy = () => chain;
    chain.limit = () => resolveRows();
    chain.then = (resolve: (v: unknown) => void) => resolve(resolveRows());
    return chain;

    function resolveRows(): Promise<unknown[]> {
      return Promise.resolve(rowsFor(table, eqIds));
    }
  }
});

import { appSettings } from "../../db/schema/app-settings.js";
import { timeClockSessions } from "../../db/schema/time-clock-sessions.js";

// --- mock plumbing helpers (declared after mocks, used by the factory above) -

function collectEqStrings(_pred: unknown, _out: string[]): void {
  // We don't introspect drizzle SQL nodes; the in-memory resolver below keys off
  // the table + the live store, which is enough for these tests.
}

function rowsFor(table: unknown, _eqIds: string[]): unknown[] {
  if (table === appSettings) {
    return store.allowList ? [{ value: store.allowList }] : [];
  }
  if (table === timeClockSessions) {
    // Return all sessions; callers (getOpenSession / by-id reads / status /
    // activity) filter in JS. getOpenSession orders desc + limit 1 and picks the
    // open one — but our chain.limit resolves the full set, so we hand back the
    // store sorted so [0] (after the service's own .limit semantics) is sane.
    // The service reads rows[0] only for by-id (unique) + open lookups; to make
    // those deterministic we sort open-first then newest-first.
    return [...store.sessions].sort((a, b) => {
      const ao = a.clockOutAt == null ? 0 : 1;
      const bo = b.clockOutAt == null ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return (b.clockInAt as Date).getTime() - (a.clockInAt as Date).getTime();
    });
  }
  return [];
}

function applyInsert(table: unknown, v: Row): void {
  if (table === timeClockSessions) {
    store.sessions.push({
      id: v.id,
      userId: v.userId,
      clockInAt: v.clockInAt,
      clockOutAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } else {
    // audit_log
    store.audit.push(v);
  }
}

function applyUpdate(patch: Row, _pred: unknown): void {
  // The only update in the service closes the currently-open session.
  const open = store.sessions.find((s) => s.clockOutAt == null);
  if (open && patch.clockOutAt) open.clockOutAt = patch.clockOutAt;
}

// IMPORTANT: import the SUT after the mocks above are registered.
import {
  clockIn,
  clockOut,
  getClockedActivity,
  getStatus,
  isClockEnabled,
  parseAllowList,
} from "./service.js";

const USER = "u-hillel";

beforeEach(() => {
  store.sessions = [];
  store.audit = [];
  store.allowList = JSON.stringify([USER]);
  store.idSeq = 0;
});

describe("parseAllowList", () => {
  it("parses a JSON array, tolerating blank/garbage", () => {
    expect(parseAllowList('["a","b"]')).toEqual(["a", "b"]);
    expect(parseAllowList("")).toEqual([]);
    expect(parseAllowList(null)).toEqual([]);
    expect(parseAllowList("not json")).toEqual([]);
    expect(parseAllowList('{"a":1}')).toEqual([]);
    expect(parseAllowList('["ok", 3, "", "two"]')).toEqual(["ok", "two"]);
  });
});

describe("isClockEnabled", () => {
  it("is true for an allow-listed user, false otherwise", async () => {
    expect(await isClockEnabled(USER)).toBe(true);
    expect(await isClockEnabled("someone-else")).toBe(false);
  });
  it("is false when the setting is missing", async () => {
    store.allowList = "";
    expect(await isClockEnabled(USER)).toBe(false);
  });
});

describe("clockIn / clockOut", () => {
  it("opens a session, then refuses a second clock-in while open", async () => {
    const first = await clockIn(USER);
    expect(first.ok).toBe(true);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]!.clockOutAt).toBeNull();
    // audit row written for the in.
    expect(store.audit.some((a) => a.action === "time_clock.in")).toBe(true);

    const second = await clockIn(USER);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_open");
    expect(store.sessions).toHaveLength(1);
  });

  it("clockOut closes the open session + writes an audit row", async () => {
    await clockIn(USER);
    const out = await clockOut(USER);
    expect(out.ok).toBe(true);
    expect(store.sessions[0]!.clockOutAt).not.toBeNull();
    expect(store.audit.some((a) => a.action === "time_clock.out")).toBe(true);
  });

  it("clockOut with nothing open returns not_open", async () => {
    const out = await clockOut(USER);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not_open");
  });
});

describe("getStatus", () => {
  it("returns enabled:false + zeros for a non-allow-list user", async () => {
    const st = await getStatus("someone-else");
    expect(st).toEqual({
      enabled: false,
      open: null,
      stale: false,
      todayMinutes: 0,
      weekMinutes: 0,
    });
  });

  it("reflects an open session + accrues today/week minutes", async () => {
    // Seed a completed session earlier today and an open one running now.
    const now = Date.now();
    store.sessions.push({
      id: "done-1",
      userId: USER,
      clockInAt: new Date(now - 90 * 60_000), // 90m ago
      clockOutAt: new Date(now - 60 * 60_000), // closed 60m ago → 30m
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    store.sessions.push({
      id: "open-1",
      userId: USER,
      clockInAt: new Date(now - 20 * 60_000), // open, 20m ago
      clockOutAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const st = await getStatus(USER);
    expect(st.enabled).toBe(true);
    expect(st.open).not.toBeNull();
    // 30m completed + ~20m open = ~50m today (allow ±1 for the second boundary).
    expect(st.todayMinutes).toBeGreaterThanOrEqual(49);
    expect(st.todayMinutes).toBeLessThanOrEqual(51);
    expect(st.weekMinutes).toBeGreaterThanOrEqual(st.todayMinutes);
    expect(st.stale).toBe(false); // fresh same-day open
  });
});

describe("getClockedActivity", () => {
  const FROM = "2026-06-29T00:00:00.000Z";
  const TO = "2026-06-30T00:00:00.000Z";

  it("clamps completed sessions + emits clock-in/out rows", async () => {
    store.sessions.push({
      id: "s1",
      userId: USER,
      clockInAt: new Date("2026-06-29T09:00:00.000Z"),
      clockOutAt: new Date("2026-06-29T11:00:00.000Z"),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await getClockedActivity(USER, FROM, TO);
    expect(res.clockedMinutes).toBe(120);
    expect(res.perDayMinutes["2026-06-29"]).toBe(120);
    expect(res.openSessionStale).toBe(false);
    expect(res.events.map((e) => e.id)).toEqual(["clock-in-s1", "clock-out-s1"]);
    expect(res.events[0]!.type).toBe("action");
    expect(res.events[1]!.detail).toContain("2h 00m session");
  });

  it("flags a stale open session that crossed midnight + counts open-elapsed", async () => {
    // Open since yesterday → stale; minutes accrue from window-start to now.
    store.sessions.push({
      id: "s2",
      userId: USER,
      clockInAt: new Date("2026-06-28T20:00:00.000Z"),
      clockOutAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await getClockedActivity(USER, FROM, TO);
    expect(res.openSessionStale).toBe(true);
    // No clock-in row inside the window (it started before FROM); minutes still
    // accrue from FROM forward, so clockedMinutes > 0.
    expect(res.events.some((e) => e.id === "clock-in-s2")).toBe(false);
    expect(res.clockedMinutes).toBeGreaterThan(0);
  });
});
