/**
 * Twitter/X On-Demand Checker — uses Apify's Twitter Scraper actor
 * Called on user request (button click), NOT automatically on every scan.
 *
 * Features:
 *  - In-memory per-trend cache (TTL 60 min) — second click on the same trend
 *    reuses the result without hitting Apify again
 *  - Bilateral fallback — if the active actor fails, automatically try the
 *    other one (kaitoeasyapi ↔ xquik). Logs the fallback
 *  - Concentration signal — percentage of total engagement driven by the top-1
 *    author (catches single-account virality vs genuine narrative)
 */

// NOTE on MAX_TWEETS: this is passed as `maxItems` to the Apify actor, but
// actors like `kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest`
// treat it as a soft hint and return a full X search page (~20 results for
// queryType: 'Top') regardless. We pay per returned result, so we align our
// request with reality (20) instead of pretending it's 5. `_summarize()`
// does no client-side trimming — whatever the actor returns is counted.
// If you need fewer tweets (to cut Apify cost), also add `tweets.slice(0, N)`
// in `_summarize` — the actor won't respect a lower cap.
const MAX_TWEETS = 20;
const TIMEOUT_SECS = 60;
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes — aligned with the refresh-button cooldown

// Mirror of the main collector's actor registry. Kept in-sync manually —
// when you add an actor here, also add it in src/collectors/twitter.js.
const ACTORS = {
  kaitoeasyapi: {
    id: 'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest',
    // Use searchTerms[] — see comment in twitter.js ACTORS for the why.
    buildInput: (query, maxItems) => ({
      searchTerms: [query], maxItems, queryType: 'Top',
    }),
  },
  xquik: {
    id: 'xquik~x-tweet-scraper',
    buildInput: (query, maxItems) => ({
      searchTerms: [query], maxItems, queryType: 'Top', includeSearchTerms: false,
    }),
  },
};
const DEFAULT_ACTOR = 'kaitoeasyapi';
const ACTOR_NAMES = Object.keys(ACTORS);

// Used by buildQuery() to detect proper-name phrases. Works cross-script
// (Unicode-aware) because toUpperCase/toLowerCase differ only for letters.
function _isCapitalized(tok) {
  if (!tok) return false;
  const first = tok[0];
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

// Minimal EN+RU stopword set used only by the buildQuery fallback slicer.
// Not exhaustive — we just need enough to stop "the squirrel" / "это закон"
// from eating the 3-token slot and leaving the actual topic out. Proper-name
// detection (priority 2) handles most real cases before we get here.
const STOPWORDS = new Set([
  // English
  'the','and','for','are','but','not','with','from','this','that',
  'have','has','had','was','were','been','will','into','than','over',
  'your','just','what','when','who','how','why','its','our','her',
  'him','his','she','they','them','said','can','all','you','one',
  'two','new','now','out','get','got','use','may','say','about',
  // Russian
  'как','это','или','уже','чтобы','если','для','при','так','тоже',
  'только','есть','был','была','было','были','будет','чем','что','кто',
  'без','над','под','про','между','после','через','весь','вся','все',
]);

class TwitterChecker {
  constructor(config, logger, db = null) {
    this.twitterKeys = config?.apify?.twitterKeys || {};
    this.logger = logger;
    this.db = db;
    this.enabled = Object.values(this.twitterKeys).some(Boolean);

    // Per-trend cache: Map<trendId, { at: ms, query, result }>
    // Lives in-memory only — warm restart forfeits cache, which is fine.
    this._cache = new Map();
  }

  _activeActor() {
    const chosen = (this.db?.getSetting('twitterActor', DEFAULT_ACTOR) || DEFAULT_ACTOR).toLowerCase();
    const name = ACTORS[chosen] ? chosen : DEFAULT_ACTOR;
    return this._actorByName(name);
  }

  _actorByName(name) {
    const def = ACTORS[name] || ACTORS[DEFAULT_ACTOR];
    const key = this.twitterKeys[name] || '';
    return { name, def, key };
  }

  /** Returns the "other" actor — used as automatic fallback when primary fails. */
  _fallbackActor(activeName) {
    const other = ACTOR_NAMES.find(n => n !== activeName) || null;
    return other ? this._actorByName(other) : null;
  }

  /**
   * Search Twitter for a given narrative keyword query.
   * @param {string} query
   * @param {{ trendId?: number, forceFresh?: boolean }} [opts]
   * @returns {Promise<Object|null>} summarized result, or null if no tweets
   *
   * Returned result extras (beyond raw engagement):
   *  - actorUsed: 'kaitoeasyapi' | 'xquik'  (which actor produced the data)
   *  - fellBack:  boolean                    (true if primary failed, fallback succeeded)
   *  - fromCache: boolean                    (true if served from in-memory cache)
   *  - cachedAt:  ms timestamp               (when fresh fetch happened; present on both fresh & cached)
   *  - concentration: 0-100                  (% of engagement from top-1 author)
   *  - topAuthor: string | null
   *  - uniqueAuthors: number
   */
  async searchNarrative(query, opts = {}) {
    if (!this.enabled) {
      throw new Error('Apify API key not configured (APIFY_API_KAITO / APIFY_API_XQUIK missing from .env)');
    }
    const { trendId = null, forceFresh = false } = opts;

    // Cache hit — bypass Apify entirely
    if (trendId != null && !forceFresh) {
      const cached = this._cache.get(trendId);
      if (cached && (Date.now() - cached.at) < CACHE_TTL_MS && cached.query === query) {
        this.logger.info(`[Twitter/X] Cache hit for trend #${trendId} (age=${Math.round((Date.now() - cached.at) / 1000)}s)`);
        return { ...cached.result, fromCache: true, cachedAt: cached.at };
      }
    }

    const active = this._activeActor();
    const fallback = this._fallbackActor(active.name);

    let result = null;
    let usedName = active.name;
    let fellBack = false;
    let primaryError = null;

    // Primary attempt
    if (active.key) {
      try {
        this.logger.info(`[Twitter/X] Searching via '${active.name}' for: "${query}"`);
        result = await this._runActor(active, query);
      } catch (err) {
        primaryError = err;
        this.logger.warn(`[Twitter/X] Primary actor '${active.name}' failed: ${err.message}`);
      }
    } else {
      primaryError = new Error(`[Twitter/X] No API key configured for actor '${active.name}'`);
      this.logger.warn(primaryError.message);
    }

    // Fallback attempt (only if primary failed or returned nothing)
    if (!result && fallback && fallback.key && fallback.name !== active.name) {
      try {
        this.logger.info(`[Twitter/X] Falling back to '${fallback.name}' for: "${query}"`);
        result = await this._runActor(fallback, query);
        if (result) {
          usedName = fallback.name;
          fellBack = true;
        }
      } catch (err) {
        this.logger.warn(`[Twitter/X] Fallback actor '${fallback.name}' also failed: ${err.message}`);
        // Re-throw the ORIGINAL primary error so the user sees what they
        // actually hit first. Fallback details are in the logs.
        if (primaryError) throw primaryError;
        throw err;
      }
    }

    if (!result) {
      if (primaryError) throw primaryError;
      return null;
    }

    result.actorUsed = usedName;
    result.fellBack = fellBack;
    result.fromCache = false;
    result.cachedAt = Date.now();

    if (trendId != null) {
      this._cache.set(trendId, { at: Date.now(), query, result });
    }

    return result;
  }

  /** How old the cached result for a given trend is, in ms. null = no cache. */
  cacheAgeMs(trendId) {
    const cached = this._cache.get(trendId);
    if (!cached) return null;
    return Date.now() - cached.at;
  }

  /** Internal: hit a specific actor once. Returns summarized result or null. */
  async _runActor({ name, def, key }, query) {
    if (!key) throw new Error(`[Twitter/X] No API key for actor '${name}'`);
    // Authorization: Bearer instead of ?token= so a network-error
    // err.message can never leak the API key (see tiktok.js for rationale).
    const runUrl = `https://api.apify.com/v2/acts/${def.id}/run-sync-get-dataset-items?timeout=${TIMEOUT_SECS}`;
    const input = def.buildInput(query, MAX_TWEETS);

    const response = await fetch(runUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Apify error ${response.status}: ${err.substring(0, 200)}`);
    }

    const tweets = await response.json();
    if (!Array.isArray(tweets) || tweets.length === 0) return null;

    return this._summarize(tweets);
  }

  _summarize(tweets) {
    let totalViews = 0;
    let totalLikes = 0;
    let totalRetweets = 0;
    let totalReplies = 0;

    const accounts = [];
    // engagement per author (likes + RT*2) — used for concentration signal.
    const byAuthor = new Map();

    for (const t of tweets) {
      const views   = t.viewCount    || t.viewsCount      || 0;
      const likes   = t.likeCount    || t.favoriteCount   || 0;
      const rts     = t.retweetCount || t.retweet_count   || 0;
      const replies = t.replyCount   || t.reply_count     || 0;

      totalViews    += views;
      totalLikes    += likes;
      totalRetweets += rts;
      totalReplies  += replies;

      const user = t.author?.userName || t.user?.screen_name || t.userName;
      if (user) {
        const engagement = likes + rts * 2;
        byAuthor.set(user, (byAuthor.get(user) || 0) + engagement);
        if (accounts.length < 5 && !accounts.includes(`@${user}`)) {
          accounts.push(`@${user}`);
        }
      }
    }

    // Concentration: 0-100 percentage of total engagement driven by the top-1
    // author. High values (>70) mean "one big account carrying the entire buzz"
    // — astroturf signal. Low values (<30) mean genuinely distributed chatter.
    let concentration = 0;
    let topAuthor = null;
    if (byAuthor.size > 0) {
      const sorted = [...byAuthor.entries()].sort((a, b) => b[1] - a[1]);
      const totalEng = sorted.reduce((s, [, v]) => s + v, 0);
      if (totalEng > 0) {
        topAuthor = sorted[0][0];
        concentration = Math.round((sorted[0][1] / totalEng) * 100);
      }
    }

    // Virality score: each component has its own budget that tops out at a
    // realistic "this is actually viral" ceiling. See commit message for the
    // full formula discussion.
    //
    // Budgets (sum = 100):
    //   tweetCount : 20 pts  (full at 20 tweets — the X search page size)
    //   views      : 30 pts  (full at 10M views)
    //   likes      : 25 pts  (full at 1M likes)
    //   retweets   : 25 pts  (full at 500K retweets)
    const capped = (value, ceiling, budget) => {
      if (value <= 0) return 0;
      const raw = (Math.log10(value + 1) / Math.log10(ceiling + 1)) * budget;
      return Math.max(0, Math.min(budget, raw));
    };
    const viralityScore = Math.round(
      capped(tweets.length, 20,         20) +
      capped(totalViews,    10_000_000, 30) +
      capped(totalLikes,    1_000_000,  25) +
      capped(totalRetweets, 500_000,    25)
    );

    return {
      tweetCount: tweets.length,
      totalViews,
      totalLikes,
      totalRetweets,
      totalReplies,
      viralityScore,
      accounts,
      concentration,   // 0-100
      topAuthor,       // string | null
      uniqueAuthors: byAuthor.size,
    };
  }

  /**
   * Build a search query for the Apify Twitter scraper.
   *
   * Priority ladder (most specific first):
   *   1. `subjectName` from Stage 2 xSearchData — a named entity Grok already
   *      identified as the hook (Peanut, Moo Deng, Hawk Tuah). Ticker-shaped
   *      names ("$BONK") are skipped deliberately: user opted out of
   *      ticker-driven search because it returns trader spam, not narrative.
   *   2. Longest run of consecutive Capitalized words in the title — covers
   *      proper-name phrases (Elon Musk, Hawk Tuah). 2+ words → quoted phrase
   *      so X treats it as AND, not OR. Single cap word (≥3 chars) → bare.
   *   3. Stopword-filtered fallback: up to 3 meaningful words; first two are
   *      quoted as a bigram to keep phrase cohesion, 3rd bare for reach.
   *
   * No zero-results fallback — if the quoted form returns nothing, we show
   * the empty state and let the user refine or retry. Adding a second Apify
   * call per miss doubles cost on the worst cases without clearly helping.
   *
   * @param {string} title             Trend's original_title or title
   * @param {Object} [opts]
   * @param {string} [opts.subjectName] Named entity from xSearchData
   * @returns {string}
   */
  static buildQuery(title, opts = {}) {
    const { subjectName = null } = opts;

    // ── Priority 1: Stage 2 subjectName ────────────────────────────────────
    if (subjectName) {
      const s = String(subjectName).trim();
      const isTicker = /^\$[A-Za-z]{2,10}$/.test(s);
      if (!isTicker && s.length >= 2) {
        const cleaned = s
          .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleaned.length >= 2) {
          return cleaned.includes(' ') ? `"${cleaned}"` : cleaned;
        }
      }
    }

    if (!title) return '';

    // Normalize: drop punctuation X doesn't need, keep apostrophes + hyphens
    // so "O'Brien" and "state-of-the-art" survive as single tokens.
    const clean = title
      .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return '';

    const tokens = clean.split(' ').filter(Boolean);

    // ── Priority 2: proper-name phrase (run of Capitalized tokens) ─────────
    const runs = [];
    let cur = [];
    for (const tok of tokens) {
      if (_isCapitalized(tok)) {
        cur.push(tok);
      } else {
        if (cur.length) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length) runs.push(cur);

    const longestRun = runs.sort((a, b) => b.length - a.length)[0] || [];
    if (longestRun.length >= 2) {
      return `"${longestRun.slice(0, 4).join(' ')}"`;
    }
    if (longestRun.length === 1 && longestRun[0].length >= 3) {
      return longestRun[0];
    }

    // ── Priority 3: stopword-filtered fallback ─────────────────────────────
    const pick = tokens
      .filter(w => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
      .slice(0, 3);

    if (pick.length >= 2) {
      const bigram = `"${pick[0]} ${pick[1]}"`;
      return pick[2] ? `${bigram} ${pick[2]}` : bigram;
    }
    if (pick.length === 1) return pick[0];

    // Worst case — no meaningful words after filtering. Return the original
    // naive slice so we still send something rather than an empty query.
    return tokens.filter(w => w.length > 2).slice(0, 3).join(' ');
  }

  /**
   * Build a user-facing X.com search URL for the same query.
   * Used for the "🔗 Поиск в X" button on the result message.
   */
  static searchUrl(query) {
    if (!query) return 'https://x.com/explore';
    return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`;
  }
}

export default TwitterChecker;
