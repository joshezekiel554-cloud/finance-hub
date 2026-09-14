import { describe, expect, it } from "vitest";
import {
  ConsumedJtiGuard,
  buildSessionCookie,
  buildHubEmbeddedCookie,
  isEmailAllowed,
  renderHandoffErrorPage,
  safeNextPath,
} from "./hub-handoff.js";

describe("ConsumedJtiGuard", () => {
  // The handoff token rides in a query string, so it lands in nginx access
  // logs; within its TTL a log reader could replay it. Burn each jti once.
  it("accepts a jti the first time and rejects the replay", () => {
    const g = new ConsumedJtiGuard();
    expect(g.consume("abc", 1_000)).toBe(true);
    expect(g.consume("abc", 1_001)).toBe(false);
    expect(g.consume("def", 1_001)).toBe(true);
  });
  it("forgets entries after the retention window so memory stays bounded", () => {
    const g = new ConsumedJtiGuard(600);
    expect(g.consume("abc", 1_000)).toBe(true);
    expect(g.consume("abc", 1_000 + 601)).toBe(true);
    expect(g.size).toBe(1);
  });
  it("treats an empty jti as unusable (never accepted)", () => {
    const g = new ConsumedJtiGuard();
    expect(g.consume("", 1_000)).toBe(false);
  });
});

describe("renderHandoffErrorPage", () => {
  it("is a small HTML page with the reason and an open-in-new-tab link, no Google button", () => {
    const html = renderHandoffErrorPage({
      reason: "This account is not allowed in Finance.",
      publicUrl: "https://finance.feldart.com",
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("This account is not allowed in Finance.");
    expect(html).toContain('href="https://finance.feldart.com/" target="_blank"');
    expect(html).toContain("Open Finance in a new tab");
    expect(html.toLowerCase()).not.toContain("google");
  });
  it("escapes the reason so a crafted message can't inject markup", () => {
    const html = renderHandoffErrorPage({ reason: "<script>x</script>", publicUrl: "https://f.example" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

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
  it("judges the OUTCOME, not the characters: WHATWG strips tab/CR/LF so '/\\t/evil.com' resolves off-origin", () => {
    expect(safeNextPath("/\t/evil.com")).toBe("/");
    expect(safeNextPath("/\r\n/evil.com/x")).toBe("/");
    expect(safeNextPath("/ok\t/path")).toBe("/ok/path");
  });
  it("normalises against the configured origin", () => {
    expect(safeNextPath("/customers?x=1#h", "https://finance.feldart.com")).toBe("/customers?x=1#h");
    expect(safeNextPath("https://finance.feldart.com/customers", "https://finance.feldart.com")).toBe("/");
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
