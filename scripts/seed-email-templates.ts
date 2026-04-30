// Seeds default email templates. Idempotent: rows are upserted by slug,
// so re-running this is safe. Run once on first boot; the user edits
// templates from the Settings UI thereafter.
//
// To bring a new default into existing installs, add the row here AND
// bump its slug if the user has been editing the existing one (we don't
// overwrite user edits — see UPSERT logic below).

import "dotenv/config";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/db/index.js";
import {
  emailTemplates,
  type NewEmailTemplate,
} from "../src/db/schema/email-templates.js";

// All bodies use {{merge_variables}} resolved at render time. Available
// vars: customer_name, primary_email, open_balance, overdue_balance,
// days_overdue, oldest_unpaid_invoice, oldest_unpaid_amount, user_name,
// company_name. The statement_open_items body is HTML because it
// renders a per-invoice table; the others are plain text.

const DEFAULTS: Omit<NewEmailTemplate, "id" | "createdAt" | "updatedAt">[] = [
  {
    slug: "chase_l1",
    name: "Chase — Level 1 (gentle reminder)",
    context: "chase",
    description: "First-touch reminder; tone is warm + helpful.",
    subject: "{{company_name}} — friendly reminder, your account",
    body: `Hi {{customer_name}},

Hope you're well. Just a gentle reminder that your account currently has \
an open balance of {{open_balance}}, of which {{overdue_balance}} is past \
due.

Your oldest open invoice is {{oldest_unpaid_invoice}} for \
{{oldest_unpaid_amount}}, now {{days_overdue}} days past due.

If a payment is already in flight, please ignore — and let me know the \
expected date so I can match it on this end. Otherwise, the easiest way \
to clear it is the Pay-now button on each invoice; statements are \
attached for reference.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "chase_l2",
    name: "Chase — Level 2 (firmer follow-up)",
    context: "chase",
    description:
      "Second touch when L1 didn't land. Still polite but more direct.",
    subject:
      "{{company_name}} — follow-up on overdue balance ({{overdue_balance}})",
    body: `Hi {{customer_name}},

Following up on my earlier note — your overdue balance with \
{{company_name}} is now {{overdue_balance}} ({{days_overdue}} days past \
due on {{oldest_unpaid_invoice}}).

Could you let me know when payment is expected, or if there's an issue \
on any of the open invoices that needs my attention?

Pay-now links are inside each invoice attached. Happy to set up a payment \
plan if that helps.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "chase_l3",
    name: "Chase — Level 3 (escalation)",
    context: "chase",
    description: "Final stage before further action.",
    subject:
      "URGENT — {{company_name}} account, overdue balance ({{overdue_balance}})",
    body: `Hi {{customer_name}},

Despite our previous reminders, the overdue balance on your account is \
still outstanding at {{overdue_balance}} (oldest invoice \
{{oldest_unpaid_invoice}}, {{days_overdue}} days past due).

I need to hear back from you within 7 days with either payment or a clear \
plan, otherwise I'll need to put further orders on hold.

Pay-now links are on each invoice attached. Please reply directly so we \
can resolve this without further escalation.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "statement_open_items",
    name: "Statement — Open Items",
    context: "statement",
    description:
      "Cover-note email body for the Statement.pdf attachment. The actual statement table is inside the PDF — this is just the wrapping email.",
    subject:
      "{{company_name}} — Statement of Account ({{open_balance}} open)",
    body: `<p>Hi {{customer_name}},</p>

<p>Please find your statement of account attached. Total open balance \
is <strong>{{open_balance}}</strong>; of that, \
<strong>{{overdue_balance}}</strong> is past due.</p>

<p>The attached PDF lists every open invoice with a Pay-now link \
straight to QuickBooks for online payment. Please let me know if \
anything looks incorrect.</p>

<p>Thanks,<br>
{{user_name}}<br>
{{company_name}}</p>`,
  },
  {
    slug: "payment_confirmation",
    name: "Payment confirmation — Thanks",
    context: "payment_confirmation",
    description: "Sent after a payment is received and applied.",
    subject: "{{company_name}} — payment received, thank you",
    body: `Hi {{customer_name}},

Just confirming we've received your recent payment — thank you, much \
appreciated.

Your remaining open balance is now {{open_balance}}.

Best,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "generic_reply",
    name: "Generic reply",
    context: "reply",
    description:
      "Empty starting point for replies — useful when threading off an inbound email.",
    subject: "Re: {{thread_subject}}",
    body: `Hi {{customer_name}},



Thanks,
{{user_name}}
{{company_name}}`,
  },
];

async function main() {
  let created = 0;
  let skipped = 0;
  for (const tpl of DEFAULTS) {
    const existing = await db
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, tpl.slug))
      .limit(1);
    if (existing.length > 0) {
      // Don't overwrite a user-edited template — only seed missing slugs.
      skipped++;
      continue;
    }
    await db.insert(emailTemplates).values({
      id: nanoid(24),
      ...tpl,
    });
    created++;
  }
  console.log(`Seeded email templates: ${created} created, ${skipped} already present.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
