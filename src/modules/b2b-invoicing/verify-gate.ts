// Server-side parse-gap verify gate (audit #15).
//
// The /invoicing/today review screen flags possible shipment-parser misses:
//   1. Any invoice line the reconciler would REMOVE ("not shipped") — could be
//      a genuinely-shipped line the parser dropped (→ silent under-billing).
//   2. Rows in the source email's items table that couldn't be read
//      (ParseResult.unparsedRows).
// The UI blocks Send until the operator verifies each flagged removal against
// the source email and acknowledges any unreadable rows — but that gate lived
// client-side only. This module re-derives the same flags server-side so
// POST /send can fail closed when a stale client (or a bug) posts unverified
// removes.
//
// IMPORTANT: the flagging semantics here must mirror invoicing-today.tsx
// (`flaggedRemoveIds`) EXACTLY, so that a client that satisfied the UI gate
// always passes this one. The ReconcileTable collapses invoice lines by SKU
// and renders ONE verify checkbox per SKU — for the LAST remove action of
// that SKU (last-write wins in its display map) — so the gate also dedupes
// removes to the last lineId per uppercased SKU. Earlier duplicate-SKU
// removes are NOT flagged and need no verification.

import type { ReconcileAction } from "./types.js";

export type FlaggedRemove = { lineId: string; sku: string };

// Mirror of the client's `flaggedRemoveIds` useMemo (invoicing-today.tsx):
// last remove action per uppercased SKU wins; non-remove actions never flag.
export function deriveFlaggedRemoves(
  actions: ReconcileAction[],
): FlaggedRemove[] {
  const lastRemoveBySku = new Map<string, FlaggedRemove>();
  for (const a of actions) {
    if (a.type === "remove") {
      lastRemoveBySku.set(a.sku.toUpperCase(), { lineId: a.lineId, sku: a.sku });
    }
  }
  return Array.from(lastRemoveBySku.values());
}

export type VerifyGateInput = {
  actions: ReconcileAction[];
  // ParseResult.unparsedRows from re-parsing the source email. Callers may
  // pass [] without re-parsing when unreadAck is already true — the ack
  // covers any unreadable rows by definition.
  unparsedRows: string[];
  // QBO Line.Ids the operator ticked "verified" on (the same identifier the
  // client's verifiedLineIds Set holds). Extra/stale ids are harmless.
  verifiedRemoveLineIds: string[];
  // The operator's "checked the email" acknowledgement for unreadable rows.
  unreadAck: boolean;
};

export type VerifyGateResult =
  | { ok: true }
  | {
      ok: false;
      // Actionable operator-facing message naming the offending SKUs/rows.
      error: string;
      unverifiedRemoves: FlaggedRemove[];
      unacknowledgedUnreadRows: string[];
    };

export function checkVerifyGate(input: VerifyGateInput): VerifyGateResult {
  const verified = new Set(input.verifiedRemoveLineIds);
  const unverifiedRemoves = deriveFlaggedRemoves(input.actions).filter(
    (r) => !verified.has(r.lineId),
  );
  const unacknowledgedUnreadRows = input.unreadAck ? [] : input.unparsedRows;

  if (unverifiedRemoves.length === 0 && unacknowledgedUnreadRows.length === 0) {
    return { ok: true };
  }

  const parts: string[] = [];
  if (unverifiedRemoves.length > 0) {
    const n = unverifiedRemoves.length;
    const skus = unverifiedRemoves.map((r) => r.sku).join(", ");
    parts.push(
      `${n} removed line${n > 1 ? "s" : ""} not verified against the source email (SKU${n > 1 ? "s" : ""}: ${skus}) — tick "verified" on each flagged removal or use Keep instead`,
    );
  }
  if (unacknowledgedUnreadRows.length > 0) {
    const n = unacknowledgedUnreadRows.length;
    parts.push(
      `${n} unreadable row${n > 1 ? "s" : ""} in the source email not acknowledged — check the email and tick the acknowledgement`,
    );
  }
  return {
    ok: false,
    error: `parse-gap verification required: ${parts.join("; ")}. If you don't see the verify controls, refresh the page and review again.`,
    unverifiedRemoves,
    unacknowledgedUnreadRows,
  };
}
