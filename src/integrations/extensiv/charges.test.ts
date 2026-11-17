import { describe, expect, it } from "vitest";
import { summarizeCharges } from "./charges.js";
import type { ExtensivOrder } from "./client.js";

// Shape copied from real order 120003 (MERKAZleathers), 2026-11-12.
const merkaz: ExtensivOrder = {
  readOnly: { orderId: 120003 },
  referenceNum: "MERKAZleathers",
  billing: {
    billingCharges: [
      { chargeType: 3, subtotal: 6.87, details: [{ numUnits: 1, chargeLabel: "Small Parcel Ship", chargePerUnit: 6.87 }] },
      {
        chargeType: 1,
        subtotal: 6.5,
        details: [
          { numUnits: 1, chargeLabel: "Order Fee - Ecom", chargePerUnit: 2.5 },
          { numUnits: 4, chargeLabel: "Picks", chargePerUnit: 1 },
        ],
      },
      { chargeType: 6, subtotal: 0.73, details: [{ numUnits: 1, chargeLabel: "Materials Used", chargePerUnit: 0.732 }] },
    ],
  },
  parcelOption: {
    chosenRate: JSON.stringify({ serviceName: "Fedex Smartpost Parcel Select", amounts: { shipping: 6.13, total: 6.13 } }),
  },
};

describe("summarizeCharges", () => {
  it("pulls the freight charge out as shipping and itemises the rest", () => {
    expect(summarizeCharges(merkaz)).toEqual({
      transactionNumber: "120003",
      reference: "MERKAZleathers",
      shipping: 6.87,
      lines: [
        { label: "Small Parcel Ship", amount: 6.87 },
        { label: "Order Fee - Ecom", amount: 2.5 },
        { label: "Picks", amount: 4 },
        { label: "Materials Used", amount: 0.73 },
      ],
      totalCharges: 14.1,
      carrierService: "Fedex Smartpost Parcel Select",
      carrierRate: 6.13,
    });
  });

  it("returns null shipping/total when the order isn't billed yet", () => {
    const s = summarizeCharges({ readOnly: { orderId: 5 }, referenceNum: "SHOP1", billing: { billingCharges: [] } });
    expect(s?.shipping).toBeNull();
    expect(s?.totalCharges).toBeNull();
    expect(s?.lines).toEqual([]);
  });

  it("handles handling-only orders (no freight line)", () => {
    const s = summarizeCharges({
      readOnly: { orderId: 7 },
      billing: { billingCharges: [{ chargeType: 1, subtotal: 3.5, details: [{ numUnits: 1, chargeLabel: "Order Fee", chargePerUnit: 3.5 }] }] },
    });
    expect(s?.shipping).toBeNull();
    expect(s?.totalCharges).toBe(3.5);
  });

  it("tolerates a missing or malformed chosen rate", () => {
    const s = summarizeCharges({ readOnly: { orderId: 8 }, parcelOption: { chosenRate: "{not json" } });
    expect(s?.carrierRate).toBeNull();
    expect(s?.carrierService).toBeNull();
  });

  it("returns null without an order id", () => {
    expect(summarizeCharges({ referenceNum: "X" })).toBeNull();
  });
});
