CREATE TABLE `dismissed_shipments` (
	`gmail_id` varchar(64) NOT NULL,
	`reason` enum('b2c_paid_upfront','etsy_faire','other') NOT NULL,
	`reason_note` text,
	`dismissed_at` timestamp NOT NULL DEFAULT (now()),
	`dismissed_by_user_id` varchar(255),
	CONSTRAINT `dismissed_shipments_gmail_id` PRIMARY KEY(`gmail_id`)
);
--> statement-breakpoint
ALTER TABLE `push_subscriptions` MODIFY COLUMN `endpoint` varchar(512) NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_dismissed_shipments_dismissed_at` ON `dismissed_shipments` (`dismissed_at`);