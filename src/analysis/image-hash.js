/**
 * ImageHasher — perceptual image hashing via dHash (difference hash).
 *
 * Used by the clusterer to detect "this is the same meme image" across
 * platforms. Two TikTok and Twitter posts of the same Pepe variant should
 * hash to nearly the same 64-bit value regardless of resize/recompression.
 *
 * Why dHash, not pHash:
 *   - dHash needs no DCT — just a 9×8 grayscale resize and adjacent-pixel
 *     comparison. ~3× faster than DCT-based pHash and 2× simpler to
 *     implement, with very similar robustness for thumbnail comparison.
 *   - Industry-tested (used by Facebook for image dedup, Tumblr, Slack).
 *   - Robust to resize, mild crop, JPEG recompression, brightness shifts.
 *   - Less robust to flips/rotations — but memes don't get flipped, so OK.
 *
 * Hash format: 64-bit BigInt. Hamming distance < 8 is the standard "same
 * image" threshold. We expose distance + a normalised similarity (0–1) so
 * the clusterer can plug it into a weighted score.
 *
 * Contract:
 *   - NEVER throws. All failures (network, decode, timeout) return null.
 *   - Per-URL in-memory cache (TTL configurable). Catalogues thumbnail
 *     URLs across consecutive cycles so we don't re-download the same
 *     image every 15 min.
 */

import sharp from 'sharp';

export class ImageHasher {
  constructor(config, logger) {
    this.logger = logger;
    this.timeoutMs    = parseInt(process.env.IMAGE_HASH_TIMEOUT_MS    || '5000',  10);
    this.maxBytes     = parseInt(process.env.IMAGE_HASH_MAX_BYTES     || '2097152', 10); // 2 MB
    this.cacheTtlMs   = parseInt(process.env.IMAGE_HASH_CACHE_TTL_MS  || '900000', 10);  // 15 min
    this.cacheCap     = parseInt(process.env.IMAGE_HASH_CACHE_CAP     || '500',    10);
    this.concurrency  = parseInt(process.env.IMAGE_HASH_CONCURRENCY   || '4',      10);
    // Cache: Map<url, { hash, expiresAt }>. LRU-ish eviction on cap hit.
    this._cache = new Map();
  }

  /**
   * Hash an array of image URLs in parallel (bounded concurrency).
   * Returns array of BigInt hashes (or null) in input order.
   */
  async hashBatch(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return [];
    const out = new Array(urls.length).fill(null);

    // Hit cache first — record indices that still need fetching
    const pending = []; // { idx, url }
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (!url) continue;
      const cached = this._cacheGet(url);
      if (cached !== undefined) {
        out[i] = cached;
        continue;
      }
      pending.push({ idx: i, url });
    }

    if (pending.length === 0) return out;

    // Bounded-concurrency fetch — workers pull from a shared cursor
    let cursor = 0;
    const startedAt = Date.now();
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= pending.length) return;
        const { idx, url } = pending[i];
        const hash = await this._hashOne(url);
        out[idx] = hash;
        this._cacheSet(url, hash);
      }
    };
    const workers = Array.from(
      { length: Math.min(this.concurrency, pending.length) },
      () => worker()
    );
    await Promise.all(workers);

    const ok = out.filter(h => h != null).length;
    this.logger?.info?.(
      `[ImageHasher] hashed ${pending.length} (${ok}/${urls.length} ok) in ${Date.now() - startedAt}ms`
    );
    return out;
  }

  // ── Core hashing ─────────────────────────────────────────────────────────

  async _hashOne(url) {
    try {
      const buffer = await this._download(url);
      if (!buffer) return null;
      return await this._computeDHash(buffer);
    } catch (e) {
      this.logger?.debug?.(`[ImageHasher] ${url.slice(0, 80)} failed: ${e.message}`);
      return null;
    }
  }

  async _download(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) return null;
      // Honour Content-Length up-front when available; otherwise we still
      // bail in the buffer-size check below.
      const cl = parseInt(res.headers.get('content-length') || '0', 10);
      if (cl > this.maxBytes) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > this.maxBytes) return null;
      if (buffer.length < 100) return null; // 1×1 transparent gif tier
      return buffer;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * dHash algorithm:
   *   1. Resize to 9 wide × 8 tall, single-channel grayscale (72 pixels)
   *   2. For each row, compare adjacent pixels: 1 if left > right, else 0
   *   3. Concatenate the 8 rows of 8 bits each → 64-bit hash
   *
   * Sharp does steps 1 in native code — fast even for largish thumbnails.
   * We use BigInt for the 64-bit value because Number loses precision past
   * 53 bits; downstream Hamming distance accepts BigInt directly.
   */
  async _computeDHash(buffer) {
    const { data } = await sharp(buffer)
      .removeAlpha()
      .grayscale()
      // `fit: 'fill'` ensures EXACTLY 9×8, ignoring aspect ratio. Aspect
      // doesn't matter for dHash because we compare WITHIN-row only.
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // data is 9×8 = 72 bytes, one byte per pixel (grayscale).
    let hash = 0n;
    for (let row = 0; row < 8; row++) {
      const rowOffset = row * 9;
      for (let col = 0; col < 8; col++) {
        const left  = data[rowOffset + col];
        const right = data[rowOffset + col + 1];
        // Bit = 1 if pixel intensity decreases left→right
        if (left > right) {
          // Position bits MSB-first so the hash visually mirrors row order
          const bitPos = BigInt(63 - (row * 8 + col));
          hash |= (1n << bitPos);
        }
      }
    }
    return hash;
  }

  // ── Cache ────────────────────────────────────────────────────────────────

  _cacheGet(url) {
    const entry = this._cache.get(url);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this._cache.delete(url);
      return undefined;
    }
    // Touch for LRU
    this._cache.delete(url);
    this._cache.set(url, entry);
    return entry.hash; // null is a valid cached value (failed download)
  }

  _cacheSet(url, hash) {
    this._cache.set(url, { hash, expiresAt: Date.now() + this.cacheTtlMs });
    while (this._cache.size > this.cacheCap) {
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }
  }
}

/**
 * Hamming distance between two 64-bit BigInt hashes. 0 = identical, 64 =
 * fully inverted. Returns 64 if either argument is null/undefined so
 * downstream similarity = 0 in that case.
 */
export function hammingDistance(a, b) {
  if (a == null || b == null) return 64;
  let xor = a ^ b;
  let dist = 0;
  while (xor) {
    // bigint popcount — trim 1 bit per iteration
    xor &= xor - 1n;
    dist++;
  }
  return dist;
}

/**
 * Convert Hamming distance to a 0–1 similarity. Distance 0 → 1.0; distance
 * ≥ DIST_MAX → 0. Linear in between. DIST_MAX of 16 gives a "soft" zone:
 * mild thumbnail variations still register as >0.5, distinct images sit
 * near 0. Tunable but the default is field-tested.
 */
export function hashSimilarity(a, b, distMax = 16) {
  if (a == null || b == null) return 0;
  const dist = hammingDistance(a, b);
  if (dist >= distMax) return 0;
  return 1 - dist / distMax;
}

export default ImageHasher;
