import { describe, it, expect } from "vitest";
import { originFromDocNumber, classifyCreditMemoOrigin } from "./origin";

describe("originFromDocNumber", () => {
  it("classifies 2-prefixed as tj", () =>
    expect(originFromDocNumber("20567")).toBe("tj"));
  it("classifies 1-prefixed as feldart", () =>
    expect(originFromDocNumber("10241")).toBe("feldart"));
  it("trims whitespace", () =>
    expect(originFromDocNumber("  20001 ")).toBe("tj"));
  it("defaults feldart for null/empty/undefined", () => {
    expect(originFromDocNumber(null)).toBe("feldart");
    expect(originFromDocNumber("")).toBe("feldart");
    expect(originFromDocNumber(undefined)).toBe("feldart");
  });
});

describe("classifyCreditMemoOrigin", () => {
  const feldartIds = new Set(["cm-from-returns"]);

  it("feldart when id is a known returns credit memo (even if docNumber looks TJ)", () =>
    expect(
      classifyCreditMemoOrigin(
        { qbCreditMemoId: "cm-from-returns", docNumber: "2999" },
        feldartIds,
      ),
    ).toEqual({ origin: "feldart", originSource: "auto" }));

  it("feldart when docNumber starts DC (damage credit)", () =>
    expect(
      classifyCreditMemoOrigin(
        { qbCreditMemoId: "x", docNumber: "DC00012" },
        feldartIds,
      ),
    ).toEqual({ origin: "feldart", originSource: "auto" }));

  it("feldart when docNumber starts dc lowercase", () =>
    expect(
      classifyCreditMemoOrigin(
        { qbCreditMemoId: "x", docNumber: "dc7" },
        feldartIds,
      ),
    ).toEqual({ origin: "feldart", originSource: "auto" }));

  it("tj by prefix 2", () =>
    expect(
      classifyCreditMemoOrigin(
        { qbCreditMemoId: "x", docNumber: "20003" },
        feldartIds,
      ),
    ).toEqual({ origin: "tj", originSource: "auto" }));

  it("feldart by prefix 1", () =>
    expect(
      classifyCreditMemoOrigin(
        { qbCreditMemoId: "x", docNumber: "10003" },
        feldartIds,
      ),
    ).toEqual({ origin: "feldart", originSource: "auto" }));

  it("needs_review when prefix is ambiguous", () =>
    expect(
      classifyCreditMemoOrigin(
        { qbCreditMemoId: "x", docNumber: "C-999" },
        feldartIds,
      ),
    ).toEqual({ origin: "feldart", originSource: "needs_review" }));

  it("needs_review when docNumber is null", () =>
    expect(
      classifyCreditMemoOrigin(
        { qbCreditMemoId: "x", docNumber: null },
        feldartIds,
      ),
    ).toEqual({ origin: "feldart", originSource: "needs_review" }));
});
