import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRESET_KEYS, validatePresetOverrides } from '../analysis/preset-config.js';

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
    this.db.pragma('foreign_keys = ON');    // Bundle #10 — DB-005: enforce FK declarations
    this.db.pragma('busy_timeout = 5000');  // Bundle #10 — 5s lock-wait on concurrent writes
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

    // Personalized ranking toggle — when 1, dashboard rank-sort applies a
    // per-category boost derived from the user's 👍/👎 history.
    addIfMissing('users', 'personalization_enabled', 'INTEGER NOT NULL DEFAULT 1');

    // Notifications user_id migration
    addIfMissing('notifications', 'user_id', 'INTEGER');

    // Pipeline status — tracks how far a trend got through the analysis pipeline
    // 'save_only' = clusterer skipped AI scoring; 'scored' = went through stage 1 AI
    addIfMissing('trends', 'pipeline_status', "TEXT NOT NULL DEFAULT 'save_only'");

    // Trigger event — stage-1 AI fills this only when there is an explicit,
    // concrete event driving the narrative right now. Empty string otherwise
    // (we instruct the model to NOT guess). Rendered separately in UI/alerts.
    addIfMissing('trends', 'why_now', "TEXT NOT NULL DEFAULT ''");

    // Alert type — orthogonal to category. One of 'event'|'trend'|'post' (see
    // src/analysis/prompts.js → ALERT_TYPE_VALUES). Filled by Stage 1 AI;
    // heuristic/fallback paths derive it deterministically. Legacy rows have
    // NULL — readers treat NULL as "any type" (no filtering) for back-compat.
    addIfMissing('trends', 'alert_type', 'TEXT');

    // Per-user alert-type subscription filter — CSV of allowed types. Default
    // all 3 included (back-compat: existing users keep getting all alerts).
    // Empty string is treated by readers as "all" (silent allow if user
    // disabled every checkbox — beats silently muting them).
    addIfMissing('users', 'alert_types_filter', "TEXT NOT NULL DEFAULT 'event,trend,post'");

    // ── On-demand trigger search (replaces legacy whyItWillPump) ─────────────
    // Filled only when a user clicks the "Search Trigger" button (TG or dashboard).
    // First click triggers a Grok reasoning + x_search call; result is shared
    // across all users (the next click reads from DB instantly).
    //
    // `trigger_in_flight` is a DB-level lock to prevent duplicate Grok calls
    // when two users click simultaneously. Cleared on startup to recover from
    // crashes that left the flag set (see _resetTriggerLocks below).
    addIfMissing('trends', 'trigger_text',         'TEXT');
    addIfMissing('trends', 'trigger_searched_at',  'DATETIME');
    addIfMissing('trends', 'trigger_searched_by',  'TEXT');     // chat_id of the user who first triggered
    addIfMissing('trends', 'trigger_sources',      'TEXT');     // JSON array of @handles
    addIfMissing('trends', 'trigger_confidence',   'INTEGER NOT NULL DEFAULT 0');
    addIfMissing('trends', 'trigger_in_flight',    'INTEGER NOT NULL DEFAULT 0');
    // Forward-looking growth forecast fields (added 2026-05-03 — Catalyst rework).
    // Old rows scored before this migration have NULL/empty values; UI treats
    // those exactly like missing (no chip / no bullet renders).
    addIfMissing('trends', 'trigger_phase',        'TEXT');     // early|building|peaking|saturated|fading
    addIfMissing('trends', 'trigger_window',       'TEXT');     // free-form short phrase
    addIfMissing('trends', 'trigger_drivers',      'TEXT');     // JSON array of ≤80-char bullets
    addIfMissing('trends', 'trigger_risks',        'TEXT');     // JSON array of ≤80-char bullets

    // Crash recovery: clear any lock left over from a previous process. Safe
    // because no in-flight Grok call could have survived the restart.
    try {
      const r = this.db.prepare(`UPDATE trends SET trigger_in_flight = 0 WHERE trigger_in_flight = 1`).run();
      if (r.changes > 0) this.logger.info(`DB startup: cleared ${r.changes} stale trigger_in_flight locks`);
    } catch (e) {
      // Column may not exist on first migration pass — ignore.
    }

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

    // Optional free-form reason attached to a vote — set via the "Reason"
    // button in Telegram after the user has voted. Empty / NULL when no
    // reason was provided. Capped at 240 chars at write time to keep the
    // AI prompt context bounded; any truncation happens BEFORE insert.
    addIfMissing('feedback_votes', 'reason', 'TEXT');

    // Per-user hidden trends — visual archive feature in dashboard. When a
    // user clicks the ✕ on a trend card it lands here; feed query filters
    // these out for that user only. Cleanup deletes rows older than 7 days
    // so the archive doesn't grow unboundedly. Mirrors feedback_votes shape.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hidden_trends (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        trend_id   INTEGER NOT NULL REFERENCES trends(id),
        chat_id    TEXT NOT NULL,
        hidden_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(trend_id, chat_id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_hidden_trends_chat ON hidden_trends(chat_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_hidden_trends_at   ON hidden_trends(hidden_at)`);

    // Per-user favourites. Pro/Admin save trends here for *permanent* recall.
    // Two-source-of-truth design (resilient to trends-table cleanup):
    //   - `trend_id` references the live trend (preferred for fresh metrics)
    //   - `snapshot` is a frozen JSON copy at save-time (title/source/url/
    //     image/score/raw_metrics/etc) — fallback when the live row is gone.
    // Render-time logic (dashboard server): try live trend by id; if NULL,
    // deserialize snapshot. Either way the user sees the post they saved
    // months/years ago, even after retention has rotated it from `trends`.
    // No FK CASCADE: we want the favourite to outlive the trend row.
    // Optional free-form `note` (cap 500 chars, enforced app-side).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_favorites (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     TEXT NOT NULL,
        trend_id    INTEGER NOT NULL,
        note        TEXT,
        snapshot    TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, trend_id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_user_favorites_chat ON user_favorites(chat_id, created_at DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_user_favorites_trend ON user_favorites(trend_id)`);

    // Support-bot ticket threads. Each row maps a user's private chat with
    // the support bot to a forum topic in the admin group. Two-way relay:
    //   user → topic    : src/support/bot.js looks up by chat_id
    //   admin reply → user : looks up by topic_id (message_thread_id)
    // group_id is captured per-row so a future re-config (new admin group)
    // doesn't silently misroute old threads.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS support_threads (
        chat_id     TEXT PRIMARY KEY,
        topic_id    INTEGER NOT NULL,
        group_id    TEXT NOT NULL,
        username    TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_support_threads_topic ON support_threads(topic_id, group_id)`);

    // ── Stage 1 calibration examples (admin-curated, fed into SYSTEM_PROMPT) ─
    // Each row is either a calibration example (specific trend → known score)
    // or a "mistake" / anti-pattern (rule the model commonly violates).
    // Operator manages these via the admin Examples page; scorer reads enabled
    // rows once per cycle and concatenates them into the cacheable prefix of
    // the system prompt. Empty table → falls back to bare rubric (no harm).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stage1_examples (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL DEFAULT 'example' CHECK(kind IN ('example','mistake')),
        title           TEXT NOT NULL,
        category        TEXT,                              -- one of our enum, NULL for mistakes
        meme_potential  INTEGER CHECK(meme_potential IS NULL OR (meme_potential BETWEEN 0 AND 100)),
        rationale       TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_stage1_examples_kind_sort ON stage1_examples(kind, sort_order)`);

    // Seed with default calibration set on first boot. Marker prevents re-seed
    // after the operator deletes / replaces them. To force re-seed, manually
    // delete the marker row from settings.
    if (this.getSetting('stage1ExamplesSeededV1', null) !== '1') {
      const seed = this.db.prepare(`
        INSERT INTO stage1_examples (kind, title, category, meme_potential, rationale, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const seedExamples = [
        // ── Examples (positive calibration across the 0-100 range) ─────────
        ['example', 'Elon tweets a meme picture (no commentary, just image)',                  'celebrity',     95, 'Mega-impact author + meme image = instant ticker-spawn pattern. Always 90+.',                  10],
        ['example', 'A-list celebrity does something absurd / embarrassing on camera',         'celebrity',     90, 'Celebrity + absurdity = strong meme energy. Boost only if shareable visual exists.',           20],
        ['example', 'Bizarre cute animal viral video (penguin/capybara/frog doing weird thing)','animals',      85, 'Cute animals are evergreen meme fuel. Short phonetic name = perfect ticker. No political baggage.', 30],
        ['example', 'Random street-interview catchphrase goes viral overnight',                'meme',          80, 'Catchy short phrase + organic spread + low-stakes context. Classic meme arc.',                 40],
        ['example', 'New indie game blows up overnight on Twitch / TikTok playthroughs',       'gaming',        70, 'Gaming virality with character/aesthetic = ticker candidate if name is short and phonetic.',   45],
        ['example', 'Surprise music drop or viral TikTok song from unknown artist',            'entertainment', 65, 'Music virality has shorter lifespan than visual memes but spawns tickers when the artist name or hook is sticky.', 48],
        ['example', 'AI chatbot publicly fails / says something deranged in screenshots',      'tech',          60, 'AI weirdness has its own meme cycle but shorter lifespan. Boost if specific named model.',     50],
        ['example', 'Non-Elon tech CEO makes minor announcement (no drama, no leaked emails)', 'tech',          35, 'Tech news without conflict / scandal = mild interest, not meme territory.',                    60],
        ['example', 'WSB / pump.fun degens chase a microcap with absurd PnL screenshots',      'gambling',      40, 'Gambling chatter has narrative energy but most candles are not ticker-worthy. Boost on genuine narrative arc.', 65],
        ['example', 'Sports team wins championship (results only, no narrative arc)',          'sports',        15, 'Standard sports = near-zero meme. Boost ONLY if a player did something absurd/legendary.',     70],
        ['example', 'Politician signs bill / makes policy speech',                             'politics',       0, 'Politics = 0 by HARD RULE. No exceptions for raw views or breaking-news framing.',            80],
        ['example', 'Mainstream news article about routine corporate earnings',                'boring',         0, 'Corporate / financial news without scandal = 0. Not meme content even at high reach.',         90],
        // ── Mistakes (anti-patterns the model commonly slips on) ───────────
        ['mistake', 'Trump signed an executive order (5M views, top trending)',                null,           null, 'POLITICS RULE: even with viral metrics, score 0. Do not be tempted by raw engagement numbers.', 100],
        ['mistake', 'Elon tweet "yes." with 8M views from 220M follower account',              null,           null, 'MEGA-ACCOUNT RULE: raw views from huge accounts != novelty. No new idea = score 0-20 max.',    110],
        ['mistake', 'Crypto token shilling thread mentioning $TICKER 50 times',                null,           null, 'SPAM RULE: set isGenuinelyInteresting=false, memePotential=0. Promotional content is never a real narrative.', 120],
      ];
      for (const row of seedExamples) seed.run(...row);
      this.setSetting('stage1ExamplesSeededV1', '1');
      this.logger.info(`DB migration: seeded ${seedExamples.length} stage1_examples (operator can edit in admin UI)`);
    }

    // ── One-time rebalance of feedback weights (2026-04-27) ─────────────────
    // Old defaults (1/1/2/3 for free/test/pro/admin) made admin only 3× louder
    // than free, which let mass free votes drown out signal. New defaults give
    // admin 25× the weight of free (5.0 vs 0.2). The marker below ensures we
    // overwrite ONCE — after this users can tune values in the admin UI and
    // the marker prevents any future redo. Skip entirely on a brand-new DB
    // (the inserts below populate the new defaults from scratch).
    if (this.getSetting('feedbackWeightsRebalancedV2', null) !== '1') {
      this.setSetting('feedbackWeightAdmin', '5');
      this.setSetting('feedbackWeightPro',   '2.5');
      this.setSetting('feedbackWeightTest',  '0.5');
      this.setSetting('feedbackWeightFree',  '0.2');
      this.setSetting('feedbackWeightsRebalancedV2', '1');
      this.logger.info('DB migration: feedback weights rebalanced (admin=5, pro=2.5, test=0.5, free=0.2)');
    }

    // ── One-time fold of legacy globals into the per-preset config blob ─────
    // (2026-05-01) PR-1 of "per-preset pipeline".
    //
    // Before this PR, alert thresholds / weights / stale decay lived as a flat
    // set of global settings (alertThreshold, alertWeight*, alertStaleDecay*),
    // and the only per-preset thing was filterProfiles (junk). After this PR,
    // everything that varies by topic is consolidated under the single
    // presetConfigs JSON setting.
    //
    // Strategy:
    //   1. Read whatever non-default global values currently exist.
    //   2. Copy them into ALL 5 presets in the new blob (so behaviour is
    //      identical for every preset on day-zero — the operator can later
    //      diverge them through the admin UI).
    //   3. Fold in legacy filterProfiles (already per-preset) into the .junk
    //      sub-tree of each preset.
    //   4. Pass the assembled blob through validatePresetOverrides — it strips
    //      values that equal new defaults, so the stored blob stays compact.
    //   5. Write to presetConfigs and set the marker.
    //
    // Legacy global keys are NOT deleted — they're left as fallback for the
    // brief window between PR-1 (storage) and PR-2 (consumer wiring) where
    // collectors still read them directly. PR-2 will remove the writes; old
    // rows can age out organically.
    if (this.getSetting('presetConfigsMigratedV1', null) !== '1') {
      const blob = {};
      for (const p of PRESET_KEYS) blob[p] = { alerts: { thresholds: {}, weights: {}, stale: {} } };

      const readNum = (k) => {
        const v = this.getSetting(k);
        if (v === undefined || v === null || v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const setForAll = (group, sub, field, val) => {
        if (val === undefined) return;
        for (const p of PRESET_KEYS) blob[p][group][sub][field] = val;
      };
      // alerts.thresholds
      setForAll('alerts', 'thresholds', 'alertThreshold',    readNum('alertThreshold'));
      setForAll('alerts', 'thresholds', 'minScoreToSave',    readNum('minScoreToSave'));
      setForAll('alerts', 'thresholds', 'maxAlertsPerCycle', readNum('maxAlertsPerCycle'));
      setForAll('alerts', 'thresholds', 'alertHardJunkStop', readNum('alertHardJunkStop'));
      // alerts.weights
      setForAll('alerts', 'weights', 'weightMemePotential', readNum('alertWeightMemePotential'));
      setForAll('alerts', 'weights', 'weightVirality',      readNum('alertWeightVirality'));
      setForAll('alerts', 'weights', 'weightEmergence',     readNum('alertWeightEmergence'));
      setForAll('alerts', 'weights', 'weightTwitter',       readNum('alertWeightTwitter'));
      setForAll('alerts', 'weights', 'weightFeedback',      readNum('alertWeightFeedback'));
      setForAll('alerts', 'weights', 'weightJunk',          readNum('alertWeightJunk'));
      // alerts.stale
      setForAll('alerts', 'stale', 'staleDecayPerHour',     readNum('alertStaleDecayPerHour'));
      setForAll('alerts', 'stale', 'staleDecayGraceHours',  readNum('alertStaleDecayGrace'));
      setForAll('alerts', 'stale', 'staleDecayCap',         readNum('alertStaleDecayCap'));

      // filterProfiles → per-preset .junk
      const fpRaw = this.getSetting('filterProfiles', null);
      if (fpRaw) {
        try {
          const fp = JSON.parse(fpRaw) || {};
          for (const [preset, junk] of Object.entries(fp)) {
            if (PRESET_KEYS.includes(preset) && junk && typeof junk === 'object') {
              blob[preset].junk = { ...junk };
            }
          }
        } catch (_) { /* malformed legacy blob — ignore */ }
      }

      // Run through the validator: it strips fields that equal new defaults
      // and validates positive-weight budgets per preset.
      let cleaned;
      try {
        cleaned = validatePresetOverrides(blob);
      } catch (e) {
        // Don't block startup over a legacy-data issue. Log + skip the migration
        // so the operator can address it later through the admin endpoint.
        this.logger.warn('DB migration: presetConfigs fold failed — ' + e.message);
        cleaned = null;
      }

      if (cleaned !== null) {
        if (Object.keys(cleaned).length > 0) {
          this.setSetting('presetConfigs', JSON.stringify(cleaned));
        } else {
          // All legacy values matched new defaults → store empty to make the
          // "first-time-empty" state explicit (admin endpoint returns {}).
          this.setSetting('presetConfigs', '');
        }
        this.setSetting('presetConfigsMigratedV1', '1');
        this.logger.info(
          'DB migration: folded legacy globals into presetConfigs (' +
          (Object.keys(cleaned).length || 0) + ' presets with overrides)'
        );
      }
    }

    // X Analysis history — one row per actually-executed Apify call. Cached
    // responses are NOT recorded here. Used by the Telegram result card to
    // render "virality delta" (previous score vs current) and for future
    // sparkline UI. `concentration` is the top-1-author engagement share; see
    // TwitterChecker._summarize for formula.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS x_analysis_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        trend_id        INTEGER NOT NULL REFERENCES trends(id),
        at              DATETIME DEFAULT CURRENT_TIMESTAMP,
        tweet_count     INTEGER NOT NULL DEFAULT 0,
        total_views     INTEGER NOT NULL DEFAULT 0,
        total_likes     INTEGER NOT NULL DEFAULT 0,
        total_retweets  INTEGER NOT NULL DEFAULT 0,
        virality_score  INTEGER NOT NULL DEFAULT 0,
        concentration   INTEGER NOT NULL DEFAULT 0,
        actor_used      TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_xa_history_trend ON x_analysis_history(trend_id, at DESC)`);

    // ── Tag auto-refresh audit log ─────────────────────────────────────────
    // Each row = one Grok-call attempt (success or failure) for one preset.
    // status: 'applied' | 'skipped_no_diff' | 'rejected_validation' | 'error'
    // diff_json: shape { added: {reddit: [...], twitter: [...]}, removed: {...} }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tag_refresh_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              DATETIME DEFAULT CURRENT_TIMESTAMP,
        preset          TEXT NOT NULL,
        source_type     TEXT NOT NULL,
        status          TEXT NOT NULL,
        diff_json       TEXT,
        error_message   TEXT,
        model           TEXT,
        cost_usd        REAL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tag_refresh_history_ts ON tag_refresh_history(ts DESC)`);

    // Alert-score history — sparkline data for the dashboard modal. Each
    // recompute (scan, hot-refresh, light-refresh) appends one row per trend
    // so users can see "score was 65 -> 78 -> 82" over time. Admin-only for
    // now; will open up later. Pruned to 30 days by maintenance loop.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_score_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        trend_id        INTEGER NOT NULL,
        ts              DATETIME DEFAULT CURRENT_TIMESTAMP,
        score           INTEGER NOT NULL,
        positive        INTEGER,
        penalty         INTEGER,
        floor_at_ts     INTEGER,
        source          TEXT,
        FOREIGN KEY(trend_id) REFERENCES trends(id) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_alert_score_history_trend_ts ON alert_score_history(trend_id, ts)`);

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

    // Housekeeping — prune anything that's fully expired and has no token.
    // Daily setInterval in src/index.js (Bundle #6) covers ongoing prunes.
    try { this.pruneAuthSessions(24); }
    catch { /* best-effort at boot */ }

    // Plan normalization (v4 pricing/policy 2026-05-06):
    //   - alert_limit kept at -1 (unlimited) for all plans — alerts are
    //     marketing, not cost. Daily-cap gate removed in alert-dispatcher.
    //   - sources column expanded to include x_trends (5th source) for
    //     test/pro/admin. Free stays locked to reddit + google_trends.
    //   - Premium feature caps (manual analyze, catalyst forecast) enforced
    //     in src/billing/entitlements.js — sources column matches it.
    const normalizePlans = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO plans (name, price_usd, sources, alert_limit, history_days, api_access, description)
        VALUES ('free', 0, 'reddit,google_trends', -1, 3, 0, 'Free - Reddit + Google Trends, unlimited alerts')
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
        VALUES ('test', 5, 'reddit,google_trends,twitter,tiktok,x_trends', -1, 1, 0, 'Test - 1 day, all 5 sources, premium features with daily caps')
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
        VALUES ('pro', 100, 'reddit,google_trends,twitter,tiktok,x_trends', -1, 30, 1, 'Pro - 30 days, all 5 sources, premium features (high anti-spam caps)')
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
        VALUES ('admin', 0, 'reddit,google_trends,twitter,tiktok,x_trends', -1, -1, 1, 'Admin - unlimited everything')
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
      // Mask chat_id - keep last 4 digits so we can correlate logs without
      // storing full PII in long-term stdout.
      const masked = '***' + String(chatId).slice(-4);
      this.logger.info(`New user registered: ${masked} (@${username || 'unknown'})`);
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
   * Cheap pause check by chat ID. Used by AlertScheduler to drop pending
   * alerts the moment a user toggles pause mid-queue (without waiting for
   * the next scan cycle to filter them out).
   * Returns true when user.status !== 'active' (paused/suspended/missing).
   */
  isUserPausedByChatId(chatId) {
    const row = this.db.prepare(`SELECT status FROM users WHERE telegram_chat_id = ?`).get(String(chatId));
    return !row || row.status !== 'active';
  }

  /**
   * Update user setting
   */
  updateUser(userId, field, value) {
    const allowed = ['language', 'alert_threshold', 'disabled_sources', 'status', 'plan_id', 'subscription_expires_at', 'alert_count_today', 'alert_types_filter'];
    if (!allowed.includes(field)) throw new Error(`Cannot update field: ${field}`);
    this.db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(value, userId);
  }

  /**
   * Per-user alert-type subscription helpers.
   *
   * Storage: CSV in users.alert_types_filter (e.g. 'event,trend,post').
   * Empty string is treated as "all" by callers — never silently mute a user
   * who happened to uncheck every box.
   *
   * Validation: only canonical values from ALERT_TYPE_VALUES land in DB.
   * Unknown tokens are dropped silently.
   */
  getUserAlertTypes(chatId) {
    const row = this.db.prepare(
      `SELECT alert_types_filter FROM users WHERE telegram_chat_id = ?`
    ).get(String(chatId));
    if (!row) return ['event', 'trend', 'post']; // unknown user → all
    const raw = String(row.alert_types_filter || '').trim();
    if (!raw) return ['event', 'trend', 'post'];
    const valid = new Set(['event', 'trend', 'post']);
    const arr = raw.split(',').map(s => s.trim().toLowerCase()).filter(s => valid.has(s));
    return arr.length > 0 ? arr : ['event', 'trend', 'post'];
  }

  setUserAlertTypes(chatId, types) {
    const valid = new Set(['event', 'trend', 'post']);
    const cleaned = (Array.isArray(types) ? types : [])
      .map(s => String(s || '').trim().toLowerCase())
      .filter(s => valid.has(s));
    // Empty array → store empty string → readers interpret as "all".
    const csv = cleaned.length === 0 ? '' : Array.from(new Set(cleaned)).join(',');
    this.db.prepare(
      `UPDATE users SET alert_types_filter = ? WHERE telegram_chat_id = ?`
    ).run(csv, String(chatId));
    return csv;
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
   * Atomically confirm payment and upgrade user plan. Audit log row written
   * inside the same transaction so confirm + upgrade + audit are atomic.
   *
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

      // BILL-002 (Bundle #2): capture previous plan before UPDATE for audit payload.
      const prev = this.db.prepare(`SELECT plan_id FROM users WHERE id = ?`).get(payment.user_id);

      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`
        UPDATE users
        SET plan_id = ?, subscription_expires_at = ?, status = 'active'
        WHERE id = ?
      `).run(plan.id, expiresAt, payment.user_id);

      // BILL-002 (Bundle #2): audit log inside the existing transaction.
      this.recordAuditEvent(
        'plan_upgrade',
        null,                         // no admin actor — payment-driven
        'system',
        payment.user_id,
        {
          from_plan_id: prev?.plan_id ?? null,
          to_plan_id:   plan.id,
          to_plan_name: payment.plan_name,
          expires_at:   expiresAt,
          source:       'payment_confirmed',
          payment_id:   payment.id,
        },
        true,
      );

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
   * Upgrade user plan after payment (atomic). Writes audit row inside the
   * same transaction so plan change + audit are committed together.
   *
   * @param {number} userId
   * @param {string} planName
   * @param {number} durationDays
   * @param {Object} [opts]
   * @param {number|null} [opts.actorUserId] - admin id, null = system/payment-driven
   * @param {string} [opts.source] - 'admin_panel' | 'payment_confirmed' | 'cron' | ...
   */
  upgradePlan(userId, planName, durationDays = 30, opts = {}) {
    // BILL-002 / ADM-005 (Bundle #2): atomic UPDATE + audit log write.
    const plan = this.db.prepare(`SELECT id FROM plans WHERE name = ?`).get(planName);
    if (!plan) throw new Error(`Plan not found: ${planName}`);

    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const tx = this.db.transaction(() => {
      const prev = this.db.prepare(`SELECT plan_id FROM users WHERE id = ?`).get(userId);
      this.db.prepare(`
        UPDATE users SET plan_id = ?, subscription_expires_at = ?, status = 'active'
        WHERE id = ?
      `).run(plan.id, expiresAt, userId);
      this.recordAuditEvent(
        'plan_upgrade',
        opts.actorUserId ?? null,
        opts.actorUserId ? 'admin' : 'system',
        userId,
        {
          from_plan_id: prev?.plan_id ?? null,
          to_plan_id:   plan.id,
          to_plan_name: planName,
          expires_at:   expiresAt,
          source:       opts.source || 'unknown',
        },
        true,
      );
    });
    tx();
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

  // ── Hot trends refresh selector ─────────────────────────────────────────
  /**
   * Pick "hot" trends eligible for the periodic re-fetch + re-score loop.
   * Returns DB rows with raw_metrics already parsed into the camelCase shape
   * scorer.scoreTrends() expects, so the caller can drop the result almost
   * directly into the scorer after merging in fresh metrics from a resolver.
   *
   * Eligibility:
   *  - first_seen_at within `maxAgeHours` (default 24h)
   *  - meme_potential >= `minMeme` (read from raw_metrics JSON since the
   *    `score` column is the alert weight, not memePotential per se)
   *  - source in `sources` (default reddit + twitter — sources that have
   *    free per-URL refreshers via fxtwitter / reddit json)
   *  - url NOT NULL (we can't refresh without a permalink)
   *
   * Sort: meme_potential desc — when `limit` clips the pool, the highest-
   * scoring trends get refreshed first (more business value per cycle).
   */
  getHotTrendsForRefresh({ minMeme = 50, maxAgeHours = 24, sources = ['reddit', 'twitter'], limit = 100 } = {}) {
    if (!Array.isArray(sources) || sources.length === 0) return [];
    const placeholders = sources.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, external_id, source, title, original_title, description, url,
             score, category, sentiment, ai_explanation, predicted_lifespan,
             raw_metrics, why_now, alert_type, first_seen_at, last_seen_at
      FROM trends
      WHERE first_seen_at > datetime('now', '-' || ? || ' hours')
        AND source IN (${placeholders})
        AND url IS NOT NULL
        AND url != ''
      ORDER BY first_seen_at DESC
    `).all(maxAgeHours, ...sources);

    const out = [];
    for (const row of rows) {
      let meta = {};
      try { meta = row.raw_metrics ? JSON.parse(row.raw_metrics) : {}; }
      catch { /* corrupt JSON — skip metrics, but still consider the row */ }

      const memePotential = Number(meta.memePotential ?? 0);
      if (memePotential < minMeme) continue;

      // Reconstruct the trend object in scorer-compatible camelCase shape.
      // Strip the score/phase/etc fields back out of metrics — they live as
      // top-level fields on the trend object. Saves the scorer a re-derivation.
      const { memePotential: _m, adoptionScore, emergenceScore, narrativePhase, rankScore,
              marketStage, junkPenalty, junkReasons, alertScore, alertBreakdown,
              alertType: _at, storyScore, storyHook, preStage, ...rawMetricsOnly } = meta;

      out.push({
        _dbId:           row.id,
        externalId:      row.external_id,
        source:          row.source,
        title:           row.title,
        originalTitle:   row.original_title || row.title,
        description:     row.description || '',
        url:             row.url,
        score:           row.score || 0,
        category:        row.category,
        sentiment:       row.sentiment,
        aiExplanation:   row.ai_explanation || '',
        predictedLifespan: row.predicted_lifespan,
        whyNow:          row.why_now || '',
        alertType:       row.alert_type,
        memePotential,
        adoptionScore:   adoptionScore   ?? memePotential,
        emergenceScore:  emergenceScore  ?? 0,
        narrativePhase,
        marketStage,
        junkPenalty:     junkPenalty     ?? 0,
        // clusterMetrics MUST mirror the cluster-domain fields here, not just
        // junkReasons. The scorer's _analyzeBatchStage1 reads emergence
        // exclusively from trend.clusterMetrics?.emergenceScore (NOT the
        // top-level field), so if we only stash it on top, every re-score
        // pass through Hot refresh writes emerg=0 back to DB. Same for
        // marketStage (scorer line 656). HotMetricsRefresher._merge carries
        // these through on the fetch-success path, but on fetch failure it
        // falls back to this raw object — populating clusterMetrics here
        // makes that fallback safe too. (Found 2026-05-03: emerg=0 on every
        // Hot-refreshed row when fxtwitter timed out, which is most of them.)
        clusterMetrics: {
          emergenceScore: emergenceScore ?? 0,
          junkPenalty:    junkPenalty    ?? 0,
          junkReasons:    junkReasons    || [],
          marketStage:    marketStage    ?? null,
          narrativePhase: narrativePhase ?? null,
          // Force re-score eligibility for Stage 2 — original isNovel was a
          // one-time check at first scoring; on re-score we want a fresh
          // x_search dive if the new memePotential clears stage2Threshold.
          isNovel: true,
        },
        preStage:        preStage || null,
        metrics:         rawMetricsOnly,
        firstSeen:       row.first_seen_at,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── Hidden trends (per-user dashboard archive) ───────────────────────────
  // Cleanup runs from index.js maintenance loop — drops rows older than the
  // configured retention (default 7 days). Visible feed query in dashboard
  // server uses getHiddenTrendIdsByChat() to exclude.

  hideTrend(trendId, chatId) {
    if (!trendId || !chatId) return;
    this.db.prepare(`
      INSERT INTO hidden_trends (trend_id, chat_id, hidden_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(trend_id, chat_id) DO UPDATE SET hidden_at = CURRENT_TIMESTAMP
    `).run(trendId, String(chatId));
  }

  unhideTrend(trendId, chatId) {
    if (!trendId || !chatId) return;
    this.db.prepare(`DELETE FROM hidden_trends WHERE trend_id = ? AND chat_id = ?`)
      .run(trendId, String(chatId));
  }

  /** Returns trend_ids hidden by this user (within retention). Used by feed
   *  query to filter out rows the user has dismissed. */
  getHiddenTrendIdsByChat(chatId, retentionDays = 7) {
    if (!chatId) return [];
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    return this.db.prepare(
      `SELECT trend_id FROM hidden_trends WHERE chat_id = ? AND hidden_at > ?`
    ).all(String(chatId), cutoff).map(r => r.trend_id);
  }

  /** Joined hidden trends for the archive panel — title/source/score/etc.
   *  Caller is responsible for shaping into TrendCard payload. */
  getHiddenTrendsByChat(chatId, retentionDays = 7, limit = 200) {
    if (!chatId) return [];
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    return this.db.prepare(`
      SELECT t.*, h.hidden_at as hidden_at
      FROM hidden_trends h
      JOIN trends t ON t.id = h.trend_id
      WHERE h.chat_id = ? AND h.hidden_at > ?
      ORDER BY h.hidden_at DESC
      LIMIT ?
    `).all(String(chatId), cutoff, limit);
  }

  clearHiddenTrendsByChat(chatId) {
    if (!chatId) return 0;
    return this.db.prepare(`DELETE FROM hidden_trends WHERE chat_id = ?`)
      .run(String(chatId)).changes;
  }

  /** Sweep entries past the retention window. Called from maintenance loop. */
  cleanupExpiredHiddenTrends(retentionDays = 7) {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    return this.db.prepare(`DELETE FROM hidden_trends WHERE hidden_at < ?`)
      .run(cutoff).changes;
  }

  // ── User favorites (Pro/Admin permanent saves) ───────────────────────────
  // Same chat_id-keyed shape as hidden_trends, but stored permanently — no
  // retention sweep. Snapshot is the entire trend row at save-time, so the
  // favourite survives even if the live trend rotates out of `trends`.
  // Note field is optional free-form (cap enforced app-side, default 500
  // chars). Plan-gate is enforced by the dashboard server.

  /** Build the snapshot JSON for a trend row. Captures everything the feed-
   *  card and modal need to render: title, source, url, image, score, raw
   *  metrics blob (memePotential, virality, narrativePhase, alertScore, all
   *  the AI fields), category, alert_type, first_seen_at. Skips heavy
   *  derived fields that can be re-computed from raw_metrics. */
  _trendSnapshot(trend) {
    if (!trend) return null;
    const fields = [
      'id', 'title', 'description', 'source', 'url',
      'image_url', 'image_urls', 'category', 'sentiment',
      'score', 'raw_metrics', 'first_seen_at', 'last_seen_at',
      'alert_type', 'whyNow', 'why_now',
      'trigger_text', 'trigger_phase', 'trigger_window',
      'trigger_drivers', 'trigger_risks', 'trigger_sources', 'trigger_confidence',
      'tg_message_id', 'tg_message_url', 'manual',
      // External fields the bot writers may have added
      'externalId', 'external_id', 'author',
    ];
    const out = {};
    for (const k of fields) {
      if (trend[k] !== undefined) out[k] = trend[k];
    }
    out._snapshotAt = new Date().toISOString();
    return JSON.stringify(out);
  }

  addFavorite(chatId, trendId, note = null) {
    if (!chatId || !trendId) return;
    // Snapshot the trend at save-time. If the trend is gone right now, we
    // store NULL snapshot (rare race: the user clicked save just as the
    // trend rolled out). The render path tolerates that.
    const trend = this.getTrendById ? this.getTrendById(trendId) : null;
    const snapshot = this._trendSnapshot(trend);
    this.db.prepare(`
      INSERT INTO user_favorites (chat_id, trend_id, note, snapshot, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id, trend_id) DO UPDATE SET
        note = excluded.note,
        snapshot = COALESCE(excluded.snapshot, user_favorites.snapshot)
    `).run(String(chatId), trendId, note, snapshot);
  }

  removeFavorite(chatId, trendId) {
    if (!chatId || !trendId) return 0;
    return this.db.prepare(
      `DELETE FROM user_favorites WHERE chat_id = ? AND trend_id = ?`
    ).run(String(chatId), trendId).changes;
  }

  setFavoriteNote(chatId, trendId, note) {
    if (!chatId || !trendId) return 0;
    return this.db.prepare(
      `UPDATE user_favorites SET note = ? WHERE chat_id = ? AND trend_id = ?`
    ).run(note, String(chatId), trendId).changes;
  }

  /** Returns trend_ids favorited by this user. Pre-fetched once per feed
   *  request and passed to _formatTrend so each row gets isFavorite. */
  getFavoriteTrendIds(chatId) {
    if (!chatId) return [];
    return this.db.prepare(
      `SELECT trend_id FROM user_favorites WHERE chat_id = ?`
    ).all(String(chatId)).map(r => r.trend_id);
  }

  /** Note + created_at for one trend (used to populate the modal note editor). */
  getFavoriteMeta(chatId, trendId) {
    if (!chatId || !trendId) return null;
    return this.db.prepare(
      `SELECT note, created_at FROM user_favorites WHERE chat_id = ? AND trend_id = ?`
    ).get(String(chatId), trendId) || null;
  }

  /** Favourites list for /api/favorites. LEFT JOIN with trends so we get
   *  fresh data when the trend is alive, else snapshot fallback. Caller
   *  (dashboard server) merges fresh+snapshot before shaping the card. */
  getFavoritesByChat(chatId, limit = 500) {
    if (!chatId) return [];
    return this.db.prepare(`
      SELECT
        f.trend_id    as fav_trend_id,
        f.note        as fav_note,
        f.snapshot    as fav_snapshot,
        f.created_at  as fav_saved_at,
        t.*
      FROM user_favorites f
      LEFT JOIN trends t ON t.id = f.trend_id
      WHERE f.chat_id = ?
      ORDER BY f.created_at DESC
      LIMIT ?
    `).all(String(chatId), limit);
  }

  countFavoritesByChat(chatId) {
    if (!chatId) return 0;
    const row = this.db.prepare(
      `SELECT COUNT(*) as c FROM user_favorites WHERE chat_id = ?`
    ).get(String(chatId));
    return row?.c || 0;
  }

  // ── Support threads (forum-topic relay) ──────────────────────────────────────

  getSupportThreadByChat(chatId) {
    if (!chatId) return null;
    return this.db.prepare(
      `SELECT chat_id, topic_id, group_id, username, created_at, updated_at
         FROM support_threads WHERE chat_id = ?`
    ).get(String(chatId)) || null;
  }

  getSupportThreadByTopic(topicId, groupId) {
    if (!topicId || !groupId) return null;
    return this.db.prepare(
      `SELECT chat_id, topic_id, group_id, username, created_at, updated_at
         FROM support_threads WHERE topic_id = ? AND group_id = ?`
    ).get(Number(topicId), String(groupId)) || null;
  }

  createSupportThread(chatId, topicId, groupId, username) {
    if (!chatId || !topicId || !groupId) return;
    this.db.prepare(
      `INSERT OR REPLACE INTO support_threads
         (chat_id, topic_id, group_id, username, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(String(chatId), Number(topicId), String(groupId), username || null);
  }

  touchSupportThread(chatId) {
    if (!chatId) return;
    this.db.prepare(
      `UPDATE support_threads SET updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?`
    ).run(String(chatId));
  }

  // ── Trend Management ─────────────────────────────────────────────────────────

  isTrendSeen(externalId, title, url) {
    // Logic:
    //   save_only → always allow through with fresh collector metrics.
    //   scored    → re-analysis window. Block if EITHER already alerted to any
    //               user (no point paying AI again) OR re-scored within the
    //               cooldown (default 3h — admin-tunable via rescoreCooldownHours).
    //               Otherwise let it through so AI can re-evaluate with fresh
    //               engagement and maybe clear the alert gate this time.
    const cooldownHours = Number(this.getSetting('rescoreCooldownHours', 3)) || 3;
    const cooldownMs = cooldownHours * 3_600_000;

    const _check = (row) => {
      if (!row) return false;
      if (row.pipeline_status !== 'scored') return false; // save_only → pass

      // Already alerted to someone? Don't waste AI re-scoring it.
      const alerted = this.db.prepare(
        `SELECT 1 FROM notifications WHERE trend_id = ? LIMIT 1`
      ).get(row.id);
      if (alerted) {
        this._touchTrend(row.id);
        return true;
      }

      // Inside cooldown window? Skip this scan.
      const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      if (lastSeenMs && Date.now() - lastSeenMs < cooldownMs) {
        this._touchTrend(row.id);
        return true;
      }

      // Cooldown expired + never alerted → re-analyse.
      return false;
    };

    if (externalId) {
      const row = this.db.prepare(
        `SELECT id, pipeline_status, last_seen_at FROM trends WHERE external_id = ?`
      ).get(externalId);
      if (_check(row)) return true;
    }
    if (url) {
      const row = this.db.prepare(
        `SELECT id, pipeline_status, last_seen_at FROM trends WHERE url = ?`
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
      alertScore:     trend.alertScore      ?? null,
      alertBreakdown: trend.alertBreakdown  ?? null,
      // alertType also lives in raw_metrics so _hydrateTrendFromDb can read
      // it from the legacy/raw blob path (admin manual-submit hydration).
      alertType:      trend.alertType       ?? null,
      storyScore:     trend.xSearchData?.storyScore ?? 0,
      storyHook:      trend.xSearchData?.storyHook  ?? '',
      // PreStage enrichment — persisted so re-scoring or admin SubmitPage
      // displays the same data that Stage 1 saw, without re-paying for
      // nano/gemini calls. null when PreStage didn't run or both failed.
      preStage:       trend.preStage              ?? null,
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
          why_now = ?, alert_type = ?,
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
        trend.whyNow || '',
        trend.alertType || null,
        existingId
      );
      return existingId;
    }

    // New trend — INSERT
    const result = this.db.prepare(`
      INSERT INTO trends (external_id, source, title, original_title, description, url, score, category, sentiment, ai_explanation, predicted_lifespan, raw_metrics, pipeline_status, why_now, alert_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      pipelineStatus,
      trend.whyNow || '',
      trend.alertType || null
    );

    return result.lastInsertRowid;
  }

  /**
   * Save many trend payloads in a SINGLE transaction (one fsync for the whole
   * batch instead of one per row — see audit DB-013/TXN). Each payload is a
   * fully-built trend object exactly as you'd pass to saveTrend(); this only
   * changes HOW they're committed, not what gets written.
   *
   * @param {Array<object>} payloads - pre-built trend objects (caller sets
   *        pipelineStatus / score / etc.).
   * @param {object}   [opts]
   * @param {boolean}  [opts.skipErrors=false] - when true a failed saveTrend is
   *        caught (its id slot becomes null) instead of rolling back the whole
   *        batch. Use for best-effort paths (e.g. hot-refresh) that previously
   *        had a per-item try/catch.
   * @param {function} [opts.onError] - called as onError(payload, err) for each
   *        skipped failure (only when skipErrors=true).
   * @returns {Array<number|null>} trend ids aligned to payloads order (null for
   *          a skipped failure).
   */
  saveTrendsBatch(payloads, { skipErrors = false, onError = null } = {}) {
    if (!Array.isArray(payloads) || payloads.length === 0) return [];
    const run = this.db.transaction((items) => {
      const ids = [];
      for (const p of items) {
        if (skipErrors) {
          try {
            ids.push(this.saveTrend(p));
          } catch (e) {
            ids.push(null);
            if (onError) onError(p, e);
          }
        } else {
          ids.push(this.saveTrend(p));
        }
      }
      return ids;
    });
    return run(payloads);
  }

  recordNotification(trendId, channel, userId = null) {
    this.db.prepare(`INSERT OR IGNORE INTO notifications (trend_id, channel, user_id) VALUES (?, ?, ?)`).run(trendId, channel, userId);
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

  /**
   * Trends that came in via the admin's "Ручной анализ" tab.
   *
   * The flag lives inside `raw_metrics` JSON (see _submitNarrative in admin —
   * `metrics.manualSubmitted = true`). We use a JSON-text LIKE filter rather
   * than parsing every row server-side; the marker string is unique enough
   * (no other field is named manualSubmitted) and SQLite handles this in
   * <1ms even with thousands of rows because the count is small.
   *
   * Returns rows ordered newest-first. Limit is clamped to [1, 200].
   */
  getManualTrends(limit = 50) {
    const cap = Math.max(1, Math.min(200, limit | 0 || 50));
    return this.db.prepare(`
      SELECT * FROM trends
      WHERE raw_metrics LIKE '%"manualSubmitted":true%'
      ORDER BY first_seen_at DESC
      LIMIT ?
    `).all(cap);
  }

  /**
   * Strip the manualSubmitted marker from a trend's raw_metrics so it
   * disappears from the SubmitPage history. We deliberately keep the row in
   * the DB (it's still a valid trend, may have been alerted on) — only the
   * marker is cleared.
   *
   * Returns true if the row existed and the flag was actually present.
   */
  unsetManualSubmitted(trendId) {
    if (!trendId) return false;
    const row = this.db.prepare(`SELECT raw_metrics FROM trends WHERE id = ?`).get(trendId);
    if (!row) return false;
    let metrics = {};
    try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch { return false; }
    if (!metrics.manualSubmitted) return false;
    delete metrics.manualSubmitted;
    delete metrics.manualSubmittedAt;
    this.db.prepare(`UPDATE trends SET raw_metrics = ? WHERE id = ?`)
      .run(JSON.stringify(metrics), trendId);
    return true;
  }

  /**
   * Update Twitter engagement metrics (views/likes/retweets/replies) on the
   * trend row(s) whose URL points to the given tweet ID. Used by the
   * dashboard hover-preview: when fxtwitter returns fresh numbers, we cache
   * them back to the DB so the next feed render shows current data instead
   * of the stale snapshot taken at scrape time.
   *
   * Why URL-based lookup (not external_id): different collectors normalize
   * tweet identifiers differently (some store the bare numeric ID, others
   * include the user prefix), but every Twitter row has the canonical
   * /status/<id> URL — that's the most reliable join key.
   *
   * Returns the number of rows actually updated. Multiple rows can match
   * (rare — e.g. if the same tweet was re-clustered), all get the fresh
   * numbers.
   *
   * Each individual field is null-safe: if fxtwitter doesn't surface a
   * particular metric, we leave the existing one untouched (don't overwrite
   * with null and lose data).
   */
  updateTwitterEngagement(tweetId, fresh) {
    if (!tweetId || typeof tweetId !== 'string' || !/^\d+$/.test(tweetId)) {
      return 0;
    }
    if (!fresh || typeof fresh !== 'object') return 0;

    // LIKE pattern is robust: matches both twitter.com/u/status/<id> and
    // x.com/u/status/<id>, with or without trailing query/fragment.
    // Also pull first_seen_at — it's the natural baseline timestamp when
    // we don't yet have a prior _engSnapshot (first-ever hover refresh).
    const rows = this.db.prepare(
      `SELECT id, raw_metrics, first_seen_at FROM trends WHERE url LIKE ?`
    ).all('%/status/' + tweetId + '%');

    if (!rows.length) return 0;

    const updateStmt = this.db.prepare(
      `UPDATE trends SET raw_metrics = ? WHERE id = ?`
    );

    const nowMs   = Date.now();
    const nowIso  = new Date(nowMs).toISOString();
    const result = { rows: 0, velocity: null };

    for (const row of rows) {
      let metrics = {};
      try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch { continue; }

      // ── Velocity: Δviews / Δhours since the last sample we have ──────
      // Sample order of preference:
      //   1) Previous _engSnapshot (set on a prior refresh) — most accurate
      //      because it represents the actual rate between hovers.
      //   2) Original metrics.views captured at scrape time + first_seen_at.
      //      Less precise (views weren't always sampled exactly at scrape
      //      time, and sometimes scraper sets views=0), but lets us derive
      //      a useful number on the FIRST hover after scrape.
      // Skip update if Δviews is non-positive (scraper rounding / cached
      // higher value) or gap < 5 min (too noisy).
      let computedVelocity = null;
      const freshViews = (typeof fresh.views === 'number' && fresh.views >= 0) ? fresh.views : null;
      if (freshViews !== null) {
        const prevSnap = metrics._engSnapshot;
        let baselineViews = null, baselineMs = null;
        if (prevSnap && typeof prevSnap.views === 'number' && typeof prevSnap.ts === 'number') {
          baselineViews = prevSnap.views;
          baselineMs    = prevSnap.ts;
        } else if (typeof metrics.views === 'number' && row.first_seen_at) {
          baselineViews = metrics.views;
          baselineMs    = Date.parse(row.first_seen_at) || null;
        }
        if (baselineMs && baselineViews !== null) {
          const gapMs = nowMs - baselineMs;
          const dV    = freshViews - baselineViews;
          // 5-min minimum gap filters out hover-spam producing wildly
          // variable per-hour numbers; positive Δ guards against view
          // counter rollback.
          if (gapMs >= 5 * 60_000 && dV > 0) {
            const gapHours = gapMs / 3_600_000;
            computedVelocity = dV / gapHours;
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────

      // Patch primary metrics — only when fxtwitter returned a valid number.
      const patch = (key, val) => {
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return;
        metrics[key] = val;
      };
      patch('views',    fresh.views);
      patch('likes',    fresh.likes);
      patch('retweets', fresh.retweets);
      patch('replies',  fresh.replies);

      if (computedVelocity !== null) {
        // Round to 1 decimal — the dashboard's fmtVelocity already does this
        // for display, but persisted values stay tidy.
        metrics.velocity = Math.round(computedVelocity * 10) / 10;
        result.velocity = metrics.velocity;
      }

      // Snapshot for the NEXT velocity computation (window-style sampling).
      // Always advance, even when we didn't compute a new velocity this time
      // (e.g. gap too short) — otherwise the snapshot would never refresh.
      if (freshViews !== null) {
        metrics._engSnapshot = { views: freshViews, likes: fresh.likes ?? null, ts: nowMs };
      }
      // Tag the freshness so we can later distinguish "from collector" vs
      // "refreshed via hover" if anyone audits the data.
      metrics.engagementRefreshedAt = nowIso;

      updateStmt.run(JSON.stringify(metrics), row.id);
      result.rows++;
    }
    // Return both row count and the freshly computed velocity (or null if
    // we kept the old one) — the caller forwards it to the SSE/event so
    // clients can update their UI without a full refetch.
    return result;
  }

  /**
   * Reddit equivalent of updateTwitterEngagement. Match by post_id (extracted
   * from /comments/<post_id>/ in the URL). Patches upvotes/comments and
   * computes velocity (Δupvotes / Δhours) using the same snapshot strategy.
   *
   * Reddit URL shapes we accept:
   *   https://reddit.com/r/Sub/comments/abc123/...
   *   https://www.reddit.com/r/Sub/comments/abc123
   *   https://old.reddit.com/r/Sub/comments/abc123/...
   * Post IDs are base36 (alphanumeric), typically 6-7 chars.
   */
  updateRedditEngagement(postId, fresh) {
    if (!postId || typeof postId !== 'string' || !/^[a-z0-9]{4,12}$/i.test(postId)) {
      return { rows: 0, velocity: null };
    }
    if (!fresh || typeof fresh !== 'object') return { rows: 0, velocity: null };

    const rows = this.db.prepare(
      `SELECT id, raw_metrics, first_seen_at FROM trends WHERE url LIKE ?`
    ).all('%/comments/' + postId + '%');

    if (!rows.length) return { rows: 0, velocity: null };

    const updateStmt = this.db.prepare(
      `UPDATE trends SET raw_metrics = ? WHERE id = ?`
    );

    const nowMs  = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const result = { rows: 0, velocity: null };

    for (const row of rows) {
      let metrics = {};
      try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch { continue; }

      // Velocity: Δupvotes / Δhours since last sample. Reddit's primary
      // engagement signal is the score (upvotes minus downvotes), exposed
      // as `metrics.upvotes` in our shape. Same windowing as Twitter:
      // baseline = previous _engSnapshot OR (metrics.upvotes + first_seen_at)
      // on the very first refresh.
      let computedVelocity = null;
      const freshUp = (typeof fresh.upvotes === 'number' && fresh.upvotes >= 0) ? fresh.upvotes : null;
      if (freshUp !== null) {
        const prevSnap = metrics._engSnapshot;
        let baseUp = null, baseMs = null;
        if (prevSnap && typeof prevSnap.upvotes === 'number' && typeof prevSnap.ts === 'number') {
          baseUp = prevSnap.upvotes;
          baseMs = prevSnap.ts;
        } else if (typeof metrics.upvotes === 'number' && row.first_seen_at) {
          baseUp = metrics.upvotes;
          baseMs = Date.parse(row.first_seen_at) || null;
        }
        if (baseMs && baseUp !== null) {
          const gapMs = nowMs - baseMs;
          const dU    = freshUp - baseUp;
          if (gapMs >= 5 * 60_000 && dU > 0) {
            const gapHours = gapMs / 3_600_000;
            computedVelocity = dU / gapHours;
          }
        }
      }

      const patch = (key, val) => {
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return;
        metrics[key] = val;
      };
      patch('upvotes',  fresh.upvotes);
      patch('comments', fresh.comments);

      if (computedVelocity !== null) {
        metrics.velocity = Math.round(computedVelocity * 10) / 10;
        result.velocity = metrics.velocity;
      }

      // Snapshot stores upvotes (Reddit) — we keep the field names
      // platform-specific so a tweet refresh and a reddit refresh on the
      // same row (shouldn't happen but defensively) don't mix Twitter
      // views with Reddit upvotes.
      if (freshUp !== null) {
        metrics._engSnapshot = { upvotes: freshUp, comments: fresh.comments ?? null, ts: nowMs };
      }
      metrics.engagementRefreshedAt = nowIso;

      updateStmt.run(JSON.stringify(metrics), row.id);
      result.rows++;
    }
    return result;
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

  // ── X Analysis history ─────────────────────────────────────────────────────

  /**
   * Record one freshly-executed X Analysis snapshot. Call only on actual Apify
   * fetches — never on cache hits (we want the history to reflect real fetches
   * only, so delta comparisons are meaningful).
   */
  saveXAnalysis(trendId, result) {
    if (!trendId || !result) return;
    try {
      this.db.prepare(`
        INSERT INTO x_analysis_history
          (trend_id, tweet_count, total_views, total_likes, total_retweets,
           virality_score, concentration, actor_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trendId,
        result.tweetCount    | 0,
        result.totalViews    | 0,
        result.totalLikes    | 0,
        result.totalRetweets | 0,
        result.viralityScore | 0,
        result.concentration | 0,
        result.actorUsed || null
      );
    } catch (e) {
      this.logger?.warn?.(`saveXAnalysis failed for trend #${trendId}: ${e.message}`);
    }
  }

  // ── Trigger search ─────────────────────────────────────────────────────────

  /**
   * Atomically claim the right to run a Grok trigger search for this trend.
   *
   * Two users can click "Search Trigger" in the same second — we want only ONE
   * Grok call to actually fire. The atomic UPDATE below succeeds only when the
   * trend has no trigger yet AND no in-flight claim. The loser of the race
   * gets `claimed: false` and inspects `state` to decide what to do:
   *   - 'cached'    → another caller already filled the trigger; read & return
   *   - 'in-flight' → another caller is currently calling Grok; show a toast,
   *                   ask the user to retry shortly
   *
   * @param {number} trendId
   * @param {string|number} userId  chat_id of the requesting user (audit)
   * @returns {{ claimed: boolean, state?: 'cached'|'in-flight', trend?: Object }}
   */
  claimTriggerSearch(trendId, userId) {
    if (!trendId) return { claimed: false, state: 'in-flight' };

    const result = this.db.prepare(`
      UPDATE trends
      SET trigger_in_flight   = 1,
          trigger_searched_by = ?
      WHERE id = ?
        AND trigger_in_flight = 0
        AND (trigger_text IS NULL OR trigger_text = '')
    `).run(String(userId || ''), trendId);

    if (result.changes === 1) {
      return { claimed: true };
    }

    // Lost the race — figure out why
    const trend = this.getTrendById(trendId);
    if (trend?.trigger_text && trend.trigger_text.length > 0) {
      return { claimed: false, state: 'cached', trend };
    }
    return { claimed: false, state: 'in-flight', trend };
  }

  /**
   * Persist a successful Catalyst-forecast result and release the lock.
   *
   * The data shape is the forward-looking forecast (see TriggerFinder):
   * `text` = 2-3 sentence forecast, `phase` = curve-phase enum, `window` =
   * upside horizon phrase, `drivers` / `risks` = short bullet arrays.
   *
   * @param {number} trendId
   * @param {Object} data
   * @param {string}   data.text         Forecast text (2-3 sentences)
   * @param {string}   [data.phase]      One of early|building|peaking|saturated|fading
   * @param {string}   [data.window]     Short upside-window phrase
   * @param {string[]} [data.drivers]    1-3 forward catalyst bullets
   * @param {string[]} [data.risks]      0-2 growth-killer bullets
   * @param {string[]} [data.sources]    Array of @handles
   * @param {number}   [data.confidence] 0-100
   */
  saveTrendTrigger(trendId, data) {
    if (!trendId || !data || typeof data.text !== 'string') return;
    try {
      const sourcesJson = JSON.stringify(Array.isArray(data.sources) ? data.sources.slice(0, 10) : []);
      const driversJson = JSON.stringify(Array.isArray(data.drivers) ? data.drivers.slice(0, 5)  : []);
      const risksJson   = JSON.stringify(Array.isArray(data.risks)   ? data.risks.slice(0, 5)    : []);
      const confidence  = Math.max(0, Math.min(100, Number(data.confidence) || 0));
      const phase       = typeof data.phase  === 'string' ? data.phase  : '';
      const window      = typeof data.window === 'string' ? data.window : '';
      this.db.prepare(`
        UPDATE trends SET
          trigger_text         = ?,
          trigger_sources      = ?,
          trigger_confidence   = ?,
          trigger_phase        = ?,
          trigger_window       = ?,
          trigger_drivers      = ?,
          trigger_risks        = ?,
          trigger_searched_at  = CURRENT_TIMESTAMP,
          trigger_in_flight    = 0
        WHERE id = ?
      `).run(data.text, sourcesJson, confidence, phase, window, driversJson, risksJson, trendId);
    } catch (e) {
      this.logger?.warn?.(`saveTrendTrigger failed for trend #${trendId}: ${e.message}`);
    }
  }

  /**
   * Release the in-flight lock without saving (call this on Grok failure).
   * Leaves trigger_text NULL so a retry is possible.
   */
  releaseTriggerLock(trendId) {
    if (!trendId) return;
    try {
      this.db.prepare(`UPDATE trends SET trigger_in_flight = 0 WHERE id = ?`).run(trendId);
    } catch (e) {
      this.logger?.warn?.(`releaseTriggerLock failed for trend #${trendId}: ${e.message}`);
    }
  }

  /**
   * Read the trigger payload for a trend, parsed into JS objects.
   * Returns null when no search has been performed yet.
   */
  getTrendTrigger(trendId) {
    if (!trendId) return null;
    const row = this.db.prepare(`
      SELECT trigger_text, trigger_sources, trigger_confidence,
             trigger_phase, trigger_window, trigger_drivers, trigger_risks,
             trigger_searched_at, trigger_searched_by, trigger_in_flight
      FROM trends WHERE id = ?
    `).get(trendId);
    if (!row || !row.trigger_text) return null;
    const safeJson = (s, fallback) => {
      try { const v = JSON.parse(s || ''); return Array.isArray(v) ? v : fallback; }
      catch { return fallback; }
    };
    return {
      text:        row.trigger_text,
      sources:     safeJson(row.trigger_sources, []),
      confidence:  row.trigger_confidence | 0,
      phase:       row.trigger_phase  || '',
      window:      row.trigger_window || '',
      drivers:     safeJson(row.trigger_drivers, []),
      risks:       safeJson(row.trigger_risks,   []),
      searchedAt:  row.trigger_searched_at,
      searchedBy:  row.trigger_searched_by,
      inFlight:    row.trigger_in_flight === 1,
    };
  }

  /**
   * Find the most recent trigger search initiated by a given user.
   * Used to enforce the 15-minute per-user cooldown on Grok calls. Cached
   * reads (where another user did the actual Grok call) DO NOT count — they
   * don't appear in this query because `trigger_searched_by` records only the
   * user who initiated the live Grok call.
   *
   * @param {string|number} userId  chat_id
   * @returns {string|null} ISO timestamp of last search, or null if none
   */
  getLastTriggerSearchByUser(userId) {
    if (!userId) return null;
    try {
      const row = this.db.prepare(`
        SELECT MAX(trigger_searched_at) AS last_at
        FROM trends
        WHERE trigger_searched_by = ?
      `).get(String(userId));
      return row?.last_at || null;
    } catch (e) {
      this.logger?.warn?.(`getLastTriggerSearchByUser failed: ${e.message}`);
      return null;
    }
  }

  /** Most recent history rows (DESC by `at`). Empty array if no history. */
  getXAnalysisHistory(trendId, limit = 5) {
    if (!trendId) return [];
    try {
      return this.db.prepare(`
        SELECT tweet_count, total_views, total_likes, total_retweets,
               virality_score, concentration, actor_used, at
        FROM x_analysis_history
        WHERE trend_id = ?
        ORDER BY at DESC
        LIMIT ?
      `).all(trendId, limit);
    } catch (e) {
      this.logger?.warn?.(`getXAnalysisHistory failed for trend #${trendId}: ${e.message}`);
      return [];
    }
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
      // Reaction removed — delete the user's vote (and any attached reason)
      this.db.prepare(`DELETE FROM feedback_votes WHERE trend_id = ? AND chat_id = ?`).run(trendId, String(chatId));
    } else {
      // Upsert: one vote per user per trend (changing vote replaces old one).
      // NOTE: switching vote direction (e.g. 👍 → 👎) clears the previously-
      // attached reason — it described a different opinion. Same-direction
      // re-votes preserve reason via COALESCE on the existing column.
      this.db.prepare(`
        INSERT INTO feedback_votes (trend_id, chat_id, vote, weight, plan_name, reason)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(trend_id, chat_id) DO UPDATE SET
          vote=excluded.vote, weight=excluded.weight,
          plan_name=excluded.plan_name, created_at=CURRENT_TIMESTAMP,
          reason = CASE WHEN feedback_votes.vote = excluded.vote THEN feedback_votes.reason ELSE NULL END
      `).run(trendId, String(chatId), vote, weight, planName);
    }

    // Recompute weighted sum and store in trends.user_feedback
    const { weighted } = this.db.prepare(`
      SELECT COALESCE(SUM(vote * weight), 0) AS weighted FROM feedback_votes WHERE trend_id = ?
    `).get(trendId);
    this.db.prepare(`UPDATE trends SET user_feedback = ? WHERE id = ?`).run(Math.round(weighted), trendId);
  }

  /**
   * Attach (or update) a free-form reason to an existing vote. Returns true
   * if the row existed and was updated, false if there was no vote to attach
   * the reason to (caller should tell the user to vote first).
   *
   * Reason is trimmed and capped at 240 chars — long rants would bloat the
   * AI prompt context. NULL/empty string clears the reason.
   *
   * @param {number} trendId
   * @param {string} chatId
   * @param {string|null} reason
   * @returns {boolean}
   */
  setFeedbackReason(trendId, chatId, reason) {
    let clean = null;
    if (reason != null) {
      clean = String(reason).trim().slice(0, 240);
      if (clean.length === 0) clean = null;
    }
    const result = this.db.prepare(
      `UPDATE feedback_votes SET reason = ? WHERE trend_id = ? AND chat_id = ?`
    ).run(clean, trendId, String(chatId));
    return result.changes > 0;
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

  /**
   * Like getUserVote, but also returns the attached reason. Used by the
   * dashboard to pre-fill the inline "why this rating?" editor in the modal.
   * Returns { vote, reason } or null when the user hasn't voted.
   */
  getUserVoteWithReason(trendId, chatId) {
    const row = this.db.prepare(
      `SELECT vote, reason FROM feedback_votes WHERE trend_id = ? AND chat_id = ?`
    ).get(trendId, String(chatId));
    if (!row) return null;
    return { vote: row.vote, reason: row.reason || '' };
  }

  // ─── Liked / Disliked narratives (used for AI feedback context) ────────────
  //
  // Returns title + category + the highest-weight reason text per trend.
  // Filtering rules (mirror the scorer's needs):
  //   - At least one vote on the trend must come from a non-trivial source —
  //     either weight ≥ minWeight (default 0.5 → drops bare free votes) OR
  //     a reason is attached (free vote with a real explanation is valuable).
  //   - Trends WITH a reason float to the top — they're concrete examples for
  //     the AI to learn from. Bare popularity comes second.
  // `topReason` is picked by max weight, then most recent — so admin/pro
  // explanations win over free even when both are present.
  //
  // Schema returned: { title, category, user_feedback, topReason | null }
  getLikedNarratives(days = 7, limit = 10, minWeight = 0.5) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    // 2026-05-11: ai_explanation + why_now joined into the result so the
    // scorer's feedback-context block can show the AI's own description of
    // each narrative, not just title+category. Reason: a vote on
    // "Cow Fursuit Viral Warning" without context is a weak training signal —
    // models can't tell if the user liked the format, the topic, or the meme.
    // Echoing the same blurb the user saw in Telegram (alertHeader → 🤖 AI:
    // line) closes that gap.
    return this.db.prepare(`
      SELECT t.title, t.category, t.user_feedback,
        t.ai_explanation AS aiExplanation,
        t.why_now AS whyNow,
        (SELECT fv.reason FROM feedback_votes fv
         WHERE fv.trend_id = t.id AND fv.vote > 0 AND fv.reason IS NOT NULL AND TRIM(fv.reason) != ''
         ORDER BY fv.weight DESC, fv.created_at DESC LIMIT 1) AS topReason
      FROM trends t
      WHERE t.user_feedback > 0 AND t.first_seen_at > ?
        AND EXISTS (
          SELECT 1 FROM feedback_votes fv2
          WHERE fv2.trend_id = t.id AND fv2.vote > 0
            AND (fv2.weight >= ? OR (fv2.reason IS NOT NULL AND TRIM(fv2.reason) != ''))
        )
      ORDER BY (CASE WHEN topReason IS NOT NULL THEN 1 ELSE 0 END) DESC,
               t.user_feedback DESC
      LIMIT ?
    `).all(cutoff, minWeight, limit);
  }

  getDislikedNarratives(days = 7, limit = 10, minWeight = 0.5) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT t.title, t.category, t.user_feedback,
        t.ai_explanation AS aiExplanation,
        t.why_now AS whyNow,
        (SELECT fv.reason FROM feedback_votes fv
         WHERE fv.trend_id = t.id AND fv.vote < 0 AND fv.reason IS NOT NULL AND TRIM(fv.reason) != ''
         ORDER BY fv.weight DESC, fv.created_at DESC LIMIT 1) AS topReason
      FROM trends t
      WHERE t.user_feedback < 0 AND t.first_seen_at > ?
        AND EXISTS (
          SELECT 1 FROM feedback_votes fv2
          WHERE fv2.trend_id = t.id AND fv2.vote < 0
            AND (fv2.weight >= ? OR (fv2.reason IS NOT NULL AND TRIM(fv2.reason) != ''))
        )
      ORDER BY (CASE WHEN topReason IS NOT NULL THEN 1 ELSE 0 END) DESC,
               t.user_feedback ASC
      LIMIT ?
    `).all(cutoff, minWeight, limit);
  }

  /**
   * Recent feedback votes WITH a reason attached (for admin dashboard).
   * Joined to trends so the UI can show what was being discussed. Anonymized
   * `chat_id` (last 4 digits only) is enough for operator inspection.
   *
   * @param {number} limit
   * @returns {Array<{title, category, vote, weight, plan_name, reason, created_at, chat_short}>}
   */
  getRecentFeedbackReasons(limit = 30) {
    return this.db.prepare(`
      SELECT t.title, t.category,
             fv.vote, fv.weight, fv.plan_name, fv.reason, fv.created_at,
             SUBSTR(fv.chat_id, -4) AS chat_short
      FROM feedback_votes fv
      JOIN trends t ON t.id = fv.trend_id
      WHERE fv.reason IS NOT NULL AND TRIM(fv.reason) != ''
      ORDER BY fv.created_at DESC
      LIMIT ?
    `).all(limit);
  }

  // ─── Stage 1 calibration examples (CRUD for admin UI + scorer reads) ─────
  //
  // The scorer calls listStage1Examples({enabledOnly:true}) once per cycle to
  // build the cacheable examples block in SYSTEM_PROMPT. The admin UI calls
  // the full CRUD set. Validation happens at the API boundary (admin/server.js)
  // — these methods trust their inputs but still cap critical fields to keep
  // the DB sane if called directly from a script.

  /**
   * @param {object} opts
   * @param {boolean} [opts.enabledOnly=false] — only enabled rows (scorer mode)
   * @param {string|null}  [opts.kind=null]    — 'example' | 'mistake' | null=both
   */
  listStage1Examples({ enabledOnly = false, kind = null } = {}) {
    let where = '1=1';
    const params = [];
    if (enabledOnly) where += ' AND enabled = 1';
    if (kind)        { where += ' AND kind = ?'; params.push(kind); }
    return this.db.prepare(`
      SELECT id, kind, title, category, meme_potential AS memePotential,
             rationale, enabled, sort_order AS sortOrder,
             created_at AS createdAt, updated_at AS updatedAt
      FROM stage1_examples
      WHERE ${where}
      ORDER BY kind ASC, sort_order ASC, id ASC
    `).all(...params);
  }

  /**
   * @returns {number} new row id
   */
  createStage1Example({ kind, title, category, memePotential, rationale, enabled = 1, sortOrder = 0 }) {
    const cleanKind  = kind === 'mistake' ? 'mistake' : 'example';
    const cleanTitle = String(title || '').trim().slice(0, 200);
    const cleanRat   = String(rationale || '').trim().slice(0, 400);
    // mistakes have no category / score; examples must have both
    const cleanCat   = cleanKind === 'mistake' ? null : (String(category || '').trim() || null);
    const cleanMP    = cleanKind === 'mistake'
      ? null
      : Math.max(0, Math.min(100, parseInt(memePotential, 10) || 0));
    const result = this.db.prepare(`
      INSERT INTO stage1_examples (kind, title, category, meme_potential, rationale, enabled, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(cleanKind, cleanTitle, cleanCat, cleanMP, cleanRat, enabled ? 1 : 0, parseInt(sortOrder, 10) || 0);
    return result.lastInsertRowid;
  }

  /**
   * Patch fields. Pass only the keys you want to change. Returns true if a
   * row was updated, false if id was missing.
   */
  updateStage1Example(id, patch = {}) {
    const fields = [];
    const params = [];
    if (patch.kind !== undefined) {
      fields.push('kind = ?');
      params.push(patch.kind === 'mistake' ? 'mistake' : 'example');
    }
    if (patch.title !== undefined) {
      fields.push('title = ?');
      params.push(String(patch.title || '').trim().slice(0, 200));
    }
    if (patch.category !== undefined) {
      fields.push('category = ?');
      params.push(patch.category ? String(patch.category).trim() : null);
    }
    if (patch.memePotential !== undefined) {
      fields.push('meme_potential = ?');
      params.push(patch.memePotential === null ? null : Math.max(0, Math.min(100, parseInt(patch.memePotential, 10) || 0)));
    }
    if (patch.rationale !== undefined) {
      fields.push('rationale = ?');
      params.push(String(patch.rationale || '').trim().slice(0, 400));
    }
    if (patch.enabled !== undefined) {
      fields.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      params.push(parseInt(patch.sortOrder, 10) || 0);
    }
    if (fields.length === 0) return false;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(parseInt(id, 10));
    const r = this.db.prepare(`UPDATE stage1_examples SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return r.changes > 0;
  }

  deleteStage1Example(id) {
    const r = this.db.prepare(`DELETE FROM stage1_examples WHERE id = ?`).run(parseInt(id, 10));
    return r.changes > 0;
  }

  countStage1Examples() {
    return this.db.prepare(`SELECT COUNT(*) AS c FROM stage1_examples`).get().c;
  }

  // Personalization API removed 2026-04-27. The previous helpers
  // (getCategoryPreferences, getPersonalizationEnabled, setPersonalizationEnabled)
  // powered a per-user category boost on the dashboard rank sort. Removing
  // them simplifies ranking semantics — all users now see the same global
  // ordering. The users.personalization_enabled column is left in place;
  // SQLite has no cheap DROP COLUMN and the column has no consumers anymore.

  // ── Tag auto-refresh history ──────────────────────────────────────────────
  recordTagRefresh({ preset, sourceType, status, diff, errorMessage, model, costUsd }) {
    this.db.prepare(`
      INSERT INTO tag_refresh_history (preset, source_type, status, diff_json, error_message, model, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(preset),
      String(sourceType),
      String(status),
      diff ? JSON.stringify(diff) : null,
      errorMessage || null,
      model || null,
      Number.isFinite(costUsd) ? costUsd : null,
    );
  }

  getTagRefreshHistory(limit = 50) {
    return this.db.prepare(`
      SELECT id, ts, preset, source_type, status, diff_json, error_message, model, cost_usd
      FROM tag_refresh_history
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(Number(limit) || 50);
  }

  // ── Alert score history (sparkline) ──────────────────────────────────────
  // Append one row per recompute. breakdown is the object returned by
  // computeAlertScore(); we extract score/positive/penalty. floorAtTs is
  // the effective alert floor at write time (max of admin/user threshold).
  // source is "scan" | "refresh-light" | "refresh-hot" | "manual" — useful
  // for charting "this jump came from a hot refresh, not new feedback".
  recordAlertScoreHistory({ trendId, breakdown, floorAtTs, source = 'scan' }) {
    if (!trendId || !breakdown) return;
    const score = Number(breakdown.score ?? breakdown.alertScore);
    if (!Number.isFinite(score)) return;
    try {
      this.db.prepare(`
        INSERT INTO alert_score_history (trend_id, score, positive, penalty, floor_at_ts, source)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        Number(trendId),
        Math.round(score),
        Number.isFinite(breakdown.positive) ? Math.round(breakdown.positive) : null,
        Number.isFinite(breakdown.penalty)  ? Math.round(breakdown.penalty)  : null,
        Number.isFinite(floorAtTs) ? Math.round(floorAtTs) : null,
        source ? String(source).slice(0, 32) : null,
      );
    } catch { /* non-fatal: history is decorative */ }
  }

  /**
   * Record many alert-score-history rows in ONE transaction (audit DB-013/TXN).
   * recordAlertScoreHistory swallows its own errors (decorative data), so this
   * batch is resilient by construction — a bad row is skipped, the rest commit.
   *
   * @param {Array<{trendId, breakdown, floorAtTs, source}>} rows
   * @returns {number} number of rows processed
   */
  recordAlertScoreHistoryBatch(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const run = this.db.transaction((items) => {
      for (const r of items) this.recordAlertScoreHistory(r);
      return items.length;
    });
    return run(rows);
  }

  // Read last N points for a trend (newest first). Limit caps the array
  // size; the dashboard uses ~100 which gives ~3-4 days at hourly recompute.
  getAlertScoreHistory(trendId, limit = 100) {
    if (!trendId) return [];
    return this.db.prepare(`
      SELECT ts, score, positive, penalty, floor_at_ts AS floorAtTs, source
      FROM alert_score_history
      WHERE trend_id = ?
      ORDER BY ts ASC, id ASC
      LIMIT ?
    `).all(Number(trendId), Math.max(1, Math.min(1000, Number(limit) || 100)));
  }

  // Daily prune. retentionDays defaults to 30 — sparkline rarely shows more
  // than a week visually, but keeping a month means we can debug "why did
  // this trend's score drop yesterday" after the fact.
  pruneAlertScoreHistory(retentionDays = 30) {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    const r = this.db.prepare(`DELETE FROM alert_score_history WHERE ts < ?`).run(cutoff);
    return r.changes | 0;
  }

  close() {
    this.db.close();
  }

  // ── Bundle #2 (2026-06-07): observability persistence ───────────────────
  // See docs/superpowers/specs/2026-06-07-observability-persistence-design.md

  /**
   * Record an admin-side audit event (plan changes, admin actions, etc.).
   * Synchronous insert. Safe to call inside an outer db.transaction(); will
   * participate in that transaction's atomicity.
   *
   * @param {string} eventType - e.g. 'plan_grant_admin', 'plan_revoke', 'plan_upgrade'
   * @param {number|null} actorUserId - admin doing the action (null = system)
   * @param {string} actorKind - 'admin' | 'system' | 'user_self'
   * @param {number|null} targetUserId - the user affected
   * @param {Object|null} payload - JSON-serializable structured payload
   * @param {boolean} success
   */
  recordAuditEvent(eventType, actorUserId, actorKind, targetUserId, payload, success = true) {
    try {
      return this.db.prepare(`
        INSERT INTO admin_audit_log (event_type, actor_user_id, actor_kind, target_user_id, payload_json, success)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        eventType,
        actorUserId ?? null,
        actorKind || 'admin',
        targetUserId ?? null,
        payload ? JSON.stringify(payload) : null,
        success ? 1 : 0,
      );
    } catch (e) {
      this.logger.error('[audit] recordAuditEvent failed', { err: e.message, eventType, actorUserId, targetUserId });
      return null;
    }
  }

  /**
   * Record one alert-dispatcher decision. Called from src/index.js
   * recordAlertDecision() as a fire-and-forget dual write. Errors are
   * swallowed — never blocks the alert flow.
   *
   * @param {Object} rec
   * @param {number|null} rec.trendId
   * @param {number|null} rec.userId
   * @param {string|null} rec.source
   * @param {string} rec.reason - 'sent' | 'skipped_seen' | ...
   * @param {Object|null} [rec.gates]
   * @param {Object|null} [rec.weights]
   * @param {boolean} [rec.sent]
   */
  recordAlertDecision({ trendId, userId, source, reason, gates, weights, sent }) {
    try {
      return this.db.prepare(`
        INSERT INTO alert_decisions (trend_id, user_id, source, reason, gates_json, weights_json, sent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        trendId ?? null,
        userId ?? null,
        source || null,
        reason,
        gates ? JSON.stringify(gates) : null,
        weights ? JSON.stringify(weights) : null,
        sent ? 1 : 0,
      );
    } catch (e) {
      this.logger.error('[audit] recordAlertDecision failed', { err: e.message, trendId, userId, reason });
      return null;
    }
  }

  /**
   * Record one feature usage hit (cost cap event). Called from dashboard
   * cost-cap callsites instead of mutating in-memory Maps.
   *
   * @param {number} userId
   * @param {string} feature - 'manualAnalysis' | 'catalyst'
   */
  recordFeatureUsage(userId, feature) {
    if (!userId || !feature) return null;
    try {
      return this.db.prepare(`
        INSERT INTO feature_usage_log (user_id, feature) VALUES (?, ?)
      `).run(userId, feature);
    } catch (e) {
      this.logger.error('[audit] recordFeatureUsage failed', { err: e.message, userId, feature });
      return null;
    }
  }

  /**
   * Get all hit timestamps (epoch ms) for user/feature within the last
   * `windowMs` milliseconds. Returns ASC-ordered array; empty on error or
   * no hits. Matches the legacy in-memory `hits` array shape so caller
   * code (cooldown check, length-based cap) is preserved.
   *
   * @param {number} userId
   * @param {string} feature
   * @param {number} windowMs
   * @returns {number[]}
   */
  getRecentFeatureUsageHits(userId, feature, windowMs) {
    if (!userId || !feature || !windowMs) return [];
    try {
      const sinceMs = Date.now() - windowMs;
      // strftime('%s', ts) returns UTC seconds-since-epoch (text). Cast →
      // INTEGER and multiply by 1000 for ms. Compared against sinceMs in
      // both filter and SELECT for consistency.
      const rows = this.db.prepare(`
        SELECT CAST(strftime('%s', ts) AS INTEGER) * 1000 AS ms
        FROM feature_usage_log
        WHERE user_id = ?
          AND feature = ?
          AND CAST(strftime('%s', ts) AS INTEGER) * 1000 > ?
        ORDER BY ts ASC
      `).all(userId, feature, sinceMs);
      return rows.map(r => r.ms);
    } catch (e) {
      this.logger.error('[audit] getRecentFeatureUsageHits failed', { err: e.message, userId, feature });
      return [];
    }
  }

  /**
   * Delete alert_decisions older than `retentionDays`. Called daily.
   * Returns number of rows deleted.
   */
  pruneAlertDecisions(retentionDays) {
    try {
      const res = this.db.prepare(`DELETE FROM alert_decisions WHERE ts < datetime('now', ?)`)
        .run(`-${retentionDays} days`);
      if (res.changes > 0) {
        this.logger.info(`[Maintenance] alert_decisions: pruned ${res.changes} rows older than ${retentionDays}d`);
      }
      return res.changes;
    } catch (e) {
      this.logger.warn(`[Maintenance] pruneAlertDecisions failed: ${e.message}`);
      return 0;
    }
  }

  /**
   * Delete feature_usage_log older than `retentionDays`. Called daily.
   */
  pruneFeatureUsageLog(retentionDays) {
    try {
      const res = this.db.prepare(`DELETE FROM feature_usage_log WHERE ts < datetime('now', ?)`)
        .run(`-${retentionDays} days`);
      if (res.changes > 0) {
        this.logger.info(`[Maintenance] feature_usage_log: pruned ${res.changes} rows older than ${retentionDays}d`);
      }
      return res.changes;
    } catch (e) {
      this.logger.warn(`[Maintenance] pruneFeatureUsageLog failed: ${e.message}`);
      return 0;
    }
  }

  pruneNotifications(retentionDays = 30) {
    const res = this.db.prepare(
      `DELETE FROM notifications WHERE sent_at < datetime('now', ?)`
    ).run(`-${retentionDays} days`);
    return res.changes | 0;
  }

  pruneFeedbackVotes(retentionDays = 90) {
    const res = this.db.prepare(
      `DELETE FROM feedback_votes WHERE created_at < datetime('now', ?)`
    ).run(`-${retentionDays} days`);
    return res.changes | 0;
  }

  pruneXAnalysisHistory(retentionDays = 90) {
    const res = this.db.prepare(
      `DELETE FROM x_analysis_history WHERE at < datetime('now', ?)`
    ).run(`-${retentionDays} days`);
    return res.changes | 0;
  }

  pruneTagRefreshHistory(retentionDays = 365) {
    const res = this.db.prepare(
      `DELETE FROM tag_refresh_history WHERE ts < datetime('now', ?)`
    ).run(`-${retentionDays} days`);
    return res.changes | 0;
  }

  pruneAuthSessions(maxAgeHours = 24) {
    const res = this.db.prepare(
      `DELETE FROM auth_sessions WHERE token IS NULL AND created_at < datetime('now', ?)`
    ).run(`-${maxAgeHours} hours`);
    return res.changes | 0;
  }
}

export default TrendDatabase;
