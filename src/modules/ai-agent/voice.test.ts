import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ db: { select: vi.fn() } }));

import { db } from "../../db/index.js";
import { buildDraftContext, DEFAULT_VOICE_GUIDE } from "./voice.js";

type Mock = ReturnType<typeof vi.fn>;

// Drizzle chain stub: .from().where().limit() resolves to `rows`.
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.where = () => c;
  c.limit = () => Promise.resolve(rows);
  return c;
}

beforeEach(() => {
  (db.select as Mock).mockReset();
});

describe("buildDraftContext", () => {
  it("falls back to DEFAULT_VOICE_GUIDE when the row is unset", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([])) // app_settings: no row
      .mockReturnValueOnce(chain([{ body: "L3 BODY" }])); // template
    const ctx = await buildDraftContext("chase_next", { tier: "CRITICAL" }, null);
    expect(ctx.voiceGuide).toBe(DEFAULT_VOICE_GUIDE);
  });

  it("uses the stored guide when present and non-empty", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "CUSTOM GUIDE" }]))
      .mockReturnValueOnce(chain([{ body: "L1 BODY" }]));
    const ctx = await buildDraftContext("chase_next", { tier: "MEDIUM" }, null);
    expect(ctx.voiceGuide).toBe("CUSTOM GUIDE");
  });

  it("maps chase tier CRITICAL -> chase_l3 body", async () => {
    (db.select as Mock)
      .mockReturnValueOnce(chain([{ value: "G" }]))
      .mockReturnValueOnce(chain([{ body: "L3 BODY" }]));
    const ctx = await buildDraftContext("chase_next", { tier: "CRITICAL" }, null);
    expect(ctx.exampleTemplate).toBe("L3 BODY");
  });

  it("returns null example for cadence_cold (no template) and never queries templates", async () => {
    (db.select as Mock).mockReturnValueOnce(chain([{ value: "G" }]));
    const ctx = await buildDraftContext("cadence_cold", {}, null);
    expect(ctx.exampleTemplate).toBeNull();
    expect((db.select as Mock).mock.calls.length).toBe(1); // only the voice-guide query
  });

  it("stubs facts/corrections/customerContext for later waves", async () => {
    (db.select as Mock).mockReturnValueOnce(chain([{ value: "G" }]));
    const ctx = await buildDraftContext("cadence_cold", {}, "cust_123");
    expect(ctx.globalFacts).toEqual([]);
    expect(ctx.categoryFacts).toEqual([]);
    expect(ctx.globalCorrections).toEqual([]);
    expect(ctx.categoryCorrections).toEqual([]);
    expect(ctx.customerContext).toBeNull();
  });
});
