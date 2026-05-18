/**
 * junk-filter.js — Pre-alert heuristic junk penalty.
 *
 * Adds a `junkPenalty` (0–100) to cluster metrics.
 * High penalty = viral but useless for meme-coin narrative detection.
 *
 * Design goals:
 *  - Simple, deterministic, no ML
 *  - Easy to disable: remove the import + `base.junkPenalty` line in clusterer.js
 *  - Does NOT touch emergence/adoption/rankScore — purely additive metadata
 *
 * Penalty sources (stack additively, then capped at 100). All weights are
 * supplied by the active FILTER_PROFILE (see filter-profiles.js), which is
 * chosen based on the active search preset — so e.g. `animals` preset has
 * a stricter politics penalty than `events`, and `celebrities` treats
 * celeb-noise as signal (zero penalty).
 *
 * Safe-signal override:
 *  If the cluster contains strong meme-shape signals (animal, absurdity,
 *  visual meme, short punchy hook), ALL penalties are divided by
 *  profile.safeOverrideDivisor (or +1 when 2+ signals fire). This prevents
 *  false positives like "weird animal at government event".
 */

import { DEFAULT_PROFILE, resolveProfile } from './filter-profiles.js';

// ── Visual-content detection ────────────────────────────────────────────────
//
// Used by:
//   1. junk-filter itself — `noContentPenalty` adds a junk score when a cluster
//      has zero visual media.
//   2. scorer.js — applies a memePotential/score multiplier when a single trend
//      lacks media (the junk-filter signal alone only nudges alertScore, doesn't
//      touch the meme/viral numbers shown in the dashboard).
//
// Inputs can be either:
//   - cluster items   (have `.metrics.thumbnailUrl/imageUrl/videoUrl/imageUrls`,
//                      plus defensive fallback at the item root)
//   - a single trend  (same shape — clusterer copies item.metrics into trend)
//
// Returns true if ANY item in the array has at least one visual signal.
export function hasVisualContent(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.some(i => {
    const m = i.metrics || {};
    return Boolean(
      m.thumbnailUrl
      || m.imageUrl
      || m.videoUrl
      || (Array.isArray(m.imageUrls) && m.imageUrls.length > 0)
      // Some collectors put image refs at the item root too — defensive.
      || i.imageUrl
      || i.videoUrl
      || (Array.isArray(i.imageUrls) && i.imageUrls.length > 0)
    );
  });
}

// Sources that legitimately carry no media — penalty must not fire here.
// google_trends is search-interest signal (bare keywords), no post body to
// attach pictures to. Adding entries here is a deliberate "this source is
// text-by-design" declaration.
const TEXTLESS_SOURCES = new Set(['google_trends']);

export function isTextlessSource(source) {
  return TEXTLESS_SOURCES.has(String(source || '').toLowerCase());
}

// ── Pattern library ──────────────────────────────────────────────────────────

const RE_POLITICS = /\b(election|elections|president|presidential|government|parliament|minister|senate|senator|congress|congressman|congresswoman|vote|voting|ballot|protest|protesters|protest(?:ing|ers)|war|warfare|military|coup|regime|chancellor|cabinet|diplomat|diplomacy|sanctions|treaty|nato|un\s+security|white\s+house|kremlin|capitol|legislation|lawmakers|lawmaker|judiciary|supreme\s+court|geopolitics|ceasefire|occupation|referendum)\b/i;

const RE_KPOP = /\b(bts|blackpink|exo|nct\s*\d*|twice|stray\s*kids|aespa|seventeen|txt|tomorrow\s*x\s*together|enhypen|itzy|ive\b|newjeans|le\s*sserafim|gidle|g[- ]?idle|kpop|k-pop|k\s+pop|fandom|fancam|fansite|stan\b|stans\b|comeback\b|idol\b|oppa\b|unnie\b|saesang|bias\s+list|lightstick|daesang|melon\s+chart|gaon\s+chart|music\s+bank|inkigayo|m\s*countdown|fan\s*war)\b/i;

// Structural celebrity-noise patterns: "X attends Y", "X interview", "X fans react" etc.
const RE_CELEB_NOISE = /\b(attends\b|spotted\s+at\b|steps\s+out\b|red\s+carpet|gala\s+event|award\s+ceremony|film\s+premiere|opening\s+night|press\s+tour|magazine\s+cover|photo\s+shoot|brand\s+deal|endorsement|celebrity\s+feud|beef\s+with|fans\s+react|fan\s+reaction|reacts\s+to|opens\s+up\s+about|speaks\s+out|admits\s+to|relationship\s+status|dating\s+rumor|breakup|splits\s+from|engaged\s+to|baby\s+shower|pregnancy\s+news|world\s+tour|concert\s+tour|announces\s+tour|tour\s+dates)\b/i;

// Meme-shape signals — animals
const RE_ANIMAL = /\b(dog|dogs|cat|cats|frog|hamster|goat|goats|bear|bears|monkey|monkeys|fish|shark|penguin|bird|birds|duck|ducks|turtle|snail|rat|rats|mouse|mice|horse|horses|wolf|wolves|fox|foxes|shiba|doge|pepe|parrot|crab|crabs|chicken|chickens|cow|cows|pig|pigs|piglet|capybara|otter|otters|raccoon|raccoons|deer|bunny|bunnies|rabbit|rabbits|squirrel|seal|seals|whale|dolphin|lizard|gecko|axolotl|hedgehog|corgi|labrador|poodle|chihuahua|ferret|sloth|alpaca|llama|flamingo|pelican|pigeon|crow|raven|jellyfish|lobster|shrimp)\b/i;

// Meme-shape signals — absurdity / weirdness
const RE_ABSURD = /\b(weird|bizarre|strange|cursed|surreal|absurd|random|unexpected|accidentally|mistakenly|glitch|glitches|bug\b|bugs\b|fail\b|fails\b|malfunction|goes\s+wrong|nobody\s+expected|unbelievable|unhinged|deranged|feral|chaotic|ai\s+fail|ai\s+generated|hallucinate|hallucination|deepfake|confused|mistook|by\s+mistake|out\s+of\s+nowhere|nobody\s+asked|unprompted|drunk|sleepwalking|escaped|on\s+the\s+loose|broke\s+into|trespassing|accidentally\s+sent|wrong\s+number)\b/i;

// Meme-shape signals — visual / internet meme culture
const RE_MEME = /\b(meme|memes|meme-able|goes\s+viral|went\s+viral|going\s+viral|viral\s+moment|reaction\s+meme|meme\s+template|based\b|cringe\b|wholesome\b|cursed\s+image|greentext|copypasta|wojak|chad\b|npc\b|ratio\b|ratioed\b|skill\s+issue|touch\s+grass|rent\s+free|no\s+cap|bussin|slay\b|iconic\b|understood\s+the\s+assignment|main\s+character|villain\s+era|this\s+is\s+fine)\b/i;

// Charity / heartwarming (should not be penalized)
const RE_HEARTWARMING = /\b(rescue|rescued|saves?\s+\w+|adopted|adoption|donated|donation|fundrais|charity|kindness|viral\s+kindness|good\s+samaritan|wholesome|heartwarming|feel.good|reunited|reunion|surprise\s+gift|pays\s+it\s+forward)\b/i;

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Calculate junk penalty for a cluster.
 *
 * @param {Array}  items          — raw cluster items (with .title, .description)
 * @param {object} clusterMetrics — pre-computed cluster metrics (not modified here)
 * @param {string} [preset]       — active search preset name; selects the
 *                                  penalty profile. Unknown/missing → `general`.
 * @param {object} [overrides]    — admin-UI overrides blob (shape defined in
 *                                  filter-profiles.js). Passed to resolveProfile.
 * @returns {{ junkPenalty: number, junkReasons: string[], memeShapeBoost: number, memeShapeSignals: string[] }}
 *   junkPenalty       0–100 (0 = clean, 100 = pure junk)
 *   junkReasons       list of triggered rules (for logging/debugging)
 *   memeShapeBoost    positive bonus meant to be added to emergenceScore when
 *                     the cluster looks meme-shaped (animal / absurd / meme /
 *                     heartwarming). Rescues short single-source meme titles
 *                     from DROP_EMERGENCE_MAX so LLM gets a chance to evaluate.
 *                     2+ signals → ×1.5 (capped).
 *   memeShapeSignals  which meme signals fired (for logs)
 */
export function calculateJunkPenalty(items, clusterMetrics = {}, preset = null, overrides = null) {
  const profile = preset || overrides ? resolveProfile(preset, overrides) : DEFAULT_PROFILE;

  // Collect all text from the cluster
  const texts = items.map(i =>
    [i.title || '', i.description || ''].join(' ')
  ).join(' ');

  const reasons = [];
  let raw = 0;

  // ── Penalty: Politics ──────────────────────────────────────────────
  if (profile.politicsPenalty > 0 && RE_POLITICS.test(texts)) {
    raw += profile.politicsPenalty;
    reasons.push('politics');
  }

  // ── Penalty: K-pop / fandom ────────────────────────────────────────
  if (profile.kpopPenalty > 0 && RE_KPOP.test(texts)) {
    raw += profile.kpopPenalty;
    reasons.push('kpop/fandom');
  }

  // ── Penalty: Routine celebrity noise ──────────────────────────────
  if (profile.celebNoisePenalty > 0 && RE_CELEB_NOISE.test(texts)) {
    raw += profile.celebNoisePenalty;
    reasons.push('celeb-noise');
  }

  // ── Penalty: No meme-shape detected ───────────────────────────────
  const hasAnimal      = RE_ANIMAL.test(texts);
  const hasAbsurd      = RE_ABSURD.test(texts);
  const hasMeme        = RE_MEME.test(texts);
  const hasHeartwarming = RE_HEARTWARMING.test(texts);

  const hasMemeShape = hasAnimal || hasAbsurd || hasMeme || hasHeartwarming;

  if (profile.noMemeShapePenalty > 0 && !hasMemeShape) {
    raw += profile.noMemeShapePenalty;
    reasons.push('no-meme-shape');
  }

  // ── Penalty: text-only (no visual content) ────────────────────────
  // Posts that arrived without picture/video. Visual posts spread further
  // on social media; pure-text posts in the modern feed are usually news
  // copypasta or low-effort shower-thought tweets.
  //
  // Skipped when ALL items in the cluster are from sources that don't carry
  // media by design (google_trends — search-interest signal, no post body).
  // That keeps the penalty surgical: it targets twitter/reddit/tiktok where
  // a missing image IS a quality signal, not platform shape.
  //
  // IMPORTANT (2026-05-19): text-only is NOT folded into `raw` and therefore
  // NOT divided by safeOverrideDivisor below. Reasoning: even if the text
  // contains absurd/animal/meme regex hits, the FACT that the post lacks
  // visual media doesn't disappear. Previously a tweet with the word "chaos"
  // would trigger safe-override(÷3) and shrink the text-only penalty to ~2,
  // making the signal cosmetic. Now text-only contributes its full value
  // directly to the final junkPenalty, AFTER safe-override has been applied
  // to the other penalty buckets.
  let textOnlyAddition = 0;
  if (profile.noContentPenalty > 0) {
    const allTextlessByDesign = items.length > 0 && items.every(i => isTextlessSource(i.source));
    if (!allTextlessByDesign && !hasVisualContent(items)) {
      textOnlyAddition = profile.noContentPenalty;
      reasons.push('text-only');
    }
  }

  // ── Meme-shape boost (applied regardless of penalty state) ─────────
  // Even a "clean" cluster (no penalties at all) benefits from the boost —
  // this is what gives lonely single-source meme titles a chance to reach
  // LLM via the emergenceScore gate.
  const memeShapeSignals = [];
  if (hasAnimal)       memeShapeSignals.push('animal');
  if (hasAbsurd)       memeShapeSignals.push('absurd');
  if (hasMeme)         memeShapeSignals.push('meme');
  if (hasHeartwarming) memeShapeSignals.push('heartwarming');

  const perSignalBoost = profile.memeShapeBoost || 0;
  const signalCount    = memeShapeSignals.length;
  const memeShapeBoost = perSignalBoost > 0 && signalCount > 0
    ? Math.round(perSignalBoost * (signalCount >= 2 ? 1.5 : 1))
    : 0;

  // ── Safe-signal override ───────────────────────────────────────────
  // Strong meme signals heavily offset the junk penalty.
  // E.g. "weird goat at government event" → politics penalty but animal overrides.
  // Excludes text-only — that bucket is added AFTER this division.
  if (raw > 0 && hasMemeShape) {
    const baseDiv = profile.safeOverrideDivisor || 3;
    const divisor = signalCount >= 2 ? baseDiv + 1 : baseDiv;
    raw = Math.round(raw / divisor);
    reasons.push(`safe-override(÷${divisor})`);
  }

  // ── Add text-only AFTER safe-override (intentional — see comment above) ─
  raw += textOnlyAddition;

  return {
    junkPenalty:      Math.min(raw, 100),
    junkReasons:      reasons,
    memeShapeBoost,
    memeShapeSignals,
  };
}
