// src/web/lib/search-schemas/statements.ts
//
// Mirrors the previous useState defaults in statements.tsx.

import { z } from "zod";

export const statementsSearchSchema = z.object({
  range: z.enum(["7d", "30d", "90d", "all"]).catch("30d"),
  senderId: z.string().catch("all"),
  offset: z.number().int().min(0).catch(0),
});

export type StatementsSearch = z.infer<typeof statementsSearchSchema>;
