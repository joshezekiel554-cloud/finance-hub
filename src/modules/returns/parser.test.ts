// Tests for the AI return-email parser.
//
// The Anthropic client is mocked via vi.hoisted so no real API calls are made.
// Each test controls exactly what the mock client returns.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockCreate, setNextResponse } = vi.hoisted(() => {
  let nextResponse: unknown = null;
  const setNextResponse = (r: unknown) => {
    nextResponse = r;
  };

  const mockCreate = vi.fn(async () => {
    const r = nextResponse;
    nextResponse = null;
    return r;
  });

  return { mockCreate, setNextResponse };
});

// Mock the Anthropic integration modules
vi.mock("../../integrations/anthropic/index.js", () => ({
  getAnthropicClient: () => ({
    messages: { create: mockCreate },
  }),
  isConfigured: () => true,
  trackUsage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
import { parseReturnRequestEmail } from "./parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnthropicResponse(jsonContent: string) {
  return {
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: jsonContent }],
    usage: { input_tokens: 120, output_tokens: 80 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseReturnRequestEmail", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  // -------------------------------------------------------------------------
  // Test 1: Well-formed email with explicit SKUs, quantities, reasons
  // -------------------------------------------------------------------------
  it("extracts items from a well-formed customer email with SKUs", async () => {
    const responseJson = JSON.stringify({
      proposedItems: [
        { sku: "MUG-GOLD-01", name: "Gold Passover Mug", quantity: 3, reason: "Damaged in transit" },
        { sku: "PLATE-SILVER", name: "Silver Seder Plate", quantity: 1, reason: "Wrong item received" },
      ],
      customerInferred: {
        name: "Rivka Goldstein",
        email: "rivka@example.com",
      },
      confidence: 0.95,
    });

    setNextResponse(makeAnthropicResponse(responseJson));

    const result = await parseReturnRequestEmail({
      emailBody: "Hi, I need to return 3x MUG-GOLD-01 (damaged) and 1x PLATE-SILVER (wrong item). — Rivka Goldstein <rivka@example.com>",
    });

    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.proposedItems).toHaveLength(2);

    const mug = result.proposedItems[0]!;
    expect(mug.sku).toBe("MUG-GOLD-01");
    expect(mug.name).toBe("Gold Passover Mug");
    expect(mug.quantity).toBe(3);
    expect(mug.reason).toBe("Damaged in transit");

    const plate = result.proposedItems[1]!;
    expect(plate.sku).toBe("PLATE-SILVER");
    expect(plate.quantity).toBe(1);

    expect(result.customerInferred?.name).toBe("Rivka Goldstein");
    expect(result.customerInferred?.email).toBe("rivka@example.com");
  });

  // -------------------------------------------------------------------------
  // Test 2: Garbage / non-return email → confidence=0, empty items
  // -------------------------------------------------------------------------
  it("returns confidence=0 and empty items when model returns no extractable content", async () => {
    const responseJson = JSON.stringify({
      proposedItems: [],
      confidence: 0,
    });

    setNextResponse(makeAnthropicResponse(responseJson));

    const result = await parseReturnRequestEmail({
      emailBody: "Newsletter: Spring sale starts Friday!",
    });

    expect(result.confidence).toBe(0);
    expect(result.proposedItems).toHaveLength(0);
    expect(result.customerInferred).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 3: Email without explicit SKUs → items have names but no sku field
  // -------------------------------------------------------------------------
  it("extracts items by name when no SKUs are mentioned", async () => {
    const responseJson = JSON.stringify({
      proposedItems: [
        { name: "Haggadah Book Set", quantity: 2, reason: "Pages missing" },
        { name: "Eliyahu Cup", quantity: 1 },
      ],
      customerInferred: { name: "Moshe Cohen" },
      confidence: 0.75,
    });

    setNextResponse(makeAnthropicResponse(responseJson));

    const result = await parseReturnRequestEmail({
      emailBody: "We received 2 Haggadah Book Sets with missing pages and 1 Eliyahu Cup that broke. Please advise. — Moshe Cohen",
    });

    expect(result.confidence).toBe(0.75);
    expect(result.proposedItems).toHaveLength(2);

    const haggadah = result.proposedItems[0]!;
    expect(haggadah.sku).toBeUndefined();   // no SKU in this email
    expect(haggadah.name).toBe("Haggadah Book Set");
    expect(haggadah.quantity).toBe(2);
    expect(haggadah.reason).toBe("Pages missing");

    const cup = result.proposedItems[1]!;
    expect(cup.sku).toBeUndefined();
    expect(cup.reason).toBeUndefined();

    expect(result.customerInferred?.name).toBe("Moshe Cohen");
    expect(result.customerInferred?.email).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 4: Model returns invalid JSON → graceful fallback to empty result
  // -------------------------------------------------------------------------
  it("returns empty result with confidence=0 when model returns invalid JSON", async () => {
    setNextResponse(makeAnthropicResponse("Sorry, I cannot process this request."));

    const result = await parseReturnRequestEmail({
      emailBody: "please return everything",
    });

    expect(result.confidence).toBe(0);
    expect(result.proposedItems).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 5: Model wraps JSON in markdown code fences → still parsed correctly
  // -------------------------------------------------------------------------
  it("strips markdown code fences before JSON parsing", async () => {
    const innerJson = JSON.stringify({
      proposedItems: [{ sku: "AFIKOMEN-01", name: "Afikomen Bag", quantity: 4 }],
      confidence: 0.88,
    });
    const fencedResponse = "```json\n" + innerJson + "\n```";

    setNextResponse(makeAnthropicResponse(fencedResponse));

    const result = await parseReturnRequestEmail({
      emailBody: "I need to return 4 Afikomen bags (SKU AFIKOMEN-01).",
    });

    expect(result.proposedItems).toHaveLength(1);
    expect(result.proposedItems[0]!.sku).toBe("AFIKOMEN-01");
    expect(result.confidence).toBe(0.88);
  });

  // -------------------------------------------------------------------------
  // Test 6: Attachment text is included in the user message
  // -------------------------------------------------------------------------
  it("includes attachment text in the prompt when provided", async () => {
    const responseJson = JSON.stringify({
      proposedItems: [{ sku: "MENORAH-7", name: "7-Branch Menorah", quantity: 1 }],
      confidence: 0.9,
    });

    setNextResponse(makeAnthropicResponse(responseJson));

    await parseReturnRequestEmail({
      emailBody: "Please see attached invoice for return details.",
      attachmentText: "Item: MENORAH-7, Qty: 1, Reason: Defective",
    });

    const callArgs = (mockCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const messages = callArgs.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("Attachment text:");
    expect(messages[0]?.content).toContain("MENORAH-7");
  });

  // -------------------------------------------------------------------------
  // Test 7: Normaliser coerces non-integer quantity to integer (rounds)
  // -------------------------------------------------------------------------
  it("normalises fractional quantity to integer", async () => {
    const responseJson = JSON.stringify({
      proposedItems: [{ name: "Candle Set", quantity: 2.7 }],
      confidence: 0.6,
    });

    setNextResponse(makeAnthropicResponse(responseJson));

    const result = await parseReturnRequestEmail({
      emailBody: "Return about 2-3 candle sets.",
    });

    expect(result.proposedItems[0]!.quantity).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test 8: API throws → returns empty result, does not propagate
  // -------------------------------------------------------------------------
  it("returns empty result without throwing when the API call fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Network error"));

    const result = await parseReturnRequestEmail({
      emailBody: "Hi, I want to return my order.",
    });

    expect(result.confidence).toBe(0);
    expect(result.proposedItems).toHaveLength(0);
  });
});
