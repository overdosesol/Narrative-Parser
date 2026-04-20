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
import fs from 'fs';
import { fileURLToPath } from 'url';
import { timingSafeEqual } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Middleware helpers ────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 16 * 1024; // 16 KB limit

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
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Cache-Control': 'no-cache',
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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

// ─── Dashboard class ──────────────────────────────────────────────────────────

class DashboardServer {
  constructor(config, logger, db, appState, scanFn, telegram = null) {
    this.config       = config.dashboard;
    this.fullConfig   = config;   // keep reference for telegram.botUsername, etc.
    this.logger       = logger;
    this.db           = db;
    this.appState     = appState;
    this.scanFn       = scanFn;   // callback to trigger manual scan
    this.telegram     = telegram; // TelegramNotifier for bot-username lookup
    this.server       = null;
    this.started      = Date.now();
    this.sseClients   = new Set();  // active Server-Sent Event subscribers
    this._sseKeepAlive = null;
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
  }

  stop() {
    this.server?.close();
  }

  // ── Router ──────────────────────────────────────────────────────────────────

  async _handle(req, res) {
    const url    = new URL(req.url, `http://localhost`);
    const path   = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
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

    // Reddit video proxy — public. <video> elements can't send custom
    // Authorization headers; and the content itself is already a public
    // Reddit CDN stream (we just mux video+audio). Route validates the
    // ?src= query against the v.redd.it pattern, so it can't be abused
    // as a generic proxy.
    if (path.match(/^\/api\/video\/reddit\/[a-z0-9]+\.mp4$/i) && method === 'GET') {
      return this._handleRedditVideo(req, res, path);
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
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          'WWW-Authenticate': 'Bearer realm="dashboard"',
        });
        return res.end(JSON.stringify({ error: 'Unauthorized — please sign in via Telegram' }));
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
      if (path === '/api/scan'     && method === 'POST') return this._handleScan(req, res);
      if (path === '/api/preview'   && method === 'GET')  return this._handlePreview(req, res, url);
      if (path === '/api/config'    && method === 'GET')  return this._handleConfig(req, res);
      if (path === '/api/settings'  && method === 'GET')  return this._handleSettingsGet(req, res);
      if (path === '/api/settings'  && method === 'POST') return this._handleSettingsPost(req, res);
      if (path === '/api/personalization' && method === 'GET')  return this._handlePersonalizationGet(req, res);
      if (path === '/api/personalization' && method === 'POST') return this._handlePersonalizationPost(req, res);
      if (path.match(/^\/api\/collectors\/[\w_]+\/toggle$/) && method === 'POST') return this._handleCollectorToggle(req, res, path);
      if (path.match(/^\/api\/trends\/\d+\/feedback$/) && method === 'POST') return this._handleTrendFeedback(req, res, path);

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

    const result = this.db.verifyAuthCode(sessionId, code);
    if (!result) return json(res, 401, { error: 'Invalid or expired code' });

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

    // Miss: resolve file path from Telegram, download, tee to cache + response
    try {
      const url = await this.telegram.getFileUrl(user.avatar_file_id);
      if (!url) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'File not available' }));
      }
      const tgRes = await fetch(url);
      if (!tgRes.ok || !tgRes.body) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Telegram CDN error' }));
      }

      const ct = tgRes.headers.get('content-type') || 'image/jpeg';
      res.writeHead(200, {
        'Content-Type':  ct,
        'Cache-Control': 'private, max-age=604800, immutable',
      });

      // Buffer the whole body once — small files (<200 KB), lets us write to
      // disk AND respond without fighting stream tee semantics.
      const buf = Buffer.from(await tgRes.arrayBuffer());
      try { fs.writeFileSync(cachePath, buf); } catch (e) {
        this.logger.warn(`[Avatar] cache write failed: ${e.message}`);
      }
      res.end(buf);
    } catch (e) {
      this.logger.warn(`[Avatar] proxy failed: ${e.message}`);
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
    const hours       = parseInt(url.searchParams.get('hours')       || '24',  10);
    const limit       = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset      = parseInt(url.searchParams.get('offset')      || '0',   10);
    const category    = url.searchParams.get('category')    || null;
    const source      = url.searchParams.get('source')      || null;
    const phase       = url.searchParams.get('phase')       || null;  // 'early'|'forming'|'strong'|'saturated'
    const minMeme     = parseInt(url.searchParams.get('minMeme')     || '0',   10);
    const minEmergence = parseInt(url.searchParams.get('minEmergence') || '0', 10);
    const minPlatforms = parseInt(url.searchParams.get('minPlatforms') || '0', 10);

    const sortParam = url.searchParams.get('sort') || 'rank';

    // ── Personalized rank-sort ─────────────────────────────────────────────
    // Only for authenticated users who left personalization enabled and have
    // actually voted on something. Bakes a per-category boost into the SQL
    // ORDER BY so pagination stays correct; untouched for other sort modes.
    const authedChatId = String(req.user?.telegram_chat_id || '').trim() || null;
    let personalBoostSql = '';
    let activePrefs = null;
    if (sortParam === 'rank' && authedChatId && this.db.getPersonalizationEnabled(authedChatId)) {
      const prefs = this.db.getCategoryPreferences(authedChatId, 30);
      const entries = Object.entries(prefs).filter(([, v]) => v !== 0);
      if (entries.length) {
        // Clamp each boost to ±15 so a single heavy category can't dominate.
        const cases = entries
          .map(([cat, v]) => {
            const boost = Math.max(-15, Math.min(15, v));
            // SQL-escape the category name (single quotes doubled).
            const safe = String(cat).replace(/'/g, "''");
            return `WHEN '${safe}' THEN ${boost}`;
          })
          .join(' ');
        personalBoostSql = ` + (CASE category ${cases} ELSE 0 END)`;
        activePrefs = prefs;
      }
    }

    let orderBy;
    if      (sortParam === 'time')      orderBy = 'first_seen_at DESC';
    else if (sortParam === 'virality')  orderBy = 'score DESC';
    else if (sortParam === 'meme')      orderBy = "CAST(JSON_EXTRACT(raw_metrics, '$.memePotential') AS INT) DESC";
    else if (sortParam === 'emergence') orderBy = "CAST(JSON_EXTRACT(raw_metrics, '$.emergenceScore') AS INT) DESC";
    else                                orderBy = `(CAST(JSON_EXTRACT(raw_metrics, '$.rankScore') AS INT)${personalBoostSql}) DESC`;

    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    let query = `SELECT * FROM trends WHERE first_seen_at > ?`;
    const params = [cutoff];

    if (category)         { query += ` AND category = ?`;                                                                              params.push(category); }
    if (source)           { query += ` AND source = ?`;                                                                                params.push(source); }
    if (phase)            { query += ` AND JSON_EXTRACT(raw_metrics, '$.narrativePhase') = ?`;                                         params.push(phase); }
    if (minMeme > 0)      { query += ` AND CAST(JSON_EXTRACT(raw_metrics, '$.memePotential') AS INT) >= ?`;                            params.push(minMeme); }
    if (minEmergence > 0) { query += ` AND CAST(JSON_EXTRACT(raw_metrics, '$.emergenceScore') AS INT) >= ?`;                           params.push(minEmergence); }
    if (minPlatforms > 1) { query += ` AND CAST(JSON_EXTRACT(raw_metrics, '$.emergenceScore') AS INT) >= 16`; } // uniquePlatforms>=2 ≈ emergence>=16

    query += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.db.prepare(query).all(...params);

    // Count with same filters (minus limit/offset)
    const countParams = params.slice(0, -2);
    const countQuery = query.replace(/ORDER BY.*$/, '').replace(/^SELECT \*/, 'SELECT COUNT(*) as c');
    const total = this.db.db.prepare(countQuery).get(...countParams)?.c ?? 0;

    const userId = String(req.user?.telegram_chat_id || '').trim() || null;
    const trends = rows.map(row => this._formatTrend(row, userId));

    // When personalization was applied, echo a tiny summary so the client
    // can show an indicator on the settings screen (active prefs map).
    const payload = { trends, total, limit, offset };
    if (activePrefs) payload.personalization = { active: true, prefs: activePrefs };

    return json(res, 200, payload);
  }

  _handleTrend(req, res, path) {
    const id  = parseInt(path.split('/').pop(), 10);
    const row = this.db.db.prepare(`SELECT * FROM trends WHERE id = ?`).get(id);
    if (!row) return json(res, 404, { error: 'Trend not found' });
    const userId = String(req.user?.telegram_chat_id || '').trim() || null;
    return json(res, 200, this._formatTrend(row, userId));
  }

  _handleStats(req, res, url) {
    const hours = parseInt(url.searchParams.get('hours') || '24', 10);
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

    const total = this.db.db.prepare(`SELECT COUNT(*) as c FROM trends WHERE first_seen_at > ?`).get(cutoff).c;

    const bySource = this.db.db.prepare(
      `SELECT source, COUNT(*) as count FROM trends WHERE first_seen_at > ? GROUP BY source`
    ).all(cutoff);

    const byCategory = this.db.db.prepare(
      `SELECT category, COUNT(*) as count FROM trends WHERE first_seen_at > ? GROUP BY category ORDER BY count DESC`
    ).all(cutoff);

    const statsUserId = String(req.user?.telegram_chat_id || '').trim() || null;
    const topTrends = this.db.db.prepare(
      `SELECT * FROM trends WHERE first_seen_at > ? ORDER BY CAST(JSON_EXTRACT(raw_metrics, '$.memePotential') AS INT) DESC LIMIT 10`
    ).all(cutoff).map(r => this._formatTrend(r, statsUserId));

    const avgScore = this.db.db.prepare(
      `SELECT AVG(score) as avg FROM trends WHERE first_seen_at > ? AND score > 0`
    ).get(cutoff).avg || 0;

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
    const sources = ['reddit', 'google_trends', 'twitter', 'tiktok'];
    const cutoff  = new Date(Date.now() - 60 * 60_000).toISOString();

    const result = sources.map(source => {
      const last = this.db.db.prepare(
        `SELECT COUNT(*) as count, MAX(first_seen_at) as last FROM trends WHERE source = ? AND first_seen_at > ?`
      ).get(source, new Date(Date.now() - 24 * 3_600_000).toISOString());

      const lastHour = this.db.db.prepare(
        `SELECT COUNT(*) as c FROM trends WHERE source = ? AND first_seen_at > ?`
      ).get(source, cutoff).c;

      const enabled = !this.appState.disabledCollectors?.has(source);

      return { source, last24h: last.count, lastHour, lastSeen: last.last, enabled };
    });

    return json(res, 200, { sources: result });
  }

  _handleSettingsGet(req, res) {
    const numDefaults = { alertThreshold: 60, viralityThreshold: 70, minScoreToSave: 0, maxAlertsPerCycle: 0 };
    const stored = this.db.getAllSettings();
    const merged = {};
    for (const [k, v] of Object.entries(numDefaults)) {
      merged[k] = stored[k] !== undefined ? Number(stored[k]) : v;
    }
    merged.activePreset = stored.activePreset || 'general';
    return json(res, 200, merged);
  }

  async _handleSettingsPost(req, res) {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: 'Invalid JSON' }); }

    const saved = {};
    const errors = [];

    const VALID_PRESETS = new Set(['general', 'animals', 'culture', 'celebrities', 'events']);
    if ('activePreset' in body) {
      if (!VALID_PRESETS.has(body.activePreset)) {
        return json(res, 400, { error: 'Invalid preset' });
      }
      this.db.setSetting('activePreset', body.activePreset);
      saved.activePreset = body.activePreset;
      this.logger.info(`[Dashboard] Search preset changed to: ${body.activePreset}`);
    }

    const allowed = {
      alertThreshold:    { min: 0,  max: 100, type: 'int' },
      viralityThreshold: { min: 0,  max: 100, type: 'int' },
      minScoreToSave:    { min: 0,  max: 100, type: 'int' },
      maxAlertsPerCycle: { min: 0,  max: 50,  type: 'int' },
    };

    for (const [key, rules] of Object.entries(allowed)) {
      if (!(key in body)) continue;
      const val = Number(body[key]);
      if (isNaN(val) || val < rules.min || val > rules.max) {
        errors.push(`${key}: must be ${rules.min}–${rules.max}`);
        continue;
      }
      const finalVal = rules.type === 'int' ? Math.round(val) : val;
      this.db.setSetting(key, finalVal);
      saved[key] = finalVal;
    }

    if (errors.length > 0) return json(res, 400, { error: errors.join(', ') });

    this.logger.info(`[Dashboard] Settings updated: ${JSON.stringify(saved)}`);
    return json(res, 200, { ok: true, saved });
  }

  /**
   * GET /api/personalization — returns the current user's preference map
   * (net 👍/👎 score per category over the last 30 days) plus the on/off
   * toggle. Used by the settings UI to show "we're boosting X, damping Y".
   */
  _handlePersonalizationGet(req, res) {
    const chatId = String(req.user?.telegram_chat_id || '').trim() || null;
    if (!chatId) return json(res, 401, { error: 'Not authenticated' });
    const enabled = this.db.getPersonalizationEnabled(chatId);
    const prefs   = this.db.getCategoryPreferences(chatId, 30);
    // Convert to a sorted array for stable UI rendering.
    const list = Object.entries(prefs)
      .map(([category, net]) => ({ category, net }))
      .sort((a, b) => b.net - a.net);
    return json(res, 200, { enabled, prefs: list });
  }

  /**
   * POST /api/personalization — accepts `{ enabled: boolean }` and persists
   * the toggle on the user row. No-op if already in that state.
   */
  async _handlePersonalizationPost(req, res) {
    const chatId = String(req.user?.telegram_chat_id || '').trim() || null;
    if (!chatId) return json(res, 401, { error: 'Not authenticated' });
    let body;
    try { body = await parseBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const enabled = !!body?.enabled;
    this.db.setPersonalizationEnabled(chatId, enabled);
    return json(res, 200, { ok: true, enabled });
  }

  _handleCollectorToggle(req, res, path) {
    const name = path.split('/')[3]; // /api/collectors/:name/toggle
    const disabled = this.appState.disabledCollectors;
    if (disabled.has(name)) {
      disabled.delete(name);
      this.logger.info(`[Dashboard] Collector enabled: ${name}`);
    } else {
      disabled.add(name);
      this.logger.info(`[Dashboard] Collector disabled: ${name}`);
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

    const vote = parseInt(body?.vote, 10);
    if (![1, -1, 0].includes(vote)) return json(res, 400, { error: 'vote must be 1, -1 or 0' });

    const trend = this.db.getTrendById ? this.db.getTrendById(trendId) : null;
    if (!trend) return json(res, 404, { error: 'Trend not found' });

    // Toggle off if the same vote is sent twice
    const prev = this.db.getUserVote ? this.db.getUserVote(trendId, userId) : null;
    const finalVote = (vote !== 0 && prev === vote) ? 0 : vote;

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

    const stats = this.db.getFeedbackStats(trendId);
    return json(res, 200, {
      likes:    stats.likes    || 0,
      dislikes: stats.dislikes || 0,
      score:    stats.weightedScore || 0,
      userVote: finalVote || 0,
    });
  }

  _handleStream(req, res) {
    res.writeHead(200, {
      'Content-Type':        'text/event-stream',
      'Cache-Control':       'no-cache, no-transform',
      'Connection':          'keep-alive',
      'X-Accel-Buffering':   'no',           // disable proxy buffering
      'Access-Control-Allow-Origin': '*',
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

  _formatTrend(row, userId = null) {
    let metrics = {};
    try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch (e) {}
    // Feedback (likes / dislikes / user's current vote)
    let feedback = { likes: 0, dislikes: 0, score: 0, userVote: 0 };
    try {
      const fb = this.db.getFeedbackStats ? this.db.getFeedbackStats(row.id) : null;
      if (fb) {
        feedback.likes    = fb.likes || 0;
        feedback.dislikes = fb.dislikes || 0;
        feedback.score    = fb.weightedScore || 0;
      }
      if (userId && this.db.getUserVote) {
        feedback.userVote = this.db.getUserVote(row.id, userId) || 0;
      }
    } catch (e) {}
    return {
      id:              row.id,
      title:           row.title,
      originalTitle:   row.original_title || row.title,
      source:          row.source,
      category:        row.category,
      sentiment:       row.sentiment,
      score:           row.score,
      memePotential:   metrics.memePotential || 0,
      adoptionScore:   metrics.adoptionScore  ?? metrics.memePotential ?? 0,
      emergenceScore:  metrics.emergenceScore ?? 0,
      narrativePhase:  metrics.narrativePhase  ?? null,
      rankScore:       metrics.rankScore       ?? null,
      marketStage:     metrics.marketStage     ?? null, // [MARKET_STAGE]
      junkPenalty:     metrics.junkPenalty     ?? 0,   // [JUNK_FILTER]
      junkReasons:     metrics.junkReasons     ?? [],  // [JUNK_FILTER]
      velocity:        metrics.velocity        ?? 0,
      uniquePlatforms: metrics.uniquePlatforms ?? 1,
      aiExplanation:   row.ai_explanation,
      whyItWillPump:   metrics.whyItWillPump || '',
      // Trigger event — empty string when the AI found no explicit cause.
      // UI only renders the row when non-empty.
      whyNow:          row.why_now || '',
      predictedLifespan: row.predicted_lifespan,
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
        return raw;
      })(),
      imageUrls:       Array.isArray(metrics.imageUrls)
        ? metrics.imageUrls.filter(u => u && !/b\.thumbs\.redditmedia\.com/i.test(u)).slice(0, 10)
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
        return v;
      })(),
      feedback,
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
          // media.all[0]: photo → .url (full-res), video → .thumbnail_url (frame)
          const media = data?.tweet?.media?.all?.[0];
          const rawUrl = media?.type === 'photo'
            ? (media.url || media.thumbnail_url)
            : (media?.thumbnail_url || media?.url) || null;
          // Force pbs.twimg.com to original resolution
          const imageUrl = rawUrl ? upgradeTwimgUrl(rawUrl) : null;
          this.logger.info(`[Preview] tweet ${tweetId} → ${imageUrl ? 'has image' : 'no media'}`);
          return json(res, 200, { imageUrl });
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

    /* ===== THEME SYSTEM =====
       Default = "midnight" (deep ink + electric cyan).
       Switch via <body data-theme="teal|abyss|violet|acid|sunset|cyberpunk">.
       Component colors should use var(--accent), var(--accent-rgb), etc. so they retint on theme change. */
    :root {
      /* Structural (mostly theme-invariant, but overridden per theme for real differentiation) */
      --bg:          #060811;
      --surface:     #0b0e1c;
      --card:        #0f1328;
      --card2:       #141935;
      --card3:       #1b2146;
      --border:      rgba(160,180,255,.07);
      --border2:     rgba(160,180,255,.11);
      --border3:     rgba(160,180,255,.17);
      --text:        #e6ecff;
      --text2:       #c2cbe8;
      --muted:       #7f8bac;
      --dim:         #48527a;

      /* Accent (primary) */
      --accent:      #00e5ff;
      --accent2:     #5eead4;
      --accent-rgb:  0,229,255;
      --accent-glow: rgba(0,229,255,.18);

      /* Semantic palette */
      --green:       #34e0a1;
      --green2:      #6bf0bd;
      --green-rgb:   52,224,161;
      --red:         #ff3d6e;
      --red2:        #ff7099;
      --red-rgb:     255,61,110;
      --orange:      #ffa641;
      --orange2:     #ffcb87;
      --orange-rgb:  255,166,65;
      --yellow:      #f6d34a;
      --yellow2:     #ffe89d;
      --blue:        #38bdf8;
      --pink:        #f472b6;
      --teal:        #14e0d1;
      --purple:      #a78bfa;

      --radius:      10px;
      --radius-sm:   8px;
      --radius-xs:   6px;
      --shadow:      0 4px 20px rgba(0,0,0,.55);
      --shadow-lg:   0 8px 40px rgba(0,0,0,.7);
      --glass:       rgba(255,255,255,.03);
      --glass2:      rgba(255,255,255,.055);
    }

    /* --- Teal / Bioluminescent --- */
    body[data-theme="teal"] {
      --bg:          #04131a;
      --surface:     #07202a;
      --card:        #0a2a37;
      --card2:       #0f3645;
      --card3:       #164656;
      --border:      rgba(94,234,212,.08);
      --border2:     rgba(94,234,212,.14);
      --border3:     rgba(94,234,212,.22);
      --text:        #e5fbf6;
      --text2:       #bfefe4;
      --muted:       #6fae9f;
      --dim:         #3d6b62;
      --accent:      #2dd4bf;
      --accent2:     #5eead4;
      --accent-rgb:  45,212,191;
      --accent-glow: rgba(45,212,191,.22);
      --green:       #5eead4;
      --green2:      #99f6e4;
      --green-rgb:   94,234,212;
      --red:         #ff6b6b;
      --red2:        #ff9090;
      --red-rgb:     255,107,107;
      --orange:      #fbbf24;
      --orange2:     #fcd34d;
      --orange-rgb:  251,191,36;
      --yellow:      #fde68a;
      --yellow2:     #fef3c7;
    }

    /* --- Abyss / Very Dark --- */
    body[data-theme="abyss"] {
      --bg:          #000000;
      --surface:     #050508;
      --card:        #0a0a0f;
      --card2:       #0f0f17;
      --card3:       #16161f;
      --border:      rgba(255,255,255,.04);
      --border2:     rgba(255,255,255,.07);
      --border3:     rgba(255,255,255,.12);
      --text:        #e0e0ea;
      --text2:       #b5b5c4;
      --muted:       #6a6a7a;
      --dim:         #3a3a44;
      --accent:      #9ca3af;
      --accent2:     #d1d5db;
      --accent-rgb:  156,163,175;
      --accent-glow: rgba(156,163,175,.14);
      --green:       #4ade80;
      --green2:      #86efac;
      --green-rgb:   74,222,128;
      --red:         #f87171;
      --red2:        #fca5a5;
      --red-rgb:     248,113,113;
      --orange:      #fb923c;
      --orange2:     #fdba74;
      --orange-rgb:  251,146,60;
      --yellow:      #facc15;
      --yellow2:     #fde047;
      --shadow:      0 4px 20px rgba(0,0,0,.8);
      --shadow-lg:   0 8px 40px rgba(0,0,0,.9);
    }

    /* --- Violet / Twilight --- */
    body[data-theme="violet"] {
      --bg:          #0d0520;
      --surface:     #17092e;
      --card:        #1e0c3c;
      --card2:       #28114d;
      --card3:       #341761;
      --border:      rgba(196,181,253,.08);
      --border2:     rgba(196,181,253,.13);
      --border3:     rgba(196,181,253,.2);
      --text:        #f3ecff;
      --text2:       #d9ccf5;
      --muted:       #9d8ec2;
      --dim:         #5c4e7e;
      --accent:      #c084fc;
      --accent2:     #e9d5ff;
      --accent-rgb:  192,132,252;
      --accent-glow: rgba(192,132,252,.22);
      --green:       #34d399;
      --green2:      #6ee7b7;
      --green-rgb:   52,211,153;
      --red:         #fb7185;
      --red2:        #fda4af;
      --red-rgb:     251,113,133;
      --orange:      #f59e0b;
      --orange2:     #fbbf24;
      --orange-rgb:  245,158,11;
      --yellow:      #fcd34d;
      --yellow2:     #fde68a;
      --pink:        #f0abfc;
      --purple:      #d8b4fe;
    }

    /* --- Acid / Toxic Green --- */
    body[data-theme="acid"] {
      --bg:          #060a04;
      --surface:     #0a120a;
      --card:        #0e1a0c;
      --card2:       #142413;
      --card3:       #1d311a;
      --border:      rgba(163,230,53,.08);
      --border2:     rgba(163,230,53,.15);
      --border3:     rgba(163,230,53,.24);
      --text:        #eaffd0;
      --text2:       #cef29a;
      --muted:       #84a368;
      --dim:         #4a6237;
      --accent:      #a3e635;
      --accent2:     #d9f99d;
      --accent-rgb:  163,230,53;
      --accent-glow: rgba(163,230,53,.28);
      --green:       #84cc16;
      --green2:      #bef264;
      --green-rgb:   132,204,22;
      --red:         #f43f5e;
      --red2:        #fb7185;
      --red-rgb:     244,63,94;
      --orange:      #f97316;
      --orange2:     #fb923c;
      --orange-rgb:  249,115,22;
      --yellow:      #eab308;
      --yellow2:     #facc15;
      --pink:        #ec4899;
    }

    /* --- Sunset / Bonus warm --- */
    body[data-theme="sunset"] {
      --bg:          #140610;
      --surface:     #200a18;
      --card:        #2a0f1e;
      --card2:       #3a1528;
      --card3:       #4d1d34;
      --border:      rgba(251,146,60,.08);
      --border2:     rgba(251,146,60,.14);
      --border3:     rgba(251,146,60,.22);
      --text:        #fff1e6;
      --text2:       #f5d5bd;
      --muted:       #b38670;
      --dim:         #6b4a3c;
      --accent:      #fb7185;
      --accent2:     #fda4af;
      --accent-rgb:  251,113,133;
      --accent-glow: rgba(251,113,133,.22);
      --green:       #4ade80;
      --green2:      #86efac;
      --green-rgb:   74,222,128;
      --red:         #ef4444;
      --red2:        #f87171;
      --red-rgb:     239,68,68;
      --orange:      #fb923c;
      --orange2:     #fdba74;
      --orange-rgb:  251,146,60;
      --yellow:      #fbbf24;
      --yellow2:     #fcd34d;
      --pink:        #f472b6;
    }

    /* --- Cyberpunk / Magenta + Cyan --- */
    body[data-theme="cyberpunk"] {
      --bg:          #0a0418;
      --surface:     #130827;
      --card:        #1a0b36;
      --card2:       #251048;
      --card3:       #32155e;
      --border:      rgba(236,72,153,.09);
      --border2:     rgba(236,72,153,.16);
      --border3:     rgba(236,72,153,.26);
      --text:        #fdf0ff;
      --text2:       #f0c8ff;
      --muted:       #b182c2;
      --dim:         #64476f;
      --accent:      #f0abfc;
      --accent2:     #22d3ee;
      --accent-rgb:  240,171,252;
      --accent-glow: rgba(240,171,252,.28);
      --green:       #22d3ee;
      --green2:      #67e8f9;
      --green-rgb:   34,211,238;
      --red:         #ef4444;
      --red2:        #f87171;
      --red-rgb:     239,68,68;
      --orange:      #fb923c;
      --orange2:     #fdba74;
      --orange-rgb:  251,146,60;
      --yellow:      #fde047;
      --yellow2:     #fef08a;
      --pink:        #ec4899;
      --purple:      #c084fc;
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
      background: linear-gradient(180deg, rgba(12,12,22,.96) 0%, rgba(8,8,15,.92) 100%);
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
      font-size: 18px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 8px;
      background: linear-gradient(135deg, rgba(var(--accent-rgb), .22), rgba(var(--accent-rgb), .05));
      border: 1px solid rgba(var(--accent-rgb), .28);
      box-shadow: 0 2px 10px rgba(var(--accent-rgb), .18), inset 0 1px 0 rgba(255,255,255,.05);
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
    .layout { display: flex; min-height: calc(100vh - 50px - 28px); }

    /* ── Sidebar ── */
    .sidebar {
      width: 240px; min-width: 240px;
      background: linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%);
      border-right: 1px solid var(--border);
      padding: 14px 10px 10px;
      display: flex; flex-direction: column; gap: 2px;
      /* classic layout: sticky scroll, subtract nav(50) + statusbar(28) */
      position: sticky; top: 50px; height: calc(100vh - 50px - 28px); overflow-y: auto;
    }
    /* In dashboard-grid the sidebar is app-shell (overrides above) */
    .sidebar-section {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 9px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1.4px; color: var(--accent); padding: 8px 8px 6px;
      margin-top: 6px;
    }
    .sidebar-section:first-child { margin-top: 0; }
    .sidebar-section-link {
      font-size: 9px; font-weight: 600; letter-spacing: 1px;
      color: var(--muted); cursor: pointer; padding: 2px 6px; border-radius: 4px;
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
    .phase-chip-early.active    { background: rgba(59,130,246,.15); border-color: rgba(59,130,246,.4); color: #93c5fd; }
    .phase-chip-forming.active  { background: rgba(234,179,8,.15);  border-color: rgba(234,179,8,.45);  color: #fde047; }
    .phase-chip-strong.active   { background: rgba(34,197,94,.15);  border-color: rgba(34,197,94,.45);  color: #86efac; }
    .phase-chip-saturated.active{ background: rgba(239,68,68,.15);  border-color: rgba(239,68,68,.45);  color: #fca5a5; }

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
    .source-icon {
      width: 22px; height: 22px; border-radius: 6px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; flex-shrink: 0;
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.05);
      transition: all .18s;
    }
    .source-item[data-src="reddit"] .source-icon        { background: rgba(255,88,0,.14); border-color: rgba(255,88,0,.25); }
    .source-item[data-src="google_trends"] .source-icon { background: rgba(66,133,244,.14); border-color: rgba(66,133,244,.28); }
    .source-item[data-src="twitter"] .source-icon       { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.12); }
    .source-item[data-src="tiktok"] .source-icon        { background: rgba(255,0,80,.14); border-color: rgba(255,0,80,.25); }
    .source-name { flex: 1; letter-spacing: -.1px; }
    .source-count {
      font-family: 'JetBrains Mono', monospace; font-size: 10.5px; font-weight: 600;
      color: var(--text2); background: rgba(255,255,255,.04);
      padding: 2px 7px; border-radius: 5px; min-width: 26px; text-align: center;
      border: 1px solid var(--border);
    }
    .source-count.hot { color: var(--accent2); background: rgba(var(--accent-rgb), .1); border-color: rgba(var(--accent-rgb), .22); }
    .source-eye {
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      font-size: 11px; opacity: 0; transition: opacity .15s;
      pointer-events: none;
    }
    .source-item:hover .source-eye { opacity: .75; }

    .sidebar-divider { height: 1px; background: var(--border); margin: 10px 6px; }

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
      padding: 10px 4px 4px;
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

    /* ── Main content ── */
    .main {
      flex: 1; min-width: 0; padding: 18px 20px 24px;
      height: calc(100vh - 50px - 28px); overflow-y: auto;
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
    .meme-num { font-size: 17px; font-weight: 800; font-family: 'JetBrains Mono', monospace; line-height: 1; }
    .meme-num.hot  { color: var(--red2); text-shadow: 0 0 10px rgba(var(--red-rgb), .35); }
    .meme-num.warm { color: var(--orange); }
    .meme-num.ok   { color: var(--yellow); }
    .meme-num.cold { color: var(--dim); }
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

    /* ── Phase badge ── */
    .phase-badge {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 6px; border-radius: 4px;
      font-size: 9px; font-weight: 800; letter-spacing: .6px;
      white-space: nowrap; flex-shrink: 0;
    }

    /* ── Badges ── */
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 5px; font-size: 10px; font-weight: 600; white-space: nowrap; letter-spacing: .2px; }
    .cat-meme        { background: rgba(162,155,254,.1); color: #a29bfe; border: 1px solid rgba(162,155,254,.18); }
    .cat-elon        { background: rgba(116,185,255,.1); color: #74b9ff; border: 1px solid rgba(116,185,255,.18); }
    .cat-animals     { background: rgba(85,239,196,.1);  color: #55efc4; border: 1px solid rgba(85,239,196,.18); }
    .cat-tech_drama  { background: rgba(225,112,85,.1);  color: #e17055; border: 1px solid rgba(225,112,85,.18); }
    .cat-degenerates { background: rgba(253,121,168,.1); color: #fd79a8; border: 1px solid rgba(253,121,168,.18); }
    .cat-celebrity   { background: rgba(253,203,110,.1); color: #fdcb6e; border: 1px solid rgba(253,203,110,.18); }
    .cat-sports_degen{ background: rgba(116,185,255,.1); color: #74b9ff; border: 1px solid rgba(116,185,255,.18); }
    .cat-ai_drama    { background: rgba(129,236,236,.1); color: #81ecec; border: 1px solid rgba(129,236,236,.18); }
    .cat-boring      { background: rgba(255,255,255,.04); color: var(--dim); border: 1px solid var(--border); }
    .cat-other       { background: rgba(255,255,255,.04); color: var(--dim); border: 1px solid var(--border); }

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

    /* ── Account hero card ── */
    .account-hero {
      display: flex; align-items: center; gap: 18px;
      background: linear-gradient(135deg, rgba(var(--accent-rgb), .09) 0%, var(--card) 70%);
      border: 1px solid rgba(var(--accent-rgb), .2) !important;
    }
    .account-avatar-big {
      flex-shrink: 0;
      width: 64px; height: 64px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; font-weight: 800; letter-spacing: -1px;
      color: var(--text);
      background: linear-gradient(135deg, rgba(var(--accent-rgb), .4), rgba(var(--accent-rgb), .12));
      border: 2px solid rgba(var(--accent-rgb), .5);
      box-shadow: 0 4px 16px rgba(var(--accent-rgb), .25), inset 0 1px 0 rgba(255,255,255,.1);
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
      background: var(--card); border: 1px solid var(--border);
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
    /* midnight (default / no attr) */
    .theme-swatch[data-theme-preview="midnight"]  .theme-swatch-dot-bg     { background: #060811; }
    .theme-swatch[data-theme-preview="midnight"]  .theme-swatch-dot-accent { background: linear-gradient(90deg,#00e5ff,#5eead4); }
    .theme-swatch[data-theme-preview="midnight"]  .theme-swatch-dot-card   { background: #141935; }
    .theme-swatch[data-theme-preview="teal"]      .theme-swatch-dot-bg     { background: #04131a; }
    .theme-swatch[data-theme-preview="teal"]      .theme-swatch-dot-accent { background: linear-gradient(90deg,#2dd4bf,#5eead4); }
    .theme-swatch[data-theme-preview="teal"]      .theme-swatch-dot-card   { background: #0f3645; }
    .theme-swatch[data-theme-preview="abyss"]     .theme-swatch-dot-bg     { background: #000000; }
    .theme-swatch[data-theme-preview="abyss"]     .theme-swatch-dot-accent { background: linear-gradient(90deg,#9ca3af,#d1d5db); }
    .theme-swatch[data-theme-preview="abyss"]     .theme-swatch-dot-card   { background: #0f0f17; }
    .theme-swatch[data-theme-preview="violet"]    .theme-swatch-dot-bg     { background: #0d0520; }
    .theme-swatch[data-theme-preview="violet"]    .theme-swatch-dot-accent { background: linear-gradient(90deg,#c084fc,#e9d5ff); }
    .theme-swatch[data-theme-preview="violet"]    .theme-swatch-dot-card   { background: #28114d; }
    .theme-swatch[data-theme-preview="acid"]      .theme-swatch-dot-bg     { background: #060a04; }
    .theme-swatch[data-theme-preview="acid"]      .theme-swatch-dot-accent { background: linear-gradient(90deg,#a3e635,#d9f99d); }
    .theme-swatch[data-theme-preview="acid"]      .theme-swatch-dot-card   { background: #142413; }
    .theme-swatch[data-theme-preview="sunset"]    .theme-swatch-dot-bg     { background: #140610; }
    .theme-swatch[data-theme-preview="sunset"]    .theme-swatch-dot-accent { background: linear-gradient(90deg,#fb7185,#fda4af); }
    .theme-swatch[data-theme-preview="sunset"]    .theme-swatch-dot-card   { background: #3a1528; }
    .theme-swatch[data-theme-preview="cyberpunk"] .theme-swatch-dot-bg     { background: #0a0418; }
    .theme-swatch[data-theme-preview="cyberpunk"] .theme-swatch-dot-accent { background: linear-gradient(90deg,#f0abfc,#22d3ee); }
    .theme-swatch[data-theme-preview="cyberpunk"] .theme-swatch-dot-card   { background: #251048; }
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
    .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 13px 0; border-top: 1px solid var(--border); }
    .setting-row:first-of-type { border-top: none; }
    .setting-label { display: flex; flex-direction: column; gap: 3px; flex: 1; }
    .setting-name  { font-size: 12px; font-weight: 600; color: var(--text); }
    .setting-hint  { font-size: 10px; color: var(--muted); }
    .setting-control { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    .setting-control input[type=range] { width: 130px; accent-color: var(--accent); height: 3px; cursor: pointer; }
    .setting-val { font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 700; color: var(--accent2); min-width: 30px; text-align: right; }
    .settings-actions { display: flex; gap: 10px; margin-top: 10px; justify-content: flex-end; }
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

    /* ── Body preference classes (applied by applyPrefsToDOM) ── */
    body.prefs-no-anim *, body.prefs-no-anim *:before, body.prefs-no-anim *:after {
      animation-duration: .001s !important; animation-delay: 0s !important;
      transition-duration: .001s !important;
    }
    body.prefs-no-images .feed-card-media,
    body.prefs-no-images .card-media,
    body.prefs-no-images .trend-modal-media { display: none !important; }
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

    /* ── Toast notifications ── */
    @keyframes toastIn  { from { opacity:0; transform: translateX(30px); } to { opacity:1; transform: translateX(0); } }
    @keyframes toastOut { from { opacity:1; transform: translateX(0); }    to { opacity:0; transform: translateX(30px); } }
    .toasts-wrap { position: fixed; top: 60px; right: 14px; z-index: 9999; display: flex; flex-direction: column; gap: 7px; pointer-events: none; }
    .toast {
      display: flex; align-items: center; gap: 9px;
      background: var(--card3); border: 1px solid var(--border2);
      border-radius: 8px; padding: 10px 14px;
      font-size: 12px; font-weight: 500; color: var(--text);
      box-shadow: var(--shadow-lg); animation: toastIn .2s ease;
      pointer-events: auto; min-width: 230px; max-width: 320px;
      backdrop-filter: blur(10px);
    }
    .toast.success { border-color: rgba(var(--green-rgb), .25); }
    .toast.success .toast-icon { color: var(--green2); }
    .toast.error   { border-color: rgba(var(--red-rgb), .25); }
    .toast.error   .toast-icon { color: var(--red2); }
    .toast.info    { border-color: rgba(var(--accent-rgb), .25); }
    .toast.info    .toast-icon { color: var(--accent2); }
    .toast-icon { font-size: 13px; flex-shrink: 0; }
    .toast-msg  { flex: 1; line-height: 1.4; }

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
      background: rgba(4,6,14,.55);
      backdrop-filter: blur(14px) saturate(1.1);
      -webkit-backdrop-filter: blur(14px) saturate(1.1);
      animation: sheetIn .22s ease;
      display: flex; align-items: center; justify-content: center;
      padding: 28px 20px;
      overflow-y: auto;
    }
    .sheet {
      position: relative;
      width: 100%; max-width: 760px;
      max-height: calc(100vh - 56px);
      background: linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%);
      border: 1px solid var(--border2);
      border-radius: 16px;
      box-shadow: 0 24px 80px rgba(0,0,0,.7), 0 0 0 1px rgba(var(--accent-rgb), .08);
      animation: sheetPop .28s cubic-bezier(.2,.8,.2,1);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
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
    .modal-image { width: 100%; height: 180px; border-radius: 8px; object-fit: cover; display: block; border: 1px solid var(--border); }
    .modal-image-loading {
      height: 180px; border-radius: 8px;
      background: linear-gradient(90deg, var(--card2) 25%, var(--card3) 50%, var(--card2) 75%);
      background-size: 200% 100%; animation: shimmer 1.5s linear infinite; border: 1px solid var(--border);
    }

    /* ── Modal sections ── */
    .modal-title { font-size: 15px; font-weight: 800; color: var(--text); line-height: 1.35; letter-spacing: -.25px; }
    .modal-section { display: flex; flex-direction: column; gap: 7px; }
    .modal-section-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); font-weight: 700; }
    .modal-section-content { font-size: 12px; color: var(--text2); line-height: 1.55; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 11px 13px; }
    .modal-section-content.pump { color: var(--orange); border-color: rgba(var(--orange-rgb), .15); background: rgba(var(--orange-rgb), .05); }
    .modal-section-content.why-now { color: #ff6b6b; border-color: rgba(255, 107, 107, .18); background: rgba(255, 107, 107, .06); font-weight: 500; }
    .pref-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .pref-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px; font-size: 11px; font-weight: 500; border: 1px solid var(--border); background: var(--card); }
    .pref-chip-name { color: var(--text2); text-transform: capitalize; }
    .pref-chip-val  { font-variant-numeric: tabular-nums; font-weight: 600; }
    .pref-chip.up   { border-color: rgba(34, 197, 94, .25); background: rgba(34, 197, 94, .06); }
    .pref-chip.up .pref-chip-val   { color: #22c55e; }
    .pref-chip.down { border-color: rgba(255, 107, 107, .22); background: rgba(255, 107, 107, .05); }
    .pref-chip.down .pref-chip-val { color: #ff6b6b; }
    .modal-stats-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 7px; }
    .modal-stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; }
    .modal-stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: .7px; color: var(--dim); font-weight: 600; }
    .modal-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }

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
      height: calc(100vh - 50px - 28px); /* viewport - nav - statusbar */
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
      overflow-y: auto;
      border-right: 1px solid var(--border);
      padding: 14px 10px 10px;
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
      padding: 14px 16px 12px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(var(--accent-rgb), .03), transparent);
    }
    .feed-panel-top {
      display: flex; align-items: center; gap: 12px; margin-bottom: 11px;
    }
    .feed-panel-icon {
      width: 32px; height: 32px; border-radius: 9px;
      background: var(--accent-glow);
      border: 1px solid rgba(var(--accent-rgb), .28);
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; flex-shrink: 0;
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

    /* ── Feed list / cards ── */
    .feed-list {
      display: flex; flex-direction: column; gap: 8px;
      padding: 10px;
    }
    .feed-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      transition: all .15s;
      cursor: pointer;
      position: relative;
    }
    .feed-card:hover {
      border-color: var(--border3);
      background: var(--card2);
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(0,0,0,.2);
    }
    .feed-card-head {
      display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px;
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
    .feed-badges { display: flex; gap: 5px; margin-left: auto; align-items: center; flex-wrap: wrap; }

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

    /* ── Feed score strip ── */
    .feed-scores {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
      padding: 8px 10px; margin: 6px 0 10px;
      background: rgba(0,0,0,.18); border-radius: 8px;
      border: 1px solid var(--border);
    }
    .feed-score { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
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
      background: var(--card);
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
      width: 22px; height: 22px; border-radius: 6px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; flex-shrink: 0;
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.05);
      transition: all .18s;
    }
    .pulse-row[data-src="reddit"] .pulse-icon        { background: rgba(255,88,0,.14); border-color: rgba(255,88,0,.25); }
    .pulse-row[data-src="google_trends"] .pulse-icon { background: rgba(66,133,244,.14); border-color: rgba(66,133,244,.28); }
    .pulse-row[data-src="twitter"] .pulse-icon       { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.12); }
    .pulse-row[data-src="tiktok"] .pulse-icon        { background: rgba(255,0,80,.14); border-color: rgba(255,0,80,.25); }
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

    /* ── Bottom status bar ── */
    .statusbar {
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 300;
      height: 28px;
      background: linear-gradient(180deg, rgba(10,10,18,.94) 0%, rgba(6,6,12,.98) 100%);
      border-top: 1px solid var(--border);
      backdrop-filter: blur(14px) saturate(1.15);
      -webkit-backdrop-filter: blur(14px) saturate(1.15);
      display: flex; align-items: center; gap: 10px;
      padding: 0 14px; font-size: 10px; font-family: 'JetBrains Mono', monospace; color: var(--text2);
      box-shadow: 0 -2px 16px rgba(0,0,0,.35);
    }
    .statusbar::before {
      content: ''; position: absolute; left: 0; right: 0; top: -1px; height: 1px;
      background: linear-gradient(90deg, transparent 0%, rgba(var(--accent-rgb), .2) 15%, rgba(var(--accent-rgb), .2) 85%, transparent 100%);
      pointer-events: none;
    }
    .statusbar-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--green2); flex-shrink: 0;
      box-shadow: 0 0 8px var(--green), 0 0 0 2px rgba(34,197,94,.12);
      animation: pulse 2.5s ease-in-out infinite;
    }
    .statusbar-dot.paused { background: var(--red2); box-shadow: 0 0 6px var(--red); animation: none; }
    .statusbar-item {
      display: flex; align-items: center; gap: 5px; white-space: nowrap;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(255,255,255,.02); border: 1px solid transparent;
      transition: border-color .15s, background .15s;
    }
    .statusbar-item:hover { background: rgba(255,255,255,.04); border-color: var(--border); }
    .statusbar-item b { color: var(--text); font-weight: 700; letter-spacing: .2px; }
    .statusbar-item .sb-key { color: var(--dim); text-transform: uppercase; font-size: 9px; letter-spacing: .8px; }
    .statusbar-sep {
      width: 1px; height: 14px;
      background: linear-gradient(180deg, transparent, var(--border2), transparent);
      flex-shrink: 0;
    }
    .statusbar-hint { margin-left: auto; color: var(--dim); opacity: .7; display: flex; align-items: center; gap: 8px; }
    .statusbar-kbd {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 1px 6px; border-radius: 4px;
      background: rgba(255,255,255,.04); border: 1px solid var(--border);
      font-size: 9px; color: var(--text2); letter-spacing: .3px;
    }
    .statusbar-kbd b { color: var(--accent2); font-weight: 700; margin-right: 1px; }

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
try { document.documentElement.setAttribute('lang', CURRENT_LANG); } catch (e) {}

// ── THEME ────────────────────────────────────────────────────────────────
// Six dark themes, no light mode. Applied via <body data-theme="...">.
// "midnight" is the default and uses no data-theme attribute (the :root block).
const THEME_KEY = 'ts_theme';
const SUPPORTED_THEMES = ['midnight', 'teal', 'abyss', 'violet', 'acid', 'sunset', 'cyberpunk'];
const THEME_META = {
  midnight:  { icon: '🌌', labelEn: 'Midnight',  labelRu: 'Полночь' },
  teal:      { icon: '🌊', labelEn: 'Teal',      labelRu: 'Бирюза' },
  abyss:     { icon: '🕳️', labelEn: 'Abyss',     labelRu: 'Бездна' },
  violet:    { icon: '🔮', labelEn: 'Violet',    labelRu: 'Фиолет' },
  acid:      { icon: '☢️', labelEn: 'Acid',      labelRu: 'Кислота' },
  sunset:    { icon: '🌅', labelEn: 'Sunset',    labelRu: 'Закат' },
  cyberpunk: { icon: '🌆', labelEn: 'Cyberpunk', labelRu: 'Киберпанк' },
};
function detectTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && SUPPORTED_THEMES.indexOf(saved) >= 0) return saved;
  } catch (e) {}
  return 'midnight';
}
let CURRENT_THEME = detectTheme();
const themeListeners = new Set();
function applyThemeAttr(theme) {
  try {
    if (theme && theme !== 'midnight') document.body.setAttribute('data-theme', theme);
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
    'status.signals': 'signals',
    'status.alerts': 'alerts',
    'status.sources': 'sources',
    'status.updating': '⏳ updating',
    'status.kbd.refresh': 'refresh',
    'status.kbd.close': 'close',

    // Nav
    'nav.live': 'Live',
    'nav.offline': 'Offline',
    'nav.stats': 'Stats',
    'nav.settings': 'Settings',
    'nav.feed': 'Feed',
    'nav.account': 'Account',

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

    // Feed card
    'feed.details': '📖 Details',
    'feed.open_source': 'Open',
    'feed.copy_title': 'Copy title',
    'feed.category_tip': 'Category',
    'feedback.like': 'Smash that like',
    'feedback.unlike': 'Undo like',
    'feedback.dislike': 'Dislike',
    'feedback.undislike': 'Undo dislike',

    // Feed panel
    'feed.panel.title': 'Narrative Feed',
    'feed.panel.count_signals': '{n} signals',
    'feed.panel.sub': 'Live narrative tracker · {active}/{total} sources · {h}h window',
    'feed.search_placeholder': 'Search narratives…',
    'feed.refresh_tip': 'Refresh (R)',
    'feed.refreshing': 'Refreshing…',
    'feed.loading': 'Loading narratives…',
    'feed.empty.no_match': 'No matches for "{q}"',
    'feed.empty.no_data': 'No narratives found — loosen the filters',
    'feed.empty.hint': 'Hint: widen the time window or clear filters',
    'feed.filter.all': 'All',

    // Pagination
    'pagination.prev': '← Prev',
    'pagination.next': 'Next →',

    // Sidebar
    'sidebar.sources': 'Sources',
    'sidebar.phase': 'Phase',
    'sidebar.filters': 'Filters',
    'sidebar.show_all': 'Show all',
    'sidebar.reset': 'Reset',
    'sidebar.window': '⏱ Window',
    'sidebar.adoption': '💎 Adoption',
    'sidebar.category': '📂 Category',
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
    'right.activity': '📊 Activity',
    'right.activity_hours': '{h}h',
    'right.signals': 'Signals',
    'right.alerts': 'Alerts',
    'right.avg_virality': 'Avg virality',
    'right.score.vrl': 'vrl',

    // Trend modal
    'modal.why_pump': "⚡ Why it'll moon",
    'modal.why_now': '🔥 Trigger',
    'modal.ai_explanation': '🤖 AI alpha',
    'modal.market_stage': '💹 Market Stage',
    'modal.phase': '🧭 Narrative phase',
    'modal.metrics': '📊 Stats',
    'modal.meme_score': 'Meme Score',
    'modal.lifespan': 'Lifespan',
    'modal.virality': 'Virality',
    'modal.sentiment': 'Vibe',
    'modal.seen': 'Seen',
    'modal.seen_suffix': 'x',
    'modal.feedback': '💬 Your take',
    'modal.links': '🔗 Links',
    'modal.source_link': '{ico} Source →',
    'modal.tg_link': '📨 Telegram',

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
    'settings.title': '⚙️ Dashboard settings',
    'settings.flash_reset': '✓ Settings reset',
    'settings.flash_sources_shown': '✓ All sources visible',

    'settings.appearance': '🎨 Appearance',
    'settings.appearance_desc': 'Visual preferences — applied instantly, stored in this browser.',
    'settings.density': 'Feed density',
    'settings.density_desc': 'Compact shrinks padding and card size for dense scrolling.',
    'settings.density.comfy': 'Comfy',
    'settings.density.compact': 'Compact',
    'settings.images': 'Show previews',
    'settings.images_desc': 'Turn off to save bandwidth and declutter the feed.',
    'settings.animations': 'UI animations',
    'settings.animations_desc': 'Turn off to reduce load on slower devices.',
    'settings.font_size': 'Font size',
    'settings.font_size_desc': 'Base text size across the dashboard.',
    'settings.col_left':  'Left column width',
    'settings.col_left_desc':  'Sidebar width — sources, phase, filters. Currently {px}px.',
    'settings.col_right': 'Right column width',
    'settings.col_right_desc': 'Insights / stats panel width. Currently {px}px.',

    'settings.personalization': '🎯 Personalization',
    'settings.personalization_desc': 'Your 👍 / 👎 votes re-rank the feed. Categories you liked get a boost, ones you disliked get damped. Only affects the default "Rank" sort.',
    'settings.personalization_toggle': 'Personalized ranking',
    'settings.personalization_toggle_desc': 'Turn off to see the raw global ranking.',
    'settings.personalization_empty': 'No votes yet — react to a few trends with 👍 or 👎 to train the feed.',

    'settings.behavior': '🔄 Behavior',
    'settings.behavior_desc': 'Source visibility in the feed. New data arrives live — no auto-refresh timer needed.',
    'settings.hidden': 'Hidden sources',
    'settings.hidden_count': '{n} hidden. Visual filter in this browser only.',
    'settings.hidden_none': 'Nothing hidden — click sources in the sidebar to hide them.',
    'settings.hidden_show_all': 'Show all',

    'settings.language': '🌐 Language',
    'settings.language_desc': 'Dashboard language. Bot stays in your Telegram language.',

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
    'account.threshold': 'Alert threshold',
    'account.threshold_desc': 'Minimum score to trigger a bot alert. Change via /threshold in the Telegram bot.',
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
    'toast.refreshing': 'Refreshing…',
    'toast.copied': '📋 Copied!',
    'toast.copy_failed': 'Copy failed',
    'toast.all_sources_visible': '👁 All sources visible',
    'toast.hidden_from_feed': '🙈 Hidden from feed: {name}',
    'toast.shown_in_feed': '👁 Shown: {name}',
    'toast.filters_reset': '♻️ Filters reset',
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
    'status.signals': 'сигналы',
    'status.alerts': 'алерты',
    'status.sources': 'источники',
    'status.updating': '⏳ обновляем',
    'status.kbd.refresh': 'обновить',
    'status.kbd.close': 'закрыть',

    // Nav
    'nav.live': 'Онлайн',
    'nav.offline': 'Офлайн',
    'nav.stats': 'Статистика',
    'nav.settings': 'Настройки',
    'nav.feed': 'Фид',
    'nav.account': 'Аккаунт',

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

    // Feed card
    'feed.details': '📖 Подробнее',
    'feed.open_source': 'Открыть',
    'feed.copy_title': 'Скопировать заголовок',
    'feed.category_tip': 'Категория',
    'feedback.like': 'Лайк',
    'feedback.unlike': 'Убрать лайк',
    'feedback.dislike': 'Дизлайк',
    'feedback.undislike': 'Убрать дизлайк',

    // Feed panel
    'feed.panel.title': 'Фид нарративов',
    'feed.panel.count_signals': '{n} сигналов',
    'feed.panel.sub': 'Живой трекер нарративов · {active}/{total} источников · окно {h}ч',
    'feed.search_placeholder': 'Поиск нарративов…',
    'feed.refresh_tip': 'Обновить (R)',
    'feed.refreshing': 'Обновляю…',
    'feed.loading': 'Загружаю нарративы…',
    'feed.empty.no_match': 'Нет совпадений для «{q}»',
    'feed.empty.no_data': 'Нарративы не найдены — попробуй другие фильтры',
    'feed.empty.hint': 'Подсказка: увеличь окно или сбрось фильтры',
    'feed.filter.all': 'Все',

    // Pagination
    'pagination.prev': '← Назад',
    'pagination.next': 'Далее →',

    // Sidebar
    'sidebar.sources': 'Источники',
    'sidebar.phase': 'Фаза',
    'sidebar.filters': 'Фильтры',
    'sidebar.show_all': 'Показать все',
    'sidebar.reset': 'Сбросить',
    'sidebar.window': '⏱ Окно',
    'sidebar.adoption': '💎 Adoption',
    'sidebar.category': '📂 Категория',
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
    'right.activity': '📊 Активность',
    'right.activity_hours': '{h}ч',
    'right.signals': 'Сигналы',
    'right.alerts': 'Алерты',
    'right.avg_virality': 'Ср. виральность',
    'right.score.vrl': 'vrl',

    // Trend modal
    'modal.why_pump': '⚡ Почему запампит',
    'modal.why_now': '🔥 Триггер',
    'modal.ai_explanation': '🤖 AI-объяснение',
    'modal.market_stage': '💹 Стадия рынка',
    'modal.phase': '🧭 Фаза нарратива',
    'modal.metrics': '📊 Метрики',
    'modal.meme_score': 'Meme Score',
    'modal.lifespan': 'Срок жизни',
    'modal.virality': 'Виральность',
    'modal.sentiment': 'Сентимент',
    'modal.seen': 'Видели',
    'modal.seen_suffix': 'раз',
    'modal.feedback': '💬 Ваша оценка',
    'modal.links': '🔗 Ссылки',
    'modal.source_link': '{ico} Источник →',
    'modal.tg_link': '📨 Telegram',

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
    'settings.title': '⚙️ Настройки дашборда',
    'settings.flash_reset': '✓ Настройки сброшены',
    'settings.flash_sources_shown': '✓ Все источники показаны',

    'settings.appearance': '🎨 Внешний вид',
    'settings.appearance_desc': 'Только визуальные предпочтения — применяются мгновенно и хранятся в этом браузере.',
    'settings.density': 'Плотность фида',
    'settings.density_desc': 'Compact уменьшает отступы и размер карточек для плотного просмотра.',
    'settings.density.comfy': 'Comfy',
    'settings.density.compact': 'Compact',
    'settings.images': 'Показывать превью',
    'settings.images_desc': 'Отключи чтобы экономить трафик и разгрузить фид.',
    'settings.animations': 'Анимации интерфейса',
    'settings.animations_desc': 'Отключи для снижения нагрузки на слабых устройствах.',
    'settings.font_size': 'Размер шрифта',
    'settings.font_size_desc': 'Базовый размер текста на дашборде.',
    'settings.col_left':  'Ширина левой колонки',
    'settings.col_left_desc':  'Сайдбар — источники, фаза, фильтры. Сейчас {px}px.',
    'settings.col_right': 'Ширина правой колонки',
    'settings.col_right_desc': 'Панель инсайтов и статистики. Сейчас {px}px.',

    'settings.personalization': '🎯 Персонализация',
    'settings.personalization_desc': 'Твои голоса 👍 / 👎 подстраивают ленту. Категории, которые ты лайкал, получают буст, дизлайкнутые — штраф. Работает только в дефолтной сортировке «Rank».',
    'settings.personalization_toggle': 'Персональный ранг',
    'settings.personalization_toggle_desc': 'Выключи, чтобы видеть обычный глобальный ранг.',
    'settings.personalization_empty': 'Голосов ещё нет — оцени несколько трендов через 👍/👎, и лента начнёт подстраиваться.',

    'settings.behavior': '🔄 Поведение',
    'settings.behavior_desc': 'Видимость источников в фиде. Новые данные приходят в реальном времени — таймер автообновления не нужен.',
    'settings.hidden': 'Скрытые источники',
    'settings.hidden_count': 'Сейчас скрыто: {n}. Это только визуальная фильтрация в твоём браузере.',
    'settings.hidden_none': 'Ничего не скрыто — можешь скрывать источники кликом в сайдбаре.',
    'settings.hidden_show_all': 'Показать все',

    'settings.language': '🌐 Язык',
    'settings.language_desc': 'Язык дашборда. Бот остаётся на языке вашего Telegram.',

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
    'account.threshold': 'Порог алертов',
    'account.threshold_desc': 'Минимальный скор для алерта от бота. Меняется командой /threshold в Telegram-боте.',
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
    'toast.refreshing': 'Обновляю…',
    'toast.copied': '📋 Скопировано!',
    'toast.copy_failed': 'Не удалось скопировать',
    'toast.all_sources_visible': '👁 Все источники видимы',
    'toast.hidden_from_feed': '🙈 Скрыт в фиде: {name}',
    'toast.shown_in_feed': '👁 Показан: {name}',
    'toast.filters_reset': '♻️ Фильтры сброшены',
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
      if (!r.ok) throw new Error(data && data.error ? data.error : ('HTTP ' + r.status));
      return data;
    }));
};

// ── Constants ────────────────────────────────────────────────────────────────
const SOURCE_ICONS  = { reddit: '🟠', google_trends: '🔍', twitter: '𝕏', tiktok: '🎵' };
const SOURCE_LABELS = { reddit: 'Reddit', google_trends: 'Google', twitter: 'Twitter/X', tiktok: 'TikTok' };
const CAT_ICONS     = { meme:'😂', elon:'🚀', animals:'🐾', tech_drama:'💻', degenerates:'🎰', celebrity:'⭐', sports_degen:'🏆', ai_drama:'🤖', boring:'😴', other:'📌' };
const CAT_CLS       = { meme:'cat-meme', elon:'cat-elon', animals:'cat-animals', tech_drama:'cat-tech_drama', degenerates:'cat-degenerates', celebrity:'cat-celebrity', sports_degen:'cat-sports_degen', ai_drama:'cat-ai_drama', boring:'cat-boring', other:'cat-other' };

// Lifespan key → i18n token. Resolve with lifespanLabel(key).
const LIFESPAN_KEYS = {
  'flash (hours)':     'lifespan.flash',
  'short (1-2 days)':  'lifespan.short',
  'medium (3-7 days)': 'lifespan.medium',
  'long (weeks+)':     'lifespan.long',
  'unknown':           'lifespan.unknown',
};
function lifespanLabel(k) {
  const key = LIFESPAN_KEYS[k];
  return key ? t(key) : '—';
}

// Source link labels
const SOURCE_LINK_LABELS = { reddit: '🟠 Reddit', twitter: '𝕏 Twitter', tiktok: '🎵 TikTok', google_trends: '🔍 Google' };

// ── Phase constants ──────────────────────────────────────────────────────────
// hint resolves via t() — call phaseHint(phase) when you need the localized text.
const PHASE_META = {
  early:     { label: 'EARLY',     color: '#3B82F6', bg: 'rgba(59,130,246,0.12)', hintKey: 'phase.early.hint' },
  forming:   { label: 'FORMING',   color: '#EAB308', bg: 'rgba(234,179,8,0.12)',  hintKey: 'phase.forming.hint' },
  strong:    { label: 'STRONG',    color: '#22C55E', bg: 'rgba(34,197,94,0.12)',  hintKey: 'phase.strong.hint' },
  saturated: { label: 'SATURATED', color: '#EF4444', bg: 'rgba(239,68,68,0.12)',  hintKey: 'phase.saturated.hint' },
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
// Bar color for emergence/adoption scores
function barColor(v) {
  if (v >= 80) return '#22C55E';
  if (v >= 60) return '#4ADE80';
  if (v >= 30) return '#EAB308';
  return '#4B5563';
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
      fetch('/api/preview?url=' + encodeURIComponent(trend.url))
        .then(r => r.json())
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

// ── FeedImage — inline image / video for feed cards ──────────────────────────
// When the trend has a videoUrl we render an HTML5 <video> player with the
// image as its poster (so the card still looks the same until the user clicks
// play). Click/drag on the player doesn't bubble up to the card's onClick —
// otherwise pressing play would open the trend modal.
function FeedImage({ trend }) {
  const [imgUrl, setImgUrl] = useState(trend.imageUrl || null);
  const [tried,  setTried]  = useState(!!trend.imageUrl);
  const [failed, setFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    if (!tried && !imgUrl && trend.url) {
      setTried(true);
      fetch('/api/preview?url=' + encodeURIComponent(trend.url))
        .then(r => r.json())
        .then(d => { if (d.imageUrl) setImgUrl(d.imageUrl); else setFailed(true); })
        .catch(() => setFailed(true));
    }
  }, [trend.url]);

  const hasVideo = !!trend.videoUrl && !videoFailed;

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
function FeedbackBar({ trend, variant }) {
  const initial = trend.feedback || { likes: 0, dislikes: 0, userVote: 0 };
  const [likes,    setLikes]    = useState(initial.likes    || 0);
  const [dislikes, setDislikes] = useState(initial.dislikes || 0);
  const [userVote, setUserVote] = useState(initial.userVote || 0);
  const [busy, setBusy] = useState(false);

  // Resync when the trend prop changes (e.g. list refresh)
  useEffect(() => {
    const fb = trend.feedback || { likes: 0, dislikes: 0, userVote: 0 };
    setLikes(fb.likes || 0);
    setDislikes(fb.dislikes || 0);
    setUserVote(fb.userVote || 0);
  }, [trend.id, trend.feedback && trend.feedback.likes, trend.feedback && trend.feedback.dislikes, trend.feedback && trend.feedback.userVote]);

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
      // Keep trend.feedback cache in sync (affects resync on unrelated updates)
      if (trend.feedback) {
        trend.feedback.likes = res.likes || 0;
        trend.feedback.dislikes = res.dislikes || 0;
        trend.feedback.userVote = res.userVote || 0;
      }
    } catch (err) {
      // Revert on failure
      setLikes(prev.likes); setDislikes(prev.dislikes); setUserVote(prev.userVote);
    } finally {
      setBusy(false);
    }
  };

  return h('div', {
    className: 'fb-bar' + (variant === 'modal' ? ' fb-bar-modal' : ''),
    onClick: e => e.stopPropagation()
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
  );
}

function FeedCard({ trend, onOpen }) {
  useLang();
  const catCls = CAT_CLS[trend.category] || 'cat-other';
  const catIco = CAT_ICONS[trend.category] || '📌';
  const srcIco = SOURCE_ICONS[trend.source] || '📡';
  const srcLbl = SOURCE_LABELS[trend.source] || trend.source;
  const linkLabel = SOURCE_LINK_LABELS[trend.source] || t('feed.open_source');

  const phase     = trend.narrativePhase || null;
  const emergence = trend.emergenceScore || 0;
  const adoption  = trend.adoptionScore  || trend.memePotential || 0;
  const velocity  = trend.velocity       || 0;
  const platforms = trend.uniquePlatforms || 1;

  const handle = '@' + (trend.source === 'google_trends' ? 'google'
                    : trend.source === 'twitter' ? 'twitter_x'
                    : trend.source || 'source');

  const descText = trend.whyItWillPump || trend.aiExplanation || '';
  const isPump = !!trend.whyItWillPump;

  const handleClick = (e) => {
    if (e.target.closest('a') || e.target.closest('button')) return;
    onOpen && onOpen(trend);
  };

  const emergenceColor = barColor(emergence);
  const adoptionColor  = barColor(adoption);

  const avatarCls = SOURCE_ICONS[trend.source] ? (trend.source) : 'default';

  // meta parts for sub row
  const metaParts = [];
  if (platforms > 1) metaParts.push(platforms + 'p');
  const vel = fmtVelocity(velocity);
  if (vel) metaParts.push(vel);
  if (trend.timesSeen > 1) metaParts.push(trend.timesSeen + 'x');

  return h('div', { className: 'feed-card', onClick: handleClick },
    h('div', { className: 'feed-card-head' },
      h('div', { className: 'feed-avatar ' + avatarCls }, srcIco),
      h('div', { className: 'feed-meta' },
        h('div', { className: 'feed-user-row' },
          h('span', { className: 'feed-user' }, srcLbl),
          h('span', { className: 'feed-handle' }, handle),
          h('span', { className: 'feed-dot' }),
          h('span', { className: 'feed-time' }, fmtTime(trend.firstSeen)),
          h('div', { className: 'feed-badges' },
            phase ? h(PhaseBadge, { phase }) : null,
            h(MarketStageBadge, { stage: trend.marketStage }),
            h('span', { className: 'badge ' + catCls, title: t('feed.category_tip') }, catIco + ' ' + (trend.category || 'other'))
          )
        ),
        h('div', { className: 'feed-title' }, trend.title),
        trend.originalTitle && trend.originalTitle !== trend.title
          ? h('div', { className: 'feed-orig' }, trend.originalTitle)
          : null
      )
    ),

    descText
      ? h('div', { className: 'feed-desc' + (isPump ? ' pump' : '') }, isPump ? '⚡ ' + descText : descText)
      : null,

    h(FeedImage, { trend }),

    // Score strip
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
          h('span', { className: 'feed-score-label' }, t('bar.adoption')),
          h('span', { className: 'feed-score-num', style: { color: adoptionColor } }, adoption)
        ),
        h('div', { className: 'feed-score-track' },
          h('div', { className: 'feed-score-fill', style: { width: Math.min(adoption, 100) + '%', background: adoptionColor } })
        )
      )
    ),

    // Actions row
    h('div', { className: 'feed-actions' },
      h('button', {
        className: 'feed-action-btn primary',
        onClick: e => { e.stopPropagation(); onOpen && onOpen(trend); }
      }, t('feed.details')),
      trend.url ? h('a', {
        className: 'feed-action-btn',
        href: trend.url, target: '_blank', rel: 'noopener',
        onClick: e => e.stopPropagation()
      }, '↗ ' + linkLabel) : null,
      trend.tgMessageUrl ? h('a', {
        className: 'feed-action-btn tg',
        href: trend.tgMessageUrl, target: '_blank', rel: 'noopener',
        onClick: e => e.stopPropagation()
      }, '📨 TG') : null,
      h(FeedbackBar, { trend }),
      metaParts.length
        ? h('span', { className: 'feed-action-btn details-hint', style: { cursor: 'default' } }, metaParts.join(' · '))
        : null
    )
  );
}

// Backward-compat alias so existing JSX keeps working if any remains
const TrendCard = FeedCard;

// ── RightPanel — AIO Feeds-style column with Top narratives / Pulse / Activity ─
function RightPanel({ stats, hours, onOpenTrend }) {
  useLang();
  // Top narratives from server-side stats (real top by adoption for the full window)
  // stats.topTrends is populated by /api/stats — same data as /top in TG bot
  const topTrends = (stats && stats.topTrends ? stats.topTrends : []).slice(0, 10);

  const topCategories = (stats && stats.byCategory ? stats.byCategory : []).slice(0, 5);
  const maxCatCount = topCategories.length ? Math.max(...topCategories.map(c => c.count)) : 1;

  const totalSignals = stats ? stats.total || 0 : 0;
  const totalAlerts  = stats ? stats.alerts || 0 : 0;
  const avgScore     = stats ? stats.avgScore || 0 : 0;

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

    // ── Activity summary ──
    h('div', { className: 'right-section' },
      h('div', { className: 'right-section-head' },
        h('span', { className: 'right-section-title' }, t('right.activity')),
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
        )
      )
    ),

    // Categories removed — moved to Stats page to keep right panel compact

   ) // right-panel-inner
   ) // right-panel
  );  // right-panel-sticky
}

// ── TrendModal (side drawer) ───────────────────────────────────────────────────
function TrendModal({ trend, onClose }) {
  useLang();
  const [imgUrl, setImgUrl] = useState(trend.imageUrl || null);
  const [imgLoading, setImgLoading] = useState(!trend.imageUrl && !!trend.url);
  const catCls = CAT_CLS[trend.category] || 'cat-other';
  const catIco = CAT_ICONS[trend.category] || '📌';
  const srcIco = SOURCE_ICONS[trend.source] || '📡';
  const srcLbl = SOURCE_LABELS[trend.source] || trend.source;
  const srcLinkCls = trend.source === 'reddit' ? ' trend-link-reddit'
    : trend.source === 'twitter' ? ' trend-link-twitter'
    : trend.source === 'tiktok' ? ' trend-link-tiktok' : '';

  useEffect(() => {
    if (!imgUrl && trend.url) {
      fetch('/api/preview?url=' + encodeURIComponent(trend.url))
        .then(r => r.json())
        .then(d => { setImgUrl(d.imageUrl || null); setImgLoading(false); })
        .catch(() => setImgLoading(false));
    }
  }, []);

  // Close on Escape
  useEffect(() => {
    const fn = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  const sentCls = trend.sentiment === 'positive' ? 'sentiment-pos'
    : trend.sentiment === 'negative' ? 'sentiment-neg' : 'sentiment-neu';
  const sentLabel = trend.sentiment === 'positive' ? t('sentiment.positive')
    : trend.sentiment === 'negative' ? t('sentiment.negative') : t('sentiment.neutral');

  return h('div', { className: 'modal-overlay', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
    h('div', { className: 'modal-drawer' },

      // Head
      h('div', { className: 'modal-head' },
        h('span', { className: 'badge ' + catCls }, catIco + ' ' + (trend.category || 'other')),
        h('div', { className: 'source-chip' }, srcIco, ' ', srcLbl),
        h('span', { className: 'time-cell', style: { fontSize: 11 } }, fmtTime(trend.firstSeen)),
        h('button', { className: 'modal-close', onClick: onClose }, t('app.esc_close'))
      ),

      // Body
      h('div', { className: 'modal-body' },

        // Media — video with image poster if available, otherwise just image
        imgLoading
          ? h('div', { className: 'modal-image-loading' })
          : trend.videoUrl
            ? h('video', {
                ref: videoVolumeRef,
                className: 'modal-image',
                style: { height: 'auto', maxHeight: 420, objectFit: 'contain', background: '#000' },
                src: trend.videoUrl,
                poster: imgUrl || undefined,
                controls: true,
                preload: 'metadata',
                playsInline: true,
              })
            : imgUrl
              ? h('img', { className: 'modal-image', src: imgUrl, alt: '', onError: () => setImgUrl(null), loading: 'lazy' })
              : null,

        // Title
        h('div', { className: 'modal-title' }, trend.title),

        // Original title
        trend.originalTitle && trend.originalTitle !== trend.title
          ? h('div', { style: { fontSize: 12, color: 'var(--dim)', fontStyle: 'italic' } }, trend.originalTitle)
          : null,

        // Why it'll pump
        trend.whyItWillPump ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.why_pump')),
          h('div', { className: 'modal-section-content pump' }, trend.whyItWillPump)
        ) : null,

        // Why now — concrete triggering event. Rendered only when the AI
        // found an explicit cause; empty string means "no visible trigger".
        trend.whyNow ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.why_now')),
          h('div', { className: 'modal-section-content why-now' }, trend.whyNow)
        ) : null,

        // AI explanation
        trend.aiExplanation ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.ai_explanation')),
          h('div', { className: 'modal-section-content' }, trend.aiExplanation)
        ) : null,

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

        // Phase + two bars
        trend.narrativePhase ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.phase')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
            h(PhaseBadge, { phase: trend.narrativePhase }),
            h('span', { style: { fontSize: 12, color: 'var(--dim)' } },
              phaseHint(trend.narrativePhase) || phaseHint('early')
            )
          ),
          h(ScoreBar, { label: t('bar.emergence'), value: trend.emergenceScore || 0 }),
          h('div', { style: { height: 4 } }),
          h(ScoreBar, { label: t('bar.adoption'),  value: trend.adoptionScore || trend.memePotential || 0 })
        ) : null,

        // Stats grid
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.metrics')),
          h('div', { className: 'modal-stats-grid' },
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, t('modal.meme_score')),
              h(MemeScore, { value: trend.memePotential || 0 })
            ),
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, t('modal.lifespan')),
              h('span', { className: 'lifespan' }, lifespanLabel(trend.predictedLifespan))
            ),
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, t('modal.virality')),
              h('span', { style: { fontFamily: 'JetBrains Mono', fontWeight: 700, color: 'var(--accent2)' } }, trend.score || 0)
            ),
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, t('modal.sentiment')),
              h('span', { className: sentCls }, sentLabel)
            ),
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, t('modal.seen')),
              h('span', { style: { fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 700 } }, trend.timesSeen || 1, t('modal.seen_suffix'))
            )
          )
        ),

        // Feedback
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.feedback')),
          h(FeedbackBar, { trend, variant: 'modal' })
        ),

        // Actions
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, t('modal.links')),
          h('div', { className: 'modal-actions' },
            trend.url ? h('a', { className: 'trend-link' + srcLinkCls, href: trend.url, target: '_blank', rel: 'noopener' }, t('modal.source_link', { ico: srcIco })) : null,
            trend.tgMessageUrl ? h('a', { className: 'trend-link trend-link-tg', href: trend.tgMessageUrl, target: '_blank', rel: 'noopener' }, t('modal.tg_link')) : null
          )
        )
      )
    )
  );
}

// ── Toast system ───────────────────────────────────────────────────────────────
function Toasts({ toasts }) {
  return h('div', { className: 'toasts-wrap' },
    toasts.map(t => h('div', { key: t.id, className: 'toast ' + (t.type || 'info') },
      h('span', { className: 'toast-icon' }, t.type === 'success' ? '✅' : t.type === 'error' ? '❌' : 'ℹ️'),
      h('span', { className: 'toast-msg' }, t.msg)
    ))
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

// ── StatusBar — bottom strip ─────────────────────────────────────────────────
function StatusBar({ stats, scanning, sources }) {
  useLang();
  const active = (sources || []).filter(function(s) { return s.enabled; }).length;
  const total  = (sources || []).length;
  const paused = !!(stats && stats.paused);
  const srcOk  = active === total && total > 0;
  return h('div', { className: 'statusbar' },
    h('span', {
      className: 'statusbar-item',
      style: { color: paused ? 'var(--red2)' : 'var(--green2)', fontWeight: 700 }
    },
      h('div', { className: 'statusbar-dot' + (paused ? ' paused' : '') }),
      paused ? t('status.offline') : t('status.live')
    ),
    h('div', { className: 'statusbar-sep' }),
    h('span', { className: 'statusbar-item' },
      h('span', { className: 'sb-key' }, t('status.signals')),
      h('b', null, String(stats ? stats.total || 0 : 0))
    ),
    h('span', { className: 'statusbar-item' },
      h('span', { className: 'sb-key' }, t('status.alerts')),
      h('b', null, String(stats ? stats.alerts || 0 : 0))
    ),
    h('span', { className: 'statusbar-item' },
      h('span', { className: 'sb-key' }, t('status.sources')),
      h('b', { style: { color: srcOk ? 'var(--green2)' : 'var(--orange)' } }, active + '/' + total)
    ),
    scanning
      ? h('span', { className: 'statusbar-item', style: { color: 'var(--accent2)' } },
          h('span', { className: 'sb-key', style: { color: 'var(--accent2)' } }, t('status.updating'))
        )
      : null,
    h('span', { className: 'statusbar-hint' },
      h('span', { className: 'statusbar-kbd' }, h('b', null, 'R'), t('status.kbd.refresh')),
      h('span', { className: 'statusbar-kbd' }, h('b', null, 'Esc'), t('status.kbd.close'))
    )
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
                h('span', null, '📡 ' + (src.source === 'google_trends' ? 'Google' : src.source.charAt(0).toUpperCase() + src.source.slice(1))),
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

function StatsPanel({ stats, hours, onBack, onOpenTrend }) {
  useLang();
  const sourceOrder = ['reddit', 'google_trends', 'twitter', 'tiktok'];
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
  fontSize:      14,   // 12..16
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
function applyPrefsToDOM(p) {
  const b = document.body;
  if (!b) return;
  b.classList.toggle('prefs-compact', p.density === 'compact');
  b.classList.toggle('prefs-no-images', !p.showImages);
  b.classList.toggle('prefs-no-anim',  !p.animations);
  try { b.style.setProperty('--user-font-size', p.fontSize + 'px'); } catch (e) {}
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
function Sheet({ title, icon, onClose, children }) {
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
    h('div', { className: 'sheet', role: 'dialog', 'aria-modal': 'true' },
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

const Row = ({ icon, title, desc, control }) =>
  h('div', { className: 'setting-row' },
    h('div', { className: 'setting-label' },
      h('span', { className: 'setting-name' }, icon ? (icon + ' ') : '', title),
      desc ? h('span', { className: 'setting-hint' }, desc) : null
    ),
    h('div', { className: 'setting-control' }, control)
  );

// ── PersonalizationCard ───────────────────────────────────────────────────────
// Fetches the current user's category preference map plus the on/off toggle.
// Shows the user a transparent view of "the feed boosts these categories and
// damps those" so they can trust or disable it. No per-trend badges on cards.
function PersonalizationCard() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [prefs,   setPrefs]   = useState([]);     // [{ category, net }]
  const [err,     setErr]     = useState(null);

  useEffect(() => {
    let cancelled = false;
    api('/personalization')
      .then(d => {
        if (cancelled) return;
        setEnabled(!!d.enabled);
        setPrefs(Array.isArray(d.prefs) ? d.prefs : []);
      })
      .catch(e => { if (!cancelled) setErr(e.message || 'load failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async (v) => {
    setEnabled(v);
    try { await api('/personalization', { method: 'POST', body: JSON.stringify({ enabled: v }) }); }
    catch (e) { setEnabled(!v); setErr(e.message || 'save failed'); }
  };

  return h('div', { className: 'settings-card' },
    h('div', { className: 'settings-card-title' }, t('settings.personalization')),
    h('div', { className: 'settings-card-desc' }, t('settings.personalization_desc')),
    h(Row, {
      icon: '🎯', title: t('settings.personalization_toggle'),
      desc: t('settings.personalization_toggle_desc'),
      control: h(Toggle, { on: enabled, onChange: toggle }),
    }),
    loading
      ? h('div', { className: 'settings-card-desc' }, '…')
      : err
        ? h('div', { className: 'settings-card-desc', style: { color: 'var(--red, #ff6b6b)' } }, err)
        : prefs.length === 0
          ? h('div', { className: 'settings-card-desc' }, t('settings.personalization_empty'))
          : h('div', { className: 'pref-chips' },
              prefs.map(p => {
                const up = p.net > 0;
                const cls = 'pref-chip ' + (up ? 'up' : 'down');
                const sign = up ? '+' : '';
                return h('span', { key: p.category, className: cls },
                  h('span', { className: 'pref-chip-name' }, p.category),
                  h('span', { className: 'pref-chip-val'  }, sign + p.net)
                );
              })
            )
  );
}

function SettingsPanel({ onBack, onResetHiddenSources, hiddenSourcesCount }) {
  const lang = useLang();
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
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, t('settings.language')),
      h('div', { className: 'settings-card-desc' },
        t('settings.language_desc')
      ),
      h(Row, {
        icon: '🌐', title: t('settings.language'),
        desc: null,
        control: h('div', { className: 'seg-group seg-compact' },
          [{ v: 'en', l: '🇺🇸 EN' }, { v: 'ru', l: '🇷🇺 RU' }].map(o =>
            h('button', {
              key: o.v,
              className: 'seg-btn' + (lang === o.v ? ' active' : ''),
              onClick: () => setLang(o.v)
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
        icon: '🔠', title: t('settings.font_size'),
        desc: t('settings.font_size_desc'),
        control: h('div', { className: 'seg-group seg-compact' },
          [{ v: 12, l: 'S' }, { v: 14, l: 'M' }, { v: 16, l: 'L' }].map(o =>
            h('button', {
              key: o.v,
              className: 'seg-btn' + (prefs.fontSize === o.v ? ' active' : ''),
              onClick: () => update({ fontSize: o.v })
            }, o.l)
          )
        )
      }),
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

    // ── Personalization (per-category boost from 👍/👎 history) ──
    h(PersonalizationCard),

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

    // ── Reset ──
    h('div', { className: 'settings-actions' },
      h('button', { className: 'btn btn-ghost', onClick: resetAllPrefs }, t('settings.reset_all'))
    )
  );
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
        ? h(Row, {
            icon: '🎯', title: t('account.threshold'),
            desc: t('account.threshold_desc'),
            control: h('span', { className: 'pref-value' }, user.threshold + '%')
          })
        : null,
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
//   1. POST /api/auth/initiate → { sessionId, botUrl }
//   2. User clicks "Войти через Telegram" → bot issues a 6-digit code
//   3. User enters code → POST /api/auth/verify → { token, user }
function LoginScreen({ onLoggedIn }) {
  const lang = useLang();
  const [phase, setPhase]       = useState('idle');        // idle | linking | code | verifying
  const [session, setSession]   = useState(null);          // { sessionId, botUrl }
  const [code, setCode]         = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const startLogin = async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/auth/initiate', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      if (!data.botUrl) throw new Error(t('login.bot_unavailable'));
      setSession(data);
      setPhase('code');
      try { window.open(data.botUrl, '_blank', 'noopener'); } catch (e) {}
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const submitCode = async () => {
    const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
    if (clean.length !== 6) { setError(t('login.err_need_6')); return; }
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

  return h('div', {
    style: {
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px', background: 'var(--bg, #0a0a0f)'
    }
  },
    h('div', {
      style: {
        maxWidth: '420px', width: '100%',
        background: 'var(--card, #14141c)',
        border: '1px solid var(--border, #22222e)',
        borderRadius: '16px',
        padding: '32px 28px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)'
      }
    },
      // Language switcher — small, top-right corner, so first-time users can pick
      h('div', {
        style: {
          display: 'flex', justifyContent: 'flex-end', gap: 6,
          marginBottom: 10, marginTop: -6
        }
      },
        [{ v: 'en', l: '🇺🇸 EN' }, { v: 'ru', l: '🇷🇺 RU' }].map(o =>
          h('button', {
            key: o.v,
            onClick: () => setLang(o.v),
            style: {
              padding: '4px 10px', fontSize: 11,
              background: lang === o.v ? 'rgba(var(--accent-rgb), 0.18)' : 'transparent',
              color: lang === o.v ? '#9ea7ff' : 'var(--muted, #888)',
              border: '1px solid ' + (lang === o.v ? 'rgba(var(--accent-rgb), 0.4)' : 'rgba(255,255,255,0.08)'),
              borderRadius: 6, cursor: 'pointer'
            }
          }, o.l)
        )
      ),

      h('div', { style: { textAlign: 'center', marginBottom: '20px' } },
        h('div', { style: { fontSize: '44px', lineHeight: '1' } }, '🔥'),
        h('div', { style: { fontSize: '22px', fontWeight: '700', marginTop: '8px' } }, t('app.title')),
        h('div', { style: { fontSize: '13px', opacity: '0.65', marginTop: '4px' } }, t('login.subtitle'))
      ),

      phase === 'idle' && h('div', null,
        h('p', { style: { fontSize: '14px', lineHeight: '1.5', opacity: '0.85', marginBottom: '16px' } },
          t('login.idle_desc')
        ),
        h('button', {
          className: 'btn',
          style: {
            width: '100%', padding: '12px 16px', fontSize: '15px', fontWeight: '600',
            background: '#229ED9', color: '#fff', border: 'none', borderRadius: '10px',
            cursor: 'pointer', opacity: loading ? 0.6 : 1
          },
          disabled: loading,
          onClick: startLogin
        }, loading ? t('app.please_wait') : t('login.idle_btn'))
      ),

      phase === 'code' && h('div', null,
        h('p', { style: { fontSize: '14px', lineHeight: '1.5', opacity: '0.85', marginBottom: '12px' } },
          t('login.code_desc')
        ),
        session?.botUrl && h('a', {
          href: session.botUrl, target: '_blank', rel: 'noopener',
          style: {
            display: 'block', textAlign: 'center', padding: '10px 14px',
            background: 'rgba(34,158,217,0.15)', color: '#5bb8e0',
            border: '1px solid rgba(34,158,217,0.35)', borderRadius: '8px',
            textDecoration: 'none', fontSize: '13px', marginBottom: '16px'
          }
        }, t('login.reopen_bot')),
        h('input', {
          type: 'text', inputMode: 'numeric', pattern: '[0-9]*', autoFocus: true,
          maxLength: 6, value: code,
          onChange: e => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6);
            setCode(v);
            if (error) setError('');
          },
          onKeyDown: e => {
            if (e.key === 'Enter' && code.length === 6 && !loading) submitCode();
          },
          placeholder: '• • • • • •',
          style: {
            width: '100%', padding: '14px', fontSize: '22px', letterSpacing: '0.4em',
            textAlign: 'center', background: '#0b0b12', color: 'var(--text, #e8e8ef)',
            border: '1px solid var(--border, #22222e)', borderRadius: '10px',
            fontFamily: 'ui-monospace, monospace', marginBottom: '12px', boxSizing: 'border-box'
          }
        }),
        h('button', {
          style: {
            width: '100%', padding: '12px 16px', fontSize: '15px', fontWeight: '600',
            background: 'var(--accent, #ff6b35)', color: '#fff', border: 'none',
            borderRadius: '10px', cursor: 'pointer', opacity: loading ? 0.6 : 1
          },
          disabled: loading || code.length !== 6,
          onClick: submitCode
        }, loading ? t('login.verifying') : t('login.verify_btn')),
        h('button', {
          style: {
            width: '100%', marginTop: '10px', padding: '8px', fontSize: '12px',
            background: 'transparent', color: 'var(--muted, #888)', border: 'none',
            cursor: 'pointer'
          },
          onClick: () => { setPhase('idle'); setSession(null); setCode(''); setError(''); }
        }, t('app.cancel'))
      ),

      error && h('div', {
        style: {
          marginTop: '14px', padding: '10px 12px', fontSize: '13px',
          background: 'rgba(239,68,68,0.1)', color: '#f87171',
          border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px'
        }
      }, error)
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
// Single source of truth for "Feed / Stats / Settings" navigation.
function BottomNav({ view, setView }) {
  useLang(); // re-render on language switch
  // Settings/Account live in top-right of the nav bar — not duplicated here.
  const tabs = [
    { id: 'trends', icon: '🔥', label: t('nav.feed')  },
    { id: 'stats',  icon: '📊', label: t('nav.stats') },
  ];
  return h('div', { className: 'sidebar-footer' },
    h('div', { className: 'sb-foot-nav', role: 'tablist' },
      tabs.map(tab => h('button', {
        key: tab.id,
        type: 'button',
        role: 'tab',
        'aria-selected': view === tab.id,
        className: 'sb-foot-btn' + (view === tab.id ? ' active' : ''),
        onClick: () => setView(tab.id),
        title: tab.label,
      },
        h('span', { className: 'sb-foot-ico' }, tab.icon),
        h('span', null, tab.label)
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
  const [minMeme,    setMinMeme]    = useState(0);
  const [offset,     setOffset]     = useState(0);
  const [scanning,   setScanning]   = useState(false);
  const [sort,       setSort]       = useState('rank');
  const [phase,      setPhase]      = useState('');
  const [view,       setView]       = useState('trends');
  const [modalTrend, setModalTrend] = useState(null);
  const [toasts,     setToasts]     = useState([]);
  const [search,     setSearch]     = useState('');
  const [refreshAt,  setRefreshAt]  = useState(Date.now() + 90000);
  // Refresh pulse — stays on for at least MIN_PULSE_MS so the animation is visible
  // even when fetchData resolves in <200ms.
  const [refreshPulse, setRefreshPulse] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hiddenSources, setHiddenSources] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ts_hidden_sources') || '[]')); }
    catch (e) { return new Set(); }
  });
  const toastId = useRef(0);
  const sentinelRef = useRef(null);
  const mainFeedRef = useRef(null);
  const LIMIT = 25;

  // addToast helper — auto-dismiss after 4s
  const addToast = useCallback((msg, type = 'info') => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

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
        (phase    ? '&phase='    + phase    : '') +
        (minMeme > 0 ? '&minMeme=' + minMeme : '');

      const [st, tr, sr] = await Promise.all([
        api('/stats?hours=' + hours),
        api('/trends' + q),
        api('/sources'),
      ]);
      setStats(st);
      setTotal(tr.total  || 0);
      if (shouldAppend) {
        const incoming = tr.trends || [];
        setTrends(prev => {
          // Dedupe by id in case page boundary shifted due to new inserts
          const have = new Set(prev.map(x => x.id));
          return [...prev, ...incoming.filter(x => !have.has(x.id))];
        });
      } else {
        setTrends(tr.trends || []);
      }
      setSources(sr.sources || []);
    } catch (ex) { setError(t('toast.error_prefix', { e: ex.message })); }
    if (shouldAppend) setLoadingMore(false);
    else setLoading(false);
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, MIN_PULSE_MS - elapsed);
    setTimeout(() => setRefreshPulse(false), remaining);
  }, [hours, category, source, phase, minMeme, offset, sort]);

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
        (phase    ? '&phase='    + phase    : '') +
        (minMeme > 0 ? '&minMeme=' + minMeme : '');
      const [st, tr, sr] = await Promise.all([
        api('/stats?hours=' + hours),
        api('/trends' + q),
        api('/sources'),
      ]);
      setStats(st);
      setTotal(tr.total || 0);
      setTrends(tr.trends || []);
      setSources(sr.sources || []);
    } catch (ex) { setError(t('toast.error_prefix', { e: ex.message })); }
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, MIN_PULSE_MS - elapsed);
    setTimeout(() => setRefreshPulse(false), remaining);
  }, [hours, category, source, phase, minMeme, offset, sort]);


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
    if (search.trim()) return;            // no auto-load during active search
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
  }, [search, loading, loadingMore, trends.length, total]);
  useEffect(() => {
    const handleNavigate = (event) => {
      const nextView = event && event.detail ? event.detail.view : null;
      if (nextView) setView(nextView);
    };
    window.addEventListener('dashboard:navigate', handleNavigate);
    return () => window.removeEventListener('dashboard:navigate', handleNavigate);
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
    setHours(24); setMinMeme(0); setCategory(''); setSource(''); setSort('rank'); setOffset(0);
    addToast(t('toast.filters_reset'), 'info');
  };

  // Client-side search filter (doesn't reset pagination) + visual source filter
  const searchFiltered = search.trim()
    ? trends.filter(t => {
        const q = search.toLowerCase();
        return (t.title || '').toLowerCase().includes(q)
          || (t.originalTitle || '').toLowerCase().includes(q)
          || (t.aiExplanation || '').toLowerCase().includes(q)
          || (t.category || '').toLowerCase().includes(q);
      })
    : trends;
  const visibleTrends = hiddenSources.size
    ? searchFiltered.filter(t => !hiddenSources.has(t.source))
    : searchFiltered;

  // ── Auth gate ───────────────────────────────────────────────────────────
  if (me === false) return h(LoginScreen, { onLoggedIn: handleLoggedIn });
  if (me === null)  return h('div', {
    style: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.7 }
  }, t('app.loading'));

  return h('div', null,
    // Toast notifications (fixed top-right)
    h(Toasts, { toasts }),

    // Bottom status bar
    h(StatusBar, { stats, scanning, sources }),

    // Side drawer modal
    modalTrend ? h(TrendModal, { trend: modalTrend, onClose: () => setModalTrend(null) }) : null,

    // ── Nav ──
    h('nav', { className: 'nav' },
      h('div', { className: 'nav-logo' },
        h('span', { className: 'nav-logo-icon' }, '🐱'),
        h('span', { className: 'nav-logo-text' }, t('app.title'))
      ),
      h('span', { className: 'nav-subtitle' }, t('app.subtitle')),
      h('div', { className: 'nav-right' },
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
            ...sources.map(s => {
              const visible = !hiddenSources.has(s.source);
              const cnt = s.last24h || 0;
              return h('div', {
                key: s.source,
                'data-src': s.source,
                className: 'source-item ' + (visible ? 'on' : 'off'),
                onClick: () => toggle(s.source),
                title: visible ? t('tooltip.hide_source') : t('tooltip.show_source')
              },
                h('span', { className: 'source-icon' }, SOURCE_ICONS[s.source] || '📡'),
                h('span', { className: 'source-name' }, SOURCE_LABELS[s.source] || s.source),
                h('span', { className: 'source-count' + (cnt >= 50 ? ' hot' : '') }, cnt),
                h('span', { className: 'source-eye' }, visible ? '👁' : '🙈')
              );
            }),

            h('div', { className: 'sidebar-divider' }),

            // ── Phase filter chips (moved from feed header) ──
            h('div', { className: 'sidebar-section' },
              h('span', null, t('sidebar.phase')),
              phase
                ? h('span', { className: 'sidebar-section-link', onClick: () => { setPhase(''); setOffset(0); }, title: t('tooltip.reset') }, t('sidebar.reset'))
                : null
            ),
            h('div', { className: 'sidebar-phase' },
              h('button', {
                type: 'button',
                className: 'phase-chip' + (phase === '' ? ' active' : ''),
                onClick: () => { setPhase(''); setOffset(0); }
              }, h('span', { className: 'phase-chip-dot' }, '◆'),
                 h('span', { className: 'phase-chip-label' }, t('feed.filter.all')),
                 h('span', { className: 'phase-chip-count' }, total)
              ),
              ['early','forming','strong','saturated'].map(p =>
                h('button', {
                  key: p,
                  type: 'button',
                  className: 'phase-chip phase-chip-' + p + (phase === p ? ' active' : ''),
                  onClick: () => { setPhase(phase === p ? '' : p); setOffset(0); }
                },
                  h('span', { className: 'phase-chip-dot' }, PHASE_DOT[p]),
                  h('span', { className: 'phase-chip-label' }, PHASE_META[p].label)
                )
              )
            ),

            h('div', { className: 'sidebar-divider' }),

            h('div', { className: 'sidebar-section' },
              h('span', null, t('sidebar.filters')),
              (hours !== 24 || minMeme !== 0 || category || sort !== 'rank')
                ? h('span', { className: 'sidebar-section-link', onClick: resetFilters, title: t('tooltip.reset') }, t('sidebar.reset'))
                : null
            ),
            h('div', { className: 'sidebar-filters' },

              // Time window (segmented)
              h('div', { className: 'filter-group' },
                h('div', { className: 'filter-label' },
                  h('span', null, t('sidebar.window')),
                  h('span', { className: 'filter-val' }, hours < 24 ? hours + 'h' : (hours / 24) + 'd')
                ),
                h('div', { className: 'seg-group seg-compact' },
                  [{ v: 6, l: '6h' }, { v: 24, l: '24h' }, { v: 72, l: '3d' }, { v: 168, l: '7d' }].map(o =>
                    h('button', {
                      key: o.v,
                      className: 'seg-btn' + (hours === o.v ? ' active' : ''),
                      onClick: () => { setHours(o.v); setOffset(0); }
                    }, o.l)
                  )
                )
              ),

              // Adoption threshold (segmented)
              h('div', { className: 'filter-group' },
                h('div', { className: 'filter-label' },
                  h('span', null, t('sidebar.adoption')),
                  h('span', { className: 'filter-val' }, '≥ ' + minMeme)
                ),
                h('div', { className: 'seg-group seg-compact' },
                  [0, 30, 50, 70, 85].map(v =>
                    h('button', {
                      key: v,
                      className: 'seg-btn' + (minMeme === v ? ' active' : ''),
                      onClick: () => { setMinMeme(v); setOffset(0); }
                    }, v)
                  )
                )
              ),

              // Category (dropdown — too many options for segments)
              h('div', { className: 'filter-group' },
                h('div', { className: 'filter-label' }, h('span', null, t('sidebar.category'))),
                h('select', {
                  value: category,
                  onChange: ev => { setCategory(ev.target.value); setOffset(0); },
                  style: { width: '100%' }
                },
                  h('option', { value: '' }, t('sidebar.all_categories')),
                  Object.keys(CAT_ICONS).map(c => h('option', { key: c, value: c }, CAT_ICONS[c] + ' ' + c))
                )
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

            // Unified bottom nav (Feed / Stats / Settings)
            h(BottomNav, { view, setView })
          ),

          // Draggable divider between sidebar and main feed
          h(ColumnResizer, { side: 'left' }),

          // ── Main feed ──
          h('main', { className: 'main-feed', ref: mainFeedRef },
            error ? h('div', { className: 'error-bar', style: { marginBottom: 12 } }, '⚠️ ', error) : null,

            h('div', { className: 'feed-panel' + (refreshPulse && trends.length > 0 ? ' is-refreshing' : '') },

              // ── Feed panel header ──
              h('div', { className: 'feed-panel-head' },
                h('div', { className: 'feed-panel-top' },
                  h('div', { className: 'feed-panel-icon' }, '🔥'),
                  h('div', null,
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
                      className: 'btn btn-ghost' + (refreshPulse ? ' is-spinning' : ''),
                      onClick: () => { if (!loading) { refreshAll(); addToast(t('toast.refreshing'), 'info'); } },
                      disabled: loading,
                      style: { fontSize: 11, padding: '6px 10px' },
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
                      visibleTrends.map(t => h(FeedCard, { key: t.id, trend: t, onOpen: setModalTrend }))
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
      onClose: () => setView('trends'),
    },
      h(AccountPanel, {
        onBack: () => setView('trends'),
        user: me,
        onLogout: handleLogout,
      })
    ) : null,

    view === 'stats' ? h(Sheet, {
      title: t('nav.stats'),
      icon: '📊',
      onClose: () => setView('trends'),
    },
      h(StatsPanel, {
        stats, hours,
        onBack: () => setView('trends'),
        onOpenTrend: setModalTrend,
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
