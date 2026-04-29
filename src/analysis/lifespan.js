/**
 * Lifespan keywords — single source of truth.
 *
 * Stage 1 schema enum + prompt text + i18n labels + dashboard SPA + Telegram
 * all derive from these constants. Adding/renaming a value here triggers
 * loud failures via assertCoversLifespans() at i18n module load — that's
 * the entire point of having this file.
 *
 * Legacy descriptive form ("flash (hours)" etc.) is supported by
 * normalizeLifespan() so DB rows scored before the bare-keyword migration
 * (2026-04-28) keep rendering correctly.
 */

export const LIFESPAN_VALUES = Object.freeze(['flash', 'short', 'medium', 'long']);

// Human-readable hint per keyword. Used by the Stage 1 prompt builder so
// the model knows what each bare keyword means, and by i18n labels.
export const LIFESPAN_DESCRIPTORS = Object.freeze({
  flash:  'hours',
  short:  '1-2 days',
  medium: '3-7 days',
  long:   'weeks+',
});

/**
 * Coerce any input (bare keyword, legacy descriptive form, junk) to a
 * canonical bare keyword, or null if it's not recognisable.
 *
 *   normalizeLifespan('flash')          → 'flash'
 *   normalizeLifespan('flash (hours)')  → 'flash'   (legacy DB rows)
 *   normalizeLifespan('  short  ')      → 'short'
 *   normalizeLifespan('unknown')        → null      (caller decides fallback)
 *   normalizeLifespan(null)             → null
 */
export function normalizeLifespan(v) {
  if (!v || typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (LIFESPAN_VALUES.includes(trimmed)) return trimmed;
  // Legacy descriptive form: "flash (hours)" → "flash"
  const bare = trimmed.split(/\s+\(/)[0];
  return LIFESPAN_VALUES.includes(bare) ? bare : null;
}

/**
 * Assert an object/map has entries for every LIFESPAN_VALUES key.
 * Throws synchronously at module load — used by i18n files so a renamed
 * keyword surfaces as a startup error instead of silent '—' in the UI.
 */
export function assertCoversLifespans(mapName, map) {
  const missing = LIFESPAN_VALUES.filter(k => !(k in map));
  if (missing.length > 0) {
    throw new Error(
      `${mapName} is missing lifespan keys: [${missing.join(', ')}]. ` +
      `Source of truth: src/analysis/lifespan.js → LIFESPAN_VALUES = [${LIFESPAN_VALUES.join(', ')}].`
    );
  }
}
