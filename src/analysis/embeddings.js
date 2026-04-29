/**
 * EmbeddingsClient — OpenAI text-embedding-3-small batch wrapper.
 *
 * Used by the clusterer for semantic similarity between trend titles, and
 * eventually by other modules that need vector representations of trends.
 *
 * Contract:
 *   - NEVER throws. On any error returns array of nulls — caller falls back
 *     to other similarity signals (image hash, entity overlap, Jaccard).
 *   - Batched: a single HTTP call per cycle, up to 2048 inputs (OpenAI cap).
 *   - In-memory LRU keyed by text hash so repeated trends across consecutive
 *     cycles don't pay twice. TTL configurable; default 5min matches the
 *     scan interval × 2.
 *
 * Cosine similarity helper exported alongside — the clusterer uses dot
 * product (vectors are L2-normalised by OpenAI, so dot == cosine).
 */

import crypto from 'node:crypto';

const DEFAULT_MODEL = 'text-embedding-3-small'; // 1536 dims, $0.02/1M tokens

export class EmbeddingsClient {
  constructor(config, logger) {
    this.logger = logger;
    this.apiKey = process.env.OPENAI_API_KEY || (config?.aiProviders?.openai?.apiKey || '');
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.model = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;

    // Cache: Map<sha1(text), { vec, expiresAt }>. Bounded to prevent leaks
    // on long-running processes — eviction is least-recently-set when cap hit.
    this.cacheTtlMs = parseInt(process.env.EMBEDDING_CACHE_TTL_MS || '300000', 10); // 5 min
    this.cacheCap   = parseInt(process.env.EMBEDDING_CACHE_CAP    || '1000', 10);
    this._cache = new Map();

    // Per-call timeout — embeddings are usually <500ms but a stalled
    // connection shouldn't block the whole pipeline.
    this.timeoutMs = parseInt(process.env.EMBEDDING_TIMEOUT_MS || '15000', 10);

    this.enabled = !!this.apiKey;
    if (!this.enabled) {
      this.logger?.warn?.('[Embeddings] disabled — OPENAI_API_KEY missing');
    }
  }

  /**
   * Get embedding vectors for an array of texts. Returns same-length array
   * where each entry is Float32Array(1536) or null on per-item failure.
   *
   * Texts are normalised (trimmed, collapsed whitespace, capped at 8000
   * chars — well within the model's 8192-token limit while keeping payload
   * small) and de-duplicated within the batch — identical inputs share a
   * single API computation.
   */
  async embedBatch(texts) {
    if (!this.enabled || !Array.isArray(texts) || texts.length === 0) {
      return (texts || []).map(() => null);
    }

    const normalised = texts.map(t => this._normalise(t));
    const result = new Array(texts.length).fill(null);

    // 1. Hit cache + collect uniques to fetch
    const toFetch = [];           // texts that aren't cached
    const toFetchKeys = [];       // their cache keys (parallel arr)
    const indexByKey = new Map(); // key → list of original indices
    for (let i = 0; i < normalised.length; i++) {
      const text = normalised[i];
      if (!text) continue;
      const key = this._cacheKey(text);
      const hit = this._cacheGet(key);
      if (hit) {
        result[i] = hit;
        continue;
      }
      if (!indexByKey.has(key)) {
        indexByKey.set(key, []);
        toFetch.push(text);
        toFetchKeys.push(key);
      }
      indexByKey.get(key).push(i);
    }

    if (toFetch.length === 0) return result;

    // 2. One HTTP request for the whole batch
    const startedAt = Date.now();
    let vectors = null;
    try {
      vectors = await this._postEmbeddings(toFetch);
    } catch (e) {
      this.logger?.warn?.(`[Embeddings] batch failed: ${e.message}`);
      return result; // partial: cached items present, fresh ones null
    }

    if (!vectors || vectors.length !== toFetch.length) {
      this.logger?.warn?.(`[Embeddings] response shape mismatch: got ${vectors?.length}, expected ${toFetch.length}`);
      return result;
    }

    // 3. Fill result + populate cache
    for (let i = 0; i < toFetch.length; i++) {
      const key = toFetchKeys[i];
      const vec = vectors[i];
      this._cacheSet(key, vec);
      for (const origIdx of (indexByKey.get(key) || [])) {
        result[origIdx] = vec;
      }
    }

    const cached = result.length - toFetch.length;
    this.logger?.info?.(
      `[Embeddings] ${toFetch.length} fresh + ${cached} cached in ${Date.now() - startedAt}ms ` +
      `(model=${this.model}, dims=${vectors[0]?.length || '?'})`
    );

    return result;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async _postEmbeddings(inputs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          // OpenAI returns L2-normalised vectors by default — we rely on
          // that for treating dot product as cosine similarity downstream.
          encoding_format: 'float',
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      if (!Array.isArray(data?.data)) throw new Error('malformed response — no data array');
      // OpenAI guarantees order matches input order.
      return data.data.map(d => Float32Array.from(d.embedding));
    } finally {
      clearTimeout(timer);
    }
  }

  _normalise(text) {
    if (!text) return '';
    // Collapse whitespace, trim, soft-cap. The hard model cap is ~8K tokens
    // (~32K chars) but in practice we feed title+description chunks — anything
    // past 8K chars is descriptive bloat that rarely changes meaning.
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 8000);
  }

  _cacheKey(text) {
    // sha1 is plenty for cache-key purposes — we're not securing anything.
    return crypto.createHash('sha1').update(this.model + '\0' + text).digest('hex');
  }

  _cacheGet(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this._cache.delete(key);
      return null;
    }
    // Touch LRU order: re-insert
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry.vec;
  }

  _cacheSet(key, vec) {
    this._cache.set(key, { vec, expiresAt: Date.now() + this.cacheTtlMs });
    // Evict oldest until under cap
    while (this._cache.size > this.cacheCap) {
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }
  }
}

/**
 * Cosine similarity between two L2-normalised float vectors. With normalised
 * vectors this is just dot product — but we don't trust the normalisation
 * unconditionally, so we compute |a|·|b| as a guard. Returns 0 on length
 * mismatch or if either vector is null/zero-length.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export default EmbeddingsClient;
