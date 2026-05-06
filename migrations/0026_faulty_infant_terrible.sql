CREATE TABLE `invoice_chases` (
	`id` varchar(24) NOT NULL,
	`invoice_id` varchar(24) NOT NULL,
	`level` tinyint NOT NULL,
	`sent_at` timestamp NOT NULL DEFAULT (now()),
	`sent_by_user_id` varchar(255),
	`email_message_id` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoice_chases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `invoice_chases` ADD CONSTRAINT `invoice_chases_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_chases` ADD CONSTRAINT `invoice_chases_sent_by_user_id_user_id_fk` FOREIGN KEY (`sent_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_invoice_chases_invoice_sent_at` ON `invoice_chases` (`invoice_id`,`sent_at`);