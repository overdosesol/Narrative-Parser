/**
 * filter-profiles.js — per-preset junk-filter tuning.
 *
 * Each active search preset (general / animals / culture / celebrities / events)
 * has different expectations about what counts as noise vs signal. A K-pop
 * cluster in the `celebrities` preset is the whole point; in `animals` it is
 * pure junk. This module centralizes those differences so `junk-filter.js`
 * stays dumb and just applies whatever profile it's handed.
 *
 * Defaults live in this file; admin-UI overrides are persisted in the
 * `filterProfiles` DB setting as a JSON blob of shape:
 *   { "<preset>": { "<field>": <number>, ... }, ... }
 * Only the fields present in overrides are taken; everything else falls
 * back to the defaults below. So an admin can tweak a single knob on a
 * single preset without re-specifying the whole table.
 *
 * Fields:
 *   politicsPenalty      — added when RE_POLITICS matches
 *   kpopPenalty          — added when RE_KPOP matches
 *   celebNoisePenalty    — added when RE_CELEB_NOISE matches
 *   noMemeShapePenalty   — added when no meme-shape signal is present
 *   safeOverrideDivisor  — if any meme-shape signal fires, total penalty is
 *                          divided by this (2+ signals → divisor + 1).
 *                          Lower = stronger override.
 */

export const FILTER_PROFILES = {
  // 🌐 General — universal defaults (original behaviour)
  general: {
    politicsPenalty:     40,
    kpopPenalty:         30,
    celebNoisePenalty:   20,
    noMemeShapePenalty:  15,
    noContentPenalty:     5,  // small nudge against text-only posts
    safeOverrideDivisor: 3,
    memeShapeBoost:      10,
  },

  // 🐾 Animals — noise is everything non-animal
  animals: {
    politicsPenalty:     60,  // politics drowns out pet content
    kpopPenalty:         40,
    celebNoisePenalty:   30,
    noMemeShapePenalty:  10,  // animals are already a meme-shape signal
    noContentPenalty:     8,  // animal posts without media = stock-text noise
    safeOverrideDivisor: 3,
    memeShapeBoost:      14,  // animal/absurd match → strong promotion to LLM
  },

  // 🎭 Culture — memes, internet slang, ratio/cancel discourse
  culture: {
    politicsPenalty:     30,  // culture-adjacent politics (ratio, cancel) is ok
    kpopPenalty:         10,  // stan culture IS part of internet culture
    celebNoisePenalty:   20,
    noMemeShapePenalty:  25,  // meme-shape is required here
    noContentPenalty:     6,
    safeOverrideDivisor: 3,
    memeShapeBoost:      12,
  },

  // ⭐ Celebrities — celeb content is the target, not noise
  celebrities: {
    politicsPenalty:     40,
    kpopPenalty:         15,
    celebNoisePenalty:    0,  // ← celeb noise is the whole point
    noMemeShapePenalty:  20,
    noContentPenalty:     5,
    safeOverrideDivisor: 3,
    memeShapeBoost:       6,  // celeb content rarely needs meme-shape promotion
  },

  // 🌍 Events — world events, protests, sports, AI news
  events: {
    politicsPenalty:     15,  // protests/elections ARE the content
    kpopPenalty:         30,
    celebNoisePenalty:   20,
    noMemeShapePenalty:  10,  // real events don't need meme-shape
    noContentPenalty:     0,  // events often break as text-first news, no penalty
    safeOverrideDivisor: 2,   // easier override (2+ signals → ÷3)
    memeShapeBoost:       4,  // events preset focuses on news, not memes
  },
};

export const DEFAULT_PROFILE = FILTER_PROFILES.general;

// Allowed preset keys — used by admin validator. Keep in sync with FILTER_PROFILES.
export const PRESET_KEYS = Object.freeze(['general', 'animals', 'culture', 'celebrities', 'events']);

// Per-field validation ranges. The admin UI renders sliders/inputs using these,
// and the admin server validates POST bodies against them.
export const PROFILE_FIELD_RANGES = Object.freeze({
  politicsPenalty:     { min: 0, max: 100, step: 5, label: 'Политика',        desc: 'Штраф если кластер о политике/войне' },
  kpopPenalty:         { min: 0, max: 100, step: 5, label: 'K-pop / фандом',   desc: 'Штраф за стан-культуру' },
  celebNoisePenalty:   { min: 0, max: 100, step: 5, label: 'Celeb-noise',      desc: 'Рутинный celeb-шум (интервью, red carpet)' },
  noMemeShapePenalty:  { min: 0, max: 100, step: 5, label: 'Нет meme-shape',   desc: 'Штраф если нет животных/абсурда/мемов' },
  noContentPenalty:    { min: 0, max: 50,  step: 1, label: 'Нет контента (text-only)', desc: 'Штраф за пост без картинок/видео. Не применяется к google_trends' },
  safeOverrideDivisor: { min: 1, max: 10,  step: 1, label: 'Safe-override ÷',  desc: 'Делитель при наличии meme-сигнала (меньше = сильнее override)' },
  memeShapeBoost:      { min: 0, max: 30,  step: 1, label: 'Meme-shape буст',  desc: 'Прибавка к emergenceScore при mem-сигнале (животное/абсурд/мем). 2+ сигнала → ×1.5. 0 = отключено' },
});

export const PROFILE_FIELDS = Object.freeze(Object.keys(PROFILE_FIELD_RANGES));

/**
 * Resolve the effective filter profile for a preset.
 * Unknown preset names fall back to `general`.
 *
 * @param {string}  preset    — active preset key (e.g. 'events')
 * @param {object} [overrides] — optional per-preset overrides from DB, shape:
 *                              { <preset>: { <field>: number, ... }, ... }
 *                              Only listed fields override defaults.
 */
export function resolveProfile(preset, overrides = null) {
  const key = preset ? String(preset).toLowerCase() : 'general';
  const base = FILTER_PROFILES[key] || DEFAULT_PROFILE;
  if (!overrides || typeof overrides !== 'object') return base;
  const patch = overrides[key];
  if (!patch || typeof patch !== 'object') return base;
  return { ...base, ...patch };
}

/**
 * Return the full table of effective profiles (defaults merged with overrides).
 * Useful for the admin UI: one call, ready to render.
 */
export function getEffectiveProfiles(overrides = null) {
  const out = {};
  for (const key of PRESET_KEYS) {
    out[key] = resolveProfile(key, overrides);
  }
  return out;
}

/**
 * Sanitize & validate an overrides payload coming from the admin UI.
 * Throws on invalid input. Returns a clean object safe to JSON.stringify.
 *
 * Rules:
 *   - top-level keys must be in PRESET_KEYS
 *   - each value must be an object of { field: number }
 *   - fields must be in PROFILE_FIELD_RANGES; values within [min, max]
 *   - if an override value equals the default, the field is stripped
 *     (keeps the stored blob small and meaningful)
 */
export function validateProfileOverrides(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('filterProfiles: must be an object');
  }
  const out = {};
  for (const [preset, patch] of Object.entries(input)) {
    const pkey = String(preset).toLowerCase();
    if (!PRESET_KEYS.includes(pkey)) {
      throw new Error(`filterProfiles: unknown preset '${preset}'`);
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error(`filterProfiles.${pkey}: must be an object`);
    }
    const cleaned = {};
    for (const [field, rawVal] of Object.entries(patch)) {
      if (!(field in PROFILE_FIELD_RANGES)) {
        throw new Error(`filterProfiles.${pkey}: unknown field '${field}'`);
      }
      const { min, max } = PROFILE_FIELD_RANGES[field];
      const num = Number(rawVal);
      if (!Number.isFinite(num)) {
        throw new Error(`filterProfiles.${pkey}.${field}: not a number`);
      }
      if (num < min || num > max) {
        throw new Error(`filterProfiles.${pkey}.${field}: must be ${min}..${max}`);
      }
      // Drop if equal to default — keeps the blob minimal
      const defaultVal = FILTER_PROFILES[pkey][field];
      if (num === defaultVal) continue;
      cleaned[field] = num;
    }
    if (Object.keys(cleaned).length > 0) {
      out[pkey] = cleaned;
    }
  }
  return out;
}
