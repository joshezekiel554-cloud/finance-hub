CREATE TABLE `customer_ai_cards` (
	`customer_id` varchar(24) NOT NULL,
	`summary` text NOT NULL,
	`actions` json NOT NULL,
	`generated_at` timestamp NOT NULL DEFAULT (now()),
	`model_used` varchar(64),
	`tokens_in` int,
	`tokens_out` int,
	CONSTRAINT `customer_ai_cards_customer_id` PRIMARY KEY(`customer_id`)
);
--> statement-breakpoint
ALTER TABLE `email_log` ADD `draft_ai_notes` text;--> statement-breakpoint
ALTER TABLE `customer_ai_cards` ADD CONSTRAINT `customer_ai_cards_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;