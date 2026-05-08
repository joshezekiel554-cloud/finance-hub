CREATE TABLE `tag_email_schedules` (
	`id` varchar(24) NOT NULL,
	`tag` varchar(64) NOT NULL,
	`recipient_email` varchar(320) NOT NULL,
	`frequency` enum('daily','weekly','monthly') NOT NULL,
	`content_type` enum('hold_or_upfront_summary') NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`last_sent_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tag_email_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `tag_email_schedules_tag_idx` ON `tag_email_schedules` (`tag`);--> statement-breakpoint
CREATE INDEX `tag_email_schedules_enabled_idx` ON `tag_email_schedules` (`enabled`);