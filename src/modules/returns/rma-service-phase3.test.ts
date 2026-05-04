// Tests for Phase 3 service extensions:
//   - approveRma for seasonal (eligibility gate + override)
//   - approveRma for non-seasonal (eligibility informational, never gates)
//   - denyRma for seasonal (PDF generation + Drive upload, best-effort)
//   - generateWarehouseExport
//   - cancelWarehouseExport
//   - setWarehouseNumber
//   - manualMarkReceived
//   - overrideApproveRma

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must live before imports that trigger module resolution
// ---------------------------------------------------------------------------
const { mockDb, setSelectResults, resetMocks } = vi.hoisted(() => {
  let selectResultsQueue: unknown[][] = [];
  const setSelectResults = (queue: unknown[][]) => {
    selectResultsQueue = queue.slice();
  };
  const resetMocks = () => {
    selectResultsQueue = [];
  };

  type LazyNode = {
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
    catch: (reject: (e: unknown) => unknown) => Promise<unknown>;
    where: (...args: unknown[]) => LazyNode;
    orderBy: (...args: unknown[]) => LazyNode;
    limit: (...args: unknown[]) => LazyNode;
    from: (...args: unknown[]) => LazyNode;
  };

  const makeNode = (): LazyNode => ({
    then(resolve, reject) {
      return Promise.resolve(selectResultsQueue.shift() ?? []).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(selectResultsQueue.shift() ?? []).catch(reject);
    },
    where: () => makeNode(),
    orderBy: () => makeNode(),
    limit: () => makeNode(),
    from: () => makeNode(),
  });

  const select = vi.fn(() => makeNode());
  const update = (_table: unknown) => ({
    set: (_values: unknown) => ({
      where: (..._args: unknown[]) => Promise.resolve(),
    }),
  });
  const insert = (_table: unknown) => ({
    values: (_values: unknown) => Promise.resolve(),
  });
  const deleteFn = (_table: unknown) => ({
    where: (..._args: unknown[]) => Promise.resolve(),
  });

  return {
    mockDb: { select, update, insert, delete: deleteFn },
    setSelectResults,
    resetMocks,
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const recordActivityMock = vi.hoisted(() => vi.fn().mockResolvedValue("act-1"));
vi.mock("../crm/activity-ingester.js", () => ({ recordActivity: recordActivityMock }));

// Mock eligibility — default: passes threshold
const runEligibilityMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    customerSeasonalPurchases: "1000.00",
    alreadyReturnedThisSeason: "0.00",
    proposedCurrentSeason: "200.00",
    proposedPriorSeason: "0.00",
    proposedNonSeasonal: "0.00",
    proposedSubtotalCountingTowardThreshold: "200.00",
    totalReturnsThisSeason: "200.00",
    cumulativeReturnPct: "20.00",
    thresholdPct: "50.00",
    passesThreshold: true,
    perInvoice: [],
  }),
);
vi.mock("./eligibility.js", () => ({ runEligibility: runEligibilityMock }));

// Mock PDF generator — returns a buffer
const generateEligibilityPdfMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
);
vi.mock("./eligibility-pdf.js", () => ({ generateEligibilityPdf: generateEligibilityPdfMock }));

// Mock Extensiv export builder
const buildExtensivExportFileMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ filename: "acme_pesach-2026_returns.txt", content: "col0\t\t\tcol3\tSKU-A\t1\t\t\t\t\t\t\t\t\t" }),
);
vi.mock("./extensiv-export.js", () => ({ buildExtensivExportFile: buildExtensivExportFileMock }));

// Mock Drive client (dynamic import in rma-service.ts)
const renameFolderMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const uploadFileMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ fileId: "drive-pdf-001", viewUrl: "https://drive.google.com/file/d/drive-pdf-001/view", thumbnailUrl: null, mimeType: "application/pdf", sizeBytes: 1234 }),
);
vi.mock("../../integrations/google-drive/client.js", () => ({
  renameFolder: renameFolderMock,
  uploadFile: uploadFileMock,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import {
  approveRma,
  denyRma,
  generateWarehouseExport,
  cancelWarehouseExport,
  setWarehouseNumber,
  manualMarkReceived,
  overrideApproveRma,
} from "./rma-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDraftRma(overrides: Record<string, unknown> = {}) {
  return {
    id: "rma-100",
    customerId: "cust-1",
    qbCustomerId: "QB-1",
    returnType: "seasonal",
    status: "draft",
    seasonId: "season-1",
    rmaNumber: null,
    driveFolderId: null,
    thresholdOverridden: false,
    overrideReason: null,
    overrideByUserId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// approveRma — seasonal (eligibility gate)
// ---------------------------------------------------------------------------
describe("approveRma — seasonal", () => {
  beforeEach(() => {
    resetMocks();
    recordActivityMock.mockClear();
    runEligibilityMock.mockClear();
    buildExtensivExportFileMock.mockClear();
  });

  it("seasonal under threshold → passes, eligibility details saved, activity fired", async () => {
    runEligibilityMock.mockResolvedValueOnce({
      customerSeasonalPurchases: "1000.00",
      alreadyReturnedThisSeason: "0.00",
      proposedCurrentSeason: "200.00",
      proposedPriorSeason: "0.00",
      proposedNonSeasonal: "0.00",
      proposedSubtotalCountingTowardThreshold: "200.00",
      totalReturnsThisSeason: "200.00",
      cumulativeReturnPct: "20.00",
      thresholdPct: "50.00",
      passesThreshold: true,
      perInvoice: [],
    });

    setSelectResults([
      [makeDraftRma()],   // fetch RMA
      [],                 // fetch items for eligibility
      [{ id: "rma-100", status: "approved", returnType: "seasonal", customerId: "cust-1" }], // updated RMA
    ]);

    const result = await approveRma("rma-100", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) {
      expect(result.rma.status).toBe("approved");
    }
    expect(runEligibilityMock).toHaveBeenCalledOnce();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_approved", refId: "rma-100" }),
      expect.anything(),
    );
  });

  it("seasonal over threshold without override → returns ok:false with reason", async () => {
    runEligibilityMock.mockResolvedValueOnce({
      customerSeasonalPurchases: "1000.00",
      alreadyReturnedThisSeason: "0.00",
      proposedCurrentSeason: "600.00",
      proposedPriorSeason: "0.00",
      proposedNonSeasonal: "0.00",
      proposedSubtotalCountingTowardThreshold: "600.00",
      totalReturnsThisSeason: "600.00",
      cumulativeReturnPct: "60.00",
      thresholdPct: "50.00",
      passesThreshold: false,
      perInvoice: [],
    });

    setSelectResults([
      [makeDraftRma()],
      [], // items
    ]);

    const result = await approveRma("rma-100", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.reason).toMatch(/threshold/i);
      expect((result as { eligibilityBreakdown?: unknown }).eligibilityBreakdown).toBeDefined();
    }
    // Must not fire activity
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("seasonal over threshold with override but missing reason → returns ok:false", async () => {
    runEligibilityMock.mockResolvedValueOnce({
      customerSeasonalPurchases: "1000.00",
      alreadyReturnedThisSeason: "0.00",
      proposedCurrentSeason: "600.00",
      proposedPriorSeason: "0.00",
      proposedNonSeasonal: "0.00",
      proposedSubtotalCountingTowardThreshold: "600.00",
      totalReturnsThisSeason: "600.00",
      cumulativeReturnPct: "60.00",
      thresholdPct: "50.00",
      passesThreshold: false,
      perInvoice: [],
    });

    setSelectResults([
      [makeDraftRma()],
      [], // items
    ]);

    const result = await approveRma("rma-100", { userId: "user-1", overrideThreshold: true });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/override reason required/i);
  });

  it("seasonal over threshold with override + reason → succeeds, thresholdOverridden=true", async () => {
    runEligibilityMock.mockResolvedValueOnce({
      customerSeasonalPurchases: "1000.00",
      alreadyReturnedThisSeason: "0.00",
      proposedCurrentSeason: "600.00",
      proposedPriorSeason: "0.00",
      proposedNonSeasonal: "0.00",
      proposedSubtotalCountingTowardThreshold: "600.00",
      totalReturnsThisSeason: "600.00",
      cumulativeReturnPct: "60.00",
      thresholdPct: "50.00",
      passesThreshold: false,
      perInvoice: [],
    });

    setSelectResults([
      [makeDraftRma()],
      [], // items
      [{ id: "rma-100", status: "approved", returnType: "seasonal", customerId: "cust-1", thresholdOverridden: true }],
    ]);

    const result = await approveRma("rma-100", {
      userId: "user-1",
      overrideThreshold: true,
      overrideReason: "Long-standing customer, exception granted",
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) {
      expect(result.rma.status).toBe("approved");
      expect(result.rma.thresholdOverridden).toBe(true);
    }
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_approved" }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// approveRma — non-seasonal (informational eligibility only, never gates)
// ---------------------------------------------------------------------------
describe("approveRma — non_seasonal", () => {
  beforeEach(() => {
    resetMocks();
    recordActivityMock.mockClear();
    runEligibilityMock.mockClear();
  });

  it("non-seasonal over threshold still approves (eligibility informational only)", async () => {
    // Even if eligibility says over threshold, non-seasonal always proceeds
    runEligibilityMock.mockResolvedValueOnce({
      customerSeasonalPurchases: "1000.00",
      alreadyReturnedThisSeason: "0.00",
      proposedCurrentSeason: "0.00",
      proposedPriorSeason: "0.00",
      proposedNonSeasonal: "800.00",
      proposedSubtotalCountingTowardThreshold: "0.00",
      totalReturnsThisSeason: "0.00",
      cumulativeReturnPct: "0.00",
      thresholdPct: "50.00",
      passesThreshold: false, // doesn't matter for non-seasonal
      perInvoice: [],
    });

    setSelectResults([
      [makeDraftRma({ returnType: "non_seasonal" })],
      [], // items
      [{ id: "rma-100", status: "approved", returnType: "non_seasonal", customerId: "cust-1" }],
    ]);

    const result = await approveRma("rma-100", { userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) expect(result.rma.status).toBe("approved");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_approved" }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// denyRma — seasonal PDF generation (best-effort)
// ---------------------------------------------------------------------------
describe("denyRma — seasonal PDF", () => {
  beforeEach(() => {
    resetMocks();
    recordActivityMock.mockClear();
    generateEligibilityPdfMock.mockClear();
    uploadFileMock.mockClear();
    runEligibilityMock.mockClear();
  });

  it("seasonal deny generates eligibility PDF and saves Drive ID", async () => {
    setSelectResults([
      [makeDraftRma({ driveFolderId: "folder-abc" })],   // fetch RMA
      [], // items for PDF
      [{ displayName: "Acme Corp" }],                    // customer
      [{ name: "Pesach 2026" }],                         // season
      [{ id: "rma-100", status: "denied", returnType: "seasonal", denialPdfDriveId: "drive-pdf-001" }],
    ]);

    const result = await denyRma("rma-100", { userId: "user-1", reason: "Over threshold" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(generateEligibilityPdfMock).toHaveBeenCalledOnce();
    expect(uploadFileMock).toHaveBeenCalledOnce();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_denied", refId: "rma-100" }),
      expect.anything(),
    );
  });

  it("seasonal deny still succeeds even if Drive upload throws", async () => {
    uploadFileMock.mockRejectedValueOnce(new Error("Drive unavailable"));

    setSelectResults([
      [makeDraftRma({ driveFolderId: "folder-abc" })],
      [],
      [{ displayName: "Acme Corp" }],
      [{ name: "Pesach 2026" }],
      [{ id: "rma-100", status: "denied", returnType: "seasonal" }],
    ]);

    const result = await denyRma("rma-100", { userId: "user-1", reason: "Over threshold" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    // PDF was generated but upload failed; denial still went through
    expect(generateEligibilityPdfMock).toHaveBeenCalledOnce();
  });

  it("non-seasonal deny skips PDF generation entirely", async () => {
    setSelectResults([
      [makeDraftRma({ returnType: "non_seasonal" })],
      [{ id: "rma-100", status: "denied", returnType: "non_seasonal" }],
    ]);

    const result = await denyRma("rma-100", { userId: "user-1", reason: "Not eligible" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(generateEligibilityPdfMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// generateWarehouseExport
// ---------------------------------------------------------------------------
describe("generateWarehouseExport", () => {
  beforeEach(() => {
    resetMocks();
    recordActivityMock.mockClear();
    buildExtensivExportFileMock.mockClear();
  });

  it("approved → awaiting_warehouse_number, builds export file, fires activity", async () => {
    setSelectResults([
      [makeDraftRma({ status: "approved", returnType: "seasonal" })],
      [], // items
      [{ displayName: "Acme Corp", primaryEmail: "a@b.com" }], // customer
      [{ name: "Pesach 2026" }], // season
      [{ id: "rma-100", status: "awaiting_warehouse_number", returnType: "seasonal" }],
    ]);

    const result = await generateWarehouseExport({ rmaId: "rma-100", userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) {
      expect(result.rma.status).toBe("awaiting_warehouse_number");
      expect(result.exportFile).toBeDefined();
      expect(result.exportFile.filename).toMatch(/\.txt$/);
    }
    expect(buildExtensivExportFileMock).toHaveBeenCalledOnce();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_warehouse_export_generated", refId: "rma-100" }),
      expect.anything(),
    );
  });

  it("rejects transition from wrong state (draft)", async () => {
    setSelectResults([[makeDraftRma({ status: "draft", returnType: "seasonal" })]]);
    const result = await generateWarehouseExport({ rmaId: "rma-100", userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("rejects for damage RMAs (damage does not use warehouse export)", async () => {
    setSelectResults([[makeDraftRma({ status: "approved", returnType: "damage" })]]);
    const result = await generateWarehouseExport({ rmaId: "rma-100", userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/damage/i);
  });

  it("returns null when RMA not found", async () => {
    setSelectResults([[]]);
    const result = await generateWarehouseExport({ rmaId: "missing", userId: "user-1" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cancelWarehouseExport
// ---------------------------------------------------------------------------
describe("cancelWarehouseExport", () => {
  beforeEach(() => {
    resetMocks();
    recordActivityMock.mockClear();
  });

  it("awaiting_warehouse_number → approved, fires activity", async () => {
    setSelectResults([
      [makeDraftRma({ status: "awaiting_warehouse_number", returnType: "seasonal" })],
      [{ id: "rma-100", status: "approved", returnType: "seasonal" }],
    ]);

    const result = await cancelWarehouseExport({ rmaId: "rma-100", userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) expect(result.rma.status).toBe("approved");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_warehouse_export_cancelled", refId: "rma-100" }),
      expect.anything(),
    );
  });

  it("rejects transition from wrong state (approved)", async () => {
    setSelectResults([[makeDraftRma({ status: "approved", returnType: "seasonal" })]]);
    const result = await cancelWarehouseExport({ rmaId: "rma-100", userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("returns null when RMA not found", async () => {
    setSelectResults([[]]);
    const result = await cancelWarehouseExport({ rmaId: "missing", userId: "user-1" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setWarehouseNumber
// ---------------------------------------------------------------------------
describe("setWarehouseNumber", () => {
  beforeEach(() => {
    resetMocks();
    recordActivityMock.mockClear();
    renameFolderMock.mockClear();
  });

  it("awaiting_warehouse_number → sent_to_warehouse, sets rmaNumber + extensivTxNumber, fires activity", async () => {
    setSelectResults([
      [makeDraftRma({ status: "awaiting_warehouse_number", returnType: "seasonal" })],
      [{ id: "rma-100", status: "sent_to_warehouse", rmaNumber: "EXT-12345", extensivTxNumber: "EXT-12345" }],
    ]);

    const result = await setWarehouseNumber({ rmaId: "rma-100", userId: "user-1", txNumber: "EXT-12345" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) {
      expect(result.rma.status).toBe("sent_to_warehouse");
      expect(result.rma.rmaNumber).toBe("EXT-12345");
    }
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rma_sent_to_warehouse", meta: { txNumber: "EXT-12345" } }),
      expect.anything(),
    );
  });

  it("renames Drive folder to txNumber when driveFolderId exists", async () => {
    setSelectResults([
      [makeDraftRma({ status: "awaiting_warehouse_number", returnType: "seasonal", driveFolderId: "folder-xyz" })],
      [{ id: "rma-100", status: "sent_to_warehouse", rmaNumber: "EXT-999" }],
    ]);

    await setWarehouseNumber({ rmaId: "rma-100", userId: "user-1", txNumber: "EXT-999" });
    expect(renameFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: "folder-xyz", newName: "EXT-999" }),
    );
  });

  it("rejects transition from wrong state", async () => {
    setSelectResults([[makeDraftRma({ status: "approved", returnType: "seasonal" })]]);
    const result = await setWarehouseNumber({ rmaId: "rma-100", userId: "user-1", txNumber: "EXT-000" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("returns null when RMA not found", async () => {
    setSelectResults([[]]);
    const result = await setWarehouseNumber({ rmaId: "missing", userId: "user-1", txNumber: "EXT-000" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// manualMarkReceived
// ---------------------------------------------------------------------------
describe("manualMarkReceived", () => {
  beforeEach(() => {
    resetMocks();
    recordActivityMock.mockClear();
  });

  it("sent_to_warehouse → received, fires activity with source:manual", async () => {
    setSelectResults([
      [makeDraftRma({ status: "sent_to_warehouse", returnType: "seasonal" })],
      [{ id: "rma-100", status: "received", returnType: "seasonal" }],
    ]);

    const result = await manualMarkReceived({ rmaId: "rma-100", userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) expect(result.rma.status).toBe("received");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rma_received_at_warehouse",
        meta: { source: "manual" },
        refId: "rma-100",
      }),
      expect.anything(),
    );
  });

  it("rejects transition from wrong state (approved)", async () => {
    setSelectResults([[makeDraftRma({ status: "approved", returnType: "seasonal" })]]);
    const result = await manualMarkReceived({ rmaId: "rma-100", userId: "user-1" });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("returns null when RMA not found", async () => {
    setSelectResults([[]]);
    const result = await manualMarkReceived({ rmaId: "missing", userId: "user-1" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// overrideApproveRma
// ---------------------------------------------------------------------------
describe("overrideApproveRma", () => {
  beforeEach(() => {
    resetMocks();
    recordActivityMock.mockClear();
  });

  it("denied → approved for seasonal, sets thresholdOverridden=true, fires activity", async () => {
    setSelectResults([
      [makeDraftRma({ status: "denied", returnType: "seasonal", denialReason: "Over threshold" })],
      [{ id: "rma-100", status: "approved", returnType: "seasonal", thresholdOverridden: true }],
    ]);

    const result = await overrideApproveRma({
      rmaId: "rma-100",
      userId: "user-1",
      reason: "Exception approved by management",
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result && result.ok) {
      expect(result.rma.status).toBe("approved");
      expect(result.rma.thresholdOverridden).toBe(true);
    }
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rma_override_approved",
        refId: "rma-100",
      }),
      expect.anything(),
    );
  });

  it("rejects override_approve for non-seasonal RMA (state machine guard)", async () => {
    setSelectResults([[makeDraftRma({ status: "denied", returnType: "damage" })]]);
    const result = await overrideApproveRma({
      rmaId: "rma-100",
      userId: "user-1",
      reason: "Test override",
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/seasonal/i);
  });

  it("rejects transition from wrong state (draft)", async () => {
    setSelectResults([[makeDraftRma({ status: "draft", returnType: "seasonal" })]]);
    const result = await overrideApproveRma({
      rmaId: "rma-100",
      userId: "user-1",
      reason: "Test",
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toMatch(/Cannot transition/);
  });

  it("returns null when RMA not found", async () => {
    setSelectResults([[]]);
    const result = await overrideApproveRma({ rmaId: "missing", userId: "user-1", reason: "nope" });
    expect(result).toBeNull();
  });
});
