ALTER TABLE `orders` ADD `hold_notice_at` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_warned_at` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_cancel_notified_at` timestamp;