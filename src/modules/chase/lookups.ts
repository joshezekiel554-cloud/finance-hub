// Drizzle lookups for chase candidate accounts.
//
// 1.0 read denormalized `qb_customer_state` rows; 2.0 reads from `customers` +
// `invoices` directly. We pull all customers with a positive `overdue_balance`,
// fetch their open invoices in one batched query, and let scoring.ts compute
// severity per row. Sort by score desc so top-of-list is highest priority.
//
// Origin-scoped variant: when an `origin` ('feldart' | 'tj') is supplied, the
// candidate set, overdue figures and severity are computed from ONLY that
// book's invoices (and that book's unapplied credit, netted via
// computeOriginBalances) rather than the blended denormalized customer fields.

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { creditMemos } from "../../db/schema/credit-memos.js";
import { customers, type Customer } from "../../db/schema/customers.js";
import { invoices, type Invoice } from "../../db/schema/invoices.js";
import type { InvoiceOrigin } from "../invoicing/origin.js";
import { computeOriginBalances } from "./balances.js";
import { computeSeverity } from "./scoring.js";
import type { OverdueCustomer } from "./types.js";

export async function getOverdueCustomers(
  origin?: InvoiceOrigin,
): Promise<OverdueCustomer[]> {
  return origin
    ? getOverdueCustomersForOrigin(origin)
    : getOverdueCustomersBlended();
}

// Blended (both books) — unchanged behaviour for the dashboard/agent callers.
async function getOverdueCustomersBlended(): Promise<OverdueCustomer[]> {
  const overdueCustomers = await db
    .select()
    .from(customers)
    .where(gt(customers.overdueBalance, "0"));

  if (overdueCustomers.length === 0) return [];

  const ids = overdueCustomers.map((c) => c.id);
  const openInvoices = await db
    .select()
    .from(invoices)
    .where(and(inArray(invoices.customerId, ids), gt(invoices.balance, "0")));

  const invoicesByCustomer = groupByCustomer(openInvoices);

  const rows: OverdueCustomer[] = overdueCustomers.map((customer) => {
    const customerInvoices = invoicesByCustomer.get(customer.id) ?? [];
    const severity = computeSeverity(customer, customerInvoices);
    return {
      customerId: customer.id,
      customer,
      invoices: customerInvoices,
      severity,
    };
  });

  return rows
    .filter((r) => r.severity.totalOverdue > 0)
    .sort((a, b) => b.severity.score - a.severity.score);
}

// One book only. Candidates are customers with ≥1 open invoice of `origin`;
// overdue/score are computed from that book's invoices netted by that book's
// unapplied credit.
async function getOverdueCustomersForOrigin(
  origin: InvoiceOrigin,
): Promise<OverdueCustomer[]> {
  const openInvoices = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.origin, origin), gt(invoices.balance, "0")));
  if (openInvoices.length === 0) return [];

  const invoicesByCustomer = groupByCustomer(openInvoices);
  const ids = [...invoicesByCustomer.keys()];

  const [customerRows, creditByCustomer] = await Promise.all([
    db.select().from(customers).where(inArray(customers.id, ids)),
    loadOriginCreditByCustomer(origin, ids),
  ]);
  const customerById = new Map(customerRows.map((c) => [c.id, c]));

  const rows: OverdueCustomer[] = [];
  for (const [customerId, customerInvoices] of invoicesByCustomer) {
    const customer = customerById.get(customerId);
    if (!customer) continue;
    const severity = originSeverity(customer, customerInvoices, origin, creditByCustomer.get(customerId) ?? 0);
    rows.push({ customerId, customer, invoices: customerInvoices, severity });
  }

  return rows
    .filter((r) => r.severity.totalOverdue > 0)
    .sort((a, b) => b.severity.score - a.severity.score);
}

// Single-customer lookup — useful for the agent surface when a tool wants the
// severity for one specific account without scanning the whole table.
export async function getOverdueForCustomer(
  customerId: string,
  origin?: InvoiceOrigin,
): Promise<OverdueCustomer | null> {
  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const customer = rows[0];
  if (!customer) return null;

  const customerInvoices = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, customerId),
        gt(invoices.balance, "0"),
        origin ? eq(invoices.origin, origin) : undefined,
      ),
    );

  let severity;
  if (origin) {
    const creditByCustomer = await loadOriginCreditByCustomer(origin, [customerId]);
    severity = originSeverity(customer, customerInvoices, origin, creditByCustomer.get(customerId) ?? 0);
  } else {
    severity = computeSeverity(customer, customerInvoices);
  }
  if (severity.totalOverdue <= 0) return null;

  return {
    customerId: customer.id,
    customer,
    invoices: customerInvoices,
    severity,
  };
}

// Compute severity for one book: net the origin's overdue via
// computeOriginBalances, then feed it to computeSeverity as an override so the
// score/tier/days reflect that book alone (not the blended customer fields).
function originSeverity(
  customer: Customer,
  customerInvoices: Invoice[],
  origin: InvoiceOrigin,
  credit: number,
) {
  const balances = computeOriginBalances(
    customerInvoices.map((i) => ({
      origin,
      balance: i.balance,
      dueDate: i.dueDate,
    })),
    { feldart: origin === "feldart" ? credit : 0, tj: origin === "tj" ? credit : 0 },
  );
  return computeSeverity(customer, customerInvoices, {
    rawOverdueOverride: balances[origin].overdue,
    unappliedCreditOverride: 0,
  });
}

async function loadOriginCreditByCustomer(
  origin: InvoiceOrigin,
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      customerId: creditMemos.customerId,
      total: sql<string>`SUM(${creditMemos.balance})`,
    })
    .from(creditMemos)
    .where(
      and(
        eq(creditMemos.origin, origin),
        inArray(creditMemos.customerId, ids),
        gt(creditMemos.balance, "0"),
      ),
    )
    .groupBy(creditMemos.customerId);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.customerId, Number(r.total) || 0);
  return map;
}

function groupByCustomer(rows: Invoice[]): Map<string, Invoice[]> {
  const byCustomer = new Map<string, Invoice[]>();
  for (const inv of rows) {
    const list = byCustomer.get(inv.customerId);
    if (list) list.push(inv);
    else byCustomer.set(inv.customerId, [inv]);
  }
  return byCustomer;
}

export type { Customer, Invoice };
