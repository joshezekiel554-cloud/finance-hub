import { describe, expect, it } from "vitest";
import {
  parseOverdueConfig,
  DEFAULT_OVERDUE_THRESHOLD_GBP,
  DEFAULT_NO_CONTACT_DAYS,
} from "./overdue-alerts.js";

describe("parseOverdueConfig", () => {
  it("parses valid settings", () => {
    expect(
      parseOverdueConfig({
        order_overdue_threshold_gbp: "2500",
        order_overdue_no_contact_days: "21",
        order_overdue_alert_recipients: "a@x.com, b@y.com",
      }),
    ).toEqual({
      thresholdGbp: 2500,
      noContactDays: 21,
      recipients: "a@x.com, b@y.com",
    });
  });

  it("falls back to defaults on garbage / empty numbers", () => {
    const cfg = parseOverdueConfig({
      order_overdue_threshold_gbp: "",
      order_overdue_no_contact_days: "abc",
      order_overdue_alert_recipients: "",
    });
    expect(cfg.thresholdGbp).toBe(DEFAULT_OVERDUE_THRESHOLD_GBP);
    expect(cfg.noContactDays).toBe(DEFAULT_NO_CONTACT_DAYS);
    expect(cfg.recipients).toBe("");
  });

  it("rejects a zero/negative no-contact window (uses default)", () => {
    expect(
      parseOverdueConfig({
        order_overdue_threshold_gbp: "1000",
        order_overdue_no_contact_days: "0",
        order_overdue_alert_recipients: "x@x.com",
      }).noContactDays,
    ).toBe(DEFAULT_NO_CONTACT_DAYS);
  });

  it("allows a zero threshold (flag every overdue customer)", () => {
    expect(
      parseOverdueConfig({
        order_overdue_threshold_gbp: "0",
        order_overdue_no_contact_days: "14",
        order_overdue_alert_recipients: "x@x.com",
      }).thresholdGbp,
    ).toBe(0);
  });

  it("floors a fractional no-contact day count", () => {
    expect(
      parseOverdueConfig({
        order_overdue_threshold_gbp: "1000",
        order_overdue_no_contact_days: "14.9",
        order_overdue_alert_recipients: "x@x.com",
      }).noContactDays,
    ).toBe(14);
  });
});
