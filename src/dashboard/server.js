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
      username:   user.username || null,
      language:   user.language || 'en',
      plan:       user.plan_name || 'free',
      status:     user.status || 'active',
      threshold:  user.alert_threshold ?? null,
      subscriptionExpiresAt: user.subscription_expires_at || null,
    };
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
    let orderBy;
    if      (sortParam === 'time')      orderBy = 'first_seen_at DESC';
    else if (sortParam === 'virality')  orderBy = 'score DESC';
    else if (sortParam === 'meme')      orderBy = "CAST(JSON_EXTRACT(raw_metrics, '$.memePotential') AS INT) DESC";
    else if (sortParam === 'emergence') orderBy = "CAST(JSON_EXTRACT(raw_metrics, '$.emergenceScore') AS INT) DESC";
    else                                orderBy = "CAST(JSON_EXTRACT(raw_metrics, '$.rankScore') AS INT) DESC";

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

    return json(res, 200, { trends, total, limit, offset });
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
      `SELECT * FROM trends WHERE first_seen_at > ? ORDER BY CAST(JSON_EXTRACT(raw_metrics, '$.memePotential') AS INT) DESC LIMIT 5`
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
      predictedLifespan: row.predicted_lifespan,
      url:             row.url,
      tgMessageUrl:    metrics.tgMessageUrl || null,
      userFeedback:    row.user_feedback || 0,
      firstSeen:       row.first_seen_at,
      lastSeen:        row.last_seen_at,
      timesSeen:       row.times_seen,
      imageUrl:        metrics.imageUrl || metrics.thumbnailUrl || metrics.thumbnail || null,
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
          // media.all[0]: photo → .url, video → .thumbnail_url
          const media = data?.tweet?.media?.all?.[0];
          const imageUrl = media?.thumbnail_url || media?.url || null;
          this.logger.info(`[Preview] tweet ${tweetId} → ${imageUrl ? 'has image' : 'no media'}`);
          return json(res, 200, { imageUrl });
        } catch (err) {
          clearTimeout(timer);
          this.logger.info(`[Preview] fxtwitter fetch error for tweet ${tweetId}: ${err.message}`);
          return json(res, 200, { imageUrl: null });
        }
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

    :root {
      --bg:          #08080f;
      --surface:     #0d0d18;
      --card:        #101020;
      --card2:       #13132a;
      --card3:       #181832;
      --border:      rgba(255,255,255,.055);
      --border2:     rgba(255,255,255,.09);
      --border3:     rgba(255,255,255,.14);
      --text:        #e4eaf8;
      --text2:       #c8d3e8;
      --muted:       #8594b0;
      --dim:         #4a5470;
      --accent:      #6272ff;
      --accent2:     #818cf8;
      --accent-glow: rgba(98,114,255,.15);
      --green:       #00d4aa;
      --green2:      #2dddb8;
      --red:         #ff4560;
      --red2:        #ff7088;
      --orange:      #ff9f43;
      --orange2:     #ffd089;
      --yellow:      #f6c453;
      --yellow2:     #ffe39d;
      --blue:        #38bdf8;
      --pink:        #e879f9;
      --teal:        #06b6d4;
      --purple:      #a78bfa;
      --radius:      10px;
      --radius-sm:   8px;
      --radius-xs:   6px;
      --shadow:      0 4px 20px rgba(0,0,0,.5);
      --shadow-lg:   0 8px 40px rgba(0,0,0,.65);
      --glass:       rgba(255,255,255,.03);
      --glass2:      rgba(255,255,255,.055);
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

    /* ── Animations ── */
    @keyframes pulse    { 0%,100%{opacity:1} 50%{opacity:.2} }
    @keyframes spin     { to { transform: rotate(360deg); } }
    @keyframes fadeIn   { from { opacity:0; transform: translateY(5px); } to { opacity:1; transform: translateY(0); } }
    @keyframes slideIn  { from { opacity:0; transform: translateX(-10px); } to { opacity:1; transform: translateX(0); } }
    @keyframes shimmer  { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    @keyframes glow     { 0%,100% { box-shadow: 0 0 6px rgba(98,114,255,.3); } 50% { box-shadow: 0 0 16px rgba(98,114,255,.5); } }

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
      box-shadow: 0 1px 0 rgba(98,114,255,.04), 0 6px 16px rgba(0,0,0,.25);
    }
    .nav::after {
      content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
      background: linear-gradient(90deg, transparent 0%, rgba(98,114,255,.22) 20%, rgba(98,114,255,.22) 80%, transparent 100%);
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
      background: linear-gradient(135deg, rgba(98,114,255,.22), rgba(98,114,255,.05));
      border: 1px solid rgba(98,114,255,.28);
      box-shadow: 0 2px 10px rgba(98,114,255,.18), inset 0 1px 0 rgba(255,255,255,.05);
    }
    .nav-logo-text {
      background: linear-gradient(180deg, #fff 0%, #cfd4ff 100%);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .nav-version {
      font-size: 9px; font-weight: 700; letter-spacing: .4px;
      color: var(--accent2); background: var(--accent-glow);
      border: 1px solid rgba(98,114,255,.22); border-radius: 6px;
      padding: 2px 7px; font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase;
    }
    .nav-sep {
      width: 1px; height: 18px;
      background: linear-gradient(180deg, transparent, var(--border2), transparent);
    }
    .nav-subtitle { font-size: 9px; color: var(--dim); letter-spacing: 1.6px; text-transform: uppercase; font-weight: 700; }
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
    .status-pill:hover { border-color: rgba(98,114,255,.3); }
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
    .sidebar-section-link:hover { color: var(--accent2); background: rgba(98,114,255,.08); }

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
    .source-count.hot { color: var(--accent2); background: rgba(98,114,255,.1); border-color: rgba(98,114,255,.22); }
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
      box-shadow: 0 0 0 1px rgba(98,114,255,.2);
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
    .sb-reset-btn:hover { color: var(--red2); border-color: rgba(255,69,96,.35); background: rgba(255,69,96,.04); }

    /* ── Sidebar footer (stats/settings row) ── */
    .sidebar-footer {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
      padding: 6px 2px 4px;
    }
    .sb-foot-btn {
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 9px 6px; border-radius: 8px;
      background: rgba(255,255,255,.025); border: 1px solid var(--border);
      cursor: pointer; transition: all .15s;
      color: var(--muted); font-size: 10.5px; font-weight: 600;
    }
    .sb-foot-btn .sb-foot-ico { font-size: 15px; filter: saturate(.8); }
    .sb-foot-btn:hover { color: var(--text); background: rgba(255,255,255,.05); border-color: var(--border2); }
    .sb-foot-btn.active { color: var(--accent2); background: var(--accent-glow); border-color: rgba(98,114,255,.25); }

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
      background: rgba(98,114,255,.1); border: 1px solid rgba(98,114,255,.2);
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
    .hero-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green2); box-shadow: 0 0 6px rgba(0,212,170,.5); }
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
    .stat-card:hover { border-color: rgba(98,114,255,.28); transform: translateY(-1px); }
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
    .control-btn:hover { border-color: rgba(98,114,255,.28); background: rgba(98,114,255,.07); color: var(--accent2); transform: translateY(-1px); }
    .control-btn:active { transform: translateY(0); }
    .control-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; }
    .control-icon { font-size: 17px; display: block; line-height: 1; }
    .control-label { font-size: 10px; color: inherit; }
    .control-status {
      position: absolute; top: 5px; right: 5px;
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--green2); box-shadow: 0 0 5px rgba(0,212,170,.6);
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
    .source-control-btn:hover { border-color: rgba(98,114,255,.22); background: rgba(98,114,255,.05); }
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
      border-color: rgba(98,114,255,.3); color: var(--text);
      box-shadow: 0 0 0 1px rgba(98,114,255,.2);
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
      border-color: rgba(98,114,255,.3);
      box-shadow: 0 0 0 1px rgba(98,114,255,.1) inset;
    }
    .btn-primary:hover {
      background: rgba(98,114,255,.18); color: var(--text);
      border-color: rgba(98,114,255,.5);
      box-shadow: 0 0 14px rgba(98,114,255,.18);
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
      border-color: rgba(98,114,255,.28);
      background: rgba(98,114,255,.025);
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
    .meme-num.hot  { color: var(--red2); text-shadow: 0 0 10px rgba(255,69,96,.35); }
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

    /* ── Pagination ── */
    .pagination {
      display: flex; gap: 7px; align-items: center;
      justify-content: center; padding: 12px;
      border-top: 1px solid var(--border);
    }
    .page-info { font-size: 11px; color: var(--dim); font-family: 'JetBrains Mono', monospace; }

    /* ── Loading / Empty ── */
    .loading-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; gap: 14px; }
    .loading-spinner { width: 28px; height: 28px; border-radius: 50%; border: 2px solid rgba(255,255,255,.06); border-top-color: var(--accent); animation: spin .7s linear infinite; }
    .loading-text { font-size: 12px; color: var(--dim); font-weight: 500; }
    .empty-wrap { display: flex; flex-direction: column; align-items: center; padding: 60px 20px; gap: 12px; }
    .empty-icon { font-size: 40px; opacity: .15; }
    .empty-text { font-size: 13px; color: var(--dim); font-weight: 500; }

    /* ── Error ── */
    .error-bar {
      background: rgba(255,69,96,.07); border: 1px solid rgba(255,69,96,.2);
      color: var(--red2); padding: 10px 14px; border-radius: 8px;
      margin-bottom: 12px; font-size: 12px; font-weight: 500;
      display: flex; align-items: center; gap: 8px;
      animation: fadeIn .25s ease;
    }

    /* ── Settings panel ── */
    .settings-panel { padding: 20px 24px; max-width: 680px; animation: fadeIn .25s ease; }
    .settings-header { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
    .settings-title { font-size: 17px; font-weight: 800; color: var(--text); letter-spacing: -.3px; }
    .settings-card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 18px 20px; margin-bottom: 12px; box-shadow: var(--shadow);
    }
    .settings-card-title { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 3px; }
    .settings-card-desc  { font-size: 11px; color: var(--muted); margin-bottom: 16px; }
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
    .stats-top-card:hover { border-color: rgba(98,114,255,.25); background: rgba(98,114,255,.05); }
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
      background: var(--accent-glow); border: 1px solid rgba(98,114,255,.22);
      padding: 4px 10px; border-radius: 999px; letter-spacing: .2px;
      animation: fadeIn .2s ease;
    }
    .settings-info { border-style: dashed; background: linear-gradient(180deg, rgba(98,114,255,.05), transparent); }

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
    .preset-card.active { border-color: var(--accent); background: rgba(98,114,255,.1); box-shadow: 0 0 0 1px var(--accent); }
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
    .sidebar-settings-btn.active { background: rgba(98,114,255,.1); color: var(--accent2); border-color: rgba(98,114,255,.2); }

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
    .toast.success { border-color: rgba(0,212,170,.25); }
    .toast.success .toast-icon { color: var(--green2); }
    .toast.error   { border-color: rgba(255,69,96,.25); }
    .toast.error   .toast-icon { color: var(--red2); }
    .toast.info    { border-color: rgba(98,114,255,.25); }
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

    /* ── Modal overlay ── */
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
    .modal-close:hover { background: rgba(255,69,96,.12); color: var(--red2); border-color: rgba(255,69,96,.25); }
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
    .modal-section-content.pump { color: var(--orange); border-color: rgba(255,159,67,.15); background: rgba(255,159,67,.05); }
    .modal-stats-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 7px; }
    .modal-stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; }
    .modal-stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: .7px; color: var(--dim); font-weight: 600; }
    .modal-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }

    /* ── Sentiment ── */
    .sentiment-pos { color: var(--green2); font-weight: 600; }
    .sentiment-neg { color: var(--red2);   font-weight: 600; }
    .sentiment-neu { color: var(--muted); }

    /* ── Dashboard 3-column grid — app-shell, only feed scrolls ── */
    .dashboard-grid {
      display: grid;
      grid-template-columns: 240px 1fr 300px;
      height: calc(100vh - 50px - 28px); /* viewport - nav - statusbar */
      overflow: hidden;
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
    /* Top progress bar shown while refreshing — kept subtle (stale-while-revalidate) */
    .feed-panel.is-refreshing::before {
      content: '';
      position: absolute; top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg,
        transparent 0%,
        rgba(98,114,255,.6) 50%,
        transparent 100%);
      background-size: 40% 100%;
      background-repeat: no-repeat;
      animation: feedProgress 1.1s ease-in-out infinite;
      z-index: 2; pointer-events: none;
    }
    @keyframes feedProgress {
      0%   { background-position: -40% 0; }
      100% { background-position: 140% 0; }
    }
    /* Gentle fade on the stale list while refreshing — disabled if user prefers reduced motion */
    .feed-list.is-refreshing { opacity: .85; transition: opacity .18s ease; }
    @media (prefers-reduced-motion: reduce) {
      .feed-panel.is-refreshing::before { animation: none; opacity: .5; }
      .feed-list.is-refreshing { opacity: 1; }
    }
    .feed-panel-head {
      padding: 14px 16px 12px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(98,114,255,.03), transparent);
    }
    .feed-panel-top {
      display: flex; align-items: center; gap: 12px; margin-bottom: 11px;
    }
    .feed-panel-icon {
      width: 32px; height: 32px; border-radius: 9px;
      background: var(--accent-glow);
      border: 1px solid rgba(98,114,255,.28);
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
      border: 1px solid rgba(98,114,255,.22); border-radius: 5px;
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
      outline: none; border-color: rgba(98,114,255,.3);
      background: var(--accent-glow);
      box-shadow: 0 0 0 1px rgba(98,114,255,.2);
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
      box-shadow: 0 0 0 1px rgba(98,114,255,.2);
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
      background: rgba(0,212,170,.12);
      color: var(--green2);
      box-shadow: 0 0 0 1px rgba(0,212,170,.25);
    }
    .fb-like.active .fb-ico { filter: saturate(1.1) brightness(1.05); }

    .fb-dislike.active {
      background: rgba(255,69,96,.1);
      color: var(--red2);
      box-shadow: 0 0 0 1px rgba(255,69,96,.22);
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
      background: linear-gradient(90deg, rgba(255,159,67,.06), transparent);
      border-left: 2px solid var(--orange);
      padding: 6px 10px; border-radius: 4px;
      color: var(--orange); font-weight: 500;
    }

    .feed-image-wrap {
      border-radius: 8px; overflow: hidden;
      margin: 8px 0 10px; max-height: 260px;
      background: var(--card3); border: 1px solid var(--border);
      display: flex; align-items: center; justify-content: center;
    }
    .feed-image {
      width: 100%; height: auto; max-height: 260px; object-fit: cover; display: block;
    }
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
      background: linear-gradient(135deg, rgba(98,114,255,.15), rgba(98,114,255,.05));
      border-color: rgba(98,114,255,.3); color: var(--accent2);
    }
    .feed-action-btn.primary:hover {
      background: linear-gradient(135deg, rgba(98,114,255,.25), rgba(98,114,255,.1));
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
      border-radius: 5px; border: 1px solid rgba(98,114,255,.22);
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
    .pulse-count.hot { color: var(--accent2); background: var(--accent-glow); border-color: rgba(98,114,255,.22); }

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
      .dashboard-grid { grid-template-columns: 210px 1fr; }
      .dashboard-grid > .right-panel { display: none; }
    }
    @media (max-width: 960px) {
      .dashboard-grid { grid-template-columns: 1fr; padding: 10px; }
      .dashboard-grid > .sidebar { display: none; }
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
      background: linear-gradient(90deg, transparent 0%, rgba(98,114,255,.2) 15%, rgba(98,114,255,.2) 85%, transparent 100%);
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

const LIFESPAN_LABELS = {
  'flash (hours)':     '⚡ Часы',
  'short (1-2 days)':  '📅 1-2 дня',
  'medium (3-7 days)': '🗓 3-7 дней',
  'long (weeks+)':     '📆 Недели+',
  'unknown':           '—',
};

// Source link labels
const SOURCE_LINK_LABELS = { reddit: '🟠 Reddit', twitter: '𝕏 Twitter', tiktok: '🎵 TikTok', google_trends: '🔍 Google' };

// ── Phase constants ──────────────────────────────────────────────────────────
const PHASE_META = {
  early:     { label: 'EARLY',     color: '#3B82F6', bg: 'rgba(59,130,246,0.12)', hint: 'Первые сигналы — риск и потенциал' },
  forming:   { label: 'FORMING',   color: '#EAB308', bg: 'rgba(234,179,8,0.12)',  hint: 'Нарратив развивается — золотое окно' },
  strong:    { label: 'STRONG',    color: '#22C55E', bg: 'rgba(34,197,94,0.12)',  hint: 'Сильный сигнал — действуй быстро' },
  saturated: { label: 'SATURATED', color: '#EF4444', bg: 'rgba(239,68,68,0.12)', hint: 'Нарратив переварен — поздно' },
};
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
  return v.toFixed(1) + '/ч ↑';
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
  if (diff < 1)    return 'только что';
  if (diff < 60)   return diff + 'м назад';
  if (diff < 1440) {
    const h = Math.floor(diff / 60);
    const m = diff % 60;
    return m > 0 ? (h + '\u0447 ' + m + '\u043C \u043D\u0430\u0437\u0430\u0434') : (h + '\u0447 \u043D\u0430\u0437\u0430\u0434');
  }
  if (diff < 10080) return Math.floor(diff / 1440) + '\u0434 \u043D\u0430\u0437\u0430\u0434'; // up to 7 days
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
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
  if (!phase) return null;
  const m = PHASE_META[phase] || PHASE_META.early;
  return h('span', {
    className: 'phase-badge',
    style: { background: m.bg, color: m.color, border: '1px solid ' + m.color },
    title: m.hint
  }, PHASE_DOT[phase] + ' ' + m.label);
}

// [MARKET_STAGE] badge — remove component + call in TrendCard to disable UI
const MARKET_STAGE_UI = {
  tokenizing: { icon: '🔄', label: 'TOKENIZING', color: '#F59E0B', bg: 'rgba(245,158,11,0.12)', hint: 'Launch discussions / pump.fun mentioned' },
  live:       { icon: '🟢', label: 'LIVE',       color: '#10B981', bg: 'rgba(16,185,129,0.12)', hint: 'Contract address or DEX links found' },
  overheated: { icon: '🔴', label: 'OVERHEATED', color: '#EF4444', bg: 'rgba(239,68,68,0.12)',  hint: 'Trading active — late/rug signals present' },
};
function MarketStageBadge({ stage }) {
  if (!stage || stage === 'none') return null;
  const m = MARKET_STAGE_UI[stage];
  if (!m) return null;
  return h('span', {
    className: 'phase-badge',
    style: { background: m.bg, color: m.color, border: '1px solid ' + m.color },
    title: m.hint
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

// ── FeedImage — inline image for feed cards (lazy-fetch with placeholder) ────
function FeedImage({ trend }) {
  const [imgUrl, setImgUrl] = useState(trend.imageUrl || null);
  const [tried,  setTried]  = useState(!!trend.imageUrl);
  const [failed, setFailed] = useState(false);
  const srcIco = SOURCE_ICONS[trend.source] || '📡';

  useEffect(() => {
    if (!tried && !imgUrl && trend.url) {
      setTried(true);
      fetch('/api/preview?url=' + encodeURIComponent(trend.url))
        .then(r => r.json())
        .then(d => { if (d.imageUrl) setImgUrl(d.imageUrl); else setFailed(true); })
        .catch(() => setFailed(true));
    }
  }, [trend.url]);

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
      title: userVote === 1 ? 'Убрать лайк' : 'Лайк'
    },
      h('span', { className: 'fb-ico' }, '👍'),
      h('span', { className: 'fb-count' }, likes)
    ),
    h('button', {
      className: 'fb-btn fb-dislike' + (userVote === -1 ? ' active' : ''),
      onClick: e => { e.stopPropagation(); vote(-1); },
      disabled: busy,
      title: userVote === -1 ? 'Убрать дизлайк' : 'Дизлайк'
    },
      h('span', { className: 'fb-ico' }, '👎'),
      h('span', { className: 'fb-count' }, dislikes)
    )
  );
}

function FeedCard({ trend, onOpen, onCopy }) {
  const catCls = CAT_CLS[trend.category] || 'cat-other';
  const catIco = CAT_ICONS[trend.category] || '📌';
  const srcIco = SOURCE_ICONS[trend.source] || '📡';
  const srcLbl = SOURCE_LABELS[trend.source] || trend.source;
  const linkLabel = SOURCE_LINK_LABELS[trend.source] || 'Open';

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
            h('span', { className: 'badge ' + catCls, title: 'Категория' }, catIco + ' ' + (trend.category || 'other'))
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
          h('span', { className: 'feed-score-label' }, '🌊 Emergence'),
          h('span', { className: 'feed-score-num', style: { color: emergenceColor } }, emergence)
        ),
        h('div', { className: 'feed-score-track' },
          h('div', { className: 'feed-score-fill', style: { width: Math.min(emergence, 100) + '%', background: emergenceColor } })
        )
      ),
      h('div', { className: 'feed-score' },
        h('div', { className: 'feed-score-top' },
          h('span', { className: 'feed-score-label' }, '💊 Adoption'),
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
      }, '📖 Details'),
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
      h('button', {
        className: 'feed-action-btn',
        onClick: e => { e.stopPropagation(); onCopy && onCopy(trend.title); },
        title: 'Copy title'
      }, '📋'),
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
function RightPanel({ stats, sources, allSourceStats, hours, hiddenSources, onOpenTrend, onToggleSource }) {
  // Top narratives from server-side stats (real top by adoption for the full window)
  // stats.topTrends is populated by /api/stats — same data as /top in TG bot
  const topTrends = (stats && stats.topTrends ? stats.topTrends : []).slice(0, 5);

  const topCategories = (stats && stats.byCategory ? stats.byCategory : []).slice(0, 5);
  const maxCatCount = topCategories.length ? Math.max(...topCategories.map(c => c.count)) : 1;

  const totalSignals = stats ? stats.total || 0 : 0;
  const totalAlerts  = stats ? stats.alerts || 0 : 0;
  const avgScore     = stats ? stats.avgScore || 0 : 0;
  const hidden = hiddenSources || new Set();
  const activeSources = (sources || []).filter(s => !hidden.has(s.source)).length;

  return h('div', { className: 'right-panel-sticky' },
   h('div', { className: 'right-panel' },  // inner scroll container via right-panel-inner wrapper below
    h('div', { className: 'right-panel-inner' },

    // ── Top Narratives ──
    h('div', { className: 'right-section' },
      h('div', { className: 'right-section-head' },
        h('span', { className: 'right-section-title' }, '🏆 Top Narratives'),
        h('span', { className: 'right-section-count' }, hours + 'h · top ' + topTrends.length)
      ),
      h('div', { className: 'right-section-body' },
        topTrends.length
          ? topTrends.map((t, i) => {
              const adoptionVal = t.adoptionScore || t.memePotential || 0;
              return h('div', { key: t.id, className: 'top-item', onClick: () => onOpenTrend && onOpenTrend(t) },
                h('div', { className: 'top-item-rank' + (i < 3 ? ' top-' + (i + 1) : '') }, i + 1),
                h('div', { className: 'top-item-info' },
                  h('div', { className: 'top-item-title', title: t.title }, t.title),
                  h('div', { className: 'top-item-meta' },
                    h('span', null, SOURCE_ICONS[t.source] || '📡'),
                    t.narrativePhase ? h('span', null, PHASE_DOT[t.narrativePhase] + ' ' + (PHASE_META[t.narrativePhase] || {}).label) : null,
                    h('span', null, (t.score || t.virality || 0) + ' vrl')
                  )
                ),
                h('div', { className: 'top-item-score' }, adoptionVal)
              );
            })
          : h('div', { className: 'empty-feed', style: { padding: '22px 10px' } },
              h('div', { className: 'empty-feed-icon' }, '📭'),
              h('div', { className: 'empty-feed-text' }, 'No signals yet')
            )
      )
    ),

    h('div', { className: 'right-sep' }),

    // ── Source Pulse ──
    h('div', { className: 'right-section' },
      h('div', { className: 'right-section-head' },
        h('span', { className: 'right-section-title' }, '📡 Source Pulse'),
        h('span', { className: 'right-section-count' }, activeSources + '/' + (sources || []).length + ' live')
      ),
      h('div', { className: 'right-section-body' },
        (allSourceStats || []).map(row => {
          const visible = !hidden.has(row.source);
          const cnt = row.count || 0;
          return h('div', {
            key: row.source,
            'data-src': row.source,
            className: 'pulse-row' + (visible ? '' : ' off'),
            onClick: () => onToggleSource && onToggleSource(row.source),
            title: visible ? 'Скрыть из фида (визуально)' : 'Показать в фиде'
          },
            h('span', { className: 'pulse-icon' }, SOURCE_ICONS[row.source] || '📡'),
            h('span', { className: 'pulse-name' }, SOURCE_LABELS[row.source] || row.source),
            h('span', { className: 'pulse-count' + (cnt >= 50 ? ' hot' : '') }, cnt)
          );
        })
      )
    ),

    h('div', { className: 'right-sep' }),

    // ── Activity summary ──
    h('div', { className: 'right-section' },
      h('div', { className: 'right-section-head' },
        h('span', { className: 'right-section-title' }, '📊 Activity'),
        h('span', { className: 'right-section-count' }, hours + 'h')
      ),
      h('div', { className: 'right-section-body' },
        h('div', { className: 'activity-grid' },
          h('div', { className: 'activity-cell' },
            h('span', { className: 'activity-label' }, 'Signals'),
            h('span', { className: 'activity-val accent' }, totalSignals)
          ),
          h('div', { className: 'activity-cell' },
            h('span', { className: 'activity-label' }, 'Alerts'),
            h('span', { className: 'activity-val orange' }, totalAlerts)
          ),
          h('div', { className: 'activity-cell full' },
            h('span', { className: 'activity-label' }, 'Avg virality'),
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
  const sentLabel = trend.sentiment === 'positive' ? '😊 Позитив'
    : trend.sentiment === 'negative' ? '😠 Негатив' : '😐 Нейтраль';

  return h('div', { className: 'modal-overlay', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
    h('div', { className: 'modal-drawer' },

      // Head
      h('div', { className: 'modal-head' },
        h('span', { className: 'badge ' + catCls }, catIco + ' ' + (trend.category || 'other')),
        h('div', { className: 'source-chip' }, srcIco, ' ', srcLbl),
        h('span', { className: 'time-cell', style: { fontSize: 11 } }, fmtTime(trend.firstSeen)),
        h('button', { className: 'modal-close', onClick: onClose }, '✕ Esc')
      ),

      // Body
      h('div', { className: 'modal-body' },

        // Image
        imgLoading
          ? h('div', { className: 'modal-image-loading' })
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
          h('div', { className: 'modal-section-label' }, '⚡ Почему запампит'),
          h('div', { className: 'modal-section-content pump' }, trend.whyItWillPump)
        ) : null,

        // AI explanation
        trend.aiExplanation ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, '🤖 AI Объяснение'),
          h('div', { className: 'modal-section-content' }, trend.aiExplanation)
        ) : null,

        // [MARKET_STAGE] market stage line in modal — remove block to disable
        trend.marketStage && trend.marketStage !== 'none' ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, '💹 Market Stage'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(MarketStageBadge, { stage: trend.marketStage }),
            h('span', { style: { fontSize: 12, color: 'var(--dim)' } },
              (MARKET_STAGE_UI[trend.marketStage] || {}).hint || ''
            )
          )
        ) : null,

        // Phase + two bars
        trend.narrativePhase ? h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, '🧭 Фаза нарратива'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
            h(PhaseBadge, { phase: trend.narrativePhase }),
            h('span', { style: { fontSize: 12, color: 'var(--dim)' } },
              (PHASE_META[trend.narrativePhase] || PHASE_META.early).hint
            )
          ),
          h(ScoreBar, { label: '🌊 Emergence', value: trend.emergenceScore || 0 }),
          h('div', { style: { height: 4 } }),
          h(ScoreBar, { label: '💊 Adoption',  value: trend.adoptionScore || trend.memePotential || 0 })
        ) : null,

        // Stats grid
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, '📊 Метрики'),
          h('div', { className: 'modal-stats-grid' },
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, 'Meme Score'),
              h(MemeScore, { value: trend.memePotential || 0 })
            ),
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, 'Срок жизни'),
              h('span', { className: 'lifespan' }, LIFESPAN_LABELS[trend.predictedLifespan] || '—')
            ),
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, 'Виральность'),
              h('span', { style: { fontFamily: 'JetBrains Mono', fontWeight: 700, color: 'var(--accent2)' } }, trend.score || 0)
            ),
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, 'Сентимент'),
              h('span', { className: sentCls }, sentLabel)
            ),
            h('div', { className: 'modal-stat' },
              h('div', { className: 'modal-stat-label' }, 'Видели'),
              h('span', { style: { fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 700 } }, trend.timesSeen || 1, 'x')
            )
          )
        ),

        // Feedback
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, '💬 Ваша оценка'),
          h(FeedbackBar, { trend, variant: 'modal' })
        ),

        // Actions
        h('div', { className: 'modal-section' },
          h('div', { className: 'modal-section-label' }, '🔗 Ссылки'),
          h('div', { className: 'modal-actions' },
            trend.url ? h('a', { className: 'trend-link' + srcLinkCls, href: trend.url, target: '_blank', rel: 'noopener' }, srcIco + ' Источник →') : null,
            trend.tgMessageUrl ? h('a', { className: 'trend-link trend-link-tg', href: trend.tgMessageUrl, target: '_blank', rel: 'noopener' }, '📨 Telegram') : null
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
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const refreshIn = Math.max(0, Math.ceil((refreshAt - now) / 1000));
  return h(React.Fragment, null,
    h('span', { className: 'refresh-badge' }, '\u21bb ' + refreshIn + 's'),
    h('span', { className: 'nav-time' }, new Date(now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))
  );
}

// ── StatusBar — bottom strip ─────────────────────────────────────────────────
function StatusBar({ stats, scanning, sources }) {
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
      paused ? 'OFFLINE' : 'LIVE'
    ),
    h('div', { className: 'statusbar-sep' }),
    h('span', { className: 'statusbar-item' },
      h('span', { className: 'sb-key' }, 'signals'),
      h('b', null, String(stats ? stats.total || 0 : 0))
    ),
    h('span', { className: 'statusbar-item' },
      h('span', { className: 'sb-key' }, 'alerts'),
      h('b', null, String(stats ? stats.alerts || 0 : 0))
    ),
    h('span', { className: 'statusbar-item' },
      h('span', { className: 'sb-key' }, 'sources'),
      h('b', { style: { color: srcOk ? 'var(--green2)' : 'var(--orange)' } }, active + '/' + total)
    ),
    scanning
      ? h('span', { className: 'statusbar-item', style: { color: 'var(--accent2)' } },
          h('span', { className: 'sb-key', style: { color: 'var(--accent2)' } }, '⏳ updating')
        )
      : null,
    h('span', { className: 'statusbar-hint' },
      h('span', { className: 'statusbar-kbd' }, h('b', null, 'R'), 'refresh'),
      h('span', { className: 'statusbar-kbd' }, h('b', null, 'Esc'), 'close')
    )
  );
}

// ── ControlPanel ──────────────────────────────────────────────────────────────
function ControlPanel({ scanning, onScan, sources, onCollectorToggle, addToast }) {
  const CONTROL_BUTTONS = [
    { id: 'scan',   icon: '⚡', label: 'Сканировать', action: 'scan',   disabled: scanning },
    { id: 'health', icon: '🏥', label: 'Здоровье',    action: 'health', disabled: false },
    { id: 'reload', icon: '↻',  label: 'Перезагрузить', action: 'reload', disabled: false },
    { id: 'stats',  icon: '📊', label: 'Статистика',  action: 'stats',  disabled: false },
  ];

  const handleAction = async (action) => {
    if (action === 'scan') {
      onScan();
    } else if (action === 'health') {
      try {
        const res = await fetch('/api/health').then(r => r.json());
        addToast && addToast('✅ Сервер живёт · uptime ' + Math.floor(res.uptime / 60) + 'м', 'success');
      } catch (e) {
        addToast && addToast('❌ Ошибка: ' + e.message, 'error');
      }
    } else if (action === 'reload') {
      location.reload();
    } else if (action === 'stats') {
      window.dispatchEvent(new CustomEvent('dashboard:navigate', { detail: { view: 'stats' } }));
    }
  };

  return h('div', { className: 'control-panel' },
    h('div', { className: 'control-panel-title' },
      '⚙️ Управление'
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
                title: src.enabled ? 'Отключить источник' : 'Включить источник',
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
  return h('div', { className: 'session-bar' },
    h('span', { className: 'session-tag' }, stats && stats.paused ? 'PAUSED' : 'LIVE'),
    h('div', { className: 'session-title' }, 'Catalyst — Narrative Terminal'),
    h('div', { className: 'session-chips' },
      h('div', { className: 'session-chip' },
        'Window ', h('span', { className: 'chip-val' }, hours + 'h')
      ),
      h('div', { className: 'session-chip' },
        'Signals ', h('span', { className: 'chip-val' }, String(stats ? stats.total || 0 : 0))
      ),
      h('div', { className: 'session-chip' },
        'Alerts ', h('span', { className: 'chip-val' }, String(stats ? stats.alerts || 0 : 0))
      ),
      h('div', { className: 'session-chip', style: { cursor: 'pointer' }, onClick: onOpenStats },
        '\ud83d\udcca Stats'
      ),
      h('button', {
        className: 'btn btn-primary',
        onClick: onScan,
        disabled: scanning,
        style: { fontSize: 11, padding: '4px 11px' }
      }, scanning ? '\u23f3 Scanning...' : '\u26a1 Scan now')
    )
  );
}

function StatsPanel({ stats, hours, onBack, onOpenTrend }) {
  const sourceOrder = ['reddit', 'google_trends', 'twitter', 'tiktok'];
  const allSources = sourceOrder.map(name => {
    const hit = (stats?.bySource || []).find(s => s.source === name);
    return { source: name, count: hit ? hit.count : 0 };
  });
  const topCategories = (stats?.byCategory || []).slice(0, 6);
  const topTrends = (stats?.topTrends || []).slice(0, 4);

  return h('div', { className: 'stats-view' },
    h('div', { className: 'settings-header' },
      h('button', { className: 'btn btn-ghost', onClick: onBack }, '← Back'),
      h('span', { className: 'settings-title' }, '📊 Stats overview')
    ),
    h('div', { className: 'stats-grid' },
      h('section', { className: 'section-shell stats-block' },
        h('div', { className: 'stats-block-head' },
          h('div', { className: 'stats-block-title' }, 'Sources'),
          h('div', { className: 'stats-block-sub' }, hours + 'h window')
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
          h('div', { className: 'stats-block-title' }, 'Categories'),
          h('div', { className: 'stats-block-sub' }, 'Top focus areas')
        ),
        h('div', { className: 'stats-list' },
          topCategories.length
            ? topCategories.map(row =>
                h('div', { key: row.category || 'other', className: 'stats-list-row' },
                  h('div', { className: 'stats-list-main' },
                    h('span', null, CAT_ICONS[row.category] || '📌'),
                    h('div', null,
                      h('div', { className: 'stats-list-name' }, row.category || 'other'),
                      h('div', { className: 'stats-list-meta' }, 'Narrative cluster count')
                    )
                  ),
                  h('span', { className: 'stats-list-value' }, String(row.count))
                )
              )
            : h('div', { className: 'stats-list-row' },
                h('span', { className: 'stats-list-meta' }, 'No category data yet')
              )
        )
      ),
      h('section', { className: 'section-shell stats-block' },
        h('div', { className: 'stats-block-head' },
          h('div', { className: 'stats-block-title' }, 'Top narratives'),
          h('div', { className: 'stats-block-sub' }, 'Highest adoption now')
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
                h('span', { className: 'stats-list-meta' }, 'No trend data yet')
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
  refreshSec:    90,   // 0 = off
  fontSize:      14,   // 12..16
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
}
// apply on first script eval (before React mounts)
try { applyPrefsToDOM(loadPrefs()); } catch (e) {}

function SettingsPanel({ onBack, onResetHiddenSources, hiddenSourcesCount, user, onLogout }) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [flash, setFlash] = useState('');

  const update = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const flashMsg = (m) => { setFlash(m); setTimeout(() => setFlash(''), 2000); };

  const planLabels = { free: 'Free', test: 'Test', pro: 'Pro', admin: 'Admin' };
  const doLogout = async () => {
    if (!confirm('Выйти из аккаунта? Нужно будет снова подтвердить код в Telegram.')) return;
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* token already invalid */ }
    if (onLogout) onLogout();
  };

  const resetAllPrefs = () => {
    if (!confirm('Сбросить все настройки дашборда к значениям по умолчанию?')) return;
    const next = { ...DEFAULT_PREFS };
    setPrefs(next);
    savePrefs(next);
    flashMsg('✓ Настройки сброшены');
  };

  const Toggle = ({ on, onChange }) =>
    h('button', {
      className: 'pref-toggle' + (on ? ' on' : ''),
      onClick: () => onChange(!on),
      role: 'switch',
      'aria-checked': on
    }, h('span', { className: 'pref-toggle-knob' }));

  const Row = ({ icon, title, desc, control }) =>
    h('div', { className: 'setting-row' },
      h('div', { className: 'setting-label' },
        h('span', { className: 'setting-name' }, icon ? (icon + ' ') : '', title),
        desc ? h('span', { className: 'setting-hint' }, desc) : null
      ),
      h('div', { className: 'setting-control' }, control)
    );

  return h('div', { className: 'settings-panel' },
    h('div', { className: 'settings-header' },
      h('button', { className: 'btn btn-ghost', onClick: onBack }, '← Назад'),
      h('span', { className: 'settings-title' }, '⚙️ Настройки дашборда'),
      flash ? h('span', { className: 'settings-flash' }, flash) : null
    ),

    // ── Внешний вид ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, '🎨 Внешний вид'),
      h('div', { className: 'settings-card-desc' },
        'Только визуальные предпочтения — применяются мгновенно и хранятся в этом браузере.'
      ),
      h(Row, {
        icon: '📐', title: 'Плотность фида',
        desc: 'Compact уменьшает отступы и размер карточек для плотного просмотра.',
        control: h('div', { className: 'seg-group seg-compact' },
          [{ v: 'comfortable', l: 'Comfy' }, { v: 'compact', l: 'Compact' }].map(o =>
            h('button', {
              key: o.v,
              className: 'seg-btn' + (prefs.density === o.v ? ' active' : ''),
              onClick: () => update({ density: o.v })
            }, o.l)
          )
        )
      }),
      h(Row, {
        icon: '🖼️', title: 'Показывать превью',
        desc: 'Отключи чтобы экономить трафик и разгрузить фид.',
        control: h(Toggle, { on: prefs.showImages, onChange: v => update({ showImages: v }) })
      }),
      h(Row, {
        icon: '✨', title: 'Анимации интерфейса',
        desc: 'Отключи для снижения нагрузки на слабых устройствах.',
        control: h(Toggle, { on: prefs.animations, onChange: v => update({ animations: v }) })
      }),
      h(Row, {
        icon: '🔠', title: 'Размер шрифта',
        desc: 'Базовый размер текста на дашборде.',
        control: h('div', { className: 'seg-group seg-compact' },
          [{ v: 12, l: 'S' }, { v: 14, l: 'M' }, { v: 16, l: 'L' }].map(o =>
            h('button', {
              key: o.v,
              className: 'seg-btn' + (prefs.fontSize === o.v ? ' active' : ''),
              onClick: () => update({ fontSize: o.v })
            }, o.l)
          )
        )
      })
    ),

    // ── Поведение ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, '🔄 Поведение'),
      h('div', { className: 'settings-card-desc' },
        'Автообновление и видимость источников в фиде.'
      ),
      h(Row, {
        icon: '⏱', title: 'Автообновление',
        desc: prefs.refreshSec === 0
          ? 'Выключено — обновляй вручную клавишей R.'
          : 'Каждые ' + prefs.refreshSec + ' секунд.',
        control: h('div', { className: 'seg-group seg-compact' },
          [{ v: 0, l: 'Off' }, { v: 30, l: '30s' }, { v: 60, l: '1m' }, { v: 90, l: '90s' }, { v: 300, l: '5m' }].map(o =>
            h('button', {
              key: o.v,
              className: 'seg-btn' + (prefs.refreshSec === o.v ? ' active' : ''),
              onClick: () => update({ refreshSec: o.v })
            }, o.l)
          )
        )
      }),
      h(Row, {
        icon: '👁', title: 'Скрытые источники',
        desc: hiddenSourcesCount
          ? 'Сейчас скрыто: ' + hiddenSourcesCount + '. Это только визуальная фильтрация в твоём браузере.'
          : 'Ничего не скрыто — можешь скрывать источники кликом в сайдбаре.',
        control: h('button', {
          className: 'btn btn-ghost',
          disabled: !hiddenSourcesCount,
          onClick: () => {
            if (onResetHiddenSources) { onResetHiddenSources(); flashMsg('✓ Все источники показаны'); }
          }
        }, 'Показать все')
      })
    ),

    // ── Аккаунт ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, '👤 Аккаунт'),
      h('div', { className: 'settings-card-desc' },
        'Вход выполняется через Telegram-бота. Твой план и настройки привязаны к этому аккаунту.'
      ),
      h(Row, {
        icon: '💬', title: 'Telegram',
        desc: user?.username ? ('@' + user.username) : ('chat id: ' + (user?.chatId || '—')),
        control: h('span', { className: 'pref-value' }, user?.chatId || '—')
      }),
      h(Row, {
        icon: '💎', title: 'Тариф',
        desc: 'Влияет на вес твоих лайков/дизлайков и доступ к премиум-функциям.',
        control: h('span', { className: 'pref-value' }, planLabels[user?.plan] || user?.plan || '—')
      }),
      h(Row, {
        icon: '🚪', title: 'Выйти',
        desc: 'Отвязать этот браузер. Для повторного входа потребуется новый код из бота.',
        control: h('button', { className: 'btn btn-ghost', onClick: doLogout }, 'Выйти')
      })
    ),

    // ── Reset ──
    h('div', { className: 'settings-actions' },
      h('button', { className: 'btn btn-ghost', onClick: resetAllPrefs }, '↺ Сбросить все настройки')
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
      if (!data.botUrl) throw new Error('Бот временно недоступен. Попробуйте позже.');
      setSession(data);
      setPhase('code');
      try { window.open(data.botUrl, '_blank', 'noopener'); } catch (e) {}
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const submitCode = async () => {
    const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
    if (clean.length !== 6) { setError('Введите 6 цифр из сообщения бота'); return; }
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
      h('div', { style: { textAlign: 'center', marginBottom: '20px' } },
        h('div', { style: { fontSize: '44px', lineHeight: '1' } }, '🔥'),
        h('div', { style: { fontSize: '22px', fontWeight: '700', marginTop: '8px' } }, 'Catalyst'),
        h('div', { style: { fontSize: '13px', opacity: '0.65', marginTop: '4px' } }, 'Вход через Telegram')
      ),

      phase === 'idle' && h('div', null,
        h('p', { style: { fontSize: '14px', lineHeight: '1.5', opacity: '0.85', marginBottom: '16px' } },
          'Мы не храним пароли. Авторизация — через нашего Telegram-бота: ты получишь одноразовый код и введёшь его здесь.'
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
        }, loading ? 'Подождите…' : '💬 Войти через Telegram')
      ),

      phase === 'code' && h('div', null,
        h('p', { style: { fontSize: '14px', lineHeight: '1.5', opacity: '0.85', marginBottom: '12px' } },
          'Открой чат с ботом и нажми Start — он пришлёт шестизначный код. Введи его ниже:'
        ),
        session?.botUrl && h('a', {
          href: session.botUrl, target: '_blank', rel: 'noopener',
          style: {
            display: 'block', textAlign: 'center', padding: '10px 14px',
            background: 'rgba(34,158,217,0.15)', color: '#5bb8e0',
            border: '1px solid rgba(34,158,217,0.35)', borderRadius: '8px',
            textDecoration: 'none', fontSize: '13px', marginBottom: '16px'
          }
        }, '↗ Открыть бота снова'),
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
        }, loading ? 'Проверяем…' : 'Войти'),
        h('button', {
          style: {
            width: '100%', marginTop: '10px', padding: '8px', fontSize: '12px',
            background: 'transparent', color: 'var(--muted, #888)', border: 'none',
            cursor: 'pointer'
          },
          onClick: () => { setPhase('idle'); setSession(null); setCode(''); setError(''); }
        }, '← Отменить')
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

function App() {
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
  const [hiddenSources, setHiddenSources] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ts_hidden_sources') || '[]')); }
    catch (e) { return new Set(); }
  });
  const toastId = useRef(0);
  const LIMIT = 25;

  // addToast helper — auto-dismiss after 4s
  const addToast = useCallback((msg, type = 'info') => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const fetchData = useCallback(async () => {
    setRefreshAt(Date.now() + 90000);
    setLoading(true); setError('');
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
      setTrends(tr.trends || []);
      setTotal(tr.total  || 0);
      setSources(sr.sources || []);
    } catch (ex) { setError('Ошибка: ' + ex.message); }
    setLoading(false);
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
  useEffect(() => { if (me && me !== true) fetchData(); }, [fetchData, me]);
  // Auto-refresh interval driven by user preference (0 = off)
  const [refreshSec, setRefreshSec] = useState(() => {
    try { return (loadPrefs().refreshSec | 0); } catch (e) { return 90; }
  });
  useEffect(() => {
    const onPrefs = (ev) => { if (ev && ev.detail) setRefreshSec(ev.detail.refreshSec | 0); };
    window.addEventListener('ts:prefs', onPrefs);
    return () => window.removeEventListener('ts:prefs', onPrefs);
  }, []);
  useEffect(() => {
    if (!refreshSec) return;
    const t = setInterval(fetchData, refreshSec * 1000);
    return () => clearInterval(t);
  }, [fetchData, refreshSec]);

  // ── Live stream (Server-Sent Events) — push-based real-time refresh ─────────
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    let es = null;
    let refreshTimer = null;
    let stopped = false;

    const scheduleRefresh = (delay = 600) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { refreshTimer = null; fetchData(); }, delay);
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
  }, [fetchData]);
  useEffect(() => {
    const handleNavigate = (event) => {
      const nextView = event && event.detail ? event.detail.view : null;
      if (nextView) setView(nextView);
    };
    window.addEventListener('dashboard:navigate', handleNavigate);
    return () => window.removeEventListener('dashboard:navigate', handleNavigate);
  }, []);

  // Keyboard shortcuts: R=refresh, Esc=close modal
  useEffect(() => {
    const fn = e => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'Escape') { setModalTrend(null); return; }
      if (e.key === 'r' || e.key === 'R') { fetchData(); addToast('Обновляю...', 'info'); return; }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [fetchData, addToast]);

  // Visual-only source filter. Does NOT touch the collectors —
  // real enable/disable lives in the admin panel. This only hides
  // trends from the selected source in the dashboard feed.
  const toggle = (name) => {
    setHiddenSources(prev => {
      const next = new Set(prev);
      const willHide = !next.has(name);
      if (willHide) next.add(name); else next.delete(name);
      try { localStorage.setItem('ts_hidden_sources', JSON.stringify([...next])); } catch (e) {}
      addToast((willHide ? '🙈 Скрыт в фиде: ' : '👁 Показан: ') + (SOURCE_LABELS[name] || name), 'info');
      return next;
    });
  };

  const showAllSources = () => {
    if (!hiddenSources.size) return;
    setHiddenSources(new Set());
    try { localStorage.setItem('ts_hidden_sources', '[]'); } catch (e) {}
    addToast('👁 Все источники видимы', 'info');
  };
  const resetFilters = () => {
    setHours(24); setMinMeme(0); setCategory(''); setSource(''); setSort('rank'); setOffset(0);
    addToast('♻️ Фильтры сброшены', 'info');
  };

  const copyToClipboard = useCallback((text) => {
    navigator.clipboard.writeText(text).then(
      () => addToast('📋 Скопировано!', 'success'),
      () => addToast('Не удалось скопировать', 'error')
    );
  }, [addToast]);

  const pages = Math.ceil(total / LIMIT);
  const page  = Math.floor(offset / LIMIT);
  const fixedSourceOrder = ['reddit', 'google_trends', 'twitter', 'tiktok'];
  const allSourceStats = fixedSourceOrder.map(name => {
    const hit = (stats?.bySource || []).find(s => s.source === name);
    return { source: name, count: hit ? hit.count : 0 };
  });

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
  }, 'Загрузка…');

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
        h('span', { className: 'nav-logo-icon' }, '🔥'),
        h('span', { className: 'nav-logo-text' }, 'Catalyst')
      ),
      h('span', { className: 'nav-version' }, 'v3'),
      h('div', { className: 'nav-sep' }),
      h('span', { className: 'nav-subtitle' }, 'Narrative Terminal'),
      h('div', { className: 'nav-right' },
        h('div', { className: 'status-pill ' + (stats && stats.paused ? 'paused' : 'live') },
          h('div', { className: 'status-dot' + (stats && stats.paused ? ' paused' : '') }),
          stats && stats.paused ? 'Offline' : 'Live'
        ),
        h(NavClock, { refreshAt })
      )
    ),

    // ── Layout: trends view gets 3-col dashboard-grid, others get classic layout ──
    view === 'trends'
      ? h('div', { className: 'dashboard-grid' },

          // ── Sidebar ──
          h('aside', { className: 'sidebar' },
            h('div', { className: 'sidebar-section' },
              h('span', null, 'Sources'),
              hiddenSources.size
                ? h('span', { className: 'sidebar-section-link', onClick: showAllSources, title: 'Показать все' }, 'Show all')
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
                title: visible ? 'Скрыть из фида (визуально)' : 'Показать в фиде'
              },
                h('span', { className: 'source-icon' }, SOURCE_ICONS[s.source] || '📡'),
                h('span', { className: 'source-name' }, SOURCE_LABELS[s.source] || s.source),
                h('span', { className: 'source-count' + (cnt >= 50 ? ' hot' : '') }, cnt),
                h('span', { className: 'source-eye' }, visible ? '👁' : '🙈')
              );
            }),

            h('div', { className: 'sidebar-divider' }),

            h('div', { className: 'sidebar-section' },
              h('span', null, 'Filters'),
              (hours !== 24 || minMeme !== 0 || category || sort !== 'rank')
                ? h('span', { className: 'sidebar-section-link', onClick: resetFilters, title: 'Сбросить' }, 'Reset')
                : null
            ),
            h('div', { className: 'sidebar-filters' },

              // Time window (segmented)
              h('div', { className: 'filter-group' },
                h('div', { className: 'filter-label' },
                  h('span', null, '⏱ Window'),
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
                  h('span', null, '💎 Adoption'),
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
                h('div', { className: 'filter-label' }, h('span', null, '📂 Category')),
                h('select', {
                  value: category,
                  onChange: ev => { setCategory(ev.target.value); setOffset(0); },
                  style: { width: '100%' }
                },
                  h('option', { value: '' }, 'All categories'),
                  Object.keys(CAT_ICONS).map(c => h('option', { key: c, value: c }, CAT_ICONS[c] + ' ' + c))
                )
              ),

              // Sort order (segmented icons)
              h('div', { className: 'filter-group' },
                h('div', { className: 'filter-label' }, h('span', null, '🔀 Sort')),
                h('div', { className: 'seg-group seg-compact' },
                  [
                    { v: 'rank',      l: '⚡', t: 'Rank' },
                    { v: 'meme',      l: '💎', t: 'Top adoption' },
                    { v: 'emergence', l: '🌊', t: 'Top emergence' },
                    { v: 'time',      l: '🕐', t: 'Newest' },
                    { v: 'virality',  l: '📊', t: 'Virality' },
                  ].map(o =>
                    h('button', {
                      key: o.v,
                      title: o.t,
                      className: 'seg-btn' + (sort === o.v ? ' active' : ''),
                      onClick: () => { setSort(o.v); setOffset(0); }
                    }, o.l)
                  )
                )
              )
            ),

            h('div', { style: { flex: 1 } }),

            // Footer with Stats + Settings
            h('div', { className: 'sidebar-footer' },
              h('div', {
                className: 'sb-foot-btn' + (view === 'stats' ? ' active' : ''),
                onClick: () => setView('stats'),
                title: 'Stats'
              },
                h('span', { className: 'sb-foot-ico' }, '📊'),
                h('span', null, 'Stats')
              ),
              h('div', {
                className: 'sb-foot-btn' + (view === 'settings' ? ' active' : ''),
                onClick: () => setView('settings'),
                title: 'Settings'
              },
                h('span', { className: 'sb-foot-ico' }, '⚙️'),
                h('span', null, 'Settings')
              )
            )
          ),

          // ── Main feed ──
          h('main', { className: 'main-feed' },
            error ? h('div', { className: 'error-bar', style: { marginBottom: 12 } }, '⚠️ ', error) : null,

            h('div', { className: 'feed-panel' + (loading && trends.length > 0 ? ' is-refreshing' : '') },

              // ── Feed panel header ──
              h('div', { className: 'feed-panel-head' },
                h('div', { className: 'feed-panel-top' },
                  h('div', { className: 'feed-panel-icon' }, '🔥'),
                  h('div', null,
                    h('div', { className: 'feed-panel-title' },
                      'Narrative Feed',
                      h('span', { className: 'feed-panel-count' },
                        search.trim()
                          ? visibleTrends.length + ' / ' + total
                          : total + ' signals'
                      )
                    ),
                    h('div', { className: 'feed-panel-sub' },
                      'Live narrative tracker across ', (sources || []).filter(s => s.enabled).length, '/', (sources || []).length, ' sources · ', hours, 'h window'
                    )
                  ),
                  h('div', { className: 'feed-panel-actions' },
                    h('div', { className: 'feed-search' },
                      h('span', { className: 'feed-search-icon' }, '🔍'),
                      h('input', {
                        type: 'text',
                        placeholder: 'Search narratives...',
                        value: search,
                        onChange: e => setSearch(e.target.value),
                      })
                    ),
                    h('button', {
                      className: 'btn btn-ghost' + (loading ? ' is-spinning' : ''),
                      onClick: () => { if (!loading) { fetchData(); addToast('Refreshing...', 'info'); } },
                      disabled: loading,
                      style: { fontSize: 11, padding: '6px 10px' },
                      title: 'Refresh (R)'
                    }, h('span', { className: 'btn-refresh-ico' }, '↻'))
                  )
                ),

                // ── Phase filter chips ──
                h('div', { className: 'feed-filters-bar' },
                  h('button', {
                    className: 'feed-chip' + (phase === '' ? ' active' : ''),
                    onClick: () => { setPhase(''); setOffset(0); }
                  }, 'All ', h('span', { className: 'chip-count' }, total)),
                  ['early','forming','strong','saturated'].map(p =>
                    h('button', {
                      key: p,
                      className: 'feed-chip' + (phase === p ? ' active' : ''),
                      onClick: () => { setPhase(phase === p ? '' : p); setOffset(0); }
                    },
                      PHASE_DOT[p], ' ', PHASE_META[p].label
                    )
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
                    h('div', { className: 'loading-text' }, 'Loading narratives...')
                  )
                : visibleTrends.length === 0
                  ? h('div', { className: 'empty-feed' },
                      h('div', { className: 'empty-feed-icon' }, '🔍'),
                      h('div', { className: 'empty-feed-text' },
                        search.trim()
                          ? 'No matches for "' + search + '"'
                          : 'No narratives found — try different filters'
                      ),
                      h('div', { className: 'empty-feed-sub' }, 'Hint: widen the time window or clear filters')
                    )
                  : h('div', { className: 'feed-list' + (loading ? ' is-refreshing' : '') },
                      visibleTrends.map(t => h(FeedCard, { key: t.id, trend: t, onOpen: setModalTrend, onCopy: copyToClipboard }))
                    ),

              // Pagination
              !search.trim() && pages > 1 ? h('div', { className: 'pagination', style: { padding: '10px 14px 14px' } },
                h('button', { className: 'btn btn-ghost', onClick: () => setOffset(Math.max(0, offset - LIMIT)), disabled: page === 0 }, '← Prev'),
                h('span', { className: 'page-info' }, (page + 1) + ' / ' + pages),
                h('button', { className: 'btn btn-ghost', onClick: () => setOffset(offset + LIMIT), disabled: page >= pages - 1 }, 'Next →')
              ) : null
            )
          ),

          // ── Right panel ──
          h(RightPanel, {
            stats,
            sources,
            allSourceStats,
            hours,
            hiddenSources,
            onOpenTrend: setModalTrend,
            onToggleSource: toggle,
          })
        )
      : h('div', { className: 'layout' },
          // Classic 2-col layout for settings / stats views
          h('aside', { className: 'sidebar' },
            h('div', { className: 'sidebar-section' },
              h('span', null, 'Sources'),
              hiddenSources.size
                ? h('span', { className: 'sidebar-section-link', onClick: showAllSources }, 'Show all')
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
                title: visible ? 'Скрыть из фида (визуально)' : 'Показать в фиде'
              },
                h('span', { className: 'source-icon' }, SOURCE_ICONS[s.source] || '📡'),
                h('span', { className: 'source-name' }, SOURCE_LABELS[s.source] || s.source),
                h('span', { className: 'source-count' + (cnt >= 50 ? ' hot' : '') }, cnt),
                h('span', { className: 'source-eye' }, visible ? '👁' : '🙈')
              );
            }),
            h('div', { className: 'sidebar-divider' }),
            h('div', { style: { flex: 1 } }),
            h('div', { className: 'sidebar-footer' },
              h('div', {
                className: 'sb-foot-btn active',
                onClick: () => setView('trends')
              },
                h('span', { className: 'sb-foot-ico' }, '🔥'),
                h('span', null, 'Feed')
              ),
              h('div', {
                className: 'sb-foot-btn' + (view === 'settings' ? ' active' : ''),
                onClick: () => setView('settings')
              },
                h('span', { className: 'sb-foot-ico' }, '⚙️'),
                h('span', null, 'Settings')
              )
            )
          ),
          h('main', { className: 'main' },
            view === 'settings'
              ? h(SettingsPanel, {
                  onBack: () => setView('trends'),
                  onResetHiddenSources: showAllSources,
                  hiddenSourcesCount: hiddenSources.size,
                  user: me,
                  onLogout: handleLogout
                })
              : h(StatsPanel, { stats, hours, onBack: () => setView('trends'), onOpenTrend: setModalTrend })
          )
        )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));
<\/script>
</body>
</html>`;
  }
}

export default DashboardServer;
