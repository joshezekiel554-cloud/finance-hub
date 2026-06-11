// Write-tool DECLARATIONS for the agent loop (spec §3). These give the
// model the names + schemas of every approvable action; they NEVER
// execute. The loop intercepts write tool_use calls and creates a chat
// proposal (chat-proposals.ts); execution happens in ai-agent/tools.ts
// via the BullMQ executor after operator approve. The handler here is a
// tripwire — if it ever runs, the interception broke.

import type {
  ToolDefinition,
  ToolInputSchema,
} from "../../../integrations/anthropic/tool-registry.js";

function declare(
  name: string,
  description: string,
  inputSchema: ToolInputSchema,
): ToolDefinition<never> {
  return {
    name,
    description,
    category: "write",
    requiresConfirmation: true,
    inputSchema,
    handler: async () => ({
      ok: false,
      error:
        "write tools must be proposalized by the agent loop, never executed directly",
    }),
  };
}

const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });

export function buildAgentWriteToolDeclarations(): ToolDefinition<never>[] {
  return [
    declare(
      "send_chase_email",
      "Propose a chase (dunning) email to a customer about overdue invoices. The level/tier controls tone (1 gentle, 2 firmer, 3 firm). Recipients are resolved server-side from the customer record. Can attach invoice PDFs (by doc number) and/or the customer's open-items statement PDF.",
      {
        type: "object",
        properties: {
          customerId: str("REAL id from search_customers/get_customer — never invent ids"),
          tier: { type: "string", enum: ["MEDIUM", "HIGH", "CRITICAL"] },
          subject: str(),
          body: str("plain text, written in the Feldart voice"),
          origin: { type: "string", enum: ["feldart", "tj"] },
          attachInvoiceDocNumbers: {
            type: "array",
            items: { type: "string" },
            description:
              "invoice doc numbers (e.g. 18312) to attach as PDFs from QuickBooks — must belong to this customer; max 5",
          },
          attachStatement: {
            type: "boolean",
            description:
              "attach the customer's current open-items statement PDF (book per origin)",
          },
        },
        required: ["customerId", "tier", "subject", "body"],
        additionalProperties: false,
      },
    ),
    declare(
      "send_statement",
      "Propose sending an open-items statement to a customer. Book-scoped; recipient resolved server-side.",
      {
        type: "object",
        properties: {
          customerId: str(),
          origin: { type: "string", enum: ["feldart", "tj"] },
          coverNote: str("optional short note for the statement email"),
        },
        required: ["customerId"],
        additionalProperties: false,
      },
    ),
    declare(
      "send_check_in_email",
      "Propose a friendly non-dunning check-in email to a customer. Can attach invoice PDFs and/or the statement PDF.",
      {
        type: "object",
        properties: {
          customerId: str("REAL id from search_customers/get_customer — never invent ids"),
          subject: str(),
          body: str(),
          attachInvoiceDocNumbers: {
            type: "array",
            items: { type: "string" },
            description: "invoice doc numbers to attach as PDFs — must belong to this customer; max 5",
          },
          attachStatement: { type: "boolean", description: "attach the open-items statement PDF" },
        },
        required: ["customerId", "subject", "body"],
        additionalProperties: false,
      },
    ),
    declare(
      "send_bookkeeper_email",
      "Propose an email to the Torah Judaica bookkeeper about a disputed TJ invoice. Recipient is the configured bookkeeper, resolved at execution time.",
      {
        type: "object",
        properties: {
          invoiceId: str("the TJ invoice id under dispute"),
          subject: str(),
          body: str(),
        },
        required: ["invoiceId", "subject", "body"],
        additionalProperties: false,
      },
    ),
    declare(
      "create_task",
      "Propose creating a team task — optionally linked to a customer, assigned to a team member by email, with a concrete ISO due date (convert any natural-language date to ISO yourself).",
      {
        type: "object",
        properties: {
          title: str(),
          body: str(),
          customerId: str(),
          assigneeEmail: str("team member's email; omit to assign to the requesting operator"),
          dueAtIso: str("ISO date e.g. 2026-06-15"),
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        },
        required: ["title"],
        additionalProperties: false,
      },
    ),
    declare("complete_task", "Propose marking an open task completed.", {
      type: "object",
      properties: { taskId: str() },
      required: ["taskId"],
      additionalProperties: false,
    }),
    declare(
      "update_customer_context",
      "Propose appending a durable fact to a customer's AI context (visible/editable by the team; never replaces existing context).",
      {
        type: "object",
        properties: { customerId: str(), append: str("the fact to remember") },
        required: ["customerId", "append"],
        additionalProperties: false,
      },
    ),
    declare(
      "record_interaction",
      "Propose logging an out-of-band interaction the operator described (WhatsApp, external phone call, in person) onto the customer's activity timeline.",
      {
        type: "object",
        properties: {
          customerId: str(),
          channel: { type: "string", enum: ["whatsapp", "phone", "in_person", "other"] },
          summary: str("what happened, as told by the operator"),
          occurredAtIso: str("ISO datetime if the operator gave one"),
        },
        required: ["customerId", "channel", "summary"],
        additionalProperties: false,
      },
    ),
    declare(
      "set_hold_status",
      "Propose changing a customer's account state: hold (blocks B2B ordering), active, or payment_upfront. Flips Shopify tags on approval.",
      {
        type: "object",
        properties: {
          customerId: str(),
          targetState: { type: "string", enum: ["active", "hold", "payment_upfront"] },
        },
        required: ["customerId", "targetState"],
        additionalProperties: false,
      },
    ),
    declare(
      "set_payment_terms",
      "Propose changing a customer's payment terms (local CRM field).",
      {
        type: "object",
        properties: { customerId: str(), terms: str('e.g. "Net 30"') },
        required: ["customerId", "terms"],
        additionalProperties: false,
      },
    ),
    declare(
      "dispute_transition",
      "Propose moving a Torah Judaica invoice through the dispute flow: claims_paid (park for verification), not_paid (resume chasing), paid_void (VOID in QuickBooks — irreversible, needs typed confirmation from the operator).",
      {
        type: "object",
        properties: {
          invoiceId: str(),
          action: { type: "string", enum: ["claims_paid", "not_paid", "paid_void"] },
          note: str("optional context, e.g. what the customer claims"),
        },
        required: ["invoiceId", "action"],
        additionalProperties: false,
      },
    ),
    declare(
      "create_admin_notification",
      "Propose raising an internal team notification.",
      {
        type: "object",
        properties: {
          title: str(),
          message: str(),
          severity: { type: "string", enum: ["info", "warning", "urgent"] },
        },
        required: ["title", "message"],
        additionalProperties: false,
      },
    ),
    declare(
      "nudge_warehouse_email",
      "Propose a nudge email to the warehouse team about an RMA. Recipient is the configured warehouse address.",
      {
        type: "object",
        properties: { rmaId: str(), subject: str(), body: str() },
        required: ["rmaId", "subject", "body"],
        additionalProperties: false,
      },
    ),
  ];
}
