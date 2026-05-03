import BaseCollector from './base-collector.js';
import { getActivePresetConfig } from '../analysis/preset-config.js';

/**
 * X Trends collector — pulls live trending topics from X via the Apify actor
 * `karamelo/twitter-trends-scraper`.
 *
 * Different from src/collectors/twitter.js: that one does TWEET SEARCH, this
 * one does the TRENDS LIST (the hashtags/topics shown in X's "Trending" tab).
 *
 * Pipeline shape: each emitted item represents one trending topic, e.g.
 *   { source: 'x_trends', title: '#SkibidiToilet',
 *     description: 'Trending #3 on X (United States, live)',
 *     metrics: { rank: 3, country: 'United States', timePeriod: 'Live' },
 *     url: 'https://x.com/search?q=%23SkibidiToilet&src=trend' }
 *
 * The trends list refreshes infrequently (~30 min real-world cadence) so we
 * decouple the API fetch from the scanner cycle: an internal timer hits Apify
 * every X_TRENDS_REFRESH_MINUTES (default 30), caches the result in memory,
 * and `collect()` returns a diff of NEW trends since last emit. This avoids
 * re-emitting "Taylor Swift" 50 times when she's been trending all afternoon
 * — but DOES re-emit if a trend disappeared and came back later.
 *
 * Cost: ~$0.29 / 1000 results × ~30 trends/run × 48 runs/day ≈ $0.42/day,
 * about $13/month. Configurable via X_TRENDS_REFRESH_MINUTES if too pricey.
 *
 * NOTE on country: the actor exposes a `country` input but in our test runs
 * the JSON view didn't include it (form-only field?). We send it anyway —
 * harmless if ignored, defaults to US which is what we want for English
 * priority either way.
 *
 * NOTE on volume: this actor returns `volume: ""` (empty string) for most
 * trends — X stopped exposing public tweet volume. So minTweetVolume filter
 * isn't viable; we rely on rank (array index) + AI Stage 1 scoring instead.
 */

const ACTOR_ID = 'karamelo~twitter-trends-scraper';
const APIFY_TIMEOUT_SECS = 90;

// Re-emission cap. Same trend won't enter the pipeline more than once per
// EMIT_TTL_MS even if it stays in the trending list across multiple refreshes.
// After it's been absent from cache and returns later, we re-emit (real signal
// of resurgence). Hourly bucketing also makes the externalId stable for DB-dedup.
const EMIT_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours

class XTrendsCollector extends BaseCollector {
  constructor(config, logger, db) {
    super('XTrends', logger);
    // Global kill switch via env (preserves admin runtime control via
    // per-preset xtrends.enabled flag in presetConfigs blob).
    this.enabled = process.env.X_TRENDS_ENABLED !== '0';
    // Reuse the project-wide Apify key — operator confirmed this token has
    // access to all actors on their account. Override via APIFY_X_TRENDS_KEY
    // if a scoped token becomes desirable later.
    this.apiKey = process.env.APIFY_X_TRENDS_KEY
               || config.apify?.apiKey
               || process.env.APIFY_API_KEY
               || '';
    this.actorId = process.env.APIFY_X_TRENDS_ACTOR_ID || ACTOR_ID;
    this.country = process.env.X_TRENDS_COUNTRY || 'United States';
    this.refreshMinutes = Math.max(5, parseInt(process.env.X_TRENDS_REFRESH_MINUTES || '30', 10));

    this.db = db;

    // In-memory state — survives within a single scanner process lifetime.
    // _cache: { fetchedAt: Date.now(), items: [...] } — last successful API result
    // _emitted: Map<trend-name, lastEmittedAt> — re-emit gate
    // _refreshTimer: handle for setInterval, cleared on stop()
    this._cache = { fetchedAt: 0, items: [] };
    this._emitted = new Map();
    this._refreshTimer = null;
    this._inFlight = null;  // dedup concurrent _refresh() calls

    if (this.enabled && !this.apiKey) {
      this.logger.warn('[XTrends] enabled=true but no Apify key (set APIFY_API_KEY) — disabling');
      this.enabled = false;
    }
  }

  /**
   * Start the background refresh timer. Called once at scanner startup.
   * Fires an immediate fetch then every X_TRENDS_REFRESH_MINUTES.
   */
  startRefreshTimer() {
    if (!this.enabled) {
      this.logger.info('[XTrends] disabled — refresh timer not started');
      return;
    }
    if (this._refreshTimer) return;  // idempotent

    // Fire-and-forget initial fetch so the first collect() has data
    this._refresh().catch(e => this.logger.warn('[XTrends] initial refresh failed: ' + e.message));

    const intervalMs = this.refreshMinutes * 60 * 1000;
    this._refreshTimer = setInterval(() => {
      this._refresh().catch(e => this.logger.warn('[XTrends] refresh failed: ' + e.message));
    }, intervalMs);
    this.logger.info(`[XTrends] refresh timer started (every ${this.refreshMinutes} min, country=${this.country})`);
  }

  /**
   * Stop the background timer. Safe to call multiple times.
   */
  stopRefreshTimer() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Hit Apify, parse, store in cache. Coalesces concurrent calls so a slow
   * sync-fetch from collect() doesn't fight the timer-driven refresh.
   */
  async _refresh() {
    if (this._inFlight) return this._inFlight;
    this._inFlight = (async () => {
      try {
        const items = await this._fetchFromApify();
        this._cache = { fetchedAt: Date.now(), items };
        this.logger.info(`[XTrends] refreshed: ${items.length} trends from ${this.country}`);
      } finally {
        this._inFlight = null;
      }
    })();
    return this._inFlight;
  }

  async _fetchFromApify() {
    if (!this.apiKey) throw new Error('No Apify key');
    // Authorization: Bearer instead of ?token= so a network-error
    // err.message can never leak the API key (see tiktok.js for rationale).
    const runUrl = `https://api.apify.com/v2/acts/${this.actorId}/run-sync-get-dataset-items?timeout=${APIFY_TIMEOUT_SECS}`;

    const input = {
      country: this.country,
      live:   true,
      hour1:  false, hour3:  false, hour6:  false, hour12: false, hour24: false,
      day2:   false, day3:   false,
      proxyOptions: { useApifyProxy: true },
    };

    const response = await fetch(runUrl, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body:    JSON.stringify(input),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Apify ${response.status} [${this.actorId}]: ${err.substring(0, 400)}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      this.logger.warn('[XTrends] non-array response from Apify');
      return [];
    }
    // Sort/de-noise: actor returns trends presumably ordered by rank already.
    // Filter out blank/garbage rows; trim trend strings; assign 1-based rank
    // by array position.
    const cleaned = [];
    for (let i = 0; i < data.length; i++) {
      const raw = data[i];
      const trend = String(raw?.trend || '').trim();
      if (!trend || trend.length < 2 || trend.length > 200) continue;
      cleaned.push({
        trend,
        rank: i + 1,
        timePeriod: String(raw?.timePeriod || 'Live'),
        volume: raw?.volume || null,  // usually empty string from this actor
        capturedAt: raw?.time || new Date().toISOString(),
      });
    }
    return cleaned;
  }

  /**
   * Called once per scanner cycle (~90s). Returns trends that haven't been
   * emitted recently — diff against _emitted map.
   *
   * If the cache is older than 2× refresh interval, force a fresh fetch
   * synchronously (rare path — happens if the timer is silently dead, e.g.
   * after host suspend/resume).
   */
  async collect() {
    if (!this.enabled) return [];

    // Per-preset config decides whether we even emit + how many top trends
    // to pass through. Read fresh every cycle so admin "Пресеты" edits to
    // xtrends.enabled / .topN apply on the next cycle without restart.
    let presetCfg;
    try { presetCfg = getActivePresetConfig(this.db); }
    catch (_) { presetCfg = null; }
    const xCfg = presetCfg?.sources?.xtrends || {};
    if (xCfg.enabled === 0) return [];
    const topN = Number.isFinite(+xCfg.topN) && +xCfg.topN > 0 ? +xCfg.topN : 20;

    // Stale cache? Force-refresh sync (also catches the case where timer
    // wasn't started — e.g. during admin manual-submit single-run paths).
    const ageMs = Date.now() - this._cache.fetchedAt;
    if (this._cache.items.length === 0 || ageMs > 2 * this.refreshMinutes * 60 * 1000) {
      try { await this._refresh(); }
      catch (e) {
        this.logger.warn('[XTrends] sync refresh failed: ' + e.message);
        return [];
      }
    }

    const top = this._cache.items.slice(0, topN);
    const now = Date.now();

    // Garbage-collect stale _emitted entries (older than EMIT_TTL_MS so they
    // can re-fire). Keeps the map bounded.
    for (const [key, ts] of this._emitted) {
      if (now - ts > EMIT_TTL_MS) this._emitted.delete(key);
    }

    const fresh = [];
    for (const t of top) {
      const key = this._dedupKey(t.trend);
      if (this._emitted.has(key)) continue;
      this._emitted.set(key, now);
      fresh.push(this._normalize(t));
    }
    return fresh;
  }

  /**
   * Stable dedup key. Lowercased + stripped of non-alphanumerics so
   * "Taylor Swift" and "TAYLOR SWIFT" and "#TaylorSwift" all collapse to
   * one bucket.
   */
  _dedupKey(trend) {
    return String(trend).toLowerCase().replace(/[^a-z0-9а-я]+/gi, '');
  }

  /**
   * Map Apify shape → unified collector item shape used by the rest of the
   * pipeline (Aggregator → cheapDedup → PreStage → Clusterer → Scorer).
   */
  _normalize(t) {
    const trend = t.trend;
    const slug  = this._dedupKey(trend) || 'unknown';
    // Hour-bucketed externalId so DB-dedup catches re-emissions within the
    // same hour. Across hours, the trend gets a fresh ID and re-enters the
    // pipeline (matches the in-memory _emitted TTL semantics).
    const hourBucket = new Date(t.capturedAt).toISOString().slice(0, 13).replace(/[-:T]/g, '');
    const countryCode = this.country === 'United States' ? 'us'
                      : this.country === 'United Kingdom' ? 'uk'
                      : this.country.toLowerCase().slice(0, 2);
    const externalId = 'xtrends-' + countryCode + '-' + slug + '-' + hourBucket;

    // URL for the alert link: takes user to X's search results for the trend.
    // src=trend tells X this came from a trending tab click (relevant search
    // mode automatically). Encoded so hashtags / spaces / unicode work.
    const url = 'https://x.com/search?q=' + encodeURIComponent(trend) + '&src=trend';

    // Description optimised for AI Stage 1 — gives the model enough context
    // (rank + country + period) to gauge whether the topic looks meme-worthy
    // without seeing actual tweets. Stage 2 (Grok x_search) will fetch real
    // tweets if the trend passes Stage 1.
    const desc = 'Trending #' + t.rank + ' on X in ' + this.country + ' (' + t.timePeriod + ').' +
                 (t.volume ? ' Volume: ' + t.volume + '.' : '');

    return {
      externalId,
      source: 'x_trends',
      title:  trend,
      description: desc,
      url,
      author: 'x_trends',  // pseudo-author so downstream code doesn't crash on null
      timestamp: t.capturedAt,
      metrics: {
        rank:        t.rank,
        country:     this.country,
        timePeriod:  t.timePeriod,
        tweetVolume: t.volume || null,
      },
    };
  }
}

export default XTrendsCollector;
