CREATE TABLE `ai_proposals` (
	`id` varchar(24) NOT NULL,
	`category` varchar(32) NOT NULL,
	`entity_type` varchar(64) NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL,
	`candidate_summary` json NOT NULL,
	`drafted_action` json,
	`drafted_preview` text,
	`drafted_at` timestamp,
	`reasoning` text,
	`confidence` decimal(3,2),
	`scan_id` varchar(24) NOT NULL,
	`decided_at` timestamp,
	`decided_by_user_id` varchar(255),
	`snoozed_until` timestamp,
	`executed_at` timestamp,
	`execution_error` text,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_proposals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_scans` (
	`id` varchar(24) NOT NULL,
	`trigger` varchar(16) NOT NULL,
	`triggered_by_user_id` varchar(255),
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`finished_at` timestamp,
	`total_candidates` int NOT NULL DEFAULT 0,
	`proposals_generated` int NOT NULL DEFAULT 0,
	`cost_cents` int NOT NULL DEFAULT 0,
	`error` text,
	CONSTRAINT `ai_scans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `chase_log` ADD `ai_proposal_id` varchar(24);--> statement-breakpoint
ALTER TABLE `activities` ADD `ai_proposal_id` varchar(24);--> statement-breakpoint
ALTER TABLE `email_log` ADD `ai_proposal_id` varchar(24);--> statement-breakpoint
ALTER TABLE `statement_sends` ADD `ai_proposal_id` varchar(24);--> statement-breakpoint
ALTER TABLE `customers` ADD `agent_mode_excluded` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_proposals` ADD CONSTRAINT `ai_proposals_decided_by_user_id_user_id_fk` FOREIGN KEY (`decided_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_scans` ADD CONSTRAINT `ai_scans_triggered_by_user_id_user_id_fk` FOREIGN KEY (`triggered_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_ai_proposals_status_category` ON `ai_proposals` (`status`,`category`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_proposals_entity` ON `ai_proposals` (`entity_type`,`entity_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_ai_proposals_scan` ON `ai_proposals` (`scan_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_scans_started` ON `ai_scans` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_customers_agent_excluded` ON `customers` (`agent_mode_excluded`);--> statement-breakpoint
ALTER TABLE `email_log` ADD CONSTRAINT `fk_email_log_ai_proposal` FOREIGN KEY (`ai_proposal_id`) REFERENCES `ai_proposals`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chase_log` ADD CONSTRAINT `fk_chase_log_ai_proposal` FOREIGN KEY (`ai_proposal_id`) REFERENCES `ai_proposals`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activities` ADD CONSTRAINT `fk_activities_ai_proposal` FOREIGN KEY (`ai_proposal_id`) REFERENCES `ai_proposals`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `statement_sends` ADD CONSTRAINT `fk_statement_sends_ai_proposal` FOREIGN KEY (`ai_proposal_id`) REFERENCES `ai_proposals`(`id`) ON DELETE set null ON UPDATE no action;