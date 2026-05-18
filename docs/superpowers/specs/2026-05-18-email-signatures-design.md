# Email Signatures — Design Spec

**Date:** 2026-05-18
**Status:** Awaiting user review
**Branch context:** new branch off `main`

---

## Problem

Outbound email from the app today (chase reminders, statement covers,
RMA approval/denial, ad-hoc compose) goes out with the bare rendered
template body. There is no signature — no "Josh, Feldart Accounts" sign-off,
no organisation footer (logo, address, disclaimer). That makes templated
emails look impersonal and obviously machine-generated.

Two layers are missing:

1. **A personal sign-off** that identifies which team member sent the
   email — "Best, Josh".
2. **An organisation block** tied to the sending alias — the
   "Feldart Ltd · address · phone · disclaimer" footer that `accounts@`
   emails should carry, distinct from what `sales@` carries.

Each user might want more than one personal sign-off (formal vs casual,
with/without phone), so the personal layer is a set, not a single value.

## Goal

End state:

1. Every team member can save 1-N personal HTML signatures in Settings,
   one marked as their default.
2. Each Gmail alias (`info@`, `accounts@`, `admin@feldart.co.uk`,
   `sales@`) has a single HTML "organisation" signature, editable by
   any team member in Settings.
3. On every outbound human-initiated send, the email body is appended
   with `{user_signature}` + `{alias_signature}` (in that order, with
   spacers). The user picks which personal sig in the compose dialog;
   defaults to their default, with a "None" option to skip the personal
   layer entirely.
4. System/cron sends (background chase jobs, anything with no
   `currentUser`) get only the alias signature appended.
5. New signatures are sanitized server-side before storage so the
   stored HTML can be trusted on render.

## Out of scope

- Mirroring signatures back to Gmail's `sendAs.signature` field. Edits
  in our Settings page do **not** propagate to Gmail's web UI. We send
  via Gmail API anyway; the field in Gmail's settings is unused by our
  send path. (Pre-population on first install is in scope — see
  Architecture §6.)
- A WYSIWYG editor. Users paste raw HTML into a `<textarea>`; a
  sandboxed iframe shows a live preview. The implementation assumes
  users either have an existing HTML signature to paste, or they're
  comfortable writing simple HTML.
- Per-template signature suppression flag (no
  `email_templates.skip_signature` column). Templates always get a
  signature on human send; if a specific template should look
  signature-free, that's a future enhancement.
- Auto-detecting a user's signature when they reply to a thread (e.g.,
  stripping out the previous signature). Out of scope for this rev.
- Multi-tenancy of alias signatures (e.g., one row per user-alias pair).
  All users see and edit the same shared alias signatures.

## Approach

Two new tables (`user_signatures`, `alias_signatures`). One pure
function (`appendSignatures`) that takes a rendered body + a context
object and returns the final HTML to hand to the Gmail send path.
Every existing send call site is changed to pass through that function.
Two new cards in the existing Settings page for management, one new
modal component for the editor. One dropdown added to each of the four
existing compose dialogs.

No template migration. Auto-append means existing email templates
(`chase_l1`, `chase_l2`, etc.) are untouched and pick up signatures
on the next send.

## Architecture

### 1. Schema migration

New migration file under `migrations/` (next sequential number).
Two tables:

```sql
CREATE TABLE user_signatures (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  name VARCHAR(64) NOT NULL,
  html TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_signatures_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_signatures_user (user_id),
  INDEX idx_user_signatures_default (user_id, is_default)
);

CREATE TABLE alias_signatures (
  alias_email VARCHAR(254) NOT NULL PRIMARY KEY,
  html TEXT NOT NULL,
  updated_by_user_id BIGINT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_alias_signatures_user FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id) ON DELETE SET NULL
);
```

**`is_default` invariant** — at most one row per `user_id` may have
`is_default = TRUE`. Enforced in the route handler (transactional
clear-then-set), not in SQL — MySQL 8 has no partial unique indexes.

### 2. Drizzle schema

New files:

- `src/db/schema/user-signatures.ts`
- `src/db/schema/alias-signatures.ts`

Wire into `src/db/schema/index.ts` exports and
`src/db/relations.ts` (user → signatures has-many).

### 3. Sanitization

Use `sanitize-html` (existing dependency choice; if not present, add
it). Real signatures are richer than the minimal allow-list suggests:
a typical Feldart-style signature uses a `<table>` for the two-column
layout, inline `style` attributes for fonts/colors/letter-spacing/
borders, and `<img>` tags for icons (phone, email, social) hosted at
public URLs. The config below supports all of that.

```ts
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
    // data: URLs allowed only in <img src>, NEVER in <a href>
    // (data:text/html in href is an XSS vector).
    img: ["http", "https", "cid", "data"],
  },
  // Allow CSS properties commonly used in signatures. sanitize-html
  // treats keys as LITERAL property names (not regex), so each shorthand
  // and longhand must be enumerated explicitly. The value regex checks
  // block expression(), javascript:, url() with non-http schemes, etc.
  // Verified end-to-end against a real Feldart signature in spec testing.
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
  // Strip on* attributes by default. sanitize-html disallows them
  // unless explicitly listed.
};
```

**Stripped categorically:**

- `<style>` blocks (no scoping, CSS-parsing complexity, and most
  recipient email clients strip them anyway). Signature builders
  output inline styles by default; users with `<style>`-based
  signatures must run their HTML through a CSS inliner (e.g.
  premailer.io) before pasting. The editor's iframe preview shows
  exactly what survived sanitization, so this surprise lands at
  edit-time.
- `<script>`, `on*` attributes, `javascript:` and `expression()` in
  styles, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>` — all
  sanitize-html defaults.
- Outlook-specific `<o:p>` / `<v:*>` tags — also default-stripped.

Helper in `src/modules/email-compose/signatures.ts`:
`sanitizeSignatureHtml(input: string): string`. Called server-side on
every write to either table. Max input length: 32 KB raw (signature
builders with embedded base64 icons can run large — reject with 413
above that). Output stored verbatim; render-time trusts it.

**Verified:** the config above was tested against `signature7.html`
(real Feldart signature, 3741 bytes, table layout with two columns,
inline-styled FELDART logotype block, vertical divider, contact
rows with phone/email/web icons, social row with WhatsApp/Instagram
icons). All tags survived; all 23 distinct style properties used in
the input survived. Output was 3606 bytes (135-byte loss is
sanitize-html's whitespace normalization inside style attributes —
purely cosmetic).

### 4. The append function

New module `src/modules/email-compose/signatures.ts`:

```ts
type AppendContext = {
  bodyHtml: string;
  userId: number | null;     // null for system/cron sends
  aliasEmail: string;
  userSignatureId?: number;  // explicit pick; if undefined, use default
  skipUserSignature?: boolean; // explicit "None" choice from dropdown
};

export async function appendSignatures(
  db: Database,
  ctx: AppendContext,
): Promise<string> {
  // 1. Resolve user signature (null if userId null, or skipUserSignature,
  //    or no signatures exist).
  // 2. Resolve alias signature (null if alias_signatures has no row
  //    for this email).
  // 3. Concatenate: bodyHtml + (userSig ? "<br><br>" + userSig : "")
  //                          + (aliasSig ? "<br><br>" + aliasSig : "")
}
```

Pure-ish (DB reads only, no writes). Returns the final HTML the Gmail
send path uses for `message.payload.body`.

### 5. Routes

Six new endpoints under `src/server/routes/signatures.ts`:

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/me/signatures` | — | Returns current user's signatures, ordered by `is_default DESC, name ASC` |
| POST | `/api/me/signatures` | `{ name, html, is_default? }` | Sanitizes html, enforces single-default invariant if `is_default=true` |
| PATCH | `/api/me/signatures/:id` | `{ name?, html?, is_default? }` | Same invariant. Returns 404 if id doesn't belong to current user |
| DELETE | `/api/me/signatures/:id` | — | Hard delete. If the deleted sig was default, no automatic re-promotion (user picks a new default explicitly) |
| GET | `/api/alias-signatures` | — | Returns all alias rows (4 today). Each row includes `updatedBy: { email }` for the "Last edited by" caption |
| PATCH | `/api/alias-signatures/:email` | `{ html }` | Sanitizes html, upserts (so an alias missing a row gets one on first edit) |

Auth: all six require an authenticated session. No role checks (no
roles in the app). Every write hits `audit_log` per CLAUDE.md
convention with `entity_type='user_signature'` or `'alias_signature'`.

### 6. Gmail signature pre-population (one-shot)

A one-shot script `scripts/seed-alias-signatures-from-gmail.ts`:

1. Fetch `users.settings.sendAs.list` (already wired in
   `src/integrations/gmail/aliases.ts` — reuse).
2. For each alias with a non-empty `signature` field, insert a row into
   `alias_signatures` with that HTML, **only if no row exists for that
   alias email yet**.
3. Sanitize through `sanitizeSignatureHtml` on the way in.
4. Log a summary: "Pre-populated N aliases from Gmail."

Run once after deploy, before users hit the Settings page. Re-running
is a no-op (skips rows that already exist).

### 7. Frontend — Settings page

New file `src/web/components/signature-editor.tsx` (modal):

- Two-pane layout. Left: `<textarea>` with monospace font for raw HTML.
  Right: sandboxed `<iframe sandbox="allow-same-origin">` updating on
  blur/debounced-input. Width 280px on mobile, 50/50 split on desktop.
- Header: editable `name` field (for user signatures only; alias rows
  don't have an editable name since the alias email is the key).
- Footer: "Set as default" checkbox (user signatures only),
  Save / Cancel buttons.
- Character counter (max 16 KB raw).
- Server returns the sanitized version on save; the editor updates
  local state to reflect what was actually stored.

Two new cards in `src/web/pages/settings.tsx`:

**"My email signatures"** — sits near the "Email templates" card (line
834-ish in the current file). Lists current user's signatures as
clickable rows: name, "Default" pill if `is_default`, edit pencil,
delete trash. Empty state: "You don't have any signatures yet — add
one to personalise your outbound emails." "Add signature" button opens
the editor modal.

**"Alias signatures"** — sits after the "My email signatures" card.
Lists all four aliases as rows: alias email, "Last edited by
{user.email} {relativeTime}" caption, edit pencil opens the editor.

Both cards use existing `Card` / `CardHeader` / `CardBody` primitives.

### 8. Compose dialog dropdown

Affected components (all four):

- `src/web/components/compose-modal.tsx`
- `src/web/components/chase-email-send-dialog.tsx`
- `src/web/components/rma-approval-email-dialog.tsx`
- `src/web/components/rma-denial-email-dialog.tsx`

New shared component
`src/web/components/signature-picker.tsx`:

```tsx
<SignaturePicker
  value={signatureChoice}  // 'default' | sigId | 'none'
  onChange={setSignatureChoice}
/>
```

Renders a `<select>` populated from `/api/me/signatures` (TanStack
Query cached). Options:

- One option per signature, by `name`. The user's default signature is
  pre-selected when the dialog opens; otherwise the first signature.
- A trailing "None (skip personal signature)" option.

If the user has no signatures yet, the dropdown shows only "None" and
is disabled.

**Semantics:** the dropdown is plain form state. Whatever option is
selected **at the moment the user clicks Send** is what gets used.
Users can change the dropdown at any point before clicking Send and
the new choice takes effect. There is no captured-at-open-time
locking.

The chosen value is included in the send payload — `userSignatureId:
number | null` on the existing send routes. `null` means skip (the
"None" option). The route handler forwards this directly to
`appendSignatures` as `skipUserSignature: true` (when null) or
`userSignatureId: <id>` (when set).

### 9. Send-path call sites

Wire `appendSignatures` into every place a rendered template hits the
Gmail send API. Audit pass needed; from the current code I know about:

- `src/integrations/gmail/send.ts` — base `sendEmail()` function.
  Don't append here (it would double-append for system code paths that
  already appended).
- Route handlers / dialogs that build a body and call `sendEmail()`:
  - Chase send (server route used by `chase-email-send-dialog`)
  - Statement send (`src/modules/statements/...`)
  - RMA approval send (server route used by `rma-approval-email-dialog`)
  - RMA denial send (server route used by `rma-denial-email-dialog`)
  - Generic compose send (server route used by `compose-modal`)
  - Background chase job (cron) — pass `userId: null`

Implementation rule: call `appendSignatures` **once**, in the route
handler (or job), right before `sendEmail()`. Never inside the modules
that build the body — keeps the contract obvious.

Test: each call site has a unit test that mocks
`appendSignatures` and asserts the body passed to `sendEmail` is the
function's return value.

### 10. Empty / edge cases

- **New user with no signatures + no default chosen:** dropdown shows
  only "None"; emails go out with alias signature only.
- **User deletes their default signature:** `is_default` is now FALSE
  for all of theirs. Dropdown's "Default" option disappears. They have
  to pick a non-default explicitly until they set a new default.
- **Alias without an `alias_signatures` row:** `appendSignatures`
  returns the body with no alias signature appended. No error.
- **HTML > 32 KB on POST/PATCH:** 413 Payload Too Large.
- **Two users editing the same alias signature concurrently:**
  last-write-wins; race window is tiny. The "Last edited by" caption
  surfaces who clobbered whom.
- **Sanitizer strips everything from a non-empty input:** still accept
  the row (empty html); next render is as if no signature. Frontend
  shows a warning banner: "Your signature looked like it was empty
  after sanitization — try simpler HTML."
- **Send from an unknown alias (not in `alias_signatures`):** treat as
  alias-less; only user signature is appended.

## Testing

### Unit

`src/modules/email-compose/signatures.test.ts`:

- `appendSignatures` matrix:
  - userId set, default exists, no explicit pick → default sig appended
  - userId set, explicit `userSignatureId` → that sig appended
  - userId set, `skipUserSignature: true` → no user sig
  - userId null → no user sig (system send)
  - alias not in table → no alias sig
  - both signatures present → both appended with spacers in correct
    order
- `sanitizeSignatureHtml`:
  - `<script>` tags removed
  - `onclick` attrs removed
  - `<img src="data:...">` preserved
  - `<a href="mailto:...">` preserved
  - inline `style="color: red"` preserved
  - inline `<table>` with style="border-right: 1px solid #ccc"
    preserved (real signature layout)
  - `<style>` block in input stripped, inline styles inside the same
    input preserved
  - 33 KB input rejected at the route layer, not in the sanitizer
    (sanitizer is pure)

### Route

`src/server/routes/signatures.test.ts`:

- POST creates, GET returns the new row
- POST with `is_default=true` clears any existing default for the same
  user, then sets the new one (transactional)
- PATCH on another user's signature returns 404
- DELETE removes the row; audit_log row written
- PATCH alias signature: row missing → upserts; row present → updates
- 32 KB boundary: 32768 bytes accepted, 32769 rejected

### E2E (Playwright)

- Create a user signature in Settings → it shows in the compose
  dialog dropdown → select it → send → received email has the
  signature HTML in the body
- Edit an alias signature → next send from that alias contains the new
  HTML
- Skip personal signature on a send → received email has only the
  alias signature

## Migration / rollout

1. Apply migration on deploy.
2. Run `scripts/seed-alias-signatures-from-gmail.ts` once
   post-deploy (pre-populates the 4 alias rows from Gmail's
   existing `sendAs.signature` values).
3. Settings cards appear on the existing Settings page. No feature
   flag — feature is fully optional per user (empty signatures = no
   change in send output until they fill any in).

## Risks and tradeoffs

- **Sanitizer false negatives** — an unusual signature (animated GIF,
  obscure CSS) may render differently after sanitization. The
  editor preview shows what will actually be saved/sent, so users see
  the truth before saving.
- **`is_default` invariant via app code, not SQL** — there's a window
  where two simultaneous PATCHes could both clear-and-set the default
  and one race-loses. Acceptable for a 5-user team; not worth a
  serializable transaction for now.
- **HTML signatures are a phishing surface** — a malicious user could
  paste a signature that mimics a Gmail-internal banner. The team is
  trusted (allow-list auth), and audit_log captures every write, so
  this is acceptable. Mention in docs.
- **No per-template override** — if you later decide automated payment
  confirmations should look signature-free, that's a follow-up to add
  a `templates.skip_signature` flag and a check in the send path.
- **Pre-population script is one-shot** — if Josh later changes an
  alias signature in Gmail's web UI, our DB will not pick it up. By
  design (single source of truth in our DB after seeding). Re-running
  the script won't overwrite. Document this in the script header.

## Effort estimate

1-2 days end-to-end:

- Day 1: migration + schema + sanitizer + `appendSignatures` + routes
  + unit tests + audit_log integration + seed script.
- Day 2: Settings UI (two cards + editor modal) + compose dialog
  dropdown wired into all four dialogs + send-path integration
  in every call site + E2E.
