// Seeds the email_routing_rules table with the canonical rules. Only
// inserts rows that aren't already present (matched on the tag+action+
// value uniqueness). Re-running is safe.

import "dotenv/config";
import { nanoid } from "nanoid";
import { db } from "../src/db/index.js";
import { emailRoutingRules } from "../src/db/schema/email-routing-rules.js";
import { and, eq } from "drizzle-orm";

const DEFAULTS = [
  {
    tag: "yiddy",
    action: "bcc_invoice" as const,
    value: "sales@feldart.com",
  },
];

async function main() {
  let inserted = 0;
  for (const r of DEFAULTS) {
    const existing = await db
      .select({ id: emailRoutingRules.id })
      .from(emailRoutingRules)
      .where(
        and(
          eq(emailRoutingRules.tag, r.tag),
          eq(emailRoutingRules.action, r.action),
          eq(emailRoutingRules.value, r.value),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      await db.insert(emailRoutingRules).values({
        id: nanoid(24),
        tag: r.tag,
        action: r.action,
        value: r.value,
      });
      inserted++;
    }
  }
  console.log(`Seeded ${inserted} routing rule(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
