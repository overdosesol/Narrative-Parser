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
 * Penalty sources (stack additively, then capped at 100):
 *  +40  Politics / government / war
 *  +30  K-pop / fandom / stan culture
 *  +20  Routine celebrity noise (events, interviews, relationships)
 *  +15  No meme-shape detected (no animal / absurdity / visual meme / hook)
 *
 * Safe-signal override:
 *  If the cluster contains strong meme-shape signals (animal, absurdity,
 *  visual meme, short punchy hook), ALL penalties are divided by 3.
 *  This prevents false positives like "weird animal at government event"
 *  or "K-pop idol does cursed thing".
 */

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
 * @returns {{ junkPenalty: number, junkReasons: string[] }}
 *   junkPenalty  0–100 (0 = clean, 100 = pure junk)
 *   junkReasons  list of triggered rules (for logging/debugging)
 */
export function calculateJunkPenalty(items, clusterMetrics = {}) {
  // Collect all text from the cluster
  const texts = items.map(i =>
    [i.title || '', i.description || ''].join(' ')
  ).join(' ');

  const reasons = [];
  let raw = 0;

  // ── Penalty: Politics ──────────────────────────────────────────────
  if (RE_POLITICS.test(texts)) {
    raw += 40;
    reasons.push('politics');
  }

  // ── Penalty: K-pop / fandom ────────────────────────────────────────
  if (RE_KPOP.test(texts)) {
    raw += 30;
    reasons.push('kpop/fandom');
  }

  // ── Penalty: Routine celebrity noise ──────────────────────────────
  if (RE_CELEB_NOISE.test(texts)) {
    raw += 20;
    reasons.push('celeb-noise');
  }

  // ── Penalty: No meme-shape detected ───────────────────────────────
  const hasAnimal      = RE_ANIMAL.test(texts);
  const hasAbsurd      = RE_ABSURD.test(texts);
  const hasMeme        = RE_MEME.test(texts);
  const hasHeartwarming = RE_HEARTWARMING.test(texts);

  const hasMemeShape = hasAnimal || hasAbsurd || hasMeme || hasHeartwarming;

  if (!hasMemeShape) {
    raw += 15;
    reasons.push('no-meme-shape');
  }

  if (raw === 0) return { junkPenalty: 0, junkReasons: [] };

  // ── Safe-signal override ───────────────────────────────────────────
  // Strong meme signals heavily offset the junk penalty.
  // E.g. "weird goat at government event" → politics penalty but animal overrides.
  if (hasAnimal || hasAbsurd || hasMeme || hasHeartwarming) {
    // Count how many safe signals fired
    const safeCount = [hasAnimal, hasAbsurd, hasMeme, hasHeartwarming].filter(Boolean).length;
    const divisor   = safeCount >= 2 ? 4 : 3;
    raw = Math.round(raw / divisor);
    reasons.push(`safe-override(÷${divisor})`);
  }

  return {
    junkPenalty: Math.min(raw, 100),
    junkReasons: reasons,
  };
}
