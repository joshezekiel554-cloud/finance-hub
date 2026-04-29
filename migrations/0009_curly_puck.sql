CREATE TABLE `email_templates` (
	`id` varchar(24) NOT NULL,
	`slug` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`context` varchar(32) NOT NULL,
	`subject` varchar(512) NOT NULL,
	`body` text NOT NULL,
	`description` varchar(512),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_templates_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE INDEX `idx_email_templates_context` ON `email_templates` (`context`);--> statement-breakpoint
CREATE INDEX `idx_email_templates_slug` ON `email_templates` (`slug`);