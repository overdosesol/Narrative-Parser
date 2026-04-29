/**
 * AI prompts for memecoin trend virality analysis
 *
 * v3 changes:
 *  - Adapted for general world trends (not crypto-native content)
 *  - Input = mainstream viral trends from Reddit, Twitter, Google Trends, TikTok
 *  - Task = evaluate each trend's potential to become a Solana memecoin
 *  - Improved scoring rubric with clearer examples
 *  - Better multilingual handling (trends come in all languages)
 */

import { LIFESPAN_VALUES, LIFESPAN_DESCRIPTORS } from './lifespan.js';

// Human-readable form for the Stage 1 prompt: "flash=hours, short=1-2 days, ..."
const LIFESPAN_HINT = LIFESPAN_VALUES
  .map(k => `${k}=${LIFESPAN_DESCRIPTORS[k]}`)
  .join(', ');

export const SYSTEM_PROMPT = `You are DEGEN-PARSER, a TRENDS / NARRATIVES analyst. Your focus is on spotting real viral narratives emerging on the internet — the kind of stories, memes, and moments that catch fire across platforms.

Your ONLY job: analyze MAINSTREAM internet trends and determine which ones have genuine narrative/meme energy strong enough that degens on Solana could latch onto them in the next 24-72 hours. Focus on the TREND itself — its shape, novelty, and cultural pull — not on whether a specific coin exists.

IMPORTANT CONTEXT: The trends you receive are NOT from crypto communities. They are general viral content from Reddit, Twitter, Google Trends, and TikTok — mainstream normie content. Your job is to spot the ones that DEGENS will notice and ape into.

━━━ WHAT MAKES A GREAT MEMECOIN NARRATIVE ━━━
• Bizarre animals doing unexpected things (cats, dogs, frogs, capybaras, etc.) — ALWAYS high potential
• Elon Musk mentions / tweets / actions → nearly ALWAYS spawns a coin
• A famous person says / does something absurd, embarrassing, or meme-worthy
• A viral meme, copypasta, or challenge sweeping social media
• Tech or AI doing something weird / failing publicly / making headlines
• Something with strong visual meme potential (funny images, reaction-worthy moments)
• Extreme stories, gambling wins/losses, underdog stories, cult-like communities
• Anything with a catchy, short, shout-able name that works as a ticker ($PEPE, $BONK, $DOGE)
• Cultural moments that unite the internet (song lyrics, movie references, gaming events)

━━━ SCORING RUBRIC (memePotential) ━━━
90-100: Legendary. Elon tweeted about it, or a meme animal went mega-viral. Coin launches within hours.
70-89:  Very strong. Massive engagement, funny/absurd, perfect ticker candidate. Degens WILL ape.
50-69:  Good potential. Trending broadly, has meme energy, needs a small push to become a coin.
30-49:  Medium. Interesting/funny but too niche, too serious, or already overdone.
10-29:  Weak. Real news without meme appeal, generic content, low virality.
0-9:    Zero potential. Politics, routine sports scores, corporate news, weather, ESG.

━━━ ENGAGEMENT CONTEXT ━━━
• When "Engagement Rate" is provided, use it as a RELATIVE signal:
  - A small account (10K followers) getting 20K likes = 200% engagement = INSANE virality, boost score
  - A mega-account (90M followers, e.g. Elon) getting 30K likes = 0.03% engagement = normal for them, DO NOT boost
  - High engagement rate (>5%) from ANY account size = strong organic virality signal
  - Low engagement rate (<0.1%) from mega-accounts = routine post, score based on content only
• MEGA-ACCOUNT RULE: A post from a large account (1M+ followers) with low/medium engagement rate is NOT a signal by itself.
  Score it ONLY on the novelty and meme potential of the CONTENT, not on raw view/like numbers.
  Ask yourself: "Is this a new narrative/meme idea, or just another tweet from a popular account?"
  If there is NO new idea, meme concept, or narrative — score it 0-20 regardless of absolute engagement numbers.

━━━ HARD RULES ━━━
1. Trends may come in ANY language (English, Spanish, Russian, Portuguese, etc.) — understand and evaluate them regardless of language.
2. All output fields must be in ENGLISH.
3. Politics (unless it's a viral absurd meme) = 0 memePotential. No exceptions.
4. Standard sports results = 0. Exception: a player does something insane/absurd/meme-worthy.
5. If the "trend" is clearly spam, bot-generated, crypto promotion, or nonsensical gibberish → set isGenuinelyInteresting: false and memePotential: 0.
6. If a trend is from Twitter/TikTok source, weight engagement metrics AND engagement rate together. Raw numbers alone are misleading without follower context.
7. Never invent context. If you don't know the topic, score conservatively.
8. Focus on NARRATIVE / MEME POTENTIAL not news importance. A silly cat video can score 90, a major political event scores 0.

━━━ PRESTAGE METADATA (when present) ━━━
Some trends include machine-generated metadata fields produced BEFORE you (Stage 0 preprocessors):
- "Topic" / "Slang" / "Entities" / "Language": from a small text-classifier (gpt-5.4-nano)
- "Visual" / "VisibleText" / "Mood" / "Video": from a vision model (Gemini Flash)
These fields are FACTUAL DESCRIPTIONS, not opinions. Use them to UNDERSTAND what the post actually contains — especially when the title is just hashtags or non-English slang.
DO NOT auto-boost score just because rich metadata was provided. A clear visual description of a boring scene is still a boring scene. A vivid bizarre-animal description IS a strong signal — but YOU decide that.
If the metadata contradicts the title (e.g. title is wholesome but visual shows something offensive), trust the visual.

Always respond with ONLY valid JSON. No markdown, no preamble, no explanation outside the JSON array.`;

export function buildAnalysisPrompt(trends) {
  const trendList = trends.map((t, i) => {
    let detail = `${i + 1}. "${t.title}" [Source: ${t.source}]`;

    if (t.description) {
      detail += `\n   Description: ${t.description}`;
    }

    // ── PreStage enrichment (Stage 0) — only present when PreStage ran ──
    // Surface nano text-classifier and gemini vision outputs verbatim.
    // None of these influence routing; they're context for the scorer.
    const ps = t.preStage;
    if (ps?.nano) {
      const n = ps.nano;
      if (n.topicSummary)                   detail += `\n   Topic: ${n.topicSummary}`;
      if (Array.isArray(n.entityCanonical) && n.entityCanonical.length > 0)
                                            detail += `\n   Entities: ${n.entityCanonical.slice(0, 8).join(', ')}`;
      if (n.slangDecoded && n.slangDecoded.trim())
                                            detail += `\n   Slang: ${n.slangDecoded}`;
      if (n.language && n.language !== 'en') detail += `\n   Language: ${n.language}`;
    }
    if (ps?.gemini) {
      const g = ps.gemini;
      if (g.visualCaption)                  detail += `\n   Visual: ${g.visualCaption}`;
      if (g.videoSummary && g.videoSummary.trim())
                                            detail += `\n   Video: ${g.videoSummary}`;
      if (g.visibleText && g.visibleText.trim())
                                            detail += `\n   VisibleText: "${g.visibleText}"`;
      if (g.mood)                           detail += `\n   Mood: ${g.mood}`;
    }

    // [MARKET_STAGE] optional context hint — remove 3 lines to disable
    const _msHint = t.clusterMetrics?.marketStage && t.clusterMetrics.marketStage !== 'none'
      ? { tokenizing: '⚠️ Market signal: TOKENIZING — launch discussions / pump.fun mentioned', live: '🟢 Market signal: LIVE MARKET — contract address or DEX links found', overheated: '🔴 Market signal: OVERHEATED — trading active but late/rug language detected' }[t.clusterMetrics.marketStage]
      : null;
    if (_msHint) detail += `\n   ${_msHint}`;

    if (t.metrics) {
      const m = t.metrics;

      // Age — critical for freshness scoring
      if (m.ageHours !== undefined) detail += `\n   Age: ${m.ageHours}h`;

      // Reddit metrics
      if (m.upvotes)      detail += `\n   Upvotes: ${m.upvotes} | Comments: ${m.comments || 0} | Velocity: ${m.velocity || 0}/hr`;
      if (m.subreddit)    detail += ` | r/${m.subreddit}`;
      if (m.positionScore !== undefined) detail += ` | Feed position: #${m.positionScore}`;

      // Google Trends metrics
      if (m.formattedTraffic) detail += `\n   Google Searches: ${m.formattedTraffic} | Geo: ${m.geo || 'worldwide'}`;

      // Twitter/X metrics
      if (m.views || m.likes || m.retweets) {
        detail += `\n   Twitter: ${m.views || 0} views | ${m.likes || 0} likes | ${m.retweets || 0} RTs`;
        if (m.tweetCount)  detail += ` | ${m.tweetCount} tweets`;
        if (m.viralScore)  detail += ` | Viral score: ${m.viralScore}/100`;
        if (m.tickers?.length) detail += ` | Tickers seen: ${m.tickers.join(', ')}`;
        if (m.author)      detail += ` | Top account: ${m.author}`;
        if (m.followers)   detail += ` | Followers: ${m.followers}`;
        if (m.engagementRate !== undefined) detail += ` | Engagement Rate: ${m.engagementRate}%`;
      }
      // Legacy twitter cross-reference from on-demand checker
      if (m.twitter && m.twitter.tweetCount > 0) {
        const tw = m.twitter;
        detail += `\n   Twitter (${tw.windowHours}h): ${tw.tweetCount} tweets`;
        if (tw.totalViews   > 0) detail += ` | 👁 ${tw.totalViews}`;
        if (tw.totalLikes   > 0) detail += ` | ❤️ ${tw.totalLikes}`;
        if (tw.totalRetweets > 0) detail += ` | 🔁 ${tw.totalRetweets}`;
        detail += ` | Viral: ${tw.viralityScore}/100`;
      }

      // TikTok metrics
      if (m.plays || m.videoCount) {
        detail += `\n   TikTok: ${m.plays || 0} plays | ${m.likes || 0} likes | ${m.shares || 0} shares`;
        if (m.videoCount) detail += ` | ${m.videoCount} videos in cluster`;
        if (m.sourceHashtag) detail += ` | Source: #${m.sourceHashtag}`;
        if (m.tickers?.length) detail += ` | Tickers: ${m.tickers.join(', ')}`;
        if (m.followers)   detail += ` | Followers: ${m.followers}`;
        if (m.engagementRate !== undefined) detail += ` | Engagement Rate: ${m.engagementRate}%`;
      }
    }

    return detail;
  }).join('\n\n');

  return `Analyze the following ${trends.length} mainstream internet trends and rate their SOLANA MEMECOIN POTENTIAL.

These trends come from general sources (Reddit, Twitter, Google Trends, TikTok) — NOT from crypto communities.
Your job: which of these mainstream trends could degens turn into a Solana memecoin?

For EACH trend, return a JSON object with these exact fields:
- "title"             : trend title in ENGLISH (use original if already English, translate otherwise)
- "viralityScore"     : internal base score 0-100 (pure virality, source-agnostic)
- "memePotential"     : 0-100 (how likely degens launch a Solana token today). MUST be 0 for boring/politics/sports-results.
- "category"          : one of [meme, elon, animals, tech_drama, degenerates, celebrity, sports_degen, ai_drama, boring, other]
- "sentiment"         : one of [positive, negative, neutral, mixed]
- "explanation"       : ONE short sentence (≤200 chars) WHY this is (or isn't) a great memecoin narrative — IN ENGLISH. Be terse: skip filler words like "this trend" / "is interesting because". State the reason directly.
- "whyNow"            : ONE short sentence naming the specific, concrete EVENT driving this trend RIGHT NOW (who did what, or what just happened). Only fill this if the data clearly points to a real triggering event — a tweet by a named person, a news story, a launch, a scandal, a viral clip, etc. If there is NO obvious trigger, or you would have to guess, return an empty string "". Do NOT speculate. Do NOT restate the title. IN ENGLISH.
- "predictedLifespan" : one of [${LIFESPAN_VALUES.join(', ')}]   (${LIFESPAN_HINT})
- "isGenuinelyInteresting": boolean — false ONLY for spam/bot/gibberish (also set memePotential to 0 in that case)

Respond ONLY with a JSON object of shape { "trends": [ ... ] } where the array
contains one object per input trend in the SAME ORDER. No markdown fences, no
extra text. (When the model is invoked with a json_schema response format the
schema is the source of truth — this text exists for non-strict providers.)

TRENDS:
${trendList}`;
}

// ─── Stage 1 JSON schema (Structured Outputs) ────────────────────────────────
//
// Used with OpenAI Responses API `text.format = { type: "json_schema", ... }`.
// Schema constraints enforced by the API:
//   - root must be an object (we wrap the array in `{ trends: [...] }`)
//   - every property must appear in `required`
//   - `additionalProperties: false` everywhere
//   - all enums must be exhaustive (we mirror the prompt rubric)
//
// Order of fields here must stay aligned with `_analyzeBatchStage1` consumer
// in scorer.js — adding/removing a field requires both ends.
export const STAGE1_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trends'],
  properties: {
    trends: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'viralityScore',
          'memePotential',
          'category',
          'sentiment',
          'explanation',
          'whyNow',
          'predictedLifespan',
          'isGenuinelyInteresting',
        ],
        properties: {
          title:                  { type: 'string', description: 'Trend title in English' },
          viralityScore:          { type: 'integer', minimum: 0, maximum: 100 },
          memePotential:          { type: 'integer', minimum: 0, maximum: 100 },
          category: {
            type: 'string',
            enum: ['meme', 'elon', 'animals', 'tech_drama', 'degenerates',
                   'celebrity', 'sports_degen', 'ai_drama', 'boring', 'other'],
          },
          sentiment: {
            type: 'string',
            enum: ['positive', 'negative', 'neutral', 'mixed'],
          },
          // Hard cap at 220 chars — strict json_schema enforces this on the
          // model side, so we don't need a defensive trim downstream. 220
          // (not 200) gives a small buffer for output tokenizer rounding.
          // Originally "1-2 sentences" → models returned 300-500 chars,
          // ballooning Stage 1 output cost AND polluting Stage 2's input.
          explanation:            { type: 'string', maxLength: 220, description: 'ONE short sentence (≤200 chars) explaining memecoin potential — terse, no filler' },
          whyNow:                 { type: 'string', description: 'Concrete trigger event in one short sentence, or empty string' },
          predictedLifespan: {
            type: 'string',
            // Schema enum derived from LIFESPAN_VALUES so renaming breaks
            // here too — no hardcoded duplicate list.
            enum: [...LIFESPAN_VALUES, 'unknown'],
          },
          isGenuinelyInteresting: { type: 'boolean' },
        },
      },
    },
  },
};

// ─── Stage 2: X Search deep-dive prompt ──────────────────────────────────────

// Compressed 2026-04-27 to cut Stage 2 input cost. Removed inline examples
// (Punch monkey / Moo Deng / Hawk Tuah) — Grok knows these. Removed dead
// `adjustment` field (was only consumed by market-stage.js which is itself
// feature-flagged off and now reads nothing). Removed `xSentiment` field —
// never consumed downstream. Result: ~750 → ~330 tokens of system prompt.
export const STAGE2_SYSTEM_PROMPT = `You are DEGEN-PARSER verifying a trend against live X discussion. Search X, judge, adjust. Do NOT evaluate coins/tickers — focus on the narrative itself.

Adjustments to memePotential:
• Massive organic buzz, many independent accounts, memes forming → +10..+25
• Clear momentum growing → +5..+15
• Stale / peaked / nobody still talks about it → -15..-30
• Backlash killing meme energy → -15..-25
• Bot / spam / single-account amplification → -20..-40
• No real X discussion found → -5..-15

storyScore (0-100) — stickiness of the story (named character + conflict + stakes = high). ADDITIVE booster only, never penalizes.
• 85-100: named character + conflict + stakes + shareable backstory
• 60-84: strong named character or memorable hook
• 30-59: mild hook, specific moment but no arc
• 0-29: no character / no story / generic

subjectName + nameStrength — tickerable proper name attached to the narrative. Animal/character/person/catchphrase/$TICKER all OK. Generic descriptors and topic labels do NOT count → return "". ADDITIVE booster only, never penalizes.
• 85-100: short, phonetic, unique, already memed
• 60-84: solid name, easily shortened to ticker
• 30-59: long, generic, or competes with existing tokens
• 0-29: weak / no name

Respond with ONLY valid JSON. No markdown, no preamble.`;

// Defensive cap on `aiExplanation` length when re-injected into Stage 2.
// Stage 1's json_schema now enforces maxLength=220 on `explanation`, so
// fresh outputs already arrive bounded. This cap stays as a safety net for:
//   - Older DB rows from before the schema cap (re-scoring path)
//   - Admin manual-submit flow that bypasses Stage 1's schema
//   - Any future provider that silently ignores maxLength
// Costs nothing — the cap is a no-op in the normal happy path.
const STAGE2_EXPLANATION_CAP = 220;

export function buildStage2Prompt(trend) {
  let detail = `Trend: "${trend.originalTitle || trend.title}"`;
  detail += `\nSource: ${trend.source}`;
  if (trend.aiExplanation) {
    const exp = String(trend.aiExplanation);
    detail += `\nInitial analysis: ${
      exp.length > STAGE2_EXPLANATION_CAP ? exp.slice(0, STAGE2_EXPLANATION_CAP) + '…' : exp
    }`;
  }
  detail += `\nInitial scores: meme=${trend.memePotential}, viral=${trend.score}, cat=${trend.category}`;
  return `Verify this trend on X and adjust scores.

${detail}

Return JSON ONLY (no markdown):
{
  "memePotential":      0-100,
  "viralityScore":      0-100,
  "xBuzz":              "none|low|medium|high|explosive",
  "narrativeMomentum":  "fading|flat|building|exploding",
  "organicity":         "organic|mixed|astroturf",
  "storyScore":         0-100,
  "storyHook":          "≤80 chars, character+conflict+stakes; empty if storyScore<30; ENGLISH",
  "subjectName":        "proper noun / ticker candidate, or empty",
  "nameStrength":       0-100
}`;
}

// ─── Trigger search (on-demand, replaces whyItWillPump) ──────────────────────
//
// Run on user click only — NOT in the automatic scoring pipeline. Uses Grok
// reasoning (grok-4-1-fast-reasoning) + x_search to identify the SPECIFIC
// catalyst that's driving a trend RIGHT NOW. Result is cached in DB and
// shared across all users (first click triggers Grok, the rest read from DB).
//
// This is intentionally factual (not a degen pitch) — names, dates, source
// accounts. Reasoning mode is justified because we want Grok to:
//   1. read multiple X search results
//   2. cross-reference timestamps to find the actual trigger event
//   3. identify amplifier accounts vs originator
//   4. distinguish "ongoing chatter" from "just-broke catalyst"

export const TRIGGER_SYSTEM_PROMPT = `You are a narrative-catalyst analyst. Given a trending topic, your job is to find the SPECIFIC EVENT happening RIGHT NOW that's driving the conversation on X.

Your tools:
- x_search: read actual top tweets about the trend in the last 24-48 hours
- reasoning: cross-reference timestamps, identify originator vs amplifiers, distinguish "the catalyst" from "ongoing chatter"

OUTPUT REQUIREMENTS:
- 2-3 plain-English sentences naming: WHAT happened, WHO is involved (real names/handles), WHEN it broke
- Cite specific X accounts that posted the most amplified content
- Confidence score reflecting how certain you are this is THE driver (vs noise)

WHAT COUNTS AS A TRIGGER:
- A specific viral post (with author + approximate time)
- A celebrity / authority quote-tweet or reply
- A breaking news event (launch, leak, arrest, death, scandal)
- A meme-format moment that just took off (and you can name the originator)
- A coordinated drop (NFT mint, token launch, product reveal)

WHAT DOES NOT COUNT (return confidence < 40 + acknowledge the absence):
- Generic ongoing chatter without a clear inciting moment
- Vague "people are talking about X" without a named trigger event
- Speculation about why something MIGHT be trending

RULES:
- NO degen pitch. NO "this will pump because..." NO ticker promotion. Pure factual catalyst summary.
- Names, dates, numbers ONLY if x_search confirms them. No invented attribution.
- If you searched and found nothing concrete, set confidence < 40 and trigger to "No specific catalyst found — narrative appears to be ongoing chatter without a clear trigger event."
- ENGLISH output.

Always respond with ONLY valid JSON. No markdown, no preamble.`;

export function buildTriggerPrompt(trend) {
  let detail = `Trend: "${trend.original_title || trend.originalTitle || trend.title || ''}"`;
  detail += `\nSource: ${trend.source || 'unknown'}`;
  if (trend.aiExplanation || trend.ai_explanation) {
    detail += `\nInitial pipeline analysis: ${trend.aiExplanation || trend.ai_explanation}`;
  }

  // Pull subject name from xSearchData if available — gives Grok a high-signal
  // anchor to search for instead of parsing it from the title.
  let subjectName = null;
  try {
    const rm = trend.raw_metrics ? JSON.parse(trend.raw_metrics) : (trend.metrics || {});
    subjectName = rm?.xSearchData?.subjectName || null;
  } catch { /* corrupt JSON, ignore */ }
  if (subjectName) detail += `\nKnown subject: ${subjectName}`;

  return `Find the current narrative trigger for this trend using x_search + reasoning.

${detail}

Search X/Twitter for the most viral discussion in the last 24-48 hours about this trend. Identify the ONE specific event/post/news that's driving it RIGHT NOW.

Return ONLY this JSON shape:
{
  "trigger":    "<2-3 sentences naming what/who/when, in English>",
  "confidence": <0-100 integer — how certain you are this is THE driver vs noise>,
  "sources":    ["@handle1", "@handle2", ...]   // up to 5 X accounts that amplified the trigger
}`;
}
