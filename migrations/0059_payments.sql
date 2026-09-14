CREATE TABLE `payments` (
	`id` varchar(24) NOT NULL,
	`qb_payment_id` varchar(64) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`doc_number` varchar(64),
	`txn_date` date,
	`total` decimal(12,2) NOT NULL DEFAULT '0',
	`feldart_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`tj_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`unallocated_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`payment_method` varchar(64),
	`last_synced_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_qb_payment_id_unique` UNIQUE(`qb_payment_id`)
);
--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_payments_customer_id` ON `payments` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_payments_txn_date` ON `payments` (`txn_date`);