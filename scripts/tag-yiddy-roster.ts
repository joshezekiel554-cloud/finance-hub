// One-shot: tag every customer on Yiddy's commission roster with the
// "yiddy" tag (which the email_routing_rules row maps to BCC
// sales@feldart.com on invoices).
//
// Source: commission_roster_20260501_124821.pdf — 118 active stores.
//
// Behaviour:
//   - Default: dry-run. Prints "would tag", "already tagged", and
//     "not found" lists. NO writes.
//   - With --apply: actually appends "yiddy" to each matched
//     customer's tags JSON column. Idempotent — skips rows that
//     already carry the tag. Audit log row written per change.
//
// Run from finance-hub root:
//   npx tsx scripts/tag-yiddy-roster.ts                # dry-run
//   npx tsx scripts/tag-yiddy-roster.ts --apply        # write

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/db/index.js";
import { customers } from "../src/db/schema/customers.js";
import { auditLog } from "../src/db/schema/audit.js";

const ROSTER: string[] = [
  "Abraham Stern",
  "Ahron Judowitz The Westview Shop",
  "Alef Judaica",
  "Apstone Interiors",
  "Baila Mueller",
  "Bais Hasforim",
  "Beilu Ungar",
  "Cadeaux Judaica klein",
  "Candylicious Faire",
  "Compliments Gift",
  "Creative Elements",
  // Roster lists "Custom Showroom" as one row but the QBO account
  // was split into BP + WB. Both belong on Yiddy's roster.
  "Custom showroom BP",
  "Custom showroom WB",
  "Doren Judaica",
  "Eddie Janani",
  "Eichler's Judaica",
  "Eichlers BP",
  "Elegant Home & Gifts",
  "Elegant Linen BP",
  "Elegant Linen Flatbush",
  "Elegant linen Howell NJ",
  "Elegant Linen Lakewood",
  "Elegant Linen Monsey",
  "Frieds hardware & houseware",
  "Gift Him",
  "Glitz BP",
  "Glitz Lakewood",
  "Going Decor",
  "Green's Bath & Home",
  "Greenfeld",
  "Greenfeld Judaica",
  "House & Home Hardware",
  "Igal Meirov",
  "Ilana Buchsbayew",
  "Impressions Gifts",
  "It's All a Gift",
  "Jakob Hollender",
  "Joel Perkowski",
  "Judaica Corner",
  "Judaica Place",
  "Judaica Plaza",
  "Judaica Plus",
  "Judaica Square Brook",
  "Judaica Square South",
  "Keter Judaica - 14th",
  "Keter Judaica - BP",
  "Keter Judaica - Lakewood",
  "Keter Judaica - Monticello",
  "Keter Judaica - Williamsburg",
  "Keter Monroe",
  "Kitchen Clique",
  "Lakewood Judaica - Cedarbridge",
  "Lakewood Judaica - James",
  "LEE AVENUE PHOTO",
  "Lideal Gifts",
  "Lideale BH Gifts corp.",
  "Louise Kramer",
  "Luxury Linen / Mamleches Tosh",
  "Maayan Judaica",
  "Made To Order Home",
  "Malchut Judaica - BP",
  "Malchut Judaica - Monroe",
  "Malchut Judaica - Monsey",
  "Malchut Judaica - Williamsburg",
  "malky krausz",
  "Mefoar Judaica - BP",
  "Mefoar Judaica - Lakewood",
  "Mefoar Judaica - Willamsburg",
  "Mefoar Monsey",
  "Mekor Judaica",
  "Menorah Judaica",
  "Meoros Judaica",
  "Merkaz Monsey",
  "Merkaz Stam",
  "Mimi's Linen and Gifts",
  "Mivchar Judaica",
  "Moishe Bineth",
  "Naftali Waldman",
  "Namery Gifts",
  "nechama shain",
  "Nesher Judaica",
  "Oitzer Judaica",
  "On The Table NJ",
  "Organicer",
  "Peony",
  "Pessi Friedman",
  "Petite Prices",
  "Plugins Plugins",
  "QHOME SALES The Chedvah Dahan Team",
  "Scharf's Judaica",
  "Shabsi's Judaica Center",
  "Shane Vorhand",
  "Shefa Appliances & Gifts",
  "shimon berkovics",
  "Shloimy's Judaica",
  "Signature Silver",
  "Table & Decor",
  "Tagin Judaica",
  "ThanQ Gifts",
  "The Engraved Signature",
  "The Engraved Signature Spitzer",
  "The Peppermill Peppermill",
  "The Present Touch",
  "The Seforim Nook",
  "The soap bar brooklyn Schweky",
  "The Towel Shop",
  "Torah Treasures Flatbush",
  "Torah Treasures Lakewood",
  "Torah Treasures Monsey",
  "Viennese Classic Confections",
  "Vintage decor",
  "Wrapped NJ",
  "yossels Housewares",
  "Z Berman - Five Towns",
  "Z. Berman Books - BP",
  "Z. Berman Books - Passaic",
  "Z. Berman Books - Squankum",
  "Z. Berman Books -Westgate",
  "Zahav Decor",
];

const TAG = "yiddy";

// Normalise for matching: lowercase, collapse internal whitespace,
// trim ends. Punctuation stays (apostrophes, ampersands, slashes,
// dashes — these are real distinguishing features for these stores).
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const allCustomers = await db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      tags: customers.tags,
    })
    .from(customers);

  // Build a normalised displayName → customer index for O(1) lookups.
  // Multiple customers can share a normalised name (rare, but defensive
  // logging if it happens).
  const byNorm = new Map<string, typeof allCustomers>();
  for (const c of allCustomers) {
    const key = norm(c.displayName);
    const arr = byNorm.get(key) ?? [];
    arr.push(c);
    byNorm.set(key, arr);
  }

  const matches: Array<{
    rosterName: string;
    customerId: string;
    customerName: string;
    alreadyTagged: boolean;
    currentTags: string[];
  }> = [];
  const ambiguous: Array<{ rosterName: string; candidates: string[] }> = [];
  const notFound: string[] = [];

  for (const rosterName of ROSTER) {
    const hit = byNorm.get(norm(rosterName)) ?? [];
    if (hit.length === 0) {
      notFound.push(rosterName);
      continue;
    }
    if (hit.length > 1) {
      ambiguous.push({
        rosterName,
        candidates: hit.map((h) => h.displayName),
      });
      continue;
    }
    const c = hit[0]!;
    const currentTags = c.tags ?? [];
    const alreadyTagged = currentTags
      .map((t) => t.toLowerCase())
      .includes(TAG);
    matches.push({
      rosterName,
      customerId: c.id,
      customerName: c.displayName,
      alreadyTagged,
      currentTags,
    });
  }

  console.log(`\nRoster size: ${ROSTER.length}`);
  console.log(`Customers in finance-hub: ${allCustomers.length}`);
  console.log(`\nMatched: ${matches.length}`);
  const toApply = matches.filter((m) => !m.alreadyTagged);
  const alreadyTagged = matches.filter((m) => m.alreadyTagged);
  console.log(`  - already tagged with "${TAG}": ${alreadyTagged.length}`);
  console.log(`  - would add "${TAG}":          ${toApply.length}`);
  if (ambiguous.length > 0) {
    console.log(`\nAmbiguous (>1 customer matches the roster name): ${ambiguous.length}`);
    for (const a of ambiguous) {
      console.log(`  - "${a.rosterName}" matched: ${a.candidates.join(" | ")}`);
    }
  }
  if (notFound.length > 0) {
    console.log(`\nNot found in finance-hub: ${notFound.length}`);
    for (const n of notFound) console.log(`  - ${n}`);
    console.log(
      `\n(These names need a manual fix — check QBO for the exact displayName.)`,
    );
  }

  if (!apply) {
    console.log(
      `\nDry run only. To apply, re-run with --apply.\n`,
    );
    return;
  }

  if (toApply.length === 0) {
    console.log(`\nNo changes to apply.\n`);
    return;
  }

  console.log(`\nApplying tag to ${toApply.length} customer(s)…`);
  let applied = 0;
  for (const m of toApply) {
    const before = { tags: m.currentTags };
    const nextTags = Array.from(
      new Set([...m.currentTags.map((t) => t.toLowerCase()), TAG]),
    );
    await db
      .update(customers)
      .set({ tags: nextTags })
      .where(eq(customers.id, m.customerId));
    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: null,
      action: "customer.tag.add.script",
      entityType: "customer",
      entityId: m.customerId,
      before,
      after: { tags: nextTags },
    });
    applied++;
    if (applied % 25 === 0) {
      console.log(`  …${applied}/${toApply.length}`);
    }
  }
  console.log(`\nDone. Tagged ${applied} customer(s) with "${TAG}".\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
