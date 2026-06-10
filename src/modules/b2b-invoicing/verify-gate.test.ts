import { describe, expect, it } from "vitest";
import { checkVerifyGate, deriveFlaggedRemoves } from "./verify-gate.js";
import type { ReconcileAction } from "./types.js";

function remove(lineId: string, sku: string, qty = 5): ReconcileAction {
  return { type: "remove", lineId, sku, qty, reason: "not_shipped" };
}

function keep(lineId: string, sku: string, qty = 5): ReconcileAction {
  return { type: "keep", lineId, sku, qty };
}

function qtyChange(lineId: string, sku: string): ReconcileAction {
  return {
    type: "qty_change",
    lineId,
    sku,
    fromQty: 5,
    toQty: 0,
    reason: "split_zero",
  };
}

describe("deriveFlaggedRemoves", () => {
  it("flags each remove action by lineId + sku", () => {
    const flagged = deriveFlaggedRemoves([
      keep("1", "AAA"),
      remove("2", "BBB"),
      remove("3", "CCC"),
    ]);
    expect(flagged).toEqual([
      { lineId: "2", sku: "BBB" },
      { lineId: "3", sku: "CCC" },
    ]);
  });

  it("never flags keep / qty_change / add / set_metadata actions", () => {
    const actions: ReconcileAction[] = [
      keep("1", "AAA"),
      qtyChange("2", "BBB"),
      { type: "add", sku: "CCC", qty: 1, unitPrice: 10, priceSource: "shopify_b2b" },
      {
        type: "set_metadata",
        trackingNumber: "1Z",
        shipVia: "UPS",
        shipDate: "2026-06-01",
      },
    ];
    expect(deriveFlaggedRemoves(actions)).toEqual([]);
  });

  it("dedupes duplicate-SKU removes to the LAST lineId (case-insensitive), matching the UI's one-checkbox-per-SKU collapse", () => {
    const flagged = deriveFlaggedRemoves([
      remove("10", "abc-1"),
      keep("11", "OTHER"),
      remove("12", "ABC-1"),
    ]);
    // Only the last remove for the SKU is flagged — the UI renders exactly
    // one verify checkbox for it.
    expect(flagged).toEqual([{ lineId: "12", sku: "ABC-1" }]);
  });
});

describe("checkVerifyGate", () => {
  // (a) flagged remove not covered by verifiedRemoveLineIds → rejected,
  // message names the SKU(s).
  it("rejects an unverified flagged remove and names the SKU", () => {
    const result = checkVerifyGate({
      actions: [keep("1", "AAA"), remove("2", "BBB-42")],
      unparsedRows: [],
      verifiedRemoveLineIds: [],
      unreadAck: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toContain("BBB-42");
    expect(result.unverifiedRemoves).toEqual([{ lineId: "2", sku: "BBB-42" }]);
    expect(result.unacknowledgedUnreadRows).toEqual([]);
  });

  it("names every uncovered SKU when several removes are unverified", () => {
    const result = checkVerifyGate({
      actions: [remove("2", "BBB"), remove("3", "CCC"), remove("4", "DDD")],
      unparsedRows: [],
      verifiedRemoveLineIds: ["3"],
      unreadAck: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toContain("BBB");
    expect(result.error).toContain("DDD");
    expect(result.error).not.toContain("CCC");
  });

  // (b) unparsedRows present and unreadAck !== true → rejected.
  it("rejects when unparsed rows exist and unreadAck is false", () => {
    const result = checkVerifyGate({
      actions: [keep("1", "AAA")],
      unparsedRows: ["XYZ — ?", "QQQ — n/a"],
      verifiedRemoveLineIds: [],
      unreadAck: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unverifiedRemoves).toEqual([]);
    expect(result.unacknowledgedUnreadRows).toEqual(["XYZ — ?", "QQQ — n/a"]);
    expect(result.error).toContain("2 unreadable rows");
  });

  // (c) fully covered → proceeds.
  it("passes when all flagged removes are verified and unread rows are acknowledged", () => {
    const result = checkVerifyGate({
      actions: [remove("2", "BBB"), remove("3", "CCC")],
      unparsedRows: ["XYZ — ?"],
      verifiedRemoveLineIds: ["2", "3"],
      unreadAck: true,
    });
    expect(result).toEqual({ ok: true });
  });

  it("passes with no flags at all (no removes, clean parse)", () => {
    const result = checkVerifyGate({
      actions: [keep("1", "AAA"), qtyChange("2", "BBB")],
      unparsedRows: [],
      verifiedRemoveLineIds: [],
      unreadAck: false,
    });
    expect(result).toEqual({ ok: true });
  });

  // (d) removes that are NOT flagged (earlier duplicate-SKU removes) require
  // no verification — verifying only the last lineId per SKU is enough.
  it("requires verification only for the last duplicate-SKU remove (the one the UI shows)", () => {
    const actions = [remove("10", "abc"), remove("12", "ABC")];
    // Verifying only the LAST lineId (the one with the checkbox) passes.
    expect(
      checkVerifyGate({
        actions,
        unparsedRows: [],
        verifiedRemoveLineIds: ["12"],
        unreadAck: false,
      }),
    ).toEqual({ ok: true });
    // Verifying only the earlier (collapsed-away) lineId does NOT.
    const result = checkVerifyGate({
      actions,
      unparsedRows: [],
      verifiedRemoveLineIds: ["10"],
      unreadAck: false,
    });
    expect(result.ok).toBe(false);
  });

  it("ignores extra/stale verified ids", () => {
    const result = checkVerifyGate({
      actions: [remove("2", "BBB")],
      unparsedRows: [],
      verifiedRemoveLineIds: ["2", "stale-id-from-keep-instead"],
      unreadAck: false,
    });
    expect(result).toEqual({ ok: true });
  });

  it("unreadAck alone does not cover unverified removes", () => {
    const result = checkVerifyGate({
      actions: [remove("2", "BBB")],
      unparsedRows: [],
      verifiedRemoveLineIds: [],
      unreadAck: true,
    });
    expect(result.ok).toBe(false);
  });
});
