import { google, gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/index.js";
import { oauthTokens } from "~/db/schema/oauth.js";
import { decrypt, encrypt } from "~/lib/crypto.js";
import { env } from "~/lib/env.js";
import { createLogger } from "~/lib/logger.js";
import type { GmailTokenSet, ParsedEmail } from "./types.js";

const log = createLogger({ module: "gmail.client" });

// Scopes required by the integration:
//   - readonly: poll inbound + sent for activity ingestion
//   - send: outbound from compose surfaces, chase, statement reminders
//
// settings.basic (used by aliases.ts) is checked separately at the call site —
// it's only needed for the alias-picker UI in week 7, and gating all polling
// behind it would block the migrated 1.0 token (which lacks that scope).
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

const SCOPE_SETTINGS_BASIC =
  "https://www.googleapis.com/auth/gmail.settings.basic";

// 1.0 used 5/500ms — keep batching identical so behavior under quota stays the
// same after the lift. Tuneable later if Google changes per-user limits.
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

const TOKEN_REFRESH_LEAD_MS = 60_000;

type CachedClient = {
  externalAccountId: string;
  oauth: OAuth2Client;
  gmail: gmail_v1.Gmail;
};

let cached: CachedClient | null = null;

function buildOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.PUBLIC_URL.replace(/\/$/, "")}/oauth/callback/gmail`,
  );
}

async function loadStoredToken(externalAccountId?: string): Promise<{
  rowId: string;
  externalAccountId: string;
  tokens: GmailTokenSet;
} | null> {
  const rows = externalAccountId
    ? await db
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.provider, "gmail"),
            eq(oauthTokens.externalAccountId, externalAccountId),
          ),
        )
        .limit(1)
    : await db
        .select()
        .from(oauthTokens)
        .where(eq(oauthTokens.provider, "gmail"))
        .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt) return null;
  if (row.externalAccountId.startsWith("pending:")) return null;

  return {
    rowId: row.id,
    externalAccountId: row.externalAccountId,
    tokens: {
      accessToken: decrypt(row.accessTokenEnc),
      refreshToken: row.refreshTokenEnc ? decrypt(row.refreshTokenEnc) : null,
      expiresAt: row.expiresAt,
      scope: row.scope,
      externalAccountId: row.externalAccountId,
    },
  };
}

async function persistToken(
  rowId: string,
  externalAccountId: string,
  tokens: GmailTokenSet,
): Promise<void> {
  await db
    .update(oauthTokens)
    .set({
      externalAccountId,
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    })
    .where(eq(oauthTokens.id, rowId));
}

function tokenHasAllScopes(scope: string | null): boolean {
  if (!scope) return false;
  const granted = scope.split(/\s+/).filter(Boolean);
  return SCOPES.every((required) => granted.includes(required));
}

async function getClient(externalAccountId?: string): Promise<CachedClient> {
  if (
    cached &&
    (externalAccountId === undefined || cached.externalAccountId === externalAccountId)
  ) {
    return cached;
  }

  const stored = await loadStoredToken(externalAccountId);
  if (!stored) {
    throw new Error(
      "Gmail not authenticated. Run /oauth/start/gmail to connect a mailbox.",
    );
  }
  if (!stored.tokens.refreshToken) {
    throw new Error(
      "Gmail token has no refresh_token; re-auth required to obtain offline access.",
    );
  }
  if (!tokenHasAllScopes(stored.tokens.scope)) {
    throw new Error(
      `Gmail token missing required scopes (need: ${SCOPES.join(" ")}). Re-auth required.`,
    );
  }

  const oauth = buildOAuth2Client();
  oauth.setCredentials({
    access_token: stored.tokens.accessToken,
    refresh_token: stored.tokens.refreshToken,
    expiry_date: stored.tokens.expiresAt ? stored.tokens.expiresAt.getTime() : undefined,
    scope: stored.tokens.scope ?? undefined,
  });

  oauth.on("tokens", (next) => {
    // googleapis emits this on automatic refresh. Persist whatever changed —
    // refresh_token may be omitted, in which case we keep the saved one.
    void (async () => {
      try {
        const merged: GmailTokenSet = {
          accessToken: next.access_token ?? stored.tokens.accessToken,
          refreshToken: next.refresh_token ?? stored.tokens.refreshToken,
          expiresAt: next.expiry_date ? new Date(next.expiry_date) : stored.tokens.expiresAt,
          scope: next.scope ?? stored.tokens.scope,
          externalAccountId: stored.externalAccountId,
        };
        await persistToken(stored.rowId, stored.externalAccountId, merged);
        log.debug({ externalAccountId: stored.externalAccountId }, "gmail tokens refreshed");
      } catch (err) {
        log.error({ err }, "failed to persist refreshed Gmail tokens");
      }
    })();
  });

  // Eagerly refresh if the access token is within the lead window. Reading
  // getAccessToken() forces googleapis to refresh and emit "tokens" above.
  if (
    stored.tokens.expiresAt &&
    stored.tokens.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_LEAD_MS
  ) {
    await oauth.getAccessToken();
  }

  cached = {
    externalAccountId: stored.externalAccountId,
    oauth,
    gmail: google.gmail({ version: "v1", auth: oauth }),
  };
  return cached;
}

export function clearClientCache(): void {
  cached = null;
}

export async function isAuthenticated(externalAccountId?: string): Promise<boolean> {
  const stored = await loadStoredToken(externalAccountId);
  if (!stored) return false;
  if (!stored.tokens.refreshToken) return false;
  return tokenHasAllScopes(stored.tokens.scope);
}

// --- Helpers (parsing) ---

function decodeBody(body: gmail_v1.Schema$MessagePartBody | undefined): string {
  if (!body || !body.data) return "";
  return Buffer.from(body.data, "base64url").toString("utf8");
}

function extractTextFromParts(parts: gmail_v1.Schema$MessagePart[] | undefined): string {
  if (!parts) return "";
  let text = "";
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body) {
      text += decodeBody(part.body);
    } else if (part.parts) {
      text += extractTextFromParts(part.parts);
    }
  }
  return text;
}

// Walks the Gmail message tree picking up text/html parts. Used by the B2B
// invoicing route to feed parseShipmentHtml without going through raw .eml.
function extractHtmlFromParts(parts: gmail_v1.Schema$MessagePart[] | undefined): string {
  if (!parts) return "";
  let html = "";
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body) {
      html += decodeBody(part.body);
    } else if (part.parts) {
      html += extractHtmlFromParts(part.parts);
    }
  }
  return html;
}

// Extracts the HTML body from a Gmail message. Handles both single-part
// (payload.body.data direct) and multipart (payload.parts) layouts. Returns
// empty string if no HTML part exists — caller can fall back to the parsed
// text body if needed.
export async function getMessageHtmlBody(
  messageId: string,
  externalAccountId?: string,
): Promise<string> {
  const { gmail } = await getClient(externalAccountId);
  const res = await withRetry(
    () => gmail.users.messages.get({ userId: "me", id: messageId, format: "full" }),
    `messages.get(${messageId})`,
  );
  const msg = res.data;
  if (!msg.payload) return "";
  if (msg.payload.mimeType === "text/html" && msg.payload.body?.data) {
    return decodeBody(msg.payload.body);
  }
  return extractHtmlFromParts(msg.payload.parts);
}

function extractHeaders(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  names: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (h.name && names.includes(h.name) && h.value) result[h.name] = h.value;
  }
  return result;
}

function parseEmailAddress(headerValue: string | undefined): string {
  if (!headerValue) return "";
  const match = headerValue.match(/<([^>]+)>/);
  return match && match[1] ? match[1].toLowerCase() : headerValue.trim().toLowerCase();
}

export function formatMessage(msg: gmail_v1.Schema$Message): ParsedEmail {
  if (!msg || !msg.payload) {
    return {
      id: msg?.id ?? "",
      threadId: msg?.threadId ?? "",
      from: "",
      to: "",
      fromEmail: "",
      toEmail: "",
      subject: "",
      date: "",
      emailDate: null,
      body: "",
      snippet: msg?.snippet ?? "",
      labelIds: [],
    };
  }

  const headers = extractHeaders(msg.payload.headers ?? [], [
    "From",
    "To",
    "Subject",
    "Date",
  ]);
  let body = "";
  if (msg.payload.body && msg.payload.body.data) {
    body = decodeBody(msg.payload.body);
  } else if (msg.payload.parts) {
    body = extractTextFromParts(msg.payload.parts);
  }

  // Prefer the integer internalDate (ms) which Gmail provides reliably; fall
  // back to parsing the Date header. ISO8601 string passes round-trip through
  // MySQL TIMESTAMP without timezone surprises.
  let emailDate: Date | null = null;
  if (msg.internalDate) {
    const ms = Number(msg.internalDate);
    if (Number.isFinite(ms)) emailDate = new Date(ms);
  }
  if (!emailDate && headers["Date"]) {
    const parsed = new Date(headers["Date"]);
    if (!Number.isNaN(parsed.getTime())) emailDate = parsed;
  }

  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    from: headers["From"] ?? "",
    to: headers["To"] ?? "",
    fromEmail: parseEmailAddress(headers["From"]),
    toEmail: parseEmailAddress(headers["To"]),
    subject: headers["Subject"] ?? "",
    date: headers["Date"] ?? "",
    emailDate,
    body,
    snippet: msg.snippet ?? "",
    labelIds: msg.labelIds ?? [],
  };
}

// --- Rate limit helpers ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ApiError = {
  response?: { status?: number };
  code?: number | string;
  message?: string;
};

// Ported verbatim from 1.0's gmail-client.js. Exponential backoff on 429 /
// RESOURCE_EXHAUSTED. Reused by send.ts and any future Gmail-touching code.
export async function withRetry<T>(fn: () => Promise<T>, label = "Gmail API"): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as ApiError;
      const status = e?.response?.status ?? e?.code;
      const isRateLimit =
        status === 429 ||
        status === "RESOURCE_EXHAUSTED" ||
        (typeof e?.message === "string" && e.message.includes("rate limit"));
      if (isRateLimit && attempt < MAX_RETRIES - 1) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        log.warn(
          { label, attempt: attempt + 1, max: MAX_RETRIES, backoffMs: backoff },
          "gmail rate limited; retrying",
        );
        await delay(backoff);
      } else {
        throw err;
      }
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error(`${label}: exhausted retries without resolution`);
}

// --- API operations ---

export async function searchEmails(
  query: string,
  maxResults = 100,
  externalAccountId?: string,
): Promise<ParsedEmail[]> {
  const { gmail } = await getClient(externalAccountId);
  const allMessages: gmail_v1.Schema$Message[] = [];
  let pageToken: string | undefined;

  do {
    const params: gmail_v1.Params$Resource$Users$Messages$List = {
      userId: "me",
      q: query,
      maxResults: Math.min(maxResults - allMessages.length, 100),
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await withRetry(() => gmail.users.messages.list(params), "messages.list");
    const messages = res.data.messages ?? [];
    allMessages.push(...messages);
    pageToken = res.data.nextPageToken ?? undefined;
    if (pageToken) await delay(BATCH_DELAY_MS);
  } while (pageToken && allMessages.length < maxResults);

  const detailed: ParsedEmail[] = [];
  const toFetch = allMessages.slice(0, maxResults);
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((m) =>
        withRetry(
          () => gmail.users.messages.get({ userId: "me", id: m.id ?? "", format: "full" }),
          `messages.get(${m.id})`,
        ),
      ),
    );
    for (const r of results) detailed.push(formatMessage(r.data));
    if (i + BATCH_SIZE < toFetch.length) await delay(BATCH_DELAY_MS);
  }

  return detailed.sort((a, b) => {
    const dateA = a.emailDate?.getTime() ?? new Date(a.date).getTime() ?? 0;
    const dateB = b.emailDate?.getTime() ?? new Date(b.date).getTime() ?? 0;
    return dateB - dateA;
  });
}

export async function getMessage(
  messageId: string,
  externalAccountId?: string,
): Promise<ParsedEmail> {
  const { gmail } = await getClient(externalAccountId);
  const res = await withRetry(
    () => gmail.users.messages.get({ userId: "me", id: messageId, format: "full" }),
    `messages.get(${messageId})`,
  );
  return formatMessage(res.data);
}

export async function getThread(
  threadId: string,
  externalAccountId?: string,
): Promise<ParsedEmail[]> {
  const { gmail } = await getClient(externalAccountId);
  const res = await withRetry(
    () => gmail.users.threads.get({ userId: "me", id: threadId, format: "full" }),
    `threads.get(${threadId})`,
  );
  return (res.data.messages ?? []).map(formatMessage);
}

export async function getProfileEmail(externalAccountId?: string): Promise<string> {
  const { gmail } = await getClient(externalAccountId);
  const res = await withRetry(
    () => gmail.users.getProfile({ userId: "me" }),
    "users.getProfile",
  );
  return res.data.emailAddress ?? "";
}

// Internal accessor for sibling files in the integration. Not exported from
// the package boundary; callers should use the high-level helpers.
export async function getInternalGmailClient(
  externalAccountId?: string,
): Promise<gmail_v1.Gmail> {
  return (await getClient(externalAccountId)).gmail;
}
