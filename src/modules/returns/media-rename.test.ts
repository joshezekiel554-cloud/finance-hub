import { describe, expect, it } from "vitest";
import { planCreditMemoRenames } from "./media-rename.js";

// When a credit memo is issued (or an existing one linked), every media file
// on the RMA is renamed from SKU-<RMA#>-n to SKU-<CM#>-n. The planner is
// pure; the executor talks to Drive + the DB.

describe("planCreditMemoRenames", () => {
  const photos = [
    { id: "p1", driveFileId: "f1", position: 0, sku: "ABC", filename: "ABC-RMA-0207-1.jpg" },
    { id: "p2", driveFileId: "f2", position: 1, sku: null, filename: "RMA-0207-2.mp4" },
    { id: "p3", driveFileId: "f3", position: 2, sku: "XYZ", filename: "XYZ-CM1042-3.png" },
  ];

  it("renames every file to SKU-<creditMemo>-<position+1> keeping its extension", () => {
    const plan = planCreditMemoRenames(photos, "CM1042");
    expect(plan).toEqual([
      { photoId: "p1", driveFileId: "f1", newFilename: "ABC-CM1042-1.jpg" },
      { photoId: "p2", driveFileId: "f2", newFilename: "CM1042-2.mp4" },
    ]);
  });

  it("skips files already carrying the credit memo name", () => {
    const plan = planCreditMemoRenames(photos, "CM1042");
    expect(plan.find((p) => p.photoId === "p3")).toBeUndefined();
  });

  it("returns an empty plan for a blank credit memo number", () => {
    expect(planCreditMemoRenames(photos, "  ")).toEqual([]);
  });
});
