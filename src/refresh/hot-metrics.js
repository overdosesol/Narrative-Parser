/**
 * HotMetricsRefresher — periodic re-fetch + re-score of "hot" recent trends.
 *
 * Why this exists:
 *   Trends are scored ONCE at collection time. If a trend was borderline
 *   (memePotential 50-59, just under stage2Threshold) and then accelerated
 *   on its source platform — extra views, replies, retweets — the original
 *   snapshot is stale and the trend never gets the Stage 2 deep-dive it
 *   deserves. This loop catches up: every N hours we re-fetch live metrics
 *   for recent trends, run them through Stage 1 (and Stage 2 if the new
 *   memePotential clears the threshold), and persist the updated scores.
 *
 * Cost shape:
 *   - Refresh metrics: FREE — we use fxtwitter (api.fxtwitter.com) for
 *     Twitter and reddit's <permalink>.json for Reddit. No Apify spend.
 *   - Stage 1 LLM: small — gpt-5.4-mini at ~$0.0012 per batch of 8 trends.
 *     ~50 trends per cycle × 12 cycles/day ≈ ~$3/month.
 *   - Stage 2: capped by stage2MaxCalls (default 3/cycle), shared with the
 *     normal collection cycles. Same cost envelope (~$153/month total).
 *   TikTok refresh is intentionally OUT of v1 — it requires Apify (paid).
 *
 * Re-entrancy:
 *   `running` flag — if a previous cycle is still in flight when the
 *   interval fires, we skip rather than pile up. A slow LLM call should
 *   never cause concurrent cycles to thrash the DB.
 *
 * Toggles:
 *   - Env `HOT_REFRESH_ENABLED=0` — panic kill-switch (process restart req'd)
 *   - DB setting `hotRefreshEnabled` — admin runtime toggle (no restart,
 *     read on every cycle entry — see _isAdminEnabled)
 *   - Env `HOT_REFRESH_INTERVAL_MINUTES` — cycle interval (default 720 = 12h)
 *
 * Owner-decided scope (2026-05-03):
 *   - Refresh only trends ≤24h old with memePotential ≥ 50
 *   - Reddit + Twitter only (TikTok later)
 *   - Cap 100 trends per cycle (highest memePotential first)
 *   - No Telegram message edits (existing alerts stay frozen)
 *   - No new alerts triggered specifically by this loop — the normal
 *     alert-loop in index.js will pick up improved scores on its next pass
 *     (so a "ripening" trend that just crossed alertThreshold DOES get
 *     alerted, but through the existing pipeline, not a new path here).
 */

import { resolveTwitterUrl, resolveRedditUrl } from '../analysis/url-resolver.js';
import { recomputeAlertScores, dispatchAlerts } from '../notifications/alert-dispatcher.js';
import { loadAlertWeights } from '../analysis/scorer.js';
import { getActivePresetConfig } from '../analysis/preset-config.js';

// (2026-05-04) Bumped default 120 → 720 (2h → 12h). The picker has no
// per-trend cooldown — every cycle re-runs Stage 1 (and Stage 2 if
// memePotential ≥ 60) on all hot trends. Trends age out of the picker
// after 24h via the first_seen_at filter, so a 2h cycle meant ~12 LLM
// reprocessings per trend lifetime, which was driving Grok costs up
// noticeably. At 12h cycle, each active trend hits Hot refresh ≤ 2 times
// before retention naturally drops it. Override via env if you want to
// tune in either direction:
//   HOT_REFRESH_INTERVAL_MINUTES=360   // every 6h (more reactive)
//   HOT_REFRESH_INTERVAL_MINUTES=1440  // once a day (cheapest)
const DEFAULT_INTERVAL_MIN = 720;
const STARTUP_DELAY_MS = 2 * 60 * 1000;  // wait 2 min after boot before first run
const DEFAULT_MAX_BATCH = 100;
const DEFAULT_MIN_MEME = 50;
const DEFAULT_MAX_AGE_HOURS = 24;
const FETCH_CONCURRENCY = 5;             // polite to fxtwitter / reddit

export default class HotMetricsRefresher {
  constructor({ db, scorer, logger, telegram = null, config = null, recordDecision = null, normalizeThreshold = null }) {
    if (!db) throw new Error('HotMetricsRefresher: db is required');
    if (!scorer) throw new Error('HotMetricsRefresher: scorer is required');
    this.db = db;
    this.scorer = scorer;
    this.logger = logger || console;
    // Optional alert-dispatch deps. If telegram/config aren't wired, the
    // refresh cycle still re-fetches and re-scores (the data layer side),
    // it just skips the dispatch step. Prevents wiring fragility from
    // breaking the loop entirely on partial setups.
    this.telegram = telegram;
    this.config = config;
    this.recordDecision = recordDecision || (() => {});  // no-op: silently drop decisions if buffer not wired
    this.normalizeThreshold = normalizeThreshold || ((v, fb) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fb;
    });
    this.running = false;
    this.intervalHandle = null;
    this.startupTimer = null;
    this.intervalMin = DEFAULT_INTERVAL_MIN;
  }

  /**
   * Snapshot of the loop state for the admin UI. Last-run summary lives in a
   * DB setting so it survives process restarts (operator restarts the bot,
   * sees "last run 3h ago" and knows the cron has been quiet — same value as
   * before restart, then refreshes once schedule kicks in).
   *
   * Returns shape:
   *   { adminEnabled, envEnabled, intervalMin, running,
   *     lastRunAt: ISO|null, lastResult: { ... }|null, nextRunAt: ISO|null }
   */
  getStatus() {
    const adminEnabled = this._isAdminEnabled();
    const envEnabled = process.env.HOT_REFRESH_ENABLED !== '0';
    const lastRunAt = this.db.getSetting?.('hotRefreshLastRunAt', null) || null;
    let lastResult = null;
    try {
      const raw = this.db.getSetting?.('hotRefreshLastResult', null);
      if (raw) lastResult = JSON.parse(raw);
    } catch { /* corrupt JSON — pretend it's absent */ }

    // Estimate next run from interval + last run. If last run is unknown
    // (fresh process, never ran yet) we can't say — admin sees "—".
    let nextRunAt = null;
    if (lastRunAt) {
      const nextMs = new Date(lastRunAt + (lastRunAt.endsWith('Z') ? '' : 'Z')).getTime() + this.intervalMin * 60_000;
      if (Number.isFinite(nextMs)) nextRunAt = new Date(nextMs).toISOString();
    }
    return { adminEnabled, envEnabled, intervalMin: this.intervalMin, running: this.running, lastRunAt, lastResult, nextRunAt };
  }

  start() {
    if (process.env.HOT_REFRESH_ENABLED === '0') {
      this.logger.info?.('[HotRefresh] disabled via HOT_REFRESH_ENABLED=0 env');
      return;
    }
    const intervalMin = Number(process.env.HOT_REFRESH_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MIN;
    const intervalMs = Math.max(60_000, intervalMin * 60_000);
    this.intervalMin = intervalMin;

    this.logger.info?.(`[HotRefresh] enabled — every ${intervalMin}min (admin toggle: hotRefreshEnabled)`);

    // Stagger the first run so it doesn't collide with the first scan-cycle.
    this.startupTimer = setTimeout(() => {
      this.runCycle().catch(e => this.logger.error?.(`[HotRefresh] startup cycle failed: ${e.message}`));
    }, STARTUP_DELAY_MS);

    this.intervalHandle = setInterval(() => {
      this.runCycle().catch(e => this.logger.error?.(`[HotRefresh] cycle failed: ${e.message}`));
    }, intervalMs);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.startupTimer)   clearTimeout(this.startupTimer);
    this.intervalHandle = null;
    this.startupTimer = null;
  }

  /** Read the admin runtime toggle. Default ON (string '1'). */
  _isAdminEnabled() {
    return this.db.getSetting?.('hotRefreshEnabled', '1') === '1';
  }

  /**
   * @param {Object} [opts]
   * @param {string} [opts.trigger='schedule']  'schedule' | 'manual' — recorded in lastResult
   *                                            for admin observability.
   */
  async runCycle({ trigger = 'schedule' } = {}) {
    if (this.running) {
      this.logger.warn?.('[HotRefresh] previous cycle still in flight — skipping');
      return { skipped: true, reason: 'already-running' };
    }
    if (!this._isAdminEnabled()) {
      this.logger.info?.('[HotRefresh] skipped — disabled in admin panel');
      return { skipped: true, reason: 'admin-disabled' };
    }
    this.running = true;
    const startedAt = Date.now();
    let result = { trigger, eligible: 0, fetchOk: 0, fetchFail: 0, stage2Hits: 0, saved: 0, tookSec: 0, error: null };

    try {
      const eligible = this.db.getHotTrendsForRefresh({
        minMeme:     DEFAULT_MIN_MEME,
        maxAgeHours: DEFAULT_MAX_AGE_HOURS,
        sources:     ['reddit', 'twitter'],
        limit:       DEFAULT_MAX_BATCH,
      });
      result.eligible = eligible.length;

      if (eligible.length === 0) {
        this.logger.info?.('[HotRefresh] no eligible trends — cycle done');
        result.tookSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
        this._persistResult(result);
        return result;
      }

      const byBucket = eligible.reduce((acc, t) => {
        acc[t.source] = (acc[t.source] || 0) + 1;
        return acc;
      }, {});
      this.logger.info?.(`[HotRefresh] cycle start — ${eligible.length} eligible (${Object.entries(byBucket).map(([s,n]) => `${s}=${n}`).join(', ')})`);

      // ── Phase 1: refresh raw metrics from source ─────────────────────────
      const refreshed = await this._refreshAll(eligible);
      const fetchOk   = refreshed.filter(t => t._refreshed).length;
      const fetchFail = refreshed.length - fetchOk;
      result.fetchOk = fetchOk;
      result.fetchFail = fetchFail;

      // ── Phase 2: re-score through Stage 1 + Stage 2 (sync, x_search) ─────
      // Pass even the fetch-failed trends — we still want to re-score them
      // against the latest rubric / DB-tunable thresholds. They'll just have
      // stale numbers, which is the same as not running this loop at all.
      let scored = [];
      try {
        scored = await this.scorer.scoreTrends(refreshed);
      } catch (e) {
        this.logger.error?.(`[HotRefresh] scoreTrends failed: ${e.message}`);
        scored = refreshed;  // fall through to persist refreshed metrics at least
      }

      // ── Phase 3: persist back ────────────────────────────────────────────
      let saved = 0;
      let stage2Hits = 0;
      for (const t of scored) {
        if (t.xSearchData) stage2Hits++;
        try {
          // saveTrend UPSERTs by externalId — same row gets updated.
          this.db.saveTrend({ ...t, pipelineStatus: 'scored' });
          saved++;
        } catch (e) {
          this.logger.warn?.(`[HotRefresh] saveTrend failed for ${t.externalId}: ${e.message}`);
        }
      }
      result.saved = saved;
      result.stage2Hits = stage2Hits;

      // ── Phase 4: dispatch alerts for trends that just ripened ────────────
      // Without this step, a trend whose alertScore crossed the threshold
      // ONLY because of refreshed metrics would never alert — the main
      // scan-cycle alert-loop only sees trends from its own batch. The
      // dispatcher's `dedup` gate (db.wasNotificationSentToUser) prevents
      // double-alerting users who already received this trend.
      result.alertsSent = 0;
      if (this.telegram && this.config && saved > 0) {
        try {
          const trendsForAlert = scored.filter(t => t._dbId);
          const alertWeights = loadAlertWeights(this.db);
          const presetCfg = getActivePresetConfig(this.db);
          const globalAlertThreshold = this.normalizeThreshold(
            presetCfg.alerts?.thresholds?.alertThreshold,
            this.config.alertThreshold
          );

          recomputeAlertScores(trendsForAlert, alertWeights, this.db);

          const dispatchResult = await dispatchAlerts({
            trends: trendsForAlert,
            source: 'refresh',
            deps: {
              db:                  this.db,
              telegram:            this.telegram,
              logger:              this.logger,
              config:              this.config,
              alertWeights,
              presetCfg,
              globalAlertThreshold,
              normalizeThreshold:  this.normalizeThreshold,
              recordDecision:      this.recordDecision,
            },
          });
          result.alertsSent = dispatchResult.sent || 0;
        } catch (e) {
          // Alert-dispatch failure should not poison the whole refresh —
          // metrics + scores are already saved. Log and move on.
          this.logger.warn?.(`[HotRefresh] alert dispatch failed: ${e.message}`);
        }
      }

      const tookSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      result.tookSec = Number(tookSec);
      this.logger.info?.(
        `[HotRefresh] cycle done (${trigger}) — fetched=${fetchOk}/${refreshed.length} (failed=${fetchFail}), ` +
        `stage2=${stage2Hits}, saved=${saved}, alerts=${result.alertsSent}, took=${tookSec}s`
      );
      this._persistResult(result);
      return result;
    } catch (e) {
      this.logger.error?.(`[HotRefresh] runCycle outer: ${e.message}`);
      result.error = e.message;
      result.tookSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
      this._persistResult(result);
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Persist the just-finished cycle's stats so the admin UI and a post-restart
   * operator can see "last cycle ran X min ago, processed Y trends, etc."
   * Two settings keys (timestamp + JSON blob) keep the SQL simple.
   */
  _persistResult(result) {
    try {
      this.db.setSetting('hotRefreshLastRunAt', new Date().toISOString());
      this.db.setSetting('hotRefreshLastResult', JSON.stringify(result));
    } catch (e) {
      this.logger.warn?.(`[HotRefresh] could not persist last-run stats: ${e.message}`);
    }
  }

  /**
   * Run all per-trend resolvers concurrently with a small worker pool.
   * Returns trends with merged-fresh metrics. Failed fetches keep the
   * original metrics object — we never drop a trend from the pool just
   * because its source 404'd, since re-scoring against current rubric
   * is still useful by itself.
   */
  async _refreshAll(trends) {
    const out = new Array(trends.length);
    let cursor = 0;

    const work = async () => {
      while (true) {
        const i = cursor++;
        if (i >= trends.length) break;
        const trend = trends[i];
        try {
          const fresh = await this._fetchFresh(trend);
          if (fresh) {
            out[i] = this._merge(trend, fresh);
            out[i]._refreshed = true;
          } else {
            out[i] = trend;  // unsupported source — skip silently
          }
        } catch (e) {
          this.logger.warn?.(`[HotRefresh] fetch ${trend.source}#${trend._dbId}: ${e.message}`);
          out[i] = trend;
        }
      }
    };

    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, work));
    return out;
  }

  async _fetchFresh(trend) {
    if (!trend.url) return null;
    if (trend.source === 'twitter') return resolveTwitterUrl(trend.url);
    if (trend.source === 'reddit')  return resolveRedditUrl(trend.url);
    return null;
  }

  /**
   * Merge fresh metrics into the existing trend object.
   *
   * Identity stays from the DB (externalId, title — title may have been
   * translated by Stage 1 originally and we want UPSERT to match the same
   * row). Metrics come from fresh. preStage is preserved from DB so the
   * scorer doesn't re-pay for nano/gemini calls on every refresh.
   */
  _merge(originalTrend, freshTrend) {
    return {
      // Identity — keep from DB so saveTrend's UPSERT path matches the row.
      externalId:    originalTrend.externalId,
      url:           originalTrend.url,
      source:        originalTrend.source,
      title:         originalTrend.title,
      originalTitle: originalTrend.originalTitle || freshTrend.originalTitle || originalTrend.title,
      description:   originalTrend.description || freshTrend.description || '',

      // Fresh content from resolver — these are the whole point of the refresh.
      metrics: {
        ...(originalTrend.metrics || {}),
        ...(freshTrend.metrics    || {}),
        // Mark this run so admin/dev can see in raw_metrics that the row
        // was touched by the refresh loop.
        lastRefreshedAt: new Date().toISOString(),
      },

      // Carry through anything that was already paid-for and shouldn't
      // be dropped just because we're re-scoring.
      preStage: originalTrend.preStage || null,

      // ── Critical carry-through ──────────────────────────────────────────
      // Stage 1 only recomputes memePotential / category / whyNow / etc.
      // It does NOT touch emergenceScore (clusterer's domain) or junkPenalty
      // (also clusterer + junk-filter). On a single-trend re-score we don't
      // re-run clusterer either, so without explicit carry-through these
      // fields would zero out and downstream computeAlertScore would read
      // emergence=0 / junk=0 — sinking the alertScore below threshold for
      // any trend that happens to pass through the refresh loop.
      //
      // clusterMetrics is the canonical source: the scorer's
      // _analyzeBatchStage1 reads `trend.clusterMetrics?.emergenceScore`
      // exclusively (not the top-level field). getHotTrendsForRefresh now
      // populates clusterMetrics fully, so we just spread it through here.
      emergenceScore: originalTrend.emergenceScore ?? 0,
      narrativePhase: originalTrend.narrativePhase ?? null,
      marketStage:    originalTrend.marketStage    ?? null,
      junkPenalty:    originalTrend.junkPenalty    ?? 0,
      clusterMetrics: { ...(originalTrend.clusterMetrics || {}) },

      // Internal pointer used by saveTrend's UPSERT path is externalId/url —
      // _dbId is informational so we can log it on errors.
      _dbId: originalTrend._dbId,
    };
  }
}
