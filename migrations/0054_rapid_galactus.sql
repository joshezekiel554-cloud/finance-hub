CREATE TABLE `user_active_minutes` (
	`user_id` varchar(255) NOT NULL,
	`minute_utc` int NOT NULL,
	CONSTRAINT `user_active_minutes_user_id_minute_utc_pk` PRIMARY KEY(`user_id`,`minute_utc`)
);
--> statement-breakpoint
ALTER TABLE `user_active_minutes` ADD CONSTRAINT `user_active_minutes_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_user_active_minutes_user_minute` ON `user_active_minutes` (`user_id`,`minute_utc`);