import { describe, expect, it } from "vitest";
import { bareHost, isHoldsHost, servesHoldsSpa } from "./holds-host.js";
import { handoffGate, handoffLandingUrl, holdsOrigin, safeNextPath } from "./hub-handoff.js";
import { holdsRoleFor, isHoldsOnlyEmail, can, HOLDS_ROLE_PERMISSIONS } from "../../modules/hold-orders/permissions.js";

describe("holds host routing", () => {
  it("matches the configured host, ignoring case + port", () => {
    expect(bareHost("HoldOrders.Feldart.com:443")).toBe("holdorders.feldart.com");
    expect(isHoldsHost("holdorders.feldart.com", "holdorders.feldart.com")).toBe(true);
    expect(isHoldsHost("finance.feldart.com", "holdorders.feldart.com")).toBe(false);
    expect(isHoldsHost(undefined, "holdorders.feldart.com")).toBe(false);
  });

  it("serves the SPA shell for page paths only", () => {
    expect(servesHoldsSpa("/")).toBe(true);
    expect(servesHoldsSpa("/?tab=at_risk")).toBe(true);
    expect(servesHoldsSpa("/rules")).toBe(true);
    expect(servesHoldsSpa("/index.html")).toBe(true);
    expect(servesHoldsSpa("/api/holds")).toBe(false);
    expect(servesHoldsSpa("/auth/hub?ht=x")).toBe(false);
    expect(servesHoldsSpa("/assets/holds-abc.js")).toBe(false);
    expect(servesHoldsSpa("/health")).toBe(false);
  });
});

describe("hub handoff on the holdorders host", () => {
  const cfg = {
    allowedEmails: "josh@feldart.com,hillel@feldart.com",
    adminEmails: "josh@feldart.com",
    holdsEmails: "sales@feldart.com",
  };
  it("holdorders host: admins + holds users only", () => {
    expect(handoffGate({ ...cfg, email: "sales@feldart.com", onHoldsHost: true }).allowed).toBe(true);
    expect(handoffGate({ ...cfg, email: "josh@feldart.com", onHoldsHost: true }).allowed).toBe(true);
    expect(handoffGate({ ...cfg, email: "hillel@feldart.com", onHoldsHost: true }).allowed).toBe(false);
  });
  it("finance host: unchanged ALLOWED_EMAILS gate — sales@ refused", () => {
    expect(handoffGate({ ...cfg, email: "sales@feldart.com", onHoldsHost: false }).allowed).toBe(false);
    expect(handoffGate({ ...cfg, email: "hillel@feldart.com", onHoldsHost: false }).allowed).toBe(true);
  });
  it("next stays on the holdorders origin; return=hub goes to the hub's holdorders tab", () => {
    const origin = holdsOrigin("https://finance.feldart.com", "holdorders.feldart.com");
    expect(origin).toBe("https://holdorders.feldart.com");
    expect(safeNextPath("/?tab=held", origin)).toBe("/?tab=held");
    expect(safeNextPath("https://evil.com/", origin)).toBe("/");
    expect(
      handoffLandingUrl({ next: "/", fromHub: true, returnTo: "hub", fetchDest: "document", hubOrigin: "https://hub.feldart.com", hubTab: "holds" }),
    ).toBe("https://hub.feldart.com/holds?p=%2F");
  });
});

describe("roles", () => {
  const cfg = { adminEmails: "josh@feldart.com", holdsEmails: "sales@feldart.com", allowedEmails: "josh@feldart.com,hillel@feldart.com" };
  it("resolves roles", () => {
    expect(holdsRoleFor("JOSH@feldart.com", cfg)).toBe("admin");
    expect(holdsRoleFor("sales@feldart.com", cfg)).toBe("holds");
    expect(holdsRoleFor("hillel@feldart.com", cfg)).toBeNull();
    expect(holdsRoleFor(null, cfg)).toBeNull();
  });
  it("holds-only = on HOLDORDERS_EMAILS and not a finance user", () => {
    expect(isHoldsOnlyEmail("sales@feldart.com", cfg)).toBe(true);
    expect(isHoldsOnlyEmail("josh@feldart.com", cfg)).toBe(false);
    expect(isHoldsOnlyEmail("hillel@feldart.com", cfg)).toBe(false);
  });
  it("holds role = option (b): everything but rules + finance links", () => {
    expect(HOLDS_ROLE_PERMISSIONS.holds).toEqual({
      view: true,
      note: true,
      hold: true,
      release: true,
      pause: true,
      recordOnly: true,
      seeBalances: true,
      editRules: false,
      editSettings: false,
      financeLinks: false,
    });
    expect(can("admin", "editRules")).toBe(true);
    expect(can(null, "view")).toBe(false);
  });
});
