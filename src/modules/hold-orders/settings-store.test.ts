// Saving Settings: one upsert per changed key + exactly ONE audit_log row
// (who, before→after per changed key). Nothing changed → no writes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  upserts: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../db/index.js", async () => {
  const { auditLog } = await import("../../db/schema/audit.js");
  return {
    db: {
      insert: (table: unknown) => ({
        values: (v: Record<string, unknown>) => {
          if (table === auditLog) {
            h.audits.push(v);
            return Promise.resolve();
          }
          h.upserts.push(v);
          return { onDuplicateKeyUpdate: () => Promise.resolve() };
        },
      }),
    },
  };
});
vi.mock("../statements/settings.js", () => ({ loadAppSettings: vi.fn(async () => ({})) }));

import { saveHoldsConfig } from "./settings-store.js";
import { HOLDS_CONFIG_DEFAULTS, mergeHoldsConfig } from "./holds-settings.js";

beforeEach(() => {
  h.upserts.length = 0;
  h.audits.length = 0;
});

describe("saveHoldsConfig", () => {
  it("writes changed keys and one audit row with before/after per key", async () => {
    const merged = mergeHoldsConfig(HOLDS_CONFIG_DEFAULTS, { warnDays: 5, autoReleaseEmailsWarehouse: false });
    if (!merged.ok) throw new Error("invalid");
    const r = await saveHoldsConfig({
      current: HOLDS_CONFIG_DEFAULTS,
      next: merged.config,
      userId: "u-josh",
      actorEmail: "josh@feldart.com",
    });
    expect(r.changed.map((c) => c.key)).toEqual(["order_hold_warn_days", "holds_auto_release_emails_warehouse"]);
    expect(h.upserts).toEqual([
      { key: "order_hold_warn_days", value: "5", updatedByUserId: "u-josh" },
      { key: "holds_auto_release_emails_warehouse", value: "false", updatedByUserId: "u-josh" },
    ]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      userId: "u-josh",
      action: "holds_settings.updated",
      entityType: "app_setting",
      entityId: "holds_settings",
      before: { order_hold_warn_days: "7", holds_auto_release_emails_warehouse: "true" },
      after: { order_hold_warn_days: "5", holds_auto_release_emails_warehouse: "false", actorEmail: "josh@feldart.com" },
    });
  });

  it("no change → no writes, no audit", async () => {
    const r = await saveHoldsConfig({ current: HOLDS_CONFIG_DEFAULTS, next: HOLDS_CONFIG_DEFAULTS, userId: "u", actorEmail: null });
    expect(r.changed).toEqual([]);
    expect(h.upserts).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});
