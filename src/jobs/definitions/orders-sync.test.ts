import { describe, expect, it } from "vitest";
import { mapOrderToRow } from "./orders-sync.js";
import type { ShopifyOrder } from "../../integrations/shopify/types.js";

function makeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: 1001,
    name: "#18301",
    order_number: 18301,
    email: "buyer@acme.com",
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    processed_at: null,
    cancelled_at: null,
    closed_at: null,
    fulfillment_status: null,
    financial_status: "paid",
    currency: "GBP",
    total_price: "120.00" as never,
    subtotal_price: null,
    total_tax: null,
    note: null,
    tags: "",
    customer: null,
    shipping_address: null,
    billing_address: null,
    line_items: [
      { id: 1, product_id: 1, variant_id: 1, sku: "ABC", title: "Widget", quantity: 2, price: "60.00" as never },
    ],
    ...overrides,
  };
}

describe("mapOrderToRow", () => {
  it("maps core fields + line items + item count", () => {
    const row = mapOrderToRow(makeOrder(), "cust-1");
    expect(row.shopifyOrderId).toBe("1001");
    expect(row.customerId).toBe("cust-1");
    expect(row.orderNumber).toBe("#18301");
    expect(row.email).toBe("buyer@acme.com");
    expect(row.total).toBe("120.00");
    expect(row.itemCount).toBe(2);
    expect(row.lineItems[0]).toEqual({
      sku: "ABC",
      name: "Widget",
      qty: 2,
      unitPrice: "60.00",
    });
    expect(row.financialStatus).toBe("paid");
  });

  it("normalizes null fulfillment_status to 'unfulfilled'", () => {
    expect(mapOrderToRow(makeOrder(), null).fulfillmentStatus).toBe("unfulfilled");
  });

  it("derives status: cancelled > refunded > fulfilled > shipped > paid > pending", () => {
    expect(mapOrderToRow(makeOrder({ cancelled_at: "2026-06-17T11:00:00Z" }), null).status).toBe("cancelled");
    expect(mapOrderToRow(makeOrder({ financial_status: "refunded" }), null).status).toBe("refunded");
    expect(mapOrderToRow(makeOrder({ fulfillment_status: "fulfilled" }), null).status).toBe("fulfilled");
    expect(mapOrderToRow(makeOrder({ fulfillment_status: "partial" }), null).status).toBe("shipped");
    expect(mapOrderToRow(makeOrder({ financial_status: "paid" }), null).status).toBe("paid");
    expect(mapOrderToRow(makeOrder({ financial_status: "pending", fulfillment_status: null }), null).status).toBe("pending");
  });

  it("extracts tracking from the newest fulfilment that has a tracking number", () => {
    const row = mapOrderToRow(
      makeOrder({
        fulfillments: [
          { id: 1, created_at: "2026-06-17T12:00:00Z", tracking_number: "TRACK1", tracking_url: "https://t/1", tracking_company: "Royal Mail", shipment_status: "in_transit" },
          { id: 2, created_at: "2026-06-16T12:00:00Z", tracking_number: null },
        ],
      }),
      null,
    );
    expect(row.trackingNumber).toBe("TRACK1");
    expect(row.trackingUrl).toBe("https://t/1");
    expect(row.trackingCompany).toBe("Royal Mail");
    expect(row.shipmentStatus).toBe("in_transit");
  });

  it("leaves tracking null when there are no fulfilments", () => {
    const row = mapOrderToRow(makeOrder(), null);
    expect(row.trackingNumber).toBeNull();
    expect(row.shipmentStatus).toBeNull();
  });
});
