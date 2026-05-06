// src/web/lib/search-schemas/returns.ts
//
// Mirrors the previous useState defaults in returns.tsx exactly.
// .catch(default) on every field so invalid params fall back silently.

import { z } from "zod";
import { RMA_STATUSES, RMA_RETURN_TYPES } from "../../../db/schema/returns";

export const returnsSearchSchema = z.object({
  view: z.enum(["kanban", "list"]).catch("list"),
  status: z
    .enum([
      ...RMA_STATUSES,
      "all",
    ] satisfies [string, ...string[]])
    .catch("all"),
  type: z
    .enum([
      ...RMA_RETURN_TYPES,
      "all",
    ] satisfies [string, ...string[]])
    .catch("all"),
  search: z.string().catch(""),
});

export type ReturnsSearch = z.infer<typeof returnsSearchSchema>;
