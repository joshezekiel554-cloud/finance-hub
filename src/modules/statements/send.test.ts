import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  booksForOrigin,
  buildBookSections,
  buildOpenInvoiceConditions,
  buildStatementScopeConditions,
} from "./send.js";
import type { Invoice } from "../../db/schema/invoices.js";
import type {
  StatementCreditMemoInput,
  StatementInvoiceInput,
} from "./pdf.js";

// Serialize a drizzle SQL fragment to its parameterized text + params so we
// can assert on the generated WHERE clause without a live database.
const dialect = new MySqlDialect();
function sqlOf(cond: ReturnType<typeof buildOpenInvoiceConditions>) {
  // buildOpenInvoiceConditions never returns undefined here (it always has
  // the customer + balance + origin conditions), but and() is typed as
  // SQL | undefined; narrow for the serializer.
  if (!cond) throw new Error("expected conditions");
  return dialect.sqlToQuery(cond);
}

describe("buildOpenInvoiceConditions", () => {
  it("scopes to tj when tj is supplied", () => {
    const { sql, params } = sqlOf(
      buildOpenInvoiceConditions("cust_123", "tj"),
    );
    // Customer + balance + origin all present.
    expect(sql).toContain("`customer_id`");
    expect(sql).toContain("`balance`");
    expect(sql).toContain("`origin`");
    // The origin value is bound as a parameter.
    expect(params).toContain("tj");
    expect(params).toContain("cust_123");
    expect(params).not.toContain("feldart");
  });

  it("scopes to feldart when feldart is supplied", () => {
    const { sql, params } = sqlOf(
      buildOpenInvoiceConditions("cust_123", "feldart"),
    );
    expect(sql).toContain("`origin`");
    expect(params).toContain("feldart");
    expect(params).not.toContain("tj");
  });

  it("always constrains origin — there is no blended query shape", () => {
    // Origin is required at the type level; verify both books produce an
    // origin predicate so a blended (no-origin) statement can't exist.
    for (const origin of ["feldart", "tj"] as const) {
      const { sql, params } = sqlOf(
        buildOpenInvoiceConditions("cust_123", origin),
      );
      expect(sql).toContain("`origin`");
      expect(params).toContain(origin);
    }
  });
});

describe("buildStatementScopeConditions", () => {
  it("matches the single-book condition for feldart/tj", () => {
    for (const origin of ["feldart", "tj"] as const) {
      const scoped = sqlOf(buildStatementScopeConditions("cust_123", origin));
      const single = sqlOf(buildOpenInvoiceConditions("cust_123", origin));
      expect(scoped.sql).toBe(single.sql);
      expect(scoped.params).toEqual(single.params);
    }
  });

  it("drops the origin predicate for 'both' (all open invoices)", () => {
    const { sql, params } = sqlOf(
      buildStatementScopeConditions("cust_123", "both"),
    );
    expect(sql).toContain("`customer_id`");
    expect(sql).toContain("`balance`");
    expect(sql).not.toContain("`origin`");
    expect(params).toContain("cust_123");
    expect(params).not.toContain("feldart");
    expect(params).not.toContain("tj");
  });
});

describe("booksForOrigin", () => {
  it("expands 'both' to feldart-then-tj (render order)", () => {
    expect(booksForOrigin("both")).toEqual(["feldart", "tj"]);
    expect(booksForOrigin("feldart")).toEqual(["feldart"]);
    expect(booksForOrigin("tj")).toEqual(["tj"]);
  });
});

describe("buildBookSections", () => {
  const inv = (id: string, origin: "feldart" | "tj"): Invoice =>
    ({
      id,
      qbInvoiceId: `qb-${id}`,
      customerId: "cust_123",
      origin,
      balance: "10.00",
    }) as unknown as Invoice;
  const cm = (qbId: string): StatementCreditMemoInput => ({
    qbId,
    docNumber: null,
    txnDate: null,
    balance: 5,
  });
  const hydrate = (i: Invoice): StatementInvoiceInput => ({
    ...i,
    invoiceLink: null,
  });

  it("returns undefined for single-book scopes", () => {
    const invoicesByBook = new Map<"feldart" | "tj", Invoice[]>([
      ["feldart", [inv("a", "feldart")]],
    ]);
    const creditsByBook = new Map<
      "feldart" | "tj",
      StatementCreditMemoInput[]
    >([
      ["feldart", []],
      ["tj", []],
    ]);
    expect(
      buildBookSections("feldart", invoicesByBook, creditsByBook, hydrate),
    ).toBeUndefined();
    expect(
      buildBookSections("tj", invoicesByBook, creditsByBook, hydrate),
    ).toBeUndefined();
  });

  it("builds labelled feldart + tj sections for 'both'", () => {
    const invoicesByBook = new Map<"feldart" | "tj", Invoice[]>([
      ["feldart", [inv("a", "feldart"), inv("b", "feldart")]],
      ["tj", [inv("c", "tj")]],
    ]);
    const creditsByBook = new Map<
      "feldart" | "tj",
      StatementCreditMemoInput[]
    >([
      ["feldart", [cm("cm-1")]],
      ["tj", []],
    ]);
    const books = buildBookSections(
      "both",
      invoicesByBook,
      creditsByBook,
      hydrate,
    );
    expect(books).toHaveLength(2);
    expect(books![0]!.label).toBe("Feldart");
    expect(books![0]!.openInvoices).toHaveLength(2);
    expect(books![0]!.creditMemos).toHaveLength(1);
    expect(books![1]!.label).toBe("Torah Judaica (passed to Feldart for collection)");
    expect(books![1]!.summaryLabel).toBe("Torah Judaica");
    expect(books![1]!.openInvoices).toHaveLength(1);
  });

  it("drops a book with nothing to show (empty TJ → single clean box)", () => {
    const invoicesByBook = new Map<"feldart" | "tj", Invoice[]>([
      ["feldart", [inv("a", "feldart")]],
      ["tj", []],
    ]);
    const creditsByBook = new Map<
      "feldart" | "tj",
      StatementCreditMemoInput[]
    >([
      ["feldart", []],
      ["tj", []],
    ]);
    const books = buildBookSections(
      "both",
      invoicesByBook,
      creditsByBook,
      hydrate,
    );
    expect(books).toHaveLength(1);
    expect(books![0]!.label).toBe("Feldart");
  });

  it("keeps a book that only has credits (credit-only TJ still shows)", () => {
    const invoicesByBook = new Map<"feldart" | "tj", Invoice[]>([
      ["feldart", [inv("a", "feldart")]],
      ["tj", []],
    ]);
    const creditsByBook = new Map<
      "feldart" | "tj",
      StatementCreditMemoInput[]
    >([
      ["feldart", []],
      ["tj", [cm("cm-tj")]],
    ]);
    const books = buildBookSections(
      "both",
      invoicesByBook,
      creditsByBook,
      hydrate,
    );
    expect(books).toHaveLength(2);
    expect(books![1]!.label).toBe("Torah Judaica (passed to Feldart for collection)");
    expect(books![1]!.openInvoices).toHaveLength(0);
    expect(books![1]!.creditMemos).toHaveLength(1);
  });
});
