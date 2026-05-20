import { describe, it, expect } from "vitest";
import { toSystemParam } from "./system-param.js";

describe("toSystemParam", () => {
  it("returns undefined for empty/whitespace system text", () => {
    expect(toSystemParam("")).toBeUndefined();
    expect(toSystemParam("   \n ")).toBeUndefined();
  });

  it("wraps non-empty text in one text block (cache_control deferred to Wave B/C)", () => {
    const out = toSystemParam("ROLE + GUIDE");
    expect(out).toEqual([{ type: "text", text: "ROLE + GUIDE" }]);
  });
});
