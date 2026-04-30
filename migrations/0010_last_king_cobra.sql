CREATE TABLE `app_settings` (
	`key` varchar(64) NOT NULL,
	`value` text NOT NULL,
	`description` varchar(512),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`updated_by_user_id` varchar(255),
	CONSTRAINT `app_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `billing_address_line1` varchar(255);--> statement-breakpoint
ALTER TABLE `customers` ADD `billing_address_line2` varchar(255);--> statement-breakpoint
ALTER TABLE `customers` ADD `billing_address_city` varchar(128);--> statement-breakpoint
ALTER TABLE `customers` ADD `billing_address_region` varchar(64);--> statement-breakpoint
ALTER TABLE `customers` ADD `billing_address_postal` varchar(32);--> statement-breakpoint
ALTER TABLE `customers` ADD `billing_address_country` varchar(64);--> statement-breakpoint
ALTER TABLE `app_settings` ADD CONSTRAINT `app_settings_updated_by_user_id_user_id_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;