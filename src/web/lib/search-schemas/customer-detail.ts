// src/web/lib/search-schemas/customer-detail.ts
//
// Single schema for the customer-detail page. Tab is top-level. Per-tab
// filters use namespace prefixes (inv*, email*) so switching tabs preserves
// the other tabs' filter state.
//
// Tasks/Activity/Orders/Notes: no list-style filter state — omitted.
// Returns: filter state lives inside ReturnsPanel sub-component, not page-level.

import { z } from "zod";

export const customerDetailSearchSchema = z.object({
  tab: z
    .enum([
      "activity",
      "emails",
      "invoices",
      "orders",
      "tasks",
      "notes",
      "returns",
    ])
    .catch("activity"),

  // ---- Invoices tab (prefix "inv") ----
  // Types mirror InvoicesPanel-private StatusFilter / TypeFilter / SortKey
  invStatus: z
    .enum(["all", "open", "paid", "overdue", "sent", "void"])
    .catch("all"),
  invType: z.enum(["all", "invoice", "credit_memo"]).catch("all"),
  invSearch: z.string().catch(""),
  invSort: z
    .enum(["issueDate", "docNumber", "total", "balance", "lastChasedAt"])
    .catch("issueDate"),
  invDir: z.enum(["asc", "desc"]).catch("desc"),

  // ---- Emails tab (prefix "email") ----
  // Types mirror EmailList-private DirectionFilter / ActionedFilter
  emailDirection: z.enum(["all", "inbound", "outbound"]).catch("all"),
  emailActioned: z.enum(["open", "done", "all"]).catch("open"),
});

export type CustomerDetailSearch = z.infer<typeof customerDetailSearchSchema>;
