ALTER TABLE `orders` ADD `email` varchar(255);--> statement-breakpoint
ALTER TABLE `orders` ADD `financial_status` varchar(32);--> statement-breakpoint
ALTER TABLE `orders` ADD `fulfillment_status` varchar(32);--> statement-breakpoint
ALTER TABLE `orders` ADD `tracking_number` varchar(128);--> statement-breakpoint
ALTER TABLE `orders` ADD `tracking_url` varchar(512);--> statement-breakpoint
ALTER TABLE `orders` ADD `tracking_company` varchar(128);--> statement-breakpoint
ALTER TABLE `orders` ADD `shipment_status` varchar(32);--> statement-breakpoint
ALTER TABLE `orders` ADD `cancelled_at` timestamp;--> statement-breakpoint
CREATE INDEX `idx_orders_email` ON `orders` (`email`);