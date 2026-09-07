// Unit tests for planInvoiceUpdate — the pure decision function behind the
// invoice update path in upsertInvoice.
//
// Backstory: the update path's drift check and UPDATE set both omitted
// customerId, so a QB-side customer merge (which repoints CustomerRef on
// every moved invoice) left local rows attached to the merged-away customer
// forever. Found 2026-08-20 when "Malchut Judaica - Monroe OLD2" (#41) was
// merged into "Malchut Judaica - Monroe" (#1796) in the QB UI and finance
// hub kept all five open invoices on the defunct OLD2 row.

import { describe, expect, it } from "vitest";
import { planInvoiceUpdate } from "./sync.js";

type Before = Parameters<typeof planInvoiceUpdate>[0];
type Desired = Parameters<typeof planInvoiceUpdate>[1];

function before(overrides: Partial<Before> = {}): Before {
  return {
    customerId: "cust-keeper",
    docNumber: "18843",
    issueDate: new Date("2026-07-13"),
    dueDate: new Date("2026-08-08"),
    total: "453.00",
    balance: "453.00",
    status: "overdue",
    customerMemo: null,
    syncToken: "3",
    originSource: "prefix",
    emailStatus: null,
    deliveryTime: null,
    deliveryError: null,
    ...overrides,
  };
}

function desired(overrides: Partial<Desired> = {}): Desired {
  return {
    customerId: "cust-keeper",
    docNumber: "18843",
    issueDate: new Date("2026-07-13"),
    dueDate: new Date("2026-08-08"),
    total: "453.00",
    balance: "453.00",
    status: "overdue",
    customerMemo: null,
    syncToken: "3",
    origin: "feldart",
    emailStatus: null,
    deliveryTime: null,
    deliveryError: null,
    lastSyncedAt: new Date("2026-08-20T15:19:00Z"),
    ...overrides,
  };
}

describe("planInvoiceUpdate", () => {
  it("returns null when nothing QBO-authoritative changed", () => {
    expect(planInvoiceUpdate(before(), desired())).toBeNull();
  });

  it("repoints customerId when QBO moved the invoice to another customer (merge)", () => {
    const plan = planInvoiceUpdate(
      before({ customerId: "cust-old2" }),
      desired({ customerId: "cust-keeper" }),
    );
    expect(plan).not.toBeNull();
    expect(plan?.customerId).toBe("cust-keeper");
  });

  it("a customerId-only change is enough to trigger an update", () => {
    // Same balance/status/syncToken — only the customer ref moved. This is
    // exactly what a QB merge of a fully-synced invoice looks like.
    const plan = planInvoiceUpdate(
      before({ customerId: "cust-old2" }),
      desired({ customerId: "cust-keeper" }),
    );
    expect(plan).not.toBeNull();
  });

  it("still updates on balance drift and carries customerId in the set", () => {
    const plan = planInvoiceUpdate(before(), desired({ balance: "0.00" }));
    expect(plan?.balance).toBe("0.00");
    expect(plan?.customerId).toBe("cust-keeper");
  });

  it("never touches sent_at / sent_via (locally-owned fields)", () => {
    const plan = planInvoiceUpdate(
      before({ customerId: "cust-old2" }),
      desired(),
    );
    expect(plan).not.toBeNull();
    expect(plan).not.toHaveProperty("sentAt");
    expect(plan).not.toHaveProperty("sentVia");
  });

  it("re-derives origin unless the row was manually classified", () => {
    const auto = planInvoiceUpdate(
      before(),
      desired({ balance: "0.00", origin: "tj" }),
    );
    expect(auto?.origin).toBe("tj");

    const manual = planInvoiceUpdate(
      before({ originSource: "manual" }),
      desired({ balance: "0.00", origin: "tj" }),
    );
    expect(manual).not.toBeNull();
    expect(manual).not.toHaveProperty("origin");
  });

  it("compares dates by calendar day, not object identity", () => {
    // Two distinct Date objects for the same day must not register drift.
    expect(
      planInvoiceUpdate(
        before({ issueDate: new Date("2026-07-13") }),
        desired({ issueDate: new Date("2026-07-13") }),
      ),
    ).toBeNull();
  });
});
