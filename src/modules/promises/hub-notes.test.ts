import { describe, expect, it } from "vitest";
import { addHubNote, cleanHubNote, customerIdFromSignalKey, type HubNoteDeps } from "./hub-notes.js";
import type { RecordActivityInput } from "../crm/activity-ingester.js";

describe("customerIdFromSignalKey", () => {
  it("reads the customer id from finance.<kind>.<customerId>.<rest>", () => {
    expect(customerIdFromSignalKey("finance.chase-no-reply.Ab_c-1.msg1")).toBe("Ab_c-1");
    expect(customerIdFromSignalKey("finance.promise-missed.cust2.2026-11-14")).toBe("cust2");
    expect(customerIdFromSignalKey("finance.promise-missed.cust2")).toBe("cust2");
  });

  it("refuses anything that isn't a finance key", () => {
    expect(customerIdFromSignalKey("inbox.thread.abc.def")).toBeNull();
    expect(customerIdFromSignalKey("finance.chase-no-reply")).toBeNull();
    expect(customerIdFromSignalKey("finance..cust1.x")).toBeNull();
    expect(customerIdFromSignalKey("finance.k.has space.x")).toBeNull();
    expect(customerIdFromSignalKey(`finance.k.${"a".repeat(25)}.x`)).toBeNull();
    expect(customerIdFromSignalKey(42)).toBeNull();
  });
});

describe("cleanHubNote", () => {
  it("trims and enforces 1-1000 chars", () => {
    expect(cleanHubNote("  hi  ")).toBe("hi");
    expect(cleanHubNote("   ")).toBeNull();
    expect(cleanHubNote("x".repeat(1000))).toHaveLength(1000);
    expect(cleanHubNote("x".repeat(1001))).toBeNull();
    expect(cleanHubNote(null)).toBeNull();
  });
});

function deps(existing: string[] = [], exists = true) {
  const recorded: RecordActivityInput[] = [];
  const d: HubNoteDeps = {
    customerExists: async () => exists,
    existingHubNotes: async () => existing,
    actorName: async () => ({ userId: "u-shaya", name: "Shaya" }),
    recordActivity: async (input) => {
      recorded.push(input);
      return "act1";
    },
  };
  return { d, recorded };
}

describe("addHubNote", () => {
  it("writes a team-only timeline note naming the hub person", async () => {
    const { d, recorded } = deps();
    const res = await addHubNote({ customerId: "c1", note: "Cheque in the post", actorEmail: "info@x.com", signalKey: "finance.chase-no-reply.c1.m1" }, d);
    expect(res).toEqual({ ok: true, changed: true, customerId: "c1", activityId: "act1" });
    expect(recorded[0]).toMatchObject({
      customerId: "c1",
      kind: "manual_note",
      userId: "u-shaya",
      body: "Note from hub (Shaya): Cheque in the post",
      refType: "hub_note",
      meta: { source: "hub", note: "Cheque in the post", setBy: "info@x.com" },
    });
  });

  it("is a no-op when the identical note already came from the hub", async () => {
    const { d, recorded } = deps(["Cheque in the post"]);
    const res = await addHubNote({ customerId: "c1", note: "Cheque in the post", actorEmail: "info@x.com", signalKey: "k" }, d);
    expect(res).toEqual({ ok: true, changed: false, customerId: "c1", activityId: null });
    expect(recorded).toHaveLength(0);
  });

  it("reports an unknown customer", async () => {
    const { d } = deps([], false);
    expect(await addHubNote({ customerId: "zz", note: "x", actorEmail: "a@x.com", signalKey: "k" }, d)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });
});
