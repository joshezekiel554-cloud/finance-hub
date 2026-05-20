CREATE TABLE `ai_learned_corrections` (
	`id` varchar(24) NOT NULL,
	`correction` text NOT NULL,
	`tags` json NOT NULL DEFAULT ('[]'),
	`status` varchar(16) NOT NULL DEFAULT 'proposed',
	`source_proposal_ids` json NOT NULL DEFAULT ('[]'),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`decided_by_user_id` varchar(255),
	`decided_at` timestamp,
	CONSTRAINT `ai_learned_corrections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ai_learned_corrections` ADD CONSTRAINT `ai_learned_corrections_decided_by_user_id_user_id_fk` FOREIGN KEY (`decided_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_ai_learned_corrections_status` ON `ai_learned_corrections` (`status`);