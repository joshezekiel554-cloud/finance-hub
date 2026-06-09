ALTER TABLE `invoices` ADD `dispute_state` enum('verifying','confirmed_paid','confirmed_unpaid');--> statement-breakpoint
ALTER TABLE `invoices` ADD `dispute_claimed_at` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `dispute_note` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `dispute_updated_by` varchar(255);--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_dispute_updated_by_user_id_fk` FOREIGN KEY (`dispute_updated_by`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_invoices_dispute_state` ON `invoices` (`dispute_state`);