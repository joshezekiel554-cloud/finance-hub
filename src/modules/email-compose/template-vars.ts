import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import type { User } from "../../db/schema/auth.js";

export type TemplateVars = {
  customer_name: string;
  primary_email: string;
  open_balance: string;
  overdue_balance: string;
  days_overdue: string;
  oldest_unpaid_invoice: string;
  oldest_unpaid_amount: string;
  user_name: string;
  company_name: string;
  thread_subject: string;
  statement_table?: string;
};

const COMPANY_NAME = "Feldart";

const DAY_MS = 1000 * 60 * 60 * 24;

// Tolerates surrounding whitespace inside the braces, e.g. {{ key }} matches.
// Captures the key name itself (alphanumerics + underscore, the variable
// charset we use across templates). Unknown vars are left intact (see
// renderTemplate) so missing-data bugs are visible in the rendered output
// rather than silently producing empty strings.
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderTemplate(
  template: string,
  vars: Partial<TemplateVars> & Record<string, string | undefined>,
): string {
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : value;
  });
}

export function formatMoney(
  amount: string | number | null | undefined,
): string {
  const n = parseAmount(amount);
  // Pre-round half-up to 2 decimals before handing to Intl. The +EPSILON
  // nudge defeats the classic 0.005 → 0.00 floating-point trap so the
  // rendered value matches what an accountant would expect.
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(rounded);
}

function parseAmount(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toDate(v: string | Date | null): Date | null {
  if (v === null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  // Drizzle stores `date` columns as 'YYYY-MM-DD'; pin to UTC midnight so
  // local TZ doesn't roll the day backward when we compute days_overdue.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDayUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function daysOverdueFor(invoice: Invoice | null | undefined, now: Date): number {
  if (!invoice) return 0;
  const due = toDate(invoice.dueDate);
  if (!due) return 0;
  const diff = startOfDayUtc(now).getTime() - startOfDayUtc(due).getTime();
  return Math.max(0, Math.floor(diff / DAY_MS));
}

function pickOldestUnpaid(invoices: Invoice[]): Invoice | null {
  let oldest: Invoice | null = null;
  let oldestDue: number = Number.POSITIVE_INFINITY;
  for (const inv of invoices) {
    if (parseAmount(inv.balance) <= 0) continue;
    const due = toDate(inv.dueDate);
    if (!due) continue;
    const t = due.getTime();
    if (t < oldestDue) {
      oldestDue = t;
      oldest = inv;
    }
  }
  return oldest;
}

export type BuildTemplateVarsInput = {
  customer: Pick<Customer, "displayName" | "primaryEmail" | "balance" | "overdueBalance">;
  openInvoices: Invoice[];
  user: Pick<User, "name">;
  oldestUnpaid?: Invoice | null;
  now?: Date;
};

export function buildTemplateVars(input: BuildTemplateVarsInput): TemplateVars {
  const { customer, openInvoices, user, oldestUnpaid, now } = input;
  const today = now ?? new Date();
  const oldest = oldestUnpaid ?? pickOldestUnpaid(openInvoices);
  const days = daysOverdueFor(oldest, today);

  return {
    customer_name: customer.displayName ?? "",
    primary_email: customer.primaryEmail ?? "",
    open_balance: formatMoney(customer.balance),
    overdue_balance: formatMoney(customer.overdueBalance),
    days_overdue: String(days),
    oldest_unpaid_invoice: oldest?.docNumber ?? "",
    oldest_unpaid_amount: formatMoney(oldest?.balance ?? 0),
    user_name: user.name ?? "",
    company_name: COMPANY_NAME,
    thread_subject: "",
  };
}
