-- Bundle #10 — DB FK-orphan hygiene + notifications dedup.
-- Idempotent: safe to re-run on already-migrated DBs (all DELETEs are no-ops
-- when 0 orphans exist; CREATE INDEX uses IF NOT EXISTS).
--
-- NOTE (Bundle #5 hardening, 2026-05-29): the notifications dedup + UNIQUE index
-- is now ALSO done automatically on every boot by database.js _migrate(), so
-- this script is NO LONGER required before deploy. It remains as optional
-- one-shot FK-orphan cleanup. The orphan-sweep only targets tables that declare
-- a FOREIGN KEY (verified against schema.sql + _migrate DDL).
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
-- NOTE: user_favorites is intentionally NOT swept — it declares NO foreign key
-- (favourites outlive their trend via the snapshot column, by design) and has
-- no user_id column (keyed by chat_id). Sweeping it would wrongly delete saved
-- favourites whose trend has rotated out. Earlier revisions had buggy DELETEs
-- here (user_favorites.user_id doesn't exist) — removed in Bundle #5 hardening.
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
