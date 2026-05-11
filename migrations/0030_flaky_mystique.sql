CREATE TABLE `phone_communications` (
	`id` varchar(24) NOT NULL,
	`kind` enum('call_in','call_out','sms_in','sms_out') NOT NULL,
	`customer_id` varchar(24),
	`phone_label_matched` varchar(64),
	`remote_number` varchar(32) NOT NULL,
	`extension_number` varchar(32),
	`extension_name` varchar(128),
	`direction` enum('inbound','outbound') NOT NULL,
	`started_at` timestamp NOT NULL,
	`duration_seconds` int,
	`body` text,
	`transcription` mediumtext,
	`recording_media_id` varchar(64),
	`sms_status` enum('sent','delivered','read','failed'),
	`group_number` varchar(32),
	`source_event_id` varchar(64),
	`dismissed_at` timestamp,
	`dismissed_by_user_id` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `phone_communications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `vocatech_events` (
	`id` varchar(64) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`received_at` timestamp NOT NULL DEFAULT (now()),
	`processed_at` timestamp,
	`raw_payload` json NOT NULL,
	`processing_error` text,
	CONSTRAINT `vocatech_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `vocatech_last_pushed_at` timestamp;--> statement-breakpoint
CREATE INDEX `phone_comm_customer_idx` ON `phone_communications` (`customer_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `phone_comm_unmatched_idx` ON `phone_communications` (`customer_id`,`dismissed_at`,`started_at`);--> statement-breakpoint
CREATE INDEX `phone_comm_remote_idx` ON `phone_communications` (`remote_number`);