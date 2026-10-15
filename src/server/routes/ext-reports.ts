// GET /api/ext/reports/* — finance's row reports for Feldart AI (hub
// "sheet-from-rows" flow, PLAN.md §5/§8, agreed 2026-10-15). The hub calls
// these server-to-server with a hub service token, then hands the
// {title, asOf, columns, rows, totals, warnings} table to internal's
// Sheet writer. Read-only; nothing here mutates state.
//
//   customers?q=                      → {customers:[{id,name,email}]} (picker)
//   returns?from&to[&customerId][&view=rmas|lines]
//   open-invoices?customerId[&book=feldart|tj|both]
//   aged-debtors[?book=feldart|tj|both]

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { requireHubService } from "../lib/hub-service-auth.js";
import { loadAgedDebtors } from "../../modules/reports/aged-debtors.js";
import {
  loadOpenInvoices,
  ReportNotFoundError,
} from "../../modules/reports/open-invoices.js";
import { loadReturnsReport } from "../../modules/reports/returns.js";
import { searchCustomerOptions } from "../../modules/reports/customers.js";

const log = createLogger({ component: "routes.ext-reports" });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  // Round-trip, not Date.parse: V8 rolls 2026-02-31 over to 3 March.
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "invalid date");
const book = z.enum(["feldart", "tj", "both"]).default("both");

// Exported for schema-level tests (no Fastify harness in repo).
export const customersQuerySchema = z.object({ q: z.string().trim().min(1).max(100) });
export const returnsQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    customerId: z.string().min(1).max(64).optional(),
    view: z.enum(["rmas", "lines"]).default("rmas"),
  })
  .refine((v) => v.from <= v.to, { message: "from must be on or before to", path: ["from"] });
export const openInvoicesQuerySchema = z.object({
  customerId: z.string().min(1).max(64),
  book,
});
export const agedDebtorsQuerySchema = z.object({ book });

const base = () => env.PUBLIC_URL.replace(/\/$/, "");
const customerUrl = (id: string) => `${base()}/customers/${id}`;
const rmaUrl = (id: string) => `${base()}/returns/${id}`;

const extReportsRoute: FastifyPluginAsync = async (app) => {
  app.get("/reports/customers", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    const parse = customersQuerySchema.safeParse(req.query ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid query", details: parse.error.flatten() });
    }
    return reply.send({ customers: await searchCustomerOptions(parse.data.q) });
  });

  app.get("/reports/returns", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    const parse = returnsQuerySchema.safeParse(req.query ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid query", details: parse.error.flatten() });
    }
    try {
      const table = await loadReturnsReport({ ...parse.data, now: new Date(), rmaUrl });
      log.info({ email: claims.email, report: "returns", rows: table.rows.length }, "report served");
      return reply.send(table);
    } catch (err) {
      log.error({ err, email: claims.email }, "returns report failed");
      return reply.code(500).send({ error: "report failed" });
    }
  });

  app.get("/reports/open-invoices", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    const parse = openInvoicesQuerySchema.safeParse(req.query ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid query", details: parse.error.flatten() });
    }
    try {
      const table = await loadOpenInvoices({ ...parse.data, now: new Date() });
      log.info(
        { email: claims.email, report: "open-invoices", customerId: parse.data.customerId, rows: table.rows.length },
        "report served",
      );
      return reply.send(table);
    } catch (err) {
      if (err instanceof ReportNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      log.error({ err, email: claims.email }, "open-invoices report failed");
      return reply.code(500).send({ error: "report failed" });
    }
  });

  app.get("/reports/aged-debtors", async (req, reply) => {
    const claims = requireHubService(req, reply);
    if (!claims) return reply;
    const parse = agedDebtorsQuerySchema.safeParse(req.query ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid query", details: parse.error.flatten() });
    }
    try {
      const table = await loadAgedDebtors({ book: parse.data.book, now: new Date(), customerUrl });
      log.info({ email: claims.email, report: "aged-debtors", rows: table.rows.length }, "report served");
      return reply.send(table);
    } catch (err) {
      log.error({ err, email: claims.email }, "aged-debtors report failed");
      return reply.code(500).send({ error: "report failed" });
    }
  });
};

export default extReportsRoute;
