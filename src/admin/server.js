/**
 * Catalyst Admin Panel — Port 8080
 * Управление пользователями, подписками, статистикой и ботом
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import { sqliteCutoff } from '../utils/sqlite-time.js';
import {
  PRESET_KEYS as PRESET_CONFIG_KEYS,
  PRESET_GROUPS,
  PRESET_FIELD_RANGES,
  DEFAULT_PRESET_CONFIGS,
  getEffectivePresetConfigs,
  validatePresetOverrides,
  readPresetTagsLocked,
  validatePresetTagsLocked,
  readPresetAutoOverrides,
  mergeOverrideBlobs,
} from '../analysis/preset-config.js';
import { runManualAnalysis } from '../analysis/manual-analysis.js';
import { withTelegramRetry } from '../notifications/telegram-retry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) { timingSafeEqual(ba, ba); return false; }
    return timingSafeEqual(ba, bb);
  } catch { return false; }
}

// Security defaults — same posture as dashboard/server.js. Admin panel is
// even more sensitive (full DB access via X-Admin-Key) so we keep the same
// strict headers regardless of where it's deployed.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

// CORS allowlist via env. Default empty - admin panel binds to 127.0.0.1 by
// default (see ctor), so cross-origin requests are unusual. If you reverse-
// proxy admin to a public URL, set ADMIN_ALLOWED_ORIGINS.
const ALLOWED_ORIGINS = (process.env.ADMIN_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function corsOriginFor(req) {
  const origin = String(req.headers?.origin || '');
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

function buildHeaders(req) {
  const headers = { ...SECURITY_HEADERS };
  const origin = corsOriginFor(req);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(res, status, data) {
  const base = res._defaultHeaders || SECURITY_HEADERS;
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    ...base,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 32 * 1024;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      body += c;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── Admin Server ─────────────────────────────────────────────────────────────

class AdminServer {
  constructor(config, logger, db, bot, appState = null, scanFn = null, extras = {}) {
    this.config = config;
    this.logger = logger;
    this.db = db;
    this.bot = bot;
    this.appState = appState || { paused: false, disabledCollectors: new Set() };
    this.scanFn = scanFn; // optional callback to trigger manual scan
    // Injected components for the manual-submit feature (POST /api/submit-narrative).
    // All optional — handlers return 503 when missing.
    this.scorer = extras.scorer || null;
    this.clusterer = extras.clusterer || null;   // NarrativeClusterer instance — used by manual-submit to compute emergence (lookup-based path) so manual ≈ scanner on identical input.
    this.telegram = extras.telegram || null;
    this.triggerFinder = extras.triggerFinder || null;  // Grok deep-search for SubmitPage trigger button
    this.hotRefresher = extras.hotRefresher || null;    // periodic re-fetch + re-score loop (status + manual trigger)
    this.tagRefresher = extras.tagRefresher || null;    // weekly Grok call to refresh source-tags (Phase 1 stub)
    // AlertScheduler instance — exposes /api/alert-scheduler GET (config+stats)
    // and POST (config update). When null, the admin panel still renders the
    // settings card but the live-stats block hides itself with "scheduler not
    // wired" so dev-runs without index.js still work.
    this.alertScheduler = extras.alertScheduler || null;
    this.port = parseInt(process.env.ADMIN_PORT || '8080');
    this.host = process.env.ADMIN_HOST || '127.0.0.1';
    this.adminKey = process.env.ADMIN_API_KEY || '';
    this.server = null;
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  _auth(req) {
    if (!this.adminKey) return false;
    const key = req.headers['x-admin-key'] || '';
    return safeEqual(key, this.adminKey);
  }

  // ── DB Queries ──────────────────────────────────────────────────────────────
  _getAllUsers(search = '', plan = '', status = '') {
    let q = `SELECT u.id, u.telegram_chat_id, u.telegram_username, u.language,
      u.status, u.alert_threshold, u.alert_count_today, u.subscription_expires_at,
      u.created_at, u.last_seen_at, p.name as plan_name, p.price_usd as plan_price
      FROM users u JOIN plans p ON u.plan_id = p.id WHERE 1=1`;
    const params = [];
    if (search) { q += ` AND (u.telegram_username LIKE ? OR u.telegram_chat_id LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
    if (plan) { q += ` AND p.name = ?`; params.push(plan); }
    if (status) { q += ` AND u.status = ?`; params.push(status); }
    q += ` ORDER BY u.created_at DESC LIMIT 200`;
    return this.db.db.prepare(q).all(...params);
  }

  _getPayments(limit = 50, offset = 0) {
    return this.db.db.prepare(`
      SELECT p.*, u.telegram_username, u.telegram_chat_id
      FROM payments p LEFT JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  _getStats() {
    const db = this.db.db;
    const now = new Date();
    const day7 = sqliteCutoff(7*86400000);
    const day30 = sqliteCutoff(30*86400000);

    const totalUsers = db.prepare(`SELECT COUNT(*) as n FROM users`).get().n;
    const activeUsers = db.prepare(`SELECT COUNT(*) as n FROM users WHERE status='active'`).get().n;
    const newToday = db.prepare(`SELECT COUNT(*) as n FROM users WHERE date(created_at) = date('now')`).get().n;
    const newWeek = db.prepare(`SELECT COUNT(*) as n FROM users WHERE created_at > ?`).get(day7).n;
    const newMonth = db.prepare(`SELECT COUNT(*) as n FROM users WHERE created_at > ?`).get(day30).n;

    const paidUsers = db.prepare(`SELECT COUNT(*) as n FROM users u JOIN plans p ON u.plan_id=p.id WHERE p.name != 'free'`).get().n;
    const revenue30 = db.prepare(`SELECT COALESCE(SUM(amount),0) as r FROM payments WHERE status='confirmed' AND created_at > ?`).get(day30).r;
    const revenueTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) as r FROM payments WHERE status='confirmed'`).get().r;
    const revenue30ByCurrency = db.prepare(`
      SELECT currency, COALESCE(SUM(amount),0) as total
      FROM payments
      WHERE status='confirmed' AND created_at > ?
      GROUP BY currency
      ORDER BY currency
    `).all(day30);
    const revenueTotalByCurrency = db.prepare(`
      SELECT currency, COALESCE(SUM(amount),0) as total
      FROM payments
      WHERE status='confirmed'
      GROUP BY currency
      ORDER BY currency
    `).all();

    const planDist = db.prepare(`SELECT p.name, COUNT(*) as n FROM users u JOIN plans p ON u.plan_id=p.id GROUP BY p.name`).all();
    const langDist = db.prepare(`SELECT language, COUNT(*) as n FROM users GROUP BY language`).all();

    // Daily new users for last 14 days
    const dailyNew = db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as n FROM users
      WHERE created_at > datetime('now', '-14 days')
      GROUP BY day ORDER BY day
    `).all();

    // Daily revenue last 14 days
    const dailyRevenue = db.prepare(`
      SELECT date(created_at) as day, SUM(amount) as total FROM payments
      WHERE status='confirmed' AND created_at > datetime('now', '-14 days')
      GROUP BY day ORDER BY day
    `).all();

    const storage = this.db.getStorageStats();

    const stats = {
      users: { total: totalUsers, active: activeUsers, paid: paidUsers, newToday, newWeek, newMonth },
      revenue: {
        total: revenueTotal,
        last30days: revenue30,
        byCurrencyTotal: revenueTotalByCurrency,
        byCurrency30days: revenue30ByCurrency,
      },
      planDist,
      langDist,
      dailyNew,
      dailyRevenue,
      storage,
    };

    // Bundle #6 — backup status info for admin UI Backup card.
    const BACKUP_DIR = '/var/backups/catalyst';
    let backup = { lastBackupAt: null, lastBackupBytes: 0, dirExists: false };
    try {
      if (fs.existsSync(BACKUP_DIR)) {
        backup.dirExists = true;
        const files = fs.readdirSync(BACKUP_DIR)
          .filter(n => n.endsWith('.db.gz'))
          .map(n => ({ n, stat: fs.statSync(path.join(BACKUP_DIR, n)) }))
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        if (files.length > 0) {
          backup.lastBackupAt = files[0].stat.mtimeMs;
          backup.lastBackupBytes = files[0].stat.size;
        }
      }
    } catch { /* best-effort */ }
    stats.backup = backup;

    return stats;
  }

  _getPlans() {
    // Explicit order: free → test → pro → admin
    return this.db.db.prepare(`
      SELECT * FROM plans
      ORDER BY CASE name
        WHEN 'free'  THEN 1
        WHEN 'test'  THEN 2
        WHEN 'pro'   THEN 3
        WHEN 'admin' THEN 4
        ELSE 99
      END
    `).all();
  }

  _updatePlan(id, fields) {
    const allowed = ['price_usd', 'alert_limit', 'history_days', 'max_sources'];
    const sets = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([k]) => `${k}=?`);
    const vals = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([,v]) => v);
    if (!sets.length) return;
    this.db.db.prepare(`UPDATE plans SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
  }

  _getFeedbackConfig() {
    return {
      enabled:     this.db.getSetting('feedbackWeightingEnabled', '1') !== '0',
      // Defaults mirror the one-time rebalance migration in database.js
      // (admin=5, pro=2.5, test=0.5, free=0.2). The migration writes these
      // keys explicitly, so these fallbacks only matter for ops who deleted
      // the rows manually.
      weightAdmin: parseFloat(this.db.getSetting('feedbackWeightAdmin', '5')   || '5'),
      weightPro:   parseFloat(this.db.getSetting('feedbackWeightPro',   '2.5') || '2.5'),
      weightTest:  parseFloat(this.db.getSetting('feedbackWeightTest',  '0.5') || '0.5'),
      weightFree:  parseFloat(this.db.getSetting('feedbackWeightFree',  '0.2') || '0.2'),
    };
  }

  _setFeedbackConfig({ enabled, weightAdmin, weightPro, weightTest, weightFree }) {
    if (enabled !== undefined) this.db.setSetting('feedbackWeightingEnabled', enabled ? '1' : '0');
    if (weightAdmin !== undefined) this.db.setSetting('feedbackWeightAdmin', String(parseFloat(weightAdmin) || 1));
    if (weightPro   !== undefined) this.db.setSetting('feedbackWeightPro',   String(parseFloat(weightPro)   || 1));
    if (weightTest  !== undefined) this.db.setSetting('feedbackWeightTest',  String(parseFloat(weightTest)  || 1));
    if (weightFree  !== undefined) this.db.setSetting('feedbackWeightFree',  String(parseFloat(weightFree)  || 1));
  }

  // Stage 1 examples — boundary validation. Returns null on OK, error string
  // on first failure. `partial` mode (PUT) only checks fields that are present;
  // `full` mode (POST) requires the minimum useful payload.
  // Category enum mirrors STAGE1_RESPONSE_SCHEMA — keep in sync if either changes.
  _validateStage1Example(body, { partial = false } = {}) {
    if (!body || typeof body !== 'object') return 'Body must be an object';
    const CATEGORY_ENUM = ['meme','celebrity','animals','tech','gambling',
                            'sports','politics','entertainment','gaming',
                            'boring','other'];
    const needsField = (key) => !partial || body[key] !== undefined;

    if (needsField('kind')) {
      if (body.kind !== 'example' && body.kind !== 'mistake') {
        return 'kind must be "example" or "mistake"';
      }
    }
    if (needsField('title')) {
      const t = String(body.title || '').trim();
      if (t.length < 5)   return 'title is too short (min 5 chars)';
      if (t.length > 200) return 'title is too long (max 200 chars)';
    }
    if (needsField('rationale')) {
      const r = String(body.rationale || '').trim();
      if (r.length < 10)  return 'rationale is too short (min 10 chars)';
      if (r.length > 400) return 'rationale is too long (max 400 chars)';
    }
    // For "example" kind we additionally require category + memePotential.
    // For "mistake" kind those fields are NULL by design.
    const isExample = partial
      ? (body.kind === undefined ? null : body.kind === 'example')
      : body.kind === 'example';
    if (isExample === true || (isExample === null && body.category !== undefined)) {
      if (body.category !== undefined && body.category !== null) {
        if (!CATEGORY_ENUM.includes(String(body.category))) {
          return `category must be one of: ${CATEGORY_ENUM.join(', ')}`;
        }
      } else if (!partial) {
        return 'category is required for kind=example';
      }
    }
    if (isExample === true || (isExample === null && body.memePotential !== undefined)) {
      if (body.memePotential !== undefined && body.memePotential !== null) {
        const n = parseInt(body.memePotential, 10);
        if (isNaN(n) || n < 0 || n > 100) return 'memePotential must be 0..100';
      } else if (!partial) {
        return 'memePotential is required for kind=example';
      }
    }
    return null;
  }

  _getScannerConfig() {
    // Int settings — orthogonal scanner-wide knobs that remain GLOBAL
    // (not per-preset). Per-preset alert / weights / stale moved to the
    // "Пресеты" admin tab in 2026-05-01 PR-2.
    const numDefaults = {
      // Drop Twitter tweets older than this many hours before they enter the pipeline.
      // 0 disables the filter.
      twitterMaxAgeHours: 72,
      // Drop TikTok videos older than this many days before they enter the pipeline.
      // TikTok's /tag/<x> page is editorially ranked — Apify often surfaces 2023
      // evergreen videos among current trends. 0 disables the filter. Default 7d.
      tiktokMaxAgeDays: 7,
      // Cooldown for re-scoring already-scored items. If the same URL shows
      // up again AND was never alerted AND last_seen_at > this many hours ago,
      // the aggregator lets it through to AI again. 0 = disables re-analysis
      // (classic "block forever" behaviour).
      rescoreCooldownHours: 3,
      // AI Stage 2 gates — tune in UI to balance x_search cost vs coverage
      stage2Threshold: 60,
      stage2MaxCalls:  6,
      // Cycle intervals — runtime-tunable since 2026-05-11. Defaults match
      // env defaults (SCAN_INTERVAL_MINUTES=15, TIKTOK_CYCLE_INTERVAL_MINUTES=30).
      // Picked up live: scan-cycle via self-rescheduling setTimeout in index.js,
      // TikTok via _getCycleIntervalMinutes() each collect(). No restart needed.
      scanIntervalMinutes:        15,
      tiktokCycleIntervalMinutes: 30,
    };
    const merged = {};
    for (const [k, v] of Object.entries(numDefaults)) {
      const s = this.db.getSetting(k);
      merged[k] = (s !== undefined && s !== null && s !== '') ? Number(s) : v;
    }
    merged.activePreset = this.db.getSetting('activePreset', 'general') || 'general';
    // Which Twitter/X scraper is active (maps to an actor in src/collectors/twitter.js)
    merged.twitterActor = (this.db.getSetting('twitterActor', 'kaitoeasyapi') || 'kaitoeasyapi').toLowerCase();
    // Same for TikTok (src/collectors/tiktok.js ACTORS).
    merged.tiktokActor  = (this.db.getSetting('tiktokActor',  'clockworks')   || 'clockworks').toLowerCase();
    return merged;
  }

  _setScannerConfig(body) {
    const VALID_PRESETS = new Set(['general', 'animals', 'culture', 'celebrities', 'events']);
    if ('activePreset' in body) {
      if (!VALID_PRESETS.has(body.activePreset)) throw new Error('Invalid preset');
      this.db.setSetting('activePreset', body.activePreset);
    }
    // Twitter/X scraper actor — must match keys in src/collectors/twitter.js ACTORS.
    // When adding a new actor there, also extend this set.
    const VALID_TWITTER_ACTORS = new Set(['kaitoeasyapi', 'xquik']);
    if ('twitterActor' in body) {
      const a = String(body.twitterActor || '').toLowerCase();
      if (!VALID_TWITTER_ACTORS.has(a)) throw new Error('Invalid twitterActor');
      this.db.setSetting('twitterActor', a);
    }
    // TikTok scraper actor — must match keys in src/collectors/tiktok.js ACTORS.
    const VALID_TIKTOK_ACTORS = new Set(['clockworks', 'apidojo']);
    if ('tiktokActor' in body) {
      const a = String(body.tiktokActor || '').toLowerCase();
      if (!VALID_TIKTOK_ACTORS.has(a)) throw new Error('Invalid tiktokActor');
      this.db.setSetting('tiktokActor', a);
    }
    // Allowed-list trimmed in 2026-05-01 PR-2: per-preset fields (alert
    // thresholds / weights / stale decay / cluster) moved to settings.presetConfigs
    // and live behind /api/preset-configs. Anything POSTed here gets silently
    // ignored if not in this list — clients should migrate.
    const allowedInt = {
      twitterMaxAgeHours:         { min: 0,  max: 720 },
      tiktokMaxAgeDays:           { min: 0,  max: 60  },
      rescoreCooldownHours:       { min: 0,  max: 168 },
      stage2Threshold:            { min: 0,  max: 100 },
      stage2MaxCalls:             { min: 0,  max: 20  },
      // Cycle intervals — clamp ranges mirrored in index.js (readIntervalMs)
      // and tiktok.js (_getCycleIntervalMinutes). Don't widen here without
      // matching the runtime fallback paths — out-of-range DB values are
      // silently ignored and the env default takes over.
      scanIntervalMinutes:        { min: 5,  max: 60  },
      tiktokCycleIntervalMinutes: { min: 10, max: 120 },
    };
    for (const [key, rules] of Object.entries(allowedInt)) {
      if (!(key in body)) continue;
      const val = Number(body[key]);
      if (isNaN(val) || val < rules.min || val > rules.max) {
        throw new Error(`${key}: must be ${rules.min}-${rules.max}`);
      }
      this.db.setSetting(key, Math.round(val));
    }
    // Float settings — empty after PR-2 (alertWeight* moved to per-preset).
    // Block kept for any future global float knobs to slot in.
  }

  // ── Junk-reason stats over the last N hours ─────────────────────────────────
  // Reads raw_metrics from trends table, aggregates junkReasons occurrences.
  // Used by the admin UI to answer "что у нас чаще всего режет junk-filter?".
  _getJunkStats(hours = 24) {
    const rows = this.db.db.prepare(
      "SELECT raw_metrics, source FROM trends WHERE first_seen_at > datetime('now', ?)"
    ).all('-' + Math.max(1, Math.min(720, hours | 0)) + ' hours');

    const reasonCounts = {};   // { politics: 12, 'no-meme-shape': 30, ... }
    const sourceCounts = {};   // { reddit: 50, twitter: 20, ... }
    let totalTrends       = 0;
    let trendsWithPenalty = 0;
    let sumPenalty        = 0;
    let maxPenalty        = 0;
    let memeShapeHits     = 0;

    for (const r of rows) {
      totalTrends++;
      sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
      if (!r.raw_metrics) continue;
      let m;
      try { m = JSON.parse(r.raw_metrics); } catch (_) { continue; }
      const p = Number(m.junkPenalty || 0);
      if (p > 0) {
        trendsWithPenalty++;
        sumPenalty += p;
        if (p > maxPenalty) maxPenalty = p;
      }
      if (Array.isArray(m.junkReasons)) {
        for (const reason of m.junkReasons) {
          // Strip "safe-override(÷N)" variance so they all aggregate together
          const key = String(reason).startsWith('safe-override') ? 'safe-override' : String(reason);
          reasonCounts[key] = (reasonCounts[key] || 0) + 1;
        }
      }
      if (Array.isArray(m.memeShapeSignals) && m.memeShapeSignals.length > 0) {
        memeShapeHits++;
      }
    }

    // Sort reasons by count desc for stable rendering
    const topReasons = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count, pctOfTotal: totalTrends ? Math.round(count * 100 / totalTrends) : 0 }));

    return {
      windowHours:       hours,
      totalTrends,
      trendsWithPenalty,
      avgPenalty:        trendsWithPenalty ? Math.round(sumPenalty / trendsWithPenalty) : 0,
      maxPenalty,
      memeShapeHits,
      memeShapePct:      totalTrends ? Math.round(memeShapeHits * 100 / totalTrends) : 0,
      topReasons,
      sourceCounts,
    };
  }

  // ── Preset configs (full per-preset pipeline tuning, PR-1) ──────────────────
  // Single source of truth for everything that varies by preset: sources,
  // junk, alerts (thresholds/weights/stale), cluster. Stored as a sparse
  // JSON blob in settings.presetConfigs — only fields differing from the
  // defaults in preset-config.js are persisted.
  //
  // GET returns enough metadata for the admin UI to render every control:
  //   - defaults:    full table { <preset>: { sources, junk, alerts, cluster } }
  //   - effective:   defaults deep-merged with current overrides
  //   - overrides:   raw sparse blob actually stored
  //   - fieldRanges: { sources: {...}, junk: {...}, alerts: {...}, cluster: {...} }
  //   - presets:     ordered list of preset keys (UI tab order)
  //   - groups:      ordered list of top-level groups (UI accordion order)
  _getPresetConfigs() {
    let overrides = {};
    const raw = this.db.getSetting('presetConfigs', null);
    if (raw) {
      try { overrides = JSON.parse(raw) || {}; }
      catch (_) { overrides = {}; }
    }

    // Effective config must mirror what production sees in `getActivePresetConfig`
    // — that's `defaults → auto → manual` (3-layer). The pre-2026-05-12 admin UI
    // only computed `defaults → manual`, completely ignoring the auto-tags
    // layer. Result: after Wipe-manual the admin UI showed the hardcoded
    // legacy tags (skibidi/dog-cat-animal/etc.) instead of the freshly
    // refreshed Grok queries. Operator thought tag-refresh was broken,
    // but really only the UI was lying — collectors on prod always merged
    // all 3 layers correctly.
    const autoOverrides = readPresetAutoOverrides(this.db);
    const mergedForEffective = mergeOverrideBlobs(autoOverrides, overrides);

    return {
      defaults:    DEFAULT_PRESET_CONFIGS,
      effective:   getEffectivePresetConfigs(mergedForEffective),
      overrides,        // manual layer — what the editing UI mutates
      autoOverrides,    // auto layer — exposed for debug pane / future "Auto" inspector
      tagsLocked:  readPresetTagsLocked(this.db),
      fieldRanges: PRESET_FIELD_RANGES,
      presets:     PRESET_CONFIG_KEYS,
      groups:      PRESET_GROUPS,
    };
  }

  _setPresetConfigs(body) {
    const cleaned = validatePresetOverrides(body?.overrides);
    const cleanedLocks = body?.tagsLocked !== undefined
      ? validatePresetTagsLocked(body.tagsLocked)
      : null;  // null = caller didn't touch locks, leave existing as-is

    const manualEmpty = Object.keys(cleaned).length === 0;
    const locksEmpty  = cleanedLocks !== null && Object.keys(cleanedLocks).length === 0;

    // Manual layer save — empty draft just clears the slot. Auto-overrides
    // and locks are independent slots; saving manual doesn't touch them.
    // (Note: pre-2026-05-12 there was a "panic-clear" path here that wiped
    // auto-overrides when both manual AND locks came in empty. Removed
    // because we now have explicit "Wipe manual" + "Restore hardcoded"
    // buttons in the UI — operator chooses intent, no implicit side effects.)
    if (manualEmpty) this.db.setSetting('presetConfigs', '');
    else             this.db.setSetting('presetConfigs', JSON.stringify(cleaned));

    if (cleanedLocks !== null) {
      this.db.setSetting('presetTagsLocked', locksEmpty ? '' : JSON.stringify(cleanedLocks));
    }
  }

  // ── Restore hardcoded sources into manual layer ─────────────────────────
  // Escape hatch: if Auto-tags goes off the rails (Grok hallucinations,
  // bad reality-check, broken curator mode) — operator can one-click pin
  // the hardcoded DEFAULT_PRESET_CONFIGS sources into manual layer. Since
  // manual ALWAYS wins in merge order, this blocks any future auto-refresh
  // from changing tags until operator clears manual again.
  //
  // Copies ONLY sources (reddit subreddits + twitter queries + tiktok
  // hashtags) — not junk-penalties / alert-weights / cluster-similarity.
  // Those manual overrides (if any) are preserved verbatim, only the
  // sources sub-tree gets replaced. Locks untouched.
  //
  // Result: operator sees the legacy hardcoded tag-list (skibidi/delulu/
  // dog-cat-animal/meme-viral/etc.) in effective config — known-good
  // baseline, never silently mutated.
  _restoreHardcodedPresetSources() {
    let existingManual = {};
    const raw = this.db.getSetting('presetConfigs', null);
    if (raw) {
      try { existingManual = JSON.parse(raw) || {}; }
      catch (_) { existingManual = {}; }
    }

    const next = JSON.parse(JSON.stringify(existingManual));
    for (const preset of Object.keys(DEFAULT_PRESET_CONFIGS)) {
      if (!next[preset]) next[preset] = {};
      // Deep-clone the defaults.sources sub-tree so manual layer owns it
      // and isn't a live reference into the imported constant.
      next[preset].sources = JSON.parse(JSON.stringify(
        DEFAULT_PRESET_CONFIGS[preset]?.sources || {}
      ));
    }

    // Validate through the same path Save uses — guards against any
    // accidental shape drift in DEFAULT_PRESET_CONFIGS.
    const validated = validatePresetOverrides(next);
    this.db.setSetting('presetConfigs', JSON.stringify(validated));
  }

  _getAiConfig() {
    const VALID_PROVIDERS = ['xai', 'openai', 'gemini', 'grokcli'];
    const rawProvider = (this.db.getSetting('aiProvider', 'xai') || 'xai').toLowerCase();
    const provider = VALID_PROVIDERS.includes(rawProvider) ? rawProvider : 'xai';

    const xaiModel    = this.db.getSetting('xaiModel',    process.env.XAI_MODEL    || 'grok-4-1-fast-non-reasoning');
    const openaiModel = this.db.getSetting('openaiModel', process.env.OPENAI_MODEL || 'gpt-5.4-mini');
    // Gemini Stage 1: routes through Google's OpenAI-compat layer
    // (/v1beta/openai/chat/completions). Reuses GOOGLE_AI_API_KEY (same key
    // used by Stage 0b captioner) so a single Google key powers both stages.
    const geminiModel = this.db.getSetting('geminiModel', process.env.GEMINI_STAGE1_MODEL || 'gemini-3.1-flash-lite');
    const grokcliModel = this.db.getSetting('grokcliModel', 'grok-build');

    const stage2Enabled = String(this.db.getSetting('aiStage2Enabled', '1')) !== '0';
    const deepReasoningEnabled = String(this.db.getSetting('deepReasoningEnabled', '0')) !== '0';
    const stage2ReasoningModel = this.db.getSetting('stage2ReasoningModel', '');
    const escalationReserve = parseInt(this.db.getSetting('escalationReserve', '2'), 10) || 2;
    const currentModel =
      provider === 'openai' ? openaiModel :
      provider === 'gemini' ? geminiModel :
      provider === 'grokcli' ? grokcliModel :
      xaiModel;

    return {
      provider,
      model: currentModel,
      xaiModel,
      openaiModel,
      geminiModel,
      grokcliModel,
      stage2Enabled,
      deepReasoningEnabled,
      stage2ReasoningModel,
      escalationReserve,
      hasXaiKey:    !!process.env.XAI_API_KEY,
      hasOpenaiKey: !!process.env.OPENAI_API_KEY,
      hasGeminiKey: !!process.env.GOOGLE_AI_API_KEY,
      grokSessionAlive: !!(this.scorer && this.scorer._grokSessionAlive),
      xaiBaseUrl:    process.env.XAI_BASE_URL    || 'https://api.x.ai/v1',
      openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      geminiBaseUrl: process.env.GEMINI_OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    };
  }

  _setAiConfig({ provider, model, stage2Enabled, deepReasoningEnabled, stage2ReasoningModel, escalationReserve }) {
    const safeProvider = String(provider || '').toLowerCase();
    if (!['xai', 'openai', 'gemini', 'grokcli'].includes(safeProvider)) {
      throw new Error('Invalid AI provider');
    }
    this.db.setSetting('aiProvider', safeProvider);

    const cleanModel = String(model || '').trim();
    if (cleanModel.length > 0) {
      const modelKey =
        safeProvider === 'openai'  ? 'openaiModel'  :
        safeProvider === 'gemini'  ? 'geminiModel'  :
        safeProvider === 'grokcli' ? 'grokcliModel' :
        'xaiModel';
      this.db.setSetting(modelKey, cleanModel);
    }

    if (stage2Enabled !== undefined) {
      const raw = stage2Enabled;
      const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
      this.db.setSetting('aiStage2Enabled', enabled ? '1' : '0');
    }

    if (deepReasoningEnabled !== undefined) {
      const on = deepReasoningEnabled === true || deepReasoningEnabled === '1' || deepReasoningEnabled === 'true';
      this.db.setSetting('deepReasoningEnabled', on ? '1' : '0');
    }
    if (typeof stage2ReasoningModel === 'string') {
      this.db.setSetting('stage2ReasoningModel', stage2ReasoningModel.trim());
    }
    if (escalationReserve !== undefined && escalationReserve !== '') {
      this.db.setSetting('escalationReserve', String(parseInt(escalationReserve, 10) || 2));
    }
  }

  async _fetchProviderModels(provider) {
    const p = String(provider || '').toLowerCase();
    if (!['xai', 'openai', 'gemini'].includes(p)) throw new Error('Invalid provider');

    // Curated model sets for cleaner admin UX
    const curated = {
      xai: [
        'grok-4-1-fast-reasoning',
        'grok-4-1-fast-non-reasoning',
        'grok-4-fast-non-reasoning',
        'grok-4.20-0309-reasoning',
        'grok-4.20-0309-non-reasoning',
        'grok-3-mini',
      ],
      openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o', 'gpt-5-mini', 'gpt-5'],
      // Gemini list is hardcoded — Google's OpenAI-compat /v1beta/openai/models
      // endpoint exposes hundreds of internal-only IDs that confuse the UI.
      // These are the four variants we actually want to expose for Stage 1.
      gemini: [
        'gemini-3.1-flash-lite',
        'gemini-3.1-flash-lite-preview',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
      ],
    };

    // Gemini: skip the live /models GET — return the curated list directly so
    // the UI gets the expected entries even if Google rotates internal IDs.
    if (p === 'gemini') {
      const apiKey = process.env.GOOGLE_AI_API_KEY;
      if (!apiKey) return { provider: p, models: curated.gemini, error: 'GOOGLE_AI_API_KEY is not configured' };
      return { provider: p, models: curated.gemini };
    }

    const apiKey = p === 'openai' ? process.env.OPENAI_API_KEY : process.env.XAI_API_KEY;
    const baseUrl = p === 'openai'
      ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
      : (process.env.XAI_BASE_URL || 'https://api.x.ai/v1');

    if (!apiKey) return { provider: p, models: curated[p], error: 'API key is not configured' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text();
        // For xAI quota/rate issues, keep UI usable with curated fallback list.
        if (p === 'xai' && (res.status === 429 || res.status === 402)) {
          return { provider: p, models: curated[p] };
        }
        return { provider: p, models: curated[p], error: `HTTP ${res.status}: ${txt.slice(0, 120)}` };
      }

      const payload = await res.json();
      const available = Array.isArray(payload?.data)
        ? payload.data.map(m => m.id).filter(Boolean).sort((a, b) => a.localeCompare(b))
        : [];

      // xAI: keep only Grok models, but not the whole list
      const providerTop = p === 'xai'
        ? available.filter(m => m.startsWith('grok-') && m !== 'grok-4-1').slice(0, 12)
        : curated[p].filter(m => available.includes(m));

      let models;
      if (p === 'xai') {
        const merged = [...providerTop, ...curated[p]];
        models = [...new Set(merged)];
      } else {
        models = providerTop.length > 0 ? providerTop : curated[p];
      }
      return { provider: p, models };
    } catch (e) {
      if (p === 'xai') {
        return { provider: p, models: curated[p] };
      }
      return { provider: p, models: curated[p], error: e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Set user plan (admin panel grant/revoke).
   * ADM-005 + BILL-002 (Bundle #2): wrapped in db.transaction() so the
   * UPDATE either fully succeeds (with audit row) or fully rolls back.
   *
   * @param {number} userId
   * @param {string} planName
   * @param {number} [days=30]
   * @param {Object} [opts]
   * @param {string} [opts.source='admin_panel'] - audit log source
   */
  _setUserPlan(userId, planName, days = 30, opts = {}) {
    const plan = this.db.db.prepare(`SELECT id, name FROM plans WHERE name = ?`).get(planName);
    if (!plan) throw new Error(`Plan not found: ${planName}`);

    if (plan.name === 'free' || plan.name === 'admin') {
      // Free and Admin plans have no expiry. Atomic UPDATE + audit log.
      const tx = this.db.db.transaction(() => {
        const prev = this.db.db.prepare(`SELECT plan_id FROM users WHERE id = ?`).get(userId);
        this.db.db.prepare(`
          UPDATE users
          SET plan_id = ?, subscription_expires_at = NULL, status = 'active'
          WHERE id = ?
        `).run(plan.id, userId);
        this.db.recordAuditEvent(
          plan.name === 'admin' ? 'plan_grant_admin' : 'plan_revoke',
          null,                  // single-tenant admin panel: no per-admin id
          'admin',
          userId,
          {
            from_plan_id: prev?.plan_id ?? null,
            to_plan_id:   plan.id,
            to_plan_name: plan.name,
            source:       opts.source || 'admin_panel',
          },
          true,
        );
      });
      tx();
      return;
    }

    // Paid plans — upgradePlan already wraps в transaction + audit (see database.js Task 3).
    this.db.upgradePlan(userId, plan.name, days, { source: opts.source || 'admin_panel' });
  }

  async _broadcast(message, planFilter) {
    let q = `
      SELECT u.id, u.telegram_chat_id, u.pinned_broadcast_message_id
      FROM users u
      JOIN plans p ON u.plan_id=p.id
      WHERE u.status='active'
    `;
    const params = [];
    if (planFilter && planFilter !== 'all') { q += ` AND p.name=?`; params.push(planFilter); }
    const users = this.db.db.prepare(q).all(...params);
    const broadcastId = this.db.createBroadcast(message, planFilter || 'all');
    let sent = 0, failed = 0;
    for (const u of users) {
      try {
        const sentMsg = await withTelegramRetry(
          () => this.bot.sendMessage(u.telegram_chat_id, message, { parse_mode: 'HTML' }),
          { logger: this.logger, label: 'broadcast' }
        );

        if (u.pinned_broadcast_message_id) {
          try {
            await this.bot.unpinChatMessage(u.telegram_chat_id, {
              message_id: u.pinned_broadcast_message_id,
            });
          } catch {
            // Old pin may already be gone or unpinnable — ignore
          }
        }

        try {
          await this.bot.pinChatMessage(u.telegram_chat_id, sentMsg.message_id, {
            disable_notification: true,
          });
          this.db.db.prepare(`
            UPDATE users
            SET pinned_broadcast_message_id = ?
            WHERE id = ?
          `).run(sentMsg.message_id, u.id);
        } catch {
          // If pin fails (no rights / private settings), keep broadcast sent
        }

        try {
          this.db.addBroadcastDelivery(broadcastId, u.id, u.telegram_chat_id, sentMsg.message_id, 'sent');
        } catch (e) {
          this.logger.warn(`Failed to record broadcast delivery: ${e.message}`);
        }

        sent++;
        await new Promise(r => setTimeout(r, 50)); // rate limit
      } catch (err) {
        if (err?.response?.statusCode === 403) {
          this.logger.warn(`Broadcast: user ${u.id} blocked the bot - suspending`);
          try {
            this.db.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('suspended', u.id);
          } catch (e) {
            this.logger.warn(`Broadcast: failed to mark user ${u.id} as suspended: ${e.message}`);
          }
        }
        failed++;
      }
    }
    this.db.finalizeBroadcast(broadcastId, sent, failed);
    return { sent, failed, total: users.length, broadcastId };
  }

  async _manageBroadcastById(broadcastId, action, message = '') {
    const bc = this.db.getBroadcastById(broadcastId);
    if (!bc) throw new Error('Broadcast not found');

    const deliveries = this.db.getBroadcastDeliveries(broadcastId);
    let success = 0;
    let failed = 0;

    for (const d of deliveries) {
      try {
        if (action === 'edit') {
          await this.bot.editMessageText(message, {
            chat_id: d.chat_id,
            message_id: d.message_id,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
          this.db.updateBroadcastDeliveryStatus(broadcastId, d.user_id, 'edited');
        } else if (action === 'unpin') {
          await this.bot.unpinChatMessage(d.chat_id, { message_id: d.message_id });
          this.db.updateBroadcastDeliveryStatus(broadcastId, d.user_id, 'unpinned');
        } else if (action === 'delete') {
          await this.bot.deleteMessage(d.chat_id, d.message_id);
          this.db.updateBroadcastDeliveryStatus(broadcastId, d.user_id, 'deleted');
        }

        if (action === 'delete') {
          this.db.db.prepare(`
            UPDATE users
            SET pinned_broadcast_message_id = NULL
            WHERE id = ? AND pinned_broadcast_message_id = ?
          `).run(d.user_id, d.message_id);
        }

        success++;
      } catch {
        if (action === 'delete') {
          this.db.db.prepare(`
            UPDATE users
            SET pinned_broadcast_message_id = NULL
            WHERE id = ? AND pinned_broadcast_message_id = ?
          `).run(d.user_id, d.message_id);
        }
        failed++;
      }

      await new Promise(r => setTimeout(r, 50));
    }

    if (action === 'edit') {
      this.db.updateBroadcastMessage(broadcastId, message);
    }

    return { ok: true, action, success, failed, total: deliveries.length, broadcastId };
  }

  async _manageBroadcastMessages(action, message = '', planFilter = 'all') {
    let q = `
      SELECT u.id, u.telegram_chat_id, u.pinned_broadcast_message_id
      FROM users u
      JOIN plans p ON u.plan_id=p.id
      WHERE u.pinned_broadcast_message_id IS NOT NULL
    `;
    const params = [];
    if (planFilter && planFilter !== 'all') { q += ` AND p.name=?`; params.push(planFilter); }
    const users = this.db.db.prepare(q).all(...params);

    let success = 0;
    let failed = 0;

    for (const u of users) {
      const msgId = u.pinned_broadcast_message_id;
      try {
        if (action === 'edit') {
          await this.bot.editMessageText(message, {
            chat_id: u.telegram_chat_id,
            message_id: msgId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
        } else if (action === 'unpin') {
          await this.bot.unpinChatMessage(u.telegram_chat_id, { message_id: msgId });
        } else if (action === 'delete') {
          await this.bot.deleteMessage(u.telegram_chat_id, msgId);
          this.db.db.prepare(`
            UPDATE users SET pinned_broadcast_message_id = NULL WHERE id = ?
          `).run(u.id);
        }

        success++;
      } catch {
        if (action === 'delete') {
          // Message may already be missing; clear stale pointer anyway
          this.db.db.prepare(`
            UPDATE users SET pinned_broadcast_message_id = NULL WHERE id = ?
          `).run(u.id);
        }
        failed++;
      }

      await new Promise(r => setTimeout(r, 50));
    }

    return { ok: true, action, success, failed, total: users.length };
  }

  // ── Request Router ──────────────────────────────────────────────────────────
  async _handle(req, res) {
    const url = new URL('http://x' + req.url);
    const path = url.pathname;
    const method = req.method;

    // Stash per-request headers (security + optional CORS) and monkey-patch
    // writeHead so every response inherits them. Same pattern as dashboard.
    res._defaultHeaders = buildHeaders(req);
    const _origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headersOrReason, maybeHeaders) => {
      let statusMsg, hdrs;
      if (typeof headersOrReason === 'string') { statusMsg = headersOrReason; hdrs = maybeHeaders || {}; }
      else { hdrs = headersOrReason || {}; }
      const merged = { ...res._defaultHeaders, ...hdrs };
      return statusMsg ? _origWriteHead(status, statusMsg, merged) : _origWriteHead(status, merged);
    };

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE',
        'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    // Health check — no auth
    if (path === '/api/health') return json(res, 200, { ok: true, service: 'admin', port: this.port });

    // Serve SPA for all non-API routes
    if (!path.startsWith('/api/')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Admin SPA must not be cached - operator restarts after a config
        // change need to see the new UI immediately, no stale redirects.
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      return res.end(this._spa());
    }

    // Auth check for all API routes
    if (!this._auth(req)) return json(res, 401, { error: 'Unauthorized' });

    try {
      // ── Users ──
      if (path === '/api/users' && method === 'GET') {
        const s = url.searchParams;
        return json(res, 200, this._getAllUsers(s.get('search') || '', s.get('plan') || '', s.get('status') || ''));
      }

      if (path.match(/^\/api\/users\/(\d+)\/subscription\/grant$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        const { plan = 'pro', days = 30 } = await parseBody(req);
        const safeDays = Math.max(1, Math.min(3650, parseInt(days, 10) || 30));
        this._setUserPlan(id, String(plan).toLowerCase(), safeDays);
        return json(res, 200, { ok: true });
      }

      if (path.match(/^\/api\/users\/(\d+)\/subscription\/revoke$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        this._setUserPlan(id, 'free', 0);
        return json(res, 200, { ok: true });
      }

      if (path.match(/^\/api\/users\/(\d+)\/status$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        const { status = 'active' } = await parseBody(req);
        const allowed = ['active', 'paused', 'blocked', 'suspended'];
        if (!allowed.includes(status)) return json(res, 400, { error: 'Invalid status' });
        this.db.updateUser(id, 'status', status);
        return json(res, 200, { ok: true });
      }

      // ── Payments ──
      if (path === '/api/payments' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        return json(res, 200, this._getPayments(limit, offset));
      }

      if (path.match(/^\/api\/payments\/(\d+)$/) && method === 'DELETE') {
        const id = parseInt(path.split('/')[3]);
        this.db.db.prepare('DELETE FROM payments WHERE id = ?').run(id);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/payments/cleanup' && method === 'POST') {
        this.db.db.prepare(`
          DELETE FROM payments
          WHERE status IN ('pending', 'expired')
            AND COALESCE(datetime(expires_at), expires_at) < datetime('now')
        `).run();
        return json(res, 200, { ok: true });
      }

      if (path === '/api/alerts/cleanup' && method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const days = Math.max(1, Math.min(365, Number(body.days || 30)));
        const result = this.db.cleanupAlerts(days);
        return json(res, 200, { ok: true, ...result });
      }

      if (path === '/api/admin/maintenance/vacuum' && method === 'POST') {
        const t0 = Date.now();
        try {
          this.db.db.exec('VACUUM');
          return json(res, 200, { ok: true, elapsedMs: Date.now() - t0 });
        } catch (e) {
          this.logger.error(`[Maintenance] VACUUM failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      if (path === '/api/admin/maintenance/cleanup-video' && method === 'POST') {
        try {
          if (this.telegram?.cleanupVideoCache) {
            this.telegram.cleanupVideoCache(3);
          }
          return json(res, 200, { ok: true });
        } catch (e) {
          this.logger.error(`[Maintenance] cleanup-video failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      if (path === '/api/admin/maintenance/cleanup-auth' && method === 'POST') {
        try {
          const removed = this.db.pruneAuthSessions(24);
          return json(res, 200, { ok: true, removed });
        } catch (e) {
          this.logger.error(`[Maintenance] cleanup-auth failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      if (path === '/api/admin/maintenance/rotate-logs' && method === 'POST') {
        try {
          const removed = this.logger.cleanupOldLogs(14);
          return json(res, 200, { ok: true, removed });
        } catch (e) {
          this.logger.error(`[Maintenance] rotate-logs failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      // ── Stats ──
      if (path === '/api/stats' && method === 'GET') {
        return json(res, 200, this._getStats());
      }

      // ── Plans ──
      if (path === '/api/plans' && method === 'GET') {
        return json(res, 200, this._getPlans());
      }

      if (path.match(/^\/api\/plans\/(\d+)$/) && method === 'PUT') {
        const id = parseInt(path.split('/')[3]);
        const body = await parseBody(req);
        this._updatePlan(id, body);
        return json(res, 200, { ok: true });
      }

      // ── Feedback Config ──
      if (path === '/api/feedback-config' && method === 'GET') {
        return json(res, 200, this._getFeedbackConfig());
      }

      if (path === '/api/feedback-config' && method === 'POST') {
        const body = await parseBody(req);
        this._setFeedbackConfig(body);
        return json(res, 200, { ok: true, ...this._getFeedbackConfig() });
      }

      // ── Stage 1 calibration examples (admin-curated few-shot for SYSTEM_PROMPT) ──
      // Reads/writes go straight to db.{list|create|update|delete}Stage1Example.
      // Validation happens here at the boundary — strict caps + enum checks so
      // a bad request gets a 400 before it touches the row writer.
      if (path === '/api/stage1-examples' && method === 'GET') {
        const filterKind = url.searchParams.get('kind');
        const items = this.db.listStage1Examples({
          kind: (filterKind === 'example' || filterKind === 'mistake') ? filterKind : null,
        });
        return json(res, 200, {
          items,
          count: items.length,
          enabledCount: items.filter(i => i.enabled).length,
        });
      }

      if (path === '/api/stage1-examples' && method === 'POST') {
        const body = await parseBody(req);
        const err = this._validateStage1Example(body, { partial: false });
        if (err) return json(res, 400, { error: err });
        // Soft cap warning vs hard cap rejection. 50 is a sanity ceiling —
        // the cacheable prefix shouldn't grow unbounded as operators add more.
        if (this.db.countStage1Examples() >= 50) {
          return json(res, 400, { error: 'Too many examples (max 50). Disable or delete some first.' });
        }
        const id = this.db.createStage1Example(body);
        return json(res, 201, { id, ok: true });
      }

      const updMatch = path.match(/^\/api\/stage1-examples\/(\d+)$/);
      if (updMatch && method === 'PUT') {
        const body = await parseBody(req);
        // Partial update — only validate fields actually present in patch
        const err = this._validateStage1Example(body, { partial: true });
        if (err) return json(res, 400, { error: err });
        const ok = this.db.updateStage1Example(parseInt(updMatch[1], 10), body);
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Not found' });
      }

      if (updMatch && method === 'DELETE') {
        const ok = this.db.deleteStage1Example(parseInt(updMatch[1], 10));
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Not found' });
      }

      // ── Recent feedback reasons (for the admin "voice of the user" panel) ──
      // Lightweight read — last N votes that actually carry a written reason.
      // Renders as a table under the feedback-weights section so the operator
      // can see WHY users react the way they do, not just the aggregate score.
      if (path === '/api/feedback-recent' && method === 'GET') {
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10)));
        const items = this.db.getRecentFeedbackReasons(limit) || [];
        return json(res, 200, { items });
      }

      // ── AI Config ──
      if (path === '/api/ai-config' && method === 'GET') {
        return json(res, 200, this._getAiConfig());
      }

      if (path === '/api/ai-config' && method === 'POST') {
        const body = await parseBody(req);
        this._setAiConfig(body);
        return json(res, 200, { ok: true, ...this._getAiConfig() });
      }

      // ── Force scan trigger ──
      if (path === '/api/scan' && method === 'POST') {
        if (this.appState?.paused) {
          return json(res, 409, { error: 'Scanner is paused. Resume it first.' });
        }
        if (this.appState?.scanRunning) {
          return json(res, 409, { error: 'Scan is already running. Try again in a moment.' });
        }
        if (typeof this.scanFn !== 'function') {
          return json(res, 503, { error: 'Scan function not available' });
        }
        this.logger.info('[Admin] Manual scan triggered');
        this.scanFn().catch(e => this.logger.error(`Manual scan error: ${e.message}`));
        return json(res, 202, { message: 'Scan triggered — check logs for progress' });
      }

      // ── Scanner Config (preset + alert thresholds + storage floor) ──
      if (path === '/api/scanner-config' && method === 'GET') {
        return json(res, 200, this._getScannerConfig());
      }
      if (path === '/api/scanner-config' && method === 'POST') {
        try {
          const body = await parseBody(req);
          this._setScannerConfig(body);
          return json(res, 200, { ok: true, ...this._getScannerConfig() });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      // ── Preset configs — full per-preset pipeline tuning (PR-1) ──
      // Operator-only by virtue of admin-server's X-Admin-Key gate.
      if (path === '/api/preset-configs' && method === 'GET') {
        return json(res, 200, this._getPresetConfigs());
      }
      if (path === '/api/preset-configs' && method === 'POST') {
        try {
          const body = await parseBody(req);
          this._setPresetConfigs(body);
          return json(res, 200, { ok: true, ...this._getPresetConfigs() });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      // Restore hardcoded DEFAULT_PRESET_CONFIGS.sources into manual layer for
      // ALL presets. Escape hatch when Auto-tags produces garbage or the
      // operator wants to lock in the legacy known-good baseline. See
      // `_restoreHardcodedPresetSources` for semantics. Does not touch
      // auto-overrides or locks — only manual layer's sources sub-tree.
      if (path === '/api/preset-configs/restore-hardcoded' && method === 'POST') {
        try {
          this._restoreHardcodedPresetSources();
          return json(res, 200, { ok: true, ...this._getPresetConfigs() });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }

      // ── Tag auto-refresh — Grok-driven sources (subreddits + twitter keywords) ──
      // Phase 1: status / toggle / force-stub / circuit-breaker reset / history.
      // Phase 2 will wire the actual xAI Responses API call inside tagRefresher.
      if (path === '/api/tag-refresh/status' && method === 'GET') {
        if (!this.tagRefresher) return json(res, 503, { error: 'tag refresher not wired' });
        const status = this.tagRefresher.getStatus();
        const history = this.db.getTagRefreshHistory(50);
        return json(res, 200, { ...status, history });
      }
      if (path === '/api/tag-refresh/toggle' && method === 'POST') {
        if (!this.tagRefresher) return json(res, 503, { error: 'tag refresher not wired' });
        try {
          const body = await parseBody(req);
          const enabled = !!body?.enabled;
          this.tagRefresher.setEnabled(enabled);
          return json(res, 200, { ok: true, enabled });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (path === '/api/tag-refresh/force' && method === 'POST') {
        if (!this.tagRefresher) return json(res, 503, { error: 'tag refresher not wired' });
        try {
          const result = await this.tagRefresher.refreshAll({ force: true });
          if (!result.ok) return json(res, 429, result);
          return json(res, 200, result);
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }
      if (path === '/api/tag-refresh/reset-breaker' && method === 'POST') {
        if (!this.tagRefresher) return json(res, 503, { error: 'tag refresher not wired' });
        this.tagRefresher.resetCircuitBreaker();
        return json(res, 200, { ok: true });
      }

      // ── TikTok hashtag source toggle (apify | grok) ─────────────────────
      // GET returns the current source string. POST { source: 'apify'|'grok' }
      // updates the DB setting that tiktok.js _getHashtags() reads on every
      // collect cycle — switch is effectively immediate (next cycle picks it
      // up). When switching to 'grok', we DON'T pre-warm any list; the
      // collector falls back to presetConfigs / hardcoded defaults until
      // tag-refresher.js next runs (manually via "Force refresh" or weekly).
      if (path === '/api/tiktok-hashtag-source' && method === 'GET') {
        const source = (this.db.getSetting('tiktokHashtagSource', 'apify') || 'apify').toLowerCase();
        return json(res, 200, { source });
      }
      if (path === '/api/tiktok-hashtag-source' && method === 'POST') {
        try {
          const body = await parseBody(req);
          const next = String(body?.source || '').toLowerCase();
          if (next !== 'apify' && next !== 'grok') {
            return json(res, 400, { error: 'source must be "apify" or "grok"' });
          }
          this.db.setSetting('tiktokHashtagSource', next);
          this.logger?.info?.(`[Admin] tiktokHashtagSource → ${next}`);
          return json(res, 200, { ok: true, source: next });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      // ── Junk-reason stats over last N hours (for observation panel) ──
      if (path === '/api/junk-stats' && method === 'GET') {
        const hours = parseInt(url.searchParams.get('hours') || '24', 10) || 24;
        try {
          return json(res, 200, this._getJunkStats(hours));
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }

      // Alert decisions — per-trend verdicts from the last N cycles. In-memory
      // ring buffer on appState.alertDecisions, populated by index.js on every
      // alert-gate evaluation. Useful to answer "почему нет алертов".
      if (path === '/api/alert-decisions' && method === 'GET') {
        const limit  = Math.min(500, parseInt(url.searchParams.get('limit')  || '200', 10));
        const filter = (url.searchParams.get('filter') || 'all').toLowerCase(); // all | sent | skipped
        const reason = (url.searchParams.get('reason') || '').trim();
        const all = Array.isArray(this.appState?.alertDecisions) ? this.appState.alertDecisions : [];
        let items = all.slice().reverse(); // newest first
        if (filter === 'sent')    items = items.filter(d => d.decision === 'sent');
        if (filter === 'skipped') items = items.filter(d => d.decision === 'skipped');
        if (reason) items = items.filter(d => d.reason === reason);
        items = items.slice(0, limit);

        // Aggregate reason counts for a header summary
        const counts = {};
        for (const d of all) counts[d.reason] = (counts[d.reason] || 0) + 1;

        return json(res, 200, { total: all.length, counts, items });
      }

      if (path === '/api/ai-models' && method === 'GET') {
        const provider = (url.searchParams.get('provider') || '').toLowerCase();
        if (provider) {
          return json(res, 200, await this._fetchProviderModels(provider));
        }
        const [xai, openai, gemini] = await Promise.all([
          this._fetchProviderModels('xai'),
          this._fetchProviderModels('openai'),
          this._fetchProviderModels('gemini'),
        ]);
        return json(res, 200, { xai, openai, gemini });
      }

      // ── Broadcast ──
      if (path === '/api/broadcast' && method === 'POST') {
        const { message, plan = 'all' } = await parseBody(req);
        if (!message) return json(res, 400, { error: 'message required' });
        const result = await this._broadcast(message, plan);
        this.logger.info('Admin broadcast sent', result);
        return json(res, 200, result);
      }

      if (path === '/api/broadcasts' && method === 'GET') {
        const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '30')));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0'));
        return json(res, 200, this.db.getBroadcastHistory(limit, offset));
      }

      if (path.match(/^\/api\/broadcasts\/(\d+)\/manage$/) && method === 'POST') {
        const broadcastId = parseInt(path.split('/')[3]);
        const { action, message = '' } = await parseBody(req);
        if (!['edit', 'unpin', 'delete'].includes(action)) {
          return json(res, 400, { error: 'invalid action' });
        }
        if (action === 'edit' && !message.trim()) {
          return json(res, 400, { error: 'message required for edit' });
        }
        const result = await this._manageBroadcastById(broadcastId, action, message);
        this.logger.info('Admin broadcast history manage action', result);
        return json(res, 200, result);
      }

      if (path === '/api/broadcast/manage' && method === 'POST') {
        const { action, message = '', plan = 'all' } = await parseBody(req);
        if (!['edit', 'unpin', 'delete'].includes(action)) {
          return json(res, 400, { error: 'invalid action' });
        }
        if (action === 'edit' && !message.trim()) {
          return json(res, 400, { error: 'message required for edit' });
        }

        const result = await this._manageBroadcastMessages(action, message, plan);
        this.logger.info('Admin broadcast manage action', result);
        return json(res, 200, result);
      }

      // ── Manual submit: analyse an arbitrary URL on demand ──────────────────
      // POST /api/submit-narrative { url, sendToTelegram? }
      // Resolves the URL → synthetic trend → runs scorer → saves to DB with
      // raw_metrics.manualSubmitted=true. If sendToTelegram is set, pushes the
      // alert to every active user (bypasses threshold/dedup gates — the whole
      // point of a manual submit is to force distribution).
      if (path === '/api/submit-narrative' && method === 'POST') {
        if (!this.scorer || !this.telegram) {
          return json(res, 503, { error: 'Scorer/Telegram not wired into admin server' });
        }
        let body;
        try { body = await parseBody(req); }
        catch (e) { return json(res, 400, { error: e.message }); }
        const rawUrl = String(body?.url || '').trim();
        const sendToTelegram = !!body?.sendToTelegram;
        const rawComment = typeof body?.comment === 'string' ? body.comment.trim() : '';
        const comment = rawComment.length > 500 ? rawComment.slice(0, 500) : rawComment;
        if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
          return json(res, 400, { error: 'Valid URL is required' });
        }
        try {
          const result = await this._submitNarrative(rawUrl, sendToTelegram, { comment });
          return json(res, 200, result);
        } catch (e) {
          this.logger.error(`[ManualSubmit] failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      // ── Manual send-alert: broadcast an alert for an ALREADY saved trend ──
      // POST /api/send-alert { trendId }
      // Used by the "📨 Отправить алерт" button on SubmitPage — works on any
      // trend_id in the DB, not just manual submits. Rehydrates the trend row
      // from raw_metrics and fans out to every active user.
      if (path === '/api/send-alert' && method === 'POST') {
        if (!this.telegram) {
          return json(res, 503, { error: 'Telegram not wired into admin server' });
        }
        let body;
        try { body = await parseBody(req); }
        catch (e) { return json(res, 400, { error: e.message }); }
        const trendId = parseInt(body?.trendId, 10);
        if (!Number.isFinite(trendId) || trendId <= 0) {
          return json(res, 400, { error: 'trendId is required' });
        }
        // Optional admin comment — prepended to the TG alert body. Cap at
        // 500 chars so the caption still fits Telegram's 1024 limit after
        // concat with the formatter output.
        const rawComment = typeof body?.comment === 'string' ? body.comment.trim() : '';
        const comment = rawComment.length > 500 ? rawComment.slice(0, 500) : rawComment;
        try {
          const row = this.db.getTrendById?.(trendId);
          if (!row) return json(res, 404, { error: 'Trend not found' });
          const trend = this._hydrateTrendFromDb(row);
          const started = Date.now();
          this.logger.info(`[SendAlert] broadcasting trend #${trendId}${comment ? ' (with comment)' : ''}`);
          const alerts = await this._broadcastTrendAlert(trend, trendId, { comment });
          const elapsedMs = Date.now() - started;
          const ok = alerts.filter(a => a.ok).length;
          this.logger.info(`[SendAlert] done in ${elapsedMs}ms — ${ok}/${alerts.length} delivered`);
          return json(res, 200, { ok: true, elapsedMs, alerts, trendId });
        } catch (e) {
          this.logger.error(`[SendAlert] failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      // ── Manual-submit history: list of trends flagged manualSubmitted ─────
      // Backs the SubmitPage history list. Returns the same shape as
      // _submitNarrative.trend (built via _shapeManualTrend) plus a
      // re-derived pipeline trace so the UI renders identically whether
      // the row was just analysed or loaded from history.
      if (path === '/api/manual-trends' && method === 'GET') {
        const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
        const limit = Number.isFinite(limitParam) ? limitParam : 50;
        try {
          const rows = this.db.getManualTrends?.(limit) || [];
          const items = rows.map(row => {
            const hydrated = this._hydrateTrendFromDb(row);
            return {
              trend: this._shapeManualTrend(hydrated, row.id),
              pipeline: this._derivePipelineTrace(hydrated),
              submittedAt: hydrated.manualSubmittedAt || row.first_seen_at || null,
            };
          });
          return json(res, 200, { ok: true, total: items.length, items });
        } catch (e) {
          this.logger.error(`[ManualTrends] list failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      // DELETE /api/manual-trends/:id — strip manualSubmitted marker so the
      // row drops out of the SubmitPage history. The trend itself stays
      // (it's a valid alert target / has feedback / etc).
      const manualDelMatch = path.match(/^\/api\/manual-trends\/(\d+)$/);
      if (manualDelMatch && method === 'DELETE') {
        const trendId = parseInt(manualDelMatch[1], 10);
        if (!Number.isFinite(trendId) || trendId <= 0) {
          return json(res, 400, { error: 'invalid trend id' });
        }
        try {
          const ok = this.db.unsetManualSubmitted?.(trendId) === true;
          return json(res, 200, { ok, trendId });
        } catch (e) {
          this.logger.error(`[ManualTrends] delete failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      // ── On-demand Grok trigger search for SubmitPage ──────────────────
      // POST /api/trends/:id/trigger
      // Mirrors dashboard's endpoint but stripped of plan/cooldown checks
      // (admin is fully privileged). If a trigger was previously saved for
      // this trend the cached payload is returned — operator can re-run
      // the scan-cycle if they want a fresh search.
      const triggerMatch = path.match(/^\/api\/trends\/(\d+)\/trigger$/);
      if (triggerMatch && method === 'POST') {
        if (!this.triggerFinder || !this.triggerFinder.enabled) {
          return json(res, 503, { error: 'Trigger search disabled (XAI_API_KEY missing)' });
        }
        const trendId = parseInt(triggerMatch[1], 10);
        const row = this.db.getTrendById?.(trendId);
        if (!row) return json(res, 404, { error: 'Trend not found' });

        // Return cached if present
        const cached = this.db.getTrendTrigger?.(trendId);
        if (cached && cached.text) {
          return json(res, 200, { ...cached, fromCache: true });
        }

        try {
          const trend = this._hydrateTrendFromDb(row);
          const started = Date.now();
          this.logger.info(`[AdminTrigger] searching trigger for trend #${trendId} (${trend.title?.slice(0, 60)})`);
          const result = await this.triggerFinder.findTrigger(trend);
          const elapsedMs = Date.now() - started;
          this.logger.info(`[AdminTrigger] done in ${elapsedMs}ms — confidence=${result.confidence}, sources=${(result.sources || []).length}`);
          // Persist so subsequent loads see it
          try { this.db.saveTrendTrigger?.(trendId, result); } catch (e) {
            this.logger.warn(`[AdminTrigger] saveTrendTrigger failed: ${e.message}`);
          }
          return json(res, 200, { ...result, fromCache: false, elapsedMs });
        } catch (e) {
          this.logger.error(`[AdminTrigger] failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      // ── Pipeline flow (live stage + counters for the flow diagram) ──
      if (path === '/api/pipeline' && method === 'GET') {
        return json(res, 200, {
          paused:         !!this.appState?.paused,
          running:        !!this.appState?.scanRunning,
          currentStage:   this.appState?.currentStage   || 'idle',
          stageStartedAt: this.appState?.stageStartedAt || null,
          cycleStartedAt: this.appState?.cycleStartedAt || null,
          cycleInProgress: this.appState?.cycleInProgress || null,
          lastCycle:       this.appState?.lastCycle       || null,
        });
      }

      // ── Scanners ──
      if (path === '/api/scanners' && method === 'GET') {
        const disabled = [...this.appState.disabledCollectors];
        return json(res, 200, {
          paused: this.appState.paused,
          collectors: [
            { name: 'reddit',       label: 'Reddit',        icon: '🟠', enabled: !disabled.includes('reddit') },
            { name: 'google_trends', label: 'Google Trends', icon: '🔍', enabled: !disabled.includes('google_trends') },
            { name: 'twitter',      label: 'Twitter / X',   icon: '🐦', enabled: !disabled.includes('twitter') },
            { name: 'tiktok',       label: 'TikTok',        icon: '🎵', enabled: !disabled.includes('tiktok') },
          ]
        });
      }

      if (path === '/api/scanners/pause' && method === 'POST') {
        this.appState.paused = true;
        // Bundle #7 — ADM-018 + SD-16: persist so pause survives deploy/restart.
        try { this.db.setSetting('scanner_paused', '1'); }
        catch (e) { this.logger.warn(`[Admin] Failed to persist pause: ${e.message}`); }
        this.logger.info('[Admin] Scanner paused');
        return json(res, 200, { paused: true });
      }

      if (path === '/api/scanners/resume' && method === 'POST') {
        this.appState.paused = false;
        // Bundle #7 — ADM-018 + SD-16: persist so resume survives deploy/restart.
        try { this.db.setSetting('scanner_paused', '0'); }
        catch (e) { this.logger.warn(`[Admin] Failed to persist resume: ${e.message}`); }
        this.logger.info('[Admin] Scanner resumed');
        return json(res, 200, { paused: false });
      }

      if (path.match(/^\/api\/scanners\/[\w]+\/toggle$/) && method === 'POST') {
        let name = path.split('/')[3].toLowerCase();
        if (name === 'googletrends') name = 'google_trends';
        const dc = this.appState.disabledCollectors;
        if (dc.has(name)) { dc.delete(name); this.logger.info(`[Admin] Collector enabled: ${name}`); }
        else              { dc.add(name);    this.logger.info(`[Admin] Collector disabled: ${name}`); }
        try {
          this.db.setSetting('disabledCollectors', JSON.stringify([...dc]));
        } catch (e) {
          this.logger.error(`[Admin] Failed to persist disabledCollectors: ${e.message}`);
        }
        return json(res, 200, { name, enabled: !dc.has(name) });
      }

      // ── PreStage / nano admin toggle ──────────────────────────────────────
      // Soft kill switch for the gpt-5.4-nano text-enrichment sub-stage.
      // Flips a DB setting that NanoClassifier consults at the start of
      // each batch — applies on the very next cycle, no restart needed.
      // Use this to A/B whether nano enrichment actually moves the needle
      // for our scoring + clustering quality.
      if (path === '/api/prestage/nano' && method === 'GET') {
        // Default '0' (disabled) since 2026-05-09 — nano is now opt-in.
        const v = this.db.getSetting?.('nanoEnabled', '0');
        return json(res, 200, { enabled: String(v) === '1' });
      }
      if (path === '/api/prestage/nano/toggle' && method === 'POST') {
        const cur = this.db.getSetting?.('nanoEnabled', '0');
        const next = String(cur) === '1' ? '0' : '1';
        try {
          this.db.setSetting('nanoEnabled', next);
        } catch (e) {
          this.logger.error(`[Admin] Failed to persist nanoEnabled: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
        const enabled = next !== '0';
        this.logger.info(`[Admin] PreStage nano ${enabled ? 'ENABLED' : 'DISABLED'}`);
        return json(res, 200, { enabled });
      }

      // ── Alert Scheduler (per-user FIFO cooldown) ──────────────────────────
      // GET returns current settings (live from DB, refreshed by scheduler
      // on each tick) + a stats snapshot from the in-memory scheduler.
      // POST accepts any subset of {enabled, cooldownMs, cap, maxAgeMs} and
      // persists into DB. Scheduler reads them on the next tick — no restart.
      if (path === '/api/alert-scheduler' && method === 'GET') {
        const cfg = {
          enabled:     String(this.db.getSetting?.('tgAlertCooldownEnabled', '1')) !== '0',
          cooldownMs:  parseInt(this.db.getSetting?.('tgAlertCooldownMs', '60000'), 10) || 60000,
          cap:         parseInt(this.db.getSetting?.('tgAlertQueueCap', '20'), 10) || 20,
          maxAgeMs:    parseInt(this.db.getSetting?.('tgAlertQueueMaxAgeMs', '1800000'), 10) || 1800000,
        };
        const stats = this.alertScheduler?.getStats?.() || null;
        return json(res, 200, { cfg, stats });
      }
      if (path === '/api/alert-scheduler' && method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        try {
          if (body.enabled !== undefined) {
            const v = (body.enabled === true || body.enabled === 1 || body.enabled === '1' || body.enabled === 'true') ? '1' : '0';
            this.db.setSetting('tgAlertCooldownEnabled', v);
          }
          if (body.cooldownMs !== undefined) {
            const n = Math.max(0, Math.min(600_000, parseInt(body.cooldownMs, 10) || 0));
            this.db.setSetting('tgAlertCooldownMs', String(n));
          }
          if (body.cap !== undefined) {
            const n = Math.max(1, Math.min(500, parseInt(body.cap, 10) || 1));
            this.db.setSetting('tgAlertQueueCap', String(n));
          }
          if (body.maxAgeMs !== undefined) {
            const n = Math.max(60_000, Math.min(24 * 60 * 60_000, parseInt(body.maxAgeMs, 10) || 60_000));
            this.db.setSetting('tgAlertQueueMaxAgeMs', String(n));
          }
        } catch (e) {
          this.logger.error(`[Admin] Failed to persist alert-scheduler settings: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
        const cfg = {
          enabled:     String(this.db.getSetting?.('tgAlertCooldownEnabled', '1')) !== '0',
          cooldownMs:  parseInt(this.db.getSetting?.('tgAlertCooldownMs', '60000'), 10) || 60000,
          cap:         parseInt(this.db.getSetting?.('tgAlertQueueCap', '20'), 10) || 20,
          maxAgeMs:    parseInt(this.db.getSetting?.('tgAlertQueueMaxAgeMs', '1800000'), 10) || 1800000,
        };
        this.logger.info(
          `[Admin] AlertScheduler updated: enabled=${cfg.enabled}, cooldown=${cfg.cooldownMs}ms, ` +
          `cap=${cfg.cap}, maxAge=${cfg.maxAgeMs}ms`
        );
        return json(res, 200, { cfg, ok: true });
      }
      // Optional manual queue drop for a specific chat (admin force-flush).
      if (path === '/api/alert-scheduler/drop' && method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const chatId = String(body.chatId || '').trim();
        if (!chatId) return json(res, 400, { error: 'chatId required' });
        const dropped = this.alertScheduler?.dropQueue?.(chatId) ?? 0;
        return json(res, 200, { ok: true, chatId, dropped });
      }

      // Hot trends refresh — periodic re-fetch + re-score loop in index.js.
      // Read on every cycle entry by HotMetricsRefresher._isAdminEnabled, so
      // toggling here takes effect on the NEXT scheduled cycle (no restart).
      //
      // GET returns full status (enabled flag + last-run summary + running
      // bool) so the admin UI can show "last run X min ago" without polling
      // multiple endpoints.
      if (path === '/api/hot-refresh' && method === 'GET') {
        const enabled = String(this.db.getSetting?.('hotRefreshEnabled', '1')) !== '0';
        const status = this.hotRefresher?.getStatus?.() || null;
        return json(res, 200, { enabled, status });
      }
      if (path === '/api/hot-refresh/toggle' && method === 'POST') {
        const cur = this.db.getSetting?.('hotRefreshEnabled', '1');
        const next = String(cur) === '0' ? '1' : '0';
        try {
          this.db.setSetting('hotRefreshEnabled', next);
        } catch (e) {
          this.logger.error(`[Admin] Failed to persist hotRefreshEnabled: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
        const enabled = next !== '0';
        this.logger.info(`[Admin] Hot trends refresh ${enabled ? 'ENABLED' : 'DISABLED'}`);
        return json(res, 200, { enabled });
      }
      // Manual trigger — fires the same cycle that runs on schedule. Mostly
      // for verifying the loop after deploy ("did it actually fetch tweets?")
      // and for forcing a refresh after manually editing thresholds. Returns
      // the cycle's result summary so the UI can update inline without polling.
      // 409 if already running — admin should wait, not pile up calls.
      if (path === '/api/hot-refresh/run' && method === 'POST') {
        if (!this.hotRefresher) return json(res, 503, { error: 'hot-refresher not wired' });
        if (this.hotRefresher.running) return json(res, 409, { error: 'already-running' });
        try {
          const result = await this.hotRefresher.runCycle({ trigger: 'manual' });
          return json(res, 200, { ok: true, result });
        } catch (e) {
          this.logger.error(`[Admin] manual hot-refresh failed: ${e.message}`);
          return json(res, 500, { error: e.message });
        }
      }

      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      this.logger.error('Admin API error', { path, error: e.message });
      return json(res, 500, { error: e.message });
    }
  }

  // ── React SPA ───────────────────────────────────────────────────────────────
  _spa() {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catalyst Admin</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  /* Surfaces — admin keeps its terminal-style navy gradient (NOT a dashboard clone) */
  --bg:#091018;--bg2:#101a23;--bg3:#162330;--bg4:#1c2b3a;
  /* Accent — teal, slightly warmed up for visual punch on hover */
  --accent:#14b8a6;--accent2:#0f766e;--accent-soft:#5eead4;
  --accent-rgb:20,184,166;
  --accent-glow:rgba(20,184,166,.12);
  --accent-tint:rgba(20,184,166,.06);
  /* Semantic state — constant across themes */
  --green:#22c55e;--green-rgb:34,197,94;
  --red:#f87171;--red-rgb:248,113,113;
  --yellow:#f59e0b;--yellow-rgb:245,158,11;
  --blue:#38bdf8;--blue-rgb:56,189,248;
  --purple:#a78bfa;--purple-rgb:167,139,250;
  /* Text — full muted ramp */
  --text:#e5eef7;--text2:#97a8ba;--text3:#6f8095;--muted:#7e90a4;--dim:#5a6b80;
  /* Borders — full ramp */
  --border:#233447;--border2:#2d4055;--border3:#1b2a3a;
  /* Effects */
  --gloss-top:inset 0 1px 0 rgba(255,255,255,.04);
  --gloss-edge:inset 0 0 0 1px rgba(255,255,255,.02);
  --shadow-card:0 12px 32px rgba(0,0,0,.18);
  --shadow-elev:0 18px 48px rgba(0,0,0,.32);
  /* Radii */
  --radius-sm:10px;--radius-md:14px;--radius-lg:16px;--radius-xl:20px;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:
linear-gradient(180deg,#081018 0%,#0a1320 100%);color:var(--text);min-height:100vh}
.layout{display:flex;min-height:100vh}
.sidebar{width:250px;background:linear-gradient(180deg,rgba(12,20,28,.98),rgba(11,18,26,.94));border-right:1px solid rgba(35,52,71,.9);padding:22px 0;flex-shrink:0;display:flex;flex-direction:column;backdrop-filter:blur(18px)}
.logo{padding:0 22px 22px;border-bottom:1px solid var(--border);margin-bottom:16px}
.logo h1{font-size:18px;font-weight:800;color:#fff;letter-spacing:-.3px}
.logo span{font-size:11px;color:var(--accent);letter-spacing:1.2px;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:10px;padding:11px 22px;cursor:pointer;font-size:14px;color:var(--text2);border-radius:0;transition:all .18s;padding-right:14px}
.nav-item:hover{background:rgba(255,255,255,.03);color:var(--text)}
.nav-item.active{background:linear-gradient(90deg,rgba(20,184,166,.18),transparent);color:#fff;border-left:3px solid var(--accent)}
.nav-item.active{padding-left:19px}
.nav-icon{font-size:16px;width:20px;text-align:center}
.nav-label{flex:1;min-width:0}
/* Live hints on sidebar nav-items — small dot or numeric badge to the right.
   Updated every 12s by App's poll loop. Empty when nothing's pending. */
.nav-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;animation:nav-pulse 1.5s ease-in-out infinite}
.nav-dot.paused{background:var(--yellow);box-shadow:0 0 8px rgba(var(--yellow-rgb),.7)}
.nav-dot.live{background:var(--green);box-shadow:0 0 8px rgba(var(--green-rgb),.7)}
.nav-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:rgba(var(--accent-rgb),.18);color:var(--accent-soft);font-variant-numeric:tabular-nums;flex-shrink:0;letter-spacing:.2px}
@keyframes nav-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.main{flex:1;padding:22px 26px 28px;overflow-y:auto}
.main-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;padding:16px 18px;border:1px solid var(--border);border-radius:16px;background:rgba(16,26,35,.78);backdrop-filter:blur(16px)}
.main-topbar h2{font-size:20px;font-weight:800;letter-spacing:-.4px}
.main-topbar p{color:var(--text2);font-size:12px;margin-top:4px}
/* .topbar-actions removed — old badge layout replaced by .sb-pipeline */
/* StatusBar — pipeline view always visible at the top of every admin page.
   Compact stage-row inline with title; shrinks gracefully on narrower screens. */
.sb-topbar{padding:14px 18px}
.sb-topbar.is-paused{border-color:rgba(var(--yellow-rgb),.30);background:linear-gradient(180deg,rgba(var(--yellow-rgb),.04),rgba(16,26,35,.78))}
.sb-head{flex-shrink:0;min-width:0;max-width:280px}
.sb-head:hover h2{color:var(--accent-soft)}
.sb-head h2{font-size:18px;font-weight:800;letter-spacing:-.4px;transition:color .15s}
.sb-head p{color:var(--text2);font-size:12px;margin-top:4px;display:flex;align-items:center;gap:6px;line-height:1.3}
.sb-live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);animation:sb-blink 1.2s ease-in-out infinite;flex-shrink:0}
.sb-paused{color:#fde68a;font-weight:600}
@keyframes sb-blink{0%,100%{opacity:1}50%{opacity:.35}}

.sb-pipeline{flex:1;min-width:0;display:flex;align-items:center;gap:0;justify-content:flex-end;flex-wrap:nowrap}
.sb-node{flex:0 0 auto;min-width:54px;text-align:center;padding:6px 4px 4px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.015);transition:all .35s ease;position:relative}
.sb-node.done{border-color:rgba(var(--accent-rgb),.35);background:rgba(var(--accent-rgb),.05)}
.sb-node.active{border-color:var(--accent);background:rgba(var(--accent-rgb),.14);box-shadow:0 0 0 1px rgba(var(--accent-rgb),.4),0 0 18px rgba(var(--accent-rgb),.32);animation:sb-node-pulse 1.6s ease-in-out infinite}
.sb-node-ico{font-size:16px;line-height:1;filter:grayscale(.3);transition:filter .3s}
.sb-node.active .sb-node-ico,.sb-node.done .sb-node-ico{filter:none}
.sb-node-cnt{font-size:11px;font-weight:700;margin-top:2px;color:var(--text);font-variant-numeric:tabular-nums;line-height:1}
.sb-node:not(.done):not(.active) .sb-node-cnt{color:var(--text2);font-weight:500}
.sb-wire{flex:1 1 14px;min-width:8px;max-width:22px;height:2px;align-self:center;background:rgba(255,255,255,.06);border-radius:2px;margin:0 1px;transition:all .35s}
.sb-wire.done{background:rgba(var(--accent-rgb),.4)}
.sb-wire.active{background:linear-gradient(90deg,rgba(var(--accent-rgb),.4) 0%,var(--accent) 50%,rgba(var(--accent-rgb),.4) 100%);box-shadow:0 0 6px rgba(var(--accent-rgb),.5);animation:sb-wire-pulse 1.4s ease-in-out infinite}
@keyframes sb-node-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
@keyframes sb-wire-pulse{0%,100%{opacity:.7}50%{opacity:1}}
/* On narrower viewports the pipeline wraps below the head instead of shrinking unreadably */
@media (max-width:1100px){
  .sb-topbar{flex-direction:column;align-items:stretch}
  .sb-head{max-width:none}
  .sb-pipeline{justify-content:flex-start;flex-wrap:wrap}
}
.page-header{margin-bottom:22px}
.page-header h2{font-size:24px;font-weight:800;letter-spacing:-.5px}
.page-header p{color:var(--text2);font-size:13px;margin-top:5px;max-width:72ch;line-height:1.5}

/* Cards */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.01));border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px;box-shadow:var(--shadow-card),var(--gloss-top);transition:border-color .15s,transform .15s,box-shadow .15s}
.card:hover{border-color:var(--border2);transform:translateY(-1px);box-shadow:var(--shadow-elev),var(--gloss-top)}
.card-label{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--text2);margin-bottom:8px;font-weight:700}
.card-value{font-size:28px;font-weight:800;letter-spacing:-.8px}
.card-sub{font-size:12px;color:var(--text2);margin-top:6px;line-height:1.4}
.card.green .card-value{color:var(--green)}
.card.purple .card-value{color:var(--accent)}
.card.yellow .card-value{color:var(--yellow)}
.card.blue .card-value{color:var(--blue)}
.stats-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.stats-bottom-grid{display:grid;grid-template-columns:1fr;gap:16px;margin-top:16px}
.info-list{display:flex;flex-direction:column;gap:10px}
.info-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(35,52,71,.7);font-size:12px}
.info-row strong{color:var(--text);font-size:12px}
.info-row span{color:var(--text2)}
.muted-note{font-size:12px;color:var(--text2);line-height:1.5}

/* Table */
.table-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.table-toolbar{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.search-input{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 12px;color:var(--text);font-size:13px;width:220px;outline:none}
.search-input:focus{border-color:var(--accent)}
/* UsersPage row-drawer — replaces a 420px-wide action column. Click ⚙ to
   reveal full action panel below the row. Single-row-open guarantees a
   clean focus state. */
tr.row-open td{background:rgba(var(--accent-rgb),.04)}
tr.row-drawer td{padding:0;background:rgba(var(--accent-rgb),.04);border-top:1px solid var(--border)}
.user-actions{display:flex;gap:24px;flex-wrap:wrap;padding:14px 18px}
.user-actions-group{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.user-actions-label{font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:var(--text3);font-weight:700;margin-right:4px}
.row-toggle{padding:4px 10px;font-size:14px;line-height:1}
select.filter{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;outline:none}
table{width:100%;border-collapse:collapse}
th{padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);border-bottom:1px solid var(--border);background:var(--bg3)}
td{padding:10px 12px;font-size:13px;border-bottom:1px solid rgba(45,45,74,.5)}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}

/* Badges */
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
.badge-active{background:rgba(16,185,129,.15);color:var(--green)}
.badge-blocked{background:rgba(239,68,68,.15);color:var(--red)}
.badge-free{background:rgba(148,163,184,.1);color:var(--text2)}
.badge-admin{background:rgba(239,68,68,.15);color:#f87171}
.badge-basic{background:rgba(59,130,246,.15);color:var(--blue)}
.badge-pro{background:rgba(124,58,237,.15);color:var(--accent)}
.badge-elite{background:rgba(245,158,11,.15);color:var(--yellow)}
.badge-pending{background:rgba(245,158,11,.1);color:var(--yellow)}
.badge-confirmed{background:rgba(16,185,129,.15);color:var(--green)}
.badge-expired{background:rgba(148,163,184,.1);color:var(--text2)}

/* Buttons */
.btn{padding:6px 12px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:500;transition:all .15s}
.btn-sm{padding:4px 9px;font-size:11px}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent2)}
.btn-danger{background:rgba(239,68,68,.2);color:var(--red);border:1px solid rgba(239,68,68,.3)}
.btn-danger:hover{background:rgba(239,68,68,.3)}
.btn-success{background:rgba(16,185,129,.2);color:var(--green);border:1px solid rgba(16,185,129,.3)}
.btn-success:hover{background:rgba(16,185,129,.3)}
.btn-ghost{background:var(--bg3);color:var(--text2);border:1px solid var(--border)}
.btn-ghost:hover{color:var(--text)}
.btn-row{display:flex;gap:6px}

/* Auth overlay */
.auth-overlay{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:999}
.auth-box{background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:36px;width:340px;text-align:center}
.auth-box h2{font-size:20px;margin-bottom:8px}
.auth-box p{color:var(--text2);font-size:13px;margin-bottom:24px}
.auth-input{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:14px;outline:none;margin-bottom:14px}
.auth-input:focus{border-color:var(--accent)}
.auth-err{color:var(--red);font-size:12px;margin-top:8px}

/* Charts */
.chart-bar-wrap{display:flex;align-items:flex-end;gap:4px;height:80px;margin:8px 0}
.chart-bar{flex:1;background:var(--accent);border-radius:3px 3px 0 0;opacity:.7;min-width:12px;transition:all .2s;cursor:pointer;position:relative}
.chart-bar:hover{opacity:1}
.chart-bar-label{font-size:9px;color:var(--text2);text-align:center;margin-top:3px}
.chart-wrap{background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.01));border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px;margin-bottom:16px;box-shadow:var(--shadow-card),var(--gloss-top)}
.chart-title{font-size:13px;font-weight:700;margin-bottom:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.7px}
/* DecisionsPage — was 100+ inline-style blocks; pulled into a proper namespace
   so themes / future restyles don't need surgery on JSX nodes. */
.dec-page-head{margin-bottom:14px}
.dec-page-head h2{font-size:22px;font-weight:800;letter-spacing:-.4px;margin-bottom:6px}
.dec-page-head p{color:var(--muted);font-size:13px;line-height:1.5}
.dec-filter-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.dec-reason-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;font-size:12px}
.dec-search{flex:1;min-width:200px;max-width:420px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:13px;outline:none}
.dec-search:focus{border-color:var(--accent)}
.dec-search-clear{background:transparent;border:none;color:var(--text2);cursor:pointer;font-size:12px;padding:4px 8px}
.dec-search-clear:hover{color:var(--text)}
.dec-list{display:flex;flex-direction:column;gap:10px}
.dec-card{background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--text3);border-radius:10px;padding:12px 14px;transition:border-color .15s}
.dec-card.sent{border-left-color:var(--green)}
.dec-card.skipped{border-left-color:var(--red)}
.dec-row1{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.dec-time{color:var(--muted);font-size:11px;font-family:'ui-monospace',monospace;white-space:nowrap}
.dec-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dec-title-link{color:var(--text);text-decoration:none;font-weight:600;font-size:14px;line-height:1.35}
.dec-title-link:hover{text-decoration:underline}
.dec-title-arrow{color:var(--muted);font-weight:400;margin-left:6px;font-size:12px}
.dec-verdict{font-size:12px;font-weight:600;white-space:nowrap;padding:3px 8px;border-radius:4px}
.dec-verdict.sent{color:var(--green);background:rgba(var(--green-rgb),.12)}
.dec-verdict.skipped{color:var(--red);background:rgba(var(--red-rgb),.12)}
.dec-meta-row{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:8px;align-items:center}
.dec-meta-row b{color:var(--text2);font-weight:600}
.dec-atype-chip{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;border:1px solid transparent}
.dec-atype-chip.event{color:#ff8a65;background:rgba(255,107,107,.12);border-color:rgba(255,107,107,.35)}
.dec-atype-chip.trend{color:#2ed573;background:rgba(46,213,115,.12);border-color:rgba(46,213,115,.35)}
.dec-atype-chip.post{color:#74b9ff;background:rgba(116,185,255,.12);border-color:rgba(116,185,255,.35)}
.dec-eng-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.dec-eng-chip{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);color:var(--text2);background:rgba(255,255,255,.02);font-family:'ui-monospace',monospace}
.dec-gate-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.dec-gate-row.no-bd{margin-bottom:0}
.dec-gate-chip{font-size:11px;padding:2px 8px;border-radius:10px;font-family:'ui-monospace',monospace}
.dec-gate-chip.passed{color:var(--green);background:rgba(var(--green-rgb),.10);border:1px solid rgba(var(--green-rgb),.40)}
.dec-gate-chip.failed{color:var(--red);background:rgba(var(--red-rgb),.10);border:1px solid rgba(var(--red-rgb),.40);cursor:help}
.dec-breakdown{color:var(--muted);font-size:11px;font-family:'ui-monospace',monospace;padding:6px 8px;background:rgba(255,255,255,.02);border-radius:4px;border:1px dashed var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px}
.dec-breakdown-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dec-expand-btn{background:transparent;border:1px solid var(--border);color:var(--text2);font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;font-family:inherit;white-space:nowrap}
.dec-expand-btn:hover{border-color:var(--accent);color:var(--text)}

/* Expanded math panel — full breakdown of every signal that fed alertScore */
.dec-math{position:relative;margin-top:8px;background:linear-gradient(180deg,rgba(140,140,255,.04),rgba(255,255,255,.01));border:1px solid rgba(140,140,255,.18);border-radius:8px;padding:14px}
.dec-math-copy-btn{position:absolute;top:10px;right:10px;padding:4px 10px;border-radius:5px;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text2);font-size:11px;font-family:inherit;cursor:pointer;transition:background 120ms,border-color 120ms,color 120ms;z-index:1}
.dec-math-copy-btn:hover{background:rgba(255,255,255,.07);border-color:var(--border2);color:var(--text)}
.dec-math-copy-btn.copied{background:rgba(34,197,94,.10);border-color:rgba(34,197,94,.30);color:var(--green)}
.dec-math-copy-btn.error{background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.30);color:var(--red)}
.dec-math-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:900px){.dec-math-grid{grid-template-columns:1fr}}
.dec-math-section{background:rgba(0,0,0,.18);border-radius:6px;padding:10px 12px;border:1px solid rgba(255,255,255,.04)}
.dec-math-section h4{margin:0 0 8px 0;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text2);display:flex;align-items:center;gap:6px}
.dec-math-section h4 .badge{font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;background:rgba(255,255,255,.05);color:var(--muted);letter-spacing:0;text-transform:none}
.dec-math-table{width:100%;border-collapse:collapse;font-size:12px;font-family:'ui-monospace',monospace}
.dec-math-table td{padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.03)}
.dec-math-table tr:last-child td{border-bottom:none}
.dec-math-table .label{color:var(--text2);width:30%}
.dec-math-table .calc{color:var(--muted);text-align:right;font-size:11px}
.dec-math-table .contrib{text-align:right;font-weight:700;width:18%}
.dec-math-table .contrib.pos{color:var(--green)}
.dec-math-table .contrib.neg{color:var(--red)}
.dec-math-table .contrib.zero{color:var(--text3)}
.dec-math-table tr.muted td{opacity:.45}
.dec-math-table tr.total td{border-top:2px solid rgba(255,255,255,.10);font-weight:700}
.dec-math-table tr.total .label{color:var(--text)}
.dec-math-table tr.total .contrib{font-size:14px}
.dec-math-equation{margin-top:10px;padding:10px 12px;background:rgba(0,0,0,.30);border-radius:6px;font-family:'ui-monospace',monospace;font-size:13px;text-align:center;color:var(--text2);line-height:1.7}
.dec-math-equation .pos-num{color:var(--green);font-weight:700}
.dec-math-equation .neg-num{color:var(--red);font-weight:700}
.dec-math-equation .final{color:var(--text);font-weight:800;font-size:18px;margin-left:6px}
.dec-math-equation .final.pass{color:var(--green)}
.dec-math-equation .final.fail{color:var(--red)}
.dec-math-floor{margin-top:8px;font-size:11px;color:var(--muted);text-align:center}
.dec-math-floor b{color:var(--text2);font-family:'ui-monospace',monospace}
.dec-math-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;font-size:11px;color:var(--muted)}
.dec-math-meta .pill{padding:3px 8px;border-radius:4px;background:rgba(255,255,255,.04);border:1px solid var(--border);font-family:'ui-monospace',monospace}
.dec-math-meta .pill b{color:var(--text);font-weight:700}
.dec-math-meta .pill.warn{color:#ff8a93;border-color:rgba(255,91,106,.30);background:rgba(255,91,106,.06)}
.dec-math-meta .pill.ok{color:var(--green);border-color:rgba(var(--green-rgb),.30);background:rgba(var(--green-rgb),.06)}
.dec-math-fb{display:flex;gap:6px;font-family:'ui-monospace',monospace;font-size:11px;align-items:center}
.dec-math-fb .like{color:var(--green)}
.dec-math-fb .dislike{color:var(--red)}
.dec-math-fb .arrow{color:var(--muted)}
.dec-math-fb .boost{font-weight:700;padding:1px 6px;border-radius:3px;background:rgba(255,255,255,.06);color:var(--text)}
.dec-math-reasons{margin-top:8px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.06);font-size:11px;display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.dec-math-reasons .lbl{color:var(--muted);font-family:'ui-monospace',monospace;margin-right:4px}
.dec-math-reasons .tag{font-family:'ui-monospace',monospace;color:#ff8a93;background:rgba(255,91,106,.08);border:1px solid rgba(255,91,106,.25);padding:1px 7px;border-radius:3px;font-size:11px}
.dec-math-reasons .tag.safe{color:#7fcfff;background:rgba(120,180,255,.08);border-color:rgba(120,180,255,.25)}

/* Maintenance card — full-width DB-housekeeping section under Stats */
.maintenance-card{margin-top:16px;border-color:rgba(248,113,113,.18);background:linear-gradient(180deg,rgba(248,113,113,.04),rgba(255,255,255,.01))}
.maintenance-card .chart-title{color:var(--red)}
.maintenance-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}

/* Generic card — formerly .broadcast-box, renamed because it was used as
   the universal section wrapper across BotPage, ScannersPage, ManualPage, etc.
   Use <Section title icon actions> for new code; .adm-card class still works. */
.adm-card{background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.01));border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;margin-bottom:20px;box-shadow:var(--shadow-card),var(--gloss-top);transition:border-color .15s,box-shadow .15s}
.adm-card:hover{border-color:var(--border2)}
.adm-card h3{font-size:15px;font-weight:600;margin-bottom:14px}
.adm-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.adm-card-title{font-size:15px;font-weight:600;color:var(--text);display:inline-flex;align-items:center;gap:8px;letter-spacing:-.1px}
.adm-card-title-ico{font-size:18px;line-height:1}
.adm-card-desc{font-size:12px;color:var(--text2);margin:-8px 0 12px;line-height:1.5}
.adm-card-actions{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
textarea.msg-input{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:13px;outline:none;resize:vertical;min-height:100px;font-family:inherit}
textarea.msg-input:focus{border-color:var(--accent)}
.broadcast-footer{display:flex;gap:10px;align-items:center;margin-top:10px}

/* Plans table */
.plan-row{display:grid;grid-template-columns:120px 120px 1fr;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)}
.plan-row:last-child{border-bottom:none}
.plan-head{background:var(--bg3);font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)}
.plan-input{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-size:13px;outline:none;width:80px}
.plan-input:focus{border-color:var(--accent)}

/* Toggle switch */
.toggle-wrap{display:flex;align-items:center;gap:10px}
.toggle{position:relative;width:44px;height:24px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:#2d2d4a;border-radius:24px;cursor:pointer;transition:.25s}
.toggle-slider:before{content:'';position:absolute;height:18px;width:18px;left:3px;top:3px;background:#94a3b8;border-radius:50%;transition:.25s}
input:checked+.toggle-slider{background:var(--green)}
input:checked+.toggle-slider:before{transform:translateX(20px);background:#fff}
/* Examples page (AI calibration few-shot manager) */
.exp-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
/* Unified tab strip — used by ExamplesPage, PresetConfigsPage, BotPage sub-tabs.
   Replaces three near-identical implementations (exp-tab / pcfg-tab / inline). */
.adm-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px}
.adm-tabs.bordered{padding-bottom:14px;border-bottom:1px solid var(--border)}
.adm-tab{position:relative;padding:9px 16px;border-radius:var(--radius-sm);background:var(--bg2);border:1px solid var(--border);color:var(--text2);cursor:pointer;font-size:13px;font-weight:500;transition:all .15s;display:inline-flex;align-items:center;gap:8px;font-family:inherit}
.adm-tab:hover{border-color:rgba(var(--accent-rgb),.35);color:var(--text)}
.adm-tab.active{background:linear-gradient(180deg,rgba(var(--accent-rgb),.18),rgba(var(--accent-rgb),.06));border-color:var(--accent);color:var(--text);box-shadow:0 4px 14px rgba(var(--accent-rgb),.16)}
.adm-tab-count{background:rgba(255,255,255,.08);padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.2px}
.adm-tab.active .adm-tab-count{background:var(--accent);color:#fff}
.adm-tab-dot{position:absolute;top:6px;right:7px;width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px rgba(var(--accent-rgb),.8)}
.exp-spacer{flex:1}
.exp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}
.exp-card{background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,.005));border:1px solid var(--border);border-radius:12px;padding:14px;transition:all .18s;display:flex;flex-direction:column;gap:10px;position:relative}
.exp-card:hover{transform:translateY(-2px);border-color:rgba(20,184,166,.35);box-shadow:0 8px 20px rgba(0,0,0,.2)}
.exp-card.disabled{opacity:.45}
.exp-card.editing{border-color:var(--accent);box-shadow:0 0 0 2px rgba(20,184,166,.2)}
.exp-card-id{position:absolute;top:10px;right:12px;font-size:10px;color:var(--text3);font-family:monospace;letter-spacing:.3px}
.exp-card-head{display:flex;align-items:flex-start;gap:12px}
.exp-score{width:54px;height:54px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0;font-variant-numeric:tabular-nums}
.exp-score.high{background:rgba(34,197,94,.18);color:#22c55e;border:1px solid rgba(34,197,94,.3)}
.exp-score.mid{background:rgba(251,191,36,.18);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
.exp-score.low{background:rgba(255,107,107,.18);color:#ff6b6b;border:1px solid rgba(255,107,107,.3)}
.exp-score.warn{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3);font-size:24px}
.exp-card-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;padding-right:36px}
.exp-cat-chip{display:inline-block;background:rgba(20,184,166,.12);color:var(--accent);font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;align-self:flex-start}
.exp-mistake-chip{display:inline-block;background:rgba(239,68,68,.12);color:#f87171;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;align-self:flex-start}
.exp-card-title{font-size:14px;font-weight:600;color:var(--text);line-height:1.35;word-break:break-word}
.exp-card-rationale{font-size:12px;color:var(--text2);line-height:1.5;font-style:italic}
.exp-card-foot{display:flex;align-items:center;gap:8px;padding-top:10px;border-top:1px solid var(--border)}
.exp-icon-btn{background:transparent;border:1px solid var(--border);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;color:var(--text2);display:inline-flex;align-items:center;gap:5px;transition:all .15s}
.exp-icon-btn:hover{background:rgba(255,255,255,.04);border-color:var(--accent);color:var(--text)}
.exp-icon-btn.danger:hover{border-color:#ff6b6b;color:#ff6b6b;background:rgba(239,68,68,.05)}
.exp-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:9999;animation:expFadeIn .18s ease-out}
.exp-modal{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:24px;max-width:580px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.5);animation:expSlideUp .22s ease-out}
.exp-modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--border)}
.exp-modal-title{font-size:16px;font-weight:600;margin:0}
.exp-modal-close{background:transparent;border:none;cursor:pointer;color:var(--text2);font-size:22px;line-height:1;padding:4px 10px;border-radius:6px}
.exp-modal-close:hover{background:rgba(255,255,255,.06);color:var(--text)}
.exp-modal-foot{display:flex;align-items:center;gap:10px;padding-top:16px;margin-top:8px;border-top:1px solid var(--border)}
@keyframes expFadeIn{from{opacity:0}to{opacity:1}}
@keyframes expSlideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
.exp-form-row{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.exp-form-label{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.exp-form-input{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text);outline:none;font-family:inherit;width:100%;box-sizing:border-box}
.exp-form-input:focus{border-color:var(--accent)}
.exp-form-textarea{min-height:80px;resize:vertical;line-height:1.5}
.exp-form-counter{font-size:10px;color:var(--text3);text-align:right}
.exp-radio-group{display:flex;gap:10px}
.exp-radio{flex:1;padding:12px 14px;border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:10px;background:var(--bg3);font-size:13px}
.exp-radio:hover{border-color:rgba(20,184,166,.4)}
.exp-radio.active{border-color:var(--accent);background:rgba(20,184,166,.08);color:var(--text)}
.exp-radio-icon{font-size:18px}
.exp-slider-row{display:flex;align-items:center;gap:14px}
.exp-slider-row input[type="range"]{flex:1;accent-color:var(--accent)}
.exp-slider-num{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;min-width:38px;text-align:center;padding:6px 10px;border-radius:8px;background:var(--bg3);border:1px solid var(--border)}
.exp-empty{text-align:center;padding:48px 20px;color:var(--text2);border:2px dashed var(--border);border-radius:12px;background:rgba(255,255,255,.01)}
.exp-empty-icon{font-size:48px;opacity:.4;margin-bottom:12px;display:block}
.exp-budget{display:flex;gap:18px;padding:14px 18px;background:rgba(20,184,166,.04);border:1px solid rgba(20,184,166,.15);border-radius:10px;margin-bottom:14px;font-size:12px;color:var(--text2);align-items:center;flex-wrap:wrap}
.exp-budget-stat{display:flex;flex-direction:column;gap:2px}
.exp-budget-num{font-size:18px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;line-height:1.1}
.exp-budget-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px}
.exp-budget-divider{width:1px;background:var(--border);align-self:stretch}
.exp-preview-pre{margin-top:10px;background:#0a0a0a;border:1px solid var(--border);border-radius:8px;padding:14px;font-size:11px;color:var(--text2);max-height:400px;overflow:auto;white-space:pre-wrap;font-family:Consolas,Monaco,monospace;line-height:1.6}
@media (max-width:780px){.exp-grid{grid-template-columns:1fr}}
/* Collector cards grid */
.collector-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:24px}
.collector-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:14px;transition:border-color .2s}
.collector-card.enabled{border-color:rgba(16,185,129,.3)}
.collector-card.disabled{border-color:rgba(239,68,68,.2);opacity:.7}
.collector-icon{font-size:28px}
.collector-name{font-weight:600;font-size:15px}
.collector-status{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.collector-status.on{color:var(--green)}
/* Global scanner status */
.scanner-status-bar{background:linear-gradient(135deg,rgba(20,184,166,.07),rgba(56,189,248,.04));border:1px solid rgba(20,184,166,.16);border-radius:16px;padding:20px 24px;margin-bottom:24px;display:flex;align-items:center;gap:20px;box-shadow:0 12px 32px rgba(0,0,0,.12)}
.scanner-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.scanner-dot.running{background:var(--green);box-shadow:0 0 8px var(--green)}
.scanner-dot.paused{background:var(--red);box-shadow:0 0 8px var(--red)}
.scanner-label{flex:1}
.scanner-label h3{font-size:16px;font-weight:700}
.scanner-label p{font-size:12px;color:var(--text2);margin-top:2px}
.mt16{margin-top:16px}
.loading{text-align:center;padding:40px;color:var(--text2)}
.empty{text-align:center;padding:40px;color:var(--text2);font-size:13px}
.pagination{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--border)}
.tag-en{background:rgba(59,130,246,.15);color:var(--blue);padding:1px 6px;border-radius:4px;font-size:11px}
.tag-ru{background:rgba(124,58,237,.15);color:var(--accent);padding:1px 6px;border-radius:4px;font-size:11px}
.sol-addr{font-family:monospace;font-size:11px;color:var(--text2)}
.success-msg{color:var(--green);font-size:12px}
.error-msg{color:var(--red);font-size:12px}
/* Scanner config (preset + alert/storage thresholds) */
.scfg-preset-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:4px}
.scfg-preset{padding:14px 14px 12px;border-radius:12px;background:var(--bg2);border:1px solid var(--border);cursor:pointer;transition:all .18s;display:flex;flex-direction:column;gap:4px;position:relative;overflow:hidden}
.scfg-preset:hover{border-color:rgba(20,184,166,.35);transform:translateY(-1px)}
.scfg-preset.active{border-color:var(--accent);background:linear-gradient(180deg,rgba(20,184,166,.14),rgba(20,184,166,.04));box-shadow:0 6px 20px rgba(20,184,166,.18)}
.scfg-preset-icon{font-size:22px;line-height:1}
.scfg-preset-label{font-size:13px;font-weight:600;color:var(--text)}
.scfg-preset-hint{font-size:11px;color:var(--text2);line-height:1.35}
.scfg-section{margin-top:22px;padding-top:18px;border-top:1px solid var(--border)}
.scfg-h4{font-size:14px;font-weight:600;margin-bottom:4px}
.scfg-desc{font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.45}
.scfg-row{margin-bottom:14px}
.scfg-row:last-child{margin-bottom:0}
.scfg-row-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:12px}
.scfg-label{color:var(--text);font-weight:500}
.scfg-val{color:var(--accent);font-weight:600;font-variant-numeric:tabular-nums}
.scfg-slider{width:100%;-webkit-appearance:none;appearance:none;height:6px;border-radius:3px;background:var(--bg3);outline:none;cursor:pointer}
.scfg-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer;border:2px solid #fff;box-shadow:0 2px 6px rgba(20,184,166,.4)}
.scfg-slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer;border:2px solid #fff;box-shadow:0 2px 6px rgba(20,184,166,.4)}
/* Preset configs page (per-preset pipeline tuning) — 2026-05-01 PR-3 */
.pcfg-banner{padding:12px 14px;border-radius:10px;background:rgba(20,184,166,.06);border:1px dashed var(--border3);margin-bottom:18px;display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.5}
.pcfg-banner-icon{font-size:20px;line-height:1}
.pcfg-banner-title{font-weight:600;margin-bottom:4px}
.pcfg-banner-desc{color:var(--text2);font-size:12px}
/* pcfg-tabs/tab/dot — replaced by unified .adm-tabs (above). Kept only the
   .adm-tab.capitalize modifier here for the preset tab labels. */
.adm-tab.capitalize{text-transform:capitalize}
.pcfg-accordion{margin-bottom:14px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.pcfg-accordion[open]{box-shadow:0 6px 20px rgba(0,0,0,.12)}
.pcfg-accordion-summary{padding:14px 16px;cursor:pointer;font-size:14px;font-weight:600;color:var(--text);user-select:none;display:flex;align-items:center;justify-content:space-between;list-style:none}
.pcfg-accordion-summary::-webkit-details-marker{display:none}
.pcfg-accordion-summary::after{content:'\\25BC';font-size:10px;color:var(--text2);transition:transform .2s}
.pcfg-accordion[open] .pcfg-accordion-summary::after{transform:rotate(180deg)}
.pcfg-accordion-summary:hover{background:rgba(255,255,255,.02)}
.pcfg-accordion-body{padding:8px 16px 16px;border-top:1px solid var(--border)}
.pcfg-subsection{margin-top:14px;padding:14px;border-radius:8px;background:var(--bg);border:1px solid var(--border)}
.pcfg-subsection:first-child{margin-top:6px}
.pcfg-subsection-title{font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.pcfg-row{margin-bottom:14px}
.pcfg-row:last-child{margin-bottom:0}
.pcfg-row-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:12px;gap:10px}
.pcfg-label{color:var(--text);font-weight:500;display:inline-flex;align-items:center;gap:6px}
.pcfg-row-right{display:inline-flex;align-items:center;gap:8px}
.pcfg-val{color:var(--accent);font-weight:600;font-variant-numeric:tabular-nums}
.pcfg-val.over-budget{color:var(--red)}
.pcfg-override-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 4px rgba(20,184,166,.8)}
.pcfg-reset-btn{background:transparent;border:1px solid var(--border);color:var(--text2);width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:12px;line-height:1;padding:0;transition:all .15s}
.pcfg-reset-btn:hover{border-color:var(--accent);color:var(--accent)}
.pcfg-desc{font-size:11px;color:var(--text2);line-height:1.45;margin-top:4px}
.pcfg-chips{display:flex;flex-wrap:wrap;gap:6px;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;align-items:center;min-height:46px}
.pcfg-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 4px 4px 10px;background:rgba(20,184,166,.14);border:1px solid rgba(20,184,166,.3);border-radius:14px;font-size:12px;color:var(--text);max-width:100%}
.pcfg-chip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px;font-variant-numeric:tabular-nums}
.pcfg-chip-x{background:transparent;border:none;color:var(--text2);cursor:pointer;width:18px;height:18px;border-radius:50%;font-size:11px;line-height:1;padding:0;transition:all .15s}
.pcfg-chip-x:hover{background:rgba(239,68,68,.2);color:var(--red)}
.pcfg-chip-lock{background:transparent;border:none;cursor:pointer;width:18px;height:18px;font-size:12px;line-height:1;padding:0;margin-right:-2px;transition:all .15s;opacity:.7}
.pcfg-chip-lock:hover{opacity:1;transform:scale(1.15)}
.pcfg-chip-locked{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.45);box-shadow:0 0 0 1px rgba(34,197,94,.25)}
.pcfg-chip-input{flex:1;min-width:140px;background:transparent;border:none;outline:none;color:var(--text);font-size:12px;padding:4px 6px;font-family:inherit}
.pcfg-chip-input::placeholder{color:var(--text3)}
.pcfg-budget{margin-top:8px;font-size:12px;color:var(--text2);text-align:right;font-variant-numeric:tabular-nums}
.pcfg-budget.over{color:var(--red)}
.pcfg-budget.full{color:var(--green)}
.pcfg-actions{display:flex;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border);align-items:center;flex-wrap:wrap}
.pcfg-actions-spacer{flex:1}
.pcfg-status{font-size:12px;padding:8px 12px;border-radius:6px}
.pcfg-status.ok{background:rgba(34,197,94,.1);color:var(--green)}
.pcfg-status.err{background:rgba(239,68,68,.1);color:var(--red)}
/* Submit page (Ручной анализ) — matches the .card / .scanner-status-bar / .exp-card vocabulary used elsewhere */
.sp-form{display:flex;flex-direction:column;gap:12px}
.sp-form-label{font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px}
.sp-input{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit}
.sp-input:focus{border-color:var(--accent)}
.sp-textarea{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:13px;outline:none;resize:vertical;min-height:60px;font-family:inherit;line-height:1.5}
.sp-textarea:focus{border-color:var(--accent)}
.sp-counter{font-size:11px;color:var(--text2);font-variant-numeric:tabular-nums}
.sp-counter.over{color:var(--red)}
.sp-loading{text-align:center;padding:26px 20px;color:var(--text2);background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.005));border:1px solid var(--border);border-radius:16px;box-shadow:0 12px 32px rgba(0,0,0,.12);margin-bottom:18px}
.sp-loading-icon{font-size:28px;margin-bottom:8px;opacity:.85}
.sp-history-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px}
.sp-history-title{font-size:11px;font-weight:700;color:var(--text2);letter-spacing:.7px;text-transform:uppercase}
.sp-history-hint{font-size:11px;color:var(--text2)}
.sp-history-strip{display:flex;gap:10px;overflow-x:auto;padding:4px 2px 12px;scroll-snap-type:x proximity}
.sp-history-strip::-webkit-scrollbar{height:6px}
.sp-history-strip::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}
.sp-hist-card{flex:0 0 230px;cursor:pointer;background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,.005));border:1px solid var(--border);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px;transition:all .18s;scroll-snap-align:start;position:relative}
.sp-hist-card:hover{transform:translateY(-2px);border-color:rgba(20,184,166,.35);box-shadow:0 8px 18px rgba(0,0,0,.18)}
.sp-hist-card.active{border-color:var(--accent);background:linear-gradient(180deg,rgba(20,184,166,.12),rgba(20,184,166,.03));box-shadow:0 0 0 1px rgba(20,184,166,.25),0 8px 22px rgba(20,184,166,.16)}
.sp-hist-row{display:flex;align-items:center;gap:8px}
.sp-hist-thumb{width:44px;height:44px;border-radius:8px;border:1px solid var(--border);object-fit:cover;flex-shrink:0;background:var(--bg3)}
.sp-hist-thumb-fallback{width:44px;height:44px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.sp-hist-text{flex:1;min-width:0}
.sp-hist-title{font-size:12px;font-weight:600;color:var(--text);line-height:1.35;max-height:2.7em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.sp-hist-meta{font-size:10px;color:var(--text2);margin-top:3px}
.sp-hist-foot{display:flex;align-items:center;justify-content:space-between;gap:6px}
.sp-hist-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;font-family:'JetBrains Mono',Consolas,monospace}
.sp-hist-pill.high{color:var(--green);background:color-mix(in srgb,var(--green) 14%,transparent)}
.sp-hist-pill.mid{color:var(--yellow);background:color-mix(in srgb,var(--yellow) 14%,transparent)}
.sp-hist-pill.low{color:#ff7849;background:rgba(255,120,73,.14)}
.sp-hist-pill.cold{color:var(--text2);background:rgba(255,255,255,.05)}
.sp-hist-time{font-size:10px;color:var(--text2)}
.sp-hist-trash{background:transparent;border:none;color:var(--text2);cursor:pointer;font-size:13px;padding:2px 4px;line-height:1;border-radius:4px;opacity:.55;transition:opacity .15s,color .15s,background .15s}
.sp-hist-trash:hover{opacity:1;color:var(--red);background:rgba(239,68,68,.1)}
.sp-empty{text-align:center;padding:40px 24px;color:var(--text2);border:2px dashed var(--border);border-radius:14px;background:rgba(255,255,255,.01)}
.sp-empty-icon{font-size:38px;opacity:.4;margin-bottom:10px;display:block}
.sp-detail{background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.01));border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,.12)}
.sp-hero{display:flex;align-items:flex-start;gap:14px;padding:18px 20px;background:linear-gradient(135deg,rgba(20,184,166,.07),rgba(56,189,248,.04));border-bottom:1px solid var(--border)}
.sp-hero-thumb{width:84px;height:84px;border-radius:12px;object-fit:cover;border:1px solid var(--border);flex-shrink:0;background:var(--bg3)}
.sp-hero-thumb-fallback{width:84px;height:84px;border-radius:12px;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:36px;flex-shrink:0}
.sp-hero-body{flex:1;min-width:0}
.sp-hero-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:4px}
.sp-hero-title{font-size:16px;font-weight:800;color:var(--text);line-height:1.3;letter-spacing:-.2px;word-break:break-word}
.sp-hero-meta{font-size:11px;color:var(--text2);margin-bottom:10px;letter-spacing:.2px}
.sp-hero-actions{display:flex;flex-wrap:wrap;gap:8px}
.sp-detail-body{padding:18px 20px;display:flex;flex-direction:column;gap:14px}
.sp-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.2px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--text2);font-family:inherit}
.sp-pill.manual{color:var(--accent);border-color:rgba(20,184,166,.45);background:rgba(20,184,166,.10)}
.sp-pill.ok{color:var(--green);border-color:color-mix(in srgb,var(--green) 38%,transparent);background:color-mix(in srgb,var(--green) 12%,transparent)}
.sp-pill.warn{color:var(--yellow);border-color:color-mix(in srgb,var(--yellow) 38%,transparent);background:color-mix(in srgb,var(--yellow) 10%,transparent)}
.sp-pill.bad{color:var(--red);border-color:color-mix(in srgb,var(--red) 38%,transparent);background:color-mix(in srgb,var(--red) 10%,transparent)}
.sp-pill.skipped{color:var(--text2);border-color:var(--border);background:rgba(255,255,255,.03)}
.sp-trace{display:flex;flex-wrap:wrap;gap:8px}
.sp-score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.sp-score-tile{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.sp-score-tile-label{font-size:10px;color:var(--text2);font-weight:700;letter-spacing:.4px;text-transform:uppercase;margin-bottom:4px}
.sp-score-tile-value{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;font-family:'JetBrains Mono',Consolas,monospace;color:var(--blue)}
.sp-score-tile.hot .sp-score-tile-value{color:#ff7849}
.sp-score-tile.warm .sp-score-tile-value{color:var(--yellow)}
.sp-score-tile.bad .sp-score-tile-value{color:var(--red)}
.sp-bars{padding:14px 16px;background:var(--bg2);border:1px solid var(--border);border-radius:10px}
.sp-bar{margin-bottom:10px}
.sp-bar:last-child{margin-bottom:0}
.sp-bar-head{display:flex;justify-content:space-between;font-size:11px;color:var(--text2);margin-bottom:4px}
.sp-bar-label{font-weight:600}
.sp-bar-val{font-family:'JetBrains Mono',Consolas,monospace;font-weight:700}
.sp-bar-track{height:6px;background:var(--bg3);border:1px solid var(--border);border-radius:3px;overflow:hidden}
.sp-bar-fill{height:100%;border-radius:2px;transition:width .35s ease}
.sp-bar-sub{margin-top:5px;font-size:11px;color:var(--text2)}
.sp-block{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.sp-block-label{font-size:10px;color:var(--text2);font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.sp-block.accent-trigger{background:rgba(248,113,113,.04);border-color:rgba(248,113,113,.18)}
.sp-block.accent-trigger .sp-block-label{color:var(--red)}
.sp-block.accent-stage2{background:rgba(56,189,248,.05);border-color:rgba(56,189,248,.18)}
.sp-block.accent-stage2 .sp-block-label{color:var(--blue)}
.sp-block.accent-prestage{background:rgba(124,58,237,.05);border-color:rgba(124,58,237,.18)}
.sp-block.accent-prestage .sp-block-label{color:#a78bfa}
.sp-block.accent-tg{background:rgba(34,197,94,.05);border-color:rgba(34,197,94,.20)}
.sp-block.accent-tg .sp-block-label{color:var(--green)}
.sp-narrative{padding:10px 14px;background:rgba(255,255,255,.025);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;font-size:13px;line-height:1.55;color:var(--text);white-space:pre-wrap;word-break:break-word}
.sp-narrative.warm{border-left-color:#ff7849;background:rgba(255,120,73,.05)}
.sp-collapsible{border:1px solid var(--border);border-radius:10px;background:var(--bg2);overflow:hidden}
.sp-collapsible-head{width:100%;text-align:left;padding:11px 16px;background:transparent;border:none;color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;font-family:inherit;transition:background .15s,color .15s}
.sp-collapsible-head:hover{background:rgba(255,255,255,.02);color:var(--text)}
.sp-collapsible-head.open{color:var(--text)}
.sp-collapsible-arrow{font-size:10px;opacity:.65}
.sp-collapsible-body{padding:6px 16px 14px;border-top:1px solid var(--border)}
.sp-collapsible.accent-prestage{background:rgba(124,58,237,.04);border-color:rgba(124,58,237,.18)}
.sp-collapsible.accent-prestage .sp-collapsible-head{color:#a78bfa}
.sp-collapsible.accent-stage2{background:rgba(56,189,248,.04);border-color:rgba(56,189,248,.18)}
.sp-collapsible.accent-stage2 .sp-collapsible-head{color:var(--blue)}
.sp-meta-chips{display:flex;flex-wrap:wrap;gap:6px}
.sp-chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--text2);font-size:11px;font-weight:600;font-family:inherit}
.sp-chip-atype-event{background:color-mix(in srgb,var(--red,#ff6b6b) 12%,transparent);border-color:color-mix(in srgb,var(--red,#ff6b6b) 35%,transparent);color:#ff8a65}
.sp-chip-atype-trend{background:color-mix(in srgb,var(--green,#2ed573) 12%,transparent);border-color:color-mix(in srgb,var(--green,#2ed573) 35%,transparent);color:#2ed573}
.sp-chip-atype-post {background:color-mix(in srgb,var(--blue,#74b9ff) 12%,transparent);border-color:color-mix(in srgb,var(--blue,#74b9ff) 35%,transparent);color:#74b9ff}
.sp-chip b{color:var(--text);font-weight:700;margin-left:4px}
.sp-metric-row{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--text2);font-family:'JetBrains Mono',Consolas,monospace}
.sp-metric-row b{color:var(--text);font-weight:700}
.sp-metric-row .accent{color:var(--blue)}
.sp-metric-row .danger{color:var(--red)}
.sp-metric-row .ok{color:var(--green)}
.sp-thumbs{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}
.sp-thumbs img{height:110px;border-radius:6px;border:1px solid var(--border)}
.sp-toast{padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.5}
.sp-toast.err{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);color:var(--red)}
.sp-toast.ok{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);color:var(--green)}
.sp-error-inline{color:var(--red);font-size:12px}
.sp-trigger-sources{margin-top:8px;font-size:11px;color:var(--text2)}
.sp-trigger-sources a{color:var(--blue);margin-right:8px;text-decoration:none}
.sp-trigger-sources a:hover{text-decoration:underline}
.sp-trigger-conf{margin-top:4px;font-size:11px;color:var(--text2);font-style:italic}
.error-banner{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;font-size:13px;margin:8px 0}
.error-banner-error{background:rgba(244,33,46,.08);border:1px solid rgba(244,33,46,.3);color:#ff6b6b}
.error-banner-warn{background:rgba(255,167,38,.08);border:1px solid rgba(255,167,38,.3);color:#ffcc80}
.error-banner-icon{font-size:16px}
.error-banner-msg{flex:1}
.error-banner-retry{padding:4px 10px;border-radius:6px;background:transparent;border:1px solid currentColor;color:inherit;cursor:pointer;font-size:12px}
.error-banner-retry:hover{background:rgba(255,255,255,.05)}
@media (max-width:780px){
  .sp-hero{flex-direction:column;align-items:flex-start;gap:12px}
  .sp-hero-thumb,.sp-hero-thumb-fallback{width:64px;height:64px;font-size:28px}
  .sp-detail-body{padding:14px}
  .sp-hist-card{flex:0 0 200px}
}
@media (max-width: 980px){
  .layout{flex-direction:column}
  .sidebar{width:100%;border-right:none;border-bottom:1px solid var(--border)}
  .main{padding:18px 14px 24px}
  .main-topbar{flex-direction:column;align-items:flex-start}
  .stats-grid,.stats-bottom-grid{grid-template-columns:1fr}
  .scanner-status-bar{flex-direction:column;align-items:flex-start}
}
</style>
</head>
<body>
<div id="root"></div>
<script>
const {useState,useEffect,useCallback,useMemo}=React;

// ── API ──────────────────────────────────────────────────────────────────────
const BASE = '';
let _apiKey = localStorage.getItem('adminKey') || '';

async function api(path, method='GET', body=null) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': _apiKey } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  if (r.status === 401) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const data = await r.json();
  if (!r.ok) {
    // Surface server-side context (status + parsed body) on the thrown Error so
    // callers can show rate-limit / cooldown details instead of generic "API
    // error". Previously this swallowed 429s with reason='force_cooldown' into
    // an uninformative flash — fixed 2026-05-16.
    const msg = data.error || data.reason || ('HTTP ' + r.status);
    throw Object.assign(new Error(msg), { status: r.status, body: data });
  }
  return data;
}

// ── Error banner component (Bundle #13, 2026-05-28) ──────────────────────
// Shared inline error UI. Use as: React.createElement(ErrorBanner, { message, onRetry, variant })
// Mirror of dashboard SPA's ErrorBanner — keep in sync.
function ErrorBanner({ message, onRetry, variant }) {
  const h = React.createElement;
  const v = variant || 'error';
  return h('div', { className: 'error-banner error-banner-' + v },
    h('span', { className: 'error-banner-icon' }, v === 'error' ? '⚠' : 'ⓘ'),
    h('span', { className: 'error-banner-msg' }, String(message || 'Something went wrong')),
    onRetry ? h('button', { className: 'error-banner-retry', onClick: onRetry }, 'Retry') : null
  );
}

// ── Section primitive ───────────────────────────────────────────────────────
// Generic card-with-header used across the admin SPA. Pre-PR-2 every page
// re-rolled its own ".broadcast-box / h3 / actions" combo with subtle
// inconsistencies. This component centralises that — pass title/icon/desc/
// actions; children render below the head.
function Section({ icon, title, desc, actions, className, children, style }) {
  const cls = 'adm-card' + (className ? ' ' + className : '');
  return React.createElement('div', { className: cls, style },
    (title || actions) && React.createElement('div', { className: 'adm-card-head' },
      title && React.createElement('div', { className: 'adm-card-title' },
        icon && React.createElement('span', { className: 'adm-card-title-ico' }, icon),
        React.createElement('span', null, title)
      ),
      actions && React.createElement('div', { className: 'adm-card-actions' }, actions)
    ),
    desc && React.createElement('div', { className: 'adm-card-desc' }, desc),
    children
  );
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function AuthOverlay({ onAuth }) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    _apiKey = key;
    try { await api('/api/stats'); localStorage.setItem('adminKey', key); onAuth(key); }
    catch (e) { setErr('Неверный ключ'); _apiKey = ''; }
  };
  return React.createElement('div',{className:'auth-overlay'},
    React.createElement('div',{className:'auth-box'},
      React.createElement('div',{style:{fontSize:32,marginBottom:12}},'🔐'),
      React.createElement('h2',null,'Catalyst Admin'),
      React.createElement('p',null,'Введите ADMIN_API_KEY для входа'),
      React.createElement('input',{className:'auth-input',type:'password',placeholder:'Admin API Key',value:key,onChange:e=>setKey(e.target.value),onKeyDown:e=>e.key==='Enter'&&submit()}),
      React.createElement('button',{className:'btn btn-primary',style:{width:'100%',padding:'10px'},onClick:submit},'Войти'),
      err&&React.createElement('div',{className:'auth-err'},err)
    )
  );
}

// ── Mini Bar Chart ─────────────────────────────────────────────────────────────
function BarChart({data, color='#7c3aed'}) {
  if (!data||!data.length) return React.createElement('div',{className:'empty'},'Нет данных');
  const max = Math.max(...data.map(d=>d.n||d.total||0), 1);
  return React.createElement('div',null,
    React.createElement('div',{className:'chart-bar-wrap'},
      data.map((d,i)=>React.createElement('div',{key:i,style:{display:'flex',flexDirection:'column',alignItems:'center',flex:1}},
        React.createElement('div',{className:'chart-bar',style:{height:Math.max(4,(d.n||d.total||0)/max*76)+'px',background:color}},null),
        React.createElement('div',{className:'chart-bar-label'},d.day?d.day.slice(5):d.n)
      ))
    )
  );
}

// ── Donut-like Pie ────────────────────────────────────────────────────────────
function PieLegend({data, colors}) {
  const total = data.reduce((s,d)=>s+(d.n||0),0)||1;
  return React.createElement('div',{style:{display:'flex',flexDirection:'column',gap:8}},
    data.map((d,i)=>React.createElement('div',{key:i,style:{display:'flex',alignItems:'center',gap:8}},
      React.createElement('div',{style:{width:10,height:10,borderRadius:2,background:colors[i%colors.length],flexShrink:0}}),
      React.createElement('span',{style:{fontSize:12,color:'var(--text2)',flex:1}},d.name),
      React.createElement('span',{style:{fontSize:12,fontWeight:600}},d.n),
      React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},Math.round(d.n/total*100)+'%')
    ))
  );
}

// ── Pages ─────────────────────────────────────────────────────────────────────

function UsersPage() {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [planF, setPlanF] = useState('');
  const [statusF, setStatusF] = useState('');
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  // Inline-drawer per row: only one row open at a time. Replaces a 420px
  // wide action column that overflowed on laptops with 5 controls crammed
  // side by side. Click ⚙ → action panel slides open below the row.
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers(await api('/api/users?search='+encodeURIComponent(search)+'&plan='+planF+'&status='+statusF)); }
    catch(e){ setMsg(e.message); }
    finally { setLoading(false); }
  }, [search, planF, statusF]);

  useEffect(()=>{ load(); }, [load]);

  useEffect(() => {
    const next = {};
    for (const u of users) {
      next[u.id] = {
        plan: u.plan_name || 'free',
        days: 30,
      };
    }
    setDraft(next);
  }, [users]);

  const action = async (url, method='POST', body=null) => {
    try { await api(url, method, body); setMsg('✓ Готово'); load(); setTimeout(()=>setMsg(''),2000); }
    catch(e){ setMsg('Ошибка: '+e.message); }
  };

  const setUserDraft = (userId, field, value) => {
    setDraft(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), [field]: value } }));
  };

  const grantSubscription = async (u) => {
    const d = draft[u.id] || { plan: u.plan_name || 'pro', days: 30 };
    const days = Math.max(1, Math.min(3650, parseInt(d.days, 10) || 30));
    await action('/api/users/' + u.id + '/subscription/grant', 'POST', { plan: d.plan, days });
  };

  const revokeSubscription = async (u) => {
    if (!window.confirm('Снять подписку и вернуть пользователя на Free?')) return;
    await action('/api/users/' + u.id + '/subscription/revoke', 'POST');
  };

  const toggleBan = async (u) => {
    const next = u.status === 'blocked' ? 'active' : 'blocked';
    await action('/api/users/' + u.id + '/status', 'POST', { status: next });
  };

  // SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" without timezone → force UTC
  const utcDate = dt => { if (!dt) return null; const s = dt.includes('Z')||dt.includes('+') ? dt : dt.replace(' ','T')+'Z'; return new Date(s); };
  const fmt   = dt => { const d = utcDate(dt); return d ? d.toLocaleDateString('ru') : '—'; };
  const fmtDt = dt => { const d = utcDate(dt); return d ? d.toLocaleString('ru',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; };
  const activeUsers = users.filter(u => (u.status || 'active') === 'active').length;
  const blockedUsers = users.filter(u => u.status === 'blocked').length;
  const paidUsers = users.filter(u => ['test','pro','admin'].includes(u.plan_name)).length;

  return React.createElement('div',null,
    React.createElement('div',{className:'page-header'},
      React.createElement('h2',null,'👥 Пользователи'),
      React.createElement('p',null,'Управление аккаунтами, планами и статусами')
    ),
    React.createElement('div',{className:'cards'},
      React.createElement('div',{className:'card purple'},React.createElement('div',{className:'card-label'},'В выборке'),React.createElement('div',{className:'card-value'},users.length),React.createElement('div',{className:'card-sub'},'С учётом текущих фильтров')),
      React.createElement('div',{className:'card green'},React.createElement('div',{className:'card-label'},'Active'),React.createElement('div',{className:'card-value'},activeUsers),React.createElement('div',{className:'card-sub'},'Пользователи без блокировки')),
      React.createElement('div',{className:'card yellow'},React.createElement('div',{className:'card-label'},'Paid / privileged'),React.createElement('div',{className:'card-value'},paidUsers),React.createElement('div',{className:'card-sub'},'Test, Pro и Admin')),
      React.createElement('div',{className:'card'},React.createElement('div',{className:'card-label'},'Blocked'),React.createElement('div',{className:'card-value'},blockedUsers),React.createElement('div',{className:'card-sub'},blockedUsers===0?'Блокировок нет':'Нужен manual review'))
    ),
    React.createElement('div',{className:'table-wrap'},
      React.createElement('div',{className:'table-toolbar'},
        React.createElement('input',{className:'search-input',placeholder:'🔍 Поиск по username или chat ID...',value:search,onChange:e=>setSearch(e.target.value)}),
        React.createElement('select',{className:'filter',value:planF,onChange:e=>setPlanF(e.target.value)},
          React.createElement('option',{value:''},'Все планы'),
          React.createElement('option',{value:'free'},'Free'),
          React.createElement('option',{value:'test'},'Test'),
          React.createElement('option',{value:'pro'},'Pro'),
          React.createElement('option',{value:'admin'},'Admin'),
        ),
        React.createElement('select',{className:'filter',value:statusF,onChange:e=>setStatusF(e.target.value)},
          React.createElement('option',{value:''},'Все статусы'),
          React.createElement('option',{value:'active'},'Active'),
          React.createElement('option',{value:'blocked'},'Blocked'),
        ),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:load},'↻ Обновить'),
        msg&&React.createElement('span',{className:msg.includes('Ошибка')?'error-msg':'success-msg'},msg)
      ),
      loading ? React.createElement('div',{className:'loading'},'Загрузка...') :
      users.length === 0 ? React.createElement('div',{className:'empty'},'Пользователи не найдены') :
      React.createElement('table',null,
        React.createElement('thead',null,React.createElement('tr',null,
          ...[['ID','40px'],['Chat ID',''],['Username',''],['Язык','60px'],['План',''],['Статус',''],['Подписка до',''],['Алерты','70px'],['Активность',''],['','64px']].map(([h,w])=>
            React.createElement('th',{key:h,style:{width:w||'auto'}},h)
          )
        )),
        React.createElement('tbody',null,
          users.flatMap(u=>{
            const open = expandedId === u.id;
            const row = React.createElement('tr',{key:u.id, className: open ? 'row-open' : ''},
              React.createElement('td',null,React.createElement('span',{style:{color:'var(--text2)',fontSize:11}},'#'+u.id)),
              React.createElement('td',null,React.createElement('span',{className:'sol-addr'},u.telegram_chat_id)),
              React.createElement('td',null,u.telegram_username?'@'+u.telegram_username:React.createElement('span',{style:{color:'var(--text2)'}},'-')),
              React.createElement('td',null,React.createElement('span',{className:u.language==='ru'?'tag-ru':'tag-en'},u.language||'en')),
              React.createElement('td',null,React.createElement('span',{className:'badge badge-'+u.plan_name},u.plan_name)),
              React.createElement('td',null,React.createElement('span',{className:'badge badge-'+(u.status||'active')},u.status||'active')),
              React.createElement('td',null,React.createElement('span',{style:{fontSize:12}},fmt(u.subscription_expires_at))),
              React.createElement('td',null,React.createElement('span',{style:{fontSize:12}},u.alert_count_today||0)),
              React.createElement('td',null,React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},fmtDt(u.last_seen_at))),
              React.createElement('td',null,
                React.createElement('button',{
                  className:'btn btn-ghost btn-sm row-toggle',
                  onClick:()=>setExpandedId(open ? null : u.id),
                  title: open ? 'Закрыть' : 'Действия'
                }, open ? '▴' : '⚙')
              )
            );
            if (!open) return [row];
            const drawer = React.createElement('tr',{key:u.id+'-drawer', className:'row-drawer'},
              React.createElement('td',{colSpan:10},
                React.createElement('div',{className:'user-actions'},
                  React.createElement('div',{className:'user-actions-group'},
                    React.createElement('div',{className:'user-actions-label'},'Подписка'),
                    React.createElement('select',{
                      className:'filter',
                      style:{minWidth:100},
                      value:(draft[u.id]?.plan || u.plan_name || 'free'),
                      onChange:e=>setUserDraft(u.id,'plan',e.target.value)
                    },
                      React.createElement('option',{value:'free'},'Free'),
                      React.createElement('option',{value:'test'},'Test'),
                      React.createElement('option',{value:'pro'},'Pro'),
                      React.createElement('option',{value:'admin'},'Admin'),
                    ),
                    React.createElement('input',{
                      className:'plan-input',
                      style:{width:84},
                      type:'number',
                      min:1,
                      max:3650,
                      value:(draft[u.id]?.days || 30),
                      onChange:e=>setUserDraft(u.id,'days',e.target.value)
                    }),
                    React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},'дней'),
                    React.createElement('button',{className:'btn btn-primary btn-sm',onClick:()=>grantSubscription(u)},'Выдать'),
                    React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>revokeSubscription(u)},'Снять')
                  ),
                  React.createElement('div',{className:'user-actions-group'},
                    React.createElement('div',{className:'user-actions-label'},'Статус'),
                    u.status!=='blocked'
                      ? React.createElement('button',{className:'btn btn-danger btn-sm',onClick:()=>toggleBan(u)},'🚫 Заблокировать')
                      : React.createElement('button',{className:'btn btn-success btn-sm',onClick:()=>toggleBan(u)},'✓ Разблокировать')
                  )
                )
              )
            );
            return [row, drawer];
          })
        )
      )
    )
  );
}

function PaymentsPage() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [msg, setMsg] = useState('');
  const limit = 50;

  const load = useCallback(async()=>{
    setLoading(true);
    try { setPayments(await api('/api/payments?limit='+limit+'&offset='+offset)); }
    catch(e){ setMsg(e.message); }
    finally { setLoading(false); }
  }, [offset]);

  useEffect(()=>{ load(); },[load]);

  const removeRaw = async (id) => {
    if (!window.confirm('Точно удалить этот платеж?')) return;
    try { await api('/api/payments/'+id, 'DELETE'); load(); }
    catch(e){ setMsg(e.message); }
  };

  const cleanup = async () => {
    try { await api('/api/payments/cleanup', 'POST'); setMsg('Очищено'); load(); setTimeout(()=>setMsg(''), 2000); }
    catch(e){ setMsg(e.message); }
  };

  const utcDate2 = dt => { if (!dt) return null; const s = dt.includes('Z')||dt.includes('+') ? dt : dt.replace(' ','T')+'Z'; return new Date(s); };
  const fmtDt = dt => { const d = utcDate2(dt); return d ? d.toLocaleString('ru',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'; };
  const fmtMoney = (amount, currency) => {
    if (amount === null || amount === undefined) return '—';
    const c = (currency || 'SOL').toUpperCase();
    const decimals = c === 'SOL' ? 4 : 2;
    return parseFloat(amount).toFixed(decimals) + ' ' + c;
  };
  const confirmed = payments.filter(p => p.status === 'confirmed').length;
  const pending = payments.filter(p => p.status === 'pending').length;
  const expired = payments.filter(p => p.status === 'expired').length;

  return React.createElement('div',null,
    React.createElement('div',{className:'page-header'},
      React.createElement('h2',null,'💳 Платежи'),
      React.createElement('p',null,'История транзакций Solana Pay')
    ),
    React.createElement('div',{className:'cards'},
      React.createElement('div',{className:'card purple'},React.createElement('div',{className:'card-label'},'В выборке'),React.createElement('div',{className:'card-value'},payments.length),React.createElement('div',{className:'card-sub'},'Текущая страница журнала')),
      React.createElement('div',{className:'card green'},React.createElement('div',{className:'card-label'},'Confirmed'),React.createElement('div',{className:'card-value'},confirmed),React.createElement('div',{className:'card-sub'},'Успешно завершённые платежи')),
      React.createElement('div',{className:'card yellow'},React.createElement('div',{className:'card-label'},'Pending'),React.createElement('div',{className:'card-value'},pending),React.createElement('div',{className:'card-sub'},'Требуют завершения или истечения')),
      React.createElement('div',{className:'card'},React.createElement('div',{className:'card-label'},'Expired'),React.createElement('div',{className:'card-value'},expired),React.createElement('div',{className:'card-sub'},expired===0?'Хвост чистый':'Можно подчистить'))
    ),
    React.createElement('div',{className:'table-wrap'},
      React.createElement('div',{className:'table-toolbar'},
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:load},'↻ Обновить'),
        React.createElement('button',{className:'btn btn-danger btn-sm',onClick:cleanup},'🧹 Очистить истекшие'),
        React.createElement('span',{style:{fontSize:12,color:'var(--text2)'}},payments.length+' записей'),
        msg&&React.createElement('span',{className:'success-msg'},msg)
      ),
      loading ? React.createElement('div',{className:'loading'},'Загрузка...') :
      payments.length===0 ? React.createElement('div',{className:'empty'},'Платежей пока нет') :
      React.createElement('table',null,
        React.createElement('thead',null,React.createElement('tr',null,
          ...['ID','Пользователь','План','Сумма','Статус','Дата','TX',''].map(h=>React.createElement('th',{key:h},h))
        )),
        React.createElement('tbody',null,
          payments.map(p=>React.createElement('tr',{key:p.id},
            React.createElement('td',null,React.createElement('span',{style:{color:'var(--text2)',fontSize:11}},'#'+p.id)),
            React.createElement('td',null,p.telegram_username?'@'+p.telegram_username:React.createElement('span',{className:'sol-addr'},p.telegram_chat_id||'—')),
            React.createElement('td',null,React.createElement('span',{className:'badge badge-'+(p.plan_name||'free')},p.plan_name||'—')),
            React.createElement('td',null,React.createElement('span',{style:{fontWeight:600,color:'var(--green)'}},fmtMoney(p.amount, p.currency))),
            React.createElement('td',null,React.createElement('span',{className:'badge badge-'+(p.status||'pending')},p.status)),
            React.createElement('td',null,React.createElement('span',{style:{fontSize:12}},fmtDt(p.created_at))),
            React.createElement('td',null,p.tx_signature
              ? React.createElement('a',{href:'https://solscan.io/tx/'+p.tx_signature,target:'_blank',style:{color:'var(--blue)',fontSize:11}},p.tx_signature.slice(0,12)+'…')
              : React.createElement('span',{style:{color:'var(--text2)',fontSize:11}},'—')
            ),
            React.createElement('td',null,
              React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>removeRaw(p.id)},'❌')
            )
          ))
        )
      ),
      React.createElement('div',{className:'pagination'},
        React.createElement('button',{className:'btn btn-ghost btn-sm',disabled:offset===0,onClick:()=>setOffset(Math.max(0,offset-limit))},'← Назад'),
        React.createElement('span',{style:{fontSize:12,color:'var(--text2)',padding:'4px 8px'}},Math.floor(offset/limit)+1),
        React.createElement('button',{className:'btn btn-ghost btn-sm',disabled:payments.length<limit,onClick:()=>setOffset(offset+limit)},'Далее →')
      )
    )
  );
}

// ── Pipeline flow diagram (Apify → Dedupe → Cluster → AI → Save → Alerts) ──
// Polls /api/pipeline on a short interval so active stages light up in near
// real time while the scan is running. Between cycles it shows numbers from
// the last completed cycle so the panel is never a dead ghost.
// Pipeline stages — the upstream "ai" marker is split into Stage 1 (base
// scoring, configurable provider) and Stage 2 (Grok + x_search). Both cards
// light up while currentStage is 'ai' since we don't get a sub-stage signal
// mid-call. Reminder: this whole file lives inside a template literal, so
// NEVER use backticks in comments here — they'll close the outer literal.
// Stage order mirrors src/index.js cycle. Since PR-2 the order is:
//   collect → dedupe (cheap) → prestage → cluster (multi-signal) → stage1/2 → save → alerts
// PreStage runs BEFORE the clusterer so the multi-signal similarity (embeddings,
// image hash, entity overlap) sees gemini/nano outputs at decision time.
const PIPELINE_STAGES = [
  { id: 'collect',  icon: '📡', label: 'Collect',  hint: 'Apify scrapers'                                          },
  { id: 'dedupe',   icon: '🧩', label: 'Dedupe',   hint: 'Aggregator + cheap exact-dupe collapse'                  },
  // Stage 0: text + visual enrichment (nano + gemini). Never filters/scores.
  { id: 'prestage', icon: '🎨', label: 'Stage 0',  hint: 'PreStage: gpt-5.4-nano + Gemini Flash'                   },
  { id: 'cluster',  icon: '🗂',  label: 'Cluster',  hint: 'Multi-signal: embeddings + image hash + entities + junk' },
  { id: 'stage1',   icon: '🧠', label: 'Stage 1',  hint: 'Base scoring (GPT/Grok)'                                 },
  { id: 'stage2',   icon: '🔍', label: 'Stage 2',  hint: 'Grok + x_search'                                         },
  { id: 'save',     icon: '💾', label: 'Save',     hint: 'Persist to DB'                                           },
  { id: 'alerts',   icon: '📣', label: 'Alerts',   hint: 'Telegram push'                                           },
];

// Both stage1 and stage2 cards highlight while the upstream marker is 'ai',
// because the scorer doesn't surface intra-call progress events.
const PIPELINE_AI_IDS = new Set(['stage1', 'stage2']);


function ScannersPage() {
  const [state, setState] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState('');

  const load = React.useCallback(async () => {
    try { setState(await api('/api/scanners')); }
    catch(e) { setMsg('Ошибка: ' + e.message); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  const toggleGlobal = async () => {
    try {
      const endpoint = state.paused ? '/api/scanners/resume' : '/api/scanners/pause';
      await api(endpoint, 'POST');
      setState(prev => ({ ...prev, paused: !prev.paused }));
      flash(state.paused ? '✓ Сканер запущен' : '✓ Сканер остановлен');
    } catch(e) { flash('Ошибка: ' + e.message); }
  };

  const [scanning, setScanning] = React.useState(false);
  const forceScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await api('/api/scan', 'POST');
      flash('⚡ Сканирование запущено');
    } catch(e) { flash('Ошибка: ' + e.message); }
    setTimeout(() => setScanning(false), 8000);
  };

  const toggleCollector = async (name) => {
    try {
      await api('/api/scanners/' + name + '/toggle', 'POST');
      setState(prev => ({
        ...prev,
        collectors: prev.collectors.map(c =>
          c.name === name ? { ...c, enabled: !c.enabled } : c
        )
      }));
    } catch(e) { flash('Ошибка: ' + e.message); }
  };

  if (loading) return React.createElement('div', { className: 'loading' }, 'Загрузка...');

  const paused = state?.paused;
  const collectors = state?.collectors || [];
  const enabledCount = collectors.filter(c => c.enabled).length;
  const disabledCount = collectors.length - enabledCount;

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header' },
      React.createElement('h2', null, '⚙️ Сканеры'),
      React.createElement('p', null, 'Здесь управляется сам heartbeat системы: глобальная пауза и отдельные площадки. Экран нужен для быстрых операционных действий, когда нужно отключить шумный источник или остановить весь пайплайн.')
    ),

    React.createElement('div', { className: 'cards' },
      React.createElement('div', { className: 'card green' },
        React.createElement('div', { className: 'card-label' }, 'Статус пайплайна'),
        React.createElement('div', { className: 'card-value' }, paused ? 'PAUSE' : 'LIVE'),
        React.createElement('div', { className: 'card-sub' }, paused ? 'Сбор данных и алерты остановлены' : 'Сканирование идёт по расписанию')
      ),
      React.createElement('div', { className: 'card blue' },
        React.createElement('div', { className: 'card-label' }, 'Включённых источников'),
        React.createElement('div', { className: 'card-value' }, enabledCount),
        React.createElement('div', { className: 'card-sub' }, 'Из ' + collectors.length + ' доступных площадок')
      ),
      React.createElement('div', { className: 'card yellow' },
        React.createElement('div', { className: 'card-label' }, 'Отключённых источников'),
        React.createElement('div', { className: 'card-value' }, disabledCount),
        React.createElement('div', { className: 'card-sub' }, disabledCount === 0 ? 'Все источники активны' : 'Есть площадки в ручном off режиме')
      )
    ),

    // Global scanner status bar
    React.createElement('div', { className: 'scanner-status-bar' },
      React.createElement('div', { className: 'scanner-dot ' + (paused ? 'paused' : 'running') }),
      React.createElement('div', { className: 'scanner-label' },
        React.createElement('h3', null, paused ? '⏸ Сканер остановлен' : '▶ Сканер работает'),
        React.createElement('p', null, paused
          ? 'Сбор данных приостановлен. Данные не собираются, алерты не отправляются.'
          : 'Данные собираются по расписанию. Алерты отправляются активным пользователям.')
      ),
      React.createElement('div', { style: { display: 'flex', gap: 10 } },
        React.createElement('button', {
          className: 'btn btn-primary',
          style: { padding: '10px 22px', fontSize: 14 },
          onClick: forceScan,
          disabled: scanning || paused,
          title: paused ? 'Сначала запусти сканер' : 'Принудительно запустить цикл сканирования'
        }, scanning ? '⏳ Сканирую...' : '⚡ Сканировать сейчас'),
        React.createElement('button', {
          className: 'btn ' + (paused ? 'btn-success' : 'btn-danger'),
          style: { padding: '10px 22px', fontSize: 14 },
          onClick: toggleGlobal
        }, paused ? '▶ Запустить' : '⏸ Остановить'),
      ),
    ),

    msg && React.createElement('div', {
      style: { marginBottom: 16, padding: '10px 14px', borderRadius: 8,
        background: msg.includes('Ошибка') ? 'rgba(239,68,68,.1)' : 'rgba(16,185,129,.1)',
        color: msg.includes('Ошибка') ? 'var(--red)' : 'var(--green)', fontSize: 13 }
    }, msg),

    // Pipeline flow moved to the global topbar (StatusBar) — visible from every page.

    // ── Collapsible accordions ──────────────────────────────────────────────
    // Each big section is wrapped in details with the same pcfg-accordion
    // styling as the Пресеты tab — gives the Сканеры tab matching compact /
    // collapsible feel. open defaults are tuned by access frequency:
    //   - Площадки + Конфиг сканера: open (most common ops)
    //   - PreStage / HotRefresh / JunkStats: closed by default

    // Per-platform collector cards (open — primary toggle surface)
    React.createElement('details', { className: 'pcfg-accordion', open: true },
      React.createElement('summary', { className: 'pcfg-accordion-summary' },
        React.createElement('span', null, '📡 Площадки'),
        React.createElement('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
          enabledCount + ' / ' + collectors.length + ' активны')
      ),
      React.createElement('div', { className: 'pcfg-accordion-body' },
        React.createElement('div', { className: 'collector-grid' },
          (state?.collectors || []).map(c =>
            React.createElement('div', {
              key: c.name,
              className: 'collector-card ' + (c.enabled ? 'enabled' : 'disabled')
            },
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
                React.createElement('div', null,
                  React.createElement('div', { className: 'collector-icon' }, c.icon),
                  React.createElement('div', { className: 'collector-name', style: { marginTop: 8 } }, c.label)
                ),
                React.createElement('label', { className: 'toggle' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: c.enabled,
                    onChange: () => toggleCollector(c.name)
                  }),
                  React.createElement('span', { className: 'toggle-slider' })
                )
              ),
              React.createElement('div', { className: 'collector-status ' + (c.enabled ? 'on' : 'off') },
                c.enabled ? '● Активен' : '○ Отключён'
              )
            )
          )
        )
      )
    ),

    // Scanner tuning config (presets, twitter actor, thresholds) — open: most-tweaked
    React.createElement('details', { className: 'pcfg-accordion', open: true },
      React.createElement('summary', { className: 'pcfg-accordion-summary' },
        React.createElement('span', null, '🎯 Конфиг сканера'),
        React.createElement('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
          'Пресет · Twitter actor · Stage 2 · Twitter-возраст')
      ),
      React.createElement('div', { className: 'pcfg-accordion-body' },
        React.createElement(ScannerConfigSection, null)
      )
    ),

    // PreStage (Stage 0) — closed: A/B test, rarely flipped
    React.createElement('details', { className: 'pcfg-accordion' },
      React.createElement('summary', { className: 'pcfg-accordion-summary' },
        React.createElement('span', null, '🎨 Stage 0 — PreStage'),
        React.createElement('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
          'Nano + Gemini обогащение')
      ),
      React.createElement('div', { className: 'pcfg-accordion-body' },
        React.createElement(PreStageSection, null)
      )
    ),

    // Telegram alert pacing — closed: tweaked occasionally
    React.createElement('details', { className: 'pcfg-accordion' },
      React.createElement('summary', { className: 'pcfg-accordion-summary' },
        React.createElement('span', null, '📤 Telegram alert pacing'),
        React.createElement('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
          'Per-user FIFO cooldown · 60s default')
      ),
      React.createElement('div', { className: 'pcfg-accordion-body' },
        React.createElement(AlertSchedulerSection, null)
      )
    ),

    // Hot trends refresh — closed: status display + trigger button
    React.createElement('details', { className: 'pcfg-accordion' },
      React.createElement('summary', { className: 'pcfg-accordion-summary' },
        React.createElement('span', null, '🔁 Обновление горячих трендов'),
        React.createElement('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
          'Heavy + light циклы')
      ),
      React.createElement('div', { className: 'pcfg-accordion-body' },
        React.createElement(HotRefreshSection, null)
      )
    ),

    // Junk-filter stats — closed: read-only observability
    React.createElement('details', { className: 'pcfg-accordion' },
      React.createElement('summary', { className: 'pcfg-accordion-summary' },
        React.createElement('span', null, '📊 Junk-filter наблюдение'),
        React.createElement('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
          'Что фильтруется и почему')
      ),
      React.createElement('div', { className: 'pcfg-accordion-body' },
        React.createElement(JunkStatsSection, null)
      )
    )
  );
}

// ── Scanner tuning: search preset + alert/storage thresholds ─────────────────
function ScannerConfigSection() {
  const h = React.createElement;
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api('/api/scanner-config').then(c => setCfg(c)).catch(e => setMsg('Ошибка: ' + e.message));
  }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  const set = (k, v) => setCfg(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api('/api/scanner-config', 'POST', cfg);
      setCfg(res);
      flash('✓ Конфиг сохранён');
    } catch (e) { flash('Ошибка: ' + e.message); }
    setSaving(false);
  };

  if (!cfg) return h('div', { className: 'loading' }, 'Загрузка конфига сканера...');

  const PRESETS = [
    { id: 'general',     icon: '🌐', label: 'Общий',        hint: 'Ультра-широкий поиск на всех языках' },
    { id: 'animals',     icon: '🐾', label: 'Животные',     hint: 'Вирусные питомцы, милые создания' },
    { id: 'culture',     icon: '🎭', label: 'Культура',     hint: 'Мемы, интернет-тренды, сленг' },
    { id: 'celebrities', icon: '⭐', label: 'Знаменитости', hint: 'Селебрити, музыка, кино' },
    { id: 'events',      icon: '🌍', label: 'События',      hint: 'Мировые события, спорт, AI-новости' },
  ];

  // Twitter/X scraper actors. The id must match a key in
  // src/collectors/twitter.js ACTORS + VALID_TWITTER_ACTORS in _setScannerConfig.
  const TWITTER_ACTORS = [
    {
      id: 'kaitoeasyapi',
      icon: '🏯',
      label: 'KaitoEasyAPI',
      price: '$0.25 / 1K',
      hint: 'Зрелый, 17K юзеров, 99% success. Рекомендуется по умолчанию.',
    },
    {
      id: 'xquik',
      icon: '⚡',
      label: 'Xquik',
      price: '$0.15 / 1K',
      hint: 'Новый, 1 актёр, 145 юзеров. Дешевле, но меньше истории — экспериментальный.',
    },
  ];

  // TikTok scraper actors. The id must match a key in
  // src/collectors/tiktok.js ACTORS + VALID_TIKTOK_ACTORS in _setScannerConfig.
  const TIKTOK_ACTORS = [
    {
      id: 'clockworks',
      icon: '⏱️',
      label: 'Clockworks',
      price: '$2.00 / 1K',
      hint: 'Дефолт. Зрелый, нативный hashtag-вход, надёжно отдаёт обложку и engagement.',
    },
    {
      id: 'apidojo',
      icon: '🥷',
      label: 'apidojo',
      price: '$0.30 / 1K',
      hint: 'Дешевле в ~6 раз. Видео-URL не отдаёт стабильно (header-bound), но обложку и метрики — да. Для нашего пайплайна разницы нет, мы и так используем cover.',
    },
  ];

  const row = (label, key, min, max, step, disp) => h('div', { className: 'scfg-row' },
    h('div', { className: 'scfg-row-top' },
      h('span', { className: 'scfg-label' }, label),
      h('span', { className: 'scfg-val' }, disp !== undefined ? disp : cfg[key])
    ),
    h('input', {
      type: 'range', min, max, step,
      value: cfg[key],
      onChange: e => set(key, +e.target.value),
      className: 'scfg-slider'
    })
  );

  // Body content only — outer wrapper + h3 title are rendered by the
  // accordion <summary> in ScannersPage to keep the Сканеры tab compact and
  // collapsible (matching the Пресеты tab pattern).
  return h('div', null,
    h('p', { style: { color: 'var(--muted)', fontSize: 13, marginBottom: 18 } },
      'Пресет поиска + пороги для алертов/хранения. Применяется со следующего цикла сканера.'),

    // Preset grid
    h('div', { className: 'scfg-label', style: { marginBottom: 10 } }, 'Пресет поиска'),
    h('div', { className: 'scfg-preset-grid' },
      PRESETS.map(p => h('div', {
        key: p.id,
        className: 'scfg-preset' + (cfg.activePreset === p.id ? ' active' : ''),
        onClick: () => set('activePreset', p.id)
      },
        h('div', { className: 'scfg-preset-icon' }, p.icon),
        h('div', { className: 'scfg-preset-label' }, p.label),
        h('div', { className: 'scfg-preset-hint' }, p.hint)
      ))
    ),

    // Twitter/X scraper picker — applies on next scan cycle. Each actor has
    // its own Apify token in .env (APIFY_API_KAITO / APIFY_API_XQUIK).
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🐦 Twitter/X scraper'),
      h('p', { className: 'scfg-desc' },
        'Какой Apify-актёр будет скрейпить X. Переключение применяется со следующего цикла. ' +
        'Оба возвращают одинаковый формат (viewCount, likeCount, retweetCount) — переключать безопасно.'),
      h('div', { className: 'scfg-preset-grid' },
        TWITTER_ACTORS.map(a => h('div', {
          key: a.id,
          className: 'scfg-preset' + (cfg.twitterActor === a.id ? ' active' : ''),
          onClick: () => set('twitterActor', a.id),
        },
          h('div', { className: 'scfg-preset-icon' }, a.icon),
          h('div', { className: 'scfg-preset-label' },
            a.label,
            h('span', { style: { marginLeft: 6, fontSize: 11, color: 'var(--muted)', fontWeight: 400 } }, a.price)
          ),
          h('div', { className: 'scfg-preset-hint' }, a.hint)
        ))
      )
    ),

    // TikTok scraper picker — same UX as Twitter. Each actor has its own
    // Apify token (APIFY_API for clockworks default, APIFY_API_APIDOJO for the
    // cheaper apidojo). Output fields differ slightly but the collector
    // _normalize chain absorbs both.
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🎵 TikTok scraper'),
      h('p', { className: 'scfg-desc' },
        'Какой Apify-актёр будет скрейпить TikTok. Переключение применяется со следующего цикла. ' +
        'Поля engagement (plays/likes/comments/shares) одинаковые — переключать безопасно. ' +
        'Видео-файл напрямую мы не используем ни у одного актёра — берём только обложку и ссылку на пост.'),
      h('div', { className: 'scfg-preset-grid' },
        TIKTOK_ACTORS.map(a => h('div', {
          key: a.id,
          className: 'scfg-preset' + (cfg.tiktokActor === a.id ? ' active' : ''),
          onClick: () => set('tiktokActor', a.id),
        },
          h('div', { className: 'scfg-preset-icon' }, a.icon),
          h('div', { className: 'scfg-preset-label' },
            a.label,
            h('span', { style: { marginLeft: 6, fontSize: 11, color: 'var(--muted)', fontWeight: 400 } }, a.price)
          ),
          h('div', { className: 'scfg-preset-hint' }, a.hint)
        ))
      )
    ),

    // ── Per-preset knobs moved to "🎛️ Пресеты" tab (PR-2 of preset-configs)
    // Alerts thresholds + weights + stale decay + junk filter + cluster
    // similarity all live in settings.presetConfigs now and are edited
    // per-preset. This banner replaces 4 large sub-sections that used to
    // edit those values globally.
    h('div', { className: 'scfg-section', style: { padding: 14, background: 'rgba(20,184,166,.06)', borderRadius: 8, border: '1px dashed var(--border3)' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 } },
        h('span', { style: { fontSize: 22 } }, '🎛️'),
        h('div', null,
          h('div', { style: { fontWeight: 600, marginBottom: 4 } },
            'Алерты, веса, stale-decay, junk и cluster — теперь в табе «Пресеты»'),
          h('div', { style: { color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 } },
            'Per-preset с 2026-05-01: каждый пресет (general/animals/culture/celebrities/events) ' +
            'хранит свой набор alertThreshold / alertWeight* / staleDecay* / junk-penalties / cluster-similarity. ' +
            'Активный пресет переключается выше, его настройки применяются на следующем цикле.')
        )
      )
    ),

    // Cycle intervals — runtime-tunable scan & TikTok cadence. Slider change
    // applies on the NEXT cycle (no restart). Min/max clamps match the
    // _setScannerConfig validator and runtime fallback paths in index.js +
    // collectors/tiktok.js — keep them in sync if you widen here.
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '⏱️ Интервалы циклов'),
      h('p', { className: 'scfg-desc' },
        'Как часто запускаются сборщики. Главный scan-cycle гонит collect → score → alerts ' +
        'для Reddit / Twitter / Google / X Trends. TikTok идёт отдельным time-gated циклом ' +
        '(дороже по Apify, поэтому реже). Изменения применяются на СЛЕДУЮЩЕМ цикле, без рестарта.'),
      row('🔁 Главный scan-cycle (мин)', 'scanIntervalMinutes', 5, 60, 5,
          cfg.scanIntervalMinutes + 'min'),
      row('🎵 TikTok cycle (мин)',        'tiktokCycleIntervalMinutes', 10, 120, 5,
          cfg.tiktokCycleIntervalMinutes + 'min'),
      h('div', { style: { marginTop: 8, fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 } },
        '💡 5 мин scan — агрессивно, ловим хайп быстро, но Apify-расход ×3 от дефолта. ' +
        '15 мин — рекомендуется. 30+ мин — экономия, но риск пропустить короткоживущие тренды. ' +
        'TikTok 10 мин — дорого ($2/1K у clockworks). 30 мин — дефолт. 60+ мин — экономия для тихих ниш.'
      ),
    ),

    // Twitter age filter — orthogonal collector knob, stays global.
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🐦 Twitter — фильтр по возрасту'),
      h('p', { className: 'scfg-desc' },
        'Твиты старше указанного числа часов отбрасываются на входе. ' +
        '0 = фильтр выключен. Рекомендуется 72 — ловим ре-игниты последних 3 суток, ' +
        'не засоряем пайплайн старьём.'),
      row('⏳ Макс. возраст твита (часов)', 'twitterMaxAgeHours', 0, 720, 12,
          cfg.twitterMaxAgeHours === 0 ? '0 (off)' : cfg.twitterMaxAgeHours + 'h'),
    ),

    // TikTok age filter — TikTok /tag/<x> page surfaces evergreen videos
    // alongside fresh trends, so we cap age explicitly. Default 7d.
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🎵 TikTok — фильтр по возрасту'),
      h('p', { className: 'scfg-desc' },
        'Видео старше указанного числа дней отбрасываются на входе. ' +
        '0 = фильтр выключен. Рекомендуется 7 — TikTok тег-страница часто ' +
        'подсовывает evergreen-ролики 2023 года, они проходят engagement-floor ' +
        'и прилетают как свежий тренд.'),
      row('⏳ Макс. возраст видео (дней)', 'tiktokMaxAgeDays', 0, 60, 1,
          cfg.tiktokMaxAgeDays === 0 ? '0 (off)' : cfg.tiktokMaxAgeDays + 'd'),
    ),

    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🔁 Ре-анализ уже обработанных постов'),
      h('p', { className: 'scfg-desc' },
        'Если тот же URL возвращается в фид, пост прогоняется через AI заново — ' +
        'если engagement вырос, он может пройти алерт-фильтр. Ре-анализ делается ' +
        'только если: (1) пост ещё никому не уходил алертом и (2) прошло ≥ N часов ' +
        'с прошлого ре-скора. 0 = выключено (посты блокируются навсегда после первого скоринга).'),
      row('🕒 Cooldown между ре-анализами (часов)', 'rescoreCooldownHours', 0, 168, 1,
          cfg.rescoreCooldownHours === 0 ? '0 (off)' : cfg.rescoreCooldownHours + 'h'),
    ),

    // AI Stage 2 — deep-dive via x_search (Grok)
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🧪 AI Stage 2 · x_search deep-dive'),
      h('p', { className: 'scfg-desc' },
        'Stage 2 = Grok + живой поиск по X. Запускается на топ-N трендов с memePotential ≥ порога. ' +
        'Результат: свежая оценка buzz + штраф за weak xBuzz (×0.5) и saturated coins 3+ (×0.7). ' +
        'Каждый вызов стоит денег (x_search) — держи cap разумным и следи за счётом xAI.'),
      row('🎯 Порог входа (memePotential ≥)', 'stage2Threshold', 0, 100, 5),
      row('⚡ Макс. вызовов за цикл (cap)',    'stage2MaxCalls',  0, 20, 1,
          cfg.stage2MaxCalls === 0 ? '0 (off)' : cfg.stage2MaxCalls),
      h('div', { style: { marginTop: 8, fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 } },
        '💡 Порог 78 / cap 3 — консервативно (старый дефолт). ' +
        'Порог 60 / cap 6 — рекомендовано: Stage 2 срабатывает ~70% циклов. ' +
        'Порог 50 / cap 10 — агрессивно: Stage 2 как основной скорер. ' +
        'Cap = 0 полностью выключает Stage 2 (дешевле через тумблер aiStage2Enabled в AI-секции).'
      ),
    ),

    // Storage floor (minScoreToSave) moved to per-preset in PR-2 — see "Пресеты" tab.

    msg && h('div', {
      style: { marginTop: 14, padding: '10px 14px', borderRadius: 8,
        background: msg.includes('Ошибка') ? 'rgba(239,68,68,.1)' : 'rgba(16,185,129,.1)',
        color: msg.includes('Ошибка') ? 'var(--red)' : 'var(--green)', fontSize: 13 }
    }, msg),

    h('div', { style: { marginTop: 16, display: 'flex', justifyContent: 'flex-end' } },
      h('button', {
        className: 'btn btn-primary',
        onClick: save, disabled: saving,
        style: { padding: '10px 20px' }
      }, saving ? '⏳ Сохраняю...' : '💾 Сохранить конфиг')
    )
  );
}

// ── Stage 0 / PreStage controls ─────────────────────────────────────────────
//
// Currently shows a single toggle for the gpt-5.4-nano text-enrichment
// sub-stage. Set up as part of an A/B test (2026-04-29) — we suspect Stage 1
// (gpt-5.4-mini) does most of nano's work natively (slang decoding, entity
// canonicalisation, paraphrasing) and the only unique signal nano adds is
// cross-language entity overlap for the clusterer (~20% of similarity weight).
//
// Toggling this flips a DB setting that NanoClassifier consults at the start
// of each batch — applies on the very next cycle without restart. After ~7
// days of running with nano OFF, compare cluster quality + Stage 1 score
// distribution against the pre-toggle baseline, then decide whether to keep
// or drop nano permanently.
function PreStageSection() {
  const h = React.createElement;
  const [nanoEnabled, setNanoEnabled] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    // MUST use api() helper — bare fetch() skips the X-Admin-Key header and
    // gets 401'd, leaving nanoEnabled stuck at its initial value (so UI looks
    // like a working toggle but DB never gets the '0' write, and nano keeps
    // running on every cycle / manual analysis).
    api('/api/prestage/nano')
      .then(d => setNanoEnabled(!!d.enabled))
      .catch(e => setErr('Не удалось загрузить статус: ' + e.message));
  }, []);

  const toggleNano = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const d = await api('/api/prestage/nano/toggle', 'POST');
      setNanoEnabled(!!d.enabled);
    } catch (e) {
      setErr('Не удалось переключить: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  // Body content only — wrapper + title rendered by the accordion summary.
  return h('div', null,
    h('p', {
      style: { fontSize: 12, color: 'var(--text3)', marginBottom: 16, lineHeight: 1.5 }
    }, 'Подготовка контекста перед скорингом. Текущий A/B: проверяем нужен ли nano-классификатор или Stage 1 (gpt-5.4-mini) справляется сам.'),

    h('div', {
      className: 'collector-grid',
      style: { gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }
    },
      // Nano card — the actual A/B-test toggle
      h('div', {
        className: 'collector-card ' + (nanoEnabled ? 'enabled' : 'disabled')
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
          h('div', null,
            h('div', { className: 'collector-icon' }, '📝'),
            h('div', { className: 'collector-name', style: { marginTop: 8 } }, 'Nano (gpt-5.4-nano)')
          ),
          // Render the toggle ONLY after we have a definitive state — keeps
          // the slider from flickering through "off → on" on first paint.
          nanoEnabled !== null && h('label', { className: 'toggle' },
            h('input', {
              type: 'checkbox',
              checked: nanoEnabled,
              disabled: busy,
              onChange: toggleNano
            }),
            h('span', { className: 'toggle-slider' })
          )
        ),
        h('div', {
          className: 'collector-status ' + (nanoEnabled ? 'on' : 'off'),
          style: { marginTop: 12 }
        },
          nanoEnabled === null ? '○ Загрузка...'
            : nanoEnabled       ? '● Активен — обогащает текст перед Stage 1'
                                : '○ Отключён — Stage 1 видит только сырые title+description'
        ),
        h('div', {
          style: { fontSize: 11, color: 'var(--text3)', marginTop: 10, lineHeight: 1.5 }
        },
          'Выход: topicSummary, entityCanonical, slangDecoded, language. ',
          'Применяется на следующем цикле без перезапуска.'
        )
      ),

      // Gemini card — read-only status, no toggle (gemini fails over to
      // OpenRouter automatically; "disable" doesn't make sense as a button).
      // Shown for symmetry so the section reflects the full Stage 0.
      h('div', {
        className: 'collector-card enabled',
        style: { opacity: 0.85 }
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
          h('div', null,
            h('div', { className: 'collector-icon' }, '🖼️'),
            h('div', { className: 'collector-name', style: { marginTop: 8 } }, 'Gemini Vision')
          ),
          h('span', {
            style: { fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px' }
          }, 'auto')
        ),
        h('div', { className: 'collector-status on', style: { marginTop: 12 } },
          '● Google direct → OpenRouter fallback'
        ),
        h('div', {
          style: { fontSize: 11, color: 'var(--text3)', marginTop: 10, lineHeight: 1.5 }
        },
          'Описывает картинки и видео. Без выключателя — деградирует автоматически при сбое API.'
        )
      )
    ),

    err && h('div', {
      style: {
        marginTop: 14, padding: '10px 14px', borderRadius: 8,
        background: 'rgba(239,68,68,.1)', color: 'var(--red)', fontSize: 13
      }
    }, err)
  );
}


// ── AlertSchedulerSection — per-user FIFO cooldown queue admin UI ───────────
// Wraps the /api/alert-scheduler endpoints. Three knobs (enabled toggle,
// cooldown seconds, queue cap) plus a live stats table that auto-refreshes
// every 5 seconds while the section is mounted. The settings are persisted
// in the DB (settings table) and the running scheduler reads them per-tick,
// so changes take effect within ~5 seconds without a restart.
function AlertSchedulerSection() {
  const h = React.createElement;
  const [data, setData]   = useState(null);   // { cfg, stats }
  const [draft, setDraft] = useState(null);   // editable copy of cfg
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');
  const [msg, setMsg]     = useState('');

  const load = async () => {
    try {
      const d = await api('/api/alert-scheduler');
      setData(d);
      // Only seed draft from server on first load — otherwise we'd stomp the
      // user's in-progress edits every time the auto-refresh tick fires.
      setDraft(prev => prev || { ...d.cfg });
    } catch (e) {
      setErr('Не удалось загрузить: ' + e.message);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const save = async () => {
    if (!draft) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const d = await api('/api/alert-scheduler', 'POST', draft);
      setData(prev => ({ ...(prev || {}), cfg: d.cfg }));
      setDraft({ ...d.cfg });
      setMsg('Сохранено');
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setErr('Не удалось сохранить: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const flash = (text, color) => h('span', {
    style: { fontSize: 11, color, marginLeft: 10, fontWeight: 600 }
  }, text);

  // Helper: format ms as human-readable.
  const fmtMs = (ms) => {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60_000) return Math.round(ms / 100) / 10 + 's';
    if (ms < 3_600_000) return Math.round(ms / 6000) / 10 + 'min';
    return Math.round(ms / 360_000) / 10 + 'h';
  };

  if (!data || !draft) {
    return h('div', { style: { padding: 12, color: 'var(--text3)', fontSize: 13 } },
      err || 'Загрузка...');
  }

  const stats = data.stats || null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.cfg);

  return h('div', null,
    h('p', {
      style: { fontSize: 12, color: 'var(--text3)', marginBottom: 14, lineHeight: 1.5 }
    },
      'Очередь FIFO на каждого пользователя. Между алертами одному и тому же чату — кулдаун. ',
      'Чужие очереди независимы. Manual-submit (кнопка "📨 Отправить" на SubmitPage) идёт мимо очереди — мгновенно.'
    ),

    // ── Settings card ──────────────────────────────────────────────────────
    h('div', {
      style: {
        padding: '14px 16px', borderRadius: 10,
        background: 'var(--bg2)', border: '1px solid var(--border)',
        marginBottom: 12,
      }
    },
      // Enabled toggle row
      h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }
      },
        h('div', null,
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'Включён'),
          h('div', { style: { fontSize: 11, color: 'var(--text3)', marginTop: 2 } },
            'Когда выключен — алерты летят синхронно (старое поведение).')
        ),
        h('label', { className: 'toggle' },
          h('input', {
            type: 'checkbox',
            checked: draft.enabled,
            disabled: busy,
            onChange: e => setDraft(prev => ({ ...prev, enabled: e.target.checked })),
          }),
          h('span', { className: 'toggle-slider' })
        )
      ),

      // Sliders row
      h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 14,
          opacity: draft.enabled ? 1 : 0.4,
          pointerEvents: draft.enabled ? 'auto' : 'none',
        }
      },
        // Cooldown seconds
        h('div', null,
          h('div', { style: { fontSize: 12, color: 'var(--text2)', marginBottom: 6 } },
            'Кулдаун: ', h('b', null, Math.round(draft.cooldownMs / 1000)), 's'
          ),
          h('input', {
            type: 'range', min: 0, max: 300, step: 5,
            value: Math.round(draft.cooldownMs / 1000),
            disabled: busy,
            onChange: e => setDraft(prev => ({ ...prev, cooldownMs: Number(e.target.value) * 1000 })),
            style: { width: '100%' }
          }),
          h('div', { style: { fontSize: 10, color: 'var(--text3)', marginTop: 4 } },
            '0 = без задержки. 60s = по умолчанию.')
        ),
        // Cap
        h('div', null,
          h('div', { style: { fontSize: 12, color: 'var(--text2)', marginBottom: 6 } },
            'Макс. в очереди на юзера: ', h('b', null, draft.cap)
          ),
          h('input', {
            type: 'range', min: 1, max: 100, step: 1,
            value: draft.cap,
            disabled: busy,
            onChange: e => setDraft(prev => ({ ...prev, cap: Number(e.target.value) })),
            style: { width: '100%' }
          }),
          h('div', { style: { fontSize: 10, color: 'var(--text3)', marginTop: 4 } },
            'Сверх лимита — drop oldest. По умолчанию 20.')
        ),
        // Max age minutes
        h('div', null,
          h('div', { style: { fontSize: 12, color: 'var(--text2)', marginBottom: 6 } },
            'Макс. возраст в очереди: ', h('b', null, Math.round(draft.maxAgeMs / 60_000)), 'min'
          ),
          h('input', {
            type: 'range', min: 1, max: 120, step: 1,
            value: Math.round(draft.maxAgeMs / 60_000),
            disabled: busy,
            onChange: e => setDraft(prev => ({ ...prev, maxAgeMs: Number(e.target.value) * 60_000 })),
            style: { width: '100%' }
          }),
          h('div', { style: { fontSize: 10, color: 'var(--text3)', marginTop: 4 } },
            'Старше — drop без отправки. По умолчанию 30 min.')
        )
      ),

      // Save row
      h('div', { style: { marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 } },
        h('button', {
          className: 'btn ' + (dirty ? 'btn-primary' : 'btn-ghost'),
          disabled: busy || !dirty,
          onClick: save
        }, busy ? 'Сохраняю...' : (dirty ? 'Сохранить' : 'Без изменений')),
        dirty && h('button', {
          className: 'btn btn-ghost btn-sm',
          disabled: busy,
          onClick: () => setDraft({ ...data.cfg })
        }, 'Откатить'),
        msg && flash('✓ ' + msg, 'var(--green)'),
        err && flash('✗ ' + err, 'var(--red)')
      )
    ),

    // ── Live stats card ─────────────────────────────────────────────────────
    stats && h('div', {
      style: {
        padding: '14px 16px', borderRadius: 10,
        background: 'var(--bg2)', border: '1px solid var(--border)',
      }
    },
      h('div', { style: { fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 10, letterSpacing: '.3px' } },
        '📊 LIVE STATS'),
      h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 10, marginBottom: 12,
        }
      },
        [
          { label: 'В очереди',         val: stats.totalQueued },
          { label: 'Активных юзеров',   val: stats.activeUsers },
          { label: 'Sent',              val: stats.metrics?.sentTotal ?? 0 },
          { label: 'Dropped (full)',    val: stats.metrics?.droppedFullTotal ?? 0 },
          { label: 'Dropped (stale)',   val: stats.metrics?.droppedStaleTotal ?? 0 },
          { label: 'Dropped (paused)',  val: stats.metrics?.droppedPausedTotal ?? 0 },
          { label: 'Errors',            val: stats.metrics?.taskErrors ?? 0 },
        ].map((s, i) => h('div', {
          key: i,
          style: { padding: '8px 12px', borderRadius: 6, background: 'rgba(255,255,255,.03)', textAlign: 'center' }
        },
          h('div', { style: { fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' } }, s.label),
          h('div', { style: { fontSize: 18, fontWeight: 700, marginTop: 4 } }, String(s.val))
        ))
      ),

      stats.perUser && stats.perUser.length > 0 && h('div', null,
        h('div', { style: { fontSize: 11, color: 'var(--text3)', marginBottom: 6 } },
          'Per-user (top ' + stats.perUser.length + '):'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          stats.perUser.map(u => h('div', {
            key: u.chatId,
            style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 8px', borderRadius: 4, background: 'rgba(255,255,255,.02)' }
          },
            h('span', { style: { fontFamily: 'monospace' } }, '@' + u.chatId),
            h('span', null,
              h('b', null, u.count), ' алерт(ов) · oldest ', fmtMs(u.oldestAgeMs),
              ' · cooldown left ', fmtMs(u.cooldownLeftMs)
            )
          ))
        )
      )
    )
  );
}


// ── Hot trends refresh toggle ───────────────────────────────────────────────
// Periodic re-fetch + re-score loop for recent borderline trends. Lives in
// src/refresh/hot-metrics.js and runs every HOT_REFRESH_INTERVAL_MINUTES (env,
// default 120). Re-fetches live engagement metrics from source (free — fxtwitter
// for Twitter, reddit json for Reddit), then re-runs Stage 1 + Stage 2 so a
// borderline trend that's accumulating views can "ripen" past stage2Threshold.
//
// Toggle reads the DB setting hotRefreshEnabled on every cycle entry, so
// flipping this here applies on the very next scheduled cycle without restart.
function HotRefreshSection() {
  const h = React.createElement;
  const [enabled, setEnabled] = useState(null); // null = loading
  const [status, setStatus]   = useState(null); // last-run summary + running flag
  const [busy, setBusy]       = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr]         = useState('');
  const [msg, setMsg]         = useState('');
  // Tick state forces re-render every 30s so the "last run X min ago" stamp
  // stays current without re-fetching the API.
  const [, tick] = useState(0);

  const refresh = () => {
    api('/api/hot-refresh')
      .then(d => {
        setEnabled(!!d.enabled);
        setStatus(d.status || null);
      })
      .catch(e => setErr('Не удалось загрузить статус: ' + e.message));
  };

  useEffect(() => {
    // Bare fetch() drops the X-Admin-Key header → 401 → toggle stuck. Use
    // the api() helper. Same trap as PreStageSection.
    refresh();
    // Poll status every 60s — covers the case where the scheduled cycle
    // fires while the admin tab is open.
    const poll = setInterval(refresh, 60000);
    // Force re-render every 30s so the relative "X min ago" updates.
    const tickTimer = setInterval(() => tick(t => t + 1), 30000);
    return () => { clearInterval(poll); clearInterval(tickTimer); };
  }, []);

  const toggle = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const d = await api('/api/hot-refresh/toggle', 'POST');
      setEnabled(!!d.enabled);
    } catch (e) {
      setErr('Не удалось переключить: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (running) return;
    setRunning(true); setErr(''); setMsg('');
    try {
      const d = await api('/api/hot-refresh/run', 'POST');
      const r = d.result || {};
      if (r.eligible === 0) {
        setMsg('Цикл прошёл, но eligible-трендов нет (≤24ч + memePotential≥50).');
      } else {
        setMsg('Готово: обработано ' + r.fetchOk + '/' + r.eligible
             + ', Stage 2: ' + (r.stage2Hits || 0)
             + ', сохранено: ' + r.saved
             + ', алертов отправлено: ' + (r.alertsSent || 0)
             + ', ' + r.tookSec + 'с');
      }
      refresh();
    } catch (e) {
      // 409 → уже бежит, 503 → не подключён, остальное → реальная ошибка
      const msg = e.message || String(e);
      if (/already-running/.test(msg))      setErr('Цикл уже выполняется — подожди завершения');
      else if (/not wired/.test(msg))       setErr('hot-refresher не подключён к админке (рестарт нужен)');
      else                                  setErr('Не удалось запустить цикл: ' + msg);
    } finally {
      setRunning(false);
    }
  };

  // ── Format helpers ────────────────────────────────────────────────────────
  const fmtAgo = (iso) => {
    if (!iso) return '—';
    const t = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
    if (!Number.isFinite(t)) return '—';
    const diff = Date.now() - t;
    if (diff < 0)               return 'через секунду';
    if (diff < 60_000)          return Math.floor(diff / 1000) + 'с назад';
    if (diff < 3_600_000)       return Math.floor(diff / 60_000) + 'м назад';
    if (diff < 86_400_000)      return Math.floor(diff / 3_600_000) + 'ч ' + Math.floor((diff % 3_600_000) / 60_000) + 'м назад';
    return Math.floor(diff / 86_400_000) + 'д назад';
  };
  const fmtDue = (iso) => {
    if (!iso) return '—';
    const t = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
    if (!Number.isFinite(t)) return '—';
    const diff = t - Date.now();
    if (diff <= 0)              return 'в любой момент';
    if (diff < 60_000)          return 'через ' + Math.floor(diff / 1000) + 'с';
    if (diff < 3_600_000)       return 'через ' + Math.floor(diff / 60_000) + 'м';
    return 'через ' + Math.floor(diff / 3_600_000) + 'ч ' + Math.floor((diff % 3_600_000) / 60_000) + 'м';
  };

  const lastRunAt = status?.lastRunAt || null;
  const lastResult = status?.lastResult || null;
  const nextRunAt = status?.nextRunAt || null;
  const intervalMin = status?.intervalMin || 120;
  const isRunning = !!status?.running;

  // Body content only — wrapper + title rendered by the accordion summary.
  return h('div', null,
    h('p', {
      style: { fontSize: 12, color: 'var(--text3)', marginBottom: 16, lineHeight: 1.5 }
    },
      'Каждые ', intervalMin, ' минут пере-фетчит метрики (views/likes/...) свежих трендов (≤24ч, memePotential≥50, Reddit + Twitter), ',
      'затем заново прогоняет Stage 1 + Stage 2. Бордерлайн-тренды, которые набирают виральность после первого скоринга, могут «дозреть» до Stage 2 и стать алертом. ',
      'Источники бесплатные (fxtwitter / reddit json) — главная статья cost — Stage 1 LLM (~$3/мес) + редкие Stage 2 (cap уже стоит).'
    ),

    h('div', {
      className: 'collector-grid',
      style: { gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }
    },
      h('div', {
        className: 'collector-card ' + (enabled ? 'enabled' : 'disabled')
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
          h('div', null,
            h('div', { className: 'collector-icon' }, '🔁'),
            h('div', { className: 'collector-name', style: { marginTop: 8 } }, 'Hot refresh loop')
          ),
          enabled !== null && h('label', { className: 'toggle' },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              disabled: busy,
              onChange: toggle
            }),
            h('span', { className: 'toggle-slider' })
          )
        ),
        h('div', {
          className: 'collector-status ' + (enabled ? 'on' : 'off'),
          style: { marginTop: 12 }
        },
          enabled === null ? '○ Загрузка...'
            : enabled       ? '● Активен — каждые ' + intervalMin + 'мин пере-скорит до 100 трендов'
                            : '○ Отключён — тренды скорятся только один раз при сборе'
        ),

        // Last run + next run rows. Shown only when we have a status payload.
        // If lastRunAt is null (process just started, never ran yet) we say so
        // honestly rather than misleading "0 минут назад".
        status && h('div', {
          style: { marginTop: 14, padding: '10px 12px', background: 'rgba(255,255,255,.02)', borderRadius: 6, border: '1px solid var(--border)' }
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 } },
            h('span', { style: { color: 'var(--text3)' } }, 'Последний цикл'),
            h('span', { style: { color: 'var(--text)', fontWeight: 600 } },
              isRunning ? '⏳ выполняется...' : (lastRunAt ? fmtAgo(lastRunAt) : 'ещё не запускался')
            )
          ),
          enabled && nextRunAt && !isRunning && h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 } },
            h('span', { style: { color: 'var(--text3)' } }, 'Следующий по расписанию'),
            h('span', { style: { color: 'var(--text2)' } }, fmtDue(nextRunAt))
          ),

          // Last cycle stats — only render if we have a meaningful result.
          lastResult && h('div', { style: { marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 11 } },
              h('span', { style: { color: 'var(--text3)' } }, 'Eligible'),
              h('span', { style: { color: 'var(--text)' } }, String(lastResult.eligible || 0)),
              h('span', { style: { color: 'var(--text3)' } }, 'Подгружено'),
              h('span', { style: { color: 'var(--text)' } },
                (lastResult.fetchOk || 0) + '/' + (lastResult.eligible || 0)
                + (lastResult.fetchFail ? ' (fail: ' + lastResult.fetchFail + ')' : '')
              ),
              h('span', { style: { color: 'var(--text3)' } }, 'Stage 2'),
              h('span', { style: { color: 'var(--text)' } }, String(lastResult.stage2Hits || 0)),
              h('span', { style: { color: 'var(--text3)' } }, 'Сохранено'),
              h('span', { style: { color: 'var(--text)' } }, String(lastResult.saved || 0)),
              h('span', { style: { color: 'var(--text3)' } }, 'Алертов отправлено'),
              h('span', { style: { color: lastResult.alertsSent > 0 ? 'var(--green2, #22c55e)' : 'var(--text)', fontWeight: lastResult.alertsSent > 0 ? 600 : 400 } }, String(lastResult.alertsSent || 0)),
              h('span', { style: { color: 'var(--text3)' } }, 'Длительность'),
              h('span', { style: { color: 'var(--text)' } }, (lastResult.tookSec || 0) + 'с'),
              h('span', { style: { color: 'var(--text3)' } }, 'Триггер'),
              h('span', { style: { color: 'var(--text2)' } }, lastResult.trigger === 'manual' ? '🖐 ручной' : '⏰ по расписанию'),
            ),
            lastResult.error && h('div', {
              style: { marginTop: 6, padding: '6px 8px', background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 4, color: '#f87171', fontSize: 11 }
            }, '⚠ ' + lastResult.error)
          )
        ),

        h('button', {
          className: 'btn btn-primary',
          style: { marginTop: 12, width: '100%', padding: '8px 12px', fontSize: 13 },
          disabled: running || isRunning || enabled === false,
          onClick: runNow,
        },
          running || isRunning ? '⏳ Цикл выполняется...' : '▶ Запустить цикл сейчас'
        ),

        msg && h('div', {
          style: { marginTop: 8, padding: '8px 10px', background: 'rgba(16,185,129,.08)', border: '1px solid rgba(16,185,129,.25)', borderRadius: 6, fontSize: 11, color: '#34d399' }
        }, msg),

        h('div', {
          style: { fontSize: 11, color: 'var(--text3)', marginTop: 10, lineHeight: 1.5 }
        },
          'Eligibility: ≤24ч + memePotential≥50 + source ∈ {reddit, twitter}. ',
          'Cap: 100 трендов на цикл. ',
          'Если после re-score alertScore пробил порог — алерт уйдёт через обычный alert-loop.'
        )
      )
    ),

    err && h('div', { className: 'error', style: { marginTop: 12 } }, err)
  );
}

// ── Junk-filter observation panel ────────────────────────────────────────────
// "What is junk-filter actually filtering out?" Shows top reasons over last N
// hours plus basic counts. Auto-refreshes so you can watch behaviour live.
const JUNK_REASON_LABELS = {
  'politics':          { color: '#ef4444', label: 'Политика' },
  'kpop/fandom':       { color: '#a855f7', label: 'K-pop / фандом' },
  'celeb-noise':       { color: '#f59e0b', label: 'Celeb-noise' },
  'no-meme-shape':     { color: '#64748b', label: 'Нет meme-shape' },
  'safe-override':     { color: '#14b8a6', label: 'Safe-override (регулятор)' },
};

function JunkStatsSection() {
  const h = React.createElement;
  const [hours, setHours]   = useState(24);
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api('/api/junk-stats?hours=' + hours)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(load, [hours]);
  useEffect(() => {
    const iv = setInterval(load, 30_000); // refresh every 30s
    return () => clearInterval(iv);
    // eslint-disable-next-line
  }, [hours]);

  // Body content only — wrapper + title rendered by the accordion summary.
  // The hour-range picker stays here (it's an inline control, not a header).
  return h('div', null,
    h('div', {
      style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }
    },
      h('div', { style: { display: 'flex', gap: 4 } },
        [6, 24, 72, 168].map(hrs =>
          h('button', {
            key: hrs,
            onClick: () => setHours(hrs),
            style: {
              padding: '6px 10px', borderRadius: 6, fontSize: 12,
              background: hours === hrs ? 'var(--accent)' : 'transparent',
              color:      hours === hrs ? '#fff' : 'var(--text)',
              border: '1px solid ' + (hours === hrs ? 'var(--accent)' : 'var(--border)'),
              cursor: 'pointer', fontWeight: hours === hrs ? 700 : 500,
            },
          }, hrs < 24 ? hrs + 'ч' : hrs === 24 ? '24ч' : hrs === 72 ? '3д' : '7д')
        )
      )
    ),
    h('p', { style: { color: 'var(--muted)', fontSize: 13, marginBottom: 16 } },
      'Что чаще всего помечает junk-filter за выбранное окно. Обновляется каждые 30с.'
    ),

    loading && !data ? h('div', { className: 'loading' }, 'Загрузка статистики...') :
    !data ? h('div', { className: 'empty' }, 'Нет данных') :
    h('div', null,
      // ── Summary tiles ──
      h('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 18 }
      },
        [
          { label: 'Трендов за окно', value: data.totalTrends, color: 'var(--text)' },
          { label: 'Со штрафом', value: data.trendsWithPenalty + ' (' + (data.totalTrends ? Math.round(data.trendsWithPenalty * 100 / data.totalTrends) : 0) + '%)', color: 'var(--red)' },
          { label: 'Ø штраф', value: data.avgPenalty, color: 'var(--accent)' },
          { label: 'Max штраф', value: data.maxPenalty, color: '#f59e0b' },
          { label: 'Meme-shape signals', value: data.memeShapeHits + ' (' + data.memeShapePct + '%)', color: 'var(--green)' },
        ].map((tile, i) => h('div', {
          key: i,
          style: {
            padding: '10px 12px', borderRadius: 8,
            background: 'var(--bg2)', border: '1px solid var(--border)',
          },
        },
          h('div', { style: { fontSize: 11, color: 'var(--muted)', marginBottom: 4 } }, tile.label),
          h('div', { style: { fontSize: 18, fontWeight: 700, color: tile.color } }, String(tile.value))
        ))
      ),

      // ── Reason breakdown bars ──
      h('h4', { style: { marginTop: 8, marginBottom: 10, fontSize: 14 } }, 'Топ причин'),
      data.topReasons.length === 0
        ? h('div', { className: 'empty', style: { padding: 12 } }, 'За это окно ничего не отфильтровано 🎉')
        : h('div', null,
            data.topReasons.map(r => {
              const meta = JUNK_REASON_LABELS[r.reason] || { color: '#94a3b8', label: r.reason };
              const pct  = Math.max(2, Math.min(100, r.pctOfTotal));
              return h('div', { key: r.reason, style: { marginBottom: 8 } },
                h('div', {
                  style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }
                },
                  h('span', { style: { color: meta.color, fontWeight: 600 } }, meta.label),
                  h('span', { style: { color: 'var(--muted)' } },
                    r.count + ' (' + r.pctOfTotal + '% всех)'
                  )
                ),
                h('div', {
                  style: {
                    height: 6, borderRadius: 3, background: 'var(--bg2)',
                    border: '1px solid var(--border)', overflow: 'hidden',
                  },
                },
                  h('div', {
                    style: {
                      height: '100%', width: pct + '%',
                      background: meta.color, transition: 'width .3s',
                    }
                  })
                )
              );
            })
          ),

      // ── Source mix ──
      Object.keys(data.sourceCounts).length > 0 && h('div', { style: { marginTop: 18 } },
        h('h4', { style: { marginBottom: 8, fontSize: 14 } }, 'Разбивка по источникам'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          Object.entries(data.sourceCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([src, cnt]) => h('span', {
              key: src,
              style: {
                padding: '4px 10px', borderRadius: 14, fontSize: 12,
                background: 'var(--bg2)', border: '1px solid var(--border)',
              },
            }, src + ': ' + cnt))
        )
      )
    )
  );
}

// ── Alert Decisions page — per-trend verdicts from the gate ──────────────────
// Minimalist list: one card per trend, with gates + score breakdown + source link.
// Reason vocabulary (must match index.js recordAlertDecision calls):
//   sent, send_failed, threshold, hard_junk, source, dedup, daily, cap
const DECISION_LABELS = {
  sent:        { color: 'var(--green)', text: '✓ Отправлено' },
  threshold:   { color: 'var(--red)',   text: '↓ Ниже порога' },
  hard_junk:   { color: 'var(--red)',   text: '🗑️ Hard-junk' },
  source:      { color: 'var(--muted)', text: '🔕 Источник отключён' },
  alert_type:  { color: 'var(--muted)', text: '🔔 Тип не подписан' },
  dedup:       { color: 'var(--muted)', text: '✓✓ Уже отправлено' },
  daily:       { color: 'var(--muted)', text: '📵 Лимит юзера' },
  cap:         { color: 'var(--muted)', text: '⏱ Cap на цикл' },
  send_failed: { color: 'var(--red)',   text: '⚠ Ошибка отправки' },
};

// Short human labels for each gate chip
const GATE_LABELS = {
  threshold:  'порог',
  hard_junk:  'junk',
  source:     'источник',
  alert_type: 'тип',
  dedup:      'dedup',
  daily:      'лимит',
  cap:        'cap',
  send:       'отправка',
};

// ── Copy-math helpers ──────────────────────────────────────────────────────
// Build a plain-text representation of the alert math panel suitable for
// pasting into Slack/issue/Telegram. Uses String.fromCharCode(10) for
// newlines — literal escape sequences in inline-template strings break
// the outer template literal (see SESSION_CONTEXT trap notes).
function formatMathPanelAsText(d) {
  if (!d || !d.breakdown) return '';
  const NL = String.fromCharCode(10);
  const b = d.breakdown;
  const w = b.weights || {};
  const fmt = (n) => {
    const x = Number(n);
    if (!isFinite(x)) return '—';
    return (Math.round(x * 10) / 10).toString();
  };
  const pad = (s, n) => {
    const str = String(s);
    return str.length >= n ? str : str + ' '.repeat(n - str.length);
  };

  const score = Number(d.alertScore) || 0;
  const floor = Number(d.threshold) || 0;
  const passed = score >= floor;
  const verdict = d.decision === 'sent'
    ? 'SENT'
    : 'SKIPPED (' + (d.reason || 'unknown') + ')';

  const lines = [];
  lines.push('Trend: ' + JSON.stringify((d.title || '—').slice(0, 120)));
  lines.push('Verdict: score=' + score + ' / ' + floor + ' · '
    + (passed ? 'PASS' : 'FAIL') + ' · ' + verdict);
  if (d.source)    lines.push('Source: ' + d.source);
  if (d.alertType) lines.push('Type: ' + d.alertType);
  if (d.preset)    lines.push('Preset: ' + d.preset);
  if (d.url)       lines.push('URL: ' + d.url);
  lines.push('');

  // Positive section
  lines.push('─ POSITIVE (Σ +' + fmt(b.positive) + ')');
  const posRows = [
    { label: 'meme',     val: b.meme,      weight: w.weightMemePotential },
    { label: 'viral',    val: b.viral,     weight: w.weightVirality },
    { label: 'emerge',   val: b.emergence, weight: w.weightEmergence },
    { label: 'twitter',  val: b.twitter,   weight: w.weightTwitter },
    { label: 'feedback', val: b.feedback,  weight: w.weightFeedback },
  ];
  for (const r of posRows) {
    const rawVal = Number(r.val) || 0;
    const wVal = Number(r.weight) || 0;
    const contrib = rawVal * wVal;
    const calc = w.weightMemePotential != null
      ? fmt(rawVal) + ' x ' + fmt(wVal)
      : fmt(rawVal);
    lines.push('   ' + pad(r.label, 9) + ' ' + pad(calc, 14)
      + ' = ' + (contrib >= 0 ? '+' : '') + fmt(contrib));
  }
  lines.push('');

  // Penalty section
  lines.push('─ PENALTY (Σ −' + fmt(b.penalty) + ')');
  const junkVal = Number(b.junk) || 0;
  const junkWeight = Number(w.weightJunk) || 0;
  const junkContrib = junkVal * junkWeight;
  lines.push('   ' + pad('junk', 9) + ' '
    + pad(fmt(junkVal) + ' x ' + fmt(junkWeight), 14)
    + ' = −' + fmt(junkContrib));
  const stale = Number(b.staleDecay) || 0;
  const grace = w.staleDecayGraceHours != null ? w.staleDecayGraceHours : 24;
  lines.push('   ' + pad('stale', 9) + ' '
    + pad(fmt(b.ageHours) + 'h, grace ' + grace + 'h', 14)
    + ' = −' + fmt(stale));

  if (Array.isArray(b.junkReasons) && b.junkReasons.length > 0) {
    lines.push('   junk triggers: ' + b.junkReasons.join(', '));
  }
  lines.push('');

  // Equation
  lines.push('+' + fmt(b.positive) + ' − ' + fmt(b.penalty) + ' = ' + score
    + ' ' + (passed ? '≥' : '<') + ' ' + floor
    + ' (' + (passed ? '✓ pass' : '✗ fail') + ')');

  // Floor decomposition
  const userFloor = Number(d.userFloor || 0);
  const adminFloor = Number(d.globalFloor || 0);
  if (userFloor || adminFloor) {
    lines.push('Floor ' + floor + ' = max(user ' + (userFloor || 0)
      + ', admin ' + (adminFloor || 0) + ')');
  }

  // Feedback details
  if (b.feedbackStats) {
    lines.push('Feedback: 👍 ' + (b.feedbackStats.likes | 0)
      + ' / 👎 ' + (b.feedbackStats.dislikes | 0)
      + ' → boost ' + (b.feedback != null ? b.feedback : 50));
  }

  return lines.join(NL);
}

// Inline copy-to-clipboard button. Uses navigator.clipboard with a textarea
// fallback for older browsers / non-secure contexts. Local state shows
// "Copied" feedback for 2 seconds, then reverts. Fully self-contained.
function CopyMathButton({ getText }) {
  const h = React.createElement;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const onClick = async () => {
    const text = typeof getText === 'function' ? getText() : '';
    if (!text) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts (http://) — execCommand path
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setError(false);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(true);
      setTimeout(() => setError(false), 2500);
    }
  };

  const cls = 'dec-math-copy-btn'
    + (copied ? ' copied' : '')
    + (error ? ' error' : '');
  const label = error ? '⚠ ошибка' : (copied ? '✓ скопировано' : '📋 copy math');

  return h('button', {
    className: cls,
    onClick,
    title: copied ? 'Скопировано в буфер обмена' : 'Скопировать математику в plain-text',
    type: 'button',
  }, label);
}

function DecisionsPage() {
  const h = React.createElement;
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all'); // all | sent | skipped
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Per-card expand state for the detailed math panel. Keyed by ts+trendId.
  // Survives polling refresh because we update by key, not array index.
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpand = (key) => setExpanded(prev => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const load = () => {
    setLoading(true);
    const qs = 'filter=' + filter + (reason ? '&reason=' + encodeURIComponent(reason) : '') + '&limit=200';
    api('/api/alert-decisions?' + qs)
      .then(d => { setData(d); setError(null); setLoading(false); })
      .catch(e => { setError(e.message || 'Failed to load decisions'); setLoading(false); });
  };
  useEffect(load, [filter, reason]);
  useEffect(() => {
    const iv = setInterval(load, 10_000); // refresh every 10s
    return () => clearInterval(iv);
  }, [filter, reason]);

  if (loading && !data) return h('div', { className: 'loading' }, 'Загрузка решений...');
  if (error && !data) return h('div', null,
    h(ErrorBanner, { message: error, onRetry: load, variant: 'error' })
  );
  if (!data) return h('div', { className: 'empty' }, 'Нет данных');

  const allItems = data.items || [];
  const counts = data.counts || {};

  // Client-side search across title / source / category / alertType / chatId.
  // Server-side не делаем потому что буфер in-memory всего 500 решений —
  // фильтрация массива из 500 элементов на каждый keystroke стоит микросекунды.
  const q = search.trim().toLowerCase();
  const items = q
    ? allItems.filter(d => {
        const hay = [
          d.title, d.source, d.category, d.alertType,
          d.userChatId, d.url, d.reason,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
    : allItems;

  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { return iso; }
  };
  // Compact number formatter — 1234 → 1.2K, 1234567 → 1.2M
  const fmtNum = (n) => {
    if (n == null || isNaN(n)) return null;
    const x = Number(n);
    if (x >= 1_000_000) return (x / 1_000_000).toFixed(x >= 10_000_000 ? 0 : 1) + 'M';
    if (x >= 1_000)     return (x / 1_000).toFixed(x >= 10_000 ? 0 : 1) + 'K';
    return String(x);
  };
  const fmtBreakdown = (b) => {
    if (!b) return '—';
    const parts = [];
    if (b.meme != null)       parts.push('meme=' + b.meme);
    if (b.viral != null)      parts.push('viral=' + b.viral);
    if (b.emergence != null)  parts.push('emerg=' + b.emergence);
    if (b.twitter)            parts.push('x=' + b.twitter);
    if (b.feedback != null && b.feedback !== 50) parts.push('fb=' + b.feedback);
    if (b.junk)               parts.push('junk=' + b.junk);
    if (b.staleDecay)         parts.push('stale=' + b.staleDecay);
    return parts.join(' · ');
  };

  // Round to 1 decimal — used everywhere in the math panel for display
  const fmt1 = (n) => {
    const x = Number(n);
    if (!isFinite(x)) return '—';
    return (Math.round(x * 10) / 10).toString();
  };

  // Tooltip text for each junk-filter rule. Synced with rule names in
  // src/analysis/junk-filter.js. safe-override(divN) means a meme-shape
  // signal divided the raw penalty by N (rescue path).
  const junkReasonHint = (r) => {
    const s = String(r || '');
    if (s.startsWith('safe-override')) {
      const m = s.match(/divisor[÷:]?(\d+)|÷(\d+)/);
      const n = m ? (m[1] || m[2]) : '?';
      return 'Сработал meme-сигнал → весь junk поделён на ÷' + n + ' (rescue)';
    }
    const HINTS = {
      'politics':      'Политика/война (RE_POLITICS) — junk-filter politicsPenalty',
      'kpop/fandom':   'K-pop / стан-культура (RE_KPOP) — kpopPenalty',
      'celeb-noise':   'Рутинный celeb-шум: интервью, red carpet (RE_CELEB_NOISE) — celebNoisePenalty',
      'no-meme-shape': 'Нет mem-сигнала: ни животного, ни абсурда, ни мема, ни heartwarming — noMemeShapePenalty',
      'text-only':     'Кластер без картинок/видео — noContentPenalty (не применяется к google_trends)',
    };
    return HINTS[s] || s;
  };

  // Detailed math panel — full arithmetic for one decision.
  // Shows every component (raw value × weight = contribution), the equation,
  // threshold breakdown, feedback details, hard-junk reference, and stale knobs.
  // Only rendered when the user clicks the expand button on a decision card.
  const MathPanel = (d) => {
    const b = d.breakdown;
    if (!b) return null;
    // Weights snapshot was added 2026-05-07. Older decisions in the buffer
    // (pre-deploy) won't have it — fall back to "—" for the calc column.
    const w = b.weights || {};
    const hasWeights = b.weights != null;

    const score = Number(d.alertScore) || 0;
    const userFloor = Number(d.userFloor || 0);
    const adminFloor = Number(d.globalFloor || 0);
    const floor = Number(d.threshold || 0);
    const passed = score >= floor;

    const posRows = [
      { key: 'meme',     val: b.meme,      weight: w.weightMemePotential, label: 'meme' },
      { key: 'viral',    val: b.viral,     weight: w.weightVirality,      label: 'viral' },
      { key: 'emerge',   val: b.emergence, weight: w.weightEmergence,     label: 'emerg' },
      { key: 'twitter',  val: b.twitter,   weight: w.weightTwitter,       label: 'twitter' },
      { key: 'feedback', val: b.feedback,  weight: w.weightFeedback,      label: 'feedback' },
    ];

    const junkPenaltyVal = (Number(b.junk) || 0) * (Number(w.weightJunk) || 0);
    const stalePenaltyVal = Number(b.staleDecay) || 0;
    const hardJunkStop = Number(w.hardJunkStop) || 70;
    const hardJunkHit = (Number(b.junk) || 0) >= hardJunkStop;

    return h('div', { className: 'dec-math' },
      // Copy-to-clipboard button — top-right corner, absolutely positioned.
      // getText is a closure over the decision so the button always copies
      // fresh numbers (relevant if the buffer rotates and the same row
      // gets re-rendered with updated data).
      h(CopyMathButton, { getText: () => formatMathPanelAsText(d) }),
      h('div', { className: 'dec-math-grid' },
        // Left column — positive contributions
        h('div', { className: 'dec-math-section' },
          h('h4', null, '+ Положительные сигналы',
            h('span', { className: 'badge' }, 'Σ +' + fmt1(b.positive))
          ),
          h('table', { className: 'dec-math-table' },
            h('tbody', null,
              ...posRows.map(r => {
                const rawVal = Number(r.val) || 0;
                const wVal = Number(r.weight) || 0;
                const contrib = rawVal * wVal;
                const isZero = !contrib;
                return h('tr', { key: r.key, className: isZero ? 'muted' : '' },
                  h('td', { className: 'label' }, r.label),
                  h('td', { className: 'calc' },
                    hasWeights ? (fmt1(rawVal) + ' x ' + fmt1(wVal)) : fmt1(rawVal)
                  ),
                  h('td', { className: 'contrib ' + (isZero ? 'zero' : 'pos') },
                    isZero ? '0' : ('+' + fmt1(contrib)))
                );
              }),
              h('tr', { className: 'total' },
                h('td', { className: 'label' }, 'Σ positive'),
                h('td', { className: 'calc' }, ''),
                h('td', { className: 'contrib pos' }, '+' + fmt1(b.positive))
              )
            )
          )
        ),
        // Right column — penalty
        h('div', { className: 'dec-math-section' },
          h('h4', null, '- Штрафы',
            h('span', { className: 'badge' }, 'Σ -' + fmt1(b.penalty))
          ),
          h('table', { className: 'dec-math-table' },
            h('tbody', null,
              h('tr', { className: !junkPenaltyVal ? 'muted' : '' },
                h('td', { className: 'label' }, 'junk'),
                h('td', { className: 'calc' },
                  hasWeights ? (fmt1(b.junk) + ' x ' + fmt1(w.weightJunk)) : fmt1(b.junk)
                ),
                h('td', { className: 'contrib ' + (!junkPenaltyVal ? 'zero' : 'neg') },
                  !junkPenaltyVal ? '0' : ('-' + fmt1(junkPenaltyVal)))
              ),
              h('tr', { className: !stalePenaltyVal ? 'muted' : '' },
                h('td', { className: 'label' }, 'stale'),
                h('td', { className: 'calc' },
                  fmt1(b.ageHours) + 'h, grace ' +
                  (w.staleDecayGraceHours != null ? w.staleDecayGraceHours : 24) + 'h'
                ),
                h('td', { className: 'contrib ' + (!stalePenaltyVal ? 'zero' : 'neg') },
                  !stalePenaltyVal ? '0' : ('-' + fmt1(stalePenaltyVal)))
              ),
              h('tr', { className: 'total' },
                h('td', { className: 'label' }, 'Σ penalty'),
                h('td', { className: 'calc' }, ''),
                h('td', { className: 'contrib neg' }, '-' + fmt1(b.penalty))
              )
            )
          ),
          // Junk reasons — what specifically triggered the junk score.
          // Set by junk-filter.js: politics, kpop/fandom, celeb-noise,
          // no-meme-shape, text-only. safe-override(divN) means a meme
          // signal divided the raw penalty.
          Array.isArray(b.junkReasons) && b.junkReasons.length > 0
            ? h('div', { className: 'dec-math-reasons' },
                h('span', { className: 'lbl' }, 'junk триггеры:'),
                ...b.junkReasons.map((r, ri) => h('span', {
                  key: ri,
                  className: 'tag' + (String(r).startsWith('safe-override') ? ' safe' : ''),
                  title: junkReasonHint(r),
                }, r))
              )
            : null
        )
      ),
      // Equation
      h('div', { className: 'dec-math-equation' },
        h('span', { className: 'pos-num' }, '+' + fmt1(b.positive)),
        ' - ',
        h('span', { className: 'neg-num' }, fmt1(b.penalty)),
        ' = ',
        h('span', { className: 'final ' + (passed ? 'pass' : 'fail') }, score),
        h('span', {
          style: { color: 'var(--muted)', fontSize: 13, marginLeft: 8 }
        }, (passed ? ' >= ' : ' < ') + floor + ' (' + (passed ? '✓ pass' : '✗ fail') + ')')
      ),
      // Threshold decomposition
      h('div', { className: 'dec-math-floor' },
        'Порог ',
        h('b', null, floor),
        ' = max(user ', h('b', null, userFloor || 0),
        ', admin ', h('b', null, adminFloor || 0), ')'
      ),
      // Meta pills — feedback votes, hard-junk reference, stale cap, trigger
      h('div', { className: 'dec-math-meta' },
        // Feedback details
        b.feedbackStats
          ? h('span', { className: 'pill' },
              h('span', { className: 'dec-math-fb' },
                h('span', { className: 'like' }, '👍 ' + (b.feedbackStats.likes | 0)),
                ' / ',
                h('span', { className: 'dislike' }, '👎 ' + (b.feedbackStats.dislikes | 0)),
                h('span', { className: 'arrow' }, ' -> '),
                h('span', { className: 'boost' }, 'boost ' + b.feedback)
              )
            )
          : h('span', { className: 'pill' },
              h('span', { className: 'dec-math-fb' },
                h('span', { className: 'arrow' }, 'feedback boost '),
                h('span', { className: 'boost' }, b.feedback != null ? b.feedback : 50),
                h('span', { className: 'arrow' },
                  ' (' + (b.feedback === 50 || b.feedback == null ? 'нейтрал' : 'votes неизвестны') + ')')
              )
            ),
        // Hard-junk gate reference
        h('span', { className: 'pill ' + (hardJunkHit ? 'warn' : 'ok') },
          'hard-junk ', h('b', null, (b.junk | 0) + ' / ' + hardJunkStop), ' ',
          (hardJunkHit ? '⚠ убил бы' : '✓ ниже порога')
        ),
        // Stale cap reference
        h('span', { className: 'pill' },
          'stale ',
          h('b', null, fmt1(b.staleDecay) + ' / ' + (w.staleDecayCap != null ? w.staleDecayCap : 30)),
          ' (',
          (w.staleDecayPerHour != null ? w.staleDecayPerHour : 2),
          '/h после ',
          (w.staleDecayGraceHours != null ? w.staleDecayGraceHours : 24),
          'h)'
        ),
        // Trigger source (scan vs refresh vs manual)
        d.triggerSource ? h('span', { className: 'pill' },
          'trigger ', h('b', null, d.triggerSource)
        ) : null,
        // Older decisions warning
        !hasWeights ? h('span', { className: 'pill warn' },
          '⚠ старая запись — веса не сохранены, calc неполный'
        ) : null
      )
    );
  };

  return h('div', null,
    error ? h(ErrorBanner, { message: error, onRetry: load, variant: 'error' }) : null,
    h('div', { className: 'dec-page-head' },
      h('h2', null, '🔔 Решения алерт-гейта'),
      h('p', null,
        'Последние 500 решений, in-memory (сбрасывается при рестарте). Обновляется каждые 10 сек. ' +
        'Всего в буфере: ' + (data.total || 0) + '.')
    ),

    // Filter chips + reason counts
    h('div', { className: 'dec-filter-row' },
      ['all', 'sent', 'skipped'].map(f => h('button', {
        key: f,
        className: 'btn ' + (filter === f ? 'btn-primary' : 'btn-ghost') + ' btn-sm',
        onClick: () => { setFilter(f); setReason(''); }
      }, f === 'all' ? 'Все' : f === 'sent' ? '✓ Отправлены' : '✗ Отсеяны')),
      h('input', {
        type: 'text',
        className: 'dec-search',
        placeholder: '🔍 Поиск по заголовку, источнику, категории, chat_id...',
        value: search,
        onChange: e => setSearch(e.target.value),
      }),
      search && h('button', {
        className: 'dec-search-clear',
        onClick: () => setSearch(''),
        title: 'Очистить поиск',
      }, '✕'),
      search && h('span', {
        style: { fontSize: 12, color: 'var(--text2)' },
      }, 'найдено: ' + items.length + ' / ' + allItems.length)
    ),
    h('div', { className: 'dec-reason-row' },
      Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, n]) => {
        const lbl = DECISION_LABELS[r];
        return h('button', {
          key: r,
          className: 'btn btn-sm ' + (reason === r ? 'btn-primary' : 'btn-ghost'),
          style: { fontSize: 11, padding: '4px 10px', color: reason === r ? '' : (lbl?.color || 'var(--text2)') },
          onClick: () => setReason(reason === r ? '' : r)
        }, (lbl?.text || r) + ' · ' + n);
      })
    ),

    // List
    items.length === 0
      ? h('div', { className: 'empty', style: { padding: 40 } },
          q
            ? 'По запросу «' + search + '» ничего не найдено в ' + allItems.length + ' решениях.'
            : 'Пока нет решений — сканер ещё ни разу не гонял алерт-гейт.')
      : h('div', { className: 'dec-list' },
          items.map((d, i) => {
            const lbl = DECISION_LABELS[d.reason] || { color: 'var(--text2)', text: d.reason };
            const isSent = d.decision === 'sent';
            // Stable key for expand state — same trend at same ts is the same row
            const expKey = (d.ts || '') + ':' + (d.trendId || i);
            const isOpen = expanded.has(expKey);

            // Fallback for old decisions without gates[] — synthesize from reason
            const gates = Array.isArray(d.gates) && d.gates.length
              ? d.gates
              : (d.reason && d.reason !== 'sent'
                  ? [{ name: d.reason, passed: false, detail: d.detail || '' }]
                  : []);

            const titleNode = d.url
              ? h('a', {
                  href: d.url, target: '_blank', rel: 'noopener noreferrer',
                  className: 'dec-title-link'
                }, (d.title || '—'), h('span', { className: 'dec-title-arrow' }, '↗'))
              : h('span', { className: 'dec-title-link' }, d.title || '—');

            return h('div', {
              key: i,
              className: 'dec-card ' + (isSent ? 'sent' : 'skipped')
            },
              // Row 1: time + title + verdict
              h('div', { className: 'dec-row1' },
                h('span', { className: 'dec-time' }, fmtTime(d.ts)),
                h('div', { className: 'dec-title' }, titleNode),
                h('span', { className: 'dec-verdict ' + (isSent ? 'sent' : 'skipped') }, lbl.text)
              ),
              // Row 2: meta (source, category, score, user, preset)
              h('div', { className: 'dec-meta-row' },
                d.source    && h('span', null, '📡 ', h('b', null, d.source)),
                // Alert-type chip — coloured per type for at-a-glance distribution
                d.alertType && h('span', { className: 'dec-atype-chip ' + d.alertType },
                  (d.alertType === 'event' ? '📰 EVENT' : d.alertType === 'trend' ? '📈 TREND' : '🚀 POST')),
                d.category  && h('span', null, '📂 ', d.category),
                d.alertScore != null && h('span', null,
                  'score: ', h('b', null, d.alertScore), ' / ', d.threshold
                ),
                // Score-source chip (2026-05-10 trust-contract). Tells the
                // admin at a glance which stage produced the final
                // memePotential. Hover reveals the override reason when Stage
                // 1 disagreed with Stage 0b.
                d.scoreSource && (() => {
                  const map = {
                    stage0b_gemini: { icon: '🌟', label: 'Gemini',   color: '#00b894', bg: 'rgba(0,184,148,.10)', tip: 'memePotential от Stage 0b (Gemini multimodal) — authoritative' },
                    stage1_override:{ icon: '🔄', label: 'Override', color: '#fdcb6e', bg: 'rgba(253,203,110,.12)', tip: 'Stage 1 переписал Gemini score' },
                    stage1_fallback:{ icon: '🤖', label: 'Stage1',   color: '#74b9ff', bg: 'rgba(116,185,255,.10)', tip: 'Stage 1 сам скорил — Gemini не вернул memePotential (text-only тренд или fallback)' },
                  };
                  const m = map[d.scoreSource];
                  if (!m) return null;
                  const ov = d.scoreOverride;
                  const lbl = (d.scoreSource === 'stage1_override' && ov)
                    ? (m.icon + ' ' + m.label + ' ' + ov.from + '→' + ov.to)
                    : (m.icon + ' ' + m.label);
                  const tipText = (d.scoreSource === 'stage1_override' && ov)
                    ? (m.tip + '\\n' + ov.from + ' → ' + ov.to + '\\n' + (ov.reason || ''))
                    : m.tip;
                  return h('span', {
                    title: tipText,
                    style: {
                      fontSize: 11, padding: '2px 7px', borderRadius: 4,
                      color: m.color, background: m.bg,
                      border: '1px solid ' + m.color + '33',
                      fontWeight: 600,
                    }
                  }, lbl);
                })(),
                // Deep Escalation badge — did this trend go through Stage 2, and how.
                d.deepDiveReason && (() => {
                  const map = {
                    escalation: { icon: '⚡', label: 'Escalated', color: '#e17055', bg: 'rgba(225,112,85,.12)', tip: 'Deep Escalation: тренд отправлен на Stage 2 как недооценённый (эвристика) или по флагу needsDeeperLook' },
                    high_meme:  { icon: '🔍', label: 'Stage 2',   color: '#a29bfe', bg: 'rgba(162,155,254,.12)', tip: 'Прошёл Stage 2 deep-dive обычным путём (high meme), без эскалации' },
                  };
                  const m = map[d.deepDiveReason];
                  if (!m) return null;
                  return h('span', {
                    title: m.tip,
                    style: {
                      fontSize: 11, padding: '2px 7px', borderRadius: 4,
                      color: m.color, background: m.bg,
                      border: '1px solid ' + m.color + '33',
                      fontWeight: 600,
                    }
                  }, m.icon + ' ' + m.label);
                })(),
                d.preset && h('span', null, '🎯 ', h('b', null, d.preset)),
                d.userChatId && h('span', null, '👤 @', d.userChatId)
              ),
              // Row 2b: engagement — raw views/likes/retweets/upvotes from
              // the collector. Hidden if no data at all.
              (() => {
                const e = d.engagement || {};
                const chips = [];
                if (e.views    != null && fmtNum(e.views)    != null) chips.push({ icon: '👁', label: 'views',    val: fmtNum(e.views) });
                if (e.likes    != null && fmtNum(e.likes)    != null) chips.push({ icon: '❤️', label: 'likes',    val: fmtNum(e.likes) });
                if (e.retweets != null && fmtNum(e.retweets) != null) chips.push({ icon: '🔁', label: 'rt',       val: fmtNum(e.retweets) });
                if (e.replies  != null && fmtNum(e.replies)  != null) chips.push({ icon: '💬', label: 'replies',  val: fmtNum(e.replies) });
                if (e.upvotes  != null && fmtNum(e.upvotes)  != null) chips.push({ icon: '⬆',  label: 'upvotes',  val: fmtNum(e.upvotes) });
                if (!chips.length) return null;
                return h('div', { className: 'dec-eng-row' },
                  chips.map((c, ci) => h('span', { key: ci, className: 'dec-eng-chip', title: c.label }, c.icon + ' ' + c.val))
                );
              })(),
              // Row 3: gate chips
              gates.length > 0 && h('div', { className: 'dec-gate-row' + (d.breakdown ? '' : ' no-bd') },
                gates.map((g, gi) => h('span', {
                  key: gi,
                  title: g.detail || '',
                  className: 'dec-gate-chip ' + (g.passed ? 'passed' : 'failed'),
                }, (g.passed ? '✓ ' : '✗ ') + (GATE_LABELS[g.name] || g.name)))
              ),
              // Row 4: breakdown one-liner + expand toggle
              d.breakdown && h('div', { className: 'dec-breakdown' },
                h('span', { className: 'dec-breakdown-text' }, fmtBreakdown(d.breakdown)),
                h('button', {
                  className: 'dec-expand-btn',
                  onClick: () => toggleExpand(expKey),
                  title: isOpen ? 'Свернуть детали' : 'Полная математика scoring'
                }, isOpen ? '▴ свернуть' : '▾ детали')
              ),
              // Row 5: full math panel (when expanded)
              d.breakdown && isOpen && MathPanel(d),
              // Row 5b: Stage 1 score-override detail block (when expanded
              // AND Stage 1 disagreed with Stage 0b). Shows from→to + reason
              // verbatim so admins can spot Stage 1 overstepping its mandate.
              isOpen && d.scoreSource === 'stage1_override' && d.scoreOverride &&
                DecisionScoreOverrideBlock(d.scoreOverride),
              // Row 6: Stage 0 PreStage block (Gemini visual+audio + chips + nano)
              // — only when expanded. If preStage is null/empty (legacy trend
              // scored before PreStage was wired, or text-only trend with no
              // media for Gemini AND no nano result), show a dashed legacy
              // chip so the missing block doesn't look like a render bug.
              isOpen && DecisionPreStageBlock(d)
            );
          })
        )
  );
}

// ── DecisionScoreOverrideBlock — Stage 1 override detail card ──────────────
// Rendered ONLY when Stage 1 disagreed with Stage 0b (scoreSource ===
// 'stage1_override'). Shows the from/to delta + the reason Stage 1 gave
// verbatim. The 2026-05-10 trust-contract makes Stage 0b authoritative; this
// block exists so admins can audit the rare override path and catch a Stage 1
// model that's overreaching its mandate (delta too big, reason too vague,
// override on every trend, etc).
function DecisionScoreOverrideBlock(ov) {
  const h = React.createElement;
  if (!ov || !Number.isFinite(ov.from) || !Number.isFinite(ov.to)) return null;
  const delta = ov.to - ov.from;
  const sign = delta > 0 ? '+' : '';
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const arrowColor = delta > 0 ? '#00b894' : delta < 0 ? '#ff7675' : 'var(--text2)';
  return h('div', {
    style: {
      marginTop: 10, padding: '10px 14px',
      background: 'rgba(253,203,110,.06)',
      border: '1px solid rgba(253,203,110,.30)',
      borderRadius: 8,
      fontSize: 12, lineHeight: 1.5, color: 'var(--text)',
    }
  },
    h('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--text2)', marginBottom: 6, letterSpacing: '.4px' } },
      '🔄 STAGE 1 SCORE OVERRIDE'),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' } },
      h('span', { style: { fontSize: 11, color: 'var(--text2)' } }, 'Gemini'),
      h('span', { style: { fontWeight: 700 } }, ov.from),
      h('span', { style: { fontSize: 14, color: arrowColor } }, '→'),
      h('span', { style: { fontWeight: 700 } }, ov.to),
      h('span', {
        style: {
          fontSize: 10, padding: '1px 7px', borderRadius: 4,
          background: arrowColor + '22', color: arrowColor, fontWeight: 700,
        }
      }, sign + delta + ' (' + direction + ')'),
      h('span', { style: { fontSize: 11, color: 'var(--text2)' } }, '· Stage 1 (' + (ov.stage || 'stage1') + ')')
    ),
    h('div', { style: { fontSize: 12, color: 'var(--text)', fontStyle: 'italic' } },
      h('span', { style: { color: 'var(--text2)', fontStyle: 'normal' } }, 'Reason: '),
      '"' + (ov.reason || '(no reason given — should not happen, validation should have dropped this)') + '"'
    )
  );
}

// ── DecisionPreStageBlock — Stage 0 PreStage card for DecisionsPage ────────
// Mirrors the block ManualResultCard shows for manual-analyzed trends, but
// rendered against decision-record shape (d.preStage). Lives here (next to
// DecisionsPage) instead of inline so the DecisionsPage row stays readable.
//
// Returns null when there is nothing to render except the legacy marker —
// in that case we still emit the dashed chip so admins know it's not a bug.
function DecisionPreStageBlock(d) {
  const h = React.createElement;
  const ps = d.preStage || null;
  const hasNano = !!ps?.nano;
  const hasGemini = !!ps?.gemini;

  // Empty case → show legacy/no-data dashed chip and return.
  if (!hasNano && !hasGemini) {
    return h('div', {
      style: {
        fontSize: 11, color: 'var(--text2)', marginTop: 10,
        padding: '6px 10px',
        border: '1px dashed rgba(255,255,255,.12)',
        borderRadius: 6,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: 'rgba(255,255,255,.02)',
      },
      title: 'Этот тренд был заскорен до того, как у тебя включился Stage 0 PreStage (nano + gemini), либо у него не было ни текста для nano, ни картинки/видео для gemini. Hot-refresh не пересоздаёт preStage — данные останутся пустыми навсегда.'
    },
      h('span', null, '📭'),
      h('span', null, 'No PreStage data (legacy trend)')
    );
  }

  const g = ps.gemini || {};
  const n = ps.nano || {};

  return h('div', {
    style: {
      marginTop: 10, padding: '12px 14px',
      background: 'rgba(124,58,237,.04)',
      border: '1px solid rgba(124,58,237,.18)',
      borderRadius: 8,
      fontSize: 12, lineHeight: 1.55, color: 'var(--text)',
    }
  },
    h('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--text2)', marginBottom: 8, letterSpacing: '.4px' } },
      '🎨 STAGE 0 PRESTAGE'),

    // Nano sub-block
    hasNano && h('div', {
      style: hasGemini ? { marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid rgba(124,58,237,.18)' } : null
    },
      h('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--text2)', marginBottom: 4 } }, '📝 Nano (gpt-5.4-nano)'),
      n.topicSummary && h('div', { style: { marginBottom: 4 } },
        h('span', { style: { color: 'var(--text2)' } }, 'Тема: '), n.topicSummary
      ),
      Array.isArray(n.entityCanonical) && n.entityCanonical.length > 0 &&
        h('div', { style: { marginBottom: 4 } },
          h('span', { style: { color: 'var(--text2)' } }, 'Сущности: '),
          n.entityCanonical.join(', ')
        ),
      n.slangDecoded && n.slangDecoded.trim() &&
        h('div', { style: { marginBottom: 4, fontStyle: 'italic' } },
          h('span', { style: { color: 'var(--text2)', fontStyle: 'normal' } }, 'Slang: '),
          n.slangDecoded
        ),
      n.language && n.language !== 'en' &&
        h('span', { style: { fontSize: 11, color: 'var(--text2)' } }, 'lang=' + n.language)
    ),

    // Gemini sub-block
    hasGemini && h('div', null,
      h('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--text2)', marginBottom: 4 } },
        '🎬 Gemini (' + (g.mediaType || 'visual') + ')' +
        (g.videoTruncated ? ' · poster fallback' :
          (g.videoClipped ? ' · clipped to ' + (g.videoMaxSec || 30) + 's' : '')) +
        (g.videoDurationSec ? ' · ' + g.videoDurationSec.toFixed(1) + 's' : '')
      ),
      g.visualCaption && h('div', { style: { marginBottom: 4 } },
        h('span', { style: { color: 'var(--text2)' } }, 'Визуал: '), g.visualCaption
      ),
      g.videoSummary && g.videoSummary.trim() &&
        h('div', { style: { marginBottom: 4 } },
          h('span', { style: { color: 'var(--text2)' } }, 'Видео: '), g.videoSummary
        ),
      g.audioSummary && g.audioSummary.trim() &&
        h('div', { style: { marginBottom: 4 } },
          h('span', { style: { color: 'var(--text2)' } }, '🎤 Аудио: '), g.audioSummary
        ),
      g.spokenText && g.spokenText.trim() &&
        h('div', { style: { marginBottom: 4 } },
          h('span', { style: { color: 'var(--text2)' } }, '💬 Речь: '),
          h('span', { style: { fontStyle: 'italic' } }, '"' + g.spokenText + '"')
        ),
      g.visibleText && g.visibleText.trim() &&
        h('div', { style: { marginBottom: 4 } },
          h('span', { style: { color: 'var(--text2)' } }, 'Текст в кадре: '),
          h('span', { style: { fontStyle: 'italic' } }, '"' + g.visibleText + '"')
        ),
      // Section B (enrichment) — was nano, now lives inside Gemini after the
      // 2026-05-10 trust-contract refactor. Surfaced verbatim so admins can
      // see how Gemini interprets the post text.
      g.topicSummary && g.topicSummary.trim() &&
        h('div', { style: { marginBottom: 4 } },
          h('span', { style: { color: 'var(--text2)' } }, 'Тема: '), g.topicSummary
        ),
      Array.isArray(g.entityCanonical) && g.entityCanonical.length > 0 &&
        h('div', { style: { marginBottom: 4 } },
          h('span', { style: { color: 'var(--text2)' } }, 'Сущности: '),
          g.entityCanonical.join(', ')
        ),
      g.slangDecoded && g.slangDecoded.trim() &&
        h('div', { style: { marginBottom: 4, fontStyle: 'italic' } },
          h('span', { style: { color: 'var(--text2)', fontStyle: 'normal' } }, 'Slang: '),
          g.slangDecoded
        ),
      // Section C (authoritative scoring) — these are the values Stage 1
      // ECHOes by default. Highlighted differently from the subsidiary
      // signals so it's obvious which numbers carry weight.
      (Number.isFinite(g.memePotential) || Number.isFinite(g.viralityScore) || g.category) &&
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
          Number.isFinite(g.memePotential) &&
            h('span', { className: 'sp-chip', style: { fontSize: 10, fontWeight: 700, color: '#00b894', borderColor: 'rgba(0,184,148,.4)' } },
              '🎯 memePotential ' + g.memePotential + '/100'),
          Number.isFinite(g.viralityScore) &&
            h('span', { className: 'sp-chip', style: { fontSize: 10, fontWeight: 700, color: '#00b894', borderColor: 'rgba(0,184,148,.4)' } },
              '🔥 viralityScore ' + g.viralityScore + '/100'),
          g.category &&
            h('span', { className: 'sp-chip', style: { fontSize: 10, fontWeight: 700, color: '#00b894', borderColor: 'rgba(0,184,148,.4)' } },
              '📂 ' + g.category)
        ),
      // Section D (subsidiary signals) — meme shape, narrative, subject, viralPattern,
      // tickerSuggestion, subjectNames, lipsync, ambient flags.
      (Number.isFinite(g.memeShapeStrength)
          || typeof g.hasNarrative === 'boolean'
          || typeof g.hasSubject === 'boolean'
          || g.viralPattern
          || (g.tickerSuggestion && g.tickerSuggestion.trim())
          || (Array.isArray(g.subjectNames) && g.subjectNames.length > 0)
          || g.isLipSync
          || g.isAmbient) &&
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, marginBottom: 4 } },
          Number.isFinite(g.memeShapeStrength) &&
            h('span', { className: 'sp-chip', style: { fontSize: 10 } }, '🎯 memeShape ' + g.memeShapeStrength + '/100'),
          typeof g.hasNarrative === 'boolean' &&
            h('span', { className: 'sp-chip', style: { fontSize: 10 } }, (g.hasNarrative ? '📖' : '🚫') + ' narrative'),
          typeof g.hasSubject === 'boolean' &&
            h('span', { className: 'sp-chip', style: { fontSize: 10 } }, (g.hasSubject ? '👤' : '🚫') + ' subject'),
          g.viralPattern &&
            h('span', { className: 'sp-chip', style: { fontSize: 10 } }, '🌀 ' + g.viralPattern),
          g.tickerSuggestion && g.tickerSuggestion.trim() &&
            h('span', { className: 'sp-chip', style: { fontSize: 10, color: '#fdcb6e' } }, '$' + g.tickerSuggestion),
          Array.isArray(g.subjectNames) && g.subjectNames.length > 0 &&
            g.subjectNames.map((nm, i) =>
              h('span', { key: 'subj-' + i, className: 'sp-chip', style: { fontSize: 10, color: '#fdcb6e' } }, '🏷️ ' + nm)
            ),
          g.isLipSync &&
            h('span', { className: 'sp-chip', style: { fontSize: 10, color: '#ff7675' } }, '🎤 lip-sync'),
          g.isAmbient &&
            h('span', { className: 'sp-chip', style: { fontSize: 10, color: '#ff7675' } }, '😴 ambient')
        ),
      // Mood + language footer
      h('div', { style: { display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' } },
        g.mood && h('span', { style: { fontSize: 11, color: 'var(--text2)' } }, 'mood: ' + g.mood),
        g.language && g.language !== 'en' &&
          h('span', { style: { fontSize: 11, color: 'var(--text2)' } }, 'lang=' + g.language)
      )
    )
  );
}

function StatsPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [maintMsg, setMaintMsg] = useState('');
  const [error, setError] = useState(null);

  const loadStats = useCallback(() => {
    setLoading(true);
    setError(null);
    api('/api/stats')
      .then(s => { setStats(s); setLoading(false); })
      .catch(e => { setError(e.message || 'Failed to load stats'); setLoading(false); });
  }, []);

  useEffect(()=>{ loadStats(); }, [loadStats]);

  // Cleanup old alerts/notifications. Moved here from PaymentsPage where it
  // didn't really belong (payments != alerts) — Stats is the natural home for
  // database-housekeeping actions.
  const cleanupAlerts = async () => {
    const raw = window.prompt('Удалить алерты старше скольких дней?', '30');
    if (raw === null) return;
    const days = Math.max(1, Math.min(365, parseInt(raw || '30', 10) || 30));
    try {
      const r = await api('/api/alerts/cleanup', 'POST', { days });
      setMaintMsg('Очищено: тренды ' + r.trendsDeleted + ', нотификации ' + r.notificationsDeleted);
      setTimeout(()=>setMaintMsg(''), 4000);
    } catch(e){ setMaintMsg('Ошибка: ' + e.message); setTimeout(()=>setMaintMsg(''), 4000); }
  };

  const runVacuum = async () => {
    if (!window.confirm('VACUUM блокирует БД на время выполнения. Продолжить?')) return;
    try {
      const r = await api('/api/admin/maintenance/vacuum', 'POST');
      setMaintMsg('VACUUM завершён за ' + r.elapsedMs + 'ms');
      setTimeout(()=>setMaintMsg(''), 4000);
      loadStats();
    } catch(e) { setMaintMsg('VACUUM ошибка: ' + e.message); setTimeout(()=>setMaintMsg(''), 4000); }
  };
  const cleanupVideoCache = async () => {
    try {
      await api('/api/admin/maintenance/cleanup-video', 'POST');
      setMaintMsg('Video cache очищен');
      setTimeout(()=>setMaintMsg(''), 3000);
    } catch(e) { setMaintMsg('Ошибка: ' + e.message); setTimeout(()=>setMaintMsg(''), 3000); }
  };
  const cleanupAuthSessions = async () => {
    try {
      const r = await api('/api/admin/maintenance/cleanup-auth', 'POST');
      setMaintMsg('Auth sessions: удалено ' + r.removed);
      setTimeout(()=>setMaintMsg(''), 3000);
    } catch(e) { setMaintMsg('Ошибка: ' + e.message); setTimeout(()=>setMaintMsg(''), 3000); }
  };
  const rotateLogs = async () => {
    try {
      const r = await api('/api/admin/maintenance/rotate-logs', 'POST');
      setMaintMsg('Logs: удалено ' + r.removed + ' файлов');
      setTimeout(()=>setMaintMsg(''), 3000);
    } catch(e) { setMaintMsg('Ошибка: ' + e.message); setTimeout(()=>setMaintMsg(''), 3000); }
  };

  if (loading) return React.createElement('div',{className:'loading'},'Загрузка статистики...');
  if (error && !stats) return React.createElement('div', null,
    React.createElement(ErrorBanner, { message: error, onRetry: loadStats, variant: 'error' })
  );
  if (!stats) return React.createElement('div',{className:'empty'},'Нет данных');

  const COLORS=['#7c3aed','#3b82f6','#10b981','#f59e0b','#ef4444'];
  const fmtRevenueByCurrency = (rows) => {
    if (!rows || rows.length === 0) return '0';
    return rows
      .map(r => {
        const c = (r.currency || 'SOL').toUpperCase();
        const decimals = c === 'SOL' ? 4 : 2;
        return parseFloat(r.total || 0).toFixed(decimals) + ' ' + c;
      })
      .join(' + ');
  };
  const fmtBytes = (bytes = 0) => {
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return mb.toFixed(1) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  };
  const paidShare = stats.users.total ? Math.round((stats.users.paid / stats.users.total) * 100) : 0;
  const activeShare = stats.users.total ? Math.round((stats.users.active / stats.users.total) * 100) : 0;
  const backup = stats.backup || {};
    let backupLabel = '⚠ Нет';
    let backupSub = 'Папка ' + (backup.dirExists ? 'пуста' : 'отсутствует');
    let backupCardColor = 'yellow';
    if (backup.lastBackupAt) {
      const ageMs = Date.now() - backup.lastBackupAt;
      const ageHours = Math.floor(ageMs / 3_600_000);
      const ageDays = Math.floor(ageHours / 24);
      if (ageHours < 36) {
        backupLabel = ageHours + 'ч назад';
        backupCardColor = 'green';
      } else if (ageDays < 7) {
        backupLabel = '⚠ ' + ageDays + 'д назад';
        backupCardColor = 'yellow';
      } else {
        backupLabel = '🚨 ' + ageDays + 'д назад';
        backupCardColor = 'yellow';
      }
      backupSub = fmtBytes(backup.lastBackupBytes);
    } else if (!backup.dirExists) {
      backupLabel = '🚨 Нет папки';
      backupCardColor = 'yellow';
    }

  return React.createElement('div',null,
    error ? React.createElement(ErrorBanner, { message: error, onRetry: loadStats, variant: 'error' }) : null,
    React.createElement('div',{className:'page-header'},
      React.createElement('h2',null,'📊 Статистика'),
      React.createElement('p',null,'Главный срез по пользователям, оплатам и состоянию базы. Это экран для быстрого sanity-check проекта: рост, монетизация, состав аудитории и нагрузка на хранилище.')
    ),
    React.createElement('div',{className:'cards'},
      React.createElement('div',{className:'card purple'},React.createElement('div',{className:'card-label'},'Всего юзеров'),React.createElement('div',{className:'card-value'},stats.users.total),React.createElement('div',{className:'card-sub'},activeShare+'% сейчас активны')),
      React.createElement('div',{className:'card green'},React.createElement('div',{className:'card-label'},'Активных'),React.createElement('div',{className:'card-value'},stats.users.active),React.createElement('div',{className:'card-sub'},'Живые пользователи в active status')),
      React.createElement('div',{className:'card blue'},React.createElement('div',{className:'card-label'},'Платных'),React.createElement('div',{className:'card-value'},stats.users.paid),React.createElement('div',{className:'card-sub'},paidShare+'% от всей базы')),
      React.createElement('div',{className:'card yellow'},React.createElement('div',{className:'card-label'},'Доход 30д'),React.createElement('div',{className:'card-value'},fmtRevenueByCurrency(stats.revenue.byCurrency30days)),React.createElement('div',{className:'card-sub'},'Текущий месячный срез')),
      React.createElement('div',{className:'card'},React.createElement('div',{className:'card-label'},'Новые сегодня'),React.createElement('div',{className:'card-value'},stats.users.newToday),React.createElement('div',{className:'card-sub'},'+'+stats.users.newWeek+' за неделю · +'+stats.users.newMonth+' за месяц')),
      React.createElement('div',{className:'card'},React.createElement('div',{className:'card-label'},'Размер БД'),React.createElement('div',{className:'card-value'},fmtBytes(stats.storage.dbBytes)),React.createElement('div',{className:'card-sub'},stats.storage.trendsCount+' trends · '+stats.storage.notificationsCount+' notifications')),
      React.createElement('div',{className:'card ' + backupCardColor},React.createElement('div',{className:'card-label'},'Бэкап'),React.createElement('div',{className:'card-value'},backupLabel),React.createElement('div',{className:'card-sub'},backupSub))
    ),
    React.createElement('div',{className:'stats-grid'},
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Новые пользователи (14 дней)'),
        React.createElement(BarChart,{data:stats.dailyNew,color:'#7c3aed'})
      ),
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Сумма платежей (смешанные валюты)'),
        React.createElement(BarChart,{data:stats.dailyRevenue.map(d=>({...d,n:parseFloat(d.total||0)})),color:'#10b981'})
      ),
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Распределение по планам'),
        React.createElement(PieLegend,{data:stats.planDist,colors:COLORS})
      ),
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Языки'),
        React.createElement(PieLegend,{data:stats.langDist.map(d=>({...d,name:d.language==='ru'?'🇷🇺 Русский':'🇺🇸 English'})),colors:['#7c3aed','#3b82f6']})
      )
    ),
    React.createElement('div',{className:'stats-bottom-grid'},
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Срез по хранению и метрики'),
        React.createElement('div',{className:'info-list'},
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Размер файла БД'),React.createElement('span',null,fmtBytes(stats.storage.dbBytes))),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Тренды'),React.createElement('span',null,stats.storage.trendsCount)),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Notifications'),React.createElement('span',null,stats.storage.notificationsCount)),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Payments'),React.createElement('span',null,stats.storage.paymentsCount)),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Active rate'),React.createElement('span',null,activeShare + '%')),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Paid share'),React.createElement('span',null,paidShare + '%')),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Доход lifetime'),React.createElement('span',null,fmtRevenueByCurrency(stats.revenue.byCurrencyTotal))),
        )
      )
    ),
    // 🧹 Maintenance — DB housekeeping actions. Lives here on Stats because
    // Stats already shows storage usage, so cleanup buttons sit naturally
    // next to the "размер БД" KPI. Previously the alerts-cleanup button was
    // on PaymentsPage which was a semantic mismatch (payments != alerts).
    React.createElement('div',{className:'chart-wrap maintenance-card'},
      React.createElement('div',{className:'chart-title'},'🧹 Обслуживание базы'),
      React.createElement('p',{className:'muted-note',style:{marginBottom:14}},
        'Регулярные cleanup-операции для удержания размера БД. Удалённое необратимо — но ничего критичного: снимаются старые алерты и истёкшие платёжные интенты.'
      ),
      React.createElement('div',{className:'maintenance-actions'},
        React.createElement('button',{className:'btn btn-danger btn-sm',onClick:cleanupAlerts},'🧹 Очистить старые алерты'),
        React.createElement('button',{className:'btn btn-warning btn-sm',onClick:runVacuum, title:'Сжать БД (VACUUM). Блокирует на ~1с.'},'💾 VACUUM'),
        React.createElement('button',{className:'btn btn-secondary btn-sm',onClick:cleanupVideoCache, title:'Удалить muxed видео старше 3 дней.'},'🎞 Video cache'),
        React.createElement('button',{className:'btn btn-secondary btn-sm',onClick:cleanupAuthSessions, title:'Удалить незавершённые auth-сессии старше 24ч.'},'🔑 Auth sessions'),
        React.createElement('button',{className:'btn btn-secondary btn-sm',onClick:rotateLogs, title:'Удалить лог-файлы старше 14 дней.'},'📜 Rotate logs'),
        React.createElement('span',{style:{fontSize:12,color:'var(--text2)'}},'удаляет тренды + notifications старше N дней'),
        maintMsg && React.createElement('span',{className:maintMsg.startsWith('Ошибка')?'error-msg':'success-msg'},maintMsg)
      )
    )
  );
}

// Input that toggles between a number and ∞ (value=-1).
// Used for alert_limit and history_days in plan rows.
function UnlimitedInput({value, onChange}) {
  const isUnlimited = value === -1 || value === '-1';
  return React.createElement('div',{style:{display:'flex',alignItems:'center',gap:4}},
    React.createElement('input',{
      className:'plan-input',
      type:'number',
      disabled:isUnlimited,
      value: isUnlimited ? '' : (value ?? ''),
      style:{width:56, opacity: isUnlimited ? 0.35 : 1},
      onChange: e => onChange(parseInt(e.target.value) || 0)
    }),
    React.createElement('label',{
      title:'Безлимит',
      style:{display:'flex',alignItems:'center',gap:3,cursor:'pointer',fontSize:13,color:'var(--text2)',userSelect:'none'}
    },
      React.createElement('input',{
        type:'checkbox',
        checked:isUnlimited,
        style:{accentColor:'var(--accent)',width:13,height:13,cursor:'pointer'},
        onChange: e => onChange(e.target.checked ? -1 : 0)
      }),
      '∞'
    )
  );
}

function BotPage() {
  const [plans, setPlans] = useState([]);
  const [broadcasts, setBroadcasts] = useState([]);
  const [aiCfg, setAiCfg] = useState(null);
  const [aiDraft, setAiDraft] = useState({ provider: 'xai', model: 'grok-4-1-fast-non-reasoning', stage2Enabled: true, deepReasoningEnabled: false, stage2ReasoningModel: '', escalationReserve: 2 });
  const [aiModels, setAiModels] = useState({ xai: [], openai: [], gemini: [] });
  const [aiModelsError, setAiModelsError] = useState('');
  const [editedPlans, setEditedPlans] = useState({});
  const [msg, setMsg] = useState('');
  // Defaults mirror the rebalanced scheme (admin=5, pro=2.5, test=0.5, free=0.2)
  // — overwritten on first render by the GET /api/feedback-config response.
  const [fbCfg, setFbCfg] = useState({ enabled:true, weightAdmin:5, weightPro:2.5, weightTest:0.5, weightFree:0.2 });
  const [fbSaving, setFbSaving] = useState(false);
  const [recentReasons, setRecentReasons] = useState([]);
  const [bcast, setBcast] = useState('');
  const [bcastPlan, setBcastPlan] = useState('all');
  const [bcastResult, setBcastResult] = useState(null);
  const [manageText, setManageText] = useState('');
  const [managePlan, setManagePlan] = useState('all');
  const [manageResult, setManageResult] = useState(null);
  const [sending, setSending] = useState(false);
  const [managing, setManaging] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  // Sub-tab for BotPage. Splits the previously crammed wall of 7 cards
  // into 3 focused views: AI / Broadcasts (send + manage + history) /
  // Plans & Feedback (plans editor + feedback weights + recent reasons).
  const [subTab, setSubTab] = useState('ai');

  const loadBroadcasts = async () => {
    try { setBroadcasts(await api('/api/broadcasts?limit=30&offset=0')); }
    catch(_) {}
  };

  const loadAiConfig = async () => {
    try {
      const cfg = await api('/api/ai-config');
      setAiCfg(cfg);
      setAiDraft({ provider: cfg.provider, model: cfg.model, stage2Enabled: !!cfg.stage2Enabled, deepReasoningEnabled: !!cfg.deepReasoningEnabled, stage2ReasoningModel: cfg.stage2ReasoningModel || '', escalationReserve: cfg.escalationReserve ?? 2, grokcliModel: cfg.grokcliModel || 'grok-build' });
    } catch (_) {}
  };

  const loadAiModels = async () => {
    try {
      setAiModelsError('');
      const all = await api('/api/ai-models');
      setAiModels({
        xai: all?.xai?.models || [],
        openai: all?.openai?.models || [],
        gemini: all?.gemini?.models || [],
      });
      // Show only actionable errors (e.g. OpenAI / Gemini key missing).
      // Ignore xAI quota noise because xAI list is intentionally fixed.
      const errOpenai = all?.openai?.error || '';
      const errGemini = all?.gemini?.error || '';
      if (errOpenai && (all?.openai?.models || []).length === 0) {
        setAiModelsError(errOpenai);
      } else if (errGemini && (all?.gemini?.models || []).length === 0) {
        setAiModelsError(errGemini);
      }
    } catch (e) {
      setAiModelsError(e.message || 'Failed to load models');
    }
  };

  useEffect(()=>{
    api('/api/plans').then(p=>setPlans(p)).catch(()=>{});
    loadBroadcasts();
    loadAiConfig();
    loadAiModels();
    api('/api/feedback-config').then(c=>setFbCfg(c)).catch(()=>{});
    api('/api/feedback-recent?limit=30').then(d=>setRecentReasons(d.items||[])).catch(()=>{});
  },[]);

  // Refresh recent reasons after the operator saves weights — quick way to
  // verify the panel works without waiting for a new vote
  const reloadRecentReasons = () => {
    api('/api/feedback-recent?limit=30').then(d=>setRecentReasons(d.items||[])).catch(()=>{});
  };

  const setPlanField = (id, field, val) => {
    setEditedPlans(prev=>({...prev,[id]:{...(prev[id]||{}), [field]:val}}));
  };

  const savePlan = async (plan) => {
    const changes = editedPlans[plan.id];
    if (!changes) return;
    setSavingPlan(true);
    try {
      await api('/api/plans/'+plan.id, 'PUT', changes);
      setMsg('✓ План обновлён');
      setPlans(await api('/api/plans'));
      setEditedPlans(prev=>{ const n={...prev}; delete n[plan.id]; return n; });
    } catch(e){ setMsg('Ошибка: '+e.message); }
    finally { setSavingPlan(false); setTimeout(()=>setMsg(''),3000); }
  };

  const saveFbCfg = async () => {
    setFbSaving(true);
    try {
      const saved = await api('/api/feedback-config', 'POST', fbCfg);
      setFbCfg(saved);
      setMsg('✓ Настройки фидбека сохранены');
    } catch(e){ setMsg('Ошибка: '+e.message); }
    finally { setFbSaving(false); setTimeout(()=>setMsg(''),3000); }
  };

  const sendBroadcast = async () => {
    if (!bcast.trim()) return;
    setSending(true);
    try {
      const r = await api('/api/broadcast','POST',{message:bcast,plan:bcastPlan});
      setBcastResult(r);
      setBcast('');
      loadBroadcasts();
    } catch(e){ setBcastResult({error:e.message}); }
    finally { setSending(false); }
  };

  const manageBroadcast = async (action) => {
    if (action === 'edit' && !manageText.trim()) return;
    if (action === 'delete' && !window.confirm('Удалить последнее закрепленное сообщение у всех выбранных пользователей?')) return;

    setManaging(true);
    try {
      const payload = { action, plan: managePlan };
      if (action === 'edit') payload.message = manageText;
      const r = await api('/api/broadcast/manage', 'POST', payload);
      setManageResult(r);
      loadBroadcasts();
    } catch (e) {
      setManageResult({ error: e.message });
    } finally {
      setManaging(false);
    }
  };

  const manageHistoryBroadcast = async (broadcastId, action, originalText='') => {
    let payload = { action };
    if (action === 'edit') {
      const next = window.prompt('Новый текст для этой рассылки:', originalText || '');
      if (next === null) return;
      if (!next.trim()) return;
      payload.message = next;
    }
    if (action === 'delete' && !window.confirm('Удалить это сообщение у всех получателей?')) return;

    setManaging(true);
    try {
      const r = await api('/api/broadcasts/' + broadcastId + '/manage', 'POST', payload);
      setManageResult(r);
      loadBroadcasts();
    } catch (e) {
      setManageResult({ error: e.message });
    } finally {
      setManaging(false);
    }
  };

  const saveAiConfig = async () => {
    setAiSaving(true);
    try {
      const cfg = await api('/api/ai-config', 'POST', {
        provider: aiDraft.provider,
        model: aiDraft.model,
        stage2Enabled: !!aiDraft.stage2Enabled,
        deepReasoningEnabled: !!aiDraft.deepReasoningEnabled,
        stage2ReasoningModel: aiDraft.stage2ReasoningModel || '',
        escalationReserve: aiDraft.escalationReserve ?? 2,
      });
      setAiCfg(cfg);
      setMsg('✓ AI конфигурация обновлена');
      setTimeout(()=>setMsg(''), 2500);
    } catch (e) {
      setMsg('Ошибка AI: ' + e.message);
      setTimeout(()=>setMsg(''), 4000);
    } finally {
      setAiSaving(false);
    }
  };

  const fmtDt = dt => { if (!dt) return '—'; const s = dt.includes('Z')||dt.includes('+') ? dt : dt.replace(' ','T')+'Z'; return new Date(s).toLocaleString('ru',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); };
  const paidPlans = plans.filter(p => ['test','pro'].includes(p.name)).length;

  return React.createElement('div',null,
    React.createElement('div',{className:'page-header'},
      React.createElement('h2',null,'🤖 Управление ботом'),
      React.createElement('p',null,'Рассылки, планы и настройки')
    ),
    React.createElement('div',{className:'cards'},
      React.createElement('div',{className:'card purple'},React.createElement('div',{className:'card-label'},'Broadcast history'),React.createElement('div',{className:'card-value'},broadcasts.length),React.createElement('div',{className:'card-sub'},'Последние сохранённые рассылки')),
      React.createElement('div',{className:'card blue'},React.createElement('div',{className:'card-label'},'Stage 1 provider'),React.createElement('div',{className:'card-value'},(aiCfg?.provider || aiDraft.provider || 'xai').toUpperCase()),React.createElement('div',{className:'card-sub'},aiCfg?.model || aiDraft.model || '—')),
      React.createElement('div',{className:'card green'},React.createElement('div',{className:'card-label'},'Stage 2'),React.createElement('div',{className:'card-value'},(aiCfg?.stage2Enabled ?? aiDraft.stage2Enabled) ? 'ON' : 'OFF'),React.createElement('div',{className:'card-sub'},'x_search через Grok')),
      React.createElement('div',{className:'card yellow'},React.createElement('div',{className:'card-label'},'Paid plans'),React.createElement('div',{className:'card-value'},paidPlans),React.createElement('div',{className:'card-sub'},'Редактируемые тарифы с оплатой'))
    ),

    // Sub-tab strip — 3 focused views instead of one giant scroll
    React.createElement('div',{className:'adm-tabs bordered'},
      [
        ['ai',         '🧠 AI Pipeline'],
        ['broadcasts', '📢 Рассылки'],
        ['plans',      '💰 Планы и фидбек'],
      ].map(([k,l]) => React.createElement('button',{
        key:k,
        className:'adm-tab' + (subTab === k ? ' active' : ''),
        onClick:()=>setSubTab(k)
      }, l))
    ),

    subTab === 'ai' && React.createElement('div',{className:'adm-card'},
      React.createElement('h3',null,'🧠 AI Pipeline'),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},
        'Stage 1: выбранная модель для основного scoring. Stage 2: x_search через Grok (вкл/выкл одним тумблером).'
      ),

      React.createElement('div',{style:{marginBottom:10,fontSize:12,fontWeight:700,color:'var(--text2)'}},'Stage 1 — Основная модель'),
      React.createElement('div',{className:'broadcast-footer',style:{alignItems:'center'}},
        React.createElement('select',{
          className:'filter',
          value:aiDraft.provider,
          onChange:e=>{
            const next = e.target.value;
            const dflt = next === 'openai' ? 'gpt-5.4-mini'
                       : next === 'gemini' ? 'gemini-3.1-flash-lite'
                       : next === 'grokcli' ? 'grok-build'
                       : 'grok-4-1-fast-non-reasoning';
            setAiDraft(prev=>({ ...prev, provider: next, model: dflt }));
          }
        },
          React.createElement('option',{value:'xai'},'xAI (Grok)'),
          React.createElement('option',{value:'openai'},'OpenAI (GPT)'),
          React.createElement('option',{value:'gemini'},'Google (Gemini)'),
          React.createElement('option',{value:'grokcli'},'Grok Build CLI (subscription)')
        ),
        aiDraft.provider === 'grokcli' && React.createElement('span',{className:'badge',style:aiCfg?.grokSessionAlive ? {background:'rgba(16,185,129,.15)',color:'var(--green)'} : {background:'rgba(245,158,11,.15)',color:'var(--yellow)'}},aiCfg?.grokSessionAlive ? 'CLI session: OK' : 'CLI session: expired — run grok login'),
        React.createElement('select',{
          className:'filter',
          style:{minWidth:300,maxWidth:360},
          value:aiDraft.model || '',
          onChange:e=>setAiDraft(prev=>({ ...prev, model: e.target.value }))
        },
          (aiModels[aiDraft.provider] || []).length > 0
            ? (aiModels[aiDraft.provider] || []).map(m => React.createElement('option',{key:m,value:m},m))
            : React.createElement('option',{value:aiDraft.model || ''},aiDraft.model || 'No models loaded')
        ),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:loadAiModels},'↻ Models'),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>setAiDraft(prev=>{
          const dflt = prev.provider === 'openai' ? 'gpt-5.4-mini'
                     : prev.provider === 'gemini' ? 'gemini-3.1-flash-lite'
                     : prev.provider === 'grokcli' ? 'grok-build'
                     : 'grok-4-1-fast-non-reasoning';
          return { ...prev, model: dflt };
        })},'Default')
      ),

      React.createElement('div',{style:{marginTop:12,marginBottom:8,fontSize:12,fontWeight:700,color:'var(--text2)'}},'Stage 2 — X Search (Grok only)'),
      React.createElement('div',{className:'broadcast-footer',style:{alignItems:'center'}},
        React.createElement('label',{style:{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}},
          React.createElement('input',{
            type:'checkbox',
            checked:!!aiDraft.stage2Enabled,
            onChange:e=>setAiDraft(prev=>({ ...prev, stage2Enabled: e.target.checked }))
          }),
          React.createElement('span',null, aiDraft.stage2Enabled ? 'Включено' : 'Отключено')
        ),
        React.createElement('button',{className:'btn btn-primary',onClick:saveAiConfig,disabled:aiSaving||!aiDraft.model?.trim()},aiSaving?'Сохранение...':'💾 Сохранить')
      ),

      React.createElement('div',{style:{marginTop:14,marginBottom:8,fontSize:12,fontWeight:700,color:'var(--text2)'}},'Deep Escalation — reasoning model'),
      React.createElement('div',{className:'broadcast-footer',style:{alignItems:'center',flexWrap:'wrap',gap:8}},
        React.createElement('label',{style:{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}},
          React.createElement('input',{
            type:'checkbox',
            checked:!!aiDraft.deepReasoningEnabled,
            onChange:e=>setAiDraft(prev=>({ ...prev, deepReasoningEnabled: e.target.checked }))
          }),
          React.createElement('span',null, aiDraft.deepReasoningEnabled ? 'Reasoning ON' : 'Reasoning OFF')
        ),
        React.createElement('select',{
          className:'filter',
          style:{minWidth:260,maxWidth:360},
          value:aiDraft.stage2ReasoningModel || '',
          onChange:e=>setAiDraft(prev=>({ ...prev, stage2ReasoningModel: e.target.value }))
        },
          React.createElement('option',{value:''},'— не задано (reasoning off) —'),
          (() => {
            const isReasoning = m => /reasoning|mini/i.test(m) && !/non-reasoning/i.test(m);
            const list = (aiModels.xai || []).filter(isReasoning);
            const cur = aiDraft.stage2ReasoningModel;
            if (cur && !list.includes(cur)) list.unshift(cur);
            return list.map(m => React.createElement('option',{key:m,value:m},m));
          })()
        ),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:loadAiModels},'↻ Models'),
        React.createElement('label',{style:{display:'flex',alignItems:'center',gap:6,fontSize:13}},
          React.createElement('span',null,'Reserve slots:'),
          React.createElement('input',{
            className:'filter',
            type:'number',
            style:{width:60},
            min:0,
            max:20,
            value:aiDraft.escalationReserve ?? 2,
            onChange:e=>setAiDraft(prev=>({ ...prev, escalationReserve: parseInt(e.target.value,10)||0 }))
          })
        )
      ),
      React.createElement('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,lineHeight:1.4}},
        'Reasoning активен только когда тумблер ON и модель выбрана (список — Grok-модели, ↻ Models обновляет). Reserve = сколько Stage 2 слотов отдаётся под эскалированные тренды.'
      ),

      aiModelsError && React.createElement('div',{className:'mt16',style:{fontSize:12,color:'var(--red)'}},'Models API: ' + aiModelsError),
      aiCfg && React.createElement('div',{className:'mt16',style:{fontSize:12,color:'var(--text2)'}},
        'Текущий Stage 1: ' + aiCfg.provider + ':' + aiCfg.model +
        ' | Stage 2: ' + (aiCfg.stage2Enabled ? 'ON' : 'OFF') +
        ' | key xAI: ' + (aiCfg.hasXaiKey ? 'yes' : 'no') +
        ' | key OpenAI: ' + (aiCfg.hasOpenaiKey ? 'yes' : 'no') +
        ' | key Gemini: ' + (aiCfg.hasGeminiKey ? 'yes' : 'no') +
        ' | grokcli session: ' + (aiCfg.grokSessionAlive ? 'alive' : 'expired')
      )
    ),

    // Broadcasts sub-tab — Send / Manage / History
    subTab === 'broadcasts' && React.createElement('div',{className:'adm-card'},
      React.createElement('h3',null,'📢 Рассылка сообщений'),
      React.createElement('textarea',{className:'msg-input',placeholder:'Введите сообщение... Поддерживается HTML: <b>жирный</b>, <i>курсив</i>, <a href="">ссылка</a>',value:bcast,onChange:e=>setBcast(e.target.value)}),
      React.createElement('div',{className:'broadcast-footer'},
        React.createElement('select',{className:'filter',value:bcastPlan,onChange:e=>setBcastPlan(e.target.value)},
          React.createElement('option',{value:'all'},'Все пользователи'),
          React.createElement('option',{value:'free'},'Только Free'),
          React.createElement('option',{value:'test'},'Только Test'),
          React.createElement('option',{value:'pro'},'Только Pro'),
        ),
        React.createElement('button',{className:'btn btn-primary',onClick:sendBroadcast,disabled:sending||!bcast.trim()},sending?'Отправка...':'📤 Отправить'),
        bcastResult&&!bcastResult.error&&React.createElement('span',{className:'success-msg'},'✓ Отправлено: '+bcastResult.sent+', ошибок: '+bcastResult.failed),
        bcastResult&&bcastResult.error&&React.createElement('span',{className:'error-msg'},'Ошибка: '+bcastResult.error)
      )
    ),

    // 🛠 Manage last pinned broadcast — edit/unpin/delete by plan filter.
    subTab === 'broadcasts' && React.createElement('div',{className:'adm-card'},
      React.createElement('h3',null,'🛠 Управление последней рассылкой'),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},'Работает с последним закрепленным рассылочным сообщением у каждого пользователя.'),
      React.createElement('textarea',{
        className:'msg-input',
        placeholder:'Новый текст для кнопки "Обновить текст" (HTML поддерживается)',
        value:manageText,
        onChange:e=>setManageText(e.target.value)
      }),
      React.createElement('div',{className:'broadcast-footer'},
        React.createElement('select',{className:'filter',value:managePlan,onChange:e=>setManagePlan(e.target.value)},
          React.createElement('option',{value:'all'},'Все пользователи'),
          React.createElement('option',{value:'free'},'Только Free'),
          React.createElement('option',{value:'test'},'Только Test'),
          React.createElement('option',{value:'pro'},'Только Pro'),
        ),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>manageBroadcast('edit'),disabled:managing||!manageText.trim()},managing?'...':'✏️ Обновить текст'),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>manageBroadcast('unpin'),disabled:managing},managing?'...':'📌 Открепить у всех'),
        React.createElement('button',{className:'btn btn-danger btn-sm',onClick:()=>manageBroadcast('delete'),disabled:managing},managing?'...':'🗑 Удалить у всех')
      ),
      manageResult&&!manageResult.error&&React.createElement('div',{className:'mt16'},React.createElement('span',{className:'success-msg'},
        'Готово: ' + (manageResult.action || '-') + ' | успех: ' + (manageResult.success || 0) + ', ошибок: ' + (manageResult.failed || 0) + ', всего: ' + (manageResult.total || 0)
      )),
      manageResult&&manageResult.error&&React.createElement('div',{className:'mt16'},React.createElement('span',{className:'error-msg'},'Ошибка: '+manageResult.error))
    ),

    subTab === 'broadcasts' && React.createElement('div',{className:'adm-card'},
      React.createElement('h3',null,'🗂 История рассылок'),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},'Можно отредактировать, открепить или удалить конкретную рассылку у всех получателей.'),
      broadcasts.length === 0
        ? React.createElement('div',{className:'empty'},'История пока пустая')
        : React.createElement('div',{style:{display:'flex',flexDirection:'column',gap:10}},
            broadcasts.map(b => React.createElement('div',{key:b.id,style:{border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',background:'var(--bg2)'}},
              React.createElement('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'center'}},
                React.createElement('div',null,
                  React.createElement('div',{style:{fontWeight:700,fontSize:13}},'#' + b.id + ' • ' + fmtDt(b.created_at) + ' • plan: ' + (b.plan_filter || 'all')),
                  React.createElement('div',{style:{fontSize:12,color:'var(--text2)'}},'sent: ' + (b.sent_count || 0) + ', failed: ' + (b.failed_count || 0) + ', deliveries: ' + (b.deliveries || 0))
                ),
                React.createElement('div',{className:'btn-row'},
                  React.createElement('button',{className:'btn btn-ghost btn-sm',disabled:managing,onClick:()=>manageHistoryBroadcast(b.id,'edit',b.message_html||'')},'✏️'),
                  React.createElement('button',{className:'btn btn-ghost btn-sm',disabled:managing,onClick:()=>manageHistoryBroadcast(b.id,'unpin')},'📌'),
                  React.createElement('button',{className:'btn btn-danger btn-sm',disabled:managing,onClick:()=>manageHistoryBroadcast(b.id,'delete')},'🗑')
                )
              ),
              React.createElement('div',{style:{fontSize:12,color:'var(--text2)',marginTop:8,whiteSpace:'pre-wrap',maxHeight:70,overflow:'hidden'}},b.message_html || '')
            ))
          )
    ),

    // Plans & Feedback sub-tab — Plans / Feedback weights / Recent reasons
    subTab === 'plans' && React.createElement('div',{className:'adm-card'},
      React.createElement('h3',null,'💰 Настройка планов'),
      // alert_limit and history_days columns removed 2026-05-06 — both fields
      // are dead in the DB. Plan rights are now configured in
      // src/billing/entitlements.js (sources, manualAnalyze cap, catalyst
      // cap, historyHours). Price is the only thing the admin still tunes
      // here. The DB columns stay (legacy), they're just no longer surfaced.
      React.createElement('div',{style:{fontSize:12,color:'var(--text2)',marginBottom:12,padding:'8px 12px',background:'var(--bg3)',borderRadius:6,border:'1px solid var(--border)'}},
        '⚠ Лимиты по фичам (источники, кап Manual analyze / Catalyst, окно истории) теперь живут в коде — src/billing/entitlements.js. Здесь правится только цена плана.'
      ),
      React.createElement('div',{style:{borderRadius:8,overflow:'hidden',border:'1px solid var(--border)'}},
        React.createElement('div',{className:'plan-row plan-head'},
          React.createElement('span',null,'План'),
          React.createElement('span',null,'Цена (USD)'),
          React.createElement('span',null,'Источники / save'),
        ),
        plans.map(p=>{
          const ed = editedPlans[p.id]||{};
          return React.createElement('div',{key:p.id,className:'plan-row'},
            React.createElement('span',null,React.createElement('span',{className:'badge badge-'+p.name},p.name)),
            React.createElement('input',{className:'plan-input',type:'number',step:'0.01',defaultValue:p.price_usd||0,onChange:e=>setPlanField(p.id,'price_usd',parseFloat(e.target.value))}),
            editedPlans[p.id]
              ? React.createElement('button',{className:'btn btn-primary btn-sm',onClick:()=>savePlan(p),disabled:savingPlan},'Сохранить')
              : React.createElement('span',{style:{fontSize:12,color:'var(--text2)'}},p.sources?'src: '+p.sources:'')
          );
        })
      ),
      msg&&React.createElement('div',{className:'mt16',style:{}},React.createElement('span',{className:msg.includes('Ошибка')?'error-msg':'success-msg'},msg))
    ),

    // ── Feedback Weighting ──────────────────────────────────────────────
    subTab === 'plans' && React.createElement('div',{className:'adm-card'},
      React.createElement('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}},
        React.createElement('h3',{style:{margin:0}},'👍 Взвешенный фидбек'),
        React.createElement('label',{style:{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}},
          React.createElement('input',{
            type:'checkbox', checked:!!fbCfg.enabled,
            style:{accentColor:'var(--accent)',width:15,height:15,cursor:'pointer'},
            onChange:e=>setFbCfg(prev=>({...prev,enabled:e.target.checked}))
          }),
          React.createElement('span',{style:{color: fbCfg.enabled?'var(--accent)':'var(--text2)'}},
            fbCfg.enabled ? 'Включено' : 'Выключено'
          )
        )
      ),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginTop:0,marginBottom:14}},
        fbCfg.enabled
          ? 'Реакции 👍 и 👎 учитываются с разным весом в зависимости от плана. Влияет на rankScore нарратива.'
          : '⚠️ Взвешивание выключено — учитываются только голоса Admin. Остальные игнорируются.'
      ),
      React.createElement('div',{style:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,opacity: fbCfg.enabled?1:0.4,pointerEvents: fbCfg.enabled?'auto':'none'}},
        ...[
          {key:'weightAdmin', label:'👑 Admin',  color:'#f87171'},
          {key:'weightPro',   label:'🚀 Pro',    color:'var(--accent)'},
          {key:'weightTest',  label:'🧪 Test',   color:'var(--text2)'},
          {key:'weightFree',  label:'🆓 Free',   color:'var(--text2)'},
        ].map(({key,label,color})=>
          React.createElement('div',{key,style:{background:'var(--bg3)',borderRadius:8,padding:'10px 12px',border:'1px solid var(--border)'}},
            React.createElement('div',{style:{fontSize:12,color,fontWeight:600,marginBottom:6}},label),
            React.createElement('div',{style:{display:'flex',alignItems:'center',gap:6}},
              React.createElement('input',{
                className:'plan-input',type:'number',min:0.1,max:10,step:0.1,
                style:{width:64},
                value: fbCfg[key] ?? 1,
                onChange: e=>setFbCfg(prev=>({...prev,[key]:parseFloat(e.target.value)||1}))
              }),
              React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},'× вес')
            )
          )
        )
      ),
      React.createElement('div',{style:{marginTop:14,display:'flex',alignItems:'center',gap:12}},
        React.createElement('button',{className:'btn btn-primary btn-sm',onClick:saveFbCfg,disabled:fbSaving},
          fbSaving ? 'Сохранение...' : 'Сохранить'
        ),
        React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},
          'Применяется к новым реакциям мгновенно, без перезапуска'
        )
      )
    ),

    // Recent feedback reasons panel — voice-of-the-user view. Populated by the
    // Telegram "Reason for rating" wizard. Helps the operator see what users
    // actually think (free text), not just aggregate +/- counts.
    // (Reminder: this whole file lives inside a template literal — do NOT use
    //  backticks in comments. Use single quotes only.)
    subTab === 'plans' && React.createElement('div',{className:'adm-card',style:{marginTop:14}},
      React.createElement('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}},
        React.createElement('h3',{style:{margin:0}},'💬 Причины оценок (последние)'),
        React.createElement('button',{className:'btn btn-sm',onClick:reloadRecentReasons,style:{fontSize:11}},
          '↻ Обновить'
        )
      ),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginTop:0,marginBottom:14}},
        'Свободные комментарии от юзеров, привязанные к их 👍/👎 в Telegram. Эти причины пробрасываются в Stage 1 промпт AI.'
      ),
      recentReasons.length === 0
        ? React.createElement('div',{style:{fontSize:13,color:'var(--text2)',padding:16,textAlign:'center'}},
            'Пока нет причин — юзеры либо не голосовали с пояснением, либо ещё не нажимали «Причина оценки».'
          )
        : React.createElement('div',{style:{maxHeight:380,overflowY:'auto',display:'flex',flexDirection:'column',gap:8}},
            ...recentReasons.map((r,i) => {
              const voteIcon = r.vote > 0 ? '👍' : '👎';
              const planColor =
                r.plan_name === 'admin' ? '#f87171' :
                r.plan_name === 'pro'   ? 'var(--accent)' :
                r.plan_name === 'test'  ? '#fbbf24' : 'var(--text2)';
              const dt = new Date(r.created_at + 'Z');
              const timeStr = isNaN(dt.getTime()) ? r.created_at : dt.toLocaleString();
              return React.createElement('div',{
                key: i,
                style: {
                  background:'var(--bg3)',
                  border:'1px solid var(--border)',
                  borderRadius:6,
                  padding:'8px 10px',
                  fontSize:13,
                  display:'flex',
                  flexDirection:'column',
                  gap:4,
                }
              },
                React.createElement('div',{style:{display:'flex',alignItems:'center',gap:8,fontSize:11,color:'var(--text2)'}},
                  React.createElement('span',{style:{fontSize:14}},voteIcon),
                  React.createElement('span',{style:{color:planColor,fontWeight:600,textTransform:'uppercase'}},r.plan_name||'free'),
                  React.createElement('span',null,'× '+(r.weight??1)),
                  React.createElement('span',{style:{marginLeft:'auto'}},timeStr),
                ),
                React.createElement('div',{style:{fontWeight:600,color:'var(--text)'}},'"'+(r.title||'')+'"'),
                React.createElement('div',{style:{color:'var(--text2)',fontStyle:'italic'}},r.reason||'')
              );
            })
          )
    )
  );
}

// ── ScoreBar (visual progress bar 0-100) — used in SubmitPage ───────────────
// Renders via .sp-bar-* CSS classes so it matches the rest of the admin
// design system (no ad-hoc inline colors, picks tones from CSS vars). The
// "sub" prop accepts any React node and is rendered under the bar (used
// for storyHook quotes).
function AdminScoreBar({ label, value, sub, color }) {
  const v = Math.max(0, Math.min(100, Math.round(value || 0)));
  // Pick the bar fill color from design tokens. Override allowed via prop.
  const c = color
    || (v >= 80 ? 'var(--green)'
      : v >= 60 ? '#84cc16'
      : v >= 40 ? 'var(--yellow)'
      : v >= 20 ? '#ff7849'
      : 'var(--text2)');
  return React.createElement('div', { className: 'sp-bar' },
    React.createElement('div', { className: 'sp-bar-head' },
      React.createElement('span', { className: 'sp-bar-label' }, label),
      React.createElement('span', { className: 'sp-bar-val', style: { color: c } }, v + '/100')
    ),
    React.createElement('div', { className: 'sp-bar-track' },
      React.createElement('div', { className: 'sp-bar-fill', style: { width: v + '%', background: c } })
    ),
    sub ? React.createElement('div', { className: 'sp-bar-sub' }, sub) : null
  );
}

// ── AdminTriggerSection — Grok deep-search button + result render ──────────
// Local React state holds the optimistic-update path: clicking the button
// fires POST /api/trends/:id/trigger, replaces section content with the
// returned payload (text + sources + confidence). If a trigger already
// exists on the trend (fresh from DB), button is replaced by content.
function AdminTriggerSection({ trend, onUpdate }) {
  const [data, setData]       = useState(trend.triggerText ? { text: trend.triggerText, sources: trend.triggerSources || [], confidence: trend.triggerConfidence || 0 } : null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const onSearch = async () => {
    if (loading || !trend.id) return;
    setLoading(true); setError(null);
    try {
      const res = await api('/api/trends/' + trend.id + '/trigger', 'POST', {});
      if (res && res.text) {
        const next = { text: res.text, sources: res.sources || [], confidence: res.confidence | 0 };
        setData(next);
        if (typeof onUpdate === 'function') onUpdate(next);
      } else {
        setError('Пустой ответ от Grok — попробуй позже');
      }
    } catch (e) {
      setError(e.message || 'Ошибка поиска триггера');
    } finally {
      setLoading(false);
    }
  };

  // State 1: have a trigger payload — render text + sources + confidence
  if (data && data.text) {
    return React.createElement('div', { className: 'sp-block accent-trigger' },
      React.createElement('div', { className: 'sp-block-label' }, '💡 Триггер (Grok deep)'),
      React.createElement('div', { style: { fontSize: 13, lineHeight: 1.5, color: 'var(--text)' } }, data.text),
      Array.isArray(data.sources) && data.sources.length > 0
        ? React.createElement('div', { className: 'sp-trigger-sources' },
            'Источники: ',
            data.sources.map((s, i) => {
              const handle = s.startsWith('@') ? s.slice(1) : s;
              return React.createElement('a', {
                key: 'src' + i,
                href: 'https://x.com/' + encodeURIComponent(handle),
                target: '_blank', rel: 'noopener',
              }, '@' + handle);
            })
          )
        : null,
      typeof data.confidence === 'number' && data.confidence > 0
        ? React.createElement('div', { className: 'sp-trigger-conf' }, 'Уверенность: ' + data.confidence + '%')
        : null
    );
  }

  // State 2/3: no trigger yet — show whyNow as fallback + search button
  return React.createElement('div', { className: 'sp-block accent-trigger' },
    React.createElement('div', { className: 'sp-block-label' }, '💡 Триггер'),
    trend.whyNow
      ? React.createElement('div', { style: { fontSize: 13, lineHeight: 1.5, color: 'var(--text)' } }, trend.whyNow)
      : React.createElement('div', { style: { fontSize: 12, color: 'var(--text2)', fontStyle: 'italic' } }, 'Stage 1 не нашёл явного триггера'),
    React.createElement('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      React.createElement('button', {
        className: 'btn btn-primary btn-sm',
        disabled: loading || !trend.id,
        onClick: onSearch,
        title: 'Запустить Grok x_search для поиска конкретного триггера',
      }, loading ? '⏳ Поиск...' : '🔍 Найти триггер (Grok)'),
      error ? React.createElement('span', { className: 'sp-error-inline' }, '⚠ ' + error) : null
    )
  );
}

// ── Collapsible — accordion section used inside ManualResultCard ────────────
// Content stays in DOM only when open (cheap unmount keeps virtual DOM small
// for cards with 5+ sections). Header click toggles. Default state is
// supplied by the caller — primary sections open, advanced sections closed.
// The accent prop is one of "prestage" | "stage2" | undefined — it adds the
// matching .sp-collapsible.accent-* class which tints the bg/border
// consistently with .sp-block tones used elsewhere in the page.
function Collapsible({ title, defaultOpen, children, accent }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const cls = 'sp-collapsible' + (accent ? ' accent-' + accent : '');
  return React.createElement('div', { className: cls },
    React.createElement('button', {
      type: 'button',
      onClick: () => setOpen(!open),
      className: 'sp-collapsible-head' + (open ? ' open' : ''),
    },
      React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, title),
      React.createElement('span', { className: 'sp-collapsible-arrow' }, open ? '▲' : '▼')
    ),
    open && React.createElement('div', { className: 'sp-collapsible-body' }, children)
  );
}

// Pretty relative time ("2 мин назад" / "1 ч назад" / "вчера" / dd.mm).
// Used by the history strip to label submission age. Inputs are ISO strings
// (manualSubmittedAt or first_seen_at fallback). Returns "—" on unparseable.
function relTimeRu(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 45) return 'только что';
  const min = Math.round(sec / 60);
  if (min < 45) return min + ' мин назад';
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + ' ч назад';
  const day = Math.round(hr / 24);
  if (day === 1) return 'вчера';
  if (day < 7) return day + ' дн назад';
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return dd + '.' + mm;
}

function srcIcon(src) {
  return src === 'twitter' ? '🐦' : src === 'reddit' ? '🟠' : src === 'tiktok' ? '🎵' : '🌐';
}

// ── ManualHistoryItem — one card in the horizontal history strip ────────────
// Compact: thumbnail + title (2 lines clamp) + score chip + age. Click body
// to select; trash button removes from history (the row itself stays in DB —
// only the manualSubmitted flag is cleared via DELETE /api/manual-trends/:id).
function ManualHistoryItem({ item, active, onSelect, onDelete }) {
  const t = item.trend || {};
  const meme = t.memePotential || 0;
  const pillTone = meme >= 70 ? 'high' : meme >= 40 ? 'mid' : meme >= 20 ? 'low' : 'cold';
  const thumb = (t.imageUrls && t.imageUrls[0]) || null;
  return React.createElement('div', {
    className: 'sp-hist-card' + (active ? ' active' : ''),
    onClick: () => onSelect(t.id),
  },
    React.createElement('div', { className: 'sp-hist-row' },
      thumb
        ? React.createElement('img', { src: thumb, alt: '', loading: 'lazy', className: 'sp-hist-thumb' })
        : React.createElement('div', { className: 'sp-hist-thumb-fallback' }, srcIcon(t.source)),
      React.createElement('div', { className: 'sp-hist-text' },
        React.createElement('div', { className: 'sp-hist-title' }, t.title || '(без заголовка)'),
        React.createElement('div', { className: 'sp-hist-meta' }, '#' + t.id + ' · ' + (t.source || '—'))
      )
    ),
    React.createElement('div', { className: 'sp-hist-foot' },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        React.createElement('span', { className: 'sp-hist-pill ' + pillTone }, '💎 ' + meme),
        React.createElement('span', { className: 'sp-hist-time' }, relTimeRu(item.submittedAt))
      ),
      React.createElement('button', {
        type: 'button',
        className: 'sp-hist-trash',
        onClick: (e) => { e.stopPropagation(); onDelete(t.id); },
        title: 'Удалить из истории (тренд останется в БД)',
      }, '🗑')
    )
  );
}

// ── ManualResultCard — the big detail card (hero + scores + sections) ───────
// Receives a single history entry { trend, pipeline, alerts? } plus a
// callback so the "Отправить алерт" button can update local alerts state
// after a broadcast finishes.
function ManualResultCard({ result, comment, setComment, onAlertSent }) {
  const [alertLoading, setAlertLoading] = useState(false);
  const [alertError, setAlertError]   = useState('');

  const COMMENT_MAX = 500;
  const t = result?.trend;
  if (!t) return null;

  const sendAlertNow = async () => {
    if (!t.id) return;
    const trimmed = (comment || '').trim();
    const confirmMsg = trimmed
      ? ('Отправить нарратив в Telegram с комментарием:' + String.fromCharCode(10) + String.fromCharCode(10) + '«' + trimmed + '»' + String.fromCharCode(10) + String.fromCharCode(10) + 'Всем активным подписчикам?')
      : 'Отправить этот нарратив в Telegram всем активным подписчикам?';
    if (!window.confirm(confirmMsg)) return;
    setAlertError(''); setAlertLoading(true);
    try {
      const res = await api('/api/send-alert', 'POST', { trendId: t.id, comment: trimmed });
      if (typeof onAlertSent === 'function') onAlertSent(res.alerts || []);
    } catch (e) {
      setAlertError(e.message || 'Не удалось отправить алерт');
    } finally {
      setAlertLoading(false);
    }
  };

  const memeCls = t.memePotential >= 80 ? 'hot' : t.memePotential >= 60 ? 'warm' : '';
  const heroThumb = (t.imageUrls && t.imageUrls[0]) || null;
  const commentLen = (comment || '').length;

  return React.createElement('div', { className: 'sp-detail' },
    // ── HERO BLOCK ───────────────────────────────────────────────────────
    React.createElement('div', { className: 'sp-hero' },
      heroThumb
        ? React.createElement('img', { src: heroThumb, alt: '', loading: 'lazy', className: 'sp-hero-thumb' })
        : React.createElement('div', { className: 'sp-hero-thumb-fallback' }, srcIcon(t.source)),
      React.createElement('div', { className: 'sp-hero-body' },
        React.createElement('div', { className: 'sp-hero-row' },
          React.createElement('div', { className: 'sp-hero-title' }, t.title),
          React.createElement('span', { className: 'sp-pill manual' }, '🧪 MANUAL')
        ),
        React.createElement('div', { className: 'sp-hero-meta' },
          '#' + t.id + ' · ' + srcIcon(t.source) + ' ' + t.source +
          // Cache hit → "из кэша · X мин назад" (free, instant). Otherwise
          // show real elapsed seconds. Mutually exclusive — one of the two.
          (result.fromCache
            ? ' · 💾 из кэша · ' + Math.max(1, Math.round((result.cacheAgeMs || 0) / 60000)) + ' мин назад'
            : (result.elapsedMs ? ' · ' + (result.elapsedMs / 1000).toFixed(1) + 's' : '')) +
          (result.submittedAt ? ' · ' + relTimeRu(result.submittedAt) : '')
        ),
        React.createElement('div', { className: 'sp-hero-actions' },
          t.url && React.createElement('a', { href: t.url, target: '_blank', className: 'btn btn-ghost btn-sm' }, '🔗 Источник'),
          React.createElement('button', {
            className: 'btn btn-primary btn-sm',
            onClick: sendAlertNow,
            disabled: alertLoading,
            title: 'Разослать этот нарратив в Telegram всем активным подписчикам',
          }, alertLoading ? '⏳ Отправка...' : '📨 Отправить алерт')
        )
      )
    ),

    React.createElement('div', { className: 'sp-detail-body' },
      alertError && React.createElement('div', { className: 'sp-toast err' }, '⚠ ' + alertError),

      // Per-card comment editor for the "Отправить алерт" button.
      React.createElement('div', null,
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
          React.createElement('label', { className: 'sp-form-label', style: { marginBottom: 0 } }, '💬 Комментарий к алерту (необязательно)'),
          React.createElement('span', { className: 'sp-counter' + (commentLen > COMMENT_MAX ? ' over' : '') }, commentLen + '/' + COMMENT_MAX)
        ),
        React.createElement('textarea', {
          className: 'sp-textarea',
          value: comment || '',
          onChange: e => setComment(e.target.value.slice(0, COMMENT_MAX + 50)),
          placeholder: 'Префикс жирной строкой в начале алерта',
          rows: 2,
        })
      ),

      // ── PIPELINE TRACE ─────────────────────────────────────────────────
      result.pipeline && React.createElement('div', { className: 'sp-trace' },
        React.createElement('span', { className: 'sp-pill ' + (result.pipeline.stage1Ran ? 'ok' : 'skipped') },
          (result.pipeline.stage1Ran ? '✓' : '✗') + ' Stage 1'
        ),
        React.createElement('span', {
          className: 'sp-pill ' + (result.pipeline.stage2Ran ? 'ok' : 'warn'),
          title: result.pipeline.stage2SkipReason || 'Stage 2 ran',
        }, (result.pipeline.stage2Ran ? '✓' : '⏭') + ' Stage 2' + (result.pipeline.stage2SkipReason ? ' — ' + result.pipeline.stage2SkipReason : ''))
      ),

      // ── SCORE GRID (compact tiles) ────────────────────────────────────
      React.createElement('div', { className: 'sp-score-grid' },
        spTile('💎 Meme',      t.memePotential   || 0, memeCls),
        spTile('📈 Score',     t.score           || 0),
        spTile('🚀 Alert',     t.alertScore      || 0),
        spTile('✨ Emergence', t.emergenceScore  || 0),
        spTile('🔥 Adoption',  t.adoptionScore   || 0),
        t.viralityScore != null && spTile('⚡ Virality', t.viralityScore),
        (t.storyScore || 0) > 0 && spTile('📖 Story', t.storyScore),
        (t.junkPenalty || 0) > 0 && spTile('🗑 Junk',  t.junkPenalty, 'bad'),
        t.stage2NameBonus && spTile('🏷 Name str.', t.stage2NameBonus.nameStrength || 0)
      ),

      // ── SCORE BARS ─────────────────────────────────────────────────────
      React.createElement('div', { className: 'sp-bars' },
        React.createElement(AdminScoreBar, { label: '🌊 Emergence', value: t.emergenceScore || 0 }),
        React.createElement(AdminScoreBar, { label: '🔥 Adoption',  value: t.adoptionScore  || t.memePotential || 0 }),
        (t.storyScore || 0) > 0 && React.createElement(AdminScoreBar, {
          label: '📖 Story',
          value: t.storyScore,
          sub: t.storyHook
            ? React.createElement('span', null,
                React.createElement('span', { style: { color: 'var(--text2)', marginRight: 6 } }, 'Hook:'),
                React.createElement('span', { style: { color: 'var(--text)', fontStyle: 'italic' } }, '“' + t.storyHook + '”')
              )
            : null
        })
      ),

      // ── TRIGGER (always visible) ───────────────────────────────────────
      React.createElement(AdminTriggerSection, { trend: t }),

      // ── AI EXPLANATION (always visible) ───────────────────────────────
      t.aiExplanation && React.createElement('div', { className: 'sp-block' },
        React.createElement('div', { className: 'sp-block-label' }, '🤖 AI объяснение'),
        React.createElement('div', { className: 'sp-narrative' }, t.aiExplanation)
      ),

      // ── DESCRIPTION (always visible — capped to 600 chars) ────────────
      t.description && t.description.trim() &&
        React.createElement('div', { className: 'sp-block' },
          React.createElement('div', { className: 'sp-block-label' }, '📝 Описание поста'),
          React.createElement('div', { className: 'sp-narrative' },
            t.description.length > 600 ? t.description.slice(0, 600) + '…' : t.description
          )
        ),

      // ── META CHIPS (compact, above the advanced sections) ─────────────
      React.createElement('div', { className: 'sp-meta-chips' },
        // Alert-type chip — first slot. Class variants paint per-type colour.
        t.alertType && React.createElement('span', {
          className: 'sp-chip sp-chip-atype sp-chip-atype-' + t.alertType
        }, (t.alertType === 'event' ? '📰 СОБЫТИЕ'
          : t.alertType === 'trend' ? '📈 ТРЕНД'
          : '🚀 ПОСТ')),
        t.category && React.createElement('span', { className: 'sp-chip' }, '📁 ' + t.category),
        t.sentiment && React.createElement('span', { className: 'sp-chip' }, '💭 ' + t.sentiment),
        t.predictedLifespan && React.createElement('span', { className: 'sp-chip' }, '⏱ ' + t.predictedLifespan),
        t.narrativePhase && React.createElement('span', { className: 'sp-chip' }, '🌀 ' + t.narrativePhase),
        t.marketStage && t.marketStage !== 'none' && React.createElement('span', { className: 'sp-chip' }, '📊 ' + t.marketStage)
      ),

      // ── Legacy marker: trend was scored before PreStage existed (or
      // PreStage was disabled at scoring time). Hot-refresh re-scores from
      // DB but never recreates the preStage blob, so old trends keep their
      // null preStage forever. Show a subtle dashed chip so admin doesn't
      // mistake a missing block for a bug.
      (!t.preStage || (!t.preStage.nano && !t.preStage.gemini)) &&
        React.createElement('div', {
          style: {
            fontSize: 11, color: 'var(--text2)', marginTop: 6,
            padding: '6px 10px',
            border: '1px dashed rgba(255,255,255,.12)',
            borderRadius: 6,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'rgba(255,255,255,.02)',
          },
          title: 'Этот тренд был заскорен до того, как у тебя включился Stage 0 PreStage (nano + gemini), либо у него не было ни текста для nano, ни картинки/видео для gemini. Hot-refresh не пересоздаёт preStage — данные останутся пустыми навсегда.'
        },
          React.createElement('span', null, '📭'),
          React.createElement('span', null, 'No PreStage data (legacy trend)')
        ),

      // ── COLLAPSIBLE: PreStage (Stage 0 nano + gemini) ─────────────────
      t.preStage && (t.preStage.nano || t.preStage.gemini) &&
        React.createElement(Collapsible, { title: '🎨 Stage 0 PreStage (контекст для скорера)', accent: 'prestage', defaultOpen: false },
          // Nano sub-block
          t.preStage.nano && React.createElement('div', {
            style: t.preStage.gemini
              ? { marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid rgba(124,58,237,.18)' }
              : null
          },
            React.createElement('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--text2)', marginBottom: 4, letterSpacing: '.3px' } }, '📝 Nano (gpt-5.4-nano)'),
            t.preStage.nano.topicSummary && React.createElement('div', { style: { fontSize: 13, color: 'var(--text)', marginBottom: 4 } },
              React.createElement('span', { style: { color: 'var(--text2)' } }, 'Тема: '),
              t.preStage.nano.topicSummary
            ),
            Array.isArray(t.preStage.nano.entityCanonical) && t.preStage.nano.entityCanonical.length > 0 &&
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text)', marginBottom: 4 } },
                React.createElement('span', { style: { color: 'var(--text2)' } }, 'Сущности: '),
                t.preStage.nano.entityCanonical.join(', ')
              ),
            t.preStage.nano.slangDecoded && t.preStage.nano.slangDecoded.trim() &&
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text)', marginBottom: 4, fontStyle: 'italic' } },
                React.createElement('span', { style: { color: 'var(--text2)', fontStyle: 'normal' } }, 'Slang: '),
                t.preStage.nano.slangDecoded
              ),
            t.preStage.nano.language && t.preStage.nano.language !== 'en' &&
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text2)' } }, 'lang=' + t.preStage.nano.language)
          ),
          // Gemini sub-block
          t.preStage.gemini && React.createElement('div', null,
            React.createElement('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--text2)', marginBottom: 4, letterSpacing: '.3px' } },
              '🎬 Gemini (' + (t.preStage.gemini.mediaType || 'visual') + ')' +
              (t.preStage.gemini.videoTruncated
                ? (t.preStage.gemini.truncationReason === 'duration_exceeded'
                    ? ' · видео > ' + (t.preStage.gemini.videoMaxSec || 30) + 's, использован poster'
                    : t.preStage.gemini.truncationReason === 'native_unavailable'
                      ? ' · нативное видео недоступно, использован poster'
                      : ' · использован poster')
                : (t.preStage.gemini.videoClipped
                    ? ' · обрезано до первых ' + (t.preStage.gemini.videoMaxSec || 30) + 's'
                    : '')) +
              (t.preStage.gemini.videoDurationSec ? ' · ' + t.preStage.gemini.videoDurationSec.toFixed(1) + 's' : '')
            ),
            t.preStage.gemini.visualCaption && React.createElement('div', { style: { fontSize: 13, color: 'var(--text)', marginBottom: 4 } },
              React.createElement('span', { style: { color: 'var(--text2)' } }, 'Визуал: '),
              t.preStage.gemini.visualCaption
            ),
            t.preStage.gemini.videoSummary && t.preStage.gemini.videoSummary.trim() &&
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text)', marginBottom: 4 } },
                React.createElement('span', { style: { color: 'var(--text2)' } }, 'Видео: '),
                t.preStage.gemini.videoSummary
              ),
            t.preStage.gemini.audioSummary && t.preStage.gemini.audioSummary.trim() &&
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text)', marginBottom: 4 } },
                React.createElement('span', { style: { color: 'var(--text2)' } }, '🎤 Аудио: '),
                t.preStage.gemini.audioSummary
              ),
            t.preStage.gemini.spokenText && t.preStage.gemini.spokenText.trim() &&
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text)', marginBottom: 4 } },
                React.createElement('span', { style: { color: 'var(--text2)' } }, '💬 Речь: '),
                React.createElement('span', { style: { fontStyle: 'italic' } }, '"' + t.preStage.gemini.spokenText + '"')
              ),
            t.preStage.gemini.visibleText && t.preStage.gemini.visibleText.trim() &&
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text)', marginBottom: 4 } },
                React.createElement('span', { style: { color: 'var(--text2)' } }, 'Текст в кадре: '),
                React.createElement('span', { style: { fontStyle: 'italic' } }, '"' + t.preStage.gemini.visibleText + '"')
              ),
            // Scoring signals row — Gemini's own voting (memeShape, hasNarrative,
            // hasSubject, viralPattern, tickerSuggestion). Shown as compact chips
            // so the admin can see Gemini's prior at a glance.
            (Number.isFinite(t.preStage.gemini.memeShapeStrength)
                || typeof t.preStage.gemini.hasNarrative === 'boolean'
                || typeof t.preStage.gemini.hasSubject === 'boolean'
                || t.preStage.gemini.viralPattern
                || (t.preStage.gemini.tickerSuggestion && t.preStage.gemini.tickerSuggestion.trim())
                || t.preStage.gemini.isLipSync
                || t.preStage.gemini.isAmbient) &&
              React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, marginBottom: 4 } },
                Number.isFinite(t.preStage.gemini.memeShapeStrength) &&
                  React.createElement('span', { className: 'sp-chip', style: { fontSize: 10 } }, '🎯 memeShape ' + t.preStage.gemini.memeShapeStrength + '/100'),
                typeof t.preStage.gemini.hasNarrative === 'boolean' &&
                  React.createElement('span', { className: 'sp-chip', style: { fontSize: 10 } }, (t.preStage.gemini.hasNarrative ? '📖' : '🚫') + ' narrative'),
                typeof t.preStage.gemini.hasSubject === 'boolean' &&
                  React.createElement('span', { className: 'sp-chip', style: { fontSize: 10 } }, (t.preStage.gemini.hasSubject ? '👤' : '🚫') + ' subject'),
                t.preStage.gemini.viralPattern &&
                  React.createElement('span', { className: 'sp-chip', style: { fontSize: 10 } }, '🌀 ' + t.preStage.gemini.viralPattern),
                t.preStage.gemini.tickerSuggestion && t.preStage.gemini.tickerSuggestion.trim() &&
                  React.createElement('span', { className: 'sp-chip', style: { fontSize: 10, color: '#fdcb6e' } }, '$' + t.preStage.gemini.tickerSuggestion),
                Array.isArray(t.preStage.gemini.subjectNames) && t.preStage.gemini.subjectNames.length > 0 &&
                  t.preStage.gemini.subjectNames.map((nm, i) =>
                    React.createElement('span', { key: 'subj-' + i, className: 'sp-chip', style: { fontSize: 10, color: '#fdcb6e' } }, '🏷️ ' + nm)
                  ),
                t.preStage.gemini.isLipSync &&
                  React.createElement('span', { className: 'sp-chip', style: { fontSize: 10, color: '#ff7675' } }, '🎤 lip-sync'),
                t.preStage.gemini.isAmbient &&
                  React.createElement('span', { className: 'sp-chip', style: { fontSize: 10, color: '#ff7675' } }, '😴 ambient')
              ),
            t.preStage.gemini.mood && React.createElement('span', { style: { fontSize: 11, color: 'var(--text2)' } }, 'mood: ' + t.preStage.gemini.mood)
          )
        ),

      // ── COLLAPSIBLE: Stage 2 deep-dive (only when scorer ran x_search) ─
      t.xSearchData && (t.xSearchData.xBuzz || t.xSearchData.narrativeMomentum || t.xSearchData.organicity || t.xSearchData.subjectName) &&
        React.createElement(Collapsible, { title: '🔍 Stage 2 (Grok deep-dive)', accent: 'stage2', defaultOpen: true },
          React.createElement('div', { className: 'sp-metric-row', style: { marginBottom: 8, fontFamily: 'inherit' } },
            React.createElement('span', null, 'X Buzz: ', React.createElement('b', null, t.xSearchData.xBuzz || 'unknown')),
            React.createElement('span', null, 'Импульс: ', React.createElement('b', null, t.xSearchData.narrativeMomentum || 'unknown')),
            React.createElement('span', null, 'Органичность: ', React.createElement('b', null, t.xSearchData.organicity || 'unknown'))
          ),
          t.xSearchData.subjectName && React.createElement('div', { style: { fontSize: 12, color: 'var(--text2)' } },
            '🏷 Subject: ', React.createElement('b', { style: { color: 'var(--text)' } }, '"' + t.xSearchData.subjectName + '"'),
            ' · strength ', React.createElement('b', { style: { color: 'var(--text)' } }, t.xSearchData.nameStrength)
          ),
          (t.stage2Penalty || t.stage2StoryBonus || t.stage2NameBonus || t.textOnlyPenalty) && React.createElement('div', { style: { fontSize: 11, color: 'var(--text2)', marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(56,189,248,.18)' } },
            t.stage2Penalty && t.stage2Penalty.multiplier < 1 && React.createElement('div', null, '⛔ Penalty ×' + t.stage2Penalty.multiplier.toFixed(2) + (t.stage2Penalty.reasons?.length ? ' (' + t.stage2Penalty.reasons.join(', ') + ')' : '')),
            t.textOnlyPenalty && t.textOnlyPenalty.multiplier < 1 && React.createElement('div', null, '📝 Text-only ×' + t.textOnlyPenalty.multiplier.toFixed(2) + ' — meme ' + t.textOnlyPenalty.memeBefore + '→' + t.textOnlyPenalty.memeAfter + ', viral ' + t.textOnlyPenalty.viralBefore + '→' + t.textOnlyPenalty.viralAfter),
            t.stage2StoryBonus && t.stage2StoryBonus.bonus > 0 && React.createElement('div', null, '📖 Story bonus +' + t.stage2StoryBonus.bonus + ' (story score ' + t.stage2StoryBonus.storyScore + ')'),
            t.stage2NameBonus  && t.stage2NameBonus.bonus  > 0 && React.createElement('div', null, '🏷 Name bonus +'  + t.stage2NameBonus.bonus  + ' (strength '   + t.stage2NameBonus.nameStrength + ')')
          )
        ),

      // ── COLLAPSIBLE: Raw engagement metrics ────────────────────────────
      (t.metrics && (t.metrics.views || t.metrics.likes || t.metrics.upvotes || t.metrics.plays || t.metrics.twitter)) &&
        React.createElement(Collapsible, { title: '📊 Сырые метрики', defaultOpen: false },
          React.createElement('div', { className: 'sp-metric-row' },
            t.metrics.views      ? React.createElement('span', null, '👁 ' + t.metrics.views.toLocaleString())   : null,
            t.metrics.upvotes    ? React.createElement('span', null, '⬆ '  + t.metrics.upvotes.toLocaleString()) : null,
            t.metrics.likes      ? React.createElement('span', null, '❤️ ' + t.metrics.likes.toLocaleString())   : null,
            t.metrics.comments   ? React.createElement('span', null, '💬 ' + t.metrics.comments.toLocaleString()): null,
            t.metrics.shares     ? React.createElement('span', null, '🔁 ' + t.metrics.shares.toLocaleString())  : null,
            t.metrics.plays      ? React.createElement('span', null, '▶ '  + t.metrics.plays.toLocaleString())   : null,
            t.metrics.twitter && t.metrics.twitter.totalRetweets ? React.createElement('span', null, '🔁 ' + t.metrics.twitter.totalRetweets.toLocaleString()) : null,
            t.metrics.twitter && t.metrics.twitter.totalLikes    ? React.createElement('span', null, '❤️ ' + t.metrics.twitter.totalLikes.toLocaleString())   : null,
            t.metrics.velocity   ? React.createElement('span', { className: 'accent' }, '⚡ ' + t.metrics.velocity.toFixed(1) + '/h ↑') : null,
            t.metrics.ageHours !== undefined ? React.createElement('span', null, '⏳ ' + t.metrics.ageHours + 'h') : null,
            t.metrics.subreddit  ? React.createElement('span', null, 'r/' + t.metrics.subreddit) : null
          )
        ),

      // ── COLLAPSIBLE: Cluster signals ───────────────────────────────────
      t.clusterMetrics &&
        React.createElement(Collapsible, { title: '🌐 Сигналы кластера', defaultOpen: false },
          React.createElement('div', { className: 'sp-metric-row', style: { fontFamily: 'inherit' } },
            // (2026-05-04) Removed cross-platform "🌐 N платформ" badge —
            // unreliable signal, see clusterer.js note. Cluster size + novelty
            // + DB recurrence below are the honest signals.
            t.clusterMetrics.isNovel === false
              ? React.createElement('span', { style: { color: 'var(--yellow)' } }, '🔁 Дубль кластера')
              : React.createElement('span', { className: 'ok' }, '🆕 Новый'),
            (t.clusterMetrics.batchSize > 1) && React.createElement('span', null, '📦 batch:' + t.clusterMetrics.batchSize),
            (t.clusterMetrics.dbRecentCount > 0) && React.createElement('span', null, '🗄 db:' + t.clusterMetrics.dbRecentCount),
            (t.clusterMetrics.junkPenalty > 0) && React.createElement('span', { className: 'danger' }, '🗑 junk:' + t.clusterMetrics.junkPenalty),
            t.junkReasons && t.junkReasons.length > 0 && React.createElement('span', { className: 'danger' }, '⚠ ' + t.junkReasons.join(', ')),
            t.memeShapeSignals && t.memeShapeSignals.length > 0 && React.createElement('span', { className: 'ok' }, '✨ ' + t.memeShapeSignals.join(', '))
          )
        ),

      // ── COLLAPSIBLE: Image gallery (if multiple) ───────────────────────
      (t.imageUrls && t.imageUrls.length > 1) &&
        React.createElement(Collapsible, { title: '🖼 Картинки (' + t.imageUrls.length + ')', defaultOpen: false },
          React.createElement('div', { className: 'sp-thumbs' },
            t.imageUrls.slice(0, 8).map((u, i) =>
              React.createElement('a', { key: i, href: u, target: '_blank', rel: 'noopener' },
                React.createElement('img', { src: u, alt: '', loading: 'lazy' })
              )
            )
          )
        ),

      // ── TG broadcast status (only after a fresh send) ──────────────────
      result.alerts && result.alerts.length > 0 &&
        React.createElement('div', { className: 'sp-block accent-tg' },
          React.createElement('div', { className: 'sp-block-label' }, '📨 Отправка в Telegram'),
          React.createElement('div', { style: { fontSize: 12, color: 'var(--text2)' } },
            '✅ Успешно: ' + result.alerts.filter(a => a.ok).length + ' / ' + result.alerts.length,
            result.alerts.some(a => !a.ok) && React.createElement('div', { style: { color: 'var(--yellow)', marginTop: 4 } },
              '⚠ Ошибки: ' + result.alerts.filter(a => !a.ok).map(a => a.reason).join(', ')
            )
          )
        )
    )
  );
}

// ── SubmitPage — manual URL / narrative analysis ─────────────────────────────
// Persists analyses across reloads: every successful submit lands in the
// trends table with raw_metrics.manualSubmitted=true; on mount we pull
// that list via GET /api/manual-trends and render it as a horizontal
// history strip above the detail card. Operator can switch between past
// analyses without re-running the pipeline.
function SubmitPage() {
  const [url, setUrl] = useState('');
  const [sendTg, setSendTg] = useState(false);
  // Comment is shared between the page-level submit form and the per-card
  // "Отправить алерт" button (the user's intent — one comment, used wherever
  // they hit send next).
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(true);

  const COMMENT_MAX = 500;

  // Load history on mount.
  useEffect(() => {
    let alive = true;
    api('/api/manual-trends?limit=80')
      .then(d => {
        if (!alive) return;
        const items = (d.items || []).map(it => ({ ...it, alerts: [] }));
        setHistory(items);
        if (items.length) setActiveId(items[0].trend.id);
      })
      .catch(() => {})
      .finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
  }, []);

  const submit = async () => {
    const clean = url.trim();
    if (!clean) { setError('Вставь URL'); return; }
    if (!/^https?:\\/\\//i.test(clean)) { setError('URL должен начинаться с http(s)://'); return; }
    setError(''); setLoading(true);
    try {
      const res = await api('/api/submit-narrative', 'POST', {
        url: clean,
        sendToTelegram: sendTg,
        comment: sendTg ? comment.trim() : '',
      });
      // Prepend to history, dedup by id (re-submitting the same URL UPSERTs
      // the row in DB but we still want it on top).
      const newItem = {
        trend: res.trend,
        pipeline: res.pipeline,
        alerts: res.alerts || [],
        elapsedMs: res.elapsedMs,
        submittedAt: res.trend?.manualSubmittedAt || new Date().toISOString(),
      };
      setHistory(prev => {
        const filtered = prev.filter(it => it.trend.id !== newItem.trend.id);
        return [newItem, ...filtered];
      });
      setActiveId(newItem.trend.id);
      setUrl('');
    } catch (e) {
      setError(e.message || 'Ошибка анализа');
    } finally {
      setLoading(false);
    }
  };

  const removeFromHistory = async (id) => {
    if (!id) return;
    if (!window.confirm('Убрать из истории? Сам тренд останется в БД.')) return;
    try {
      await api('/api/manual-trends/' + id, 'DELETE');
    } catch (e) {
      alert('Не удалось удалить: ' + (e.message || 'unknown'));
      return;
    }
    setHistory(prev => {
      const next = prev.filter(it => it.trend.id !== id);
      // If we just removed the active one, fall back to the new top.
      if (activeId === id) setActiveId(next[0]?.trend?.id || null);
      return next;
    });
  };

  const updateActiveAlerts = (alerts) => {
    setHistory(prev => prev.map(it =>
      it.trend.id === activeId ? { ...it, alerts } : it
    ));
  };

  const active = history.find(it => it.trend.id === activeId) || null;

  return React.createElement('div', null,
    // ── PAGE HEADER (matches ScannersPage / DecisionsPage idiom) ──────────
    React.createElement('div', { className: 'page-header' },
      React.createElement('h2', null, '🧪 Ручной анализ нарратива'),
      React.createElement('p', null,
        'Закинь URL поста (Twitter / Reddit / TikTok / любой сайт с og:image) — прогоним через полный пайплайн анализа (Stage 1 + Stage 2 Grok), сохраним в БД и опционально отправим в Telegram. История сохраняется между сессиями.'
      )
    ),

    // ── SUBMIT FORM ────────────────────────────────────────────────────────
    React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
      React.createElement('div', { className: 'sp-form' },
        React.createElement('div', null,
          React.createElement('label', { className: 'sp-form-label' }, 'URL поста'),
          React.createElement('input', {
            type: 'url',
            className: 'sp-input',
            value: url,
            onChange: e => setUrl(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter' && !loading) submit(); },
            placeholder: 'https://twitter.com/user/status/12345  или  https://reddit.com/r/xyz/comments/...',
            disabled: loading,
          })
        ),
        React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 } },
          React.createElement('input', { type: 'checkbox', checked: sendTg, onChange: e => setSendTg(e.target.checked), disabled: loading }),
          React.createElement('span', null, '📨 Отправить в Telegram всем активным подписчикам после анализа')
        ),
        sendTg && React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            React.createElement('label', { className: 'sp-form-label', style: { marginBottom: 0 } }, '💬 Комментарий к алерту (необязательно)'),
            React.createElement('span', { className: 'sp-counter' + (comment.length > COMMENT_MAX ? ' over' : '') }, comment.length + '/' + COMMENT_MAX)
          ),
          React.createElement('textarea', {
            className: 'sp-textarea',
            value: comment,
            onChange: e => setComment(e.target.value.slice(0, COMMENT_MAX + 50)),
            placeholder: 'Например: смотрите реплаи под этим постом — там эпичный слив',
            disabled: loading,
            rows: 2,
          })
        ),
        React.createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          React.createElement('button', { className: 'btn btn-primary', onClick: submit, disabled: loading || !url.trim() },
            loading ? '⏳ Анализ идёт...' : '🚀 Проанализировать'
          ),
          error && React.createElement('span', { className: 'sp-error-inline' }, '⚠ ' + error)
        )
      )
    ),

    loading && React.createElement('div', { className: 'sp-loading' },
      React.createElement('div', { className: 'sp-loading-icon' }, '⚙️'),
      React.createElement('div', { style: { fontSize: 13 } }, 'Тянем метаданные → Stage 1 (батч-скоринг) → Stage 2 (Grok x_search deep-dive)...'),
      React.createElement('div', { style: { fontSize: 11, marginTop: 6, color: 'var(--text2)', opacity: .8 } }, 'Обычно 10-30 секунд')
    ),

    // ── HISTORY STRIP ──────────────────────────────────────────────────────
    history.length > 0 && React.createElement('div', { style: { marginBottom: 14 } },
      React.createElement('div', { className: 'sp-history-head' },
        React.createElement('div', { className: 'sp-history-title' }, '📚 История анализов (' + history.length + ')'),
        React.createElement('div', { className: 'sp-history-hint' }, 'Клик — открыть детали · 🗑 убрать из списка')
      ),
      React.createElement('div', { className: 'sp-history-strip' },
        history.map(it => React.createElement(ManualHistoryItem, {
          key: it.trend.id,
          item: it,
          active: it.trend.id === activeId,
          onSelect: setActiveId,
          onDelete: removeFromHistory,
        }))
      )
    ),

    historyLoading && history.length === 0 && React.createElement('div', { className: 'sp-loading' }, '⏳ Загружаем историю...'),

    !historyLoading && history.length === 0 && !loading && React.createElement('div', { className: 'sp-empty' },
      React.createElement('span', { className: 'sp-empty-icon' }, '📭'),
      React.createElement('div', { style: { fontSize: 14, marginBottom: 6 } }, 'История пуста'),
      React.createElement('div', { style: { fontSize: 12 } }, 'Закинь первый URL в форме выше')
    ),

    // ── ACTIVE DETAIL CARD ─────────────────────────────────────────────────
    active && React.createElement(ManualResultCard, {
      result: active,
      comment, setComment,
      onAlertSent: updateActiveAlerts,
    })
  );
}

// ── spTile (score tile) — used inside ManualResultCard's score grid ─────────
// Auto-derives a tone class (hot / warm / bad / blue default) from the value.
// Caller can pass cls ("hot" | "warm" | "bad") to force a tone — used by
// the Junk tile which is always red.
function spTile(label, value, cls) {
  const tone = cls || (value >= 70 ? 'hot' : value >= 40 ? 'warm' : '');
  return React.createElement('div', { className: 'sp-score-tile' + (tone ? ' ' + tone : '') },
    React.createElement('div', { className: 'sp-score-tile-label' }, label),
    React.createElement('div', { className: 'sp-score-tile-value' }, value + '/100')
  );
}

// ── ExamplesPage — manage Stage 1 calibration examples + counterexamples ────
// Operator-curated few-shot block fed into SYSTEM_PROMPT for OpenAI Stage 1.
// Each row is either:
//   - kind="example"  — concrete trend with a known memePotential to teach the rubric
//   - kind="mistake"  — anti-pattern the model commonly slips on (HARD RULES)
//
// REMINDERS for editing this whole file:
//   1. NEVER use backticks in comments — they break the outer template literal
//   2. NEVER write a backslash followed by n / t / r / u / x ANYWHERE
//      (strings AND comments) — outer literal eats the escape and shifts the
//      rest of the line out of context. Use String.fromCharCode for whitespace
//      and quote-only Unicode characters directly. See SESSION_CONTEXT.
function ExamplesPage() {
  const CATEGORIES = ['meme','celebrity','animals','tech','gambling',
                       'sports','politics','entertainment','gaming',
                       'boring','other'];
  const NL = String.fromCharCode(10);  // outer-template-safe newline

  const [items, setItems]         = useState([]);
  const [tab, setTab]             = useState('example');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft]         = useState({
    kind:'example', title:'', category:'meme',
    memePotential:50, rationale:'', enabled:true, sortOrder:0,
  });
  const [msg, setMsg]             = useState('');
  const [saving, setSaving]       = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const load = () => api('/api/stage1-examples').then(d => setItems(d.items || [])).catch(()=>{});
  useEffect(() => { load(); }, []);

  const openNew = (kind) => {
    setEditingId(null);
    setDraft({
      kind: kind || 'example',
      title:'', category:'meme', memePotential:50, rationale:'',
      enabled:true, sortOrder: items.length * 10,
    });
    setMsg('');
    setModalOpen(true);
  };

  const openEdit = (item) => {
    setEditingId(item.id);
    setDraft({
      kind: item.kind, title: item.title, category: item.category || 'meme',
      memePotential: item.memePotential ?? 50, rationale: item.rationale,
      enabled: !!item.enabled, sortOrder: item.sortOrder || 0,
    });
    setMsg('');
    setModalOpen(true);
  };

  const closeModal = () => { setModalOpen(false); setEditingId(null); setMsg(''); };

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      if (editingId) {
        await api('/api/stage1-examples/' + editingId, 'PUT', draft);
      } else {
        await api('/api/stage1-examples', 'POST', draft);
      }
      load();
      closeModal();
    } catch (e) {
      setMsg('Ошибка: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const del = async (id) => {
    if (!confirm('Удалить?')) return;
    try { await api('/api/stage1-examples/' + id, 'DELETE'); load(); }
    catch (e) { setMsg('Ошибка: ' + e.message); }
  };

  const toggleEnabled = async (item) => {
    try {
      await api('/api/stage1-examples/' + item.id, 'PUT', { enabled: !item.enabled });
      load();
    } catch (e) { setMsg('Ошибка: ' + e.message); }
  };

  const exampleCount = items.filter(i => i.kind === 'example').length;
  const mistakeCount = items.filter(i => i.kind === 'mistake').length;
  const enabledCount = items.filter(i => i.enabled).length;
  const visible      = items.filter(i => i.kind === tab);
  const tokenEst = items
    .filter(i => i.enabled)
    .reduce((sum, i) => sum + (i.kind === 'mistake' ? 35 : 50), 0);
  // Cost: gpt-5.4-mini cached input = $0.075 / 1M tokens.
  // Cycle interval ~2 min → 720 cycles/day → 21600/month.
  // Per-month cost = tokenEst * 0.075 / 1e6 * 21600 = tokenEst * 0.00162.
  // First call after restart pays uncached (~$0.30/1M), but auto-cache (5-min TTL)
  // covers virtually all subsequent calls — so steady-state is cached price.
  const costPerMonth = tokenEst * 0.00162;
  const costPerDay   = tokenEst * 0.000054;
  const costLabel = (enabledCount === 0)
    ? '$0'
    : (costPerMonth < 0.01
        ? '< $0.01/мес'
        : '≈ $' + costPerMonth.toFixed(2) + '/мес');
  const costTooltip = (enabledCount === 0)
    ? 'Нет активных примеров'
    : tokenEst + ' ток × $0.075/M (cached) × 21600 циклов/мес ≈ $'
      + costPerMonth.toFixed(3) + '/мес ($' + costPerDay.toFixed(3) + '/день)';

  // Preview mirrors scorer._buildExamplesContext output exactly. Uses NL
  // constant to avoid the outer-template escape trap (see top-of-function note).
  const buildPreview = () => {
    const ex = items.filter(i => i.enabled && i.kind === 'example');
    const mi = items.filter(i => i.enabled && i.kind === 'mistake');
    let p = '';
    if (ex.length) {
      p += '━━━ CALIBRATION EXAMPLES (mirror these scores) ━━━' + NL;
      p += ex.map(e =>
        '  • "' + e.title + '" [' + (e.category || 'other') + '] → memePotential ' +
        (e.memePotential ?? 0) + (e.rationale ? ' — ' + e.rationale : '')
      ).join(NL);
    }
    if (mi.length) {
      if (p) p += NL + NL;
      p += '━━━ COMMON MISTAKES TO AVOID ━━━' + NL;
      p += mi.map(m => '  ✗ "' + m.title + '"' + (m.rationale ? ' — ' + m.rationale : '')).join(NL);
    }
    return p || '(no enabled examples — falling back to bare rubric)';
  };

  // ── Card renderer ────────────────────────────────────────────────────────
  const scoreClass = (n) => n >= 70 ? 'high' : n >= 30 ? 'mid' : 'low';

  const renderCard = (item) => {
    const isExample = item.kind === 'example';
    return React.createElement('div', {
      key: item.id,
      className: 'exp-card' + (item.enabled ? '' : ' disabled') + (editingId === item.id ? ' editing' : ''),
    },
      React.createElement('div', { className: 'exp-card-id' }, '#' + item.id),
      React.createElement('div', { className: 'exp-card-head' },
        isExample
          ? React.createElement('div', { className: 'exp-score ' + scoreClass(item.memePotential || 0) },
              item.memePotential ?? 0)
          : React.createElement('div', { className: 'exp-score warn' }, '⚠'),
        React.createElement('div', { className: 'exp-card-meta' },
          isExample
            ? React.createElement('span', { className: 'exp-cat-chip' }, item.category || 'other')
            : React.createElement('span', { className: 'exp-mistake-chip' }, 'Mistake'),
          React.createElement('div', { className: 'exp-card-title' }, '"' + item.title + '"')
        )
      ),
      React.createElement('div', { className: 'exp-card-rationale' }, item.rationale),
      React.createElement('div', { className: 'exp-card-foot' },
        React.createElement('label', { className: 'toggle-wrap' },
          React.createElement('label', { className: 'toggle' },
            React.createElement('input', {
              type: 'checkbox',
              checked: !!item.enabled,
              onChange: () => toggleEnabled(item)
            }),
            React.createElement('span', { className: 'toggle-slider' })
          ),
          React.createElement('span', { style:{ fontSize:11, color:'var(--text2)' } },
            item.enabled ? 'enabled' : 'disabled')
        ),
        React.createElement('div', { style:{ flex:1 } }),
        React.createElement('button', {
          className: 'exp-icon-btn',
          onClick: () => openEdit(item)
        }, '✏️ Edit'),
        React.createElement('button', {
          className: 'exp-icon-btn danger',
          onClick: () => del(item.id)
        }, '🗑')
      )
    );
  };

  // ── Modal editor ─────────────────────────────────────────────────────────
  const modal = !modalOpen ? null : React.createElement('div', {
    className: 'exp-modal-backdrop',
    onClick: (e) => { if (e.target === e.currentTarget) closeModal(); }
  },
    React.createElement('div', { className: 'exp-modal' },
      React.createElement('div', { className: 'exp-modal-head' },
        React.createElement('h3', { className: 'exp-modal-title' },
          editingId ? ('✏️ Редактировать #' + editingId) : '+ Добавить новый'
        ),
        React.createElement('button', { className: 'exp-modal-close', onClick: closeModal }, '×')
      ),
      // Kind radio
      React.createElement('div', { className: 'exp-form-row' },
        React.createElement('div', { className: 'exp-form-label' }, 'Тип'),
        React.createElement('div', { className: 'exp-radio-group' },
          React.createElement('div', {
            className: 'exp-radio' + (draft.kind === 'example' ? ' active' : ''),
            onClick: () => setDraft({...draft, kind:'example'})
          },
            React.createElement('span', { className:'exp-radio-icon' }, '📚'),
            React.createElement('span', null, 'Example (с категорией и score)')
          ),
          React.createElement('div', {
            className: 'exp-radio' + (draft.kind === 'mistake' ? ' active' : ''),
            onClick: () => setDraft({...draft, kind:'mistake'})
          },
            React.createElement('span', { className:'exp-radio-icon' }, '⚠️'),
            React.createElement('span', null, 'Mistake (анти-паттерн)')
          )
        )
      ),
      // Title
      React.createElement('div', { className: 'exp-form-row' },
        React.createElement('div', { className: 'exp-form-label' }, 'Title (5-200 символов)'),
        React.createElement('input', {
          className: 'exp-form-input',
          maxLength: 200,
          value: draft.title,
          placeholder: draft.kind === 'example'
            ? 'e.g. "Bizarre cute animal viral video"'
            : 'e.g. "Trump signed an executive order (5M views)"',
          onChange: e => setDraft({...draft, title: e.target.value})
        }),
        React.createElement('div', { className: 'exp-form-counter' }, draft.title.length + ' / 200')
      ),
      // Category + score (only for examples)
      draft.kind === 'example' && React.createElement('div', { className: 'exp-form-row' },
        React.createElement('div', { className: 'exp-form-label' }, 'Category'),
        React.createElement('select', {
          className: 'exp-form-input',
          value: draft.category,
          onChange: e => setDraft({...draft, category: e.target.value})
        }, ...CATEGORIES.map(c => React.createElement('option', { key:c, value:c }, c)))
      ),
      draft.kind === 'example' && React.createElement('div', { className: 'exp-form-row' },
        React.createElement('div', { className: 'exp-form-label' }, 'Meme Potential (0-100)'),
        React.createElement('div', { className: 'exp-slider-row' },
          React.createElement('input', {
            type: 'range', min:0, max:100, step:1,
            value: draft.memePotential,
            onChange: e => setDraft({...draft, memePotential: parseInt(e.target.value, 10)})
          }),
          React.createElement('div', {
            className: 'exp-slider-num',
            style: {
              color: draft.memePotential >= 70 ? '#22c55e'
                   : draft.memePotential >= 30 ? '#fbbf24' : '#ff6b6b'
            }
          }, draft.memePotential)
        )
      ),
      // Rationale
      React.createElement('div', { className: 'exp-form-row' },
        React.createElement('div', { className: 'exp-form-label' },
          'Rationale (10-400 символов) — почему такой score / в чём ошибка'
        ),
        React.createElement('textarea', {
          className: 'exp-form-input exp-form-textarea',
          maxLength: 400,
          value: draft.rationale,
          placeholder: draft.kind === 'example'
            ? 'e.g. "Cute animals are evergreen meme fuel. Short phonetic name = perfect ticker."'
            : 'e.g. "POLITICS RULE: даже с viral metrics, score 0. Не вестись на raw engagement."',
          onChange: e => setDraft({...draft, rationale: e.target.value})
        }),
        React.createElement('div', { className: 'exp-form-counter' }, draft.rationale.length + ' / 400')
      ),
      // Enabled + sort_order
      React.createElement('div', { className: 'exp-form-row', style:{ flexDirection:'row', gap:24, alignItems:'center' } },
        React.createElement('label', { className:'toggle-wrap' },
          React.createElement('label', { className: 'toggle' },
            React.createElement('input', {
              type:'checkbox', checked: !!draft.enabled,
              onChange: e => setDraft({...draft, enabled: e.target.checked})
            }),
            React.createElement('span', { className:'toggle-slider' })
          ),
          React.createElement('span', { style:{ fontSize:12, color:'var(--text2)' } },
            draft.enabled ? 'Enabled' : 'Disabled')
        ),
        React.createElement('label', { style:{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'var(--text2)' } },
          React.createElement('span', null, 'Sort:'),
          React.createElement('input', {
            type:'number', step:10,
            className:'exp-form-input', style:{ width:80 },
            value: draft.sortOrder,
            onChange: e => setDraft({...draft, sortOrder: parseInt(e.target.value, 10) || 0})
          })
        )
      ),
      // Validation message inside modal
      msg && React.createElement('div', {
        style:{
          padding:'10px 12px', borderRadius:8, fontSize:12,
          background: msg.includes('Ошибка') ? 'rgba(239,68,68,.1)' : 'rgba(34,197,94,.1)',
          color: msg.includes('Ошибка') ? '#ff6b6b' : '#22c55e',
          marginBottom:10
        }
      }, msg),
      // Footer
      React.createElement('div', { className: 'exp-modal-foot' },
        React.createElement('button', {
          className:'btn btn-primary btn-sm',
          onClick: save, disabled: saving
        }, saving ? 'Сохранение...' : (editingId ? '💾 Сохранить' : '+ Добавить')),
        React.createElement('button', { className:'btn btn-sm', onClick: closeModal }, 'Отмена'),
        React.createElement('span', { style:{ flex:1 } }),
        React.createElement('span', { style:{ fontSize:11, color:'var(--text3)' } },
          'Применится через ~2 минуты на следующем цикле')
      )
    )
  );

  // ── Page ─────────────────────────────────────────────────────────────────
  return React.createElement('div', { className: 'page' },
    // Header
    React.createElement('div', { style:{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:16, gap:16, flexWrap:'wrap' } },
      React.createElement('div', null,
        React.createElement('h2', { style:{ margin:0 } }, '🎓 Stage 1 AI Examples'),
        React.createElement('div', { style:{ fontSize:12, color:'var(--text2)', marginTop:4, maxWidth:600, lineHeight:1.5 } },
          'Few-shot калибровка для AI-скоринга. Изменения попадают в кэш Responses API и применяются на следующем цикле скоринга (~2 минуты).')
      ),
      React.createElement('button', {
        className:'btn btn-primary btn-sm',
        style:{ fontSize:13, padding:'8px 14px' },
        onClick: () => openNew(tab)
      }, '+ Добавить ' + (tab === 'example' ? 'example' : 'mistake'))
    ),
    // Budget bar
    React.createElement('div', { className:'exp-budget' },
      React.createElement('div', { className:'exp-budget-stat' },
        React.createElement('span', { className:'exp-budget-num' }, enabledCount + ' / ' + items.length),
        React.createElement('span', { className:'exp-budget-label' }, 'Активных')
      ),
      React.createElement('div', { className:'exp-budget-divider' }),
      React.createElement('div', { className:'exp-budget-stat' },
        React.createElement('span', { className:'exp-budget-num' }, '~' + tokenEst),
        React.createElement('span', { className:'exp-budget-label' }, 'Токенов / цикл')
      ),
      React.createElement('div', { className:'exp-budget-divider' }),
      React.createElement('div', { className:'exp-budget-stat', title: costTooltip },
        React.createElement('span', { className:'exp-budget-num', style:{ color:'#22c55e' } }, costLabel),
        React.createElement('span', { className:'exp-budget-label' }, 'Cost (с кэшем)')
      ),
      React.createElement('div', { style:{ flex:1 } }),
      React.createElement('button', {
        className:'exp-icon-btn',
        onClick: () => setShowPreview(!showPreview)
      }, showPreview ? '⌃ Скрыть preview' : '👁 Preview промпт')
    ),
    showPreview && React.createElement('pre', { className:'exp-preview-pre' }, buildPreview()),
    // Tabs
    React.createElement('div', { className:'exp-toolbar' },
      React.createElement('div', { className:'adm-tabs' },
        ...[['example', '📚 Examples', exampleCount], ['mistake', '⚠️ Mistakes', mistakeCount]].map(([k, l, n]) =>
          React.createElement('button', {
            key: k,
            className: 'adm-tab' + (tab === k ? ' active' : ''),
            onClick: () => setTab(k)
          },
            React.createElement('span', null, l),
            React.createElement('span', { className:'adm-tab-count' }, n)
          )
        )
      )
    ),
    // List or empty state
    visible.length === 0
      ? React.createElement('div', { className:'exp-empty' },
          React.createElement('span', { className:'exp-empty-icon' }, tab === 'example' ? '📚' : '⚠️'),
          React.createElement('div', { style:{ fontSize:14, marginBottom:8 } }, 'Пока пусто'),
          React.createElement('div', { style:{ fontSize:12 } },
            'Добавь первый ' + (tab === 'example' ? 'example' : 'mistake') + ' через кнопку выше')
        )
      : React.createElement('div', { className:'exp-grid' }, ...visible.map(renderCard)),
    // Page-level status (only when modal isn't open)
    !modalOpen && msg && React.createElement('div', { style:{ marginTop:14, fontSize:12 } },
      React.createElement('span', { className: msg.includes('Ошибка') ? 'error-msg' : 'success-msg' }, msg)
    ),
    modal
  );
}

// narrativeBox helper removed 2026-04-30 — its callers (AI explanation /
// description blocks) now render via .sp-block + .sp-narrative classes
// for visual consistency with the rest of the SubmitPage card.

// ── PresetConfigsPage — per-preset pipeline tuning (PR-3, full UI) ──────────
// Operator-only by virtue of the admin server's shared X-Admin-Key gate.
// Manages settings.presetConfigs blob — overrides for sources / junk /
// alerts / cluster per preset (general/animals/culture/celebrities/events).
//
// PR-3 (this revision) replaces PR-1's JSON textarea with a real UI:
//   - tab strip (one preset at a time)
//   - accordions per group (sources / junk / alerts / cluster)
//   - chip-input for list fields (subreddits / X queries / TikTok hashtags)
//   - sliders with reset-to-default + override indicator
//   - dynamic-clamp budget on positive weight groups (alerts.weights, cluster)
// JSON inspector retained inside <details> as a debug fallback.
//
// Template-literal traps (see ExamplesPage):
//   1) never use backticks in comments
//   2) never use \\n / \\t / \\r / \\u / \\x in strings or comments
function PresetConfigsPage() {
  const h = React.createElement;
  const [data,   setData]   = useState(null);
  const [draft,  setDraft]  = useState({});
  // Lock-mask draft — Phase 3. Shape: { <preset>: { reddit: [...], twitter: [...] } }
  // Locked items are protected from auto-refresh deletion (tag-refresher.js
  // _computeDiff respects this list). For Twitter, lock-key is the keyword-PART
  // of the query (without min_faves and -is:retweet) — that's how
  // tag-refresher matches locks against current/proposed groups.
  const [locked, setLocked] = useState({});
  const [tab,    setTab]    = useState('general');
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState('');
  const [msgKind, setMsgKind] = useState('ok');

  const load = () => {
    api('/api/preset-configs')
      .then(d => { setData(d); setDraft(d.overrides || {}); setLocked(d.tagsLocked || {}); })
      .catch(e => { setMsg('Ошибка загрузки: ' + e.message); setMsgKind('err'); });
  };
  useEffect(load, []);

  const flash = (m, kind) => {
    setMsg(m); setMsgKind(kind || 'ok');
    setTimeout(() => setMsg(''), 3500);
  };

  // ── Draft mutators ──────────────────────────────────────────────────────
  // walk(obj, path) — read leaf or undefined; never throws
  const walk = (root, path) => {
    let n = root;
    for (const k of path) {
      if (n == null || typeof n !== 'object') return undefined;
      n = n[k];
    }
    return n;
  };

  const getDefault = (preset, path) => walk(data?.defaults?.[preset], path);
  // Mirror production's 3-layer merge (draft → auto → defaults) so the admin
  // UI shows what collectors actually see. BEFORE 2026-05-16 this only walked
  // draft → defaults, hiding the auto-overrides layer. That made the chip
  // lists look empty when a user wiped manual edits but autoOverrides were
  // populated — leading the operator to remove chips one-by-one, each removal
  // writing an explicit empty array into draft that then REPLACED auto on save
  // (deepMerge top-layer-wins for arrays). End result: collectors got zero
  // queries for the active preset until manual got wiped via the Wipe-manual
  // button.
  const getEffective = (preset, path) => {
    const fromDraft = walk(draft[preset], path);
    if (fromDraft !== undefined) return fromDraft;
    const fromAuto = walk(data?.autoOverrides?.[preset], path);
    if (fromAuto !== undefined) return fromAuto;
    return getDefault(preset, path);
  };
  const isOverridden = (preset, path) => walk(draft[preset], path) !== undefined;

  // setLeaf — set a leaf in draft; if value equals default, drop the leaf and
  // garbage-collect empty parent objects up the chain so the blob stays compact.
  const setLeaf = (preset, path, value) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const dflt = getDefault(preset, path);
      const eqDefault = Array.isArray(value) && Array.isArray(dflt)
        ? value.length === dflt.length && value.every((v, i) => v === dflt[i])
        : value === dflt;

      if (eqDefault) {
        // Drop leaf + collapse empty parents
        if (!next[preset]) return next;
        const chain = [next[preset]];
        for (let i = 0; i < path.length - 1; i++) {
          const node = chain[chain.length - 1];
          if (!node || typeof node[path[i]] !== 'object') return next;
          chain.push(node[path[i]]);
        }
        const leafParent = chain[chain.length - 1];
        if (leafParent) delete leafParent[path[path.length - 1]];
        for (let i = chain.length - 1; i >= 1; i--) {
          if (Object.keys(chain[i]).length === 0) {
            delete chain[i - 1][path[i - 1]];
          }
        }
        if (Object.keys(next[preset]).length === 0) delete next[preset];
        return next;
      }

      // Walk + create
      if (!next[preset]) next[preset] = {};
      let node = next[preset];
      for (let i = 0; i < path.length - 1; i++) {
        if (!node[path[i]] || typeof node[path[i]] !== 'object') node[path[i]] = {};
        node = node[path[i]];
      }
      node[path[path.length - 1]] = value;
      return next;
    });
  };

  const resetField = (preset, path) => {
    const dflt = getDefault(preset, path);
    if (dflt === undefined) return;
    setLeaf(preset, path, dflt);
  };

  const resetPreset = (preset) => {
    setDraft(prev => {
      const next = { ...prev };
      delete next[preset];
      return next;
    });
    setLocked(prev => {
      const next = { ...prev };
      delete next[preset];
      return next;
    });
    flash('Сброшен пресет ' + preset, 'ok');
  };

  // Wipe manual layer for ALL presets (lets Auto-tags work freely).
  // Auto-overrides + locks stay intact — only the manual draft is cleared.
  // Effective config falls back to auto+defaults until next manual edit.
  const wipeManualAll = () => {
    setDraft({});
    flash('Manual слой будет очищен для всех пресетов при Save → auto+defaults станут effective', 'ok');
  };

  // Restore hardcoded DEFAULT_PRESET_CONFIGS.sources into manual layer.
  // Escape hatch when Auto-tags produces garbage. Manual ALWAYS wins in
  // merge order — so this pins legacy known-good tags and blocks any
  // future auto-refresh from changing them. Direct backend call (immediate)
  // rather than draft+save flow, because the action is destructive enough
  // to warrant an explicit confirm dialog with no "preview" intermediate.
  const restoreHardcoded = async () => {
    // NB outer file is a template-literal-served SPA — newline-escape
    // literals inside would break the parser. Use runtime fromCharCode(10)
    // for newlines in user-facing strings here. See CLAUDE.md SPA trap.
    const NL = String.fromCharCode(10) + String.fromCharCode(10);
    if (!window.confirm(
      'Восстановить hardcoded sources (subreddits / twitter queries / tiktok hashtags) ' +
      'в manual слой для ВСЕХ пресетов?' + NL +
      'После этого manual слой перекроет auto-tags для sources. Junk / alerts / cluster ' +
      'overrides не задеваются. Locks тоже сохраняются.' + NL +
      'Используй когда auto-tags сошёл с ума и нужен known-good baseline.'
    )) return;
    setSaving(true);
    try {
      const res = await api('/api/preset-configs/restore-hardcoded', 'POST', {});
      setData(res);
      setDraft(res.overrides || {});
      setLocked(res.tagsLocked || {});
      flash('Hardcoded sources восстановлены в manual слой', 'ok');
    } catch (e) {
      flash('Ошибка: ' + e.message, 'err');
    } finally { setSaving(false); }
  };

  // ── Lock-mask mutators ─────────────────────────────────────────────────
  // sourceType: 'reddit' | 'twitter' | 'tiktok'. The chip rendering layer
  // (PChips) normalizes lockKey per sourceType before calling toggleLock:
  //   reddit  — subreddit name as-is
  //   twitter — keyword-part (без min_faves/-is:retweet)
  //   tiktok  — lowercased hashtag, no leading "#"
  const toggleLock = (preset, sourceType, lockKey) => {
    setLocked(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (!next[preset]) next[preset] = {};
      if (!next[preset][sourceType]) next[preset][sourceType] = [];
      const arr = next[preset][sourceType];
      const idx = arr.indexOf(lockKey);
      if (idx >= 0) {
        arr.splice(idx, 1);
        if (arr.length === 0) delete next[preset][sourceType];
        if (Object.keys(next[preset]).length === 0) delete next[preset];
      } else {
        arr.push(lockKey);
      }
      return next;
    });
  };
  const isLocked = (preset, sourceType, lockKey) => {
    const arr = locked[preset]?.[sourceType] || [];
    return arr.includes(lockKey);
  };

  const reload = () => { load(); flash('Reloaded from server', 'ok'); };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api('/api/preset-configs', 'POST', { overrides: draft, tagsLocked: locked });
      setData(res);
      setDraft(res.overrides || {});
      setLocked(res.tagsLocked || {});
      flash('Сохранено', 'ok');
    } catch (e) {
      flash('Ошибка: ' + e.message, 'err');
    } finally { setSaving(false); }
  };

  if (!data) return h('div', { style: { padding: 20, color: 'var(--text2)' } },
    msg || 'Загрузка пресетов...');

  // ── Component primitives ───────────────────────────────────────────────
  // PSlider — slider row with override indicator + reset-to-default button.
  // formatValue prop overrides the default display (e.g. "∞" for 0).
  const PSlider = ({ preset, path, label, desc, formatValue, valStyle, overBudget }) => {
    const meta = walkRanges(data.fieldRanges, path);
    if (!meta) return null;
    const value     = getEffective(preset, path);
    const dflt      = getDefault(preset, path);
    const overridden = isOverridden(preset, path);
    const isFloat   = meta.type === 'float' || (meta.step && meta.step < 1);
    const display   = formatValue
      ? formatValue(value)
      : (isFloat ? Number(value).toFixed(2) : String(value));
    const dfltDisp  = isFloat ? Number(dflt).toFixed(2) : String(dflt);
    return h('div', { className: 'pcfg-row' },
      h('div', { className: 'pcfg-row-top' },
        h('span', { className: 'pcfg-label' },
          label,
          overridden ? h('span', {
            className: 'pcfg-override-dot',
            title: 'Overridden (default: ' + dfltDisp + ')'
          }) : null
        ),
        h('span', { className: 'pcfg-row-right' },
          h('span', {
            className: 'pcfg-val' + (overBudget ? ' over-budget' : ''),
            style: valStyle || null
          }, display),
          overridden ? h('button', {
            className: 'pcfg-reset-btn',
            onClick: () => resetField(preset, path),
            title: 'Reset to default (' + dfltDisp + ')'
          }, '↺') : null
        )
      ),
      h('input', {
        type: 'range',
        min: meta.min, max: meta.max, step: meta.step,
        value: value,
        onChange: e => setLeaf(preset, path, isFloat ? +e.target.value : Math.round(+e.target.value)),
        className: 'scfg-slider'
      }),
      desc ? h('div', { className: 'pcfg-desc' }, desc) : null
    );
  };

  // BudgetSlider — like PSlider but clamps onChange to remaining budget so
  // sum(positive in group) never exceeds 1.0. siblings prop is an array of
  // sibling field paths (relative to same path-prefix) to sum.
  const BudgetSlider = ({ preset, path, siblings, label, desc }) => {
    const meta = walkRanges(data.fieldRanges, path);
    if (!meta) return null;
    const others = siblings
      .filter(s => s.join('/') !== path.join('/'))
      .reduce((s, p) => s + (Number(getEffective(preset, p)) || 0), 0);
    const otherSteps = Math.round(others * 20);
    const budget = Math.max(0, 20 - otherSteps) / 20;
    const value = getEffective(preset, path);
    const atLimit = value >= budget - 1e-9;
    const dflt = getDefault(preset, path);
    const overridden = isOverridden(preset, path);
    return h('div', { className: 'pcfg-row' },
      h('div', { className: 'pcfg-row-top' },
        h('span', { className: 'pcfg-label' },
          label,
          overridden ? h('span', {
            className: 'pcfg-override-dot',
            title: 'Overridden (default: ' + dflt.toFixed(2) + ')'
          }) : null
        ),
        h('span', { className: 'pcfg-row-right' },
          h('span', {
            className: 'pcfg-val',
            style: atLimit ? { color: 'var(--green)' } : null
          }, Number(value).toFixed(2) + (atLimit ? ' ⛔' : '')),
          overridden ? h('button', {
            className: 'pcfg-reset-btn',
            onClick: () => resetField(preset, path),
            title: 'Reset to default (' + dflt.toFixed(2) + ')'
          }, '↺') : null
        )
      ),
      h('input', {
        type: 'range', min: 0, max: 1, step: 0.05,
        value: value,
        onChange: e => {
          const v = Math.min(+e.target.value, budget);
          setLeaf(preset, path, v);
        },
        className: 'scfg-slider'
      }),
      desc ? h('div', { className: 'pcfg-desc' }, desc) : null
    );
  };

  // PChips — chip-input for list fields. Renders items as removable chips
  // and an inline input that adds on Enter / blur.
  //
  // Phase 3: lockable chips — for paths under sources.reddit.subreddits and
  // sources.twitter.queries we attach lock toggles. Lock-key for twitter is
  // the keyword-part (without min_faves/-is:retweet) so it matches what
  // tag-refresher.js stores in presetTagsLocked.
  const PChips = ({ preset, path, max, placeholder }) => {
    const items = getEffective(preset, path) || [];
    const overridden = isOverridden(preset, path);
    const dflt = getDefault(preset, path) || [];
    const setList = (next) => setLeaf(preset, path, next);
    const remove = (idx) => setList(items.filter((_, i) => i !== idx));

    // Determine if this chip-list is lockable + which sourceType the lock-mask uses.
    let lockSourceType = null;
    let toLockKey = null;
    if (path.length === 3 && path[0] === 'sources') {
      if (path[1] === 'reddit' && path[2] === 'subreddits') {
        lockSourceType = 'reddit';
        toLockKey = (item) => item;  // subreddit name, used as-is
      } else if (path[1] === 'twitter' && path[2] === 'queries') {
        lockSourceType = 'twitter';
        // Strip min_faves and -is:retweet — match tag-refresher's normalization.
        toLockKey = (item) => String(item || '')
          .replace(/\s*min_faves:\d+\s*/g, '')
          .replace(/\s*-is:retweet\s*/g, '')
          .trim();
      } else if (path[1] === 'tiktok' && path[2] === 'hashtags') {
        lockSourceType = 'tiktok';
        // Lowercase + strip leading "#" — match the shape stored in
        // presetConfigsAuto.sources.tiktok.hashtags by tag-refresher.
        toLockKey = (item) => String(item || '').toLowerCase().replace(/^#+/, '').trim();
      }
    }

    return h(ChipInputBox, {
      items, placeholder, max,
      onAdd: (v) => {
        if (max && items.length >= max) return;
        if (items.includes(v)) return;
        setList([...items, v]);
      },
      onRemove: (idx) => {
        // If chip is locked — also unlock it, so we don't leave a dangling lock-key.
        if (lockSourceType && toLockKey) {
          const key = toLockKey(items[idx]);
          if (key && isLocked(preset, lockSourceType, key)) {
            toggleLock(preset, lockSourceType, key);
          }
        }
        remove(idx);
      },
      overridden,
      defaultLen: dflt.length,
      onReset: () => resetField(preset, path),
      // Lock interface — null when path doesn't support locking.
      lockSourceType,
      isLocked: lockSourceType && toLockKey
        ? (item) => isLocked(preset, lockSourceType, toLockKey(item))
        : null,
      onToggleLock: lockSourceType && toLockKey
        ? (item) => toggleLock(preset, lockSourceType, toLockKey(item))
        : null,
    });
  };

  // ── Helpers used by primitives ─────────────────────────────────────────
  const presets = data.presets;
  const groups  = data.groups;

  // Top-level layout
  return h('div', { className: 'adm-card', style: { marginBottom: 20 } },
    h('h3', { style: { marginBottom: 6 } }, '🎛️ Preset configs'),

    h('div', { className: 'pcfg-banner' },
      h('span', { className: 'pcfg-banner-icon' }, 'ℹ️'),
      h('div', null,
        h('div', { className: 'pcfg-banner-title' },
          'Per-preset pipeline tuning'),
        h('div', { className: 'pcfg-banner-desc' },
          'Каждый пресет хранит свой набор источников (subreddits / X queries / TikTok hashtags), ' +
          'junk-штрафов, alert-thresholds + весов, stale-decay и cluster-similarity. ' +
          'Активный пресет (его настройки реально применяются) переключается в табе «Сканеры». ' +
          'Здесь редактируются ВСЕ пять пресетов, по одному за раз.')
      )
    ),

    // Tab strip
    h('div', { className: 'adm-tabs bordered' },
      presets.map(p => h('button', {
        key: p,
        className: 'adm-tab capitalize' + (tab === p ? ' active' : ''),
        onClick: () => setTab(p),
      },
        getPresetIcon(p) + ' ' + p,
        draft[p] ? h('span', { className: 'adm-tab-dot', title: 'Has overrides' }) : null
      ))
    ),

    // Accordions for the active preset. getEffective is forwarded so the
    // SumMeter inside Alerts/Cluster can render a live sum of the current
    // draft (not just the server's last-saved snapshot).
    h(SourcesAccordion, {
      preset: tab, draft, data, h,
      PChips, PSlider,
    }),
    h(JunkAccordion, {
      preset: tab, h, PSlider,
      fields: data.fieldRanges.junk,
    }),
    h(AlertsAccordion, {
      preset: tab, h, PSlider, BudgetSlider, getEffective,
      fields: data.fieldRanges.alerts,
    }),
    h(ClusterAccordion, {
      preset: tab, h, PSlider, BudgetSlider, getEffective,
      fields: data.fieldRanges.cluster,
    }),

    // Actions
    h('div', { className: 'pcfg-actions' },
      h('button', {
        className: 'btn btn-primary btn-sm',
        disabled: saving,
        onClick: save,
      }, saving ? 'Сохранение...' : '💾 Save'),
      h('button', {
        className: 'btn btn-ghost btn-sm',
        disabled: saving,
        onClick: reload,
      }, '↺ Reload from server'),
      h('button', {
        className: 'btn btn-ghost btn-sm',
        disabled: saving || !draft[tab],
        onClick: () => resetPreset(tab),
      }, '🧹 Reset preset «' + tab + '»'),
      h('div', { className: 'pcfg-actions-spacer' }),
      h('button', {
        className: 'btn btn-ghost btn-sm',
        disabled: saving,
        onClick: wipeManualAll,
        title: 'Очистить manual слой во всех пресетах → auto-tags + defaults станут effective. ' +
               'Auto-overrides и locks НЕ задеваются. Используй для нормальной работы Auto-tags.',
      }, '🧹 Wipe manual'),
      h('button', {
        className: 'btn btn-ghost btn-sm',
        disabled: saving,
        onClick: restoreHardcoded,
        title: 'Записать hardcoded DEFAULT sources (subreddits / twitter queries / tiktok hashtags) ' +
               'в manual слой ВСЕХ пресетов. Это перекроет auto-tags и зафиксирует legacy теги. ' +
               'Используй когда auto-tags выдаёт мусор и нужен known-good baseline.',
      }, '↩ Restore hardcoded'),
      msg ? h('div', { className: 'pcfg-status ' + msgKind }, msg) : null,
    ),

    // Debug inspector
    h('details', { style: { marginTop: 14 } },
      h('summary', { style: { cursor: 'pointer', fontSize: 12, color: 'var(--text2)' } },
        '🔧 Debug — посмотреть raw blobs (defaults / effective / draft)'
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10 } },
        renderInspectorPane(h, 'Defaults · ' + tab, data.defaults[tab]),
        renderInspectorPane(h, 'Effective · ' + tab, data.effective[tab]),
        renderInspectorPane(h, 'Draft overrides · ' + tab, draft[tab] || {}),
      )
    )
  );
}

// ── Module-scope helpers + sub-components for PresetConfigsPage ─────────────
//
// These live outside the main function so React doesn't re-create them on
// every render (would defeat children memoisation if we ever add it).

function walkRanges(root, path) {
  let n = root;
  for (const k of path) {
    if (!n || typeof n !== 'object') return null;
    n = n[k];
  }
  // Only return if it's a leaf descriptor (has .type)
  return (n && typeof n === 'object' && n.type) ? n : null;
}

function getPresetIcon(p) {
  const map = { general: '🌐', animals: '🐾', culture: '🎭', celebrities: '⭐', events: '🌍' };
  return map[p] || '•';
}

function renderInspectorPane(h, title, obj) {
  return h('div', null,
    h('div', { style: { fontSize: 11, fontWeight: 600, color: 'var(--text2)', marginBottom: 4 } }, title),
    h('pre', {
      style: {
        margin: 0, padding: 8, background: 'var(--bg)',
        color: 'var(--text3)', border: '1px solid var(--border)',
        borderRadius: 6, fontSize: 10, lineHeight: 1.4,
        maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }
    }, JSON.stringify(obj || {}, null, 2))
  );
}

// ── Chip input box (shared by all list fields) ──────────────────────────────
function ChipInputBox({ items, placeholder, max, onAdd, onRemove, overridden, defaultLen, onReset, lockSourceType, isLocked, onToggleLock }) {
  const h = React.createElement;
  const [input, setInput] = useState('');

  const commit = () => {
    const v = input.trim();
    if (!v) return;
    onAdd(v);
    setInput('');
  };

  const lockable = !!(lockSourceType && isLocked && onToggleLock);

  return h('div', null,
    h('div', { className: 'pcfg-chips' },
      items.map((it, i) => {
        const locked = lockable && isLocked(it);
        return h('span', {
          key: i + ':' + it,
          className: 'pcfg-chip' + (locked ? ' pcfg-chip-locked' : ''),
          title: locked ? 'Залочено — auto-refresh не удалит этот элемент' : undefined,
        },
          lockable ? h('button', {
            className: 'pcfg-chip-lock',
            onClick: () => onToggleLock(it),
            title: locked ? 'Снять lock — auto-refresh сможет удалить' : 'Залочить — auto-refresh не удалит',
            style: { color: locked ? 'var(--ok)' : 'var(--text3)' },
          }, locked ? '🔒' : '🔓') : null,
          h('span', { className: 'pcfg-chip-text', title: it }, it),
          h('button', {
            className: 'pcfg-chip-x',
            onClick: () => onRemove(i),
            title: 'Удалить',
          }, '✕')
        );
      }),
      h('input', {
        className: 'pcfg-chip-input',
        value: input,
        placeholder: placeholder || 'Добавить и нажать Enter',
        onChange: e => setInput(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Backspace' && !input && items.length > 0) {
            // Friendly delete-last-on-empty-backspace
            onRemove(items.length - 1);
          }
        },
        onBlur: commit,
      })
    ),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--text3)' } },
      h('span', null,
        items.length + (max ? '/' + max : '') + ' items',
        overridden ? h('span', { className: 'pcfg-override-dot', style: { marginLeft: 6 } }) : null
      ),
      overridden ? h('button', {
        className: 'pcfg-reset-btn',
        onClick: onReset,
        title: 'Reset to defaults (' + defaultLen + ' items)',
        style: { fontSize: 11 },
      }, '↺ defaults') : null
    )
  );
}

// ── Sources accordion (per-platform sub-sections) ──────────────────────────
function SourcesAccordion({ preset, draft, data, h, PChips, PSlider }) {
  const overridden = !!(draft[preset] && draft[preset].sources);
  return h('details', { className: 'pcfg-accordion', open: true },
    h('summary', { className: 'pcfg-accordion-summary' },
      h('span', null, '📡 Sources', overridden ? h('span', { className: 'pcfg-override-dot', style: { marginLeft: 8 } }) : null),
      h('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
        'Reddit · Twitter · TikTok · X Trends · Google Trends')
    ),
    h('div', { className: 'pcfg-accordion-body' },
      // Reddit
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '🟠 Reddit'),
        h('div', { className: 'pcfg-row' },
          h('div', { className: 'pcfg-row-top' }, h('span', { className: 'pcfg-label' }, 'Subreddits')),
          h(PChips, {
            preset, path: ['sources', 'reddit', 'subreddits'],
            max: 30, placeholder: 'Например: aww (без r/)',
          })
        ),
        h(PSlider, { preset, path: ['sources', 'reddit', 'minUpvotes'], label: 'Min upvotes',
                     desc: 'Порог апвотов чтобы пост попал в pipeline.' }),
        h(PSlider, { preset, path: ['sources', 'reddit', 'postsPerSubreddit'], label: 'Posts / subreddit',
                     desc: 'Сколько hot-постов брать с каждого subreddit’а.' }),
      ),
      // Twitter
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '🐦 Twitter / X'),
        h('div', { className: 'pcfg-row' },
          h('div', { className: 'pcfg-row-top' }, h('span', { className: 'pcfg-label' }, 'Search queries')),
          h(PChips, {
            preset, path: ['sources', 'twitter', 'queries'],
            max: 20,
            placeholder: '(elon OR musk) min_faves:10000 -is:retweet',
          })
        )
      ),
      // TikTok
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '🎵 TikTok'),
        h('div', { className: 'pcfg-row' },
          h('div', { className: 'pcfg-row-top' }, h('span', { className: 'pcfg-label' }, 'Hashtags (без #)')),
          h(PChips, {
            preset, path: ['sources', 'tiktok', 'hashtags'],
            max: 30, placeholder: 'Например: memecoin',
          })
        )
      ),
      // X Trends — internal 30-min refresh via Apify, country=US (English priority).
      // Two knobs: enabled (0/1 toggle, slider acts as switch) + topN (5..50).
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '📈 X Trends'),
        h('div', { className: 'pcfg-desc', style: { marginBottom: 8 } },
          'Trending topics из X (United States). Refresh каждые 30 минут через Apify (~$13/мес). ' +
          'Все верхние тренды идут через тот же AI скоринг что и tweets/posts.'),
        h(PSlider, { preset, path: ['sources', 'xtrends', 'enabled'], label: 'Enabled (0/1)',
                     desc: '1 = ловим X trends в этом пресете, 0 = выкл. Глобальный kill-switch — env X_TRENDS_ENABLED=0.' }),
        h(PSlider, { preset, path: ['sources', 'xtrends', 'topN'], label: 'Top N trends',
                     desc: 'Сколько верхних трендов с каждого fetch (~50 в сыром выводе). 5-50, шаг 5.' }),
      ),
      // Google Trends
      h('div', { className: 'pcfg-subsection', style: { opacity: .55 } },
        h('div', { className: 'pcfg-subsection-title' }, '📊 Google Trends'),
        h('div', { className: 'pcfg-desc' },
          'Зарезервированный namespace. Per-source knob’ы (regions / categories / minScore) появятся позже.')
      )
    )
  );
}

// ── Junk accordion ──────────────────────────────────────────────────────────
function JunkAccordion({ preset, h, PSlider, fields }) {
  return h('details', { className: 'pcfg-accordion' },
    h('summary', { className: 'pcfg-accordion-summary' },
      h('span', null, '🚫 Junk filter'),
      h('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
        'Штрафы за политику / k-pop / celeb-noise / нет meme-shape')
    ),
    h('div', { className: 'pcfg-accordion-body' },
      Object.keys(fields).map(field => h(PSlider, {
        key: field, preset, path: ['junk', field],
        label: fields[field].label, desc: fields[field].desc,
      }))
    )
  );
}

// ── Alerts accordion (3 sub-groups) ─────────────────────────────────────────
function AlertsAccordion({ preset, h, PSlider, BudgetSlider, getEffective, fields }) {
  const weightSiblings = Object.keys(fields.weights)
    .filter(k => fields.weights[k].positive)
    .map(k => ['alerts', 'weights', k]);

  return h('details', { className: 'pcfg-accordion' },
    h('summary', { className: 'pcfg-accordion-summary' },
      h('span', null, '🔔 Alerts'),
      h('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
        'Thresholds · Weights · Stale decay')
    ),
    h('div', { className: 'pcfg-accordion-body' },
      // Thresholds
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '🎯 Thresholds'),
        Object.keys(fields.thresholds).map(field => h(PSlider, {
          key: field, preset, path: ['alerts', 'thresholds', field],
          label: fields.thresholds[field].label,
          desc: fields.thresholds[field].desc,
          formatValue: field === 'maxAlertsPerCycle'
            ? (v => v === 0 ? '∞' : String(v))
            : null,
        }))
      ),
      // Weights — positive must sum to ≤ 1.0 (BudgetSlider clamps)
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '⚖️ Weights · Σ positive ≤ 1.00'),
        h('div', { className: 'pcfg-desc', style: { marginBottom: 8 } },
          'meme + virality + emergence + twitter + feedback ≤ 1.0 (positive). ' +
          'Каждый ползунок упирается в свободный бюджет от соседей. ' +
          'junk — отдельный множитель штрафа (вычитается).'),
        Object.keys(fields.weights)
          .filter(k => fields.weights[k].positive)
          .map(field => h(BudgetSlider, {
            key: field, preset, path: ['alerts', 'weights', field],
            siblings: weightSiblings,
            label: '— ' + fields.weights[field].label,
            desc: fields.weights[field].desc,
          })),
        h(SumMeter, { preset, paths: weightSiblings, h, getEffective }),
        h(PSlider, {
          preset, path: ['alerts', 'weights', 'weightJunk'],
          label: '🗑️ junk ' + fields.weights.weightJunk.label,
          desc: fields.weights.weightJunk.desc,
        })
      ),
      // Stale decay
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '⏳ Stale decay'),
        h('div', { className: 'pcfg-desc', style: { marginBottom: 8 } },
          'Тренд теряет баллы по мере старения. Grace — часы без штрафа. Cap — максимальный штраф.'),
        Object.keys(fields.stale).map(field => h(PSlider, {
          key: field, preset, path: ['alerts', 'stale', field],
          label: fields.stale[field].label,
          desc: fields.stale[field].desc,
        }))
      )
    )
  );
}

// ── Cluster accordion ───────────────────────────────────────────────────────
function ClusterAccordion({ preset, h, PSlider, BudgetSlider, getEffective, fields }) {
  const clusterWeightSiblings = Object.keys(fields)
    .filter(k => fields[k].positive)
    .map(k => ['cluster', k]);

  return h('details', { className: 'pcfg-accordion' },
    h('summary', { className: 'pcfg-accordion-summary' },
      h('span', null, '🧬 Cluster'),
      h('span', { style: { fontSize: 11, color: 'var(--text3)', fontWeight: 400 } },
        'Similarity weights + threshold')
    ),
    h('div', { className: 'pcfg-accordion-body' },
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '⚙️ Threshold + time'),
        h(PSlider, { preset, path: ['cluster', 'simThreshold'],
                     label: fields.simThreshold.label, desc: fields.simThreshold.desc }),
        h(PSlider, { preset, path: ['cluster', 'timePenaltyHours'],
                     label: fields.timePenaltyHours.label, desc: fields.timePenaltyHours.desc }),
      ),
      h('div', { className: 'pcfg-subsection' },
        h('div', { className: 'pcfg-subsection-title' }, '🧮 Similarity weights · Σ ≤ 1.00'),
        h('div', { className: 'pcfg-desc', style: { marginBottom: 8 } },
          'Веса сигналов similarity. Сумма всех 4 ≤ 1.0. Если сигнал недоступен (нет картинки, ' +
          'nano выключен), его вес автоматически перераспределяется на остальные.'),
        clusterWeightSiblings.map(p => {
          const field = p[p.length - 1];
          return h(BudgetSlider, {
            key: field, preset, path: p,
            siblings: clusterWeightSiblings,
            label: '— ' + fields[field].label,
            desc: fields[field].desc,
          });
        }),
        h(SumMeter, { preset, paths: clusterWeightSiblings, h, getEffective })
      )
    )
  );
}

// SumMeter — live sum(positive weights) for a budget group. getEffective
// is the parent's closure walker over draft + defaults, so the figure stays
// in sync with the user's in-progress edits (not just the last server save).
function SumMeter({ preset, paths, h, getEffective }) {
  if (typeof getEffective !== 'function') return null;
  const sum = paths.reduce((s, p) => s + (Number(getEffective(preset, p)) || 0), 0);
  const cls = sum > 1.0001 ? 'over' : (sum > 0.95 ? 'full' : '');
  return h('div', { className: 'pcfg-budget ' + cls },
    'Σ = ' + sum.toFixed(2) + ' / 1.00');
}

// ── App Root ──────────────────────────────────────────────────────────────────
// StatusBar — pipeline visualisation pinned to the top of every page.
// Replaces the standalone PipelineFlow component in ScannersPage so the
// operator can see the live cycle from anywhere. Polls every 2.5s. Click
// the head (title) navigates to Сканеры for full controls.
function StatusBar({ onNavigate }) {
  const h = React.createElement;
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api('/api/pipeline')
        .then(s => { if (alive) { setState(s); setError(null); } })
        .catch(e => { if (alive) setError(e.message || 'unknown error'); });
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // No data yet — if we already errored, show compact warn banner; otherwise stay invisible.
  if (!state) {
    if (error) return h(ErrorBanner, { message: 'Pipeline status unavailable: ' + error, variant: 'warn' });
    return null;
  }

  // Same routing logic as the old PipelineFlow component
  const live     = state.running && state.cycleInProgress;
  const counts   = live ? state.cycleInProgress : (state.lastCycle || {});
  const curStage = state.currentStage || 'idle';
  const effectiveCurStage = curStage === 'ai' ? 'stage1' : curStage;
  const curIdx = PIPELINE_STAGES.findIndex(s => s.id === effectiveCurStage);

  let subtitle;
  if (state.paused) {
    subtitle = h('span', { className: 'sb-paused' }, '⏸ Сканер на паузе');
  } else if (state.running) {
    const activeLabel = curStage === 'ai' ? 'Stage 1 / Stage 2'
      : curStage === 'prestage' ? 'Stage 0 (nano + Gemini)'
      : (PIPELINE_STAGES[curIdx]?.label || 'работает');
    subtitle = h('span', null,
      h('span', { className: 'sb-live-dot' }),
      'Live — ' + activeLabel + '...'
    );
  } else if (state.lastCycle) {
    const ago = Math.max(0, Math.round((Date.now() - (state.lastCycle.completedAt || 0)) / 1000));
    const agoStr = ago < 60 ? ago + 'с назад' : Math.round(ago / 60) + 'м назад';
    const dur = state.lastCycle.durationMs ? (state.lastCycle.durationMs / 1000).toFixed(1) + 'с' : '—';
    subtitle = 'Последний цикл ' + agoStr + ' (за ' + dur + ')';
  } else {
    subtitle = 'Ожидание первого цикла...';
  }

  const fmt = (v) => (v === undefined || v === null ? '—' : String(v));

  // Per-stage tooltip — surfaces actual model used this cycle (Stage 1 is
  // configurable, Stage 2 is always Grok). Same logic as old PipelineFlow.
  const stage1Model = counts.stage1Model || state.lastCycle?.stage1Model || null;
  const stage2Model = counts.stage2Model || state.lastCycle?.stage2Model || null;
  const nanoModel    = counts.nanoModel    || state.lastCycle?.nanoModel    || null;
  const geminiModel  = counts.geminiModel  || state.lastCycle?.geminiModel  || null;
  const stageTitle = (s) => {
    if (s.id === 'stage1' && stage1Model) return s.label + ' · ' + stage1Model;
    if (s.id === 'stage2' && stage2Model) return s.label + ' · ' + stage2Model;
    if (s.id === 'prestage') {
      const parts = [];
      if (nanoModel)   parts.push('nano: ' + nanoModel);
      if (geminiModel) parts.push('vision: ' + geminiModel);
      return parts.length ? s.label + ' · ' + parts.join(', ') : (s.label + ' · ' + s.hint);
    }
    return s.label + ' · ' + s.hint;
  };

  const nodes = [];
  PIPELINE_STAGES.forEach((s, i) => {
    const isActive = live && (curStage === s.id || (curStage === 'ai' && PIPELINE_AI_IDS.has(s.id)));
    const isDone   = live ? (curIdx > i) : !!state.lastCycle;
    nodes.push(h('div', {
      key: s.id,
      className: 'sb-node' + (isActive ? ' active' : '') + (!isActive && isDone ? ' done' : ''),
      title: stageTitle(s),
    },
      h('div', { className: 'sb-node-ico' }, s.icon),
      h('div', { className: 'sb-node-cnt' }, fmt(counts[s.id]))
    ));
    if (i < PIPELINE_STAGES.length - 1) {
      const wireActive = live && curIdx === i + 1;
      const wireDone   = live ? curIdx > i + 1 : !!state.lastCycle;
      nodes.push(h('div', {
        key: 'w' + i,
        className: 'sb-wire' + (wireActive ? ' active' : '') + (!wireActive && wireDone ? ' done' : ''),
      }));
    }
  });

  return h('div', null,
    error ? h(ErrorBanner, { message: 'Pipeline status unavailable: ' + error, variant: 'warn' }) : null,
    h('div', { className: 'main-topbar sb-topbar' + (state.paused ? ' is-paused' : '') },
      h('div', {
        className: 'sb-head',
        onClick: () => onNavigate && onNavigate('scanners'),
        style: { cursor: onNavigate ? 'pointer' : 'default' },
        title: 'Открыть Сканеры',
      },
        h('h2', null, '🔄 Пайплайн'),
        h('p', null, subtitle)
      ),
      h('div', { className: 'sb-pipeline' }, nodes)
    )
  );
}

// ── TagRefreshPage — Phase 1 admin UI for tag auto-refresh ─────────────────
// Shows toggle, status badge, force button, history table, circuit-breaker reset.
// Phase 2 will add per-tag pin checkboxes inside PresetConfigsPage source lists.
function TagRefreshPage() {
  const h = React.createElement;
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgKind, setMsgKind] = useState('ok');
  // TikTok hashtag source (apify | grok). Stored as a separate DB setting,
  // read on every TikTok scan cycle. Loaded alongside refresh-status so the
  // toggle reflects current backend state without a second round-trip.
  const [tiktokSource, setTiktokSource] = useState('apify');
  const [tiktokSourceBusy, setTiktokSourceBusy] = useState(false);

  const flash = (m, kind) => {
    setMsg(m); setMsgKind(kind || 'ok');
    setTimeout(() => setMsg(''), 4000);
  };

  const load = () => {
    api('/api/tag-refresh/status')
      .then(d => setData(d))
      .catch(e => flash('Ошибка загрузки: ' + e.message, 'err'));
    api('/api/tiktok-hashtag-source')
      .then(d => setTiktokSource(d.source || 'apify'))
      .catch(() => { /* tolerate — toggle just stays apify */ });
  };
  useEffect(load, []);

  const switchTiktokSource = async (next) => {
    if (next === tiktokSource) return;
    setTiktokSourceBusy(true);
    try {
      const r = await api('/api/tiktok-hashtag-source', 'POST', { source: next });
      setTiktokSource(r.source || next);
      flash('TikTok hashtag source → ' + (r.source || next), 'ok');
    } catch (e) { flash('Ошибка: ' + e.message, 'err'); }
    finally { setTiktokSourceBusy(false); }
  };

  const toggle = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const next = !data.enabled;
      await api('/api/tag-refresh/toggle', 'POST', { enabled: next });
      flash(next ? 'Auto-refresh включён' : 'Auto-refresh выключен', 'ok');
      load();
    } catch (e) { flash('Ошибка: ' + e.message, 'err'); }
    finally { setBusy(false); }
  };

  const force = async () => {
    if (!data) return;
    if (!confirm('Запустить refresh сейчас? Он съест ~$0.13 на токены grok-4.3 и пойдёт по всем 5 пресетам. Force-cooldown ' + data.forceCooldownHours + 'h.')) return;
    setBusy(true);
    flash('Refresh запущен — ждём Grok-а по 5 пресетам, это может занять 5-20 мин. Не давай повторно.', 'ok');
    try {
      const r = await api('/api/tag-refresh/force', 'POST', {});
      // api() throws on !r.ok now — this success branch only fires on 200.
      flash('Refresh готов — ' + r.results.length + ' пресетов обработано за ' + r.elapsedSec + 'с', 'ok');
      load();
    } catch (e) {
      // 429 = cooldown. body.remainingMinutes set by server.
      if (e.status === 429 && e.body) {
        const mins = e.body.remainingMinutes;
        flash('Заблокировано: ' + e.body.reason + (mins ? ' (ещё ' + mins + ' мин до разблокировки)' : ''), 'err');
      } else {
        flash('Ошибка: ' + e.message, 'err');
      }
    }
    finally { setBusy(false); }
  };

  const resetBreaker = async () => {
    if (!confirm('Сбросить circuit-breaker и разрешить новые попытки?')) return;
    setBusy(true);
    try {
      await api('/api/tag-refresh/reset-breaker', 'POST', {});
      flash('Circuit-breaker сброшен', 'ok');
      load();
    } catch (e) { flash('Ошибка: ' + e.message, 'err'); }
    finally { setBusy(false); }
  };

  if (!data) return h('div', { className: 'page' }, h('h1', null, '🔄 Auto-tags'), h('p', null, 'Загрузка...'));

  const fmtTs = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { hour12: false });
  };
  const remaining = (iso) => {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'готов';
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    return days > 0 ? days + 'd ' + hours + 'h' : hours + 'h';
  };

  const statusBadge = data.circuitBreakerOpen
    ? h('span', { style: { color: 'var(--err)', fontWeight: 600 } }, '⛔ Circuit breaker open (' + data.failureStreak + ' fails)')
    : data.enabled
      ? h('span', { style: { color: 'var(--ok)', fontWeight: 600 } }, '✓ Enabled')
      : h('span', { style: { color: 'var(--muted)', fontWeight: 600 } }, '⏸ Disabled');

  return h('div', { className: 'page' },
    h('h1', null, '🔄 Auto-tags refresh'),
    h('div', { style: { fontSize: 13, color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 } },
      'Раз в ', String(data.cooldownDays), ' дней Grok ', data.model, ' (fallback: ', data.fallbackModel, ') ',
      'предлагает обновлённые subreddits и Twitter keywords для каждого пресета. ',
      'Manual overrides всегда побеждают auto. Cost: ~$0.13 за refresh, ~$0.54/мес.'
    ),

    // ── Status block ──
    h('div', { className: 'card', style: { marginBottom: 18, padding: 16 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
        h('div', null, h('strong', null, 'Status: '), statusBadge),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', {
            className: 'btn btn-' + (data.enabled ? 'ghost' : 'primary') + ' btn-sm',
            disabled: busy,
            onClick: toggle,
          }, data.enabled ? '⏸ Disable' : '▶ Enable'),
          h('button', {
            className: 'btn btn-primary btn-sm',
            disabled: busy || !data.enabled || data.circuitBreakerOpen,
            onClick: force,
            title: 'Force refresh now (rate-limited to 1×/' + data.forceCooldownHours + 'h)',
          }, '⚡ Force refresh now'),
          data.circuitBreakerOpen ? h('button', {
            className: 'btn btn-ghost btn-sm',
            disabled: busy,
            onClick: resetBreaker,
          }, '🔓 Reset breaker') : null,
        )
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, fontSize: 12 } },
        h('div', null, h('div', { style: { color: 'var(--muted)' } }, 'Last run'), h('div', null, fmtTs(data.lastRunAt))),
        h('div', null, h('div', { style: { color: 'var(--muted)' } }, 'Next scheduled'), h('div', null, fmtTs(data.nextRunAt), ' (', remaining(data.nextRunAt), ')')),
        h('div', null, h('div', { style: { color: 'var(--muted)' } }, 'Force available after'), h('div', null, fmtTs(data.nextForceAt), ' (', remaining(data.nextForceAt), ')'))
      )
    ),

    // ── TikTok hashtag source toggle ──────────────────────────────────────
    // Switches between the live Apify Creative Center pool (default —
    // "топовые но мусорные" tags) and the Grok-curated list refreshed
    // weekly by tag-refresher.js into presetConfigs.tiktok.hashtags.
    // When set to 'grok', the TikTok collector skips the Apify Creative
    // Center call entirely. When set to 'apify', original behavior.
    h('div', { className: 'card', style: { marginBottom: 18, padding: 16 } },
      h('h3', { style: { marginTop: 0, marginBottom: 8 } }, '🎵 TikTok hashtag source'),
      h('div', { style: { fontSize: 12, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 } },
        'Apify — топ-теги из TikTok Creative Center (refresh каждые 12ч). Включает много dance/lipsync/outfit-format мусора. ',
        'Grok — кастомный список, обновляется этим tag-refresher-ом (раз в ' + String(data.cooldownDays) + ' дней). ',
        'Переключение применится в следующем scan-цикле TikTok (по умолчанию каждые 30мин).'
      ),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', {
          className: 'btn btn-' + (tiktokSource === 'apify' ? 'primary' : 'ghost') + ' btn-sm',
          disabled: tiktokSourceBusy,
          onClick: () => switchTiktokSource('apify'),
        }, (tiktokSource === 'apify' ? '✓ ' : '') + 'Apify Creative Center'),
        h('button', {
          className: 'btn btn-' + (tiktokSource === 'grok' ? 'primary' : 'ghost') + ' btn-sm',
          disabled: tiktokSourceBusy,
          onClick: () => switchTiktokSource('grok'),
        }, (tiktokSource === 'grok' ? '✓ ' : '') + 'Grok (auto-tags)'),
      ),
      tiktokSource === 'grok' && h('div', { style: { fontSize: 11, color: 'var(--muted)', marginTop: 10, fontStyle: 'italic' } },
        '⚠ Если tag-refresher ещё не отрабатывал — TikTok будет использовать hardcoded fallback из preset-config.js (animals/culture/celebrities/events 3+3+3+3 теги). Жми "Force refresh now" сверху чтобы Grok сгенерил кастомные.'
      )
    ),

    // ── Auto-overrides preview ──
    h('div', { className: 'card', style: { marginBottom: 18, padding: 16 } },
      h('h3', { style: { marginTop: 0, marginBottom: 8 } }, '🤖 Current auto-overrides'),
      h('div', { style: { fontSize: 12, color: 'var(--muted)', marginBottom: 8 } },
        'Поля где Grok что-то предложил. Manual overrides поверх — всегда побеждают.'
      ),
      Object.keys(data.autoOverrides || {}).length === 0
        ? h('div', { style: { color: 'var(--muted)', fontSize: 12 } }, '— ничего не предложено (Phase 1 stub не делает реальных Grok-вызовов) —')
        : h('pre', { style: { background: 'var(--bg)', padding: 10, borderRadius: 6, fontSize: 11, overflow: 'auto', maxHeight: 280 } },
            JSON.stringify(data.autoOverrides, null, 2))
    ),

    // ── History table ──
    h('div', { className: 'card', style: { padding: 16 } },
      h('h3', { style: { marginTop: 0, marginBottom: 8 } }, '📜 Refresh history'),
      (data.history || []).length === 0
        ? h('div', { style: { color: 'var(--muted)', fontSize: 12 } }, '— пусто —')
        : h('table', { className: 'tbl', style: { width: '100%', fontSize: 12 } },
            h('thead', null, h('tr', null,
              h('th', null, 'Time'), h('th', null, 'Preset'), h('th', null, 'Source'),
              h('th', null, 'Status'), h('th', null, 'Model'), h('th', null, 'Cost'), h('th', null, 'Detail')
            )),
            h('tbody', null, ...(data.history || []).map(row => h('tr', { key: row.id },
              h('td', null, fmtTs(row.ts)),
              h('td', null, row.preset),
              h('td', null, row.source_type),
              h('td', null, h('span', {
                style: {
                  color: row.status === 'applied' ? 'var(--ok)' :
                         row.status === 'error' ? 'var(--err)' : 'var(--muted)'
                }
              }, row.status)),
              h('td', null, row.model || '—'),
              h('td', null, row.cost_usd != null ? '$' + row.cost_usd.toFixed(3) : '—'),
              h('td', { style: { fontSize: 11, color: 'var(--muted)' } }, row.error_message || (row.diff_json ? 'diff' : ''))
            )))
          )
    ),

    msg ? h('div', {
      style: { marginTop: 14, fontSize: 12, color: msgKind === 'err' ? 'var(--err)' : 'var(--ok)' }
    }, msg) : null
  );
}

function App() {
  const [authed, setAuthed] = useState(!!localStorage.getItem('adminKey'));
  const [tab, setTab] = useState('stats');
  // Lightweight live indicators on sidebar tabs — paused dot on Сканеры,
  // unread count on Алерты. Polled every 12s, fail silently. Lets the
  // operator notice activity without opening every tab.
  const [navHints, setNavHints] = useState({ paused: false, unsentDecisions: 0 });
  useEffect(() => {
    if (!authed) return;
    const load = async () => {
      try {
        const [pipe, dec] = await Promise.all([
          api('/api/pipeline').catch(()=>null),
          api('/api/alert-decisions?filter=skipped&limit=1').catch(()=>null),
        ]);
        setNavHints({
          paused: !!pipe?.paused,
          unsentDecisions: dec?.counts ? Object.values(dec.counts).reduce((a,b)=>a+b,0) : 0,
        });
      } catch(_) {}
    };
    load();
    const iv = setInterval(load, 12_000);
    return () => clearInterval(iv);
  }, [authed]);

  if (!authed) return React.createElement(AuthOverlay,{onAuth:()=>setAuthed(true)});

  const TABS = [
    {id:'stats',     icon:'📊', label:'Статистика'},
    {id:'scanners',  icon:'⚙️',  label:'Сканеры'},
    {id:'presets',   icon:'🎛️', label:'Пресеты'},
    {id:'tagrefresh',icon:'🔄', label:'Auto-tags'},
    {id:'submit',    icon:'🧪', label:'Ручной анализ'},
    {id:'decisions', icon:'🔔', label:'Алерты'},
    {id:'examples',  icon:'🎓', label:'AI Examples'},
    {id:'users',     icon:'👥', label:'Пользователи'},
    {id:'payments',  icon:'💳', label:'Платежи'},
    {id:'bot',       icon:'🤖', label:'Бот и планы'},
  ];

  const PAGE = {stats:StatsPage, scanners:ScannersPage, presets:PresetConfigsPage, tagrefresh:TagRefreshPage, submit:SubmitPage, decisions:DecisionsPage, examples:ExamplesPage, users:UsersPage, payments:PaymentsPage, bot:BotPage};
  const CurrentPage = PAGE[tab];

  return React.createElement('div',{className:'layout'},
    React.createElement('aside',{className:'sidebar'},
      React.createElement('div',{className:'logo'},
        React.createElement('h1',null,'Catalyst'),
        React.createElement('span',null,'Admin Panel')
      ),
      TABS.map(t=>{
        // Optional live hint per tab — paused dot for Сканеры, unread badge
        // for Алерты. Renders to the right of the label when active.
        let hint = null;
        if (t.id === 'scanners' && navHints.paused) {
          hint = React.createElement('span',{className:'nav-dot paused',title:'Сканер на паузе'});
        } else if (t.id === 'decisions' && navHints.unsentDecisions > 0) {
          hint = React.createElement('span',{className:'nav-badge'},navHints.unsentDecisions > 99 ? '99+' : navHints.unsentDecisions);
        }
        return React.createElement('div',{key:t.id,className:'nav-item'+(tab===t.id?' active':''),onClick:()=>setTab(t.id)},
          React.createElement('span',{className:'nav-icon'},t.icon),
          React.createElement('span',{className:'nav-label'},t.label),
          hint
        );
      }),
      React.createElement('div',{style:{marginTop:'auto',padding:'16px 20px',borderTop:'1px solid var(--border)'}},
        React.createElement('button',{className:'btn btn-ghost btn-sm',style:{width:'100%',fontSize:11},onClick:()=>{localStorage.removeItem('adminKey');_apiKey='';setAuthed(false);}},
          '🚪 Выйти'
        )
      )
    ),
    React.createElement('main',{className:'main'},
      React.createElement(StatusBar, { onNavigate: setTab }),
      React.createElement(CurrentPage,null)
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
</script>
</body>
</html>`;
  }

  // ── Manual narrative submit ──────────────────────────────────────────────────
  // Thin wrapper around runManualAnalysis() that adds the admin-specific
  // option of broadcasting to every active TG user after the analysis lands.
  // Dashboard + TG bot use runManualAnalysis() directly without broadcast.
  async _submitNarrative(rawUrl, sendToTelegram, opts = {}) {
    const result = await runManualAnalysis({
      scorer: this.scorer,
      db: this.db,
      clusterer: this.clusterer,
      url: rawUrl,
      save: true,           // admin path → adds the trend to the global feed
      logger: this.logger,
      actorId: 'admin',
    });
    const { trend, dbId, elapsedMs, pipeline, fromCache, cacheAgeMs } = result;

    const alertResults = sendToTelegram
      ? await this._broadcastTrendAlert(trend, dbId, { comment: opts.comment || '' })
      : [];
    if (sendToTelegram) {
      this.logger.info(`[ManualSubmit] alerts=${alertResults.filter(a => a.ok).length}/${alertResults.length}`);
    }

    return {
      ok: true,
      elapsedMs,
      pipeline,
      fromCache: !!fromCache,
      cacheAgeMs: cacheAgeMs || 0,
      // Shape via the shared helper so the live submit response and the
      // /api/manual-trends history endpoint always render identically.
      trend: this._shapeManualTrend(trend, dbId),
      alerts: alertResults,
    };
  }

  // Broadcast a TG alert for an already-analysed trend to every active user.
  // Returns a per-user results array (same shape _submitNarrative used to emit).
  // Used by both the inline submit-with-TG flow and the standalone
  // POST /api/send-alert endpoint (button on an already-analysed narrative).
  async _broadcastTrendAlert(trend, dbId, opts = {}) {
    const alertResults = [];
    const users = this.db.getActiveUsers();
    const comment = typeof opts.comment === 'string' ? opts.comment : '';
    for (const user of users) {
      if (user.status === 'suspended') continue;
      try {
        const sent = await this.telegram.sendAlertToUser(trend, user, { comment });
        if (sent) {
          this.db.recordNotification(dbId, 'telegram', user.id);
          this.db.incrementAlertCount(user.id);
          if (sent.messageId && typeof this.telegram.attachXButton === 'function') {
            try {
              await this.telegram.attachXButton(sent.chatId, sent.messageId, dbId, user, trend);
            } catch { /* best-effort — buttons aren't critical for manual push */ }
            // Save tg_message_id so the dashboard can link to the TG alert
            try {
              const existing = this.db.getTrendById?.(dbId);
              if (existing && !existing.tg_message_id) {
                let msgUrl = '';
                if (String(sent.chatId).startsWith('-100')) {
                  msgUrl = `https://t.me/c/${String(sent.chatId).slice(4)}/${sent.messageId}`;
                }
                this.db.updateTgUrl?.(dbId, msgUrl, sent.messageId);
              }
            } catch { /* non-fatal */ }
          }
          alertResults.push({ userId: user.id, chatId: user.telegram_chat_id, ok: true });
        } else {
          alertResults.push({ userId: user.id, chatId: user.telegram_chat_id, ok: false, reason: 'send returned false' });
        }
        // Small spacing so we don't hammer Telegram rate-limit
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {
        alertResults.push({ userId: user.id, chatId: user.telegram_chat_id, ok: false, reason: e.message });
      }
    }
    return alertResults;
  }

  // Rebuild a scorer-shaped trend object from a DB row (for re-sending an alert
  // on a trend that was already saved). DB row is mostly flat — metrics live
  // inside raw_metrics as JSON. We restore the same field names the
  // Telegram notifier reads (metrics.imageUrls, storyHook, etc).
  _hydrateTrendFromDb(row) {
    if (!row) return null;
    let metrics = {};
    try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch {}
    return {
      _dbId:           row.id,
      id:              row.id,
      source:          row.source,
      title:           row.title,
      originalTitle:   row.original_title || row.title,
      // description column on the trends table — needed by SubmitPage history
      // so the "📝 Описание поста" block renders the same as on the live
      // submit response.
      description:     row.description || metrics.description || '',
      url:             row.url,
      category:        row.category,
      sentiment:       row.sentiment,
      score:           row.score,
      memePotential:   metrics.memePotential || 0,
      adoptionScore:   metrics.adoptionScore  ?? metrics.memePotential ?? 0,
      emergenceScore:  metrics.emergenceScore ?? 0,
      storyScore:      metrics.storyScore     ?? 0,
      storyHook:       metrics.storyHook      ?? '',
      narrativePhase:  metrics.narrativePhase  ?? null,
      rankScore:       metrics.rankScore       ?? null,
      alertScore:      metrics.alertScore      ?? null,
      alertBreakdown:  metrics.alertBreakdown  ?? null,
      // Alert-type axis (event/trend/post). Prefer the dedicated column when
      // hydrating from DB; fall back to the raw_metrics mirror so historical
      // rows whose column is NULL but raw_metrics already has it (e.g. rows
      // saved by the same process under the new schema before column-update)
      // still surface the type in admin SubmitPage history.
      alertType:       row.alert_type || metrics.alertType || null,
      marketStage:     metrics.marketStage     ?? null,
      junkPenalty:     metrics.junkPenalty     ?? 0,
      junkReasons:     metrics.junkReasons     ?? [],
      velocity:        metrics.velocity        ?? 0,
      // Stage 0 PreStage enrichment — restored from raw_metrics so the
      // /api/send-alert flow and SubmitPage display see the same context
      // Stage 1 actually saw at scoring time (no re-paying Gemini/nano).
      preStage:        metrics.preStage        ?? null,
      aiExplanation:   row.ai_explanation,
      whyNow:          row.why_now || '',
      // Deep trigger from on-demand Grok-reasoning search (filled by Pro click,
      // shared across users). May be null when no user has searched yet.
      triggerText:     row.trigger_text || null,
      triggerSources:  (() => { try { return JSON.parse(row.trigger_sources || '[]'); } catch { return []; } })(),
      triggerConfidence: row.trigger_confidence | 0,
      predictedLifespan: row.predicted_lifespan,
      xSearchData:     metrics.xSearchData || { storyScore: metrics.storyScore || 0, storyHook: metrics.storyHook || '' },
      // Stage 2 deltas — saved per-trend so the SubmitPage history can show
      // the same penalty/bonus chips after page reload.
      stage2Penalty:    metrics.stage2Penalty    || null,
      stage2StoryBonus: metrics.stage2StoryBonus || null,
      stage2NameBonus:  metrics.stage2NameBonus  || null,
      textOnlyPenalty:  metrics.textOnlyPenalty  || null,
      // Cluster routing inputs (snapshot at scoring time).
      clusterMetrics:   metrics.clusterMetrics   || null,
      // Stage 1 viralityScore lives in raw_metrics for non-current rows; the
      // SubmitPage chip block reads it via t.viralityScore.
      viralityScore:    metrics.viralityScore    ?? row.virality_score ?? null,
      // Manual-submit marker (drives 🧪 MANUAL chip + history visibility).
      manualSubmitted:  metrics.manualSubmitted === true,
      manualSubmittedAt: metrics.manualSubmittedAt || row.first_seen_at || null,
      // Original creation time (Telegram alert showed first_seen_at; we
      // reuse it as a "submitted at" timestamp in the history list).
      firstSeenAt:      row.first_seen_at || null,
      metrics,
    };
  }

  // Shape a hydrated trend (from _submitNarrative or _hydrateTrendFromDb)
  // into the public SubmitPage payload. Single source of truth so the
  // initial submit response and the GET /api/manual-trends history list
  // render identically.
  _shapeManualTrend(trend, dbId) {
    return {
      id: dbId || trend._dbId || trend.id,
      source: trend.source,
      title: trend.title,
      originalTitle: trend.originalTitle || trend.title,
      url: trend.url,
      description: trend.description || null,
      score: trend.score,
      viralityScore: trend.viralityScore ?? null,
      memePotential: trend.memePotential,
      emergenceScore: trend.emergenceScore,
      adoptionScore: trend.adoptionScore,
      storyScore: trend.xSearchData?.storyScore || trend.storyScore || 0,
      storyHook: trend.xSearchData?.storyHook || trend.storyHook || '',
      category: trend.category,
      sentiment: trend.sentiment,
      predictedLifespan: trend.predictedLifespan,
      aiExplanation: trend.aiExplanation,
      whyNow: trend.whyNow,
      triggerText: trend.triggerText || trend.trigger?.text || null,
      triggerSources: trend.triggerSources || trend.trigger?.sources || [],
      triggerConfidence: trend.triggerConfidence || trend.trigger?.confidence || 0,
      narrativePhase: trend.narrativePhase,
      alertType: trend.alertType || null,
      marketStage: trend.marketStage,
      alertScore: trend.alertScore,
      junkPenalty: trend.junkPenalty,
      xSearchData: trend.xSearchData || null,
      stage2Penalty: trend.stage2Penalty || null,
      stage2StoryBonus: trend.stage2StoryBonus || null,
      stage2NameBonus: trend.stage2NameBonus || null,
      textOnlyPenalty: trend.textOnlyPenalty || null,
      clusterMetrics: trend.clusterMetrics || null,
      memeShapeSignals: trend.metrics?.memeShapeSignals || trend.memeShapeSignals || null,
      junkReasons: trend.clusterMetrics?.junkReasons || trend.metrics?.junkReasons || trend.junkReasons || [],
      preStage: trend.preStage || trend.metrics?.preStage || null,
      imageUrls: trend.metrics?.imageUrls || [],
      videoUrl: trend.metrics?.videoUrl || null,
      metrics: trend.metrics,
      manualSubmitted: trend.manualSubmitted === true || trend.metrics?.manualSubmitted === true,
      manualSubmittedAt: trend.manualSubmittedAt || trend.metrics?.manualSubmittedAt || trend.firstSeenAt || null,
    };
  }

  // Reconstruct the gate-trace shown above the score grid. For history items
  // we don't have the live-pipeline trace anymore, so we re-derive from
  // saved fields the same way _submitNarrative does inline.
  _derivePipelineTrace(trend) {
    const s2Threshold = parseInt(this.db.getSetting?.('stage2Threshold', '60'), 10) || 60;
    const stage1Ran = typeof trend.memePotential === 'number';
    const stage2Ran = !!trend.xSearchData && (
      typeof trend.xSearchData.xBuzz === 'string' ||
      typeof trend.xSearchData.narrativeMomentum === 'string' ||
      typeof trend.xSearchData.organicity === 'string' ||
      (trend.xSearchData.storyScore || 0) > 0
    );
    let stage2SkipReason = null;
    if (!stage2Ran) {
      if ((trend.memePotential || 0) < s2Threshold) {
        stage2SkipReason = `memePotential ${trend.memePotential || 0} < threshold ${s2Threshold}`;
      } else if (trend.source === 'google_trends') {
        stage2SkipReason = 'google_trends source skipped from Stage 2';
      } else if (trend.clusterMetrics?.isNovel === false) {
        stage2SkipReason = 'duplicate cluster (isNovel=false)';
      } else {
        stage2SkipReason = 'cap reached or Stage 2 disabled';
      }
    }
    return { stage1Ran, stage2Ran, stage2SkipReason, stage2Threshold: s2Threshold };
  }


  // ── Start ────────────────────────────────────────────────────────────────────
  start() {
    if (!this.adminKey) {
      this.logger.warn('ADMIN_API_KEY is not set — admin API is locked (set ADMIN_API_KEY to enable access)');
    }

    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch(e => {
        this.logger.error('Admin server error', { error: e.message });
        try { json(res, 500, { error: 'Internal error' }); } catch {}
      });
    });

    this.server.listen(this.port, this.host, () => {
      this.logger.info(`Admin panel running at http://${this.host}:${this.port}`);
    });

    this.server.on('error', e => this.logger.error('Admin server error', { error: e.message }));
  }

  /** Graceful shutdown — stop accepting + drain in-flight, hard-cap at timeoutMs. */
  stop(timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      const t = setTimeout(() => {
        try { this.server?.closeAllConnections?.(); } catch {}
        resolve();
      }, timeoutMs);
      t.unref?.();
    });
  }
}

export default AdminServer;
