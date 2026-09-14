import { describe, expect, it } from "vitest";
import {
  buildSessionCookie,
  buildHubEmbeddedCookie,
  isEmailAllowed,
  safeNextPath,
} from "./hub-handoff.js";

describe("safeNextPath", () => {
  it("keeps a plain in-app path", () => {
    expect(safeNextPath("/customers/abc?tab=orders")).toBe("/customers/abc?tab=orders");
  });
  it("falls back to / for empty, external, protocol-relative or non-path input", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("https://evil.example/x")).toBe("/");
    expect(safeNextPath("//evil.example/x")).toBe("/");
    expect(safeNextPath("customers")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
  });
  it("never bounces back into the handoff route itself", () => {
    expect(safeNextPath("/auth/hub?ht=abc")).toBe("/");
  });
});

describe("isEmailAllowed", () => {
  it("matches case-insensitively against the comma list", () => {
    expect(isEmailAllowed("Leibel@Feldart.com", "a@b.c, leibel@feldart.com")).toBe(true);
    expect(isEmailAllowed("nobody@feldart.com", "a@b.c, leibel@feldart.com")).toBe(false);
  });
  it("fails closed on an empty list", () => {
    expect(isEmailAllowed("a@b.c", "")).toBe(false);
  });
});

describe("buildSessionCookie", () => {
  it("uses the __Secure- Auth.js cookie name over https with the flags Auth.js sets", () => {
    const c = buildSessionCookie({ token: "tok123", expires: new Date("2026-10-14T00:00:00Z"), secure: true });
    expect(c.startsWith("__Secure-authjs.session-token=tok123;")).toBe(true);
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Expires=Wed, 14 Oct 2026 00:00:00 GMT");
  });
  it("uses the plain cookie name without Secure over http (dev)", () => {
    const c = buildSessionCookie({ token: "tok123", expires: new Date("2026-10-14T00:00:00Z"), secure: false });
    expect(c.startsWith("authjs.session-token=tok123;")).toBe(true);
    expect(c).not.toContain("Secure");
  });
});

describe("buildHubEmbeddedCookie", () => {
  it("is readable by the SPA (no HttpOnly) and session-scoped", () => {
    const c = buildHubEmbeddedCookie(true);
    expect(c.startsWith("hub_embedded=1;")).toBe(true);
    expect(c).not.toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Expires=");
  });
});
