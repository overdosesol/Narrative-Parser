/**
 * TriggerFinder — on-demand "what's driving this trend RIGHT NOW" lookup.
 *
 * Triggered by user action (Telegram button or dashboard click), NOT by the
 * automatic scoring pipeline. Uses Grok reasoning (`grok-4-1-fast-reasoning`)
 * + xAI's `x_search` tool to read live X discussion and extract the catalyst
 * event behind a trend.
 *
 * Result is cached in the `trends` table (`trigger_text`, `trigger_sources`,
 * `trigger_confidence`) and shared across all users — only the FIRST click
 * for a given trend pays for a Grok call. Subsequent clicks read from DB.
 *
 * Concurrency: relies on the DB-level claim (`db.claimTriggerSearch()`) to
 * prevent duplicate Grok calls when multiple users click in the same second.
 *
 * Cost note: reasoning is ~15× more expensive per token than the
 * fast-non-reasoning model used in Stage 2. We accept this because:
 *   1. Calls are user-initiated (~5-50/day total, not 100s)
 *   2. Per-user cooldown (15min) is enforced upstream by the Telegram handler
 *   3. The reasoning premium buys us cross-tweet timestamp correlation,
 *      originator detection, and astroturf vs organic distinction —
 *      things `non-reasoning` can't do reliably from a single x_search batch
 */

import { TRIGGER_SYSTEM_PROMPT, buildTriggerPrompt } from './prompts.js';

const DEFAULT_MODEL = 'grok-4-1-fast-reasoning';
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';

class TriggerFinder {
  constructor(config, logger) {
    this.logger = logger;
    this.apiKey = process.env.XAI_API_KEY || config?.xai?.apiKey || '';
    this.baseUrl = process.env.XAI_BASE_URL || config?.xai?.baseUrl || DEFAULT_BASE_URL;
    this.model = process.env.XAI_TRIGGER_MODEL || DEFAULT_MODEL;
    this.enabled = !!this.apiKey;

    if (!this.enabled) {
      this.logger?.warn?.('[TriggerFinder] XAI_API_KEY not set — trigger search disabled');
    } else {
      this.logger?.info?.(`[TriggerFinder] enabled with ${this.model} @ ${this.baseUrl}`);
    }
  }

  /**
   * Run a trigger search for the given trend.
   *
   * Caller is responsible for the DB-level claim (see db.claimTriggerSearch).
   * On success: returns `{ text, sources, confidence }` ready to pass to
   * `db.saveTrendTrigger`. On failure: throws — caller should call
   * `db.releaseTriggerLock` and surface the error to the user.
   *
   * @param {Object} trend  Row from `db.getTrendById(id)` (raw DB row OR a
   *                        normalized object — buildTriggerPrompt handles both)
   * @returns {Promise<{ text: string, sources: string[], confidence: number, inputTokens: number, outputTokens: number }>}
   */
  async findTrigger(trend) {
    if (!this.enabled) {
      throw new Error('Trigger search is disabled (XAI_API_KEY not configured)');
    }
    if (!trend) throw new Error('TriggerFinder.findTrigger called with null trend');

    const prompt = buildTriggerPrompt(trend);
    const startedAt = Date.now();

    const { text: raw, inputTokens, outputTokens } = await this._callResponsesAPI({
      input: [
        { role: 'system', content: TRIGGER_SYSTEM_PROMPT },
        { role: 'user',   content: prompt },
      ],
      tools: [{ type: 'x_search' }],
    });

    const elapsedMs = Date.now() - startedAt;

    // Parse JSON — Grok occasionally wraps in markdown fences despite instructions
    let parsed;
    try {
      let clean = String(raw || '').trim();
      const fence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fence) clean = fence[1];
      parsed = JSON.parse(clean);
    } catch (err) {
      throw new Error(`TriggerFinder JSON parse failed: ${err.message} (raw: ${String(raw).slice(0, 200)})`);
    }

    // Sanitize + validate
    // Forecast text: prefer the new `forecast` field, fall back to `trigger`
    // for older Grok outputs / cached prompts that haven't refreshed yet.
    const text = typeof parsed.forecast === 'string' && parsed.forecast.trim()
      ? parsed.forecast.trim()
      : (typeof parsed.trigger === 'string' ? parsed.trigger.trim() : '');
    if (!text) throw new Error('TriggerFinder: empty forecast text from Grok');

    const confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
    const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
    const sources = rawSources
      .filter(s => typeof s === 'string' && s.trim().length > 1)
      .map(s => {
        const t = s.trim();
        return t.startsWith('@') ? t : '@' + t;
      })
      .slice(0, 5);

    // Curve phase — strict enum, anything else collapses to '' (UI hides chip).
    const PHASES = ['early', 'building', 'peaking', 'saturated', 'fading'];
    const phaseRaw = String(parsed.phase || '').trim().toLowerCase();
    const phase = PHASES.includes(phaseRaw) ? phaseRaw : '';

    // Window — free-form short phrase, hard cap 80 chars to keep UI tidy.
    const window = typeof parsed.window === 'string'
      ? parsed.window.trim().slice(0, 80)
      : '';

    // Drivers / risks — bullet arrays. 80-char cap mirrors the prompt rule.
    const cleanBullets = (arr, max) => (Array.isArray(arr) ? arr : [])
      .filter(b => typeof b === 'string' && b.trim().length > 0)
      .map(b => b.trim().slice(0, 100))   // 100 = soft cap (prompt asks ≤80)
      .slice(0, max);
    const drivers = cleanBullets(parsed.drivers, 3);
    const risks   = cleanBullets(parsed.risks,   2);

    this.logger?.info?.(
      `[TriggerFinder] "${trend.title || trend.original_title || 'unknown'}" → ` +
      `phase=${phase || 'n/a'}, drivers=${drivers.length}, risks=${risks.length}, ` +
      `confidence=${confidence}, sources=${sources.length}, ` +
      `tokens in=${inputTokens}/out=${outputTokens}, ${elapsedMs}ms`
    );

    return { text, phase, window, drivers, risks, sources, confidence, inputTokens, outputTokens };
  }

  // ── Private: Responses API call ────────────────────────────────────────────
  // Mirror of Scorer._callResponsesAPI — duplicated rather than shared because:
  //   1. Different default model (reasoning vs fast)
  //   2. Different `runtime` semantics (no admin override needed)
  //   3. Keeps trigger-finder.js self-contained / removable as one file

  async _callResponsesAPI({ input, tools }) {
    const body = { model: this.model, input };
    if (tools && tools.length > 0) body.tools = tools;

    const response = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    }).catch(err => { throw new Error(`xAI fetch error: ${err.message}`); });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`xAI ${response.status}: ${errText.substring(0, 400)}`);
    }

    const data = await response.json();
    return this._extractResponseData(data);
  }

  _extractResponseData(data) {
    if (!data || !data.output) throw new Error('Empty response from xAI Responses API');

    const inputTokens  = data.usage?.input_tokens  || 0;
    const outputTokens = data.usage?.output_tokens || 0;

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
      if (data.output_text) return { text: data.output_text, inputTokens, outputTokens };
      throw new Error('No text content in xAI Responses API output');
    }

    return { text: textParts.join('\n'), inputTokens, outputTokens };
  }
}

export default TriggerFinder;
