import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, runScanSpy } = vi.hoisted(() => {
  const selectChain = {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([] as Array<{ value: string }>),
      }),
    }),
  };
  return {
    runScanSpy: vi.fn(),
    mockDb: { select: vi.fn(() => selectChain) },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../modules/ai-agent/scanner.js", () => ({ runScan: runScanSpy }));

import { autopilotScanHandler } from "./autopilot-scan.js";

beforeEach(() => {
  runScanSpy.mockReset();
});

describe("autopilotScanHandler", () => {
  it("skips when trigger='cron' and the flag is unset/empty", async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ value: "" }]) }),
      }),
    }));
    const job = { id: "j1", data: { trigger: "cron" as const } } as any;
    const res = await autopilotScanHandler(job);
    expect(res).toEqual({ ran: false, reason: "disabled" } as any);
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it("runs when trigger='manual' regardless of the flag", async () => {
    runScanSpy.mockResolvedValue({
      scanId: "scan-1",
      totalCandidates: 0,
      proposalsGenerated: 0,
    });
    const job = {
      id: "j2",
      data: { trigger: "manual" as const, triggeredByUserId: "u1" },
    } as any;
    const res = await autopilotScanHandler(job);
    expect(runScanSpy).toHaveBeenCalledWith("manual", "u1");
    expect((res as any).scanId).toBe("scan-1");
  });

  it("runs when trigger='cron' and the flag is 'true'", async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ value: "true" }]) }),
      }),
    }));
    runScanSpy.mockResolvedValue({
      scanId: "scan-2",
      totalCandidates: 1,
      proposalsGenerated: 1,
    });
    const job = { id: "j3", data: { trigger: "cron" as const } } as any;
    const res = await autopilotScanHandler(job);
    expect(runScanSpy).toHaveBeenCalled();
    expect((res as any).scanId).toBe("scan-2");
  });
});
