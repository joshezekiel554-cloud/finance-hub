CREATE TABLE `alias_signatures` (
	`alias_email` varchar(254) NOT NULL,
	`html` text NOT NULL,
	`updated_by_user_id` varchar(255),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `alias_signatures_alias_email` PRIMARY KEY(`alias_email`)
);
--> statement-breakpoint
CREATE TABLE `user_signatures` (
	`id` varchar(24) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`name` varchar(64) NOT NULL,
	`html` text NOT NULL,
	`is_default` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_signatures_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `alias_signatures` ADD CONSTRAINT `alias_signatures_updated_by_user_id_user_id_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_signatures` ADD CONSTRAINT `user_signatures_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_user_signatures_user` ON `user_signatures` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_signatures_default` ON `user_signatures` (`user_id`,`is_default`);