// Feldart AI (hub) proposals are settled ONLY on the hub's Confirm card, by
// the member who asked (routes/ext-tools.ts proposalsRoute). Every in-app
// path that could approve, edit, dismiss or delete an ai_proposals row
// must refuse them — otherwise anyone with a finance login could send a
// hub-drafted email (or rewrite its recipients) without that click.

import { sql } from "drizzle-orm";
import { aiProposals } from "../../db/schema/ai-proposals.js";

export const HUB_ONLY_MESSAGE =
  "This change is waiting on its Confirm card in Feldart AI — only the person who asked can confirm or cancel it there.";

export function isHubProposal(p: { candidateSummary: unknown } | null | undefined): boolean {
  const s = p?.candidateSummary;
  return typeof s === "object" && s !== null && (s as { via?: unknown }).via === "hub";
}

/** SQL filter: rows that are NOT hub proposals. */
export const notHubProposalSql = sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${aiProposals.candidateSummary}, '$.via')), '') <> 'hub'`;
