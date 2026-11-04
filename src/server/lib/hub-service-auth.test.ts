import { describe, expect, it } from "vitest";
import { mintHubToken } from "../../lib/hub-token.js";
import { checkHubServiceAuth, financeLinkSecret, hubSecrets } from "./hub-service-auth.js";

const NOW = 1_800_000_000;
const SHARED = "s".repeat(48);
const FINANCE = "f".repeat(48);
const ALLOWED = "joshezekiel554@gmail.com";

const bearer = (secret: string, over: Partial<Parameters<typeof mintHubToken>[0]> = {}) =>
  `Bearer ${mintHubToken({ email: ALLOWED, aud: "finance", ttlSeconds: 60, secret, nowSeconds: NOW, scope: "service", ...over })}`;

const check = (auth: string, secrets: string[], scope?: Parameters<typeof checkHubServiceAuth>[1]["scope"]) =>
  checkHubServiceAuth(auth, { secrets, allowedEmails: ALLOWED, nowSeconds: NOW, scope });

describe("per-app hub secret cutover", () => {
  it("lists finance's own secret first, the shared one until retired", () => {
    expect(hubSecrets({ HUB_SECRET_FINANCE: FINANCE, HUB_SSO_SECRET: SHARED, HUB_SHARED_SECRET_RETIRED: false })).toEqual([FINANCE, SHARED]);
    expect(hubSecrets({ HUB_SECRET_FINANCE: FINANCE, HUB_SSO_SECRET: SHARED, HUB_SHARED_SECRET_RETIRED: true })).toEqual([FINANCE]);
    expect(hubSecrets({ HUB_SECRET_FINANCE: undefined, HUB_SSO_SECRET: SHARED, HUB_SHARED_SECRET_RETIRED: false })).toEqual([SHARED]);
    expect(financeLinkSecret({ HUB_SECRET_FINANCE: FINANCE, HUB_SSO_SECRET: SHARED })).toBe(FINANCE);
    expect(financeLinkSecret({ HUB_SECRET_FINANCE: undefined, HUB_SSO_SECRET: SHARED })).toBe(SHARED);
  });

  it("accepts tokens signed with either secret during cutover, only finance's after", () => {
    expect(check(bearer(FINANCE), [FINANCE, SHARED]).ok).toBe(true);
    expect(check(bearer(SHARED), [FINANCE, SHARED]).ok).toBe(true);
    expect(check(bearer(SHARED), [FINANCE])).toMatchObject({ ok: false, status: 401 });
    expect(check(bearer("x".repeat(48)), [FINANCE, SHARED])).toMatchObject({ ok: false, status: 401 });
    expect(check(bearer(FINANCE), [])).toMatchObject({ ok: false, status: 503 });
  });
});

describe("confirm-scoped tokens", () => {
  const confirm = (pid: string) => bearer(FINANCE, { scope: "confirm", pid, ops: true });
  const settle = (proposalId: string, confirmRequired = false) => ({ kind: "settle" as const, proposalId, confirmRequired });

  it("are refused on every non-settle route (tools, reports, hub-summary)", () => {
    expect(check(confirm("p1"), [FINANCE])).toMatchObject({ ok: false, status: 401 });
  });

  it("settle a proposal only when bound to that proposal id", () => {
    const ok = check(confirm("p1"), [FINANCE], settle("p1"));
    expect(ok.ok && ok.claims.pid).toBe("p1");
    expect(check(confirm("p2"), [FINANCE], settle("p1"))).toMatchObject({ ok: false, status: 401 });
    expect(check(bearer(FINANCE, { scope: "confirm" }), [FINANCE], settle("p1"))).toMatchObject({ ok: false });
  });

  it("service tokens still settle until the hub flips confirm tokens on", () => {
    expect(check(bearer(FINANCE, { ops: true }), [FINANCE], settle("p1")).ok).toBe(true);
    expect(check(bearer(FINANCE, { ops: true }), [FINANCE], settle("p1", true))).toMatchObject({ ok: false, status: 401 });
    expect(check(confirm("p1"), [FINANCE], settle("p1", true)).ok).toBe(true);
  });

  it("user (hand-off) tokens never pass the service gate", () => {
    expect(check(bearer(FINANCE, { scope: "user" }), [FINANCE])).toMatchObject({ ok: false, status: 401 });
    expect(check(bearer(FINANCE, { scope: "user" }), [FINANCE], settle("p1"))).toMatchObject({ ok: false, status: 401 });
  });
});
