/**
 * NanoClassifier — Stage 0a text-only preprocessing via gpt-5.4-nano.
 *
 * Purpose: enrich each trend with structured semantic metadata that Stage 1
 * (gpt-5.4-mini) can reason about. NEVER filters, NEVER scores, NEVER drops.
 * If the API call fails for a trend, the field is set to null and the
 * pipeline continues normally — Stage 1 just gets the raw input as before.
 *
 * Output shape per trend:
 *   {
 *     topicSummary:    "1-sentence plain English rephrasing",
 *     entityCanonical: ["proper noun 1", "proper noun 2"],
 *     language:        "en" | "ru" | "ja" | ...,   // ISO 639-1
 *     slangDecoded:    "explanation of slang/hashtags or empty string"
 *   }
 *
 * Single batched API call per scorer cycle to amortize prefix cache. Output
 * mirrors Stage 1 schema style (json_schema response_format) so we get
 * shape guarantees without parse failures.
 */

const NANO_SYSTEM_PROMPT = `You are a TEXT ENRICHMENT preprocessor for a memecoin trend analyzer. Your ONLY job: enrich raw post text with structured metadata so the downstream scorer has cleaner inputs.

You DO NOT score. You DO NOT judge. You DO NOT filter. Even if the input looks like spam, bot output, or gibberish, you STILL enrich it factually — the next stage decides what to do.

For each input trend, return:
- "topicSummary":    ONE sentence in plain English describing what the post is about. Decode hashtags, expand slang, name the subject. ≤200 chars. If text is purely gibberish/empty, summarise that fact ("Post contains only repeated emoji" / "Empty caption with hashtags only").
- "entityCanonical": array of canonical proper nouns mentioned (people, brands, products, places, fictional characters). Empty array if none. Keep canonical English names ("Илон Маск" → "Elon Musk").
- "language":        ISO 639-1 code of the primary language (the language of MEANINGFUL text — ignore hashtag-only fragments). Default "en" when unsure.
- "slangDecoded":    1-2 sentences explaining any non-obvious slang, abbreviations, or hashtag references that the next stage might miss. Empty string if all clear.

Respond with ONLY valid JSON of shape: {"trends": [...]} — array entries match input order exactly. Same length as input.`;

const NANO_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trends'],
  properties: {
    trends: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topicSummary', 'entityCanonical', 'language', 'slangDecoded'],
        properties: {
          topicSummary:    { type: 'string' },
          entityCanonical: { type: 'array', items: { type: 'string' } },
          language:        { type: 'string' },
          slangDecoded:    { type: 'string' },
        },
      },
    },
  },
};

export class NanoClassifier {
  constructor(config, logger, db = null) {
    this.logger = logger;
    // Optional DB handle — used for the admin-toggle kill switch. Old
    // callers without DB still work; they just lose the runtime toggle.
    this.db = db;
    this.apiKey = process.env.OPENAI_API_KEY || (config?.aiProviders?.openai?.apiKey || '');
    this.model = process.env.OPENAI_NANO_MODEL || 'gpt-5.4-nano';
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.maxBatch = parseInt(process.env.STAGE0_NANO_MAX_BATCH || '20', 10);

    // Layered enable check (lowest level — API key present at all):
    //   1. apiKey absent → permanently disabled, log once at startup
    //   2. STAGE0_NANO_ENABLED=0 → env-forced kill switch (panic mode,
    //      survives DB issues)
    //   3. DB setting `nanoEnabled` (default '1') → admin runtime toggle
    //      consulted on each classifyBatch call so the panel works without
    //      a restart.
    // (1) and (2) sit on `this.enabled` because they don't change at
    // runtime. (3) is checked dynamically in `_isAdminEnabled()`.
    const envForcedOff = process.env.STAGE0_NANO_ENABLED === '0';
    this.enabled = !!this.apiKey && !envForcedOff;

    if (!this.apiKey) {
      this.logger?.warn?.('NanoClassifier disabled — OPENAI_API_KEY missing');
    } else if (envForcedOff) {
      this.logger?.warn?.('NanoClassifier disabled via STAGE0_NANO_ENABLED=0 (env panic switch)');
    }
  }

  /**
   * Runtime kill switch read from the DB on each call. Allows admin UI to
   * flip nano on/off without restart. Returns true if the setting allows
   * nano to run, false if admin disabled it.
   *
   * DEFAULT FLIPPED 2026-05-09: nano is now OFF by default (was ON). After the
   * Stage 1 model rework (Grok / Gemini-3.1-flash-lite), nano became dead
   * weight — its three fields (topicSummary / entityCanonical / slangDecoded)
   * are duplicated by the new Stage 1 model with much better quality. We keep
   * the file alive so an operator can re-enable from the admin panel for A/B
   * tests, but the production path skips it.
   *
   * If the DB read fails we now default to FALSE (skip nano) — opposite of
   * the previous behaviour. Operators who want nano back must explicitly
   * toggle it on in the admin UI.
   */
  _isAdminEnabled() {
    if (!this.db?.getSetting) return false;
    try {
      const v = this.db.getSetting('nanoEnabled', '0');
      return String(v) === '1';
    } catch (_) {
      return false;
    }
  }

  /**
   * Classify a batch of trends. Returns array of metadata objects (or null
   * for failed entries) in the same order. NEVER throws — failures degrade
   * to nulls so the pipeline keeps running.
   */
  async classifyBatch(trends) {
    if (!this.enabled || !Array.isArray(trends) || trends.length === 0) {
      return (trends || []).map(() => null);
    }
    if (!this._isAdminEnabled()) {
      // Soft skip — log once per batch so the cycle log shows nano was
      // intentionally bypassed (vs. silently failing). Returns nulls so
      // downstream logic treats trends as "no nano data".
      this.logger?.info?.(`[NanoClassifier] skipped — disabled via admin panel`);
      return trends.map(() => null);
    }

    // Split into chunks if larger than configured max
    const chunks = [];
    for (let i = 0; i < trends.length; i += this.maxBatch) {
      chunks.push(trends.slice(i, i + this.maxBatch));
    }

    const results = [];
    for (const chunk of chunks) {
      const chunkResults = await this._classifyChunk(chunk);
      results.push(...chunkResults);
    }
    return results;
  }

  async _classifyChunk(trends) {
    const promptItems = trends.map((t, i) => {
      // Header line: title + source + light context tags. Subreddit and
      // sourceHashtag are ALSO topical signals (r/wallstreetbets vs r/aww),
      // and author@handle disambiguates entities ("@elonmusk posted X" vs
      // anonymous repost). All NON-numeric — we deliberately don't pass
      // metrics like views/likes/velocity here; nano is an enricher, not
      // a scorer, and Stage 1 already sees those raw numbers separately.
      const m = t.metrics || {};
      const tags = [];
      if (m.subreddit)     tags.push(`r/${m.subreddit}`);
      if (m.sourceHashtag) tags.push(`#${m.sourceHashtag}`);
      if (m.author)        tags.push(`by @${m.author}`);

      // Domain hint — only useful when it's NOT one of the obvious feed
      // domains (the post's source already covers those). External links
      // sometimes reveal context the title hides (a coingecko/etherscan/
      // news-site URL gives a strong topical anchor).
      const SKIP_DOMAINS = new Set([
        'twitter.com', 'x.com', 'reddit.com', 'redd.it',
        't.co', 'tiktok.com', 'vm.tiktok.com', 'youtube.com', 'youtu.be',
        'trends.google.com', 'google.com',
      ]);
      try {
        if (t.url) {
          const host = new URL(t.url).hostname.replace(/^www\./, '');
          if (host && !SKIP_DOMAINS.has(host)) tags.push(`link:${host}`);
        }
      } catch (_) { /* malformed URL — skip */ }

      const tagSuffix = tags.length ? ` (${tags.join(', ')})` : '';
      let line = `${i + 1}. Title: "${t.title || ''}" [Source: ${t.source || 'unknown'}]${tagSuffix}`;

      // Description: bumped 300 → 600. nano's context window is huge and
      // tokens are cheap; the extra 300 chars often contain the actual
      // joke/context that the title omits.
      if (t.description && t.description.trim()) {
        line += `\n   Description: ${t.description.slice(0, 600)}`;
      }

      // Sibling titles from cluster — when the same narrative shows up
      // across several posts with different wording, showing all variants
      // anchors topicSummary much better than any single title can.
      // Pre-deduped + capped at 5 in clusterer.js.
      if (Array.isArray(t.clusterSiblingTitles) && t.clusterSiblingTitles.length > 0) {
        const sibs = t.clusterSiblingTitles
          .slice(0, 5)
          .map(s => `"${(s || '').slice(0, 140)}"`)
          .join(' | ');
        line += `\n   RelatedPosts: ${sibs}`;
      }

      return line;
    }).join('\n\n');

    const userPrompt = `Enrich these ${trends.length} trends. Return JSON {trends: [...]} with one entry per input in the SAME ORDER.\n\nINPUT:\n${promptItems}`;

    const startedAt = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            { role: 'system', content: NANO_SYSTEM_PROMPT },
            { role: 'user',   content: userPrompt },
          ],
          // Force structured output — strict json_schema gives us shape guarantees.
          text: {
            format: {
              type: 'json_schema',
              name: 'nano_classify',
              schema: NANO_RESPONSE_SCHEMA,
              strict: true,
            },
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data.output_text
        || data.output?.[0]?.content?.[0]?.text
        || data.output?.find?.(o => o.type === 'message')?.content?.[0]?.text
        || '';
      if (!text) throw new Error('empty response_text');

      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed.trends) ? parsed.trends : [];

      const elapsedMs = Date.now() - startedAt;
      const inputTok = data.usage?.input_tokens || 0;
      const outputTok = data.usage?.output_tokens || 0;
      this.logger?.info?.(
        `[NanoClassifier] ${trends.length} trends in ${elapsedMs}ms ` +
        `(model=${this.model}, tokens=${inputTok}+${outputTok})`
      );

      // Map each input to its result (or null if missing)
      return trends.map((_, i) => items[i] || null);
    } catch (e) {
      this.logger?.warn?.(`[NanoClassifier] batch failed: ${e.message}`);
      return trends.map(() => null);
    }
  }
}

export default NanoClassifier;
