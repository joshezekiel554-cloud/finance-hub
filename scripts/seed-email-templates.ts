// Seeds default email templates. Idempotent: rows are upserted by slug,
// so re-running this is safe. Run once on first boot; the user edits
// templates from the Settings UI thereafter.
//
// To bring a new default into existing installs, add the row here AND
// bump its slug if the user has been editing the existing one (we don't
// overwrite user edits - see UPSERT logic below).

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
    name: "Chase - Level 1 (gentle reminder)",
    context: "chase",
    description: "First-touch reminder; tone is warm + helpful.",
    subject: "{{company_name}} - friendly reminder, your account",
    body: `Hi {{customer_name}},

Hope you're well. Just a gentle reminder that your account currently has \
an open balance of {{open_balance}}, of which {{overdue_balance}} is past \
due{{overdue_credit_note}}.

Your oldest open invoice is {{oldest_unpaid_invoice}} for \
{{oldest_unpaid_amount}}, now {{days_overdue}} days past due.

If a payment is already in flight, please ignore - and let me know the \
expected date so I can match it on this end. Otherwise, the easiest way \
to clear it is the Pay-now button on each invoice; statements are \
attached for reference.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "chase_l2",
    name: "Chase - Level 2 (firmer follow-up)",
    context: "chase",
    description:
      "Second touch when L1 didn't land. Still polite but more direct.",
    subject:
      "{{company_name}} - follow-up on overdue balance ({{overdue_balance}})",
    body: `Hi {{customer_name}},

Following up on my earlier note - your overdue balance with \
{{company_name}} is now {{overdue_balance}}{{overdue_credit_note}} \
({{days_overdue}} days past due on {{oldest_unpaid_invoice}}).

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
    name: "Chase - Level 3 (escalation)",
    context: "chase",
    description: "Final stage before further action.",
    subject:
      "URGENT - {{company_name}} account, overdue balance ({{overdue_balance}})",
    body: `Hi {{customer_name}},

Despite our previous reminders, the overdue balance on your account is \
still outstanding at {{overdue_balance}}{{overdue_credit_note}} (oldest \
invoice {{oldest_unpaid_invoice}}, {{days_overdue}} days past due).

I need to hear back from you within 7 days with either payment or a clear \
plan, otherwise I'll need to put further orders on hold.

Pay-now links are on each invoice attached. Please reply directly so we \
can resolve this without further escalation.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "tj_l1",
    name: "TJ Chase - Level 1 (gentle)",
    context: "chase",
    description:
      "First touch on a Torah Judaica legacy balance; acknowledges the handover and invites a paid-already check.",
    subject: "{{company_name}} - reminder regarding your Torah Judaica account",
    body: `Hi {{customer_name}},

Hope you're well. We're now looking after the invoices originally raised by \
Torah Judaica, and our records show {{overdue_balance}} past due on your \
account (oldest invoice {{oldest_unpaid_invoice}}, {{days_overdue}} days past \
due).

If you've already settled this directly with Torah Judaica, just reply and \
let us know. We'll check it against their records and clear it from our end. \
Otherwise we'd appreciate payment, or an expected date so we can keep things \
tidy.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "tj_l2",
    name: "TJ Chase - Level 2 (firmer)",
    context: "chase",
    description:
      "Second touch on a Torah Judaica legacy balance; firmer, still invites the paid-already check.",
    subject:
      "{{company_name}} - follow-up on your Torah Judaica balance ({{overdue_balance}})",
    body: `Hi {{customer_name}},

Following up on the Torah Judaica balance on your account, which is still \
outstanding at {{overdue_balance}} ({{days_overdue}} days past due on \
{{oldest_unpaid_invoice}}).

If you believe this was already paid to Torah Judaica, please reply and we'll \
verify it with their bookkeeper before taking it any further. If not, could \
you let us know when payment will reach us?

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "tj_l3",
    name: "TJ Chase - Level 3 (firm)",
    context: "chase",
    description:
      "Final reminder on a Torah Judaica legacy balance; firm but not legalistic given the handover.",
    subject:
      "{{company_name}} - outstanding Torah Judaica balance ({{overdue_balance}})",
    body: `Hi {{customer_name}},

We've reached out a couple of times now about the Torah Judaica balance on \
your account, still outstanding at {{overdue_balance}} (oldest invoice \
{{oldest_unpaid_invoice}}, {{days_overdue}} days past due).

We'd really like to get this settled. If it has already been paid to Torah \
Judaica, tell us and we'll verify it with their bookkeeper and close it off. \
Otherwise please arrange payment, or reply so we can work out a plan together.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "statement_open_items",
    name: "Statement - Open Items",
    context: "statement",
    description:
      "Cover-note email body for the Statement.pdf attachment. The actual statement table is inside the PDF - this is just the wrapping email.",
    subject:
      "{{company_name}} - Statement of Account ({{open_balance}} open)",
    body: `<p>Hi {{customer_name}},</p>

<p>Please find your statement of account attached. Total open balance \
is <strong>{{open_balance}}</strong>; of that, \
<strong>{{overdue_balance}}</strong> is past due\
{{overdue_credit_note}}.</p>

<p>The attached PDF lists every open invoice with a Pay-now link \
straight to QuickBooks for online payment. Please let me know if \
anything looks incorrect.</p>

<p>Thanks,<br>
{{user_name}}<br>
{{company_name}}</p>`,
  },
  {
    slug: "payment_confirmation",
    name: "Payment confirmation - Thanks",
    context: "payment_confirmation",
    description: "Sent after a payment is received and applied.",
    subject: "{{company_name}} - payment received, thank you",
    body: `Hi {{customer_name}},

Just confirming we've received your recent payment - thank you, much \
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
      "Empty starting point for replies - useful when threading off an inbound email.",
    subject: "Re: {{thread_subject}}",
    body: `Hi {{customer_name}},



Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "invoice_reminder",
    name: "Invoice reminder",
    context: "invoice_reminder",
    description:
      "Per-invoice nudge sent from the customer profile's Invoices tab. The PDF is attached automatically.",
    subject:
      "Reminder: Invoice {{invoice_number}} from {{company_name}}",
    body: `Hi {{customer_name}},

Just a friendly reminder about invoice {{invoice_number}} ({{invoice_total}}, due {{invoice_due_date}}). Could you let me know the status when you get a chance?

I've attached a copy of the invoice for reference.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "rma-approval",
    name: "RMA approval",
    context: "rma_approval",
    description:
      "Sent when an RMA is approved. Includes the RMA number, items, and return-shipping instructions for warehouse-routed RMAs (or replacement note for damage replacements).",
    subject: "Your return request - RMA {{rma_number}}",
    body: `Hi {{customer_name}},

{{approval_opening}}

RMA Number: {{rma_number}}

Items approved for return:
{{items_list}}

{{resolution_body}}

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "rma-denial",
    name: "RMA denial",
    context: "rma_denial",
    description:
      "Sent when an RMA is denied. For seasonal RMAs, includes an eligibility breakdown PDF as attachment (handled at send time).",
    subject: "Your return request - {{customer_name}}",
    body: `Hi {{customer_name}},

Thank you for your return request. After review, we are unable to approve it at this time.

Reason: {{denial_reason}}

{{eligibility_section}}

If you believe this decision should be reviewed, please reply to this email and we'll discuss.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "rma-credit-memo",
    name: "RMA credit memo",
    context: "rma_credit_memo",
    description:
      "Sent when a credit memo is issued for an approved RMA. Includes the credit memo PDF as attachment.",
    subject: "Credit memo {{credit_memo_doc_number}} - RMA {{rma_number}}",
    body: `Hi {{customer_name}},

Please find attached credit memo {{credit_memo_doc_number}} for RMA {{rma_number}}.

Goods credited: {{goods_subtotal}}
{{deductions_section}}
Total credit: {{total_credit_amount}}

This credit has been applied to your account.

Thanks,
{{user_name}}
{{company_name}}`,
  },
  {
    slug: "rma-warehouse-tracking",
    name: "RMA warehouse tracking notification",
    context: "rma_warehouse_tracking",
    description:
      "Sent to the warehouse team when the operator records the return tracking number from the customer.",
    subject: "Inbound return: RMA {{rma_number}} — tracking {{tracking_number}}",
    body: `Hi team,

Customer {{customer_name}} is shipping back RMA {{rma_number}}.

Carrier:  {{tracking_carrier}}
Tracking: {{tracking_number}}

Please flag the parcel when it arrives and confirm receipt against the
warehouse export already on file. Operator notes:

{{tracking_notes}}

Thanks,
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
      // Don't overwrite a user-edited template - only seed missing slugs.
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
