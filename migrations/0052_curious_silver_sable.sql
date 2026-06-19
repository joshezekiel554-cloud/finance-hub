-- Data migration only (no schema change — app_settings is K/V).
-- order-email-templates feature (spec 2026-06-19): the single legacy
-- `order_hold_alert_recipients` value becomes the warehouse list. Copy it into
-- `order_hold_warehouse_recipients` ONLY when that key is not already set to a
-- non-empty value (idempotent + safe to re-run; never clobbers an operator's
-- explicit warehouse list).
INSERT INTO `app_settings` (`key`, `value`)
SELECT 'order_hold_warehouse_recipients', src.`value`
FROM `app_settings` AS src
WHERE src.`key` = 'order_hold_alert_recipients'
  AND TRIM(src.`value`) <> ''
ON DUPLICATE KEY UPDATE
  `value` = IF(TRIM(`app_settings`.`value`) = '', VALUES(`value`), `app_settings`.`value`);
