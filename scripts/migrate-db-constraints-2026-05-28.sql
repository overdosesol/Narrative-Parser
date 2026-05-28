-- Bundle #10 — DB constraints + retention. Run BEFORE deploying the new code.
-- Idempotent: safe to re-run on already-migrated DBs (all DELETEs are no-ops
-- when 0 orphans exist; CREATE INDEX uses IF NOT EXISTS).
--
-- Required ORDER: this script must run BEFORE the new database.js with
-- foreign_keys=ON. Running it AFTER would trigger CASCADE side-effects.
--
-- Usage on VPS:
--   sqlite3 /path/to/catalyst.db < scripts/migrate-db-constraints-2026-05-28.sql

BEGIN TRANSACTION;

-- 1. Orphan sweep (pre-FK=ON). Each DELETE is a no-op if 0 orphans.
DELETE FROM notifications        WHERE trend_id   NOT IN (SELECT id FROM trends);
DELETE FROM notifications        WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users);
DELETE FROM feedback_votes       WHERE trend_id   NOT IN (SELECT id FROM trends);
DELETE FROM hidden_trends        WHERE trend_id   NOT IN (SELECT id FROM trends);
DELETE FROM user_favorites       WHERE trend_id   NOT IN (SELECT id FROM trends);
DELETE FROM user_favorites       WHERE user_id    NOT IN (SELECT id FROM users);
DELETE FROM alert_score_history  WHERE trend_id   NOT IN (SELECT id FROM trends);
DELETE FROM x_analysis_history   WHERE trend_id   NOT IN (SELECT id FROM trends);
DELETE FROM broadcast_deliveries WHERE broadcast_id NOT IN (SELECT id FROM broadcasts);
DELETE FROM broadcast_deliveries WHERE user_id    NOT IN (SELECT id FROM users);
DELETE FROM payments             WHERE user_id    NOT IN (SELECT id FROM users);

-- 2. Notifications duplicate cleanup — keep oldest row per (trend_id, channel, user_id).
--    Required before UNIQUE INDEX or CREATE INDEX will fail with "UNIQUE constraint violation".
DELETE FROM notifications
WHERE id NOT IN (
  SELECT MIN(id) FROM notifications GROUP BY trend_id, channel, user_id
);

-- 3. UNIQUE compound index (closes DB-007 + PIPE-006 race window).
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications(trend_id, channel, user_id);

COMMIT;

-- Verification queries (operator runs manually after the script):
--   SELECT COUNT(*) FROM notifications;
--   SELECT COUNT(*) FROM (SELECT 1 FROM notifications GROUP BY trend_id, channel, user_id HAVING COUNT(*)>1);  -- expect 0
--   PRAGMA foreign_key_check;  -- expect 0 rows
