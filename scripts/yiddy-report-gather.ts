// One-off gatherer for the yiddy-roster sales report. READ-ONLY.
//
// Runs ON THE VPS (deploys are dist-only) via the recipe:
//   scp scripts/yiddy-report-gather.ts finance-vps:finance-hub/scripts/
//   ssh finance-vps "cd finance-hub && sed 's|\.\./src/|../dist/|g' \
//     scripts/yiddy-report-gather.ts > scripts/.tmp-yiddy-gather.ts && \
//     GEN_DATE=2026-09-01 npx dotenv-cli -e .env.production -- \
//     npx tsx scripts/.tmp-yiddy-gather.ts > /tmp/yiddy-gathered.json"
//
// Emits ONE GatheredData JSON blob on stdout — progress goes to stderr
// so redirection stays clean. Lives FLAT in scripts/ so the sed
// src→dist rewrite matches every import below.

import "dotenv/config";
import { and, asc, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { customers, customerContacts } from "../src/db/schema/customers.js";
import { invoices, invoiceLines } from "../src/db/schema/invoices.js";
import { activities } from "../src/db/schema/crm.js";
import { orders } from "../src/db/schema/catalog.js";
import { creditMemos } from "../src/db/schema/credit-memos.js";
import { QboClient } from "../src/integrations/qb/client.js";
import { ShopifyClient } from "../src/integrations/shopify/client.js";

const GEN_DATE = process.env.GEN_DATE ?? new Date().toISOString().slice(0, 10);
const gy = Number(GEN_DATE.slice(0, 4));
const gm = Number(GEN_DATE.slice(5, 7));
// 25 whole months back from the generation month: covers TTM + prior
// year + the season look-back.
const windowStartStr = (() => {
  const d = new Date(Date.UTC(gy, gm - 1 - 25, 1));
  return d.toISOString().slice(0, 10);
})();
const windowStart = new Date(`${windowStartStr}T00:00:00Z`);

const num = (v: unknown): number =>
  v === null || v === undefined ? 0 : Number(v);
const iso = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

async function main(): Promise<void> {
  // ---- roster ----
  const roster = await db
    .select({
      id: customers.id,
      qbCustomerId: customers.qbCustomerId,
      displayName: customers.displayName,
      phone: customers.phone,
      additionalPhones: customers.additionalPhones,
      primaryEmail: customers.primaryEmail,
      paymentTerms: customers.paymentTerms,
      holdStatus: customers.holdStatus,
      balance: customers.balance,
      overdueBalance: customers.overdueBalance,
      internalNotes: customers.internalNotes,
      aiCustomerContext: customers.aiCustomerContext,
    })
    .from(customers)
    .where(sql`JSON_CONTAINS(${customers.tags}, '"yiddy"')`)
    .orderBy(asc(customers.displayName));
  console.error(`roster: ${roster.length} customers`);
  const ids = roster.map((r) => r.id);

  // ---- contacts ----
  const contacts = await db
    .select({
      customerId: customerContacts.customerId,
      name: customerContacts.name,
      email: customerContacts.email,
      role: customerContacts.role,
      phone: customerContacts.phone,
    })
    .from(customerContacts)
    .where(inArray(customerContacts.customerId, ids));

  // ---- lifetime invoice dates (cadence + first order) ----
  const lifetime = await db
    .select({ customerId: invoices.customerId, issueDate: invoices.issueDate })
    .from(invoices)
    .where(
      and(
        inArray(invoices.customerId, ids),
        ne(invoices.status, "void"),
        isNotNull(invoices.issueDate),
      ),
    )
    .orderBy(asc(invoices.issueDate));

  // ---- windowed invoices + lines ----
  const invRows = await db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      docNumber: invoices.docNumber,
      issueDate: invoices.issueDate,
      total: invoices.total,
      balance: invoices.balance,
      status: invoices.status,
      origin: invoices.origin,
    })
    .from(invoices)
    .where(
      and(
        inArray(invoices.customerId, ids),
        ne(invoices.status, "void"),
        isNotNull(invoices.issueDate),
        gte(invoices.issueDate, windowStart),
      ),
    );
  const invIds = invRows.map((r) => r.id);
  const lineRows =
    invIds.length === 0
      ? []
      : await db
          .select({
            invoiceId: invoiceLines.invoiceId,
            sku: invoiceLines.sku,
            description: invoiceLines.description,
            qty: invoiceLines.qty,
            lineTotal: invoiceLines.lineTotal,
          })
          .from(invoiceLines)
          .where(inArray(invoiceLines.invoiceId, invIds));
  console.error(`invoices: ${invRows.length}, lines: ${lineRows.length}`);

  // ---- hold history (customer-level) + shopify order-hold notes ----
  const holdActs = await db
    .select({
      customerId: activities.customerId,
      kind: activities.kind,
      occurredAt: activities.occurredAt,
      meta: activities.meta,
    })
    .from(activities)
    .where(
      and(
        inArray(activities.customerId, ids),
        inArray(activities.kind, ["hold_on", "hold_off"]),
      ),
    )
    .orderBy(asc(activities.occurredAt));
  const orderHolds = await db
    .select({
      customerId: orders.customerId,
      holdStartedAt: orders.holdStartedAt,
      holdReason: orders.holdReason,
      holdNote: orders.holdNote,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.customerId, ids),
        ne(orders.holdState, "none"),
        isNotNull(orders.holdStartedAt),
        gte(orders.holdStartedAt, windowStart),
      ),
    );

  // ---- credit memos (window; compute filters to TTM exactly) ----
  const cms = await db
    .select({
      customerId: creditMemos.customerId,
      txnDate: creditMemos.txnDate,
      total: creditMemos.total,
    })
    .from(creditMemos)
    .where(
      and(
        inArray(creditMemos.customerId, ids),
        isNotNull(creditMemos.txnDate),
        gte(creditMemos.txnDate, windowStart),
      ),
    );

  // ---- QBO: item map + sales receipts ----
  // query/queryAll are `private` on the client class — compile-time
  // only; reach them at runtime for this one-off READ. (Adding a public
  // method would require a deploy: the VPS runs dist/ only.)
  const q = new QboClient() as unknown as {
    queryAll<T>(
      sfw: string,
      ex: (r: {
        QueryResponse: Record<string, T[] | undefined>;
      }) => T[] | undefined,
    ): Promise<T[]>;
  };
  // NOTE: the local `products` table is EMPTY on prod (Shopify product
  // sync never populated it), so QBO Items are the product catalog
  // here: same SKU keyspace as invoice_lines, and MetaData.CreateTime
  // gives the "new product" date. Active items only — discontinued
  // lines shouldn't appear in pitch lists.
  type QboItemSlim = {
    Id: string;
    Name?: string;
    Sku?: string;
    Type?: string;
    Active?: boolean;
    UnitPrice?: number;
    MetaData?: { CreateTime?: string };
  };
  const items = await q.queryAll<QboItemSlim>(
    "SELECT * FROM Item WHERE Active = true",
    (r) => r.QueryResponse.Item,
  );
  const itemMap = new Map(
    items.map((i) => [i.Id, { sku: i.Sku ?? null, name: i.Name ?? null }]),
  );
  console.error(`qbo items: ${items.length}`);

  type QboSrSlim = {
    Id: string;
    DocNumber?: string;
    TxnDate: string;
    TotalAmt: number;
    CustomerRef?: { value: string };
    Line?: Array<{
      Amount?: number;
      SalesItemLineDetail?: {
        ItemRef?: { value: string; name?: string };
        Qty?: number;
      };
    }>;
  };
  const srs = await q.queryAll<QboSrSlim>(
    `SELECT * FROM SalesReceipt WHERE TxnDate >= '${windowStartStr}'`,
    (r) => r.QueryResponse.SalesReceipt,
  );
  console.error(`qbo sales receipts (all customers, windowed): ${srs.length}`);

  const qbToLocal = new Map(
    roster
      .filter((r) => r.qbCustomerId)
      .map((r) => [String(r.qbCustomerId), r.id]),
  );

  // ---- assemble per-customer ----
  const linesByInv = new Map<
    string,
    Array<{ sku: string | null; name: string | null; qty: number; lineTotal: number }>
  >();
  for (const l of lineRows) {
    const arr = linesByInv.get(l.invoiceId) ?? [];
    arr.push({
      sku: l.sku ?? null,
      name: l.description ?? null,
      qty: num(l.qty),
      lineTotal: num(l.lineTotal),
    });
    linesByInv.set(l.invoiceId, arr);
  }

  const outCustomers = roster.map((r) => {
    const id = r.id;
    const myInvs = invRows
      .filter((i) => i.customerId === id)
      .map((i) => {
        const open =
          num(i.balance) > 0 && !["paid", "void"].includes(String(i.status));
        return {
          kind: "inv" as const,
          docNumber: i.docNumber ?? null,
          date: iso(i.issueDate),
          total: num(i.total),
          open,
          openBalance: open ? num(i.balance) : 0,
          origin: i.origin,
          status: String(i.status ?? "sent"),
          lines: linesByInv.get(i.id) ?? [],
        };
      });
    const mySrs = srs
      .filter((s) => s.CustomerRef && qbToLocal.get(s.CustomerRef.value) === id)
      .filter((s) => s.TotalAmt !== 0) // voided SRs are zeroed in QBO
      .map((s) => ({
        kind: "sr" as const,
        docNumber: s.DocNumber ?? null,
        date: s.TxnDate,
        total: s.TotalAmt,
        open: false,
        openBalance: 0,
        origin: (s.DocNumber?.startsWith("2") ? "tj" : "feldart") as
          | "feldart"
          | "tj",
        status: "paid",
        lines: (s.Line ?? [])
          .filter((l) => l.SalesItemLineDetail?.ItemRef)
          .map((l) => {
            const ref = l.SalesItemLineDetail!.ItemRef!;
            const item = itemMap.get(ref.value);
            return {
              sku: item?.sku ?? null,
              name: item?.name ?? ref.name ?? null,
              qty: l.SalesItemLineDetail?.Qty ?? 0,
              lineTotal: l.Amount ?? 0,
            };
          }),
      }));
    const docs = [...myInvs, ...mySrs].sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    // hold periods: pair each hold_on with the next hold_off
    const holdPeriods: Array<{
      from: string;
      to: string | null;
      reason: string | null;
    }> = [];
    for (const a of holdActs.filter((x) => x.customerId === id)) {
      if (a.kind === "hold_on") {
        const meta = a.meta as Record<string, unknown> | null;
        holdPeriods.push({
          from: iso(a.occurredAt),
          to: null,
          reason: meta?.reason ? String(meta.reason) : null,
        });
      } else {
        const last = holdPeriods[holdPeriods.length - 1];
        if (last && last.to === null) last.to = iso(a.occurredAt);
      }
    }

    const myLifetime = lifetime
      .filter((l) => l.customerId === id)
      .map((l) => iso(l.issueDate));

    return {
      id,
      displayName: r.displayName,
      phone: r.phone ?? null,
      additionalPhones: r.additionalPhones ?? [],
      primaryEmail: r.primaryEmail ?? null,
      contacts: contacts
        .filter((c) => c.customerId === id)
        .map((c) => ({
          name: c.name ?? null,
          email: c.email ?? null,
          role: c.role ?? null,
          phone: c.phone ?? null,
        })),
      paymentTerms: r.paymentTerms ?? null,
      holdStatus: r.holdStatus,
      balance: num(r.balance),
      overdueBalance: num(r.overdueBalance),
      internalNotes: r.internalNotes ?? null,
      aiCustomerContext: r.aiCustomerContext ?? null,
      firstOrderDate: myLifetime[0] ?? null,
      lifetimeOrderDates: myLifetime,
      docs,
      holdPeriods,
      orderHoldNotes: orderHolds
        .filter((o) => o.customerId === id)
        .map((o) => ({
          date: iso(o.holdStartedAt),
          reason: o.holdReason ?? null,
          note: o.holdNote ?? null,
        })),
      creditMemos: cms
        .filter((c) => c.customerId === id)
        .map((c) => ({ date: iso(c.txnDate), total: num(c.total) })),
    };
  });

  // ---- Shopify: curated new-product set ----
  // Operator asked for "new july26"; the store's actual tag is
  // "new arrivals july 26" (verified against productTags 2026-09-01).
  const shopify = new ShopifyClient();
  type ShopifyProductsResp = {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        title: string;
        variants: { nodes: Array<{ sku: string | null }> };
      }>;
    };
  };
  const shopifyNewProducts: Array<{ sku: string; title: string }> = [];
  let after: string | null = null;
  do {
    const resp: ShopifyProductsResp = await shopify.graphql<ShopifyProductsResp>(
      `query($after: String) {
        products(first: 100, after: $after, query: "tag:'new arrivals july 26'") {
          pageInfo { hasNextPage endCursor }
          nodes { title variants(first: 50) { nodes { sku } } }
        }
      }`,
      { after },
    );
    for (const p of resp.products.nodes) {
      for (const v of p.variants.nodes) {
        if (v.sku) shopifyNewProducts.push({ sku: v.sku, title: p.title });
      }
    }
    after = resp.products.pageInfo.hasNextPage
      ? resp.products.pageInfo.endCursor
      : null;
  } while (after);
  console.error(
    `shopify "new arrivals july 26" tagged variant skus: ${shopifyNewProducts.length}`,
  );

  const out = {
    generatedAt: new Date().toISOString(),
    genDate: GEN_DATE,
    shopifyNewProducts,
    products: items
      .filter((i) => i.MetaData?.CreateTime && (i.Sku || i.Name))
      // Sellable product only: QBO Service items are shipping/admin
      // lines ("Shipping per item", "Name", …) and would pollute the
      // new-product pitch lists. Belt-and-braces name filter too.
      .filter(
        (i) =>
          i.Type !== "Service" &&
          !/shipp?ing|delivery|postage|freight/i.test(i.Name ?? ""),
      )
      .map((i) => ({
        sku: i.Sku ?? i.Name!,
        name: i.Name ?? i.Sku!,
        b2bPrice: i.UnitPrice ?? null,
        createdAt: i.MetaData!.CreateTime!,
      })),
    customers: outCustomers,
  };

  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(out), (err) =>
      err ? reject(err) : resolve(),
    );
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
