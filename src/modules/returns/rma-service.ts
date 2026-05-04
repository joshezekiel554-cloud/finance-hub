import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  rmas,
  type NewRma,
  type Rma,
  type RmaReturnType,
} from "../../db/schema/returns.js";
import { recordActivity } from "../crm/activity-ingester.js";

export type CreateRmaInput = {
  customerId: string;
  qbCustomerId: string;
  returnType: RmaReturnType;
  createdByUserId: string;
  seasonId?: string | null;
  notes?: string | null;
  originalEmail?: string | null;
};

export async function createRma(input: CreateRmaInput): Promise<Rma> {
  const id = nanoid(24);
  const row: NewRma = {
    id,
    customerId: input.customerId,
    qbCustomerId: input.qbCustomerId,
    returnType: input.returnType,
    status: "draft",
    seasonId: input.seasonId ?? null,
    notes: input.notes ?? null,
    originalEmail: input.originalEmail ?? null,
    totalValue: "0",
    thresholdOverridden: false,
    createdViaReceipt: false,
    createdByUserId: input.createdByUserId,
  };
  await db.insert(rmas).values(row);
  await recordActivity(
    {
      customerId: input.customerId,
      kind: "rma_created",
      source: "user_action",
      userId: input.createdByUserId,
      refType: "rma",
      refId: id,
    },
    db,
  );
  return row as Rma;
}
