import { describe, expect, it, vi } from "vitest";
import { buildPayload, sendInvoiceUpdate } from "./sender.js";
import type { QboInvoice, QboInvoiceLine } from "../../integrations/qb/types.js";
import type { ReconcileAction } from "./types.js";

function makeLine(overrides: Partial<QboInvoiceLine>): QboInvoiceLine {
  return {
    Id: "1",
    LineNum: 1,
    Description: "SKU1",
    Amount: 100,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      ItemRef: { value: "1000", name: "Test Product" },
      Qty: 10,
      UnitPrice: 10,
      TaxCodeRef: { value: "NON" },
    },
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<QboInvoice> = {}): QboInvoice {
  return {
    Id: "13781",
    DocNumber: "18294",
    SyncToken: "3",
    TxnDate: "2026-04-20",
    DueDate: "2026-05-20",
    TotalAmt: 100,
    Balance: 100,
    CustomerRef: { value: "10", name: "Bais Hasforim" },
    CurrencyRef: { value: "USD" },
    Line: [
      makeLine({ Id: "1", Description: "SKU1", Amount: 100 }),
    ],
    ...overrides,
  };
}

const SET_METADATA: ReconcileAction = {
  type: "set_metadata",
  trackingNumber: "1Z0JF5830328583312",
  shipVia: "UPS",
  shipDate: "2026-04-27",
};

describe("buildPayload — required fields", () => {
  it("requires SyncToken", () => {
    const invoice = makeInvoice({ SyncToken: undefined });
    expect(() => buildPayload(invoice, [SET_METADATA])).toThrow(/SyncToken/);
  });

  it("emits Id, SyncToken, sparse:true on every payload", () => {
    const payload = buildPayload(makeInvoice(), [SET_METADATA]);
    expect(payload.Id).toBe("13781");
    expect(payload.SyncToken).toBe("3");
    expect(payload.sparse).toBe(true);
  });

  it("populates ship metadata from set_metadata action", () => {
    const payload = buildPayload(makeInvoice(), [SET_METADATA]);
    expect(payload.TrackingNum).toBe("1Z0JF5830328583312");
    expect(payload.ShipDate).toBe("2026-04-27");
    expect(payload.ShipMethodRef).toEqual({ value: "UPS", name: "UPS" });
  });

  it("omits ship metadata when no set_metadata action present", () => {
    // Defensive — reconciler always emits set_metadata, but if a caller
    // doesn't, payload should still be valid.
    const payload = buildPayload(makeInvoice(), []);
    expect(payload.TrackingNum).toBeUndefined();
    expect(payload.ShipDate).toBeUndefined();
    expect(payload.ShipMethodRef).toBeUndefined();
  });
});

describe("buildPayload — Line transformations", () => {
  it("preserves a line when keep action targets it", () => {
    const invoice = makeInvoice();
    const payload = buildPayload(invoice, [
      SET_METADATA,
      { type: "keep", lineId: "1", sku: "SKU1", qty: 10 },
    ]);
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0]?.SalesItemLineDetail?.Qty).toBe(10);
  });

  it("updates Qty + Amount on qty_change", () => {
    const invoice = makeInvoice({
      Line: [makeLine({ Id: "1", Amount: 100 })],
    });
    const payload = buildPayload(invoice, [
      SET_METADATA,
      {
        type: "qty_change",
        lineId: "1",
        sku: "SKU1",
        fromQty: 10,
        toQty: 4,
        reason: "shipped_less",
      },
    ]);
    expect(payload.Line[0]?.SalesItemLineDetail?.Qty).toBe(4);
    expect(payload.Line[0]?.Amount).toBe(40);
  });

  it("zeros Amount when qty_change drops qty to 0 (not_shipped)", () => {
    const invoice = makeInvoice();
    const payload = buildPayload(invoice, [
      SET_METADATA,
      {
        type: "qty_change",
        lineId: "1",
        sku: "SKU1",
        fromQty: 10,
        toQty: 0,
        reason: "not_shipped",
      },
    ]);
    expect(payload.Line[0]?.SalesItemLineDetail?.Qty).toBe(0);
    expect(payload.Line[0]?.Amount).toBe(0);
  });

  it("appends an add action as a new SalesItemLineDetail row", () => {
    const invoice = makeInvoice();
    const payload = buildPayload(invoice, [
      SET_METADATA,
      { type: "keep", lineId: "1", sku: "SKU1", qty: 10 },
      {
        type: "add",
        sku: "EXTRA-SKU",
        qty: 3,
        unitPrice: 12.5,
        priceSource: "shopify_b2b",
      },
    ]);
    expect(payload.Line).toHaveLength(2);
    const added = payload.Line[1]!;
    expect(added.Description).toBe("EXTRA-SKU");
    expect(added.DetailType).toBe("SalesItemLineDetail");
    expect(added.SalesItemLineDetail?.Qty).toBe(3);
    expect(added.SalesItemLineDetail?.UnitPrice).toBe(12.5);
    expect(added.Amount).toBe(37.5);
    expect(added.SalesItemLineDetail?.TaxCodeRef).toEqual({ value: "NON" });
  });

  it("blocks add actions with null unitPrice", () => {
    expect(() =>
      buildPayload(makeInvoice(), [
        SET_METADATA,
        {
          type: "add",
          sku: "MYSTERY",
          qty: 1,
          unitPrice: null,
          priceSource: "fallback",
        },
      ]),
    ).toThrow(/unitPrice/);
  });

  it("drops auto-generated SubTotalLineDetail rows from output", () => {
    const invoice = makeInvoice({
      Line: [
        makeLine({ Id: "1", Description: "SKU1" }),
        {
          DetailType: "SubTotalLineDetail",
          Amount: 100,
        } as QboInvoiceLine,
      ],
    });
    const payload = buildPayload(invoice, [
      SET_METADATA,
      { type: "keep", lineId: "1", sku: "SKU1", qty: 10 },
    ]);
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0]?.DetailType).toBe("SalesItemLineDetail");
  });

  it("preserves lines unaddressed by any action", () => {
    // Multi-line invoice; reconciler only emits keep for line "1". Line "2"
    // should still appear in the payload untouched.
    const invoice = makeInvoice({
      Line: [
        makeLine({ Id: "1", Description: "SKU1", Amount: 100 }),
        makeLine({ Id: "2", Description: "SKU2", Amount: 50 }),
      ],
    });
    const payload = buildPayload(invoice, [
      SET_METADATA,
      { type: "keep", lineId: "1", sku: "SKU1", qty: 10 },
    ]);
    expect(payload.Line).toHaveLength(2);
    expect(payload.Line.map((l) => l.Description)).toEqual(["SKU1", "SKU2"]);
  });
});

describe("buildPayload — realistic 18294-shaped scenario", () => {
  it("aligns the 5-line Bais Hasforim invoice to match a Feldart shipment", () => {
    // Shape lifted from the live 18294 discovery:
    //   Line 1: DDCS01LG x 12 @ 38.25
    //   Line 2: FSHTL01S x 1  @ 49
    //   Line 3: FSHTL01G x 6  @ 49
    //   Line 4: NHOG01   x 1  @ 23
    //   (subtotal auto-row dropped)
    // Suppose Feldart shipped: DDCS01LG x 12 (match), FSHTL01S x 0 (split),
    // FSHTL01G x 5 (shipped less), NHOG01 absent (not shipped).
    const invoice = makeInvoice({
      Line: [
        makeLine({
          Id: "1",
          Description: "DDCS01LG",
          Amount: 459,
          SalesItemLineDetail: {
            ItemRef: { value: "1691", name: "Classic Swivel Dip Dish" },
            Qty: 12,
            UnitPrice: 38.25,
            TaxCodeRef: { value: "NON" },
          },
        }),
        makeLine({
          Id: "2",
          Description: "FSHTL01S",
          Amount: 49,
          SalesItemLineDetail: {
            ItemRef: { value: "1010000236", name: "Foldable Leatherite - Silver" },
            Qty: 1,
            UnitPrice: 49,
            TaxCodeRef: { value: "NON" },
          },
        }),
        makeLine({
          Id: "3",
          Description: "FSHTL01G",
          Amount: 294,
          SalesItemLineDetail: {
            ItemRef: { value: "1010000214", name: "Foldable Leatherite - Gold" },
            Qty: 6,
            UnitPrice: 49,
            TaxCodeRef: { value: "NON" },
          },
        }),
        makeLine({
          Id: "4",
          Description: "NHOG01",
          Amount: 23,
          SalesItemLineDetail: {
            ItemRef: { value: "1939", name: "Ornate Garden Napkin Holder" },
            Qty: 1,
            UnitPrice: 23,
            TaxCodeRef: { value: "NON" },
          },
        }),
      ],
    });

    const actions: ReconcileAction[] = [
      SET_METADATA,
      { type: "keep", lineId: "1", sku: "DDCS01LG", qty: 12 },
      {
        type: "qty_change",
        lineId: "2",
        sku: "FSHTL01S",
        fromQty: 1,
        toQty: 0,
        reason: "split_zero",
      },
      {
        type: "qty_change",
        lineId: "3",
        sku: "FSHTL01G",
        fromQty: 6,
        toQty: 5,
        reason: "shipped_less",
      },
      {
        type: "qty_change",
        lineId: "4",
        sku: "NHOG01",
        fromQty: 1,
        toQty: 0,
        reason: "not_shipped",
      },
    ];

    const payload = buildPayload(invoice, actions);
    expect(payload.Line).toHaveLength(4);
    expect(payload.Line[0]?.SalesItemLineDetail?.Qty).toBe(12);
    expect(payload.Line[0]?.Amount).toBe(459);
    expect(payload.Line[1]?.SalesItemLineDetail?.Qty).toBe(0);
    expect(payload.Line[1]?.Amount).toBe(0);
    expect(payload.Line[2]?.SalesItemLineDetail?.Qty).toBe(5);
    expect(payload.Line[2]?.Amount).toBe(245);
    expect(payload.Line[3]?.SalesItemLineDetail?.Qty).toBe(0);
    expect(payload.Line[3]?.Amount).toBe(0);
    expect(payload.TrackingNum).toBe("1Z0JF5830328583312");
    expect(payload.ShipMethodRef).toEqual({ value: "UPS", name: "UPS" });
  });
});

describe("buildPayload — customer memo + terms", () => {
  it("always blanks CustomerMemo and PrivateNote on every send", () => {
    const payload = buildPayload(makeInvoice(), [SET_METADATA]);
    expect(payload.CustomerMemo).toEqual({ value: "" });
    expect(payload.PrivateNote).toBe("");
  });

  it("sets SalesTermRef when salesTermId is provided", () => {
    const payload = buildPayload(makeInvoice(), [SET_METADATA], {
      salesTermId: "3",
      salesTermName: "Net 30",
    });
    expect(payload.SalesTermRef).toEqual({ value: "3", name: "Net 30" });
  });

  it("omits SalesTermRef from the payload when no override is requested", () => {
    const payload = buildPayload(makeInvoice(), [SET_METADATA]);
    expect(payload.SalesTermRef).toBeUndefined();
  });

  it("includes SalesTermRef without name when only id is provided", () => {
    const payload = buildPayload(makeInvoice(), [SET_METADATA], {
      salesTermId: "5",
    });
    expect(payload.SalesTermRef).toEqual({ value: "5" });
  });
});

describe("buildPayload — invoice-level discount", () => {
  it("appends DiscountLineDetail with PercentBased=true when discountPercent>0", () => {
    const payload = buildPayload(makeInvoice(), [SET_METADATA], {
      discountPercent: 5,
    });
    const discountLine = payload.Line.find(
      (l) => l.DetailType === "DiscountLineDetail",
    ) as { DiscountLineDetail?: { PercentBased: boolean; DiscountPercent: number } } | undefined;
    expect(discountLine).toBeDefined();
    expect(discountLine?.DiscountLineDetail).toEqual({
      PercentBased: true,
      DiscountPercent: 5,
    });
  });

  it("strips any pre-existing DiscountLineDetail from the source invoice", () => {
    const invoice = makeInvoice({
      Line: [
        makeLine({ Id: "1" }),
        {
          DetailType: "DiscountLineDetail",
          Amount: -10,
        } as unknown as QboInvoiceLine,
      ],
    });
    // No discountPercent → existing discount should still be dropped (caller
    // must opt in each time).
    const payload = buildPayload(invoice, [
      SET_METADATA,
      { type: "keep", lineId: "1", sku: "SKU1", qty: 10 },
    ]);
    expect(payload.Line.some((l) => l.DetailType === "DiscountLineDetail")).toBe(
      false,
    );
  });

  it("replaces a pre-existing discount with the user's new value", () => {
    const invoice = makeInvoice({
      Line: [
        makeLine({ Id: "1" }),
        {
          DetailType: "DiscountLineDetail",
          Amount: -10,
          DiscountLineDetail: { PercentBased: true, DiscountPercent: 10 },
        } as unknown as QboInvoiceLine,
      ],
    });
    const payload = buildPayload(
      invoice,
      [SET_METADATA, { type: "keep", lineId: "1", sku: "SKU1", qty: 10 }],
      { discountPercent: 5 },
    );
    const discountLines = payload.Line.filter(
      (l) => l.DetailType === "DiscountLineDetail",
    );
    expect(discountLines).toHaveLength(1);
    const dl = discountLines[0] as { DiscountLineDetail?: { DiscountPercent: number } } | undefined;
    expect(dl?.DiscountLineDetail?.DiscountPercent).toBe(5);
  });

  it("rejects discount > 100", () => {
    expect(() =>
      buildPayload(makeInvoice(), [SET_METADATA], { discountPercent: 150 }),
    ).toThrow(/exceeds 100/);
  });

  it("does NOT append a discount line when discountPercent=0 or omitted", () => {
    const omitted = buildPayload(makeInvoice(), [SET_METADATA]);
    const zero = buildPayload(makeInvoice(), [SET_METADATA], {
      discountPercent: 0,
    });
    expect(omitted.Line.some((l) => l.DetailType === "DiscountLineDetail")).toBe(
      false,
    );
    expect(zero.Line.some((l) => l.DetailType === "DiscountLineDetail")).toBe(
      false,
    );
  });
});

describe("sendInvoiceUpdate — shadow vs live", () => {
  it("returns status:shadow without posting when shadowMode=true", async () => {
    const postUpdate = vi.fn();
    const result = await sendInvoiceUpdate(makeInvoice(), [SET_METADATA], {
      shadowMode: true,
      postUpdate,
    });
    expect(result.status).toBe("shadow");
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("calls postUpdate and returns status:sent when shadowMode=false", async () => {
    const updated = makeInvoice({ SyncToken: "4" });
    const postUpdate = vi.fn(async () => updated);
    const result = await sendInvoiceUpdate(makeInvoice(), [SET_METADATA], {
      shadowMode: false,
      postUpdate,
    });
    expect(postUpdate).toHaveBeenCalledOnce();
    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.response.SyncToken).toBe("4");
    }
  });

  it("throws if live mode is requested without a postUpdate hook", async () => {
    await expect(
      sendInvoiceUpdate(makeInvoice(), [SET_METADATA], { shadowMode: false }),
    ).rejects.toThrow(/postUpdate/);
  });
});
