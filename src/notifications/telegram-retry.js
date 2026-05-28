// Bot resilience helper — Bundle #15 (2026-05-28).
//
// Wraps any async Telegram send call. On HTTP 429 (rate-limit), reads the
// `retry_after` payload from the TG error and sleeps for that long (capped
// at 60s) before retrying ONCE. Any other error — including 403 (user
// blocked the bot) — re-throws immediately so the caller can decide what
// to do.
//
// Usage:
//   import { withTelegramRetry } from './telegram-retry.js';
//   const sent = await withTelegramRetry(
//     () => bot.sendMessage(chatId, text, opts),
//     { logger: this.logger, label: 'alert-text' }
//   );

const DEFAULT_MAX_RETRIES = 1;          // 1 retry → 2 attempts total
const DEFAULT_RETRY_CAP_MS = 60 * 1000; // 60s safety cap on retry_after
const FALLBACK_RETRY_AFTER_MS = 5000;   // when TG didn't include retry_after

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function is429(err) { return err?.response?.statusCode === 429; }

function extractRetryAfterMs(err, capMs) {
  const r = err?.response?.body?.parameters?.retry_after;
  if (typeof r === 'number' && r > 0) return Math.min(r * 1000, capMs);
  return FALLBACK_RETRY_AFTER_MS;
}

export async function withTelegramRetry(sendFn, opts = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    retryCapMs = DEFAULT_RETRY_CAP_MS,
    logger = null,
    label = 'tg-send',
  } = opts;
  let attempt = 0;
  while (true) {
    try {
      return await sendFn();
    } catch (err) {
      if (!is429(err) || attempt >= maxRetries) throw err;
      attempt++;
      const waitMs = extractRetryAfterMs(err, retryCapMs);
      if (logger?.warn) {
        logger.warn(`[${label}] TG 429 — sleeping ${waitMs}ms before retry ${attempt}/${maxRetries}`);
      }
      await sleep(waitMs);
    }
  }
}
