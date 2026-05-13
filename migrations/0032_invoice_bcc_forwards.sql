CREATE TABLE `invoice_bcc_forwards` (
	`id` varchar(24) NOT NULL,
	`doc_type` enum('invoice','salesreceipt') NOT NULL,
	`doc_id` varchar(64) NOT NULL,
	`customer_id` varchar(24) NOT NULL,
	`target_email` varchar(255) NOT NULL,
	`forwarded_at` timestamp NOT NULL DEFAULT (now()),
	`gmail_message_id` varchar(128),
	CONSTRAINT `invoice_bcc_forwards_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_invoice_bcc_forwards_doc_target` UNIQUE(`doc_type`,`doc_id`,`target_email`)
);
