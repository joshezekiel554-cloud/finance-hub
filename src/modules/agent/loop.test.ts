// Agent loop control-flow tests: tool round trips, iteration cap,
// write-tool guard, in-flight lock, error path, background notification.
// Conversations/context/cost-tracker are mocked at the module boundary;
// the tool registry is the real one with fake tools registered per test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appended: Array<{ role: string; content: Record<string, unknown> }> = [];

vi.mock("./conversations.js", () => ({
  appendMessage: vi.fn(async (_id: string, role: string, content: Record<string, unknown>) => {
    appended.push({ role, content });
    return `msg-${appended.length}`;
  }),
  getConversation: vi.fn(async () => ({
    id: "conv1",
    userId: "user1",
    title: "t",
    summary: null,
  })),
  listMessagesForContext: vi.fn(async () => [
    { role: "user", content: { text: "hello agent" }, createdAt: new Date() },
  ]),
  maybeCompact: vi.fn(async () => false),
  parseSummary: (raw: string | null) => (raw ? JSON.parse(raw) : null),
  setTitle: vi.fn(async () => undefined),
}));

vi.mock("./context.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./context.js")>();
  return {
    ...real,
    buildAgentSystemPrompt: vi.fn(async () => "SYSTEM-SENTINEL"),
  };
});

vi.mock("../../integrations/anthropic/cost-tracker.js", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../integrations/anthropic/cost-tracker.js")
  >();
  return { ...real, trackUsage: vi.fn(async () => null) };
});

import {
  __resetRegistry,
  registerTool,
} from "../../integrations/anthropic/tool-registry.js";
import { trackUsage } from "../../integrations/anthropic/cost-tracker.js";
import { setTitle } from "./conversations.js";
import {
  MAX_TOOL_ITERATIONS,
  projectHistory,
  runAgentTurn,
  type AgentTurnDeps,
  type AgentTurnEvent,
} from "./loop.js";

type FakeResponse = {
  model: string;
  content: Array<Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number };
};

function textResponse(text: string): FakeResponse {
  return {
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function toolUseResponse(name: string, input: unknown): FakeResponse {
  return {
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: "tu1", name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function makeDeps(overrides: Partial<AgentTurnDeps> = {}) {
  const events: Array<{ userId: string; event: AgentTurnEvent }> = [];
  const notifications: unknown[] = [];
  const deps: AgentTurnDeps = {
    publish: (userId, event) => events.push({ userId, event }),
    hasSubscribers: () => true,
    notify: async (n) => {
      notifications.push(n);
    },
    ...overrides,
  };
  return { deps, events, notifications };
}

const baseInput = {
  conversationId: "conv1",
  userId: "user1",
  userText: "hello agent",
  pageContext: null,
  isFirstTurn: false,
};

beforeEach(() => {
  appended.length = 0;
  __resetRegistry();
  vi.mocked(trackUsage).mockClear();
  vi.mocked(setTitle).mockClear();
});
afterEach(() => __resetRegistry());

describe("runAgentTurn", () => {
  it("plain text turn: persists user + assistant and completes", async () => {
    const { deps, events } = makeDeps();
    const create = vi.fn(async () => textResponse("Hi! How can I help?"));
    await runAgentTurn(baseInput, { ...deps, createMessage: create as never });

    expect(appended.map((a) => a.role)).toEqual(["user", "assistant"]);
    expect(appended[1]!.content.text).toContain("How can I help");
    const kinds = events.map((e) => e.event.kind);
    expect(kinds).toEqual(["assistant", "complete"]);
    expect(trackUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: "agent_chat", userId: "user1" }),
    );
  });

  it("tool round trip: dispatches handler, persists tool_event, feeds result back", async () => {
    registerTool({
      name: "get_thing",
      description: "",
      category: "read",
      requiresConfirmation: false,
      inputSchema: { type: "object", properties: {} },
      handler: async (input) => ({
        ok: true,
        output: `THING:${JSON.stringify(input)}`,
      }),
    });
    const calls: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      return calls.length === 1
        ? toolUseResponse("get_thing", { q: "x" })
        : textResponse("Found the thing.");
    });
    const { deps, events } = makeDeps();
    await runAgentTurn(baseInput, { ...deps, createMessage: create as never });

    // second call carries the tool_result back to the model
    const second = calls[1]!.messages as Array<{ role: string; content: unknown }>;
    const lastMsg = second[second.length - 1]!;
    expect(lastMsg.role).toBe("user");
    const results = lastMsg.content as Array<{
      type: string;
      tool_use_id: string;
      content: string;
    }>;
    expect(results[0]!.type).toBe("tool_result");
    expect(results[0]!.tool_use_id).toBe("tu1");
    expect(results[0]!.content).toBe('THING:{"q":"x"}');

    expect(appended.some((a) => a.role === "tool_event")).toBe(true);
    expect(
      events.some((e) => e.event.kind === "tool" && e.event.tool === "get_thing"),
    ).toBe(true);
    expect(appended[appended.length - 1]!.content.text).toBe("Found the thing.");
  });

  it("write tools are refused in Wave A even if registered", async () => {
    registerTool({
      name: "send_money",
      description: "",
      category: "write",
      requiresConfirmation: true,
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ ok: true, output: "SHOULD NEVER RUN" }),
    });
    const calls: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      return calls.length === 1
        ? toolUseResponse("send_money", {})
        : textResponse("ok");
    });
    const { deps } = makeDeps();
    await runAgentTurn(baseInput, { ...deps, createMessage: create as never });

    const second = calls[1]!.messages as Array<{ role: string; content: unknown }>;
    const resultJson = JSON.stringify(second[second.length - 1]!.content);
    expect(resultJson).toContain("requires operator approval");
    expect(resultJson).not.toContain("SHOULD NEVER RUN");
  });

  it("unknown tool returns an error result without crashing the turn", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      return calls.length === 1
        ? toolUseResponse("nope_tool", {})
        : textResponse("recovered");
    });
    const { deps, events } = makeDeps();
    await runAgentTurn(baseInput, { ...deps, createMessage: create as never });
    expect(JSON.stringify(calls[1]!.messages)).toContain("Unknown tool: nope_tool");
    expect(events.at(-1)!.event.kind).toBe("complete");
  });

  it("iteration cap produces the checkpoint message", async () => {
    registerTool({
      name: "loop_forever",
      description: "",
      category: "read",
      requiresConfirmation: false,
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ ok: true, output: "again!" }),
    });
    const create = vi.fn(async () => toolUseResponse("loop_forever", {}));
    const { deps } = makeDeps();
    await runAgentTurn(baseInput, { ...deps, createMessage: create as never });

    expect(create).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS);
    const final = appended[appended.length - 1]!;
    expect(final.role).toBe("assistant");
    expect(String(final.content.text)).toContain("tool limit");
  });

  it("model error persists a friendly message and completes with error", async () => {
    const create = vi.fn(async () => {
      throw new Error("api down");
    });
    const { deps, events } = makeDeps();
    await runAgentTurn(baseInput, { ...deps, createMessage: create as never });

    const final = appended[appended.length - 1]!;
    expect(String(final.content.text)).toContain("Something went wrong");
    const complete = events.at(-1)!.event;
    expect(complete.kind).toBe("complete");
    expect((complete as { error?: string }).error).toContain("api down");
  });

  it("rejects a second concurrent turn for the same conversation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const create = vi.fn(async () => {
      await gate;
      return textResponse("done");
    });
    const { deps } = makeDeps();
    const first = runAgentTurn(baseInput, { ...deps, createMessage: create as never });
    await expect(
      runAgentTurn(baseInput, { ...deps, createMessage: create as never }),
    ).rejects.toThrow(/already in flight/);
    release();
    await first;
  });

  it("notifies when nobody is subscribed, skips when watching", async () => {
    const create = vi.fn(async () => textResponse("done"));
    const watching = makeDeps({ hasSubscribers: () => true });
    await runAgentTurn(baseInput, {
      ...watching.deps,
      createMessage: create as never,
    });
    expect(watching.notifications).toHaveLength(0);

    const away = makeDeps({ hasSubscribers: () => false });
    await runAgentTurn(baseInput, {
      ...away.deps,
      createMessage: create as never,
    });
    expect(away.notifications).toHaveLength(1);
  });

  it("first turn generates a title via the cheap model", async () => {
    const create = vi.fn(async (params: Record<string, unknown>) =>
      params.model === "claude-haiku-4-5"
        ? textResponse("Chase sweep planning")
        : textResponse("answer"),
    );
    const { deps } = makeDeps();
    await runAgentTurn(
      { ...baseInput, isFirstTurn: true },
      { ...deps, createMessage: create as never },
    );
    expect(setTitle).toHaveBeenCalledWith("conv1", "Chase sweep planning");
    const models = create.mock.calls.map((c) => (c[0] as { model: string }).model);
    expect(models).toContain("claude-haiku-4-5");
  });
});

describe("projectHistory", () => {
  it("maps user/assistant, injects page context, skips tool events", () => {
    const out = projectHistory([
      {
        role: "user",
        content: {
          text: "what about this one?",
          pageContext: { page: "/customers/x", customerId: "x", customerName: "Brown & Co" },
        },
      },
      { role: "tool_event", content: { tool: "get_customer" } },
      { role: "assistant", content: { text: "They owe £4,648.90." } },
    ]);
    expect(out).toHaveLength(2);
    expect(String(out[0]!.content)).toContain("Brown & Co");
    expect(String(out[0]!.content)).toContain("what about this one?");
    expect(out[1]).toEqual({ role: "assistant", content: "They owe £4,648.90." });
  });
});
