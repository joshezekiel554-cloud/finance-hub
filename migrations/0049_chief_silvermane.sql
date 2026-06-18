ALTER TABLE `orders` ADD `hold_state` enum('none','on_hold','released','cancelled') DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_reason` varchar(40);--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_started_at` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_released_at` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_released_by_user_id` varchar(255);--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_alert_thread_id` varchar(255);--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_alert_message_id` varchar(255);