// src/web/lib/search-schemas/customers.ts

import { z } from "zod";

// Mirrors the previous useState defaults in customers.tsx exactly.
// Every field uses .catch(default) so invalid/missing params fall back
// silently — bookmarks and stale storage never crash the page.
export const customersSearchSchema = z.object({
  tab: z
    .enum(["b2b", "b2c", "uncategorized", "all"])
    .catch("b2b"),
  search: z.string().catch(""),
  sort: z
    .enum([
      "displayName",
      "balance",
      "overdueBalance",
      "lastSyncedAt",
      "lastPaymentAt",
      "lastStatementSentAt",
      "lastContactedAt",
      "openTaskCount",
    ])
    .catch("balance"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  hideZero: z.boolean().catch(true),
  hasOverdue: z.boolean().catch(false),
  onHold: z.boolean().catch(false),
  missingTerms: z.boolean().catch(false),
  hasUnactionedEmail: z.boolean().catch(false),
});

export type CustomersSearch = z.infer<typeof customersSearchSchema>;
