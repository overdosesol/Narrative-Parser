/**
 * Alert formatter — creates localized messages for Telegram (HTML)
 */
import { getTranslations } from '../i18n/index.js';
import { normalizeLifespan } from '../analysis/lifespan.js';
import { collectSubjectNames, buildSubjectMatchRegex } from '../analysis/subject-names.js';

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

  // Subject names: collected once per alert, used to highlight in title /
  // whyNow / aiExplanation. Title is already wrapped in <b>, so we use <u>
  // there; whyNow + aiExplanation are plain text \u2192 <b>.
  const subjects = collectSubjectNames(trend);
  const subjectRegex = buildSubjectMatchRegex(subjects.aliases);

  const DIV = '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501';
  // Alert-type chip \u2014 rendered above the header so it's the very first line
  // the user sees. NULL alertType (legacy / pre-rollout rows) \u2192 no chip.
  const typeChip = formatAlertTypeChip(trend.alertType, t);
  let msg = '';
  if (typeChip) msg += typeChip + '\n';
  msg += t.alertHeader(memePotential) + '\n';
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
  // Title is in <b>; subject names get an additional <u> so they stand out
  // INSIDE the bold header instead of blending in.
  msg += `\u{1F4CC} <b>${highlightHtml(escHtml(displayTitle), subjectRegex, '<u>', '</u>')}</b>\n\n`;

  if (trend.whyNow) {
    msg += `\u{1F525} <b>${t.alertTrigger}:</b> ${highlightHtml(escHtml(trend.whyNow), subjectRegex, '<b>', '</b>')}\n\n`;
  }

  if (trend.aiExplanation) {
    msg += `\u{1F916} <b>${t.alertAI}:</b> ${highlightHtml(escHtml(trend.aiExplanation), subjectRegex, '<b>', '</b>')}\n\n`;
  }

  const sources = trend.sources ? trend.sources.join(', ') : trend.source;
  const category = t.categories[trend.category] || trend.category || t.categories.other;
  const sentiment = t.sentiments[trend.sentiment] || trend.sentiment || t.sentiments.neutral;
  // Normalize legacy descriptive forms from old DB rows before lookup.
  const lspKey = normalizeLifespan(trend.predictedLifespan);
  const lifespan = (lspKey && t.lifespans[lspKey]) || trend.predictedLifespan || t.lifespans.unknown;

  msg += DIV + '\n';
  msg += `${escHtml(category)}  \u00B7  ${escHtml(sentiment)}  \u00B7  ${escHtml(lifespan)}\n`;
  msg += `\u{1F30D} ${escHtml(sources)}\n`;

  if (trend.metrics) {
    const m = trend.metrics;
    const src = (trend.source || '').toLowerCase();
    // X Trends carry tweet-aggregated engagement (views/likes/retweets) instead
    // of upvotes. Render the rich row (views + likes + retweets) inline like
    // the X-analysis section below — single number is misleading because the
    // trend's signal is the *combination*.
    const isXTrend = src === 'x_trends' && (m.views || m.likes || m.retweets);
    const hasEngagement = isXTrend || m.upvotes || m.comments || m.formattedTraffic;
    if (hasEngagement) msg += DIV + '\n';

    if (isXTrend) {
      const parts = [];
      if (m.views    > 0) parts.push(`\u{1F441} <b>${formatNumber(m.views)}</b>`);
      if (m.likes    > 0) parts.push(`\u{2764}\u{FE0F} <b>${formatNumber(m.likes)}</b>`);
      if (m.retweets > 0) parts.push(`\u{1F501} <b>${formatNumber(m.retweets)}</b>`);
      if (m.replies  > 0) parts.push(`\u{1F4AC} <b>${formatNumber(m.replies)}</b>`);
      if (parts.length) {
        const tw = m.tweetsCount || (m.topTweets ? m.topTweets.length : 0);
        msg += parts.join('  ') + (tw > 0 ? `  ·  ${tw} tweets\n` : '\n');
      }
    } else if (m.upvotes || (src === 'tiktok' && m.plays)) {
      const vel   = formatNumber(m.velocity || 0);
      if (src === 'twitter') {
        msg += t.alertLikes(formatNumber(m.upvotes), vel) + '\n';
      } else if (src === 'tiktok') {
        // Show REAL plays count for TikTok, not the upvotes composite
        // (likes + shares×3). Earlier the alert displayed `m.upvotes` labelled
        // as "plays" — e.g. for a video with 128K likes + 17K shares the row
        // read "180.6K plays" while real plays were 2.14M. This caused user
        // confusion: the metric label "plays" was wrong, and the displayed
        // count was a synthetic composite that didn't match either the
        // platform's plays counter or its likes counter. Switch to actual
        // `m.plays` so what the user sees in the alert matches what they
        // see when they click through.
        msg += t.alertPlays(formatNumber(m.plays || 0), vel) + '\n';
      } else {
        msg += t.alertUpvotes(formatNumber(m.upvotes), vel) + '\n';
      }
    }
    if (m.comments && !isXTrend) msg += t.alertComments(formatNumber(m.comments)) + '\n';
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
 * Format the on-demand X/Twitter analysis result.
 *
 * @param {Object} result   — summarized output from TwitterChecker.searchNarrative
 * @param {string} query    — the query string passed to Apify
 * @param {string} lang     — 'en' | 'ru'
 * @param {Object} [extras] — optional enrichment
 * @param {number}  [extras.prevViralityScore] previous virality score for delta
 * @param {Object}  [extras.grokPrev] xSearchData snapshot from scorer Stage 2
 */
export function formatTwitterResult(result, query, lang = 'en', extras = {}) {
  const t = getTranslations(lang);
  const {
    tweetCount, totalViews, totalLikes, totalRetweets, totalReplies,
    viralityScore, concentration, topAuthor, fromCache, cachedAt, fellBack, actorUsed,
  } = result;

  const viralEmoji = viralityScore >= 75 ? '\u{1F525}\u{1F525}\u{1F525}'
                  : viralityScore >= 50 ? '\u{1F525}\u{1F525}'
                  : viralityScore >= 25 ? '\u{1F525}'
                  : '\u{1F4CA}';

  let msg = t.xAnalysisTitle + '\n';
  msg += `\u{1F50D} ${t.xAnalysisQuery}: <code>${escHtml(query)}</code>\n`;

  // Cache / fallback markers — show before main numbers so user knows freshness
  if (fromCache && cachedAt) {
    const ageMin = Math.max(1, Math.round((Date.now() - cachedAt) / 60000));
    msg += `${t.xAnalysisFromCache(ageMin)}\n`;
  }
  if (fellBack && actorUsed) {
    msg += `${t.xAnalysisFallbackNote(actorUsed)}\n`;
  }

  msg += `\n\u{1F4CA} <b>${t.xAnalysisVirality}: ${viralityScore}/100</b> ${viralEmoji}\n`;

  // Virality delta vs previous recorded snapshot
  if (typeof extras.prevViralityScore === 'number' && extras.prevViralityScore >= 0) {
    const prev = extras.prevViralityScore;
    const diff = viralityScore - prev;
    if (diff === 0) {
      msg += t.xAnalysisDeltaNeutral(prev) + '\n';
    } else {
      const sign = diff > 0 ? `\u{1F4C8} +${diff}` : `\u{1F4C9} ${diff}`;
      msg += t.xAnalysisDelta(prev, sign) + '\n';
    }
  }

  msg += '\n';
  msg += `\u{1F426} ${t.xAnalysisTweets}: <b>${tweetCount}</b>\n`;
  if (totalViews    > 0) msg += `\u{1F441} ${t.xAnalysisViews}: <b>${formatNumber(totalViews)}</b>\n`;
  if (totalLikes    > 0) msg += `\u{2764}\u{FE0F} ${t.xAnalysisLikes}: <b>${formatNumber(totalLikes)}</b>\n`;
  if (totalRetweets > 0) msg += `\u{1F501} ${t.xAnalysisRetweets}: <b>${formatNumber(totalRetweets)}</b>\n`;
  if (totalReplies  > 0) msg += `\u{1F4AC} ${t.xAnalysisReplies}: <b>${formatNumber(totalReplies)}</b>\n`;

  // Concentration (astroturf) warning — only render when meaningful.
  // Threshold 70% matches the "single-account signal" rubric from Stage 2.
  if (concentration >= 70 && topAuthor) {
    msg += '\n' + t.xAnalysisConcentration(concentration, escHtml(topAuthor)) + '\n';
  }

  // Grok snapshot from the scorer's Stage 2 run (if present in the trend row).
  // Gives a before/after feel: "Grok saw X at scan time, now live data says Y".
  const gp = extras.grokPrev;
  if (gp && (gp.xBuzz || gp.narrativeMomentum || gp.organicity)) {
    msg += '\n' + t.xAnalysisGrokHeader + '\n';
    msg += t.xAnalysisGrokLine(
      gp.xBuzz             || 'unknown',
      gp.narrativeMomentum || 'unknown',
      gp.organicity        || 'unknown'
    ) + '\n';
  }

  return msg;
}

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * Build the alert-type chip line: "📰 СОБЫТИЕ" / "📈 ТРЕНД" / "🚀 ПОСТ".
 * Returns empty string when the trend has no alertType (legacy rows) so
 * the formatter can simply skip emitting the line.
 */
function formatAlertTypeChip(alertType, t) {
  if (!alertType) return '';
  if (alertType === 'event') return `\u{1F4F0} <b>${escHtml(t.alertTypeEvent)}</b>`;
  if (alertType === 'trend') return `\u{1F4C8} <b>${escHtml(t.alertTypeTrend)}</b>`;
  if (alertType === 'post')  return `\u{1F680} <b>${escHtml(t.alertTypePost)}</b>`;
  return '';
}

function escHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Wrap every regex match in `text` with `openTag`/`closeTag`. The input
 * MUST already be HTML-escaped (we call escHtml first in the alert chain),
 * so we don't need to re-escape and the inserted tags are safe. The regex
 * may be null (no subjects found) → returns text unchanged.
 *
 * Critical: tags ('<b>', '<u>') are NOT in the escaped input, so they
 * survive intact in the output. Tag literals must be raw '<b>' style, not
 * already-escaped '&lt;b&gt;'.
 */
function highlightHtml(escapedText, regex, openTag, closeTag) {
  if (!escapedText || !regex) return escapedText || '';
  // Reset lastIndex defensively — regex was constructed with /g flag.
  regex.lastIndex = 0;
  return escapedText.replace(regex, (match) => `${openTag}${match}${closeTag}`);
}

function formatNumber(num) {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}
