import { describe, expect, it } from "vitest";
import { csvFilename, reportToCsv } from "./csv.js";
import type { TeamActivityReport } from "./types.js";

const REPORT: TeamActivityReport = {
  subject: { userId: "u1", name: "Hillel Schijves", email: "hillel@feldart.com", inboxMemberId: "tm-1" },
  range: { from: "2026-06-22T00:00:00.000Z", to: "2026-06-29T00:00:00.000Z" },
  counts: {
    emailsSent: 0,
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
          id: "e1",
          at: "2026-06-29T08:14:00.000Z",
          source: "inbox",
          type: "email_sent",
          title: 'Replied to Smiths — "Re: Invoice #1043, overdue"',
          detail: "outbound reply",
          customerName: 'Smith "Bros"',
        },
        {
          id: "e2",
          at: "2026-06-29T09:31:00.000Z",
          source: "finance",
          type: "call",
          title: "Outbound call · Jones · 6:12",
          detail: null,
          customerName: null,
        },
      ],
    },
  ],
  inboxUnavailable: false,
};

describe("reportToCsv", () => {
  it("emits a header row + one row per event", () => {
    const csv = reportToCsv(REPORT);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 events
    expect(lines[0]).toBe("date,time,source,type,title,detail,customer");
  });

  it("quotes fields with commas and escapes embedded quotes", () => {
    const csv = reportToCsv(REPORT);
    // title with comma → quoted; embedded quotes in "Bros" → doubled.
    expect(csv).toContain('"Replied to Smiths — ""Re: Invoice #1043, overdue"""');
    expect(csv).toContain('"Smith ""Bros"""');
  });

  it("renders empty cells for null detail/customer", () => {
    const csv = reportToCsv(REPORT);
    const lines = csv.trim().split("\r\n");
    // Second event has null detail + customer → two trailing empty fields.
    expect(lines[2]?.endsWith(",,")).toBe(true);
  });

  it("renders date in Europe/London", () => {
    const csv = reportToCsv(REPORT);
    expect(csv).toContain("2026-06-29");
  });
});

describe("csvFilename", () => {
  it("slugifies the subject name + range", () => {
    expect(csvFilename(REPORT)).toBe("team-activity-hillel-schijves-2026-06-22_to_2026-06-29.csv");
  });

  it("falls back to email then userId when name is absent", () => {
    const noName = { ...REPORT, subject: { ...REPORT.subject, name: null } };
    expect(csvFilename(noName)).toContain("hillel-feldart-com");
  });
});
