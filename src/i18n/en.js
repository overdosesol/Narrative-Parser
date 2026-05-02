/**
 * English translations (default language)
 */
import { LIFESPAN_VALUES, assertCoversLifespans } from '../analysis/lifespan.js';

const en = {
  // ── Bot welcome & commands ─────────────────────────────────────────────
  welcome: `<b>Catalyst</b>

Narrative scanner for <b>Twitter</b>, <b>TikTok</b>, <b>Reddit</b> and <b>Google Trends</b>. Pings when a story starts breaking out.

<b>Each alert includes:</b>
\u{1F3AF}  Score \u00b7 0\u2013100
\u{26A1}  The trigger
\u{1F4D6}  What's happening
\u{1F9E0}  Plain-language breakdown
\u{1F4CA}  Live engagement (views, likes, reposts)

Open the menu below to set sources, threshold, language and plan.

<a href="https://x.com/Catalystparser">\u{1D54F} Follow</a>`,

  welcomeBack: (plan) => `<b>Catalyst</b> \u00b7 plan: <b>${plan}</b>\n\n/menu \u2014 settings\n/top \u2014 top narratives right now`,

  // ── Main menu ──────────────────────────────────────────────────────────
  menuTitle: '\u{2699}\u{FE0F} <b>Settings</b>\n\nTap a tile to tweak it. Current values are shown next to each option.',
  btnSources: '\u{1F4E1} Sources',
  btnLanguage: '\u{1F310} Language',
  btnThreshold: '\u{1F3AF} Threshold',
  btnSubscription: '\u{1F4B3} Subscription',
  btnAlertTypes: '\u{1F514} Alert Types',
  btnTop: '\u{1F525} Top Trends',
  btnStartStop: (paused) => paused ? '\u{25B6}\u{FE0F} Resume Alerts' : '\u{23F8}\u{FE0F} Pause Alerts',
  btnFollowX: '\u{1D54F} Follow @Catalystparser',
  btnAskQuestion: '\u{1F4AC} Ask a question',
  btnOpenMenu: '\u2699\uFE0F Open Menu',
  btnBack: '\u{25C0}\u{FE0F} Back',
  btnClose: '\u{274C} Close',
  // Badge formatters used by the main menu to show each option's current
  // state inline on the button itself (e.g. "\uD83D\uDCE1 Sources \u00B7 4/5").
  badgeSources:    (enabled, total) => ` \u00B7 ${enabled}/${total}`,
  badgeThreshold:  (val)            => ` \u00B7 ${val}`,
  badgeLanguage:   (code)           => ` \u00B7 ${code.toUpperCase()}`,
  badgeAlertTypes: (count, total)   => (count === 0 || count === total) ? ' \u00B7 all' : ` \u00B7 ${count}/${total}`,

  // ── Sources ────────────────────────────────────────────────────────────
  sourcesTitle: '\u{1F4E1} <b>Data Sources</b>\n\nTap a platform to turn its alerts on or off.',
  sourceToggled: (name, enabled) => `${enabled ? '\u{2705}' : '\u{274C}'} <b>${name}</b> is now ${enabled ? 'enabled' : 'disabled'}`,
  sourceNames: {
    reddit: 'Reddit',
    google_trends: 'Google Trends',
    twitter: 'Twitter/X',
    tiktok: 'TikTok',
    x_trends: 'X Trends',
  },

  // ── Alert types ────────────────────────────────────────────────────────
  alertTypesTitle: '\u{1F514} <b>Alert Types</b>\n\nChoose what kinds of alerts to receive:\n\n\u{1F4F0} <b>Event</b> — concrete trigger (someone said/did something specific)\n\u{1F4C8} <b>Trend</b> — narrative bubbling across multiple posts\n\u{1F680} <b>Post</b> — a single viral post\n\n<i>Tip: turning all of them off also receives all — no silent state.</i>',
  alertTypeNameEvent: 'Event',
  alertTypeNameTrend: 'Trend',
  alertTypeNamePost:  'Post',
  alertTypeToggled: (name, enabled) => `${enabled ? '\u{2705}' : '\u{274C}'} <b>${name}</b> alerts ${enabled ? 'enabled' : 'disabled'}`,

  // ── Language ───────────────────────────────────────────────────────────
  languageTitle: '\u{1F310} <b>Language</b>\n\nChoose your preferred language for alerts and interface:',
  languageSet: (lang) => `\u{2705} Language set to <b>${lang === 'en' ? 'English' : '\u{420}\u{443}\u{441}\u{441}\u{43A}\u{438}\u{439}'}</b>`,

  // ── Threshold ──────────────────────────────────────────────────────────
  thresholdTitle: (current) => `\u{1F3AF} <b>Alert Threshold</b>\n\nCurrent: <b>${current}/100</b>\n\nOnly trends scoring above this value will reach you.\n<i>Lower = more alerts. Higher = only the loudest signals.</i>\n\nPick a preset or set your own:`,
  thresholdSet: (val) => `\u{2705} Alert threshold set to <b>${val}/100</b>`,
  thresholdLow: '\u{1F7E2} Low \u00B7 52+ \u2014 more alerts',
  thresholdMedium: '\u{1F7E1} Medium \u00B7 67+ \u2014 balanced',
  thresholdHigh: '\u{1F534} High \u00B7 75+ \u2014 only the loudest',
  thresholdCustomBtn: '\u270F\uFE0F Custom number',
  // Marker prepended to the active preset row inside the threshold keyboard
  // so users can tell at a glance which one matches their current value.
  thresholdActiveMark: '\u25B8 ',
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
  btnPaySOL: '\u{26A1} Pay with SOL',
  btnPayUSDC: '\u{1F4B5} Pay with USDC',
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
  // Alert-type labels (orthogonal to category \u2014 describes the SHAPE of the
  // signal). Rendered as a chip on the first line of every alert.
  alertTypeEvent: 'EVENT',
  alertTypeTrend: 'TREND',
  alertTypePost:  'POST',
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
  topSelectorTitle: '\u{1F525} <b>Top Narratives · last 24h</b>\n\nHow many trends do you want to see?',
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
    // Keys derive from LIFESPAN_VALUES — see src/analysis/lifespan.js.
    // Legacy descriptive forms are normalized away at scorer/dashboard
    // read sites via normalizeLifespan(), so we don't carry them here.
    flash: '\u26A1', short: '\u{1F552}', medium: '\u{1F4C5}', long: '\u{1F4C6}',
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

  // Inline buttons on the result card
  xAnalysisRefreshBtn: '\u{1F504} Refresh',
  xAnalysisSearchBtn:  '\u{1F517} Search on X',

  // Cooldown toast (shown when refresh is hit within the 1h window)
  xAnalysisCooldown: (min) => `\u{23F3} Refresh available in ${min} min`,

  // Cache / freshness markers inside the result card
  xAnalysisFromCache: (min) => `\u{1F4BE} Cached · ${min} min ago`,
  xAnalysisFallbackNote: (actor) => `\u{26A0}\u{FE0F} Primary actor failed, fell back to ${actor}`,

  // History delta line (previous virality score → current)
  xAnalysisDelta: (prev, sign) => `\u{1F4C8} Previous: <b>${prev}/100</b> (${sign})`,
  xAnalysisDeltaNeutral: (prev) => `\u{1F4C8} Previous: <b>${prev}/100</b> (=)`,

  // Concentration (astroturf) warning
  xAnalysisConcentration: (pct, author) =>
    `\u{26A0}\u{FE0F} <b>@${author}</b> drives <b>${pct}%</b> of engagement (single-account signal)`,

  // Grok prior-snapshot block (pulled from stored xSearchData)
  xAnalysisGrokHeader: '\u{1F9E0} <b>Grok snapshot (at scan time):</b>',
  xAnalysisGrokLine:   (buzz, momentum, organicity) =>
    `buzz=${buzz} \u00B7 momentum=${momentum} \u00B7 organicity=${organicity}`,

  // ── Trigger search (on-demand Grok reasoning catalyst lookup) ──────────
  triggerBtn:        '\u{1F50D} Trigger',
  triggerCachedBtn:  '\u{1F4A1} Trigger',
  triggerLockedBtn:  '\u{1F512} Trigger (Pro)',
  triggerLocked:     '\u{1F512} Trigger search is a Pro-plan feature. Upgrade to unlock.',
  triggerLoading:    '\u{1F50D} Searching trigger... (~30-60s, reasoning mode)',
  triggerInFlight:   '\u{1F50D} Another user is already searching this trend’s trigger. Try again in ~30s.',
  triggerCooldown:   (min) => `\u{23F3} You can run another trigger search in ${min} min`,
  triggerHeader:     '\u{1F4A1} <b>Trigger:</b>',
  triggerSourcesHdr: '\u{1F4E1} <b>Sources:</b>',
  triggerConfidence: (pct) => `<i>Confidence: ${pct}%</i>`,
  triggerNotFound:   'No specific catalyst found — narrative appears to be ongoing chatter without a clear trigger event.',
  triggerError:      (err) => `\u{274C} Trigger search failed: ${err}`,
  triggerDisabled:   '\u{274C} Trigger search is currently unavailable (XAI_API_KEY not configured).',

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
    // Keys derive from LIFESPAN_VALUES — see src/analysis/lifespan.js.
    flash:  '\u{26A1} Flash (hours)',
    short:  '\u{1F550} Short (1-2 days)',
    medium: '\u{1F4C5} Medium (3-7 days)',
    long:   '\u{1F4C6} Long (weeks+)',
    'unknown': '\u{2753} Unknown',
  },

  // ── Feedback "Reason for rating" wizard ────────────────────────────────
  // Surfaced after the user taps 👍 / 👎 — they get a "Reason" button which
  // captures one short text message via _awaitingInput FSM.
  btnFeedbackReason: '\u{270F}\u{FE0F} Reason for rating',
  feedbackReasonPrompt: '\u{1F4DD} <b>Why this rating?</b>\n\nReply with one short sentence (any language). Send /skip to cancel. Max 240 characters.',
  feedbackReasonSaved: '\u{2705} <b>Reason saved.</b> The AI will use it for similar trends next cycle.',
  feedbackReasonSkipped: '\u{1F44C} Cancelled — your vote stays as is.',
  feedbackReasonNoVote: '\u{26A0}\u{FE0F} You haven’t voted on this trend, or your vote was removed. Vote again first.',
  feedbackReasonTooLong: '\u{26A0}\u{FE0F} Too long (max 240 chars). Tap the Reason button again to retry.',
};

// Loud failure at module load if the i18n maps drift from LIFESPAN_VALUES.
assertCoversLifespans('en.topLifeIcons', en.topLifeIcons);
assertCoversLifespans('en.lifespans',    en.lifespans);

export default en;

function scoreEmoji(score) {
  if (score >= 90) return '\u{1F525}\u{1F525}\u{1F525}';
  if (score >= 75) return '\u{1F525}\u{1F525}';
  if (score >= 60) return '\u{1F525}';
  return '\u{1F4CA}';
}
