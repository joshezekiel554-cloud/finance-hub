// Pure helpers behind the compose modal's customer-doc picker.
//
// The picker lets the operator tick several invoices / credit memos and
// attach them in one action. Everything here is DOM-free so it can be
// unit-tested: filename derivation (which also drives the
// already-attached dedupe), the bounded-concurrency fetch runner, and
// the success/failure partition of a batch.

// Mirrors the server cap in src/server/routes/email-send.ts
// (`attachments: z.array(...).max(20)`). Selecting past it client-side
// would only surface as a 400 after every PDF had been fetched and
// base64-encoded, so the picker stops the operator earlier.
export const MAX_ATTACHMENTS = 20;

// How many more docs may be ticked before the send would be rejected.
export function remainingAttachmentSlots(
  alreadyAttachedCount: number,
): number {
  return Math.max(0, MAX_ATTACHMENTS - alreadyAttachedCount);
}

export type CustomerDocRow = {
  docType: "invoice" | "credit_memo";
  qbId: string;
  docNumber: string | null;
  issueDate: string | null;
  total: string;
  balance: string;
};

export function docRowKey(row: CustomerDocRow): string {
  return `${row.docType}:${row.qbId}`;
}

// Must stay stable: the attached-file dedupe compares these names
// against the File objects already on the draft.
export function docRowFilename(row: CustomerDocRow): string {
  const baseName =
    row.docType === "credit_memo"
      ? `CreditMemo-${row.docNumber ?? row.qbId}`
      : `Invoice-${row.docNumber ?? row.qbId}`;
  return `${baseName}.pdf`;
}

export function docRowLabel(row: CustomerDocRow): string {
  return `${row.docType === "credit_memo" ? "CM" : "Inv"} ${
    row.docNumber ?? row.qbId
  }`;
}

// Run `worker` over every item with at most `limit` in flight, preserving
// input order in the results. Keeps a 20-doc batch from opening 20
// simultaneous QBO PDF requests, which the upstream API throttles.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  async function runner(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner),
  );
  return results;
}

export type DocFetchResult<F> = {
  row: CustomerDocRow;
  file: F | null;
  error: string | null;
};

export type BatchOutcome<F> = {
  files: F[];
  // Keys that landed — these get un-ticked. Failures stay ticked so a
  // retry is one click.
  attachedKeys: string[];
  failedLabels: string[];
  errorMessage: string | null;
};

export function partitionBatch<F>(
  results: DocFetchResult<F>[],
): BatchOutcome<F> {
  const files: F[] = [];
  const attachedKeys: string[] = [];
  const failedLabels: string[] = [];
  for (const result of results) {
    if (result.file !== null) {
      files.push(result.file);
      attachedKeys.push(docRowKey(result.row));
    } else {
      failedLabels.push(docRowLabel(result.row));
    }
  }
  return {
    files,
    attachedKeys,
    failedLabels,
    errorMessage:
      failedLabels.length === 0
        ? null
        : `Couldn't fetch ${failedLabels.length} of ${results.length}: ${failedLabels.join(", ")}`,
  };
}
