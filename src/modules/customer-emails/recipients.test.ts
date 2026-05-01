// Tests for the per-channel recipient resolver. After the
// override-paradigm removal (commit a074693), this resolver is
// deliberately small: read the per-channel arrays + tag rules,
// dedupe, return. These tests pin the contract.

import { describe, expect, it } from "vitest";
import {
  resolveRecipientsWithRules,
  type CustomerEmailInput,
} from "./recipients.js";
import type { RoutingRuleAction } from "../../db/schema/email-routing-rules.js";

function makeCustomer(
  overrides: Partial<CustomerEmailInput> = {},
): CustomerEmailInput {
  return {
    primaryEmail: "primary@example.com",
    billingEmails: null,
    invoiceToEmails: null,
    invoiceCcEmails: null,
    invoiceBccEmails: null,
    statementToEmails: null,
    statementCcEmails: null,
    statementBccEmails: null,
    tags: null,
    ...overrides,
  };
}

describe("resolveRecipientsWithRules — invoice channel", () => {
  it("returns the invoice arrays directly with no fallback", () => {
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceToEmails: ["a@x.com"],
        invoiceCcEmails: ["b@x.com"],
        invoiceBccEmails: ["c@x.com"],
      }),
      [],
    );
    expect(r.to).toEqual(["a@x.com"]);
    expect(r.cc).toEqual(["b@x.com"]);
    expect(r.bcc).toEqual(["c@x.com"]);
  });

  it("does NOT fall back to primary_email / billing_emails when arrays are null", () => {
    // The fallback-to-primary paradigm was removed; the migration
    // backfills per-channel arrays so this path should never trigger
    // in production, but we explicitly assert the resolver no longer
    // peeks at primary/billing.
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        primaryEmail: "primary@example.com",
        billingEmails: ["billing@example.com"],
        invoiceToEmails: null,
        invoiceCcEmails: null,
        invoiceBccEmails: null,
      }),
      [],
    );
    expect(r.to).toEqual([]);
    expect(r.cc).toEqual([]);
    expect(r.bcc).toEqual([]);
  });

  it("supports multiple TO addresses", () => {
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceToEmails: ["a@x.com", "b@x.com", "c@x.com"],
      }),
      [],
    );
    expect(r.to).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("strips CC entries that duplicate a TO (case-insensitive)", () => {
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceToEmails: ["A@X.com"],
        invoiceCcEmails: ["a@x.com", "other@x.com"],
      }),
      [],
    );
    expect(r.cc).toEqual(["other@x.com"]);
  });

  it("dedupes case-insensitively across the same list", () => {
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceCcEmails: ["a@x.com", "A@x.com", "b@x.com"],
      }),
      [],
    );
    expect(r.cc).toEqual(["a@x.com", "b@x.com"]);
  });

  it("layers tag-driven bcc_invoice rules onto BCC", () => {
    const rules: Array<{
      tag: string;
      action: RoutingRuleAction;
      value: string;
    }> = [
      { tag: "yiddy", action: "bcc_invoice", value: "sales@feldart.com" },
    ];
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceToEmails: ["a@x.com"],
        invoiceBccEmails: ["manual@x.com"],
        tags: ["yiddy"],
      }),
      rules,
    );
    expect(r.bcc).toContain("manual@x.com");
    expect(r.bcc).toContain("sales@feldart.com");
    expect(r.bccReasons).toEqual([
      { tag: "yiddy", address: "sales@feldart.com" },
    ]);
  });

  it("applies cc_invoice rules to CC, not BCC", () => {
    const rules: Array<{
      tag: string;
      action: RoutingRuleAction;
      value: string;
    }> = [
      { tag: "always-cc", action: "cc_invoice", value: "ops@feldart.com" },
    ];
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceToEmails: ["a@x.com"],
        tags: ["always-cc"],
      }),
      rules,
    );
    expect(r.cc).toContain("ops@feldart.com");
    expect(r.bcc).toEqual([]);
  });

  it("ignores statement-channel rules on the invoice channel", () => {
    const rules: Array<{
      tag: string;
      action: RoutingRuleAction;
      value: string;
    }> = [
      {
        tag: "yiddy",
        action: "bcc_statement",
        value: "stmt@feldart.com",
      },
    ];
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceToEmails: ["a@x.com"],
        tags: ["yiddy"],
      }),
      rules,
    );
    expect(r.bcc).toEqual([]);
    expect(r.bccReasons).toEqual([]);
  });

  it("matches tags case-insensitively", () => {
    const rules: Array<{
      tag: string;
      action: RoutingRuleAction;
      value: string;
    }> = [
      { tag: "yiddy", action: "bcc_invoice", value: "sales@feldart.com" },
    ];
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceToEmails: ["a@x.com"],
        tags: ["YIDDY"],
      }),
      rules,
    );
    expect(r.bcc).toEqual(["sales@feldart.com"]);
  });

  it("doesn't double-add a tag-derived BCC that's already in the manual BCC list", () => {
    const rules: Array<{
      tag: string;
      action: RoutingRuleAction;
      value: string;
    }> = [
      { tag: "yiddy", action: "bcc_invoice", value: "sales@feldart.com" },
    ];
    const r = resolveRecipientsWithRules(
      "invoice",
      makeCustomer({
        invoiceToEmails: ["a@x.com"],
        invoiceBccEmails: ["sales@feldart.com"],
        tags: ["yiddy"],
      }),
      rules,
    );
    expect(r.bcc).toEqual(["sales@feldart.com"]);
  });
});

describe("resolveRecipientsWithRules — statement channel", () => {
  it("reads statement_*_emails (not invoice_*) for the statement channel", () => {
    const r = resolveRecipientsWithRules(
      "statement",
      makeCustomer({
        invoiceToEmails: ["wrong@x.com"],
        statementToEmails: ["right@x.com"],
        statementCcEmails: ["cc@x.com"],
      }),
      [],
    );
    expect(r.to).toEqual(["right@x.com"]);
    expect(r.cc).toEqual(["cc@x.com"]);
  });

  it("applies bcc_statement rules and ignores bcc_invoice rules", () => {
    const rules: Array<{
      tag: string;
      action: RoutingRuleAction;
      value: string;
    }> = [
      { tag: "x", action: "bcc_invoice", value: "inv@x.com" },
      { tag: "x", action: "bcc_statement", value: "stmt@x.com" },
    ];
    const r = resolveRecipientsWithRules(
      "statement",
      makeCustomer({
        statementToEmails: ["a@x.com"],
        tags: ["x"],
      }),
      rules,
    );
    expect(r.bcc).toEqual(["stmt@x.com"]);
  });
});
