import type { BuiltPrompt, DraftContext } from "../voice.js";

export const TOOL_NAMES = [
  "nudge_warehouse_email",
  "create_admin_notification",
] as const;

type OpRmaStalledSummary = {
  rmaNumber: string;
  customerName: string;
  status: string;
  daysInState: number;
};

export function buildPrompt(
  summary: Record<string, unknown>,
  context: DraftContext,
): BuiltPrompt {
  const { rmaNumber, customerName, status, daysInState } =
    summary as OpRmaStalledSummary;

  const warehouseStatuses = ["sent_to_warehouse", "awaiting_warehouse_number"];
  const isWarehouseCase = warehouseStatuses.includes(status);

  // Warehouse branch writes an outbound email -> Feldart voice. Admin branch
  // writes an internal notification -> no voice context (empty system).
  const system = isWarehouseCase
    ? `You are an operations assistant at Feldart writing a brief warehouse nudge email.

## How Feldart writes
${context.voiceGuide}`
    : "";

  const user = isWarehouseCase
    ? `RMA ${rmaNumber} for ${customerName} has been stuck in status "${status}" for ${daysInState} days.

Call \`nudge_warehouse_email\` with:
- rmaId: the RMA's database ID
- subject: "RMA ${rmaNumber} status check"
- body: a brief, factual message (2-4 sentences) stating the RMA number, customer name, current status, how many days it has been waiting, and asking for an update on next steps.

If context clearly indicates no action is needed, return exactly:
{"skip": true, "reason": "<brief reason>"}

Be concise. Do not add preamble or explanation outside the tool call or skip response.`
    : `You are an operations assistant reviewing a stalled RMA.

RMA ${rmaNumber} for ${customerName} has been stuck in status "${status}" for ${daysInState} days.

Call \`create_admin_notification\` with:
- title: "RMA ${rmaNumber} needs attention"
- message: a sentence describing the current state ("${status}") and the operator action required to move it forward
- severity: "warning"

If context clearly indicates no action is needed, return exactly:
{"skip": true, "reason": "<brief reason>"}

Be concise. Do not add preamble or explanation outside the tool call or skip response.`;

  return { system, user };
}
