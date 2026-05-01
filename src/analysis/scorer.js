import {
  SYSTEM_PROMPT,
  buildAnalysisPrompt,
  STAGE1_RESPONSE_SCHEMA,
  STAGE2_SYSTEM_PROMPT,
  buildStage2Prompt,
  normalizeAlertType,
} from './prompts.js';
import { normalizeLifespan } from './lifespan.js';
import { getActivePresetConfig } from './preset-config.js';

/**
 * Deterministic alert-type derivation — used (a) when AI returns an invalid
 * value, (b) for the heuristic / fallback paths where AI never ran.
 * Rule:
 *   non-empty whyNow                                 → 'event'
 *   uniquePlatforms ≥ 2 OR cluster items ≥ 3        → 'trend'
 *   otherwise                                        → 'post'
 */
export function deriveAlertType(trend) {
  const why = String(trend?.whyNow || trend?.why_now || '').trim();
  if (why.length > 0) return 'event';
  const platforms = trend?.clusterMetrics?.uniquePlatforms
    ?? trend?.metrics?.uniquePlatforms
    ?? 0;
  const clusterSize = trend?.clusterMetrics?.itemCount
    ?? (Array.isArray(trend?.items) ? trend.items.length : 0);
  if (platforms >= 2 || clusterSize >= 3) return 'trend';
  return 'post';
}
// [MARKET_STAGE] optional import — remove this line + applyStage2MarketPatch call to disable
import { applyStage2MarketPatch } from './market-stage.js';

// ─── Emergence + Adoption helpers (used by scorer and server) ─────────────────

/**
 * Determine narrative phase from emergenceScore (pre-AI) and adoptionScore (post-AI).
 * @param {number} e  emergenceScore 0–100
 * @param {number|null} a  adoptionScore 0–100 (null = AI hasn't run yet)
 * @returns {'early'|'forming'|'strong'|'saturated'}
 */
export function narrativePhase(e, a = null) {
  if (a === null) {
    // Pre-AI phase estimate based only on emergence
    if (e < 20) return 'early';
    if (e < 45) return 'forming';
    return 'strong';
  }
  // Post-AI: high adoption but emergence dropping = narrative already "spent"
  if (a >= 60 && e < 25) return 'saturated';
  if (e >= 55 && a >= 55) return 'strong';
  if (e >= 30 || a >= 35) return 'forming';
  return 'early';
}

/**
 * Combined rank score for sorting — emergence + adoption weighted, optionally
 * adjusted by user feedback bias.
 * @param {number} e  emergenceScore 0–100
 * @param {number} a  adoptionScore 0–100
 * @param {number} feedbackBias  -1.0 to +1.0 (0 = no feedback)
 * @returns {number}  0–100
 */
export function narrativeRankScore(e, a, feedbackBias = 0) {
  const base     = e * 0.15 + a * 0.85; // Variant A: adoption dominates ranking
  const modifier = 1 + Math.max(-1, Math.min(1, feedbackBias)) * 0.15;
  return Math.min(Math.round(base * modifier), 100);
}

/**
 * Default weights for the unified alertScore. Admin can override any of these
 * via settings keys `alertWeight<Name>`. Positive weights sum to 1.0 so the
 * positive part stays in 0–100; junk is a pure subtraction on top.
 */
export const DEFAULT_ALERT_WEIGHTS = {
  weightMemePotential:  0.35, // AI-assessed meme quality
  weightVirality:       0.25, // AI/heuristic virality score
  weightEmergence:      0.20, // cluster velocity + spread + ideaBoost
  weightTwitter:        0.10, // on-platform X signal
  weightFeedback:       0.10, // global 👍/👎 bias on this trend (50 = neutral)
  weightJunk:           0.50, // subtracted: junk × this
  staleDecayPerHour:    2,    // points subtracted per hour of age (after grace)
  staleDecayGraceHours: 24,   // no stale penalty for trends younger than this
  staleDecayCap:        30,   // max total stale penalty
  hardJunkStop:         70,   // junkPenalty ≥ this → never alert, regardless
};

/**
 * Pull all alert-score knobs (weights + stale decay + hardJunkStop) for the
 * active search preset. Per-preset since 2026-05-01 (PR-2 of "preset configs"):
 * values come from settings.presetConfigs blob keyed by activePreset, falling
 * back to DEFAULT_ALERT_WEIGHTS for any field not in the override.
 *
 * Called once per cycle by index.js — snapshotting is fine because activePreset
 * changes are rare (admin clicks a tab) and within a single cycle we want
 * stable weights across all 30 trends.
 *
 * Backward-compat: if `db` is omitted (legacy callers, tests), returns
 * DEFAULT_ALERT_WEIGHTS untouched.
 */
export function loadAlertWeights(db) {
  if (!db) return { ...DEFAULT_ALERT_WEIGHTS };
  let alerts;
  try { alerts = getActivePresetConfig(db).alerts || {}; }
  catch (_) { alerts = {}; }
  const W = alerts.weights || {};
  const S = alerts.stale   || {};
  const T = alerts.thresholds || {};
  return {
    weightMemePotential: pickNum(W.weightMemePotential, DEFAULT_ALERT_WEIGHTS.weightMemePotential),
    weightVirality:      pickNum(W.weightVirality,      DEFAULT_ALERT_WEIGHTS.weightVirality),
    weightEmergence:     pickNum(W.weightEmergence,     DEFAULT_ALERT_WEIGHTS.weightEmergence),
    weightTwitter:       pickNum(W.weightTwitter,       DEFAULT_ALERT_WEIGHTS.weightTwitter),
    weightFeedback:      pickNum(W.weightFeedback,      DEFAULT_ALERT_WEIGHTS.weightFeedback),
    weightJunk:          pickNum(W.weightJunk,          DEFAULT_ALERT_WEIGHTS.weightJunk),
    staleDecayPerHour:   pickNum(S.staleDecayPerHour,   DEFAULT_ALERT_WEIGHTS.staleDecayPerHour),
    staleDecayGraceHours:pickNum(S.staleDecayGraceHours, DEFAULT_ALERT_WEIGHTS.staleDecayGraceHours),
    staleDecayCap:       pickNum(S.staleDecayCap,       DEFAULT_ALERT_WEIGHTS.staleDecayCap),
    hardJunkStop:        pickNum(T.alertHardJunkStop,   DEFAULT_ALERT_WEIGHTS.hardJunkStop),
  };
}

function pickNum(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Convert raw feedback counts (likes, dislikes) into a 0-100 boost where
 * 50 = neutral / no signal. Small samples (< 5 total votes) pull hard toward
 * 50 so a single vote doesn't swing the score.
 */
export function feedbackBoostFromStats(likes = 0, dislikes = 0) {
  const total = (likes | 0) + (dislikes | 0);
  if (total === 0) return 50;
  // Confidence dampening: below 5 votes, blend toward neutral
  const conf = Math.min(1, total / 5);
  const ratio = (likes - dislikes) / Math.max(total, 1); // -1..+1
  const raw  = 50 + ratio * 50;                           // 0..100
  return Math.round(50 + (raw - 50) * conf);
}

/**
 * Unified alert score — single 0–100 number that combines every signal we have.
 * Replaces the old 3-gate system (memePotential AND viralityScore AND junkPenalty).
 *
 * Reads from trend fields already populated by the scorer/clusterer:
 *  - memePotential  (AI, 0–100)
 *  - score          (virality, 0–100)
 *  - emergenceScore (cluster, 0–100)
 *  - metrics.twitter.viralityScore (0–100, optional)
 *  - junkPenalty OR clusterMetrics.junkPenalty (0–100)
 *
 * @param {Object} trend
 * @param {Object} [w]  weights from loadAlertWeights(); defaults used if omitted
 * @returns {{ alertScore: number, breakdown: Object, hardJunk: boolean }}
 */
export function computeAlertScore(trend, w = DEFAULT_ALERT_WEIGHTS) {
  const meme      = Number(trend.memePotential) || 0;
  const viral     = Number(trend.score) || 0;
  const emergence = Number(trend.emergenceScore ?? trend.clusterMetrics?.emergenceScore) || 0;
  const twitter   = Number(trend.metrics?.twitter?.viralityScore) || 0;
  const junk      = Number(trend.junkPenalty ?? trend.clusterMetrics?.junkPenalty) || 0;

  // feedbackBoost: 0-100, 50 = neutral. Caller (index.js) pre-computes it from
  // live feedback_votes and attaches as trend._feedbackBoost. Defaults to 50
  // for fresh trends that have never been voted on.
  const feedback = (typeof trend._feedbackBoost === 'number')
    ? trend._feedbackBoost : 50;

  // Stale decay: linear penalty after grace period, capped. ageHours comes
  // from (now - firstSeenAt) in index.js; 0 at scoring time.
  const ageHours = Math.max(0, Number(trend._ageHours) || 0);
  const staleHours = Math.max(0, ageHours - (w.staleDecayGraceHours || 0));
  const staleDecay = Math.min(
    w.staleDecayCap || 0,
    staleHours * (w.staleDecayPerHour || 0)
  );

  const positive =
      meme      * w.weightMemePotential
    + viral     * w.weightVirality
    + emergence * w.weightEmergence
    + twitter   * w.weightTwitter
    + feedback  * w.weightFeedback;

  const penalty  = junk * w.weightJunk + staleDecay;
  const raw      = positive - penalty;
  const alertScore = Math.max(0, Math.min(100, Math.round(raw)));
  const hardJunk = junk >= w.hardJunkStop;

  return {
    alertScore,
    hardJunk,
    breakdown: {
      meme, viral, emergence, twitter, feedback, junk,
      ageHours: Math.round(ageHours * 10) / 10,
      staleDecay: Math.round(staleDecay),
      positive: Math.round(positive),
      penalty: Math.round(penalty),
    },
  };
}

/**
 * AI Scorer — uses xAI Responses API to analyze trend virality and meme potential.
 *
 * v3 changes:
 *  - Switched from Chat Completions to Responses API (/v1/responses)
 *  - Two-stage scoring: Stage 1 (base) → Stage 2 (x_search for memePotential >= 78)
 *  - Heuristic fallback aligned with AI scoring scale
 *
 * v3.1 cost optimizations:
 *  - Feedback context built once per cycle (not per batch)
 *  - Real token tracking from API usage field
 *  - Batch size increased 5 → 8
 *  - Stage 2 gating: threshold 78, cap 3, skip google_trends, novelty gate
 */
class Scorer {
  constructor(config, logger, db, preStage = null) {
    this.logger  = logger;
    this.db      = db;
    // Optional Stage 0 preprocessor — text + visual enrichment.
    // When null/disabled the pipeline runs exactly as before (back-compat).
    this.preStage = preStage;

    this.providers = {
      xai: {
        apiKey: process.env.XAI_API_KEY || '',
        baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
        defaultModel: process.env.XAI_MODEL || 'grok-4-1-fast-non-reasoning',
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        // Default bumped 2026-04-27: gpt-4.1-mini → gpt-5.4-mini.
        // Nominal price ×1.88 input / ×2.81 output, but cached input is $0.075/1M
        // (10× cheaper) and our SYSTEM_PROMPT (~1.2K tokens, stable) is auto-cached
        // by the Responses API across batches in a 5-min window → real cost ≈ ×1.1.
        // Knowledge cutoff Aug-2025 (vs Jun-2024 on 4.1-mini) materially improves
        // recognition of recent meme/celebrity references.
        defaultModel: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      },
    };

    this.current = this._getRuntimeAiConfig();

    // Stage 2 gates — default values; can be overridden in admin UI via
    // `stage2Threshold` and `stage2MaxCalls` settings. Runtime read per cycle
    // inside scoreTrends() so changes apply without restart.
    this.stage2Threshold = 60;   // memePotential >= this → Stage 2 candidate
    this.stage2Model = 'grok-4-1-fast-non-reasoning';
    // Cap reduced 6 → 3 (2026-04-29): logs showed cycles rarely hit the cap,
    // so the existing budget was paying for borderline candidates. With cap=3
    // we deep-dive only on the strongest signals; the remaining Stage 2 slots
    // are recoverable through admin UI override if some cycle truly needs it.
    this.stage2MaxCalls = 3;

    // Stage 2 cost knobs (env-tunable, no restart needed if read per cycle).
    // - XAI_STAGE2_MAX_RESULTS: tweets per x_search call. Default reduced
    //   10 → 5 (2026-04-29): one Stage 2 call was eating ~23K input tokens
    //   because x_search dumps each tweet's full payload (text + author +
    //   timestamps + entities + media URLs ≈ 1K tokens/tweet) back into the
    //   model context. With max_tool_calls=2 that's 2×10×~1K = ~20K. Halving
    //   max_results halves Stage 2 input cost while still giving Grok 10
    //   tweets across 2 search angles — enough to judge buzz/momentum
    //   without losing the second-angle refinement.
    // - XAI_STAGE2_LOOKBACK_HOURS: how far back x_search looks (48h default).
    // - XAI_STAGE2_MAX_TOOL_CALLS: hard cap on consecutive x_search calls in
    //   one Grok response (default 2). Stops the model from over-fanning.
    this.stage2MaxResults     = Math.max(1, Math.min(30, parseInt(process.env.XAI_STAGE2_MAX_RESULTS, 10)     || 5));
    this.stage2LookbackHours  = Math.max(1, Math.min(168, parseInt(process.env.XAI_STAGE2_LOOKBACK_HOURS, 10) || 48));
    this.stage2MaxToolCalls   = Math.max(1, Math.min(5, parseInt(process.env.XAI_STAGE2_MAX_TOOL_CALLS, 10)   || 2));

    // Stage 1 reasoning effort (gpt-5.x reasoning-capable models only).
    // Empty / "off" = don't send `reasoning` param at all → back-compat with
    // non-reasoning models like gpt-4.1-mini and current xAI defaults.
    // For reasoning models the `temperature` param is incompatible — the
    // existing 400-retry path in _callResponsesAPI already strips it.
    const rawEffort = String(process.env.OPENAI_REASONING_EFFORT || '').trim().toLowerCase();
    this.openaiReasoningEffort = ['minimal', 'low', 'medium', 'high'].includes(rawEffort)
      ? rawEffort
      : null;

    if (!this.current.enabled) {
      this.logger.warn('AI API key not set for selected provider — AI scoring disabled, using heuristics');
    } else {
      this.logger.info(`AI scorer: ${this.current.provider}:${this.current.model} @ ${this.current.baseUrl} (Responses API, 2-stage)`);
    }
  }

  _getRuntimeAiConfig() {
    const rawProvider = this.db?.getSetting('aiProvider', 'xai') || 'xai';
    let provider = ['xai', 'openai'].includes(String(rawProvider).toLowerCase())
      ? String(rawProvider).toLowerCase()
      : 'xai';

    let providerCfg = this.providers[provider] || this.providers.xai;
    if (!providerCfg.apiKey) {
      if (provider !== 'xai' && this.providers.xai.apiKey) {
        provider = 'xai';
        providerCfg = this.providers.xai;
      } else if (provider !== 'openai' && this.providers.openai.apiKey) {
        provider = 'openai';
        providerCfg = this.providers.openai;
      }
    }
    const modelSettingKey = provider === 'openai' ? 'openaiModel' : 'xaiModel';
    const model = this.db?.getSetting(modelSettingKey, providerCfg.defaultModel) || providerCfg.defaultModel;

    return {
      provider,
      model,
      apiKey: providerCfg.apiKey,
      baseUrl: providerCfg.baseUrl,
      enabled: !!providerCfg.apiKey,
    };
  }

  // ─── Stage 1 calibration examples (admin-curated) ─────────────────────────
  //
  // Read enabled rows from the stage1_examples table and format them as a
  // semi-static block that lives BETWEEN the static SYSTEM_PROMPT and the
  // volatile feedback context. Examples teach the model the rubric by
  // pattern; mistakes teach it which HARD RULES it commonly violates.
  //
  // Cache behavior: this block changes only when the admin edits an example
  // in the UI. Within a single cycle (and usually for hours/days at a time)
  // it stays byte-identical → falls into the OpenAI auto-cache prefix along
  // with SYSTEM_PROMPT. Per-request cost ≈ free.
  //
  // Empty / table-missing → returns '' silently. The bare rubric in
  // SYSTEM_PROMPT is enough to function; examples only sharpen calibration.
  _buildExamplesContext() {
    if (!this.db || typeof this.db.listStage1Examples !== 'function') return '';
    try {
      const rows = this.db.listStage1Examples({ enabledOnly: true });
      if (!rows || rows.length === 0) return '';

      const examples = rows.filter(r => r.kind === 'example');
      const mistakes = rows.filter(r => r.kind === 'mistake');

      let ctx = '';
      if (examples.length > 0) {
        ctx += '\n\n━━━ CALIBRATION EXAMPLES (mirror these scores) ━━━';
        ctx += '\n' + examples.map(e =>
          `  • "${e.title}" [${e.category || 'other'}] → memePotential ${e.memePotential ?? 0}` +
          (e.rationale ? ` — ${e.rationale}` : '')
        ).join('\n');
      }
      if (mistakes.length > 0) {
        ctx += '\n\n━━━ COMMON MISTAKES TO AVOID ━━━';
        ctx += '\n' + mistakes.map(m =>
          `  ✗ "${m.title}"${m.rationale ? ` — ${m.rationale}` : ''}`
        ).join('\n');
      }
      return ctx;
    } catch (e) {
      this.logger.warn(`_buildExamplesContext failed: ${e.message}`);
      return '';
    }
  }

  // ─── Feedback context (built once per scoreTrends call) ────────────────────

  _buildFeedbackContext() {
    if (!this.db) return '';
    try {
      // getLikedNarratives / getDislikedNarratives now filter out bare free
      // votes (weight < 0.5) UNLESS a reason was attached — so this list
      // already represents "high-signal" feedback. `topReason` is the highest-
      // weight reason text among voters (admin/pro win when multiple exist).
      // Reasons can be in any language; SYSTEM_PROMPT enforces English output.
      const liked    = this.db.getLikedNarratives(7, 8);
      const disliked = this.db.getDislikedNarratives(7, 8);

      // Cap reason length per item — long rants would crowd out the rubric.
      const fmtReason = (r) => {
        if (!r) return '';
        const clean = String(r).replace(/\s+/g, ' ').trim();
        return clean.length > 120 ? ` — "${clean.slice(0, 117)}..."` : ` — "${clean}"`;
      };

      let ctx = '';
      if (liked.length > 0) {
        ctx += '\n\n━━━ USER PREFERENCES (apply these) ━━━';
        ctx += '\nUSER LIKED (boost similar narratives):';
        ctx += '\n' + liked.map(t =>
          `  + "${t.title}" [${t.category}]${fmtReason(t.topReason)}`
        ).join('\n');
      }
      if (disliked.length > 0) {
        ctx += '\nUSER DISLIKED (penalize similar narratives):';
        ctx += '\n' + disliked.map(t =>
          `  - "${t.title}" [${t.category}]${fmtReason(t.topReason)}`
        ).join('\n');
      }
      return ctx;
    } catch (e) {
      return '';
    }
  }

  // ─── Main entry point ─────────────────────────────────────────────────────

  /**
   * Score a batch of trends.
   * Stage 1: base AI scoring (no tools) in sub-batches of 8
   * Stage 2: x_search deep-dive for trends with memePotential >= 78 (max 3 per cycle)
   */
  async scoreTrends(trends) {
    if (trends.length === 0) return trends;

    const runtime = this._getRuntimeAiConfig();
    const changed = !this.current ||
      this.current.provider !== runtime.provider ||
      this.current.model !== runtime.model ||
      this.current.baseUrl !== runtime.baseUrl;
    this.current = runtime;

    if (changed) {
      this.logger.info(`AI config updated: ${this.current.provider}:${this.current.model} @ ${this.current.baseUrl}`);
    }

    if (!this.current.enabled) {
      return trends.map(t => this._applyHeuristic(t));
    }

    // ── Stage 0: PreStage enrichment (idempotent safety net) ───────────────
    // Since PR-2, PreStage runs in index.js BEFORE the clusterer so the
    // clusterer can use Gemini/nano outputs as similarity signals. By the
    // time we reach the scorer, every trend already has `trend.preStage`
    // (either an object or null). The idempotency guard inside enrichBatch
    // (`'preStage' in t`) makes this call a no-op in normal flow.
    //
    // Why keep the call at all: the manual-submit path in admin still hands
    // raw single trends straight to scorer.scoreTrends without going
    // through index.js's pipeline — this branch enriches those.
    if (this.preStage && this.preStage.enabled) {
      try {
        await this.preStage.enrichBatch(trends);
      } catch (e) {
        this.logger.warn(`PreStage threw (continuing without enrichment): ${e.message}`);
      }
    }

    // Build the assembled system prompt ONCE for the whole cycle. Order
    // matters for prompt-cache stability:
    //   1. SYSTEM_PROMPT     — fully static (rubric, hard rules)
    //   2. examples block    — semi-static (admin edits via /api/stage1-examples)
    //   3. feedback context  — volatile (re-sampled from feedback_votes each cycle)
    // OpenAI's auto-cache hits any prefix >1024 tokens that's byte-identical
    // within 5 minutes, so the static + semi-static head almost always caches.
    const examplesContext = this._buildExamplesContext();
    const feedbackContext = this._buildFeedbackContext();
    const systemPrompt    = SYSTEM_PROMPT + examplesContext + feedbackContext;

    // ── Stage 1: base scoring ──
    const batchSize = 8;
    let stage1Results = [];
    const metrics = {
      stage1Calls:        0,
      stage1InputTokens:  0,
      stage1OutputTokens: 0,
      stage2Candidates:   0,
      stage2Calls:        0,
      stage2Success:      0,
      stage2Failed:       0,
      stage2InputTokens:  0,
      stage2OutputTokens: 0,
    };

    for (let i = 0; i < trends.length; i += batchSize) {
      const batch = trends.slice(i, i + batchSize);
      try {
        const scored = await this._analyzeBatchStage1(batch, metrics, systemPrompt);
        stage1Results.push(...scored);
      } catch (error) {
        this.logger.error(`Stage 1 batch failed: ${error.message}`);
        stage1Results.push(...this._fallback(batch, 'AI unavailable'));
      }

      if (i + batchSize < trends.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const stage2EnabledRaw = this.db?.getSetting?.('aiStage2Enabled', '1');
    const stage2Enabled = String(stage2EnabledRaw) !== '0';

    // Runtime-tunable gates — read fresh from DB each cycle so admin edits
    // take effect immediately (no restart). Falls back to constructor defaults.
    const readNum = (key, fallback) => {
      const v = this.db?.getSetting?.(key);
      if (v === undefined || v === null || v === '') return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const stage2Threshold = readNum('stage2Threshold', this.stage2Threshold);
    const stage2MaxCalls  = readNum('stage2MaxCalls',  this.stage2MaxCalls);

    // ── Stage 2: x_search deep-dive for high-potential trends ──
    // Gates: threshold (default 60), max (default 6), skip google_trends, novelty gate
    const stage2Candidates = stage1Results
      .filter(t =>
        t.memePotential >= stage2Threshold &&
        t.source?.toLowerCase() !== 'google_trends' &&
        t.clusterMetrics?.isNovel !== false
      )
      .slice(0, stage2MaxCalls);

    metrics.stage2Candidates = stage2Candidates.length;

    if (!stage2Enabled) {
      this.logger.info('Stage 2 disabled in admin settings — skipping x_search');
    } else if (stage2Candidates.length > 0) {
      const stage2Cfg = {
        provider: 'xai',
        apiKey: this.providers.xai.apiKey,
        baseUrl: this.providers.xai.baseUrl,
        model: this.stage2Model,
        enabled: !!this.providers.xai.apiKey,
      };

      if (!stage2Cfg.enabled) {
        this.logger.info('Stage 2 skipped: XAI_API_KEY is not configured (x_search requires Grok)');
        return stage1Results;
      }

      this.logger.info(
        `Stage 2: ${stage2Candidates.length} trends scored >= ${stage2Threshold} (cap=${stage2MaxCalls}), running x_search with ${stage2Cfg.model}`
      );

      for (const trend of stage2Candidates) {
        metrics.stage2Calls++;
        try {
          const { inputTokens, outputTokens } = await this._stage2DeepDive(trend, stage2Cfg);
          metrics.stage2Success++;
          metrics.stage2InputTokens  += inputTokens  || 0;
          metrics.stage2OutputTokens += outputTokens || 0;
        } catch (error) {
          metrics.stage2Failed++;
          this.logger.warn(`Stage 2 failed for "${trend.title}": ${error.message}`);
          // Keep Stage 1 scores on failure
        }
        // Small delay between Stage 2 calls
        await new Promise(r => setTimeout(r, 1500));
      }
    } else {
      this.logger.info('Stage 2: no trends above threshold, skipping x_search');
    }

    // Log real token counts
    const totalIn  = metrics.stage1InputTokens  + metrics.stage2InputTokens;
    const totalOut = metrics.stage1OutputTokens + metrics.stage2OutputTokens;
    this.logger.info(
      `AI cost metrics: stage1_calls=${metrics.stage1Calls} ` +
      `in=${metrics.stage1InputTokens} out=${metrics.stage1OutputTokens} | ` +
      `stage2_calls=${metrics.stage2Calls}/${metrics.stage2Candidates} ` +
      `in=${metrics.stage2InputTokens} out=${metrics.stage2OutputTokens} | ` +
      `total_in=${totalIn} total_out=${totalOut} (real tokens from API)`
    );

    // Expose latest metrics so the pipeline observability layer (admin UI's
    // /api/pipeline → cycleInProgress) can split Stage 1 vs Stage 2 counts.
    // Includes the configured provider/model for both stages so the UI can
    // label cards dynamically (Stage 1 may be GPT or Grok, Stage 2 is always
    // Grok with x_search).
    this.lastMetrics = {
      ...metrics,
      stage1Trends:    stage1Results.length,
      stage1Provider:  this.current?.provider || 'unknown',
      stage1Model:     this.current?.model    || 'unknown',
      stage2Provider:  'xai',
      stage2Model:     this.stage2Model,
    };

    return stage1Results;
  }

  // ─── Stage 1: base scoring via Responses API (no tools) ────────────────────

  async _analyzeBatchStage1(trends, metrics = null, systemPrompt = null) {
    const prompt  = buildAnalysisPrompt(trends);
    // Mirror the assembly order in scoreTrends() when called standalone
    // (e.g. from manual-submit pipeline) so cache prefix stays consistent.
    const sysMsg  = systemPrompt || (SYSTEM_PROMPT + this._buildExamplesContext() + this._buildFeedbackContext());

    if (metrics) {
      metrics.stage1Calls += 1;
    }

    // Structured Outputs + reasoning effort are only attached for OpenAI inside
    // _callResponsesAPI — for xAI runs they are silently ignored, so this call
    // shape is provider-agnostic. The schema guarantees JSON shape (no parse
    // retries) and reasoning='low' on gpt-5.x adds a small thinking budget for
    // edge-case classification (genuine novelty vs mega-account noise) at
    // ~+30% output tokens.
    const { text: raw, inputTokens, outputTokens } = await this._callResponsesAPI({
      input: [
        { role: 'system', content: sysMsg  },
        { role: 'user',   content: prompt  },
      ],
      temperature: 0.25,
      responseSchema: {
        name: 'trend_analyses',
        schema: STAGE1_RESPONSE_SCHEMA,
      },
      reasoningEffort: this.openaiReasoningEffort,
    });

    if (metrics) {
      metrics.stage1InputTokens  += inputTokens  || 0;
      metrics.stage1OutputTokens += outputTokens || 0;
    }

    let analyses;
    try {
      let clean = raw.trim();
      const fence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fence) clean = fence[1];

      const parsed = JSON.parse(clean);
      analyses = Array.isArray(parsed) ? parsed : (parsed.trends || parsed.results || [parsed]);
    } catch (err) {
      this.logger.warn(`Stage 1 JSON parse failed: ${err.message} | raw: ${raw.substring(0, 200)}`);
      return this._fallback(trends, 'Parse error');
    }

    return trends.map((trend, idx) => {
      const a = analyses[idx] || {};
      // originalTitle = raw source text (any language), title/titleEn = AI's
      // English rendering. We no longer produce a Russian translation — prompt
      // is English-only. `titleRu` was removed end-to-end; do NOT bring it back
      // without also reviving the dual-flag formatter branch.
      const originalEnTitle = trend.originalTitle || trend.title;
      const aiEnTitle       = a.title || originalEnTitle;

      const adoption  = Number(a.memePotential) || 0;
      const emergence = trend.clusterMetrics?.emergenceScore ?? 0;
      const phase     = narrativePhase(emergence, adoption);
      const rankScore = narrativeRankScore(emergence, adoption);
      const viralityForAlert = Number(a.viralityScore) || this._heuristicScore(trend);
      const alertProbe = computeAlertScore({
        memePotential: adoption,
        score: viralityForAlert,
        emergenceScore: emergence,
        metrics: trend.metrics,
        junkPenalty: trend.junkPenalty ?? trend.clusterMetrics?.junkPenalty ?? 0,
      });

      return {
        ...trend,
        // [MARKET_STAGE] carry through from clusterMetrics if present
        marketStage: trend.clusterMetrics?.marketStage ?? null,
        originalTitle:    originalEnTitle,
        title:            aiEnTitle,
        titleEn:          aiEnTitle,
        score:            viralityForAlert,
        memePotential:    adoption,
        adoptionScore:    adoption,    // semantic alias
        emergenceScore:   emergence,   // from clusterMetrics
        narrativePhase:   phase,       // 'early'|'forming'|'strong'|'saturated'
        rankScore,                     // combined sort score
        alertScore:       alertProbe.alertScore,
        alertBreakdown:   alertProbe.breakdown,
        category:         a.category         || 'other',
        sentiment:        a.sentiment         || 'neutral',
        aiExplanation:    a.explanation       || '',
        // Trigger event — only populated when the model found an explicit cause.
        // We trim and cap to keep it one line; empty string means "no trigger".
        whyNow:           (a.whyNow || '').trim().slice(0, 280),
        // alertType: trust AI when it returned a valid enum, otherwise derive
        // deterministically from whyNow + cluster signals. We pass a probe
        // object that includes the freshly-trimmed whyNow so derivation sees
        // the post-cap value (not a.whyNow which may differ).
        alertType: normalizeAlertType(a.alertType) || deriveAlertType({
          whyNow: (a.whyNow || '').trim(),
          clusterMetrics: trend.clusterMetrics,
          metrics: trend.metrics,
          items: trend.items,
        }),
        // Normalize so legacy descriptive forms ("flash (hours)") that may
        // appear from non-strict providers get folded back to bare keywords.
        predictedLifespan:normalizeLifespan(a.predictedLifespan) || 'unknown',
        isGenuinelyInteresting: a.isGenuinelyInteresting ?? true,
      };
    });
  }

  // ─── Stage 2: x_search deep-dive (mutates trend in-place) ─────────────────

  async _stage2DeepDive(trend, runtimeOverride) {
    const prompt = buildStage2Prompt(trend);

    // x_search params — were unset before, so xAI defaulted to ~25 results /
    // unbounded date range and Grok could fan out into 3-4 consecutive tool
    // calls. Each tool call dumps its results into the model's context for
    // the next reasoning step → quadratic input growth. Capping all three
    // levers cuts Stage 2 input tokens by ~60%.
    const fromDate = new Date(Date.now() - this.stage2LookbackHours * 3_600_000)
      .toISOString().slice(0, 10); // YYYY-MM-DD per xAI x_search spec
    const xSearchTool = {
      type: 'x_search',
      max_search_results: this.stage2MaxResults,
      from_date: fromDate,
      sources: [{ type: 'x' }],     // do not bleed into news / web sources
      return_citations: false,       // we don't render citations downstream
    };

    const { text: raw, inputTokens, outputTokens } = await this._callResponsesAPI({
      input: [
        { role: 'system', content: STAGE2_SYSTEM_PROMPT },
        { role: 'user',   content: prompt               },
      ],
      tools: [xSearchTool],
      maxToolCalls: this.stage2MaxToolCalls,
      temperature: 0.3,
      runtimeOverride,
    });

    let result;
    try {
      let clean = raw.trim();
      const fence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fence) clean = fence[1];
      result = JSON.parse(clean);
    } catch (err) {
      this.logger.warn(`Stage 2 JSON parse failed for "${trend.title}": ${err.message}`);
      return { inputTokens, outputTokens }; // Keep Stage 1 scores
    }

    // Apply Stage 2 adjustments
    const oldMeme  = trend.memePotential;
    const oldViral = trend.score;

    if (typeof result.memePotential === 'number') {
      trend.memePotential = Math.max(0, Math.min(100, result.memePotential));
    }
    if (typeof result.viralityScore === 'number') {
      trend.score = Math.max(0, Math.min(100, result.viralityScore));
    }

    // Store Stage 2 metadata (narrative-focused — no coin search)
    // Removed 2026-04-27: `xSentiment` (never consumed downstream) and
    // `adjustment` (only read by market-stage.js which is feature-flagged off
    // and depended on the now-deleted existingCoins field). storyHook capped
    // 80 chars — Grok was returning 100-150 char prose, output token waste.
    const storyScore = Math.max(0, Math.min(100, Number(result.storyScore) || 0));
    const rawSubjectName = typeof result.subjectName === 'string' ? result.subjectName.trim() : '';
    const subjectName = rawSubjectName.length > 64 ? rawSubjectName.slice(0, 64) : rawSubjectName;
    const nameStrength = subjectName
      ? Math.max(0, Math.min(100, Number(result.nameStrength) || 0))
      : 0;
    const rawStoryHook = typeof result.storyHook === 'string' ? result.storyHook.trim() : '';
    const storyHook = rawStoryHook.length > 80 ? rawStoryHook.slice(0, 80) : rawStoryHook;
    trend.xSearchData = {
      xBuzz:              result.xBuzz              || 'unknown',
      narrativeMomentum:  result.narrativeMomentum  || 'unknown',
      organicity:         result.organicity         || 'unknown',
      storyScore,
      storyHook,
      subjectName,
      nameStrength,
    };

    // ── Stage 2 authority: apply penalties based on live X narrative signals ──
    // Stage 1 judges from a headline; Stage 2 saw the actual X feed. If Grok
    // reports weak buzz, fading momentum, or astroturf amplification, we TRUST
    // it over Stage 1 and penalize memePotential/score. Multiplicative so
    // strong signals still pass through — just capped.
    const xBuzz       = String(trend.xSearchData.xBuzz              || '').toLowerCase();
    const momentum    = String(trend.xSearchData.narrativeMomentum  || '').toLowerCase();
    const organicity  = String(trend.xSearchData.organicity         || '').toLowerCase();

    let penaltyMult = 1.0;
    const penaltyReasons = [];

    if (xBuzz === 'low' || xBuzz === 'none') {
      penaltyMult *= 0.5;          // no real buzz on X → half credit
      penaltyReasons.push('weak-xBuzz');
    }
    if (momentum === 'fading') {
      penaltyMult *= 0.7;          // narrative is dying
      penaltyReasons.push('fading-momentum');
    }
    if (organicity === 'astroturf') {
      penaltyMult *= 0.6;          // bot / spam amplification, not organic
      penaltyReasons.push('astroturf');
    }

    if (penaltyMult < 1.0) {
      const beforeMeme  = trend.memePotential;
      const beforeViral = trend.score;
      trend.memePotential = Math.round(trend.memePotential * penaltyMult);
      trend.score         = Math.round(trend.score         * penaltyMult);
      trend.stage2Penalty = {
        multiplier: +penaltyMult.toFixed(2),
        reasons: penaltyReasons,
        memeBefore:  beforeMeme,
        memeAfter:   trend.memePotential,
        viralBefore: beforeViral,
        viralAfter:  trend.score,
      };
      this.logger.info(
        `Stage 2 penalty "${trend.title}": ×${penaltyMult.toFixed(2)} ` +
        `[${penaltyReasons.join(', ')}] meme ${beforeMeme}→${trend.memePotential}`
      );
    }

    // Story-hook booster — additive only, never penalizes.
    // Generic cute-pet posts (low storyScore) stay where they are; narratives
    // with real character + conflict + stakes (Punch monkey, Peanut squirrel)
    // get a bump that lets them clear the alert bar on softer raw virality.
    if (storyScore >= 60) {
      const storyBonus = Math.min(15, Math.round((storyScore - 60) * 0.4));
      if (storyBonus > 0) {
        const beforeMeme = trend.memePotential;
        trend.memePotential = Math.min(100, trend.memePotential + storyBonus);
        trend.stage2StoryBonus = {
          storyScore,
          bonus: storyBonus,
          memeBefore: beforeMeme,
          memeAfter:  trend.memePotential,
        };
        this.logger.info(
          `Stage 2 story bonus "${trend.title}": +${storyBonus} ` +
          `(storyScore=${storyScore}) meme ${beforeMeme}→${trend.memePotential}`
        );
      }
    }

    // Subject-name / ticker-candidate booster — additive only, never penalizes.
    // If Grok spotted a clean proper name attached to the narrative (Peanut,
    // Moo Deng, Hawk Tuah, $BONK) and rated it tickerable, we bump memePotential
    // a little. Trends without a name get subjectName="" and nameStrength=0 —
    // they simply don't receive the bonus. No penalty path.
    // Formula mirrors stage2StoryBonus: threshold 60, max +10, slope 0.25.
    if (subjectName && nameStrength >= 60) {
      const nameBonus = Math.min(10, Math.round((nameStrength - 60) * 0.25));
      if (nameBonus > 0) {
        const beforeMeme = trend.memePotential;
        trend.memePotential = Math.min(100, trend.memePotential + nameBonus);
        trend.stage2NameBonus = {
          subjectName,
          nameStrength,
          bonus: nameBonus,
          memeBefore: beforeMeme,
          memeAfter:  trend.memePotential,
        };
        this.logger.info(
          `Stage 2 name bonus "${trend.title}": +${nameBonus} ` +
          `(subject="${subjectName}", strength=${nameStrength}) meme ${beforeMeme}→${trend.memePotential}`
        );
      }
    }

    // Recalculate adoption + phase after Stage 2 adjustments
    trend.adoptionScore  = trend.memePotential;
    trend.narrativePhase = narrativePhase(trend.emergenceScore ?? 0, trend.adoptionScore);
    trend.rankScore      = narrativeRankScore(trend.emergenceScore ?? 0, trend.adoptionScore);
    const alertProbe2 = computeAlertScore(trend);
    trend.alertScore     = alertProbe2.alertScore;
    trend.alertBreakdown = alertProbe2.breakdown;

    // [MARKET_STAGE] optional patch — remove 1 line to disable
    if (process.env.MARKET_STAGE_DETECTION === '1') applyStage2MarketPatch(trend, result);

    this.logger.info(
      `Stage 2 "${trend.title}": meme ${oldMeme}→${trend.memePotential}, ` +
      `viral ${oldViral}→${trend.score}, buzz: ${trend.xSearchData.xBuzz}, ` +
      `story: ${storyScore}, phase: ${trend.narrativePhase}`
    );

    return { inputTokens, outputTokens };
  }

  // ─── Responses API call ────────────────────────────────────────────────────

  /**
   * Call the Responses API and return { text, inputTokens, outputTokens }.
   */
  async _callResponsesAPI({
    input,
    tools,
    temperature,
    runtimeOverride = null,
    maxToolCalls = null,
    responseSchema = null,        // { name, schema } → text.format json_schema
    reasoningEffort = null,       // 'minimal' | 'low' | 'medium' | 'high'
  }) {
    const runtime = runtimeOverride || this.current;
    const body = {
      model: runtime.model,
      input,
    };

    if (temperature !== undefined) body.temperature = temperature;
    if (tools && tools.length > 0) body.tools = tools;
    // Hard cap consecutive tool calls (e.g. x_search loops) — without this,
    // Grok happily fans out 3-4 searches per response and quadruples input
    // tokens via accumulated tool results in the reasoning context.
    if (maxToolCalls && Number.isFinite(maxToolCalls)) body.max_tool_calls = maxToolCalls;

    // Structured Outputs (OpenAI Responses API). xAI Grok does not currently
    // honor `text.format = json_schema` reliably — only attach when we're
    // explicitly talking to OpenAI. Schema name must be alphanumeric+_ only.
    if (responseSchema && runtime.provider === 'openai') {
      body.text = {
        format: {
          type: 'json_schema',
          name: responseSchema.name || 'response',
          schema: responseSchema.schema,
          strict: true,
        },
      };
    }

    // Reasoning effort — only meaningful for reasoning-capable models. We pass
    // it whenever caller asked for it and provider is OpenAI; for non-reasoning
    // models the API returns 400 and we fall through to a retry without it
    // (handled in the catch-block below, same pattern as the temperature retry).
    if (reasoningEffort && runtime.provider === 'openai') {
      body.reasoning = { effort: reasoningEffort };
    }

    const doRequest = async (requestBody) => {
      const response = await fetch(`${runtime.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${runtime.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      }).catch(err => { throw new Error(`Responses API fetch error: ${err.message}`); });

      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`Responses API ${response.status}: ${errorText.substring(0, 300)}`);
        err.status = response.status;
        err.errorText = errorText;
        throw err;
      }

      return response.json();
    };

    let data;
    try {
      data = await doRequest(body);
    } catch (err) {
      const errBlob = err.errorText || err.message || '';
      const unsupportedTemp =
        body.temperature !== undefined &&
        err.status === 400 &&
        /unsupported parameter:\s*'temperature'|temperature.*not supported/i.test(errBlob);
      const unsupportedReasoning =
        body.reasoning !== undefined &&
        err.status === 400 &&
        /unsupported parameter:\s*'reasoning'|reasoning.*not supported|does not support reasoning/i.test(errBlob);
      const unsupportedSchema =
        body.text?.format?.type === 'json_schema' &&
        err.status === 400 &&
        /(text\.format|json_schema|response_format).*not supported|unsupported parameter:\s*'text'/i.test(errBlob);

      if (unsupportedTemp || unsupportedReasoning || unsupportedSchema) {
        const retryBody = { ...body };
        const dropped = [];
        if (unsupportedTemp)      { delete retryBody.temperature; dropped.push('temperature'); }
        if (unsupportedReasoning) { delete retryBody.reasoning;   dropped.push('reasoning'); }
        if (unsupportedSchema)    { delete retryBody.text;        dropped.push('json_schema'); }
        this.logger.info(`Retrying ${runtime.provider}:${runtime.model} without ${dropped.join('+')}`);
        data = await doRequest(retryBody);
      } else {
        throw err;
      }
    }

    return this._extractResponseData(data);
  }

  /**
   * Extract text content and token counts from Responses API output.
   * Format: { output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }], usage: { input_tokens, output_tokens } }
   */
  _extractResponseData(data) {
    if (!data || !data.output) {
      throw new Error('Empty response from Responses API');
    }

    // Real token counts from API (preferred over char estimation)
    const inputTokens  = data.usage?.input_tokens  || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    // Collect all text from output_text blocks across all message items
    const textParts = [];

    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === 'output_text' && block.text) {
            textParts.push(block.text);
          }
        }
      }
    }

    if (textParts.length === 0) {
      // Fallback: try legacy format or direct text
      if (data.output_text) return { text: data.output_text, inputTokens, outputTokens };
      throw new Error('No text content in Responses API output');
    }

    return { text: textParts.join('\n'), inputTokens, outputTokens };
  }

  // ─── Heuristic fallback ────────────────────────────────────────────────────

  _applyHeuristic(trend) {
    const adoption  = this._heuristicMemePotential(trend);
    const emergence = trend.clusterMetrics?.emergenceScore ?? 0;
    const viral     = this._heuristicScore(trend);
    const probe = computeAlertScore({
      memePotential: adoption, score: viral, emergenceScore: emergence,
      metrics: trend.metrics,
      junkPenalty: trend.junkPenalty ?? trend.clusterMetrics?.junkPenalty ?? 0,
    });
    return {
      ...trend,
      score:            viral,
      memePotential:    adoption,
      adoptionScore:    adoption,
      emergenceScore:   emergence,
      narrativePhase:   narrativePhase(emergence, adoption),
      rankScore:        narrativeRankScore(emergence, adoption),
      alertScore:       probe.alertScore,
      alertBreakdown:   probe.breakdown,
      marketStage:      trend.clusterMetrics?.marketStage ?? null, // [MARKET_STAGE]
      category:         'other',
      sentiment:        'neutral',
      aiExplanation:    'AI scoring disabled — heuristic score applied',
      predictedLifespan:'unknown',
      isGenuinelyInteresting: true,
      alertType:        deriveAlertType(trend),
    };
  }

  _fallback(trends, reason) {
    return trends.map(t => {
      const adoption  = this._heuristicMemePotential(t);
      const emergence = t.clusterMetrics?.emergenceScore ?? 0;
      const viral     = this._heuristicScore(t);
      const probe = computeAlertScore({
        memePotential: adoption, score: viral, emergenceScore: emergence,
        metrics: t.metrics,
        junkPenalty: t.junkPenalty ?? t.clusterMetrics?.junkPenalty ?? 0,
      });
      return {
        ...t,
        score:            viral,
        memePotential:    adoption,
        adoptionScore:    adoption,
        emergenceScore:   emergence,
        narrativePhase:   narrativePhase(emergence, adoption),
        rankScore:        narrativeRankScore(emergence, adoption),
        alertScore:       probe.alertScore,
        alertBreakdown:   probe.breakdown,
        marketStage:      t.clusterMetrics?.marketStage ?? null, // [MARKET_STAGE]
        category:         'other',
        sentiment:        'neutral',
        aiExplanation:    reason,
        predictedLifespan:'unknown',
        isGenuinelyInteresting: true,
        alertType:        deriveAlertType(t),
      };
    });
  }

  // ─── Heuristic scoring (aligned with AI 0-100 scale) ──────────────────────

  /**
   * Heuristic virality score.
   * Aligned with AI scale: 25 = baseline, up to ~85 max for extreme engagement.
   * AI can go higher (90-100) based on content analysis — heuristics can't judge content.
   */
  _heuristicScore(trend) {
    let score = 20; // baseline — slightly conservative without AI
    if (!trend.metrics) return score;
    const m = trend.metrics;

    // Velocity / upvotes (Reddit)
    if (m.velocity > 5000) score += 25;
    else if (m.velocity > 1000) score += 15;
    else if (m.velocity > 500)  score += 8;

    if (m.upvotes > 50_000) score += 12;
    else if (m.upvotes > 10_000) score += 8;
    else if (m.upvotes > 1_000)  score += 4;

    if (m.comments > 5_000) score += 8;

    // Google Trends traffic
    if (m.traffic > 1_000_000) score += 20;
    else if (m.traffic > 500_000) score += 14;
    else if (m.traffic > 100_000) score += 8;

    // Twitter engagement
    if (m.views > 1_000_000) score += 15;
    else if (m.views > 100_000) score += 10;
    if (m.retweets > 5_000) score += 10;
    if (m.viralScore) score += Math.floor(m.viralScore / 8);

    // Engagement rate bonus (relative signal)
    if (m.engagementRate > 5) score += 10;
    else if (m.engagementRate > 1) score += 5;

    // TikTok plays
    if (m.plays > 10_000_000) score += 15;
    else if (m.plays > 1_000_000) score += 10;

    // (Multi-source bonus removed — news/politics dominated every platform
    //  and drowned out single-source meme content.)

    return Math.min(score, 85); // Cap at 85 — AI needed for 85+
  }

  /**
   * Heuristic meme potential.
   * Conservative without AI — capped at 70 since we can't judge meme-worthiness of content.
   */
  _heuristicMemePotential(trend) {
    const title = (trend.title || '').toLowerCase();
    let bonus = 0;

    const highSignal = ['elon', 'musk', 'doge', 'meme', 'pepe', 'shib', 'bonk', 'cat', 'dog', 'frog', 'ape'];
    highSignal.forEach(kw => { if (title.includes(kw)) bonus += 10; });

    // Engagement rate signal
    if (trend.metrics?.engagementRate > 5) bonus += 8;

    // (Multi-source bonus removed — see _heuristicScore.)

    const raw = Math.floor(this._heuristicScore(trend) * 0.8) + bonus;
    return Math.min(raw, 70); // Cap at 70 — AI needed for confident high scores
  }
}

export default Scorer;
