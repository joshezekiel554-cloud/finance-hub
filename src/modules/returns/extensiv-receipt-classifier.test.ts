import { describe, expect, it } from "vitest";
import {
  classifyExtensivEmail,
  inferCustomerNameFromRef,
} from "./extensiv-receipt-classifier.js";

const EXTENSIV_FROM = "WMS Notifications <notifications@secure-wms.com>";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function outboundEmail() {
  return {
    from: EXTENSIV_FROM,
    subject: "requested transaction notification",
    body: `
PO Number: SHOP18301
Transaction Number: (99863)
We have shipped your order to your customer Acme Co via UPS.
Carrier: UPS
Tracking Number: 1Z0JF5830328583312
Ship Date: 4/27/2026
Shipping Cost:

Item\tQuantity
HCTOG01\t23.00
    `.trim(),
  };
}

function receiptWithSummaryAndItems() {
  return {
    from: EXTENSIV_FROM,
    subject: "Receipt Notification (12345)",
    body: `
Summary of the receipt for your records.
Ref: Acme Company Spring2026 returns

The following items have been received into the warehouse:
HCTOG01\t5
HCTOG02\t3
    `.trim(),
  };
}

function receiptWithInventoryMarker() {
  return {
    from: EXTENSIV_FROM,
    subject: "Inventory Receipt (67890)",
    body: `
We have put into inventory the returned merchandise as requested.
Ref: Best Boutique Summer2025 returns

SKU\tQty
FELD-001\t10
FELD-002\t2
    `.trim(),
  };
}

function receiptNoItemsNoRef() {
  return {
    from: EXTENSIV_FROM,
    subject: "Receipt (11111)",
    body: `
Summary of the receipt.
    `.trim(),
  };
}

function receiptTxInBodyOnly() {
  return {
    from: EXTENSIV_FROM,
    subject: "Receipt Notification",
    body: `
Summary of the receipt (54321).
Ref: Downtown Designs Fall2026 returns

Nothing parsed as items here — just prose text.
    `.trim(),
  };
}

function unknownSender() {
  return {
    from: "noreply@example.com",
    subject: "Summary of the receipt",
    body: "Summary of the receipt (999). Ref: Test returns",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifyExtensivEmail", () => {
  describe("unknown sender", () => {
    it("returns unknown + confidence=0 for non-Extensiv sender", () => {
      const result = classifyExtensivEmail(unknownSender());
      expect(result.direction).toBe("unknown");
      expect(result.confidence).toBe(0);
      expect(result.txNumber).toBeUndefined();
    });
  });

  describe("outbound shipment", () => {
    it("classifies a standard outbound shipment as outbound with confidence 1", () => {
      const result = classifyExtensivEmail(outboundEmail());
      expect(result.direction).toBe("outbound");
      expect(result.confidence).toBe(1.0);
      expect(result.parsedItems).toBeUndefined();
    });
  });

  describe("return_receipt via 'summary of the receipt'", () => {
    it("classifies a receipt with summary marker as return_receipt", () => {
      const result = classifyExtensivEmail(receiptWithSummaryAndItems());
      expect(result.direction).toBe("return_receipt");
    });

    it("parses txNumber from subject parens", () => {
      const result = classifyExtensivEmail(receiptWithSummaryAndItems());
      expect(result.txNumber).toBe("12345");
    });

    it("parses refString from body", () => {
      const result = classifyExtensivEmail(receiptWithSummaryAndItems());
      expect(result.refString).toBe("Acme Company Spring2026 returns");
    });

    it("parses line items from tab-separated body table", () => {
      const result = classifyExtensivEmail(receiptWithSummaryAndItems());
      expect(result.parsedItems).toEqual([
        { sku: "HCTOG01", quantity: 5 },
        { sku: "HCTOG02", quantity: 3 },
      ]);
    });

    it("returns confidence 1.0 when tx# + items are present", () => {
      const result = classifyExtensivEmail(receiptWithSummaryAndItems());
      expect(result.confidence).toBe(1.0);
    });
  });

  describe("return_receipt via 'put into inventory'", () => {
    it("classifies 'put into inventory' email as return_receipt", () => {
      const result = classifyExtensivEmail(receiptWithInventoryMarker());
      expect(result.direction).toBe("return_receipt");
    });

    it("parses txNumber from subject", () => {
      const result = classifyExtensivEmail(receiptWithInventoryMarker());
      expect(result.txNumber).toBe("67890");
    });

    it("parses refString", () => {
      const result = classifyExtensivEmail(receiptWithInventoryMarker());
      expect(result.refString).toBe("Best Boutique Summer2025 returns");
    });

    it("skips SKU/Qty header row and parses item rows", () => {
      const result = classifyExtensivEmail(receiptWithInventoryMarker());
      expect(result.parsedItems).toEqual([
        { sku: "FELD-001", quantity: 10 },
        { sku: "FELD-002", quantity: 2 },
      ]);
    });
  });

  describe("partial parse — no items", () => {
    it("returns confidence 0.7 when direction + tx# but no items", () => {
      const result = classifyExtensivEmail(receiptNoItemsNoRef());
      // tx# from subject "(11111)", no ref, no items
      expect(result.direction).toBe("return_receipt");
      expect(result.txNumber).toBe("11111");
      expect(result.parsedItems).toEqual([]);
      expect(result.confidence).toBe(0.7);
    });
  });

  describe("partial parse — no tx# or ref", () => {
    it("returns confidence 0.5 when direction set but no tx# or ref (prose body)", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt Notification",
        body: "Summary of the receipt.\nNo transaction number found in this message.",
      });
      expect(result.direction).toBe("return_receipt");
      expect(result.txNumber).toBeUndefined();
      expect(result.refString).toBeUndefined();
      expect(result.confidence).toBe(0.5);
    });
  });

  describe("tx# only in body", () => {
    it("falls back to parsing tx# from the body text when subject lacks parens", () => {
      const result = classifyExtensivEmail(receiptTxInBodyOnly());
      expect(result.txNumber).toBe("54321");
      expect(result.refString).toBe("Downtown Designs Fall2026 returns");
      // no parseable items → confidence 0.7
      expect(result.confidence).toBe(0.7);
    });
  });

  describe("case-insensitive markers", () => {
    it("matches 'SUMMARY OF THE RECEIPT' uppercase", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt (99)",
        body: "SUMMARY OF THE RECEIPT",
      });
      expect(result.direction).toBe("return_receipt");
    });

    it("matches 'Put Into Inventory' mixed case", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt (88)",
        body: "Put Into Inventory processed.",
      });
      expect(result.direction).toBe("return_receipt");
    });
  });

  // --- inferredCustomerName: feeds the matcher's tier-3 fuzzy path ---
  describe("inferredCustomerName extraction (Bug 3)", () => {
    it("strips trailing season-token + 'returns' from a receipt's Ref line", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt (1)",
        body: "Summary of the receipt.\nRef: Test Customer Spring2026 returns",
      });
      expect(result.inferredCustomerName).toBe("Test Customer");
    });

    it("populates inferredCustomerName for the canonical receipt fixture", () => {
      const result = classifyExtensivEmail(receiptWithSummaryAndItems());
      expect(result.inferredCustomerName).toBe("Acme Company");
    });

    it("populates inferredCustomerName for the inventory-marker fixture", () => {
      const result = classifyExtensivEmail(receiptWithInventoryMarker());
      expect(result.inferredCustomerName).toBe("Best Boutique");
    });

    it("populates inferredCustomerName when only the body has tx#", () => {
      const result = classifyExtensivEmail(receiptTxInBodyOnly());
      expect(result.inferredCustomerName).toBe("Downtown Designs");
    });

    it("returns undefined when refString is missing", () => {
      const result = classifyExtensivEmail(receiptNoItemsNoRef());
      expect(result.inferredCustomerName).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // Bug I11: item-row regex must reject prose-shaped lines like "1 5".
  // The fix requires SKU to be ≥3 chars AND contain at least one letter.
  // ---------------------------------------------------------------------
  describe("item-row regex tightening (Bug I11)", () => {
    it("does NOT parse '1 5' as an item row (no letter, too short)", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt (1)",
        body: "Summary of the receipt.\nRef: Test returns\n1 5",
      });
      // No items should have been parsed from the boilerplate "1 5" line.
      expect(result.parsedItems).toEqual([]);
    });

    it("does NOT parse 'AB 5' as an item row (only 2 chars)", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt (1)",
        body: "Summary of the receipt.\nRef: Test returns\nAB 5",
      });
      expect(result.parsedItems).toEqual([]);
    });

    it("DOES parse 'ABC 5' (≥3 chars + has letter)", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt (1)",
        body: "Summary of the receipt.\nRef: Test returns\nABC 5",
      });
      expect(result.parsedItems).toEqual([{ sku: "ABC", quantity: 5 }]);
    });

    it("does NOT parse '123 5' (no letter)", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt (1)",
        body: "Summary of the receipt.\nRef: Test returns\n123 5",
      });
      expect(result.parsedItems).toEqual([]);
    });

    it("DOES parse 'AB-CD 5' (4 chars + hyphen + letter)", () => {
      const result = classifyExtensivEmail({
        from: EXTENSIV_FROM,
        subject: "Receipt (1)",
        body: "Summary of the receipt.\nRef: Test returns\nAB-CD 5",
      });
      expect(result.parsedItems).toEqual([{ sku: "AB-CD", quantity: 5 }]);
    });
  });

  // ---------------------------------------------------------------------
  // inferCustomerNameFromRef — table-driven unit tests of the helper.
  // ---------------------------------------------------------------------
  describe("inferCustomerNameFromRef helper", () => {
    it.each<[string | undefined, string | undefined]>([
      ["Acme Company Spring2026 returns", "Acme Company"],
      ["Test Customer Spring2026 returns", "Test Customer"],
      ["Best Boutique Summer 2025 returns", "Best Boutique"],
      ["Downtown Designs Fall2026 returns", "Downtown Designs"],
      ["Foo Bar Pesach2026 returns", "Foo Bar"],
      ["Foo Bar return", "Foo Bar"], // singular "return"
      ["Foo Bar", "Foo Bar"], // no suffixes — leave alone
      ["", undefined],
      [undefined, undefined],
      ["   returns   ", undefined], // only suffix → empty → undefined
    ])("inferCustomerNameFromRef(%j) === %j", (input, expected) => {
      expect(inferCustomerNameFromRef(input)).toBe(expected);
    });
  });
});
