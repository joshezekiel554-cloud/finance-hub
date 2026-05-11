CREATE TABLE `rma_items` (
	`id` varchar(24) NOT NULL,
	`rma_id` varchar(24) NOT NULL,
	`position` int NOT NULL,
	`qb_item_id` varchar(64) NOT NULL,
	`sku` varchar(64) NOT NULL,
	`name` varchar(512) NOT NULL,
	`quantity` decimal(12,4) NOT NULL,
	`list_unit_price` decimal(12,4),
	`unit_price` decimal(12,4) NOT NULL,
	`invoice_discount_pct` decimal(6,4),
	`line_total` decimal(12,2) NOT NULL,
	`classification` enum('seasonal_current','seasonal_prior','non_seasonal','damage') NOT NULL,
	`prior_season_id` varchar(24),
	`prior_season_override_reason` text,
	`reason` varchar(512),
	`original_invoice_doc_number` varchar(64),
	`original_invoice_date` date,
	`received_quantity` decimal(12,4),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rma_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rmas` (
	`id` varchar(24) NOT NULL,
	`rma_number` varchar(64),
	`customer_id` varchar(24) NOT NULL,
	`qb_customer_id` varchar(64),
	`return_type` enum('damage','seasonal','non_seasonal') NOT NULL,
	`status` enum('draft','approved','awaiting_warehouse_number','sent_to_warehouse','received','completed','denied','cancelled') NOT NULL DEFAULT 'draft',
	`season_id` varchar(24),
	`total_value` decimal(12,2) NOT NULL DEFAULT '0',
	`eligible_amount` decimal(12,2),
	`return_percentage` decimal(6,2),
	`eligibility_details` json,
	`threshold_overridden` boolean NOT NULL DEFAULT false,
	`override_reason` text,
	`override_by_user_id` varchar(255),
	`denial_reason` text,
	`denial_pdf_drive_id` varchar(255),
	`qbo_credit_memo_id` varchar(64),
	`credit_memo_doc_number` varchar(64),
	`shipping_deduction_amount` decimal(12,2),
	`restocking_fee_amount` decimal(12,2),
	`extensiv_ref` varchar(255),
	`extensiv_tx_number` varchar(64),
	`extensiv_export_generated_at` timestamp,
	`created_via_receipt` boolean NOT NULL DEFAULT false,
	`original_email` text,
	`parsed_confidence` decimal(3,2),
	`notes` text,
	`resolution_type` enum('credit','replacement'),
	`created_by_user_id` varchar(255) NOT NULL,
	`approved_by_user_id` varchar(255),
	`approved_at` timestamp,
	`sent_to_warehouse_at` timestamp,
	`received_at_warehouse_at` timestamp,
	`completed_at` timestamp,
	`denied_at` timestamp,
	`cancelled_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rmas_id` PRIMARY KEY(`id`),
	CONSTRAINT `rmas_rma_number_unique` UNIQUE(`rma_number`)
);
--> statement-breakpoint
CREATE TABLE `seasonal_products` (
	`id` varchar(24) NOT NULL,
	`season_id` varchar(24) NOT NULL,
	`qb_item_id` varchar(64) NOT NULL,
	`sku` varchar(64) NOT NULL,
	`name` varchar(512) NOT NULL,
	`description` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `seasonal_products_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` varchar(24) NOT NULL,
	`name` varchar(255) NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_by_user_id` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seasons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `rma_items` ADD CONSTRAINT `rma_items_rma_id_rmas_id_fk` FOREIGN KEY (`rma_id`) REFERENCES `rmas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rma_items` ADD CONSTRAINT `rma_items_prior_season_id_seasons_id_fk` FOREIGN KEY (`prior_season_id`) REFERENCES `seasons`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rmas` ADD CONSTRAINT `rmas_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rmas` ADD CONSTRAINT `rmas_override_by_user_id_user_id_fk` FOREIGN KEY (`override_by_user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rmas` ADD CONSTRAINT `rmas_created_by_user_id_user_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rmas` ADD CONSTRAINT `rmas_approved_by_user_id_user_id_fk` FOREIGN KEY (`approved_by_user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seasonal_products` ADD CONSTRAINT `seasonal_products_season_id_seasons_id_fk` FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seasons` ADD CONSTRAINT `seasons_created_by_user_id_user_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_rma_items_rma` ON `rma_items` (`rma_id`);--> statement-breakpoint
CREATE INDEX `idx_rma_items_qb_item` ON `rma_items` (`qb_item_id`);--> statement-breakpoint
CREATE INDEX `idx_rma_items_rma_classification` ON `rma_items` (`rma_id`,`classification`);--> statement-breakpoint
CREATE INDEX `idx_rmas_customer` ON `rmas` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_rmas_status` ON `rmas` (`status`);--> statement-breakpoint
CREATE INDEX `idx_rmas_type_created` ON `rmas` (`return_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rmas_extensiv_ref` ON `rmas` (`extensiv_ref`);--> statement-breakpoint
CREATE INDEX `idx_seasonal_products_season` ON `seasonal_products` (`season_id`);--> statement-breakpoint
CREATE INDEX `idx_seasonal_products_qb_item` ON `seasonal_products` (`qb_item_id`);--> statement-breakpoint
CREATE INDEX `idx_seasons_is_active` ON `seasons` (`is_active`);