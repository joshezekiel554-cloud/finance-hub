// One-off Monday.com → Finance Hub terms sync. Two endpoints:
//
//   POST /api/monday-sync/preview-terms — fetch the Monday board, match
//     each row to a customer (email-first, name fallback), classify the
//     match confidence, and return a dry-run preview. No writes.
//
//   POST /api/monday-sync/apply-terms — accept the operator's selected
//     monday-row → customer-id pairs and write the mapped terms string
//     to customers.payment_terms. One UPDATE per match. Audited.
//
// Rationale for the two-step flow: the operator wants eyes on every
// match before any write — name collisions (Monday "Amarosa Home" maps
// to QBO "Abraham Stern" because the email lines up), comma-separated
// emails, parenthetical name suffixes, etc. Better one preview API
// + one apply API than embedding "preview" as a query param on apply.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { auditLog } from "../../db/schema/audit.js";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import { requireAuth } from "../lib/auth.js";
import {
  fetchTermsBoardRows,
  type MondayStoreRow,
} from "../../integrations/monday/client.js";

const log = createLogger({ component: "routes.monday-sync" });

// Map Monday's free-text terms column to the canonical display string we
// store in customers.payment_terms. Lower-cased + trimmed comparison so
// "60 Days" / " 60 days  " / "60days" all resolve. Returns null when
// the value is empty or unrecognised — the preview surfaces those rows
// as "skip" with the original raw value visible.
function mapTerms(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return null;
  if (v === "30 days" || v === "30days") return "Net 30";
  if (v === "45 days" || v === "45days") return "Net 45";
  if (v === "60 days" || v === "60days") return "Net 60";
  if (v === "90 days" || v === "90days") return "Net 90";
  if (v === "upfront" || v === "due on receipt" || v === "prepay")
    return "Due on Receipt";
  return null;
}

// Normalise a name for fuzzy matching: lowercase, strip accents,
// collapse whitespace, drop trailing parentheticals like
// " (Shane Vorhand)" so the board's "Aura Home (Shane Vorhand)" matches
// QBO's "Aura Home". Punctuation-only differences (hyphens, ampersands)
// are preserved — the board's cleaner so we don't want to over-match.
function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse the email column (may be comma- or semicolon-separated) into a
// deduped list of lower-cased addresses.
function parseEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(parts));
}

type CustomerLookup = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  billingEmails: string[];
  paymentTerms: string | null;
};

// Pull all customers once (~2,400 rows for Feldart). Build email +
// normalized-name indexes for O(1) lookup. Cheaper than 140 individual
// SELECTs against MySQL.
async function buildCustomerIndex(): Promise<{
  byEmail: Map<string, CustomerLookup>;
  byNormName: Map<string, CustomerLookup[]>;
}> {
  const rows = await db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
      paymentTerms: customers.paymentTerms,
    })
    .from(customers);

  const byEmail = new Map<string, CustomerLookup>();
  const byNormName = new Map<string, CustomerLookup[]>();
  for (const r of rows) {
    const billing = Array.isArray(r.billingEmails)
      ? (r.billingEmails as string[])
      : [];
    const lookup: CustomerLookup = {
      id: r.id,
      displayName: r.displayName ?? "",
      primaryEmail: r.primaryEmail,
      billingEmails: billing,
      paymentTerms: r.paymentTerms,
    };
    if (r.primaryEmail) {
      byEmail.set(r.primaryEmail.toLowerCase(), lookup);
    }
    for (const e of billing) {
      if (typeof e === "string" && e) {
        byEmail.set(e.toLowerCase(), lookup);
      }
    }
    const k = normalizeName(r.displayName);
    if (k) {
      const arr = byNormName.get(k) ?? [];
      arr.push(lookup);
      byNormName.set(k, arr);
    }
  }
  return { byEmail, byNormName };
}

type PreviewRow = {
  mondayId: string;
  mondayName: string;
  mondayEmail: string | null;
  mondayTerms: string | null;
  // null when the Monday value isn't a known term (e.g. blank, "TBD")
  mappedTerm: string | null;
  match: {
    customerId: string | null;
    customerName: string | null;
    currentTerm: string | null;
    via: "email" | "name" | "name_ambiguous" | "none";
    matchedEmail?: string;
    candidates?: Array<{ id: string; displayName: string }>;
  };
  // True when the Monday value cleanly maps + we have a single match +
  // the new term differs from the existing one. Default-checked in UI.
  recommended: boolean;
};

const monthSyncRoute: FastifyPluginAsync = async (app) => {
  app.post("/preview-terms", async (req, reply) => {
    await requireAuth(req);
    if (!env.MONDAY_API_TOKEN || !env.MONDAY_TERMS_BOARD_ID) {
      return reply
        .code(503)
        .send({ error: "Monday integration not configured" });
    }

    const [rows, index] = await Promise.all([
      fetchTermsBoardRows(env.MONDAY_TERMS_BOARD_ID),
      buildCustomerIndex(),
    ]);

    const preview: PreviewRow[] = rows.map((mr) =>
      classifyRow(mr, index),
    );

    // Stable sort: matched rows that change something first, then
    // matched-no-change, then unmatched/skip. Keeps the list scannable
    // in the UI.
    const order = (r: PreviewRow): number => {
      if (r.recommended) return 0;
      if (r.match.customerId) return 1;
      return 2;
    };
    preview.sort((a, b) => {
      const d = order(a) - order(b);
      if (d !== 0) return d;
      return a.mondayName.localeCompare(b.mondayName);
    });

    const stats = {
      total: preview.length,
      matchedByEmail: preview.filter((p) => p.match.via === "email").length,
      matchedByName: preview.filter((p) => p.match.via === "name").length,
      ambiguous: preview.filter((p) => p.match.via === "name_ambiguous")
        .length,
      unmatched: preview.filter((p) => p.match.via === "none").length,
      recommended: preview.filter((p) => p.recommended).length,
      unrecognizedTerms: preview.filter(
        (p) => p.mondayTerms && !p.mappedTerm,
      ).length,
    };

    return reply.send({ rows: preview, stats });
  });

  // Body shape: { applies: Array<{ customerId: string, term: string }> }
  // The frontend builds this from the operator's checkbox selection in
  // the preview screen. We deliberately don't take the Monday id —
  // there's no need to keep it after the write, and accepting it would
  // tempt callers to skip the preview step.
  const applyBodySchema = z.object({
    applies: z
      .array(
        z.object({
          customerId: z.string().min(1).max(64),
          term: z.string().min(1).max(64),
        }),
      )
      .min(1)
      .max(500),
  });

  app.post("/apply-terms", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = applyBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { applies } = parse.data;

    let updated = 0;
    let skipped = 0;
    const failures: Array<{ customerId: string; reason: string }> = [];

    for (const a of applies) {
      try {
        const before = await db
          .select({
            id: customers.id,
            paymentTerms: customers.paymentTerms,
          })
          .from(customers)
          .where(eq(customers.id, a.customerId))
          .limit(1);
        if (before.length === 0) {
          failures.push({ customerId: a.customerId, reason: "not_found" });
          continue;
        }
        if (before[0]!.paymentTerms === a.term) {
          skipped++;
          continue;
        }
        await db
          .update(customers)
          .set({ paymentTerms: a.term })
          .where(eq(customers.id, a.customerId));

        await db.insert(auditLog).values({
          id: nanoid(24),
          userId: user.id,
          action: "customer.update",
          entityType: "customer",
          entityId: a.customerId,
          before: { paymentTerms: before[0]!.paymentTerms } as Record<
            string,
            unknown
          >,
          after: { paymentTerms: a.term } as Record<string, unknown>,
        });
        updated++;
      } catch (err) {
        log.error(
          { err, customerId: a.customerId, term: a.term },
          "apply-terms write failed",
        );
        failures.push({
          customerId: a.customerId,
          reason: (err as Error).message ?? "unknown",
        });
      }
    }

    log.info(
      { updated, skipped, failures: failures.length, by: user.id },
      "monday terms apply complete",
    );

    return reply.send({ updated, skipped, failures });
  });
};

function classifyRow(
  mr: MondayStoreRow,
  index: {
    byEmail: Map<string, CustomerLookup>;
    byNormName: Map<string, CustomerLookup[]>;
  },
): PreviewRow {
  const mappedTerm = mapTerms(mr.termsRaw);
  const emails = parseEmails(mr.emailRaw);

  // Email path — first email that resolves wins.
  let viaEmail: { lookup: CustomerLookup; email: string } | null = null;
  for (const e of emails) {
    const hit = index.byEmail.get(e);
    if (hit) {
      viaEmail = { lookup: hit, email: e };
      break;
    }
  }

  if (viaEmail) {
    return {
      mondayId: mr.id,
      mondayName: mr.name,
      mondayEmail: mr.emailRaw,
      mondayTerms: mr.termsRaw,
      mappedTerm,
      match: {
        customerId: viaEmail.lookup.id,
        customerName: viaEmail.lookup.displayName,
        currentTerm: viaEmail.lookup.paymentTerms,
        via: "email",
        matchedEmail: viaEmail.email,
      },
      recommended: Boolean(
        mappedTerm && mappedTerm !== viaEmail.lookup.paymentTerms,
      ),
    };
  }

  // Name path — exact match on normalized form. If multiple QBO
  // customers normalise to the same string, surface as ambiguous so the
  // operator can disambiguate manually.
  const norm = normalizeName(mr.name);
  const candidates = norm ? (index.byNormName.get(norm) ?? []) : [];
  if (candidates.length === 1) {
    const c = candidates[0]!;
    return {
      mondayId: mr.id,
      mondayName: mr.name,
      mondayEmail: mr.emailRaw,
      mondayTerms: mr.termsRaw,
      mappedTerm,
      match: {
        customerId: c.id,
        customerName: c.displayName,
        currentTerm: c.paymentTerms,
        via: "name",
      },
      recommended: Boolean(mappedTerm && mappedTerm !== c.paymentTerms),
    };
  }
  if (candidates.length > 1) {
    return {
      mondayId: mr.id,
      mondayName: mr.name,
      mondayEmail: mr.emailRaw,
      mondayTerms: mr.termsRaw,
      mappedTerm,
      match: {
        customerId: null,
        customerName: null,
        currentTerm: null,
        via: "name_ambiguous",
        candidates: candidates.map((c) => ({
          id: c.id,
          displayName: c.displayName,
        })),
      },
      recommended: false,
    };
  }
  return {
    mondayId: mr.id,
    mondayName: mr.name,
    mondayEmail: mr.emailRaw,
    mondayTerms: mr.termsRaw,
    mappedTerm,
    match: {
      customerId: null,
      customerName: null,
      currentTerm: null,
      via: "none",
    },
    recommended: false,
  };
}

export default monthSyncRoute;

// Exported for the test file.
export { mapTerms, normalizeName, parseEmails };

// Suppress unused-warning when sql is not referenced by all branches; some
// drizzle helpers like sql are tree-shaken depending on actual use.
void sql;
