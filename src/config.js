import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Reddit — direct RSS scraping, no auth needed
  reddit: {
    enabled: process.env.REDDIT_ENABLED !== 'false', // on by default
    subreddits: process.env.REDDIT_SUBREDDITS
      ? process.env.REDDIT_SUBREDDITS.split(',').map(s => s.trim())
      : ['all', 'popular'],
    postsPerSubreddit: 30,
    minUpvotes: 500,
  },

  // Google Trends — RSS feed, no auth needed
  googleTrends: {
    enabled: process.env.GOOGLE_TRENDS_ENABLED !== 'false', // on by default
    geo: process.env.GOOGLE_TRENDS_GEO || '', // empty = worldwide
    category: 'all',
  },

  // Twitter/X — via Apify tweet-scraper (requires APIFY_API key)
  twitter: {
    enabled: process.env.TWITTER_ENABLED === 'true',
    maxItemsPerQuery: parseInt(process.env.TWITTER_MAX_ITEMS || '20', 10),
    queries: process.env.TWITTER_QUERIES
      ? process.env.TWITTER_QUERIES.split('||').map(q => q.trim())
      : undefined,
  },

  // TikTok — via Apify tiktok-scraper (requires APIFY_API key)
  tiktok: {
    enabled: process.env.TIKTOK_ENABLED === 'true',
    maxVideosPerTag: parseInt(process.env.TIKTOK_MAX_VIDEOS || '15', 10),
    hashtags: process.env.TIKTOK_HASHTAGS
      ? process.env.TIKTOK_HASHTAGS.split(',').map(h => h.trim())
      : undefined,
  },

  // xAI Grok — AI scoring engine (OpenAI-compatible API)
  openai: {
    apiKey:   process.env.XAI_API_KEY   || process.env.OPENAI_API_KEY || '',
    model:    process.env.XAI_MODEL     || 'grok-4-1-fast',
    baseUrl:  process.env.XAI_BASE_URL  || 'https://api.x.ai/v1',
  },

  // Apify — on-demand X/Twitter analysis + collectors
  apify: {
    apiKey:  process.env.APIFY_API  || '',
    // Per-actor tokens. The active Twitter actor is a runtime admin setting
    // ('twitterActor' in DB, values: 'kaitoeasyapi' | 'xquik'), and we look
    // up the matching token here when instantiating the collector.
    twitterKeys: {
      kaitoeasyapi: process.env.APIFY_API_KAITO || '',
      xquik:        process.env.APIFY_API_XQUIK || '',
    },
    twitterAuthToken: process.env.TWITTER_AUTH_TOKEN || '',
    twitterCt0:       process.env.TWITTER_CT0        || '',
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    // Bot username (without @) used to build login deep-links.
    // If empty, the dashboard will try to resolve it via bot.getMe() at runtime.
    botUsername: (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
  },

  // Support bot — separate bot for tickets that relays into a forum-topics
  // group. Each user gets their own topic in the admin group; admin replies
  // in a topic are forwarded back to that user. Disabled gracefully if any
  // of the three vars is missing — main bot keeps working.
  support: {
    botToken: process.env.SUPPORT_BOT_TOKEN || '',
    botUsername: (process.env.SUPPORT_BOT_USERNAME || '').replace(/^@/, ''),
    groupId:  process.env.SUPPORT_GROUP_ID || '',
  },

  // Solana Pay
  solanaPay: {
    merchantWallet: process.env.SOLANA_MERCHANT_WALLET || '',
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    // USDC on Solana mainnet
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },

  // Dashboard — web UI & REST API
  dashboard: {
    enabled:  process.env.DASHBOARD_ENABLED !== 'false', // on by default
    port:     parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    apiKey:   process.env.DASHBOARD_API_KEY || '',       // protects the REST API
    host:     process.env.DASHBOARD_HOST    || '0.0.0.0',
  },

  // System settings
  alertThreshold:      parseInt(process.env.ALERT_THRESHOLD       || '60', 10),
  scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '15', 10),
  logLevel:            process.env.LOG_LEVEL || 'info',

  // Database
  dbPath: process.env.DB_PATH || './data/catalyst.db',
};

// ─── Validation ────────────────────────────────────────────────────────────────
const warnings = [];
if (!config.openai.apiKey)        warnings.push('XAI_API_KEY is not set — AI analysis disabled');
if (!config.telegram.botToken)    warnings.push('TELEGRAM_BOT_TOKEN is not set — Telegram alerts disabled');
if (!config.solanaPay.merchantWallet) warnings.push('SOLANA_MERCHANT_WALLET is not set — crypto payments disabled');
if (config.twitter.enabled && !config.apify.apiKey) warnings.push('TWITTER_ENABLED=true but APIFY_API not set');
if (config.tiktok.enabled  && !config.apify.apiKey) warnings.push('TIKTOK_ENABLED=true but APIFY_API not set');
if (config.dashboard.enabled && !config.dashboard.apiKey) warnings.push('DASHBOARD_API_KEY not set — dashboard API will reject requests');
if (!process.env.ADMIN_API_KEY) warnings.push('ADMIN_API_KEY not set — admin API will reject requests');
if (config.support.botToken && !config.support.groupId) warnings.push('SUPPORT_BOT_TOKEN set but SUPPORT_GROUP_ID missing — support bot will not relay tickets');

if (warnings.length > 0) {
  console.warn('\u26a0\ufe0f  Configuration warnings:');
  warnings.forEach(w => console.warn(`   - ${w}`));
}

export default config;
