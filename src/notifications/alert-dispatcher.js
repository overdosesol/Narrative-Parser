/**
 * Alert dispatcher — single source of truth for "given a set of trends,
 * decide which user gets which alert and send it".
 *
 * Extracted from `src/index.js` 2026-05-03 because two call sites need the
 * exact same logic:
 *   1. The main scan-cycle (every ~90s) — fresh trends straight from the
 *      collectors → cluster → score → here.
 *   2. The hot-trends refresh loop (every 2h) — re-fetched + re-scored
 *      trends. Without dispatching here, a trend that "ripens" past the
 *      alert threshold during refresh would never reach the user.
 *
 * Both call sites share:
 *   - Per-user iteration with status / subscription / disabled-source guards
 *   - Per-trend gate cascade: threshold → hard_junk → source → alert_type →
 *     dedup → daily-limit → per-cycle-cap
 *   - Recording the decision (sent / skipped + reason) into the admin ring
 *     buffer for the DecisionsPage UI
 *   - Sending via the Telegram wrapper (`sendAlertToUser`) and persisting
 *     the notification + tg message URL
 *
 * What's NOT here (intentionally):
 *   - Pipeline-stage observability (setPipelineStage). Scan-cycle owns that
 *     animation; refresh-loop is silent in the topbar pipeline.
 *   - cycleInProgress counter mutation. Same reason.
 *   - Recomputing alertScore from feedback + age — moved to its own
 *     `recomputeAlertScores()` helper here so callers do it once before
 *     entering the dispatch loop.
 */

import { computeAlertScore, feedbackBoostFromStats } from '../analysis/scorer.js';

/**
 * Refresh `alertScore` / `alertBreakdown` / `_alertHardJunk` on every trend
 * using LIVE inputs (feedback votes from DB + actual age in hours). The
 * scorer baked-in alertScore is a coarse estimate from scoring time; the
 * gate-time recompute lets a flurry of 👍/👎 or stale-decay tip the verdict.
 *
 * Mutates trends in place. Returns the same array for chaining convenience.
 */
export function recomputeAlertScores(trends, alertWeights, db) {
  const nowMs = Date.now();
  for (const t of trends) {
    let feedbackBoost = 50;
    if (t._dbId && typeof db.getFeedbackStats === 'function') {
      try {
        const fb = db.getFeedbackStats(t._dbId);
        feedbackBoost = feedbackBoostFromStats(fb?.likes, fb?.dislikes);
      } catch { /* keep neutral */ }
    }
    const firstSeen = t.firstSeenAt || t.first_seen_at || null;
    const ageHours = firstSeen ? Math.max(0, (nowMs - new Date(firstSeen).getTime()) / 3_600_000) : 0;

    t._feedbackBoost = feedbackBoost;
    t._ageHours = ageHours;

    const probe = computeAlertScore(t, alertWeights);
    t.alertScore = probe.alertScore;
    t.alertBreakdown = probe.breakdown;
    t._alertHardJunk = probe.hardJunk;
  }
  return trends;
}

/**
 * Main per-user / per-trend gate cascade. Sends alerts via telegram and
 * records each decision (sent / skipped) into the admin decisions buffer.
 *
 * @param {Object} args
 * @param {Object[]} args.trends                    Already-scored, persisted trends (must have `_dbId`)
 * @param {Object}   args.deps
 * @param {Object}   args.deps.db                   TrendDatabase
 * @param {Object}   args.deps.telegram             TelegramNotifier wrapper (sendAlertToUser, attachXButton)
 * @param {Object}   args.deps.logger               Logger
 * @param {Object}   args.deps.config               Top-level config (for alertThreshold fallback)
 * @param {Object}   args.deps.alertWeights         Output of `loadAlertWeights(db)`
 * @param {Object}   args.deps.presetCfg            Output of `getActivePresetConfig(db)`
 * @param {number}   args.deps.globalAlertThreshold Effective preset alertThreshold
 * @param {Function} args.deps.normalizeThreshold   `(value, fallback) => 0..100`
 * @param {Function} args.deps.recordDecision       `(rec) => void` — push to admin ring buffer
 * @param {string}   [args.source='scan']           'scan' | 'refresh' | 'manual' — for log tagging
 * @returns {Promise<{ usersTried: number, sent: number, skipped: number }>}
 */
export async function dispatchAlerts({ trends, deps, source = 'scan' }) {
  const {
    db, telegram, logger, config,
    alertWeights, presetCfg, globalAlertThreshold,
    normalizeThreshold, recordDecision,
  } = deps;

  if (!Array.isArray(trends) || trends.length === 0) {
    return { usersTried: 0, sent: 0, skipped: 0 };
  }

  // Sort by alertScore desc — when per-user cap is hit, the highest-priority
  // trend should have already been delivered. Same chain as the legacy code.
  const alertCandidates = trends
    .filter(t => t._dbId)
    .sort((a, b) =>
      (b.alertScore ?? b.rankScore ?? b.memePotential ?? 0) -
      (a.alertScore ?? a.rankScore ?? a.memePotential ?? 0)
    );

  if (alertCandidates.length === 0) return { usersTried: 0, sent: 0, skipped: 0 };

  const activeUsers = db.getActiveUsers();
  let totalSent = 0;
  let totalSkipped = 0;

  for (const user of activeUsers) {
    if (user.status === 'suspended') continue;

    // Subscription expiry → silent downgrade. Same path scan-cycle takes;
    // refresh-loop honestly shouldn't be the place to flip plans, but it's
    // a free side-effect when we iterate the user list anyway, and skipping
    // it here would diverge the two call sites' user state. Keep parity.
    if (db.isSubscriptionExpired(user)) {
      db.updateUser(user.id, 'plan_id', 1);
      db.updateUser(user.id, 'subscription_expires_at', null);
      logger.info?.(`Subscription expired for user ${user.telegram_chat_id} — downgraded to free`);
    }

    let userDisabledSources = [];
    try { userDisabledSources = JSON.parse(user.disabled_sources || '[]'); } catch { /* ignore */ }

    const userAlertTypes = db.getUserAlertTypes(user.telegram_chat_id);
    const userThreshold  = normalizeThreshold(user.alert_threshold, config.alertThreshold);
    const effectiveAlertThreshold = Math.max(userThreshold, globalAlertThreshold);
    const maxAlertsPerCycle = Number(presetCfg.alerts?.thresholds?.maxAlertsPerCycle ?? 0) || 0;

    let alertsSentThisCycle = 0;

    for (const trend of alertCandidates) {
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
        // Tag the dispatch source so DecisionsPage shows whether the decision
        // came from a normal scan or the hot-refresh loop. Useful when you
        // see "why did this trend fire 4h after first seen?" — answer is
        // there in the buffer.
        triggerSource: source,
        engagement: {
          views:    em.views    ?? null,
          likes:    em.likes    ?? null,
          retweets: em.retweets ?? null,
          replies:  em.replies  ?? null,
          upvotes:  em.upvotes  ?? null,
        },
      };

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

      const trendAlertType = trend.alertType || null;
      const alertTypePass  = !trendAlertType || userAlertTypes.includes(trendAlertType);

      gates.push({ name: 'threshold',  passed: thresholdPass, detail: `${alertScore} / ${effectiveAlertThreshold}` });
      gates.push({ name: 'hard_junk',  passed: hardJunkPass,  detail: `junk=${junkVal}${junkReasons ? ' (' + junkReasons + ')' : ''} < ${alertWeights.hardJunkStop}` });
      gates.push({ name: 'source',     passed: sourcePass,    detail: trend.source + (sourcePass ? '' : ' (muted)') });
      gates.push({ name: 'alert_type', passed: alertTypePass, detail: trendAlertType ? `${trendAlertType} ∈ [${userAlertTypes.join(',')}]` : 'no type (wildcard)' });
      gates.push({ name: 'dedup',      passed: dedupPass,     detail: dedupPass ? 'new trend' : 'already sent' });
      gates.push({ name: 'daily',      passed: dailyPass,     detail: dailyPass ? 'ok' : `limit=${user.alert_limit}` });
      gates.push({ name: 'cap',        passed: capPass,       detail: maxAlertsPerCycle > 0 ? `${alertsSentThisCycle}/${maxAlertsPerCycle}` : '∞' });

      const firstFail = gates.find(g => !g.passed);
      const allPassed = !firstFail;

      if (!capPass || !dailyPass) {
        recordDecision({ ...decisionBase, decision: 'skipped', reason: firstFail.name, gates });
        totalSkipped++;
        break;
      }
      if (!allPassed) {
        if (firstFail.name === 'hard_junk') {
          logger.debug?.(`[HardJunk:${source}] SKIP "${trend.title?.substring(0, 50)}" junk=${junkVal} (${junkReasons})`);
        }
        recordDecision({ ...decisionBase, decision: 'skipped', reason: firstFail.name, gates });
        totalSkipped++;
        continue;
      }

      const sent = await telegram.sendAlertToUser(trend, user);
      if (sent) {
        db.recordNotification(trend._dbId, 'telegram', user.id);
        db.incrementAlertCount(user.id);
        alertsSentThisCycle++;
        totalSent++;
        gates.push({ name: 'send', passed: true, detail: `msg ${sent.messageId || '-'}` });
        recordDecision({ ...decisionBase, decision: 'sent', reason: 'sent', gates });

        // Attach X Analysis button + persist tg message URL on first send.
        if (sent.messageId) {
          await telegram.attachXButton(sent.chatId, sent.messageId, trend._dbId, user, trend);
          const existing = db.getTrendById(trend._dbId);
          if (existing && !existing.tg_message_id) {
            let msgUrl = '';
            if (String(sent.chatId).startsWith('-100')) {
              msgUrl = `https://t.me/c/${String(sent.chatId).slice(4)}/${sent.messageId}`;
            }
            db.updateTgUrl(trend._dbId, msgUrl, sent.messageId);
          }
        }

        await new Promise(r => setTimeout(r, 300));
      } else {
        gates.push({ name: 'send', passed: false, detail: 'telegram returned no result' });
        recordDecision({ ...decisionBase, decision: 'skipped', reason: 'send_failed', gates });
        totalSkipped++;
      }
    }

    if (alertsSentThisCycle > 0) {
      logger.info?.(`[Dispatch:${source}] sent ${alertsSentThisCycle} alert(s) to user ${user.telegram_chat_id}`);
    }
  }

  return { usersTried: activeUsers.length, sent: totalSent, skipped: totalSkipped };
}
