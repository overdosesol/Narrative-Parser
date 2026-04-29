/**
 * PreStage — orchestrates Stage 0a (NanoClassifier text enrichment) and
 * Stage 0b (GeminiCaptioner visual enrichment) in parallel, then merges
 * the outputs into each trend at `trend.preStage`.
 *
 * Critical contract: PreStage NEVER drops, NEVER reorders, NEVER scores.
 * Input array length === output array length. If both sub-stages fail,
 * `trend.preStage = null` and the trend continues unchanged into Stage 1.
 *
 * Output shape (when at least one sub-stage succeeded):
 *   trend.preStage = {
 *     nano:   { topicSummary, entityCanonical, language, slangDecoded } | null,
 *     gemini: { visualCaption, visibleText, mood, mediaType, videoSummary,
 *               videoDurationSec, videoTruncated } | null,
 *     elapsedMs: number,
 *   }
 */

export class PreStage {
  constructor(logger, { nanoClassifier, geminiCaptioner } = {}) {
    this.logger = logger;
    this.nano = nanoClassifier || null;
    this.gemini = geminiCaptioner || null;
    this.enabled = !!(this.nano?.enabled || this.gemini?.enabled);
    // Runtime kill-switch — operator can toggle in admin without redeploy
    this._adminDisabled = false;
  }

  setEnabled(flag) { this._adminDisabled = !flag; }

  /**
   * Enrich an array of trends. Returns the SAME trends with `preStage` field
   * added. Mutates input in-place AND returns it for chaining convenience.
   */
  async enrichBatch(trends) {
    if (!Array.isArray(trends) || trends.length === 0) return trends;
    if (!this.enabled || this._adminDisabled) return trends;

    // Idempotency guard — if every trend already has the preStage field set
    // (even to null), assume someone upstream already ran this stage and skip.
    // This lets index.js (cycle pipeline) and scorer.scoreTrends (manual
    // submit fallback) both safely call enrichBatch without double-paying.
    const needsWork = trends.some(t => !('preStage' in t));
    if (!needsWork) {
      this.logger?.debug?.(`[PreStage] all ${trends.length} trends already enriched, skipping`);
      return trends;
    }

    const startedAt = Date.now();

    // Fan-out: nano gets the whole batch (it batches internally), gemini
    // runs per-trend with concurrency cap. Promise.all so both finish
    // before we move on to Stage 1.
    const [nanoResults, geminiResults] = await Promise.all([
      this.nano?.enabled
        ? this.nano.classifyBatch(trends).catch(e => {
            this.logger?.warn?.(`[PreStage] nano failed: ${e.message}`);
            return trends.map(() => null);
          })
        : Promise.resolve(trends.map(() => null)),
      this.gemini?.enabled
        ? this.gemini.captionBatch(trends).catch(e => {
            this.logger?.warn?.(`[PreStage] gemini failed: ${e.message}`);
            return trends.map(() => null);
          })
        : Promise.resolve(trends.map(() => null)),
    ]);

    const elapsedMs = Date.now() - startedAt;
    let nanoOk = 0, geminiOk = 0;

    for (let i = 0; i < trends.length; i++) {
      const nano = nanoResults[i] || null;
      const gemini = geminiResults[i] || null;
      if (nano) nanoOk++;
      if (gemini) geminiOk++;

      // Only attach preStage if at least one sub-stage produced data —
      // otherwise downstream code can rely on `trend.preStage == null`
      // meaning "no enrichment available, behave as before".
      if (nano || gemini) {
        trends[i].preStage = { nano, gemini, elapsedMs };
      } else {
        trends[i].preStage = null;
      }
    }

    this.logger?.info?.(
      `[PreStage] ${trends.length} trends in ${elapsedMs}ms ` +
      `(nano=${nanoOk}/${trends.length}, gemini=${geminiOk}/${trends.length})`
    );

    return trends;
  }
}

export default PreStage;
