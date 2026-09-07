import { describe, it, expect } from "vitest";
import {
  classifyTodayRow,
  type ClassifiableTodayRow,
} from "./invoicing-today-classify.js";

function row(overrides: Partial<ClassifiableTodayRow> = {}): ClassifiableTodayRow {
  return {
    gmailId: "gm-1",
    parseConfidence: 1,
    autoHidden: null,
    qbInvoice: { emailStatus: null },
    ...overrides,
  };
}

describe("classifyTodayRow", () => {
  it("sends a fully-parsed, unsent, undismissed row to Open", () => {
    expect(classifyTodayRow(row(), {})).toBe("open");
  });

  it("sends a row QBO reports as emailed to Sent", () => {
    const r = row({ qbInvoice: { emailStatus: "EmailSent" } });
    expect(classifyTodayRow(r, {})).toBe("sent");
  });

  it("sends a low-confidence parse to Unparseable", () => {
    expect(classifyTodayRow(row({ parseConfidence: 0.49 }), {})).toBe("unparseable");
    // The boundary itself is good enough to stay actionable.
    expect(classifyTodayRow(row({ parseConfidence: 0.5 }), {})).toBe("open");
  });

  it("sends an auto-hidden B2C paid-upfront row to Dismissed", () => {
    const r = row({ autoHidden: "b2c_paid_upfront" });
    expect(classifyTodayRow(r, {})).toBe("dismissed");
  });

  it("lets a real dismissal win over everything else", () => {
    const r = row({
      gmailId: "gm-dismissed",
      autoHidden: "b2c_paid_upfront",
      parseConfidence: 0.1,
      qbInvoice: { emailStatus: "EmailSent" },
    });
    expect(classifyTodayRow(r, { "gm-dismissed": { reason: "other" } })).toBe(
      "dismissed",
    );
  });

  it("lets auto-hidden beat both Sent and Unparseable", () => {
    const alsoSent = row({
      autoHidden: "b2c_paid_upfront",
      qbInvoice: { emailStatus: "EmailSent" },
    });
    expect(classifyTodayRow(alsoSent, {})).toBe("dismissed");

    const alsoUnparseable = row({
      autoHidden: "b2c_paid_upfront",
      parseConfidence: 0,
    });
    expect(classifyTodayRow(alsoUnparseable, {})).toBe("dismissed");
  });

  it("treats a missing QB doc as not-sent", () => {
    expect(classifyTodayRow(row({ qbInvoice: null }), {})).toBe("open");
  });

  it("ignores dismissal records belonging to other rows", () => {
    expect(classifyTodayRow(row({ gmailId: "gm-a" }), { "gm-b": {} })).toBe("open");
  });
});
