CREATE TABLE `credit_memos` (
	`id` varchar(24) NOT NULL,
	`qb_credit_memo_id` varchar(64) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`doc_number` varchar(64),
	`total` decimal(12,2) NOT NULL DEFAULT '0',
	`balance` decimal(12,2) NOT NULL DEFAULT '0',
	`origin` enum('feldart','tj') NOT NULL DEFAULT 'feldart',
	`origin_source` enum('auto','manual','needs_review') NOT NULL DEFAULT 'auto',
	`applied_invoice_id` varchar(24),
	`txn_date` date,
	`last_synced_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `credit_memos_id` PRIMARY KEY(`id`),
	CONSTRAINT `credit_memos_qb_credit_memo_id_unique` UNIQUE(`qb_credit_memo_id`)
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `origin` enum('feldart','tj') DEFAULT 'feldart' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `origin_source` enum('prefix','manual','needs_review') DEFAULT 'prefix' NOT NULL;--> statement-breakpoint
ALTER TABLE `credit_memos` ADD CONSTRAINT `credit_memos_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_memos` ADD CONSTRAINT `credit_memos_applied_invoice_id_invoices_id_fk` FOREIGN KEY (`applied_invoice_id`) REFERENCES `invoices`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_credit_memos_customer_id` ON `credit_memos` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_memos_origin` ON `credit_memos` (`origin`);--> statement-breakpoint
CREATE INDEX `idx_invoices_origin` ON `invoices` (`origin`);--> statement-breakpoint
CREATE INDEX `idx_invoices_origin_balance` ON `invoices` (`origin`,`balance`);--> statement-breakpoint
-- Backfill: invoices whose docNumber begins '2' are Torah Judaica (the rest
-- default to feldart from the column default). origin_source stays 'prefix'.
UPDATE `invoices` SET `origin` = 'tj' WHERE `doc_number` LIKE '2%';