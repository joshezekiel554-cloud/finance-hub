// One-shot helper: prints users so the operator can grab the right id for
// scripts that need IMPORT_USER_ID / similar attribution.
//
//   npx tsx scripts/list-users.ts

import "dotenv/config";
import { db } from "../src/db/index.js";
import { users } from "../src/db/schema/auth.js";

async function main() {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users);
  console.table(rows);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
