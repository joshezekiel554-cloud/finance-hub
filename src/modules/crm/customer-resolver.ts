// Email → customer-id resolver with a short-lived cache.
//
// The Gmail poller hits this repeatedly inside one run (one lookup per
// fetched message). Without a cache that's N table scans of `customers` per
// poll, all reading the same data. With a 60s TTL we collapse a poll's worth
// of lookups into a single scan; long enough for poll-loop bursts, short
// enough that a freshly-synced customer becomes resolvable within a minute.
//
// The customer set is bounded (low thousands per the plan), so a full-table
// scan + in-memory index is correct here. Building a SQL-side query for
// JSON-array containment in MySQL 8 is awkward and slower than scanning.

import { db, type DB } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";

const CACHE_TTL_MS = 60_000;

type CustomerEmailIndex = Map<string, string>;

type CacheEntry = {
  index: CustomerEmailIndex;
  expiresAt: number;
};

let cache: CacheEntry | null = null;

async function buildIndex(database: DB): Promise<CustomerEmailIndex> {
  const rows = await database
    .select({
      id: customers.id,
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
    })
    .from(customers);

  const index: CustomerEmailIndex = new Map();
  for (const row of rows) {
    if (row.primaryEmail) {
      index.set(row.primaryEmail.toLowerCase(), row.id);
    }
    if (Array.isArray(row.billingEmails)) {
      for (const e of row.billingEmails) {
        if (typeof e === "string" && e.length > 0) {
          index.set(e.toLowerCase(), row.id);
        }
      }
    }
  }
  return index;
}

async function getIndex(database: DB): Promise<CustomerEmailIndex> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.index;
  }
  const index = await buildIndex(database);
  cache = { index, expiresAt: now + CACHE_TTL_MS };
  return index;
}

export async function resolveCustomerByEmail(
  email: string | null | undefined,
  database: DB = db,
): Promise<string | null> {
  if (!email) return null;
  const key = email.trim().toLowerCase();
  if (!key || !key.includes("@")) return null;

  const index = await getIndex(database);
  return index.get(key) ?? null;
}

// Test-only: drop the cached index so each test starts fresh.
export function __resetCustomerResolverCache(): void {
  cache = null;
}
