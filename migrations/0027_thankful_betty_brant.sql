CREATE TABLE `email_rma_links` (
	`gmail_message_id` varchar(64) NOT NULL,
	`rma_id` varchar(24) NOT NULL,
	`source` enum('auto','manual') NOT NULL DEFAULT 'auto',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_rma_links_gmail_message_id_rma_id_pk` PRIMARY KEY(`gmail_message_id`,`rma_id`)
);
--> statement-breakpoint
ALTER TABLE `extensiv_receipts` ADD `dismissed_reason` varchar(64);--> statement-breakpoint
ALTER TABLE `rmas` ADD `damages_note` text;--> statement-breakpoint
CREATE INDEX `email_rma_links_rma_idx` ON `email_rma_links` (`rma_id`);--> statement-breakpoint
CREATE INDEX `email_rma_links_gmail_idx` ON `email_rma_links` (`gmail_message_id`);