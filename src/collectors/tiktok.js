import BaseCollector from './base-collector.js';

/**
 * TikTok collector — uses Apify's TikTok scraper to surface viral content.
 *
 * Strategy:
 *  - Searches TikTok by hashtag (crypto/meme focused)
 *  - Extracts high-view videos and their hashtags as potential meme signals
 *  - Clusters by hashtag to surface emerging narratives
 */

const ACTOR_ID = 'clockworks~tiktok-scraper';
const MAX_VIDEOS_PER_TAG = 15;
const TIMEOUT_SECS = 120;

// Hashtags per preset — pick 2 per cycle, rotated
const PRESET_HASHTAGS = {
  general:  ['memecoin', 'solana', 'cryptomeme', 'degenlife', 'memetoken', 'solanameme', 'cryptohumor'],
  animals:  ['catcoin', 'dogcoin', 'pepecoin', 'animalmeme', 'memecoin', 'solanameme', 'cryptoanimals'],
  ai:       ['aicoin', 'aitoken', 'aiagent', 'artificialintelligence', 'cryptoai', 'memecoin', 'solana'],
  elon:     ['dogecoin', 'elonmusk', 'doge', 'memecoin', 'crypto', 'shibainu', 'eloncoin'],
  sports:   ['sportscrypto', 'fantoken', 'nflcrypto', 'nbacrypto', 'memecoin', 'ufccrypto', 'sportstoken'],
};

class TikTokCollector extends BaseCollector {
  constructor(config, logger, db) {
    super('TikTok', logger);
    this.enabled = config.tiktok?.enabled ?? false;
    this.apifyKeys = [config.apify?.apiKey, config.apify?.apiKey2].filter(Boolean);
    this._keyIndex = 0;
    this.customHashtags = config.tiktok?.hashtags || null;
    this.maxVideosPerTag = config.tiktok?.maxVideosPerTag || MAX_VIDEOS_PER_TAG;
    this.db = db;

    if (this.enabled && this.apifyKeys.length === 0) {
      this.logger.warn('[TikTok] enabled=true but APIFY_API not set — disabling');
      this.enabled = false;
    }
  }

  _getHashtags() {
    if (this.customHashtags) return this.customHashtags;
    const preset = this.db?.getSetting('activePreset', 'general') || 'general';
    return PRESET_HASHTAGS[preset] || PRESET_HASHTAGS.general;
  }

  _nextKey() {
    const key = this.apifyKeys[this._keyIndex % this.apifyKeys.length];
    this._keyIndex++;
    return key;
  }

  async collect() {
    if (!this.enabled) return [];

    const allVideos = [];

    // Pick 2 hashtags per cycle to conserve Apify credits
    const tagsThisCycle = this._pickHashtags();

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

  _pickHashtags() {
    const hashtags = this._getHashtags();
    const cycleSize = 2;
    const start = (this._keyIndex * cycleSize) % hashtags.length;
    const picked = [];
    for (let i = 0; i < cycleSize; i++) {
      picked.push(hashtags[(start + i) % hashtags.length]);
    }
    return picked;
  }

  async _fetchHashtag(hashtag) {
    const apiKey = this._nextKey();
    const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apiKey}&timeout=${TIMEOUT_SECS}`;

    const input = {
      hashtags: [hashtag],
      resultsPerPage: this.maxVideosPerTag,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
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

    const videos = await response.json();
    if (!Array.isArray(videos)) return [];

    return videos.map(v => this._normalize(v, hashtag)).filter(Boolean);
  }

  _normalize(video, sourceHashtag) {
    if (!video) return null;

    const id   = video.id || video.webVideoUrl?.split('/').pop() || null;
    const desc = video.text || video.desc || video.description || '';
    if (!desc && !id) return null;

    const plays     = video.playCount     || video.views          || 0;
    const likes     = video.diggCount     || video.likeCount      || 0;
    const comments  = video.commentCount  || 0;
    const shares    = video.shareCount    || 0;
    const author    = video.authorMeta?.name || video.author?.uniqueId || 'unknown';
    const followers = video.authorMeta?.fans || video.author?.fans || 0;

    const url = video.webVideoUrl || (id ? `https://www.tiktok.com/@${author}/video/${id}` : '');

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

    // Minimum engagement bar — must meet at least ONE condition to be worth analysing:
    //   ≥ 50 000 plays   (basic reach on TikTok)
    //   ≥ 1 000 likes    (people actively liked it)
    //   ≥ 200  shares    (the real virality signal on TikTok)
    //   viralScore ≥ 40  (composite — catches influencer posts with big follower counts)
    const meetsBar = plays >= 50_000 || likes >= 1_000 || shares >= 200 || viralScore >= 40;
    if (!meetsBar) return null;

    const createdAt = video.createTime ? new Date(video.createTime * 1000) : null;
    const ageHours  = createdAt
      ? (Date.now() - createdAt.getTime()) / 3_600_000
      : 0;

    const title = this._buildTitle(desc, hashtags, tickers, sourceHashtag);

    // Cover image — TikTok API provides multiple thumbnail candidates
    const thumbnailUrl = video.originCoverUrl
      || video.covers?.[0]
      || video.cover
      || video.dynamicCover
      || video.shareCover?.[0]
      || null;

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
   * Group videos by shared hashtag clusters — surfaces emerging hashtag trends
   */
  _clusterByHashtag(videos) {
    const clusters = new Map();

    for (const video of videos) {
      const { hashtags = [], tickers = [], sourceHashtag } = video.metrics;
      const keys = [...tickers, ...hashtags.filter(h => h !== `#${sourceHashtag}`)].slice(0, 2);
      const clusterKey = keys.length > 0 ? keys[0] : `tiktok_${sourceHashtag}`;

      if (!clusters.has(clusterKey)) {
        clusters.set(clusterKey, { ...video, _count: 1 });
      } else {
        const c = clusters.get(clusterKey);
        c._count++;
        c.metrics.plays    = (c.metrics.plays    || 0) + (video.metrics.plays    || 0);
        c.metrics.likes    = (c.metrics.likes    || 0) + (video.metrics.likes    || 0);
        c.metrics.shares   = (c.metrics.shares   || 0) + (video.metrics.shares   || 0);
        c.metrics.upvotes  = (c.metrics.upvotes  || 0) + (video.metrics.upvotes  || 0);
        // Keep the highest-plays video URL
        if ((video.metrics.plays || 0) > (c.metrics.plays || 0)) {
          c.url = video.url;
        }
      }
    }

    return Array.from(clusters.values())
      // Drop clusters that still don't meet the bar after aggregation
      .filter(c =>
        (c.metrics.plays  || 0) >= 50_000 ||
        (c.metrics.likes  || 0) >= 1_000  ||
        (c.metrics.shares || 0) >= 200
      )
      .map(cluster => ({
        ...cluster,
        metrics: {
          ...cluster.metrics,
          videoCount: cluster._count,
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

export default TikTokCollector;
