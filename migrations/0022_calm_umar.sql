CREATE TABLE `rma_photos` (
	`id` varchar(24) NOT NULL,
	`rma_id` varchar(24) NOT NULL,
	`position` int NOT NULL,
	`drive_file_id` varchar(255) NOT NULL,
	`drive_view_url` varchar(2000) NOT NULL,
	`drive_thumbnail_url` varchar(2000),
	`filename` varchar(255) NOT NULL,
	`mime_type` varchar(64) NOT NULL,
	`size_bytes` bigint NOT NULL,
	`uploaded_by_user_id` varchar(255) NOT NULL,
	`uploaded_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rma_photos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `rmas` ADD `drive_folder_id` varchar(255);--> statement-breakpoint
ALTER TABLE `rma_photos` ADD CONSTRAINT `rma_photos_rma_id_rmas_id_fk` FOREIGN KEY (`rma_id`) REFERENCES `rmas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rma_photos` ADD CONSTRAINT `rma_photos_uploaded_by_user_id_user_id_fk` FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_rma_photos_rma` ON `rma_photos` (`rma_id`);