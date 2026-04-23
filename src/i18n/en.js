/**
 * English translations (default language)
 */
export default {
  // ── Bot welcome & commands ─────────────────────────────────────────────
  welcome: `\u{1F431} <b>Hey! Meet Catalyst</b>

\u{1F916} It scans Twitter, TikTok, Reddit and Google Trends - the moment something starts going viral, you get an alert.

\u{1F3AF} <b>What's in the alert:</b>
\u2022 How hot the trend is (0\u2013100)
\u2022 The catalyst behind the hype
\u2022 What exactly happened
\u2022 A plain-English explanation
\u2022 View/like numbers

Hit "Open Menu" and tune it to your taste \u2699\u{FE0F}

\u{1D54F} <a href="https://x.com/Catalystparser">Follow us on X</a>`,

  welcomeBack: (plan) => `\u{1F44B} <b>Welcome back!</b>\n\nYour plan: <b>${plan}</b>\nUse /menu any time to tweak settings.`,

  // ── Main menu ──────────────────────────────────────────────────────────
  menuTitle: '\u{2699}\u{FE0F} <b>Settings</b>\n\nManage your Catalyst preferences:',
  btnSources: '\u{1F4E1} Sources',
  btnLanguage: '\u{1F310} Language',
  btnThreshold: '\u{1F3AF} Alert Threshold',
  btnSubscription: '\u{1F4B3} Subscription',
  btnTop: '\u{1F525} Top Trends',
  btnStartStop: (paused) => paused ? '\u{25B6}\u{FE0F} Resume Alerts' : '\u{23F8}\u{FE0F} Pause Alerts',
  btnFollowX: '\u{1D54F} Follow @Catalystparser',
  btnAskQuestion: '\u{1F4AC} Ask a question',
  btnOpenMenu: '\u2699\uFE0F Open Menu',
  btnBack: '\u{25C0}\u{FE0F} Back',
  btnClose: '\u{274C} Close',

  // ── Sources ────────────────────────────────────────────────────────────
  sourcesTitle: '\u{1F4E1} <b>Data Sources</b>\n\nToggle which platforms to monitor.\n\u{2705} = enabled, \u{274C} = disabled',
  sourceToggled: (name, enabled) => `${enabled ? '\u{2705}' : '\u{274C}'} <b>${name}</b> is now ${enabled ? 'enabled' : 'disabled'}`,
  sourceNames: {
    reddit: 'Reddit',
    google_trends: 'Google Trends',
    twitter: 'Twitter/X',
    tiktok: 'TikTok',
  },

  // ── Language ───────────────────────────────────────────────────────────
  languageTitle: '\u{1F310} <b>Language</b>\n\nChoose your preferred language for alerts and interface:',
  languageSet: (lang) => `\u{2705} Language set to <b>${lang === 'en' ? 'English' : '\u{420}\u{443}\u{441}\u{441}\u{43A}\u{438}\u{439}'}</b>`,

  // ── Threshold ──────────────────────────────────────────────────────────
  thresholdTitle: (current) => `\u{1F3AF} <b>Alert Threshold</b>\n\nCurrent: <b>${current}/100</b>\n\nOnly trends with meme potential above this value will trigger alerts.\n\u2B50 Recommended: <b>75+</b>\n\nChoose a preset:`,
  thresholdSet: (val) => `\u{2705} Alert threshold set to <b>${val}/100</b>`,
  thresholdLow: '\u{1F7E2} Low (52+) \u2014 More alerts',
  thresholdMedium: '\u{1F7E1} Medium (67+) \u2014 Balanced',
  thresholdHigh: '\u{1F534} High (75+) \u2014 Only bangers',
  thresholdCustomBtn: '\u270F\uFE0F Custom number',
  thresholdCustomPrompt: '\u270F\uFE0F <b>Custom threshold</b>\n\nEnter a whole number from 1 to 100:',
  thresholdCustomInvalid: '\u274C Invalid value. Please enter a whole number from 1 to 100.',

  // ── Subscription ───────────────────────────────────────────────────────
  subscriptionTitle: (plan, status, expires) => {
    let msg = `\u{1F4B3} <b>Subscription</b>\n\nPlan: <b>${plan}</b>\nStatus: <b>${status}</b>`;
    if (expires) msg += `\nExpires: <b>${expires}</b>`;
    return msg;
  },
  btnUpgrade: '\u{2B06}\u{FE0F} Upgrade',
  btnManageSub: '\u{1F527} Manage',
  planFree: 'Free',
  planTest: 'Test Plan ($5 / 1 day, one-time)',
  planPro: 'Pro ($100 / 30 days)',

  // ── Payment ────────────────────────────────────────────────────────────
  paymentTitle: '\u{1F4B0} <b>Choose a plan:</b>\n\n🆓 <b>Free — free forever (current)</b>\n• Sources: Reddit, Google Trends\n• Unlimited alerts\n• Twitter, TikTok and X Analysis not available\n\n🧪 <b>Test — $5 / 1 day (one-time)</b>\n• All sources (Reddit, Google, Twitter, TikTok)\n• Unlimited alerts\n• X Analysis is not available\n\n🚀 <b>Pro — $100 / 30 days</b>\n• All sources (Reddit, Google, Twitter, TikTok)\n• Unlimited alerts\n• X Analysis included',
  paymentMethod: '\u{1F4B0} <b>Payment</b>\n\nChoose payment method:',
  btnPaySOL: '\u{25C9} Pay with SOL',
  btnPayUSDC: '\u{25C9} Pay with USDC',
  btnPayStars: (amount) => '\u2B50 Telegram Stars (' + amount + ' \u2B50)',
  starsInvoiceTitle: (plan) => 'Catalyst \u2014 ' + plan,
  starsInvoiceDesc: (plan) => 'Access to Catalyst ' + plan + '. Payment is confirmed instantly.',
  paymentInstructions: (amount, currency, address, reference) =>
    `\u{1F4B0} <b>Payment Instructions</b>\n\n` +
    `<b>Option 1 (Recommended):</b>\nScan the QR code below using your wallet (Phantom / Solflare). Amount and details will be filled automatically.\n\n` +
    `<b>Option 2 (Manual):</b>\nSend exactly <code>${amount} ${currency}</code> to this address:\n<code>${address}</code>\n\n` +
    `Payment will be confirmed automatically within 1-5 minutes.`,
  btnOpenWallet: '\u{1F4F1} Open in Wallet',
  paymentConfirmed: (plan) => `\u{2705} <b>Payment confirmed!</b>\n\nYour plan has been upgraded to <b>${plan}</b>.\nEnjoy your premium features!`,
  paymentExpired: '\u{274C} Payment session expired. Please try again.',
  paymentPending: '\u{23F3} Waiting for payment confirmation...',

  // ── Alerts ─────────────────────────────────────────────────────────────
  alertHeader: (score) => `${scoreEmoji(score)} <b>${score}/100</b> \u00B7 TREND ALERT`,
  alertTrigger: 'Trigger',
  alertAI: 'AI',
  alertCategory: 'Category',
  alertViralityScore: 'Virality',
  alertSentiment: 'Sentiment',
  alertForecast: 'Forecast',
  alertSources: 'Sources',
  alertUpvotes:    (count, velocity) => `\u{1F4C8} <b>${count}</b> upvotes (\u2191${velocity}/hr)`,
  alertLikes:      (count, velocity) => `\u{2764}\u{FE0F} <b>${count}</b> likes (\u2191${velocity}/hr)`,
  alertPlays:      (count, velocity) => `\u{25B6}\u{FE0F} <b>${count}</b> plays (\u2191${velocity}/hr)`,
  alertGoogleHits: (count)           => `\u{1F4CA} Search interest: <b>${count}</b>`,
  alertComments: (count) => `\u{1F4AC} <b>${count}</b> comments`,
  alertGoogleTraffic: (traffic) => `\u{1F4CA} Google traffic: <b>${traffic}</b>`,
  alertTwitterHeader: (hours) => `\u{1F426} <b>Twitter \u00B7 ${hours}h</b>`,
  alertOpen: 'Open link',

  // ── Top command ────────────────────────────────────────────────────────
  topSelectorTitle: '\u{1F525} <b>Top Narratives</b>\n\nHow many trends to show?',
  topBtnCount: (n) => '\u{1F4CA} TOP-' + n,
  topTitle: (n) => '\u{1F525} <b>TOP-' + n + ' NARRATIVES \u00B7 24H</b>',
  topEmpty: '\u{1F937} No degen trends in the last 24 hours.',
  topSource: 'Open',
  topTgPost: 'TG',
  topCatIcons: {
    meme: '\u{1F923}', elon: '\u{1F680}', animals: '\u{1F43E}',
    tech_drama: '\u{1F4BB}', degenerates: '\u{1F3B0}', celebrity: '\u{2B50}',
    sports_degen: '\u{1F3C6}', ai_drama: '\u{1F916}', other: '\u{1F4CC}', boring: '\u{1F634}',
  },
  topLifeIcons: {
    'flash (hours)': '\u26A1', 'short (1-2 days)': '\u{1F552}',
    'medium (3-7 days)': '\u{1F4C5}', 'long (weeks+)': '\u{1F4C6}',
  },

  // ── Status ─────────────────────────────────────────────────────────────
  paused: '\u{23F8}\u{FE0F} <b>Alerts paused.</b>\nUse /menu to resume.',
  resumed: '\u{25B6}\u{FE0F} <b>Alerts resumed!</b>\nYou will receive trend notifications.',

  // ── X Analysis ─────────────────────────────────────────────────────────
  xAnalysisBtn: '\u{1F426} X Analysis',
  btnAskGrok:   '\u{1F9E0} Ask Grok',
  xAnalysisLockedBtn: '\u{1F512} X Analysis (Locked)',
  xAnalysisLocked: '\u{1F512} X Analysis is not available on Test plan. Upgrade to Pro.',
  xAnalysisLoading: '\u{23F3} Loading...',
  xAnalysisTitle: '\u{1F426} <b>X / Twitter Analysis</b>',
  xAnalysisQuery: 'Query',
  xAnalysisVirality: 'Virality',
  xAnalysisTweets: 'Tweets found',
  xAnalysisViews: 'Views',
  xAnalysisLikes: 'Likes',
  xAnalysisRetweets: 'Retweets',
  xAnalysisReplies: 'Replies',
  xAnalysisAuthors: 'Who writes',
  xAnalysisNone: (query) => `\u{1F426} <b>X / Twitter:</b> no tweets found for <code>${query}</code>`,
  xAnalysisError: (err) => `\u{274C} X Analysis error: ${err}`,
  xAnalysisNoKeywords: 'Not enough keywords for X search',

  // ── Errors ─────────────────────────────────────────────────────────────
  dbUnavailable: '\u{274C} Database unavailable',
  trendNotFound: '\u{274C} Trend not found.',
  errorGeneric: (err) => `\u{274C} Error: ${err}`,

  // ── Categories ─────────────────────────────────────────────────────────
  categories: {
    meme: '\u{1F602} Meme',
    elon: '\u{1F680} Elon',
    animals: '\u{1F43E} Animals',
    tech_drama: '\u{1F4BB} Tech/Crypto Drama',
    degenerates: '\u{1F3B0} Degens',
    boring: '\u{1F634} Boring',
    news: '\u{1F4F0} News',
    politics: '\u{1F3DB}\u{FE0F} Politics',
    celebrity: '\u{2B50} Celebrity',
    sports_degen: '\u{1F3C6} Sports',
    ai_drama: '\u{1F916} AI Drama',
    other: '\u{1F4CC} Other',
  },

  sentiments: {
    positive: '\u{1F60A} Positive',
    negative: '\u{1F620} Negative',
    neutral: '\u{1F610} Neutral',
    mixed: '\u{1F914} Mixed',
  },

  lifespans: {
    'flash (hours)': '\u{26A1} Flash (hours)',
    'short (1-2 days)': '\u{1F550} Short (1-2 days)',
    'medium (3-7 days)': '\u{1F4C5} Medium (3-7 days)',
    'long (weeks+)': '\u{1F4C6} Long (weeks+)',
    'unknown': '\u{2753} Unknown',
  },
};

function scoreEmoji(score) {
  if (score >= 90) return '\u{1F525}\u{1F525}\u{1F525}';
  if (score >= 75) return '\u{1F525}\u{1F525}';
  if (score >= 60) return '\u{1F525}';
  return '\u{1F4CA}';
}
