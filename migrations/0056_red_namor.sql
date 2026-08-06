ALTER TABLE `orders` ADD `hold_ladder_paused_until` timestamp;--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_ladder_pause_note` varchar(300);