CREATE TABLE `agent_conversations` (
	`id` varchar(24) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`title` varchar(256) NOT NULL,
	`summary` text,
	`archived_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_files` (
	`id` varchar(24) NOT NULL,
	`conversation_id` varchar(24),
	`uploader_user_id` varchar(255),
	`filename` varchar(512) NOT NULL,
	`mime` varchar(128) NOT NULL,
	`size_bytes` int NOT NULL,
	`storage_path` varchar(1024) NOT NULL,
	`source_email_log_id` varchar(24),
	`customer_id` varchar(24),
	`rma_id` varchar(24),
	`invoice_id` varchar(24),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` varchar(24) NOT NULL,
	`conversation_id` varchar(24) NOT NULL,
	`role` enum('user','assistant','tool_event') NOT NULL,
	`content` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_reports` (
	`id` varchar(24) NOT NULL,
	`conversation_id` varchar(24),
	`requested_by_user_id` varchar(255),
	`title` varchar(256) NOT NULL,
	`kind` enum('pdf','csv') NOT NULL,
	`storage_path` varchar(1024) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ai_proposals` ADD `source` enum('scan','chat') DEFAULT 'scan' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_conversations` ADD CONSTRAINT `agent_conversations_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_files` ADD CONSTRAINT `agent_files_conversation_id_agent_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_files` ADD CONSTRAINT `agent_files_uploader_user_id_user_id_fk` FOREIGN KEY (`uploader_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_files` ADD CONSTRAINT `agent_files_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD CONSTRAINT `agent_messages_conversation_id_agent_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_reports` ADD CONSTRAINT `agent_reports_conversation_id_agent_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_reports` ADD CONSTRAINT `agent_reports_requested_by_user_id_user_id_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_agent_conversations_user` ON `agent_conversations` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_files_customer` ON `agent_files` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_files_conversation` ON `agent_files` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_conversation` ON `agent_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_reports_created` ON `agent_reports` (`created_at`);