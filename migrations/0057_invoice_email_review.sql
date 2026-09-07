CREATE TABLE `invoice_email_dismissals` (
	`invoice_id` varchar(24) NOT NULL,
	`reason` enum('sent_elsewhere','no_invoice_needed','other') NOT NULL,
	`reason_note` text,
	`dismissed_at` timestamp NOT NULL DEFAULT (now()),
	`dismissed_by_user_id` varchar(255),
	CONSTRAINT `invoice_email_dismissals_invoice_id` PRIMARY KEY(`invoice_id`)
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `email_status` varchar(32);--> statement-breakpoint
ALTER TABLE `invoices` ADD `delivery_time` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `delivery_error` varchar(64);--> statement-breakpoint
ALTER TABLE `invoice_email_dismissals` ADD CONSTRAINT `invoice_email_dismissals_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_email_dismissals` ADD CONSTRAINT `invoice_email_dismissals_dismissed_by_user_id_user_id_fk` FOREIGN KEY (`dismissed_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_invoice_email_dismissals_dismissed_at` ON `invoice_email_dismissals` (`dismissed_at`);