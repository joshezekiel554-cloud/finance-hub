-- Hold Orders rules become OVERDUE-based (operator 2026-11-26): hold when an
-- invoice is more than grace_days past its DUE date and the overdue balance
-- is >= min_overdue. Terms are no longer stored on the rule (they're the
-- customer's payment_terms). Existing rules keep their hold DAY:
--   grace = hold_when_invoice_days_over - (customer's real terms days, else the rule's terms_days), floored at 0
-- and map to strict/standard/relaxed only when the numbers match the new
-- built-ins exactly (0/15/30 days, $50 min); everything else becomes custom.
ALTER TABLE `customer_hold_rules` MODIFY COLUMN `preset` enum('standard_30_45','extended_60_75','vip_90_110','strict','never','custom','standard','relaxed') NOT NULL;--> statement-breakpoint
ALTER TABLE `customer_hold_rules` ADD `grace_days` int DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE `customer_hold_rules` ADD `min_overdue` decimal(12,2) DEFAULT '50' NOT NULL;--> statement-breakpoint
UPDATE `customer_hold_rules` r JOIN `customers` c ON c.`id` = r.`customer_id`
SET r.`grace_days` = GREATEST(0, r.`hold_when_invoice_days_over` - COALESCE(
      CASE
        WHEN LOWER(TRIM(c.`payment_terms`)) REGEXP '^due (on|upon) receipt$' THEN 0
        WHEN LOWER(TRIM(c.`payment_terms`)) REGEXP '^net ?[0-9]{1,3}$'
          THEN CAST(REGEXP_REPLACE(LOWER(TRIM(c.`payment_terms`)), '[^0-9]', '') AS UNSIGNED)
      END,
      r.`terms_days`)),
    r.`min_overdue` = r.`min_balance`
WHERE r.`preset` <> 'never';--> statement-breakpoint
UPDATE `customer_hold_rules` SET `grace_days` = 0, `min_overdue` = 0 WHERE `preset` = 'never';--> statement-breakpoint
UPDATE `customer_hold_rules`
SET `preset` = CASE
    WHEN `grace_days` = 0 AND `min_overdue` = 50 THEN 'strict'
    WHEN `grace_days` = 15 AND `min_overdue` = 50 THEN 'standard'
    WHEN `grace_days` = 30 AND `min_overdue` = 50 THEN 'relaxed'
    ELSE 'custom'
  END
WHERE `preset` <> 'never';--> statement-breakpoint
ALTER TABLE `customer_hold_rules` MODIFY COLUMN `preset` enum('strict','standard','relaxed','never','custom') NOT NULL;--> statement-breakpoint
ALTER TABLE `customer_hold_rules` DROP COLUMN `terms_days`;--> statement-breakpoint
ALTER TABLE `customer_hold_rules` DROP COLUMN `hold_when_invoice_days_over`;--> statement-breakpoint
ALTER TABLE `customer_hold_rules` DROP COLUMN `min_balance`;
