/**
 * Catalyst Dashboard — Express REST API + embedded React SPA
 *
 * Endpoints:
 *   GET  /api/health          — health check (no auth)
 *   GET  /api/trends          — list trends (paginated, filterable)
 *   GET  /api/trends/:id      — single trend detail
 *   GET  /api/stats           — aggregated stats
 *   GET  /api/sources         — collector status
 *   POST /api/scan            — trigger manual scan
 *   GET  /                    — serves the React SPA
 */

import http from 'http';
import path from 'path';
import { LIFESPAN_VALUES, normalizeLifespan } from '../analysis/lifespan.js';
import { runManualAnalysis, peekManualAnalysisCache } from '../analysis/manual-analysis.js';
import { getActivePresetConfig } from '../analysis/preset-config.js';
import { collectSubjectNames } from '../analysis/subject-names.js';
import { getPlanEntitlements, shouldShowUsageCounter } from '../billing/entitlements.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { timingSafeEqual, createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Middleware helpers ────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 16 * 1024; // 16 KB limit

// Security headers — applied to every response. Defaults are conservative;
// override via env if you need to embed the dashboard in an iframe etc.
//   - HSTS: tells browsers to only ever talk HTTPS for the next year. Safe even
//     when terminating TLS at a reverse proxy (header is honored by the client).
//   - X-Frame-Options DENY: blocks clickjacking via <iframe>.
//   - X-Content-Type-Options nosniff: blocks MIME-sniff attacks.
//   - Referrer-Policy no-referrer: don't leak the dashboard URL to outbound links.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

// CORS allowlist — comma-separated env var. Empty (default) = no cross-origin
// allowed; the SPA is same-origin to the API in normal deployment. If you serve
// the frontend from a different origin (separate CDN, dev bundler), add it
// here, e.g. `DASHBOARD_ALLOWED_ORIGINS=https://app.example.com,http://localhost:5173`.
const ALLOWED_ORIGINS = (process.env.DASHBOARD_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/**
 * Compute the value of `Access-Control-Allow-Origin` for this request.
 * Returns null when no CORS header should be sent (= same-origin only).
 */
function corsOriginFor(req) {
  const origin = String(req.headers?.origin || '');
  if (!origin) return null;            // same-origin / non-browser request
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

/**
 * Build response headers with security defaults + optional CORS echo.
 * Pass extra headers as the second arg (Content-Type, Cache-Control, etc.).
 */
function buildHeaders(req, extra = {}) {
  const headers = { ...SECURITY_HEADERS, ...extra };
  const origin = corsOriginFor(req);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    // Browsers cache CORS results per-Origin — Vary lets shared caches hold
    // separate entries per origin instead of mixing them up.
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/**
 * Mask a Telegram chat_id (or any user identifier) for logging. Long-term
 * stdout logs (Docker / journald) are PII surface — we want enough info to
 * correlate two log lines for the same user, but not enough to expose the
 * full identifier to anyone scanning logs. Last 4 chars is the standard.
 *
 * Examples:  6321487523 → '***7523',   '47'  → '***47'
 */
export function maskId(id) {
  const s = String(id ?? '');
  if (!s) return '<empty>';
  return '***' + s.slice(-4);
}

/**
 * Format a "now - msAgo" cutoff to match SQLite's stored TEXT timestamp shape
 * ('YYYY-MM-DD HH:MM:SS') so lexicographic WHERE comparisons work correctly.
 *
 * Why: SQLite has no real DATETIME type — `CURRENT_TIMESTAMP` is stored as
 * TEXT 'YYYY-MM-DD HH:MM:SS' (space separator, no Z, no millis). If we feed
 * a JS-style ISO string ('YYYY-MM-DDTHH:MM:SS.sssZ') as a cutoff, the
 * comparison is purely string-lex: at position 10, ' ' (0x20) < 'T' (0x54),
 * so any same-day stored row is < cutoff string, and `WHERE col > cutoff`
 * returns zero rows — silently. The bug is invisible at 24h windows because
 * the cutoff lands on a different calendar day (date prefix differs first),
 * but visible at 6h windows where cutoff and rows share the same date prefix.
 *
 * Symptom that revealed this: dashboard 6h window returned an empty feed.
 */
function sqliteCutoff(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}

// ─── Plan-based gating helpers ────────────────────────────────────────────────
// getPlanEntitlements is imported from src/billing/entitlements.js — shared
// with the Telegram bot so source-filter, manual-analyze cap and catalyst cap
// stay consistent across both surfaces.

// ─── Tweet preview (hover popups) ─────────────────────────────────────────────
// Lightweight in-memory cache keyed by tweet ID. The dashboard's hover-preview
// feature (added 2026-05-04) shows a card when the user hovers a tweet link.
// Source of truth: api.fxtwitter.com — open, no auth, returns clean JSON with
// text/author/media/metrics. Same backend Discord and Telegram use to render
// tweet cards, so the format is well-tested.
//
// LRU is overkill for ≤500 entries; a Map + age check + simple eviction does
// the job. TTL is short (5 min) because tweet metrics drift, but author/text
// don't, so even a stale read is "fine enough" for hover UX. Cache survives
// only in-memory (process restart loses it) — that's intentional, no DB write
// pressure for ephemeral hover data.
const tweetPreviewCache = new Map();          // id → { data, ts, status }
const TWEET_PREVIEW_TTL_MS  = 5 * 60_000;
const TWEET_PREVIEW_NEG_TTL_MS = 30_000;       // 404/error: re-try sooner
const TWEET_PREVIEW_MAX     = 500;

function tweetPreviewCacheSet(id, status, data) {
  if (tweetPreviewCache.size >= TWEET_PREVIEW_MAX) {
    // Evict oldest 10% — cheaper than per-insert LRU bookkeeping for this size
    const drop = Math.ceil(TWEET_PREVIEW_MAX * 0.1);
    let i = 0;
    for (const k of tweetPreviewCache.keys()) {
      tweetPreviewCache.delete(k);
      if (++i >= drop) break;
    }
  }
  tweetPreviewCache.set(id, { status, data, ts: Date.now() });
}

function extractTweetId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i);
  return m ? m[1] : null;
}

/**
 * Normalize fxtwitter response to a stable shape the frontend can render
 * without knowing about provider quirks. We pick only what the hover card
 * shows; everything else (entities, polls, quoted_tweet) gets dropped.
 */
function normalizeFxTweet(t) {
  if (!t || typeof t !== 'object') return null;
  const author = t.author || {};
  const media  = t.media || {};
  // fxtwitter exposes photos/videos arrays; flatten into a single ordered list.
  const photos = Array.isArray(media.photos) ? media.photos.map(p => ({
    type: 'photo', url: p.url, width: p.width || null, height: p.height || null,
  })) : [];
  const videos = Array.isArray(media.videos) ? media.videos.map(v => ({
    type: 'video', url: v.url, thumbnail: v.thumbnail_url || null,
    width: v.width || null, height: v.height || null,
  })) : [];
  return {
    id: String(t.id || ''),
    url: t.url || '',
    text: String(t.text || '').slice(0, 1000),
    createdAt: t.created_timestamp ? t.created_timestamp * 1000 : null,
    author: {
      name: author.name || '',
      screenName: author.screen_name || '',
      avatarUrl: author.avatar_url || null,
      followers: typeof author.followers === 'number' ? author.followers : null,
    },
    media: [...photos, ...videos],
    metrics: {
      likes:    typeof t.likes    === 'number' ? t.likes    : null,
      retweets: typeof t.retweets === 'number' ? t.retweets : null,
      replies: typeof t.replies   === 'number' ? t.replies  : null,
      views:    typeof t.views    === 'number' ? t.views    : null,
    },
  };
}

// ─── Reddit preview (parallel pipeline to Twitter) ────────────────────────────
// Same idea as the Twitter cache above, but for Reddit posts. Uses Reddit's
// free public JSON API (https://reddit.com/comments/<id>.json) — no auth, no
// rate-limit auth header needed for moderate read traffic with a polite UA.
const redditPreviewCache = new Map();
const REDDIT_PREVIEW_TTL_MS     = 5 * 60_000;
const REDDIT_PREVIEW_NEG_TTL_MS = 30_000;
const REDDIT_PREVIEW_MAX        = 500;

function redditPreviewCacheSet(id, status, data) {
  if (redditPreviewCache.size >= REDDIT_PREVIEW_MAX) {
    const drop = Math.ceil(REDDIT_PREVIEW_MAX * 0.1);
    let i = 0;
    for (const k of redditPreviewCache.keys()) {
      redditPreviewCache.delete(k);
      if (++i >= drop) break;
    }
  }
  redditPreviewCache.set(id, { status, data, ts: Date.now() });
}

function extractRedditPostId(url) {
  if (!url) return null;
  const m = String(url).match(/\/comments\/([a-z0-9]{4,12})(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

/**
 * Normalize Reddit JSON response into the same shape the hover-preview
 * frontend understands. Mirrors normalizeFxTweet — author/text/media/metrics
 * with platform-appropriate field names.
 */
function normalizeRedditPost(post) {
  if (!post || typeof post !== 'object') return null;
  // Pick first preview image if available (Reddit serves multiple sizes;
  // .source is full-res). Galleries we collapse to first item — hover card
  // shouldn't have a carousel.
  let imageUrl = null;
  const direct = post.url_overridden_by_dest || post.url || '';
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(direct)) imageUrl = direct;
  else if (post.preview?.images?.[0]?.source?.url) imageUrl = post.preview.images[0].source.url;
  else if (post.is_gallery && post.media_metadata && post.gallery_data?.items?.length) {
    const firstId = post.gallery_data.items[0].media_id;
    const item = firstId && post.media_metadata[firstId];
    imageUrl = item?.s?.u || item?.s?.gif || null;
  }

  // Reddit awards: post.total_awards_received or post.all_awardings (length).
  // We collapse into a single number for the hover card.
  const awards = typeof post.total_awards_received === 'number'
    ? post.total_awards_received
    : (Array.isArray(post.all_awardings) ? post.all_awardings.length : 0);

  return {
    id: String(post.id || ''),
    permalink: post.permalink ? ('https://reddit.com' + post.permalink) : '',
    title: String(post.title || '').slice(0, 400),
    text: String(post.selftext || '').slice(0, 1500),
    createdAt: post.created_utc ? post.created_utc * 1000 : null,
    author: {
      name: post.author || '',
      subreddit: post.subreddit || '',
      // Reddit doesn't expose author avatar in the post JSON cheaply (would
      // need a second fetch to /user/<u>/about.json). Skip for now — the
      // hover card falls back to a letter avatar like Twitter does.
      avatarUrl: null,
    },
    media: imageUrl ? [{ type: 'photo', url: imageUrl, width: null, height: null }] : [],
    metrics: {
      upvotes:   typeof post.score        === 'number' ? post.score        : (post.ups || null),
      comments:  typeof post.num_comments === 'number' ? post.num_comments : null,
      // Reddit doesn't expose per-post views in the public JSON. Leave null.
      views:     null,
      awards,
      ratio:     typeof post.upvote_ratio === 'number' ? post.upvote_ratio : null,
    },
    nsfw: !!post.over_18,
  };
}

/**
 * Fetch reddit post by id (base36) using the public .json endpoint. No auth
 * needed but a polite User-Agent is good citizenship — Reddit explicitly
 * asks for descriptive UAs in their API guidelines.
 */
async function fetchRedditPreview(id) {
  try {
    const ctl = new AbortController();
    const tm  = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`https://www.reddit.com/comments/${id}.json?raw_json=1`, {
      headers: {
        'User-Agent': 'CatalystBot/1.0 (+hover-preview)',
        'Accept': 'application/json',
      },
      signal: ctl.signal,
    });
    clearTimeout(tm);
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    // Response is [post_listing, comments_listing]. We only need the post.
    const post = j?.[0]?.data?.children?.[0]?.data;
    if (!post) return { ok: false, status: 502 };
    const data = normalizeRedditPost(post);
    if (!data) return { ok: false, status: 502 };
    return { ok: true, status: 200, data };
  } catch (e) {
    return { ok: false, status: 599, error: String(e?.message || e) };
  }
}

/**
 * Fetch tweet preview from fxtwitter (with timeout). Returns
 * { ok, data, status }. Never throws — always resolves so caller can cache
 * negative results. ~200-500ms typical latency; 3s timeout is generous.
 */
async function fetchTweetPreview(id) {
  try {
    const ctl = new AbortController();
    const tm  = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`https://api.fxtwitter.com/i/status/${id}`, {
      headers: { 'User-Agent': 'CatalystBot/1.0 (+hover-preview)' },
      signal: ctl.signal,
    });
    clearTimeout(tm);
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    if (!j || j.code !== 200 || !j.tweet) {
      return { ok: false, status: j?.code || 502 };
    }
    const data = normalizeFxTweet(j.tweet);
    if (!data) return { ok: false, status: 502 };
    return { ok: true, status: 200, data };
  } catch (e) {
    return { ok: false, status: 599, error: String(e?.message || e) };
  }
}

/** Constant-time string comparison to prevent timing attacks */
function safeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) {
      // Still run comparison on equal-length buffers to avoid leaking length
      timingSafeEqual(ba, ba);
      return false;
    }
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function json(res, status, data) {
  // res._defaultHeaders stashed by _handle() entry — security defaults +
  // optional CORS for the current Origin. Falls back to bare security
  // headers if a caller forgot to pass through _handle (shouldn't happen).
  const base = res._defaultHeaders || SECURITY_HEADERS;
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    ...base,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * Normalize pbs.twimg.com URLs to the original-resolution variant.
 * Twitter serves multiple sizes via ?name=small|medium|large|orig; we want the
 * largest. No-op for non-twimg URLs.
 */
function upgradeTwimgUrl(u) {
  if (!u || !/pbs\.twimg\.com\//.test(u)) return u;
  try {
    const url = new URL(u);
    url.searchParams.set('name', 'orig');
    // Some responses omit the format param — twimg requires it alongside name=
    if (!url.searchParams.get('format')) {
      const ext = url.pathname.match(/\.(jpe?g|png|webp)$/i)?.[1] || 'jpg';
      url.searchParams.set('format', ext.toLowerCase().replace('jpeg', 'jpg'));
    }
    return url.toString();
  } catch { return u; }
}

function html(res, content) {
  const base = res._defaultHeaders || SECURITY_HEADERS;
  res.writeHead(200, {
    ...base,
    'Content-Type': 'text/html; charset=utf-8',
    // SPA HTML must not be long-cached: a redeploy ships new code and we want
    // browsers to grab the new index. Hashed sub-resources (logo, video) ship
    // their own Cache-Control via the relevant handlers.
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(content);
}

// ─── Dashboard class ──────────────────────────────────────────────────────────

class DashboardServer {
  constructor(config, logger, db, appState, scanFn, telegram = null, triggerFinder = null, extras = {}) {
    this.config        = config.dashboard;
    this.fullConfig    = config;   // keep reference for telegram.botUsername, etc.
    this.logger        = logger;
    this.db            = db;
    this.appState      = appState;
    this.scanFn        = scanFn;   // callback to trigger manual scan
    this.telegram      = telegram; // TelegramNotifier for bot-username lookup
    this.triggerFinder = triggerFinder; // optional — pro-only Grok reasoning trigger search
    // Optional injected dependencies (8th arg is options object — mirrors admin/server.js).
    // Scorer powers the pro/admin manual-analysis endpoint; without it the
    // endpoint replies 503 instead of crashing.
    this.scorer        = extras.scorer || null;
    // NarrativeClusterer — used by manual-analysis to compute emergence via
    // lookup-based path (same formula scanner uses, see clusterer.js
    // computeSingleTrendEmergence). null falls back to legacy 0-emergence.
    this.clusterer     = extras.clusterer || null;
    this.server        = null;
    this.started       = Date.now();
    this.sseClients    = new Set();  // active Server-Sent Event subscribers
    this._sseKeepAlive = null;
    // In-memory rate-limit rings. Map<userId, number[]> — array of timestamps
    // within the rolling 24h window. Reset on restart, which is fine for a
    // soft cap (only matters for sustained abuse).
    this._manualAnalysisHits = new Map();
    this._catalystHits       = new Map();

    // Brute-force protection on /api/auth/verify. 6-digit codes have only
    // ~20 bits of entropy; without throttling an attacker who knows the
    // sessionId could try ~10/sec and crack a code in days. We cap to 5
    // attempts per session_id. After that the user has to /start over.
    // Map<sessionId, { count: number, firstAttempt: number }>. Cleaned on
    // a 15min sliding window so memory doesn't grow unbounded.
    this._authVerifyAttempts = new Map();
    this._AUTH_VERIFY_MAX = 5;
    this._AUTH_VERIFY_WINDOW_MS = 15 * 60 * 1000;

    // Flood protection on /api/auth/initiate. Each call creates an
    // auth_sessions row; without limit a script can fill the table (the
    // 1-day housekeeping eventually prunes them, but that's a bandaid).
    // Per-IP cap: 10 fresh sessions / 5 minutes is generous for legitimate
    // users (multi-tab, retries) and brutal to scripts. Same Map<ip,
    // {count, firstAttempt}> shape as verify-attempts.
    // NB: behind a reverse proxy without TRUST_PROXY=1, every request
    // looks like the proxy IP - cap then becomes "10/5min for the whole
    // proxy", which is fine for a single VPS. When/if we add trust-proxy
    // support, this Map should key on X-Forwarded-For instead.
    this._authInitiateAttempts = new Map();
    this._AUTH_INITIATE_MAX = 10;
    this._AUTH_INITIATE_WINDOW_MS = 5 * 60 * 1000;

    // Brand logo cache-bust. Compute mtime of assets/logo.png ONCE at boot;
    // SPA embeds it as ?v=<this> on the <img> src. When you replace the
    // file and redeploy, Docker rebuild resets the layer mtime → version
    // changes → URL changes → browser cache miss → fresh bytes. Same
    // mechanic webpack uses for content-hashed bundles.
    // Falls back to startup time when the file is missing (still busts on
    // every restart, which is acceptable for the no-logo case).
    this._logoVersion = (() => {
      try {
        const p = path.join(process.cwd(), 'assets', 'logo.png');
        const s = fs.statSync(p);
        return Math.floor(s.mtimeMs);
      } catch { return this.started; }
    })();

    // Bot username for nav-link to the Telegram bot. Resolves asynchronously
    // at start() — empty string until then. SPA template injects whatever's
    // cached at HTML render time. Falls back to a generic t.me link if empty.
    this._botUsername = '';
  }

  /** Broadcast an event to all connected SSE clients. */
  broadcast(event, data) {
    if (!this.sseClients || this.sseClients.size === 0) return;
    const payload = 'event: ' + String(event || 'message') + '\n' +
                    'data: ' + JSON.stringify(data ?? {}) + '\n\n';
    for (const res of this.sseClients) {
      try { res.write(payload); } catch (e) { /* drop */ }
    }
  }

  start() {
    if (!this.config.enabled) {
      this.logger.info('Dashboard disabled (DASHBOARD_ENABLED=false)');
      return;
    }
    if (!this.config.apiKey) {
      this.logger.warn('DASHBOARD_API_KEY is not set — API requests will be rejected');
    }

    this.server = http.createServer((req, res) => this._handle(req, res));

    this.server.listen(this.config.port, this.config.host, () => {
      this.logger.info(`Dashboard running at http://${this.config.host}:${this.config.port}`);
    });

    this.server.on('error', err => {
      this.logger.error(`Dashboard server error: ${err.message}`);
    });

    // Resolve and cache bot username for the nav Telegram link. getMe() is
    // ~150ms; happens once at start, never again. SPA reads this._botUsername
    // at HTML-render time. Failure → empty string → SPA renders bot link
    // as fallback `t.me/` (still valid, just lands on TG search).
    if (this.telegram && typeof this.telegram.getBotUsername === 'function') {
      this.telegram.getBotUsername()
        .then(username => {
          this._botUsername = username || '';
          if (this._botUsername) {
            this.logger.info(`Dashboard nav bot link → @${this._botUsername}`);
          }
        })
        .catch(e => this.logger.warn(`getBotUsername failed: ${e.message}`));
    }
  }

  /**
   * Graceful shutdown:
   *   1. Stop accepting new connections (server.close)
   *   2. End all active SSE streams cleanly so clients see a normal close
   *      (otherwise they'd retry-loop against a 502 from the LB during deploy)
   *   3. Drop the keep-alive interval
   *   4. Wait up to `timeoutMs` for in-flight requests to drain, then force-exit
   * Returns a promise that resolves when the server is fully closed.
   */
  stop(timeoutMs = 10000) {
    return new Promise((resolve) => {
      // (1) close keep-alive timer
      if (this._sseKeepAlive) { clearInterval(this._sseKeepAlive); this._sseKeepAlive = null; }
      // (2) drain SSE — write a 'bye' event so the SPA can show "reconnecting"
      for (const r of this.sseClients) {
        try {
          r.write('event: bye\ndata: {"reason":"shutdown"}\n\n');
          r.end();
        } catch { /* already closed */ }
      }
      this.sseClients.clear();
      // (3) close listener; existing keep-alive sockets force-closed below
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // (4) hard-cap: if a slow handler is hung, don't block the whole process
      const t = setTimeout(() => {
        try { this.server?.closeAllConnections?.(); } catch {}
        resolve();
      }, timeoutMs);
      t.unref?.();
    });
  }

  // ── Router ──────────────────────────────────────────────────────────────────

  async _handle(req, res) {
    const url    = new URL(req.url, `http://localhost`);
    const path   = url.pathname;
    const method = req.method;

    // Pre-compute the security + CORS headers for this request and stash
    // them on `res` so json()/html()/SSE all share the same baseline.
    res._defaultHeaders = buildHeaders(req);

    // Monkey-patch writeHead so EVERY response (including binary asset
    // handlers, video proxy, error paths) automatically inherits security
    // headers without each handler having to remember to spread them.
    // Caller's explicit headers still win — Object spread order makes the
    // caller's keys override our defaults when they collide.
    const _origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headersOrReason, maybeHeaders) => {
      let statusMsg, hdrs;
      if (typeof headersOrReason === 'string') {
        statusMsg = headersOrReason;
        hdrs = maybeHeaders || {};
      } else {
        hdrs = headersOrReason || {};
      }
      const merged = { ...res._defaultHeaders, ...hdrs };
      return statusMsg ? _origWriteHead(status, statusMsg, merged) : _origWriteHead(status, merged);
    };

    // CORS preflight — only succeed if origin is in the allowlist; otherwise
    // browser will block the actual request anyway, but returning 204 with no
    // ACAO matches the secure-by-default posture (vs old behavior that echoed *).
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...res._defaultHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    // ── Public routes (no auth) ────────────────────────────────────────────
    // Health
    if (path === '/api/health' && method === 'GET') {
      return json(res, 200, { ok: true, uptime: Math.floor((Date.now() - this.started) / 1000), paused: this.appState?.paused ?? false });
    }

    // Auth endpoints — public (they create/verify sessions)
    if (path === '/api/auth/initiate' && method === 'POST') return this._handleAuthInitiate(req, res);
    if (path === '/api/auth/verify'   && method === 'POST') return this._handleAuthVerify(req, res);
    if (path === '/api/auth/status'   && method === 'GET')  return this._handleAuthStatus(req, res, url);

    // Brand logo — public. Static file baked into the Docker image at
    // /app/assets/logo.png (Dockerfile: COPY --chown=node:node . .).
    // Falls through to a 404 if the file is missing; the client SPA has
    // an onError fallback to a 🐱 emoji so the nav never looks broken.
    if (path === '/assets/logo.png' && method === 'GET') {
      return this._handleBrandLogo(req, res);
    }

    // Reddit video proxy — public. <video> elements can't send custom
    // Authorization headers; and the content itself is already a public
    // Reddit CDN stream (we just mux video+audio). Route validates the
    // ?src= query against the v.redd.it pattern, so it can't be abused
    // as a generic proxy.
    if (path.match(/^\/api\/video\/reddit\/[a-z0-9]+\.mp4$/i) && method === 'GET') {
      return this._handleRedditVideo(req, res, path);
    }

    // Twitter video proxy — public. video.twimg.com returns 403 on cross-origin
    // hotlinked <video> plays, so we fetch server-side with a Twitter Referer,
    // cache on disk, and stream with Range support.
    if (path.match(/^\/api\/video\/twitter\/[a-f0-9]{16}\.mp4$/i) && method === 'GET') {
      return this._handleTwitterVideo(req, res, path);
    }

    // ── Bearer-token auth ──────────────────────────────────────────────────
    // Every /api/* route below this point requires a valid session token
    // issued by the Telegram bot login flow. The token is passed as either:
    //   • Authorization: Bearer <token>   (preferred)
    //   • ?token=<token>                  (for EventSource — no custom headers)
    const authHeader = String(req.headers['authorization'] || '');
    const bearerMatch = authHeader.match(/^Bearer\s+([a-f0-9]{64})$/i);
    const token = bearerMatch ? bearerMatch[1] : (url.searchParams.get('token') || '');
    const authUser = token ? this.db.getUserByAuthToken(token) : null;

    if (path.startsWith('/api/')) {
      if (!authUser) {
        res.writeHead(401, {
          ...res._defaultHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer realm="dashboard"',
        });
        return res.end(JSON.stringify({ error: 'Unauthorized - please sign in via Telegram' }));
      }
      req.user = authUser;
      req.authToken = token;
    }

    // Auth routes requiring a session
    if (path === '/api/auth/me'     && method === 'GET')  return this._handleAuthMe(req, res);
    if (path === '/api/auth/avatar' && method === 'GET')  return this._handleAuthAvatar(req, res);
    if (path === '/api/auth/avatar/debug' && method === 'GET') return this._handleAuthAvatarDebug(req, res);
    if (path === '/api/auth/logout' && method === 'POST') return this._handleAuthLogout(req, res);

    // SSE stream — pushed updates from server (new scans, etc.)
    if (path === '/api/stream' && method === 'GET') {
      return this._handleStream(req, res);
    }

    try {
      if (path === '/api/trends'   && method === 'GET')  return this._handleTrends(req, res, url);
      if (path.match(/^\/api\/trends\/\d+$/) && method === 'GET') return this._handleTrend(req, res, path);
      if (path === '/api/stats'    && method === 'GET')  return this._handleStats(req, res, url);
      if (path === '/api/sources'  && method === 'GET')  return this._handleSources(req, res);
      if (path === '/api/tweet-preview'  && method === 'GET') return this._handleTweetPreview(req, res, url);
      if (path === '/api/reddit-preview' && method === 'GET') return this._handleRedditPreview(req, res, url);
      if (path === '/api/scan'     && method === 'POST') return this._handleScan(req, res);
      if (path === '/api/preview'   && method === 'GET')  return this._handlePreview(req, res, url);
      if (path === '/api/config'    && method === 'GET')  return this._handleConfig(req, res);
      if (path === '/api/settings'  && method === 'GET')  return this._handleSettingsGet(req, res);
      if (path === '/api/settings'  && method === 'POST') return this._handleSettingsPost(req, res);
      if (path === '/api/user/threshold'  && method === 'POST') return this._handleUserThresholdPost(req, res);
      if (path === '/api/user/alert-types' && method === 'POST') return this._handleUserAlertTypesPost(req, res);
      if (path.match(/^\/api\/collectors\/[\w_]+\/toggle$/) && method === 'POST') return this._handleCollectorToggle(req, res, path);
      if (path.match(/^\/api\/trends\/\d+\/feedback$/) && method === 'POST') return this._handleTrendFeedback(req, res, path);
      if (path.match(/^\/api\/trends\/\d+\/trigger$/)  && method === 'POST') return this._handleTrendTrigger(req, res, path);
      // Per-user hide / unhide / archive list. /hidden ≠ \d+ so collision-free.
      if (path.match(/^\/api\/trends\/\d+\/hide$/)     && method === 'POST') return this._handleTrendHide(req, res, path);
      if (path.match(/^\/api\/trends\/\d+\/unhide$/)   && method === 'POST') return this._handleTrendUnhide(req, res, path);
      if (path === '/api/trends/hidden'        && method === 'GET')  return this._handleHiddenTrends(req, res);
      if (path === '/api/trends/hidden/clear'  && method === 'POST') return this._handleHiddenTrendsClear(req, res);
      // Per-user favorites (Pro/Admin). POST = add, DELETE = remove,
      // PATCH = edit note. GET /api/favorites returns the list.
      if (path.match(/^\/api\/trends\/\d+\/favorite$/) && method === 'POST')   return this._handleTrendFavoriteAdd(req, res, path);
      if (path.match(/^\/api\/trends\/\d+\/favorite$/) && method === 'DELETE') return this._handleTrendFavoriteRemove(req, res, path);
      if (path.match(/^\/api\/trends\/\d+\/favorite$/) && method === 'PATCH')  return this._handleTrendFavoriteNote(req, res, path);
      if (path === '/api/favorites' && method === 'GET') return this._handleFavorites(req, res);
      if (path === '/api/manual-analysis' && method === 'POST') return this._handleManualAnalysis(req, res);

      // Alert-score history (sparkline). Admin-only for now; will open up
      // later when we trust the visual + retention defaults.
      if (path.match(/^\/api\/trends\/\d+\/alert-history$/) && method === 'GET') return this._handleAlertHistory(req, res, path);

      // SPA fallback — serve dashboard HTML for all non-API routes
      if (!path.startsWith('/api/')) return html(res, this._buildSPA());

      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      this.logger.error(`Dashboard handler error: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  // ── Auth handlers ───────────────────────────────────────────────────────────

  async _handleAuthInitiate(req, res) {
    // Per-IP flood gate. Sweeps stale entries first (cheap O(active-IPs)
    // per call). The connecting IP is whatever Node sees on the socket -
    // that's the proxy IP behind nginx, the real client IP when direct.
    const ip = String(req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    for (const [k, rec] of this._authInitiateAttempts) {
      if (now - rec.firstAttempt > this._AUTH_INITIATE_WINDOW_MS) {
        this._authInitiateAttempts.delete(k);
      }
    }
    const cur = this._authInitiateAttempts.get(ip) || { count: 0, firstAttempt: now };
    if (cur.count >= this._AUTH_INITIATE_MAX) {
      return json(res, 429, { error: 'Too many login attempts. Try again in a few minutes.' });
    }
    cur.count++;
    this._authInitiateAttempts.set(ip, cur);

    try {
      const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
      const sessionId = this.db.createAuthSession(userAgent);
      let botUsername = '';
      try {
        if (this.telegram && typeof this.telegram.getBotUsername === 'function') {
          botUsername = await this.telegram.getBotUsername();
        } else {
          botUsername = (this.fullConfig?.telegram?.botUsername || '').replace(/^@/, '');
        }
      } catch (e) { /* ignore */ }
      const botUrl = botUsername
        ? `https://t.me/${botUsername}?start=auth_${sessionId}`
        : null;
      return json(res, 200, { sessionId, botUrl, botUsername: botUsername || null });
    } catch (err) {
      this.logger.error(`auth/initiate failed: ${err.message}`);
      return json(res, 500, { error: 'Failed to start login' });
    }
  }

  async _handleAuthVerify(req, res) {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }

    const sessionId = String(body?.sessionId || '').trim();
    const code      = String(body?.code || '').trim();
    if (!/^[a-f0-9]{32}$/i.test(sessionId)) return json(res, 400, { error: 'Invalid session' });
    if (!/^\d{6}$/.test(code))              return json(res, 400, { error: 'Code must be 6 digits' });

    // Brute-force gate (see ctor for rationale). Sweep stale entries first so
    // the map doesn't grow forever; cheap O(n) for n ~ active sessions.
    const now = Date.now();
    for (const [sid, rec] of this._authVerifyAttempts) {
      if (now - rec.firstAttempt > this._AUTH_VERIFY_WINDOW_MS) {
        this._authVerifyAttempts.delete(sid);
      }
    }
    const rec = this._authVerifyAttempts.get(sessionId);
    if (rec && rec.count >= this._AUTH_VERIFY_MAX) {
      return json(res, 429, { error: 'Too many attempts. Restart login from /start in the bot.' });
    }

    const result = this.db.verifyAuthCode(sessionId, code);
    if (!result) {
      // Bump attempt counter ONLY on real-looking failures (right format,
      // wrong code). Format errors above already short-circuited.
      const cur = this._authVerifyAttempts.get(sessionId) || { count: 0, firstAttempt: now };
      cur.count++;
      this._authVerifyAttempts.set(sessionId, cur);
      const remaining = Math.max(0, this._AUTH_VERIFY_MAX - cur.count);
      return json(res, 401, {
        error: 'Invalid or expired code',
        attemptsRemaining: remaining,
      });
    }

    // Success — clear any failed-attempt counter for this session
    this._authVerifyAttempts.delete(sessionId);

    return json(res, 200, {
      token: result.token,
      expiresAt: result.tokenExpiresAt,
      user: this._publicUser(result.user),
    });
  }

  _handleAuthStatus(req, res, url) {
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    if (!/^[a-f0-9]{32}$/i.test(sessionId)) return json(res, 400, { error: 'Invalid session' });
    const status = this.db.getAuthSessionStatus(sessionId);
    return json(res, 200, status || { exists: false, verified: false, codeReady: false });
  }

  _handleAuthMe(req, res) {
    // Opportunistic avatar refresh (internally rate-limited to ~6h)
    if (this.telegram && req.user?.id && req.user?.telegram_chat_id) {
      this.telegram.refreshUserAvatar(req.user.telegram_chat_id, req.user.id).catch(() => {});
    }
    return json(res, 200, { user: this._publicUser(req.user) });
  }

  _handleAuthLogout(req, res) {
    try { this.db.revokeAuthToken(req.authToken); } catch (e) { /* ignore */ }
    return json(res, 200, { ok: true });
  }

  /** Strip private fields from a user row for client consumption. */
  _publicUser(user) {
    if (!user) return null;
    return {
      chatId:     String(user.telegram_chat_id || user.chat_id || ''),
      username:   user.username || user.telegram_username || null,
      language:   user.language || 'en',
      plan:       user.plan_name || 'free',
      status:     user.status || 'active',
      threshold:  user.alert_threshold ?? null,
      // Effective ADMIN-side floor (per-preset `alerts.thresholds.alertThreshold`).
      // The actual alert gate compares alertScore against `max(user.threshold,
      // alertFloor)`. Exposed so the dashboard modal can render an honest
      // "would-alert" verdict — without it the client doesn't know the admin
      // floor and would show false-positives if user.threshold < admin floor.
      // Server-side this is read fresh per login response (preset config is
      // app-global state, not a hot path).
      alertFloor: (() => {
        try {
          const cfg = getActivePresetConfig(this.db);
          const v = Number(cfg?.alerts?.thresholds?.alertThreshold);
          return Number.isFinite(v) ? v : null;
        } catch { return null; }
      })(),
      // Subscription filter for the alert-type axis — array of canonical
      // values ('event'|'trend'|'post'). Empty/legacy → all 3 (handled by
      // db.getUserAlertTypes). The settings page uses this to render
      // checkboxes; client never sends raw CSV back, only the array.
      alertTypes: this.db.getUserAlertTypes(user.telegram_chat_id || user.chat_id || ''),
      // Plan entitlements — single source of truth from getPlanEntitlements.
      // Frontend reads these to render 🔒 markers and "X / cap today" counters
      // on Catalyst / manual-analyze surfaces. Caps semantics:
      //   -1 = unlimited (admin), 0 = blocked (free), N>0 = N/day soft cap.
      // sources is the list of source-IDs the user can see in the feed.
      entitlements: getPlanEntitlements(user.plan_name || 'free'),
      subscriptionExpiresAt: user.subscription_expires_at || null,
      // Avatar — present iff we've successfully fetched a profile photo from TG.
      // Cache-busting key: fileUniqueId changes when user updates their photo.
      hasAvatar:  !!user.avatar_file_id,
      avatarKey:  user.avatar_file_unique_id || null,
    };
  }

  // ── Avatar debug — force-refresh + dump status (for triage) ─────────────
  async _handleAuthAvatarDebug(req, res) {
    const user = req.user;
    const info = {
      userId: user?.id,
      chatId: user?.telegram_chat_id,
      username: user?.telegram_username,
      hasTelegram: !!this.telegram,
      hasBot: !!this.telegram?.bot,
      dbColumns: {
        avatar_file_id:        user?.avatar_file_id || null,
        avatar_file_unique_id: user?.avatar_file_unique_id || null,
        avatar_checked_at:     user?.avatar_checked_at || null,
      },
    };

    if (!this.telegram || !this.telegram.bot) {
      return json(res, 200, { ...info, error: 'Telegram bot not attached to dashboard process' });
    }

    try {
      const ok = await this.telegram.refreshUserAvatar(user.telegram_chat_id, user.id, { force: true });
      // Re-read row to show post-state
      const fresh = this.db.getUserByChatId(user.telegram_chat_id);
      return json(res, 200, {
        ...info,
        refreshResult: ok,
        afterRefresh: {
          avatar_file_id:        fresh?.avatar_file_id || null,
          avatar_file_unique_id: fresh?.avatar_file_unique_id || null,
          avatar_checked_at:     fresh?.avatar_checked_at || null,
        },
      });
    } catch (e) {
      return json(res, 200, { ...info, error: e.message, stack: e.stack });
    }
  }

  // ── Avatar proxy ────────────────────────────────────────────────────────
  /**
   * GET /assets/logo.png — brand logo, baked into the Docker image at
   * /app/assets/logo.png by `COPY --chown=node:node . .` in Dockerfile.
   *
   * Resolution order:
   *   1. ./assets/logo.png  (relative to project root / docker workdir)
   *
   * Returns 404 when the file is missing — the SPA has an onError handler
   * that swaps in the 🐱 emoji so the nav never breaks.
   *
   * Long-cached (immutable) because the logo only changes on a redeploy,
   * which busts the cache via a different filename or hard refresh.
   */
  async _handleBrandLogo(req, res) {
    try {
      const logoPath = path.join(process.cwd(), 'assets', 'logo.png');
      const stat = await fs.promises.stat(logoPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Logo not bundled — see assets/README.md' }));
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=86400, immutable',
      });
      const stream = fs.createReadStream(logoPath);
      stream.on('error', (e) => {
        this.logger.warn(`[BrandLogo] read error: ${e.message}`);
        try { res.end(); } catch {}
      });
      stream.pipe(res);
    } catch (e) {
      this.logger.warn(`[BrandLogo] handler error: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'logo handler failed' }));
    }
  }

  // Streams the user's Telegram profile photo via a local disk cache.
  // Cache key: avatar_file_unique_id (stable per-photo across CDN rotations).
  async _handleAuthAvatar(req, res) {
    const user = req.user;
    if (!user?.avatar_file_id) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No avatar' }));
    }
    if (!this.telegram) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Telegram bot not available' }));
    }

    const dir = path.join(process.cwd(), 'data', 'avatars');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    const cacheKey = (user.avatar_file_unique_id || user.avatar_file_id)
      .replace(/[^A-Za-z0-9_-]/g, '_');
    const cachePath = path.join(dir, cacheKey + '.jpg');

    // Serve from disk cache if present
    try {
      const st = fs.statSync(cachePath);
      if (st.size > 0) {
        res.writeHead(200, {
          'Content-Type':  'image/jpeg',
          'Content-Length': st.size,
          'Cache-Control': 'private, max-age=604800, immutable',
        });
        return fs.createReadStream(cachePath).pipe(res);
      }
    } catch { /* miss — fall through to fetch */ }

    // Miss: resolve + download via telegram.fetchFile() which keeps the
    // token-embedded URL inside the telegram module. We never see (or log)
    // the bot-token URL here, eliminating the leak vector.
    try {
      const file = await this.telegram.fetchFile(user.avatar_file_id);
      if (!file) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Telegram CDN error' }));
      }

      res.writeHead(200, {
        'Content-Type':  file.contentType,
        'Cache-Control': 'private, max-age=604800, immutable',
      });

      try { fs.writeFileSync(cachePath, file.buffer); } catch (e) {
        this.logger.warn(`[Avatar] cache write failed: ${e.message}`);
      }
      res.end(file.buffer);
    } catch (e) {
      // Defensive: e.message here is from our own code (not fetch), so no
      // token leak. But we still scrub to err.code in case something below
      // re-introduces the URL.
      this.logger.warn(`[Avatar] proxy failed: ${e.code || e.name || 'unknown'}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Avatar fetch failed' }));
      } else {
        try { res.end(); } catch {}
      }
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  _handleTrends(req, res, url) {
    const requestedHours = parseInt(url.searchParams.get('hours')    || '24',  10);
    // Plan-history cap: Free is capped to 72h (3 days). Paid plans uncapped.
    // Cap silently — if Free sends ?hours=168 (7d), backend honours 72h. SPA
    // also blocks the slider client-side, so this is defence-in-depth.
    const planHistoryHours = getPlanEntitlements(req.user?.plan_name).historyHours;
    const hours = (planHistoryHours > 0) ? Math.min(requestedHours, planHistoryHours) : requestedHours;
    const limit       = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset      = parseInt(url.searchParams.get('offset')      || '0',   10);
    const category    = url.searchParams.get('category')    || null;
    const source      = url.searchParams.get('source')      || null;
    // phase param accepts a comma-separated list (e.g. ?phase=early,forming).
    // Empty/null → no phase restriction. Each chip in the sidebar toggles its
    // value independently; "Все" clears the whole list.
    const phaseRaw    = url.searchParams.get('phase')       || '';
    const phaseList   = phaseRaw.split(',')
      .map(s => s.trim())
      .filter(s => ['early','forming','strong','saturated'].includes(s));
    // minMeme was removed 2026-05-14 — sidebar Adoption filter was rarely used
    // and confused users (the per-row Adoption bar in cards already conveys
    // the score, no need to gate the feed by it). Param silently ignored if
    // older clients still send it.
    const minEmergence = parseInt(url.searchParams.get('minEmergence') || '0', 10);
    // Server-side feed search — added 2026-05-14. Client-side filter alone was
    // unusable beyond 6h windows: the SPA only loads top-LIMIT (=25) trends per
    // page, so any item ranked below #25 was invisible to search. Pushing the
    // filter into SQL means `?q=...` searches the whole window, then LIMIT is
    // applied to matches. Trimmed + capped to 80 chars to keep the query bound.
    const qRaw = (url.searchParams.get('q') || '').trim().slice(0, 80);
    // minPlatforms was removed 2026-05-04 along with cross-platform aggregation.
    // The clusterer's cross-source matcher is unreliable, so we no longer
    // expose a "platforms ≥ N" filter — the param is silently ignored if older
    // clients still send it.

    const sortParam = url.searchParams.get('sort') || 'rank';

    // Sort modes (no per-user personalization — removed 2026-04-27 along with
    // the per-category boost. Rank is now the same global ordering for everyone.)
    let orderBy;
    if      (sortParam === 'time')      orderBy = 'first_seen_at DESC';
    else if (sortParam === 'virality')  orderBy = 'score DESC';
    else if (sortParam === 'meme')      orderBy = "CAST(JSON_EXTRACT(raw_metrics, '$.memePotential') AS INT) DESC";
    else if (sortParam === 'emergence') orderBy = "CAST(JSON_EXTRACT(raw_metrics, '$.emergenceScore') AS INT) DESC";
    else                                orderBy = "CAST(JSON_EXTRACT(raw_metrics, '$.rankScore') AS INT) DESC";

    // Per-user hidden trends — exclude IDs the current user dismissed.
    // chat_id is set after auth middleware; for anonymous (no auth in dev?)
    // hiddenIds is empty so the filter is a no-op.
    const userIdEarly = String(req.user?.telegram_chat_id || '').trim() || null;
    const hiddenIds = userIdEarly ? this.db.getHiddenTrendIdsByChat(userIdEarly, 7) : [];

    // Per-user favorites — pre-fetched once per request so _formatTrend can
    // attach isFavorite via a Set.has() lookup (no per-row DB query).
    const favoriteIds = userIdEarly ? this.db.getFavoriteTrendIds(userIdEarly) : [];
    const favoriteIdSet = new Set(favoriteIds);
    // ?favoritesOnly=1 — Pro/Admin filter that scopes feed to saved-only.
    // Free/test never has favorites (plan-gate), so the filter would
    // return empty for them — which is fine (they shouldn't be hitting it
    // from the SPA in the first place since the toggle is locked).
    const favoritesOnly = url.searchParams.get('favoritesOnly') === '1';

    // Window filter uses last_seen_at, not first_seen_at. The clusterer keeps
    // pulling fresh posts into an existing narrative — last_seen_at advances,
    // first_seen_at stays pinned to when the cluster was born. Filtering on
    // first_seen_at made small windows (esp. 6h) under-report dramatically:
    // a narrative still hot RIGHT NOW but born 8h ago was invisible at 6h.
    // last_seen_at answers "active in this window", which is what the slider
    // means to a user. (Default for new rows is CURRENT_TIMESTAMP, so for
    // brand-new trends the two columns coincide — no regression at 24h.)
    // Cutoff is formatted to match SQLite's stored shape — see sqliteCutoff().
    const cutoff = sqliteCutoff(hours * 3_600_000);
    let query = `SELECT * FROM trends WHERE last_seen_at > ?`;
    const params = [cutoff];

    if (hiddenIds.length > 0) {
      // Use a parameterized IN list — SQLite supports up to 999 params per
      // statement; with retention=7d a sane user won't accumulate that many.
      query += ` AND id NOT IN (${hiddenIds.map(() => '?').join(',')})`;
      params.push(...hiddenIds);
    }
    // Favourites-only filter (Pro/Admin). Returns empty when user has no
    // saves yet — empty IN clause would be a SQL syntax error, so guard it.
    if (favoritesOnly) {
      if (favoriteIds.length === 0) {
        return json(res, 200, { trends: [], total: 0, limit, offset });
      }
      query += ` AND id IN (${favoriteIds.map(() => '?').join(',')})`;
      params.push(...favoriteIds);
    }
    // Plan-source gate: free is locked to reddit + google_trends. Paid plans
    // see all 5. Mirror of alert-dispatcher's plan_source gate so feed and
    // alerts agree on what user can see.
    const planSources = getPlanEntitlements(req.user?.plan_name).sources;
    if (planSources && planSources.length > 0 && planSources.length < 5) {
      const placeholders = planSources.map(() => '?').join(',');
      query += ` AND source IN (${placeholders})`;
      params.push(...planSources);
    }
    if (category)         { query += ` AND category = ?`;                                                                              params.push(category); }
    if (source)           { query += ` AND source = ?`;                                                                                params.push(source); }
    if (phaseList.length > 0) {
      const placeholders = phaseList.map(() => '?').join(',');
      query += ` AND JSON_EXTRACT(raw_metrics, '$.narrativePhase') IN (${placeholders})`;
      params.push(...phaseList);
    }
    if (minEmergence > 0) { query += ` AND CAST(JSON_EXTRACT(raw_metrics, '$.emergenceScore') AS INT) >= ?`;                           params.push(minEmergence); }
    if (qRaw) {
      // Escape SQL LIKE wildcards (%, _, \) so user-typed punctuation is literal.
      // Sqlite LIKE is case-insensitive for ASCII; Cyrillic case-folding requires
      // ICU which we don't load — acceptable tradeoff (titles are mostly EN).
      const like = '%' + qRaw.replace(/[\\%_]/g, c => '\\' + c) + '%';
      query += ` AND (title LIKE ? ESCAPE '\\' OR original_title LIKE ? ESCAPE '\\' OR ai_explanation LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')`;
      params.push(like, like, like, like);
    }

    query += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.db.prepare(query).all(...params);

    // Count with same filters (minus limit/offset)
    const countParams = params.slice(0, -2);
    const countQuery = query.replace(/ORDER BY.*$/, '').replace(/^SELECT \*/, 'SELECT COUNT(*) as c');
    const total = this.db.db.prepare(countQuery).get(...countParams)?.c ?? 0;

    const userId = String(req.user?.telegram_chat_id || '').trim() || null;
    const trends = rows.map(row => this._formatTrend(row, userId, favoriteIdSet));

    return json(res, 200, { trends, total, limit, offset, favoriteCount: favoriteIds.length });
  }

  _handleTrend(req, res, path) {
    const id  = parseInt(path.split('/').pop(), 10);
    const row = this.db.db.prepare(`SELECT * FROM trends WHERE id = ?`).get(id);
    if (!row) return json(res, 404, { error: 'Trend not found' });
    const userId = String(req.user?.telegram_chat_id || '').trim() || null;
    const favSet = userId ? new Set(this.db.getFavoriteTrendIds(userId)) : null;
    return json(res, 200, this._formatTrend(row, userId, favSet));
  }

  _handleStats(req, res, url) {
    const requestedHours = parseInt(url.searchParams.get('hours') || '24', 10);
    // Plan-history cap mirrors _handleTrends.
    const planHistoryHours = getPlanEntitlements(req.user?.plan_name).historyHours;
    const hours = (planHistoryHours > 0) ? Math.min(requestedHours, planHistoryHours) : requestedHours;
    const cutoff = sqliteCutoff(hours * 3_600_000);

    // Plan-source gate (mirror of _handleTrends). Free user's stats reflect
    // only the trends they're allowed to see — otherwise total / by-source /
    // top-narratives leak counts of locked sources back.
    const planSources = getPlanEntitlements(req.user?.plan_name).sources;
    const planFiltered = planSources && planSources.length > 0 && planSources.length < 5;
    const planClause = planFiltered ? ` AND source IN (${planSources.map(() => '?').join(',')})` : '';
    const planParams = planFiltered ? planSources : [];

    // Same semantics as _handleTrends: "active in this window" via last_seen_at,
    // not "born in this window" via first_seen_at. See _handleTrends for why.
    const total = this.db.db.prepare(`SELECT COUNT(*) as c FROM trends WHERE last_seen_at > ?${planClause}`).get(cutoff, ...planParams).c;

    const bySource = this.db.db.prepare(
      `SELECT source, COUNT(*) as count FROM trends WHERE last_seen_at > ?${planClause} GROUP BY source`
    ).all(cutoff, ...planParams);

    const byCategory = this.db.db.prepare(
      `SELECT category, COUNT(*) as count FROM trends WHERE last_seen_at > ?${planClause} GROUP BY category ORDER BY count DESC`
    ).all(cutoff, ...planParams);

    const statsUserId = String(req.user?.telegram_chat_id || '').trim() || null;
    const topTrends = this.db.db.prepare(
      `SELECT * FROM trends WHERE last_seen_at > ?${planClause} ORDER BY CAST(JSON_EXTRACT(raw_metrics, '$.memePotential') AS INT) DESC LIMIT 10`
    ).all(cutoff, ...planParams).map(r => this._formatTrend(r, statsUserId));

    const avgScore = this.db.db.prepare(
      `SELECT AVG(score) as avg FROM trends WHERE last_seen_at > ? AND score > 0${planClause}`
    ).get(cutoff, ...planParams).avg || 0;

    const alerts24h = this.db.db.prepare(
      `SELECT COUNT(*) as c FROM notifications WHERE sent_at > ?`
    ).get(cutoff).c;

    return json(res, 200, {
      period:     `${hours}h`,
      total,
      alerts:     alerts24h,
      avgScore:   Math.round(avgScore),
      bySource,
      byCategory,
      topTrends,
      paused:     this.appState?.paused ?? false,
    });
  }

  _handleSources(req, res) {
    const sources = ['reddit', 'google_trends', 'twitter', 'tiktok', 'x_trends'];
    const cutoff   = sqliteCutoff(60 * 60_000);              // 1h ago
    const cutoff24 = sqliteCutoff(24 * 3_600_000);           // 24h ago

    // Plan-allowed sources for this user. Frontend uses inPlan to render a
    // 🔒 marker on locked sources (free user sees twitter/tiktok/x_trends
    // greyed out with an upgrade hint).
    const planSources = getPlanEntitlements(req.user?.plan_name).sources;

    // Window filter uses last_seen_at (active-in-window), NOT first_seen_at
    // (born-in-window). See _handleTrends for the long-form rationale — TL;DR:
    // clusterer keeps pulling fresh posts into existing narratives so
    // last_seen_at advances while first_seen_at stays pinned at birth.
    // Counting on first_seen_at made the sidebar under-report dramatically
    // for any source where the clusterer is doing its job — a still-hot
    // narrative born 25h ago would not show up at 24h window even though the
    // feed itself showed it (because the feed already used last_seen_at).
    // Sidebar fix landed 2026-05-11 after Twitter showed `0` despite 7+
    // active twitter trends in the feed.
    const result = sources.map(source => {
      const last = this.db.db.prepare(
        `SELECT COUNT(*) as count, MAX(last_seen_at) as last FROM trends WHERE source = ? AND last_seen_at > ?`
      ).get(source, cutoff24);

      const lastHour = this.db.db.prepare(
        `SELECT COUNT(*) as c FROM trends WHERE source = ? AND last_seen_at > ?`
      ).get(source, cutoff).c;

      const enabled = !this.appState.disabledCollectors?.has(source);
      const inPlan = planSources.includes(source);

      return { source, last24h: last.count, lastHour, lastSeen: last.last, enabled, inPlan };
    });

    return json(res, 200, { sources: result });
  }

  /**
   * GET /api/tweet-preview?id=<tweet_id>  OR  ?url=<full_tweet_url>
   *
   * Returns a normalized tweet card for the dashboard hover-preview popup.
   * Cache-first: in-memory LRU with 5-min TTL (positive) / 30s TTL (negative).
   * On miss → fxtwitter.com fetch (no API key, no auth).
   *
   * Auth: requires the same session cookie as the rest of /api/*. We rely on
   * the global auth gate that wraps these routes (see _handle entry); no extra
   * check here.
   */
  async _handleTweetPreview(req, res, url) {
    const idParam  = url.searchParams.get('id') || '';
    const urlParam = url.searchParams.get('url') || '';
    const id = /^\d{5,25}$/.test(idParam) ? idParam : extractTweetId(urlParam);

    if (!id) return json(res, 400, { error: 'Missing or invalid tweet id' });

    // Cache hit
    const cached = tweetPreviewCache.get(id);
    if (cached) {
      const ttl = cached.status === 200 ? TWEET_PREVIEW_TTL_MS : TWEET_PREVIEW_NEG_TTL_MS;
      if (Date.now() - cached.ts < ttl) {
        if (cached.status === 200) {
          return json(res, 200, { ok: true, cached: true, tweet: cached.data });
        }
        return json(res, cached.status, { ok: false, cached: true });
      }
      tweetPreviewCache.delete(id);
    }

    const r = await fetchTweetPreview(id);
    tweetPreviewCacheSet(id, r.status, r.ok ? r.data : null);

    if (r.ok) {
      // Persist fresh engagement back into the trend(s) with this tweet URL
      // so the next /api/trends fetch shows current views/likes/RT/replies.
      // Fire-and-forget — failure here must not break the preview response.
      // The DB call is sync (better-sqlite3) so we don't even await; just
      // try/catch so a malformed row doesn't 500 the user-facing endpoint.
      //
      // updateTwitterEngagement also computes velocity (Δviews / Δhours)
      // from the previous snapshot and returns it so the client can patch
      // its trend state without a full refetch.
      let derivedVelocity = null;
      try {
        const upd = this.db.updateTwitterEngagement(id, r.data.metrics || {});
        if (upd && typeof upd.velocity === 'number') derivedVelocity = upd.velocity;
      } catch (e) {
        this.logger.warn?.(`[TweetPreview] DB update failed for ${id}: ${e.message}`);
      }
      return json(res, 200, {
        ok: true, cached: false, tweet: r.data, velocity: derivedVelocity,
      });
    }
    return json(res, r.status >= 400 && r.status < 600 ? r.status : 502, {
      ok: false, cached: false,
    });
  }

  /**
   * GET /api/reddit-preview?id=<post_id>  OR  ?url=<full_reddit_url>
   *
   * Reddit equivalent of /api/tweet-preview. Fetches from reddit.com's free
   * .json endpoint, caches with the same LRU/TTL pattern, and pushes fresh
   * upvotes/comments back to the trend row via db.updateRedditEngagement.
   */
  async _handleRedditPreview(req, res, url) {
    const idParam  = url.searchParams.get('id') || '';
    const urlParam = url.searchParams.get('url') || '';
    const id = /^[a-z0-9]{4,12}$/i.test(idParam) ? idParam : extractRedditPostId(urlParam);

    if (!id) return json(res, 400, { error: 'Missing or invalid reddit post id' });

    const cached = redditPreviewCache.get(id);
    if (cached) {
      const ttl = cached.status === 200 ? REDDIT_PREVIEW_TTL_MS : REDDIT_PREVIEW_NEG_TTL_MS;
      if (Date.now() - cached.ts < ttl) {
        if (cached.status === 200) {
          return json(res, 200, { ok: true, cached: true, post: cached.data });
        }
        return json(res, cached.status, { ok: false, cached: true });
      }
      redditPreviewCache.delete(id);
    }

    const r = await fetchRedditPreview(id);
    redditPreviewCacheSet(id, r.status, r.ok ? r.data : null);

    if (r.ok) {
      let derivedVelocity = null;
      try {
        const upd = this.db.updateRedditEngagement(id, r.data.metrics || {});
        if (upd && typeof upd.velocity === 'number') derivedVelocity = upd.velocity;
      } catch (e) {
        this.logger.warn?.(`[RedditPreview] DB update failed for ${id}: ${e.message}`);
      }
      return json(res, 200, {
        ok: true, cached: false, post: r.data, velocity: derivedVelocity,
      });
    }
    return json(res, r.status >= 400 && r.status < 600 ? r.status : 502, {
      ok: false, cached: false,
    });
  }

  _handleSettingsGet(req, res) {
    // alertThreshold / minScoreToSave / maxAlertsPerCycle were removed in
    // 2026-05-01 PR-2 (per-preset). They live in settings.presetConfigs now
    // and are admin-server-only. Kept the endpoint for activePreset read.
    const stored = this.db.getAllSettings();
    return json(res, 200, {
      activePreset: stored.activePreset || 'general',
    });
  }

  async _handleSettingsPost(req, res) {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: 'Invalid JSON' }); }

    const saved = {};

    const VALID_PRESETS = new Set(['general', 'animals', 'culture', 'celebrities', 'events']);
    if ('activePreset' in body) {
      if (!VALID_PRESETS.has(body.activePreset)) {
        return json(res, 400, { error: 'Invalid preset' });
      }
      this.db.setSetting('activePreset', body.activePreset);
      saved.activePreset = body.activePreset;
      this.logger.info(`[Dashboard] Search preset changed to: ${body.activePreset}`);
    }

    // alertThreshold / minScoreToSave / maxAlertsPerCycle removed from
    // dashboard's allowed-list in 2026-05-01 PR-2. They became per-preset
    // and the admin server (port 8081) is the only place to edit them now.
    // Anything else POSTed here gets silently ignored.

    this.logger.info(`[Dashboard] Settings updated: ${JSON.stringify(saved)}`);
    return json(res, 200, { ok: true, saved });
  }

  /**
   * POST /api/user/threshold — user sets their personal alertScore sensitivity.
   * This is the single slider the user tunes in dashboard settings: higher =
   * fewer, only very strong alerts; lower = more alerts. Gated by the global
   * floor (admin's alertThreshold) when applied in the notification pipeline.
   */
  async _handleUserThresholdPost(req, res) {
    const user = req.user;
    if (!user) return json(res, 401, { error: 'Not authenticated' });
    let body;
    try { body = await parseBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const val = Math.round(Number(body?.threshold));
    if (isNaN(val) || val < 0 || val > 100) {
      return json(res, 400, { error: 'threshold must be 0-100' });
    }
    this.db.updateUser(user.id, 'alert_threshold', val);
    this.logger.info(`[Dashboard] user ${maskId(user.telegram_chat_id)} alert_threshold -> ${val}`);
    return json(res, 200, { ok: true, threshold: val });
  }

  /**
   * POST /api/user/alert-types — body { types: ['event','trend','post'] }
   * Persists the user's per-type subscription as a CSV in the users table.
   * Empty array is treated by the alert gate as "all" (matching db helper).
   * Reply echoes the canonical post-validation array so the client can
   * reconcile UI state without re-fetching /me.
   */
  async _handleUserAlertTypesPost(req, res) {
    const user = req.user;
    if (!user) return json(res, 401, { error: 'Not authenticated' });
    let body;
    try { body = await parseBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const arr = Array.isArray(body?.types) ? body.types : null;
    if (arr === null) return json(res, 400, { error: 'types must be an array' });
    this.db.setUserAlertTypes(user.telegram_chat_id, arr);
    const saved = this.db.getUserAlertTypes(user.telegram_chat_id);
    this.logger.info(`[Dashboard] user ${maskId(user.telegram_chat_id)} alert_types -> ${saved.join(',')}`);
    return json(res, 200, { ok: true, alertTypes: saved });
  }

  _handleCollectorToggle(req, res, path) {
    // System-wide toggle (affects ALL users' alert pipeline) - admin-only.
    // Pre-fix: any logged-in Free/Pro user could disable Twitter for the
    // entire bot. Now gated to plan_name === 'admin'. The dashboard SPA
    // already hides this button for non-admins; this is the server-side
    // enforcement layer.
    const planName = req.user?.plan_name || 'free';
    if (planName !== 'admin') {
      return json(res, 403, { error: 'Forbidden' });
    }

    const name = path.split('/')[3]; // /api/collectors/:name/toggle
    const disabled = this.appState.disabledCollectors;
    if (disabled.has(name)) {
      disabled.delete(name);
      this.logger.info(`[Dashboard] Collector enabled by admin ${maskId(req.user.telegram_chat_id)}: ${name}`);
    } else {
      disabled.add(name);
      this.logger.info(`[Dashboard] Collector disabled by admin ${maskId(req.user.telegram_chat_id)}: ${name}`);
    }
    // Persist to DB so disabled state survives restarts
    try {
      this.db.setSetting('disabledCollectors', JSON.stringify([...disabled]));
    } catch (e) {
      this.logger.error(`[Dashboard] Failed to persist disabledCollectors: ${e.message}`);
    }
    return json(res, 200, { source: name, enabled: !disabled.has(name) });
  }

  // ── Trend feedback (like / dislike) ───────────────────────────────────────
  async _handleTrendFeedback(req, res, path) {
    const m = path.match(/^\/api\/trends\/(\d+)\/feedback$/);
    if (!m) return json(res, 400, { error: 'Invalid path' });
    const trendId = parseInt(m[1], 10);

    // Authenticated user's Telegram chat_id — unifies votes between bot & web
    const userId = String(req.user?.telegram_chat_id || '').trim();
    if (!userId) return json(res, 401, { error: 'Authenticated user has no chat_id' });
    const planName = req.user?.plan_name || 'free';

    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }

    // `vote` is optional when the client is ONLY updating the reason text on
    // an existing vote — in that case we keep whatever vote the user already
    // has. Validate only when supplied.
    const voteRaw = body?.vote;
    const isVoteUpdate = voteRaw !== undefined && voteRaw !== null;
    let vote = null;
    if (isVoteUpdate) {
      vote = parseInt(voteRaw, 10);
      if (![1, -1, 0].includes(vote)) return json(res, 400, { error: 'vote must be 1, -1 or 0' });
    }

    // Optional free-form reason. Trimmed/capped is handled by db.setFeedbackReason.
    // `null` / empty string explicitly clears any previous reason.
    const reasonProvided = Object.prototype.hasOwnProperty.call(body || {}, 'reason');
    const reasonRaw = reasonProvided ? body.reason : undefined;

    const trend = this.db.getTrendById ? this.db.getTrendById(trendId) : null;
    if (!trend) return json(res, 404, { error: 'Trend not found' });

    // Toggle off if the same vote is sent twice. When the call is reason-only
    // (no vote field), keep the existing vote untouched.
    const prev = this.db.getUserVote ? this.db.getUserVote(trendId, userId) : null;
    let finalVote;
    if (isVoteUpdate) {
      finalVote = (vote !== 0 && prev === vote) ? 0 : vote;

      // Weight follows the authenticated user's plan (same as TG bot reactions).
      const weightingEnabled = this.db?.getSetting?.('feedbackWeightingEnabled', '1') !== '0';
      let weight = 1;
      if (weightingEnabled) {
        const key = 'feedbackWeight' + planName.charAt(0).toUpperCase() + planName.slice(1);
        weight = parseFloat(this.db?.getSetting?.(key, planName === 'admin' ? '3' : planName === 'pro' ? '2' : '1') || '1');
      } else {
        weight = planName === 'admin' ? 1 : 0;
      }
      this.db.recordFeedback(trendId, userId, finalVote, weight, planName);
    } else {
      // Reason-only call. If user has no vote, there's nothing to attach the
      // reason to — surface that explicitly so the UI can prompt to vote first.
      finalVote = prev || 0;
      if (finalVote === 0 && reasonProvided && reasonRaw && String(reasonRaw).trim()) {
        return json(res, 409, { error: 'No active vote to attach a reason to', code: 'no_vote' });
      }
    }

    // Persist reason if the client supplied the field. Skipped when finalVote
    // is 0 (toggled off) — recordFeedback already deleted the row, so there's
    // nothing to attach. Empty string / null explicitly clears it.
    if (reasonProvided && finalVote !== 0) {
      const cleaned = (reasonRaw == null) ? null : String(reasonRaw);
      this.db.setFeedbackReason(trendId, userId, cleaned);
    }

    const stats = this.db.getFeedbackStats(trendId);
    const after = this.db.getUserVoteWithReason
      ? this.db.getUserVoteWithReason(trendId, userId)
      : null;
    return json(res, 200, {
      likes:    stats.likes    || 0,
      dislikes: stats.dislikes || 0,
      score:    stats.weightedScore || 0,
      userVote: finalVote || 0,
      userReason: after?.reason || '',
    });
  }

  /**
   * POST /api/trends/:id/trigger — on-demand "what's driving this trend RIGHT NOW"
   * lookup via Grok reasoning + x_search.
   *
   * Response shape:
   *   200 { text, sources, confidence, fromCache: boolean, searchedAt }
   *   202 { state: 'in-flight' }                  another user is already searching
   *   403 { error, reason: 'plan'|'cooldown', minLeft? }
   *   503 { error, reason: 'disabled' }
   *
   * Behaviour mirrors the Telegram flow — see telegram.js _handleTriggerSearch.
   */
  async _handleTrendTrigger(req, res, path) {
    const m = path.match(/^\/api\/trends\/(\d+)\/trigger$/);
    if (!m) return json(res, 400, { error: 'Invalid path' });
    const trendId = parseInt(m[1], 10);

    if (!this.triggerFinder || !this.triggerFinder.enabled) {
      return json(res, 503, { error: 'Trigger search disabled', reason: 'disabled' });
    }

    const userId = String(req.user?.telegram_chat_id || '').trim();
    if (!userId) return json(res, 401, { error: 'Authenticated user has no chat_id' });
    const planName = req.user?.plan_name || 'free';
    const ent = getPlanEntitlements(planName);

    // Plan gate — free is hard-locked (cap=0). Test/pro have daily caps,
    // admin is unlimited (cap=-1). Per-user 15-min cooldown removed —
    // Catalyst forecast is cheap (~$0.05/call), daily caps are enough.
    if (ent.catalyst === 0) {
      return json(res, 403, { error: 'Catalyst forecast is a Pro-plan feature', reason: 'plan' });
    }

    const trend = this.db.getTrendById ? this.db.getTrendById(trendId) : null;
    if (!trend) return json(res, 404, { error: 'Trend not found' });

    // Cached fast-path — shared across all users, no cap consumed
    const existing = this.db.getTrendTrigger(trendId);
    if (existing && existing.text) {
      return json(res, 200, { ...existing, fromCache: true });
    }

    // Daily cap (per-user, rolling 24h, in-memory). Admin bypass.
    if (ent.catalyst > 0) {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const hits = (this._catalystHits.get(userId) || []).filter(t => now - t < dayMs);
      if (hits.length >= ent.catalyst) {
        return json(res, 403, { error: 'Daily Catalyst limit reached', reason: 'daily_limit', cap: ent.catalyst });
      }
      hits.push(now);
      this._catalystHits.set(userId, hits);
    }

    // DB-level claim — dedupe parallel clicks across TG and dashboard
    const claim = this.db.claimTriggerSearch(trendId, userId);
    if (!claim.claimed) {
      if (claim.state === 'cached' && claim.trend?.trigger_text) {
        // Re-read through getTrendTrigger so cached-race responses include
        // the full forecast shape (phase/window/drivers/risks) instead of
        // only the legacy fields hand-picked from the row.
        const saved = this.db.getTrendTrigger(trendId);
        return json(res, 200, { ...saved, fromCache: true });
      }
      return json(res, 202, { state: 'in-flight' });
    }

    try {
      const result = await this.triggerFinder.findTrigger(trend);
      this.db.saveTrendTrigger(trendId, result);
      const saved = this.db.getTrendTrigger(trendId); // re-read to pick up timestamp
      // Usage counter for plans that show it (test only). Pro/admin omit.
      let usage = null;
      if (shouldShowUsageCounter(planName) && ent.catalyst > 0) {
        const used = (this._catalystHits.get(userId) || []).length;
        usage = { used, cap: ent.catalyst, left: Math.max(0, ent.catalyst - used) };
      }
      return json(res, 200, { ...saved, fromCache: false, usage });
    } catch (err) {
      this.db.releaseTriggerLock(trendId);
      this.logger.error(`Trigger search failed for trend #${trendId}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  // ── Per-user hide / archive ────────────────────────────────────────────────
  // Personal visual filter: clicking ✕ on a feed card stores
  // (trend_id, chat_id) in `hidden_trends`. The /api/trends feed query
  // excludes these IDs for the current user. Cleanup loop in index.js
  // sweeps rows older than HIDDEN_TREND_RETENTION_DAYS (7).

  _handleTrendHide(req, res, path) {
    const m = path.match(/^\/api\/trends\/(\d+)\/hide$/);
    if (!m) return json(res, 400, { error: 'Invalid path' });
    const trendId = parseInt(m[1], 10);
    const userId = String(req.user?.telegram_chat_id || '').trim();
    if (!userId) return json(res, 401, { error: 'Authenticated user has no chat_id' });
    try {
      this.db.hideTrend(trendId, userId);
      return json(res, 200, { ok: true, hidden: true });
    } catch (err) {
      this.logger.warn(`hide trend #${trendId} for ${userId}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  _handleTrendUnhide(req, res, path) {
    const m = path.match(/^\/api\/trends\/(\d+)\/unhide$/);
    if (!m) return json(res, 400, { error: 'Invalid path' });
    const trendId = parseInt(m[1], 10);
    const userId = String(req.user?.telegram_chat_id || '').trim();
    if (!userId) return json(res, 401, { error: 'Authenticated user has no chat_id' });
    try {
      this.db.unhideTrend(trendId, userId);
      return json(res, 200, { ok: true, hidden: false });
    } catch (err) {
      this.logger.warn(`unhide trend #${trendId} for ${userId}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  _handleHiddenTrends(req, res) {
    const userId = String(req.user?.telegram_chat_id || '').trim();
    if (!userId) return json(res, 401, { error: 'Authenticated user has no chat_id' });
    try {
      const rows = this.db.getHiddenTrendsByChat(userId, 7, 200);
      const trends = rows.map(row => {
        const shaped = this._formatTrend(row, userId);
        shaped.hiddenAt = row.hidden_at;
        return shaped;
      });
      return json(res, 200, { trends, retentionDays: 7 });
    } catch (err) {
      this.logger.warn(`hidden list for ${userId}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  _handleHiddenTrendsClear(req, res) {
    const userId = String(req.user?.telegram_chat_id || '').trim();
    if (!userId) return json(res, 401, { error: 'Authenticated user has no chat_id' });
    try {
      const cleared = this.db.clearHiddenTrendsByChat(userId);
      return json(res, 200, { ok: true, cleared });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ── Per-user favorites (Pro/Admin) ───────────────────────────────────────
  // Permanent saves of trends the user wants to keep around. Snapshot stored
  // at save-time via db.addFavorite (see database.js _trendSnapshot) — even
  // if the live trend rolls out of `trends` later, the favorite survives.
  // Plan-gate: free/test get 403 with reason='plan'. Pro/admin pass.

  _favoriteGate(req, res) {
    const userId = String(req.user?.telegram_chat_id || '').trim();
    if (!userId) { json(res, 401, { error: 'Authenticated user has no chat_id' }); return null; }
    const planName = req.user?.plan_name || 'free';
    if (!getPlanEntitlements(planName).favorites) {
      json(res, 403, { error: 'Favorites is a Pro feature', reason: 'plan' });
      return null;
    }
    return userId;
  }

  async _handleTrendFavoriteAdd(req, res, path) {
    const m = path.match(/^\/api\/trends\/(\d+)\/favorite$/);
    if (!m) return json(res, 400, { error: 'Invalid path' });
    const trendId = parseInt(m[1], 10);
    const userId = this._favoriteGate(req, res);
    if (!userId) return;

    let body = {};
    try { body = await parseBody(req); } catch { /* note is optional */ }
    let note = String(body?.note || '').trim();
    if (note.length > 500) note = note.slice(0, 500);
    if (!note) note = null;

    try {
      this.db.addFavorite(userId, trendId, note);
      const count = this.db.countFavoritesByChat(userId);
      return json(res, 200, { ok: true, favorited: true, count, note });
    } catch (err) {
      this.logger.warn(`favorite add #${trendId} for ${maskId(userId)}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  _handleTrendFavoriteRemove(req, res, path) {
    const m = path.match(/^\/api\/trends\/(\d+)\/favorite$/);
    if (!m) return json(res, 400, { error: 'Invalid path' });
    const trendId = parseInt(m[1], 10);
    const userId = this._favoriteGate(req, res);
    if (!userId) return;

    try {
      this.db.removeFavorite(userId, trendId);
      const count = this.db.countFavoritesByChat(userId);
      return json(res, 200, { ok: true, favorited: false, count });
    } catch (err) {
      this.logger.warn(`favorite remove #${trendId} for ${maskId(userId)}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  async _handleTrendFavoriteNote(req, res, path) {
    const m = path.match(/^\/api\/trends\/(\d+)\/favorite$/);
    if (!m) return json(res, 400, { error: 'Invalid path' });
    const trendId = parseInt(m[1], 10);
    const userId = this._favoriteGate(req, res);
    if (!userId) return;

    let body = {};
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    let note = String(body?.note || '').trim();
    if (note.length > 500) note = note.slice(0, 500);

    try {
      const changed = this.db.setFavoriteNote(userId, trendId, note || null);
      if (!changed) return json(res, 404, { error: 'Favorite not found' });
      return json(res, 200, { ok: true, note: note || null });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  _handleFavorites(req, res) {
    const userId = this._favoriteGate(req, res);
    if (!userId) return;

    try {
      const rows = this.db.getFavoritesByChat(userId, 500);
      const favIdSet = new Set(rows.map(r => r.fav_trend_id));
      // For each row: prefer live trend data; fall back to snapshot when
      // the LEFT JOIN missed (trend rolled out). Tag each entry with its
      // note + saved_at so the frontend can render the note inline.
      const trends = rows.map(r => {
        const liveTrend = r.id != null;
        const base = liveTrend ? r : (() => {
          try { return JSON.parse(r.fav_snapshot || '{}'); }
          catch { return null; }
        })();
        if (!base) return null;
        // _formatTrend expects a row-shape with raw_metrics as a string —
        // snapshot stores it as already-stored, so pass as-is.
        const formatted = this._formatTrend(base, userId, favIdSet);
        formatted.favoriteNote = r.fav_note || null;
        formatted.favoriteSavedAt = r.fav_saved_at || null;
        formatted.favoriteSnapshotted = !liveTrend; // UI hint: "saved copy"
        return formatted;
      }).filter(Boolean);
      return json(res, 200, { trends, total: trends.length });
    } catch (err) {
      this.logger.warn(`favorites list for ${maskId(userId)}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  /**
   * POST /api/manual-analysis — pro/admin only.
   *
   * Body: { url: string }
   * Response:
   *   200 { ok, elapsedMs, pipeline, trend: <_formatTrend-shaped> }
   *   400 { error }
   *   403 { error, reason: 'plan'|'cooldown'|'daily', minLeft? }
   *   503 { error, reason: 'disabled' }
   *
   * Does NOT save the trend to the global feed — analyses are private to the
   * user's session. Rate-limited per user (admin bypass): 30s between calls
   * and max 20 / 24h. Stage 2 deep-dive can cost ~5¢, so unlimited access
   * is a footgun even for paying customers.
   */
  // ── Alert score history (sparkline) ────────────────────────────────────
  // GET /api/trends/:id/alert-history -> { points: [{ts, score, positive,
  // penalty, floor, source}, ...], floor: <effective floor at request time> }
  // Admin-only for now (gate symmetric with the dashboard SPA which only
  // renders the Alert verdict panel for plan==="admin"). When we open this
  // up to all plans, drop the planName guard below — the API itself is
  // read-only and trend-scoped, so leaking it more broadly is fine.
  async _handleAlertHistory(req, res, path) {
    const planName = req.user?.plan_name || 'free';
    if (planName !== 'admin') {
      return json(res, 403, { error: 'Forbidden' });
    }
    const m = path.match(/^\/api\/trends\/(\d+)\/alert-history$/);
    if (!m) return json(res, 400, { error: 'Bad path' });
    const trendId = Number(m[1]);
    if (!Number.isFinite(trendId) || trendId <= 0) return json(res, 400, { error: 'Bad trend id' });

    let points = [];
    try { points = this.db.getAlertScoreHistory(trendId, 200); }
    catch (e) {
      this.logger.warn?.(`alert-history fetch failed for trend ${trendId}: ${e.message}`);
      return json(res, 500, { error: e.message });
    }

    // Effective floor at request time — same arithmetic the gate uses,
    // so the sparkline can draw the floor line where it currently sits.
    // Pulled from active preset config (mirrors /api/me alertFloor logic).
    const userFloor = Number(req.user?.alert_threshold) || 0;
    let adminFloor = 0;
    try {
      const cfg = getActivePresetConfig(this.db);
      const v = Number(cfg?.alerts?.thresholds?.alertThreshold);
      if (Number.isFinite(v)) adminFloor = v;
    } catch { /* fall back to 0 */ }
    const floor = Math.max(userFloor, adminFloor);

    return json(res, 200, { points, floor });
  }

  async _handleManualAnalysis(req, res) {
    if (!this.scorer) {
      return json(res, 503, { error: 'Manual analysis unavailable on this server', reason: 'disabled' });
    }
    const userId = String(req.user?.telegram_chat_id || '').trim();
    if (!userId) return json(res, 401, { error: 'Authenticated user has no chat_id' });
    const planName = req.user?.plan_name || 'free';
    const ent = getPlanEntitlements(planName);

    // Plan gate: free is hard-locked (cap=0). Test/pro/admin pass.
    if (ent.manualAnalyze === 0) {
      return json(res, 403, { error: 'Manual analysis is a Pro-plan feature', reason: 'plan' });
    }

    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    const rawUrl = String(body?.url || '').trim();
    if (!rawUrl) return json(res, 400, { error: 'url is required' });
    if (!/^https?:\/\//i.test(rawUrl)) return json(res, 400, { error: 'URL must start with http(s)://' });

    // Rate limit only when the analysis will actually run the scorer. Cache
    // hits cost zero and arrive instantly, so we let them bypass — that
    // keeps a pro user from burning their daily cap on duplicate URL clicks.
    // 30s cooldown stays for everyone except admin (anti-spam, anti-dupe).
    const cacheAge = peekManualAnalysisCache(rawUrl);
    if (cacheAge === null && ent.manualAnalyze > 0) {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const cooldownMs = 30 * 1000;
      const dailyCap = ent.manualAnalyze;
      const hits = (this._manualAnalysisHits.get(userId) || []).filter(t => now - t < dayMs);
      if (hits.length && now - hits[hits.length - 1] < cooldownMs) {
        const secLeft = Math.max(1, Math.ceil((cooldownMs - (now - hits[hits.length - 1])) / 1000));
        return json(res, 403, { error: 'Cooldown active — analysis can take 10-30s', reason: 'cooldown', secLeft });
      }
      if (hits.length >= dailyCap) {
        return json(res, 403, { error: 'Daily limit reached (' + dailyCap + ' / 24h)', reason: 'daily', cap: dailyCap });
      }
      hits.push(now);
      this._manualAnalysisHits.set(userId, hits);
    }

    try {
      const result = await runManualAnalysis({
        scorer: this.scorer,
        db: this.db,
        clusterer: this.clusterer,
        url: rawUrl,
        // save:true so dashboard Analyze submissions land in the shared
        // feed (same as admin's manual-submit path in admin/server.js).
        // Previously save:false made the result private to the caller —
        // operator complained that Analyze from dashboard never showed up
        // in feed while admin manual-analysis did. Both paths now persist;
        // the TG-broadcast on top of save still gates to the admin path
        // (_submitNarrative) — dashboard never spams TG, just adds to feed.
        // Rows get manualSubmitted=true → '🧪 MANUAL' badge in feed cards,
        // so it's visually distinct from collector-found trends.
        save: true,
        logger: this.logger,
        actorId: userId,
      });
      // Adapt scorer output to the dashboard's trend-card shape so TrendModal
      // can render it the same way as a feed item. _formatTrend reads a flat
      // DB row — for a synthetic (in-memory) trend we hand-roll the same fields.
      const t = result.trend;
      const m = t.metrics || {};
      const synthId = 'manual-' + Date.now();
      const shaped = {
        id:              synthId,
        title:           t.title,
        originalTitle:   t.originalTitle || t.title,
        source:          t.source,
        category:        t.category,
        sentiment:       t.sentiment,
        score:           t.score,
        memePotential:   t.memePotential || 0,
        adoptionScore:   t.adoptionScore  ?? t.memePotential ?? 0,
        emergenceScore:  t.emergenceScore ?? 0,
        storyScore:      t.xSearchData?.storyScore ?? t.storyScore ?? 0,
        storyHook:       t.xSearchData?.storyHook ?? t.storyHook ?? '',
        narrativePhase:  t.narrativePhase ?? null,
        rankScore:       t.rankScore      ?? null,
        alertScore:      t.alertScore     ?? null,
        alertBreakdown:  t.alertBreakdown ?? null,
        marketStage:     t.marketStage    ?? null,
        junkPenalty:     t.junkPenalty    ?? 0,
        junkReasons:     t.junkReasons    ?? [],
        velocity:        m.velocity       ?? 0,
        // Engagement passthrough — same shape as feed-row _formatTrend so the
        // modal's metrics row works identically for manual-analysis trends.
        engagement: {
          views:    m.views    ?? m.plays    ?? m.upvotes ?? null,
          likes:    m.likes    ?? null,
          comments: m.comments ?? m.replies  ?? null,
          reposts:  m.retweets ?? m.shares   ?? null,
        },
        manualSubmitted: true,
        aiExplanation:   t.aiExplanation || '',
        whyNow:          t.whyNow || '',
        trigger:         null,
        predictedLifespan: normalizeLifespan(t.predictedLifespan),
        url:             t.url,
        tgMessageUrl:    null,
        userFeedback:    0,
        firstSeen:       new Date().toISOString(),
        lastSeen:        new Date().toISOString(),
        timesSeen:       1,
        imageUrl:        m.imageUrls?.[0] || m.thumbnailUrl || null,
        imageUrls:       Array.isArray(m.imageUrls) ? m.imageUrls.slice(0, 10) : [],
        videoUrl:        m.videoUrl || null,
        feedback:        { likes: 0, dislikes: 0, score: 0, userVote: 0, userReason: '' },
        // Manual-analysis-only extras (the SPA can show these in a debug panel)
        xSearchData:     t.xSearchData || null,
        subjectAliases:  collectSubjectNames({ preStage: t.preStage || null, xSearchData: t.xSearchData || null }).aliases,
      };
      // Usage counter for plans that show it (test only). Skipped on cache
      // hits — those don't consume a daily slot.
      let usage = null;
      if (!result.fromCache && shouldShowUsageCounter(planName) && ent.manualAnalyze > 0) {
        const used = (this._manualAnalysisHits.get(userId) || []).length;
        usage = { used, cap: ent.manualAnalyze, left: Math.max(0, ent.manualAnalyze - used) };
      }
      // Notify all connected dashboards that the feed changed — manual
      // submissions now persist (save:true above), so other tabs / SSE
      // clients should refetch to surface the new trend. Skip on cache
      // hits where no new row was inserted.
      if (!result.fromCache) {
        try { this.broadcast('refresh', { at: Date.now() }); } catch (e) {}
      }
      return json(res, 200, {
        ok: true,
        elapsedMs: result.elapsedMs,
        pipeline: result.pipeline,
        // fromCache + cacheAgeMs let the UI show "from cache, X min ago" so
        // the user understands why a result came back instantly. Cache TTL
        // is 1h; serves any other pro/admin who already analysed this URL.
        fromCache: !!result.fromCache,
        cacheAgeMs: result.cacheAgeMs || 0,
        trend: shaped,
        usage,
      });
    } catch (err) {
      this.logger.error(`[ManualAnalysis] failed for user ${userId}: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  _handleStream(req, res) {
    res.writeHead(200, {
      ...(res._defaultHeaders || SECURITY_HEADERS),
      'Content-Type':        'text/event-stream',
      'Cache-Control':       'no-cache, no-transform',
      'Connection':          'keep-alive',
      'X-Accel-Buffering':   'no',           // disable proxy buffering
    });
    // Handshake event so the client knows the stream is live
    res.write('retry: 3000\n');
    res.write('event: hello\ndata: ' + JSON.stringify({ t: Date.now() }) + '\n\n');

    this.sseClients.add(res);

    // Start keep-alive heartbeat once we have subscribers
    if (!this._sseKeepAlive) {
      this._sseKeepAlive = setInterval(() => {
        for (const r of this.sseClients) {
          try { r.write(': ping\n\n'); } catch (e) { /* drop */ }
        }
      }, 25_000);
    }

    const cleanup = () => {
      this.sseClients.delete(res);
      if (this.sseClients.size === 0 && this._sseKeepAlive) {
        clearInterval(this._sseKeepAlive);
        this._sseKeepAlive = null;
      }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  async _handleScan(req, res) {
    if (this.appState?.paused) {
      return json(res, 409, { error: 'Scanner is paused. Resume it first.' });
    }
    if (this.appState?.scanRunning) {
      return json(res, 409, { error: 'Scan is already running. Try again in a moment.' });
    }
    if (typeof this.scanFn === 'function') {
      // Run in background, don't await
      this.scanFn().catch(e => this.logger.error(`Manual scan error: ${e.message}`));
      return json(res, 202, { message: 'Scan triggered — check logs for progress' });
    }
    return json(res, 503, { error: 'Scan function not available' });
  }

  _handleConfig(req, res) {
    const cfg = this.config;
    return json(res, 200, {
      dashboardPort:  cfg.port,
      version:        '2.0.0',
      paused:         this.appState?.paused ?? false,
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _formatTrend(row, userId = null, favSet = null) {
    let metrics = {};
    try {
      // raw_metrics may already be a parsed object (when called from the
      // favorites snapshot path) — handle both.
      metrics = typeof row.raw_metrics === 'string'
        ? JSON.parse(row.raw_metrics || '{}')
        : (row.raw_metrics || {});
    } catch (e) {}
    // Feedback (likes / dislikes / user's current vote + their attached reason)
    let feedback = { likes: 0, dislikes: 0, score: 0, userVote: 0, userReason: '' };
    try {
      const fb = this.db.getFeedbackStats ? this.db.getFeedbackStats(row.id) : null;
      if (fb) {
        feedback.likes    = fb.likes || 0;
        feedback.dislikes = fb.dislikes || 0;
        feedback.score    = fb.weightedScore || 0;
      }
      if (userId) {
        // Prefer the combined helper so we hydrate vote + reason in one query.
        if (this.db.getUserVoteWithReason) {
          const vr = this.db.getUserVoteWithReason(row.id, userId);
          if (vr) {
            feedback.userVote   = vr.vote || 0;
            feedback.userReason = vr.reason || '';
          }
        } else if (this.db.getUserVote) {
          feedback.userVote = this.db.getUserVote(row.id, userId) || 0;
        }
      }
    } catch (e) {}
    return {
      id:              row.id,
      title:           row.title,
      originalTitle:   row.original_title || row.title,
      source:          row.source,
      category:        row.category,
      // Alert type — orthogonal to category. NULL means legacy/pre-rollout
      // row; the SPA renders no chip in that case (treats as wildcard).
      // Prefer the dedicated column; fall back to the raw_metrics mirror so
      // freshly scored manual submissions that haven't been hydrated yet
      // still surface the type.
      alertType:       row.alert_type || metrics.alertType || null,
      sentiment:       row.sentiment,
      score:           row.score,
      memePotential:   metrics.memePotential || 0,
      adoptionScore:   metrics.adoptionScore  ?? metrics.memePotential ?? 0,
      emergenceScore:  metrics.emergenceScore ?? 0,
      storyScore:      metrics.storyScore     ?? 0,
      storyHook:       metrics.storyHook      ?? '',
      narrativePhase:  metrics.narrativePhase  ?? null,
      rankScore:       metrics.rankScore       ?? null,
      alertScore:      metrics.alertScore      ?? null,
      alertBreakdown:  metrics.alertBreakdown  ?? null,
      marketStage:     metrics.marketStage     ?? null, // [MARKET_STAGE]
      junkPenalty:     metrics.junkPenalty     ?? 0,   // [JUNK_FILTER]
      junkReasons:     metrics.junkReasons     ?? [],  // [JUNK_FILTER]
      velocity:        metrics.velocity        ?? 0,
      // Per-source engagement counts surfaced in TrendModal's metrics grid.
      // Different platforms use different field names; this is the unified
      // shape the modal renders (👁 views · ❤️ likes · 💬 comments · 🔁 reposts).
      // Reddit posts have no views — `upvotes` falls back into the views slot.
      engagement: {
        views:    metrics.views    ?? metrics.plays    ?? metrics.upvotes ?? null,
        likes:    metrics.likes    ?? null,
        comments: metrics.comments ?? metrics.replies  ?? null,
        reposts:  metrics.retweets ?? metrics.shares   ?? null,
      },
      manualSubmitted: metrics.manualSubmitted === true,
      aiExplanation:   row.ai_explanation,
      // Trigger event — empty string when the AI found no explicit cause.
      // UI only renders the row when non-empty.
      whyNow:          row.why_now || '',
      // On-demand Catalyst forecast (filled by Pro click). Forward-looking
      // growth forecast, NOT a recap of the past trigger (`whyNow` covers that).
      // When null/empty, the dashboard renders a "Catalyst" search button.
      trigger: row.trigger_text ? {
        text:        row.trigger_text,
        sources:     (() => { try { const v = JSON.parse(row.trigger_sources || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
        confidence:  row.trigger_confidence | 0,
        phase:       row.trigger_phase  || '',
        window:      row.trigger_window || '',
        drivers:     (() => { try { const v = JSON.parse(row.trigger_drivers || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
        risks:       (() => { try { const v = JSON.parse(row.trigger_risks   || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
        searchedAt:  row.trigger_searched_at,
      } : null,
      // Normalize legacy descriptive form ("flash (hours)") from rows scored
      // before the bare-keyword migration; SPA only knows bare keywords.
      predictedLifespan: normalizeLifespan(row.predicted_lifespan),
      url:             row.url,
      tgMessageUrl:    metrics.tgMessageUrl || null,
      userFeedback:    row.user_feedback || 0,
      firstSeen:       row.first_seen_at,
      lastSeen:        row.last_seen_at,
      timesSeen:       row.times_seen,
      imageUrl:        (() => {
        const raw = metrics.imageUrl || metrics.thumbnailUrl || metrics.thumbnail || null;
        if (!raw) return null;
        // Reddit's b.thumbs.redditmedia.com is a 140×140 thumbnail — drop it so the
        // client falls back to /api/preview (og:image is source-quality).
        if (/b\.thumbs\.redditmedia\.com/i.test(raw)) return null;
        // Same avatar/profile-image filter as imageUrls below — see comment there.
        if (/\/profile_images\//i.test(raw)) return null;
        if (/_(normal|bigger|mini|400x400)\.(jpe?g|png|webp)(\?|$)/i.test(raw)) return null;
        return raw;
      })(),
      // Reject:
      //   - reddit b.thumbs CDN (low-quality 70x70 cards, useless for modal)
      //   - Twitter profile-image URLs (avatars). Legacy DB rows from older
      //     collector versions sometimes have @user pfp leaked into imageUrls;
      //     they render as a tiny round portrait inside the 440px carousel
      //     and look like a layout bug. Filter at the boundary so neither
      //     feed nor modal sees them. Pattern matches both pbs.twimg.com
      //     /profile_images/ path AND any URL ending with _normal/_bigger/
      //     _400x400 size suffix that's only used for avatars.
      imageUrls:       Array.isArray(metrics.imageUrls)
        ? metrics.imageUrls.filter(u =>
            u
            && !/b\.thumbs\.redditmedia\.com/i.test(u)
            && !/\/profile_images\//i.test(u)
            && !/_(normal|bigger|mini|400x400)\.(jpe?g|png|webp)(\?|$)/i.test(u)
          ).slice(0, 10)
        : [],
      videoUrl:        (() => {
        const v = metrics.videoUrl;
        if (!v) return null;
        // For Reddit DASH videos, route through our muxing proxy so the
        // browser gets an MP4 with audio (ffmpeg muxes video+audio lazily).
        // Pass the original URL as ?src= — the resolution segment varies
        // (DASH_720 / DASH_480 / …) and we want the proxy to fetch the
        // exact stream Reddit indexed for this post.
        const m = /^https:\/\/v\.redd\.it\/([a-z0-9]+)\//i.exec(v);
        if (m) return `/api/video/reddit/${m[1]}.mp4?src=${encodeURIComponent(v)}`;
        // Twitter — video.twimg.com 403s on hotlink. Route through our proxy.
        if (/^https:\/\/video\.twimg\.com\//i.test(v) && /\.mp4(\?|$)/i.test(v)) {
          const id = createHash('sha1').update(v).digest('hex').slice(0, 16);
          return `/api/video/twitter/${id}.mp4?src=${encodeURIComponent(v)}`;
        }
        return v;
      })(),
      // X Trends only: source tweets that fed this trend's aggregated metrics.
      // Rendered in TrendModal as a clickable list. Trimmed to the fields the
      // UI needs (no avatars / hashtags) — keeps the row payload small.
      topTweets: Array.isArray(metrics.topTweets)
        ? metrics.topTweets.slice(0, 10).map(t => ({
            id:       t.id || null,
            url:      t.url || null,
            author:   t.author || null,
            text:     (t.text || '').substring(0, 280),
            views:    t.views    || 0,
            likes:    t.likes    || 0,
            retweets: t.retweets || 0,
            replies:  t.replies  || 0,
          }))
        : null,
      feedback,
      // Favorite flag — true if this trend is in the caller's favorites set.
      // favSet is pre-fetched once per feed request (see _handleTrends) so
      // this is a single Set.has() check per row, not a per-row DB query.
      isFavorite: favSet ? favSet.has(row.id) : false,
      // Subject-name highlight signals. Aliases are pre-computed server-side
      // (Gemini visual+audio + Stage 2 Grok + nano text NER, with blacklist).
      // The SPA highlights any alias inside the title / whyNow / aiExplanation
      // with a CSS accent. Empty array → no highlighting (no overhead).
      subjectAliases: collectSubjectNames({
        preStage: metrics.preStage || null,
        xSearchData: metrics.xSearchData || null,
      }).aliases,
    };
  }

  async _handlePreview(req, res, url) {
    const target = url.searchParams.get('url');
    if (!target) return json(res, 400, { error: 'url required' });
    try {
      const u = new URL(target);
      if (!['http:', 'https:'].includes(u.protocol)) return json(res, 400, { error: 'invalid url' });

      const isTwitter = /^https?:\/\/(www\.)?(twitter|x)\.com\//i.test(target);
      const isTiktok  = /^https?:\/\/(www\.|vm\.)?tiktok\.com\//i.test(target);

      // ── Twitter/X: use api.fxtwitter.com JSON API ────────────────────────
      // Use /i/status/{id} path — doesn't require a valid username (avoids 'unknown' author issue).
      if (isTwitter) {
        const m = target.match(/(?:twitter|x)\.com\/[^/?#]+\/status\/(\d+)/i);
        if (!m) return json(res, 200, { imageUrl: null });
        const [, tweetId] = m;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        try {
          const r = await fetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Catalyst/3.0', 'Accept': 'application/json' },
          });
          clearTimeout(timer);
          if (!r.ok) {
            this.logger.info(`[Preview] fxtwitter ${r.status} for tweet ${tweetId}`);
            return json(res, 200, { imageUrl: null });
          }
          const data = await r.json();
          // Collect media from main tweet AND quoted/reply-parent tweet. For
          // each media entry: photo → .url (full-res), video → .thumbnail_url
          // (frame). Force pbs.twimg.com to original resolution via upgrade.
          const collectFrom = (list, bucket) => {
            if (!Array.isArray(list)) return;
            for (const m of list) {
              const raw = m?.type === 'photo'
                ? (m.url || m.thumbnail_url)
                : (m?.thumbnail_url || m?.url);
              const u = raw ? upgradeTwimgUrl(raw) : null;
              if (!u || bucket.includes(u)) continue;
              // Avatar / profile-image guard — fxtwitter shouldn't return
              // these in media.all, but defensive filter prevents legacy
              // payload variants leaking pfp URLs into the carousel.
              if (/\/profile_images\//i.test(u)) continue;
              if (/_(normal|bigger|mini|400x400)\.(jpe?g|png|webp)(\?|$)/i.test(u)) continue;
              bucket.push(u);
            }
          };
          const urls = [];
          collectFrom(data?.tweet?.media?.all, urls);
          collectFrom(data?.tweet?.quote?.media?.all, urls);
          collectFrom(data?.tweet?.replying_to?.media?.all, urls);
          const imageUrl = urls[0] || null;
          this.logger.info(`[Preview] tweet ${tweetId} → ${urls.length} image(s) (main + quote)`);
          return json(res, 200, { imageUrl, imageUrls: urls });
        } catch (err) {
          clearTimeout(timer);
          this.logger.info(`[Preview] fxtwitter fetch error for tweet ${tweetId}: ${err.message}`);
          return json(res, 200, { imageUrl: null });
        }
      }

      // ── Reddit: fetch post JSON and pick source-quality image ────────────
      const isReddit = /^https?:\/\/(www\.|old\.|new\.)?reddit\.com\//i.test(target);
      if (isReddit) {
        try {
          const jsonUrl = target.replace(/\/?(\?.*)?$/, '') + '.json?raw_json=1';
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          const r = await fetch(jsonUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Catalyst/3.0)',
              'Accept': 'application/json',
            },
          });
          clearTimeout(timer);
          if (r.ok) {
            const data = await r.json();
            const post = data?.[0]?.data?.children?.[0]?.data;
            if (post) {
              const directUrl = post.url_overridden_by_dest || post.url;
              let imageUrl = null;
              if (directUrl && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(directUrl)) imageUrl = directUrl;
              else if (post.preview?.images?.[0]?.source?.url) imageUrl = post.preview.images[0].source.url;
              else if (post.preview?.reddit_video_preview?.fallback_url) imageUrl = post.preview.reddit_video_preview.fallback_url;
              else if (post.is_gallery && post.media_metadata) {
                const firstId = post.gallery_data?.items?.[0]?.media_id;
                const item = firstId && post.media_metadata[firstId];
                imageUrl = item?.s?.u || item?.s?.gif || null;
              }
              if (imageUrl) return json(res, 200, { imageUrl });
            }
          }
        } catch (e) { /* fall through to og:image */ }
      }

      // ── TikTok: official oEmbed JSON endpoint ────────────────────────────
      if (isTiktok) {
        const videoIdMatch = target.match(/\/video\/(\d+)/);
        if (videoIdMatch) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          try {
            const r = await fetch(
              `https://www.tiktok.com/oembed?url=${encodeURIComponent(target)}`,
              { signal: controller.signal, headers: { 'User-Agent': 'Catalyst/3.0', 'Accept': 'application/json' } }
            );
            clearTimeout(timer);
            if (r.ok) {
              const data = await r.json();
              return json(res, 200, { imageUrl: data.thumbnail_url || null });
            }
          } catch { clearTimeout(timer); }
        }
        return json(res, 200, { imageUrl: null });
      }

      // ── Generic: og:image from HTML ──────────────────────────────────────
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const r = await fetch(target, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Catalyst/3.0)' },
      });
      clearTimeout(timer);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('text/html')) return json(res, 200, { imageUrl: null });
      const html = await r.text();
      const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
      return json(res, 200, { imageUrl: ogImage || null });
    } catch {
      return json(res, 200, { imageUrl: null });
    }
  }

  // ── Reddit video proxy ────────────────────────────────────────────────────
  // Serves muxed (video+audio) Reddit MP4s out of the same ffmpeg cache used
  // by Telegram alerts. If the file isn't cached yet, we kick off a mux pass
  // on demand and stream the result. Supports HTTP Range so the browser can
  // seek and start playback before the whole file is buffered.
  async _handleRedditVideo(req, res, reqPath) {
    try {
      const id = reqPath.match(/\/api\/video\/reddit\/([a-z0-9]+)\.mp4$/i)?.[1];
      if (!id) { res.writeHead(400).end('bad id'); return; }

      // Pull the original v.redd.it source from ?src= so we mux the exact
      // stream Reddit indexed (resolution segment varies per post).
      const u = new URL(req.url, 'http://localhost');
      const srcRaw = u.searchParams.get('src') || '';
      const sourceUrl = /^https:\/\/v\.redd\.it\/[a-z0-9]+\//i.test(srcRaw)
        ? srcRaw
        : `https://v.redd.it/${id}/DASH_720.mp4`;  // best-effort fallback

      const cacheDir = path.join(process.cwd(), 'data', 'video-cache');
      const filePath = path.join(cacheDir, `${id}.mp4`);

      // Cache miss — mux on demand. Telegram helper handles audio discovery
      // and ffmpeg invocation; returns null if no audio / ffmpeg missing.
      if (!fs.existsSync(filePath)) {
        if (!this.telegram?._muxRedditVideo) {
          res.writeHead(503).end('video muxer unavailable');
          return;
        }
        const muxed = await this.telegram._muxRedditVideo(sourceUrl);
        if (!muxed || !fs.existsSync(filePath)) {
          // No audio track or mux failed — 302 to the silent original so
          // the <video> tag still plays something.
          res.writeHead(302, { Location: sourceUrl });
          res.end();
          return;
        }
      }

      // Range-aware streaming — browsers send Range for video seeking.
      const stat = fs.statSync(filePath);
      const total = stat.size;
      const range = req.headers.range;

      // Common headers — allow caching (content is immutable per id)
      const baseHeaders = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400, immutable',
      };

      if (!range) {
        res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end   = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } catch (err) {
      this.logger?.warn?.(`[Video] proxy error: ${err.message}`);
      try { res.writeHead(500).end('video proxy error'); } catch {}
    }
  }

  // Twitter video proxy. video.twimg.com hotlink-protects and returns 403 when
  // a <video> element plays it cross-origin (no Referer). We fetch server-side
  // with a Twitter Referer + browser UA, cache to disk, then stream with Range.
  async _handleTwitterVideo(req, res, reqPath) {
    try {
      const id = reqPath.match(/\/api\/video\/twitter\/([a-f0-9]{16})\.mp4$/i)?.[1];
      if (!id) { res.writeHead(400).end('bad id'); return; }

      const u = new URL(req.url, 'http://localhost');
      const srcRaw = u.searchParams.get('src') || '';
      // Strict allow-list — only genuine video.twimg.com MP4s, no open proxy.
      if (!/^https:\/\/video\.twimg\.com\/[^\s]+\.mp4(\?|$)/i.test(srcRaw)) {
        res.writeHead(400).end('bad src');
        return;
      }

      const cacheDir = path.join(process.cwd(), 'data', 'video-cache');
      const filePath = path.join(cacheDir, `tw_${id}.mp4`);

      if (!fs.existsSync(filePath)) {
        try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const upstream = await fetch(srcRaw, {
            signal: controller.signal,
            headers: {
              'Referer': 'https://x.com/',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
              'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.5',
            },
          });
          if (!upstream.ok || !upstream.body) {
            throw new Error(`upstream ${upstream.status}`);
          }
          const partPath = filePath + '.part';
          const fileStream = fs.createWriteStream(partPath);
          await new Promise((resolve, reject) => {
            const reader = upstream.body.getReader();
            const pump = async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  fileStream.write(value);
                }
                fileStream.end();
                fileStream.on('finish', resolve);
                fileStream.on('error', reject);
              } catch (e) { reject(e); }
            };
            pump();
          });
          fs.renameSync(partPath, filePath);
        } catch (err) {
          this.logger?.warn?.(`[Video] twitter fetch failed (${err.message}) — 302 fallback`);
          try { fs.unlinkSync(filePath + '.part'); } catch {}
          res.writeHead(302, { Location: srcRaw });
          res.end();
          return;
        } finally {
          clearTimeout(timer);
        }
      }

      const stat = fs.statSync(filePath);
      const total = stat.size;
      const range = req.headers.range;

      const baseHeaders = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400, immutable',
      };

      if (!range) {
        res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end   = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } catch (err) {
      this.logger?.warn?.(`[Video] twitter proxy error: ${err.message}`);
      try { res.writeHead(500).end('video proxy error'); } catch {}
    }
  }

  // ── Embedded SPA ────────────────────────────────────────────────────────────

  _buildSPA() {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Catalyst — Degen Intelligence</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"><\/script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"><\/script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');

    /* ===== THEME SYSTEM (rewritten 2026-05-06) =====
       2 dark themes:
         ink   — pure black + X-blue          (default, no data-theme attribute)
         tide  — deep navy + cyan/aqua accent (crypto-terminal vibe)

       Design principles:
         • One accent colour per theme, used sparingly
         • Borders are translucent at low alpha — white in ink, cool steel-blue in tide
         • Surfaces use very subtle top-down gradients via box-shadow
           inset 0 1px 0 rgba(255,255,255,.04) for the "glassy" feel
         • Semantic state colours (green/red/orange/yellow) stay constant
           across themes so OK/error signals don't shift hue per theme

       Component colours should use var(--accent), var(--accent-rgb), etc.
       so they re-tint on theme change. */
    :root {
      /* ── pulse (default) — X true-black + green primary ── */
      /* Was ink (X-blue) before 2026-05-19 redesign — old palette moved to   */
      /* body[data-theme="ink"] below for users who prefer it.                 */
      --bg:          #000000;
      --surface:     #0a0a0a;
      --surface2:    #16181c;
      --card:        #16181c;
      --card2:       #1c1f24;
      --card3:       #232730;
      --border:      rgba(239,243,244,.08);
      --border2:     rgba(239,243,244,.14);
      --border3:     rgba(239,243,244,.22);
      --text:        #e7e9ea;
      --text2:       #c4c8cc;
      --muted:       #71767b;
      --dim:         #4d5258;

      /* PRIMARY — green (was #1d9bf0) */
      --accent:      #4ade80;
      --accent2:     #86efac;
      --accent-rgb:  74,222,128;
      --accent-glow: rgba(74,222,128,.16);

      /* SECONDARY — X-blue (was primary, now used for manual/links/external) */
      --secondary:       #1d9bf0;
      --secondary-rgb:   29,155,240;
      --secondary-glow:  rgba(29,155,240,.16);

      /* TERTIARY — amber for saturated/decay/warning */
      --warn:        #f59e0b;
      --warn-rgb:    245,158,11;
      --warn-glow:   rgba(245,158,11,.12);

      /* Semantic state palette — kept constant across themes so OK/error
         signals don't shift hue per theme. Tuned to match X's own
         verified-green / red and a slightly muted orange. */
      --green:       #00ba7c;
      --green2:      #4ed6a4;
      --green-rgb:   0,186,124;
      --red:         #f4212e;
      --red2:        #ff6b6b;
      --red-rgb:     244,33,46;
      --orange:      #ffa726;
      --orange2:     #ffcc80;
      --orange-rgb:  255,167,38;
      --yellow:      #ffd400;
      --yellow2:     #ffe566;
      --blue:        #1d9bf0;
      --pink:        #f91880;
      --teal:        #00ba7c;
      --purple:      #8b5cf6;

      /* Radius scale — sharp (new) */
      --r1:          2px;
      --r2:          3px;
      --r3:          4px;
      --radius:      10px;
      --radius-sm:   8px;
      --radius-xs:   6px;
      --shadow:      0 4px 20px rgba(0,0,0,.6);
      --shadow-lg:   0 8px 40px rgba(0,0,0,.75);
      /* Glass effect tokens — used by .feed-card, .sheet, .session-bar
         to get a "glossy surface" look. Subtle inset highlight reads as
         light catching the top edge of a panel. */
      --glass:       rgba(255,255,255,.03);
      --glass2:      rgba(255,255,255,.055);
      --gloss-top:   inset 0 1px 0 rgba(255,255,255,.04);
      --gloss-edge:  inset 0 0 0 1px rgba(255,255,255,.02);
    }

    /* ── ink — preserved X-blue palette for users who liked the old default ── */
    body[data-theme="ink"] {
      --bg:          #000000;
      --surface:     #0a0a0a;
      --surface2:    #16181c;
      --card:        #16181c;
      --card2:       #1c1f24;
      --card3:       #232730;
      --border:      rgba(239,243,244,.08);
      --border2:     rgba(239,243,244,.14);
      --border3:     rgba(239,243,244,.22);
      --text:        #e7e9ea;
      --text2:       #c4c8cc;
      --muted:       #71767b;
      --dim:         #4d5258;

      /* PRIMARY back to X-blue (this theme = "ink") */
      --accent:      #1d9bf0;
      --accent2:     #4cb1ff;
      --accent-rgb:  29,155,240;
      --accent-glow: rgba(29,155,240,.16);

      /* SECONDARY — green demoted */
      --secondary:       #4ade80;
      --secondary-rgb:   74,222,128;
      --secondary-glow:  rgba(74,222,128,.16);

      /* TERTIARY shared across themes */
      --warn:        #f59e0b;
      --warn-rgb:    245,158,11;
      --warn-glow:   rgba(245,158,11,.12);

      /* Semantic state palette (same as root) */
      --green:       #00ba7c;
      --green2:      #4ed6a4;
      --green-rgb:   0,186,124;
      --red:         #f4212e;
      --red2:        #ff6b6b;
      --red-rgb:     244,33,46;
      --orange:      #ffa726;
      --orange2:     #ffcc80;
      --orange-rgb:  255,167,38;
      --yellow:      #ffd400;
      --yellow2:     #ffe566;
      --blue:        #1d9bf0;
      --pink:        #f91880;
      --teal:        #00ba7c;
      --purple:      #8b5cf6;

      /* Radius scale — sharp (new) */
      --r1:          2px;
      --r2:          3px;
      --r3:          4px;
      --radius:      10px;
      --radius-sm:   8px;
      --radius-xs:   6px;
      --shadow:      0 4px 20px rgba(0,0,0,.6);
      --shadow-lg:   0 8px 40px rgba(0,0,0,.75);
      --glass:       rgba(255,255,255,.03);
      --glass2:      rgba(255,255,255,.055);
      --gloss-top:   inset 0 1px 0 rgba(255,255,255,.04);
      --gloss-edge:  inset 0 0 0 1px rgba(255,255,255,.02);
    }

    /* ── tide — deep navy + cyan/aqua accent ── */
    body[data-theme="tide"] {
      --bg:          #0a1622;
      --surface:     #0f1c2a;
      --card:        #14202e;
      --card2:       #1a2837;
      --card3:       #213244;
      --border:      rgba(115,168,210,.10);
      --border2:     rgba(115,168,210,.18);
      --border3:     rgba(115,168,210,.28);
      --text:        #d6e1ec;
      --text2:       #aebccc;
      --muted:       #7387a0;
      --dim:         #4a5b72;
      --accent:      #4dd4e0;
      --accent2:     #7ce8f0;
      --accent-rgb:  77,212,224;
      --accent-glow: rgba(77,212,224,.16);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body { height: 100%; overflow: hidden; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.18); }

    /* Main feed scrollbar — fat and clearly visible so it's easy to grab
       without fighting the adjacent column resizer handle. */
    .main-feed::-webkit-scrollbar { width: 14px; }
    .main-feed::-webkit-scrollbar-track {
      background: rgba(255,255,255,.02);
      border-left: 1px solid var(--border);
    }
    .main-feed::-webkit-scrollbar-thumb {
      background: rgba(var(--accent-rgb), .35);
      border: 3px solid transparent;
      background-clip: padding-box;
      border-radius: 10px;
      min-height: 40px;
    }
    .main-feed::-webkit-scrollbar-thumb:hover {
      background: rgba(var(--accent-rgb), .6);
      background-clip: padding-box;
    }
    .main-feed::-webkit-scrollbar-thumb:active {
      background: rgba(var(--accent-rgb), .85);
      background-clip: padding-box;
    }
    /* Firefox */
    .main-feed { scrollbar-width: auto; scrollbar-color: rgba(var(--accent-rgb), .45) transparent; }

    /* ── Animations ── */
    @keyframes pulse    { 0%,100%{opacity:1} 50%{opacity:.2} }
    @keyframes spin     { to { transform: rotate(360deg); } }
    @keyframes fadeIn   { from { opacity:0; transform: translateY(5px); } to { opacity:1; transform: translateY(0); } }
    @keyframes slideIn  { from { opacity:0; transform: translateX(-10px); } to { opacity:1; transform: translateX(0); } }
    @keyframes shimmer  { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    @keyframes glow     { 0%,100% { box-shadow: 0 0 6px rgba(var(--accent-rgb), .3); } 50% { box-shadow: 0 0 16px rgba(var(--accent-rgb), .5); } }

    /* ── Nav ── */
    .nav {
      position: sticky; top: 0; z-index: 200;
      /* 2026-05-01: theme-tied bg — was hardcoded rgba(12,12,22) blue tint
         from the old midnight palette, looked off against the new ink theme
         which is pure #000. var(--bg) → var(--surface) gradient gives just
         enough elevation to separate nav from content without a colour shift. */
      background: linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%);
      backdrop-filter: blur(18px) saturate(1.3);
      -webkit-backdrop-filter: blur(18px) saturate(1.3);
      border-bottom: 1px solid var(--border);
      padding: 0 18px;
      height: 50px;
      display: flex; align-items: center; gap: 14px;
      box-shadow: 0 1px 0 rgba(var(--accent-rgb), .04), 0 6px 16px rgba(0,0,0,.25);
    }
    .nav::after {
      content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
      background: linear-gradient(90deg, transparent 0%, rgba(var(--accent-rgb), .22) 20%, rgba(var(--accent-rgb), .22) 80%, transparent 100%);
      pointer-events: none;
    }
    .nav-logo {
      display: flex; align-items: center; gap: 9px;
      font-size: 15px; font-weight: 800; letter-spacing: -0.5px;
      color: var(--text);
      white-space: nowrap;
    }
    .nav-logo-icon {
      font-size: 22px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      /* Bumped 28→38 (2026-05-01) — at 28px the cat-outline artwork was
         too small to read in the nav. 38 fits comfortably in the 50px
         nav bar (50−2×6 padding = ample headroom). */
      width: 38px; height: 38px; border-radius: 10px;
      background: linear-gradient(135deg, rgba(var(--accent-rgb), .25), rgba(var(--accent-rgb), .06));
      border: 1px solid rgba(var(--accent-rgb), .32);
      box-shadow: 0 2px 12px rgba(var(--accent-rgb), .22), inset 0 1px 0 rgba(255,255,255,.06);
      overflow: hidden;
      transition: background .15s, border-color .15s, box-shadow .15s, transform .18s;
    }
    .nav-logo:hover .nav-logo-icon {
      transform: scale(1.04);
      box-shadow: 0 3px 16px rgba(var(--accent-rgb), .32), inset 0 1px 0 rgba(255,255,255,.08);
    }
    /* Logo PNG — fills the badge edge-to-edge. object-fit: contain keeps
       original aspect ratio. For PNGs with a transparent background the
       teal-gradient badge shows through as a subtle frame ("подсветка"
       in the original Catalyst nav design). For PNGs with their own
       solid background, the artwork covers the whole square.
       2026-05-01: dropped 3px inset — at 38×38 the artwork was eating
       only 32×32 visually, looked too small inside the frame. */
    .nav-logo-img {
      width: 100%; height: 100%;
      object-fit: contain;
      display: block;
    }
    .nav-logo-text {
      background: linear-gradient(180deg, #fff 0%, #cfd4ff 100%);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    /* Top-right nav buttons (account + settings shortcut) */
    .nav-icon-btn {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 5px 10px 5px 6px;
      background: rgba(255,255,255,.025);
      border: 1px solid var(--border2);
      border-radius: 999px;
      color: var(--text2);
      font-size: 11px; font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: all .15s;
      letter-spacing: .1px;
      line-height: 1;
    }
    .nav-icon-btn:hover {
      color: var(--text);
      border-color: rgba(var(--accent-rgb), .35);
      background: rgba(var(--accent-rgb), .06);
    }
    .nav-icon-btn.active {
      color: var(--accent2);
      background: var(--accent-glow);
      border-color: rgba(var(--accent-rgb), .4);
    }
    .nav-icon-btn-ico {
      font-size: 14px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      margin: -2px 0;
    }
    .nav-icon-btn[aria-label] {
      padding: 5px;
      width: 32px; height: 32px;
      justify-content: center;
    }
    .nav-account-avatar {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border-radius: 50%;
      background: linear-gradient(135deg, rgba(var(--accent-rgb), .35), rgba(var(--accent-rgb), .12));
      border: 1px solid rgba(var(--accent-rgb), .35);
      color: var(--text); font-size: 11px; font-weight: 800;
      letter-spacing: 0; margin: -2px 0;
      overflow: hidden;
    }
    .nav-account-avatar img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .nav-account-name {
      max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .nav-sep {
      width: 1px; height: 18px;
      background: linear-gradient(180deg, transparent, var(--border2), transparent);
    }
    .nav-subtitle {
      /* Absolutely centered across the whole nav bar, independent of logo/button widths */
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      font-size: 9px; color: var(--dim); letter-spacing: 1.6px;
      text-transform: uppercase; font-weight: 700;
      pointer-events: none;
      white-space: nowrap;
    }
    /* On narrow screens where centered text would overlap buttons, hide it */
    @media (max-width: 900px) {
      .nav-subtitle { display: none; }
    }
    .nav-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .status-pill {
      display: flex; align-items: center; gap: 7px;
      background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.015));
      border: 1px solid var(--border2);
      border-radius: 999px; padding: 4px 11px 4px 9px;
      font-size: 10px; color: var(--text2); font-weight: 700;
      letter-spacing: .4px; text-transform: uppercase;
      transition: border-color .2s, background .2s;
    }
    .status-pill:hover { border-color: rgba(var(--accent-rgb), .3); }
    .status-pill.live  { color: var(--green2); }
    .status-pill.live:hover { border-color: rgba(34,197,94,.35); }
    .status-pill.paused { color: var(--red2); }
    .status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--green2);
      box-shadow: 0 0 8px var(--green), 0 0 0 2px rgba(34,197,94,.12);
      animation: pulse 2.5s ease-in-out infinite;
    }
    .status-dot.paused { background: var(--red2); box-shadow: 0 0 6px var(--red); animation: none; }
    .nav-time {
      font-size: 10px; color: var(--dim); font-family: 'JetBrains Mono', monospace; font-weight: 500;
      padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border);
      background: rgba(255,255,255,.015); letter-spacing: .3px;
    }

    /* ── Layout (classic 2-col for settings/stats) ── */
    .layout { display: flex; min-height: calc(100vh - 50px); }

    /* ── Sidebar ── */
    .sidebar {
      width: 240px; min-width: 240px;
      background: linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%);
      border-right: 1px solid var(--border);
      padding: 14px 10px 10px;
      display: flex; flex-direction: column; gap: 2px;
      /* classic layout: sticky scroll, subtract nav(50). Statusbar removed
         2026-05-02 — viewport extends to bottom edge. */
      position: sticky; top: 50px; height: calc(100vh - 50px); overflow-y: auto;
    }
    /* In dashboard-grid the sidebar is app-shell (overrides above) */
    .sidebar-section {
      display: flex; align-items: center; justify-content: space-between;
      /* 2026-05-01 polish: dropped the "shouty" 9px / letter-spacing 1.4px
         look — section headers were the loudest thing on the page. The
         calmer treatment (10.5px, modest spacing, --muted colour) keeps
         content as the focal point. Tightened vertical padding so the
         sidebar fits a 720p viewport without a vestigial scrollbar. */
      font-size: 10.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .8px; color: var(--muted); padding: 5px 8px 2px;
      margin-top: 0;
    }
    .sidebar-section:first-child { margin-top: 0; padding-top: 2px; }
    .sidebar-section-link {
      font-size: 10px; font-weight: 600; letter-spacing: .4px;
      color: var(--dim); cursor: pointer; padding: 2px 6px; border-radius: 4px;
      text-transform: none;
      transition: all .15s;
    }
    .sidebar-section-link:hover { color: var(--accent2); background: rgba(var(--accent-rgb), .08); }

    /* ── Sidebar phase chips (stacked vertical list) ── */
    .sidebar-phase {
      display: grid; grid-template-columns: 1fr 1fr; gap: 5px;
      padding: 2px 2px 4px;
    }
    .sidebar-phase > button:first-child { grid-column: 1 / -1; }
    .phase-chip {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 7px 9px;
      font-size: 10.5px; font-weight: 700; letter-spacing: .4px;
      color: var(--muted);
      background: rgba(255,255,255,.02);
      border: 1px solid var(--border);
      border-radius: 7px;
      cursor: pointer;
      font-family: inherit;
      text-transform: uppercase;
      transition: all .15s;
      line-height: 1;
      text-align: left;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
    }
    .phase-chip:hover { color: var(--text2); background: rgba(255,255,255,.04); border-color: var(--border2); }
    .phase-chip-dot { font-size: 8px; line-height: 1; flex-shrink: 0; }
    .phase-chip-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .phase-chip-count {
      margin-left: auto; font-family: 'JetBrains Mono', monospace;
      font-size: 10px; color: var(--dim); font-weight: 700;
    }
    .phase-chip.active {
      color: var(--text);
      background: rgba(var(--accent-rgb), .12);
      border-color: rgba(var(--accent-rgb), .35);
      box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), .1);
    }
    .phase-chip.active .phase-chip-count { color: var(--accent2); }
    /* Phase chip colour schema (spec 4.2):
       EARLY=muted, FORMING=white, STRONG=accent, SATURATED=warn.
       Only strong/saturated get colour emphasis; early/forming stay neutral. */
    .phase-chip-early.active    { background: rgba(255,255,255,.06);    border-color: var(--border3);                  color: var(--text2); }
    .phase-chip-forming.active  { background: rgba(255,255,255,.06);    border-color: rgba(255,255,255,.20);           color: var(--text); }
    .phase-chip-strong.active   { background: rgba(var(--accent-rgb),.10); border-color: rgba(var(--accent-rgb),.30);  color: var(--accent); }
    .phase-chip-saturated.active{ background: rgba(var(--warn-rgb),.10);   border-color: rgba(var(--warn-rgb),.30);    color: var(--warn); }

    /* ── Source items (brand-colored, feed-like rows) ── */
    .source-item {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 10px; border-radius: var(--radius-sm);
      border: 1px solid transparent;
      cursor: pointer; transition: all .18s ease;
      font-size: 12.5px; font-weight: 600;
      user-select: none; position: relative;
    }
    .source-item:hover {
      background: rgba(255,255,255,.04); border-color: var(--border2);
      transform: translateX(1px);
    }
    .source-item.on {
      background: rgba(255,255,255,.025);
      border-color: rgba(255,255,255,.06);
    }
    .source-item.off {
      background: transparent;
      border-color: transparent;
      color: var(--dim);
      opacity: .5;
    }
    .source-item.off .source-icon { filter: grayscale(1); }
    .source-item.off .source-count { opacity: .4; }
    /* Locked source (Free plan, premium source). Greyer than .off, lock icon
       on the right where the count would normally be. Click does NOT toggle
       (handled in JS) — opens an upgrade toast instead. */
    .source-item.locked {
      background: rgba(239,243,244,0.02);
      border-color: var(--border);
      color: var(--dim);
      opacity: .55;
      cursor: not-allowed;
    }
    .source-item.locked .source-icon { filter: grayscale(0.85) brightness(0.75); }
    .source-item.locked .source-name { opacity: .7; }
    .source-item.locked .source-lock {
      font-size: 11px;
      padding: 3px 7px;
      background: rgba(239,243,244,0.04);
      border: 1px solid var(--border);
      border-radius: 999px;
      flex-shrink: 0;
    }
    .source-item.locked:hover { opacity: .75; background: rgba(239,243,244,0.04); }
    .source-icon {
      width: 26px; height: 26px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 13.5px; font-weight: 800; flex-shrink: 0;
      font-family: 'Inter', sans-serif; line-height: 1;
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.05);
      color: var(--text2);
      transition: all .18s;
      box-shadow: var(--gloss-top);
    }
    /* Brand-colored letter-marks. Higher border alpha for crisper outline
       than the previous emoji chips. */
    .source-item[data-src="reddit"] .source-icon        { background: rgba(255,88,0,.14);   border-color: rgba(255,88,0,.36);   color: #ff5800; }
    .source-item[data-src="google_trends"] .source-icon { background: rgba(66,133,244,.14); border-color: rgba(66,133,244,.40); color: #4285f4; }
    .source-item[data-src="twitter"] .source-icon       { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.22); color: #ffffff; }
    .source-item[data-src="tiktok"] .source-icon        { background: rgba(255,0,80,.14);   border-color: rgba(255,0,80,.40);   color: #ff2469; font-size: 16px; }
    .source-item[data-src="x_trends"] .source-icon      { background: rgba(29,155,240,.14); border-color: rgba(29,155,240,.42); color: #1d9bf0; }
    .source-item:hover .source-icon { transform: scale(1.05); }

    /* SVG brand logos rendered via SourceMark. The chip's color is set
       per data-src above, SVG fills with currentColor. Letter-mark
       fallback (.src-mark-text) inherits font-size from chip. */
    .src-mark-svg {
      display: inline-flex; align-items: center; justify-content: center;
      width: 60%; height: 60%; line-height: 0;
    }
    .src-mark-svg svg {
      width: 100%; height: 100%;
      fill: currentColor; display: block;
    }
    .src-mark-text { line-height: 1; }
    /* Inside .feed-avatar (38px chip) — slightly smaller logo to leave breathing room */
    .feed-avatar .src-mark-svg { width: 58%; height: 58%; }
    /* X (Twitter) glyph is naturally tall+thin → render slightly larger so
       optical weight matches Reddit/Google. */
    .source-item[data-src="twitter"] .src-mark-svg,
    .feed-avatar.twitter .src-mark-svg { width: 56%; height: 56%; }
    .source-name { flex: 1; letter-spacing: -.1px; }
    .source-count {
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px; font-weight: 600;
      color: var(--text2); background: rgba(255,255,255,.04);
      padding: 2px 7px; border-radius: 5px; min-width: 26px; text-align: center;
      border: 1px solid var(--border);
    }
    .source-count.hot { color: var(--accent2); background: rgba(var(--accent-rgb), .1); border-color: rgba(var(--accent-rgb), .22); }
    /* Eye glyph removed — it sat on top of the count chip and hid the number.
       on/off state is already conveyed by .source-item.off styles
       (grayscale icon + opacity .5). */

    .sidebar-divider { height: 1px; background: var(--border); margin: 6px 6px; }

    /* ── Sidebar filters ── */
    .sidebar-filters { padding: 2px 2px; display: flex; flex-direction: column; gap: 10px; }
    .filter-group { display: flex; flex-direction: column; gap: 5px; }
    .filter-label {
      font-size: 9px; font-weight: 700; letter-spacing: 1.2px;
      text-transform: uppercase; color: var(--muted); padding: 0 4px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .filter-label .filter-val {
      color: var(--accent2); font-family: 'JetBrains Mono', monospace;
      font-size: 10px; letter-spacing: 0;
    }

    /* ── Segmented control ── */
    .seg-group {
      display: flex; background: rgba(255,255,255,.025);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 2px; gap: 2px;
    }
    .seg-btn {
      flex: 1; padding: 5px 4px; border-radius: 6px;
      font-size: 10.5px; font-weight: 600; color: var(--muted);
      background: transparent; border: none; cursor: pointer;
      transition: all .15s; font-family: inherit;
      white-space: nowrap; text-align: center;
    }
    .seg-btn:hover { color: var(--text2); background: rgba(255,255,255,.03); }
    .seg-btn.active {
      background: var(--accent-glow);
      color: var(--accent2);
      box-shadow: 0 0 0 1px rgba(var(--accent-rgb), .2);
    }
    .seg-group.seg-compact .seg-btn { padding: 5px 2px; font-size: 11px; }

    /* ── Reset filters button ── */
    .sb-reset-btn {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      padding: 6px 10px; margin-top: 4px;
      background: transparent; border: 1px dashed var(--border2);
      border-radius: 6px; color: var(--muted);
      font-size: 10.5px; font-weight: 600; cursor: pointer;
      transition: all .15s; font-family: inherit;
    }
    .sb-reset-btn:hover { color: var(--red2); border-color: rgba(var(--red-rgb), .35); background: rgba(var(--red-rgb), .04); }

    /* ── Sidebar footer (unified bottom nav: Feed / Stats / Settings) ── */
    .sidebar-footer {
      margin-top: auto;
      padding: 6px 4px 4px;
      border-top: 1px solid var(--border);
      background: linear-gradient(180deg, transparent 0%, rgba(0,0,0,.15) 100%);
    }
    .sb-foot-nav {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px;
      padding: 4px; border-radius: 10px;
      background: rgba(0,0,0,.18);
      border: 1px solid var(--border);
    }
    .sb-foot-btn {
      position: relative;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
      padding: 9px 4px 8px; border-radius: 7px;
      background: transparent; border: 1px solid transparent;
      cursor: pointer; transition: all .15s;
      color: var(--muted); font-size: 10px; font-weight: 600;
      letter-spacing: .2px;
      text-align: center;
      overflow: hidden;
    }
    .sb-foot-btn .sb-foot-ico { font-size: 15px; filter: saturate(.75); transition: filter .15s, transform .15s; }
    .sb-foot-btn:hover { color: var(--text); background: rgba(255,255,255,.04); }
    .sb-foot-btn:hover .sb-foot-ico { filter: saturate(1.1); transform: scale(1.05); }
    .sb-foot-btn.active {
      color: var(--accent2);
      background: var(--accent-glow);
      border-color: rgba(var(--accent-rgb), .3);
      box-shadow: 0 2px 8px rgba(var(--accent-rgb), .15), inset 0 1px 0 rgba(255,255,255,.04);
    }
    .sb-foot-btn.active::before {
      content: '';
      position: absolute; top: 0; left: 20%; right: 20%; height: 2px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      border-radius: 0 0 2px 2px;
    }
    .sb-foot-btn.active .sb-foot-ico { filter: saturate(1.2) drop-shadow(0 0 4px var(--accent-glow)); }
    /* Locked tab — Free plan, "Analyze" stays visible but un-clickable so
       the user discovers the feature exists. Click → upgrade toast (handled
       in BottomNav). Visually muted, dashed border to read as "available
       elsewhere", lock icon already replaces the regular tab icon. */
    .sb-foot-btn.locked {
      opacity: .55;
      cursor: not-allowed;
      border-style: dashed;
    }
    .sb-foot-btn.locked:hover {
      opacity: .7;
      background: rgba(239,243,244,0.03);
      color: var(--muted);
    }
    .sb-foot-btn.locked:hover .sb-foot-ico { transform: none; }

    /* ── Main content ── */
    .main {
      flex: 1; min-width: 0; padding: 18px 20px 24px;
      height: calc(100vh - 50px); overflow-y: auto;
    }
    .settings-panel { padding-bottom: 40px; }

    /* ── Session bar (compact hero replacement) ── */
    .session-bar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 10px 14px; margin-bottom: 14px;
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius); box-shadow: var(--shadow);
    }
    .session-tag {
      font-size: 9px; font-weight: 800; letter-spacing: 1.6px; text-transform: uppercase;
      color: var(--accent2); padding: 2px 7px; border-radius: 4px;
      background: rgba(var(--accent-rgb), .1); border: 1px solid rgba(var(--accent-rgb), .2);
    }
    .session-title { font-size: 13px; font-weight: 700; color: var(--text); letter-spacing: -.3px; }
    .session-chips { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-left: auto; }
    .session-chip {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 10px; font-weight: 500; color: var(--muted);
      padding: 3px 8px; border-radius: 5px;
      background: rgba(255,255,255,.03); border: 1px solid var(--border);
    }
    .session-chip .chip-val { font-family: 'JetBrains Mono', monospace; font-weight: 700; color: var(--text2); font-size: 11px; }

    /* ── Old hero stubs (kept for compat) ── */
    .dashboard-hero { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
    .hero-panel { border-radius: var(--radius); border: 1px solid var(--border); overflow: hidden; }
    .hero-main { background: var(--card); padding: 18px 20px; }
    .hero-side { background: var(--surface); padding: 14px 16px; }
    .hero-kicker { font-size: 9px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: var(--accent2); margin-bottom: 6px; }
    .hero-title { font-size: 18px; line-height: 1.1; letter-spacing: -.5px; font-weight: 800; margin-bottom: 6px; }
    .hero-copy { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
    .hero-chip-row { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 12px; }
    .hero-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 5px; border: 1px solid var(--border2); background: rgba(255,255,255,.03); color: var(--muted); font-size: 11px; font-weight: 500; }
    .hero-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green2); box-shadow: 0 0 6px rgba(var(--green-rgb), .5); }
    .hero-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .hero-side-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .hero-mini-card { border-radius: 8px; border: 1px solid var(--border); background: rgba(255,255,255,.025); padding: 10px; }
    .hero-mini-label { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--dim); margin-bottom: 5px; }
    .hero-mini-value { font-size: 15px; font-weight: 800; color: var(--text); letter-spacing: -.4px; margin-bottom: 2px; font-family: 'JetBrains Mono', monospace; }
    .hero-mini-sub { font-size: 10px; color: var(--muted); }

    .section-shell {
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .section-shell + .section-shell { margin-top: 10px; }

    /* ── Stats grid ── */
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .stat-card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 14px 16px;
      position: relative; overflow: hidden;
      transition: border-color .2s, transform .18s;
      animation: fadeIn .35s ease backwards;
      box-shadow: var(--shadow);
    }
    .stat-card:nth-child(2) { animation-delay: .04s; }
    .stat-card:nth-child(3) { animation-delay: .08s; }
    .stat-card:nth-child(4) { animation-delay: .12s; }
    .stat-card:hover { border-color: rgba(var(--accent-rgb), .28); transform: translateY(-1px); }
    .stat-card::after {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: linear-gradient(90deg, var(--accent), transparent);
      opacity: 0; transition: opacity .25s;
    }
    .stat-card:hover::after { opacity: 1; }
    .stat-icon { font-size: 15px; margin-bottom: 9px; display: inline-block; opacity: .65; }
    .stat-val {
      font-size: 22px; font-weight: 800; color: var(--text); letter-spacing: -.8px; line-height: 1;
      font-family: 'JetBrains Mono', monospace;
    }
    .stat-val span { font-size: 12px; font-weight: 500; color: var(--accent2); margin-left: 1px; }
    .stat-lbl { font-size: 10px; color: var(--muted); margin-top: 5px; font-weight: 500; }
    .stat-sub { font-size: 10px; color: var(--dim); margin-top: 2px; }

    /* ── Toolbar ── */
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 10px; flex-wrap: wrap;
      padding: 10px 14px;
    }
    .toolbar-label { font-size: 9px; color: var(--dim); margin-right: 1px; white-space: nowrap; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; }

    /* ── Control Panel ── */
    .control-panel {
      background: var(--card);
      border-radius: var(--radius);
      padding: 14px 16px;
    }
    .control-panel-title {
      font-size: 9px; font-weight: 700; color: var(--dim);
      text-transform: uppercase; letter-spacing: 1.3px; margin-bottom: 10px;
      display: flex; align-items: center; gap: 6px;
    }
    .control-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 6px; }
    .control-btn {
      display: flex; flex-direction: column; align-items: center; gap: 5px;
      padding: 11px 8px;
      background: rgba(255,255,255,.025); border: 1px solid var(--border2);
      border-radius: 8px; cursor: pointer; transition: all .15s ease;
      font-size: 11px; font-weight: 600; color: var(--muted);
      white-space: nowrap; position: relative; overflow: hidden;
    }
    .control-btn:hover { border-color: rgba(var(--accent-rgb), .28); background: rgba(var(--accent-rgb), .07); color: var(--accent2); transform: translateY(-1px); }
    .control-btn:active { transform: translateY(0); }
    .control-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; }
    .control-icon { font-size: 17px; display: block; line-height: 1; }
    .control-label { font-size: 10px; color: inherit; }
    .control-status {
      position: absolute; top: 5px; right: 5px;
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--green2); box-shadow: 0 0 5px rgba(var(--green-rgb), .6);
    }
    .control-status.off { background: var(--red2); box-shadow: none; }
    .control-status.idle { background: var(--dim); box-shadow: none; }

    /* ── Source Controls ── */
    .source-controls { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
    .source-control-btn {
      display: flex; align-items: center; justify-content: space-between;
      padding: 7px 11px; background: rgba(255,255,255,.02);
      border: 1px solid var(--border); border-radius: var(--radius-xs);
      cursor: pointer; transition: all .15s; font-size: 11px; font-weight: 600; color: var(--text2);
    }
    .source-control-btn:hover { border-color: rgba(var(--accent-rgb), .22); background: rgba(var(--accent-rgb), .05); }
    .source-control-btn.disabled { border-color: var(--border); background: transparent; color: var(--dim); }
    .source-control-toggle {
      width: 26px; height: 14px; border-radius: 7px; background: var(--green);
      position: relative; transition: background .2s; flex-shrink: 0;
    }
    .source-control-toggle::after {
      content: ''; position: absolute;
      width: 10px; height: 10px; border-radius: 50%; background: white;
      top: 2px; left: 14px; transition: left .2s;
    }
    .source-control-btn.disabled .source-control-toggle { background: var(--dim); }
    .source-control-btn.disabled .source-control-toggle::after { left: 2px; }

    .toolbar-sep { width: 1px; height: 16px; background: var(--border); margin: 0 2px; }
    select {
      background: rgba(255,255,255,.025); border: 1px solid var(--border);
      color: var(--text2); padding: 7px 10px; border-radius: 8px;
      font-size: 11px; font-weight: 600; outline: none; cursor: pointer;
      font-family: 'Inter', sans-serif; transition: all .15s;
      appearance: none; -webkit-appearance: none;
      background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
      padding-right: 26px;
    }
    select:hover { border-color: var(--border2); color: var(--text); }
    select:focus {
      border-color: rgba(var(--accent-rgb), .3); color: var(--text);
      box-shadow: 0 0 0 1px rgba(var(--accent-rgb), .2);
      background-color: var(--accent-glow);
    }
    select option { background: var(--surface); color: var(--text); }

    /* Custom category dropdown — replaces native select to match X-style theme.
       Native option list is browser-painted (chromium dark UA), here we get
       full control: hover ripple, animated panel, colored category dots. */
    .cat-dd { position: relative; width: 100%; }
    .cat-dd-trigger {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      width: 100%; padding: 8px 11px;
      background: rgba(255,255,255,.025);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text2);
      font-size: 11.5px; font-weight: 600;
      font-family: inherit; cursor: pointer;
      transition: all .15s; text-align: left;
      box-shadow: var(--gloss-top);
    }
    .cat-dd-trigger:hover {
      border-color: var(--border2); color: var(--text);
      background: rgba(255,255,255,.045);
    }
    .cat-dd.open .cat-dd-trigger {
      border-color: rgba(var(--accent-rgb), .4);
      background: var(--accent-glow);
      color: var(--text);
      box-shadow: 0 0 0 1px rgba(var(--accent-rgb), .15);
    }
    .cat-dd-trigger.has-value { color: var(--text); }
    .cat-dd-trigger-ico {
      flex-shrink: 0; font-size: 14px;
      filter: saturate(.85);
    }
    .cat-dd-trigger-label {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      letter-spacing: .1px;
    }
    .cat-dd-trigger-label.is-placeholder { color: var(--muted); font-weight: 500; }
    .cat-dd-caret {
      font-size: 9px; color: var(--muted); transition: transform .2s, color .2s;
      flex-shrink: 0;
    }
    .cat-dd.open .cat-dd-caret { transform: rotate(180deg); color: var(--accent2); }

    /* Panel opens UPWARD — anchored to trigger's bottom edge. CategoryDropdown
       sits low in the sidebar (near BottomNav), so dropping upward avoids
       overlapping the foot-nav and keeps the active row close to the cursor. */
    /* No max-height / overflow — list of 10 categories + reset row fits in ~390px,
       comfortably below typical sidebar height. Panel opens upward, so it grows
       toward the top of the viewport without ever clipping the trigger. */
    .cat-dd-panel {
      position: absolute; bottom: calc(100% + 5px); left: 0; right: 0;
      z-index: 50;
      background: var(--surface);
      border: 1px solid var(--border2);
      border-radius: 10px;
      padding: 4px;
      box-shadow:
        0 -12px 40px rgba(0,0,0,.55),
        0 -4px 12px rgba(0,0,0,.35),
        var(--gloss-edge);
      animation: cat-dd-slide-up .14s ease-out;
    }
    @keyframes cat-dd-slide-up {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .cat-dd-divider { height: 1px; background: var(--border); margin: 3px 6px; }
    .cat-dd-opt {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 7px 10px;
      background: transparent; border: none; border-radius: 6px;
      color: var(--text2); font-size: 11.5px; font-weight: 500;
      font-family: inherit; cursor: pointer; text-align: left;
      transition: background .12s, color .12s;
      position: relative;
    }
    .cat-dd-opt:hover {
      background: rgba(255,255,255,.045); color: var(--text);
    }
    .cat-dd-opt.active {
      background: var(--accent-glow);
      color: var(--accent2);
      font-weight: 700;
    }
    .cat-dd-opt.active::before {
      content: ''; position: absolute; left: 2px; top: 8px; bottom: 8px; width: 2px;
      background: var(--accent); border-radius: 2px;
    }
    .cat-dd-opt-ico {
      width: 20px; flex-shrink: 0; text-align: center;
      font-size: 14px; line-height: 1;
      filter: saturate(.8);
      transition: filter .12s, transform .12s;
    }
    .cat-dd-opt:hover .cat-dd-opt-ico,
    .cat-dd-opt.active .cat-dd-opt-ico {
      filter: saturate(1.15);
      transform: scale(1.08);
    }
    .cat-dd-opt-label {
      flex: 1; text-transform: capitalize;
      letter-spacing: .15px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cat-dd-opt-check {
      flex-shrink: 0;
      color: var(--accent2);
      font-size: 11px; font-weight: 700;
    }

    .btn {
      padding: 7px 12px; border-radius: 8px; border: 1px solid transparent;
      cursor: pointer; font-size: 11px; font-weight: 700;
      transition: all .15s ease; white-space: nowrap;
      font-family: 'Inter', sans-serif; letter-spacing: .1px;
      display: inline-flex; align-items: center; gap: 5px;
    }
    .btn-primary {
      background: var(--accent-glow); color: var(--accent2);
      border-color: rgba(var(--accent-rgb), .3);
      box-shadow: 0 0 0 1px rgba(var(--accent-rgb), .1) inset;
    }
    .btn-primary:hover {
      background: rgba(var(--accent-rgb), .18); color: var(--text);
      border-color: rgba(var(--accent-rgb), .5);
      box-shadow: 0 0 14px rgba(var(--accent-rgb), .18);
    }
    .btn-primary:active { transform: translateY(1px); }
    .btn-ghost {
      background: rgba(255,255,255,.025); border-color: var(--border);
      color: var(--muted);
    }
    .btn-ghost:hover {
      background: rgba(255,255,255,.05); color: var(--text);
      border-color: var(--border2);
    }
    .btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none !important; box-shadow: none !important; }
    .btn.is-spinning { opacity: .8; }
    .btn.is-spinning .btn-refresh-ico {
      display: inline-block;
      animation: spin 0.9s linear infinite;
    }
    .btn-refresh-ico { display: inline-block; }

    /* ── Trend Cards ── */
    .trends-list { display: flex; flex-direction: column; gap: 4px; padding: 8px; }
    .trend-card {
      background: rgba(255,255,255,.01);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0;
      transition: border-color .15s, background .15s;
      animation: fadeIn .25s ease backwards;
      overflow: hidden;
      cursor: pointer;
    }
    .trend-card:hover {
      border-color: rgba(var(--accent-rgb), .28);
      background: rgba(var(--accent-rgb), .025);
    }

    /* ── Card header row ── */
    .card-header {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 10px 13px 8px;
      border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,.015);
    }
    .card-title {
      font-size: 13px; font-weight: 700; color: var(--text);
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .card-title a { color: inherit; text-decoration: none; transition: color .12s; }
    .card-title a:hover { color: var(--accent2); }
    .card-meta { display: flex; align-items: center; gap: 7px; flex-shrink: 0; }

    /* ── Card body ── */
    .card-body { padding: 10px 13px; }
    .card-orig {
      font-size: 10px; color: var(--dim); font-style: italic;
      margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .card-desc {
      font-size: 12px; color: var(--muted); line-height: 1.5;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      margin-bottom: 9px;
    }
    .card-desc.pump { color: var(--orange); font-weight: 500; }

    /* ── Card stats row ── */
    .card-stats { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .card-stat { display: flex; flex-direction: column; gap: 2px; }
    .card-stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: .7px; color: var(--dim); font-weight: 600; }

    /* ── Score / meme bars ── */
    .meme-score { display: flex; align-items: center; gap: 7px; }
    .meme-num { font-size: 17px; font-weight: 800; font-family: 'JetBrains Mono', monospace; line-height: 1; color: var(--accent); }
    /* Score level communicated via bar-fill length, not number color — keep
       all tier classes (hot/warm/ok/cold) on the same accent for visual
       calmness ("светофор" removed 2026-05-19). */
    .meme-num.hot,
    .meme-num.warm,
    .meme-num.ok,
    .meme-num.cold { color: var(--accent); }
    .meme-bar-wrap { display: flex; flex-direction: column; gap: 2px; min-width: 70px; }
    .meme-bar { height: 3px; border-radius: 3px; background: rgba(255,255,255,.06); overflow: hidden; width: 70px; }
    .meme-fill { height: 100%; border-radius: 3px; transition: width .35s ease; }
    .meme-label { font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: .4px; }

    .score-bar-wrap { display: flex; flex-direction: column; gap: 2px; }
    .score-bar-row  { display: flex; align-items: center; gap: 6px; }
    .score-bar-label { font-size: 10px; color: var(--dim); font-weight: 600; white-space: nowrap; min-width: 82px; }
    .score-bar-track { flex: 1; height: 3px; border-radius: 3px; background: rgba(255,255,255,.06); overflow: hidden; }
    .score-bar-fill { height: 100%; border-radius: 3px; transition: width .35s ease; }
    .score-bar-num { font-size: 11px; font-weight: 800; font-family: 'JetBrains Mono', monospace; min-width: 20px; text-align: right; }
    .score-bar-sub { font-size: 10px; color: var(--dim); padding-left: 88px; margin-top: -1px; }
    .card-score-bars { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }

    /* ── Modal hero Meme Score ──
       Promoted treatment for the Meme Score at the top of the trend modal.
       Bigger number, thicker gradient-filled bar, soft accent card around it
       so it visually stands above the ordinary ScoreBars further down. */
    .meme-hero {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 9px;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(255,107,107,0.08), rgba(255,184,0,0.05));
      border: 1px solid rgba(255,107,107,0.18);
      box-shadow: 0 0 12px -8px rgba(255,107,107,0.25);
    }
    .meme-hero-left { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex-shrink: 0; }
    .meme-hero-label {
      font-size: 8px; font-weight: 800;
      text-transform: uppercase; letter-spacing: 1px;
      color: var(--dim);
    }
    .meme-hero-num {
      font-family: 'JetBrains Mono', monospace;
      font-size: 16px; font-weight: 800; line-height: 1;
      letter-spacing: -0.3px;
    }
    /* All tiers on --accent — level via bar-fill length, not color */
    .meme-hero-num.hot,
    .meme-hero-num.warm,
    .meme-hero-num.ok,
    .meme-hero-num.cold { color: var(--accent); }
    .meme-hero-num-sub { font-size: 9px; color: var(--dim); font-weight: 600; }
    .meme-hero-bar {
      flex: 1; height: 4px;
      border-radius: 4px;
      background: rgba(255,255,255,0.05);
      overflow: hidden;
      position: relative;
    }
    .meme-hero-fill {
      height: 100%; border-radius: 4px;
      transition: width .45s cubic-bezier(.2,.8,.2,1);
      position: relative;
      overflow: hidden;
    }
    .meme-hero-fill::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg,
        rgba(255,255,255,0) 0%,
        rgba(255,255,255,.18) 50%,
        rgba(255,255,255,0) 100%);
      transform: translateX(-100%);
      animation: meme-shimmer 2.4s ease-in-out infinite;
    }
    @keyframes meme-shimmer {
      0%   { transform: translateX(-100%); }
      60%  { transform: translateX(100%); }
      100% { transform: translateX(100%); }
    }

    /* ── Phase badge ── */
    .phase-badge {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 6px; border-radius: 4px;
      font-size: 9px; font-weight: 800; letter-spacing: .6px;
      white-space: nowrap; flex-shrink: 0;
    }

    /* ── Badges ── */
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 5px; font-size: 10px; font-weight: 600; white-space: nowrap; letter-spacing: .2px; }
    .cat-meme          { background: rgba(162,155,254,.1); color: #a29bfe; border: 1px solid rgba(162,155,254,.18); }
    .cat-celebrity     { background: rgba(253,203,110,.1); color: #fdcb6e; border: 1px solid rgba(253,203,110,.18); }
    .cat-animals       { background: rgba(85,239,196,.1);  color: #55efc4; border: 1px solid rgba(85,239,196,.18); }
    .cat-tech          { background: rgba(225,112,85,.1);  color: #e17055; border: 1px solid rgba(225,112,85,.18); }
    .cat-gambling      { background: rgba(253,121,168,.1); color: #fd79a8; border: 1px solid rgba(253,121,168,.18); }
    .cat-sports        { background: rgba(116,185,255,.1); color: #74b9ff; border: 1px solid rgba(116,185,255,.18); }
    .cat-politics      { background: rgba(255,118,117,.12); color: #ff7675; border: 1px solid rgba(255,118,117,.22); }
    .cat-entertainment { background: rgba(255,165,2,.12);   color: #ffa502; border: 1px solid rgba(255,165,2,.22); }
    .cat-gaming        { background: rgba(0,206,201,.12);   color: #00cec9; border: 1px solid rgba(0,206,201,.22); }
    .cat-boring        { background: rgba(255,255,255,.04); color: var(--dim); border: 1px solid var(--border); }
    .cat-other         { background: rgba(255,255,255,.04); color: var(--dim); border: 1px solid var(--border); }
    .badge-manual    { background: rgba(var(--secondary-rgb),.10); color: var(--secondary); border: 1px solid rgba(var(--secondary-rgb),.30); }
    /* Alert-type chips — orthogonal to category. event = warm red-orange,
       trend = green (movement), post = blue (single signal). */
    .badge-atype-event { background: rgba(255,107,107,.12); color: #ff8a65; border: 1px solid rgba(255,107,107,.3); font-weight: 600; }
    .badge-atype-trend { background: rgba(46,213,115,.12); color: #2ed573; border: 1px solid rgba(46,213,115,.3); font-weight: 600; }
    .badge-atype-post  { background: rgba(116,185,255,.12); color: #74b9ff; border: 1px solid rgba(116,185,255,.3); font-weight: 600; }
    /* Catalyst-found indicator: accent-tinted (matches the modal's Catalyst
       section). Subtle pulse so the eye picks it up while scanning the feed. */
    .badge-catalyst {
      background: rgba(var(--accent-rgb), .14);
      color: var(--accent);
      border: 1px solid rgba(var(--accent-rgb), .38);
      font-weight: 700;
      box-shadow: var(--gloss-top);
    }
    /* Sidebar chip variants — paint phase-chip same colours when filtering. */
    .phase-chip.atype-chip-event.active { border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.10); color: #ff8a65; }
    .phase-chip.atype-chip-trend.active { border-color: rgba(46,213,115,.5);  background: rgba(46,213,115,.10);  color: #2ed573; }
    .phase-chip.atype-chip-post.active  { border-color: rgba(116,185,255,.5); background: rgba(116,185,255,.10); color: #74b9ff; }
    .phase-chip.atype-chip-manual.active { border-color: rgba(var(--secondary-rgb),.30); background: rgba(var(--secondary-rgb),.10); color: var(--secondary); }

    /* ── Source chip ── */
    .source-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--dim); white-space: nowrap; padding: 2px 7px; border-radius: 5px; background: rgba(255,255,255,.04); }

    /* ── Lifespan / Time ── */
    .lifespan { font-size: 10px; color: var(--dim); white-space: nowrap; }
    .time-cell { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--dim); white-space: nowrap; }

    /* ── Card footer ── */
    .card-footer {
      display: flex; gap: 6px; padding: 8px 13px;
      border-top: 1px solid var(--border);
      background: rgba(255,255,255,.012);
    }
    .trend-link {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; font-weight: 600; color: var(--muted);
      text-decoration: none; padding: 5px 11px;
      border: 1px solid var(--border); border-radius: 6px;
      background: rgba(255,255,255,.025); transition: all .13s;
      white-space: nowrap;
    }
    .trend-link:hover { background: rgba(255,255,255,.05); color: var(--text); border-color: var(--border2); }
    .trend-link-tg { color: #5bc0eb; border-color: rgba(91,192,235,.2); }
    .trend-link-tg:hover { background: rgba(91,192,235,.1); border-color: rgba(91,192,235,.4); color: #fff; }
    .trend-link-reddit { color: #ff6b35; border-color: rgba(255,107,53,.2); }
    .trend-link-reddit:hover { background: rgba(255,107,53,.1); border-color: rgba(255,107,53,.4); color: #fff; }
    .trend-link-twitter { color: #1da1f2; border-color: rgba(29,161,242,.2); }
    .trend-link-twitter:hover { background: rgba(29,161,242,.1); border-color: rgba(29,161,242,.4); color: #fff; }
    .trend-link-tiktok { color: #ee1d52; border-color: rgba(238,29,82,.2); }
    .trend-link-tiktok:hover { background: rgba(238,29,82,.1); border-color: rgba(238,29,82,.4); color: #fff; }
    .trend-link-grok { color: #b48cff; border-color: rgba(180,140,255,.25); }
    .trend-link-grok:hover { background: rgba(180,140,255,.1); border-color: rgba(180,140,255,.5); color: #fff; }

    /* ── Table wrap & header ── */
    .table-wrap { background: transparent; border: none; border-radius: var(--radius); overflow: hidden; }
    .table-header {
      padding: 11px 14px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      background: var(--card);
      border-radius: var(--radius) var(--radius) 0 0;
    }
    .table-title { font-size: 13px; font-weight: 700; color: var(--text); }
    .table-count { font-size: 10px; color: var(--dim); font-family: 'JetBrains Mono', monospace; font-weight: 500; }

    /* ── Infinite-scroll sentinel ── */
    .feed-sentinel {
      display: flex; align-items: center; justify-content: center;
      min-height: 56px; padding: 14px 12px 22px;
      color: var(--dim);
    }
    .feed-sentinel-end { opacity: 0.6; }
    .feed-sentinel-hint {
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.1em; opacity: .55;
    }
    .feed-loading-more {
      display: flex; align-items: center; gap: 10px;
      font-size: 12px; color: var(--dim); font-weight: 500;
    }
    .loading-spinner.small {
      width: 14px; height: 14px; border-width: 2px;
    }

    /* ── Loading / Empty ── */
    .loading-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; gap: 14px; }
    .loading-spinner { width: 28px; height: 28px; border-radius: 50%; border: 2px solid rgba(255,255,255,.06); border-top-color: var(--accent); animation: spin .7s linear infinite; }
    .loading-text { font-size: 12px; color: var(--dim); font-weight: 500; }
    .empty-wrap { display: flex; flex-direction: column; align-items: center; padding: 60px 20px; gap: 12px; }
    .empty-icon { font-size: 40px; opacity: .15; }
    .empty-text { font-size: 13px; color: var(--dim); font-weight: 500; }

    /* ── Error ── */
    .error-bar {
      background: rgba(var(--red-rgb), .07); border: 1px solid rgba(var(--red-rgb), .2);
      color: var(--red2); padding: 10px 14px; border-radius: 8px;
      margin-bottom: 12px; font-size: 12px; font-weight: 500;
      display: flex; align-items: center; gap: 8px;
      animation: fadeIn .25s ease;
    }

    /* ── Settings panel ── */
    .settings-panel { padding: 20px 24px; max-width: 680px; animation: fadeIn .25s ease; }
    .settings-header { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }

    /* ── Analyze panel (pro/admin manual URL → trend) ── */
    .analyze-panel { padding: 20px 24px; max-width: 720px; animation: fadeIn .25s ease; }
    .analyze-intro { color: var(--dim); font-size: 13px; line-height: 1.5; margin-bottom: 18px; }
    .analyze-form {
      background: rgba(var(--accent-rgb), .04);
      border: 1px solid rgba(var(--accent-rgb), .18);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 16px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .analyze-label { font-size: 11px; font-weight: 700; color: var(--dim); text-transform: uppercase; letter-spacing: .6px; }
    .analyze-input {
      width: 100%;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
      outline: none;
    }
    .analyze-input:focus { border-color: rgba(var(--accent-rgb), .55); }
    .analyze-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .analyze-hint { font-size: 11px; color: var(--dim); }
    .analyze-error { font-size: 12px; color: var(--red); }
    .analyze-empty {
      text-align: center; padding: 28px 20px;
      color: var(--dim); font-size: 13px;
      border: 1px dashed var(--border);
      border-radius: 12px;
    }
    /* Stage loader — shown during /api/manual-analysis fetch. The pipeline
       runs PreStage → Stage 1 → Stage 2 → finalize; backend doesn't stream
       progress, so we advance the label client-side on a timer (rough
       estimates per stage). Looks alive, sets honest expectations. */
    .analyze-loader {
      display: flex; flex-direction: column; align-items: center;
      gap: 14px; padding: 36px 20px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(var(--accent-rgb), .05), rgba(var(--accent-rgb), .01));
    }
    .analyze-loader-spinner {
      width: 36px; height: 36px;
      border-radius: 50%;
      border: 3px solid rgba(var(--accent-rgb), .15);
      border-top-color: rgba(var(--accent-rgb), .85);
      animation: analyze-spin .9s linear infinite;
    }
    @keyframes analyze-spin { to { transform: rotate(360deg); } }
    .analyze-loader-text {
      font-size: 14px; font-weight: 700;
      color: var(--text);
      letter-spacing: .2px;
      display: flex; align-items: center; gap: 4px;
    }
    /* Animated ellipsis — three dots that fade in/out one after another.
       Renders inside the loader text to give a "thinking" cue without
       reflowing layout (fixed width via inline-block). */
    .analyze-loader-dots { display: inline-block; width: 22px; text-align: left; }
    .analyze-loader-dots span {
      display: inline-block;
      opacity: 0;
      animation: analyze-dot 1.2s ease-in-out infinite;
    }
    .analyze-loader-dots span:nth-child(2) { animation-delay: .15s; }
    .analyze-loader-dots span:nth-child(3) { animation-delay: .30s; }
    @keyframes analyze-dot {
      0%, 80%, 100% { opacity: 0; }
      40%           { opacity: 1; }
    }
    .analyze-loader-sub {
      font-size: 11px; color: var(--dim);
      letter-spacing: .3px;
    }
    /* Tiny per-stage breadcrumb under the main label — passive trail of
       the 4 stages so the user can see roughly where in the pipeline we are
       (current = accent dot, past = filled-dim, upcoming = outlined). */
    .analyze-loader-trail {
      display: flex; gap: 8px; margin-top: 4px;
    }
    .analyze-loader-trail-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: transparent;
      border: 1px solid rgba(var(--accent-rgb), .25);
      transition: background .25s ease, border-color .25s ease, transform .25s ease;
    }
    .analyze-loader-trail-dot.done {
      background: rgba(var(--accent-rgb), .35);
      border-color: rgba(var(--accent-rgb), .35);
    }
    .analyze-loader-trail-dot.active {
      background: rgba(var(--accent-rgb), .85);
      border-color: rgba(var(--accent-rgb), .85);
      transform: scale(1.2);
    }
    .analyze-result {
      background: linear-gradient(180deg, rgba(255,255,255,.025), rgba(255,255,255,.005));
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 0;
      overflow: hidden;
    }
    .analyze-hero {
      display: flex; align-items: flex-start; gap: 14px;
      padding: 16px;
      background: linear-gradient(135deg, rgba(var(--accent-rgb), .08), rgba(var(--accent-rgb), .02));
      border-bottom: 1px solid var(--border);
    }
    .analyze-thumb {
      width: 84px; height: 84px;
      object-fit: cover; border-radius: 12px;
      border: 1px solid var(--border);
      flex-shrink: 0; background: var(--bg2);
    }
    .analyze-thumb-fb {
      width: 84px; height: 84px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg2);
      display: flex; align-items: center; justify-content: center;
      font-size: 36px; flex-shrink: 0;
    }
    .analyze-hero-body { flex: 1; min-width: 0; }
    .analyze-hero-title { font-size: 16px; font-weight: 800; color: var(--text); line-height: 1.3; margin-bottom: 4px; word-break: break-word; }
    .analyze-hero-meta { font-size: 11px; color: var(--dim); margin-bottom: 10px; }
    .analyze-hero-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    /* Verdict banner — top of the result card, biggest signal first.
       Three flavours (high/mid/low) chosen from max(meme, adoption). Each
       has a tinted gradient + coloured left-bar so the user gets the
       headline answer ("will it go viral?") before scanning numbers. */
    .analyze-verdict {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 3px;
    }
    .analyze-verdict.high {
      background: linear-gradient(135deg, color-mix(in srgb, var(--green) 16%, transparent), color-mix(in srgb, var(--green) 3%, transparent));
      border-left: 4px solid var(--green);
    }
    .analyze-verdict.mid {
      background: linear-gradient(135deg, color-mix(in srgb, var(--yellow) 16%, transparent), color-mix(in srgb, var(--yellow) 3%, transparent));
      border-left: 4px solid var(--yellow);
    }
    .analyze-verdict.low {
      background: linear-gradient(135deg, rgba(255,120,73,.12), rgba(255,120,73,.02));
      border-left: 4px solid #ff7849;
    }
    .analyze-verdict-title { font-size: 15px; font-weight: 800; color: var(--text); }
    .analyze-verdict-sub   { font-size: 12px; color: var(--dim); line-height: 1.5; }

    .analyze-scores {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      padding: 14px 16px;
    }
    .analyze-score {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .analyze-score-label { font-size: 10px; font-weight: 700; letter-spacing: .4px; color: var(--dim); text-transform: uppercase; margin-bottom: 4px; }
    .analyze-score-value { font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--blue); font-family: 'JetBrains Mono', Consolas, monospace; }
    .analyze-score.high .analyze-score-value { color: var(--green); }
    .analyze-score.mid  .analyze-score-value { color: var(--yellow); }
    .analyze-score.low  .analyze-score-value { color: #ff7849; }
    /* Score progress bar — visual context for the bare number. */
    .analyze-score-bar {
      margin-top: 8px;
      height: 4px;
      background: rgba(255,255,255,.06);
      border-radius: 2px;
      overflow: hidden;
    }
    .analyze-score-bar-fill {
      height: 100%;
      background: var(--blue);
      transition: width .35s ease;
    }
    .analyze-score.high .analyze-score-bar-fill { background: var(--green); }
    .analyze-score.mid  .analyze-score-bar-fill { background: var(--yellow); }
    .analyze-score.low  .analyze-score-bar-fill { background: #ff7849; }
    /* Qualitative tag (Low/Medium/High) — gives the bare number a verbal anchor
       for users who don't know what 20/100 means at a glance. */
    .analyze-score-tag {
      margin-top: 6px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .3px;
      text-transform: uppercase;
      color: var(--dim);
    }
    .analyze-score.high .analyze-score-tag { color: var(--green); }
    .analyze-score.mid  .analyze-score-tag { color: var(--yellow); }
    .analyze-score.low  .analyze-score-tag { color: #ff7849; }

    /* Footer — tiny technical note (deep-analysis status). Replaces the
       old big "Stage 1 ✓ / Stage 2 ⏭ memePotential 20 < threshold 70"
       pills which leaked engineer terminology onto the user surface. */
    .analyze-footer {
      padding: 10px 16px;
      border-top: 1px solid var(--border);
      background: rgba(255,255,255,.015);
    }
    .analyze-footer-text { font-size: 11px; color: var(--dim); }
    .analyze-explain {
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border);
    }
    .analyze-explain-label { font-size: 10px; font-weight: 700; letter-spacing: .5px; color: var(--dim); text-transform: uppercase; margin-bottom: 6px; }
    .analyze-explain-body {
      font-size: 13px; line-height: 1.55;
      color: var(--text);
      padding: 8px 12px;
      background: rgba(255,255,255,.025);
      border-left: 3px solid rgba(var(--accent-rgb), .55);
      border-radius: 0 8px 8px 0;
    }

    /* ── Account hero card ── */
    .account-hero {
      display: flex; align-items: center; gap: 18px;
      /* 2026-05-01: dropped the bright accent-gradient — was rendering an
         electric-blue diagonal across the card on the ink theme. Plain
         --surface matches the rest of the settings-cards. The avatar
         retains its accent ring as the single colour focal point. */
      background: var(--surface);
      border: 1px solid var(--border) !important;
    }
    .account-avatar-big {
      flex-shrink: 0;
      width: 64px; height: 64px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; font-weight: 800; letter-spacing: -1px;
      color: var(--text);
      /* Subtler avatar ring — was a heavy gradient + 2px accent border +
         coloured glow. On X-style monochrome the avatar should be the focal
         point but not shouty. */
      background: var(--card2);
      border: 1px solid rgba(var(--accent-rgb), .35);
      box-shadow: 0 2px 10px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.06);
      overflow: hidden;
    }
    .account-avatar-big img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .account-hero-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .account-hero-name {
      font-size: 18px; font-weight: 800; color: var(--text);
      letter-spacing: -.3px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .account-hero-sub { display: flex; flex-wrap: wrap; gap: 6px; }
    .account-hero-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 9px; border-radius: 999px;
      background: rgba(255,255,255,.04); border: 1px solid var(--border2);
      font-size: 10.5px;
    }
    .account-hero-chip-k { color: var(--muted); font-weight: 700; letter-spacing: .3px; }
    .account-hero-chip-v { color: var(--text2); font-family: 'JetBrains Mono', monospace; font-weight: 600; }
    .settings-title { font-size: 17px; font-weight: 800; color: var(--text); letter-spacing: -.3px; }
    .settings-card {
      /* 2026-05-01: was --card (#16181c) — too bright on the new ink theme.
         --surface matches feed-cards/right-section so everything reads as
         one calm monochrome surface. */
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 18px 20px; margin-bottom: 12px; box-shadow: var(--shadow);
    }
    .settings-card-title { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 3px; }
    .settings-card-desc  { font-size: 11px; color: var(--muted); margin-bottom: 16px; }

    /* ── Range slider (column width, etc.) ── */
    .slider-wrap { display: flex; align-items: center; gap: 10px; min-width: 220px; }
    .range-slider {
      flex: 1; height: 22px; padding: 0;
      -webkit-appearance: none; appearance: none;
      background: transparent;
      cursor: pointer;
    }
    .range-slider:focus { outline: none; }
    .range-slider::-webkit-slider-runnable-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(90deg, var(--accent) 0%, var(--accent2) 100%);
      opacity: .85;
    }
    .range-slider::-moz-range-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(90deg, var(--accent) 0%, var(--accent2) 100%);
      opacity: .85;
    }
    .range-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 16px; height: 16px; border-radius: 50%;
      background: var(--text); border: 2px solid var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow), 0 2px 6px rgba(0,0,0,.4);
      margin-top: -6px; cursor: grab;
      transition: transform .12s;
    }
    .range-slider::-moz-range-thumb {
      width: 16px; height: 16px; border-radius: 50%;
      background: var(--text); border: 2px solid var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow), 0 2px 6px rgba(0,0,0,.4);
      cursor: grab;
    }
    .range-slider:active::-webkit-slider-thumb { transform: scale(1.15); cursor: grabbing; }
    .range-slider:active::-moz-range-thumb     { transform: scale(1.15); cursor: grabbing; }
    .slider-val {
      min-width: 52px; text-align: right;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; font-weight: 700;
      color: var(--accent2);
    }
    .slider-reset {
      width: 26px; height: 26px; border-radius: 50%;
      background: rgba(255,255,255,.04); color: var(--muted);
      border: 1px solid var(--border2);
      cursor: pointer; font-size: 13px;
      display: inline-flex; align-items: center; justify-content: center;
      transition: all .15s;
    }
    .slider-reset:hover { color: var(--accent2); border-color: rgba(var(--accent-rgb), .35); background: var(--accent-glow); }

    /* Theme picker swatches */
    .theme-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 10px;
    }
    .theme-swatch {
      position: relative;
      display: flex; flex-direction: column; gap: 6px;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--border2);
      background: var(--card2);
      cursor: pointer;
      color: var(--text);
      font-family: inherit;
      transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
      overflow: hidden;
    }
    .theme-swatch:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(0,0,0,.35);
    }
    .theme-swatch.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-glow), 0 6px 18px rgba(0,0,0,.45);
    }
    .theme-swatch-label {
      font-size: 11px; font-weight: 600; color: var(--text2);
      margin-top: 4px;
      letter-spacing: .2px;
    }
    .theme-swatch-dot {
      display: inline-block;
      width: 100%; height: 14px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,.06);
    }
    /* Theme swatch previews — match the actual theme palettes above. Each
       row shows bg / accent / card so the user can preview at a glance. */
    .theme-swatch[data-theme-preview="pulse"] .theme-swatch-dot-bg     { background: #000000; }
    .theme-swatch[data-theme-preview="pulse"] .theme-swatch-dot-accent { background: #4ade80; }
    .theme-swatch[data-theme-preview="pulse"] .theme-swatch-dot-card   { background: #16181c; }
    .theme-swatch[data-theme-preview="ink"]   .theme-swatch-dot-bg     { background: #000000; }
    .theme-swatch[data-theme-preview="ink"]   .theme-swatch-dot-accent { background: #1d9bf0; }
    .theme-swatch[data-theme-preview="ink"]   .theme-swatch-dot-card   { background: #16181c; }
    .theme-swatch[data-theme-preview="tide"]  .theme-swatch-dot-bg     { background: #0a1622; }
    .theme-swatch[data-theme-preview="tide"]  .theme-swatch-dot-accent { background: #4dd4e0; }
    .theme-swatch[data-theme-preview="tide"]  .theme-swatch-dot-card   { background: #14202e; }
    .stats-view { display: grid; gap: 12px; }
    .stats-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .stats-block { padding: 14px 16px; }
    .stats-block-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .stats-block-title { font-size: 9px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--accent2); }
    .stats-block-sub { color: var(--dim); font-size: 10px; }
    .stats-list { display: flex; flex-direction: column; gap: 5px; }
    .stats-list-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border);
      background: rgba(255,255,255,.018);
    }
    .stats-list-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .stats-list-name { font-size: 12px; font-weight: 600; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stats-list-meta { font-size: 10px; color: var(--dim); }
    .stats-list-value { font-family: 'JetBrains Mono', monospace; font-weight: 700; color: var(--accent2); font-size: 11px; white-space: nowrap; }
    .stats-top-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .stats-top-card { padding: 11px; border-radius: 8px; border: 1px solid var(--border); background: rgba(255,255,255,.018); cursor: pointer; transition: border-color .15s, background .15s; }
    .stats-top-card:hover { border-color: rgba(var(--accent-rgb), .25); background: rgba(var(--accent-rgb), .05); }
    .stats-top-title { font-size: 12px; font-weight: 700; color: var(--text); margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .stats-top-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--muted); font-size: 10px; }
    .setting-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 20px; padding: 13px 0; border-top: 1px solid var(--border);
      min-width: 0;
    }
    .setting-row:first-of-type { border-top: none; }
    /* Stacked variant — for controls that need full row width (multi-toggle
       groups, long select dropdowns, etc.). Label sits on top; control
       fills the row below. */
    .setting-row-stacked {
      flex-direction: column; align-items: stretch; gap: 10px;
    }
    .setting-row-stacked .setting-control {
      width: 100%; flex-shrink: 1;
    }
    .setting-label {
      display: flex; flex-direction: column; gap: 3px; flex: 1;
      min-width: 0;
    }
    .setting-name  { font-size: 12px; font-weight: 600; color: var(--text); }
    .setting-hint  { font-size: 10px; color: var(--muted); line-height: 1.4; }
    .setting-control {
      display: flex; align-items: center; gap: 12px;
      /* Allow the control column to shrink so its inner content doesn't
         push the row wider than its parent (Account sheet at 560px). */
      min-width: 0; flex-shrink: 1;
      max-width: 100%;
    }
    .setting-control input[type=range] { width: 130px; accent-color: var(--accent); height: 3px; cursor: pointer; }
    .setting-val { font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 700; color: var(--accent2); min-width: 30px; text-align: right; }
    .settings-actions { display: flex; gap: 10px; margin-top: 10px; justify-content: center; }
    .settings-flash {
      margin-left: auto; font-size: 11px; font-weight: 600; color: var(--accent2);
      background: var(--accent-glow); border: 1px solid rgba(var(--accent-rgb), .22);
      padding: 4px 10px; border-radius: 999px; letter-spacing: .2px;
      animation: fadeIn .2s ease;
    }
    .settings-info { border-style: dashed; background: linear-gradient(180deg, rgba(var(--accent-rgb), .05), transparent); }

    /* ── Preference toggle switch ── */
    .pref-toggle {
      position: relative; width: 42px; height: 22px; flex-shrink: 0;
      border-radius: 999px; border: 1px solid var(--border);
      background: var(--card2); cursor: pointer; padding: 0;
      transition: background .15s, border-color .15s;
    }
    .pref-toggle.on { background: var(--accent); border-color: var(--accent); }
    .pref-toggle-knob {
      position: absolute; top: 2px; left: 2px;
      width: 16px; height: 16px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3);
      transition: transform .15s ease;
    }
    .pref-toggle.on .pref-toggle-knob { transform: translateX(20px); }

    /* ── Alert-type toggle group (settings card) ── */
    .atype-toggle-group {
      display: flex; flex-direction: column; gap: 6px;
      min-width: 0;        /* allow group to shrink inside narrow rows */
      max-width: 100%;
    }
    .atype-toggle {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
      background: var(--card2); color: var(--text); cursor: pointer;
      font-size: 12px; text-align: left; line-height: 1.3;
      transition: background .12s, border-color .12s;
      min-width: 0;        /* lets flex children inside actually shrink */
      width: 100%;
    }
    .atype-toggle:hover { border-color: var(--accent); background: rgba(255,255,255,.04); }
    .atype-toggle.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .atype-toggle:disabled { opacity: 0.6; cursor: wait; }
    .atype-toggle-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
    /* Label wraps cleanly on narrow widths instead of overflowing the
       toggle border. min-width:0 is the canonical fix for flex children
       that contain potentially-long text. */
    .atype-toggle-label {
      flex: 1; min-width: 0;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .atype-foot { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; font-size: 11px; }
    .atype-saved { color: var(--green2, #2ed573); }
    .atype-err   { color: var(--red2, #ff6b6b); }
    .atype-hint  { color: var(--dim); font-style: italic; }

    /* ── Body preference classes (applied by applyPrefsToDOM) ── */
    body.prefs-no-anim *, body.prefs-no-anim *:before, body.prefs-no-anim *:after {
      animation-duration: .001s !important; animation-delay: 0s !important;
      transition-duration: .001s !important;
    }
    /* Show-previews toggle — selectors fixed 2026-05-14. Earlier list referenced
       .feed-card-media / .card-media / .trend-modal-media which don't exist
       anywhere in the JSX, so the toggle was visually no-op. These are the
       real preview classes (carousel/image/video, both feed cards and modal).
       Note: display:none does NOT save bandwidth — <img src> still fetches.
       The toggle is currently «declutter only» (description copy updated). */
    body.prefs-no-images .feed-image-wrap,
    body.prefs-no-images .feed-image,
    body.prefs-no-images .feed-video-wrap,
    body.prefs-no-images .feed-video,
    body.prefs-no-images .img-carousel { display: none !important; }
    body.prefs-compact .feed-card { padding: 10px 12px; }
    body.prefs-compact .feed-card + .feed-card { margin-top: 6px; }
    body.prefs-compact .feed-list { gap: 6px; }

    /* ── Preset grid ── */
    .preset-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-top: 6px; }
    @media (max-width: 700px) { .preset-grid { grid-template-columns: repeat(3, 1fr); } }
    .preset-card {
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      padding: 12px 6px; border-radius: var(--radius-sm);
      border: 1px solid var(--border); background: var(--card2);
      cursor: pointer; text-align: center; transition: all .15s ease;
    }
    .preset-card:hover { border-color: var(--border3); background: var(--card3); transform: translateY(-1px); }
    .preset-card.active { border-color: var(--accent); background: rgba(var(--accent-rgb), .1); box-shadow: 0 0 0 1px var(--accent); }
    .preset-icon  { font-size: 20px; }
    .preset-label { font-size: 11px; font-weight: 700; color: var(--text); }
    .preset-hint  { font-size: 9px; color: var(--muted); line-height: 1.3; }

    /* ── Sidebar settings link ── */
    .sidebar-settings-btn {
      display: flex; align-items: center; gap: 9px;
      padding: 8px 10px; border-radius: var(--radius-sm);
      cursor: pointer; color: var(--muted);
      font-size: 12px; font-weight: 500;
      transition: all .15s ease; border: 1px solid transparent;
      margin-top: auto;
    }
    .sidebar-settings-btn:hover { background: rgba(255,255,255,.04); color: var(--text); }
    .sidebar-settings-btn.active { background: rgba(var(--accent-rgb), .1); color: var(--accent2); border-color: rgba(var(--accent-rgb), .2); }

    /* ── Card image thumbnail ── */
    .card-image-wrap { flex-shrink: 0; border-radius: 7px; overflow: hidden; background: var(--card3); border: 1px solid var(--border); position: relative; }
    .card-image-wrap img { width: 100%; height: 100%; object-fit: cover; transition: transform .25s ease; }
    .trend-card:hover .card-image-wrap img { transform: scale(1.04); }
    .card-image-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 24px; opacity: .18; }

    /* ── Copy button ── */
    .card-copy-btn {
      opacity: 0; pointer-events: none;
      background: var(--card3); border: 1px solid var(--border2);
      color: var(--muted); border-radius: 5px; padding: 2px 7px;
      font-size: 10px; cursor: pointer; transition: all .12s; white-space: nowrap;
    }
    .trend-card:hover .card-copy-btn { opacity: 1; pointer-events: auto; }
    .card-copy-btn:hover { background: var(--accent-glow); color: var(--accent2); border-color: var(--accent); }

    /* ── Search input ── */
    .search-wrap { position: relative; flex: 1; min-width: 170px; max-width: 300px; }
    .search-icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--dim); font-size: 12px; pointer-events: none; }
    .search-input {
      width: 100%; background: rgba(255,255,255,.03); border: 1px solid var(--border2);
      color: var(--text); padding: 5px 10px 5px 27px;
      border-radius: var(--radius-xs); font-size: 11px;
      outline: none; font-family: 'Inter', sans-serif; transition: border-color .15s;
    }
    .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
    .search-input::placeholder { color: var(--dim); }

    /* ── Toast notifications ── slides down from above the nav, Ink-styled.
       Pill-shaped, glassy, no left accent stripe (legacy artifact from the
       earlier right-side toast — removed 2026-05-06). Type signal carried
       by border tint + icon colour, not a side bar. */
    @keyframes toastIn  {
      from { opacity: 0; transform: translateY(-22px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes toastOut {
      from { opacity: 1; transform: translateY(0); }
      to   { opacity: 0; transform: translateY(-14px); }
    }
    .toasts-wrap {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9999;
      display: flex; flex-direction: column;
      gap: 8px;
      pointer-events: none;
      max-width: calc(100vw - 24px);
    }
    .toast {
      display: flex; align-items: center; gap: 10px;
      background: rgba(10,10,10,0.92);
      border: 1px solid var(--border, rgba(239,243,244,0.08));
      border-radius: 999px;
      padding: 9px 16px;
      font-size: 13px; font-weight: 500; color: var(--text, #e7e9ea);
      letter-spacing: .1px;
      /* Single layered shadow — depth without inset glossy lines that
         compete with the pill shape. */
      box-shadow:
        0 12px 32px -10px rgba(0,0,0,.65),
        0 2px 8px -2px rgba(0,0,0,.45);
      backdrop-filter: blur(14px) saturate(1.1);
      -webkit-backdrop-filter: blur(14px) saturate(1.1);
      animation: toastIn .22s cubic-bezier(.21,.62,.32,1.06);
      pointer-events: auto;
      max-width: 440px;
    }
    /* Type tinting via border + icon colour only. No left stripe. */
    .toast.info    { border-color: rgba(var(--accent-rgb), .30); }
    .toast.info    .toast-icon { color: var(--accent2, var(--accent)); }
    .toast.success { border-color: rgba(var(--green-rgb), .30); }
    .toast.success .toast-icon { color: var(--green2, var(--green)); }
    .toast.error   { border-color: rgba(var(--red-rgb), .30); }
    .toast.error   .toast-icon { color: var(--red2, var(--red)); }
    .toast-icon {
      font-size: 13px;
      flex-shrink: 0;
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      line-height: 1;
    }
    .toast-msg { flex: 1; line-height: 1.4; white-space: nowrap; }
    @media (max-width: 540px) {
      .toasts-wrap { top: 10px; }
      .toast { max-width: calc(100vw - 24px); }
      .toast-msg { white-space: normal; }
    }

    /* ── Refresh badge + keyboard hints ── */
    .refresh-badge {
      font-family: 'JetBrains Mono', monospace; font-size: 10px;
      color: var(--dim); background: rgba(255,255,255,.03);
      border: 1px solid var(--border); border-radius: 6px;
      padding: 3px 8px; white-space: nowrap;
    }
    .kbd { display: inline-block; background: rgba(255,255,255,.05); border: 1px solid var(--border2); border-radius: 4px; padding: 1px 5px; font-size: 9px; font-family: 'JetBrains Mono', monospace; color: var(--dim); }

    /* ── Settings modal (centered, blurred backdrop) ── */
    @keyframes sheetIn  { from { opacity:0; } to { opacity:1; } }
    @keyframes sheetPop { from { opacity:0; transform: translateY(12px) scale(.97); } to { opacity:1; transform: translateY(0) scale(1); } }
    .sheet-overlay {
      position: fixed; inset: 0; z-index: 7000;
      /* 2026-05-01: was rgba(4,6,14,.55) — leftover blue tint from the old
         midnight palette + saturate(1.1) which amplified any remaining blue
         in the page behind the blur. Pure black at higher opacity gives a
         neutral, theme-agnostic blackout. */
      background: rgba(0,0,0,.62);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      animation: sheetIn .22s ease;
      display: flex; align-items: center; justify-content: center;
      padding: 28px 20px;
      overflow-y: auto;
    }
    .sheet {
      position: relative;
      width: 100%; max-width: 720px;
      max-height: calc(100vh - 56px);
      background: linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%);
      border: 1px solid var(--border2);
      border-radius: 16px;
      box-shadow: 0 24px 80px rgba(0,0,0,.7), 0 0 0 1px rgba(var(--accent-rgb), .08);
      animation: sheetPop .28s cubic-bezier(.2,.8,.2,1);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    /* Narrow Analyze sheet — input form + result preview reads better at
       a tighter width. Same for Account (profile + settings rows). */
    .sheet.sheet-narrow { max-width: 560px; }
    .sheet-head {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(var(--accent-rgb), .05), transparent);
      flex-shrink: 0;
    }
    .sheet-title {
      font-size: 14px; font-weight: 800; color: var(--text);
      letter-spacing: -.2px;
      display: flex; align-items: center; gap: 8px;
    }
    .sheet-title-ico { font-size: 18px; filter: saturate(1.2); }
    .sheet-close {
      margin-left: auto;
      width: 30px; height: 30px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,.04); border: 1px solid var(--border2);
      color: var(--muted); border-radius: 8px;
      cursor: pointer; font-size: 14px;
      transition: all .12s;
    }
    .sheet-close:hover {
      background: rgba(var(--red-rgb), .12); color: var(--red2);
      border-color: rgba(var(--red-rgb), .3);
    }
    .sheet-body {
      flex: 1; min-height: 0;
      overflow-y: auto;
      padding: 18px 20px 24px;
    }
    /* Hide the in-panel header (back button) when rendered inside a sheet —
       the sheet has its own header and close button. */
    .sheet-body .settings-header { display: none; }
    .sheet-body .settings-panel  { padding-bottom: 0; }
    @media (max-width: 700px) {
      .sheet-overlay { padding: 10px; }
      .sheet { border-radius: 12px; max-height: calc(100vh - 20px); }
    }

    /* ── Modal overlay (kept for TrendModal) ── */
    @keyframes modalIn  { from { opacity:0; } to { opacity:1; } }
    @keyframes drawerIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .modal-overlay {
      position: fixed; inset: 0; z-index: 8000;
      background: rgba(0,0,0,.75); backdrop-filter: blur(3px);
      animation: modalIn .18s ease; display: flex; justify-content: flex-end;
    }
    .modal-drawer {
      width: 520px; max-width: 95vw; height: 100vh;
      background: var(--surface); border-left: 1px solid var(--border2);
      display: flex; flex-direction: column;
      animation: drawerIn .22s cubic-bezier(.4,0,.2,1);
      box-shadow: -6px 0 40px rgba(0,0,0,.65); overflow: hidden;
    }
    .modal-head {
      display: flex; align-items: center; gap: 11px;
      padding: 13px 15px; border-bottom: 1px solid var(--border);
      flex-shrink: 0; background: var(--card);
    }
    .modal-close {
      margin-left: auto; background: rgba(255,255,255,.04); border: 1px solid var(--border2);
      color: var(--muted); border-radius: 6px; padding: 5px 9px;
      cursor: pointer; font-size: 12px; transition: all .12s; flex-shrink: 0;
    }
    .modal-close:hover { background: rgba(var(--red-rgb), .12); color: var(--red2); border-color: rgba(var(--red-rgb), .25); }
    .modal-body { flex: 1; overflow-y: auto; padding: 16px 16px 36px; display: flex; flex-direction: column; gap: 14px; }

    /* ── Modal image ── */
    /* Matches .feed-image: bounded max-height + contain so portraits / GIFs
       aren't cropped. The dark wrap supplies letterbox bg for narrower images. */
    .modal-image-wrap {
      position: relative;
      width: 100%;
      border-radius: 8px;
      overflow: hidden;
      background: #0a0a12;
      border: 1px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      /* Fixed min-height keeps the frame from collapsing when the video
         element renders at its 300×150 default before metadata loads,
         or when a Twitter poster URL is an oddly cropped banner. */
      min-height: 200px;
      max-height: 260px;
    }
    .modal-image {
      display: block;
      width: 100%;
      height: auto;
      max-height: 260px;
      object-fit: contain;
    }
    /* Lightbox cursor only on images, not on the video player. The <video>
       shares the .modal-image class for sizing, so without this scope the
       zoom-in cursor would also override the video's native controls cursor. */
    img.modal-image { cursor: zoom-in; }
    /* <video> has no intrinsic size until metadata loads (default 300×150,
       i.e. 2:1). With width:100% + height:auto that produces a flat letterbox
       and the poster gets squashed to a thin strip. Force a sane 16:9 default
       — once the real video metadata arrives the browser updates intrinsic
       dimensions and aspect-ratio is overridden by the natural ratio. */
    video.modal-image { aspect-ratio: 16 / 9; height: 100%; }
    .modal-image-loading {
      /* Match the in-modal carousel height (440px) so when preview returns
         multiple images, the layout doesn't jump by 220px. Single-image
         render also uses min-height 260px on .modal-image-wrap, so 440px
         here is a slight upper bound — fine for shimmer. */
      height: 440px; border-radius: 8px;
      background: linear-gradient(90deg, var(--card2) 25%, var(--card3) 50%, var(--card2) 75%);
      background-size: 200% 100%; animation: shimmer 1.5s linear infinite; border: 1px solid var(--border);
    }
    /* Secondary carousel under a primary video — slimmer than .img-carousel.in-modal */
    .modal-aux-gallery {
      margin-top: 8px;
    }
    .modal-aux-gallery .img-carousel.in-modal {
      height: 220px;
    }

    /* ── Image lightbox ──
       Click any image in the modal carousel / single-image wrap to open it
       at near-full-viewport size, centered. Click anywhere outside (or on
       the image, or hit Esc) to close. Z-index must beat .modal-overlay
       (8000) but stay under .toasts-wrap (9999) so toast notifications
       still render on top of the lightbox if any fire while it's open. */
    .img-lightbox-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, .88);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 9000;
      display: flex; align-items: center; justify-content: center;
      padding: 4vh 4vw;
      cursor: zoom-out;
      animation: lightbox-fade .15s ease-out;
    }
    @keyframes lightbox-fade {
      from { opacity: 0; } to { opacity: 1; }
    }
    .img-lightbox-img {
      max-width: 92vw;
      max-height: 92vh;
      object-fit: contain;
      border-radius: 6px;
      box-shadow: 0 20px 60px rgba(0,0,0,.6);
      display: block;
    }
    .img-lightbox-close {
      position: fixed; top: 20px; right: 24px;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.18);
      color: #fff;
      width: 40px; height: 40px;
      border-radius: 50%;
      font-size: 22px; line-height: 1;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px);
      transition: background .15s, transform .15s;
    }
    .img-lightbox-close:hover {
      background: rgba(255,255,255,.16);
      transform: scale(1.05);
    }

    /* ── Tweet hover preview ──
       Floating card that appears next to tweet links inside .feed and
       .modal-overlay. Renders via portal to document.body, so positioning is
       fixed-coords (parent stacking context doesn't apply). z-index 7500 sits
       above the modal overlay (8000... wait, actually below). Re-checking:
       modal-overlay z-index ~8000, lightbox 9000. We want the hover card to
       appear ON TOP of feed (no z-index needed) AND on top of modal. So 8500.
       Toasts (9999) still win — that's correct, errors should always be on top. */
    .tw-prev-card {
      position: fixed;
      z-index: 8500;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 12px 36px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.02);
      font-size: 13px;
      color: var(--text);
      display: flex; flex-direction: column; gap: 9px;
      pointer-events: auto;          /* card itself is hoverable (keeps card alive) */
      animation: tw-prev-fade .12s ease-out;
      user-select: text;             /* let user copy tweet text */
    }
    @keyframes tw-prev-fade {
      from { opacity: 0; transform: translateY(-2px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .tw-prev-card.above {
      animation: tw-prev-fade-up .12s ease-out;
    }
    @keyframes tw-prev-fade-up {
      from { opacity: 0; transform: translateY(2px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .tw-prev-loading, .tw-prev-error {
      padding: 8px 4px;
      color: var(--text2);
      font-size: 12px;
      text-align: center;
    }
    .tw-prev-error { color: #ff8585; }
    .tw-prev-head { display: flex; align-items: center; gap: 9px; }
    .tw-prev-avatar {
      width: 38px; height: 38px;
      border-radius: 50%;
      background: var(--bg2);
      object-fit: cover;
      flex-shrink: 0;
    }
    .tw-prev-avatar-fb {
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; color: var(--text2); font-size: 16px;
    }
    .tw-prev-author { flex: 1; min-width: 0; }
    .tw-prev-name {
      font-weight: 700; font-size: 13px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .tw-prev-handle {
      font-size: 12px; color: var(--text2);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* Profile-link styling for name/handle/avatar — anchor tags inside the
       hover card. Inherit color so they don't paint as default-blue and
       break the dark theme; underline only on hover for affordance. */
    a.tw-prev-link {
      color: inherit;
      text-decoration: none;
      cursor: pointer;
      display: block;
    }
    a.tw-prev-link:hover {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    a.tw-prev-link.tw-prev-name:hover { color: var(--accent, #1d9bf0); }
    /* Avatar wrapped in <a> — keep avatar's own dimensions, just inherit
       the cursor + hover affordance from the parent anchor. */
    .tw-prev-head > a { flex-shrink: 0; line-height: 0; }
    .tw-prev-head > a > .tw-prev-avatar {
      transition: transform .12s ease, opacity .12s ease;
    }
    .tw-prev-head > a:hover > .tw-prev-avatar {
      transform: scale(1.05);
      opacity: .9;
    }
    .tw-prev-x {
      color: var(--text2);
      font-size: 16px;
      flex-shrink: 0;
    }
    /* Reddit-flavored variants — same chrome, different brand mark */
    .tw-prev-x-reddit {
      color: #ff4500;
      font-weight: 700;
    }
    .tw-prev-avatar-reddit {
      background: #ff4500;
      color: #fff;
      font-weight: 800;
    }
    /* Reddit posts have a real title (separate from body text); show it
       above the selftext so the hover card reads naturally. */
    .tw-prev-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
      line-height: 1.35;
      letter-spacing: -.2px;
    }
    .tw-prev-text {
      font-size: 13px;
      line-height: 1.45;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
      /* Most tweets ≤ 280 chars (~6-8 lines) fit unconstrained. For long-form
         X premium posts (up to ~25k chars) the card stays bounded by viewport
         and the user can scroll within. Padding-right reserves space for the
         scrollbar so emoji-rich text doesn't shift when overflow kicks in. */
      max-height: 380px;
      overflow-y: auto;
      padding-right: 4px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,.18) transparent;
    }
    .tw-prev-text::-webkit-scrollbar { width: 6px; }
    .tw-prev-text::-webkit-scrollbar-track { background: transparent; }
    .tw-prev-text::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.18);
      border-radius: 3px;
    }
    .tw-prev-text::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,.28);
    }
    .tw-prev-media {
      position: relative;
      border-radius: 8px;
      overflow: hidden;
      background: #0a0a12;
      border: 1px solid var(--border);
      max-height: 240px;
    }
    .tw-prev-media img {
      display: block;
      width: 100%;
      max-height: 240px;
      object-fit: cover;
    }
    .tw-prev-play {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 36px;
      color: rgba(255,255,255,.92);
      text-shadow: 0 2px 8px rgba(0,0,0,.65);
      pointer-events: none;
    }
    .tw-prev-meta {
      display: flex; flex-wrap: wrap; gap: 10px;
      font-size: 12px; color: var(--text2);
    }
    .tw-prev-meta span { display: inline-flex; align-items: center; gap: 3px; }
    .tw-prev-date {
      margin-left: auto;
      color: var(--dim);
      font-size: 11px;
    }

    /* ── Modal sections ── */
    .modal-title { font-size: 15px; font-weight: 800; color: var(--text); line-height: 1.35; letter-spacing: -.25px; }
    .modal-section { display: flex; flex-direction: column; gap: 7px; }
    .modal-section-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); font-weight: 700; }
    .modal-section-content { font-size: 12px; color: var(--text2); line-height: 1.55; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 11px 13px; }
    .modal-section-content.pump { color: var(--orange); border-color: rgba(var(--orange-rgb), .15); background: rgba(var(--orange-rgb), .05); }
    .modal-section-content.why-now { color: #ff6b6b; border-color: rgba(255, 107, 107, .18); background: rgba(255, 107, 107, .06); font-weight: 500; }
    /* Subject-name highlight — the names extracted by Gemini / Stage 2 / nano
       are wrapped in <span class="subject-hl"> so they pop in title and
       summary text. Yellow accent matches the existing $TICKER chip color. */
    .subject-hl { color: #fdcb6e; font-weight: 700; }
    .modal-title .subject-hl { background: rgba(253, 203, 110, .14); padding: 0 3px; border-radius: 3px; }
    .modal-section-content .subject-hl { background: rgba(253, 203, 110, .12); padding: 0 2px; border-radius: 2px; }
    .feed-title .subject-hl { color: #fdcb6e; }
    /* .pref-chip* CSS removed 2026-04-27 with PersonalizationCard. */
    .modal-stats-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 7px; }
    .modal-stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; }
    .modal-stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: .7px; color: var(--dim); font-weight: 600; }
    .modal-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }

    /* Engagement metrics row inside the Virality stat cell — emoji + count
       per signal (views/likes/comments/reposts). Two-column grid so 4
       metrics never overflow on narrow modals. */
    .modal-engagement {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px 10px;
    }
    .modal-engagement-item {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--text);
      font-weight: 700;
      letter-spacing: .2px;
    }
    .modal-engagement-ico { font-size: 11px; opacity: .85; }
    .modal-engagement-num { font-variant-numeric: tabular-nums; }

    /* X Trends source-tweets list — clickable rows with text + per-tweet
       engagement. Each row is an anchor so hover-preview (data-tweet-id)
       works as on any other Twitter link. */
    .xtrends-toptweets { display: flex; flex-direction: column; gap: 6px; }
    .xtrends-toptweet {
      display: block;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 11px;
      text-decoration: none;
      color: var(--text);
      transition: border-color .12s, background .12s;
    }
    .xtrends-toptweet:hover {
      border-color: rgba(var(--accent-rgb), .45);
      background: rgba(var(--accent-rgb), .04);
    }
    .xtrends-toptweet-head {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 4px;
    }
    .xtrends-toptweet-author {
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      font-family: 'JetBrains Mono', monospace;
    }
    .xtrends-toptweet-text {
      font-size: 12.5px;
      line-height: 1.45;
      color: var(--text);
      margin-bottom: 6px;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    .xtrends-toptweet-engage {
      display: flex; flex-wrap: wrap; gap: 10px;
      font-size: 11px;
      color: var(--dim);
      font-family: 'JetBrains Mono', monospace;
    }
    .xtrends-toptweet-engage span { display: inline-flex; align-items: center; gap: 4px; }

    /* Story hook — pull-quote rendered after the score bars. Accent left
       border + slight surface lift, italic body, big quote marks. Not a
       generic blockquote because the modal content is dense and we want
       the hook to read as a single line, not a paragraph. */
    .story-hook {
      margin-top: 10px;
      padding: 10px 14px 10px 12px;
      border-left: 3px solid var(--accent);
      background: linear-gradient(90deg, rgba(var(--accent-rgb), .06), rgba(255,255,255,.01) 60%);
      border-radius: 6px;
      display: flex; align-items: flex-start; gap: 6px;
      font-size: 13px; line-height: 1.5;
      color: var(--text);
      font-style: italic;
      box-shadow: var(--gloss-top);
    }
    .story-hook-mark {
      font-family: Georgia, serif;
      font-size: 22px;
      line-height: 1;
      color: var(--accent);
      font-weight: 700;
      flex-shrink: 0;
      transform: translateY(2px);
    }
    .story-hook-mark.right { transform: translateY(8px); }
    .story-hook-text { flex: 1; }

    /* ── Alert verdict — compact header + collapsible math panel ──
       The header is always visible (verdict pill + alertType chip + toggle
       button); the math panel only renders when the user clicks "show math".
       Same visual language as the admin Decisions page MathPanel so anyone
       used to one is at home in the other. */
    .alert-verdict-header {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      font-size: 12px;
    }
    .alert-verdict-pill {
      padding: 4px 12px; border-radius: 6px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-weight: 700;
    }
    .alert-verdict-pill.pass {
      background: rgba(var(--green-rgb), .15); color: var(--green2);
    }
    .alert-verdict-pill.fail {
      background: rgba(var(--red-rgb), .15); color: #ff6b6b;
    }
    .alert-type-chip {
      padding: 4px 10px; border-radius: 6px;
      background: rgba(140,140,140,.10); color: var(--dim);
    }
    .alert-type-chip.muted {
      background: rgba(var(--red-rgb), .10); color: #ff6b6b;
    }
    .alert-details-btn {
      margin-left: auto; padding: 4px 12px;
      background: rgba(255,255,255,.04);
      border: 1px solid var(--border);
      color: var(--text2); font-size: 11px; border-radius: 6px;
      font-family: inherit; cursor: pointer;
      transition: background 120ms, border-color 120ms, color 120ms;
      white-space: nowrap;
    }
    .alert-details-btn:hover {
      background: rgba(255,255,255,.07);
      border-color: var(--border2); color: var(--text);
    }
    .alert-details-btn.open {
      background: rgba(var(--accent-rgb), .08);
      border-color: rgba(var(--accent-rgb), .25);
      color: var(--accent2);
    }
    .alert-math-panel {
      margin-top: 10px; padding: 12px;
      background: linear-gradient(180deg, rgba(var(--accent-rgb), .04), rgba(255,255,255,.01));
      border: 1px solid rgba(var(--accent-rgb), .18);
      border-radius: 8px;
    }
    .alert-math-panel.empty {
      text-align: center; color: var(--muted); font-size: 12px;
      padding: 20px 12px; font-style: italic;
    }
    .alert-math-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    }
    @media (max-width: 720px) {
      .alert-math-grid { grid-template-columns: 1fr; }
    }
    .alert-math-section {
      background: rgba(0,0,0,.20); border-radius: 6px;
      padding: 9px 11px; border: 1px solid rgba(255,255,255,.04);
    }
    .alert-math-h {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 10px; text-transform: uppercase; letter-spacing: .6px;
      color: var(--text2); font-weight: 700; margin-bottom: 7px;
      gap: 8px;
    }
    .alert-math-sum {
      font-size: 10px; padding: 2px 6px; border-radius: 3px;
      background: rgba(255,255,255,.05); color: var(--muted);
      letter-spacing: 0; text-transform: none;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-weight: 700;
    }
    .alert-math-sum.pos { color: var(--green2); }
    .alert-math-sum.neg { color: #ff8a93; }
    .alert-math-table {
      width: 100%; border-collapse: collapse; font-size: 12px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .alert-math-table td {
      padding: 4px 5px;
      border-bottom: 1px solid rgba(255,255,255,.03);
    }
    .alert-math-table tr:last-child td { border-bottom: none; }
    .alert-math-table td.lbl { color: var(--text2); width: 32%; }
    .alert-math-table td.calc {
      color: var(--muted); text-align: right; font-size: 11px;
    }
    .alert-math-table td.val {
      text-align: right; font-weight: 700; width: 22%;
    }
    .alert-math-table td.val.pos { color: var(--green); }
    .alert-math-table td.val.neg { color: var(--red); }
    .alert-math-table td.val.zero { color: var(--dim); }
    .alert-math-table tr.muted td { opacity: .45; }

    .alert-math-reasons {
      margin-top: 7px; padding-top: 7px;
      border-top: 1px dashed rgba(255,255,255,.06);
      font-size: 11px;
      display: flex; flex-wrap: wrap; gap: 5px; align-items: center;
    }
    .alert-math-reasons .lbl {
      color: var(--muted);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      margin-right: 3px;
    }
    .alert-math-reasons .tag {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      color: #ff8a93;
      background: rgba(var(--red-rgb), .10);
      border: 1px solid rgba(var(--red-rgb), .25);
      padding: 1px 7px; border-radius: 3px; font-size: 11px;
    }
    .alert-math-reasons .tag.safe {
      color: #7fcfff;
      background: rgba(120,180,255,.08);
      border-color: rgba(120,180,255,.25);
    }
    .alert-math-eq {
      margin-top: 10px; padding: 9px 12px;
      background: rgba(0,0,0,.30); border-radius: 6px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 13px; text-align: center;
      color: var(--text2); line-height: 1.7;
    }
    .alert-math-eq .pos { color: var(--green); font-weight: 700; }
    .alert-math-eq .neg { color: var(--red); font-weight: 700; }
    .alert-math-eq .final {
      font-weight: 800; font-size: 17px; margin-left: 6px;
      color: var(--text);
    }
    .alert-math-eq .final.pass { color: var(--green); }
    .alert-math-eq .final.fail { color: var(--red); }
    .alert-math-eq .cmp {
      color: var(--muted); font-size: 12px; margin-left: 4px;
    }
    .alert-math-floor {
      margin-top: 7px; font-size: 11px;
      color: var(--muted); text-align: center;
    }

    /* ── Term-help (?) tooltip ──
       Small "?" bubble next to term labels (Meme Score, Velocity, Emergence,
       etc). On hover shows a CSS-only tooltip with a plain-text definition.
       Admin-gated for now via the isAdmin flag in TrendModal — when we
       open it up to all users, just remove the gate, no CSS change. */
    .term-help {
      display: inline-flex; align-items: center; justify-content: center;
      width: 13px; height: 13px;
      margin-left: 5px;
      vertical-align: middle;
      border-radius: 50%;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.08);
      color: var(--muted);
      font-size: 9px; font-weight: 700; font-family: inherit;
      letter-spacing: 0; text-transform: none;
      cursor: help;
      position: relative;
      user-select: none;
      transition: background 120ms, color 120ms, border-color 120ms;
    }
    .term-help:hover {
      background: rgba(var(--accent-rgb), .15);
      border-color: rgba(var(--accent-rgb), .35);
      color: var(--accent2);
    }
    /* Tooltip body — positioned BELOW the icon (not above, to avoid getting
       clipped by the modal/viewport top edge), and anchored by the LEFT edge
       (not centered, to avoid clipping when the icon is near the left side
       of its container — which is where most of our labels live). The
       .right modifier flips the horizontal anchor for icons near a right
       edge (e.g. Alert tile in the modal-stat grid). */
    .term-help::before {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      width: 220px;
      max-width: calc(100vw - 40px);
      padding: 9px 11px;
      background: #16181c;
      border: 1px solid rgba(255,255,255,.10);
      border-radius: 6px;
      font-size: 11px; font-weight: 400;
      color: var(--text2);
      letter-spacing: 0; text-transform: none;
      white-space: normal;
      text-align: left;
      line-height: 1.5;
      opacity: 0;
      pointer-events: none;
      transition: opacity 150ms;
      z-index: 100;
      box-shadow: 0 6px 20px rgba(0,0,0,.5);
    }
    .term-help::after {
      content: '';
      position: absolute;
      top: calc(100% + 2px);
      left: 4px;
      border: 5px solid transparent;
      border-bottom-color: rgba(255,255,255,.10);
      opacity: 0;
      pointer-events: none;
      transition: opacity 150ms;
    }
    .term-help:hover::before, .term-help:hover::after {
      opacity: 1;
    }
    /* Right-edge variant: tooltip anchors to the right edge of the icon and
       extends leftward. Used for icons near the right side of containers
       (the Alert tile is the typical case). */
    .term-help.right::before {
      left: auto; right: 0;
    }
    .term-help.right::after {
      left: auto; right: 4px;
    }

    /* ── Sparkline (alertScore evolution) ── */
    .alert-spark {
      margin-top: 12px; padding: 10px 12px;
      background: rgba(0,0,0,.20);
      border: 1px solid rgba(255,255,255,.04);
      border-radius: 6px;
    }
    .alert-spark-header {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 10px; text-transform: uppercase; letter-spacing: .6px;
      color: var(--text2); font-weight: 700; margin-bottom: 6px;
    }
    .alert-spark-header .lbl { color: var(--text2); }
    .alert-spark-header .meta {
      color: var(--muted); font-weight: 600;
      letter-spacing: 0; text-transform: none; font-size: 11px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .alert-spark-header .meta .delta {
      margin-left: 4px; font-weight: 700;
      padding: 1px 6px; border-radius: 3px;
      background: rgba(255,255,255,.04);
    }
    .alert-spark-header .meta .delta.pos { color: var(--green); }
    .alert-spark-header .meta .delta.neg { color: #ff8a93; }
    .alert-spark-header .meta .delta.zero { color: var(--muted); }
    .alert-spark-svg {
      display: block; width: 100%; height: 56px;
    }
    .alert-spark-svg .alert-spark-floor {
      stroke: var(--muted); stroke-width: 1;
      stroke-dasharray: 3,3; opacity: .5;
    }
    .alert-spark-legend {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; margin-top: 5px;
      font-size: 10px; color: var(--muted);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .alert-spark-legend .arrow { color: var(--dim); }

    /* ── Catalyst forecast (TriggerSection) ── */
    /* Forecast body — neutral accent-tinted, NOT red (red is reserved for the
       past-event block, see why-now). Slightly larger leading and a soft
       accent border for a "forecast / forward" feel. */
    .modal-section-content.catalyst-forecast {
      color: var(--text);
      border-color: rgba(var(--accent-rgb), .14);
      background: rgba(var(--accent-rgb), .04);
      font-weight: 400;
      line-height: 1.6;
      font-size: 12.5px;
    }

    /* Phase + window chips. Use the same tinted-gradient pattern as story-hook
       but with phase-specific accent so the curve state is glanceable. */
    .catalyst-chips {
      display: flex; flex-wrap: wrap; gap: 7px;
      margin-top: 12px;
    }
    .catalyst-chip {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 5px 11px;
      border-radius: 999px;
      font-size: 11px; font-weight: 600;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.08);
      color: var(--text2);
      box-shadow: var(--gloss-top);
    }
    .catalyst-chip-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: 1px;
      color: var(--dim); font-weight: 700;
    }
    .catalyst-chip-val { color: var(--text); }

    /* Phase tints — semantic colors stay constant across themes. */
    .phase-early     { background: rgba(34,197,94,.10);  border-color: rgba(34,197,94,.28); }
    .phase-building  { background: rgba(29,155,240,.12); border-color: rgba(29,155,240,.32); }
    .phase-peaking   { background: rgba(255,176,32,.12); border-color: rgba(255,176,32,.36); }
    .phase-saturated { background: rgba(255,255,255,.04); border-color: rgba(255,255,255,.12); }
    .phase-fading    { background: rgba(239,68,68,.10);  border-color: rgba(239,68,68,.28); }
    .phase-early     .catalyst-chip-val { color: var(--green2, #22c55e); }
    .phase-building  .catalyst-chip-val { color: var(--accent); }
    .phase-peaking   .catalyst-chip-val { color: var(--orange, #ffb020); }
    .phase-fading    .catalyst-chip-val { color: var(--red2,   #ef4444); }

    /* Drivers / Risks bullet lists — compact, accent-tinted left edge. */
    .catalyst-bullets {
      margin-top: 10px;
      padding: 8px 10px 8px 12px;
      border-left: 2px solid rgba(255,255,255,.10);
      border-radius: 4px;
      background: rgba(255,255,255,.02);
    }
    .catalyst-drivers { border-left-color: rgba(var(--accent-rgb), .55); }
    .catalyst-risks   { border-left-color: rgba(239,68,68,.45); background: rgba(239,68,68,.04); }
    .catalyst-bullets-head {
      font-size: 9px; text-transform: uppercase; letter-spacing: 1px;
      color: var(--dim); font-weight: 700;
      margin-bottom: 4px;
    }
    .catalyst-drivers .catalyst-bullets-head { color: var(--accent); }
    .catalyst-risks   .catalyst-bullets-head { color: var(--red2, #ef4444); }
    .catalyst-bullets-list {
      margin: 0; padding-left: 16px;
      font-size: 12.5px; line-height: 1.55;
      color: var(--text);
    }
    .catalyst-bullets-list li { margin: 2px 0; }

    /* Sources — X handle pills with brand-blue tint and hover lift. */
    .catalyst-sources {
      margin-top: 14px;
      padding: 10px 12px 11px;
      border-radius: 8px;
      background: rgba(255,255,255,.02);
      border: 1px solid rgba(255,255,255,.06);
    }
    .catalyst-sources-head {
      font-size: 9px; text-transform: uppercase; letter-spacing: 1px;
      color: var(--dim); font-weight: 700;
      margin-bottom: 7px;
    }
    .catalyst-sources-list {
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    .catalyst-source-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px 4px 8px;
      border-radius: 999px;
      background: rgba(29,155,240,.08);
      border: 1px solid rgba(29,155,240,.22);
      color: var(--text);
      font-size: 11.5px; font-weight: 500;
      text-decoration: none;
      transition: background .15s ease, border-color .15s ease, transform .15s ease;
      box-shadow: var(--gloss-top);
    }
    .catalyst-source-pill:hover {
      background: rgba(29,155,240,.18);
      border-color: rgba(29,155,240,.42);
      transform: translateY(-1px);
    }
    .catalyst-source-x {
      font-size: 12px;
      color: rgb(29,155,240);
      font-weight: 700;
      line-height: 1;
    }
    .catalyst-source-handle { color: var(--text); }

    /* Confidence — gradient progress bar (red→orange→green) instead of plain text.
       Color of the fill is bucketed so low confidence reads red, high reads green. */
    .catalyst-confidence {
      display: flex; align-items: center; gap: 10px;
      margin-top: 12px;
      padding: 0 2px;
    }
    .catalyst-confidence-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: 1px;
      color: var(--dim); font-weight: 700;
      flex-shrink: 0;
    }
    .catalyst-confidence-bar {
      flex: 1;
      height: 5px;
      border-radius: 3px;
      background: rgba(255,255,255,.06);
      overflow: hidden;
    }
    .catalyst-confidence-fill {
      height: 100%;
      border-radius: 3px;
      transition: width .4s ease;
    }
    .conf-low  { background: linear-gradient(90deg, rgba(239,68,68,.7),  rgba(239,68,68,1));  }
    .conf-mid  { background: linear-gradient(90deg, rgba(255,176,32,.7), rgba(255,176,32,1)); }
    .conf-high { background: linear-gradient(90deg, rgba(34,197,94,.7),  rgba(34,197,94,1));  }
    .catalyst-confidence-val {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 11.5px;
      color: var(--text);
      font-weight: 600;
      min-width: 36px; text-align: right;
    }

    /* ── Sentiment ── */
    .sentiment-pos { color: var(--green2); font-weight: 600; }
    .sentiment-neg { color: var(--red2);   font-weight: 600; }
    .sentiment-neu { color: var(--muted); }

    /* ── Dashboard 3-column grid — app-shell, only feed scrolls ──
       Column widths controlled via --col-left / --col-right CSS vars set
       on <body> by the user's saved prefs. Middle column is 1fr.
       Two 6px resizers separate the columns; user can drag them. */
    :root {
      --col-left:  240px;
      --col-right: 300px;
    }
    .dashboard-grid {
      display: grid;
      grid-template-columns: var(--col-left) 6px 1fr 6px var(--col-right);
      height: calc(100vh - 50px); /* viewport - nav (statusbar removed 2026-05-02) */
      overflow: hidden;
    }

    /* Draggable column resizer handles */
    .col-resizer {
      position: relative;
      cursor: col-resize;
      background: transparent;
      z-index: 5;
      transition: background .18s ease;
      touch-action: none;
      user-select: none;
    }
    .col-resizer::before {
      content: '';
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 2px; height: 36px;
      border-radius: 2px;
      background: var(--border3);
      transition: background .15s, height .15s, width .15s, box-shadow .15s;
    }
    .col-resizer::after {
      /* widen the grab area beyond the visual handle */
      content: '';
      position: absolute; top: 0; bottom: 0; left: -3px; right: -3px;
    }
    /* Right-side resizer must NOT eat into the main-feed scrollbar — extend
       the grab area only toward the panel side. */
    .col-resizer-right::after { left: 0; right: -5px; }
    .col-resizer:hover { background: rgba(var(--accent-rgb), .08); }
    .col-resizer:hover::before {
      background: var(--accent);
      height: 60px; width: 3px;
      box-shadow: 0 0 10px var(--accent-glow);
    }
    body.is-resizing { cursor: col-resize !important; user-select: none; }
    body.is-resizing * { cursor: col-resize !important; }
    body.is-resizing .col-resizer { background: rgba(var(--accent-rgb), .14); }
    body.is-resizing .col-resizer::before {
      background: var(--accent);
      height: 80px; width: 3px;
      box-shadow: 0 0 14px var(--accent-glow), 0 0 28px var(--accent-glow);
    }
    .dashboard-grid > .sidebar {
      position: static !important;
      height: 100%;
      width: auto;
      /* Critical: base .sidebar sets min-width: 240px which would force the
         sidebar to bleed into the feed track when the user drags the resizer
         below 240px (the resizer clamps to 180px min). Reset min-width here
         so the grid track is the authoritative width — same trick as the
         min-width:0 on .main-feed below. */
      min-width: 0;
      /* overflow-y: auto when content can grow past the viewport (e.g. lots
         of sources); scrollbar-gutter prevents the scrollbar from causing a
         layout shift when it does appear. */
      overflow-y: auto;
      scrollbar-gutter: stable;
      border-right: 1px solid var(--border);
      padding: 10px 10px 6px;
    }
    .dashboard-grid > .main-feed {
      height: 100%;
      overflow-y: auto;
      overscroll-behavior: contain;
      min-width: 0;
      padding: 12px 12px 28px;
    }
    /* right panel: natural height, no scroll — fits in viewport */
    .dashboard-grid > .right-panel-sticky {
      height: 100%;
      overflow: hidden;
      border-left: 1px solid var(--border);
      background: var(--bg);
    }
    .right-panel-inner {
      padding: 12px 10px;
      height: 100%;
    }

    /* ── Feed panel ── */
    .feed-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      display: flex; flex-direction: column;
      position: relative;
    }
    /* Refresh indicator — thin top bar that fills across the panel.
       Uses a scaling transform (not background-position) so it animates smoothly
       and completes visibly even when fetchData resolves in <200ms.
       The MIN_PULSE_MS timer in App keeps the class on for at least 650ms. */
    .feed-panel.is-refreshing::before {
      content: '';
      position: absolute; top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg,
        rgba(var(--accent-rgb), 0) 0%,
        rgba(var(--accent-rgb), .85) 50%,
        rgba(var(--accent-rgb), .25) 100%);
      transform-origin: left center;
      animation: feedProgress 650ms cubic-bezier(.4, 0, .2, 1) forwards;
      z-index: 3; pointer-events: none;
      box-shadow: 0 0 8px rgba(var(--accent-rgb), .35);
    }
    @keyframes feedProgress {
      0%   { transform: scaleX(0);   opacity: 1; }
      70%  { transform: scaleX(.9);  opacity: 1; }
      100% { transform: scaleX(1);   opacity: 0; }
    }
    /* Very subtle list opacity dip — avoid flashing the whole feed */
    .feed-list.is-refreshing { opacity: .94; transition: opacity .25s ease; }
    @media (prefers-reduced-motion: reduce) {
      .feed-panel.is-refreshing::before { animation: none; transform: scaleX(1); opacity: .5; }
      .feed-list.is-refreshing { opacity: 1; }
    }
    .feed-panel-head {
      padding: 12px 14px 10px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(var(--accent-rgb), .03), transparent);
    }
    .feed-panel-top {
      display: flex; align-items: center; gap: 12px; margin-bottom: 0;
    }
    /* Title column — title + sub-line stack tightly. */
    .feed-panel-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    /* Square refresh button — visual symmetry with the search input height. */
    .feed-refresh-btn {
      width: 32px; height: 32px;
      padding: 0 !important;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px; line-height: 1;
    }
    .feed-panel-title {
      font-size: 14.5px; font-weight: 800; color: var(--text);
      letter-spacing: -.2px; display: flex; align-items: center; gap: 8px;
    }
    .feed-panel-count {
      font-family: 'JetBrains Mono', monospace; font-size: 10px;
      color: var(--accent2); background: var(--accent-glow);
      border: 1px solid rgba(var(--accent-rgb), .22); border-radius: 5px;
      padding: 2px 7px; font-weight: 700;
    }
    .feed-panel-sub {
      font-size: 10.5px; color: var(--dim); margin-top: 3px;
      font-weight: 500; letter-spacing: .1px;
    }
    .feed-panel-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
    .feed-search {
      flex: 1; max-width: 280px;
      position: relative;
    }
    .feed-search input {
      width: 100%; padding: 7px 10px 7px 30px;
      background: rgba(255,255,255,.025); border: 1px solid var(--border);
      border-radius: 8px; color: var(--text); font-size: 12px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      transition: all .15s;
    }
    .feed-search input::placeholder { color: var(--dim); }
    .feed-search input:hover { border-color: var(--border2); }
    .feed-search input:focus {
      outline: none; border-color: rgba(var(--accent-rgb), .3);
      background: var(--accent-glow);
      box-shadow: 0 0 0 1px rgba(var(--accent-rgb), .2);
    }
    .feed-search-icon {
      position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      font-size: 11px; color: var(--dim); pointer-events: none;
    }

    /* ── Feed filter chips (canonical: matches seg-btn style) ── */
    .feed-filters-bar {
      display: flex; gap: 5px; flex-wrap: wrap; align-items: center;
      background: rgba(255,255,255,.02); border: 1px solid var(--border);
      border-radius: 9px; padding: 3px;
    }
    .feed-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 6px;
      background: transparent; border: none;
      color: var(--muted); font-size: 11px; font-weight: 600;
      cursor: pointer; transition: all .15s;
      font-family: inherit;
    }
    .feed-chip:hover { color: var(--text2); background: rgba(255,255,255,.03); }
    .feed-chip.active {
      background: var(--accent-glow);
      color: var(--accent2);
      box-shadow: 0 0 0 1px rgba(var(--accent-rgb), .2);
    }
    .feed-chip .chip-count {
      font-family: 'JetBrains Mono', monospace; font-size: 9.5px;
      color: var(--dim); margin-left: 2px; font-weight: 700;
    }
    .feed-chip.active .chip-count { color: var(--accent2); opacity: .9; }

    /* ── Feedback bar (like / dislike) — same language as seg-group ── */
    .fb-bar {
      display: inline-flex; gap: 3px;
      background: rgba(255,255,255,.025); border: 1px solid var(--border);
      border-radius: 8px; padding: 2px;
      align-items: center;
    }
    .fb-btn {
      display: inline-flex; align-items: center; gap: 5px;
      background: transparent; border: none; cursor: pointer;
      padding: 4px 9px; border-radius: 6px;
      font-family: inherit; font-size: 11px; font-weight: 700;
      color: var(--muted); transition: all .15s;
      line-height: 1;
    }
    .fb-btn .fb-ico {
      font-size: 12px; filter: saturate(.75) brightness(.95);
      transition: filter .15s, transform .15s;
    }
    .fb-btn .fb-count {
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px;
      font-weight: 700; min-width: 10px; text-align: center;
    }
    .fb-btn:hover:not(:disabled) {
      background: rgba(255,255,255,.04); color: var(--text2);
    }
    .fb-btn:hover:not(:disabled) .fb-ico { filter: saturate(1) brightness(1); transform: scale(1.08); }
    .fb-btn:active:not(:disabled) { transform: translateY(1px); }
    .fb-btn:disabled { opacity: .6; cursor: wait; }

    .fb-like.active {
      background: rgba(var(--green-rgb), .12);
      color: var(--green2);
      box-shadow: 0 0 0 1px rgba(var(--green-rgb), .25);
    }
    .fb-like.active .fb-ico { filter: saturate(1.1) brightness(1.05); }

    .fb-dislike.active {
      background: rgba(var(--red-rgb), .1);
      color: var(--red2);
      box-shadow: 0 0 0 1px rgba(var(--red-rgb), .22);
    }
    .fb-dislike.active .fb-ico { filter: saturate(1.1) brightness(1.05); }

    /* Modal variant — larger, full-width */
    .fb-bar-modal {
      display: flex; gap: 4px; padding: 3px;
      border-radius: 9px;
    }
    .fb-bar-modal .fb-btn {
      flex: 1; padding: 7px 12px; font-size: 12px; gap: 7px;
      justify-content: center;
    }
    .fb-bar-modal .fb-btn .fb-ico { font-size: 14px; }
    .fb-bar-modal .fb-btn .fb-count { font-size: 12px; }

    /* ── Inline "why this rating?" editor (modal variant only) ── */
    /* Sits directly under the like/dislike buttons. Appears only when the
       user has an active vote — gives them a place to explain WHY they
       voted, which the scorer surfaces as Liked/Disliked examples to AI. */
    .fb-reason {
      margin-top: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    .fb-reason-label {
      font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
      text-transform: uppercase; color: var(--muted);
      display: flex; align-items: center; gap: 5px;
    }
    .fb-reason-textarea {
      width: 100%; min-height: 56px; max-height: 140px;
      padding: 8px 10px; box-sizing: border-box;
      background: rgba(255,255,255,.025); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px;
      font-family: inherit; font-size: 12.5px; line-height: 1.4;
      resize: vertical; outline: none;
      transition: border-color .15s, background .15s;
    }
    .fb-reason-textarea:focus {
      border-color: rgba(var(--accent-rgb), .45);
      background: rgba(255,255,255,.04);
    }
    .fb-reason-textarea::placeholder { color: var(--dim); }
    .fb-reason-foot {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; font-size: 10.5px;
    }
    .fb-reason-count { color: var(--dim); font-family: 'JetBrains Mono', monospace; }
    .fb-reason-count.over { color: var(--red2); }
    .fb-reason-actions { display: flex; gap: 6px; }
    .fb-reason-btn {
      padding: 5px 11px; border-radius: 6px;
      font-family: inherit; font-size: 11px; font-weight: 600;
      cursor: pointer; transition: all .15s;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.02); color: var(--muted);
    }
    .fb-reason-btn:hover:not(:disabled) {
      color: var(--text); background: rgba(255,255,255,.05);
    }
    .fb-reason-btn:disabled { opacity: .45; cursor: not-allowed; }
    .fb-reason-btn.primary {
      border-color: rgba(var(--accent-rgb), .35);
      color: var(--accent2);
      background: var(--accent-glow);
    }
    .fb-reason-btn.primary:hover:not(:disabled) {
      background: rgba(var(--accent-rgb), .18);
      box-shadow: 0 0 0 1px rgba(var(--accent-rgb), .35);
    }
    .fb-reason-status {
      font-size: 10.5px; color: var(--accent2); opacity: .9;
    }
    .fb-reason-status.error { color: var(--red2); }

    /* ── Feed list / cards ── */
    .feed-list {
      display: flex; flex-direction: column; gap: 8px;
      padding: 10px;
    }
    .feed-card {
      /* 2026-05-01: was using --card2/--card (#1c-#16) which read as bright
         gray on the new ink theme. Switched to --surface so cards match
         the sidebar/feed-panel backdrop — only the border distinguishes
         them. The gloss-top inset keeps a subtle "glassy" highlight. */
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 11px 13px 9px;
      transition: border-color .15s, background .15s, transform .15s, box-shadow .15s;
      cursor: pointer;
      position: relative;
      box-shadow: var(--gloss-top);
    }
    .feed-card:hover {
      border-color: var(--border3);
      /* Hover = soft white-alpha overlay (same trick X uses) — gives a lift
         without shifting hue. */
      background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.015));
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(0,0,0,.35), var(--gloss-top);
    }
    .feed-card-head {
      display: flex; align-items: flex-start; gap: 10px; margin-bottom: 6px;
    }
    .feed-avatar {
      width: 38px; height: 38px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; flex-shrink: 0; font-weight: 800;
      border: 1px solid var(--border2);
    }
    .feed-avatar.reddit  { background: linear-gradient(135deg, #ff6a33, #ff4500); color: white; }
    .feed-avatar.twitter { background: linear-gradient(135deg, #1a1a1a, #000); color: white; }
    .feed-avatar.tiktok  { background: linear-gradient(135deg, #25f4ee, #fe2c55); color: white; }
    .feed-avatar.google_trends { background: linear-gradient(135deg, #4285f4, #34a853); color: white; }
    .feed-avatar.x_trends { background: linear-gradient(135deg, #1d9bf0, #0a0a0a); color: white; }
    .feed-avatar.default { background: var(--card3); color: var(--muted); }

    .feed-meta { flex: 1; min-width: 0; }
    .feed-user-row {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; line-height: 1.2; margin-bottom: 2px;
      flex-wrap: wrap;
    }
    .feed-user { font-weight: 700; color: var(--text); }
    .feed-handle { color: var(--dim); font-size: 11px; }
    .feed-dot { width: 2px; height: 2px; background: var(--dim); border-radius: 50%; flex-shrink: 0; }
    .feed-time { color: var(--dim); font-size: 11px; font-family: 'JetBrains Mono', monospace; }
    /* Inline meta (platforms / velocity) — sits between time and badges so
       it reads as part of the factual line, not as an action. Subtle, tab-
       ular. */
    .feed-meta-hint {
      color: var(--dim); font-size: 10.5px;
      font-family: 'JetBrains Mono', monospace;
      padding: 1px 6px; border-radius: 4px;
      background: rgba(255,255,255,.025);
      border: 1px solid var(--border);
    }
    /* margin-right reserves space for the absolute-positioned .feed-hide-btn
       in the card's top-right so badges don't slide under it on hover. */
    .feed-badges { display: flex; gap: 5px; margin-left: auto; margin-right: 28px; align-items: center; flex-wrap: wrap; }
    /* Normalise badge sizing — manual / alert-type / phase / category all
       use the same padding + font-size so the row reads as a coherent
       chip-set instead of a mixed bag. */
    .feed-badges .badge {
      font-size: 10px;
      padding: 2px 7px;
      line-height: 1.3;
      letter-spacing: .2px;
    }
    /* Fresh indicator — soft green pulse dot on trends < 60min old. */
    .badge-fresh {
      background: rgba(46,213,115,.12);
      color: #2ed573;
      border: 1px solid rgba(46,213,115,.3);
      font-weight: 700;
      animation: freshPulse 2.4s ease-in-out infinite;
    }
    @keyframes freshPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(46,213,115,.3); }
      50%      { box-shadow: 0 0 0 4px rgba(46,213,115,0); }
    }
    .feed-card.is-fresh { border-left: 2px solid rgba(46,213,115,.35); }

    /* Hide button — top-right, hover-only. Per-user dismiss; result lands in
       hidden_trends and is filtered server-side from feed. Square shape +
       border-radius 5 mirrors the .badge style next to it (PHASE / FORMING
       / category chips), so it reads as part of the chip-row rather than a
       circular floating action. */
    .feed-hide-btn {
      position: absolute; top: 9px; right: 9px;
      width: 22px; height: 22px; border-radius: 5px;
      background: rgba(0,0,0,.5);
      border: 1px solid var(--border2);
      color: var(--muted);
      font-size: 11px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      opacity: 0;
      transition: opacity .12s, background .12s, color .12s, border-color .12s;
      z-index: 2;
    }
    .feed-card:hover .feed-hide-btn { opacity: 1; }
    .feed-hide-btn:hover {
      background: rgba(255,255,255,.06);
      color: var(--text);
      border-color: var(--border3);
    }
    /* Touch devices have no hover — show the button always but at lower
       contrast so it's discoverable without dominating the card. */
    @media (hover: none) {
      .feed-hide-btn { opacity: .6; }
    }

    /* ── Favorite (⭐) button — sits inline at the start of .feed-user-row
       (left side, right after the avatar). Compact pill that matches the
       row's font size; hidden until card hover unless the trend is saved.
       Pro/Admin only — for free/test the button is omitted entirely. */
    .feed-fav-btn {
      width: 18px; height: 18px; border-radius: 4px;
      background: transparent;
      border: 1px solid var(--border2);
      color: var(--muted);
      font-size: 11px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      margin-right: 4px;
      opacity: 0;
      transition: opacity .12s, background .12s, color .12s, border-color .12s, transform .15s;
    }
    .feed-card:hover .feed-fav-btn { opacity: 1; }
    .feed-fav-btn.saved {
      opacity: 1;                    /* always-visible when saved */
      background: rgba(var(--accent-rgb), .18);
      border-color: rgba(var(--accent-rgb), .45);
      color: var(--accent);
    }
    .feed-fav-btn:hover {
      background: rgba(255,255,255,.06);
      color: var(--text);
      border-color: var(--border3);
    }
    .feed-fav-btn.just-saved { animation: favPulse .4s cubic-bezier(.21,.62,.32,1.06); }
    @keyframes favPulse {
      0%   { transform: scale(1); }
      40%  { transform: scale(1.35); }
      100% { transform: scale(1); }
    }
    @media (hover: none) {
      .feed-fav-btn { opacity: .6; }
      .feed-fav-btn.saved { opacity: 1; }
    }

    /* Modal star button — same styling, but inline in the modal head row */
    .modal-fav-btn {
      width: 26px; height: 26px; border-radius: 6px;
      background: rgba(0,0,0,.4);
      border: 1px solid var(--border2);
      color: var(--text2);
      font-size: 13px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer;
      transition: background .12s, color .12s, border-color .12s, transform .15s;
    }
    .modal-fav-btn.saved {
      background: rgba(var(--accent-rgb), .18);
      border-color: rgba(var(--accent-rgb), .45);
      color: var(--accent2);
    }
    .modal-fav-btn:hover {
      background: rgba(var(--accent-rgb), .22);
      color: var(--accent2);
      border-color: rgba(var(--accent-rgb), .50);
    }
    .modal-fav-btn.just-saved { animation: favPulse .4s cubic-bezier(.21,.62,.32,1.06); }

    /* Favorite note editor — collapsible block in the modal under the header */
    .fav-note-block {
      margin: 10px 0 0;
      padding: 10px 12px;
      background: rgba(var(--accent-rgb), .04);
      border: 1px solid rgba(var(--accent-rgb), .14);
      border-radius: 8px;
      font-size: 12.5px; color: var(--text2);
    }
    .fav-note-row { display: flex; align-items: flex-start; gap: 8px; }
    .fav-note-text { flex: 1; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .fav-note-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .fav-note-act {
      background: transparent; border: none; cursor: pointer;
      color: var(--muted); font-size: 11px; padding: 2px 6px; border-radius: 4px;
      transition: background .12s, color .12s;
    }
    .fav-note-act:hover { background: rgba(255,255,255,.06); color: var(--text); }
    .fav-note-textarea {
      width: 100%; min-height: 60px; max-height: 160px;
      padding: 8px 10px;
      background: rgba(0,0,0,.3); color: var(--text);
      border: 1px solid var(--border2); border-radius: 6px;
      font-size: 12.5px; line-height: 1.45;
      font-family: inherit; resize: vertical;
      box-sizing: border-box; outline: none;
    }
    .fav-note-textarea:focus { border-color: rgba(var(--accent-rgb), .45); }
    .fav-note-controls { display: flex; gap: 6px; margin-top: 6px; }
    .fav-note-controls .btn { padding: 4px 10px; font-size: 11px; }
    .fav-note-saved-at { font-size: 10px; color: var(--dim); margin-top: 4px; }
    .fav-snapshot-banner {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; margin-bottom: 8px;
      font-size: 10.5px; color: var(--muted);
      background: rgba(255,255,255,.03);
      border: 1px solid var(--border); border-radius: 999px;
    }

    /* Undo toast — fixed bottom-center, single instance. Separate from the
       top-right .toast notification system (different purpose: actionable
       undo vs informational). 2026-05-02: bottom: 24 (was 64) since the
       statusbar strip is gone. Bottom-nav on mobile sits above this. */
    /* Scroll-to-top — floating circular button centered over the .main-feed
       column (not the viewport — sidebars shift the visual middle).
       Inline left value is set from JS (feedCenterX) and translateX(-50%)
       here finishes the centering. Visible only when feed scrolled past
       threshold. Hover/active transforms preserve translateX(-50%) so the
       button doesn't jump horizontally on interaction. */
    .scroll-to-top {
      position: fixed;
      top: 60px;
      transform: translateX(-50%);
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--surface);
      border: 1px solid var(--border3);
      color: var(--text);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px;
      line-height: 1;
      padding: 0;
      box-shadow: 0 4px 12px rgba(0,0,0,.45), var(--gloss-top);
      z-index: 900;
      animation: scroll-to-top-in .18s ease-out;
      transition: transform .12s ease, background .12s ease, border-color .12s ease;
    }
    .scroll-to-top:hover {
      background: var(--surface-hover, var(--surface));
      border-color: rgba(var(--accent-rgb), .5);
      transform: translate(-50%, -2px);
    }
    .scroll-to-top:active { transform: translate(-50%, 0); }
    @keyframes scroll-to-top-in {
      from { opacity: 0; transform: translate(-50%, -8px); }
      to   { opacity: 1; transform: translate(-50%, 0); }
    }

    .undo-toast {
      position: fixed;
      bottom: 24px; left: 50%; transform: translateX(-50%);
      background: var(--surface);
      border: 1px solid var(--border3);
      padding: 10px 14px;
      border-radius: 10px;
      display: flex; align-items: center; gap: 12px;
      box-shadow: 0 6px 20px rgba(0,0,0,.5), var(--gloss-top);
      z-index: 1000;
      font-size: 13px;
      animation: undo-toast-slide-up .18s ease-out;
      max-width: calc(100vw - 32px);
    }
    @keyframes undo-toast-slide-up {
      from { transform: translate(-50%, 12px); opacity: 0; }
      to   { transform: translateX(-50%); opacity: 1; }
    }
    .undo-toast-text { color: var(--text); }
    .undo-toast-btn {
      background: transparent;
      color: var(--accent);
      border: none;
      font-weight: 700;
      cursor: pointer;
      font-size: 13px;
      padding: 4px 6px;
      letter-spacing: .2px;
    }
    .undo-toast-btn:hover { text-decoration: underline; }

    /* Archive card — collapsible. Closed by default so a long retention list
       doesn't blow up the Settings sheet height. The .archive-head button
       replaces the usual .settings-card-title in this card. */
    .archive-card .archive-card-desc { margin-bottom: 0; }
    .archive-head {
      display: flex; align-items: center; gap: 8px;
      width: 100%;
      background: transparent;
      border: none;
      padding: 0;
      cursor: pointer;
      color: var(--text);
      font-size: 13px; font-weight: 700;
      text-align: left;
    }
    .archive-head-caret {
      display: inline-flex; align-items: center; justify-content: center;
      width: 14px; height: 14px;
      font-size: 10px; color: var(--text3);
      transition: transform .15s;
    }
    .archive-card.open .archive-head-caret { transform: rotate(90deg); color: var(--accent); }
    .archive-head-title { flex: 1; }
    .archive-head-count {
      font-size: 11px; color: var(--text3); font-weight: 500;
      font-family: 'JetBrains Mono', monospace;
    }
    .archive-body {
      margin-top: 10px;
      animation: archive-fade-in .14s ease-out;
    }
    @keyframes archive-fade-in {
      from { opacity: 0; transform: translateY(-3px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .archive-actions-top {
      margin-top: 0; margin-bottom: 10px;
      justify-content: flex-end;
    }

    /* Archive list (in Settings sheet) */
    .archive-list {
      display: flex; flex-direction: column; gap: 6px;
      max-height: 400px; overflow-y: auto;
      margin-top: 0;
    }
    .archive-row {
      display: grid;
      grid-template-columns: 28px 1fr auto auto;
      gap: 10px; align-items: center;
      padding: 8px 10px;
      border: 1px solid var(--border2);
      border-radius: 8px;
      background: rgba(255,255,255,.015);
      transition: border-color .12s, background .12s;
    }
    .archive-row:hover { border-color: var(--border3); background: rgba(255,255,255,.03); }
    .archive-row-icon {
      width: 28px; height: 28px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 13px;
      border: 1px solid var(--border2);
    }
    .archive-row-body { min-width: 0; }
    .archive-row-title {
      font-size: 13px; color: var(--text); font-weight: 600;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .archive-row-meta { font-size: 11px; color: var(--text3); margin-top: 2px; }
    .archive-row-btn {
      background: transparent;
      border: 1px solid var(--border2);
      color: var(--text2);
      border-radius: 6px;
      padding: 4px 9px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .archive-row-btn:hover { color: var(--accent); border-color: var(--accent); }
    .archive-empty {
      color: var(--text3); font-size: 13px;
      padding: 16px; text-align: center;
      border: 1px dashed var(--border2);
      border-radius: 8px;
    }
    .archive-actions {
      display: flex; gap: 8px; justify-content: flex-end;
      margin-top: 12px;
    }

    .feed-title {
      font-size: 14px; font-weight: 700; color: var(--text);
      line-height: 1.35; letter-spacing: -.1px; margin: 2px 0 4px;
      word-break: break-word;
    }
    .feed-orig {
      font-size: 11px; color: var(--dim); font-style: italic;
      margin-bottom: 6px; line-height: 1.4;
    }
    .feed-desc {
      font-size: 12px; color: var(--text2); line-height: 1.5;
      margin-bottom: 8px;
    }
    .feed-desc.pump {
      background: linear-gradient(90deg, rgba(var(--orange-rgb), .06), transparent);
      border-left: 2px solid var(--orange);
      padding: 6px 10px; border-radius: 4px;
      color: var(--orange); font-weight: 500;
    }

    /* Feed image — Twitter/Mario Nawfal style: bounded, fully visible (contain),
       with a subtle dark backdrop filling the letterbox area. Never stretched. */
    .feed-image-wrap {
      position: relative;
      border-radius: 14px; overflow: hidden;
      margin: 8px 0 10px;
      background: #0a0a12;
      border: 1px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      /* Cap height so portraits don't eat the whole feed */
      max-height: 380px;
    }
    .feed-image {
      display: block;
      width: 100%;
      height: auto;
      max-height: 380px;
      object-fit: contain;   /* show the whole picture, no cropping/stretching */
    }
    /* Compact density — tighter frame */
    body.prefs-compact .feed-image-wrap,
    body.prefs-compact .feed-image { max-height: 280px; }
    /* Inline video player — matches .feed-image geometry */
    .feed-video-wrap { background: #000; }
    .feed-video {
      width: 100%;
      height: auto;
      max-height: 380px;
      display: block;
      outline: none;
    }
    body.prefs-compact .feed-video { max-height: 280px; }
    .feed-image-placeholder {
      height: 140px; width: 100%;
      display: flex; align-items: center; justify-content: center;
      font-size: 36px; opacity: .35;
      background: linear-gradient(135deg, var(--card2), var(--card3));
    }

    /* Multi-image gallery (2+ photos) — horizontal carousel with arrows.
       Container has a FIXED height (not max-height) so switching between
       portrait / landscape / short-landscape images doesn't collapse the
       frame. The <img> inside uses object-fit: contain — letterboxing
       appears for narrower images, but the card layout stays stable.

       (2026-05-04) Two prior fixes failed and the bug kept coming back:
         1) flex+img-as-flex-item with align-items/justify-content centering
            — the img's intrinsic dimensions leaked through width/height:100%
            on Chromium when a low-res thumbnail loaded first, rendering a
            tiny image inside the full-size container.
         2) position:absolute on img — fixed (1) but pulled the img out of
            normal flow. The carousel had no intrinsic content height, so
            the flex column parent (.modal-body) shrank it to ~0 via the
            default flex-shrink:1 + min-height:auto behavior, despite the
            explicit height: 380px on the wrapper.
       The reliable shape: NO flex on the wrapper (block layout) + img kept
       in normal flow with explicit width:100%/height:100%. The img's flow
       size anchors the carousel against flex-shrink, AND it fills the
       wrapper exactly — no flex-item sizing surprises. Don't reintroduce
       display:flex here. */
    .img-carousel {
      position: relative; width: 100%;
      border-radius: 14px; overflow: hidden;
      margin: 8px 0 10px;
      background: #0a0a12;
      border: 1px solid var(--border);
      height: 380px;
      /* Belt-and-suspenders: even if some future ancestor turns into a
         shrinking flex container, refuse to collapse below the explicit
         height. Costs nothing when the wrapper is in a block parent. */
      flex-shrink: 0;
    }
    .img-carousel img {
      display: block;
      width: 100%; height: 100%;
      object-fit: contain;
      /* Default = pointer (carousel inside feed card — click opens modal,
         not a zoomed lightbox, so the magnifier cursor was misleading). */
      cursor: pointer;
    }
    /* Lightbox-aware cursor only inside the modal carousel, where image click
       actually opens a fullscreen zoomed view via setLightboxSrc. */
    .img-carousel.in-modal img { cursor: zoom-in; }
    body.prefs-compact .img-carousel { height: 280px; }
    /* in-modal MUST beat body.prefs-compact (which has higher specificity)
       — without the body-prefix the prefs-compact rule wins and the modal
       carousel collapses to 280px even on desktop. */
    .img-carousel.in-modal,
    body.prefs-compact .img-carousel.in-modal { height: 260px; border-radius: 8px; }
    .img-carousel-nav {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 38px; height: 38px; border-radius: 50%;
      background: rgba(0,0,0,.55);
      border: 1px solid rgba(255,255,255,.18);
      color: #fff; font-size: 22px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; z-index: 2;
      transition: all .15s;
      padding: 0;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .img-carousel-nav:hover {
      background: rgba(0,0,0,.8);
      border-color: rgba(255,255,255,.35);
      transform: translateY(-50%) scale(1.08);
    }
    .img-carousel-nav:active { transform: translateY(-50%) scale(.95); }
    .img-carousel-nav-prev { left: 10px; }
    .img-carousel-nav-next { right: 10px; }
    .img-carousel-counter {
      position: absolute; top: 10px; right: 10px;
      background: rgba(0,0,0,.6);
      color: #fff; font-size: 11px; font-weight: 700;
      padding: 4px 10px; border-radius: 12px;
      z-index: 2;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: .3px;
    }
    .img-carousel-dots {
      position: absolute; bottom: 10px; left: 50%;
      transform: translateX(-50%);
      display: flex; gap: 5px; z-index: 2;
    }
    .img-carousel-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: rgba(255,255,255,.35);
      transition: all .15s;
    }
    .img-carousel-dot.active {
      background: #fff;
      width: 18px; border-radius: 3px;
    }

    /* ── Feed score strip ──
       Three-column grid: Emergence / Meme Score / Adoption. Each column is
       narrow (~135px on a typical card width) so the labels render in two
       lines on the smallest cards — that's fine, score numbers stay aligned
       on the right. Larger gap + per-column inner padding + thin vertical
       dividers between columns so the three metrics read as distinct cells
       instead of running together. The dividers use ::after pseudos on
       columns 1 and 2 so they only appear between cells, not on the right
       edge of the strip. */
    .feed-scores {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0;
      padding: 8px 6px; margin: 6px 0 10px;
      background: rgba(0,0,0,.18); border-radius: 8px;
      border: 1px solid var(--border);
    }
    .feed-score {
      display: flex; flex-direction: column; gap: 4px; min-width: 0;
      padding: 0 10px;
      position: relative;
    }
    .feed-score + .feed-score::before {
      content: ''; position: absolute;
      left: 0; top: 4px; bottom: 4px;
      width: 1px;
      background: linear-gradient(to bottom,
        rgba(255,255,255,0) 0%,
        rgba(255,255,255,.12) 30%,
        rgba(255,255,255,.12) 70%,
        rgba(255,255,255,0) 100%);
    }
    .feed-score-top {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .6px;
    }
    .feed-score-label { color: var(--muted); display: flex; align-items: center; gap: 4px; }
    .feed-score-num { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 800; }
    .feed-score-track {
      height: 4px; background: rgba(255,255,255,.05); border-radius: 2px; overflow: hidden;
    }
    .feed-score-fill { height: 100%; border-radius: 2px; transition: width .4s ease; }

    /* ── Feed actions ── */
    .feed-actions {
      display: flex; gap: 6px; flex-wrap: wrap; padding-top: 2px;
    }
    .feed-action-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 7px;
      background: rgba(255,255,255,.03); border: 1px solid var(--border2);
      color: var(--muted); font-size: 11px; font-weight: 600;
      cursor: pointer; text-decoration: none;
      transition: all .12s; font-family: inherit;
    }
    .feed-action-btn:hover {
      background: rgba(255,255,255,.06); color: var(--text);
      border-color: var(--border3); transform: translateY(-1px);
    }
    .feed-action-btn.primary {
      background: linear-gradient(135deg, rgba(var(--accent-rgb), .15), rgba(var(--accent-rgb), .05));
      border-color: rgba(var(--accent-rgb), .3); color: var(--accent2);
    }
    .feed-action-btn.primary:hover {
      background: linear-gradient(135deg, rgba(var(--accent-rgb), .25), rgba(var(--accent-rgb), .1));
      border-color: var(--accent);
    }
    .feed-action-btn.tg { color: #3b9dff; border-color: rgba(59,157,255,.25); }
    .feed-action-btn.tg:hover { background: rgba(59,157,255,.1); border-color: rgba(59,157,255,.5); }
    .feed-action-btn.details-hint { margin-left: auto; color: var(--dim); font-family: 'JetBrains Mono', monospace; }

    .empty-feed {
      padding: 60px 20px; text-align: center;
      color: var(--dim);
    }
    .empty-feed-icon { font-size: 44px; opacity: .3; margin-bottom: 12px; }
    .empty-feed-text { font-size: 13px; }
    .empty-feed-sub { font-size: 11px; margin-top: 4px; opacity: .7; }

    /* ── Right panel ── */
    .right-panel {
      display: flex; flex-direction: column;
    }
    .right-sep {
      height: 1px;
      background: rgba(255,255,255,.07);
      margin: 14px 4px;
    }
    .right-section {
      /* 2026-05-01: was --card (#16181c) — too bright vs the rest of the
         monochrome layout. --surface matches feed-panel + sidebar tone. */
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }
    .right-section-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px 9px;
      border-bottom: 1px solid var(--border);
    }
    .right-section-title {
      font-size: 10px; font-weight: 700; color: var(--accent);
      letter-spacing: 1.3px; text-transform: uppercase;
      display: flex; align-items: center; gap: 6px;
    }
    .right-section-count {
      margin-left: auto;
      font-family: 'JetBrains Mono', monospace; font-size: 9.5px;
      color: var(--muted); background: rgba(255,255,255,.03);
      border: 1px solid var(--border); border-radius: 5px;
      padding: 2px 7px; font-weight: 700; letter-spacing: 0;
      text-transform: none;
    }
    .right-section-body { padding: 6px 8px 10px; display: flex; flex-direction: column; gap: 2px; }

    /* ── Top item (Top Narratives) ── */
    .top-item {
      display: flex; align-items: center; gap: 9px;
      padding: 7px 8px;
      border-radius: 8px;
      cursor: pointer;
      transition: all .15s;
      border: 1px solid transparent;
    }
    .top-item:hover {
      background: rgba(255,255,255,.03);
      border-color: var(--border);
      transform: translateX(1px);
    }
    .top-item-rank {
      width: 22px; height: 22px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 800;
      background: rgba(255,255,255,.04); color: var(--muted);
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    .top-item-rank.top-1 { background: linear-gradient(135deg, #ffd93d, #f59e0b); color: #1a1200; border-color: rgba(245,158,11,.4); }
    .top-item-rank.top-2 { background: linear-gradient(135deg, #cbd5e1, #94a3b8); color: #1a1a2a; border-color: rgba(148,163,184,.4); }
    .top-item-rank.top-3 { background: linear-gradient(135deg, #d97706, #92400e); color: #fff; border-color: rgba(217,119,6,.4); }
    .top-item-info { flex: 1; min-width: 0; }
    .top-item-title {
      font-size: 12px; font-weight: 600; color: var(--text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      line-height: 1.3; letter-spacing: -.1px;
    }
    .top-item-meta {
      display: flex; align-items: center; gap: 5px;
      font-size: 10px; color: var(--dim); margin-top: 3px;
      font-family: 'JetBrains Mono', monospace;
    }
    .top-item-score {
      font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700;
      color: var(--accent2); flex-shrink: 0;
      padding: 2px 7px; background: var(--accent-glow);
      border-radius: 5px; border: 1px solid rgba(var(--accent-rgb), .22);
      min-width: 28px; text-align: center;
    }

    /* ── Pulse rows (Source Pulse) — mirrors .source-item ── */
    .pulse-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 9px;
      border-radius: 8px;
      cursor: pointer;
      transition: all .15s;
      border: 1px solid transparent;
    }
    .pulse-row:hover {
      background: rgba(255,255,255,.03);
      border-color: var(--border);
      transform: translateX(1px);
    }
    .pulse-row.off { opacity: .5; }
    .pulse-row.off .pulse-icon { filter: grayscale(1); }
    .pulse-row.off .pulse-count { opacity: .5; }
    .pulse-icon {
      width: 26px; height: 26px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 13.5px; font-weight: 800; flex-shrink: 0;
      font-family: 'Inter', sans-serif; line-height: 1;
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.05);
      color: var(--text2);
      transition: all .18s;
      box-shadow: var(--gloss-top);
    }
    .pulse-row[data-src="reddit"] .pulse-icon        { background: rgba(255,88,0,.14);   border-color: rgba(255,88,0,.36);   color: #ff5800; }
    .pulse-row[data-src="google_trends"] .pulse-icon { background: rgba(66,133,244,.14); border-color: rgba(66,133,244,.40); color: #4285f4; }
    .pulse-row[data-src="twitter"] .pulse-icon       { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.22); color: #ffffff; }
    .pulse-row[data-src="tiktok"] .pulse-icon        { background: rgba(255,0,80,.14);   border-color: rgba(255,0,80,.40);   color: #ff2469; font-size: 16px; }
    .pulse-row[data-src="x_trends"] .pulse-icon      { background: rgba(29,155,240,.14); border-color: rgba(29,155,240,.42); color: #1d9bf0; }
    .pulse-name {
      flex: 1; font-size: 12px; font-weight: 600; color: var(--text2);
      letter-spacing: -.1px;
    }
    .pulse-count {
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px; font-weight: 600;
      color: var(--text2); background: rgba(255,255,255,.04);
      padding: 2px 7px; border-radius: 5px; min-width: 26px; text-align: center;
      border: 1px solid var(--border);
    }
    .pulse-count.hot { color: var(--accent2); background: var(--accent-glow); border-color: rgba(var(--accent-rgb), .22); }

    /* ── Activity summary ── */
    .activity-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
      padding: 2px;
    }
    .activity-cell {
      background: rgba(255,255,255,.025);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 10px;
      display: flex; flex-direction: column; gap: 4px;
      transition: all .15s;
    }
    .activity-cell:hover { background: rgba(255,255,255,.04); border-color: var(--border2); }
    .activity-cell.full { grid-column: 1 / -1; }
    .activity-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px;
      color: var(--muted); font-weight: 700;
    }
    .activity-val {
      font-family: 'JetBrains Mono', monospace; font-size: 17px;
      font-weight: 800; color: var(--text); letter-spacing: -.5px;
    }
    .activity-val.accent { color: var(--accent2); }
    .activity-val.green  { color: var(--green2); }
    .activity-val.orange { color: var(--orange); }
    .activity-sub { font-size: 10px; color: var(--dim); font-weight: 500; }

    /* Live indicator dot in the Activity-section title (replaces the bottom
       statusbar's pulse). Green = scanning; red = paused. */
    .right-live-dot {
      display: inline-block;
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--green2);
      box-shadow: 0 0 6px var(--green), 0 0 0 2px rgba(34,197,94,.12);
      animation: pulse 2.5s ease-in-out infinite;
      margin-right: 8px;
      vertical-align: middle;
      transform: translateY(-1px);
    }
    .right-live-dot.paused {
      background: var(--red2);
      box-shadow: 0 0 5px var(--red);
      animation: none;
    }

    /* Sources sub-block inside the Activity section. Each source = a small
       pill with a status dot + emoji. Hover shows full source name. */
    .right-sources {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed var(--border2);
    }
    .right-sources-head {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 6px;
    }
    .right-sources-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px;
      color: var(--muted); font-weight: 700;
    }
    .right-sources-count {
      font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700;
    }
    .right-sources-list {
      display: flex; flex-wrap: wrap; gap: 5px;
    }
    .right-sources-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 7px;
      background: rgba(255,255,255,.025);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 11px;
      transition: opacity .15s, border-color .15s, background .15s;
    }
    .right-sources-pill.off { opacity: .4; }
    /* Locked = source not in user's plan. Slightly more visible than .off so
       the user perceives "available, just gated" rather than "broken". */
    .right-sources-pill.locked {
      opacity: .5;
      background: rgba(239,243,244,0.02);
      border-style: dashed;
      cursor: help;
    }
    .right-sources-pill.locked .right-sources-dot { background: var(--muted); }
    .right-sources-pill.locked .right-sources-glyph { color: var(--muted); font-size: 9px; }
    .right-sources-pill.on:hover { border-color: var(--border2); background: rgba(255,255,255,.05); }
    .right-sources-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--green2); flex-shrink: 0;
    }
    .right-sources-pill.off .right-sources-dot { background: var(--red2); }
    /* Glyph (R / G / X / ♪ / #) — brand-tinted letter-marks. Matches the
       sidebar source-icon palette so the right panel reads consistently. */
    .right-sources-glyph {
      font-weight: 800; font-size: 11px;
      color: var(--text2); letter-spacing: 0;
      line-height: 1;
    }
    .right-sources-pill[title^="Reddit"] .right-sources-glyph,
    .right-sources-pill[title^="reddit"] .right-sources-glyph { color: #ff5800; }
    .right-sources-pill[title^="Twitter"] .right-sources-glyph,
    .right-sources-pill[title^="twitter"] .right-sources-glyph { color: var(--text); }
    .right-sources-pill[title^="TikTok"] .right-sources-glyph,
    .right-sources-pill[title^="tiktok"] .right-sources-glyph { color: #ff2469; }
    .right-sources-pill[title^="Google"] .right-sources-glyph,
    .right-sources-pill[title^="google"] .right-sources-glyph { color: #4285f4; }
    .right-sources-pill[title^="X Trends"] .right-sources-glyph { color: #1d9bf0; }
    .right-sources-pill.off .right-sources-glyph { color: var(--dim); }

    /* ── Category mini-legend in right panel ── */
    .cat-row {
      display: flex; align-items: center; gap: 7px;
      padding: 4px 6px; border-radius: 6px;
      transition: all .12s;
    }
    .cat-row:hover { background: var(--card2); }
    .cat-bar-wrap {
      flex: 1; height: 4px; background: rgba(255,255,255,.05);
      border-radius: 2px; overflow: hidden;
    }
    .cat-bar { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 2px; }
    .cat-name { font-size: 11px; color: var(--text2); min-width: 74px; display: flex; gap: 5px; align-items: center; }
    .cat-count { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--dim); min-width: 20px; text-align: right; }

    /* ── Responsive grid collapses ── */
    @media (max-width: 1280px) {
      .dashboard-grid { grid-template-columns: var(--col-left) 6px 1fr; }
      .dashboard-grid > .right-panel,
      .dashboard-grid > .right-panel-sticky,
      .dashboard-grid > .col-resizer-right { display: none; }
    }
    @media (max-width: 960px) {
      .dashboard-grid { grid-template-columns: 1fr; padding: 10px; }
      .dashboard-grid > .sidebar,
      .dashboard-grid > .col-resizer { display: none; }
    }

    /* ── Responsive ── */
    @media (max-width: 1100px) { .card-meta { flex-wrap: wrap; } }
    @media (max-width: 900px) {
      .sidebar { display: none; }
      .stats-grid, .stats-top-grid { grid-template-columns: 1fr; }
      .stat-val { font-size: 20px; }
      .card-header { flex-direction: column; align-items: flex-start; gap: 6px; }
      .card-meta { width: 100%; }
      .card-stats { gap: 8px; }
      .card-footer { flex-wrap: wrap; }
      .trend-link { flex: 1; justify-content: center; min-width: 100px; }
      .modal-drawer { width: 100vw; }
    }
    @media (max-width: 600px) {
      .hero-main, .hero-side, .stats-block { padding: 12px; }
      .trends-list { padding: 6px; gap: 4px; }
      .card-header { padding: 9px 12px 7px; }
      .card-body { padding: 9px 12px; }
      .card-footer { padding: 7px 12px; }
      .card-stats { flex-direction: column; gap: 10px; }
      .meme-num { font-size: 15px; }
    }
  </style>
</head>
<body>
<div id="root"></div>
<script>
const { useState, useEffect, useCallback, useRef } = React;
const h = React.createElement;

// Server-injected — single source of truth lives in src/analysis/lifespan.js.
const LIFESPAN_VALUES = ${JSON.stringify(LIFESPAN_VALUES)};

// Cache-bust token for /assets/logo.png. Mtime of the file at server boot
// (or startup time as fallback). When the file changes (Docker rebuild
// resets the layer mtime), this number changes → <img src> changes →
// browser drops the cached version. Avoids the "I redeployed but the old
// logo is still showing" trap that long Cache-Control would otherwise
// cause.
const LOGO_VERSION = ${JSON.stringify(this._logoVersion)};
// Bot username injected at HTML render time. Empty string → fallback rendering
// in nav (t.me/ root). Used for the Telegram-bot nav link next to the X icon.
const BOT_USERNAME = ${JSON.stringify(this._botUsername || '')};

// ── Auth token ────────────────────────────────────────────────────────────
// Login is Telegram-bot-only. The bot issues a 6-digit code bound to a session;
// verifying the code returns a 64-hex bearer token that is attached to every
// /api/* request. On 401 we clear the token and show the login screen.
const AUTH_TOKEN_KEY = 'ts_auth_token';
let AUTH_TOKEN = '';
try { AUTH_TOKEN = localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (e) {}
const authListeners = new Set();
function setAuthToken(tok) {
  AUTH_TOKEN = tok || '';
  try {
    if (AUTH_TOKEN) localStorage.setItem(AUTH_TOKEN_KEY, AUTH_TOKEN);
    else            localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch (e) {}
  authListeners.forEach(fn => { try { fn(AUTH_TOKEN); } catch (e) {} });
}
function onAuthChange(fn) { authListeners.add(fn); return () => authListeners.delete(fn); }

// ── I18N ──────────────────────────────────────────────────────────────────
// Dashboard is bilingual. English is primary with a light degen / crypto-twitter
// flavor; Russian is a faithful second. Strings are resolved via t(key, args)
// where {token} placeholders are substituted from args.
const LANG_KEY = 'ts_lang';
const SUPPORTED_LANGS = ['en', 'ru'];
function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && SUPPORTED_LANGS.indexOf(saved) >= 0) return saved;
  } catch (e) {}
  return 'en';
}
let CURRENT_LANG = detectLang();
const langListeners = new Set();
function setLang(l) {
  if (SUPPORTED_LANGS.indexOf(l) < 0) return;
  CURRENT_LANG = l;
  try { localStorage.setItem(LANG_KEY, l); } catch (e) {}
  try { document.documentElement.setAttribute('lang', l); } catch (e) {}
  langListeners.forEach(fn => { try { fn(l); } catch (e) {} });
}
function onLangChange(fn) { langListeners.add(fn); return () => langListeners.delete(fn); }

// ── Grok prompt language ──────────────────────────────────────────────────
// Separate from UI lang so a user with an English UI can still ask Grok in
// Russian (and vice-versa). Saved value: 'en' | 'ru' | null. Null = follow
// UI lang (default behavior). Read via getGrokLang() in the Ask Grok prompt
// builder; written via setGrokLang() from SettingsView.
const GROK_LANG_KEY = 'ts_grok_lang';
function getGrokLang() {
  try {
    const saved = localStorage.getItem(GROK_LANG_KEY);
    if (saved && SUPPORTED_LANGS.indexOf(saved) >= 0) return saved;
  } catch (e) {}
  return CURRENT_LANG;
}
const grokLangListeners = new Set();
function setGrokLang(l) {
  if (SUPPORTED_LANGS.indexOf(l) < 0) return;
  try { localStorage.setItem(GROK_LANG_KEY, l); } catch (e) {}
  grokLangListeners.forEach(fn => { try { fn(l); } catch (e) {} });
}
function onGrokLangChange(fn) { grokLangListeners.add(fn); return () => grokLangListeners.delete(fn); }
try { document.documentElement.setAttribute('lang', CURRENT_LANG); } catch (e) {}

// ── THEME ────────────────────────────────────────────────────────────────
// 3 dark themes. Applied via <body data-theme="...">. "pulse" is the default
// (green primary) and uses no data-theme attribute (it's the :root block).
// "ink" is the legacy X-blue default (pre-2026-05-19 redesign); "tide" is a
// navy + cyan/aqua alternative.
//
// Old themes (dim/slate/mono — and even older midnight/teal/abyss/violet
// /acid/sunset/cyberpunk) were retired. Old saved values fall through
// detectTheme()'s validity check and reset to the new default — no
// migration needed.
const THEME_KEY = 'ts_theme';
const SUPPORTED_THEMES = ['pulse', 'ink', 'tide'];
const THEME_META = {
  pulse: { icon: '⚡', labelEn: 'Pulse', labelRu: 'Импульс' },
  ink:   { icon: '⬛', labelEn: 'Ink',   labelRu: 'Чернила' },
  tide:  { icon: '🌊', labelEn: 'Tide',  labelRu: 'Прилив' },
};
function detectTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && SUPPORTED_THEMES.indexOf(saved) >= 0) return saved;
  } catch (e) {}
  return 'pulse';
}
let CURRENT_THEME = detectTheme();
const themeListeners = new Set();
function applyThemeAttr(theme) {
  try {
    if (theme && theme !== 'pulse') document.body.setAttribute('data-theme', theme);
    else document.body.removeAttribute('data-theme');
  } catch (e) {}
}
function setTheme(theme) {
  if (SUPPORTED_THEMES.indexOf(theme) < 0) return;
  CURRENT_THEME = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  applyThemeAttr(theme);
  themeListeners.forEach(fn => { try { fn(theme); } catch (e) {} });
}
function onThemeChange(fn) { themeListeners.add(fn); return () => themeListeners.delete(fn); }
// Apply on load (body may not exist yet; retry on DOMContentLoaded)
try { applyThemeAttr(CURRENT_THEME); } catch (e) {}
try { document.addEventListener('DOMContentLoaded', () => applyThemeAttr(CURRENT_THEME)); } catch (e) {}

const I18N = {
  en: {
    // App
    'app.title': 'Catalyst',
    'app.subtitle': 'Narrative Terminal',
    'app.loading': 'Loading…',
    'app.please_wait': 'Hold up…',
    'app.back': '← Back',
    'app.reset': 'Reset',
    'app.cancel': '← Cancel',
    'app.esc_close': '✕ Esc',

    // Status bar
    'status.live': 'LIVE',
    'status.offline': 'OFFLINE',

    // Nav
    'nav.live': 'Live',
    'nav.offline': 'Offline',
    'nav.stats': 'Stats',
    'nav.settings': 'Settings',
    'nav.feed': 'Feed',
    'nav.account': 'Account',
    'nav.analyze': 'Analyze',
    'nav.saved': 'Saved',
    'analyze.title': 'Analyze a post',
    'analyze.intro': "Paste a link to any X / Reddit / TikTok post (or any page with a preview image). We compare it to today's trends and tell you if it has viral potential.",
    'analyze.url_label': 'Post link',
    'analyze.url_placeholder': 'https://x.com/user/status/...',
    'analyze.run_btn': 'Analyze',
    'analyze.running': 'Analyzing...',
    'analyze.subtitle': 'Usually takes 10-30 seconds',
    'analyze.locked': 'Manual analysis is a Test/Pro feature.',
    'analyze.locked_tooltip': 'Available on Test/Pro plan',
    'analyze.locked_toast': '🔒 Manual analysis is available on Test/Pro',
    'analyze.verdict_high':     '🔥 Strong viral potential',
    'analyze.verdict_mid':      '📈 Some traction',
    'analyze.verdict_low':      '💤 Unlikely to take off',
    'analyze.verdict_sub_high': 'This post matches the patterns we see in narratives that explode.',
    'analyze.verdict_sub_mid':  'There is a signal here, but the post has not broken out yet.',
    'analyze.verdict_sub_low':  'Weak narrative signal and low engagement — probably not going viral.',
    'analyze.score_meme':       'Viral potential',
    'analyze.score_emerge':     'Emergence',
    'analyze.score_adopt':      'Adoption',
    'analyze.score_story':      'Story',
    'analyze.score_low':        'Low',
    'analyze.score_mid':        'Medium',
    'analyze.score_high':       'High',
    'analyze.why_label':        'Why this score',
    'analyze.deep_ran':         'Deep analysis: completed',
    'analyze.deep_skipped':     'Deep analysis: skipped (low signal — saved you a Grok call)',
    'fav.add_tooltip': 'Save to favorites',
    'fav.remove_tooltip': 'Remove from favorites',
    'fav.locked_tooltip': 'Favorites is a Pro feature',
    'fav.locked_toast': '🔒 Favorites is a Pro feature',
    'fav.added_toast': '⭐ Saved to favorites',
    'fav.removed_toast': '☆ Removed from favorites',
    'fav.note_placeholder': 'Add a note (private, optional)',
    'fav.note_save': 'Save note',
    'fav.note_cancel': 'Cancel',
    'fav.note_edit': 'Edit note',
    'fav.note_remove': 'Remove note',
    'fav.filter_label': 'Saved only',
    'fav.empty': 'No saved narratives yet — tap ⭐ on any post to save it',
    'fav.snapshot_hint': 'Saved copy — original may have been removed',
    'analyze.cooldown': 'Cooldown active — please wait {sec}s.',
    'analyze.daily_cap': 'Daily limit reached (20 / 24h).',
    'analyze.error_prefix': 'Analysis failed: ',
    'analyze.open_full': 'Open full view',
    'analyze.empty': 'Paste a link above and hit Analyze to get started.',
    'analyze.from_cache': 'from cache · {min} min ago',
    'analyze.fresh_run': 'analysed in {sec}s',
    'analyze.open_link':  'Open original',
    'analyze.stage_fetch':    'Fetching post metadata',
    'analyze.stage_ai':       'Running AI analysis',
    'analyze.stage_deep':     'Deep search via Grok',
    'analyze.stage_finalize': 'Finalizing scores',

    // Time
    'time.just_now': 'just now',
    'time.min_ago': '{n}m ago',
    'time.hours_min_ago': '{h}h {m}m ago',
    'time.hours_ago': '{h}h ago',
    'time.days_ago': '{d}d ago',

    // Lifespan
    'lifespan.flash': '⚡ Hours',
    'lifespan.short': '📅 1-2 days',
    'lifespan.medium': '🗓 3-7 days',
    'lifespan.long': '📆 Weeks+',
    'lifespan.unknown': '—',

    // Phase hints
    'phase.early.hint': 'First signals — all risk, all upside',
    'phase.forming.hint': 'Narrative forming — golden window to ape',
    'phase.strong.hint': 'Strong signal — move fast or get left',
    'phase.saturated.hint': 'Narrative cooked — ngmi if you enter now',

    // Sentiment
    'sentiment.positive': '😊 Bullish AF',
    'sentiment.negative': '😠 Bearish',
    'sentiment.neutral': '😐 Mid',

    // Bars / scores
    'bar.emergence': '🌊 Emergence',
    'bar.adoption': '💊 Adoption',
    'bar.story': '📖 Story',

    // Feed card
    'feed.details': '📖 Details',
    'feed.open_source': 'Open',
    'feed.copy_title': 'Copy title',
    'feed.category_tip': 'Category',
    'feed.manual_tip': 'Manually submitted',
    'feed.fresh_tip':  'First seen within the last hour',
    'feed.catalyst_tip': 'Catalyst forecast available — open the card to read it',
    'badge.fresh':     'NEW',
    'badge.catalyst':  '🔮 Catalyst',
    'feedback.like': 'Smash that like',
    'feedback.unlike': 'Undo like',
    'feedback.dislike': 'Dislike',
    'feedback.undislike': 'Undo dislike',
    'feedback.reason.label': 'Why this rating?',
    'feedback.reason.placeholder': 'One short sentence — what made this great or off?',
    'feedback.reason.save': 'Save',
    'feedback.reason.clear': 'Clear',
    'feedback.reason.saved': 'Saved — AI will use it next cycle',
    'feedback.reason.cleared': 'Reason cleared',
    'feedback.reason.error': 'Could not save — try again',
    'feedback.reason.too_long': 'Max 240 characters',
    'feedback.reason.help': 'Vote first, then add a reason',

    // Feed panel
    'feed.panel.title': 'Narrative Feed',
    'feed.panel.count_signals': '{n} signals',
    // Tighter sub-line (was "Live narrative tracker · 3/4 sources · 24h window").
    // The tracker label is redundant when the user already knows what they're
    // looking at; the sources/window facts are the actual signal.
    'feed.panel.sub': '{active}/{total} sources · last {h}h',
    'feed.search_placeholder': 'Search narratives…',
    'feed.refresh_tip': 'Refresh (R)',
    'feed.refreshing': 'Refreshing…',
    'feed.scroll_top': 'Scroll to top',
    'feed.loading': 'Loading narratives…',
    'feed.empty.no_match': 'No matches for "{q}"',
    'feed.empty.no_data': 'No narratives match these filters',
    'feed.empty.hint': 'Try a wider time window or clear filters',
    'feed.filter.all': 'All',

    // Pagination
    'pagination.prev': '← Prev',
    'pagination.next': 'Next →',

    // Sidebar
    'sidebar.sources': 'Sources',
    'sidebar.phase': 'Phase',
    'sidebar.alert_type': 'Type',
    'sidebar.filters': 'Filters',
    'sidebar.manual_only': 'Manual',
    'feed.atype.event': 'Event',
    'feed.atype.trend': 'Trend',
    'feed.atype.post':  'Post',
    'feed.atype_chip': (label) => label, // for badge in feed cards
    'badge.alert_type.event': '📰 EVENT',
    'badge.alert_type.trend': '📈 TREND',
    'badge.alert_type.post':  '🚀 POST',
    'account.alert_types':       'Alert types',
    'account.alert_types_desc':  'Choose which kinds of alerts to receive (subscription, applies to Telegram + this dashboard).',
    // Shortened 2026-05-01 — long forms overflowed the toggle container in
    // AlertTypesRow. Hover/title attribute keeps the longer description.
    'account.alert_types_event': '📰 Events — concrete trigger',
    'account.alert_types_trend': '📈 Trends — multi-platform narrative',
    'account.alert_types_post':  '🚀 Posts — single viral post',
    'account.alert_types_save':  'Save',
    'account.alert_types_saved': '✓ Saved',
    'account.alert_types_all_off_hint': 'All off = receive all (we never silently mute you).',
    'sidebar.show_all': 'Show all',
    'sidebar.reset': 'Reset',
    'sidebar.window': '⏱ Window',
    'sidebar.category': '🏷️ Category',
    'sidebar.all_categories': 'All categories',
    'sidebar.sort': '🔀 Sort',
    'sort.rank': 'Rank',
    'sort.meme': 'Top adoption',
    'sort.emergence': 'Top emergence',
    'sort.time': 'Newest',
    'sort.virality': 'Virality',
    'tooltip.hide_source': 'Hide from feed (visual only)',
    'tooltip.show_source': 'Show in feed',
    'tooltip.show_all': 'Show all',
    'tooltip.reset': 'Reset',
    'tooltip.manual_on': 'Show only manually-submitted trends',
    'tooltip.manual_off': 'Show all trends',

    // Hero bar (session/trends summary header)
    'hero.window': 'Window',
    'hero.signals': 'Signals',
    'hero.alerts': 'Alerts',
    'hero.stats': '📊 Stats',
    'hero.scan_now': '⚡ Scan now',
    'hero.scanning': '⏳ Scanning…',

    // Right panel
    'right.top_narratives': '🏆 Top Narratives',
    'right.top_suffix': '{h}h · top {n}',
    'right.no_signals': 'No signals yet',
    'right.source_pulse': '📡 Source Pulse',
    'right.live_count': '{a}/{t} live',
    'right.activity': '🟢 Live',
    'right.activity_hours': '{h}h',
    'right.sources_label': 'Sources',
    'right.sources_active': 'Active sources',
    'right.kbd_hint': 'R refresh · Esc close',
    'right.signals': 'Signals',
    'right.alerts': 'Alerts',
    'right.avg_virality': 'Avg virality',
    'right.score.vrl': 'vrl',

    // Trend modal
    'modal.why_now': '🔥 Trigger',
    'modal.why_now_empty': 'No clear trigger — organic slow-burn',
    'modal.trigger': '🔥 Trigger',
    'modal.ai_explanation': '🤖 AI alpha',
    // Trigger search (on-demand Grok reasoning)
    'trigger.label':         '🔮 Catalyst',
    'trigger.btn':           '🔮 Forecast Catalyst',
    'trigger.btn_pro_only':  '🔒 Catalyst forecast — Test/Pro',
    'trigger.daily_limit':   '⛔ Daily Catalyst limit reached ({cap}/24h)',
    'window.locked_tooltip': 'Available on Test/Pro plan',
    'window.locked_toast':   '🔒 Wider time window is available on Test/Pro',
    'source.locked_tooltip': 'Available on Test/Pro plan',
    'source.locked_toast':   '🔒 This source is available on Test/Pro',
    'usage.test_left':       '📊 {used}/{cap} used today ({left} left)',
    'trigger.locked_title':  'Catalyst forecast',
    'trigger.locked_desc':   'Available on Test and Pro plans',
    'trigger.btn_loading':   '🔮 Forecasting… (~30-60s)',
    'trigger.confidence':    'Confidence: {pct}%',
    'trigger.confidence_label': 'Confidence',
    'trigger.sources':       '📡 Sources:',
    'trigger.sources_head':  '𝕏 Sources',
    'trigger.in_flight':     '🔮 Another user is already forecasting this catalyst. Try again in ~30s.',
    'trigger.cooldown':      '⏳ You can run another catalyst forecast in {min} min',
    'trigger.error':         '❌ Catalyst forecast failed: {err}',
    'trigger.disabled':      '❌ Catalyst forecast is currently unavailable.',
    'trigger.phase_label':   'Phase',
    'trigger.window_label':  'Window',
    'trigger.drivers_label': '📈 Growth drivers',
    'trigger.risks_label':   '⚠️ Risks',
    'trigger.cta_hint':      'Where this narrative is heading - phase, catalysts, risks.',
    'trigger.phase.early':       'Early',
    'trigger.phase.building':    'Building',
    'trigger.phase.peaking':     'Peaking',
    'trigger.phase.saturated':   'Saturated',
    'trigger.phase.fading':      'Fading',
    'modal.market_stage': '💹 Market Stage',
    'modal.metrics': '📊 Stats',
    'modal.meme_score': 'Meme Score',
    'modal.lifespan': 'Lifespan',
    'modal.virality': 'Virality',
    'modal.sentiment': 'Vibe',
    'modal.velocity': 'Velocity',
    'modal.alert_score': 'Alert',
    'modal.alert_pass': 'would alert',
    'modal.alert_fail': "won't alert",
    'modal.alert_breakdown': '🔔 Alert verdict',
    'modal.alert_floor': 'floor',
    'modal.alert_type_in_filter': '✓ in your filter',
    'modal.alert_type_muted': '✕ muted in your filter',
    'modal.alert_breakdown_meme': 'meme',
    'modal.alert_breakdown_viral': 'viral',
    'modal.alert_breakdown_emerge': 'emerge',
    'modal.alert_breakdown_twitter': 'X',
    'modal.alert_breakdown_feedback': 'feedback',
    'modal.alert_breakdown_junk': 'junk',
    'modal.alert_breakdown_stale': 'stale',
    'modal.alert_details_show': 'show math',
    'modal.alert_details_hide': 'hide math',
    'modal.alert_section_positive': '+ positive signals',
    'modal.alert_section_penalty': '- penalties',
    'modal.alert_floor_explain': 'Floor {floor} = max(your {user}, admin {admin})',
    'modal.alert_junk_triggers': 'junk triggers',
    'modal.alert_no_breakdown': 'No detailed breakdown saved for this trend',
    'modal.alert_spark_label': 'score evolution',
    'modal.alert_spark_points': 'pts',
    'modal.alert_no_score': 'not scored yet',

    // ── Term-help tooltips (admin-only "?" bubbles) ──
    'term.meme_score':  'AI estimate (0-100) of how meme-shaped the trend is — animal, absurd, heartwarming, copypasta. Drives ~45% of the alert score by default.',
    'term.virality':    'Engagement-based virality (0-100) — likes, retweets, comments, replies, upvotes plus velocity weighting.',
    'term.velocity':    'Engagement growth rate per hour (e.g. 12K/h). Empty when negative or stale.',
    'term.alert_score': 'Composite 0-100 verdict. Combines meme, virality, emergence, X signal and feedback votes minus junk and stale-decay penalties. Decides if a Telegram alert fires.',
    'term.lifespan':    'AI prediction of how long this trend stays interesting — short / medium / long.',
    'term.emergence':   'Cluster velocity: how fast this narrative spreads vs background noise. High = picking up steam right now.',
    'term.feedback':    'Bias from user 👍/👎 votes (50 = neutral). Likes push the score up; mass dislikes pull it down. Below 5 votes the effect is dampened.',
    'term.junk':        'Junk-filter penalty (0-100) — politics, k-pop drama, celeb noise, no meme-shape, text-only. Subtracted from positive score.',
    'term.stale':       'Age penalty. After 24h grace each hour subtracts ~2 points (max −30). Punishes alerts about old news.',
    'modal.feedback': '💬 Your take',
    'modal.links': '🔗 Links',
    'modal.source_link': '{ico} Source →',
    'modal.tg_link': '📨 Telegram',
    'modal.ask_grok': '🧠 Ask Grok',
    'modal.xtrends_top_tweets': '🔥 Top tweets ({n})',

    // Control panel
    'control.title': '⚙️ Controls',
    'control.scan': 'Scan',
    'control.health': 'Health',
    'control.reload': 'Reload',
    'control.stats': 'Stats',
    'control.health_ok': '✅ Server alive · uptime {m}m',
    'control.error': '❌ Error: {e}',
    'control.enable_source': 'Enable source',
    'control.disable_source': 'Disable source',

    // Stats view
    'stats.overview': '📊 Stats overview',
    'stats.sources': 'Sources',
    'stats.window': '{h}h window',
    'stats.categories': 'Categories',
    'stats.categories_sub': 'Top focus areas',
    'stats.cluster_count': 'Narrative cluster count',
    'stats.no_category_data': 'No category data yet',
    'stats.top_narratives': 'Top narratives',
    'stats.top_narratives_sub': 'Highest adoption right now',
    'stats.no_trend_data': 'No trend data yet',

    // Settings
    'settings.title': 'Dashboard settings',
    'settings.flash_reset': '✓ Settings reset',
    'settings.flash_sources_shown': '✓ All sources visible',

    'settings.appearance': '🎨 Appearance',
    'settings.appearance_desc': 'Visual preferences — applied instantly, stored in this browser.',
    'settings.density': 'Feed density',
    'settings.density_desc': 'Compact shrinks padding and card size for dense scrolling.',
    'settings.density.comfy': 'Comfy',
    'settings.density.compact': 'Compact',
    'settings.images': 'Show previews',
    'settings.images_desc': 'Turn off to declutter the feed — hides image and video previews in cards and modals.',
    'settings.animations': 'UI animations',
    'settings.animations_desc': 'Turn off to reduce load on slower devices.',
    'settings.hover_preview': 'Hover preview',
    'settings.hover_preview_desc': 'Show tweet/post content card when hovering over a source link.',
    'settings.col_left':  'Left column width',
    'settings.col_left_desc':  'Sidebar width — sources, phase, filters. Currently {px}px.',
    'settings.col_right': 'Right column width',
    'settings.col_right_desc': 'Insights / stats panel width. Currently {px}px.',


    'settings.behavior': '🔄 Behavior',
    'settings.behavior_desc': 'Source visibility in the feed. New data arrives live — no auto-refresh timer needed.',
    'settings.hidden': 'Hidden sources',
    'settings.hidden_count': '{n} hidden. Visual filter in this browser only.',
    'settings.hidden_none': 'Nothing hidden — click sources in the sidebar to hide them.',
    'settings.hidden_show_all': 'Show all',

    // ── Per-trend hide / archive (per-user, server-side, 7d retention) ──
    'feed.hide_btn_tip': 'Hide this alert',
    'toast.alert_hidden': 'Hidden',
    'toast.undo': 'Undo',
    'archive.title': '📦 Archive',
    'archive.desc': 'Alerts you hid. Kept for 7 days, then auto-removed.',
    'archive.empty': 'Nothing here yet — click ✕ on a card to hide it.',
    'archive.restore': '↺ Restore',
    'archive.clear_all': 'Clear archive',
    'archive.clear_confirm': 'Remove all hidden alerts? This cannot be undone.',
    'archive.count': '{n} hidden',
    'archive.loading': 'Loading…',

    'settings.language': '🌐 Language',
    'settings.language_desc': 'Dashboard language and Ask-Grok prompt language. Bot stays in your Telegram language.',
    'settings.language_dashboard': 'Dashboard',
    'settings.language_dashboard_hint': 'UI language',
    'settings.grok_language': 'Ask Grok',
    'settings.grok_language_hint': 'Prompt language for the "Ask Grok" button',

    'settings.theme': '🎨 Theme',
    'settings.theme_desc': 'Pick your vibe. All dark — no white allowed.',

    'settings.account': '👤 Account',
    'settings.account_desc': 'Login goes through our Telegram bot. Your plan and settings are tied to this account.',
    'settings.tg': 'Telegram',
    'settings.tg_chatid': 'chat id: {id}',
    'settings.plan': 'Plan',
    'settings.plan_desc': 'Weights your likes/dislikes and unlocks premium features.',
    'account.subscription': 'Subscription',
    'account.subscription_desc': 'Your plan is active until this date.',
    // Renamed 2026-05-01 to make scope explicit: this slider gates Telegram
    // pushes only, not the dashboard feed. Earlier wording suggested it
    // filtered everything, which it doesn't — the feed still shows all
    // Stage-1-scored trends regardless.
    'account.threshold': 'Telegram alert threshold',
    'account.threshold_desc': 'Minimum alertScore for the bot to push you a Telegram alert. Higher = fewer, stronger alerts. Applies on top of the platform floor. Does NOT filter the dashboard feed.',
    'settings.logout': 'Log out',
    'settings.logout_desc': "Unlink this browser. You'll need a fresh bot code to sign back in.",
    'settings.logout_confirm': "Log out? You'll need to verify a fresh bot code to sign back in.",

    'settings.reset_all': '↺ Reset all settings',
    'settings.reset_all_confirm': 'Reset all dashboard settings to defaults?',

    'plan.free': 'Free',
    'plan.test': 'Test',
    'plan.pro': 'Pro',
    'plan.admin': 'Admin',

    // Market stage hints
    'market.tokenizing.hint': 'Launch discussions / pump.fun mentioned',
    'market.live.hint': 'Contract address or DEX links found',
    'market.overheated.hint': 'Trading active — late/rug signals present',

    // Login
    'login.subtitle': 'Sign in via Telegram',
    'login.idle_desc': "No passwords here. Auth goes through our Telegram bot — you'll get a one-time code and paste it below.",
    'login.idle_btn': '💬 Sign in with Telegram',
    'login.code_desc': "Open the bot and hit Start — it'll send a 6-digit code. Paste it below:",
    'login.bot_unavailable': 'Bot is temporarily unavailable. Try again later.',
    'login.reopen_bot': '↗ Reopen the bot',
    'login.verify_btn': 'Sign in',
    'login.verifying': 'Verifying…',
    'login.err_need_6': 'Enter the 6 digits from the bot message',

    // Toasts
    'toast.refreshing': 'Refreshed',
    'toast.copied': '📋 Copied!',
    'toast.copy_failed': 'Copy failed',
    'toast.all_sources_visible': '👁 All sources visible',
    'toast.hidden_from_feed': '🙈 Hidden from feed: {name}',
    'toast.shown_in_feed': '👁 Shown: {name}',
    'toast.filters_reset': '♻️ Filters reset',
    'toast.manual_only_on': '🧪 Showing manual submissions only',
    'toast.manual_only_off': '🧪 Showing all trends',
    'toast.error_prefix': 'Error: {e}',
  },

  ru: {
    // App
    'app.title': 'Catalyst',
    'app.subtitle': 'Narrative Terminal',
    'app.loading': 'Загрузка…',
    'app.please_wait': 'Подождите…',
    'app.back': '← Назад',
    'app.reset': 'Сброс',
    'app.cancel': '← Отменить',
    'app.esc_close': '✕ Esc',

    // Status bar
    'status.live': 'LIVE',
    'status.offline': 'OFFLINE',

    // Nav
    'nav.live': 'Онлайн',
    'nav.offline': 'Офлайн',
    'nav.stats': 'Статистика',
    'nav.settings': 'Настройки',
    'nav.feed': 'Фид',
    'nav.account': 'Аккаунт',
    'nav.analyze': 'Анализ',
    'nav.saved': 'Избранное',
    'analyze.title': 'Анализ поста',
    'analyze.intro': 'Вставь ссылку на пост из X / Reddit / TikTok (или любую страницу с превью-картинкой). Сравним с трендами сегодняшнего дня и скажем, есть ли шанс уйти в вирус.',
    'analyze.url_label': 'Ссылка на пост',
    'analyze.url_placeholder': 'https://x.com/user/status/...',
    'analyze.run_btn': 'Анализ',
    'analyze.running': 'Анализирую...',
    'analyze.subtitle': 'Обычно 10-30 секунд',
    'analyze.locked': 'Ручной анализ — на Test/Pro плане.',
    'analyze.locked_tooltip': 'Доступно на Test/Pro',
    'analyze.locked_toast': '🔒 Ручной анализ — на Test/Pro',
    'analyze.verdict_high':     '🔥 Высокий вирусный потенциал',
    'analyze.verdict_mid':      '📈 Есть потенциал',
    'analyze.verdict_low':      '💤 Вряд ли разлетится',
    'analyze.verdict_sub_high': 'Пост попадает в паттерны нарративов, которые взрываются.',
    'analyze.verdict_sub_mid':  'Сигнал есть, но пост пока не пробил.',
    'analyze.verdict_sub_low':  'Слабый нарратив и низкая вовлечённость — вирусности ждать не стоит.',
    'analyze.score_meme':       'Вирусность',
    'analyze.score_emerge':     'Emergence',
    'analyze.score_adopt':      'Adoption',
    'analyze.score_story':      'Story',
    'analyze.score_low':        'Низкий',
    'analyze.score_mid':        'Средний',
    'analyze.score_high':       'Высокий',
    'analyze.why_label':        'Почему такая оценка',
    'analyze.deep_ran':         'Глубокий анализ: выполнен',
    'analyze.deep_skipped':     'Глубокий анализ: пропущен (слабый сигнал — сэкономили Grok-запрос)',
    'fav.add_tooltip': 'В избранное',
    'fav.remove_tooltip': 'Убрать из избранного',
    'fav.locked_tooltip': 'Избранное — только на Pro',
    'fav.locked_toast': '🔒 Избранное доступно только на Pro',
    'fav.added_toast': '⭐ Добавлено в избранное',
    'fav.removed_toast': '☆ Убрано из избранного',
    'fav.note_placeholder': 'Заметка (приватная, опционально)',
    'fav.note_save': 'Сохранить',
    'fav.note_cancel': 'Отмена',
    'fav.note_edit': 'Изменить заметку',
    'fav.note_remove': 'Удалить заметку',
    'fav.filter_label': 'Только избранное',
    'fav.empty': 'Пока ничего не сохранено — нажми ⭐ на любом тренде',
    'fav.snapshot_hint': 'Сохранённая копия — оригинал мог быть удалён',
    'analyze.cooldown': 'Подожди {sec} с — анализ ещё идёт.',
    'analyze.daily_cap': 'Лимит на сегодня исчерпан (20 / 24ч).',
    'analyze.error_prefix': 'Ошибка: ',
    'analyze.open_full': 'Открыть карточку',
    'analyze.empty': 'Вставь ссылку выше и нажми Анализ.',
    'analyze.from_cache': 'из кэша · {min} мин назад',
    'analyze.fresh_run': 'анализ за {sec}с',
    'analyze.open_link':  'Открыть оригинал',
    'analyze.stage_fetch':    'Получаю данные поста',
    'analyze.stage_ai':       'Запускаю AI-анализ',
    'analyze.stage_deep':     'Глубокий поиск через Grok',
    'analyze.stage_finalize': 'Финализирую скоры',

    // Time
    'time.just_now': 'только что',
    'time.min_ago': '{n}м назад',
    'time.hours_min_ago': '{h}ч {m}м назад',
    'time.hours_ago': '{h}ч назад',
    'time.days_ago': '{d}д назад',

    // Lifespan
    'lifespan.flash': '⚡ Часы',
    'lifespan.short': '📅 1-2 дня',
    'lifespan.medium': '🗓 3-7 дней',
    'lifespan.long': '📆 Недели+',
    'lifespan.unknown': '—',

    // Phase hints
    'phase.early.hint': 'Первые сигналы — риск и потенциал',
    'phase.forming.hint': 'Нарратив развивается — золотое окно',
    'phase.strong.hint': 'Сильный сигнал — действуй быстро',
    'phase.saturated.hint': 'Нарратив переварен — поздно',

    // Sentiment
    'sentiment.positive': '😊 Позитив',
    'sentiment.negative': '😠 Негатив',
    'sentiment.neutral': '😐 Нейтраль',

    // Bars / scores
    'bar.emergence': '🌊 Emergence',
    'bar.adoption': '💊 Adoption',
    'bar.story': '📖 Story',

    // Feed card
    'feed.details': '📖 Подробнее',
    'feed.open_source': 'Открыть',
    'feed.copy_title': 'Скопировать заголовок',
    'feed.category_tip': 'Категория',
    'feed.manual_tip': 'Добавлено вручную',
    'feed.fresh_tip':  'Появился в последний час',
    'feed.catalyst_tip': 'Каталист найден — открой карточку чтобы прочитать прогноз',
    'badge.fresh':     'NEW',
    'badge.catalyst':  '🔮 Каталист',
    'feedback.like': 'Лайк',
    'feedback.unlike': 'Убрать лайк',
    'feedback.dislike': 'Дизлайк',
    'feedback.undislike': 'Убрать дизлайк',
    'feedback.reason.label': 'Почему такая оценка?',
    'feedback.reason.placeholder': 'Одно короткое предложение — что зашло или не зашло?',
    'feedback.reason.save': 'Сохранить',
    'feedback.reason.clear': 'Очистить',
    'feedback.reason.saved': 'Сохранено — AI учтёт в следующем цикле',
    'feedback.reason.cleared': 'Причина очищена',
    'feedback.reason.error': 'Не удалось сохранить — попробуй ещё раз',
    'feedback.reason.too_long': 'Максимум 240 символов',
    'feedback.reason.help': 'Сначала проголосуй, потом добавь причину',

    // Feed panel
    'feed.panel.title': 'Фид нарративов',
    'feed.panel.count_signals': '{n} сигналов',
    // Терсий sub-line (было «Живой трекер нарративов · 3/4 источников · окно 24ч»).
    'feed.panel.sub': '{active}/{total} источников · за {h}ч',
    'feed.search_placeholder': 'Поиск нарративов…',
    'feed.refresh_tip': 'Обновить (R)',
    'feed.refreshing': 'Обновляю…',
    'feed.scroll_top': 'Наверх',
    'feed.loading': 'Загружаю нарративы…',
    'feed.empty.no_match': 'Нет совпадений для «{q}»',
    'feed.empty.no_data': 'Под текущие фильтры ничего нет',
    'feed.empty.hint': 'Расширь окно или сбрось фильтры',
    'feed.filter.all': 'Все',

    // Pagination
    'pagination.prev': '← Назад',
    'pagination.next': 'Далее →',

    // Sidebar
    'sidebar.sources': 'Источники',
    'sidebar.phase': 'Фаза',
    'sidebar.alert_type': 'Тип',
    'sidebar.filters': 'Фильтры',
    'sidebar.manual_only': 'Ручные',
    'feed.atype.event': 'Событие',
    'feed.atype.trend': 'Тренд',
    'feed.atype.post':  'Пост',
    'feed.atype_chip': (label) => label,
    'badge.alert_type.event': '📰 СОБЫТИЕ',
    'badge.alert_type.trend': '📈 ТРЕНД',
    'badge.alert_type.post':  '🚀 ПОСТ',
    'account.alert_types':       'Типы алертов',
    'account.alert_types_desc':  'Выберите, какие алерты получать (подписка, применяется к Telegram и дашборду).',
    // Сокращено 2026-05-01 — длинные формулировки вылезали за границы тогглов
    // в AlertTypesRow.
    'account.alert_types_event': '📰 События — конкретный триггер',
    'account.alert_types_trend': '📈 Тренды — на нескольких платформах',
    'account.alert_types_post':  '🚀 Посты — один вирусный пост',
    'account.alert_types_save':  'Сохранить',
    'account.alert_types_saved': '✓ Сохранено',
    'account.alert_types_all_off_hint': 'Если выключить все — приходят все (мы никогда не мутим вас молча).',
    'sidebar.show_all': 'Показать все',
    'sidebar.reset': 'Сбросить',
    'sidebar.window': '⏱ Окно',
    'sidebar.category': '🏷️ Категория',
    'sidebar.all_categories': 'Все категории',
    'sidebar.sort': '🔀 Сортировка',
    'sort.rank': 'Рейтинг',
    'sort.meme': 'Топ adoption',
    'sort.emergence': 'Топ emergence',
    'sort.time': 'Свежие',
    'sort.virality': 'Виральность',
    'tooltip.hide_source': 'Скрыть из фида (визуально)',
    'tooltip.show_source': 'Показать в фиде',
    'tooltip.show_all': 'Показать все',
    'tooltip.reset': 'Сбросить',
    'tooltip.manual_on': 'Показать только ручные сабмиты',
    'tooltip.manual_off': 'Показать все тренды',

    // Hero bar
    'hero.window': 'Окно',
    'hero.signals': 'Сигналы',
    'hero.alerts': 'Алерты',
    'hero.stats': '📊 Статистика',
    'hero.scan_now': '⚡ Сканировать',
    'hero.scanning': '⏳ Сканирую…',

    // Right panel
    'right.top_narratives': '🏆 Топ нарративов',
    'right.top_suffix': '{h}ч · топ {n}',
    'right.no_signals': 'Пока нет сигналов',
    'right.source_pulse': '📡 Пульс источников',
    'right.live_count': '{a}/{t} активных',
    'right.activity': '🟢 Live',
    'right.activity_hours': '{h}ч',
    'right.sources_label': 'Источники',
    'right.sources_active': 'Активных источников',
    'right.kbd_hint': 'R обновить · Esc закрыть',
    'right.signals': 'Сигналы',
    'right.alerts': 'Алерты',
    'right.avg_virality': 'Ср. виральность',
    'right.score.vrl': 'vrl',

    // Trend modal
    'modal.why_now': '🔥 Триггер',
    'modal.why_now_empty': 'Нет явного триггера — органический рост',
    'modal.trigger': '🔥 Триггер',
    'modal.ai_explanation': '🤖 AI-объяснение',
    // Trigger search (on-demand Grok reasoning)
    'trigger.label':         '🔮 Каталист',
    'trigger.btn':           '🔮 Найти Каталиста',
    'trigger.btn_pro_only':  '🔒 Каталист — Test/Pro',
    'trigger.daily_limit':   '⛔ Дневной лимит Каталиста ({cap}/24ч)',
    'window.locked_tooltip': 'Доступно на Test/Pro',
    'window.locked_toast':   '🔒 Большее окно времени — на Test/Pro',
    'source.locked_tooltip': 'Доступно на Test/Pro',
    'source.locked_toast':   '🔒 Этот источник — на Test/Pro',
    'usage.test_left':       '📊 {used}/{cap} сегодня (осталось {left})',
    'trigger.locked_title':  'Катализатор',
    'trigger.locked_desc':   'Доступно на Test и Pro',
    'trigger.btn_loading':   '🔮 Ищу Каталиста… (~30-60с)',
    'trigger.confidence':    'Уверенность: {pct}%',
    'trigger.confidence_label': 'Уверенность',
    'trigger.sources':       '📡 Источники:',
    'trigger.sources_head':  '𝕏 Источники',
    'trigger.in_flight':     '🔮 Другой юзер уже ищет Каталиста. Попробуй через ~30с.',
    'trigger.cooldown':      '⏳ Следующий поиск Каталиста через {min} мин',
    'trigger.error':         '❌ Ошибка поиска Каталиста: {err}',
    'trigger.disabled':      '❌ Поиск Каталиста недоступен.',
    'trigger.phase_label':   'Фаза',
    'trigger.window_label':  'Окно',
    'trigger.drivers_label': '📈 Факторы роста',
    'trigger.risks_label':   '⚠️ Риски',
    'trigger.cta_hint':      'Куда движется этот нарратив - фаза, каталисты, риски.',
    'trigger.phase.early':       'Зарождается',
    'trigger.phase.building':    'Набирает',
    'trigger.phase.peaking':     'На пике',
    'trigger.phase.saturated':   'Насыщен',
    'trigger.phase.fading':      'Угасает',
    'modal.market_stage': '💹 Стадия рынка',
    'modal.metrics': '📊 Метрики',
    'modal.meme_score': 'Meme Score',
    'modal.lifespan': 'Срок жизни',
    'modal.virality': 'Виральность',
    'modal.sentiment': 'Сентимент',
    'modal.velocity': 'Скорость',
    'modal.alert_score': 'Alert',
    'modal.alert_pass': 'алерт пройдёт',
    'modal.alert_fail': 'не алертится',
    'modal.alert_breakdown': '🔔 Решение алерта',
    'modal.alert_floor': 'порог',
    'modal.alert_type_in_filter': '✓ в вашем фильтре',
    'modal.alert_type_muted': '✕ выключен в фильтре',
    'modal.alert_breakdown_meme': 'meme',
    'modal.alert_breakdown_viral': 'viral',
    'modal.alert_breakdown_emerge': 'emerge',
    'modal.alert_breakdown_twitter': 'X',
    'modal.alert_breakdown_feedback': 'feedback',
    'modal.alert_breakdown_junk': 'junk',
    'modal.alert_breakdown_stale': 'stale',
    'modal.alert_details_show': 'детали',
    'modal.alert_details_hide': 'скрыть',
    'modal.alert_section_positive': '+ положительные',
    'modal.alert_section_penalty': '- штрафы',
    'modal.alert_floor_explain': 'Порог {floor} = max(твой {user}, админ {admin})',
    'modal.alert_junk_triggers': 'junk триггеры',
    'modal.alert_no_breakdown': 'Подробная разбивка для этого тренда не сохранена',
    'modal.alert_spark_label': 'эволюция score',
    'modal.alert_spark_points': 'точек',
    'modal.alert_no_score': 'ещё не оценено',

    // ── Term-help tooltips (admin-only "?" bubbles) ──
    'term.meme_score':  'Оценка AI (0-100): насколько штука похожа на мем — животные, абсурд, heartwarming, копипаста. Даёт ~45% веса в alertScore по дефолту.',
    'term.virality':    'Вирусность по engagement (0-100) — лайки, ретвиты, комменты, реплаи, апвоуты плюс velocity-вес.',
    'term.velocity':    'Прирост engagement в час (например 12K/ч). Пусто если отрицательный или старый тренд.',
    'term.alert_score': 'Итоговый 0-100 verdict. Складывает meme, virality, emergence, X-сигнал и feedback votes минус penalties (junk, stale-decay). Решает: отправится ли Telegram-алерт.',
    'term.lifespan':    'Предсказание AI: как долго тренд останется интересным — короткий / средний / длинный.',
    'term.emergence':   'Cluster velocity: насколько быстро нарратив распространяется относительно фонового шума. Высокий = сейчас набирает обороты.',
    'term.feedback':    'Bias от 👍/👎 юзеров (50 = нейтрал). Лайки толкают score вверх, дизы — вниз. Меньше 5 голосов — эффект ослаблен.',
    'term.junk':        'Штраф junk-фильтра (0-100) — политика, k-pop, celeb-шум, нет meme-shape, text-only. Вычитается из positive score.',
    'term.stale':       'Штраф за возраст. После 24h grace каждый час -2 очка (max -30). Бьёт по алертам о вчерашних новостях.',
    'modal.feedback': '💬 Ваша оценка',
    'modal.links': '🔗 Ссылки',
    'modal.source_link': '{ico} Источник →',
    'modal.tg_link': '📨 Telegram',
    'modal.ask_grok': '🧠 Спросить Grok',
    'modal.xtrends_top_tweets': '🔥 Топовые твиты ({n})',

    // Control panel
    'control.title': '⚙️ Управление',
    'control.scan': 'Сканировать',
    'control.health': 'Здоровье',
    'control.reload': 'Перезагрузить',
    'control.stats': 'Статистика',
    'control.health_ok': '✅ Сервер живёт · uptime {m}м',
    'control.error': '❌ Ошибка: {e}',
    'control.enable_source': 'Включить источник',
    'control.disable_source': 'Отключить источник',

    // Stats view
    'stats.overview': '📊 Обзор статистики',
    'stats.sources': 'Источники',
    'stats.window': 'окно {h}ч',
    'stats.categories': 'Категории',
    'stats.categories_sub': 'Топ категорий',
    'stats.cluster_count': 'Кластер нарративов',
    'stats.no_category_data': 'Ещё нет данных по категориям',
    'stats.top_narratives': 'Топ нарративов',
    'stats.top_narratives_sub': 'Самый высокий adoption сейчас',
    'stats.no_trend_data': 'Ещё нет данных по трендам',

    // Settings
    'settings.title': 'Настройки дашборда',
    'settings.flash_reset': '✓ Настройки сброшены',
    'settings.flash_sources_shown': '✓ Все источники показаны',

    'settings.appearance': '🎨 Внешний вид',
    'settings.appearance_desc': 'Только визуальные предпочтения — применяются мгновенно и хранятся в этом браузере.',
    'settings.density': 'Плотность фида',
    'settings.density_desc': 'Compact уменьшает отступы и размер карточек для плотного просмотра.',
    'settings.density.comfy': 'Comfy',
    'settings.density.compact': 'Compact',
    'settings.images': 'Показывать превью',
    'settings.images_desc': 'Отключи чтобы разгрузить фид — скрывает превью картинок и видео в карточках и модалках.',
    'settings.animations': 'Анимации интерфейса',
    'settings.animations_desc': 'Отключи для снижения нагрузки на слабых устройствах.',
    'settings.hover_preview': 'Превью при наведении',
    'settings.hover_preview_desc': 'Показывать карточку с содержимым твита/поста при наведении на ссылку источника.',
    'settings.col_left':  'Ширина левой колонки',
    'settings.col_left_desc':  'Сайдбар — источники, фаза, фильтры. Сейчас {px}px.',
    'settings.col_right': 'Ширина правой колонки',
    'settings.col_right_desc': 'Панель инсайтов и статистики. Сейчас {px}px.',


    'settings.behavior': '🔄 Поведение',
    'settings.behavior_desc': 'Видимость источников в фиде. Новые данные приходят в реальном времени — таймер автообновления не нужен.',
    'settings.hidden': 'Скрытые источники',
    'settings.hidden_count': 'Сейчас скрыто: {n}. Это только визуальная фильтрация в твоём браузере.',
    'settings.hidden_none': 'Ничего не скрыто — можешь скрывать источники кликом в сайдбаре.',
    'settings.hidden_show_all': 'Показать все',

    // ── Скрытие алертов / архив (per-user, server-side, 7 дней) ──
    'feed.hide_btn_tip': 'Скрыть алерт',
    'toast.alert_hidden': 'Скрыто',
    'toast.undo': 'Отменить',
    'archive.title': '📦 Архив',
    'archive.desc': 'Алерты, которые ты скрыл. Хранятся 7 дней, потом удаляются.',
    'archive.empty': 'Пусто — клик по ✕ на карточке скроет её.',
    'archive.restore': '↺ Вернуть',
    'archive.clear_all': 'Очистить архив',
    'archive.clear_confirm': 'Удалить все скрытые алерты? Это нельзя отменить.',
    'archive.count': 'Скрыто: {n}',
    'archive.loading': 'Загрузка…',

    'settings.language': '🌐 Язык',
    'settings.language_desc': 'Язык дашборда и промта для Ask Grok. Бот остаётся на языке вашего Telegram.',
    'settings.language_dashboard': 'Дашборд',
    'settings.language_dashboard_hint': 'Язык интерфейса',
    'settings.grok_language': 'Ask Grok',
    'settings.grok_language_hint': 'Язык промта для кнопки "Ask Grok"',

    'settings.theme': '🎨 Тема',
    'settings.theme_desc': 'Выбери настроение. Все тёмные — никакого белого.',

    'settings.account': '👤 Аккаунт',
    'settings.account_desc': 'Вход выполняется через Telegram-бота. Твой план и настройки привязаны к этому аккаунту.',
    'settings.tg': 'Telegram',
    'settings.tg_chatid': 'chat id: {id}',
    'settings.plan': 'Тариф',
    'settings.plan_desc': 'Влияет на вес твоих лайков/дизлайков и доступ к премиум-функциям.',
    'account.subscription': 'Подписка',
    'account.subscription_desc': 'Тариф активен до этой даты.',
    // Переименовано 2026-05-01 — слайдер управляет ТОЛЬКО TG-алертами,
    // на дашбод-фид не влияет. Старое имя «Чувствительность алертов»
    // создавало впечатление общего фильтра.
    'account.threshold': 'Порог Telegram-алертов',
    'account.threshold_desc': 'Минимальный alertScore, при котором бот пришлёт алерт в Telegram. Выше = строже (меньше, но сильнее). Действует поверх глобального floor платформы. На фид в дашбоде НЕ влияет.',
    'settings.logout': 'Выйти',
    'settings.logout_desc': 'Отвязать этот браузер. Для повторного входа потребуется новый код из бота.',
    'settings.logout_confirm': 'Выйти из аккаунта? Нужно будет снова подтвердить код в Telegram.',

    'settings.reset_all': '↺ Сбросить все настройки',
    'settings.reset_all_confirm': 'Сбросить все настройки дашборда к значениям по умолчанию?',

    'plan.free': 'Free',
    'plan.test': 'Test',
    'plan.pro': 'Pro',
    'plan.admin': 'Admin',

    // Market stage hints
    'market.tokenizing.hint': 'Обсуждение запуска / упомянут pump.fun',
    'market.live.hint': 'Найден контракт или ссылки на DEX',
    'market.overheated.hint': 'Торги идут — поздно / признаки rug',

    // Login
    'login.subtitle': 'Вход через Telegram',
    'login.idle_desc': 'Мы не храним пароли. Авторизация — через нашего Telegram-бота: ты получишь одноразовый код и введёшь его здесь.',
    'login.idle_btn': '💬 Войти через Telegram',
    'login.code_desc': 'Открой чат с ботом и нажми Start — он пришлёт шестизначный код. Введи его ниже:',
    'login.bot_unavailable': 'Бот временно недоступен. Попробуйте позже.',
    'login.reopen_bot': '↗ Открыть бота снова',
    'login.verify_btn': 'Войти',
    'login.verifying': 'Проверяем…',
    'login.err_need_6': 'Введите 6 цифр из сообщения бота',

    // Toasts
    'toast.refreshing': 'Обновлено',
    'toast.copied': '📋 Скопировано!',
    'toast.copy_failed': 'Не удалось скопировать',
    'toast.all_sources_visible': '👁 Все источники видимы',
    'toast.hidden_from_feed': '🙈 Скрыт в фиде: {name}',
    'toast.shown_in_feed': '👁 Показан: {name}',
    'toast.filters_reset': '♻️ Фильтры сброшены',
    'toast.manual_only_on': '🧪 Только ручные сабмиты',
    'toast.manual_only_off': '🧪 Показываю все тренды',
    'toast.error_prefix': 'Ошибка: {e}',
  },
};

function t(key, args) {
  const dict = I18N[CURRENT_LANG] || I18N.en;
  let str = dict[key];
  if (str == null) str = (I18N.en[key] != null ? I18N.en[key] : key);
  if (args) {
    for (const k in args) {
      str = str.split('{' + k + '}').join(String(args[k]));
    }
  }
  return str;
}
function useLang() {
  const [lang, setLangState] = useState(CURRENT_LANG);
  useEffect(() => onLangChange(setLangState), []);
  return lang;
}
function useGrokLang() {
  // Subscribes to both UI-lang changes and explicit grok-lang changes —
  // when grok-lang is unset (auto), it follows UI-lang in real time.
  const [g, setG] = useState(getGrokLang);
  useEffect(() => {
    const off1 = onGrokLangChange(() => setG(getGrokLang()));
    const off2 = onLangChange(() => setG(getGrokLang()));
    return () => { off1 && off1(); off2 && off2(); };
  }, []);
  return g;
}
function localeTag() { return CURRENT_LANG === 'ru' ? 'ru-RU' : 'en-US'; }
function useTheme() {
  const [theme, setThemeState] = useState(CURRENT_THEME);
  useEffect(() => onThemeChange(setThemeState), []);
  return theme;
}

const api = (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
  return fetch('/api' + path, { ...opts, headers })
    .then(r => r.json().then(data => {
      if (r.status === 401) {
        // Token rejected — nuke it and re-show the login screen
        if (AUTH_TOKEN) setAuthToken('');
        const err = new Error(data?.error || 'Unauthorized');
        err.status = 401;
        throw err;
      }
      if (!r.ok) {
        const err = new Error(data && data.error ? data.error : ('HTTP ' + r.status));
        err.status = r.status;
        err.reason = data && data.reason ? data.reason : null;
        throw err;
      }
      return data;
    }));
};

// ── Constants ────────────────────────────────────────────────────────────────
// Inline SVG logos — real brand marks (Snoo, multicolor-G shape, X glyph,
// TikTok music note, hashtag for trends). Sourced from simpleicons.org
// public-domain paths, single-color (fill: currentColor) so the chip's CSS
// color: <brand> tint paints them. SourceMark component below picks SVG
// when available, falls back to SOURCE_ICONS letter-marks otherwise.
const SOURCE_LOGOS = {
  reddit: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.499.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12.5c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12c-.69 0-1.25.56-1.25 1.25 0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>',
  google_trends: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
  twitter: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.1z"/></svg>',
  x_trends: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.41 21l.71-4H2.41l.36-2h3.71l1.06-6H3.83l.36-2h3.71l.71-4h2l-.71 4h6l.71-4h2l-.71 4h3.71l-.36 2h-3.71l-1.06 6h3.71l-.36 2h-3.71l-.71 4h-2l.71-4h-6l-.71 4h-2zM9.53 9l-1.06 6h6l1.06-6h-6z"/></svg>'
};

// Letter-mark fallbacks for inline text contexts (top-narratives meta,
// telegram keyboard rendering, Markov contexts). Brand-coded but
// single-character so they don't blow up the line-height. Used wherever
// SourceMark isn't appropriate (or for unknown sources).
const SOURCE_ICONS  = { reddit: 'R', google_trends: 'G', twitter: '𝕏', tiktok: '♪', x_trends: '#' };
const SOURCE_LABELS = { reddit: 'Reddit', google_trends: 'Google', twitter: 'Twitter/X', tiktok: 'TikTok', x_trends: 'X Trends' };
const CAT_ICONS     = { meme:'😂', celebrity:'⭐', animals:'🐾', tech:'💻', gambling:'🎰', sports:'🏆', politics:'🏛️', entertainment:'🎬', gaming:'🎮', boring:'😴', other:'📌' };
const CAT_CLS       = { meme:'cat-meme', celebrity:'cat-celebrity', animals:'cat-animals', tech:'cat-tech', gambling:'cat-gambling', sports:'cat-sports', politics:'cat-politics', entertainment:'cat-entertainment', gaming:'cat-gaming', boring:'cat-boring', other:'cat-other' };

// Subject-name highlight helper. trend.subjectAliases is a sorted list
// (longest-first) of name variants pre-computed by collectSubjectNames in
// src/analysis/subject-names.js. Renders the input string as plain text
// chunks plus span.subject-hl nodes for each alias hit. Returns either the
// original string (no aliases / no matches) or an array of React children
// safe to drop into any text container.
//
// Note: NO backticks in this comment block — outer SPA template literal
// would close prematurely and eat the rest of the script. Keep all examples
// in plain prose. (Trap #1 in SESSION_CONTEXT.)
const _SUBJ_RE_CACHE = new WeakMap();
function _subjRegexFor(aliases) {
  if (!Array.isArray(aliases) || aliases.length === 0) return null;
  const cached = _SUBJ_RE_CACHE.get(aliases);
  if (cached) return cached;
  // NOTE: regex char class deliberately avoids the dollar-curly substring —
  // this is inside the outer SPA template literal, and dollar-curly...curly
  // would be eaten by it as an interpolation slot. Same trap as Trap #2 in
  // SESSION_CONTEXT — keep dollar at the end of the set, never adjacent to
  // an opening curly brace.
  const escaped = aliases
    .filter(a => typeof a === 'string' && a.length >= 2)
    .map(a => a.replace(/[.*+?^()|{}[\]\\$]/g, String.fromCharCode(92) + '$&'));
  if (escaped.length === 0) return null;
  const re = new RegExp(String.fromCharCode(92) + 'b(' + escaped.join('|') + ')' + String.fromCharCode(92) + 'b', 'gi');
  _SUBJ_RE_CACHE.set(aliases, re);
  return re;
}
function withSubjectHighlight(text, aliases) {
  if (!text || typeof text !== 'string') return text;
  const re = _subjRegexFor(aliases);
  if (!re) return text;
  re.lastIndex = 0;
  const out = [];
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span', { className: 'subject-hl', key: 'sh-' + (key++) }, m[0]));
    last = m.index + m[0].length;
    // Defensive: avoid infinite loops on zero-length matches (shouldn't
    // happen with \b alternations, but cheap insurance).
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Lifespan key → i18n token. Built from LIFESPAN_VALUES injected by the
// server (see src/analysis/lifespan.js). Renaming a value there triggers
// loud failures upstream (i18n assertCoversLifespans + scorer normalize)
// rather than silent '—' here.
const LIFESPAN_KEYS = LIFESPAN_VALUES.reduce(
  (m, k) => { m[k] = 'lifespan.' + k; return m; },
  { unknown: 'lifespan.unknown' }
);
function lifespanLabel(k) {
  const key = LIFESPAN_KEYS[k];
  return key ? t(key) : '—';
}

// Source link labels
const SOURCE_LINK_LABELS = { reddit: '🟠 Reddit', twitter: '𝕏 Twitter', tiktok: '🎵 TikTok', google_trends: '🔍 Google', x_trends: '📈 X Trends' };

// ── Phase constants ──────────────────────────────────────────────────────────
// hint resolves via t() — call phaseHint(phase) when you need the localized text.
const PHASE_META = {
  early:     { label: 'EARLY',     color: '#71767b', bg: 'rgba(255,255,255,0.04)', hintKey: 'phase.early.hint' },
  forming:   { label: 'FORMING',   color: '#e7e9ea', bg: 'rgba(255,255,255,0.06)', hintKey: 'phase.forming.hint' },
  strong:    { label: 'STRONG',    color: '#4ade80', bg: 'rgba(74,222,128,0.10)',  hintKey: 'phase.strong.hint' },
  saturated: { label: 'SATURATED', color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  hintKey: 'phase.saturated.hint' },
};
function phaseHint(p) { const m = PHASE_META[p]; return m ? t(m.hintKey) : ''; }
const PHASE_DOT = { early: '🔵', forming: '🟡', strong: '🟢', saturated: '🔴' };

// ── Helpers ──────────────────────────────────────────────────────────────────
function memeClass(v) {
  if (v >= 80) return 'hot';
  if (v >= 60) return 'warm';
  if (v >= 40) return 'ok';
  return 'cold';
}
function memeColor(v) {
  if (v >= 80) return 'linear-gradient(90deg, #ff7675, #d63031)';
  if (v >= 60) return 'linear-gradient(90deg, #e17055, #fab1a0)';
  if (v >= 40) return 'linear-gradient(90deg, #fdcb6e, #ffeaa7)';
  return '#333348';
}
// Bar color for emergence/adoption/meme scores. Unified on --accent —
// score LEVEL is communicated via bar-fill LENGTH, not color (no more
// red/yellow/green "светофор"). Single token; theme-aware.
function barColor(_v) {
  return 'var(--accent)';
}
function fmtVelocity(v) {
  if (!v || v === 0) return null;
  const unit = CURRENT_LANG === 'ru' ? '/ч' : '/h';
  return v.toFixed(1) + unit + ' ↑';
}
function fmtTime(iso) {
  if (!iso) return '—';
  // SQLite CURRENT_TIMESTAMP → "YYYY-MM-DD HH:MM:SS" (no timezone).
  // Without explicit 'Z', browsers parse it as LOCAL time → wrong diff.
  // Force UTC by appending Z (server always stores UTC).
  const normalised = (iso.includes('Z') || iso.includes('+'))
    ? iso
    : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalised);
  const now = new Date();
  const diff = Math.floor((now - d) / 60000); // minutes
  if (isNaN(diff) || diff < 0) return '—';
  if (diff < 1)    return t('time.just_now');
  if (diff < 60)   return t('time.min_ago', { n: diff });
  if (diff < 1440) {
    const hr = Math.floor(diff / 60);
    const m  = diff % 60;
    return m > 0 ? t('time.hours_min_ago', { h: hr, m }) : t('time.hours_ago', { h: hr });
  }
  if (diff < 10080) return t('time.days_ago', { d: Math.floor(diff / 1440) });
  return d.toLocaleDateString(localeTag(), { day: '2-digit', month: '2-digit' });
}

// ── Components ───────────────────────────────────────────────────────────────

function StatCard({ icon, value, suffix, label, sub }) {
  return h('div', { className: 'stat-card' },
    h('div', { className: 'stat-icon' }, icon),
    h('div', { className: 'stat-val' }, value, suffix ? h('span', null, suffix) : null),
    h('div', { className: 'stat-lbl' }, label),
    sub ? h('div', { className: 'stat-sub' }, sub) : null
  );
}

// Legacy — kept for backward compat (modal uses it)
function MemeScore({ value }) {
  return h(ScoreBar, { value, label: null });
}

// Generic score bar used for both emergence and adoption
function ScoreBar({ value, label, sub, color }) {
  const fill = color || barColor(value);
  return h('div', { className: 'score-bar-wrap', title: label ? label + ': ' + value : value },
    h('div', { className: 'score-bar-row' },
      label ? h('span', { className: 'score-bar-label' }, label) : null,
      h('div', { className: 'score-bar-track' },
        h('div', { className: 'score-bar-fill', style: { width: Math.min(value, 100) + '%', background: fill } })
      ),
      h('span', { className: 'score-bar-num', style: { color: fill } }, value),
    ),
    sub ? h('div', { className: 'score-bar-sub' }, sub) : null
  );
}

// SourceMark — renders a real brand SVG logo inside any chip-style icon
// container (.source-icon, .feed-avatar, etc). Falls back to the
// SOURCE_ICONS letter-mark when the source has no SVG, and to a generic
// '·' when the source is unknown.
function SourceMark({ src, fallback }) {
  const svg = SOURCE_LOGOS[src];
  if (svg) {
    return h('span', {
      className: 'src-mark-svg',
      'aria-hidden': 'true',
      dangerouslySetInnerHTML: { __html: svg }
    });
  }
  return h('span', { className: 'src-mark-text' }, SOURCE_ICONS[src] || fallback || '·');
}

// Custom category dropdown — replaces native <select> in the sidebar.
// Native UA dropdown is essentially unstyleable on chromium (the open
// list is browser-painted, ignores select { ... } CSS), so we render a
// fully custom panel: trigger button + animated panel of buttons.
// Click-outside / Esc / option-click close it. Active option shows
// accent left-border + check mark. Used in the sidebar filter group.
function CategoryDropdown({ value, onChange, categories }) {
  useLang();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev) => {
      if (ref.current && !ref.current.contains(ev.target)) setOpen(false);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const cur = value || '';
  const curIcon = cur ? (CAT_ICONS[cur] || '🏷️') : '◆';
  const curLabel = cur ? cur : t('sidebar.all_categories');
  const isPlaceholder = !cur;

  return h('div', { className: 'cat-dd' + (open ? ' open' : ''), ref },
    h('button', {
      type: 'button',
      className: 'cat-dd-trigger' + (cur ? ' has-value' : ''),
      onClick: () => setOpen(o => !o),
      'aria-expanded': open ? 'true' : 'false',
      'aria-haspopup': 'listbox'
    },
      h('span', { className: 'cat-dd-trigger-ico' }, curIcon),
      h('span', {
        className: 'cat-dd-trigger-label' + (isPlaceholder ? ' is-placeholder' : '')
      }, curLabel),
      h('span', { className: 'cat-dd-caret' }, '▴')
    ),
    open ? h('div', { className: 'cat-dd-panel', role: 'listbox' },
      // "All" reset row
      h('button', {
        key: '_all',
        type: 'button',
        className: 'cat-dd-opt' + (cur === '' ? ' active' : ''),
        onClick: () => { onChange(''); setOpen(false); }
      },
        h('span', { className: 'cat-dd-opt-ico' }, '◆'),
        h('span', { className: 'cat-dd-opt-label' }, t('sidebar.all_categories')),
        cur === '' ? h('span', { className: 'cat-dd-opt-check' }, '✓') : null
      ),
      h('div', { className: 'cat-dd-divider' }),
      // Concrete categories
      categories.map(c => h('button', {
        key: c,
        type: 'button',
        className: 'cat-dd-opt cat-dd-opt-' + c + (cur === c ? ' active' : ''),
        onClick: () => { onChange(c); setOpen(false); }
      },
        h('span', { className: 'cat-dd-opt-ico' }, CAT_ICONS[c] || '🏷️'),
        h('span', { className: 'cat-dd-opt-label' }, c),
        cur === c ? h('span', { className: 'cat-dd-opt-check' }, '✓') : null
      ))
    ) : null
  );
}

// Phase badge shown in card header
function PhaseBadge({ phase }) {
  useLang();
  if (!phase) return null;
  const m = PHASE_META[phase] || PHASE_META.early;
  return h('span', {
    className: 'phase-badge',
    style: { background: m.bg, color: m.color, border: '1px solid ' + m.color },
    title: phaseHint(phase)
  }, PHASE_DOT[phase] + ' ' + m.label);
}

// [MARKET_STAGE] badge — remove component + call in TrendCard to disable UI
const MARKET_STAGE_UI = {
  tokenizing: { icon: '🔄', label: 'TOKENIZING', color: '#F59E0B', bg: 'rgba(245,158,11,0.12)', hintKey: 'market.tokenizing.hint' },
  live:       { icon: '🟢', label: 'LIVE',       color: '#10B981', bg: 'rgba(16,185,129,0.12)', hintKey: 'market.live.hint' },
  overheated: { icon: '🔴', label: 'OVERHEATED', color: '#EF4444', bg: 'rgba(239,68,68,0.12)',  hintKey: 'market.overheated.hint' },
};
function marketStageHint(stage) { const m = MARKET_STAGE_UI[stage]; return m ? t(m.hintKey) : ''; }
function MarketStageBadge({ stage }) {
  useLang();
  if (!stage || stage === 'none') return null;
  const m = MARKET_STAGE_UI[stage];
  if (!m) return null;
  return h('span', {
    className: 'phase-badge',
    style: { background: m.bg, color: m.color, border: '1px solid ' + m.color },
    title: marketStageHint(stage)
  }, m.icon + ' ' + m.label);
}

// ── ImageThumb (legacy — still used in modal-equivalent contexts) ────────────
function ImageThumb({ trend, size = 80 }) {
  const [imgUrl, setImgUrl] = useState(trend.imageUrl || null);
  const [tried, setTried] = useState(!!trend.imageUrl);
  const srcIco = SOURCE_ICONS[trend.source] || '📡';

  useEffect(() => {
    if (!tried && !imgUrl && trend.url) {
      setTried(true);
      // api() attaches Bearer auth — raw fetch 401's against the auth gate.
      api('/preview?url=' + encodeURIComponent(trend.url))
        .then(d => { if (d.imageUrl) setImgUrl(d.imageUrl); })
        .catch(() => {});
    }
  }, [trend.url]);

  return h('div', { className: 'card-image-wrap', style: { width: size, height: size } },
    imgUrl
      ? h('img', {
          src: imgUrl, alt: '',
          onError: () => setImgUrl(null),
          loading: 'lazy',
        })
      : h('div', { className: 'card-image-placeholder' }, srcIco)
  );
}

// ── Persist <video> volume/mute across all players via localStorage ─────────
// Pass this function as the ref prop of a video element. On mount we apply
// the stored volume/muted, and on every volumechange we write back, so the
// next video the user opens starts at the same level.
const VIDEO_VOLUME_KEY = 'catalyst_video_volume';
const VIDEO_MUTED_KEY  = 'catalyst_video_muted';
function videoVolumeRef(el) {
  if (!el || el.__volumeHooked) return;
  el.__volumeHooked = true;
  try {
    const v = parseFloat(localStorage.getItem(VIDEO_VOLUME_KEY));
    if (!isNaN(v) && v >= 0 && v <= 1) el.volume = v;
    const m = localStorage.getItem(VIDEO_MUTED_KEY);
    if (m === '1') el.muted = true;
  } catch {}
  el.addEventListener('volumechange', () => {
    try {
      localStorage.setItem(VIDEO_VOLUME_KEY, String(el.volume));
      localStorage.setItem(VIDEO_MUTED_KEY,  el.muted ? '1' : '0');
    } catch {}
  });
}

// ── Lightbox — fullscreen image viewer ──────────────────────────────────────
// Mounted into document.body via a portal so its z-index sits above the trend
// modal. Closes on click anywhere (overlay or image), the close button, or Esc.
function Lightbox({ src, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // Capture phase so we beat the modal's own Escape handler.
    window.addEventListener('keydown', onKey, true);
    // Lock body scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  if (!src) return null;
  const handleClick = (e) => { e.stopPropagation(); onClose(); };
  return ReactDOM.createPortal(
    h('div', { className: 'img-lightbox-overlay', onClick: handleClick },
      h('button', {
        className: 'img-lightbox-close',
        onClick: handleClick,
        'aria-label': 'Close',
        type: 'button',
      }, '×'),
      h('img', {
        className: 'img-lightbox-img',
        src,
        alt: '',
        onClick: handleClick,
      })
    ),
    document.body
  );
}

// ── TweetHoverPreview — inline tweet card on link hover ─────────────────────
// Trading-terminal style: hovering a tweet link shows the tweet inline so the
// user doesn't context-switch to X. Backed by /api/tweet-preview which fetches
// from fxtwitter (5-min cache).
//
// Lifecycle owned by useTweetHover hook below — this is a dumb renderer.
// Positioning: anchored to the source link's getBoundingClientRect via fixed
// coords, with overflow-flip (if the card would clip the viewport bottom, it
// flips above the link). Width clamped to avoid clipping at the right edge.
function TweetHoverPreview({ state, onMouseEnter, onMouseLeave }) {
  if (!state || !state.anchor) return null;
  const { anchor, data, status } = state;

  // Position: prefer below-and-right of link. If there isn't enough room
  // below, flip ABOVE — and there we use CSS bottom instead of top, so the
  // card grows upward from PAD-px-above the link regardless of its actual
  // rendered height. (Earlier attempt used top = anchor.top - ESTIMATED_H
  // which floated the card too high when the real card was much shorter
  // than the estimate.)
  const PAD = 8;
  const W   = 360;
  // Generous estimate used only to DECIDE which side; positioning itself
  // doesn't depend on this (we use CSS bottom for above-flip).
  const ESTIMATED_H = 600;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.left;
  if (left + W + PAD > vw) left = Math.max(PAD, vw - W - PAD);
  if (left < PAD) left = PAD;

  // Decide side: prefer below if it fits; otherwise flip above when there's
  // any room there at all (anchor.top > PAD). If neither side has full room
  // (very small viewports), still pick the side with more space.
  const spaceBelow = vh - anchor.bottom;
  const spaceAbove = anchor.top;
  const showAbove = spaceBelow < ESTIMATED_H && spaceAbove > spaceBelow;

  // Build positioning style. Below = CSS top from the link's bottom.
  // Above = CSS bottom from the viewport bottom = vh - link.top + PAD.
  // Using CSS bottom makes the card's bottom edge sit PAD above the link,
  // and the card's intrinsic height grows upward from there — no estimate
  // needed (which was the previous bug: estimated height way larger than
  // actual put the card too high).
  //
  // maxHeight clamps the card to the available space on its chosen side so
  // a tall preview doesn't overflow the viewport (the inner .tw-prev-text
  // already has overflow-y: auto, so internal scroll handles long tweets).
  const availableH = (showAbove ? spaceAbove : spaceBelow) - PAD * 2;
  const posStyle = showAbove
    ? {
        left: left + 'px', bottom: (vh - anchor.top + PAD) + 'px',
        width: W + 'px', maxHeight: availableH + 'px',
      }
    : {
        left: left + 'px', top: (anchor.bottom + PAD) + 'px',
        width: W + 'px', maxHeight: availableH + 'px',
      };

  const fmtNum = (n) => {
    if (n == null) return null;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
    return String(n);
  };

  // Body switcher — Twitter and Reddit have different fields. They share
  // the wrapper card chrome (positioning, border, scroll), but the inner
  // header / metrics row look different enough that we render two distinct
  // body shapes routed by state.kind.
  const kind = state.kind || 'tweet';
  let body;
  if (status === 'loading') {
    body = h('div', { className: 'tw-prev-loading' },
      kind === 'reddit' ? '⏳ Загрузка поста...' : '⏳ Загрузка...');
  } else if (status === 'error' || !data) {
    body = h('div', { className: 'tw-prev-error' },
      kind === 'reddit' ? '⚠ Не удалось загрузить пост' : '⚠ Не удалось загрузить твит');
  } else if (kind === 'reddit') {
    const a = data.author || {};
    const m = data.metrics || {};
    const date = data.createdAt
      ? new Date(data.createdAt).toLocaleString('ru-RU', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        })
      : null;
    const photo = (data.media || []).find(x => x.type === 'photo');
    const stopProp = (e) => e.stopPropagation();
    const subUrl  = a.subreddit ? 'https://reddit.com/r/' + a.subreddit : null;
    const userUrl = a.name      ? 'https://reddit.com/u/' + a.name      : null;
    body = [
      h('div', { className: 'tw-prev-head', key: 'head' },
        // Reddit doesn't give us avatars cheaply — use letter-mark fallback
        // showing "r/" prefix to make the platform obvious.
        h('div', { className: 'tw-prev-avatar tw-prev-avatar-fb tw-prev-avatar-reddit' },
          (a.subreddit || '?').charAt(0).toUpperCase()),
        h('div', { className: 'tw-prev-author' },
          subUrl
            ? h('a', {
                className: 'tw-prev-name tw-prev-link',
                href: subUrl, target: '_blank', rel: 'noopener noreferrer',
                onClick: stopProp,
              }, 'r/' + a.subreddit)
            : h('div', { className: 'tw-prev-name' }, 'reddit'),
          userUrl
            ? h('a', {
                className: 'tw-prev-handle tw-prev-link',
                href: userUrl, target: '_blank', rel: 'noopener noreferrer',
                onClick: stopProp,
              }, 'u/' + a.name)
            : h('div', { className: 'tw-prev-handle' }, 'u/' + (a.name || 'unknown'))
        ),
        h('div', { className: 'tw-prev-x tw-prev-x-reddit' }, '🅡')
      ),
      data.title && h('div', { className: 'tw-prev-title', key: 'title' }, data.title),
      data.text && h('div', { className: 'tw-prev-text', key: 'text' }, data.text),
      photo && h('div', { className: 'tw-prev-media', key: 'media' },
        h('img', { src: photo.url, alt: '', loading: 'lazy' })
      ),
      h('div', { className: 'tw-prev-meta', key: 'meta' },
        m.upvotes != null && h('span', null, '⬆ ', fmtNum(m.upvotes)),
        m.comments != null && h('span', null, '💬 ', fmtNum(m.comments)),
        m.awards   ? h('span', null, '🏅 ', fmtNum(m.awards)) : null,
        typeof m.ratio === 'number' && h('span', null, Math.round(m.ratio * 100) + '% ↑'),
        date && h('span', { className: 'tw-prev-date' }, date)
      ),
    ];
  } else {
    // Twitter (kind === 'tweet') — original body, unchanged
    const a = data.author || {};
    const m = data.metrics || {};
    const date = data.createdAt
      ? new Date(data.createdAt).toLocaleString('ru-RU', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        })
      : null;
    const photo = (data.media || []).find(x => x.type === 'photo');
    const video = (data.media || []).find(x => x.type === 'video');
    const profileUrl = a.screenName ? 'https://x.com/' + a.screenName : null;
    const stopProp = (e) => e.stopPropagation();
    body = [
      h('div', { className: 'tw-prev-head', key: 'head' },
        profileUrl
          ? h('a', {
              href: profileUrl, target: '_blank', rel: 'noopener noreferrer',
              onClick: stopProp,
              title: '@' + a.screenName,
            },
              a.avatarUrl
                ? h('img', { className: 'tw-prev-avatar', src: a.avatarUrl, alt: '' })
                : h('div', { className: 'tw-prev-avatar tw-prev-avatar-fb' }, (a.name || '?').charAt(0))
            )
          : (a.avatarUrl
              ? h('img', { className: 'tw-prev-avatar', src: a.avatarUrl, alt: '' })
              : h('div', { className: 'tw-prev-avatar tw-prev-avatar-fb' }, (a.name || '?').charAt(0))),
        h('div', { className: 'tw-prev-author' },
          profileUrl
            ? h('a', {
                className: 'tw-prev-name tw-prev-link',
                href: profileUrl, target: '_blank', rel: 'noopener noreferrer',
                onClick: stopProp,
              }, a.name || '—')
            : h('div', { className: 'tw-prev-name' }, a.name || '—'),
          profileUrl
            ? h('a', {
                className: 'tw-prev-handle tw-prev-link',
                href: profileUrl, target: '_blank', rel: 'noopener noreferrer',
                onClick: stopProp,
              }, '@' + a.screenName)
            : h('div', { className: 'tw-prev-handle' }, '@' + (a.screenName || ''))
        ),
        h('div', { className: 'tw-prev-x' }, '𝕏')
      ),
      data.text && h('div', { className: 'tw-prev-text', key: 'text' }, data.text),
      (photo || video) && h('div', { className: 'tw-prev-media', key: 'media' },
        photo
          ? h('img', { src: photo.url, alt: '', loading: 'lazy' })
          : h('img', { src: video.thumbnail || '', alt: '', loading: 'lazy' }),
        video && h('div', { className: 'tw-prev-play' }, '▶')
      ),
      h('div', { className: 'tw-prev-meta', key: 'meta' },
        m.views    != null && h('span', null, '👁 ', fmtNum(m.views)),
        m.likes    != null && h('span', null, '❤️ ', fmtNum(m.likes)),
        m.retweets != null && h('span', null, '🔁 ', fmtNum(m.retweets)),
        m.replies  != null && h('span', null, '💬 ', fmtNum(m.replies)),
        date && h('span', { className: 'tw-prev-date' }, date)
      ),
    ];
  }

  return ReactDOM.createPortal(
    h('div', {
      className: 'tw-prev-card' + (showAbove ? ' above' : ''),
      style: posStyle,
      onMouseEnter, onMouseLeave,
    }, body),
    document.body
  );
}

// ── useTweetHover — global delegate for tweet-link hover preview ─────────────
// Listens at the document level (single listener, not per-card) and matches
// any anchor whose href has a /status/NNN segment. Debounce = 350ms so
// brushing past links does not fire API calls; grace = 200ms on mouseleave
// so the user can move the cursor INTO the card to interact (links inside
// text, scrolling). The card itself reports onMouseEnter/Leave to keep
// itself open.
//
// Selector tightening: we only care about tweet links inside the feed (.feed)
// and the open modal (.modal-overlay), per spec. Hovers on, e.g., navigation
// links elsewhere in the SPA are ignored.
function useTweetHover() {
  const [state, setState] = useState(null);
  const enterTimerRef = useRef(null);
  const leaveTimerRef = useRef(null);
  const cacheRef      = useRef(new Map());

  const clearLeave = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  };
  const clearEnter = () => {
    if (enterTimerRef.current) {
      clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
  };

  // Track the currently-hovered tweet-id container so we don't pre-fetch on
  // every internal mousemove. mouseover/mouseout bubble through every nested
  // element, but we only care about transitions between different tagged
  // containers (or between tagged ↔ non-tagged).
  const activeIdRef = useRef(null);

  useEffect(() => {
    // Trigger element = anything with [data-tweet-id] OR [data-reddit-id].
    // FeedCard / TrendModal tag the actual link buttons; we read whichever
    // attribute is present and route to the matching endpoint.
    //
    // kind: 'tweet' or 'reddit' — drives endpoint, event name, and which
    // body the hover-card renders.
    const findHost = (target) => {
      if (!target || !target.closest) return null;
      const el = target.closest('[data-tweet-id], [data-reddit-id]');
      if (!el) return null;
      const tweetId  = el.getAttribute('data-tweet-id')  || '';
      const redditId = el.getAttribute('data-reddit-id') || '';
      if (/^\\d+$/.test(tweetId)) {
        return { el, kind: 'tweet', id: tweetId };
      }
      if (/^[a-z0-9]{4,12}$/i.test(redditId)) {
        return { el, kind: 'reddit', id: redditId };
      }
      return null;
    };

    const onOver = (e) => {
      // Per-user toggle (SettingsPanel → Appearance → Hover preview). Read
      // fresh from localStorage so changes apply on the next mouseover with
      // no hook re-mount. Default true preserves existing UX.
      if (readPref('hoverPreview', true) === false) return;
      const hit = findHost(e.target);
      if (!hit) return;
      // Same target as currently active — ignore (mousemove inside the same
      // link would otherwise reset the debounce timer endlessly). Use a
      // composite key so different kinds with same id (impossible in practice
      // but defensive) don't collide.
      const key = hit.kind + ':' + hit.id;
      if (activeIdRef.current === key && state) return;

      activeIdRef.current = key;
      clearLeave();
      clearEnter();
      enterTimerRef.current = setTimeout(async () => {
        const rect = hit.el.getBoundingClientRect();
        const id   = hit.id;
        const kind = hit.kind;

        const cacheKey = kind + ':' + id;
        if (cacheRef.current.has(cacheKey)) {
          setState({ anchor: rect, status: 'ok', data: cacheRef.current.get(cacheKey), kind });
          return;
        }
        setState({ anchor: rect, status: 'loading', data: null, kind });
        try {
          const endpoint = kind === 'reddit' ? '/reddit-preview' : '/tweet-preview';
          const j = await api(endpoint + '?id=' + encodeURIComponent(id));
          // Twitter returns j.tweet, Reddit returns j.post — normalize.
          const payload = kind === 'reddit' ? j?.post : j?.tweet;
          if (j && j.ok && payload) {
            cacheRef.current.set(cacheKey, payload);
            setState({ anchor: rect, status: 'ok', data: payload, kind });
            // Broadcast fresh metrics. Single event name, kind in detail —
            // the App listener routes by kind.
            window.dispatchEvent(new CustomEvent('link-metrics-update', {
              detail: {
                kind, id,
                metrics: payload.metrics || {},
                velocity: typeof j.velocity === 'number' ? j.velocity : null,
              },
            }));
          } else {
            setState({ anchor: rect, status: 'error', data: null, kind });
          }
        } catch {
          setState({ anchor: rect, status: 'error', data: null, kind });
        }
      }, 350);
    };

    const onOut = (e) => {
      const hit = findHost(e.target);
      if (!hit) return;
      const next = e.relatedTarget;
      if (next && hit.el.contains(next)) return;
      activeIdRef.current = null;
      clearEnter();
      leaveTimerRef.current = setTimeout(() => setState(null), 200);
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout',  onOut);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout',  onOut);
      clearEnter();
      clearLeave();
    };
    // state is intentionally NOT a dep — re-binding listeners on every state
    // tick would defeat the single-handler design. We read state via the
    // closure captured at mount; the active-id optimization uses a ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Card-side handlers passed back so the card can keep itself alive while
  // the cursor hovers over it (e.g. user wants to read full text).
  const onCardEnter = () => clearLeave();
  const onCardLeave = () => {
    leaveTimerRef.current = setTimeout(() => setState(null), 150);
  };

  return { state, onCardEnter, onCardLeave };
}

// ── ImageCarousel — horizontal slider for 2+ photos ─────────────────────────
// One image at a time, full width, aspect preserved. Prev/next arrow buttons,
// a small "N/M" counter, and dot pagination. Arrow clicks stop propagation so
// feed cards don't open their modal when the user just wants to flip photos.
// onImageClick(url) — optional. If provided, clicking the image fires it
// (used by TrendModal to open a lightbox). Without it, the image is inert
// (feed-card variant — click bubbles to the card to open the modal).
function ImageCarousel({ urls, variant = 'in-feed', onImageClick = null }) {
  const allUrls = (urls || []).filter(Boolean);
  // Track which slots failed to load — auto-skip them so a broken first
  // image doesn't leave the carousel looking empty/collapsed. Only when ALL
  // images failed do we show nothing.
  const [failed, setFailed] = useState(() => new Set());
  const filtered = allUrls.filter((_, i) => !failed.has(i));
  const [idx, setIdx] = useState(0);
  // Clamp idx if entries got removed (e.g. several errors fired)
  const safeIdx = filtered.length > 0 ? Math.min(idx, filtered.length - 1) : 0;
  if (filtered.length === 0) return null;
  const stop = (e) => { if (e) { e.stopPropagation(); e.preventDefault(); } };
  const go = (delta) => (e) => {
    stop(e);
    setIdx((i) => (i + delta + filtered.length) % filtered.length);
  };
  // Map filtered index back to the original index so onError marks the right slot.
  const visibleUrl = filtered[safeIdx];
  const originalIdx = allUrls.indexOf(visibleUrl);
  const handleImgClick = onImageClick
    ? (e) => { stop(e); onImageClick(visibleUrl); }
    : undefined;
  const children = [
    h('img', {
      key: 'img:' + originalIdx,
      src: visibleUrl, alt: '', loading: 'lazy',
      onClick: handleImgClick,
      onError: () => {
        setFailed(prev => {
          const next = new Set(prev);
          next.add(originalIdx);
          return next;
        });
      },
    }),
  ];
  if (filtered.length > 1) {
    children.push(
      h('button', {
        key: 'prev',
        className: 'img-carousel-nav img-carousel-nav-prev',
        onClick: go(-1),
        'aria-label': 'Previous image',
        type: 'button',
      }, '\u2039'),
      h('button', {
        key: 'next',
        className: 'img-carousel-nav img-carousel-nav-next',
        onClick: go(1),
        'aria-label': 'Next image',
        type: 'button',
      }, '\u203A'),
      h('div', { key: 'counter', className: 'img-carousel-counter' },
        (safeIdx + 1) + ' / ' + filtered.length
      ),
      h('div', { key: 'dots', className: 'img-carousel-dots' },
        filtered.map((_, i) =>
          h('div', {
            key: 'dot' + i,
            className: 'img-carousel-dot' + (i === safeIdx ? ' active' : ''),
          })
        )
      )
    );
  }
  return h('div', { className: 'img-carousel ' + variant }, children);
}

// ── FeedImage — inline image / video for feed cards ──────────────────────────
// When the trend has a videoUrl we render an HTML5 <video> player with the
// image as its poster (so the card still looks the same until the user clicks
// play). Click/drag on the player doesn't bubble up to the card's onClick —
// otherwise pressing play would open the trend modal.
function FeedImage({ trend }) {
  const galleryUrls = Array.isArray(trend.imageUrls) ? trend.imageUrls.filter(Boolean) : [];
  const hasGallery  = galleryUrls.length >= 2;
  const [imgUrl, setImgUrl] = useState(trend.imageUrl || (hasGallery ? galleryUrls[0] : null));
  const [tried,  setTried]  = useState(!!trend.imageUrl || hasGallery);
  const [failed, setFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    if (!tried && !imgUrl && trend.url) {
      setTried(true);
      api('/preview?url=' + encodeURIComponent(trend.url))
        .then(d => { if (d.imageUrl) setImgUrl(d.imageUrl); else setFailed(true); })
        .catch(() => setFailed(true));
    }
  }, [trend.url]);

  const hasVideo = !!trend.videoUrl && !videoFailed;

  // Multi-image gallery (no video) → TG-style tile grid
  if (!hasVideo && hasGallery) {
    return h(ImageCarousel, { urls: galleryUrls, variant: 'in-feed' });
  }

  if (!hasVideo) {
    if (failed || (!imgUrl && tried)) return null;
    if (!imgUrl) return null;
    return h('div', { className: 'feed-image-wrap' },
      h('img', {
        className: 'feed-image',
        src: imgUrl, alt: '',
        onError: () => { setImgUrl(null); setFailed(true); },
        loading: 'lazy',
      })
    );
  }

  // Video branch — inline player with image as poster
  return h('div', {
      className: 'feed-image-wrap feed-video-wrap',
      onClick: e => e.stopPropagation(),  // don't open modal when scrubbing
    },
    h('video', {
      ref: videoVolumeRef,
      className: 'feed-image feed-video',
      src: trend.videoUrl,
      poster: imgUrl || undefined,
      controls: true,
      preload: 'none',
      playsInline: true,
      onError: () => setVideoFailed(true),  // fall back to still image
    })
  );
}

// ── FeedCard — new social-feed-style narrative card ──────────────────────────
// ── Feedback bar (👍 / 👎) — canonical pill style ────────────────────────────
// In the modal variant, the like/dislike buttons are followed by an inline
// "Why this rating?" textarea — only rendered while userVote !== 0. The
// reason text is sent to POST /feedback alongside (or independently of) the
// vote and is later surfaced to the AI scorer as a Liked/Disliked example.
const REASON_MAX = 240;

function FeedbackBar({ trend, variant }) {
  const initial = trend.feedback || { likes: 0, dislikes: 0, userVote: 0, userReason: '' };
  const [likes,    setLikes]    = useState(initial.likes    || 0);
  const [dislikes, setDislikes] = useState(initial.dislikes || 0);
  const [userVote, setUserVote] = useState(initial.userVote || 0);
  const [busy, setBusy] = useState(false);

  // Reason editor state (modal variant only — but kept in this component so
  // the textarea picks up the freshest reason on every prop refresh).
  const [reasonDraft, setReasonDraft] = useState(initial.userReason || '');
  const [savedReason, setSavedReason] = useState(initial.userReason || '');
  const [reasonBusy,  setReasonBusy]  = useState(false);
  const [statusMsg,   setStatusMsg]   = useState('');
  const [statusErr,   setStatusErr]   = useState(false);
  const statusTimerRef = useRef(null);

  // Resync when the trend prop changes (e.g. list refresh / reopen modal)
  useEffect(() => {
    const fb = trend.feedback || { likes: 0, dislikes: 0, userVote: 0, userReason: '' };
    setLikes(fb.likes || 0);
    setDislikes(fb.dislikes || 0);
    setUserVote(fb.userVote || 0);
    // Only reset the draft when the saved reason actually changes — this
    // avoids stomping on a half-typed message if the parent re-renders for
    // an unrelated reason (likes count tick from someone else's vote).
    const incomingReason = fb.userReason || '';
    if (incomingReason !== savedReason) {
      setSavedReason(incomingReason);
      setReasonDraft(incomingReason);
    }
  }, [trend.id, trend.feedback && trend.feedback.likes, trend.feedback && trend.feedback.dislikes, trend.feedback && trend.feedback.userVote, trend.feedback && trend.feedback.userReason]);

  // Surface a status hint for ~2s after a save/clear so the user gets
  // visible confirmation. Cleared on unmount.
  const flashStatus = (msg, isErr = false) => {
    setStatusMsg(msg);
    setStatusErr(isErr);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMsg(''), 2400);
  };
  useEffect(() => () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current); }, []);

  const vote = async (next) => {
    if (busy) return;
    // Optimistic update
    const prev = { likes, dislikes, userVote };
    const willToggleOff = prev.userVote === next;
    const finalVote = willToggleOff ? 0 : next;
    let nextLikes = likes, nextDislikes = dislikes;
    if (prev.userVote === 1) nextLikes = Math.max(0, nextLikes - 1);
    if (prev.userVote === -1) nextDislikes = Math.max(0, nextDislikes - 1);
    if (finalVote === 1) nextLikes += 1;
    if (finalVote === -1) nextDislikes += 1;
    setLikes(nextLikes); setDislikes(nextDislikes); setUserVote(finalVote);
    setBusy(true);
    try {
      const res = await api('/trends/' + trend.id + '/feedback', {
        method: 'POST',
        body: JSON.stringify({ vote: next }),
      });
      setLikes(res.likes || 0);
      setDislikes(res.dislikes || 0);
      setUserVote(res.userVote || 0);
      // Vote-flip / toggle-off wipes the previously saved reason on the
      // server (see db.recordFeedback). Mirror that on the client so the
      // textarea doesn't show stale text. If the server kept it (same-vote
      // re-press is a no-op), the response carries it back unchanged.
      const newReason = res.userReason || '';
      setSavedReason(newReason);
      setReasonDraft(newReason);
      // Keep trend.feedback cache in sync (affects resync on unrelated updates)
      if (trend.feedback) {
        trend.feedback.likes = res.likes || 0;
        trend.feedback.dislikes = res.dislikes || 0;
        trend.feedback.userVote = res.userVote || 0;
        trend.feedback.userReason = newReason;
      }
    } catch (err) {
      // Revert on failure
      setLikes(prev.likes); setDislikes(prev.dislikes); setUserVote(prev.userVote);
    } finally {
      setBusy(false);
    }
  };

  const saveReason = async (textOverride) => {
    if (reasonBusy) return;
    if (userVote === 0) return; // guarded — UI hides the controls anyway
    const raw = (textOverride !== undefined ? textOverride : reasonDraft) || '';
    if (raw.length > REASON_MAX) {
      flashStatus(t('feedback.reason.too_long'), true);
      return;
    }
    setReasonBusy(true);
    try {
      const res = await api('/trends/' + trend.id + '/feedback', {
        method: 'POST',
        // Reason-only update — vote field deliberately omitted so the server
        // keeps the existing vote intact (see _handleTrendFeedback).
        body: JSON.stringify({ reason: raw }),
      });
      const newReason = res.userReason || '';
      setSavedReason(newReason);
      setReasonDraft(newReason);
      if (trend.feedback) trend.feedback.userReason = newReason;
      flashStatus(newReason ? t('feedback.reason.saved') : t('feedback.reason.cleared'));
    } catch (err) {
      flashStatus(t('feedback.reason.error'), true);
    } finally {
      setReasonBusy(false);
    }
  };

  const showReasonEditor = variant === 'modal' && userVote !== 0;
  const draftLen   = (reasonDraft || '').length;
  const isOverCap  = draftLen > REASON_MAX;
  const isDirty    = (reasonDraft || '') !== (savedReason || '');
  const canSave    = isDirty && !isOverCap && !reasonBusy;
  const canClear   = !!savedReason && !reasonBusy;

  return h('div', { className: 'fb-wrap', onClick: e => e.stopPropagation() },
    h('div', {
      className: 'fb-bar' + (variant === 'modal' ? ' fb-bar-modal' : ''),
    },
      h('button', {
        className: 'fb-btn fb-like' + (userVote === 1 ? ' active' : ''),
        onClick: e => { e.stopPropagation(); vote(1); },
        disabled: busy,
        title: userVote === 1 ? t('feedback.unlike') : t('feedback.like')
      },
        h('span', { className: 'fb-ico' }, '👍'),
        h('span', { className: 'fb-count' }, likes)
      ),
      h('button', {
        className: 'fb-btn fb-dislike' + (userVote === -1 ? ' active' : ''),
        onClick: e => { e.stopPropagation(); vote(-1); },
        disabled: busy,
        title: userVote === -1 ? t('feedback.undislike') : t('feedback.dislike')
      },
        h('span', { className: 'fb-ico' }, '👎'),
        h('span', { className: 'fb-count' }, dislikes)
      )
    ),
    showReasonEditor && h('div', { className: 'fb-reason' },
      h('div', { className: 'fb-reason-label' },
        h('span', null, '✏️ ' + t('feedback.reason.label'))
      ),
      h('textarea', {
        className: 'fb-reason-textarea',
        placeholder: t('feedback.reason.placeholder'),
        maxLength: REASON_MAX + 50, // soft cap; server enforces 240
        value: reasonDraft,
        disabled: reasonBusy,
        onChange: e => setReasonDraft(e.target.value),
        onKeyDown: e => {
          // Cmd/Ctrl + Enter saves — common pattern for chat inputs
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
            e.preventDefault();
            saveReason();
          }
        }
      }),
      h('div', { className: 'fb-reason-foot' },
        h('span', {
          className: 'fb-reason-count' + (isOverCap ? ' over' : '')
        }, draftLen + ' / ' + REASON_MAX),
        h('div', { className: 'fb-reason-actions' },
          canClear && h('button', {
            className: 'fb-reason-btn',
            onClick: e => { e.stopPropagation(); setReasonDraft(''); saveReason(''); },
            disabled: reasonBusy,
          }, t('feedback.reason.clear')),
          h('button', {
            className: 'fb-reason-btn primary',
            onClick: e => { e.stopPropagation(); saveReason(); },
            disabled: !canSave,
          }, t('feedback.reason.save'))
        )
      ),
      statusMsg && h('div', {
        className: 'fb-reason-status' + (statusErr ? ' error' : '')
      }, statusMsg)
    )
  );
}

function FeedCard({ trend, onOpen, onHide, onFavToggle, canFavorite }) {
  useLang();
  const catCls = CAT_CLS[trend.category] || 'cat-other';
  const catIco = CAT_ICONS[trend.category] || '📌';
  const srcIco = SOURCE_ICONS[trend.source] || '📡';
  const srcLbl = SOURCE_LABELS[trend.source] || trend.source;
  const linkLabel = SOURCE_LINK_LABELS[trend.source] || t('feed.open_source');

  const phase     = trend.narrativePhase || null;
  const emergence = trend.emergenceScore || 0;
  const meme      = trend.memePotential  || 0;
  const adoption  = trend.adoptionScore  || trend.memePotential || 0;
  const velocity  = trend.velocity       || 0;

  const handle = '@' + (trend.source === 'google_trends' ? 'google'
                    : trend.source === 'twitter' ? 'twitter_x'
                    : trend.source === 'x_trends' ? 'x_trends'
                    : trend.source || 'source');

  // The trigger / AI-explanation text used to render as a long block under
  // the title (.feed-desc). Owner moved it inside the modal — feed cards now
  // surface a compact "🔮 Каталист" badge in the .feed-badges row instead,
  // visible only when a deep Catalyst forecast has been searched (Pro click).
  // Glance-reading the feed is faster and the long forecast text is one click
  // away in the modal's Catalyst section.
  const hasCatalyst = !!(trend.trigger && trend.trigger.text);

  const handleClick = (e) => {
    if (e.target.closest('a') || e.target.closest('button')) return;
    onOpen && onOpen(trend);
  };

  const emergenceColor = barColor(emergence);
  const memeColor      = barColor(meme);
  const adoptionColor  = barColor(adoption);

  const avatarCls = SOURCE_ICONS[trend.source] ? (trend.source) : 'default';

  // meta parts for sub row.
  // Velocity removed from feed cards 2026-05-16 — it cluttered the row and
  // the same number is available in the modal's Metrics section for users
  // who want the per-hour growth rate. Velocity calc/update logic stays
  // intact (modal still consumes trend.velocity).
  const metaParts = [];

  // "Fresh" indicator — trends seen within the last 60 minutes get a tiny
  // pulse dot. Helps the eye lock onto what's actually new during a refresh.
  // Use lastSeen (most recent activity) rather than firstSeen (birth) so a
  // narrative born 8h ago but still being touched right now reads as fresh,
  // matching the window-filter semantics (active-in-window, not born-in-window).
  const recencyTs = trend.lastSeen || trend.firstSeen || '';
  const ageMs = (() => {
    const ts = Date.parse(recencyTs);
    return isNaN(ts) ? Infinity : (Date.now() - ts);
  })();
  const isFresh = ageMs < 60 * 60 * 1000;

  // Hover-preview tags — only the "↗" link itself triggers the popup, not
  // the whole card body (revert per UX request).
  //
  // Source-of-truth: URL pattern, NOT trend.source — collector can vary the
  // source field ('twitter' / 'x' / 'x_trends'). If URL matches the canonical
  // shape, that's the platform.
  //
  // FOUR backslashes — see useTweetHover note. Outer template literal AND
  // browser JS string literal both eat one pair each.
  const _twPreviewId = (() => {
    const re = new RegExp(
      '(?:twitter\\\\.com|x\\\\.com)/[^/]+/status/(\\\\d+)', 'i'
    );
    const m = String(trend.url || '').match(re);
    return m ? m[1] : null;
  })();
  const _redditPreviewId = (() => {
    const re = new RegExp('reddit\\\\.com/.*?/comments/([a-z0-9]{4,12})', 'i');
    const m = String(trend.url || '').match(re);
    return m ? m[1] : null;
  })();

  return h('div', {
    className: 'feed-card' + (isFresh ? ' is-fresh' : ''),
    onClick: handleClick,
  },
    onHide ? h('button', {
      className: 'feed-hide-btn',
      title: t('feed.hide_btn_tip'),
      'aria-label': t('feed.hide_btn_tip'),
      onClick: (e) => { e.stopPropagation(); onHide(trend); }
    }, '✕') : null,
    h('div', { className: 'feed-card-head' },
      h('div', { className: 'feed-avatar ' + avatarCls },
        SOURCE_LOGOS[trend.source] ? h(SourceMark, { src: trend.source }) : srcIco
      ),
      h('div', { className: 'feed-meta' },
        h('div', { className: 'feed-user-row' },
          // ⭐ favorite button — Pro/Admin only. Inline at the start of the
          // user-row (left side, right after the avatar) so it has clear
          // visual space from the ✕ on the far right. Filled when saved,
          // outline otherwise.
          (canFavorite && onFavToggle) ? h('button', {
            className: 'feed-fav-btn' + (trend.isFavorite ? ' saved' : ''),
            title: trend.isFavorite ? t('fav.remove_tooltip') : t('fav.add_tooltip'),
            'aria-label': trend.isFavorite ? t('fav.remove_tooltip') : t('fav.add_tooltip'),
            onClick: (e) => { e.stopPropagation(); onFavToggle(trend, e.currentTarget); }
          }, trend.isFavorite ? '★' : '☆') : null,
          h('span', { className: 'feed-user' }, srcLbl),
          // Handle (e.g. @twitter_x) removed from feed card 2026-05-16 — was
          // synthetic per-source, not the real author handle, and added noise
          // next to the platform label. Variable kept for ref by tools/grep.
          h('span', { className: 'feed-dot' }),
          h('span', { className: 'feed-time' }, fmtTime(recencyTs)),
          // Inline meta-hint (platforms / velocity) — replaced the fake-button
          // in the actions row. Lives next to time so all "factual" bits sit
          // in one place. Hidden when neither signal is interesting.
          metaParts.length
            ? h('span', { className: 'feed-meta-hint' }, metaParts.join(' · '))
            : null,
          h('div', { className: 'feed-badges' },
            isFresh ? h('span', { className: 'badge badge-fresh', title: t('feed.fresh_tip') }, '● ' + t('badge.fresh')) : null,
            trend.manualSubmitted ? h('span', { className: 'badge badge-manual', title: t('feed.manual_tip') }, '🧪 MANUAL') : null,
            // Alert-type chip — first slot so the user instantly sees signal
            // shape. NULL alertType (legacy rows) renders nothing.
            trend.alertType
              ? h('span', { className: 'badge badge-atype badge-atype-' + trend.alertType }, t('badge.alert_type.' + trend.alertType))
              : null,
            phase ? h(PhaseBadge, { phase }) : null,
            h(MarketStageBadge, { stage: trend.marketStage }),
            // Catalyst-found indicator: shown when a deep forward forecast has
            // been searched for this trend (data lives in trend.trigger). One
            // click on the card opens the modal where the full forecast renders.
            hasCatalyst
              ? h('span', { className: 'badge badge-catalyst', title: t('feed.catalyst_tip') }, t('badge.catalyst'))
              : null,
            h('span', { className: 'badge ' + catCls, title: t('feed.category_tip') }, catIco + ' ' + (trend.category || 'other'))
          )
        ),
        h('div', { className: 'feed-title' }, withSubjectHighlight(trend.title, trend.subjectAliases))
        // originalTitle (raw post text in source language) used to render here
        // as a dim italic sub-line. Owner removed it — feed stays compact, the
        // original text is still visible in the modal under the title.
      )
    ),

    h(FeedImage, { trend }),

    // Score strip — Emergence / Meme Score / Adoption.
    // (2026-05-04) Added Meme Score as a third column between the two
    // existing bars. Reads trend.memePotential (raw Stage 1 LLM signal) —
    // same value the modal surfaces at the top, surfaced here at-a-glance
    // so the feed reader does not need to open the modal to see it.
    h('div', { className: 'feed-scores' },
      h('div', { className: 'feed-score' },
        h('div', { className: 'feed-score-top' },
          h('span', { className: 'feed-score-label' }, t('bar.emergence')),
          h('span', { className: 'feed-score-num', style: { color: emergenceColor } }, emergence)
        ),
        h('div', { className: 'feed-score-track' },
          h('div', { className: 'feed-score-fill', style: { width: Math.min(emergence, 100) + '%', background: emergenceColor } })
        )
      ),
      h('div', { className: 'feed-score' },
        h('div', { className: 'feed-score-top' },
          h('span', { className: 'feed-score-label' }, t('modal.meme_score')),
          h('span', { className: 'feed-score-num', style: { color: memeColor } }, meme)
        ),
        h('div', { className: 'feed-score-track' },
          h('div', { className: 'feed-score-fill', style: { width: Math.min(meme, 100) + '%', background: memeColor } })
        )
      ),
      h('div', { className: 'feed-score' },
        h('div', { className: 'feed-score-top' },
          h('span', { className: 'feed-score-label' }, t('bar.adoption')),
          h('span', { className: 'feed-score-num', style: { color: adoptionColor } }, adoption)
        ),
        h('div', { className: 'feed-score-track' },
          h('div', { className: 'feed-score-fill', style: { width: Math.min(adoption, 100) + '%', background: adoptionColor } })
        )
      )
    ),

    // Actions row — left side = primary actions; the meta hints (platforms,
    // velocity) used to be a fake button on the right; they now sit in the
    // upper meta line as a proper chip so this row stays purely actionable.
    h('div', { className: 'feed-actions' },
      h('button', {
        className: 'feed-action-btn primary',
        onClick: e => { e.stopPropagation(); onOpen && onOpen(trend); }
      }, t('feed.details')),
      trend.url ? h('a', {
        className: 'feed-action-btn',
        href: trend.url, target: '_blank', rel: 'noopener',
        onClick: e => e.stopPropagation(),
        // Hover-preview tags: only one of these is set (the URL pattern
        // determines which), and only on Twitter/Reddit URLs. TikTok and
        // others have no tag → no preview popup.
        'data-tweet-id':  _twPreviewId,
        'data-reddit-id': _redditPreviewId,
      }, '↗ ' + linkLabel) : null,
      trend.tgMessageUrl ? h('a', {
        className: 'feed-action-btn tg',
        href: trend.tgMessageUrl, target: '_blank', rel: 'noopener',
        onClick: e => e.stopPropagation()
      }, '📨 TG') : null,
      h(FeedbackBar, { trend })
    )
  );
}

// Backward-compat alias so existing JSX keeps working if any remains
const TrendCard = FeedCard;

// ── RightPanel — AIO Feeds-style column with Top narratives / Live / Sources ─
function RightPanel({ stats, hours, sources, scanning, onOpenTrend }) {
  useLang();
  // Top narratives from server-side stats (real top by adoption for the full window)
  // stats.topTrends is populated by /api/stats — same data as /top in TG bot
  const topTrends = (stats && stats.topTrends ? stats.topTrends : []).slice(0, 10);

  const topCategories = (stats && stats.byCategory ? stats.byCategory : []).slice(0, 5);
  const maxCatCount = topCategories.length ? Math.max(...topCategories.map(c => c.count)) : 1;

  const totalSignals = stats ? stats.total || 0 : 0;
  const totalAlerts  = stats ? stats.alerts || 0 : 0;
  const avgScore     = stats ? stats.avgScore || 0 : 0;
  const paused       = !!(stats && stats.paused);

  // Sources mini-list — active vs disabled. Used to live in the bottom strip
  // (StatusBar) which we removed; now collapses next to Activity here.
  const srcList   = Array.isArray(sources) ? sources : [];
  const activeSrc = srcList.filter(s => s.enabled).length;
  const totalSrc  = srcList.length;
  const srcOk     = totalSrc > 0 && activeSrc === totalSrc;

  return h('div', { className: 'right-panel-sticky' },
   h('div', { className: 'right-panel' },  // inner scroll container via right-panel-inner wrapper below
    h('div', { className: 'right-panel-inner' },

    // ── Top Narratives ──
    h('div', { className: 'right-section' },
      h('div', { className: 'right-section-head' },
        h('span', { className: 'right-section-title' }, t('right.top_narratives')),
        h('span', { className: 'right-section-count' }, t('right.top_suffix', { h: hours, n: topTrends.length }))
      ),
      h('div', { className: 'right-section-body' },
        topTrends.length
          ? topTrends.map((tr, i) => {
              const adoptionVal = tr.adoptionScore || tr.memePotential || 0;
              return h('div', { key: tr.id, className: 'top-item', onClick: () => onOpenTrend && onOpenTrend(tr) },
                h('div', { className: 'top-item-rank' + (i < 3 ? ' top-' + (i + 1) : '') }, i + 1),
                h('div', { className: 'top-item-info' },
                  h('div', { className: 'top-item-title', title: tr.title }, tr.title),
                  h('div', { className: 'top-item-meta' },
                    h('span', null, SOURCE_ICONS[tr.source] || '📡'),
                    tr.narrativePhase ? h('span', null, PHASE_DOT[tr.narrativePhase] + ' ' + (PHASE_META[tr.narrativePhase] || {}).label) : null,
                    h('span', null, (tr.score || tr.virality || 0) + ' ' + t('right.score.vrl'))
                  )
                ),
                h('div', { className: 'top-item-score' }, adoptionVal)
              );
            })
          : h('div', { className: 'empty-feed', style: { padding: '22px 10px' } },
              h('div', { className: 'empty-feed-icon' }, '📭'),
              h('div', { className: 'empty-feed-text' }, t('right.no_signals'))
            )
      )
    ),

    h('div', { className: 'right-sep' }),

    // ── Live activity (formerly "Activity" section + bottom statusbar) ──
    // Title is just "🟢 Live" (or red dot when scanner paused) — replaces the
    // bottom strip we removed. Sources sub-block lives here too: each source
    // shows enabled state via a colored dot, total count in the head.
    h('div', { className: 'right-section' },
      h('div', { className: 'right-section-head' },
        h('span', { className: 'right-section-title' },
          h('span', { className: 'right-live-dot' + (paused ? ' paused' : '') }),
          paused ? t('status.offline') : t('status.live')
        ),
        h('span', { className: 'right-section-count' }, t('right.activity_hours', { h: hours }))
      ),
      h('div', { className: 'right-section-body' },
        h('div', { className: 'activity-grid' },
          h('div', { className: 'activity-cell' },
            h('span', { className: 'activity-label' }, t('right.signals')),
            h('span', { className: 'activity-val accent' }, totalSignals)
          ),
          h('div', { className: 'activity-cell' },
            h('span', { className: 'activity-label' }, t('right.alerts')),
            h('span', { className: 'activity-val orange' }, totalAlerts)
          ),
          h('div', { className: 'activity-cell full' },
            h('span', { className: 'activity-label' }, t('right.avg_virality')),
            h('span', { className: 'activity-val green' }, avgScore, h('span', { style: { fontSize: 11, color: 'var(--dim)', marginLeft: 4 } }, '/100'))
          )
        ),
        // ── Sources sub-block — moved here from the deleted bottom strip ──
        totalSrc > 0 ? h('div', { className: 'right-sources' },
          h('div', { className: 'right-sources-head' },
            h('span', { className: 'right-sources-label' }, t('right.sources_label')),
            h('span', {
              className: 'right-sources-count',
              style: { color: srcOk ? 'var(--green2)' : 'var(--orange)' }
            }, activeSrc + '/' + totalSrc)
          ),
          h('div', { className: 'right-sources-list' },
            srcList.map(s => {
              const locked = s.inPlan === false;
              const labelBase = SOURCE_LABELS[s.source] || s.source;
              const cls = 'right-sources-pill' + (locked ? ' locked' : (s.enabled ? ' on' : ' off'));
              const ttl = locked
                ? labelBase + ' — locked (Test/Pro)'
                : labelBase + (s.enabled ? '' : ' — off');
              return h('span', { key: s.source, className: cls, title: ttl },
                h('span', { className: 'right-sources-dot' }),
                h('span', { className: 'right-sources-glyph' },
                  locked ? '🔒' : (SOURCE_ICONS[s.source] || '📡')
                )
              );
            })
          )
        ) : null
      )
    ),

    // Categories removed — moved to Stats page to keep right panel compact

   ) // right-panel-inner
   ) // right-panel
  );  // right-panel-sticky
}

// ── TriggerSection (TrendModal child) ──────────────────────────────────────
//
// Renders the "Catalyst" forecast block inside the trend modal. Forward-looking
// forecast: what will drive FURTHER growth of the narrative. Two render
// states:
//
//   1. trend.trigger.text present
//      → render the forecast: text + phase/window chips + drivers/risks
//        bullets + sources + confidence. Shared across all users.
//
//   2. nothing yet
//      → render a CTA hint + action button. Pro/admin → fetch on click;
//        free/test → locked. The past-event anchor (whyNow) lives in a
//        separate "🔥 Trigger" block above this section, NOT inside it,
//        so the Catalyst section is purely about the forward forecast.
//
// Local state holds the optimistic-update path: clicking the button sets
// loading=true, fires POST /api/trends/:id/trigger, and on success replaces
// the whole section with the returned payload without remounting the modal.
//
// Module-level CATALYST_CACHE: survives modal close/re-open without waiting
// for the next /api/trends poll. After a successful fetch we mirror the
// payload here, and on every TriggerSection mount we prefer trend.trigger
// from server (authoritative) but fall back to the cache for the current
// session. Cleared on full page reload (acceptable — server already has it).
const CATALYST_CACHE = new Map();

function TriggerSection({ trend, lang, me }) {
  // Initial state priority:
  //   1. trend.trigger from server-side _formatTrend (authoritative, freshest
  //      after the next feed poll completes)
  //   2. CATALYST_CACHE (covers the gap between "click → save → re-open modal"
  //      before the next poll has shipped the field down)
  //   3. null → CTA state
  const initial = trend.trigger || (trend.id != null ? CATALYST_CACHE.get(trend.id) : null) || null;
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Usage counter (only set when server returns one — Test plan, fresh call).
  // Format: { used, cap, left }. Pro/admin: omitted; cache hits: omitted.
  const [usage, setUsage] = useState(null);

  const planName = (me && typeof me === 'object') ? (me.plan || me.plan_name || 'free') : 'free';
  // Catalyst entitlement: -1 unlimited (admin), 0 locked (free), N>0 daily cap.
  // Read from server-shipped me.entitlements.catalyst (single source of truth).
  const catalystCap = (me && me.entitlements && typeof me.entitlements.catalyst === 'number') ? me.entitlements.catalyst : 0;
  const isPro = catalystCap !== 0; // any non-zero entitlement = unlocked

  const onSearch = async () => {
    if (loading) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/trends/' + trend.id + '/trigger', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(AUTH_TOKEN ? { 'Authorization': 'Bearer ' + AUTH_TOKEN } : {}),
        },
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 200 && body && body.text) {
        const payload = {
          text:       body.text,
          sources:    Array.isArray(body.sources) ? body.sources : [],
          confidence: body.confidence | 0,
          phase:      body.phase  || '',
          window:     body.window || '',
          drivers:    Array.isArray(body.drivers) ? body.drivers : [],
          risks:      Array.isArray(body.risks)   ? body.risks   : [],
        };
        setData(payload);
        // Test-plan usage counter (server omits for pro/admin/cache-hit)
        if (body.usage && typeof body.usage.used === 'number') setUsage(body.usage);
        // Mirror in module cache so closing+reopening the modal before the next
        // feed poll still shows the forecast. Server is authoritative — once
        // the next /api/trends poll runs, trend.trigger will overwrite this.
        if (trend.id != null) CATALYST_CACHE.set(trend.id, payload);
      } else if (res.status === 202) {
        setError(t('trigger.in_flight'));
      } else if (res.status === 403 && body.reason === 'cooldown') {
        setError(t('trigger.cooldown', { min: body.minLeft || 1 }));
      } else if (res.status === 403 && body.reason === 'daily_limit') {
        setError(t('trigger.daily_limit', { cap: body.cap || '?' }));
      } else if (res.status === 403 && body.reason === 'plan') {
        setError(t('trigger.btn_pro_only'));
      } else if (res.status === 503) {
        setError(t('trigger.disabled'));
      } else {
        setError(t('trigger.error', { err: (body && body.error) || ('HTTP ' + res.status) }));
      }
    } catch (e) {
      setError(t('trigger.error', { err: e.message }));
    } finally {
      setLoading(false);
    }
  };

  // Render-state 1: we have a forecast payload (either pre-loaded from API
  // or just fetched). Always wins over the past-trigger fallback.
  if (data && data.text) {
    const hasChips    = !!(data.phase || data.window);
    const hasDrivers  = Array.isArray(data.drivers) && data.drivers.length > 0;
    const hasRisks    = Array.isArray(data.risks)   && data.risks.length   > 0;
    // hasSources removed 2026-05-04 — Catalyst forecast was returning low-quality
    // X handles (random low-signal accounts). The Sources block is no longer
    // rendered. The field is still populated in the API payload for API
    // consumers, just hidden from the UI.
    const hasConfidence = typeof data.confidence === 'number' && data.confidence > 0;
    return h('div', { className: 'modal-section' },
      h('div', { className: 'modal-section-label' }, t('trigger.label')),
      h('div', { className: 'modal-section-content catalyst-forecast' }, data.text),
      hasChips
        ? h('div', { className: 'catalyst-chips' },
            data.phase
              ? h('span', { className: 'catalyst-chip catalyst-chip-phase phase-' + data.phase },
                  h('span', { className: 'catalyst-chip-label' }, t('trigger.phase_label')),
                  h('span', { className: 'catalyst-chip-val' }, t('trigger.phase.' + data.phase) || data.phase))
              : null,
            data.window
              ? h('span', { className: 'catalyst-chip catalyst-chip-window' },
                  h('span', { className: 'catalyst-chip-label' }, t('trigger.window_label')),
                  h('span', { className: 'catalyst-chip-val' }, data.window))
              : null,
          )
        : null,
      hasDrivers
        ? h('div', { className: 'catalyst-bullets catalyst-drivers' },
            h('div', { className: 'catalyst-bullets-head' }, t('trigger.drivers_label')),
            h('ul', { className: 'catalyst-bullets-list' },
              data.drivers.map((b, i) => h('li', { key: 'd' + i }, b))),
          )
        : null,
      hasRisks
        ? h('div', { className: 'catalyst-bullets catalyst-risks' },
            h('div', { className: 'catalyst-bullets-head' }, t('trigger.risks_label')),
            h('ul', { className: 'catalyst-bullets-list' },
              data.risks.map((b, i) => h('li', { key: 'r' + i }, b))),
          )
        : null,
      // (2026-05-04) Sources block removed — Catalyst's source list was
      // surfacing low-signal X handles. Forecast text + drivers + risks are
      // the useful parts; sources just added noise to the modal.
      hasConfidence
        ? h('div', { className: 'catalyst-confidence' },
            h('span', { className: 'catalyst-confidence-label' }, t('trigger.confidence_label')),
            h('div', { className: 'catalyst-confidence-bar' },
              h('div', {
                className: 'catalyst-confidence-fill conf-' + (data.confidence >= 70 ? 'high' : data.confidence >= 40 ? 'mid' : 'low'),
                style: { width: data.confidence + '%' },
              })
            ),
            h('span', { className: 'catalyst-confidence-val' }, data.confidence + '%'),
          )
        : null,
      // Usage counter (Test plan only). Tiny line, dim color, after content.
      usage
        ? h('div', {
            style: { marginTop: 10, fontSize: 11, color: 'var(--muted, #71767b)' }
          }, t('usage.test_left', { used: usage.used, cap: usage.cap, left: usage.left }))
        : null,
    );
  }

  // Render-state 2: no forecast yet. Just the section label + action button
  // (or locked state for non-pro). The hint text was removed 2026-05-04 —
  // the "Найти Каталиста" / "Find Catalyst" button copy is self-explanatory
  // and the empty state read better without an extra description line.
  // whyNow is NOT rendered here — it has its own "🔥 Trigger" section
  // above in the modal. Semantics: 🔥 = past, 🔮 = future.
  return h('div', { className: 'modal-section' },
    h('div', { className: 'modal-section-label' }, t('trigger.label')),

    h('div', { style: { marginTop: 10 } },
      isPro
        ? h('button', {
            className: 'btn btn-primary',
            disabled: loading,
            onClick: onSearch,
            style: { padding: '8px 14px', borderRadius: 8, cursor: loading ? 'wait' : 'pointer' },
          }, loading ? t('trigger.btn_loading') : t('trigger.btn'))
        // Locked card for Free — small icon-tile + two-line text. Reads like
        // a content row, not a dimmed-out button. Still inert on click; the
        // upgrade-flow already lives in /menu / Account.
        : h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 14px',
              background: 'rgba(239,243,244,0.025)',
              border: '1px solid var(--border, rgba(239,243,244,0.08))',
              borderRadius: 10,
            }
          },
            h('div', {
              style: {
                width: 36, height: 36, borderRadius: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(var(--accent-rgb), 0.08)',
                border: '1px solid rgba(var(--accent-rgb), 0.18)',
                fontSize: 16, lineHeight: 1, flexShrink: 0,
              }
            }, '🔒'),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', {
                style: { fontSize: 13, fontWeight: 600, color: 'var(--text, #e7e9ea)' }
              }, t('trigger.locked_title')),
              h('div', {
                style: { fontSize: 11, color: 'var(--muted, #71767b)', marginTop: 2 }
              }, t('trigger.locked_desc'))
            )
          ),
    ),
    error ? h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--accent2, #f55)' } }, error) : null,
  );
}

// ── Favorite note editor — inline collapsible block in TrendModal ─────────
// Three states: (1) no note → "Add note" button; (2) note set → render
// text + ✏ edit + ✕ remove; (3) editing → textarea + Save/Cancel.
function FavoriteNoteEditor({ trend, onSave }) {
  useLang(); // re-render on lang switch
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trend.favoriteNote || '');
  const note = trend.favoriteNote;

  // Reset draft when modal opens for a different trend (or note changes from
  // server) so we don't leak stale text from a previous edit session.
  useEffect(() => { setDraft(note || ''); setEditing(false); }, [trend.id, note]);

  const commit = () => {
    onSave && onSave(trend, draft.trim());
    setEditing(false);
  };
  const cancel = () => { setDraft(note || ''); setEditing(false); };

  if (editing) {
    return h('div', { className: 'fav-note-block' },
      h('textarea', {
        className: 'fav-note-textarea',
        value: draft,
        autoFocus: true,
        maxLength: 500,
        placeholder: t('fav.note_placeholder'),
        onChange: e => setDraft(e.target.value.slice(0, 500)),
        onKeyDown: e => {
          if (e.key === 'Escape') cancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
        },
      }),
      h('div', { className: 'fav-note-controls' },
        h('button', { className: 'btn btn-primary', onClick: commit }, t('fav.note_save')),
        h('button', { className: 'btn', onClick: cancel }, t('fav.note_cancel'))
      )
    );
  }

  if (!note) {
    return h('div', { className: 'fav-note-block' },
      h('button', {
        className: 'fav-note-act',
        onClick: () => setEditing(true),
        style: { fontSize: 12, padding: '4px 0' },
      }, '✏ ' + t('fav.note_placeholder'))
    );
  }

  return h('div', { className: 'fav-note-block' },
    h('div', { className: 'fav-note-row' },
      h('div', { className: 'fav-note-text' }, note),
      h('div', { className: 'fav-note-actions' },
        h('button', { className: 'fav-note-act', title: t('fav.note_edit'), onClick: () => setEditing(true) }, '✏'),
        h('button', { className: 'fav-note-act', title: t('fav.note_remove'), onClick: () => onSave && onSave(trend, '') }, '✕')
      )
    )
  );
}

// ── Alert score sparkline ──────────────────────────────────────────────────
// Inline SVG renderer, no chart library. Takes the points array from
// /api/trends/:id/alert-history and the effective floor; produces a small
// path with floor reference line, color-coded by pass/fail at last point.
//
// Layout: 240w x 56h. Y axis 0..100 mapped to the 56px height (with 4px
// top/bottom padding so the path doesn"t touch the edges). X axis is
// time-spaced (NOT index-spaced) — gaps are real time, not noise.
function renderAlertSparkline(points, floor, t) {
  const h = React.createElement;
  if (!Array.isArray(points) || points.length < 2) return null;

  const W = 240, H = 56, PAD_Y = 5, PAD_X = 2;
  const innerH = H - PAD_Y * 2;
  const innerW = W - PAD_X * 2;

  const tsToMs = (p) => {
    const v = p && p.ts;
    if (!v) return 0;
    // SQLite TEXT timestamp ("YYYY-MM-DD HH:MM:SS") needs T injected for Date()
    const s = String(v).indexOf('T') >= 0 ? v : String(v).replace(' ', 'T') + 'Z';
    const n = Date.parse(s);
    return Number.isFinite(n) ? n : 0;
  };
  const minMs = tsToMs(points[0]);
  const maxMs = tsToMs(points[points.length - 1]);
  const spanMs = Math.max(1, maxMs - minMs);

  const xy = points.map(p => {
    const ms = tsToMs(p);
    const score = Math.max(0, Math.min(100, Number(p.score) || 0));
    return {
      x: PAD_X + ((ms - minMs) / spanMs) * innerW,
      y: PAD_Y + (1 - score / 100) * innerH,
      score,
      ts: p.ts,
      source: p.source,
    };
  });

  const pathD = xy.map((pt, i) => (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.y.toFixed(1)).join(' ');

  // Floor reference line — only when in 0..100 range
  const floorY = (Number.isFinite(floor) && floor >= 0 && floor <= 100)
    ? PAD_Y + (1 - floor / 100) * innerH : null;

  const last = xy[xy.length - 1];
  const passed = last.score >= (Number(floor) || 0);
  const lineColor = passed ? 'var(--green)' : 'var(--red)';
  const fillColor = passed ? 'rgba(0,186,124,.10)' : 'rgba(244,33,46,.10)';

  // Filled area under the line
  const areaD = pathD
    + ' L' + xy[xy.length - 1].x.toFixed(1) + ',' + (PAD_Y + innerH).toFixed(1)
    + ' L' + xy[0].x.toFixed(1) + ',' + (PAD_Y + innerH).toFixed(1)
    + ' Z';

  // Time delta from first to last point — humanized
  const deltaH = (maxMs - minMs) / 3_600_000;
  const deltaLabel = deltaH < 1
    ? Math.round(deltaH * 60) + 'm'
    : (deltaH < 24 ? deltaH.toFixed(1) + 'h' : Math.round(deltaH / 24) + 'd');

  // Score delta first -> last
  const scoreDelta = xy[xy.length - 1].score - xy[0].score;
  const deltaSign = scoreDelta > 0 ? '+' : '';
  const deltaCls = scoreDelta > 0 ? 'pos' : (scoreDelta < 0 ? 'neg' : 'zero');

  return h('div', { className: 'alert-spark' },
    h('div', { className: 'alert-spark-header' },
      h('span', { className: 'lbl' }, t('modal.alert_spark_label')),
      h('span', { className: 'meta' },
        points.length + ' ' + t('modal.alert_spark_points')
        + ' / ' + deltaLabel + ' / ',
        h('span', { className: 'delta ' + deltaCls },
          deltaSign + scoreDelta.toFixed(0))
      )
    ),
    h('svg', {
      width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
      className: 'alert-spark-svg',
      preserveAspectRatio: 'none',
    },
      // Floor reference line (dashed)
      floorY != null ? h('line', {
        x1: 0, y1: floorY, x2: W, y2: floorY,
        className: 'alert-spark-floor',
      }) : null,
      // Filled area
      h('path', { d: areaD, fill: fillColor, stroke: 'none' }),
      // Score line
      h('path', { d: pathD, fill: 'none', stroke: lineColor, strokeWidth: 1.6 }),
      // Last-point dot
      h('circle', {
        cx: last.x, cy: last.y, r: 2.4,
        fill: lineColor, stroke: 'var(--card)', strokeWidth: 1.5,
      })
    ),
    // Mini-legend: first→last with timestamps (helpful when chart is small)
    h('div', { className: 'alert-spark-legend' },
      h('span', null, fmtSparkTs(xy[0].ts) + ' · ' + xy[0].score),
      h('span', { className: 'arrow' }, '→'),
      h('span', null, fmtSparkTs(last.ts) + ' · ' + last.score)
    )
  );
}

function fmtSparkTs(ts) {
  if (!ts) return '—';
  const s = String(ts).indexOf('T') >= 0 ? ts : String(ts).replace(' ', 'T') + 'Z';
  const d = new Date(s);
  if (!isFinite(d.getTime())) return String(ts).slice(5, 16);
  // Compact: MM-DD HH:MM
  const pad = n => (n < 10 ? '0' : '') + n;
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
    + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ── TrendModal (side drawer) ───────────────────────────────────────────────────
function TrendModal({ trend, onClose, me = null, onFavToggle = null, onFavNote = null }) {
  const lang = useLang();
  const [imgUrl, setImgUrl] = useState(trend.imageUrl || null);
  const [imgLoading, setImgLoading] = useState(!trend.imageUrl && !!trend.url);
  // Extra images pulled lazily from /api/preview (typically quote-tweet media
  // for Twitter trends saved before the quote-media fix). Merged with
  // trend.imageUrls below so the carousel surfaces them even for old rows.
  const [extraUrls, setExtraUrls] = useState([]);
  // Lightbox: when the user clicks an image inside the carousel / single-image
  // wrap, we surface a fullscreen viewer above the modal. Esc closes it (and
  // is stopPropagation"d so the modal stays open).
  const [lightboxSrc, setLightboxSrc] = useState(null);
  // Alert verdict math panel — collapsed by default. The compact header
  // (pass/fail pill + alertType chip) is enough for the "would I be alerted?"
  // question; the full breakdown opens only when the user wants the math.
  const [alertDetailsOpen, setAlertDetailsOpen] = useState(false);
  // Sparkline history (admin-only). Fetched lazily — only when the user
  // opens the math panel, so we don"t hammer the API for everyone clicking
  // around the feed. null = not loaded, [] = loaded but empty (old trend
  // before history feature shipped).
  const [alertHistory, setAlertHistory] = useState(null);
  const [alertHistoryLoading, setAlertHistoryLoading] = useState(false);

  // Admin-only flag — gates internal-mechanics affordances (term-help "?"
  // bubbles, sparkline, math panel, etc). Same pattern as elsewhere in
  // this file (line 8396, 9436). When we open features up to all plans,
  // flip the targeted condition only — leaves this flag for admin-only
  // affordances that stay private.
  const isAdmin = me?.plan === 'admin' || me?.plan_name === 'admin';

  // Tiny "?" bubble with hover tooltip. Renders only for admin and only
  // when text is provided. Pass right=true to anchor the tooltip to the
  // right edge (use when the icon is near the right side of the modal).
  const termHelp = (text, right = false) => {
    if (!isAdmin || !text) return null;
    return React.createElement('span', {
      className: 'term-help' + (right ? ' right' : ''),
      'data-tooltip': text,
      'aria-label': text,
    }, '?');
  };
  const catCls = CAT_CLS[trend.category] || 'cat-other';
  const catIco = CAT_ICONS[trend.category] || '📌';
  const srcIco = SOURCE_ICONS[trend.source] || '📡';
  const srcLbl = SOURCE_LABELS[trend.source] || trend.source;
  const srcLinkCls = trend.source === 'reddit' ? ' trend-link-reddit'
    : (trend.source === 'twitter' || trend.source === 'x_trends') ? ' trend-link-twitter'
    : trend.source === 'tiktok' ? ' trend-link-tiktok' : '';

  useEffect(() => {
    // Missing main image → fetch preview for the og:image / fxtwitter media.
    if (!imgUrl && trend.url) {
      api('/preview?url=' + encodeURIComponent(trend.url))
        .then(d => {
          setImgUrl(d.imageUrl || null);
          if (Array.isArray(d.imageUrls) && d.imageUrls.length) setExtraUrls(d.imageUrls);
          setImgLoading(false);
        })
        .catch(() => setImgLoading(false));
      return;
    }
    // Twitter trend WITH main image → still probe preview to pick up
    // quote-tweet / reply-parent media that the collector didn't capture
    // (old DB rows). Cheap: a single fxtwitter call per modal open.
    if (trend.source === 'twitter' && trend.url) {
      const existing = Array.isArray(trend.imageUrls) ? trend.imageUrls.filter(Boolean) : [];
      if (existing.length < 2) {
        api('/preview?url=' + encodeURIComponent(trend.url))
          .then(d => {
            if (Array.isArray(d.imageUrls) && d.imageUrls.length) setExtraUrls(d.imageUrls);
          })
          .catch(() => {});
      }
    }
  }, []);

  // Close on Escape — but only when lightbox is closed. The lightbox runs its
  // own Escape listener (capture phase) and stops propagation, but we also
  // gate here so the modal can't accidentally close from a stray event when
  // the lightbox is on top.
  useEffect(() => {
    const fn = e => { if (e.key === 'Escape' && !lightboxSrc) onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [lightboxSrc]);

  // Lazy-fetch alert score history when the user opens the math panel.
  // Admin-only (the API gates with 403); we still try the fetch for
  // everyone — non-admin gets 403 and we just never render the sparkline.
  // Fetched once per modal-open; closing/reopening refetches because the
  // state was reset by lightbox unmount.
  useEffect(() => {
    if (!alertDetailsOpen || alertHistory !== null || alertHistoryLoading) return;
    if (!trend?._dbId && !trend?.id) return;
    const id = trend._dbId || trend.id;
    setAlertHistoryLoading(true);
    api('/api/trends/' + id + '/alert-history')
      .then(d => {
        setAlertHistory(Array.isArray(d?.points) ? d.points : []);
        setAlertHistoryLoading(false);
      })
      .catch(() => {
        // 403 (not admin) or 5xx — silent fail, no sparkline rendered
        setAlertHistory([]);
        setAlertHistoryLoading(false);
      });
  }, [alertDetailsOpen]);

  // Sentiment removed from the modal visual (2026-05-04). The field is still
  // populated by Stage 1 and shown elsewhere (Telegram alert, feed card chip),
  // but the modal's metrics grid no longer surfaces it.

  // Hover-preview tags — see FeedCard for rationale. URL-pattern based.
  // Each platform has its own; only one will be set per trend.
  const _twModalPreviewId = (() => {
    const re = new RegExp(
      '(?:twitter\\\\.com|x\\\\.com)/[^/]+/status/(\\\\d+)', 'i'
    );
    const m = String(trend.url || '').match(re);
    return m ? m[1] : null;
  })();
  const _redditModalPreviewId = (() => {
    const re = new RegExp('reddit\\\\.com/.*?/comments/([a-z0-9]{4,12})', 'i');
    const m = String(trend.url || '').match(re);
    return m ? m[1] : null;
  })();

  return h(React.Fragment, null,
   lightboxSrc ? h(Lightbox, { src: lightboxSrc, onClose: () => setLightboxSrc(null) }) : null,
   h('div', { className: 'modal-overlay', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
    h('div', { className: 'modal-drawer' },

      // Head — alertType / category / manual / phase / source / time / close
      // Phase moved here (used to live in its own labelled section). Without
      // its old subtitle hint — the badge color + label is enough signal.
      h('div', { className: 'modal-head' },
        // ⭐ Favorite — Pro/Admin only. Leftmost position so it's the first
        // thing the user sees when the modal opens (and isn't squeezed
        // between badges and ✕).
        (onFavToggle && me && me.entitlements && me.entitlements.favorites) ? h('button', {
          className: 'modal-fav-btn' + (trend.isFavorite ? ' saved' : ''),
          title: trend.isFavorite ? t('fav.remove_tooltip') : t('fav.add_tooltip'),
          'aria-label': trend.isFavorite ? t('fav.remove_tooltip') : t('fav.add_tooltip'),
          onClick: (e) => { onFavToggle(trend, e.currentTarget); }
        }, trend.isFavorite ? '★' : '☆') : null,
        trend.alertType
          ? h('span', { className: 'badge badge-atype badge-atype-' + trend.alertType }, t('badge.alert_type.' + trend.alertType))
          : null,
        h('span', { className: 'badge ' + catCls }, catIco + ' ' + (trend.category || 'other')),
        trend.manualSubmitted ? h('span', { className: 'badge badge-manual', title: t('feed.manual_tip') }, '🧪 MANUAL') : null,
        trend.narrativePhase ? h(PhaseBadge, { phase: trend.narrativePhase }) : null,
        h('div', { className: 'source-chip' }, srcIco, ' ', srcLbl),
        h('span', { className: 'time-cell', style: { fontSize: 11 } }, fmtTime(trend.lastSeen || trend.firstSeen)),
        h('button', { className: 'modal-close', onClick: onClose }, t('app.esc_close'))
      ),
      // Snapshot banner — shown when this trend was reconstructed from the
      // favorite snapshot (live row was deleted from the trends table).
      // Tells the user "you're looking at the saved copy".
      trend.favoriteSnapshotted ? h('div', { className: 'modal-body', style: { paddingTop: 0, paddingBottom: 0 } },
        h('span', { className: 'fav-snapshot-banner' }, '🗄 ' + t('fav.snapshot_hint'))
      ) : null,

      // Body
      h('div', { className: 'modal-body' },

        // ⭐ Favorite note editor — only when this trend is saved AND the
        // user has the entitlement. Sits at the top of the modal body so
        // the user's own context appears before AI-derived content.
        (trend.isFavorite && onFavNote && me && me.entitlements && me.entitlements.favorites)
          ? h(FavoriteNoteEditor, { trend, onSave: onFavNote })
          : null,

        // Meme Score — promoted to the very top above the media with a
        // dedicated "hero" treatment (bigger number, thicker gradient bar,
        // soft accent card). It's the single number users care about most,
        // so it earns visual prominence above the ordinary ScoreBars below.
        (() => {
          const v = trend.memePotential || 0;
          const tier = v >= 80 ? 'hot' : v >= 60 ? 'warm' : v >= 40 ? 'ok' : 'cold';
          const fillColor = barColor(v);
          return h('div', { className: 'modal-section' },
            h('div', { className: 'meme-hero' },
              h('div', { className: 'meme-hero-left' },
                h('div', { className: 'meme-hero-label' },
                  t('modal.meme_score'),
                  termHelp(t('term.meme_score'))
                ),
                h('div', { className: 'meme-hero-num ' + tier },
                  v,
                  h('span', { className: 'meme-hero-num-sub' }, ' / 100')
                )
              ),
              h('div', { className: 'meme-hero-bar' },
                h('div', {
                  className: 'meme-hero-fill',
                  style: {
                    width: Math.min(v, 100) + '%',
                    // Solid accent fill — no more tier gradient. Level via
                    // width, not color (see barColor() comment).
                    background: fillColor,
                  }
                })
              )
            )
          );
        })(),

        // Media — video with image poster if available, otherwise just image
        // (or a carousel when the trend has 2+ photos and no video).
        //
        // Build the merged gallery first — DB imageUrls + preview-sourced
        // extras (quote-tweet / multi-photo media for Twitter), dedupe
        // preserving order. Seed with singular imgUrl in case DB only stored
        // the scalar field. We need the full list even on the video branch
        // so we can surface non-poster images underneath the player.
        (() => {
          const gallery = [];
          const pushUnique = (u) => { if (u && !gallery.includes(u)) gallery.push(u); };
          if (imgUrl) pushUnique(imgUrl);
          if (Array.isArray(trend.imageUrls)) trend.imageUrls.forEach(pushUnique);
          extraUrls.forEach(pushUnique);

          // Loading skeleton: ONLY when nothing is populated yet AND a preview
          // fetch is in flight AND there's no video to render. If the trend
          // already has imageUrls in the DB or extras have arrived, we render
          // them immediately — waiting on preview is pointless and was the
          // source of "images disappear in modal" reports for multi-photo
          // posts where the preview hadn't returned yet on first paint.
          if (imgLoading && gallery.length === 0 && !trend.videoUrl) {
            return h('div', { className: 'modal-image-loading' });
          }

          if (trend.videoUrl) {
            // Video branch — show player primary, then any non-poster images
            // in a secondary carousel below. Without this, posts that combine
            // a video + 1-2 photos lose every image except the poster.
            const auxImgs = gallery.filter(u => u !== imgUrl);
            const player = h('video', {
              ref: videoVolumeRef,
              className: 'modal-image',
              style: { background: '#000' },
              src: trend.videoUrl,
              poster: imgUrl || undefined,
              controls: true,
              preload: 'metadata',
              playsInline: true,
            });
            if (auxImgs.length === 0) {
              return h('div', { className: 'modal-image-wrap' }, player);
            }
            return h('div', null,
              h('div', { className: 'modal-image-wrap' }, player),
              h('div', { className: 'modal-aux-gallery' },
                auxImgs.length >= 2
                  ? h(ImageCarousel, { urls: auxImgs, variant: 'in-modal', onImageClick: setLightboxSrc })
                  : h('div', { className: 'modal-image-wrap' },
                      h('img', {
                        className: 'modal-image',
                        src: auxImgs[0], alt: '', loading: 'lazy',
                        onClick: () => setLightboxSrc(auxImgs[0]),
                        onError: e => { try { e.target.style.opacity = 0; } catch {} },
                      })
                    )
              )
            );
          }

          if (gallery.length >= 2) {
            return h(ImageCarousel, { urls: gallery, variant: 'in-modal', onImageClick: setLightboxSrc });
          }
          if (gallery.length === 1) {
            return h('div', { className: 'modal-image-wrap' },
              h('img', {
                className: 'modal-image',
                src: gallery[0], alt: '',
                onClick: () => setLightboxSrc(gallery[0]),
                onError: () => setImgUrl(null),
                loading: 'lazy',
              })
            );
          }
          return null;
        })(),

        // Title
        h('div', { className: 'modal-title' }, withSubjectHighlight(trend.title, trend.subjectAliases)),

        // Original title
        trend.originalTitle && trend.originalTitle !== trend.title
          ? h('div', { style: { fontSize: 12, color: 'var(--dim)', fontStyle: 'italic' } }, trend.originalTitle)
          : null,

        // 🔥 Trigger — concrete past-event "what happened" from Stage 1 (auto-
        // populated on every trend by the scoring pipeline, no Grok call). This
        // is the factual anchor; replaced the old "AI-объяснение" block which
        // was a vague rationale text. Rendered first so the user reads "what
        // happened" before the forward-looking Catalyst forecast below.
        trend.whyNow ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.trigger')),
          h('div', { className: 'modal-section-content why-now' }, withSubjectHighlight(trend.whyNow, trend.subjectAliases))
        ) : null,

        // 🔮 Catalyst — forward-looking forecast from Grok reasoning + x_search.
        // On-demand: pro/admin click the button to fetch, result shared cache.
        // Empty/CTA state when not yet searched.
        h(TriggerSection, { trend, lang, me }),

        // Actions — moved up for quick access to source/TG/Grok
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.links')),
          h('div', { className: 'modal-actions' },
            trend.url ? h('a', {
              className: 'trend-link' + srcLinkCls,
              href: trend.url, target: '_blank', rel: 'noopener',
              // Hover-preview tags — only one is set per trend (Twitter or
              // Reddit URLs match their respective regex; other sources
              // skip both).
              'data-tweet-id':  _twModalPreviewId,
              'data-reddit-id': _redditModalPreviewId,
            }, t('modal.source_link', { ico: srcIco })) : null,
            trend.tgMessageUrl ? h('a', { className: 'trend-link trend-link-tg', href: trend.tgMessageUrl, target: '_blank', rel: 'noopener' }, t('modal.tg_link')) : null,
            (() => {
              const title = trend.titleEn || trend.original_title || trend.originalTitle || trend.title || '';
              if (!title && !trend.url) return null;
              // Structured prompt — narrative-name + virality reasons + growth
              // catalysts + potential + risks + audience. Each point is a
              // separate question so Grok answers in sections instead of one
              // hand-wave paragraph. Newlines via String.fromCharCode(10) —
              // backslash-n inside the SPA template literal would be eaten by
              // the outer backtick before it reaches the browser (see Trap #2
              // in SESSION_CONTEXT, "Ловушка server.js").
              const NL = String.fromCharCode(10);
              // Grok prompt language is separate from UI lang — user may
              // prefer asking Grok in their native language while keeping
              // the dashboard UI in English. Falls back to UI lang when
              // not explicitly set in Settings → Grok language.
              const grokLang = getGrokLang();
              const sourceLine = trend.url
                ? (grokLang === 'ru' ? 'Источник: ' : 'Source: ') + trend.url
                : '';
              const promptLines = grokLang === 'ru'
                ? [
                    'Проанализируй этот нарратив, используя свежие данные из X (твиты, треды, аккаунты последних 24-48 часов).',
                    '',
                    'Тема: "' + title + '"',
                    sourceLine,
                    '',
                    'Дай ответ строго по пунктам, кратко (1-3 предложения на пункт):',
                    '1. Название — НАЙДИ как уже называют в X за 24-48ч (хэштеги, повторяющиеся фразы). НЕ ПРИДУМЫВАЙ. 2-3 варианта буллетами с источником. Если нет устоявшегося — напиши «нет, чаще описывают как: ...». Минимум один на английском.',
                    '2. Почему сейчас вирален — что зажгло, кто пушит (имена аккаунтов / комьюнити), сколько примерно постов/просмотров.',
                    '3. Почему может вырасти дальше — катализаторы на 24-72 часа (события, релизы, виральные хуки).',
                    '4. Потенциал роста — оценка 1-10 и обоснование одной строкой.',
                    '5. Риски — что может убить тренд раньше времени.',
                    '6. Релевантная аудитория — какие комьюнити/типы аккаунтов это разносят.',
                    '',
                    'Если данных недостаточно — честно скажи "слабый сигнал" по конкретному пункту, не выдумывай.',
                  ]
                : [
                    'Analyse this narrative using fresh X data (tweets, threads, accounts from the last 24-48 hours).',
                    '',
                    'Topic: "' + title + '"',
                    sourceLine,
                    '',
                    'Answer strictly point-by-point, concise (1-3 sentences each):',
                    '1. Name — FIND how it\\u2019s called in X over 24-48h (hashtags, repeating phrases). Do NOT invent. 2-3 bullets with source. If no established name — say so, give short description. At least one in English.',
                    '2. Why it\\u2019s viral right now — what ignited it, who pushes it (account names / communities), rough post/view counts.',
                    '3. Why it could grow further — 24-72h catalysts (events, releases, viral hooks).',
                    '4. Growth potential — 1-10 score with one-line rationale.',
                    '5. Risks — what could kill the trend prematurely.',
                    '6. Relevant audience — which communities/account types are spreading it.',
                    '',
                    'If a point lacks data, honestly say "weak signal" — don\\u2019t fabricate.',
                  ];
              const prompt = promptLines.filter(Boolean).join(NL);
              const grokUrl = 'https://grok.com/?q=' + encodeURIComponent(prompt);
              return h('a', { className: 'trend-link trend-link-grok', href: grokUrl, target: '_blank', rel: 'noopener' }, t('modal.ask_grok'));
            })()
          )
        ),

        // X Trends only — show the source tweets that fed this trend's
        // aggregated engagement signal. Each row is a clickable link with
        // hover-preview (data-tweet-id wires into the global useTweetHover).
        (trend.source === 'x_trends' && Array.isArray(trend.topTweets) && trend.topTweets.length > 0)
          ? h('div', { className: 'modal-section' },
              h('div', { className: 'modal-section-label' },
                t('modal.xtrends_top_tweets', { n: trend.topTweets.length })
              ),
              h('div', { className: 'xtrends-toptweets' },
                trend.topTweets.map((tw, i) => {
                  const fmt = (n) => {
                    if (typeof n !== 'number' || n <= 0) return null;
                    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
                    if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
                    return String(n);
                  };
                  const chips = [
                    { ico: '\u{1F441}',   v: fmt(tw.views) },
                    { ico: '❤️', v: fmt(tw.likes) },
                    { ico: '\u{1F501}',   v: fmt(tw.retweets) },
                    { ico: '\u{1F4AC}',   v: fmt(tw.replies) },
                  ].filter(c => c.v !== null);
                  return h('a', {
                    key: i,
                    className: 'xtrends-toptweet',
                    href: tw.url || '#',
                    target: '_blank',
                    rel: 'noopener',
                    'data-tweet-id': tw.id || null,
                  },
                    h('div', { className: 'xtrends-toptweet-head' },
                      h('span', { className: 'xtrends-toptweet-author' }, tw.author || '@unknown')
                    ),
                    tw.text ? h('div', { className: 'xtrends-toptweet-text' }, tw.text) : null,
                    chips.length ? h('div', { className: 'xtrends-toptweet-engage' },
                      chips.map((c, j) => h('span', { key: j }, c.ico, ' ', c.v))
                    ) : null
                  );
                })
              )
            )
          : null,

        // Feedback
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.feedback')),
          h(FeedbackBar, { trend, variant: 'modal' })
        ),

        // [MARKET_STAGE] market stage line in modal — remove block to disable
        trend.marketStage && trend.marketStage !== 'none' ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.market_stage')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(MarketStageBadge, { stage: trend.marketStage }),
            h('span', { style: { fontSize: 12, color: 'var(--dim)' } },
              marketStageHint(trend.marketStage)
            )
          )
        ) : null,

        // Score bars \u2014 phase label and its hint moved out to the header chip.
        // Story bar always renders even when Stage 2 didn't run (value=0),
        // so the user sees a complete metric set on every card. The story
        // pull-quote below only renders when there's an actual hook text.
        h('div', { className: 'modal-section' },
          h(ScoreBar, { label: t('bar.emergence'), value: trend.emergenceScore || 0 }),
          h('div', { style: { height: 4 } }),
          h(ScoreBar, { label: t('bar.adoption'),  value: trend.adoptionScore || trend.memePotential || 0 }),
          h('div', { style: { height: 4 } }),
          h(ScoreBar, { label: t('bar.story'), value: trend.storyScore || 0 }),
          trend.storyHook
            ? h('div', { className: 'story-hook' },
                h('span', { className: 'story-hook-mark' }, '\u201C'),
                h('span', { className: 'story-hook-text' }, trend.storyHook),
                h('span', { className: 'story-hook-mark right' }, '\u201D')
              )
            : null
        ),

        // Stats grid — metrics at the very bottom.
        // (2026-05-04) Layout simplified: Meme Score promoted to a top
        // ScoreBar (above the media), Sentiment removed from the visual
        // entirely. Three tiles remain in this fixed order:
        //   Virality → Velocity → Lifespan
        // Cross-platform "Platforms" tile was already removed earlier with
        // the cross-source aggregation rip-out.
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.metrics')),
          h('div', { className: 'modal-stats-grid' },
            // Virality cell — per-source engagement metrics
            // (👁 views · ❤️ likes · 💬 comments · 🔁 reposts). Pulls
            // from trend.engagement (server unifies twitter/tiktok/reddit).
            // Falls back to the raw score number when no metrics are available
            // (google_trends, x_trends, manual rows).
            (() => {
              const e = trend.engagement || {};
              const fmtCount = (n) => {
                if (typeof n !== 'number' || n <= 0) return null;
                if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
                if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
                return String(n);
              };
              // Reddit puts upvotes into the views slot — use ⬆️ for clarity.
              const isReddit = trend.source === 'reddit';
              const viewIco = isReddit ? '⬆️' : '👁';
              const items = [
                { ico: viewIco, n: e.views },
                { ico: '❤️', n: e.likes },
                { ico: '💬', n: e.comments },
                { ico: '🔁', n: e.reposts },
              ].filter(it => fmtCount(it.n) !== null);

              return h('div', { className: 'modal-stat' },
                h('div', { className: 'modal-stat-label' },
                  t('modal.virality'),
                  termHelp(t('term.virality'))
                ),
                items.length
                  ? h('div', { className: 'modal-engagement' },
                      items.map((it, i) => h('span', { key: i, className: 'modal-engagement-item' },
                        h('span', { className: 'modal-engagement-ico' }, it.ico),
                        h('span', { className: 'modal-engagement-num' }, fmtCount(it.n))
                      ))
                    )
                  : h('span', { style: { fontFamily: 'JetBrains Mono', fontWeight: 700, color: 'var(--accent2)' } }, trend.score || 0)
              );
            })(),
            // Velocity — growth rate per hour. fmtVelocity returns null when
            // velocity ≤ 0; we render an em-dash so the cell stays balanced.
            // Positive → accent (green), zero → muted. Negative case was
            // removed from the scanner pipeline a week ago.
            (() => {
              const vel = fmtVelocity(trend.velocity || 0);
              return h('div', { className: 'modal-stat' },
                h('div', { className: 'modal-stat-label' },
                  t('modal.velocity'),
                  termHelp(t('term.velocity'))
                ),
                h('span', {
                  style: {
                    fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 700,
                    color: vel ? 'var(--accent)' : 'var(--muted)',
                  }
                }, vel || '—')
              );
            })(),
            // Alert tile — replaces the old "Lifespan" tile (2026-05-06).
            // The alert verdict is the user's primary "should I care?" signal,
            // far more actionable than the AI's lifespan guess. We compute the
            // EFFECTIVE floor (max of user.threshold and admin/preset floor)
            // and compare against alertScore — same arithmetic the gate uses.
            //
            // Color is intentionally only green/red — this is a binary verdict
            // (would the alert have fired or not?), not a continuous score
            // worth gradient-coloring. Em-dash when alertScore is null (older
            // rows or save-only items that never went through Stage 1).
            (() => {
              const score = (trend.alertScore == null) ? null : Number(trend.alertScore);
              const userFloor = Number(me?.threshold) || 0;
              const adminFloor = Number(me?.alertFloor) || 0;
              const floor = Math.max(userFloor, adminFloor);
              const passed = score != null && score >= floor;
              const color = score == null
                ? 'var(--dim)'
                : (passed ? 'var(--accent2)' : '#ff5b6a');
              return h('div', { className: 'modal-stat' },
                h('div', { className: 'modal-stat-label' },
                  t('modal.alert_score'),
                  termHelp(t('term.alert_score'), true)
                ),
                h('span', {
                  style: {
                    fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 700,
                    color,
                  }
                }, score == null
                    ? '—'
                    : (score + ' / ' + floor)
                )
              );
            })()
          )
        ),

        // ── Alert verdict / breakdown — shows the unified alertScore vs the
        // user effective floor PLUS each component contribution. The dash-
        // board per-trend question is "would I have been alerted?", and the
        // formula behind alertScore is non-obvious (memePotential is only 30-
        // 45% of it depending on preset).
        //
        // Layout: compact verdict header (always) + collapsible math panel
        // (toggle button). Header shows pass/fail pill, alertType filter
        // chip, and "show math" button. Expanded panel shows real
        // contributions (meme x weight = +N) instead of raw input values,
        // with junk triggers and floor decomposition. Hidden when alertScore
        // is null (save-only rows that bypassed Stage 1).
        //
        // ADMIN-ONLY: scoring weights, junk triggers, and floor decomposition
        // are internal mechanics — surfacing them to free/test/pro users
        // creates more confusion than insight ("why is my -10 stale penalty
        // missing in this row but not that one?"). Same me.plan==="admin"
        // check pattern used elsewhere in this file (line 8396, 9436).
        (trend.alertScore != null && (me?.plan === 'admin' || me?.plan_name === 'admin')) ? (() => {
          const score = Number(trend.alertScore);
          const userFloor = Number(me?.threshold) || 0;
          const adminFloor = Number(me?.alertFloor) || 0;
          const floor = Math.max(userFloor, adminFloor);
          const passed = score >= floor;
          const breakdown = trend.alertBreakdown || null;
          const userTypes = Array.isArray(me?.alertTypes) ? me.alertTypes : null;
          const trendType = trend.alertType || null;
          // alertType muted iff the user has an explicit filter AND it
          // doesnt include this trend type. Empty/missing filter -> "all"
          // (server-side in db.getUserAlertTypes), so trendTypeMuted=false.
          const trendTypeMuted = trendType && Array.isArray(userTypes)
            && userTypes.length > 0 && !userTypes.includes(trendType);

          // Math helpers — same fmt1 the admin Math panel uses, kept inline
          // so this section stays self-contained.
          const fmt1 = (n) => {
            const x = Number(n);
            if (!isFinite(x)) return '—';
            return (Math.round(x * 10) / 10).toString();
          };
          const w = (breakdown && breakdown.weights) || null;

          // Positive rows — drive the contribution column off the saved
          // weight snapshot. When weights are missing (older decisions),
          // calc column falls back to raw input only.
          const posRows = breakdown ? [
            { label: t('modal.alert_breakdown_meme'),     val: breakdown.meme,      weight: w && w.weightMemePotential, tooltip: t('term.meme_score') },
            { label: t('modal.alert_breakdown_viral'),    val: breakdown.viral,     weight: w && w.weightVirality,      tooltip: t('term.virality') },
            { label: t('modal.alert_breakdown_emerge'),   val: breakdown.emergence, weight: w && w.weightEmergence,     tooltip: t('term.emergence') },
            { label: t('modal.alert_breakdown_twitter'),  val: breakdown.twitter,   weight: w && w.weightTwitter },
            { label: t('modal.alert_breakdown_feedback'), val: breakdown.feedback,  weight: w && w.weightFeedback,      tooltip: t('term.feedback') },
          ] : [];

          const junkVal = breakdown ? (Number(breakdown.junk) || 0) : 0;
          const staleVal = breakdown ? (Number(breakdown.staleDecay) || 0) : 0;
          const junkContrib = junkVal * (Number(w && w.weightJunk) || 0);

          return h('div', { className: 'modal-section' },
            h('div', { className: 'modal-section-label' }, t('modal.alert_breakdown')),
            // Compact verdict header — always visible
            h('div', { className: 'alert-verdict-header' },
              h('span', {
                className: 'alert-verdict-pill ' + (passed ? 'pass' : 'fail'),
              }, (passed ? '✓ ' : '✕ ') + score + ' / ' + floor + ' · '
                 + (passed ? t('modal.alert_pass') : t('modal.alert_fail'))),
              trendType ? h('span', {
                className: 'alert-type-chip ' + (trendTypeMuted ? 'muted' : 'ok'),
              }, trendType + ' · ' + (trendTypeMuted
                ? t('modal.alert_type_muted')
                : t('modal.alert_type_in_filter'))) : null,
              breakdown ? h('button', {
                className: 'alert-details-btn' + (alertDetailsOpen ? ' open' : ''),
                onClick: () => setAlertDetailsOpen(v => !v),
                'aria-expanded': alertDetailsOpen ? 'true' : 'false',
              }, (alertDetailsOpen ? '▴ ' : '▾ ')
                 + (alertDetailsOpen
                   ? t('modal.alert_details_hide')
                   : t('modal.alert_details_show'))) : null
            ),
            // Math panel — only when expanded AND we have a breakdown
            (alertDetailsOpen && breakdown) ? h('div', { className: 'alert-math-panel' },
              h('div', { className: 'alert-math-grid' },
                // Left column — positive contributions
                h('div', { className: 'alert-math-section' },
                  h('div', { className: 'alert-math-h' },
                    h('span', null, t('modal.alert_section_positive')),
                    h('span', { className: 'alert-math-sum pos' },
                      'Σ +' + fmt1(breakdown.positive))
                  ),
                  h('table', { className: 'alert-math-table' },
                    h('tbody', null,
                      ...posRows.map((r, ri) => {
                        const rawVal = Number(r.val) || 0;
                        const wVal = Number(r.weight) || 0;
                        const contrib = rawVal * wVal;
                        const isZero = !contrib;
                        return h('tr', { key: ri, className: isZero ? 'muted' : '' },
                          h('td', { className: 'lbl' },
                            r.label,
                            termHelp(r.tooltip)
                          ),
                          h('td', { className: 'calc' },
                            w ? (fmt1(rawVal) + ' × ' + fmt1(wVal)) : fmt1(rawVal)),
                          h('td', { className: 'val ' + (isZero ? 'zero' : 'pos') },
                            isZero ? '0' : ('+' + fmt1(contrib)))
                        );
                      })
                    )
                  )
                ),
                // Right column — penalties
                h('div', { className: 'alert-math-section' },
                  h('div', { className: 'alert-math-h' },
                    h('span', null, t('modal.alert_section_penalty')),
                    h('span', { className: 'alert-math-sum neg' },
                      'Σ −' + fmt1(breakdown.penalty))
                  ),
                  h('table', { className: 'alert-math-table' },
                    h('tbody', null,
                      h('tr', { className: !junkContrib ? 'muted' : '' },
                        h('td', { className: 'lbl' },
                          t('modal.alert_breakdown_junk'),
                          termHelp(t('term.junk'))
                        ),
                        h('td', { className: 'calc' },
                          w ? (fmt1(junkVal) + ' × ' + fmt1(w.weightJunk)) : fmt1(junkVal)),
                        h('td', { className: 'val ' + (!junkContrib ? 'zero' : 'neg') },
                          !junkContrib ? '0' : ('−' + fmt1(junkContrib)))
                      ),
                      h('tr', { className: !staleVal ? 'muted' : '' },
                        h('td', { className: 'lbl' },
                          t('modal.alert_breakdown_stale'),
                          termHelp(t('term.stale'))
                        ),
                        h('td', { className: 'calc' },
                          fmt1(breakdown.ageHours) + 'h, grace '
                          + ((w && w.staleDecayGraceHours != null) ? w.staleDecayGraceHours : 24) + 'h'),
                        h('td', { className: 'val ' + (!staleVal ? 'zero' : 'neg') },
                          !staleVal ? '0' : ('−' + fmt1(staleVal)))
                      )
                    )
                  ),
                  // Junk triggers (politics / no-meme-shape / text-only / etc.)
                  Array.isArray(breakdown.junkReasons) && breakdown.junkReasons.length > 0
                    ? h('div', { className: 'alert-math-reasons' },
                        h('span', { className: 'lbl' },
                          t('modal.alert_junk_triggers') + ':'),
                        ...breakdown.junkReasons.map((r, ri) => h('span', {
                          key: ri,
                          className: 'tag' + (String(r).startsWith('safe-override') ? ' safe' : ''),
                        }, r))
                      )
                    : null
                )
              ),
              // Equation line
              h('div', { className: 'alert-math-eq' },
                h('span', { className: 'pos' }, '+' + fmt1(breakdown.positive)),
                ' − ',
                h('span', { className: 'neg' }, fmt1(breakdown.penalty)),
                ' = ',
                h('span', { className: 'final ' + (passed ? 'pass' : 'fail') }, score),
                h('span', { className: 'cmp' }, (passed ? ' ≥ ' : ' < ') + floor)
              ),
              // Sparkline of alertScore evolution. Rendered when we have at
              // least 2 history points (1 point is just a dot, no signal).
              // Built inline as SVG — no chart library dependency.
              (Array.isArray(alertHistory) && alertHistory.length >= 2)
                ? renderAlertSparkline(alertHistory, floor, t)
                : null,
              // Floor decomposition
              h('div', { className: 'alert-math-floor' },
                t('modal.alert_floor_explain')
                  .replace('{floor}', floor)
                  .replace('{user}', userFloor || 0)
                  .replace('{admin}', adminFloor || 0)
              )
            ) : (alertDetailsOpen && !breakdown
              ? h('div', { className: 'alert-math-panel empty' },
                  t('modal.alert_no_breakdown'))
              : null)
          );
        })() : null
      )
    )
   )
  );
}

// ── Toast system ───────────────────────────────────────────────────────────────
// Skips the auto type-icon (✅/❌/ℹ️) when the message already starts with an
// emoji or symbol — most user-facing toasts include a contextual lead char
// (🔒 ⛔ ✓ ✕ 📊 ⚠), and stacking ℹ️ in front looked like a double-icon bug.
// Detection: if first char is a letter/digit/whitespace → plain text → show
// auto-icon. Anything else → assume the user-supplied char carries the
// signal and don't add another.
function Toasts({ toasts }) {
  return h('div', { className: 'toasts-wrap' },
    toasts.map(t => {
      const msg = t.msg || '';
      const showAutoIcon = /^[\p{L}\p{N}\s]/u.test(msg);
      const autoIcon = t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ';
      return h('div', { key: t.id, className: 'toast ' + (t.type || 'info') },
        showAutoIcon ? h('span', { className: 'toast-icon' }, autoIcon) : null,
        h('span', { className: 'toast-msg' }, msg)
      );
    })
  );
}

// ── NavClock — isolated 1-second ticker (no App re-render) ───────────────────
function NavClock({ refreshAt }) {
  useLang();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const refreshIn = Math.max(0, Math.ceil((refreshAt - now) / 1000));
  return h(React.Fragment, null,
    h('span', { className: 'refresh-badge' }, '\u21bb ' + refreshIn + 's'),
    h('span', { className: 'nav-time' }, new Date(now).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }))
  );
}

// ── ControlPanel ──────────────────────────────────────────────────────────────
function ControlPanel({ scanning, onScan, sources, onCollectorToggle, addToast }) {
  useLang();
  const CONTROL_BUTTONS = [
    { id: 'scan',   icon: '⚡', label: t('control.scan'),   action: 'scan',   disabled: scanning },
    { id: 'health', icon: '🏥', label: t('control.health'), action: 'health', disabled: false },
    { id: 'reload', icon: '↻',  label: t('control.reload'), action: 'reload', disabled: false },
    { id: 'stats',  icon: '📊', label: t('control.stats'),  action: 'stats',  disabled: false },
  ];

  const handleAction = async (action) => {
    if (action === 'scan') {
      onScan();
    } else if (action === 'health') {
      try {
        const res = await fetch('/api/health').then(r => r.json());
        addToast && addToast(t('control.health_ok', { m: Math.floor(res.uptime / 60) }), 'success');
      } catch (e) {
        addToast && addToast(t('control.error', { e: e.message }), 'error');
      }
    } else if (action === 'reload') {
      location.reload();
    } else if (action === 'stats') {
      window.dispatchEvent(new CustomEvent('dashboard:navigate', { detail: { view: 'stats' } }));
    }
  };

  return h('div', { className: 'control-panel' },
    h('div', { className: 'control-panel-title' },
      t('control.title')
    ),

    h('div', { className: 'control-grid' },
      CONTROL_BUTTONS.map(btn =>
        h('button', {
          key: btn.id,
          className: 'control-btn',
          onClick: () => handleAction(btn.action),
          disabled: btn.disabled,
          title: btn.label,
        },
          h('span', { className: 'control-icon' }, btn.icon),
          h('span', { className: 'control-label' }, btn.label),
          btn.id === 'scan' && scanning
            ? h('span', { className: 'control-status' })
            : null
        )
      )
    ),

    // Source toggles
    sources && sources.length > 0
      ? h(React.Fragment, null,
          h('div', { className: 'source-controls' },
            sources.map(src =>
              h('button', {
                key: src.source,
                className: 'source-control-btn' + (src.enabled ? '' : ' disabled'),
                onClick: () => onCollectorToggle(src.source),
                title: src.enabled ? t('control.disable_source') : t('control.enable_source'),
              },
                h('span', null, '📡 ' + (SOURCE_LABELS[src.source] || src.source.charAt(0).toUpperCase() + src.source.slice(1))),
                h('div', { className: 'source-control-toggle' })
              )
            )
          )
        )
      : null
  );
}

// ── SettingsPanel ─────────────────────────────────────────────────────────────
function HeroPanel({ stats, hours, refreshIn, scanning, onScan, onOpenStats }) {
  useLang();
  return h('div', { className: 'session-bar' },
    h('span', { className: 'session-tag' }, stats && stats.paused ? t('status.offline') : t('status.live')),
    h('div', { className: 'session-title' }, t('app.title') + ' — ' + t('app.subtitle')),
    h('div', { className: 'session-chips' },
      h('div', { className: 'session-chip' },
        t('hero.window') + ' ', h('span', { className: 'chip-val' }, hours + 'h')
      ),
      h('div', { className: 'session-chip' },
        t('hero.signals') + ' ', h('span', { className: 'chip-val' }, String(stats ? stats.total || 0 : 0))
      ),
      h('div', { className: 'session-chip' },
        t('hero.alerts') + ' ', h('span', { className: 'chip-val' }, String(stats ? stats.alerts || 0 : 0))
      ),
      h('div', { className: 'session-chip', style: { cursor: 'pointer' }, onClick: onOpenStats },
        t('hero.stats')
      ),
      h('button', {
        className: 'btn btn-primary',
        onClick: onScan,
        disabled: scanning,
        style: { fontSize: 11, padding: '4px 11px' }
      }, scanning ? t('hero.scanning') : t('hero.scan_now'))
    )
  );
}

// ── AnalyzePanel — pro/admin manual URL analysis ────────────────────────────
// Mirrors AccountPanel/SettingsPanel layout. Posts to /api/manual-analysis,
// renders a compact preview of the scored trend, and lets the user pop the
// full TrendModal via onOpenTrend(trend). Plan gate is ALSO enforced
// server-side — this UI is only rendered when me.plan ∈ {pro, admin}, but
// the endpoint will 403 if the user changes plan mid-session.
function AnalyzePanel({ onBack, onOpenTrend }) {
  useLang();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  // Stage index for the loader breadcrumb (0..3). Backend doesn't stream
  // progress, so we advance on a client-side timer with estimates that
  // roughly match real pipeline timing (PreStage ~3s, Stage 1 ~8-15s,
  // Stage 2 ~30-50s, finalize ~1s). Resets to 0 on each run().
  const [stageIdx, setStageIdx] = useState(0);
  useEffect(() => {
    if (!loading) { setStageIdx(0); return; }
    setStageIdx(0);
    // Estimated time-per-stage in ms — last stage sticks until response arrives.
    const stops = [3000, 12000, 45000];
    const timers = stops.map((ms, i) =>
      setTimeout(() => setStageIdx(Math.min(i + 1, 3)), ms)
    );
    return () => timers.forEach(clearTimeout);
  }, [loading]);

  const run = async () => {
    const clean = url.trim();
    if (!clean) { setError(t('analyze.url_label')); return; }
    if (!/^https?:\\/\\//i.test(clean)) { setError('URL must start with http(s)://'); return; }
    setError(''); setLoading(true); setResult(null);
    try {
      const r = await fetch('/api/manual-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(AUTH_TOKEN ? { 'Authorization': 'Bearer ' + AUTH_TOKEN } : {}),
        },
        body: JSON.stringify({ url: clean }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (data.reason === 'plan')     { setError(t('analyze.locked')); return; }
        if (data.reason === 'cooldown') { setError(t('analyze.cooldown', { sec: data.secLeft || 30 })); return; }
        if (data.reason === 'daily')    { setError(t('analyze.daily_cap')); return; }
        setError(t('analyze.error_prefix') + (data.error || 'unknown'));
        return;
      }
      setResult(data);
    } catch (e) {
      setError(t('analyze.error_prefix') + (e.message || 'network error'));
    } finally {
      setLoading(false);
    }
  };

  const tr = result?.trend;
  // Verdict level — driven by max(memePotential, adoptionScore). Buckets:
  // high ≥70 / mid ≥40 / low. This is what powers the headline banner so
  // the user gets a one-line answer ("will it go viral?") before scanning
  // numbers. Same buckets reused per-score for the qualitative tags below.
  const bucketOf = (v) => (v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low');
  const verdictLvl = tr
    ? bucketOf(Math.max(tr.memePotential || 0, tr.adoptionScore || 0))
    : 'low';

  // Score cards spec — kept in data so the JSX below is just a .map().
  // Three cards: Emergence / Adoption / Story (operator picked these 3 over
  // the previous "Viral potential / Trending / Reach growth" trio).
  // Story always rendered now — bar going to 0 reads as "no signal yet"
  // which is the honest answer when Stage 2 hasn't run.
  const scoreSpecs = tr ? [
    { k: 'emerge', v: tr.emergenceScore || 0, icon: '🌊' },
    { k: 'adopt',  v: tr.adoptionScore  || 0, icon: '🔥' },
    { k: 'story',  v: tr.storyScore     || 0, icon: '📖' },
  ] : [];

  return h('div', { className: 'analyze-panel' },
    h('div', { className: 'settings-header' },
      h('button', { className: 'btn btn-ghost', onClick: onBack }, t('app.back')),
      h('span', { className: 'settings-title' }, '🧪 ' + t('analyze.title'))
    ),
    h('div', { className: 'analyze-intro' }, t('analyze.intro')),

    h('div', { className: 'analyze-form' },
      h('label', { className: 'analyze-label' }, t('analyze.url_label')),
      h('input', {
        type: 'url',
        className: 'analyze-input',
        value: url,
        onChange: e => setUrl(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter' && !loading) run(); },
        placeholder: t('analyze.url_placeholder'),
        disabled: loading,
      }),
      h('div', { className: 'analyze-row' },
        h('button', { className: 'btn btn-primary', onClick: run, disabled: loading || !url.trim() },
          loading ? t('analyze.running') : ('🚀 ' + t('analyze.run_btn'))
        ),
        error ? h('span', { className: 'analyze-error' }, '⚠ ' + error) : null
      )
    ),

    // Loading state — animated stage loader. Replaces the old single-line
    // "Usually takes 10-30 seconds" hint. Stage label advances on a timer
    // (PreStage → AI → Grok deep-dive → Finalize) plus a trailing 4-dot
    // breadcrumb so the user sees roughly where the pipeline is.
    loading ? (() => {
      const stageKey = ['analyze.stage_fetch', 'analyze.stage_ai', 'analyze.stage_deep', 'analyze.stage_finalize'][stageIdx] || 'analyze.stage_finalize';
      return h('div', { className: 'analyze-loader' },
        h('div', { className: 'analyze-loader-spinner' }),
        h('div', { className: 'analyze-loader-text' },
          t(stageKey),
          h('span', { className: 'analyze-loader-dots' },
            h('span', null, '.'),
            h('span', null, '.'),
            h('span', null, '.')
          )
        ),
        h('div', { className: 'analyze-loader-trail' },
          [0, 1, 2, 3].map(i => {
            const cls = i < stageIdx ? 'done' : (i === stageIdx ? 'active' : '');
            return h('div', { key: i, className: 'analyze-loader-trail-dot ' + cls });
          })
        )
      );
    })() : null,

    !result && !loading && !error ? h('div', { className: 'analyze-empty' }, t('analyze.empty')) : null,

    result && tr ? h('div', { className: 'analyze-result' },
      // Verdict banner — top-of-card headline answer. Drives the user's
      // entire takeaway before they scan individual scores. Coloured
      // strip + gradient picks the level (high/mid/low).
      h('div', { className: 'analyze-verdict ' + verdictLvl },
        h('div', { className: 'analyze-verdict-title' }, t('analyze.verdict_' + verdictLvl)),
        h('div', { className: 'analyze-verdict-sub' },   t('analyze.verdict_sub_' + verdictLvl))
      ),
      // Hero strip — thumbnail + title + quick actions.
      h('div', { className: 'analyze-hero' },
        tr.imageUrl
          ? h('img', { src: tr.imageUrl, alt: '', loading: 'lazy', className: 'analyze-thumb' })
          : h('div', { className: 'analyze-thumb-fb' },
              SOURCE_ICONS[tr.source] || '🌐'
            ),
        h('div', { className: 'analyze-hero-body' },
          h('div', { className: 'analyze-hero-title' }, tr.title),
          h('div', { className: 'analyze-hero-meta' },
            (SOURCE_LABELS[tr.source] || tr.source) +
            ' · ' + (result.fromCache
              ? t('analyze.from_cache', { min: Math.max(1, Math.round((result.cacheAgeMs || 0) / 60000)) })
              : t('analyze.fresh_run', { sec: (result.elapsedMs / 1000).toFixed(1) })) +
            (tr.category ? ' · ' + tr.category : '')
          ),
          h('div', { className: 'analyze-hero-actions' },
            tr.url ? h('a', { href: tr.url, target: '_blank', rel: 'noopener', className: 'btn btn-ghost btn-sm' }, '🔗 ' + t('analyze.open_link')) : null,
            h('button', { className: 'btn btn-primary btn-sm', onClick: () => onOpenTrend(tr) }, '👁 ' + t('analyze.open_full'))
          )
        )
      ),
      // Score grid — number + progress bar. The bar gives spatial context
      // (20/100 is clearly tiny). Qualitative tag (Low/Med/High) removed
      // 2026-05-17 per operator — bar already does that job visually.
      h('div', { className: 'analyze-scores' },
        scoreSpecs.map(s => {
          const lvl = bucketOf(s.v);
          return h('div', { key: s.k, className: 'analyze-score ' + lvl },
            h('div', { className: 'analyze-score-label' }, s.icon + ' ' + t('analyze.score_' + s.k)),
            h('div', { className: 'analyze-score-value' }, (s.v || 0) + '/100'),
            h('div', { className: 'analyze-score-bar' },
              h('div', { className: 'analyze-score-bar-fill', style: { width: (s.v || 0) + '%' } })
            )
          );
        })
      ),
      // AI explanation — relabelled from "AI" to "Why this score" so the
      // section's job is obvious to a non-engineer reading the panel.
      tr.aiExplanation ? h('div', { className: 'analyze-explain' },
        h('div', { className: 'analyze-explain-label' }, '🤖 ' + t('analyze.why_label')),
        h('div', { className: 'analyze-explain-body' }, tr.aiExplanation)
      ) : null,
      // Deep-analysis footer removed 2026-05-17 — even the trimmed one-liner
      // ("Deep analysis: skipped — saved you a Grok call") was internal-talk
      // that bored users. Verdict banner + score cards convey everything a
      // non-engineer needs. Modal still has full pipeline trace for debugging.

      // Test-plan usage counter — tiny line, only when server returned one
      // (cache hits and non-test plans omit it).
      result.usage
        ? h('div', {
            style: { padding: '8px 16px 16px', fontSize: 11, color: 'var(--muted, #71767b)' }
          }, t('usage.test_left', { used: result.usage.used, cap: result.usage.cap, left: result.usage.left }))
        : null
    ) : null
  );
}

function StatsPanel({ stats, hours, onBack, onOpenTrend }) {
  useLang();
  const sourceOrder = ['reddit', 'google_trends', 'twitter', 'tiktok', 'x_trends'];
  const allSources = sourceOrder.map(name => {
    const hit = (stats?.bySource || []).find(s => s.source === name);
    return { source: name, count: hit ? hit.count : 0 };
  });
  const topCategories = (stats?.byCategory || []).slice(0, 6);
  const topTrends = (stats?.topTrends || []).slice(0, 4);

  return h('div', { className: 'stats-view' },
    h('div', { className: 'settings-header' },
      h('button', { className: 'btn btn-ghost', onClick: onBack }, t('app.back')),
      h('span', { className: 'settings-title' }, t('stats.overview'))
    ),
    h('div', { className: 'stats-grid' },
      h('section', { className: 'section-shell stats-block' },
        h('div', { className: 'stats-block-head' },
          h('div', { className: 'stats-block-title' }, t('stats.sources')),
          h('div', { className: 'stats-block-sub' }, t('stats.window', { h: hours }))
        ),
        h('div', { className: 'stats-list' },
          allSources.map(row =>
            h('div', { key: row.source, className: 'stats-list-row' },
              h('div', { className: 'stats-list-main' },
                h('span', null, SOURCE_ICONS[row.source] || '📡'),
                h('span', { className: 'stats-list-name' }, SOURCE_LABELS[row.source] || row.source)
              ),
              h('span', { className: 'stats-list-value' }, String(row.count))
            )
          )
        )
      ),
      h('section', { className: 'section-shell stats-block' },
        h('div', { className: 'stats-block-head' },
          h('div', { className: 'stats-block-title' }, t('stats.categories')),
          h('div', { className: 'stats-block-sub' }, t('stats.categories_sub'))
        ),
        h('div', { className: 'stats-list' },
          topCategories.length
            ? topCategories.map(row =>
                h('div', { key: row.category || 'other', className: 'stats-list-row' },
                  h('div', { className: 'stats-list-main' },
                    h('span', null, CAT_ICONS[row.category] || '📌'),
                    h('div', null,
                      h('div', { className: 'stats-list-name' }, row.category || 'other'),
                      h('div', { className: 'stats-list-meta' }, t('stats.cluster_count'))
                    )
                  ),
                  h('span', { className: 'stats-list-value' }, String(row.count))
                )
              )
            : h('div', { className: 'stats-list-row' },
                h('span', { className: 'stats-list-meta' }, t('stats.no_category_data'))
              )
        )
      ),
      h('section', { className: 'section-shell stats-block' },
        h('div', { className: 'stats-block-head' },
          h('div', { className: 'stats-block-title' }, t('stats.top_narratives')),
          h('div', { className: 'stats-block-sub' }, t('stats.top_narratives_sub'))
        ),
        h('div', { className: 'stats-top-grid' },
          topTrends.length
            ? topTrends.map(trend =>
                h('div', {
                  key: trend.id,
                  className: 'stats-top-card',
                  onClick: () => onOpenTrend && onOpenTrend(trend),
                },
                  h('div', { className: 'stats-top-title' }, trend.title),
                  h('div', { className: 'stats-top-meta' },
                    h('span', null, SOURCE_ICONS[trend.source] || '📡'),
                    h('span', null, SOURCE_LABELS[trend.source] || trend.source),
                    h('span', null, (trend.adoptionScore || trend.memePotential || 0) + '/100')
                  )
                )
              )
            : h('div', { className: 'stats-list-row' },
                h('span', { className: 'stats-list-meta' }, t('stats.no_trend_data'))
              )
        )
      )
    )
  );
}

// ── User preferences helpers ─────────────────────────────────────────────────
const PREFS_KEY = 'ts_prefs_v1';
const DEFAULT_PREFS = {
  density:       'comfortable', // 'compact' | 'comfortable'
  showImages:    true,
  animations:    true,
  hoverPreview:  true,  // hover-card with tweet/reddit content on link hover
  colLeft:       240,  // left sidebar width in px (180..360)
  colRight:      300,  // right panel width in px (240..420)
};
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch (e) { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('ts:prefs', { detail: p })); } catch (e) {}
  applyPrefsToDOM(p);
}

// Snapshot accessor for non-React code paths (e.g. document-level event
// handlers in useTweetHover) that need the freshest pref WITHOUT subscribing
// to ts:prefs. Reads localStorage directly so toggle changes apply on the
// very next mouseover with no re-mount needed.
function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw)[key];
    return typeof v === 'undefined' ? fallback : v;
  } catch (e) { return fallback; }
}
function applyPrefsToDOM(p) {
  const b = document.body;
  if (!b) return;
  b.classList.toggle('prefs-compact', p.density === 'compact');
  b.classList.toggle('prefs-no-images', !p.showImages);
  b.classList.toggle('prefs-no-anim',  !p.animations);
  try {
    const root = document.documentElement;
    const left  = Math.max(180, Math.min(540, Number(p.colLeft)  || 240));
    const right = Math.max(240, Math.min(630, Number(p.colRight) || 300));
    root.style.setProperty('--col-left',  left  + 'px');
    root.style.setProperty('--col-right', right + 'px');
  } catch (e) {}
}
// apply on first script eval (before React mounts)
try { applyPrefsToDOM(loadPrefs()); } catch (e) {}

// Modal sheet — centered card with blurred backdrop. Used by Settings,
// Account and Stats views. Close via Esc, backdrop click, or the ✕ button.
// Sheet — centered modal with blurred backdrop. The "narrow" flag tightens
// max-width for forms (Analyze, Account) so the content doesn't sprawl.
function Sheet({ title, icon, onClose, children, narrow = false }) {
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);
  // Lock body scroll while sheet is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return h('div', {
    className: 'sheet-overlay',
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
  },
    h('div', { className: 'sheet' + (narrow ? ' sheet-narrow' : ''), role: 'dialog', 'aria-modal': 'true' },
      h('div', { className: 'sheet-head' },
        icon ? h('span', { className: 'sheet-title-ico' }, icon) : null,
        h('span', { className: 'sheet-title' }, title),
        h('button', {
          type: 'button',
          className: 'sheet-close',
          onClick: onClose,
          'aria-label': 'Close',
          title: 'Esc',
        }, '✕')
      ),
      h('div', { className: 'sheet-body' }, children)
    )
  );
}

// Shared primitives used by SettingsPanel and AccountPanel (keep module-level
// so any settings-like panel can pick them up).
const Toggle = ({ on, onChange }) =>
  h('button', {
    className: 'pref-toggle' + (on ? ' on' : ''),
    onClick: () => onChange(!on),
    role: 'switch',
    'aria-checked': on,
  }, h('span', { className: 'pref-toggle-knob' }));

// Row primitive — label + control side-by-side by default. Pass
// stacked:true for controls that need full row width (e.g. multi-toggle
// groups like AlertTypesRow). Stacked rows put the label/desc on top and
// the control below at full width.
const Row = ({ icon, title, desc, control, stacked = false }) =>
  h('div', { className: 'setting-row' + (stacked ? ' setting-row-stacked' : '') },
    h('div', { className: 'setting-label' },
      h('span', { className: 'setting-name' }, icon ? (icon + ' ') : '', title),
      desc ? h('span', { className: 'setting-hint' }, desc) : null
    ),
    h('div', { className: 'setting-control' }, control)
  );

// PersonalizationCard / per-user category boost was removed 2026-04-27.
// Feed ordering is now uniformly global. Removed pieces (kept here as a
// pointer for git archeology):
//   - PersonalizationCard React component (rendered chips of net per-category)
//   - api('/personalization') GET/POST + matching server handlers
//   - i18n keys settings.personalization*
//   - .pref-chip* CSS rules
//   - getCategoryPreferences / get|setPersonalizationEnabled in db
// The users.personalization_enabled column is intentionally left in place
// (SQLite does not support cheap DROP COLUMN; it has no consumers anymore).

function SettingsPanel({ onBack, onResetHiddenSources, hiddenSourcesCount }) {
  const lang = useLang();
  const grokLang = useGrokLang();
  const theme = useTheme();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [flash, setFlash] = useState('');

  const update = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const flashMsg = (m) => { setFlash(m); setTimeout(() => setFlash(''), 2000); };

  const resetAllPrefs = () => {
    if (!confirm(t('settings.reset_all_confirm'))) return;
    const next = { ...DEFAULT_PREFS };
    setPrefs(next);
    savePrefs(next);
    flashMsg(t('settings.flash_reset'));
  };


  return h('div', { className: 'settings-panel' },
    h('div', { className: 'settings-header' },
      h('button', { className: 'btn btn-ghost', onClick: onBack }, t('app.back')),
      h('span', { className: 'settings-title' }, t('settings.title')),
      flash ? h('span', { className: 'settings-flash' }, flash) : null
    ),

    // ── Language ──
    // Card title + desc removed 2026-05-14 — оператор счёл их избыточными,
    // сами language-Row'ы достаточно self-explanatory. i18n keys
    // settings.language / settings.language_desc остались в словарях на
    // случай если решим вернуть, но в UI больше не рендерятся.
    h('div', { className: 'settings-card' },
      // Dashboard / UI language
      h(Row, {
        icon: '🌐', title: t('settings.language_dashboard'),
        desc: t('settings.language_dashboard_hint'),
        control: h('div', { className: 'seg-group seg-compact' },
          [{ v: 'en', l: '🇺🇸 EN' }, { v: 'ru', l: '🇷🇺 RU' }].map(o =>
            h('button', {
              key: o.v,
              className: 'seg-btn' + (lang === o.v ? ' active' : ''),
              onClick: () => setLang(o.v)
            }, o.l)
          )
        )
      }),
      // Grok prompt language — independent from UI lang. Saved separately
      // in localStorage (ts_grok_lang). Read by the Ask Grok prompt builder
      // via getGrokLang() so EN-UI users can still send RU prompts.
      h(Row, {
        icon: '🧠', title: t('settings.grok_language'),
        desc: t('settings.grok_language_hint'),
        control: h('div', { className: 'seg-group seg-compact' },
          [{ v: 'en', l: '🇺🇸 EN' }, { v: 'ru', l: '🇷🇺 RU' }].map(o =>
            h('button', {
              key: o.v,
              className: 'seg-btn' + (grokLang === o.v ? ' active' : ''),
              onClick: () => setGrokLang(o.v)
            }, o.l)
          )
        )
      })
    ),

    // ── Theme ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, t('settings.theme')),
      h('div', { className: 'settings-card-desc' }, t('settings.theme_desc')),
      h('div', { className: 'theme-grid' },
        SUPPORTED_THEMES.map(tk => {
          const meta = THEME_META[tk];
          const label = lang === 'ru' ? meta.labelRu : meta.labelEn;
          return h('button', {
            key: tk,
            className: 'theme-swatch' + (theme === tk ? ' active' : ''),
            'data-theme-preview': tk,
            onClick: () => setTheme(tk),
            title: label,
          },
            h('span', { className: 'theme-swatch-dot theme-swatch-dot-bg' }),
            h('span', { className: 'theme-swatch-dot theme-swatch-dot-accent' }),
            h('span', { className: 'theme-swatch-dot theme-swatch-dot-card' }),
            h('span', { className: 'theme-swatch-label' }, meta.icon + ' ' + label)
          );
        })
      )
    ),

    // ── Appearance ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, t('settings.appearance')),
      h('div', { className: 'settings-card-desc' }, t('settings.appearance_desc')),
      h(Row, {
        icon: '📐', title: t('settings.density'),
        desc: t('settings.density_desc'),
        control: h('div', { className: 'seg-group seg-compact' },
          [{ v: 'comfortable', l: t('settings.density.comfy') }, { v: 'compact', l: t('settings.density.compact') }].map(o =>
            h('button', {
              key: o.v,
              className: 'seg-btn' + (prefs.density === o.v ? ' active' : ''),
              onClick: () => update({ density: o.v })
            }, o.l)
          )
        )
      }),
      h(Row, {
        icon: '🖼️', title: t('settings.images'),
        desc: t('settings.images_desc'),
        control: h(Toggle, { on: prefs.showImages, onChange: v => update({ showImages: v }) })
      }),
      h(Row, {
        icon: '✨', title: t('settings.animations'),
        desc: t('settings.animations_desc'),
        control: h(Toggle, { on: prefs.animations, onChange: v => update({ animations: v }) })
      }),
      h(Row, {
        icon: '\u{1F441}', title: t('settings.hover_preview'),
        desc: t('settings.hover_preview_desc'),
        control: h(Toggle, { on: prefs.hoverPreview, onChange: v => update({ hoverPreview: v }) })
      }),
      // Font size setting removed 2026-05-14 — it set a --user-font-size
      // CSS variable that no rule consumed (every selector hard-codes px),
      // so the toggle was visually no-op. Re-adding it would require an
      // em/rem refactor across the SPA CSS.
      h(Row, {
        icon: '◧', title: t('settings.col_left'),
        desc: t('settings.col_left_desc', { px: prefs.colLeft }),
        control: h('div', { className: 'slider-wrap' },
          h('input', {
            type: 'range', min: 180, max: 540, step: 10,
            value: prefs.colLeft,
            onChange: e => update({ colLeft: Number(e.target.value) }),
            className: 'range-slider'
          }),
          h('span', { className: 'slider-val' }, prefs.colLeft + 'px'),
          h('button', {
            type: 'button',
            className: 'slider-reset',
            onClick: () => update({ colLeft: 240 }),
            title: t('app.reset')
          }, '↺')
        )
      }),
      h(Row, {
        icon: '◨', title: t('settings.col_right'),
        desc: t('settings.col_right_desc', { px: prefs.colRight }),
        control: h('div', { className: 'slider-wrap' },
          h('input', {
            type: 'range', min: 240, max: 630, step: 10,
            value: prefs.colRight,
            onChange: e => update({ colRight: Number(e.target.value) }),
            className: 'range-slider'
          }),
          h('span', { className: 'slider-val' }, prefs.colRight + 'px'),
          h('button', {
            type: 'button',
            className: 'slider-reset',
            onClick: () => update({ colRight: 300 }),
            title: t('app.reset')
          }, '↺')
        )
      })
    ),

    // ── Behavior ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, t('settings.behavior')),
      h('div', { className: 'settings-card-desc' }, t('settings.behavior_desc')),
      h(Row, {
        icon: '👁', title: t('settings.hidden'),
        desc: hiddenSourcesCount
          ? t('settings.hidden_count', { n: hiddenSourcesCount })
          : t('settings.hidden_none'),
        control: h('button', {
          className: 'btn btn-ghost',
          disabled: !hiddenSourcesCount,
          onClick: () => {
            if (onResetHiddenSources) { onResetHiddenSources(); flashMsg(t('settings.flash_sources_shown')); }
          }
        }, t('settings.hidden_show_all'))
      })
    ),

    // ── Archive (per-user, server-side, 7d retention) ──
    h(ArchiveCard, null),

    // ── Reset ──
    h('div', { className: 'settings-actions' },
      h('button', { className: 'btn btn-ghost', onClick: resetAllPrefs }, t('settings.reset_all'))
    )
  );
}

// ── ArchiveCard — list of user's hidden alerts (Settings → Archive section) ──
// Fetches /api/trends/hidden, renders compact rows with restore + clear-all.
// Loads on first mount; refetches after restore/clear so the list stays sync'd.
// Stays inside SettingsPanel as a card so the archive doesn't need its own
// route — feels like a Twitter "muted" sublist.
function ArchiveCard() {
  useLang();
  const [items, setItems] = useState(null); // null = not loaded yet
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Collapsed by default — with 7d retention the list can be long, and the
  // user usually opens Settings for other reasons. Click on the head expands
  // and triggers the lazy fetch (no API call until the user actually wants it).
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      const data = await api('/trends/hidden');
      setItems(Array.isArray(data?.trends) ? data.trends : []);
    } catch (e) { setErr(e.message || 'load failed'); setItems([]); }
  }, []);

  // Fetch the first time the user opens the section (and never again unless
  // the component re-mounts — Settings sheet remount per-open handles that).
  useEffect(() => { if (open && items === null) load(); }, [open, items, load]);

  const restore = async (trendId) => {
    if (busy) return;
    setBusy(true);
    try {
      await api('/trends/' + trendId + '/unhide', { method: 'POST' });
      setItems(prev => (prev || []).filter(it => it.id !== trendId));
    } catch (e) { setErr(e.message || 'restore failed'); }
    finally { setBusy(false); }
  };

  const clearAll = async () => {
    if (busy) return;
    if (!items || !items.length) return;
    if (!confirm(t('archive.clear_confirm'))) return;
    setBusy(true);
    try {
      await api('/trends/hidden/clear', { method: 'POST' });
      setItems([]);
    } catch (e) { setErr(e.message || 'clear failed'); }
    finally { setBusy(false); }
  };

  const fmtAge = (iso) => {
    const ms = Date.now() - Date.parse(iso || '');
    if (!isFinite(ms) || ms < 0) return '';
    const m = Math.round(ms / 60000);
    if (m < 60)        return m + 'm';
    if (m < 60 * 24)   return Math.round(m / 60) + 'h';
    return Math.round(m / 60 / 24) + 'd';
  };

  const count = items && items.length;

  return h('div', { className: 'settings-card archive-card' + (open ? ' open' : '') },
    // Clickable head — toggles collapse. Caret rotates 90° when open.
    h('button', {
      className: 'archive-head',
      onClick: () => setOpen(v => !v),
      'aria-expanded': open,
    },
      h('span', { className: 'archive-head-caret' }, '▸'),
      h('span', { className: 'archive-head-title' }, t('archive.title')),
      count ? h('span', { className: 'archive-head-count' }, t('archive.count', { n: items.length })) : null
    ),
    h('div', { className: 'settings-card-desc archive-card-desc' }, t('archive.desc')),

    // Body is rendered only when open. CSS handles the slide-down feel via
    // archive-fade-in keyframes; we still gate the React work with the open
    // flag so an unopened archive never paints 200 rows.
    open ? h('div', { className: 'archive-body' },
      // Clear-all moved to the TOP per UX request — easier to find than at
      // the bottom of a long list. Only shows when there are items.
      count ? h('div', { className: 'archive-actions archive-actions-top' },
        h('button', {
          className: 'btn btn-ghost',
          disabled: busy,
          onClick: clearAll
        }, t('archive.clear_all'))
      ) : null,

      items === null
        ? h('div', { className: 'archive-empty' }, t('archive.loading'))
        : items.length === 0
          ? h('div', { className: 'archive-empty' }, t('archive.empty'))
          : h('div', { className: 'archive-list' },
              items.map(it => h('div', { key: it.id, className: 'archive-row' },
                h('span', {
                  className: 'archive-row-icon',
                  style: { color: 'var(--text)' }
                }, SOURCE_ICONS[it.source] || '📡'),
                h('div', { className: 'archive-row-body' },
                  h('div', { className: 'archive-row-title', title: it.title }, it.title),
                  h('div', { className: 'archive-row-meta' },
                    (SOURCE_LABELS[it.source] || it.source) + ' · ' + fmtAge(it.hiddenAt)
                  )
                ),
                h('button', {
                  className: 'archive-row-btn',
                  disabled: busy,
                  onClick: () => restore(it.id)
                }, t('archive.restore'))
              ))
            ),

      err ? h('div', { style: { color: 'var(--red, #f87171)', fontSize: 12, marginTop: 8 } }, '⚠ ' + err) : null
    ) : null
  );
}

// ── AlertSensitivityRow — single interactive slider for the user's alertScore
// threshold. Slider value is stored locally while dragging, then POSTed to the
// server on pointerup. This is the ONE knob the user has for alerts: higher =
// stricter (fewer alerts), lower = looser (more alerts). Admin-tunable weights
// decide how alertScore is computed.
function AlertSensitivityRow({ initial }) {
  const [val, setVal] = useState(typeof initial === 'number' ? initial : 60);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async (v) => {
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/user/threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH_TOKEN },
        body: JSON.stringify({ threshold: v }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) { setErr(e.message || 'error'); }
    setSaving(false);
  };

  return h(Row, {
    // ✈ paper-plane evokes Telegram, hints that this knob is TG-scoped.
    icon: '✈️',
    title: t('account.threshold'),
    desc: t('account.threshold_desc'),
    control: h('div', { className: 'slider-row', style: { gap: 10 } },
      h('input', {
        type: 'range', min: 0, max: 100, step: 1,
        value: val,
        onChange: e => setVal(Number(e.target.value)),
        onPointerUp: () => save(val),
        onKeyUp: (e) => { if (['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key)) save(val); },
        className: 'range-slider',
        disabled: saving,
      }),
      h('span', { className: 'slider-val' }, val + (saving ? ' …' : err ? ' ⚠' : ''))
    )
  });
}

/**
 * AlertTypesRow — three checkboxes (event/trend/post) that POST the new
 * subscription to the server. Initial state comes from user.alertTypes
 * (already canonicalised by db.getUserAlertTypes via _publicUser).
 *
 * UX rules:
 *  • toggling is optimistic — user sees the change instantly, server roundtrip
 *    is fire-and-forget. On error we revert and toast.
 *  • all-off is allowed (server treats empty CSV as "all" — see hint string).
 *
 * Variable name "selected" is a Set so flipping a single value is O(1) and
 * order-independent.
 */
function AlertTypesRow({ initial }) {
  useLang();
  const init = Array.isArray(initial) ? initial : ['event','trend','post'];
  const [selected, setSelected] = useState(() => new Set(init));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [err, setErr] = useState('');

  const toggle = async (key) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
    setSaving(true);
    setErr('');
    try {
      const r = await fetch('/api/user/alert-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   ...(AUTH_TOKEN ? { 'Authorization': 'Bearer ' + AUTH_TOKEN } : {}) },
        body: JSON.stringify({ types: Array.from(next) }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || ('HTTP ' + r.status));
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e.message);
      // rollback so UI matches server
      setSelected(new Set(selected));
    }
    setSaving(false);
  };

  const Box = ({ k, label }) => {
    const on = selected.has(k);
    return h('button', {
      type: 'button',
      className: 'atype-toggle' + (on ? ' on' : ''),
      onClick: () => toggle(k),
      disabled: saving,
    },
      h('span', { className: 'atype-toggle-icon' }, on ? '✅' : '⬜'),
      h('span', { className: 'atype-toggle-label' }, label)
    );
  };

  return h(Row, {
    icon: '🔔',
    title: t('account.alert_types'),
    desc: t('account.alert_types_desc'),
    // Stacked layout — three full-width toggles read better as a vertical
    // list under the label than crammed next to it. Same pattern X uses
    // for "Notification preferences".
    stacked: true,
    control: h('div', { className: 'atype-toggle-group' },
      h(Box, { k: 'event', label: t('account.alert_types_event') }),
      h(Box, { k: 'trend', label: t('account.alert_types_trend') }),
      h(Box, { k: 'post',  label: t('account.alert_types_post')  }),
      h('div', { className: 'atype-foot' },
        savedFlash ? h('span', { className: 'atype-saved' }, t('account.alert_types_saved')) : null,
        err ? h('span', { className: 'atype-err' }, '⚠ ' + err) : null,
        h('span', { className: 'atype-hint' }, t('account.alert_types_all_off_hint'))
      )
    )
  });
}

// ── AccountPanel — profile / plan / logout (extracted from SettingsPanel) ─────
function AccountPanel({ onBack, user, onLogout }) {
  useLang();
  const planLabels = { free: t('plan.free'), test: t('plan.test'), pro: t('plan.pro'), admin: t('plan.admin') };
  const doLogout = async () => {
    if (!confirm(t('settings.logout_confirm'))) return;
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* token already invalid */ }
    if (onLogout) onLogout();
  };

  const avatarLetter = (user && user.username)
    ? user.username.charAt(0).toUpperCase()
    : '👤';
  const avatarSrc = user?.hasAvatar
    ? '/api/auth/avatar?token=' + encodeURIComponent(AUTH_TOKEN) + '&k=' + encodeURIComponent(user.avatarKey || '')
    : null;

  const subExpiry = user?.subscriptionExpiresAt
    ? new Date(user.subscriptionExpiresAt).toLocaleDateString(localeTag(), { day: '2-digit', month: 'short', year: 'numeric' })
    : null;

  return h('div', { className: 'settings-panel' },
    h('div', { className: 'settings-header' },
      h('button', { className: 'btn btn-ghost', onClick: onBack }, t('app.back')),
      h('span', { className: 'settings-title' }, t('nav.account'))
    ),

    // Profile hero
    h('div', { className: 'settings-card account-hero' },
      h('div', { className: 'account-avatar-big' },
        avatarSrc
          ? h('img', { src: avatarSrc, alt: user?.username || 'avatar', onError: (e) => { e.target.style.display = 'none'; } })
          : avatarLetter
      ),
      h('div', { className: 'account-hero-main' },
        h('div', { className: 'account-hero-name' },
          user?.username ? '@' + user.username : t('settings.tg_chatid', { id: user?.chatId || '—' })
        ),
        h('div', { className: 'account-hero-sub' },
          h('span', { className: 'account-hero-chip' },
            h('span', { className: 'account-hero-chip-k' }, 'ID'),
            h('span', { className: 'account-hero-chip-v' }, user?.chatId || '—')
          ),
          h('span', { className: 'account-hero-chip' },
            h('span', { className: 'account-hero-chip-k' }, '💎'),
            h('span', { className: 'account-hero-chip-v' }, planLabels[user?.plan] || user?.plan || '—')
          ),
          user?.status
            ? h('span', { className: 'account-hero-chip' },
                h('span', {
                  className: 'account-hero-chip-k',
                  style: { color: user.status === 'active' ? 'var(--green2)' : 'var(--red2)' }
                }, user.status === 'active' ? '● ' + t('status.live') : '● ' + t('status.offline'))
              )
            : null
        )
      )
    ),

    // Account details
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, t('settings.account')),
      h('div', { className: 'settings-card-desc' }, t('settings.account_desc')),
      h(Row, {
        icon: '💬', title: t('settings.tg'),
        desc: user?.username ? ('@' + user.username) : t('settings.tg_chatid', { id: user?.chatId || '—' }),
        control: h('span', { className: 'pref-value' }, user?.chatId || '—')
      }),
      h(Row, {
        icon: '💎', title: t('settings.plan'),
        desc: t('settings.plan_desc'),
        control: h('span', { className: 'pref-value' }, planLabels[user?.plan] || user?.plan || '—')
      }),
      subExpiry
        ? h(Row, {
            icon: '📅', title: t('account.subscription'),
            desc: t('account.subscription_desc'),
            control: h('span', { className: 'pref-value' }, subExpiry)
          })
        : null,
      user?.threshold != null
        ? h(AlertSensitivityRow, { initial: user.threshold })
        : null,
      // Per-user subscription to alert types (event / trend / post).
      // Always rendered — there is no "free" gate here, the gate logic is
      // applied server-side in the alert pipeline.
      h(AlertTypesRow, { initial: user?.alertTypes || ['event','trend','post'] }),
      h(Row, {
        icon: '🚪', title: t('settings.logout'),
        desc: t('settings.logout_desc'),
        control: h('button', { className: 'btn btn-ghost', onClick: doLogout }, t('settings.logout'))
      })
    )
  );
}

// ── App ──────────────────────────────────────────────────────────────────────
// ── LoginScreen ──────────────────────────────────────────────────────────────
// Telegram-bot-only login. Flow:
//   1. POST /api/auth/initiate -> sessionId + botUrl
//   2. User clicks Sign in -> bot issues a 6-digit code
//   3. User enters code -> POST /api/auth/verify -> token + user
//
// EN-only by design (top-level pre-auth surface). Strings are hardcoded —
// language switcher lives inside the app, accessible after sign-in.
function LoginScreen({ onLoggedIn }) {
  const [phase, setPhase]       = useState('idle');        // idle | code
  const [session, setSession]   = useState(null);
  const [code, setCode]         = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const startLogin = async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/auth/initiate', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      if (!data.botUrl) throw new Error('Bot is temporarily unavailable. Try again later.');
      setSession(data);
      setPhase('code');
      try { window.open(data.botUrl, '_blank', 'noopener'); } catch (e) {}
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const submitCode = async () => {
    const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
    if (clean.length !== 6) { setError('Enter the 6 digits from the bot message'); return; }
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, code: clean })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      setAuthToken(data.token);
      onLoggedIn && onLoggedIn(data.user);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  // ── Stage page (ambient bg + center card) ──────────────────────────
  // Colors driven by CSS vars — auto-adapts to user's theme (Ink default).
  // Ink: --bg=#000, --accent=#1d9bf0 (X blue), --accent-rgb=29,155,240,
  // --surface=#0a0a0a, --border=rgba(239,243,244,.08).
  return h('div', {
    style: {
      minHeight: '100vh', position: 'relative', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '24px',
      background: 'var(--bg, #000)'
    }
  },
    // Ambient X-blue radial blobs — single accent hue at varying intensities,
    // monochrome by Ink design philosophy. Pure CSS, zero JS repaint.
    h('div', {
      'aria-hidden': 'true',
      style: {
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background:
          'radial-gradient(60% 50% at 18% 22%, rgba(var(--accent-rgb), 0.18) 0%, transparent 60%),' +
          'radial-gradient(50% 40% at 82% 18%, rgba(var(--accent-rgb), 0.10) 0%, transparent 60%),' +
          'radial-gradient(70% 55% at 50% 95%, rgba(var(--accent-rgb), 0.07) 0%, transparent 60%)',
        filter: 'blur(40px)',
      }
    }),
    // Subtle grid overlay (translucent white, faded toward edges)
    h('div', {
      'aria-hidden': 'true',
      style: {
        position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0.35,
        backgroundImage:
          'linear-gradient(rgba(239,243,244,0.03) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgba(239,243,244,0.03) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
        maskImage: 'radial-gradient(70% 70% at 50% 50%, #000 0%, transparent 100%)',
        WebkitMaskImage: 'radial-gradient(70% 70% at 50% 50%, #000 0%, transparent 100%)',
      }
    }),

    // ── Card ────────────────────────────────────────────────────────────
    h('div', {
      style: {
        position: 'relative', zIndex: 1,
        width: '100%', maxWidth: '440px',
        background: 'linear-gradient(180deg, rgba(22,24,28,0.92) 0%, rgba(10,10,10,0.94) 100%)',
        border: '1px solid var(--border, rgba(239,243,244,0.08))',
        borderRadius: '20px',
        padding: '40px 32px 28px',
        boxShadow:
          '0 30px 80px rgba(0,0,0,0.65),' +
          '0 0 0 1px rgba(239,243,244,0.02) inset,' +
          'inset 0 1px 0 rgba(239,243,244,0.04)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }
    },
      // ── Brand mark ────────────────────────────────────────────────────
      // Cat logo on a glowing X-blue tile. PNG via /assets/logo.png?v=...
      // Same cache-bust + onError fallback (🐱) as the nav logo. Transparent
      // PNG sits on the accent glow so the cat reads through cleanly.
      h('div', { style: { textAlign: 'center', marginBottom: '28px' } },
        h('div', {
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 80, height: 80, borderRadius: 20,
            background: 'radial-gradient(120% 100% at 50% 0%, rgba(var(--accent-rgb), 0.22) 0%, rgba(var(--accent-rgb), 0.05) 60%, transparent 100%)',
            border: '1px solid rgba(var(--accent-rgb), 0.20)',
            boxShadow: '0 0 40px rgba(var(--accent-rgb), 0.18), inset 0 1px 0 rgba(239,243,244,0.05)',
            padding: 10, boxSizing: 'border-box',
          }
        },
          h('img', {
            src: '/assets/logo.png?v=' + LOGO_VERSION,
            alt: 'Catalyst',
            style: {
              width: '100%', height: '100%',
              objectFit: 'contain', display: 'block',
            },
            onError: (e) => {
              // Mirror nav logo: drop the broken <img>, fall back to 🐱
              const tile = e.target.parentNode;
              if (tile) {
                tile.removeChild(e.target);
                tile.style.fontSize = '38px';
                tile.style.lineHeight = '1';
                tile.style.padding = '0';
                tile.textContent = '\u{1F431}'; // 🐱
              }
            },
          })
        ),
        h('h1', {
          style: {
            margin: '18px 0 0', fontSize: 30, fontWeight: 800,
            letterSpacing: '-0.02em', lineHeight: 1.1,
            background: 'linear-gradient(180deg, var(--text, #e7e9ea) 0%, var(--text2, #c4c8cc) 100%)',
            WebkitBackgroundClip: 'text', backgroundClip: 'text',
            WebkitTextFillColor: 'transparent', color: 'transparent',
          }
        }, 'Catalyst'),
        h('div', {
          style: {
            marginTop: 8, fontSize: 14, lineHeight: 1.45,
            color: 'var(--muted, #71767b)',
            // Short copy fits full card width on one line (39 chars). No
            // maxWidth, no nowrap — falls back gracefully on tiny screens.
          }
        }, 'Track narratives across the social web.')
      ),

      // ── Idle phase (default) ──────────────────────────────────────────
      phase === 'idle' && h('div', null,
        // 3-row mini feature list
        h('div', {
          style: {
            display: 'grid', rowGap: 10,
            padding: '14px 14px',
            background: 'rgba(239,243,244,0.025)',
            border: '1px solid var(--border, rgba(239,243,244,0.08))',
            borderRadius: 12,
            marginBottom: 22,
          }
        },
          [
            { i: '📡', t: 'Multi-source feed', s: 'Reddit · X · TikTok · Google · X Trends' },
            { i: '🎯', t: 'Trend scoring',     s: 'Memetic potential, virality, emergence' },
            { i: '🔔', t: 'Real-time alerts',  s: 'Direct to your Telegram, instantly' },
          ].map((row, i) =>
            h('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 12 } },
              h('div', {
                style: {
                  flex: '0 0 32px', height: 32, borderRadius: 8,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16,
                  background: 'rgba(239,243,244,0.04)',
                  border: '1px solid var(--border, rgba(239,243,244,0.08))',
                }
              }, row.i),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--text, #e7e9ea)' } }, row.t),
                h('div', { style: { fontSize: 11, color: 'var(--muted, #71767b)', marginTop: 2 } }, row.s)
              )
            )
          )
        ),

        // ── Primary CTA — X-blue glossy ───────────────────────────────
        h('button', {
          onClick: startLogin,
          disabled: loading,
          style: {
            width: '100%', padding: '14px 18px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            fontSize: 15, fontWeight: 700, letterSpacing: '0.01em',
            color: '#fff',
            background: 'linear-gradient(180deg, var(--accent, #1d9bf0) 0%, #146da8 100%)',
            border: '1px solid rgba(var(--accent-rgb), 0.40)',
            borderRadius: 12,
            cursor: loading ? 'wait' : 'pointer',
            // Flat — outer glow only, no inset highlight/shadow that read as
            // a stripe on the button surface.
            boxShadow: '0 8px 24px rgba(var(--accent-rgb), 0.26)',
            opacity: loading ? 0.7 : 1,
            transition: 'transform 120ms ease, box-shadow 120ms ease',
          },
          onMouseEnter: (e) => { if (!loading) e.currentTarget.style.transform = 'translateY(-1px)'; },
          onMouseLeave: (e) => { e.currentTarget.style.transform = 'translateY(0)'; },
        },
          // Paper-plane glyph — Material "send" silhouette rotated -25 deg
          // so the tip points up-right (Telegram's logo orientation),
          // instead of straight right (which read as a directional arrow).
          h('svg', {
            width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor',
            style: { display: 'block', transform: 'rotate(-25deg)' }
          },
            h('path', { d: 'M2.01 21l20.99-9L2.01 3 2 10l15 2-15 2z' })
          ),
          loading ? 'Please wait…' : 'Sign in with Telegram'
        ),

        h('div', {
          style: {
            marginTop: 16, fontSize: 11, lineHeight: 1.5,
            color: 'var(--dim, #4d5258)', textAlign: 'center',
          }
        }, "No password needed. We'll send a one-time code to your Telegram.")
      ),

      // ── Code phase (after click "Sign in") ────────────────────────────
      phase === 'code' && h('div', null,
        h('p', {
          style: {
            fontSize: 13, lineHeight: 1.55,
            color: 'var(--text2, #c4c8cc)',
            margin: '0 0 14px',
          }
        }, "Open the bot and tap Start — it'll send a 6-digit code. Paste it below:"),
        session?.botUrl && h('a', {
          href: session.botUrl, target: '_blank', rel: 'noopener',
          style: {
            display: 'block', textAlign: 'center',
            padding: '10px 14px', marginBottom: 16,
            fontSize: 13, fontWeight: 500,
            background: 'rgba(var(--accent-rgb), 0.10)',
            color: 'var(--accent2, #4cb1ff)',
            border: '1px solid rgba(var(--accent-rgb), 0.30)',
            borderRadius: 10,
            textDecoration: 'none',
          }
        }, '↗ Reopen the bot'),
        h('input', {
          type: 'text', inputMode: 'numeric', pattern: '[0-9]*', autoFocus: true,
          maxLength: 6, value: code,
          onChange: e => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6);
            setCode(v);
            if (error) setError('');
          },
          onKeyDown: e => { if (e.key === 'Enter' && code.length === 6 && !loading) submitCode(); },
          placeholder: '• • • • • •',
          style: {
            width: '100%', padding: '16px',
            fontSize: 24, letterSpacing: '0.45em', textAlign: 'center',
            color: 'var(--text, #e7e9ea)',
            background: 'rgba(0,0,0,0.45)',
            border: '1px solid var(--border, rgba(239,243,244,0.08))',
            borderRadius: 12,
            fontFamily: 'ui-monospace, monospace',
            marginBottom: 14, boxSizing: 'border-box',
            outline: 'none',
          }
        }),
        h('button', {
          onClick: submitCode,
          disabled: loading || code.length !== 6,
          style: {
            width: '100%', padding: '14px 18px',
            fontSize: 15, fontWeight: 700,
            color: '#fff',
            background: code.length === 6
              ? 'linear-gradient(180deg, var(--accent, #1d9bf0) 0%, #146da8 100%)'
              : 'rgba(239,243,244,0.06)',
            border: '1px solid ' + (code.length === 6 ? 'rgba(var(--accent-rgb), 0.40)' : 'var(--border, rgba(239,243,244,0.08))'),
            borderRadius: 12,
            cursor: (loading || code.length !== 6) ? 'not-allowed' : 'pointer',
            // Flat — outer glow only, matches the primary CTA above.
            boxShadow: code.length === 6
              ? '0 8px 24px rgba(var(--accent-rgb), 0.24)'
              : 'none',
            opacity: loading ? 0.7 : 1,
            transition: 'background 120ms ease, box-shadow 120ms ease',
          },
        }, loading ? 'Verifying…' : 'Sign in'),
        h('button', {
          onClick: () => { setPhase('idle'); setSession(null); setCode(''); setError(''); },
          style: {
            width: '100%', marginTop: 10, padding: '10px',
            fontSize: 12,
            color: 'var(--muted, #71767b)',
            background: 'transparent', border: 'none',
            cursor: 'pointer',
          }
        }, 'Cancel')
      ),

      // ── Error toast (semantic red — constant across themes) ──────────
      error && h('div', {
        style: {
          marginTop: 14, padding: '10px 12px',
          fontSize: 13, lineHeight: 1.4,
          color: 'var(--red2, #ff6b6b)',
          background: 'rgba(var(--red-rgb), 0.08)',
          border: '1px solid rgba(var(--red-rgb), 0.25)',
          borderRadius: 10,
        }
      }, error)
    ),

    // ── Footer — Twitter/X follow link, subtle ───────────────────────
    // Uses the same handle as the in-app nav (https://x.com/Catalystparser).
    // Active CTA, not decoration: pre-auth users discover the brand on X.
    h('a', {
      href: 'https://x.com/Catalystparser',
      target: '_blank',
      rel: 'noopener noreferrer',
      style: {
        position: 'relative', zIndex: 1,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        marginTop: 20, padding: '6px 12px',
        fontSize: 12, fontWeight: 500,
        color: 'var(--muted, #71767b)',
        background: 'rgba(239,243,244,0.025)',
        border: '1px solid var(--border, rgba(239,243,244,0.08))',
        borderRadius: 999,
        textDecoration: 'none',
        transition: 'color 120ms ease, background 120ms ease, border-color 120ms ease',
      },
      onMouseEnter: (e) => {
        e.currentTarget.style.color = 'var(--text, #e7e9ea)';
        e.currentTarget.style.background = 'rgba(239,243,244,0.05)';
        e.currentTarget.style.borderColor = 'rgba(239,243,244,0.18)';
      },
      onMouseLeave: (e) => {
        e.currentTarget.style.color = 'var(--muted, #71767b)';
        e.currentTarget.style.background = 'rgba(239,243,244,0.025)';
        e.currentTarget.style.borderColor = 'var(--border, rgba(239,243,244,0.08))';
      },
    },
      h('span', { style: { fontSize: 13, lineHeight: 1 } }, '\u{1D54F}'),
      h('span', null, '@Catalystparser')
    )
  );
}

// Draggable column resizer — live-updates a CSS var while dragging,
// then persists the final width to ts_prefs_v1 on mouseup/touchend.
// Uses raw DOM (no React re-renders per frame) for 60fps smoothness.
function ColumnResizer({ side }) {
  const varName = side === 'left' ? '--col-left' : '--col-right';
  const prefKey = side === 'left' ? 'colLeft'    : 'colRight';
  const min     = side === 'left' ? 180 : 240;
  const max     = side === 'left' ? 540 : 630;

  const start = (clientX) => {
    const root = document.documentElement;
    const raw = getComputedStyle(root).getPropertyValue(varName).trim();
    const startWidth = parseInt(raw, 10) || (side === 'left' ? 240 : 300);
    const startX = clientX;
    document.body.classList.add('is-resizing');

    let currentW = startWidth;
    const move = (x) => {
      const delta = side === 'left' ? (x - startX) : (startX - x);
      currentW = Math.max(min, Math.min(max, startWidth + delta));
      root.style.setProperty(varName, currentW + 'px');
    };
    const onMove       = (ev) => { move(ev.clientX); };
    const onTouchMove  = (ev) => { if (ev.touches[0]) move(ev.touches[0].clientX); };
    const end = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', end);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', end);
      document.body.classList.remove('is-resizing');
      try {
        const current = loadPrefs();
        savePrefs({ ...current, [prefKey]: currentW });
      } catch (e) {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', end);
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', end);
  };

  // Double-click → reset to default
  const onDoubleClick = () => {
    const def = side === 'left' ? 240 : 300;
    document.documentElement.style.setProperty(varName, def + 'px');
    try {
      const current = loadPrefs();
      savePrefs({ ...current, [prefKey]: def });
    } catch (e) {}
  };

  return h('div', {
    className: 'col-resizer col-resizer-' + side,
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize ' + side + ' column (double-click to reset)',
    title: 'Drag to resize · double-click to reset',
    onMouseDown: (e) => { e.preventDefault(); start(e.clientX); },
    onTouchStart: (e) => { if (e.touches[0]) start(e.touches[0].clientX); },
    onDoubleClick,
  });
}

// Unified bottom nav — shown in both trends sidebar and settings/stats sidebar.
// Three tabs: Feed / Saved / Analyze. Saved is a *filtered* view of Feed
// (toggles favoritesOnly state), not a separate route — but rendered as a
// tab so it sits in the user's primary nav surface alongside Feed/Analyze.
// Plan-locked tabs (Saved for free/test, Analyze for free) render with 🔒
// and emit an upgrade toast on click instead of switching view.
function BottomNav({ view, setView, me, favoritesOnly, setFavoritesOnly, favoriteCount, setOffset, addToast }) {
  useLang(); // re-render on language switch
  const manualCap = (me && me.entitlements && typeof me.entitlements.manualAnalyze === 'number') ? me.entitlements.manualAnalyze : 0;
  const analyzeLocked = manualCap === 0;
  const canFav = !!(me && me.entitlements && me.entitlements.favorites);
  const savedLocked = !canFav;

  // Active-tab logic: Analyze when on its view; Saved when on trends with
  // favoritesOnly; otherwise Feed. Three buttons are mutually exclusive
  // visually even though only the view variable is real route state.
  const activeKey =
    view === 'analyze' ? 'analyze' :
    (view === 'trends' && favoritesOnly && canFav) ? 'saved' :
    'trends';

  const tabs = [
    { id: 'trends',  icon: '🔥',                              label: t('nav.feed'),    locked: false        },
    { id: 'saved',   icon: savedLocked ? '🔒' : '⭐',          label: t('nav.saved'),   locked: savedLocked  },
    { id: 'analyze', icon: analyzeLocked ? '🔒' : '🧪',       label: t('nav.analyze'), locked: analyzeLocked },
  ];

  const persistFav = (next) => {
    try { localStorage.setItem('ts_favorites_only', next ? '1' : '0'); } catch (e) {}
  };

  return h('div', { className: 'sidebar-footer' },
    h('div', {
      className: 'sb-foot-nav',
      role: 'tablist',
      style: { gridTemplateColumns: 'repeat(' + tabs.length + ', 1fr)' },
    },
      tabs.map(tab => h('button', {
        key: tab.id,
        type: 'button',
        role: 'tab',
        'aria-selected': activeKey === tab.id,
        className: 'sb-foot-btn' + (activeKey === tab.id ? ' active' : '') + (tab.locked ? ' locked' : ''),
        onClick: () => {
          if (tab.locked) {
            const lockMsg = tab.id === 'saved' ? t('fav.locked_toast') : t('analyze.locked_toast');
            if (typeof addToast === 'function') addToast(lockMsg, 'info');
            return;
          }
          if (tab.id === 'saved') {
            // Toggle favoritesOnly + ensure we're on the trends view. If
            // already on Saved, clicking again turns the filter off (acts
            // as "back to all"). Reset pagination so we don't open page-2
            // of a freshly-applied filter.
            const next = !(favoritesOnly && view === 'trends');
            setFavoritesOnly(next);
            persistFav(next);
            if (typeof setOffset === 'function') setOffset(0);
            if (view !== 'trends') setView('trends');
          } else if (tab.id === 'trends') {
            // Plain Feed — clear favorites filter to avoid surprise empty
            // feed if the user was on Saved.
            if (favoritesOnly) {
              setFavoritesOnly(false);
              persistFav(false);
              if (typeof setOffset === 'function') setOffset(0);
            }
            setView('trends');
          } else {
            setView(tab.id);
          }
        },
        title: tab.locked
          ? (tab.id === 'saved' ? t('fav.locked_tooltip') : t('analyze.locked_tooltip'))
          : tab.label,
      },
        h('span', { className: 'sb-foot-ico' }, tab.icon),
        h('span', null,
          tab.label,
          // Counter on Saved tab — shown only for Pro/Admin with at least
          // one favorite saved. Tiny dim badge to the right of the label.
          (tab.id === 'saved' && canFav && favoriteCount > 0)
            ? h('span', { style: { marginLeft: 4, opacity: 0.6, fontSize: 10 } }, favoriteCount)
            : null
        )
      ))
    )
  );
}

function App() {
  useLang();
  // Auth: null = checking, false = logged out, object = logged in
  const [me,         setMe]         = useState(AUTH_TOKEN ? null : false);
  const [stats,      setStats]      = useState(null);
  const [trends,     setTrends]     = useState([]);
  const [sources,    setSources]    = useState([]);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [category,   setCategory]   = useState('');
  const [source,     setSource]     = useState('');
  const [hours,      setHours]      = useState(24);
  const [offset,     setOffset]     = useState(0);
  const [scanning,   setScanning]   = useState(false);
  const [sort,       setSort]       = useState('rank');
  // Phase filter — multi-select. Stored as a sorted comma-separated string
  // (e.g. 'early,strong'); empty string = no restriction. Persisted in
  // localStorage. Clicking a chip toggles its membership; the "Все" chip
  // clears the whole set.
  const [phases,     setPhases]     = useState(() => {
    try {
      const v = localStorage.getItem('ts_phase_filter') || '';
      const valid = v.split(',').map(s => s.trim()).filter(s =>
        ['early','forming','strong','saturated'].includes(s)
      );
      return valid.sort().join(',');
    } catch (e) { return ''; }
  });
  const [view,       setView]       = useState('trends');
  const [modalTrend, setModalTrend] = useState(null);
  const [toasts,     setToasts]     = useState([]);
  // Per-user hide: optimistic-remove via localHidden until next server fetch
  // (server filters them out via hidden_trends table). pendingUndo holds the
  // single most-recently hidden trend for the bottom undo toast (5s window).
  const [localHidden, setLocalHidden] = useState(() => new Set());
  const [pendingUndo, setPendingUndo] = useState(null); // { trend, expiresAt }
  const undoTimerRef = useRef(null);
  const [search,     setSearch]     = useState('');
  // Debounced mirror of "search" — drives server-side q-param fetches with
  // 250ms throttle so we don't spam /api/trends per keystroke. The raw
  // "search" state still updates immediately (controlled input + UI
  // affordances like the "0 / N" counter / Reset chip / empty-state copy).
  const [searchDebounced, setSearchDebounced] = useState('');
  useEffect(() => {
    const tid = setTimeout(() => setSearchDebounced(search), 250);
    return () => clearTimeout(tid);
  }, [search]);
  // Reset pagination when the effective query changes so we always start on
  // page 0 of the filtered result set, not the middle of the unfiltered one.
  useEffect(() => { setOffset(0); }, [searchDebounced]);
  const [refreshAt,  setRefreshAt]  = useState(Date.now() + 90000);
  // Refresh pulse — stays on for at least MIN_PULSE_MS so the animation is visible
  // even when fetchData resolves in <200ms.
  const [refreshPulse, setRefreshPulse] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hiddenSources, setHiddenSources] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ts_hidden_sources') || '[]')); }
    catch (e) { return new Set(); }
  });
  // "Manual only" filter — when true, restricts the feed to manually-submitted
  // trends (flagged via raw_metrics.manualSubmitted). Persisted in localStorage.
  const [manualOnly, setManualOnly] = useState(() => {
    try { return localStorage.getItem('ts_manual_only') === '1'; }
    catch (e) { return false; }
  });
  // "Saved only" (favorites-only) filter — Pro/Admin. Server-side filter
  // (?favoritesOnly=1) so pagination doesn't skip non-faved rows. Persisted
  // in localStorage; cleared on logout if user downgrades.
  const [favoritesOnly, setFavoritesOnly] = useState(() => {
    try { return localStorage.getItem('ts_favorites_only') === '1'; }
    catch (e) { return false; }
  });
  // Counter — how many trends user has saved overall (not the current view).
  // Updated optimistically by toggleFavorite + on every /api/trends pull
  // (server returns favoriteCount in payload).
  const [favoriteCount, setFavoriteCount] = useState(0);
  // Alert-type chip filter — multi-select. Stored as sorted comma-separated
  // string (e.g. 'event,post'); empty string = all. Pure client-side (the
  // feed already includes the type per-row), so no round-trip to the server.
  // Persisted in localStorage. Backwards-compat: legacy single-value entries
  // ('event') stay valid as 1-element CSV.
  const [alertTypes, setAlertTypes] = useState(() => {
    try {
      const v = localStorage.getItem('ts_alert_type_filter') || '';
      const valid = v.split(',').map(s => s.trim()).filter(s =>
        ['event','trend','post'].includes(s)
      );
      return valid.sort().join(',');
    } catch (e) { return ''; }
  });
  const toastId = useRef(0);
  const sentinelRef = useRef(null);
  const mainFeedRef = useRef(null);
  const LIMIT = 25;

  // Scroll-to-top button — shown when user scrolls the main feed below
  // SCROLL_TOP_THRESHOLD. Listener is attached to the .main-feed element
  // (NOT window) because the feed has its own overflow-y:auto scroll root.
  // Dep on "me" (auth) is critical: on first render the auth gate returns
  // LoginScreen, so .main-feed isn't in the DOM yet and the ref is null.
  // We need the effect to re-run once auth flips so it actually subscribes
  // to scroll on the real element. "view" is included too because the main
  // feed only mounts on the feed view — switching tabs remounts the node
  // and the listener has to re-attach to the fresh DOM element.
  const [showScrollTop, setShowScrollTop] = useState(false);
  // Horizontal center of the .main-feed column in viewport-px. Used as
  // inline "left" on the scroll-to-top button so it sits over the feed's
  // visual middle, not the viewport's (sidebars are wide + draggable).
  // Tracks via ResizeObserver on the feed element + window resize, so the
  // button re-centers when the column resizer is dragged.
  const [feedCenterX, setFeedCenterX] = useState(null);
  useEffect(() => {
    if (!me) return;                       // not authed yet, main isn't mounted
    const el = mainFeedRef.current;
    if (!el) return;
    const SCROLL_TOP_THRESHOLD = 400;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        setShowScrollTop((el.scrollTop || 0) > SCROLL_TOP_THRESHOLD);
        ticking = false;
      });
    };
    const recomputeCenter = () => {
      const r = el.getBoundingClientRect();
      setFeedCenterX(r.left + r.width / 2);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', recomputeCenter);
    // ResizeObserver fires when the column resizer drags the sidebar and
    // changes .main-feed's width without a window resize event.
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recomputeCenter);
      ro.observe(el);
    }
    // Run once immediately in case feed is already scrolled (e.g. user
    // navigated away and came back — browser preserves scrollTop).
    onScroll();
    recomputeCenter();
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', recomputeCenter);
      if (ro) ro.disconnect();
    };
  }, [me, view]);
  const scrollFeedToTop = useCallback(() => {
    const el = mainFeedRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // addToast helper — auto-dismiss after 3s
  const addToast = useCallback((msg, type = 'info') => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  // ── Per-trend hide / undo ─────────────────────────────────────────────────
  // Click ✕ on a card → optimistic remove via localHidden + POST /hide. The
  // bottom undo toast is exclusive (only 1 at a time); a second hide bumps
  // the previous one. After 5s the toast vanishes and the trend stays hidden
  // until the user restores it from Settings → Archive.
  const hideTrend = useCallback(async (trend) => {
    if (!trend?.id) return;
    setLocalHidden(prev => { const n = new Set(prev); n.add(trend.id); return n; });
    // Set undo target — replaces previous one (single-toast policy).
    if (undoTimerRef.current) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null; }
    setPendingUndo({ trend, expiresAt: Date.now() + 5000 });
    undoTimerRef.current = setTimeout(() => setPendingUndo(null), 5000);
    try {
      await api('/trends/' + trend.id + '/hide', { method: 'POST' });
    } catch (e) {
      // Server reject → roll back local hide and show error toast. Don't
      // touch pendingUndo — the user already pressed ✕ and got feedback.
      setLocalHidden(prev => { const n = new Set(prev); n.delete(trend.id); return n; });
      addToast('⚠ ' + (e.message || 'hide failed'), 'error');
    }
  }, [addToast]);

  const undoHide = useCallback(async (trend) => {
    if (!trend?.id) return;
    if (undoTimerRef.current) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null; }
    setPendingUndo(null);
    setLocalHidden(prev => { const n = new Set(prev); n.delete(trend.id); return n; });
    try {
      await api('/trends/' + trend.id + '/unhide', { method: 'POST' });
    } catch (e) {
      addToast('⚠ ' + (e.message || 'undo failed'), 'error');
    }
  }, [addToast]);

  // ── Favorites toggle (Pro/Admin) ─────────────────────────────────────────
  // Optimistic UI: flip trend.isFavorite immediately in both the trends list
  // and the open modal trend, fire the request. On 403 (plan) → roll back +
  // show locked toast (defensive — UI shouldn't render the button for Free
  // anyway). On other failure → roll back + error toast. On success → toast
  // + brief pulse animation on the source button (passed as 2nd arg).
  const toggleFavorite = useCallback(async (trend, btnEl = null) => {
    if (!trend?.id) return;
    const wasFav = !!trend.isFavorite;
    const willFav = !wasFav;
    // Optimistic: patch the trend in both feed list and modal state
    const patch = (t) => (t && t.id === trend.id) ? { ...t, isFavorite: willFav } : t;
    setTrends(prev => prev.map(patch));
    setModalTrend(prev => patch(prev));
    setFavoriteCount(prev => Math.max(0, prev + (willFav ? 1 : -1)));
    // Pulse animation (one-shot)
    if (btnEl && willFav) {
      btnEl.classList.add('just-saved');
      setTimeout(() => btnEl.classList.remove('just-saved'), 450);
    }
    try {
      await api('/trends/' + trend.id + '/favorite', {
        method: willFav ? 'POST' : 'DELETE',
      });
      addToast(willFav ? t('fav.added_toast') : t('fav.removed_toast'), 'info');
    } catch (e) {
      // Rollback
      setTrends(prev => prev.map(t => (t && t.id === trend.id) ? { ...t, isFavorite: wasFav } : t));
      setModalTrend(prev => (prev && prev.id === trend.id) ? { ...prev, isFavorite: wasFav } : prev);
      setFavoriteCount(prev => Math.max(0, prev + (willFav ? -1 : 1)));
      if (e.status === 403) addToast(t('fav.locked_toast'), 'info');
      else addToast('⚠ ' + (e.message || 'favorite failed'), 'error');
    }
  }, [addToast]);

  // PATCH /api/trends/:id/favorite — update the note on an already-favorited
  // trend. Optimistic update of the modal trend's favoriteNote field; on
  // failure rollback + error toast.
  const saveFavNote = useCallback(async (trend, note) => {
    if (!trend?.id) return;
    const trimmed = String(note || '').trim().slice(0, 500);
    const prev = trend.favoriteNote || null;
    setModalTrend(p => (p && p.id === trend.id) ? { ...p, favoriteNote: trimmed || null } : p);
    setTrends(prevList => prevList.map(t => (t && t.id === trend.id) ? { ...t, favoriteNote: trimmed || null } : t));
    try {
      await api('/trends/' + trend.id + '/favorite', {
        method: 'PATCH',
        body: JSON.stringify({ note: trimmed }),
      });
    } catch (e) {
      setModalTrend(p => (p && p.id === trend.id) ? { ...p, favoriteNote: prev } : p);
      setTrends(prevList => prevList.map(t => (t && t.id === trend.id) ? { ...t, favoriteNote: prev } : t));
      addToast('⚠ ' + (e.message || 'note save failed'), 'error');
    }
  }, [addToast]);

  const fetchData = useCallback(async () => {
    const started = Date.now();
    const MIN_PULSE_MS = 650; // minimum duration the refresh indicator stays visible
    setRefreshAt(Date.now() + 90000);
    // Offset > 0 means the user scrolled — append next page, don't replace.
    const shouldAppend = offset > 0;
    if (shouldAppend) setLoadingMore(true);
    else { setLoading(true); setRefreshPulse(true); }
    setError('');
    try {
      const q = '?hours=' + hours + '&limit=' + LIMIT + '&offset=' + offset +
        '&sort=' + sort +
        (category ? '&category=' + category : '') +
        (source   ? '&source='   + source   : '') +
        (phases   ? '&phase='    + phases   : '') +
        (searchDebounced.trim() ? '&q=' + encodeURIComponent(searchDebounced.trim()) : '') +
        (favoritesOnly ? '&favoritesOnly=1' : '');

      const [st, tr, sr] = await Promise.all([
        api('/stats?hours=' + hours),
        api('/trends' + q),
        api('/sources'),
      ]);
      setStats(st);
      setTotal(tr.total  || 0);
      // Server returns total favorites count in feed payload — use as the
      // sidebar badge counter. Falls back to current value if undefined
      // (e.g. when /api/trends is called before the feature is deployed).
      if (typeof tr.favoriteCount === 'number') setFavoriteCount(tr.favoriteCount);
      if (shouldAppend) {
        const incoming = tr.trends || [];
        setTrends(prev => {
          // Dedupe by id in case page boundary shifted due to new inserts
          const have = new Set(prev.map(x => x.id));
          return [...prev, ...incoming.filter(x => !have.has(x.id))];
        });
      } else {
        setTrends(tr.trends || []);
        // Server is the source of truth for hidden — clear the optimistic
        // local set so a "Restore" from the archive (which un-hides on
        // server) lets the trend reappear in the feed.
        setLocalHidden(new Set());
      }
      setSources(sr.sources || []);
    } catch (ex) { setError(t('toast.error_prefix', { e: ex.message })); }
    if (shouldAppend) setLoadingMore(false);
    else setLoading(false);
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, MIN_PULSE_MS - elapsed);
    setTimeout(() => setRefreshPulse(false), remaining);
  }, [hours, category, source, phases, offset, sort, favoritesOnly, searchDebounced]);

  // Full refresh for SSE 'refresh' events and the manual refresh button.
  // Refetches from the top with a big enough limit to cover every page the
  // user has already scrolled through, then replaces the list. Keeps scroll
  // position since React reuses nodes by stable id key.
  const refreshAll = useCallback(async () => {
    const started = Date.now();
    const MIN_PULSE_MS = 650;
    setRefreshAt(Date.now() + 90000);
    setRefreshPulse(true);
    setError('');
    try {
      const fetchLimit = Math.max(LIMIT, offset + LIMIT);
      const q = '?hours=' + hours + '&limit=' + fetchLimit + '&offset=0' +
        '&sort=' + sort +
        (category ? '&category=' + category : '') +
        (source   ? '&source='   + source   : '') +
        (phases   ? '&phase='    + phases   : '') +
        (searchDebounced.trim() ? '&q=' + encodeURIComponent(searchDebounced.trim()) : '') +
        (favoritesOnly ? '&favoritesOnly=1' : '');
      const [st, tr, sr] = await Promise.all([
        api('/stats?hours=' + hours),
        api('/trends' + q),
        api('/sources'),
      ]);
      setStats(st);
      setTotal(tr.total || 0);
      setTrends(tr.trends || []);
      if (typeof tr.favoriteCount === 'number') setFavoriteCount(tr.favoriteCount);
      // Reset optimistic local-hide on full reload — server is authoritative.
      setLocalHidden(new Set());
      setSources(sr.sources || []);
    } catch (ex) { setError(t('toast.error_prefix', { e: ex.message })); }
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, MIN_PULSE_MS - elapsed);
    setTimeout(() => setRefreshPulse(false), remaining);
  }, [hours, category, source, phases, offset, sort, favoritesOnly, searchDebounced]);


  // Resolve the authenticated user on load / whenever the token changes.
  useEffect(() => {
    const sync = (tok) => {
      if (!tok) { setMe(false); return; }
      setMe(prev => (prev && prev !== true) ? prev : null);
      api('/auth/me').then(d => setMe(d.user || false)).catch(() => setMe(false));
    };
    sync(AUTH_TOKEN);
    return onAuthChange(sync);
  }, []);

  const handleLoggedIn = useCallback((user) => { setMe(user || null); }, []);
  const handleLogout   = useCallback(() => { setAuthToken(''); setMe(false); }, []);

  // Only fetch trends/stats/sources after we have a valid session.
  // Fresh data arrives via SSE ('refresh' event from the scanner) — no polling.
  useEffect(() => { if (me && me !== true) fetchData(); }, [fetchData, me]);

  // Keep a ref to the latest refreshAll so the SSE effect below doesn't need
  // to reconnect every time a filter / offset changes (refreshAll's identity
  // changes on every state transition).
  const refreshAllRef = useRef(refreshAll);
  useEffect(() => { refreshAllRef.current = refreshAll; }, [refreshAll]);

  // ── Live stream (Server-Sent Events) — push-based real-time refresh ─────────
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    let es = null;
    let refreshTimer = null;
    let stopped = false;

    const scheduleRefresh = (delay = 600) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshAllRef.current?.();
      }, delay);
    };

    const connect = () => {
      if (stopped) return;
      if (!AUTH_TOKEN) return; // skip stream until user is signed in
      try {
        // EventSource can't set custom headers — pass token as query param
        es = new EventSource('/api/stream?token=' + encodeURIComponent(AUTH_TOKEN));
      } catch (e) { return; }

      es.addEventListener('hello', () => { /* connected */ });
      es.addEventListener('scan-start', () => {
        setScanning(true);
        // safety reset in case the completion event is missed
        setTimeout(() => setScanning(false), 90_000);
      });
      es.addEventListener('refresh', () => {
        setScanning(false);
        scheduleRefresh(400);
      });
      es.onerror = () => {
        // EventSource auto-reconnects — browser uses the retry interval
        // we send in the stream handshake.
      };
    };

    connect();

    return () => {
      stopped = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (es) { try { es.close(); } catch (e) {} }
    };
  }, []);

  // ── Infinite scroll ────────────────────────────────────────────────────────
  // Auto-load the next page when the sentinel div enters the main feed's
  // scroll viewport. Disabled while searching (search filters loaded data).
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    // 2026-05-14: removed the "if (search.trim()) return" guard — server now
    // paginates filtered results, so infinite scroll walks page 2+ of search.
    if (loading || loadingMore) return;   // don't stack requests
    if (trends.length === 0) return;      // nothing to page from yet
    if (trends.length >= total) return;   // loaded everything

    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        setOffset(o => o + LIMIT);
      }
    }, {
      root: mainFeedRef.current || null,  // use main-feed as scroll root
      rootMargin: '300px',                // pre-load before user hits bottom
      threshold: 0,
    });
    io.observe(node);
    return () => io.disconnect();
  }, [loading, loadingMore, trends.length, total]);
  useEffect(() => {
    const handleNavigate = (event) => {
      const nextView = event && event.detail ? event.detail.view : null;
      if (nextView) setView(nextView);
    };
    window.addEventListener('dashboard:navigate', handleNavigate);
    return () => window.removeEventListener('dashboard:navigate', handleNavigate);
  }, []);

  // useLinkHover emits 'link-metrics-update' when a hover preview returns
  // fresh engagement numbers (Twitter via fxtwitter, Reddit via reddit.com
  // public JSON). Patch matching trend in local state so feed card +
  // open modal update instantly, without waiting for /api/trends refresh.
  // Backend already wrote the same data to DB.
  useEffect(() => {
    const reTweet  = new RegExp(
      '(?:twitter\\\\.com|x\\\\.com)/[^/]+/status/(\\\\d+)', 'i'
    );
    const reReddit = new RegExp('reddit\\\\.com/.*?/comments/([a-z0-9]{4,12})', 'i');

    const numOr = (val, prev) =>
      typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : prev;

    // Build the new engagement shape based on platform. We map provider
    // field names → unified trend.engagement keys:
    //   Twitter: views/likes/retweets/replies → views/likes/reposts/comments
    //   Reddit:  upvotes/comments             → views/likes/comments
    //            (Reddit has no separate "likes" or "reposts" — we put the
    //            score under views so the existing card UI's first slot is
    //            populated, and likes/reposts stay null to read as "n/a")
    const mergeEngagement = (kind, m, e) => {
      if (kind === 'reddit') {
        return {
          ...e,
          // For Reddit we leave .views/.likes/.reposts as-is; upvotes goes
          // into views (Reddit's display convention; matches the modal's
          // existing fallback metrics.upvotes ?? metrics.views ?? null).
          views:    numOr(m.upvotes,  e.views),
          comments: numOr(m.comments, e.comments),
        };
      }
      return {
        ...e,
        views:    numOr(m.views,    e.views),
        likes:    numOr(m.likes,    e.likes),
        comments: numOr(m.replies,  e.comments),
        reposts:  numOr(m.retweets, e.reposts),
      };
    };

    const handle = (event) => {
      const det = event?.detail || {};
      const kind = det.kind === 'reddit' ? 'reddit' : 'tweet';
      const id   = det.id;
      const m    = det.metrics || {};
      const velocity = typeof det.velocity === 'number' && det.velocity >= 0
        ? det.velocity : null;
      if (!id) return;

      const re = kind === 'reddit' ? reReddit : reTweet;

      setTrends(prev => {
        let changed = false;
        const next = prev.map(t => {
          const urlMatch = String(t.url || '').match(re);
          if (!urlMatch || urlMatch[1] !== id) return t;
          const e = t.engagement || {};
          const newEng = mergeEngagement(kind, m, e);
          const newVelocity = velocity !== null ? velocity : t.velocity;
          // Cheap shallow-equal: skip render when nothing actually changed.
          const same =
            newEng.views    === e.views &&
            newEng.likes    === e.likes &&
            newEng.comments === e.comments &&
            newEng.reposts  === e.reposts &&
            newVelocity     === t.velocity;
          if (same) return t;
          changed = true;
          return { ...t, engagement: newEng, velocity: newVelocity };
        });
        return changed ? next : prev;
      });

      setModalTrend(prev => {
        if (!prev) return prev;
        const urlMatch = String(prev.url || '').match(re);
        if (!urlMatch || urlMatch[1] !== id) return prev;
        const e = prev.engagement || {};
        return {
          ...prev,
          engagement: mergeEngagement(kind, m, e),
          velocity: velocity !== null ? velocity : prev.velocity,
        };
      });
    };

    window.addEventListener('link-metrics-update', handle);
    return () => window.removeEventListener('link-metrics-update', handle);
  }, []);

  // Keyboard shortcuts: R=refresh, Esc=close modal → else return to feed
  useEffect(() => {
    const fn = e => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (modalTrend) { setModalTrend(null); return; }
        if (view !== 'trends') { setView('trends'); return; }
        return;
      }
      if (e.key === 'r' || e.key === 'R') { refreshAll(); addToast(t('toast.refreshing'), 'info'); return; }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [refreshAll, addToast, modalTrend, view]);

  // Visual-only source filter. Does NOT touch the collectors —
  // real enable/disable lives in the admin panel. This only hides
  // trends from the selected source in the dashboard feed.
  const toggle = (name) => {
    setHiddenSources(prev => {
      const next = new Set(prev);
      const willHide = !next.has(name);
      if (willHide) next.add(name); else next.delete(name);
      try { localStorage.setItem('ts_hidden_sources', JSON.stringify([...next])); } catch (e) {}
      const label = SOURCE_LABELS[name] || name;
      addToast(willHide ? t('toast.hidden_from_feed', { name: label }) : t('toast.shown_in_feed', { name: label }), 'info');
      return next;
    });
  };

  const showAllSources = () => {
    if (!hiddenSources.size) return;
    setHiddenSources(new Set());
    try { localStorage.setItem('ts_hidden_sources', '[]'); } catch (e) {}
    addToast(t('toast.all_sources_visible'), 'info');
  };
  const resetFilters = () => {
    setHours(24); setCategory(''); setSource(''); setSort('rank'); setOffset(0);
    addToast(t('toast.filters_reset'), 'info');
  };

  // Client-side search filter (doesn't reset pagination) + visual source filter
  const searchFiltered = search.trim()
    // Search filtering moved server-side 2026-05-14 — client filter could
    // only see top-LIMIT loaded trends, so items past page 1 became invisible
    // at 24h+ windows. Server now applies the SQL filter, and pagination
    // walks the filtered result set. Local var kept as pass-through to
    // preserve the downstream consumer (visibleTrends) below.
    ? trends
    : trends;
  let visibleTrends = hiddenSources.size
    ? searchFiltered.filter(t => !hiddenSources.has(t.source))
    : searchFiltered;
  // Optimistic local-hide — server filters these out on next fetch via
  // hidden_trends table, but we hide instantly so the card disappears the
  // moment the user clicks ✕ (don't wait for round-trip).
  if (localHidden.size) visibleTrends = visibleTrends.filter(t => !localHidden.has(t.id));
  // Type-axis chips (Event / Trend / Post / Manual) form a UNION, not an
  // intersection. They sit on the same axis ("what kinds of trends do I
  // want?"), so selecting "Manual" + "Post" should show both manual-submitted
  // items AND alertType=post items. Earlier this was AND-combined, which made
  // the Manual chip hide everything else as soon as it was selected — even
  // when other type chips were also active.
  // Wildcard semantics for legacy rows: rows without alertType still pass any
  // type-chip filter so we don't hide the back-catalog when alertType is
  // empty (this was the original behavior; preserved here in the OR clause).
  if (manualOnly || alertTypes) {
    const sel = alertTypes ? new Set(alertTypes.split(',')) : null;
    visibleTrends = visibleTrends.filter(t => {
      const passManual = manualOnly && t.manualSubmitted;
      const passType   = sel && (!t.alertType || sel.has(t.alertType));
      // If only one filter is active, that one decides. If both are active,
      // a row passes when EITHER predicate matches (union).
      if (manualOnly && sel) return passManual || passType;
      if (manualOnly)        return passManual;
      return passType;
    });
  }

  // Tweet hover-preview — global delegate, single instance for the whole app.
  // Hook itself attaches mouseover/mouseout listeners at the document level
  // and only matches anchors inside .feed or .modal-overlay (per spec —
  // dashboard only, no nav/sidebar links).
  //
  // MUST sit ABOVE the auth-gate early-return below — Rules of Hooks: the
  // hook order has to be stable across renders, and the early returns here
  // would skip this hook when not logged in. Putting it above keeps the
  // count consistent. The hook's effect attaches a no-op listener on the
  // login screen — harmless, since none of LoginScreen's anchors match the
  // tweet-link selector.
  const tweetHover = useTweetHover();

  // ── Auth gate ───────────────────────────────────────────────────────────
  if (me === false) return h(LoginScreen, { onLoggedIn: handleLoggedIn });
  if (me === null)  return h('div', {
    style: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.7 }
  }, t('app.loading'));

  return h('div', null,
    // Toast notifications (fixed top-right)
    h(Toasts, { toasts }),

    // Tweet hover-preview portal — renders into document.body via a portal in
    // the component itself, so it sits above modal/lightbox like a tooltip.
    h(TweetHoverPreview, {
      state: tweetHover.state,
      onMouseEnter: tweetHover.onCardEnter,
      onMouseLeave: tweetHover.onCardLeave,
    }),

    // Bottom undo toast for "hide alert" — fades out after 5s
    pendingUndo ? h('div', { className: 'undo-toast' },
      h('span', { className: 'undo-toast-text' }, t('toast.alert_hidden')),
      h('button', {
        className: 'undo-toast-btn',
        onClick: () => undoHide(pendingUndo.trend)
      }, t('toast.undo'))
    ) : null,

    // Scroll-to-top button — appears at the horizontal center of the feed
    // column (not viewport) when user scrolls past the threshold. Click
    // smooth-scrolls .main-feed to top. Inline left value from feedCenterX,
    // updated by the scroll/resize/ResizeObserver effect above. While
    // feedCenterX is null (very first paint before effect fires), suppress
    // render — otherwise the button briefly flashes at left:0 viewport edge.
    (showScrollTop && feedCenterX !== null) ? h('button', {
      type: 'button',
      className: 'scroll-to-top',
      style: { left: feedCenterX + 'px' },
      onClick: scrollFeedToTop,
      title: t('feed.scroll_top'),
      'aria-label': t('feed.scroll_top'),
    }, '↑') : null,

    // Bottom status bar removed 2026-05-02 — Live indicator + sources list
    // moved into RightPanel's Activity section so the dashboard reads as a
    // single Twitter-like column-set without a footer strip.

    // Side drawer modal
    modalTrend ? h(TrendModal, {
      trend: modalTrend,
      onClose: () => setModalTrend(null),
      me,
      onFavToggle: toggleFavorite,
      onFavNote: saveFavNote,
    }) : null,

    // ── Nav ──
    h('nav', { className: 'nav' },
      h('div', { className: 'nav-logo' },
        // Brand logo. PNG comes from /assets/logo.png (baked into Docker
        // image). LOGO_VERSION (server-injected) busts the cache on every
        // rebuild, so replacing the file + redeploy actually shows the new
        // image — without it, Cache-Control:immutable kept the old one for
        // a day. On 404 / load error we swap in the 🐱 emoji so the nav
        // never looks broken — see _handleBrandLogo for the server side.
        h('span', { className: 'nav-logo-icon' },
          h('img', {
            src: '/assets/logo.png?v=' + LOGO_VERSION,
            alt: 'Catalyst',
            className: 'nav-logo-img',
            onError: (e) => {
              const span = e.target.parentNode;
              if (span) {
                span.removeChild(e.target);
                span.textContent = '\u{1F431}'; // 🐱
              }
            },
          })
        ),
        h('span', { className: 'nav-logo-text' }, t('app.title'))
      ),
      // Decorative center subtitle removed in 2026-05-01 polish — it added
      // noise without information. Centered content can come back if we ship
      // a global status badge (e.g. "scanning…", "stale 2m"); for now the
      // status pill in the bottom bar carries that signal.
      h('div', { className: 'nav-right' },
        // Telegram bot link — same icon-button styling as X. Username is
        // injected at HTML render time (BOT_USERNAME); falls back to a bare
        // t.me link if unresolved (still works, lands on Telegram home).
        h('a', {
          className: 'nav-icon-btn',
          href: BOT_USERNAME ? ('https://t.me/' + BOT_USERNAME) : 'https://t.me/',
          target: '_blank',
          rel: 'noopener noreferrer',
          title: BOT_USERNAME ? ('Open @' + BOT_USERNAME + ' bot') : 'Open Telegram bot',
          'aria-label': 'Open Telegram bot',
        },
          // Telegram brand glyph — paper plane SVG, fill via currentColor so
          // it inherits .nav-icon-btn-ico colour rules and matches X.
          h('span', { className: 'nav-icon-btn-ico' },
            h('svg', {
              width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor',
              style: { display: 'block', transform: 'translateX(-1px)' }
            },
              h('path', {
                d: 'M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z'
              })
            )
          )
        ),
        h('a', {
          className: 'nav-icon-btn',
          href: 'https://x.com/Catalystparser',
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'Follow @Catalystparser on X',
          'aria-label': 'Follow on X',
        },
          h('span', { className: 'nav-icon-btn-ico' }, '𝕏')
        ),
        h('button', {
          type: 'button',
          className: 'nav-icon-btn nav-account' + (view === 'account' ? ' active' : ''),
          onClick: () => setView(view === 'account' ? 'trends' : 'account'),
          title: (me && me !== true && me.username)
            ? '@' + me.username + ' · ' + t('nav.account')
            : t('nav.account'),
        },
          h('span', { className: 'nav-account-avatar' },
            (me && me !== true && me.hasAvatar)
              ? h('img', {
                  src: '/api/auth/avatar?token=' + encodeURIComponent(AUTH_TOKEN) + '&k=' + encodeURIComponent(me.avatarKey || ''),
                  alt: me.username || 'avatar',
                  onError: (e) => { e.target.style.display = 'none'; },
                })
              : (me && me !== true && me.username)
                ? me.username.charAt(0).toUpperCase()
                : '👤'
          ),
          h('span', { className: 'nav-account-name' },
            (me && me !== true && me.username)
              ? '@' + me.username
              : t('nav.account')
          )
        ),
        h('button', {
          type: 'button',
          className: 'nav-icon-btn' + (view === 'settings' ? ' active' : ''),
          onClick: () => setView(view === 'settings' ? 'trends' : 'settings'),
          title: t('nav.settings'),
          'aria-label': t('nav.settings'),
        },
          h('span', { className: 'nav-icon-btn-ico' }, '⚙️')
        )
      )
    ),

    // ── Layout: always 3-col dashboard-grid. Settings / Account / Stats
    //   open as centered modal sheets with blurred backdrop (see below). ──
    h('div', { className: 'dashboard-grid' },

          // ── Sidebar ──
          h('aside', { className: 'sidebar' },
            h('div', { className: 'sidebar-section' },
              h('span', null, t('sidebar.sources')),
              hiddenSources.size
                ? h('span', { className: 'sidebar-section-link', onClick: showAllSources, title: t('tooltip.show_all') }, t('sidebar.show_all'))
                : null
            ),
            // Sort sources by current 24h alert count (desc) so the busiest
            // platform sits on top — operator's eye lands there first. Ties
            // keep the original server order via stable Array.sort + original
            // index as secondary key (Reddit > Google > Twitter/X > TikTok >
            // X Trends — same as before when counts equal). Copy via slice()
            // so we don't mutate React state (would cause hard-to-debug
            // re-render loops with the SSE subscriber).
            ...sources
              .map((s, i) => ({ s, i }))
              .sort((a, b) => {
                const ca = a.s.last24h || 0;
                const cb = b.s.last24h || 0;
                if (cb !== ca) return cb - ca;
                return a.i - b.i;
              })
              .map(({ s }) => s)
              .map(s => {
              const visible = !hiddenSources.has(s.source);
              const cnt = s.last24h || 0;
              // Locked source = not in user's plan (Free can't toggle premium
              // sources). Click → upgrade toast instead of toggle. The
              // count is still shown so the user sees what they're missing.
              const locked = s.inPlan === false;
              return h('div', {
                key: s.source,
                'data-src': s.source,
                className: 'source-item ' + (locked ? 'locked' : (visible ? 'on' : 'off')),
                onClick: () => {
                  if (locked) { addToast(t('source.locked_toast'), 'info'); return; }
                  toggle(s.source);
                },
                title: locked
                  ? t('source.locked_tooltip')
                  : (visible ? t('tooltip.hide_source') : t('tooltip.show_source'))
              },
                h('span', { className: 'source-icon' }, h(SourceMark, { src: s.source, fallback: '·' })),
                h('span', { className: 'source-name' }, SOURCE_LABELS[s.source] || s.source),
                locked
                  ? h('span', { className: 'source-lock', title: t('source.locked_tooltip') }, '🔒')
                  : h('span', { className: 'source-count' + (cnt >= 50 ? ' hot' : '') }, cnt)
              );
            }),

            // ── Phase filter chips (moved from feed header) ──
            // Manual-only filter moved here as a sibling row so the source
            // list stays focused on actual data sources. The toggle still
            // affects the visible feed (see visibleTrends below).
            // Multi-select: each chip toggles its membership in the set;
            // "Все" clears the whole set.
            h('div', { className: 'sidebar-section' },
              h('span', null, t('sidebar.phase')),
              phases
                ? h('span', { className: 'sidebar-section-link', onClick: () => {
                    setPhases('');
                    try { localStorage.setItem('ts_phase_filter', ''); } catch (e) {}
                    setOffset(0);
                  }, title: t('tooltip.reset') }, t('sidebar.reset'))
                : null
            ),
            h('div', { className: 'sidebar-phase' },
              (function() {
                const phaseArr = phases ? phases.split(',') : [];
                const activeAll = phaseArr.length === 0;
                const togglePhase = (p) => {
                  const cur = phases ? phases.split(',') : [];
                  const next = cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p];
                  const str = next.sort().join(',');
                  setPhases(str);
                  try { localStorage.setItem('ts_phase_filter', str); } catch (e) {}
                  setOffset(0);
                };
                return [
                  h('button', {
                    key: '_all',
                    type: 'button',
                    className: 'phase-chip' + (activeAll ? ' active' : ''),
                    onClick: () => {
                      setPhases('');
                      try { localStorage.setItem('ts_phase_filter', ''); } catch (e) {}
                      setOffset(0);
                    }
                  }, h('span', { className: 'phase-chip-dot' }, '◆'),
                     h('span', { className: 'phase-chip-label' }, t('feed.filter.all')),
                     h('span', { className: 'phase-chip-count' }, total)
                  ),
                  ...['early','forming','strong','saturated'].map(p =>
                    h('button', {
                      key: p,
                      type: 'button',
                      className: 'phase-chip phase-chip-' + p + (phaseArr.includes(p) ? ' active' : ''),
                      onClick: () => togglePhase(p)
                    },
                      h('span', { className: 'phase-chip-dot' }, PHASE_DOT[p]),
                      h('span', { className: 'phase-chip-label' }, PHASE_META[p].label)
                    )
                  )
                ];
              })()
            ),

            // ── Alert type filter chips (event / trend / post) ──
            // Pure client-side filter — does NOT change subscription. The
            // user's subscription lives in /api/user/alert-types and is
            // edited from SettingsPanel. Multi-select: each chip toggles
            // its membership; "Все" clears the whole set.
            h('div', { className: 'sidebar-section' },
              h('span', null, t('sidebar.alert_type')),
              (alertTypes || manualOnly)
                ? h('span', { className: 'sidebar-section-link', onClick: () => {
                    setAlertTypes('');
                    try { localStorage.setItem('ts_alert_type_filter', ''); } catch (e) {}
                    if (manualOnly) {
                      setManualOnly(false);
                      try { localStorage.setItem('ts_manual_only', '0'); } catch (e) {}
                    }
                  }, title: t('tooltip.reset') }, t('sidebar.reset'))
                : null
            ),
            h('div', { className: 'sidebar-phase' },
              (function() {
                const atypeArr = alertTypes ? alertTypes.split(',') : [];
                // ALL is active only when NO axis is filtering — neither
                // alert-type chips nor the Manual toggle. Otherwise the
                // header lies (says "all" but feed is filtered).
                const activeAll = atypeArr.length === 0 && !manualOnly;
                const toggleAtype = (k) => {
                  const cur = alertTypes ? alertTypes.split(',') : [];
                  const next = cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k];
                  const str = next.sort().join(',');
                  setAlertTypes(str);
                  try { localStorage.setItem('ts_alert_type_filter', str); } catch (e) {}
                };
                const items = [
                  h('button', {
                    key: '_all',
                    type: 'button',
                    className: 'phase-chip' + (activeAll ? ' active' : ''),
                    onClick: () => {
                      // ALL = no filter on the type axis. Reset BOTH
                      // alertTypes AND manualOnly so manual rows show up
                      // alongside event/trend/post. Without the manualOnly
                      // reset, a previously-enabled Manual chip kept the
                      // feed locked to manual-only even after picking ALL.
                      setAlertTypes('');
                      try { localStorage.setItem('ts_alert_type_filter', ''); } catch (e) {}
                      if (manualOnly) {
                        setManualOnly(false);
                        try { localStorage.setItem('ts_manual_only', '0'); } catch (e) {}
                      }
                    }
                  }, h('span', { className: 'phase-chip-dot' }, '◆'),
                     h('span', { className: 'phase-chip-label' }, t('feed.filter.all'))
                  )
                ];
                [['event','📰','feed.atype.event'],['trend','📈','feed.atype.trend'],['post','🚀','feed.atype.post']].forEach(spec => {
                  const key = spec[0], emoji = spec[1], i18nKey = spec[2];
                  items.push(h('button', {
                    key: key,
                    type: 'button',
                    className: 'phase-chip atype-chip-' + key + (atypeArr.includes(key) ? ' active' : ''),
                    onClick: () => toggleAtype(key)
                  },
                    h('span', { className: 'phase-chip-dot' }, emoji),
                    h('span', { className: 'phase-chip-label' }, t(i18nKey))
                  ));
                });
                return items;
              })(),
              // Manual-only toggle styled as a chip — sits inside the same
              // grid as alert-type filters because it's the same axis: "what
              // kind of trend do I want to see right now". Single cell so it
              // pairs visually next to the Post chip (4 items in 2x2 + ALL header).
              h('button', {
                type: 'button',
                className: 'phase-chip atype-chip-manual' + (manualOnly ? ' active' : ''),
                onClick: () => {
                  const next = !manualOnly;
                  setManualOnly(next);
                  try { localStorage.setItem('ts_manual_only', next ? '1' : '0'); } catch (e) {}
                  addToast(next ? t('toast.manual_only_on') : t('toast.manual_only_off'), 'info');
                },
                title: manualOnly ? t('tooltip.manual_off') : t('tooltip.manual_on')
              },
                h('span', { className: 'phase-chip-dot' }, '🧪'),
                h('span', { className: 'phase-chip-label' }, t('sidebar.manual_only'))
              )
              // Saved-only chip removed from sidebar 2026-05-06 — moved into
              // BottomNav between Feed and Analyze for prominence.
            ),

            h('div', { className: 'sidebar-section' },
              h('span', null, t('sidebar.filters')),
              (hours !== 24 || category || sort !== 'rank')
                ? h('span', { className: 'sidebar-section-link', onClick: resetFilters, title: t('tooltip.reset') }, t('sidebar.reset'))
                : null
            ),
            h('div', { className: 'sidebar-filters' },

              // Time window (segmented). Plan-historyHours caps Free at 72h
              // (3 days). Options beyond cap render with 🔒 + tooltip and
              // emit an upgrade-toast on click instead of switching window.
              h('div', { className: 'filter-group' },
                h('div', { className: 'filter-label' },
                  h('span', null, t('sidebar.window')),
                  h('span', { className: 'filter-val' }, hours < 24 ? hours + 'h' : (hours / 24) + 'd')
                ),
                h('div', { className: 'seg-group seg-compact' },
                  [{ v: 6, l: '6h' }, { v: 24, l: '24h' }, { v: 72, l: '3d' }, { v: 168, l: '7d' }].map(o => {
                    const planHist = (me && me.entitlements && typeof me.entitlements.historyHours === 'number') ? me.entitlements.historyHours : -1;
                    const locked = (planHist > 0) && (o.v > planHist);
                    return h('button', {
                      key: o.v,
                      className: 'seg-btn' + (hours === o.v ? ' active' : '') + (locked ? ' seg-btn-locked' : ''),
                      title: locked ? t('window.locked_tooltip') : null,
                      style: locked ? { opacity: 0.55, cursor: 'not-allowed' } : null,
                      onClick: () => {
                        if (locked) { addToast(t('window.locked_toast'), 'info'); return; }
                        setHours(o.v); setOffset(0);
                      },
                    }, locked ? '🔒 ' + o.l : o.l);
                  })
                )
              ),

              // Adoption threshold (segmented) — REMOVED 2026-05-14.
              // The per-row Adoption bar in cards already conveys the score;
              // gating the feed by it confused users more than it helped.

              // Category — custom styled dropdown (CategoryDropdown).
              // Replaced native <select> because chromium paints the option
              // list itself and ignores most CSS, which clashed with the
              // X-style monochrome theme. The custom panel matches sidebar
              // chips: hover ripple, accent left-border on active row.
              h('div', { className: 'filter-group' },
                h('div', { className: 'filter-label' }, h('span', null, t('sidebar.category'))),
                h(CategoryDropdown, {
                  value: category,
                  onChange: (v) => { setCategory(v); setOffset(0); },
                  categories: Object.keys(CAT_ICONS)
                })
              ),

              // Sort order (segmented icons)
              h('div', { className: 'filter-group' },
                h('div', { className: 'filter-label' }, h('span', null, t('sidebar.sort'))),
                h('div', { className: 'seg-group seg-compact' },
                  [
                    { v: 'rank',      l: '⚡', tip: t('sort.rank') },
                    { v: 'meme',      l: '💎', tip: t('sort.meme') },
                    { v: 'emergence', l: '🌊', tip: t('sort.emergence') },
                    { v: 'time',      l: '🕐', tip: t('sort.time') },
                    { v: 'virality',  l: '📊', tip: t('sort.virality') },
                  ].map(o =>
                    h('button', {
                      key: o.v,
                      title: o.tip,
                      className: 'seg-btn' + (sort === o.v ? ' active' : ''),
                      onClick: () => { setSort(o.v); setOffset(0); }
                    }, o.l)
                  )
                )
              )
            ),

            h('div', { style: { flex: 1 } }),

            // Unified bottom nav (Feed / Stats / Settings + Analyze for pro/admin)
            h(BottomNav, { view, setView, me, favoritesOnly, setFavoritesOnly, favoriteCount, setOffset, addToast })
          ),

          // Draggable divider between sidebar and main feed
          h(ColumnResizer, { side: 'left' }),

          // ── Main feed ──
          h('main', { className: 'main-feed', ref: mainFeedRef },
            error ? h('div', { className: 'error-bar', style: { marginBottom: 12 } }, '⚠️ ', error) : null,

            h('div', { className: 'feed-panel' + (refreshPulse && trends.length > 0 ? ' is-refreshing' : '') },

              // ── Feed panel header ──
              // 2026-05-01 polish: dropped the decorative 🔥 icon-block on
              // the left — it ate horizontal space without adding info.
              // Title carries the same energy via its 800-weight text.
              h('div', { className: 'feed-panel-head' },
                h('div', { className: 'feed-panel-top' },
                  h('div', { className: 'feed-panel-titles' },
                    h('div', { className: 'feed-panel-title' },
                      t('feed.panel.title'),
                      h('span', { className: 'feed-panel-count' },
                        search.trim()
                          ? visibleTrends.length + ' / ' + total
                          : t('feed.panel.count_signals', { n: total })
                      )
                    ),
                    h('div', { className: 'feed-panel-sub' },
                      t('feed.panel.sub', {
                        active: (sources || []).filter(s => s.enabled).length,
                        total: (sources || []).length,
                        h: hours
                      })
                    )
                  ),
                  h('div', { className: 'feed-panel-actions' },
                    h('div', { className: 'feed-search' },
                      h('span', { className: 'feed-search-icon' }, '🔍'),
                      h('input', {
                        type: 'text',
                        placeholder: t('feed.search_placeholder'),
                        value: search,
                        onChange: e => setSearch(e.target.value),
                      })
                    ),
                    h('button', {
                      className: 'btn btn-ghost feed-refresh-btn' + (refreshPulse ? ' is-spinning' : ''),
                      onClick: () => { if (!loading) { refreshAll(); addToast(t('toast.refreshing'), 'info'); } },
                      disabled: loading,
                      title: t('feed.refresh_tip')
                    }, h('span', { className: 'btn-refresh-ico' }, '↻'))
                  )
                )
              ),

              // ── Feed list (stale-while-revalidate) ──
              // Full spinner only on the first load (no cached trends yet).
              // On subsequent refreshes keep the existing list visible
              // and show a subtle top progress bar.
              (loading && trends.length === 0)
                ? h('div', { className: 'loading-wrap', style: { padding: '60px 20px' } },
                    h('div', { className: 'loading-spinner' }),
                    h('div', { className: 'loading-text' }, t('feed.loading'))
                  )
                : visibleTrends.length === 0
                  ? h('div', { className: 'empty-feed' },
                      h('div', { className: 'empty-feed-icon' }, '🔍'),
                      h('div', { className: 'empty-feed-text' },
                        search.trim()
                          ? t('feed.empty.no_match', { q: search })
                          : t('feed.empty.no_data')
                      ),
                      h('div', { className: 'empty-feed-sub' }, t('feed.empty.hint'))
                    )
                  : h('div', { className: 'feed-list' + (refreshPulse ? ' is-refreshing' : '') },
                      visibleTrends.map(tr => h(FeedCard, {
                        key: tr.id, trend: tr,
                        onOpen: setModalTrend,
                        onHide: hideTrend,
                        onFavToggle: toggleFavorite,
                        canFavorite: !!(me && me.entitlements && me.entitlements.favorites),
                      }))
                    ),

              // Infinite-scroll sentinel + "loading more" spinner.
              // Sentinel is observed by IntersectionObserver which bumps offset
              // when it scrolls into view. Hidden during search / once all
              // loaded. Keeps a small bottom pad so it's actually reachable.
              !search.trim() && trends.length > 0 && trends.length < total
                ? h('div', { ref: sentinelRef, className: 'feed-sentinel' },
                    loadingMore
                      ? h('div', { className: 'feed-loading-more' },
                          h('div', { className: 'loading-spinner small' }),
                          h('span', null, t('feed.loading'))
                        )
                      : h('span', { className: 'feed-sentinel-hint' }, '↓')
                  )
                : (!search.trim() && trends.length > 0 && trends.length >= total
                    ? h('div', { className: 'feed-sentinel feed-sentinel-end' },
                        h('span', { className: 'feed-sentinel-hint' }, '— ' + t('feed.panel.count_signals', { n: total }) + ' —')
                      )
                    : null)
            )
          ),

          // Draggable divider between main feed and right panel
          h(ColumnResizer, { side: 'right' }),

          // ── Right panel ──
          h(RightPanel, {
            stats,
            hours,
            sources,
            scanning,
            onOpenTrend: setModalTrend,
          })
    ),

    // ── Modal sheets (Settings / Account / Stats) ──
    view === 'settings' ? h(Sheet, {
      title: t('settings.title'),
      icon: '⚙️',
      onClose: () => setView('trends'),
    },
      h(SettingsPanel, {
        onBack: () => setView('trends'),
        onResetHiddenSources: showAllSources,
        hiddenSourcesCount: hiddenSources.size,
      })
    ) : null,

    view === 'account' ? h(Sheet, {
      title: t('nav.account'),
      icon: '👤',
      narrow: true,
      onClose: () => setView('trends'),
    },
      h(AccountPanel, {
        onBack: () => setView('trends'),
        user: me,
        onLogout: handleLogout,
      })
    ) : null,

    // Stats tab removed 2026-05-06 — see BottomNav comment. StatsPanel
    // component definition kept intact for now (dead code, easy revival).

    view === 'analyze' ? h(Sheet, {
      title: t('analyze.title'),
      icon: '🧪',
      narrow: true,
      onClose: () => setView('trends'),
    },
      h(AnalyzePanel, {
        onBack: () => setView('trends'),
        // Pop the analyzed (synthetic) trend in the same TrendModal feed
        // items use — full carousel + score bars + Ask Grok / source link.
        onOpenTrend: (trend) => { setModalTrend(trend); setView('trends'); },
      })
    ) : null
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));
<\/script>
</body>
</html>`;
  }
}

export default DashboardServer;
