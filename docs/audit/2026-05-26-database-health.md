# Database health audit — 2026-05-26

**Scope**: пятый этап. Здоровье БД: schema, migrations, индексы, retention, backup integrity, SQLite-specific gotchas, lock contention, future scaling. **Не покрыто** (другие этапы): security (1 done), pipeline (2 done), billing (3 done), cost (4 done), UX (6), admin UI (7), TG delivery (8), nginx/Docker (9).

**Method**: 9 параллельных агентов (sonnet для schema integrity / transactions, haiku для остальных) + schema-map самосбор. Один subagent (transactions) запросил Bash на первой попытке — retry'нул с явной Read/Grep инструкцией.

**WARNING**: этот audit вернул **4 critical** finding'а в одной секции (backup integrity). Top-3 worst — все critical. Рекомендую отнестись к этому отчёту в первую очередь.

---

## Schema map

**16 tables total** — `src/db/schema.sql` имеет 7, остальные 9 inline в `database.js` (schema-split issue сам по себе).

| Категория | Table | Indexes | FK declared / enforced? | Steady-state rows | Retention |
|---|---|---|---|---|---|
| **Core data** | `trends` | 5 (title, source, first_seen_at, external_id, tg_message_id) | none | 13K rows/7d cap | 30d emergency cleanup |
| | `raw_metrics` | JSON blob inside trends.raw_metrics | n/a | n/a | via trends TTL |
| **User data** | `users` | 1 (chat_id) | plans(id) declared / **NOT enforced** | <1K | forever |
| | `user_favorites` | 2 (chat_id+created_at, trend_id) | trends(id) / NOT enforced | ~2.5K | forever (by design) |
| | `hidden_trends` | 2 (chat_id, hidden_at) | trends(id) / NOT enforced | ~5K (7d rolling) | **7d scheduled** |
| | `feedback_votes` | 2 (trend_id, chat_id) | trends(id) / NOT enforced | ~2K | **NEVER (unbounded)** |
| **Delivery** | `notifications` | 2 (trend_id), (user_id) — NO compound, NO UNIQUE | trends, users / NOT enforced | **3M/year @ 100u** | **emergency only** |
| | `broadcasts` | 1 (created_at) | — | <100 | forever |
| | `broadcast_deliveries` | 2 + UNIQUE(broadcast_id, user_id) | broadcasts (CASCADE), users — **CASCADE silently broken** without FK ON | ~10K-100K | forever |
| **Billing** | `plans` | implicit UNIQUE on name | — | 4 static | forever |
| | `payments` | 3 + UNIQUE partial on tx_signature | users(id) / NOT enforced | <100 | 30d expired/confirmed cleanup |
| | `auth_sessions` | 2 (token, chat_id) | — | 100-1K | **one-time on boot (orphans accumulate)** |
| **History/audit** | `alert_score_history` | 1 (trend_id, ts) | trends ON DELETE CASCADE / **CASCADE broken** | ~30K | 30d scheduled |
| | `x_analysis_history` | 1 (trend_id, at DESC) | trends(id) / NOT enforced | ~10K | **NEVER** |
| | `tag_refresh_history` | 1 (ts DESC) | — | ~75/month | **NEVER** |
| **System** | `support_threads` | 1 (topic_id, group_id) | — | <100 | **NEVER** |
| | `stage1_examples` | 1 (kind, sort_order) | — | <1K | forever |
| | `settings` | UNIQUE(key) | — | ~20 keys (with blobs up to ~50KB) | forever |

**Growth projection** (year-by-year, dominated by `notifications`):

| Period | Users | Total DB | Risk |
|---|---|---|---|
| Y1 Q4 | 100 | ~1.2GB | ✅ safe |
| Y2 Q2 | 300 | ~3.5GB | ⚠️ monitor |
| Y3 Q1 | 1000 | ~11.5GB (notifications=6GB) | 🔴 action |

---

## Hot query paths

Top-10 hot SELECT с index status:

| Query | Frequency | Index status |
|---|---|---|
| `getUserByAuthToken(token)` | per authed request | ✓ `idx_auth_token` point lookup |
| `getUserByChatId(chatId)` | per TG message | ✓ `idx_users_chat_id` |
| `_handleTrends` main feed `WHERE last_seen_at > ? ORDER BY score` | per /api/trends | **⚠ missing `idx_trends_last_seen_at`** + `idx_trends_first_seen` partial помощь |
| `_handleStats` GROUP BY source/category | per /api/stats | ⚠ table scan, acceptable at 13K rows |
| `wasNotificationSentToUser(trendId, userId)` | per alert × per user | **⚠ missing compound `(trend_id, user_id, channel)`** + no UNIQUE → PIPE-006 race |
| `isTrendSeen(externalId)` | per collected trend | ✓ `idx_trends_external_id` |
| `saveTrend()` UPSERT lookup by url | per scan-cycle save | **⚠ missing `idx_trends_url`** → table scan |
| `getHotTrendsForRefresh()` | every 12h heavy refresh | ✓ `idx_trends_first_seen` |
| `_handleSources` count per source | per /api/sources | ✓ `idx_trends_source` |
| `getFavoritesByChat(chatId)` | per /api/favorites | ✓ `idx_user_favorites_chat_id` |

---

## Summary

**Counts**: **4 critical** · 11 high · 10 medium · 7 low · 5 info · **37 findings total** + 3 spec drift items + multiple cross-audit overlaps extended.

**Эту аудиторскую сессию надо открывать сразу с backup-секции** — там 4 critical finding'а, которые делают весь production посгубишь-критичным. SESSION_CONTEXT декларирует один backup contract, реальный `scripts/backup.sh` имплементирует другой (`cp` вместо `sqlite3 .backup`, нет gzip integrity, B2 off-site **отсутствует целиком**, restore drill никогда не делался). Если VPS пропадёт сегодня — мы не знаем что у нас в backup и работает ли он. Это самый болезненный gap всех 5 этапов.

База держится: WAL mode правильно set, AUTOINCREMENT overhead acceptable, chat_id TEXT affinity безопасно конвертируется через `String(chatId)`, существующие transactions (normalizePlans, confirmPaymentAndUpgrade, cleanupAlerts) корректно atomic, payment tx_signature UNIQUE защищает от double-credit, addIfMissing migration pattern idempotent через `PRAGMA table_info`. Existing indexes для point-lookups (auth_token, chat_id, external_id, reference) — оптимальны.

Слабые места — **schema integrity** (FK=OFF означает CASCADE silently broken, orphan rows на retention sweep), **transactions** (3 hot save loops в scan-cycle без батчинг = N×fsync ~50× slowdown, busy_timeout=0 → random SQLITE_BUSY на concurrent writes), **retention coverage** (4 unbounded tables + 2 one-time-only cleanups + log files без rotation), **timestamps trap** (3 hot path функции с raw `toISOString()` → silent empty result на small window queries). И, самое тяжёлое — **backup integrity** (4 critical).

**Top-3 worst** (все critical, все из backup):

1. **DB-001** — `scripts/backup.sh` использует `cp` вместо `sqlite3 .backup`. Hot backup non-locking-aware → file может быть corrupt под нагрузкой scan-cycle (writer активен).
2. **DB-002** — нет `gzip -t` validation. Backup может быть corrupt годами, узнаём при restore (никогда).
3. **DB-003** — rclone+B2 off-site copy задокументирован в SESSION_CONTEXT, но `scripts/backup.sh` его **не вызывает**. Только local backup, VPS dies = full data loss.

---

## Findings

### [DB-001] Backup использует `cp`, не `sqlite3 .backup` — severity: **critical**

* **Where**: `scripts/backup.sh:13`
* **What**: `cp "$DB_PATH" "$BACKUP_DIR/catalyst_$BACKUP_DATE.db"`. SESSION_CONTEXT § Production posture **прямо** говорит `sqlite3 .backup (locking-aware)`. Если SQLite пишет в момент копирования (scan-cycle, dashboard writes, alert dispatch) — копия captures partial WAL state → corrupt file silently.
* **Risk**: silent corruption of all backups. WAL mode частично mitigates (snapshot consistent until WAL checkpoint), но **под нагрузкой** + `cp` может ловить mid-transaction = corrupt. Detection — только при restore.
* **Repro**: запустить `cp` во время активной transaction. Resulting file `.db-shm`/`.db-wal` partial → SQLite restore fails или возвращает inconsistent state.
* **Fix**: переписать на `sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/catalyst_$BACKUP_DATE.db'"`. Это locking-aware hot snapshot, blocks writers только на ~миллисекунды на checkpoint. ⚠ assumes: agent verified `scripts/backup.sh:13` exists с `cp`.

---

### [DB-002] Нет `gzip -t` integrity check — severity: **critical**

* **Where**: `scripts/backup.sh` (нет post-gzip validation)
* **What**: после `gzip` нет `gzip -t backup.db.gz` для verify что compressed файл валидный. Disk error mid-compress → truncated/corrupt output, exit 0 нормальный.
* **Risk**: silent corruption на gzip step (в дополнение к DB-001 corruption на `cp` step). Backup файл присутствует, размер plausible, но не разворачивается.
* **Fix**: после gzip вызывать `if ! gzip -t "$BACKUP_FILE.gz"; then echo "BACKUP FAILED gzip -t check"; exit 1; fi`. Three lines.

---

### [DB-003] rclone+B2 off-site copy документирован, но НЕ имплементирован — severity: **critical**

* **Where**: `scripts/backup.sh` (нет rclone calls), `SESSION_CONTEXT.md:746` (декларирует «rclone copy → B2»)
* **What**: SESSION_CONTEXT обещает off-site backup на B2 через `rclone copy` с lifecycle hide+delete 30+1d. Реальный script делает только local gzip → `/var/backups/catalyst/` и `find ... -mtime +30 -delete`. Никакого rclone в коде. ⚠ assumes: agent сверил отсутствие rclone calls — лично script не читал.
* **Risk**: VPS pешит (disk fail, hetzner billing dispute, accidentally rm -rf /var) → все backups теряются вместе с DB. Single point of failure. Это **самый болезненный gap** всех 5 этапов аудита — мы decларируем resilience которой нет.
* **Fix**: либо имплементировать rclone (config + script step + error handling + log) либо **обновить SESSION_CONTEXT** что off-site **не работает** и это known operational debt. Predпочтительно имплементировать — B2 lifecycle уже на bucket side (по spec), нужно только добавить `rclone copy "$BACKUP_FILE.gz" b2:catalystparser-prod-backups/` после gzip integrity check.

---

### [DB-004] Restore procedure не задокументирована и никогда не тестировалась — severity: **critical**

* **Where**: `DEPLOY.md` (no restore steps), отсутствие entry'й о restore drill в WORKLOG/ARCHIVE.
* **What**: Backup pipeline (даже если работает) бесполезен если оператор не знает как restore'ить. Текущий DEPLOY.md описывает создание backup'а, не recovery. Restore drill never executed.
* **Risk**: при необходимости recover (corrupt DB, accidental DELETE, migration gone wrong) оператор должен на ходу выяснять команды + проверять что backup actually валидный. Time-to-recovery measured in hours при stress. Worse: silent backup corruption (DB-001+DB-002) обнаруживается только при первом restore — slишком поздно.
* **Fix**: 
  1. Добавить `DEPLOY.md § 11.5 Restore from backup` step-by-step.
  2. Запланировать **quarterly restore drill**: разворачивать latest backup в test container, проверить что schema integrity OK, app starts, key queries return data. Записывать в WORKLOG.
  3. Опционально — automated nightly check: latest backup развернуть в throwaway container, run `PRAGMA integrity_check`, compare row counts с prod (within tolerance).

---

### [DB-005] PRAGMA `foreign_keys=ON` не установлен → FK silently broken — severity: **high**

* **Where**: `src/db/database.js:22-26` (constructor — только `journal_mode = WAL`, нет `foreign_keys`)
* **What**: schema.sql + inline declarations имеют ≥9 FK constraints (`REFERENCES plans(id)`, `REFERENCES trends(id)`, `REFERENCES users(id)`, `REFERENCES broadcasts(id) ON DELETE CASCADE`). Без `PRAGMA foreign_keys = ON` SQLite **игнорирует** все эти constraints. CASCADE deletes silently broken.
* **Risk**: 
  - Orphan rows на retention sweep `cleanupAlerts(daysOld)` deletes trends — `notifications`, `feedback_votes`, `hidden_trends`, `x_analysis_history` rows с dangling trend_id остаются.
  - `alert_score_history` имеет `ON DELETE CASCADE` declared — silently broken, manual cleanup не работает.
  - `broadcast_deliveries.broadcast_id` имеет `ON DELETE CASCADE` — same.
  - Eventual JOIN с trends → NULL fields, queries возвращают stale data.
* **Fix**: добавить `this.db.pragma('foreign_keys = ON')` сразу после WAL line. **Before** включать — single sweep query на orphan cleanup (иначе INSERT на FK-tables начнёт ловить `SQLITE_CONSTRAINT_FOREIGNKEY`). Plus: добавить explicit `ON DELETE CASCADE` на declarations которые сейчас silent (`notifications.trend_id`, `feedback_votes.trend_id`, `hidden_trends.trend_id`, `x_analysis_history.trend_id`).

---

### [DB-006] `busy_timeout = 0` (default) → random `SQLITE_BUSY` errors — severity: **high**

* **Where**: `src/db/database.js:22-26` (constructor)
* **What**: better-sqlite3 default `busy_timeout = 0`. Любой concurrent writer ловит `SQLITE_BUSY` instantly. WAL improves reader-writer concurrency, но не writer-writer.
* **Risk**: Catalyst пишет параллельно из: scan-cycle (save loop ~50 INSERT/cycle), alert-dispatcher (notifications row), dashboard SSE (auth_sessions UPDATE per poll), feedback_votes endpoints, support-bot relay, TG webhook (users.last_seen update). Между ними real contention. При scan-cycle транзакции на ~500 INSERT → параллельный `/api/feedback` от dashboard ловит `SQLITE_BUSY: database is locked` → 500 user. Связано с **COST-001/002** (concurrent race на cap counters): те cap-counter writes тоже могут получить BUSY.
* **Repro**: запустить `/api/feedback` или `/api/trends/:id/favorite` во время scan-cycle save phase. Random fail.
* **Fix**: `this.db.pragma('busy_timeout = 5000')` (5 sec retry-loop, встроен в SQLite). One-liner.

---

### [DB-007] `notifications` missing compound + UNIQUE index — severity: **high**

* **Where**: schema.sql:74-86 + `wasNotificationSentToUser(trendId, userId)` query
* **What**: текущие индексы — separate `idx_notifications_trend(trend_id)` + `idx_notifications_user(user_id)`. Anti-dupe gate (PIPE-006 уже flag'нул) делает `SELECT WHERE trend_id=? AND channel=? AND user_id=?` — SQLite использует один index + linear filter. На 3M rows/year (DB-008) это будет slow. **Также** нет UNIQUE constraint → PIPE-006 race window между SELECT и INSERT может вставить duplicate row.
* **Risk**: 
  - Performance: anti-dupe gate slow as notifications grows.
  - Correctness: race condition → duplicate alert sent to user (already flagged PIPE-006).
* **Fix**: `CREATE UNIQUE INDEX idx_notifications_dedup ON notifications(trend_id, channel, user_id)` + try/catch на INSERT (или `INSERT OR IGNORE`). Single index решает performance и correctness. Migration требует cleanup существующих duplicates перед UNIQUE creation.

---

### [DB-008] `notifications` table без retention — exponential growth — severity: **high**

* **Where**: `src/db/database.js` (no scheduled cleanup), `src/index.js` (no `cleanupNotifications` loop)
* **What**: cleanup происходит только в `cleanupAlerts(daysOld)` который зовётся **emergency** (low-disk trigger) или daily в `scheduleDailyTasks`. На bursty traffic notifications grows ~80 alerts/day × N users × **forever**. PIPE-006, COST-016 уже flag'нули; DB-08 confirms с growth-projection: ~3M rows/year @ 100 users → ~600MB/year. @ 1000 users → ~6GB/year.
* **Risk**: disk fill at year 2-3 with growth.
* **Fix**: scheduled retention loop: `DELETE FROM notifications WHERE sent_at < datetime('now', '-30 days')`. Run в daily maintenance. Может объединить с миграцией DB-007 (UNIQUE) — оба касаются той же table.

---

### [DB-009] Множество tables без retention — unbounded growth — severity: **high**

* **Where**: `feedback_votes` (no cleanup), `support_threads` (no cleanup), `x_analysis_history` (no cleanup), `tag_refresh_history` (no cleanup)
* **What**: 4 tables никогда не чистятся:
  - `feedback_votes` — low rate, но per-user × per-trend. Forever.
  - `support_threads` — 1 row per support user. Slow growth.
  - `x_analysis_history` — per Apify fetch. Test=10/day, growing.
  - `tag_refresh_history` — ~75 rows/month = ~900/year.
* **Risk**: medium-low individually, additive. Tag_refresh_history самая медленная (~1KB/month), `x_analysis_history` самая быстрая.
* **Fix**: добавить retention loops в `scheduleDailyTasks`:
  - `feedback_votes` — 90 day retention (votes на старые тренды бесполезны).
  - `x_analysis_history` — 90 day.
  - `tag_refresh_history` — 1 year (audit log).
  - `support_threads` — forever (operational data, keep).

---

### [DB-010] `cleanupVideoCache` запускается только на boot, не scheduled — severity: **high**

* **Where**: `src/index.js:~78` (startup only — `telegram.cleanupVideoCache(5)`)
* **What**: video-cache cleanup называется **один раз на startup** и больше **никогда**. Между restart'ами файлы аккумулируются неограниченно. Worst-case оценка: ~240 TikTok видео/day × ~20MB avg = **~4.8GB/day** → за неделю без restart ~33GB.
* **Risk**: Docker volume fill → SQLite write fails → app crash. На VPS со small disk (50-100GB) это критично.
* **Fix**: добавить `setInterval(() => telegram.cleanupVideoCache(7), 24*60*60*1000)` после startup call.

---

### [DB-011] `auth_sessions` cleanup только на startup, orphans accumulate — severity: **high**

* **Where**: `src/db/database.js:~453` (migration-time only)
* **What**: `DELETE FROM auth_sessions WHERE token IS NULL AND created_at < datetime('now', '-1 day')` запускается **только** при boot в `_migrate()`. Между restart'ами orphan sessions (auth начат, не finalized) аккумулируются.
* **Risk**: settings table growth, slow auth lookups, eventually disk-cost (small, но multiplied with traffic).
* **Fix**: `setInterval` каждые ~12h, или в scheduled daily tasks loop.

---

### [DB-012] Three hot SQLite TEXT timestamp queries с raw `toISOString()` → silent empty — severity: **high**

* **Where**: `src/db/database.js:1354` (`isTrendSeenFuzzy(hoursBack=6)`), `src/analysis/clusterer.js:621` (`_fetchHistory` with `DB_WINDOW_HOURS`), `src/admin/server.js:160-161` (`_getStats day7/day30`)
* **What**: SQLite stores `CURRENT_TIMESTAMP` как `"YYYY-MM-DD HH:MM:SS"` (space). JS `toISOString()` даёт `"YYYY-MM-DDTHH:MM:SS.sssZ"` (T). Lexicographic compare: space (0x20) < T (0x54), DB string ALWAYS < cutoff на same-day. Query returns **empty silently**.
* **Risk**:
  - `isTrendSeenFuzzy(6)` — false negative on dedup check → duplicate trends through pipeline.
  - `clusterer._fetchHistory` if `DB_WINDOW_HOURS < 24` (default 24) → empty cluster history.
  - admin stats `newWeek` / `newMonth` могут показать 0 если cutoff within 24h boundary.
* **Fix**: применить existing `sqliteCutoff(msAgo)` helper в эти 3 callsites. Также — consolidate duplicate helpers (DB-027 ниже).

---

### [DB-013] Hot save loops без транзакций — N×fsync slowdown — severity: **high**

* **Where**: `src/index.js:461-471` (saveTrend loop low-signal), `src/index.js:512-525` (main post-AI save loop, hot path per scan), `src/refresh/hot-metrics.js:263-272` (refresh save loop), `src/notifications/alert-dispatcher.js:90-122` (`recomputeAlertScores` → per-row `recordAlertScoreHistory` INSERTs)
* **What**: каждая итерация = independent transaction = fsync ~3-10ms each. На ~50 trends per scan-cycle save phase это ~500ms fsync overhead. Wrapped в `db.transaction(rows => ...)` это становится ~5-15ms total.
* **Risk**: scan-cycle latency 10× slower than necessary. Long lock window → больше шансов на DB-006 BUSY. Тяжелее scan-cycle = больше chance дёргать `_aiUnavailable` save_only retry path (PIPE-005 cost burn).
* **Fix**: добавить helper `db.saveTrendsBatch(trends)` и `db.recordAlertScoreHistoryBatch(rows)` через `db.transaction()`. Caller replaces for-loop. Существующие patterns (`normalizePlans`, `confirmPaymentAndUpgrade`, `cleanupAlerts`) уже правильно atomic — distribute pattern.

---

### [DB-014] No log rotation в `/logs/{date}.log` → 36GB/year — severity: **high**

* **Where**: `src/utils/logger.js:~35` (file per date) + Docker `json-file` driver only handles stdout buffer
* **What**: per-day log file без cleanup. Estimate ~50-100MB/day на info+debug level. На год — **~36GB**.
* **Risk**: disk fill на same volume что `/data/catalyst.db`. SQLite writes fail when disk full. Same root cause class что DB-010 video-cache.
* **Fix**: либо `logrotate` entry (50MB/file, 14-day retention), либо implement size-based cleanup в logger.js, либо переключиться на winston/pino with built-in rotation. Cheapest — `logrotate` config + restart.

---

### [DB-015] Backup без encryption — token leak risk если B2 будет имплементирован — severity: **high (conditional)**

* **Where**: `scripts/backup.sh` (gzip only, не encrypt) + future rclone+B2 config
* **What**: при имплементации DB-003 (rclone+B2) backups уйдут на B2 в plain (gzipped only). rclone config holds B2 API token в `/root/.config/rclone/rclone.conf` plaintext. SSH compromise → attacker downloads все backups → читает user PII, plan history, payment records, всё.
* **Risk**: conditional на DB-003 fix. Сейчас (без B2) — local backup-only, blast radius ограничен self-VPS.
* **Fix**: при имплементации B2 — `rclone --crypt` config или client-side `age`/`gpg` encrypt до upload. B2 server-side encryption — protects only against B2 storage leak, не token leak.

---

### [DB-016] No schema versioning + custom migrations вне runbook — severity: **medium**

* **Where**: `src/db/database.js _migrate()` (~30 inline addIfMissing), `scripts/migrate-categories-2026-05-08.sql` (manual run только)
* **What**: каждый boot ре-bежит all inline migrations. Seed-blocks защищены settings-marker'ами (good). Custom SQL files (`scripts/migrate-*.sql`) запускаются вручную через `docker exec ... sqlite3 < file.sql`, описано только в WORKLOG_ARCHIVE, не в DEPLOY.md. Нет `PRAGMA user_version` ни custom `schema_migrations` table.
* **Risk**: drift между schema на разных environment'ах. Operator может пропустить migration после `git pull` (rolling deploys ничего не запускают).
* **Fix**: либо `PRAGMA user_version` + automated runner который читает `scripts/migrate-*.sql` и применяет в порядке (sorted), либо `schema_migrations(filename, applied_at)` table + check. Plus DEPLOY.md «11.5 SQL Migrations» section.

---

### [DB-017] `addIfMissing` DDL вне транзакций — severity: **medium**

* **Where**: `src/db/database.js _migrate()` (~30 ALTER calls)
* **What**: каждый `ALTER TABLE ADD COLUMN` — отдельная транзакция. Crash mid-migration (OOM, kill -9, power) → DB в полу-мигрированном state. Restart recovery полагается на idempotency через `PRAGMA table_info` check (current pattern OK), но fragile для non-idempotent future migrations.
* **Risk**: low сейчас (pattern idempotent), но fragile.
* **Fix**: обернуть весь `_migrate()` body в `this.db.transaction(() => { ...all ALTERs + seeds... })`. `normalizePlans` уже правильно делает это — extend pattern на весь init.

---

### [DB-018] Missing index на `trends.last_seen_at` — severity: **medium**

* **Where**: `_handleTrends` main feed query `WHERE last_seen_at > ?`
* **What**: existing indexes: `idx_trends_first_seen_at`. Feed sort by score после `WHERE last_seen_at` — full scan на 13K rows. Acceptable при текущем масштабе (~100ms), но margin тонкий.
* **Risk**: feed latency degrades at scale.
* **Fix**: `CREATE INDEX idx_trends_last_seen_at ON trends(last_seen_at DESC)`. ~2 sec migration.

---

### [DB-019] Missing index на `trends.url` для UPSERT lookup — severity: **medium**

* **Where**: `saveTrend()` UPSERT, `updateTwitterEngagement`/`updateRedditEngagement` (per hover preview)
* **What**: `WHERE url = ?` lookup без index → table scan. На 13K rows = ~50ms × ~50 saves/cycle = ~2.5sec of cycle time на этом alone. Плюс per-hover в COST-012 угле.
* **Risk**: save phase performance, hover preview latency.
* **Fix**: `CREATE INDEX idx_trends_url ON trends(url)`. May need partial если много NULL url.

---

### [DB-020] 8 secondary `toISOString()` raw places — symptom-less но wrong — severity: **medium**

* **Where**: `database.js:1121, 1131, 1150, 1467, 1735, 2116, 2145, 2359` (retention/dedup queries с 7d/30d windows)
* **What**: на больших окнах (>24h) lexicographic compare совпадает на day prefix → query возвращает correct day-boundary rows. Symptom-less, но conceptually wrong и fragile (если когда-нибудь caller передаст small window — silent break).
* **Risk**: latent bug, активируется при cap window <24h.
* **Fix**: применить `sqliteCutoff` helper во все 8 places. Mass migration, low impact.

---

### [DB-021] Broadcast per-user pin+delivery не atomic — severity: **medium**

* **Where**: `src/admin/server.js:741-777` (broadcast loop)
* **What**: для каждого user — TG send → UPDATE users.pinned_broadcast_message_id → INSERT broadcast_deliveries. На JS crash mid-loop (SIGTERM, OOM) — partial state: some users имеют new pin без delivery audit row.
* **Risk**: inconsistency между `users.pinned_broadcast_message_id` и `broadcast_deliveries`. Operational concern только.
* **Fix**: per-user обернуть UPDATE+INSERT в `db.transaction((uid, msgId) => { ... })()`. Не span TG send (network) — keep TG call outside transaction.

---

### [DB-022] Backup script без monitoring — cron failures invisible — severity: **medium**

* **Where**: `scripts/backup.sh` + cron `/etc/cron.d/catalyst-backup`
* **What**: no email/Slack alert при failure. `exit 1` на missing DB — но cron logs не trigger'ит alert. Permission drift, disk full на `/var/backups/`, missing rclone config — все silent.
* **Risk**: infra issues unnoticed for weeks. Combined с DB-001/002/003 — мы не знаем работает ли backup сегодня.
* **Fix**: добавить `|| send_alert "Backup failed: $?"` (TG bot message? Email?). Minimal cost.

---

### [DB-023] Video-cache worst-case ~30GB rolling 7d — severity: **medium**

* **Where**: video-cache TTL 7d + concurrent TikTok search spikes
* **What**: уже flagged DB-010 (one-time cleanup). Расширение: даже если cleanup работает каждые 24h, rolling 7d × ~4.8GB/day = ~33GB upper bound. На VPS с 50-100GB disk это значительная часть.
* **Risk**: disk fill risk если video-cache не shrinks proportionally к scan-cycle rate.
* **Fix**: либо tightening TTL (3-5d вместо 7d), либо size-based eviction (>15GB → trigger aggressive cleanup), либо monitor + alert.

---

### [DB-024] `disabledCollectors` JSON.parse без try/catch — severity: **medium**

* **Where**: `src/index.js:316` — `const saved = JSON.parse(db.getSetting('disabledCollectors', '[]') || '[]')`
* **What**: corrupt blob (crash mid-write, disk error) → `JSON.parse` throws → boot fails hard.
* **Risk**: boot failure on corrupt settings row. Unrecoverable без manual SQLite intervention.
* **Fix**: wrap в try/catch, fallback на `[]` + warn.

---

### [DB-025] Backup retention drift: script 30d, docs 14d — severity: **medium**

* **Where**: `scripts/backup.sh:17` (`-mtime +30 -delete`), `SESSION_CONTEXT.md:746` («Local retention 14 дней»)
* **What**: drift documentation vs реальность. Не data loss risk (over-retention safe), operational confusion.
* **Fix**: либо update script на `+14`, либо update SESSION_CONTEXT на «30 дней».

---

### [DB-026] Schema split — schema.sql vs database.js inline — severity: **low**

* **Where**: `schema.sql` has 7 tables, остальные 9 inline в `database.js`
* **What**: new contributor не знает реальную schema без чтения database.js. Schema migrations history фрагментарна.
* **Fix**: либо консолидировать всё в `schema.sql`, либо явно задокументировать split в schema.sql comment header. Long-term — migration runner files-based.

---

### [DB-027] Duplicate `sqliteCutoff` helper в 2 файлах — severity: **low**

* **Where**: `src/dashboard/server.js:131`, `src/analysis/manual-analysis.js:42`
* **What**: identical implementation, manual-analysis.js имеет comment «Keep in sync» — но shared module нет → drift risk.
* **Fix**: вынести в `src/utils/db-helpers.js` или метод `database.js` (где она логически живёт).

---

### [DB-028] Missing index на `trends.category` — severity: **low**

* **Where**: `_handleTrends` с `WHERE category = ?` filter
* **What**: user-initiated category filter без index → full scan. Cardinality low (~20 categories), not hot path.
* **Fix**: `CREATE INDEX idx_trends_category ON trends(category)`. Optional, измерить usage first.

---

### [DB-029] PRAGMA tuning gap (synchronous/cache_size/mmap_size implicit) — severity: **low**

* **Where**: `src/db/database.js:22-26`
* **What**: только `journal_mode = WAL` set. `synchronous` defaults to NORMAL (OK с WAL), `cache_size` ~2MB (мало для 1GB+ DB), `mmap_size` not set, `temp_store` default.
* **Risk**: subtle slowdown на full-table scans (admin queries, search), не correctness.
* **Fix**: 
  ```
  pragma('synchronous = NORMAL')  -- explicit
  pragma('cache_size = -20000')   -- ~20MB
  pragma('temp_store = MEMORY')
  pragma('mmap_size = 268435456') -- 256MB на Linux production
  ```

---

### [DB-030] `notifications.user_id` legacy NULLABLE — severity: **low**

* **Where**: `schema.sql:78` — `user_id INTEGER` (без NOT NULL)
* **What**: legacy от pre-v3 миграции, после которой user_id обязательный. Запрос видит NULL = orphan-like row.
* **Fix**: cleanup script + rebuild table с NOT NULL. Может комбинироваться с DB-007 UNIQUE migration.

---

### [DB-031] WAL checkpoint только on cleanup → потенциальный grow — severity: **low**

* **Where**: `src/db/database.js:1751` (`wal_checkpoint(TRUNCATE)` после cleanupAlerts)
* **What**: better-sqlite3 auto-checkpoint ~1000 pages (~4MB) — нормальный rate. Manual TRUNCATE checkpoint только daily в cleanup. На sustained write burst WAL может расти больше.
* **Fix**: optional `pragma('wal_autocheckpoint = 500')` для tighter cycle. Monitor `*.db-wal` size on prod.

---

### [DB-032] `presetConfigsAuto` blob ~50KB в settings table — severity: **low**

* **Where**: `settings` KV table holds large JSON blobs (`presetConfigs`, `presetConfigsAuto`, `presetTagsLocked`)
* **What**: estimate 5-50KB per blob. Settings table designed для small KV, не large blobs. Если рост presets — может расти до 100KB+.
* **Fix**: если боль реальная — вынести в свою `preset_overrides(preset TEXT PRIMARY KEY, json TEXT, updated_at)` table.

---

### [DB-033] No VACUUM / auto_vacuum — observation (not finding) — severity: **info**

* **Where**: (absence of VACUUM calls)
* **What**: zero VACUUM в коде — это **good news** (нет mid-day freeze risk). При current ~18MB DB размер freelist modest, `cleanupAlerts` + `wal_checkpoint(TRUNCATE)` достаточно. **Future tuning**: при DB > 100MB рассмотреть `PRAGMA auto_vacuum = INCREMENTAL` (set перед schema populate, иначе требует one-shot VACUUM).

---

### [DB-034] FTS5 для LIKE search — info opportunity

* **Where**: feed search server-side `LIKE '%q%'` × 4 columns (`title`, `original_title`, `ai_explanation`, `category`)
* **What**: leading wildcard → indexes не используются. На 13K rows full scan OK. При 100K+ rows стоит FTS5 virtual table. SQLite поддерживает via better-sqlite3.
* **Fix**: будущая optimization, не сейчас.

---

### [DB-035] AUTOINCREMENT — info

* **Where**: все 7 schema.sql tables использует `INTEGER PRIMARY KEY AUTOINCREMENT`
* **What**: AUTOINCREMENT guarantees monotonic IDs (не reuse), overhead — `sqlite_sequence` table touched per INSERT. Для нашего use case strict monotonic не нужен — можно убрать AUTOINCREMENT (just `INTEGER PRIMARY KEY` = ROWID).
* **Fix**: cosmetic optimization. Not worth touching на live tables (requires rebuild).

---

### [DB-036] Postgres migration threshold — info

* **What**: SQLite current scale (100 users, 1GB DB) — optimal. Threshold для миграции: ~5000 active users OR ~5GB DB OR concurrent writer contention noticeable. Сейчас далеко.
* **Fix**: planning concern для year 2-3.

---

### [DB-037] WAL может grow если manual checkpoint редкий — info

* **What**: см. DB-031. На sustained burst WAL может расти до GB. Не блокер при current scale.

---

## Verified safe

* ✓ **WAL mode** enabled (`journal_mode = WAL`) — concurrent reads OK during writes, backup-during-write safe.
* ✓ **`normalizePlans`** wraps 6 UPSERTs в transaction.
* ✓ **`confirmPaymentAndUpgrade`** atomic transaction (payment + plan upgrade).
* ✓ **`cleanupAlerts`** wrapped в transaction + checkpoint after.
* ✓ **`claimTriggerSearch`** atomic single UPDATE с rows-affected check.
* ✓ **`addFavorite`** UPSERT через INSERT ... ON CONFLICT.
* ✓ **`setSetting`** UPSERT через INSERT ... ON CONFLICT.
* ✓ **`payments.tx_signature` UNIQUE WHERE NOT NULL** — double-credit impossible.
* ✓ **`broadcast_deliveries` UNIQUE(broadcast_id, user_id)** — но FK CASCADE silently broken (DB-005).
* ✓ **Auth tables**: `idx_auth_token`, `idx_users_chat_id` — point lookup per request OK.
* ✓ **Trends point lookups**: `external_id`, `tg_message_id` indexed.
* ✓ **CHAT_ID TEXT affinity** — `String(chatId)` conversion везде → safe equality.
* ✓ **Hot retention loops** для `hidden_trends` (7d), `alert_score_history` (30d), `payments` (30d) — все daily + startup scheduled.
* ✓ **`addIfMissing` migration pattern** idempotent через `PRAGMA table_info`.
* ✓ **Backup script in repo** (`scripts/backup.sh`) — restoration не impossible if VPS lost.

---

## Spec drift

Накопительный counter (sync-pass after 12 этапов):

* **SD-1** (PIPE/SEC) — TRUST_PROXY=1 в spec, не работает в коде.
* **SD-2** (PIPE) — alert-dispatcher daily-limit gate JSDoc — gate'а нет.
* **SD-3** (PIPE/BILL) — Catalyst forecast 15-min cooldown в spec, снят в коде.
* **SD-4** (BILL) — `xAnalysis` поле не упомянуто в § Бизнес-правила.
* **SD-5** (BILL) — `historyHours: 72` для free не в § Бизнес-правила.
* **SD-6** (BILL) — `favorites: true` для pro/admin не явно в § Бизнес-правила.
* **SD-7** (BILL) — Manual analysis cache TTL: spec=1h, code=6h.
* **SD-8** (PIPE/COST re-confirm) — Embeddings TTL docstring contradiction.
* **SD-9** (DB, **new**) — Backup contract drift: SESSION_CONTEXT § Production posture обещает `sqlite3 .backup` + rclone+B2 off-site, реальный `scripts/backup.sh` делает `cp` + только local. **Самый болезненный drift всех 5 этапов**.
* **SD-10** (DB, **new**) — Backup retention: code 30d, spec 14d.
* **SD-11** (DB, **new**) — Schema documentation: schema.sql имеет 7 tables, реальная схема — 16 (9 inline в database.js).

**Total spec drift count: 11**.

---

## Cross-audit overlap (расширенный)

Накопленные pairs/triples и **«One-fix-many-wins»** target list расширяется DB findings:

### Known triple (locked)
* **SEC-001 + PIPE-004 + BILL-003** — `/api/scan` admin gate. Cost angle уже в BILL-003.

### Extended pairs

* **DB-008 ↔ PIPE-006 ↔ COST-016** — все три про `notifications`. **Single migration** покрывает: retention loop + UNIQUE constraint + compound index (DB-007 тоже сюда):
  ```sql
  -- 1. Cleanup duplicates (если есть)
  DELETE FROM notifications WHERE id NOT IN (
    SELECT MIN(id) FROM notifications GROUP BY trend_id, channel, user_id
  );
  -- 2. UNIQUE compound index (closes PIPE-006 + DB-007)
  CREATE UNIQUE INDEX idx_notifications_dedup ON notifications(trend_id, channel, user_id);
  -- 3. Retention loop в index.js scheduleDailyTasks (closes DB-008 + COST-016)
  ```

* **DB-005 ↔ DB-009 ↔ implicit CASCADE expectation** — FK=OFF означает что existing `ON DELETE CASCADE` declarations (alert_score_history, broadcast_deliveries) silently broken. Включение PRAGMA + orphan sweep — single migration. Connected с DB-010, DB-011 (one-time cleanups → orphan accumulate).

* **DB-013 ↔ COST-007 ↔ TXN-002/003** — все про transaction granularity. Single «batch-save helper» refactor закрывает 3 finding'а с разных аудитов.

* **DB-012 ↔ DB-020 ↔ DB-027** — все про SQLite timestamps. Single «unify sqliteCutoff usage + migrate helper to shared module» PR закрывает все три. Plus PIPE-007/COST-PIPE drift in embeddings TTL is related class.

* **DB-006 ↔ COST-001/002 (concurrent caps)** — busy_timeout=0 amplifies cap race conditions. Включение busy_timeout=5000 mitigates concurrent race surface.

* **DB-010 ↔ DB-014 ↔ DB-023 — disk fill class** — video-cache + log rotation + monitoring. Add scheduled cleanup loops as single «housekeeping refresh».

### **«One-fix-many-wins» backlog (расширенный)**

| Fix | Closes (across all 5 audits) |
|---|---|
| `/api/scan` admin gate + immediate timestamp | SEC-001 + PIPE-004 + BILL-003 |
| DB-backed `feature_usage_log` table | BILL-007 + COST-003 |
| Hover preview plan-check + per-user rate-limit | BILL-001 + COST-004 |
| Proactive Google healthcheck + counter reset | PIPE-002 + COST-006 + COST-008 |
| **Backup integrity rewrite (sqlite3 .backup + gzip -t + rclone+B2 + restore drill)** | **DB-001 + DB-002 + DB-003 + DB-004 + SD-9** |
| **`notifications` migration (UNIQUE + compound index + retention)** | **PIPE-006 + COST-016 + DB-007 + DB-008** |
| **Schema integrity sweep (FK=ON + busy_timeout + orphan cleanup + retention)** | **DB-005 + DB-006 + DB-009 + DB-010 + DB-011** |
| **`db.transaction` wrap всех save loops** | **DB-013 + COST-007 + TXN-002+003** |
| **`sqliteCutoff` consolidation + 11 usage migration** | **DB-012 + DB-020 + DB-027 + part of SD-8** |
| **Housekeeping schedule (logs + video-cache + auth_sessions + monitoring)** | **DB-010 + DB-011 + DB-014 + DB-022 + DB-023** |

**Total**: 10 «one-fix-many-wins» targets. Если приоритезировать backup-rewrite + notifications-migration + schema-sweep — закрывается ~12 finding'ов из 5 этапов одной серией PR.

---

## Out of scope / followups

* **(этап 6, UX)** — admin UI dashboard для cost/cap visibility (DB-007 indexes улучшат perfomance), schema docs page.
* **(этап 7, admin UI)** — confirmation modals для destructive actions (revoke, cleanup).
* **(этап 9, prod posture)** — `logrotate` config за пределами node app — nginx-level cron job. Также — Docker volume size monitoring (Prometheus exporter? Manual `df -h` script?).
* **(operational)** — quarterly restore drill (DB-004) — добавить в operations runbook.
* **(observation)** — Postgres migration planning — соберём criteria для решения в Q4 (active users + DB size + concurrent write rate).
* **(observation)** — текущая arch'ра в основном single-process Node — concurrent writer issue (DB-006) decreases when scaling out, но increases при event-driven (TG webhooks). Сейчас polling-based — мало contention.
* **(observation)** — `support_threads` retention forever — оставить, это operational data. Можно archive в file после 1y, не cleanup.

---

**Audit complete.** Жду решения какие finding'и фиксить первыми. Backup-секция (DB-001..004) **должна быть приоритетом №1** — четыре critical в одной области говорят что production resilience сейчас не существует.
