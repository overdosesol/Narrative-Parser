import BaseCollector from './base-collector.js';
import { getActivePresetConfig } from '../analysis/preset-config.js';

/**
 * X Trends collector — TREND-LEVEL with tweet-backed engagement signal.
 *
 * Two-stage daily flow:
 *  1. Pulls the live X trending list via Apify actor `karamelo/twitter-trends-scraper`
 *     — gives us hashtags / topics like "#SkibidiToilet", "Taylor Swift", with rank.
 *  2. Takes the top-N (default 3) and FOR EACH calls TwitterCollector.searchByQuery
 *     to fetch the top K real tweets matching that trend (default 7). Aggregates
 *     their engagement (sum of views / likes / retweets / replies) and emits ONE
 *     item per trend — a source='x_trends' card with REAL engagement numbers
 *     instead of the previous text-only "Trending #N" stub that forced Stage 1
 *     LLM to hallucinate virality.
 *
 * Why one card per trend (not per tweet):
 *   We want the user to SEE the trend itself in the feed (e.g. "#SkibidiToilet
 *   — trending #1 in US, 21M total views across top tweets") — not 21 separate
 *   tweet cards from the same hashtag flooding the feed. The tweets are kept
 *   in metrics.topTweets[] for the LLM and (eventually) the modal/UI.
 *
 * Emitted item shape:
 *   {
 *     externalId:  'xtrends-us-skibiditoilet-20260504',  // daily bucket
 *     source:      'x_trends',
 *     title:       '#SkibidiToilet',
 *     description: 'Trending #1 on X in US (Live). Top tweets: ...',
 *     url:         'https://x.com/search?q=...&src=trend',
 *     // Visual content lifted from the highest-engagement tweet so the card
 *     // has a poster/thumbnail/video to render in dashboard:
 *     imageUrl, videoUrl, ...
 *     metrics: {
 *       // Aggregated REAL engagement (sum across topTweets)
 *       views, likes, retweets, replies,
 *       // Trend metadata
 *       rank, country, timePeriod, tweetVolume,
 *       // Source data — visible in TrendModal, used by Stage 1 prompt
 *       topTweets: [{ id, url, author, text, views, likes, retweets, replies,
 *                     thumbnailUrl, imageUrls, videoUrl }],
 *       tweetsCount,
 *     }
 *   }
 *
 * Cost: 1 trends-list call/day (~100 results × $0.00039 = ~$0.04/day, $1.20/mo)
 *       + N × K tweet fetches/day (3 × 7 = 21 tweets/day × $0.00025 = ~$0.005/day,
 *         $0.16/mo with kaitoeasyapi). Total < $1.50/mo.
 *
 * Configurable via env:
 *   X_TRENDS_REFRESH_MINUTES        — default 1440 (24h)
 *   X_TRENDS_TOP_TRENDS             — default 3
 *   X_TRENDS_TWEETS_PER_TREND       — default 7 (range 5-10 makes sense)
 *   X_TRENDS_COUNTRY                — default "United States" (or numeric ID "1".."35")
 *   X_TRENDS_ENABLED                — panic kill (set to "0")
 *
 * NOTE on country: actor's input schema (build 0.0.33, 2026-03-06) requires a
 * numeric-string enum ("1"..."35"), not the country name. We translate via
 * COUNTRY_ID_MAP below; numeric env values pass through.
 */

const ACTOR_ID = 'karamelo~twitter-trends-scraper';
const APIFY_TIMEOUT_SECS = 90;

const COUNTRY_ID_MAP = {
  'world':                '1',
  'united states':        '2', 'us': '2', 'usa': '2',
  'canada':               '3',
  'mexico':               '4',
  'united kingdom':       '5', 'uk': '5',
  'france':               '6',
  'germany':              '7',
  'italy':                '8',
  'spain':                '9',
  'portugal':             '10',
  'netherlands':          '11',
  'denmark':              '12',
  'austria':              '13',
  'belgium':              '14',
  'switzerland':          '15',
  'greece':               '16',
  'russian federation':   '17', 'russia': '17',
  'turkey':               '18',
  'korea':                '19', 'south korea': '19',
  'singapore':            '20',
  'indonesia':            '21',
  'philippines':          '22',
  'viet nam':             '23', 'vietnam': '23',
  'thailand':             '24',
  'australia':            '25',
  'israel':               '26',
  'united arab emirates': '27', 'uae': '27',
  'saudi arabia':         '28',
  'argentina':            '29',
  'brazil':               '30',
  'egypt':                '31',
  'nigeria':              '32',
  'kenya':                '33',
  'south africa':         '34',
  'japan':                '35',
};

function resolveCountryId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '2';                  // default US
  if (/^\d+$/.test(raw)) return raw;     // already an ID
  return COUNTRY_ID_MAP[raw.toLowerCase()] || '2';
}

function dedupSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9а-я]+/gi, '');
}

class XTrendsCollector extends BaseCollector {
  constructor(config, logger, db, twitterCollector) {
    super('XTrends', logger);

    this.enabled = process.env.X_TRENDS_ENABLED !== '0';
    this.apiKey = process.env.APIFY_X_TRENDS_KEY
               || config.apify?.apiKey
               || process.env.APIFY_API_KEY
               || '';
    this.actorId = process.env.APIFY_X_TRENDS_ACTOR_ID || ACTOR_ID;
    this.country = process.env.X_TRENDS_COUNTRY || 'United States';

    // Daily by default. Was 30min when we emitted raw hashtags; now we pull
    // real tweets per top trend, once-a-day is plenty.
    this.refreshMinutes  = Math.max(60, parseInt(process.env.X_TRENDS_REFRESH_MINUTES || '1440', 10));
    this.topTrendsCount  = Math.max(1,  parseInt(process.env.X_TRENDS_TOP_TRENDS      || '3',    10));
    this.tweetsPerTrend  = Math.max(1,  parseInt(process.env.X_TRENDS_TWEETS_PER_TREND || '7',   10));

    this.db      = db;
    this.twitter = twitterCollector;  // for searchByQuery() — required for tweet pulls

    // _cache.items — array of normalized X-trend items (one per top trend)
    // _emitted     — Set<externalId> already returned by collect() for the
    //                current refresh; cleared on _refresh()
    this._cache         = { fetchedAt: 0, items: [] };
    this._emitted       = new Set();
    this._refreshTimer  = null;
    this._inFlight      = null;

    if (this.enabled && !this.apiKey) {
      this.logger.warn('[XTrends] enabled=true but no Apify key (set APIFY_API_KEY) — disabling');
      this.enabled = false;
    }
    if (this.enabled && !this.twitter) {
      this.logger.warn('[XTrends] no TwitterCollector reference — discovery layer needs it for tweet pulls; disabling');
      this.enabled = false;
    }
  }

  startRefreshTimer() {
    if (!this.enabled) {
      this.logger.info('[XTrends] disabled — refresh timer not started');
      return;
    }
    if (this._refreshTimer) return;

    this._refresh().catch(e => this.logger.warn('[XTrends] initial refresh failed: ' + e.message));

    const intervalMs = this.refreshMinutes * 60 * 1000;
    this._refreshTimer = setInterval(() => {
      this._refresh().catch(e => this.logger.warn('[XTrends] refresh failed: ' + e.message));
    }, intervalMs);
    this.logger.info(
      `[XTrends] refresh timer started (every ${this.refreshMinutes} min, country=${this.country}, ` +
      `top=${this.topTrendsCount}, tweetsPerTrend=${this.tweetsPerTrend})`
    );
  }

  stopRefreshTimer() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Daily refresh: trends list → top-N → tweets per trend → aggregate into
   * one X-Trend item per trend. Coalesces concurrent calls.
   */
  async _refresh() {
    if (this._inFlight) return this._inFlight;
    this._inFlight = (async () => {
      try {
        const trendsList = await this._fetchTrendsList();
        const top = trendsList.slice(0, this.topTrendsCount);
        if (top.length === 0) {
          this.logger.warn('[XTrends] trends list empty — keeping old cache');
          return;
        }

        const items = [];
        for (const trend of top) {
          try {
            // Relaxed floor — these are already the *top* tweets for a trending
            // topic; the firehose-grade 500K-views bar would filter most out.
            const tweets = await this.twitter.searchByQuery(trend.trend, this.tweetsPerTrend, { relaxedFloor: true });
            if (!tweets || tweets.length === 0) {
              this.logger.info(`[XTrends] "${trend.trend}" (rank ${trend.rank}) — no qualifying tweets, skipping`);
              continue;
            }
            const item = this._buildTrendItem(trend, tweets);
            items.push(item);
            this.logger.info(
              `[XTrends] "${trend.trend}" (rank ${trend.rank}) → ${tweets.length} tweets, ` +
              `aggregated views=${item.metrics.views} likes=${item.metrics.likes}`
            );
          } catch (e) {
            this.logger.warn(`[XTrends] tweet fetch for "${trend.trend}" failed: ${e.message}`);
          }
        }

        this._cache   = { fetchedAt: Date.now(), items };
        this._emitted = new Set();  // fresh cycle, allow re-emission of all
        this.logger.info(`[XTrends] daily refresh: ${items.length}/${top.length} trends emitted from ${this.country}`);
      } finally {
        this._inFlight = null;
      }
    })();
    return this._inFlight;
  }

  /**
   * Build a single X-Trend item from a trend descriptor + array of normalized
   * tweets. Aggregates engagement, lifts visual content from the top tweet,
   * and packs source tweets into metrics.topTweets[] for LLM context and UI.
   */
  _buildTrendItem(trend, tweets) {
    // Sort by views desc; representative = highest views (fallback likes if no views)
    const sorted = [...tweets].sort((a, b) => {
      const av = a.metrics?.views ?? 0;
      const bv = b.metrics?.views ?? 0;
      if (bv !== av) return bv - av;
      return (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0);
    });
    const rep = sorted[0];

    // Aggregate engagement (sum across all qualifying tweets — gives a
    // realistic "trend size" signal for Stage 1 LLM)
    let views = 0, likes = 0, retweets = 0, replies = 0;
    for (const t of tweets) {
      views    += t.metrics?.views    || 0;
      likes    += t.metrics?.likes    || 0;
      retweets += t.metrics?.retweets || 0;
      replies  += t.metrics?.replies  || 0;
    }

    // Top tweets — condensed for storage / UI / prompt context
    const topTweets = sorted.map(t => ({
      id:           String(t.externalId || '').replace(/^twitter_/, ''),
      url:          t.url || null,
      author:       t.metrics?.author || null,
      text:         (t.description || t.title || '').substring(0, 280),
      views:        t.metrics?.views    || 0,
      likes:        t.metrics?.likes    || 0,
      retweets:     t.metrics?.retweets || 0,
      replies:      t.metrics?.replies  || 0,
      thumbnailUrl: t.metrics?.thumbnailUrl || null,
      imageUrls:    Array.isArray(t.metrics?.imageUrls) ? t.metrics.imageUrls.slice(0, 4) : [],
      videoUrl:     t.metrics?.videoUrl || null,
    }));

    // Daily bucket so DB-dedup catches the same trend across cycles within a
    // calendar day. New day = fresh ID = re-enters pipeline (matches the
    // "trending again" semantics of X's trending tab).
    const slug = dedupSlug(trend.trend) || 'unknown';
    const day  = new Date().toISOString().slice(0, 10).replace(/-/g, '');  // YYYYMMDD
    const countryCode = this.country === 'United States' ? 'us'
                      : this.country === 'United Kingdom' ? 'uk'
                      : String(this.country).toLowerCase().slice(0, 2);
    const externalId = `xtrends-${countryCode}-${slug}-${day}`;

    // X's canonical "clicked from trending tab" URL — gives the curated trending
    // feed (top-posts grouped, context card on top) instead of plain search.
    // The actor doesn't expose X's internal topic_id (would let us use the
    // /i/trending/<id> deep-link), so this is the closest UX-equivalent.
    const url = `https://x.com/search?q=${encodeURIComponent(trend.trend)}&src=trend_click&vertical=trends`;

    // Description: trend metadata + top 3 tweet snippets so Stage 1 prompt has
    // real content to reason about (not just a hashtag string)
    const sample = sorted.slice(0, 3).map(t => {
      const who  = t.metrics?.author ? `${t.metrics.author}: ` : '';
      const text = (t.description || '').replace(/\s+/g, ' ').trim().substring(0, 140);
      return `${who}"${text}"`;
    }).join(' | ');
    const desc = `Trending #${trend.rank} on X in ${this.country} (${trend.timePeriod}). ` +
                 `Top tweets: ${sample}`;

    return {
      externalId,
      source:      'x_trends',
      title:       trend.trend,
      description: desc,
      url,
      author:      'x_trends',
      timestamp:   new Date().toISOString(),
      // Visual content from rep tweet — lets the X-Trend card have a poster/
      // gallery/video in the dashboard feed, just like a regular twitter card
      imageUrl:    rep.metrics?.thumbnailUrl || null,
      videoUrl:    rep.metrics?.videoUrl    || null,
      metrics: {
        // Aggregated real engagement
        views,
        likes,
        retweets,
        replies,
        // Trend metadata
        rank:        trend.rank,
        country:     this.country,
        timePeriod:  trend.timePeriod,
        tweetVolume: trend.volume || null,
        // Visual aliases (collector schema uses thumbnailUrl/imageUrls; mirror
        // here for cross-source compatibility with the dashboard's image carousel)
        thumbnailUrl: rep.metrics?.thumbnailUrl || null,
        imageUrls:    Array.isArray(rep.metrics?.imageUrls) ? rep.metrics.imageUrls.slice(0, 10) : [],
        videoUrl:     rep.metrics?.videoUrl || null,
        // Source tweets — used by Stage 1 prompt context, dashboard modal,
        // and Stage 2 if it wants to verify/expand
        topTweets,
        tweetsCount: tweets.length,
      },
    };
  }

  async _fetchTrendsList() {
    if (!this.apiKey) throw new Error('No Apify key');
    const runUrl = `https://api.apify.com/v2/acts/${this.actorId}/run-sync-get-dataset-items?timeout=${APIFY_TIMEOUT_SECS}`;

    const input = {
      country: resolveCountryId(this.country),
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

    const cleaned = [];
    for (let i = 0; i < data.length; i++) {
      const raw = data[i];
      const trend = String(raw?.trend || '').trim();
      if (!trend || trend.length < 2 || trend.length > 200) continue;
      cleaned.push({
        trend,
        rank: i + 1,
        timePeriod: String(raw?.timePeriod || 'Live'),
        volume: raw?.volume || null,
      });
    }
    return cleaned;
  }

  /**
   * Per scanner cycle (~90s). Returns X-Trend items deduped within the current
   * refresh (so we don't re-emit the same set 96 times per day). DB-level dedup
   * by externalId handles cross-day backstop.
   *
   * Stale cache → force-refresh sync (catches dead-timer / first-call cases).
   */
  async collect() {
    if (!this.enabled) return [];

    let presetCfg;
    try { presetCfg = getActivePresetConfig(this.db); }
    catch (_) { presetCfg = null; }
    if (presetCfg?.sources?.xtrends?.enabled === 0) return [];

    const ageMs = Date.now() - this._cache.fetchedAt;
    if (this._cache.items.length === 0 || ageMs > 1.5 * this.refreshMinutes * 60 * 1000) {
      try { await this._refresh(); }
      catch (e) {
        this.logger.warn('[XTrends] sync refresh failed: ' + e.message);
        return [];
      }
    }

    const fresh = [];
    for (const item of this._cache.items) {
      if (!item || !item.externalId) continue;
      if (this._emitted.has(item.externalId)) continue;
      this._emitted.add(item.externalId);
      fresh.push(item);
    }
    return fresh;
  }
}

export default XTrendsCollector;
