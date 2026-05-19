import { beforeEach, describe, expect, it, vi } from "vitest";

// Queue of row-arrays to return from select().from().where().orderBy().limit().
// Each call to .limit() shifts one entry off the front.
const { mockDb, rowQueue } = vi.hoisted(() => {
  const rowQueue: unknown[][] = [];

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => Promise.resolve(rowQueue.shift() ?? []),
  };

  const select = vi.fn(() => selectChain);

  return { mockDb: { select }, rowQueue };
});

vi.mock("../../../db/index.js", () => ({ db: mockDb }));

import { findCandidates, isStillEligible } from "./ops-cron-fail.js";
import { SYNC_KINDS } from "../../../db/schema/audit.js";

beforeEach(() => {
  rowQueue.length = 0;
  mockDb.select.mockClear();
});

function row(
  status: "ok" | "failed" | "running" | "partial",
  startedAt: Date,
  errorMessage?: string,
) {
  return { id: "x", status, startedAt, errorMessage: errorMessage ?? null };
}

describe("findCandidates", () => {
  it("emits a candidate when 2 most recent runs both failed and 3rd was ok", async () => {
    // First kind (qb_full) gets the failing pattern; all others get empty arrays.
    rowQueue.push([
      row("failed", new Date("2026-05-19T10:00:00Z"), "Connection timeout after 30s"),
      row("failed", new Date("2026-05-19T08:00:00Z"), "Connection timeout after 30s"),
      row("ok", new Date("2026-05-19T06:00:00Z")),
    ]);
    for (let i = 1; i < SYNC_KINDS.length; i++) rowQueue.push([]);

    const candidates = await findCandidates();

    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.entityType).toBe("cron_job");
    expect(c.entityId).toBe("qb_full");
    expect(c.summary.jobKind).toBe("qb_full");
    expect(c.summary.lastFailureAt).toBe("2026-05-19T10:00:00.000Z");
    expect(c.summary.lastErrorExcerpt).toBe("Connection timeout after 30s");
  });

  it("does NOT emit when pattern is fail-then-ok (not consecutive)", async () => {
    rowQueue.push([
      row("failed", new Date("2026-05-19T10:00:00Z"), "err"),
      row("ok", new Date("2026-05-19T08:00:00Z")),
      row("failed", new Date("2026-05-19T06:00:00Z"), "err"),
    ]);
    for (let i = 1; i < SYNC_KINDS.length; i++) rowQueue.push([]);

    const candidates = await findCandidates();

    expect(candidates).toHaveLength(0);
  });
});

describe("isStillEligible", () => {
  it("returns true when kind still has 2 consecutive failures with prior ok", async () => {
    rowQueue.push([
      row("failed", new Date("2026-05-19T10:00:00Z")),
      row("failed", new Date("2026-05-19T08:00:00Z")),
      row("ok", new Date("2026-05-19T06:00:00Z")),
    ]);

    expect(await isStillEligible("qb_full")).toBe(true);
  });

  it("returns false when a recovery run has landed since the candidate was created", async () => {
    rowQueue.push([
      row("ok", new Date("2026-05-19T11:00:00Z")),
      row("failed", new Date("2026-05-19T10:00:00Z")),
      row("failed", new Date("2026-05-19T08:00:00Z")),
    ]);

    expect(await isStillEligible("qb_full")).toBe(false);
  });
});
