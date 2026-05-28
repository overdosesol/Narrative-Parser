import config from './config.js';
import fs from 'fs';
import path from 'path';
import Logger from './utils/logger.js';
import TrendDatabase from './db/database.js';
import RedditCollector from './collectors/reddit.js';
import GoogleTrendsCollector from './collectors/google-trends.js';
import TwitterCollector from './collectors/twitter.js';
import TikTokCollector from './collectors/tiktok.js';
import XTrendsCollector from './collectors/x-trends.js';
import Aggregator from './analysis/aggregator.js';
import Scorer, { loadAlertWeights, computeAlertScore, feedbackBoostFromStats } from './analysis/scorer.js';
import { getActivePresetConfig } from './analysis/preset-config.js';
import NarrativeClusterer from './analysis/clusterer.js';
import TriggerFinder from './analysis/trigger-finder.js';
import NanoClassifier from './analysis/nano-classifier.js';
import GeminiCaptioner from './analysis/gemini-captioner.js';
import PreStage from './analysis/pre-stage.js';
import TelegramNotifier from './notifications/telegram.js';
import { recomputeAlertScores, dispatchAlerts } from './notifications/alert-dispatcher.js';
import { AlertScheduler } from './notifications/alert-scheduler.js';
import SupportBot from './support/bot.js';
import { initAdminAlerts, notifyAdminCrash } from './notifications/admin-alert.js';
import HotMetricsRefresher from './refresh/hot-metrics.js';
import TagRefresher from './refresh/tag-refresher.js';
import SolanaPayMonitor from './billing/solana-pay.js';
import DashboardServer from './dashboard/server.js';
import AdminServer from './admin/server.js';
import { getTranslations } from './i18n/index.js';

const logger = new Logger(config.logLevel);

logger.info('═══════════════════════════════════════════');
logger.info('  🔥 Catalyst v3.0 — Starting up...');
logger.info('═══════════════════════════════════════════');

// ── Initialize core components ──────────────────────────────────────────────
const db         = new TrendDatabase(config.dbPath, logger);
const aggregator = new Aggregator(db, logger);
const clusterer  = new NarrativeClusterer(db, logger);

// ── Stage 0 (PreStage) — text + visual enrichment before scoring ──────────
// nano: gpt-5.4-nano via OPENAI_API_KEY (text). gemini: gemini-3.1-flash
// via OPENROUTER_API_KEY (vision). Both fail gracefully — when either key
// is missing the corresponding sub-stage is skipped, scoring works as before.
// Pass `db` so the classifier can read its admin-toggle setting at runtime.
// Without `db` the classifier still works — just no live admin toggle.
const nanoClassifier  = new NanoClassifier(config, logger, db);
const geminiCaptioner = new GeminiCaptioner(config, logger);
const preStage = new PreStage(logger, { nanoClassifier, geminiCaptioner });
if (preStage.enabled) {
  logger.info('PreStage enabled: nano=' + (nanoClassifier.enabled ? 'on' : 'off') +
              ', gemini=' + (geminiCaptioner.enabled ? 'on' : 'off'));
} else {
  logger.info('PreStage disabled (no Stage 0 keys configured)');
}

const scorer = new Scorer(config, logger, db, preStage);

// On-demand trigger search (Pro-plan button in TG + dashboard).
// Disabled gracefully when XAI_API_KEY is missing — `enabled` flag exposed
// so handlers can show "trigger search unavailable" instead of failing.
const triggerFinder = new TriggerFinder(config, logger);

// ── Initialize Telegram Bot ─────────────────────────────────────────────────
// scorer is passed for the pro/admin /analyze + bare-URL manual-analysis flow.
const telegram = new TelegramNotifier(config, logger, db, null, triggerFinder, scorer, clusterer); // solanaMonitor injected below; clusterer used by manual-analysis emergence path

// ── Alert scheduler (per-user FIFO cooldown queue) ──────────────────────────
// Paces outgoing Telegram alerts so a single user doesn't get 5 pings/sec from
// one scan cycle. Cooldown / cap / max-age are admin-tunable via DB settings
// (tgAlertCooldown* keys). Scheduler reads them per-tick. Manual-submit path
// in telegram.js (_handleSendAlert) intentionally does NOT route through here
// — those alerts are user-triggered and must be instant.
const alertScheduler = new AlertScheduler({ logger, db });
alertScheduler.start();
telegram.scheduler = alertScheduler;  // for pause-toggle dropQueue hook

// Hidden trends archive — sweep entries older than 7 days. Run once on
// startup, then daily. Per-user dashboard archive feature; rows accumulate
// until either the user restores them or this sweeper drops them.
const HIDDEN_TREND_RETENTION_DAYS = 7;
try {
  const swept = db.cleanupExpiredHiddenTrends(HIDDEN_TREND_RETENTION_DAYS);
  if (swept > 0) logger.info(`[Maintenance] hidden_trends: pruned ${swept} entries older than ${HIDDEN_TREND_RETENTION_DAYS}d`);
} catch (e) { logger.warn(`[Maintenance] hidden_trends sweep failed: ${e.message}`); }
setInterval(() => {
  try {
    const swept = db.cleanupExpiredHiddenTrends(HIDDEN_TREND_RETENTION_DAYS);
    if (swept > 0) logger.info(`[Maintenance] hidden_trends: pruned ${swept} entries (daily)`);
  } catch (e) { logger.warn(`[Maintenance] hidden_trends sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);

// Alert-score history retention (sparkline data). 30 days = balance of
// "show last week's evolution" vs "table doesn't grow forever". On startup
// + daily, same pattern as hidden_trends sweep above.
const ALERT_SCORE_HISTORY_RETENTION_DAYS = 30;
try {
  const swept = db.pruneAlertScoreHistory(ALERT_SCORE_HISTORY_RETENTION_DAYS);
  if (swept > 0) logger.info(`[Maintenance] alert_score_history: pruned ${swept} rows older than ${ALERT_SCORE_HISTORY_RETENTION_DAYS}d`);
} catch (e) { logger.warn(`[Maintenance] alert_score_history sweep failed: ${e.message}`); }
setInterval(() => {
  try {
    const swept = db.pruneAlertScoreHistory(ALERT_SCORE_HISTORY_RETENTION_DAYS);
    if (swept > 0) logger.info(`[Maintenance] alert_score_history: pruned ${swept} rows (daily)`);
  } catch (e) { logger.warn(`[Maintenance] alert_score_history sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);

// Bundle #2 (2026-06-07): retention cleanup for new observability tables.
// alert_decisions — 14d (debugging window for post-deploy incidents).
// feature_usage_log — 7d (caps need only 24h; extra week for cap-hit debugging).
// admin_audit_log — no cleanup (audit-grade data, low write rate; defer until scaling concern).
const ALERT_DECISIONS_RETENTION_DAYS  = 14;
const FEATURE_USAGE_RETENTION_DAYS    =  7;
try { db.pruneAlertDecisions(ALERT_DECISIONS_RETENTION_DAYS); }
catch (e) { logger.warn(`[Maintenance] alert_decisions sweep failed: ${e.message}`); }
try { db.pruneFeatureUsageLog(FEATURE_USAGE_RETENTION_DAYS); }
catch (e) { logger.warn(`[Maintenance] feature_usage_log sweep failed: ${e.message}`); }
setInterval(() => {
  try { db.pruneAlertDecisions(ALERT_DECISIONS_RETENTION_DAYS); }
  catch (e) { logger.warn(`[Maintenance] alert_decisions sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);
setInterval(() => {
  try { db.pruneFeatureUsageLog(FEATURE_USAGE_RETENTION_DAYS); }
  catch (e) { logger.warn(`[Maintenance] feature_usage_log sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);

// Bundle #10 (2026-05-28): retention for notifications + 3 audit-style tables.
// notifications        — 30d  (DB-008)
// feedback_votes       — 90d  (DB-009 — votes lose forecasting value after 3mo)
// x_analysis_history   — 90d  (DB-009 — X virality snapshots, debugging window)
// tag_refresh_history  — 365d (DB-009 — audit log of preset reloads, low write rate)
const NOTIFICATIONS_RETENTION_DAYS   =  30;
const FEEDBACK_VOTES_RETENTION_DAYS  =  90;
const X_ANALYSIS_RETENTION_DAYS      =  90;
const TAG_REFRESH_RETENTION_DAYS     = 365;

try {
  const n = db.pruneNotifications(NOTIFICATIONS_RETENTION_DAYS);
  if (n > 0) logger.info(`[Maintenance] notifications: pruned ${n} rows older than ${NOTIFICATIONS_RETENTION_DAYS}d`);
} catch (e) { logger.warn(`[Maintenance] notifications sweep failed: ${e.message}`); }
try {
  const n = db.pruneFeedbackVotes(FEEDBACK_VOTES_RETENTION_DAYS);
  if (n > 0) logger.info(`[Maintenance] feedback_votes: pruned ${n} rows older than ${FEEDBACK_VOTES_RETENTION_DAYS}d`);
} catch (e) { logger.warn(`[Maintenance] feedback_votes sweep failed: ${e.message}`); }
try {
  const n = db.pruneXAnalysisHistory(X_ANALYSIS_RETENTION_DAYS);
  if (n > 0) logger.info(`[Maintenance] x_analysis_history: pruned ${n} rows older than ${X_ANALYSIS_RETENTION_DAYS}d`);
} catch (e) { logger.warn(`[Maintenance] x_analysis_history sweep failed: ${e.message}`); }
try {
  const n = db.pruneTagRefreshHistory(TAG_REFRESH_RETENTION_DAYS);
  if (n > 0) logger.info(`[Maintenance] tag_refresh_history: pruned ${n} rows older than ${TAG_REFRESH_RETENTION_DAYS}d`);
} catch (e) { logger.warn(`[Maintenance] tag_refresh_history sweep failed: ${e.message}`); }

setInterval(() => {
  try { db.pruneNotifications(NOTIFICATIONS_RETENTION_DAYS); }
  catch (e) { logger.warn(`[Maintenance] notifications sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);
setInterval(() => {
  try { db.pruneFeedbackVotes(FEEDBACK_VOTES_RETENTION_DAYS); }
  catch (e) { logger.warn(`[Maintenance] feedback_votes sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);
setInterval(() => {
  try { db.pruneXAnalysisHistory(X_ANALYSIS_RETENTION_DAYS); }
  catch (e) { logger.warn(`[Maintenance] x_analysis_history sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);
setInterval(() => {
  try { db.pruneTagRefreshHistory(TAG_REFRESH_RETENTION_DAYS); }
  catch (e) { logger.warn(`[Maintenance] tag_refresh_history sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);

// Bundle #6 (2026-05-28): housekeeping daily loops.
// video-cache       — 3d  (DB-010 + DB-023 — tightened from 7d default for disk safety)
// auth_sessions     — 24h (DB-011 — moved from boot-only)
// logs              — 14d (DB-014 — application-level rotation)
const VIDEO_CACHE_RETENTION_DAYS    =  3;
const AUTH_SESSIONS_RETENTION_HOURS = 24;
const LOG_RETENTION_DAYS            = 14;

try {
  telegram.cleanupVideoCache(VIDEO_CACHE_RETENTION_DAYS);
} catch (e) { logger.warn(`[Maintenance] video-cache sweep failed: ${e.message}`); }
try {
  const n = db.pruneAuthSessions(AUTH_SESSIONS_RETENTION_HOURS);
  if (n > 0) logger.info(`[Maintenance] auth_sessions: pruned ${n} rows older than ${AUTH_SESSIONS_RETENTION_HOURS}h`);
} catch (e) { logger.warn(`[Maintenance] auth_sessions sweep failed: ${e.message}`); }
try {
  const n = logger.cleanupOldLogs(LOG_RETENTION_DAYS);
  if (n > 0) logger.info(`[Maintenance] logs: pruned ${n} files older than ${LOG_RETENTION_DAYS}d`);
} catch (e) { logger.warn(`[Maintenance] log rotation failed: ${e.message}`); }

setInterval(() => {
  try { telegram.cleanupVideoCache(VIDEO_CACHE_RETENTION_DAYS); }
  catch (e) { logger.warn(`[Maintenance] video-cache sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);
setInterval(() => {
  try { db.pruneAuthSessions(AUTH_SESSIONS_RETENTION_HOURS); }
  catch (e) { logger.warn(`[Maintenance] auth_sessions sweep failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);
setInterval(() => {
  try { logger.cleanupOldLogs(LOG_RETENTION_DAYS); }
  catch (e) { logger.warn(`[Maintenance] log rotation failed: ${e.message}`); }
}, 24 * 60 * 60 * 1000);

// ── Initialize Solana Pay Monitor ───────────────────────────────────────────
const solanaMonitor = new SolanaPayMonitor(
  config,
  logger,
  db,
  async (userId, planName) => {
    // Find the user and send them a confirmation message
    try {
      const users = db.getActiveUsers();
      const user = users.find(u => u.id === userId);
      if (!user || !telegram.bot) return;
      const t = getTranslations(user.language);
      const planDisplay = t[`plan${planName.charAt(0).toUpperCase() + planName.slice(1)}`] || planName;
      await telegram.bot.sendMessage(
        user.telegram_chat_id,
        t.paymentConfirmed(planDisplay),
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      logger.error(`Payment confirmation notify failed: ${e.message}`);
    }
  }
);

// Inject monitor into bot (after both are created to avoid circular deps)
telegram.solanaMonitor = solanaMonitor;

// ── Support bot (forum-topics relay) ────────────────────────────────────────
// Separate Telegram bot dedicated to user-support tickets. Each user gets a
// forum topic in a private admin group; admin replies in topics are routed
// back to the user. Disabled gracefully when env vars are missing.
const supportBot = new SupportBot(config, logger, db);
supportBot.start();

// Bundle #13 (2026-05-28): wire admin crash alerts to support bot instance.
// supportBot.bot is the underlying node-telegram-bot-api instance.
initAdminAlerts(supportBot?.bot, config, logger);

// Periodic refresh + re-score of "hot" trends (≤24h, memePotential≥50). Re-fetches
// live metrics from source (free: fxtwitter / reddit json) every 2h, runs them
// back through Stage 1 + Stage 2, then dispatches alerts for any trend whose
// alertScore just crossed the threshold (dedup gate prevents double-alerting).
// Toggle: db setting hotRefreshEnabled (admin).
const hotRefresher = new HotMetricsRefresher({
  db, scorer, logger,
  telegram,                                     // shared notifier — same path as scan-cycle
  config,                                       // for alertThreshold fallback
  recordDecision: recordAlertDecision,          // append to the same admin ring buffer
  normalizeThreshold,                           // [0..100] integer clamp
});
hotRefresher.start();

// Tag auto-refresh — weekly Grok call to suggest fresh subreddits + Twitter
// keywords per preset. Real xAI Responses API call with x_search tool +
// fallback model on 5xx. Variant-3 reality-check for proposed Twitter
// keyword groups via 1 Apify probe per group (skips already-existing groups).
// Model: grok-4.3 primary, grok-4.20-0309-reasoning fallback.
// Toggle: db setting tagAutoRefreshEnabled (admin).
// Note: TwitterCollector instance is initialized below in `collectors`. The
// tag-refresher needs it for reality-check probes — we wire it AFTER both
// the refresher and the twitter instance exist (see _attachTwitter call below).
const tagRefresher = new TagRefresher({ db, logger, config, telegram });

// Hourly check loop — fires refreshAll() when 7-day cooldown expired AND
// auto-refresh is enabled AND circuit breaker is closed. First check 5 min
// after boot to keep startup light.
setTimeout(() => {
  setInterval(async () => {
    try {
      const gate = tagRefresher.shouldRefreshNow();
      if (gate.ok) {
        logger.info(`[TagRefresher] cooldown expired (${gate.reason}) — running scheduled refresh`);
        await tagRefresher.refreshAll();
      }
    } catch (e) {
      logger.error(`[TagRefresher] scheduled run failed: ${e.message}`);
    }
  }, 60 * 60 * 1000);  // hourly
}, 5 * 60 * 1000);  // first check 5 min after boot

// ── Initialize collectors ───────────────────────────────────────────────────
const collectors = [];
if (config.reddit.enabled)       collectors.push(new RedditCollector(config, logger, db));
if (config.googleTrends.enabled) collectors.push(new GoogleTrendsCollector(config, logger));
if (config.twitter.enabled)      collectors.push(new TwitterCollector(config, logger, db));
if (config.tiktok.enabled)       collectors.push(new TikTokCollector(config, logger, db));

// X Trends — discovery layer (daily): pulls top-3 trending hashtags via Apify
// `karamelo/twitter-trends-scraper`, then for each calls TwitterCollector's
// scraper actor to fetch the top 7 real tweets — those flow into the pipeline
// as regular twitter items with real engagement. Needs a TwitterCollector ref
// for searchByQuery(); if Twitter is disabled, X Trends self-disables.
// Kill switches: env X_TRENDS_ENABLED=0 OR per-preset xtrends.enabled=0.
const twitterInstance = collectors.find(c => c.name === 'Twitter') || null;
// Wire twitter instance into tag-refresher AFTER it's been constructed.
// tag-refresher uses it for variant-3 reality-check probes on proposed
// Twitter keyword groups (1 Apify call per new group; existing groups skipped).
if (twitterInstance) tagRefresher.twitter = twitterInstance;
const xTrendsCollector = new XTrendsCollector(config, logger, db, twitterInstance);
if (xTrendsCollector.enabled) {
  collectors.push(xTrendsCollector);
  xTrendsCollector.startRefreshTimer();
}

logger.info(`Active collectors: ${collectors.map(c => c.name).join(', ') || 'none'}`);
logger.info(`Alert threshold (global default): ${config.alertThreshold}/100`);
logger.info(`Scan interval: ${config.scanIntervalMinutes} minutes`);

function normalizeThreshold(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeSourceName(name) {
  const raw = String(name || '').toLowerCase();
  if (raw === 'googletrends' || raw === 'google_trends') return 'google_trends';
  return raw;
}

// ── Shared runtime state (mutated by admin panel and dashboard) ────────────
const appState = {
  paused: false,
  scanRunning: false,
  disabledCollectors: new Set(),
  lastStorageCheckAt: 0,
  // Pipeline observability — drives the admin flow-diagram animation.
  // currentStage: idle|collect|dedupe|cluster|prestage|ai|save|alerts|done
  currentStage: 'idle',
  stageStartedAt: null,
  cycleStartedAt: null,
  cycleInProgress: null,   // live per-stage counters for the active cycle
  lastCycle: null,         // snapshot of the previous completed cycle
  // Ring buffer of per-trend alert-gate decisions (last N). Mirrored to the
  // admin UI so you can see exactly why a trend was or wasn't alerted.
  alertDecisions: [],
  alertDecisionsCap: 500,
};

function setPipelineStage(stage) {
  appState.currentStage = stage;
  appState.stageStartedAt = Date.now();
}

function recordAlertDecision(rec) {
  // ADM-002 + PIPE-016 (Bundle #2): memory buffer stays as fast cache for
  // /api/decisions API; DB write becomes authoritative for post-mortem.
  appState.alertDecisions.push({ ts: new Date().toISOString(), ...rec });
  const over = appState.alertDecisions.length - appState.alertDecisionsCap;
  if (over > 0) appState.alertDecisions.splice(0, over);

  // Fire-and-forget DB write. Error swallow — never block alert flow.
  // db.recordAlertDecision already wraps the INSERT in try/catch + logger.error,
  // so this outer try/catch is belt-and-suspenders for edge cases like `db`
  // being undefined during early-boot.
  try {
    db.recordAlertDecision({
      trendId: rec.trend_id ?? rec.trendId ?? null,
      userId:  rec.user_id  ?? rec.userId  ?? null,
      source:  rec.source   ?? null,
      reason:  rec.reason,
      gates:   rec.gates    ?? null,
      weights: rec.weights  ?? null,
      sent:    rec.sent === true || rec.reason === 'sent',
    });
  } catch (e) {
    // db.recordAlertDecision already logs; this catch handles edge cases
    // like `db` being undefined. Stay silent — alert flow is more important.
  }
}


const STORAGE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const LOW_DISK_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const CRITICAL_DISK_FREE_BYTES = 1 * 1024 * 1024 * 1024;

function formatGb(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

function runStorageGuard() {
  const now = Date.now();
  if (now - appState.lastStorageCheckAt < STORAGE_CHECK_INTERVAL_MS) return;
  appState.lastStorageCheckAt = now;

  try {
    const targetDir = path.dirname(config.dbPath);
    const stat = fs.statfsSync(targetDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (freeBytes >= LOW_DISK_FREE_BYTES) return;

    const days = freeBytes < CRITICAL_DISK_FREE_BYTES ? 7 : 14;
    logger.warn(`Low disk space: ${formatGb(freeBytes)} GB free. Running alert cleanup (${days}d)...`);
    const result = db.cleanupAlerts(days);
    logger.warn(`Storage cleanup done: trends=${result.trendsDeleted}, notifications=${result.notificationsDeleted}`);

    // The DB cleanup above only frees a few MB on this project (DB ~10MB
    // total). The real disk hog on this VPS is Docker build cache (we hit
    // 85% disk on 2026-04-27 from accumulated layers, not from data).
    // From inside the container we can't touch host docker — but we CAN
    // truncate our own log files which DO grow unbounded between deploys.
    try {
      const logsDir = path.resolve(process.cwd(), 'logs');
      if (fs.existsSync(logsDir)) {
        const cutoffMs = Date.now() - 7 * 24 * 3600_000;
        let purged = 0;
        let bytesFreed = 0;
        for (const file of fs.readdirSync(logsDir)) {
          const full = path.join(logsDir, file);
          try {
            const s = fs.statSync(full);
            if (s.isFile() && s.mtimeMs < cutoffMs) {
              bytesFreed += s.size;
              fs.unlinkSync(full);
              purged++;
            }
          } catch (_) { /* skip locked file */ }
        }
        if (purged > 0) {
          logger.warn(`Storage cleanup: removed ${purged} log file(s) older than 7d (${formatGb(bytesFreed)} GB)`);
        }
      }
    } catch (e) {
      logger.warn(`Log cleanup failed: ${e.message}`);
    }
  } catch (e) {
    logger.warn(`Storage guard failed: ${e.message}`);
  }
}

// Restore disabled collectors persisted by dashboard/admin
try {
  const saved = JSON.parse(db.getSetting('disabledCollectors', '[]') || '[]');
  if (Array.isArray(saved)) {
    for (const name of saved) {
      appState.disabledCollectors.add(normalizeSourceName(name));
    }
    if (saved.length > 0) {
      logger.info(`Restored disabled collectors: ${[...appState.disabledCollectors].join(', ')}`);
    }
  }
} catch (e) {
  logger.warn(`Failed to restore disabled collectors: ${e.message}`);
}

// ── Initialize dashboard ────────────────────────────────────────────────────
const dashboard = new DashboardServer(config, logger, db, appState, () => runScanCycle(), telegram, triggerFinder, { scorer, clusterer });
dashboard.start();

// ── Initialize admin panel ──────────────────────────────────────────────────
const admin = new AdminServer(config, logger, db, telegram.bot, appState, () => runScanCycle(), {
  scorer,
  clusterer,      // used by manual-submit to compute emergence (same formula as scanner)
  telegram,       // full wrapper — needed for sendAlertToUser + attachXButton
  triggerFinder,  // optional Grok deep-search; SubmitPage button → /api/trends/:id/trigger
  hotRefresher,   // status reads + manual trigger from admin /api/hot-refresh/*
  tagRefresher,   // weekly auto-refresh of source-tags (admin /api/tag-refresh/*)
  alertScheduler, // per-user FIFO cooldown queue (config + live stats endpoints)
});
admin.start();

// ── Start Solana Pay monitor ────────────────────────────────────────────────
solanaMonitor.start(30_000);

/**
 * Main scan cycle — collect → deduplicate → AI score → notify all active users
 */
async function runScanCycle() {
  if (appState.paused) {
    logger.info('────── Scan cycle skipped (paused via admin/dashboard) ──────');
    return;
  }
  if (appState.scanRunning) {
    logger.info('────── Scan cycle skipped (already running) ──────');
    return;
  }

  appState.scanRunning = true;
  try { dashboard.broadcast('scan-start', { at: Date.now() }); } catch (e) {}

  const cycleStart = Date.now();
  appState.cycleStartedAt = cycleStart;
  appState.cycleInProgress = {
    collect: 0, dedupe: 0, cluster: 0,
    // `prestage` = trends enriched by Stage 0 (nano + gemini). Counts as 0
    // when PreStage is disabled — card still appears in the pipeline UI.
    prestage: 0,
    // `ai` kept for backwards compat (= total trends scored). New split:
    // `stage1` = trends through base scoring, `stage2` = actual x_search calls.
    ai: 0, stage1: 0, stage2: 0,
    save: 0, alerts: 0,
  };
  setPipelineStage('collect');
  logger.info('────── Starting scan cycle ──────');

  try {
    runStorageGuard();

    // Step 1: Collect from all enabled sources
    const allRawTrends = [];
    for (const collector of collectors) {
      if (appState.disabledCollectors.has(normalizeSourceName(collector.name))) {
        logger.info(`[${collector.name}] Skipped (disabled via admin panel)`);
        continue;
      }
      const items = await collector.safeCollect();
      allRawTrends.push(...items);
    }
    appState.cycleInProgress.collect = allRawTrends.length;

    if (allRawTrends.length === 0) {
      logger.info('No trends collected this cycle');
      return;
    }
    logger.info(`Total raw trends collected: ${allRawTrends.length}`);

    // Step 2: Aggregate & deduplicate
    setPipelineStage('dedupe');
    const newTrends = aggregator.process(allRawTrends);
    appState.cycleInProgress.dedupe = newTrends.length;
    if (newTrends.length === 0) {
      logger.info('No new trends after deduplication');
      return;
    }

    // ─── PR-2 PIPELINE ORDER ─────────────────────────────────────────────
    // Aggregator → cheapDedup → PreStage → SmartCluster → Stage 1 → Stage 2
    //
    // PreStage now runs BEFORE clustering so the clusterer sees Gemini's
    // visualCaption/videoSummary and nano's entityCanonical at decision
    // time — semantically richer signal than title alone. The cheap dedup
    // step protects PreStage from paying for exact-text bot copypaste
    // ladders before the smart cluster pass collapses real narratives.
    //
    // Cost note: items that the smart clusterer eventually drops or marks
    // `save_only` now still pay for PreStage (1 nano + 1 gemini call each).
    // cheapDedup mitigates the worst case; the rest is the price for a
    // clusterer that actually understands content. ────────────────────────

    // Step 2.4: cheapDedup — pure in-memory, exact-text/url collisions.
    const uniqueTrends = clusterer.cheapDedup(newTrends);

    // Step 2.5: PreStage (Stage 0) — text + visual enrichment.
    // Tracked as a separate pipeline stage so the admin Pipeline card
    // animates it distinctly. PreStage NEVER filters/scores — output goes
    // into trend.preStage and is read by buildAnalysisPrompt + clusterer's
    // similarity function. Failures degrade silently (preStage = null).
    if (preStage.enabled) {
      setPipelineStage('prestage');
      const ps0 = Date.now();
      try {
        await preStage.enrichBatch(uniqueTrends);
      } catch (e) {
        logger.warn(`PreStage threw, continuing without enrichment: ${e.message}`);
      }
      const enrichedCount = uniqueTrends.filter(t => t.preStage).length;
      appState.cycleInProgress.prestage = enrichedCount;
      // Surface model names so the admin Pipeline card tooltip shows what
      // actually ran (Gemini may have fallen back silently).
      appState.cycleInProgress.nanoModel   = nanoClassifier.enabled  ? nanoClassifier.model    : null;
      appState.cycleInProgress.geminiModel = geminiCaptioner.enabled ? geminiCaptioner._activeModel : null;
      logger.info(`PreStage: ${enrichedCount}/${uniqueTrends.length} trends enriched in ${Date.now() - ps0}ms`);
    } else {
      appState.cycleInProgress.prestage = 0;
    }

    // Step 2.6: Smart cluster routing — multi-signal similarity. Now reads
    // PreStage outputs (videoSummary, visualCaption, entityCanonical) for
    // semantically-aware clustering. async because of OpenAI embeddings +
    // image-hash batches; degrades to fewer signals or Jaccard on failure.
    setPipelineStage('cluster');
    const { priority, toScore, toSave, droppedCount } = await clusterer.route(uniqueTrends);
    appState.cycleInProgress.cluster = (priority?.length || 0) + (toScore?.length || 0);

    // Save "save_only" items directly (no AI cost, no alerts). They now
    // carry PreStage data into the DB even though they never went to Stage 1
    // — a future cycle that re-clusters this narrative will benefit.
    for (const trend of toSave) {
      db.saveTrend({
        ...trend,
        score:           0,
        memePotential:   0,
        aiExplanation:   null,
        predictedLifespan: null,
        category:        null,
        sentiment:       null,
      });
    }
    if (toSave.length > 0) {
      logger.info(`Saved ${toSave.length} low-signal trends (no AI scoring)`);
    }

    // Priority items go first in the AI batch — higher meme potential expected
    const toScoreAll = [...priority, ...toScore];
    if (toScoreAll.length === 0) {
      logger.info(`No trends to score after cluster routing (dropped=${droppedCount})`);
      return;
    }

    // Step 3: AI scoring
    setPipelineStage('ai');
    logger.info(`Running AI scoring on ${toScoreAll.length} trends (${priority.length} priority)...`);
    const scoredTrends = await scorer.scoreTrends(toScoreAll);
    appState.cycleInProgress.ai = scoredTrends.length;
    // Split AI into Stage 1 / Stage 2 cards. scorer.lastMetrics is set by
    // scoreTrends(); falls back to scoredTrends.length / 0 on heuristic path
    // where lastMetrics is unset.
    const aiMetrics = scorer.lastMetrics || null;
    appState.cycleInProgress.stage1 = aiMetrics ? aiMetrics.stage1Trends : scoredTrends.length;
    appState.cycleInProgress.stage2 = aiMetrics ? aiMetrics.stage2Calls   : 0;
    appState.cycleInProgress.stage1Model = aiMetrics?.stage1Provider
      ? `${aiMetrics.stage1Provider}:${aiMetrics.stage1Model}`
      : null;
    appState.cycleInProgress.stage2Model = aiMetrics?.stage2Model || null;

    // Step 4: Filter — drop politics/spam
    setPipelineStage('save');
    const validTrends = scoredTrends.filter(t =>
      t.category !== 'politics' && t.isGenuinelyInteresting !== false
    );

    // Save all valid trends to DB. minScoreToSave is per-preset since
    // 2026-05-01 (PR-2 of preset-configs) — pulled via the helper inline.
    const presetCfgForSave = getActivePresetConfig(db);
    const minScoreToSave = Number(presetCfgForSave.alerts?.thresholds?.minScoreToSave ?? 0) || 0;
    const allToSave = validTrends.filter(t =>
      (t.score || 0) >= minScoreToSave || (t.memePotential || 0) >= minScoreToSave
    );
    for (const trend of allToSave) {
      // pipeline_status governs isTrendSeen behaviour on the NEXT scan:
      //   'scored'     → blocked (within rescoreCooldownHours) — AI got a real verdict
      //   'save_only'  → always pass through — needs another shot at AI
      //
      // _aiUnavailable flag is set by scorer._fallback when the LLM provider
      // returned 5xx / timeout / parse-error and we had to use heuristic
      // scoring. We mark such trends 'save_only' so next scan re-attempts
      // the AI call (and the alert-dispatcher.ai_score gate suppresses
      // the bogus heuristic-only alert in the meantime).
      const status = trend._aiUnavailable ? 'save_only' : 'scored';
      const trendId = db.saveTrend({ ...trend, pipelineStatus: status });
      trend._dbId = trendId;
    }
    appState.cycleInProgress.save = allToSave.length;

    logger.info(`Scored ${scoredTrends.length} trends, saved ${allToSave.length}`);

    // Step 5: Send notifications per-user based on their individual settings
    const activeUsers = db.getActiveUsers();
    // Per-preset alert thresholds since 2026-05-01 (PR-2). The "global"
    // floor is now whatever the active preset's alerts.thresholds.alertThreshold
    // resolves to — preserving the legacy "global" naming for clarity in
    // log messages and per-user MAX(...) gating below.
    const presetCfgForAlerts = getActivePresetConfig(db);
    const globalAlertThreshold = normalizeThreshold(
      presetCfgForAlerts.alerts?.thresholds?.alertThreshold,
      config.alertThreshold
    );
    const alertWeights = loadAlertWeights(db);

    // (Re)compute alertScore for every candidate using LIVE inputs:
    //  - fresh feedback counts (so a flurry of 👍/👎 shifts the alert gate now)
    //  - actual age in hours from first_seen_at (drives staleDecay)
    // The alertScore baked in by the scorer is only a coarse estimate — we
    // trust the live probe here, right before the gate.
    recomputeAlertScores(validTrends, alertWeights, db, {
      source: 'scan',
      floor: globalAlertThreshold,
    });

    logger.info(
      `Alert gate: alertScore>=${globalAlertThreshold} (weights: ` +
      `meme=${alertWeights.weightMemePotential}, viral=${alertWeights.weightVirality}, ` +
      `emerge=${alertWeights.weightEmergence}, x=${alertWeights.weightTwitter}, ` +
      `junk×${alertWeights.weightJunk}, hardJunk>=${alertWeights.hardJunkStop})`
    );
    setPipelineStage('alerts');
    logger.info(`Sending alerts to ${activeUsers.length} active user(s)`);

    // Hand off to the shared dispatcher — same logic the hot-refresh loop
    // uses, so a trend that ripens past the threshold during refresh still
    // alerts via the exact same gate cascade.
    const dispatchResult = await dispatchAlerts({
      trends: validTrends,
      source: 'scan',
      deps: {
        db, telegram, logger, config,
        alertWeights, presetCfg: presetCfgForAlerts, globalAlertThreshold,
        normalizeThreshold,
        recordDecision: recordAlertDecision,
        scheduler: alertScheduler,
      },
    });

    if (dispatchResult.sent > 0 && appState.cycleInProgress) {
      appState.cycleInProgress.alerts = (appState.cycleInProgress.alerts || 0) + dispatchResult.sent;
    }

    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
    logger.info(`────── Cycle complete in ${elapsed}s ──────`);

  } catch (error) {
    logger.error(`Scan cycle failed: ${error.message}`, { stack: error.stack });
  } finally {
    // Snapshot the cycle as "last completed" so the admin flow diagram keeps
    // showing meaningful numbers between scans instead of dashes.
    if (appState.cycleInProgress) {
      appState.lastCycle = {
        ...appState.cycleInProgress,
        startedAt:   appState.cycleStartedAt,
        completedAt: Date.now(),
        durationMs:  Date.now() - (appState.cycleStartedAt || Date.now()),
      };
    }
    appState.cycleInProgress = null;
    appState.cycleStartedAt = null;
    setPipelineStage('idle');
    appState.scanRunning = false;
    // Persist the wall-clock timestamp of this completion so a deploy/restart
    // doesn't trigger an immediate scan — the scheduler reads this on boot
    // and waits out the remaining slice of the interval instead of kicking
    // off a fresh full cycle (which was wasteful after every deploy).
    try { db.setSetting('lastScanCompletedAt', String(Date.now())); } catch (e) {}
    // Notify all connected dashboard clients that fresh data is available
    try { dashboard.broadcast('refresh', { at: Date.now() }); } catch (e) {}
  }
}

/**
 * Scheduler — runs scan cycle at configured interval.
 *
 * Runtime-tunable: reads `scanIntervalMinutes` from DB before each tick, so
 * admin slider changes take effect on the NEXT cycle without restart. Falls
 * back to `config.scanIntervalMinutes` (from SCAN_INTERVAL_MINUTES env, default
 * 15) if DB setting is missing/invalid. Clamped to [5, 60] mins — see admin
 * server `allowedInt` validator for the source-of-truth range.
 *
 * Replaced naive `setInterval` 2026-05-11 — that version locked the cadence
 * to startup-time env; ползунок в админке требует self-rescheduling loop.
 */
function startScheduler() {
  const readIntervalMs = () => {
    const fromDb = Number(db.getSetting('scanIntervalMinutes'));
    const minutes = Number.isFinite(fromDb) && fromDb >= 5 && fromDb <= 60
      ? fromDb
      : config.scanIntervalMinutes;
    return minutes * 60 * 1000;
  };

  const initialMin = Math.round(readIntervalMs() / 60_000);
  logger.info(`Scheduler started — scanning every ${initialMin} minutes (runtime-tunable via admin)`);

  const scheduleNext = () => {
    setTimeout(async () => {
      try { await runScanCycle(); } catch (e) { logger.error(`Scheduled scan failed: ${e.message}`); }
      scheduleNext();  // re-reads interval AFTER cycle finishes — picks up slider change
    }, readIntervalMs());
  };

  // Deploy-aware boot: if a previous run completed less than `interval` ago,
  // wait out the REMAINING slice instead of running a fresh scan immediately.
  // Keeps the cadence stable across deploys — restart no longer burns a full
  // collector+scorer cycle every time we ship code. Saved on every cycle's
  // finally block (see runScanCycle). Missing/zero → first boot ever → scan now.
  const lastScanAt = Number(db.getSetting('lastScanCompletedAt', '0')) || 0;
  const intervalMs = readIntervalMs();
  const sinceLast  = Date.now() - lastScanAt;
  if (lastScanAt > 0 && sinceLast >= 0 && sinceLast < intervalMs) {
    const remaining = intervalMs - sinceLast;
    const ageMin    = Math.round(sinceLast / 60_000);
    const waitMin   = Math.max(1, Math.round(remaining / 60_000));
    logger.info(`Resuming after restart — last scan ${ageMin}m ago, next in ~${waitMin}m`);
    setTimeout(async () => {
      try { await runScanCycle(); } catch (e) { logger.error(`Scheduled scan failed: ${e.message}`); }
      scheduleNext();
    }, remaining);
  } else {
    // First boot OR interval already elapsed while down — run a scan now and
    // start the self-rescheduling loop. `sinceLast < 0` (clock skew → future
    // timestamp) also falls here, treated as "stale, scan now".
    if (lastScanAt > 0) {
      logger.info(`Interval elapsed during downtime (${Math.round(sinceLast/60_000)}m since last scan) — scanning now`);
    }
    runScanCycle().then(() => { scheduleNext(); });
  }

  // Daily cleanup + reset alert counts at midnight
  const scheduleDailyTasks = () => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    setTimeout(() => {
      db.cleanup(30);
      db.resetDailyAlertCounts();
      logger.info('Daily cleanup + alert count reset done');
      scheduleDailyTasks();
    }, midnight.getTime() - now.getTime());
  };
  scheduleDailyTasks();
}

// ── Graceful shutdown ───────────────────────────────────────────────────────
// Two-phase: phase 1 stops collectors / new work, phase 2 drains HTTP servers
// (waits up to 10s for in-flight requests). Hard-cap at 15s overall - better
// to lose a stuck request than hang the process under systemd / Docker, where
// an unresponsive process gets SIGKILL'd anyway.
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;     // re-entry guard - SIGTERM can fire twice
  _shuttingDown = true;
  logger.info(`Received ${signal} - shutting down gracefully...`);

  // Hard cap on the whole shutdown - protects against a hung db.close() or
  // a Telegram polling loop refusing to exit.
  const hardCap = setTimeout(() => {
    logger.warn('Shutdown hard cap reached (15s) - forcing exit');
    process.exit(1);
  }, 15_000);
  hardCap.unref?.();

  try {
    solanaMonitor.stop();
    await telegram.stop();
    // Drain HTTP servers in parallel - independent so don't serialize them.
    await Promise.allSettled([
      dashboard.stop(10_000),
      admin.stop(10_000),
    ]);
    db.close();
  } catch (e) {
    logger.error(`Shutdown error: ${e.message}`);
  }
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Bundle #13 (PROD-006): log + admin TG notification. 5-min dedupe via notifyAdminCrash.
// Note: handlers still don't process.exit — Docker healthcheck handles fatal-state restart.
process.on('uncaughtException', err => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  notifyAdminCrash(err, { kind: 'uncaughtException' });
});
process.on('unhandledRejection', reason => {
  logger.error(`Unhandled rejection: ${reason}`);
  const err = reason instanceof Error ? reason : new Error(String(reason));
  notifyAdminCrash(err, { kind: 'unhandledRejection' });
});

// ── Start! ──────────────────────────────────────────────────────────────────
startScheduler();
