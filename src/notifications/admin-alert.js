// Admin crash alert helper — Bundle #13 (2026-05-28).
//
// Posts crash/error notifications to config.support.groupId via the support
// bot. Used by uncaughtException / unhandledRejection / per-user dispatch
// crashes / TG truncate events.
//
// Init flow: src/index.js calls initAdminAlerts(supportBot.bot, config, logger)
// at boot AFTER supportBot is constructed. Until init is called,
// notifyAdminCrash() is a no-op (logs the gap once at init time).

let _bot = null;
let _groupId = null;
let _logger = console;
const _dedupeMap = new Map(); // fingerprint -> lastSentMs
const _COOLDOWN_MS = 5 * 60 * 1000;
const _ADMIN_MSG_LIMIT = 4000; // leave headroom under TG 4096 plain-text cap

/**
 * Wire the admin-alert module to the support bot instance.
 * Safe to call once at boot from src/index.js. If groupId missing,
 * notifyAdminCrash becomes a no-op (logs once at init).
 *
 * @param {Object|null} supportBot - the underlying bot instance (e.g., supportBot.bot)
 * @param {Object} config - app config (reads config.support.groupId)
 * @param {Object} [logger] - logger with .info/.warn/.error (default: console)
 */
export function initAdminAlerts(supportBot, config, logger) {
  _bot = supportBot || null;
  _groupId = config?.support?.groupId || null;
  _logger = logger || console;
  if (!_groupId) {
    _logger.warn('[admin-alert] No SUPPORT_GROUP_ID configured — crash notifications disabled');
  } else if (!_bot) {
    _logger.warn('[admin-alert] Support bot instance not provided — crash notifications disabled');
  } else {
    _logger.info('[admin-alert] Initialized — crash notifications enabled');
  }
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fingerprint(err) {
  const name = err?.name || 'Error';
  const stack = (err?.stack || '').split('\n').slice(1, 2).join('') || (err?.message || '');
  return `${name}::${stack}`.slice(0, 200);
}

/**
 * Send admin crash notification. Never throws. Dedupes via in-memory Map
 * with 5-min cooldown per fingerprint (errorName + first stack line).
 *
 * @param {Error|string} error
 * @param {Object} [context] - structured payload, JSON.stringify'd safely
 * @returns {Promise<void>}
 */
export async function notifyAdminCrash(error, context = {}) {
  if (!_bot || !_groupId) return; // no-op until initialized

  const err = error instanceof Error ? error : new Error(String(error));
  const fp = fingerprint(err);
  const now = Date.now();
  const lastSent = _dedupeMap.get(fp) || 0;
  if (now - lastSent < _COOLDOWN_MS) return; // suppress duplicate within cooldown

  _dedupeMap.set(fp, now);

  const env = process.env.NODE_ENV || 'unknown';
  const stackLines = (err.stack || '').split('\n').slice(0, 4).join('\n');

  let ctxStr = '';
  try { ctxStr = JSON.stringify(context).slice(0, 500); }
  catch { ctxStr = '(context not serializable)'; }

  let msg =
    `🚨 <code>${escHtml(env)}</code> <b>${escHtml(err.name)}</b>\n` +
    `${escHtml(err.message)}\n\n` +
    `<pre>${escHtml(stackLines)}</pre>\n\n` +
    `Context: <code>${escHtml(ctxStr)}</code>`;

  // Safety: admin alert itself must fit under TG plain-text 4096 limit.
  if (msg.length > _ADMIN_MSG_LIMIT) {
    msg = msg.slice(0, _ADMIN_MSG_LIMIT) + '\n…[truncated]';
  }

  try {
    await _bot.sendMessage(_groupId, msg, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: false,
    });
  } catch (e) {
    // Admin TG send failed — log and swallow. Don't cascade into another crash.
    _logger.warn(`[admin-alert] sendMessage to admin group failed: ${e.message}`);
  }
}

/**
 * Test/debug helper — clears the dedupe Map. Exposed для REPL/manual tests,
 * not used by production code.
 */
export function _resetForTest() {
  _dedupeMap.clear();
}
