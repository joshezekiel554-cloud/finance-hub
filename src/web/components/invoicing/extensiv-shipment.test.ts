import { describe, expect, it } from "vitest";
import {
  addSkusNeedingReference,
  formatRetail,
  isNonShopifyShipment,
  noMatchExplanation,
  retailTooltip,
  shippingLabel,
  shippingTooltip,
  shouldShowExtensivPanel,
  transactionNumbersFor,
  uniqueSkus,
  type ExtensivRowShape,
} from "./extensiv-shipment";

function row(over: Partial<ExtensivRowShape["parsed"]> & {
  qbInvoice?: unknown;
  reconcileResult?: unknown;
} = {}): ExtensivRowShape {
  const { qbInvoice = null, reconcileResult = null, ...parsed } = over;
  return {
    parsed: {
      poNumber: "MERKAZleathers",
      shopifyOrderNumber: null,
      transactionNumber: "120003",
      lineItems: [
        { sku: "FTL03G-leather", quantity: "2.00" },
        { sku: "FTL03S-Leather", quantity: "2.00" },
      ],
      ...parsed,
    },
    qbInvoice,
    reconcileResult,
  };
}

describe("isNonShopifyShipment / noMatchExplanation", () => {
  it("treats a reference without the SHOP prefix as not a Shopify order", () => {
    const r = row();
    expect(isNonShopifyShipment(r)).toBe(true);
    expect(noMatchExplanation(r)).toBe(
      "Not a Shopify order (reference MERKAZleathers), so there's no QB invoice to match automatically.",
    );
  });

  it("omits the reference when the PO is missing", () => {
    expect(noMatchExplanation(row({ poNumber: null }))).toBe(
      "Not a Shopify order, so there's no QB invoice to match automatically.",
    );
  });

  it("names the order for a Shopify shipment with no QB invoice", () => {
    const r = row({ poNumber: "SHOP18301", shopifyOrderNumber: "18301" });
    expect(isNonShopifyShipment(r)).toBe(false);
    expect(noMatchExplanation(r)).toBe("No QB invoice found for order 18301.");
  });
});

describe("shouldShowExtensivPanel", () => {
  it("shows when there is no reconcile table", () => {
    expect(shouldShowExtensivPanel(row())).toBe(true);
    expect(shouldShowExtensivPanel(row({ qbInvoice: {} }))).toBe(true);
  });
  it("hides when the reconcile table already lists the shipment", () => {
    expect(shouldShowExtensivPanel(row({ qbInvoice: {}, reconcileResult: {} }))).toBe(false);
  });
});

describe("addSkusNeedingReference / uniqueSkus", () => {
  it("returns distinct SKUs of add actions only", () => {
    expect(
      addSkusNeedingReference([
        { type: "keep", sku: "A" },
        { type: "add", sku: "B" },
        { type: "add", sku: "b" },
        { type: "remove", sku: "C" },
        { type: "add", sku: "D" },
        { type: "set_metadata" },
      ]),
    ).toEqual(["B", "D"]);
  });
  it("skips blanks", () => {
    expect(uniqueSkus(["", null, undefined, " x ", "X"])).toEqual(["x"]);
  });
});

describe("shippingLabel / shippingTooltip / transactionNumbersFor", () => {
  const billed = {
    transactionNumber: "120003",
    reference: "MERKAZleathers",
    shipping: 6.87,
    lines: [
      { label: "Small Parcel Ship", amount: 6.87 },
      { label: "Picks", amount: 4 },
    ],
    totalCharges: 10.87,
    carrierService: "Fedex Smartpost Parcel Select",
    carrierRate: 6.13,
  };
  it("labels billed, unbilled and freight-less shipments", () => {
    expect(shippingLabel(billed)).toBe("Shipping $6.87");
    expect(shippingLabel({ ...billed, shipping: null, totalCharges: null, lines: [] })).toBe(
      "Shipping: not billed yet",
    );
    expect(shippingLabel({ ...billed, shipping: null })).toBe("Shipping: no freight charge");
    expect(shippingLabel(undefined)).toBeNull();
  });
  it("breaks the charges down on hover", () => {
    expect(shippingTooltip(billed)).toBe(
      "Extensiv / Blue Chip:\nSmall Parcel Ship $6.87\nPicks $4.00\nTotal Blue Chip charges $10.87\nCarrier rate (Fedex Smartpost Parcel Select) $6.13",
    );
    expect(shippingTooltip(undefined)).toBeUndefined();
  });
  it("collects numeric, distinct, sorted transaction numbers", () => {
    expect(
      transactionNumbersFor([
        { parsed: { transactionNumber: "120232" } },
        { parsed: { transactionNumber: "120003" } },
        { parsed: { transactionNumber: "120003" } },
        { parsed: { transactionNumber: null } },
        { parsed: { transactionNumber: "abc" } },
      ]),
    ).toEqual(["120003", "120232"]);
  });
});

describe("formatRetail / retailTooltip", () => {
  const hit = {
    sku: "PHCR01G",
    price: 76,
    compareAtPrice: 90,
    productTitle: "Classic Round Pan Holder",
    variantTitle: "Gold",
    productStatus: "DRAFT",
  };
  it("formats a price or a dash", () => {
    expect(formatRetail(hit)).toBe("$76.00");
    expect(formatRetail(undefined)).toBe("—");
  });
  it("describes the match", () => {
    expect(retailTooltip(hit)).toBe(
      "Classic Round Pan Holder – Gold · compare-at $90.00 · draft",
    );
    expect(retailTooltip(undefined)).toBe("Not found in the Shopify catalogue");
  });
});
