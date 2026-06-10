// src/web/lib/search-schemas/chase.ts
//
// Mirrors the previous useState defaults in chase.tsx exactly.

import { z } from "zod";

export const chaseSearchSchema = z.object({
  // No `origin` param: /chase shows both books as two sections (origin-
  // split-2). Stale bookmarked ?origin=… values are dropped silently.
  customerType: z.enum(["b2b", "b2c", "all"]).catch("b2b"),
  holdStatus: z.enum(["active", "hold", "all"]).catch("all"),
  missingTerms: z.boolean().catch(false),
  hasPendingRma: z.boolean().catch(false),
  sort: z
    .enum([
      "overdueBalance",
      "daysOverdue",
      "displayName",
      "lastActivityAt",
      "balance",
      "lastPaymentAt",
      "lastStatementSentAt",
    ])
    .catch("overdueBalance"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
});

export type ChaseSearch = z.infer<typeof chaseSearchSchema>;
