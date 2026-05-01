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
import Scorer, { loadAlertWeights, computeAlertScore, feedbackBoostFromStats } from './analysis/scorer.js';
import { getActivePresetConfig } from './analysis/preset-config.js';
import NarrativeClusterer from './analysis/clusterer.js';
import TriggerFinder from './analysis/trigger-finder.js';
import NanoClassifier from './analysis/nano-classifier.js';
import GeminiCaptioner from './analysis/gemini-captioner.js';
import PreStage from './analysis/pre-stage.js';
import TelegramNotifier from './notifications/telegram.js';
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
const telegram = new TelegramNotifier(config, logger, db, null, triggerFinder, scorer); // solanaMonitor injected below
// Prune muxed video cache on startup (files older than 7 days)
try { telegram.cleanupVideoCache(5); } catch {}

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
  appState.alertDecisions.push({ ts: new Date().toISOString(), ...rec });
  const over = appState.alertDecisions.length - appState.alertDecisionsCap;
  if (over > 0) appState.alertDecisions.splice(0, over);
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
const dashboard = new DashboardServer(config, logger, db, appState, () => runScanCycle(), telegram, triggerFinder, { scorer });
dashboard.start();

// ── Initialize admin panel ──────────────────────────────────────────────────
const admin = new AdminServer(config, logger, db, telegram.bot, appState, () => runScanCycle(), {
  scorer,
  telegram,       // full wrapper — needed for sendAlertToUser + attachXButton
  triggerFinder,  // optional Grok deep-search; SubmitPage button → /api/trends/:id/trigger
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
      // Mark as 'scored' so they are never re-sent through the AI pipeline
      const trendId = db.saveTrend({ ...trend, pipelineStatus: 'scored' });
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
    const nowMs = Date.now();
    for (const t of validTrends) {
      // Feedback: pull stats if trend is persisted; neutral (50) otherwise.
      let feedbackBoost = 50;
      if (t._dbId && typeof db.getFeedbackStats === 'function') {
        try {
          const fb = db.getFeedbackStats(t._dbId);
          feedbackBoost = feedbackBoostFromStats(fb?.likes, fb?.dislikes);
        } catch (e) { /* keep neutral */ }
      }
      // Age: use firstSeenAt if present, else treat as fresh (0h).
      const firstSeen = t.firstSeenAt || t.first_seen_at || null;
      const ageHours = firstSeen ? Math.max(0, (nowMs - new Date(firstSeen).getTime()) / 3_600_000) : 0;

      t._feedbackBoost = feedbackBoost;
      t._ageHours = ageHours;

      const probe = computeAlertScore(t, alertWeights);
      t.alertScore = probe.alertScore;
      t.alertBreakdown = probe.breakdown;
      t._alertHardJunk = probe.hardJunk;
    }

    logger.info(
      `Alert gate: alertScore>=${globalAlertThreshold} (weights: ` +
      `meme=${alertWeights.weightMemePotential}, viral=${alertWeights.weightVirality}, ` +
      `emerge=${alertWeights.weightEmergence}, x=${alertWeights.weightTwitter}, ` +
      `junk×${alertWeights.weightJunk}, hardJunk>=${alertWeights.hardJunkStop})`
    );
    setPipelineStage('alerts');
    logger.info(`Sending alerts to ${activeUsers.length} active user(s)`);

    // Sort by alertScore descending (fallback chain for legacy rows)
    const alertCandidates = validTrends
      .filter(t => t._dbId)
      .sort((a, b) =>
        (b.alertScore ?? b.rankScore ?? b.memePotential ?? 0) -
        (a.alertScore ?? a.rankScore ?? a.memePotential ?? 0)
      );

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

      // Per-user alert-type subscription. CSV in users.alert_types_filter,
      // helper normalises empty/legacy/garbage to "all 3 types". Wildcard
      // semantics: an empty resulting array is treated as "no filter" by the
      // gate below (matches db helper contract).
      const userAlertTypes = db.getUserAlertTypes(user.telegram_chat_id);

      // Get this user's threshold (per-user or fallback to global). This now
      // gates the unified alertScore — higher value = stricter.
      const userThreshold = normalizeThreshold(user.alert_threshold, config.alertThreshold);
      const effectiveAlertThreshold = Math.max(userThreshold, globalAlertThreshold);

      // Per-preset cap on alerts/cycle since 2026-05-01 (PR-2). Same
      // active preset config snapshot used by the threshold above.
      const maxAlertsPerCycle = Number(presetCfgForAlerts.alerts?.thresholds?.maxAlertsPerCycle ?? 0) || 0;

      let alertsSentThisCycle = 0;

      for (const trend of alertCandidates) {
        // Common snapshot for the decisions log — every gate evaluation below
        // decorates this before storing. `url` is what the UI renders as a
        // clickable source link.
        // Engagement — for Twitter clusters these are sums across the cluster.
        // Present at top level on collector output; survive clusterer.
        const em = trend.metrics || trend.clusterMetrics?.metrics || {};
        const decisionBase = {
          trendId:    trend._dbId,
          title:      (trend.title || '').slice(0, 160),
          source:     trend.source,
          category:   trend.category || null,
          alertType:  trend.alertType || null,
          alertScore: trend.alertScore ?? null,
          threshold:  effectiveAlertThreshold,
          breakdown:  trend.alertBreakdown || null,
          url:        trend.url || null,
          userChatId: String(user.telegram_chat_id || ''),
          engagement: {
            views:    em.views    ?? null,
            likes:    em.likes    ?? null,
            retweets: em.retweets ?? null,
            replies:  em.replies  ?? null,
            upvotes:  em.upvotes  ?? null, // reddit
          },
        };

        // Evaluate every gate in order and record pass/fail for ALL of them.
        // Some gates short-circuit the loop (cap / daily limit → `break`), but
        // we still want to know which specific gate failed, so the full list
        // is always written to the decisions buffer.
        const gates = [];
        const alertScore = trend.alertScore ?? 0;
        const junkVal    = trend.junkPenalty ?? trend.clusterMetrics?.junkPenalty ?? 0;
        const junkReasons = trend.clusterMetrics?.junkReasons?.join(',') || '';
        const sourceLc   = (trend.source || '').toLowerCase();

        const capPass       = !(maxAlertsPerCycle > 0 && alertsSentThisCycle >= maxAlertsPerCycle);
        const dailyPass     = db.canUserReceiveAlert(user);
        const thresholdPass = alertScore >= effectiveAlertThreshold;
        const hardJunkPass  = !trend._alertHardJunk;
        const sourcePass    = !userDisabledSources.includes(sourceLc);
        const dedupPass     = !db.wasNotificationSentToUser(trend._dbId, user.id);

        // alert_type filter: NULL alertType (legacy / pre-rollout trends)
        // counts as wildcard so we don't silently mute back-catalog. Same
        // wildcard logic when the user array is empty (handled by db helper:
        // it can't return empty without us special-casing here).
        const trendAlertType = trend.alertType || null;
        const alertTypePass = !trendAlertType || userAlertTypes.includes(trendAlertType);

        gates.push({ name: 'threshold', passed: thresholdPass, detail: `${alertScore} / ${effectiveAlertThreshold}` });
        gates.push({ name: 'hard_junk', passed: hardJunkPass,  detail: `junk=${junkVal}${junkReasons ? ' (' + junkReasons + ')' : ''} < ${alertWeights.hardJunkStop}` });
        gates.push({ name: 'source',    passed: sourcePass,    detail: trend.source + (sourcePass ? '' : ' (muted)') });
        gates.push({ name: 'alert_type', passed: alertTypePass, detail: trendAlertType ? `${trendAlertType} ∈ [${userAlertTypes.join(',')}]` : 'no type (wildcard)' });
        gates.push({ name: 'dedup',     passed: dedupPass,     detail: dedupPass ? 'new trend' : `already sent`  });
        gates.push({ name: 'daily',     passed: dailyPass,     detail: dailyPass ? `ok` : `limit=${user.alert_limit}` });
        gates.push({ name: 'cap',       passed: capPass,       detail: maxAlertsPerCycle > 0 ? `${alertsSentThisCycle}/${maxAlertsPerCycle}` : '∞' });

        const firstFail = gates.find(g => !g.passed);
        const allPassed = !firstFail;

        // Apply short-circuit semantics (same as before):
        //  - cycle cap / daily limit → stop looking at more trends for this user
        //  - anything else → skip just this trend
        if (!capPass || !dailyPass) {
          recordAlertDecision({ ...decisionBase, decision: 'skipped', reason: firstFail.name, gates });
          break;
        }
        if (!allPassed) {
          if (firstFail.name === 'hard_junk') {
            logger.debug(`[HardJunk] SKIP "${trend.title?.substring(0, 50)}" junk=${junkVal} (${junkReasons})`);
          }
          recordAlertDecision({ ...decisionBase, decision: 'skipped', reason: firstFail.name, gates });
          continue;
        }

        // All gates passed — send it.
        const sent = await telegram.sendAlertToUser(trend, user);
        if (sent) {
          db.recordNotification(trend._dbId, 'telegram', user.id);
          db.incrementAlertCount(user.id);
          alertsSentThisCycle++;
          gates.push({ name: 'send', passed: true, detail: `msg ${sent.messageId || '—'}` });
          recordAlertDecision({ ...decisionBase, decision: 'sent', reason: 'sent', gates });
        } else {
          gates.push({ name: 'send', passed: false, detail: 'telegram returned no result' });
          recordAlertDecision({ ...decisionBase, decision: 'skipped', reason: 'send_failed', gates });
        }

        // (Close old `if (sent) {` — legacy body below runs inside that block.)
        if (sent) {

          // Attach X Analysis button (only for the first user's message — use their chat as anchor)
          if (sent.messageId) {
            await telegram.attachXButton(sent.chatId, sent.messageId, trend._dbId, user, trend);

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
        appState.cycleInProgress.alerts += alertsSentThisCycle;
        logger.info(`Sent ${alertsSentThisCycle} alert(s) to user ${user.telegram_chat_id}`);
      }
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
    // Notify all connected dashboard clients that fresh data is available
    try { dashboard.broadcast('refresh', { at: Date.now() }); } catch (e) {}
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
