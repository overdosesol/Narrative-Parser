/**
 * Alert formatter — creates localized messages for Telegram (HTML)
 */
import { getTranslations } from '../i18n/index.js';

const SCORE_EMOJI = (score) => {
  if (score >= 90) return '\u{1F525}\u{1F525}\u{1F525}';
  if (score >= 75) return '\u{1F525}\u{1F525}';
  if (score >= 60) return '\u{1F525}';
  return '\u{1F4CA}';
};

/**
 * Format trend alert for Telegram (HTML parse_mode)
 * @param {Object} trend - The scored trend object
 * @param {string} lang - Language code ('en' or 'ru')
 */
export function formatTelegramAlert(trend, lang = 'en') {
  const t = getTranslations(lang);
  const memePotential = trend.memePotential || 0;

  let msg = t.alertHeader(memePotential) + '\n\n';

  // Title display:
  // EN users: original English source title (or AI English title)
  // RU users: show EN source title + RU translated title
  const enTitle = trend.titleEn || trend.originalTitle || trend.original_title || trend.title;
  const ruTitle = (trend.title !== enTitle) ? trend.title : null;

  if (lang === 'ru' && ruTitle) {
    msg += `\u{1F1EC}\u{1F1E7} ${escHtml(enTitle)}\n`;
    msg += `\u{1F1F7}\u{1F1FA} <b>${escHtml(ruTitle)}</b>\n\n`;
  } else {
    msg += `\u{1F4CC} <b>${escHtml(enTitle)}</b>\n\n`;
  }

  // Trigger event — rendered only when the model found a concrete cause.
  // Shown above the longer AI explanation as a one-liner with a 🔥 marker.
  if (trend.whyNow) {
    msg += `\u{1F525} <b>${escHtml(trend.whyNow)}</b>\n\n`;
  }

  if (trend.aiExplanation) {
    msg += `\u{1F916} ${escHtml(trend.aiExplanation)}\n\n`;
  }

  const sources = trend.sources ? trend.sources.join(', ') : trend.source;
  const category = t.categories[trend.category] || trend.category || t.categories.other;
  const sentiment = t.sentiments[trend.sentiment] || trend.sentiment || t.sentiments.neutral;
  const lifespan = t.lifespans[trend.predictedLifespan] || trend.predictedLifespan || t.lifespans.unknown;

  msg += `\u{1F4C2} ${t.alertCategory}: ${escHtml(category)}\n`;
  msg += `\u{1F525} ${t.alertViralityScore}: ${trend.score}/100\n`;
  msg += `\u{1F3AD} ${t.alertSentiment}: ${escHtml(sentiment)}\n`;
  msg += `\u{23F1} ${t.alertForecast}: ${escHtml(lifespan)}\n`;
  msg += `\u{1F30D} ${t.alertSources}: ${escHtml(sources)}\n`;

  if (trend.metrics) {
    const m = trend.metrics;
    if (m.upvotes) msg += t.alertUpvotes(formatNumber(m.upvotes), formatNumber(m.velocity || 0)) + '\n';
    if (m.comments) msg += t.alertComments(formatNumber(m.comments)) + '\n';
    if (m.formattedTraffic) msg += t.alertGoogleTraffic(escHtml(m.formattedTraffic)) + '\n';

    if (m.twitter && m.twitter.tweetCount > 0) {
      const tw = m.twitter;
      msg += '\n' + t.alertTwitterHeader(tw.windowHours) + '\n';
      msg += `   Tweets: ${tw.tweetCount}`;
      if (tw.totalViews > 0)   msg += ` | \u{1F441} ${formatNumber(tw.totalViews)}`;
      if (tw.totalLikes > 0)   msg += ` | \u{2764}\u{FE0F} ${formatNumber(tw.totalLikes)}`;
      if (tw.totalRetweets > 0) msg += ` | \u{1F501} ${formatNumber(tw.totalRetweets)}`;
      msg += '\n';
      if (tw.viralityScore >= 60) msg += `   \u{1F4E1} Virality: ${tw.viralityScore}/100 \u{1F525}\n`;
      else msg += `   \u{1F4E1} Virality: ${tw.viralityScore}/100\n`;
    }
  }

  if (trend.url) {
    msg += `\n\u{1F517} <a href="${trend.url}">${t.alertOpen}</a>`;
  }

  return msg;
}

/**
 * Format the on-demand X/Twitter analysis result
 */
export function formatTwitterResult(result, query, lang = 'en') {
  const t = getTranslations(lang);
  const { tweetCount, totalViews, totalLikes, totalRetweets, totalReplies, viralityScore, accounts } = result;

  const viralEmoji = viralityScore >= 75 ? '\u{1F525}\u{1F525}\u{1F525}' : viralityScore >= 50 ? '\u{1F525}\u{1F525}' : viralityScore >= 25 ? '\u{1F525}' : '\u{1F4CA}';

  let msg = t.xAnalysisTitle + '\n';
  msg += `\u{1F50D} ${t.xAnalysisQuery}: <code>${escHtml(query)}</code>\n\n`;
  msg += `\u{1F4CA} <b>${t.xAnalysisVirality}: ${viralityScore}/100</b> ${viralEmoji}\n\n`;
  msg += `\u{1F426} ${t.xAnalysisTweets}: <b>${tweetCount}</b>\n`;
  if (totalViews   > 0) msg += `\u{1F441} ${t.xAnalysisViews}: <b>${formatNumber(totalViews)}</b>\n`;
  if (totalLikes   > 0) msg += `\u{2764}\u{FE0F} ${t.xAnalysisLikes}: <b>${formatNumber(totalLikes)}</b>\n`;
  if (totalRetweets > 0) msg += `\u{1F501} ${t.xAnalysisRetweets}: <b>${formatNumber(totalRetweets)}</b>\n`;
  if (totalReplies > 0) msg += `\u{1F4AC} ${t.xAnalysisReplies}: <b>${formatNumber(totalReplies)}</b>\n`;
  if (accounts && accounts.length > 0) {
    msg += `\n\u{1F464} ${t.xAnalysisAuthors}: ${accounts.map(a => escHtml(a)).join(', ')}\n`;
  }

  return msg;
}

// ── Utility ──────────────────────────────────────────────────────────────────

function escHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatNumber(num) {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}
