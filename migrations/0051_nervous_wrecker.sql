CREATE TABLE `order_review_dismissals` (
	`order_id` varchar(24) NOT NULL,
	`dismissed_at` timestamp NOT NULL DEFAULT (now()),
	`dismissed_by_user_id` varchar(255),
	CONSTRAINT `order_review_dismissals_order_id` PRIMARY KEY(`order_id`)
);
--> statement-breakpoint
ALTER TABLE `order_review_dismissals` ADD CONSTRAINT `order_review_dismissals_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_review_dismissals` ADD CONSTRAINT `order_review_dismissals_dismissed_by_user_id_user_id_fk` FOREIGN KEY (`dismissed_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;