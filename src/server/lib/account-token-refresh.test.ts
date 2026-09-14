import { describe, expect, it } from "vitest";
import { accountTokenPatch } from "./account-token-refresh.js";

// Auth.js only writes the `account` row on first link; later sign-ins (with
// prompt=consent + access_type=offline) mint a fresh refresh token that was
// silently thrown away, so the stored grant aged until Google answered
// invalid_grant. This helper decides what a sign-in should write back.

describe("accountTokenPatch", () => {
  const base = {
    provider: "google",
    providerAccountId: "sub-1",
    access_token: "at-new",
    refresh_token: "rt-new",
    expires_at: 1_800_000_000,
    scope: "openid email https://www.googleapis.com/auth/drive",
    token_type: "bearer",
    id_token: "idt",
  };

  it("writes fresh tokens + scope when a refresh token was minted", () => {
    expect(accountTokenPatch(base)).toEqual({
      access_token: "at-new",
      refresh_token: "rt-new",
      expires_at: 1_800_000_000,
      scope: base.scope,
    });
  });

  it("keeps the stored refresh token when Google didn't return a new one", () => {
    const patch = accountTokenPatch({ ...base, refresh_token: undefined });
    expect(patch).toEqual({
      access_token: "at-new",
      expires_at: 1_800_000_000,
      scope: base.scope,
    });
    expect(patch).not.toHaveProperty("refresh_token");
  });

  it("returns null when there's no access token to store", () => {
    expect(accountTokenPatch({ ...base, access_token: undefined })).toBeNull();
  });

  it("returns null for non-google providers", () => {
    expect(accountTokenPatch({ ...base, provider: "credentials" })).toBeNull();
  });
});
