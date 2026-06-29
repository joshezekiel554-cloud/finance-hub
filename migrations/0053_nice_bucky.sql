ALTER TABLE `orders` ADD `hold_note` varchar(500);--> statement-breakpoint
ALTER TABLE `orders` ADD `hold_ladder_enabled` boolean DEFAULT true NOT NULL;