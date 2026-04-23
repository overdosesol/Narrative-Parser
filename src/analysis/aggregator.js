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
   * 1. Deduplicate within the batch by identity (externalId / URL) only —
   *    titles are NOT used, so posts with similar wording survive and get
   *    grouped semantically by the clusterer downstream.
   * 2. Filter out trends already seen in DB.
   */
  process(allTrends) {
    this.logger.info(`Aggregator: processing ${allTrends.length} raw trends`);

    const deduped = this._deduplicateByIdentity(allTrends);
    this.logger.info(`After identity dedup: ${deduped.length} unique trends`);

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

  _deduplicateByIdentity(trends) {
    const seenIds = new Set();
    const seenUrls = new Set();
    const out = [];

    for (const trend of trends) {
      const idKey  = trend.externalId ? `${trend.source}:${trend.externalId}` : null;
      const urlKey = trend.url || null;

      if (idKey && seenIds.has(idKey))   continue;
      if (urlKey && seenUrls.has(urlKey)) continue;

      if (idKey)  seenIds.add(idKey);
      if (urlKey) seenUrls.add(urlKey);

      out.push({ ...trend, sources: [trend.source] });
    }

    return out;
  }
}

export default Aggregator;
