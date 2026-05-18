import { and, eq } from "drizzle-orm";
import sanitizeHtml from "sanitize-html";
import type { DB } from "../../db/index.js";
import { aliasSignatures } from "../../db/schema/alias-signatures.js";
import { userSignatures } from "../../db/schema/user-signatures.js";

const SIGNATURE_SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "b", "br", "div", "em", "font", "hr", "i", "img",
    "p", "small", "span", "strong",
    "table", "tbody", "td", "tfoot", "th", "thead", "tr",
    "u",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel", "style"],
    img: ["src", "alt", "width", "height", "style"],
    table: ["width", "cellpadding", "cellspacing", "border", "style", "align"],
    td: ["width", "valign", "align", "colspan", "rowspan", "style"],
    th: ["width", "valign", "align", "colspan", "rowspan", "style"],
    tr: ["style", "valign"],
    font: ["color", "face", "size"],
    "*": ["style"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: {
    img: ["http", "https", "cid", "data"],
  },
  allowedStyles: {
    "*": {
      color: [/^.+$/],
      "background-color": [/^.+$/],
      background: [/^.+$/],
      "font-family": [/^.+$/],
      "font-size": [/^\d+(\.\d+)?(px|em|rem|pt|%)$/],
      "font-weight": [/^.+$/],
      "font-style": [/^.+$/],
      "letter-spacing": [/^.+$/],
      "line-height": [/^.+$/],
      "text-align": [/^(left|right|center|justify)$/],
      "text-decoration": [/^.+$/],
      "text-transform": [/^.+$/],
      "white-space": [/^.+$/],
      opacity: [/^.+$/],

      padding: [/^.+$/],
      "padding-top": [/^.+$/],
      "padding-right": [/^.+$/],
      "padding-bottom": [/^.+$/],
      "padding-left": [/^.+$/],

      margin: [/^.+$/],
      "margin-top": [/^.+$/],
      "margin-right": [/^.+$/],
      "margin-bottom": [/^.+$/],
      "margin-left": [/^.+$/],

      border: [/^.+$/],
      "border-top": [/^.+$/],
      "border-right": [/^.+$/],
      "border-bottom": [/^.+$/],
      "border-left": [/^.+$/],
      "border-width": [/^.+$/],
      "border-style": [/^.+$/],
      "border-color": [/^.+$/],
      "border-radius": [/^.+$/],

      width: [/^.+$/],
      height: [/^.+$/],
      "min-width": [/^.+$/],
      "max-width": [/^.+$/],
      "vertical-align": [/^.+$/],
      display: [/^(block|inline|inline-block|table-cell|none)$/],
    },
  },
};

export const MAX_SIGNATURE_BYTES = 32 * 1024;

export function sanitizeSignatureHtml(input: string): string {
  return sanitizeHtml(input, SIGNATURE_SANITIZE_OPTS);
}

export function composeSignatureHtml(
  bodyHtml: string,
  userSig: string | null,
  aliasSig: string | null,
): string {
  const u = userSig && userSig.length > 0 ? `<br><br>${userSig}` : "";
  const a = aliasSig && aliasSig.length > 0 ? `<br><br>${aliasSig}` : "";
  return `${bodyHtml}${u}${a}`;
}

export type AppendContext = {
  bodyHtml: string;
  userId: string | null;
  aliasEmail: string;
  userSignatureId?: string;
  skipUserSignature?: boolean;
};

export async function appendSignatures(
  db: DB,
  ctx: AppendContext,
): Promise<string> {
  const userSig = await resolveUserSignature(db, ctx);
  const aliasSig = await resolveAliasSignature(db, ctx.aliasEmail);
  return composeSignatureHtml(ctx.bodyHtml, userSig, aliasSig);
}

async function resolveUserSignature(
  db: DB,
  ctx: AppendContext,
): Promise<string | null> {
  if (ctx.skipUserSignature) return null;
  if (!ctx.userId) return null;

  if (ctx.userSignatureId) {
    const rows = await db
      .select({ html: userSignatures.html })
      .from(userSignatures)
      .where(
        and(
          eq(userSignatures.id, ctx.userSignatureId),
          eq(userSignatures.userId, ctx.userId),
        ),
      )
      .limit(1);
    return rows[0]?.html ?? null;
  }

  const rows = await db
    .select({ html: userSignatures.html })
    .from(userSignatures)
    .where(
      and(
        eq(userSignatures.userId, ctx.userId),
        eq(userSignatures.isDefault, true),
      ),
    )
    .limit(1);
  return rows[0]?.html ?? null;
}

async function resolveAliasSignature(
  db: DB,
  aliasEmail: string,
): Promise<string | null> {
  const rows = await db
    .select({ html: aliasSignatures.html })
    .from(aliasSignatures)
    .where(eq(aliasSignatures.aliasEmail, aliasEmail.toLowerCase()))
    .limit(1);
  return rows[0]?.html ?? null;
}
