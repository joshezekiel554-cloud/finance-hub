# Email Signatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add layered email signatures (per-user personal sign-off + per-alias organisation block) auto-appended to every outbound human-initiated send; cron sends get alias signature only.

**Architecture:** Two new tables (`user_signatures`, `alias_signatures`) with a CRUD route surface, one server-side sanitizer (`sanitize-html`), one pure compose helper, and a thin `appendSignatures(db, ctx)` wrapper. Every existing send route + the chase cron job calls `appendSignatures` once, right before `sendEmail()`. Frontend gets a reusable `<SignaturePicker>` dropdown for compose dialogs, a `<SignatureEditor>` modal, and two new Settings cards.

**Tech Stack:** Drizzle ORM (MySQL 8) + drizzle-kit migrations, Fastify v5 + Zod route validation, `sanitize-html`, vitest, React 18 + TanStack Query + Radix Dialog + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-05-18-email-signatures-design.md`

---

## Spec adaptations

The spec was written against an idealised schema. These deviations apply because the codebase pre-dates the spec:

1. **ID type:** `VARCHAR(24)` with `nanoid(24)` (not `BIGINT AUTO_INCREMENT`). Matches every other table in this repo (`email_templates`, `audit_log`, `customers`, etc.).
2. **`users.id` FK target:** `VARCHAR(255)` (Auth.js stores UUIDs). Spec said `BIGINT` — replace everywhere user FKs appear.
3. **User-table name:** the MySQL table is `"user"` (singular, Auth.js convention) but the Drizzle export is `users`.
4. **Character counter cap:** **32 KB everywhere.** Spec §3 hardened the cap to 32 KB to fit base64 icons; §7 still referenced 16 KB — resolved to 32 KB so UI matches the server's 413 boundary.
5. **E2E tests:** deferred — Playwright is not configured in the repo. Replaced by an explicit **Manual smoke checklist** (see end).
6. **Import paths:** server imports use `.js` extensions on relative paths (post-build resolution); follow the pattern in `src/server/routes/email-templates.ts`.
7. **Task 6d (invoicing) is N/A** — invoices send through QBO's own `/invoice/{id}/send` and `/salesreceipt/{id}/send` endpoints. QBO renders the body server-side; finance-hub never constructs an HTML body for invoice sends. Signatures cannot be appended without refactoring invoice send off QBO and onto Gmail (which would lose QBO's tracked EmailSent status + DeliveryInfo). Out of scope for this feature. Task marked complete-as-no-op.

---

## File structure

**Create:**
- `src/db/schema/user-signatures.ts` — Drizzle table for per-user signatures
- `src/db/schema/alias-signatures.ts` — Drizzle table for per-alias signatures
- `src/modules/email-compose/signatures.ts` — sanitizer + `composeSignatureHtml` (pure) + `appendSignatures` (DB-bound)
- `src/modules/email-compose/signatures.test.ts` — unit tests
- `src/server/routes/signatures.ts` — `/api/me/signatures` + `/api/alias-signatures` CRUD
- `src/server/routes/signatures.test.ts` — route validation tests
- `src/web/components/signature-editor.tsx` — modal with `<textarea>` + sandboxed iframe preview
- `src/web/components/signature-picker.tsx` — shared `<select>` dropdown
- `scripts/seed-alias-signatures-from-gmail.ts` — one-shot pre-population from `sendAs.signature`
- `migrations/0034_email_signatures.sql` — auto-generated; commit verbatim

**Modify:**
- `src/db/schema/index.ts` — re-export the two new schema files
- `src/db/relations.ts` — wire `usersRelations.userSignatures` many-relation
- `src/server/routes/index.ts` — register the new route plugin
- `src/server/routes/email-send.ts` — accept `userSignatureId` in body, call `appendSignatures`
- `src/server/routes/chase.ts` — same
- `src/server/routes/statements.ts` — same
- `src/server/routes/invoicing.ts` — same (in `send-invoice` handler)
- `src/server/routes/returns.ts` — same (in `send-approval` and `send-denial` handlers)
- `src/modules/statements/send.ts` — call `appendSignatures` before delegating to `sendEmail`
- `src/jobs/definitions/chase-digest.ts` — call `appendSignatures` with `userId: null`
- `src/web/components/compose-modal.tsx` — render `<SignaturePicker>`, include `userSignatureId` in payload
- `src/web/components/chase-email-send-dialog.tsx` — same
- `src/web/components/rma-approval-email-dialog.tsx` — same
- `src/web/components/rma-denial-email-dialog.tsx` — same
- `src/web/pages/settings.tsx` — add `<MySignaturesSection>` and `<AliasSignaturesSection>` cards

Each task below produces a self-contained commit on `feat/email-signatures`.

---

## Task 1: Drizzle schema + relations

**Files:**
- Create: `src/db/schema/user-signatures.ts`
- Create: `src/db/schema/alias-signatures.ts`
- Modify: `src/db/schema/index.ts`
- Modify: `src/db/relations.ts`

- [ ] **Step 1: Create `user-signatures.ts`**

```ts
// src/db/schema/user-signatures.ts
import {
  boolean,
  index,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const userSignatures = mysqlTable(
  "user_signatures",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    userId: varchar("user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    html: text("html").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .onUpdateNow(),
  },
  (t) => ({
    userIdx: index("idx_user_signatures_user").on(t.userId),
    defaultIdx: index("idx_user_signatures_default").on(t.userId, t.isDefault),
  }),
);

export type UserSignature = typeof userSignatures.$inferSelect;
export type NewUserSignature = typeof userSignatures.$inferInsert;
```

- [ ] **Step 2: Create `alias-signatures.ts`**

```ts
// src/db/schema/alias-signatures.ts
import {
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const aliasSignatures = mysqlTable("alias_signatures", {
  aliasEmail: varchar("alias_email", { length: 254 }).primaryKey(),
  html: text("html").notNull(),
  updatedByUserId: varchar("updated_by_user_id", { length: 255 }).references(
    () => users.id,
    { onDelete: "set null" },
  ),
  updatedAt: timestamp("updated_at").defaultNow().notNull().onUpdateNow(),
});

export type AliasSignature = typeof aliasSignatures.$inferSelect;
export type NewAliasSignature = typeof aliasSignatures.$inferInsert;
```

- [ ] **Step 3: Wire exports in `src/db/schema/index.ts`**

Add (alphabetical-ish, near the other email exports):

```ts
export * from "./email-templates";
export * from "./email-routing-rules";
export * from "./user-signatures";       // NEW
export * from "./alias-signatures";      // NEW
```

- [ ] **Step 4: Add `usersRelations.userSignatures` many-relation in `src/db/relations.ts`**

Locate `usersRelations` and add `userSignatures`:

```ts
import { userSignatures } from "./schema/user-signatures";
// ...
export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  auditLog: many(auditLog),
  // ... existing
  userSignatures: many(userSignatures),  // NEW
}));

export const userSignaturesRelations = relations(userSignatures, ({ one }) => ({
  user: one(users, { fields: [userSignatures.userId], references: [users.id] }),
}));
```

`aliasSignatures` does not need a `relations()` export — it has no children and `updatedByUserId` is rarely joined.

- [ ] **Step 5: Type-check**

Run: `npm run build` (or `npm run typecheck` if defined — check `package.json` scripts)
Expected: PASS. Any error here means schema/relations are misshapen — fix before generating migration.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/user-signatures.ts src/db/schema/alias-signatures.ts \
        src/db/schema/index.ts src/db/relations.ts
git commit -m "Email signatures: drizzle schema + relations"
```

---

## Task 2: Generate + verify migration

**Files:**
- Create: `migrations/0034_email_signatures.sql` (drizzle-kit output)

- [ ] **Step 1: Generate migration**

Run: `npm run db:generate`
Expected: drizzle-kit emits `migrations/0034_<word>.sql` (number auto-increments from 0033). The journal `migrations/meta/_journal.json` updates.

- [ ] **Step 2: Inspect the SQL**

Run: read the generated file. Confirm it contains:
- `CREATE TABLE \`user_signatures\` (...)` with all columns, `PRIMARY KEY (\`id\`)`, the two `INDEX` lines, and the FK `CONSTRAINT ... FOREIGN KEY (\`user_id\`) REFERENCES \`user\`(\`id\`) ON DELETE CASCADE`
- `CREATE TABLE \`alias_signatures\` (...)` with `PRIMARY KEY (\`alias_email\`)` and the FK `... ON DELETE SET NULL`

If drizzle-kit generated something unexpected (e.g. a `DROP TABLE`, or renamed an existing table because of a misedit), STOP — fix Task 1 instead of hand-editing this file.

- [ ] **Step 3: (Optional) rename for clarity**

drizzle-kit gives it a random word suffix. Rename to `0034_email_signatures.sql` for human-readability and update `migrations/meta/_journal.json`'s `tag` field accordingly. Skip if local convention is to leave random names (check existing migrations — most do use descriptive names like `0032_invoice_bcc_forwards.sql`).

- [ ] **Step 4: Apply locally to confirm valid SQL**

Run: `npm run db:migrate`
Expected: completes without error. Connect to your local MySQL and confirm `SHOW CREATE TABLE user_signatures;` and `SHOW CREATE TABLE alias_signatures;` both match the spec.

- [ ] **Step 5: Commit**

```bash
git add migrations/0034_email_signatures.sql migrations/meta/_journal.json
git commit -m "Email signatures: migration 0034"
```

---

## Task 3: Sanitizer (TDD)

**Files:**
- Create: `src/modules/email-compose/signatures.ts`
- Create: `src/modules/email-compose/signatures.test.ts`

- [ ] **Step 1: Write failing sanitizer tests**

```ts
// src/modules/email-compose/signatures.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeSignatureHtml } from "./signatures";

describe("sanitizeSignatureHtml", () => {
  it("strips <script> tags", () => {
    const input = `<div>hi</div><script>alert(1)</script>`;
    expect(sanitizeSignatureHtml(input)).toBe(`<div>hi</div>`);
  });

  it("strips on* attributes", () => {
    const input = `<a href="https://x.com" onclick="alert(1)">x</a>`;
    expect(sanitizeSignatureHtml(input)).toBe(
      `<a href="https://x.com">x</a>`,
    );
  });

  it("preserves data: URLs inside <img src> but not <a href>", () => {
    const img = `<img src="data:image/png;base64,iVBORw0KGgo=" alt="x" />`;
    expect(sanitizeSignatureHtml(img)).toContain(`src="data:image/png;base64,`);

    const link = `<a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">x</a>`;
    expect(sanitizeSignatureHtml(link)).not.toContain("data:");
  });

  it("preserves mailto: and tel: links", () => {
    expect(sanitizeSignatureHtml(`<a href="mailto:x@y.com">x</a>`)).toBe(
      `<a href="mailto:x@y.com">x</a>`,
    );
    expect(sanitizeSignatureHtml(`<a href="tel:+441234567890">call</a>`)).toBe(
      `<a href="tel:+441234567890">call</a>`,
    );
  });

  it("preserves inline color style", () => {
    const input = `<span style="color: red">x</span>`;
    expect(sanitizeSignatureHtml(input)).toContain(`color:red`);
  });

  it("preserves table layout with border-right inline style", () => {
    const input = `<table><tr><td style="border-right: 1px solid #ccc">A</td><td>B</td></tr></table>`;
    const out = sanitizeSignatureHtml(input);
    expect(out).toContain(`<table>`);
    expect(out).toContain(`border-right:1px solid #ccc`);
  });

  it("strips <style> blocks but keeps adjacent inline styles", () => {
    const input = `<style>.x{color:red}</style><div style="color:blue">x</div>`;
    const out = sanitizeSignatureHtml(input);
    expect(out).not.toContain("<style>");
    expect(out).toContain(`color:blue`);
  });

  it("strips javascript: in href", () => {
    expect(
      sanitizeSignatureHtml(`<a href="javascript:alert(1)">x</a>`),
    ).not.toContain("javascript:");
  });

  it("preserves min-width and opacity (used by real signatures)", () => {
    const input = `<div style="min-width: 100px; opacity: 0.8">x</div>`;
    const out = sanitizeSignatureHtml(input);
    expect(out).toContain("min-width:100px");
    expect(out).toContain("opacity:0.8");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run src/modules/email-compose/signatures.test.ts`
Expected: FAIL with `Cannot find module './signatures'`.

- [ ] **Step 3: Implement `sanitizeSignatureHtml`**

```ts
// src/modules/email-compose/signatures.ts
import sanitizeHtml from "sanitize-html";

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
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run src/modules/email-compose/signatures.test.ts`
Expected: 9 pass.

- [ ] **Step 5: Smoke against real signature**

This is a verification, not an automated test (the file is on disk at `C:\Users\user\Desktop\signature7.html` — outside the repo, not appropriate to commit). Skip if file missing. Otherwise:

```ts
// Throwaway one-liner in node REPL:
// const raw = require('fs').readFileSync('C:/Users/user/Desktop/signature7.html', 'utf8');
// const { sanitizeSignatureHtml } = require('./dist/modules/email-compose/signatures');
// console.log(sanitizeSignatureHtml(raw).length, 'vs input', raw.length);
```
Expected: output length within ~150 bytes of input (sanitize-html normalizes whitespace inside style attributes). If output is dramatically smaller, a property regex is too tight — investigate before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/modules/email-compose/signatures.ts src/modules/email-compose/signatures.test.ts
git commit -m "Email signatures: sanitizer (sanitize-html config + tests)"
```

---

## Task 4: Compose helper + appendSignatures (TDD)

**Files:**
- Modify: `src/modules/email-compose/signatures.ts`
- Modify: `src/modules/email-compose/signatures.test.ts`

- [ ] **Step 1: Add failing tests for `composeSignatureHtml`**

Append to `signatures.test.ts`:

```ts
import { composeSignatureHtml } from "./signatures";

describe("composeSignatureHtml", () => {
  const body = `<p>Hello</p>`;
  const userSig = `<div>Best, Josh</div>`;
  const aliasSig = `<div>Feldart Ltd</div>`;

  it("returns body alone when no signatures", () => {
    expect(composeSignatureHtml(body, null, null)).toBe(body);
  });

  it("appends user sig with spacer", () => {
    expect(composeSignatureHtml(body, userSig, null)).toBe(
      `${body}<br><br>${userSig}`,
    );
  });

  it("appends alias sig with spacer", () => {
    expect(composeSignatureHtml(body, null, aliasSig)).toBe(
      `${body}<br><br>${aliasSig}`,
    );
  });

  it("appends both with user before alias", () => {
    expect(composeSignatureHtml(body, userSig, aliasSig)).toBe(
      `${body}<br><br>${userSig}<br><br>${aliasSig}`,
    );
  });

  it("treats empty-string sig as no sig (sanitizer can return empty)", () => {
    expect(composeSignatureHtml(body, "", aliasSig)).toBe(
      `${body}<br><br>${aliasSig}`,
    );
  });
});
```

- [ ] **Step 2: Run tests — confirm fail**

Run: `npx vitest run src/modules/email-compose/signatures.test.ts`
Expected: FAIL with `composeSignatureHtml is not a function`.

- [ ] **Step 3: Implement `composeSignatureHtml`**

Append to `signatures.ts`:

```ts
export function composeSignatureHtml(
  bodyHtml: string,
  userSig: string | null,
  aliasSig: string | null,
): string {
  const u = userSig && userSig.length > 0 ? `<br><br>${userSig}` : "";
  const a = aliasSig && aliasSig.length > 0 ? `<br><br>${aliasSig}` : "";
  return `${bodyHtml}${u}${a}`;
}
```

- [ ] **Step 4: Run tests — confirm pass**

Run: `npx vitest run src/modules/email-compose/signatures.test.ts`
Expected: all pass.

- [ ] **Step 5: Add `appendSignatures` (DB-bound wrapper)**

Append to `signatures.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { DB } from "../../db/index.js";
import { userSignatures } from "../../db/schema/user-signatures.js";
import { aliasSignatures } from "../../db/schema/alias-signatures.js";

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
```

- [ ] **Step 6: Type-check**

Run: `npm run build` (or `tsc --noEmit`)
Expected: PASS.

`appendSignatures` is not unit-tested in isolation — it's exercised end-to-end via the route + integration paths in later tasks. The pure `composeSignatureHtml` covers the branching logic; the DB layer is the trivial part.

- [ ] **Step 7: Commit**

```bash
git add src/modules/email-compose/signatures.ts src/modules/email-compose/signatures.test.ts
git commit -m "Email signatures: appendSignatures + composeSignatureHtml"
```

---

## Task 5: User-signatures CRUD route

**Files:**
- Create: `src/server/routes/signatures.ts`
- Create: `src/server/routes/signatures.test.ts`
- Modify: `src/server/routes/index.ts`

- [ ] **Step 1: Create the route file with user-signature handlers**

```ts
// src/server/routes/signatures.ts
import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db/index.js";
import { userSignatures } from "../../db/schema/user-signatures.js";
import { aliasSignatures } from "../../db/schema/alias-signatures.js";
import { users } from "../../db/schema/auth.js";
import { auditLog } from "../../db/schema/audit.js";
import {
  MAX_SIGNATURE_BYTES,
  sanitizeSignatureHtml,
} from "../../modules/email-compose/signatures.js";
import { requireAuth } from "../lib/auth.js";

const createUserSigSchema = z.object({
  name: z.string().min(1).max(64),
  html: z.string().min(0).max(MAX_SIGNATURE_BYTES),
  isDefault: z.boolean().optional(),
});

const patchUserSigSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  html: z.string().min(0).max(MAX_SIGNATURE_BYTES).optional(),
  isDefault: z.boolean().optional(),
});

const patchAliasSigSchema = z.object({
  html: z.string().min(0).max(MAX_SIGNATURE_BYTES),
});

const signaturesRoute: FastifyPluginAsync = async (app) => {
  // ----- User signatures (per current user) -----

  app.get("/me/signatures", async (req, reply) => {
    const user = await requireAuth(req);
    const rows = await db
      .select()
      .from(userSignatures)
      .where(eq(userSignatures.userId, user.id))
      .orderBy(desc(userSignatures.isDefault), asc(userSignatures.name));
    return reply.send({ rows });
  });

  app.post("/me/signatures", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = createUserSigSchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(parse.error.issues.some((i) => i.code === "too_big") ? 413 : 400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const sanitizedHtml = sanitizeSignatureHtml(parse.data.html);
    const id = nanoid(24);
    const isDefault = parse.data.isDefault ?? false;

    await db.transaction(async (tx) => {
      if (isDefault) {
        await tx
          .update(userSignatures)
          .set({ isDefault: false })
          .where(eq(userSignatures.userId, user.id));
      }
      await tx.insert(userSignatures).values({
        id,
        userId: user.id,
        name: parse.data.name,
        html: sanitizedHtml,
        isDefault,
      });
      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "user_signature.create",
        entityType: "user_signature",
        entityId: id,
        before: null,
        after: { name: parse.data.name, isDefault },
      });
    });

    const rows = await db
      .select()
      .from(userSignatures)
      .where(eq(userSignatures.id, id))
      .limit(1);
    return reply.send({ row: rows[0] });
  });

  app.patch("/me/signatures/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const parse = patchUserSigSchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(parse.error.issues.some((i) => i.code === "too_big") ? 413 : 400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }

    const beforeRows = await db
      .select()
      .from(userSignatures)
      .where(
        and(eq(userSignatures.id, id), eq(userSignatures.userId, user.id)),
      )
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "signature not found" });

    const update: Partial<typeof before> = {};
    if (parse.data.name !== undefined) update.name = parse.data.name;
    if (parse.data.html !== undefined) {
      update.html = sanitizeSignatureHtml(parse.data.html);
    }
    if (parse.data.isDefault !== undefined) update.isDefault = parse.data.isDefault;

    await db.transaction(async (tx) => {
      if (parse.data.isDefault === true) {
        await tx
          .update(userSignatures)
          .set({ isDefault: false })
          .where(eq(userSignatures.userId, user.id));
      }
      await tx
        .update(userSignatures)
        .set(update)
        .where(eq(userSignatures.id, id));
      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "user_signature.update",
        entityType: "user_signature",
        entityId: id,
        before: { name: before.name, isDefault: before.isDefault },
        after: { ...before, ...update },
      });
    });

    const afterRows = await db
      .select()
      .from(userSignatures)
      .where(eq(userSignatures.id, id))
      .limit(1);
    return reply.send({ row: afterRows[0] });
  });

  app.delete("/me/signatures/:id", async (req, reply) => {
    const user = await requireAuth(req);
    const id = (req.params as { id: string }).id;
    const beforeRows = await db
      .select()
      .from(userSignatures)
      .where(
        and(eq(userSignatures.id, id), eq(userSignatures.userId, user.id)),
      )
      .limit(1);
    const before = beforeRows[0];
    if (!before) return reply.code(404).send({ error: "signature not found" });

    await db.transaction(async (tx) => {
      await tx.delete(userSignatures).where(eq(userSignatures.id, id));
      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "user_signature.delete",
        entityType: "user_signature",
        entityId: id,
        before: { name: before.name, isDefault: before.isDefault },
        after: null,
      });
    });

    return reply.send({ ok: true });
  });

  // ----- Alias signatures (shared) -----

  app.get("/alias-signatures", async (req, reply) => {
    await requireAuth(req);
    const rows = await db
      .select({
        aliasEmail: aliasSignatures.aliasEmail,
        html: aliasSignatures.html,
        updatedByUserId: aliasSignatures.updatedByUserId,
        updatedAt: aliasSignatures.updatedAt,
        updatedByEmail: users.email,
      })
      .from(aliasSignatures)
      .leftJoin(users, eq(users.id, aliasSignatures.updatedByUserId))
      .orderBy(asc(aliasSignatures.aliasEmail));
    return reply.send({ rows });
  });

  app.patch("/alias-signatures/:email", async (req, reply) => {
    const user = await requireAuth(req);
    const aliasEmail = decodeURIComponent(
      (req.params as { email: string }).email,
    ).toLowerCase();
    const parse = patchAliasSigSchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(parse.error.issues.some((i) => i.code === "too_big") ? 413 : 400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const sanitizedHtml = sanitizeSignatureHtml(parse.data.html);

    const beforeRows = await db
      .select()
      .from(aliasSignatures)
      .where(eq(aliasSignatures.aliasEmail, aliasEmail))
      .limit(1);
    const before = beforeRows[0] ?? null;

    if (before) {
      await db
        .update(aliasSignatures)
        .set({ html: sanitizedHtml, updatedByUserId: user.id })
        .where(eq(aliasSignatures.aliasEmail, aliasEmail));
    } else {
      await db.insert(aliasSignatures).values({
        aliasEmail,
        html: sanitizedHtml,
        updatedByUserId: user.id,
      });
    }

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: before ? "alias_signature.update" : "alias_signature.create",
      entityType: "alias_signature",
      entityId: aliasEmail,
      before: before ? { html: before.html } : null,
      after: { html: sanitizedHtml },
    });

    const afterRows = await db
      .select()
      .from(aliasSignatures)
      .where(eq(aliasSignatures.aliasEmail, aliasEmail))
      .limit(1);
    return reply.send({ row: afterRows[0] });
  });
};

export default signaturesRoute;
```

- [ ] **Step 2: Register the route**

Modify `src/server/routes/index.ts`. Add import and registration alongside the other route plugins:

```ts
import signaturesRoute from "./signatures.js";
// ...
await app.register(signaturesRoute, { prefix: "/api" });
```

The `/me/signatures` and `/alias-signatures` paths are prefixed with `/api` via the registration.

- [ ] **Step 3: Write Zod-level validation tests**

```ts
// src/server/routes/signatures.test.ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_SIGNATURE_BYTES } from "../../modules/email-compose/signatures.js";

const createUserSigSchema = z.object({
  name: z.string().min(1).max(64),
  html: z.string().min(0).max(MAX_SIGNATURE_BYTES),
  isDefault: z.boolean().optional(),
});

describe("signatures route validation", () => {
  it("rejects empty name", () => {
    const r = createUserSigSchema.safeParse({ name: "", html: "x" });
    expect(r.success).toBe(false);
  });

  it("accepts 32 KB html (boundary)", () => {
    const html = "a".repeat(MAX_SIGNATURE_BYTES);
    const r = createUserSigSchema.safeParse({ name: "x", html });
    expect(r.success).toBe(true);
  });

  it("rejects 32 KB + 1 html with too_big code", () => {
    const html = "a".repeat(MAX_SIGNATURE_BYTES + 1);
    const r = createUserSigSchema.safeParse({ name: "x", html });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === "too_big")).toBe(true);
    }
  });

  it("rejects 65-char name", () => {
    const r = createUserSigSchema.safeParse({
      name: "x".repeat(65),
      html: "x",
    });
    expect(r.success).toBe(false);
  });
});
```

Reason for schema-level rather than integration: this codebase has no Fastify route-test harness yet (no `tap` / supertest / mock-app setup in the repo as of this plan). A full route test would mean either spinning up the real Fastify app (slow + needs a test DB) or building one. Pure Zod-schema tests cover the parsing rules the handler relies on. The `audit_log + transaction` flow gets validated by the manual smoke pass at the end.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/server/routes/signatures.test.ts src/modules/email-compose/signatures.test.ts`
Expected: all pass.

- [ ] **Step 5: Type-check + start server**

Run: `npm run build` then `npm run dev:server`
Expected: server starts without error. Hit `curl http://localhost:3001/api/me/signatures` from another shell — it returns 401 (no auth). Stop the server.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/signatures.ts src/server/routes/signatures.test.ts \
        src/server/routes/index.ts
git commit -m "Email signatures: CRUD routes + Zod validation tests"
```

---

## Task 6: Wire send-path call sites

Each send route + the cron job needs:
1. Body schema gains `userSignatureId: string | null` (optional, only for human-initiated routes; the cron job has no request body).
2. Right before `sendEmail({ html, ... })`, call `appendSignatures(db, { bodyHtml: html, userId, aliasEmail, userSignatureId, skipUserSignature })` and pass the result as `html`.

Each sub-task below is **file-disjoint** — they can be parallelised across subagents per `feedback_finance-hub-workflow`. If executing inline, do them in order.

### Task 6a: email-send.ts (compose modal)

**Files:**
- Modify: `src/server/routes/email-send.ts`

- [ ] **Step 1: Locate the send handler**

The route is `POST /api/send` (look for `sendBodySchema` near the top). Find the spot where `sendEmail({...})` is called.

- [ ] **Step 2: Extend the body schema**

```ts
const sendBodySchema = z.object({
  to: z.string().min(1).max(2000),
  cc: z.string().max(2000).optional(),
  bcc: z.string().max(2000).optional(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(200_000),
  isHtml: z.boolean().optional().default(false),
  alias: z.string().optional(),
  customerId: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
  inReplyTo: z.string().optional(),
  threadId: z.string().optional(),
  userSignatureId: z.string().nullable().optional(),  // NEW
});
```

- [ ] **Step 3: Call `appendSignatures` before `sendEmail`**

Add the import:
```ts
import { appendSignatures } from "../../modules/email-compose/signatures.js";
import { db } from "../../db/index.js";
```

Replace the `sendEmail({ html: parse.data.body, ... })` (or `text: ...` for non-HTML) with:

```ts
const aliasEmail = parse.data.alias ?? (await defaultFromAddress());  // use existing fallback
const finalHtml = parse.data.isHtml
  ? await appendSignatures(db, {
      bodyHtml: parse.data.body,
      userId: user.id,
      aliasEmail,
      userSignatureId: parse.data.userSignatureId ?? undefined,
      skipUserSignature: parse.data.userSignatureId === null,
    })
  : parse.data.body;

const result = await sendEmail({
  to: parse.data.to,
  cc: parse.data.cc,
  bcc: parse.data.bcc,
  subject: parse.data.subject,
  html: parse.data.isHtml ? finalHtml : undefined,
  text: parse.data.isHtml ? undefined : finalHtml,
  alias: parse.data.alias,
  attachments: parse.data.attachments,
  threadId: parse.data.threadId,
  inReplyTo: parse.data.inReplyTo,
  replyTo: parse.data.alias,  // if existing code already set this, keep it
});
```

**Read the existing handler first** — the snippet above is illustrative. Don't blindly replace; keep every existing argument to `sendEmail()` intact. Only swap the `html` (or `text`) value.

**Plain-text sends:** skip signature appending. Signatures are HTML; appending HTML to a plain-text body would surface raw tags. Only the `isHtml: true` branch gets `appendSignatures`.

If `parse.data.alias` is undefined and there's no clear fallback in the existing code, pass `aliasEmail = ""` — `resolveAliasSignature` returns `null` for unknown aliases, so the email goes out with no alias signature.

- [ ] **Step 4: Type-check + smoke**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/email-send.ts
git commit -m "Email signatures: wire appendSignatures into /api/send"
```

### Task 6b: chase.ts

**Files:**
- Modify: `src/server/routes/chase.ts`

- [ ] **Step 1: Read the file, find the POST handler that sends a chase email**

There is one route that triggers a per-customer chase send. Find where `sendEmail({...})` or `renderTemplate(...)` is called inside it.

- [ ] **Step 2: Extend the body schema with `userSignatureId`**

Same pattern as 6a:

```ts
userSignatureId: z.string().nullable().optional(),
```

- [ ] **Step 3: Add the imports + the `appendSignatures` call**

```ts
import { appendSignatures } from "../../modules/email-compose/signatures.js";
```

Right before `sendEmail({ html: renderedBody, ... })`:

```ts
const finalHtml = await appendSignatures(db, {
  bodyHtml: renderedBody,
  userId: user.id,
  aliasEmail: aliasFromRequestOrFallback,
  userSignatureId: parse.data.userSignatureId ?? undefined,
  skipUserSignature: parse.data.userSignatureId === null,
});

await sendEmail({ html: finalHtml, /* other args unchanged */ });
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/chase.ts
git commit -m "Email signatures: wire into chase send route"
```

### Task 6c: statements.ts (post handler — statement-sends.ts is unrelated audit log GET) (route — plumb userSignatureId into module)

**Files:**
- Modify: `src/server/routes/statements.ts`

This route delegates to `src/modules/statements/send.ts`. Per Task 6f's decision, `appendSignatures` is called inside that module — NOT here. This task only adds `userSignatureId` to the body schema and forwards it.

- [ ] **Step 1: Extend body schema**

```ts
userSignatureId: z.string().nullable().optional(),
```

- [ ] **Step 2: Forward `userSignatureId` into the `sendStatement(...)` call**

Inside the handler, after `parse.success`:

```ts
await sendStatement(parse.data.customerId, {
  // ... existing args
  userId: user.id,
  userSignatureId: parse.data.userSignatureId ?? null,
});
```

(Replace `sendStatement` with the actual exported name from the module.)

- [ ] **Step 3: Type-check** — `npm run build` PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/statements.ts (post handler — statement-sends.ts is unrelated audit log GET)
git commit -m "Email signatures: plumb userSignatureId through statement send route"
```

### Task 6d: invoicing.ts (send-invoice handler)

**Files:**
- Modify: `src/server/routes/invoicing.ts`

The `POST /api/invoicing/:customerId/send-invoice` handler. Same wiring pattern.

- [ ] **Step 1-5:** mirror 6b/6c. Commit `Email signatures: wire into invoice send`.

### Task 6e: returns.ts (RMA approval + denial)

**Files:**
- Modify: `src/server/routes/returns.ts`

Two handlers in this file: `send-approval` and `send-denial`. Both need the same change.

- [ ] **Step 1: Extend both body schemas with `userSignatureId`**
- [ ] **Step 2: Add import**
- [ ] **Step 3: Wrap both `sendEmail` calls with `appendSignatures`**
- [ ] **Step 4: `npm run build` — PASS**
- [ ] **Step 5: Commit `Email signatures: wire into RMA approval + denial routes`**

### Task 6f: statements module (modules/statements/send.ts)

**Files:**
- Modify: `src/modules/statements/send.ts`
- Re-check: `src/server/routes/statements.ts` (depending on call-site decision)

The statements module currently calls `sendEmail()` directly (around line 250). Spec §9 says "never inside modules" — but in this codebase the module IS the orchestrator: the route is a thin wrapper that delegates body-rendering + send to the module. Refactoring the body-build out of the module to satisfy the literal rule expands scope.

**Decision: call `appendSignatures` inside this module, immediately before `sendEmail()`.** Task 6c (`statements.ts (post handler — statement-sends.ts is unrelated audit log GET)` route) is responsible only for plumbing `userSignatureId` and `aliasEmail` through into the module's function signature. Document this exception in the commit message so future readers know spec §9 was relaxed here.

- [ ] **Step 1: Read the file. Find `sendStatement(...)` (or whatever the exported function is named) and locate the `sendEmail({...})` call.**

- [ ] **Step 2: Extend the function signature to accept `userSignatureId` and `aliasEmail`**

If the function currently looks like `sendStatement(customerId, opts)`, add to `opts`:

```ts
userSignatureId?: string | null;
aliasEmail: string;  // probably already there as 'fromAlias' or similar
userId: string;      // probably already there
```

- [ ] **Step 3: Add the imports**

```ts
import { appendSignatures } from "../email-compose/signatures.js";
import { db } from "../../db/index.js";
```

- [ ] **Step 4: Wrap the `sendEmail` call**

```ts
const finalHtml = await appendSignatures(db, {
  bodyHtml: htmlBody,
  userId: opts.userId,
  aliasEmail: opts.aliasEmail,
  userSignatureId: opts.userSignatureId ?? undefined,
  skipUserSignature: opts.userSignatureId === null,
});

await sendEmail({
  to: customerEmail,
  subject: subject,
  html: finalHtml,
  alias: opts.aliasEmail,
  attachments,
});
```

- [ ] **Step 5: Re-verify Task 6c plumbs `userSignatureId` into the module call**

Open `src/server/routes/statements.ts`. The handler should now pass `userSignatureId: parse.data.userSignatureId ?? null` into the module call, NOT call `appendSignatures` itself.

- [ ] **Step 6: Type-check + commit**

Run: `npm run build` — PASS.

```bash
git add src/modules/statements/send.ts src/server/routes/statements.ts (post handler — statement-sends.ts is unrelated audit log GET)
git commit -m "Email signatures: appendSignatures inside statements module (closest to sendEmail)"
```

### Task 6g: chase-digest cron job (system send, userId: null)

**Files:**
- Modify: `src/jobs/definitions/chase-digest.ts`

The chase digest is a system-triggered send: no current user. Per spec §9: pass `userId: null` so only the alias signature is appended.

- [ ] **Step 1: Add imports**

```ts
import { appendSignatures } from "../../modules/email-compose/signatures.js";
import { db } from "../../db/index.js";
import { env } from "../../lib/env.js";
```

- [ ] **Step 2: Find the `sendEmail({...})` call inside `processChaseDigest`**

It currently looks roughly like:

```ts
const result = await sendEmail({
  to: env.CHASE_DIGEST_RECIPIENT,
  subject: "Daily chase digest",
  html: htmlEnvelope(built.digest),
  text: built.digest,
});
```

- [ ] **Step 3: Append the alias signature before the call**

The digest goes from a specific alias — likely `env.CHASE_FROM_ALIAS` or similar. Locate the env var; if it doesn't exist, add it with a sensible default (e.g. `accounts@feldart.co.uk`) in `src/lib/env.ts` Zod schema.

```ts
const aliasEmail = env.CHASE_FROM_ALIAS ?? "accounts@feldart.co.uk";
const finalHtml = await appendSignatures(db, {
  bodyHtml: htmlEnvelope(built.digest),
  userId: null,
  aliasEmail,
});

const result = await sendEmail({
  to: env.CHASE_DIGEST_RECIPIENT,
  subject: "Daily chase digest",
  html: finalHtml,
  text: built.digest,
  alias: aliasEmail,  // ensure send goes out from the right alias
});
```

If `env.CHASE_FROM_ALIAS` doesn't exist and adding it expands scope, leave the alias resolution to whatever `sendEmail` does today; just hard-code the alias in the call.

- [ ] **Step 4: Type-check + sanity-run the job in shadow mode**

Run: `npm run build`
Then: with `SHADOW_MODE=true` in env, invoke the job's `processChaseDigest` (existing dev harness or BullMQ runner). Expected: returns `{ sent: false, reason: "shadow_mode" }` — confirms no regression.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/definitions/chase-digest.ts
git commit -m "Email signatures: wire chase-digest cron with userId: null (alias-only)"
```

---

## Task 7: Signature editor modal (frontend)

**Files:**
- Create: `src/web/components/signature-editor.tsx`

- [ ] **Step 1: Scaffold the component shell**

```tsx
// src/web/components/signature-editor.tsx
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type SignatureEditorMode =
  | { kind: "user"; id?: string; name: string; html: string; isDefault: boolean }
  | { kind: "alias"; aliasEmail: string; html: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: SignatureEditorMode;
  onSave: (payload: SignatureEditorMode) => Promise<void>;
  saving?: boolean;
};

const MAX_BYTES = 32 * 1024;

export function SignatureEditor({
  open,
  onOpenChange,
  initial,
  onSave,
  saving,
}: Props) {
  const [name, setName] = useState(
    initial.kind === "user" ? initial.name : initial.aliasEmail,
  );
  const [html, setHtml] = useState(initial.html);
  const [isDefault, setIsDefault] = useState(
    initial.kind === "user" ? initial.isDefault : false,
  );
  const [previewHtml, setPreviewHtml] = useState(html);

  // Debounced preview update
  useEffect(() => {
    const t = setTimeout(() => setPreviewHtml(html), 200);
    return () => clearTimeout(t);
  }, [html]);

  const bytes = useMemo(() => new Blob([html]).size, [html]);
  const overLimit = bytes > MAX_BYTES;

  const handleSave = async () => {
    if (overLimit) return;
    if (initial.kind === "user") {
      await onSave({ kind: "user", id: initial.id, name, html, isDefault });
    } else {
      await onSave({ kind: "alias", aliasEmail: initial.aliasEmail, html });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {initial.kind === "user" ? "Edit signature" : `Edit ${initial.aliasEmail} signature`}
          </DialogTitle>
          <DialogDescription>
            Paste pre-built HTML. The preview shows exactly what will be saved
            after sanitisation.
          </DialogDescription>
        </DialogHeader>

        {initial.kind === "user" && (
          <div className="grid gap-2">
            <Label htmlFor="sig-name">Name</Label>
            <Input
              id="sig-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder="Casual sign-off"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              Set as default
            </label>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="sig-html">HTML source</Label>
            <textarea
              id="sig-html"
              className="font-mono text-xs h-72 rounded border border-default bg-base p-2"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              spellCheck={false}
            />
            <div className={overLimit ? "text-xs text-red-600" : "text-xs text-muted"}>
              {bytes.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
              {overLimit && " — too large; trim before saving"}
            </div>
          </div>
          <div className="grid gap-1">
            <Label>Preview</Label>
            <iframe
              title="signature preview"
              sandbox="allow-same-origin"
              className="h-72 w-full rounded border border-default bg-white"
              srcDoc={previewHtml}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={overLimit || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

If `Label` or `Input` primitives aren't present in `src/web/components/ui/`, substitute plain `<label>` and `<input>` with Tailwind classes consistent with surrounding usage in `settings.tsx`.

- [ ] **Step 2: Smoke type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/signature-editor.tsx
git commit -m "Email signatures: SignatureEditor modal (textarea + sandboxed iframe preview)"
```

---

## Task 8: Signature picker dropdown (frontend)

**Files:**
- Create: `src/web/components/signature-picker.tsx`

- [ ] **Step 1: Build the picker**

```tsx
// src/web/components/signature-picker.tsx
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

export type SignatureChoice = string | null; // signature id, or null = "None"

type Props = {
  value: SignatureChoice;
  onChange: (next: SignatureChoice) => void;
  className?: string;
};

type UserSignatureRow = {
  id: string;
  name: string;
  isDefault: boolean;
};

export function SignaturePicker({ value, onChange, className }: Props) {
  const { data, isPending } = useQuery<{ rows: UserSignatureRow[] }>({
    queryKey: ["me-signatures"],
    queryFn: async () => {
      const res = await fetch("/api/me/signatures");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = data?.rows ?? [];

  // Auto-select default on first load
  useEffect(() => {
    if (value !== undefined && value !== null) return;
    if (rows.length === 0) {
      onChange(null);
      return;
    }
    const def = rows.find((r) => r.isDefault) ?? rows[0];
    onChange(def?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  const disabled = isPending || rows.length === 0;

  return (
    <select
      className={
        className ??
        "h-8 rounded border border-default bg-base px-2 text-xs disabled:opacity-50"
      }
      value={value ?? "__none__"}
      onChange={(e) =>
        onChange(e.target.value === "__none__" ? null : e.target.value)
      }
      disabled={disabled}
    >
      {rows.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
          {r.isDefault ? " (default)" : ""}
        </option>
      ))}
      <option value="__none__">None (skip personal signature)</option>
    </select>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/signature-picker.tsx
git commit -m "Email signatures: SignaturePicker dropdown component"
```

---

## Task 9: Settings page integration (frontend)

**Files:**
- Modify: `src/web/pages/settings.tsx`

- [ ] **Step 1: Add `MySignaturesSection` (new card)**

Insert near the existing `EmailTemplatesSection` (search the file for `function EmailTemplatesSection`). Pattern follows the existing list/edit/delete card style with TanStack Query.

```tsx
function MySignaturesSection() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{
    id?: string;
    name: string;
    html: string;
    isDefault: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isPending } = useQuery<{
    rows: Array<{ id: string; name: string; html: string; isDefault: boolean }>;
  }>({
    queryKey: ["me-signatures"],
    queryFn: async () => {
      const res = await fetch("/api/me/signatures");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = data?.rows ?? [];

  const save = async (
    payload:
      | { kind: "user"; id?: string; name: string; html: string; isDefault: boolean }
      | { kind: "alias"; aliasEmail: string; html: string },
  ) => {
    if (payload.kind !== "user") return;
    setSaving(true);
    try {
      const body = JSON.stringify({
        name: payload.name,
        html: payload.html,
        isDefault: payload.isDefault,
      });
      const res = payload.id
        ? await fetch(`/api/me/signatures/${payload.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body,
          })
        : await fetch("/api/me/signatures", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["me-signatures"] });
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const del = async (id: string) => {
    if (!window.confirm("Delete this signature?")) return;
    const res = await fetch(`/api/me/signatures/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    await queryClient.invalidateQueries({ queryKey: ["me-signatures"] });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">My email signatures</h2>
            <p className="mt-0.5 text-xs text-muted">
              Personal sign-offs appended to your outbound emails.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setEditing({ name: "", html: "", isDefault: rows.length === 0 })
            }
          >
            <Plus className="size-3.5" /> Add signature
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="text-xs text-muted">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">
            You don't have any signatures yet — add one to personalise your
            outbound emails.
          </div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{r.name}</span>
                  {r.isDefault && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                      Default
                    </span>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setEditing({
                        id: r.id,
                        name: r.name,
                        html: r.html,
                        isDefault: r.isDefault,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => del(r.id)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {editing && (
        <SignatureEditor
          open
          onOpenChange={(o) => !o && setEditing(null)}
          initial={{ kind: "user", ...editing }}
          onSave={save}
          saving={saving}
        />
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Add `AliasSignaturesSection` (new card)**

```tsx
function AliasSignaturesSection() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{
    aliasEmail: string;
    html: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isPending } = useQuery<{
    rows: Array<{
      aliasEmail: string;
      html: string;
      updatedByEmail: string | null;
      updatedAt: string;
    }>;
  }>({
    queryKey: ["alias-signatures"],
    queryFn: async () => {
      const res = await fetch("/api/alias-signatures");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = data?.rows ?? [];

  const save = async (
    payload:
      | { kind: "user"; id?: string; name: string; html: string; isDefault: boolean }
      | { kind: "alias"; aliasEmail: string; html: string },
  ) => {
    if (payload.kind !== "alias") return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/alias-signatures/${encodeURIComponent(payload.aliasEmail)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ html: payload.html }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["alias-signatures"] });
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium">Alias signatures</h2>
        <p className="mt-0.5 text-xs text-muted">
          Organisation footer appended to every email sent from each alias.
        </p>
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="text-xs text-muted">Loading…</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
              <li
                key={r.aliasEmail}
                className="flex items-center justify-between py-2"
              >
                <div>
                  <div className="text-sm">{r.aliasEmail}</div>
                  <div className="text-[11px] text-muted">
                    {r.updatedByEmail
                      ? `Last edited by ${r.updatedByEmail}`
                      : "Never edited"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setEditing({ aliasEmail: r.aliasEmail, html: r.html })
                  }
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {editing && (
        <SignatureEditor
          open
          onOpenChange={(o) => !o && setEditing(null)}
          initial={{ kind: "alias", ...editing }}
          onSave={save}
          saving={saving}
        />
      )}
    </Card>
  );
}
```

- [ ] **Step 3: Wire both sections into the page layout**

Add the imports near the top of `settings.tsx`:

```tsx
import { SignatureEditor } from "../components/signature-editor";
```

In the JSX where `<EmailTemplatesSection />` is rendered, add directly after it:

```tsx
<MySignaturesSection />
<AliasSignaturesSection />
```

- [ ] **Step 4: Run the dev server and click through**

Run: `npm run dev`
In browser:
1. Open `/settings`. Confirm both cards render and load without console error.
2. Click "Add signature" → modal opens. Paste `<b>test</b>`. Confirm preview iframe shows bold "test".
3. Save → list shows the new row.
4. Edit it → modal opens with existing HTML. Save changes — list updates.
5. Open an alias row → modal opens. Save edit — caption updates to your email.
6. Delete the user signature.

Hard test (sanity): paste `<script>alert(1)</script><b>x</b>` and Save — the saved HTML should only be `<b>x</b>` (sanitizer stripped script). The preview before save still shows the script tag (browser ignores it in sandboxed iframe), but the server stores the sanitized version. Confirm by re-opening the row.

Empty-output warning (per spec §10): paste a signature that's entirely `<script>...</script>` tags → save → server returns row with `html: ""`. Add a small inline check in both `save` handlers above:

```ts
if (payload.html.trim().length > 0 && (await res.json()).row?.html?.length === 0) {
  window.alert("Your signature looked empty after sanitisation — try simpler HTML.");
}
```

(A toast would be more polished if a toast primitive exists in `src/web/components/ui/`; otherwise the `window.alert` above is acceptable for an internal tool.)

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/settings.tsx
git commit -m "Email signatures: Settings cards (my signatures + alias signatures)"
```

---

## Task 10: Wire signature picker into compose dialogs

Each of the four compose dialogs needs:
1. Local state for `userSignatureId: string | null` (default `null` until SignaturePicker populates).
2. `<SignaturePicker value={...} onChange={...} />` rendered near the send button.
3. The send payload includes `userSignatureId`.

File-disjoint; can be parallelised.

### Task 10a: compose-modal.tsx

**Files:**
- Modify: `src/web/components/compose-modal.tsx`

- [ ] **Step 1: Add state**

Near the other `useState` calls in the component:
```tsx
const [userSignatureId, setUserSignatureId] = useState<string | null>(null);
```

- [ ] **Step 2: Add import**

```tsx
import { SignaturePicker } from "./signature-picker";
```

- [ ] **Step 3: Render picker in footer row**

Find the send button. Place above or to the left:
```tsx
<div className="flex items-center gap-2">
  <span className="text-xs text-muted">Signature</span>
  <SignaturePicker value={userSignatureId} onChange={setUserSignatureId} />
</div>
```

- [ ] **Step 4: Add to send payload**

Inside `sendMutation.mutationFn`, in the `body: JSON.stringify({ ... })` block:
```ts
userSignatureId,  // string | null
```

- [ ] **Step 5: Smoke**

`npm run dev`, open compose modal from a customer page. Picker dropdown should populate with your signatures. Select "None" → send → check `email_log` (or sent items) for body without personal signature.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/compose-modal.tsx
git commit -m "Email signatures: SignaturePicker in compose modal"
```

### Task 10b: chase-email-send-dialog.tsx

**Files:**
- Modify: `src/web/components/chase-email-send-dialog.tsx`

- [ ] **Step 1: Add state** (near other `useState` calls)

```tsx
const [userSignatureId, setUserSignatureId] = useState<string | null>(null);
```

- [ ] **Step 2: Add import**

```tsx
import { SignaturePicker } from "./signature-picker";
```

- [ ] **Step 3: Render picker in dialog footer**

Find the existing `<DialogFooter>` block. Insert before the Send button:

```tsx
<div className="mr-auto flex items-center gap-2">
  <span className="text-xs text-muted">Signature</span>
  <SignaturePicker value={userSignatureId} onChange={setUserSignatureId} />
</div>
```

- [ ] **Step 4: Include in send payload**

Find the `fetch("/api/chase/...", { ... })` call (or whichever mutation function POSTs the chase send). In its JSON body, add:

```ts
userSignatureId,  // string | null
```

- [ ] **Step 5: Smoke + commit**

`npm run dev`, open the chase dialog from a customer page, verify dropdown populates and send completes.

```bash
git add src/web/components/chase-email-send-dialog.tsx
git commit -m "Email signatures: SignaturePicker in chase send dialog"
```

### Task 10c: rma-approval-email-dialog.tsx

**Files:**
- Modify: `src/web/components/rma-approval-email-dialog.tsx`

- [ ] **Step 1: Add state**

```tsx
const [userSignatureId, setUserSignatureId] = useState<string | null>(null);
```

- [ ] **Step 2: Add import**

```tsx
import { SignaturePicker } from "./signature-picker";
```

- [ ] **Step 3: Render picker in dialog footer**

Insert before the Send button in `<DialogFooter>`:

```tsx
<div className="mr-auto flex items-center gap-2">
  <span className="text-xs text-muted">Signature</span>
  <SignaturePicker value={userSignatureId} onChange={setUserSignatureId} />
</div>
```

- [ ] **Step 4: Include in send payload**

In the fetch body to `/api/rmas/:id/send-approval`:

```ts
userSignatureId,
```

- [ ] **Step 5: Smoke + commit**

```bash
git add src/web/components/rma-approval-email-dialog.tsx
git commit -m "Email signatures: SignaturePicker in RMA approval dialog"
```

### Task 10d: rma-denial-email-dialog.tsx

**Files:**
- Modify: `src/web/components/rma-denial-email-dialog.tsx`

- [ ] **Step 1: Add state**

```tsx
const [userSignatureId, setUserSignatureId] = useState<string | null>(null);
```

- [ ] **Step 2: Add import**

```tsx
import { SignaturePicker } from "./signature-picker";
```

- [ ] **Step 3: Render picker in dialog footer**

```tsx
<div className="mr-auto flex items-center gap-2">
  <span className="text-xs text-muted">Signature</span>
  <SignaturePicker value={userSignatureId} onChange={setUserSignatureId} />
</div>
```

- [ ] **Step 4: Include in send payload**

In the fetch body to `/api/rmas/:id/send-denial`:

```ts
userSignatureId,
```

- [ ] **Step 5: Smoke + commit**

```bash
git add src/web/components/rma-denial-email-dialog.tsx
git commit -m "Email signatures: SignaturePicker in RMA denial dialog"
```

---

## Task 11: Seed script — pre-populate alias signatures from Gmail

**Files:**
- Create: `scripts/seed-alias-signatures-from-gmail.ts`

- [ ] **Step 1: Write the script**

```ts
// scripts/seed-alias-signatures-from-gmail.ts
//
// One-shot: walk Gmail's sendAs aliases and pre-populate alias_signatures
// rows from each alias's existing `signature` field. Skips aliases that
// already have a row. Re-run is a no-op.
//
// IMPORTANT: this is NOT a sync. After seeding, alias signatures live in
// our DB and edits in our Settings page do NOT propagate back to Gmail.

import { db } from "../src/db/index.js";
import { aliasSignatures } from "../src/db/schema/alias-signatures.js";
import { eq } from "drizzle-orm";
import { listAliases } from "../src/integrations/gmail/aliases.js";
import {
  sanitizeSignatureHtml,
  MAX_SIGNATURE_BYTES,
} from "../src/modules/email-compose/signatures.js";
import { getInternalGmailClient, withRetry } from "../src/integrations/gmail/client.js";

async function main() {
  const aliases = await listAliases();
  const gmail = await getInternalGmailClient();

  let seeded = 0;
  let skipped = 0;
  let empty = 0;

  for (const alias of aliases) {
    const email = alias.sendAsEmail.toLowerCase();
    if (!email) continue;

    // Skip if a row already exists
    const existing = await db
      .select({ aliasEmail: aliasSignatures.aliasEmail })
      .from(aliasSignatures)
      .where(eq(aliasSignatures.aliasEmail, email))
      .limit(1);
    if (existing[0]) {
      skipped++;
      console.log(`SKIP ${email} — already in DB`);
      continue;
    }

    // Fetch the full sendAs object for the `signature` field
    const res = await withRetry(
      () =>
        gmail.users.settings.sendAs.get({
          userId: "me",
          sendAsEmail: alias.sendAsEmail,
        }),
      `settings.sendAs.get(${alias.sendAsEmail})`,
    );
    const raw = res.data.signature ?? "";
    if (!raw.trim()) {
      empty++;
      console.log(`EMPTY ${email} — no signature in Gmail`);
      continue;
    }
    if (raw.length > MAX_SIGNATURE_BYTES) {
      console.warn(
        `OVERSIZED ${email} — ${raw.length} bytes; truncate or edit manually`,
      );
      continue;
    }

    const sanitized = sanitizeSignatureHtml(raw);
    await db.insert(aliasSignatures).values({
      aliasEmail: email,
      html: sanitized,
      updatedByUserId: null,
    });
    seeded++;
    console.log(`SEEDED ${email} (${sanitized.length} bytes after sanitisation)`);
  }

  console.log(
    `\nPre-populated ${seeded} alias(es) from Gmail. Skipped ${skipped} (already present), ${empty} empty.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Add an npm script (optional, but matches existing scripts/ pattern)**

In `package.json`, under `"scripts"`:

```json
"seed:alias-signatures": "tsx scripts/seed-alias-signatures-from-gmail.ts"
```

(Check the file — existing scripts likely use `tsx` or `node --import tsx`. Match exactly.)

- [ ] **Step 3: Dry-run locally if possible**

Run: `npm run seed:alias-signatures`
Expected: prints `SEEDED accounts@feldart.co.uk (NNNN bytes after sanitisation)` (and similar for other aliases), or `EMPTY ...` if the Gmail field is blank. Re-running immediately prints `SKIP ... already in DB` for every row.

If Gmail integration auth isn't wired locally, defer the run to post-deploy on the VPS.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-alias-signatures-from-gmail.ts package.json
git commit -m "Email signatures: one-shot seed script (Gmail sendAs.signature)"
```

---

## Task 12: Manual smoke + finish branch

- [ ] **Step 1: Run the full vitest suite**

Run: `npx vitest run`
Expected: all tests pass — no regressions in pre-existing files.

- [ ] **Step 2: Run the full build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Run lint (if configured)**

Run: `npm run lint` (skip if no lint script in package.json)
Expected: PASS or only pre-existing warnings.

- [ ] **Step 4: Manual smoke (substitute for the missing Playwright suite)**

In `npm run dev`:

- [ ] Settings → create a user signature; mark default — appears in "My email signatures" list with "Default" pill
- [ ] Settings → create a second user signature without default — first one keeps its pill
- [ ] Settings → edit second one and mark default — first one's pill disappears (transactional clear-and-set worked)
- [ ] Settings → delete the default signature — list shows the other one as un-defaulted (no auto-promotion)
- [ ] Settings → click an alias row → modal opens with current Gmail-seeded HTML (after running the seed script) → save trivial edit → list caption updates to "Last edited by you@…"
- [ ] Open compose modal from a customer page → SignaturePicker shows your signatures → default pre-selected → send a test email to yourself → received email shows: body, `<br><br>`, your signature, `<br><br>`, alias signature
- [ ] In the same compose modal change picker to "None" → send → received email has only alias signature (no personal)
- [ ] Open chase send dialog → repeat picker check + send
- [ ] Open RMA approval + denial dialogs → repeat
- [ ] Trigger chase cron job manually (`npm run job:chase-digest` or equivalent) → digest email has alias signature only (no user)
- [ ] In Settings, paste `<script>alert(1)</script><b>x</b>` as a new signature → save → reopen → only `<b>x</b>` survives

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/email-signatures
```

- [ ] **Step 6: Open PR (or hand off per finance-hub workflow)**

Per `feedback_finance-hub-workflow`: push every wave merge. With the branch fully pushed, open a PR for review (`gh pr create ...`) and tag `superpowers:requesting-code-review` if a fresh review is wanted.

---

## Known follow-ups (out of scope, noted for backlog)

- **Per-template signature suppression** — add `email_templates.skip_signature` boolean + check in `appendSignatures` if a non-trivial number of automated templates should look signature-free.
- **E2E coverage** — when Playwright lands in the repo, port the smoke checklist (Task 12 Step 4) into `tests/e2e/email-signatures.spec.ts`.
- **Sync from Gmail** — if Josh continues editing alias signatures in Gmail's web UI by habit and expects them to flow into the app, the one-shot seed becomes a periodic sync. Currently single-source-of-truth in our DB after seeding.
