-- Per-channel emails: TO becomes a JSON array (parity with CC/BCC),
-- BCC arrays added per channel. The fallback paradigm goes away —
-- the per-channel arrays are now the source of truth for who gets
-- emailed; primary_email + billing_emails remain only as legacy
-- display fields seeded from QBO on first sync.

ALTER TABLE `customers` ADD `invoice_to_emails` json;
--> statement-breakpoint
ALTER TABLE `customers` ADD `invoice_bcc_emails` json;
--> statement-breakpoint
ALTER TABLE `customers` ADD `statement_to_emails` json;
--> statement-breakpoint
ALTER TABLE `customers` ADD `statement_bcc_emails` json;
--> statement-breakpoint
UPDATE `customers` SET `invoice_to_emails` = JSON_ARRAY(`invoice_to_email`) WHERE `invoice_to_email` IS NOT NULL AND `invoice_to_email` <> '';
--> statement-breakpoint
UPDATE `customers` SET `invoice_to_emails` = JSON_ARRAY(`primary_email`) WHERE `invoice_to_emails` IS NULL AND `primary_email` IS NOT NULL AND `primary_email` <> '';
--> statement-breakpoint
UPDATE `customers` SET `statement_to_emails` = JSON_ARRAY(`statement_to_email`) WHERE `statement_to_email` IS NOT NULL AND `statement_to_email` <> '';
--> statement-breakpoint
UPDATE `customers` SET `statement_to_emails` = JSON_ARRAY(`primary_email`) WHERE `statement_to_emails` IS NULL AND `primary_email` IS NOT NULL AND `primary_email` <> '';
--> statement-breakpoint
UPDATE `customers` SET `invoice_cc_emails` = `billing_emails` WHERE `invoice_cc_emails` IS NULL AND `billing_emails` IS NOT NULL AND JSON_LENGTH(`billing_emails`) > 0;
--> statement-breakpoint
UPDATE `customers` SET `statement_cc_emails` = `billing_emails` WHERE `statement_cc_emails` IS NULL AND `billing_emails` IS NOT NULL AND JSON_LENGTH(`billing_emails`) > 0;
--> statement-breakpoint
ALTER TABLE `customers` DROP COLUMN `invoice_to_email`;
--> statement-breakpoint
ALTER TABLE `customers` DROP COLUMN `statement_to_email`;
