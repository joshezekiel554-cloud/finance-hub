import { describe, expect, it } from "vitest";
import { flattenReport, normalizeQboQuery, QBO_CALLS_PER_MINUTE, scrubQbo, takeQboSlot } from "./qbo-tools.js";

describe("qbo_query validation", () => {
  it("accepts one SELECT and caps MAXRESULTS at 100", () => {
    expect(normalizeQboQuery("SELECT * FROM Bill")).toBe("SELECT * FROM Bill MAXRESULTS 50");
    expect(normalizeQboQuery("select Id from Invoice   where Balance > '0' maxresults 500")).toBe(
      "select Id from Invoice where Balance > '0' MAXRESULTS 100",
    );
    expect(normalizeQboQuery("SELECT * FROM Invoice MAXRESULTS 10")).toBe("SELECT * FROM Invoice MAXRESULTS 10");
    expect(normalizeQboQuery("SELECT COUNT(*) FROM Invoice")).toBe("SELECT COUNT(*) FROM Invoice");
  });

  it("refuses anything that isn't a single SELECT", () => {
    for (const q of ["", "SELECT * FROM Employee", "select * from  preferences", "SELECT * FROM CompanyInfo", "DELETE FROM Invoice", "SELECT * FROM Invoice; SELECT * FROM Bill", "UPDATE Customer SET x=1", " update x", "x".repeat(1501)]) {
      expect(() => normalizeQboQuery(q)).toThrow();
    }
  });
});

describe("qbo_report flattening", () => {
  it("turns the report tree into indented lines with section totals", () => {
    const flat = flattenReport({
      Header: { ReportName: "ProfitAndLoss", StartPeriod: "2026-10-01", EndPeriod: "2026-10-31", ReportBasis: "Accrual" },
      Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
      Rows: {
        Row: [
          {
            Header: { ColData: [{ value: "Income" }, { value: "" }] },
            Rows: { Row: [{ ColData: [{ value: "Sales" }, { value: "1000.00" }] }] },
            Summary: { ColData: [{ value: "Total Income" }, { value: "1000.00" }] },
          },
          { Summary: { ColData: [{ value: "Net Income" }, { value: "400.00" }] } },
        ],
      },
    });
    expect(flat.title).toBe("ProfitAndLoss 2026-10-01 to 2026-10-31 (Accrual)");
    expect(flat.columns).toEqual(["", "Total"]);
    expect(flat.lines).toEqual(["Income", "  Sales | 1000.00", "Total Income | 1000.00", "Net Income | 400.00"]);
  });
});

describe("qbo per-member limiter", () => {
  it("allows 30 calls a rolling minute per member", () => {
    const seen = new Map<string, number[]>();
    for (let i = 0; i < QBO_CALLS_PER_MINUTE; i++) expect(takeQboSlot("josh", 1_000 + i, seen)).toBe(true);
    expect(takeQboSlot("josh", 2_000, seen)).toBe(false);
    expect(takeQboSlot("leibel", 2_000, seen)).toBe(true);
    expect(takeQboSlot("josh", 61_001, seen)).toBe(true);
  });
});

describe("qbo scrub", () => {
  it("drops raw signed attachment links at any depth", () => {
    expect(scrubQbo([{ Id: "1", TempDownloadUri: "https://x", Nested: { TempDownloadUri: "y", Keep: 1 } }])).toEqual([
      { Id: "1", Nested: { Keep: 1 } },
    ]);
  });
});
