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

  const DIV = '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501';
  let msg = t.alertHeader(memePotential) + '\n';
  msg += DIV + '\n';

  // Single-line title. Historical note: earlier prompts returned both `title`
  // (English) and `titleRu` (Russian), so the formatter rendered a two-flag
  // bilingual block. The current SYSTEM_PROMPT is English-only — there is no
  // Russian translation anywhere in the pipeline, and `trend.titleEn` is not
  // restored by `_hydrateTrendFromDb` either. The dual-flag path therefore
  // produced "🇷🇺 <English text>" on manual resends, which confused users.
  // If we ever reintroduce translations, bring back a guarded bilingual branch
  // here — but gate it on a real `titleRu` field, not on inequality.
  const displayTitle = trend.title || trend.titleEn || trend.originalTitle || trend.original_title || '';
  msg += `\u{1F4CC} <b>${escHtml(displayTitle)}</b>\n\n`;

  if (trend.whyNow) {
    msg += `\u{1F525} <b>${t.alertTrigger}:</b> ${escHtml(trend.whyNow)}\n\n`;
  }

  if (trend.aiExplanation) {
    msg += `\u{1F916} <b>${t.alertAI}:</b> ${escHtml(trend.aiExplanation)}\n\n`;
  }

  const sources = trend.sources ? trend.sources.join(', ') : trend.source;
  const category = t.categories[trend.category] || trend.category || t.categories.other;
  const sentiment = t.sentiments[trend.sentiment] || trend.sentiment || t.sentiments.neutral;
  const lifespan = t.lifespans[trend.predictedLifespan] || trend.predictedLifespan || t.lifespans.unknown;

  msg += DIV + '\n';
  msg += `${escHtml(category)}  \u00B7  ${escHtml(sentiment)}  \u00B7  ${escHtml(lifespan)}\n`;
  msg += `\u{1F30D} ${escHtml(sources)}\n`;

  if (trend.metrics) {
    const m = trend.metrics;
    const hasEngagement = m.upvotes || m.comments || m.formattedTraffic;
    if (hasEngagement) msg += DIV + '\n';
    if (m.upvotes) {
      const src = (trend.source || '').toLowerCase();
      const count = formatNumber(m.upvotes);
      const vel   = formatNumber(m.velocity || 0);
      if (src === 'twitter')      msg += t.alertLikes(count, vel) + '\n';
      else if (src === 'tiktok')  msg += t.alertPlays(count, vel) + '\n';
      else                        msg += t.alertUpvotes(count, vel) + '\n';
    }
    if (m.comments) msg += t.alertComments(formatNumber(m.comments)) + '\n';
    if (m.formattedTraffic) msg += t.alertGoogleTraffic(escHtml(m.formattedTraffic)) + '\n';

    if (m.twitter && m.twitter.tweetCount > 0) {
      const tw = m.twitter;
      msg += DIV + '\n';
      msg += t.alertTwitterHeader(tw.windowHours) + '\n';
      const parts = [];
      if (tw.totalViews > 0)    parts.push(`\u{1F441} <b>${formatNumber(tw.totalViews)}</b>`);
      if (tw.totalLikes > 0)    parts.push(`\u{2764}\u{FE0F} <b>${formatNumber(tw.totalLikes)}</b>`);
      if (tw.totalRetweets > 0) parts.push(`\u{1F501} <b>${formatNumber(tw.totalRetweets)}</b>`);
      if (parts.length) msg += parts.join('  ') + `  \u00B7  ${tw.tweetCount} tweets\n`;
      else              msg += `${tw.tweetCount} tweets\n`;
      const flame = tw.viralityScore >= 60 ? ' \u{1F525}' : '';
      msg += `\u{1F4E1} ${t.alertViralityScore} <b>${tw.viralityScore}/100</b>${flame}\n`;
    }
  }

  if (trend.url) {
    msg += DIV + '\n';
    msg += `\u{1F517} <a href="${trend.url}">${t.alertOpen}</a>`;
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
