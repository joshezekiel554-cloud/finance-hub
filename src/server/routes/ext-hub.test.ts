import { describe, expect, it } from "vitest";
import { ageLabel, buildNeedsYou, type NeedsYouCandidate } from "./ext-hub.js";

// The hub's Home shows one cross-app "Needs you" list. Finance contributes
// up to five items in the hub's contract (inbox agent, 2026-09-14 15:36):
//   { id, kind: decision|bounce|return|hold, title, detail, age, urgency: now|today, url }
// ordered most urgent first, then oldest first within an urgency.

const NOW = new Date("2026-09-14T15:00:00.000Z");

const cand = (over: Partial<NeedsYouCandidate>): NeedsYouCandidate => ({
  id: "x",
  kind: "hold",
  title: "t",
  detail: null,
  url: "https://finance.feldart.com/",
  urgency: "now",
  since: new Date("2026-09-14T10:00:00.000Z"),
  ...over,
});

describe("buildNeedsYou", () => {
  it("orders now before today, then oldest first, and emits the contract shape", () => {
    const out = buildNeedsYou(
      [
        cand({ id: "a", title: "today-new", urgency: "today", since: new Date("2026-09-14T14:00:00.000Z") }),
        cand({ id: "b", title: "now-new", urgency: "now", since: new Date("2026-09-14T14:00:00.000Z") }),
        cand({ id: "c", title: "now-old", urgency: "now", since: new Date("2026-09-08T14:00:00.000Z"), kind: "decision" }),
      ],
      NOW,
    );
    expect(out.map((i) => i.title)).toEqual(["now-old", "now-new", "today-new"]);
    expect(out[0]).toEqual({
      id: "c",
      kind: "decision",
      title: "now-old",
      detail: null,
      age: "6d",
      // ISO twin of `age` so the hub can sort a merged inbox+finance list.
      at: "2026-09-08T14:00:00.000Z",
      urgency: "now",
      url: "https://finance.feldart.com/",
    });
  });

  it("caps at five", () => {
    const many = Array.from({ length: 9 }, (_, i) => cand({ id: `t${i}` }));
    expect(buildNeedsYou(many, NOW)).toHaveLength(5);
  });
});

describe("ageLabel", () => {
  it("renders compact human ages", () => {
    expect(ageLabel(new Date("2026-09-14T14:46:00.000Z"), NOW)).toBe("14m");
    expect(ageLabel(new Date("2026-09-14T12:00:00.000Z"), NOW)).toBe("3h");
    expect(ageLabel(new Date("2026-09-08T15:00:00.000Z"), NOW)).toBe("6d");
    expect(ageLabel(new Date("2026-09-14T15:00:00.000Z"), NOW)).toBe("now");
  });
});
