/**
 * Catalyst Support Bot — separate Telegram bot dedicated to user support.
 *
 * Architecture: forum-topics relay.
 *   1. Each user who messages the support bot gets their own forum topic
 *      created in a private admin group (config.support.groupId).
 *   2. User → admin   : message is copied into that user's topic.
 *   3. Admin → user   : a message posted in any topic is copied back to
 *      the matching user's chat with the bot.
 *
 * Setup checklist (lives in .env.example, repeated here for ops parity):
 *   • @BotFather → /mybots → support bot → Bot Settings → Group Privacy: OFF
 *     (otherwise the bot will not see admin replies inside topics)
 *   • Create a private group, enable Topics in its settings
 *   • Add the support bot as admin with "Manage Topics" permission
 *   • Put the group's chat_id into SUPPORT_GROUP_ID (negative number)
 *
 * Disabled gracefully when SUPPORT_BOT_TOKEN or SUPPORT_GROUP_ID is missing —
 * main bot continues to work, the support flow simply isn't wired.
 */

import TelegramBot from 'node-telegram-bot-api';

export default class SupportBot {
  constructor(config, logger, db) {
    this.config = config;
    this.logger = logger;
    this.db = db;
    this.token = config.support?.botToken || '';
    this.groupId = config.support?.groupId || '';
    this.username = (config.support?.botUsername || '').replace(/^@/, '');
    this.enabled = !!(this.token && this.groupId);
    this.bot = null;

    // Per-chat lock so two messages arriving in close succession from the
    // same user do not race on createForumTopic — the second one would hit
    // a "topic already exists" race or, worse, create a duplicate topic.
    this._creatingTopic = new Map();
  }

  start() {
    if (!this.enabled) {
      if (this.token && !this.groupId) {
        this.logger.warn('Support bot: SUPPORT_GROUP_ID missing — disabled');
      } else if (!this.token) {
        this.logger.info('Support bot: SUPPORT_BOT_TOKEN not set — skipping');
      }
      return;
    }

    try {
      this.bot = new TelegramBot(this.token, {
        polling: { params: { allowed_updates: ['message'] } },
      });
      this.logger.info(`Support bot started (group=${this.groupId})`);

      // Resolve username once so we can log it & expose deep-link.
      this.bot.getMe().then(me => {
        this.username = me.username;
        this.logger.info(`Support bot: @${me.username} ready, t.me/${me.username}`);
      }).catch(e => this.logger.warn(`Support bot getMe failed: ${e.message}`));

      this._setupHandlers();
      this._setupErrorHandler();
    } catch (e) {
      this.logger.error(`Support bot startup failed: ${e.message}`);
    }
  }

  _setupHandlers() {
    // Single message handler covers both relay directions. Branch on whether
    // the message arrived in the admin group (downward) or anywhere else
    // (upward — DM from a user).
    this.bot.on('message', async (msg) => {
      try {
        const chat = msg.chat || {};
        const from = msg.from || {};
        if (from.is_bot) return;  // ignore other bots & ourselves
        if (!chat.id) return;

        const isAdminGroup = String(chat.id) === String(this.groupId);
        if (isAdminGroup) {
          await this._handleAdminMessage(msg);
        } else if (chat.type === 'private') {
          await this._handleUserMessage(msg);
        }
        // group/supergroup messages outside the admin group: ignore
      } catch (e) {
        this.logger.error(`Support bot handler error: ${e.message}`);
      }
    });
  }

  // ── Language resolution ────────────────────────────────────────────────
  // chat_id in Telegram is identical across all bots a user interacts with,
  // so we can pick up their preference saved by the main bot in `users.language`.
  // Falls back to Telegram UI lang_code, then to 'en'.
  _resolveLang(chatId, fromUser) {
    try {
      const u = this.db?.getUserByChatId?.(chatId);
      if (u && u.language) return u.language;
    } catch { /* DB miss is fine, fall through */ }
    const code = (fromUser?.language_code || 'en').slice(0, 2).toLowerCase();
    return code === 'ru' ? 'ru' : 'en';
  }

  // ── Upward: user → admin topic ──────────────────────────────────────────
  async _handleUserMessage(msg) {
    const chatId = String(msg.chat.id);
    const username = msg.from?.username || msg.from?.first_name || 'anonymous';

    // Welcome on /start — short, just confirms the relay is live.
    if (msg.text && msg.text.trim().startsWith('/start')) {
      const ru = this._resolveLang(chatId, msg.from) === 'ru';
      await this.bot.sendMessage(chatId, ru
        ? '👋 Это поддержка <b>Catalyst</b>.\n\nОпиши проблему или вопрос — мы ответим как только увидим. Можно прикреплять скриншоты, видео, ссылки.'
        : '👋 You are talking to <b>Catalyst</b> support.\n\nDescribe your issue or question — we will reply as soon as we see it. Feel free to attach screenshots, videos, or links.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const topicId = await this._ensureTopic(chatId, username, msg.from);
    if (!topicId) return;  // create failed; error already logged

    // copyMessage preserves media without the "Forwarded from" header,
    // which keeps the topic clean. Reply target is the topic root.
    await this.bot.copyMessage(this.groupId, chatId, msg.message_id, {
      message_thread_id: topicId,
    }).catch(e => this.logger.warn(`copyMessage user→topic failed: ${e.message}`));

    this.db.touchSupportThread(chatId);
  }

  // ── Downward: admin reply in topic → user ───────────────────────────────
  async _handleAdminMessage(msg) {
    // Bot's own posts (topic creation, system messages) carry no from.is_bot
    // == false guard already, but topic_created service messages should also
    // be skipped — they have no `text` and arrive with `forum_topic_created`.
    if (msg.forum_topic_created || msg.forum_topic_closed || msg.forum_topic_reopened) return;

    const topicId = msg.message_thread_id;
    if (!topicId) return;  // someone posted in General — ignore

    const thread = this.db.getSupportThreadByTopic(topicId, this.groupId);
    if (!thread) {
      // Admin typed in a topic we don't recognize — could be a manual topic
      // they made, or one created before this DB existed. Don't auto-relay.
      return;
    }

    await this.bot.copyMessage(thread.chat_id, this.groupId, msg.message_id)
      .catch(e => this.logger.warn(`copyMessage topic→user failed: ${e.message}`));

    this.db.touchSupportThread(thread.chat_id);
  }

  // ── Topic resolution / creation ─────────────────────────────────────────
  async _ensureTopic(chatId, username, fromUser) {
    const existing = this.db.getSupportThreadByChat(chatId);
    if (existing) return existing.topic_id;

    // Coalesce concurrent creations from the same chat so two fast messages
    // don't both call createForumTopic.
    if (this._creatingTopic.has(chatId)) return this._creatingTopic.get(chatId);

    const promise = (async () => {
      try {
        const name = this._buildTopicName(username, fromUser);
        const created = await this.bot.createForumTopic(this.groupId, name);
        const topicId = created.message_thread_id;
        this.db.createSupportThread(chatId, topicId, this.groupId, username);

        // Pin a header in the new topic with full user metadata so the admin
        // has all relevant identifiers without scrolling.
        const header = this._buildHeader(chatId, fromUser);
        await this.bot.sendMessage(this.groupId, header, {
          message_thread_id: topicId,
          parse_mode: 'HTML',
          disable_notification: true,
        }).catch(() => {});

        this.logger.info(`Support: created topic ${topicId} for chat ${chatId} (@${username})`);
        return topicId;
      } catch (e) {
        this.logger.error(`createForumTopic failed for chat ${chatId}: ${e.message}`);
        return null;
      } finally {
        this._creatingTopic.delete(chatId);
      }
    })();

    this._creatingTopic.set(chatId, promise);
    return promise;
  }

  _buildTopicName(username, fromUser) {
    const handle = username && username !== 'anonymous'
      ? `@${username}`
      : (fromUser?.first_name || 'user');
    // Telegram caps topic name at 128 chars; we stay well under that.
    return handle.slice(0, 60);
  }

  _buildHeader(chatId, fromUser) {
    const lines = [];
    lines.push('🎫 <b>New support thread</b>');
    if (fromUser?.username) lines.push(`👤 @${fromUser.username}`);
    if (fromUser?.first_name || fromUser?.last_name) {
      const name = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ');
      lines.push(`📝 ${this._escape(name)}`);
    }
    lines.push(`🆔 chat_id: <code>${chatId}</code>`);
    if (fromUser?.language_code) lines.push(`🌐 lang: ${fromUser.language_code}`);
    lines.push('');
    lines.push('<i>Reply in this topic — your message will be delivered to the user.</i>');
    return lines.join('\n');
  }

  _escape(s) {
    return String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  }

  _setupErrorHandler() {
    this.bot.on('polling_error', (err) => {
      const msg = err?.message || String(err);
      if (/EFATAL|ETELEGRAM/i.test(msg)) {
        this.logger.warn(`Support bot polling error: ${msg}`);
      }
    });
  }
}
