import { describe, expect, it } from "vitest";
import { activePromise, formatPromiseDate, promiseLine } from "./customer-promise";

const NOW = new Date("2026-11-19T22:00:00Z");

describe("activePromise", () => {
  it("is active through the promised day and gone the day after", () => {
    expect(activePromise({ promisedPayBy: "2026-11-19" }, NOW)?.date).toBe("2026-11-19");
    expect(activePromise({ promisedPayBy: "2026-11-18" }, NOW)).toBeNull();
    expect(activePromise({ promisedPayBy: null }, NOW)).toBeNull();
    expect(activePromise({}, NOW)).toBeNull();
  });

  it("carries the note and who set it", () => {
    expect(
      activePromise({ promisedPayBy: "2026-11-21", promiseNote: "  wire Friday ", promiseSetBy: "josh@x.com" }, NOW),
    ).toEqual({ date: "2026-11-21", note: "wire Friday", setBy: "josh@x.com", setAt: null });
  });
});

describe("promiseLine", () => {
  it("reads naturally with and without the optional parts", () => {
    expect(formatPromiseDate("2026-11-21")).toBe("Sat 21 Nov 2026");
    expect(promiseLine({ date: "2026-11-21", note: "wire Friday", setBy: "josh@x.com", setAt: null })).toBe(
      "Promised to pay by Sat 21 Nov 2026 — wire Friday — set by josh@x.com via hub",
    );
    expect(promiseLine({ date: "2026-11-21", note: null, setBy: null, setAt: null })).toBe(
      "Promised to pay by Sat 21 Nov 2026",
    );
  });
});
