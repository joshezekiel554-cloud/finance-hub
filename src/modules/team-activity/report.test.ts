import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the finance gatherer (DB) + inbox client/members so the merge logic is
// tested with no database or network.
const gatherMock = vi.hoisted(() => vi.fn());
const inboxFetchMock = vi.hoisted(() => vi.fn());
const resolveMemberMock = vi.hoisted(() => vi.fn());
const clockedMock = vi.hoisted(() => vi.fn());

vi.mock("./gather-finance.js", () => ({
  gatherFinanceActivity: gatherMock,
  // buildActiveMarkers is re-exported through gather-finance; provide a stub so
  // report.ts's import graph resolves (report.ts doesn't call it directly).
  buildActiveMarkers: vi.fn(() => []),
}));
// Time Clock service is DB-backed; stub it so the merge runs without a database.
vi.mock("../time-clock/service.js", () => ({
  getClockedActivity: clockedMock,
}));
vi.mock("../../integrations/inbox/client.js", () => ({
  inboxFetch: inboxFetchMock,
}));
vi.mock("../../integrations/inbox/members.js", () => ({
  resolveMemberByEmail: resolveMemberMock,
}));
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildTeamActivityReport, mapInboxEvent } from "./report.js";
import type { FinanceActivity, InboxMemberActivity } from "./types.js";

const FROM = "2026-06-29T00:00:00.000Z";
const TO = "2026-06-30T00:00:00.000Z";

const FINANCE: FinanceActivity = {
  events: [
    {
      id: "email-1",
      at: "2026-06-29T09:00:00.000Z",
      source: "finance",
      type: "email_sent",
      title: 'Emailed Acme — "Re: Invoice"',
    },
  ],
  counts: { emailsSent: 1, calls: 0, totalTalkSeconds: 0, holds: 0, statements: 0, invoices: 0 },
  // 09:00 and 09:01 UTC.
  activeMinuteStampsUtc: [
    Math.floor(Date.parse("2026-06-29T09:00:00.000Z") / 60_000),
    Math.floor(Date.parse("2026-06-29T09:01:00.000Z") / 60_000),
  ],
};

describe("mapInboxEvent", () => {
  it("maps customerFinanceId → customerId and prefixes the id + source", () => {
    const mapped = mapInboxEvent({
      id: "abc",
      at: "2026-06-29T10:00:00.000Z",
      type: "task",
      title: "Completed task",
      detail: "in Chasing column",
      customerFinanceId: "cust-9",
      customerName: "Acme",
      link: { kind: "task", id: "t-1" },
    });
    expect(mapped).toEqual({
      id: "inbox-abc",
      at: "2026-06-29T10:00:00.000Z",
      source: "inbox",
      type: "task",
      title: "Completed task",
      detail: "in Chasing column",
      customerId: "cust-9",
      customerName: "Acme",
      link: { kind: "task", id: "t-1" },
    });
  });
});

describe("buildTeamActivityReport", () => {
  beforeEach(() => {
    gatherMock.mockReset();
    inboxFetchMock.mockReset();
    resolveMemberMock.mockReset();
    clockedMock.mockReset();
    gatherMock.mockResolvedValue(FINANCE);
    clockedMock.mockResolvedValue({
      clockedMinutes: 0,
      perDayMinutes: {},
      openSessionStale: false,
      events: [],
    });
  });

  it("merges inbox events + sessionizes active time across both apps", async () => {
    resolveMemberMock.mockResolvedValue({ teamMemberId: "tm-7" });
    const inbox: InboxMemberActivity = {
      events: [
        {
          id: "ix",
          at: "2026-06-29T11:00:00.000Z",
          type: "task",
          title: "Completed task",
          customerFinanceId: null,
        },
      ],
      counts: { emailsSent: 4, tasksCompleted: 2, tasksCreated: 3 },
      // 09:01 overlaps finance; 11:00 is new.
      activeMinuteStampsUtc: [
        Math.floor(Date.parse("2026-06-29T09:01:00.000Z") / 60_000),
        Math.floor(Date.parse("2026-06-29T11:00:00.000Z") / 60_000),
      ],
    };
    inboxFetchMock.mockResolvedValue(inbox);

    const report = await buildTeamActivityReport(
      { userId: "u1", name: "Hillel", email: "hillel@feldart.com" },
      FROM,
      TO,
    );

    expect(report.inboxUnavailable).toBe(false);
    expect(report.subject.inboxMemberId).toBe("tm-7");
    // Sessionized: combined has two clusters >15min apart — the 09:00–09:02
    // cluster (finance+inbox pings) and the 11:00 cluster — each floored to the
    // 3-min minimum → 6 min total. Finance alone = the one 09:00 cluster (3 min);
    // inbox alone = two clusters (09:01 + 11:00) → 6 min.
    expect(report.activeTime.totalMinutes).toBe(6);
    expect(report.activeTime.financeMinutes).toBe(3);
    expect(report.activeTime.inboxMinutes).toBe(6);
    // 2026-06-29 has presence pings → exact, not estimated.
    expect(report.activeTime.estimatedDays).toEqual([]);
    // counts fold in inbox tasks + inbox emails.
    expect(report.counts.emailsSent).toBe(1);
    expect(report.counts.inboxEmailsSent).toBe(4);
    expect(report.counts.tasksCompleted).toBe(2);
    expect(report.counts.tasksCreated).toBe(3);
    // timeline carries both finance + inbox events.
    const ids = report.days.flatMap((d) => d.events.map((e) => e.id));
    expect(ids).toContain("email-1");
    expect(ids).toContain("inbox-ix");
  });

  it("degrades gracefully when the inbox fetch throws", async () => {
    resolveMemberMock.mockResolvedValue({ teamMemberId: "tm-7" });
    inboxFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const report = await buildTeamActivityReport(
      { userId: "u1", name: "Hillel", email: "hillel@feldart.com" },
      FROM,
      TO,
    );

    expect(report.inboxUnavailable).toBe(true);
    // Finance-only: the single 09:00–09:02 cluster, floored to 3 min.
    expect(report.activeTime.totalMinutes).toBe(3);
    expect(report.counts.inboxEmailsSent).toBe(0);
    expect(report.counts.tasksCompleted).toBe(0);
    expect(report.days.flatMap((d) => d.events.map((e) => e.id))).toContain("email-1");
  });

  it("is finance-only (not 'unavailable') when the user has no inbox identity", async () => {
    resolveMemberMock.mockResolvedValue(null);

    const report = await buildTeamActivityReport(
      { userId: "u1", name: "Solo", email: "solo@feldart.com" },
      FROM,
      TO,
    );

    expect(report.subject.inboxMemberId).toBeNull();
    expect(report.inboxUnavailable).toBe(false);
    expect(inboxFetchMock).not.toHaveBeenCalled();
    expect(report.activeTime.totalMinutes).toBe(3);
  });

  it("folds clocked timesheet into the report + timeline, separate from active time", async () => {
    resolveMemberMock.mockResolvedValue(null);
    clockedMock.mockResolvedValue({
      clockedMinutes: 480,
      perDayMinutes: { "2026-06-29": 480 },
      openSessionStale: true,
      events: [
        {
          id: "clock-in-s1",
          at: "2026-06-29T08:00:00.000Z",
          source: "finance",
          type: "action",
          title: "Clocked in",
          detail: "started 09:00",
          link: null,
        },
      ],
    });

    const report = await buildTeamActivityReport(
      { userId: "u1", name: "Hillel", email: "hillel@feldart.com" },
      FROM,
      TO,
    );

    // Clocked summary present + separate from activeTime (which stays 3 min).
    expect(report.clocked.clockedMinutes).toBe(480);
    expect(report.clocked.openStale).toBe(true);
    expect(report.clocked.perDayMinutes).toEqual({ "2026-06-29": 480 });
    expect(report.activeTime.totalMinutes).toBe(3);
    // The clock-in row joins the timeline.
    expect(report.days.flatMap((d) => d.events.map((e) => e.id))).toContain("clock-in-s1");
    expect(clockedMock).toHaveBeenCalledWith("u1", FROM, TO);
  });
});
