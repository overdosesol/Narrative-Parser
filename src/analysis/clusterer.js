// [MARKET_STAGE] optional import — safe to remove along with market-stage.js
import { detectMarketSignals, resolveMarketStage } from './market-stage.js';

// [JUNK_FILTER] optional import — remove this line + base.junkPenalty block to disable
import { calculateJunkPenalty } from './junk-filter.js';

// [PRESET_CONFIG] per-preset cluster + junk knobs (PR-2 of preset-configs)
import { getActivePresetConfig } from './preset-config.js';

// [MULTI_SIGNAL] semantic + perceptual similarity inputs. Both modules degrade
// to null on any failure, so the clusterer keeps working even if OpenAI or
// the image fetch is down — it just falls back to fewer signals.
import { EmbeddingsClient, cosineSimilarity } from './embeddings.js';
import { ImageHasher, hashSimilarity } from './image-hash.js';

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
  constructor(db, logger, opts = {}) {
    this.db     = db;
    this.logger = logger;

    // ── Multi-signal similarity (PR-1) ───────────────────────────────────
    // The clusterer combines several similarity signals to decide whether
    // two items describe the same narrative:
    //   • Title/description embedding cosine        (semantic)
    //   • Thumbnail dHash similarity                (visual)
    //   • Shared $TICKER bonus                      (lexical, regex)
    //   • Time-distance penalty                     (recency)
    //
    // Per-preset since 2026-05-01 (PR-2): weights + threshold live in
    // settings.presetConfigs.<active>.cluster and are refreshed by
    // _refreshClusterParams() at the start of every route() call. Defaults
    // are baked into preset-config.js DEFAULT_PRESET_CONFIGS.
    this.SIM_THRESHOLD          = 0.55;
    this.SIM_WEIGHT_EMBED       = 0.40;
    this.SIM_WEIGHT_PHASH       = 0.30;
    this.SIM_WEIGHT_ENTITY      = 0.20;
    this.SIM_WEIGHT_TICKER      = 0.10;
    this.SIM_TIME_PENALTY_HOURS = 24;

    // Multi-signal infrastructure. Both clients can be disabled (missing
    // API key / opt-out env var) and the clusterer will fall back gracefully.
    this.embeddings = opts.embeddings || new EmbeddingsClient({}, logger);
    this.imageHasher = opts.imageHasher || new ImageHasher({}, logger);
    this.MULTI_SIGNAL_ENABLED = process.env.CLUSTER_MULTI_SIGNAL !== '0';

    // ── Legacy Jaccard params (used as fallback when all signals null) ──
    this.JACCARD_THRESHOLD = 0.40; // word-set overlap to merge into one cluster
    this.MIN_WORDS         = 1;    // allow short meme titles ("capybara", "$PEPE") to
                                   //   cluster with longer variants.

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
   * Cheap pre-PreStage dedup pass (PR-2).
   *
   * Pipeline order is now:
   *   aggregator → cheapDedup → PreStage → route → scorer
   *
   * PreStage costs money (Gemini per image, nano per text). Without a pre-
   * filter, exact-duplicate items would each pay separately even though they
   * describe identical content. cheapDedup is the cheap insurance: pure
   * in-memory, microseconds, no API calls. It collapses **only obvious**
   * duplicates — bot copypaste, exact reposts, same external URL — because
   * any heuristic stronger than that requires the very signals (embeddings,
   * pHash, semantic) that PreStage will produce.
   *
   * Things that are NOT cheapDedup's job:
   *   - DB-history-based "seen N times before" drop → that's `route()` later
   *   - Multi-platform spread merging                → that's `route()` later
   *   - Junk filtering                               → that's `route()` later
   *
   * Items collapsed here keep their highest-engagement representative; the
   * losers are dropped entirely (we won't see their data again this cycle).
   * That's intentional — they were exact dupes by definition.
   *
   * @param {Array} items
   * @returns {Array} unique items, same shape as input
   */
  cheapDedup(items) {
    if (!Array.isArray(items) || items.length < 2) return items || [];

    // Bucket by (source, normalised-title) — a same-source bucket of size > 1
    // is a copypaste ladder. Keep the highest-engagement entry from each
    // bucket; drop the rest.
    const bySourceTitle = new Map();
    const byUrl         = new Map();
    const out           = [];
    let droppedTitle = 0, droppedUrl = 0;

    for (const item of items) {
      const titleNorm = String(item.title || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const sourceKey = `${item.source || ''}::${titleNorm}`;

      // Identical post URL across multiple items — extremely rare but seen
      // when collectors race on the same Reddit /r/all spike.
      const url = item.url || item.metrics?.permalink || '';
      if (url) {
        const prev = byUrl.get(url);
        if (prev) {
          if (this._engScore(item) > this._engScore(prev)) {
            // Replace the weaker dupe in `out` with `item`
            const idx = out.indexOf(prev);
            if (idx !== -1) out[idx] = item;
            byUrl.set(url, item);
            // Re-sync source-title bucket too
            bySourceTitle.set(sourceKey, item);
          }
          droppedUrl++;
          continue;
        }
      }

      if (titleNorm.length > 0) {
        const prev = bySourceTitle.get(sourceKey);
        if (prev) {
          if (this._engScore(item) > this._engScore(prev)) {
            const idx = out.indexOf(prev);
            if (idx !== -1) out[idx] = item;
            bySourceTitle.set(sourceKey, item);
            if (url) byUrl.set(url, item);
          }
          droppedTitle++;
          continue;
        }
        bySourceTitle.set(sourceKey, item);
      }

      if (url) byUrl.set(url, item);
      out.push(item);
    }

    if (droppedTitle + droppedUrl > 0) {
      this.logger?.info?.(
        `[Clusterer] cheapDedup: ${items.length} → ${out.length} ` +
        `(droppedTitle=${droppedTitle}, droppedUrl=${droppedUrl})`
      );
    }
    return out;
  }

  /**
   * Route items to different pipeline lanes.
   *
   * Async because we now pre-compute embedding vectors and image hashes for
   * all items in a single batched pass before clustering. These are cheap
   * (~1.5–2.5s wall time for 100 items: one OpenAI batch call + ≤4 parallel
   * image fetches) and let the similarity scoring do real semantic work
   * instead of crude word-set overlap.
   *
   * @param {Array} items — output of aggregator.process() (already DB-filtered)
   * @returns {{ priority: Array, toScore: Array, toSave: Array, droppedCount: number }}
   */
  /**
   * Snapshot the active preset's cluster knobs into instance fields. Called
   * at the start of route() so an admin "Пресеты" edit picks up on the next
   * cycle without restart. Safe across cycles — clusterer is a long-lived
   * singleton, instance fields are mutated in place.
   */
  _refreshClusterParams() {
    let cluster;
    try { cluster = getActivePresetConfig(this.db).cluster || {}; }
    catch (_) { cluster = {}; }
    const num = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    this.SIM_THRESHOLD          = num(cluster.simThreshold,     0.55);
    this.SIM_WEIGHT_EMBED       = num(cluster.weightEmbedding,  0.40);
    this.SIM_WEIGHT_PHASH       = num(cluster.weightPhash,      0.30);
    this.SIM_WEIGHT_ENTITY      = num(cluster.weightEntity,     0.20);
    this.SIM_WEIGHT_TICKER      = num(cluster.weightTicker,     0.10);
    this.SIM_TIME_PENALTY_HOURS = num(cluster.timePenaltyHours, 24);
  }

  async route(items) {
    if (items.length === 0) {
      return { priority: [], toScore: [], toSave: [], droppedCount: 0 };
    }

    // Refresh per-preset cluster knobs (sim threshold + weights + time penalty)
    // before any similarity work. Cheap — just reads the cached preset blob.
    this._refreshClusterParams();

    // Multi-signal pre-compute: enrich each item with `_embedding` (Float32Array
    // or null) and `_imageHash` (BigInt or null) BEFORE clustering. Both calls
    // are best-effort — if either fails the similarity function transparently
    // ignores that signal and re-weights what's left.
    if (this.MULTI_SIGNAL_ENABLED) {
      try {
        await this._precomputeSignals(items);
      } catch (e) {
        this.logger?.warn?.(`[Clusterer] signal pre-compute failed (${e.message}) — falling back to Jaccard`);
      }
    }

    // Pick clustering strategy: multi-signal if any item has a usable signal,
    // otherwise legacy Jaccard so the system never goes mute even if BOTH
    // OpenAI and image fetches collapse simultaneously.
    const haveAnySignal = items.some(it => it._embedding || it._imageHash != null);
    const clusters = (this.MULTI_SIGNAL_ENABLED && haveAnySignal)
      ? this._clusterBySimilarity(items)
      : this._clusterByJaccard(items);
    this.logger.info(
      `[Clusterer] ${items.length} items → ${clusters.length} clusters ` +
      `(strategy=${haveAnySignal && this.MULTI_SIGNAL_ENABLED ? 'multi-signal' : 'jaccard-fallback'})`
    );

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

      // Sibling titles for PreStage (nano) — gives the text enricher more
      // context than a single representative title, especially valuable when
      // titles vary in wording but describe the same event. Dedup by
      // normalized form so a copypaste cluster doesn't waste tokens. Cap at
      // 5 to bound prompt size; siblings are ranked by engagement so the
      // most "real" variations win.
      try {
        const seen = new Set();
        const siblings = [];
        const sortedSibs = cluster.items
          .filter(i => i !== cluster.representative)
          .sort((a, b) => this._engScore(b) - this._engScore(a));
        for (const sib of sortedSibs) {
          const t = (sib.title || '').trim();
          if (!t) continue;
          const norm = t.toLowerCase().replace(/\s+/g, ' ');
          if (seen.has(norm)) continue;
          seen.add(norm);
          siblings.push(t);
          if (siblings.length >= 5) break;
        }
        cluster.representative.clusterSiblingTitles = siblings;
      } catch (_) { /* never break pipeline on sibling collection */ }

      // Aggregate image URLs across the cluster — gives alerts a mini gallery
      // when the same narrative hits multiple platforms. Dedup, cap at 10.
      try {
        const gallery = [];
        const push = (u) => {
          if (u && !gallery.includes(u)) gallery.push(u);
        };
        // Representative first so caption lands under its primary image
        const rep = cluster.representative;
        (rep.metrics?.imageUrls || []).forEach(push);
        push(rep.metrics?.imageUrl);
        push(rep.metrics?.thumbnailUrl);
        for (const item of cluster.items) {
          if (item === rep) continue;
          (item.metrics?.imageUrls || []).forEach(push);
          push(item.metrics?.imageUrl);
          push(item.metrics?.thumbnailUrl);
          if (gallery.length >= 10) break;
        }
        if (gallery.length > 1) {
          rep.metrics = rep.metrics || {};
          rep.metrics.imageUrls = gallery.slice(0, 10);
        }

        // Video: representative wins; otherwise fall back to the first cluster
        // item that has one. Single `videoUrl` — we don't ship multi-video alerts.
        if (!rep.metrics?.videoUrl) {
          for (const item of cluster.items) {
            if (item.metrics?.videoUrl) {
              rep.metrics = rep.metrics || {};
              rep.metrics.videoUrl = item.metrics.videoUrl;
              break;
            }
          }
        }
      } catch (_) { /* never break pipeline on image aggregation */ }

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

  // ── Multi-signal clustering (PR-1) ────────────────────────────────────────

  /**
   * Pre-compute per-item embedding vectors and image hashes in batch. Mutates
   * each item with `_embedding` and `_imageHash` fields used by `_similarity`
   * during the clustering pass. Failures are silent — the corresponding field
   * stays null and the similarity function downweights to remaining signals.
   *
   * Note on embedding text: since PR-2, PreStage runs BEFORE the clusterer,
   * so `trend.preStage` is populated (object or null) for every item by the
   * time we get here. When non-null we fold gemini's visualCaption /
   * videoSummary / nano's topicSummary into the embedding text so the
   * vector captures visual + decoded semantics — that's the whole reason
   * we reordered the pipeline. When PreStage failed (preStage === null,
   * e.g. all vision providers down) we fall back to title + description,
   * which is still better than word-set Jaccard would have been.
   */
  async _precomputeSignals(items) {
    // 1) Embeddings — one batch call for all items.
    const texts = items.map(it => this._embeddingText(it));
    const vectors = await this.embeddings.embedBatch(texts);
    for (let i = 0; i < items.length; i++) items[i]._embedding = vectors[i] || null;

    // 2) Image hashes — bounded-concurrency parallel fetches. We pick ONE
    //    representative URL per item (preferring an explicit image, then a
    //    thumbnail, then the first gallery URL) so we don't multiply network
    //    traffic by gallery size — the rep URL is enough for "same meme".
    const urls = items.map(it => this._pickHashUrl(it));
    const hashes = await this.imageHasher.hashBatch(urls);
    for (let i = 0; i < items.length; i++) items[i]._imageHash = hashes[i] ?? null;
  }

  _embeddingText(item) {
    const parts = [];
    if (item.title)        parts.push(item.title);
    if (item.description)  parts.push(String(item.description).slice(0, 400));
    const ps = item.preStage;
    if (ps?.gemini?.videoSummary)  parts.push('[video] ' + ps.gemini.videoSummary);
    if (ps?.gemini?.visualCaption) parts.push('[visual] ' + ps.gemini.visualCaption);
    if (ps?.gemini?.visibleText)   parts.push('[on-screen] ' + ps.gemini.visibleText);
    if (ps?.nano?.topicSummary)    parts.push('[topic] ' + ps.nano.topicSummary);
    return parts.filter(Boolean).join('\n');
  }

  _pickHashUrl(item) {
    const m = item.metrics || {};
    return m.imageUrl
        || m.thumbnailUrl
        || (Array.isArray(m.imageUrls) && m.imageUrls[0])
        || null;
  }

  /**
   * Multi-signal greedy clustering. For each unassigned item, scan remaining
   * items and merge any whose `_similarity` exceeds SIM_THRESHOLD. Greedy
   * matches the existing Jaccard pass shape so all downstream code (metrics,
   * representative selection, gallery aggregation) keeps working unchanged.
   */
  _clusterBySimilarity(items) {
    const clusters = [];
    const assigned = new Set();
    for (let i = 0; i < items.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = { items: [items[i]], representative: items[i] };
      assigned.add(i);
      for (let j = i + 1; j < items.length; j++) {
        if (assigned.has(j)) continue;
        const sim = this._similarity(items[i], items[j]);
        if (sim >= this.SIM_THRESHOLD) {
          cluster.items.push(items[j]);
          assigned.add(j);
        }
      }
      // Representative: highest engagement (same rule as Jaccard path)
      cluster.representative = cluster.items.reduce((best, item) =>
        this._engScore(item) >= this._engScore(best) ? item : best
      );
      clusters.push(cluster);
    }
    return clusters;
  }

  /**
   * Weighted similarity in [0, 1]. Each signal contributes its weight scaled
   * by its strength (cosine for embeddings, normalised hash similarity for
   * images, Jaccard-like for entities, presence boolean for tickers). Weights
   * are renormalised over signals that are actually present — so an item
   * pair with no embedding but matching images still gets a sensible score.
   * A small recency penalty is applied at the end.
   */
  _similarity(a, b) {
    let score = 0;
    let weightUsed = 0;

    // 1) Title/description embedding cosine (semantic)
    if (a._embedding && b._embedding) {
      const cos = cosineSimilarity(a._embedding, b._embedding);
      // Cosines are usually 0.3–0.95 even for unrelated short texts — squash
      // the bottom of the range so noise doesn't accumulate. 0 below 0.5,
      // linear from 0.5→1.0 above. Tunable later if needed.
      const normalised = Math.max(0, (cos - 0.5) * 2);
      score      += this.SIM_WEIGHT_EMBED * normalised;
      weightUsed += this.SIM_WEIGHT_EMBED;
    }

    // 2) Image dHash similarity (visual)
    if (a._imageHash != null && b._imageHash != null) {
      const sim = hashSimilarity(a._imageHash, b._imageHash);
      score      += this.SIM_WEIGHT_PHASH * sim;
      weightUsed += this.SIM_WEIGHT_PHASH;
    }

    // 3) Entity overlap (from PreStage nano if available, else 0). When neither
    //    item has nano output, this signal is absent — weightUsed stays low and
    //    the others decide.
    const ea = a.preStage?.nano?.entityCanonical;
    const eb = b.preStage?.nano?.entityCanonical;
    if (Array.isArray(ea) && Array.isArray(eb) && ea.length > 0 && eb.length > 0) {
      const sa = new Set(ea.map(s => String(s).toLowerCase().trim()));
      const sb = new Set(eb.map(s => String(s).toLowerCase().trim()));
      let inter = 0;
      for (const x of sa) if (sb.has(x)) inter++;
      const overlap = inter / Math.max(sa.size, sb.size);
      score      += this.SIM_WEIGHT_ENTITY * overlap;
      weightUsed += this.SIM_WEIGHT_ENTITY;
    }

    // 4) Shared $TICKER bonus — cheap regex lift. Common in memecoin posts;
    //    when the same ticker appears in both, it's a strong "same narrative"
    //    hint independent of phrasing.
    const ta = this._tickers(a);
    const tb = this._tickers(b);
    if (ta.length > 0 && tb.length > 0) {
      const sa = new Set(ta);
      const shared = tb.some(t => sa.has(t));
      if (shared) {
        score      += this.SIM_WEIGHT_TICKER;
        weightUsed += this.SIM_WEIGHT_TICKER;
      } else {
        // Different tickers actively mentioned → likely different narratives.
        // Penalise lightly so the score doesn't slip past threshold on text
        // alone when tickers explicitly disagree.
        score *= 0.85;
      }
    }

    if (weightUsed === 0) return 0;
    // Renormalise — score is on a [0, weightUsed] scale; re-stretch to [0, 1].
    let final = score / weightUsed;

    // 5) Recency penalty: if items were first seen >N hours apart, soften.
    //    Two posts about "the same trend" hours apart usually still are; days
    //    apart usually aren't. Linear damp 1.0 → 0.7 over the configured
    //    horizon.
    try {
      const tsA = this._firstSeenMs(a);
      const tsB = this._firstSeenMs(b);
      if (tsA && tsB) {
        const dh = Math.abs(tsA - tsB) / 3_600_000;
        const horizon = Math.max(1, this.SIM_TIME_PENALTY_HOURS);
        if (dh > horizon) {
          const damp = Math.max(0.7, 1 - 0.3 * Math.min(1, (dh - horizon) / horizon));
          final *= damp;
        }
      }
    } catch (_) { /* timestamp parse edge cases — ignore */ }

    return final;
  }

  _tickers(item) {
    // Prefer pre-extracted tickers from the collector; fall back to a regex
    // sweep over the title so single-source items still benefit.
    const fromMetrics = item.metrics?.tickers;
    if (Array.isArray(fromMetrics) && fromMetrics.length > 0) {
      return fromMetrics.map(t => String(t).toUpperCase().replace(/^\$/, ''));
    }
    const matches = String(item.title || '').match(/\$([A-Z]{2,10})\b/g) || [];
    return matches.map(s => s.replace(/^\$/, ''));
  }

  _firstSeenMs(item) {
    // Items can carry timestamps in several shapes depending on collector.
    const v = item.firstSeenAt || item.first_seen_at || item.metrics?.publishedAt || item.metrics?.createdAt;
    if (!v) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
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
    const batchSize    = items.length;
    const batchAuthors = new Set(items.map(i => i.externalId)).size;

    // Text variation: ratio of distinct word-sets to cluster size.
    // High variation = people rephrase = organic spread of a real narrative.
    const uniqueWordSets = new Set(items.map(i => [...this._wordSet(i.title)].sort().join(' ')));
    const textVariation  = batchSize > 1 ? uniqueWordSets.size / batchSize : 0;

    // DB history
    const dbRecentCount = history.length;
    const isNovel       = dbRecentCount === 0;

    // NOTE (2026-05-04): cross-platform aggregation removed. The clusterer's
    // similarity matcher reliably groups within a single source but routinely
    // fails to merge identical content across sources (e.g. the same TikTok
    // video re-posted to Twitter and Reddit ends up as two separate trends).
    // Rather than reward an unreliable signal, we no longer compute
    // uniquePlatforms or use it in scoring/routing/UI. Single-platform
    // breakouts are still caught via _computeBreakoutScore, which is
    // platform-agnostic and based on raw engagement.

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
    // Per-preset since 2026-05-01 (PR-2). Junk profile lives in
    // settings.presetConfigs.<active>.junk; we synthesize a legacy-shaped
    // overrides blob `{ <preset>: { ...junk-fields } }` so junk-filter.js +
    // filter-profiles.js resolveProfile() can keep their existing API.
    try {
      const cfg = getActivePresetConfig(this.db);
      const activePreset = cfg.preset || 'general';
      const overrides = { [activePreset]: cfg.junk || {} };
      const { junkPenalty, junkReasons, memeShapeBoost, memeShapeSignals } =
        calculateJunkPenalty(items, base, activePreset, overrides);
      base.junkPenalty       = junkPenalty;
      base.junkReasons       = junkReasons;
      base.memeShapeBoost    = memeShapeBoost    || 0;
      base.memeShapeSignals  = memeShapeSignals  || [];

      // Apply meme-shape boost to emergenceScore so that meme-looking clusters
      // pass the DROP_EMERGENCE_MAX gate and reach LLM. Affects ROUTING only —
      // LLM still assigns the real memePotential based on actual content.
      if (base.memeShapeBoost > 0) {
        const before = base.emergenceScore;
        base.emergenceScore = Math.min(100, base.emergenceScore + base.memeShapeBoost);
        if (base.emergenceScore !== before) {
          this.logger.debug(
            `[Clusterer] meme-shape boost +${base.memeShapeBoost} ` +
            `[${base.memeShapeSignals.join(',')}] emergence ${before}→${base.emergenceScore}`
          );
        }
      }
    } catch (_) {
      base.junkPenalty      = 0;
      base.junkReasons      = [];
      base.memeShapeBoost   = 0;
      base.memeShapeSignals = [];
    }

    return base;
  }

  // ── EmergenceScore ────────────────────────────────────────────────────────

  /**
   * Compute EmergenceScore (0–100): how much this narrative is actually emerging.
   *
   * Three independent paths, final score = Math.max(spread, breakout) + ideaBoost:
   *
   * Spread-based (multi-post clusters within a single source):
   *   Velocity         (0–35)
   *   Organic spread   (0–30)
   *   Novelty stage    (0–20)
   *   Author diversity (0–15)
   *
   * Breakout-based (single extremely viral post — platform-agnostic):
   *   Views / Plays    (0–35)
   *   Likes / Upvotes  (0–30)
   *   Retweets / Shares(0–20)
   *   Engagement rate  (0–15)
   *
   * IdeaBoost (Reddit early-idea signal, additive, 0–12):
   *   Upvote tiers: >=10k→+5, >=15k→+8, >=30k→+10, >=60k→+12
   *   Applied on top of max(spread, breakout), capped at 100.
   *
   * (2026-05-04) Removed the "Platform spread" component (was 0–30) — the
   * clusterer's cross-source matching is unreliable, so we don't reward it.
   * The 30 points were redistributed across the four remaining spread
   * components: velocity +10, organic +10, novelty +5, author diversity +5.
   * Single-source viral posts still get caught via the breakout path.
   *
   * @param {object} m       — cluster-level metrics (spread signals)
   * @param {Array}  items   — raw cluster items (for breakout + ideaBoost signals)
   */
  _computeEmergenceScore(m, items = []) {
    // ── Path 1: spread-based ──────────────────────────────────────────────
    let spreadScore = 0;

    // Velocity (0–35) — DB appearances per hour since first seen
    spreadScore += m.velocity > 2.0 ? 35
                 : m.velocity > 1.0 ? 26
                 : m.velocity > 0.5 ? 17
                 : m.velocity > 0.2 ? 9
                 : 0;

    // Organic spread (0–30) — distinct word-sets / cluster size
    spreadScore += Math.min(Math.round(Math.min(m.batchSize, 10) * m.textVariation * 3), 30);

    // Novelty stage (0–20)
    spreadScore += m.isNovel            ? 20
                 : m.dbRecentCount <= 3 ? 13
                 : m.dbRecentCount <= 8 ? 7
                 : 3;

    // Author diversity (0–15)
    spreadScore += m.batchAuthors >= 5 ? 15
                 : m.batchAuthors >= 3 ? 10
                 : m.batchAuthors >= 2 ? 6
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
   * we only drop if emergence is also weak (no growth in DB count + flat velocity).
   *
   * (2026-05-04) Removed the `uniquePlatforms <= 1` guard from this gate. The
   * cross-source matcher is unreliable, so a "1 platform" reading was just as
   * likely a clustering miss as a genuine mono-platform narrative. Velocity +
   * emergence are sufficient to identify stale noise without it.
   */
  _decide(m) {
    const e = m.emergenceScore;

    // DROP — stale noise: seen many times but NOT growing (velocity flat + emergence weak)
    if (
      m.dbRecentCount >= this.DROP_DB_MIN &&
      e < this.DROP_EMERGENCE_MAX &&
      m.velocity < this.DROP_VELOCITY_MAX
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
