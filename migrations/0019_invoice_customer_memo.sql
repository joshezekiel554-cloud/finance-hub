-- Customer-facing memo on invoices, synced from QBO
-- Invoice.CustomerMemo.value. Surfaced on the customer profile's
-- Invoices tab as a read-only column. Backfill is a no-op — the
-- next 30-min QBO sync populates the column for all rows.

ALTER TABLE `invoices` ADD `customer_memo` text;
