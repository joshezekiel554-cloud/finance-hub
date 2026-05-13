// Vocatech REST API client. Wraps the endpoints we use:
//   GET /v1/calls?start_date=...&end_date=...&page=... (backfill)
//   GET /v1/calls/{call_id} (per-call detail for recording_media_id lookup)
//   GET /v1/media/{media_id} (returns signed Google Cloud Storage URL valid 30 min)
//   GET /v1/messages?start_date=...&end_date=... (SMS backfill)
//   POST /v1/messages (send SMS)
//   POST /v1/contacts (upsert customer roster, batch up to 500)
//   POST /v1/webhooks/{id}/test (settings health check)
//
// API envelope shapes (confirmed against live API 2026-05-11):
//   GET /calls:    { query, calls:   VocatechCall[],    meta: PageMeta }
//   GET /messages: { query, messages: VocatechMessage[], meta: PageMeta }
//   GET /contacts: { query, contacts: VocatechContact[], meta: PageMeta }
//   GET /webhooks: VocatechWebhook[] (returned as a bare array)
// Pagination is page-numbered (1-indexed) via `?page=N`, with total_pages on
// meta. Cursor-based pagination is NOT used.
//
// Direction values from the API are "incoming" | "outgoing" | "internal".
// (NOT "inbound"/"outbound" — those are the values we use in our DB column.
// Map at the edge.)

import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "vocatech.client" });
const BASE = "https://api.vocatech.com/v1";

export class VocatechApiError extends Error {
  status: number;
  retryAfter?: number; // seconds, parsed from Retry-After header if present
  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "VocatechApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = env.VOCATECH_API_KEY;
  if (!apiKey) throw new Error("VOCATECH_API_KEY not configured");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.warn({ status: res.status, path, body }, "vocatech api error");
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
    throw new VocatechApiError(
      `Vocatech ${res.status}: ${body || res.statusText}`,
      res.status,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  return res.json() as Promise<T>;
}

// --- Shared shapes -----------------------------------------------------------

export type VocatechApiDirection = "incoming" | "outgoing" | "internal";

export type VocatechPageMeta = {
  page: number;
  limit: number;
  total_pages: number;
};

// --- Calls -------------------------------------------------------------------

export type VocatechCallJourneySegment = {
  order: number;
  type: string;
  extension_name?: string;
  extension?: string;
  start_time: string;
  end_time: string;
  duration: number;
  summary?: string | null;
  transcription?: string | null;
  recording_url?: string | null;
};

export type VocatechCall = {
  call_id: string;
  direction: VocatechApiDirection;
  status?: string;
  extension?: string;
  extension_name?: string;
  remote_name?: string;
  remote_number: string;
  group_number?: string;
  start_time: string;
  end_time: string;
  duration: number;
  journey: VocatechCallJourneySegment[];
};

export type VocatechCallsList = {
  calls: VocatechCall[];
  meta: VocatechPageMeta & { total_calls: number };
};

export async function listCalls(params: {
  startDate?: string;
  endDate?: string;
  direction?: VocatechApiDirection | "any";
  page?: number;
  timezone?: string;
}): Promise<VocatechCallsList> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set("start_date", params.startDate);
  if (params.endDate) qs.set("end_date", params.endDate);
  if (params.direction) qs.set("direction", params.direction);
  if (params.page) qs.set("page", String(params.page));
  qs.set("timezone", params.timezone ?? "UTC");
  return call<VocatechCallsList>(`/calls?${qs}`);
}

export async function getCall(callId: string): Promise<VocatechCall> {
  return call<VocatechCall>(`/calls/${encodeURIComponent(callId)}`);
}

export async function getMediaUrl(mediaId: string): Promise<{ url: string; expires_at: string }> {
  return call(`/media/${encodeURIComponent(mediaId)}`);
}

// --- Messages ----------------------------------------------------------------

export type VocatechMessageAttachment = {
  id: string;
  content_type: string;
  filename?: string;
  size?: number;
};

export type VocatechMessage = {
  message_id: string;
  direction: VocatechApiDirection;
  status: "sent" | "delivered" | "read" | "failed";
  remote_name?: string;
  remote_number: string;
  group_number?: string;
  sent_time: string;
  channel: "text" | "whatsapp";
  type?: string;
  body: string;
  attachments?: VocatechMessageAttachment[];
};

export type VocatechMessagesList = {
  messages: VocatechMessage[];
  meta: VocatechPageMeta & { total_messages: number };
};

export async function listMessages(params: {
  startDate?: string;
  endDate?: string;
  direction?: VocatechApiDirection | "any";
  page?: number;
}): Promise<VocatechMessagesList> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set("start_date", params.startDate);
  if (params.endDate) qs.set("end_date", params.endDate);
  if (params.direction) qs.set("direction", params.direction);
  if (params.page) qs.set("page", String(params.page));
  return call<VocatechMessagesList>(`/messages?${qs}`);
}

// POST /messages request shape per the live OpenAPI spec:
//   { platform: "text", from, to, message, name?, members?, test? }
// `from` must be a phone number registered to the authenticated company
// (configure via VOCATECH_FROM_NUMBER env). `message` (not `body`) is the
// text content, max 1600 chars. `name` is a display label for the contact —
// we pass the customer's displayName so the Vocatech UI shows a useful label.
// Response on success is 201 with `{ status: "created", message: { mode,
// platform, from, to, name, room_uuid?, email_recipient?, message_sent,
// email_sent?, created_at } }`. Note: no `message_id` is returned here —
// the resulting message arrives in our system via the message.sent webhook
// or message.status_updated webhook, where we'll learn its id.
export type VocatechSendMessageInput = {
  platform: "text";
  from: string;
  to: string;
  message: string;
  name?: string;
  members?: string[];
  test?: boolean;
};

export type VocatechSendMessageResponse = {
  status: "created" | "test" | string;
  message: {
    mode: "webex" | "email";
    platform: string;
    from: string;
    to: string;
    name?: string;
    room_uuid?: string;
    email_recipient?: string;
    message_sent?: boolean;
    email_sent?: boolean;
    created_at?: string;
    existing_space?: boolean;
  };
};

export async function sendMessage(
  input: VocatechSendMessageInput,
): Promise<VocatechSendMessageResponse> {
  return call<VocatechSendMessageResponse>("/messages", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// --- Contacts (roster push) --------------------------------------------------

export type VocatechContactField = {
  id: number;
  name: string;
  order: number;
  is_phone: boolean;
  is_match: boolean;
  reports_enabled: boolean;
  hide_no_data: boolean;
  show_in_fields: boolean;
  is_integration: boolean;
};

export async function getContactFields(): Promise<{ fields: VocatechContactField[] }> {
  return call<{ fields: VocatechContactField[] }>("/contacts/fields");
}

// Each contact is a bag of field name → value strings. Field names are
// whatever the tenant configured in Vocatech's admin UI — discover them
// via getContactFields() before building payloads.
export type VocatechContactUpsert = { fields: Record<string, string> };

export type VocatechContactUpsertResponse = {
  summary: { total: number; created: number; updated: number; errors: number };
  contacts: Array<{ contact: { id: number; fields: Record<string, string> }; action: "created" | "updated" }>;
  errors: Array<{ index: number; message: string }>;
};

export async function upsertContacts(
  contacts: VocatechContactUpsert[],
): Promise<VocatechContactUpsertResponse> {
  if (contacts.length > 500) {
    throw new Error("upsertContacts batch exceeds 500 — chunk caller-side");
  }
  return call<VocatechContactUpsertResponse>("/contacts", {
    method: "POST",
    body: JSON.stringify({ contacts }),
  });
}

// --- Webhook health ----------------------------------------------------------

export type VocatechWebhook = {
  id: string;
  name: string;
  url: string;
  event_filters: string[];
};

export async function listWebhooks(): Promise<VocatechWebhook[]> {
  // API returns a bare array (no envelope).
  return call<VocatechWebhook[]>("/webhooks");
}

export async function testWebhook(webhookId: string): Promise<{ ok: true }> {
  return call(`/webhooks/${encodeURIComponent(webhookId)}/test`, { method: "POST" });
}

// --- Helpers -----------------------------------------------------------------

// Map Vocatech's API direction values to our DB enum. The REST API uses
// "incoming" | "outgoing" | "internal"; webhook payloads MAY use the same
// or may use "inbound" | "outbound" — we accept both spellings defensively
// until a real webhook is observed. Our `phone_communications.direction`
// column is enum('inbound','outbound'). Internal calls collapse to
// "inbound" (single-customer view); practically we rarely ingest them.
export function mapDirection(
  d: VocatechApiDirection | string | undefined,
): "inbound" | "outbound" {
  return d === "outgoing" || d === "outbound" ? "outbound" : "inbound";
}
