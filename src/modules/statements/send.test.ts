import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { buildOpenInvoiceConditions } from "./send.js";

// Serialize a drizzle SQL fragment to its parameterized text + params so we
// can assert on the generated WHERE clause without a live database.
const dialect = new MySqlDialect();
function sqlOf(cond: ReturnType<typeof buildOpenInvoiceConditions>) {
  // buildOpenInvoiceConditions never returns undefined here (it always has
  // at least the customer + balance conditions), but and() is typed as
  // SQL | undefined; narrow for the serializer.
  if (!cond) throw new Error("expected conditions");
  return dialect.sqlToQuery(cond);
}

describe("buildOpenInvoiceConditions", () => {
  it("filters to a single origin when one is supplied", () => {
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
  });

  it("does not constrain origin when none is supplied (blended)", () => {
    const { sql, params } = sqlOf(
      buildOpenInvoiceConditions("cust_123", undefined),
    );
    expect(sql).toContain("`customer_id`");
    expect(sql).toContain("`balance`");
    // No origin predicate in the blended case.
    expect(sql).not.toContain("`origin`");
    expect(params).not.toContain("tj");
    expect(params).not.toContain("feldart");
  });

  it("scopes to feldart when feldart is supplied", () => {
    const { sql, params } = sqlOf(
      buildOpenInvoiceConditions("cust_123", "feldart"),
    );
    expect(sql).toContain("`origin`");
    expect(params).toContain("feldart");
  });
});
