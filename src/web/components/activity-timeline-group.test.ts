import { describe, expect, it } from "vitest";
import {
  groupActivitiesByDay,
  formatDayLabel,
} from "./activity-timeline-group.js";

const mk = (id: string, iso: string) => ({ id, occurredAt: iso });

describe("groupActivitiesByDay", () => {
  it("buckets by local day, newest day first, newest item first", () => {
    const a = mk("a", "2026-05-13T16:30:00Z");
    const b = mk("b", "2026-05-12T18:00:00Z");
    const c = mk("c", "2026-05-12T12:00:00Z");
    const groups = groupActivitiesByDay([c, a, b]);
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-05-13", "2026-05-12"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["a"]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("returns [] for empty input", () => {
    expect(groupActivitiesByDay([])).toEqual([]);
  });
});

describe("formatDayLabel", () => {
  const now = new Date("2026-05-13T10:00:00Z").getTime();

  it("labels today and yesterday relative to now", () => {
    expect(formatDayLabel("2026-05-13T16:30:00Z", now)).toBe("Today");
    expect(formatDayLabel("2026-05-12T18:00:00Z", now)).toBe("Yesterday");
  });

  it("labels older dates with weekday + day + month", () => {
    expect(formatDayLabel("2026-05-06T12:00:00Z", now)).toMatch(/May/);
  });
});
