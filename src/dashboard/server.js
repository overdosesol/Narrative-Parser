/**
 * TrendScout Dashboard — Express REST API + embedded React SPA
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
  constructor(config, logger, db, appState, scanFn) {
    this.config   = config.dashboard;
    this.logger   = logger;
    this.db       = db;
    this.appState = appState;
    this.scanFn   = scanFn;   // callback to trigger manual scan
    this.server   = null;
    this.started  = Date.now();
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

    // Health — no auth
    if (path === '/api/health' && method === 'GET') {
      return json(res, 200, { ok: true, uptime: Math.floor((Date.now() - this.started) / 1000), paused: this.appState?.paused ?? false });
    }

    // Auth check for all other /api routes
    if (path.startsWith('/api/')) {
      const apiKey = this.config.apiKey;
      if (!apiKey) return json(res, 503, { error: 'Dashboard API key is not configured' });
      const provided = req.headers['x-api-key'] || '';
      if (!safeEqual(provided, apiKey)) return json(res, 401, { error: 'Unauthorized — provide X-API-Key header' });
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

      // SPA fallback — serve dashboard HTML for all non-API routes
      if (!path.startsWith('/api/')) return html(res, this._buildSPA());

      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      this.logger.error(`Dashboard handler error: ${err.message}`);
      return json(res, 500, { error: err.message });
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

    const trends = rows.map(row => this._formatTrend(row));

    return json(res, 200, { trends, total, limit, offset });
  }

  _handleTrend(req, res, path) {
    const id  = parseInt(path.split('/').pop(), 10);
    const row = this.db.db.prepare(`SELECT * FROM trends WHERE id = ?`).get(id);
    if (!row) return json(res, 404, { error: 'Trend not found' });
    return json(res, 200, this._formatTrend(row));
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

    const topTrends = this.db.db.prepare(
      `SELECT id, title, score, category, source, first_seen_at, raw_metrics FROM trends WHERE first_seen_at > ? ORDER BY CAST(JSON_EXTRACT(raw_metrics, '$.memePotential') AS INT) DESC LIMIT 5`
    ).all(cutoff).map(r => this._formatTrend(r));

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

  _formatTrend(row) {
    let metrics = {};
    try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch (e) {}
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
            headers: { 'User-Agent': 'TrendScout/3.0', 'Accept': 'application/json' },
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
              { signal: controller.signal, headers: { 'User-Agent': 'TrendScout/3.0', 'Accept': 'application/json' } }
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
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendScout/3.0)' },
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
  <title>TrendScout — Degen Intelligence</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"><\/script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"><\/script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');

    :root {
      --bg:        #06060a;
      --surface:   #0c0c12;
      --card:      #111118;
      --card2:     #16161e;
      --card3:     #1a1a24;
      --border:    #1e1e2a;
      --border2:   #2a2a3a;
      --border3:   #353548;
      --text:      #eeeef0;
      --text2:     #ccccd0;
      --muted:     #8888a0;
      --dim:       #50506a;
      --accent:    #6c5ce7;
      --accent2:   #a29bfe;
      --accent-glow: rgba(108,92,231,.2);
      --green:     #00b894;
      --green2:    #55efc4;
      --red:       #d63031;
      --red2:      #ff7675;
      --orange:    #e17055;
      --orange2:   #fab1a0;
      --yellow:    #fdcb6e;
      --yellow2:   #ffeaa7;
      --blue:      #74b9ff;
      --pink:      #fd79a8;
      --teal:      #81ecec;
      --purple:    #a29bfe;
      --radius:    14px;
      --radius-sm: 10px;
      --radius-xs: 7px;
      --shadow:    0 4px 24px rgba(0,0,0,.4);
      --shadow-lg: 0 8px 40px rgba(0,0,0,.5);
      --glass:     rgba(255,255,255,.03);
      --glass2:    rgba(255,255,255,.05);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

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
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--border3); }

    /* ── Animations ── */
    @keyframes pulse    { 0%,100%{opacity:1} 50%{opacity:.3} }
    @keyframes spin     { to { transform: rotate(360deg); } }
    @keyframes fadeIn   { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
    @keyframes slideIn  { from { opacity:0; transform: translateX(-12px); } to { opacity:1; transform: translateX(0); } }
    @keyframes shimmer  { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    @keyframes glow     { 0%,100% { box-shadow: 0 0 8px rgba(108,92,231,.3); } 50% { box-shadow: 0 0 20px rgba(108,92,231,.5); } }

    /* ── Nav ── */
    .nav {
      position: sticky; top: 0; z-index: 200;
      background: rgba(6,6,10,.85);
      backdrop-filter: blur(20px) saturate(1.4);
      -webkit-backdrop-filter: blur(20px) saturate(1.4);
      border-bottom: 1px solid var(--border);
      padding: 0 28px;
      height: 60px;
      display: flex; align-items: center; gap: 20px;
    }
    .nav-logo {
      display: flex; align-items: center; gap: 10px;
      font-size: 17px; font-weight: 800; letter-spacing: -0.5px;
      background: linear-gradient(135deg, var(--accent), var(--accent2), var(--teal));
      background-size: 200% 200%;
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      white-space: nowrap;
    }
    .nav-logo-icon { font-size: 22px; -webkit-text-fill-color: initial; }
    .nav-sep { width: 1px; height: 24px; background: var(--border); }
    .nav-subtitle { font-size: 10px; color: var(--dim); letter-spacing: 1.5px; text-transform: uppercase; font-weight: 600; }
    .nav-right { margin-left: auto; display: flex; align-items: center; gap: 14px; }
    .status-pill {
      display: flex; align-items: center; gap: 7px;
      background: var(--glass2); border: 1px solid var(--border);
      border-radius: 20px; padding: 5px 14px;
      font-size: 11px; color: var(--muted); font-weight: 500;
      backdrop-filter: blur(8px);
    }
    .status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--green2);
      box-shadow: 0 0 8px var(--green);
      animation: pulse 2s ease-in-out infinite;
    }
    .status-dot.paused { background: var(--red2); box-shadow: 0 0 8px var(--red); animation: none; }
    .nav-time { font-size: 11px; color: var(--dim); font-family: 'JetBrains Mono', monospace; font-weight: 400; }

    /* ── Layout ── */
    .layout { display: flex; min-height: calc(100vh - 60px); }

    /* ── Sidebar ── */
    .sidebar {
      width: 240px; min-width: 240px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 20px 14px;
      display: flex; flex-direction: column; gap: 4px;
      position: sticky; top: 60px; height: calc(100vh - 60px); overflow-y: auto;
    }
    .sidebar-section {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1.2px; color: var(--dim); padding: 12px 10px 6px;
      margin-top: 4px;
    }
    .sidebar-section:first-child { margin-top: 0; }
    .source-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-radius: var(--radius-sm);
      border: 1px solid transparent;
      cursor: pointer; transition: all .2s ease;
      font-size: 12px; font-weight: 500;
      user-select: none;
    }
    .source-item:hover { background: var(--glass2); border-color: var(--border); }
    .source-item.on {
      background: rgba(0,184,148,.06);
      border-color: rgba(0,184,148,.2);
      color: var(--green2);
    }
    .source-item.off {
      background: rgba(214,48,49,.04);
      border-color: rgba(214,48,49,.12);
      color: var(--dim);
      opacity: .7;
    }
    .source-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; transition: all .2s; }
    .source-dot.on  { background: var(--green2); box-shadow: 0 0 8px rgba(0,184,148,.5); }
    .source-dot.off { background: var(--red2); box-shadow: 0 0 4px rgba(214,48,49,.3); }
    .source-name { flex: 1; }
    .source-count {
      font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 500;
      color: var(--dim); background: var(--glass); padding: 2px 7px; border-radius: 6px;
    }
    .sidebar-divider { height: 1px; background: linear-gradient(90deg, transparent, var(--border), transparent); margin: 10px 8px; }

    /* ── Sidebar filters ── */
    .sidebar-filters { padding: 4px 8px; display: flex; flex-direction: column; gap: 8px; }

    /* ── Main content ── */
    .main { flex: 1; min-width: 0; padding: 28px; }

    /* ── Stats grid ── */
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 28px; }
    .stat-card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 20px 22px;
      position: relative; overflow: hidden;
      transition: all .25s ease;
      animation: fadeIn .4s ease backwards;
    }
    .stat-card:nth-child(2) { animation-delay: .05s; }
    .stat-card:nth-child(3) { animation-delay: .1s; }
    .stat-card:nth-child(4) { animation-delay: .15s; }
    .stat-card:hover { border-color: var(--border2); transform: translateY(-2px); box-shadow: var(--shadow); }
    .stat-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: linear-gradient(90deg, var(--accent), var(--accent2), transparent);
      opacity: 0; transition: opacity .3s;
    }
    .stat-card:hover::before { opacity: 1; }
    .stat-icon { font-size: 20px; margin-bottom: 12px; display: inline-block; }
    .stat-val {
      font-size: 28px; font-weight: 800; color: var(--text); letter-spacing: -1px; line-height: 1;
      font-family: 'JetBrains Mono', monospace;
    }
    .stat-val span { font-size: 14px; font-weight: 500; color: var(--accent2); margin-left: 2px; }
    .stat-lbl { font-size: 11px; color: var(--muted); margin-top: 6px; font-weight: 500; }
    .stat-sub { font-size: 10px; color: var(--dim); margin-top: 3px; }

    /* ── Toolbar ── */
    .toolbar {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 18px; flex-wrap: wrap;
      padding: 14px 18px;
      background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
      backdrop-filter: blur(8px);
    }
    .toolbar-label { font-size: 11px; color: var(--dim); margin-right: 2px; white-space: nowrap; font-weight: 600; }

    /* ── Control Panel ── */
    .control-panel {
      background: linear-gradient(135deg, rgba(108,92,231,.05) 0%, rgba(129,236,236,.03) 100%);
      border: 1px solid rgba(108,92,231,.15);
      border-radius: var(--radius);
      padding: 20px 24px;
      margin-bottom: 24px;
      backdrop-filter: blur(10px);
    }
    .control-panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--accent2);
      text-transform: uppercase;
      letter-spacing: 1.2px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .control-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }
    .control-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 16px 12px;
      background: var(--card2);
      border: 1.5px solid var(--border2);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all .2s ease;
      font-size: 12px;
      font-weight: 600;
      color: var(--text2);
      white-space: nowrap;
      position: relative;
      overflow: hidden;
    }
    .control-btn::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(108,92,231,.1) 0%, transparent 80%);
      pointer-events: none;
      opacity: 0;
      transition: opacity .3s;
    }
    .control-btn:hover {
      border-color: var(--accent);
      background: rgba(108,92,231,.08);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(108,92,231,.15);
      color: var(--accent2);
    }
    .control-btn:hover::before {
      opacity: 1;
    }
    .control-btn:active {
      transform: translateY(0);
    }
    .control-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }
    .control-icon {
      font-size: 22px;
      display: block;
      line-height: 1;
    }
    .control-label {
      font-size: 11px;
      color: var(--muted);
    }
    .control-btn:hover .control-label {
      color: var(--text2);
    }
    .control-status {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--green2);
      box-shadow: 0 0 6px rgba(0,184,148,.6);
    }
    .control-status.off {
      background: var(--red2);
      box-shadow: 0 0 6px rgba(214,48,49,.4);
    }
    .control-status.idle {
      background: var(--dim);
      box-shadow: none;
    }

    /* ── Source Controls ── */
    .source-controls {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .source-control-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--card);
      border: 1px solid var(--border2);
      border-radius: var(--radius-xs);
      cursor: pointer;
      transition: all .2s ease;
      font-size: 11px;
      font-weight: 600;
      color: var(--text2);
    }
    .source-control-btn:hover {
      border-color: var(--accent);
      background: rgba(108,92,231,.06);
    }
    .source-control-btn.disabled {
      border-color: var(--border);
      background: rgba(214,48,49,.04);
      color: var(--dim);
    }
    .source-control-toggle {
      width: 24px;
      height: 14px;
      border-radius: 7px;
      background: var(--green2);
      position: relative;
      transition: all .2s;
    }
    .source-control-toggle::after {
      content: '';
      position: absolute;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: white;
      top: 1px;
      left: 1px;
      transition: left .2s;
    }
    .source-control-btn.disabled .source-control-toggle {
      background: var(--dim);
    }
    .source-control-btn.disabled .source-control-toggle::after {
      left: 11px;
    }
    .toolbar-sep { width: 1px; height: 22px; background: var(--border); margin: 0 4px; }
    select {
      background: var(--card2); border: 1px solid var(--border2);
      color: var(--text); padding: 7px 12px; border-radius: var(--radius-xs);
      font-size: 12px; outline: none; cursor: pointer;
      font-family: 'Inter', sans-serif;
      transition: border-color .2s, box-shadow .2s;
    }
    select:hover { border-color: var(--border3); }
    select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }

    .btn {
      padding: 8px 16px; border-radius: var(--radius-xs); border: none;
      cursor: pointer; font-size: 12px; font-weight: 600;
      transition: all .2s ease; white-space: nowrap;
      font-family: 'Inter', sans-serif;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), #7c6cf0);
      color: #fff; box-shadow: 0 2px 16px rgba(108,92,231,.35);
    }
    .btn-primary:hover { box-shadow: 0 4px 24px rgba(108,92,231,.5); transform: translateY(-1px); }
    .btn-primary:active { transform: translateY(0); }
    .btn-ghost {
      background: var(--glass); border: 1px solid var(--border2);
      color: var(--muted);
    }
    .btn-ghost:hover { background: var(--card3); color: var(--text); border-color: var(--border3); }
    .btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none !important; box-shadow: none !important; }

    /* ── Trend Cards (card layout) ── */
    .trends-list { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
    .trend-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0;
      transition: all .2s ease;
      animation: fadeIn .3s ease backwards;
      overflow: hidden;
    }
    .trend-card:hover {
      border-color: var(--border2);
      box-shadow: 0 4px 20px rgba(0,0,0,.3);
      transform: translateY(-1px);
    }

    /* ── Card header row ── */
    .card-header {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 14px 18px 10px;
      border-bottom: 1px solid var(--border);
      background: var(--glass);
    }
    .card-title {
      font-size: 14px; font-weight: 700; color: var(--text);
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .card-title a { color: inherit; text-decoration: none; transition: color .15s; }
    .card-title a:hover { color: var(--accent2); text-decoration: underline; }
    .card-meta {
      display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    }

    /* ── Card body ── */
    .card-body { padding: 14px 18px; }
    .card-orig {
      font-size: 11px; color: var(--dim); font-style: italic;
      margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .card-desc {
      font-size: 12px; color: var(--muted); line-height: 1.5;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
      margin-bottom: 12px;
    }
    .card-desc.pump { color: var(--orange); font-weight: 500; }

    /* ── Card stats row ── */
    .card-stats {
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    }
    .card-stat {
      display: flex; flex-direction: column; gap: 2px;
    }
    .card-stat-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: .8px;
      color: var(--dim); font-weight: 600;
    }

    /* ── Meme score (inline for cards, legacy) ── */
    .meme-score { display: flex; align-items: center; gap: 8px; }
    .meme-num {
      font-size: 20px; font-weight: 800; font-family: 'JetBrains Mono', monospace;
      line-height: 1;
    }
    .meme-num.hot  { color: var(--red2);  text-shadow: 0 0 14px rgba(255,118,117,.5); }
    .meme-num.warm { color: var(--orange); text-shadow: 0 0 12px rgba(225,112,85,.4); }
    .meme-num.ok   { color: var(--yellow); }
    .meme-num.cold { color: var(--dim); }
    .meme-bar-wrap { display: flex; flex-direction: column; gap: 2px; min-width: 80px; }
    .meme-bar {
      height: 4px; border-radius: 4px;
      background: var(--border); overflow: hidden; width: 80px;
    }
    .meme-fill { height: 100%; border-radius: 4px; transition: width .4s ease; }
    .meme-label { font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; }

    /* ── ScoreBar — reusable bar for emergence + adoption ── */
    .score-bar-wrap { display: flex; flex-direction: column; gap: 2px; }
    .score-bar-row  { display: flex; align-items: center; gap: 7px; }
    .score-bar-label {
      font-size: 10px; color: var(--dim); font-weight: 600;
      white-space: nowrap; min-width: 86px;
    }
    .score-bar-track {
      flex: 1; height: 5px; border-radius: 4px;
      background: var(--border); overflow: hidden;
    }
    .score-bar-fill { height: 100%; border-radius: 4px; transition: width .4s ease; }
    .score-bar-num {
      font-size: 11px; font-weight: 800; font-family: 'JetBrains Mono', monospace;
      min-width: 22px; text-align: right;
    }
    .score-bar-sub {
      font-size: 10px; color: var(--dim); padding-left: 93px;
      margin-top: -1px;
    }

    /* ── Two-bar container in card ── */
    .card-score-bars { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }

    /* ── Phase badge ── */
    .phase-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 5px;
      font-size: 9px; font-weight: 800; letter-spacing: .8px;
      white-space: nowrap; flex-shrink: 0;
    }

    /* ── Badges ── */
    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 10px; border-radius: 6px;
      font-size: 10px; font-weight: 600; white-space: nowrap; letter-spacing: .3px;
    }
    .cat-meme        { background: rgba(162,155,254,.12); color: #a29bfe; border: 1px solid rgba(162,155,254,.2); }
    .cat-elon        { background: rgba(116,185,255,.12); color: #74b9ff; border: 1px solid rgba(116,185,255,.2); }
    .cat-animals     { background: rgba(85,239,196,.12);  color: #55efc4; border: 1px solid rgba(85,239,196,.2); }
    .cat-tech_drama  { background: rgba(225,112,85,.12);  color: #e17055; border: 1px solid rgba(225,112,85,.2); }
    .cat-degenerates { background: rgba(253,121,168,.12); color: #fd79a8; border: 1px solid rgba(253,121,168,.2); }
    .cat-celebrity   { background: rgba(253,203,110,.12); color: #fdcb6e; border: 1px solid rgba(253,203,110,.2); }
    .cat-sports_degen{ background: rgba(116,185,255,.12); color: #74b9ff; border: 1px solid rgba(116,185,255,.2); }
    .cat-ai_drama    { background: rgba(129,236,236,.12); color: #81ecec; border: 1px solid rgba(129,236,236,.2); }
    .cat-boring      { background: rgba(30,30,40,.6);     color: #555568; border: 1px solid rgba(40,40,55,.8); }
    .cat-other       { background: rgba(30,30,40,.6);     color: #666680; border: 1px solid rgba(40,40,55,.8); }

    /* ── Source chip ── */
    .source-chip {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; color: var(--muted); white-space: nowrap;
      padding: 3px 8px; border-radius: 6px; background: var(--glass);
    }

    /* ── Lifespan ── */
    .lifespan { font-size: 11px; color: var(--dim); white-space: nowrap; }

    /* ── Time ── */
    .time-cell { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--dim); white-space: nowrap; }

    /* ── Card footer (action buttons) ── */
    .card-footer {
      display: flex; gap: 8px; padding: 12px 18px;
      border-top: 1px solid var(--border);
      background: var(--glass);
    }
    .trend-link {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 600; color: var(--accent2);
      text-decoration: none; padding: 7px 16px;
      border: 1px solid var(--border2); border-radius: 8px;
      background: var(--card2); transition: all .2s;
      white-space: nowrap;
    }
    .trend-link:hover {
      background: var(--accent-glow); border-color: var(--accent);
      color: var(--text); transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(108,92,231,.25);
    }
    .trend-link-tg {
      color: #5bc0eb; border-color: rgba(91,192,235,.3);
    }
    .trend-link-tg:hover {
      background: rgba(91,192,235,.12); border-color: rgba(91,192,235,.5);
      color: #fff; box-shadow: 0 2px 8px rgba(91,192,235,.2);
    }
    .trend-link-reddit { color: #ff6b35; border-color: rgba(255,107,53,.3); }
    .trend-link-reddit:hover {
      background: rgba(255,107,53,.12); border-color: rgba(255,107,53,.5);
      color: #fff; box-shadow: 0 2px 8px rgba(255,107,53,.2);
    }
    .trend-link-twitter { color: #1da1f2; border-color: rgba(29,161,242,.3); }
    .trend-link-twitter:hover {
      background: rgba(29,161,242,.12); border-color: rgba(29,161,242,.5);
      color: #fff; box-shadow: 0 2px 8px rgba(29,161,242,.2);
    }
    .trend-link-tiktok { color: #ee1d52; border-color: rgba(238,29,82,.3); }
    .trend-link-tiktok:hover {
      background: rgba(238,29,82,.12); border-color: rgba(238,29,82,.5);
      color: #fff; box-shadow: 0 2px 8px rgba(238,29,82,.2);
    }

    /* ── Table wrap & header ── */
    .table-wrap {
      background: transparent; border: none;
      border-radius: var(--radius); overflow: hidden;
    }
    .table-header {
      padding: 14px 22px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 4px;
    }
    .table-title { font-size: 14px; font-weight: 700; color: var(--text); }
    .table-count { font-size: 11px; color: var(--dim); font-family: 'JetBrains Mono', monospace; font-weight: 500; }

    /* ── Pagination ── */
    .pagination {
      display: flex; gap: 8px; align-items: center;
      justify-content: center; padding: 18px;
      background: var(--glass);
    }
    .page-info { font-size: 12px; color: var(--dim); font-family: 'JetBrains Mono', monospace; }

    /* ── Loading / Empty ── */
    .loading-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 20px; gap: 16px; }
    .loading-spinner {
      width: 36px; height: 36px; border-radius: 50%;
      border: 3px solid var(--border); border-top-color: var(--accent);
      animation: spin .7s linear infinite;
    }
    .loading-text { font-size: 13px; color: var(--dim); font-weight: 500; }
    .empty-wrap { display: flex; flex-direction: column; align-items: center; padding: 80px 20px; gap: 14px; }
    .empty-icon { font-size: 48px; opacity: .2; }
    .empty-text { font-size: 14px; color: var(--dim); font-weight: 500; }

    /* ── Error ── */
    .error-bar {
      background: rgba(214,48,49,.08); border: 1px solid rgba(214,48,49,.2);
      color: var(--red2); padding: 12px 18px; border-radius: var(--radius-sm);
      margin-bottom: 18px; font-size: 13px; font-weight: 500;
      display: flex; align-items: center; gap: 8px;
      animation: fadeIn .3s ease;
    }

    /* ── Settings panel ── */
    .settings-panel { padding: 28px 32px; max-width: 700px; animation: fadeIn .3s ease; }
    .settings-header {
      display: flex; align-items: center; gap: 16px;
      margin-bottom: 28px;
    }
    .settings-title { font-size: 20px; font-weight: 800; color: var(--text); letter-spacing: -0.3px; }
    .settings-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 22px 26px;
      margin-bottom: 20px;
      transition: border-color .2s;
    }
    .settings-card:hover { border-color: var(--border2); }
    .settings-card-title { font-size: 14px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
    .settings-card-desc  { font-size: 12px; color: var(--muted); margin-bottom: 20px; }
    .setting-row {
      display: flex; align-items: center; justify-content: space-between; gap: 24px;
      padding: 16px 0;
      border-top: 1px solid var(--border);
    }
    .setting-row:first-of-type { border-top: none; }
    .setting-label { display: flex; flex-direction: column; gap: 4px; flex: 1; }
    .setting-name  { font-size: 13px; font-weight: 600; color: var(--text); }
    .setting-hint  { font-size: 11px; color: var(--muted); }
    .setting-control { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
    .setting-control input[type=range] {
      width: 150px; accent-color: var(--accent);
      height: 4px; cursor: pointer;
    }
    .setting-val {
      font-family: 'JetBrains Mono', monospace;
      font-size: 16px; font-weight: 700;
      color: var(--accent2); min-width: 36px; text-align: right;
    }
    .settings-actions { display: flex; gap: 12px; margin-top: 12px; }

    /* ── Preset grid ── */
    .preset-grid {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px;
      margin-top: 8px;
    }
    @media (max-width: 700px) { .preset-grid { grid-template-columns: repeat(3, 1fr); } }
    .preset-card {
      display: flex; flex-direction: column; align-items: center; gap: 7px;
      padding: 16px 8px; border-radius: var(--radius-sm);
      border: 1px solid var(--border); background: var(--card2);
      cursor: pointer; text-align: center;
      transition: all .2s ease;
    }
    .preset-card:hover { border-color: var(--border3); background: var(--card3); transform: translateY(-1px); }
    .preset-card.active {
      border-color: var(--accent);
      background: var(--accent-glow);
      box-shadow: 0 0 0 1px var(--accent), 0 4px 16px rgba(108,92,231,.2);
    }
    .preset-icon  { font-size: 24px; }
    .preset-label { font-size: 12px; font-weight: 700; color: var(--text); }
    .preset-hint  { font-size: 10px; color: var(--muted); line-height: 1.3; }

    /* ── Sidebar settings link ── */
    .sidebar-settings-btn {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-radius: var(--radius-sm);
      cursor: pointer; color: var(--muted);
      font-size: 13px; font-weight: 500;
      transition: all .2s ease;
      margin-top: auto;
    }
    .sidebar-settings-btn:hover { background: var(--glass2); color: var(--text); }
    .sidebar-settings-btn.active { background: var(--accent-glow); color: var(--accent2); }

    /* ── Trend card: clickable cursor ── */
    .trend-card { cursor: pointer; }
    .trend-card:hover { border-color: var(--accent); box-shadow: 0 4px 24px rgba(108,92,231,.15); }

    /* ── Card image thumbnail ── */
    .card-image-wrap {
      width: 80px; height: 80px; flex-shrink: 0;
      border-radius: 8px; overflow: hidden;
      background: var(--card3); border: 1px solid var(--border);
      position: relative;
    }
    .card-image-wrap img {
      width: 100%; height: 100%; object-fit: cover;
      transition: transform .3s ease;
    }
    .trend-card:hover .card-image-wrap img { transform: scale(1.05); }
    .card-image-placeholder {
      width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
      font-size: 28px; opacity: .25;
    }

    /* ── Copy button (shows on card hover) ── */
    .card-copy-btn {
      opacity: 0; pointer-events: none;
      background: var(--card3); border: 1px solid var(--border2);
      color: var(--muted); border-radius: 6px; padding: 3px 8px;
      font-size: 10px; cursor: pointer; transition: all .15s;
      white-space: nowrap;
    }
    .trend-card:hover .card-copy-btn { opacity: 1; pointer-events: auto; }
    .card-copy-btn:hover { background: var(--accent-glow); color: var(--accent2); border-color: var(--accent); }

    /* ── Search input ── */
    .search-wrap {
      position: relative; flex: 1; min-width: 200px; max-width: 340px;
    }
    .search-icon {
      position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
      color: var(--dim); font-size: 13px; pointer-events: none;
    }
    .search-input {
      width: 100%;
      background: var(--card2); border: 1px solid var(--border2);
      color: var(--text); padding: 7px 12px 7px 32px;
      border-radius: var(--radius-xs); font-size: 12px;
      outline: none; font-family: 'Inter', sans-serif;
      transition: border-color .2s, box-shadow .2s;
    }
    .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
    .search-input::placeholder { color: var(--dim); }

    /* ── Toast notifications ── */
    @keyframes toastIn  { from { opacity:0; transform: translateX(40px); } to { opacity:1; transform: translateX(0); } }
    @keyframes toastOut { from { opacity:1; transform: translateX(0); }    to { opacity:0; transform: translateX(40px); } }
    .toasts-wrap {
      position: fixed; top: 72px; right: 20px; z-index: 9999;
      display: flex; flex-direction: column; gap: 10px;
      pointer-events: none;
    }
    .toast {
      display: flex; align-items: center; gap: 10px;
      background: var(--card3); border: 1px solid var(--border2);
      border-radius: var(--radius-sm); padding: 12px 18px;
      font-size: 13px; font-weight: 500; color: var(--text);
      box-shadow: var(--shadow-lg);
      animation: toastIn .25s ease;
      pointer-events: auto; min-width: 260px; max-width: 360px;
      backdrop-filter: blur(12px);
    }
    .toast.success { border-color: rgba(0,184,148,.3); }
    .toast.success .toast-icon { color: var(--green2); }
    .toast.error   { border-color: rgba(214,48,49,.3); }
    .toast.error   .toast-icon { color: var(--red2); }
    .toast.info    { border-color: rgba(108,92,231,.3); }
    .toast.info    .toast-icon { color: var(--accent2); }
    .toast-icon { font-size: 16px; flex-shrink: 0; }
    .toast-msg  { flex: 1; line-height: 1.4; }

    /* ── Auto-refresh countdown badge ── */
    .refresh-badge {
      font-family: 'JetBrains Mono', monospace; font-size: 10px;
      color: var(--dim); background: var(--glass);
      border: 1px solid var(--border); border-radius: 20px;
      padding: 4px 10px; white-space: nowrap;
    }

    /* ── Keyboard shortcut hints ── */
    .kbd {
      display: inline-block; background: var(--card3); border: 1px solid var(--border3);
      border-radius: 4px; padding: 1px 6px; font-size: 10px;
      font-family: 'JetBrains Mono', monospace; color: var(--dim);
    }

    /* ── Modal overlay ── */
    @keyframes modalIn { from { opacity:0; } to { opacity:1; } }
    @keyframes drawerIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .modal-overlay {
      position: fixed; inset: 0; z-index: 8000;
      background: rgba(0,0,0,.7);
      backdrop-filter: blur(4px);
      animation: modalIn .2s ease;
      display: flex; justify-content: flex-end;
    }
    .modal-drawer {
      width: 560px; max-width: 95vw; height: 100vh;
      background: var(--surface); border-left: 1px solid var(--border2);
      display: flex; flex-direction: column;
      animation: drawerIn .25s cubic-bezier(.4,0,.2,1);
      box-shadow: -8px 0 40px rgba(0,0,0,.5);
      overflow: hidden;
    }
    .modal-head {
      display: flex; align-items: center; gap: 14px;
      padding: 18px 20px; border-bottom: 1px solid var(--border);
      flex-shrink: 0; background: var(--card);
    }
    .modal-close {
      margin-left: auto; background: var(--card3); border: 1px solid var(--border2);
      color: var(--muted); border-radius: 8px; padding: 6px 10px;
      cursor: pointer; font-size: 14px; transition: all .15s; flex-shrink: 0;
    }
    .modal-close:hover { background: rgba(214,48,49,.15); color: var(--red2); border-color: rgba(214,48,49,.3); }
    .modal-body {
      flex: 1; overflow-y: auto; padding: 22px 22px 40px;
      display: flex; flex-direction: column; gap: 18px;
    }

    /* ── Modal image banner ── */
    .modal-image {
      width: 100%; height: 200px; border-radius: var(--radius-sm);
      object-fit: cover; display: block;
      border: 1px solid var(--border);
    }
    .modal-image-loading {
      height: 200px; border-radius: var(--radius-sm);
      background: linear-gradient(90deg, var(--card2) 25%, var(--card3) 50%, var(--card2) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s linear infinite;
      border: 1px solid var(--border);
    }

    /* ── Modal sections ── */
    .modal-title { font-size: 17px; font-weight: 800; color: var(--text); line-height: 1.35; letter-spacing: -.3px; }
    .modal-section { display: flex; flex-direction: column; gap: 8px; }
    .modal-section-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: 1px;
      color: var(--dim); font-weight: 700;
    }
    .modal-section-content {
      font-size: 13px; color: var(--text2); line-height: 1.6;
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 14px 16px;
    }
    .modal-section-content.pump {
      color: var(--orange); border-color: rgba(225,112,85,.2);
      background: rgba(225,112,85,.06);
    }
    .modal-stats-grid {
      display: grid; grid-template-columns: repeat(3,1fr); gap: 10px;
    }
    .modal-stat {
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 12px 14px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .modal-stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: .8px; color: var(--dim); font-weight: 600; }
    .modal-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px; }

    /* ── Sentiment badge ── */
    .sentiment-pos { color: var(--green2); font-weight: 600; }
    .sentiment-neg { color: var(--red2);   font-weight: 600; }
    .sentiment-neu { color: var(--muted); }

    /* ── Responsive ── */
    @media (max-width: 1100px) { .card-meta { flex-wrap: wrap; } }
    @media (max-width: 900px) {
      .sidebar { display: none; }
      .stat-val { font-size: 22px; }
      .card-header { flex-direction: column; align-items: flex-start; gap: 8px; }
      .card-meta { width: 100%; }
      .card-stats { gap: 10px; }
      .card-footer { flex-wrap: wrap; }
      .trend-link { flex: 1; justify-content: center; min-width: 120px; }
      .modal-drawer { width: 100vw; }
    }
    @media (max-width: 600px) {
      .trends-list { padding: 8px; gap: 8px; }
      .card-header { padding: 10px 14px 8px; }
      .card-body { padding: 10px 14px; }
      .card-footer { padding: 10px 14px; }
      .card-stats { flex-direction: column; gap: 12px; }
      .meme-num { font-size: 16px; }
    }
  </style>
</head>
<body>
<div id="root"></div>
<script>
const { useState, useEffect, useCallback, useRef } = React;
const h = React.createElement;

// ── API ──────────────────────────────────────────────────────────────────────
let API_KEY = localStorage.getItem('ts_api_key') || '';
if (!API_KEY) {
  const entered = window.prompt('Введите DASHBOARD API key');
  if (entered && entered.trim()) {
    API_KEY = entered.trim();
    localStorage.setItem('ts_api_key', API_KEY);
  }
}
const api = (path, opts = {}) =>
  fetch('/api' + path, { headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' }, ...opts })
    .then(r => r.json());

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

// ── ImageThumb ─────────────────────────────────────────────────────────────────
function ImageThumb({ trend, size = 80 }) {
  const [imgUrl, setImgUrl] = useState(trend.imageUrl || null);
  const [tried, setTried] = useState(!!trend.imageUrl);
  const srcIco = SOURCE_ICONS[trend.source] || '📡';

  useEffect(() => {
    if (!tried && !imgUrl && trend.url) {
      setTried(true);
      fetch('/api/preview?url=' + encodeURIComponent(trend.url), { headers: { 'X-API-Key': API_KEY } })
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

// ── TrendCard ──────────────────────────────────────────────────────────────────
function TrendCard({ trend, onOpen, onCopy }) {
  const catCls = CAT_CLS[trend.category] || 'cat-other';
  const catIco = CAT_ICONS[trend.category] || '📌';
  const srcIco = SOURCE_ICONS[trend.source] || '📡';
  const srcLbl = SOURCE_LABELS[trend.source] || trend.source;
  const linkLabel = SOURCE_LINK_LABELS[trend.source] || 'Источник';
  const srcLinkCls = trend.source === 'reddit' ? ' trend-link-reddit'
    : trend.source === 'twitter' ? ' trend-link-twitter'
    : trend.source === 'tiktok' ? ' trend-link-tiktok' : '';

  const phase       = trend.narrativePhase || null;
  const emergence   = trend.emergenceScore || 0;
  const adoption    = trend.adoptionScore  || trend.memePotential || 0;
  const velocity    = trend.velocity       || 0;
  const platforms   = trend.uniquePlatforms || 1;
  const phaseMeta   = phase ? (PHASE_META[phase] || PHASE_META.early) : null;

  // Compact meta: "2 плат · 0.8/ч ↑"
  const metaParts = [];
  if (platforms > 1) metaParts.push(platforms + ' плат');
  const vel = fmtVelocity(velocity);
  if (vel) metaParts.push(vel);
  if (trend.timesSeen > 1) metaParts.push(trend.timesSeen + 'x видели');
  const metaStr = metaParts.join(' · ');

  const descText = trend.whyItWillPump || trend.aiExplanation || '';
  const isPump = !!trend.whyItWillPump;

  const handleClick = (e) => {
    if (e.target.closest('a') || e.target.closest('button')) return;
    onOpen && onOpen(trend);
  };

  // Left phase accent border color
  const accentColor = phaseMeta ? phaseMeta.color : 'var(--border)';

  return h('div', {
    className: 'trend-card',
    onClick: handleClick,
    style: { borderLeft: '3px solid ' + accentColor }
  },
    // Header: phase badge + market stage badge + title + meta
    h('div', { className: 'card-header' },
      phase ? h(PhaseBadge, { phase }) : null,
      h(MarketStageBadge, { stage: trend.marketStage }), // [MARKET_STAGE] remove to disable
      h('div', { className: 'card-title', style: { flex: 1 } }, trend.title),
      h('div', { className: 'card-meta' },
        h('span', { className: 'badge ' + catCls }, catIco + ' ' + (trend.category || 'other')),
        h('div', { className: 'source-chip' }, srcIco, ' ', srcLbl),
        h('span', { className: 'time-cell' }, fmtTime(trend.firstSeen)),
        h('button', {
          className: 'card-copy-btn',
          onClick: e => { e.stopPropagation(); onCopy && onCopy(trend.title); },
          title: 'Копировать заголовок'
        }, '📋')
      )
    ),

    // Body
    h('div', { className: 'card-body', style: { display: 'flex', gap: 14 } },
      h('div', { style: { flex: 1, minWidth: 0 } },
        trend.originalTitle && trend.originalTitle !== trend.title
          ? h('div', { className: 'card-orig' }, trend.originalTitle)
          : null,
        descText
          ? h('div', { className: 'card-desc' + (isPump ? ' pump' : '') }, isPump ? '⚡ ' + descText : descText)
          : null,

        // Two bars: Emergence + Adoption
        h('div', { className: 'card-score-bars' },
          h(ScoreBar, {
            label: '🌊 Emergence',
            value: emergence,
            sub: metaStr || null,
          }),
          h(ScoreBar, {
            label: '💊 Adoption',
            value: adoption,
            sub: LIFESPAN_LABELS[trend.predictedLifespan] || null,
          })
        )
      ),
      h(ImageThumb, { trend, size: 76 })
    ),

    // Footer
    (trend.url || trend.tgMessageUrl)
      ? h('div', { className: 'card-footer' },
          trend.url ? h('a', { className: 'trend-link' + srcLinkCls, href: trend.url, target: '_blank', rel: 'noopener', onClick: e => e.stopPropagation() }, linkLabel + ' →') : null,
          trend.tgMessageUrl ? h('a', { className: 'trend-link trend-link-tg', href: trend.tgMessageUrl, target: '_blank', rel: 'noopener', onClick: e => e.stopPropagation() }, '📨 Telegram') : null,
          h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--dim)' } }, '↗ детали')
        )
      : h('div', { className: 'card-footer' },
          h('span', { style: { fontSize: 11, color: 'var(--dim)' } }, '↗ детали')
        )
  );
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
      fetch('/api/preview?url=' + encodeURIComponent(trend.url), { headers: { 'X-API-Key': API_KEY } })
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
function SettingsPanel({ onBack }) {
  const [draft,   setDraft]   = useState(null);
  const [saving,  setSaving]  = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [err,     setErr]     = useState('');

  useEffect(() => {
    api('/settings').then(s => setDraft(s)).catch(e => setErr(e.message));
  }, []);

  const set = (key, val) => setDraft(prev => ({ ...prev, [key]: val }));

  const save = async () => {
    setSaving(true); setSavedOk(false); setErr('');
    try {
      const res = await api('/settings', { method: 'POST', body: JSON.stringify(draft) });
      if (res.error) { setErr(res.error); }
      else { setSavedOk(true); setTimeout(() => setSavedOk(false), 3000); }
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  if (!draft) return h('div', { className: 'loading-wrap' },
    h('div', { className: 'loading-spinner' }),
    h('span', { className: 'loading-text' }, 'Загрузка настроек...')
  );

  const SliderRow = ({ label, hint, settingKey, min, max, step, valDisplay }) =>
    h('div', { className: 'setting-row' },
      h('div', { className: 'setting-label' },
        h('span', { className: 'setting-name' }, label),
        h('span', { className: 'setting-hint' }, hint)
      ),
      h('div', { className: 'setting-control' },
        h('input', {
          type: 'range', min, max, step,
          value: draft[settingKey],
          onChange: e => set(settingKey, +e.target.value)
        }),
        h('span', { className: 'setting-val' }, valDisplay !== undefined ? valDisplay : draft[settingKey])
      )
    );

  const PRESETS = [
    { id: 'general',     icon: '🌐', label: 'Общий',        hint: 'Любой вирусный контент — ультра-широкий поиск на всех языках' },
    { id: 'animals',     icon: '🐾', label: 'Животные',     hint: 'Вирусные питомцы, смешные животные, милые создания' },
    { id: 'culture',     icon: '🎭', label: 'Культура',     hint: 'Мемы, интернет-тренды, сленг, юмор, вирусный контент' },
    { id: 'celebrities', icon: '⭐', label: 'Знаменитости', hint: 'Селебрити, поп-культура, музыка, кино, вирусные моменты' },
    { id: 'events',      icon: '🌍', label: 'События',      hint: 'Мировые события, спорт, брейкинг, космос, AI-новости' },
  ];

  return h('div', { className: 'settings-panel' },
    h('div', { className: 'settings-header' },
      h('button', { className: 'btn btn-ghost', onClick: onBack }, '← Назад'),
      h('span', { className: 'settings-title' }, '⚙️ Настройки')
    ),

    err ? h('div', { className: 'error-bar' }, '⚠️ ', err) : null,

    // ── Presets ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, '🎯 Пресет поиска'),
      h('div', { className: 'settings-card-desc' },
        'Определяет темы для Twitter, Reddit и TikTok сразу. Применяется с ближайшего цикла.'
      ),
      h('div', { className: 'preset-grid' },
        PRESETS.map(p =>
          h('div', {
            key: p.id,
            className: 'preset-card' + (draft.activePreset === p.id ? ' active' : ''),
            onClick: () => set('activePreset', p.id),
          },
            h('div', { className: 'preset-icon' }, p.icon),
            h('div', { className: 'preset-label' }, p.label),
            h('div', { className: 'preset-hint' }, p.hint)
          )
        )
      )
    ),

    // ── Alerts ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, '🔔 Алерты в Telegram / Discord'),
      h('div', { className: 'settings-card-desc' },
        'Нарратив проходит в уведомление только если проходит оба фильтра: Meme Potential и Virality.'
      ),
      h(SliderRow, {
        label: '🔥 Глобальный Meme Potential (минимум для всех)',
        hint:  'Текущее: ' + draft.alertThreshold + '/100. Это общий floor: пользовательский порог не может быть ниже.',
        settingKey: 'alertThreshold', min: 0, max: 100, step: 5
      }),
      h(SliderRow, {
        label: '📈 Virality Score — глобальный порог',
        hint:  'Текущее: ' + draft.viralityThreshold + '/100. Рекомендуемо 70-75 для снижения мусорных алертов.',
        settingKey: 'viralityThreshold', min: 0, max: 100, step: 5
      }),
      h(SliderRow, {
        label: '📨 Максимум алертов за цикл',
        hint:  '0 = без ограничений. Поставь 3-5 чтобы не получать пачки за раз.',
        settingKey: 'maxAlertsPerCycle', min: 0, max: 20, step: 1,
        valDisplay: draft.maxAlertsPerCycle === 0 ? '∞' : draft.maxAlertsPerCycle
      })
    ),

    // ── Storage ──
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-card-title' }, '🗄️ Хранение данных'),
      h('div', { className: 'settings-card-desc' },
        'Нарративы ниже порога сохраняются в БД но не алертят. Увеличь чтобы экономить место.'
      ),
      h(SliderRow, {
        label: '📊 Базовый охват — мин. для сохранения',
        hint:  'Нарративы с базовым охватом ниже этого значения не сохраняются вообще.',
        settingKey: 'minScoreToSave', min: 0, max: 80, step: 5
      })
    ),

    h('div', { className: 'settings-actions' },
      h('button', {
        className: 'btn btn-primary',
        onClick: save,
        disabled: saving
      }, saving ? '⏳ Сохраняю...' : savedOk ? '✅ Сохранено!' : '💾 Сохранить настройки')
    )
  );
}

// ── App ──────────────────────────────────────────────────────────────────────
function App() {
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
  const [tick,       setTick]       = useState(0);
  const [view,       setView]       = useState('trends');
  const [modalTrend, setModalTrend] = useState(null);
  const [toasts,     setToasts]     = useState([]);
  const [search,     setSearch]     = useState('');
  const [refreshAt,  setRefreshAt]  = useState(Date.now() + 90000);
  const toastId = useRef(0);
  const LIMIT = 25;

  // 1-second tick for countdown + clock
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

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

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await api('/scan', { method: 'POST' });
      if (res.error) { addToast(res.error, 'error'); }
      else { addToast('⚡ Сканирование запущено!', 'success'); setTimeout(fetchData, 8000); }
    } catch (ex) { addToast(ex.message, 'error'); }
    setTimeout(() => setScanning(false), 6000);
  }, [addToast, fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { const t = setInterval(fetchData, 90000); return () => clearInterval(t); }, [fetchData]);

  // Keyboard shortcuts: R=refresh, S=scan, Esc=close modal
  useEffect(() => {
    const fn = e => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'Escape') { setModalTrend(null); return; }
      if (e.key === 'r' || e.key === 'R') { fetchData(); addToast('Обновляю...', 'info'); return; }
      if ((e.key === 's' || e.key === 'S') && !scanning) { scan(); return; }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [scanning, fetchData, addToast, scan]);

  const toggle = async (name) => {
    await api('/collectors/' + name + '/toggle', { method: 'POST' });
    setSources(prev => prev.map(s => s.source === name ? { ...s, enabled: !s.enabled } : s));
    const src = sources.find(s => s.source === name);
    const nowEnabled = src ? !src.enabled : true;
    addToast((nowEnabled ? '✅ Включён: ' : '🔴 Отключён: ') + (SOURCE_LABELS[name] || name), nowEnabled ? 'success' : 'info');
  };

  const copyToClipboard = useCallback((text) => {
    navigator.clipboard.writeText(text).then(
      () => addToast('📋 Скопировано!', 'success'),
      () => addToast('Не удалось скопировать', 'error')
    );
  }, [addToast]);

  const pages = Math.ceil(total / LIMIT);
  const page  = Math.floor(offset / LIMIT);
  const refreshIn = Math.max(0, Math.ceil((refreshAt - Date.now()) / 1000));

  // Client-side search filter (doesn't reset pagination)
  const visibleTrends = search.trim()
    ? trends.filter(t => {
        const q = search.toLowerCase();
        return (t.title || '').toLowerCase().includes(q)
          || (t.originalTitle || '').toLowerCase().includes(q)
          || (t.aiExplanation || '').toLowerCase().includes(q)
          || (t.category || '').toLowerCase().includes(q);
      })
    : trends;

  return h('div', null,
    // Toast notifications (fixed top-right)
    h(Toasts, { toasts }),

    // Side drawer modal
    modalTrend ? h(TrendModal, { trend: modalTrend, onClose: () => setModalTrend(null) }) : null,

    // ── Nav ──
    h('nav', { className: 'nav' },
      h('div', { className: 'nav-logo' },
        h('span', { className: 'nav-logo-icon' }, '🔥'),
        'TrendScout'
      ),
      h('div', { className: 'nav-sep' }),
      h('span', { className: 'nav-subtitle' }, 'Trend Intelligence'),
      h('div', { className: 'nav-right' },
        h('div', { className: 'status-pill' },
          h('div', { className: 'status-dot' + (stats?.paused ? ' paused' : '') }),
          stats?.paused ? 'Пауза' : 'Активен'
        ),
        h('span', { className: 'refresh-badge' }, '↻ ' + refreshIn + 'с'),
        h('span', { className: 'nav-time' }, new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))
      )
    ),

    // ── Layout ──
    h('div', { className: 'layout' },

      // ── Sidebar ──
      h('aside', { className: 'sidebar' },
        h('div', { className: 'sidebar-section' }, 'Источники'),
        ...sources.map(s =>
          h('div', {
            key: s.source,
            className: 'source-item ' + (s.enabled ? 'on' : 'off'),
            onClick: () => toggle(s.source),
            title: s.enabled ? 'Кликни чтобы отключить' : 'Кликни чтобы включить'
          },
            h('div', { className: 'source-dot ' + (s.enabled ? 'on' : 'off') }),
            h('span', { className: 'source-name' }, SOURCE_ICONS[s.source] + ' ' + (SOURCE_LABELS[s.source] || s.source)),
            h('span', { className: 'source-count' }, s.last24h || 0)
          )
        ),
        h('div', { className: 'sidebar-divider' }),
        h('div', { className: 'sidebar-section' }, 'Фильтры'),
        h('div', { className: 'sidebar-filters' },
          h('select', { value: hours, onChange: ev => { setHours(+ev.target.value); setOffset(0); }, style: { width: '100%' } },
            h('option', { value: 6 },   '6 часов'),
            h('option', { value: 24 },  '24 часа'),
            h('option', { value: 72 },  '3 дня'),
            h('option', { value: 168 }, '7 дней')
          ),
          h('select', { value: minMeme, onChange: ev => { setMinMeme(+ev.target.value); setOffset(0); }, style: { width: '100%' } },
            h('option', { value: 0 },  'Adoption ≥ 0'),
            h('option', { value: 30 }, 'Adoption ≥ 30'),
            h('option', { value: 50 }, 'Adoption ≥ 50'),
            h('option', { value: 70 }, 'Adoption ≥ 70'),
            h('option', { value: 85 }, 'Adoption ≥ 85')
          ),
          h('select', { value: category, onChange: ev => { setCategory(ev.target.value); setOffset(0); }, style: { width: '100%' } },
            h('option', { value: '' }, 'Все категории'),
            Object.keys(CAT_ICONS).map(c => h('option', { key: c, value: c }, CAT_ICONS[c] + ' ' + c))
          )
        ),
        h('div', { style: { flex: 1 } }),
        h('div', {
          className: 'sidebar-settings-btn' + (view === 'settings' ? ' active' : ''),
          onClick: () => setView(v => v === 'settings' ? 'trends' : 'settings')
        }, '⚙️', h('span', null, ' Настройки'))
      ),

      // ── Main ──
      h('main', { className: 'main' },
        view === 'settings'
          ? h(SettingsPanel, { onBack: () => setView('trends') })
          : h(React.Fragment, null,

        // Error
        error ? h('div', { className: 'error-bar' }, '⚠️ ', error) : null,

        // Stats
        stats ? h('div', { className: 'stats-row' },
          h(StatCard, { icon: '📊', value: stats.total, label: 'Трендов за ' + hours + 'ч', sub: stats.alerts + ' алертов' }),
          h(StatCard, { icon: '🎯', value: stats.avgScore, suffix: '/100', label: 'Средний score' }),
          ...(stats.bySource || []).map(s =>
            h(StatCard, { key: s.source, icon: SOURCE_ICONS[s.source] || '📡', value: s.count, label: SOURCE_LABELS[s.source] || s.source, sub: 'за ' + hours + 'ч' })
          )
        ) : null,

        // Control Panel
        h(ControlPanel, {
          scanning,
          onScan: scan,
          sources,
          onCollectorToggle: toggle,
          addToast,
        }),

        // Toolbar with search
        h('div', { className: 'toolbar' },
          h('span', { className: 'toolbar-label' }, 'Источник:'),
          h('select', { value: source, onChange: ev => { setSource(ev.target.value); setOffset(0); } },
            h('option', { value: '' }, 'Все источники'),
            ['reddit','google_trends','twitter','tiktok'].map(s => h('option', { key: s, value: s }, SOURCE_ICONS[s] + ' ' + (SOURCE_LABELS[s] || s)))
          ),
          h('div', { className: 'toolbar-sep' }),
          h('span', { className: 'toolbar-label' }, 'Фаза:'),
          h('select', { value: phase, onChange: ev => { setPhase(ev.target.value); setOffset(0); } },
            h('option', { value: '' }, 'Все фазы'),
            h('option', { value: 'early'     }, '🔵 Early'),
            h('option', { value: 'forming'   }, '🟡 Forming'),
            h('option', { value: 'strong'    }, '🟢 Strong'),
            h('option', { value: 'saturated' }, '🔴 Saturated')
          ),
          h('div', { className: 'toolbar-sep' }),
          h('span', { className: 'toolbar-label' }, 'Сортировка:'),
          h('select', { value: sort, onChange: ev => { setSort(ev.target.value); setOffset(0); } },
            h('option', { value: 'rank'      }, '⚡ Rank (Emergence+Adoption)'),
            h('option', { value: 'meme'      }, '💊 Топ Adoption'),
            h('option', { value: 'emergence' }, '🌊 Топ Emergence'),
            h('option', { value: 'time'      }, '🕐 Новые сначала'),
            h('option', { value: 'virality'  }, '📊 Виральность')
          ),
          h('div', { className: 'toolbar-sep' }),
          h('div', { className: 'search-wrap' },
            h('span', { className: 'search-icon' }, '🔍'),
            h('input', {
              type: 'text',
              className: 'search-input',
              placeholder: 'Поиск по заголовку...',
              value: search,
              onChange: e => setSearch(e.target.value),
            })
          ),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', { className: 'kbd', title: 'R = обновить, S = сканировать, Esc = закрыть' }, 'R / S / Esc'),
            h('button', { className: 'btn btn-ghost', onClick: () => { fetchData(); addToast('Обновляю...', 'info'); } }, '↻ Обновить'),
            h('button', { className: 'btn btn-primary', onClick: scan, disabled: scanning },
              scanning ? '⏳ Скан...' : '⚡ Сканировать'
            )
          )
        ),

        // Trends list
        h('div', { className: 'table-wrap' },
          h('div', { className: 'table-header' },
            h('span', { className: 'table-title' }, '🔥 Нарративы'),
            h('span', { className: 'table-count' },
              search.trim() ? visibleTrends.length + ' / ' + total + ' найдено' : total + ' найдено'
            )
          ),
          loading
            ? h('div', { className: 'loading-wrap' },
                h('div', { className: 'loading-spinner' }),
                h('div', { className: 'loading-text' }, 'Загружаю тренды...')
              )
            : visibleTrends.length === 0
              ? h('div', { className: 'empty-wrap' },
                  h('div', { className: 'empty-icon' }, '🔍'),
                  h('div', { className: 'empty-text' },
                    search.trim()
                      ? 'Нет совпадений по запросу «' + search + '»'
                      : 'Нарративов не найдено — попробуй другие фильтры'
                  )
                )
              : h(React.Fragment, null,
                  h('div', { className: 'trends-list' },
                    visibleTrends.map(t => h(TrendCard, { key: t.id, trend: t, onOpen: setModalTrend, onCopy: copyToClipboard }))
                  )
                ),
          // Pagination (hidden when searching)
          !search.trim() && pages > 1 ? h('div', { className: 'pagination' },
            h('button', { className: 'btn btn-ghost', onClick: () => setOffset(Math.max(0, offset - LIMIT)), disabled: page === 0 }, '← Назад'),
            h('span', { className: 'page-info' }, (page + 1) + ' / ' + pages),
            h('button', { className: 'btn btn-ghost', onClick: () => setOffset(offset + LIMIT), disabled: page >= pages - 1 }, 'Вперёд →')
          ) : null
        )

      ) // end Fragment
      ) // end main
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
