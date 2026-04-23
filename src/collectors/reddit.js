import BaseCollector from './base-collector.js';

/**
 * Reddit collector — uses Reddit JSON API (no auth needed with proper User-Agent)
 *
 * Strategy:
 *  - Per active preset (see PRESET_SUBREDDITS below) fetches hot listings from
 *    a curated list of meme-shape-friendly subreddits
 *  - Filters by minimum upvotes (5 000) to surface truly viral content
 *  - NICHE_SUBS (crypto) get a lowered bar (1 000) — only triggers when a user
 *    manually overrides subreddits via env, since crypto subs are no longer in
 *    any default preset
 */

const MIN_UPVOTES       = 5_000;
const NICHE_MIN_UPVOTES = 1_000;
const NICHE_SUBS = new Set(['cryptocurrency', 'cryptomoonshots', 'solana', 'memecoins', 'defi', 'wallstreetbets', 'dogecoin', 'pepecoin', 'shib', 'AICoins']);

// Subreddits per preset — tailored to the active meta.
// Keys MUST match filter-profiles.js PRESET_KEYS (general/animals/culture/celebrities/events).
// Picked for MEME-SHAPE signal (viral, visual, absurd, wholesome) rather than
// crypto-native chat. Crypto subs are intentionally NOT here — they're mostly
// price-chat / shill noise; we want the original meme energy that degens then
// latch onto. You can still force crypto subs via env override (config.reddit.subreddits).
const PRESET_SUBREDDITS = {
  // 🌐 General — broad viral net: aggregators + "interesting" subs
  general: [
    'all', 'popular', 'interestingasfuck', 'Damnthatsinteresting',
    'nextfuckinglevel', 'BeAmazed',
  ],

  // 🐾 Animals — viral pets, wildlife, cute/funny creatures
  animals: [
    'aww', 'AnimalsBeingDerps', 'AnimalsBeingBros', 'AnimalsBeingJerks',
    'NatureIsFuckingLit', 'Eyebleach', 'rarepuppers', 'capybara',
  ],

  // 🎭 Culture — memes, internet humor, viral moments
  culture: [
    'memes', 'dankmemes', 'Unexpected', 'facepalm', 'TikTokCringe',
    'OutOfTheLoop', 'KnowYourMeme', 'therewasanattempt',
  ],

  // ⭐ Celebrities — pop culture, celeb drama, entertainment
  celebrities: [
    'popculturechat', 'Fauxmoi', 'entertainment', 'movies', 'television',
    'popheads', 'hiphopheads',
  ],

  // 🌍 Events — world events, tech, space, uplifting news
  events: [
    'worldnews', 'news', 'UpliftingNews', 'technology', 'space',
    'Futurology', 'science',
  ],
};

class RedditCollector extends BaseCollector {
  constructor(config, logger, db) {
    super('Reddit', logger);
    this.customSubs  = config.reddit.subreddits?.length ? config.reddit.subreddits : null;
    this.minUpvotes  = config.reddit.minUpvotes  || MIN_UPVOTES;
    this.postsPerSub = config.reddit.postsPerSubreddit || 50;
    this.db = db;
  }

  _getSubreddits() {
    if (this.customSubs) return this.customSubs;
    const preset = this.db?.getSetting('activePreset', 'general') || 'general';
    return PRESET_SUBREDDITS[preset] || PRESET_SUBREDDITS.general;
  }

  async collect() {
    const allItems = [];
    const subreddits = this._getSubreddits();

    for (const subreddit of subreddits) {
      try {
        const items = await this._fetchJSON(subreddit);
        allItems.push(...items);
        await this._delay(1500);
      } catch (error) {
        this.logger.warn(`[Reddit] Failed to fetch r/${subreddit}: ${error.message}`);
      }
    }

    // Deduplicate by post ID
    const seen = new Set();
    return allItems.filter(item => {
      if (seen.has(item.externalId)) return false;
      seen.add(item.externalId);
      return true;
    });
  }

  async _fetchJSON(subreddit) {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${this.postsPerSub}&raw_json=1`;

    const response = await fetch(url, {
      headers: {
        // Reddit blocks non-browser UAs — mimic Chrome
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });

    if (response.status === 403 || response.status === 429) {
      this.logger.warn(`[Reddit] JSON API blocked for r/${subreddit} (${response.status}) — falling back to RSS`);
      return this._fetchRSSFallback(subreddit);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const posts = data?.data?.children || [];

    return posts
      .map(child => this._normalize(child.data, subreddit))
      .filter(Boolean);
  }

  /**
   * RSS fallback — no upvote counts, but filters by freshness (< 6h) and uses
   * position-on-page as a proxy for popularity. Only keeps recent posts from
   * high-quality subreddits to reduce noise.
   */
  async _fetchRSSFallback(subreddit) {
    const url = `https://www.reddit.com/r/${subreddit}/hot/.rss?limit=50`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/atom+xml, text/xml, */*',
      },
    });
    if (!response.ok) throw new Error(`RSS fallback failed: HTTP ${response.status}`);

    const text = await response.text();
    const items = this._parseAtomFeed(text);

    // RSS has no scores — only keep very fresh top-page posts as a rough proxy
    return items.filter(item => (item.metrics.ageHours || 99) < 6);
  }

  _parseAtomFeed(xml) {
    const items = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    let position = 0;

    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1];
      const title     = this._extractTag(entry, 'title') || '';
      const id        = this._extractTag(entry, 'id') || '';
      const link      = this._extractAttr(entry, 'link', 'href') || '';
      const published = this._extractTag(entry, 'published') || '';
      const updated   = this._extractTag(entry, 'updated') || '';
      const category  = this._extractAttr(entry, 'category', 'label') || '';

      if (title.length < 5) continue;

      const publishedDate = new Date(published || updated);
      const ageHours = (Date.now() - publishedDate.getTime()) / 3_600_000;

      items.push({
        externalId: `reddit_${id.replace('t3_', '').replace(/.*\//, '')}`,
        source:     'reddit',
        title:      this._decodeHtml(title),
        description:'',
        url:        link,
        metrics: {
          upvotes:   0,           // unknown via RSS
          comments:  0,
          ageHours:  Math.round(ageHours * 10) / 10,
          velocity:  0,
          engagement:0,
          subreddit: category.replace('r/', ''),
          position:  position++,  // proxy: lower = more popular on page
        },
      });
    }
    return items;
  }

  _extractTag(xml, tag) {
    const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);
    return m ? m[1].trim() : null;
  }

  _extractAttr(xml, tag, attr) {
    const m = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/?>`, 'i').exec(xml);
    return m ? m[1] : null;
  }

  _decodeHtml(text) {
    return text
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
  }

  /**
   * Pick the best available image URL from a Reddit post.
   * Priority:
   *   1. Direct image post (.jpg/.png/.gif/.webp)
   *   2. Video/GIF preview thumbnail at source resolution
   *   3. Reddit preview at source resolution (full-quality)
   *   4. First image from a gallery (source resolution)
   *   5. Low-res thumbnail (last resort — 140×140, what was used before the fix)
   *
   * NB: reddit JSON is fetched with ?raw_json=1 so URLs are NOT HTML-escaped.
   */
  _bestImage(post) {
    if (!post) return null;

    // 1. Direct image link (i.redd.it, i.imgur.com, etc.)
    const directUrl = post.url_overridden_by_dest || post.url;
    if (directUrl && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(directUrl)) {
      return directUrl;
    }

    // 2. Preview source (full-quality preview that Reddit itself generates)
    const previewSrc = post.preview?.images?.[0]?.source?.url;
    if (previewSrc) return previewSrc;

    // 3. Video/GIF post — preview.reddit_video_preview or media.oembed.thumbnail
    const videoPreview = post.preview?.reddit_video_preview?.fallback_url;
    if (videoPreview) return videoPreview;
    const oembedThumb = post.media?.oembed?.thumbnail_url;
    if (oembedThumb) return oembedThumb;

    // 4. Galleries — first item's source URL
    if (post.is_gallery && post.media_metadata) {
      const firstId = post.gallery_data?.items?.[0]?.media_id;
      const item = firstId && post.media_metadata[firstId];
      const srcUrl = item?.s?.u || item?.s?.gif;
      if (srcUrl) return srcUrl;
    }

    // 5. Low-res thumbnail fallback
    if (post.thumbnail?.startsWith('http')) return post.thumbnail;
    return null;
  }

  /**
   * Pick a direct, Telegram-friendly MP4 URL for a Reddit video post.
   * Returns null if the post isn't video-y.
   *
   * Caveat: v.redd.it uses DASH, so `fallback_url` is VIDEO-ONLY (no audio).
   * Muxing would require FFmpeg — out of scope. We accept silent playback.
   */
  _bestVideo(post) {
    if (!post) return null;

    // 1. Native Reddit-hosted video (v.redd.it) — silent MP4
    const rv = post.media?.reddit_video || post.secure_media?.reddit_video;
    if (rv?.fallback_url) return rv.fallback_url.split('?')[0];

    // 2. Reddit's video preview (e.g. for cross-posted/gif-as-video content)
    const prev = post.preview?.reddit_video_preview;
    if (prev?.fallback_url) return prev.fallback_url.split('?')[0];

    // 3. Direct link — .mp4 / .webm
    const directUrl = post.url_overridden_by_dest || post.url || '';
    if (/\.(mp4|webm)(\?|$)/i.test(directUrl)) return directUrl;

    // 4. Imgur .gifv → swap to .mp4 (their HTML wrapper is not playable)
    if (/imgur\.com\/\w+\.gifv$/i.test(directUrl)) {
      return directUrl.replace(/\.gifv$/i, '.mp4');
    }

    // 5. oEmbed video (YouTube/Vimeo embeds aren't direct MP4 — skip)
    return null;
  }

  /**
   * Collect ALL image URLs from a post — primarily for Reddit galleries.
   * Returns up to 10 URLs (Telegram media-group cap). Order preserved.
   * For single-image posts returns [bestImage] (array of 1).
   */
  _allImages(post) {
    if (!post) return [];
    const out = [];

    // Gallery: full order from gallery_data.items
    if (post.is_gallery && post.media_metadata && post.gallery_data?.items?.length) {
      for (const gi of post.gallery_data.items) {
        const item = post.media_metadata[gi.media_id];
        const url  = item?.s?.u || item?.s?.gif;
        if (url && !out.includes(url)) out.push(url);
        if (out.length >= 10) break;
      }
      if (out.length) return out;
    }

    // Non-gallery: fall back to best single image
    const best = this._bestImage(post);
    if (best) out.push(best);
    return out;
  }

  _normalize(post, requestedSub) {
    if (!post || !post.title) return null;

    const score    = post.score       || 0;   // upvotes (net)
    const comments = post.num_comments || 0;
    const upvoteRatio = post.upvote_ratio || 0;
    const sub      = post.subreddit    || requestedSub;
    const isNiche  = NICHE_SUBS.has(sub.toLowerCase());
    const minBar   = isNiche ? NICHE_MIN_UPVOTES : this.minUpvotes;

    // Hard filter — if it's not popular enough, skip entirely
    if (score < minBar) return null;

    // Also skip very controversial posts (ratio < 0.6) — usually drama, not memes
    if (upvoteRatio < 0.6 && score < 20_000) return null;

    const id          = post.id        || post.name;
    const title       = post.title     || '';
    const url         = post.url       || `https://reddit.com${post.permalink}`;
    const permalink   = `https://reddit.com${post.permalink}`;
    const createdUtc  = post.created_utc ? post.created_utc * 1000 : Date.now();
    const ageHours    = (Date.now() - createdUtc) / 3_600_000;

    // Engagement composite
    const engagement  = score + comments * 5;
    const velocity    = ageHours > 0 ? Math.round(score / ageHours) : score;

    // Skip very old posts (> 48h) — they're not trending anymore
    if (ageHours > 48) return null;

    return {
      externalId: `reddit_${id}`,
      source:     'reddit',
      title:      title,
      description: post.selftext?.substring(0, 300) || '',
      url:        permalink,
      metrics: {
        upvotes:     score,
        comments,
        upvoteRatio,
        ageHours:    Math.round(ageHours * 10) / 10,
        velocity,        // upvotes/hour — key virality signal
        engagement,
        subreddit:   sub,
        flair:       post.link_flair_text || '',
        imageUrl:    this._bestImage(post),
        imageUrls:   this._allImages(post),
        videoUrl:    this._bestVideo(post),
        // For scorer compatibility
        score,
      },
    };
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RedditCollector;
