import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseShipmentEml, parseShipmentHtml } from "./parser.js";

const FIXTURE_PATH = resolve(
  __dirname,
  "../../../tests/fixtures/feldart-shipments/sample-1-ups-single-item.eml",
);

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

describe("parseShipmentEml — sample 1 (UPS, single item, SHOP18301)", () => {
  const result = parseShipmentEml(loadFixture());
  const { shipment } = result;

  it("extracts the PO number with SHOP prefix preserved", () => {
    expect(shipment.poNumber).toBe("SHOP18301");
  });

  it("derives the bare Shopify order number", () => {
    expect(shipment.shopifyOrderNumber).toBe("18301");
  });

  it("extracts the Feldart transaction number", () => {
    expect(shipment.transactionNumber).toBe("99863");
  });

  it("extracts the end-customer name from the body sentence", () => {
    expect(shipment.endCustomerName).toBe("Decorate");
  });

  it("extracts the long carrier description (United Parcel Service)", () => {
    expect(shipment.carrierLong).toBe("United Parcel Service");
  });

  it("extracts the short carrier code (UPS)", () => {
    expect(shipment.carrierShort).toBe("UPS");
  });

  it("extracts the tracking number", () => {
    expect(shipment.trackingNumber).toBe("1Z0JF5830328583312");
  });

  it("converts the US ship date to ISO YYYY-MM-DD", () => {
    expect(shipment.shipDate).toBe("2026-04-27");
  });

  it("normalizes empty shipping cost to '0.00'", () => {
    expect(shipment.shippingCost).toBe("0.00");
  });

  it("extracts a single line item with SKU + decimal qty", () => {
    expect(shipment.lineItems).toEqual([
      { sku: "HCTOG01", quantity: "23.00" },
    ]);
  });

  it("reports full confidence with no missing fields", () => {
    expect(result.missingFields).toEqual([]);
    expect(result.confidence).toBe(1);
  });

  it("retains decoded HTML for downstream re-parse", () => {
    expect(result.decodedHtml).toContain("PO Number:  SHOP18301");
    expect(result.decodedHtml).toContain("HCTOG01");
  });
});

describe("parseShipmentHtml — edge cases", () => {
  it("returns confidence=0 and lists every missing field on garbage input", () => {
    const result = parseShipmentHtml("<html>not a shipment notification</html>");
    expect(result.confidence).toBe(0);
    expect(result.missingFields).toEqual([
      "poNumber",
      "transactionNumber",
      "endCustomerName",
      "carrierShort",
      "trackingNumber",
      "shipDate",
      "lineItems",
    ]);
    expect(result.shipment.lineItems).toEqual([]);
    expect(result.shipment.shopifyOrderNumber).toBeNull();
  });

  it("preserves a non-empty shipping cost value", () => {
    const html = `
      PO Number: SHOP12345<br/>
      Transaction Number: 11111<br/>
      to your customer Acme Co via FedEx Ground.
      Carrier: FED<br/>
      Tracking Number: ABC123<br/>
      Ship Date: 1/2/2026<br/>
      Shipping Cost: 12.50<br/>
      <table><tr><th>Item</th><th>Quantity</th></tr><tr><td>SKU1</td><td>1.00</td></tr></table>
    `;
    const result = parseShipmentHtml(html);
    expect(result.shipment.shippingCost).toBe("12.50");
    expect(result.shipment.shipDate).toBe("2026-01-02");
    expect(result.shipment.lineItems).toEqual([
      { sku: "SKU1", quantity: "1.00" },
    ]);
  });

  it("preserves zero-qty line rows for split-shipment detection", () => {
    const html = `
      PO Number: SHOP99999<br/>
      Transaction Number: 22222<br/>
      to your customer Split Co via UPS.
      Carrier: UPS<br/>
      Tracking Number: TRACK1<br/>
      Ship Date: 6/15/2026<br/>
      Shipping Cost: <br/>
      <table>
        <tr><th>Item</th><th>Quantity</th></tr>
        <tr><td>FULL-SKU</td><td>5.00</td></tr>
        <tr><td>SPLIT-SKU</td><td>0.00</td></tr>
      </table>
    `;
    const result = parseShipmentHtml(html);
    expect(result.shipment.lineItems).toEqual([
      { sku: "FULL-SKU", quantity: "5.00" },
      { sku: "SPLIT-SKU", quantity: "0.00" },
    ]);
  });

  it("returns null for the bare order number when PO lacks SHOP prefix", () => {
    const html = `
      PO Number: ACME-001<br/>
      Transaction Number: 33333<br/>
      to your customer X via UPS.
      Carrier: UPS<br/>
      Tracking Number: T1<br/>
      Ship Date: 1/1/2026<br/>
      Shipping Cost: <br/>
      <table><tr><th>Item</th><th>Quantity</th></tr><tr><td>S</td><td>1</td></tr></table>
    `;
    const result = parseShipmentHtml(html);
    expect(result.shipment.poNumber).toBe("ACME-001");
    expect(result.shipment.shopifyOrderNumber).toBeNull();
  });
});
