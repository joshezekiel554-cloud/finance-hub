import { describe, expect, it } from "vitest";
import { buildNeedsYou, type NeedsYouItem } from "./ext-hub.js";

// The hub's Home shows one cross-app "Needs you" list. Finance contributes
// up to five items, most urgent first, then oldest first within a severity.

const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
  kind: "hold",
  title: "t",
  subtitle: null,
  path: "/",
  severity: "todo",
  since: "2026-09-14T10:00:00.000Z",
  ...over,
});

describe("buildNeedsYou", () => {
  it("orders by severity (todo > in-progress > waiting) then by age, oldest first", () => {
    const out = buildNeedsYou([
      item({ title: "waiting-new", severity: "waiting", since: "2026-09-14T12:00:00.000Z" }),
      item({ title: "todo-new", severity: "todo", since: "2026-09-14T12:00:00.000Z" }),
      item({ title: "prog", severity: "in-progress", since: "2026-09-13T12:00:00.000Z" }),
      item({ title: "todo-old", severity: "todo", since: "2026-09-08T12:00:00.000Z" }),
    ]);
    expect(out.map((i) => i.title)).toEqual(["todo-old", "todo-new", "prog", "waiting-new"]);
  });

  it("caps at five", () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ title: `t${i}` }));
    expect(buildNeedsYou(many)).toHaveLength(5);
  });
});
