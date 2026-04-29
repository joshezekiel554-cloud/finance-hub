CREATE TABLE `comments` (
	`id` varchar(24) NOT NULL,
	`parent_type` varchar(32) NOT NULL,
	`parent_id` varchar(24) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`body` text NOT NULL,
	`edited_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `comments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mentions` (
	`id` varchar(24) NOT NULL,
	`comment_id` varchar(24) NOT NULL,
	`mentioned_user_id` varchar(255) NOT NULL,
	`by_user_id` varchar(255) NOT NULL,
	`parent_type` varchar(32) NOT NULL,
	`parent_id` varchar(24) NOT NULL,
	`read_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mentions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `task_watchers` (
	`task_id` varchar(24) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `task_watchers_task_id_user_id_pk` PRIMARY KEY(`task_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `tasks` MODIFY COLUMN `status` varchar(32) NOT NULL DEFAULT 'open';--> statement-breakpoint
ALTER TABLE `tasks` ADD `tags` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `position` varchar(32) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `comments_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mentions` ADD CONSTRAINT `mentions_comment_id_comments_id_fk` FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mentions` ADD CONSTRAINT `mentions_mentioned_user_id_user_id_fk` FOREIGN KEY (`mentioned_user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mentions` ADD CONSTRAINT `mentions_by_user_id_user_id_fk` FOREIGN KEY (`by_user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_watchers` ADD CONSTRAINT `task_watchers_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_watchers` ADD CONSTRAINT `task_watchers_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_comments_parent` ON `comments` (`parent_type`,`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_comments_user` ON `comments` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_comments_created_at` ON `comments` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mentions_mentioned_read` ON `mentions` (`mentioned_user_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mentions_parent` ON `mentions` (`parent_type`,`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_mentions_comment` ON `mentions` (`comment_id`);--> statement-breakpoint
CREATE INDEX `idx_task_watchers_user` ON `task_watchers` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_position` ON `tasks` (`status`,`position`);