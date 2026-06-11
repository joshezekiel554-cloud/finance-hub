// The agent turn loop (spec 2026-06-11 §2): server-side multi-turn
// tool-use against Sonnet, emitting per-step events the route forwards
// over SSE. A turn keeps executing even if the client disconnects —
// results persist to agent_messages and a bell notification fires when
// nobody was watching.
//
// Layering: this module never imports server plugins. The route injects
// `publish` (SSE), `hasSubscribers`, and `notify`; tests inject fakes for
// everything including the Anthropic client.

import { getAnthropicClient } from "../../integrations/anthropic/client.js";
import {
  getTool,
  toAnthropicTools,
} from "../../integrations/anthropic/tool-registry.js";
import {
  trackUsage,
  type ToolCallRecord,
} from "../../integrations/anthropic/cost-tracker.js";
import type { AnthropicResponseWithUsage } from "../../integrations/anthropic/types.js";
import { createLogger } from "../../lib/logger.js";
import {
  buildAgentSystemPrompt,
  composePageContextBlock,
  composeSummaryBlock,
  type PageContext,
} from "./context.js";
import {
  appendMessage,
  getConversation,
  listMessagesForContext,
  maybeCompact,
  parseSummary,
  setTitle,
  type Summarizer,
} from "./conversations.js";

const log = createLogger({ component: "agent.loop" });

export const AGENT_MODEL = "claude-sonnet-4-6";
export const TITLE_MODEL = "claude-haiku-4-5";
export const MAX_TOOL_ITERATIONS = 15;
const MAX_TOKENS = 4096;

// Events the route forwards over SSE. `tool` fires per tool call (chip
// rendering), `assistant` per intermediate/final text, `complete` once
// per turn (with error flag when the turn died).
export type AgentTurnEvent =
  | { kind: "tool"; conversationId: string; tool: string; ok: boolean; durationMs: number }
  | { kind: "assistant"; conversationId: string; messageId: string; text: string }
  | { kind: "complete"; conversationId: string; error?: string };

export type AgentTurnDeps = {
  publish: (userId: string, event: AgentTurnEvent) => void;
  hasSubscribers: (userId: string) => boolean;
  notify: (input: {
    userId: string;
    conversationId: string;
    title: string;
  }) => Promise<void>;
  // Test seams; default to real implementations.
  createMessage?: (
    params: Record<string, unknown>,
  ) => Promise<AnthropicResponseWithUsage>;
  summarize?: Summarizer;
  now?: () => number;
};

// One in-flight turn per conversation (in-process — single pm2 web
// process serves all SSE + agent traffic).
const inFlight = new Set<string>();

export function isTurnInFlight(conversationId: string): boolean {
  return inFlight.has(conversationId);
}

type SdkMessage = {
  role: "user" | "assistant";
  content: unknown;
};

// Project persisted history into SDK messages. tool_event rows are
// replay metadata for the UI — the model sees tool results inline within
// the turn they happened, so history projection collapses them to a
// short marker inside an assistant turn... simpler and sufficient: skip
// them (the assistant's own text already reflects what tools told it).
export function projectHistory(
  rows: Array<{ role: string; content: unknown }>,
): SdkMessage[] {
  const out: SdkMessage[] = [];
  for (const m of rows) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const c = m.content as { text?: unknown; pageContext?: unknown };
    const text = String(c.text ?? "").trim();
    if (!text) continue;
    if (m.role === "user") {
      const page = composePageContextBlock(
        (c.pageContext as PageContext | undefined) ?? null,
      );
      out.push({ role: "user", content: page ? `${page}\n${text}` : text });
    } else {
      out.push({ role: "assistant", content: text });
    }
  }
  return out;
}

async function defaultCreateMessage(
  params: Record<string, unknown>,
): Promise<AnthropicResponseWithUsage> {
  const client = getAnthropicClient();
  return (await client.messages.create(
    params as unknown as Parameters<typeof client.messages.create>[0],
  )) as unknown as AnthropicResponseWithUsage;
}

async function defaultSummarize(transcript: string): Promise<string> {
  const res = await defaultCreateMessage({
    model: TITLE_MODEL,
    max_tokens: 800,
    messages: [
      {
        role: "user",
        content: `Summarize this finance-CRM agent conversation in under 300 words, keeping customer names, amounts, invoice numbers and decisions:\n\n${transcript.slice(0, 60_000)}`,
      },
    ],
  });
  void trackUsage(res, { surface: "agent_chat", userId: null });
  return res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function generateTitle(
  createMessage: NonNullable<AgentTurnDeps["createMessage"]>,
  userText: string,
  userId: string,
): Promise<string | null> {
  try {
    const res = await createMessage({
      model: TITLE_MODEL,
      max_tokens: 30,
      messages: [
        {
          role: "user",
          content: `Give a 3-6 word title for a conversation that starts with this request. Reply with the title only.\n\n${userText.slice(0, 500)}`,
        },
      ],
    });
    void trackUsage(res, { surface: "agent_chat", userId });
    const title = res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim()
      .replace(/^["']|["']$/g, "");
    return title || null;
  } catch {
    return null; // titles are cosmetic — never fail a turn
  }
}

export type RunTurnInput = {
  conversationId: string;
  userId: string;
  userText: string;
  pageContext: PageContext | null;
  isFirstTurn: boolean;
};

export async function runAgentTurn(
  input: RunTurnInput,
  deps: AgentTurnDeps,
): Promise<void> {
  const { conversationId, userId } = input;
  if (inFlight.has(conversationId)) {
    throw new Error("turn already in flight for this conversation");
  }
  inFlight.add(conversationId);
  const createMessage = deps.createMessage ?? defaultCreateMessage;
  const summarize = deps.summarize ?? defaultSummarize;
  const now = deps.now ?? Date.now;

  try {
    await appendMessage(conversationId, "user", {
      text: input.userText,
      pageContext: input.pageContext ?? undefined,
    });

    const conv = await getConversation(userId, conversationId);
    if (!conv) throw new Error("conversation not found");
    const summary = parseSummary(conv.summary);

    const [system, historyRows] = await Promise.all([
      buildAgentSystemPrompt(),
      listMessagesForContext(conversationId, summary),
    ]);

    const messages: SdkMessage[] = [];
    const summaryBlock = composeSummaryBlock(summary?.text ?? null);
    if (summaryBlock) messages.push({ role: "user", content: summaryBlock });
    messages.push(...projectHistory(historyRows));
    // historyRows already includes the just-persisted user message.

    const tools = toAnthropicTools();
    const toolsCalled: ToolCallRecord[] = [];
    let finalText: string | null = null;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await createMessage({
        model: AGENT_MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools,
        messages,
      });
      void trackUsage(response, {
        surface: "agent_chat",
        userId,
        toolsCalled: toolsCalled.length ? toolsCalled : undefined,
      });

      const content = response.content as Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
      >;
      const toolUses = content.filter(
        (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
          b.type === "tool_use",
      );
      const textBlocks = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      if (toolUses.length === 0) {
        finalText = textBlocks || "(no response)";
        break;
      }

      // Intermediate narration before tool calls — surface it live.
      if (textBlocks) {
        const mid = await appendMessage(conversationId, "assistant", {
          text: textBlocks,
          intermediate: true,
        });
        deps.publish(userId, {
          kind: "assistant",
          conversationId,
          messageId: mid,
          text: textBlocks,
        });
      }

      messages.push({ role: "assistant", content });

      const results: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = [];
      for (const tu of toolUses) {
        const started = now();
        const def = getTool(tu.name);
        let resultText: string;
        let okFlag = false;
        if (!def) {
          resultText = `Unknown tool: ${tu.name}`;
        } else if (def.requiresConfirmation) {
          // Wave A: no write tools in the loop. Defense in depth — the
          // registry only holds reads today, but the guard outlives that.
          resultText =
            "This action requires operator approval and is not yet available in chat (coming in the next update).";
        } else {
          try {
            const res = await def.handler(tu.input, { userId });
            okFlag = res.ok;
            resultText = res.ok ? res.output : `Error: ${res.error}`;
          } catch (err) {
            resultText = `Error: ${err instanceof Error ? err.message : "tool failed"}`;
            log.error({ err, tool: tu.name, conversationId }, "agent tool threw");
          }
        }
        const durationMs = now() - started;
        toolsCalled.push({ name: tu.name, ok: okFlag, durationMs });
        await appendMessage(conversationId, "tool_event", {
          tool: tu.name,
          ok: okFlag,
          durationMs,
        });
        deps.publish(userId, {
          kind: "tool",
          conversationId,
          tool: tu.name,
          ok: okFlag,
          durationMs,
        });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: resultText,
          ...(okFlag ? {} : { is_error: true }),
        });
      }
      messages.push({ role: "user", content: results });
    }

    if (finalText === null) {
      finalText = `I've hit my per-turn tool limit (${MAX_TOOL_ITERATIONS} rounds) while working on this. Here's where I got to — say "continue" and I'll pick up from here.`;
    }

    const messageId = await appendMessage(conversationId, "assistant", {
      text: finalText,
    });
    deps.publish(userId, {
      kind: "assistant",
      conversationId,
      messageId,
      text: finalText,
    });
    deps.publish(userId, { kind: "complete", conversationId });

    if (input.isFirstTurn) {
      const title = await generateTitle(createMessage, input.userText, userId);
      if (title) await setTitle(conversationId, title);
    }
    void maybeCompact(conversationId, summarize);

    if (!deps.hasSubscribers(userId)) {
      await deps
        .notify({
          userId,
          conversationId,
          title: "The agent finished working on your request",
        })
        .catch((err) =>
          log.warn({ err, conversationId }, "turn-complete notification failed"),
        );
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "the agent hit an unexpected error";
    log.error({ err, conversationId, userId }, "agent turn failed");
    try {
      const messageId = await appendMessage(conversationId, "assistant", {
        text: `Something went wrong on my end (${message}). Your message is saved — try again in a moment.`,
        error: true,
      });
      deps.publish(userId, {
        kind: "assistant",
        conversationId,
        messageId,
        text: `Something went wrong on my end (${message}). Your message is saved — try again in a moment.`,
      });
    } catch {
      // persistence itself failed — the SSE error event is all we can do
    }
    deps.publish(userId, { kind: "complete", conversationId, error: message });
  } finally {
    inFlight.delete(conversationId);
  }
}
