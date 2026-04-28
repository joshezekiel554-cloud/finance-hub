DROP INDEX `idx_oauth_tokens_provider_account` ON `oauth_tokens`;--> statement-breakpoint
ALTER TABLE `oauth_tokens` MODIFY COLUMN `pending_state_user_id` varchar(255);--> statement-breakpoint
ALTER TABLE `oauth_tokens` ADD CONSTRAINT `uq_oauth_tokens_provider_account` UNIQUE(`provider`,`external_account_id`);