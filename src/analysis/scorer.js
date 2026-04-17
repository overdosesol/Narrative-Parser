import {
  SYSTEM_PROMPT,
  buildAnalysisPrompt,
  STAGE2_SYSTEM_PROMPT,
  buildStage2Prompt,
} from './prompts.js';
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
  const base     = e * 0.40 + a * 0.60;
  const modifier = 1 + Math.max(-1, Math.min(1, feedbackBias)) * 0.15;
  return Math.min(Math.round(base * modifier), 100);
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
  constructor(config, logger, db) {
    this.logger  = logger;
    this.db      = db;

    this.providers = {
      xai: {
        apiKey: process.env.XAI_API_KEY || '',
        baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
        defaultModel: process.env.XAI_MODEL || 'grok-4-1-fast-non-reasoning',
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        defaultModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      },
    };

    this.current = this._getRuntimeAiConfig();

    // Stage 2 threshold — only trends scoring >= this get x_search deep-dive
    this.stage2Threshold = 78;
    this.stage2Model = 'grok-4-1-fast-non-reasoning';
    this.stage2MaxCalls = 3; // cap per cycle to limit cost

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

  // ─── Feedback context (built once per scoreTrends call) ────────────────────

  _buildFeedbackContext() {
    if (!this.db) return '';
    try {
      const liked    = this.db.getLikedNarratives(7, 8);
      const disliked = this.db.getDislikedNarratives(7, 8);
      let ctx = '';
      if (liked.length > 0) {
        ctx += '\n\n━━━ USER PREFERENCES (apply these) ━━━';
        ctx += '\nUSER LIKED (boost similar narratives):';
        ctx += '\n' + liked.map(t => `  + "${t.title}" [${t.category}]`).join('\n');
      }
      if (disliked.length > 0) {
        ctx += '\nUSER DISLIKED (penalize similar narratives):';
        ctx += '\n' + disliked.map(t => `  - "${t.title}" [${t.category}]`).join('\n');
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

    // Build feedback context ONCE for the whole cycle
    const feedbackContext = this._buildFeedbackContext();
    const systemPrompt    = SYSTEM_PROMPT + feedbackContext;

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

    // ── Stage 2: x_search deep-dive for high-potential trends ──
    // Gates: threshold=78, max=3, skip google_trends, novelty gate
    const stage2Candidates = stage1Results
      .filter(t =>
        t.memePotential >= this.stage2Threshold &&
        t.source?.toLowerCase() !== 'google_trends' &&
        t.clusterMetrics?.isNovel !== false
      )
      .slice(0, this.stage2MaxCalls);

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
        `Stage 2: ${stage2Candidates.length} trends scored >= ${this.stage2Threshold} (cap=${this.stage2MaxCalls}), running x_search with ${stage2Cfg.model}`
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

    return stage1Results;
  }

  // ─── Stage 1: base scoring via Responses API (no tools) ────────────────────

  async _analyzeBatchStage1(trends, metrics = null, systemPrompt = null) {
    const prompt  = buildAnalysisPrompt(trends);
    const sysMsg  = systemPrompt || (SYSTEM_PROMPT + this._buildFeedbackContext());

    if (metrics) {
      metrics.stage1Calls += 1;
    }

    const { text: raw, inputTokens, outputTokens } = await this._callResponsesAPI({
      input: [
        { role: 'system', content: sysMsg  },
        { role: 'user',   content: prompt  },
      ],
      temperature: 0.25,
      // No tools for Stage 1
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
      // originalTitle = source English title, title = English (from AI), titleRu = Russian translation
      const originalEnTitle = trend.originalTitle || trend.title;
      const aiEnTitle       = a.title    || originalEnTitle;
      const aiRuTitle       = a.titleRu  || null;

      const adoption  = Number(a.memePotential) || 0;
      const emergence = trend.clusterMetrics?.emergenceScore ?? 0;
      const phase     = narrativePhase(emergence, adoption);
      const rankScore = narrativeRankScore(emergence, adoption);

      return {
        ...trend,
        // [MARKET_STAGE] carry through from clusterMetrics if present
        marketStage: trend.clusterMetrics?.marketStage ?? null,
        originalTitle:    originalEnTitle,
        title:            aiRuTitle || aiEnTitle,
        titleEn:          aiEnTitle,
        score:            Number(a.viralityScore) || this._heuristicScore(trend),
        memePotential:    adoption,
        adoptionScore:    adoption,    // semantic alias
        emergenceScore:   emergence,   // from clusterMetrics
        narrativePhase:   phase,       // 'early'|'forming'|'strong'|'saturated'
        rankScore,                     // combined sort score
        category:         a.category         || 'other',
        sentiment:        a.sentiment         || 'neutral',
        aiExplanation:    a.explanation       || '',
        whyItWillPump:    a.whyItWillPump     || '',
        predictedLifespan:a.predictedLifespan || 'unknown',
        isGenuinelyInteresting: a.isGenuinelyInteresting ?? true,
      };
    });
  }

  // ─── Stage 2: x_search deep-dive (mutates trend in-place) ─────────────────

  async _stage2DeepDive(trend, runtimeOverride) {
    const prompt = buildStage2Prompt(trend);

    const { text: raw, inputTokens, outputTokens } = await this._callResponsesAPI({
      input: [
        { role: 'system', content: STAGE2_SYSTEM_PROMPT },
        { role: 'user',   content: prompt               },
      ],
      tools: [{ type: 'x_search' }],
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
    if (result.whyItWillPump) {
      trend.whyItWillPump = result.whyItWillPump;
    }

    // Store Stage 2 metadata
    trend.xSearchData = {
      xBuzz:         result.xBuzz         || 'unknown',
      existingCoins: result.existingCoins  || [],
      xSentiment:    result.xSentiment     || 'unknown',
      adjustment:    result.adjustment     || '',
    };

    // Recalculate adoption + phase after Stage 2 adjustments
    trend.adoptionScore  = trend.memePotential;
    trend.narrativePhase = narrativePhase(trend.emergenceScore ?? 0, trend.adoptionScore);
    trend.rankScore      = narrativeRankScore(trend.emergenceScore ?? 0, trend.adoptionScore);

    // [MARKET_STAGE] optional patch — remove 1 line to disable
    if (process.env.MARKET_STAGE_DETECTION === '1') applyStage2MarketPatch(trend, result);

    this.logger.info(
      `Stage 2 "${trend.title}": meme ${oldMeme}→${trend.memePotential}, ` +
      `viral ${oldViral}→${trend.score}, buzz: ${trend.xSearchData.xBuzz}, ` +
      `phase: ${trend.narrativePhase}`
    );

    return { inputTokens, outputTokens };
  }

  // ─── Responses API call ────────────────────────────────────────────────────

  /**
   * Call the Responses API and return { text, inputTokens, outputTokens }.
   */
  async _callResponsesAPI({ input, tools, temperature, runtimeOverride = null }) {
    const runtime = runtimeOverride || this.current;
    const body = {
      model: runtime.model,
      input,
    };

    if (temperature !== undefined) body.temperature = temperature;
    if (tools && tools.length > 0) body.tools = tools;

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
      const unsupportedTemp =
        body.temperature !== undefined &&
        err.status === 400 &&
        /unsupported parameter:\s*'temperature'|temperature.*not supported/i.test(err.errorText || err.message);

      if (unsupportedTemp) {
        const retryBody = { ...body };
        delete retryBody.temperature;
        this.logger.info(`Retrying ${runtime.provider}:${runtime.model} without temperature`);
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
    return {
      ...trend,
      score:            this._heuristicScore(trend),
      memePotential:    adoption,
      adoptionScore:    adoption,
      emergenceScore:   emergence,
      narrativePhase:   narrativePhase(emergence, adoption),
      rankScore:        narrativeRankScore(emergence, adoption),
      marketStage:      trend.clusterMetrics?.marketStage ?? null, // [MARKET_STAGE]
      category:         'other',
      sentiment:        'neutral',
      aiExplanation:    'AI scoring disabled — heuristic score applied',
      whyItWillPump:    '',
      predictedLifespan:'unknown',
      isGenuinelyInteresting: true,
    };
  }

  _fallback(trends, reason) {
    return trends.map(t => {
      const adoption  = this._heuristicMemePotential(t);
      const emergence = t.clusterMetrics?.emergenceScore ?? 0;
      return {
        ...t,
        score:            this._heuristicScore(t),
        memePotential:    adoption,
        adoptionScore:    adoption,
        emergenceScore:   emergence,
        narrativePhase:   narrativePhase(emergence, adoption),
        rankScore:        narrativeRankScore(emergence, adoption),
        marketStage:      t.clusterMetrics?.marketStage ?? null, // [MARKET_STAGE]
        category:         'other',
        sentiment:        'neutral',
        aiExplanation:    reason,
        whyItWillPump:    '',
        predictedLifespan:'unknown',
        isGenuinelyInteresting: true,
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

    // Multi-source bonus
    if (trend.multiSourceBonus > 0) {
      score += Math.min(trend.multiSourceBonus, 20);
    }

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

    // Multi-source signal
    if (trend.sources?.length > 1) bonus += (trend.sources.length - 1) * 5;

    const raw = Math.floor(this._heuristicScore(trend) * 0.8) + bonus;
    return Math.min(raw, 70); // Cap at 70 — AI needed for confident high scores
  }
}

export default Scorer;
