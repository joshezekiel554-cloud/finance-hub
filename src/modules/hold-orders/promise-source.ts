// Load "which email did this promise come from?" for a batch of customers:
// promise_scans (result='promise') ⋈ activities (meta.threadId). Selection
// rule + link format: promise-link.ts.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { promiseScans } from "../../db/schema/promise-scans.js";
import { activities } from "../../db/schema/crm.js";
import { pickPromiseSource, type PromiseScanCandidate } from "./promise-link.js";

export type PromiseSource = { activityId: string; threadId: string; url: string };

/** customerId → source email link, for customers whose promise has one. */
export async function loadPromiseSources(
  promises: ReadonlyArray<{ customerId: string; payBy: string | null }>,
): Promise<Map<string, PromiseSource>> {
  const out = new Map<string, PromiseSource>();
  const ids = Array.from(new Set(promises.map((p) => p.customerId)));
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      customerId: promiseScans.customerId,
      activityId: promiseScans.activityId,
      emailAt: promiseScans.emailAt,
      promisedDate: promiseScans.promisedDate,
      meta: activities.meta,
    })
    .from(promiseScans)
    .innerJoin(activities, eq(activities.id, promiseScans.activityId))
    .where(and(inArray(promiseScans.customerId, ids), eq(promiseScans.result, "promise")))
    .limit(5000);
  const byCustomer = new Map<string, PromiseScanCandidate[]>();
  for (const r of rows) {
    const list = byCustomer.get(r.customerId) ?? [];
    list.push({ activityId: r.activityId, emailAt: r.emailAt, promisedDate: r.promisedDate, meta: r.meta ?? null });
    byCustomer.set(r.customerId, list);
  }
  for (const p of promises) {
    const src = pickPromiseSource(byCustomer.get(p.customerId) ?? [], p.payBy);
    if (src) out.set(p.customerId, src);
  }
  return out;
}
