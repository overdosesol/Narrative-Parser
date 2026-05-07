-- ──────────────────────────────────────────────────────────────────────────
-- Migration: rename / collapse trend categories (2026-05-08)
--
-- WHAT THIS DOES
--   • elon         → celebrity
--   • tech_drama   → tech
--   • ai_drama     → tech       (collapsed into single tech bucket)
--   • degenerates  → gambling
--   • sports_degen → sports
--   • politics, entertainment, gaming — new buckets, no rename needed
--
-- AFFECTED TABLES
--   • trends            (column `category`)
--   • stage1_examples   (column `category`)
--
-- BEFORE RUNNING: take a backup
--   docker exec catalystparser sqlite3 /app/data/trendscout.db ".backup /app/data/trendscout.db.bak-pre-cat-migration"
--   OR rely on the daily B2 backup that ran today.
--
-- ROLLBACK
--   Restore from the backup above. There is no clean reverse — `tech_drama`
--   and `ai_drama` are merged, so the original split cannot be recovered.
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

-- trends table -------------------------------------------------------------
UPDATE trends SET category = 'celebrity' WHERE category = 'elon';
UPDATE trends SET category = 'tech'      WHERE category = 'tech_drama';
UPDATE trends SET category = 'tech'      WHERE category = 'ai_drama';
UPDATE trends SET category = 'gambling'  WHERE category = 'degenerates';
UPDATE trends SET category = 'sports'    WHERE category = 'sports_degen';

-- stage1_examples table ----------------------------------------------------
-- (Operator-editable seed/calibration examples. Keep ENUM in sync with
--  STAGE1_RESPONSE_SCHEMA in src/analysis/prompts.js.)
UPDATE stage1_examples SET category = 'celebrity' WHERE category = 'elon';
UPDATE stage1_examples SET category = 'tech'      WHERE category = 'tech_drama';
UPDATE stage1_examples SET category = 'tech'      WHERE category = 'ai_drama';
UPDATE stage1_examples SET category = 'gambling'  WHERE category = 'degenerates';
UPDATE stage1_examples SET category = 'sports'    WHERE category = 'sports_degen';

-- Sanity: any rows with legacy categories left? Should be 0 each.
SELECT 'trends_legacy_left' AS check_name, COUNT(*) AS n FROM trends
  WHERE category IN ('elon','tech_drama','ai_drama','degenerates','sports_degen');
SELECT 'examples_legacy_left' AS check_name, COUNT(*) AS n FROM stage1_examples
  WHERE category IN ('elon','tech_drama','ai_drama','degenerates','sports_degen');

-- New distribution
SELECT category, COUNT(*) AS n FROM trends GROUP BY category ORDER BY n DESC;

COMMIT;
