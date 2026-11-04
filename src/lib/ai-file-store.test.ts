import { describe, expect, it } from "vitest";
import { AI_FILE_TTL_MS, isAiFileId, readAiFile, storeAiFile } from "./ai-file-store.js";

describe("ai file store", () => {
  it("stores bytes under an unguessable id and reads them back while fresh", async () => {
    const id = await storeAiFile(Buffer.from("%PDF-test"));
    expect(isAiFileId(id)).toBe(true);
    expect((await readAiFile(id))?.toString()).toBe("%PDF-test");
    expect(await readAiFile(id, Date.now() + AI_FILE_TTL_MS + 1000)).toBeNull();
  });
  it("never reads a path that isn't a store id", async () => {
    expect(await readAiFile("../../etc/passwd")).toBeNull();
    expect(await readAiFile("A".repeat(32))).toBeNull();
  });
});
