import { describe, expect, it } from "vitest";
import { parseHubEmbeddedCookie, hubNavigateMessage } from "./hub-embed.js";

// Repo has no DOM test env; the cookie/message logic is kept as plain
// functions so it can be tested here, and the React glue stays thin.

describe("parseHubEmbeddedCookie", () => {
  it("is true only when hub_embedded=1 is present", () => {
    expect(parseHubEmbeddedCookie("a=1; hub_embedded=1; b=2")).toBe(true);
    expect(parseHubEmbeddedCookie("hub_embedded=1")).toBe(true);
  });
  it("is false otherwise", () => {
    expect(parseHubEmbeddedCookie("")).toBe(false);
    expect(parseHubEmbeddedCookie("hub_embedded=0")).toBe(false);
    expect(parseHubEmbeddedCookie("nothub_embedded=1")).toBe(false);
    expect(parseHubEmbeddedCookie(undefined)).toBe(false);
  });
});

describe("hubNavigateMessage", () => {
  it("shapes the postMessage the hub expects", () => {
    expect(hubNavigateMessage("/customers/abc?tab=orders")).toEqual({
      type: "hub:navigate",
      path: "/customers/abc?tab=orders",
    });
  });
});
