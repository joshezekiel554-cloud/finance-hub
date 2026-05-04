import type { Rma, RmaItem } from "../../db/schema/returns.js";

export type BuildAndPushInput = {
  rma: Rma;
  items: RmaItem[];
  shippingDeduction: string | null;
  restockingFee: string | null;
};

export type BuildAndPushResult = {
  qboCreditMemoId: string;
  docNumber: string;
};

export async function buildAndPushCreditMemo(
  _input: BuildAndPushInput,
): Promise<BuildAndPushResult> {
  throw new Error(
    "buildAndPushCreditMemo not yet implemented — coming in Phase 1 Task 5",
  );
}
