import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock for the db — getSourceInvoiceTaxStatus only does one query:
// select originalInvoiceDocNumber rows for the RMA's items.
// ---------------------------------------------------------------------------
const dbState = vi.hoisted(() => ({
  rows: [] as Array<{ docNumber: string | null }>,
}));

vi.mock("../../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => dbState.rows,
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Hoisted mock for QboClient — mock getInvoiceByDocNumber
// ---------------------------------------------------------------------------
const getInvoiceByDocNumberMock = vi.hoisted(() => vi.fn());

vi.mock("../../integrations/qb/client.js", () => ({
  QboClient: vi.fn().mockImplementation(() => ({
    getInvoiceByDocNumber: getInvoiceByDocNumberMock,
  })),
  configFromEnv: vi.fn().mockReturnValue({
    clientId: "test",
    clientSecret: "test",
    redirectUri: "http://localhost",
    realmId: "123",
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { getSourceInvoiceTaxStatus } from "./source-invoice-tax.js";

beforeEach(() => {
  dbState.rows = [];
  getInvoiceByDocNumberMock.mockReset();
});

function taxedInvoice(totalAmt: number, totalTax: number, taxCode = "5") {
  return {
    TotalAmt: totalAmt,
    TxnTaxDetail: {
      TotalTax: totalTax,
      TxnTaxCodeRef: { value: taxCode },
    },
  };
}

describe("getSourceInvoiceTaxStatus — lookup failures", () => {
  it("reports the failed doc number while still using the successful lookup (hadTax stays true)", async () => {
    dbState.rows = [{ docNumber: "INV-100" }, { docNumber: "INV-200" }];
    getInvoiceByDocNumberMock.mockImplementation(async (docNum: string) => {
      if (docNum === "INV-100") throw new Error("QBO 500");
      return taxedInvoice(111, 11);
    });

    const status = await getSourceInvoiceTaxStatus("rma-1");

    expect(status.hadTax).toBe(true);
    expect(status.taxCodeRef).toBe("5");
    expect(status.ratePercent).toBeCloseTo(11, 5);
    expect(status.failedDocNumbers).toEqual(["INV-100"]);
  });

  it("lists every doc number when ALL lookups throw, with hadTax false", async () => {
    dbState.rows = [{ docNumber: "INV-100" }, { docNumber: "INV-200" }];
    getInvoiceByDocNumberMock.mockRejectedValue(new Error("QBO down"));

    const status = await getSourceInvoiceTaxStatus("rma-1");

    expect(status.hadTax).toBe(false);
    expect(status.ratePercent).toBe(0);
    expect(status.taxCodeRef).toBeNull();
    expect(status.failedDocNumbers).toEqual(["INV-100", "INV-200"]);
  });

  it('does NOT treat "not found" (null) as a failure', async () => {
    dbState.rows = [{ docNumber: "INV-100" }, { docNumber: "INV-200" }];
    getInvoiceByDocNumberMock.mockImplementation(async (docNum: string) => {
      if (docNum === "INV-100") return null;
      return taxedInvoice(111, 11);
    });

    const status = await getSourceInvoiceTaxStatus("rma-1");

    expect(status.hadTax).toBe(true);
    expect(status.failedDocNumbers).toEqual([]);
  });

  it("returns empty failedDocNumbers when the RMA has no original invoice doc numbers", async () => {
    dbState.rows = [{ docNumber: null }];

    const status = await getSourceInvoiceTaxStatus("rma-1");

    expect(status).toEqual({
      hadTax: false,
      ratePercent: 0,
      taxCodeRef: null,
      failedDocNumbers: [],
    });
    expect(getInvoiceByDocNumberMock).not.toHaveBeenCalled();
  });
});
