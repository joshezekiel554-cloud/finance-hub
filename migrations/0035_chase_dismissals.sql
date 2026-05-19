CREATE TABLE `chase_dismissals` (
	`customer_id` varchar(24) NOT NULL,
	`dismissed_at` timestamp NOT NULL DEFAULT (now()),
	`dismissed_by_user_id` varchar(255),
	CONSTRAINT `chase_dismissals_customer_id` PRIMARY KEY(`customer_id`)
);
--> statement-breakpoint
ALTER TABLE `chase_dismissals` ADD CONSTRAINT `chase_dismissals_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chase_dismissals` ADD CONSTRAINT `chase_dismissals_dismissed_by_user_id_user_id_fk` FOREIGN KEY (`dismissed_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;