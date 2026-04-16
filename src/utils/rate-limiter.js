/**
 * Dual-mode rate limiter:
 *  - Per-user sliding-window limiter (for Telegram command spam protection)
 *  - Global token-bucket limiter (for API call throttling)
 */

/** Per-user sliding-window rate limiter */
export class UserRateLimiter {
  constructor({ windowMs = 60_000, maxRequests = 20 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this._buckets = new Map();
    // Auto-cleanup stale entries every 5 minutes
    setInterval(() => this._cleanup(), 5 * 60_000).unref();
  }

  /**
   * Returns true if the request is allowed, false if rate-limited.
   */
  allow(chatId) {
    const now = Date.now();
    const key = String(chatId);
    const windowStart = now - this.windowMs;

    let hits = (this._buckets.get(key) || []).filter(ts => ts > windowStart);
    if (hits.length >= this.maxRequests) {
      this._buckets.set(key, hits);
      return false;
    }
    hits.push(now);
    this._buckets.set(key, hits);
    return true;
  }

  _cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, hits] of this._buckets) {
      if (hits.every(ts => ts <= cutoff)) this._buckets.delete(key);
    }
  }
}

/** Global token-bucket rate limiter (for outbound API calls) */
export class TokenBucketLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
  }

  async waitForToken() {
    this._refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    const waitTime = this.windowMs - (Date.now() - this.lastRefill);
    await new Promise(resolve => setTimeout(resolve, Math.max(waitTime, 100)));
    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  _refill() {
    const now = Date.now();
    if (now - this.lastRefill >= this.windowMs) {
      this.tokens = this.maxRequests;
      this.lastRefill = now;
    }
  }
}

// Default export kept for backward compatibility
export default TokenBucketLimiter;
