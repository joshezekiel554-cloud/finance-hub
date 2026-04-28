import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import type { CHASE_METHODS, CHASE_SEVERITIES } from "../../db/schema/audit.js";

export type ChaseTier = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ChaseMethod = (typeof CHASE_METHODS)[number];
export type ChaseSeverityLevel = (typeof CHASE_SEVERITIES)[number];

export type Severity = {
  score: number;
  tier: ChaseTier;
  daysOverdue: number;
  totalOverdue: number;
  oldestUnpaidDate: string | null;
};

export type OverdueCustomer = {
  customerId: string;
  customer: Customer;
  invoices: Invoice[];
  severity: Severity;
};
