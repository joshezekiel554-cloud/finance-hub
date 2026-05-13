// src/web/lib/search-schemas/invoicing-today.ts
//
// Mirrors the previous useState default in invoicing-today.tsx.

import { z } from "zod";

export const invoicingTodaySearchSchema = z.object({
  tab: z
    .enum(["open", "unparseable", "sent", "dismissed", "phone_calls"])
    .catch("open"),
});

export type InvoicingTodaySearch = z.infer<typeof invoicingTodaySearchSchema>;
