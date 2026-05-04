import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { accounts, users } from "../src/db/schema/auth.js";

async function main(): Promise<void> {
  const allAccounts = await db
    .select({
      userId: accounts.userId,
      provider: accounts.provider,
      providerAccountId: accounts.providerAccountId,
      scope: accounts.scope,
      expiresAt: accounts.expires_at,
      hasRefresh: accounts.refresh_token,
      hasAccess: accounts.access_token,
    })
    .from(accounts);

  for (const a of allAccounts) {
    const u = await db
      .select()
      .from(users)
      .where(eq(users.id, a.userId))
      .limit(1);
    console.log({
      email: u[0]?.email,
      provider: a.provider,
      scope: a.scope,
      expiresAt: a.expiresAt
        ? new Date(a.expiresAt * 1000).toISOString()
        : null,
      hasRefreshToken: !!a.hasRefresh,
      hasAccessToken: !!a.hasAccess,
    });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
