/**
 * GeminiCaptioner — Stage 0b vision preprocessing.
 *
 * Two-provider failover (2026-04-28 architecture):
 *   - PRIMARY:  Direct Google AI Studio (`generativelanguage.googleapis.com`)
 *               — supports BOTH images AND native video (up to 30s) via
 *                 inlineData with base64-encoded bytes.
 *               — geo-restricted (Germany/US/most-EU = supported,
 *                 RU/BY/etc = blocked).
 *   - FALLBACK: OpenRouter (`openrouter.ai/api/v1`)
 *               — gemini-2.5-flash via OpenAI-compatible chat/completions.
 *               — IMAGES ONLY (OpenRouter can't reliably proxy video).
 *               — for video trends the fallback uses the poster image,
 *                 sacrificing temporal info but keeping vision available.
 *
 * Failover triggers (any of these on a Google call → try OpenRouter next):
 *   - HTTP 429 (rate limit / quota exceeded)
 *   - HTTP 403 with FAILED_PRECONDITION (geo block, billing disabled)
 *   - HTTP 5xx (upstream issue)
 *   - Network/timeout errors
 *
 * Cooldown: after 3 consecutive Google failures, skip Google for 5 min and
 * route directly to OpenRouter. Resets on first Google success after window.
 *
 * NEVER filters, NEVER scores. Failures degrade silently (preStage.gemini = null).
 *
 * Output shape per trend:
 *   {
 *     // ── Visual ─────────────────────────────────────────────────────────
 *     visualCaption:    "Factual 1-2 sentence description",
 *     visibleText:      "Text visible in the visual",
 *     videoSummary:     "Temporal description for video, empty for image",
 *
 *     // ── Audio (video only — empty/false for static images & poster fallback) ─
 *     audioSummary:     "What is HEARD — speech/music/sound effects/atmosphere",
 *     spokenText:       "Verbatim transcript of speech in the video",
 *
 *     // ── Mood / quick tags ──────────────────────────────────────────────
 *     mood:             "Short emotional tone tag",
 *
 *     // ── Scoring signals (Gemini is now a downstream voter, not just a captioner) ─
 *     memeShapeStrength: 0-100,   // how meme-shaped the visual+audio is (animal,
 *                                  //   absurd, character, viral aesthetic, hook)
 *     hasNarrative:      boolean, // is there a story arc / something happens?
 *     hasSubject:        boolean, // is there a clear subject (person/animal/character)?
 * *     viralPattern:      string,  // 'character' | 'reaction' | 'pov_skit' |
 *                                  // 'compilation' | 'sound_format' | 'gameplay' |
 *                                  // 'animal_action' | 'event' | 'satisfying' |
 *                                  // 'asmr' | 'tutorial' | 'process' |
 *                                  // 'aesthetic' | 'other'
 *     tickerSuggestion:  string,  // short phonetic ticker candidate, "" if none
 *     subjectNames:      string[], // 0-4 display-form proper nouns of the main
 *                                  //   subject(s). [0] = primary. Used by
 *                                  //   formatter.js + dashboard for highlight.
 *
 *     // ── Filter flags ───────────────────────────────────────────────────
 *     isLipSync:         boolean, // true → alert-dispatcher hard-skips the trend
 *                                  //   (sound-format participation, not story)
 *     isAmbient:         boolean, // true → for source='tiktok' alert-dispatcher
 *                                  //   hard-skips. Scroll-bait / loop / hypnotic
 *                                  //   (satisfying / ASMR / tutorial / process /
 *                                  //   aesthetic vibe) without narrative arc.
 *
 *     // ── Meta ───────────────────────────────────────────────────────────
 *     mediaType:        "image" | "video",
 *     videoDurationSec: number | null,
 *     videoTruncated:   boolean,  // true when fell back to poster from video
 *     provider:         "google" | "openrouter"   // which one served the call
 *   }
 *
 * The OpenRouter fallback only sees static images (poster), so for it the
 * audio/narrative/lipsync/ambient fields are forced to safe defaults:
 *   audioSummary='', spokenText='', isLipSync=false, isAmbient=false,
 *   hasNarrative=false.
 * Other scoring fields the model still answers from the still image.
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const VISION_SYSTEM_PROMPT = `You are a MULTIMODAL ANALYZER for a memecoin trend system. You watch and LISTEN to image/video content and provide BOTH factual description AND scoring signals so the downstream scorer can make better decisions.

You do not filter (you never refuse to describe). But you ARE a downstream voter — your scoring fields directly influence whether this trend reaches alerts. Be honest and calibrated.

For VIDEO inputs you MUST analyze BOTH the visual track AND the audio track. The audio is part of the input (Google AI Studio passes media bytes including sound) — listen to it. Identify speech, music, sound effects, ambience. Transcribe spoken words verbatim. Audio is often where the actual narrative lives — what someone says/yells/laughs/reacts to is frequently more meme-relevant than what is visible.

Analyze the FIRST 30 SECONDS only — ignore anything past that.

Return these fields:

━━━ DESCRIPTION FIELDS ━━━
- "visualCaption":   1-2 complete sentences describing WHAT is visible (subjects, scene, art style). Concrete and factual ("Cartoon TREE characters with anthropomorphic faces in brown earth-tone palette") not promotional ("amazing viral meme!"). Tight — finish the thought, do not pad.
- "visibleText":     Any text, captions, watermarks, on-screen writing visible IN the visual. Empty string if none. Quote directly. If there is a lot, summarize the gist.
- "videoSummary":    For VIDEO: how the visual content unfolds over time, in 2-3 complete sentences. Empty string for static images.
- "audioSummary":    For VIDEO: what is HEARD — speech context, music genre/recognizable songs, sound effects, ambient noise, laughter/yells/reactions. 1-2 sentences. Empty string for static images. Be specific: "young woman whispering in ASMR style" beats "person speaking softly".
- "spokenText":      For VIDEO: VERBATIM transcript of what people say in English (translate non-English speech to English; quote in the original language only if it's meme-relevant gibberish). Empty string if no speech, or for static images. Cap at ~400 chars — quote the most meme-relevant lines if longer.

━━━ MOOD ━━━
- "mood":            SHORT phrase (1-3 words) describing emotional tone — absurd, wholesome, dramatic, surreal, humorous, ominous, mundane, etc. Take BOTH visual and audio into account.

━━━ SCORING SIGNALS (you are now voting) ━━━
- "memeShapeStrength": Integer 0-100. How meme-coin-shaped this content is. Combine visual + audio. High (70+): clear character, absurd action, catchy audio hook, single iconic moment, viral aesthetic. Medium (40-69): some meme energy but missing a hook OR the subject is generic. Low (0-39): news/political/corporate/static/no clear character. BE CALIBRATED — most content is 30-60.
- "hasNarrative":     Boolean. TRUE if something happens with a beginning/middle/end — a person reacts to something, an event unfolds, a punchline lands, a transformation occurs. FALSE if it's static repetition, generic dancing/posing without a plot, gameplay loops, slideshows.
- "hasSubject":       Boolean. TRUE if there is a CLEAR FOCAL SUBJECT — a specific person, animal, character, or object that is the "main character" of the content. FALSE for crowd shots, abstract visuals, generic landscapes, multiple equal-importance subjects.
- "viralPattern":     One of: "character" | "reaction" | "pov_skit" | "compilation" | "sound_format" | "dance_challenge" | "outfit_transition" | "gameplay" | "animal_action" | "event" | "satisfying" | "asmr" | "tutorial" | "process" | "aesthetic" | "other". Pick the dominant pattern. Definitions for the "ambient / sound-format" group (these are auto-rejected on TikTok regardless of engagement):
                      • "sound_format" — videos built around a trending audio/voiceover; creator participates in the format (lip-sync, sound bite reenactment, audio meme)
                      • "dance_challenge" — choreographed dance moves performed to a trending song or sound (TikTok dance challenges, #renegade-style, paired dances)
                      • "outfit_transition" — outfit reveal / glow-up / before-after / fashion transition cut to a beat drop (#wlw / #thegreatdivide / "tag yourself" formats)
                      • "satisfying" — slime / soap cutting / sand cutting / restoration / pressure washing / kinetic sand / pottery cutting (visual loops with no narrative)
                      • "asmr" — whispering / tapping / mukbang / eating sounds / quiet trigger sounds (audio-driven relaxation)
                      • "tutorial" — how-to walkthroughs (makeup / cooking / fitness / DIY / study technique) — instructional content, not narrative
                      • "process" — extended craft/build timelapses (cooking-from-scratch / woodworking / calligraphy / pottery building)
                      • "aesthetic" — vibe / mood content (study-with-me / "day in my life" / aesthetic vlogs / room ambience)
- "tickerSuggestion": Short phonetic ticker candidate (3-8 chars, all caps) IF the content has an obvious ticker-friendly subject. Examples: "PEPE", "CHILLGUY", "MOODENG". Empty string if no obvious candidate. DO NOT force it — empty is better than weak.
- "subjectNames":     Array of 0-4 proper-noun names of the MAIN subject(s) of the content, in display form as people would write them in normal text. First element = primary subject. Examples: ["Moo Deng"], ["Mr. Beast", "Logan Paul"], ["Chill Guy"], ["Pepe"], []. Rules:
                      • Display form only (e.g. "Moo Deng", NOT "MOODENG" or "moo deng"). The downstream code generates lowercase / no-space / hashtag variants for matching.
                      • Real names of characters, animals, projects, public figures who ARE the focal subject.
                      • SKIP generic platform / country / big-tech names (TikTok, YouTube, Twitter, USA, China, Apple, Google, Microsoft, Amazon) — these are context, not subjects.
                      • SKIP if there is no proper-noun subject (abstract concept, generic crowd, weather event without a named figure). Empty array is correct.
                      • Cap each name at 32 chars. Cap array at 4 entries.

━━━ FILTER FLAGS ━━━
- "isLipSync":       Boolean. TRUE for ANY form of sound-trend participation — videos where the creator is following a trending audio/format rather than telling their own story. This is broader than literal lip-syncing; it covers the entire family of "sound-driven format videos" that flood TikTok and never make memecoins.

                     Set TRUE when ANY of these apply:
                     • Lip-syncing / mouthing to a song, sound, or viral audio
                     • Dance moves / dance challenges performed to a trending sound (TikTok dance videos like #thegreatdivide / #wlw / #renegade — dancing IS sound-participation, even though "something is happening" visually)
                     • Outfit transitions, glow-ups, "before/after" reveals timed to a beat drop
                     • POV setups where the visual "story" is just overlay text + a sticker subject + trending audio (no original spoken lines, no real event)
                     • "Stitch" / "duet" responses where the participant adds NO original speech of their own
                     • Acting out a sound bite (creator reenacts a meme audio with facial expressions but no original words)
                     • Outfit/aesthetic loops cut to music (fashion/beauty trend videos)

                     The unifying principle: if you MUTED the audio, the video would be "a person dancing / posing / transitioning outfits / pointing at overlay text" — there is no event, no original dialogue, no story. The creator is participating in a FORMAT defined by the sound, not telling something new.

                     Set FALSE for: news clips, event recordings (concert footage / political rallies / sports plays), original dialogue / monologues / skits where the creator says their own words, interviews, animal action videos with an absurd specific action, gameplay with original commentary, streamer reactions with talking, vlogs with own narration, ASMR (those go to isAmbient). If the creator says/yells/laughs ORIGINAL words that drive the meaning of the video → FALSE. If they only mime / dance / pose / transition / point at overlay text to a sound → TRUE.

                     Decisive heuristic — the "audio source" test: is the audio (music/voiceover) ORIGINAL to this creator (their own words / sounds / commentary) or a TRENDING SOUND that thousands of other creators are also using? Original audio → FALSE. Trending / borrowed sound with no original speech on top → TRUE.

                     Static images: always FALSE.
- "isAmbient":       Boolean. TRUE if this is "scroll-bait" / loop / hypnotic content with NO narrative arc, NO meme hook, NO punchline — content people zone out to but never turn into a memecoin: satisfying loops, ASMR, tutorials, long process videos, aesthetic mood vlogs, generic gameplay loops. The litmus test: would a degen forward this to a friend with "you HAVE to see this"? If no, and the only appeal is "relaxing to watch" / "I just kept watching" — TRUE. FALSE for: event clips, character moments, reactions with punchlines, animal videos with a clear absurd action, original dialogue with a hook. Static images: always FALSE.

CRITICAL LENGTH RULE: every text field must be a COMPLETE thought ending with proper punctuation. Never cut mid-sentence or mid-word.

Respond with ONLY valid JSON. No markdown, no preamble.`;

const GOOGLE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    visualCaption:     { type: 'string' },
    visibleText:       { type: 'string' },
    videoSummary:      { type: 'string' },
    audioSummary:      { type: 'string' },
    spokenText:        { type: 'string' },
    mood:              { type: 'string' },
    memeShapeStrength: { type: 'integer' },
    hasNarrative:      { type: 'boolean' },
    hasSubject:        { type: 'boolean' },
    viralPattern:      { type: 'string' },
    tickerSuggestion:  { type: 'string' },
    subjectNames:      { type: 'array', items: { type: 'string' } },
    isLipSync:         { type: 'boolean' },
    isAmbient:         { type: 'boolean' },
  },
  // Only the original captioner fields stay strictly required — they're
  // what was working pre-Gemini-2.0 upgrade. The Gemini 2.0 additions
  // (audioSummary / spokenText / scoring / filter flags / subjectNames) are
  // OPTIONAL on the schema level: if the model skips one, JSON still
  // validates, captioner returns the partial result, and downstream code
  // applies safe defaults (=== true for booleans, clampInt fallback=0 for
  // memeShapeStrength, normalizeViralPattern → 'other', empty array for
  // subjectNames). Critical fix 2026-05-08: making all 14 fields required
  // was crashing the response on tricky content — captioner fell back to
  // null, so lipsync / tiktok_quality gates lost their input.
  required: ['visualCaption', 'visibleText', 'videoSummary', 'mood'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Output-coercion helpers. The Google Structured-Outputs schema enforces the
// type, but on parse-loose / OpenRouter / older fallback paths the model may
// emit a string for an integer or an unknown enum value. These helpers clamp
// to safe defaults instead of letting weird values flow downstream.
// ─────────────────────────────────────────────────────────────────────────────
const VIRAL_PATTERN_VALUES = new Set([
  'character', 'reaction', 'pov_skit', 'compilation',
  'sound_format', 'gameplay', 'animal_action', 'event',
  // Sound-format participation group — added 2026-05-08 after dance/transition
  // trends like #thegreatdivide / #wlw kept slipping through the lipsync
  // gate (they technically have "movement happening" but the audio is the
  // actual narrative). alert-dispatcher.js auto-skips these on TikTok.
  'dance_challenge', 'outfit_transition',
  // "Ambient" group — scroll-bait / loop / hypnotic content. These pattern
  // tags exist primarily so alert-dispatcher.js can hard-skip TikTok trends
  // matching them (no narrative, no meme hook, just "relaxing to watch").
  'satisfying', 'asmr', 'tutorial', 'process', 'aesthetic',
  'other',
]);

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeViralPattern(v) {
  const s = String(v || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/-+/g, '_');
  return VIRAL_PATTERN_VALUES.has(s) ? s : 'other';
}

// Code-side blacklist of names Gemini should not return as subject. Catches
// the case when the model ignores the prompt rule "skip platform/country/
// big-tech". Keep lower-case, single-token. Multi-word context names are
// handled by Gemini itself (the prompt is explicit about "TikTok" etc.).
const SUBJECT_NAME_BLACKLIST = new Set([
  // Platforms
  'tiktok', 'youtube', 'twitter', 'x', 'reddit', 'instagram', 'facebook',
  'meta', 'twitch', 'discord', 'telegram', 'whatsapp', 'snapchat', 'threads',
  // Big tech (rarely the *subject* of a meme — usually context)
  'apple', 'google', 'microsoft', 'amazon', 'samsung', 'sony', 'intel',
  // Countries / regions (way too generic)
  'usa', 'us', 'uk', 'eu', 'china', 'russia', 'india', 'japan', 'korea',
  'america', 'europe', 'asia', 'africa',
  // Devices / OS / generic tech
  'iphone', 'ipad', 'android', 'windows', 'macos', 'ios',
]);

// Sanitize subjectNames array. Drops blacklisted, empty, too-long, and
// duplicate entries. Caps array at 4. Returns array of trimmed display
// strings.
function normalizeSubjectNames(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = String(raw || '').trim().slice(0, 32);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    if (SUBJECT_NAME_BLACKLIST.has(key)) continue;
    // Reject single-letter and pure-numeric noise.
    if (s.length < 2 || /^\d+$/.test(s)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 4) break;
  }
  return out;
}

export class GeminiCaptioner {
  constructor(config, logger) {
    this.logger = logger;

    // ── Primary: Direct Google AI Studio ────────────────────────────────────
    this.googleKey   = process.env.GOOGLE_AI_API_KEY || '';
    this.googleModel = process.env.GOOGLE_AI_MODEL
      || process.env.GOOGLE_AI_VIDEO_MODEL    // back-compat alias
      || 'gemini-2.5-flash';
    this.googleBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';

    // ── Fallback: OpenRouter ────────────────────────────────────────────────
    this.openRouterKey   = process.env.OPENROUTER_API_KEY || '';
    this.openRouterModel = process.env.OPENROUTER_VISION_MODEL          || 'google/gemini-2.5-flash';
    this.openRouterFallbackModel = process.env.OPENROUTER_VISION_MODEL_FALLBACK || 'google/gemini-2.5-flash';
    this.openRouterBaseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

    // ── Knobs ───────────────────────────────────────────────────────────────
    this.timeoutMs   = parseInt(process.env.STAGE0_GEMINI_TIMEOUT_MS    || '45000', 10);
    this.downloadTimeoutMs = parseInt(process.env.STAGE0_DOWNLOAD_TIMEOUT_MS || '15000', 10);
    this.videoMaxSec = parseInt(process.env.STAGE0_VIDEO_MAX_SEC || '30',  10);
    this.videoMaxMb  = parseInt(process.env.STAGE0_VIDEO_MAX_MB  || '20',  10);
    this.imageMaxMb  = parseInt(process.env.STAGE0_IMAGE_MAX_MB  || '5',   10);

    // ── Cooldown for primary provider ───────────────────────────────────────
    // After N consecutive Google failures, skip it for `cooldownMs` and route
    // straight to OpenRouter. Reset counter on first success after cooldown.
    this.cooldownThreshold = parseInt(process.env.STAGE0_GOOGLE_COOLDOWN_FAILURES || '3', 10);
    this.cooldownMs        = parseInt(process.env.STAGE0_GOOGLE_COOLDOWN_MS       || '300000', 10);   // 5 min default
    this._googleFailures   = 0;
    this._googleCooldownUntil = 0;

    // OpenRouter primary→fallback model (one-shot, like before — protects
    // against admin setting a model that doesn't exist on OpenRouter).
    this._openRouterActiveModel = this.openRouterModel;
    this._openRouterPrimaryFailed = false;

    // ── URL → caption cache (TikTok thumbnails repeat across cycles) ──────
    this._cache = new Map();
    this._cacheTTLms = parseInt(process.env.STAGE0_GEMINI_CACHE_TTL_SEC || '300', 10) * 1000;

    this.hasGoogle     = !!this.googleKey;
    this.hasOpenRouter = !!this.openRouterKey;
    this.enabled       = this.hasGoogle || this.hasOpenRouter;

    if (!this.enabled) {
      this.logger?.warn?.('GeminiCaptioner disabled — neither GOOGLE_AI_API_KEY nor OPENROUTER_API_KEY set');
    } else {
      this.logger?.info?.(
        `GeminiCaptioner: primary=${this.hasGoogle ? 'google:' + this.googleModel : 'none'}, ` +
        `fallback=${this.hasOpenRouter ? 'openrouter:' + this.openRouterModel : 'none'}`
      );
    }
  }

  // Back-compat for admin Pipeline tooltip
  get _activeModel() { return this.googleModel; }

  /**
   * Caption a single trend. Returns metadata or null. Never throws.
   */
  async captionTrend(trend) {
    if (!this.enabled || !trend) return null;

    // Collectors write videoUrl into trend.metrics.videoUrl (twitter, reddit);
    // dashboard hoists it later, but during the pipeline (Stage 0 → cluster →
    // Stage 1/2) it lives inside metrics. Read both for safety so Gemini can
    // actually see the video instead of always falling through to the poster.
    const videoUrl = trend.videoUrl || trend.metrics?.videoUrl || null;
    const isVideo  = !!videoUrl;
    const posterUrl = trend.metrics?.imageUrls?.[0] || trend.imageUrl || null;
    if (!isVideo && !posterUrl) return null;

    // Primary URL = video for video trends, poster for image trends
    const primaryUrl = isVideo ? videoUrl : posterUrl;
    const cacheKey = this._hash(primaryUrl);
    const cached = this._cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    let videoDurationSec = null;
    let result = null;
    let videoTruncated = false;
    let videoClipped = false;     // true when we fed Gemini ffmpeg-trimmed first N sec
    // Why we fell through to the poster (used by the admin badge so we don't
    // mislead with "видео > 30s" when the real reason was a Google 503/cooldown).
    //   'duration_exceeded' — duration > STAGE0_VIDEO_MAX_SEC AND ffmpeg trim failed
    //   'native_unavailable' — native video call failed (Google down/cooldown,
    //                          or fallback was OpenRouter which is image-only)
    let truncationReason = null;
    let provider = null;

    if (isVideo) {
      // Probe duration once.
      videoDurationSec = await this._probeVideoDuration(primaryUrl).catch(() => null);
      const tooLong = videoDurationSec !== null && videoDurationSec > this.videoMaxSec;

      if (tooLong) {
        // Long video → ffmpeg-trim to first videoMaxSec, send the clip natively.
        // Falls through to poster only if trimming or Google call fails. This
        // is the architectural fix — we used to throw away long videos; now
        // we extract the most informative window (first N sec, where the meme
        // hook usually lives) and let Gemini caption it.
        this.logger?.info?.(
          `[GeminiCaptioner] video ${videoDurationSec.toFixed(1)}s > ${this.videoMaxSec}s, ` +
          `trimming to first ${this.videoMaxSec}s`
        );
        const trimmed = await this._trimVideoToBuffer(primaryUrl, this.videoMaxSec);
        if (trimmed && this._canUseGoogle()) {
          const r = await this._tryGoogleMedia(primaryUrl, 'video', trend, trimmed);
          if (r) {
            this._recordGoogleSuccess();
            result = r;
            provider = 'google';
            videoClipped = true;
          } else {
            this._recordGoogleFailure();
          }
        }
        // Trim or Google failed → poster fallback (preserves old behaviour).
        if (!result && posterUrl) {
          this.logger?.warn?.(
            `[GeminiCaptioner] trim path unavailable, falling back to poster`
          );
          videoTruncated = true;
          truncationReason = 'duration_exceeded';
          ({ result, provider } = await this._captionImageWithFailover(posterUrl, trend));
        } else if (!result && !posterUrl) {
          // No video, no trim, no poster — give up.
          return null;
        }
      } else {
        // Short video → send raw to Google.
        if (this._canUseGoogle()) {
          const r = await this._tryGoogleMedia(primaryUrl, 'video', trend);
          if (r) {
            this._recordGoogleSuccess();
            result = r;
            provider = 'google';
          } else {
            this._recordGoogleFailure();
          }
        }
        // 2) On video failure → poster image via OpenRouter (or Google, whichever is healthy)
        if (!result && posterUrl) {
          this.logger?.warn?.('[GeminiCaptioner] native video unavailable, falling back to poster');
          videoTruncated = true;
          truncationReason = 'native_unavailable';
          ({ result, provider } = await this._captionImageWithFailover(posterUrl, trend));
        }
      }
    } else {
      ({ result, provider } = await this._captionImageWithFailover(primaryUrl, trend));
    }

    if (!result) return null;

    const enriched = {
      ...result,
      mediaType: videoTruncated ? 'image' : (isVideo ? 'video' : 'image'),
      videoDurationSec,
      videoTruncated,
      videoClipped,    // true when video was ffmpeg-trimmed to first N sec (still 'video' mediaType)
      truncationReason,
      videoMaxSec: isVideo ? this.videoMaxSec : null,
      provider,
    };

    this._cache.set(cacheKey, { result: enriched, expiresAt: Date.now() + this._cacheTTLms });
    if (this._cache.size > 500) {
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }

    return enriched;
  }

  /**
   * Caption a batch — concurrency-capped fan-out. Returns array aligned to input.
   */
  async captionBatch(trends, { concurrency = 4 } = {}) {
    if (!this.enabled || !Array.isArray(trends) || trends.length === 0) {
      return (trends || []).map(() => null);
    }
    const results = new Array(trends.length).fill(null);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, trends.length) }, async () => {
      while (cursor < trends.length) {
        const i = cursor++;
        try { results[i] = await this.captionTrend(trends[i]); }
        catch (e) { this.logger?.warn?.(`[GeminiCaptioner] trend #${i} failed: ${e.message}`); }
      }
    });
    await Promise.all(workers);
    return results;
  }

  // ── Image flow with failover (Google primary → OpenRouter fallback) ────────

  async _captionImageWithFailover(imageUrl, trend) {
    // 1) Try Google direct
    if (this._canUseGoogle()) {
      const r = await this._tryGoogleMedia(imageUrl, 'image', trend);
      if (r) {
        this._recordGoogleSuccess();
        return { result: r, provider: 'google' };
      }
      this._recordGoogleFailure();
    }
    // 2) Fall back to OpenRouter
    if (this.hasOpenRouter) {
      const r = await this._tryOpenRouterImage(imageUrl, trend);
      if (r) return { result: r, provider: 'openrouter' };
    }
    return { result: null, provider: null };
  }

  // ── Google direct API call (handles both image and video via inlineData) ──

  /**
   * Download → base64 → POST to Google generateContent. Returns parsed
   * caption object, or null on any failure (caller decides whether to
   * fall back to OpenRouter).
   */
  /**
   * Send media (image or video) to Google AI Studio for captioning.
   *
   * @param {string} url        Source URL — used for download + diagnostic logs.
   * @param {string} kind       'image' | 'video'
   * @param {Object} trend      Trend object (for title context in prompt + log).
   * @param {Buffer|null} prefetched  Optional pre-fetched bytes (e.g. ffmpeg-trimmed
   *                                  video). When supplied, skips HEAD + download —
   *                                  the buffer is treated as the final payload.
   *                                  `url` still kept for log attribution.
   */
  async _tryGoogleMedia(url, kind /* 'image' | 'video' */, trend, prefetched = null) {
    if (!this.hasGoogle) return null;
    const startedAt = Date.now();
    const maxBytes = (kind === 'video' ? this.videoMaxMb : this.imageMaxMb) * 1024 * 1024;

    // Reddit (v.redd.it) and some Twitter video CDN endpoints reject the
    // default Node fetch User-Agent. Use a Chrome UA for media downloads —
    // mirrors what the Reddit collector already does for JSON API calls.
    //
    // TikTok CDN (tiktokv.com / tiktokcdn.com / tiktokcdn-us.com) additionally
    // gates by Referer — without `Referer: https://www.tiktok.com/` the URL
    // returns 403 even with a valid signed token. apidojo's `videoUrl` is
    // sometimes called "header-bound" because of this; it's not actually
    // bound to the original request — just needs a tiktok-origin Referer.
    const downloadHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (_isTikTokMediaUrl(url)) {
      downloadHeaders['Referer'] = 'https://www.tiktok.com/';
    }

    let buffer;
    let downloadContentType = null;
    let contentLength = null;

    if (prefetched) {
      // Bytes already in hand (e.g. ffmpeg trim output). Skip HEAD + download.
      buffer = prefetched;
      contentLength = buffer.length;
      downloadContentType = kind === 'video' ? 'video/mp4' : null;  // ffmpeg writes mp4
      if (buffer.length > maxBytes) {
        this.logger?.info?.(
          `[GeminiCaptioner] ${kind} prefetched ${(buffer.length / 1024 / 1024).toFixed(1)}MB ` +
          `exceeds cap, skipping`
        );
        return null;
      }
    } else {
      // 1. HEAD probe for early size rejection
      try {
        const head = await fetch(url, { method: 'HEAD', headers: downloadHeaders, signal: AbortSignal.timeout(8000) });
        const cl = head.headers.get('content-length');
        if (cl) contentLength = parseInt(cl, 10);
      } catch { /* HEAD optional */ }
      if (contentLength && contentLength > maxBytes) {
        this.logger?.info?.(`[GeminiCaptioner] ${kind} ${(contentLength / 1024 / 1024).toFixed(1)}MB > ${maxBytes / 1024 / 1024}MB cap, skipping`);
        return null;
      }

      // 2. Download bytes
      try {
        const res = await fetch(url, { headers: downloadHeaders, signal: AbortSignal.timeout(this.downloadTimeoutMs) });
        if (!res.ok) {
          this.logger?.warn?.(`[GeminiCaptioner] ${kind} download HTTP ${res.status}`);
          return null;
        }
        downloadContentType = res.headers.get('content-type') || null;
        buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > maxBytes) {
          this.logger?.info?.(`[GeminiCaptioner] ${kind} ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds cap after download, skipping`);
          return null;
        }
      } catch (e) {
        this.logger?.warn?.(`[GeminiCaptioner] ${kind} download failed: ${e.message}`);
        return null;
      }
    }

    // 3. Validate payload BEFORE shipping it to Google.
    //
    // Without this guard we'd send any non-image bytes to generateContent
    // labelled as image/jpeg → reliably eat 400 INVALID_ARGUMENT
    // ("Unable to process input image"). Verified via curl on 2026-04-29:
    // empty body, HTML 404 pages, redirect-HTML — all reproduce the 400.
    //
    // Twitter/Reddit CDN URLs expire silently (HTTP 200 with HTML body, or
    // HTTP 200 with 0-byte body, or 404), so this happens regularly in prod.
    // We refuse to send and let the caller fall back to OpenRouter.
    if (buffer.length === 0) {
      this.logger?.warn?.(
        `[GeminiCaptioner] ${kind} download returned empty buffer ` +
        `(stale CDN / 0-byte response, ct=${downloadContentType || 'none'}) — ` +
        `url=${String(url).slice(0, 120)}`
      );
      return null;
    }
    let sniffedMime = kind === 'video'
      ? this._sniffVideoMime(buffer)
      : this._sniffImageMime(buffer);

    // HEIC/HEIF posters (TikTok cover URLs ending in .heic) — Google doesn't
    // accept them directly. Convert to JPEG via ffmpeg first, then proceed
    // with the normal flow. Conversion ~50-300ms on a single-frame still.
    if (sniffedMime === 'image/heic') {
      const before = buffer.length;
      const converted = await this._convertHeicToJpeg(buffer);
      if (converted && converted.length > 0) {
        buffer = converted;
        sniffedMime = 'image/jpeg';
        this.logger?.info?.(
          `[GeminiCaptioner] HEIC→JPEG converted (${(before / 1024).toFixed(0)}KB → ${(buffer.length / 1024).toFixed(0)}KB)`
        );
      } else {
        // ffmpeg failed (no libheif in build / source corrupt / OOM) → drop.
        // OpenRouter image fallback would also reject HEIC, so there's no
        // point fanning out. Caller treats null as "Gemini unavailable".
        this.logger?.warn?.(
          `[GeminiCaptioner] HEIC conversion failed — skipping image. url=${String(url).slice(0, 120)}`
        );
        return null;
      }
    }

    if (!sniffedMime) {
      const firstBytesHex = buffer.slice(0, 16).toString('hex');
      const firstBytesAscii = buffer.slice(0, 80).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
      this.logger?.warn?.(
        `[GeminiCaptioner] ${kind} buffer signature unknown — refusing to ship to Google ` +
        `(would cause 400 INVALID_ARGUMENT). ` +
        `size=${buffer.length}b ct=${downloadContentType || 'none'} ` +
        `first16=${firstBytesHex} preview="${firstBytesAscii}" ` +
        `url=${String(url).slice(0, 120)}`
      );
      return null;
    }
    const mimeType = sniffedMime;
    const base64 = buffer.toString('base64');

    const userText = kind === 'video'
      ? `Title context: "${(trend.title || '').slice(0, 200)}"\n\nWatch AND LISTEN to this video — analyze BOTH visual and audio tracks. Focus on the FIRST 30 SECONDS ONLY. Transcribe spoken words verbatim into spokenText. Describe sounds/music in audioSummary. Return ALL fields per the schema (visualCaption, visibleText, videoSummary, audioSummary, spokenText, mood, memeShapeStrength, hasNarrative, hasSubject, viralPattern, tickerSuggestion, subjectNames, isLipSync, isAmbient).`
      : `Title context: "${(trend.title || '').slice(0, 200)}"\n\nDescribe this image. Return ALL fields per the schema. For a static image: videoSummary='', audioSummary='', spokenText='', hasNarrative=false, isLipSync=false, isAmbient=false. Other fields (memeShapeStrength, hasSubject, viralPattern, tickerSuggestion, subjectNames) — answer based on the still image.`;

    const apiUrl = `${this.googleBaseUrl}/models/${this.googleModel}:generateContent?key=${encodeURIComponent(this.googleKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: VISION_SYSTEM_PROMPT }] },
      contents: [{
        parts: [
          { text: userText },
          { inlineData: { mimeType, data: base64 } },
        ],
      }],
      // Reddit/Twitter memes regularly trip default safety thresholds for
      // HARASSMENT/SEXUALLY_EXPLICIT/etc. Without this override Gemini eats
      // input tokens (visible in AI Studio dashboard) but returns empty
      // candidates with finishReason=SAFETY — looks like "no output" to us.
      // We're a description preprocessor, not a content host — turn off.
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GOOGLE_RESPONSE_SCHEMA,
        // Bumped from 1024 → 3072 on 2026-05-08 after the Gemini 2.0 upgrade
        // added audioSummary / spokenText / 5 scoring fields / subjectNames.
        // The earlier ceiling was hitting truncation on rich video content
        // (long spokenText + full visualCaption + videoSummary), causing the
        // entire response to fail JSON parse → captioner returned null →
        // preStage.gemini = null → lipsync / tiktok_quality gates lost their
        // primary signal. 3072 gives ~3-4× headroom over the worst-case fields.
        maxOutputTokens: 3072,
        // Gemini 2.5 Flash has dynamic thinking on by default — for a vision
        // captioner we don't need it, and the thinking budget can eat the
        // output budget (returning empty `text` while consuming tokens).
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        // 4xx = our problem (bad payload, bad mime, oversized, bad auth) →
        // log full body + payload metadata so we can actually diagnose.
        // 5xx = Google's problem (overload, internal error) → keep short
        // because body is just a generic "high demand" template and we'd
        // flood logs during their incidents.
        if (res.status >= 400 && res.status < 500) {
          // Note: at this point `mimeType` is guaranteed to be a sniffed
          // signature (we refuse non-image/non-video buffers above), so
          // payload-shape 400s mean Google found something else wrong —
          // safety filter, schema mismatch, oversized inline data, etc.
          const meta = {
            kind,
            status: res.status,
            sentMime: mimeType,
            bufferBytes: buffer.length,
            bufferMb: +(buffer.length / 1024 / 1024).toFixed(2),
            headContentLength: contentLength,
            headMissing: contentLength === null,
            downloadContentType,
            url: String(url).slice(0, 120),
            trendTitle: String(trend?.title || '').slice(0, 80),
            trendSource: trend?.source || trend?.metrics?.source || null,
          };
          this.logger?.warn?.(
            `[GeminiCaptioner] Google ${kind} HTTP ${res.status} (CLIENT ERROR — investigate): ${errBody}`,
            meta
          );
        } else {
          this.logger?.warn?.(`[GeminiCaptioner] Google ${kind} HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        }
        return null;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) {
        // Empty output usually means SAFETY block, MAX_TOKENS hit, or RECITATION.
        // These all consume input tokens (visible in AI Studio dashboard) so
        // surfacing the actual reason is critical — without it we just see
        // "empty text" and assume Google is broken.
        const cand = data.candidates?.[0] || {};
        const finishReason = cand.finishReason || 'unknown';
        const safetyBlocked = (cand.safetyRatings || [])
          .filter(r => r.blocked || r.probability === 'HIGH' || r.probability === 'MEDIUM')
          .map(r => `${r.category}=${r.probability}`)
          .join(',') || 'none';
        const promptBlock = data.promptFeedback?.blockReason || null;
        const inputTok  = data.usageMetadata?.promptTokenCount     || 0;
        const outputTok = data.usageMetadata?.candidatesTokenCount || 0;
        this.logger?.warn?.(
          `[GeminiCaptioner] Google ${kind} returned empty text — ` +
          `finishReason=${finishReason}, promptBlock=${promptBlock || 'none'}, ` +
          `safetyTriggers=${safetyBlocked}, tokens=${inputTok}+${outputTok}`
        );
        return null;
      }
      const parsed = this._parseJsonLoose(text);
      if (!parsed) {
        this.logger?.warn?.(`[GeminiCaptioner] Google ${kind} parse failed: ${text.slice(0, 80)}`);
        return null;
      }

      const elapsedMs = Date.now() - startedAt;
      const inputTok  = data.usageMetadata?.promptTokenCount     || 0;
      const outputTok = data.usageMetadata?.candidatesTokenCount || 0;
      this.logger?.info?.(
        `[GeminiCaptioner] google ${kind} caption in ${elapsedMs}ms ` +
        `(model=${this.googleModel}, ${(buffer.length / 1024 / 1024).toFixed(2)}MB, tokens=${inputTok}+${outputTok}) ` +
        `— "${(trend.title || '').slice(0, 50)}"`
      );

      // Length is now controlled by the system prompt ("complete sentences,
      // never cut mid-word"). Slices below are runaway-token safety nets, not
      // formatting controls — generous enough to never clip a well-formed
      // response.
      return {
        visualCaption:     String(parsed.visualCaption || '').trim().slice(0, 800),
        visibleText:       String(parsed.visibleText   || '').trim().slice(0, 600),
        videoSummary:      String(parsed.videoSummary  || '').trim().slice(0, 800),
        audioSummary:      String(parsed.audioSummary  || '').trim().slice(0, 600),
        spokenText:        String(parsed.spokenText    || '').trim().slice(0, 800),
        mood:              String(parsed.mood          || '').trim().slice(0, 60),
        memeShapeStrength: clampInt(parsed.memeShapeStrength, 0, 100, 0),
        hasNarrative:      parsed.hasNarrative === true,
        hasSubject:        parsed.hasSubject === true,
        viralPattern:      normalizeViralPattern(parsed.viralPattern),
        tickerSuggestion:  String(parsed.tickerSuggestion || '').trim().slice(0, 16),
        subjectNames:      normalizeSubjectNames(parsed.subjectNames),
        // Coerce: model may omit field on rare occasions, default to false
        // (alert dispatcher uses === true, so missing/null/undefined never
        // accidentally hard-skips a legitimate trend).
        isLipSync:         parsed.isLipSync === true,
        isAmbient:         parsed.isAmbient === true,
      };
    } catch (e) {
      this.logger?.warn?.(`[GeminiCaptioner] Google ${kind} call failed: ${e.message}`);
      return null;
    }
  }

  // ── OpenRouter fallback (image only — OpenRouter can't proxy video) ───────

  async _tryOpenRouterImage(imageUrl, trend) {
    if (!this.hasOpenRouter) return null;

    const payload = {
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Title context: "${(trend.title || '').slice(0, 200)}"\n\nDescribe this image. Return ALL fields per the schema. For a static image: videoSummary='', audioSummary='', spokenText='', hasNarrative=false, isLipSync=false, isAmbient=false. Other fields (memeShapeStrength, hasSubject, viralPattern, tickerSuggestion) — answer based on the still image.` },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    };

    const tryModel = async (modelName) => {
      const startedAt = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.openRouterBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.openRouterKey,
            'HTTP-Referer': 'https://catalyst.app',
            'X-Title': 'Catalyst PreStage Vision',
          },
          body: JSON.stringify({ model: modelName, ...payload }),
          signal: ctrl.signal,
        });
        const elapsedMs = Date.now() - startedAt;

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const looksLikeUnknownModel = res.status === 404 ||
            /not a valid model|model not found|invalid model|no such model/i.test(body);
          if (looksLikeUnknownModel) {
            throw Object.assign(new Error('model-not-found: ' + body.slice(0, 120)), { code: 'MODEL_NOT_FOUND' });
          }
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content || '';
        if (!raw) throw new Error('empty content');
        const parsed = this._parseJsonLoose(raw);
        if (!parsed) throw new Error('parse-failure: ' + raw.slice(0, 80));

        const inputTok  = data.usage?.prompt_tokens     || 0;
        const outputTok = data.usage?.completion_tokens || 0;
        this.logger?.info?.(
          `[GeminiCaptioner] openrouter image caption in ${elapsedMs}ms ` +
          `(model=${modelName}, tokens=${inputTok}+${outputTok}) — "${(trend.title || '').slice(0, 50)}"`
        );

        return {
          visualCaption:     String(parsed.visualCaption || '').trim().slice(0, 800),
          visibleText:       String(parsed.visibleText   || '').trim().slice(0, 600),
          videoSummary:      '',
          // OpenRouter fallback runs on a static poster image — no audio or
          // motion. Force the audio/narrative/lipsync/ambient fields to safe
          // defaults regardless of what the model returns.
          audioSummary:      '',
          spokenText:        '',
          hasNarrative:      false,
          isLipSync:         false,
          isAmbient:         false,
          mood:              String(parsed.mood          || '').trim().slice(0, 60),
          // The model can still answer these from the still image.
          memeShapeStrength: clampInt(parsed.memeShapeStrength, 0, 100, 0),
          hasSubject:        parsed.hasSubject === true,
          viralPattern:      normalizeViralPattern(parsed.viralPattern),
          tickerSuggestion:  String(parsed.tickerSuggestion || '').trim().slice(0, 16),
          subjectNames:      normalizeSubjectNames(parsed.subjectNames),
        };
      } finally {
        clearTimeout(timer);
      }
    };

    const modelUsed = this._openRouterActiveModel;
    try {
      return await tryModel(modelUsed);
    } catch (e) {
      if (e.code === 'MODEL_NOT_FOUND' && modelUsed === this.openRouterModel) {
        if (!this._openRouterPrimaryFailed) {
          this._openRouterPrimaryFailed = true;
          this._openRouterActiveModel = this.openRouterFallbackModel;
          this.logger?.warn?.(`[GeminiCaptioner] OpenRouter primary model ${this.openRouterModel} not available, switching to ${this.openRouterFallbackModel}`);
        }
        try { return await tryModel(this.openRouterFallbackModel); }
        catch (e2) {
          this.logger?.warn?.(`[GeminiCaptioner] OpenRouter fallback also failed: ${e2.message}`);
          return null;
        }
      }
      this.logger?.warn?.(`[GeminiCaptioner] OpenRouter call failed: ${e.message}`);
      return null;
    }
  }

  // ── Cooldown bookkeeping for the primary provider ─────────────────────────

  _canUseGoogle() {
    return this.hasGoogle && Date.now() >= this._googleCooldownUntil;
  }

  _recordGoogleSuccess() {
    this._googleFailures = 0;
    if (this._googleCooldownUntil) {
      this.logger?.info?.('[GeminiCaptioner] Google AI back to healthy, exiting cooldown');
      this._googleCooldownUntil = 0;
    }
  }

  _recordGoogleFailure() {
    this._googleFailures++;
    if (this._googleFailures >= this.cooldownThreshold) {
      this._googleCooldownUntil = Date.now() + this.cooldownMs;
      this._googleFailures = 0;
      const minutes = Math.round(this.cooldownMs / 60000);
      this.logger?.warn?.(`[GeminiCaptioner] Google AI failed ${this.cooldownThreshold}× in a row, cooling down for ~${minutes}min — routing to OpenRouter`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _probeVideoDuration(videoUrl) {
    return new Promise((resolve) => {
      // ffprobe sends a default UA that some CDNs reject, and TikTok additionally
      // requires Referer — without these probe returns code 1 ("HTTP 403") and
      // we'd think the video has no duration. Adding both is harmless for other
      // hosts (Twitter / Reddit / fxtwitter all accept anything).
      const ffprobeArgs = [
        '-v', 'error',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ];
      if (_isTikTokMediaUrl(videoUrl)) {
        ffprobeArgs.push('-referer', 'https://www.tiktok.com/');
      }
      ffprobeArgs.push(
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoUrl,
      );
      const proc = spawn('ffprobe', ffprobeArgs);
      let buf = '';
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
      proc.stdout.on('data', d => { buf += d.toString(); });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => {
        if (code !== 0) return finish(null);
        const sec = parseFloat(buf.trim());
        finish(Number.isFinite(sec) && sec > 0 ? sec : null);
      });
      setTimeout(() => {
        if (!settled) { try { proc.kill('SIGKILL'); } catch {} finish(null); }
      }, 5000);
    });
  }

  /**
   * Clip the first `maxSec` seconds of a remote video and return its bytes.
   *
   * Uses ffmpeg with `-c copy` (stream copy, no re-encode) — typically 50-300ms
   * total because we just rewrite container metadata + copy raw packets, no
   * decode/encode pipeline. Output goes to a temp mp4 file then gets read back
   * as Buffer (streaming-to-pipe needs fragmented mp4 which Gemini doesn't
   * always accept; tmpfile is more compatible).
   *
   * Adds proper headers for sources that gate by them:
   *   - User-Agent (Chrome) — Reddit v.redd.it, some Twitter CDN endpoints
   *   - Referer https://www.tiktok.com/ — TikTok CDN (apidojo videoUrl etc.)
   *
   * Returns null on:
   *   - ffmpeg failure (non-zero exit, source unreachable, codec mismatch)
   *   - timeout (downloadTimeoutMs)
   *   - empty output (corrupt source)
   *   - resulting buffer >videoMaxMb (very rare — 30s clip should fit easily)
   *
   * Caller must always handle null by falling back to poster captioning.
   */
  async _trimVideoToBuffer(videoUrl, maxSec) {
    const tmpFile = path.join(
      os.tmpdir(),
      `catalyst-trim-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`,
    );
    return new Promise((resolve) => {
      const args = [
        '-y',                                    // overwrite (defensive)
        '-v', 'error',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ];
      if (_isTikTokMediaUrl(videoUrl)) {
        args.push('-referer', 'https://www.tiktok.com/');
      }
      args.push(
        '-i', videoUrl,
        '-t', String(maxSec),
        '-c', 'copy',                            // no re-encode — instant
        '-movflags', '+faststart',               // moov at start (Gemini expects this)
        tmpFile,
      );

      const proc = spawn('ffmpeg', args);
      let stderrBuf = '';
      proc.stderr.on('data', d => { stderrBuf += d.toString(); });

      let settled = false;
      const cleanup = async () => {
        try { await fs.unlink(tmpFile); } catch { /* already gone */ }
      };
      const finish = async (val) => {
        if (settled) return;
        settled = true;
        await cleanup();
        resolve(val);
      };

      proc.on('error', (e) => {
        this.logger?.warn?.(`[GeminiCaptioner] ffmpeg trim spawn error: ${e.message}`);
        finish(null);
      });
      proc.on('close', async (code) => {
        if (settled) return;
        if (code !== 0) {
          this.logger?.warn?.(
            `[GeminiCaptioner] ffmpeg trim exit ${code}: ${stderrBuf.slice(0, 200)}`
          );
          return finish(null);
        }
        try {
          const buf = await fs.readFile(tmpFile);
          if (buf.length === 0) return finish(null);
          if (buf.length > this.videoMaxMb * 1024 * 1024) {
            this.logger?.info?.(
              `[GeminiCaptioner] trimmed video ${(buf.length / 1024 / 1024).toFixed(1)}MB ` +
              `> ${this.videoMaxMb}MB cap — falling back to poster`
            );
            return finish(null);
          }
          // Read OK, return buffer (cleanup happens after)
          settled = true;
          await fs.unlink(tmpFile).catch(() => {});
          resolve(buf);
        } catch (e) {
          this.logger?.warn?.(`[GeminiCaptioner] ffmpeg trim read failed: ${e.message}`);
          finish(null);
        }
      });

      setTimeout(() => {
        if (settled) return;
        try { proc.kill('SIGKILL'); } catch {}
        this.logger?.warn?.(`[GeminiCaptioner] ffmpeg trim timeout after ${this.downloadTimeoutMs}ms`);
        finish(null);
      }, this.downloadTimeoutMs);
    });
  }

  _sniffImageMime(buffer) {
    if (buffer.length < 12) return null;
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
    if (buffer.slice(0, 4).toString() === 'GIF8') return 'image/gif';
    if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    // HEIC / HEIF (Apple iPhone format). TikTok cover URLs sometimes return
    // .heic posters which neither Google nor OpenRouter accept directly.
    // We return a synthetic 'image/heic' marker so the caller can spot it
    // and run an ffmpeg conversion to JPEG before shipping. Brands per
    // ISO/IEC 23008-12: heic / heix (HEIC), mif1 / msf1 (HEIF), heim / heis
    // (multi-image / image-sequence variants — same conversion path).
    if (buffer.slice(4, 8).toString() === 'ftyp') {
      const brand = buffer.slice(8, 12).toString();
      if (brand === 'heic' || brand === 'heix'
          || brand === 'mif1' || brand === 'msf1'
          || brand === 'heim' || brand === 'heis') {
        return 'image/heic';
      }
    }
    return null;
  }

  /**
   * Convert HEIC/HEIF bytes to JPEG via ffmpeg piped through stdin/stdout.
   * Modern ffmpeg builds (Debian bookworm / Ubuntu 22.04+ / Alpine 3.18+)
   * include libheif and decode HEIC out of the box. Older builds will fail
   * the spawn with "Could not find tag for codec hevc" — we treat that as
   * a soft fail (return null) so the caller falls back to OpenRouter.
   *
   * Returns Buffer (JPEG bytes) on success, null on any failure.
   */
  async _convertHeicToJpeg(buffer) {
    return new Promise((resolve) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-v', 'error',
        '-i', 'pipe:0',
        '-vframes', '1',          // single still — HEIC sequences pick first frame
        '-f', 'mjpeg',            // JPEG-encoded MPEG container == raw JPEG bytes
        '-q:v', '4',              // visually lossless-ish (1=best, 31=worst)
        'pipe:1',
      ]);
      const chunks = [];
      let stderrBuf = '';
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
      proc.stdout.on('data', d => chunks.push(d));
      proc.stderr.on('data', d => { stderrBuf += d.toString(); });
      proc.on('error', (err) => {
        this.logger?.warn?.(`[GeminiCaptioner] HEIC→JPEG ffmpeg spawn error: ${err.message}`);
        finish(null);
      });
      proc.on('close', (code) => {
        if (code !== 0 || chunks.length === 0) {
          this.logger?.warn?.(
            `[GeminiCaptioner] HEIC→JPEG ffmpeg failed (code=${code}, stderr=${stderrBuf.slice(0, 160)})`
          );
          return finish(null);
        }
        const out = Buffer.concat(chunks);
        finish(out.length > 0 ? out : null);
      });
      try {
        proc.stdin.write(buffer);
        proc.stdin.end();
      } catch (e) {
        this.logger?.warn?.(`[GeminiCaptioner] HEIC→JPEG stdin write failed: ${e.message}`);
        try { proc.kill('SIGKILL'); } catch {}
        finish(null);
      }
      // Hard 10s ceiling — single-frame conversion is normally <500ms.
      setTimeout(() => {
        if (!settled) { try { proc.kill('SIGKILL'); } catch {} finish(null); }
      }, 10_000);
    });
  }

  _sniffVideoMime(buffer) {
    if (buffer.length < 12) return null;
    if (buffer.slice(4, 8).toString() === 'ftyp') {
      const brand = buffer.slice(8, 12).toString();
      if (brand.startsWith('qt')) return 'video/quicktime';
      return 'video/mp4';
    }
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
      return 'video/webm';
    }
    return null;
  }

  _parseJsonLoose(text) {
    let s = String(text || '').trim();
    if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(s); } catch { /* try to find first {…} block */ }
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  _hash(str) {
    return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 16);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detect a TikTok-CDN media URL (video or cover). Used to know when to add
 * `Referer: https://www.tiktok.com/` to fetch / ffprobe — without it TikTok's
 * CDN returns 403. The match is intentionally broad (covers tiktokcdn.com,
 * tiktokv.com, tiktokcdn-us.com, p16-sign-*.tiktokcdn-us.com etc.) so future
 * subdomain reshuffles by TikTok don't quietly break us.
 */
function _isTikTokMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /(?:^|\.)(?:tiktok|tiktokcdn|tiktokcdn-us|tiktokv)\.com\b/i.test(url);
}

export default GeminiCaptioner;
