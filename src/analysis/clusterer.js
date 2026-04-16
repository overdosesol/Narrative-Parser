/**
 * NarrativeClusterer — pre-AI signal quality layer
 *
 * Position in pipeline: Aggregator → Clusterer → Scorer
 *
 * Groups similar raw items into narrative clusters, computes cluster-level
 * metrics, and makes routing decisions without any LLM calls.
 *
 * Routing outcomes:
 *   priority  — strong multi-platform signal → sent to AI first in batch
 *   stage1    — normal → sent to AI
 *   save_only — weak but not noise → saved to DB, no AI scoring
 *   drop      — clear spam/stale → discarded
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

    // ── Routing thresholds ───────────────────────────────────────────────
    this.DROP_DB_MIN    = 8;  // seen N+ times recently, no new signals → drop
    this.PRIORITY_PLAT  = 2;  // spans N+ platforms → priority
    this.PRIORITY_POSTS = 5;  // N+ posts in batch cluster → priority
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
      const decision = this._decide(metrics);

      // Attach cluster context so AI scorer can see it
      cluster.representative.clusterMetrics = metrics;

      if (decision === 'drop') {
        droppedCount++;
        this.logger.debug(
          `[Clusterer] DROP "${cluster.representative.title.substring(0, 50)}" ` +
          `(db=${metrics.dbRecentCount} vel=${metrics.velocity.toFixed(2)} plat=${metrics.uniquePlatforms})`
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
        .filter(w => w.length > 2) // skip stopword-length tokens
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
   * Uses first 2–3 significant words as a LIKE key — fast enough for our volumes.
   */
  _fetchHistory(title) {
    const words = [...this._wordSet(title)].slice(0, 3);
    if (words.length < 2) return [];

    // Build LIKE pattern from words: "%word1%word2%"
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
    const batchAuthors   = new Set(items.map(i => i.externalId)).size; // each externalId = unique post

    // Text variation: ratio of distinct word-sets to cluster size.
    // High variation (people rephrase) = organic spread of a real narrative.
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

    return {
      batchSize,
      uniquePlatforms,
      batchAuthors,
      textVariation,
      dbRecentCount,
      isNovel,
      velocity,
      maxEngagement,
    };
  }

  // ── Routing decision ──────────────────────────────────────────────────────

  _decide(m) {
    // DROP: stale narrative — seen many times, no new platforms, velocity flat, low engagement.
    // This filters out perpetual low-grade noise that keeps re-appearing.
    if (
      m.dbRecentCount >= this.DROP_DB_MIN &&
      m.uniquePlatforms <= 1 &&
      m.velocity < 0.15 &&
      m.maxEngagement < 5000
    ) {
      return 'drop';
    }

    // PRIORITY: strong cross-platform or high-density batch signal.
    // These are the "this is actually spreading" signals — send to AI first.
    if (
      m.uniquePlatforms >= this.PRIORITY_PLAT ||
      m.batchSize >= this.PRIORITY_POSTS ||
      (m.batchAuthors >= 4 && m.textVariation > 0.5)
    ) {
      return 'priority';
    }

    // STAGE1: novel trend with real engagement, growing velocity, or multi-post cluster.
    if (m.isNovel && m.maxEngagement > 500) return 'stage1';
    if (m.velocity > 0.3)                   return 'stage1';
    if (m.batchSize >= 2)                   return 'stage1';

    // SAVE_ONLY: some signal but not enough to spend an LLM call on.
    return 'save_only';
  }
}

export default NarrativeClusterer;
