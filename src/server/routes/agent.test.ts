// Agent route body-schema tests (schema-export pattern — the repo has no
// Fastify harness; statements.test.ts established this approach).

import { describe, expect, it } from "vitest";
import {
  createConversationBodySchema,
  messageBodySchema,
} from "./agent.js";

describe("messageBodySchema", () => {
  it("accepts a plain message", () => {
    const r = messageBodySchema.safeParse({ text: "who owes us the most?" });
    expect(r.success).toBe(true);
  });

  it("accepts page context with customer subject", () => {
    const r = messageBodySchema.safeParse({
      text: "summarise this customer",
      pageContext: {
        page: "/customers/abc",
        customerId: "abc",
        customerName: "Brown & Co",
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty and oversized text", () => {
    expect(messageBodySchema.safeParse({ text: "" }).success).toBe(false);
    expect(
      messageBodySchema.safeParse({ text: "x".repeat(20_001) }).success,
    ).toBe(false);
  });

  it("rejects malformed page context", () => {
    const r = messageBodySchema.safeParse({
      text: "hi",
      pageContext: { page: "x".repeat(300) },
    });
    expect(r.success).toBe(false);
  });
});

describe("createConversationBodySchema", () => {
  it("accepts empty body and optional title", () => {
    expect(createConversationBodySchema.safeParse({}).success).toBe(true);
    expect(
      createConversationBodySchema.safeParse({ title: "Chase sweep" }).success,
    ).toBe(true);
  });
  it("rejects blank titles", () => {
    expect(createConversationBodySchema.safeParse({ title: "" }).success).toBe(
      false,
    );
  });
});
