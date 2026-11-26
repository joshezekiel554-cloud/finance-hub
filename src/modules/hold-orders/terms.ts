// Customer payment terms → days, plus the "Net 60 · holds at day 75 (15 days
// overdue)" line. PURE (shared with the Hold Orders SPA).
//
// Terms are owned by finance (customers.payment_terms, edited on the finance
// customer page and pushed to QBO). Hold Orders only SHOWS them.

import { graceText } from "./presets.js";

/** "Net 60" → 60, "Due on Receipt" → 0, anything else / blank → null. */
export function parseTermsDays(terms: string | null | undefined): number | null {
  const t = (terms ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^due (on|upon) receipt$/.test(t)) return 0;
  const m = /^net\s*(\d{1,3})$/.exec(t);
  return m ? Number(m[1]) : null;
}

export type TermsLine =
  | { known: true; text: string }
  | { known: false; text: string };

/**
 * The read-only terms line for a customer under a rule:
 *   - known terms + a rule:  "Net 60 · holds at day 75 (15 days overdue)"
 *   - known terms, no rule:  "Net 60"
 *   - "never":               "Net 60 · never held automatically"
 *   - unknown terms:         { known:false, "Terms not set" } (+ grace text when there's a rule)
 */
export function termsLine(
  paymentTerms: string | null | undefined,
  rule: { preset: string; graceDays: number } | null,
): TermsLine {
  const days = parseTermsDays(paymentTerms);
  const label = (paymentTerms ?? "").trim();
  if (days == null) {
    if (!rule || rule.preset === "never") return { known: false, text: "Terms not set" };
    return { known: false, text: `Terms not set · holds ${graceText(rule.graceDays)}` };
  }
  if (!rule) return { known: true, text: label };
  if (rule.preset === "never") return { known: true, text: `${label} · never held automatically` };
  const holdDay = days + rule.graceDays;
  const grace = rule.graceDays <= 0 ? "as soon as overdue" : graceText(rule.graceDays);
  return { known: true, text: `${label} · holds at day ${holdDay} (${grace})` };
}
