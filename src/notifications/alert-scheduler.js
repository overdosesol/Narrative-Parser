/**
 * AlertScheduler — per-user FIFO cooldown queue for outgoing Telegram alerts.
 *
 * Why this exists (2026-05-10):
 *   alert-dispatcher used to call telegram.sendAlertToUser() in a tight loop —
 *   one user could receive 5 alerts per second, which both spammed the chat
 *   and made the bot feel like a batch processor instead of a live monitor.
 *   Scheduler enforces a per-user cooldown (60s default) so messages trickle
 *   in evenly, giving a "real-time scanner" UX.
 *
 * Behaviour:
 *   - Per-user FIFO queue. Different users do NOT block each other — chat A's
 *     queue progresses independently of chat B's.
 *   - Fast path on `enqueue()`: if the user is past their cooldown AND has an
 *     empty queue, the alert fires immediately (no tick wait). Cooldown is
 *     reset only after a real send. This keeps idle users feeling instant.
 *   - Slow path: enqueue with FIFO order. When tick fires AND cooldown has
 *     elapsed, pop oldest and run.
 *   - Cap (default 20): if queue is full at enqueue, drop oldest. Protects
 *     against runaway producers.
 *   - Max-age (default 30 min): items older than this are discarded on each
 *     tick — alert that waited 31 min is stale, send is worse than silence.
 *   - Pause: scheduler.dropQueue(chatId) wipes pending items. Defensive
 *     fallback in tick: if db.isUserPaused(chatId) returns true, queue is
 *     dropped on the spot (covers hot-path toggles).
 *   - All settings (cooldown / cap / max-age / enabled flag) are read fresh
 *     from db.getSetting() per tick / per enqueue, so admin changes apply
 *     without restart.
 *   - When `tgAlertCooldownEnabled === '0'`, scheduler becomes a transparent
 *     pass-through (every enqueue runs the task immediately). Bypass switch.
 *
 * NOT durable: queue lives in memory. On process restart all pending items
 * are lost. Acceptable trade-off — alerts are time-sensitive anyway, and the
 * next scan cycle (15-30 min) will re-evaluate any still-relevant trends.
 *
 * Manual-submit path (telegram.js _handleSendAlert) calls sendAlertToUser
 * directly and does NOT go through scheduler — those alerts are user-
 * triggered and must be instant.
 */

const DEFAULT_COOLDOWN_MS    = 60_000;     // 1 minute between alerts to same user
const DEFAULT_QUEUE_CAP      = 20;         // drop oldest beyond this
const DEFAULT_QUEUE_MAX_AGE  = 30 * 60_000; // 30 minutes — discard stale
const DEFAULT_TICK_MS        = 5_000;      // how often we wake up to process queues
const IDLE_CLEANUP_MS        = 5 * 60_000; // remove user state after 5 min idle

export class AlertScheduler {
  /**
   * @param {Object} args
   * @param {Object} [args.logger]  any logger with info/warn/debug/error
   * @param {Object} [args.db]      database wrapper (used for getSetting + isUserPaused)
   */
  constructor({ logger = null, db = null } = {}) {
    this.logger = logger;
    this.db     = db;

    /**
     * Map<chatIdString, {
     *   lastSentAt: number,
     *   queue: Array<{ task: () => Promise, queuedAt: number, label: string }>,
     * }>
     */
    this.queues = new Map();

    // Live settings — refreshed per tick / per enqueue from DB. Constructor
    // values are the fallback used before the first DB read.
    this.enabled       = true;
    this.cooldownMs    = DEFAULT_COOLDOWN_MS;
    this.cap           = DEFAULT_QUEUE_CAP;
    this.maxAgeMs      = DEFAULT_QUEUE_MAX_AGE;
    this.tickIntervalMs= DEFAULT_TICK_MS;

    this._tickHandle = null;
    this._running    = false;

    // Cumulative metrics — admin Pipeline page can show these. Cheap to
    // bump and consult.
    this.metrics = {
      enqueuedTotal:   0,
      sentTotal:       0,
      droppedFullTotal:0,
      droppedStaleTotal:0,
      droppedPausedTotal:0,
      taskErrors:      0,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────

  start() {
    if (this._tickHandle) return;
    this._readSettings();
    this._tickHandle = setInterval(() => this._tick(), this.tickIntervalMs);
    if (typeof this._tickHandle.unref === 'function') this._tickHandle.unref();
    this._running = true;
    this.logger?.info?.(
      `[AlertScheduler] started: cooldown=${this.cooldownMs}ms, cap=${this.cap}, ` +
      `maxAge=${this.maxAgeMs}ms, tick=${this.tickIntervalMs}ms, enabled=${this.enabled}`
    );
  }

  stop() {
    if (this._tickHandle) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
    this._running = false;
  }

  /**
   * Enqueue an outgoing alert for a chat. The `task` is an async function that
   * does the actual send + downstream DB work (recordNotification, attachXButton,
   * recordDecision, etc). Returns a status string for the caller to record.
   *
   * @param {string|number} chatId
   * @param {() => Promise<any>} task      — async send-and-followups function
   * @param {Object} [opts]
   * @param {string} [opts.label]          — short label for logging (e.g. trend title)
   * @returns {'sent'|'queued'|'dropped_full'|'bypass'} status
   */
  enqueue(chatId, task, opts = {}) {
    if (typeof task !== 'function') {
      this.logger?.warn?.('[AlertScheduler] enqueue called with non-function task');
      return 'dropped_full';
    }

    this._readSettings();

    // Bypass switch: scheduler disabled in admin → run immediately.
    if (!this.enabled) {
      this.metrics.enqueuedTotal++;
      this.metrics.sentTotal++;
      Promise.resolve(task()).catch(e => {
        this.metrics.taskErrors++;
        this.logger?.warn?.(`[AlertScheduler] (bypass) task threw: ${e.message}`);
      });
      return 'bypass';
    }

    const key = String(chatId);
    const state = this.queues.get(key) || { lastSentAt: 0, queue: [] };
    const now = Date.now();

    this.metrics.enqueuedTotal++;

    // Fast path: cooldown elapsed AND queue empty → fire immediately.
    if (state.queue.length === 0 && now - state.lastSentAt >= this.cooldownMs) {
      state.lastSentAt = now;
      this.queues.set(key, state);
      this.metrics.sentTotal++;
      Promise.resolve(task()).catch(e => {
        this.metrics.taskErrors++;
        this.logger?.warn?.(`[AlertScheduler] (fast) task threw: ${e.message}`);
      });
      return 'sent';
    }

    // Slow path: queue it. Cap enforcement drops oldest.
    if (state.queue.length >= this.cap) {
      state.queue.shift();
      this.metrics.droppedFullTotal++;
      this.logger?.warn?.(
        `[AlertScheduler] queue full for chat ${key} (cap=${this.cap}), dropped oldest`
      );
    }
    state.queue.push({
      task,
      queuedAt: now,
      label: String(opts.label || '').slice(0, 80),
    });
    this.queues.set(key, state);

    return 'queued';
  }

  /**
   * Wipe pending alerts for a chat. Called when user pauses their alerts
   * mid-flight (so they don't get a flood when they unpause — they don't,
   * scheduler discards now-irrelevant items).
   */
  dropQueue(chatId) {
    const key = String(chatId);
    const state = this.queues.get(key);
    if (!state) return 0;
    const dropped = state.queue.length;
    state.queue = [];
    if (dropped > 0) {
      this.metrics.droppedPausedTotal += dropped;
      this.logger?.info?.(`[AlertScheduler] dropped ${dropped} queued alert(s) for chat ${key}`);
    }
    return dropped;
  }

  /**
   * Snapshot for admin observability.
   */
  getStats() {
    const now = Date.now();
    const perUser = [];
    let totalQueued = 0;
    for (const [chatId, state] of this.queues.entries()) {
      const count = state.queue.length;
      if (count === 0) continue;
      const oldestAgeMs = now - state.queue[0].queuedAt;
      const cooldownLeftMs = Math.max(0, this.cooldownMs - (now - state.lastSentAt));
      perUser.push({ chatId, count, oldestAgeMs, cooldownLeftMs });
      totalQueued += count;
    }
    return {
      enabled:         this.enabled,
      cooldownMs:      this.cooldownMs,
      cap:             this.cap,
      maxAgeMs:        this.maxAgeMs,
      activeUsers:     perUser.length,
      totalQueued,
      perUser:         perUser.sort((a, b) => b.count - a.count).slice(0, 50),
      metrics:         { ...this.metrics },
      running:         this._running,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  _readSettings() {
    if (!this.db?.getSetting) return;
    try {
      const enabledRaw    = this.db.getSetting('tgAlertCooldownEnabled', '1');
      this.enabled        = String(enabledRaw) !== '0';
      const cd = parseInt(this.db.getSetting('tgAlertCooldownMs', String(DEFAULT_COOLDOWN_MS)), 10);
      if (Number.isFinite(cd) && cd >= 0) this.cooldownMs = cd;
      const cap = parseInt(this.db.getSetting('tgAlertQueueCap', String(DEFAULT_QUEUE_CAP)), 10);
      if (Number.isFinite(cap) && cap >= 1) this.cap = cap;
      const ma = parseInt(this.db.getSetting('tgAlertQueueMaxAgeMs', String(DEFAULT_QUEUE_MAX_AGE)), 10);
      if (Number.isFinite(ma) && ma >= 1000) this.maxAgeMs = ma;
    } catch (e) {
      this.logger?.warn?.(`[AlertScheduler] settings read failed: ${e.message}`);
    }
  }

  _isPaused(chatId) {
    if (!this.db) return false;
    try {
      // Prefer a dedicated helper if the DB wrapper exposes one — most callers
      // wire isUserPaused(chatId) to a single SELECT. Fallback: pull the row
      // ourselves through getUserByChatId (also common). Both are cheap.
      if (typeof this.db.isUserPausedByChatId === 'function') {
        return !!this.db.isUserPausedByChatId(chatId);
      }
      if (typeof this.db.getUserByChatId === 'function') {
        const row = this.db.getUserByChatId(chatId);
        return !!(row && row.alerts_paused);
      }
    } catch (_) { /* ignore — defensive */ }
    return false;
  }

  _tick() {
    this._readSettings();
    const now = Date.now();

    // If cooldown is fully disabled at admin level, nothing to do — items
    // never reach the queue path.
    if (!this.enabled) return;

    for (const [chatId, state] of this.queues.entries()) {
      // 1. Drop stale items older than maxAge.
      while (state.queue.length > 0 && now - state.queue[0].queuedAt > this.maxAgeMs) {
        const stale = state.queue.shift();
        this.metrics.droppedStaleTotal++;
        this.logger?.debug?.(
          `[AlertScheduler] dropped stale alert for chat ${chatId} ` +
          `(age=${Math.round((now - stale.queuedAt) / 1000)}s, label="${stale.label}")`
        );
      }

      // 2. If user just paused, wipe rest of their queue.
      if (state.queue.length > 0 && this._isPaused(chatId)) {
        const dropped = state.queue.length;
        state.queue = [];
        this.metrics.droppedPausedTotal += dropped;
        this.logger?.info?.(
          `[AlertScheduler] chat ${chatId} paused mid-queue, dropped ${dropped} alert(s)`
        );
        continue;
      }

      // 3. Idle cleanup — empty queue + cooldown long expired → forget user.
      if (state.queue.length === 0) {
        if (now - state.lastSentAt > IDLE_CLEANUP_MS) {
          this.queues.delete(chatId);
        }
        continue;
      }

      // 4. Cooldown gate.
      if (now - state.lastSentAt < this.cooldownMs) continue;

      // 5. Pop and fire. We update lastSentAt BEFORE running the task so a
      // slow send doesn't let a second tick pop another item for the same user.
      const item = state.queue.shift();
      state.lastSentAt = now;
      this.metrics.sentTotal++;
      Promise.resolve(item.task()).catch(e => {
        this.metrics.taskErrors++;
        this.logger?.warn?.(
          `[AlertScheduler] tick task threw for chat ${chatId} ("${item.label}"): ${e.message}`
        );
      });
    }
  }
}

export default AlertScheduler;
