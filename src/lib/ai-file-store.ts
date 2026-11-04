// Short-lived store for files the Feldart AI tools GENERATE (e.g. a numbered
// statement PDF). The side effect happens once, when the tool runs; the
// signed link only streams these stored bytes, so opening it any number of
// times — browser prefetch, link scanners, a double tap — changes nothing.
//
// Local disk under the OS temp dir (finance-hub is a single pm2 fork), files
// mode 600, swept after AI_FILE_TTL_MS. Ids are random and unguessable; the
// signed link is still required to read one.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AI_FILE_TTL_MS = 15 * 60 * 1000;
const DIR = join(tmpdir(), "finance-feldart-ai-files");
const ID_RE = /^[A-Za-z0-9_-]{32}$/;

export function isAiFileId(id: string): boolean {
  return ID_RE.test(id);
}

async function sweep(now: number): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(DIR);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (n) => {
      try {
        const s = await stat(join(DIR, n));
        if (now - s.mtimeMs > AI_FILE_TTL_MS) await rm(join(DIR, n), { force: true });
      } catch {
        /* raced with another sweep */
      }
    }),
  );
}

export async function storeAiFile(bytes: Buffer, now = Date.now()): Promise<string> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  void sweep(now);
  const id = randomBytes(24).toString("base64url");
  await writeFile(join(DIR, id), bytes, { mode: 0o600 });
  return id;
}

/** The stored bytes, or null if unknown / expired. */
export async function readAiFile(id: string, now = Date.now()): Promise<Buffer | null> {
  if (!isAiFileId(id)) return null;
  try {
    const p = join(DIR, id);
    const s = await stat(p);
    if (now - s.mtimeMs > AI_FILE_TTL_MS) return null;
    return await readFile(p);
  } catch {
    return null;
  }
}
