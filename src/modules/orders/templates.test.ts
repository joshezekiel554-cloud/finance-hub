import { describe, expect, it } from "vitest";
import {
  ORDER_EMAIL_DEFAULTS,
  ORDER_TEMPLATE_KEYS,
  SAMPLE_VARS,
  loadOrderTemplate,
  renderOrderTemplate,
} from "./templates.js";

describe("renderOrderTemplate", () => {
  it("substitutes known placeholders", () => {
    const out = renderOrderTemplate(
      { subject: "Order {{order_number}}", body: "Hi {{customer_name}}" },
      { order_number: "#18672", customer_name: "Acme" },
    );
    expect(out.subject).toBe("Order #18672");
    expect(out.text).toBe("Hi Acme");
  });

  it("strips unknown / unrendered {{x}} to blank", () => {
    const out = renderOrderTemplate(
      { subject: "S {{nope}}", body: "Body {{also_missing}} end" },
      {},
    );
    expect(out.subject).toBe("S");
    expect(out.text).toBe("Body  end");
    expect(out.subject).not.toContain("{{");
    expect(out.text).not.toContain("{{");
  });

  it("strips malformed / empty braces too", () => {
    const out = renderOrderTemplate({ subject: "x", body: "a {{}} b {{ }} c" }, {});
    expect(out.text).not.toContain("{{");
  });

  it("blank line becomes a paragraph; single newline becomes <br/>", () => {
    const out = renderOrderTemplate(
      { subject: "s", body: "Line one\nLine two\n\nNew para" },
      {},
    );
    expect(out.html).toBe(
      "<p>Line one<br/>Line two</p>\n<p>New para</p>",
    );
  });

  it("renders all 5 defaults against SAMPLE_VARS with no leftover {{", () => {
    for (const key of ORDER_TEMPLATE_KEYS) {
      const out = renderOrderTemplate(ORDER_EMAIL_DEFAULTS[key], SAMPLE_VARS);
      expect(out.subject, `${key} subject`).not.toContain("{{");
      expect(out.text, `${key} body`).not.toContain("{{");
      expect(out.html, `${key} html`).not.toContain("{{");
      expect(out.subject.length, `${key} subject non-empty`).toBeGreaterThan(0);
      expect(out.text.length, `${key} body non-empty`).toBeGreaterThan(0);
    }
  });
});

describe("loadOrderTemplate (override-vs-default selection)", () => {
  it("returns the default when no override is stored", () => {
    const tpl = loadOrderTemplate({}, "hold_notice");
    expect(tpl).toEqual(ORDER_EMAIL_DEFAULTS.hold_notice);
  });

  it("returns the default when the stored override is blank/whitespace", () => {
    const tpl = loadOrderTemplate(
      { order_tpl_hold_notice_subject: "  ", order_tpl_hold_notice_body: "" },
      "hold_notice",
    );
    expect(tpl).toEqual(ORDER_EMAIL_DEFAULTS.hold_notice);
  });

  it("uses the operator override when present (per field)", () => {
    const tpl = loadOrderTemplate(
      {
        order_tpl_hold_notice_subject: "Custom subject {{order_number}}",
        // body left blank → falls back to default body
      },
      "hold_notice",
    );
    expect(tpl.subject).toBe("Custom subject {{order_number}}");
    expect(tpl.body).toBe(ORDER_EMAIL_DEFAULTS.hold_notice.body);
  });

  it("uses both overrides when both set", () => {
    const tpl = loadOrderTemplate(
      {
        order_tpl_order_cancelled_subject: "Cancelled: {{order_number}}",
        order_tpl_order_cancelled_body: "Your order is gone.",
      },
      "order_cancelled",
    );
    expect(tpl.subject).toBe("Cancelled: {{order_number}}");
    expect(tpl.body).toBe("Your order is gone.");
  });
});
