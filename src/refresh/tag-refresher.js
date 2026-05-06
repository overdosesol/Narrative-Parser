/**
 * Tag auto-refresh — periodic Grok call to propose fresh subreddits and
 * Twitter keyword groups for each preset's sources. Phase 1 is the
 * infrastructure scaffold (cooldown, audit log, admin endpoints, toggle
 * switch); Phase 2 wires the real xAI Responses API call with Live Search.
 *
 * Storage:
 *   settings.presetConfigsAuto         — sparse override blob (Grok-written)
 *   settings.presetTagsLocked          — per-tag pin lock-mask (Phase 3)
 *   settings.tagAutoRefreshEnabled     — '0' | '1'
 *   settings.tagAutoRefreshLastRunAt   — ISO timestamp of last attempt
 *   settings.tagAutoRefreshFailureStreak — int, auto-disable when >= 3
 *
 * Merge order (resolved in preset-config.js getActivePresetConfig):
 *   DEFAULT_PRESET_CONFIGS  →  presetConfigsAuto  →  presetConfigs (manual)
 *   Manual ALWAYS wins on conflict.
 *
 * Cooldown rules:
 *   - Scheduled refresh: every TAG_REFRESH_COOLDOWN_DAYS days (default 7)
 *   - Force button: rate-limited to TAG_REFRESH_FORCE_COOLDOWN_HOURS (default 24)
 *     so accidental double-clicks don't burn $$ on grok-4.3 tokens
 *   - 3 consecutive failures → circuit breaker, requires manual reset in admin UI
 */

import {
  PRESET_KEYS,
  readPresetAutoOverrides,
  readPresetTagsLocked,
} from '../analysis/preset-config.js';

const TAG_REFRESH_COOLDOWN_DAYS = Number(process.env.TAG_REFRESH_COOLDOWN_DAYS) || 7;
const TAG_REFRESH_FORCE_COOLDOWN_HOURS = Number(process.env.TAG_REFRESH_FORCE_COOLDOWN_HOURS) || 24;
const TAG_REFRESH_MODEL_PRIMARY = process.env.XAI_TAG_REFRESH_MODEL || 'grok-4.3';
const TAG_REFRESH_MODEL_FALLBACK = process.env.XAI_TAG_REFRESH_FALLBACK_MODEL || 'grok-4.20-0309-reasoning';

class TagRefresher {
  constructor({ db, logger, config = {} }) {
    this.db = db;
    this.logger = logger;
    this.config = config;
  }

  // ── Toggle / status ─────────────────────────────────────────────────────
  isEnabled() {
    // Default-on. Operator must explicitly disable via admin toggle.
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
  /**
   * Phase 1: stub — does NOT actually call Grok. Records a 'skipped_no_diff'
   * audit row per preset and bumps lastRunAt so the cooldown gate works.
   *
   * Phase 2 will replace _callGrokForPreset with a real xAI Responses API
   * call (search_parameters: {mode: "on"}, structured output schema for
   * subreddits + twitter_keywords + slang_anchor with evidence).
   */
  async refreshAll(opts = {}) {
    const isForce = !!opts.force;
    const gate = isForce ? this.canForceNow() : this.shouldRefreshNow();
    if (!gate.ok) {
      this.logger?.info?.(`[TagRefresher] refresh skipped: ${gate.reason}`);
      return { ok: false, reason: gate.reason, ...gate };
    }

    const startedAt = Date.now();
    const results = [];
    let anyFailure = false;

    this.logger?.info?.(`[TagRefresher] starting refresh (force=${isForce}, model=${TAG_REFRESH_MODEL_PRIMARY})`);

    for (const preset of PRESET_KEYS) {
      try {
        const proposed = await this._callGrokForPreset(preset);
        if (!proposed) {
          this.db.recordTagRefresh({
            preset,
            sourceType: 'all',
            status: 'skipped_no_diff',
            diff: null,
            errorMessage: 'Phase 1 stub — Grok call not yet wired',
            model: TAG_REFRESH_MODEL_PRIMARY,
            costUsd: 0,
          });
          results.push({ preset, status: 'skipped_no_diff' });
          continue;
        }
        // Phase 2 will land here: validate, compute diff, apply to auto-blob
        results.push({ preset, status: 'applied' });
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
    this.logger?.info?.(`[TagRefresher] done in ${elapsedSec}s — ${results.length} presets, anyFailure=${anyFailure}`);
    return { ok: true, results, elapsedSec, anyFailure };
  }

  // ── Grok call (Phase 1 stub, Phase 2 will replace) ──────────────────────
  async _callGrokForPreset(preset) {
    // Phase 1: no real call. Returns null = "no changes proposed".
    // Phase 2 will:
    //   1. Build prompt with EXISTING list across all 5 presets
    //   2. Call xAI Responses API: { model: 'grok-4.3', search_parameters: { mode: 'on' },
    //        response_format: { type: 'json_schema', json_schema: TAG_REFRESH_SCHEMA } }
    //   3. Fallback to grok-4.20-0309-reasoning on 5xx / model_not_found
    //   4. For slang_anchor — verify each term via 1 Apify Twitter probe (variant 3)
    //   5. Compute diff vs current effective sources, return { added, removed, kept_locked }
    this.logger?.debug?.(`[TagRefresher] Phase 1 stub for preset=${preset}`);
    return null;
  }
}

export default TagRefresher;
