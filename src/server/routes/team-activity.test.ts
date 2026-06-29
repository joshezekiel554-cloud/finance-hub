// Route tests for the Team Activity surface. We boot a real Fastify instance
// with the plugin registered and drive it via `inject`, mocking the auth gate,
// db, inbox members, and the report/csv modules. This exercises the admin gate
// (Hillel 403 / Josh 200), heartbeat idempotency wiring, and the CSV shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// --- mocks ------------------------------------------------------------------
const currentUser = vi.hoisted(() => ({
  value: null as { id: string; email: string } | null,
}));
const adminEmails = vi.hoisted(() => ({ value: ["josh@feldart.com"] }));

vi.mock("../lib/auth.js", () => ({
  requireAuth: vi.fn(async () => {
    if (!currentUser.value) {
      const err = new Error("Unauthorized") as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    }
    return currentUser.value;
  }),
  isAdmin: vi.fn((user: { email?: string } | null) =>
    Boolean(user?.email && adminEmails.value.includes(user.email.toLowerCase())),
  ),
}));

// db chain: .insert().ignore().values() for heartbeat; .select().from()[.where().limit()]
// for members + subject. We capture heartbeat inserts and serve canned rows.
const heartbeatInserts = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));
const userRows = vi.hoisted(() => ({
  value: [] as Array<{ userId: string; name: string | null; email: string | null }>,
}));

vi.mock("../../db/index.js", () => {
  const insertChain = {
    ignore: () => insertChain,
    values: (v: Record<string, unknown>) => {
      heartbeatInserts.value.push(v);
      return Promise.resolve();
    },
  };
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.limit = () => Promise.resolve(userRows.value);
  // `await db.select().from()` (no where) resolves to all rows (members route).
  (selectChain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve(userRows.value);
  return {
    db: {
      insert: () => insertChain,
      select: () => selectChain,
    },
  };
});

vi.mock("../../integrations/inbox/members.js", () => ({
  listMembers: vi.fn(async () => []),
}));

const buildReportMock = vi.hoisted(() => vi.fn());
vi.mock("../../modules/team-activity/report.js", () => ({
  buildTeamActivityReport: buildReportMock,
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import teamActivityRoute from "./team-activity.js";

const FROM = "2026-06-29T00:00:00.000Z";
const TO = "2026-06-30T00:00:00.000Z";

const SAMPLE_REPORT = {
  subject: { userId: "u-josh", name: "Josh", email: "josh@feldart.com", inboxMemberId: null },
  range: { from: FROM, to: TO },
  counts: {
    emailsSent: 1,
    calls: 0,
    totalTalkSeconds: 0,
    holds: 0,
    statements: 0,
    invoices: 0,
    inboxEmailsSent: 0,
    tasksCompleted: 0,
    tasksCreated: 0,
  },
  activeTime: { totalMinutes: 0, financeMinutes: 0, inboxMinutes: 0, perDayMinutes: {} },
  days: [
    {
      day: "2026-06-29",
      label: "Mon 29 Jun",
      activeMinutes: 0,
      events: [
        {
          id: "email-1",
          at: "2026-06-29T09:00:00.000Z",
          source: "finance",
          type: "email_sent",
          title: 'Emailed Acme, Inc — "Re: Invoice"', // comma forces CSV quoting
          detail: "outbound",
          customerName: "Acme, Inc",
        },
      ],
    },
  ],
  inboxUnavailable: false,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Surface thrown 401s as proper status codes (mirrors the app error handler).
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    reply.code(status).send({ error: err.message });
  });
  await app.register(teamActivityRoute, { prefix: "/api" });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  currentUser.value = null;
  adminEmails.value = ["josh@feldart.com"];
  heartbeatInserts.value = [];
  userRows.value = [];
  buildReportMock.mockReset();
  buildReportMock.mockResolvedValue(SAMPLE_REPORT);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe("admin gate", () => {
  it("403s a non-admin (Hillel) on the report route", async () => {
    currentUser.value = { id: "u-hillel", email: "hschijves@gmail.com" };
    const res = await app.inject({
      method: "GET",
      url: `/api/team-activity?userId=u-hillel&from=${FROM}&to=${TO}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("200s an admin (Josh) on the report route", async () => {
    currentUser.value = { id: "u-josh", email: "josh@feldart.com" };
    userRows.value = [{ userId: "u-josh", name: "Josh", email: "josh@feldart.com" }];
    const res = await app.inject({
      method: "GET",
      url: `/api/team-activity?userId=u-josh&from=${FROM}&to=${TO}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subject.name).toBe("Josh");
  });

  it("403s a non-admin on members + csv routes too", async () => {
    currentUser.value = { id: "u-hillel", email: "hschijves@gmail.com" };
    const members = await app.inject({ method: "GET", url: "/api/team-activity/members" });
    expect(members.statusCode).toBe(403);
    const csv = await app.inject({
      method: "GET",
      url: `/api/team-activity/export.csv?userId=u-hillel&from=${FROM}&to=${TO}`,
    });
    expect(csv.statusCode).toBe(403);
  });
});

describe("POST /api/heartbeat", () => {
  it("requires auth (401 when no user)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/heartbeat" });
    expect(res.statusCode).toBe(401);
    expect(heartbeatInserts.value).toHaveLength(0);
  });

  it("upserts the current minute for any authenticated user and returns 204", async () => {
    currentUser.value = { id: "u-hillel", email: "hschijves@gmail.com" }; // non-admin allowed
    const res = await app.inject({ method: "POST", url: "/api/heartbeat" });
    expect(res.statusCode).toBe(204);
    expect(heartbeatInserts.value).toHaveLength(1);
    const row = heartbeatInserts.value[0]!;
    expect(row.userId).toBe("u-hillel");
    // minuteUtc is floor(now/60000) — a sane recent integer.
    expect(typeof row.minuteUtc).toBe("number");
    expect(row.minuteUtc).toBeGreaterThan(Math.floor(Date.parse("2026-01-01") / 60_000));
  });

  it("is idempotent at the wire level — two pings in the same minute both 204", async () => {
    currentUser.value = { id: "u-josh", email: "josh@feldart.com" };
    const a = await app.inject({ method: "POST", url: "/api/heartbeat" });
    const b = await app.inject({ method: "POST", url: "/api/heartbeat" });
    expect(a.statusCode).toBe(204);
    expect(b.statusCode).toBe(204);
    // Both reach the INSERT IGNORE; the DB PK collapses dupes (mocked here).
    expect(heartbeatInserts.value).toHaveLength(2);
    expect(heartbeatInserts.value[0]!.minuteUtc).toBe(heartbeatInserts.value[1]!.minuteUtc);
  });
});

describe("GET /api/team-activity/export.csv", () => {
  it("returns a text/csv attachment with the expected header + quoted fields", async () => {
    currentUser.value = { id: "u-josh", email: "josh@feldart.com" };
    userRows.value = [{ userId: "u-josh", name: "Josh", email: "josh@feldart.com" }];
    const res = await app.inject({
      method: "GET",
      url: `/api/team-activity/export.csv?userId=u-josh&from=${FROM}&to=${TO}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(String(res.headers["content-disposition"])).toContain("attachment");
    const body = res.body;
    const lines = body.trim().split("\r\n");
    expect(lines[0]).toBe("date,time,source,type,title,detail,customer");
    // The title + customer contain commas → must be double-quoted.
    expect(lines[1]).toContain('"Emailed Acme, Inc');
    expect(lines[1]).toContain('"Acme, Inc"');
    expect(lines[1]).toContain("2026-06-29");
    expect(lines[1]).toContain("email_sent");
  });
});

describe("validation", () => {
  it("400s on a missing/invalid range", async () => {
    currentUser.value = { id: "u-josh", email: "josh@feldart.com" };
    const res = await app.inject({ method: "GET", url: "/api/team-activity?userId=u-josh" });
    expect(res.statusCode).toBe(400);
  });
});
