import { describe, expect, it } from "vitest";
import {
  drawerActions,
  holdConfirmLabel,
  parseTab,
  previewSummary,
  releaseBody,
  releaseConfirmLabel,
  type EmailPreview,
} from "./view";
import { NEW_RULE_DRAFT, displayNumbers, draftToBody } from "./rule-form";
import { HOLDS_ROLE_PERMISSIONS } from "../../../modules/hold-orders/permissions";

const wh: EmailPreview = { to: "wh@x", role: "warehouse", template: "hold_alert", subject: "S", when: "now" };
const cust: EmailPreview = { to: "c@x", role: "customer", template: "hold_notice", subject: "S2", when: "next_sync" };

describe("view helpers", () => {
  it("tabs fall back to held", () => {
    expect(parseTab("at_risk")).toBe("at_risk");
    expect(parseTab("nope")).toBe("held");
    expect(parseTab(null)).toBe("held");
  });

  it("preview summary says exactly who", () => {
    expect(previewSummary([], false)).toBe("Nobody will be emailed.");
    expect(previewSummary([wh, cust], false)).toBe("warehouse emailed now; customer emailed on the next sync");
    expect(previewSummary([wh], true)).toContain("shadow mode");
  });

  it("button labels", () => {
    expect(holdConfirmLabel("record_only", [wh])).toBe("Record hold — tell nobody");
    expect(holdConfirmLabel("notify", [wh])).toBe("Hold & send these emails");
    expect(releaseConfirmLabel("notify")).toBe("Release & email warehouse");
    expect(releaseConfirmLabel("record_only")).toBe("Mark released — already told");
  });

  it("drawer actions follow state + permissions", () => {
    const held = { holdState: "on_hold", pausedUntil: null };
    const a = drawerActions(held, HOLDS_ROLE_PERMISSIONS.holds);
    expect(a).toMatchObject({ canHold: false, canRelease: true, canPause: true, canResume: false, canNote: true, canRecordOnly: true });
    const b = drawerActions({ holdState: "none", pausedUntil: null }, HOLDS_ROLE_PERMISSIONS.holds);
    expect(b).toMatchObject({ canHold: true, canRelease: false, canPause: false });
    const viewOnly = { ...HOLDS_ROLE_PERMISSIONS.holds, hold: false, release: false, pause: false };
    expect(drawerActions(held, viewOnly)).toMatchObject({ canRelease: false, canPause: false, canNote: true });
    const paused = drawerActions({ holdState: "on_hold", pausedUntil: "2999-01-01T00:00:00Z" }, HOLDS_ROLE_PERMISSIONS.holds);
    expect(paused.canResume).toBe(true);
  });

  it("release body: paid outside QBO needs details", () => {
    const d = { paidOutside: true, method: "cheque" as const, paidNote: "", note: "" };
    expect(releaseBody("record_only", d).ok).toBe(false);
    expect(releaseBody("record_only", { ...d, paidNote: " chq 77 " })).toEqual({
      ok: true,
      body: { mode: "record_only", paidOutsideQbo: { method: "cheque", note: "chq 77" } },
    });
    expect(releaseBody("notify", { ...d, paidOutside: false })).toEqual({ ok: true, body: { mode: "notify" } });
  });
});

describe("rule form", () => {
  it("new rules default to no customer emails, warehouse on, auto-release on", () => {
    expect(NEW_RULE_DRAFT).toMatchObject({ autoStartLadder: false, notifyWarehouse: true, autoReleaseOnPayment: true });
  });
  it("presets show their fixed numbers; never shows none", () => {
    expect(displayNumbers({ ...NEW_RULE_DRAFT, preset: "vip_90_110" })).toEqual({ termsDays: 90, holdWhenInvoiceDaysOver: 110, minBalance: 50 });
    expect(displayNumbers({ ...NEW_RULE_DRAFT, preset: "never" })).toBeNull();
  });
  it("custom validation mirrors the server", () => {
    expect(draftToBody({ ...NEW_RULE_DRAFT, preset: "custom", termsDays: "60", holdWhenInvoiceDaysOver: "30" }).ok).toBe(false);
    expect(draftToBody({ ...NEW_RULE_DRAFT, preset: "custom", termsDays: "abc", holdWhenInvoiceDaysOver: "30" }).ok).toBe(false);
    const ok = draftToBody({ ...NEW_RULE_DRAFT, preset: "custom", termsDays: "45", holdWhenInvoiceDaysOver: "60", minBalance: "200" });
    expect(ok).toMatchObject({ ok: true, body: { preset: "custom", termsDays: 45, holdWhenInvoiceDaysOver: 60, minBalance: 200 } });
  });
});
