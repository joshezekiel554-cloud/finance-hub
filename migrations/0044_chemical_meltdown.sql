ALTER TABLE `ai_proposals` ADD `origin` enum('feldart','tj');--> statement-breakpoint
ALTER TABLE `customer_ai_cards` ADD `summary_feldart` text;--> statement-breakpoint
ALTER TABLE `customer_ai_cards` ADD `summary_tj` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `bookkeeper_thread_id` varchar(128);