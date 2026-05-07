// Plan entitlements — single source of truth for "what can plan X do?".
//
// Used by both the dashboard backend (feed/stats source-filter, manual-analyze
// gate, catalyst-trigger gate, history-window cap) and the Telegram bot
// (manual-analyze command, catalyst-trigger callback). Frontends mirror these
// caps to render 🔒 markers and "X / cap today" counters consistently.
//
// Caps semantics (caps fields manualAnalyze / catalyst / xAnalysis / historyHours):
//   -1 = unlimited (admin / pro on some features)
//    0 = blocked (free, only for manualAnalyze / catalyst / xAnalysis)
//   N>0 = N/day soft cap for paid features, or N-hours window cap for history
//
// Sources: array of source-IDs the user is allowed to see in their feed and
// receive alerts for. Free is locked to reddit + google_trends; paid plans
// (test/pro) include all 5.
//
// historyHours: max age (hours) of trends in dashboard feed/stats. Free is
// capped to 72h (3 days) — paid plans see anything in DB. Window selector
// on the SPA renders 🔒 on options exceeding this cap.
//
// xAnalysis: per-day cap on X/Twitter on-demand analysis (the 🔍 button
// under each alert that fetches live tweet metrics via Apify). Free=0
// (blocked, ~$0.001/call but on free plan adds up); Test=10/day (taste
// of paid feature); Pro/Admin unlimited. The bot enforces this with an
// in-memory hits Map (24h rolling window), same shape as catalyst.

export const ALL_SOURCES = ['reddit', 'google_trends', 'twitter', 'tiktok', 'x_trends'];

const PLAN_ENTITLEMENTS = {
  free:  { sources: ['reddit', 'google_trends'], manualAnalyze: 0,   catalyst: 0,   xAnalysis: 0,  historyHours: 72, favorites: false },
  test:  { sources: ALL_SOURCES,                 manualAnalyze: 5,   catalyst: 5,   xAnalysis: 10, historyHours: -1, favorites: false },
  pro:   { sources: ALL_SOURCES,                 manualAnalyze: 100, catalyst: 100, xAnalysis: -1, historyHours: -1, favorites: true  },
  admin: { sources: ALL_SOURCES,                 manualAnalyze: -1,  catalyst: -1,  xAnalysis: -1, historyHours: -1, favorites: true  },
};

/** Return entitlements for a given plan name. Falls back to `free` for
 *  unknown values (paranoid default — better to over-restrict than leak). */
export function getPlanEntitlements(planName) {
  return PLAN_ENTITLEMENTS[planName] || PLAN_ENTITLEMENTS.free;
}

/** Whether a plan should see a per-call usage counter ("X/N used today").
 *  Test gets it (small caps, awareness valuable). Pro doesn't (cap=100 is
 *  huge, counter would be noise). Admin no caps at all. Free can't call
 *  these features. */
export function shouldShowUsageCounter(planName) {
  return planName === 'test';
}
