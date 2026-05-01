import BaseCollector from './base-collector.js';
import { getActivePresetConfig } from '../analysis/preset-config.js';

/**
 * Twitter/X collector — uses Apify's tweet-scraper to find viral world trends.
 *
 * Strategy:
 *  - Runs broad high-engagement search queries per cycle (no specific topic keywords)
 *  - Uses ultra-common words (a, the, is, de, la…) + min_faves to capture ANY viral tweet
 *  - Themed presets (animals, culture, celebrities, events) narrow the focus when needed
 *  - Clusters tweets by hashtag/topic to surface emerging narratives
 */

const MAX_ITEMS = 20;
const TIMEOUT_SECS = 90;

// ── Actor registry ──────────────────────────────────────────────────────────
// Each entry is a pluggable Apify Twitter scraper. The active actor is picked
// at runtime from DB setting 'twitterActor' (admin-configurable without
// restart). Both current actors happen to return identical engagement fields
// (viewCount / likeCount / retweetCount), so _normalize stays actor-agnostic.
// Default is 'kaitoeasyapi' — the more mature one (20+ months, 17K users).
//
// To add a new actor: drop a new key here + its token in .env (APIFY_API_<X>),
// wire it into config.js → apify.twitterKeys, and add it to admin-side
// VALID_TWITTER_ACTORS. No changes needed elsewhere.
const ACTORS = {
  kaitoeasyapi: {
    id: 'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest',
    // Kaito accepts EITHER twitterContent (single string) OR searchTerms (array).
    // We use searchTerms — safer because `twitterContent: ""` triggers input
    // validation errors on some schema revisions. Empty lang field also
    // intermittently fails validation → only include it when non-empty.
    buildInput: (query, maxItems) => ({
      searchTerms: [query],
      maxItems,
      queryType: 'Top',
    }),
  },
  xquik: {
    id: 'xquik~x-tweet-scraper',
    buildInput: (query, maxItems) => ({
      searchTerms: [query],
      maxItems,
      queryType: 'Top',
      includeSearchTerms: false,
    }),
  },
};
const DEFAULT_ACTOR = 'kaitoeasyapi';

// ── Search presets ────────────────────────────────────────────────────────────
// Each preset = 6 queries. Per cycle we run 2 (rotated).
// Strategy: ultra-common words + high min_faves to catch ANY viral content.
// No lang filter — we want global trends from all languages.

const PRESET_QUERIES = {
  // Universal — catches any viral content worldwide via common words from multiple languages.
  //
  // Language coverage (one slot each unless noted):
  //   • EN          — 4 slots (articles/prepositions, wh-words, pronouns, demonstratives)
  //   • Romance+RU  — 1 slot  (ES/PT/FR particles + RU particles merged; RU trades
  //                            dedicated coverage for an extra EN slot)
  //   • CJK         — 1 slot  (JP + KR + ZH particles in a single OR clause).
  //                            JP is weighted slightly heavier (6 particles vs 3+3)
  //                            because JP Twitter is the most active non-EN market.
  general: [
    '(a OR the OR is OR to OR in) min_faves:10000 -is:retweet',
    '(de OR la OR el OR que OR en OR и OR я OR на OR не OR что) min_faves:10000 -is:retweet',
    '(when OR where OR why OR how OR who) min_faves:10000 -is:retweet',
    '(you OR me OR my OR we OR our) min_faves:10000 -is:retweet',
    '(this OR that OR it OR was OR has) min_faves:10000 -is:retweet',
    '(の OR は OR を OR が OR に OR で OR 이 OR 가 OR 는 OR 的 OR 是 OR 了) min_faves:10000 -is:retweet',
  ],

  // 🐾 Animals — viral pets, funny animals, cute creatures
  animals: [
    '(dog OR puppy OR doggo OR pupper) min_faves:10000 -is:retweet',
    '(cat OR kitten OR kitty OR meow) min_faves:10000 -is:retweet',
    '(animal OR pet OR cute OR adorable) min_faves:10000 -is:retweet',
    '(duck OR frog OR monkey OR bear OR hamster) min_faves:10000 -is:retweet',
    '(rescue OR adopt OR stray OR shelter) (dog OR cat OR animal) min_faves:5000 -is:retweet',
    '(funny OR hilarious OR silly) (dog OR cat OR animal OR pet) min_faves:5000 -is:retweet',
  ],

  // 🎭 Culture — memes, internet culture, slang, humor
  culture: [
    '(meme OR memes OR viral OR trend) min_faves:10000 -is:retweet',
    '(funny OR hilarious OR lmao OR lol OR bruh) min_faves:10000 -is:retweet',
    '(slay OR iconic OR based OR goated OR era) min_faves:10000 -is:retweet',
    '(insane OR crazy OR wild OR unhinged OR unreal) min_faves:10000 -is:retweet',
    '(cancel OR ratio OR timeline OR main character) min_faves:10000 -is:retweet',
    '(gen z OR millennial OR boomer OR tiktok OR trend) min_faves:10000 -is:retweet',
  ],

  // ⭐ Celebrities — famous people, viral moments, pop culture
  celebrities: [
    '(elon OR musk OR trump OR biden) min_faves:10000 -is:retweet',
    '(taylor OR beyonce OR drake OR kanye OR rihanna) min_faves:10000 -is:retweet',
    '(movie OR film OR series OR netflix OR disney) min_faves:10000 -is:retweet',
    '(album OR song OR music OR concert OR tour) min_faves:10000 -is:retweet',
    '(celebrity OR famous OR star OR interview OR paparazzi) min_faves:10000 -is:retweet',
    '(award OR grammy OR oscar OR golden globe) min_faves:10000 -is:retweet',
  ],

  // 🌍 Events — world events, sports, breaking news, happenings
  events: [
    '(breaking OR "breaking news" OR happening OR urgent OR alert) min_faves:10000 -is:retweet',
    '(NASA OR space OR mars OR moon OR launch OR rocket) min_faves:10000 -is:retweet',
    '(earthquake OR hurricane OR flood OR wildfire OR disaster) min_faves:5000 -is:retweet',
    '(championship OR final OR world cup OR super bowl OR olympics) min_faves:10000 -is:retweet',
    '(protest OR march OR rally OR movement OR strike) min_faves:10000 -is:retweet',
    '(AI OR ChatGPT OR robot OR artificial intelligence) min_faves:10000 -is:retweet',
  ],
};

class TwitterCollector extends BaseCollector {
  constructor(config, logger, db) {
    super('Twitter', logger);
    this.enabled = config.twitter?.enabled ?? false;
    this.twitterKeys = config.apify?.twitterKeys || {};
    this.customQueries = config.twitter?.queries || null; // manual override via .env
    this.maxItemsPerQuery = config.twitter?.maxItemsPerQuery || MAX_ITEMS;
    this.db = db;

    // Validate: at least one actor key must be present.
    const configuredActors = Object.entries(this.twitterKeys).filter(([, v]) => v).map(([k]) => k);
    if (this.enabled && configuredActors.length === 0) {
      this.logger.warn('[Twitter] enabled=true but no actor keys (APIFY_API_KAITO / APIFY_API_XQUIK) set — disabling');
      this.enabled = false;
    }
  }

  /**
   * Resolve the active actor definition + its API key.
   * Falls back to default if the configured actor has no key or is unknown.
   */
  _activeActor() {
    const chosen = (this.db?.getSetting('twitterActor', DEFAULT_ACTOR) || DEFAULT_ACTOR).toLowerCase();
    const def = ACTORS[chosen] || ACTORS[DEFAULT_ACTOR];
    const key = this.twitterKeys[chosen] || this.twitterKeys[DEFAULT_ACTOR] || '';
    const name = ACTORS[chosen] ? chosen : DEFAULT_ACTOR;
    return { name, def, key };
  }

  _getQueries() {
    if (this.customQueries) return this.customQueries; // .env override takes priority
    // Per-preset queries since 2026-05-01 (PR-2). Edited from admin "Пресеты"
    // tab. Falls back to defaults baked into preset-config.js if the preset's
    // sources.twitter.queries is missing (resolver always populates).
    let queries = [];
    try { queries = getActivePresetConfig(this.db).sources?.twitter?.queries || []; }
    catch (_) { queries = []; }
    return queries.length > 0 ? queries : (PRESET_QUERIES.general);
  }

  async collect() {
    if (!this.enabled) return [];

    const allTweets = [];

    // Run 2 queries per cycle (rotates through the list to save Apify credits)
    const queriesThisCycle = this._pickQueries();

    for (const query of queriesThisCycle) {
      try {
        const items = await this._searchQuery(query);
        allTweets.push(...items);
        await this._delay(2000);
      } catch (err) {
        this.logger.warn(`[Twitter] Query failed "${query.substring(0, 60)}": ${err.message}`);
      }
    }

    // Deduplicate by tweet id
    const seen = new Set();
    const unique = allTweets.filter(t => {
      if (seen.has(t.externalId)) return false;
      seen.add(t.externalId);
      return true;
    });

    // Group by topic / hashtag to avoid 20 micro-alerts for the same trend
    return this._clusterByTopic(unique);
  }

  /**
   * Pick 2 queries per cycle (rotates through the list over successive calls)
   */
  _pickQueries() {
    const queries = this._getQueries();
    const cycleSize = 2;
    this._cycleCounter = (this._cycleCounter || 0) + 1;
    const start = (this._cycleCounter * cycleSize) % queries.length;
    const picked = [];
    for (let i = 0; i < cycleSize; i++) {
      picked.push(queries[(start + i) % queries.length]);
    }
    return picked;
  }

  async _searchQuery(query) {
    const { name: actorName, def: actor, key: apiKey } = this._activeActor();
    if (!apiKey) {
      throw new Error(`[Twitter] No API key configured for actor '${actorName}'`);
    }
    const runUrl = `https://api.apify.com/v2/acts/${actor.id}/run-sync-get-dataset-items?token=${apiKey}&timeout=${TIMEOUT_SECS}`;

    // Per-actor input shape. Both return identical engagement fields.
    const input = actor.buildInput(query, this.maxItemsPerQuery);

    const response = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const err = await response.text();
      // Bump the log slice up — Apify's 400 responses carry nested JSON with
      // the actual validation reason beyond the first 200 chars.
      throw new Error(`Apify ${response.status} [${actorName}]: ${err.substring(0, 600)}`);
    }

    const tweets = await response.json();
    if (!Array.isArray(tweets)) return [];

    return tweets.map(t => this._normalize(t, query)).filter(Boolean);
  }

  _normalize(tweet, query) {
    if (!tweet) return null;

    const id   = tweet.id || tweet.tweet_id || tweet.rest_id;
    const text = tweet.text || tweet.full_text || tweet.rawContent || '';
    if (!text || text.length < 10) return null;

    const author    = tweet.author?.userName || tweet.author?.username || tweet.user?.screen_name || tweet.userName || tweet.username || 'unknown';
    const url       = id ? `https://twitter.com/${author}/status/${id}` : '';
    const views     = tweet.viewCount    || tweet.viewsCount      || 0;
    const likes     = tweet.likeCount    || tweet.favoriteCount   || 0;
    const retweets  = tweet.retweetCount || tweet.retweet_count   || 0;
    const replies   = tweet.replyCount   || tweet.reply_count     || 0;
    const followers = tweet.author?.followers || tweet.user?.followers_count || 0;

    // Extract hashtags
    const hashtagMatches = text.match(/#\w+/g) || [];
    const hashtags = [...new Set(hashtagMatches.map(h => h.toLowerCase()))];

    // Extract tickers (e.g. $BONK, $SOL)
    const tickerMatches = text.match(/\$[A-Z]{2,8}/g) || [];
    const tickers = [...new Set(tickerMatches)];

    // Virality score for filtering
    const engagement = likes + retweets * 3 + replies;
    const viralScore = Math.min(100, Math.round(
      (Math.log10(views + 1) * 8) +
      (Math.log10(likes + 1) * 12) +
      (Math.log10(retweets + 1) * 15) +
      (Math.log10(followers + 1) * 5)
    ));

    // Engagement rate: likes relative to follower count
    // High rate from small account = organic virality; low rate from big account = baseline noise
    const engagementRate = followers > 0 ? Math.round((likes / followers) * 10000) / 100 : 0; // percentage

    // Minimum engagement bar — must have real traction to be worth analysing.
    // Accepts a tweet if it meets ANY of these thresholds:
    //   ≥ 500  likes  (small viral)
    //   ≥ 100  retweets (shared, not just liked)
    //   ≥ 10 000 views (significant reach)
    //   viralScore ≥ 35 (composite signal)
    // Hard filter: 500K+ views required. If views unavailable — fallback to 10K+ likes.
    //
    // CJK-script tweets get a harder bar — the Apify firehose pulls in too
    // much low-signal Asian-language virality (idol fandom, regional memes,
    // news copypasta) that meets the global threshold but never converts into
    // a tradeable narrative on EN/global crypto twitter.
    //   • Chinese (zh): 4× — biggest source of noise, mostly mainland reposts
    //   • Japanese (ja) / Korean (ko): 2× — noisier than EN but more often
    //     genuinely on-trend (idol launches, anime/game IP)
    const cjkScript = _detectCjkScript(text);
    const cjkMult   = cjkScript === 'zh' ? 4 : cjkScript ? 2 : 1;
    const viewsBar  = 500_000 * cjkMult;
    const likesBar  = 10_000  * cjkMult;
    const meetsBar  = views > 0 ? views >= viewsBar : likes >= likesBar;
    if (!meetsBar) return null;

    const createdAt = tweet.created_at || tweet.createdAt || null;
    const ageHours  = createdAt
      ? (Date.now() - new Date(createdAt).getTime()) / 3_600_000
      : 0;

    // Drop stale tweets — default 72h, admin-configurable via 'twitterMaxAgeHours'.
    // 0 disables the filter. Only applies when the tweet has a createdAt.
    const maxAgeHours = Number(this.db?.getSetting('twitterMaxAgeHours', 72) ?? 72) || 0;
    if (createdAt && maxAgeHours > 0 && ageHours > maxAgeHours) return null;

    const title = this._buildTitle(text, hashtags, tickers);

    // Media — works for both photos and videos (preview frame)
    // Twitter API v2: tweet.media[].preview_image_url (videos) or .url (photos)
    // Legacy/Apify: tweet.entities.media[].media_url_https
    const mediaList = tweet.media?.length ? tweet.media
                    : (tweet.entities?.media || []);
    const pickUrl = (m) => {
      if (!m) return null;
      const isPhoto = m?.type === 'photo' || !m?.type;
      return isPhoto
        ? (m.media_url_https || m.url || m.media_url || m.preview_image_url || null)
        : (m.preview_image_url || m.media_url_https || m.url || m.media_url || null);
    };
    const upgrade = (u) => {
      if (!u || !/pbs\.twimg\.com\//.test(u)) return u;
      try {
        const url = new URL(u);
        url.searchParams.set('name', 'orig');
        if (!url.searchParams.get('format')) {
          const ext = url.pathname.match(/\.(jpe?g|png|webp)$/i)?.[1] || 'jpg';
          url.searchParams.set('format', ext.toLowerCase().replace('jpeg', 'jpg'));
        }
        return url.toString();
      } catch (_) { return u; }
    };
    // Helper: extract image URLs from a given media array into `imageUrls`.
    // Dedupes against existing entries; caps the final list at 10.
    const pushImagesFrom = (list) => {
      if (!Array.isArray(list)) return;
      for (const m of list) {
        const raw = pickUrl(m);
        const url = upgrade(raw);
        if (url && !imageUrls.includes(url)) imageUrls.push(url);
        if (imageUrls.length >= 10) break;
      }
    };

    // Helper: extract the best MP4 video URL from a media array.
    const pickVideoFrom = (list) => {
      if (!Array.isArray(list)) return null;
      for (const m of list) {
        const type = m?.type;
        if (type !== 'video' && type !== 'animated_gif') continue;
        const variants = m.video_info?.variants || m.variants || [];
        const mp4s = variants
          .filter(v => (v.content_type || v.contentType || '').includes('mp4') || /\.mp4(\?|$)/i.test(v.url || ''))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const best = mp4s[0]?.url;
        if (best) return best;
      }
      return null;
    };

    // All photo URLs (preserve order, dedupe); cap 10 for Telegram media group.
    // Order: (1) main tweet images, (2) quoted tweet images, (3) reply-parent
    // images. This keeps the tweet's own content primary while still surfacing
    // the referenced media — crucial for quote tweets where the "story" lives
    // entirely in the embedded card.
    const imageUrls = [];
    pushImagesFrom(mediaList);

    // Quoted tweet — multiple Apify/X API shapes. fxtwitter uses `quote`,
    // apidojo/kaitoeasy usually `quoted_tweet` / `quotedStatus`.
    const quoted = tweet.quote || tweet.quoted_tweet || tweet.quotedStatus
                 || tweet.quoted_status || tweet.retweeted_tweet || null;
    if (quoted) {
      const qMedia = quoted.media?.length ? quoted.media
                   : (quoted.entities?.media || quoted.media?.all || []);
      pushImagesFrom(qMedia);
    }

    // Reply-parent tweet — when the current tweet is itself a reply and the
    // parent carries the original content (e.g. a thread starter with the
    // screenshot). Less common in Apify payloads; fetched when exposed.
    const replyParent = tweet.in_reply_to_tweet || tweet.in_reply_to_status
                      || tweet.replying_to || null;
    if (replyParent) {
      const rMedia = replyParent.media?.length ? replyParent.media
                   : (replyParent.entities?.media || []);
      pushImagesFrom(rMedia);
    }

    const thumbnailUrl = imageUrls[0] || null;

    // Best video URL — main tweet first, then quoted/reply-parent as fallback.
    let videoUrl = pickVideoFrom(mediaList);
    if (!videoUrl && quoted) {
      const qMedia = quoted.media?.length ? quoted.media : (quoted.entities?.media || []);
      videoUrl = pickVideoFrom(qMedia);
    }
    if (!videoUrl && replyParent) {
      const rMedia = replyParent.media?.length ? replyParent.media : (replyParent.entities?.media || []);
      videoUrl = pickVideoFrom(rMedia);
    }

    return {
      externalId: `twitter_${id || Buffer.from(text.substring(0, 30)).toString('base64').substring(0, 12)}`,
      source: 'twitter',
      title,
      description: text.substring(0, 300),
      url,
      metrics: {
        views,
        likes,
        retweets,
        replies,
        followers,
        engagementRate,
        viralScore,
        ageHours: Math.round(ageHours * 10) / 10,
        hashtags,
        tickers,
        author: `@${author}`,
        searchQuery: query.substring(0, 60),
        thumbnailUrl,
        imageUrls,
        videoUrl,
      },
    };
  }

  /**
   * Build a clean trend title from tweet text
   */
  _buildTitle(text, hashtags, tickers) {
    // Filter out generic / noise hashtags — keep only meaningful ones
    const STOP_HASHTAGS = [
      '#fyp', '#foryou', '#foryoupage', '#viral', '#trending', '#trend',
      '#follow', '#like', '#retweet', '#rt', '#breaking', '#news',
    ];
    const meaningfulHashtags = hashtags.filter(h => !STOP_HASHTAGS.includes(h));

    if (meaningfulHashtags.length > 0 && tickers.length > 0) {
      return `${meaningfulHashtags[0]} ${tickers[0]}`;
    }
    if (meaningfulHashtags.length > 0) return meaningfulHashtags.slice(0, 2).join(' ');
    if (tickers.length > 0) return tickers.join(' ');

    // Fallback: clean first sentence
    return text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/#\w+|@\w+|\$\w+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100);
  }

  /**
   * Group individual tweets into cluster-level trend signals.
   * Returns one item per unique topic (hashtag cluster or ticker),
   * with aggregated engagement metrics.
   */
  _clusterByTopic(tweets) {
    const clusters = new Map();

    for (const tweet of tweets) {
      const { hashtags = [], tickers = [] } = tweet.metrics;
      const keys = [...tickers, ...hashtags].slice(0, 3);
      const clusterKey = keys.length > 0 ? keys[0] : tweet.title.substring(0, 30);

      // Per-tweet engagement velocity (likes/hour). Reused both for the
      // initial cluster seed and every merged tweet — we accumulate the sum
      // of rates so the cluster velocity reflects real-time traction across
      // all tweets, not just cluster size.
      const tweetEngagement = (tweet.metrics.likes || 0) + (tweet.metrics.retweets || 0) * 2;
      const tweetAge = Math.max(tweet.metrics.ageHours || 0, 0.25); // floor at 15min
      const tweetVelocity = tweetEngagement / tweetAge;

      if (!clusters.has(clusterKey)) {
        clusters.set(clusterKey, { ...tweet, _count: 1, _velocitySum: tweetVelocity });
      } else {
        const c = clusters.get(clusterKey);
        c._count++;
        c._velocitySum = (c._velocitySum || 0) + tweetVelocity;
        c.metrics.views    = (c.metrics.views    || 0) + (tweet.metrics.views    || 0);
        c.metrics.likes    = (c.metrics.likes    || 0) + (tweet.metrics.likes    || 0);
        c.metrics.retweets = (c.metrics.retweets || 0) + (tweet.metrics.retweets || 0);
        // Keep the best-performing tweet's URL
        if ((tweet.metrics.likes || 0) > (c.metrics.likes || 0)) {
          c.url = tweet.url;
        }
      }
    }

    return Array.from(clusters.values())
      // Drop clusters that still don't meet the bar after aggregation
      .filter(c =>
        (c.metrics.views || 0) > 0
          ? (c.metrics.views || 0) >= 500_000
          : (c.metrics.likes || 0) >= 10_000
      )
      .map(cluster => ({
        ...cluster,
        metrics: {
          ...cluster.metrics,
          tweetCount: cluster._count,
          // upvotes-equivalent for scorer
          upvotes: (cluster.metrics.likes || 0) + (cluster.metrics.retweets || 0) * 2,
          // Likes/hour — sum of per-tweet rates, mirrors Reddit's velocity
          velocity: Math.round(cluster._velocitySum || 0),
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
 * Detect dominant CJK script in a tweet.
 *
 * Returns one of: 'zh' (Chinese-only Han chars), 'ja' (any Hiragana/Katakana),
 * 'ko' (any Hangul), or null (not CJK-dominant).
 *
 * Logic:
 *  - Counts CJK characters across Han + Hiragana/Katakana + Hangul ranges.
 *  - Requires ≥30 % of all Unicode letters to be CJK — otherwise null.
 *  - Once CJK-dominant: presence of kana → 'ja', presence of hangul → 'ko',
 *    only Han ideographs → 'zh' (the Chinese case).
 *
 * Why script-specific detection: Chinese pulls 4× more low-signal virality
 * (regional news, idol gossip, copypasta) through Apify than ja/ko, so it
 * gets a stricter floor in `_normalize`.
 */
function _detectCjkScript(text) {
  if (!text) return null;
  // Hiragana (3040-309F) + Katakana (30A0-30FF) — Japanese-exclusive
  const kanaRe   = /[぀-ゟ゠-ヿ]/g;
  // Hangul Syllables (AC00-D7AF) — Korean-exclusive
  const hangulRe = /[가-힯]/g;
  // Han ideographs (CJK Ext-A 3400-4DBF + CJK Unified 4E00-9FFF) — shared
  const hanRe    = /[㐀-䶿一-鿿]/g;

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
  return 'zh'; // pure Han, no kana, no hangul
}

export default TwitterCollector;
