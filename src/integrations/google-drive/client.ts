// Google Drive client for RMA photo upload + folder management.
//
// Auth pattern mirrors src/integrations/gmail/client.ts exactly:
//   - Tokens stored in `oauth_tokens` table with provider="gmail" (Drive
//     uses the same Google OAuth flow; the drive.file scope was added in
//     Phase 2 Task 2).
//   - Tokens loaded by externalAccountId (= the Google account email) or
//     by the first gmail row when no ID is specified.
//   - On successful Drive API calls, googleapis emits "tokens" when it
//     refreshes; we persist the updated token back to the DB.
//
// Each exported function accepts `userId` (the app user's UUID) which is
// currently used only to satisfy the call signature — Drive operations
// use the shared Google OAuth token (single-mailbox setup), not per-user
// tokens. This parameter is reserved for future multi-user token routing.

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/index.js";
import { accounts } from "~/db/schema/auth.js";
import { oauthTokens } from "~/db/schema/oauth.js";
import { decrypt, encrypt } from "~/lib/crypto.js";
import { env } from "~/lib/env.js";
import { createLogger } from "~/lib/logger.js";

const log = createLogger({ module: "google-drive.client" });

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type DriveUploadResult = {
  fileId: string;
  viewUrl: string;
  thumbnailUrl: string | null;
  mimeType: string;
  sizeBytes: number;
};

// ---------------------------------------------------------------------------
// Internal token helpers (shared with Gmail — same table, same provider)
// ---------------------------------------------------------------------------

type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  externalAccountId: string;
};

// Where a token came from decides which Google OAuth client can refresh it.
// Refresh tokens are bound to the client that issued them: rows in the
// Auth.js `account` table were minted by the sign-in client
// (AUTH_GOOGLE_CLIENT_ID); rows in `oauth_tokens` by the Gmail client
// (GOOGLE_CLIENT_ID). Refreshing with the wrong one makes Google answer
// `unauthorized_client` — which is exactly why every prod photo upload
// 502'd from launch until 2026-09-14.
type TokenSource = "account" | "oauth_tokens";

type StoredToken = {
  source: TokenSource;
  rowId: string;
  externalAccountId: string;
  tokens: TokenSet;
};

// Either scope is sufficient: `drive.file` is the minimal per-file scope;
// `drive` is the full Drive scope. Both let us upload + manage files via
// the Drive API.
const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
];
const TOKEN_REFRESH_LEAD_MS = 60_000;

function buildOAuth2Client(source: TokenSource): OAuth2Client {
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  if (source === "account") {
    return new google.auth.OAuth2(
      env.AUTH_GOOGLE_CLIENT_ID,
      env.AUTH_GOOGLE_CLIENT_SECRET,
      `${base}/api/auth/callback/google`,
    );
  }
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${base}/oauth/callback/gmail`,
  );
}

function tokenHasDriveScope(scope: string | null): boolean {
  if (!scope) return false;
  const granted = scope.split(/\s+/).filter(Boolean);
  return DRIVE_SCOPES.some((s) => granted.includes(s));
}

type AccountRow = typeof accounts.$inferSelect;

// An `account` row can drive uploads only if it carries offline access AND
// a Drive scope. Staff who signed in before the drive scope was added to
// the consent screen have a row with neither, so we skip those.
function accountRowUsableForDrive(
  row: AccountRow,
): row is AccountRow & { access_token: string; refresh_token: string } {
  return (
    !!row.access_token && !!row.refresh_token && tokenHasDriveScope(row.scope ?? null)
  );
}

function storedTokenFromAccountRow(
  row: AccountRow & { access_token: string; refresh_token: string },
): StoredToken {
  return {
    source: "account",
    rowId: row.providerAccountId,
    externalAccountId: row.providerAccountId,
    tokens: {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at != null ? new Date(row.expires_at * 1000) : null,
      scope: row.scope ?? null,
      externalAccountId: row.providerAccountId,
    },
  };
}

async function loadStoredToken(userId?: string): Promise<StoredToken | null> {
  // 1. The signed-in user's own Auth.js `account` row (provider=google).
  //    Signing in grants the full drive scope (see plugins/auth.ts), so
  //    this is the normal source.
  if (userId) {
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, "google")))
      .limit(1);
    const own = rows[0];
    if (own && accountRowUsableForDrive(own)) {
      return storedTokenFromAccountRow(own);
    }
  }

  // 2. Any staff member's Drive grant. The returns photo tree is one shared
  //    folder, so whose token performs the upload doesn't matter — this
  //    keeps uploads working for teammates whose own sign-in predates the
  //    drive scope, instead of bouncing them to "sign out and back in".
  const staffRows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.provider, "google"))
    .limit(50);
  const staff = staffRows.find(accountRowUsableForDrive);
  if (staff) {
    return storedTokenFromAccountRow(staff);
  }

  // 3. Legacy oauth_tokens row (used by Gmail polling).
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.provider, "gmail"))
    .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt) return null;
  if (row.externalAccountId.startsWith("pending:")) return null;

  return {
    source: "oauth_tokens",
    rowId: row.id,
    externalAccountId: row.externalAccountId,
    tokens: {
      accessToken: decrypt(row.accessTokenEnc),
      refreshToken: row.refreshTokenEnc ? decrypt(row.refreshTokenEnc) : null,
      expiresAt: row.expiresAt,
      scope: row.scope,
      externalAccountId: row.externalAccountId,
    },
  };
}

async function persistToken(stored: StoredToken, tokens: TokenSet): Promise<void> {
  if (stored.source === "account") {
    // Auth.js rows keep raw tokens + unix-second expiry.
    await db
      .update(accounts)
      .set({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt ? Math.floor(tokens.expiresAt.getTime() / 1000) : null,
        scope: tokens.scope,
      })
      .where(
        and(eq(accounts.provider, "google"), eq(accounts.providerAccountId, stored.rowId)),
      );
    return;
  }
  await db
    .update(oauthTokens)
    .set({
      externalAccountId: stored.externalAccountId,
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    })
    .where(eq(oauthTokens.id, stored.rowId));
}

// ---------------------------------------------------------------------------
// Build an authenticated OAuth2Client for Drive calls
// ---------------------------------------------------------------------------

async function getDriveClient(userId?: string): Promise<ReturnType<typeof google.drive>> {
  const stored = await loadStoredToken(userId);
  if (!stored) {
    throw new Error(
      "Drive not authenticated. Sign out and sign back in via Google to grant photo upload permission.",
    );
  }
  if (!stored.tokens.refreshToken) {
    throw new Error(
      "Drive token has no refresh_token — re-auth required to obtain offline access.",
    );
  }
  if (!tokenHasDriveScope(stored.tokens.scope)) {
    throw new Error(
      "Drive not authorized — sign out and sign back in to grant photo upload permission.",
    );
  }

  const oauth = buildOAuth2Client(stored.source);
  oauth.setCredentials({
    access_token: stored.tokens.accessToken,
    refresh_token: stored.tokens.refreshToken,
    expiry_date: stored.tokens.expiresAt ? stored.tokens.expiresAt.getTime() : undefined,
    scope: stored.tokens.scope ?? undefined,
  });

  oauth.on("tokens", (next) => {
    void (async () => {
      try {
        const merged: TokenSet = {
          accessToken: next.access_token ?? stored.tokens.accessToken,
          refreshToken: next.refresh_token ?? stored.tokens.refreshToken,
          expiresAt: next.expiry_date
            ? new Date(next.expiry_date)
            : stored.tokens.expiresAt,
          scope: next.scope ?? stored.tokens.scope,
          externalAccountId: stored.externalAccountId,
        };
        await persistToken(stored, merged);
        log.debug({ externalAccountId: stored.externalAccountId }, "drive tokens refreshed");
      } catch (err) {
        log.error({ err }, "failed to persist refreshed Drive tokens");
      }
    })();
  });

  // Eagerly refresh if the access token is within the lead window.
  if (
    stored.tokens.expiresAt &&
    stored.tokens.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_LEAD_MS
  ) {
    await oauth.getAccessToken();
  }

  return google.drive({ version: "v3", auth: oauth });
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Upload a file into a Drive folder.
 * Returns metadata needed to populate the rma_photos row.
 */
export async function uploadFile(input: {
  userId: string;
  folderId: string;
  filename: string;
  mimeType: string;
  content: Buffer | NodeJS.ReadableStream;
}): Promise<DriveUploadResult> {
  const drive = await getDriveClient(input.userId);
  const { folderId, filename, mimeType, content } = input;

  // googleapis expects `media.body` to be a Readable stream (not a Buffer).
  // multer's memoryStorage gives us a Buffer, so wrap it.
  const body = Buffer.isBuffer(content) ? Readable.from(content) : content;

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      mimeType,
    },
    media: {
      mimeType,
      body,
    },
    fields: "id,webViewLink,thumbnailLink,mimeType,size",
    supportsAllDrives: true,
  });

  const file = res.data;
  if (!file.id) throw new Error("Drive upload returned no file id");

  return {
    fileId: file.id,
    viewUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    thumbnailUrl: file.thumbnailLink ?? null,
    mimeType: file.mimeType ?? mimeType,
    sizeBytes: Number(file.size ?? 0),
  };
}

/**
 * Delete a file from Drive.
 * Silently swallows 404 (file already gone).
 */
export async function deleteFile(input: {
  userId: string;
  fileId: string;
}): Promise<void> {
  const drive = await getDriveClient(input.userId);
  try {
    await drive.files.delete({ fileId: input.fileId, supportsAllDrives: true });
  } catch (err) {
    const status = (err as { code?: number; response?: { status?: number } })?.response?.status
      ?? (err as { code?: number })?.code;
    if (status === 404) {
      log.warn({ fileId: input.fileId }, "Drive file already deleted — ignoring 404");
      return;
    }
    throw err;
  }
}

/**
 * Delete a folder from Drive. Folders in Drive are themselves files with a
 * folder MIME type, so this is a thin wrapper around the same `files.delete`
 * call as `deleteFile` — kept as a separate export for caller readability.
 *
 * Drive treats folder delete as a recursive trash by default — children are
 * deleted along with the folder. Silently swallows 404 (folder already gone)
 * so callers can call this best-effort during RMA cleanup.
 */
export async function deleteFolder(input: {
  userId: string;
  folderId: string;
}): Promise<void> {
  const drive = await getDriveClient(input.userId);
  try {
    await drive.files.delete({ fileId: input.folderId, supportsAllDrives: true });
  } catch (err) {
    const status = (err as { code?: number; response?: { status?: number } })?.response?.status
      ?? (err as { code?: number })?.code;
    if (status === 404) {
      log.warn({ folderId: input.folderId }, "Drive folder already deleted — ignoring 404");
      return;
    }
    throw err;
  }
}

/**
 * Ensure a folder exists inside `parentId` with the given `name`.
 * If the folder already exists, return its ID. Otherwise create it.
 */
export async function ensureFolder(input: {
  userId: string;
  parentId: string;
  name: string;
}): Promise<string> {
  const drive = await getDriveClient(input.userId);
  const { parentId, name } = input;

  // Search for an existing folder with this name under the parent.
  const listRes = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: "files(id,name)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existing = listRes.data.files?.[0];
  if (existing?.id) {
    log.debug({ name, parentId, folderId: existing.id }, "drive folder already exists");
    return existing.id;
  }

  // Create the folder.
  const createRes = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
    supportsAllDrives: true,
  });

  const folderId = createRes.data.id;
  if (!folderId) throw new Error(`Failed to create Drive folder "${name}"`);
  log.info({ name, parentId, folderId }, "drive folder created");
  return folderId;
}

/**
 * Rename a Drive folder.
 */
export async function renameFolder(input: {
  userId: string;
  folderId: string;
  newName: string;
}): Promise<void> {
  const drive = await getDriveClient(input.userId);
  await drive.files.update({
    fileId: input.folderId,
    requestBody: { name: input.newName },
  });
  log.info({ folderId: input.folderId, newName: input.newName }, "drive folder renamed");
}

/**
 * Grant anyone-with-link read access to a file (so thumbnails/view URLs work
 * for users who aren't signed into Google).
 */
export async function makeViewable(input: {
  userId: string;
  fileId: string;
}): Promise<void> {
  const drive = await getDriveClient(input.userId);
  await drive.permissions.create({
    fileId: input.fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });
  log.debug({ fileId: input.fileId }, "drive file made publicly viewable");
}

/**
 * Download the binary content of a Drive file.
 * Returns a Buffer. Caller handles MIME type detection.
 */
export async function downloadFileContent(input: {
  userId: string;
  fileId: string;
}): Promise<Buffer> {
  const drive = await getDriveClient(input.userId);
  const res = await drive.files.get(
    { fileId: input.fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
  const data = res.data as ArrayBuffer;
  return Buffer.from(data);
}
