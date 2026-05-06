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

class TagRefresher {
  constructor({ db, logger, config = {}, twitter = null }) {
    this.db = db;
    this.logger = logger;
    this.config = config;
    this.twitter = twitter;  // TwitterCollector instance, used for reality-check probes
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
    return { ok: true, results, elapsedSec, anyFailure, totalCost };
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
    if (sanitized.subreddits.length === 0 && sanitized.twitter_keywords.length === 0) {
      this.db.recordTagRefresh({
        preset, sourceType: 'all', status: 'rejected_validation',
        diff: null,
        errorMessage: `Empty after sanitization. Raw text head: ${rawText.substring(0, 200)}`,
        model, costUsd,
      });
      return { status: 'rejected_validation', costUsd, model };
    }

    // 4. Variant-3 reality-check on Twitter keyword groups (probe each PROPOSED group)
    const verifiedTwitter = await this._realityCheckTwitter(sanitized.twitter_keywords, preset);

    // 5. Compute diff vs current effective sources, respecting locked tags
    const diff = this._computeDiff(preset, {
      subreddits: sanitized.subreddits,
      twitter_keywords: verifiedTwitter,
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

    return { status, costUsd, model, inputTokens, outputTokens, addedCount: diff.addedSubs.length + diff.addedTwitter.length };
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
      return { subreddits: [], twitter_keywords: [] };
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

    return { subreddits: uniqueSubs, twitter_keywords: uniqueGroups };
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
    }
    return {
      subreddits: Array.from(allSubs),
      twitter_keywords: Array.from(allKeywords),
    };
  }

  // ── Diff computation respecting locked tags ─────────────────────────────
  _computeDiff(preset, proposed) {
    const lockedAll = readPresetTagsLocked(this.db);
    const lockedSubs = (lockedAll[preset]?.reddit || []).map(s => s.toLowerCase());
    const lockedTwitter = (lockedAll[preset]?.twitter || []).map(s => s.toLowerCase());

    const currentSubs = DEFAULT_PRESET_CONFIGS[preset]?.sources?.reddit?.subreddits || [];
    const currentTwitterParts = (DEFAULT_PRESET_CONFIGS[preset]?.sources?.twitter?.queries || [])
      .map(q => q.replace(/\s*min_faves:\d+\s*/g, '').replace(/\s*-is:retweet\s*/g, '').trim());

    const proposedSubsSet = new Set(proposed.subreddits.map(s => s.toLowerCase()));
    const currentSubsSet = new Set(currentSubs.map(s => s.toLowerCase()));
    const proposedTwSet = new Set(proposed.twitter_keywords.map(s => s.toLowerCase()));
    const currentTwSet = new Set(currentTwitterParts.map(s => s.toLowerCase()));

    return {
      addedSubs:    proposed.subreddits.filter(s => !currentSubsSet.has(s.toLowerCase())),
      keptSubs:     currentSubs.filter(s => proposedSubsSet.has(s.toLowerCase()) || lockedSubs.includes(s.toLowerCase())),
      removedSubs:  currentSubs.filter(s => !proposedSubsSet.has(s.toLowerCase()) && !lockedSubs.includes(s.toLowerCase())),

      addedTwitter:    proposed.twitter_keywords.filter(g => !currentTwSet.has(g.toLowerCase())),
      keptTwitter:     currentTwitterParts.filter(g => proposedTwSet.has(g.toLowerCase()) || lockedTwitter.includes(g.toLowerCase())),
      removedTwitter:  currentTwitterParts.filter(g => !proposedTwSet.has(g.toLowerCase()) && !lockedTwitter.includes(g.toLowerCase())),
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

    // Read current auto-blob, merge this preset's slot
    const auto = readPresetAutoOverrides(this.db);
    if (!auto[preset]) auto[preset] = {};
    if (!auto[preset].sources) auto[preset].sources = {};
    auto[preset].sources.reddit = {
      subreddits: finalSubs,
      ...defaultRedditMeta,
    };
    auto[preset].sources.twitter = { queries: finalTwitter };

    // Cleanup: if applied set equals defaults exactly, drop the auto-slot for this preset.
    // (Avoids polluting auto-blob with no-op overrides.)
    const subsEqDefault = arraysEqIgnoreCase(finalSubs, defaults.reddit?.subreddits || []);
    const twEqDefault = arraysEq(finalTwitter, defaultQueries);
    if (subsEqDefault && twEqDefault) {
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
  "twitter_keywords": [{"group": "(emotion1 OR emotion2 OR behavior)", "why_source": "..."}]
}

CRITICAL RULES:
- DO NOT suggest named memes/catchphrases/characters as Twitter keywords. Those are SUBJECTS, not SOURCES.
- DO NOT suggest fan-subreddits tied to one show/movie/celebrity. They're too narrow.
- DO NOT repeat anything from the EXISTING list provided in the user message.
- DO NOT include massive generic subs like memes/funny/lol — already covered or signal-poor.
- Twitter keyword groups: NO numbers, NO min_faves, NO -is:retweet. Just keyword OR-groups in parentheses.

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

  return `Today is ${today}. Suggest fresh SOURCES for the "${preset}" preset.

PRESET THEME: ${presetTheme}

OUTPUT TARGETS:
- 8-10 subreddits (NO r/ prefix). Focus on the theme above.
- 5-6 Twitter keyword groups. Behavior patterns / archetypes / fresh slang anchors. NOT named memes.

EXISTING LIST (across ALL 5 presets — do NOT repeat any of these):
- subreddits: [${existingSubsCsv}]
- twitter keyword groups: [${existingTwCsv}]

Use the x_search tool to verify each suggestion is currently active and producing viral content. Cite freshly-dated evidence for slang terms.

If you can only confidently suggest 5 subreddits instead of 10 — give 5. Quality over quota.`;
};

export default TagRefresher;
