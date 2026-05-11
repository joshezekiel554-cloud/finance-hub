import type {
  RmaReturnType,
  RmaStatus,
} from "../../db/schema/returns.js";

export type RmaAction =
  | "approve"
  | "deny"
  | "override_approve"
  | "unapprove"
  | "revert_to_draft"
  | "generate_warehouse_export"
  | "cancel_warehouse_export"
  | "set_warehouse_number"
  | "mark_received"
  | "issue_credit_memo"
  | "mark_already_credited"
  | "mark_replacement_sent"
  | "cancel";

export type TransitionInput = {
  currentStatus: RmaStatus;
  returnType: RmaReturnType;
};

export type TransitionResult =
  | { ok: true; nextStatus: RmaStatus }
  | { ok: false; reason: string };

type TransitionRule = (input: TransitionInput) => TransitionResult;

const allowFrom = (
  fromStatuses: RmaStatus[],
  nextStatus: RmaStatus,
  guard?: (input: TransitionInput) => string | null,
): TransitionRule => {
  return ({ currentStatus, returnType }) => {
    if (!fromStatuses.includes(currentStatus)) {
      return {
        ok: false,
        reason: `Cannot transition from "${currentStatus}" — required: ${fromStatuses.join(" / ")}`,
      };
    }
    if (guard) {
      const blocked = guard({ currentStatus, returnType });
      if (blocked) return { ok: false, reason: blocked };
    }
    return { ok: true, nextStatus };
  };
};

export const TRANSITIONS: Record<RmaAction, TransitionRule> = {
  approve: allowFrom(["draft"], "approved"),
  deny: allowFrom(["draft"], "denied"),
  override_approve: allowFrom(["denied"], "approved", ({ returnType }) =>
    returnType === "seasonal"
      ? null
      : "override_approve is only allowed for seasonal RMAs",
  ),
  unapprove: allowFrom(["approved"], "draft"),
  // Heavier "edit again" path. Allowed from any non-terminal post-draft state
  // so the operator can fix mistakes after approval / warehouse handoff. The
  // service-layer impl clears workflow side-effects (rmaNumber, export
  // timestamp, sent_to_warehouse_at) so the next walk-through starts clean.
  revert_to_draft: allowFrom(
    [
      "approved",
      "awaiting_warehouse_number",
      "sent_to_warehouse",
      "received",
      "denied",
    ],
    "draft",
  ),
  generate_warehouse_export: allowFrom(
    ["approved"],
    "awaiting_warehouse_number",
    ({ returnType }) =>
      returnType === "damage"
        ? "damage RMAs do not use warehouse export"
        : null,
  ),
  cancel_warehouse_export: allowFrom(
    ["awaiting_warehouse_number"],
    "approved",
  ),
  set_warehouse_number: allowFrom(
    ["awaiting_warehouse_number"],
    "sent_to_warehouse",
  ),
  mark_received: allowFrom(["sent_to_warehouse"], "received"),
  issue_credit_memo: allowFrom(["approved", "received"], "completed", ({
    currentStatus,
    returnType,
  }) => {
    if (currentStatus === "approved" && returnType !== "damage") {
      return "issue_credit_memo from approved is only valid for damage RMAs";
    }
    return null;
  }),
  // Used to reconcile imported RMAs whose desktop status was stale — the
  // CM was actually issued in QBO but the desktop never advanced past
  // "approved". The operator pastes the QBO CM doc number and the service
  // moves the RMA to completed without re-creating anything in QBO.
  //
  // Also allowed from "completed" so the same button can backfill the link
  // on RMAs that were imported as completed but lacked a CM doc number
  // (the bulk backfill script handles 99% of them; this covers stragglers).
  // The service guards against overwriting an existing qboCreditMemoId.
  mark_already_credited: allowFrom(
    ["approved", "received", "completed"],
    "completed",
  ),
  mark_replacement_sent: allowFrom(["approved"], "completed", ({
    returnType,
  }) =>
    returnType === "damage"
      ? null
      : "mark_replacement_sent is only valid for damage RMAs",
  ),
  cancel: allowFrom(
    ["approved", "awaiting_warehouse_number", "sent_to_warehouse"],
    "cancelled",
  ),
};

export type ValidateTransitionInput = TransitionInput & { action: RmaAction };

export function validateTransition(
  input: ValidateTransitionInput,
): TransitionResult {
  const rule = TRANSITIONS[input.action];
  if (!rule) {
    return { ok: false, reason: `Unknown action: ${input.action}` };
  }
  return rule({
    currentStatus: input.currentStatus,
    returnType: input.returnType,
  });
}
