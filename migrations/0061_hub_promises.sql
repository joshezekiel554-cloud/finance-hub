CREATE TABLE `promise_scans` (
	`activity_id` varchar(24) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`message_id` varchar(128),
	`email_at` timestamp NOT NULL,
	`result` enum('promise','none','invalid') NOT NULL,
	`promised_date` date,
	`quote` varchar(200),
	`model` varchar(64),
	`scanned_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `promise_scans_activity_id` PRIMARY KEY(`activity_id`)
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `promised_pay_by` date;--> statement-breakpoint
ALTER TABLE `customers` ADD `promise_note` varchar(300);--> statement-breakpoint
ALTER TABLE `customers` ADD `promise_set_by` varchar(255);--> statement-breakpoint
ALTER TABLE `customers` ADD `promise_set_at` timestamp;--> statement-breakpoint
ALTER TABLE `promise_scans` ADD CONSTRAINT `promise_scans_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_promise_scans_customer` ON `promise_scans` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_promise_scans_email_at` ON `promise_scans` (`email_at`);