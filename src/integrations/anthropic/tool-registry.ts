// Foundation for the week 9 agent loop. Intentionally empty at launch —
// tools are registered as the agentic surface lands (lookup_customer,
// draft_email, send_email-with-confirm, create_task, send_statement, etc.).
// All write tools must require explicit user confirmation (plan §AI agentic
// surface). The agent loop itself is not implemented here; this file just
// establishes the shape so callers can plug into a stable registry now.

import type Anthropic from "@anthropic-ai/sdk";

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type ToolCategory = "read" | "write";

export type ToolHandlerContext = {
  // Auth.js v5 user id of the operator initiating the call. Null for
  // background-proposing jobs that run without a session.
  userId: string | null;
  // BullMQ-friendly: write tools schedule a job rather than executing inline,
  // so handlers receive the queue handle. Populated by the agent loop wrapper
  // when it lands; free-form for now to avoid circular deps with src/jobs.
  enqueue?: (jobName: string, payload: unknown) => Promise<void>;
};

export type ToolHandlerResult =
  | { ok: true; output: string }
  | { ok: true; proposalId: string; output: string }
  | { ok: false; error: string };

export type ToolDefinition<TInput = unknown> = {
  name: string;
  description: string;
  category: ToolCategory;
  // requiresConfirmation: every write tool MUST set this true. The agent
  // loop reads it before executing — the model proposes, the user approves,
  // BullMQ runs.
  requiresConfirmation: boolean;
  inputSchema: ToolInputSchema;
  handler: (
    input: TInput,
    context: ToolHandlerContext,
  ) => Promise<ToolHandlerResult>;
};

const registry = new Map<string, ToolDefinition<unknown>>();

export function registerTool<TInput>(def: ToolDefinition<TInput>): void {
  if (registry.has(def.name)) {
    throw new Error(`Tool already registered: ${def.name}`);
  }
  if (def.category === "write" && !def.requiresConfirmation) {
    throw new Error(
      `Write tool '${def.name}' must set requiresConfirmation: true`,
    );
  }
  registry.set(def.name, def as ToolDefinition<unknown>);
}

export function listTools(): ToolDefinition<unknown>[] {
  return Array.from(registry.values());
}

export function getTool(name: string): ToolDefinition<unknown> | undefined {
  return registry.get(name);
}

// Test/dev hook only — production never clears the registry.
export function __resetRegistry(): void {
  registry.clear();
}

// Shape Claude expects in messages.create({tools: ...}). Used by the agent
// loop in week 9 to project our richer ToolDefinition into the SDK type.
export function toAnthropicTools(): Anthropic.Tool[] {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as unknown as Anthropic.Tool.InputSchema,
  }));
}
