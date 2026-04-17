import BaseCollector from './base-collector.js';

/**
 * Twitter/X collector — uses Apify's tweet-scraper to find viral world trends.
 *
 * Strategy:
 *  - Runs broad high-engagement search queries per cycle (no specific topic keywords)
 *  - Uses ultra-common words (a, the, is, de, la…) + min_faves to capture ANY viral tweet
 *  - Themed presets (animals, culture, celebrities, events) narrow the focus when needed
 *  - Clusters tweets by hashtag/topic to surface emerging narratives
 */

const ACTOR_ID = 'apidojo~tweet-scraper';
const MAX_ITEMS = 20;
const TIMEOUT_SECS = 90;

// ── Search presets ────────────────────────────────────────────────────────────
// Each preset = 6 queries. Per cycle we run 2 (rotated).
// Strategy: ultra-common words + high min_faves to catch ANY viral content.
// No lang filter — we want global trends from all languages.

const PRESET_QUERIES = {
  // Universal — catches any viral content worldwide via common words from multiple languages
  general: [
    '(a OR the OR is OR to OR in) min_faves:10000 -is:retweet',
    '(de OR la OR el OR que OR en) min_faves:10000 -is:retweet',
    '(и OR я OR на OR не OR что) min_faves:10000 -is:retweet',
    '(you OR me OR my OR we OR our) min_faves:10000 -is:retweet',
    '(this OR that OR it OR was OR has) min_faves:10000 -is:retweet',
    '(just OR so OR but OR now OR all) min_faves:10000 -is:retweet',
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
    this.apifyKeys = [config.apify?.apiKey, config.apify?.apiKey2].filter(Boolean);
    this._keyIndex = 0;
    this.customQueries = config.twitter?.queries || null; // manual override via .env
    this.maxItemsPerQuery = config.twitter?.maxItemsPerQuery || MAX_ITEMS;
    this.db = db;

    if (this.enabled && this.apifyKeys.length === 0) {
      this.logger.warn('[Twitter] enabled=true but APIFY_API not set — disabling');
      this.enabled = false;
    }
  }

  _getQueries() {
    if (this.customQueries) return this.customQueries; // .env override takes priority
    const preset = this.db?.getSetting('activePreset', 'general') || 'general';
    const queries = PRESET_QUERIES[preset] || PRESET_QUERIES.general;
    return queries;
  }

  _nextKey() {
    const key = this.apifyKeys[this._keyIndex % this.apifyKeys.length];
    this._keyIndex++;
    return key;
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
   * Pick 2 queries per cycle (rotates through the list to balance Apify usage)
   */
  _pickQueries() {
    const queries = this._getQueries();
    const cycleSize = 2;
    const start = (this._keyIndex * cycleSize) % queries.length;
    const picked = [];
    for (let i = 0; i < cycleSize; i++) {
      picked.push(queries[(start + i) % queries.length]);
    }
    return picked;
  }

  async _searchQuery(query) {
    const apiKey = this._nextKey();
    const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apiKey}&timeout=${TIMEOUT_SECS}`;

    const input = {
      searchTerms: [query],
      maxItems: this.maxItemsPerQuery,
      queryType: 'Top',     // Top tweets sorted by engagement by Twitter itself
      addUserInfo: true,    // include follower counts for viralScore calculation
      minimumFavorites: 5000, // native Apify filter as safety net
    };

    const response = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Apify ${response.status}: ${err.substring(0, 200)}`);
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
    const meetsBar = views > 0 ? views >= 500_000 : likes >= 10_000;
    if (!meetsBar) return null;

    const createdAt = tweet.created_at || tweet.createdAt || null;
    const ageHours  = createdAt
      ? (Date.now() - new Date(createdAt).getTime()) / 3_600_000
      : 0;

    const title = this._buildTitle(text, hashtags, tickers);

    // Media thumbnail — works for both photos and videos (preview frame)
    // Twitter API v2: tweet.media[].preview_image_url (videos) or .url (photos)
    // Legacy/Apify: tweet.entities.media[].media_url_https
    const media = tweet.media?.[0] || tweet.entities?.media?.[0] || null;
    const thumbnailUrl = media?.preview_image_url
      || media?.url
      || media?.media_url_https
      || media?.media_url
      || null;

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

      if (!clusters.has(clusterKey)) {
        clusters.set(clusterKey, { ...tweet, _count: 1 });
      } else {
        const c = clusters.get(clusterKey);
        c._count++;
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
          velocity: cluster._count,
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

export default TwitterCollector;
