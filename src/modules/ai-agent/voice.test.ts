import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ db: { select: vi.fn() } }));

import { db } from "../../db/index.js";
import { buildDraftContext, DEFAULT_VOICE_GUIDE } from "./voice.js";

type Mock = ReturnType<typeof vi.fn>;

// Drizzle chain stub. Query order in buildDraftContext:
//   1. voice guide   .from().where().limit(1)
//   2. facts         .from().where()            (awaited, no limit)
//   3. customer ctx  .from().where().limit(1)   (only when customerId)
//   4. example       .from().where().limit(1)   (only when slug)
// .where() returns an object that is both awaitable AND has .limit().
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.where = () => ({
    limit: () => Promise.resolve(rows),
    then: (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r),
  });
  return c;
}

beforeEach(() => {
  (db.select as Mock).mockReset();
});

describe("buildDraftContext", () => {
  it("falls back to DEFAULT_VOICE_GUIDE when unset; resolves chase_l3 example", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([])) // voice guide: none
      .mockReturnValueOnce(chain([])) // facts: none
      .mockReturnValueOnce(chain([{ body: "L3 BODY" }])); // example
    const ctx = await buildDraftContext("chase_next", { tier: "CRITICAL" }, null);
    expect(ctx.voiceGuide).toBe(DEFAULT_VOICE_GUIDE);
    expect(ctx.exampleTemplate).toBe("L3 BODY");
  });

  it("partitions facts into global vs category by tag", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }])) // voice guide
      .mockReturnValueOnce(
        chain([
          { fact: "We close in August", tags: ["global"], active: true },
          { fact: "Chase: mention orders-on-hold", tags: ["chase_next"], active: true },
          { fact: "RMA fact", tags: ["ops_rma_stalled"], active: true },
        ]),
      ) // facts
      .mockReturnValueOnce(chain([{ body: "L1 BODY" }])); // example
    const ctx = await buildDraftContext("chase_next", { tier: "MEDIUM" }, null);
    expect(ctx.globalFacts).toEqual(["We close in August"]);
    expect(ctx.categoryFacts).toEqual(["Chase: mention orders-on-hold"]);
  });

  it("loads customer context when customerId is provided", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }])) // voice guide
      .mockReturnValueOnce(chain([])) // facts
      .mockReturnValueOnce(chain([{ ctx: "Pays late but always pays" }])); // customer (cadence_cold: no example)
    const ctx = await buildDraftContext("cadence_cold", {}, "cust_1");
    expect(ctx.customerContext).toBe("Pays late but always pays");
  });

  it("customerContext null when the column is empty", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ ctx: "" }]));
    const ctx = await buildDraftContext("cadence_cold", {}, "cust_1");
    expect(ctx.customerContext).toBeNull();
  });

  it("leaves corrections empty (Wave C) and does not query templates for cadence_cold", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }])) // voice guide
      .mockReturnValueOnce(chain([])); // facts (no customer, no example)
    const ctx = await buildDraftContext("cadence_cold", {}, null);
    expect(ctx.globalCorrections).toEqual([]);
    expect(ctx.categoryCorrections).toEqual([]);
    expect((db.select as Mock).mock.calls.length).toBe(2);
  });
});
