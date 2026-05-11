// One-shot — set the drive_root_folder_id app_settings row.
// Usage:  npx tsx scripts/set-drive-root-folder.ts <folder-id>
//
// The folder ID is the last segment of a Drive folder URL:
//   https://drive.google.com/drive/folders/<THIS-IS-THE-ID>

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { appSettings } from "../src/db/schema/app-settings.js";

async function main(): Promise<void> {
  const folderId = process.argv[2]?.trim();
  if (!folderId) {
    console.error("Usage: npx tsx scripts/set-drive-root-folder.ts <folder-id>");
    process.exit(1);
  }

  const existing = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "drive_root_folder_id"))
    .limit(1);

  if (existing[0]) {
    await db
      .update(appSettings)
      .set({ value: folderId, updatedAt: new Date() })
      .where(eq(appSettings.key, "drive_root_folder_id"));
    console.log(`Updated drive_root_folder_id to: ${folderId}`);
  } else {
    await db.insert(appSettings).values({
      key: "drive_root_folder_id",
      value: folderId,
      updatedAt: new Date(),
    });
    console.log(`Inserted drive_root_folder_id = ${folderId}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
