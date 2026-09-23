-- Platform database, migration 0006: email delivery.
--
-- The outbox now sends through Cloudflare Email Service. A failed attempt
-- waits before the next one (next_attempt_at), and a notice gives up after a
-- few attempts (status 'failed'; the control centre can retry it).

ALTER TABLE notification_outbox ADD COLUMN next_attempt_at INTEGER;
