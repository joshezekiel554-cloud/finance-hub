CREATE TABLE `extensiv_receipts` (
	`id` varchar(24) NOT NULL,
	`rma_id` varchar(24),
	`match_kind` enum('exact_tx_number','exact_ref_string','fuzzy_customer_sku','no_match') NOT NULL,
	`match_confidence` decimal(3,2),
	`tx_number` varchar(64),
	`ref_string` varchar(255),
	`parsed_items_json` json,
	`inferred_customer_name` varchar(255),
	`gmail_message_id` varchar(255) NOT NULL,
	`dismissed_at` timestamp,
	`dismissed_by_user_id` varchar(255),
	`classified_at` timestamp NOT NULL DEFAULT (now()),
	`confirmed_at` timestamp,
	`confirmed_by_user_id` varchar(255),
	CONSTRAINT `extensiv_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `extensiv_receipts_gmail_message_id_unique` UNIQUE(`gmail_message_id`)
);
--> statement-breakpoint
ALTER TABLE `ai_interactions` MODIFY COLUMN `surface` enum('agent_chat','inline_draft_email','inline_summarize','inline_suggest','inline_enhance','task_proposal','background_proposing','chase_digest','email_summary','customer_summary','action_plan','return_email_parse') NOT NULL;--> statement-breakpoint
ALTER TABLE `extensiv_receipts` ADD CONSTRAINT `extensiv_receipts_rma_id_rmas_id_fk` FOREIGN KEY (`rma_id`) REFERENCES `rmas`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `extensiv_receipts` ADD CONSTRAINT `extensiv_receipts_dismissed_by_user_id_user_id_fk` FOREIGN KEY (`dismissed_by_user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `extensiv_receipts` ADD CONSTRAINT `extensiv_receipts_confirmed_by_user_id_user_id_fk` FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_extensiv_receipts_rma` ON `extensiv_receipts` (`rma_id`);--> statement-breakpoint
CREATE INDEX `idx_extensiv_receipts_classified` ON `extensiv_receipts` (`classified_at`);