import { describe, expect, it } from "vitest";
import { allocatePaymentByBook } from "./payment-allocation.js";
import type { QboPayment } from "./types.js";

// A QBO Payment carries Line[] entries, each linked to the invoice(s) it
// pays down. "Received last 30 days" must split Feldart / TJ, so each line's
// amount is attributed to the linked invoice's book; anything not linked to a
// known invoice (unapplied, credit, unknown) is "unallocated".

const base: QboPayment = {
  Id: "p1",
  TxnDate: "2026-09-10",
  TotalAmt: 150,
  CustomerRef: { value: "c1" },
};

const origins = new Map([
  ["inv-f", "feldart" as const],
  ["inv-t", "tj" as const],
]);

describe("allocatePaymentByBook", () => {
  it("splits line amounts by the linked invoice's book", () => {
    const p: QboPayment = {
      ...base,
      Line: [
        { Amount: 100, LinkedTxn: [{ TxnId: "inv-f", TxnType: "Invoice" }] },
        { Amount: 50, LinkedTxn: [{ TxnId: "inv-t", TxnType: "Invoice" }] },
      ],
    };
    expect(allocatePaymentByBook(p, origins)).toEqual({ feldart: 100, tj: 50, unallocated: 0 });
  });

  it("puts lines linked to unknown or non-invoice txns, and unapplied amounts, in unallocated", () => {
    const p: QboPayment = {
      ...base,
      TotalAmt: 130,
      UnappliedAmt: 30,
      Line: [
        { Amount: 60, LinkedTxn: [{ TxnId: "inv-f", TxnType: "Invoice" }] },
        { Amount: 25, LinkedTxn: [{ TxnId: "nope", TxnType: "Invoice" }] },
        { Amount: 15, LinkedTxn: [{ TxnId: "cm-1", TxnType: "CreditMemo" }] },
      ],
    };
    expect(allocatePaymentByBook(p, origins)).toEqual({ feldart: 60, tj: 0, unallocated: 70 });
  });

  it("treats a payment with no lines as fully unallocated", () => {
    expect(allocatePaymentByBook(base, origins)).toEqual({ feldart: 0, tj: 0, unallocated: 150 });
  });

  it("scales book amounts down when line amounts exceed the cash total (credit memos applied alongside)", () => {
    // QBO: when a credit memo is applied with a payment, the line Amount
    // includes the memo's portion, so lines can sum above TotalAmt. Only
    // real cash counts as "received".
    const p: QboPayment = {
      ...base,
      TotalAmt: 100,
      Line: [
        { Amount: 120, LinkedTxn: [{ TxnId: "inv-f", TxnType: "Invoice" }, { TxnId: "cm-9", TxnType: "CreditMemo" }] },
        { Amount: 80, LinkedTxn: [{ TxnId: "inv-t", TxnType: "Invoice" }] },
      ],
    };
    const a = allocatePaymentByBook(p, origins);
    expect(a).toEqual({ feldart: 60, tj: 40, unallocated: 0 });
    expect(a.feldart + a.tj + a.unallocated).toBeCloseTo(100, 2);
  });

  it("never lets rounding push the parts above the total", () => {
    const p: QboPayment = {
      ...base,
      TotalAmt: 10,
      Line: [
        { Amount: 3.333, LinkedTxn: [{ TxnId: "inv-f", TxnType: "Invoice" }] },
        { Amount: 3.333, LinkedTxn: [{ TxnId: "inv-t", TxnType: "Invoice" }] },
        { Amount: 3.334, LinkedTxn: [{ TxnId: "inv-t", TxnType: "Invoice" }] },
      ],
    };
    const a = allocatePaymentByBook(p, origins);
    expect(a.feldart + a.tj + a.unallocated).toBeCloseTo(10, 2);
    expect(a.feldart).toBe(3.33);
    expect(a.tj).toBe(6.67);
  });
});
