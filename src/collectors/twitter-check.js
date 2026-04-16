/**
 * Twitter/X On-Demand Checker — uses Apify's Twitter Scraper actor
 * Called on user request (button click), NOT automatically on every scan.
 */

const ACTOR_ID = 'apidojo~tweet-scraper';
const MAX_TWEETS = 5;
const TIMEOUT_SECS = 60;

class TwitterChecker {
  constructor(config, logger) {
    // Build list of available API keys for round-robin rotation
    const keys = [config?.apify?.apiKey, config?.apify?.apiKey2].filter(Boolean);
    this.apiKeys = keys;
    this._keyIndex = 0;
    this.logger = logger;
    this.enabled = keys.length > 0;
  }

  /** Returns the next API key in rotation */
  _nextKey() {
    const key = this.apiKeys[this._keyIndex % this.apiKeys.length];
    this._keyIndex++;
    return key;
  }

  /**
   * Search Twitter for a given narrative keyword query.
   * Returns a structured result object, or null on failure.
   */
  async searchNarrative(query) {
    if (!this.enabled) {
      throw new Error('Apify API key not configured (APIFY_API missing from .env)');
    }

    const apiKey = this._nextKey();
    this.logger.info(`[Twitter/X] Searching Apify for: "${query}" (key #${this._keyIndex})`);

    const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apiKey}&timeout=${TIMEOUT_SECS}`;

    const input = {
      searchTerms: [query],
      maxItems: MAX_TWEETS,
      queryType: 'Top',  // 'Top' = most viral/liked tweets, better for virality analysis
    };

    const response = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Apify error ${response.status}: ${err.substring(0, 200)}`);
    }

    const tweets = await response.json();
    if (!Array.isArray(tweets) || tweets.length === 0) return null;

    return this._summarize(tweets, query);
  }

  _summarize(tweets) {
    let totalViews = 0;
    let totalLikes = 0;
    let totalRetweets = 0;
    let totalReplies = 0;

    const accounts = [];

    for (const t of tweets) {
      totalViews    += t.viewCount    || t.viewsCount      || 0;
      totalLikes    += t.likeCount    || t.favoriteCount   || 0;
      totalRetweets += t.retweetCount || t.retweet_count   || 0;
      totalReplies  += t.replyCount   || t.reply_count     || 0;

      const user = t.author?.userName || t.user?.screen_name || t.userName;
      if (user && accounts.length < 5 && !accounts.includes(`@${user}`)) {
        accounts.push(`@${user}`);
      }
    }

    // Virality score: weighted log formula
    const viralityScore = Math.min(100, Math.round(
      (Math.log10(tweets.length + 1) * 15) +
      (Math.log10(totalViews + 1) * 10) +
      (Math.log10(totalLikes + 1) * 12) +
      (Math.log10(totalRetweets + 1) * 15)
    ));

    return {
      tweetCount: tweets.length,
      totalViews,
      totalLikes,
      totalRetweets,
      totalReplies,
      viralityScore,
      accounts,
    };
  }

  /**
   * Build a clean search query from narrative title
   */
  static buildQuery(title) {
    if (!title) return '';
    
    // Support Unicode (Russian, etc.) by using \p{L} (letters) and \p{N} (numbers)
    const words = title
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 3);

    return words.join(' ');
  }
}

export default TwitterChecker;
