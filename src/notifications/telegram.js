import TelegramBot from 'node-telegram-bot-api';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { formatTelegramAlert, formatTwitterResult } from './formatter.js';
import { getTranslations } from '../i18n/index.js';
import { normalizeLifespan } from '../analysis/lifespan.js';
import TwitterChecker from '../collectors/twitter-check.js';
import { UserRateLimiter } from '../utils/rate-limiter.js';
import { getPlanEntitlements, shouldShowUsageCounter } from '../billing/entitlements.js';

// PII masking for log lines (last 4 chars of identifier). See dashboard
// server.js for rationale - long-term stdout shouldn't keep full chat_ids.
function maskId(id) {
  const s = String(id ?? '');
  return s ? '***' + s.slice(-4) : '<empty>';
}
import { runManualAnalysis, peekManualAnalysisCache } from '../analysis/manual-analysis.js';

/**
 * Build a deep-link to grok.com with a pre-filled prompt asking Grok to
 * assess the narrative's current virality. Returns null when the trend is
 * missing the bits needed to form a useful prompt.
 * grok.com accepts `?q=<url-encoded-text>` and auto-sends it as the first message.
 */
function buildGrokUrl(trend, lang = 'en') {
  if (!trend) return null;
  const title = trend.titleEn || trend.title_en || trend.original_title || trend.originalTitle || trend.title || '';
  const url   = trend.url || '';
  if (!title && !url) return null;

  const prompt = lang === 'ru'
    ? `\u041D\u0430\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0432\u0438\u0440\u0443\u0441\u0438\u0442\u0441\u044F \u044D\u0442\u043E\u0442 \u043D\u0430\u0440\u0440\u0430\u0442\u0438\u0432 \u043F\u0440\u044F\u043C\u043E \u0441\u0435\u0439\u0447\u0430\u0441? ${title}${url ? ' - ' + url : ''}`
    : `How viral is this narrative right now? ${title}${url ? ' - ' + url : ''}`;

  return `https://grok.com/?q=${encodeURIComponent(prompt)}`;
}

/**
 * Multi-user Telegram bot with inline keyboard management.
 * Each user has their own language, sources, threshold, and subscription.
 */
class TelegramNotifier {
  constructor(config, logger, db, solanaMonitor = null, triggerFinder = null, scorer = null) {
    this.logger = logger;
    this.botToken = config.telegram.botToken;
    this.db = db;
    this.config = config;
    this.solanaMonitor = solanaMonitor; // injected after creation, or passed directly
    this.triggerFinder = triggerFinder; // optional - pro-only trigger search via Grok reasoning
    // Scorer for the pro/admin manual-analysis URL handler. Without it the
    // /analyze command and bare-URL handler reply with "feature unavailable".
    this.scorer = scorer;
    this.twitterChecker = new TwitterChecker(config, logger, db);
    this.enabled = !!this.botToken;
    // Rate limiter: max 30 interactions per user per minute
    this._rateLimiter = new UserRateLimiter({ windowMs: 60_000, maxRequests: 30 });
    // State: users awaiting a text input (e.g. custom threshold)
    // Map<chatId, { type: 'threshold' }>
    this._awaitingInput = new Map();
    // Manual analysis & Catalyst-forecast rate-limit rings. Map<chatId,
    // number[]> — timestamps within the rolling 24h window. Reset on restart
    // (in-memory only — soft cap, not a security boundary).
    this._manualAnalysisHits = new Map();
    this._catalystHits       = new Map();

    if (!this.botToken) {
      this.logger.warn('Telegram bot token not set - Telegram alerts disabled');
      return;
    }

    try {
      this.bot = new TelegramBot(this.botToken, {
        polling: {
          params: {
            allowed_updates: ['message', 'callback_query', 'message_reaction'],
          }
        }
      });
      this.logger.info('Telegram Bot initialized (multi-user mode)');
      this._registerBotCommands();
      this._setupCommands();
      this._setupCallbacks();
      this._setupReactions();
      this._setupPollingErrorHandler();
    } catch (e) {
      this.logger.error(`Failed to start Telegram Bot: ${e.message}`);
    }
  }

  // ── Register bot commands in BotFather (menu hint) ───────────────────────

  _registerBotCommands() {
    // English (default for all languages)
    const enCommands = [
      { command: 'start',     description: 'Start the bot / register' },
      { command: 'menu',      description: 'Open settings menu' },
      { command: 'dashboard', description: 'Open the web dashboard' },
      { command: 'top',       description: 'Top-10 memecoin narratives (24h)' },
      { command: 'analyze',   description: 'Analyze a URL (Pro / Admin)' },
    ];

    // Keep command descriptions in English for all locales
    const ruCommands = enCommands;

    // Fire-and-forget - errors are non-critical
    Promise.all([
      this.bot.setMyCommands(enCommands, { language_code: '' }),   // default (EN)
      this.bot.setMyCommands(enCommands, { language_code: 'en' }),
      this.bot.setMyCommands(ruCommands, { language_code: 'ru' }),
    ])
      .then(() => this.logger.info('Bot commands registered (EN + RU)'))
      .catch(e => this.logger.warn(`Failed to register bot commands: ${e.message}`));
  }

  // ── Command handlers ──────────────────────────────────────────────────────

  _setupCommands() {
    // /start - register user & show welcome (optional auth deep-link payload)
    this.bot.onText(/^\/start(?:\s+(.+))?/, (msg, match) => {
      const chatId = msg.chat.id;
      const username = msg.from?.username || null;
      const user = this.db.getOrCreateUser(chatId, username);
      const t = getTranslations(user.language);
      const payload = (match && match[1] || '').trim();

      // Fire-and-forget avatar refresh - cosmetic, must not block /start
      this.refreshUserAvatar(chatId, user.id).catch(() => {});

      // ── Dashboard login deep-link: /start auth_<sessionId> ───────────
      const authMatch = payload.match(/^auth_([a-f0-9]{32})$/i);
      if (authMatch) {
        const sessionId = authMatch[1].toLowerCase();
        const result = this.db.attachAuthCode(sessionId, chatId);
        if (!result) {
          const txt = user.language === 'ru'
            ? '\u274C Ссылка для входа недействительна или устарела. Вернитесь на сайт и попробуйте снова.'
            : '\u274C Login link is invalid or expired. Go back to the site and try again.';
          this.bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
          return;
        }
        if (result.alreadyVerified) {
          const txt = user.language === 'ru'
            ? '\u2705 Эта сессия уже подтверждена.'
            : '\u2705 This session is already verified.';
          this.bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
          return;
        }
        const mins = Math.max(1, Math.round((result.expiresAt - Date.now()) / 60000));
        const title = user.language === 'ru' ? '\u{1F510} Код для входа на сайт' : '\u{1F510} Website login code';
        const prompt = user.language === 'ru'
          ? `Введите этот код на сайте, чтобы войти:\n\n<code>${result.code}</code>\n\n\u23F1 Код действителен ${mins} мин.\nЕсли вы не запрашивали вход - просто проигнорируйте это сообщение.`
          : `Enter this code on the site to sign in:\n\n<code>${result.code}</code>\n\n\u23F1 Code expires in ${mins} min.\nIf you didn't request a login, you can ignore this message.`;
        this.bot.sendMessage(chatId, `<b>${title}</b>\n\n${prompt}`, { parse_mode: 'HTML' });
        return;
      }

      this.bot.sendMessage(chatId, t.welcome, {
        parse_mode: 'HTML',
        reply_markup: this._startKeyboard(user),
      });
    });

    // /menu - show settings menu
    this.bot.onText(/^\/menu/, (msg) => {
      const chatId = msg.chat.id;
      const user = this.db.getOrCreateUser(chatId, msg.from?.username);
      const t = getTranslations(user.language);

      this.bot.sendMessage(chatId, t.menuTitle, {
        parse_mode: 'HTML',
        reply_markup: this._mainMenuKeyboard(user),
      });
    });

    // /dashboard - send the web-dashboard URL with a clickable button. URL
    // comes from PUBLIC_BASE_URL (set in production .env) with a hardcoded
    // fallback so it still works in dev or if the env var is missing.
    this.bot.onText(/^\/dashboard/, (msg) => {
      const chatId = msg.chat.id;
      const user = this.db.getOrCreateUser(chatId, msg.from?.username);
      const t = getTranslations(user.language);
      const url = process.env.PUBLIC_BASE_URL || 'https://catalystparser.io';

      this.bot.sendMessage(chatId, t.dashboardPrompt(url), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: t.btnDashboard, url }]],
        },
      });
    });

    // /analyze <url> - pro/admin only. Resolves the URL, runs the full
    // scorer pipeline, and replies with a regular alert message (same
    // rendering as autonomous alerts). Bare URLs from the same plans are
    // also auto-detected by the message handler below.
    this.bot.onText(/^\/analyze(?:@\w+)?(?:\s+(.+))?/i, async (msg, match) => {
      const chatId = String(msg.chat.id);
      const arg = (match?.[1] || '').trim();
      const user = this.db.getOrCreateUser(msg.chat.id, msg.from?.username);
      if (!arg) {
        // Heavy-horizontal dividers (U+2501) match the alert-message style in
        // formatter.js - same visual rhythm so manual responses don't look
        // foreign next to autonomous alerts.
        const DIV = '━'.repeat(20);
        const text = user.language === 'ru'
          ? '\u{1F50D} <b>/analyze - ручной анализ ссылки</b>\n'
            + DIV + '\n'
            + '\u{1F916} Кидай ссылку на пост (X, Reddit, TikTok) - прогоню её через тот же пайплайн, что и автоалерты: скор, триггер, разбор нарратива, метрики.\n'
            + DIV + '\n'
            + '\u{2728} <b>Пример</b>\n<code>/analyze https://x.com/user/status/123</code>\n'
            + DIV + '\n'
            + '\u{1F4A1} <i>Подсказка: можно просто вставить ссылку без команды - поймаю автоматически.</i>'
          : '\u{1F50D} <b>/analyze - manual link analysis</b>\n'
            + DIV + '\n'
            + '\u{1F916} Drop a post link (X, Reddit, TikTok) and I’ll run it through the same pipeline as automatic alerts: score, trigger, narrative breakdown, engagement.\n'
            + DIV + '\n'
            + '\u{2728} <b>Example</b>\n<code>/analyze https://x.com/user/status/123</code>\n'
            + DIV + '\n'
            + '\u{1F4A1} <i>Tip: paste the link without the command - I’ll pick it up automatically.</i>';
        return this.bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      }
      // Pull the first http(s) URL from the argument string. Tolerates a
      // trailing comment like "/analyze https://x.com/... - посмотри это".
      const m = arg.match(/(https?:\/\/\S+)/i);
      if (!m) {
        const txt = user.language === 'ru' ? '⚠ Не нашёл URL в сообщении' : '⚠ No URL found in message';
        return this.bot.sendMessage(chatId, txt);
      }
      this._runManualAnalysisForUser(msg, user, m[1]).catch(e =>
        this.logger.warn(`[Manual TG /analyze] ${e.message}`)
      );
    });

    // Bare-URL handler - pro/admin can paste a URL with no command prefix
    // and we run analysis automatically. Other plans are silently ignored
    // (we don't want to nag every free user who shares a link in chat).
    // Registered BEFORE the wizard handler so wizard inputs that happen to
    // contain a URL still go through their state machine first.
    this.bot.on('message', async (msg) => {
      const chatId = String(msg.chat.id);
      const text = msg.text || '';
      if (!text || text.startsWith('/')) return;
      // If the user is in a multi-step wizard (threshold input, feedback
      // reason, etc.), the wizard handler claims this message - skip URL
      // detection so we don't double-handle.
      if (this._awaitingInput.has(chatId)) return;
      const m = text.match(/(https?:\/\/\S+)/i);
      if (!m) return;
      const user = this.db.getOrCreateUser(msg.chat.id, msg.from?.username);
      // Plan gate - silently ignore for free (no spam). Test/pro/admin get
      // automatic analysis on bare URL paste; daily caps applied downstream
      // in _runManualAnalysisForUser.
      if (getPlanEntitlements(user.plan_name).manualAnalyze === 0) return;
      this._runManualAnalysisForUser(msg, user, m[1]).catch(e =>
        this.logger.warn(`[Manual TG bare-url] ${e.message}`)
      );
    });

    // Free-text handler - processes awaited inputs (e.g. custom threshold)
    // Must be registered before /top so it fires on plain number messages
    this.bot.on('message', async (msg) => {
      const chatId = String(msg.chat.id);
      const text = msg.text || '';

      const state = this._awaitingInput.get(chatId);

      // Allow `/skip` to abort an in-progress wizard cleanly. Other commands
      // are handled by their own onText handlers, so we ignore them here.
      if (text.startsWith('/')) {
        if (state && text.trim().toLowerCase().startsWith('/skip')) {
          this._awaitingInput.delete(chatId);
          const u = this.db.getOrCreateUser(msg.chat.id, msg.from?.username);
          const tr = getTranslations(u.language);
          await this.bot.sendMessage(msg.chat.id, tr.feedbackReasonSkipped || 'Cancelled.', {
            parse_mode: 'HTML',
          }).catch(() => {});
        }
        return;
      }

      if (!state) return;

      const user = this.db.getOrCreateUser(msg.chat.id, msg.from?.username);
      const t = getTranslations(user.language);

      // 5-minute timeout - drop stale states so a user who clicks the button
      // but never replies isn't surprised days later when they say something.
      if (state.startedAt && Date.now() - state.startedAt > 5 * 60 * 1000) {
        this._awaitingInput.delete(chatId);
        return;
      }

      if (state.type === 'threshold') {
        this._awaitingInput.delete(chatId);
        const val = parseInt(text.trim(), 10);
        if (isNaN(val) || val < 1 || val > 100) {
          await this.bot.sendMessage(msg.chat.id, t.thresholdCustomInvalid || '\u274C Invalid value. Enter a number from 1 to 100.', {
            parse_mode: 'HTML',
          }).catch(() => {});
          return;
        }
        this.db.updateUser(user.id, 'alert_threshold', val);
        await this.bot.sendMessage(msg.chat.id, t.thresholdSet(val), {
          parse_mode: 'HTML',
          reply_markup: this._mainMenuKeyboard({ ...user, alert_threshold: val }),
        }).catch(() => {});
      }

      else if (state.type === 'feedback_reason') {
        this._awaitingInput.delete(chatId);
        const reason = text.trim();
        // Hard cap mirrors db.setFeedbackReason - message would be silently
        // truncated otherwise; tell the user instead so they can retry.
        if (reason.length > 240) {
          await this.bot.sendMessage(msg.chat.id, t.feedbackReasonTooLong || 'Too long (240 chars max). Tap the button again to retry.', {
            parse_mode: 'HTML',
          }).catch(() => {});
          return;
        }
        const ok = this.db.setFeedbackReason(state.trendId, chatId, reason);
        if (ok) {
          this.logger.info(`Feedback reason saved (${reason.length} chars) for trend ${state.trendId} by ${maskId(chatId)}`);
          await this.bot.sendMessage(msg.chat.id, t.feedbackReasonSaved || 'Reason saved - thank you!', {
            parse_mode: 'HTML',
          }).catch(() => {});
        } else {
          // Vote was deleted between button-click and reply
          await this.bot.sendMessage(msg.chat.id, t.feedbackReasonNoVote || 'No active vote to attach this to.', {
            parse_mode: 'HTML',
          }).catch(() => {});
        }
      }
    });

    // /top - show count selector first, then top trends
    this.bot.onText(/^\/top/, async (msg) => {
      const chatId = msg.chat.id;
      const user = this.db.getOrCreateUser(chatId, msg.from?.username);
      const t = getTranslations(user.language);
      try {
        await this.bot.sendMessage(chatId, t.topSelectorTitle, {
          parse_mode: 'HTML',
          reply_markup: this._topSelectorKeyboard(t),
        });
      } catch (err) {
        this.logger.error(`Error handling /top: ${err.message}`);
        this.bot.sendMessage(chatId, t.errorGeneric(err.message), { parse_mode: 'HTML' });
      }
    });
  }

  // ── Callback query handlers ───────────────────────────────────────────────

  _setupCallbacks() {
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat?.id;
      if (!chatId) return;

      // Rate limit: prevent spam clicking
      if (!this._rateLimiter.allow(chatId)) {
        await this.bot.answerCallbackQuery(query.id, { text: '⏳ Slow down!' }).catch(() => {});
        return;
      }

      const user = this.db.getOrCreateUser(chatId, query.from?.username);
      const t = getTranslations(user.language);
      const data = query.data;

      try {
        // ── Main menu actions ─────────────────
        if (data === 'menu') {
          await this._editMessage(chatId, query.message.message_id, t.menuTitle, this._mainMenuKeyboard(user));
          await this.bot.answerCallbackQuery(query.id);
        }

        // ── Sources ───────────────────────────
        else if (data === 'sources') {
          await this._editMessage(chatId, query.message.message_id, t.sourcesTitle, this._sourcesKeyboard(user));
          await this.bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('toggle_source:')) {
          const sourceName = data.split(':')[1];
          // Defence-in-depth: server-side check that the user actually has
          // this source in their plan. The keyboard already filters them
          // (locked sources emit 'source_locked:' instead), but this guard
          // protects against stale message buttons from before a plan
          // downgrade.
          const planSources = getPlanEntitlements(user.plan_name).sources;
          if (!planSources.includes(sourceName)) {
            const txt = user.language === 'ru'
              ? '🔒 Этот источник доступен на Test и Pro планах.'
              : '🔒 This source is available on Test/Pro plans.';
            await this.bot.answerCallbackQuery(query.id, { text: txt, show_alert: true });
            return;
          }

          let disabled = JSON.parse(user.disabled_sources || '[]');

          if (disabled.includes(sourceName)) {
            disabled = disabled.filter(s => s !== sourceName);
          } else {
            disabled.push(sourceName);
          }

          this.db.updateUser(user.id, 'disabled_sources', JSON.stringify(disabled));
          user.disabled_sources = JSON.stringify(disabled);

          const isEnabled = !disabled.includes(sourceName);
          const displayName = t.sourceNames[sourceName] || sourceName;
          await this.bot.answerCallbackQuery(query.id, { text: t.sourceToggled(displayName, isEnabled) });
          await this._editMessage(chatId, query.message.message_id, t.sourcesTitle, this._sourcesKeyboard(user));
        }
        else if (data.startsWith('source_locked:')) {
          // Free user clicked a 🔒 source. Show upgrade hint, no state change.
          const txt = user.language === 'ru'
            ? '🔒 Этот источник доступен на Test и Pro планах. Открой /menu → Подписка чтобы апгрейднуть.'
            : '🔒 This source is available on Test/Pro plans. Open /menu → Subscription to upgrade.';
          await this.bot.answerCallbackQuery(query.id, { text: txt, show_alert: true });
        }

        // ── Alert types ───────────────────────
        else if (data === 'alert_types') {
          await this._editMessage(chatId, query.message.message_id, t.alertTypesTitle, this._alertTypesKeyboard(user));
          await this.bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('toggle_alert_type:')) {
          const key = data.split(':')[1];
          if (!['event', 'trend', 'post'].includes(key)) {
            await this.bot.answerCallbackQuery(query.id);
            return;
          }
          const current = this.db.getUserAlertTypes(user.telegram_chat_id);
          // Toggle: if present → remove; if absent → add. Empty resulting
          // array means "all" by handler contract - never silently mute.
          const next = current.includes(key)
            ? current.filter(k => k !== key)
            : [...current, key];
          this.db.setUserAlertTypes(user.telegram_chat_id, next);
          const isEnabled = next.includes(key);
          const labelKey = key === 'event' ? 'alertTypeNameEvent'
                          : key === 'trend' ? 'alertTypeNameTrend'
                          : 'alertTypeNamePost';
          const label = t[labelKey] || key;
          await this.bot.answerCallbackQuery(query.id, { text: t.alertTypeToggled(label, isEnabled).replace(/<[^>]*>/g, '') });
          await this._editMessage(chatId, query.message.message_id, t.alertTypesTitle, this._alertTypesKeyboard(user));
        }

        // ── Language ──────────────────────────
        else if (data === 'language') {
          await this._editMessage(chatId, query.message.message_id, t.languageTitle, this._languageKeyboard());
          await this.bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('set_lang:')) {
          const lang = data.split(':')[1];
          this.db.updateUser(user.id, 'language', lang);
          user.language = lang;
          const newT = getTranslations(lang);
          await this.bot.answerCallbackQuery(query.id, { text: newT.languageSet(lang) });
          await this._editMessage(chatId, query.message.message_id, newT.menuTitle, this._mainMenuKeyboard(user));
        }

        // ── Threshold ─────────────────────────
        else if (data === 'threshold') {
          await this._editMessage(chatId, query.message.message_id, t.thresholdTitle(user.alert_threshold), this._thresholdKeyboard(t, user.alert_threshold));
          await this.bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('set_threshold:')) {
          const val = parseInt(data.split(':')[1], 10);
          this.db.updateUser(user.id, 'alert_threshold', val);
          user.alert_threshold = val;
          await this.bot.answerCallbackQuery(query.id, { text: t.thresholdSet(val) });
          await this._editMessage(chatId, query.message.message_id, t.menuTitle, this._mainMenuKeyboard(user));
        }
        else if (data === 'threshold_custom') {
          // Set state: next plain text message from this user = threshold value
          this._awaitingInput.set(String(chatId), { type: 'threshold' });
          await this.bot.answerCallbackQuery(query.id);
          await this.bot.sendMessage(chatId, t.thresholdCustomPrompt || '\u270F\uFE0F Enter a number from 1 to 100:', {
            parse_mode: 'HTML',
          });
        }

        // ── Start/Stop ────────────────────────
        else if (data === 'toggle_pause') {
          const newStatus = user.status === 'active' ? 'paused' : 'active';
          this.db.updateUser(user.id, 'status', newStatus);
          user.status = newStatus;
          const statusMsg = newStatus === 'active' ? t.resumed : t.paused;
          await this.bot.answerCallbackQuery(query.id, { text: statusMsg.replace(/<[^>]*>/g, '') });
          await this._editMessage(chatId, query.message.message_id, statusMsg + '\n\n' + t.menuTitle, this._mainMenuKeyboard(user));
        }

        // ── Subscription / Upgrade ────────────
        // Both routes show the plans screen directly - the old intermediate
        // "current plan / upgrade" status page was removed since users almost
        // always wanted to pick a plan, not stare at their current one.
        else if (data === 'subscription' || data === 'upgrade') {
          await this._editMessage(chatId, query.message.message_id, t.paymentTitle, this._plansKeyboard(t));
          await this.bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('buy_plan:')) {
          const planName = data.split(':')[1];

          if (!['test', 'pro'].includes(planName)) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Plan is unavailable', show_alert: true });
            return;
          }

          if (planName === 'test' && this.db.hasConfirmedPlanPayment(user.id, 'test')) {
            const txt = user.language === 'ru'
              ? 'Тестовый план можно купить только один раз на аккаунт.'
              : 'Test plan can only be purchased once per account.';
            await this.bot.answerCallbackQuery(query.id, { text: txt, show_alert: true });
            return;
          }

          await this._editMessage(chatId, query.message.message_id, t.paymentMethod, this._paymentMethodKeyboard(planName, t));
          await this.bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('pay:')) {
          const [, planName, currency] = data.split(':');
          await this._handlePayment(chatId, query.message.message_id, user, planName, currency, t);
          await this.bot.answerCallbackQuery(query.id);
        }

        // ── Top trends ────────────────────────
        else if (data === 'top') {
          await this._editMessage(chatId, query.message.message_id, t.topSelectorTitle, this._topSelectorKeyboard(t));
          await this.bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('top:')) {
          const limit = parseInt(data.split(':')[1], 10) || 5;
          await this.bot.answerCallbackQuery(query.id);
          await this._handleTopCommand(chatId, user, limit);
        }

        // ── X Analysis ────────────────────────
        else if (data.startsWith('x_analysis:')) {
          if (user.plan_name === 'test') {
            await this.bot.answerCallbackQuery(query.id, {
              text: t.xAnalysisLocked || 'X Analysis is locked for Test plan',
              show_alert: true,
            });
            return;
          }

          const trendId = parseInt(data.split(':')[1], 10);
          await this.bot.answerCallbackQuery(query.id, {
            text: user.language === 'ru' ? '\u{1F50D} \u{0418}\u{0449}\u{0443} \u{0432} X/Twitter...' : '\u{1F50D} Searching X/Twitter...'
          });
          await this._handleXAnalysis(chatId, trendId, query.message?.message_id, user);
        }
        else if (data === 'x_locked') {
          await this.bot.answerCallbackQuery(query.id, {
            text: t.xAnalysisLocked || 'X Analysis is locked for this plan',
            show_alert: true,
          });
        }

        // ── Trigger search (on-demand Grok reasoning) ────────────────────
        else if (data === 'trigger_locked') {
          await this.bot.answerCallbackQuery(query.id, {
            text: t.triggerLocked || 'Catalyst forecast is for Test/Pro plan',
            show_alert: true,
          });
        }
        else if (data.startsWith('trigger:')) {
          // Plan gate — free is hard-locked. Test/pro/admin pass; daily caps
          // applied per plan in _handleTriggerSearch.
          if (user.plan_name === 'free') {
            await this.bot.answerCallbackQuery(query.id, {
              text: t.triggerLocked || 'Catalyst forecast is for Test/Pro plan',
              show_alert: true,
            });
            return;
          }
          const trendId = parseInt(data.split(':')[1], 10);
          await this._handleTriggerSearch(chatId, trendId, query, user);
        }

        // ── X Analysis refresh (1h cooldown) ──────────────────────────────
        else if (data.startsWith('x_refresh:')) {
          if (user.plan_name === 'test') {
            await this.bot.answerCallbackQuery(query.id, {
              text: t.xAnalysisLocked || 'X Analysis is locked for Test plan',
              show_alert: true,
            });
            return;
          }
          const trendId = parseInt(data.split(':')[1], 10);
          await this._handleXRefresh(chatId, trendId, query, user);
        }

        // ── Feedback buttons (👍 / 👎 on alert cards) ────────────────────
        else if (data.startsWith('feedback:')) {
          const parts = data.split(':');
          const vote    = parseInt(parts[1], 10); // +1 or -1
          const trendId = parseInt(parts[2], 10);

          const trend = this.db?.getTrendById ? this.db.getTrendById(trendId) : null;
          if (!trend) {
            await this.bot.answerCallbackQuery(query.id, {
              text: user.language === 'ru' ? '\u274C \u0422\u0440\u0435\u043D\u0434 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D' : '\u274C Trend not found',
              show_alert: false,
            });
          } else {
            const { weight, planName } = this._feedbackWeight(String(chatId));
            const prevVote = this.db.getUserVote ? this.db.getUserVote(trendId, String(chatId)) : null;

            let finalVote = vote;
            let ackText;

            if (prevVote === vote) {
              // Same button pressed again → remove vote (toggle off)
              finalVote = 0;
              ackText = user.language === 'ru' ? '\u274C \u041E\u0446\u0435\u043D\u043A\u0430 \u0443\u0434\u0430\u043B\u0435\u043D\u0430' : '\u274C Vote removed';
            } else if (vote === 1) {
              ackText = user.language === 'ru' ? '\uD83D\uDC4D \u041B\u0430\u0439\u043A \u0437\u0430\u0441\u0447\u0438\u0442\u0430\u043D' : '\uD83D\uDC4D Liked!';
            } else {
              ackText = user.language === 'ru' ? '\uD83D\uDC4E \u0414\u0438\u0441\u043B\u0430\u0439\u043A \u0437\u0430\u0441\u0447\u0438\u0442\u0430\u043D' : '\uD83D\uDC4E Disliked!';
            }

            this.db.recordFeedback(trendId, String(chatId), finalVote, weight, planName);
            this.logger.info(`Feedback btn ${finalVote > 0 ? '+1' : finalVote < 0 ? '-1' : '0'} (w=${weight}, plan=${planName}) for "${trend.title}"`);
            await this.bot.answerCallbackQuery(query.id, { text: ackText });

            // ── Reason row toggle ─────────────────────────────────────────
            // Append a "Reason for rating" row when there's an active vote;
            // strip it when the vote was just removed. We surgically modify
            // the existing keyboard (filter out any prior fb_reason row, then
            // optionally append) so we don't need to re-derive plan-locked
            // states for the X Analysis / Trigger buttons here.
            try {
              const existingRows = query.message?.reply_markup?.inline_keyboard || [];
              const baseRows = existingRows.filter(row =>
                !row.some(b => typeof b.callback_data === 'string' && b.callback_data.startsWith('fb_reason:'))
              );
              const newRows = [...baseRows];
              if (finalVote !== 0) {
                newRows.push([{ text: t.btnFeedbackReason, callback_data: `fb_reason:${trendId}` }]);
              }
              await this.bot.editMessageReplyMarkup(
                { inline_keyboard: newRows },
                { chat_id: chatId, message_id: query.message.message_id }
              ).catch(() => {});
            } catch (err) {
              // Non-fatal - the vote was already recorded above
              this.logger.warn(`Could not toggle reason button: ${err.message}`);
            }
          }
        }

        // ── Reason-for-rating button (FSM entry) ──────────────────────────
        // Pressing this puts the user into `_awaitingInput` for `feedback_reason`
        // - the next non-command text message they send is captured as the
        // reason for their existing vote. /skip or 5-min timeout cancels.
        else if (data.startsWith('fb_reason:')) {
          const trendId = parseInt(data.split(':')[1], 10);
          const userVote = this.db?.getUserVote ? this.db.getUserVote(trendId, String(chatId)) : null;
          if (!userVote) {
            await this.bot.answerCallbackQuery(query.id, {
              text: t.feedbackReasonNoVote || 'Vote first, then add a reason',
              show_alert: false,
            });
          } else {
            this._awaitingInput.set(String(chatId), {
              type: 'feedback_reason',
              trendId,
              startedAt: Date.now(),
            });
            await this.bot.answerCallbackQuery(query.id);
            await this.bot.sendMessage(chatId, t.feedbackReasonPrompt, { parse_mode: 'HTML' }).catch(() => {});
          }
        }

        // ── Close menu ────────────────────────
        else if (data === 'close') {
          await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
          await this.bot.answerCallbackQuery(query.id);
        }

        // ── Noop ──────────────────────────────
        else if (data === 'noop') {
          await this.bot.answerCallbackQuery(query.id);
        }

      } catch (err) {
        this.logger.error(`Callback error: ${err.message}`);
        await this.bot.answerCallbackQuery(query.id, { text: 'Error' }).catch(() => {});
      }
    });
  }

  // ── Keyboard builders ─────────────────────────────────────────────────────

  // "Ask a question" deep-link. Prefers the dedicated support bot when
  // SUPPORT_BOT_USERNAME is configured; falls back to the legacy personal
  // DM URL so the button never points nowhere.
  _supportUrl() {
    const u = this.config?.support?.botUsername;
    return u ? `https://t.me/${u}` : 'https://t.me/skipnick';
  }

  _startKeyboard(user) {
    const t = getTranslations(user.language);
    const dashboardUrl = process.env.PUBLIC_BASE_URL || 'https://catalystparser.io';
    return {
      inline_keyboard: [
        [{ text: t.btnOpenMenu  || '⚙️ Open Menu',     callback_data: 'menu' }],
        [{ text: t.btnDashboard || '\u{1F310} Open Dashboard', url: dashboardUrl }],
      ],
    };
  }

  _mainMenuKeyboard(user) {
    const t = getTranslations(user.language);

    // Live badges - show each setting's current value right on its tile so
    // the menu doubles as a status screen and saves a tap to peek inside.
    const ALL_SOURCES_COUNT = 5;
    const disabled = (() => { try { return JSON.parse(user.disabled_sources || '[]'); } catch { return []; } })();
    const sourcesBadge    = t.badgeSources    ? t.badgeSources(ALL_SOURCES_COUNT - disabled.length, ALL_SOURCES_COUNT) : '';
    const thresholdBadge  = t.badgeThreshold  ? t.badgeThreshold(user.alert_threshold) : '';
    const languageBadge   = t.badgeLanguage   ? t.badgeLanguage(user.language || 'en') : '';
    const alertTypesList  = (this.db?.getUserAlertTypes ? this.db.getUserAlertTypes(user.telegram_chat_id) : []) || [];
    const alertTypesBadge = t.badgeAlertTypes ? t.badgeAlertTypes(alertTypesList.length, 3) : '';
    const dashboardUrl    = process.env.PUBLIC_BASE_URL || 'https://catalystparser.io';

    return {
      inline_keyboard: [
        [
          { text: t.btnSources   + sourcesBadge,    callback_data: 'sources'   },
          { text: t.btnThreshold + thresholdBadge,  callback_data: 'threshold' },
        ],
        [
          { text: t.btnAlertTypes + alertTypesBadge, callback_data: 'alert_types' },
          { text: t.btnLanguage   + languageBadge,   callback_data: 'language'    },
        ],
        [
          { text: t.btnTop,          callback_data: 'top'          },
          { text: t.btnSubscription, callback_data: 'subscription' },
        ],
        [{ text: t.btnDashboard || '\u{1F310} Open Dashboard', url: dashboardUrl }],
        [{ text: t.btnStartStop(user.status === 'paused'), callback_data: 'toggle_pause' }],
        [{ text: t.btnAskQuestion || '💬 Ask a question', url: this._supportUrl() }],
        [{ text: t.btnClose, callback_data: 'close' }],
      ]
    };
  }

  /**
   * Inline keyboard for the alert-types submenu. Three rows, one per type,
   * showing ✅ when subscribed and ❌ when muted. Toggling a single button
   * rewrites the user's CSV - empty = treated as "all" by the alert gate
   * (handler in src/index.js).
   */
  _alertTypesKeyboard(user) {
    const t = getTranslations(user.language);
    const types = this.db.getUserAlertTypes(user.telegram_chat_id);
    const has = (k) => types.includes(k);
    const row = (key, label, emoji) => {
      const enabled = has(key);
      const icon = enabled ? '\u{2705}' : '\u{274C}';
      return [{ text: `${icon} ${emoji} ${label}`, callback_data: `toggle_alert_type:${key}` }];
    };
    return {
      inline_keyboard: [
        row('event', t.alertTypeNameEvent, '\u{1F4F0}'),
        row('trend', t.alertTypeNameTrend, '\u{1F4C8}'),
        row('post',  t.alertTypeNamePost,  '\u{1F680}'),
        [{ text: t.btnBack, callback_data: 'menu' }],
      ]
    };
  }

  _sourcesKeyboard(user) {
    const t = getTranslations(user.language);
    const disabled = JSON.parse(user.disabled_sources || '[]');
    const allSources = ['reddit', 'google_trends', 'twitter', 'tiktok', 'x_trends'];
    // Plan-allowed sources: free is locked to reddit + google_trends.
    // Premium sources show a 🔒 instead of ✅/❌, and clicking them shows
    // an "upgrade" toast instead of toggling on/off.
    const planSources = getPlanEntitlements(user.plan_name).sources;

    const buttons = allSources.map(src => {
      const inPlan = planSources.includes(src);
      const name = t.sourceNames[src] || src;
      if (!inPlan) {
        return [{ text: `\u{1F512} ${name}`, callback_data: `source_locked:${src}` }];
      }
      const enabled = !disabled.includes(src);
      const icon = enabled ? '\u{2705}' : '\u{274C}';
      return [{ text: `${icon} ${name}`, callback_data: `toggle_source:${src}` }];
    });

    buttons.push([{ text: t.btnBack, callback_data: 'menu' }]);
    return { inline_keyboard: buttons };
  }

  _languageKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '\u{1F1EC}\u{1F1E7} English', callback_data: 'set_lang:en' }, { text: '\u{1F1F7}\u{1F1FA} Russian', callback_data: 'set_lang:ru' }],
        [{ text: '\u{25C0}\u{FE0F} Back', callback_data: 'menu' }],
      ]
    };
  }

  _thresholdKeyboard(t, current) {
    // Mark the row matching the user's current threshold so they can spot
    // their active preset at a glance. Falls back to a leading space for
    // the inactive rows so all three labels stay vertically aligned.
    const mark = (val) => current === val ? (t.thresholdActiveMark || '\u25B8 ') : '\u2003 ';
    return {
      inline_keyboard: [
        [{ text: mark(52) + t.thresholdLow,    callback_data: 'set_threshold:52' }],
        [{ text: mark(67) + t.thresholdMedium, callback_data: 'set_threshold:67' }],
        [{ text: mark(75) + t.thresholdHigh,   callback_data: 'set_threshold:75' }],
        [{ text: t.thresholdCustomBtn || '\u270F\uFE0F Custom', callback_data: 'threshold_custom' }],
        [{ text: t.btnBack, callback_data: 'menu' }],
      ]
    };
  }

  _plansKeyboard(t) {
    return {
      inline_keyboard: [
        [{ text: t.planTest || 'Test Plan ($5 / 1 day)', callback_data: 'buy_plan:test' }],
        [{ text: t.planPro || 'Pro ($100 / 30 days)', callback_data: 'buy_plan:pro' }],
        [{ text: t.btnBack, callback_data: 'menu' }],
      ]
    };
  }

  _paymentMethodKeyboard(planName, t) {
    return {
      inline_keyboard: [
        [{ text: t.btnPaySOL,  callback_data: `pay:${planName}:SOL`   }],
        [{ text: t.btnPayUSDC, callback_data: `pay:${planName}:USDC`  }],
        [{ text: t.btnBack, callback_data: 'upgrade' }],
      ]
    };
  }

  // ── Payment handler ───────────────────────────────────────────────────────

  async _handlePayment(chatId, messageId, user, planName, currency, t) {
    if (!this.solanaMonitor) {
      await this._editMessage(chatId, messageId,
        '❌ Payment system not configured. Please contact support.',
        { inline_keyboard: [[{ text: t.btnBack, callback_data: 'upgrade' }]] }
      );
      return;
    }

    try {
      // Show loading state while we fetch SOL price (if needed)
      await this._editMessage(chatId, messageId,
        '⏳ Generating payment details...',
        { inline_keyboard: [[{ text: '⏳', callback_data: 'noop' }]] }
      );

      // Use SolanaPayMonitor which handles SOL price fetching correctly
      const intent = await this.solanaMonitor.createPaymentIntent(planName, currency);

      // Create payment record in DB (expires in 30 min)
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      this.db.createPayment(user.id, planName, intent.amount, currency, intent.reference, expiresAt);

      const msg = t.paymentInstructions(
        intent.amount,
        currency,
        this.config.solanaPay.merchantWallet,
        intent.reference
      );

      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(intent.payUrl)}`;

      try {
        await this.bot.deleteMessage(chatId, messageId).catch(() => {});
        await this.bot.sendPhoto(chatId, qrUrl, {
          caption: msg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: t.btnBack, callback_data: 'upgrade' }]]
          }
        });
      } catch (e) {
        await this.bot.sendMessage(chatId, msg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: t.btnBack, callback_data: 'upgrade' }]]
          }
        });
      }
    } catch (err) {
      this.logger.error(`Payment generation failed: ${err.message}`);
      await this._editMessage(chatId, messageId,
        t.errorGeneric(this._escHtml(err.message)),
        { inline_keyboard: [[{ text: t.btnBack, callback_data: 'upgrade' }]] }
      );
    }
  }

  _generateReference() {
    return randomBytes(24).toString('base64url').slice(0, 32);
  }

  // ── Top trends ────────────────────────────────────────────────────────────

  _topSelectorKeyboard(t) {
    const btn = (n) => ({ text: t.topBtnCount(n), callback_data: `top:${n}` });
    return {
      inline_keyboard: [
        [btn(3),  btn(5)],
        [btn(10), btn(20)],
        [{ text: t.btnBack, callback_data: 'menu' }],
      ],
    };
  }

  async _handleTopCommand(chatId, user, limit = 5) {
    const t = getTranslations(user.language);

    if (!this.db) {
      return this.bot.sendMessage(chatId, t.dbUnavailable, { parse_mode: 'HTML' });
    }

    const recent = this.db.getRecentTrends(24);
    if (!recent || recent.length === 0) {
      return this.bot.sendMessage(chatId, t.topEmpty, { parse_mode: 'HTML' });
    }

    const parsed = recent.map(row => {
      let metrics = {};
      try { metrics = JSON.parse(row.raw_metrics || '{}'); } catch(e) {}
      return {
        title:         row.title,
        originalTitle: row.original_title,
        score:         row.score,
        category:      row.category,
        sentiment:     row.sentiment,
        url:           row.url,
        memePotential: metrics.memePotential || 0,
        predictedLifespan: metrics.predictedLifespan || null,
        // Optional pitch line - only show on the /top card if a pro user
        // already ran a deep trigger search for this trend. No fallback to the
        // legacy whyItWillPump, no auto-generation, no Stage-1 hint.
        triggerText:   row.trigger_text || null,
        tgMessageUrl:  metrics.tgMessageUrl || null,
      };
    });

    const filtered = parsed.filter(tr => tr.category !== 'boring' && tr.category !== 'politics');
    filtered.sort((a, b) => b.memePotential - a.memePotential);
    const top = filtered.slice(0, limit);

    if (top.length === 0) {
      return this.bot.sendMessage(chatId, t.topEmpty, { parse_mode: 'HTML' });
    }

    // ── Score helpers ───────────────────────────────────────────────────────
    const scoreFire = (s) =>
      s >= 90 ? '\uD83D\uDD25\uD83D\uDD25\uD83D\uDD25' :
      s >= 75 ? '\uD83D\uDD25\uD83D\uDD25' :
      s >= 60 ? '\uD83D\uDD25' : '\uD83D\uDCCA';

    const scoreBar = (s) => {
      const filled = Math.round(s / 10);
      return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled) + ' ' + s;
    };

    const catIcon  = (cat) => (t.topCatIcons  || {})[cat]  || '\u{1F4CC}';
    const lifeIcon = (lsp) => (t.topLifeIcons || {})[lsp]  || '\u2753';

    // ── Build message ───────────────────────────────────────────────────────
    // Header
    let report = t.topTitle(limit) + '\n';

    top.forEach((tr, i) => {
      const title = this._escHtml(
        user.language === 'en' && tr.originalTitle ? tr.originalTitle : tr.title
      );
      const catIco  = catIcon(tr.category);
      // Normalize legacy descriptive forms ("flash (hours)") from old DB rows.
      const lifeLbl = tr.predictedLifespan ? lifeIcon(normalizeLifespan(tr.predictedLifespan)) : '';

      report += '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
      // Number + title
      report += `<b>${i + 1}. ${title}</b>\n`;
      // Score bar + category + lifespan
      report += `<code>${scoreBar(tr.memePotential)}</code>  ${catIco}`;
      if (lifeLbl) report += '  ' + lifeLbl;
      report += '\n';
      // Pitch line - only shown if a Pro user has already searched the trigger
      // (deep Grok-reasoning catalyst summary). Truncated for the /top card so
      // the report stays compact; full text is available in the alert thread.
      if (tr.triggerText) {
        const short = tr.triggerText.length > 220 ? tr.triggerText.slice(0, 217) + '...' : tr.triggerText;
        report += `\u{1F4A1} <i>${this._escHtml(short)}</i>\n`;
      }
      // Links
      const links = [];
      if (tr.url)         links.push(`<a href="${tr.url}">\uD83D\uDD17 ${t.topSource}</a>`);
      if (tr.tgMessageUrl) links.push(`<a href="${tr.tgMessageUrl}">\uD83D\uDCE2 ${t.topTgPost}</a>`);
      if (links.length)   report += links.join('  \u00B7  ') + '\n';
    });

    await this.bot.sendMessage(chatId, report, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  // ── Manual analysis (pro/admin) ───────────────────────────────────────────
  //
  // Triggered by /analyze <url> or bare URL paste from a pro/admin user.
  // Resolves the URL → runs scorer → replies with the regular alert format
  // via sendAlertToUser. Result is NOT saved to the trends table - analyses
  // are private to the requesting user's chat. Caller is expected to have
  // already verified the user's plan; this method enforces it again as a
  // defence in depth.
  async _runManualAnalysisForUser(msg, user, url) {
    const chatId = String(msg.chat.id);

    const ent = getPlanEntitlements(user.plan_name);
    // Plan gate — free is hard-locked. Test/pro/admin pass; daily cap below.
    if (ent.manualAnalyze === 0) {
      const txt = user.language === 'ru'
        ? '🔒 Ручной анализ доступен на Test и Pro планах. Открой /menu чтобы апгрейднуть.'
        : '🔒 Manual analysis is a Test/Pro feature. Use /menu to upgrade.';
      return this.bot.sendMessage(chatId, txt).catch(() => {});
    }
    if (!this.scorer) {
      return this.bot.sendMessage(chatId, '⚠ Manual analysis is not configured on this server.').catch(() => {});
    }

    // Rate limit only when scorer will actually run. Cache hits are free
    // and instant - letting them bypass means a pro user can re-paste a
    // URL someone else just analysed without burning their daily quota.
    // 30s cooldown stays for everyone except admin (anti-dupe protection).
    const cacheAge = peekManualAnalysisCache(url);
    if (cacheAge === null && ent.manualAnalyze > 0) {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const cooldownMs = 30 * 1000;
      const dailyCap = ent.manualAnalyze;
      const hits = (this._manualAnalysisHits.get(chatId) || []).filter(t => now - t < dayMs);
      if (hits.length && now - hits[hits.length - 1] < cooldownMs) {
        const sec = Math.max(1, Math.ceil((cooldownMs - (now - hits[hits.length - 1])) / 1000));
        const txt = user.language === 'ru'
          ? `⏳ Подожди ${sec}с - анализ занимает 10-30 секунд.`
          : `⏳ Wait ${sec}s - each analysis takes 10-30 seconds.`;
        return this.bot.sendMessage(chatId, txt).catch(() => {});
      }
      if (hits.length >= dailyCap) {
        const txt = user.language === 'ru'
          ? `⛔ Дневной лимит исчерпан (${dailyCap}/24ч).`
          : `⛔ Daily limit reached (${dailyCap} / 24h).`;
        return this.bot.sendMessage(chatId, txt).catch(() => {});
      }
      hits.push(now);
      this._manualAnalysisHits.set(chatId, hits);
    }

    // Acknowledge - analysis can take 10-30s, the user needs to know we
    // received the request. Skip it on cache hits (instant) and delete
    // this placeholder once the real result is ready.
    let waitMsgId = null;
    if (cacheAge === null) {
      try {
        const ackText = user.language === 'ru'
          ? '⚙️ Анализирую... (Stage 1 + Stage 2 Grok, 10-30 сек)'
          : '⚙️ Analyzing... (Stage 1 + Stage 2 Grok, 10-30 sec)';
        const wm = await this.bot.sendMessage(chatId, ackText);
        waitMsgId = wm?.message_id;
      } catch { /* ack is cosmetic */ }
    }

    try {
      const result = await runManualAnalysis({
        scorer: this.scorer,
        db: this.db,
        url,
        save: false,                          // private - don't pollute global feed
        logger: this.logger,
        actorId: chatId,
      });
      // Tear down the "analyzing..." placeholder before the alert lands so
      // there's no visual stutter.
      if (waitMsgId) {
        try { await this.bot.deleteMessage(chatId, waitMsgId); } catch {}
      }
      // Send the result via the standard alert renderer - same media
      // handling, same buttons, same caption logic. We don't record this
      // as a notification (no DB row) and don't increment alert_count -
      // it's a private analysis, not a broadcast.
      const sent = await this.sendAlertToUser(result.trend, user);
      if (!sent) {
        const txt = user.language === 'ru' ? '⚠ Не удалось отправить результат.' : '⚠ Failed to deliver the result.';
        await this.bot.sendMessage(chatId, txt).catch(() => {});
      }
      // Test-plan usage counter — sent as a separate small message so the
      // user sees daily-cap remaining without us editing the alert template.
      // Skipped on cache hits (no slot consumed) and for pro/admin/free.
      if (!result.fromCache && shouldShowUsageCounter(user.plan_name) && ent.manualAnalyze > 0) {
        const used = (this._manualAnalysisHits.get(chatId) || []).length;
        const left = Math.max(0, ent.manualAnalyze - used);
        const counterText = user.language === 'ru'
          ? `📊 ${used}/${ent.manualAnalyze} использовано сегодня (осталось ${left})`
          : `📊 ${used}/${ent.manualAnalyze} used today (${left} left)`;
        await this.bot.sendMessage(chatId, counterText).catch(() => {});
      }
    } catch (err) {
      if (waitMsgId) {
        try { await this.bot.deleteMessage(chatId, waitMsgId); } catch {}
      }
      this.logger.warn(`[Manual TG] failed for ${maskId(chatId)}: ${err.message}`);
      const head = user.language === 'ru' ? '⚠ Ошибка анализа: ' : '⚠ Analysis failed: ';
      await this.bot.sendMessage(chatId, head + (err.message || 'unknown')).catch(() => {});
    }
  }

  // ── Send alert to a specific user ─────────────────────────────────────────

  async sendAlertToUser(trend, user, opts = {}) {
    if (!this.enabled || !this.bot) return false;

    try {
      const t = getTranslations(user.language);
      let message = formatTelegramAlert(trend, user.language);
      // Optional admin comment prepended to the alert body. Used by the
      // "📨 Отправить алерт" button on SubmitPage - lets the operator add
      // context (e.g. "смотрите реплаи под этим постом") without editing
      // the formatter. HTML-escaped to match parse_mode: 'HTML'.
      const rawComment = typeof opts.comment === 'string' ? opts.comment.trim() : '';
      if (rawComment) {
        const esc = rawComment
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        message = `💬 <b>${esc}</b>\n\n` + message;
      }
      const chatId = user.telegram_chat_id;

      // Collect all available images (deduped). Prefer the array collected by
      // collectors + clusterer; fall back to the single imageUrl.
      const rawUrls = Array.isArray(trend.metrics?.imageUrls) && trend.metrics.imageUrls.length
        ? trend.metrics.imageUrls
        : (trend.metrics?.imageUrl ? [trend.metrics.imageUrl] : []);
      const imageUrls = [];
      for (const u of rawUrls) {
        if (u && !imageUrls.includes(u)) imageUrls.push(u);
        if (imageUrls.length >= 10) break;
      }

      const videoUrl = trend.metrics?.videoUrl || null;

      // Telegram media-group caption cap is 1024 chars. If message is longer,
      // send album without caption and post the full text as a follow-up.
      const CAPTION_MAX = 1024;
      const fitsInCaption = message.length <= CAPTION_MAX;

      let sentMsg;

      // Prefer video over stills when present. If it's a pure gallery (>=2
      // photos and no single video), images win - multi-image posts aren't
      // videos anyway, and media groups can't mix here without the video
      // likely exceeding 50MB by URL.
      if (videoUrl && imageUrls.length < 2) {
        // For Reddit DASH (v.redd.it): try to mux audio for a non-silent alert.
        // Falls back to original silent URL if ffmpeg missing / no audio track.
        let videoSource = videoUrl;
        if (/v\.redd\.it/i.test(videoUrl)) {
          try {
            const muxed = await this._muxRedditVideo(videoUrl);
            if (muxed) videoSource = muxed; // local file path, uploaded as multipart
          } catch (e) {
            this.logger.warn(`[Video] mux attempt failed: ${e.message}`);
          }
        }
        try {
          sentMsg = await this.bot.sendVideo(chatId, videoSource, {
            caption: fitsInCaption ? message : undefined,
            parse_mode: 'HTML',
            supports_streaming: true,
          });
          if (!fitsInCaption) {
            await this.bot.sendMessage(chatId, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_to_message_id: sentMsg?.message_id,
            });
          }
        } catch (err) {
          // Common causes: >50MB, bad codec, Telegram can't fetch URL. Fall
          // back to the still-frame path.
          this.logger.warn(`sendVideo failed (${err.message}) - falling back to image`);
          const fallbackImg = imageUrls[0] || trend.metrics?.thumbnailUrl || null;
          if (fallbackImg) {
            try {
              sentMsg = await this.bot.sendPhoto(chatId, fallbackImg, {
                caption: fitsInCaption ? message : undefined,
                parse_mode: 'HTML',
              });
              if (!fitsInCaption) {
                await this.bot.sendMessage(chatId, message, {
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  reply_to_message_id: sentMsg?.message_id,
                });
              }
            } catch {
              sentMsg = await this.bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: false,
              });
            }
          } else {
            sentMsg = await this.bot.sendMessage(chatId, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: false,
            });
          }
        }
      } else if (imageUrls.length >= 2) {
        try {
          // Media groups (albums) do NOT support inline_keyboard on their
          // items - Telegram Bot API limitation. So we send the album WITHOUT
          // a caption and post the full body as a follow-up text message that
          // CAN host buttons. We return the follow-up's message_id as the
          // anchor so attachAlertButtons wires X Analysis / Ask Grok / 👍👎
          // to a message that accepts them.
          const media = imageUrls.map((u) => ({ type: 'photo', media: u }));
          // Send the album silently - the follow-up text message is what
          // triggers the single notification ping (with buttons attached).
          const group = await this.bot.sendMediaGroup(chatId, media, { disable_notification: true });
          const albumAnchor = Array.isArray(group) ? group[0] : group;
          sentMsg = await this.bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_to_message_id: albumAnchor?.message_id,
          });
        } catch (err) {
          this.logger.warn(`sendMediaGroup failed (${err.message}) - falling back to sendPhoto`);
          try {
            sentMsg = await this.bot.sendPhoto(chatId, imageUrls[0], {
              caption: fitsInCaption ? message : undefined,
              parse_mode: 'HTML',
            });
            if (!fitsInCaption) {
              await this.bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_to_message_id: sentMsg?.message_id,
              });
            }
          } catch {
            sentMsg = await this.bot.sendMessage(chatId, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: false,
            });
          }
        }
      } else if (imageUrls.length === 1) {
        try {
          sentMsg = await this.bot.sendPhoto(chatId, imageUrls[0], {
            caption: fitsInCaption ? message : undefined,
            parse_mode: 'HTML',
          });
          if (!fitsInCaption) {
            await this.bot.sendMessage(chatId, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_to_message_id: sentMsg?.message_id,
            });
          }
        } catch {
          sentMsg = await this.bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false,
          });
        }
      } else {
        sentMsg = await this.bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        });
      }

      const msgId = sentMsg.message_id;
      this.logger.info(`Alert sent to user ${maskId(user.telegram_chat_id)}: "${trend.title}"`);
      return { messageId: msgId, chatId: user.telegram_chat_id };
    } catch (error) {
      if (error.response?.statusCode === 403) {
        // User blocked the bot - mark as suspended
        this.logger.warn(`User ${maskId(user.telegram_chat_id)} blocked the bot - suspending`);
        this.db.updateUser(user.id, 'status', 'suspended');
      } else {
        this.logger.error(`Alert send failed for ${maskId(user.telegram_chat_id)}: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * Attach all alert buttons: X Analysis + Trigger + Ask Grok + 👍/👎 feedback.
   * `trend` is optional - when provided, we add a deep-link button that opens
   * grok.com with a pre-filled prompt asking about the narrative's virality.
   *
   * Layout (3 rows max for mobile readability):
   *   [ X Analysis ] [ Trigger ]
   *   [ Ask Grok ]
   *   [ 👍 ]        [ 👎 ]
   *
   * Trigger button shows different label depending on cache state:
   *   - 💡 Trigger  → result already in DB, click is instant
   *   - 🔍 Trigger  → no result yet, click triggers Grok reasoning (~30-60s)
   *   - 🔒 Trigger  → user is on a non-pro plan
   */
  async attachAlertButtons(chatId, messageId, dbId, userOrLang = 'en', trend = null) {
    if (!this.bot || !messageId || !dbId) return;
    const lang = typeof userOrLang === 'string' ? userOrLang : (userOrLang?.language || 'en');
    const plan = typeof userOrLang === 'object' ? userOrLang?.plan_name : null;
    const t = getTranslations(lang);
    const isLocked = plan === 'test';
    const xText = isLocked ? (t.xAnalysisLockedBtn || '\u{1F512} X Analysis') : t.xAnalysisBtn;
    const xData = isLocked ? 'x_locked' : `x_analysis:${dbId}`;

    // Trigger button — locked for free, available on test/pro/admin
    // (daily caps applied server-side in _handleTriggerSearch).
    const catalystEnabled = plan && plan !== 'free';
    let triggerText, triggerData;
    if (!catalystEnabled) {
      triggerText = t.triggerLockedBtn || '\u{1F512} Trigger';
      triggerData = 'trigger_locked';
    } else {
      // Cheap DB peek - no Grok call. Tells us if we should show 💡 (cached) or 🔍 (new).
      const cached = this.db?.getTrendTrigger ? this.db.getTrendTrigger(dbId) : null;
      triggerText = cached ? (t.triggerCachedBtn || '\u{1F4A1} Trigger') : (t.triggerBtn || '\u{1F50D} Trigger');
      triggerData = `trigger:${dbId}`;
    }

    const topRow = [
      { text: xText,        callback_data: xData },
      { text: triggerText,  callback_data: triggerData },
    ];
    const rows = [topRow];

    const grokUrl = buildGrokUrl(trend, lang);
    if (grokUrl) {
      rows.push([{ text: t.btnAskGrok, url: grokUrl }]);
    }
    rows.push([
      { text: '\u{1F44D}', callback_data: `feedback:1:${dbId}` },
      { text: '\u{1F44E}', callback_data: `feedback:-1:${dbId}` },
    ]);

    try {
      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: rows },
        { chat_id: chatId, message_id: messageId }
      );
    } catch (e) {
      this.logger.warn(`Could not attach alert buttons: ${e.message}`);
    }
  }

  /** Backward-compat alias - forwards trend so the Grok button appears. */
  async attachXButton(chatId, messageId, dbId, userOrLang = 'en', trend = null) {
    return this.attachAlertButtons(chatId, messageId, dbId, userOrLang, trend);
  }

  // ── X Analysis ────────────────────────────────────────────────────────────

  /**
   * Pull the Stage 2 `subjectName` off a trend row. Used to prime
   * `TwitterChecker.buildQuery` with a named entity (Peanut, Moo Deng, …)
   * before it falls back to heuristic title parsing. Returns null if the
   * column is missing, unparseable, or the field was never populated.
   */
  _getSubjectName(trend) {
    try {
      if (trend?.raw_metrics) {
        const metrics = JSON.parse(trend.raw_metrics);
        const name = metrics?.xSearchData?.subjectName;
        if (name && typeof name === 'string' && name.trim().length >= 2) {
          return name.trim();
        }
      }
    } catch {
      // ignore parse errors - buildQuery just falls back to title heuristics
    }
    return null;
  }

  /**
   * Build extras dict for formatTwitterResult - previous virality + Grok snapshot.
   * Called once per X Analysis render (both initial and refresh paths).
   */
  _xAnalysisExtras(trendId) {
    const extras = {};
    try {
      const trendRow = this.db?.getTrendById?.(trendId);
      if (trendRow?.raw_metrics) {
        const metrics = JSON.parse(trendRow.raw_metrics);
        if (metrics?.xSearchData) extras.grokPrev = metrics.xSearchData;
      }
      const hist = this.db?.getXAnalysisHistory?.(trendId, 1) || [];
      if (hist.length > 0) extras.prevViralityScore = hist[0].virality_score;
    } catch (e) {
      this.logger?.warn?.(`_xAnalysisExtras failed: ${e.message}`);
    }
    return extras;
  }

  /** Inline keyboard attached to every X Analysis result message. */
  _xAnalysisResultKeyboard(trendId, query, lang) {
    const t = getTranslations(lang);
    return {
      inline_keyboard: [
        [
          { text: t.xAnalysisRefreshBtn, callback_data: `x_refresh:${trendId}` },
          { text: t.xAnalysisSearchBtn,  url: TwitterChecker.searchUrl(query) },
        ],
      ],
    };
  }

  async _handleXAnalysis(chatId, trendId, originalMsgId, user) {
    const t = getTranslations(user.language);
    if (user.plan_name === 'test') {
      return this.bot.sendMessage(chatId, t.xAnalysisLocked || '🔒 X Analysis is locked for this plan.', {
        parse_mode: 'HTML',
      });
    }

    const trend = this.db?.getTrendById ? this.db.getTrendById(trendId) : null;
    if (!trend) {
      return this.bot.sendMessage(chatId, t.trendNotFound, { parse_mode: 'HTML' });
    }

    const subjectName = this._getSubjectName(trend);
    const query = TwitterChecker.buildQuery(trend.original_title || trend.title, { subjectName });
    this.logger.info(`X Analysis for "${trend.title}" -> Query: ${query} (subject=${subjectName || 'none'})`);

    try {
      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: t.xAnalysisLoading, callback_data: 'noop' }]] },
        { chat_id: chatId, message_id: originalMsgId }
      ).catch(() => {});

      if (!query || query.trim().length < 2) {
        throw new Error(t.xAnalysisNoKeywords);
      }

      // Extras (prev virality + Grok snapshot) captured BEFORE saving the fresh
      // run - so `prevViralityScore` reflects the previous fetch, not the one
      // we're about to record.
      const extras = this._xAnalysisExtras(trendId);

      const result = await this.twitterChecker.searchNarrative(query, { trendId });

      let reply;
      let keyboard = null;
      if (!result || result.tweetCount === 0) {
        reply = t.xAnalysisNone(this._escHtml(query));
      } else {
        reply = formatTwitterResult(result, query, user.language, extras);
        keyboard = this._xAnalysisResultKeyboard(trendId, query, user.language);

        // Record only genuine Apify fetches (cache hits don't contribute to history)
        if (!result.fromCache) {
          this.db?.saveXAnalysis?.(trendId, result);
        }
      }

      await this.bot.sendMessage(chatId, reply, {
        parse_mode: 'HTML',
        reply_to_message_id: originalMsgId,
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });

      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: t.xAnalysisBtn, callback_data: `x_analysis:${trendId}` }]] },
        { chat_id: chatId, message_id: originalMsgId }
      ).catch(() => {});

    } catch (err) {
      this.logger.error(`X Analysis failed: ${err.message}`);
      await this.bot.sendMessage(chatId, t.xAnalysisError(this._escHtml(err.message)), { parse_mode: 'HTML' });
      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: t.xAnalysisBtn, callback_data: `x_analysis:${trendId}` }]] },
        { chat_id: chatId, message_id: originalMsgId }
      ).catch(() => {});
    }
  }

  /**
   * Refresh button handler. Enforces a 1-hour cooldown - if the last live fetch
   * for this trend happened <60 min ago, we show a toast and bail. Otherwise
   * we force a fresh Apify run, edit the existing result message in place, and
   * record the new snapshot to history.
   */
  async _handleXRefresh(chatId, trendId, query, user) {
    const t = getTranslations(user.language);
    const cbId = query.id;
    const messageId = query.message?.message_id;

    // Cooldown check - uses in-memory cache age as the "last fresh fetch" marker.
    // cache entry is written only on actual Apify calls, so its age == last-run age.
    const ageMs = this.twitterChecker.cacheAgeMs(trendId);
    const COOLDOWN_MS = 60 * 60 * 1000;
    if (ageMs != null && ageMs < COOLDOWN_MS) {
      const minLeft = Math.max(1, Math.ceil((COOLDOWN_MS - ageMs) / 60000));
      await this.bot.answerCallbackQuery(cbId, {
        text: t.xAnalysisCooldown(minLeft),
        show_alert: false,
      }).catch(() => {});
      return;
    }

    await this.bot.answerCallbackQuery(cbId, {
      text: user.language === 'ru' ? '\u{1F504} \u{041E}\u{0431}\u{043D}\u{043E}\u{0432}\u{043B}\u{044F}\u{044E}...' : '\u{1F504} Refreshing...',
    }).catch(() => {});

    const trend = this.db?.getTrendById ? this.db.getTrendById(trendId) : null;
    if (!trend) {
      return this.bot.sendMessage(chatId, t.trendNotFound, { parse_mode: 'HTML' });
    }

    const subjectName = this._getSubjectName(trend);
    const searchQ = TwitterChecker.buildQuery(trend.original_title || trend.title, { subjectName });
    if (!searchQ || searchQ.trim().length < 2) return;

    try {
      // Capture extras BEFORE saving the new fetch
      const extras = this._xAnalysisExtras(trendId);

      const result = await this.twitterChecker.searchNarrative(searchQ, {
        trendId,
        forceFresh: true,
      });

      if (!result || result.tweetCount === 0) {
        // Edit with "no tweets" message, drop buttons
        await this.bot.editMessageText(
          t.xAnalysisNone(this._escHtml(searchQ)),
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }
        ).catch(() => {});
        return;
      }

      // Record the fresh snapshot
      this.db?.saveXAnalysis?.(trendId, result);

      const body = formatTwitterResult(result, searchQ, user.language, extras);
      const keyboard = this._xAnalysisResultKeyboard(trendId, searchQ, user.language);

      await this.bot.editMessageText(body, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      }).catch((e) => {
        // Common: "message is not modified" - ignore, means same numbers
        if (!/not modified/i.test(e?.message || '')) {
          this.logger?.warn?.(`X refresh editMessageText failed: ${e.message}`);
        }
      });
    } catch (err) {
      this.logger.error(`X Analysis refresh failed: ${err.message}`);
      await this.bot.sendMessage(chatId, t.xAnalysisError(this._escHtml(err.message)), { parse_mode: 'HTML' });
    }
  }

  // ── Trigger search (on-demand Grok reasoning) ─────────────────────────────

  /**
   * Render a Catalyst forecast payload into an HTML message matching the
   * project's alert style. Forward-looking - what will drive further growth
   * of the narrative. Used both for cached hits and fresh Grok results, so
   * they always look the same to the user.
   *
   * Fields:
   *   text       - 2-3 sentence forecast (required)
   *   phase      - early|building|peaking|saturated|fading (optional)
   *   window     - short upside-window phrase (optional)
   *   drivers    - 1-3 forward-catalyst bullets (optional)
   *   risks      - 0-2 growth-killer bullets (optional)
   *   sources    - @handles referenced (optional)
   *   confidence - 0-100 (optional)
   */
  _renderTriggerMessage(payload, lang) {
    const t = getTranslations(lang);
    const lines = [];

    // Forecast body (header + 2-3 sentence text)
    lines.push(`${t.triggerHeader}\n${this._escHtml(payload.text)}`);

    // Phase + window - single combined line when both present, individually
    // when only one is filled. Keeps the Telegram message compact.
    const phaseLabel = payload.phase
      ? (t.triggerPhaseValues?.[payload.phase] || payload.phase)
      : '';
    const chips = [];
    if (phaseLabel)    chips.push(`${t.triggerPhaseHdr} <b>${this._escHtml(phaseLabel)}</b>`);
    if (payload.window) chips.push(`${t.triggerWindowHdr} <b>${this._escHtml(payload.window)}</b>`);
    if (chips.length)  lines.push(`\n${chips.join(' · ')}`);

    // Drivers - 📈 list. Skip the header if empty (don't render an empty section).
    if (Array.isArray(payload.drivers) && payload.drivers.length > 0) {
      const items = payload.drivers
        .filter(b => typeof b === 'string' && b.trim().length > 0)
        .map(b => `• ${this._escHtml(b.trim())}`)
        .join('\n');
      if (items) lines.push(`\n${t.triggerDriversHdr}\n${items}`);
    }

    // Risks - ⚠️ list. Same skip-if-empty rule.
    if (Array.isArray(payload.risks) && payload.risks.length > 0) {
      const items = payload.risks
        .filter(b => typeof b === 'string' && b.trim().length > 0)
        .map(b => `• ${this._escHtml(b.trim())}`)
        .join('\n');
      if (items) lines.push(`\n${t.triggerRisksHdr}\n${items}`);
    }

    // (2026-05-04) Sources block removed from Telegram alerts (mirrored the
    // dashboard removal): Catalyst's source list was surfacing low-signal X
    // handles. Forecast text + drivers + risks + confidence are the useful
    // parts. payload.sources is still populated upstream but no longer rendered.
    if (typeof payload.confidence === 'number' && payload.confidence > 0) {
      lines.push(`\n${t.triggerConfidence(payload.confidence)}`);
    }
    return lines.join('\n');
  }

  /**
   * Handler for the "Trigger" button on alert cards.
   *
   * Flow:
   *   1. If trigger already in DB → render & return (no Grok call, no cooldown).
   *   2. Plan gate is enforced upstream (callback dispatcher) - by the time we
   *      get here the user is pro/admin.
   *   3. Per-user 15min cooldown (admin bypasses) - checked against the last
   *      time THIS user actually triggered a Grok call (cached reads don't count).
   *   4. DB-level claim via `db.claimTriggerSearch` to dedupe parallel clicks.
   *   5. Call Grok → save result → render. On failure release the lock so a
   *      retry is possible.
   */
  async _handleTriggerSearch(chatId, trendId, query, user) {
    const t = getTranslations(user.language);
    const cbId = query.id;
    const messageId = query.message?.message_id;

    if (!this.triggerFinder || !this.triggerFinder.enabled) {
      await this.bot.answerCallbackQuery(cbId, {
        text: t.triggerDisabled || 'Trigger search disabled',
        show_alert: true,
      }).catch(() => {});
      return;
    }

    const trend = this.db?.getTrendById ? this.db.getTrendById(trendId) : null;
    if (!trend) {
      await this.bot.answerCallbackQuery(cbId, {
        text: t.trendNotFound, show_alert: false,
      }).catch(() => {});
      return;
    }

    // ── Step 1: cached-read fast path ─────────────────────────────────────
    const existing = this.db.getTrendTrigger(trendId);
    if (existing && existing.text) {
      await this.bot.answerCallbackQuery(cbId, { text: t.triggerHeader || '💡 Trigger' }).catch(() => {});
      await this.bot.sendMessage(chatId, this._renderTriggerMessage(existing, user.language), {
        parse_mode: 'HTML',
        reply_to_message_id: messageId,
        disable_web_page_preview: true,
      });
      return;
    }

    // ── Step 2: daily cap (per-plan, in-memory). Admin bypass. ────────────
    // Replaces the old 15-min cooldown — Catalyst is cheap (~$0.05/call), so
    // daily caps (test=5/day, pro=100/day) are enough anti-spam protection.
    const ent = getPlanEntitlements(user.plan_name);
    if (ent.catalyst > 0) {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const hits = (this._catalystHits.get(String(chatId)) || []).filter(t => now - t < dayMs);
      if (hits.length >= ent.catalyst) {
        const txt = user.language === 'ru'
          ? `⛔ Дневной лимит Catalyst исчерпан (${ent.catalyst}/24ч).`
          : `⛔ Daily Catalyst limit reached (${ent.catalyst} / 24h).`;
        await this.bot.answerCallbackQuery(cbId, { text: txt, show_alert: true }).catch(() => {});
        return;
      }
      hits.push(now);
      this._catalystHits.set(String(chatId), hits);
    }

    // ── Step 3: claim the lock atomically ─────────────────────────────────
    const claim = this.db.claimTriggerSearch(trendId, chatId);
    if (!claim.claimed) {
      if (claim.state === 'cached' && claim.trend?.trigger_text) {
        // Race: another caller filled it between our check and the claim.
        // Re-read through getTrendTrigger so the rendered message includes
        // the full forecast shape (phase/window/drivers/risks) instead of
        // only the legacy text+sources+confidence triplet.
        const payload = this.db.getTrendTrigger(trendId) || {
          text:       claim.trend.trigger_text,
          sources:    (() => { try { return JSON.parse(claim.trend.trigger_sources || '[]'); } catch { return []; } })(),
          confidence: claim.trend.trigger_confidence | 0,
        };
        await this.bot.answerCallbackQuery(cbId, { text: t.triggerHeader || '💡 Trigger' }).catch(() => {});
        await this.bot.sendMessage(chatId, this._renderTriggerMessage(payload, user.language), {
          parse_mode: 'HTML',
          reply_to_message_id: messageId,
          disable_web_page_preview: true,
        });
        return;
      }
      // Another user is currently calling Grok - show toast and bail
      await this.bot.answerCallbackQuery(cbId, {
        text: t.triggerInFlight || 'Another user is searching this trigger',
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // ── Step 4: ack with loading toast (alert-style so user knows it's slow) ──
    await this.bot.answerCallbackQuery(cbId, {
      text: t.triggerLoading || 'Searching...',
      show_alert: true,
    }).catch(() => {});

    // ── Step 5: actual Grok call ──────────────────────────────────────────
    try {
      const result = await this.triggerFinder.findTrigger(trend);
      this.db.saveTrendTrigger(trendId, result);

      // Pass the full forecast shape - _renderTriggerMessage will skip any
      // empty phase/window/drivers/risks fields gracefully.
      const payload = {
        text:       result.text,
        sources:    result.sources,
        confidence: result.confidence,
        phase:      result.phase,
        window:     result.window,
        drivers:    result.drivers,
        risks:      result.risks,
      };
      await this.bot.sendMessage(chatId, this._renderTriggerMessage(payload, user.language), {
        parse_mode: 'HTML',
        reply_to_message_id: messageId,
        disable_web_page_preview: true,
      });

      // Test-plan usage counter — small follow-up message with daily-cap
      // remaining. Skipped for pro/admin/free (free can't reach this code
      // path; pro's cap is huge so counter would be noise).
      if (shouldShowUsageCounter(user.plan_name) && ent.catalyst > 0) {
        const used = (this._catalystHits.get(String(chatId)) || []).length;
        const left = Math.max(0, ent.catalyst - used);
        const counterText = user.language === 'ru'
          ? `📊 ${used}/${ent.catalyst} Каталистов сегодня (осталось ${left})`
          : `📊 ${used}/${ent.catalyst} Catalyst calls today (${left} left)`;
        await this.bot.sendMessage(chatId, counterText).catch(() => {});
      }

      // Update the original alert's keyboard so the button now shows 💡 (cached)
      // for everyone who comes back to this message later.
      this.attachAlertButtons(chatId, messageId, trendId, user, trend).catch(() => {});
    } catch (err) {
      this.db.releaseTriggerLock(trendId);
      this.logger.error(`Trigger search failed for trend #${trendId}: ${err.message}`);
      await this.bot.sendMessage(chatId, t.triggerError(this._escHtml(err.message)), {
        parse_mode: 'HTML',
        reply_to_message_id: messageId,
      });
    }
  }

  // ── Reactions feedback ────────────────────────────────────────────────────

  _setupReactions() {
    // Only 👍 and 👎 are treated as feedback signals.
    // All other emojis are intentionally ignored.
    const LIKED    = ['\u{1F44D}']; // 👍
    const DISLIKED = ['\u{1F44E}']; // 👎

    this.bot.on('message_reaction', (update) => {
      try {
        const msgId = update.message_id;
        const newReactions = update.new_reaction || [];
        const oldReactions = update.old_reaction || [];

        // Identify the reactor - available in private chats / non-anon group reactions
        const reactorChatId = String(update.user?.id || update.actor_chat?.id || '');
        if (!reactorChatId) return; // anonymous reaction - skip

        const added   = newReactions.filter(r => !oldReactions.find(o => o.emoji === r.emoji));
        const removed = oldReactions.filter(r => !newReactions.find(n => n.emoji === r.emoji));

        // Only process if there's anything relevant to 👍/👎
        const anyRelevant = [...added, ...removed].some(r =>
          LIKED.includes(r.emoji) || DISLIKED.includes(r.emoji)
        );
        if (!anyRelevant) return;

        const trend = this.db?.getTrendByTgMessageId(msgId);
        if (!trend) return;

        // Resolve voter's plan and compute weight
        const { weight, planName } = this._feedbackWeight(reactorChatId);

        for (const reaction of added) {
          if (LIKED.includes(reaction.emoji)) {
            this.db.recordFeedback(trend.id, reactorChatId, +1, weight, planName);
            this.logger.info(`Feedback +1 (w=${weight}, plan=${planName}) for "${trend.title}"`);
          } else if (DISLIKED.includes(reaction.emoji)) {
            this.db.recordFeedback(trend.id, reactorChatId, -1, weight, planName);
            this.logger.info(`Feedback -1 (w=${weight}, plan=${planName}) for "${trend.title}"`);
          }
        }

        for (const reaction of removed) {
          if (LIKED.includes(reaction.emoji) || DISLIKED.includes(reaction.emoji)) {
            // Remove vote entirely (vote=0)
            this.db.recordFeedback(trend.id, reactorChatId, 0, 0, planName);
            this.logger.info(`Feedback removed (plan=${planName}) for "${trend.title}"`);
          }
        }
      } catch (err) {
        this.logger.error(`Reaction processing error: ${err.message}`);
      }
    });
  }

  /**
   * Resolve feedback weight for a reactor based on their plan.
   * Falls back to weight=1 if weighting is disabled or user not found.
   *
   * @param {string} chatId
   * @returns {{ weight: number, planName: string }}
   */
  _feedbackWeight(chatId) {
    const enabled = this.db?.getSetting('feedbackWeightingEnabled', '1') !== '0';

    let planName = 'free';
    try {
      const user = this.db?.getUserByChatId(chatId);
      if (user?.plan_name) planName = user.plan_name;
    } catch (_) { /* user not found - default to free */ }

    // Weighting off → only admin votes count (weight=1), all others are ignored (weight=0)
    if (!enabled) return { weight: planName === 'admin' ? 1 : 0, planName };

    // Defaults match the rebalanced scheme set by the DB migration on first
    // boot (2026-04-27). If those settings keys exist (they will, post-
    // migration) the migration values win; the defaults below are only used
    // for a brand-new install or if an operator manually deleted the keys.
    const weights = {
      admin: parseFloat(this.db?.getSetting('feedbackWeightAdmin', '5')   || '5'),
      pro:   parseFloat(this.db?.getSetting('feedbackWeightPro',   '2.5') || '2.5'),
      test:  parseFloat(this.db?.getSetting('feedbackWeightTest',  '0.5') || '0.5'),
      free:  parseFloat(this.db?.getSetting('feedbackWeightFree',  '0.2') || '0.2'),
    };

    const weight = weights[planName] ?? 1;
    return { weight, planName };
  }

  // ── Telegram profile photos (used by dashboard avatar) ───────────────────

  /**
   * Fetch the user's latest Telegram profile photo and persist its file_id.
   * Silent on error - avatars are cosmetic and must never break login.
   *
   * @param {string|number} chatId   Telegram chat id / user id
   * @param {number}        userId   internal users.id (for UPDATE)
   * @param {object} [opts]
   * @param {boolean} [opts.force=false]  skip freshness check, always refresh
   * @returns {Promise<boolean>}  true if we stored a new avatar
   */
  async refreshUserAvatar(chatId, userId, opts = {}) {
    if (!this.bot || !userId) {
      this.logger?.debug?.(`[Avatar] skip refresh: bot=${!!this.bot} userId=${userId}`);
      return false;
    }
    try {
      // Always read the previously-stored unique_id so we can clean up stale
      // disk cache on change / removal.
      const prevRow = this.db.db.prepare(
        `SELECT avatar_checked_at, avatar_file_id, avatar_file_unique_id FROM users WHERE id = ?`
      ).get(userId);
      const prevUid = prevRow?.avatar_file_unique_id || null;

      // Freshness guard - refresh at most once every 6h unless forced
      if (!opts.force && prevRow?.avatar_checked_at) {
        const age = Date.now() - new Date(prevRow.avatar_checked_at).getTime();
        if (age < 6 * 3_600_000) {
          this.logger?.debug?.(`[Avatar] fresh (age=${Math.round(age/60000)}min, hasAvatar=${!!prevRow.avatar_file_id}), skip`);
          return false;
        }
      }

      this.logger?.info?.(`[Avatar] fetching for chat=${chatId} userId=${userId}`);
      const res = await this.bot.getUserProfilePhotos(chatId, { limit: 1 });
      const count = res?.total_count || 0;
      if (!count || !res?.photos?.[0]?.length) {
        this.logger?.info?.(`[Avatar] no photo for chat=${chatId} (total_count=${count}) - privacy or none`);
        this.db.setUserAvatar(userId, null, null);
        this._deleteAvatarFile(prevUid);
        return false;
      }
      // Largest size is the last element in the array (sorted by resolution)
      const sizes = res.photos[0];
      const best  = sizes[sizes.length - 1];
      const newUid = best.file_unique_id || null;

      this.db.setUserAvatar(userId, best.file_id, newUid);

      // Delete the old cached file if the unique_id actually changed
      if (prevUid && prevUid !== newUid) {
        this._deleteAvatarFile(prevUid);
      }

      this.logger?.info?.(`[Avatar] saved for chat=${chatId} file_id=${best.file_id?.substring(0,20)}... size=${best.width}x${best.height}${prevUid && prevUid !== newUid ? ' (replaced previous)' : ''}`);
      return true;
    } catch (e) {
      this.logger?.warn?.(`[Avatar] refresh failed for chat ${chatId}: ${e.message}`);
      return false;
    }
  }

  /**
   * Remove a cached avatar JPEG from disk by its file_unique_id.
   * Silent if the file doesn't exist. Guards against path traversal by
   * stripping anything that isn't a safe base64url-ish character.
   */
  _deleteAvatarFile(fileUniqueId) {
    if (!fileUniqueId) return;
    const safe = String(fileUniqueId).replace(/[^A-Za-z0-9_-]/g, '');
    if (!safe) return;
    const file = path.join(process.cwd(), 'data', 'avatars', `${safe}.jpg`);
    try {
      fs.unlinkSync(file);
      this.logger?.info?.(`[Avatar] deleted stale cache file ${safe}.jpg`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.logger?.warn?.(`[Avatar] failed to delete ${safe}.jpg: ${e.message}`);
      }
    }
  }

  // ── Reddit video + audio muxing ───────────────────────────────────────────
  // Reddit's v.redd.it serves DASH: `fallback_url` is video-only, audio is a
  // separate MP4 segment. We mux them with ffmpeg (stream-copy, no re-encode)
  // so alerts play with sound. If ffmpeg is missing or the video has no audio
  // track, caller falls back to the silent URL transparently.

  _redditVideoId(url) {
    const m = /v\.redd\.it\/([a-z0-9]+)/i.exec(url || '');
    return m ? m[1] : null;
  }

  /**
   * Probe known Reddit DASH audio paths, return the first that responds 200.
   * Ordered by current-to-legacy probability.
   */
  async _findRedditAudioUrl(videoUrl) {
    const m = /^(https:\/\/v\.redd\.it\/[a-z0-9]+)\//i.exec(videoUrl);
    if (!m) return null;
    const base = m[1];
    // Reddit switched video segments from DASH_* to CMAF_* in 2025.
    // Audio segments followed suit; keep legacy names as fallback so older
    // posts (still on DASH) continue to play with sound.
    const candidates = [
      `${base}/CMAF_AUDIO_128.mp4`,
      `${base}/CMAF_AUDIO_64.mp4`,
      `${base}/CMAF_audio.mp4`,
      `${base}/DASH_AUDIO_128.mp4`,
      `${base}/DASH_AUDIO_64.mp4`,
      `${base}/DASH_audio.mp4`,
      `${base}/audio`,
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const r = await fetch(u, { method: 'HEAD' });
        tried.push(`${u.split('/').pop()}=${r.status}`);
        if (r.ok) return u;
      } catch (e) {
        tried.push(`${u.split('/').pop()}=ERR`);
      }
    }
    this.logger?.warn?.(`[Video] no reddit audio found - tried [${tried.join(', ')}]`);
    return null;
  }

  /**
   * Mux a v.redd.it video with its audio track. Returns a local file path
   * ready for sendVideo multipart upload, or null if anything went wrong.
   * Results are cached under data/video-cache/<id>.mp4 and re-used.
   */
  async _muxRedditVideo(videoUrl) {
    const id = this._redditVideoId(videoUrl);
    if (!id) return null;

    const cacheDir = path.join(process.cwd(), 'data', 'video-cache');
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
    const outPath = path.join(cacheDir, `${id}.mp4`);

    // Cache hit - reuse
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return outPath;
    }

    const audioUrl = await this._findRedditAudioUrl(videoUrl);
    if (!audioUrl) {
      this.logger?.warn?.(`[Video] no audio track for reddit ${id} - silent fallback`);
      return null;
    }

    return new Promise((resolve) => {
      const args = [
        '-y',
        '-loglevel', 'error',
        '-i', videoUrl,
        '-i', audioUrl,
        '-c', 'copy',
        '-movflags', '+faststart',
        outPath,
      ];
      let stderr = '';
      let proc;
      try {
        proc = spawn('ffmpeg', args);
      } catch (e) {
        this.logger?.warn?.(`[Video] ffmpeg spawn failed: ${e.message}`);
        return resolve(null);
      }
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('error', (e) => {
        if (e.code === 'ENOENT') {
          this.logger?.warn?.(`[Video] ffmpeg not found in PATH - install it to enable Reddit audio`);
        } else {
          this.logger?.warn?.(`[Video] ffmpeg error: ${e.message}`);
        }
        resolve(null);
      });
      proc.on('exit', (code) => {
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          this.logger?.info?.(`[Video] muxed reddit ${id} (+audio, ${Math.round(fs.statSync(outPath).size / 1024)}KB)`);
          resolve(outPath);
        } else {
          this.logger?.warn?.(`[Video] ffmpeg failed (exit=${code}): ${stderr.slice(0, 200)}`);
          try { fs.unlinkSync(outPath); } catch {}
          resolve(null);
        }
      });
    });
  }

  /**
   * Remove cached muxed videos older than `maxAgeDays` (default 7).
   * Safe to call on startup / cron. No-op if cache dir missing.
   */
  cleanupVideoCache(maxAgeDays = 7) {
    const dir = path.join(process.cwd(), 'data', 'video-cache');
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let removed = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        try {
          if (fs.statSync(p).mtimeMs < cutoff) {
            fs.unlinkSync(p);
            removed++;
          }
        } catch {}
      }
      if (removed) this.logger?.info?.(`[Video] cleaned ${removed} stale video cache file(s)`);
    } catch {}
  }

  /**
   * Resolve a Telegram file_id to a full CDN URL.
   * Returned links live for ~1h on Telegram's side; do not persist them.
   */
  /**
   * Fetch a Telegram file by file_id and return its bytes + content-type.
   * Keeps the bot-token-embedded URL inside this module - callers never see
   * it, so a downstream `logger.error(e.message)` can't leak the token if
   * fetch throws on a network/DNS error.
   *
   * @returns {Promise<{ buffer: Buffer, contentType: string }|null>}
   */
  async fetchFile(fileId) {
    if (!this.bot || !fileId) return null;
    let filePath;
    try {
      const file = await this.bot.getFile(fileId);
      filePath = file?.file_path;
      if (!filePath) return null;
    } catch (e) {
      this.logger?.warn?.(`[Avatar] getFile failed: ${e.message}`);
      return null;
    }
    // URL is constructed and used purely inside this try block. Any error
    // from fetch goes through our own catch with a scrubbed message.
    const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
    try {
      const r = await fetch(url);
      if (!r.ok || !r.body) {
        this.logger?.warn?.(`[Avatar] CDN status ${r.status} for ${filePath}`);
        return null;
      }
      const buffer = Buffer.from(await r.arrayBuffer());
      const contentType = r.headers.get('content-type') || 'image/jpeg';
      return { buffer, contentType };
    } catch (e) {
      // Strip URL from message defensively - undici embeds the URL into
      // some error messages (DNS, abort, etc.). Keep just the error code.
      const safeMsg = String(e.code || e.name || 'fetch failed');
      this.logger?.warn?.(`[Avatar] CDN fetch failed: ${safeMsg}`);
      return null;
    }
  }

  /**
   * @deprecated since the secret-leak audit - prefer fetchFile() which keeps
   * the token inside this module. Kept for back-compat with any external
   * caller (none currently).
   */
  async getFileUrl(fileId) {
    if (!this.bot || !fileId) return null;
    try {
      const file = await this.bot.getFile(fileId);
      if (!file?.file_path) return null;
      return `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    } catch (e) {
      this.logger?.warn?.(`[Avatar] getFile failed: ${e.message}`);
      return null;
    }
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  async _editMessage(chatId, messageId, text, replyMarkup) {
    try {
      await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
        disable_web_page_preview: true,
      });
    } catch (e) {
      if (e.message?.includes('there is no text in the message to edit')) {
        try {
          await this.bot.deleteMessage(chatId, messageId).catch(() => {});
          await this.bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
            disable_web_page_preview: true,
          });
        } catch (innerErr) {
          this.logger.warn(`Failed to replace photo with text message: ${innerErr.message}`);
        }
        return;
      }
      
      // If message unchanged, ignore
      if (!e.message?.includes('message is not modified')) {
        this.logger.warn(`Edit message failed: ${e.message}`);
      }
    }
  }

  _setupPollingErrorHandler() {
    this.bot.on('polling_error', (err) => {
      if (err.code === 'ETELEGRAM' && err.message?.includes('409 Conflict')) return;
      if (err.code === 'EFATAL') return;
      this.logger.error(`Telegram polling error: ${err.message}`);
    });
  }

  /**
   * Resolve the bot's @username (without leading @).
   * Prefers config.telegram.botUsername, falls back to bot.getMe() and caches.
   * Returns '' if the bot is disabled or getMe() fails.
   */
  async getBotUsername() {
    const configured = (this.config?.telegram?.botUsername || '').replace(/^@/, '');
    if (configured) return configured;
    if (this._cachedBotUsername) return this._cachedBotUsername;
    if (!this.bot) return '';
    try {
      const me = await this.bot.getMe();
      this._cachedBotUsername = (me?.username || '').replace(/^@/, '');
      return this._cachedBotUsername;
    } catch (e) {
      this.logger.warn(`getBotUsername: bot.getMe() failed: ${e.message}`);
      return '';
    }
  }

  async stop() {
    if (this.bot) {
      try {
        await this.bot.stopPolling();
        this.logger.info('Telegram bot polling stopped');
      } catch (e) { /* ignore */ }
    }
  }

  _escHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

export default TelegramNotifier;
