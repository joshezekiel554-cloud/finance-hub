import { describe, expect, it } from "vitest";
import { adaptAgentTool, emailIssueRow, OPS_FINANCE_READS, refreshCooldown } from "./ops-finance-reads.js";
import { ToolInputError } from "./finance-tools.js";

describe("wave-1 ops reads", () => {
  it("ships every adapted in-app agent tool, all ops-gated (no email-attachment fetch)", () => {
    const names = OPS_FINANCE_READS.map((t) => t.name);
    expect(names).toEqual([
      "statement_pdf",
      "money_summary",
      "chase_list",
      "accounts_on_hold",
      "finance_orders",
      "invoice_email_issues",
      "get_customer",
      "get_emails",
      "get_calls",
      "get_rmas",
      "get_chase_statement_history",
      "get_app_settings",
      "refresh_customer_from_qb",
    ]);
    expect(names).not.toContain("get_email_attachments");
    expect(OPS_FINANCE_READS.every((t) => t.ops === true)).toBe(true);
  });

  it("adapts an agent tool: text out, failures become model-readable 400s", async () => {
    const okTool = adaptAgentTool({
      name: "get_rmas",
      description: "x",
      category: "read",
      requiresConfirmation: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ ok: true, output: "rma #1" }),
    });
    const ctx = { now: new Date(), baseUrl: "https://f" };
    await expect(okTool.run({}, ctx)).resolves.toEqual({ text: "rma #1" });
    const badTool = adaptAgentTool({
      name: "get_customer",
      description: "x",
      category: "read",
      requiresConfirmation: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ ok: false, error: "customer c9 not found" }),
    });
    await expect(badTool.run({}, ctx)).rejects.toBeInstanceOf(ToolInputError);
    expect(() =>
      adaptAgentTool({
        name: "delete_everything",
        description: "x",
        category: "write",
        requiresConfirmation: true,
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ ok: true, output: "" }),
      }),
    ).toThrow(/no ops description/);
  });

  it("shapes an email-review invoice for the model", () => {
    expect(
      emailIssueRow(
        {
          invoiceId: "i1",
          qbInvoiceId: "77",
          docNumber: "10234",
          customerId: "c1",
          customerName: "Acme",
          origin: "tj",
          issueDate: "2026-10-01",
          createdAt: "2026-10-01T00:00:00Z",
          total: "100.00",
          balance: "40.5",
          status: "sent",
          emailStatus: "EmailSent",
          deliveryTime: null,
          deliveryError: "Bounced",
          recipients: { to: ["a@x.com"], cc: [] },
          dismissal: null,
        },
        "https://f",
      ),
    ).toEqual({
      invoiceId: "i1",
      invoice: "10234",
      customer: "Acme",
      book: "Torah Judaica",
      issued: "2026-10-01",
      total: 100,
      balance: 40.5,
      qboEmailStatus: "EmailSent",
      deliveryError: "Bounced",
      sendsTo: ["a@x.com"],
      url: "https://f/customers/c1",
    });
  });

  it("cools down QuickBooks refreshes per customer for 60s", () => {
    const seen = new Map<string, number>();
    expect(refreshCooldown("c1", 1_000, seen)).toBeNull();
    expect(refreshCooldown("c1", 31_000, seen)).toBe(30);
    expect(refreshCooldown("c2", 31_000, seen)).toBeNull();
    expect(refreshCooldown("c1", 61_001, seen)).toBeNull();
  });
});
