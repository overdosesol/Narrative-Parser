# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 безархивации. Полная история — в git.

Если задача мелкая, например передвинуть кнопку в дашборде или изменить немного текст в промпте для llm, можно сразу не записывать в WORKLOG, а подождать пока накопится около 5 мелких правок или 1 большая и записать всё вместе.

---

## 2026-05-29 · opus · PROD INCIDENT — 502 after all-at-once deploy (B10 unique-index boot crash) + boot-safe hardening

**Симптом:** после деплоя всего бэклога разом — `502 Bad Gateway` (nginx жив, апп в краш-лупе `Restarting`).

**Root cause:** деплой «всё разом» без прогона B10-миграции. `_migrate()` на boot гонит `schema.sql` → `CREATE UNIQUE INDEX idx_notifications_dedup ON notifications(trend_id,channel,user_id)`; в проде было 3 дубль-группы (5 строк) → `SQLITE_CONSTRAINT_UNIQUE` → необработанное исключение → process exit → Docker рестарт-луп. Подтверждено `docker logs` + эмпирическим in-memory тестом ДО фикса.

**Прод-фикс** (read-only диагностика → operator authorized mutation): `docker stop` → 2 бэкапа (`cp` + `sqlite3 .backup`, integrity ok) → минимальный верный фикс (дедуп notifications −5, создание индекса, транзакционно, `-bail`) → `chown 1000:1000` → `docker start`. Boot чистый, health **200** внутри+снаружи. Бэкапы на VPS: `catalyst.db.{pre-b10,fullbak}-*` (почистить позже).

**Discovered:** сама B10-миграция багнута — `migrate-db-constraints-2026-05-28.sql:19` делала `DELETE FROM user_favorites WHERE user_id ...`, но таблица keyed по `chat_id`, без колонки `user_id` и вообще без FK (favourites by design переживают тренд). Поэтому прогнал только notifications-часть (100% верную), orphan-sweep не трогал.

**Hardening (репо, следующий деплой):**
- `src/db/database.js _migrate()` — индекс перенесён сюда: **дедуп → `CREATE UNIQUE INDEX IF NOT EXISTS`**, guarded `try/catch`, на каждом boot. Устраняет весь класс «деплой без миграции → 502». Self-heal протестирован (in-memory: дубли+нет индекса → boot НЕ падает, дедуп 4→2, индекс создан, dup-insert блокируется).
- `src/db/schema.sql` — убран `CREATE UNIQUE INDEX idx_notifications_dedup` (он и ронял boot) + коммент-указатель на `_migrate`.
- `scripts/migrate-db-constraints-2026-05-28.sql` — убраны обе багнутые `user_favorites` orphan-DELETE; orphan-sweep сверен по реальным FK (schema.sql + `_migrate` DDL — только декларированные FOREIGN KEY); шапка: скрипт теперь опциональный (notifications-часть self-heal'ится в `_migrate`).

**Верификация:** `node --check` OK; SPA не тронут; hardening-тест PASSED (4 чека). **Прод УЖЕ на исправленной БД**; код-hardening уедет следующим `deploy.ps1`. Урок сохранён в memory (`feedback_boot-safe-migrations`).

---

## 2026-05-29 · opus · Bundle #5 — sqliteCutoff consolidation + REAL space/T bug fix (DB-012/020/027 + SD-8)

**Цель:** Свести разбросанный timestamp-cutoff в один shared-хелпер. Recon вскрыл, что это НЕ причёсывание, а **реальный баг**: 8 мест сравнивали `toISOString()` («T»-формат) против `CURRENT_TIMESTAMP`-колонок («пробел»-формат). Пробел (0x20) < «T» (0x54) → `WHERE col > cutoff` молча возвращал ~0 строк для свежих данных. Подтверждено in-memory тестом ДО правки.

**Что было сломано (теперь восстановлено как задумано):**
- `isTrendSeenFuzzy` — fuzzy-дедуп трендов по похожему заголовку (запрос всегда пуст → фича не работала; точные дубли ловились другими слоями, поэтому не замечалось).
- `clusterer._fetchHistory` — окно истории для кластеризации (пусто → влияло на novelty → **скоринг**).
- `getRecentTrends` — выборка свежих трендов.
- admin `_getStats` — новые юзеры/выручка за 7/30д (показывали **0** при наличии данных).
- hidden_trends (feed-фильтр + архив) + retention-чистка.

**Оператор согласовал «чинить всё»** (показал баг + видимый эффект ДО правки, т.к. влияет на ленту/алерты). Ожидаемый эффект после деплоя: меньше почти-дублирующихся трендов/алертов (дедуп ожил) + точные админ-статы 7/30д.

**Файлы:**
- `src/utils/sqlite-time.js` (new) — `export function sqliteCutoff(msAgo)` (space-формат) + JSDoc с объяснением бага. Единый источник.
- `src/db/database.js` — import + 5 мест (3 retention hidden_trends + `isTrendSeenFuzzy` + `getRecentTrends`).
- `src/analysis/clusterer.js` — import + `_fetchHistory`.
- `src/admin/server.js` — import + `_getStats` day7/day30 (SPA gate ✅).
- `src/dashboard/server.js` — import + удалён локальный дубль `sqliteCutoff` (bug-doc коммент оставлен); 4 существующих callsite'а теперь на общем хелпере (SPA gate ✅).
- `src/analysis/manual-analysis.js` — import + удалён 2-й дубль `sqliteCutoff`.
- `src/analysis/embeddings.js` — SD-8: docstring TTL поправлен (убрано неверное «5min = scan_interval × 2»; реальный scan interval = 15min).

**Верификация:** `node --check` 7 файлов OK; `npm run check:spa` зелёный (346231 / 271793); throwaway functional-тест: `isTrendSeenFuzzy` находит свежий near-dup (был FALSE под багом), `getRecentTrends(24)`→строка, unrelated→FALSE. Тест удалён.

**Деплой:** код, no commit. Оператор коммитит + `deploy.ps1`. Без schema/env/migration.

**Closes:** DB-012 (3 hot scoring queries), DB-020 (8 secondary), DB-027, SD-8. **Tier 4 полностью разобран** (6 done + #14 dropped). Весь аудит-бэклог закрыт, кроме Tier 1 #18 (QA-инфра, deprioritized для соло).

---

## 2026-05-29 · opus · Bundle #12 — theme contract sync (SD-12/UX-004/DOC-006; QUAL-005 pre-closed) — doc-only

**Итог:** синк контракта тем — только `ai-context/SESSION_CONTEXT.md`, кода не трогал. Recon (haiku) подтвердил: реальный код = 3 темы (`SUPPORTED_THEMES=['pulse','ink','tide']`, `detectTheme()→'pulse'`, `applyThemeAttr()` снимает attribute для pulse), а CSS-коммент `dashboard/server.js:2686` уже исправлен Bundle #19 (QUAL-005). Stale оставался только state-spec.

**Файлы:**
- `ai-context/SESSION_CONTEXT.md` § Theme system — переписана: «2 dark темы, ink default» → «3 темы, pulse default (`:root` baseline без attribute) + ink/tide (`body[data-theme]`)». Таблица 3 строки, обновлён последний абзац (`detectTheme()→pulse`, `applyThemeAttr`). Дизайн-принципы не тронуты — актуальны.

**Деплой:** не требуется (только ai-context). No code, no SPA.

**Closes:** SD-12 + DOC-006 + UX-004 (все три = один drift: state-spec врал про число тем и дефолт). QUAL-005 — был закрыт Bundle #19. **Tier 4: 5/7** (#7 + #20 + #4 + #9 + #12). Remaining: #5 sqliteCutoff (scoring), #14 i18n.

---

## 2026-05-29 · opus · Bundle #9 — hover-preview plan-check + rate-limit (BILL-001 + COST-004) — verified pre-closed, no code change

**Итог:** оба finding'а #9 уже закрыты предыдущими бандлами — код-правок не потребовалось. Verified по текущему `src/dashboard/server.js`:
- **BILL-001** (plan-gate на hover preview) — закрыт Bundle #3: `_handleTweetPreview` (~1343) и `_handleRedditPreview` (~1415) гейтят по `getPlanEntitlements(plan).sources.includes('twitter'|'reddit')` → 403 `reason:'plan'` до любого fetch.
- **COST-004** (Reddit/Twitter IP-ban через unthrottled preview) — закрыт Bundle #8: module-level `tweetPreviewLimiter`/`redditPreviewLimiter` (30 req/5min, ~420) + guards в обоих хендлерах → 429 `reason:'rate_limit'`.

`node --check src/dashboard/server.js` → OK. INDEX и так помечал #9 «already partially covered by #3». Закрыт документально, SPA не тронут.

**Closes:** BILL-001 (HIGH), COST-004 (HIGH) — обе уже live. **Tier 4: 4/7** (#7 + #20 + #4 + #9).

---

## 2026-05-29 · opus · Bundle #4 — db.transaction batch helpers (DB-013/TXN-002/003; COST-007 false positive)

**Цель:** Закрыть DB-013 (4 unbatched save-loop'а = N fsync вместо 1) через batch-хелперы. COST-007 расследован — false positive.

**Метод:** tightly-coupled refactor (хелпер + 4 потребителя его API) → inline-исполнение (не subagent-driven: по SDD-гайду coupled-задачи делаются вручную). Recon (haiku) → правки → верификация `node --check` (5 файлов) + throwaway in-memory тест (14 чеков: ordered ids, персист, UPSERT-идемпотентность, skipErrors, history-батч) → тест удалён. SPA не тронут → SPA-gate не нужен.

**Файлы:**
- `src/db/database.js` — +2 метода на `TrendDatabase`: `saveTrendsBatch(payloads, {skipErrors, onError})` (возвращает id'шники по порядку payload'ов; внутри — существующий `saveTrend` UPSERT) и `recordAlertScoreHistoryBatch(rows)`. Оба через `this.db.transaction()`.
- `src/index.js` — 2 save-loop'а → `db.saveTrendsBatch()`: main post-AI save (~641, маппит id'шники обратно в `_dbId` для alert-dispatch) + low-signal save (~590). Payload-логика идентична.
- `src/refresh/hot-metrics.js` — hot-refresh save-loop (~263) → `saveTrendsBatch(..., {skipErrors:true, onError:warn})`. Сохранена per-item резильентность + warn-логи + счётчики. **`_dbId` НЕ маппится назад** (намеренно — Phase-4 alert-фильтр опирается на `_dbId` из Phase-1; менять = менять кто получит алерт).
- `src/notifications/alert-dispatcher.js` — `recomputeAlertScores` loop (~91): мутация alertScore/breakdown нетронута, sparkline-инсерты собираются в массив → `recordAlertScoreHistoryBatch()` после цикла (defensive-фолбэк на per-row).
- `src/analysis/scorer.js` — поясняющий коммент к `metrics.stage2Calls++` (~705): COST-007 false positive.

**COST-007 разбор:** аудит решил, что фейлы Stage 2 «съедают» кап. Реально кап = `.slice(0, stage2MaxCalls)` ДО цикла; `metrics.stage2Calls` — только лог-строка `stage2_calls=X/Y` + admin UI, цикл не гейтит. Перенос инкремента поменял бы лишь метрику (attempts→successes) и сделал бы «calls» менее точной (фейл тоже жжёт токены). **Не применяю**, коммент против повторного флага.

**Деплой:** код, no commit. Оператор коммитит + `deploy.ps1`. Никаких schema/env/migration изменений.

**Риски:** низкие. На save-пути index.js loop 1/2 транзакция меняет error-гранулярность (фейл середины batch'а: было partial save + проброс → стало полный rollback + проброс) — улучшение (нет полу-сохранённого скана); на success-пути запись идентична. Транзакции синхронны (saveTrend/recordAlertScoreHistory без await) — требование better-sqlite3 соблюдено.

**Closes:** DB-013 (HIGH), TXN-002/003 (cross-audit синонимы DB-013). COST-007 (MEDIUM) — false positive, documented (не код-фикс). **Tier 4: 3/7** (#7 + #20 + #4).

---

## 2026-05-29 · opus · Bundle #20 — README + DEPLOY runbooks (DOC-001/016/017/018; DOC-002/003/004 pre-closed)

**Цель:** Закрыть документ-находки Tier 4 #20 — создать отсутствующий README.md (DOC-001) + добить incident-response секции DEPLOY.md (DR, troubleshooting, migration note). Подтвердить, что DOC-002/003/004 уже закрыты ранее (#1 restore §6.5/6.6, #17 cert §4.2 + secret rotation §10.1).

**Метод:** docs-бандл, без TDD/SDD-машинерии. Recon деплой-инфры (haiku) → написание → фактчек по коду (haiku — 12/14 точны, 2 расхождения исправлены) → operator review. SPA-gate не нужен (server.js не тронут).

**Файлы:**
- `README.md` (new, ~115 строк, англ.) — pitch, what it does, pipeline-диаграмма, tech stack, quick start (dev) + npm scripts, минимум env, plans-таблица, project layout, ссылка на DEPLOY.md, SPA-trap heads-up, private-license. Факты выверены по package.json / .env.example / структуре `src/` / SESSION_CONTEXT pipeline.
- `DEPLOY.md`:
  - §6 intro переписан под реальный `catalyst-backup.sh` (было: до-#1 inline `sqlite3 ".backup"` cron + «rsync/aws s3 cp»; стало: docker inspect catalyst-app /data → integrity_check → hot .backup → gzip+`gzip -t` → 14d prune → rclone `b2:` → TG fail-trap, креды в `/etc/catalyst.env`). Drift-фикс.
  - +§6.7 Disaster Recovery (рус, ~50 строк) — полный rebuild VPS с нуля: новый VPS+DNS → docker/rclone/nginx/certbot → секреты из password manager → deploy кода → БД из B2 (ref §6.5) → TLS → cron → verify. RTO ~30-60мин, RPO ≤24ч.
  - +§13 Common troubleshooting (рус) — 6 сценариев: бот молчит (401/409), dashboard 502, Apify quota, коллектор в краш-лупе, OOM, SQLITE_BUSY. Старая «Future hardening» → §14.
  - +§7 migration note (англ) — авто-`_migrate()` на boot, ручного шага не нужно.
  - §8 bonus-фикс: admin health пример `8080`→`8081` (пред-существующая опечатка, поймана фактчеком).

**Деплой:** доки, кода нет. Рантайму не нужны; оператор коммитит, попадут в следующий обычный `deploy.ps1` заодно — отдельного шага не требуют. Никаких env/migration/SPA изменений.

**Риски:** нулевые (pure docs). Главный риск — doc-lies — закрыт фактчек-пассом по коду (порты, npm-скрипты, имена зависимостей, структура `src/`, container name, `busy_timeout`, deploy IP — всё подтверждено).

**Closes:** DOC-001 (HIGH, README), DOC-016 (MEDIUM, DR), DOC-017 (LOW, troubleshooting), DOC-018 (LOW, migration note). Pre-closed подтверждено: DOC-002 (#1), DOC-003/004 (#17). **Tier 4: 2/7** (#7 + #20).

---

## 2026-05-28 · sonnet · Bundle #7: /api/scan admin gate + pause persistence — 4 finding'ов + 1 SD одним PR

**Цель:** Закрыть SEC-001 (manual scan privilege) + PIPE-004 (immediate timestamp visibility) + BILL-003 (free user LLM-burn) + ADM-018 (pause lost on restart) + SD-16 (pause persistence drift).

**Файлы:**
- `src/dashboard/server.js` — `_handleScan`: +admin plan check на верху (`req.user?.plan_name !== 'admin'` → 403 `reason: 'plan'`) + immediate `setSetting('lastScanStartedAt', Date.now())` перед scanFn-fire. SPA gate ✅.
- `src/admin/server.js` — `/api/scanners/pause` теперь `setSetting('scanner_paused', '1')`, `/api/scanners/resume` → `'0'`. Best-effort try/catch (in-memory всегда update'ит). SPA gate ✅.
- `src/index.js` — после `const db = ...`: restore `appState.paused = true` если `getSetting('scanner_paused') === '1'`. WARN log при restored pause: «Scanner is PAUSED (persisted from previous session). Resume via admin panel.»

**Деплой:** стандартный `deploy.ps1`. Никаких schema / env / migration изменений.

**Риски:** admin-only гейт может lock'ать test/pro user'ов, но они и так не должны иметь доступ (audit принцип). Persisted pause требует операторской дисциплины — забыл resume → бот навсегда paused. Mitigation: WARN-level boot log с suggested next action.

**Не сделано:** admin UI badge «scan in progress» (using lastScanStartedAt vs lastScanCompletedAt) — deferred, data exposed для будущей UI работы. Schema migration на отдельный `admin_state` table — settings table достаточно для 2-key footprint.

---

## 2026-05-28 · sonnet · Bundle #8: Rate-limit + cooldown — per-user limiter on hover previews

**Цель:** Закрыть COST-004 (Reddit IP-ban risk через unthrottled hover preview). Подтвердить closure COST-001/002/PIPE-002 (уже закрыты pre-existing work).

**Файлы:**
- `src/dashboard/server.js`:
  - +1 import `UserRateLimiter` from `../utils/rate-limiter.js`
  - +2 module-level limiter `const`s (`tweetPreviewLimiter`, `redditPreviewLimiter`, оба 30 req / 5 min) + 2 константы `PREVIEW_RATE_*`
  - +2 rate-limit guard блока в `_handleTweetPreview` и `_handleRedditPreview` после BILL-001 plan check. Возвращают 429 `{ error, reason: 'rate_limit' }` на flood. Per-endpoint instances (Twitter ≠ Reddit upstream).
  - SPA gate ✅.

**Деплой:** стандартный `deploy.ps1`. Никаких env vars / migrations.

**Recon findings (закрыто до бандла):**
- **COST-001** — manual-analysis cap race → закрыто Bundle #2 (2026-06-07), DB-backed `feature_usage_log` table + atomic `getRecentFeatureUsageHits`.
- **COST-002** — catalyst cap race + key type mismatch → закрыто Bundle #2 (тот же fix).
- **PIPE-002** — Gemini cooldown reset на success → закрыто pre-existing `_recordGoogleSuccess()` at `src/analysis/gemini-captioner.js:1094-1100` сбрасывает `_googleFailures = 0` на каждый success.

**Риски:** 30/5min может быть тесно для power users — легко раздвинуть через `PREVIEW_RATE_MAX` const. In-memory state теряется на restart (acceptable — upstream rate windows тоже short-lived). 'anon' fallback shared bucket — defense-in-depth если auth gate когда-нибудь bypass'нется.

**Не сделано:** dashboard SPA toast UX для 429 — current generic 4xx handler достаточен.

---

## 2026-05-28 · sonnet · Bundle #6: Housekeeping + admin UI maintenance — 3 daily prunes + 4 admin buttons + backup widget

**Цель:** Закрыть DB-010 (video-cache daily), DB-011 (auth_sessions daily), DB-014 (log rotation), DB-022 (backup TG alert), DB-023 (video TTL tighten), PROD-019 (disk visibility), ADM-004 (admin maintenance gap).

**Файлы:**
- `src/utils/logger.js` — +1 method `cleanupOldLogs(maxAgeDays=14)`.
- `src/db/database.js` — +1 method `pruneAuthSessions(maxAgeHours=24)`. Boot cleanup refactored to call it.
- `src/index.js` — −1 startup line (old `cleanupVideoCache(5)`); +3 startup prune calls + 3 daily setInterval'ы (по B2 паттерну). Constants: `VIDEO_CACHE_RETENTION_DAYS=3`, `AUTH_SESSIONS_RETENTION_HOURS=24`, `LOG_RETENTION_DAYS=14`.
- `scripts/catalyst-backup.sh` — +env source from `/etc/catalyst.env` + trap-based curl TG sendMessage on non-zero exit. Tg destination: `SUPPORT_GROUP_ID` (re-uses B13 env). Silent skip if vars unset.
- `src/admin/server.js` — +4 POST endpoints `/api/admin/maintenance/{vacuum,cleanup-video,cleanup-auth,rotate-logs}`. `_getStats` теперь включает `stats.backup={lastBackupAt, lastBackupBytes, dirExists}`. SPA: +4 handler funcs в StatsPage, +4 buttons рядом с cleanupAlerts, +Backup status card с age-based color/emoji. SPA gate ✅ (271793 chars).

**Деплой:** оператор-driven (deploy.ps1). Дополнительно: убедиться что `/etc/catalyst.env` на VPS содержит `TG_BOT_TOKEN` и `SUPPORT_GROUP_ID` для backup alerts. Иначе alerts silent skipped (не блокирует backup).

**Риски:** VACUUM lock ~1с на текущем размере БД (10-50MB) — manual button с confirm prompt. Video TTL 7d→3d может вызывать re-mux редко replay'ленных видео (acceptable trade-off). Log retention 14d — короче на бОльших инцидентах (operator может override через env).

**Не сделано:** predictive disk-fill alert (PROD-019 частично), explicit logrotate config — application-level cleanup делает ос-side избыточным. Backup card cosmetic 🚨 на dev (нет /var/backups/catalyst локально) — intended.

---

## 2026-05-28 · sonnet · Bundle #10: DB constraints + retention — FK=ON + notifications UNIQUE + 4 prune loops

**Цель:** Закрыть DB-005 (FK enforcement), DB-007 (notifications duplicate race), DB-008 (notifications growth), DB-009 (3 audit-style tables retention).

**Файлы:**
- `scripts/migrate-db-constraints-2026-05-28.sql` (new) — idempotent: orphan sweep (11 tables) + notifications dedup + `CREATE UNIQUE INDEX idx_notifications_dedup`. Запускается оператором на VPS перед deploy через `sqlite3 catalyst.db < ...`. Транзакционно, можно re-run.
- `src/db/schema.sql` — +1 `CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup` для fresh installs.
- `src/db/database.js` — constructor: +2 PRAGMA (`foreign_keys = ON`, `busy_timeout = 5000`). `recordNotification` → `INSERT OR IGNORE`. +4 prune methods (`pruneNotifications` 30d / `pruneFeedbackVotes` 90d / `pruneXAnalysisHistory` 90d / `pruneTagRefreshHistory` 365d).
- `src/index.js` — +4 startup prune calls + 4 daily setInterval'ы (по B2 паттерну).

**Деплой:** оператор-driven. Order: (1) backup DB, (2) `sqlite3 < migration.sql`, (3) `PRAGMA foreign_key_check` (expect 0), (4) `deploy.ps1`.

**Риски:** FK=ON может ломать existing parent-delete code paths если orphans есть. Migration sweep'ит orphans перед PRAGMA flip. `busy_timeout=5000` — concurrent writes теперь блокируются до 5с вместо immediate `SQLITE_BUSY` (net positive при текущем write volume).

**Не сделано:** VACUUM/log rotation/video cache cleanup (Tier 3 #6). Explicit `ON DELETE CASCADE` дополнения на FK без cascade — out of scope. Unit tests prune-методов — defer to B18 QA infra.

---

## 2026-05-28 · sonnet · Bundle #15: Bot resilience — 429 retry + broadcast 403→suspended

**Цель:** Закрыть BOT-006 (TG 429 не honor'ится) и BOT-007 (broadcast 403 не маркирует suspended).

**Файлы:**
- `src/notifications/telegram-retry.js` (new, ~40 LOC ESM) — `withTelegramRetry(sendFn, opts)`: 1 retry на 429, honor `retry_after` (cap 60s), fallback 5s. Non-429 → immediate re-throw.
- `src/notifications/telegram.js` — import + 6 wrap sites в `sendAlertToUser` pathway (sendMessage в `_sendPlainTextChunked`, sendVideo, sendMediaGroup, 3× sendPhoto).
- `src/admin/server.js` — import + wrap broadcast `bot.sendMessage` + extend catch с `UPDATE users SET status='suspended' WHERE id=?` на 403, plus `logger.warn` на suspend. SPA gate ✅.
- `src/notifications/admin-alert.js` — import + wrap `_bot.sendMessage` в `notifyAdminCrash`.

**Деплой:** не задеплоено. Оператор закоммитит и развернёт через deploy.ps1.

**Риски:** retry cap 60s prevents bot freeze on absurd `retry_after`. 1 retry max prevents storm amplification. 403 теперь auto-suspends в broadcast — мониторим что не помечаем массово легитимных юзеров после первого batch (acceptable since 403 = реально заблокированы).

**Не сделано:** BOT-021 (global token bucket) отложен. При текущем масштабе (5-50 users) шанс 429 низкий; после BOT-006 retry это реактивно покрыто. Реассесс при scaling > 200 users или если 429 retry начнёт срабатывать заметно часто.

---

