-- Webhook health from reconciliation (docs/PAYMENT_SECURITY.md, issue 5).
--
-- Additive only, like 0010: the code works before this is applied (health
-- simply isn't recorded). Refunds themselves are kept in each workspace's own
-- database (payment_refunds, created by the Worker), next to its links.

-- What the scheduled reconciliation found for an account. missed_by_webhook
-- counts payments or refunds it discovered that no verified webhook had
-- delivered: the defensible signal that the webhook isn't arriving.
ALTER TABLE payment_webhook_health ADD COLUMN reconciled_at INTEGER;
ALTER TABLE payment_webhook_health ADD COLUMN reconcile_checked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_webhook_health ADD COLUMN missed_by_webhook INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_webhook_health ADD COLUMN last_missed_at INTEGER;
ALTER TABLE payment_webhook_health ADD COLUMN reconcile_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_webhook_health ADD COLUMN last_reconcile_error TEXT;
-- The last verified delivery that was applied without an error.
ALTER TABLE payment_webhook_health ADD COLUMN last_processed_ok_at INTEGER;
