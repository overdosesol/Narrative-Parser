/**
 * subject-names.js — Aggregate "who is the subject of this trend?" across
 * Stage 0 (Gemini visual+audio), Stage 0a (nano text NER) and Stage 2 (Grok
 * deep-dive). Used by:
 *
 *   • Telegram formatter — highlight names inside title / whyNow /
 *     aiExplanation. Title is already wrapped in <b>, so we use <u> there;
 *     plain-text sections use <b>.
 *   • Dashboard SPA — highlight names with a CSS class for visual accent.
 *   • Admin DecisionsPage — show extracted names as chips next to the
 *     other Gemini scoring signals.
 *
 * Why it lives in `src/analysis/` (not `notifications/`): the same regex /
 * dedup logic is reused for non-Telegram surfaces (SPA / admin), and we
 * cannot import from `notifications/` into `dashboard/server.js` cleanly.
 *
 * Output shape of `collectSubjectNames(trend)`:
 *   {
 *     primary: 'Moo Deng' | null,    // first, most-confident display name
 *     all:     ['Moo Deng', 'Mr. Beast'],  // dedup'd display forms
 *     ticker:  'MOODENG' | null,     // gemini.tickerSuggestion if present
 *     aliases: ['Moo Deng', 'moo deng', 'moodeng', 'moo-deng', ...],
 *               // generated lowercase / no-space / hyphen variants for
 *               // case-insensitive regex matching against post text.
 *   }
 *
 * If no subject is found, all arrays are empty and primary/ticker are null.
 */

// Mirrors the SUBJECT_NAME_BLACKLIST inside gemini-captioner.js. Duplicated
// here so that names coming from xSearch / nano are filtered the same way
// even though Gemini wasn't the source. Keep both lists in sync — they're
// short and rarely change.
const SUBJECT_BLACKLIST = new Set([
  'tiktok', 'youtube', 'twitter', 'x', 'reddit', 'instagram', 'facebook',
  'meta', 'twitch', 'discord', 'telegram', 'whatsapp', 'snapchat', 'threads',
  'apple', 'google', 'microsoft', 'amazon', 'samsung', 'sony', 'intel',
  'usa', 'us', 'uk', 'eu', 'china', 'russia', 'india', 'japan', 'korea',
  'america', 'europe', 'asia', 'africa',
  'iphone', 'ipad', 'android', 'windows', 'macos', 'ios',
]);

/**
 * Collect subject names from all available sources on a trend, dedup, filter
 * blacklist, and return canonical structure for downstream highlight code.
 *
 * Source priority (higher overrides lower for primary):
 *   1. gemini.subjectNames[0]      — visual+audio truth (most accurate)
 *   2. xSearch.subjectName         — Grok deep-dive (only on Stage 2 trends)
 *   3. nano.entityCanonical[0..]   — text-NER fallback (filter to capitalized)
 *
 * Aliases: generated programmatically from each display name to catch
 * case-insensitive / no-space / hyphenated variants in post text.
 */
export function collectSubjectNames(trend) {
  if (!trend) return { primary: null, all: [], ticker: null, aliases: [] };

  const collected = []; // [{name, src}]
  const seen = new Set();

  const push = (raw, src) => {
    const s = String(raw || '').trim().slice(0, 32);
    if (!s) return;
    if (s.length < 2) return;
    if (/^\d+$/.test(s)) return;
    const key = s.toLowerCase();
    if (SUBJECT_BLACKLIST.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push({ name: s, src });
  };

  // 1) Gemini subject names
  const gNames = trend.preStage?.gemini?.subjectNames;
  if (Array.isArray(gNames)) {
    for (const n of gNames) push(n, 'gemini');
  }

  // 2) Stage 2 Grok subjectName (single value with strength score)
  const x = trend.xSearchData;
  if (x?.subjectName) {
    // Only trust Grok's name when nameStrength is decent. <30 = guess noise.
    const strength = Number(x.nameStrength) || 0;
    if (strength >= 30) push(x.subjectName, 'xsearch');
  }

  // 3) Nano entityCanonical — text NER fallback. Filter to capitalized
  //    proper-noun-shaped tokens (start uppercase, length 3-32). Skips
  //    common-word entities ("president", "election") that nano sometimes
  //    surfaces. Cap to first 3 to avoid spamming the alert.
  const nanoEnt = trend.preStage?.nano?.entityCanonical;
  if (Array.isArray(nanoEnt)) {
    let count = 0;
    for (const e of nanoEnt) {
      if (count >= 3) break;
      const s = String(e || '').trim();
      if (!s) continue;
      // Must start with uppercase letter — primitive proper-noun detector.
      if (!/^[A-ZА-Я]/.test(s)) continue;
      push(s, 'nano');
      count++;
    }
  }

  if (collected.length === 0) {
    return { primary: null, all: [], ticker: null, aliases: [] };
  }

  // Cap total to 5 names — beyond that it's noise in the highlight.
  const capped = collected.slice(0, 5);
  const all = capped.map(c => c.name);
  const primary = all[0];

  // Build alias list for regex matching. Each display name yields:
  //   "Moo Deng"    (display form)
  //   "moo deng"    (lowercase, with spaces)
  //   "MooDeng"     (camel, no spaces)
  //   "moodeng"     (lowercase, no spaces)
  //   "moo-deng"    (lowercase, hyphenated)
  // Single-word names just have display + lowercase variants.
  const aliasSet = new Set();
  for (const name of all) {
    aliasSet.add(name);
    const lower = name.toLowerCase();
    aliasSet.add(lower);
    if (/\s/.test(name)) {
      const noSpace = name.replace(/\s+/g, '');
      const noSpaceLower = lower.replace(/\s+/g, '');
      const hyphen = lower.replace(/\s+/g, '-');
      aliasSet.add(noSpace);
      aliasSet.add(noSpaceLower);
      aliasSet.add(hyphen);
    }
  }
  // Sort by length DESC so longer aliases match first (avoids "Moo Deng"
  // being eaten by "Moo" if both were ever in the set).
  const aliases = Array.from(aliasSet).sort((a, b) => b.length - a.length);

  // Ticker from Gemini (if any) — kept separate from name aliases since
  // it's already an all-caps form intended for the "$TICKER" usage.
  const ticker = String(trend.preStage?.gemini?.tickerSuggestion || '').trim().slice(0, 16) || null;

  return { primary, all, ticker, aliases };
}

/**
 * Build a single case-insensitive regex that matches any alias in `aliases`,
 * with word boundaries. Used by formatter.js (Telegram) and dashboard SPA
 * helper to find highlight positions in post text.
 *
 * Returns null when aliases is empty (so the caller can skip processing).
 */
export function buildSubjectMatchRegex(aliases) {
  if (!Array.isArray(aliases) || aliases.length === 0) return null;
  // Escape regex metacharacters in each alias.
  const parts = aliases
    .filter(a => typeof a === 'string' && a.length >= 2)
    .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (parts.length === 0) return null;
  // Word boundary on both sides — catches "Moo Deng," and "Moo Deng!" while
  // skipping "MooDengCorp" (which wouldn't have a boundary at the end).
  // Aliases were already sorted longest-first by collectSubjectNames so the
  // alternation tries the most-specific match first.
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'gi');
}
