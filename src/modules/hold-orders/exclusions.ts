// Settings → Exclusions: READ-ONLY summary of who is carved out of the
// automatic hold machinery. Editing stays on the customer page / rule editor.
//
//   never            customer_hold_rules.preset = 'never' (no rule holds,
//                    no overdue-review flag)
//   payment_upfront  customers.hold_status = 'payment_upfront' (prepay; held
//                    until the order is paid, not on terms)
//   account_hold     customers.hold_status = 'hold' (every order held)
//   ladder_off       held orders with orders.hold_ladder_enabled = 0 (no
//                    customer chase emails for that hold)
//   autopilot_off    customers.agent_mode_excluded = 1 (left out of the
//                    overdue-review flag)

import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { customerHoldRules } from "../../db/schema/hold-rules.js";
import { orders } from "../../db/schema/catalog.js";

export const EXCLUSION_KINDS = ["never", "payment_upfront", "account_hold", "ladder_off", "autopilot_off"] as const;
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number];

export type ExclusionItem = {
  customerId: string;
  customerName: string | null;
  orderId?: string;
  orderNumber?: string | null;
};

export type ExclusionGroup = { kind: ExclusionKind; count: number; items: ExclusionItem[] };

export const EXCLUSION_LIST_MAX = 100;
const SCAN_MAX = 5000;

function group(kind: ExclusionKind, items: ExclusionItem[]): ExclusionGroup {
  const sorted = [...items].sort((a, b) => (a.customerName ?? "").localeCompare(b.customerName ?? ""));
  return { kind, count: items.length, items: sorted.slice(0, EXCLUSION_LIST_MAX) };
}

export async function loadExclusions(): Promise<ExclusionGroup[]> {
  const [never, upfront, acctHold, ladderOff, autopilotOff] = await Promise.all([
    db
      .select({ customerId: customerHoldRules.customerId, customerName: customers.displayName })
      .from(customerHoldRules)
      .leftJoin(customers, eq(customers.id, customerHoldRules.customerId))
      .where(eq(customerHoldRules.preset, "never"))
      .limit(SCAN_MAX),
    db
      .select({ customerId: customers.id, customerName: customers.displayName })
      .from(customers)
      .where(eq(customers.holdStatus, "payment_upfront"))
      .limit(SCAN_MAX),
    db
      .select({ customerId: customers.id, customerName: customers.displayName })
      .from(customers)
      .where(eq(customers.holdStatus, "hold"))
      .limit(SCAN_MAX),
    db
      .select({
        customerId: orders.customerId,
        customerName: customers.displayName,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
      })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(and(eq(orders.holdState, "on_hold"), eq(orders.holdLadderEnabled, false)))
      .limit(SCAN_MAX),
    db
      .select({ customerId: customers.id, customerName: customers.displayName })
      .from(customers)
      .where(eq(customers.agentModeExcluded, true))
      .limit(SCAN_MAX),
  ]);
  return [
    group("never", never),
    group("payment_upfront", upfront),
    group("account_hold", acctHold),
    group(
      "ladder_off",
      ladderOff.map((r) => ({
        customerId: r.customerId ?? "",
        customerName: r.customerName,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
      })),
    ),
    group("autopilot_off", autopilotOff),
  ];
}
