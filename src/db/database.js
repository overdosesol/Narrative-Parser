import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TrendDatabase {
  constructor(dbPath, logger) {
    this.logger = logger;
    this.dbPath = dbPath;

    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
    this.logger.info('Database initialized', { path: dbPath });
  }

  _migrate() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    this.db.exec(schema);

    // Safe migrations for existing DBs
    const addIfMissing = (table, column, definition) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.find(c => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        this.logger.info(`DB migration: added column ${column} to ${table}`);
      }
    };

    // Trends table migrations
    addIfMissing('trends', 'tg_message_id', 'INTEGER');
    addIfMissing('trends', 'user_feedback', 'INTEGER DEFAULT 0');
    addIfMissing('trends', 'original_title', 'TEXT');

    // Users table migrations (v3.0)
    addIfMissing('users', 'language', "TEXT NOT NULL DEFAULT 'en'");
    addIfMissing('users', 'alert_threshold', 'INTEGER NOT NULL DEFAULT 60');
    addIfMissing('users', 'disabled_sources', "TEXT DEFAULT '[]'");
    addIfMissing('users', 'subscription_expires_at', 'DATETIME');
    addIfMissing('users', 'telegram_username', 'TEXT');
    addIfMissing('users', 'pinned_broadcast_message_id', 'INTEGER');

    // Notifications user_id migration
    addIfMissing('notifications', 'user_id', 'INTEGER');

    // Pipeline status — tracks how far a trend got through the analysis pipeline
    // 'save_only' = clusterer skipped AI scoring; 'scored' = went through stage 1 AI
    addIfMissing('trends', 'pipeline_status', "TEXT NOT NULL DEFAULT 'save_only'");

    // Settings key-value store
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Weighted feedback votes (one row per user per trend)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_votes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        trend_id   INTEGER NOT NULL REFERENCES trends(id),
        chat_id    TEXT NOT NULL,
        vote       INTEGER NOT NULL,   -- +1 liked, -1 disliked
        weight     REAL NOT NULL DEFAULT 1.0,
        plan_name  TEXT NOT NULL DEFAULT 'free',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(trend_id, chat_id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_votes_trend ON feedback_votes(trend_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_votes_chat  ON feedback_votes(chat_id)`);

    // Auth sessions (Telegram-bot-verified login for the dashboard)
    // ── Flow ───────────────────────────────────────────────────────────────────
    //   1) Browser calls /api/auth/initiate     → row with session_id only
    //   2) Bot receives /start auth_<session_id>→ row gets chat_id + 6-digit code
    //   3) Browser calls /api/auth/verify       → row gets long-lived token,
    //                                             code is cleared
    //   4) Browser sends Authorization: Bearer <token> on all requests;
    //      middleware looks up chat_id via the token row
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        session_id       TEXT PRIMARY KEY,
        chat_id          TEXT,
        code             TEXT,
        code_expires_at  DATETIME,
        token            TEXT,
        token_expires_at DATETIME,
        user_agent       TEXT,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        verified_at      DATETIME
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_token   ON auth_sessions(token)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_chat    ON auth_sessions(chat_id)`);

    // Housekeeping — prune anything that's fully expired and has no token
    try {
      this.db.prepare(
        `DELETE FROM auth_sessions
         WHERE token IS NULL
           AND created_at < datetime('now', '-1 day')`
      ).run();
    } catch (e) { /* best-effort */ }

    // Plan normalization (v3 pricing/policy)
    const normalizePlans = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO plans (name, price_usd, sources, alert_limit, history_days, api_access, description)
        VALUES ('free', 0, 'reddit,google_trends', -1, 3, 0, 'Free tier - unlimited alerts')
        ON CONFLICT(name) DO UPDATE SET
          price_usd=excluded.price_usd,
          sources=excluded.sources,
          alert_limit=excluded.alert_limit,
          history_days=excluded.history_days,
          api_access=excluded.api_access,
          description=excluded.description
      `).run();

      this.db.prepare(`
        INSERT INTO plans (name, price_usd, sources, alert_limit, history_days, api_access, description)
        VALUES ('test', 5, 'reddit,google_trends,twitter,tiktok', -1, 1, 0, 'Test plan - one-time, 1 day, all sources, no X analysis')
        ON CONFLICT(name) DO UPDATE SET
          price_usd=excluded.price_usd,
          sources=excluded.sources,
          alert_limit=excluded.alert_limit,
          history_days=excluded.history_days,
          api_access=excluded.api_access,
          description=excluded.description
      `).run();

      this.db.prepare(`
        INSERT INTO plans (name, price_usd, sources, alert_limit, history_days, api_access, description)
        VALUES ('pro', 100, 'reddit,google_trends,twitter,tiktok', -1, 30, 1, 'Pro - 30 days, unlimited alerts, all sources')
        ON CONFLICT(name) DO UPDATE SET
          price_usd=excluded.price_usd,
          sources=excluded.sources,
          alert_limit=excluded.alert_limit,
          history_days=excluded.history_days,
          api_access=excluded.api_access,
          description=excluded.description
      `).run();

      this.db.prepare(`
        INSERT INTO plans (name, price_usd, sources, alert_limit, history_days, api_access, description)
        VALUES ('admin', 0, 'reddit,google_trends,twitter,tiktok', -1, -1, 1, 'Admin plan - unlimited everything')
        ON CONFLICT(name) DO UPDATE SET
          price_usd=excluded.price_usd,
          sources=excluded.sources,
          alert_limit=excluded.alert_limit,
          history_days=excluded.history_days,
          api_access=excluded.api_access,
          description=excluded.description
      `).run();

      this.db.prepare(`UPDATE plans SET alert_limit = -1`).run();

      const pro = this.db.prepare(`SELECT id FROM plans WHERE name='pro'`).get();
      if (pro?.id) {
        this.db.prepare(`
          UPDATE users
          SET plan_id = ?
          WHERE plan_id IN (SELECT id FROM plans WHERE name IN ('starter','elite'))
        `).run(pro.id);
      }

      this.db.prepare(`DELETE FROM plans WHERE name IN ('starter','elite')`).run();
    });
    normalizePlans();

    // Migration: avatar cache for Telegram profile photos
    // (SQLite has no IF NOT EXISTS for ADD COLUMN — check via pragma)
    try {
      const cols = this.db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
      if (!cols.includes('avatar_file_id')) {
        this.db.prepare(`ALTER TABLE users ADD COLUMN avatar_file_id TEXT`).run();
      }
      if (!cols.includes('avatar_file_unique_id')) {
        this.db.prepare(`ALTER TABLE users ADD COLUMN avatar_file_unique_id TEXT`).run();
      }
      if (!cols.includes('avatar_checked_at')) {
        this.db.prepare(`ALTER TABLE users ADD COLUMN avatar_checked_at DATETIME`).run();
      }
    } catch (e) {
      this.logger.warn(`Avatar column migration skipped: ${e.message}`);
    }

    this.logger.info('Database schema applied');
  }

  /**
   * Persist a user's latest Telegram profile-photo file reference.
   * `fileUniqueId` stays stable across Telegram CDN rotations — use it to
   * invalidate on-disk caches when the user changes their photo.
   */
  setUserAvatar(userId, fileId, fileUniqueId) {
    this.db.prepare(`
      UPDATE users
         SET avatar_file_id        = ?,
             avatar_file_unique_id = ?,
             avatar_checked_at     = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(fileId || null, fileUniqueId || null, userId);
  }

  // ── User Management ───────────────────────────────────────────────────────

  /**
   * Get or create a user by Telegram chat ID
   */
  getOrCreateUser(chatId, username = null) {
    let user = this.db.prepare(`SELECT u.*, p.name as plan_name, p.sources as plan_sources, p.alert_limit, p.history_days
      FROM users u JOIN plans p ON u.plan_id = p.id
      WHERE u.telegram_chat_id = ?`).get(String(chatId));

    if (!user) {
      this.db.prepare(`
        INSERT INTO users (telegram_chat_id, telegram_username, language, plan_id, status)
        VALUES (?, ?, 'en', 1, 'active')
      `).run(String(chatId), username);
      user = this.db.prepare(`SELECT u.*, p.name as plan_name, p.sources as plan_sources, p.alert_limit, p.history_days
        FROM users u JOIN plans p ON u.plan_id = p.id
        WHERE u.telegram_chat_id = ?`).get(String(chatId));
      this.logger.info(`New user registered: ${chatId} (@${username || 'unknown'})`);
    } else {
      // Update last seen and username
      this.db.prepare(`UPDATE users SET last_seen_at = CURRENT_TIMESTAMP, telegram_username = COALESCE(?, telegram_username) WHERE id = ?`)
        .run(username, user.id);
    }
    return user;
  }

  /**
   * Get user by Telegram chat ID (without creating)
   */
  getUserByChatId(chatId) {
    return this.db.prepare(`SELECT u.*, p.name as plan_name, p.sources as plan_sources, p.alert_limit, p.history_days
      FROM users u JOIN plans p ON u.plan_id = p.id
      WHERE u.telegram_chat_id = ?`).get(String(chatId));
  }

  /**
   * Get all active users (for sending alerts)
   */
  getActiveUsers() {
    return this.db.prepare(`SELECT u.*, p.name as plan_name, p.sources as plan_sources, p.alert_limit, p.history_days
      FROM users u JOIN plans p ON u.plan_id = p.id
      WHERE u.status = 'active'`).all();
  }

  /**
   * Update user setting
   */
  updateUser(userId, field, value) {
    const allowed = ['language', 'alert_threshold', 'disabled_sources', 'status', 'plan_id', 'subscription_expires_at', 'alert_count_today'];
    if (!allowed.includes(field)) throw new Error(`Cannot update field: ${field}`);
    this.db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(value, userId);
  }

  /**
   * Reset daily alert counts for all users (call at midnight)
   */
  resetDailyAlertCounts() {
    this.db.prepare(`UPDATE users SET alert_count_today = 0, alert_reset_at = CURRENT_TIMESTAMP`).run();
  }

  /**
   * Increment alert count for a user
   */
  incrementAlertCount(userId) {
    this.db.prepare(`UPDATE users SET alert_count_today = alert_count_today + 1 WHERE id = ?`).run(userId);
  }

  // ── Auth (Telegram-bot login) ─────────────────────────────────────────────

  /**
   * Step 1 — browser starts a new auth session. Returns the short public id
   * embedded in the Telegram deep-link (t.me/<bot>?start=auth_<sessionId>).
   * Session stays empty until the bot attaches a code.
   */
  createAuthSession(userAgent = null) {
    // 16 bytes = 32 hex chars — enough entropy, short enough for deep-links
    const sessionId = crypto.randomBytes(16).toString('hex');
    this.db.prepare(`
      INSERT INTO auth_sessions (session_id, user_agent) VALUES (?, ?)
    `).run(sessionId, userAgent);
    return sessionId;
  }

  /**
   * Step 2 — bot confirms the user and stores a 6-digit code tied to the
   * session + the chat_id that scanned the deep-link. Subsequent requests
   * overwrite the code (e.g. user reopens the link).
   */
  attachAuthCode(sessionId, chatId, ttlMs = 5 * 60 * 1000) {
    const session = this.db.prepare(
      `SELECT * FROM auth_sessions WHERE session_id = ?`
    ).get(sessionId);
    if (!session) return null;
    // Already verified — refuse (security)
    if (session.token) return { alreadyVerified: true };

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + ttlMs).toISOString();
    this.db.prepare(`
      UPDATE auth_sessions
         SET chat_id = ?, code = ?, code_expires_at = ?
       WHERE session_id = ?
    `).run(String(chatId), code, expires, sessionId);
    return { code, expiresAt: Date.now() + ttlMs };
  }

  /**
   * Non-sensitive status check — returns only whether a code is waiting,
   * never the code itself.
   */
  getAuthSessionStatus(sessionId) {
    const s = this.db.prepare(
      `SELECT chat_id, code, code_expires_at, token
         FROM auth_sessions WHERE session_id = ?`
    ).get(sessionId);
    if (!s) return { exists: false };
    if (s.token) return { exists: true, verified: true };
    const hasCode = !!(s.chat_id && s.code &&
      s.code_expires_at && new Date(s.code_expires_at).getTime() > Date.now());
    return { exists: true, verified: false, codeReady: hasCode };
  }

  /**
   * Step 3 — browser posts the code. On success: issues a long-lived token,
   * clears the code, returns { token, user }. Constant-time code compare to
   * resist timing attacks. Rate-limiting is the caller's responsibility.
   */
  verifyAuthCode(sessionId, code, ttlDays = 30) {
    const s = this.db.prepare(
      `SELECT * FROM auth_sessions WHERE session_id = ?`
    ).get(sessionId);
    if (!s || !s.chat_id || !s.code) return null;
    if (!s.code_expires_at || new Date(s.code_expires_at).getTime() < Date.now()) return null;

    const a = Buffer.from(String(s.code));
    const b = Buffer.from(String(code || ''));
    if (a.length !== b.length) return null;
    try { if (!crypto.timingSafeEqual(a, b)) return null; } catch { return null; }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + ttlDays * 24 * 3600_000).toISOString();

    this.db.prepare(`
      UPDATE auth_sessions
         SET token = ?, token_expires_at = ?, verified_at = CURRENT_TIMESTAMP,
             code = NULL, code_expires_at = NULL
       WHERE session_id = ?
    `).run(token, expires, sessionId);

    const user = this.getUserByChatId(s.chat_id);
    return { token, tokenExpiresAt: expires, chatId: s.chat_id, user };
  }

  /**
   * Middleware helper — resolve a bearer token to its owning user row.
   * Returns null for missing/expired/unknown tokens.
   */
  getUserByAuthToken(token) {
    if (!token || typeof token !== 'string') return null;
    const row = this.db.prepare(
      `SELECT chat_id, token_expires_at
         FROM auth_sessions
        WHERE token = ?`
    ).get(token);
    if (!row) return null;
    if (row.token_expires_at && new Date(row.token_expires_at).getTime() < Date.now()) return null;
    return this.getUserByChatId(row.chat_id);
  }

  /**
   * Logout — invalidate a single token.
   */
  revokeAuthToken(token) {
    if (!token) return 0;
    return this.db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token).changes;
  }

  /**
   * Check if user can receive more alerts today
   */
  canUserReceiveAlert(user) {
    if (user.alert_limit === -1) return true; // unlimited
    return user.alert_count_today < user.alert_limit;
  }

  /**
   * Check if user's subscription is expired
   */
  isSubscriptionExpired(user) {
    if (!user.subscription_expires_at) return false; // free plan doesn't expire
    if (user.plan_name === 'free') return false;
    return new Date(user.subscription_expires_at) < new Date();
  }

  // ── Payment Management ─────────────────────────────────────────────────────

  /**
   * Create a new payment record
   */
  createPayment(userId, planName, amount, currency, reference, expiresAt) {
    return this.db.prepare(`
      INSERT INTO payments (user_id, plan_name, amount, currency, reference, status, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(userId, planName, amount, currency, reference, expiresAt);
  }

  /**
   * Get pending payment by reference
   */
  getPaymentByReference(reference) {
    return this.db.prepare(`SELECT * FROM payments WHERE reference = ?`).get(reference);
  }

  /**
   * Get pending payments (for monitoring)
   */
  getPendingPayments() {
    return this.db.prepare(`
      SELECT * FROM payments
      WHERE status = 'pending'
        AND COALESCE(datetime(expires_at), expires_at) > datetime('now')
    `).all();
  }

  /**
   * Confirm a payment
   */
  confirmPayment(reference, txSignature) {
    this.db.prepare(`
      UPDATE payments SET status = 'confirmed', tx_signature = ?, confirmed_at = CURRENT_TIMESTAMP
      WHERE reference = ?
    `).run(txSignature, reference);
  }

  /**
   * Atomically confirm payment and upgrade user plan.
   * Returns upgraded payment row or null if payment is not eligible.
   */
  confirmPaymentAndUpgrade(reference, txSignature, durationDays = 30) {
    const runTxn = this.db.transaction((ref, sig, days) => {
      const payment = this.db.prepare(`SELECT * FROM payments WHERE reference = ?`).get(ref);
      if (!payment) return null;
      if (payment.status !== 'pending') return null;

      this.db.prepare(`
        UPDATE payments
        SET status = 'confirmed', tx_signature = ?, confirmed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sig, payment.id);

      const plan = this.db.prepare(`SELECT id FROM plans WHERE name = ?`).get(payment.plan_name);
      if (!plan) throw new Error(`Plan not found: ${payment.plan_name}`);

      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`
        UPDATE users
        SET plan_id = ?, subscription_expires_at = ?, status = 'active'
        WHERE id = ?
      `).run(plan.id, expiresAt, payment.user_id);

      return { ...payment, tx_signature: sig };
    });

    return runTxn(reference, txSignature, durationDays);
  }

  /**
   * Expire old pending payments
   */
  expireOldPayments() {
    return this.db.prepare(`
      UPDATE payments SET status = 'expired'
      WHERE status = 'pending' AND COALESCE(datetime(expires_at), expires_at) < datetime('now')
    `).run();
  }

  /**
   * Upgrade user plan after payment
   */
  upgradePlan(userId, planName, durationDays = 30) {
    const plan = this.db.prepare(`SELECT id FROM plans WHERE name = ?`).get(planName);
    if (!plan) throw new Error(`Plan not found: ${planName}`);

    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      UPDATE users SET plan_id = ?, subscription_expires_at = ?, status = 'active'
      WHERE id = ?
    `).run(plan.id, expiresAt, userId);
  }

  // ── Broadcast history ───────────────────────────────────────────────────────

  createBroadcast(messageHtml, planFilter = 'all') {
    const r = this.db.prepare(`
      INSERT INTO broadcasts (message_html, plan_filter)
      VALUES (?, ?)
    `).run(messageHtml, planFilter || 'all');
    return r.lastInsertRowid;
  }

  addBroadcastDelivery(broadcastId, userId, chatId, messageId, status = 'sent') {
    this.db.prepare(`
      INSERT INTO broadcast_deliveries (broadcast_id, user_id, chat_id, message_id, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(broadcastId, userId, String(chatId), messageId, status);
  }

  finalizeBroadcast(broadcastId, sentCount, failedCount) {
    this.db.prepare(`
      UPDATE broadcasts
      SET sent_count = ?, failed_count = ?
      WHERE id = ?
    `).run(sentCount, failedCount, broadcastId);
  }

  getBroadcastHistory(limit = 30, offset = 0) {
    return this.db.prepare(`
      SELECT b.*,
             COUNT(d.id) as deliveries,
             COALESCE(SUM(CASE WHEN d.status='sent' THEN 1 ELSE 0 END), 0) as sent_deliveries
      FROM broadcasts b
      LEFT JOIN broadcast_deliveries d ON d.broadcast_id = b.id
      GROUP BY b.id
      ORDER BY b.id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  getBroadcastDeliveries(broadcastId) {
    return this.db.prepare(`
      SELECT d.*, u.plan_id, p.name as plan_name
      FROM broadcast_deliveries d
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN plans p ON p.id = u.plan_id
      WHERE d.broadcast_id = ?
      ORDER BY d.id ASC
    `).all(broadcastId);
  }

  getBroadcastById(broadcastId) {
    return this.db.prepare(`SELECT * FROM broadcasts WHERE id = ?`).get(broadcastId);
  }

  updateBroadcastMessage(broadcastId, messageHtml) {
    this.db.prepare(`
      UPDATE broadcasts
      SET message_html = ?
      WHERE id = ?
    `).run(messageHtml, broadcastId);
  }

  updateBroadcastDeliveryStatus(broadcastId, userId, status) {
    this.db.prepare(`
      UPDATE broadcast_deliveries
      SET status = ?
      WHERE broadcast_id = ? AND user_id = ?
    `).run(status, broadcastId, userId);
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  getSetting(key, defaultValue = null) {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    if (!row) return defaultValue;
    if (typeof defaultValue === 'number') return Number(row.value);
    return row.value;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value));
  }

  getAllSettings() {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  // ── Trend Management ─────────────────────────────────────────────────────────

  isTrendSeen(externalId, title, url) {
    // Logic:
    //   scored    → block forever (AI already analysed, no point repeating)
    //   save_only → always allow through with fresh collector metrics so the
    //               clusterer can re-evaluate based on current engagement.
    //               The collector itself acts as a natural "freshness gate":
    //               if a post fell off the feed it won't appear at all.
    const _check = (row) => {
      if (!row) return false;
      if (row.pipeline_status === 'scored') {
        this._touchTrend(row.id);
        return true;
      }
      // save_only — let it through every scan
      return false;
    };

    if (externalId) {
      const row = this.db.prepare(
        `SELECT id, pipeline_status FROM trends WHERE external_id = ?`
      ).get(externalId);
      if (_check(row)) return true;
    }
    if (url) {
      const row = this.db.prepare(
        `SELECT id, pipeline_status FROM trends WHERE url = ?`
      ).get(url);
      if (_check(row)) return true;
    }
    return false;
  }

  _touchTrend(id) {
    this.db.prepare(`UPDATE trends SET last_seen_at = CURRENT_TIMESTAMP, times_seen = times_seen + 1 WHERE id = ?`).run(id);
  }

  isTrendSeenFuzzy(title, hoursBack = 6) {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const words = title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    if (words.length === 0) return false;

    const existing = this.db.prepare(`SELECT title FROM trends WHERE first_seen_at > ?`).all(cutoff);
    for (const row of existing) {
      const existingWords = row.title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const matches = words.filter(w => existingWords.includes(w));
      if (matches.length >= 2) return true;
    }
    return false;
  }

  saveTrend(trend) {
    const pipelineStatus = trend.pipelineStatus || 'save_only';
    const rawMetrics = JSON.stringify({
      ...(trend.metrics || {}),
      memePotential:  trend.memePotential,
      adoptionScore:  trend.adoptionScore  ?? trend.memePotential ?? 0,
      emergenceScore: trend.emergenceScore ?? trend.clusterMetrics?.emergenceScore ?? 0,
      narrativePhase: trend.narrativePhase  ?? null,
      rankScore:      trend.rankScore       ?? null,
      marketStage:    trend.marketStage     ?? null, // [MARKET_STAGE] remove to disable
      junkPenalty:    trend.junkPenalty     ?? trend.clusterMetrics?.junkPenalty  ?? 0, // [JUNK_FILTER]
      junkReasons:    trend.clusterMetrics?.junkReasons ?? [],                           // [JUNK_FILTER]
    });

    // UPSERT: if the trend already exists in DB (re-analysis after window expiry),
    // update it instead of inserting a duplicate row.
    let existingId = null;
    if (trend.externalId) {
      const row = this.db.prepare(`SELECT id FROM trends WHERE external_id = ?`).get(trend.externalId);
      if (row) existingId = row.id;
    }
    if (!existingId && trend.url) {
      const row = this.db.prepare(`SELECT id FROM trends WHERE url = ?`).get(trend.url);
      if (row) existingId = row.id;
    }

    if (existingId) {
      this.db.prepare(`
        UPDATE trends SET
          score = ?, category = ?, sentiment = ?, ai_explanation = ?,
          predicted_lifespan = ?, raw_metrics = ?, pipeline_status = ?,
          last_seen_at = CURRENT_TIMESTAMP, times_seen = times_seen + 1
        WHERE id = ?
      `).run(
        trend.score || 0,
        trend.category || null,
        trend.sentiment || null,
        trend.aiExplanation || null,
        trend.predictedLifespan || null,
        rawMetrics,
        pipelineStatus,
        existingId
      );
      return existingId;
    }

    // New trend — INSERT
    const result = this.db.prepare(`
      INSERT INTO trends (external_id, source, title, original_title, description, url, score, category, sentiment, ai_explanation, predicted_lifespan, raw_metrics, pipeline_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trend.externalId || null,
      trend.source,
      trend.title,
      trend.originalTitle || trend.title,
      trend.description || null,
      trend.url || null,
      trend.score || 0,
      trend.category || null,
      trend.sentiment || null,
      trend.aiExplanation || null,
      trend.predictedLifespan || null,
      rawMetrics,
      pipelineStatus
    );

    return result.lastInsertRowid;
  }

  recordNotification(trendId, channel, userId = null) {
    this.db.prepare(`INSERT INTO notifications (trend_id, channel, user_id) VALUES (?, ?, ?)`).run(trendId, channel, userId);
  }

  wasNotificationSentToUser(trendId, userId) {
    const row = this.db.prepare(`SELECT id FROM notifications WHERE trend_id = ? AND user_id = ?`).get(trendId, userId);
    return !!row;
  }

  wasNotificationSent(trendId, channel) {
    const row = this.db.prepare(`SELECT id FROM notifications WHERE trend_id = ? AND channel = ?`).get(trendId, channel);
    return !!row;
  }

  getRecentTrends(hours = 24) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`SELECT * FROM trends WHERE first_seen_at > ? ORDER BY score DESC`).all(cutoff);
  }

  cleanup(daysOld = 30) {
    const alertResult = this.cleanupAlerts(daysOld);
    const cutoff = alertResult.cutoff;
    const payments = this.db.prepare(`DELETE FROM payments WHERE status IN ('expired', 'confirmed') AND created_at < ?`).run(cutoff);
    this.logger.info(`Cleanup done: trends=${alertResult.trendsDeleted}, notifications=${alertResult.notificationsDeleted}, payments=${payments.changes}`);
  }

  /**
   * Delete old alert data (trends + notifications only).
   * Does NOT touch users/plans/payments.
   */
  cleanupAlerts(daysOld = 30) {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();

    const runTxn = this.db.transaction((dateCutoff) => {
      const notifResult = this.db.prepare(`DELETE FROM notifications WHERE sent_at < ?`).run(dateCutoff);
      const trendsResult = this.db.prepare(`DELETE FROM trends WHERE first_seen_at < ?`).run(dateCutoff);
      // Safety pass for potential orphan rows if FK checks were disabled earlier
      this.db.prepare(`DELETE FROM notifications WHERE trend_id NOT IN (SELECT id FROM trends)`).run();
      return {
        cutoff: dateCutoff,
        trendsDeleted: trendsResult.changes,
        notificationsDeleted: notifResult.changes,
      };
    });

    const result = runTxn(cutoff);
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {}

    this.logger.info(`Alert cleanup (${daysOld}d): trends=${result.trendsDeleted}, notifications=${result.notificationsDeleted}`);
    return result;
  }

  getStorageStats() {
    const pageCount = this.db.pragma('page_count', { simple: true }) || 0;
    const pageSize = this.db.pragma('page_size', { simple: true }) || 0;
    const dbBytes = pageCount * pageSize;
    const trendsCount = this.db.prepare(`SELECT COUNT(*) as n FROM trends`).get().n || 0;
    const notificationsCount = this.db.prepare(`SELECT COUNT(*) as n FROM notifications`).get().n || 0;
    const paymentsCount = this.db.prepare(`SELECT COUNT(*) as n FROM payments`).get().n || 0;
    return {
      dbBytes,
      trendsCount,
      notificationsCount,
      paymentsCount,
    };
  }

  hasConfirmedPlanPayment(userId, planName) {
    const row = this.db.prepare(`
      SELECT id
      FROM payments
      WHERE user_id = ? AND plan_name = ? AND status = 'confirmed'
      LIMIT 1
    `).get(userId, planName);
    return !!row;
  }

  updateTgUrl(trendId, url, messageId) {
    const row = this.db.prepare(`SELECT raw_metrics FROM trends WHERE id = ?`).get(trendId);
    if (!row) return;
    let metrics = {};
    try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch(e) {}
    metrics.tgMessageUrl = url;
    this.db.prepare(`UPDATE trends SET raw_metrics = ?, tg_message_id = ? WHERE id = ?`)
      .run(JSON.stringify(metrics), messageId || null, trendId);
  }

  getTrendById(id) {
    return this.db.prepare(`SELECT * FROM trends WHERE id = ?`).get(id);
  }

  getTrendByTgMessageId(tgMessageId) {
    return this.db.prepare(`SELECT * FROM trends WHERE tg_message_id = ?`).get(tgMessageId);
  }

  /**
   * Record a weighted vote for a trend from a specific user.
   *
   * @param {number} trendId
   * @param {string} chatId    — Telegram chat_id of the voter
   * @param {number} vote      — +1 liked, -1 disliked, 0 = remove vote
   * @param {number} weight    — plan-based weight (default 1)
   * @param {string} planName  — plan name for audit ('free','test','pro','admin')
   */
  recordFeedback(trendId, chatId, vote, weight = 1, planName = 'free') {
    if (vote === 0) {
      // Reaction removed — delete the user's vote
      this.db.prepare(`DELETE FROM feedback_votes WHERE trend_id = ? AND chat_id = ?`).run(trendId, String(chatId));
    } else {
      // Upsert: one vote per user per trend (changing vote replaces old one)
      this.db.prepare(`
        INSERT INTO feedback_votes (trend_id, chat_id, vote, weight, plan_name)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(trend_id, chat_id) DO UPDATE SET
          vote=excluded.vote, weight=excluded.weight,
          plan_name=excluded.plan_name, created_at=CURRENT_TIMESTAMP
      `).run(trendId, String(chatId), vote, weight, planName);
    }

    // Recompute weighted sum and store in trends.user_feedback
    const { weighted } = this.db.prepare(`
      SELECT COALESCE(SUM(vote * weight), 0) AS weighted FROM feedback_votes WHERE trend_id = ?
    `).get(trendId);
    this.db.prepare(`UPDATE trends SET user_feedback = ? WHERE id = ?`).run(Math.round(weighted), trendId);
  }

  /**
   * Get feedback stats for a trend: like/dislike counts + weighted score.
   * @param {number} trendId
   * @returns {{ likes: number, dislikes: number, weightedScore: number }}
   */
  getFeedbackStats(trendId) {
    return this.db.prepare(`
      SELECT
        COUNT(CASE WHEN vote > 0 THEN 1 END)       AS likes,
        COUNT(CASE WHEN vote < 0 THEN 1 END)        AS dislikes,
        COALESCE(SUM(vote * weight), 0)             AS weightedScore
      FROM feedback_votes WHERE trend_id = ?
    `).get(trendId) || { likes: 0, dislikes: 0, weightedScore: 0 };
  }

  /**
   * Get current vote for a specific user on a trend.
   * Returns +1, -1, or null (no vote).
   */
  getUserVote(trendId, chatId) {
    const row = this.db.prepare(
      `SELECT vote FROM feedback_votes WHERE trend_id = ? AND chat_id = ?`
    ).get(trendId, String(chatId));
    return row ? row.vote : null;
  }

  getLikedNarratives(days = 7, limit = 10) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT title, category, user_feedback FROM trends
      WHERE user_feedback > 0 AND first_seen_at > ?
      ORDER BY user_feedback DESC LIMIT ?
    `).all(cutoff, limit);
  }

  getDislikedNarratives(days = 7, limit = 10) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT title, category, user_feedback FROM trends
      WHERE user_feedback < 0 AND first_seen_at > ?
      ORDER BY user_feedback ASC LIMIT ?
    `).all(cutoff, limit);
  }

  close() {
    this.db.close();
  }
}

export default TrendDatabase;
