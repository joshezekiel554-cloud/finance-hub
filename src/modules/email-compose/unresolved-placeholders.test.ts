import { describe, expect, it } from "vitest";
import {
  findUnresolvedPlaceholders,
  renderTemplate,
} from "./template-vars.js";

describe("findUnresolvedPlaceholders", () => {
  it("names what a render left behind", () => {
    const body = renderTemplate("Total: {{total_value}} for {{customer_name}}", {
      customer_name: "Acme",
    });
    expect(body).toBe("Total: {{total_value}} for Acme");
    expect(findUnresolvedPlaceholders(body)).toEqual(["total_value"]);
  });

  it("returns nothing when every placeholder was supplied", () => {
    const body = renderTemplate("Total: {{total_value}}", {
      total_value: "$39.79",
    });
    expect(findUnresolvedPlaceholders(body)).toEqual([]);
  });

  it("dedupes across subject and body", () => {
    const subject = renderTemplate("RMA {{rma_number}}", {});
    const body = renderTemplate("{{rma_number}} — {{total_value}}", {});
    expect(findUnresolvedPlaceholders(subject, body).sort()).toEqual([
      "rma_number",
      "total_value",
    ]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(findUnresolvedPlaceholders("{{ total_value }}")).toEqual([
      "total_value",
    ]);
  });

  it("ignores text that only looks like a placeholder", () => {
    expect(findUnresolvedPlaceholders("{{}} {{ 123 }} {not_a_placeholder}")).toEqual(
      [],
    );
  });
});
