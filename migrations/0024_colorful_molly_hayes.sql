ALTER TABLE `rmas` ADD `tracking_number` varchar(128);--> statement-breakpoint
ALTER TABLE `rmas` ADD `tracking_carrier` varchar(64);--> statement-breakpoint
ALTER TABLE `rmas` ADD `tracking_saved_at` timestamp;