// Rename RMA evidence files in Drive when a credit memo number arrives.
//
// Files are uploaded as SKU-<RMA#>-n.ext because the credit memo doesn't
// exist yet. Once it's issued (or an existing one is linked), the operator
// wants them findable by credit memo: SKU-<CM#>-n.ext. Best-effort: a Drive
// hiccup never fails the credit memo itself; it's logged and the DB row
// keeps the old name so a later retry can pick it up.

import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { rmaPhotos } from "../../db/schema/returns.js";
import { createLogger } from "../../lib/logger.js";
import { buildRmaMediaFilename, extensionOfFilename } from "../../lib/rma-media.js";

const log = createLogger({ module: "returns.media-rename" });

export type RenamablePhoto = {
  id: string;
  driveFileId: string;
  position: number;
  sku: string | null;
  filename: string;
};

export type RenamePlanEntry = {
  photoId: string;
  driveFileId: string;
  newFilename: string;
};

/** Pure: which files need a new name for this credit memo number. */
export function planCreditMemoRenames(
  photos: readonly RenamablePhoto[],
  creditMemoDocNumber: string,
): RenamePlanEntry[] {
  const docNumber = creditMemoDocNumber.trim();
  if (!docNumber) return [];
  const plan: RenamePlanEntry[] = [];
  for (const photo of photos) {
    const newFilename = buildRmaMediaFilename({
      sku: photo.sku,
      docNumber,
      n: photo.position + 1,
      ext: extensionOfFilename(photo.filename),
    });
    if (newFilename === photo.filename) continue;
    plan.push({ photoId: photo.id, driveFileId: photo.driveFileId, newFilename });
  }
  return plan;
}

/**
 * Execute the plan for one RMA: rename in Drive, then record the new name.
 * Never throws — returns how many files were renamed.
 */
export async function renameRmaMediaForCreditMemo(input: {
  rmaId: string;
  creditMemoDocNumber: string;
  userId: string;
}): Promise<number> {
  let renamed = 0;
  try {
    const rows = await db
      .select({
        id: rmaPhotos.id,
        driveFileId: rmaPhotos.driveFileId,
        position: rmaPhotos.position,
        sku: rmaPhotos.sku,
        filename: rmaPhotos.filename,
      })
      .from(rmaPhotos)
      .where(eq(rmaPhotos.rmaId, input.rmaId));
    const plan = planCreditMemoRenames(rows, input.creditMemoDocNumber);
    if (plan.length === 0) return 0;

    const { renameFile } = await import("../../integrations/google-drive/client.js");
    for (const entry of plan) {
      try {
        await renameFile({
          userId: input.userId,
          fileId: entry.driveFileId,
          newName: entry.newFilename,
        });
        await db
          .update(rmaPhotos)
          .set({ filename: entry.newFilename })
          .where(eq(rmaPhotos.id, entry.photoId));
        renamed += 1;
      } catch (err) {
        log.warn(
          { err, rmaId: input.rmaId, photoId: entry.photoId, newFilename: entry.newFilename },
          "Drive media rename failed; leaving old name",
        );
      }
    }
    log.info(
      { rmaId: input.rmaId, creditMemoDocNumber: input.creditMemoDocNumber, renamed, planned: plan.length },
      "rma media renamed for credit memo",
    );
  } catch (err) {
    log.error({ err, rmaId: input.rmaId }, "media rename planning failed");
  }
  return renamed;
}
