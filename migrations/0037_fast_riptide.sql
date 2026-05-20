CREATE TABLE `ai_company_facts` (
	`id` varchar(24) NOT NULL,
	`fact` text NOT NULL,
	`tags` json NOT NULL DEFAULT ('[]'),
	`active` boolean NOT NULL DEFAULT true,
	`created_by_user_id` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ai_company_facts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `ai_customer_context` text;--> statement-breakpoint
ALTER TABLE `ai_company_facts` ADD CONSTRAINT `ai_company_facts_created_by_user_id_user_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_ai_company_facts_active` ON `ai_company_facts` (`active`);