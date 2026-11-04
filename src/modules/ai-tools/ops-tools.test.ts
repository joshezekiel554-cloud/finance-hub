import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  invoiceState,
  linkedInvoicesByPayment,
  normalizeDocNumber,
  rmaRow,
} from "./ops-tools.js";
import { FINANCE_TOOLS } from "./finance-tools.js";
import { hasOpsAccess, OPS_TOOLS, toolsFor } from "../../server/routes/ext-tools.js";
import { mintHubToken, verifyHubToken } from "../../lib/hub-token.js";

const OPS = "josh@feldart.com,joshezekiel554@gmail.com,info@feldartcollection.co.uk";

describe("ops gate", () => {
  it("needs BOTH the hub's ops claim and finance's own list", () => {
    expect(hasOpsAccess({ email: "josh@feldart.com", ops: true }, OPS)).toBe(true);
    expect(hasOpsAccess({ email: "josh@feldart.com", ops: false }, OPS)).toBe(false); // hub didn't vouch
    expect(hasOpsAccess({ email: "staff@feldart.com", ops: true }, OPS)).toBe(false); // not on finance's list
    expect(hasOpsAccess({ email: "josh@feldart.com", ops: true }, "")).toBe(false); // unset = nobody
  });

  it("lists ops tools only with access, and staff tools always", () => {
    const names = (a: boolean) => toolsFor(a).map((t) => t.name);
    expect(names(false)).toEqual(FINANCE_TOOLS.map((t) => t.name));
    expect(names(true)).toEqual([...FINANCE_TOOLS, ...OPS_TOOLS].map((t) => t.name));
    expect(OPS_TOOLS.every((t) => t.ops === true)).toBe(true);
    expect(FINANCE_TOOLS.some((t) => t.ops)).toBe(false);
    const all = [...FINANCE_TOOLS, ...OPS_TOOLS].map((t) => t.name);
    expect(new Set(all).size).toBe(all.length);
  });

  it("reads ops:true from the hub token, nothing else counts", () => {
    const secret = "k".repeat(40);
    const now = 1_800_000_000;
    const read = (ops: unknown) => {
      const t = mintHubToken({ email: "Josh@Feldart.com", aud: "finance", scope: "service", ttlSeconds: 60, secret, nowSeconds: now });
      if (ops === undefined) return verifyHubToken(t, { secret, aud: "finance", nowSeconds: now });
      // Re-sign a payload with a custom ops value.
      const seg1 = Buffer.from(JSON.stringify({ email: "josh@feldart.com", exp: now + 60, aud: "finance", jti: "j", scope: "service", ops })).toString("base64url");
      const sig = createHmac("sha256", secret).update(seg1).digest("base64url");
      return verifyHubToken(`${seg1}.${sig}`, { secret, aud: "finance", nowSeconds: now });
    };
    expect(read(undefined)?.ops).toBe(false);
    expect(read(true)?.ops).toBe(true);
    expect(read("true")?.ops).toBe(false);
    expect(read(1)?.ops).toBe(false);
    const minted = mintHubToken({ email: "a@b.c", aud: "finance", ttlSeconds: 60, secret, nowSeconds: now, ops: true });
    expect(verifyHubToken(minted, { secret, aud: "finance", nowSeconds: now })?.ops).toBe(true);
  });

  it("every ops tool has a closed schema and a model-facing description", () => {
    for (const t of OPS_TOOLS) {
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(80);
    }
  });
});

describe("find_invoice helpers", () => {
  it("normalises how people say invoice numbers", () => {
    for (const s of ["10234", " #10234 ", "INV 10234", "inv-10234", "Invoice no. 10234", "invoice #10234", "invoice number 10234", "CM 10234"]) {
      expect(normalizeDocNumber(s)).toBe("10234");
    }
    expect(normalizeDocNumber("A-77")).toBe("A-77");
  });

  it("derives open / overdue / paid / void", () => {
    const today = "2026-11-03";
    expect(invoiceState({ status: "void", balance: "50", dueDate: "2026-01-01" }, today)).toBe("void");
    expect(invoiceState({ status: "paid", balance: "0.00", dueDate: "2026-01-01" }, today)).toBe("paid");
    expect(invoiceState({ status: "sent", balance: "10", dueDate: "2026-11-02" }, today)).toBe("overdue");
    expect(invoiceState({ status: "sent", balance: "10", dueDate: "2026-11-03" }, today)).toBe("open");
    expect(invoiceState({ status: "sent", balance: "10", dueDate: null }, today)).toBe("open");
    expect(invoiceState({ status: "sent", balance: "10", dueDate: new Date("2026-10-01T00:00:00Z") }, today)).toBe("overdue");
  });
});

describe("customer_payments helpers", () => {
  it("maps each payment to the invoices its lines paid", () => {
    const m = linkedInvoicesByPayment([
      {
        Id: "p1",
        CustomerRef: { value: "c" },
        Line: [
          { Amount: 100, LinkedTxn: [{ TxnId: "i1", TxnType: "Invoice" }] },
          { Amount: 25.5, LinkedTxn: [{ TxnId: "cm9", TxnType: "CreditMemo" }] },
          { Amount: 40.005, LinkedTxn: [{ TxnId: "i2", TxnType: "Invoice" }] },
        ],
      },
      { Id: "p2", CustomerRef: { value: "c" } },
    ]);
    expect(m.get("p1")).toEqual([
      { qbInvoiceId: "i1", amount: 100 },
      { qbInvoiceId: "i2", amount: 40.01 },
    ]);
    expect(m.get("p2")).toEqual([]);
  });
});

describe("rma rows", () => {
  const base = {
    id: "r1",
    rmaNumber: "DC12345",
    customerId: "c1",
    customer: "Acme Judaica",
    email: "a@x.com",
    returnType: "damage" as const,
    status: "sent_to_warehouse" as const,
    totalValue: "120.50",
    createdAt: new Date("2026-10-01T10:00:00Z"),
    approvedAt: new Date("2026-10-03T10:00:00Z"),
    sentToWarehouseAt: new Date("2026-10-04T10:00:00Z"),
    receivedAtWarehouseAt: null,
    trackingNumber: null,
    trackingCarrier: null,
    trackingSavedAt: null,
    creditMemoDocNumber: null,
    extensivRef: "RMA DC12345",
  };

  it("plain-words status, days open from approval, tracking only when saved", () => {
    const r = rmaRow(base, "2026-11-03", "https://f");
    expect(r).toMatchObject({
      rma: "DC12345",
      type: "Damage",
      status: "Sent to warehouse — expecting the parcel",
      value: 120.5,
      approved: "2026-10-03",
      daysOpen: 31,
      tracking: null,
      url: "https://f/returns/r1",
    });
    const t = rmaRow({ ...base, trackingNumber: "1Z999", trackingCarrier: "UPS", trackingSavedAt: new Date("2026-10-05T09:00:00Z") }, "2026-11-03", "https://f");
    expect(t.tracking).toEqual({ number: "1Z999", carrier: "UPS", saved: "2026-10-05" });
  });

  it("falls back to the created date for unapproved drafts", () => {
    expect(rmaRow({ ...base, status: "draft", approvedAt: null }, "2026-11-03", "https://f").daysOpen).toBe(33);
  });
});
