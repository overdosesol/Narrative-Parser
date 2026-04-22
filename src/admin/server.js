/**
 * Catalyst Admin Panel — Port 8080
 * Управление пользователями, подписками, статистикой и ботом
 */

import http from 'http';
import { timingSafeEqual } from 'crypto';
import {
  FILTER_PROFILES,
  PRESET_KEYS,
  PROFILE_FIELD_RANGES,
  getEffectiveProfiles,
  validateProfileOverrides,
} from '../analysis/filter-profiles.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) { timingSafeEqual(ba, ba); return false; }
    return timingSafeEqual(ba, bb);
  } catch { return false; }
}

function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Cache-Control': 'no-cache',
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 32 * 1024;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      body += c;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── Admin Server ─────────────────────────────────────────────────────────────

class AdminServer {
  constructor(config, logger, db, bot, appState = null, scanFn = null) {
    this.config = config;
    this.logger = logger;
    this.db = db;
    this.bot = bot;
    this.appState = appState || { paused: false, disabledCollectors: new Set() };
    this.scanFn = scanFn; // optional callback to trigger manual scan
    this.port = parseInt(process.env.ADMIN_PORT || '8080');
    this.host = process.env.ADMIN_HOST || '127.0.0.1';
    this.adminKey = process.env.ADMIN_API_KEY || '';
    this.server = null;
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  _auth(req) {
    if (!this.adminKey) return false;
    const key = req.headers['x-admin-key'] || '';
    return safeEqual(key, this.adminKey);
  }

  // ── DB Queries ──────────────────────────────────────────────────────────────
  _getAllUsers(search = '', plan = '', status = '') {
    let q = `SELECT u.id, u.telegram_chat_id, u.telegram_username, u.language,
      u.status, u.alert_threshold, u.alert_count_today, u.subscription_expires_at,
      u.created_at, u.last_seen_at, p.name as plan_name, p.price_usd as plan_price
      FROM users u JOIN plans p ON u.plan_id = p.id WHERE 1=1`;
    const params = [];
    if (search) { q += ` AND (u.telegram_username LIKE ? OR u.telegram_chat_id LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
    if (plan) { q += ` AND p.name = ?`; params.push(plan); }
    if (status) { q += ` AND u.status = ?`; params.push(status); }
    q += ` ORDER BY u.created_at DESC LIMIT 200`;
    return this.db.db.prepare(q).all(...params);
  }

  _getPayments(limit = 50, offset = 0) {
    return this.db.db.prepare(`
      SELECT p.*, u.telegram_username, u.telegram_chat_id
      FROM payments p LEFT JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  _getStats() {
    const db = this.db.db;
    const now = new Date();
    const day7 = new Date(now - 7*86400000).toISOString();
    const day30 = new Date(now - 30*86400000).toISOString();

    const totalUsers = db.prepare(`SELECT COUNT(*) as n FROM users`).get().n;
    const activeUsers = db.prepare(`SELECT COUNT(*) as n FROM users WHERE status='active'`).get().n;
    const newToday = db.prepare(`SELECT COUNT(*) as n FROM users WHERE date(created_at) = date('now')`).get().n;
    const newWeek = db.prepare(`SELECT COUNT(*) as n FROM users WHERE created_at > ?`).get(day7).n;
    const newMonth = db.prepare(`SELECT COUNT(*) as n FROM users WHERE created_at > ?`).get(day30).n;

    const paidUsers = db.prepare(`SELECT COUNT(*) as n FROM users u JOIN plans p ON u.plan_id=p.id WHERE p.name != 'free'`).get().n;
    const revenue30 = db.prepare(`SELECT COALESCE(SUM(amount),0) as r FROM payments WHERE status='confirmed' AND created_at > ?`).get(day30).r;
    const revenueTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) as r FROM payments WHERE status='confirmed'`).get().r;
    const revenue30ByCurrency = db.prepare(`
      SELECT currency, COALESCE(SUM(amount),0) as total
      FROM payments
      WHERE status='confirmed' AND created_at > ?
      GROUP BY currency
      ORDER BY currency
    `).all(day30);
    const revenueTotalByCurrency = db.prepare(`
      SELECT currency, COALESCE(SUM(amount),0) as total
      FROM payments
      WHERE status='confirmed'
      GROUP BY currency
      ORDER BY currency
    `).all();

    const planDist = db.prepare(`SELECT p.name, COUNT(*) as n FROM users u JOIN plans p ON u.plan_id=p.id GROUP BY p.name`).all();
    const langDist = db.prepare(`SELECT language, COUNT(*) as n FROM users GROUP BY language`).all();

    // Daily new users for last 14 days
    const dailyNew = db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as n FROM users
      WHERE created_at > datetime('now', '-14 days')
      GROUP BY day ORDER BY day
    `).all();

    // Daily revenue last 14 days
    const dailyRevenue = db.prepare(`
      SELECT date(created_at) as day, SUM(amount) as total FROM payments
      WHERE status='confirmed' AND created_at > datetime('now', '-14 days')
      GROUP BY day ORDER BY day
    `).all();

    const storage = this.db.getStorageStats();

    return {
      users: { total: totalUsers, active: activeUsers, paid: paidUsers, newToday, newWeek, newMonth },
      revenue: {
        total: revenueTotal,
        last30days: revenue30,
        byCurrencyTotal: revenueTotalByCurrency,
        byCurrency30days: revenue30ByCurrency,
      },
      planDist,
      langDist,
      dailyNew,
      dailyRevenue,
      storage,
    };
  }

  _getPlans() {
    // Explicit order: free → test → pro → admin
    return this.db.db.prepare(`
      SELECT * FROM plans
      ORDER BY CASE name
        WHEN 'free'  THEN 1
        WHEN 'test'  THEN 2
        WHEN 'pro'   THEN 3
        WHEN 'admin' THEN 4
        ELSE 99
      END
    `).all();
  }

  _updatePlan(id, fields) {
    const allowed = ['price_usd', 'alert_limit', 'history_days', 'max_sources'];
    const sets = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([k]) => `${k}=?`);
    const vals = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([,v]) => v);
    if (!sets.length) return;
    this.db.db.prepare(`UPDATE plans SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
  }

  _getFeedbackConfig() {
    return {
      enabled:     this.db.getSetting('feedbackWeightingEnabled', '1') !== '0',
      weightAdmin: parseFloat(this.db.getSetting('feedbackWeightAdmin', '3') || '3'),
      weightPro:   parseFloat(this.db.getSetting('feedbackWeightPro',   '2') || '2'),
      weightTest:  parseFloat(this.db.getSetting('feedbackWeightTest',  '1') || '1'),
      weightFree:  parseFloat(this.db.getSetting('feedbackWeightFree',  '1') || '1'),
    };
  }

  _setFeedbackConfig({ enabled, weightAdmin, weightPro, weightTest, weightFree }) {
    if (enabled !== undefined) this.db.setSetting('feedbackWeightingEnabled', enabled ? '1' : '0');
    if (weightAdmin !== undefined) this.db.setSetting('feedbackWeightAdmin', String(parseFloat(weightAdmin) || 1));
    if (weightPro   !== undefined) this.db.setSetting('feedbackWeightPro',   String(parseFloat(weightPro)   || 1));
    if (weightTest  !== undefined) this.db.setSetting('feedbackWeightTest',  String(parseFloat(weightTest)  || 1));
    if (weightFree  !== undefined) this.db.setSetting('feedbackWeightFree',  String(parseFloat(weightFree)  || 1));
  }

  _getScannerConfig() {
    // Int settings — thresholds + legacy gates (kept for back-compat)
    const numDefaults = {
      alertThreshold: 60, viralityThreshold: 70, minScoreToSave: 0, maxAlertsPerCycle: 0,
      alertHardJunkStop: 70,
      alertStaleDecayPerHour: 2,
      alertStaleDecayGrace:   24,
      alertStaleDecayCap:     30,
      // AI Stage 2 gates — tune in UI to balance x_search cost vs coverage
      stage2Threshold: 60,
      stage2MaxCalls:  6,
    };
    const merged = {};
    for (const [k, v] of Object.entries(numDefaults)) {
      const s = this.db.getSetting(k);
      merged[k] = (s !== undefined && s !== null && s !== '') ? Number(s) : v;
    }
    merged.activePreset = this.db.getSetting('activePreset', 'general') || 'general';
    // Which Twitter/X scraper is active (maps to an actor in src/collectors/twitter.js)
    merged.twitterActor = (this.db.getSetting('twitterActor', 'kaitoeasyapi') || 'kaitoeasyapi').toLowerCase();

    // Float settings — alertScore component weights
    const floatDefaults = {
      alertWeightMemePotential: 0.35,
      alertWeightVirality:      0.25,
      alertWeightEmergence:     0.20,
      alertWeightTwitter:       0.10,
      alertWeightFeedback:      0.10,
      alertWeightJunk:          0.50,
    };
    for (const [k, v] of Object.entries(floatDefaults)) {
      const s = this.db.getSetting(k);
      merged[k] = (s !== undefined && s !== null && s !== '') ? Number(s) : v;
    }
    return merged;
  }

  _setScannerConfig(body) {
    const VALID_PRESETS = new Set(['general', 'animals', 'culture', 'celebrities', 'events']);
    if ('activePreset' in body) {
      if (!VALID_PRESETS.has(body.activePreset)) throw new Error('Invalid preset');
      this.db.setSetting('activePreset', body.activePreset);
    }
    // Twitter/X scraper actor — must match keys in src/collectors/twitter.js ACTORS.
    // When adding a new actor there, also extend this set.
    const VALID_TWITTER_ACTORS = new Set(['kaitoeasyapi', 'xquik']);
    if ('twitterActor' in body) {
      const a = String(body.twitterActor || '').toLowerCase();
      if (!VALID_TWITTER_ACTORS.has(a)) throw new Error('Invalid twitterActor');
      this.db.setSetting('twitterActor', a);
    }
    const allowedInt = {
      alertThreshold:    { min: 0, max: 100 },
      viralityThreshold: { min: 0, max: 100 },
      minScoreToSave:    { min: 0, max: 100 },
      maxAlertsPerCycle: { min: 0, max: 50  },
      alertHardJunkStop: { min: 0, max: 100 },
      alertStaleDecayPerHour: { min: 0, max: 20 },
      alertStaleDecayGrace:   { min: 0, max: 168 },
      alertStaleDecayCap:     { min: 0, max: 100 },
      stage2Threshold:        { min: 0, max: 100 },
      stage2MaxCalls:         { min: 0, max: 20  },
    };
    for (const [key, rules] of Object.entries(allowedInt)) {
      if (!(key in body)) continue;
      const val = Number(body[key]);
      if (isNaN(val) || val < rules.min || val > rules.max) {
        throw new Error(`${key}: must be ${rules.min}-${rules.max}`);
      }
      this.db.setSetting(key, Math.round(val));
    }
    const allowedFloat = {
      alertWeightMemePotential: { min: 0, max: 2 },
      alertWeightVirality:      { min: 0, max: 2 },
      alertWeightEmergence:     { min: 0, max: 2 },
      alertWeightTwitter:       { min: 0, max: 2 },
      alertWeightFeedback:      { min: 0, max: 2 },
      alertWeightJunk:          { min: 0, max: 3 },
    };
    // Collect float writes, validate per-field ranges, then enforce the
    // "sum of positive weights ≤ 1.0" invariant BEFORE committing anything.
    const pendingFloats = {};
    for (const [key, rules] of Object.entries(allowedFloat)) {
      if (!(key in body)) continue;
      const val = Number(body[key]);
      if (isNaN(val) || val < rules.min || val > rules.max) {
        throw new Error(`${key}: must be ${rules.min}-${rules.max}`);
      }
      pendingFloats[key] = val;
    }

    const POSITIVE = ['alertWeightMemePotential','alertWeightVirality','alertWeightEmergence','alertWeightTwitter','alertWeightFeedback'];
    const defaults = { alertWeightMemePotential:0.35, alertWeightVirality:0.25, alertWeightEmergence:0.20, alertWeightTwitter:0.10, alertWeightFeedback:0.10 };
    const effective = (k) => {
      if (k in pendingFloats) return pendingFloats[k];
      const stored = this.db.getSetting(k);
      return (stored !== undefined && stored !== null && stored !== '') ? Number(stored) : defaults[k];
    };
    const sum = POSITIVE.reduce((s, k) => s + (Number(effective(k)) || 0), 0);
    if (sum > 1.0001) {
      throw new Error(`sum of positive weights would be ${sum.toFixed(2)} > 1.00 — reduce other weights first`);
    }

    // Passed validation — now commit
    for (const [key, val] of Object.entries(pendingFloats)) {
      this.db.setSetting(key, String(val));
    }
  }

  // ── Filter profiles (per-preset junk-filter tuning) ─────────────────────────
  // Returns the full effective table (defaults merged with overrides) plus the
  // raw overrides blob + field metadata, so the UI can render inputs + reset.
  _getFilterProfiles() {
    let overrides = {};
    const raw = this.db.getSetting('filterProfiles', null);
    if (raw) {
      try { overrides = JSON.parse(raw) || {}; }
      catch (_) { overrides = {}; }
    }
    return {
      defaults:  FILTER_PROFILES,
      effective: getEffectiveProfiles(overrides),
      overrides,                       // what's actually stored (sparse)
      fields:    PROFILE_FIELD_RANGES, // { field: {min,max,step,label,desc} }
      presets:   PRESET_KEYS,
    };
  }

  _setFilterProfiles(body) {
    const cleaned = validateProfileOverrides(body?.overrides);
    // Empty blob → delete the setting to avoid confusing "stored but empty" state
    if (Object.keys(cleaned).length === 0) {
      this.db.setSetting('filterProfiles', '');
    } else {
      this.db.setSetting('filterProfiles', JSON.stringify(cleaned));
    }
  }

  _getAiConfig() {
    const provider = (this.db.getSetting('aiProvider', 'xai') || 'xai').toLowerCase();
    const xaiModel = this.db.getSetting('xaiModel', process.env.XAI_MODEL || 'grok-4-1-fast-non-reasoning');
    const openaiModel = this.db.getSetting('openaiModel', process.env.OPENAI_MODEL || 'gpt-4.1-mini');
    const stage2Enabled = String(this.db.getSetting('aiStage2Enabled', '1')) !== '0';
    const currentModel = provider === 'openai' ? openaiModel : xaiModel;

    return {
      provider: ['xai', 'openai'].includes(provider) ? provider : 'xai',
      model: currentModel,
      xaiModel,
      openaiModel,
      stage2Enabled,
      hasXaiKey: !!process.env.XAI_API_KEY,
      hasOpenaiKey: !!process.env.OPENAI_API_KEY,
      xaiBaseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
      openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    };
  }

  _setAiConfig({ provider, model, stage2Enabled }) {
    const safeProvider = String(provider || '').toLowerCase();
    if (!['xai', 'openai'].includes(safeProvider)) {
      throw new Error('Invalid AI provider');
    }
    this.db.setSetting('aiProvider', safeProvider);

    const cleanModel = String(model || '').trim();
    if (cleanModel.length > 0) {
      const modelKey = safeProvider === 'openai' ? 'openaiModel' : 'xaiModel';
      this.db.setSetting(modelKey, cleanModel);
    }

    if (stage2Enabled !== undefined) {
      const raw = stage2Enabled;
      const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
      this.db.setSetting('aiStage2Enabled', enabled ? '1' : '0');
    }
  }

  async _fetchProviderModels(provider) {
    const p = String(provider || '').toLowerCase();
    if (!['xai', 'openai'].includes(p)) throw new Error('Invalid provider');

    // Curated model sets for cleaner admin UX
    const curated = {
      xai: [
        'grok-4-1-fast-non-reasoning',
        'grok-4-fast-non-reasoning',
        'grok-4.20-0309-non-reasoning',
        'grok-3-mini',
      ],
      openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o', 'gpt-5-mini', 'gpt-5'],
    };

    const apiKey = p === 'openai' ? process.env.OPENAI_API_KEY : process.env.XAI_API_KEY;
    const baseUrl = p === 'openai'
      ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
      : (process.env.XAI_BASE_URL || 'https://api.x.ai/v1');

    if (!apiKey) return { provider: p, models: curated[p], error: 'API key is not configured' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text();
        // For xAI quota/rate issues, keep UI usable with curated fallback list.
        if (p === 'xai' && (res.status === 429 || res.status === 402)) {
          return { provider: p, models: curated[p] };
        }
        return { provider: p, models: curated[p], error: `HTTP ${res.status}: ${txt.slice(0, 120)}` };
      }

      const payload = await res.json();
      const available = Array.isArray(payload?.data)
        ? payload.data.map(m => m.id).filter(Boolean).sort((a, b) => a.localeCompare(b))
        : [];

      // xAI: keep only Grok models, but not the whole list
      const providerTop = p === 'xai'
        ? available.filter(m => m.startsWith('grok-') && m !== 'grok-4-1').slice(0, 12)
        : curated[p].filter(m => available.includes(m));

      let models;
      if (p === 'xai') {
        const merged = [...providerTop, ...curated[p]];
        models = [...new Set(merged)];
      } else {
        models = providerTop.length > 0 ? providerTop : curated[p];
      }
      return { provider: p, models };
    } catch (e) {
      if (p === 'xai') {
        return { provider: p, models: curated[p] };
      }
      return { provider: p, models: curated[p], error: e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  _setUserPlan(userId, planName, days = 30) {
    const plan = this.db.db.prepare(`SELECT id, name FROM plans WHERE name = ?`).get(planName);
    if (!plan) throw new Error(`Plan not found: ${planName}`);

    if (plan.name === 'free' || plan.name === 'admin') {
      // Free and Admin plans have no expiry
      this.db.db.prepare(`
        UPDATE users
        SET plan_id = ?, subscription_expires_at = NULL, status = 'active'
        WHERE id = ?
      `).run(plan.id, userId);
      return;
    }

    this.db.upgradePlan(userId, plan.name, days);
  }

  async _broadcast(message, planFilter) {
    let q = `
      SELECT u.id, u.telegram_chat_id, u.pinned_broadcast_message_id
      FROM users u
      JOIN plans p ON u.plan_id=p.id
      WHERE u.status='active'
    `;
    const params = [];
    if (planFilter && planFilter !== 'all') { q += ` AND p.name=?`; params.push(planFilter); }
    const users = this.db.db.prepare(q).all(...params);
    const broadcastId = this.db.createBroadcast(message, planFilter || 'all');
    let sent = 0, failed = 0;
    for (const u of users) {
      try {
        const sentMsg = await this.bot.sendMessage(u.telegram_chat_id, message, { parse_mode: 'HTML' });

        if (u.pinned_broadcast_message_id) {
          try {
            await this.bot.unpinChatMessage(u.telegram_chat_id, {
              message_id: u.pinned_broadcast_message_id,
            });
          } catch {
            // Old pin may already be gone or unpinnable — ignore
          }
        }

        try {
          await this.bot.pinChatMessage(u.telegram_chat_id, sentMsg.message_id, {
            disable_notification: true,
          });
          this.db.db.prepare(`
            UPDATE users
            SET pinned_broadcast_message_id = ?
            WHERE id = ?
          `).run(sentMsg.message_id, u.id);
        } catch {
          // If pin fails (no rights / private settings), keep broadcast sent
        }

        try {
          this.db.addBroadcastDelivery(broadcastId, u.id, u.telegram_chat_id, sentMsg.message_id, 'sent');
        } catch (e) {
          this.logger.warn(`Failed to record broadcast delivery: ${e.message}`);
        }

        sent++;
        await new Promise(r => setTimeout(r, 50)); // rate limit
      } catch { failed++; }
    }
    this.db.finalizeBroadcast(broadcastId, sent, failed);
    return { sent, failed, total: users.length, broadcastId };
  }

  async _manageBroadcastById(broadcastId, action, message = '') {
    const bc = this.db.getBroadcastById(broadcastId);
    if (!bc) throw new Error('Broadcast not found');

    const deliveries = this.db.getBroadcastDeliveries(broadcastId);
    let success = 0;
    let failed = 0;

    for (const d of deliveries) {
      try {
        if (action === 'edit') {
          await this.bot.editMessageText(message, {
            chat_id: d.chat_id,
            message_id: d.message_id,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
          this.db.updateBroadcastDeliveryStatus(broadcastId, d.user_id, 'edited');
        } else if (action === 'unpin') {
          await this.bot.unpinChatMessage(d.chat_id, { message_id: d.message_id });
          this.db.updateBroadcastDeliveryStatus(broadcastId, d.user_id, 'unpinned');
        } else if (action === 'delete') {
          await this.bot.deleteMessage(d.chat_id, d.message_id);
          this.db.updateBroadcastDeliveryStatus(broadcastId, d.user_id, 'deleted');
        }

        if (action === 'delete') {
          this.db.db.prepare(`
            UPDATE users
            SET pinned_broadcast_message_id = NULL
            WHERE id = ? AND pinned_broadcast_message_id = ?
          `).run(d.user_id, d.message_id);
        }

        success++;
      } catch {
        if (action === 'delete') {
          this.db.db.prepare(`
            UPDATE users
            SET pinned_broadcast_message_id = NULL
            WHERE id = ? AND pinned_broadcast_message_id = ?
          `).run(d.user_id, d.message_id);
        }
        failed++;
      }

      await new Promise(r => setTimeout(r, 50));
    }

    if (action === 'edit') {
      this.db.updateBroadcastMessage(broadcastId, message);
    }

    return { ok: true, action, success, failed, total: deliveries.length, broadcastId };
  }

  async _manageBroadcastMessages(action, message = '', planFilter = 'all') {
    let q = `
      SELECT u.id, u.telegram_chat_id, u.pinned_broadcast_message_id
      FROM users u
      JOIN plans p ON u.plan_id=p.id
      WHERE u.pinned_broadcast_message_id IS NOT NULL
    `;
    const params = [];
    if (planFilter && planFilter !== 'all') { q += ` AND p.name=?`; params.push(planFilter); }
    const users = this.db.db.prepare(q).all(...params);

    let success = 0;
    let failed = 0;

    for (const u of users) {
      const msgId = u.pinned_broadcast_message_id;
      try {
        if (action === 'edit') {
          await this.bot.editMessageText(message, {
            chat_id: u.telegram_chat_id,
            message_id: msgId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
        } else if (action === 'unpin') {
          await this.bot.unpinChatMessage(u.telegram_chat_id, { message_id: msgId });
        } else if (action === 'delete') {
          await this.bot.deleteMessage(u.telegram_chat_id, msgId);
          this.db.db.prepare(`
            UPDATE users SET pinned_broadcast_message_id = NULL WHERE id = ?
          `).run(u.id);
        }

        success++;
      } catch {
        if (action === 'delete') {
          // Message may already be missing; clear stale pointer anyway
          this.db.db.prepare(`
            UPDATE users SET pinned_broadcast_message_id = NULL WHERE id = ?
          `).run(u.id);
        }
        failed++;
      }

      await new Promise(r => setTimeout(r, 50));
    }

    return { ok: true, action, success, failed, total: users.length };
  }

  // ── Request Router ──────────────────────────────────────────────────────────
  async _handle(req, res) {
    const url = new URL('http://x' + req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key' });
      return res.end();
    }

    // Health check — no auth
    if (path === '/api/health') return json(res, 200, { ok: true, service: 'admin', port: this.port });

    // Serve SPA for all non-API routes
    if (!path.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(this._spa());
    }

    // Auth check for all API routes
    if (!this._auth(req)) return json(res, 401, { error: 'Unauthorized' });

    try {
      // ── Users ──
      if (path === '/api/users' && method === 'GET') {
        const s = url.searchParams;
        return json(res, 200, this._getAllUsers(s.get('search') || '', s.get('plan') || '', s.get('status') || ''));
      }

      if (path.match(/^\/api\/users\/(\d+)$/) && method === 'PUT') {
        const id = parseInt(path.split('/')[3]);
        const body = await parseBody(req);
        const allowed = ['status', 'plan_id', 'subscription_expires_at', 'alert_threshold'];
        for (const [k, v] of Object.entries(body)) {
          if (allowed.includes(k)) this.db.updateUser(id, k, v);
        }
        return json(res, 200, { ok: true });
      }

      if (path.match(/^\/api\/users\/(\d+)\/extend$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        const { days = 30, plan = 'pro' } = await parseBody(req);
        this.db.upgradePlan(id, plan, days);
        return json(res, 200, { ok: true });
      }

      if (path.match(/^\/api\/users\/(\d+)\/subscription\/grant$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        const { plan = 'pro', days = 30 } = await parseBody(req);
        const safeDays = Math.max(1, Math.min(3650, parseInt(days, 10) || 30));
        this._setUserPlan(id, String(plan).toLowerCase(), safeDays);
        return json(res, 200, { ok: true });
      }

      if (path.match(/^\/api\/users\/(\d+)\/subscription\/revoke$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        this._setUserPlan(id, 'free', 0);
        return json(res, 200, { ok: true });
      }

      if (path.match(/^\/api\/users\/(\d+)\/status$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        const { status = 'active' } = await parseBody(req);
        const allowed = ['active', 'paused', 'blocked', 'suspended'];
        if (!allowed.includes(status)) return json(res, 400, { error: 'Invalid status' });
        this.db.updateUser(id, 'status', status);
        return json(res, 200, { ok: true });
      }

      if (path.match(/^\/api\/users\/(\d+)\/block$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        this.db.updateUser(id, 'status', 'blocked');
        return json(res, 200, { ok: true });
      }

      if (path.match(/^\/api\/users\/(\d+)\/unblock$/) && method === 'POST') {
        const id = parseInt(path.split('/')[3]);
        this.db.updateUser(id, 'status', 'active');
        return json(res, 200, { ok: true });
      }

      // ── Payments ──
      if (path === '/api/payments' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        return json(res, 200, this._getPayments(limit, offset));
      }

      if (path.match(/^\/api\/payments\/(\d+)$/) && method === 'DELETE') {
        const id = parseInt(path.split('/')[3]);
        this.db.db.prepare('DELETE FROM payments WHERE id = ?').run(id);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/payments/cleanup' && method === 'POST') {
        this.db.db.prepare(`
          DELETE FROM payments
          WHERE status IN ('pending', 'expired')
            AND COALESCE(datetime(expires_at), expires_at) < datetime('now')
        `).run();
        return json(res, 200, { ok: true });
      }

      if (path === '/api/alerts/cleanup' && method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const days = Math.max(1, Math.min(365, Number(body.days || 30)));
        const result = this.db.cleanupAlerts(days);
        return json(res, 200, { ok: true, ...result });
      }

      // ── Stats ──
      if (path === '/api/stats' && method === 'GET') {
        return json(res, 200, this._getStats());
      }

      // ── Plans ──
      if (path === '/api/plans' && method === 'GET') {
        return json(res, 200, this._getPlans());
      }

      if (path.match(/^\/api\/plans\/(\d+)$/) && method === 'PUT') {
        const id = parseInt(path.split('/')[3]);
        const body = await parseBody(req);
        this._updatePlan(id, body);
        return json(res, 200, { ok: true });
      }

      // ── Feedback Config ──
      if (path === '/api/feedback-config' && method === 'GET') {
        return json(res, 200, this._getFeedbackConfig());
      }

      if (path === '/api/feedback-config' && method === 'POST') {
        const body = await parseBody(req);
        this._setFeedbackConfig(body);
        return json(res, 200, { ok: true, ...this._getFeedbackConfig() });
      }

      // ── AI Config ──
      if (path === '/api/ai-config' && method === 'GET') {
        return json(res, 200, this._getAiConfig());
      }

      if (path === '/api/ai-config' && method === 'POST') {
        const body = await parseBody(req);
        this._setAiConfig(body);
        return json(res, 200, { ok: true, ...this._getAiConfig() });
      }

      // ── Force scan trigger ──
      if (path === '/api/scan' && method === 'POST') {
        if (this.appState?.paused) {
          return json(res, 409, { error: 'Scanner is paused. Resume it first.' });
        }
        if (this.appState?.scanRunning) {
          return json(res, 409, { error: 'Scan is already running. Try again in a moment.' });
        }
        if (typeof this.scanFn !== 'function') {
          return json(res, 503, { error: 'Scan function not available' });
        }
        this.logger.info('[Admin] Manual scan triggered');
        this.scanFn().catch(e => this.logger.error(`Manual scan error: ${e.message}`));
        return json(res, 202, { message: 'Scan triggered — check logs for progress' });
      }

      // ── Scanner Config (preset + alert thresholds + storage floor) ──
      if (path === '/api/scanner-config' && method === 'GET') {
        return json(res, 200, this._getScannerConfig());
      }
      if (path === '/api/scanner-config' && method === 'POST') {
        try {
          const body = await parseBody(req);
          this._setScannerConfig(body);
          return json(res, 200, { ok: true, ...this._getScannerConfig() });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      // ── Filter profiles — per-preset junk-filter weights ──
      if (path === '/api/filter-profiles' && method === 'GET') {
        return json(res, 200, this._getFilterProfiles());
      }
      if (path === '/api/filter-profiles' && method === 'POST') {
        try {
          const body = await parseBody(req);
          this._setFilterProfiles(body);
          return json(res, 200, { ok: true, ...this._getFilterProfiles() });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      // Alert decisions — per-trend verdicts from the last N cycles. In-memory
      // ring buffer on appState.alertDecisions, populated by index.js on every
      // alert-gate evaluation. Useful to answer "почему нет алертов".
      if (path === '/api/alert-decisions' && method === 'GET') {
        const limit  = Math.min(500, parseInt(url.searchParams.get('limit')  || '200', 10));
        const filter = (url.searchParams.get('filter') || 'all').toLowerCase(); // all | sent | skipped
        const reason = (url.searchParams.get('reason') || '').trim();
        const all = Array.isArray(this.appState?.alertDecisions) ? this.appState.alertDecisions : [];
        let items = all.slice().reverse(); // newest first
        if (filter === 'sent')    items = items.filter(d => d.decision === 'sent');
        if (filter === 'skipped') items = items.filter(d => d.decision === 'skipped');
        if (reason) items = items.filter(d => d.reason === reason);
        items = items.slice(0, limit);

        // Aggregate reason counts for a header summary
        const counts = {};
        for (const d of all) counts[d.reason] = (counts[d.reason] || 0) + 1;

        return json(res, 200, { total: all.length, counts, items });
      }

      if (path === '/api/ai-models' && method === 'GET') {
        const provider = (url.searchParams.get('provider') || '').toLowerCase();
        if (provider) {
          return json(res, 200, await this._fetchProviderModels(provider));
        }
        const [xai, openai] = await Promise.all([
          this._fetchProviderModels('xai'),
          this._fetchProviderModels('openai'),
        ]);
        return json(res, 200, { xai, openai });
      }

      // ── Broadcast ──
      if (path === '/api/broadcast' && method === 'POST') {
        const { message, plan = 'all' } = await parseBody(req);
        if (!message) return json(res, 400, { error: 'message required' });
        const result = await this._broadcast(message, plan);
        this.logger.info('Admin broadcast sent', result);
        return json(res, 200, result);
      }

      if (path === '/api/broadcasts' && method === 'GET') {
        const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '30')));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0'));
        return json(res, 200, this.db.getBroadcastHistory(limit, offset));
      }

      if (path.match(/^\/api\/broadcasts\/(\d+)\/manage$/) && method === 'POST') {
        const broadcastId = parseInt(path.split('/')[3]);
        const { action, message = '' } = await parseBody(req);
        if (!['edit', 'unpin', 'delete'].includes(action)) {
          return json(res, 400, { error: 'invalid action' });
        }
        if (action === 'edit' && !message.trim()) {
          return json(res, 400, { error: 'message required for edit' });
        }
        const result = await this._manageBroadcastById(broadcastId, action, message);
        this.logger.info('Admin broadcast history manage action', result);
        return json(res, 200, result);
      }

      if (path === '/api/broadcast/manage' && method === 'POST') {
        const { action, message = '', plan = 'all' } = await parseBody(req);
        if (!['edit', 'unpin', 'delete'].includes(action)) {
          return json(res, 400, { error: 'invalid action' });
        }
        if (action === 'edit' && !message.trim()) {
          return json(res, 400, { error: 'message required for edit' });
        }

        const result = await this._manageBroadcastMessages(action, message, plan);
        this.logger.info('Admin broadcast manage action', result);
        return json(res, 200, result);
      }

      // ── Scanners ──
      if (path === '/api/scanners' && method === 'GET') {
        const disabled = [...this.appState.disabledCollectors];
        return json(res, 200, {
          paused: this.appState.paused,
          collectors: [
            { name: 'reddit',       label: 'Reddit',        icon: '🟠', enabled: !disabled.includes('reddit') },
            { name: 'google_trends', label: 'Google Trends', icon: '🔍', enabled: !disabled.includes('google_trends') },
            { name: 'twitter',      label: 'Twitter / X',   icon: '🐦', enabled: !disabled.includes('twitter') },
            { name: 'tiktok',       label: 'TikTok',        icon: '🎵', enabled: !disabled.includes('tiktok') },
          ]
        });
      }

      if (path === '/api/scanners/pause' && method === 'POST') {
        this.appState.paused = true;
        this.logger.info('[Admin] Scanner paused');
        return json(res, 200, { paused: true });
      }

      if (path === '/api/scanners/resume' && method === 'POST') {
        this.appState.paused = false;
        this.logger.info('[Admin] Scanner resumed');
        return json(res, 200, { paused: false });
      }

      if (path.match(/^\/api\/scanners\/[\w]+\/toggle$/) && method === 'POST') {
        let name = path.split('/')[3].toLowerCase();
        if (name === 'googletrends') name = 'google_trends';
        const dc = this.appState.disabledCollectors;
        if (dc.has(name)) { dc.delete(name); this.logger.info(`[Admin] Collector enabled: ${name}`); }
        else              { dc.add(name);    this.logger.info(`[Admin] Collector disabled: ${name}`); }
        try {
          this.db.setSetting('disabledCollectors', JSON.stringify([...dc]));
        } catch (e) {
          this.logger.error(`[Admin] Failed to persist disabledCollectors: ${e.message}`);
        }
        return json(res, 200, { name, enabled: !dc.has(name) });
      }

      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      this.logger.error('Admin API error', { path, error: e.message });
      return json(res, 500, { error: e.message });
    }
  }

  // ── React SPA ───────────────────────────────────────────────────────────────
  _spa() {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catalyst Admin</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#091018;--bg2:#101a23;--bg3:#162330;--bg4:#1c2b3a;
  --accent:#14b8a6;--accent2:#0f766e;--green:#22c55e;--red:#f87171;
  --yellow:#f59e0b;--blue:#38bdf8;--text:#e5eef7;--text2:#97a8ba;--border:#233447;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:
linear-gradient(180deg,#081018 0%,#0a1320 100%);color:var(--text);min-height:100vh}
.layout{display:flex;min-height:100vh}
.sidebar{width:250px;background:linear-gradient(180deg,rgba(12,20,28,.98),rgba(11,18,26,.94));border-right:1px solid rgba(35,52,71,.9);padding:22px 0;flex-shrink:0;display:flex;flex-direction:column;backdrop-filter:blur(18px)}
.logo{padding:0 22px 22px;border-bottom:1px solid var(--border);margin-bottom:16px}
.logo h1{font-size:18px;font-weight:800;color:#fff;letter-spacing:-.3px}
.logo span{font-size:11px;color:var(--accent);letter-spacing:1.2px;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:10px;padding:11px 22px;cursor:pointer;font-size:14px;color:var(--text2);border-radius:0;transition:all .18s}
.nav-item:hover{background:rgba(255,255,255,.03);color:var(--text)}
.nav-item.active{background:linear-gradient(90deg,rgba(20,184,166,.18),transparent);color:#fff;border-left:3px solid var(--accent)}
.nav-item.active{padding-left:19px}
.nav-icon{font-size:16px;width:20px;text-align:center}
.main{flex:1;padding:22px 26px 28px;overflow-y:auto}
.main-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;padding:16px 18px;border:1px solid var(--border);border-radius:16px;background:rgba(16,26,35,.78);backdrop-filter:blur(16px)}
.main-topbar h2{font-size:20px;font-weight:800;letter-spacing:-.4px}
.main-topbar p{color:var(--text2);font-size:12px;margin-top:4px}
.topbar-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.shell-badge{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;border:1px solid rgba(20,184,166,.18);background:rgba(20,184,166,.08);font-size:11px;font-weight:700;color:#b8d6d3;text-transform:uppercase;letter-spacing:.7px}
.page-header{margin-bottom:22px}
.page-header h2{font-size:24px;font-weight:800;letter-spacing:-.5px}
.page-header p{color:var(--text2);font-size:13px;margin-top:5px;max-width:72ch;line-height:1.5}

/* Cards */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.01));border:1px solid var(--border);border-radius:16px;padding:18px;box-shadow:0 12px 32px rgba(0,0,0,.12)}
.card-label{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--text2);margin-bottom:8px;font-weight:700}
.card-value{font-size:28px;font-weight:800;letter-spacing:-.8px}
.card-sub{font-size:12px;color:var(--text2);margin-top:6px;line-height:1.4}
.card.green .card-value{color:var(--green)}
.card.purple .card-value{color:var(--accent)}
.card.yellow .card-value{color:var(--yellow)}
.card.blue .card-value{color:var(--blue)}
.stats-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.stats-bottom-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}
.info-list{display:flex;flex-direction:column;gap:10px}
.info-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(35,52,71,.7);font-size:12px}
.info-row strong{color:var(--text);font-size:12px}
.info-row span{color:var(--text2)}
.muted-note{font-size:12px;color:var(--text2);line-height:1.5}

/* Table */
.table-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.table-toolbar{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.search-input{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 12px;color:var(--text);font-size:13px;width:220px;outline:none}
.search-input:focus{border-color:var(--accent)}
select.filter{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;outline:none}
table{width:100%;border-collapse:collapse}
th{padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);border-bottom:1px solid var(--border);background:var(--bg3)}
td{padding:10px 12px;font-size:13px;border-bottom:1px solid rgba(45,45,74,.5)}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}

/* Badges */
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
.badge-active{background:rgba(16,185,129,.15);color:var(--green)}
.badge-blocked{background:rgba(239,68,68,.15);color:var(--red)}
.badge-free{background:rgba(148,163,184,.1);color:var(--text2)}
.badge-admin{background:rgba(239,68,68,.15);color:#f87171}
.badge-basic{background:rgba(59,130,246,.15);color:var(--blue)}
.badge-pro{background:rgba(124,58,237,.15);color:var(--accent)}
.badge-elite{background:rgba(245,158,11,.15);color:var(--yellow)}
.badge-pending{background:rgba(245,158,11,.1);color:var(--yellow)}
.badge-confirmed{background:rgba(16,185,129,.15);color:var(--green)}
.badge-expired{background:rgba(148,163,184,.1);color:var(--text2)}

/* Buttons */
.btn{padding:6px 12px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:500;transition:all .15s}
.btn-sm{padding:4px 9px;font-size:11px}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent2)}
.btn-danger{background:rgba(239,68,68,.2);color:var(--red);border:1px solid rgba(239,68,68,.3)}
.btn-danger:hover{background:rgba(239,68,68,.3)}
.btn-success{background:rgba(16,185,129,.2);color:var(--green);border:1px solid rgba(16,185,129,.3)}
.btn-success:hover{background:rgba(16,185,129,.3)}
.btn-ghost{background:var(--bg3);color:var(--text2);border:1px solid var(--border)}
.btn-ghost:hover{color:var(--text)}
.btn-row{display:flex;gap:6px}

/* Auth overlay */
.auth-overlay{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:999}
.auth-box{background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:36px;width:340px;text-align:center}
.auth-box h2{font-size:20px;margin-bottom:8px}
.auth-box p{color:var(--text2);font-size:13px;margin-bottom:24px}
.auth-input{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:14px;outline:none;margin-bottom:14px}
.auth-input:focus{border-color:var(--accent)}
.auth-err{color:var(--red);font-size:12px;margin-top:8px}

/* Charts */
.chart-bar-wrap{display:flex;align-items:flex-end;gap:4px;height:80px;margin:8px 0}
.chart-bar{flex:1;background:var(--accent);border-radius:3px 3px 0 0;opacity:.7;min-width:12px;transition:all .2s;cursor:pointer;position:relative}
.chart-bar:hover{opacity:1}
.chart-bar-label{font-size:9px;color:var(--text2);text-align:center;margin-top:3px}
.chart-wrap{background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.01));border:1px solid var(--border);border-radius:16px;padding:18px;margin-bottom:16px;box-shadow:0 12px 32px rgba(0,0,0,.12)}
.chart-title{font-size:13px;font-weight:700;margin-bottom:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.7px}

/* Broadcast */
.broadcast-box{background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.01));border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:20px;box-shadow:0 12px 32px rgba(0,0,0,.12)}
.broadcast-box h3{font-size:15px;font-weight:600;margin-bottom:14px}
textarea.msg-input{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:13px;outline:none;resize:vertical;min-height:100px;font-family:inherit}
textarea.msg-input:focus{border-color:var(--accent)}
.broadcast-footer{display:flex;gap:10px;align-items:center;margin-top:10px}

/* Plans table */
.plan-row{display:grid;grid-template-columns:120px 100px 100px 100px 1fr;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)}
.plan-row:last-child{border-bottom:none}
.plan-head{background:var(--bg3);font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)}
.plan-input{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-size:13px;outline:none;width:80px}
.plan-input:focus{border-color:var(--accent)}

/* Toggle switch */
.toggle-wrap{display:flex;align-items:center;gap:10px}
.toggle{position:relative;width:44px;height:24px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:#2d2d4a;border-radius:24px;cursor:pointer;transition:.25s}
.toggle-slider:before{content:'';position:absolute;height:18px;width:18px;left:3px;top:3px;background:#94a3b8;border-radius:50%;transition:.25s}
input:checked+.toggle-slider{background:var(--green)}
input:checked+.toggle-slider:before{transform:translateX(20px);background:#fff}
/* Collector cards grid */
.collector-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:24px}
.collector-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:14px;transition:border-color .2s}
.collector-card.enabled{border-color:rgba(16,185,129,.3)}
.collector-card.disabled{border-color:rgba(239,68,68,.2);opacity:.7}
.collector-icon{font-size:28px}
.collector-name{font-weight:600;font-size:15px}
.collector-status{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.collector-status.on{color:var(--green)}
.collector-status.off{color:var(--red)}
/* Global scanner status */
.scanner-status-bar{background:linear-gradient(135deg,rgba(20,184,166,.07),rgba(56,189,248,.04));border:1px solid rgba(20,184,166,.16);border-radius:16px;padding:20px 24px;margin-bottom:24px;display:flex;align-items:center;gap:20px;box-shadow:0 12px 32px rgba(0,0,0,.12)}
.scanner-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.scanner-dot.running{background:var(--green);box-shadow:0 0 8px var(--green)}
.scanner-dot.paused{background:var(--red);box-shadow:0 0 8px var(--red)}
.scanner-label{flex:1}
.scanner-label h3{font-size:16px;font-weight:700}
.scanner-label p{font-size:12px;color:var(--text2);margin-top:2px}
.mt16{margin-top:16px}
.loading{text-align:center;padding:40px;color:var(--text2)}
.empty{text-align:center;padding:40px;color:var(--text2);font-size:13px}
.pagination{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--border)}
.tag-en{background:rgba(59,130,246,.15);color:var(--blue);padding:1px 6px;border-radius:4px;font-size:11px}
.tag-ru{background:rgba(124,58,237,.15);color:var(--accent);padding:1px 6px;border-radius:4px;font-size:11px}
.sol-addr{font-family:monospace;font-size:11px;color:var(--text2)}
.success-msg{color:var(--green);font-size:12px}
.error-msg{color:var(--red);font-size:12px}
/* Scanner config (preset + alert/storage thresholds) */
.scfg-preset-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:4px}
.scfg-preset{padding:14px 14px 12px;border-radius:12px;background:var(--bg2);border:1px solid var(--border);cursor:pointer;transition:all .18s;display:flex;flex-direction:column;gap:4px;position:relative;overflow:hidden}
.scfg-preset:hover{border-color:rgba(20,184,166,.35);transform:translateY(-1px)}
.scfg-preset.active{border-color:var(--accent);background:linear-gradient(180deg,rgba(20,184,166,.14),rgba(20,184,166,.04));box-shadow:0 6px 20px rgba(20,184,166,.18)}
.scfg-preset-icon{font-size:22px;line-height:1}
.scfg-preset-label{font-size:13px;font-weight:600;color:var(--text)}
.scfg-preset-hint{font-size:11px;color:var(--text2);line-height:1.35}
.scfg-section{margin-top:22px;padding-top:18px;border-top:1px solid var(--border)}
.scfg-h4{font-size:14px;font-weight:600;margin-bottom:4px}
.scfg-desc{font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.45}
.scfg-row{margin-bottom:14px}
.scfg-row:last-child{margin-bottom:0}
.scfg-row-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:12px}
.scfg-label{color:var(--text);font-weight:500}
.scfg-val{color:var(--accent);font-weight:600;font-variant-numeric:tabular-nums}
.scfg-slider{width:100%;-webkit-appearance:none;appearance:none;height:6px;border-radius:3px;background:var(--bg3);outline:none;cursor:pointer}
.scfg-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer;border:2px solid #fff;box-shadow:0 2px 6px rgba(20,184,166,.4)}
.scfg-slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer;border:2px solid #fff;box-shadow:0 2px 6px rgba(20,184,166,.4)}
@media (max-width: 980px){
  .layout{flex-direction:column}
  .sidebar{width:100%;border-right:none;border-bottom:1px solid var(--border)}
  .main{padding:18px 14px 24px}
  .main-topbar{flex-direction:column;align-items:flex-start}
  .stats-grid,.stats-bottom-grid{grid-template-columns:1fr}
  .scanner-status-bar{flex-direction:column;align-items:flex-start}
}
</style>
</head>
<body>
<div id="root"></div>
<script>
const {useState,useEffect,useCallback,useMemo}=React;

// ── API ──────────────────────────────────────────────────────────────────────
const BASE = '';
let _apiKey = localStorage.getItem('adminKey') || '';

async function api(path, method='GET', body=null) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': _apiKey } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  if (r.status === 401) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'API error');
  return data;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function AuthOverlay({ onAuth }) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    _apiKey = key;
    try { await api('/api/stats'); localStorage.setItem('adminKey', key); onAuth(key); }
    catch (e) { setErr('Неверный ключ'); _apiKey = ''; }
  };
  return React.createElement('div',{className:'auth-overlay'},
    React.createElement('div',{className:'auth-box'},
      React.createElement('div',{style:{fontSize:32,marginBottom:12}},'🔐'),
      React.createElement('h2',null,'Catalyst Admin'),
      React.createElement('p',null,'Введите ADMIN_API_KEY для входа'),
      React.createElement('input',{className:'auth-input',type:'password',placeholder:'Admin API Key',value:key,onChange:e=>setKey(e.target.value),onKeyDown:e=>e.key==='Enter'&&submit()}),
      React.createElement('button',{className:'btn btn-primary',style:{width:'100%',padding:'10px'},onClick:submit},'Войти'),
      err&&React.createElement('div',{className:'auth-err'},err)
    )
  );
}

// ── Mini Bar Chart ─────────────────────────────────────────────────────────────
function BarChart({data, color='#7c3aed'}) {
  if (!data||!data.length) return React.createElement('div',{className:'empty'},'Нет данных');
  const max = Math.max(...data.map(d=>d.n||d.total||0), 1);
  return React.createElement('div',null,
    React.createElement('div',{className:'chart-bar-wrap'},
      data.map((d,i)=>React.createElement('div',{key:i,style:{display:'flex',flexDirection:'column',alignItems:'center',flex:1}},
        React.createElement('div',{className:'chart-bar',style:{height:Math.max(4,(d.n||d.total||0)/max*76)+'px',background:color}},null),
        React.createElement('div',{className:'chart-bar-label'},d.day?d.day.slice(5):d.n)
      ))
    )
  );
}

// ── Donut-like Pie ────────────────────────────────────────────────────────────
function PieLegend({data, colors}) {
  const total = data.reduce((s,d)=>s+(d.n||0),0)||1;
  return React.createElement('div',{style:{display:'flex',flexDirection:'column',gap:8}},
    data.map((d,i)=>React.createElement('div',{key:i,style:{display:'flex',alignItems:'center',gap:8}},
      React.createElement('div',{style:{width:10,height:10,borderRadius:2,background:colors[i%colors.length],flexShrink:0}}),
      React.createElement('span',{style:{fontSize:12,color:'var(--text2)',flex:1}},d.name),
      React.createElement('span',{style:{fontSize:12,fontWeight:600}},d.n),
      React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},Math.round(d.n/total*100)+'%')
    ))
  );
}

// ── Pages ─────────────────────────────────────────────────────────────────────

function UsersPage() {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [planF, setPlanF] = useState('');
  const [statusF, setStatusF] = useState('');
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers(await api('/api/users?search='+encodeURIComponent(search)+'&plan='+planF+'&status='+statusF)); }
    catch(e){ setMsg(e.message); }
    finally { setLoading(false); }
  }, [search, planF, statusF]);

  useEffect(()=>{ load(); }, [load]);

  useEffect(() => {
    const next = {};
    for (const u of users) {
      next[u.id] = {
        plan: u.plan_name || 'free',
        days: 30,
      };
    }
    setDraft(next);
  }, [users]);

  const action = async (url, method='POST', body=null) => {
    try { await api(url, method, body); setMsg('✓ Готово'); load(); setTimeout(()=>setMsg(''),2000); }
    catch(e){ setMsg('Ошибка: '+e.message); }
  };

  const setUserDraft = (userId, field, value) => {
    setDraft(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), [field]: value } }));
  };

  const grantSubscription = async (u) => {
    const d = draft[u.id] || { plan: u.plan_name || 'pro', days: 30 };
    const days = Math.max(1, Math.min(3650, parseInt(d.days, 10) || 30));
    await action('/api/users/' + u.id + '/subscription/grant', 'POST', { plan: d.plan, days });
  };

  const revokeSubscription = async (u) => {
    if (!window.confirm('Снять подписку и вернуть пользователя на Free?')) return;
    await action('/api/users/' + u.id + '/subscription/revoke', 'POST');
  };

  const toggleBan = async (u) => {
    const next = u.status === 'blocked' ? 'active' : 'blocked';
    await action('/api/users/' + u.id + '/status', 'POST', { status: next });
  };

  // SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" without timezone → force UTC
  const utcDate = dt => { if (!dt) return null; const s = dt.includes('Z')||dt.includes('+') ? dt : dt.replace(' ','T')+'Z'; return new Date(s); };
  const fmt   = dt => { const d = utcDate(dt); return d ? d.toLocaleDateString('ru') : '—'; };
  const fmtDt = dt => { const d = utcDate(dt); return d ? d.toLocaleString('ru',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; };
  const activeUsers = users.filter(u => (u.status || 'active') === 'active').length;
  const blockedUsers = users.filter(u => u.status === 'blocked').length;
  const paidUsers = users.filter(u => ['test','pro','admin'].includes(u.plan_name)).length;

  return React.createElement('div',null,
    React.createElement('div',{className:'page-header'},
      React.createElement('h2',null,'👥 Пользователи'),
      React.createElement('p',null,'Управление аккаунтами, планами и статусами')
    ),
    React.createElement('div',{className:'cards'},
      React.createElement('div',{className:'card purple'},React.createElement('div',{className:'card-label'},'В выборке'),React.createElement('div',{className:'card-value'},users.length),React.createElement('div',{className:'card-sub'},'С учётом текущих фильтров')),
      React.createElement('div',{className:'card green'},React.createElement('div',{className:'card-label'},'Active'),React.createElement('div',{className:'card-value'},activeUsers),React.createElement('div',{className:'card-sub'},'Пользователи без блокировки')),
      React.createElement('div',{className:'card yellow'},React.createElement('div',{className:'card-label'},'Paid / privileged'),React.createElement('div',{className:'card-value'},paidUsers),React.createElement('div',{className:'card-sub'},'Test, Pro и Admin')),
      React.createElement('div',{className:'card'},React.createElement('div',{className:'card-label'},'Blocked'),React.createElement('div',{className:'card-value'},blockedUsers),React.createElement('div',{className:'card-sub'},blockedUsers===0?'Блокировок нет':'Нужен manual review'))
    ),
    React.createElement('div',{className:'table-wrap'},
      React.createElement('div',{className:'table-toolbar'},
        React.createElement('input',{className:'search-input',placeholder:'🔍 Поиск по username или chat ID...',value:search,onChange:e=>setSearch(e.target.value)}),
        React.createElement('select',{className:'filter',value:planF,onChange:e=>setPlanF(e.target.value)},
          React.createElement('option',{value:''},'Все планы'),
          React.createElement('option',{value:'free'},'Free'),
          React.createElement('option',{value:'test'},'Test'),
          React.createElement('option',{value:'pro'},'Pro'),
          React.createElement('option',{value:'admin'},'Admin'),
        ),
        React.createElement('select',{className:'filter',value:statusF,onChange:e=>setStatusF(e.target.value)},
          React.createElement('option',{value:''},'Все статусы'),
          React.createElement('option',{value:'active'},'Active'),
          React.createElement('option',{value:'blocked'},'Blocked'),
        ),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:load},'↻ Обновить'),
        msg&&React.createElement('span',{className:msg.includes('Ошибка')?'error-msg':'success-msg'},msg)
      ),
      loading ? React.createElement('div',{className:'loading'},'Загрузка...') :
      users.length === 0 ? React.createElement('div',{className:'empty'},'Пользователи не найдены') :
      React.createElement('table',null,
        React.createElement('thead',null,React.createElement('tr',null,
          ...[['ID','40px'],['Chat ID',''],['Username',''],['Язык','60px'],['План',''],['Статус',''],['Подписка до',''],['Алерты','70px'],['Активность',''],['Управление','420px']].map(([h,w])=>
            React.createElement('th',{key:h,style:{width:w||'auto'}},h)
          )
        )),
        React.createElement('tbody',null,
          users.map(u=>React.createElement('tr',{key:u.id},
            React.createElement('td',null,React.createElement('span',{style:{color:'var(--text2)',fontSize:11}},'#'+u.id)),
            React.createElement('td',null,React.createElement('span',{className:'sol-addr'},u.telegram_chat_id)),
            React.createElement('td',null,u.telegram_username?'@'+u.telegram_username:React.createElement('span',{style:{color:'var(--text2)'}},'-')),
            React.createElement('td',null,React.createElement('span',{className:u.language==='ru'?'tag-ru':'tag-en'},u.language||'en')),
            React.createElement('td',null,React.createElement('span',{className:'badge badge-'+u.plan_name},u.plan_name)),
            React.createElement('td',null,React.createElement('span',{className:'badge badge-'+(u.status||'active')},u.status||'active')),
            React.createElement('td',null,React.createElement('span',{style:{fontSize:12}},fmt(u.subscription_expires_at))),
            React.createElement('td',null,React.createElement('span',{style:{fontSize:12}},u.alert_count_today||0)),
            React.createElement('td',null,React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},fmtDt(u.last_seen_at))),
            React.createElement('td',null,
              React.createElement('div',{className:'btn-row'},
                React.createElement('select',{
                  className:'filter',
                  style:{minWidth:100},
                  value:(draft[u.id]?.plan || u.plan_name || 'free'),
                  onChange:e=>setUserDraft(u.id,'plan',e.target.value)
                },
                  React.createElement('option',{value:'free'},'Free'),
                  React.createElement('option',{value:'test'},'Test'),
                  React.createElement('option',{value:'pro'},'Pro'),
                  React.createElement('option',{value:'admin'},'Admin'),
                ),
                React.createElement('input',{
                  className:'plan-input',
                  style:{width:74},
                  type:'number',
                  min:1,
                  max:3650,
                  value:(draft[u.id]?.days || 30),
                  onChange:e=>setUserDraft(u.id,'days',e.target.value)
                }),
                React.createElement('button',{className:'btn btn-primary btn-sm',onClick:()=>grantSubscription(u)},'Выдать'),
                React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>revokeSubscription(u)},'Снять'),
                u.status!=='blocked'
                  ? React.createElement('button',{className:'btn btn-danger btn-sm',onClick:()=>toggleBan(u)},'Бан')
                  : React.createElement('button',{className:'btn btn-success btn-sm',onClick:()=>toggleBan(u)},'Разбан')
              )
            )
          ))
        )
      )
    )
  );
}

function PaymentsPage() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [msg, setMsg] = useState('');
  const limit = 50;

  const load = useCallback(async()=>{
    setLoading(true);
    try { setPayments(await api('/api/payments?limit='+limit+'&offset='+offset)); }
    catch(e){ setMsg(e.message); }
    finally { setLoading(false); }
  }, [offset]);

  useEffect(()=>{ load(); },[load]);

  const removeRaw = async (id) => {
    if (!window.confirm('Точно удалить этот платеж?')) return;
    try { await api('/api/payments/'+id, 'DELETE'); load(); }
    catch(e){ setMsg(e.message); }
  };

  const cleanup = async () => {
    try { await api('/api/payments/cleanup', 'POST'); setMsg('Очищено'); load(); setTimeout(()=>setMsg(''), 2000); }
    catch(e){ setMsg(e.message); }
  };

  const cleanupAlerts = async () => {
    const raw = window.prompt('Удалить алерты старше скольких дней?', '30');
    if (raw === null) return;
    const days = Math.max(1, Math.min(365, parseInt(raw || '30', 10) || 30));
    try {
      const r = await api('/api/alerts/cleanup', 'POST', { days });
      setMsg('Алерты очищены: тренды ' + r.trendsDeleted + ', нотификации ' + r.notificationsDeleted);
      setTimeout(()=>setMsg(''), 4000);
    } catch(e){ setMsg(e.message); }
  };

  const utcDate2 = dt => { if (!dt) return null; const s = dt.includes('Z')||dt.includes('+') ? dt : dt.replace(' ','T')+'Z'; return new Date(s); };
  const fmtDt = dt => { const d = utcDate2(dt); return d ? d.toLocaleString('ru',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'; };
  const fmtMoney = (amount, currency) => {
    if (amount === null || amount === undefined) return '—';
    const c = (currency || 'SOL').toUpperCase();
    const decimals = c === 'SOL' ? 4 : 2;
    return parseFloat(amount).toFixed(decimals) + ' ' + c;
  };
  const confirmed = payments.filter(p => p.status === 'confirmed').length;
  const pending = payments.filter(p => p.status === 'pending').length;
  const expired = payments.filter(p => p.status === 'expired').length;

  return React.createElement('div',null,
    React.createElement('div',{className:'page-header'},
      React.createElement('h2',null,'💳 Платежи'),
      React.createElement('p',null,'История транзакций Solana Pay')
    ),
    React.createElement('div',{className:'cards'},
      React.createElement('div',{className:'card purple'},React.createElement('div',{className:'card-label'},'В выборке'),React.createElement('div',{className:'card-value'},payments.length),React.createElement('div',{className:'card-sub'},'Текущая страница журнала')),
      React.createElement('div',{className:'card green'},React.createElement('div',{className:'card-label'},'Confirmed'),React.createElement('div',{className:'card-value'},confirmed),React.createElement('div',{className:'card-sub'},'Успешно завершённые платежи')),
      React.createElement('div',{className:'card yellow'},React.createElement('div',{className:'card-label'},'Pending'),React.createElement('div',{className:'card-value'},pending),React.createElement('div',{className:'card-sub'},'Требуют завершения или истечения')),
      React.createElement('div',{className:'card'},React.createElement('div',{className:'card-label'},'Expired'),React.createElement('div',{className:'card-value'},expired),React.createElement('div',{className:'card-sub'},expired===0?'Хвост чистый':'Можно подчистить'))
    ),
    React.createElement('div',{className:'table-wrap'},
      React.createElement('div',{className:'table-toolbar'},
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:load},'↻ Обновить'),
        React.createElement('button',{className:'btn btn-danger btn-sm',onClick:cleanupAlerts},'🧹 Очистить алерты'),
        React.createElement('button',{className:'btn btn-danger btn-sm',onClick:cleanup},'🧹 Очистить истекшие'),
        React.createElement('span',{style:{fontSize:12,color:'var(--text2)'}},payments.length+' записей'),
        msg&&React.createElement('span',{className:'success-msg'},msg)
      ),
      loading ? React.createElement('div',{className:'loading'},'Загрузка...') :
      payments.length===0 ? React.createElement('div',{className:'empty'},'Платежей пока нет') :
      React.createElement('table',null,
        React.createElement('thead',null,React.createElement('tr',null,
          ...['ID','Пользователь','План','Сумма','Статус','Дата','TX',''].map(h=>React.createElement('th',{key:h},h))
        )),
        React.createElement('tbody',null,
          payments.map(p=>React.createElement('tr',{key:p.id},
            React.createElement('td',null,React.createElement('span',{style:{color:'var(--text2)',fontSize:11}},'#'+p.id)),
            React.createElement('td',null,p.telegram_username?'@'+p.telegram_username:React.createElement('span',{className:'sol-addr'},p.telegram_chat_id||'—')),
            React.createElement('td',null,React.createElement('span',{className:'badge badge-'+(p.plan_name||'free')},p.plan_name||'—')),
            React.createElement('td',null,React.createElement('span',{style:{fontWeight:600,color:'var(--green)'}},fmtMoney(p.amount, p.currency))),
            React.createElement('td',null,React.createElement('span',{className:'badge badge-'+(p.status||'pending')},p.status)),
            React.createElement('td',null,React.createElement('span',{style:{fontSize:12}},fmtDt(p.created_at))),
            React.createElement('td',null,p.tx_signature
              ? React.createElement('a',{href:'https://solscan.io/tx/'+p.tx_signature,target:'_blank',style:{color:'var(--blue)',fontSize:11}},p.tx_signature.slice(0,12)+'…')
              : React.createElement('span',{style:{color:'var(--text2)',fontSize:11}},'—')
            ),
            React.createElement('td',null,
              React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>removeRaw(p.id)},'❌')
            )
          ))
        )
      ),
      React.createElement('div',{className:'pagination'},
        React.createElement('button',{className:'btn btn-ghost btn-sm',disabled:offset===0,onClick:()=>setOffset(Math.max(0,offset-limit))},'← Назад'),
        React.createElement('span',{style:{fontSize:12,color:'var(--text2)',padding:'4px 8px'}},Math.floor(offset/limit)+1),
        React.createElement('button',{className:'btn btn-ghost btn-sm',disabled:payments.length<limit,onClick:()=>setOffset(offset+limit)},'Далее →')
      )
    )
  );
}

function ScannersPage() {
  const [state, setState] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState('');

  const load = React.useCallback(async () => {
    try { setState(await api('/api/scanners')); }
    catch(e) { setMsg('Ошибка: ' + e.message); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  const toggleGlobal = async () => {
    try {
      const endpoint = state.paused ? '/api/scanners/resume' : '/api/scanners/pause';
      await api(endpoint, 'POST');
      setState(prev => ({ ...prev, paused: !prev.paused }));
      flash(state.paused ? '✓ Сканер запущен' : '✓ Сканер остановлен');
    } catch(e) { flash('Ошибка: ' + e.message); }
  };

  const [scanning, setScanning] = React.useState(false);
  const forceScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await api('/api/scan', 'POST');
      flash('⚡ Сканирование запущено');
    } catch(e) { flash('Ошибка: ' + e.message); }
    setTimeout(() => setScanning(false), 8000);
  };

  const toggleCollector = async (name) => {
    try {
      await api('/api/scanners/' + name + '/toggle', 'POST');
      setState(prev => ({
        ...prev,
        collectors: prev.collectors.map(c =>
          c.name === name ? { ...c, enabled: !c.enabled } : c
        )
      }));
    } catch(e) { flash('Ошибка: ' + e.message); }
  };

  if (loading) return React.createElement('div', { className: 'loading' }, 'Загрузка...');

  const paused = state?.paused;
  const collectors = state?.collectors || [];
  const enabledCount = collectors.filter(c => c.enabled).length;
  const disabledCount = collectors.length - enabledCount;

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header' },
      React.createElement('h2', null, '⚙️ Сканеры'),
      React.createElement('p', null, 'Здесь управляется сам heartbeat системы: глобальная пауза и отдельные площадки. Экран нужен для быстрых операционных действий, когда нужно отключить шумный источник или остановить весь пайплайн.')
    ),

    React.createElement('div', { className: 'cards' },
      React.createElement('div', { className: 'card green' },
        React.createElement('div', { className: 'card-label' }, 'Статус пайплайна'),
        React.createElement('div', { className: 'card-value' }, paused ? 'PAUSE' : 'LIVE'),
        React.createElement('div', { className: 'card-sub' }, paused ? 'Сбор данных и алерты остановлены' : 'Сканирование идёт по расписанию')
      ),
      React.createElement('div', { className: 'card blue' },
        React.createElement('div', { className: 'card-label' }, 'Включённых источников'),
        React.createElement('div', { className: 'card-value' }, enabledCount),
        React.createElement('div', { className: 'card-sub' }, 'Из ' + collectors.length + ' доступных площадок')
      ),
      React.createElement('div', { className: 'card yellow' },
        React.createElement('div', { className: 'card-label' }, 'Отключённых источников'),
        React.createElement('div', { className: 'card-value' }, disabledCount),
        React.createElement('div', { className: 'card-sub' }, disabledCount === 0 ? 'Все источники активны' : 'Есть площадки в ручном off режиме')
      )
    ),

    // Global scanner status bar
    React.createElement('div', { className: 'scanner-status-bar' },
      React.createElement('div', { className: 'scanner-dot ' + (paused ? 'paused' : 'running') }),
      React.createElement('div', { className: 'scanner-label' },
        React.createElement('h3', null, paused ? '⏸ Сканер остановлен' : '▶ Сканер работает'),
        React.createElement('p', null, paused
          ? 'Сбор данных приостановлен. Данные не собираются, алерты не отправляются.'
          : 'Данные собираются по расписанию. Алерты отправляются активным пользователям.')
      ),
      React.createElement('div', { style: { display: 'flex', gap: 10 } },
        React.createElement('button', {
          className: 'btn btn-primary',
          style: { padding: '10px 22px', fontSize: 14 },
          onClick: forceScan,
          disabled: scanning || paused,
          title: paused ? 'Сначала запусти сканер' : 'Принудительно запустить цикл сканирования'
        }, scanning ? '⏳ Сканирую...' : '⚡ Сканировать сейчас'),
        React.createElement('button', {
          className: 'btn ' + (paused ? 'btn-success' : 'btn-danger'),
          style: { padding: '10px 22px', fontSize: 14 },
          onClick: toggleGlobal
        }, paused ? '▶ Запустить' : '⏸ Остановить'),
      ),
    ),

    msg && React.createElement('div', {
      style: { marginBottom: 16, padding: '10px 14px', borderRadius: 8,
        background: msg.includes('Ошибка') ? 'rgba(239,68,68,.1)' : 'rgba(16,185,129,.1)',
        color: msg.includes('Ошибка') ? 'var(--red)' : 'var(--green)', fontSize: 13 }
    }, msg),

    // Scanner tuning config (presets, thresholds, storage floor)
    React.createElement(ScannerConfigSection, null),

    // Per-preset junk-filter weights (politics/kpop/celeb/meme-shape/safe-override)
    React.createElement(FilterProfilesSection, null),

    // Per-platform collector cards
    React.createElement('div', { className: 'broadcast-box' },
      React.createElement('h3', { style: { marginBottom: 16 } }, '📡 Площадки'),
      React.createElement('div', { className: 'collector-grid' },
        (state?.collectors || []).map(c =>
          React.createElement('div', {
            key: c.name,
            className: 'collector-card ' + (c.enabled ? 'enabled' : 'disabled')
          },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
              React.createElement('div', null,
                React.createElement('div', { className: 'collector-icon' }, c.icon),
                React.createElement('div', { className: 'collector-name', style: { marginTop: 8 } }, c.label)
              ),
              React.createElement('label', { className: 'toggle' },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: c.enabled,
                  onChange: () => toggleCollector(c.name)
                }),
                React.createElement('span', { className: 'toggle-slider' })
              )
            ),
            React.createElement('div', { className: 'collector-status ' + (c.enabled ? 'on' : 'off') },
              c.enabled ? '● Активен' : '○ Отключён'
            )
          )
        )
      )
    )
  );
}

// ── Scanner tuning: search preset + alert/storage thresholds ─────────────────
function ScannerConfigSection() {
  const h = React.createElement;
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api('/api/scanner-config').then(c => setCfg(c)).catch(e => setMsg('Ошибка: ' + e.message));
  }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  const set = (k, v) => setCfg(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api('/api/scanner-config', 'POST', cfg);
      setCfg(res);
      flash('✓ Конфиг сохранён');
    } catch (e) { flash('Ошибка: ' + e.message); }
    setSaving(false);
  };

  if (!cfg) return h('div', { className: 'broadcast-box', style: { marginBottom: 20 } },
    h('div', { className: 'loading' }, 'Загрузка конфига сканера...')
  );

  const PRESETS = [
    { id: 'general',     icon: '🌐', label: 'Общий',        hint: 'Ультра-широкий поиск на всех языках' },
    { id: 'animals',     icon: '🐾', label: 'Животные',     hint: 'Вирусные питомцы, милые создания' },
    { id: 'culture',     icon: '🎭', label: 'Культура',     hint: 'Мемы, интернет-тренды, сленг' },
    { id: 'celebrities', icon: '⭐', label: 'Знаменитости', hint: 'Селебрити, музыка, кино' },
    { id: 'events',      icon: '🌍', label: 'События',      hint: 'Мировые события, спорт, AI-новости' },
  ];

  // Twitter/X scraper actors. The id must match a key in
  // src/collectors/twitter.js ACTORS + VALID_TWITTER_ACTORS in _setScannerConfig.
  const TWITTER_ACTORS = [
    {
      id: 'kaitoeasyapi',
      icon: '🏯',
      label: 'KaitoEasyAPI',
      price: '$0.25 / 1K',
      hint: 'Зрелый, 17K юзеров, 99% success. Рекомендуется по умолчанию.',
    },
    {
      id: 'xquik',
      icon: '⚡',
      label: 'Xquik',
      price: '$0.15 / 1K',
      hint: 'Новый, 1 актёр, 145 юзеров. Дешевле, но меньше истории — экспериментальный.',
    },
  ];

  const row = (label, key, min, max, step, disp) => h('div', { className: 'scfg-row' },
    h('div', { className: 'scfg-row-top' },
      h('span', { className: 'scfg-label' }, label),
      h('span', { className: 'scfg-val' }, disp !== undefined ? disp : cfg[key])
    ),
    h('input', {
      type: 'range', min, max, step,
      value: cfg[key],
      onChange: e => set(key, +e.target.value),
      className: 'scfg-slider'
    })
  );

  return h('div', { className: 'broadcast-box', style: { marginBottom: 20 } },
    h('h3', { style: { marginBottom: 6 } }, '🎯 Конфиг сканера'),
    h('p', { style: { color: 'var(--muted)', fontSize: 13, marginBottom: 18 } },
      'Пресет поиска + пороги для алертов/хранения. Применяется со следующего цикла сканера.'),

    // Preset grid
    h('div', { className: 'scfg-label', style: { marginBottom: 10 } }, 'Пресет поиска'),
    h('div', { className: 'scfg-preset-grid' },
      PRESETS.map(p => h('div', {
        key: p.id,
        className: 'scfg-preset' + (cfg.activePreset === p.id ? ' active' : ''),
        onClick: () => set('activePreset', p.id)
      },
        h('div', { className: 'scfg-preset-icon' }, p.icon),
        h('div', { className: 'scfg-preset-label' }, p.label),
        h('div', { className: 'scfg-preset-hint' }, p.hint)
      ))
    ),

    // Twitter/X scraper picker — applies on next scan cycle. Each actor has
    // its own Apify token in .env (APIFY_API_KAITO / APIFY_API_XQUIK).
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🐦 Twitter/X scraper'),
      h('p', { className: 'scfg-desc' },
        'Какой Apify-актёр будет скрейпить X. Переключение применяется со следующего цикла. ' +
        'Оба возвращают одинаковый формат (viewCount, likeCount, retweetCount) — переключать безопасно.'),
      h('div', { className: 'scfg-preset-grid' },
        TWITTER_ACTORS.map(a => h('div', {
          key: a.id,
          className: 'scfg-preset' + (cfg.twitterActor === a.id ? ' active' : ''),
          onClick: () => set('twitterActor', a.id),
        },
          h('div', { className: 'scfg-preset-icon' }, a.icon),
          h('div', { className: 'scfg-preset-label' },
            a.label,
            h('span', { style: { marginLeft: 6, fontSize: 11, color: 'var(--muted)', fontWeight: 400 } }, a.price)
          ),
          h('div', { className: 'scfg-preset-hint' }, a.hint)
        ))
      )
    ),

    // Alerts section
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🔔 Алерты — единый alertScore'),
      h('p', { className: 'scfg-desc' },
        'alertScore = сумма взвешенных сигналов − штраф за мусор. Тренд уходит в алерт, если alertScore ≥ порога. ' +
        'Порог пользователи настраивают сами в дашборде; здесь — floor и веса.'),
      row('🎯 Минимальный alertScore (floor)', 'alertThreshold', 0, 100, 5),
      row('📨 Максимум алертов за цикл', 'maxAlertsPerCycle', 0, 20, 1,
          cfg.maxAlertsPerCycle === 0 ? '∞' : cfg.maxAlertsPerCycle),
      row('🚫 Hard-stop по junk (никогда не алертить при junk ≥)', 'alertHardJunkStop', 0, 100, 5),
    ),

    // Alert score weights — positive weights must sum to ≤ 1.0. Slider track
    // stays 0..1 for visual reference; dragging past the remaining budget is
    // clamped in onChange (value can't exceed 1 - sum of others).
    (() => {
      const POSITIVE = ['alertWeightMemePotential','alertWeightVirality','alertWeightEmergence','alertWeightTwitter','alertWeightFeedback'];
      const STEP = 0.05;
      const sumPositive = POSITIVE.reduce((s, k) => s + (Number(cfg[k]) || 0), 0);
      const budgetFor = (key) => {
        const others = POSITIVE.reduce((s, k) => k === key ? s : s + (Number(cfg[k]) || 0), 0);
        // All weights live on the 0.05 grid. Convert via *20 → round → /20 so
        // FP artefacts like 0.65 → 0.6500000000000001 don't eat a step.
        const othersSteps = Math.round(others * 20);
        const freeSteps = Math.max(0, 20 - othersSteps);
        return freeSteps / 20;
      };
      const weightRow = (label, key) => {
        const budget = budgetFor(key);
        const curr = Number(cfg[key]) || 0;
        const atLimit = curr >= budget - 1e-9;
        return h('div', { className: 'scfg-row' },
          h('div', { className: 'scfg-row-top' },
            h('span', { className: 'scfg-label' }, label),
            h('span', { className: 'scfg-val', style: atLimit ? { color: 'var(--green)' } : null },
              curr.toFixed(2) + (atLimit ? ' ⛔' : '')
            )
          ),
          h('input', {
            type: 'range', min: 0, max: 1, step: STEP,
            value: curr,
            onChange: e => {
              const v = Math.min(+e.target.value, budget);
              set(key, v);
            },
            className: 'scfg-slider'
          })
        );
      };
      const sumColor = sumPositive > 1.0001 ? 'var(--red)' : (sumPositive > 0.95 ? 'var(--green)' : 'var(--muted)');
      return h('div', { className: 'scfg-section' },
        h('h4', { className: 'scfg-h4' }, '⚖️ Веса alertScore'),
        h('p', { className: 'scfg-desc' },
          'Каждый сигнал (0–100) умножается на свой вес. Сумма положительных весов не больше 1.0 — чтобы результат оставался в шкале 0–100. ' +
          'Ползунок упрётся в свободный бюджет: если остальные весят 0.80, этот не уедет выше 0.20. Штраф junk и staleDecay вычитаются отдельно.'),
        weightRow('🔥 Вес Meme Potential (AI)',    'alertWeightMemePotential'),
        weightRow('📈 Вес Virality Score',         'alertWeightVirality'),
        weightRow('🚀 Вес Emergence (кластер)',    'alertWeightEmergence'),
        weightRow('🐦 Вес Twitter virality',       'alertWeightTwitter'),
        weightRow('👍 Вес Feedback (global 👍/👎)', 'alertWeightFeedback'),
        h('div', { style: { marginTop: 10, fontSize: 12, color: sumColor, textAlign: 'right' } },
          'Σ положительных весов: ' + sumPositive.toFixed(2) + ' / 1.00'),
        h('div', { style: { marginTop: 14 } },
          row('🗑️ Множитель штрафа junk',    'alertWeightJunk',          0, 2, STEP, cfg.alertWeightJunk?.toFixed(2)),
        ),
      );
    })(),

    // Stale decay — age-based penalty
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '⏳ Stale decay (штраф за возраст)'),
      h('p', { className: 'scfg-desc' },
        'Тренд теряет баллы по мере старения. Grace — сколько часов тренд «молодой» и штрафа нет. ' +
        'Cap — максимум, сколько баллов можно снять.'),
      row('📉 Баллов штрафа за каждый час после grace', 'alertStaleDecayPerHour', 0, 10, 1),
      row('🛡️ Grace-период (часов без штрафа)',          'alertStaleDecayGrace',   0, 72, 1),
      row('🧢 Максимум штрафа (cap)',                    'alertStaleDecayCap',     0, 80, 5),
    ),

    // AI Stage 2 — deep-dive via x_search (Grok)
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🧪 AI Stage 2 · x_search deep-dive'),
      h('p', { className: 'scfg-desc' },
        'Stage 2 = Grok + живой поиск по X. Запускается на топ-N трендов с memePotential ≥ порога. ' +
        'Результат: свежая оценка buzz + штраф за weak xBuzz (×0.5) и saturated coins 3+ (×0.7). ' +
        'Каждый вызов стоит денег (x_search) — держи cap разумным и следи за счётом xAI.'),
      row('🎯 Порог входа (memePotential ≥)', 'stage2Threshold', 0, 100, 5),
      row('⚡ Макс. вызовов за цикл (cap)',    'stage2MaxCalls',  0, 20, 1,
          cfg.stage2MaxCalls === 0 ? '0 (off)' : cfg.stage2MaxCalls),
      h('div', { style: { marginTop: 8, fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 } },
        '💡 Порог 78 / cap 3 — консервативно (старый дефолт). ' +
        'Порог 60 / cap 6 — рекомендовано: Stage 2 срабатывает ~70% циклов. ' +
        'Порог 50 / cap 10 — агрессивно: Stage 2 как основной скорер. ' +
        'Cap = 0 полностью выключает Stage 2 (дешевле через тумблер aiStage2Enabled в AI-секции).'
      ),
    ),

    // Storage section
    h('div', { className: 'scfg-section' },
      h('h4', { className: 'scfg-h4' }, '🗄️ Хранение'),
      h('p', { className: 'scfg-desc' },
        'Нарративы с базовым охватом ниже этого значения не сохраняются в БД вообще.'),
      row('📊 Базовый охват — floor для сохранения', 'minScoreToSave', 0, 80, 5),
    ),

    msg && h('div', {
      style: { marginTop: 14, padding: '10px 14px', borderRadius: 8,
        background: msg.includes('Ошибка') ? 'rgba(239,68,68,.1)' : 'rgba(16,185,129,.1)',
        color: msg.includes('Ошибка') ? 'var(--red)' : 'var(--green)', fontSize: 13 }
    }, msg),

    h('div', { style: { marginTop: 16, display: 'flex', justifyContent: 'flex-end' } },
      h('button', {
        className: 'btn btn-primary',
        onClick: save, disabled: saving,
        style: { padding: '10px 20px' }
      }, saving ? '⏳ Сохраняю...' : '💾 Сохранить конфиг')
    )
  );
}

// ── Per-preset junk-filter tuning ────────────────────────────────────────────
// Admin UI for the filterProfiles setting. Each preset (general/animals/...)
// has its own weights. Overrides are sparse — only fields that differ from
// the defaults get stored. Shows defaults as hints + a reset chip on modified
// fields. Changes apply from the next scan cycle (no restart).
const FILTER_PRESET_META = {
  general:     { icon: '🌐', label: 'Общий' },
  animals:     { icon: '🐾', label: 'Животные' },
  culture:     { icon: '🎭', label: 'Культура' },
  celebrities: { icon: '⭐', label: 'Знаменитости' },
  events:      { icon: '🌍', label: 'События' },
};

function FilterProfilesSection() {
  const h = React.createElement;
  const [data, setData]     = useState(null);    // full server response
  const [draft, setDraft]   = useState({});      // local working copy of overrides
  const [active, setActive] = useState('general');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState('');

  useEffect(() => {
    api('/api/filter-profiles')
      .then(d => { setData(d); setDraft(d.overrides || {}); })
      .catch(e => setMsg('Ошибка: ' + e.message));
  }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  if (!data) return h('div', { className: 'broadcast-box', style: { marginBottom: 20 } },
    h('div', { className: 'loading' }, 'Загрузка профилей фильтров...')
  );

  const defaults = data.defaults;
  const fields   = data.fields;
  const presets  = data.presets;

  // Effective value for a field on a preset = draft[preset][field] if set, else default.
  const effVal = (preset, field) => {
    if (draft[preset] && draft[preset][field] != null) return draft[preset][field];
    return defaults[preset][field];
  };
  const isOverridden = (preset, field) => draft[preset] && draft[preset][field] != null;

  const setFieldVal = (preset, field, val) => {
    const num = Number(val);
    setDraft(prev => {
      const next = { ...prev };
      const patch = { ...(next[preset] || {}) };
      if (num === defaults[preset][field]) {
        delete patch[field];
      } else {
        patch[field] = num;
      }
      if (Object.keys(patch).length === 0) delete next[preset];
      else next[preset] = patch;
      return next;
    });
  };

  const resetField = (preset, field) => {
    setDraft(prev => {
      const next = { ...prev };
      if (!next[preset]) return prev;
      const patch = { ...next[preset] };
      delete patch[field];
      if (Object.keys(patch).length === 0) delete next[preset];
      else next[preset] = patch;
      return next;
    });
  };

  const resetPreset = (preset) => {
    setDraft(prev => {
      const next = { ...prev };
      delete next[preset];
      return next;
    });
  };

  const resetAll = () => setDraft({});

  const save = async () => {
    setSaving(true);
    try {
      const res = await api('/api/filter-profiles', 'POST', { overrides: draft });
      setData(res);
      setDraft(res.overrides || {});
      flash('✓ Профили сохранены');
    } catch (e) {
      flash('Ошибка: ' + e.message);
    }
    setSaving(false);
  };

  // Count modifications for header badge
  const modCount = Object.values(draft).reduce((acc, p) => acc + Object.keys(p).length, 0);
  const activeMods = draft[active] ? Object.keys(draft[active]).length : 0;

  // ── Field row ──
  const fieldRow = (field) => {
    const meta = fields[field];
    const cur  = effVal(active, field);
    const def  = defaults[active][field];
    const mod  = isOverridden(active, field);
    return h('div', { key: field, className: 'scfg-row' },
      h('div', { className: 'scfg-row-top' },
        h('span', { className: 'scfg-label' },
          meta.label,
          h('span', { style: { marginLeft: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 400 } },
            meta.desc)
        ),
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          mod && h('button', {
            onClick: () => resetField(active, field),
            title: 'Сбросить к ' + def,
            style: {
              padding: '2px 8px', fontSize: 11, borderRadius: 4,
              background: 'rgba(239,68,68,.12)', color: 'var(--red)',
              border: '1px solid rgba(239,68,68,.3)', cursor: 'pointer',
            },
          }, '↺ ' + def),
          h('span', {
            className: 'scfg-val',
            style: mod ? { color: 'var(--accent)', fontWeight: 700 } : null,
          }, cur)
        )
      ),
      h('input', {
        type: 'range',
        min: meta.min, max: meta.max, step: meta.step,
        value: cur,
        onChange: e => setFieldVal(active, field, e.target.value),
        className: 'scfg-slider',
      })
    );
  };

  return h('div', { className: 'broadcast-box', style: { marginBottom: 20 } },
    h('h3', { style: { marginBottom: 6 } },
      '🎛️ Профили фильтров по пресетам',
      modCount > 0 && h('span', {
        style: {
          marginLeft: 10, padding: '2px 8px', fontSize: 12,
          borderRadius: 10, background: 'rgba(20,184,166,.15)',
          color: 'var(--accent)', fontWeight: 600,
        },
      }, modCount + ' изменение' + (modCount === 1 ? '' : modCount < 5 ? 'я' : 'й'))
    ),
    h('p', { style: { color: 'var(--muted)', fontSize: 13, marginBottom: 16 } },
      'Штрафы junk-filter для каждого пресета. Изменения применяются со следующего цикла сканера. ' +
      'Сохраняются только значения, отличающиеся от дефолтных (sparse override).'
    ),

    // ── Preset tabs ──
    h('div', {
      style: {
        display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap',
        padding: 6, background: 'var(--bg2)', borderRadius: 10,
        border: '1px solid var(--border)',
      },
    },
      presets.map(p => {
        const meta = FILTER_PRESET_META[p] || { icon: '•', label: p };
        const mods = draft[p] ? Object.keys(draft[p]).length : 0;
        const isActive = active === p;
        return h('button', {
          key: p,
          onClick: () => setActive(p),
          style: {
            flex: '1 1 auto', minWidth: 110, padding: '8px 12px',
            borderRadius: 8, cursor: 'pointer',
            background: isActive ? 'var(--accent)' : 'transparent',
            color: isActive ? '#fff' : 'var(--text)',
            border: isActive ? '1px solid var(--accent)' : '1px solid transparent',
            fontWeight: isActive ? 700 : 500,
            fontSize: 13,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          },
        },
          h('span', null, meta.icon + ' ' + meta.label),
          mods > 0 && h('span', {
            style: {
              padding: '1px 6px', fontSize: 10, borderRadius: 8,
              background: isActive ? 'rgba(255,255,255,.22)' : 'rgba(20,184,166,.18)',
              color: isActive ? '#fff' : 'var(--accent)',
              fontWeight: 700,
            },
          }, mods)
        );
      })
    ),

    // ── Field rows for active preset ──
    Object.keys(fields).map(fieldRow),

    // ── Per-preset reset + save ──
    h('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginTop: 18, gap: 10, flexWrap: 'wrap',
      },
    },
      h('div', { style: { display: 'flex', gap: 8 } },
        activeMods > 0 && h('button', {
          onClick: () => resetPreset(active),
          style: {
            padding: '8px 14px', borderRadius: 8, fontSize: 12,
            background: 'transparent', color: 'var(--red)',
            border: '1px solid rgba(239,68,68,.4)', cursor: 'pointer',
          },
        }, '↺ Сбросить этот пресет'),
        modCount > 0 && h('button', {
          onClick: resetAll,
          style: {
            padding: '8px 14px', borderRadius: 8, fontSize: 12,
            background: 'transparent', color: 'var(--muted)',
            border: '1px solid var(--border)', cursor: 'pointer',
          },
        }, '↺ Сбросить все пресеты'),
      ),
      h('button', {
        className: 'btn btn-primary',
        onClick: save, disabled: saving,
        style: { padding: '10px 20px' },
      }, saving ? '⏳ Сохраняю...' : '💾 Сохранить профили')
    ),

    msg && h('div', {
      style: {
        marginTop: 14, padding: '10px 14px', borderRadius: 8,
        background: msg.includes('Ошибка') ? 'rgba(239,68,68,.1)' : 'rgba(16,185,129,.1)',
        color: msg.includes('Ошибка') ? 'var(--red)' : 'var(--green)',
        fontSize: 13,
      },
    }, msg)
  );
}

// ── Alert Decisions page — per-trend verdicts from the gate ──────────────────
// Minimalist list: one card per trend, with gates + score breakdown + source link.
// Reason vocabulary (must match index.js recordAlertDecision calls):
//   sent, send_failed, threshold, hard_junk, source, dedup, daily, cap
const DECISION_LABELS = {
  sent:        { color: 'var(--green)', text: '✓ Отправлено' },
  threshold:   { color: 'var(--red)',   text: '↓ Ниже порога' },
  hard_junk:   { color: 'var(--red)',   text: '🗑️ Hard-junk' },
  source:      { color: 'var(--muted)', text: '🔕 Источник отключён' },
  dedup:       { color: 'var(--muted)', text: '✓✓ Уже отправлено' },
  daily:       { color: 'var(--muted)', text: '📵 Лимит юзера' },
  cap:         { color: 'var(--muted)', text: '⏱ Cap на цикл' },
  send_failed: { color: 'var(--red)',   text: '⚠ Ошибка отправки' },
};

// Short human labels for each gate chip
const GATE_LABELS = {
  threshold: 'порог',
  hard_junk: 'junk',
  source:    'источник',
  dedup:     'dedup',
  daily:     'лимит',
  cap:       'cap',
  send:      'отправка',
};

function DecisionsPage() {
  const h = React.createElement;
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all'); // all | sent | skipped
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const qs = 'filter=' + filter + (reason ? '&reason=' + encodeURIComponent(reason) : '') + '&limit=200';
    api('/api/alert-decisions?' + qs)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(load, [filter, reason]);
  useEffect(() => {
    const iv = setInterval(load, 10_000); // refresh every 10s
    return () => clearInterval(iv);
  }, [filter, reason]);

  if (loading && !data) return h('div', { className: 'loading' }, 'Загрузка решений...');
  if (!data) return h('div', { className: 'empty' }, 'Нет данных');

  const items = data.items || [];
  const counts = data.counts || {};

  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { return iso; }
  };
  // Compact number formatter — 1234 → 1.2K, 1234567 → 1.2M
  const fmtNum = (n) => {
    if (n == null || isNaN(n)) return null;
    const x = Number(n);
    if (x >= 1_000_000) return (x / 1_000_000).toFixed(x >= 10_000_000 ? 0 : 1) + 'M';
    if (x >= 1_000)     return (x / 1_000).toFixed(x >= 10_000 ? 0 : 1) + 'K';
    return String(x);
  };
  const fmtBreakdown = (b) => {
    if (!b) return '—';
    const parts = [];
    if (b.meme != null)       parts.push('meme=' + b.meme);
    if (b.viral != null)      parts.push('viral=' + b.viral);
    if (b.emergence != null)  parts.push('emerg=' + b.emergence);
    if (b.twitter)            parts.push('x=' + b.twitter);
    if (b.feedback != null && b.feedback !== 50) parts.push('fb=' + b.feedback);
    if (b.junk)               parts.push('junk=' + b.junk);
    if (b.staleDecay)         parts.push('stale=' + b.staleDecay);
    return parts.join(' · ');
  };

  return h('div', null,
    h('h2', { style: { marginBottom: 6 } }, '🔔 Решения алерт-гейта'),
    h('p', { style: { color: 'var(--muted)', fontSize: 13, marginBottom: 16 } },
      'Последние 500 решений, in-memory (сбрасывается при рестарте). Обновляется каждые 10 сек. ' +
      'Всего в буфере: ' + (data.total || 0) + '.'),

    // Filter chips + reason counts
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 } },
      ['all', 'sent', 'skipped'].map(f => h('button', {
        key: f,
        className: 'btn ' + (filter === f ? 'btn-primary' : 'btn-ghost') + ' btn-sm',
        onClick: () => { setFilter(f); setReason(''); }
      }, f === 'all' ? 'Все' : f === 'sent' ? '✓ Отправлены' : '✗ Отсеяны'))
    ),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, fontSize: 12 } },
      Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, n]) => {
        const lbl = DECISION_LABELS[r];
        return h('button', {
          key: r,
          className: 'btn btn-sm ' + (reason === r ? 'btn-primary' : 'btn-ghost'),
          style: { fontSize: 11, padding: '4px 10px', color: reason === r ? '' : (lbl?.color || 'var(--text2)') },
          onClick: () => setReason(reason === r ? '' : r)
        }, (lbl?.text || r) + ' · ' + n);
      })
    ),

    // List
    items.length === 0
      ? h('div', { className: 'empty', style: { padding: 40 } },
          'Пока нет решений — сканер ещё ни разу не гонял алерт-гейт.')
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          items.map((d, i) => {
            const lbl = DECISION_LABELS[d.reason] || { color: 'var(--text2)', text: d.reason };
            const isSent = d.decision === 'sent';
            const accent = isSent ? 'var(--green)' : (lbl.color || 'var(--red)');

            // Fallback for old decisions without gates[] — synthesize from reason
            const gates = Array.isArray(d.gates) && d.gates.length
              ? d.gates
              : (d.reason && d.reason !== 'sent'
                  ? [{ name: d.reason, passed: false, detail: d.detail || '' }]
                  : []);

            const titleNode = d.url
              ? h('a', {
                  href: d.url, target: '_blank', rel: 'noopener noreferrer',
                  style: { color: 'var(--text)', textDecoration: 'none', fontWeight: 600, fontSize: 14, lineHeight: 1.35 },
                  onMouseOver: e => e.currentTarget.style.textDecoration = 'underline',
                  onMouseOut:  e => e.currentTarget.style.textDecoration = 'none',
                }, (d.title || '—'), h('span', { style: { color: 'var(--muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 } }, '↗'))
              : h('span', { style: { color: 'var(--text)', fontWeight: 600, fontSize: 14 } }, d.title || '—');

            return h('div', {
              key: i,
              style: {
                background: 'var(--bg2, rgba(255,255,255,0.02))',
                border: '1px solid var(--border)',
                borderLeft: '3px solid ' + accent,
                borderRadius: 8,
                padding: '12px 14px',
              }
            },
              // Row 1: time + title + verdict
              h('div', {
                style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }
              },
                h('span', { style: { color: 'var(--muted)', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'nowrap' } }, fmtTime(d.ts)),
                h('div', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, titleNode),
                h('span', {
                  style: {
                    color: accent, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                    padding: '3px 8px', borderRadius: 4,
                    background: 'color-mix(in srgb, ' + accent + ' 12%, transparent)',
                  }
                }, lbl.text)
              ),
              // Row 2: meta (source, category, score, user)
              h('div', {
                style: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)', marginBottom: 8 }
              },
                d.source    && h('span', null, '📡 ', h('b', { style: { color: 'var(--text2)', fontWeight: 500 } }, d.source)),
                d.category  && h('span', null, '📂 ', d.category),
                d.alertScore != null && h('span', null,
                  'score: ',
                  h('b', { style: { color: 'var(--text2)', fontWeight: 600 } }, d.alertScore),
                  ' / ', d.threshold
                ),
                d.userChatId && h('span', null, '👤 @', d.userChatId)
              ),
              // Row 2b: engagement — raw views/likes/retweets/upvotes from
              // the collector. For Twitter clusters these are sums across
              // all tweets in the cluster. Hidden if no data at all.
              (() => {
                const e = d.engagement || {};
                const chips = [];
                if (e.views    != null && fmtNum(e.views)    != null) chips.push({ icon: '👁', label: 'views',    val: fmtNum(e.views) });
                if (e.likes    != null && fmtNum(e.likes)    != null) chips.push({ icon: '❤️', label: 'likes',    val: fmtNum(e.likes) });
                if (e.retweets != null && fmtNum(e.retweets) != null) chips.push({ icon: '🔁', label: 'rt',       val: fmtNum(e.retweets) });
                if (e.replies  != null && fmtNum(e.replies)  != null) chips.push({ icon: '💬', label: 'replies',  val: fmtNum(e.replies) });
                if (e.upvotes  != null && fmtNum(e.upvotes)  != null) chips.push({ icon: '⬆',  label: 'upvotes',  val: fmtNum(e.upvotes) });
                if (!chips.length) return null;
                return h('div', {
                  style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }
                },
                  chips.map((c, ci) => h('span', {
                    key: ci,
                    title: c.label,
                    style: {
                      fontSize: 11, padding: '2px 8px', borderRadius: 10,
                      border: '1px solid var(--border)',
                      color: 'var(--text2)',
                      background: 'rgba(255,255,255,0.02)',
                      fontFamily: 'ui-monospace, monospace',
                    }
                  }, c.icon + ' ' + c.val))
                );
              })(),
              // Row 3: gate chips
              gates.length > 0 && h('div', {
                style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: d.breakdown ? 8 : 0 }
              },
                gates.map((g, gi) => {
                  const c = g.passed ? 'var(--green)' : 'var(--red)';
                  return h('span', {
                    key: gi,
                    title: g.detail || '',
                    style: {
                      fontSize: 11, padding: '2px 8px', borderRadius: 10,
                      border: '1px solid color-mix(in srgb, ' + c + ' 40%, transparent)',
                      color: c,
                      background: 'color-mix(in srgb, ' + c + ' 10%, transparent)',
                      fontFamily: 'ui-monospace, monospace',
                      cursor: g.detail ? 'help' : 'default',
                    }
                  }, (g.passed ? '✓ ' : '✗ ') + (GATE_LABELS[g.name] || g.name));
                })
              ),
              // Row 4: breakdown (monospace, subtle)
              d.breakdown && h('div', {
                style: {
                  color: 'var(--muted)', fontSize: 11, fontFamily: 'ui-monospace, monospace',
                  padding: '6px 8px', background: 'rgba(255,255,255,0.02)',
                  borderRadius: 4, border: '1px dashed var(--border)',
                }
              }, fmtBreakdown(d.breakdown))
            );
          })
        )
  );
}

function StatsPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(()=>{
    api('/api/stats').then(s=>{ setStats(s); setLoading(false); }).catch(()=>setLoading(false));
  },[]);

  if (loading) return React.createElement('div',{className:'loading'},'Загрузка статистики...');
  if (!stats) return React.createElement('div',{className:'empty'},'Нет данных');

  const COLORS=['#7c3aed','#3b82f6','#10b981','#f59e0b','#ef4444'];
  const fmtRevenueByCurrency = (rows) => {
    if (!rows || rows.length === 0) return '0';
    return rows
      .map(r => {
        const c = (r.currency || 'SOL').toUpperCase();
        const decimals = c === 'SOL' ? 4 : 2;
        return parseFloat(r.total || 0).toFixed(decimals) + ' ' + c;
      })
      .join(' + ');
  };
  const fmtBytes = (bytes = 0) => {
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return mb.toFixed(1) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  };
  const paidShare = stats.users.total ? Math.round((stats.users.paid / stats.users.total) * 100) : 0;
  const activeShare = stats.users.total ? Math.round((stats.users.active / stats.users.total) * 100) : 0;

  return React.createElement('div',null,
    React.createElement('div',{className:'page-header'},
      React.createElement('h2',null,'📊 Статистика'),
      React.createElement('p',null,'Главный срез по пользователям, оплатам и состоянию базы. Это экран для быстрого sanity-check проекта: рост, монетизация, состав аудитории и нагрузка на хранилище.')
    ),
    React.createElement('div',{className:'cards'},
      React.createElement('div',{className:'card purple'},React.createElement('div',{className:'card-label'},'Всего юзеров'),React.createElement('div',{className:'card-value'},stats.users.total),React.createElement('div',{className:'card-sub'},activeShare+'% сейчас активны')),
      React.createElement('div',{className:'card green'},React.createElement('div',{className:'card-label'},'Активных'),React.createElement('div',{className:'card-value'},stats.users.active),React.createElement('div',{className:'card-sub'},'Живые пользователи в active status')),
      React.createElement('div',{className:'card blue'},React.createElement('div',{className:'card-label'},'Платных'),React.createElement('div',{className:'card-value'},stats.users.paid),React.createElement('div',{className:'card-sub'},paidShare+'% от всей базы')),
      React.createElement('div',{className:'card yellow'},React.createElement('div',{className:'card-label'},'Доход 30д'),React.createElement('div',{className:'card-value'},fmtRevenueByCurrency(stats.revenue.byCurrency30days)),React.createElement('div',{className:'card-sub'},'Текущий месячный срез')),
      React.createElement('div',{className:'card'},React.createElement('div',{className:'card-label'},'Новые сегодня'),React.createElement('div',{className:'card-value'},stats.users.newToday),React.createElement('div',{className:'card-sub'},'+'+stats.users.newWeek+' за неделю · +'+stats.users.newMonth+' за месяц')),
      React.createElement('div',{className:'card'},React.createElement('div',{className:'card-label'},'Размер БД'),React.createElement('div',{className:'card-value'},fmtBytes(stats.storage.dbBytes)),React.createElement('div',{className:'card-sub'},stats.storage.trendsCount+' trends · '+stats.storage.notificationsCount+' notifications'))
    ),
    React.createElement('div',{className:'stats-grid'},
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Новые пользователи (14 дней)'),
        React.createElement(BarChart,{data:stats.dailyNew,color:'#7c3aed'})
      ),
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Сумма платежей (смешанные валюты)'),
        React.createElement(BarChart,{data:stats.dailyRevenue.map(d=>({...d,n:parseFloat(d.total||0)})),color:'#10b981'})
      ),
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Распределение по планам'),
        React.createElement(PieLegend,{data:stats.planDist,colors:COLORS})
      ),
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Языки'),
        React.createElement(PieLegend,{data:stats.langDist.map(d=>({...d,name:d.language==='ru'?'🇷🇺 Русский':'🇺🇸 English'})),colors:['#7c3aed','#3b82f6']})
      )
    ),
    React.createElement('div',{className:'stats-bottom-grid'},
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Срез по хранению'),
        React.createElement('div',{className:'info-list'},
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Размер файла БД'),React.createElement('span',null,fmtBytes(stats.storage.dbBytes))),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Тренды'),React.createElement('span',null,stats.storage.trendsCount)),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Notifications'),React.createElement('span',null,stats.storage.notificationsCount)),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Payments'),React.createElement('span',null,stats.storage.paymentsCount)),
        )
      ),
      React.createElement('div',{className:'chart-wrap'},
        React.createElement('div',{className:'chart-title'},'Краткие выводы'),
        React.createElement('div',{className:'info-list'},
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Active rate'),React.createElement('span',null,activeShare + '%')),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Paid share'),React.createElement('span',null,paidShare + '%')),
          React.createElement('div',{className:'info-row'},React.createElement('strong',null,'Доход lifetime'),React.createElement('span',null,fmtRevenueByCurrency(stats.revenue.byCurrencyTotal))),
        ),
        React.createElement('p',{className:'muted-note',style:{marginTop:14}},
          'Если нужно быстро проверить здоровье продукта, обычно хватает трёх мест: новые пользователи, доход 30д и размер базы. Они быстрее всего показывают, всё ли идёт в плюс.'
        )
      )
    )
  );
}

// Input that toggles between a number and ∞ (value=-1).
// Used for alert_limit and history_days in plan rows.
function UnlimitedInput({value, onChange}) {
  const isUnlimited = value === -1 || value === '-1';
  return React.createElement('div',{style:{display:'flex',alignItems:'center',gap:4}},
    React.createElement('input',{
      className:'plan-input',
      type:'number',
      disabled:isUnlimited,
      value: isUnlimited ? '' : (value ?? ''),
      style:{width:56, opacity: isUnlimited ? 0.35 : 1},
      onChange: e => onChange(parseInt(e.target.value) || 0)
    }),
    React.createElement('label',{
      title:'Безлимит',
      style:{display:'flex',alignItems:'center',gap:3,cursor:'pointer',fontSize:13,color:'var(--text2)',userSelect:'none'}
    },
      React.createElement('input',{
        type:'checkbox',
        checked:isUnlimited,
        style:{accentColor:'var(--accent)',width:13,height:13,cursor:'pointer'},
        onChange: e => onChange(e.target.checked ? -1 : 0)
      }),
      '∞'
    )
  );
}

function BotPage() {
  const [plans, setPlans] = useState([]);
  const [broadcasts, setBroadcasts] = useState([]);
  const [aiCfg, setAiCfg] = useState(null);
  const [aiDraft, setAiDraft] = useState({ provider: 'xai', model: 'grok-4-1-fast-non-reasoning', stage2Enabled: true });
  const [aiModels, setAiModels] = useState({ xai: [], openai: [] });
  const [aiModelsError, setAiModelsError] = useState('');
  const [editedPlans, setEditedPlans] = useState({});
  const [msg, setMsg] = useState('');
  const [fbCfg, setFbCfg] = useState({ enabled:true, weightAdmin:3, weightPro:2, weightTest:1, weightFree:1 });
  const [fbSaving, setFbSaving] = useState(false);
  const [bcast, setBcast] = useState('');
  const [bcastPlan, setBcastPlan] = useState('all');
  const [bcastResult, setBcastResult] = useState(null);
  const [manageText, setManageText] = useState('');
  const [managePlan, setManagePlan] = useState('all');
  const [manageResult, setManageResult] = useState(null);
  const [sending, setSending] = useState(false);
  const [managing, setManaging] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);

  const loadBroadcasts = async () => {
    try { setBroadcasts(await api('/api/broadcasts?limit=30&offset=0')); }
    catch(_) {}
  };

  const loadAiConfig = async () => {
    try {
      const cfg = await api('/api/ai-config');
      setAiCfg(cfg);
      setAiDraft({ provider: cfg.provider, model: cfg.model, stage2Enabled: !!cfg.stage2Enabled });
    } catch (_) {}
  };

  const loadAiModels = async () => {
    try {
      setAiModelsError('');
      const all = await api('/api/ai-models');
      setAiModels({
        xai: all?.xai?.models || [],
        openai: all?.openai?.models || [],
      });
      // Show only actionable errors (e.g. OpenAI key missing).
      // Ignore xAI quota noise because xAI list is intentionally fixed.
      const err = all?.openai?.error || '';
      if (err && (all?.openai?.models || []).length === 0) setAiModelsError(err);
    } catch (e) {
      setAiModelsError(e.message || 'Failed to load models');
    }
  };

  useEffect(()=>{
    api('/api/plans').then(p=>setPlans(p)).catch(()=>{});
    loadBroadcasts();
    loadAiConfig();
    loadAiModels();
    api('/api/feedback-config').then(c=>setFbCfg(c)).catch(()=>{});
  },[]);

  const setPlanField = (id, field, val) => {
    setEditedPlans(prev=>({...prev,[id]:{...(prev[id]||{}), [field]:val}}));
  };

  const savePlan = async (plan) => {
    const changes = editedPlans[plan.id];
    if (!changes) return;
    setSavingPlan(true);
    try {
      await api('/api/plans/'+plan.id, 'PUT', changes);
      setMsg('✓ План обновлён');
      setPlans(await api('/api/plans'));
      setEditedPlans(prev=>{ const n={...prev}; delete n[plan.id]; return n; });
    } catch(e){ setMsg('Ошибка: '+e.message); }
    finally { setSavingPlan(false); setTimeout(()=>setMsg(''),3000); }
  };

  const saveFbCfg = async () => {
    setFbSaving(true);
    try {
      const saved = await api('/api/feedback-config', 'POST', fbCfg);
      setFbCfg(saved);
      setMsg('✓ Настройки фидбека сохранены');
    } catch(e){ setMsg('Ошибка: '+e.message); }
    finally { setFbSaving(false); setTimeout(()=>setMsg(''),3000); }
  };

  const sendBroadcast = async () => {
    if (!bcast.trim()) return;
    setSending(true);
    try {
      const r = await api('/api/broadcast','POST',{message:bcast,plan:bcastPlan});
      setBcastResult(r);
      setBcast('');
      loadBroadcasts();
    } catch(e){ setBcastResult({error:e.message}); }
    finally { setSending(false); }
  };

  const manageBroadcast = async (action) => {
    if (action === 'edit' && !manageText.trim()) return;
    if (action === 'delete' && !window.confirm('Удалить последнее закрепленное сообщение у всех выбранных пользователей?')) return;

    setManaging(true);
    try {
      const payload = { action, plan: managePlan };
      if (action === 'edit') payload.message = manageText;
      const r = await api('/api/broadcast/manage', 'POST', payload);
      setManageResult(r);
      loadBroadcasts();
    } catch (e) {
      setManageResult({ error: e.message });
    } finally {
      setManaging(false);
    }
  };

  const manageHistoryBroadcast = async (broadcastId, action, originalText='') => {
    let payload = { action };
    if (action === 'edit') {
      const next = window.prompt('Новый текст для этой рассылки:', originalText || '');
      if (next === null) return;
      if (!next.trim()) return;
      payload.message = next;
    }
    if (action === 'delete' && !window.confirm('Удалить это сообщение у всех получателей?')) return;

    setManaging(true);
    try {
      const r = await api('/api/broadcasts/' + broadcastId + '/manage', 'POST', payload);
      setManageResult(r);
      loadBroadcasts();
    } catch (e) {
      setManageResult({ error: e.message });
    } finally {
      setManaging(false);
    }
  };

  const saveAiConfig = async () => {
    setAiSaving(true);
    try {
      const cfg = await api('/api/ai-config', 'POST', {
        provider: aiDraft.provider,
        model: aiDraft.model,
        stage2Enabled: !!aiDraft.stage2Enabled,
      });
      setAiCfg(cfg);
      setMsg('✓ AI конфигурация обновлена');
      setTimeout(()=>setMsg(''), 2500);
    } catch (e) {
      setMsg('Ошибка AI: ' + e.message);
      setTimeout(()=>setMsg(''), 4000);
    } finally {
      setAiSaving(false);
    }
  };

  const fmtDt = dt => { if (!dt) return '—'; const s = dt.includes('Z')||dt.includes('+') ? dt : dt.replace(' ','T')+'Z'; return new Date(s).toLocaleString('ru',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); };
  const paidPlans = plans.filter(p => ['test','pro'].includes(p.name)).length;

  return React.createElement('div',null,
    React.createElement('div',{className:'page-header'},
      React.createElement('h2',null,'🤖 Управление ботом'),
      React.createElement('p',null,'Рассылки, планы и настройки')
    ),
    React.createElement('div',{className:'cards'},
      React.createElement('div',{className:'card purple'},React.createElement('div',{className:'card-label'},'Broadcast history'),React.createElement('div',{className:'card-value'},broadcasts.length),React.createElement('div',{className:'card-sub'},'Последние сохранённые рассылки')),
      React.createElement('div',{className:'card blue'},React.createElement('div',{className:'card-label'},'Stage 1 provider'),React.createElement('div',{className:'card-value'},(aiCfg?.provider || aiDraft.provider || 'xai').toUpperCase()),React.createElement('div',{className:'card-sub'},aiCfg?.model || aiDraft.model || '—')),
      React.createElement('div',{className:'card green'},React.createElement('div',{className:'card-label'},'Stage 2'),React.createElement('div',{className:'card-value'},(aiCfg?.stage2Enabled ?? aiDraft.stage2Enabled) ? 'ON' : 'OFF'),React.createElement('div',{className:'card-sub'},'x_search через Grok')),
      React.createElement('div',{className:'card yellow'},React.createElement('div',{className:'card-label'},'Paid plans'),React.createElement('div',{className:'card-value'},paidPlans),React.createElement('div',{className:'card-sub'},'Редактируемые тарифы с оплатой'))
    ),

    React.createElement('div',{className:'broadcast-box'},
      React.createElement('h3',null,'🧠 AI Pipeline'),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},
        'Stage 1: выбранная модель для основного scoring. Stage 2: x_search через Grok (вкл/выкл одним тумблером).'
      ),

      React.createElement('div',{style:{marginBottom:10,fontSize:12,fontWeight:700,color:'var(--text2)'}},'Stage 1 — Основная модель'),
      React.createElement('div',{className:'broadcast-footer',style:{alignItems:'center'}},
        React.createElement('select',{
          className:'filter',
          value:aiDraft.provider,
          onChange:e=>setAiDraft(prev=>({ ...prev, provider: e.target.value, model: e.target.value === 'openai' ? 'gpt-4.1-mini' : 'grok-4-1-fast-non-reasoning' }))
        },
          React.createElement('option',{value:'xai'},'xAI (Grok)'),
          React.createElement('option',{value:'openai'},'OpenAI (GPT)')
        ),
        React.createElement('select',{
          className:'filter',
          style:{minWidth:300,maxWidth:360},
          value:aiDraft.model || '',
          onChange:e=>setAiDraft(prev=>({ ...prev, model: e.target.value }))
        },
          (aiModels[aiDraft.provider] || []).length > 0
            ? (aiModels[aiDraft.provider] || []).map(m => React.createElement('option',{key:m,value:m},m))
            : React.createElement('option',{value:aiDraft.model || ''},aiDraft.model || 'No models loaded')
        ),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:loadAiModels},'↻ Models'),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>setAiDraft(prev=>({ ...prev, model: prev.provider === 'openai' ? 'gpt-4.1-mini' : 'grok-4-1-fast-non-reasoning' }))},'Default')
      ),

      React.createElement('div',{style:{marginTop:12,marginBottom:8,fontSize:12,fontWeight:700,color:'var(--text2)'}},'Stage 2 — X Search (Grok only)'),
      React.createElement('div',{className:'broadcast-footer',style:{alignItems:'center'}},
        React.createElement('label',{style:{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}},
          React.createElement('input',{
            type:'checkbox',
            checked:!!aiDraft.stage2Enabled,
            onChange:e=>setAiDraft(prev=>({ ...prev, stage2Enabled: e.target.checked }))
          }),
          React.createElement('span',null, aiDraft.stage2Enabled ? 'Включено' : 'Отключено')
        ),
        React.createElement('button',{className:'btn btn-primary',onClick:saveAiConfig,disabled:aiSaving||!aiDraft.model?.trim()},aiSaving?'Сохранение...':'💾 Сохранить')
      ),

      aiModelsError && React.createElement('div',{className:'mt16',style:{fontSize:12,color:'var(--red)'}},'Models API: ' + aiModelsError),
      aiCfg && React.createElement('div',{className:'mt16',style:{fontSize:12,color:'var(--text2)'}},
        'Текущий Stage 1: ' + aiCfg.provider + ':' + aiCfg.model +
        ' | Stage 2: ' + (aiCfg.stage2Enabled ? 'ON' : 'OFF') +
        ' | key xAI: ' + (aiCfg.hasXaiKey ? 'yes' : 'no') +
        ' | key OpenAI: ' + (aiCfg.hasOpenaiKey ? 'yes' : 'no')
      )
    ),

    // Broadcast
    React.createElement('div',{className:'broadcast-box'},
      React.createElement('h3',null,'📢 Рассылка сообщений'),
      React.createElement('textarea',{className:'msg-input',placeholder:'Введите сообщение... Поддерживается HTML: <b>жирный</b>, <i>курсив</i>, <a href="">ссылка</a>',value:bcast,onChange:e=>setBcast(e.target.value)}),
      React.createElement('div',{className:'broadcast-footer'},
        React.createElement('select',{className:'filter',value:bcastPlan,onChange:e=>setBcastPlan(e.target.value)},
          React.createElement('option',{value:'all'},'Все пользователи'),
          React.createElement('option',{value:'free'},'Только Free'),
          React.createElement('option',{value:'test'},'Только Test'),
          React.createElement('option',{value:'pro'},'Только Pro'),
        ),
        React.createElement('button',{className:'btn btn-primary',onClick:sendBroadcast,disabled:sending||!bcast.trim()},sending?'Отправка...':'📤 Отправить'),
        bcastResult&&!bcastResult.error&&React.createElement('span',{className:'success-msg'},'✓ Отправлено: '+bcastResult.sent+', ошибок: '+bcastResult.failed),
        bcastResult&&bcastResult.error&&React.createElement('span',{className:'error-msg'},'Ошибка: '+bcastResult.error)
      )
    ),

    React.createElement('div',{className:'broadcast-box'},
      React.createElement('h3',null,'🛠 Управление последней рассылкой'),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},'Работает с последним закрепленным рассылочным сообщением у каждого пользователя.'),
      React.createElement('textarea',{
        className:'msg-input',
        placeholder:'Новый текст для кнопки "Обновить текст" (HTML поддерживается)',
        value:manageText,
        onChange:e=>setManageText(e.target.value)
      }),
      React.createElement('div',{className:'broadcast-footer'},
        React.createElement('select',{className:'filter',value:managePlan,onChange:e=>setManagePlan(e.target.value)},
          React.createElement('option',{value:'free'},'Только Free'),
          React.createElement('option',{value:'test'},'Только Test'),
          React.createElement('option',{value:'pro'},'Только Pro'),
        ),
        React.createElement('button',{className:'btn btn-primary',onClick:sendBroadcast,disabled:sending||!bcast.trim()},sending?'Отправка...':'📤 Отправить'),
        bcastResult&&!bcastResult.error&&React.createElement('span',{className:'success-msg'},'✓ Отправлено: '+bcastResult.sent+', ошибок: '+bcastResult.failed),
        bcastResult&&bcastResult.error&&React.createElement('span',{className:'error-msg'},'Ошибка: '+bcastResult.error)
      )
    ),

    React.createElement('div',{className:'broadcast-box'},
      React.createElement('h3',null,'🛠 Управление последней рассылкой'),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},'Работает с последним закрепленным рассылочным сообщением у каждого пользователя.'),
      React.createElement('textarea',{
        className:'msg-input',
        placeholder:'Новый текст для кнопки "Обновить текст" (HTML поддерживается)',
        value:manageText,
        onChange:e=>setManageText(e.target.value)
      }),
      React.createElement('div',{className:'broadcast-footer'},
        React.createElement('select',{className:'filter',value:managePlan,onChange:e=>setManagePlan(e.target.value)},
          React.createElement('option',{value:'all'},'Все пользователи'),
          React.createElement('option',{value:'free'},'Только Free'),
          React.createElement('option',{value:'test'},'Только Test'),
          React.createElement('option',{value:'pro'},'Только Pro'),
        ),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>manageBroadcast('edit'),disabled:managing||!manageText.trim()},managing?'...':'✏️ Обновить текст'),
        React.createElement('button',{className:'btn btn-ghost btn-sm',onClick:()=>manageBroadcast('unpin'),disabled:managing},managing?'...':'📌 Открепить у всех'),
        React.createElement('button',{className:'btn btn-danger btn-sm',onClick:()=>manageBroadcast('delete'),disabled:managing},managing?'...':'🗑 Удалить у всех')
      ),
      manageResult&&!manageResult.error&&React.createElement('div',{className:'mt16'},React.createElement('span',{className:'success-msg'},
        'Готово: ' + (manageResult.action || '-') + ' | успех: ' + (manageResult.success || 0) + ', ошибок: ' + (manageResult.failed || 0) + ', всего: ' + (manageResult.total || 0)
      )),
      manageResult&&manageResult.error&&React.createElement('div',{className:'mt16'},React.createElement('span',{className:'error-msg'},'Ошибка: '+manageResult.error))
    ),

    React.createElement('div',{className:'broadcast-box'},
      React.createElement('h3',null,'🗂 История рассылок'),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},'Можно отредактировать, открепить или удалить конкретную рассылку у всех получателей.'),
      broadcasts.length === 0
        ? React.createElement('div',{className:'empty'},'История пока пустая')
        : React.createElement('div',{style:{display:'flex',flexDirection:'column',gap:10}},
            broadcasts.map(b => React.createElement('div',{key:b.id,style:{border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',background:'var(--bg2)'}},
              React.createElement('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'center'}},
                React.createElement('div',null,
                  React.createElement('div',{style:{fontWeight:700,fontSize:13}},'#' + b.id + ' • ' + fmtDt(b.created_at) + ' • plan: ' + (b.plan_filter || 'all')),
                  React.createElement('div',{style:{fontSize:12,color:'var(--text2)'}},'sent: ' + (b.sent_count || 0) + ', failed: ' + (b.failed_count || 0) + ', deliveries: ' + (b.deliveries || 0))
                ),
                React.createElement('div',{className:'btn-row'},
                  React.createElement('button',{className:'btn btn-ghost btn-sm',disabled:managing,onClick:()=>manageHistoryBroadcast(b.id,'edit',b.message_html||'')},'✏️'),
                  React.createElement('button',{className:'btn btn-ghost btn-sm',disabled:managing,onClick:()=>manageHistoryBroadcast(b.id,'unpin')},'📌'),
                  React.createElement('button',{className:'btn btn-danger btn-sm',disabled:managing,onClick:()=>manageHistoryBroadcast(b.id,'delete')},'🗑')
                )
              ),
              React.createElement('div',{style:{fontSize:12,color:'var(--text2)',marginTop:8,whiteSpace:'pre-wrap',maxHeight:70,overflow:'hidden'}},b.message_html || '')
            ))
          )
    ),

    // Plans
    React.createElement('div',{className:'broadcast-box'},
      React.createElement('h3',null,'💰 Настройка планов'),
      React.createElement('div',{style:{borderRadius:8,overflow:'hidden',border:'1px solid var(--border)'}},
        React.createElement('div',{className:'plan-row plan-head'},
          React.createElement('span',null,'План'),
          React.createElement('span',null,'Цена (USD)'),
          React.createElement('span',null,'Алертов/день'),
          React.createElement('span',null,'Дней'),
          React.createElement('span',null,''),
        ),
        plans.map(p=>{
          const ed = editedPlans[p.id]||{};
          return React.createElement('div',{key:p.id,className:'plan-row'},
            React.createElement('span',null,React.createElement('span',{className:'badge badge-'+p.name},p.name)),
            React.createElement('input',{className:'plan-input',type:'number',step:'0.01',defaultValue:p.price_usd||0,onChange:e=>setPlanField(p.id,'price_usd',parseFloat(e.target.value))}),
            React.createElement(UnlimitedInput,{value:(editedPlans[p.id]?.alert_limit??p.alert_limit),onChange:v=>setPlanField(p.id,'alert_limit',v)}),
            React.createElement(UnlimitedInput,{value:(editedPlans[p.id]?.history_days??p.history_days),onChange:v=>setPlanField(p.id,'history_days',v)}),
            editedPlans[p.id]
              ? React.createElement('button',{className:'btn btn-primary btn-sm',onClick:()=>savePlan(p),disabled:savingPlan},'Сохранить')
              : React.createElement('span',{style:{fontSize:12,color:'var(--text2)'}},p.sources?'src: '+p.sources:'')
          );
        })
      ),
      msg&&React.createElement('div',{className:'mt16',style:{}},React.createElement('span',{className:msg.includes('Ошибка')?'error-msg':'success-msg'},msg))
    ),

    // ── Feedback Weighting ──────────────────────────────────────────────
    React.createElement('div',{className:'broadcast-box'},
      React.createElement('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}},
        React.createElement('h3',{style:{margin:0}},'👍 Взвешенный фидбек'),
        React.createElement('label',{style:{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}},
          React.createElement('input',{
            type:'checkbox', checked:!!fbCfg.enabled,
            style:{accentColor:'var(--accent)',width:15,height:15,cursor:'pointer'},
            onChange:e=>setFbCfg(prev=>({...prev,enabled:e.target.checked}))
          }),
          React.createElement('span',{style:{color: fbCfg.enabled?'var(--accent)':'var(--text2)'}},
            fbCfg.enabled ? 'Включено' : 'Выключено'
          )
        )
      ),
      React.createElement('p',{style:{fontSize:12,color:'var(--text2)',marginTop:0,marginBottom:14}},
        fbCfg.enabled
          ? 'Реакции 👍 и 👎 учитываются с разным весом в зависимости от плана. Влияет на rankScore нарратива.'
          : '⚠️ Взвешивание выключено — учитываются только голоса Admin. Остальные игнорируются.'
      ),
      React.createElement('div',{style:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,opacity: fbCfg.enabled?1:0.4,pointerEvents: fbCfg.enabled?'auto':'none'}},
        ...[
          {key:'weightAdmin', label:'👑 Admin',  color:'#f87171'},
          {key:'weightPro',   label:'🚀 Pro',    color:'var(--accent)'},
          {key:'weightTest',  label:'🧪 Test',   color:'var(--text2)'},
          {key:'weightFree',  label:'🆓 Free',   color:'var(--text2)'},
        ].map(({key,label,color})=>
          React.createElement('div',{key,style:{background:'var(--bg3)',borderRadius:8,padding:'10px 12px',border:'1px solid var(--border)'}},
            React.createElement('div',{style:{fontSize:12,color,fontWeight:600,marginBottom:6}},label),
            React.createElement('div',{style:{display:'flex',alignItems:'center',gap:6}},
              React.createElement('input',{
                className:'plan-input',type:'number',min:0.1,max:10,step:0.1,
                style:{width:64},
                value: fbCfg[key] ?? 1,
                onChange: e=>setFbCfg(prev=>({...prev,[key]:parseFloat(e.target.value)||1}))
              }),
              React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},'× вес')
            )
          )
        )
      ),
      React.createElement('div',{style:{marginTop:14,display:'flex',alignItems:'center',gap:12}},
        React.createElement('button',{className:'btn btn-primary btn-sm',onClick:saveFbCfg,disabled:fbSaving},
          fbSaving ? 'Сохранение...' : 'Сохранить'
        ),
        React.createElement('span',{style:{fontSize:11,color:'var(--text2)'}},
          'Применяется к новым реакциям мгновенно, без перезапуска'
        )
      )
    )
  );
}

// ── App Root ──────────────────────────────────────────────────────────────────
function App() {
  const [authed, setAuthed] = useState(!!localStorage.getItem('adminKey'));
  const [tab, setTab] = useState('stats');

  if (!authed) return React.createElement(AuthOverlay,{onAuth:()=>setAuthed(true)});

  const TABS = [
    {id:'stats',     icon:'📊', label:'Статистика'},
    {id:'scanners',  icon:'⚙️',  label:'Сканеры'},
    {id:'decisions', icon:'🔔', label:'Алерты'},
    {id:'users',     icon:'👥', label:'Пользователи'},
    {id:'payments',  icon:'💳', label:'Платежи'},
    {id:'bot',       icon:'🤖', label:'Бот и планы'},
  ];

  const PAGE = {stats:StatsPage, scanners:ScannersPage, decisions:DecisionsPage, users:UsersPage, payments:PaymentsPage, bot:BotPage};
  const CurrentPage = PAGE[tab];

  return React.createElement('div',{className:'layout'},
    React.createElement('aside',{className:'sidebar'},
      React.createElement('div',{className:'logo'},
        React.createElement('h1',null,'Catalyst'),
        React.createElement('span',null,'Admin Panel')
      ),
      TABS.map(t=>React.createElement('div',{key:t.id,className:'nav-item'+(tab===t.id?' active':''),onClick:()=>setTab(t.id)},
        React.createElement('span',{className:'nav-icon'},t.icon),
        React.createElement('span',null,t.label)
      )),
      React.createElement('div',{style:{marginTop:'auto',padding:'16px 20px',borderTop:'1px solid var(--border)'}},
        React.createElement('button',{className:'btn btn-ghost btn-sm',style:{width:'100%',fontSize:11},onClick:()=>{localStorage.removeItem('adminKey');_apiKey='';setAuthed(false);}},
          '🚪 Выйти'
        )
      )
    ),
    React.createElement('main',{className:'main'},
      React.createElement(CurrentPage,null)
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
</script>
</body>
</html>`;
  }

  // ── Start ────────────────────────────────────────────────────────────────────
  start() {
    if (!this.adminKey) {
      this.logger.warn('ADMIN_API_KEY is not set — admin API is locked (set ADMIN_API_KEY to enable access)');
    }

    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch(e => {
        this.logger.error('Admin server error', { error: e.message });
        try { json(res, 500, { error: 'Internal error' }); } catch {}
      });
    });

    this.server.listen(this.port, this.host, () => {
      this.logger.info(`Admin panel running at http://${this.host}:${this.port}`);
    });

    this.server.on('error', e => this.logger.error('Admin server error', { error: e.message }));
  }

  stop() {
    this.server?.close();
  }
}

export default AdminServer;
