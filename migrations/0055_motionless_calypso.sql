CREATE TABLE `time_clock_sessions` (
	`id` varchar(24) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`clock_in_at` timestamp NOT NULL,
	`clock_out_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `time_clock_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `time_clock_sessions` ADD CONSTRAINT `time_clock_sessions_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_time_clock_sessions_user_clock_in` ON `time_clock_sessions` (`user_id`,`clock_in_at`);