import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "~/db/index.js";
import { emailLog } from "~/db/schema/crm.js";
import { customers } from "~/db/schema/customers.js";
import { oauthTokens } from "~/db/schema/oauth.js";
import { createLogger } from "~/lib/logger.js";
import { recordActivity } from "~/modules/crm/index.js";
import { searchEmails } from "./client.js";
import type {
  GmailProviderMeta,
  ParsedEmail,
  PollResult,
} from "./types.js";

const log = createLogger({ module: "gmail.poller" });

// Default look-back window for the very first poll (no cursor stored). After
// that we use the lastPollAt cursor and ratchet forward.
const DEFAULT_INITIAL_LOOKBACK_DAYS = 7;
const DEFAULT_MAX_RESULTS = 500;

// Business outbound addresses — anything sent FROM these counts as outbound.
// Sourced from 1.0's gmail-engine.js. Should eventually be derived from the
// connected mailbox's aliases instead of hardcoded; tracked for week 7.
//
// TODO(week-7): replace with listAliases() result so adding a new sendAs
// inside Gmail automatically classifies outbound without a code change.
const BUSINESS_EMAILS = new Set<string>([
  "info@feldart.com",
  "accounts@feldart.com",
  "admin@feldart.co.uk",
]);

// --- Cursor persistence (oauth_tokens.meta as JSON) ---

async function loadProviderRow(externalAccountId?: string): Promise<{
  rowId: string;
  externalAccountId: string;
  meta: GmailProviderMeta;
} | null> {
  const rows = externalAccountId
    ? await db
        .select({
          id: oauthTokens.id,
          externalAccountId: oauthTokens.externalAccountId,
          meta: oauthTokens.meta,
          revokedAt: oauthTokens.revokedAt,
        })
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.provider, "gmail"),
            eq(oauthTokens.externalAccountId, externalAccountId),
          ),
        )
        .limit(1)
    : await db
        .select({
          id: oauthTokens.id,
          externalAccountId: oauthTokens.externalAccountId,
          meta: oauthTokens.meta,
          revokedAt: oauthTokens.revokedAt,
        })
        .from(oauthTokens)
        .where(eq(oauthTokens.provider, "gmail"))
        .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt) return null;
  if (row.externalAccountId.startsWith("pending:")) return null;

  let meta: GmailProviderMeta = {};
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta) as GmailProviderMeta;
    } catch {
      log.warn({ rowId: row.id }, "oauth_tokens.meta was not valid JSON; resetting");
      meta = {};
    }
  }
  return { rowId: row.id, externalAccountId: row.externalAccountId, meta };
}

async function saveProviderMeta(rowId: string, meta: GmailProviderMeta): Promise<void> {
  await db
    .update(oauthTokens)
    .set({ meta: JSON.stringify(meta) })
    .where(eq(oauthTokens.id, rowId));
}

// --- Customer lookup for matching ---

type CustomerMatchRow = {
  id: string;
  primaryEmail: string | null;
  billingEmails: string[] | null;
};

// Build a lowercased email → customerId index from the customers table. We
// scan all rows because `billing_emails` is a JSON array and equality on
// JSON columns is awkward in MySQL; index in memory instead. The customer
// list is bounded (low thousands) so a per-poll full scan is fine.
async function buildCustomerEmailIndex(): Promise<Map<string, string>> {
  const rows: CustomerMatchRow[] = await db
    .select({
      id: customers.id,
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
    })
    .from(customers);

  const index = new Map<string, string>();
  for (const row of rows) {
    if (row.primaryEmail) {
      index.set(row.primaryEmail.toLowerCase(), row.id);
    }
    if (Array.isArray(row.billingEmails)) {
      for (const e of row.billingEmails) {
        if (typeof e === "string" && e) index.set(e.toLowerCase(), row.id);
      }
    }
  }
  return index;
}

function classifyDirection(email: ParsedEmail): "inbound" | "outbound" {
  return BUSINESS_EMAILS.has(email.fromEmail) ? "outbound" : "inbound";
}

function matchCustomer(email: ParsedEmail, index: Map<string, string>): string | null {
  // Inbound matches on sender, outbound matches on recipient. This mirrors
  // 1.0's behavior where activity ingestion ties the message to whichever
  // party is the customer regardless of direction.
  const candidate =
    classifyDirection(email) === "inbound" ? email.fromEmail : email.toEmail;
  if (!candidate) return null;
  return index.get(candidate.toLowerCase()) ?? null;
}

function formatGmailDateForQuery(d: Date): string {
  // Gmail accepts after:YYYY/MM/DD. Use UTC components so the boundary is
  // deterministic regardless of where the worker runs.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

// --- The main poll ---

export type PollOptions = {
  externalAccountId?: string;
  maxResults?: number;
  // For first-time runs (no cursor stored) we look back this many days.
  initialLookbackDays?: number;
};

export async function pollNewEmails(opts: PollOptions = {}): Promise<PollResult> {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const initialLookbackDays =
    opts.initialLookbackDays ?? DEFAULT_INITIAL_LOOKBACK_DAYS;

  const provider = await loadProviderRow(opts.externalAccountId);
  if (!provider) {
    log.warn(
      { externalAccountId: opts.externalAccountId ?? "(any)" },
      "no usable Gmail provider row; skipping poll",
    );
    return {
      fetched: 0,
      inserted: 0,
      matched: 0,
      activitiesCreated: 0,
      cursorAdvancedTo: null,
    };
  }

  // Cursor: if we have one, query "after:" that date. Otherwise look back N
  // days. Gmail's after: is day-granular, so we re-fetch the last day every
  // time and rely on the email_log UNIQUE index to dedup. Cheap and reliable.
  const cursorIso = provider.meta.lastPollAt;
  const cursorDate = cursorIso ? new Date(cursorIso) : null;
  const fromDate =
    cursorDate && !Number.isNaN(cursorDate.getTime())
      ? new Date(cursorDate.getTime() - 24 * 60 * 60 * 1000) // overlap one day
      : new Date(Date.now() - initialLookbackDays * 24 * 60 * 60 * 1000);

  const query = `after:${formatGmailDateForQuery(fromDate)}`;
  log.info(
    { query, maxResults, externalAccountId: provider.externalAccountId },
    "starting gmail poll",
  );

  const fetched = await searchEmails(query, maxResults, provider.externalAccountId);
  if (fetched.length === 0) {
    return {
      fetched: 0,
      inserted: 0,
      matched: 0,
      activitiesCreated: 0,
      cursorAdvancedTo: cursorIso ?? null,
    };
  }

  // Dedup: which message IDs are already in email_log?
  const ids = fetched.map((e) => e.id).filter((id): id is string => Boolean(id));
  const existing = ids.length
    ? await db
        .select({ gmailMessageId: emailLog.gmailMessageId })
        .from(emailLog)
        .where(inArray(emailLog.gmailMessageId, ids))
    : [];
  const existingSet = new Set(existing.map((r) => r.gmailMessageId));

  const newEmails = fetched.filter((e) => e.id && !existingSet.has(e.id));
  if (newEmails.length === 0) {
    return {
      fetched: fetched.length,
      inserted: 0,
      matched: 0,
      activitiesCreated: 0,
      cursorAdvancedTo: cursorIso ?? null,
    };
  }

  const customerIndex = await buildCustomerEmailIndex();

  let inserted = 0;
  let matched = 0;
  let activitiesCreated = 0;
  let newestSeen = cursorDate ? cursorDate.getTime() : 0;

  for (const email of newEmails) {
    const direction = classifyDirection(email);
    const customerId = matchCustomer(email, customerIndex);
    const occurredAt = email.emailDate ?? new Date();

    const emailLogId = nanoid(24);
    try {
      await db.insert(emailLog).values({
        id: emailLogId,
        gmailMessageId: email.id,
        threadId: email.threadId || null,
        customerId,
        userId: null,
        direction,
        aliasUsed: direction === "outbound" ? email.fromEmail || null : null,
        fromAddress: email.fromEmail || null,
        toAddress: email.toEmail || null,
        subject: email.subject || null,
        body: email.body || null,
        snippet: email.snippet ? email.snippet.slice(0, 510) : null,
        classification: null,
        emailDate: occurredAt,
      });
      inserted++;
    } catch (err) {
      // Most likely a UNIQUE-on-gmail_message_id collision from a concurrent
      // poll. Skip and continue rather than aborting the run — the row is
      // already there, no action needed.
      const msg = (err as { message?: string }).message ?? "";
      if (/duplicate|ER_DUP_ENTRY|unique/i.test(msg)) {
        log.debug({ gmailMessageId: email.id }, "duplicate gmail message; skipped");
        continue;
      }
      log.error(
        { err, gmailMessageId: email.id },
        "failed to insert email_log row",
      );
      continue;
    }

    if (customerId) {
      matched++;
      try {
        // Direction is decided by the matched alias upstream: messages from a
        // BUSINESS_EMAILS sender are outbound; everything else is inbound.
        // recordActivity handles the audit_log write atomically.
        const created = await recordActivity({
          customerId,
          kind: direction === "inbound" ? "email_in" : "email_out",
          source: "gmail_poll",
          occurredAt,
          subject: email.subject || null,
          body: email.body || email.snippet || null,
          bodyHtml: null,
          refType: "email_log",
          refId: emailLogId,
          meta: {
            gmailMessageId: email.id,
            threadId: email.threadId,
            from: email.from,
            to: email.to,
          },
        });
        if (created) activitiesCreated++;
      } catch (err) {
        log.error(
          { err, gmailMessageId: email.id, customerId },
          "failed to write activity row",
        );
      }
    }

    if (occurredAt.getTime() > newestSeen) newestSeen = occurredAt.getTime();
  }

  // Advance cursor to the newest email we processed, only if we actually
  // moved forward. Stored as ISO so it survives a JSON round-trip.
  let cursorAdvancedTo: string | null = cursorIso ?? null;
  if (newestSeen > 0 && (!cursorDate || newestSeen > cursorDate.getTime())) {
    const advancedIso = new Date(newestSeen).toISOString();
    await saveProviderMeta(provider.rowId, {
      ...provider.meta,
      lastPollAt: advancedIso,
    });
    cursorAdvancedTo = advancedIso;
  }

  log.info(
    {
      fetched: fetched.length,
      inserted,
      matched,
      activitiesCreated,
      cursorAdvancedTo,
    },
    "gmail poll complete",
  );

  return {
    fetched: fetched.length,
    inserted,
    matched,
    activitiesCreated,
    cursorAdvancedTo,
  };
}

// ---------------------------------------------------------------------
// Per-customer email backfill. Triggered from the customer-detail Email
// tab when a user wants the historical email feed for a specific
// customer rather than waiting for the worker's incremental polling to
// catch up. Searches Gmail for messages to/from any of the customer's
// known email addresses and writes new rows to email_log + activities.
// Idempotent — duplicates dedupe on email_log.gmailMessageId UNIQUE.

export type CustomerSyncResult = {
  fetched: number;
  inserted: number;
  activitiesCreated: number;
  emails: string[]; // the addresses we searched against
};

export async function syncEmailsForCustomer(
  customerId: string,
  opts: { maxResults?: number; externalAccountId?: string } = {},
): Promise<CustomerSyncResult> {
  const maxResults = opts.maxResults ?? 1000;

  // Collect every known email address for this customer — primary +
  // billing list. Lowercased + deduped.
  const rows = await db
    .select({
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`customer not found: ${customerId}`);
  }
  const addresses = new Set<string>();
  if (row.primaryEmail) addresses.add(row.primaryEmail.toLowerCase());
  if (Array.isArray(row.billingEmails)) {
    for (const e of row.billingEmails) {
      if (typeof e === "string" && e) addresses.add(e.toLowerCase());
    }
  }
  if (addresses.size === 0) {
    return { fetched: 0, inserted: 0, activitiesCreated: 0, emails: [] };
  }

  // Build the Gmail search query: (from:e OR to:e OR from:e2 OR to:e2 ...)
  // Wrap each address in quotes to handle plus-addressing or special chars
  // safely. Cap at ~10 addresses to keep query length sane (Gmail's
  // operator OR-tree caps somewhere around 1000 chars total).
  const cappedAddresses = Array.from(addresses).slice(0, 10);
  const clauses: string[] = [];
  for (const a of cappedAddresses) {
    clauses.push(`from:${a}`);
    clauses.push(`to:${a}`);
  }
  const query = clauses.join(" OR ");

  log.info(
    { customerId, addressCount: cappedAddresses.length, maxResults },
    "starting per-customer email sync",
  );

  const fetched = await searchEmails(query, maxResults, opts.externalAccountId);
  if (fetched.length === 0) {
    return {
      fetched: 0,
      inserted: 0,
      activitiesCreated: 0,
      emails: cappedAddresses,
    };
  }

  // Dedup: which message IDs already exist?
  const ids = fetched
    .map((e) => e.id)
    .filter((id): id is string => Boolean(id));
  const existing =
    ids.length > 0
      ? await db
          .select({ gmailMessageId: emailLog.gmailMessageId })
          .from(emailLog)
          .where(inArray(emailLog.gmailMessageId, ids))
      : [];
  const seen = new Set(existing.map((r) => r.gmailMessageId));
  const newEmails = fetched.filter((e) => e.id && !seen.has(e.id));

  let inserted = 0;
  let activitiesCreated = 0;

  for (const email of newEmails) {
    const direction = classifyDirection(email);
    const occurredAt = email.emailDate ?? new Date();
    const emailLogId = nanoid(24);
    try {
      await db.insert(emailLog).values({
        id: emailLogId,
        gmailMessageId: email.id,
        threadId: email.threadId || null,
        customerId,
        userId: null,
        direction,
        aliasUsed: direction === "outbound" ? email.fromEmail || null : null,
        fromAddress: email.fromEmail || null,
        toAddress: email.toEmail || null,
        subject: email.subject || null,
        body: email.body || null,
        snippet: email.snippet ? email.snippet.slice(0, 510) : null,
        classification: null,
        emailDate: occurredAt,
      });
      inserted++;
    } catch (err) {
      const msg = (err as { message?: string }).message ?? "";
      if (/duplicate|ER_DUP_ENTRY|unique/i.test(msg)) {
        continue;
      }
      log.error(
        { err, gmailMessageId: email.id, customerId },
        "per-customer sync — email_log insert failed",
      );
      continue;
    }

    try {
      const created = await recordActivity({
        customerId,
        kind: direction === "inbound" ? "email_in" : "email_out",
        source: "gmail_poll",
        occurredAt,
        subject: email.subject || null,
        body: email.body || email.snippet || null,
        bodyHtml: null,
        refType: "email_log",
        refId: emailLogId,
        meta: {
          gmailMessageId: email.id,
          threadId: email.threadId,
          from: email.from,
          to: email.to,
        },
      });
      if (created) activitiesCreated++;
    } catch (err) {
      log.error(
        { err, gmailMessageId: email.id, customerId },
        "per-customer sync — activity write failed",
      );
    }
  }

  log.info(
    { customerId, fetched: fetched.length, inserted, activitiesCreated },
    "per-customer email sync complete",
  );

  return {
    fetched: fetched.length,
    inserted,
    activitiesCreated,
    emails: cappedAddresses,
  };
}
