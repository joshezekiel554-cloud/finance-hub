import { describe, expect, it } from "vitest";
import {
  activeMinutesPerDay,
  auditActionTitle,
  auditEventType,
  extensionsForUser,
  formatTalkTime,
  eventsToSignals,
  groupEventsByDay,
  londonDayKey,
  londonDayKeyForMinute,
  minutesToSignals,
  parseExtensionUserMap,
  sessionizedMinutes,
  unionActiveMinutes,
} from "./helpers.js";
import type { ActivityEvent } from "./types.js";

describe("parseExtensionUserMap", () => {
  it("parses a valid map", () => {
    expect(parseExtensionUserMap('{"102":"u1","103":"u2"}')).toEqual({
      "102": "u1",
      "103": "u2",
    });
  });

  it("returns {} for blank / null / undefined", () => {
    expect(parseExtensionUserMap("")).toEqual({});
    expect(parseExtensionUserMap("   ")).toEqual({});
    expect(parseExtensionUserMap(null)).toEqual({});
    expect(parseExtensionUserMap(undefined)).toEqual({});
  });

  it("returns {} for malformed JSON and non-object JSON", () => {
    expect(parseExtensionUserMap("{not json")).toEqual({});
    expect(parseExtensionUserMap("[1,2,3]")).toEqual({});
    expect(parseExtensionUserMap('"a string"')).toEqual({});
  });

  it("drops entries whose value is not a non-empty string", () => {
    expect(parseExtensionUserMap('{"102":"u1","103":42,"104":"","105":null}')).toEqual({
      "102": "u1",
    });
  });
});

describe("extensionsForUser", () => {
  it("inverts the map and returns all extensions a user owns", () => {
    const map = { "102": "u1", "103": "u2", "104": "u1" };
    expect(extensionsForUser(map, "u1").sort()).toEqual(["102", "104"]);
    expect(extensionsForUser(map, "u2")).toEqual(["103"]);
    expect(extensionsForUser(map, "nobody")).toEqual([]);
  });
});

describe("auditActionTitle + auditEventType", () => {
  it("maps known actions to friendly titles", () => {
    expect(auditActionTitle("order.hold_started")).toBe("Placed hold on order");
    expect(auditActionTitle("statement.send")).toBe("Sent statement");
    expect(auditActionTitle("rma.completed")).toBe("Completed return");
  });

  it("humanizes unknown actions instead of leaving raw strings", () => {
    expect(auditActionTitle("origin_review.invoice.override")).toBe(
      "Origin review invoice override",
    );
  });

  it("buckets sends vs actions", () => {
    expect(auditEventType("statement.send")).toBe("send");
    expect(auditEventType("invoice.send")).toBe("send");
    expect(auditEventType("order.hold_started")).toBe("action");
    expect(auditEventType("rma.completed")).toBe("action");
  });
});

describe("unionActiveMinutes (dedupe across both apps)", () => {
  it("unions and de-duplicates overlapping minutes", () => {
    const finance = [100, 101, 102, 105];
    const inbox = [102, 105, 106, 107];
    // Overlap (102, 105) counted once → 6 distinct minutes, sorted.
    expect(unionActiveMinutes(finance, inbox)).toEqual([100, 101, 102, 105, 106, 107]);
  });

  it("handles empty inputs", () => {
    expect(unionActiveMinutes([], [])).toEqual([]);
    expect(unionActiveMinutes([1, 1, 2], [])).toEqual([1, 2]);
  });
});

describe("sessionizedMinutes (continuous-work sessions)", () => {
  const M = Math.floor(Date.parse("2026-06-29T09:00:00.000Z") / 60_000);
  const iso = (min: number) => new Date(min * 60_000).toISOString();

  it("bridges a gap ≤15 min into one continuous session", () => {
    // pings 10 min apart → the 10-min gap is bridged → 11 contiguous minutes.
    expect(sessionizedMinutes(minutesToSignals([M, M + 10]))).toHaveLength(11);
  });

  it("breaks a gap >15 min into separate sessions (each min-credit 3 min)", () => {
    // 20 min apart → two sessions, each floored to the 3-min minimum.
    expect(sessionizedMinutes(minutesToSignals([M, M + 20]))).toHaveLength(6);
  });

  it("gives a lone instant signal the ~3-min minimum credit", () => {
    expect(sessionizedMinutes(eventsToSignals([{ at: iso(M) }]))).toHaveLength(3);
  });

  it("counts a call's full duration as active work", () => {
    // a 10-minute call (no other signals) = ~10 active minutes.
    expect(
      sessionizedMinutes(eventsToSignals([{ at: iso(M), durationSec: 600 }])),
    ).toHaveLength(10);
  });

  it("returns nothing for no signals", () => {
    expect(sessionizedMinutes([])).toEqual([]);
  });
});

describe("Europe/London day grouping", () => {
  it("keys an instant to its London calendar day", () => {
    // 2026-06-29 23:30 UTC = 00:30 BST on 2026-06-30 (London is UTC+1 in summer).
    expect(londonDayKey("2026-06-29T23:30:00.000Z")).toBe("2026-06-30");
    expect(londonDayKey("2026-06-29T08:00:00.000Z")).toBe("2026-06-29");
  });

  it("keys an epoch-minute to its London day", () => {
    const minute = Math.floor(Date.parse("2026-06-29T23:30:00.000Z") / 60_000);
    expect(londonDayKeyForMinute(minute)).toBe("2026-06-30");
  });

  it("rolls active minutes up per London day", () => {
    const base = Math.floor(Date.parse("2026-06-29T08:00:00.000Z") / 60_000);
    // 3 minutes on the 29th + a duplicate (deduped) + 1 minute that crosses to the 30th.
    const lateNight = Math.floor(Date.parse("2026-06-29T23:30:00.000Z") / 60_000);
    const perDay = activeMinutesPerDay([base, base + 1, base + 2, base + 2, lateNight]);
    expect(perDay["2026-06-29"]).toBe(3);
    expect(perDay["2026-06-30"]).toBe(1);
  });
});

describe("groupEventsByDay", () => {
  const evAt = (id: string, at: string): ActivityEvent => ({
    id,
    at,
    source: "finance",
    type: "email_sent",
    title: id,
  });

  it("groups newest day first, newest event first within a day", () => {
    const events = [
      evAt("a", "2026-06-29T08:00:00.000Z"),
      evAt("b", "2026-06-29T10:00:00.000Z"),
      evAt("c", "2026-06-28T09:00:00.000Z"),
    ];
    const days = groupEventsByDay(events, { "2026-06-29": 120, "2026-06-28": 60 });
    expect(days.map((d) => d.day)).toEqual(["2026-06-29", "2026-06-28"]);
    expect(days[0]?.events.map((e) => e.id)).toEqual(["b", "a"]);
    expect(days[0]?.activeMinutes).toBe(120);
  });

  it("includes days that have active minutes but no events", () => {
    const days = groupEventsByDay([], { "2026-06-27": 45 });
    expect(days).toHaveLength(1);
    expect(days[0]?.day).toBe("2026-06-27");
    expect(days[0]?.events).toEqual([]);
    expect(days[0]?.activeMinutes).toBe(45);
  });
});

describe("formatTalkTime", () => {
  it("renders mm:ss with zero padding", () => {
    expect(formatTalkTime(0)).toBe("0:00");
    expect(formatTalkTime(5)).toBe("0:05");
    expect(formatTalkTime(125)).toBe("2:05");
    expect(formatTalkTime(null)).toBe("0:00");
    expect(formatTalkTime(undefined)).toBe("0:00");
  });
});
