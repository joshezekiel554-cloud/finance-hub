// Smoke tests for the Statement PDF renderer. We don't assert on the
// visual layout (that's the user's eyeball test in the preview UI) —
// just that the renderer produces a non-empty PDF buffer for a few
// representative inputs without throwing. The PDF byte-stream starts
// with the literal "%PDF" magic, so checking the first four bytes is a
// cheap proof that the document was generated.

import { describe, expect, it } from "vitest";
import { renderStatementPdf } from "./pdf.js";
import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import type { AppSettingsMap } from "./settings.js";

const FROZEN = new Date("2026-04-29T12:00:00.000Z");

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "cust-1",
    qbCustomerId: "123",
    displayName: "Acme Test Ltd",
    primaryEmail: "a@b.com",
    billingEmails: [],
    invoiceToEmails: null,
    invoiceCcEmails: null,
    invoiceBccEmails: null,
    statementToEmails: null,
    statementCcEmails: null,
    statementBccEmails: null,
    tags: null,
    phone: null,
    additionalPhones: null,
    paymentTerms: "Net 30",
    holdStatus: "active",
    shopifyCustomerId: null,
    mondayItemId: null,
    billingAddressLine1: "100 Main St",
    billingAddressLine2: null,
    billingAddressCity: "Springfield",
    billingAddressRegion: "IL",
    billingAddressPostal: "62701",
    billingAddressCountry: "USA",
    customerType: "b2b",
    balance: "1500.00",
    overdueBalance: "500.00",
    unappliedCreditBalance: "0.00",
    internalNotes: null,
    aiCustomerContext: null,
    lastSyncedAt: FROZEN,
    vocatechLastPushedAt: null,
    agentModeExcluded: false,
    createdAt: FROZEN,
    updatedAt: FROZEN,
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "i-1",
    qbInvoiceId: "q-1",
    customerId: "cust-1",
    origin: "feldart",
    originSource: "prefix",
    disputeState: null,
    disputeClaimedAt: null,
    disputeNote: null,
    disputeUpdatedBy: null,
    bookkeeperThreadId: null,
    docNumber: "18307",
    issueDate: new Date("2026-03-01T00:00:00.000Z"),
    dueDate: new Date("2026-03-31T00:00:00.000Z"),
    total: "500.00",
    balance: "500.00",
    status: "sent",
    sentAt: null,
    sentVia: null,
    customerMemo: null,
    syncToken: null,
    lastSyncedAt: null,
    createdAt: FROZEN,
    updatedAt: FROZEN,
    ...overrides,
  };
}

const SETTINGS: AppSettingsMap = {
  company_name: "Feldart Test",
  company_address: "123 Co Way\nNYC, NY 10001",
  company_phone: "555-1234",
  company_email: "accounts@feldart.com",
  company_website: "feldart.com",
  company_logo_path: "",
  payment_methods: "Wire transfer to:\nABC Bank\nAcct #12345",
  footer_note: "Thank you for your business.",
  statement_number_next: "101",
  statement_bcc_email: "",
  drive_root_folder_id: "",
  warehouse_team_email: "",
  rma_shipping_fee_item_id: "",
  rma_restocking_fee_item_id: "",
  damage_cm_number_next: "38771",
  ai_voice_guide: "",
  ai_corrections_cron_enabled: "",
  autopilot_scan_cron_enabled: "",
  tj_bookkeeper_email: "",
  tj_bookkeeper_name: "",
  agent_enabled: "1",
  agent_monthly_budget_usd: "150",
  inbox_integration_enabled: "",
  shared_tasks_enabled: "",
  order_hold_alert_recipients: "",
  order_hold_warehouse_recipients: "",
  order_hold_team_recipients: "",
  order_tpl_hold_alert_subject: "",
  order_tpl_hold_alert_body: "",
  order_tpl_hold_notice_subject: "",
  order_tpl_hold_notice_body: "",
  order_tpl_hold_warning_subject: "",
  order_tpl_hold_warning_body: "",
  order_tpl_hold_cancel_subject: "",
  order_tpl_hold_cancel_body: "",
  order_tpl_order_cancelled_subject: "",
  order_tpl_order_cancelled_body: "",
  order_overdue_alert_recipients: "",
  order_overdue_threshold_gbp: "1000",
  order_overdue_no_contact_days: "14",
  time_clock_user_ids: "",
};

describe("renderStatementPdf", () => {
  it("produces a non-empty PDF buffer for a basic statement", async () => {
    const buf = await renderStatementPdf({
      customer: makeCustomer(),
      openInvoices: [makeInvoice()],
      creditMemos: [],
      settings: SETTINGS,
      statementNumber: 101,
      generatedAt: FROZEN,
    });
    expect(buf.byteLength).toBeGreaterThan(1000);
    // %PDF magic header.
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("renders with multiple invoices + a credit memo", async () => {
    const buf = await renderStatementPdf({
      customer: makeCustomer(),
      openInvoices: [
        makeInvoice({ qbInvoiceId: "q-1", docNumber: "18307" }),
        makeInvoice({
          qbInvoiceId: "q-2",
          docNumber: "18308",
          balance: "1000.00",
          total: "1000.00",
          dueDate: new Date("2026-05-15T00:00:00.000Z"),
        }),
      ],
      creditMemos: [
        {
          qbId: "cm-1",
          docNumber: "17995CR",
          txnDate: "2026-04-10",
          balance: 100,
          description: "Damage Credit",
        },
      ],
      settings: SETTINGS,
      statementNumber: 102,
      generatedAt: FROZEN,
    });
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("survives a missing logo path without throwing", async () => {
    const buf = await renderStatementPdf({
      customer: makeCustomer(),
      openInvoices: [makeInvoice()],
      creditMemos: [],
      settings: { ...SETTINGS, company_logo_path: "/no/such/file.png" },
      statementNumber: 103,
      generatedAt: FROZEN,
    });
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("renders with no payment terms (uses em-dash placeholder)", async () => {
    const buf = await renderStatementPdf({
      customer: makeCustomer({ paymentTerms: null }),
      openInvoices: [makeInvoice()],
      creditMemos: [],
      settings: SETTINGS,
      statementNumber: 104,
      generatedAt: FROZEN,
    });
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("renders with empty company info gracefully", async () => {
    const buf = await renderStatementPdf({
      customer: makeCustomer(),
      openInvoices: [makeInvoice()],
      creditMemos: [],
      settings: {
        company_name: "",
        company_address: "",
        company_phone: "",
        company_email: "",
        company_website: "",
        company_logo_path: "",
        payment_methods: "",
        footer_note: "",
        statement_number_next: "1",
        statement_bcc_email: "",
        drive_root_folder_id: "",
        warehouse_team_email: "",
        rma_shipping_fee_item_id: "",
        rma_restocking_fee_item_id: "",
        damage_cm_number_next: "38771",
        ai_voice_guide: "",
        ai_corrections_cron_enabled: "",
        autopilot_scan_cron_enabled: "",
        tj_bookkeeper_email: "",
        tj_bookkeeper_name: "",
        agent_enabled: "1",
        agent_monthly_budget_usd: "150",
        inbox_integration_enabled: "",
        shared_tasks_enabled: "",
        order_hold_alert_recipients: "",
        order_hold_warehouse_recipients: "",
        order_hold_team_recipients: "",
        order_tpl_hold_alert_subject: "",
        order_tpl_hold_alert_body: "",
        order_tpl_hold_notice_subject: "",
        order_tpl_hold_notice_body: "",
        order_tpl_hold_warning_subject: "",
        order_tpl_hold_warning_body: "",
        order_tpl_hold_cancel_subject: "",
        order_tpl_hold_cancel_body: "",
        order_tpl_order_cancelled_subject: "",
        order_tpl_order_cancelled_body: "",
        order_overdue_alert_recipients: "",
        order_overdue_threshold_gbp: "1000",
        order_overdue_no_contact_days: "14",
        time_clock_user_ids: "",
      },
      statementNumber: 1,
      generatedAt: FROZEN,
    });
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("handles many invoices (paginated layout)", async () => {
    const invoices = Array.from({ length: 30 }, (_, i) =>
      makeInvoice({
        qbInvoiceId: `q-${i + 1}`,
        docNumber: String(18000 + i),
        balance: "100.00",
        total: "100.00",
        // Vary due dates so some are overdue, some not.
        dueDate: new Date(
          `2026-${String((i % 12) + 1).padStart(2, "0")}-15T00:00:00.000Z`,
        ),
      }),
    );
    const buf = await renderStatementPdf({
      customer: makeCustomer(),
      openInvoices: invoices,
      creditMemos: [],
      settings: SETTINGS,
      statementNumber: 200,
      generatedAt: FROZEN,
    });
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
    // Multi-page document — should be well over 5 KB.
    expect(buf.byteLength).toBeGreaterThan(5000);
  });
});
