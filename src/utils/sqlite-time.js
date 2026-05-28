/**
 * Build a SQLite-comparable cutoff timestamp `msAgo` milliseconds in the past.
 *
 * SQLite stores `CURRENT_TIMESTAMP` / `datetime('now')` columns as TEXT in the
 * form "YYYY-MM-DD HH:MM:SS" (note the SPACE between date and time). JS
 * `Date#toISOString()` instead yields "YYYY-MM-DDTHH:MM:SS.sssZ" (a "T").
 * Comparing those two lexicographically is WRONG: a space (0x20) sorts BEFORE
 * "T" (0x54), so e.g. `WHERE first_seen_at > <toISOString()>` silently drops
 * in-window rows. This helper emits the SPACE form so text comparisons against
 * those columns are correct.
 *
 * ALWAYS use this for cutoffs compared to CURRENT_TIMESTAMP / datetime('now')
 * columns — never raw `toISOString()`. (Audit DB-012/020/027, SD-8.)
 *
 * @param {number} msAgo - milliseconds before "now" for the cutoff.
 * @returns {string} e.g. "2026-05-29 08:30:00"
 */
export function sqliteCutoff(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}
