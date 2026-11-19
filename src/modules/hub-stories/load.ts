// DB loaders for customer stories (pure builders in story.ts). Every query is
// batched over a list of customer ids (chunked IN lists) so the bulk route
// and the signals feed never go N+1 per customer.

import { and, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { orders } from "../../db/schema/catalog.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { activities, statementSends } from "../../db/schema/crm.js";
import { customerContacts, customers } from "../../db/schema/customers.js";
import { invoiceLines, invoices } from "../../db/schema/invoices.js";
import { payments } from "../../db/schema/payments.js";
import { rmas } from "../../db/schema/returns.js";
import { customerAddrSet } from "../crm/email-match.js";
import { HUB_NOTE_REF_TYPE } from "../promises/hub-notes.js";
import { newYorkYmd, todayYmd, toYmd } from "../promises/promise-state.js";
import {
  addDaysYmd,
  buildStory,
  emptyLedger,
  STORY_RULES,
  type Book,
  type CustomerStory,
  type Ledger,
  type PromiseMade,
  type StoryInputs,
} from "./story.js";

const CHUNK = 500;
const toNum = (v: string | number | null | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const toDate = (v: Date | string | null | undefined): Date | null =>
  v === null || v === undefined ? null : v instanceof Date ? v : new Date(v);
const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const tsYmd = (v: Date | string | null | undefined): string | null => {
  const d = toDate(v);
  return d && Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

async function perChunk<T>(ids: string[], q: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const uniq = Array.from(new Set(ids));
  if (uniq.length === 0) return [];
  const parts = await Promise.all(chunks(uniq).map(q));
  return parts.flat();
}

function group<T>(rows: T[], key: (r: T) => string | null | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

const notVoid = (): SQL => or(isNull(invoices.status), ne(invoices.status, "void")) as SQL;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** Invoices / payments / credit memos per customer (see story.ts header). */
export async function loadLedgers(ids: string[], now: Date): Promise<Map<string, Ledger>> {
  const today = todayYmd(now);
  const start = addDaysYmd(today, -STORY_RULES.ledgerLookbackDays);
  const startD = dayStart(start);

  const [inv, pay, cred, preInv, prePay, preCred] = await Promise.all([
    perChunk(ids, (c) =>
      db
        .select({
          id: invoices.id,
          customerId: invoices.customerId,
          docNumber: invoices.docNumber,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          total: invoices.total,
          balance: invoices.balance,
          origin: invoices.origin,
        })
        .from(invoices)
        .where(
          and(
            inArray(invoices.customerId, c),
            notVoid(),
            isNotNull(invoices.issueDate),
            lte(invoices.issueDate, dayStart(today)),
            or(gte(invoices.issueDate, startD), gt(invoices.balance, "0")),
          ),
        ),
    ),
    perChunk(ids, (c) =>
      db
        .select({
          id: payments.id,
          customerId: payments.customerId,
          txnDate: payments.txnDate,
          total: payments.total,
          feldart: payments.feldartAmount,
          tj: payments.tjAmount,
        })
        .from(payments)
        .where(and(inArray(payments.customerId, c), gte(payments.txnDate, startD), lte(payments.txnDate, dayStart(today)))),
    ),
    perChunk(ids, (c) =>
      db
        .select({
          id: creditMemos.id,
          customerId: creditMemos.customerId,
          docNumber: creditMemos.docNumber,
          txnDate: creditMemos.txnDate,
          total: creditMemos.total,
          balance: creditMemos.balance,
          origin: creditMemos.origin,
        })
        .from(creditMemos)
        .where(and(inArray(creditMemos.customerId, c), gte(creditMemos.txnDate, startD), lte(creditMemos.txnDate, dayStart(today)))),
    ),
    // Opening position: everything dated before the window.
    perChunk(ids, (c) =>
      db
        .select({ customerId: invoices.customerId, origin: invoices.origin, total: sql<string>`SUM(${invoices.total})` })
        .from(invoices)
        .where(and(inArray(invoices.customerId, c), notVoid(), isNotNull(invoices.issueDate), sql`${invoices.issueDate} < ${startD}`))
        .groupBy(invoices.customerId, invoices.origin),
    ),
    perChunk(ids, (c) =>
      db
        .select({
          customerId: payments.customerId,
          total: sql<string>`SUM(${payments.total})`,
          feldart: sql<string>`SUM(${payments.feldartAmount})`,
          tj: sql<string>`SUM(${payments.tjAmount})`,
        })
        .from(payments)
        .where(and(inArray(payments.customerId, c), sql`${payments.txnDate} < ${startD}`))
        .groupBy(payments.customerId),
    ),
    perChunk(ids, (c) =>
      db
        .select({
          customerId: creditMemos.customerId,
          origin: creditMemos.origin,
          total: sql<string>`SUM(${creditMemos.total})`,
          applied: sql<string>`SUM(${creditMemos.total} - ${creditMemos.balance})`,
        })
        .from(creditMemos)
        .where(and(inArray(creditMemos.customerId, c), sql`${creditMemos.txnDate} < ${startD}`))
        .groupBy(creditMemos.customerId, creditMemos.origin),
    ),
  ]);

  const out = new Map<string, Ledger>();
  const get = (id: string): Ledger => {
    let l = out.get(id);
    if (!l) {
      l = emptyLedger();
      out.set(id, l);
    }
    return l;
  };
  for (const id of ids) get(id);
  for (const r of inv) {
    const issue = toYmd(r.issueDate);
    if (!issue || issue > today) continue;
    get(r.customerId).invoices.push({
      id: r.id,
      docNumber: r.docNumber,
      issueDate: issue,
      dueDate: toYmd(r.dueDate),
      total: toNum(r.total),
      balance: toNum(r.balance),
      origin: r.origin as Book,
      ...(issue < start ? { beforeWindow: true } : {}),
    });
  }
  for (const r of pay) {
    const d = toYmd(r.txnDate);
    if (!d || d > today) continue;
    get(r.customerId).payments.push({ id: r.id, date: d, total: toNum(r.total), feldart: toNum(r.feldart), tj: toNum(r.tj) });
  }
  for (const r of cred) {
    const d = toYmd(r.txnDate);
    if (!d || d > today) continue;
    get(r.customerId).credits.push({ id: r.id, docNumber: r.docNumber, date: d, total: toNum(r.total), balance: toNum(r.balance), origin: r.origin as Book });
  }
  for (const r of preInv) {
    const o = get(r.customerId).opening;
    const t = toNum(r.total);
    o[r.origin as Book] += t;
    o.total += t;
  }
  for (const r of prePay) {
    const o = get(r.customerId).opening;
    o.feldart -= toNum(r.feldart);
    o.tj -= toNum(r.tj);
    o.total -= toNum(r.total);
  }
  for (const r of preCred) {
    const o = get(r.customerId).opening;
    o[r.origin as Book] -= toNum(r.applied);
    o.total -= toNum(r.total);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Promise history
// ---------------------------------------------------------------------------

/**
 * Promises made over the last 2 years: customer-level saves (manual_note
 * rows ref_type customer_promise, not the "cleared" ones) plus hold-ladder
 * pauses set by hand on an order (audit order.hold_ladder_paused).
 */
export async function loadPromiseHistory(ids: string[], now: Date): Promise<Map<string, PromiseMade[]>> {
  const from = dayStart(addDaysYmd(todayYmd(now), -STORY_RULES.lookbackDays));
  const [notes, pauses] = await Promise.all([
    perChunk(ids, (c) =>
      db
        .select({ customerId: activities.customerId, occurredAt: activities.occurredAt, meta: activities.meta })
        .from(activities)
        .where(
          and(
            inArray(activities.customerId, c),
            eq(activities.kind, "manual_note"),
            eq(activities.refType, "customer_promise"),
            gte(activities.occurredAt, from),
          ),
        ),
    ),
    perChunk(ids, (c) =>
      db
        .select({ customerId: orders.customerId, occurredAt: auditLog.occurredAt, after: auditLog.after })
        .from(auditLog)
        .innerJoin(orders, eq(orders.id, auditLog.entityId))
        .where(and(eq(auditLog.action, "order.hold_ladder_paused"), inArray(orders.customerId, c), gte(auditLog.occurredAt, from))),
    ),
  ]);
  const out = new Map<string, PromiseMade[]>();
  const add = (id: string | null, p: PromiseMade) => {
    if (!id) return;
    const arr = out.get(id) ?? [];
    arr.push(p);
    out.set(id, arr);
  };
  for (const n of notes) {
    const m = (n.meta ?? {}) as { promisedBy?: unknown; cleared?: unknown; note?: unknown };
    const date = typeof m.promisedBy === "string" ? toYmd(m.promisedBy) : null;
    const at = toDate(n.occurredAt);
    if (!date || m.cleared === true || !at) continue;
    add(n.customerId, { setAt: at, date, source: "customer", note: typeof m.note === "string" ? m.note : null });
  }
  for (const p of pauses) {
    const a = (p.after ?? {}) as { holdLadderPausedUntil?: unknown; note?: unknown };
    const until = typeof a.holdLadderPausedUntil === "string" || a.holdLadderPausedUntil instanceof Date ? toDate(a.holdLadderPausedUntil) : null;
    const at = toDate(p.occurredAt);
    if (!until || !Number.isFinite(until.getTime()) || !at) continue;
    add(p.customerId, { setAt: at, date: newYorkYmd(until), source: "held-order", note: typeof a.note === "string" ? a.note : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Customer heads
// ---------------------------------------------------------------------------

export type CustomerHead = {
  id: string;
  name: string;
  /** Lower-cased: primary first, then billing / invoice / statement "to", then contacts. */
  emails: string[];
  balance: number;
  country: string | null;
  customerType: "b2b" | "b2c" | null;
  holdStatus: "active" | "hold" | "payment_upfront";
  promisedPayBy: string | null;
};

export async function loadCustomerHeads(ids: string[], opts: { contacts?: boolean } = {}): Promise<Map<string, CustomerHead>> {
  const [rows, contacts] = await Promise.all([
    perChunk(ids, (c) =>
      db
        .select({
          id: customers.id,
          name: customers.displayName,
          primaryEmail: customers.primaryEmail,
          billingEmails: customers.billingEmails,
          invoiceToEmails: customers.invoiceToEmails,
          statementToEmails: customers.statementToEmails,
          balance: customers.balance,
          country: customers.billingAddressCountry,
          customerType: customers.customerType,
          holdStatus: customers.holdStatus,
          promisedPayBy: customers.promisedPayBy,
        })
        .from(customers)
        .where(inArray(customers.id, c)),
    ),
    opts.contacts
      ? perChunk(ids, (c) =>
          db
            .select({ customerId: customerContacts.customerId, email: customerContacts.email })
            .from(customerContacts)
            .where(and(inArray(customerContacts.customerId, c), isNotNull(customerContacts.email))),
        )
      : Promise.resolve([] as Array<{ customerId: string; email: string | null }>),
  ]);
  const byCust = group(contacts, (r) => r.customerId);
  const out = new Map<string, CustomerHead>();
  for (const r of rows) {
    const emails = customerAddrSet(r);
    for (const c of byCust.get(r.id) ?? []) {
      const e = c.email?.trim().toLowerCase();
      if (e && !emails.includes(e)) emails.push(e);
    }
    out.set(r.id, {
      id: r.id,
      name: r.name,
      emails,
      balance: toNum(r.balance),
      country: r.country,
      customerType: r.customerType,
      holdStatus: r.holdStatus,
      promisedPayBy: toYmd(r.promisedPayBy),
    });
  }
  return out;
}

/**
 * The customer an email address belongs to (case-insensitive, any linked
 * address incl. contacts). Several matches (the origin split can leave two
 * records sharing an address): the one whose primary email it is, then the
 * larger balance, then the lowest id — deterministic.
 */
export async function findCustomerIdByEmail(email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!e || e.length > 254) return null;
  const like = `%"${e.replace(/[\\%_"]/g, (ch) => `\\${ch}`)}"%`;
  const [direct, viaContacts] = await Promise.all([
    db
      .select({ id: customers.id })
      .from(customers)
      .where(
        or(
          sql`LOWER(${customers.primaryEmail}) = ${e}`,
          sql`LOWER(CAST(${customers.billingEmails} AS CHAR)) LIKE ${like}`,
          sql`LOWER(CAST(${customers.invoiceToEmails} AS CHAR)) LIKE ${like}`,
          sql`LOWER(CAST(${customers.statementToEmails} AS CHAR)) LIKE ${like}`,
        ),
      )
      .limit(20),
    db
      .select({ id: customerContacts.customerId })
      .from(customerContacts)
      .where(sql`LOWER(${customerContacts.email}) = ${e}`)
      .limit(20),
  ]);
  const ids = Array.from(new Set([...direct.map((r) => r.id), ...viaContacts.map((r) => r.id)]));
  if (ids.length === 0) return null;
  const heads = await loadCustomerHeads(ids, { contacts: true });
  const matches = Array.from(heads.values()).filter((h) => h.emails.includes(e));
  matches.sort((a, b) => Number(b.emails[0] === e) - Number(a.emails[0] === e) || b.balance - a.balance || a.id.localeCompare(b.id));
  return matches[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Timeline extras + buying lines
// ---------------------------------------------------------------------------

type Extras = StoryInputs["extras"];

export async function loadStoryExtras(ids: string[], now: Date): Promise<Map<string, Extras>> {
  const today = todayYmd(now);
  const from = dayStart(addDaysYmd(today, -STORY_RULES.lookbackDays));
  const [ord, acts, rma, stmts] = await Promise.all([
    perChunk(ids, (c) =>
      db
        .select({
          id: orders.id,
          customerId: orders.customerId,
          number: orders.orderNumber,
          orderDate: orders.orderDate,
          total: orders.total,
          status: orders.status,
          cancelledAt: orders.cancelledAt,
          holdStartedAt: orders.holdStartedAt,
          holdReleasedAt: orders.holdReleasedAt,
          holdReason: orders.holdReason,
        })
        .from(orders)
        .where(and(inArray(orders.customerId, c), gte(orders.orderDate, from))),
    ),
    perChunk(ids, (c) =>
      db
        .select({
          customerId: activities.customerId,
          kind: activities.kind,
          occurredAt: activities.occurredAt,
          subject: activities.subject,
          body: sql<string | null>`LEFT(${activities.body}, 400)`,
          refType: activities.refType,
          meta: activities.meta,
        })
        .from(activities)
        .where(
          and(
            inArray(activities.customerId, c),
            gte(activities.occurredAt, from),
            or(
              and(eq(activities.kind, "email_out"), eq(activities.refType, "chase_email")),
              inArray(activities.kind, ["hold_on", "hold_off"]),
              and(eq(activities.kind, "manual_note"), eq(activities.refType, HUB_NOTE_REF_TYPE)),
            ),
          ),
        ),
    ),
    perChunk(ids, (c) =>
      db
        .select({
          id: rmas.id,
          customerId: rmas.customerId,
          number: rmas.rmaNumber,
          createdAt: rmas.createdAt,
          status: rmas.status,
          type: rmas.returnType,
          total: rmas.totalValue,
        })
        .from(rmas)
        .where(and(inArray(rmas.customerId, c), gte(rmas.createdAt, from))),
    ),
    perChunk(ids, (c) =>
      db
        .select({ customerId: statementSends.customerId, sentAt: statementSends.sentAt, number: statementSends.statementNumber, type: statementSends.statementType })
        .from(statementSends)
        .where(and(inArray(statementSends.customerId, c), gte(statementSends.sentAt, from))),
    ),
  ]);

  const out = new Map<string, Extras>();
  const get = (id: string): Extras => {
    let e = out.get(id);
    if (!e) {
      e = { orders: [], chases: [], holds: [], rmas: [], statements: [], hubNotes: [] };
      out.set(id, e);
    }
    return e;
  };
  for (const id of ids) get(id);
  for (const o of ord) {
    const d = tsYmd(o.orderDate);
    if (!o.customerId || !d) continue;
    get(o.customerId).orders.push({
      id: o.id,
      number: o.number,
      date: d,
      total: o.total === null ? null : toNum(o.total),
      cancelled: o.status === "cancelled" || o.cancelledAt !== null,
      holdStartedAt: tsYmd(o.holdStartedAt),
      holdReleasedAt: tsYmd(o.holdReleasedAt),
      holdReason: o.holdReason,
    });
  }
  for (const a of acts) {
    const d = tsYmd(a.occurredAt);
    if (!d) continue;
    const e = get(a.customerId);
    if (a.kind === "email_out") {
      const level = (a.meta ?? {}).level;
      e.chases.push({ date: d, level: typeof level === "number" ? level : null, subject: a.subject });
    } else if (a.kind === "hold_on" || a.kind === "hold_off") {
      e.holds.push({ date: d, on: a.kind === "hold_on", text: a.subject });
    } else {
      e.hubNotes.push({ date: d, text: a.body ?? a.subject ?? "Note from hub" });
    }
  }
  for (const r of rma) {
    const d = tsYmd(r.createdAt);
    if (d) get(r.customerId).rmas.push({ id: r.id, number: r.number, date: d, status: r.status, type: r.type, total: toNum(r.total) });
  }
  for (const s of stmts) {
    const d = tsYmd(s.sentAt);
    if (d) get(s.customerId).statements.push({ date: d, number: s.number, type: s.type });
  }
  return out;
}

/** Feldart invoice lines over 2 years (for topSkus). */
export async function loadBuyingLines(ids: string[], now: Date): Promise<Map<string, StoryInputs["lines"]>> {
  const today = todayYmd(now);
  const rows = await perChunk(ids, (c) =>
    db
      .select({
        customerId: invoices.customerId,
        sku: invoiceLines.sku,
        description: sql<string | null>`LEFT(${invoiceLines.description}, 64)`,
        itemName: invoiceLines.itemName,
        qty: invoiceLines.qty,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(
        and(
          inArray(invoices.customerId, c),
          eq(invoices.origin, "feldart"),
          notVoid(),
          gte(invoices.issueDate, dayStart(addDaysYmd(today, -STORY_RULES.lookbackDays))),
          lte(invoices.issueDate, dayStart(today)),
        ),
      ),
  );
  const out = new Map<string, StoryInputs["lines"]>();
  for (const r of rows) {
    const arr = out.get(r.customerId) ?? [];
    arr.push({ sku: r.sku, description: r.description, itemName: r.itemName, qty: toNum(r.qty) });
    out.set(r.customerId, arr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** Full stories for these customers (unknown ids are left out). */
export async function loadStories(ids: string[], ctx: { now: Date; baseUrl: string }): Promise<CustomerStory[]> {
  const [heads, ledgers, promises, extras, lines] = await Promise.all([
    loadCustomerHeads(ids, { contacts: true }),
    loadLedgers(ids, ctx.now),
    loadPromiseHistory(ids, ctx.now),
    loadStoryExtras(ids, ctx.now),
    loadBuyingLines(ids, ctx.now),
  ]);
  const out: CustomerStory[] = [];
  for (const id of ids) {
    const h = heads.get(id);
    if (!h) continue;
    out.push(
      buildStory(
        {
          customer: { id: h.id, name: h.name, emails: h.emails, balance: h.balance },
          ledger: ledgers.get(id) ?? emptyLedger(),
          promisesMade: promises.get(id) ?? [],
          lines: lines.get(id) ?? [],
          extras: extras.get(id) ?? { orders: [], chases: [], holds: [], rmas: [], statements: [], hubNotes: [] },
        },
        ctx,
      ),
    );
  }
  return out;
}

/**
 * Customers with something NEW since `since` (id > cursor, ascending), for
 * the bulk stories feed. "New" = rows created since then — invoices,
 * payments, credit memos, Shopify orders (incl. hold on/off and
 * cancellation), activities (chases, emails, notes, promises, holds),
 * statement sends, RMA updates and customer promise saves. updated_at on
 * synced tables is NOT used: the QBO sync bumps it on every touch, so it
 * would report every customer every 30 minutes.
 */
export async function changedCustomerIds(opts: { since: Date; afterId: string | null; limit: number }): Promise<string[]> {
  const s = opts.since;
  const after = opts.afterId ?? "";
  const rows = await db.execute(sql`
    SELECT customer_id AS id FROM (
      SELECT customer_id FROM ${invoices} WHERE created_at >= ${s}
      UNION SELECT customer_id FROM ${payments} WHERE created_at >= ${s}
      UNION SELECT customer_id FROM ${creditMemos} WHERE created_at >= ${s}
      UNION SELECT customer_id FROM ${orders} WHERE customer_id IS NOT NULL AND (created_at >= ${s} OR hold_started_at >= ${s} OR hold_released_at >= ${s} OR cancelled_at >= ${s})
      UNION SELECT customer_id FROM ${activities} WHERE occurred_at >= ${s}
      UNION SELECT customer_id FROM ${statementSends} WHERE sent_at >= ${s}
      UNION SELECT customer_id FROM ${rmas} WHERE updated_at >= ${s}
      UNION SELECT id AS customer_id FROM ${customers} WHERE promise_set_at >= ${s}
    ) t
    WHERE customer_id > ${after}
    ORDER BY customer_id ASC
    LIMIT ${opts.limit}
  `);
  const data = (Array.isArray(rows) ? rows[0] : rows) as unknown;
  if (!Array.isArray(data)) return [];
  return data.map((r) => String((r as { id: unknown }).id)).filter(Boolean);
}
