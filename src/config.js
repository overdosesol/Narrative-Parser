import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Reddit - direct RSS scraping, no auth needed
  reddit: {
    enabled: process.env.REDDIT_ENABLED !== 'false', // on by default
    subreddits: process.env.REDDIT_SUBREDDITS
      ? process.env.REDDIT_SUBREDDITS.split(',').map(s => s.trim())
      : ['all', 'popular'],
    postsPerSubreddit: 30,
    minUpvotes: 500,
  },

  // Google Trends - RSS feed, no auth needed
  googleTrends: {
    enabled: process.env.GOOGLE_TRENDS_ENABLED !== 'false', // on by default
    geo: process.env.GOOGLE_TRENDS_GEO || '', // empty = worldwide
    category: 'all',
  },

  // Twitter/X - via Apify tweet-scraper (requires APIFY_API key)
  twitter: {
    enabled: process.env.TWITTER_ENABLED === 'true',
    maxItemsPerQuery: parseInt(process.env.TWITTER_MAX_ITEMS || '20', 10),
    queries: process.env.TWITTER_QUERIES
      ? process.env.TWITTER_QUERIES.split('||').map(q => q.trim())
      : undefined,
  },

  // TikTok - via Apify tiktok-scraper (requires APIFY_API key)
  tiktok: {
    enabled: process.env.TIKTOK_ENABLED === 'true',
    maxVideosPerTag: parseInt(process.env.TIKTOK_MAX_VIDEOS || '15', 10),
    hashtags: process.env.TIKTOK_HASHTAGS
      ? process.env.TIKTOK_HASHTAGS.split(',').map(h => h.trim())
      : undefined,
  },

  // xAI Grok - AI scoring engine (OpenAI-compatible API)
  openai: {
    apiKey:   process.env.XAI_API_KEY   || process.env.OPENAI_API_KEY || '',
    model:    process.env.XAI_MODEL     || 'grok-4-1-fast',
    baseUrl:  process.env.XAI_BASE_URL  || 'https://api.x.ai/v1',
  },

  // Apify - on-demand X/Twitter analysis + collectors
  apify: {
    apiKey:  process.env.APIFY_API  || '',
    // Per-actor tokens. The active Twitter actor is a runtime admin setting
    // ('twitterActor' in DB, values: 'kaitoeasyapi' | 'xquik'), and we look
    // up the matching token here when instantiating the collector.
    twitterKeys: {
      kaitoeasyapi: process.env.APIFY_API_KAITO || '',
      xquik:        process.env.APIFY_API_XQUIK || '',
    },
    // Same pattern for TikTok: per-actor tokens, runtime-switched via
    // 'tiktokActor' DB setting (values: 'clockworks' | 'apidojo').
    // Default actor (clockworks) reuses the generic APIFY_API for back-compat
    // with single-key deployments — no .env change required to keep working.
    tiktokKeys: {
      clockworks: process.env.APIFY_API_CLOCKWORKS || process.env.APIFY_API || '',
      apidojo:    process.env.APIFY_API_APIDOJO    || '',
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

  // Support bot - separate bot for tickets that relays into a forum-topics
  // group. Each user gets their own topic in the admin group; admin replies
  // in a topic are forwarded back to that user. Disabled gracefully if any
  // of the three vars is missing - main bot keeps working.
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

  // Dashboard - web UI & REST API
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

  // Production deployment hints
  //   nodeEnv:       'development' (default) | 'production' - flips behaviour
  //                  on env validation (warn vs hard-fail).
  //   publicBaseUrl: canonical origin of the dashboard (e.g. https://catalyst.io).
  //                  Used to build absolute links in user-facing places (OG
  //                  tags, share URLs). Empty in dev = relative links.
  //   trustProxy:    true when behind nginx/Cloudflare/Caddy. Currently we
  //                  don't read X-Forwarded-* anywhere, but when we do (IP-
  //                  based rate limit, real-IP audit log), this flag gates it.
  nodeEnv:       process.env.NODE_ENV       || 'development',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  trustProxy:    process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
};

// --- Validation -----------------------------------------------------------
// In development we just warn so a fresh-clone contributor can `npm start`
// without filling in every secret. In production we HARD-FAIL on missing
// critical secrets - silently running with a half-configured ADMIN_API_KEY
// or no AI key would mean a publicly reachable but broken service.
const isProduction = config.nodeEnv === 'production';
const warnings = [];
const errors   = [];

const flag = (cond, msg, level = 'warn') => {
  if (!cond) return;
  (level === 'error' ? errors : warnings).push(msg);
};

// Critical (hard-fail in production, warn in dev)
flag(!config.openai.apiKey,           'XAI_API_KEY is not set - AI analysis disabled', isProduction ? 'error' : 'warn');
flag(!config.telegram.botToken,       'TELEGRAM_BOT_TOKEN is not set - Telegram alerts disabled', isProduction ? 'error' : 'warn');
flag(!process.env.ADMIN_API_KEY,      'ADMIN_API_KEY not set - admin API would accept all requests', isProduction ? 'error' : 'warn');
flag(isProduction && !config.publicBaseUrl, 'PUBLIC_BASE_URL not set in production - share links will be relative-only', 'warn');

// Soft (warn only)
flag(!config.solanaPay.merchantWallet, 'SOLANA_MERCHANT_WALLET is not set - crypto payments disabled');
flag(config.twitter.enabled && !config.apify.apiKey, 'TWITTER_ENABLED=true but APIFY_API not set');
flag(config.tiktok.enabled && !Object.values(config.apify.tiktokKeys).some(Boolean),
     'TIKTOK_ENABLED=true but no TikTok actor key (APIFY_API / APIFY_API_APIDOJO) set');
flag(config.dashboard.enabled && !config.dashboard.apiKey, 'DASHBOARD_API_KEY not set - legacy header check will fail');
flag(config.support.botToken && !config.support.groupId, 'SUPPORT_BOT_TOKEN set but SUPPORT_GROUP_ID missing - support bot disabled');

if (warnings.length > 0) {
  console.warn('⚠️  Configuration warnings:');
  warnings.forEach(w => console.warn(`   - ${w}`));
}
if (errors.length > 0) {
  console.error('❌  Configuration errors (NODE_ENV=production):');
  errors.forEach(e => console.error(`   - ${e}`));
  console.error('\nRefusing to start with missing critical config. Set the env vars above or unset NODE_ENV for dev mode.');
  process.exit(1);
}

export default config;
