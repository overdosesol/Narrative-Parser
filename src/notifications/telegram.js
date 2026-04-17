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
    // State: users awaiting a text input (e.g. custom threshold)
    // Map<chatId, { type: 'threshold' }>
    this._awaitingInput = new Map();

    if (!this.botToken) {
      this.logger.warn('Telegram bot token not set — Telegram alerts disabled');
      return;
    }

    try {
      this.bot = new TelegramBot(this.botToken, {
        polling: {
          params: {
            allowed_updates: ['message', 'callback_query', 'message_reaction', 'pre_checkout_query'],
          }
        }
      });
      this.logger.info('Telegram Bot initialized (multi-user mode)');
      this._registerBotCommands();
      this._setupCommands();
      this._setupCallbacks();
      this._setupReactions();
      this._setupStarsPayments();
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

    // Free-text handler — processes awaited inputs (e.g. custom threshold)
    // Must be registered before /top so it fires on plain number messages
    this.bot.on('message', async (msg) => {
      const chatId = String(msg.chat.id);
      const text = msg.text || '';
      // Ignore commands
      if (text.startsWith('/')) return;

      const state = this._awaitingInput.get(chatId);
      if (!state) return;

      const user = this.db.getOrCreateUser(msg.chat.id, msg.from?.username);
      const t = getTranslations(user.language);

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
    });

    // /top — show count selector first, then top trends
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
          if (currency === 'STARS') {
            await this.bot.answerCallbackQuery(query.id);
            await this._handleStarsPayment(chatId, query.message.message_id, user, planName, t);
          } else {
            await this._handlePayment(chatId, query.message.message_id, user, planName, currency, t);
            await this.bot.answerCallbackQuery(query.id);
          }
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
        [{ text: t.thresholdLow,    callback_data: 'set_threshold:52' }],
        [{ text: t.thresholdMedium, callback_data: 'set_threshold:67' }],
        [{ text: t.thresholdHigh,   callback_data: 'set_threshold:75' }],
        [{ text: t.thresholdCustomBtn || '\u270F\uFE0F Custom', callback_data: 'threshold_custom' }],
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
    const starsAmount = planName === 'test'
      ? (this.config.telegram?.starsTestPrice || 250)
      : (this.config.telegram?.starsProPrice  || 5000);
    return {
      inline_keyboard: [
        [{ text: t.btnPayStars(starsAmount), callback_data: `pay:${planName}:STARS` }],
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

  // ── Telegram Stars payment ────────────────────────────────────────────────

  async _handleStarsPayment(chatId, messageId, user, planName, t) {
    const starsAmount = planName === 'test'
      ? (this.config.telegram?.starsTestPrice || 250)
      : (this.config.telegram?.starsProPrice  || 5000);

    const planLabel   = planName === 'test' ? 'Test Plan' : 'Pro Plan';
    const durationDays = planName === 'test' ? 1 : 30;

    const reference = this._generateReference();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    this.db.createPayment(user.id, planName, starsAmount, 'STARS', reference, expiresAt);

    const title = t.starsInvoiceTitle ? t.starsInvoiceTitle(planLabel) : 'TrendScout — ' + planLabel;
    const desc  = t.starsInvoiceDesc  ? t.starsInvoiceDesc(planLabel)  : planLabel + ' access';

    try {
      await this.bot.sendInvoice(
        chatId,
        title,
        desc,
        reference,          // payload — used to match payment on success
        '',                 // provider_token: empty string for Stars (no external provider)
        'XTR',              // currency for Telegram Stars
        [{ label: planLabel, amount: starsAmount }]
      );
    } catch (err) {
      this.logger.error(`Stars invoice failed for user ${chatId}: ${err.message}`);
      await this.bot.sendMessage(chatId, '\u274C Failed to create Stars invoice. Please try SOL/USDC.', {
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  }

  /**
   * Handle Telegram Stars pre_checkout_query and successful_payment.
   * pre_checkout_query must be answered within 10 seconds.
   * successful_payment arrives as a message with message.successful_payment.
   */
  _setupStarsPayments() {
    // Step 1: approve every pre-checkout (validation happens at invoice creation time)
    this.bot.on('pre_checkout_query', async (query) => {
      try {
        await this.bot.answerPreCheckoutQuery(query.id, true);
        this.logger.info(`[Stars] pre_checkout approved: payload=${query.invoice_payload}`);
      } catch (err) {
        this.logger.error(`[Stars] pre_checkout answer failed: ${err.message}`);
      }
    });

    // Step 2: on successful payment → confirm in DB and upgrade plan
    this.bot.on('message', async (msg) => {
      if (!msg.successful_payment) return;

      const payment    = msg.successful_payment;
      const reference  = payment.invoice_payload;
      const chargeId   = payment.telegram_payment_charge_id;
      const chatId     = msg.chat.id;

      try {
        // Look up pending payment to determine plan and duration
        const pending = this.db.db.prepare(
          `SELECT plan_name FROM payments WHERE reference = ? AND status = 'pending'`
        ).get(reference);
        const durationDays = pending?.plan_name === 'test' ? 1 : 30;

        const confirmed = this.db.confirmPaymentAndUpgrade(reference, chargeId, durationDays);
        if (!confirmed) {
          this.logger.warn(`[Stars] Payment ${reference} not found or already confirmed`);
          return;
        }

        const user = this.db.getOrCreateUser(chatId, msg.from?.username);
        const t    = getTranslations(user.language);
        const planDisplay = t[`plan${confirmed.plan_name.charAt(0).toUpperCase() + confirmed.plan_name.slice(1)}`] || confirmed.plan_name;

        await this.bot.sendMessage(chatId, t.paymentConfirmed(planDisplay), {
          parse_mode: 'HTML',
          reply_markup: this._mainMenuKeyboard(user),
        });

        this.logger.info(`[Stars] Plan ${confirmed.plan_name} activated for user ${chatId} (charge: ${chargeId})`);
      } catch (err) {
        this.logger.error(`[Stars] successful_payment processing error: ${err.message}`);
      }
    });
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
        whyItWillPump: metrics.whyItWillPump || null,
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
      const lifeLbl = tr.predictedLifespan ? lifeIcon(tr.predictedLifespan) : '';

      report += '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
      // Number + title
      report += `<b>${i + 1}. ${title}</b>\n`;
      // Score bar + category + lifespan
      report += `<code>${scoreBar(tr.memePotential)}</code>  ${catIco}`;
      if (lifeLbl) report += '  ' + lifeLbl;
      report += '\n';
      // Pitch line if available
      if (tr.whyItWillPump) {
        report += `\u{1F4A1} <i>${this._escHtml(tr.whyItWillPump)}</i>\n`;
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

  /**
   * Attach all alert buttons: X Analysis + 👍/👎 feedback.
   * Replaces the old attachXButton (kept as alias for compatibility).
   */
  async attachAlertButtons(chatId, messageId, dbId, userOrLang = 'en') {
    if (!this.bot || !messageId || !dbId) return;
    const lang = typeof userOrLang === 'string' ? userOrLang : (userOrLang?.language || 'en');
    const plan = typeof userOrLang === 'object' ? userOrLang?.plan_name : null;
    const t = getTranslations(lang);
    const isLocked = plan === 'test';
    const xText = isLocked ? (t.xAnalysisLockedBtn || '\u{1F512} X Analysis') : t.xAnalysisBtn;
    const xData = isLocked ? 'x_locked' : `x_analysis:${dbId}`;
    try {
      await this.bot.editMessageReplyMarkup(
        {
          inline_keyboard: [
            [{ text: xText, callback_data: xData }],
            [
              { text: '\u{1F44D}', callback_data: `feedback:1:${dbId}` },
              { text: '\u{1F44E}', callback_data: `feedback:-1:${dbId}` },
            ],
          ],
        },
        { chat_id: chatId, message_id: messageId }
      );
    } catch (e) {
      this.logger.warn(`Could not attach alert buttons: ${e.message}`);
    }
  }

  /** Backward-compat alias */
  async attachXButton(chatId, messageId, dbId, userOrLang = 'en') {
    return this.attachAlertButtons(chatId, messageId, dbId, userOrLang);
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
    // Only 👍 and 👎 are treated as feedback signals.
    // All other emojis are intentionally ignored.
    const LIKED    = ['\u{1F44D}']; // 👍
    const DISLIKED = ['\u{1F44E}']; // 👎

    this.bot.on('message_reaction', (update) => {
      try {
        const msgId = update.message_id;
        const newReactions = update.new_reaction || [];
        const oldReactions = update.old_reaction || [];

        // Identify the reactor — available in private chats / non-anon group reactions
        const reactorChatId = String(update.user?.id || update.actor_chat?.id || '');
        if (!reactorChatId) return; // anonymous reaction — skip

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
    } catch (_) { /* user not found — default to free */ }

    // Weighting off → only admin votes count (weight=1), all others are ignored (weight=0)
    if (!enabled) return { weight: planName === 'admin' ? 1 : 0, planName };

    const weights = {
      admin: parseFloat(this.db?.getSetting('feedbackWeightAdmin', '3') || '3'),
      pro:   parseFloat(this.db?.getSetting('feedbackWeightPro',   '2') || '2'),
      test:  parseFloat(this.db?.getSetting('feedbackWeightTest',  '1') || '1'),
      free:  parseFloat(this.db?.getSetting('feedbackWeightFree',  '1') || '1'),
    };

    const weight = weights[planName] ?? 1;
    return { weight, planName };
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
