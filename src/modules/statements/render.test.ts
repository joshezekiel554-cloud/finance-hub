import { describe, expect, it } from "vitest";
import {
  renderStatementTable,
  type StatementCreditMemoRow,
  type StatementInvoiceRow,
} from "./render.js";

const NOW = new Date("2026-04-29T12:00:00.000Z");

function makeRow(overrides: Partial<StatementInvoiceRow> = {}): StatementInvoiceRow {
  return {
    qbInvoiceId: "1001",
    docNumber: "18307",
    issueDate: "2026-03-01",
    dueDate: "2026-03-31",
    total: "324.00",
    balance: "324.00",
    invoiceLink: null,
    ...overrides,
  };
}

function makeCreditMemo(
  overrides: Partial<StatementCreditMemoRow> = {},
): StatementCreditMemoRow {
  return {
    qbCreditMemoId: "5001",
    docNumber: "CM-1",
    txnDate: "2026-04-15",
    balance: "50.00",
    ...overrides,
  };
}

describe("renderStatementTable", () => {
  it("renders an open-invoices table with totals", () => {
    const html = renderStatementTable({
      customer: { displayName: "Acme Ltd" },
      openInvoices: [makeRow()],
      creditMemos: [],
      now: NOW,
    });
    expect(html).toContain("Open invoices for Acme Ltd");
    expect(html).toContain("18307");
    expect(html).toContain("$324.00");
    // Days overdue against 2026-04-29 from due date 2026-03-31 = 29 days.
    expect(html).toContain(">29</span>");
    // Totals row.
    expect(html).toContain("Total open");
    expect(html).toContain("Total overdue");
    expect(html).toContain("Net amount due");
  });

  it("escapes customer-supplied data going into the rendered HTML", () => {
    const html = renderStatementTable({
      customer: { displayName: "Foo & Sons <Acme>" },
      openInvoices: [makeRow({ docNumber: '<script>"hi"</script>' })],
      creditMemos: [],
      now: NOW,
    });
    expect(html).toContain("Foo &amp; Sons &lt;Acme&gt;");
    expect(html).toContain("&lt;script&gt;&quot;hi&quot;&lt;/script&gt;");
    // Raw closing tag must not appear — the input is escaped inside the
    // surrounding cell's <td>.
    expect(html).not.toContain("<script>");
  });

  it("renders InvoiceLink as a clickable Pay-now anchor when present", () => {
    const html = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [
        makeRow({
          docNumber: "18307",
          invoiceLink: "https://qbo.intuit.com/pay/inv/abc?token=xyz",
        }),
      ],
      creditMemos: [],
      now: NOW,
    });
    expect(html).toContain("href=\"https://qbo.intuit.com/pay/inv/abc?token=xyz\"");
    expect(html).toContain(">18307</a>");
  });

  it("falls back to plain text Invoice # when InvoiceLink is null", () => {
    const html = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [makeRow({ invoiceLink: null })],
      creditMemos: [],
      now: NOW,
    });
    // No <a tag for the invoice number cell.
    expect(html).not.toContain("href=");
    expect(html).toContain(">18307</td>");
  });

  it("renders the credit memos section only when at least one is present", () => {
    const without = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [makeRow()],
      creditMemos: [],
      now: NOW,
    });
    expect(without).not.toContain("Available credits");

    const withCm = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [makeRow()],
      creditMemos: [makeCreditMemo()],
      now: NOW,
    });
    expect(withCm).toContain("Available credits");
    expect(withCm).toContain("CM-1");
    expect(withCm).toContain("$50.00");
  });

  it("computes totals correctly with multiple invoices + credits", () => {
    const html = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [
        makeRow({
          qbInvoiceId: "1",
          docNumber: "100",
          balance: "1000.00",
          dueDate: "2026-03-01",
        }),
        makeRow({
          qbInvoiceId: "2",
          docNumber: "101",
          balance: "500.00",
          dueDate: "2099-01-01",
        }),
      ],
      creditMemos: [makeCreditMemo({ balance: "200.00" })],
      now: NOW,
    });
    // Total open = 1500
    expect(html).toContain("$1,500.00");
    // Total overdue = 1000 (only the first row's due is in the past)
    // Total credits = 200
    expect(html).toContain("$1,000.00");
    expect(html).toContain("$200.00");
    // Net = 1500 - 200 = 1300
    expect(html).toContain("$1,300.00");
  });

  it("treats invoices with no due date as not overdue", () => {
    const html = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [
        makeRow({ qbInvoiceId: "1", balance: "100.00", dueDate: null }),
      ],
      creditMemos: [],
      now: NOW,
    });
    expect(html).toContain(">0</td>");
    // Total overdue should be $0.
    expect(html).toMatch(/Total overdue<\/td>\s*<td[^>]+>[^<]*<span[^>]+>\$0\.00<\/span>/);
  });

  it("formats dates as DD/MM/YYYY (en-GB)", () => {
    const html = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [
        makeRow({
          issueDate: "2026-03-01",
          dueDate: "2026-03-31",
        }),
      ],
      creditMemos: [],
      now: NOW,
    });
    expect(html).toContain("01/03/2026");
    expect(html).toContain("31/03/2026");
  });

  it("renders an em dash for missing dates rather than empty cells", () => {
    const html = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [
        makeRow({ issueDate: null, dueDate: null }),
      ],
      creditMemos: [],
      now: NOW,
    });
    expect(html).toContain("—");
  });

  it("returns valid markup with no invoices is impossible — caller handles", () => {
    // Guard: render with empty arrays still produces a complete shell.
    const html = renderStatementTable({
      customer: { displayName: "Acme" },
      openInvoices: [],
      creditMemos: [],
      now: NOW,
    });
    expect(html).toContain("Open invoices for Acme");
    expect(html).toContain("$0.00");
  });
});
