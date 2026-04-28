// Drizzle lookups for chase candidate accounts.
//
// 1.0 read denormalized `qb_customer_state` rows; 2.0 reads from `customers` +
// `invoices` directly. We pull all customers with a positive `overdue_balance`,
// fetch their open invoices in one batched query, and let scoring.ts compute
// severity per row. Sort by score desc so top-of-list is highest priority.

import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers, type Customer } from "../../db/schema/customers.js";
import { invoices, type Invoice } from "../../db/schema/invoices.js";
import { computeSeverity } from "./scoring.js";
import type { OverdueCustomer } from "./types.js";

export async function getOverdueCustomers(): Promise<OverdueCustomer[]> {
  const overdueCustomers = await db
    .select()
    .from(customers)
    .where(gt(customers.overdueBalance, "0"));

  if (overdueCustomers.length === 0) return [];

  const ids = overdueCustomers.map((c) => c.id);
  const openInvoices = await db
    .select()
    .from(invoices)
    .where(
      and(inArray(invoices.customerId, ids), gt(invoices.balance, "0")),
    );

  const invoicesByCustomer = new Map<string, Invoice[]>();
  for (const inv of openInvoices) {
    const list = invoicesByCustomer.get(inv.customerId);
    if (list) list.push(inv);
    else invoicesByCustomer.set(inv.customerId, [inv]);
  }

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

// Single-customer lookup — useful for the agent surface when a tool wants the
// severity for one specific account without scanning the whole table.
export async function getOverdueForCustomer(
  customerId: string,
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
    .where(and(eq(invoices.customerId, customerId), gt(invoices.balance, "0")));

  const severity = computeSeverity(customer, customerInvoices);
  if (severity.totalOverdue <= 0) return null;

  return {
    customerId: customer.id,
    customer,
    invoices: customerInvoices,
    severity,
  };
}

export type { Customer, Invoice };
