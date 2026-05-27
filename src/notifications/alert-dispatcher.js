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
import { notifyAdminCrash } from './admin-alert.js';

// ─── TikTok quality gate constants ───────────────────────────────────────────
// TikTok firehose drags in tons of "scroll-bait" (ASMR / satisfying loops /
// tutorials / process timelapses / aesthetic vlogs). They get massive
// engagement but are NOT memecoin material. The gate runs ONLY for
// source='tiktok' and uses Gemini PreStage signals:
//   • NO Gemini data at all            → hard skip (legacy/failed PreStage,
//                                          we cannot verify visual content)
//   • viralPattern in AMBIENT_PATTERNS → hard skip (Gemini classified as scroll-bait)
//   • isAmbient=true                   → hard skip (Gemini's own boolean judgment)
//   • memeShapeStrength < FLOOR        → hard skip (TikTok-only quality bar)
// Keeping these as module-level constants (not config knobs) per "хардкод"
// directive — flip to admin sliders later if calibration needs tuning.
// "No Gemini data" branch was added 2026-05-11 after compilation-style
// trends ("Weird Sea Animals sounds trend" etc.) slipped through when
// PreStage failed silently — without visual verification, we cannot
// distinguish a real story trend from a generic sound-format compilation,
// so fail-closed is the safer default for the TikTok firehose.
// Patterns that always hard-skip on TikTok regardless of engagement / score:
// the original "ambient" group (satisfying / asmr / tutorial / process /
// aesthetic — scroll-bait without narrative) PLUS the sound-format group
// (sound_format / dance_challenge / outfit_transition — audio-driven trend
// participation, not a story). The latter was added 2026-05-08 after dance
// trends like #thegreatdivide / #wlw repeatedly slipped through the lipsync
// gate even though Gemini correctly classified the pattern.
const AMBIENT_PATTERNS = new Set([
  'satisfying', 'asmr', 'tutorial', 'process', 'aesthetic',
  'sound_format', 'dance_challenge', 'outfit_transition',
]);
const TIKTOK_MEME_SHAPE_FLOOR = 60;

// PII masking for log lines. Long-term stdout (Docker / journald) shouldn't
// retain full Telegram chat_ids - they're stable identifiers that can be
// cross-referenced. Last 4 chars is enough to correlate two log lines about
// the same user without exposing the whole ID.
function maskId(id) {
  const s = String(id ?? '');
  return s ? '***' + s.slice(-4) : '<empty>';
}

/**
 * Refresh `alertScore` / `alertBreakdown` / `_alertHardJunk` on every trend
 * using LIVE inputs (feedback votes from DB + actual age in hours). The
 * scorer baked-in alertScore is a coarse estimate from scoring time; the
 * gate-time recompute lets a flurry of 👍/👎 or stale-decay tip the verdict.
 *
 * Mutates trends in place. Returns the same array for chaining convenience.
 */
export function recomputeAlertScores(trends, alertWeights, db, opts = {}) {
  const nowMs = Date.now();
  // History-write knobs. source defaults to 'scan'; hot-metrics passes
  // 'refresh-light' / 'refresh-hot' so the sparkline can later show what
  // kind of cycle caused each tick. floorAtTs is the effective alert floor
  // at write time (callers know this from preset config).
  const historySource = opts.source || 'scan';
  const floorAtTs = Number.isFinite(opts.floor) ? Math.round(opts.floor) : null;
  const recordHistory = typeof db?.recordAlertScoreHistory === 'function';

  for (const t of trends) {
    let feedbackBoost = 50;
    let feedbackStats = null;
    if (t._dbId && typeof db.getFeedbackStats === 'function') {
      try {
        const fb = db.getFeedbackStats(t._dbId);
        feedbackBoost = feedbackBoostFromStats(fb?.likes, fb?.dislikes);
        feedbackStats = { likes: fb?.likes | 0, dislikes: fb?.dislikes | 0 };
      } catch { /* keep neutral */ }
    }
    const firstSeen = t.firstSeenAt || t.first_seen_at || null;
    const ageHours = firstSeen ? Math.max(0, (nowMs - new Date(firstSeen).getTime()) / 3_600_000) : 0;

    t._feedbackBoost = feedbackBoost;
    t._feedbackStats = feedbackStats;
    t._ageHours = ageHours;

    const probe = computeAlertScore(t, alertWeights);
    t.alertScore = probe.alertScore;
    t.alertBreakdown = probe.breakdown;
    t._alertHardJunk = probe.hardJunk;

    // Append sparkline point. Skip when we have no DB id (pre-persist trends
    // wouldn't have anything to FK to anyway).
    if (recordHistory && t._dbId) {
      db.recordAlertScoreHistory({
        trendId: t._dbId,
        breakdown: { ...probe.breakdown, score: probe.alertScore },
        floorAtTs,
        source: historySource,
      });
    }
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
    // Optional — when wired by index.js, outgoing alerts go through a per-user
    // FIFO cooldown queue (default 60s between alerts to the same chat). When
    // omitted we fall back to direct synchronous send (old behaviour) so unit
    // tests and isolated dev runs don't need to wire the scheduler.
    scheduler = null,
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
    try {
      if (user.status === 'suspended') continue;

      // Subscription expiry → silent downgrade. Same path scan-cycle takes;
      // refresh-loop honestly shouldn't be the place to flip plans, but it's
      // a free side-effect when we iterate the user list anyway, and skipping
      // it here would diverge the two call sites' user state. Keep parity.
      if (db.isSubscriptionExpired(user)) {
        db.updateUser(user.id, 'plan_id', 1);
        db.updateUser(user.id, 'subscription_expires_at', null);
        logger.info?.(`Subscription expired for user ${maskId(user.telegram_chat_id)} - downgraded to free`);
      }

      let userDisabledSources = [];
      try { userDisabledSources = JSON.parse(user.disabled_sources || '[]'); } catch { /* ignore */ }

      // Plan-allowed sources: free is locked to reddit + google_trends; paid
      // plans include all 5 (reddit, twitter, tiktok, google_trends, x_trends).
      // user.plan_sources comes from JOIN with plans table (CSV string).
      // Empty/missing falls back to "all allowed" — paranoid default that
      // protects admin/legacy rows where plan_sources isn't populated.
      const planSourcesRaw = String(user.plan_sources || '').trim();
      const planAllowedSources = planSourcesRaw
        ? planSourcesRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : []; // empty = no restriction (legacy/admin fallback)

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
          // Floor decomposition — the admin Decisions panel shows which side
          // (user-pers slider vs admin global) actually set the bar. Useful to
          // answer "почему именно 60 — может, я где-то слайдер сдвинул".
          userFloor:   userThreshold,
          globalFloor: globalAlertThreshold,
          // Active preset that owned the weights table — same for all decisions
          // in one cycle, but storing per-row keeps history accurate when admin
          // flips the active preset between cycles.
          preset: presetCfg?.preset || null,
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
          // PreStage blob (Stage 0a nano + Stage 0b gemini) — passed through
          // so DecisionsPage in admin can render the same Gemini chips/captions
          // that ManualResultCard shows. Keeps the ring-buffer footprint
          // bounded since preStage is at most ~2KB per trend (text fields
          // are capped in gemini-captioner.js / nano-classifier.js).
          // Falls back through metrics.preStage for hot-refresh trends where
          // preStage was deserialized from raw_metrics back into the metrics
          // namespace.
          preStage: trend.preStage || trend.metrics?.preStage || null,
          // Score-source audit trail (2026-05-10 trust-contract). scoreSource
          // tells the admin which stage produced the final memePotential
          // ('stage0b_gemini' | 'stage1_override' | 'stage1_fallback'); the
          // override record carries from/to/reason when Stage 1 disagreed with
          // Stage 0b. Used by DecisionsPage to render a small audit chip so
          // calibration drift is visible at a glance.
          scoreSource:   trend.scoreSource   || null,
          scoreOverride: trend.scoreOverride || null,
          memePotential: trend.memePotential ?? null,
        };

        const gates = [];
        const alertScore = trend.alertScore ?? 0;
        const junkVal    = trend.junkPenalty ?? trend.clusterMetrics?.junkPenalty ?? 0;
        const junkReasons = trend.clusterMetrics?.junkReasons?.join(',') || '';
        const sourceLc   = (trend.source || '').toLowerCase();

        // Lip-sync hard skip — Gemini (Stage 0b vision) marks creators-miming-to-
        // -audio videos with isLipSync=true. Those trends are sound-format
        // participation, not story trends — bad memecoin candidates regardless of
        // engagement. Hard-skip overrides everything else (no threshold can
        // rescue them). Static-image trends always have isLipSync=false (forced
        // in gemini-captioner.js OpenRouter fallback path), so this only ever
        // fires on video content.
        const isLipSync     = trend.preStage?.gemini?.isLipSync === true;
        const lipsyncPass   = !isLipSync;

        // ── TikTok quality gate ────────────────────────────────────────────
        // TikTok firehose drags in tons of "scroll-bait" — ASMR, satisfying
        // loops, tutorials, process timelapses, mood vlogs. They get massive
        // engagement (people zone out and watch) but are NOT memecoin material.
        // Four sub-checks (any failure → hard skip):
        //   0) NO Gemini data at all (legacy/failed PreStage) — cannot verify
        //      visual content, so we fail-closed for the TikTok firehose
        //   1) Gemini flagged isAmbient=true (its own judgment)
        //   2) viralPattern in the AMBIENT_PATTERNS set
        //   3) memeShapeStrength below TIKTOK_MEME_SHAPE_FLOOR
        // Only fires when source='tiktok'. Reddit/Twitter/Google trends bypass
        // this gate entirely (their text-first nature makes the visual gate
        // pointless and applying it would block legitimate text-only narratives).
        const isTikTok = sourceLc === 'tiktok';
        const gemini   = trend.preStage?.gemini;
        const hasGemini        = !!gemini;
        const isAmbient        = gemini?.isAmbient === true;
        const ambientPattern   = AMBIENT_PATTERNS.has(gemini?.viralPattern);
        const memeShape        = gemini?.memeShapeStrength;
        const memeShapeKnown   = Number.isFinite(memeShape);
        const memeShapeTooLow  = memeShapeKnown && memeShape < TIKTOK_MEME_SHAPE_FLOOR;

        let tiktokQualityFail = null;
        if (isTikTok) {
          if (!hasGemini)            tiktokQualityFail = 'no PreStage data (legacy/failed Stage 0b)';
          else if (isAmbient)        tiktokQualityFail = 'ambient flag (Gemini)';
          else if (ambientPattern)   tiktokQualityFail = `pattern=${gemini.viralPattern}`;
          else if (memeShapeTooLow)  tiktokQualityFail = `memeShape=${memeShape}/100 < ${TIKTOK_MEME_SHAPE_FLOOR}`;
        }
        const tiktokQualityPass = !tiktokQualityFail;

        // ai_score gate — block alerts where AI provider returned 5xx/timeout/
        // parse error and we fell back to heuristic scoring (scorer._fallback
        // sets aiExplanation to 'AI unavailable' or 'Parse error'). Without
        // this gate users would receive "POST · 🤖 AI: AI unavailable" alerts
        // with category=other/sentiment=neutral — useless. The trend is saved
        // with pipeline_status='save_only' (see index.js), so isTrendSeen
        // passes it through on the next scan → AI gets another shot. If the
        // re-attempt succeeds, the same row is UPSERTed with real scores and
        // pipeline_status='scored' → alert flows normally. Added 2026-05-12.
        const aiUnavailable = trend.aiExplanation === 'AI unavailable'
                           || trend.aiExplanation === 'Parse error';
        const aiScorePass   = !aiUnavailable;

        const capPass       = !(maxAlertsPerCycle > 0 && alertsSentThisCycle >= maxAlertsPerCycle);
        const thresholdPass = alertScore >= effectiveAlertThreshold;
        const hardJunkPass  = !trend._alertHardJunk;
        const sourcePass    = !userDisabledSources.includes(sourceLc);
        // Plan-source gate: free is restricted to reddit + google_trends. Paid
        // plans (test/pro/admin) include all 5 sources. Empty plan_sources =
        // no restriction (legacy/admin fallback).
        const planSourcePass = planAllowedSources.length === 0 || planAllowedSources.includes(sourceLc);
        const dedupPass     = !db.wasNotificationSentToUser(trend._dbId, user.id);

        const trendAlertType = trend.alertType || null;
        const alertTypePass  = !trendAlertType || userAlertTypes.includes(trendAlertType);

        gates.push({ name: 'ai_score',     passed: aiScorePass,      detail: aiUnavailable ? `heuristic fallback (${trend.aiExplanation}) — will retry next scan` : 'AI verdict OK' });
        gates.push({ name: 'threshold',    passed: thresholdPass,    detail: `${alertScore} / ${effectiveAlertThreshold}` });
        gates.push({ name: 'hard_junk',    passed: hardJunkPass,     detail: `junk=${junkVal}${junkReasons ? ' (' + junkReasons + ')' : ''} < ${alertWeights.hardJunkStop}` });
        gates.push({ name: 'lipsync',      passed: lipsyncPass,      detail: isLipSync ? 'gemini flagged: lip-sync / sound participation' : 'no lip-sync' });
        gates.push({ name: 'tiktok_quality', passed: tiktokQualityPass, detail: isTikTok ? (tiktokQualityFail || `ok (memeShape=${memeShapeKnown ? memeShape : 'n/a'}, pattern=${gemini?.viralPattern || 'n/a'})`) : 'n/a (not tiktok)' });
        gates.push({ name: 'plan_source',  passed: planSourcePass,   detail: planSourcePass ? trend.source : `${trend.source} (not in ${user.plan_name || 'free'} plan)` });
        gates.push({ name: 'source',       passed: sourcePass,       detail: trend.source + (sourcePass ? '' : ' (muted)') });
        gates.push({ name: 'alert_type',   passed: alertTypePass,    detail: trendAlertType ? `${trendAlertType} ∈ [${userAlertTypes.join(',')}]` : 'no type (wildcard)' });
        gates.push({ name: 'dedup',        passed: dedupPass,        detail: dedupPass ? 'new trend' : 'already sent' });
        gates.push({ name: 'cap',          passed: capPass,          detail: maxAlertsPerCycle > 0 ? `${alertsSentThisCycle}/${maxAlertsPerCycle}` : '∞' });

        const firstFail = gates.find(g => !g.passed);
        const allPassed = !firstFail;

        if (!capPass) {
          recordDecision({ ...decisionBase, decision: 'skipped', reason: firstFail.name, gates });
          totalSkipped++;
          break;
        }
        if (!allPassed) {
          if (firstFail.name === 'hard_junk') {
            logger.debug?.(`[HardJunk:${source}] SKIP "${trend.title?.substring(0, 50)}" junk=${junkVal} (${junkReasons})`);
          } else if (firstFail.name === 'lipsync') {
            logger.debug?.(`[LipSync:${source}] SKIP "${trend.title?.substring(0, 50)}" — Gemini flagged sound-participation`);
          } else if (firstFail.name === 'tiktok_quality') {
            logger.debug?.(`[TikTokQuality:${source}] SKIP "${trend.title?.substring(0, 50)}" — ${tiktokQualityFail}`);
          }
          recordDecision({ ...decisionBase, decision: 'skipped', reason: firstFail.name, gates });
          totalSkipped++;
          continue;
        }

        // ── Build the send-and-followups task ─────────────────────────────
        // Wrapped in a closure so it can be either run inline (no scheduler
        // wired) or handed to scheduler.enqueue() for cooldown-paced delivery.
        // All DB writes that depend on a real send (recordNotification,
        // incrementAlertCount, attachXButton, decision record with sent/skipped)
        // happen INSIDE the task so they reflect what actually went out — not
        // what was queued. Per-cycle counters (alertsSentThisCycle, totalSent)
        // are bumped at enqueue time below since they govern cap enforcement,
        // not actual delivery.
        const baseGates = gates;  // freeze pre-send gate state for closure
        const sendTask = async () => {
          try {
            const sent = await telegram.sendAlertToUser(trend, user);
            if (sent) {
              db.recordNotification(trend._dbId, 'telegram', user.id);
              db.incrementAlertCount(user.id);
              const finalGates = [...baseGates, { name: 'send', passed: true, detail: `msg ${sent.messageId || '-'}` }];
              recordDecision({ ...decisionBase, decision: 'sent', reason: 'sent', gates: finalGates });

              // Attach X Analysis button + persist tg message URL on first send.
              if (sent.messageId) {
                try {
                  await telegram.attachXButton(sent.chatId, sent.messageId, trend._dbId, user, trend);
                } catch (e) {
                  logger.warn?.(`[Dispatch] attachXButton failed: ${e.message}`);
                }
                const existing = db.getTrendById(trend._dbId);
                if (existing && !existing.tg_message_id) {
                  let msgUrl = '';
                  if (String(sent.chatId).startsWith('-100')) {
                    msgUrl = `https://t.me/c/${String(sent.chatId).slice(4)}/${sent.messageId}`;
                  }
                  db.updateTgUrl(trend._dbId, msgUrl, sent.messageId);
                }
              }
            } else {
              const finalGates = [...baseGates, { name: 'send', passed: false, detail: 'telegram returned no result' }];
              recordDecision({ ...decisionBase, decision: 'skipped', reason: 'send_failed', gates: finalGates });
            }
          } catch (e) {
            logger.warn?.(`[Dispatch] sendAlertToUser threw for chat ${maskId(user.telegram_chat_id)}: ${e.message}`);
            const finalGates = [...baseGates, { name: 'send', passed: false, detail: 'exception: ' + String(e.message || '').slice(0, 80) }];
            recordDecision({ ...decisionBase, decision: 'skipped', reason: 'send_failed', gates: finalGates });
          }
        };

        let dispatchStatus;
        if (scheduler) {
          dispatchStatus = scheduler.enqueue(user.telegram_chat_id, sendTask, {
            label: (trend.title || '').slice(0, 50),
          });
        } else {
          // No scheduler wired (tests / isolated dev) — fall back to direct send.
          await sendTask();
          dispatchStatus = 'sent';
        }

        if (dispatchStatus === 'dropped_full') {
          // Cap reached — alert never fires. Record the drop for admin visibility.
          const finalGates = [...baseGates, { name: 'queue', passed: false, detail: 'scheduler queue cap reached' }];
          recordDecision({ ...decisionBase, decision: 'skipped', reason: 'queue_full', gates: finalGates });
          totalSkipped++;
        } else {
          // Either sent immediately, queued for later, or bypassed (cooldown
          // disabled). All three count toward the per-cycle cap — the user
          // is in the pipeline regardless of when the chat actually beeps.
          alertsSentThisCycle++;
          totalSent++;
        }

        // Tiny inline pacing — keeps the for-loop from spinning faster than
        // ~3 enqueues/sec even when the scheduler fast-paths everything. Cheap
        // safety against accidental 100-trend bursts saturating Node.
        await new Promise(r => setTimeout(r, 100));
      }

      if (alertsSentThisCycle > 0) {
        logger.info?.(`[Dispatch:${source}] sent ${alertsSentThisCycle} alert(s) to user ${maskId(user.telegram_chat_id)}`);
      }
    } catch (err) {
      // BOT-020 (Bundle #13): per-user crash isolation. Log + admin TG alert,
      // then continue to next user instead of cascading the failure.
      logger.error?.(`[alert-dispatch] per-user crash uid=${user?.id || 'unknown'}: ${err.message}`, { stack: err.stack });
      notifyAdminCrash(err, {
        kind: 'alert-dispatch-per-user',
        userId: user?.id ?? null,
        telegram_chat_id: user?.telegram_chat_id ?? null,
        plan_id: user?.plan_id ?? null,
      });
      // continue to next user
    }
  }

  return { usersTried: activeUsers.length, sent: totalSent, skipped: totalSkipped };
}
