import TelegramBot from 'node-telegram-bot-api';
import { randomBytes } from 'crypto';
import { formatTelegramAlert, formatTwitterResult } from './formatter.js';
import { getTranslations } from '../i18n/index.js';
import TwitterChecker from '../collectors/twitter-check.js';
import { UserRateLimiter } from '../utils/rate-limiter.js';

/**
 * Multi-user Telegram bot with inline keyboard management.
 * Each user has their own language, sources, threshold, and subscription.
 */
class TelegramNotifier {
  constructor(config, logger, db, solanaMonitor = null) {
    this.logger = logger;
    this.botToken = config.telegram.botToken;
    this.db = db;
    this.config = config;
    this.solanaMonitor = solanaMonitor; // injected after creation, or passed directly
    this.twitterChecker = new TwitterChecker(config, logger);
    this.enabled = !!this.botToken;
    // Rate limiter: max 30 interactions per user per minute
    this._rateLimiter = new UserRateLimiter({ windowMs: 60_000, maxRequests: 30 });

    if (!this.botToken) {
      this.logger.warn('Telegram bot token not set — Telegram alerts disabled');
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
      { command: 'start', description: 'Start the bot / register' },
      { command: 'menu',  description: 'Open settings menu' },
      { command: 'top',   description: 'Top-10 memecoin narratives (24h)' },
    ];

    // Keep command descriptions in English for all locales
    const ruCommands = enCommands;

    // Fire-and-forget — errors are non-critical
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
    // /start — register user & show welcome
    this.bot.onText(/^\/start/, (msg) => {
      const chatId = msg.chat.id;
      const username = msg.from?.username || null;
      const user = this.db.getOrCreateUser(chatId, username);
      const t = getTranslations(user.language);

      if (user.created_at === user.last_seen_at) {
        // New user
        this.bot.sendMessage(chatId, t.welcome, {
          parse_mode: 'HTML',
          reply_markup: this._startKeyboard(user),
        });
      } else {
        this.bot.sendMessage(chatId, t.welcomeBack(user.plan_name), {
          parse_mode: 'HTML',
          reply_markup: this._startKeyboard(user),
        });
      }
    });

    // /menu — show settings menu
    this.bot.onText(/^\/menu/, (msg) => {
      const chatId = msg.chat.id;
      const user = this.db.getOrCreateUser(chatId, msg.from?.username);
      const t = getTranslations(user.language);

      this.bot.sendMessage(chatId, t.menuTitle, {
        parse_mode: 'HTML',
        reply_markup: this._mainMenuKeyboard(user),
      });
    });

    // /top — show top trends
    this.bot.onText(/^\/top/, async (msg) => {
      const chatId = msg.chat.id;
      const user = this.db.getOrCreateUser(chatId, msg.from?.username);
      try {
        await this._handleTopCommand(chatId, user);
      } catch (err) {
        const t = getTranslations(user.language);
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
          await this._editMessage(chatId, query.message.message_id, t.thresholdTitle(user.alert_threshold), this._thresholdKeyboard(t));
          await this.bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('set_threshold:')) {
          const val = parseInt(data.split(':')[1], 10);
          this.db.updateUser(user.id, 'alert_threshold', val);
          user.alert_threshold = val;
          await this.bot.answerCallbackQuery(query.id, { text: t.thresholdSet(val) });
          await this._editMessage(chatId, query.message.message_id, t.menuTitle, this._mainMenuKeyboard(user));
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

        // ── Subscription ──────────────────────
        else if (data === 'subscription') {
          const expires = user.subscription_expires_at
            ? new Date(user.subscription_expires_at).toLocaleDateString()
            : null;
          const statusText = user.status === 'active' ? (user.language === 'ru' ? 'Активна' : 'Active') : (user.language === 'ru' ? 'Приостановлена' : 'Paused');
          const planDisplay = t[`plan${user.plan_name.charAt(0).toUpperCase() + user.plan_name.slice(1)}`] || user.plan_name;
          const msg = t.subscriptionTitle(planDisplay, statusText, expires);
          await this._editMessage(chatId, query.message.message_id, msg, this._subscriptionKeyboard(user, t));
          await this.bot.answerCallbackQuery(query.id);
        }

        // ── Upgrade ───────────────────────────
        else if (data === 'upgrade') {
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
          await this.bot.answerCallbackQuery(query.id);
          await this._handleTopCommand(chatId, user);
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

  _startKeyboard(user) {
    const t = getTranslations(user.language);
    return {
      inline_keyboard: [
        [{ text: t.btnOpenMenu || '⚙️ Open Menu', callback_data: 'menu' }],
      ],
    };
  }

  _mainMenuKeyboard(user) {
    const t = getTranslations(user.language);
    return {
      inline_keyboard: [
        [{ text: t.btnSources, callback_data: 'sources' }, { text: t.btnThreshold, callback_data: 'threshold' }],
        [{ text: t.btnLanguage, callback_data: 'language' }, { text: t.btnSubscription, callback_data: 'subscription' }],
        [{ text: t.btnTop, callback_data: 'top' }],
        [{ text: t.btnStartStop(user.status === 'paused'), callback_data: 'toggle_pause' }],
        [{ text: t.btnClose, callback_data: 'close' }],
      ]
    };
  }

  _sourcesKeyboard(user) {
    const t = getTranslations(user.language);
    const disabled = JSON.parse(user.disabled_sources || '[]');
    const allSources = ['reddit', 'google_trends', 'twitter', 'tiktok'];

    const buttons = allSources.map(src => {
      const enabled = !disabled.includes(src);
      const icon = enabled ? '\u{2705}' : '\u{274C}';
      const name = t.sourceNames[src] || src;
      return [{ text: `${icon} ${name}`, callback_data: `toggle_source:${src}` }];
    });

    buttons.push([{ text: t.btnBack, callback_data: 'menu' }]);
    return { inline_keyboard: buttons };
  }

  _languageKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '\u{1F1EC}\u{1F1E7} English', callback_data: 'set_lang:en' }, { text: '\u{1F1F7}\u{1F1FA} \u{0420}\u{0443}\u{0441}\u{0441}\u{043A}\u{0438}\u{0439}', callback_data: 'set_lang:ru' }],
        [{ text: '\u{25C0}\u{FE0F} Back / \u{041D}\u{0430}\u{0437}\u{0430}\u{0434}', callback_data: 'menu' }],
      ]
    };
  }

  _thresholdKeyboard(t) {
    return {
      inline_keyboard: [
        [{ text: t.thresholdLow, callback_data: 'set_threshold:40' }],
        [{ text: t.thresholdMedium, callback_data: 'set_threshold:60' }],
        [{ text: t.thresholdHigh, callback_data: 'set_threshold:80' }],
        [{ text: t.btnBack, callback_data: 'menu' }],
      ]
    };
  }

  _subscriptionKeyboard(user, t) {
    const buttons = [];
    buttons.push([{ text: t.btnUpgrade, callback_data: 'upgrade' }]);
    buttons.push([{ text: t.btnBack, callback_data: 'menu' }]);
    return { inline_keyboard: buttons };
  }

  _plansKeyboard(t) {
    return {
      inline_keyboard: [
        [{ text: t.planTest || 'Test Plan ($5 / 1 day)', callback_data: 'buy_plan:test' }],
        [{ text: t.planPro || 'Pro ($100 / 30 days)', callback_data: 'buy_plan:pro' }],
        [{ text: t.btnBack, callback_data: 'subscription' }],
      ]
    };
  }

  _paymentMethodKeyboard(planName, t) {
    return {
      inline_keyboard: [
        [{ text: t.btnPaySOL, callback_data: `pay:${planName}:SOL` }],
        [{ text: t.btnPayUSDC, callback_data: `pay:${planName}:USDC` }],
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

  async _handleTopCommand(chatId, user) {
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
        title: row.title,
        originalTitle: row.original_title,
        score: row.score,
        category: row.category,
        sentiment: row.sentiment,
        url: row.url,
        memePotential: metrics.memePotential || 0,
        tgMessageUrl: metrics.tgMessageUrl || null,
      };
    });

    const filtered = parsed.filter(tr => tr.category !== 'boring' && tr.category !== 'politics');
    filtered.sort((a, b) => b.memePotential - a.memePotential);
    const top = filtered.slice(0, 10);

    if (top.length === 0) {
      return this.bot.sendMessage(chatId, t.topEmpty, { parse_mode: 'HTML' });
    }

    let report = t.topTitle + '\n';
    top.forEach((tr, i) => {
      const safeTitle = this._escHtml(user.language === 'en' && tr.originalTitle ? tr.originalTitle : tr.title);
      const scoreIcon = tr.memePotential >= 90 ? '\u{1F525}\u{1F525}\u{1F525}' : tr.memePotential >= 75 ? '\u{1F525}\u{1F525}' : tr.memePotential >= 60 ? '\u{1F525}' : '\u{1F4CA}';

      report += `${i + 1}. ${scoreIcon} <b>${safeTitle}</b>\n`;
      report += `\u{1F48A} ${t.topPotential}: ${tr.memePotential}/100\n`;
      if (tr.tgMessageUrl) report += `\u{1F4E2} <a href="${tr.tgMessageUrl}">${t.topTgPost}</a> | `;
      if (tr.url) report += `\u{1F517} <a href="${tr.url}">${t.topSource}</a>\n`;
      report += '\n';
    });

    await this.bot.sendMessage(chatId, report, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  // ── Send alert to a specific user ─────────────────────────────────────────

  async sendAlertToUser(trend, user) {
    if (!this.enabled || !this.bot) return false;

    try {
      const t = getTranslations(user.language);
      const message = formatTelegramAlert(trend, user.language);
      const imageUrl = trend.metrics?.imageUrl;
      let sentMsg;

      if (imageUrl) {
        try {
          sentMsg = await this.bot.sendPhoto(user.telegram_chat_id, imageUrl, {
            caption: message,
            parse_mode: 'HTML',
          });
        } catch {
          sentMsg = await this.bot.sendMessage(user.telegram_chat_id, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false,
          });
        }
      } else {
        sentMsg = await this.bot.sendMessage(user.telegram_chat_id, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        });
      }

      const msgId = sentMsg.message_id;
      this.logger.info(`Alert sent to user ${user.telegram_chat_id}: "${trend.title}"`);
      return { messageId: msgId, chatId: user.telegram_chat_id };
    } catch (error) {
      if (error.response?.statusCode === 403) {
        // User blocked the bot — mark as suspended
        this.logger.warn(`User ${user.telegram_chat_id} blocked the bot — suspending`);
        this.db.updateUser(user.id, 'status', 'suspended');
      } else {
        this.logger.error(`Alert send failed for ${user.telegram_chat_id}: ${error.message}`);
      }
      return false;
    }
  }

  async attachXButton(chatId, messageId, dbId, userOrLang = 'en') {
    if (!this.bot || !messageId || !dbId) return;
    const lang = typeof userOrLang === 'string' ? userOrLang : (userOrLang?.language || 'en');
    const plan = typeof userOrLang === 'object' ? userOrLang?.plan_name : null;
    const t = getTranslations(lang);
    const isLocked = plan === 'test';
    const buttonText = isLocked ? (t.xAnalysisLockedBtn || '🔒 X Analysis (Locked)') : t.xAnalysisBtn;
    const callbackData = isLocked ? 'x_locked' : `x_analysis:${dbId}`;
    try {
      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: buttonText, callback_data: callbackData }]] },
        { chat_id: chatId, message_id: messageId }
      );
    } catch (e) {
      this.logger.warn(`Could not attach X button: ${e.message}`);
    }
  }

  // ── X Analysis ────────────────────────────────────────────────────────────

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

    const query = TwitterChecker.buildQuery(trend.original_title || trend.title);
    this.logger.info(`X Analysis for "${trend.title}" -> Query: "${query}"`);

    try {
      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: t.xAnalysisLoading, callback_data: 'noop' }]] },
        { chat_id: chatId, message_id: originalMsgId }
      ).catch(() => {});

      if (!query || query.trim().length < 2) {
        throw new Error(t.xAnalysisNoKeywords);
      }

      const result = await this.twitterChecker.searchNarrative(query);

      let reply;
      if (!result || result.tweetCount === 0) {
        reply = t.xAnalysisNone(this._escHtml(query));
      } else {
        reply = formatTwitterResult(result, query, user.language);
      }

      await this.bot.sendMessage(chatId, reply, {
        parse_mode: 'HTML',
        reply_to_message_id: originalMsgId,
        disable_web_page_preview: true,
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

  // ── Reactions feedback ────────────────────────────────────────────────────

  _setupReactions() {
    this.bot.on('message_reaction', (update) => {
      try {
        const msgId = update.message_id;
        const newReactions = update.new_reaction || [];
        const oldReactions = update.old_reaction || [];

        const added = newReactions.filter(r => !oldReactions.find(o => o.emoji === r.emoji));
        const removed = oldReactions.filter(r => !newReactions.find(n => n.emoji === r.emoji));

        const LIKED = ['\u{1F44D}', '\u{1F525}', '\u{2764}\u{FE0F}', '\u{1F929}', '\u{1F680}', '\u{26A1}'];
        const DISLIKED = ['\u{1F44E}', '\u{1F92E}', '\u{1F4A9}', '\u{1F914}'];

        for (const reaction of added) {
          let feedback = 0;
          if (LIKED.includes(reaction.emoji)) feedback = +1;
          else if (DISLIKED.includes(reaction.emoji)) feedback = -1;
          if (feedback !== 0) {
            const trend = this.db?.getTrendByTgMessageId(msgId);
            if (trend) {
              this.db.recordFeedback(trend.id, feedback);
              this.logger.info(`Feedback ${feedback > 0 ? '+1' : '-1'} for "${trend.title}"`);
            }
          }
        }

        for (const reaction of removed) {
          let feedback = 0;
          if (LIKED.includes(reaction.emoji)) feedback = -1;
          else if (DISLIKED.includes(reaction.emoji)) feedback = +1;
          if (feedback !== 0) {
            const trend = this.db?.getTrendByTgMessageId(msgId);
            if (trend) {
              this.db.recordFeedback(trend.id, feedback);
            }
          }
        }
      } catch (err) {
        this.logger.error(`Reaction processing error: ${err.message}`);
      }
    });
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
