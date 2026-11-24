// Claim-then-send helper. Every hold state change that may email someone
// first CLAIMS the transition with a conditional UPDATE (… WHERE id = ? AND
// hold_state = <expected>) and only sends when exactly one row was claimed —
// so two concurrent passes (or a person acting between our read and our
// write) can never produce a duplicate or stale email.
//
// Drizzle's mysql2 driver resolves update() to [ResultSetHeader, fields];
// ResultSetHeader.affectedRows is the number of rows the WHERE matched.

export function affectedRows(result: unknown): number {
  const header: unknown = Array.isArray(result) ? result[0] : result;
  if (header && typeof header === "object" && "affectedRows" in header) {
    const n = (header as { affectedRows: unknown }).affectedRows;
    return typeof n === "number" ? n : 0;
  }
  return 0;
}
