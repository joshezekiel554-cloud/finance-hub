// src/server/modules/rma/rma-number-format.ts
//
// Single source of truth for RMA number patterns. Used by the email
// linker to detect RMA references in inbound email subject + body.
//
// Patterns:
//   - DC##### for damage credit memos (5-digit, currently starts at DC38771)
//   - 5-7 digit sequential for seasonal/non-seasonal
//   - <rmaNumber>CR is the credit memo doc number (NOT auto-link target —
//     a CM doc number references back to its source RMA but linking the
//     CM email to the RMA via this pattern would create circular noise).

const DAMAGE_RE = /\bDC\d{5}\b/g;
const SEASONAL_RE = /\b\d{5,7}\b/g;

// Anchored exclusion: don't pick up <number>CR — that's a CM doc number.
const CR_SUFFIX_RE = /\b\d+CR\b/g;

export type ExtractedRmaRef = { number: string; kind: "damage" | "sequential" };

export function extractRmaNumbers(text: string): ExtractedRmaRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: ExtractedRmaRef[] = [];

  // Strip CM doc number patterns first so they don't show up as bare digits
  const cleaned = text.replace(CR_SUFFIX_RE, "");

  for (const m of cleaned.matchAll(DAMAGE_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      refs.push({ number: m[0], kind: "damage" });
    }
  }

  for (const m of cleaned.matchAll(SEASONAL_RE)) {
    // Skip if already captured as a damage number (DC##### contains a 5-digit run)
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      refs.push({ number: m[0], kind: "sequential" });
    }
  }

  return refs;
}
