import { describe, expect, it } from "vitest";
import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import type { User } from "../../db/schema/auth.js";
import {
  buildTemplateVars,
  formatMoney,
  renderTemplate,
  type TemplateVars,
} from "./template-vars.js";

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  const now = new Date();
  return {
    id: "cust-1",
    qbCustomerId: "QB-1",
    displayName: "Acme Ltd",
    primaryEmail: "billing@acme.test",
    billingEmails: null,
    paymentTerms: "Net 30",
    holdStatus: "active",
    shopifyCustomerId: null,
    mondayItemId: null,
    customerType: "b2b",
    balance: "1234.56",
    overdueBalance: "324.00",
    internalNotes: null,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date();
  return {
    id: "inv-1",
    qbInvoiceId: "QB-INV-1",
    customerId: "cust-1",
    docNumber: "18307",
    issueDate: null,
    dueDate: null,
    total: "324.00",
    balance: "324.00",
    status: "overdue",
    sentAt: null,
    sentVia: null,
    syncToken: "0",
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    name: "Joshua",
    email: "joshua@feldart.com",
    emailVerified: null,
    image: null,
    ...overrides,
  };
}

describe("renderTemplate", () => {
  it("substitutes a single placeholder", () => {
    expect(renderTemplate("Hi {{customer_name}}", { customer_name: "Acme" }))
      .toBe("Hi Acme");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Hi {{ customer_name }}", { customer_name: "Acme" }))
      .toBe("Hi Acme");
    expect(renderTemplate("Hi {{   customer_name   }}", { customer_name: "Acme" }))
      .toBe("Hi Acme");
  });

  it("replaces every occurrence of the same variable", () => {
    const out = renderTemplate(
      "{{company_name}} — {{customer_name}} owes you. — {{company_name}}",
      { company_name: "Feldart", customer_name: "Acme" },
    );
    expect(out).toBe("Feldart — Acme owes you. — Feldart");
  });

  it("leaves unknown variables intact", () => {
    expect(renderTemplate("Hi {{unknown_var}}", {})).toBe("Hi {{unknown_var}}");
    expect(renderTemplate("a {{ ghost }} b", { customer_name: "x" }))
      .toBe("a {{ ghost }} b");
  });

  it("treats an explicitly-undefined value as unknown (left intact)", () => {
    const vars: Record<string, string | undefined> = { customer_name: undefined };
    expect(renderTemplate("Hi {{customer_name}}", vars))
      .toBe("Hi {{customer_name}}");
  });

  it("substitutes empty-string values (not 'undefined')", () => {
    expect(renderTemplate("Hi[{{thread_subject}}]", { thread_subject: "" }))
      .toBe("Hi[]");
  });

  it("is idempotent: render(render(t)) === render(t)", () => {
    const tpl = "Hi {{customer_name}}, balance {{open_balance}} ({{unknown}})";
    const vars = { customer_name: "Acme", open_balance: "$10.00" };
    const once = renderTemplate(tpl, vars);
    const twice = renderTemplate(once, vars);
    expect(twice).toBe(once);
  });

  it("does not match malformed placeholders", () => {
    expect(renderTemplate("{customer_name}", { customer_name: "Acme" }))
      .toBe("{customer_name}");
    expect(renderTemplate("{{customer_name", { customer_name: "Acme" }))
      .toBe("{{customer_name");
  });

  it("renders the statement template body with statement_table HTML", () => {
    const tpl = "<p>Hi {{customer_name}}</p>{{statement_table}}<p>End</p>";
    const out = renderTemplate(tpl, {
      customer_name: "Acme",
      statement_table: "<table><tr><td>row</td></tr></table>",
    });
    expect(out).toBe(
      "<p>Hi Acme</p><table><tr><td>row</td></tr></table><p>End</p>",
    );
  });
});

describe("formatMoney", () => {
  it("formats a plain number with comma thousands and 2 decimals", () => {
    expect(formatMoney(1234.56)).toBe("$1,234.56");
  });

  it("formats a numeric string the same as a number", () => {
    expect(formatMoney("1234.56")).toBe("$1,234.56");
  });

  it("rounds half-up to 2 decimals", () => {
    expect(formatMoney(0.005)).toBe("$0.01");
    expect(formatMoney(0.004)).toBe("$0.00");
    expect(formatMoney(2.345)).toBe("$2.35");
  });

  it("returns $0.00 for null / undefined / empty / NaN", () => {
    expect(formatMoney(null)).toBe("$0.00");
    expect(formatMoney(undefined)).toBe("$0.00");
    expect(formatMoney("")).toBe("$0.00");
    expect(formatMoney("not-a-number")).toBe("$0.00");
  });

  it("formats large values", () => {
    expect(formatMoney(1234567.89)).toBe("$1,234,567.89");
  });
});

describe("buildTemplateVars", () => {
  it("populates all the basic fields from raw rows", () => {
    const customer = makeCustomer();
    const oldest = makeInvoice({
      docNumber: "18307",
      balance: "324.00",
      dueDate: null,
    });
    const vars = buildTemplateVars({
      customer,
      openInvoices: [oldest],
      user: makeUser(),
      oldestUnpaid: oldest,
    });

    expect(vars.customer_name).toBe("Acme Ltd");
    expect(vars.primary_email).toBe("billing@acme.test");
    expect(vars.open_balance).toBe("$1,234.56");
    expect(vars.overdue_balance).toBe("$324.00");
    expect(vars.oldest_unpaid_invoice).toBe("18307");
    expect(vars.oldest_unpaid_amount).toBe("$324.00");
    expect(vars.user_name).toBe("Joshua");
    expect(vars.company_name).toBe("Feldart");
    expect(vars.thread_subject).toBe("");
  });

  it("computes days_overdue from oldestUnpaid.dueDate against `now`", () => {
    const oldest = makeInvoice({ dueDate: new Date("2026-04-17T00:00:00.000Z") });
    const vars = buildTemplateVars({
      customer: makeCustomer(),
      openInvoices: [oldest],
      user: makeUser(),
      oldestUnpaid: oldest,
      now: new Date("2026-04-29T12:00:00.000Z"),
    });
    expect(vars.days_overdue).toBe("12");
  });

  it("returns days_overdue = '0' when oldestUnpaid is null", () => {
    const vars = buildTemplateVars({
      customer: makeCustomer({ overdueBalance: "0.00" }),
      openInvoices: [],
      user: makeUser(),
      oldestUnpaid: null,
    });
    expect(vars.days_overdue).toBe("0");
    expect(vars.oldest_unpaid_invoice).toBe("");
    expect(vars.oldest_unpaid_amount).toBe("$0.00");
  });

  it("returns days_overdue = '0' when oldestUnpaid has no dueDate", () => {
    const oldest = makeInvoice({ dueDate: null });
    const vars = buildTemplateVars({
      customer: makeCustomer(),
      openInvoices: [oldest],
      user: makeUser(),
      oldestUnpaid: oldest,
    });
    expect(vars.days_overdue).toBe("0");
  });

  it("returns days_overdue = '0' when due date is in the future", () => {
    const oldest = makeInvoice({ dueDate: new Date("2099-01-01T00:00:00.000Z") });
    const vars = buildTemplateVars({
      customer: makeCustomer(),
      openInvoices: [oldest],
      user: makeUser(),
      oldestUnpaid: oldest,
      now: new Date("2026-04-29T12:00:00.000Z"),
    });
    expect(vars.days_overdue).toBe("0");
  });

  it("derives oldestUnpaid from openInvoices when not provided explicitly", () => {
    const newer = makeInvoice({
      id: "inv-2",
      docNumber: "18400",
      balance: "100.00",
      dueDate: new Date("2026-04-25T00:00:00.000Z"),
    });
    const older = makeInvoice({
      id: "inv-1",
      docNumber: "18307",
      balance: "324.00",
      dueDate: new Date("2026-04-10T00:00:00.000Z"),
    });
    const paid = makeInvoice({
      id: "inv-0",
      docNumber: "18000",
      balance: "0.00",
      dueDate: new Date("2026-01-01T00:00:00.000Z"),
    });
    const vars = buildTemplateVars({
      customer: makeCustomer(),
      openInvoices: [newer, older, paid],
      user: makeUser(),
      now: new Date("2026-04-29T12:00:00.000Z"),
    });
    expect(vars.oldest_unpaid_invoice).toBe("18307");
    expect(vars.oldest_unpaid_amount).toBe("$324.00");
    expect(vars.days_overdue).toBe("19");
  });

  it("handles a customer with null primaryEmail and null docNumber", () => {
    const vars = buildTemplateVars({
      customer: makeCustomer({ primaryEmail: null }),
      openInvoices: [],
      user: makeUser({ name: null }),
      oldestUnpaid: makeInvoice({ docNumber: null, dueDate: null }),
    });
    expect(vars.primary_email).toBe("");
    expect(vars.user_name).toBe("");
    expect(vars.oldest_unpaid_invoice).toBe("");
  });

  it("renders end-to-end through renderTemplate using buildTemplateVars output", () => {
    const oldest = makeInvoice({
      docNumber: "18307",
      balance: "324.00",
      dueDate: new Date("2026-04-17T00:00:00.000Z"),
    });
    const vars: TemplateVars = buildTemplateVars({
      customer: makeCustomer(),
      openInvoices: [oldest],
      user: makeUser(),
      oldestUnpaid: oldest,
      now: new Date("2026-04-29T12:00:00.000Z"),
    });
    const tpl =
      "Hi {{customer_name}}, you owe {{open_balance}} " +
      "({{overdue_balance}} overdue, oldest {{oldest_unpaid_invoice}} " +
      "{{days_overdue}} days). — {{user_name}}, {{company_name}}";
    const out = renderTemplate(tpl, vars);
    expect(out).toBe(
      "Hi Acme Ltd, you owe $1,234.56 ($324.00 overdue, oldest 18307 12 days). — Joshua, Feldart",
    );
  });
});
