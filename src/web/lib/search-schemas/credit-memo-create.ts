// src/web/lib/search-schemas/credit-memo-create.ts
//
// Search params for /returns/$rmaId/credit-memo. Currently no params, but
// reserve the schema slot so future filters can be added without a route
// signature change.

import { z } from "zod";

export const creditMemoCreateSearchSchema = z.object({});
export type CreditMemoCreateSearch = z.infer<typeof creditMemoCreateSearchSchema>;
