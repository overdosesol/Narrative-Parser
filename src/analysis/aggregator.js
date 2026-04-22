/**
 * Aggregator — deduplicates and merges trends from multiple sources
 */
class Aggregator {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Process raw collected trends:
   * 1. Deduplicate within the batch
   * 2. Filter out already-seen trends (from DB)
   * 3. Merge multi-source trends
   */
  process(allTrends) {
    this.logger.info(`Aggregator: processing ${allTrends.length} raw trends`);

    // Step 1: Deduplicate within batch by title similarity
    const deduped = this._deduplicateByTitle(allTrends);
    this.logger.info(`After dedup: ${deduped.length} unique trends`);

    // Step 2: Filter out trends already seen in DB by URL or ID (avoid matching English vs Russian titles)
    const newTrends = deduped.filter(trend => {
      const seen = this.db.isTrendSeen(trend.externalId, trend.title, trend.url, 12);
      if (seen) {
        this.logger.debug(`Skipping already-seen trend: ID/URL match for "${trend.title}"`);
      }
      return !seen;
    });

    this.logger.info(`After DB filter: ${newTrends.length} new trends`);
    return newTrends;
  }

  _deduplicateByTitle(trends) {
    const groups = new Map();

    for (const trend of trends) {
      const key = this._normalizeTitle(trend.title);
      if (groups.has(key)) {
        // Merge: keep the one with higher engagement
        const existing = groups.get(key);
        existing.sources = existing.sources || [existing.source];
        if (!existing.sources.includes(trend.source)) {
          existing.sources.push(trend.source);
        }
        // Multi-source bonus disabled — in practice it rewards news/politics
        // (which tend to hit every platform) and starves single-platform memes.
      } else {
        groups.set(key, { ...trend, sources: [trend.source] });
      }
    }

    return Array.from(groups.values());
  }

  _normalizeTitle(title) {
    return title
      .toLowerCase()
      // Keep all Unicode letters/digits (Latin, Cyrillic, CJK, Arabic, etc.)
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 80);
  }
}

export default Aggregator;
