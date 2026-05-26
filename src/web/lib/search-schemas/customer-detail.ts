// src/web/lib/search-schemas/customer-detail.ts
//
// Single schema for the customer-detail page. Tab is top-level. Per-tab
// filters use namespace prefixes (inv*, email*) so switching tabs preserves
// the other tabs' filter state.
//
// Tasks/Activity/Orders/Notes: no list-style filter state — omitted.
// Returns: filter state lives inside ReturnsPanel sub-component, not page-level.

import { z } from "zod";
import { RMA_STATUSES, RMA_RETURN_TYPES } from "../../../db/schema/returns";

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
      "calls_sms",
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

  // ---- Returns tab (prefix "rma") ----
  rmaStatus: z.enum(["all", ...RMA_STATUSES]).catch("all"),
  rmaType: z.enum(["all", ...RMA_RETURN_TYPES]).catch("all"),

  // Dashboard widget "Draft reply" deep-link: when this is set, the page
  // opens the compose modal in AI-draft mode for the named email_log row.
  // The page clears the param from the URL on first read so it doesn't
  // persist across navigations.
  draftReplyFor: z.string().optional().catch(undefined),
});

export type CustomerDetailSearch = z.infer<typeof customerDetailSearchSchema>;
