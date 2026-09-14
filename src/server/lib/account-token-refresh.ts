// What a Google sign-in should write back onto the Auth.js `account` row.
//
// The Drizzle adapter only inserts the row on first link; every later
// sign-in (which, with prompt=consent + access_type=offline, mints a brand
// new refresh token) was discarded. Drive uploads run off that stored
// refresh token, so it quietly aged until Google answered `invalid_grant`
// and the only cure was deleting the row. Persisting the tokens on each
// sign-in means "sign out and back in" genuinely refreshes the grant.

import type { Account } from "@auth/core/types";

export type AccountTokenPatch = {
  access_token: string;
  refresh_token?: string;
  expires_at: number | null;
  scope: string | null;
};

type AccountLike = Pick<
  Account,
  "provider" | "access_token" | "refresh_token" | "expires_at" | "scope"
>;

export function accountTokenPatch(
  account: AccountLike | null | undefined,
): AccountTokenPatch | null {
  if (!account || account.provider !== "google") return null;
  if (!account.access_token) return null;

  const patch: AccountTokenPatch = {
    access_token: account.access_token,
    expires_at: account.expires_at ?? null,
    scope: account.scope ?? null,
  };
  // Google omits refresh_token when it decides the existing grant still
  // stands; never overwrite a stored one with nothing.
  if (account.refresh_token) patch.refresh_token = account.refresh_token;
  return patch;
}
