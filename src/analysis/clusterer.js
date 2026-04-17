// [MARKET_STAGE] optional import — safe to remove along with market-stage.js
import { detectMarketSignals, resolveMarketStage } from './market-stage.js';

// [JUNK_FILTER] optional import — remove this line + base.junkPenalty block to disable
import { calculateJunkPenalty } from './junk-filter.js';

/**
 * NarrativeClusterer — pre-AI signal quality layer
 *
 * Position in pipeline: Aggregator → Clusterer → Scorer
 *
 * Groups similar raw items into narrative clusters, computes cluster-level
 * metrics (including EmergenceScore), and makes routing decisions without
 * any LLM calls.
 *
 * Routing outcomes:
 *   priority  — strong multi-platform signal (emergenceScore >= 65) → AI first
 *   stage1    — worthwhile signal (emergenceScore >= 20) → AI scoring
 *   save_only — weak but not noise → saved to DB, no AI scoring
 *   drop      — stale spam → discarded
 *
 * EmergenceScore (0–100) — measures HOW MUCH a narrative is spreading:
 *   • Platform spread (0–30):  spans multiple platforms = real organic spread
 *   • Velocity       (0–25):  mentions/hour = acceleration signal
 *   • Organic spread (0–20):  batchSize × textVariation (punishes copypaste)
 *   • Novelty stage  (0–15):  fresh = early entry, repeat = developing
 *   • Author diversity(0–10): many voices = organic, one voice = shill
 */
class NarrativeClusterer {
  constructor(db, logger) {
    this.db     = db;
    this.logger = logger;

    // ── Clustering params ────────────────────────────────────────────────
    this.JACCARD_THRESHOLD = 0.40; // word-set overlap to merge into one cluster
    this.MIN_WORDS         = 3;    // titles with fewer meaningful words → singleton

    // ── DB lookback ──────────────────────────────────────────────────────
    this.DB_WINDOW_HOURS = 48;

    // [MARKET_STAGE] feature flag — set MARKET_STAGE_DETECTION=1 to enable
    this._marketStageEnabled = process.env.MARKET_STAGE_DETECTION === '1';
    if (this._marketStageEnabled) {
      this.logger.info('[Clusterer] Market stage detection ENABLED');
    }

    // ── Routing thresholds ───────────────────────────────────────────────
    this.DROP_DB_MIN          = 8;   // seen N+ times recently
    this.DROP_VELOCITY_MAX    = 0.15;
    this.DROP_EMERGENCE_MAX   = 20;
    this.SAVE_EMERGENCE_MAX   = 15;
    this.SAVE_ENGAGEMENT_MAX  = 200;
    this.PRIORITY_EMERGENCE   = 65;  // emergenceScore >= this → priority lane
    this.STAGE1_EMERGENCE     = 20;  // emergenceScore >= this → AI scoring
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Route items to different pipeline lanes.
   * @param {Array} items — output of aggregator.process() (already DB-filtered)
   * @returns {{ priority: Array, toScore: Array, toSave: Array, droppedCount: number }}
   */
  route(items) {
    if (items.length === 0) {
      return { priority: [], toScore: [], toSave: [], droppedCount: 0 };
    }

    const clusters = this._clusterByJaccard(items);
    this.logger.info(`[Clusterer] ${items.length} items → ${clusters.length} clusters`);

    const priority = [];
    const toScore  = [];
    const toSave   = [];
    let droppedCount = 0;

    for (const cluster of clusters) {
      const history  = this._fetchHistory(cluster.representative.title);
      const metrics  = this._computeMetrics(cluster, history);

      // [MARKET_STAGE] optional enrichment — remove block + import to disable
      if (this._marketStageEnabled) {
        try {
          const signals        = detectMarketSignals(cluster.items);
          metrics.marketStage  = resolveMarketStage(signals);
          metrics.marketSignals = signals; // kept in clusterMetrics for debugging
        } catch (e) {
          metrics.marketStage = 'none'; // never crash the pipeline
        }
      }

      const decision = this._decide(metrics);

      // Attach cluster context so scorer can use emergenceScore + phase
      cluster.representative.clusterMetrics = metrics;

      if (decision === 'drop') {
        droppedCount++;
        this.logger.debug(
          `[Clusterer] DROP "${cluster.representative.title.substring(0, 50)}" ` +
          `(emergence=${metrics.emergenceScore} db=${metrics.dbRecentCount} vel=${metrics.velocity.toFixed(2)})`
        );
      } else if (decision === 'save_only') {
        toSave.push(cluster.representative);
      } else if (decision === 'priority') {
        priority.push(cluster.representative);
      } else {
        toScore.push(cluster.representative);
      }
    }

    this.logger.info(
      `[Clusterer] → priority=${priority.length} score=${toScore.length} ` +
      `save=${toSave.length} drop=${droppedCount}`
    );

    return { priority, toScore, toSave, droppedCount };
  }

  // ── Clustering ────────────────────────────────────────────────────────────

  _clusterByJaccard(items) {
    const clusters = [];
    const assigned = new Set();

    for (let i = 0; i < items.length; i++) {
      if (assigned.has(i)) continue;

      const wordsI  = this._wordSet(items[i].title);
      const cluster = { items: [items[i]], representative: items[i] };
      assigned.add(i);

      // Only try to merge if title has enough meaningful words
      if (wordsI.size >= this.MIN_WORDS) {
        for (let j = i + 1; j < items.length; j++) {
          if (assigned.has(j)) continue;
          const wordsJ = this._wordSet(items[j].title);
          if (wordsJ.size >= this.MIN_WORDS && this._jaccard(wordsI, wordsJ) >= this.JACCARD_THRESHOLD) {
            cluster.items.push(items[j]);
            assigned.add(j);
          }
        }
      }

      // Best representative = highest engagement (will lead the batch to AI)
      cluster.representative = cluster.items.reduce((best, item) =>
        this._engScore(item) >= this._engScore(best) ? item : best
      );

      clusters.push(cluster);
    }

    return clusters;
  }

  _wordSet(title) {
    return new Set(
      title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .split(/\s+/)
        .filter(w => w.length > 2)
    );
  }

  _jaccard(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
  }

  _engScore(item) {
    const m = item.metrics || {};
    return (m.engagement || 0) + (m.upvotes || 0) + (m.likes || 0) + (m.views || 0) / 100;
  }

  // ── DB history ────────────────────────────────────────────────────────────

  /**
   * Fetch recent DB appearances of this narrative (last 48h).
   * Uses first 2–3 significant words as a LIKE key.
   */
  _fetchHistory(title) {
    const words = [...this._wordSet(title)].slice(0, 3);
    if (words.length < 2) return [];

    const pattern = '%' + words.slice(0, 2).join('%').substring(0, 35) + '%';
    const cutoff  = new Date(Date.now() - this.DB_WINDOW_HOURS * 3_600_000).toISOString();

    try {
      return this.db.db.prepare(`
        SELECT source, first_seen_at
        FROM   trends
        WHERE  LOWER(title) LIKE ?
          AND  first_seen_at > ?
        LIMIT  30
      `).all(pattern.toLowerCase(), cutoff);
    } catch (e) {
      this.logger.debug(`[Clusterer] DB history error: ${e.message}`);
      return [];
    }
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  _computeMetrics(cluster, history) {
    const items = cluster.items;

    // Batch-level
    const batchSize      = items.length;
    const batchPlatforms = new Set(items.map(i => i.source));
    const batchAuthors   = new Set(items.map(i => i.externalId)).size;

    // Text variation: ratio of distinct word-sets to cluster size.
    // High variation = people rephrase = organic spread of a real narrative.
    const uniqueWordSets = new Set(items.map(i => [...this._wordSet(i.title)].sort().join(' ')));
    const textVariation  = batchSize > 1 ? uniqueWordSets.size / batchSize : 0;

    // DB history
    const dbRecentCount  = history.length;
    const dbPlatforms    = new Set(history.map(r => r.source));
    const uniquePlatforms = new Set([...batchPlatforms, ...dbPlatforms]).size;
    const isNovel        = dbRecentCount === 0;

    // Velocity: DB appearances per hour since first seen
    let velocity = 0;
    if (history.length >= 2) {
      const oldest = Math.min(...history.map(r => new Date(r.first_seen_at).getTime()));
      const hoursElapsed = Math.max(1, (Date.now() - oldest) / 3_600_000);
      velocity = dbRecentCount / hoursElapsed;
    }

    const maxEngagement = Math.max(...items.map(i => this._engScore(i)));

    const base = {
      batchSize,
      uniquePlatforms,
      batchAuthors,
      textVariation,
      dbRecentCount,
      isNovel,
      velocity,
      maxEngagement,
    };

    // EmergenceScore computed last (needs the above metrics + raw items for breakout)
    base.emergenceScore = this._computeEmergenceScore(base, items);

    // isEarlyIdea: Reddit post gaining traction, not yet spread across platforms
    // Used downstream to soften the alert gate for early signals
    const maxUpvotes = items.reduce((max, i) => {
      const m = i.metrics || {};
      return Math.max(max, m.upvotes || 0, m.score || 0);
    }, 0);
    base.isEarlyIdea = base.emergenceScore >= 20
                    && base.emergenceScore < 50
                    && maxUpvotes >= 10_000;

    // [JUNK_FILTER] heuristic junk penalty — remove block + import above to disable
    try {
      const { junkPenalty, junkReasons } = calculateJunkPenalty(items, base);
      base.junkPenalty  = junkPenalty;
      base.junkReasons  = junkReasons;
    } catch (_) {
      base.junkPenalty = 0;
      base.junkReasons = [];
    }

    return base;
  }

  // ── EmergenceScore ────────────────────────────────────────────────────────

  /**
   * Compute EmergenceScore (0–100): how much this narrative is actually emerging.
   *
   * Three independent paths, final score = Math.max(spread, breakout) + ideaBoost:
   *
   * Spread-based (multi-post / multi-platform clusters):
   *   Platform spread (0–30)
   *   Velocity        (0–25)
   *   Organic spread  (0–20)
   *   Novelty stage   (0–15)
   *   Author diversity(0–10)
   *
   * Breakout-based (single extremely viral post):
   *   Views / Plays    (0–35)
   *   Likes / Upvotes  (0–30)
   *   Retweets / Shares(0–20)
   *   Engagement rate  (0–15)
   *
   * IdeaBoost (Reddit early-idea signal, additive, 0–12):
   *   Upvote tiers: >=10k→+5, >=15k→+8, >=30k→+10, >=60k→+12
   *   Applied on top of max(spread, breakout), capped at 100.
   *
   * @param {object} m       — cluster-level metrics (spread signals)
   * @param {Array}  items   — raw cluster items (for breakout + ideaBoost signals)
   */
  _computeEmergenceScore(m, items = []) {
    // ── Path 1: spread-based ──────────────────────────────────────────────
    let spreadScore = 0;

    // Platform spread (0–30)
    spreadScore += m.uniquePlatforms >= 3 ? 30
                 : m.uniquePlatforms === 2 ? 16
                 : 0;

    // Velocity (0–25)
    spreadScore += m.velocity > 2.0 ? 25
                 : m.velocity > 1.0 ? 18
                 : m.velocity > 0.5 ? 12
                 : m.velocity > 0.2 ? 6
                 : 0;

    // Organic spread (0–20)
    spreadScore += Math.min(Math.round(Math.min(m.batchSize, 10) * m.textVariation * 2), 20);

    // Novelty stage (0–15)
    spreadScore += m.isNovel            ? 15
                 : m.dbRecentCount <= 3 ? 10
                 : m.dbRecentCount <= 8 ? 5
                 : 2;

    // Author diversity (0–10)
    spreadScore += m.batchAuthors >= 5 ? 10
                 : m.batchAuthors >= 3 ? 7
                 : m.batchAuthors >= 2 ? 4
                 : 0;

    // ── Path 2: breakout-based ────────────────────────────────────────────
    const breakoutScore = items.length > 0 ? this._computeBreakoutScore(items) : 0;

    // ── Path 3: early-idea boost (Reddit upvotes, additive, 0–12) ─────────
    const ideaBoost = items.length > 0 ? this._computeIdeaBoost(items) : 0;

    // Best of spread/breakout, then add idea boost, cap at 100
    return Math.min(Math.max(spreadScore, breakoutScore) + ideaBoost, 100);
  }

  /**
   * IdeaBoost — Reddit early-idea signal.
   *
   * Rewards posts that are gaining real traction on Reddit (high upvotes)
   * even if they haven't yet spread to other platforms.
   * Additive on top of spread/breakout — keeps Reddit from dominating
   * but ensures early ideas aren't silently dropped.
   *
   * To remove: delete this method + remove the ideaBoost lines in
   * _computeEmergenceScore and _computeMetrics (isEarlyIdea).
   *
   * @param {Array} items — raw cluster items
   * @returns {number} boost 0–12
   */
  _computeIdeaBoost(items) {
    let maxUpvotes = 0;

    for (const item of items) {
      const m = item.metrics || {};
      // Reddit: upvotes field; also check score (some adapters use it)
      const u = Math.max(m.upvotes || 0, m.score || 0);
      if (u > maxUpvotes) maxUpvotes = u;
    }

    return maxUpvotes >= 60_000 ? 12
         : maxUpvotes >= 30_000 ? 10
         : maxUpvotes >= 15_000 ? 8
         : maxUpvotes >= 10_000 ? 5
         : 0;
  }

  /**
   * Breakout-based emergence: detects a single extremely viral post without
   * requiring cluster spread. Works across Twitter/X, TikTok, and Reddit.
   *
   * Score components (max 100):
   *   Views / Plays    (0–35): primary intensity signal
   *   Likes / Upvotes  (0–30): absolute engagement volume
   *   Retweets / Shares(0–20): amplification signal
   *   Engagement rate  (0–15): relative virality (account-size-agnostic)
   *
   * To remove: delete this method + revert _computeEmergenceScore signature
   * to (m) and remove the breakoutScore + Math.max lines.
   */
  _computeBreakoutScore(items) {
    let maxViews          = 0;
    let maxLikes          = 0;
    let maxRetweets       = 0;
    let maxEngagementRate = 0;
    let maxUpvotes        = 0;
    let maxPlays          = 0;
    let maxShares         = 0;

    // Track followers of the item that drives peak views (primary signal).
    // Used by _normalizeBreakoutByFollowers to dampen mega-account routine posts.
    let peakFollowers     = 0;

    for (const item of items) {
      const m = item.metrics || {};

      // Primary peak: views (Twitter) — capture followers of this item
      if ((m.views || 0) > maxViews) {
        maxViews      = m.views;
        peakFollowers = m.followers || peakFollowers;
      }
      // TikTok plays treated equally with views
      if ((m.plays || 0) > maxPlays) {
        maxPlays      = m.plays;
        peakFollowers = m.followers || peakFollowers;
      }
      // Fallback: if no views/plays recorded, use likes item as peak source
      if ((m.likes || 0) > maxLikes) {
        maxLikes = m.likes;
        if (!peakFollowers) peakFollowers = m.followers || 0;
      }

      if ((m.retweets       || 0) > maxRetweets)       maxRetweets       = m.retweets;
      if ((m.engagementRate || 0) > maxEngagementRate) maxEngagementRate = m.engagementRate;
      if ((m.upvotes        || 0) > maxUpvotes)        maxUpvotes        = m.upvotes;
      if ((m.shares         || 0) > maxShares)         maxShares         = m.shares;
    }

    let score = 0;

    // Views — Twitter primary; TikTok plays as fallback (0–35)
    const views = Math.max(maxViews, maxPlays);
    score += views > 5_000_000 ? 35
           : views > 1_000_000 ? 28
           : views >   500_000 ? 22
           : views >   100_000 ? 15
           : views >    10_000 ? 8
           : 0;

    // Likes — Twitter; Reddit upvotes as fallback (0–30)
    const likes = Math.max(maxLikes, maxUpvotes);
    score += likes > 100_000 ? 30
           : likes >  50_000 ? 24
           : likes >  10_000 ? 18
           : likes >   1_000 ? 10
           : likes >     500 ? 5
           : 0;

    // Retweets / shares — amplification signal (0–20)
    const shares = Math.max(maxRetweets, maxShares);
    score += shares > 10_000 ? 20
           : shares >  1_000 ? 14
           : shares >    100 ? 8
           : shares >     20 ? 3
           : 0;

    // Engagement rate — relative virality, account-size-agnostic (0–15)
    score += maxEngagementRate > 10  ? 15
           : maxEngagementRate > 5   ? 12
           : maxEngagementRate > 2   ? 8
           : maxEngagementRate > 0.5 ? 4
           : 0;

    const raw = Math.min(score, 100);

    // Dampen for mega-account routine posts (see _normalizeBreakoutByFollowers)
    return this._normalizeBreakoutByFollowers(raw, peakFollowers, maxEngagementRate);
  }

  /**
   * Follower-aware breakout dampening.
   *
   * Large accounts have a permanently inflated absolute engagement baseline.
   * A post with 1M views from a 100M-follower account is "normal" for them —
   * not a narrative breakout. We reduce the score proportionally, but
   * restore it if the engagement RATE is genuinely high (real viral content).
   *
   * Dampening is applied ONLY to the breakout component; spread and ideaBoost
   * are unaffected.
   *
   * To disable: replace `return this._normalizeBreakoutByFollowers(...)` with
   * `return raw;` in _computeBreakoutScore.
   *
   * @param {number} score          — raw breakout score (0–100)
   * @param {number} followers      — follower count of the peak-views item
   * @param {number} engagementRate — engagement rate % (likes/followers*100)
   * @returns {number} dampened score (0–100)
   */
  _normalizeBreakoutByFollowers(score, followers, engagementRate) {
    // No follower data → no dampening (can't tell account size)
    if (!followers || followers < 100_000) return score;

    // High engagement rate = genuinely viral content regardless of account size
    // Even Elon at 5%+ engagement = the content itself is doing something unusual
    if (engagementRate >= 5) return score;
    if (engagementRate >= 2) return Math.round(score * 0.85); // slight damp

    // Low-rate post from large account: apply followers-based multiplier
    const factor = followers > 50_000_000 ? 0.40  // e.g. Elon — strong damp
                 : followers > 10_000_000 ? 0.55  // e.g. large influencer
                 : followers >  1_000_000 ? 0.72  // mid-tier celeb
                 : 1.0;                            // < 1M — no damp

    return Math.round(score * factor);
  }

  // ── Routing decision ──────────────────────────────────────────────────────

  /**
   * Route based on emergenceScore + stale-detection safeguard.
   *
   * Key change vs old logic: high dbRecentCount alone does NOT trigger drop.
   * A narrative appearing repeatedly CAN be a genuine spreading signal —
   * we only drop if emergence is also weak (no growth, no new platforms).
   */
  _decide(m) {
    const e = m.emergenceScore;

    // DROP — stale noise: seen many times but NOT growing (no new platforms, velocity flat)
    if (
      m.dbRecentCount >= this.DROP_DB_MIN &&
      e < this.DROP_EMERGENCE_MAX &&
      m.velocity < this.DROP_VELOCITY_MAX &&
      m.uniquePlatforms <= 1
    ) {
      return 'drop';
    }

    // SAVE_ONLY — very weak emergence + very low engagement
    if (e < this.SAVE_EMERGENCE_MAX && m.maxEngagement < this.SAVE_ENGAGEMENT_MAX) {
      return 'save_only';
    }

    // PRIORITY — strong spreading signal, process first in AI batch
    if (e >= this.PRIORITY_EMERGENCE) return 'priority';

    // STAGE1 — worthwhile signal, send to AI
    if (e >= this.STAGE1_EMERGENCE)   return 'stage1';

    // Fallback: send to AI — better to over-score than miss a trend
    // (Variant A: emergence only drops true noise, AI adoption score decides quality)
    return 'stage1';
  }
}

export default NarrativeClusterer;
