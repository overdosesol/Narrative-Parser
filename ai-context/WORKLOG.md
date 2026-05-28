# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 безархивации. Полная история — в git.

Если задача мелкая, например передвинуть кнопку в дашборде или изменить немного текст в промпте для llm, можно сразу не записывать в WORKLOG, а подождать пока накопится около 5 мелких правок или 1 большая и записать всё вместе.

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

## 2026-05-28 · sonnet · Bundle #11 — A11y compliance sprint (UX-002, UX-006, UX-012, UX-013, UX-017, CAT-001, CAT-008)

**Цель**: Закрыть 7 audit finding'ов accessibility в dashboard SPA — focus trap, semantic landmarks, skip link, heading hierarchy, role/tabIndex для clickable divs, CatMascot aria-hidden + reduced-motion extension.

**Метод**: subagent-driven (sonnet оркестратор, haiku/sonnet implementers, SPA-trap territory). 7-task bundle: T1 `useFocusTrap` hook → T2 apply к 5 modals → T3 App root semantic + skip link + CSS → T4 heading swaps → T5 clickable div fixes → T6 CatMascot aria + reduced-motion CSS → T7 docs. Per-task `npm run check:spa` validation после каждого edit'a SPA template.

**Scope decision**: **Dashboard SPA only**. Admin SPA имеет 0 a11y baseline (0 role, 0 aria, 0 semantic HTML, 0 tabIndex) но НЕ в audit scope этого bundle. Defer.

**Spec divergence (T3)**: brainstorm subagent ошибочно сообщил class names `left-sidebar` / `main-panel` для top-level wrappers. Реальные классы — `sidebar` (уже `<aside>`!) и `main-feed` (уже `<main>`!). T3 implementer adapted — добавил отсутствующие `aria-label` + `id="main-content"` вместо полных swap'ов. Только `right-panel-sticky` (внутри `RightPanel` component, line 9965) реально нуждался в div→aside swap.

**Scope expansion (T4)**: `modal-section-label` имеет 9 occurrences (spec предполагал 2). Все 9 swapped div→h3 для consistency.

**Approach decision**: Roll-own `useFocusTrap` inline hook (~50 LOC) вместо external library. Соответствует established pattern Bundle #3/#13 — inline duplication в SPA template literal.

**Файлы**:
- `src/dashboard/server.js`:
  - **+`useFocusTrap` hook** inline после Bundle #13's ErrorBanner (line 7176). `useEffect`+`useRef` based. Captures opener element, cycles Tab/Shift+Tab, restores focus on cleanup. Focusable selector filters `:not([disabled])` + `offsetParent !== null`.
  - **5 modals wired**: Lightbox (~9001), TrendModal (~10447), AnalyzePanel (~11371), SettingsPanel (~11794), AccountPanel (~12238). Each: `const modalRef = useRef(null); useFocusTrap(modalRef, true);` + `ref: modalRef` на root panel/drawer div.
  - **Semantic landmarks** (line 14127 sidebar `<aside>`, line 14414 main-feed `<main id="main-content">`, line 9965 right-panel-sticky `<div>`→`<aside>`). CSS classes preserved.
  - **Skip link** `<a href="#main-content" className="skip-link">Skip to content</a>` first child of dashboard-grid (line 14124). CSS rules `.skip-link` + `.skip-link:focus` (lines 4969-4988) с offscreen-by-default + visible-on-focus pattern.
  - **Headings**: `right-section-title` (2 sites: lines 9972, 10007) `<span>` → `<h2>`. `modal-section-label` (9 sites) `<div>` → `<h3>`.
  - **Clickable divs**: `.top-item` (line 9979) + interactive `.session-chip` (line 11379) теперь имеют `role="button"` + `tabIndex={0}` + `onKeyDown` (Enter/Space) handlers. Non-interactive session-chip instances (3 sites) — не трогали.
  - **CatMascot**: `aria-hidden="true"` (line 13288). Existing `@media (prefers-reduced-motion: reduce)` (line 6017-6019) extended с `.cat-mascot, .cat-mascot * { animation: none !important; transition: none !important; }`.
- `ai-context/SESSION_CONTEXT.md` — +1 bullet в Production posture.

**Деплой**: subagents file edits only. Operator commits selectively + deploys через `deploy.ps1`. Bundle #16 SPA gate валидирует SPA повторно. No env vars, no DB changes, no new deps. Admin SPA не задет (audit не включал admin в scope).

**Риски**: low. Tag swaps preserved className → CSS unaffected. `useFocusTrap` filters offscreen elements. Reduced-motion CSS только disables animations, не layouts. `try/catch` на focus restore handles edge cases (opener gone). 8 distinct edits в `src/dashboard/server.js`, все прошли SPA gate без revert'ов.

**Closes**: UX-002 (HIGH), UX-006 (HIGH), UX-012 (MEDIUM), UX-013 (MEDIUM), UX-017 (LOW), CAT-001 (MEDIUM), CAT-008 (LOW). 7 findings — Tier 2 закрыт (5/5 bundles done).

---

## 2026-05-28 · sonnet · Bundle #13 — Error visibility (ADM-001, UX-001, BOT-003, PROD-006, BOT-020)

**Цель**: Закрыть 5 high-severity finding'ов visibility — silent admin UI errors, silent feed errors, TG 4096 truncate drop, no admin crash alerts, per-user dispatch cascade.

**Метод**: subagent-driven (sonnet оркестратор, haiku для мехач задач, sonnet для SPA-trap territory + T4 multi-site replacement). 7-task bundle: T1 admin-alert.js module → T2 index.js wiring → T3 alert-dispatcher loop try/catch → T4 telegram.js 4096 truncate helper → T5 ErrorBanner в dashboard SPA + feed wire-up → T6 ErrorBanner в admin SPA + 3 page wire-ups → T7 docs. Per-task `npm run check:spa` validation после edit'a SPA templates (T5 + T6).

**Approach decision**: **No Sentry / no third-party SaaS**. Solo-dev масштаб — admin TG group (already configured via `config.support.groupId` для support bot forum-topics) — достаточная destination для crash visibility. Sentry легко reversible later (5-line init + npm install), но defer до реальной потребности.

**Scope expansions during execution**:
- T4 (telegram.js): план говорил 4 callsites, реально `sendAlertToUser` имеет 10 plain-message branches (video / album / single photo / no-image fallbacks). Все 10 replaced с `_sendPlainTextChunked` — иначе partial coverage BOT-003. Same pattern as Bundle #3 T4.
- T6 (admin SPA): 6 ErrorBanner usages (2 per page = empty-state + main-render) instead of plan's 3. Empty-state coverage необходим — без него "Нет данных" silent fail сохраняется. CSS использовал hex literals вместо `var(--red-rgb)` — admin SPA не имеет `--orange-rgb` / `--red2` / `--orange2` vars.

**Файлы**:
- `src/notifications/admin-alert.js` — **new** (~110 LOC, 3 exports: `initAdminAlerts`, `notifyAdminCrash`, `_resetForTest`). In-memory dedupe Map (fingerprint = errorName + stack first line, 5-min cooldown). Admin message сам truncates if > 4000 chars (avoid recursive 4096 hit).
- `src/index.js`:
  - +1 import + `initAdminAlerts(supportBot?.bot, config, logger)` после supportBot construction (line 166).
  - `uncaughtException` + `unhandledRejection` handlers (line 762-763 → 767-775) теперь log + `notifyAdminCrash`.
- `src/notifications/alert-dispatcher.js` — `for (const user of activeUsers)` loop body (line 177-461) wrapped в try/catch с `notifyAdminCrash` + continue. Cascade prevention для BOT-020. 3 internal `continue` statements semantically preserved.
- `src/notifications/telegram.js`:
  - +1 import.
  - New helper method `_sendPlainTextChunked(chatId, message, opts, ctx)` — truncate at 4090 + admin notify с full payload (sliced to 8000 chars).
  - **10** `bot.sendMessage(chatId, message, ...)` callsites within `sendAlertToUser` (line 1244+) заменены на `_sendPlainTextChunked`. Return value preservation для `sentMsg = await ...` patterns confirmed (6 такие assignment cases).
- `src/dashboard/server.js`:
  - Inline `ErrorBanner({message, onRetry, variant})` component после Bundle #3's URL safety helpers (~line 7159). Использует module-level `h = React.createElement` (dashboard pattern).
  - CSS `.error-banner.*` family (7 rules) добавлен в `<style>` block с `var(--red-rgb)` / `var(--orange-rgb)` references (vars exist в dashboard theme).
  - Feed error-bar (line 14335) заменён на `<ErrorBanner>` с `onRetry: refreshAll`.
- `src/admin/server.js`:
  - Inline duplicate `ErrorBanner` (mirror of dashboard) после первого `const h = React.createElement` (~line 2283). **Re-binds `h` locally** внутри своего тела — admin SPA pattern (каждый component re-binds `h`). Confirmed via runtime SPA validator.
  - CSS duplicate (hex literals: rgba(244,33,46,.08), #ff6b6b для red; rgba(255,167,38,.08), #ffcc80 для warn).
  - 3 page wire-ups: StatsPage (line 4703), DecisionsPage (line 4029), StatusBar (line 7246). Каждая — `error` state + setError в catch + 2 ErrorBanner renders (empty-state + main-render). StatusBar — variant 'warn' без retry (refresh через SSE).
- `ai-context/SESSION_CONTEXT.md` — +1 bullet в Production posture.

**Деплой**: subagents file edits only. Operator commits selectively + deploys через `deploy.ps1`. Bundle #16 SPA gate (`[1/5] Validating SPA syntax`) валидирует SPA повторно. Требует `SUPPORT_GROUP_ID` env var (уже configured для support bot) — если не set, `notifyAdminCrash` no-op'ит (boot warns once).

**Риски**: low. `notifyAdminCrash` все TG sends в try/catch — не cascade. Dedupe Map unbounded но 5-min retention + per-process restart = capped в практике. ErrorBanner inline duplicate — established pattern (Bundle #3 URL safety). Admin SPA CSS hex literals — visually consistent с другими error UI (red #ff6b6b, orange #ffcc80).

**Closes**: ADM-001 (HIGH), UX-001 (HIGH), BOT-003 (HIGH), PROD-006 (HIGH), BOT-020 (HIGH). 5 findings — все HIGH.

---

## 2026-06-07 · sonnet · Bundle #3 — URL safety helpers (BOT-001, BOT-002, SEC-006, BILL-001)

**Цель**: Закрыть 4 finding'а URL-handling — HTML attr escape (BOT-001), protocol whitelist (BOT-002, SEC-006), paywall gate на hover preview (BILL-001).

**Метод**: subagent-driven (sonnet оркестратор, haiku для мехач задач). 7-task bundle: T1 helpers → T2 formatter → T3-T6 dashboard SPA edits (4 JSX hrefs + 2 preview endpoints) → T7 docs. Per-task `npm run check:spa` validation gate (Bundle #16 SPA-trap defense) после каждого `src/dashboard/server.js` edit.

**Файлы**:
- `src/utils/url-safety.js` — **new** (~50 LOC, 3 exports: `escHtmlAttr`, `safeUrl`, `safeHref`).
- `src/notifications/formatter.js` — import + line 145 теперь `if (safeUrl(trend.url))` + `safeHref()` в `<a href>`. Если URL невалиден — линк скипается целиком (лучше тихий no-link чем TG 400 на alert).
- `src/dashboard/server.js`:
  - Inline duplicate `escHtmlAttr`/`safeUrl`/`safeHref` в `_buildSPA` template после `BOT_USERNAME` injection (SPA не может ESM-импортить).
  - `href: safeHref(...)` применён к 4 JSX hrefs: feed action button (~9799), modal source link (~10657), X-trends top tweets (~10753), AnalyzeResult hero (~11419). Quality reviewer обнаружил 2 дополнительных миссы поверх изначальных 2 audit'ных — расширили scope чтобы полностью закрыть SEC-006.
  - `_handleTweetPreview` (~1334): `getPlanEntitlements().sources.includes('twitter')` gate → 403 если нет.
  - `_handleRedditPreview` (~1396): аналогичный `'reddit'` gate (consistency — reddit пока в free, gate rarely rejects, future-proofing).
- `ai-context/SESSION_CONTEXT.md` — +1 bullet в Production posture.

**Деплой**: subagents file edits only, no commits. Оператор сам деплоит через `deploy.ps1` после ревью. Bundle #16 SPA gate (`[1/5] Validating SPA syntax`) в deploy script повторно проверит SPA как defense-in-depth.

**Риски**: low. URL constructor throws → `try/catch` returns null → graceful. SPA template литерал не задет (helpers без backticks/template syntax, валидатор подтвердил после каждой правки). Reddit gate безвреден (reddit в free.sources). TG bot link skip — лучше чем 400. Inline duplicate в SPA — established pattern (LIFESPAN_VALUES, CatMascot FSM), drift отслеживается quarterly drill (DEPLOY.md §6.6).

**Closes**: BOT-001 (HIGH), BOT-002 (HIGH), SEC-006 (MEDIUM), BILL-001 (HIGH). 4 finding'а одним bundle'ом.

---

