import BaseCollector from './base-collector.js';
import { getActivePresetConfig } from '../analysis/preset-config.js';

/**
 * TikTok collector — uses Apify's TikTok scraper to surface viral content.
 *
 * Strategy:
 *  - Searches TikTok by hashtag (crypto/meme focused)
 *  - Extracts high-view videos and their hashtags as potential meme signals
 *  - Clusters by hashtag to surface emerging narratives
 */

const MAX_VIDEOS_PER_TAG = 15;
const TIMEOUT_SECS = 120;

// ── Trending hashtag discovery ──────────────────────────────────────────────
// Daily refresh of currently-popular TikTok hashtags via clockworks Trends
// scraper. The actor pulls live data from TikTok's Creative Center (the
// official source TikTok publishes trending hashtags through), so we get
// genuinely current memes/topics — not predictions or last-week's slang.
//
// Used as the PRIMARY hashtag source in `_getHashtags()`; the per-preset
// hardcoded list (preset-config.js) remains as fallback only (if the actor
// call fails or returns nothing).
//
// Cost: ~$4.32/month at default 24 hashtags × twice-daily refresh.
// PRICING TRAP: Apify's public actor page lists $1.70/1K, the real billed
// rate (visible in console / actor's "pricing" tab) is **$3.00/1K**. The
// public-page number is stale/wrong — always verify in console. This applies
// to other clockworks actors too — don't trust the open-site sticker price.
const TRENDS_ACTOR_ID = 'clockworks~tiktok-trends-scraper';
const TRENDS_TIMEOUT_SECS = 60;

// ── Compilation / aggregator detector ───────────────────────────────────────
// TikTok hashtag-search inevitably surfaces a lot of category-aggregator
// videos: "Top 10 funny dogs", "Cute moments compilation #5", "10 minutes of
// fails", weekly meme dumps, etc. They have no narrative — just stitched-
// together clips for engagement farming.
//
// The strongest tell is the caption text. Match early in `_normalize` and
// drop before we waste an Apify download / Stage 0 enrichment / Stage 1 LLM
// call on something that's structurally not a narrative.
//
// Patterns chosen to be high-precision, low-recall — we'd rather miss a few
// compilations than drop legit narrative posts that happen to use phrases
// like "the best moment" or "top scorer". Concrete examples:
//   "Funny dog compilation #5"        → "compilation"
//   "Top 10 cute cats of the week"    → "top 10"  +  "of the week"
//   "10 minutes of fails"             → "10 minutes of"
//   "Funniest moments 2026"           → "funniest"
//   "Best of dogs"                    → "best of"
//   "Memes #5"                        → "#5" at end
// Non-matches (left through):
//   "Trump vs Biden in heated moment" — single moment narrative
//   "My breakup story part 1"         — narrative, even with "part"
//   "She found a stray kitten"        — single event
const COMPILATION_RE = /\b(?:compilations?|funniest|funny\s+moments?|cute\s+moments?|best\s+of|top\s+\d+|(?:\d+|a\s+few)\s+(?:minute|second|hour|min|sec|hr)s?\s+of|memes?\s+#\d+|weekly\s+best|monthly\s+best|daily\s+best|of\s+the\s+(?:week|month|year)|highlights\s+of\s+the)\b|#\d+\s*$/i;

// ── Actor registry ──────────────────────────────────────────────────────────
// Pluggable Apify TikTok scrapers. Active actor picked at runtime from DB
// setting 'tiktokActor' (admin-configurable, no restart).
//
// Both actors return mostly overlapping engagement fields (playCount, diggCount,
// commentCount, shareCount, createTime). Field-path differences (authorMeta.name
// vs authorUsername, covers[0] vs imageUrl) are absorbed by the wide fallback
// chains in `_normalize` — adding a new actor only requires extending those
// chains if it uses yet another field name.
//
// VIDEO MEDIA NOTE: neither actor's direct video URL is reliable for our
// pipeline. clockworks doesn't expose it. apidojo returns `videoUrl` but it's
// header/cookie-bound and expires quickly. We use `webVideoUrl` (the page link)
// + `thumbnailUrl` (the cover) — same as before, no behaviour change for users.
const ACTORS = {
  clockworks: {
    id: 'clockworks~tiktok-scraper',
    // Native hashtag input — actor fetches the tag page directly.
    buildInput: (hashtag, maxItems) => ({
      hashtags: [hashtag],
      resultsPerPage: maxItems,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    }),
  },
  apidojo: {
    id: 'apidojo~tiktok-scraper',
    // No `hashtags` field — feed it tag URLs through startUrls instead.
    // `https://www.tiktok.com/tag/<tag>` is the canonical hashtag-page URL.
    buildInput: (hashtag, maxItems) => ({
      startUrls: [{ url: `https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}` }],
      maxItems,
      sortType: 'RELEVANCE',
      // Suppress optional media downloads — we keep cover URLs only.
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    }),
  },
};
const DEFAULT_ACTOR = 'clockworks';

// Per-preset hashtags now live in settings.presetConfigs (sources.tiktok.hashtags).
// See preset-config.js DEFAULT_PRESET_CONFIGS for shipped defaults — note this
// fixed a stale-keys bug where pre-PR PRESET_HASHTAGS only had general/animals/
// ai/elon/sports keys (didn't match PRESET_KEYS), so culture/celebrities/events
// silently fell back to general. Now every preset has tailored hashtags.

class TikTokCollector extends BaseCollector {
  constructor(config, logger, db) {
    super('TikTok', logger);
    this.enabled = config.tiktok?.enabled ?? false;
    // Per-actor tokens — falls back to generic APIFY_API for clockworks
    // (back-compat with old single-key deployments).
    this.tiktokKeys = config.apify?.tiktokKeys || {};
    this.customHashtags = config.tiktok?.hashtags || null;
    this.maxVideosPerTag = config.tiktok?.maxVideosPerTag || MAX_VIDEOS_PER_TAG;
    this.db = db;

    const configured = Object.entries(this.tiktokKeys).filter(([, v]) => v).map(([k]) => k);
    if (this.enabled && configured.length === 0) {
      this.logger.warn('[TikTok] enabled=true but no actor keys (APIFY_API / APIFY_API_APIDOJO) set — disabling');
      this.enabled = false;
    }

    // Trending hashtag discovery state (Stage A — daily refresh from TikTok
    // Creative Center via clockworks/tiktok-trends-scraper).
    this._trendingHashtags = null;       // string[] of hashtag names (no #)
    this._trendingFetchedAt = 0;         // ms epoch of last successful fetch
    this.trendsRefreshMinutes = parseInt(process.env.TIKTOK_TRENDS_REFRESH_MINUTES || '720', 10);
    this.trendsTopN           = parseInt(process.env.TIKTOK_TRENDS_TOP_N           || '24',  10);
    this.trendsCountry        = (process.env.TIKTOK_TRENDS_COUNTRY  || 'US').toUpperCase();

    // TikTok-specific cycle interval — runs less frequently than the global
    // scan cadence to conserve Apify credits. Math at defaults: 30min cycle ×
    // 1 hashtag per cycle = 48 searches/day; 24 hashtags rotated through
    // exactly 24 cycles = 12h = matches the trends-refresh window so each
    // hashtag is searched once per refresh window.
    this.cycleIntervalMinutes = parseInt(process.env.TIKTOK_CYCLE_INTERVAL_MINUTES || '30', 10);
    this._lastCollectAt = 0;

    this._restoreCachedTrendingHashtags();
  }

  /**
   * Restore trending-hashtag cache from DB on startup so a freshly-restarted
   * container doesn't re-fetch immediately if a recent cache exists. The
   * cache is also written to DB after each successful fetch.
   */
  _restoreCachedTrendingHashtags() {
    try {
      const raw = this.db?.getSetting?.('tiktokTrendingHashtags', '');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.hashtags) && parsed.hashtags.length > 0) {
        this._trendingHashtags = parsed.hashtags;
        this._trendingFetchedAt = parsed.fetchedAt || 0;
        const ageMin = Math.round((Date.now() - this._trendingFetchedAt) / 60_000);
        this.logger?.info?.(`[TikTok] restored ${parsed.hashtags.length} cached trending hashtags (age=${ageMin}min)`);
      }
    } catch (_) { /* corrupt cache — ignore, will re-fetch */ }
  }

  /**
   * Resolve the active actor + its API key. Falls back to default if the
   * configured one is unknown or has no key.
   */
  _activeActor() {
    const chosen = (this.db?.getSetting('tiktokActor', DEFAULT_ACTOR) || DEFAULT_ACTOR).toLowerCase();
    const def = ACTORS[chosen] || ACTORS[DEFAULT_ACTOR];
    const key = this.tiktokKeys[chosen] || this.tiktokKeys[DEFAULT_ACTOR] || '';
    const name = ACTORS[chosen] ? chosen : DEFAULT_ACTOR;
    return { name, def, key };
  }

  /**
   * Refresh trending hashtags from TikTok Creative Center if cache is stale
   * (>refresh interval old) OR empty. Soft-fails — on error, keeps existing
   * cache (or null, in which case `_getHashtags` falls back to preset list).
   *
   * Called lazily before each scan cycle's hashtag pick. Cost: 1 Apify call
   * per `trendsRefreshMinutes` interval (default 1440 = once per day).
   */
  async _ensureTrendingHashtagsFresh() {
    const ageMs = Date.now() - this._trendingFetchedAt;
    const stale = !this._trendingHashtags || ageMs >= this.trendsRefreshMinutes * 60_000;
    if (!stale) return;

    try {
      const fresh = await this._fetchTrendingHashtags();
      if (Array.isArray(fresh) && fresh.length > 0) {
        this._trendingHashtags = fresh;
        this._trendingFetchedAt = Date.now();
        try {
          this.db?.setSetting?.('tiktokTrendingHashtags', JSON.stringify({
            hashtags: fresh,
            fetchedAt: this._trendingFetchedAt,
          }));
        } catch (_) { /* DB write best-effort */ }
        this.logger.info(
          `[TikTok] refreshed ${fresh.length} trending hashtags from TikTok Creative Center ` +
          `(country=${this.trendsCountry}, top=${this.trendsTopN})`
        );
      } else {
        this.logger.warn('[TikTok] trends scraper returned no hashtags — keeping cached/fallback list');
      }
    } catch (e) {
      this.logger.warn(`[TikTok] trending hashtags refresh failed: ${e.message} — keeping cached/fallback list`);
    }
  }

  /**
   * Single-call to clockworks/tiktok-trends-scraper. Returns an array of
   * hashtag names (no leading #), filtered:
   *   - skip promoted (TikTok's own ad placements — `isPromoted: true`)
   *   - skip 0-video entries (corrupt/dead tags)
   *   - sorted by rank ascending
   *   - capped at `trendsTopN`
   */
  async _fetchTrendingHashtags() {
    // Reuse whichever Apify token the user has — clockworks-trends accepts
    // the standard token same as clockworks-scraper / apidojo.
    const apiKey = this.tiktokKeys.clockworks || this.tiktokKeys.apidojo || '';
    if (!apiKey) {
      throw new Error('No Apify API key configured for trends discovery');
    }

    const runUrl = `https://api.apify.com/v2/acts/${TRENDS_ACTOR_ID}/run-sync-get-dataset-items?timeout=${TRENDS_TIMEOUT_SECS}`;
    // Input schema per actor's published JSON schema (verified 2026-05-05 via
    // /v2/acts/{id}/builds/default). All hashtag-config keys use `ads*`
    // prefix (Creative Center is TikTok's "ads" surface — naming reflects
    // that origin even though the data is general trending). Default values:
    //   adsScrapeHashtags=true       → enable hashtag scraping (we need this)
    //   resultsPerPage=int           → up to ~100 for hashtags
    //   adsCountryCode='US'          → ISO-2 enum (subset of countries)
    //   adsTimeRange='7'/'30'/'120'  → last N days
    //   adsScrapeSounds/Creators/Videos=false → skip these data types so we
    //                                  don't pay for irrelevant Creative Center
    //                                  pages we'd discard
    //   adsRankType='popular'        → sort mode
    const input = {
      adsScrapeHashtags: true,
      adsScrapeSounds: false,
      adsScrapeCreators: false,
      adsScrapeVideos: false,
      resultsPerPage: this.trendsTopN,
      adsCountryCode: this.trendsCountry,
      adsTimeRange: '7',                  // last 7 days — most current spike data
      adsRankType: 'popular',             // by view count, not new-on-board
    };

    const res = await fetch(runUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Apify ${res.status}: ${body.substring(0, 400)}`);
    }

    const items = await res.json();
    if (!Array.isArray(items)) return [];

    return items
      .filter(it => it && typeof it.name === 'string' && !it.isPromoted && (it.videoCount || 0) > 0)
      .sort((a, b) => (a.rank || 999) - (b.rank || 999))
      .slice(0, this.trendsTopN)
      .map(it => it.name.replace(/^#+/, '').trim())
      .filter(Boolean);
  }

  /**
   * Resolve hashtag list for the active scan cycle. Priority:
   *   1. customHashtags (env override TIKTOK_HASHTAGS) — escape hatch
   *   2. Trending hashtags from TikTok Creative Center (live, refreshes daily)
   *   3. Per-preset hardcoded list (preset-config.js) — fallback when trends
   *      discovery is unavailable / failed / not yet fetched
   *   4. Last-resort generic list — only if preset blob is corrupted
   *
   * Marked async because it triggers refresh-on-stale; in practice only one
   * call per ~24h actually awaits the network.
   */
  async _getHashtags() {
    if (this.customHashtags) return this.customHashtags;

    // Try live trending list first.
    await this._ensureTrendingHashtagsFresh();
    if (this._trendingHashtags && this._trendingHashtags.length > 0) {
      return this._trendingHashtags;
    }

    // Fallback to preset config hardcoded list.
    let hashtags = [];
    try { hashtags = getActivePresetConfig(this.db).sources?.tiktok?.hashtags || []; }
    catch (_) { hashtags = []; }
    if (hashtags.length === 0) hashtags = ['memecoin', 'viral', 'fyp'];
    return hashtags;
  }

  async collect() {
    if (!this.enabled) return [];

    // Time-based cycle gate — TikTok runs less often than other collectors
    // (default 30min vs global 15min) to save Apify credits. The gate here
    // matches the global scan cadence by skipping every other cycle when
    // global = 15min and TikTok = 30min. First cycle after restart always
    // passes (lastCollectAt=0 → ageMinutes very large).
    const ageMinutes = (Date.now() - this._lastCollectAt) / 60_000;
    if (ageMinutes < this.cycleIntervalMinutes) {
      this.logger.info(
        `[TikTok] skipping cycle — last run ${Math.round(ageMinutes)}min ago ` +
        `(interval=${this.cycleIntervalMinutes}min)`
      );
      return [];
    }
    this._lastCollectAt = Date.now();

    const allVideos = [];

    // Pick 1 hashtag per cycle (was 2). With 24 trending hashtags refreshed
    // every 12h (=720min) and 30min cycles, exactly 24 cycles fit per refresh
    // window → each hashtag searched once per window. Bumping to 2 would
    // burn through hashtags in 6h and re-search same ones twice per window.
    // `_pickHashtags()` is async — it lazy-refreshes the trending list from
    // TikTok Creative Center if the cache is stale.
    const tagsThisCycle = await this._pickHashtags();

    for (const hashtag of tagsThisCycle) {
      try {
        const items = await this._fetchHashtag(hashtag);
        allVideos.push(...items);
        await this._delay(2500);
      } catch (err) {
        this.logger.warn(`[TikTok] Hashtag #${hashtag} failed: ${err.message}`);
      }
    }

    // Deduplicate by video id
    const seen = new Set();
    const unique = allVideos.filter(v => {
      if (seen.has(v.externalId)) return false;
      seen.add(v.externalId);
      return true;
    });

    return this._clusterByHashtag(unique);
  }

  async _pickHashtags() {
    const hashtags = await this._getHashtags();
    if (!Array.isArray(hashtags) || hashtags.length === 0) return [];
    // 1 hashtag per cycle — at 30min cycle + 24 trending hashtags refreshed
    // every 12h, this gives exactly 24 cycles per refresh window so each
    // hashtag is searched once before refresh brings new ones.
    const cycleSize = 1;
    this._cycleCounter = (this._cycleCounter || 0) + 1;
    const start = (this._cycleCounter * cycleSize) % hashtags.length;
    const picked = [];
    for (let i = 0; i < cycleSize; i++) {
      picked.push(hashtags[(start + i) % hashtags.length]);
    }
    return picked;
  }

  async _fetchHashtag(hashtag) {
    const { name: actorName, def: actor, key: apiKey } = this._activeActor();
    if (!apiKey) {
      throw new Error(`[TikTok] No API key configured for actor '${actorName}'`);
    }
    // Token via Authorization: Bearer (not ?token= query): if fetch() throws
    // a network/DNS error, the URL is embedded in err.message and a token
    // would leak through any upstream `logger.error(e.message)`. Bearer
    // keeps it out of the URL entirely.
    const runUrl = `https://api.apify.com/v2/acts/${actor.id}/run-sync-get-dataset-items?timeout=${TIMEOUT_SECS}`;

    const input = actor.buildInput(hashtag, this.maxVideosPerTag);

    const response = await fetch(runUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Apify ${response.status} [${actorName}]: ${err.substring(0, 400)}`);
    }

    const videos = await response.json();
    if (!Array.isArray(videos)) return [];

    return videos.map(v => this._normalize(v, hashtag)).filter(Boolean);
  }

  _normalize(video, sourceHashtag) {
    if (!video) return null;

    // ID + caption text — apidojo puts the caption in `title`, clockworks in `text`/`desc`.
    const id = video.id || video.webVideoUrl?.split('/').pop() || null;
    const desc = video.text
              || video.desc
              || video.description
              || video.title           // apidojo: caption + hashtags live here
              || '';
    if (!desc && !id) return null;

    // Field-name variations across actors. apidojo's schema uses bare names
    // (views/likes/comments/shares) and nests media + author one level deep.
    //   clockworks: playCount, diggCount, commentCount, shareCount, authorMeta.{name,fans}, covers[], cover, dynamicCover
    //   apidojo:    views,     likes,     comments,     shares,     channel.{username,followers},  video.{url,cover,thumbnail}
    const plays     = video.playCount     || video.views          || 0;
    const likes     = video.diggCount     || video.likeCount      || video.likes    || 0;
    const comments  = video.commentCount  || video.comments       || 0;
    const shares    = video.shareCount    || video.shares         || 0;
    const author    = video.authorMeta?.name
                   || video.authorUsername
                   || video.author?.uniqueId
                   || video.channel?.username   // apidojo
                   || 'unknown';
    const followers = video.authorMeta?.fans
                   || video.authorMeta?.followers
                   || video.authorMeta?.followerCount
                   || video.author?.fans
                   || video.channel?.followers   // apidojo (often null but checked)
                   || 0;

    const url = video.webVideoUrl
             || video.url                                         // apidojo top-level page link
             || (id ? `https://www.tiktok.com/@${author}/video/${id}` : '');

    // Extract hashtags from description
    const hashtagMatches = desc.match(/#\w+/g) || [];
    const hashtags = [...new Set(hashtagMatches.map(h => h.toLowerCase()))];

    // Extract tickers
    const tickerMatches = desc.match(/\$[A-Z]{2,8}/g) || [];
    const tickers = [...new Set(tickerMatches)];

    // Virality score
    const viralScore = Math.min(100, Math.round(
      (Math.log10(plays    + 1) * 10) +
      (Math.log10(likes    + 1) * 12) +
      (Math.log10(comments + 1) * 8) +
      (Math.log10(shares   + 1) * 15) +
      (Math.log10(followers + 1) * 5)
    ));

    // Engagement rate: likes relative to follower count
    const engagementRate = followers > 0 ? Math.round((likes / followers) * 10000) / 100 : 0; // percentage

    // Minimum engagement bar — passes if ANY of:
    //   • plays  ≥ 500 000   (real reach — 500K views = certified viral)
    //   • likes  ≥  20 000   (real engagement — 20K likes is consistent with
    //                         genuine virality regardless of view count, and
    //                         organically near-impossible to fake at scale)
    //   • shares ≥   5 000   (the strongest TikTok virality signal — a low-view
    //                         but heavily-shared video is still meaningful)
    //
    // Floor was raised 2026-05-05 from 50K plays / 1K likes / 200 shares.
    //
    // viralScore was previously a 4th OR-option (≥60 default) but it's the
    // sum of `log10` per metric — `10·log10(plays) + 12·log10(likes) +
    // 8·log10(comments) + 15·log10(shares) + 5·log10(followers)`. Any video
    // with ~200K plays alone gets viralScore = 100 (10·log10(200K) ≈ 53,
    // plus *anything* on the other axes pushes past 60). That made the floor
    // a no-op — videos with 6K likes and 100 shares slipped through because
    // their 200K plays kept viralScore pinned at 100. Removed 2026-05-05.
    // viralScore is still computed for downstream signals; it just no longer
    // gates the floor.
    //
    // CJK-script videos get a harder bar — Apify's TikTok firehose drags in
    // regional virality that meets the default floor but never crosses into a
    // global narrative.
    //   • Chinese (zh): 4× plays/likes/shares
    //   • Japanese (ja) / Korean (ko): 2× plays/likes/shares
    const cjkScript = _detectCjkScript(desc);
    const cjkMult   = cjkScript === 'zh' ? 4 : cjkScript ? 2 : 1;
    const playsBar  = 500_000 * cjkMult;
    const likesBar  =  20_000 * cjkMult;
    const sharesBar =   5_000 * cjkMult;
    const meetsBar  = plays  >= playsBar
                   || likes  >= likesBar
                   || shares >= sharesBar;
    if (!meetsBar) return null;

    // Drop obvious compilations / aggregator videos — they have no narrative
    // arc and pollute the feed with "Top 10 funny X" and "X minutes of Y" type
    // listicles. Cheap regex pre-filter, runs before any expensive enrichment.
    if (COMPILATION_RE.test(desc)) {
      return null;
    }

    // createTime is UNIX seconds in clockworks; apidojo uses `uploadedAt`
    // (also seconds). Both formats handled identically.
    const createdUnix = video.createTime || video.uploadedAt || null;
    const createdAt = createdUnix ? new Date(createdUnix * 1000) : null;
    const ageHours  = createdAt
      ? (Date.now() - createdAt.getTime()) / 3_600_000
      : 0;

    const title = this._buildTitle(desc, hashtags, tickers, sourceHashtag);

    // Cover image — apidojo nests media in `video.{cover,thumbnail}`,
    // clockworks scatters at top level (originCoverUrl/covers[]/dynamicCover).
    const thumbnailUrl = video.originCoverUrl
      || video.covers?.[0]
      || (typeof video.covers === 'object' && video.covers && (video.covers.default || video.covers.origin))
      || video.cover
      || video.dynamicCover
      || video.shareCover?.[0]
      || video.imageUrl
      || video.video?.cover           // apidojo
      || video.video?.thumbnail       // apidojo
      || null;

    // Video URL — for native-video processing in Stage 0 Gemini-captioner
    // (mirrors what twitter.js does with its mp4 picker). Field-name variations:
    //   apidojo:    video.url  (signed CDN URL on tiktokcdn.com, ~6h TTL,
    //                           gated by Referer: https://www.tiktok.com/
    //                           which gemini-captioner adds automatically)
    //   clockworks: only populated when shouldDownloadVideos=true (we keep
    //                that off to save credits) — for clockworks this is
    //                normally null and Gemini falls through to the cover.
    //
    // Skip music-only URLs: for some items apidojo populates fallback fields
    // with the soundtrack mp3 URL (`tiktokcdn.com/.../ies-music/...mp3`) instead
    // of the video stream. Without filtering, gemini-captioner downloads the
    // mp3 and refuses it on mime-sniff (buffer is ID3-tagged audio). Better to
    // skip here so we fall through to poster directly.
    const videoUrl = _firstNonAudioUrl([
      video.video?.url,                     // apidojo (NESTED — primary path)
      video.videoUrlNoWaterMark,
      typeof video.videoUrl === 'string' ? video.videoUrl : null,
      Array.isArray(video.mediaUrls) ? video.mediaUrls[0] : null,
      video.videoMeta?.downloadAddr,
      video.videoMeta?.playAddr,
    ]);

    return {
      externalId: `tiktok_${id || Buffer.from(desc.substring(0, 20)).toString('base64').substring(0, 10)}`,
      source: 'tiktok',
      title,
      description: desc.substring(0, 300),
      url,
      metrics: {
        plays,
        likes,
        comments,
        shares,
        followers,
        engagementRate,
        viralScore,
        ageHours: Math.round(ageHours * 10) / 10,
        hashtags,
        tickers,
        author: `@${author}`,
        sourceHashtag,
        // upvotes-equivalent
        upvotes: likes + shares * 3,
        velocity: Math.round(plays / Math.max(ageHours, 1)), // plays/hour
        thumbnailUrl,
        videoUrl,
      },
    };
  }

  _buildTitle(desc, hashtags, tickers, sourceHashtag) {
    // Filter out generic crypto/tiktok hashtags
    const GENERIC = new Set(['#crypto', '#solana', '#nft', '#bitcoin', '#ethereum', '#fyp', '#foryou', '#viral', '#trending', '#memecoin', `#${sourceHashtag}`]);
    const uniqueHashtags = hashtags.filter(h => !GENERIC.has(h));

    if (tickers.length > 0 && uniqueHashtags.length > 0) {
      return `${tickers[0]} ${uniqueHashtags[0]} TikTok`;
    }
    if (tickers.length > 0) return `${tickers.join(' ')} TikTok trend`;
    if (uniqueHashtags.length > 0) return `#${sourceHashtag} ${uniqueHashtags[0]} TikTok`;

    return desc
      .replace(/https?:\/\/\S+/g, '')
      .replace(/#\w+|@\w+|\$\w+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100) || `TikTok #${sourceHashtag} trend`;
  }

  /**
   * Group videos by shared hashtag clusters — surfaces emerging hashtag trends.
   *
   * Cluster output represents ONE specific video (the "representative") whose
   * URL/author/thumbnail/metrics the user will see in the alert. The rep is
   * picked as the highest-scoring video in the cluster (plays + shares×1000 +
   * likes×10 — shares get the heaviest multiplier because they're the strongest
   * TikTok virality signal per platform calibration).
   *
   * Cluster-wide aggregates are emitted as SEPARATE fields (`clusterPlays`,
   * `clusterLikes`, `clusterShares`, `videoCount`) — never merged into the
   * displayed metrics. Earlier versions summed everything into `metrics.plays`
   * etc., but that caused alert/AI mismatches: the alert linked to a single
   * video with 6K likes while AI's whyNow text said "@user posted with 128K
   * likes" because the prompt got the cluster sum. Now what the user sees in
   * the alert link MUST match the metrics in the alert body.
   */
  _clusterByHashtag(videos) {
    const clusters = new Map();

    for (const video of videos) {
      const { hashtags = [], tickers = [], sourceHashtag } = video.metrics;
      const keys = [...tickers, ...hashtags.filter(h => h !== `#${sourceHashtag}`)].slice(0, 2);
      const clusterKey = keys.length > 0 ? keys[0] : `tiktok_${sourceHashtag}`;

      // Viral-weighted score for representative selection. Shares are
      // weighted heaviest — they're the strongest virality signal on TikTok
      // and the hardest to fake at scale. Plays are raw reach. Likes are
      // soft (autoplay-influenced).
      const score = (video.metrics.plays  || 0)
                  + (video.metrics.shares || 0) * 1000
                  + (video.metrics.likes  || 0) * 10;

      if (!clusters.has(clusterKey)) {
        clusters.set(clusterKey, {
          ...video,
          _count: 1,
          _repScore: score,
          _clusterPlays:  video.metrics.plays  || 0,
          _clusterLikes:  video.metrics.likes  || 0,
          _clusterShares: video.metrics.shares || 0,
        });
      } else {
        const c = clusters.get(clusterKey);
        c._count++;
        // Always accumulate cluster-wide totals (kept SEPARATE from the
        // representative's individual metrics — never merged into them).
        c._clusterPlays  += video.metrics.plays  || 0;
        c._clusterLikes  += video.metrics.likes  || 0;
        c._clusterShares += video.metrics.shares || 0;

        // Swap representative if this video scores higher. Replace ALL
        // identifying fields together so url + author + thumbnail + metrics
        // remain in sync (the rep IS the video the user clicks through to).
        if (score > c._repScore) {
          c._repScore     = score;
          c.url           = video.url;
          c.title         = video.title;
          c.description   = video.description;
          c.externalId    = video.externalId;
          c.metrics       = { ...video.metrics };
        }
      }
    }

    // No aggregate-floor re-check at this stage. Each video already passed
    // the individual floor in `_normalize` (500K plays OR 20K likes OR 5K
    // shares), so any cluster formed here has at least one bona-fide viral
    // video. The previous aggregate-floor was a safety-net from the era of
    // looser individual floors — became redundant when we tightened those,
    // and was actively harmful because it encouraged summing into the
    // representative's metrics.
    return Array.from(clusters.values()).map(cluster => ({
      ...cluster,
      metrics: {
        ...cluster.metrics,
        // Cluster-wide context — distinct from rep's individual metrics
        // above. Prompts.js renders these on a separate line so the AI
        // doesn't conflate cluster totals with the rep video's stats.
        videoCount:    cluster._count,
        clusterPlays:  cluster._clusterPlays,
        clusterLikes:  cluster._clusterLikes,
        clusterShares: cluster._clusterShares,
        // velocity is preserved from rep's `_normalize` (= rep's plays/hour).
        // Earlier code overwrote it with `cluster._count`, which displayed
        // "↑4/hr" meaning "4 videos in cluster" — confusing. Removed.
      },
    }));
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  normalize(item) {
    return item; // already normalized in _normalize()
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Filter out music/audio URLs from a list of candidate video URLs and return
 * the first non-audio one. apidojo fallback fields sometimes carry the TikTok
 * soundtrack URL (mp3 on `*-music*.tiktokcdn.com`) instead of the video MP4 —
 * we skip those so Gemini-captioner falls through to poster cleanly.
 */
function _firstNonAudioUrl(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const u of candidates) {
    if (!u || typeof u !== 'string') continue;
    if (/\/ies-music|-music[-.]|\.mp3(\?|$)/i.test(u)) continue;
    return u;
  }
  return null;
}

/**
 * Detect dominant CJK script in a description.
 *
 * Returns 'zh' (Han only), 'ja' (any kana), 'ko' (any hangul), or null.
 * ≥30 % of Unicode letters must be CJK to register at all.
 *
 * Used by `_normalize` to scale the engagement floor by script:
 * Chinese gets 4×, Japanese/Korean get 2×, everyone else 1×.
 */
function _detectCjkScript(text) {
  if (!text) return null;
  const kanaRe   = /[぀-ゟ゠-ヿ]/g;          // Hiragana + Katakana — Japanese
  const hangulRe = /[가-힯]/g;                 // Hangul Syllables — Korean
  const hanRe    = /[㐀-䶿一-鿿]/g;           // CJK Ext-A + Unified — shared

  const kanaCount   = (text.match(kanaRe)   || []).length;
  const hangulCount = (text.match(hangulRe) || []).length;
  const hanCount    = (text.match(hanRe)    || []).length;
  const cjkCount    = kanaCount + hangulCount + hanCount;
  if (cjkCount === 0) return null;

  const letterMatches = text.match(/\p{L}/gu);
  const letters = letterMatches ? letterMatches.length : 0;
  if (letters === 0) return null;
  if ((cjkCount / letters) < 0.30) return null;

  if (kanaCount > 0)   return 'ja';
  if (hangulCount > 0) return 'ko';
  return 'zh';
}

export default TikTokCollector;
