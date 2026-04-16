import config from './config.js';
import fs from 'fs';
import path from 'path';
import Logger from './utils/logger.js';
import TrendDatabase from './db/database.js';
import RedditCollector from './collectors/reddit.js';
import GoogleTrendsCollector from './collectors/google-trends.js';
import TwitterCollector from './collectors/twitter.js';
import TikTokCollector from './collectors/tiktok.js';
import Aggregator from './analysis/aggregator.js';
import Scorer from './analysis/scorer.js';
import NarrativeClusterer from './analysis/clusterer.js';
import TelegramNotifier from './notifications/telegram.js';
import SolanaPayMonitor from './billing/solana-pay.js';
import DashboardServer from './dashboard/server.js';
import AdminServer from './admin/server.js';
import { getTranslations } from './i18n/index.js';

const logger = new Logger(config.logLevel);

logger.info('═══════════════════════════════════════════');
logger.info('  🔥 TrendScout v3.0 — Starting up...');
logger.info('═══════════════════════════════════════════');

// ── Initialize core components ──────────────────────────────────────────────
const db         = new TrendDatabase(config.dbPath, logger);
const aggregator = new Aggregator(db, logger);
const clusterer  = new NarrativeClusterer(db, logger);
const scorer     = new Scorer(config, logger, db);

// ── Initialize Telegram Bot ─────────────────────────────────────────────────
const telegram = new TelegramNotifier(config, logger, db); // solanaMonitor injected below

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

// ── Initialize collectors ───────────────────────────────────────────────────
const collectors = [];
if (config.reddit.enabled)       collectors.push(new RedditCollector(config, logger, db));
if (config.googleTrends.enabled) collectors.push(new GoogleTrendsCollector(config, logger));
if (config.twitter.enabled)      collectors.push(new TwitterCollector(config, logger, db));
if (config.tiktok.enabled)       collectors.push(new TikTokCollector(config, logger, db));

logger.info(`Active collectors: ${collectors.map(c => c.name).join(', ') || 'none'}`);
logger.info(`Alert threshold (global default): ${config.alertThreshold}/100`);
logger.info(`Virality threshold (global default): ${config.viralityThreshold}/100`);
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
const appState = { paused: false, scanRunning: false, disabledCollectors: new Set(), lastStorageCheckAt: 0 };

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
const dashboard = new DashboardServer(config, logger, db, appState, () => runScanCycle());
dashboard.start();

// ── Initialize admin panel ──────────────────────────────────────────────────
const admin = new AdminServer(config, logger, db, telegram.bot, appState);
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

  const cycleStart = Date.now();
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

    if (allRawTrends.length === 0) {
      logger.info('No trends collected this cycle');
      return;
    }
    logger.info(`Total raw trends collected: ${allRawTrends.length}`);

    // Step 2: Aggregate & deduplicate
    const newTrends = aggregator.process(allRawTrends);
    if (newTrends.length === 0) {
      logger.info('No new trends after deduplication');
      return;
    }

    // Step 2.5: Pre-AI cluster routing — signal quality layer
    const { priority, toScore, toSave, droppedCount } = clusterer.route(newTrends);

    // Save "save_only" items directly (no AI cost, no alerts)
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
    logger.info(`Running AI scoring on ${toScoreAll.length} trends (${priority.length} priority)...`);
    const scoredTrends = await scorer.scoreTrends(toScoreAll);

    // Step 4: Filter — drop politics/spam
    const validTrends = scoredTrends.filter(t =>
      t.category !== 'politics' && t.isGenuinelyInteresting !== false
    );

    // Save all valid trends to DB
    const minScoreToSave = db.getSetting('minScoreToSave', 0);
    const allToSave = validTrends.filter(t =>
      (t.score || 0) >= minScoreToSave || (t.memePotential || 0) >= minScoreToSave
    );
    for (const trend of allToSave) {
      const trendId = db.saveTrend(trend);
      trend._dbId = trendId;
    }

    logger.info(`Scored ${scoredTrends.length} trends, saved ${allToSave.length}`);

    // Step 5: Send notifications per-user based on their individual settings
    const activeUsers = db.getActiveUsers();
    const globalMemeThreshold = normalizeThreshold(
      db.getSetting('alertThreshold', config.alertThreshold),
      config.alertThreshold
    );
    const globalViralityThreshold = normalizeThreshold(
      db.getSetting('viralityThreshold', config.viralityThreshold),
      config.viralityThreshold
    );

    logger.info(
      `Alert gates: meme>=${globalMemeThreshold} (global floor), virality>=${globalViralityThreshold}`
    );
    logger.info(`Sending alerts to ${activeUsers.length} active user(s)`);

    // Sort by meme potential descending
    const alertCandidates = validTrends
      .filter(t => t._dbId)
      .sort((a, b) => (b.memePotential || 0) - (a.memePotential || 0));

    for (const user of activeUsers) {
      // Skip suspended users
      if (user.status === 'suspended') continue;

      // Check if subscription is expired → downgrade to free
      if (db.isSubscriptionExpired(user)) {
        db.updateUser(user.id, 'plan_id', 1); // free plan
        db.updateUser(user.id, 'subscription_expires_at', null);
        logger.info(`Subscription expired for user ${user.telegram_chat_id} — downgraded to free`);
      }

      // Get this user's disabled sources
      let userDisabledSources = [];
      try { userDisabledSources = JSON.parse(user.disabled_sources || '[]'); } catch(e) {}

      // Get this user's threshold (per-user or fallback to global)
      const userThreshold = normalizeThreshold(user.alert_threshold, config.alertThreshold);
      const effectiveMemeThreshold = Math.max(userThreshold, globalMemeThreshold);

      // Get max alerts per cycle from global settings
      const maxAlertsPerCycle = db.getSetting('maxAlertsPerCycle', 0);

      let alertsSentThisCycle = 0;

      for (const trend of alertCandidates) {
        // Check per-cycle cap
        if (maxAlertsPerCycle > 0 && alertsSentThisCycle >= maxAlertsPerCycle) break;

        // Check daily alert limit for this user's plan
        if (!db.canUserReceiveAlert(user)) {
          logger.debug(`User ${user.telegram_chat_id} reached daily alert limit (${user.alert_limit})`);
          break;
        }

        // Check user's meme potential threshold
        if ((trend.memePotential || 0) < effectiveMemeThreshold) continue;

        // Global virality gate (reduces noisy alerts even with high memePotential)
        if ((trend.score || 0) < globalViralityThreshold) continue;

        // Check if this trend's source is disabled by this user
        if (userDisabledSources.includes(trend.source?.toLowerCase())) continue;

        // Check if we already sent this trend to this user
        if (db.wasNotificationSentToUser(trend._dbId, user.id)) continue;

        // Send the alert
        const sent = await telegram.sendAlertToUser(trend, user);
        if (sent) {
          db.recordNotification(trend._dbId, 'telegram', user.id);
          db.incrementAlertCount(user.id);
          alertsSentThisCycle++;

          // Attach X Analysis button (only for the first user's message — use their chat as anchor)
          if (sent.messageId) {
            await telegram.attachXButton(sent.chatId, sent.messageId, trend._dbId, user);

            // Save tg_message_id to trend for reaction tracking (use first message sent)
            const existing = db.getTrendById(trend._dbId);
            if (existing && !existing.tg_message_id) {
              let msgUrl = '';
              if (String(sent.chatId).startsWith('-100')) {
                msgUrl = `https://t.me/c/${String(sent.chatId).slice(4)}/${sent.messageId}`;
              }
              db.updateTgUrl(trend._dbId, msgUrl, sent.messageId);
            }
          }

          await new Promise(r => setTimeout(r, 300)); // small delay between sends
        }
      }

      if (alertsSentThisCycle > 0) {
        logger.info(`Sent ${alertsSentThisCycle} alert(s) to user ${user.telegram_chat_id}`);
      }
    }

    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
    logger.info(`────── Cycle complete in ${elapsed}s ──────`);

  } catch (error) {
    logger.error(`Scan cycle failed: ${error.message}`, { stack: error.stack });
  } finally {
    appState.scanRunning = false;
  }
}

/**
 * Scheduler — runs scan cycle at configured interval
 */
function startScheduler() {
  const intervalMs = config.scanIntervalMinutes * 60 * 1000;
  logger.info(`Scheduler started — scanning every ${config.scanIntervalMinutes} minutes`);

  // Run immediately on startup
  runScanCycle().then(() => {
    setInterval(runScanCycle, intervalMs);
  });

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
async function shutdown(signal) {
  logger.info(`Received ${signal} — shutting down gracefully...`);
  solanaMonitor.stop();
  await telegram.stop();
  dashboard.stop();
  admin.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  err => logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack }));
process.on('unhandledRejection', reason => logger.error(`Unhandled rejection: ${reason}`));

// ── Start! ──────────────────────────────────────────────────────────────────
startScheduler();
