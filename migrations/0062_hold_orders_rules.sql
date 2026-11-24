CREATE TABLE `customer_hold_rules` (
	`customer_id` varchar(24) NOT NULL,
	`preset` enum('standard_30_45','extended_60_75','vip_90_110','strict','never','custom') NOT NULL,
	`terms_days` int NOT NULL,
	`hold_when_invoice_days_over` int NOT NULL,
	`min_balance` decimal(12,2) NOT NULL DEFAULT '0',
	`auto_start_ladder` boolean NOT NULL DEFAULT false,
	`auto_release_on_payment` boolean NOT NULL DEFAULT true,
	`notify_warehouse` boolean NOT NULL DEFAULT true,
	`note` varchar(500),
	`set_by_user_id` varchar(255),
	`set_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customer_hold_rules_customer_id` PRIMARY KEY(`customer_id`)
);
--> statement-breakpoint
ALTER TABLE `customer_hold_rules` ADD CONSTRAINT `customer_hold_rules_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_hold_rules` ADD CONSTRAINT `customer_hold_rules_set_by_user_id_user_id_fk` FOREIGN KEY (`set_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_customer_hold_rules_preset` ON `customer_hold_rules` (`preset`);