-- ---------------------------------------------------------
--  Catalyst Database Schema  v3.0
--  Multi-user SaaS with Solana Pay
-- ---------------------------------------------------------

-- -- Subscription plans -----------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,   -- 'free', 'starter', 'pro', 'elite'
  price_usd   REAL NOT NULL DEFAULT 0,
  sources     TEXT NOT NULL DEFAULT 'reddit,google_trends',  -- comma-separated
  alert_limit INTEGER NOT NULL DEFAULT 5,    -- max alerts/day (-1 = unlimited)
  history_days INTEGER NOT NULL DEFAULT 7,   -- how far back they can query
  api_access  INTEGER NOT NULL DEFAULT 0,    -- 1 = REST API access
  description TEXT
);

-- Default plans (INSERT OR IGNORE so re-running doesn't fail)
INSERT OR IGNORE INTO plans (name, price_usd, sources, alert_limit, history_days, api_access, description) VALUES
  ('free',    0,    'reddit,google_trends', -1, 3,  0, 'Free - Reddit + Google Trends, unlimited alerts'),
  ('test',    5,    'reddit,google_trends,twitter,tiktok,x_trends', -1, 1,  0, 'Test - 1 day, all 5 sources, premium features with daily caps'),
  ('pro',     100,  'reddit,google_trends,twitter,tiktok,x_trends', -1, 30, 1, 'Pro - 30 days, all 5 sources, premium features (high anti-spam caps)'),
  ('admin',   0,    'reddit,google_trends,twitter,tiktok,x_trends', -1, -1, 1, 'Admin - unlimited everything');

-- -- Users (multi-user via Telegram) ----------------------
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  language         TEXT NOT NULL DEFAULT 'en',    -- 'en' or 'ru'
  plan_id          INTEGER NOT NULL DEFAULT 1 REFERENCES plans(id),
  status           TEXT NOT NULL DEFAULT 'active',  -- active, paused, suspended
  alert_threshold  INTEGER NOT NULL DEFAULT 60,
  disabled_sources TEXT DEFAULT '[]',               -- JSON array of disabled source names
  alert_count_today INTEGER NOT NULL DEFAULT 0,
  alert_reset_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  subscription_expires_at DATETIME,
  pinned_broadcast_message_id INTEGER,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_chat_id ON users(telegram_chat_id);

-- -- Trends -----------------------------------------------
CREATE TABLE IF NOT EXISTS trends (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id      TEXT,
  source           TEXT NOT NULL,
  title            TEXT NOT NULL,
  original_title   TEXT,
  description      TEXT,
  url              TEXT,
  score            INTEGER DEFAULT 0,
  category         TEXT,
  sentiment        TEXT,
  ai_explanation   TEXT,
  predicted_lifespan TEXT,
  raw_metrics      TEXT,
  tg_message_id    INTEGER,
  user_feedback    INTEGER DEFAULT 0,
  first_seen_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  times_seen       INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_trends_title       ON trends(title);
CREATE INDEX IF NOT EXISTS idx_trends_source      ON trends(source);
CREATE INDEX IF NOT EXISTS idx_trends_first_seen  ON trends(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_trends_external_id ON trends(external_id);
CREATE INDEX IF NOT EXISTS idx_trends_tg_message_id ON trends(tg_message_id);

-- -- Notifications (per-user tracking) --------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trend_id   INTEGER NOT NULL,
  channel    TEXT NOT NULL,
  user_id    INTEGER,
  status     TEXT DEFAULT 'sent',
  sent_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (trend_id) REFERENCES trends(id),
  FOREIGN KEY (user_id)  REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_trend ON notifications(trend_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user  ON notifications(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(trend_id, channel, user_id);

-- -- Payments (Solana Pay tracking) -----------------------
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  plan_name     TEXT NOT NULL,
  amount        REAL NOT NULL,
  currency      TEXT NOT NULL,           -- 'SOL' or 'USDC'
  reference     TEXT NOT NULL UNIQUE,    -- Solana Pay reference key
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending, confirmed, expired
  tx_signature  TEXT,                    -- Solana transaction signature
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  confirmed_at  DATETIME,
  expires_at    DATETIME
);

CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_user      ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status    ON payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_tx_signature_unique
  ON payments(tx_signature)
  WHERE tx_signature IS NOT NULL;

-- -- Broadcasts (admin mass messages history) ----------------
CREATE TABLE IF NOT EXISTS broadcasts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_html  TEXT NOT NULL,
  plan_filter   TEXT NOT NULL DEFAULT 'all',
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS broadcast_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id  INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  chat_id       TEXT NOT NULL,
  message_id    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'sent',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(broadcast_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_broadcast ON broadcast_deliveries(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_user ON broadcast_deliveries(user_id);

-- ── Bundle #2 (2026-06-07): observability persistence ────────────────────
-- Replaces in-memory state that previously lost on restart.
-- See docs/superpowers/specs/2026-06-07-observability-persistence-design.md

-- admin_audit_log: plan changes + admin actions. Forever retention.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL DEFAULT (datetime('now')),
  actor_user_id   INTEGER,                          -- admin doing the action (NULL = system)
  actor_kind      TEXT    NOT NULL,                 -- 'admin' | 'system' | 'user_self'
  event_type      TEXT    NOT NULL,                 -- 'plan_grant_admin' | 'plan_revoke' | 'plan_upgrade' | etc.
  target_user_id  INTEGER,                          -- the user the action affected
  payload_json    TEXT,                             -- JSON: structured payload
  success         INTEGER NOT NULL DEFAULT 1        -- 1 | 0
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts     ON admin_audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_event  ON admin_audit_log(event_type, ts DESC);

-- alert_decisions: alert dispatcher decisions. 14d retention.
CREATE TABLE IF NOT EXISTS alert_decisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL DEFAULT (datetime('now')),
  trend_id     INTEGER,
  user_id      INTEGER,
  source       TEXT,                                -- 'reddit' | 'twitter' | 'google_trends' | ...
  reason       TEXT    NOT NULL,                    -- 'sent' | 'skipped_seen' | 'skipped_score' | etc.
  gates_json   TEXT,                                -- full gate evaluations
  weights_json TEXT,                                -- optional weight breakdown
  sent         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alert_decisions_ts    ON alert_decisions(ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_decisions_user  ON alert_decisions(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_decisions_trend ON alert_decisions(trend_id, ts DESC);

-- feature_usage_log: per-hit event log for rolling cost caps. 7d retention.
CREATE TABLE IF NOT EXISTS feature_usage_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL DEFAULT (datetime('now')),
  user_id   INTEGER NOT NULL,
  feature   TEXT    NOT NULL                        -- 'manualAnalysis' | 'catalyst'
);
CREATE INDEX IF NOT EXISTS idx_feature_usage_user_feature_ts ON feature_usage_log(user_id, feature, ts DESC);
