// AI-powered parser: extracts return-request items from a customer email using
// Claude Haiku (cheap, fast, structured extraction).
//
// Mirror pattern from src/integrations/anthropic/summary.ts:
//   - getAnthropicClient() singleton
//   - isConfigured() guard
//   - trackUsage() fire-and-forget cost tracking
//   - AnthropicResponseWithUsage cast
//   - Graceful JSON parse failure → empty result with confidence=0

import {
  getAnthropicClient,
  isConfigured,
  trackUsage,
} from "../../integrations/anthropic/index.js";
import type { AnthropicResponseWithUsage } from "../../integrations/anthropic/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ParsedReturnItem = {
  sku?: string;         // operator confirms after — may be empty
  name?: string;        // best-guess product name from email
  quantity: number;
  reason?: string;
};

export type ParsedReturnRequest = {
  proposedItems: ParsedReturnItem[];
  customerInferred?: { name?: string; email?: string };
  confidence: number;  // 0..1
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a returns-processing assistant. Your job is to extract product return information from customer emails.

Given a customer email body (and optionally extracted text from PDF/image attachments), identify each product the customer wants to return.

Output ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "proposedItems": [
    {
      "sku": "<SKU if explicitly mentioned, else omit>",
      "name": "<best-guess product name or description>",
      "quantity": <positive integer>,
      "reason": "<return reason if stated, else omit>"
    }
  ],
  "customerInferred": {
    "name": "<customer name if identifiable from the email, else omit>",
    "email": "<reply-to or from email address if present, else omit>"
  },
  "confidence": <float 0.0 to 1.0 indicating how confident you are in the extraction>
}

Rules:
- If no items can be extracted, return proposedItems as an empty array with confidence 0.
- Omit optional fields (sku, name, reason, customerInferred.name, customerInferred.email) rather than setting them to null or empty string.
- quantity must always be a positive integer; default to 1 if unclear.
- confidence should reflect: 1.0 = explicit quantities + item names/SKUs clearly stated; 0.5 = some ambiguity; 0.0 = no extractable items.`;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export type ParseReturnRequestEmailInput = {
  emailBody: string;
  attachmentText?: string;  // pre-extracted text from PDF/image attachments
};

export async function parseReturnRequestEmail(
  input: ParseReturnRequestEmailInput,
): Promise<ParsedReturnRequest> {
  const empty: ParsedReturnRequest = { proposedItems: [], confidence: 0 };

  if (!isConfigured()) {
    return empty;
  }

  const client = getAnthropicClient();

  // Build user message — include attachment text if provided
  const userParts: string[] = [`Email body:\n${input.emailBody}`];
  if (input.attachmentText?.trim()) {
    userParts.push(`\nAttachment text:\n${input.attachmentText}`);
  }
  const userMessage = userParts.join("\n\n");

  try {
    const response = (await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    } as Parameters<typeof client.messages.create>[0])) as unknown as AnthropicResponseWithUsage;

    // Fire-and-forget cost tracking — don't block the caller
    void trackUsage(response, { surface: "return_email_parse" });

    const rawText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();

    let parsed: unknown;
    try {
      // Strip markdown code fences if the model wrapped the JSON
      const stripped = rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      parsed = JSON.parse(stripped);
    } catch {
      return empty;
    }

    return normalise(parsed);
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Internal normaliser — coerces the parsed JSON into our strict type
// ---------------------------------------------------------------------------

function normalise(raw: unknown): ParsedReturnRequest {
  if (!raw || typeof raw !== "object") return { proposedItems: [], confidence: 0 };

  const obj = raw as Record<string, unknown>;

  const rawItems = Array.isArray(obj.proposedItems) ? obj.proposedItems : [];
  const proposedItems: ParsedReturnItem[] = rawItems
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => {
      const qty = typeof item.quantity === "number" ? Math.max(1, Math.round(item.quantity)) : 1;
      const out: ParsedReturnItem = { quantity: qty };
      if (typeof item.sku === "string" && item.sku.trim()) out.sku = item.sku.trim();
      if (typeof item.name === "string" && item.name.trim()) out.name = item.name.trim();
      if (typeof item.reason === "string" && item.reason.trim()) out.reason = item.reason.trim();
      return out;
    });

  const confidence = typeof obj.confidence === "number"
    ? Math.min(1, Math.max(0, obj.confidence))
    : (proposedItems.length > 0 ? 0.5 : 0);

  const result: ParsedReturnRequest = { proposedItems, confidence };

  if (obj.customerInferred && typeof obj.customerInferred === "object") {
    const ci = obj.customerInferred as Record<string, unknown>;
    const customerInferred: ParsedReturnRequest["customerInferred"] = {};
    if (typeof ci.name === "string" && ci.name.trim()) customerInferred.name = ci.name.trim();
    if (typeof ci.email === "string" && ci.email.trim()) customerInferred.email = ci.email.trim();
    if (Object.keys(customerInferred).length > 0) result.customerInferred = customerInferred;
  }

  return result;
}
