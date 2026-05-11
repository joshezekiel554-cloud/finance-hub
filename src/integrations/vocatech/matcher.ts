// Phone-number matcher: takes a raw phone number from a Vocatech webhook
// and resolves it to a finance-hub customer + the label of the phone that
// matched (e.g. "Owner's mobile"). US-only — we normalize to last-10-digits
// for comparison.
//
// Index is built in-memory and refreshed every hour. ~2400 customers ×
// ~3 phones each = ~7200 entries, well under 1MB heap.

import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "vocatech.matcher" });

export type MatchResult = {
  customerId: string;
  phoneLabel: string | null;
};

type IndexEntry = { customerId: string; phoneLabel: string | null };
type Index = Map<string, IndexEntry[]>;

let cachedIndex: Index | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Normalize: strip non-digits, take last 10. Returns null if too short.
export function normalize(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

async function buildIndex(): Promise<Index> {
  const rows = await db
    .select({
      id: customers.id,
      phone: customers.phone,
      additionalPhones: customers.additionalPhones,
    })
    .from(customers);

  const map: Index = new Map();

  function addEntry(num: string | null | undefined, customerId: string, label: string | null) {
    const normalized = normalize(num);
    if (!normalized) return;
    const bucket = map.get(normalized) ?? [];
    bucket.push({ customerId, phoneLabel: label });
    map.set(normalized, bucket);
  }

  for (const row of rows) {
    addEntry(row.phone, row.id, "Primary");
    if (Array.isArray(row.additionalPhones)) {
      for (const extra of row.additionalPhones as Array<{ label?: string; number?: string }>) {
        addEntry(extra.number ?? null, row.id, extra.label ?? null);
      }
    }
  }

  log.debug({ buckets: map.size }, "matcher index built");
  return map;
}

async function getIndex(): Promise<Index> {
  if (!cachedIndex || Date.now() - cachedAt > CACHE_TTL_MS) {
    cachedIndex = await buildIndex();
    cachedAt = Date.now();
  }
  return cachedIndex;
}

// Returns the best customer match for the given number, or null when no
// match. When the same number matches multiple customers, picks matches[0]
// (rare — same household number on multiple B2C customers) and logs a warning.
export async function matchPhoneToCustomer(phone: string): Promise<MatchResult | null> {
  const normalized = normalize(phone);
  if (!normalized) return null;

  const index = await getIndex();
  const matches = index.get(normalized);
  if (!matches || matches.length === 0) return null;
  if (matches.length === 1) {
    return { customerId: matches[0]!.customerId, phoneLabel: matches[0]!.phoneLabel };
  }

  // Multi-match — log warning and take first entry. Surfaces the case for
  // manual cleanup; a future optimization could tiebreak by updatedAt.
  log.warn({ phone: normalized, candidates: matches.length }, "phone matched multiple customers");
  return { customerId: matches[0]!.customerId, phoneLabel: matches[0]!.phoneLabel };
}

// Call after a customer's phone is edited to force the next lookup to
// rebuild the index rather than serving stale data.
export function invalidateMatcherCache(): void {
  cachedIndex = null;
  cachedAt = 0;
}
