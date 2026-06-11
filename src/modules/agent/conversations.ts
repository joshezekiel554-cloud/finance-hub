// Conversation persistence + rolling compaction (spec 2026-06-11 §2, §6).
//
// Compaction: when a conversation outgrows the context budget, older
// turns are summarized (Haiku) and the verbatim window shrinks to the
// most recent messages. The summary column stores JSON
// {text, throughCreatedAt} — context assembly includes the summary block
// plus only messages created AFTER throughCreatedAt. UI history always
// shows everything (messages are never deleted).

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  agentConversations,
  agentMessages,
  type AgentMessageRole,
} from "../../db/schema/agent.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "agent.conversations" });

// Compaction thresholds: count-based primary, char-based backstop.
export const COMPACT_MESSAGE_THRESHOLD = 60;
export const COMPACT_KEEP_RECENT = 20;
export const COMPACT_CHAR_THRESHOLD = 400_000;

export type ConversationSummary = {
  text: string;
  throughCreatedAt: string; // ISO — messages after this stay verbatim
};

export function parseSummary(raw: string | null): ConversationSummary | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationSummary>;
    if (typeof parsed.text === "string" && typeof parsed.throughCreatedAt === "string") {
      return { text: parsed.text, throughCreatedAt: parsed.throughCreatedAt };
    }
  } catch {
    // Legacy/garbled value — treat as absent rather than failing the turn.
  }
  return null;
}

export async function createConversation(
  userId: string,
  title = "New conversation",
): Promise<string> {
  const id = nanoid(24);
  await db.insert(agentConversations).values({ id, userId, title });
  return id;
}

export async function listConversations(userId: string) {
  return db
    .select({
      id: agentConversations.id,
      title: agentConversations.title,
      createdAt: agentConversations.createdAt,
      updatedAt: agentConversations.updatedAt,
    })
    .from(agentConversations)
    .where(
      and(
        eq(agentConversations.userId, userId),
        isNull(agentConversations.archivedAt),
      ),
    )
    .orderBy(desc(agentConversations.updatedAt))
    .limit(100);
}

// Per-user scoping enforced here: a conversation id belonging to another
// user behaves exactly like a missing one.
export async function getConversation(userId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(agentConversations)
    .where(
      and(
        eq(agentConversations.id, conversationId),
        eq(agentConversations.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listMessages(conversationId: string) {
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(agentMessages.createdAt, agentMessages.id);
}

export async function appendMessage(
  conversationId: string,
  role: AgentMessageRole,
  content: Record<string, unknown>,
): Promise<string> {
  const id = nanoid(24);
  await db.insert(agentMessages).values({ id, conversationId, role, content });
  // Touch the conversation so the list sorts by activity.
  await db
    .update(agentConversations)
    .set({ updatedAt: new Date() })
    .where(eq(agentConversations.id, conversationId));
  return id;
}

export async function setTitle(conversationId: string, title: string) {
  await db
    .update(agentConversations)
    .set({ title: title.slice(0, 256) })
    .where(eq(agentConversations.id, conversationId));
}

export async function archiveConversation(userId: string, conversationId: string) {
  await db
    .update(agentConversations)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(agentConversations.id, conversationId),
        eq(agentConversations.userId, userId),
      ),
    );
}

// Messages the loop should include verbatim (post-summary window).
export async function listMessagesForContext(
  conversationId: string,
  summary: ConversationSummary | null,
) {
  if (!summary) return listMessages(conversationId);
  return db
    .select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.conversationId, conversationId),
        gt(agentMessages.createdAt, new Date(summary.throughCreatedAt)),
      ),
    )
    .orderBy(agentMessages.createdAt, agentMessages.id);
}

export type Summarizer = (transcript: string) => Promise<string>;

// Compact when over threshold. Injectable summarizer (Haiku in prod).
// Returns true when a new summary was written.
export async function maybeCompact(
  conversationId: string,
  summarize: Summarizer,
): Promise<boolean> {
  const conv = await db
    .select()
    .from(agentConversations)
    .where(eq(agentConversations.id, conversationId))
    .limit(1);
  if (!conv[0]) return false;
  const existing = parseSummary(conv[0].summary);
  const windowMessages = await listMessagesForContext(conversationId, existing);

  const totalChars = windowMessages.reduce(
    (n, m) => n + JSON.stringify(m.content).length,
    0,
  );
  if (
    windowMessages.length <= COMPACT_MESSAGE_THRESHOLD &&
    totalChars <= COMPACT_CHAR_THRESHOLD
  ) {
    return false;
  }

  const toSummarize = windowMessages.slice(0, -COMPACT_KEEP_RECENT);
  if (toSummarize.length === 0) return false;

  const transcript = [
    existing ? `[previous summary]\n${existing.text}` : null,
    ...toSummarize.map((m) => {
      const c = m.content as { text?: unknown; tool?: unknown };
      if (m.role === "tool_event") return `[tool: ${String(c.tool ?? "?")}]`;
      return `${m.role}: ${String(c.text ?? "")}`;
    }),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const text = await summarize(transcript);
    const through = toSummarize[toSummarize.length - 1]!.createdAt;
    const next: ConversationSummary = {
      text,
      throughCreatedAt: through.toISOString(),
    };
    await db
      .update(agentConversations)
      .set({ summary: JSON.stringify(next) })
      .where(eq(agentConversations.id, conversationId));
    return true;
  } catch (err) {
    // Compaction is an optimization — never fail a turn over it.
    log.warn({ err, conversationId }, "conversation compaction failed");
    return false;
  }
}
