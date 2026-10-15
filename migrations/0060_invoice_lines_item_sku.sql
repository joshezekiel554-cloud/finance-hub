ALTER TABLE `invoice_lines` ADD `qb_item_id` varchar(64);--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `item_name` varchar(255);--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `sku_source` enum('item','description','none');