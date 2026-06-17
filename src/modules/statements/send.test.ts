import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { bridgeContentNewlines, buildOpenInvoiceConditions } from "./send.js";

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

describe("bridgeContentNewlines", () => {
  it("bridges single newlines between content (a run-on invoice list)", () => {
    const body =
      "Invoice #17426 $602.50 View and pay\nInvoice #17447 $240.00 View and pay\nInvoice #17481 $688.75 View and pay";
    const out = bridgeContentNewlines(body);
    // Every row boundary becomes a <br/> (consecutive rows, not every other).
    expect(out.match(/<br\/>/g)?.length).toBe(2);
    expect(out).toContain("View and pay<br/>");
  });

  it("leaves tag-adjacent newlines alone (no double gaps in well-formed HTML)", () => {
    const html = "<p>Hi Mendy,</p>\n<p>Please find your statement.</p>";
    expect(bridgeContentNewlines(html)).toBe(html);
  });

  it("leaves blank-line paragraph breaks alone", () => {
    const text = "First line.\n\nSecond block.";
    expect(bridgeContentNewlines(text)).toBe(text);
  });

  it("bridges a newline between text and following bold/inline content", () => {
    const html = "Total open balance is\n<strong>$21,114.24</strong>";
    // Newline is immediately before a tag (`<`) → left alone (the tag handles
    // layout); we only bridge text-to-text runs.
    expect(bridgeContentNewlines(html)).toBe(html);
  });
});

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
