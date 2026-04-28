CREATE TABLE `ai_digests` (
	`id` varchar(24) NOT NULL,
	`generated_at` timestamp NOT NULL DEFAULT (now()),
	`model` varchar(64) NOT NULL,
	`input_tokens` int NOT NULL DEFAULT 0,
	`output_tokens` int NOT NULL DEFAULT 0,
	`cache_read_tokens` int NOT NULL DEFAULT 0,
	`cache_creation_tokens` int NOT NULL DEFAULT 0,
	`cost_usd` decimal(10,6) NOT NULL DEFAULT '0',
	`body` text NOT NULL,
	CONSTRAINT `ai_digests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_interactions` (
	`id` varchar(24) NOT NULL,
	`occurred_at` timestamp NOT NULL DEFAULT (now()),
	`user_id` varchar(255),
	`surface` enum('agent_chat','inline_draft_email','inline_summarize','inline_suggest','inline_enhance','task_proposal','background_proposing','chase_digest','email_summary') NOT NULL,
	`model` varchar(64) NOT NULL,
	`tools_called` json,
	`input_tokens` int NOT NULL DEFAULT 0,
	`output_tokens` int NOT NULL DEFAULT 0,
	`cache_read_tokens` int NOT NULL DEFAULT 0,
	`cache_creation_tokens` int NOT NULL DEFAULT 0,
	`cost_usd` decimal(10,6) NOT NULL DEFAULT '0',
	CONSTRAINT `ai_interactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` varchar(24) NOT NULL,
	`occurred_at` timestamp NOT NULL DEFAULT (now()),
	`user_id` varchar(255),
	`action` varchar(128) NOT NULL,
	`entity_type` varchar(64) NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`before` json,
	`after` json,
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `chase_log` (
	`id` varchar(24) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`user_id` varchar(255),
	`chased_at` timestamp NOT NULL DEFAULT (now()),
	`method` enum('email','phone','statement','in_person','ai') NOT NULL,
	`severity` enum('low','medium','high','critical') NOT NULL,
	`ai_digest_id` varchar(24),
	`notes` text,
	CONSTRAINT `chase_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` varchar(24) NOT NULL,
	`kind` enum('qb_full','qb_incremental','gmail_poll','shopify_full','shopify_incremental','monday_mirror') NOT NULL,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`completed_at` timestamp,
	`status` enum('running','ok','failed','partial') NOT NULL DEFAULT 'running',
	`stats` json,
	`error_message` text,
	CONSTRAINT `sync_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `account` (
	`userId` varchar(255) NOT NULL,
	`type` varchar(255) NOT NULL,
	`provider` varchar(255) NOT NULL,
	`providerAccountId` varchar(255) NOT NULL,
	`refresh_token` varchar(255),
	`access_token` varchar(255),
	`expires_at` int,
	`token_type` varchar(255),
	`scope` varchar(255),
	`id_token` varchar(2048),
	`session_state` varchar(255),
	CONSTRAINT `account_provider_providerAccountId_pk` PRIMARY KEY(`provider`,`providerAccountId`)
);
--> statement-breakpoint
CREATE TABLE `authenticator` (
	`credentialID` varchar(255) NOT NULL,
	`userId` varchar(255) NOT NULL,
	`providerAccountId` varchar(255) NOT NULL,
	`credentialPublicKey` varchar(255) NOT NULL,
	`counter` int NOT NULL,
	`credentialDeviceType` varchar(255) NOT NULL,
	`credentialBackedUp` boolean NOT NULL,
	`transports` varchar(255),
	CONSTRAINT `authenticator_userId_credentialID_pk` PRIMARY KEY(`userId`,`credentialID`),
	CONSTRAINT `authenticator_credentialID_unique` UNIQUE(`credentialID`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`sessionToken` varchar(255) NOT NULL,
	`userId` varchar(255) NOT NULL,
	`expires` timestamp NOT NULL,
	CONSTRAINT `session_sessionToken` PRIMARY KEY(`sessionToken`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(255) NOT NULL,
	`name` varchar(255),
	`email` varchar(255),
	`emailVerified` timestamp(3),
	`image` varchar(255),
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `verificationToken` (
	`identifier` varchar(255) NOT NULL,
	`token` varchar(255) NOT NULL,
	`expires` timestamp NOT NULL,
	CONSTRAINT `verificationToken_identifier_token_pk` PRIMARY KEY(`identifier`,`token`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` varchar(24) NOT NULL,
	`shopify_order_id` varchar(64) NOT NULL,
	`customer_id` varchar(24),
	`order_number` varchar(64),
	`order_date` timestamp,
	`notes_raw` text,
	`line_items` json,
	`total` decimal(12,2),
	`item_count` int,
	`status` enum('pending','paid','shipped','fulfilled','cancelled','refunded'),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_shopify_order_id_unique` UNIQUE(`shopify_order_id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` varchar(24) NOT NULL,
	`sku` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`retail_price_gbp` decimal(12,2),
	`b2b_price_gbp` decimal(12,2),
	`shopify_product_id` varchar(64),
	`last_synced_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_sku_unique` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `activities` (
	`id` varchar(24) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`user_id` varchar(255),
	`kind` enum('email_in','email_out','qbo_invoice_sent','qbo_statement_sent','qbo_payment','qbo_credit_memo','balance_change','hold_on','hold_off','terms_changed','manual_note','task_created','task_completed') NOT NULL,
	`occurred_at` timestamp NOT NULL,
	`subject` varchar(512),
	`body` text,
	`body_html` text,
	`source` enum('gmail_poll','app_send','qbo_sync','shopify_sync','user_action','ai_agent') NOT NULL,
	`ref_type` varchar(64),
	`ref_id` varchar(64),
	`meta` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `activities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_log` (
	`id` varchar(24) NOT NULL,
	`gmail_message_id` varchar(128) NOT NULL,
	`thread_id` varchar(128),
	`customer_id` varchar(24),
	`user_id` varchar(255),
	`direction` enum('inbound','outbound') NOT NULL,
	`alias_used` varchar(255),
	`from_address` varchar(255),
	`to_address` varchar(1024),
	`subject` varchar(512),
	`body` text,
	`snippet` varchar(512),
	`classification` varchar(64),
	`email_date` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_log_gmail_message_id_unique` UNIQUE(`gmail_message_id`)
);
--> statement-breakpoint
CREATE TABLE `statement_sends` (
	`id` varchar(24) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`sent_at` timestamp NOT NULL DEFAULT (now()),
	`sent_by_user_id` varchar(255),
	`sent_to_email` varchar(255),
	`qbo_response` json,
	`statement_type` enum('open_items','balance_forward') NOT NULL DEFAULT 'open_items',
	CONSTRAINT `statement_sends_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` varchar(24) NOT NULL,
	`customer_id` varchar(24),
	`assignee_user_id` varchar(255),
	`created_by_user_id` varchar(255),
	`title` varchar(512) NOT NULL,
	`body` text,
	`due_at` timestamp,
	`priority` enum('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
	`status` enum('open','in_progress','done','cancelled') NOT NULL DEFAULT 'open',
	`related_activity_id` varchar(24),
	`ai_proposed` boolean NOT NULL DEFAULT false,
	`completed_at` timestamp,
	`completed_by_user_id` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customer_contacts` (
	`id` varchar(24) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`name` varchar(255),
	`email` varchar(255),
	`role` varchar(64),
	`phone` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `customer_contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` varchar(24) NOT NULL,
	`qb_customer_id` varchar(64),
	`display_name` varchar(255) NOT NULL,
	`primary_email` varchar(255),
	`billing_emails` json,
	`payment_terms` varchar(64),
	`hold_status` enum('active','hold') NOT NULL DEFAULT 'active',
	`shopify_customer_id` varchar(64),
	`monday_item_id` varchar(64),
	`balance` decimal(12,2) NOT NULL DEFAULT '0',
	`overdue_balance` decimal(12,2) NOT NULL DEFAULT '0',
	`internal_notes` text,
	`last_synced_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `customers_qb_customer_id_unique` UNIQUE(`qb_customer_id`)
);
--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` varchar(24) NOT NULL,
	`invoice_id` varchar(24) NOT NULL,
	`sku` varchar(64),
	`description` text,
	`qty` decimal(12,4),
	`unit_price` decimal(12,4),
	`line_total` decimal(12,2),
	`matched_order_id` varchar(24),
	`position` int,
	CONSTRAINT `invoice_lines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` varchar(24) NOT NULL,
	`qb_invoice_id` varchar(64) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`doc_number` varchar(64),
	`issue_date` date,
	`due_date` date,
	`total` decimal(12,2) NOT NULL DEFAULT '0',
	`balance` decimal(12,2) NOT NULL DEFAULT '0',
	`status` enum('draft','sent','partial','paid','void','overdue'),
	`sent_at` timestamp,
	`sent_via` varchar(32),
	`sync_token` varchar(32),
	`last_synced_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoices_qb_invoice_id_unique` UNIQUE(`qb_invoice_id`)
);
--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` varchar(24) NOT NULL,
	`source_email_id` varchar(255),
	`parsed_at` timestamp,
	`customer_match_id` varchar(24),
	`line_items` json,
	`raw_email` text,
	`parse_confidence` float,
	`tracking_number` varchar(128),
	`ship_via` varchar(64),
	`ship_date` date,
	`status` enum('parsed','matched','reconciled','invoiced','ignored','needs_review') NOT NULL DEFAULT 'parsed',
	`notes` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shipments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` varchar(24) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`kind` enum('customer_email_in','task_assigned','task_overdue','ai_proposal','chase_due','system') NOT NULL,
	`customer_id` varchar(24),
	`ref_type` varchar(64),
	`ref_id` varchar(64),
	`payload` json,
	`read_at` timestamp,
	`delivered_in_app` boolean NOT NULL DEFAULT false,
	`delivered_email` boolean NOT NULL DEFAULT false,
	`delivered_push` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` varchar(24) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`endpoint` varchar(1024) NOT NULL,
	`p256dh` varchar(255) NOT NULL,
	`auth` varchar(255) NOT NULL,
	`user_agent` varchar(512),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `push_subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` varchar(24) NOT NULL,
	`provider` enum('quickbooks','gmail','shopify') NOT NULL,
	`external_account_id` varchar(255) NOT NULL,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text,
	`expires_at` timestamp,
	`scope` varchar(1024),
	`installed_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`revoked_at` timestamp,
	`meta` text,
	`pending_state_expires_at` timestamp,
	`pending_state_nonce` varchar(64),
	`pending_state_user_id` varchar(24),
	CONSTRAINT `oauth_tokens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ai_interactions` ADD CONSTRAINT `ai_interactions_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chase_log` ADD CONSTRAINT `chase_log_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chase_log` ADD CONSTRAINT `chase_log_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chase_log` ADD CONSTRAINT `chase_log_ai_digest_id_ai_digests_id_fk` FOREIGN KEY (`ai_digest_id`) REFERENCES `ai_digests`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `account` ADD CONSTRAINT `account_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `authenticator` ADD CONSTRAINT `authenticator_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `session` ADD CONSTRAINT `session_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activities` ADD CONSTRAINT `activities_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activities` ADD CONSTRAINT `activities_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_log` ADD CONSTRAINT `email_log_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_log` ADD CONSTRAINT `email_log_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `statement_sends` ADD CONSTRAINT `statement_sends_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `statement_sends` ADD CONSTRAINT `statement_sends_sent_by_user_id_user_id_fk` FOREIGN KEY (`sent_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assignee_user_id_user_id_fk` FOREIGN KEY (`assignee_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_created_by_user_id_user_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_related_activity_id_activities_id_fk` FOREIGN KEY (`related_activity_id`) REFERENCES `activities`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_completed_by_user_id_user_id_fk` FOREIGN KEY (`completed_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_contacts` ADD CONSTRAINT `customer_contacts_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_matched_order_id_orders_id_fk` FOREIGN KEY (`matched_order_id`) REFERENCES `orders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shipments` ADD CONSTRAINT `shipments_customer_match_id_customers_id_fk` FOREIGN KEY (`customer_match_id`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD CONSTRAINT `push_subscriptions_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_ai_digests_generated_at` ON `ai_digests` (`generated_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_interactions_occurred_at` ON `ai_interactions` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_interactions_surface` ON `ai_interactions` (`surface`);--> statement-breakpoint
CREATE INDEX `idx_ai_interactions_user_id` ON `ai_interactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_occurred_at` ON `audit_log` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_user_id` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_chase_log_customer_id` ON `chase_log` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_chase_log_chased_at` ON `chase_log` (`chased_at`);--> statement-breakpoint
CREATE INDEX `idx_sync_runs_kind_started` ON `sync_runs` (`kind`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_sync_runs_status` ON `sync_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_orders_customer_id` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_orders_order_date` ON `orders` (`order_date`);--> statement-breakpoint
CREATE INDEX `idx_orders_status` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `idx_products_shopify_id` ON `products` (`shopify_product_id`);--> statement-breakpoint
CREATE INDEX `idx_products_name` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `idx_activities_customer_id` ON `activities` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_activities_occurred_at` ON `activities` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_activities_customer_occurred` ON `activities` (`customer_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_activities_kind` ON `activities` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_activities_ref` ON `activities` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `idx_email_log_customer_id` ON `email_log` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_email_log_thread` ON `email_log` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_email_log_email_date` ON `email_log` (`email_date`);--> statement-breakpoint
CREATE INDEX `idx_email_log_direction` ON `email_log` (`direction`);--> statement-breakpoint
CREATE INDEX `idx_statement_sends_customer_id` ON `statement_sends` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_statement_sends_sent_at` ON `statement_sends` (`sent_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_customer_id` ON `tasks` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_assignee_status_due` ON `tasks` (`assignee_user_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_due` ON `tasks` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_customer_contacts_customer_id` ON `customer_contacts` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_customer_contacts_email` ON `customer_contacts` (`email`);--> statement-breakpoint
CREATE INDEX `idx_customers_primary_email` ON `customers` (`primary_email`);--> statement-breakpoint
CREATE INDEX `idx_customers_display_name` ON `customers` (`display_name`);--> statement-breakpoint
CREATE INDEX `idx_customers_hold_status` ON `customers` (`hold_status`);--> statement-breakpoint
CREATE INDEX `idx_customers_shopify_id` ON `customers` (`shopify_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_invoice_lines_invoice_id` ON `invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `idx_invoice_lines_matched_order_id` ON `invoice_lines` (`matched_order_id`);--> statement-breakpoint
CREATE INDEX `idx_invoices_customer_id` ON `invoices` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_invoices_due_date` ON `invoices` (`due_date`);--> statement-breakpoint
CREATE INDEX `idx_invoices_status` ON `invoices` (`status`);--> statement-breakpoint
CREATE INDEX `idx_invoices_doc_number` ON `invoices` (`doc_number`);--> statement-breakpoint
CREATE INDEX `idx_shipments_customer_match_id` ON `shipments` (`customer_match_id`);--> statement-breakpoint
CREATE INDEX `idx_shipments_status` ON `shipments` (`status`);--> statement-breakpoint
CREATE INDEX `idx_shipments_parsed_at` ON `shipments` (`parsed_at`);--> statement-breakpoint
CREATE INDEX `idx_shipments_source_email_id` ON `shipments` (`source_email_id`);--> statement-breakpoint
CREATE INDEX `idx_notifications_user_id` ON `notifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_notifications_user_read` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_created_at` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_push_subscriptions_user_id` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_push_subscriptions_endpoint` ON `push_subscriptions` (`endpoint`);