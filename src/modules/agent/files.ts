// Agent file handling (spec §8): operator uploads + email attachments,
// stored under data/agent-files/ (rsync-excluded from deploys) with
// agent_files metadata. Files enter model context as multimodal blocks,
// always treated as untrusted content.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { agentFiles } from "../../db/schema/agent.js";
import { auditLog } from "../../db/schema/audit.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "agent.files" });

export const AGENT_FILES_DIR = path.resolve("data", "agent-files");
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Image types go to the model as image blocks; PDFs as document blocks.
export const ACCEPTED_MIME: Record<string, { ext: string; kind: "image" | "document" }> = {
  "image/png": { ext: "png", kind: "image" },
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "application/pdf": { ext: "pdf", kind: "document" },
};

export type SaveAgentFileInput = {
  buffer: Buffer;
  filename: string;
  mime: string;
  conversationId: string | null;
  uploaderUserId: string | null;
  sourceEmailLogId?: string | null;
};

export async function saveAgentFile(
  input: SaveAgentFileInput,
): Promise<{ id: string; storagePath: string }> {
  const accepted = ACCEPTED_MIME[input.mime];
  if (!accepted) throw new Error(`unsupported file type: ${input.mime}`);
  if (input.buffer.length > MAX_FILE_BYTES) {
    throw new Error("file too large (max 20 MB)");
  }
  const id = nanoid(24);
  const rel = `${id}.${accepted.ext}`;
  if (!existsSync(AGENT_FILES_DIR)) {
    await fs.mkdir(AGENT_FILES_DIR, { recursive: true });
  }
  await fs.writeFile(path.join(AGENT_FILES_DIR, rel), input.buffer);
  await db.insert(agentFiles).values({
    id,
    conversationId: input.conversationId,
    uploaderUserId: input.uploaderUserId,
    filename: input.filename.slice(0, 512),
    mime: input.mime,
    sizeBytes: input.buffer.length,
    storagePath: rel,
    sourceEmailLogId: input.sourceEmailLogId ?? null,
  });
  return { id, storagePath: rel };
}

export async function getAgentFile(id: string) {
  const rows = await db
    .select()
    .from(agentFiles)
    .where(eq(agentFiles.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function readAgentFileBytes(storagePath: string): Promise<Buffer> {
  // storagePath is always our own nanoid-derived relative name; resolve
  // defensively anyway so a tampered row can't escape the directory.
  const full = path.resolve(AGENT_FILES_DIR, storagePath);
  if (!full.startsWith(AGENT_FILES_DIR + path.sep)) {
    throw new Error("invalid storage path");
  }
  return fs.readFile(full);
}

// "File this remittance under Brown & Co" — link to a record; shows in
// the customer's file list (activity rail integration is render-side).
export async function linkAgentFile(
  fileId: string,
  link: { customerId?: string; rmaId?: string; invoiceId?: string },
  userId: string,
): Promise<boolean> {
  const file = await getAgentFile(fileId);
  if (!file) return false;
  await db
    .update(agentFiles)
    .set({
      customerId: link.customerId ?? file.customerId,
      rmaId: link.rmaId ?? file.rmaId,
      invoiceId: link.invoiceId ?? file.invoiceId,
    })
    .where(eq(agentFiles.id, fileId));
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId,
    action: "agent_file.link",
    entityType: "agent_file",
    entityId: fileId,
    before: {
      customerId: file.customerId,
      rmaId: file.rmaId,
      invoiceId: file.invoiceId,
    },
    after: link,
  });
  return true;
}

export async function listConversationFiles(conversationId: string) {
  return db
    .select()
    .from(agentFiles)
    .where(eq(agentFiles.conversationId, conversationId));
}

export async function listCustomerFiles(customerId: string) {
  return db
    .select()
    .from(agentFiles)
    .where(and(eq(agentFiles.customerId, customerId)));
}

// Multimodal content block for the SDK. Untrusted by definition — the
// system prompt's fencing rules cover binary content semantics (the
// model is told uploads/attachments are customer-originated data).
export async function fileToModelBlock(
  file: { storagePath: string; mime: string },
): Promise<Record<string, unknown> | null> {
  const accepted = ACCEPTED_MIME[file.mime];
  if (!accepted) return null;
  try {
    const bytes = await readAgentFileBytes(file.storagePath);
    const data = bytes.toString("base64");
    if (accepted.kind === "image") {
      return {
        type: "image",
        source: { type: "base64", media_type: file.mime, data },
      };
    }
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
    };
  } catch (err) {
    log.warn({ err, path: file.storagePath }, "agent file unreadable");
    return null;
  }
}
