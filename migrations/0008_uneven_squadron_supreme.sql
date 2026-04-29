ALTER TABLE `email_log` ADD `actioned_at` timestamp;--> statement-breakpoint
ALTER TABLE `email_log` ADD `actioned_by_user_id` varchar(255);--> statement-breakpoint
ALTER TABLE `email_log` ADD CONSTRAINT `email_log_actioned_by_user_id_user_id_fk` FOREIGN KEY (`actioned_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_email_log_customer_actioned` ON `email_log` (`customer_id`,`actioned_at`,`email_date`);