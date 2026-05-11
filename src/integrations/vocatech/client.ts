// Vocatech REST API client. Wraps the endpoints we use:
//   GET /v1/calls?start_date=...&end_date=...&page=... (backfill)
//   GET /v1/calls/{call_id} (per-call detail for recording_media_id lookup)
//   GET /v1/media/{media_id} (returns signed Google Cloud Storage URL valid 30 min)
//   GET /v1/messages?start_date=...&end_date=... (SMS backfill)
//   POST /v1/messages (send SMS)
//   POST /v1/contacts (upsert customer roster, batch up to 500)
//   POST /v1/webhooks/{id}/test (settings health check)

import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "vocatech.client" });
const BASE = "https://api.vocatech.com/v1";

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
    throw new Error(`Vocatech ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// --- Read endpoints ----------------------------------------------------------

export type VocatechCallJourneySegment = {
  order: number;
  type: string;
  name?: string;
  start_time: string;
  end_time: string;
  duration: number;
  transcription?: string;
  recording_url?: string | null;
};

export type VocatechCall = {
  call_id: string;
  direction: "inbound" | "outbound" | "internal";
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
  data: VocatechCall[];
  next?: string;
};

export async function listCalls(params: {
  startDate?: string;
  endDate?: string;
  direction?: "inbound" | "outbound" | "any";
  page?: string;
  timezone?: string;
}): Promise<VocatechCallsList> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set("start_date", params.startDate);
  if (params.endDate) qs.set("end_date", params.endDate);
  if (params.direction) qs.set("direction", params.direction);
  if (params.page) qs.set("page", params.page);
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

export type VocatechMessage = {
  message_id: string;
  from: string;
  to: string;
  channel: "text" | "whatsapp";
  direction: "inbound" | "outbound";
  body: string;
  status: "sent" | "delivered" | "read" | "failed";
  attachments?: Array<{ media_id: string; content_type: string }>;
  created_at: string;
};

export type VocatechMessagesList = { data: VocatechMessage[]; next?: string };

export async function listMessages(params: {
  startDate?: string;
  endDate?: string;
  direction?: "inbound" | "outbound" | "any";
  page?: string;
}): Promise<VocatechMessagesList> {
  const qs = new URLSearchParams();
  if (params.startDate) qs.set("start_date", params.startDate);
  if (params.endDate) qs.set("end_date", params.endDate);
  if (params.direction) qs.set("direction", params.direction);
  if (params.page) qs.set("page", params.page);
  return call<VocatechMessagesList>(`/messages?${qs}`);
}

export async function sendMessage(input: {
  to: string;
  body: string;
  channel?: "text" | "whatsapp";
}): Promise<VocatechMessage> {
  return call<VocatechMessage>("/messages", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// --- Contacts (roster push) --------------------------------------------------

export type VocatechContactUpsert = {
  external_id: string;
  name: string;
  phone_numbers: string[];
};

export async function upsertContacts(
  contacts: VocatechContactUpsert[],
): Promise<{ inserted: number; updated: number }> {
  // API accepts batches up to 500.
  if (contacts.length > 500) {
    throw new Error("upsertContacts batch exceeds 500 — chunk caller-side");
  }
  return call("/contacts", {
    method: "POST",
    body: JSON.stringify({ contacts }),
  });
}

// --- Webhook health ----------------------------------------------------------

export async function listWebhooks(): Promise<{ data: Array<{ id: string; name: string; url: string; event_filters: string[] }> }> {
  return call("/webhooks");
}

export async function testWebhook(webhookId: string): Promise<{ ok: true }> {
  return call(`/webhooks/${encodeURIComponent(webhookId)}/test`, { method: "POST" });
}
