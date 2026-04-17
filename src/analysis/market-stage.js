/**
 * Market Stage Detection — isolated, optional layer
 *
 * Detects signs of tokenization around a narrative cluster WITHOUT
 * guessing a specific ticker. Scans raw text signals (coin-language,
 * launch intent, trading links, contract addresses) from cluster items.
 *
 * Four states:
 *   none        — no token activity signals
 *   tokenizing  — launch discussions, coin-language, pump.fun mentioned
 *   live        — CA address or DEX trading link found
 *   overheated  — live market + late/rug language
 *
 * FEATURE FLAG: enabled only when MARKET_STAGE_DETECTION=1 env var is set.
 * To disable entirely: unset the env var. To remove: delete this file and
 * the ~5 call sites tagged with [MARKET_STAGE].
 *
 * No external dependencies. No LLM calls. No onchain queries.
 */

// ── Signal word lists ─────────────────────────────────────────────────────────

// Type A — coin-language markers (soft signal, scored)
const COIN_WORDS = [
  'token', 'coin', 'memecoin', 'meme coin', 'solana', ' sol ',
  'launch', 'deploy', 'deploying', 'ape ', 'aping', 'degen',
  'moonshot', 'pump', '100x', ' moon ', 'mint ', ' lp ',
  'liquidity', 'fdv', 'market cap', 'mcap', 'fair launch', 'presale',
  'raydium', 'jupiter', ' jup ', 'bonk', 'wen token',
];

// Type B — launch intent phrases (strong soft signal)
const INTENT_PHRASES = [
  'pump.fun',            // platform without CA = intent, not live
  'moonshot.money',      // platform without CA = intent
  'someone launch',
  'who\'s launching',
  'who is launching',
  'need a coin',
  'make a coin',
  'launch the coin',
  'someone deploy',
  'going to deploy',
  'deploying soon',
  'will deploy',
  'wen launch',
  'wen coin',
];

// Type C — trading domain links (live market signal)
const TRADING_DOMAINS = [
  'dexscreener.com',
  'birdeye.so',
  'raydium.io/swap',
  'jup.ag/swap',
  'moonshot.money/token/',
  'defined.fi',
  'dextools.io',
  'ave.ai',
  'geckoterminal.com',
];

// Type D — overheated / late language (modifier on top of live)
const LATE_PHRASES = [
  'already rugged',
  'rug pull',
  ' rugged',
  'too late',
  'already pumped',
  'already 100x',
  'already mooned',
  'honeypot',
  'dead coin',
  'mcap too high',
  'mc too high',
  'sniper',
  'sniped at launch',
  'insiders bought',
];

// pump.fun URL with a Solana base58 address appended (live signal)
const RE_PUMP_FUN_WITH_CA = /pump\.fun\/[1-9A-HJ-NP-Za-km-z]{32,44}/;

// Contract address with explicit context anchor
// Avoids false positives from long random strings
const RE_CA_WITH_CONTEXT  = /(?:ca:|contract:|address:|mint:|token:)\s*[1-9A-HJ-NP-Za-km-z]{32,44}/i;

// ── Core detection ────────────────────────────────────────────────────────────

/**
 * Scan all items in a cluster and return raw signal flags.
 * @param {Array} items — raw items from aggregator (title, description, url)
 * @returns {object} signals
 */
export function detectMarketSignals(items) {
  const signals = {
    hasCoinLanguage:   false,
    hasLaunchIntent:   false,
    hasCA:             false,
    hasTradingLink:    false,
    hasPumpFunLink:    false,
    hasOverboughtLang: false,
    coinLangScore:     0,
  };

  for (const item of items) {
    // Combine all text fields; keep original for regex (CA is case-sensitive)
    const raw  = [item.title, item.description, item.url].filter(Boolean).join(' ');
    const text = raw.toLowerCase();

    // A — coin-language score
    const hits = COIN_WORDS.filter(w => text.includes(w)).length;
    signals.coinLangScore += hits;
    if (signals.coinLangScore >= 4) signals.hasCoinLanguage = true;

    // B — launch intent
    if (!signals.hasLaunchIntent && INTENT_PHRASES.some(p => text.includes(p))) {
      signals.hasLaunchIntent = true;
    }

    // C — pump.fun with full CA in URL or text (strongest live signal)
    if (!signals.hasPumpFunLink && RE_PUMP_FUN_WITH_CA.test(raw)) {
      signals.hasPumpFunLink = true;
      signals.hasCA          = true;
    }

    // C — other trading domain links
    if (!signals.hasTradingLink && TRADING_DOMAINS.some(d => text.includes(d))) {
      signals.hasTradingLink = true;
    }

    // C — contract address with explicit context anchor
    if (!signals.hasCA && RE_CA_WITH_CONTEXT.test(raw)) {
      signals.hasCA = true;
    }

    // D — overheated / late language
    if (!signals.hasOverboughtLang && LATE_PHRASES.some(p => text.includes(p))) {
      signals.hasOverboughtLang = true;
    }
  }

  return signals;
}

/**
 * Resolve a single market stage string from raw signals.
 * @param {object} signals — output of detectMarketSignals()
 * @returns {'none'|'tokenizing'|'live'|'overheated'}
 */
export function resolveMarketStage(signals) {
  const hasLive = signals.hasCA || signals.hasTradingLink || signals.hasPumpFunLink;

  if (hasLive && signals.hasOverboughtLang) return 'overheated';
  if (hasLive)                              return 'live';
  if (signals.hasLaunchIntent)             return 'tokenizing';
  // Require a denser cluster of coin words without explicit intent phrase
  if (signals.hasCoinLanguage && signals.coinLangScore >= 6) return 'tokenizing';
  return 'none';
}

// ── Stage 2 patch (called from scorer after x_search) ────────────────────────

/**
 * Optionally upgrade/downgrade a trend's marketStage based on Stage 2 findings.
 * Mutates trend.marketStage in-place; safe to call only when feature is enabled.
 * @param {object} trend
 * @param {object} stage2Result — parsed JSON from Stage 2 AI response
 */
export function applyStage2MarketPatch(trend, stage2Result) {
  if (!trend || !stage2Result) return;

  const adj = (stage2Result.adjustment || '').toLowerCase();

  // Upgrade to live if Stage 2 found existing coins with active buzz
  if (
    Array.isArray(stage2Result.existingCoins) &&
    stage2Result.existingCoins.length > 0 &&
    ['high', 'explosive'].includes(stage2Result.xBuzz)
  ) {
    if (trend.marketStage === 'none' || trend.marketStage === 'tokenizing') {
      trend.marketStage = 'live';
    }
  }

  // Downgrade to overheated if rug / late language in adjustment text
  if (['rugged', 'rug pull', 'dumped', 'honeypot', 'too late'].some(w => adj.includes(w))) {
    if (trend.marketStage === 'live') {
      trend.marketStage = 'overheated';
    }
  }
}

// ── UI / alert helpers ────────────────────────────────────────────────────────

/**
 * Human-readable label for use in Telegram alerts and logs.
 * Returns null for 'none' (no line added to alert).
 */
export function marketStageAlertLine(stage) {
  switch (stage) {
    case 'tokenizing': return '🔄 Токенизируется — launch discussions detected';
    case 'live':       return '🟢 Живой рынок — contract / DEX links found';
    case 'overheated': return '🔴 Перегрет — possible rug / late entry signals';
    default:           return null;
  }
}

/**
 * One-line context string appended to Stage 1 AI prompt.
 * Returns null for 'none'.
 */
export function marketStagePromptHint(stage) {
  switch (stage) {
    case 'tokenizing': return '⚠️ Market signal: TOKENIZING — launch discussions and/or pump.fun mentioned';
    case 'live':       return '🟢 Market signal: LIVE MARKET — contract address or DEX links found in sources';
    case 'overheated': return '🔴 Market signal: OVERHEATED — trading active but late/rug language detected';
    default:           return null;
  }
}
