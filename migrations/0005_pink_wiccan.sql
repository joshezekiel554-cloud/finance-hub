ALTER TABLE `customers` ADD `customer_type` enum('b2b','b2c');--> statement-breakpoint
CREATE INDEX `idx_customers_customer_type` ON `customers` (`customer_type`);