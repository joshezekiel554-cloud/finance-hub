// Wipe the Auth.js Google account + session rows for a given email so the
// next sign-in does a fresh OAuth grant. Used when the stored scope is stale.
//
// Usage:  npx tsx scripts/reset-google-auth.ts <email>

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { accounts, sessions, users } from "../src/db/schema/auth.js";

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  if (!email) {
    console.error("Usage: npx tsx scripts/reset-google-auth.ts <email>");
    process.exit(1);
  }

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const user = userRows[0];
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  const a = await db.delete(accounts).where(eq(accounts.userId, user.id));
  const s = await db.delete(sessions).where(eq(sessions.userId, user.id));
  console.log(
    `Wiped Google auth for ${email}. Account rows: ${JSON.stringify(a)}. Session rows: ${JSON.stringify(s)}.`,
  );
  console.log("Sign in via /api/auth/signin to get a fresh OAuth grant.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
