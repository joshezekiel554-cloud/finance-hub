import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ db: { select: vi.fn() } }));

import { db } from "../../db/index.js";
import { buildDraftContext, DEFAULT_VOICE_GUIDE } from "./voice.js";

type Mock = ReturnType<typeof vi.fn>;

// Drizzle chain stub. Query order in buildDraftContext:
//   1. voice guide   .from().where().limit(1)
//   2. facts         .from().where()            (awaited, no limit)
//   3. corrections   .from().where()            (awaited, no limit)
//   4. customer ctx  .from().where().limit(1)   (only when customerId)
//   5. example       .from().where().limit(1)   (only when slug)
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
      .mockReturnValueOnce(chain([])) // corrections: none
      .mockReturnValueOnce(chain([{ body: "L3 BODY" }])); // example
    const ctx = await buildDraftContext("chase_next", { tier: "CRITICAL" }, null);
    expect(ctx.voiceGuide).toBe(DEFAULT_VOICE_GUIDE);
    expect(ctx.exampleTemplate).toBe("L3 BODY");
  });

  it("resolves the TJ ladder for tj_chase (CRITICAL → tj_l3 example)", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([])) // voice guide: none
      .mockReturnValueOnce(chain([])) // facts: none
      .mockReturnValueOnce(chain([])) // corrections: none
      .mockReturnValueOnce(chain([{ body: "TJ L3 BODY" }])); // example
    const ctx = await buildDraftContext("tj_chase", { tier: "CRITICAL" }, null);
    expect(ctx.exampleTemplate).toBe("TJ L3 BODY");
  });

  it("tj_dispute_nudge has no example template (no template query)", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }])) // voice guide
      .mockReturnValueOnce(chain([])) // facts
      .mockReturnValueOnce(chain([])); // corrections (no customer, no example)
    const ctx = await buildDraftContext("tj_dispute_nudge", {}, null);
    expect(ctx.exampleTemplate).toBeNull();
    expect((db.select as Mock).mock.calls.length).toBe(3);
  });

  it("partitions facts and corrections by tag", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }])) // voice guide
      .mockReturnValueOnce(
        chain([
          { fact: "We close in August", tags: ["global"], active: true },
          { fact: "Chase: mention orders-on-hold", tags: ["chase_next"], active: true },
        ]),
      ) // facts
      .mockReturnValueOnce(
        chain([
          { correction: "Never say 'kindly'", tags: ["global"], status: "active" },
          { correction: "Chase: no legal threats at L1", tags: ["chase_next"], status: "active" },
        ]),
      ) // corrections
      .mockReturnValueOnce(chain([{ body: "L1 BODY" }])); // example
    const ctx = await buildDraftContext("chase_next", { tier: "MEDIUM" }, null);
    expect(ctx.globalFacts).toEqual(["We close in August"]);
    expect(ctx.categoryFacts).toEqual(["Chase: mention orders-on-hold"]);
    expect(ctx.globalCorrections).toEqual(["Never say 'kindly'"]);
    expect(ctx.categoryCorrections).toEqual(["Chase: no legal threats at L1"]);
  });

  it("loads customer context when customerId is provided", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }])) // voice guide
      .mockReturnValueOnce(chain([])) // facts
      .mockReturnValueOnce(chain([])) // corrections
      .mockReturnValueOnce(chain([{ ctx: "Pays late but always pays" }])); // customer (cadence_cold: no example)
    const ctx = await buildDraftContext("cadence_cold", {}, "cust_1");
    expect(ctx.customerContext).toBe("Pays late but always pays");
  });

  it("customerContext null when the column is empty", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ ctx: "", notes: "" }]));
    const ctx = await buildDraftContext("cadence_cold", {}, "cust_1");
    expect(ctx.customerContext).toBeNull();
  });

  it("folds internal notes into customerContext alongside AI context", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(
        chain([{ ctx: "Pays late but always pays", notes: "Owner is Shmuel; prefers phone" }]),
      );
    const ctx = await buildDraftContext("cadence_cold", {}, "cust_1");
    expect(ctx.customerContext).toContain("Pays late but always pays");
    expect(ctx.customerContext).toContain("Owner is Shmuel; prefers phone");
  });

  it("surfaces internal notes even when AI context is empty", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ ctx: null, notes: "Disputes every invoice — verify before chasing" }]));
    const ctx = await buildDraftContext("cadence_cold", {}, "cust_1");
    expect(ctx.customerContext).toContain("Disputes every invoice — verify before chasing");
  });

  it("leaves corrections empty when none are active; no template query for cadence_cold", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }])) // voice guide
      .mockReturnValueOnce(chain([])) // facts
      .mockReturnValueOnce(chain([])); // corrections (no customer, no example)
    const ctx = await buildDraftContext("cadence_cold", {}, null);
    expect(ctx.globalCorrections).toEqual([]);
    expect(ctx.categoryCorrections).toEqual([]);
    expect((db.select as Mock).mock.calls.length).toBe(3);
  });
});
