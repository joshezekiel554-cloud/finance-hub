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

export function buildPrompt(summary: Record<string, unknown>): string {
  const { rmaNumber, customerName, status, daysInState } =
    summary as OpRmaStalledSummary;

  const warehouseStatuses = ["sent_to_warehouse", "awaiting_warehouse_number"];
  const isWarehouseCase = warehouseStatuses.includes(status);

  return `You are an operations assistant reviewing a stalled RMA.

RMA ${rmaNumber} for ${customerName} has been stuck in status "${status}" for ${daysInState} days.

${
  isWarehouseCase
    ? `Call \`nudge_warehouse_email\` with:
- rmaId: the RMA's database ID
- subject: "RMA ${rmaNumber} status check"
- body: a brief, factual message (2–4 sentences) that states the RMA number, customer name, current status, how many days it has been waiting, and asks for an update on next steps`
    : `Call \`create_admin_notification\` with:
- title: "RMA ${rmaNumber} needs attention"
- message: a sentence describing the current state ("${status}") and the operator action required to move it forward
- severity: "warning"`
}

If context clearly indicates no action is needed (e.g., the RMA was just updated or a reply is pending), return exactly:
{"skip": true, "reason": "<brief reason>"}

Be concise. Do not add preamble or explanation outside the tool call or skip response.`;
}
