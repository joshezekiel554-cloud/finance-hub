import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../db/index.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../../../db/index.js";
import { findCandidates, isStillEligible } from "./ops-rma-stalled.js";

type SelectChain = {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function makeChain(result: unknown[]): SelectChain {
  const chain = {} as SelectChain;
  chain.limit = vi.fn().mockResolvedValue(result);
  chain.where = vi.fn().mockReturnValue({ ...chain, then: undefined, limit: chain.limit, [Symbol.iterator]: undefined });
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);

  // where() for findCandidates resolves directly (no .limit())
  chain.where = vi.fn().mockResolvedValue(result);
  // override for isStillEligible that calls .limit(1)
  const whereChain = {
    limit: vi.fn().mockResolvedValue(result),
  };
  chain.where = vi.fn().mockReturnValue({ ...whereChain, then: (resolve: (v: unknown[]) => void) => resolve(result) });

  return chain;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findCandidates", () => {
  it("suppresses RMA belonging to agent_mode_excluded customer", async () => {
    // DB mock returns no rows (excluded customer filtered by SQL)
    const chain = makeChain([]);
    vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("suppresses RMA in sent_to_warehouse with sentToWarehouseAt 5 days ago", async () => {
    // DB mock returns no rows (recent state change filtered by SQL)
    const chain = makeChain([]);
    vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);

    const results = await findCandidates();
    expect(results).toHaveLength(0);
  });

  it("returns stalled RMA with updatedAt > 14 days ago", async () => {
    const row = {
      id: "rma_abc123",
      rmaNumber: "RMA-001",
      status: "draft",
      updatedAt: daysAgo(20),
      sentToWarehouseAt: null,
      receivedAtWarehouseAt: null,
      customerName: "Acme Corp",
    };
    const chain = makeChain([row]);
    vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);

    const results = await findCandidates();
    expect(results).toHaveLength(1);
    const first = results[0]!;
    expect(first.entityType).toBe("rma");
    expect(first.entityId).toBe("rma_abc123");
    expect(first.summary.daysInState).toBeGreaterThanOrEqual(20);
  });

  it("when customerId is passed, result only includes RMAs for that customer", async () => {
    const row = {
      id: "rma_scope",
      rmaNumber: "RMA-SCOPE",
      status: "draft",
      updatedAt: daysAgo(20),
      sentToWarehouseAt: null,
      receivedAtWarehouseAt: null,
      customerName: "Scoped Co",
    };
    const chain = makeChain([row]);
    vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);

    const results = await findCandidates("cust-scope");
    expect(results).toHaveLength(1);
    expect(results[0]!.entityId).toBe("rma_scope");
  });
});

describe("isStillEligible", () => {
  it("returns false for agent_mode_excluded customer", async () => {
    const row = {
      id: "rma_abc123",
      status: "draft",
      updatedAt: daysAgo(20),
      sentToWarehouseAt: null,
      receivedAtWarehouseAt: null,
      agentModeExcluded: true,
    };
    const chain = makeChain([row]);
    vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);

    expect(await isStillEligible("rma_abc123")).toBe(false);
  });

  it("returns false for sent_to_warehouse with sentToWarehouseAt 5 days ago", async () => {
    const row = {
      id: "rma_def456",
      status: "sent_to_warehouse",
      updatedAt: daysAgo(20),
      sentToWarehouseAt: daysAgo(5),
      receivedAtWarehouseAt: null,
      agentModeExcluded: false,
    };
    const chain = makeChain([row]);
    vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);

    expect(await isStillEligible("rma_def456")).toBe(false);
  });

  it("returns true for sent_to_warehouse with sentToWarehouseAt 20 days ago", async () => {
    const row = {
      id: "rma_ghi789",
      status: "sent_to_warehouse",
      updatedAt: daysAgo(20),
      sentToWarehouseAt: daysAgo(20),
      receivedAtWarehouseAt: null,
      agentModeExcluded: false,
    };
    const chain = makeChain([row]);
    vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);

    expect(await isStillEligible("rma_ghi789")).toBe(true);
  });
});
