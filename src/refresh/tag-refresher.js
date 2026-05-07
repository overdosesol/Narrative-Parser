/**
 * Tag auto-refresh — periodic Grok call to propose fresh subreddits and
 * Twitter keyword groups for each preset's sources.
 *
 * Phase 2 (this revision):
 *   - Real xAI Responses API call: model `grok-4.3` (env XAI_TAG_REFRESH_MODEL),
 *     fallback `grok-4.20-0309-reasoning` on 5xx / model_not_found
 *   - Live Search via `tools: [{type:'x_search'}]` (same pattern as Stage 2 in scorer.js)
 *   - JSON output parsed manually — xAI Grok doesn't honour text.format=json_schema
 *     reliably (see scorer.js comment line 933-934)
 *   - Variant-3 reality-check: each PROPOSED Twitter keyword group is validated
 *     via 1 Apify Twitter probe — if 0 results, group is dropped before apply.
 *     Skipped for already-existing groups (they're known to work).
 *   - Diff vs current effective sources. Added/removed lists logged in
 *     tag_refresh_history audit row. Locked tags (from settings.presetTagsLocked)
 *     are NEVER removed — they survive any auto-refresh.
 *   - Cost tracking: USD per call computed from input/output tokens.
 *
 * Storage:
 *   settings.presetConfigsAuto         — sparse override blob (Grok-written)
 *   settings.presetTagsLocked          — per-tag pin lock-mask (Phase 3 will write)
 *   settings.tagAutoRefreshEnabled     — '0' | '1'
 *   settings.tagAutoRefreshLastRunAt   — ISO timestamp of last attempt
 *   settings.tagAutoRefreshFailureStreak — int, auto-disable when >= 3
 *
 * Merge order (resolved in preset-config.js getActivePresetConfig):
 *   DEFAULT_PRESET_CONFIGS  →  presetConfigsAuto  →  presetConfigs (manual)
 *   Manual ALWAYS wins on conflict.
 */

import { Agent } from 'undici';
import {
  PRESET_KEYS,
  DEFAULT_PRESET_CONFIGS,
  readPresetAutoOverrides,
  readPresetOverrides,
  readPresetTagsLocked,
} from '../analysis/preset-config.js';

// Long-running Grok calls (with x_search reasoning loops) routinely take
// 100-300s and exceed undici's default 5-min headers timeout. Custom
// dispatcher used per-request so other fetches in the process keep their
// own timeouts. Empirical: sanity-test 2026-05-07 measured 117s for animals
// preset with 9 x_search calls — extrapolating worst-case to 10-15 min
// allows headroom for celebrities/culture which are slang-heavy.
const XAI_LONG_AGENT = new Agent({
  headersTimeout: 15 * 60_000,
  bodyTimeout:    15 * 60_000,
  connectTimeout: 30_000,
});

const TAG_REFRESH_COOLDOWN_DAYS = Number(process.env.TAG_REFRESH_COOLDOWN_DAYS) || 7;
const TAG_REFRESH_FORCE_COOLDOWN_HOURS = Number(process.env.TAG_REFRESH_FORCE_COOLDOWN_HOURS) || 24;
const TAG_REFRESH_MODEL_PRIMARY = process.env.XAI_TAG_REFRESH_MODEL || 'grok-4.3';
const TAG_REFRESH_MODEL_FALLBACK = process.env.XAI_TAG_REFRESH_FALLBACK_MODEL || 'grok-4.20-0309-reasoning';

// xAI pricing (May 2026): grok-4.3 and grok-4.20-0309-reasoning both $1.25/$2.50 per 1M tokens
const PRICE_INPUT_PER_M  = 1.25;
const PRICE_OUTPUT_PER_M = 2.50;

// xAI Live Search tool — Grok physically queries X / web for fresh evidence
// instead of guessing from training data. Critical for slang anchor freshness:
// without this, Grok hallucinates terms to comply with "fresh 2026 slang" prompt.
const X_SEARCH_TOOL = {
  type: 'x_search',
  max_search_results: 20,
  return_citations: false,
};

// Apify Twitter probe — for variant-3 reality-check on PROPOSED keyword groups.
// 5 results is enough to confirm "this query returns SOME tweets" — we don't
// care about volume, just non-zero existence.
const APIFY_PROBE_MIN_FAVES = 100;
const APIFY_PROBE_MAX_ITEMS = 5;

// Reddit reality-check — Grok routinely hallucinates plausible-sounding
// subreddit names that don't exist. We hit reddit.com/r/<name>/about.json
// (free public endpoint, ~10 req/min unauthenticated rate limit) to confirm
// each PROPOSED subreddit actually exists before applying it.
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'Catalyst:tag-refresher:v1.0';
const REDDIT_PROBE_DELAY_MS = 6_500;          // 6.5s between probes — safe margin under 10/min
const REDDIT_PROBE_TIMEOUT_MS = 8_000;        // per-request timeout
const REDDIT_PROBE_NETWORK_ERROR_BAILOUT = 3; // after 3 consecutive net errors, pass-through rest

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class TagRefresher {
  constructor({ db, logger, config = {}, twitter = null, telegram = null }) {
    this.db = db;
    this.logger = logger;
    this.config = config;
    this.twitter = twitter;    // TwitterCollector instance, used for reality-check probes
    this.telegram = telegram;  // TelegramNotifier — used to DM admins after each refresh cycle
  }

  // ── Toggle / status ─────────────────────────────────────────────────────
  isEnabled() {
    return String(this.db.getSetting('tagAutoRefreshEnabled', '1')) !== '0';
  }

  setEnabled(enabled) {
    this.db.setSetting('tagAutoRefreshEnabled', enabled ? '1' : '0');
    this.logger?.info?.(`[TagRefresher] toggle → ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  getStatus() {
    const lastRunAt = this.db.getSetting('tagAutoRefreshLastRunAt', null);
    const failureStreak = Number(this.db.getSetting('tagAutoRefreshFailureStreak', '0')) || 0;
    const enabled = this.isEnabled();
    const cooldownMs = TAG_REFRESH_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const forceCooldownMs = TAG_REFRESH_FORCE_COOLDOWN_HOURS * 60 * 60 * 1000;
    const lastTs = lastRunAt ? new Date(lastRunAt).getTime() : 0;
    const nextRunAt = lastTs ? new Date(lastTs + cooldownMs).toISOString() : null;
    const nextForceAt = lastTs ? new Date(lastTs + forceCooldownMs).toISOString() : null;
    return {
      enabled,
      lastRunAt: lastRunAt || null,
      nextRunAt,
      nextForceAt,
      failureStreak,
      cooldownDays: TAG_REFRESH_COOLDOWN_DAYS,
      forceCooldownHours: TAG_REFRESH_FORCE_COOLDOWN_HOURS,
      model: TAG_REFRESH_MODEL_PRIMARY,
      fallbackModel: TAG_REFRESH_MODEL_FALLBACK,
      autoOverrides: readPresetAutoOverrides(this.db),
      lockedTags: readPresetTagsLocked(this.db),
      circuitBreakerOpen: failureStreak >= 3,
      twitterReady: !!this.twitter,
    };
  }

  resetCircuitBreaker() {
    this.db.setSetting('tagAutoRefreshFailureStreak', '0');
    this.logger?.info?.(`[TagRefresher] circuit breaker manually reset`);
  }

  // ── Gate checks ─────────────────────────────────────────────────────────
  shouldRefreshNow() {
    if (!this.isEnabled()) return { ok: false, reason: 'disabled' };
    const failureStreak = Number(this.db.getSetting('tagAutoRefreshFailureStreak', '0')) || 0;
    if (failureStreak >= 3) return { ok: false, reason: 'circuit_breaker_open' };
    const lastRunAt = this.db.getSetting('tagAutoRefreshLastRunAt', null);
    if (!lastRunAt) return { ok: true, reason: 'first_run' };
    const lastTs = new Date(lastRunAt).getTime();
    const cooldownMs = TAG_REFRESH_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - lastTs < cooldownMs) {
      const remainingHours = Math.ceil((cooldownMs - (Date.now() - lastTs)) / 3600000);
      return { ok: false, reason: 'cooldown', remainingHours };
    }
    return { ok: true, reason: 'cooldown_expired' };
  }

  canForceNow() {
    if (!this.isEnabled()) return { ok: false, reason: 'disabled' };
    const lastRunAt = this.db.getSetting('tagAutoRefreshLastRunAt', null);
    if (!lastRunAt) return { ok: true, reason: 'first_run' };
    const lastTs = new Date(lastRunAt).getTime();
    const forceCooldownMs = TAG_REFRESH_FORCE_COOLDOWN_HOURS * 60 * 60 * 1000;
    if (Date.now() - lastTs < forceCooldownMs) {
      const remaining = Math.ceil((forceCooldownMs - (Date.now() - lastTs)) / 60000);
      return { ok: false, reason: 'force_cooldown', remainingMinutes: remaining };
    }
    return { ok: true, reason: 'ok' };
  }

  // ── Core refresh loop ───────────────────────────────────────────────────
  async refreshAll(opts = {}) {
    const isForce = !!opts.force;
    const gate = isForce ? this.canForceNow() : this.shouldRefreshNow();
    if (!gate.ok) {
      this.logger?.info?.(`[TagRefresher] refresh skipped: ${gate.reason}`);
      return { ok: false, reason: gate.reason, ...gate };
    }

    if (!process.env.XAI_API_KEY) {
      this.logger?.error?.(`[TagRefresher] XAI_API_KEY missing — refresh disabled`);
      return { ok: false, reason: 'no_api_key' };
    }

    const startedAt = Date.now();
    const results = [];
    let anyFailure = false;
    let totalCost = 0;

    this.logger?.info?.(`[TagRefresher] starting refresh (force=${isForce}, model=${TAG_REFRESH_MODEL_PRIMARY})`);

    for (const preset of PRESET_KEYS) {
      try {
        const result = await this._refreshPreset(preset);
        totalCost += result.costUsd || 0;
        results.push({ preset, ...result });
      } catch (e) {
        anyFailure = true;
        this.db.recordTagRefresh({
          preset,
          sourceType: 'all',
          status: 'error',
          diff: null,
          errorMessage: String(e?.message || e),
          model: TAG_REFRESH_MODEL_PRIMARY,
          costUsd: 0,
        });
        results.push({ preset, status: 'error', error: String(e?.message || e) });
        this.logger?.error?.(`[TagRefresher] preset=${preset} failed: ${e?.message || e}`);
      }
    }

    this.db.setSetting('tagAutoRefreshLastRunAt', new Date().toISOString());
    const newStreak = anyFailure
      ? (Number(this.db.getSetting('tagAutoRefreshFailureStreak', '0')) || 0) + 1
      : 0;
    this.db.setSetting('tagAutoRefreshFailureStreak', String(newStreak));
    if (newStreak >= 3) {
      this.logger?.warn?.(`[TagRefresher] circuit breaker tripped (${newStreak} consecutive failures) — manual reset required`);
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger?.info?.(`[TagRefresher] done in ${elapsedSec}s — ${results.length} presets, anyFailure=${anyFailure}, cost=$${totalCost.toFixed(3)}`);

    // Post-cycle Telegram digest to admins (best-effort; never fails the run).
    // Skipped when no telegram instance is wired — index.js may decide not to
    // pass one (eg. dev environments without a bot token).
    try {
      await this._notifyAdmins({ results, totalCost, elapsedSec, anyFailure, isForce, newStreak });
    } catch (e) {
      this.logger?.warn?.(`[TagRefresher] admin notify failed: ${e.message}`);
    }

    return { ok: true, results, elapsedSec, anyFailure, totalCost };
  }

  // ── Admin Telegram digest ────────────────────────────────────────────────
  // Sent after every refreshAll() — success OR failure, force OR scheduled.
  // Only admins (plan_name === 'admin') receive it. Best-effort: errors are
  // logged but never propagate up. The message is HTML-formatted, capped at
  // ~3500 chars so we don't hit Telegram's 4096 limit even if Grok proposed
  // 50+ subs per preset.
  async _notifyAdmins({ results, totalCost, elapsedSec, anyFailure, isForce, newStreak }) {
    if (!this.telegram?.bot) return;  // no bot wired — silent skip
    const admins = this._getAdminChatIds();
    if (admins.length === 0) {
      this.logger?.debug?.('[TagRefresher] no admins to notify (no plan_name=admin users)');
      return;
    }

    const html = this._formatAdminDigestHtml({
      results, totalCost, elapsedSec, anyFailure, isForce, newStreak,
    });

    for (const chatId of admins) {
      try {
        await this.telegram.bot.sendMessage(chatId, html, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (e) {
        this.logger?.warn?.(`[TagRefresher] notify chat ${chatId} failed: ${e.message}`);
      }
    }
  }

  _getAdminChatIds() {
    try {
      const all = this.db.getActiveUsers ? this.db.getActiveUsers() : [];
      return all
        .filter(u => u.plan_name === 'admin' && u.telegram_chat_id)
        .map(u => String(u.telegram_chat_id));
    } catch (e) {
      this.logger?.warn?.(`[TagRefresher] getAdminChatIds failed: ${e.message}`);
      return [];
    }
  }

  // HTML digest. Uses Telegram-flavoured tags only (b/i/code/pre/a). Avoids
  // \n inside string literals (SPA-template-literal shim is irrelevant here
  // since this file isn't an SPA, but consistency with other server-side
  // HTML helpers in the codebase keeps muscle memory clean).
  _formatAdminDigestHtml({ results, totalCost, elapsedSec, anyFailure, isForce, newStreak }) {
    const NL = String.fromCharCode(10);
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const trigger = isForce ? 'Force refresh' : 'Scheduled refresh';
    const statusEmoji = anyFailure ? '⚠️' : '✅';
    const lines = [];

    lines.push(`${statusEmoji} <b>Tag auto-refresh — ${trigger}</b>`);
    lines.push(`<i>${results.length} presets · ${elapsedSec}s · $${totalCost.toFixed(3)}</i>`);
    if (newStreak >= 3) {
      lines.push(`🚨 <b>Circuit breaker tripped</b> — ${newStreak} consecutive failures. Manual reset required in admin panel.`);
    } else if (anyFailure) {
      lines.push(`⚠️ Failure streak now: <b>${newStreak}</b>`);
    }
    lines.push('');

    // Per-preset block
    for (const r of results) {
      const status = r.status || 'unknown';
      const presetEmoji = status === 'applied' ? '🔄'
                       : status === 'no-op'    ? '·'
                       : status === 'rejected_validation' ? '✗'
                       : status === 'error'    ? '⚠️'
                       : '?';
      const costStr = r.costUsd ? `$${r.costUsd.toFixed(3)}` : '—';
      lines.push(`${presetEmoji} <b>${esc(r.preset)}</b> — <code>${esc(status)}</code> · ${costStr}`);

      if (r.error) {
        lines.push(`   <i>error: ${esc(r.error.slice(0, 200))}</i>`);
      } else if (r.diff) {
        const d = r.diff;
        const fmtList = (arr, max = 6) => {
          if (!Array.isArray(arr) || arr.length === 0) return null;
          const shown = arr.slice(0, max).map(s => esc(s)).join(', ');
          const more = arr.length > max ? ` <i>(+${arr.length - max} more)</i>` : '';
          return shown + more;
        };
        const addedSubs = fmtList(d.addedSubs);
        if (addedSubs)   lines.push(`   <b>+ subs:</b> ${addedSubs}`);
        const removedSubs = fmtList(d.removedSubs);
        if (removedSubs) lines.push(`   <b>− subs:</b> ${removedSubs}`);
        const addedTw = fmtList(d.addedTwitter);
        if (addedTw)     lines.push(`   <b>+ tw:</b> ${addedTw}`);
        const removedTw = fmtList(d.removedTwitter);
        if (removedTw)   lines.push(`   <b>− tw:</b> ${removedTw}`);
        const addedTk = fmtList(d.addedTiktok);
        if (addedTk)     lines.push(`   <b>+ tiktok:</b> ${addedTk}`);
        const removedTk = fmtList(d.removedTiktok);
        if (removedTk)   lines.push(`   <b>− tiktok:</b> ${removedTk}`);
        if (!addedSubs && !removedSubs && !addedTw && !removedTw && !addedTk && !removedTk) {
          lines.push(`   <i>no changes</i>`);
        }
      }
    }

    lines.push('');
    lines.push(`<i>Open admin panel → Auto-tags for full diff & history.</i>`);

    let html = lines.join(NL);
    // Telegram caps at 4096; trim conservatively at 3800 with an ellipsis tail.
    if (html.length > 3800) {
      html = html.slice(0, 3800) + NL + '<i>... (digest truncated, see admin panel)</i>';
    }
    return html;
  }

  // ── Per-preset refresh ──────────────────────────────────────────────────
  async _refreshPreset(preset) {
    // 1. Build prompt with EXISTING list across all 5 presets (anti-duplicate)
    const existing = this._buildExistingList();
    const prompt = this._buildPrompt(preset, existing);

    // 2. Grok call with x_search Live Search tool + fallback model
    const { parsed, model, costUsd, inputTokens, outputTokens, rawText } =
      await this._callGrokWithFallback(prompt);

    // 3. Sanitize + validate output structure
    const sanitized = this._sanitizeResponse(parsed);
    if (sanitized.subreddits.length === 0
        && sanitized.twitter_keywords.length === 0
        && sanitized.tiktok_hashtags.length === 0) {
      this.db.recordTagRefresh({
        preset, sourceType: 'all', status: 'rejected_validation',
        diff: null,
        errorMessage: `Empty after sanitization. Raw text head: ${rawText.substring(0, 200)}`,
        model, costUsd,
      });
      return { status: 'rejected_validation', costUsd, model };
    }

    // 4a. Reddit reality-check — probe each PROPOSED subreddit via free
    //     /r/<name>/about.json endpoint to filter Grok hallucinations
    //     (model invents plausible-sounding subs that don't exist).
    const verifiedSubs = await this._realityCheckSubreddits(sanitized.subreddits, preset);

    // 4b. Variant-3 reality-check on Twitter keyword groups (probe each PROPOSED group)
    const verifiedTwitter = await this._realityCheckTwitter(sanitized.twitter_keywords, preset);

    // 4c. TikTok hashtags — no reality-check by design. Probing each tag would
    //     require a paid Apify call, and the cost-benefit is bad: if Grok
    //     hallucinates a non-existent hashtag, TikTok's collector simply gets
    //     zero results for that cycle and the system continues. Soft-fail
    //     beats paying for verification of every tag every week.
    const verifiedTiktok = sanitized.tiktok_hashtags;

    // 5. Compute diff vs current effective sources, respecting locked tags
    const diff = this._computeDiff(preset, {
      subreddits: verifiedSubs,
      twitter_keywords: verifiedTwitter,
      tiktok_hashtags: verifiedTiktok,
    });

    // 6. Apply to settings.presetConfigsAuto (sparse blob; only fields differing
    //    from defaults are stored — minimizes surface for stale auto-data).
    const status = this._applyAutoOverride(preset, diff);

    this.db.recordTagRefresh({
      preset, sourceType: 'all', status,
      diff,
      errorMessage: null,
      model, costUsd,
    });

    return {
      status, costUsd, model, inputTokens, outputTokens,
      addedCount: diff.addedSubs.length + diff.addedTwitter.length,
      diff,  // exposed so refreshAll can pass it to admin Telegram digest
    };
  }

  // ── Grok call with fallback model on 5xx / model_not_found ──────────────
  async _callGrokWithFallback(prompt) {
    const input = [
      { role: 'system', content: TAG_REFRESH_SYSTEM_PROMPT },
      { role: 'user',   content: prompt },
    ];
    try {
      return await this._callXaiResponses({
        model: TAG_REFRESH_MODEL_PRIMARY,
        input,
        tools: [X_SEARCH_TOOL],
        temperature: 0.3,
      });
    } catch (e) {
      const isTransient = e.status >= 500 || /model.*not.*found|not.*available|invalid.*model/i.test(e.message || '');
      if (!isTransient) throw e;
      this.logger?.warn?.(`[TagRefresher] primary model failed (${e.message}), falling back to ${TAG_REFRESH_MODEL_FALLBACK}`);
      return await this._callXaiResponses({
        model: TAG_REFRESH_MODEL_FALLBACK,
        input,
        tools: [X_SEARCH_TOOL],
        temperature: 0.3,
      });
    }
  }

  // ── Standalone xAI Responses API client ─────────────────────────────────
  async _callXaiResponses({ model, input, tools, temperature }) {
    const baseUrl = process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
    const apiKey = process.env.XAI_API_KEY || '';

    const body = { model, input };
    if (tools && tools.length > 0) body.tools = tools;
    // Note: tool_choice='required' is NOT used. xAI Responses API drops the
    // connection (UND_ERR_SOCKET) instead of returning 400 when given that
    // parameter. Grok obeys the prompt-level mandate ("MUST invoke x_search
    // 3+ times") reliably — sanity-test 2026-05-07 measured 9 calls per
    // preset with the strengthened system prompt.
    if (temperature !== undefined) body.temperature = temperature;
    // Hard cap consecutive x_search calls — without this, Grok happily fans
    // out 4+ searches per response and quadruples input tokens via accumulated
    // tool results (same trap scorer.js Stage 2 hit).
    body.max_tool_calls = 5;

    const r = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      dispatcher: XAI_LONG_AGENT,  // 15-min timeout for long Grok+x_search calls
    }).catch(err => {
      const cause = err.cause?.message || err.cause?.code || '';
      throw new Error(`xAI fetch error: ${err.message}${cause ? ' (cause: ' + cause + ')' : ''}`);
    });
    if (!r.ok) {
      const t = await r.text();
      const err = new Error(`xAI ${r.status}: ${t.substring(0, 400)}`);
      err.status = r.status;
      err.errorText = t;
      throw err;
    }
    const data = await r.json();

    // Extract text from output[].content[]
    let text = '';
    for (const out of (data.output || [])) {
      if (out.type === 'message' && Array.isArray(out.content)) {
        for (const c of out.content) {
          if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
        }
      }
    }
    if (!text) throw new Error('Empty text in xAI response');

    const inputTokens = Number(data.usage?.input_tokens) || 0;
    const outputTokens = Number(data.usage?.output_tokens) || 0;
    const costUsd = (inputTokens * PRICE_INPUT_PER_M + outputTokens * PRICE_OUTPUT_PER_M) / 1_000_000;

    const parsed = this._parseJson(text);

    return { parsed, model, costUsd, inputTokens, outputTokens, rawText: text };
  }

  _parseJson(text) {
    let clean = String(text || '').trim();
    // Strip markdown fences if present
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) clean = fence[1].trim();
    // Sometimes Grok wraps prose around JSON — extract first balanced object
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      clean = clean.substring(firstBrace, lastBrace + 1);
    }
    return JSON.parse(clean);
  }

  // ── Sanitize + validate Grok output ─────────────────────────────────────
  _sanitizeResponse(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      return { subreddits: [], twitter_keywords: [], tiktok_hashtags: [] };
    }
    // Subreddit name regex: alphanumeric + underscore, 2-40 chars, no r/ prefix
    const validSub = (s) => /^[a-zA-Z0-9_]{2,40}$/.test(s);
    const subreddits = (Array.isArray(parsed.subreddits) ? parsed.subreddits : [])
      .map(item => {
        if (typeof item === 'string') return item;
        return String(item?.name || '').trim();
      })
      .map(s => s.replace(/^\/?r\//i, '').trim())
      .filter(s => validSub(s));

    // Twitter keyword group regex: must be wrapped in (...) and contain no
    // numbers/operators (we add min_faves and -is:retweet in collector).
    const validGroup = (g) => /^\(.+\)$/.test(g) && !/min_faves|-is:retweet|\d+/i.test(g);
    const twitter_keywords = (Array.isArray(parsed.twitter_keywords) ? parsed.twitter_keywords : [])
      .map(item => {
        if (typeof item === 'string') return item;
        return String(item?.group || '').trim();
      })
      .filter(g => g.length > 0 && g.length < 300 && validGroup(g));

    // TikTok hashtag regex: alphanumeric + underscore, 2-40 chars, no leading
    // "#" or "/", no spaces. We strip "#" defensively even though prompt
    // forbids it. Lowercased for stable dedup downstream.
    const validTiktokTag = (s) => /^[a-z0-9_]{2,40}$/.test(s);
    const tiktok_hashtags = (Array.isArray(parsed.tiktok_hashtags) ? parsed.tiktok_hashtags : [])
      .map(item => {
        if (typeof item === 'string') return item;
        return String(item?.name || '').trim();
      })
      .map(s => s.replace(/^#+/, '').replace(/\s+/g, '').toLowerCase().trim())
      .filter(s => validTiktokTag(s));

    // Dedupe (case-insensitive for subs)
    const seenSubs = new Set();
    const uniqueSubs = subreddits.filter(s => {
      const lc = s.toLowerCase();
      if (seenSubs.has(lc)) return false;
      seenSubs.add(lc);
      return true;
    });
    const seenGroups = new Set();
    const uniqueGroups = twitter_keywords.filter(g => {
      if (seenGroups.has(g)) return false;
      seenGroups.add(g);
      return true;
    });
    const seenTags = new Set();
    const uniqueTags = tiktok_hashtags.filter(t => {
      if (seenTags.has(t)) return false;
      seenTags.add(t);
      return true;
    });

    return { subreddits: uniqueSubs, twitter_keywords: uniqueGroups, tiktok_hashtags: uniqueTags };
  }

  // ── Variant-3 reality-check: probe each PROPOSED Twitter keyword group ──
  async _realityCheckTwitter(proposedGroups, preset) {
    if (!this.twitter || typeof this.twitter.searchByQuery !== 'function') {
      this.logger?.warn?.(`[TagRefresher] twitter instance missing — skipping reality-check for preset=${preset}`);
      return proposedGroups;  // pass-through if no probe available
    }
    if (proposedGroups.length === 0) return proposedGroups;

    // Filter out groups already in current sources — they're known to work.
    const currentTwitter = this._getCurrentTwitterKeywordParts(preset);
    const currentSet = new Set(currentTwitter.map(s => s.toLowerCase()));
    const toProbe = proposedGroups.filter(g => !currentSet.has(g.toLowerCase()));
    const toKeep = proposedGroups.filter(g => currentSet.has(g.toLowerCase()));

    const verified = [...toKeep];
    for (const group of toProbe) {
      try {
        // Construct a minimal-faves probe query just to check non-zero
        const probeQuery = `${group} min_faves:${APIFY_PROBE_MIN_FAVES} -is:retweet`;
        const tweets = await this.twitter.searchByQuery(probeQuery, APIFY_PROBE_MAX_ITEMS, { relaxedFloor: true });
        if (Array.isArray(tweets) && tweets.length > 0) {
          verified.push(group);
          this.logger?.debug?.(`[TagRefresher] probe ✓ "${group}" (${tweets.length} tweets)`);
        } else {
          this.logger?.info?.(`[TagRefresher] probe ✗ "${group}" — 0 results, dropped`);
        }
      } catch (e) {
        // Probe failed — be conservative, drop the group rather than apply unverified
        this.logger?.warn?.(`[TagRefresher] probe error "${group}": ${e.message} — dropped`);
      }
    }
    return verified;
  }

  // ── Reality-check: probe each PROPOSED subreddit via Reddit public API ──
  // Grok hallucinates ~20-30% of subreddit names (sounds-plausible-but-doesn't-
  // exist pattern: r/cuteanimalvideos, r/memesofthe2020s, etc). This filters
  // them out before they contaminate the active source list.
  //
  // Skips subreddits already in effective sources — they're known to work,
  // probing them wastes the rate-limit budget. Bails out if Reddit is
  // unreachable (3+ consecutive network errors): conservative approach
  // would wipe everything, which is worse than letting one cycle through
  // unverified.
  async _realityCheckSubreddits(proposedSubs, preset) {
    if (!Array.isArray(proposedSubs) || proposedSubs.length === 0) return proposedSubs;

    const currentSubs = new Set(
      this._getCurrentSubreddits(preset).map(s => s.toLowerCase())
    );
    const toProbe = proposedSubs.filter(s => !currentSubs.has(s.toLowerCase()));
    const toKeep  = proposedSubs.filter(s =>  currentSubs.has(s.toLowerCase()));

    if (toProbe.length === 0) return proposedSubs;

    const verified = [...toKeep];
    let networkErrorStreak = 0;
    let bailedOut = false;

    for (let i = 0; i < toProbe.length; i++) {
      const name = toProbe[i];
      if (bailedOut) {
        // Reddit unreachable — pass remaining through unverified
        verified.push(name);
        continue;
      }
      try {
        const result = await this._probeSubreddit(name);
        if (result.networkError) {
          networkErrorStreak++;
          this.logger?.warn?.(`[TagRefresher] reddit probe net-err /r/${name}: ${result.reason} (streak=${networkErrorStreak})`);
          if (networkErrorStreak >= REDDIT_PROBE_NETWORK_ERROR_BAILOUT) {
            bailedOut = true;
            this.logger?.warn?.(`[TagRefresher] reddit unreachable — passing remaining ${toProbe.length - i} subs through unverified`);
          }
          // Conservative on individual net-err: keep the sub (don't drop on flake)
          verified.push(name);
        } else if (result.exists) {
          networkErrorStreak = 0;
          verified.push(name);
          this.logger?.debug?.(`[TagRefresher] reddit ✓ /r/${name} (${result.subreddit_type || 'public'}, ${result.subscribers ?? '?'} subs)`);
        } else {
          networkErrorStreak = 0;
          this.logger?.info?.(`[TagRefresher] reddit ✗ /r/${name} — ${result.reason}, dropped`);
        }
      } catch (e) {
        networkErrorStreak++;
        verified.push(name);  // keep on unexpected error — conservative
        this.logger?.warn?.(`[TagRefresher] reddit probe threw /r/${name}: ${e.message}`);
        if (networkErrorStreak >= REDDIT_PROBE_NETWORK_ERROR_BAILOUT) {
          bailedOut = true;
          this.logger?.warn?.(`[TagRefresher] reddit probe bailout — passing remaining ${toProbe.length - i - 1} subs through unverified`);
        }
      }
      // Throttle for next iteration (skip after last)
      if (i < toProbe.length - 1 && !bailedOut) await sleep(REDDIT_PROBE_DELAY_MS);
    }
    return verified;
  }

  // Single Reddit probe. Returns { exists, reason, subreddit_type?, subscribers?, networkError? }.
  async _probeSubreddit(name) {
    const url = 'https://www.reddit.com/r/' + encodeURIComponent(name) + '/about.json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REDDIT_PROBE_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': REDDIT_USER_AGENT,
          'Accept': 'application/json',
        },
      });
    } catch (e) {
      clearTimeout(timer);
      return { exists: false, networkError: true, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
    clearTimeout(timer);

    if (response.status === 404) return { exists: false, reason: '404 (not found)' };
    if (response.status === 403) return { exists: false, reason: '403 (private/banned)' };
    if (response.status === 451) return { exists: false, reason: '451 (legal block)' };
    if (response.status === 429) {
      // Rate-limited — be conservative and treat as exists rather than drop
      return { exists: true, reason: '429 rate-limited (assumed exists)' };
    }
    if (!response.ok) {
      return { exists: false, networkError: true, reason: 'HTTP ' + response.status };
    }

    let data;
    try { data = await response.json(); }
    catch (e) { return { exists: false, networkError: true, reason: 'json parse: ' + e.message }; }

    // Reddit returns { kind: "t5", data: {...} } for valid subreddit;
    // { kind: "Listing", data: { children: [] } } for non-existent /r/<name>
    if (data && data.kind === 't5' && data.data && data.data.display_name) {
      return {
        exists: true,
        subreddit_type: data.data.subreddit_type,
        subscribers:    data.data.subscribers,
      };
    }
    return { exists: false, reason: 'unexpected response shape' };
  }

  _getCurrentSubreddits(preset) {
    // Effective subreddits for this preset (defaults + auto + manual layers).
    const auto   = readPresetAutoOverrides(this.db)[preset]?.sources?.reddit?.subreddits;
    const manual = readPresetOverrides(this.db)[preset]?.sources?.reddit?.subreddits;
    const def    = DEFAULT_PRESET_CONFIGS[preset]?.sources?.reddit?.subreddits || [];
    if (Array.isArray(manual)) return manual;
    if (Array.isArray(auto))   return auto;
    return def;
  }

  _getCurrentTwitterKeywordParts(preset) {
    // Effective Twitter queries for this preset (defaults + auto + manual layers).
    // We extract just the keyword-group part (strip min_faves and -is:retweet).
    const effective = readPresetAutoOverrides(this.db)[preset]?.sources?.twitter?.queries
                    || readPresetOverrides(this.db)[preset]?.sources?.twitter?.queries
                    || DEFAULT_PRESET_CONFIGS[preset]?.sources?.twitter?.queries
                    || [];
    return effective.map(q =>
      q.replace(/\s*min_faves:\d+\s*/g, '').replace(/\s*-is:retweet\s*/g, '').trim()
    ).filter(Boolean);
  }

  // ── EXISTING list across all 5 presets (anti-duplicate prompt input) ────
  _buildExistingList() {
    const allSubs = new Set();
    const allKeywords = new Set();
    const allTiktokTags = new Set();
    for (const preset of PRESET_KEYS) {
      const cfg = DEFAULT_PRESET_CONFIGS[preset];
      for (const s of (cfg?.sources?.reddit?.subreddits || [])) allSubs.add(s);
      for (const q of (cfg?.sources?.twitter?.queries || [])) {
        const keywordPart = q
          .replace(/\s*min_faves:\d+\s*/g, '')
          .replace(/\s*-is:retweet\s*/g, '')
          .trim();
        if (keywordPart) allKeywords.add(keywordPart);
      }
      for (const t of (cfg?.sources?.tiktok?.hashtags || [])) {
        allTiktokTags.add(String(t).toLowerCase());
      }
    }
    return {
      subreddits: Array.from(allSubs),
      twitter_keywords: Array.from(allKeywords),
      tiktok_hashtags: Array.from(allTiktokTags),
    };
  }

  // ── Diff computation respecting locked tags ─────────────────────────────
  _computeDiff(preset, proposed) {
    const lockedAll = readPresetTagsLocked(this.db);
    const lockedSubs = (lockedAll[preset]?.reddit || []).map(s => s.toLowerCase());
    const lockedTwitter = (lockedAll[preset]?.twitter || []).map(s => s.toLowerCase());
    const lockedTiktok = (lockedAll[preset]?.tiktok || []).map(s => s.toLowerCase());

    const currentSubs = DEFAULT_PRESET_CONFIGS[preset]?.sources?.reddit?.subreddits || [];
    const currentTwitterParts = (DEFAULT_PRESET_CONFIGS[preset]?.sources?.twitter?.queries || [])
      .map(q => q.replace(/\s*min_faves:\d+\s*/g, '').replace(/\s*-is:retweet\s*/g, '').trim());
    const currentTiktok = DEFAULT_PRESET_CONFIGS[preset]?.sources?.tiktok?.hashtags || [];

    const proposedSubsSet = new Set(proposed.subreddits.map(s => s.toLowerCase()));
    const currentSubsSet = new Set(currentSubs.map(s => s.toLowerCase()));
    const proposedTwSet = new Set(proposed.twitter_keywords.map(s => s.toLowerCase()));
    const currentTwSet = new Set(currentTwitterParts.map(s => s.toLowerCase()));
    const proposedTiktokSet = new Set(proposed.tiktok_hashtags.map(s => s.toLowerCase()));
    const currentTiktokSet = new Set(currentTiktok.map(s => s.toLowerCase()));

    return {
      addedSubs:    proposed.subreddits.filter(s => !currentSubsSet.has(s.toLowerCase())),
      keptSubs:     currentSubs.filter(s => proposedSubsSet.has(s.toLowerCase()) || lockedSubs.includes(s.toLowerCase())),
      removedSubs:  currentSubs.filter(s => !proposedSubsSet.has(s.toLowerCase()) && !lockedSubs.includes(s.toLowerCase())),

      addedTwitter:    proposed.twitter_keywords.filter(g => !currentTwSet.has(g.toLowerCase())),
      keptTwitter:     currentTwitterParts.filter(g => proposedTwSet.has(g.toLowerCase()) || lockedTwitter.includes(g.toLowerCase())),
      removedTwitter:  currentTwitterParts.filter(g => !proposedTwSet.has(g.toLowerCase()) && !lockedTwitter.includes(g.toLowerCase())),

      addedTiktok:    proposed.tiktok_hashtags.filter(t => !currentTiktokSet.has(t.toLowerCase())),
      keptTiktok:     currentTiktok.filter(t => proposedTiktokSet.has(t.toLowerCase()) || lockedTiktok.includes(t.toLowerCase())),
      removedTiktok:  currentTiktok.filter(t => !proposedTiktokSet.has(t.toLowerCase()) && !lockedTiktok.includes(t.toLowerCase())),
    };
  }

  // ── Apply diff to settings.presetConfigsAuto blob ───────────────────────
  // Auto-blob is sparse — store only sources fields the auto-layer wants to override.
  // Rebuild final list = (locked + kept) ∪ added. Note: Twitter queries need
  // re-attachment of min_faves and -is:retweet — defaults retain those numeric
  // floors, so we copy them verbatim from DEFAULT_PRESET_CONFIGS per query slot.
  _applyAutoOverride(preset, diff) {
    const defaults = DEFAULT_PRESET_CONFIGS[preset]?.sources || {};
    const defaultRedditMeta = {
      minUpvotes:        defaults.reddit?.minUpvotes        ?? 5000,
      postsPerSubreddit: defaults.reddit?.postsPerSubreddit ?? 50,
    };
    // Use the median min_faves from defaults to apply to NEW queries.
    // Existing queries keep their original numbers (re-extracted below).
    const defaultQueries = defaults.twitter?.queries || [];
    const minFavesValues = defaultQueries
      .map(q => Number((q.match(/min_faves:(\d+)/) || [])[1]) || 0)
      .filter(n => n > 0);
    const defaultMinFaves = minFavesValues.length > 0
      ? minFavesValues.sort((a, b) => a - b)[Math.floor(minFavesValues.length / 2)]
      : 10000;

    // Final subreddits = kept ∪ added (already excludes removed; locked are in kept)
    const finalSubs = [...new Set([...diff.keptSubs, ...diff.addedSubs])];

    // Final Twitter queries: kept ones recover their original min_faves;
    // added ones get the median min_faves + -is:retweet.
    const queryByPart = new Map();
    for (const q of defaultQueries) {
      const part = q.replace(/\s*min_faves:\d+\s*/g, '').replace(/\s*-is:retweet\s*/g, '').trim();
      queryByPart.set(part.toLowerCase(), q);
    }
    const finalTwitter = [
      ...diff.keptTwitter.map(part => queryByPart.get(part.toLowerCase()) || `${part} min_faves:${defaultMinFaves} -is:retweet`),
      ...diff.addedTwitter.map(part => `${part} min_faves:${defaultMinFaves} -is:retweet`),
    ];

    // Final TikTok hashtags = kept ∪ added (lowercase, no leading #).
    const finalTiktok = [...new Set([...diff.keptTiktok, ...diff.addedTiktok])]
      .map(t => String(t).toLowerCase().replace(/^#+/, ''));

    // Read current auto-blob, merge this preset's slot
    const auto = readPresetAutoOverrides(this.db);
    if (!auto[preset]) auto[preset] = {};
    if (!auto[preset].sources) auto[preset].sources = {};
    auto[preset].sources.reddit = {
      subreddits: finalSubs,
      ...defaultRedditMeta,
    };
    auto[preset].sources.twitter = { queries: finalTwitter };
    auto[preset].sources.tiktok = { hashtags: finalTiktok };

    // Cleanup: if applied set equals defaults exactly, drop the auto-slot for this preset.
    // (Avoids polluting auto-blob with no-op overrides.)
    const subsEqDefault = arraysEqIgnoreCase(finalSubs, defaults.reddit?.subreddits || []);
    const twEqDefault = arraysEq(finalTwitter, defaultQueries);
    const tiktokEqDefault = arraysEqIgnoreCase(finalTiktok, defaults.tiktok?.hashtags || []);
    if (subsEqDefault && twEqDefault && tiktokEqDefault) {
      delete auto[preset];
      this.db.setSetting('presetConfigsAuto', Object.keys(auto).length > 0 ? JSON.stringify(auto) : '');
      return 'skipped_no_diff';
    }

    this.db.setSetting('presetConfigsAuto', JSON.stringify(auto));
    return 'applied';
  }

  _isApiAvailable() {
    return !!process.env.XAI_API_KEY;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function arraysEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function arraysEqIgnoreCase(a, b) {
  if (a.length !== b.length) return false;
  const sa = a.map(s => String(s).toLowerCase()).sort();
  const sb = b.map(s => String(s).toLowerCase()).sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

// ── System prompt — finalized after 3-iteration testing ─────────────────
// Key concepts that must NOT regress:
//   - Source vs subject distinction (fishing spot ≠ fish)
//   - Anti-pattern examples from previous failed iterations
//   - Mix requirement: 70% mainstream / 30% rising for subreddits
//   - Behavior-pattern keywords for Twitter, NOT named memes
//   - Evidence requirement for slang anchor (Live Search backed)
//   - Existing list across ALL 5 presets (not just current preset)
const TAG_REFRESH_SYSTEM_PROMPT = `You suggest SOURCES for a trend-discovery system. The system already detects named narratives via collectors that sift Reddit + Twitter — your job is NOT to name what's trending, but to suggest WHERE we should be fishing for the NEXT unknown narratives.

CRITICAL DISTINCTION:
- A SOURCE is a fishing spot (subreddit / broad keyword group) where DIFFERENT trends surface.
- A SUBJECT is a specific trend (meme name, catchphrase, character, sound).
- We already capture subjects via the system. We need better SOURCES.

MANDATORY TOOL USAGE — read carefully:
- You MUST invoke the x_search tool AT LEAST 3 times BEFORE writing the JSON output.
- Suggestions produced without x_search verification are training-data guesses and will be REJECTED downstream.
- Use these search angles (adapt queries to the requested preset's theme):
  1. Search X for "the [preset theme] subreddit" / "best subreddit for [theme]" — find what people are recommending in 2026.
  2. Search X for current behavior-pattern slang in the [preset theme] domain — what words are being used to describe viral [theme] content in posts dated last 30-60 days.
  3. Search X for "fresh slang 2026" / "new gen z slang [month] 2026" to verify any fresh-slang anchor terms you propose.
- After searches, synthesize what x_search returned into JSON. Cite verified findings in the why_source field (e.g. "saw it in @username's post May 3 2026").
- If x_search yields no good signal for a category, return fewer items in that category. Empty/short list is BETTER than fabricated.

OUTPUT FORMAT — strict JSON only (no prose outside the object):
{
  "subreddits": [{"name": "ExampleSub", "why_source": "..."}],
  "twitter_keywords": [{"group": "(emotion1 OR emotion2 OR behavior)", "why_source": "..."}],
  "tiktok_hashtags": [{"name": "exampletag", "why_source": "..."}]
}

TIKTOK HASHTAG RULES — read carefully:
- 5-7 hashtags per preset. Lowercase, no leading "#", no spaces, alphanumeric+underscore only.
- The system uses these hashtags to scrape TikTok video pages. The goal is to surface NAMED memeable moments — animals doing absurd things, characters with iconic phrases, viral events with a tickerable subject.
- HARD SKIP these categories — they pollute the alerts with content that has no memecoin potential:
  • Generic firehose tags: fyp, foryou, foryoupage, viral, trending, tiktok, capcut, edit
  • Dance challenges: any tag where the dominant content is choreography to a sound (renegade, savagechallenge, throw-it-back, twerktok-style)
  • Outfit transitions / fashion / beauty: grwm, getreadywithme, ootd, outfitinspo, makeupartist, glowup, beautytok, fashiontok
  • Tutorials / satisfying / asmr / process: howto, tutorial, lifehack, satisfying, asmr, restorationtok, cleantok, organizationtok, studytok
  • LGBT format videos like wlw / thegreatdivide unless the tag itself is about a specific viral moment
  • Politics, news, sports results, kpop fan tags, celebrity gossip aggregators
- PREFER: animal hashtags with character potential (funnydogs, catstiktok, capybaras, frogs), niche meme communities (memetok, gentlecore, weirdcore), event/topic tags with named subjects, crypto/finance degen tags (cryptotok, degentok, solanatok).
- The litmus test: if you imagine a creator's video under this tag — is the TYPICAL video about a NAMED character/event/moment, or just "person dancing/doing makeup/showing outfit to a sound"? If the latter — SKIP.

CRITICAL RULES:
- DO NOT suggest named memes/catchphrases/characters as Twitter keywords. Those are SUBJECTS, not SOURCES.
- DO NOT suggest fan-subreddits tied to one show/movie/celebrity. They're too narrow.
- DO NOT repeat anything from the EXISTING list provided in the user message.
- DO NOT include massive generic subs like memes/funny/lol — already covered or signal-poor.
- Twitter keyword groups: NO numbers, NO min_faves, NO -is:retweet. Just keyword OR-groups in parentheses.
- TikTok hashtags: NO leading "#", NO spaces, lowercase only. Alphanumeric + underscore.

ANTI-PATTERN EXAMPLES (these were rejected in prior iterations — DO NOT repeat):
- BAD subreddit: "Euphoria" / "TheBoys" — fan-community for ONE show, not horizontal.
- BAD subreddit: "GenZ" / "teenagers" — too generic, signal-to-noise too low.
- BAD twitter keyword: "(jestermaxxing OR jestermaxx)" — NAMED meme, system catches via collectors.
- BAD twitter keyword: "(pop off OR crashing out OR serve OR chopped)" — pre-2025 staples passed off as fresh.

MIX REQUIREMENT for subreddits:
- 70% proven horizontal hubs: mainstream subs (>1M subs, active 5+ years) consistently surfacing viral content.
- 30% rising communities: subs that grew >5x in 2025-2026, smaller but active.

EVIDENCE REQUIREMENT (use the x_search tool aggressively):
- For each suggestion, verify it via x_search. If you can't find recent X posts/discussion confirming the source is active and producing viral content — exclude it.
- For slang-anchor groups (current Q2 2026 slang), each individual term must be cited from real X posts dated Nov 2025-May 2026. NO PRE-2025 STAPLES (skibidi, rizz, delulu, brainrot, mewing, gyatt, sigma, mid, sus, pop off, serve, slay, ate, ick, main character, pick me, era, vibe, mood, tea, spill, drag, chopped, crashing out, aura farming, 404 coded, no cap, bet, cap, fr, lowkey, highkey).
- Honesty over format compliance: an empty/short list with reason "weak evidence" is BETTER than a fabricated full slate.

Be focused on the requested preset's theme. Don't bleed themes (e.g. don't suggest sports subs for a celebrities preset).`;

TagRefresher.prototype._buildPrompt = function _buildPrompt(preset, existing) {
  const today = new Date().toISOString().slice(0, 10);
  const presetTheme = {
    general: 'broad mix — curated horizontal hubs covering animals, culture, celebrities, events',
    animals: 'cute / wholesome / wildlife / pets — viral animal moments and creature content',
    culture: 'memes / viral catchphrases / Gen-Z slang / TikTok cross-pollination',
    celebrities: 'entertainment / movies / music / K-pop / awards / tabloid drama',
    events: 'breaking news / disasters / sports / politics / AI launches / space',
  }[preset] || 'broad mix';

  const existingSubsCsv = existing.subreddits.map(s => '"' + s + '"').join(', ');
  const existingTwCsv = existing.twitter_keywords.map(s => '"' + s + '"').join(', ');
  const existingTiktokCsv = existing.tiktok_hashtags.map(s => '"' + s + '"').join(', ');

  return `Today is ${today}. Suggest fresh SOURCES for the "${preset}" preset.

PRESET THEME: ${presetTheme}

OUTPUT TARGETS:
- 8-10 subreddits (NO r/ prefix). Focus on the theme above.
- 5-6 Twitter keyword groups. Behavior patterns / archetypes / fresh slang anchors. NOT named memes.
- 5-7 TikTok hashtags. Topic-themed, NOT dance/outfit/lipsync/beauty/tutorial formats. See "TIKTOK HASHTAG RULES" in system prompt for the hard-skip list.

EXISTING LIST (across ALL 5 presets — do NOT repeat any of these):
- subreddits: [${existingSubsCsv}]
- twitter keyword groups: [${existingTwCsv}]
- tiktok hashtags: [${existingTiktokCsv}]

Use the x_search tool to verify each suggestion is currently active and producing viral content. Cite freshly-dated evidence for slang terms.

If you can only confidently suggest 5 subreddits instead of 10 — give 5. Quality over quota. Same for TikTok — empty/short list with reason "no good non-dance/non-outfit tags for this theme" is BETTER than fabricating sound-format tags.`;
};

export default TagRefresher;
