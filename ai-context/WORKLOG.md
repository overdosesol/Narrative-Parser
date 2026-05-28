# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 безархивации. Полная история — в git.

Если задача мелкая, например передвинуть кнопку в дашборде или изменить немного текст в промпте для llm, можно сразу не записывать в WORKLOG, а подождать пока накопится около 5 мелких правок или 1 большая и записать всё вместе.

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

## 2026-06-07 · sonnet · Bundle #2 — Observability persistence (BILL-002, ADM-002, ADM-005, COST-003, PIPE-016)

**Цель**: Закрыть 5 finding'ов критической observability — audit log на plan changes, alert decisions persist, cost counter persist, atomic transactions.

**Метод**: subagent-driven (sonnet оркестратор, haiku для мехач задач, sonnet для SPA-trap territory). 9-task bundle: T1 schema + migration → T2 6 new DB methods → T3-T4 upgradePlan/confirmPaymentAndUpgrade transactions → T5 _setUserPlan atomic + audit → T6 alert dispatcher dual write → T7 cost counter Map→DB swap → T8 housekeeping intervals → T9 docs. Per-task verification via Node REPL in-memory DB tests + `npm run check:spa` после edit'a dashboard/server.js (T7).

**Spec divergence**: spec'овские helper modules (`src/db/audit.js`, `src/billing/usage.js`) **отброшены** — проект не имеет singleton `db` export (создаётся в `src/index.js:37`, передаётся как ctor param). Все DB calls через `this.db.<method>` / `db.<method>`. Методы добавлены прямо на `TrendDatabase` class. -2 файла, matches existing pattern.

**T7 bonus**: implementer обнаружил 2 пропущенных в плане Map references (lines 1703 + 2065 — `shouldShowUsageCounter` readout paths). Применил тот же DB swap, иначе runtime TypeError. Scope расширен с 3 edit'ов до 5.

**Файлы**:
- `src/db/schema.sql` — +3 `CREATE TABLE IF NOT EXISTS` + indexes (admin_audit_log, alert_decisions, feature_usage_log).
- `scripts/migrate-audit-log-2026-06-07.sql` — **new** idempotent migration script (operator one-off; также re-creates on boot).
- `src/db/database.js` — +6 методов на `TrendDatabase`: `recordAuditEvent`, `recordAlertDecision`, `recordFeatureUsage`, `getRecentFeatureUsageHits`, `pruneAlertDecisions`, `pruneFeatureUsageLog`. `upgradePlan` wrapped в `db.transaction()` + audit write. `confirmPaymentAndUpgrade` writes audit inside existing transaction (atomic с payment confirm + plan update).
- `src/admin/server.js` — `_setUserPlan` wrapped в transaction + audit для free/admin path. Paid path делегирует на `db.upgradePlan` (уже atomic от T3).
- `src/index.js`:
  - `recordAlertDecision` function dual write — memory ring buffer для `/api/decisions` API + fire-and-forget `db.recordAlertDecision()`.
  - Housekeeping cron: +2 `setInterval` для `pruneAlertDecisions(14)` + `pruneFeatureUsageLog(7)` + boot-time one-shot calls.
- `src/dashboard/server.js`:
  - Удалены `_manualAnalysisHits` / `_catalystHits` Map fields.
  - 5 callsites swap: catalyst cap (~1670) + manual-analysis cap+cooldown (~1972) + 2 usage counter readouts (~1703 + ~2065).
- `ai-context/SESSION_CONTEXT.md` — +1 bullet в Production posture.

**Деплой**: subagents file edits only, no commits. Operator commits selectively. **CRITICAL**: после деплоя operator должен ОДНОКРАТНО запустить миграцию на VPS — `sqlite3 /path/to/catalyst.db < scripts/migrate-audit-log-2026-06-07.sql` (boot-time `_migrate()` тоже их создаст, но script даёт explicit DR step). Deploy через `deploy.ps1`, Bundle #16 SPA gate валидирует SPA повторно.

**Риски**: low/medium. Cap check теперь hits DB вместо Map — но composite index `(user_id, feature, ts DESC)` делает SELECT ~50µs. Fail-open on DB error (`getRecentFeatureUsageHits` returns `[]`) — better than lockout. Alert dispatcher dual write fire-and-forget — log loss non-fatal. Atomic transactions для `_setUserPlan` — strict gain (previous state allowed half-applied plan changes). Memory ring buffer `appState.alertDecisions` сохранён для `/api/decisions` API — нет breaking changes на dashboard side.

**Closes**: BILL-002 (HIGH), ADM-002 (HIGH), ADM-005 (HIGH), COST-003 (HIGH), PIPE-016 (info, intended). 5 findings одним bundle'ом.

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

## 2026-06-06 · sonnet · Bundle #19 — Dead code cleanup (QUAL-005/006/007/011 + SD-23 + chained dead const)

**Цель**: удалить мёртвый код в dashboard SPA (~24 LOC + chained 8 LOC bonus) + 1 stale CSS comment update + 1 doc annotation. Tier 2 #19 из `docs/audit/INDEX.md` — самый высокий ROI Tier 2 (7.0).

**Контекст**: Stage 11 audit пометил функции и CSS классы от прошлых iterations (R4 redesign + ранние UX experiments). Haiku-grep валидация подтвердила 0 actual usages для всех dead items до старта. Pure polish после foundation Tier 1 (Bundle #1/#16/#17 closed).

**Метод**: brainstorm (`docs/superpowers/specs/2026-06-06-dead-code-cleanup-design.md`) → 9-task plan (`docs/superpowers/plans/2026-06-06-dead-code-cleanup.md`), subagent-driven T1-T8, operator T9. Per-task `npm run check:spa` validation gate (Bundle #16 deploy gate) после каждого `src/dashboard/server.js` edit — раннее обнаружение SPA-trap. **6 server.js edits, все прошли SPA check без revert'ов.**

**Файлы**:
- `src/dashboard/server.js` (~-35 LOC + ~3 lines updated):
  - **T1** Updated CSS theme comment: "2 dark themes" → "3 themes (pulse default + ink + tide)" — QUAL-005 + SD-23
  - **T2** Deleted `.toolbar` CSS class (+ orphan section comment) — QUAL-007 part 1
  - **T3** Deleted `.kbd` CSS class — QUAL-007 part 2 (kbd_hint i18n key preserved — 2 usages)
  - **T4** Deleted `lifespanLabel()` function — QUAL-006 part 1
  - **T4.5** Bonus: deleted chained dead const `LIFESPAN_KEYS` (used only by deleted `lifespanLabel`) + its introducing comment. `LIFESPAN_VALUES` preserved (still imported + injected в SPA template)
  - **T5** Deleted `memeClass()` function — QUAL-006 part 2
  - **T6** Deleted `memeColor()` function (NOT const at line ~9617 — explicit verify const stays) — QUAL-006 part 3 + closes QUAL-011 (shadow risk resolved, only const remains)
- `ai-context/WORKLOG_ARCHIVE.md` (+1 bullet): annotation к R4 entry о partial coverage (~85% glyphs, 18 emoji остались per UX-003) — SD-14

**T7 (SESSION_CONTEXT useEffect count) — no-op**: drift не было (Stage 12 sync-pass уже резолвил это, либо документ изначально не упоминал точное число). Bonus discovery: реальный count в CatMascot = **14 useEffects** (audit assumed 11, actual differs). Out of scope, не правил.

**Verification**:
- SPA check (`npm run check:spa`) после каждого из 6 server.js edits → exit 0, без revert'ов
- Final cross-file review (sonnet): 7/7 checks pass — dead items count 0, live items count preserved, SPA OK, scope clean, diff sanity OK
- Char count baseline: Dashboard SPA 342963 → 342072 chars (≈ -1KB после deletes), Admin SPA unchanged 266605 chars

**Closed findings**:
- QUAL-005 (CSS theme comment updated to 3 themes)
- QUAL-006 (3 dead functions deleted: lifespanLabel, memeClass, memeColor)
- QUAL-007 (2 dead CSS classes deleted: .toolbar, .kbd)
- QUAL-011 (shadow risk resolved — function gone, only const memeColor remains)
- SD-14 (WORKLOG_ARCHIVE R4 annotation о ~85% coverage)
- SD-23 (resolved together с QUAL-005)
- **Bonus**: chained dead const `LIFESPAN_KEYS` (8 LOC) — not in audit, found by T4 subagent

**Не закрыто (deferred)**:
- QUAL-013 (useEffect count drift) — no-op в SESSION_CONTEXT, drift не existed. Bonus discovery (audit 11 vs actual 14) — отдельный mini-bundle если operator захочет.
- T9 operator smoke (final `npm run check:spa`, `npm run dev` startup, browser smoke) — ждёт operator.

**Tier 2 progress**: Bundle #19 closed (first из 5 Tier 2 bundles). Tier 2 remaining: #2 audit log persistence (~4h), #3 URL safety (~2h), #11 A11y sprint (~4h), #13 error visibility (~4h). Tier 2 total ~14h ahead.

**Риски/заметки**:
- SPA validation gate (Bundle #16) отработал идеально — каждый edit прошёл check:spa без откатов. Это validates наш design choice (T6 deploy hardening) — validators реально ловят bugs до того как они уйдут в прод.
- `const memeColor` at line ~9617 explicitly verified survived T6 delete. Usages on lines ~9747, ~9750 preserved.
- Chained dead code pattern: subagent T4 предупредил о LIFESPAN_KEYS становящемся dead после `lifespanLabel` delete. T4.5 cleanup'ил same session. Pattern для будущих bundles: после function delete grep всё что только эта функция использовала.
- `docs/superpowers/specs/2026-06-06-*.md` + `docs/superpowers/plans/2026-06-06-*.md` — planning artifacts, untracked. Operator может включить в commit Bundle #19 или оставить как pending.

---

## 2026-06-05 · sonnet · Bundle #17 — Cert + infra visibility (PROD-007/008/021 + DOC-003/004 + port drift)

**Цель**: версионировать prod nginx config в репо, добавить cert expiry monitoring + cron, задокументировать cert renewal + secret rotation SOPs. Tier 1 #17 из `docs/audit/INDEX.md`.

**Контекст**: prod nginx config жил только на VPS (`/etc/nginx/sites-available/catalyst`) → drift unrecoverable. HTTPS мог тихо умереть на 90д (нет alerting'а). Secret rotation был 1-liner stub в DEPLOY.md §10. Operator принёс prod nginx через `ssh cat` — bonus discovered drift в DEPLOY.md §4 (пример port 7357 vs real 8080, admin tunnel 8080 vs real 8081). Закрыли заодно.

**Метод**: brainstorm (`docs/superpowers/specs/2026-06-05-cert-infra-visibility-design.md`) → 7-task plan (`docs/superpowers/plans/2026-06-05-cert-infra-visibility.md`), subagent-driven T1-T6, operator-driven T7. Operator выбрал «Минимум» scope per Bundle #16 pattern (TG bot pings + auto-deploy nginx + external uptime monitor + DR section deferred).

**Файлы**:
- `scripts/nginx-catalyst.conf` (new, 56 lines) — exact prod copy + source-of-truth header (Bundle #17, manual sync procedure). Содержание: `server_name catalystparser.io www.catalystparser.io`, `proxy_pass http://127.0.0.1:8080`, certbot-managed TLS, set_real_ip_from 127.0.0.1, 4 X-headers + Authorization passthrough, HTTP→HTTPS redirect
- `scripts/check-cert-expiry.sh` (new, mode 100755) — bash + openssl s_client external check, exit 1 если < 14 дней (WARN_DAYS=14), exit 2 если fetch fails, log в `/var/log/catalyst-cert.log` через tee
- `DEPLOY.md` — port drift fix 4 + 1 bonus места (dashboard 7357→8080, admin 8080→8081, nginx proxy_pass пример, ssh tunnel пример, firewall comment) + new §4.2 TLS certificate renewal verification (~70 lines: install snippet, daily auto-check, manual verification, if-renewal-failed, nginx config in repo note) + new §10.1 Secret rotation (~50 lines: 12-key schedule table + 6-step per-key procedure + 5-step incident response)
- `ai-context/SESSION_CONTEXT.md` (+3 bullets, line 750) — Production posture: nginx config, Cert monitoring, Secret rotation — все ref на Bundle #17

**Деплой/проверка (T7 operator-driven)**:
- `scp scripts/check-cert-expiry.sh root@vps:/usr/local/bin/` + chmod +x → success
- Cron entry `/etc/cron.daily/catalyst-cert-check` создан, chmod +x → success
- Manual test: `ssh root@vps "/usr/local/bin/check-cert-expiry.sh catalystparser.io"` → `OK: catalystparser.io cert valid for 68 days (expires Aug 3 15:20:52 2026 GMT)`, exit 0. Comfortable margin (68 >> 14).
- nginx diff `ssh ... cat /etc/nginx/sites-available/catalyst` vs `scripts/nginx-catalyst.conf` → only diffs: новый header comment (intended) + cosmetic whitespace cleanup. Content semantically identical.

**Closed findings (audit series)**:
- PROD-007 (nginx config теперь в репо как `scripts/nginx-catalyst.conf`, manual sync задокументирован в DEPLOY.md §4.2)
- PROD-008 (daily cert expiry check via cron — warn если < 14д, верифицирован live: 68 days margin)
- PROD-021 (secret rotation полностью задокументирован в DEPLOY.md §10.1: 12-key schedule + per-key procedure + incident response)
- DOC-003 (DEPLOY.md §4.2 full cert renewal verification SOP)
- DOC-004 (DEPLOY.md §10.1 full secret rotation SOP)

**Bonus** (discovered during brainstorm, not in audit):
- DEPLOY.md §4 port drift: dashboard 7357→8080, admin 8080→8081, proxy_pass example, ssh tunnel example. **+1 subagent-discovered**: firewall comment line ("# DO NOT open 7357, 8080" → "8080, 8081"). 5 fix'ов total.

**Не закрыто (deferred)**:
- TG bot pings при cert expiry — Bundle #15 (Bot resilience) territory
- Auto-deploy nginx config через `deploy.{ps1,sh}` — требует `sudo nginx -t && systemctl reload nginx` логику; defer как риск сломать prod при broken config
- External uptime monitor (UptimeRobot/BetterStack) — operator может настроить отдельно при желании
- DR section в DEPLOY.md (VPS погиб целиком) — большой scope, отдельный bundle

**Tier 1 progress**: **Tier 1 fully closed** — Bundle #1 + #16 + #17. Все 5 critical audit'а серии разрешены (DB-001/003 false-positive, DB-002+004 Bundle #1, QUAL-001 Bundle #16). Operational readiness восстановлен. Tier 2 next: 5 bundles общим ~15h — #2 audit log persistence, #3 URL safety, #11 A11y compliance, #13 error visibility, #19 dead code cleanup.

**Риски/заметки**:
- T1 subagent потерял ` # managed by Certbot` коммент на `return 404;` строке (likely markdown rendering quirk при копировании из prompt). Controller post-fix'нул через targeted Edit. Cosmetic only — certbot CLI might re-add марк при следующем renewal.
- `scripts/nginx-catalyst.conf` теперь source of truth — если кто-то правит `/etc/nginx/sites-available/catalyst` на VPS вручную, drift молчит. Mitigation defer (можно добавить quarterly diff в drill procedure).
- Cert check использует GNU `date -d` — на BSD упадёт. Catalyst prod = Debian/Ubuntu (GNU), OK.
- В случае cron MAILTO not configured, operator проверяет `/var/log/catalyst-cert.log` руками. Pattern documented в §4.2.

---

## 2026-06-04 · sonnet · Bundle #16 — Deploy hardening (QUAL-001 + PROD-002/003)

**Цель**: интегрировать существующие SPA validators в обязательный deploy gate + sync drift между deploy.ps1 и deploy.sh. Tier 1 #16 из `docs/audit/INDEX.md` master backlog.

**Контекст**: validators (`scripts/check-dashboard-spa.cjs`, `scripts/check-admin-spa.cjs`) существовали с тех пор как backtick traps срабатывали 3 раза за неделю, но никогда не вызывались автоматически. Audit пометил это QUAL-001 (CRITICAL) — defensive infra без integration. PROD-003 — этот же gap с прод-стороны. PROD-002 — `.sh` отстал от `.ps1` (нет ServerAlive flags на scp, нет EvilCatPack/.claude/posts/ai-context в zip exclude).

**Метод**: brainstorm (`docs/superpowers/specs/2026-06-04-deploy-hardening-design.md`) → 7-task plan (`docs/superpowers/plans/2026-06-04-deploy-hardening.md`), subagent-driven для T1-T5, operator-driven для T7. T6 (synthetic negative test) skip'нут оператором — positive test уже показал что validators реально импортируют SPA и валидируют (342963 chars dashboard, 266605 chars admin).

**Файлы**:
- `package.json` (+2 lines) — `"check:spa"` chain + `"check"` umbrella alias
- `deploy.ps1` — новая `[1/5] Validating SPA syntax` phase + renumber [1/4]..[4/4] → [2/5]..[5/5]
- `deploy.sh` — симметричная `[1/5]` phase + ServerAlive flags на 4 scp calls + zip exclude расширен 4 entries (`.claude/*`, `posts/*`, `ai-context/*`, `EvilCatPack/*`)
- `DEPLOY.md` (+~6 lines в §7) — note о pre-deploy validation gate
- `ai-context/SESSION_CONTEXT.md` (+1 bullet) — Deploy gate в Production posture

**Verification**:
- Positive: `npm run check:spa` локально → exit 0, оба validators OK
- Cross-file review (sonnet): 8/8 checks pass — naming consistent, phases симметричны, ServerAlive 4/4, exclude list complete, docs cross-referenced
- Real deploy: `./deploy.ps1` показал `[1/5] Validating SPA syntax... → Dashboard SPA inner OK → SPA inner OK → SPA OK` → продолжил архивацию → завершился успешно

**Closed findings**:
- QUAL-001 (validators integrated в deploy gate) — **CRITICAL → resolved**
- PROD-002 (deploy.sh symmetric с deploy.ps1 — ServerAlive + exclude list)
- PROD-003 (pre-deploy validation now mandatory)

**Не закрыто (deferred)**:
- PROD-004 (rollback feature) — отдельный mini-PR на ~3-4h. Включает image tagging + DB backup hook + `--rollback` flag. Out of scope текущего bundle (operator выбрал «Минимум»).

**Series milestone**: после Bundle #16 **все 5 critical** из 12-stage audit разрешены. DB-001/003 = false-positive audit (prod уже OK), DB-002+DB-004 = Bundle #1, QUAL-001 = Bundle #16. Critical-free posture восстановлен.

**Bonus**: subagent fix T3 (deploy.ps1) добавил `Join-Path $LOCAL_DIR` (CWD-independence) + colored Write-Host для consistency с соседними блоками — улучшение из code review, не было в исходном spec.

**Риски/заметки**:
- Если validator сам падает (bug в check-*-spa.cjs) — блокирует deploy. Fallback: оператор может разово закомментить `npm run check:spa` блок в deploy.{ps1,sh}.
- `npm` теперь required на dev машине для deploy. Раньше можно было deploy без node (только scp/ssh).
- Phase renumber [1/4] → [1/5] — внутренние UX labels, никто на них не парсится.
- T6 (synthetic negative test) skip'нут оператором as nice-to-have, не блокер.

**Tier 1 progress**: Bundle #1 + Bundle #16 closed. Остались: #18 QA infrastructure (~3h) + #17 cert visibility (~3h).

---

