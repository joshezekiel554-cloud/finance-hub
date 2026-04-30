CREATE TABLE `email_routing_rules` (
	`id` varchar(24) NOT NULL,
	`tag` varchar(64) NOT NULL,
	`action` enum('bcc_invoice','bcc_statement','cc_invoice','cc_statement') NOT NULL,
	`value` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`created_by_user_id` varchar(255),
	CONSTRAINT `email_routing_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_email_routing_rules_tag_action_value` UNIQUE(`tag`,`action`,`value`)
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `invoice_to_email` varchar(255);--> statement-breakpoint
ALTER TABLE `customers` ADD `invoice_cc_emails` json;--> statement-breakpoint
ALTER TABLE `customers` ADD `statement_to_email` varchar(255);--> statement-breakpoint
ALTER TABLE `customers` ADD `statement_cc_emails` json;--> statement-breakpoint
ALTER TABLE `customers` ADD `tags` json;--> statement-breakpoint
CREATE INDEX `idx_email_routing_rules_tag` ON `email_routing_rules` (`tag`);