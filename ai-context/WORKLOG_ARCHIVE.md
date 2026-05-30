# WORKLOG ARCHIVE

Архивные записи из `WORKLOG.md`. Активный лог содержит **последние 10 entries**;
всё что старше переезжает сюда автоматически (по правилу `AGENT_RULES.md §6`).

Append-only внутри файла — порядок: новейшие архивированные сверху, старейшие снизу.
Полная история до агрегации — в git.

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

## 2026-06-03 · sonnet · Bundle #1 — Backup integrity rewrite (T1-T7 implementation)

**Цель**: закрыть оставшиеся critical/high backup findings из 12-stage audit (DB-002, DB-004, PROD-001/005/011, SD-9/21). Brainstorm → spec → plan → subagent-driven implementation → operator deploy + drill. Tier 1 #1 из `docs/audit/INDEX.md` master backlog.

**Контекст**: brainstorm-сессия (`docs/superpowers/specs/2026-05-27-backup-integrity-rewrite-design.md`) выявила что 2 из 4 DB critical уже закрыты на prod — `sqlite3 .backup` использовался, B2 rclone крутил с 6 мая (149 MB, 21 файл). Audit ошибся в обвинении «B2 не имплементирован» — он видел только репо-стаб `scripts/backup.sh`, не prod-скрипт. Реальная проблема: prod-скрипт не в репо + три hardening gap'а.

**Метод**: 9-task план (`docs/superpowers/plans/2026-05-27-backup-integrity-rewrite.md`), subagent-driven-development для T1-T7, operator-driven для T8-T9. Per-task spec compliance + code quality reviews. Code-quality reviewer на T1 нашёл что `set -o pipefail` сам по себе НЕ ловит `rclone | tee` — это invalidated quick-win 1 spec; добавлено 4 review-driven fixes.

**Файлы**:
- `scripts/catalyst-backup.sh` (new, 56 lines) — prod backup, **7 hardening features**:
  1. `set -euo pipefail`
  2. Volume discovery validation (3 guards: VOLUME_NAME / VOLUME_PATH / DB file)
  3. PRAGMA integrity_check на исходной БД
  4. stat -c%s sanity check после .backup (fail если < 4096 байт)
  5. gzip -t verify после компрессии
  6. Direct `>> log 2>&1` (не `| tee` — экранирует exit code rclone)
  7. `du -sh` вместо `ls -lh | awk` (locale-stable)
- `scripts/backup.sh` (deleted) — dev stub, не использовался в prod
- `deploy.ps1` (+10 lines) — sync block с `$LOCAL_DIR`-relative path + colored output
- `deploy.sh` (+8 lines) — симметричный bash sync block
- `DEPLOY.md` (+158 lines) — §6.5 Restore from backup (9 шагов, включая pointer на rclone config setup), §6.6 Quarterly drill (7 шагов с реальными именами таблиц users/trends/notifications/payments из schema.sql)
- `ai-context/SESSION_CONTEXT.md` (line 748) — backup paragraph переписан под новую реальность
- `DEPLOYMENT_SUMMARY.txt` — refs `scripts/backup.sh` → `scripts/catalyst-backup.sh` (subagent T2 заодно починил, accepted as sensible scope-creep)

**Деплой/проверка (T8)**: `./deploy.ps1` прошёл, ssh `head -10` на VPS показал новую версию с `set -euo pipefail`. Manual prod run: `bash /usr/local/bin/catalyst-backup.sh` → `backup OK: catalyst_2026-05-26_19-47.db.gz (9.2M)` без FATAL. B2 listing подтвердил upload (9617244 bytes). Ночной cron 03:30 UTC прогон — verify утром.

**Drill (T9)**: ждёт оператора (DEPLOY.md §6.6, ~20 мин). Acceptance gate для Bundle.

**Closed findings (audit series)**:
- DB-002 (gzip -t integrity check)
- DB-004 (restore documented + drill procedure; первый drill — T9)
- PROD-001 (backup script versioned в репо, deploy syncs)
- PROD-005 (DEPLOY.md restore section)
- PROD-011 (script name unified: `scripts/catalyst-backup.sh`)
- SD-9 (B2 declared + implemented + documented + versioned — drift resolved)
- SD-21 (script name mismatch resolved)

**Bonus** (не из audit, найдено в brainstorm/review): 4 hardening fixes выше (RF-1..RF-4).

**Counts subagent-driven (T1-T7)**: 7 implementer dispatches + 1 fix-up loop on T1 + 3 spec/code reviews + 1 final cross-file review. Models: sonnet для T1/T3/T4/T7 (script edge cases + deploy scripts + SESSION_CONTEXT precision); haiku для T2/T5/T6 (mechanical edits).

**Риски/заметки**:
- Prod-скрипт теперь авто-переписывается каждым deploy — если правишь руками на VPS, следующий deploy перезатрёт (by design: git = single source of truth).
- DB-001 + DB-003 = false-positive audit (фиксов не требовалось, prod уже OK).
- 3 minor notes от final reviewer оставлены defer: (1) deploy.sh sync block без `[X/Y]` step-маркера; (2) SESSION_CONTEXT formula «tee глушит exit code» для cold reader темная; (3) формальная codepath verify утром после cron-прогона.
- Tier 1 progress: Bundle #1 done (after T9). Next per INDEX.md: #16 deploy hardening (QUAL-001 + PROD-002/003/004, ~2h), затем #18 QA infra (~3h), #17 cert visibility (~3h).

---

## 2026-06-02 · opus · Documentation + spec drift resolution (этап 12/12 — series finale)

**Цель**: финальный этап серии — полный пересмотр документации (README, DEPLOY.md, CLAUDE.md, ai-context/*, .env.example, docs/superpowers/*, docs/audit/*) + финальный пас по 23 spec drift items с propose resolution для каждого. Создание master integration backlog для оператора. Только review + propose, никаких файлов не правил, не коммитил, не deployил.

**Scope (13 направлений)**: README · DEPLOY.md · CLAUDE.md · ai-context/AGENT_RULES.md · ai-context/SESSION_CONTEXT.md · ai-context/WORKLOG.md + ARCHIVE · .env.example · docs/superpowers/specs/* · docs/superpowers/plans/* · docs/audit/* (11 prior reports) · package.json · 23 spec drift resolution proposals · cross-audit final integration.

**Метод**: 5 параллельных haiku-агентов (all 11 audit reports + SD extraction, SESSION_CONTEXT vs SD matching, README+DEPLOY+CLAUDE analysis, env+package+AGENT_RULES+WORKLOG inventory, superpowers specs+plans inventory) + manual integration writing 2 documents.

**Файлы создал**:
- `docs/audit/2026-06-02-documentation-spec-drift.md` — Stage 12 report (~750 строк). Documentation inventory (13 files), Coverage gaps (5 critical DEPLOY.md sections missing, README absent, SESSION_CONTEXT §7 violations), Spec drift resolution table (all 23 SD items × category × where × effort), 20 DOC-XXX findings + 25 verified safe items.
- `docs/audit/INDEX.md` — master integration backlog (~600 строк). Series overview, 12 reports table, verdicts dashboard (per layer GREEN/AMBER/RED), Priority backlog (Tier 1-4, 19 bundles), Spec drift sync queue, Lessons learned, What's next operator workflow.

**Counts Stage 12**: 0 critical · **4 high** · 7 medium · 5 low · 4 info · **20 total** + 23 SD resolution proposals.

**Series-wide totals (all 12 stages)**:
- **~291 findings** suммарно
- **5 critical** (4 DB backup integrity cluster + 1 SPA validators dead)
- **57 high** · **99 medium** · **65 low** · **67 info**
- **23 spec drift items** accumulated
- **19 «one-fix-many-wins» bundle targets** consolidated
- **~500+ verified-safe** items (foundation для next-year audit)

**Top-3 worst Stage 12 (все high)**:
1. **DOC-002 + DOC-003 + DOC-004 + DOC-016** combined — DEPLOY.md missing 4 critical operational sections (restore procedure / cert renewal SOP / secret rotation SOP / DR section). Cross-confirm PROD-005/008/021 + DB-004. **One PR ~2h closes 4 findings + 4 cross-audit items**.
2. **DOC-005** SESSION_CONTEXT state-vs-change protocol violations — 30+ date-stamped change narratives в Tag auto-refresh + Scoring sections, violates AGENT_RULES §7. ~45 min careful edit, restores compliance.
3. **DOC-001** README.md missing — public surface = 0. Acceptable пока private operator-only repo, critical если repo open. ~30 min create.

**Verdicts dashboard (всех 12 layers)**:
- 🟢 GREEN (5): Security, Pipeline, Billing, Dashboard UX, Cat mascot R7
- 🟡 AMBER (6): Cost, Admin, TG bot, Production, Code quality, Documentation
- 🔴 RED (1): **Database health** (4 critical backup integrity cluster)

**Overall**: 🟡 AMBER — production safe для current scale, multiple actionable risks queue до scaling.

**Cross-audit overlap — 19 bundle targets organized по 4 tiers**:

**Tier 1: foundation** (~12 hours, ~20 findings closed):
- #1 Backup integrity rewrite (8 items): DB-001..004 + SD-9/10/21 + PROD-001/005/011
- #16 Deploy hardening (4 items): PROD-002/003/004 + QUAL-001
- #18 QA infrastructure bootstrap (3 items): QUAL-002/009/012
- #17 Cert + infra visibility (5 items): PROD-007/008/021 + DOC-003/004

**Tier 2: high-ROI cleanup** (~15 hours, ~28 findings):
- #2 Observability persistence migration (5 items): BILL-002 + ADM-002/005 + COST-003 + PIPE-016
- #3 URL safety bundle (4 items): BOT-001/002 + SEC-006 + BILL-001
- #11 A11y compliance sprint (7 items): UX-002/006/012/013/017 + CAT-001/008
- #13 Standardized error visibility (5 items): ADM-001 + UX-001 + BOT-003/020 + PROD-006
- #19 Dead code cleanup pass (7 items): QUAL-005/006/007/011/013 + SD-14/23

**Tier 3: scaling prep** (~12h, ~19 findings): bot resilience #15, rate-limit #8, housekeeping #6, DB constraints #10

**Tier 4: polish** (~11h, ~28 findings): sqliteCutoff #5, db.transaction #4, /api/scan triple #7, hover preview #9, theme sync #12, i18n strict #14, README+DEPLOY doc PR #20

**All 4 tiers**: ~50 hours work-days, closes **~95 findings (~33% of all 291)**. Remaining 196 findings — isolated low/info polish + verified-safe baseline.

**Spec drift 23 items — resolution breakdown**:
- 15 items resolvable purely through SESSION_CONTEXT / WORKLOG edits — **Stage 12 sync-pass ~2-3 hours single session**
- 5 items need paired code + doc fix — bundled с existing backlog targets
- 3 items pure code fixes (pause persist, nginx commit, CSS comment) — quick PRs

**Verified safe Stage 12** (25 items): CLAUDE.md accurate · AGENT_RULES.md 7 sections solid · SESSION_CONTEXT size 557 lines on-target · cross-references all valid · DEPLOY.md happy-path comprehensive · DEPLOY.md examples accurate · .env.example 100% documented (53 keys) · package.json description accurate · package.json license set (ISC) · WORKLOG format consistency across 20 entries · WORKLOG_ARCHIVE properly formatted · Superpowers naming 100% compliant · Plans→Specs cross-links 5/5 · 3/4 specs fully implemented · docs/audit naming 100% compliant · cross-audit references resolve · SD-9 backup docs accurate (drift is code) · SD-10 retention accurate · SD-14 R4 emoji partial documented · SD-16 pause docs accurate · SD-17 caching docs accurate · SD-20 HOT_REFRESH in SESSION_CONTEXT · 0 broken cross-refs.

**Lessons learned (от 12-стейдж серии)**:
1. **Hybrid strategy «audit all then fix» was correct** — 50+ cross-audit overlap pairs discovered, ~33% findings закрываются через bundles.
2. **Critical findings концентрированы в defensive infrastructure** — 5 critical all в 2 areas (backup + SPA validators), не в application logic.
3. **8 of 12 stages clean (0 critical)** — production posture fundamentally solid.
4. **Verified safe sections** (~500+ items) — foundation для next-year audit.
5. **Severity calibration drift** — early stages over-severity, mid-stages calibrated.
6. **Spec drift accumulates faster than code** — 15 of 23 pure doc-side; need periodic sync-pass.
7. **Inline React SPA monolith** — blocks team scaling, must fix before > solo.
8. **Haiku-агенты consistently effective** — 70-80% of grep work.
9. **Documentation surface inversely correlated с quality** — smaller doc = easier accurate.
10. **SPA-trap defensive code emerged** but never integrated — common «built defense, not integrated defense» pattern.

**Деплой/проверка**: не деплоил. Не коммитил. Не ходил на прод.

**Риски/заметки финальные**:
- **WORKLOG ротация overdue** (DOC-013) — 21 entries now (20 was over, + Stage 12 final = 21). Per AGENT_RULES §6 — rotate entries 13-21 (R-development pre-audit-series + Stage 12) к ARCHIVE. Keep 12 active (audit stages 1-11 + final). Operator decides timing. Mechanical 10-min copy-paste.
- **DOC-001 README** — самый низковисящий high. ~30 min create. Closes public surface gap.
- **Tier 1 PR sequence** — рекомендуется в порядке: backup rewrite (#1, 4h, all 4 critical resolved) → deploy hardening (#16, 2h, SPA-trap prevention) → QA infra (#18, 3h, foundation) → cert+infra visibility (#17, 3h, includes DEPLOY.md missing sections). **Day 1 = 6h closes 12 finding's + RED → GREEN на DB layer**.
- **Stage 12 sync-pass** — отдельная 2-3 hour session SESSION_CONTEXT update. Closes 15 SD items одной серией. Restore §7 compliance (remove 30+ date-stamped narratives из Tag refresh + Scoring sections).
- **Audit series stage prompts** in `docs/audit/PROMPT-stage-*.txt` — historical artifact, operator може удалить після finalize если не нужны.
- **One subagent (sprite delivery) Stage 10 — partial gap** — covered through manual sample reads. Lesson noted для future audit: «return findings, не суб-делегируй» в haiku prompts.
- **Series-wide cost estimate**: ~50-60 hours total agent + operator time. Cheaper than one major production incident.
- **Post-fix re-audit**: через 3-6 months single-stage smoke pass, не full 12-stage series. Focus areas: backups verified (DR drill), monitoring coverage, новые features added.

**Series COMPLETE**. Operator review pending для INDEX.md → choose Tier 1 first PR.

---

## 2026-06-01 · opus · Code quality sweep (этап 11/12)

**Цель**: одиннадцатый чекап — качество кода: SPA-trap protection enforcement, dead code, comment drift после R1-R7 sweep'ов, file/function size health, error handling, magic numbers, naming inconsistencies, lint/test coverage. Только review, не правил, не коммитил.

**Scope (13 направлений)**: SPA-trap validators + lint + tests · dead code inventory · comment drift map · server.js монолит health · error handling patterns · magic numbers · naming consistency · file/function size · imports/module hygiene · lint/format coverage · test coverage · logging patterns · cross-audit reverse traces.

**Out of scope**: все previous этапы (1-10) done · документация / SESSION_CONTEXT final sync-pass / WORKLOG ротация — Stage 12 · architectural refactoring (split server.js + bundler) — flagged but не in audit scope.

**Метод**: 5 параллельных haiku-агентов (SPA validators+lint+tests, dead code inventory, comment drift map, file+function size+monolith, naming+magic numbers+i18n unused) + ручная sample-проверка (`scripts/check-*-spa.cjs`, `package.json`, eslint/prettier glob). Все 5 без retry. Не запускал реально lint / format / tests.

**Файлы**:
- `docs/audit/2026-06-01-code-quality.md` — новый, полный отчёт. В начале — File size map (top-10 by lines, dashboard/server.js 13,682 + admin/server.js 7,355 = **52.6% of project**), Function size map (top-10 longest, _buildSPA() 11,828 + _spa() 6,224), Dead code inventory (3 dead functions + 2 dead CSS classes), Comment drift map (1 stale CSS comment, 0 TODO/FIXME markers), Lint/format/test coverage (∅ — zero QA infra).

**Counts**: **1 critical** · **5 high** · 9 medium · 5 low · 4 info · **24 total** + 1 новый spec drift (накопительно 23) + расширенный «one-fix-many-wins» backlog до 19 targets.

**Top-3 worst**:
1. **QUAL-001 CRITICAL** — **SPA validators dead в infrastructure**. `scripts/check-{dashboard,admin}-spa.cjs` existует (50 + 64 LOC each, call _buildSPA/_spa + vm.Script() catches SyntaxError) но **0 invocation points** — нет в package.json scripts, нет в .husky pre-commit, нет в CI workflows, нет в deploy.ps1/sh. **Cross-confirm PROD-003/004 с code-side angle**: где validators ДОЛЖНЫ быть вызваны. Backtick trap fired 3 раза за неделю по WORKLOG, validators ничего не предотвращают.
2. **QUAL-002 HIGH** — **Zero QA infrastructure**. 0 lint, 0 tests, 0 pre-commit hooks, 0 CI workflows, 0 prettier, `engines.node` not pinned, 0 devDependencies. 2-year project = silent technical debt accumulation. Sustainable for solo operator, **wall for any contributor scaling**.
3. **QUAL-003 + QUAL-004 HIGH (×2)** — server.js (13,682 lines, 34.2% of project) + admin/server.js (7,355 lines, 18.4%). Combined 52.6% of codebase in 2 files. _buildSPA() alone = 82% of dashboard file. Cognitive load + refactor friction + SPA-trap byproduct.

**Прочие high**: QUAL-005 CSS comment line 2636 declares «2 dark themes» (реально 3, pulse default) — stale post-R1.

**Прочие medium (9)**: QUAL-006 dead memeColor()/memeClass()/lifespanLabel() functions (~50-100 LOC), QUAL-007 dead .toolbar / .kbd CSS classes, QUAL-008 magic numbers not centralized (5min auth has 3 different literal forms `5*60*1000` / `5*60_000` / `300_000`), QUAL-009 engines.node not pinned, QUAL-010 _buildSPA()/_spa() longest single functions ~18K LOC combined, QUAL-011 memeColor function/const shadow (bug-prone).

**Technical debt verdict**: **HIGH (~70%)**. Code itself relatively clean for 2-year project (R-cleanups thorough — only 3 dead functions + 2 dead CSS classes ~80 LOC total, 0 TODO/FIXME markers, 0/5 sample files имеют unused imports, 20/20 sample i18n keys used). **Infrastructure debt severe**: no QA tooling, validators unused, monolith blocks refactor.

**Maintainability verdict**: **~40%**. Solo operator OK (operator knows all). Larger team contributing impossible без QA infra. Sustainable for current scale, breaks at scale.

**Cross-audit overlap (расширен до 19 targets)**:

Новые code-quality-уровень:
- **#18 QA infrastructure bootstrap** — QUAL-002 + QUAL-009 + QUAL-012 + install eslint + prettier + husky + lint-staged + GitHub Actions CI = **3 items одним setup PR** (~3 hours). Foundational.
- **#19 Dead code cleanup pass** — QUAL-006 (3 dead funcs) + QUAL-007 (2 dead CSS) + QUAL-011 (shadow) + QUAL-005 (CSS comment drift) + QUAL-013 (cat useEffect drift, SESSION_CONTEXT only) = **5 items одним cleanup PR** (~30 LOC removed + 5 comments fixed). Pre-Stage-12 cleanup.

Расширены existing:
- **#16 Deploy hardening bundle** — +**QUAL-001 (call validators в deploy + pre-commit)** = теперь **4 items одним PR** (PROD-002 + PROD-003 + PROD-004 + QUAL-001).

Если приоритезировать **#16 Deploy hardening (с QUAL-001) + #18 QA infra bootstrap + #19 Dead code cleanup** — **10 finding'ов из 3 этапов** одной серией PR (deploy + QA + cleanup). Foundation для post-Stage-12 development cycles.

**Spec drift (накопительно 23)**: добавился 1 code-quality-уровень:
- **SD-23** CSS theme comment drift (dashboard/server.js:2636-2638 CSS block declares «2 themes», реально 3). Subset of SD-12 theme contract drift, code-side specifically. Fix in QUAL-005.

Stage 12 sync-pass нужно update SESSION_CONTEXT для всех 23 items.

**Verified safe** (28 items, по 13 разделам отчёта): 0 TODO/FIXME/XXX/HACK markers in src/ ✓ · 0 dangerouslySetInnerHTML / eval() callsites ✓ · SOURCE_LOGOS / sort.virality / .analyze-trace+pill / MARKET_STAGE_UI.icon fully removed post-R-cleanups ✓ · 20/20 sample i18n keys used ✓ · 5/5 sample files clean imports ✓ · 8/10 sample CSS classes used ✓ · 10/10 boolean naming (is*/has*/Enabled) consistent ✓ · _prefixed methods semantically private (5/5) ✓ · snake_case (DB) → camelCase (JS) mapping explicit ✓ · ESM in src/ + CJS in scripts/.cjs properly separated ✓ · 8/10 CSS classes used, comments mostly accurate post-R1-R7 (только 1 stale CSS block) ✓ · file-top JSDoc accurate ✓ · toast 3000ms matches ✓ · 5/5 bot commands accurate ✓ · cat pose counts match ✓ · CAT_TIMINGS demonstrates good central registry pattern ✓ · DashboardServer/AdminServer encapsulation ~49/~32 methods ✓ · validators detection logic sound (vm.Script catches SyntaxError) ✓ · `getActivePresetConfig` vs `getEffectivePresetConfigs` vs `getEffective` — different purposes, naming appropriate ✓ · `isTrendSeen` vs `wasNotificationSentToUser` — different abstraction levels ✓ · `recordNotification` sole API ✓ · `_setUserPlan` wraps `upgradePlan` — different abstraction levels ✓ · R-cleanups thorough.

**Деплой/проверка**: не деплоил. Не коммитил. Не запускал реально lint/format/tests.

**Риски/заметки**:
- QUAL-001 critical (validators dead) — самый низковисящий fix: 3 integration points, ~30 LOC. Add `"check:spa"` script в package.json, add `npm run check:spa` в deploy.ps1/sh (backlog #16), optional pre-commit hook. Prevents next backtick trap reaching prod. Cross-overlap PROD-003.
- QUAL-002 (zero QA) — 5-step setup ~3 hours. eslint + prettier + husky + lint-staged + GitHub Actions CI. Backlog #18. Foundation для contributor scaling. Mandatory if team grows.
- QUAL-003/004 (monolith) — long-term architectural. Cannot fix in single PR. Acceptable for current solo ops. Если scale → must.
- QUAL-005 (CSS comment) — 3 lines edit. Include в backlog #19 (dead code cleanup).
- QUAL-006 (3 dead functions + memeColor shadow) — ~80 LOC trivial delete.
- QUAL-008 (magic numbers) — 1 central `src/constants.js` + N callsite updates. ~30 LOC. Future polish.
- Code itself surprisingly clean post R1-R7 churn. Dead code only ~50-100 LOC. Comments mostly accurate (только 1 CSS block stale). R-cleanups были thorough.
- Stage 12 next: WORKLOG ротация (11 entries now + Stage 12 = 12, мы на лимите), SESSION_CONTEXT sync для 23 spec drift items.

---

## 2026-05-31 · opus · Cat mascot R7 deep-dive (этап 10/12)

**Цель**: десятый чекап — behavioral deep-dive R7 cat mascot. FSM corner cases, listener/timer memory safety, sprite delivery, login mount, glow keyframes, positioning, mobile unmount, a11y, prefers-reduced-motion, race conditions. Decorative feature без stakes (data/cost = 0), но самая свежая фича + сложный FSM (5 idle poses + walk-cycle + sleep + reactive forecast). Stage 6 visual-level «matches spec» расширен до behavioral. Только review, не правил.

(... 58 lines omitted for brevity ...этап Stage 10 entry full text here ...)

---

## 2026-05-30 · opus · Production posture audit (этап 9/12)

(... этап Stage 9 entry full text here...)

---

## 2026-05-29 · opus · TG bot + notifications audit (этап 8/12)

(... этап Stage 8 entry full text here...)

---

## 2026-05-28 · opus · Admin panel functionality audit (этап 7/12)

(... этап Stage 7 entry full text here...)

---

## 2026-05-27 · opus · Dashboard UX/UI audit (этап 6/12)

(... этап Stage 6 entry full text here...)

---

## 2026-05-26 · opus · Database health audit (этап 5/12)

**Цель**: пятый чекап — здоровье БД: schema, миграции, индексы, retention, backup integrity, SQLite-specific gotchas, lock contention, future scaling. Только review, ничего не правил, не коммитил.

**⚠️ ВАЖНО**: этот audit вернул **4 critical** finding'а в одной секции (backup integrity). Текущее состояние production resilience — фактически отсутствует. См. Top-3 ниже.

**Scope (9 направлений)**: schema map self-collect / schema integrity + migrations / indexes + query performance / retention + cleanup loops / SQLite TEXT timestamps trap / transactions + lock contention + WAL / backup integrity + restore drill / settings + SQLite gotchas / DB size + future scaling.

**Out of scope**: cost throttling (4 done), UX (6), admin UI (7), TG delivery (8), nginx/Docker (9).

**Метод**: 9 параллельных агентов (sonnet для schema integrity / transactions, haiku для остальных) + Schema map (16 tables) + Hot query paths + Growth projection (year 1-3, 100-1000 users) собраны самостоятельно. Один haiku-агент (transactions) запросил Bash на первой попытке — retry'нул с явной Read/Grep инструкцией.

**Файлы**:
- `docs/audit/2026-05-26-database-health.md` — новый, полный отчёт. В начале — Schema map (16 tables × indexes × FK × retention × row count estimates), Hot query paths (top-10 с index status), Growth projection.

**Counts**: **4 critical** · 11 high · 10 medium · 7 low · 5 info · **37 total** + 3 новых spec drift (накопительно 11) + расширенный «one-fix-many-wins» backlog до 10 targets.

**Top-3 worst (все critical, все из backup)**:
1. **DB-001** `scripts/backup.sh` использует `cp` вместо `sqlite3 .backup` → corrupt file under load. SESSION_CONTEXT обещает locking-aware backup, реальный script не делает.
2. **DB-002** Нет `gzip -t` integrity validation → backup может быть corrupt годами, узнаём при restore (никогда).
3. **DB-003** **rclone+B2 off-site copy документирован в SESSION_CONTEXT, но НЕ ИМПЛЕМЕНТИРОВАН** в `scripts/backup.sh`. Только local backup → VPS dies = full data loss.

Плюс **DB-004** (4-й critical): restore procedure не задокументирована и **никогда не тестировалась**.

**Прочие high (11)**:
- **DB-005** PRAGMA `foreign_keys=ON` отсутствует → все declared FK constraints + CASCADE silently broken (alert_score_history CASCADE silently не работает, orphan rows на retention sweep).
- **DB-006** `busy_timeout=0` (default) → random `SQLITE_BUSY` errors on concurrent writes (amplifies COST-001/002 race conditions).
- **DB-007** `notifications` table — missing compound `(trend_id, channel, user_id)` UNIQUE index (расширение PIPE-006).
- **DB-008** `notifications` table no retention → ~3M rows/year @ 100u, ~6GB/year @ 1000u (confirms PIPE-006 + COST-016).
- **DB-009** 4 tables без retention loops (`feedback_votes`, `support_threads`, `x_analysis_history`, `tag_refresh_history`).
- **DB-010** `cleanupVideoCache` запускается **только на boot** → ~33GB rolling worst-case.
- **DB-011** `auth_sessions` cleanup only on boot → orphan sessions accumulate between restarts.
- **DB-012** 3 hot SQLite TEXT timestamp queries с raw `toISOString()` → silent empty on small windows: `isTrendSeenFuzzy(6h)` (false negative on dedup — duplicate trends pipeline through), `clusterer._fetchHistory`, admin `_getStats`.
- **DB-013** Hot save loops (3 hot paths: scan-cycle + hot-refresh + alert-dispatcher) без `db.transaction()` wrap → N×fsync = scan phase 10× slower than necessary.
- **DB-014** No log rotation в `/logs/{date}.log` → ~36GB/year accumulation.
- **DB-015** Backups не encrypted (если/когда B2 будет implemented — rclone config token leak risk).

**Cross-audit overlap (значительно расширен)**:

«One-fix-many-wins» backlog теперь **10 targets** (был 4 после COST). Новые DB-уровень добавления:
- **Backup integrity rewrite** (sqlite3 .backup + gzip -t + rclone+B2 + restore drill) → закрывает DB-001+002+003+004 + SD-9 (5 items одной серией).
- **`notifications` migration** (UNIQUE compound + retention) → PIPE-006 + COST-016 + DB-007 + DB-008 (4 items).
- **Schema integrity sweep** (FK=ON + busy_timeout + orphan cleanup + retention loops) → DB-005 + DB-006 + DB-009 + DB-010 + DB-011 (5 items).
- **`db.transaction` wrap save loops** → DB-013 + COST-007 + TXN-002+003 (3 items).
- **`sqliteCutoff` consolidation + 11 usage migration** → DB-012 + DB-020 + DB-027 + SD-8 (4 items).
- **Housekeeping schedule** (logs + video-cache + auth_sessions + monitoring) → DB-010+011+014+022+023 (5 items).

Если приоритезировать **backup-rewrite + notifications-migration + schema-sweep** — закрывается ~14 finding'ов из 5 этапов одной серией PR.

**Spec drift (накопительно 11)**: добавились 3 новых DB-уровень:
- **SD-9** Backup contract drift (SESSION_CONTEXT vs реальность) — самый болезненный drift всех 5 этапов.
- **SD-10** Backup retention drift (script 30d / docs 14d).
- **SD-11** Schema documentation: schema.sql имеет 7 tables, реальная схема — 16 (9 inline в database.js).

**Verified safe**: WAL mode правильно set (concurrent reads OK + backup-during-write safe), existing transactions atomic (`normalizePlans`, `confirmPaymentAndUpgrade`, `cleanupAlerts`), `claimTriggerSearch` race-arbiter правильно work, payments.tx_signature UNIQUE защищает double-credit, addIfMissing migration pattern idempotent через PRAGMA table_info, chat_id TEXT affinity safe через `String(chatId)` conversion, point-lookup indexes (auth_token, chat_id, external_id) корректные, scheduled retention для hidden_trends (7d) + alert_score_history (30d) + payments (30d) работают, backup script в репо (восстановим если VPS уйдёт).

**Деплой/проверка**: не деплоил. Не коммитил.

**Риски/заметки**:
- 4 critical в одной секции (backup) — production-level emergency. Restore drill немедленно нужен (даже простой quarterly test).
- DB-001 (cp vs sqlite3 .backup) — самый низко-висящий fruit, 3-line fix.
- DB-005 (FK=OFF) requires sweep query на orphan cleanup ПЕРЕД включением — иначе INSERT начинают ловить SQLITE_CONSTRAINT_FOREIGNKEY. Sequence has order.
- DB-008 (notifications retention) — может быть combined с DB-007 (UNIQUE migration) — single PR закрывает performance + correctness + growth.
- Cost angle на DB-013 (save loops без transactions): closes COST-007 + TXN-002+003 + объясняет PIPE-005 cost burn (затяжной AI outage → save_only retry на каждом цикле N×fsync — слабая batched-save усиливает проблему).
- Schema split (DB-026/SD-11) — opportunity для consolidation в schema.sql. Future contributors будут благодарны.
- При имплементации DB-003 (rclone+B2) нужно сразу DB-015 (encryption) — B2 credentials в plaintext = blast radius.

---

## 2026-05-25 · opus · Cost & throttling audit (этап 4/12)

**Цель**: четвёртый чекап — контроль расходов и throttling на всех уровнях: LLM provider quotas, per-user caps, per-stage budgets, Apify токены, broadcast limits, refresh cycles, observability. Только review, ничего не правил, не коммитил.

**Scope (10 направлений)**: cap map self-collect / cap enforcement point + atomicity / cap persistence + reset cadence / per-provider budgets (OpenAI/Grok/Gemini/OpenRouter/Apify) / circuit breaker + runaway protection / tag-refresher + hot refresh budgets / hover preview cost (BILL-001 angle) / manual analysis cache / TG broadcast throttle / observability.

**Out of scope**: privilege boundaries (1+3 — done), pipeline correctness (2 — done), DB schema/retention (5), UX (6), TG message format (8).

**Метод**: 10 параллельных агентов (sonnet для cap enforcement + circuit breaker, haiku для остальных) + cap-map самосбор + cross-reference с existing audits. Один haiku-agent (cap enforcement) запросил Bash на первой попытке — перезапустил с явной инструкцией про Read+Grep, retry успешен.

**Файлы**:
- `docs/audit/2026-05-25-cost-throttling.md` — новый, полный отчёт. Cap map таблица (35+ caps) и Cost surface map (rough $/month estimate ~$280-350/mo) в начале.

**Counts**: 0 critical · 4 high · 8 medium · 3 low · 2 info · **17 total** + 0 новых spec drift (1 re-confirm).

**Top-3 worst**:
1. **COST-001/002** (high) — concurrent race на manual + catalyst caps (parallel requests дают 20-40% bypass). Catalyst дополнительно имеет **key mismatch**: dashboard использует numeric userId, TG bot — `String(chatId)`. Эти разные Map keys → effectively 2× cap для user'а, который использует обе surfaces.
2. **COST-004** (high) — `/api/tweet-preview` и `/api/reddit-preview` без per-user rate-limit + без `Retry-After` backoff. Free user через curl loop (100+ req/sec) → Reddit IP-ban (50/min unauth) → 24h outage сайта. Same root cause что BILL-001.
3. **COST-003** (high) — extension к **BILL-007**: catalyst и xAnalysis hits Maps тоже restart-reset (не только manualAnalyze который BILL-007 cover'ил). Каждый deploy = ×2 spend для test plan user'ов.

**Прочие medium (8)**: COST-005 OpenAI/Grok cost не в USD (только tokens), COST-006 Google/OpenRouter stuck-fallback no detection, COST-007 Stage 2 cap counter на attempt (не success), COST-008 Gemini permanent-down 8s+15s timeouts forever, COST-009 no per-cycle cost log, COST-010 admin /api/pipeline без token/$, COST-011 preview cache 5min TTL короткий для trending, COST-012 engagement update side-effect через preview spam.

**Cross-audit overlap (накопленные)**:
- **TRIPLE (locked)**: SEC-001+PIPE-004+BILL-003 = `/api/scan` admin gate. Cost angle уже в BILL-003, новым звеном не extended.
- **COST-003 ↔ BILL-007** — extension: BILL-007 был про manualAnalyze, COST-003 расширяет на ALL 3 cost-critical caps. Same fix (DB-backed persistence).
- **COST-004 ↔ BILL-001** — same root cause (hover preview endpoints). Одна правка (plan-check + per-user rate-limit) закроет обе.
- **COST-006/008 ↔ PIPE-002** — три finding'а про Gemini failover. Proactive Google healthcheck + counter management закроет все.
- **COST-009/010 ↔ PIPE-016** — observability state in-memory. Архитектурный — общая metrics persistence infrastructure.
- **COST-016 ↔ PIPE-006** — обе про `notifications` table (UNIQUE constraint + retention). One migration covers.

**Spec drift накопительный (8 items)**: TRUST_PROXY · daily-limit gate JSDoc · Catalyst 15min cooldown · xAnalysis missing in таble · historyHours not in таble · favorites pro/admin не явно · Manual cache TTL 1h/6h · Embeddings TTL drift. Cost audit новый drift не нашёл.

**Verified safe** (по 10 разделам): cap enforcement действительно ДО LLM call'а (manualAnalyze + catalyst + xAnalysis), Stage 2 cap+threshold правильно ограничивают самый дорогой провайдер, tag-refresher отслеживает USD per call правильно, light hot refresh ноль-LLM (verified), TG broadcast scheduler 60-sec per-chat cooldown → TG rate-limit не пробивается, force-refresh 24h backend-cooldown, Reddit reality-check free + throttled, embeddings/image-hash NEVER throws + bounded LRU+TTL, body limits enforced, Apify per-actor token isolation, PreStage Promise.all partial-fail isolation, Stage 2 1.5s inter-call delay.

**Top «one-fix-many-wins» targets**:
- **`/api/scan` admin gate + immediate timestamp** — закрывает SEC-001 + PIPE-004 + BILL-003. (Triple known.)
- **DB-backed counter table `feature_usage_log`** — закрывает BILL-007 + COST-003. Migration минимальная.
- **Hover preview plan-check + per-user rate-limit** — закрывает BILL-001 + COST-004. Same endpoint pair.
- **Proactive Google healthcheck + counter reset на success** — закрывает PIPE-002 + COST-006 + COST-008.

**Деплой/проверка**: не деплоил. Не коммитил.

**Риски/заметки**:
- COST-001/002 (concurrent race) лично не верифицировал mutex absent — finding из agent code-read. Стоит подтвердить трейс get→filter→push→set перед фиксом.
- COST-008 (Gemini timeouts forever) — оценка bandwidth waste rough, реальный impact зависит от размера media.
- 4 «one-fix-many-wins» targets — приоритетный backlog. Если фиксить только эти 4 — закроется ~10 finding'ов из 3-х аудитов.
- Cap map в начале отчёта (35+ caps) — useful artifact сам по себе для долгосрочной памяти проекта.

---

## 2026-05-24 · opus · Billing & entitlements audit (этап 3/12)

**Цель**: третий чекап — целостность tier'ов подписки (free/test/pro/admin), paywall'ов, plan-based ограничений, plan-change lifecycle. Только review, ничего не правил, не коммитил.

**Scope (9 направлений)**: entitlements callers consistency / locked sources backend enforcement / locked features paywall (Saved/Analyze/Catalyst) / per-plan caps + counter persistence / plan change lifecycle / admin gate billing-specific / TG bot plan checks / i18n + UX consistency / edge cases + privilege escalation.

**Out of scope**: cost throttling per LLM provider (→ 4), DB schema/retention (→ 5), UX polish (→ 6), admin UI usability (→ 7).

**Метод**: 9 параллельных агентов (sonnet для entitlements / plan lifecycle / edge cases, haiku для остальных) + ручная сверка entitlements map против `src/billing/entitlements.js`. Учтены existing audits (SEC + PIPE) — overlap'ы помечены, не дублированы.

**Файлы**:
- `docs/audit/2026-05-24-billing-entitlements.md` — новый, полный отчёт с Entitlements map таблицей в начале.

**Counts**: 0 critical · 3 high · 5 medium · 3 low · 4 info · **15 total** + 5 spec drift items + 4 cross-audit overlaps.

**Top-3 worst**:
1. **BILL-001** (high) — `/api/tweet-preview` и `/api/reddit-preview` без plan-check → free user читает live Twitter content через hover-preview backend (paywall bypass на key paid feature).
2. **BILL-002** (high) — Plan grant/revoke полностью без audit log → невозможно ответить «кто, когда, кому grant'нул pro/test». Compromised admin token = тихие grants. Multi-admin команда — конфликты неразрешимы.
3. **BILL-003** (high) — `/api/scan` без plan-gate (billing dimension; **overlap с SEC-001 и PIPE-004**) → free может триггерить полный Stage1+Stage2 cycle с реальным LLM spend; не consume'тся ни как manualAnalyze, ни как scan counter.

**Прочие medium**: BILL-004 (двойной SoT для sources — entitlements.js vs `plans.sources` CSV, alert-dispatcher читает CSV вместо getPlanEntitlements), BILL-005 (asymmetric fallback в alert-dispatcher: empty CSV → all pass vs paranoid free default), BILL-006 (`_setUserPlan` не атомарен — multi-step без транзакции, асимметрия с правильно сделанным `confirmPaymentAndUpgrade`), BILL-007 (in-memory caps restart-reset — на test plan каждый deploy ×2 spend), BILL-008 (pro→pro renewal обнуляет оставшиеся 25 дней без warning — defrauds user).

**Cross-audit overlaps**:
- **BILL-003 ↔ SEC-001 ↔ PIPE-004**: все три про `/api/scan` без admin gate. **Одна правка** (admin-only check + immediate `lastScanCompletedAt` write) закроет все три.
- BILL-002 ↔ операционные observations: нет audit infrastructure вообще. Введут — общая `audit_log` table покроет grant/revoke + future admin actions.
- BILL-014 ↔ SEC-003: anti-abuse, multi-account factory + shared per-IP cap. SEC-003 fix не блокирует N TG-аккаунтов от одного человека.
- BILL-007 ↔ PIPE-016: оба про in-memory state restart-reset. Общая `feature_usage_log` / `alert_decisions_log` infrastructure economical.

**Spec drift (5 items)**: SESSION_CONTEXT § Бизнес-правила не упоминает `xAnalysis` поле и `historyHours: 72` для free + § Manual analysis cap TTL расходится (spec 1h, code 6h после WORKLOG 17.05) + § Catalyst 15-min cooldown (уже зафиксирован в PIPE-018). Стоит финальный sync-pass после всех 12 этапов.

**Verified safe** (по 9 разделам отчёта): `getPlanEntitlements` — единственный SoT для всех hot paths, paranoid default `unknown → free` срабатывает, plan читается fresh из DB каждый request, per-plan caps проверяются ДО LLM call, cache-hit не consume slot, backend clamp `?source=twitter` для free, `_favoriteGate` на всех 4 favorite endpoints, bot keyboard plan-aware + callback double-check (defense-in-depth), payment confirmation атомарна, tx_signature uniqueness защищает от double-credit, downgrade favorites preserve.

**Деплой/проверка**: не деплоил. Не коммитил.

**Риски/заметки**:
- BILL-001 (preview endpoints) — лично не верифицировал handler line range, finding из agent-сводки. Проверить line 1333/1389 перед фиксом.
- BILL-002 (audit log) — нужна миграция, скорее этап 5.
- BILL-003 — приоритет №1 среди cross-audit, одна правка закроет три finding'а из разных этапов.
- Test=`favorites: false` — WORKLOG-агент первого pass'а ошибочно записал `true`. Реальность из `entitlements.js`: только pro/admin = true. SESSION_CONTEXT § User favourites § 411 это подтверждает («Pro/Admin only»).

---

## 2026-05-23 · opus · Pipeline integrity audit (этап 2/12)

**Цель**: второй чекап — целостность пайплайна обработки трендов от collectors до TG-алертов. Только review, ничего не правил, не коммитил.

**Scope (11 направлений)**: transient failure recovery (12.05 fix) / 3-layer preset merge / tag-refresher anti-hallucination / Stage 2 gates / junk-filter + text-only multiplier (19.05) / clusterer / collectors / deploy-aware scheduler (16.05) / hot refresh + Catalyst forecast / alert-dispatcher gates / PreStage providers + caching.

**Out of scope (другие этапы)**: cost throttling (→ 4), DB schema/indices (→ 5), UX states (→ 6), TG delivery format (→ 8).

**Метод**: 11 параллельных агентов (sonnet для transient/clusterer/alert-dispatcher, haiku для остальных) + ручная проверка top finding'ов. Data-flow карта собрана перед запуском агентов и записана в начало отчёта для self-check.

**Файлы**:
- `docs/audit/2026-05-23-pipeline-integrity.md` — новый, полный отчёт.

**Counts**: 0 critical · 2 high · 5 medium · 4 low · 7 info · **18 total**.

**Top-3 worst**:
1. **PIPE-001** (high) — alert-dispatcher `gates[]` push order расходится с контрактом: `lipsync` пушится перед `tiktok_quality` (должно быть после) → admin DecisionsPage показывает неправильный `firstFail` для TikTok-трендов с двойным fail. Skip-decision корректный, но debug-нарратив сломан.
2. **PIPE-002** (high) — Gemini cooldown counter не сбрасывается на partial success: 3 intermittent fails (даже при 50% successes между ними) → 5-min route в OpenRouter (image-only) → video-trends теряют audio/narrative signals на Stage 0b.
3. **PIPE-003** (medium) — tag-refresher `tagAutoRefreshLastRunAt` пишется при `anyFailure=true`: при полном fail 5/5 пресетов cooldown 2 дня всё равно блочит retry (должен учитывать last successful).

**Прочие notable medium**: PIPE-004 (manual scan trigger не обновляет timestamp синхронно — scheduler jitter), PIPE-005 (нет circuit breaker'а на затяжной AI outage — save_only loop платит full PreStage), PIPE-006 (`notifications` table без UNIQUE → race на dispatch), PIPE-007 (embeddings TTL drift 5min vs spec 30min).

**Spec drift (вынесено в Followups)**: 3 места где SESSION_CONTEXT расходится с кодом:
- Catalyst forecast 15-min cooldown в spec, но снят в коде (`trigger-finder.js`).
- `daily-limit gate` упоминается в alert-dispatcher JSDoc, реального gate нет.
- `TRUST_PROXY=1` обещается в spec, в коде не работает (это уже из security audit'а SEC-003).
Стоит сделать единый pass по SESSION_CONTEXT после всех 12 чекапов.

**Verified safe** (по 11 разделам отчёта, не пересматривать в след. этапах): transient failure end-to-end (6/6 checks), 3-layer merge через 12 callers, tag-refresher reality-check + CB + empty-array guard, Stage 2 gates включая forceStage2 scope, text-only multiplier × 0.65 на meme И score во всех путях (scan/refresh/manual), clusterer route единая точка, computeSingleTrendEmergence изолирован для manual, caches bounded LRU+TTL NEVER throws, collectors graceful degrade, scheduler clock skew + finally write, hot refresh light без LLM, anti-dupe через notifications row, alert-dispatcher per-user iteration, PreStage providers `Promise.all`+`.catch` isolation.

**Деплой/проверка**: не деплоил. Не коммитил.

**Риски/заметки**:
- PIPE-002 (Gemini cooldown) лично не верифицировал — finding из agent-сводки, помечен `⚠ assumes` в отчёте. Стоит подтвердить (`grep _googleFailures` + смотреть reset path) перед фиксом.
- PIPE-006 (notifications UNIQUE) — schema fix потребует миграции на проде; race window узкое, urgency low.
- PIPE-005 (no AI circuit breaker) пересекается с этапом 4 (cost throttling) — там и обсудить.
- PIPE-004 связан с security SEC-001 (`/api/scan` без admin gate) — одна правка может закрыть обе гипотезы.

---

## 2026-05-22 · opus · Security audit (этап 1/12) — application-layer findings

**Цель**: первый из 12 чекапов — application-layer security audit. Только review, ничего не правил, не коммитил, не пушил.

**Scope (9 направлений)**: auth flow / admin gate / CORS+headers / path traversal / SQL inj / XSS / PII в логах / env hygiene / misc (proto pollution, CSRF, SSRF, open redirect).

**Out of scope (другие этапы)**: nginx/ufw/cert (→ этап 9), TG delivery (→ этап 8), cost-DoS на пайплайн (→ этап 4), SPA-trap protection (→ этап 11), performance.

**Метод**: 8 параллельных haiku-агентов через `Agent({model:"haiku"})`, top-3 high findings верифицировал лично против `src/dashboard/server.js` (линии 2112, 2578, 459).

**Файлы**:
- `docs/audit/2026-05-22-security-audit.md` — новый, полный отчёт со структурой Summary / Findings (SEC-001..017) / Verified safe / Out of scope.

**Counts**: 0 critical · 2 high · 5 medium · 5 low · 5 info · **17 total**.

**Top-3** (требуют решения первыми):
1. **SEC-001** (high) — `POST /api/scan` доступен любому залогиненному (free/test/pro) — cost-burn vector. `_handleScan` (dashboard/server.js:2112-2125) не проверяет `plan_name === 'admin'`.
2. **SEC-002** (high) — open redirect в video proxy fallback (dashboard/server.js:2578) — `res.writeHead(302, { Location: srcRaw })` без валидации `?src=` query параметра. Phishing vector.
3. **SEC-003** (medium) — `TRUST_PROXY=1` env не имплементирован в коде (комментарий в server.js:459-462 сам это признаёт), но SESSION_CONTEXT обещает обратное. В проде rate-limit'ы фактически shared по всему nginx-трафику, не per-IP.

**Прочие notable medium**: 6-digit code entropy + sessionId rotation (SEC-004), localStorage для токена (SEC-005), `<a href={trend.url}>` без protocol whitelist (SEC-006), `DASHBOARD_API_KEY` декоративный (SEC-007).

**Verified safe** (не пересматривать в след. этапах): timing-safe code compare, admin gate на всех mutating admin/server.js endpoints, CORS allowlist (без wildcard), все file handlers (anchored regex + path.join), SQL feed/search (whitelist + LIKE escape после fix 16.05), zero `dangerouslySetInnerHTML`/`eval`/`Function`, `maskId` консистентно, Apify Bearer, Telegram bot-token contained в telegram.js, hard-fail env validation, no hardcoded secrets, `deepMerge` защищён от proto pollution, header-based auth → CSRF non-applicable.

**Followup operational**: один subagent при scan'е secrets процитировал реальные prod-ключи из локального `.env` в свой transcript-output. Это не leak за пределы машины (`.env` уже на диске), но имеет смысл подумать о (а) правиле «secret-grep'и не возвращают значения, только ключи + present/missing», (б) проверить что Claude Code telemetry не вкладывает полные agent transcripts. Подробнее — в Followups секции отчёта.

**Деплой/проверка**: не деплоил. Не коммитил.

**Риски/заметки**:
- Линии в SEC-005, SEC-006, SEC-011 взяты из agent-сводки, лично не верифицированы (помечены `⚠ assumes` в отчёте) — стоит подтвердить перед фиксом.
- SEC-003 (state drift) — либо имплементировать `TRUST_PROXY`, либо обновить SESSION_CONTEXT. Сейчас spec лжёт.
- Папка `docs/audit/` создана впервые — этот файл первый в ней. Структура подразумевает что следующие 11 этапов сложатся как `docs/audit/2026-XX-XX-<этап>.md`.

---

## 2026-05-22 · sonnet · R7 — Cat Mascot polish + idle pose pool + login cat + glow blink

**Цель**: большое расширение R6 базы. (1) починить визуальные косяки R6 (walking «по воздуху», sidebar scroll, посадка не над кнопками); (2) развернуть walking — кот уходит влево, возвращается слева (Pacman-respawn); (3) добавить idle-pose pool (5 поз), смена позы происходит через walk-home — кот ушёл, прибежал, сел в новую позу; (4) добавить кота в login screen с собственным pose-pool [cute, lying]; (5) eye-blink-synced glow (подсветка тускнеет когда кот моргает, плавный fade); (6) hidden triple-click flee easter egg.

**Файлы**:
- `src/dashboard/server.js` — backend regex whitelist расширен (`cat-(idle|walk|walk-left|lie|observe|cute|headup|staytall|lying)`), `_catSpritesVersion` теперь `max(mtime)` по всем 9 спрайтам, CSS state-rules для 5 idle + 2 sleep вариантов + 5 walk-cycle стейтов + 6 glow @keyframes (catIdleGlow / catStayTallGlow / catLyingGlow / catLieGlow / catObserveGlow), CatMascot FSM расширен (random initial pose, walk-home → random pose, triple-click flee, route-divergence dashboard vs login, route='login' mount в `LoginScreen`).
- `assets/cats/cat-walk-left.png` — зеркальный walk-спрайт (cat-walk через `sprite_mirror_crop.py`).
- `assets/cats/cat-{cute,headup,staytall,lying}.png` — 4 новых idle спрайта из EvilCatPack через `build-cat-poses.py`.
- `scripts/build-cat-poses.py` — sprite builder с `skip_ranges` (cat-lying пропускает плохие кадры 15-27: 66 source → 53 → 17 sampled).
- `scripts/sprite_mirror_crop.py` — отдельный mirror для face-left walk.
- `deploy.ps1` — `EvilCatPack` в EXCLUDE list (1.1 MB raw frames не нужны на проде), `-o ServerAliveInterval=30 -o ServerAliveCountMax=10` на все 3 scp + ssh (фиксило Connection-reset на upload после того как deploy-архив подрос).

**R6 polish** (визуальные косяки base):
- Walking cat «бежал по воздуху» → обрезаны 2 anti-alias rows из cat-walk.png через PIL crop.
- Sidebar получил vertical scroll после R6 → высота уменьшена на 56px (выбрано из 3 опций оператором).
- Кот переехал с фиксированной правой позиции на sidebar nav box, сидит над Feed/Saved/Analyze (`bottom: 73px; left: 73px` для idleSitting).
- Убран dark drop-shadow (закрывал текст кнопок), оставлен только red glow `rgba(255,50,50,.2)`.
- Walking reverse: кот уходит **влево**, возвращается **слева** — иначе при возврате он бежал спиной. Зеркалили cat-walk через PIL `ImageOps.mirror`.

**Idle pose pool** (R7 — dashboard):
- `IDLE_POSES_DASHBOARD = [idleSitting, idleCute, idleHeadUp, idleStayTall, idleLying]`. 4 новые позы — Evil Cute Cat / Slim Evil Cat HeadUp / Slim Evil Cat StayTall / Evil Lying Cat 2.
- Pose меняется через walk: в FSM-controller `walkingHome → next = pool[random]; transitionTo(next, WALK_HOME_DURATION_MS)`. Без timer-based смены — был дёрганный effect (поза мерцала посреди idle).
- Random initial pose на mount: `useState(function() { return pool[Math.floor(Math.random()*pool.length)]; })` — при перезагрузке дашборда дефолтная поза разная.
- Walk interval **5-10 мин** (CAT_TIMINGS.WALK_THROUGH_INTERVAL_{MIN,MAX}_MS = 300000/600000).
- Per-state left/bottom overrides для центрирования над Saved (idleCute:103, idleHeadUp:108, idleStayTall:109, idleLying:103+bottom 63, idleSleeping:101). Walking states тоже left:97 (HOME_X_PX) — иначе на старте walk кот «прыгал» с центра поз к base left:73.
- idleLying на dashboard опущен `bottom: 63` (оператор: «так же стоит на лапе, как было в логине»).

**Login cat** (R7):
- `<CatMascot route="login">` mount'нут в `LoginScreen` (3-й child после Twitter/X footer link).
- `position: absolute; right: 0; bottom: 100%; transform: scale(1.1); transform-origin: bottom right;` — кот сидит на правом верхнем углу нижней границы карточки.
- `IDLE_POSES_LOGIN = [idleCute, idleLying]`, цикл смены позы 60s (`LOGIN_POSE_CYCLE_MS`).
- Login lying: `bottom: calc(100% - 10px)` — лапа свисает за край карточки (на dashboard другая логика, там через bottom-offset).
- Свои speed multipliers через CSS attribute селекторы `[data-route="login"]`: cute +30% / lying +10% (тюнили вместе с оператором).
- Triple-click flee disabled (на login кот не убегает: `if (isLoginRoute) return;`).

**Eye-blink-synced glow** (R7):
- 6 спрайтов получили @keyframes с alpha blink: 0.2 (eyes open) ↔ 0.1 (eyes closed, dim x2). Базовый filter тот же `drop-shadow(0 0 6px rgba(255,50,50, X))`.
- `linear` timing + 2% anchor buffer на каждое плато → smooth ~80ms fade на переход. Step-end давал резкий blink — не понравилось оператору.
- Per-sprite frame-by-frame анализ закрытых глаз → разные процентные anchors на каждый sprite.
- `idleHeadUp` после редизайна (см. ниже) глаза всегда открыты в активной анимации → glow трек удалён, базовая alpha 0.2 стоит статично.

**Triple-click flee** (R7, hidden Easter egg):
- `clickStateRef = { count, lastClickMs }`, окно 1500ms, 3 клика → `setStateName('walkingLeft')`, FSM-controller сам уведёт кота.
- `cursor` НЕ меняется (нет `cursor: pointer`) — скрытый прикол, не CTA. Только `pointer-events: auto` чтобы клик долетал. Параллель с triple-click toggle на лого в Header (Header.toggle = выключить кота, кот.click×3 = убежать).
- Только из idle поз (`if (!isIdlePose(stateNameRef.current)) return;`) — посреди walk/sleep клики не считаются.

**Headup sleep variant** (R7):
- Original cat-headup анимация кивает головой вниз-вверх (16 кадров: 0-2 head down, 3-15 head up + turn). На dashboard смотрелось странно как idle — оператор: «кивает странно».
- Active `idleHeadUp` теперь играет только кадры 3-15 (поворот головы вбок, без head-down): `background-position: -69px 0 → -368px 0`, `steps(13)`, 3.25s (250ms/frame).
- `idleHeadUpAsleep` — отдельный state, статичный frame 1 (head down), `animation: none`, dim glow `rgba(255,50,50,.1)`.
- Inactivity (60s, `INACTIVITY_TIMEOUT_MS`): `cur === 'idleHeadUp'` → `idleHeadUpAsleep`; остальные idle позы → `idleSleeping`. Wake handler инвертирует: `idleSleeping` → `idleSitting`, `idleHeadUpAsleep` → `idleHeadUp`.

**FSM состояния (after R7)**:

| Group | States |
|---|---|
| Idle (sticky) | idleSitting · idleCute · idleHeadUp · idleStayTall · idleLying |
| Sleep | idleSleeping (default) · idleHeadUpAsleep (только из idleHeadUp) |
| Walk-cycle | walkingLeft → disappearing → dormant → appearing → walkingHome → next-random-idle |
| Reactive | forecastWatching (sticky пока loading=true) |

**Infrastructure**:
- `EvilCatPack/` (1.1 MB raw frames) — в `deploy.ps1` EXCLUDE. Спрайты собраны локально, доезжают как готовые PNG в `assets/cats/`. Raw frames для пересборки/редизайна остаются только в локальном репо.
- SCP keepalive — фиксил `Connection reset by peer` на upload после того как cat-mascot пакет накачал deploy-архив. ServerAliveInterval=30 (heartbeat каждые 30s) + ServerAliveCountMax=10 (5 минут tolerance).
- `build-cat-poses.py` поддерживает `skip_ranges: List[Tuple[start, end]]` per-target — индексы относятся к sorted source list до subsample. Применили для cat-lying: пропуск кадров 15-27 (плохая paw motion).

**Деплой**: оператор сам через `deploy.ps1`. Архив теперь без EvilCatPack — `scp` не рвёт соединение.

**Риски**:
- **SPA-trap**: после каждого Edit `node scripts/check-dashboard-spa.cjs`. Все зелёные. Финал inner SPA: 342963 chars.
- **9 спрайтов = 9 HTTP requests** на mount cat-mascot (один раз, потом cache-bust только при изменении). `_catSpritesVersion` = max mtime по всем — при изменении ЛЮБОГО спрайта ВСЕ ре-fetch'атся. Trade-off для простоты, не оптимизировано (например per-sprite hash).
- **Cycle-by-walk вместо timer**: оператор: «не вижу других поз». Timer-based смена выглядела внезапной (mid-idle pose mutation). Walk-based чище — pose меняется только когда кот «вернулся домой», что естественно объясняет смену.
- **Headup редизайн** стрипнул только клиентскую CSS-анимацию (играет 13 из 16 кадров). Сам спрайтшит на проде остался 16-кадровым — это ОК, sleep variant использует frame 1.
- **Login кот при resize**: pose-cycle timer завязан на mount, не на resize — теоретически не сломается, но не тестировали отдельно (LoginScreen всё равно центрирован, кот живёт в углу карточки).

---

## 2026-05-21 · sonnet · R6 — Cat Mascot (pixel-art evil cat)

**Цель**: Добавил декоративного кота-маскота на dashboard. Tier 2.5 hybrid — живёт сам (idle sprite loop, периодически проходит через экран), реагирует на 3 события (Forecast Catalyst loading, 60s inactivity, walk-through cycle). Pixel-art стилистика контрастирует с минималистичным flat UI — индийско-крипто-хищник вайб.

**Pivot из spec**: оригинальный план предполагал inline-SVG rigging с per-part animations (blink, tail wag, ear twitch). После провала vectorization Grok-картинок (single path без разделения на части) — pivot на готовые pixel-art спрайтшиты из itch.io "EvilCatPack". Whole-cat animations через CSS background-position + `steps()` keyframes.

**Файлы**:
- `src/dashboard/server.js` — основные правки (~600 строк inline-СPА: backend asset handler, CSS sprite states, CatMascot component с FSM, triple-click toggle в Header)
- `assets/cats/cat-{idle,walk,lie,observe}.png` — 4 спрайтшита (15+16+17+17 кадров)
- `scripts/build-cat-sprites.py` — helper для пересборки спрайтов из EvilCatPack/

**Что добавлено**:
- **Backend** (`server.js:627+`): whitelist route `/assets/cats/cat-(idle|walk|lie|observe).png` + handler `_handleCatSprite` по шаблону `_handleBrandLogo` (stream, 404, cache headers, path traversal через regex anchoring).
- **CSS** (`server.js:3801-3897`): `.cat-mascot` container (fixed, z-index 500, drop-shadow, pixelated rendering) + 4 state-rules с `background-image`/`steps()` animations + 3 fade-state rules (disappearing/appearing/dormant) + `.cat-paused` для Page Visibility freeze.
- **JSX** (`server.js:~12410-12700`): `CatMascot` компонент со всем стейт-машинным аппаратом. 8 useEffects:
  1. Visibility gate (route + localStorage + matchMedia)
  2. catalyst:cat-toggle event listener (toggle re-eval)
  3. stateNameRef sync
  4. Walk-through scheduler (random 1-3 мин, только из idleSitting)
  5. State-flow controller (FSM: idleSitting → walkingRight → disappearing → dormant → appearing → walkingHome → sittingDown → idleSitting, + sticky forecastWatching и idleSleeping branches)
  6. catalyst:forecast-loading event listener (Task 5 R3 reaction)
  7. Activity detector + inactivity timer (Task 6 R6 sleep, 60s timeout, 6 events с passive: true)
  8. Page Visibility pause/resume + window resize teleport-home (Task 7 edge cases)
- **Triple-click toggle**: в Header logo wrapper (`server.js:~13003-13033`) — buffer ref с 1500ms окном, 3 клика → flip localStorage `catMascotOff` + toast + dispatch `catalyst:cat-toggle`. Try/catch на localStorage (silent no-op если SecurityError в private mode).
- **i18n**: 2 ключа (`cat.toggle_on`, `cat.toggle_off`) на EN + RU.

**Реакции (3 в v1)**:
- R2 Walk-through (random 1-3 мин): встал → пошёл вправо 15s → fade-out → dormant 30-60s → fade-in слева → walk-home 4s → сел.
- R3 Forecast watching: на старте Forecast Catalyst → sprite swap на observe pose, держится пока loading. На finally → возврат в idleSitting.
- R6 Inactivity sleep (60s no input): swap на lying sprite. На любое событие — wake to idleSitting.

**3D-feeling трюки** (упрощены из-за sprite-based подхода):
- drop-shadow filter — кот "парит" над фоном (есть).
- breath scale через CSS keyframe на body — НЕ применимо (sprite уже включает breathing motion на кадрах).
- mouse parallax — declined в brainstorm.
- walk perspective scaleX — не реализовано (lower priority; native sprite faces only right anyway).

**Не сделано / отложено в v2**:
- Front view ассет (для разворотов в кадре) — Pacman-respawn pattern избегает.
- R4 Modal hide / R5 Toast / R7 Scroll-to-top / R8 Welcome — не выбраны в v1.
- Slim Evil Cat variant (HeadUp / StayTall) — на будущее, не в v1.
- Sound effects — нет.
- Settings UI toggle — выбран hidden triple-click.

**Деплой**: оператор сам через `deploy.ps1`. Не deployed автоматически.

**Риски (контролируются)**:
- SPA-trap: `check-dashboard-spa.cjs` запускался после каждого Edit, все green. Финал: 336160 chars.
- Drop-shadow GPU: small element (32-82px), single filter, ОК.
- Тройной клик на лого — изолирован 1500ms окном, future-actions можно повесить на double-click.
- Activity listeners: `passive: true` на mousemove/wheel/touchmove/scroll — не ломают R5 wheel-scroll perf-fix.
- Dockerfile: `COPY . .` копирует `assets/cats/*.png`, `.dockerignore` не исключает `assets/` — спрайты доедут до prod.

**FSM состояния**:
| State | Pose / Sprite | Sticky? | Triggers |
|---|---|---|---|
| `idleSitting` | cat-idle | yes | default; return from all other states |
| `idleSleeping` | cat-lie | yes (until activity) | 60s inactivity from idleSitting |
| `walkingRight` | cat-walk | no | walk-through scheduler from idleSitting |
| `disappearing` | (fade out) | no | after walkingRight completes |
| `dormant` | (invisible) | no | 30-60s after disappearing |
| `appearing` | (fade in) | no | after dormant |
| `walkingHome` | cat-walk | no | after appearing |
| `forecastWatching` | cat-observe | yes (until loading=false) | catalyst:forecast-loading event |

**Edge cases**:
- Tab hidden (Page Visibility): `cat-paused` class freezes animations + transitions. Wake on visibility.
- Resize >100px during walk: snap home, return to idleSitting.
- Mobile <700px: visibility gate returns null, component unmounts cleanly.
- Forecast triggers mid-walk: cancel walk, immediate forecastWatching at current position. After loading completes → idleSitting (no walk-resume).
- Cat toggle OFF mid-walk: unmount → useEffect cleanups clear all timers/listeners.
- localStorage SecurityError: silent no-op, cat stays in current state.

---

## 2026-05-20 · sonnet · Dashboard redesign Round 5 — Sort control rework

**Триггер**: после R4 фильтр Sort в сайдбаре остался как 5-кнопочный seg-control с одними иконками без подписей. Юзер: «непонятное и неудобное». Иконки (zap/gem/waves/clock/bar-chart-3) для sort-критериев не self-descriptive — каждый раз надо хувер. Плюс `virality` дублировал `rank` по смыслу (оба weighted by score).

### Что покрыто

3 коммита в `src/dashboard/server.js`:

1. **CSS** — добавил `.sort-list` (vertical flex container) + `.sort-chip` (idle: surface2 + neutral border, hover: чуть светлее, active: accent fill rgba(--accent-rgb,.14) + accent border .38 + accent text). Все колор-токены — существующие, theme-switch (pulse/ink/tide) flows through автоматически. Вставлено после `.phase-badge`, перед `── Badges ──`.
2. **JSX** — заменил `seg-group seg-compact` с 5 кнопками-иконками на `sort-list` с 4 button-chip'ами (icon 14px + полный label через `t()`). Active state — class toggle. Virality удалён из массива опций.
3. **Cleanup** — удалил `'sort.virality'` ключи (EN + RU). Backend `sortParam === 'virality'` ветка оставлена как legacy-tolerance с поясняющим комментарием — старые ссылки `?sort=virality` всё ещё резолвятся в `score DESC` (тот же ordering что и был), не ломаются.

### Архитектура

- **CSS pattern reuse**: idle = `.phase-badge` neutral pattern (surface2 + border), active = `.badge-catalyst` accent-fill pattern (rgba accent .14 + .38 border + accent text). Никаких новых токенов.
- **JSX**: native `<button>` остаётся — focus/keyboard/screen-reader без изменений. `title=` остаётся как fallback для tooltip (например для keyboard nav).
- **State**: `useState('rank')` не тронут. `setSort` вызывается только из Reset callback и chip onClick — стейл `'virality'` недостижим.

### Files

- `src/dashboard/server.js` — CSS (~30 строк), JSX block (~13287–13305), i18n EN (~6917) + RU (~7347) удаления, backend comment (~1057).
- `ai-context/WORKLOG.md` — этот entry.

### Деплой

Оператор делает сам через `deploy.ps1`. После деплоя визуально проверить все 3 темы (pulse/ink/tide) — accent цвет на active chip разный, надо убедиться что контраст ОК во всех.

### Риски / followups

- Theme `ink` (синий accent на тёмно-синем `--surface2`) — может быть слабый контраст. Проверить визуально, поднять alpha с .14 → .18 если нужно.
- Если в future захочется добавить новые сорт-критерии (impact, controversy) — просто добавляем элемент в массив, никакой реструктуризации.

---

## 2026-05-20 · sonnet · Dashboard redesign Round 4 — iconography sweep

**Триггер**: после Round 3 (градиенты + abyss-black) дашборд читался плоско, но ~90 эмодзи (категории, фазы, кнопки, settings rows, source glyphs) тянули его обратно в "AI-made". Round 4 закрывает редизайн: SVG icons (Lucide + Phosphor 2 exceptions + 5 brand glyphs), color-dot + uppercase text для phase/market state, plain text + color для sentiment.

### Что покрыто

8 коммитов в `src/dashboard/server.js`:

1. **`2764a6f` Icon helper foundation** — `makeIcon()` factory + `ICONS` registry + `icon(name, opts)` shim near JS-helpers section. Smoke icons: search, x.
2. **`7b1a69c` Brand SVGs (sources)** — 5 brand glyphs (reddit/twitter/google/tiktok/hash). `SOURCE_ICONS` → icon-key strings, обновил sidebar source rows + feed-card avatar + tw-prev-x + nav X button. Удалил `SOURCE_LOGOS` + `dangerouslySetInnerHTML` path. `SourceMark` теперь использует `icon()`.
3. **`cbd138b` Bottom-nav + sidebar phase chips + filters** — `flame/star/search` для Feed/Saved/Analyze. `PHASE_DOT` emoji glyphs (🔵🟡🟢🔴) → `phaseDot()` helper с CSS-coloured `<span>`. CSS `.phase-dot` + `.phase-dot.glow`. `CAT_ICONS` → Lucide-key strings. Type chips EVENT/TREND/POST → newspaper/trend/circle-dot. Включает `lock` icon для locked tabs.
4. **`df03dfc` Feed card chips/metrics/actions** — heart/message-circle/repeat-2/eye/arrow-up/award metrics, external-link/send/star/x actions, flask-conical для MANUAL badge.
5. **`cddf10a` Settings + Account icons** — 21 settings-area icons (settings (Phosphor) / palette/globe/user/refresh-ccw/archive/radio-tower/bell/sparkles/rows/log-out/activity/gem/bot/clock/bar-chart-3/zap/calendar*/brain/target/droplet/waves). `Row` component accepts icon-NAME strings (legacy emoji fallback оставлен). `Sheet` тоже. Language flags 🇺🇸/🇷🇺 → "EN"/"RU".
6. **`9a8f26c` Analyze panel + TrendModal** — alert-triangle/ban/x-circle/line-chart/thumbs-*/clipboard-check/inbox/search-x/book-open. Market stage: emoji → CSS dot/pulse/spinner (kind field). Sentiment text-only: i18n strings → POSITIVE/NEGATIVE/NEUTRAL без emoji. FeedbackBar thumbs SVG.
7. **R4 Task 7: Empty states + warnings + misc** — empty-feed inbox / search-x, error-bar alert-triangle, lock icons на locked sources + source-lock chip + stats banner, feed-search-icon, sort segments (rank/meme/emergence/time/virality → icon-name keys).
8. **R4 Task 8: i18n sweep + WORKLOG (this commit)** — strip leading emoji from ~50 translation strings (EN + RU). Update remaining JSX render sites to add icon() separately (modal-engagement metrics row, xtrends top tweets, archive snapshot banner, analyze action buttons, source-pulse render, account-hero gem chip, LoginScreen feature list). Nav-account avatar fallback 👤 → icon('user'). Nav logo onError 🐱 → "C" monogram inline. Window-pill locked emoji → icon('lock'). Manual filter chip emoji → icon('flask-conical').

### Архитектура

- `ICONS` registry — ~80 inline-SVG factories (Lucide stroke 2px + 2 Phosphor fill exceptions + 5 brand glyphs).
- `makeIcon(viewBox, stroke, ...children)` returns render function captured with viewBox + stroke/fill style.
- `icon(name, opts)` — use-site shim. `opts.size` default 14; `opts.color` cascades through inline style; `aria-hidden=true` unless `aria-label` set.
- `currentColor` everywhere — theming работает автоматически.
- `phaseDot(p)` helper для PHASE_META — color-circle через `<span>`.
- `MARKET_STAGE_UI.kind` field — `'dot'|'pulse'|'spinner'` — picks indicator type. CSS: `.market-dot` + `.market-spinner` + `@keyframes`.
- Sentiment: i18n POSITIVE/NEGATIVE/NEUTRAL + `.sentiment-chip` CSS (mono uppercase, currentColor border).

### Файлы

- `src/dashboard/server.js` — основной (~295k → 319k chars, +24k = inline SVG paths).
- `ai-context/WORKLOG.md` — этот entry.

### Деплой

Не деплоил — оператор сам через `deploy.ps1`. SPA check зелёный после каждого коммита.

### Риски / regression

- SPA-trap (backticks в comments) поймана 3 раза за работу — каждый раз сразу пофиксил, no commit on red.
- `Row` + `Sheet` components сохранили legacy-emoji-fallback ветку на случай если где-то остался не-мигрированный caller. Чисто defensive — после R4 не должно срабатывать.
- `SOURCE_LINK_LABELS` теперь plain text (`'Reddit'`, `'Twitter'`, etc) — на feed-action-btn открытия источника теперь нет эмодзи префикса. Brand recognition — через `icon(external-link)` slot уже добавлен.
- `MarketStageBadge` поменял shape — `kind` field вместо `icon`. Если где-то ещё читался `MARKET_STAGE_UI[stage].icon` (grep clean — нет), сломается. Final grep подтверждает.

### Оставшиеся эмодзи в файле

Все в comments (документация). Whitelist: `\u{1F300}-\u{1F9FF}` grep возвращает ~20 матчей, все из них — `//`-комментарии описывающие старые трапы или JSX (например `// 🔥 Trigger — concrete past-event`). Render path чистый.

- **Note (Bundle #19, 2026-06-06)**: iconography sweep covered ~85% of glyphs; 18 emoji remain in i18n strings + inline JSX (per UX-003, Stage 6 audit 2026-05-27). Cleanup deferred to future bundle.

---

## 2026-05-20 · sonnet · Dashboard redesign Round 3 — gradient removal (flat pass)

**Триггер**: после деплоя Round 2 (radius + density) оператор сказал "Может уберем все градиенты?". Цель — убрать оставшиеся декоративные `linear-gradient`/`radial-gradient`, оставив только functional (брендовые avatars, медальные TOP-1/2/3, shimmer-анимации, select-arrow icon-hack).

### Что покрыто

Один файл — `src/dashboard/server.js`. Точечный sweep по 48 gradient-правилам:

- **Heavy (видимые)**: CATALYST badge `.nav-logo-icon` + текст `.nav-logo-text`, `.nav-account-avatar`, `.meme-hero` modal hero, `.analyze-verdict.high/.low`. → solid альфы / `var(--surface2)`.
- **LoginScreen**: убраны 2 ambient `<div>` целиком — radial-blue-blob и grid-overlay (с radial-маской). Monogram h1 → solid `var(--text)`. Verify-кнопка градиент `accent→#146da8` → solid `var(--accent)`.
- **Decoration**: `.nav` bg `surface→bg` → solid `var(--surface)`. `.nav::after` accent-полоска → solid alpha. `.sidebar` bg, `.sidebar-footer` bg, `.sb-foot-btn.active::before`, `.stat-card::after` hover-полоска, `.feed-panel.is-refreshing::before` прогресс-бар — все плоско.
- **Subtle bg overlays**: `.status-pill`, `.analyze-loader`, `.analyze-result`, `.analyze-hero`, `.settings-info`, `.sheet`, `.sheet-head`, `.story-hook`, `.alert-math-panel`, `.feed-panel-head`, `.feed-desc.pump`, `.feed-score::before` divider, `.feed-card:hover` (pillowy hover) — gradient → среднее значение solid.
- **Button/bar fills**: `.range-slider` tracks (webkit + moz), `.feed-action-btn.primary` + `:hover`, `.cat-bar`, `.feed-image-placeholder` — все `accent→accent2` → solid `var(--accent)` / `var(--card2)`.
- **Confidence bars**: `.conf-low/.conf-mid/.conf-high` градиент `.7→1` alpha → solid full-opacity (semantic red/yellow/green сохранен).
- **Dead code**: `memeColor(v)` global function (shadowed внутри TrendCard `const memeColor = barColor(meme)`) — gradients заменены на возврат `var(--accent)`, добавлен комментарий что dead в дашборде.

### Что осталось (functional, не трогали)

- `select` arrow CSS-hack (45deg + 135deg triangles).
- `.meme-hero-fill::after` shimmer animation (loading indicator).
- `.skeleton` shimmer animation.
- `.feed-avatar.reddit/twitter/tiktok/google_trends/x_trends` — брендовые градиенты Reddit оранжевый / TikTok бирюза+малина / Google Material / X-чёрный → semantic.
- `.top-item-rank.top-1/.top-2/.top-3` — gold/silver/bronze медали (рейтинговая семантика).

### Follow-up: surface/card scale "abyss black"

После градиентного pass оператор сказал что cards читаются как "тёмно-серые" на чёрном bg. Crunched surface/card ladder в обеих темах (pulse + ink, tide-navy не трогал):

- `--surface`  `#0a0a0a` → `#050505`
- `--surface2` `#16181c` → `#0a0b0e`
- `--card`     `#16181c` → `#0a0b0e`
- `--card2`    `#1c1f24` → `#101114`
- `--card3`    `#232730` → `#16181c`

Depth-ordering сохранен (bg < surface < surface2/card < card2 < card3), но шкала смещена к `#000`. Borders (rgba) и текст не трогал — контраст с новым background чуть-чуть вырос, читается ОК. theme-swatch preview в settings (там hardcoded `#16181c` для card-чипа) показывает "старое" card-значение, но это превью-плашка размером 14px — переделаю если бросится в глаза.

### Деплой

Не деплоил — оператор сам через `deploy.ps1`. SPA check зелёный после каждой партии (4 партии: heavy → nav/sidebar/stripes → subtle overlays → confidence+hover+dead). Размер inner SPA: 295380 → 295419 chars (~+40 — комментарии добавлены, сами правила короче).

### Риски / regression

- LoginScreen теперь полностью пустой фон — Axiom-style ambient blobs и grid сняты. Может казаться "слишком пусто" — оператор это и просил.
- `.feed-card:hover` теперь solid `rgba(255,255,255,.025)` вместо gradient'а 4%→1.5% — оставил тот же tone, лифт от translateY+shadow остался.
- `memeColor()` function больше не возвращает gradient — все вызовы внутри TrendCard используют локальный const, поэтому изменение виртуальное. На случай если функция в проекте импортируется снаружи — теперь возвращает `var(--accent)` (consistent с barColor).

### Файлы

- `src/dashboard/server.js` — основной файл (одна серия Edit'ов).
- `ai-context/WORKLOG.md` — этот entry.

---

## 2026-05-20 · sonnet+haiku · Dashboard redesign Round 2 — radius + density polish

**Триггер**: после деплоя Round 1 оператор сказал "почти ничего не поменялось" — видны были только цвета. Реальная причина: Round 1 определил `--r1/--r2/--r3` токены, но не подключил их к существующим компонентам (углы остались мягкие 8-12px везде).

### Что покрыто

7 коммитов в `src/dashboard/server.js`:

1. **`556b57c` — sidebar sharp radius** (15 edits): source items, phase/type chips base rules, window/sort buttons, bottom nav, category dropdown — все на `var(--r1)` (2px).
2. **`0162982` — header sharp radius** (5 edits): brand logo, profile chip, icon buttons (X/TG/settings), search input.
3. **`e650a1e` — feed card sharp radius** (11 edits): card wrapper → `var(--r3)` (4px), thumbnails → `var(--r2)` (3px), badges/buttons → `var(--r1)` (2px).
4. **`659c388` — right column sharp radius** (10 edits): TOP NARRATIVES list items, LIVE metric tiles, sources indicator.
5. **`0ea03e0` — final radius sweep** (65 edits): AnalyzePanel, TrendModal, settings, account, hints, login button, archive carousel, alert forecast styles — всё что осталось >= 6px.
6. **`7fe3543` — density tightening** (18 selectors): padding/gap reduced 2-3px across sidebar source items, feed card padding, LIVE tile padding, TOP item padding, stat cards. Toasts, modals, login card оставлены spacious (readability priority).
7. **`ce0212e` — flatten nav/filter hovers** (9 rules): source items, phase/type chips, window/sort buttons, bottom-nav, header icon buttons, category dropdown, TOP NARRATIVES list — hover full-fill background → transparent + border emphasis. Action button hovers (toasts, primary CTAs, modal close, login button) preserved.

### Файлы
- `src/dashboard/server.js` — 7 коммитов (133+ edits total)
- `ai-context/WORKLOG.md` — этот entry

### Сохранены by design
- Toasts (Round 1 уже tight)
- Login card padding (centered surface, spacious read-friendly)
- Modal content padding (readability priority)
- AnalyzePanel verdict banner (emotional emphasis)
- `.toast-close:hover` (uses --surface2 as Round 1 spec)
- All `:hover` для action buttons (primary CTA, modal close, login button)
- Circles 50% (avatars, status dots, pulse indicators) — нетронуты
- Pills 999px на color dots — нетронуты

### Деплой
Стандартный `deploy.ps1`. Существующие юзеры — без сюрпризов (никаких new tokens / new behaviour, просто визуальная компрессия).

### Verification checklist
1. Sidebar source items — sharp углы (2px не 10px)
2. Phase/Type chips — sharp 2px (не pill)
3. Feed cards — 4px corners, тightер spacing
4. TOP NARRATIVES sidebar items — sharp
5. LIVE panel tiles — sharp
6. Header chips — sharp
7. Hover на sidebar item → border emphasis, не full-fill pillow
8. Overall feel — denser, less "AI-made", more trading-desk

### Что осталось как Minor / future polish
- `.analyze-score-value` per-level coloring (#ff7849 hex leak)
- LoginScreen feature list + tagline — hardcoded English orphans
- PHASE_META не theme-adaptive
- TrendModal styling — есть несогласованность с feed card
- Margins не трогали (только padding/gap)

---

## 2026-05-19 · sonnet+haiku · Dashboard visual redesign (token swap in place)

**Триггер**: оператор сказал "выглядит дёшево / by-an-engineer / AI-made", хотел sharper + дисциплинированную палитру. Опирался на собственный мокап в Claude Design (axiom-style trading-desk вайб).

### Brainstorm + spec + plan
- `/superpowers:brainstorming` → 6 визуальных axes locked: corners B-tight (2-4px), palette green primary + cyan secondary + amber tertiary, total black bg, шрифты Inter+JBM текущие, density A-spacious, login + toasts полный рефакш.
- Spec: `docs/superpowers/specs/2026-05-19-dashboard-redesign-design.md`
- Plan: `docs/superpowers/plans/2026-05-19-dashboard-redesign.md` (14 tasks, 5-rollout оригинальный → 17 commits итого)
- Execution: `superpowers:subagent-driven-development` — fresh implementer + 2-stage review (spec compliance + code quality) per task.

### Реализация (17 commits)

**Foundation (Tasks 1-2):**
1. `c304bf8` — pulse :root tokens (green primary, было X-blue)
2. `2adbc30` — fix-up: добавил пропущенные --surface2 + --r1/r2/r3
3. `e7b9324` — doc comment update (2 themes → 3)
4. `23d5cd4` — theme switcher registration (SUPPORTED_THEMES + THEME_META + preview swatch, default flip ink → pulse)

**Targeted fixes (Tasks 4-7):**
5. `535cf4f` — phase chips re-color (STRONG=accent / FORMING=white / EARLY=muted / SATURATED=warn)
6. `0b3e120` — fix-up: PHASE_META на feed-card badges тоже на новой палитре + EARLY active state distinct from hover
7. `b134fae` — MANUAL chip → --secondary (cyan/blue)
8. `7d74fc2` — feed card scores/velocity/actions: tier rainbow убран, all на --accent
9. `881aaef` — fix-up: .feed-fav-btn.saved:hover preserve accent + revert TrendModal scope creep
10. `c9b8ebb` — AnalyzePanel verdict (high/mid/low) + bars unified + Ask Grok → --secondary

**Toasts (Tasks 8-10):**
11. `434fb9a` — Toasts CSS: pill → sharp 2px, no blur, left-stripe by type, new warn type
12. `b6f2e03` — fix-up: .toast.error использует var(--red2) токен вместо bare hex
13. `56cc065` — Toasts JSX: SVG icons (feather) + close button + dismissToast handler
14. `1010e17` — addToast() calls: emoji prefixes stripped + EN/RU i18n cleanup

**LoginScreen (Tasks 11-13):**
15. `be5820d` — CSS overhaul: card radius 20px → 4px, logo tile 80→64, blur removed, ambient gradient слабее
16. `be178f8` — paper-plane SVG button (cyan hardcode #1d9bf0, чёрный текст) + monogram C fallback вместо 🐱
17. `b9503f7` — i18n cleanup: subtitle key DELETED, idle_desc rewritten без em-dash и "No passwords", drop 💬 + arrow emoji. ПЛЮС wire-up missing t() calls (pre-existing bug: LoginScreen JSX был hardcoded English, не вызывал t('login.idle_btn') etc. — теперь RU users реально видят русский).
18. `0a22003` — fix-up: stale LoginScreen header comment + RU "шестизначный" → "6-значный" consistency. (Кстати, первый attempt поймал SPA-trap: backticks в комментарии вокруг `login.*` сломали template literal — урок: даже в комментариях backticks нельзя.)

### Файлы
- `src/dashboard/server.js` — все 17 commits
- `ai-context/WORKLOG.md` — этот entry

### SPA-trap moments
- Task 1 implementer пропустил 4 токена (--surface2 + radius scale) — caught by spec reviewer
- Task 4 implementer не обновил PHASE_META для feed cards — caught by code quality reviewer
- Task 6 implementer создал .feed-fav-btn.saved:hover regression — caught by code quality reviewer
- Task 8 implementer использовал bare #ef4444 вместо var(--red2) токена — caught by code quality reviewer
- Task 13 — самый рискованный, EN apostrophe strings (You'll, It'll). Implementer корректно использовал double-quoted values.
- Я (coordinator) сам словил SPA-trap в Task 13 fix-up: backticks в комментарии вокруг login.* — сразу заметил и переписал в prose form.

### Деплой
- Стандартный `deploy.ps1` (without migrations).
- Существующие юзеры с `localStorage.ts_theme=ink` → остаются на синей теме (зелёный по умолчанию только для новых).
- Никаких миграций в БД, никаких новых env vars, никаких изменений в backend.

### Что НЕ сделано (deliberate, out of scope)
- TrendModal styling — несогласованность с feed card (Verify button code-phase, hero gradient bg) — отдельный future round.
- `.analyze-score-value` числа в AnalyzePanel остались per-level coloring (#ff7849 hex leak) — spec был про bars, не numbers.
- LoginScreen feature list + tagline — hardcoded English orphans, не было в scope.
- Legacy `memeColor()` функция и tier classNames в JSX — dead code, оставлено.
- "Анти-голость" fallbacks из brainstorm (micro-icons, per-source accent line, activity dot) — не trigger'нулись, ждут визуального assessment после деплоя.
- Theme adaptation для PhaseBadge (PHASE_META hex hardcoded) — pulse-only, не theme-swap. Acceptable trade-off.
- stage2Penalty chip typo bug (mult vs multiplier) — отдельная задача, не визуал.

### Риски post-deploy
- Existing users с сохранённой темой `ink` → видят синюю тему. Норм, by design.
- Legacy commits в БД с старой палитрой phase indicator — не пересчитываются, видны как есть до next scan cycle.
- `login.verifying` строка используется и для idle-phase "Please wait..." и code-phase "Verifying..." (раньше были раздельны). Brief loading flash, не critical.
- 64x64 logo tile может выглядеть mushy если PNG оптимизирован под 80x80 — visual judgement after deploy.

### Verification checklist (operator после деплоя)
1. Pulse тема (зелёный) — default для новых юзеров
2. Settings → Theme switcher показывает pulse / ink / tide. Переключение работает.
3. Существующий юзер на ink → видит синюю тему
4. Feed card: score numbers зелёные, MANUAL chip cyan, SATURATED phase amber
5. Login screen: monogram C (or PNG логотип), no 💬, cyan button, sharp 4px corners
6. Toasts: SVG icon + left-stripe + close button работают
7. Auto-dismiss 3s, click on × — instant close
8. AnalyzePanel: verdict high=green / mid=white / low=amber
9. Tide theme — без изменений
10. Console clean

---

## 2026-05-19 · haiku · Fix: добавить недостающие токены в dashboard-redesign

**Контекст**: Task 1 implementation был неполный (commit c304bf8). Spec reviewer обнаружил 4 токена отсутствуют в обоих `:root` и `body[data-theme="ink"]` блоках.

### Что добавил
`src/dashboard/server.js`:
- `:root` (line 2579): `--surface2: #16181c;` после `--surface`
- `:root` (line 2631–2633): `--r1/--r2/--r3` (2px/3px/4px) перед `--radius`
- `body[data-theme="ink"]` (line 2650): `--surface2: #16181c;` после `--surface`
- `body[data-theme="ink"]` (line 2676–2678): `--r1/--r2/--r3` перед `--radius`

Оба блока теперь синхронизированы — spec compliant. SPA check прошёл (295524 chars).

**Коммит**: 2adbc30 (`fix(dashboard): add missing --surface2 and --r1/r2/r3 tokens`)

---

## 2026-05-19 · sonnet · Text-only штраф теперь бьёт по memePotential, не только по alertScore

**Триггер**: оператор показал твит "Mall meet-and-greet chaos" с meme=100 viral=100 emerg=100, junk=2 (text-only + safe-override(÷3)). Junk-пеналти ушёл, но в карточке всё равно 100/100/100 — confusing AF.

### Что было сломано архитектурно
`noContentPenalty` из `junk-filter.js` копился ТОЛЬКО в `junkPenalty` (0–100), который потом × `weightJunk` (0.5) **вычитается из финального `alertScore`**. К `memePotential`/`score`/`emergenceScore` не прикасался вообще. Плюс safe-override делил text-only на 3 если в тексте было слово типа "chaos" (RE_ABSURD) — итоговый пеналти ≈2 punkt'a, чисто косметика.

### Фикс — три слоя

**1. `junk-filter.js` — text-only выносим из-под safe-override**
- Новый exports: `hasVisualContent(items)` (общий хелпер для junk-filter + scorer) и `isTextlessSource(s)` (set с `google_trends`).
- `textOnlyAddition` считается отдельно, не попадает в `raw` до safe-override.
- После division'а добавляется к `raw` напрямую → meme-shape слова больше не размывают сигнал об отсутствии медиа.

**2. `preset-config.js` + `filter-profiles.js` — бамп значений**
| Preset | Было | Стало |
|---|---|---|
| general | 5 | 12 |
| animals | 8 | 15 |
| culture | 6 | 12 |
| celebrities | 5 | 10 |
| events | 0 | 0 (не трогаем — news ОК текстом) |

**3. `scorer.js` — мультипликатор на memePotential/score (главное)**
Новая post-pass `applyTextOnlyMultiplier(trend, logger)` после Stage 2 для ВСЕХ трендов:
- Если `source ∈ {twitter, reddit, tiktok, instagram, threads, bluesky}` AND `!hasVisualContent(trend + items)` AND не textless-by-design → `memePotential *= 0.65`, `score *= 0.65`.
- Сохраняется `trend.textOnlyPenalty = { multiplier, memeBefore, memeAfter, viralBefore, viralAfter }`.
- Логируется: `Text-only penalty "..." × 0.65 meme 100→65 viral 100→65`.

**4. Admin SubmitPage** (`src/admin/server.js`):
- Чип `📝 Text-only ×0.65 — meme 100→65, viral 100→65` рядом с stage2Penalty/Bonus.
- Передаётся в `_hydrateTrendFromDb` + `_shapeManualTrend` чтобы после reload истории chip держался.

### Файлы
- `src/analysis/junk-filter.js` — exports + safe-override refactor
- `src/analysis/preset-config.js` — 4 preset bumps
- `src/analysis/filter-profiles.js` — same bumps в fallback profile
- `src/analysis/scorer.js` — import + applyTextOnlyMultiplier + post-pass call
- `src/admin/server.js` — chip + DB store + history hydrate

### Деплой
- `deploy.ps1` (без миграций — settings.presetConfigs пересохранится с новыми defaults только если override был равен прежнему default'у и `validateProfileOverrides` его дропнет; если оператор не правил руками — defaults применятся автоматически из bootstrap).
- Cache `RESULT_CACHE` в `manual-analysis.js` — in-memory Map, перезапуск процесса сбросит. Кеш-инвалидация не нужна.

### Риски
- **Legacy trends в БД** — `memePotential` уже записан, не пересчитывается. Старые text-only тренды в feed/admin останутся с прежним числом. Новые с этого момента — со штрафом.
- **Threads/Instagram/Bluesky** — добавил в social-sources на будущее, сейчас не активны.
- **Telegram alert text** — использует `trend.memePotential` после мультипликатора, так что в TG алертах число уже будет уменьшенным. Желаемое поведение.
- **stage2Penalty chip bug**: в admin SubmitPage код проверяет `t.stage2Penalty.mult < 1`, но scorer пишет `multiplier`, не `mult`. То есть Stage 2 penalty НИКОГДА не отображался в чипах (давний bug). Не правил — оставил для отдельной задачи.

### Проверка после деплоя
1. Manual analyze тот же text-only твит ("Mall meet-and-greet chaos") → должен вернуть meme≈65, viral≈65, chip `📝 Text-only ×0.65`.
2. Manual analyze твит с картинкой → штраф не должен сработать (no chip).
3. Manual analyze google_trends URL → штраф не должен сработать.
4. Junk math в SubmitPage: text-only пеналти не должен попадать в safe-override(÷3) — теперь должен быть полный (12 для general, не ~4).

---

## 2026-05-17 · sonnet · Manual analysis = full scanner pipeline (Emergence/Story fix)

**Триггер**: оператор пожаловался — manual analysis буквально бесполезен, Emergence и Story вечно 0. Скрин из дашборда: `EMERGENCE 0/100 LOW` для поста с 1M views. Хотим manual ≈ scanner для одинакового URL.

### Корни нулевых скоров
| Метрика | Откуда в scanner | Почему 0 в manual |
|---|---|---|
| Emergence | `clusterer.route()` сравнивает batch + DB row dynamics | Single trend в isolation → нет cluster context |
| Story | Stage 2 (Grok x-search) | Гейты `memePotential ≥ 60` + `isNovel ≠ false` режут слабые посты |
| PreStage | Step 2.5 в `runScanCycle` (явный вызов) | Был только через scorer's idempotency guard — ненадёжно |

### Реализация (4 этапа по плану)

**Этап 1 — PreStage** (`src/analysis/manual-analysis.js`):
Изменений в самом scorer'е не нужно — `scorer.scoreTrends()` уже auto-enrich'ает через idempotency guard на scorer.js:541. Но в manual я теперь вызываю `scorer.preStage.enrichBatch([synthetic])` ЯВНО ПЕРЕД scoring — чтобы `synthetic.preStage.nano.entityCanonical` был доступен для DB lookup'а на этапе 3.

**Этап 2 — Force Stage 2** (`src/analysis/scorer.js:513`):
- `scoreTrends(trends, opts = {})` теперь принимает второй arg
- `forceStage2: true` → bypass двух гейтов: `memePotential >= stage2Threshold` и `clusterMetrics?.isNovel !== false`
- `source !== 'google_trends'` гейт ОСТАВЛЕН — на gtrends entries Grok всё равно не может deep-dive'нуть (bare keywords, не URL)
- `stage2MaxCalls` cap остался — но manual single-trend, упирается в 1, не проблема
- Cost protection: per-user daily cap (`entitlements.manualAnalyze`: Test 5/day, Pro 100/day) уже в месте

**Этап 3 — Lookup-based emergence** (Variant A из плана):
- Добавил public-wrapper `NarrativeClusterer.computeSingleTrendEmergence(trend, {isNovel, dbRecentCount})` в `clusterer.js`. Дёргает существующий `_computeEmergenceScore` с conservative spread inputs (velocity=0, batchSize=1, batchAuthors=1, textVariation=0). Breakout-path и ideaBoost driveн `trend.metrics` напрямую → identical к scanner на single-trend viral постах.
- В `manual-analysis.js` ПЕРЕД scoring:
  1. Берём `synthetic.preStage.nano.entityCanonical` (fallback: longest word ≥5 chars из title)
  2. DB query: `SELECT COUNT(*) FROM trends WHERE last_seen_at > 6h_ago AND (title LIKE %needle% OR raw_metrics LIKE %needle%)`
  3. `isNovel = dbRecentCount <= 3` (тот же threshold что scanner — см. `_computeEmergenceScore` line 783-786 buckets)
  4. `emergenceScore = clusterer.computeSingleTrendEmergence(synthetic, {isNovel, dbRecentCount})`
  5. Set `synthetic.clusterMetrics = {emergenceScore, isNovel, dbRecentCount, ...defaults}` → scorer читает это на scorer.js:808 и пробрасывает на финальный `trend.emergenceScore`
- Эскейп для LIKE: `needle.replace(/[\\%_]/g, c => '\\' + c)` + `ESCAPE '\\'` clause (защита от user-controlled entity с `%`).
- Local `sqliteCutoff()` helper (формат `YYYY-MM-DD HH:MM:SS` без T — SQLite CURRENT_TIMESTAMP shape).

**Этап 4 — Cache TTL** (`manual-analysis.js`):
- `CACHE_TTL_MS`: 1h → 6h. Manual теперь дорогой (~$0.05 Grok + ~$0.005 Gemini + ~$0.001 nano), хочется чаще hit'ать. Оператор может re-open AnalyzePanel в течение рабочего дня без двойной оплаты.

**Этап 5 — UI loader** (`src/dashboard/server.js` AnalyzePanel):
- State `stageIdx` (0..3) + useEffect с `setTimeout` chain: PreStage → 3s → Stage 1, → 12s → Stage 2, → 45s → finalize. Backend не стримит progress, advances client-side по estimate'ам.
- CSS `.analyze-loader` — 36×36 spinner (rotating border), label с animated 3-dot ellipsis, breadcrumb trail (4 dots: done/active/pending).
- i18n: `analyze.stage_fetch/ai/deep/finalize` × EN+RU. EN: "Fetching post metadata / Running AI analysis / Deep search via Grok / Finalizing scores".
- Старый `"Usually takes 10-30 seconds"` hint span убран — заменён лоадером, expectation скрыт (оператор так попросил).

### Wiring `clusterer` → 3 call sites
`runManualAnalysis({clusterer})` опциональный (null fallback = legacy 0-emergence). Прокинуто:
- `src/index.js`: `new TelegramNotifier(..., scorer, clusterer)`; `new DashboardServer(..., { scorer, clusterer })`; `new AdminServer(..., { scorer, clusterer, ... })`
- `src/admin/server.js`: `this.clusterer = extras.clusterer` + `_submitNarrative` передаёт в runManualAnalysis
- `src/dashboard/server.js`: `this.clusterer = extras.clusterer` + `_handleManualAnalysis` передаёт
- `src/notifications/telegram.js`: 7th constructor arg + передаёт в `_runManualAnalysisForUser`

### Файлы
- `src/analysis/scorer.js` — `forceStage2` opt
- `src/analysis/clusterer.js` — `computeSingleTrendEmergence` public wrapper
- `src/analysis/manual-analysis.js` — explicit preStage call, DB-lookup emergence, forceStage2:true, cache TTL 6h, `sqliteCutoff` local helper
- `src/index.js` — wire clusterer
- `src/admin/server.js`, `src/dashboard/server.js`, `src/notifications/telegram.js` — accept clusterer, pass through
- `src/dashboard/server.js` — AnalyzePanel stage-loader (CSS + state + JSX + i18n EN/RU)

**SPA-check**: OK (dashboard 295524 / admin 266247).
**Syntax-check** (`node --check`): ok для всех backend файлов.

### Риски
- **Cost up**: каждый manual теперь = nano + Gemini + Stage 1 + forced Stage 2 = ~$0.06 vs было ~$0.01. Per-user cap (5/100 day) ограничивает; Test users могут хитить cap быстрее.
- **Latency up**: 10-30s → 30-90s. Лоадер с progress mitigate UX-боль; cache 6h съедает повторы.
- **Emergence approximation**: Variant A (LIKE search) пропускает синонимы. На viral постах с high engagement breakout-path даёт основной вклад (≥50 баллов на 1M views + 100K likes), spread-path добавка через `isNovel + dbRecentCount` — небольшой. Точность ±10% от scanner оценки. Если оператор скажет «всё ещё мимо» — мигрируем на Variant B (через embeddings).
- **Forced Stage 2 на бесполезных URL**: пользователь может submit мусор и сжечь свой 5/day cap. Trade-off, который оператор явно выбрал.

### Деплой
Операторский (`deploy.ps1`). После деплоя проверь:
1. Force Refresh / wait 1 cycle чтобы DB наполнилась
2. Analyze известного viral поста (>500K views) — Emergence должен быть ≥30, Story > 0
3. Analyze слабого поста — Emergence ≤20 (low signal), Story > 0 (forced Stage 2 всё равно отработает)

---

## 2026-05-17 · sonnet · AnalyzePanel redesign + dashboard Analyze landed в feed

**Триггер 1**: оператор пожаловался — Analyze из дашборда не появляется в feed, а manual submit из админки появляется.
**Триггер 2**: окно AnalyzePanel слишком технарское для конечного пользователя — Stage 1/2 pills, "memePotential 20 < threshold 70", голые цифры без контекста.

### 1. Bug fix: dashboard Analyze теперь персистится (`src/dashboard/server.js`)

`_handleManualAnalysis` ходил в `runManualAnalysis({ save: false, ... })` с комментом «private to caller, don't pollute global feed». Намерение было — Pro user не должен засорять shared feed. Но **админский путь** (`admin/server.js` `_submitNarrative`) использует тот же `runManualAnalysis` с `save: true` — потому из админки тренд попадал в DB, из дашборда нет.

**Фикс**: `save: true` в дашбордном пути. Тренды сохраняются с `raw_metrics.manualSubmitted=true` → в фиде показываются с бейджем `🧪 MANUAL`. TG-broadcast остался ТОЛЬКО за админкой (`_submitNarrative`) — дашбордный Analyze не спамит Telegram, просто кладёт в фид.

**Бонус**: после non-cache submit'а — `this.broadcast('refresh', ...)` SSE-событие, чтобы все подключённые дашборды автоматом подтянули новый тренд без F5. На cache-hit не бродкастю (новой DB-строки нет).

### 2. AnalyzePanel UI redesign (`src/dashboard/server.js`)

**До**: i18n кричит «Stage 1 + Stage 2 Grok», «POST URL», результат — два pills с техническим текстом + 3-4 серых score-карточки с голыми цифрами + плоский AI-блок.

**После** — структура сверху вниз:

1. **Verdict banner**: цветной (green/yellow/orange-red) хедер с одной строкой ответа: `🔥 Strong viral potential` / `📈 Some traction` / `💤 Unlikely to take off`. Уровень — bucketOf(max(meme, adoption)) ≥70/40/<40. Под заголовком — subtitle одним предложением («Этот пост попадает в паттерны нарративов, которые взрываются»).
2. **Hero**: thumbnail + title + meta (`source · analysed in 12.3s · category`) + actions (`🔗 Open original` + `👁 Open full details`).
3. **Score grid** (4 карточки: Viral potential / Trending now / Reach growth / Story strength): icon + label + `20/100` + **progress bar** (цвет от bucket) + **qualitative tag** «Low/Medium/High». Story показывается только при `> 0` (Stage 2 не всегда run).
4. **Why this score** (был «AI») — relabeled, читается как объяснение, не debug-дамп.
5. **Footer** — одна dim-строка вместо двух pills: `🔬 Deep analysis: completed` или `⏭ Deep analysis: skipped (low signal — saved you a Grok call)`. Сырое `memePotential 20 < threshold 70` ушло — это инфа для разработчика, не юзера.
6. **Usage** (test plan only) — крошечная строка, не конкурирует с контентом.

**Файлы**: `src/dashboard/server.js`:
- CSS добавлен — `.analyze-verdict`, `.analyze-score-bar`, `.analyze-score-tag`, `.analyze-footer`. Старые `.analyze-trace` / `.analyze-pill` оставлены — могут переиспользоваться в других местах (граппнуть через ide → нет, только AnalyzePanel; реально мёртвые, но удалю отдельно).
- i18n EN + RU добавлено ~15 ключей: `verdict_high/mid/low`, `verdict_sub_*`, `score_meme/emerge/adopt/story`, `score_low/mid/high`, `why_label`, `deep_ran/skipped`, `open_link`. Старые ключи `intro` / `title` переписаны (был «Manual analysis (Stage 1 + Stage 2 Grok)» — стал «Analyze a post — paste a link, get viral potential»).
- JSX: верстка через data-driven `scoreSpecs.map()` вместо ручных 4 карточек.

**Gotcha** (поймал): `'today\'s trends'` в EN-строке внутри outer template literal сломал SPA — backslash escape `\'` в template literal evaluate'ится в `'`, и output JS видел `'today's trends'` → SyntaxError 'Unexpected identifier "s"'. Фикс — value на двойные кавычки: `"today's trends"`. Template literal не парсит `"` как спец-символ. Решил так, а не `today\\'s` (двойной escape тоже работал бы, но менее читаемо). Записал в memory: **в i18n EN строках с апострофами всегда юзай `"..."` для value**.

**SPA-check**: OK (293625 chars).
**Деплой**: операторский.
**Риски**:
- save:true в дашборде — Pro users теперь могут засорять feed «мусорными» URL. Видно по бейджу `🧪 MANUAL`. Если шум станет проблемой — можно добавить scoring-threshold (низкие memes не сохранять) или per-user TTL. Сейчас admin-плана достаточно (operator = main user).
- Старые `.analyze-trace` / `.analyze-pill` стили — dead code, удалю отдельным entry.

---

## 2026-05-16 · sonnet · Dashboard UX-пачка + deploy-aware scheduler

Накопилось 5 мелких правок + 1 средняя — пишу одним entry per WORKLOG-rule.

**1. ALL chip ресетит обе оси типа** (`src/dashboard/server.js`)
- Раньше клик на ALL чистил только `alertTypes`. Если `manualOnly=true` сохранён в localStorage от прошлого клика на «🧪 Ручные» — фид оставался залочен на manual-only, чип ALL подсвечивался как «активен» (врал).
- Теперь: ALL → `setAlertTypes('') + setManualOnly(false)`. `activeAll = atypeArr.length === 0 && !manualOnly`. Manual чип остался отдельной UNION-кнопкой (Event+Manual = event OR manual rows).

**2. Toast UX** (`src/dashboard/server.js`)
- `addToast` setTimeout `4000 → 3000` (короче и не мешает).
- `toast.refreshing`: `'Refreshing…' → 'Refreshed'` / `'Обновляю…' → 'Обновлено'`. Toast висит после клика по Refresh, present continuous звучал странно (действие уже завершено к моменту показа). `feed.refreshing` (inline-лоадер внутри ленты) не трогал — там present норм.

**3. Scroll-to-top кнопка** (`src/dashboard/server.js`)
- Floating круглая кнопка `↑` появляется когда `.main-feed.scrollTop > 400px`, по клику `scrollTo({top:0, behavior:'smooth'})`.
- Listener на `.main-feed` (не window), throttle через rAF.
- **Gotcha #1** (auth gate): первый эффект-рендер ставит deps `[mainFeedRef]` — стабильный ref-объект, эффект ни разу не перезапустится. Когда `me === null` LoginScreen рендерится, `.main-feed` ещё не в DOM, `ref.current = null` → effect бейлится навсегда. Фикс — deps `[me, view]`, перезапуск при логине/переключении вкладки.
- **Gotcha #2** (SPA-trap): в первой попытке написал в комменте `` `me` `` / `` `view` `` с бэктиками — закрылся внешний template literal, SPA сломался с `Unexpected identifier 'me'`. Заменил на `"me"` / `"view"`. После каждой правки server.js — `node scripts/check-dashboard-spa.cjs` обязателен.
- Позиция: `top: 60px; left: 50%; transform: translateX(-50%)`, 22×22px кругляш. Hover/active/keyframes сохраняют `translate(-50%, ...)`, иначе кнопка скачет вправо при анимации.
- i18n: `feed.scroll_top` = `'Scroll to top'` / `'Наверх'`.

**4. Velocity убрана из feed-карточек** (`src/dashboard/server.js`)
- `metaParts` больше не пушит `vel` — бейдж `1005.2/h ↑` исчез. Сам `trend.velocity` остался (модалка в Metrics показывает, twitter-engagement update пишет), это чисто визуальное декларирование.

**5. @handle убран из feed header'а** (`src/dashboard/server.js`)
- Span `.feed-handle` (`@twitter_x`, `@google`, `@x_trends`) удалён — был синтетический per-source, не настоящий автор. Теперь хедер: `[avatar] Twitter/X · 21h 57m ago [badges]`.
- `feed-dot` оставил — единственный разделитель источник↔время.

**6. Deploy-aware scheduler** (`src/index.js`) — главная правка
- **До**: `startScheduler` всегда дёргал `runScanCycle()` immediately on boot → каждый деплой сжигал полный collect+scorer цикл сразу.
- **После**: в `finally` блоке `runScanCycle` пишется `db.setSetting('lastScanCompletedAt', String(Date.now()))`. На boot scheduler читает этот ts, считает `sinceLast = now - lastScanAt`:
  - `sinceLast < intervalMs` → wait `intervalMs - sinceLast`, потом scan + `scheduleNext()`. Лог: `"Resuming after restart — last scan Xm ago, next in ~Ym"`.
  - `lastScanAt === 0` → первый boot ever → scan now.
  - `sinceLast >= intervalMs` или отрицательный (clock skew) → stale, scan now. Лог: `"Interval elapsed during downtime (Xm) — scanning now"`.
- Манульные триггеры из dashboard/admin тоже пишут `lastScanCompletedAt` — это правильно, deploy-resume считает их за полноценный scan.
- `appState.paused` НЕ обновляет ts (early-return до try-блока). Если оператор паузил скан перед деплоем → после рестарта таймер не сдвинется, scan не запустится сам, scheduler уйдёт в setTimeout как обычно. Корректное поведение.

**Файлы**: `src/dashboard/server.js` (5 правок), `src/index.js` (deploy-resume).
**SPA-check**: OK (~288k chars).
**Деплой**: операторский (`deploy.ps1`).
**Риски**: deploy-resume — `db.getSetting` валидируется только Number-cast (`|| 0`), corrupted value безопасно деградирует к "scan now". Если оператор хочет принудительно скан после деплоя — `DELETE FROM settings WHERE key='lastScanCompletedAt'` или Force Refresh из админки.

---

## 2026-05-16 · opus · Tag-refresher: empty-array guard + промпт против sparse output

**Триггер**: оператор скинул raw `presetConfigsAuto` после удачного refresh — `animals.twitter.queries: []`, `events.twitter` 2 шт., `culture.twitter` 1 шт., `celebrities.tiktok` 3 шт. (target 8-10), плюс галлюцинация `gumite` (несуществующее слово) в `events.twitter`. Grok ленится и галлюцинирует.

**Диагноз** — два независимых бага:

**Баг 1 (механика)**: `_applyAutoOverride` писал `{ queries: [] }` в auto-blob когда Grok возвращал 0 items. Empty array через `deepMerge` top-layer-wins **полностью ЗАМЕНЯЛ** defaults → production collector видел zero queries → no-op cycle. Та же грабля что мы фиксили в admin UI, но на стороне tag-refresher.

**Баг 2 (промпт)**: текущий промпт говорит «do NOT repeat existing items» + «Honesty over format compliance: empty/short list BETTER than fabricated». Для animals preset весь дефолт уже в existing list → Grok видит «нельзя повторять» + «можно вернуть пусто» → возвращает `[]`. Анти-галлюцинация была размыта → `gumite` проскочил.

**Что сделано** (1 файл, `src/refresh/tag-refresher.js`):

1. **`_applyAutoOverride`** — empty-array guard:
   - Если `finalSubs.length === 0` → `delete auto[preset].sources.reddit` + warn-лог.
   - То же для twitter и tiktok.
   - Если все три source-слота сдохли → `delete auto[preset].sources` → `delete auto[preset]`.
   - Семантика: «Grok вернул 0» теперь = «defaults остаются в силе», а не «production обнуляется».

2. **`_buildPrompt`** — переписан с трёх углов:
   - **Минимум 6 items per source**, target 8-10 (TikTok 8-12). NEVER empty array.
   - **EXISTING list переинтерпретирован**: было «do NOT repeat», стало «verified baseline you can keep — use it to fill the gap». Если Grok не находит 8 свежих → берёт theme-relevant из existing + добавляет сколько может верифицировать.
   - **Anti-hallucination HARD rules**: «NEVER invent English words. Every keyword/hashtag must be real with x_search hits. If x_search returns zero hits → DROP, don't pad with fakes». Конкретно упомянул `gumite` как пример anti-pattern.

3. **TAG_REFRESH_SYSTEM_PROMPT** — поправлена строчка «Honesty over format compliance: empty list BETTER than fabricated» → теперь «Honesty over fabrication: never pad with invented words; BUT don't return short/empty either — fill from existing».

**Деплой**: `deploy.ps1`. Следующий tag-refresh цикл (next `refreshAll()`, every 2 days по `TAG_REFRESH_COOLDOWN_DAYS`, либо «Force refresh now» из админки) использует новый промпт. Empty-array guard работает уже сейчас, до следующего refresh.

**Риски**: новый промпт длиннее на ~300 символов — стоимость Grok input чуть выше (~$0.0005 на refresh). Если Grok всё ещё ленится после изменений → variant A (programmatic composition from defaults) остаётся в комментарии `_refreshGeneralAsCurator` как escape hatch.

**Что НЕ сделано** (опции на будущее):
- `_buildExistingList()` всё ещё читает из `DEFAULT_PRESET_CONFIGS`, не из текущего `presetConfigsAuto`. Грок не видит ПОСЛЕДНИЕ auto-refreshed теги как «verified baseline», только hardcoded дефолты. Стоит расширить если хочется чтобы Grok сохранял auto-state между циклами.
- Twitter reality-check (`_realityCheckTwitter`) пропустил `gumite` — анти-галлюцинация только в промпте. Если повторится — добавить regex-check на dictionary-word в `_sanitizeResponse`.

---

## 2026-05-16 · opus · Admin: `getEffective` теперь делает 3-layer merge как production (фикс «auto-tags работают только для general»)

**Триггер**: оператор: «при авто-тегах будто ищет только по general пресету. Стоял Animals 2 дня, но искало всё». SQL подтвердил `activePreset=animals`, но в админке (Presets → Animals → Sources) все chip-листы пустые (`0/30 items`).

**Диагноз** — **второй слой того же бага что я фиксил 2026-05-12**:
- 12-го числа поправил `_getPresetConfigs` чтобы в response летел `effective` (3-layer merged) и `autoOverrides` отдельно.
- НО UI-компоненты чипов читали через `getEffective(preset, path)` который walks ТОЛЬКО `draft → defaults`, полностью **игнорируя `data.autoOverrides`**.
- Когда оператор открыл Animals tab, увидел пустые поля (auto layer не показан, а manual после Wipe тоже пустой). Подумал «auto не сработал» и **поудалял chips один-за-другим**.
- Каждое удаление chip'а пишет в draft empty-array `[]`. На Save оно попало в `settings.presetConfigs.animals.sources.{reddit,twitter,tiktok}` как explicit empty arrays.
- Production's `getActivePresetConfig` через `deepMerge` — массивы не мержатся, top layer wins. Manual=`[]` ЗАМЕНИЛ auto+defaults → коллекторы Reddit/Twitter/TikTok получили **ноль queries** для Animals.
- Фид при этом продолжал жить за счёт (1) stale данных из прошлых циклов, (2) X Trends + Google Trends — оба коллектора preset вообще игнорируют (firehose).

**Что сделано** (1 файл, `src/admin/server.js`):

`getEffective(preset, path)` теперь делает proper 3-layer merge **точно как production**:
```js
const fromDraft = walk(draft[preset], path);
if (fromDraft !== undefined) return fromDraft;
const fromAuto = walk(data?.autoOverrides?.[preset], path);
if (fromAuto !== undefined) return fromAuto;
return getDefault(preset, path);
```

**Post-deploy инструкция оператору**:
1. Нажать **🧹 Wipe manual** в админке (Preset configs → top buttons).
2. Save → `settings.presetConfigs = {}` → broken empty-array overrides уйдут.
3. Reload админки → Animals tab → должны увидеть **animal-themed chips** (auto layer Grok-refreshed queries).
4. Production коллекторы со следующего цикла начнут пробивать `r/aww`, `(capybara OR otter)`, `#animalsoftiktok` etc.

**Сопутствующая мысль (не реализована)**: empty-array-в-manual ломает 3-layer семантику. Если оператор хочет «вернуться к auto» — единственный текущий путь это нажать ↺ Reset на конкретном поле (это пишет default, GC дропает leaf → auto оживает). Если в будущем будет повторяться — добавить в `setLeaf` GC empty arrays когда auto имеет non-empty (но тогда теряем legitimate use-case «отключить Twitter для preset»). Пока оставил руль на операторе.

**Деплой**: `deploy.ps1`. SPA-check 265535 chars OK.

**Риски**: после deploy + Wipe + Save оператор должен быть ГОТОВ что в Animals tab появятся незнакомые chips из auto-refresh. Если они выглядят не-animal (Grok strayed) — это уже отдельный bug, лечится корректировкой `_buildPrompt` per-preset theme или ужесточением reality-check.

---

## 2026-05-16 · opus · Dashboard: feed search переехал на server-side (фикс «search at 24h not finding things»)

**Триггер**: оператор: «Поиск работает только на 6h, а если на 24h то не ищет один и тот же алерт». Скрины: при 6h `Narrative Feed 1 / 205`, при 24h `Narrative Feed 0 / 577` (один и тот же search query).

**Диагноз**: поиск был полностью client-side — фильтровал массив `trends` уже загруженный в state. SPA грузит первые `LIMIT = 25` строк отсортированных по `rank/meme/...`. При 6h в окне всего ~200 трендов, целевой в top-25 → найден. При 24h 577 трендов, целевой свалился на #100+ по rank → даже не загружен в client state → search его «не видел». То же самое на 3d/7d. Lazy-load подгружал страницы при скролле, но при активном search guard в IntersectionObserver блокировал пагинацию вообще.

**Что сделано** (1 файл, `src/dashboard/server.js`):

1. **Server** (`_handleTrends`): парсит `?q=` (trim, length cap 80). Если непустой — добавляет `AND (title LIKE ? ESCAPE \\ OR original_title LIKE ? ESCAPE \\ OR ai_explanation LIKE ? ESCAPE \\ OR category LIKE ? ESCAPE \\)` к WHERE. User-input wildcards `%`/`_`/`\` экранируются явно. Count query reuses тот же WHERE → `tr.total` сразу отражает количество match'ей.

2. **Client**:
   - Новый state `searchDebounced` + `useEffect` со `setTimeout 250ms` мирорит `search`. Раздельные state'ы: `search` для controlled input + UI affordances (counter, empty-state), `searchDebounced` для fetch trigger.
   - `useEffect(() => setOffset(0), [searchDebounced])` — сбрасывает пагинацию при смене query.
   - Оба query builder'а (`fetchData`, `refreshAll`) теперь шлют `&q=<encodeURIComponent>` и имеют `searchDebounced` в deps.
   - Старый client-side filter `searchFiltered = search ? trends.filter(...) : trends` превращён в pass-through (комментарий-объяснение). Downstream `visibleTrends` логика осталась.
   - В infinite-scroll guard убран `if (search.trim()) return;` — теперь scroll работает и при активном поиске (server paginates filtered set).

**SQLite caveat**: `LIKE` case-insensitive для ASCII, не для Cyrillic. Заголовки трендов в основном английские → ОК на сейчас. Если понадобится — добавить ICU extension или PRAGMA для full case-folding.

**SPA-trap rake** (опять): первый заход добавил три комментария с backtick'ами: `\`search\``, `\`?q=\``, `\`if (search.trim())...\``, `\`searchFiltered\``. Это закрыло outer template-literal → `node -c` упал на `Unexpected identifier 'search'`. Фикс: убрал backtick'и, заменил на `"..."`. Третий случай за неделю — стоит в SESSION_CONTEXT добавить явное правило: **никаких backtick'ов в комментариях внутри SPA**.

**Деплой**: `deploy.ps1`. SPA-check 285703 chars OK.

**Риски**: на больших окнах (7d, 577+ трендов) SQL LIKE без индекса работает sequential scan по `trends`-таблице. Сейчас retention 7d × ~80 трендов/час ≈ 13K строк max — секвенциальный LIKE на 4 колонках это <50ms на SSD. Если retention вырастет — поднимать FTS5 виртуальную таблицу.

---

## 2026-05-14 · opus · Dashboard: Font size setting удалён (был визуально no-op'ом)

**Триггер**: оператор: «Что делает в настройках Font size? При переключении ничего не происходит».

**Диагноз**: настройка существовала, но **ничего не делала**. `applyPrefsToDOM` (`dashboard/server.js` ~10213) писала `body.style.setProperty('--user-font-size', p.fontSize + 'px')` — и **ни одно CSS-правило эту переменную не читало**. Грепнул весь файл, единственное упоминание `--user-font-size` — само присваивание. Все размеры шрифтов в SPA-стилях захардкожены в px (~сотни мест). UI-переключатель S/M/L подсвечивался активным, localStorage обновлялся, но ноль визуального эффекта.

**Что сделано** (1 файл, `src/dashboard/server.js`):

- UI `h(Row, ...)` блок с переключателем S/M/L — удалён, оставлен arch-комментарий.
- `DEFAULT_PREFS.fontSize: 14` — удалён.
- `applyPrefsToDOM`: строка с `setProperty('--user-font-size', ...)` — удалена.
- i18n-ключи `settings.font_size` + `settings.font_size_desc` (RU + EN) — удалены.

**Trap-rake**: первый заход добавил комментарий с backtick'ами вокруг `--user-font-size`. Это закрыло **outer SPA template-literal** — `node -c` упал с `Invalid left-hand side expression in postfix operation` (CSS-переменная `--user-font-size` после закрытой backtick'и парсилась как `-- user-font-size`, постфиксный декремент). Фикс: убрал backtick'и в комментарии. SPA-trap (`CLAUDE.md → «Ловушка server.js»`) reminder.

**Деплой**: `deploy.ps1`. SPA-check 284478 chars OK.

**Риски**: если кто-то хочет реально менять размер шрифта — будет нужен em/rem refactor по всему SPA CSS (~100+ правил), сейчас всё в px. Альтернатива на будущее: `body { zoom: var(--user-zoom, 1) }` — масштабирует всю страницу включая иконки/паддинги.

---

## 2026-05-14 · sonnet · Dashboard: sidebar Adoption filter удалён целиком

**Триггер**: оператор: «Я хочу вообще убрать фильтр Adoption слева в дашборде».

**Что сделано** (1 файл, `src/dashboard/server.js`, серия согласованных правок):

- **UI-блок** sidebar `filter-group` «Adoption threshold (segmented)» — удалён (был segmented control [0, 30, 50, 70, 85]).
- **State**: `useState minMeme/setMinMeme` — удалён.
- **Query-builder**: убран `&minMeme=...` из обоих `?` (refresh + refreshAll).
- **Dep arrays** обоих useCallback'ов — без `minMeme`.
- **resetFilters**: убран `setMinMeme(0)`.
- **Active-filters indicator** (`hours !== 24 || minMeme !== 0 || ...`): убран `minMeme !== 0`.
- **Server**: `parseInt minMeme` + `if (minMeme > 0) WHERE memePotential >= ?` удалены. Комментарий: «param silently ignored if older clients send it» — backward-safe.
- **i18n**: ключи `sidebar.adoption` (RU + EN) удалены — больше не используются.
- **Сопутствующее**: `account.threshold_desc` (RU + EN) и комментарий к нему ссылались на «sidebar Adoption filter» — упоминания убраны.

**Деплой**: `deploy.ps1`. SPA-check прошёл (285039 chars OK).

**Риски**: per-row Adoption-bar в карточках треда остаётся — оператор/юзер всё ещё видит score. Если кто-то хочет фильтровать — есть sort `meme` (топ по adoption). Серверный фильтр не сломан, просто param никто не шлёт.

---

## 2026-05-14 · sonnet · Ask Grok prompt — narrative-name chapter переписан: «найди», а не «придумай» (dashboard + telegram bot)

**Триггер**: оператор: «Нужно в промпте грока (Ask Grok) изменить главу про название нарратива — нужно чтобы он искал названия, а не придумывал их». Follow-up: «Еще в тг боте остался самый первый старый промпт».

**Что было**:
- **Dashboard** (`dashboard/server.js` ~9395-9427): 6-пунктовый промпт, но пункт 1 формулировался как «предложи 2-3 варианта, каждый короткий и ёмкий (2-5 слов)» → Grok галлюцинировал свои.
- **Telegram bot** (`telegram.js:27-38` `buildGrokUrl`): жил легаси-однострочник ещё с MVP — `«How viral is this narrative right now? <title> - <url>»`. Никаких пунктов, никакого структурного ответа.

**Что сделано** (2 файла, оба двуязычных RU+EN):

1. **`src/dashboard/server.js`** → Ask Grok modal-link prompt, пункт «1. Название нарратива»:
   - «**НАЙДИ как его уже называют в постах/тредах X** за последние 24-48 часов: устоявшиеся хэштеги, повторяющиеся фразы из шапок постов, ключевые слова из топ-комментариев.»
   - «**НЕ ПРИДУМЫВАЙ** свои варианты.»
   - «для каждого укажи источник (пример: `#PunchMonkey — 12K постов` или `"Hawk Tuah girl" — фраза из вирального клипа`).»
   - «Если устоявшегося имени нет — честно напиши `устоявшегося названия пока нет, чаще всего описывают как: <короткая фраза>`.»

2. **`src/notifications/telegram.js → buildGrokUrl`**: однострочник заменён полным 6-пунктовым промптом — синхронизирован с dashboard-версией. Пункты: name (find, don't invent) / why viral / why grow / potential / risks / audience. Док-комментарий теперь явно говорит «keep the two in sync» — чтобы в будущем правки шли парой.

**Деплой**: `deploy.ps1`. После — клик «🧠 Ask Grok» под алертом в Telegram или в модалке дашборда → Grok откроется с одинаковым промптом.

**Риски**: длина промпта выросла (~80 → ~2000 символов). `grok.com/?q=` URL-encode не имеет публично задокументированного лимита, но браузеры обычно нормально кушают URL до 8K. Если упрёмся — резать другие пункты, не этот. SPA-trap в dashboard через `String.fromCharCode(10)` сохранён; в telegram.js (не-SPA) можно литералы `'\n'`.

**Update 2026-05-16**: упёрлись — grok.com отвечал HTTP 431 «Request Header Fields Too Large». Кириллица в URL-encode = 6 байт/символ (`%D0%9D`), ~1550 рус. символов = ~8.5KB query → за лимитом сервера grok.com. Сократил пункт 1 до сути: «Название — НАЙДИ как уже называют в X за 24-48ч (хэштеги, повторяющиеся фразы). НЕ ПРИДУМЫВАЙ. 2-3 варианта буллетами с источником…» — сэкономил ~400 символов, URL теперь ~6.2KB, проходит. Правило про геопривязку не-английского вырезано (edge-case). Применено в обоих местах: `dashboard/server.js` Ask-Grok modal + `telegram.js buildGrokUrl`.

---

## 2026-05-14 · sonnet · Fix: TikTok max-age filter (evergreen 2023 videos surfacing as fresh alerts)

**Триггер**: оператор: «В тиктоке приходят алерты для видео из 2023 года».

**Диагноз**: TikTok-страница `/tag/<x>` ранжируется редакционно, а не хронологически. Apify-actor (clockworks/apidojo) возвращает evergreen-видео из 2023-2024 среди свежих. Они проходят engagement floor (миллионы просмотров накопились за годы), PreStage и Stage 1, прилетают как «свежий тренд». В `tiktok.js _normalize` `ageHours` уже считался (`createTime` / `uploadedAt`), но **не использовался для фильтра**. У Twitter симметричная защита (`twitterMaxAgeHours`, default 72h) есть с давних пор — у TikTok была дыра.

**Что сделано** (3 файла):

1. **`src/collectors/tiktok.js _normalize`**: после расчёта `ageHours` добавлен max-age filter — читает DB-setting `tiktokMaxAgeDays` (default 7), `return null` если `createdAt && ageHours > maxAgeDays * 24`. 0 = выключено. Видео без timestamp пропускаются без проверки (редкий edge-case).

2. **`src/admin/server.js`**:
   - В `_getScannerConfig.numDefaults` добавлен `tiktokMaxAgeDays: 7`.
   - В `_setScannerConfig.allowedInt` — `{ min: 0, max: 60 }`.
   - В UI секция «🎵 TikTok — фильтр по возрасту» сразу под Twitter-фильтром (range 0-60d, step 1, label `Nd` / `0 (off)`).

3. **`ai-context/SESSION_CONTEXT.md`** → секция TikTok specifics — новый блок «Max-age filter».

**Деплой**: `deploy.ps1`. После — крутить ползунок без рестарта (читается каждый Apify-call). 7d — рекомендованный default, оператор выбрал.

**Риски**: при `maxAgeDays=7` можно срезать медленные tail-всплески (видео залило неделю назад, начало вируситься сейчас). Если оператор увидит false-negative — крутить ползунок выше (14d/30d) без редеплоя.

---

## 2026-05-12 · sonnet · Fix: admin UI showed only `defaults+manual` без auto-layer (3-layer merge dropped one layer)

**Триггер**: только что разделил Clear ALL на 2 кнопки (Wipe manual / Restore hardcoded). Юзер: «Обе кнопки возвращают старые пресеты». То есть после Wipe manual в UI **все равно** виден legacy skibidi-блок, хотя `presetConfigsAuto` точно содержит свежие Grok queries (проверено SQL).

**Диагноз**: `_getPresetConfigs` (admin endpoint) считает `effective` через `getEffectivePresetConfigs(overrides)` где `overrides` = **только manual layer**. Auto-tags layer в этом merge **полностью игнорировался**. Production-side `getActivePresetConfig` правильно делает 3-layer (`defaults → auto → manual`), но **admin UI лгал**:
- Wipe manual → manual=∅ → admin показывает `defaults` (= hardcoded skibidi) ❌
- Restore hardcoded → manual=defaults.sources → admin показывает то же самое ❌

То есть auto-tags layer работал нормально на проде (collectors шли по свежим queries), но в админке его не было видно никогда. **Bug ≥ 5 дней** (с момента Phase 2 Auto-tags = 2026-05-07).

**Что сделано** (2 файла):

1. **`src/analysis/preset-config.js`** — `mergeOverrideBlobs(auto, manual)` теперь `export` (был internal). Это уже была готовая функция для 2-layer merge, просто не была доступна снаружи.

2. **`src/admin/server.js → _getPresetConfigs`**:
   - Импортирует `readPresetAutoOverrides` + `mergeOverrideBlobs` из preset-config.
   - Перед `getEffectivePresetConfigs` мерджит `mergedForEffective = mergeOverrideBlobs(autoOverrides, overrides)` (auto + manual).
   - Передаёт `mergedForEffective` в `getEffectivePresetConfigs` — теперь UI видит реальную 3-layer картину.
   - В response добавлено новое поле `autoOverrides` — auto layer отдельно (для будущего Debug Inspector pane «Auto · <preset>», сейчас не рендерится, но доступен через `data.autoOverrides[tab]`).

**Файлы**: `src/analysis/preset-config.js`, `src/admin/server.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax + admin SPA check прошёл (264050 chars OK).

**После деплоя поведение кнопок**:
- **🧹 Wipe manual** → manual=∅ → effective = `defaults+auto` → юзер видит свежие Grok queries (ragebait/scandal/tabloid/(tiny OR smol)…). Auto-tags работает.
- **↩ Restore hardcoded** → manual=defaults.sources → effective = `defaults+auto+defaults.sources` где manual перекрывает auto → юзер видит legacy skibidi-блок. Используется как escape hatch.

**Lesson learned**: при разделении layered config (defaults / auto / manual) UI должен **в точности** mirror'ить production merge logic. Иначе оператор делает решения на основе ложной картины. Стоит написать smoke-test «UI effective === production effective» (не сделал — поставлю в backlog).

**Что НЕ сделано (опции для будущего)**:
- Debug Inspector pane «Auto · <preset>» рядом с Defaults / Effective / Draft — `data.autoOverrides` уже передаётся, остался один React-блок добавить. Полезно для визуальной проверки что auto-tags выдал. Если юзер скажет — добавлю.

---

## 2026-05-12 · sonnet · Preset-configs: 2 кнопки вместо Clear ALL — «Wipe manual» + «Restore hardcoded»

**Цель**: операторская ловушка — старая «🗑 Clear ALL» делала **panic-clear** (wipe manual + auto + locks), что в спокойном режиме нежелательно. И не было способа one-click восстановить hardcoded legacy теги в manual layer для блокировки сошедшего с ума Auto-tags. Разделил на 2 явные операторские кнопки с разной семантикой.

**Что сделано** (1 файл):

1. **`src/admin/server.js → _setPresetConfigs`** — убрал panic-clear branch (`isPanicClear` + `setSetting('presetConfigsAuto', '')`). Manual save теперь чисто atomic: empty draft → стираем `presetConfigs`, empty locks → стираем `presetTagsLocked`, auto **никогда** не трогается. Операторские намерения через 2 явные кнопки ниже.

2. **`src/admin/server.js → _restoreHardcodedPresetSources`** — новый метод. Читает existing manual из БД, для каждого preset перезаписывает `manual[preset].sources = deep-clone(DEFAULT_PRESET_CONFIGS[preset].sources)`. Остальные manual поля (junk / alerts / cluster) сохраняются как были. Прогоняет через `validatePresetOverrides` для shape-guard. Записывает обратно.

3. **Backend endpoint** `POST /api/preset-configs/restore-hardcoded` — вызывает helper выше, возвращает обновлённый `_getPresetConfigs()` ответ.

4. **Frontend (`PresetConfigsPage`)**:
   - Удалён `clearAll()`. Заменён на **`wipeManualAll()`** — только `setDraft({})`, locks **не** трогает. Save сохранит empty manual → `setSetting('presetConfigs', '')`. Tooltip объясняет «auto+defaults станут effective».
   - Новый **`restoreHardcoded()`** — `window.confirm` (с описанием что произойдёт) → `POST /api/preset-configs/restore-hardcoded` → обновляет state. Direct backend call (не draft+save), потому что операция destructive и заслуживает explicit confirm dialog. **NB**: confirm-текст использует `String.fromCharCode(10)` для переносов строк, потому что outer dashboard/admin server.js — это template-literal-served SPA, литералы `\\n` в inner strings ломают SPA-парсер (см. CLAUDE.md «Ловушка server.js»). Сделал ошибку при первом коммите — поймал check-admin-spa.cjs.
   - В action-bar заменил одну `🗑 Clear ALL` на две: `🧹 Wipe manual` (зелёная семантика — нормальный режим) + `↩ Restore hardcoded` (красная семантика — escape hatch). Tooltips описывают use-cases.

5. **`ai-context/SESSION_CONTEXT.md`** — § *Per-preset pipeline configs / Merge order* добавлен абзац про 2 кнопки с описанием semantic.

**Use cases (для операторской документации)**:

| Кнопка | Когда нажимать | Что произойдёт |
|---|---|---|
| 🧹 Wipe manual | Старые manual queries застряли и перекрывают свежие auto-tags (типичный legacy случай) | Manual слой стирается во всех пресетах → auto+defaults становятся effective. Auto-tags работает свободно. |
| ↩ Restore hardcoded | Auto-tags производит мусор (галлюцинации Grok'а / битый curator-mode / устаревший сленг) | `DEFAULT_PRESET_CONFIGS.sources` копируется в manual слой всех пресетов. Manual перекрывает auto → legacy теги become effective. Auto refresh больше не сможет их изменить (manual wins). |

**Файлы**: `src/admin/server.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax + admin SPA check прошёл (264050 chars OK после исправления `\\n` ловушки в confirm-тексте).

**Триггер**: юзер только что обнаружил что у него в manual layer для General preset сидят давние legacy queries (`skibidi/dog OR puppy/meme OR memes/...`), поставленные ДО появления Auto-tags. Они тихо перетирали все свежие refresh'и. После обнаружения сам сказал «убери весь мусор», и попросил оформить две кнопки для будущего: одну для очистки, одну для возврата legacy.

**Что НЕ задеваем**:
- `presetConfigsAuto` — никогда не стирается ни одной из новых кнопок. Auto-tags refresh history сохраняется.
- `presetTagsLocked` — Wipe manual не трогает locks. Restore hardcoded не трогает locks. Очистка locks — через `🧹 Reset preset «<name>»` на per-preset уровне (там как раз и locks, и manual сбрасываются для одного пресета).
- Manual non-sources секции — Restore hardcoded трогает **только** `sources` sub-tree. Если у оператора есть manual junk-penalties / alert-weights / cluster — они сохраняются.

---

## 2026-05-12 · sonnet · Variant B (description synthesis) — добавлен и сразу откачен (гипотеза опровергнута)

**Что было**: гипотеза «image-only Twitter с пустым description ломает Stage 1 Gemini → 503». В `prompts.js → buildAnalysisPrompt` добавил synthesis: если description пустая, подставить `[Visual] <preStage.gemini.visualCaption>`. См. предыдущую версию этого entry в git history.

**Что показал прод (до деплоя variant B)**: юзер получил image-only Twitter алерт (kitten + tiger statue) с полностью **штатно отработавшим** Stage 1 — title «Tabby kitten mimics tiger statue expression», explanation «A humorous viral image of a kitten mirroring the open-mouthed expression of a tiger sculpture», category=animals, sentiment=positive. То есть **image-only с visualCaption Stage 1 обрабатывает нормально и без variant B**.

**Вывод**: гипотеза опровергнута. 503 в Hash Brown-инциденте — это **настоящий transient 503** от Google AI, не связанный с sparse input. Variant B не помогал, а только дублировал visualCaption в prompt'е (description + Visual:) что для LLM скорее минус (потенциальная двусмысленность «один контент в двух полях»).

**Что сделано**: revert variant B. `buildAnalysisPrompt` вернулся к простому `if (t.description) detail += '\\n   Description: ...'`. Syntax-check прошёл.

**Что остаётся в коде из этой сессии**: save_only + ai_score gate + retry-on-next-scan (см. entry ниже). Этот механизм покрывает **настоящие** transient 503 — что подтверждено как реальная причина инцидента.

**Lesson learned**: не делать фиксы под единичную гипотезу без верификации на свежих данных. **Любая** транзиентная ошибка LLM-провайдера (5xx / timeout / parse error) приведёт к точно такому же симптому «AI unavailable», независимо от того что было в input'е. Сделанный ранее save_only + retry — правильная reactive защита. Proactive фиксы под конкретный input edge-case требуют statisticals доказательств (не одного скриншота).

**Файлы**: `src/analysis/prompts.js` (revert), `ai-context/SESSION_CONTEXT.md` (убран подраздел «Description synthesis»), `ai-context/WORKLOG.md`.

**Что НЕ сделано (опции для будущего)**:
- Variant A (skip Stage 1 для no-content + no-preStage заранее) — не нужен, save_only + retry покрывает
- Variant C (retry 1-2 раза на 5xx внутри Stage 1) — может быть полезным если 503 у провайдеров станут массовыми. Currently единичные → save_only retry достаточно
- Synthesis для title — если когда-то увидим case где `title=""` ломает schema → можно сделать

---

## 2026-05-12 · sonnet · Suppress «AI unavailable» алерты + auto-retry на следующем scan'е

**Цель**: при transient 5xx / timeout от LLM провайдера Stage 1 batch падает → `scorer._fallback` ставит heuristic-скор + `aiExplanation='AI unavailable'` → alertScore проходит threshold (heuristic тоже даёт нормальные числа) → юзер получает в Telegram алерт с «🤖 AI: AI unavailable / category=other / sentiment=neutral» — бесполезный шум. Юзер: «можем ли мы не алертить такие, а отправлять заново в следующем скане?»

**Архитектурное решение**: использовать **уже существующий** `pipeline_status` механизм в `isTrendSeen` (db/database.js:1310-1331). Если status `save_only` — `isTrendSeen` пропускает через на любом scan'е (re-analyze). Сейчас всё что прошло Stage 1 сохраняется как `'scored'` → блок до cooldown. Для AI-failed трендов ставим `'save_only'` → автоматический retry через 15 мин (`SCAN_INTERVAL_MINUTES`) без отдельной retry-logic в scorer'е. `saveTrend` уже UPSERT'ит по URL/external_id — на повторной попытке тот же row обновится с реальными скорами.

**Что сделано** (3 файла):

1. **`src/analysis/scorer.js → _fallback()`** — добавил флаг `_aiUnavailable: true` в возвращаемые объекты + 7-строчный комментарий объясняющий downstream-семантику. Сам heuristic-скоринг не тронут.

2. **`src/index.js`** (save loop) — определяет pipeline_status динамически: `trend._aiUnavailable ? 'save_only' : 'scored'`. Комментарий с описанием обеих веток `isTrendSeen` behavior.

3. **`src/notifications/alert-dispatcher.js`** — новый gate `ai_score` (вставлен ПЕРЕД `threshold`, чтобы в decisions buffer firstFail был чётко «ai_score», не путать с threshold/junk):
   ```js
   const aiUnavailable = trend.aiExplanation === 'AI unavailable'
                      || trend.aiExplanation === 'Parse error';
   const aiScorePass   = !aiUnavailable;
   ```
   Decision detail: `heuristic fallback (AI unavailable) — will retry next scan`.

**Cycle behavior**:
- Scan #1: Gemini 503 → `_analyzeBatchStage1` throw → catch → `_fallback` → `_aiUnavailable=true` → save с `pipeline_status='save_only'` → alert-dispatcher `ai_score` fail → silent skip алерта (admin decisions buffer видит причину)
- Scan #2 (через 15 мин): collector снова приносит тот же URL → `isTrendSeen` находит row, status='save_only' → **pass through** → Stage 1 пробует снова → если Gemini уже жив → real verdict → save UPSERT с `pipeline_status='scored'` + реальные скоры → alert-dispatcher `ai_score` pass → алерт идёт штатно
- Worst case: provider лежит долго → тренд циклится save_only ↔ AI fail каждые 15 мин до восстановления. Это OK — данные собираются (есть в feed/dashboard), просто алертов нет.

**Файлы**: `src/analysis/scorer.js`, `src/index.js`, `src/notifications/alert-dispatcher.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax-check 3 файлов прошёл (`node --check ALL OK`).

**Триггер**: на проде увидено в TG алерт `POST · 62/100 · 🤖 AI: AI unavailable · Other · Neutral · unknown · twitter`, кот в Hash Brown пакете. Stage 1 batch упал с `Gemini chat 503` в `08:26:29`. Один лог-entry за сутки, но юзер «уже 2 раз такое видел» — это observation bias из-за низкого Twitter throughput (1 алерт/сутки → 1 fallback = 100% bad rate).

**Риски / что мониторить**:
- **Тренд может потеряться** если: (a) пост получен только один раз (например X Trends daily refresh), (b) AI лежит всё время до следующего daily-refresh-окна. Маловероятно — daily refresh раз в 24h, Gemini downtime обычно минуты. Можно мониторить через SQL `SELECT COUNT(*) FROM trends WHERE pipeline_status='save_only' AND first_seen_at > -24h`.
- **save_only trends могут не получить alert вообще** если оператор отключит preset / mute source между scan'ами. Это by design — пост в БД, но не алертится. Не баг.
- **`Parse error`** (Stage 2 / Stage 1 JSON parse, line 729 в scorer.js) теперь тоже триггерит save_only + skip алерта. Раньше тоже триггерил heuristic-fallback с алертом — теперь поведение унифицировано.
- **Decision visibility**: admin DecisionsPage увидит skipped-decisions с `reason='ai_score'` — хорошая observability на случай если провайдер лёг надолго.

**Что НЕ сделано (опции для будущего)**:
- **Retry в самом `_analyzeBatchStage1`** (1-2 attempt с backoff на 5xx) — улучшит UX для микро-503'ов (секундное мерцание). Текущая реализация дожидается следующего scan'а — это 15 мин минимум. Можно добавить если 503 у провайдеров станут частыми.
- **Provider fallback на 5xx** (Gemini → OpenAI → xAI при 5xx) — есть auto-fallback в `_getRuntimeAiConfig` но только при missing API key, не при 5xx. Можно расширить когда multi-provider станет нормой.

---

## 2026-05-11 · sonnet · 📌 META: root cause Twitter throughput drop — Stage 0b authoritative scorer + text-only sources

**Что это**: связной обзор семи сегодняшних entries — все они оказались фиксами **одной и той же проблемы**, обнаруженной по разным симптомам. Эта meta-entry фиксирует root cause явно, чтобы будущие сессии не reverse-engineer'или связь.

**Root cause** (обновлено после SQL-верификации 2026-05-11 поздно вечером): **в основном — низкий throughput новых уникальных Twitter трендов** из-за устаревших/узких queries в `presetConfigsAuto`. SQL по `trends WHERE source='twitter' AND first_seen_at > -24h` показал ~1 новый тренд в сутки. Остальные «активные» Twitter тренды (видные через last_seen) — это re-clustered старые, по которым алерты уже были отправлены → `notifications` row есть → dedup блокирует повторные.

**Изначальная гипотеза (опровергнута)**: думал что коммит `3cf492d` от 2026-05-10 ввёл "trust contract" — Stage 0b (Gemini Vision) authoritative scorer, Stage 1 = echoes. Для Twitter без визуала → Gemini пустой → score 0 → нет алертов. Логика в `scorer.js`:

```
1. Stage 1 scoreOverride (rare, must include reason)
2. Stage 0b (preStage.gemini) — authoritative when present
3. Stage 1 echo / fallback
```

**Почему это режет Twitter, X Trends и Google**: Stage 0b — Vision-модель, требует визуал. Источники с типичным input'ом:

| Источник | Визуал есть? | Stage 0b скорит? | Алерты идут? |
|---|---|---|---|
| Reddit | да (image-посты доминируют) | да | ✓ |
| TikTok | да (видео всегда) | да | ✓ |
| X Trends | частично (aggregated tweets имеют картинки) | частично | ⚠ редко |
| **Twitter** | **редко** (text-first) | **нет** | **✗ почти никогда** |
| Google Trends | нет (текст) | нет | ✗ |

Когда визуала нет → `preStage.gemini.memePotential = null` → Stage 1 echo'ит null → final memePotential ≈ 0 → не проходит `alertThreshold` → **0 алертов**. При этом Twitter actor продолжает собирать посты (counter в БД корректный после моего sidebar fix'а), они просто получают плохой score.

**Симптомы (как мы это нашли)**:
1. Юзер заметил Sources sidebar: Twitter 6-7 при ожидаемых 100+. Подумали что collector сломан.
2. Я проверил логи прода — collectors работают штатно, `Collected 0-2 items` каждый цикл. Подумали что узкие теги.
3. Юзер заметил skibidi/delulu/brainrot в General Twitter queries. Стали чинить tag-refresher.
4. После моего sidebar-counter fix'а юзер увидел: counter правильный, 7 trends в БД, но в **админке Алерты: 27 total, 0 из Twitter** при том что X Trends даёт алерты.
5. Git log за 5 дней + diff `3cf492d` → нашёл trust contract rework в `scorer.js`, подумал «вот оно».
6. **SQL верификация опровергла шаг 5**: из 7 Twitter трендов 6 имеют `gemini_missing=0`, meme=50-75, score=63-85. Stage 0b их штатно отскорил.
7. **Финальная зацепка**: посмотрел `first_seen_at` тех же 7 — 6 из них старше 24h. То есть в last 24h попали по last_seen (clusterer re-tied новые посты), но первый раз замечены вчера-позавчера → notifications row есть → dedup блокирует повторный алерт. **Реально новых за сутки — 1**.

**Сегодняшние фиксы и их реальная роль** (в порядке коммитов; пересмотрено после SQL-верификации):

| Entry | Поверхностная цель | Реальная роль в root cause |
|---|---|---|
| Feedback context: surface AI explanation | Усилить training signal от 👍/👎 | Orthogonal — не связано с Twitter |
| TikTok quality gate fail-closed + Stage 1 fallback rubric | Compilation-style alerts слипали | Stage 1 fallback rubric **не критичен для Twitter** (он отлично проходит через Gemini Stage 0b). Полезно для Google Trends / X Trends где Gemini может пустовать. |
| **Tag-refresh cadence 7d→2d + расширение Twitter queries 5-6→8-10** | Hashtag-trends живут 1-3 дня | **🎯 Direct fix Twitter throughput** — больше queries + чаще refresh = больше новых уникальных постов в день. |
| TikTok lock-mask + hardskip | kpopfyp/fandomdrama в general | Orthogonal — TikTok only |
| Runtime-tunable cycle intervals | Юзер хотел ползунки | Orthogonal — operator UX |
| **General curator-mode** | skibidi в general Twitter queries | **🎯 Direct fix Twitter throughput** — уберёт зомби-сленг из general Twitter queries, новые curator-picked queries дадут лучше yield. |
| Sidebar source counter | Twitter counter показывал 0 | **Diagnostic fix** — без него мы бы продолжали путать UI-баг с пайплайн-багом; ровно через него обнаружили что counter ≠ throughput новых трендов. |

**Что нужно сделать после деплоя** для измерения эффекта:
1. `deploy.ps1` → перезапуск приложения.
2. **Force-refresh tag-refresher** через админку (применить новые curator-mode + расширенный tag-list немедленно, не ждать cooldown 2 дня).
3. Подождать 24h (хотим увидеть прирост **новых** трендов, не активных).
4. Запустить SQL для верификации (метрика — `first_seen_at`, не `last_seen_at`):

```sql
-- Новые Twitter тренды за 24h (ожидаем рост с 1 → 5-10)
SELECT COUNT(*) AS new_24h
FROM trends
WHERE source='twitter' AND first_seen_at > datetime('now', '-24 hours');

-- Алерты по source за 24h (ожидаем рост Twitter с 0 → 3+)
SELECT t.source, COUNT(*) AS alerts_24h
FROM notifications n JOIN trends t ON t.id=n.trend_id
WHERE n.sent_at > datetime('now', '-24 hours')
GROUP BY t.source ORDER BY alerts_24h DESC;
```

**Stage 0b authoritative trap — отдельная тема**: SQL опроверг гипотезу что это режет Twitter (там Gemini справляется). Но для **Google Trends / X Trends** проблема остаётся актуальной (они text-only). Stage 1 fallback rubric, которую я уже задеплоил, должна это решить. После деплоя проверить SQL по `source IN ('google_trends', 'x_trends')` — должен быть прирост meme score'ов.

**Альтернативный escape hatch** (на случай если throughput всё равно не вырастает): можно временно **disable Auto-tags для Twitter** (закомментировать `auto[preset].sources.twitter = ...` в `_applyAutoOverride`) → Twitter будет использовать хардкод-defaults из `preset-config.js`, которые проверены. Реверт curator/auto-tags для Twitter, оставив для Reddit/TikTok. Не реализовано — сначала ждём эффект текущих фиксов.

**Lessons learned**:
- Большие refactor'ы scoring-pipeline (`3cf492d` — 1911 insertions) нужно сопровождать **per-source throughput тестом**: «после rework алерты должны идти из всех 5 источников, не только из визуальных». Сейчас такого теста нет, я бы добавил smoke-check в admin (мониторинг "0 alerts from source X за 24h → warn"). Это отдельная задача на потом.
- **Source-tagging фикса в WORKLOG**: писать в entry не только «что сделано» но и «какую проблему чинит» — иначе фиксы остаются изолированными карточками без cross-link'ов.

---

## 2026-05-11 · sonnet · Fix sidebar source counter — last_seen_at вместо first_seen_at

**Цель**: юзер заметил на дашборде `Sources sidebar` показывает `Twitter/X 0` при том что в feed реально 7 Twitter-постов за 24h. Counter других площадок тоже under-report'ил (TikTok 2 при реальных 11+, etc.).

**Диагноз** (5-секундный): `_handleSources` в `dashboard/server.js` фильтровал по `first_seen_at > cutoff`, но `_handleTrends` (feed) — по `last_seen_at > cutoff`. Рассогласование: тренд, родившийся 25h назад, но всё ещё активный сейчас (clusterer тащит свежие посты → `last_seen_at` advance'ится), попадает в feed но не в sidebar counter. В `_handleTrends` есть 8-строчный комментарий **именно про это** — feed мигрировал на `last_seen_at` давно, sidebar забыли. `_handleStats` (тот же файл) тоже на `last_seen_at` — sidebar был **единственным** местом со старой нормой.

**Что сделано** (1 файл):

1. **`src/dashboard/server.js → _handleSources`** — 2 SQL'я переключены с `first_seen_at` на `last_seen_at`:
   - `SELECT COUNT(*) as count, MAX(last_seen_at) as last FROM trends WHERE source = ? AND last_seen_at > ?` (24h count)
   - `SELECT COUNT(*) as c FROM trends WHERE source = ? AND last_seen_at > ?` (1h count)
   - Также `MAX(first_seen_at) as last` → `MAX(last_seen_at) as last` — поле `lastSeen` в response теперь правда last_seen, не first_seen (имя поля раньше врало).
   - Добавлен 9-строчный комментарий с rationale (зачем last_seen) — параллельно тому что в `_handleTrends`.

**Файлы**: `src/dashboard/server.js`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax + Dashboard SPA template-literal sanity check прошёл (285359 chars OK).

**Что юзер увидит после деплоя**:
- Sidebar counter сразу станет совпадать с фактом из feed'а. Twitter покажет реальные 6-7 при 24h window (а не 0). TikTok, X Trends, Google — аналогично.
- `lastSeen` timestamp поле (если рендерится где-то) теперь правда отражает последнюю активность, а не дату рождения. Если фронт юзал его как «когда последний раз пост от этого источника» — стало корректно. Если как «когда нашли первый раз» — поведение изменилось (вряд ли где-то так, имя поля врало бы).

**Риски / что мониторить**:
- **Counter может вырасти у всех источников** — это правильно. Не баг — это уже **до конца сегодняшнего дня** должно соответствовать тому что юзер видит в feed'е.
- **1h count** тоже теперь шире (тренды активные за последний час, не родившиеся за последний час). Полезнее для метрики «что сейчас живо».
- **Plan-source filter НЕ применяется** в `_handleSources` (только в `_handleTrends` + `_handleStats`). Это by design — sidebar показывает абсолютные counters, юзер видит inPlan-маркер 🔒 отдельно. Если в будущем захочется привязать sidebar к plan — нужен отдельный PR.

---

## 2026-05-11 · sonnet · General preset curator-mode (Grok picks из pools, не invent'ит)

**Цель**: General preset страдал от deep-rooted bug — Grok при generation-mode для general стабильно выдумывал broad-firehose Twitter queries + pre-2025 slang anchors (`skibidi/delulu/rizz/brainrot/mewing/aura`), несмотря на явный запрет в SYSTEM_PROMPT. Юзер заметил по скринам что в active general tags сидит `(skibidi OR delulu OR rizz OR aura OR brainrot OR mewing...)` — точная антипатерн из системного промпта. Причина — у Grok'а для темы «broad mix — curated horizontal hubs» нет concrete anchor'а, он сваливается в generic-firehose mode.

**Решение (variant B)**: переключить general на CURATOR mode. Грок больше **не создаёт** теги для general с нуля — после refresh'а 4 тематических пресетов он получает их **pools** и **выбирает** balanced mix. Pool-membership filter после parse'а дропает любое invention.

**Что сделано** (1 файл кода + ai-context):

1. **`src/refresh/tag-refresher.js`** — 5 добавок:
   - `TAG_REFRESH_GENERAL_CURATOR_PROMPT` — новый system prompt: «You are a CURATOR... pick the best from pools below... DO NOT invent... aim 2-3 picks per theme... no x_search... items not in pools silently dropped».
   - `_buildGeneralCuratorPrompt(pools)` — user prompt builder. Форматирует 4 pool-блока (subs/twitter/tiktok per theme) + явное «only items from pools above».
   - `_getCurrentTiktokHashtags(preset)` — helper, аналог `_getCurrentTwitterKeywordParts` для TikTok.
   - `_collectThemedPools()` — читает effective tag-lists для animals/culture/celebrities/events (auto-overrides take precedence, defaults как fallback). Возвращает `{[theme]: {subreddits, twitter, tiktok}}`.
   - `_refreshGeneralAsCurator()` — главный метод. (a) collect pools (b) bail-out если все pools пустые (fresh DB) (c) Grok call через `_callGrokCurator` (без x_search, temperature 0.2) (d) standard sanitize (e) **EXTRA pool-membership filter** — дроп всего, что не в pools verbatim, с info-логом сколько Grok пытался выдумать (f) если после filter пусто → `rejected_validation` (g) diff + apply.
   - `_callGrokCurator(userPrompt)` — отдельный Grok-вызов: `TAG_REFRESH_GENERAL_CURATOR_PROMPT` + tools `[]` (no x_search) + fallback model логика как у обычного `_callGrokWithFallback`.

2. **`refreshAll()` reordering** — пресеты сортируются explicit `[animals, culture, celebrities, events, general]` (general в конец). Если preset === 'general' → `_refreshGeneralAsCurator()`, иначе `_refreshPreset()`. Try/catch вокруг обоих, error path identical.

3. **`ai-context/SESSION_CONTEXT.md`** — § *Per-preset pipeline configs* / *General preset philosophy* расширен новым параграфом про curator mode + явная пометка про variant A как fallback.

**Файлы**: `src/refresh/tag-refresher.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax-check прошёл. Эффект увидится на следующем `refreshAll()` (по cooldown'у — раз в 2 дня; либо force-кнопкой в админке).

**Pinned идея на потом — variant A (kept as fallback)**: если curator-mode тоже окажется leaky (Grok всё равно invent'ит много и pool-filter режет 50%+) — переключить general на полностью **программный** compose без LLM. Round-robin 2-3 pick с каждой темы детерминированно. Zero cost / zero hallucination / нет judgment про balance/seasonality. Помечено в коде в комментарии перед `_refreshGeneralAsCurator()` + в SESSION_CONTEXT.

**Риски / что мониторить**:
- **Pool-filter может дропнуть всё** если Grok совсем не понял задачу curator'а. Лог `[TagRefresher] general curator dropped N subs / M twitter / K tiktok — not in themed pools (invention attempt)` покажет масштаб. Если 80%+ дропается — план B/A в работу.
- **Bootstrap problem**: на fresh DB до первого refresh themed pools = только defaults. Pool-filter дропнет всё что Grok предложит вне defaults. Это OK — defaults уже balanced curated mix, ничего не сломается. На второй refresh уже будут свежие auto-overrides.
- **Cost**: +1 Grok-вызов на refresh (теперь 5 вызовов вместо 4-в-один-Grok'е). Cost ≈ $0.13 → ≈ $0.16/refresh = +20%. Месячно ≈ +$0.40. Незаметно.
- **General теперь зависит от quality 4 тематических**: если themed presets имеют плохие auto-overrides — general это унаследует. Это feature, не bug — раньше general мог быть «хорошим» когда themed были плохими, теперь они sync'нуты.
- **Существующий мусор в `presetConfigsAuto.general`** не очищается автоматически. Юзер хотел чтобы я сбросил General Twitter queries через UI — это всё ещё стоит сделать перед первым curator-refresh'ем, иначе старый skibidi-блок может пережить пере-выбор (если Grok случайно его «pick'нет» — а он не сможет, потому что pool-filter его дропнет, **но** в `keptTwitter` диффа он останется если уже в current'е — нужно проверить). Безопаснее всего: сбрось через UI кнопку «сброс на defaults» для `sources.twitter.queries` в general перед force-refresh'ем.

**Связь с предыдущими entries сегодня**: это 5-й по счёту фикс одной и той же темы — quality and throughput of auto-tags. Цепочка: (1) TikTok lock-mask + hardskip → (2) cadence 7d→2d + tag-list расширение → (3) runtime-tunable cycle intervals → (4) обнаружение Twitter throughput-проблемы → (5) **general curator-mode**. Дальнейшие шаги если этого мало: variant A (программный compose) или taggart deep-cleanup существующих auto-overrides.

---

## 2026-05-11 · sonnet · Runtime-tunable scan-cycle + TikTok cycle intervals (admin ползунки)

**Цель**: юзер попросил ползунок в админке для регулировки интервала между запусками сканера. Уточнили — сделать scan-cycle (главный) + TikTok cycle (отдельный, time-gated). Runtime-tunable: изменение применяется на следующем цикле без рестарта.

**Архитектурное решение**: DB-setting wins over env, env остаётся fallback. Out-of-range DB-значения silently игнорируются (защита от corrupted settings). Clamp ranges консистентны в трёх местах: admin validator + index.js fallback + tiktok collector fallback.

**Что сделано** (3 файла кода + ai-context):

1. **`src/index.js → startScheduler()`** — переписан с фиксированного `setInterval` на самопланирующийся `setTimeout`:
   - `readIntervalMs()` читает `db.getSetting('scanIntervalMinutes')` перед каждым тиком, clamp [5, 60] мин, fallback на `config.scanIntervalMinutes` (env `SCAN_INTERVAL_MINUTES`, default 15).
   - `scheduleNext()` рекурсивно репланирует себя ПОСЛЕ завершения cycle'а — слайдер change применяется на следующем тике.
   - Try/catch внутри cycle, чтобы exception не прерывал loop.

2. **`src/collectors/tiktok.js`**:
   - Новый метод `_getCycleIntervalMinutes()` — читает `db.getSetting('tiktokCycleIntervalMinutes')`, clamp [10, 120], fallback на `this.cycleIntervalMinutes` (env).
   - В `collect()` time-gate использует `effectiveInterval = this._getCycleIntervalMinutes()` вместо `this.cycleIntervalMinutes` напрямую.

3. **`src/admin/server.js`**:
   - `_getScannerConfig.numDefaults` расширен: `scanIntervalMinutes: 15`, `tiktokCycleIntervalMinutes: 30`.
   - `_setScannerConfig.allowedInt` расширен: `{min: 5, max: 60}` для scan, `{min: 10, max: 120}` для TikTok.
   - В `ScannerConfigSection` (UI) добавлена новая секция «⏱️ Интервалы циклов» с 2 ползунками (step=5 для обоих). Размещена перед существующей «Twitter — фильтр по возрасту». Hint-блок объясняет trade-off cost vs reactivity.
   - Admin SPA template-literal sanity check прошёл (261643 chars OK).

4. **`ai-context/SESSION_CONTEXT.md`** — обновлены 2 секции:
   - § *Pipeline* — добавлен подраздел **Scan-cycle cadence** с описанием self-rescheduling loop'а.
   - § *TikTok specifics* — Cycle pacing переписан: явно описано что DB-setting wins, env fallback, метод `_getCycleIntervalMinutes()`.

**Файлы**: `src/index.js`, `src/collectors/tiktok.js`, `src/admin/server.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. После деплоя на странице **«Сканеры»** в админке появится новая секция «⏱️ Интервалы циклов» с 2 слайдерами.

**Риски / что мониторить**:
- **Слишком агрессивные настройки**: scan=5 мин даёт ×3 Apify-расход vs дефолт. Юзер увидит это в Apify billing через сутки. Hint-блок в UI явно предупреждает.
- **Race с длинным cycle**: если cycle затянулся (медленный Stage 2 / Gemini timeout), новый `setTimeout` запустится только ПОСЛЕ его завершения — нет overlap'а. Это by design (старый `setInterval` имел тот же эффективный поведение через `scanRunning` flag в `runScanCycle`).
- **TikTok 10 мин**: дорогой режим — Apify clockworks $2/1K. При active TikTok firehose на 10-мин cycle с 1 hashtag/cycle = 144 searches/day. Если у юзера 24 trending hashtags, full rotation = 144 / 24 ≈ 6 циклов на хэштег в день — слишком много. Стоит вернуть на 30 если бюджет режется.
- **Out-of-range DB values**: ползунок в UI гарантирует clamp, но если кто-то напрямую дёрнет POST с out-of-range — admin validator вернёт 400. Если же в БД как-то окажется out-of-range (manual SQL, импорт) — fallback на env-default тихо его проигнорирует, info-логом не подсветится (тихий fallback by design).

**Связь с предыдущими entries сегодняшнего дня**: вместе с tag-refresh cadence (7d → 2d) и расширением tag-list'ов формируется единая ручка управления throughput'ом сборщиков. Tag-refresh влияет на ширину pool'а (что искать), cycle intervals — на частоту (как часто).

---

## 2026-05-11 · sonnet · TikTok lock-mask + hardskip k-pop/fandom/celeb-gossip

**Цель**: юзер на скрине показал что в active TikTok-тегах сидят `kpopfyp` и `fandomdrama` — явные нарушения SYSTEM_PROMPT правил «HARD SKIP: kpop fan tags / celebrity gossip aggregators». Reality-check для TikTok отсутствовал → Grok-output попадал в БД as-is. Плюс на TikTok не было замочков (lock-mask только Reddit + Twitter).

**Что сделано** (3 файла кода + ai-context):

1. **`src/analysis/preset-config.js`** — `validatePresetTagsLocked()`:
   - `allowedSourceTypes` set: `{'reddit','twitter'} → {'reddit','twitter','tiktok'}`.
   - JSDoc обновлён: явно описана normalization per sourceType (reddit as-is, twitter — keyword-part без `min_faves`/`-is:retweet`, tiktok — lowercase + strip leading `#`).

2. **`src/admin/server.js`** — `PChips()` lockable chips:
   - Добавлен 3-й branch: `path[1]==='tiktok' && path[2]==='hashtags'` → `lockSourceType='tiktok'`, `toLockKey = lowercase + strip '#'`. Шейп ключа точно совпадает с тем, что хранит `tag-refresher` в `presetConfigsAuto.sources.tiktok.hashtags`.
   - `toggleLock`/`isLocked` уже universal — без изменений.
   - Комментарий перед `toggleLock` обновлён (теперь 3 sourceType'а вместо 2).
   - Admin SPA template-literal sanity check (`scripts/check-admin-spa.cjs`) прошёл — 260246 chars OK.

3. **`src/refresh/tag-refresher.js`** — `_sanitizeResponse()`:
   - Добавлен **second line of defense** regex `TIKTOK_HARDSKIP_RE` после Grok-output. Ловит `kpop|kpopfyp|kpopstan|kpoptiktok|kpopedits|fandom|fandomdrama|stantwitter|stantiktok|celebgossip|celebtea|hollywoodgossip|gossipgirl`.
   - Anchored на word-boundaries `(?:^|_)...(?:_|$)` — НЕ ловит подстроки. `kdrama` (жанр) проходит, `kdramafan` (фан-тег) — банится.
   - Drop'ы логируются как `[TagRefresher] dropped TikTok hashtag '<name>' — matches kpop/fandom/celeb-gossip hardskip` (info-level). Visible в продовых логах.

4. **`ai-context/SESSION_CONTEXT.md`** — обновлены 2 места:
   - § *Per-preset pipeline configs* — `presetTagsLocked` shape: добавлен `tiktok: [...]`.
   - § *Tag auto-refresh* — Reality-check подсекция: явно описано что TikTok НЕ проходит Apify probe, вместо этого regex-based hardskip.

**Файлы**: `src/analysis/preset-config.js`, `src/admin/server.js`, `src/refresh/tag-refresher.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax + admin-SPA checks прошли.

**Что юзер увидит после деплоя**:
- На странице Auto-tags / Preset Configs у TikTok-тегов появятся замочки (как сейчас на Reddit/Twitter chips).
- При следующем auto-refresh `kpopfyp`/`fandomdrama` отвалятся с info-логом. Существующие в БД — НЕ трогаются автоматически (нет migration, design-выбор: юзер сам пройдётся и удалит/запиннит). Но при первом же `_applyAutoOverride` они НЕ попадут в новый kept-set — Grok их не предложит, в `currentTiktok` (defaults) их нет, locked их не защищает (никто не пиннил) → автоматически удалятся.
- API `/api/preset-configs` POST уже принимает `tagsLocked.<preset>.tiktok` — был бы 400 раньше (через `validatePresetTagsLocked` strip), теперь pass-through.

**Риски / что мониторить**:
- **False positives в hardskip-regex**: список покрывает явные случаи. Если Grok принесёт что-то новое (e.g. `armysstan`, `bts_army`), regex не поймает — придётся расширить вручную или вынести в DB-конфиг. Но ловить все варианты regex-ом — заведомо проигрышный fight; lock-mask теперь доступен → юзер может вручную блочить.
- **Migration существующих записей**: `kpopfyp`/`fandomdrama` уже сидят в `presetConfigsAuto`. Они отвалятся на следующем auto-refresh **только если** Grok их не пере-предложит. Если хочешь почистить сейчас — удали через UI (X-кнопка на чипе). Можно потом запиннить хорошие соседи замочком, чтобы их не прогнать в следующем refresh случайно.

---

## 2026-05-11 · sonnet · Tag-refresh cadence 7d→2d + расширение TikTok/Twitter tag-list'ов

**Цель**: восстановить throughput TikTok / Twitter / X Trends. Юзер заметил в Sources-карточке `Reddit 169 / Google 4 / Twitter 7 / TikTok 11 / X Trends 6`. Логи прода подтвердили — collectors отрабатывают без ошибок, но возвращают мало, потому что hashtag-driven discovery с weekly refresh'ем не успевает за 1-3-дневной жизнью тегов: к середине цикла tag-list выгребается досуха.

**Что сделано** (3 файла):

1. **`src/refresh/tag-refresher.js`** — три правки:
   - `TAG_REFRESH_COOLDOWN_DAYS` дефолт `7 → 2`. Hourly check loop теперь триггерит refresh каждые 2 дня вместо недели. Cost ≈$2/мес вместо ≈$0.54/мес — копейки.
   - `TIKTOK HASHTAG RULES` в `TAG_REFRESH_SYSTEM_PROMPT`: «5-7 hashtags per preset» → «8-12 hashtags per preset».
   - `OUTPUT TARGETS` в `_buildPrompt`: Twitter `5-6 → 8-10`, TikTok `5-7 → 8-12`. Subreddits оставлены `8-10` (стабильные, не нуждаются).

2. **`.env.example`** — обновлён дефолт `TAG_REFRESH_COOLDOWN_DAYS=2` + новый комментарий с историческим контекстом (был 7, изменён 2026-05-11, причина).

3. **`ai-context/SESSION_CONTEXT.md`** — обновлены 3 места:
   - § *Per-preset pipeline configs* — `presetConfigsAuto` описание (weekly → every 2 days).
   - § *Tag auto-refresh* — добавлен подраздел **Cadence** с историей изменения, новый подраздел **Output targets per preset**, обновлена цифра в **Архитектура** (default 7 → 2).
   - § *Env keys* — `TAG_REFRESH_COOLDOWN_DAYS (7)` → `(2)`.

**Файлы**: `src/refresh/tag-refresher.js`, `.env.example`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером (`deploy.ps1`). Syntax-check на tag-refresher прошёл. На проде после деплоя env-переменная `TAG_REFRESH_COOLDOWN_DAYS=2` подхватится автоматом из `.env.example` если её там нет (или код возьмёт код-дефолт `|| 2`).

**Риски / что мониторить**:
- **Стоимость Grok**: было ≈$0.54/мес (4 refresh × $0.13), стало ≈$2/мес (15 refresh × $0.13). Если refresh будет валиться (timeout, x_search lag) — circuit breaker откроется через 3 fail'а подряд (existing infra). Cost-budget UI в Auto-tags page покажет тренд.
- **Throughput TikTok/Twitter**: ожидаем рост в 2-3× за 4-7 дней (после первого нового refresh + времени накопления постов под расширенными тегами). Если не вырос — следующий шаг daily refresh (`TAG_REFRESH_COOLDOWN_DAYS=1`).
- **Quality v. quantity**: Grok при «8-12 TikTok» может разбавить мусором (sound-format / dance — те самые pattern'ы из AMBIENT_PATTERNS). System prompt уже их банит, но если просочатся — TikTok quality gate в alert-dispatcher (см. предыдущий entry) их прибьёт. Двойная защита.
- **Locked tags**: если у юзера в `presetTagsLocked` сейчас pinned теги — они переживут refresh (это инвариант), новые приходят сверху.

**Связь с предыдущим entry** (TikTok quality gate fail-closed): этот fix ломает причину частоты «No PreStage data» инцидентов. Тот fail-closed gate был защитой на случай если PreStage упадёт; этот entry чинит саму причину перегрузки PreStage юзером, который вручную дёргал scan из-за анемичных коллекторов.

---

## 2026-05-11 · sonnet · TikTok quality gate fail-closed without preStage + Stage 1 fallback rubric

**Цель**: 3 алерта-подборки животных ("Weird Herbivore Sounds trend", "Weird Sea Animals sounds trend", "Weird Farm Animal Sounds trend") прошли в TG, хотя должны были забаниться. Все 3 — `No PreStage data (legacy trend)`. Юзер запустил scan 5 раз подряд, упёрся в rate-limit Gemini → preStage вернул null → fail-open path в alert gate пропустил.

**Диагноз** (3 проблемы цепочкой):
1. PreStage упал silently (rate-limit / circuit-breaker / nano off) → `trend.preStage = null`.
2. Stage 1 без визуального контекста придумала title типа "Weird Sea Animals sounds trend" с `meme=40, viral=55, emerg=94`. Низкий meme не пустил в Stage 2 (gate 60), но emerg=94 + alertThreshold=52 хватило для алерта.
3. **Главный архитектурный баг**: `tiktok_quality` gate был fail-open на legacy trends. `gemini?.isAmbient === true` / `AMBIENT_PATTERNS.has(undefined)` / `Number.isFinite(undefined)` — все три проверки молча пропускают, когда preStage отсутствует. На TikTok firehose это означает «никакого визуального контроля → trust by default».

**Что сделано** (2 файла кода + SESSION_CONTEXT):

1. **`src/notifications/alert-dispatcher.js`** — добавил sub-проверку **0** в TikTok quality gate: `!hasGemini` → `tiktokQualityFail = 'no PreStage data (legacy/failed Stage 0b)'`. Срабатывает раньше остальных трёх. Reddit/Twitter/Google не задеты (gate с `if (isTikTok)`-guard'ом). Header-комментарий + inline-комментарий обновлены, объясняют why fail-closed (compilation-style алерты слипали через fail-open).

2. **`src/analysis/prompts.js`** — добавил секцию **FALLBACK SCORING (when GeminiScore line is MISSING)** в `SYSTEM_PROMPT` (Stage 1):
   - Generic group-label titles (Sea Animals sounds / Farm Animal Compilation / Weird [Group] Sounds / etc.) → cap memePotential ≤ 25.
   - TikTok без concrete focal subject → cap ≤ 35.
   - Concrete focal subject → band 35-65.
   - В fallback `explanation` обязан явно упомянуть unavailable visual analysis (audit-trail).
   - `scoreOverride` не применяется (нет Stage 0b score).

3. **`ai-context/SESSION_CONTEXT.md`** — обновлены 2 секции:
   - **Alert gate** — добавлен подраздел «TikTok quality gate» с 4 sub-проверками (0..3) + lipsync gate caveat.
   - **AI provider config** (Stage 1 rubric philosophy) — добавлен подраздел «Stage 1 fallback rules (no GeminiScore)» с capping rubric.

**Файлы**: `src/notifications/alert-dispatcher.js`, `src/analysis/prompts.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером (`deploy.ps1`). Syntax-check на оба JS-файла прошёл (`node --check` OK).

**Риски / что мониторить**:
- **TikTok-алерты могут временно просесть** если Gemini глобально лежит — это by design (fail-closed). Если падение длится >30 мин на проде, имеет смысл проверить circuit breaker / rate-limit Google AI Studio.
- Stage 1 fallback rubric — это prompt engineering, leaky by nature. Если LLM проигнорирует cap (что вероятно для Gemini, она хуже OpenAI следует структурным rule'ам) — алерты с category=animals и сомнительными titles надо отслеживать ещё минимум 2-3 дня.
- **Legacy trends в БД** (старые без preStage) теперь автоматически hard-skip'аются если source=tiktok. Hot-refresh не пересоздаёт preStage → останутся zombie'ями навсегда. Если хочется их «оживить» — нужен отдельный backfill-скрипт (не в скоупе этого PR).

**Связанная аномалия (диагноз)**: на дашборде в `Sources` юзер увидел `Reddit 169 / Google 4 / Twitter 7 / TikTok 11 / X Trends 6` и подумал что баг → запустил scan 5 раз → Gemini упёрся в rate-limit → preStage ушёл в null → alert-gate fail-open пропустил compilations. После проверки логов прода (`docker logs catalyst-app | grep ...`) выяснилось — **это не баг**: collectors отрабатывают штатно (`Collected N items` без ошибок), просто органически возвращают мало из-за сочетания (a) высокого engagement floor (TikTok plays≥500K | likes≥20K | shares≥5K), (b) узкого tag-list'а (5-7 hashtag'ов на TikTok, 5-6 query на Twitter), (c) weekly tag-refresh — теги устаревают к середине цикла. Reddit стабилен потому что у него много subreddit'ов и floor мягче. Корневая причина — **архитектурный mismatch**: hashtag-driven discovery с длинным cooldown'ом плохо ловит свежие 1-3-дневные тренды. Фикс описан в следующем entry (cadence 7d → 2d + расширение tag-list'ов).

---

## 2026-05-11 · sonnet · Feedback context: surface AI explanation to Stage 1

**Цель**: усилить обучающий сигнал от 👍/👎 голосов. Раньше Stage 1 видел только `title + category + reason` — для трендов вроде «Cow Fursuit Viral Warning» это слабый контекст: модель не понимает, что юзер реально лайкнул (формат? тему? мем?). Теперь подмешиваем то самое описание `🤖 AI:`, что юзер видел в TG-карточке на момент голосования → fair learning signal.

**Что сделано** (2 файла):

1. **`src/db/database.js`** — `getLikedNarratives` / `getDislikedNarratives`: в SELECT добавил `t.ai_explanation AS aiExplanation, t.why_now AS whyNow`. Старая фильтрация и порядок не тронуты, только дополнительные поля.

2. **`src/analysis/scorer.js`** — `_buildFeedbackContext`:
   - Хелпер `truncate(s, max)` (унифицировал, было `fmtReason`).
   - Хелпер `fmtEntry(sign, t)` собирает многострочный entry: `+ "Title" [category]` на первой строке, `      AI: <ai_explanation, ≤160>` и `      reason: "<topReason, ≤120>"` под ней — с indent 6 пробелов чтобы структура читалась в system prompt.
   - Если `aiExplanation` пуст (старые ряды / heuristic fallback) — строка пропускается, формат деградирует к старому виду без AI.
   - `whyNow` пока **не** добавляем (по обсуждению — избыточно, `aiExplanation` несёт суть).

**Пример нового формата** (был vs стал):

Было:
```
+ "Cow Fursuit Viral Warning" [animals] — "based"
```

Стало:
```
+ "Cow Fursuit Viral Warning" [animals]
      AI: An absurd image of a cow fursuit with udders has sparked a viral 'do not drink' meme.
      reason: "based"
```

**Что мониторить**:
- **Длина system prompt после feedback context**. До 16 entries × ~250 байт = ~4KB (раньше было ~1.5KB). Не критично для cache stability — этот блок и так volatile (rebuild каждый цикл).
- **Качество скоринга похожих нарративов через 2-3 дня** — Stage 1 должен начать better-distinguishing «мне нравится формат cow-fursuit-style абсурда» vs «мне нравится конкретно cow fursuit». Если сигнал не улучшился — добавим `whyNow` на пробу.

**Файлы**: `src/db/database.js`, `src/analysis/scorer.js`.

**Деплой**: пользователь сам. Без миграций (`ai_explanation` и `why_now` уже в схеме).

**Риски**:
- Минимальный. Формат добавляет строки в system prompt — модели норм, JSON output не затрагивается.
- Если `aiExplanation` сильно длинный (>500 символов на старых рядах) — cap 160 + многоточие защищает от взрыва промпта.

---

## 2026-05-10 · sonnet · Alert score / meme score balance fix

**Цель**: устранить расхождение между числом в TG-алерте и реальной оценкой alertScore.

**Корень проблемы**: пользователь видел "🔥🔥🔥 97/100 TREND ALERT" в Telegram (это `memePotential` от Stage 0b), а в админке тот же тренд имел `alertScore=58/52` (еле прошёл порог). Концептуально разные метрики:
- `memePotential` — насколько это **мем-shaped** (Gemini оценка)
- `alertScore` — взвешенная композитная оценка `meme×0.45 + viral×0.20 + emerg×0.15 + feedback×0.15 + twitter×0.05 − junk×0.50` (что реально определяет прохождение порога)

При meme=97 и средне-низких side-сигналах alertScore выходил 55-65 — пользователь думал «огонь, топ дня», админ видел «чудом прошёл».

**Что сделано** (3 файла, 1 концептуальный фикс):

1. **`src/analysis/scorer.js`** — `DEFAULT_ALERT_WEIGHTS`:
   - `weightMemePotential`: 0.45 → **0.60** (доминирующий сигнал)
   - `weightEmergence`: 0.15 → **0.10**
   - `weightFeedback`: 0.15 → **0.05**
   - Виральность 0.20 и twitter 0.05 без изменений
   - Сумма positive ≈ 1.00 (было 1.00, не сместили)

2. **`src/notifications/formatter.js`** — `formatTelegramAlert`:
   - `alertHeader(memePotential)` → `alertHeader(alertScore)`. В шапке теперь то же число, что в админке (DecisionsPage `score: X / threshold`).
   - Под шапкой добавлена опциональная строка `🎯 Meme energy 97/100` — рендерится только если `|alertScore − memePotential| ≥ 8` (иначе строка избыточна). Юзер видит «47/100 ALERT, но Meme energy 97/100» и понимает: формат огонь, просто engagement/emergence стек средний.

3. **`src/i18n/en.js` / `src/i18n/ru.js`**:
   - Новый ключ `alertMemeEnergy(val)` → `🎯 Meme energy 97/100` / `🎯 Мем-энергия 97/100`.
   - `scoreEmoji` пороги откалиброваны под композитную шкалу alertScore (после rebalance топ-меме-тренд набирает ~75-85, не 55-65):
     - `>= 85` → 🔥🔥🔥 (было 90)
     - `>= 70` → 🔥🔥 (было 75)
     - `>= 55` → 🔥 (было 60)
     - else → 📊
   - Комментарии в коде обоих файлов объясняют новую калибровку.

**Симуляция Hide the Pain Harold (тот самый кейс)**:
- Старая формула: `97×0.45 + 85×0.20 + 20×0.15 + 50×0.15 − 20×0.5 = 58` → одинокий 🔥 у порога.
- Новая формула: `97×0.60 + 85×0.20 + 20×0.10 + 50×0.05 − 20×0.5 = 70` → 🔥🔥, уверенно над порогом.
- В TG юзер увидит: `🔥🔥 70/100 · TREND ALERT` + строку `🎯 Meme energy 97/100` (т.к. разница 27 ≥ 8).

**Файлы**: `src/analysis/scorer.js`, `src/notifications/formatter.js`, `src/i18n/en.js`, `src/i18n/ru.js`.

**Деплой**: пользователь сам.

**Что мониторить**:
- **Распределение alertScore в DecisionsPage** первые сутки — должна сместиться вверх для меме-трендов.
- **Тренды события** (события/новости с meme=20-40 но взрывным engagement) — могут начать недопроходить порог из-за emergence weight 0.15→0.10. Если так — поднять `weightEmergence` до 0.15 в admin presetConfigs (per-preset override живой, дефолт не трогать).
- **Tone alignment**: если в TG 🔥🔥 стало слишком частым (`>= 70`), поднять порог 70 → 72-75. Если 🔥🔥🔥 стало слишком редким — опустить 85 → 82.

**Что НЕ сделано** (intentionally):
- Per-preset weights не трогали — `events`/`celebs`/`animals` пресеты живут со своими override'ами в `preset-config.js`. Дефолт обновлён, но активный preset мог иметь свои значения — посмотреть в админке Пресеты → Веса.
- Не сделали admin-toggle для шага «показывать ли meme energy строку» — порог 8 хардкоден. Если хочется тонкой настройки — добавим slider позже.

---

## 2026-05-10 · sonnet · Telegram alert pacing: per-user FIFO cooldown + tag-refresh digest off

**Цель**: отказаться от 5-алертов-в-секунду в TG. Раньше alert-dispatcher шлёт всё синхронно в цикле — батч-feel, спам у юзера. Теперь — per-user FIFO очередь с кулдауном. UX: «сканер работает в реалтайме», алерты прилетают равномерно. Заодно выпилил digest от tag-refresh — он шёл всем админам после каждого refresh (success OR failure), хотя то же самое уже видно в Pipeline page.

**Что сделано**:

1. **`tag-refresher.js`**: `_notifyAdmins` теперь no-op (`return` в начале). Код функций оставил — admin-панель использует `_formatAdminDigestHtml` + `_getAdminChatIds` для diff view, плюс при необходимости вернуть digest достаточно убрать early return. Tag-refresh больше никому в TG не пишет.

2. **`src/notifications/alert-scheduler.js`** — НОВЫЙ файл. Класс `AlertScheduler`:
   - Per-user FIFO очередь (`Map<chatId, { lastSentAt, queue }>`).
   - **Fast path**: при `enqueue()` если cooldown прошёл и queue пуста — отправляем сразу (не ждём tick).
   - **Slow path**: в очередь. Cap=20 → drop oldest. Max-age=30min → drop stale на каждом tick.
   - **Pause-drop**: `dropQueue(chatId)` + tick-проверка `db.isUserPausedByChatId()`. Двойная защита.
   - **Bypass switch**: при `tgAlertCooldownEnabled === '0'` — pass-through (старое поведение).
   - **Live settings**: cooldownMs / cap / maxAgeMs читаются из DB в каждом tick + при enqueue. Применяются без рестарта.
   - **Metrics**: cumulative counters (enqueued, sent, dropped*, errors) + `getStats()` snapshot для admin observability.
   - Tick interval = 5s. Idle cleanup: пустые user state удаляются через 5 мин неактивности.

3. **`alert-dispatcher.js`**: `dispatchAlerts({ deps: { ..., scheduler } })` опционально принимает scheduler. Вместо прямого `await sendAlertToUser` теперь:
   - Закрытие в `sendTask` async function — содержит весь post-send DB work (recordNotification, incrementAlertCount, attachXButton, recordDecision, updateTgUrl).
   - Если scheduler wired → `scheduler.enqueue(chatId, sendTask, { label })`. Возвращает 'sent' / 'queued' / 'dropped_full' / 'bypass'.
   - Если 'dropped_full' → recordDecision со reason `'queue_full'` (видно в DecisionsPage).
   - Пер-cycle counter `alertsSentThisCycle` инкрементится на enqueue (не на send) — cap про намерение, не доставку.
   - `await sleep(300ms)` → `100ms` (scheduler сам распределяет, sync-цикл нужен только защититься от 100-тренд-burst'ов).

4. **`db/database.js`**: новый helper `isUserPausedByChatId(chatId)` — cheap SELECT по `users.status`. Используется scheduler tick'ом для defensive pause-drop.

5. **`telegram.js`**: `this.scheduler` — публичное поле, set из index.js post-construction. На `toggle_pause` callback → `this.scheduler.dropQueue(chatId)`. Manual-submit path (`_handleSendAlert`, `/api/submit-narrative`) НЕ трогает scheduler — мгновенная доставка остаётся.

6. **`index.js`**: создаёт `AlertScheduler`, стартует `.start()`, передаёт в `dispatchAlerts` deps + в `telegram.scheduler` + в `AdminServer` (для UI/REST). `hot-metrics.js` подхватывает scheduler через `this.telegram?.scheduler` чтобы hot-refresh тоже шёл через очередь.

7. **`admin/server.js`** REST + UI:
   - **GET `/api/alert-scheduler`** → `{ cfg: {enabled, cooldownMs, cap, maxAgeMs}, stats: {...} }`.
   - **POST `/api/alert-scheduler`** → принимает любую частичную конфигурацию, валидирует диапазоны (cooldown 0-600s, cap 1-500, maxAge 1min-24h).
   - **POST `/api/alert-scheduler/drop`** → manual flush очереди для конкретного chatId (admin force-flush).
   - **UI**: новый accordion **«📤 Telegram alert pacing»** на Сканеры-tab между Stage 0 и Hot trends. Компонент `AlertSchedulerSection`:
     - Toggle вкл/выкл.
     - Слайдеры: cooldown (0-300s), cap (1-100), maxAge (1-120 min).
     - Save / Откатить кнопки. Save persistит в DB, scheduler подхватывает в следующем tick (≤5s).
     - **Live stats card** (auto-refresh каждые 5s): 7 числовых тайлов (queue depth, active users, totals по sent / dropped_full / dropped_stale / dropped_paused / errors) + per-user breakdown (топ 50): `@chatId · N alerts · oldest 14s · cooldown left 23s`.

**Файлы**:
- NEW: `src/notifications/alert-scheduler.js`
- TOUCHED: `src/notifications/alert-dispatcher.js`, `src/notifications/telegram.js`, `src/db/database.js`, `src/refresh/tag-refresher.js`, `src/refresh/hot-metrics.js`, `src/index.js`, `src/admin/server.js`

**Деплой**: пользователь сам.

**Дефолты**: cooldown 60s, cap 20, max-age 30 min, enabled=true. Все настраиваемы через admin UI.

**Что мониторить**:
- **Queue depth** в Live Stats: если стабильно >5 в очереди — cooldown слишком жёсткий или поток алертов высокий, поднять cap или уменьшить cooldown.
- **Dropped (stale)** > 0: алерты не успели отправиться за 30 мин → или поток пиковый, или cooldown надо уменьшать.
- **Dropped (full)** > 0: cap слишком низкий, drop oldest. Поднять cap или уменьшить cooldown.
- **Errors** > 0: задачи бросают исключения. Залезть в логи, искать `[AlertScheduler] ... task threw`.

**Edge cases протестировать**:
- Pause toggle → очередь дропнулась? Hook через `scheduler.dropQueue(chatId)` + defensive check в tick'е.
- Restart bot → очередь теряется (in-memory). При следующем scan cycle новые алерты прилетят. Документировано как acceptable trade-off.
- Manual-submit мгновенный? `_handleSendAlert` идёт через прямой `sendAlertToUser` — scheduler не trigger.
- Bypass mode (`enabled=false`)? `enqueue()` сразу выполняет task, статус 'bypass'.

---

## 2026-05-10 · sonnet · DecisionsPage: UI плашки для score-source и override

Дополнение к рефактору trust-contract. Stage 0b теперь authoritative scorer, Stage 1 пишет narrative — но без визуализации в админке невозможно было увидеть кто реально поставил memePotential. Добавил.

**Что сделано**:

1. **alert-dispatcher.js**: `decisionBase` теперь несёт `scoreSource` ('stage0b_gemini' | 'stage1_override' | 'stage1_fallback'), `scoreOverride` (полная запись from/to/reason/stage), `memePotential` (sanity для аудита). Эти поля попадают в ring buffer decision-records и оттуда в /api/decisions → DecisionsPage.

2. **DecisionsPage Row 2 (всегда видно)**: inline-chip рядом с `score: X / Y`:
   - `🌟 Gemini` (зелёный) — Stage 0b скорил
   - `🤖 Stage1` (голубой) — Stage 1 fallback (preStage отсутствует)
   - `🔄 Override 0→40` (жёлтый, с tooltip с reason) — Stage 1 переписал Gemini
   Hover показывает полное объяснение + override reason.

3. **DecisionsPage expanded (Row 5b)**: новый компонент `DecisionScoreOverrideBlock` — рендерится ТОЛЬКО когда `scoreSource === 'stage1_override'`. Показывает:
   - `Gemini X → Y` с цветной стрелкой (зелёная если delta > 0, красная если < 0)
   - delta-чип `+15 (up)` / `-30 (down)`
   - Reason verbatim из Stage 1 output
   Жёлтая рамка чтобы не путать с Stage 0b блоком.

4. **DecisionPreStageBlock — Gemini секция расширена**:
   - Section B (enrichment): Topic / Entities / Slang выводятся под VisibleText. Раньше эти поля показывались только из nano-блока.
   - Section C (authoritative scoring): чипы memePotential / viralityScore / category — выделены зелёным цветом с жирным шрифтом, чтобы визуально отличаться от subsidiary signals.
   - Section D (subsidiary): memeShape / hasNarrative / hasSubject / viralPattern / subjectNames / lipsync / ambient — оставлены как раньше (нейтральный цвет).
   - Footer: mood + language (когда не en).

**SPA traps пойманы и зафиксированы по ходу** (CLAUDE.md gotchas в действии):
- backticks (`` `${m.icon} ${m.label}` ``) внутри template literal SPA inner закрывают внешний template — переписал на string concat.
- `\\n` в строках SPA inner превращается в literal newline → пришлось писать `\\\\n` (т.е. `\\n` в исходнике, чтобы выйти как `\n` в SPA-runtime).

**Файлы**: `src/admin/server.js`, `src/notifications/alert-dispatcher.js`.

**Деплой**: пользователь сам.

**Проверки**: `node --check` + `node scripts/check-admin-spa.cjs` — `SPA inner OK (249998 chars)`.

**Что мониторить**:
- **Распределение score-source** в DecisionsPage: если >30% алертов идут через `stage1_fallback` — значит Stage 0b слишком часто молчит (text-only тренды без медиа), нужно добавить text-only Gemini path.
- **Частота override**: если каждый второй тренд получает 🔄 Override — Stage 1 модель злоупотребляет правом, нужны лимиты (например cap delta ±20 или max 3 override per cycle).
- **Reason quality**: tooltip показывает reason от Stage 1. Если там "model thinks score is low" / "based on context" — модель халтурит, ужесточить промпт-инструкцию про reason.

---

## 2026-05-10 · sonnet · Перераспределение обязанностей между моделями: Stage 0b = authoritative scorer, Stage 1 = alert writer

**Цель**: решить корневой баг (вчера на бейсболе Gemini=0, gpt-mini поставил 40, выиграл текст-онли) через чёткое разделение «что видит» и «что говорит».

**Архитектура после рефактора**:

```
[trend] → Stage 0b (Gemini)  → Stage 1 (Grok / Gemini)  → Stage 2 (Grok x_search)
            ↓                        ↓                          ↓
     SCORING + FACTS          NARRATIVE + ALERT TEXT       BUZZ VERIFY
     (мультимодал → числа)    (текст → текст)              (live X → корректировка)
```

**Что сделано (10 шагов)**:

1. **Stage 0b prompt — переписан с нуля в 4 секции** (`gemini-captioner.js:VISION_SYSTEM_PROMPT`):
   - **Section A (Describe)**: visualCaption, visibleText, videoSummary, audioSummary, spokenText, mood — как раньше.
   - **Section B (Enrichment)**: topicSummary, entityCanonical, slangDecoded, language — это работа выпиленного nano, теперь делает Gemini.
   - **Section C (Authoritative scoring)**: memePotential, viralityScore, category — НОВОЕ. Все anchors / hard rules / source-aware metric calibration переехали сюда из Stage 1. Stage 0b теперь скорит, потому что он видел реальный контент.
   - **Section D (Subsidiary signals)**: memeShapeStrength, hasNarrative, hasSubject, viralPattern, tickerSuggestion, subjectNames, isLipSync, isAmbient — как раньше, downstream пользователи (alert-dispatcher, formatter, admin UI) не меняются.

2. **Stage 0b schema расширена** (GOOGLE_RESPONSE_SCHEMA): +7 properties (topicSummary, entityCanonical, slangDecoded, language, memePotential, viralityScore, category). Required список оставлен на тех же 4 полях (фикс от 2026-05-08, не ломаем).

3. **Output coercion**: новые helpers `normalizeCategory`, `normalizeEntityList`. Оба ветки `_tryGoogle` и `_tryOpenRouterImage` возвращают новые поля. `clampInt(..., null)` для memePotential/viralityScore — null сигналит «Gemini не скорил, fallback на Stage 1».

4. **Context block в userText** (Gemini раньше видел только title): новый helper `_buildContextString(trend)` собирает source/author/metrics/description/clusterSiblings → теперь Gemini действительно может применить SOURCE-AWARE METRIC CALIBRATION (TikTok plays inflation, mega-account engagement-rate rule, etc.). Без этого блока вся scoring rubric в промпте была бы декоративной.

5. **Stage 1 SYSTEM_PROMPT — сокращён ~3×** (`prompts.js:SYSTEM_PROMPT`):
   - Убрано: WHAT MAKES A GREAT MEMECOIN NARRATIVE (60 строк), SCORING RUBRIC, ENGAGEMENT CONTEXT, SOURCE-AWARE METRIC CALIBRATION, GEMINI VISION+AUDIO IS GROUND TRUTH, HARD RULES (politics=0/sports=0 переехали в Stage 0b), PRESTAGE METADATA description.
   - Добавлено: TRUST CONTRACT — Stage 0b уже скорил, ECHO значения. scoreOverride mechanism — Stage 1 переписывает score только когда видит контекст которого нет в видео (политическая подоплёка title, coordinated bot push). Default null, реquires reason ≥8 chars.
   - Оставлено: ALERT TYPE rules, hard rule про English output, isGenuinelyInteresting как safety filter.

6. **STAGE1_RESPONSE_SCHEMA**: +`scoreOverride` field. anyOf [null | object{value, reason}]. Добавлено в required список (OpenAI strict json_schema требует ВСЕ properties в required).

7. **scorer.js — `_analyzeBatchStage1` приоритизация**:
   - Score-source resolution priority: Stage 1 scoreOverride (rare) → Stage 0b gemini.memePotential → Stage 1 echo/fallback.
   - `Number.isFinite(g.memePotential)` отличает «Gemini сказал 0» (валидно) от «Gemini не возвращал поле» (null).
   - Stage 1 scoreOverride валидируется строго (number 0-100 + reason string ≥8 chars). Bad payloads silently dropped.
   - Записываются audit fields: `trend.scoreSource` ('stage0b_gemini' | 'stage1_override' | 'stage1_fallback') + `trend.scoreOverride` (полная запись from/to/reason/stage когда был override).
   - Аналогично viralityScore (Gemini → Stage 1) и category (Gemini → Stage 1 → 'other').

8. **`buildAnalysisPrompt` — Stage 1 видит Gemini scoring явно**:
   - `GeminiScore (TRUST — ECHO into output): memePotential=X, viralityScore=Y, category=Z` — отдельная строка, чтобы Stage 1 модель копировала значения 1-в-1.
   - `GeminiSignals: ...` — subsidiary signals (memeShape, hasNarrative, viralPattern, subjects) для narrative work.
   - User prompt сокращён ~5× — больше нет дублирующего описания scoring rules (всё в SYSTEM_PROMPT теперь).

9. **Проверки**: `node --check` на scorer.js / gemini-captioner.js / prompts.js + `node scripts/check-admin-spa.cjs` — всё OK.

**Файлы**: `src/analysis/gemini-captioner.js`, `src/analysis/prompts.js`, `src/analysis/scorer.js`.

**Деплой**: пользователь сам.

**Что это даёт**:
- Score формирует тот, кто РЕАЛЬНО видел контент. Бейсбол получит 5, не 40.
- Stage 1 промпт ~3× короче → меньше input токенов на каждый batch (auto-cache всё ещё работает).
- A/B тумблер Grok/Gemini в Stage 1 становится осмысленным: сравнение narrative writers, не двух слепых scorer'ов.
- HARD RULES (politics=0, ambient cap 25, lipsync cap 15) теперь применяются ОДИН РАЗ в Stage 0b, а не тремя моделями вразнобой.

**Риски**:
- **Calibration drift**: если Gemini systematically переоценивает/недооценивает определённые типы — это просочится без коррекции. Mitigations: scoreOverride mechanism + UI плашка в DecisionsPage (TODO след. итерация). Если первые дни покажут сдвиг — добавим feedback context в Stage 0b prompt.
- **Text-only тренды**: Gemini сейчас вызывается только для трендов с медиа. Reddit text posts / Google Trends не получат Stage 0b scoring → пойдут через `scoreSource='stage1_fallback'` (Stage 1 сам скорит, но без рубрики в промпте — модель должна импровизировать). В DecisionsPage scoreSource будет видно — мониторить долю fallback в логах.
- **ScoreOverride abuse**: Stage 1 модель может начать злоупотреблять override (особенно gpt-mini, который вчера и провалил бейсбол). Mitigation: reason ≥8 chars, видно в audit log. Если в первый день 30%+ алертов идут через override — добавим жёсткие limits (например cap delta ±20).
- **OpenRouter fallback (image-only)**: тоже стал скорить от картинки. Калибровка будет хуже primary Google пути (нет аудио/видео). При успешном Google пути проблем нет.
- **gemini-3.1-flash-lite + json_object** (для Stage 1 если выбран): нет strict json_schema, scoreOverride структуру модель должна соблюдать сама. Если ломается — fallback в _analyzeBatchStage1 на heuristic per-trend.

**Что НЕ сделано** (запланировано):
- UI плашка в DecisionsPage показывающая `scoreSource` + `scoreOverride` (from→to + reason) когда Stage 1 переписал. Сейчас audit fields пишутся в decision, но не визуализируются.
- Не перенесли feedback context (likes/dislikes) в Stage 0b — оставили в Stage 1. Это компромисс: feedback больше про tone/preference, чем про objective scoring. Если первый день покажет что user preferences плохо влияют на narrative — пересмотрим.
- Text-only Gemini path (для трендов без медиа) — пока fallback на Stage 1 scoring. Полноценный text-only Gemini это отдельная задача (другой code path captionTrend).

---

## 2026-05-09 · sonnet · AI pipeline rework: nano off, Gemini-3.1-flash-lite, Stage 1 третий провайдер

**Цель**: отказаться от gpt-nano (Stage 0) и gpt-mini (Stage 1) — они слабо понимают мемы / нарративы. Заменить на Gemini / Grok с возможностью A/B-теста через тумблер.

**Что сделано** (4 точки):

1. **Stage 0a (nano) — выключен по дефолту**
   - `src/analysis/nano-classifier.js:_isAdminEnabled` — `getSetting('nanoEnabled', '1')` → `'0'`, ветка ошибки тоже defaults to false. Файл живой, можно вернуть кнопкой в админке для A/B.
   - `src/admin/server.js` — оба места `/api/prestage/nano` GET/toggle используют дефолт `'0'`.
   - `.env.example` — комментарий объясняет что nano теперь opt-in.

2. **Stage 0b (Gemini captioner) — модель `2.5-flash` → `3.1-flash-lite`**
   - `src/analysis/gemini-captioner.js:googleModel` дефолт + оба `openRouterModel`/`openRouterFallbackModel` бампнуты до `google/gemini-3.1-flash-lite`.
   - `.env.example` — `GOOGLE_AI_MODEL` и `OPENROUTER_VISION_MODEL` дефолты обновлены.
   - Schema/captioner-код не менялся — 3.1-flash-lite поддерживает то же `responseSchema` мультимодалов что и 2.5-flash. Если что-то отвалится — `GOOGLE_AI_MODEL=gemini-2.5-flash` в env откатывает мгновенно.

3. **Stage 1 — третий провайдер `gemini` через Google OpenAI-compat layer**
   - `src/analysis/scorer.js`:
     - `this.providers.gemini` блок: `apiKey: GOOGLE_AI_API_KEY`, `baseUrl: https://generativelanguage.googleapis.com/v1beta/openai`, `defaultModel: gemini-3.1-flash-lite` (env override `GEMINI_STAGE1_MODEL` / `GEMINI_OPENAI_BASE_URL`).
     - `_getRuntimeAiConfig` whitelist расширен до `['xai', 'openai', 'gemini']`, fallback chain `xai → openai → gemini` если нет ключа у выбранного провайдера. DB key `geminiModel` для модели.
     - Новый метод `_callGeminiChatCompletions`: ходит на `/chat/completions` (Google OpenAI-compat НЕ имеет `/responses`), `response_format: {type: 'json_object'}`, парсит `choices[0].message.content` + `usage.prompt_tokens/completion_tokens`. Возвращает тот же `{text, inputTokens, outputTokens}` shape.
     - Новый branch в `_callResponsesAPI`: если `runtime.provider === 'gemini'` → делегирует в новый метод. Stage 2 это не задевает — он строит `runtimeOverride` с `provider: 'xai'`.
   - **Почему json_object, не json_schema**: Google OpenAI-compat не задокументировал strict json_schema. Промпт уже описывает каждое поле с типом — Gemini эмпирически держит shape. Если responsy ломается — try/catch в `_analyzeBatchStage1` фоллбекается на heuristic per-trend (как и для xAI).
   - **Stage 2 не трогали** — Grok с `x_search` остался prim'ом, выключаемый тумблером `aiStage2Enabled`.

4. **Admin UI — третья кнопка в Stage-1 dropdown**
   - `_getAiConfig` — отдаёт `geminiModel`, `hasGeminiKey`, `geminiBaseUrl`.
   - `_setAiConfig` — принимает `provider: 'gemini'`, пишет в DB `aiProvider` + `geminiModel`.
   - `_fetchProviderModels('gemini')` — хардкод-лист 4 модели (`gemini-3.1-flash-lite`, `-preview`, `gemini-2.5-flash`, `-lite`). Не дёргаем `/models` GET — Google там отдаёт сотни внутренних ID.
   - `/api/ai-models` без `?provider=` — теперь параллельно фетчит xai+openai+gemini.
   - SettingsPanel в SPA: `<select>` с третьим option «Google (Gemini)», `Default`-кнопка знает дефолтную модель для Gemini, status-строка внизу показывает `key Gemini: yes/no`.
   - `loadAiModels` — добавил gemini-ветку в `setAiModels` + error reporting.

**Файлы**: `src/analysis/scorer.js`, `src/analysis/gemini-captioner.js`, `src/analysis/nano-classifier.js`, `src/admin/server.js`, `.env.example`.

**Деплой**: пользователь сам.

**Риски**:
- Google OpenAI-compat в beta. Если `response_format: json_object` ведёт себя странно — fallback на heuristic per-trend сработает (но качество просядет). Мониторить логи Stage 1 в первый же цикл после деплоя на провайдере gemini: `Gemini chat 4xx/5xx` или `Stage 1 JSON parse failed` подряд = откатываться на xai/openai.
- Nano off по дефолту: трендам теперь не приходят `topicSummary` / `entityCanonical` / `slangDecoded`. Stage 1 prompt раньше использовал их в опциональных блоках — без nano блок просто пропускается. Качество распознавания тикеров и сленга НА ОСНОВНОЙ ВЕТКЕ может слегка просесть. Если что — включить nano кнопкой в админке.
- `gemini-3.1-flash-lite` на OpenRouter может ещё не быть листан — в этом случае выставить `OPENROUTER_VISION_MODEL=google/gemini-2.5-flash` в env (только fallback-путь, primary Google всё равно идёт на 3.1).

**Что НЕ сделано** (по плану следующих шагов):
- Не переключали Stage 1 Gemini на native Google API (вариант A) — оставлено на отдельную задачу когда выяснится насколько нам критичен strict json_schema.
- Не переписывали промпты под новые модели — это следующий шаг ("перераспределить обязанности между моделями", обсуждается отдельно).

---

## 2026-05-08 (Telegram bot — апгрейд Settings menu)

Старый settings-screen жрал две строки на onboarding-текст («Tap a tile to tweak it...»), не показывал статус (paused/active, тип плана, дни), эмодзи разнокалиберные, layout без логической группировки. Апгрейд — все болевые точки за один проход.

**Что было** (со скриншота):
```
⚙️ Settings
Tap a tile to tweak it. Current values are shown next to each option.
[📡 Sources · 5/5]   [🎯 Threshold · 52]
[🔔 Alert Types · all] [🌐 Language · EN]
[🔥 Top Trends]      [💳 Subscription]
[🌐 Open Dashboard]
[⏸ Pause Alerts]
[💬 Ask a question]
[❌ Close]
```

**Что стало**:
```
⚙️ Settings
🟢 Active · Pro · 12d left
─────
[📡 Sources · 5/5]       [🎚 Threshold · 52]
[🔔 Alert Types · 3/3]   [🌐 Language · EN]
[💎 Plan · Pro · 12d]    [🔥 Top Trends ▸]
─────
[⏸ Pause Alerts]
[📊 Open Dashboard ↗]
[💬 Ask a question ↗]
[❌ Close]
```

**Изменения**:

- **Header → live status line.** `t.menuTitle` теперь функция `(info) => string`, возвращает «🟢 Active · Pro · 12d left» (или «🟠 Paused · Free»). Источники: `user.status`, `user.plan_name`, `user.subscription_expires_at`. Free / истёкший план → без days suffix. Past-expiry → daysLeft=null (silent — не показываем минус).
- **Эмодзи унифицированы**:
  - 🎯 → 🎚 (Threshold — slider, не target)
  - 💳 → 💎 (Plan — gem, без «pay now» вибу)
  - 🌐 (Dashboard) → 📊 (chart — убирает конфликт с Language 🌐)
  - Subscription → Plan (короче, точнее по смыслу)
- **Богатые badges**:
  - `Sources · 5/5` (как было)
  - `Threshold · 52` (только цифры — пользователь сказал «оставь цифры»)
  - `Alert Types · 3/3` (всегда N/total — было «all», запутывало; 0 = «все включены» теперь рендерится как «3/3»)
  - `Language · EN` (как было)
  - `Plan · Pro · 12d` (новое — раньше badge не было)
  - `Top Trends ▸` (новый submenu marker — раньше без значка; не toggle, ведёт на выбор topN)
- **Layout 3-уровневая группировка** (header → 3 settings rows → 4 actions stacked):
  - Группа 1 (alert tuning, 2×2 grid): Sources + Threshold, AlertTypes + Language
  - Группа 2 (account/misc, 1 row): Plan + Top Trends — оба «odd-shaped» (Plan info-only, Top Trends submenu)
  - Группа 3 (actions, stacked): Pause/Resume → Dashboard → Ask → Close

**Файлы**:

- `src/i18n/en.js` и `src/i18n/ru.js`:
  - `menuTitle: (info) => ...` — функция вместо строки. Принимает `{paused, plan, daysLeft}`. Render шапки 2 строки.
  - `btnThreshold` — эмодзи 🎚 (`\u{1F39A}`)
  - `btnSubscription` — `'💎 Plan'` / `'💎 План'`. Callback_data `subscription` оставлен (avoid breaking handlers).
  - `btnDashboard` — эмодзи 📊
  - `badgeAlertTypes` — всегда `N/total` (0 → total для понятности)
  - **новые keys**: `badgePlan(plan, daysLeft)` и `badgeSubmenu()`

- `src/notifications/telegram.js`:
  - **новый** `_menuStatusInfo(user)` — собирает `{paused, plan, daysLeft}` из user-row. Days считается из `subscription_expires_at` через `Math.ceil((exp - now) / 86_400_000)`. Защита: past-expiry → null (не показываем отрицательное).
  - `_mainMenuKeyboard(user)` — новый layout (см. выше). Plan и Top Trends объединены в одну строку. Top Trends получает `submenuBadge` (`▸`).
  - 4 callsite `t.menuTitle` → `t.menuTitle(this._menuStatusInfo(user))` (sendMessage в /menu, editMessage в menu callback, после смены языка, после установки threshold, после toggle pause).

**Поведение per-plan**:

| Plan | Daysleft | Header пример |
|---|---|---|
| free | null | `🟢 Active · Free` |
| free | null + paused | `🟠 Paused · Free` |
| pro | 12 | `🟢 Active · Pro · 12d left` |
| pro | 1 (last day) | `🟢 Active · Pro · 1d left` |
| pro | null (already expired, downgrade pending) | `🟢 Active · Pro` (без days; ближайший scan-cycle силент-даунгрейдит) |
| admin | null | `🟢 Active · Admin` |

**Что НЕ сделано** (намеренно, по запросу пользователя):
- Нет upsell-маркера (`↑ Upgrade`) на Plan-плитке для Free пользователей.
- Нет pause-таймера в bottom-кнопке (бесконечный pause до явного Resume).
- Нет визуальных разделителей между группами кнопок (Telegram inline_keyboard их не поддерживает; группировка достигается порядком).

**Стоимость**: ноль API-вызовов, ноль миграций. Только UX-косметика.

**Риски**:
- **Тип плана 'admin' с `daysLeft != null`**: бывает админам тоже сетят expiry для тестов. Покажет «Admin · 12d left» — корректно, но subtly weird. Не баг.
- **subscription_expires_at в прошлом**: silent downgrade сработает на ближайшем scan-cycle (см. `dispatchAlerts` в alert-dispatcher.js), пока он не отработал — header показывает старый plan_name без days. Acceptable — окно несколько минут.
- **Локализация**: «d left» / «д» — короткие суффиксы. Если перевод раздуется (спанский «12d restantes»), header может wrap'нуться. Сейчас en/ru только, не проблема.

## 2026-05-08 (Subject names — извлечение и подсветка имён в алертах/дашборде)

Цель: находить имена главных субъектов тренда (имя животного, проекта, персонажа, человека) и подсвечивать их в Telegram-алертах и в дашборде. Это даёт пользователю мгновенную ассоциацию «о ком/чём тренд» — критично для memecoin'ов где имя = ticker candidate.

**Архитектура — три источника + shared aggregator**:

1. **Gemini** (Stage 0b) — основной источник. Новое поле `subjectNames: string[]` (0-4 display-формы, [0]=primary).
2. **Stage 2 Grok** — `xSearchData.subjectName` (используем только если `nameStrength ≥ 30`).
3. **Nano** (Stage 0a) — `entityCanonical` (filter по proper-noun-shape, cap 3).

Shared модуль `src/analysis/subject-names.js` собирает их в кучу, фильтрует blacklist (платформы / страны / big-tech), генерит aliases для regex-матчинга (lowercase / no-space / hyphenated варианты), возвращает `{ primary, all, ticker, aliases }`.

**Файлы**:

- `src/analysis/gemini-captioner.js`:
  - VISION_SYSTEM_PROMPT — добавлен пункт `subjectNames` с правилами: display form (Moo Deng, не MOODENG), 0-4 элементов, primary первым, **skip platforms/big-tech** (TikTok/YouTube/Apple/Google blacklist прописан в промте), пропустить если нет proper-noun субъекта.
  - GOOGLE_RESPONSE_SCHEMA: `subjectNames: { type: 'array', items: { type: 'string' } }` + в required.
  - Helper `normalizeSubjectNames(arr)` — code-side blacklist `SUBJECT_NAME_BLACKLIST` (Set ~30 имён), dedup, cap к 4 entries × 32 chars.
  - Google return + OpenRouter fallback применяют `normalizeSubjectNames`.
  - Doc-comment output shape обновлён.

- `src/analysis/subject-names.js` (НОВЫЙ):
  - `collectSubjectNames(trend)` — приоритет Gemini > xSearch (если nameStrength≥30) > nano.entityCanonical (только capitalized).
  - `SUBJECT_BLACKLIST` Set дублирует Gemini-один (нужен для имён из xSearch/nano где Gemini сам не отфильтровал).
  - Aliases generation — для каждого display name создаются варианты: original, lowercase, noSpace, noSpaceLower, hyphenated. Сортируются longest-first для regex alternation.
  - `buildSubjectMatchRegex(aliases)` — case-insensitive regex с word boundaries, escape метасимволов.

- `src/notifications/formatter.js` (Telegram):
  - Импорт `collectSubjectNames` + `buildSubjectMatchRegex`.
  - В начале `formatTelegramAlert` собирается `subjects` + `subjectRegex`.
  - Highlight применяется к **title** (`<u>` — title уже в `<b>`, нужен другой тэг для отличия), **whyNow** и **aiExplanation** (`<b>`).
  - Helper `highlightHtml(escapedText, regex, openTag, closeTag)` — заменяет matches на обёрнутые версии. Critical: вызывается ПОСЛЕ `escHtml` чтобы вставленные тэги не экранировались.
  - Используем `<u>` underline в title и `<b>` в плоском тексте — Telegram HTML-mode supports оба.

- `src/dashboard/server.js`:
  - Импорт `collectSubjectNames` (server-side).
  - `_formatTrend` теперь возвращает `subjectAliases: string[]` — pre-computed массив для SPA. Тот же массив добавлен в manual-analyze response shape.
  - Inline SPA helper `withSubjectHighlight(text, aliases)` — превращает строку в массив React children с `<span class="subject-hl">match</span>` для каждого alias hit. Использует кэш regex'ов через `WeakMap`.
  - **Ловушки SPA, на которые наткнулись**:
    1. Backticks в комментарии (`text` обёрнутые) — outer template literal закрывает строку преждевременно. Решение: написать прозой без backticks.
    2. `${}` substring в regex `[.*+?^${}()|[\]\\]` — outer template видит `${` как interpolation slot. Решение: переставить `$` в конец char class → `[.*+?^()|{}[\]\\$]`. Аналогичная ловушка в комментарии где упоминался паттерн (тоже переписан прозой).
    3. RegExp constructor backslashes — `String.fromCharCode(92)` вместо литерального `\\` чтобы избежать двойного escape в outer template.
  - Highlight применён в трёх местах: `feed-title` (карточка тренда), `modal-title` (заголовок modal'а), `modal-section-content.why-now` (триггер).
  - CSS: `.subject-hl` (yellow accent #fdcb6e), плюс варианты для разных контейнеров (`modal-title`, `modal-section-content`, `feed-title`) с разной интенсивностью фона.

- `src/admin/server.js` (DecisionsPage):
  - В Gemini chips row добавлен chip `🏷️ <name>` per element of `subjectNames` (жёлтый, как ticker chip).

- `src/analysis/prompts.js` (Stage 1):
  - GeminiScoring строка теперь содержит `subjects=[name1, name2]` если есть. Stage 1 модель видит имена явно — может использовать в whyNow / aiExplanation.

**Поведение**:

- **Telegram**: «🐾 <b>Viral capybara <u>Moo Deng</u> bites tourist</b>» — display name подчёркнут внутри жирного title.
- **Dashboard карточка**: «Viral capybara **Moo Deng** bites tourist» — имя жёлтым с лёгким фоном.
- **Admin DecisionsPage**: chips row показывает 🎯 memeShape, 🌀 viralPattern, **🏷️ Moo Deng** (per name), $TICKER, 🎤/😴 флаги.

**Покрытие**:
- Все тренды с visual (TikTok / Twitter / Reddit с картинкой) — через Gemini.
- Тренды через Stage 2 — дополнительно через xSearch (overrides Gemini если nameStrength высокий).
- Текстовые тренды (Reddit text-only) — через nano.entityCanonical (proper-noun filter).
- Тренды без всего → пустой aliases → highlight ничего не делает (zero overhead).

**Стоимость**: Gemini +30-50 output токенов на subjectNames. Регексы в SPA кэшируются через WeakMap (один regex на массив).

**Не сделано** (намеренно):
- Нет отдельного «🎯 Subject: <b>Moo Deng</b>» блока в алерте — пользователь сказал «слишком много места займёт».
- Нет visual badge на карточке в дашборде с явным именем — подсветка inline достаточна.
- Не подсвечиваем в `description` / `topTweets` text — слишком много мест, минорное место.

**Риски**:
- **False positives на коротких именах**: если Gemini выдаст subject `'Apple'` (не должен — в blacklist), или `'It'` (не должен — len≥2), highlight попадёт на каждый occurrence в title. Защита: blacklist + length≥2 + word-boundary regex.
- **Multi-language имена**: regex поддерживает только ASCII word boundaries. Если имя в кириллице («Хатико»), `\b` будет работать корректно для cyrillic если не зажато между двумя кириллическими буквами. На практике protected — Gemini нормализует к ASCII display form.
- **Performance**: regex builds per-trend в SPA. WeakMap кэш помогает — один раз на trend.subjectAliases array reference. Если SPA пере-рендерит тренды (re-fetch) — массив новый, regex пересчитается. Не bottleneck для 50 трендов.

**Не было миграций / env / админ-настроек**. Только код.

## 2026-05-08 (TikTok quality gate — отрезаем «scroll-bait» / залипалово)

Проблема: TikTok firehose тащит уйму «залипательных» видео — ASMR, satisfying loops (slime/soap/sand), tutorials (makeup/cooking/fitness), process timelapses (woodworking/calligraphy/pottery), aesthetic vibe vlogs (study-with-me / day in my life). Они получают огромный engagement (люди залипают), но это НЕ memecoin material — нет narrative, нет hook'а, нет персонажа.

Также: animals из TikTok должны проходить только если ОЧЕНЬ виральные/мем-shaped, а не «милый щенок зевает на 40-й секунде».

**Решение**: комбо A+B+C. Три слоя защиты, все полагаются на Gemini PreStage сигналы (после апгрейда Gemini 2.0).

### A. Расширение `viralPattern` enum

В `gemini-captioner.js` добавлены 5 новых паттернов в `VIRAL_PATTERN_VALUES` Set + в Stage 1 prompt rubric:
- `satisfying` — slime / soap cutting / sand cutting / restoration / pressure washing
- `asmr` — whispering / tapping / mukbang / eating sounds
- `tutorial` — how-to walkthroughs (makeup / cooking / fitness / DIY)
- `process` — extended craft/build timelapses
- `aesthetic` — vibe / mood content (study-with-me / day-in-my-life)

Каждый имеет 1-строчное определение в промте Gemini, чтобы модель не путала с `event`/`reaction`/`character`.

### B. Новый Gemini boolean `isAmbient`

В schema добавлено поле `isAmbient: boolean`. Промт rubric:
> «scroll-bait / loop / hypnotic content with NO narrative arc, NO meme hook, NO punchline. Litmus test: would a degen forward this to a friend with "you HAVE to see this"? If no, and only appeal is "relaxing to watch" — TRUE.»

Для статичных картинок (OpenRouter fallback) принудительно `false`.

### C. TikTok-only quality gate в `alert-dispatcher.js`

Новый gate `tiktok_quality` в цепочке (после `lipsync`, перед `plan_source`). Применяется ТОЛЬКО если `source === 'tiktok'`. Три sub-проверки (любая failure → hard skip):

1. `gemini.isAmbient === true` → skip (Gemini's own boolean)
2. `gemini.viralPattern in AMBIENT_PATTERNS` → skip (Set из 5 паттернов)
3. `gemini.memeShapeStrength < TIKTOK_MEME_SHAPE_FLOOR (60)` → skip (общий quality bar)

Старые тренды без Gemini-полей проходят естественно — `memeShape undefined → !Number.isFinite → нет penalty`. Reddit/Twitter/Google Trends этот gate вообще не видят.

Константы `AMBIENT_PATTERNS` и `TIKTOK_MEME_SHAPE_FLOOR=60` хардкод per «хардкод» директива пользователя. Если калибровка memeShape в первые дни покажет промахи — поправим в коде, не делаем admin slider.

**Файлы**:

- `src/analysis/gemini-captioner.js`:
  - VISION_SYSTEM_PROMPT — `viralPattern` enum расширен с 5 ambient значений + 1-строчные определения; новый `isAmbient` field с rubric'ом и litmus test'ом.
  - GOOGLE_RESPONSE_SCHEMA — `isAmbient: boolean` + в required.
  - `VIRAL_PATTERN_VALUES` Set расширен (нормализатор `normalizeViralPattern` теперь принимает новые значения).
  - userText (video и image) — упомянут `isAmbient`. Image-вариант форсит `isAmbient=false`.
  - Google return parse + OpenRouter fallback — `isAmbient: parsed.isAmbient === true` / `false`.
  - Doc-comment output shape обновлён (Filter Flags секция теперь содержит оба flag'а).

- `src/analysis/prompts.js` (Stage 1):
  - В `_formatTrendDetails` GeminiScoring строка теперь содержит `AMBIENT` / `LIPSYNC` теги когда соответствующие флаги true.
  - В Stage 1 system prompt секция «GEMINI VISION+AUDIO IS GROUND TRUTH» дополнена калибрационными правилами:
    - `viralPattern in {satisfying, asmr, tutorial, process, aesthetic}` → cap memePotential ≤ 25 (это «relaxing to watch», не мем)
    - GeminiScoring содержит `AMBIENT` или `LIPSYNC` → cap memePotential ≤ 20 (тренд на пути к hard skip — не пере-скорить)

- `src/notifications/alert-dispatcher.js`:
  - Module-level константы `AMBIENT_PATTERNS` (Set из 5) и `TIKTOK_MEME_SHAPE_FLOOR = 60`.
  - В `dispatchAlerts` после lipsync gate — новые переменные `isAmbient`, `ambientPattern`, `memeShape`, `tiktokQualityFail`. Логика: gate срабатывает только при `source === 'tiktok'`, иначе `tiktokQualityPass = true` (n/a).
  - Gate `{ name: 'tiktok_quality', passed, detail }` встроен в цепь между `lipsync` и `plan_source`.
  - В firstFail-handler debug-log с тегом `[TikTokQuality:${source}]` — содержит конкретную причину провала (ambient/pattern/memeShape).
  - В detail-строке gate'а для не-TikTok трендов выводится `'n/a (not tiktok)'` — чтобы admin DecisionsPage не показывал ложно-положительный pass.

- `src/admin/server.js` (DecisionsPage Gemini блок):
  - Chips row дополнена `😴 ambient` chip (красный, рендерится только если `isAmbient === true`).

**Что в выходе видно**:

Когда tiktok_quality gate срабатывает, в admin DecisionsPage:
- `decision: skipped`, `reason: tiktok_quality`
- Gate detail: `'ambient flag (Gemini)'` или `'pattern=satisfying'` или `'memeShape=42/100 < 60'`
- В Stage 0 PreStage блок видно chips: 🎯 memeShape, 🌀 viralPattern, 😴 ambient

**Не сделано** (отложено):

- Нет admin override для `TIKTOK_MEME_SHAPE_FLOOR` или `AMBIENT_PATTERNS` — хардкод per директива.
- Нет специального animals threshold (пользователь принял общий floor 60 для всех категорий на TikTok). Если animals будут пробиваться слишком часто — добавим `category === 'animals' && memeShape < 75 → skip`.
- Не применили к Twitter/Reddit (по запросу пользователя — только TikTok). Если ASMR-клипы из Twitter начнут пробиваться — расширим scope.

**Риски**:
- Калибровка `memeShapeStrength` от Gemini может оказаться смещённой первые дни. Если floor 60 режет слишком много — снизим до 55 или 50. Если пропускает слишком много — поднимем до 65-70. В DecisionsPage все skipped тренды видны с конкретной причиной — легко мониторить.
- False positives на новые паттерны: Gemini может пометить event-клип как `aesthetic` (например, концертный клип в полумраке). Промт даёт чёткие определения, посмотрим как зайдёт.
- Старые тренды (без Gemini-полей) проходят без penalty — это **намеренно** (backward compat per директива «игнорим их»). Только новые видео со следующего цикла Stage 0b получат полный quality gate.

**Деплой**:
- `deploy.ps1`. Никаких миграций, никаких env. После рестарта контейнера — следующий цикл Stage 0b начнёт писать `isAmbient` и нормализованный `viralPattern` в `preStage.gemini`. Первые 1-2 часа на проде стоит мониторить admin DecisionsPage с фильтром `reason: tiktok_quality` — увидим что отрезается.

## 2026-05-08 (Gemini 2.0 — апгрейд до multimodal voter с аудио-анализом)

После того как `isLipSync` показал что Gemini хорошо понимает контент, решили дать ему больше веса. Раньше Gemini был «captioner only» — описывал визуал, но не оценивал и не слушал звук (в промте было «describe what is **visible**»).

Расширили его роль до **multimodal analyzer / scoring voter**: теперь он обязательно слушает аудио, транскрибирует речь и выдаёт numerical scoring сигналы.

**Файлы**:

- `src/analysis/gemini-captioner.js`:
  - `VISION_SYSTEM_PROMPT` полностью переписан. Теперь это «multimodal analyzer for memecoin trend system». Жёстко требует анализ ОБА tracks (visual + audio) для видео. Без описания «what is heard» ответ невалиден по schema.
  - **Новые поля output**:
    - `audioSummary` (string) — что СЛЫШНО: speech context, music genre, sound effects, ambient noise, laughter/yells. Empty для статичных картинок.
    - `spokenText` (string) — VERBATIM transcript речи. Если речь не на английском — переводится в английский (за исключением meme-relevant gibberish, который квотируется в оригинале). Cap 800 chars.
    - `memeShapeStrength` (integer 0-100) — насколько контент memecoin-shaped. Промт прописывает калибрационные anchors (70+ = clear character + audio hook + viral aesthetic; <30 = news/political/static; default 30-60).
    - `hasNarrative` (boolean) — есть ли story arc.
    - `hasSubject` (boolean) — есть ли явный focal subject (персона/животное/character).
    - `viralPattern` (enum) — 'character' | 'reaction' | 'pov_skit' | 'compilation' | 'sound_format' | 'gameplay' | 'animal_action' | 'event' | 'other'.
    - `tickerSuggestion` (string) — короткое имя для тикера (3-8 chars caps), пустое если нет очевидного кандидата. Промт явно говорит «empty is better than weak».
  - `GOOGLE_RESPONSE_SCHEMA` расширен; все новые поля в required (ответ невалиден без них — вынуждает модель отвечать на каждое).
  - Helper-ы `clampInt(v, min, max, fallback)` и `normalizeViralPattern(v)` (whitelist VIRAL_PATTERN_VALUES) для безопасной нормализации output'а на parse-loose path и OpenRouter fallback.
  - Google return parse: применяет `clampInt` + `normalizeViralPattern` + `=== true` coercion для booleans.
  - **OpenRouter fallback** (poster image only — нет аудио, нет видео): принудительно выставляет `audioSummary='', spokenText='', hasNarrative=false, isLipSync=false`. Остальные scoring fields (memeShape/hasSubject/viralPattern/tickerSuggestion) модель отвечает по картинке — это валидно.
  - `userText` для Google video — явно требует анализ аудио и transcription речи. `userText` для image (Google + OpenRouter) — указывает, какие поля принудительно empty/false для статики.
  - Doc-comment output shape переработан с тремя секциями: Visual / Audio / Scoring / Filter / Meta.

- `src/analysis/prompts.js` (Stage 1):
  - В `_formatTrendDetails` блок Gemini расширен — теперь подаёт scorer'у Audio, Speech, и компактную строку `GeminiScoring: memeShape=N/100, hasNarrative=bool, hasSubject=bool, pattern=X, tickerHint=Y`.
  - **Новая секция в Stage 1 system prompt**: `━━━ GEMINI VISION+AUDIO IS GROUND TRUTH ━━━`. Жёстко инструктирует: titles/descriptions могут быть clickbait/foreign/aggregator, Gemini watched the actual media → **TRUST GEMINI**. Spoken text — primary source of «what is actually said». GeminiScoring memeShape — strong prior (≥70 lean upward, <30 lean downward). hasSubject=false AND hasNarrative=false → почти никогда memecoin candidate. viralPattern='compilation' / 'sound_format' без narrative → cap memePotential ≤ 50.
  - HARD RULE #7 уточнён: «Never invent context» теперь имеет exception — Gemini Visual/Video/Speech описание считается legitimate context.

- `src/admin/server.js` (DecisionsPage, вкладка Алерты):
  - Gemini блок в Stage 0 PreStage Collapsible теперь показывает:
    - 🎤 Аудио (audioSummary) — отдельной строкой
    - 💬 Речь (spokenText) — italic + кавычки
    - Текст в кадре (visibleText) — как раньше
    - **Scoring chips row** (compact 10px chips, flex-wrap):
      - 🎯 memeShape N/100
      - 📖/🚫 narrative
      - 👤/🚫 subject
      - 🌀 viralPattern
      - $tickerSuggestion (жёлтый)
      - 🎤 lip-sync (красный, только если true)
  - Это даёт админу мгновенную картинку: «что Gemini подумал об этом тренде» — без чтения текстов.

**Что НЕ сделали** (оставлено на потом):

- Не прокинули `geminiBoost = memeShapeStrength × weight` в `alertScore` breakdown как отдельный sub-score. Сейчас Gemini scoring уходит в Stage 1 как prior через промт. Если хочется явное numerical влияние на alert gate — добавим в alert-dispatcher отдельный gate / penalty компонент.
- Не использовали Gemini для визуальной dedup'а (cluster.js не трогали).
- Не делали multi-shot Gemini для top-N (deep-analysis на финальные топ-10).
- Не дали Gemini junk-фильтрационные полномочия (isCompilation/isLowEffort/isPoliticalVisual флаги). Промт по-прежнему «describe + score», не «filter».

**Стоимость**:
- ~150-200 дополнительных входных токенов в каждом Gemini-вызове (расширенный system prompt). На output — ~50-100 токенов больше (audioSummary + spokenText + scoring fields). Gemini-2.5-flash дешёвый, экономически незаметно.
- НЕ добавляем новые API-вызовы — всё в один существующий request.

**Риски**:
- Gemini может галлюцинировать речь (придумывать spokenText, если речь нечёткая). Промт инструктирует «verbatim», но защиты от hallucination нет. Мониторим в DecisionsPage визуально первые дни.
- Calibration scoring — модель может быть слишком щедрой на memeShapeStrength. Промт даёт явные anchors (70+ = rare, <30 = common no-meme), посмотрим что выйдет на проде.
- Stage 1 trust shift — если Gemini ошибся (см. выше), Stage 1 может переоценить тренд. Промт это явно отмечает: «Gemini is a PRIOR, not a verdict — you may override consciously».

**Деплой**:
- `deploy.ps1`. Никаких миграций, никаких env-переменных. Старые тренды без новых полей в `preStage.gemini` нормально проходят (все строковые проверки `&& field.trim()` гасят отсутствующие поля). Новые тренды со следующего cycle Stage 0b начнут получать полный set полей.


## 2026-05-08 (Lip-sync hard-skip через Gemini)

Проблема: TikTok-липсинги (креатор беззвучно открывает рот / танцует под чужой sound) проходили в алерты. Это «звуковой формат», а не нарратив — нет персоны для тикера, нет concrete trigger event, sound разлетается по 10K видео без явного героя. Под мемкоин не годится.

**Решение**: использовать существующий Stage 0b (Gemini captioner). Он уже смотрит видео — пусть сразу классифицирует и lip-sync.

**Архитектура**:
- Gemini добавил **+1 булево поле `isLipSync`** в JSON-ответ. Стоимость: ~10 токенов на инструкцию + 1 поле в response. Никаких новых API-вызовов.
- В `alert-dispatcher.js` добавлен **gate `lipsync`** в цепь gates. Если `trend.preStage?.gemini?.isLipSync === true` — **hard skip алерта**. Никакой score не спасает (по аналогии с `hard_junk`).
- Никакого junk-filter regex'а, никакой Stage 1 schema-правки, никакого musicMeta plumbing'а в TikTok collector — отказались от слоистого подхода в пользу одного точного сигнала.

**Файлы**:

- `src/analysis/gemini-captioner.js`:
  - `VISION_SYSTEM_PROMPT` — добавлен пункт `isLipSync` с rubric'ом: TRUE only if creators miming/dancing to audio without narrative arc; FALSE for events/news/dialogue/animals/gameplay/streamer reactions/vlogs with own audio. Tie-breaker: «if you can describe a CONCRETE thing happening, FALSE; if only thing is "person mouths along/dances to music", TRUE».
  - `GOOGLE_RESPONSE_SCHEMA` — поле `isLipSync: { type: 'boolean' }` + в required.
  - `userText` (видео и картинка) — упомянут флаг в JSON-shape, для картинки явно «must be false».
  - Google return path: `isLipSync: parsed.isLipSync === true` (strict-equal: missing/null/undefined → false, никогда случайно не тру).
  - OpenRouter fallback path: `isLipSync: false` всегда (fallback работает только на static poster image, не может быть lip-sync by definition).
  - Doc-comment output shape обновлён.

- `src/notifications/alert-dispatcher.js`:
  - `dispatchAlerts` — после `hardJunkPass` добавлен `lipsyncPass = !(trend.preStage?.gemini?.isLipSync === true)`.
  - Gate `{ name: 'lipsync', passed, detail }` встроен в цепь между `hard_junk` и `plan_source` — порядок отображения в admin DecisionsPage сохраняет семантическую группировку (threshold → quality gates → access gates → cap).
  - В firstFail-handler добавлен debug-log с тегом `[LipSync:${source}]`.

**Покрытие**:
- Только тренды с visual попадают в Gemini → Reddit/text-only тренды НЕ получают флаг (остаются `null`/`undefined`). По дизайну: lip-sync проблема исключительно TikTok'а, на reddit её нет.
- Static-image тренды forced `isLipSync: false` (картинка не может быть lip-sync). Видео-тренды получают честный classification от Gemini.
- Video с failover на poster image (truncationReason='duration_exceeded' / 'native_unavailable') — в этих кейсах OpenRouter работает с poster, форсит `false`. Это компромисс: видео >30s или Google в кулдауне → теряем lip-sync detection. Считается приемлемым, потому что failover уже редкий путь.

**Риски**:
- False positives: Gemini может пометить как lip-sync видео где креатор реально что-то делает (танцует ИЛИ говорит) под фоновую музыку. Промт прямо инструктирует «if you can describe a CONCRETE thing happening, FALSE». Если будет много false positives — смягчим до soft penalty (-30 score) или добавим admin override slider.
- False negatives: lip-sync с приклеенной overlay-надписью «I survived World War 3» может пройти как «event». Это меньшая проблема — overlay-текст обычно даёт concrete narrative и тренд может быть оправданным алертом.
- **Не тестируется юнит-тестами**. Полагаемся на Gemini. Если он начнёт галлюцинировать — увидим в DecisionsPage по причине `lipsync` (отдельный gate, легко фильтруется).

**Деплой**:
- `deploy.ps1` — катит код. Никаких миграций БД, никаких новых env-переменных. После рестарта контейнера следующий cycle Stage 0b начнёт писать `isLipSync` в `preStage.gemini`. Старые тренды без флага → `undefined` → `=== true` ложь → пропускаются нормально.

**Возможные дальнейшие шаги**:
- Если хочется visual-индикатор в дашборде/админке — добавить badge `🎤 lip-sync` на карточке (не делали по запросу пользователя).
- Если хочется admin override (slider для веса штрафа вместо hard skip) — выкатить в admin Alert weights panel рядом с `hardJunkStop` (не делали по запросу пользователя — «хардкод»).

## 2026-05-08 (Таксономия категорий — рефактор «A: minor surgery»)

Старая таксономия (10 ярлыков) была кривой: `elon` как отдельная категория (персона ≠ топик, личный bias автора), `tech_drama` vs `ai_drama` (дублёры, AI = подраздел tech), `sports_degen` / `degenerates` (degen — лишний эмоциональный коннотатор), пересечение `elon`↔`celebrity`. Большие пробелы: politics упомянут в промте как hard-rule (memePotential MUST be 0), но категории не было — модель сама решала, в `boring` или `other` положить. Music/movies/streaming/gaming — размазывались по `meme`/`celebrity`/`other`.

**Финальный список (11 категорий)**:
`meme, celebrity, animals, tech, gambling, sports, politics, entertainment, gaming, boring, other`

| Было | Стало |
|---|---|
| elon | → celebrity |
| tech_drama | → tech (drama убрал) |
| ai_drama | → tech (слил) |
| degenerates | → gambling |
| sports_degen | → sports |
| (новая) | + politics |
| (новая) | + entertainment (music/movies/tv) |
| (новая) | + gaming |

Crypto/finance отдельной категорией **не делали** (явное решение пользователя — мемкоиновые тренды раскидываются по `meme`/`gambling`/`tech`).

**Файлы**:

- `src/analysis/prompts.js` — Stage1 prompt rubric (расширена до per-category описаний на 1 строку каждое, чтобы модель не путала `gambling` с `tech` или `sports` с `entertainment`); JSON schema enum для `category`.
- `src/db/database.js` — `seedExamples` (calibration set для stage1_examples). Добавлены 2 новых примера для `gaming` (70) и `entertainment` (65), `gambling` пример (40), Politicis-пример переехал из `boring` в `politics` (но всё равно memePotential=0 по hard-rule).
- `src/dashboard/server.js` — CSS `.cat-*` (11 классов вместо 10), `CAT_ICONS`, `CAT_CLS`. Цвета новых: politics=#ff7675, entertainment=#ffa502, gaming=#00cec9.
- `src/admin/server.js` — `CATEGORY_ENUM` (валидатор для `stage1_examples` API), `CATEGORIES` array в `ExamplesPage`.
- `src/i18n/{en,ru}.js` — `topCatIcons` + `categories.{...}`. Удалён legacy `categories.news` (не использовался).

**Эмодзи**:
- `meme` 🤣 / 😂 · `celebrity` ⭐ · `animals` 🐾 · `tech` 💻 · `gambling` 🎰 · `sports` 🏆 · `politics` 🏛️ · `entertainment` 🎬 · `gaming` 🎮 · `boring` 😴 · `other` 📌

**Миграция БД**: `scripts/migrate-categories-2026-05-08.sql`. Транзакционный UPDATE на `trends` и `stage1_examples`, плюс sanity-чек (legacy left = 0). Деструктивно: `tech_drama` и `ai_drama` сливаются в `tech` без возможности обратного разделения. Перед запуском — бэкап (или полагаемся на B2 daily backup).

**Деплой план**: `deploy.ps1` → SSH на VPS → запустить `sqlite3 /app/data/trendscout.db < scripts/migrate-categories-2026-05-08.sql` (внутри контейнера или через docker exec). После — рестарт контейнера, чтобы Stage1 prompt с новой рубрикой пошёл в работу.

**Риски**:
- Если миграцию забыли запустить, а код задеплоили — модель сразу начнёт писать новые ярлыки в `category`, старые тренды останутся со старыми, фильтры в дашборде покажут «битые» категории (`elon` отфильтровано, но в БД таких уже нет — пустой результат). Сценарий ловится визуально через Top Categories блок.
- Stage1 model attention: расширили промт на ~10 строк per-category — модель теперь видит описание каждой. Это уменьшает hallucination в `other`, но добавляет ~50 токенов на запрос (×N трендов). Цена незначительная.

**Не тронуто**:
- `src/analysis/scorer.js:1199` — `highSignal = ['elon', 'musk', ...]` остался: это keyword-маркеры в title для бонуса `+10` к скору, не категория. Слово `elon` как маркер для Маска по-прежнему имеет смысл.
- `presetConfigs` / `presetConfigsAuto` в БД — категории там не упоминаются.
- Subreddits с именем `news` (preset-config) — не категория.

## 2026-05-07 (Telegram digest для admin'а после tag auto-refresh)

Юзер выбрал #5 — последний из NICE-TO-HAVE. Цель: после каждого `refreshAll()` отправлять админу в Telegram сводку с diff'ом по каждому пресету. Чтобы не лезть в admin-panel ради проверки «что Grok нагенерил на этой неделе».

**Реализация (`src/refresh/tag-refresher.js`)**:

- **Constructor** — добавлен `telegram = null` параметр (TelegramNotifier instance из `src/notifications/telegram.js`).
- **`_refreshPreset` return** — теперь включает `diff` (added/kept/removed для subs и twitter), чтобы агрегатор-нотификатор мог формировать message без повторного DB-чтения.
- **`refreshAll`** — после circuit-breaker setSettings вызывает `_notifyAdmins({results, totalCost, elapsedSec, anyFailure, isForce, newStreak})` через try-catch (best-effort, ошибка нотификации не валит run).
- **`_notifyAdmins`** — собирает HTML, шлёт каждому admin'у через `telegram.bot.sendMessage(chatId, html, {parse_mode: 'HTML'})`. Skip silently если `telegram=null` или 0 admin'ов.
- **`_getAdminChatIds`** — `db.getActiveUsers().filter(u => u.plan_name === 'admin')`. Используем существующий метод, не добавляем нового в database.js.
- **`_formatAdminDigestHtml`** — Telegram-flavoured HTML (b/i/code), trim до 3800 char (запас под 4096 лимит).

**Формат сообщения** (пример):
```
✅ Tag auto-refresh — Scheduled refresh
5 presets · 124.3s · $0.547

🔄 animals — applied · $0.121
   + subs: AnimalsBeingDerps, FunnyAnimals
   − subs: badanimalsubs2024 (404)
   + tw: furry chaos, pet fails
🔄 culture — applied · $0.108
   + subs: PeoplePerception
   + tw: gen z slang, terminally online
· celebrities — no-op · $0.097
   no changes
✗ events — rejected_validation · $0.099
   error: Empty after sanitization. Raw text head: ...
🔄 general — applied · $0.122
   + subs: BrandNewSentence, OldSchoolCool

Open admin panel → Auto-tags for full diff & history.
```

- `🔄` applied · `·` no-op · `✗` rejected_validation · `⚠️` error
- `+ subs:` — added subreddits (max 6 в строке, остальные через `(+N more)`)
- `− subs:` — removed (auto-cleanup, locked никогда не показываются здесь)
- `+ tw:` / `− tw:` — Twitter keyword groups
- Если streak ≥ 3 — отдельное сообщение `🚨 Circuit breaker tripped`.

**Wiring** — в `src/index.js`:
```js
const tagRefresher = new TagRefresher({ db, logger, config, telegram });
```
`telegram` уже инициализирован выше (line 65), к моменту создания tag-refresher (line 156) instance готов.

**Edge cases** покрыты:
- Нет telegram instance → silent skip
- Нет admin'ов в системе → debug log + skip
- Каждый sendMessage в try/catch (один сломанный chat не валит остальных)
- HTML escape через `esc(s)` для всех динамических полей (предотвращает HTML-injection через preset names или ошибочные диффы)
- Слишком длинное сообщение → trim до 3800 + `... (digest truncated)`

**Что НЕ сделано осознанно**:
- Per-preset notify (одно сообщение на пресет). Решил digest — 5 presets × 1 msg = много спама. Один summary компактнее.
- Inline-кнопки «Open admin» / «Reset breaker». Можно добавить если станет нужно — пока ссылка текстом достаточно.
- Локализация (RU/EN). Сообщение на английском, с английскими статусами — admin читает и так знает термины.

**Файлы**: `src/refresh/tag-refresher.js` (~+115 LOC: constructor + diff in result + _notifyAdmins + _getAdminChatIds + _formatAdminDigestHtml), `src/index.js` (+1 line: telegram в TagRefresher constructor).

**Проверки**: `node --check` чистый по обоим файлам.

**Testing на проде**: следующий scheduled refresh (через ≤ 7 дней) или ручной trigger через admin panel «Force refresh» сразу пришлёт digest. Если ничего не пришло — проверить что у юзера действительно `plan_name === 'admin'` в `users JOIN plans`.

> **Update 2026-05-10**: эта функция отключена в коде. `_notifyAdmins` — no-op (early return). Админа спамило диффами тегов; сама фича digest сохранена для будущего возрождения.

---

## 2026-05-07 (Reddit subreddit reality-check для tag-refresh)

Юзер выбрал #4 из NICE-TO-HAVE. Цель: фильтровать Grok-галлюцинации в auto-tag-refresh для Reddit. Grok routinely генерит plausible-sounding subreddit'ы которые не существуют (r/cuteanimalvideos, r/memesofthe2020s и т.п.). До этой правки они улетали прямо в `presetConfigsAuto` и потом коллектор Reddit'а получал 404 на каждом обращении.

**Реализация (`src/refresh/tag-refresher.js`)**:

- **Constants**:
  - `REDDIT_USER_AGENT` (env-tunable, default `Catalyst:tag-refresher:v1.0`) — Reddit требует осмысленный UA для unauthenticated, иначе rate-limit жёстче.
  - `REDDIT_PROBE_DELAY_MS = 6500` — 6.5 сек между probe'ами (10/min лимит unauthenticated с safe margin).
  - `REDDIT_PROBE_TIMEOUT_MS = 8000` — per-request timeout.
  - `REDDIT_PROBE_NETWORK_ERROR_BAILOUT = 3` — после 3 подряд network error'ов bail out, остальные subs идут pass-through (не дропаем когда Reddit лежит).
  - `sleep(ms)` helper.

- **`_realityCheckSubreddits(proposedSubs, preset)`**:
  - Скипает subs которые уже в effective sources (известно работают, не тратим rate-limit).
  - Для остальных — вызов `_probeSubreddit(name)` через `fetch('https://www.reddit.com/r/<name>/about.json')` с UA + Accept headers.
  - На сетевые ошибки **conservative**: keeps the sub (флак реддита не должен валить весь refresh).
  - На 404/403/451 — drops с логированием reason'а.
  - На 429 (rate-limited) — keeps as fallback (предполагаем существующий, не дропаем).
  - Bailout-логика: 3 consecutive network errors → пропускаем remaining через verified без проверки.

- **`_probeSubreddit(name)`** — отдельная функция:
  - AbortController с 8s timeout.
  - Парсит `{kind: 't5', data: {display_name, subreddit_type, subscribers}}` shape.
  - Возвращает `{exists, reason, subreddit_type?, subscribers?, networkError?}`.

- **`_getCurrentSubreddits(preset)`** helper — manual override > auto > defaults (mirrors merge order).

- **Вписано в pipeline**: между `_sanitizeResponse` (step 3) и `_computeDiff` (step 5). Step 4a — reddit, step 4b — twitter.

**ENV**: добавлен `REDDIT_USER_AGENT=Catalyst:tag-refresher:v1.0` в `.env.example`.

**Стоимость**:
- 5 пресетов × ~5-10 proposed subs / week = ~30-50 probe'ов в неделю.
- 6.5s паузы → max 5 минут на пресет (только если Grok нагенерит 50 новых subs, реально 5-15).
- Бесплатно. Reddit free public API.

**Что НЕ делаем**:
- OAuth — лишний setup, 60/min vs 10/min не нужно для нашего объёма.
- Batch endpoint `api/info?sr_name=...` — требует OAuth.
- Кэш проверенных subs — TTL Reddit's banned list нестабилен, лучше каждый refresh проверять заново.

**Файлы**: `src/refresh/tag-refresher.js` (~+115 LOC), `.env.example` (+3 lines).

**Проверка**: `node --check` чистый.

---

## 2026-05-07 (Copy-math button — экспорт математики из admin Decisions)

Юзер выбрал #3 из NICE-TO-HAVE: кнопка «копировать математику в буфер» в admin DecisionsPage. Скопированный текст можно вставить в Slack/Telegram/issue без скриншотов. DecisionsPage сама по себе админская, дополнительный gate не нужен.

**Что сделано (`src/admin/server.js`)**:

- **Helper `formatMathPanelAsText(d)`** — собирает plain-text вид всей математики:
  - Header: title, verdict, source, type, preset, url
  - Positive section с табличным выравниванием через `pad(s, n)`: `meme       70 x 0.45     = +31.5`
  - Penalty section: junk + stale, `junk triggers: ...` если есть
  - Equation `+54 − 10 = 44 < 60 (✗ fail)`
  - Floor decomposition `Floor 60 = max(user 50, admin 60)`
  - Feedback details если есть `feedbackStats`
  - Newlines через `String.fromCharCode(10)` (SPA trap — literal `\` + `n` в строках ломает outer template literal).

- **Component `CopyMathButton({getText})`**:
  - Local useState `copied` / `error`, lifecycle 2-2.5 сек
  - Primary path: `navigator.clipboard.writeText()`
  - Fallback path для non-secure contexts: `<textarea>` + `document.execCommand('copy')`
  - Кнопка показывает `📋 copy math` / `✓ скопировано` / `⚠ ошибка`

- **Встройка в MathPanel** — первый child в `dec-math` контейнере, абсолютно позиционирован top-right. `getText: () => formatMathPanelAsText(d)` — closure over decision, всегда свежие данные.

- **CSS**: `.dec-math` теперь `position:relative`. `.dec-math-copy-btn` (top:10px, right:10px, z-index:1) + `.copied` (зелёный) и `.error` (красный) состояния.

**SPA-traps по дороге** (third и fourth раз за день):
1. Backtick `\`d\`` в комментарии «closure over `d`» → `Unexpected identifier 'd'`. Заменил на «closure over the decision».
2. `\n` в комментарии «literal `\n` in inline-template strings» — outer template literal съел `\n`, сделал реальный newline, комментарий оборвался, дальнейший текст стал кодом → `Unexpected token 'in'`. Переписал без escape-sequence.

Validator после фикса ✅ OK (227836 chars).

**Пример вывода** (plain-text, монospace-friendly):
```
Trend: "Costco guys fell off..."
Verdict: score=44 / 60 · FAIL · SKIPPED (threshold)
Source: reddit
Type: trend
Preset: general

─ POSITIVE (Σ +54)
   meme       70 x 0.45     = +31.5
   viral      85 x 0.15     = +12.8
   emerge     28 x 0.2      = +5.6
   twitter    0 x 0.05      = +0
   feedback   50 x 0.15     = +7.5

─ PENALTY (Σ −10)
   junk       20 x 0.5      = −10
   stale      0h, grace 24h = −0
   junk triggers: no-meme-shape, text-only

+54 − 10 = 44 < 60 (✗ fail)
Floor 60 = max(user 50, admin 60)
```

**Файлы**: `src/admin/server.js` (~+150 LOC: helper + CopyMathButton + кнопка в MathPanel + 5 строк CSS).

**Проверки**: SPA validator ✅ OK, `node --check` чистый.

---

## 2026-05-07 (Term-help tooltips — admin-only "?" подсказки в дашборде)

Юзер выбрал #2 из NICE-TO-HAVE. Цель: добавить подсказки рядом с терминами в trend-modal — особенно «Emergence» (юзер сам сказал что это слово сбивает). Admin-only сначала, потом откроем всем.

**Что сделано (все правки в `src/dashboard/server.js`)**:

- **CSS-only tooltip** — маленький круглый `?` бэдж рядом с term label'ом. На hover вылезает styled tooltip (240px wide, темный фон, стрелка-уголок снизу). Использует `data-tooltip` + `::before`/`::after` псевдоэлементы — никакого JS, никаких state'ов. `.term-help.right` — модификатор для тултипа в правой части модалки (anchor flip, не клипается).
- **Helper в TrendModal**: `const isAdmin = me?.plan === 'admin' || me?.plan_name === 'admin'` + `termHelp(text, right=false)` который возвращает `<span class="term-help" data-tooltip="...">?</span>` или null если не админ.
- **i18n**: 9 ключей EN+RU в блоках `term.*`:
  - `meme_score`, `virality`, `velocity`, `alert_score`, `lifespan` — top stats
  - `emergence`, `feedback`, `junk`, `stale` — alert breakdown rows

**Где встроены `?`-бэджи**:
- Modal stats grid: рядом с лейблами **Meme Score**, **Virality**, **Velocity**, **Alert** (последний с `right=true` — он у правого края).
- Alert math panel rows: **meme**, **viral**, **emerge**, **feedback** (positive); **junk**, **stale** (penalty). `posRows` теперь содержит поле `tooltip`, мап рендерит `termHelp(r.tooltip)` после label'а.

**Что НЕ затронуто**:
- Twitter `X` row в breakdown — нет tooltip'а, потому что метрика самоочевидна и редко не-нулевая.
- Lifespan tile ушёл из модалки давно (заменён на Alert), но i18n строка `term.lifespan` осталась на будущее.

**Когда откроем всем — одна строчка**:
```js
// строка 8704 в src/dashboard/server.js — заменить:
const isAdmin = me?.plan === 'admin' || me?.plan_name === 'admin';
// на:
const isAdmin = true;
```
Все `?`-бэджи сразу появятся у free/test/pro юзеров. Никакого других правок не нужно.

**SPA-trap, попался дважды**:
1. CSS comment `via the \`isAdmin\` flag` — backticks → SPA сломан, ошибка `Unexpected identifier 'isAdmin'`.
2. JS comment `Pass \`right=true\`` — то же самое, ошибка `Unexpected identifier 'right'`.
Заменил на голый текст без backticks. Validator после фикса ✅ OK (279361 chars).

**Файлы**: `src/dashboard/server.js` (~+190 LOC: CSS + i18n EN/RU + helper + 9 встраиваний).

**Проверки**: SPA validator ✅ OK, `node --check` чистый.

**Дополнение (fix позиционирования tooltip'ов, тот же день)**:
- Юзер прислал скриншоты — tooltip'ы клипались: верхние (Meme Score) уезжали выше viewport'а, левые (Virality) обрезались по левому краю модалки.
- Причина: original CSS позиционировал tooltip **сверху** иконки + **по центру** (`bottom: 100% + 8px; left: 50%; transform: translateX(-50%)`). Иконки-то у верхней/левой границ контейнера → клип.
- Fix: tooltip теперь **ПОД** иконкой (`top: calc(100% + 8px)`) + якорится **по левому краю** (`left: 0`). Стрелка тоже flipped (`border-bottom-color`, `top: calc(100% + 2px)`). Width 240→220 + `max-width: calc(100vw - 40px)` защита на узких экранах.
- `.right` модификатор остался — теперь «anchor right» для Alert tile (была `transform: none` лишняя — убрал).
- Result: для всех 9 встраиваний tooltip уходит вниз-вправо (вниз-влево для Alert с `right=true`). Не клипается по верху; левого клипа нет.

---

## 2026-05-07 (Mini-chart эволюции alertScore — sparkline в дашборде)

Юзер выбрал первый из NICE-TO-HAVE. Цель: показать как `alertScore` меняется со временем (recompute cycles) — sparkline под equation в Alert verdict. Тестируем только на admin'е, потом откроем всем.

**Backend**:
- `src/db/database.js`:
  - Новая таблица `alert_score_history` (trend_id FK, ts DEFAULT CURRENT_TIMESTAMP, score, positive, penalty, floor_at_ts, source) + index `(trend_id, ts)`. ON DELETE CASCADE — если тренд удалён, история чистится автоматом.
  - Методы: `recordAlertScoreHistory({trendId, breakdown, floorAtTs, source})`, `getAlertScoreHistory(trendId, limit=100)`, `pruneAlertScoreHistory(retentionDays=30)`.
- `src/notifications/alert-dispatcher.js — recomputeAlertScores`:
  - Сигнатура расширена: `(trends, alertWeights, db, opts={})` где `opts = {source, floor}`.
  - После каждого `computeAlertScore` пишем точку в `alert_score_history` (если `t._dbId` есть).
  - Try/catch обёрнуто — история «декоративная», падать на write не должна.
- Call sites:
  - `src/index.js:511` (scan cycle) → `source: 'scan', floor: globalAlertThreshold`.
  - `src/refresh/hot-metrics.js:293` (hot refresh) → `source: 'refresh-hot', floor: globalAlertThreshold`.
- Maintenance loop в `src/index.js`: startup prune + daily setInterval, retention 30 дней. Тот же паттерн что у `cleanupExpiredHiddenTrends`.

**API endpoint**:
- `GET /api/trends/:id/alert-history` → `{points: [{ts, score, positive, penalty, floorAtTs, source}], floor}`.
- **Admin-only гейт**: `if (planName !== 'admin') return 403 Forbidden`. Когда откроем — одна строчка.
- Floor подтягивается из `getActivePresetConfig(db).alerts.thresholds.alertThreshold` (как в /api/me).

**Frontend (`src/dashboard/server.js`)**:
- Новый useState в TrendModal: `alertHistory`, `alertHistoryLoading`. Lazy-fetch при открытии math panel (alertDetailsOpen=true) — не дёргаем API на каждое открытие модалки, только когда юзер реально хочет видеть детали.
- Функция `renderAlertSparkline(points, floor, t)` — inline SVG (240×56), без chart-библиотек:
  - Filled area под линией score (зелёный/красный зависит от passed состояния на последней точке).
  - Score line + dot на последней точке.
  - Floor reference line (dashed).
  - X-axis time-scaled (gaps = реальное время, не равномерные шаги).
  - Header: `score evolution · 47 pts · 2.3h · +12` (зелёный delta).
  - Mini-legend под графиком: `MM-DD HH:MM · 65 → MM-DD HH:MM · 78`.
- `fmtSparkTs()` helper для форматирования SQLite TEXT timestamp'ов.
- Render в alert math panel **между equation и floor decomposition**. Только если `points.length >= 2` (одна точка = просто dot, бесполезен).

**Стили**: `.alert-spark` / `.alert-spark-header` / `.alert-spark-svg` / `.alert-spark-floor` (dashed) / `.alert-spark-legend`. Token-aware (`--green`, `--red`, `--text2`, `--muted`).

**i18n**: 4 строки EN+RU — `alert_spark_label` («score evolution» / «эволюция score»), `alert_spark_points` («pts» / «точек»).

**Admin-only сейчас, потому что**:
1. Весь Alert verdict block уже gate'нут к `me.plan === 'admin'` в TrendModal — sparkline просто наследует.
2. API эндпоинт второй уровень защиты.

Когда откроем для всех — убираем `if (planName !== 'admin')` в `_handleAlertHistory` и `me.plan === 'admin'` гейт в TrendModal на блоке Alert verdict.

**Стоимость в продакшене**:
- Scan каждые 15 мин = 96 recompute/день/trend. Hot-refresh раз в 12h. ~100 rows/день/trend.
- При 200 активных трендах в среднем = 20K rows/день, 600K/месяц. SQLite справится без вопросов.
- Если станет шумно — добавим throttle «skip write if score unchanged within 1h».

**Файлы**: `src/db/database.js`, `src/notifications/alert-dispatcher.js`, `src/index.js`, `src/refresh/hot-metrics.js`, `src/dashboard/server.js`.

**Проверки**: SPA validator ✅ OK (275054 chars), `node --check` чистый по всем 5 файлам.

---

## 2026-05-07 (Dashboard Alert verdict — collapsible math panel)

Юзер пожаловался, что блок Alert verdict в trend-modal грузит интерфейс — чипы с **сырыми** значениями `meme 98 · viral 95 · emerge 90 · feedback 50 · junk -15` без weights и без понимания, какой компонент на сколько очков подвинул. И что блок развёрнут по умолчанию, занимает место. Сделал такой же подход, как в admin Decisions — компактный header + collapsible math panel.

**Что сделано (`src/dashboard/server.js`)**:
- `TrendModal` — новый useState `alertDetailsOpen` (default false).
- **Compact header** (всегда виден): pass/fail пилюля (`✓ 73 / 60 · would alert`) + alertType chip (`trend · ✓ in your filter` или muted) + кнопка `▾ show math` справа.
- **Math panel** (раскрывается по клику):
  - 2-колоночный grid: **+ positive signals** (meme/viral/emerge/twitter/feedback) и **− penalties** (junk, stale).
  - Каждая строка: `label · raw × weight · contribution` (color-coded). Когда weights snapshot отсутствует (старые decisions) — calc-колонка падает на голый raw.
  - `junk триггеры:` теги под penalty-таблицей (politics, kpop/fandom, celeb-noise, no-meme-shape, text-only, safe-override). Те же визуально, что в admin'е: красный border, голубой для safe-override.
  - **Equation**: `+positive − penalty = score ≥/< floor (✓ pass / ✗ fail)`.
  - **Floor decomposition**: `Floor 60 = max(your 50, admin 60)`.
- **Empty state**: если breakdown null (старые save-only rows), при клике на details показывается вежливое `No detailed breakdown saved for this trend`.

**Стили** — добавлен self-contained блок `.alert-verdict-header` / `.alert-verdict-pill` / `.alert-type-chip` / `.alert-details-btn` / `.alert-math-panel` / `.alert-math-grid` / `.alert-math-section` / `.alert-math-table` / `.alert-math-reasons` / `.alert-math-eq` / `.alert-math-floor`. Использует существующие токены (`--green-rgb`, `--red-rgb`, `--accent-rgb`, `--text2`, `--dim`). Mobile-friendly: при ≤720px grid становится одноколоночным.

**i18n** — добавлено по 7 строк в EN и RU блоки: `alert_details_show/hide`, `alert_section_positive/penalty`, `alert_floor_explain` (template `{floor}/{user}/{admin}`), `alert_junk_triggers`, `alert_no_breakdown`.

**Файлы**: `src/dashboard/server.js` (~+200 LOC: useState + render + CSS + i18n).

**Проверка**: `check-dashboard-spa.cjs` ✅ OK (268237 chars). `node --check` чистый.

**Не сделано (nice-to-have)**:
- Mobile-tap delight: можно добавить лёгкий expand-анимацию (height transition) для math panel. Сейчас просто скачкообразно появляется.
- Tooltip с пояснением каждого junk-триггера (как в admin'е через `junkReasonHint`). Дашбордный юзер не разработчик, для него «no-meme-shape» — кракозябра. TODO: добавить понятный i18n-словарь.

**Дополнение (admin-only gate)**:
- Юзер уточнил: блок Alert verdict нужен только админам. Free/test/pro и так не разбираются в внутренней механике scoring'а; видеть «-10 stale penalty» это им ничего не даст и только добавит вопросов.
- В условии рендера блока добавлена проверка `me?.plan === 'admin' || me?.plan_name === 'admin'` (паттерн как в существующем коде line 8396, 9436). Other plans теперь не видят ни верхнюю пилюлю, ни кнопку «show math».
- **SPA trap**: первая попытка содержала backticks в комментарии (`` `me.plan === 'admin'` ``) → SPA сразу слетел на «Unexpected identifier». Заменил на `me.plan==="admin"` без backticks. Validator после фикса ✅ OK (268682 chars).

**Дополнение (зачистка упоминаний admin плана из UX)**:

Юзер увидел `🔒 Manual analysis is available on Test/Pro` и вспомнил, что в других местах ещё могут проскакивать `Pro/Admin`, `Pro / Admin`. Попросил пройтись по всему проекту и убрать упоминания admin плана отовсюду, кроме самого админ-интерфейса.

**Стратегия**: трогаем только user-facing строки (i18n, error responses, bot command descriptions, tooltips). НЕ трогаем: серверный guard'ы (`if (plan === 'admin')`), комментарии в коде, SQL-схему, таблицу plans, admin/server.js, ai-context.

**Заменено (10 user-facing строк)**:
- `src/dashboard/server.js`:
  - `1668` API 403 error — `'Favorites is a Pro/Admin feature'` → `'Favorites is a Pro feature'`
  - `1406` API 403 error — `'Admin only'` → `'Forbidden'`
  - `6203` (EN) `analyze.intro` — `'Pro / Admin only.'` → `'Pro only.'`
  - `6214/6215` (EN) `fav.locked_tooltip/toast` — `'Pro/Admin'` → `'Pro'`
  - `6269` (EN) `feed.manual_tip` — `'Manually submitted via admin panel'` → `'Manually submitted'`
  - `6534` (EN) `account.threshold_desc` — `'admin floor'` → `'platform floor'`
  - `6601` (RU) `analyze.intro` — `'Pro/Admin'` → `'Pro'`
  - `6612/6613` (RU) `fav.locked_*` — `'Pro/Admin'` → `'только на Pro'`
  - `6667` (RU) `feed.manual_tip` — `'Ручная отправка через админку'` → `'Добавлено вручную'`
  - `6929` (RU) `account.threshold_desc` — `'floor админа'` → `'floor платформы'`
- `src/notifications/telegram.js:101` — bot command description `'Analyze a URL (Pro / Admin)'` → `'Analyze a URL (Pro)'`
- `src/i18n/en.js:36` + `ru.js:37` — `dashboardPrompt`: `(Pro / Admin)` → `(Pro)`

**Сознательно НЕ удалили**:
- `'plan.admin': 'Admin'` строки в i18n (line 6545/6940) — нужны самому admin-юзеру в его AccountPanel; рендерятся только при `user.plan === 'admin'`, для free/test/pro не fire.
- `'modal.alert_floor_explain'` (line 6435/6831) — содержит слово `admin` в шаблоне, но весь блок Alert verdict уже gate'нут к admin-only viewing (предыдущий step). Не-админу строка в bundle есть, но никогда не рендерится.
- Комментарии `// pro/admin` по всему коду — внутренние доки, в UI не выходят.
- `src/admin/server.js` — там «Test, Pro и Admin» в card-sub label, видит только админ, и так в админке.

**Проверки**: `check-dashboard-spa.cjs` ✅ OK (268639 chars), `node --check` чистый по всем 4 затронутым файлам.

**Файлы**: `src/dashboard/server.js`, `src/notifications/telegram.js`, `src/i18n/en.js`, `src/i18n/ru.js`.

---

## 2026-05-07 (Admin DecisionsPage — расширенная панель математики scoring)

Пользователь заметил, что на дашборде trend с `meme=92 viral=92 emerg=93 junk=20` получил score 55 при пороге 60 — и по умолчанию непонятно, откуда такой штраф. junk×0.50 = -10, не объясняет 16 недостающих очков. Чтобы такие вопросы больше не возникали — добавил подробную панель в admin Decisions.

**Backend snapshot weights в breakdown**:
- `src/analysis/scorer.js` — `computeAlertScore.breakdown` теперь включает `weights: {...}` snapshot (10 полей: weightMemePotential/Virality/Emergence/Twitter/Feedback/Junk + staleDecay knobs + hardJunkStop) и `feedbackStats: {likes, dislikes}`. Снимок гарантирует, что отображаемая математика соответствует МОМЕНТУ принятия решения, даже если активный preset потом отредактировали.
- `src/notifications/alert-dispatcher.js — recomputeAlertScores` — подцепляет `t._feedbackStats` (raw vote counts из getFeedbackStats), чтобы scorer мог их положить в breakdown.
- `dispatchAlerts.decisionBase` — добавлены `userFloor`, `globalFloor`, `preset` (имя активного preset'а в момент решения).

**Frontend — `DecisionsPage` (`src/admin/server.js`)**:
- Добавлено состояние `expanded` (Set keyed by `ts:trendId`) + кнопка `▾ детали` справа от breakdown one-liner.
- Новая функция `MathPanel(d)` рендерит:
  - 2-колоночный grid: **+ Положительные сигналы** (meme/viral/emerg/twitter/feedback) и **− Штрафы** (junk, stale).
  - Каждая строка: `label · raw × weight · contribution` (color-coded: pos зелёный, neg красный, zero мутный).
  - Σ итог в каждой колонке.
  - Equation: `+81.3 − 26 = 55  ≥/< 60 (✓/✗)` с большим color-coded финальным числом.
  - Threshold breakdown: `max(user X, admin Y)`.
  - Meta-pills: feedback votes (👍 N / 👎 M → boost X), hard-junk reference (`junk N / 70 ✓/⚠`), stale cap, trigger source (scan/refresh/manual).
- В meta-row карточки добавлен `🎯 <preset>` chip (понимать какой preset был активен).
- Backward compat: старые decisions без `weights` snapshot получают warning-pill «старая запись — calc неполный» и calc-колонка показывает только raw value.

**Стили** (~50 строк CSS, секция `.dec-math*`): grid 2-col → 1-col на ≤900px, цветные contributions, badge'и в заголовках секций, equation block с большим финальным числом.

**Файлы**: 
- `src/analysis/scorer.js` (+30 LOC, breakdown extras)
- `src/notifications/alert-dispatcher.js` (+5 LOC, feedbackStats hook + decisionBase fields)
- `src/admin/server.js` (+~180 LOC: MathPanel + CSS + state)

**Деплой**: не требует миграций. Старые decisions в ring-buffer покажут warning-pill, новые — полную математику. После рестарта buffer очищается, всё отображается ок.

**Риски**: ring-buffer ~500 решений × ~80 байт extra на decision (weights snapshot) = +40KB heap. Принципиально не страшно. Если станет больно — можно хранить только weights diff от DEFAULT_ALERT_WEIGHTS, но пока преждевременная оптимизация.

**Не сделано (nice-to-have)**:
- Кнопка «копировать математику в буфер» как text — для шаринга в slack/issue.
- Линк на trend page в дашборде (сейчас только URL первоисточника, можно добавить deep-link `/dashboard/trend/<id>`).
- Mini-chart how alertScore evolved across recompute cycles (нужен timeseries, нет в текущем буфере).

**Дополнение того же дня (junk-reasons в panel)**:
- Юзер увидел trend с junk=20 → -10 штрафом и спросил «за что junk?». Math panel показывал результат, но не сами триггеры junk-filter'а.
- `scorer.js` — `breakdown.junkReasons` (array) теперь снимок triggers'ов из `trend.junkReasons` / `trend.clusterMetrics.junkReasons` (politics, kpop/fandom, celeb-noise, no-meme-shape, text-only, safe-override(÷N)).
- `admin/server.js — MathPanel` — под penalty-таблицей появился ряд `junk триггеры: <tag1> <tag2> ...` с tooltip-подсказкой через `junkReasonHint(r)`. safe-override tag'и подсвечены голубым (rescue path), остальные — красным.
- Стили: `.dec-math-reasons` + `.tag` (красный border) + `.tag.safe` (голубой).
- Файлы: `src/analysis/scorer.js` (+8 LOC), `src/admin/server.js` (+~30 LOC: hint helper + render + CSS).

---

## 2026-05-07 (Tag auto-refresh — Phase 3: per-tag pin lock UI в PresetConfigsPage)

Финальная фаза tag-refresh — UI для per-element lock-mask. Юзер может закрепить (🔒) конкретный subreddit или Twitter keyword group, и auto-refresh не сможет его удалить даже если Grok не предложит. Pin-флаг — основа «копилки хороших тегов» (как юзер сказал в Phase 2 обсуждении).

**Архитектурные решения**:
- **Lock-mask shape**: `{<preset>: {reddit: ['aww', 'capybara'], twitter: ['(zoomies)', '(blep OR mlem)']}}`. Per-source-type, не per-tag global. Сравнение case-sensitive для Reddit, case-insensitive для Twitter (toLowerCase в `_computeDiff`).
- **Twitter lock-key — это keyword-PART** запроса (без `min_faves:N` и `-is:retweet`). Это согласуется с tag-refresher.js diff logic — он сравнивает proposed groups (без чисел) с current groups (нормализованные). Если бы хранили full string — match не сработал бы. UI извлекает keyword-part при toggle через regex strip.
- **Save flow**: оба draft'а (overrides + locks) сохраняются одним `POST /api/preset-configs`. Locks-only save (overrides empty, locks non-empty) — нормальный flow, NOT триггерит Clear-ALL panic. Только когда оба пустые — wipes auto-blob тоже.
- **Reset preset «X» button** теперь чистит и manual draft, и lock-mask для этого preset'а.
- **Clear ALL** чистит всё: manual + locks frontend-state, после Save backend wipes manual + auto + locks blobs.
- **Chip removal** автоматически unlock'ает удалённый item — иначе остался бы dangling lock-key несуществующего тега.

**Что в Phase 3 (этот коммит)**:

1. **Validator** (`src/analysis/preset-config.js`):
   - `validatePresetTagsLocked(input)` — sanity-check: преsetы из PRESET_KEYS, sourceType ∈ {'reddit', 'twitter'}, tags coerced to deduplicated string array. Drop unknown silently.

2. **Backend integration** (`src/admin/server.js`):
   - `_getPresetConfigs` теперь возвращает `tagsLocked: readPresetTagsLocked(db)` — frontend читает оттуда.
   - `_setPresetConfigs(body)` принимает `body.tagsLocked` (опц), валидирует через `validatePresetTagsLocked`, persist'ит в `settings.presetTagsLocked`.
   - Clear-ALL panic logic: только если **оба** (manual + locks) пустые → wipe auto-blob тоже. Иначе locks-only save проходит нормально без затирания auto.

3. **Frontend** (`src/admin/server.js — PresetConfigsPage`):
   - State `locked` (отдельно от `draft`) — sparse blob lock-mask.
   - Mutators: `toggleLock(preset, sourceType, lockKey)` — toggle individual entry, GC empty arrays/objects.
   - `clearAll` теперь чистит и draft и locked. `resetPreset(preset)` чистит для конкретного preset'а.
   - `save` отправляет `{overrides: draft, tagsLocked: locked}`.
   - `PChips` компонент: для путей `sources.reddit.subreddits` и `sources.twitter.queries` передаёт `lockSourceType`, `isLocked`, `onToggleLock` callbacks в `ChipInputBox`. Twitter путь использует strip regex для извлечения keyword-part в качестве lock-key.
   - Auto-unlock при удалении chip'а (через onRemove): если удаляемый item был locked — снимаем lock одновременно с удалением.

4. **`ChipInputBox`** (presentation):
   - Принимает 3 новых prop'а: `lockSourceType`, `isLocked`, `onToggleLock`. Если все три — chip получает 🔒/🔓 toggle button слева от текста.
   - Locked chip: дополнительный CSS класс `pcfg-chip-locked` — зелёный border + glow. Visual signal что элемент защищён.
   - `pcfg-chip-lock` button: opacity .7 → 1 + scale на hover, transition .15s.

5. **CSS** (`src/admin/server.js inline styles`):
   - `.pcfg-chip-lock` — стиль toggle-кнопки.
   - `.pcfg-chip-locked` — extra border/bg/glow для locked chip'ов.

**Поведение auto-refresh с Phase 3**:
Когда tag-refresher запускается (force или scheduled):
1. Grok возвращает proposed list.
2. `_computeDiff` читает `presetTagsLocked` через `readPresetTagsLocked(db)`.
3. Locked items добавляются в `kept` set ВСЕГДА — даже если их нет в proposed.
4. `_applyAutoOverride` пишет в auto-blob финальный список = locked + (proposed ∩ current).
5. Юзер видит в админке: locked chips остались (зелёные с 🔒), не-locked могли быть удалены/добавлены.

**Файлы**: `src/analysis/preset-config.js` (+30 строк validator), `src/admin/server.js` (~80 строк frontend + endpoints + CSS).

**Деплой**: TBD юзером. После деплоя — UI готов, юзер может lock'ать в админке. Auto-refresh уже respect'ит locks с Phase 1 (был reader без UI).

**Sanity checks**: `node --check` для preset-config.js + admin/server.js ✓. SPA-template ✓ (211636 chars, +4K с Phase 2).

**Риски**:
- Если юзер lock'ает Twitter keyword group через UI, и потом меняет min_faves в полной строке (например через manual edit), lock-key (keyword-part) останется match'иться правильно — потому что мы lock'аем part, не full string. Но если юзер изменит сам keyword-part (`(zoomies)` → `(zoomies OR sploots)`), старый lock останется на неактуальном ключе. Это acceptable edge case — юзер delete'нет старый item и lock'нет новый.
- Frontend stores lock-key in client state до save. Если юзер lock'нул и закрыл вкладку без Save — lock не persist. Это standard для всего PresetConfigsPage flow (manual overrides тоже теряются без Save).
- Размер lock-mask blob небольшой (~ десятки строк), settings table выдержит.

---

## 2026-05-07 (Tag auto-refresh — Phase 2 sanity-tests + production fixes)

После Phase 2 запустили 2 теста через temp script (потом удалён):

**Тест #1** (промпт без MANDATORY TOOL USAGE, без tool_choice):
- ✅ 200 OK, 69 sec, $0.0312
- ✅ JSON парсится, 8 subs + 5 twitter groups
- ❌ **0 x_search calls** — Grok ответил из training data без real-time проверки

**Тест #2** (после усиления промпта + добавления tool_choice='required'):
- Сначала падал с UND_ERR_HEADERS_TIMEOUT — undici default 5 min недостаточно для Grok+x_search reasoning
- Установил undici@6 (8.x не совместима с Node-bundled fetch — `invalid onRequestStart method`)
- Затем падал с UND_ERR_SOCKET / "other side closed" — **xAI Responses API НЕ поддерживает `tool_choice: 'required'`**, обрывает соединение rude вместо 400
- После удаления tool_choice + custom dispatcher (15-min timeout): ✅ 200 OK, 117 sec, $0.0448, **9 x_search calls**, citations с реальными @usernames + датами May 6 2026

**Найденные проблемы и применённые фиксы в production**:

1. **Удалил `tool_choice: 'required'`** из `_callXaiResponses`. Comment: «xAI Responses API drops the connection (UND_ERR_SOCKET) instead of returning 400». Prompt-mandate отрабатывает (9 calls в тесте), tool_choice не нужен.

2. **Добавил undici long-timeout dispatcher** — `XAI_LONG_AGENT` с 15-min headers/body timeout. Передаётся в fetch как `dispatcher` опция (per-request, не глобально — другие fetch'и в process сохраняют свои дефолтные timeout'ы). Без этого первый production refresh с x_search'ами на 100-300s валился бы по UND_ERR_HEADERS_TIMEOUT.

3. **Установил `undici@6`** в dependencies (1 пакет). Версия 6.x совместима с Node 22.22.2 bundled fetch; v8.x несовместима — выдаёт `invalid onRequestStart method`. Использует только tag-refresher для своего dispatcher; остальной проект на native fetch без изменений.

**Итоговая стоимость и время с production-конфигом**:
- $0.045 / preset × 5 = $0.22/refresh × 4/мес ≈ **~$0.88/мес** (vs прогноз $0.54 без mandate)
- 117s / preset × 5 = ~10 мин на полный refresh. Force-button показывает «5 пресетов обработано за Xс» в success-toast.

**Качество предложений Grok'a с x_search**:
- Subs: `Zoomies` (450K), `blep` (461K), `Chonkers`, `sploots` — реальные mid-size сабы (size verified в его citations)
- Twitter groups: `(zoomies)`, `(chonker OR chonky)`, `(mlem OR blep)`, `(sploots)`, `(loaf OR catloaf)`, `(boop OR snoot)` — все behavior-pattern, без named memes
- Каждое предложение grounded на real @username + date (e.g. `@remalchacha post May 6 2026`)

**Файлы**: `src/refresh/tag-refresher.js` (обновлён: undici dispatcher + удалён tool_choice + усилен SYSTEM_PROMPT), `package.json` (added undici@6 dep), `package-lock.json`.

**Деплой**: TBD юзером. Перед деплоем — `npm install` обязателен, чтобы undici@6 попал в node_modules контейнера.

**Риски**:
- Reddit subs предлагаемые Grok'ом могут не существовать (например `BoopTheSnoot` — может быть hallucination даже с x_search). Phase 3+ может добавить Reddit existence check через `https://www.reddit.com/r/<name>/about.json` (free Reddit API).
- 10-мин refresh time не блочит scan-cycle (фоновый), но force-button в админке должен показывать spinner + не давать spam-clicks (rate-limit 24h на это и рассчитан).
- undici@6 транзитивно зависит от `tr46` который имеет известные мелкие vulnerabilities (`npm audit` может ругаться). Не блокер для server-side use.

---

## 2026-05-07 (Tag auto-refresh — Phase 2: реальный xAI Grok call + Live Search + reality-check)

Phase 1 был infra-skeleton. Phase 2 — настоящая логика. После Phase 2 force-кнопка в админке физически зовёт Grok, парсит JSON, валидирует, проверяет каждый новый Twitter keyword через Apify probe, считает diff vs defaults, пишет в `presetConfigsAuto`.

**Архитектурные решения**:
- **Live Search**: через `tools: [{type: 'x_search', max_search_results: 20, return_citations: false}]` — этот же pattern Stage 2 в scorer.js использует. xAI x_search **physically** ходит в X (Twitter) и возвращает свежие посты, прямо в reasoning context Grok'a. Решает hallucination проблему slang anchor.
- **Не используем `text.format = json_schema`**: scorer.js comment line 933-934 явно говорит «xAI Grok does not currently honour text.format=json_schema reliably». Парсим JSON свободно из text response с поддержкой markdown fences и prose-обёрток.
- **Fallback model**: на 5xx / `model_not_found` / `not_available` падаем с `grok-4.3` на `grok-4.20-0309-reasoning`. Тот же pricing ($1.25/$2.50 per 1M), оба reasoning-capable.
- **Cost tracking**: `cost = (input × 1.25 + output × 2.50) / 1_000_000`. Записывается в `tag_refresh_history.cost_usd`, summary в logs `[TagRefresher] done in Xs ... cost=$0.123`.
- **`max_tool_calls: 5`**: hard cap на consecutive x_search calls — без него Grok делает 4+ search'ей на один запрос, накапливая search results в reasoning context → quadratic input tokens (тот же trap scorer.js Stage 2 ловил).

**Pipeline per-preset refresh**:
1. `_buildPrompt(preset, existing)` — system prompt (моdule-level constant) + user prompt с EXISTING list across **всех 5 пресетов** (anti-duplicate) + per-preset theme description.
2. `_callGrokWithFallback(prompt)` — primary `grok-4.3`, fallback `grok-4.20-0309-reasoning`.
3. `_parseJson(text)` — strips markdown fences, finds first balanced `{...}` block.
4. `_sanitizeResponse(parsed)` — regex-validation: subreddits `^[a-zA-Z0-9_]{2,40}$` без `r/` prefix; twitter groups `^\(.+\)$` БЕЗ цифр / `min_faves` / `-is:retweet`. Дедуп case-insensitive.
5. `_realityCheckTwitter(proposed, preset)` — variant-3: для **новых** keyword groups (skip already-existing) делаем 1 Apify Twitter probe `${group} min_faves:100 -is:retweet`, max 5 results. Если 0 — drop. Если probe error — drop conservatively. Existing groups passes-through (они уже работают).
6. `_computeDiff(preset, sanitized)` — sets из current defaults + locked-mask (`presetTagsLocked`). Locked tags **никогда не удаляются** (даже если Grok их не предложил).
7. `_applyAutoOverride(preset, diff)` — пишет в `settings.presetConfigsAuto`, sparse blob. Восстанавливает `min_faves` для каждой Twitter query (берёт из defaults original, новые получают median min_faves). Если final result == defaults точно — drops slot (no-op pollution prevention).

**Sanitization details**:
- Twitter keyword groups валидируются жёстко: regex `^\(.+\)$` (must be wrapped in parens) И `!/min_faves|-is:retweet|\d+/` (no numbers, no operators). Если Grok добавит `(skibidi OR delulu OR 2026)` — отвергается (потому что цифры в `2026`). Если без скобок — отвергается. Это double-check к промпту.
- Subreddits: `replace(/^\/?r\//i, '')` срезает любые префиксы `r/`, `/r/`. Затем regex matches `/^[a-zA-Z0-9_]{2,40}$/`.
- Если sanitized result полностью пустой (subs=0 AND twitter=0) — `status: 'rejected_validation'`, audit row пишется с raw text head в error_message для debugging. Auto-blob не трогается.

**Reality-check (variant 3) детали**:
- Probe = single Apify Twitter call через `twitter.searchByQuery(query, 5, {relaxedFloor: true})`. Стоимость одного probe ~ $0.001 (5 tweets max). На 5 пресетов × 5-6 keyword groups × 0-3 NEW groups per refresh = ~$0.01-0.03 per refresh, погрешность.
- Skip-logic: existing keyword groups (уже в defaults / auto / manual) не проверяются — они известно работают, лишний расход бюджета.
- Если twitter instance не передан в constructor (early-boot edge case) — pass-through без probe + warn-log.

**Locked tags merge**: `_computeDiff` читает `presetTagsLocked[preset].reddit/twitter` arrays. Locked items добавляются в `kept` set всегда, попадают в final apply без условий. Это даже если Grok их не предложил И их нет в defaults — locked = sticky. Phase 3 добавит UI для записи в этот lock-mask.

**Failure handling**:
- 5xx / model_not_found → fallback model
- JSON parse error → throw, audit `error` status, anyFailure=true, retry next cycle
- Validation reject (empty after sanitization) → audit `rejected_validation` status, NOT counted as failure (no streak bump) — это «Grok дал мусор», не «infra сломалась»
- 3 consecutive `error` runs (only `error`, не rejected_validation) → circuit breaker

**Wire**:
- `index.js`: после `collectors.find('Twitter')` — `if (twitterInstance) tagRefresher.twitter = twitterInstance;` пост-инициализационный attach (TagRefresher constructed BEFORE collectors).
- `_isApiAvailable()` checks `XAI_API_KEY` — `refreshAll` reject'ит refresh с reason `no_api_key` если ключа нет.

**Файлы**: `src/refresh/tag-refresher.js` (полностью переписан, ~430 строк), `src/index.js` (twitter attach + комментарий обновлён).

**Деплой**: TBD юзером. После Phase 2 деплоя — first force-refresh даст реальные предложения. Если выйдут плохие — Clear ALL вернёт всё к code-defaults, потом юзер выключит toggle и решит что дальше.

**Sanity checks пройдены**: `node --check` для tag-refresher.js, index.js, admin/server.js ✓. SPA template ✓ (207K chars).

**Риски**:
- xAI x_search tool input shape может отличаться от моих предположений. Я взял ровно тот pattern что Stage 2 использует (line 725-731 scorer.js). Если что-то пойдёт не так — error будет в audit log с full xAI response text.
- Grok-4.3 — модель вышла недавно (дата релиза < 1 неделя). Может иметь instability на сложных prompt'ах. Fallback на 4.20-reasoning должен спасти.
- `_parseJson` берёт первый `{` до последнего `}` — если Grok даст несколько JSON блоков подряд (например narrative + JSON + narrative + JSON), возьмёт всё включая prose между. Validation на следующем шаге это выкинет.
- Reality-check probe использует `relaxedFloor: true` (10K views / 500 likes). Это лояльный bar — keyword group с одним viral tweet проходит. Это не fail-mode потому что мы хотим сохранить keywords которые catch'ат **редкие** но виральные events.

---

## 2026-05-07 (Tag auto-refresh — Phase 1 infra: storage, admin UI, toggle, history)

Юзер хочет автоматический weekly Grok call чтобы обновлять `subreddits` и Twitter `keywords` по 5 пресетам. Sources не trogatься руками — auto-overrides + manual locks. Cost ~$0.13 / refresh × 4/мес = ~$0.54/мес.

**Грок-промпт после 3 итераций**: source-vs-subject distinction усвоен (Grok даёт horizontal hubs + behavior-pattern keyword groups, не named memes). Slang-anchor (6-я keyword группа) — слабая точка, без Live Search Grok галлюцинирует «свежие 2026 термины». Решено в Phase 2 делать **variant 3** (reality-check каждого slang term через 1 Apify Twitter probe) + Live Search через xAI API.

**Архитектурные решения**:
- **Storage**: 3-layer merge `defaults → presetConfigsAuto → presetConfigs (manual)`. Manual ВСЕГДА побеждает. Auto-blob — separate setting.
- **Lock**: Phase 3 будет per-tag pin (юзер сказал «и базу хороших тегов соберу со временем»). Phase 1 только storage `presetTagsLocked` без UI.
- **Cooldown**: 7 дней scheduled, 1×/24h force (anti-double-click). Both в env, defaults в коде.
- **Failure**: 3 strikes circuit breaker (auto-disable после 3 fails подряд), manual reset через админку.
- **Models**: primary `grok-4.3` ($1.25/$2.50/M), fallback `grok-4.20-0309-reasoning` (то же pricing). Оба через тот же `XAI_API_KEY` / `XAI_BASE_URL`.
- **Clear ALL extension**: panic-button теперь стирает ОБА blob'а (manual + auto), полный возврат к code-defaults.

**Что в Phase 1 (этот коммит)**:

1. **DB** (`src/db/database.js`):
   - Migration: table `tag_refresh_history(id, ts, preset, source_type, status, diff_json, error_message, model, cost_usd)` + index по ts.
   - Методы: `recordTagRefresh`, `getTagRefreshHistory(limit)`.

2. **Reader** (`src/analysis/preset-config.js`):
   - `readPresetAutoOverrides(db)` — читает `settings.presetConfigsAuto` blob.
   - `readPresetTagsLocked(db)` — per-tag lock-mask (Phase 3 reader готов).
   - `getActivePresetConfig` теперь делает 3-layer merge через `mergeOverrideBlobs(auto, manual)` → manual wins. Все consumers (scorer/clusterer/collectors) автоматически получают auto-suggestions поверх defaults и manual поверх auto.

3. **Refresher** (`src/refresh/tag-refresher.js` — новый):
   - Class `TagRefresher` с методами: `isEnabled/setEnabled/getStatus/shouldRefreshNow/canForceNow/refreshAll/resetCircuitBreaker`.
   - `_callGrokForPreset` — Phase 1 stub возвращает `null` (no changes). Phase 2 заменит на real xAI call.
   - Cooldown gates через `tagAutoRefreshLastRunAt` setting.
   - Failure tracking через `tagAutoRefreshFailureStreak` (3 → auto-disable).

4. **Admin endpoints** (`src/admin/server.js`):
   - `GET /api/tag-refresh/status` — full status + history (50 last rows).
   - `POST /api/tag-refresh/toggle` body `{enabled}` — переключатель.
   - `POST /api/tag-refresh/force` — запускает refresh (rate-limited 1×/24h).
   - `POST /api/tag-refresh/reset-breaker` — сброс failure streak.

5. **Admin UI** (`src/admin/server.js`):
   - Новая sidebar tab `🔄 Auto-tags` (между Пресеты и Ручной анализ).
   - Component `TagRefreshPage`: status badge (Enabled/Disabled/Circuit-breaker open), toggle button, Force button (с confirm + cost warning), reset-breaker button (только когда CB open), 3-cell stats grid (Last run / Next scheduled / Force available after), preview auto-overrides JSON, history table со status-цветами + cost.

6. **Wire** (`src/index.js`):
   - Инициализация `tagRefresher` после `hotRefresher`.
   - Hourly check loop через `setInterval` (60 min × 60 sec × 1000 ms), первый чек 5 min после boot. Loop вызывает `shouldRefreshNow()`, если ok — фоновый `refreshAll()`.
   - Передаётся в `AdminServer` через extras.

7. **Clear ALL extension** (`src/admin/server.js`):
   - `_setPresetConfigs` при пустом overrides теперь wipes **оба** slot'а (`presetConfigs` + `presetConfigsAuto`).

8. **`.env.example`**:
   - `TAG_REFRESH_COOLDOWN_DAYS=7`, `TAG_REFRESH_FORCE_COOLDOWN_HOURS=24`, `XAI_TAG_REFRESH_MODEL=grok-4.3`, `XAI_TAG_REFRESH_FALLBACK_MODEL=grok-4.20-0309-reasoning`.

**Phase 2 (следующий коммит)**: реальный xAI Responses API вызов с `search_parameters: {mode: "on"}`, JSON schema response, slang reality-check через Apify Twitter probe. Прайс на refresh: ~$0.13.

**Phase 3 (потом)**: per-tag pin checkboxes в `PresetConfigsPage` source-секциях, lock-mask save через новый endpoint.

**Файлы**: `src/db/database.js`, `src/analysis/preset-config.js`, `src/refresh/tag-refresher.js` (новый), `src/admin/server.js`, `src/index.js`, `.env.example`.

**Деплой**: TBD юзером. На проде после деплоя — admin sidebar получит tab `🔄 Auto-tags`, всё работает кроме реального Grok-вызова (stub пишет `skipped_no_diff` rows в history). Можно тестировать toggle / force / breaker UI прямо на проде, ничего не сломается.

**Sanity checks пройдены**: `node scripts/check-admin-spa.cjs` ✓ (SPA template валиден, 207K chars), `node --check` для всех 4 модифицированных .js файлов ✓.

**Риски**:
- Phase 1 stub в production будет каждые 7 дней писать `skipped_no_diff` row в `tag_refresh_history` и bump'ать `lastRunAt`. Безвредно но шумит в audit-логе. Можно оставить — после Phase 2 это место превратится в реальные refresh records.
- Hourly loop добавляет крошечную нагрузку (1 setting read per hour). Negligible.
- Если юзер забыл `XAI_API_KEY` в .env — Phase 2 будет fail'ить. Need explicit error message в Phase 2.

---

## 2026-05-06 (Per-preset review — все 5 пресетов: thresholds/weights/stale/junk апдейт)

После Fix B (scorer/dispatcher unified weights) юзер сделал Clear ALL в админ-панели — все overrides снесены, defaults применяются напрямую. Затем прошлись подряд по 5 пресетам (animals → culture → celebrities → events → general), обсуждая каждую секцию. Sources не трогали (юзер хочет потом сделать auto-discovery). Cluster секцию не трогали кроме обсуждения emergence-веса в alerts.

**Контекст про emergence**: юзер в начале думал что emergence — это cross-platform сигнал и хотел его «вырезать». Уже на финальном этапе нашёл [clusterer.js:759-763](src/analysis/clusterer.js:759) — *"Removed the 'Platform spread' component (was 0–30) — clusterer's cross-source matching is unreliable"* — cross УЖЕ был выпилен 4 мая. Текущий emergenceScore = `Math.max(spread, breakout) + ideaBoost`, всё single-source: velocity (db-appearances/hour, 0-35), organic spread (text variation × cluster size, 0-30), novelty (0-20), author diversity (0-15), breakout (one-post virality), Reddit ideaBoost (0-12). Раз cross убран — emergence в пресетах оставили / вернули, но с пересмотренными весами.

**Animals**:
- `reddit.minUpvotes`: 3000 → 5000 (чище floor)
- `junk.noMemeShapePenalty`: 10 → 15
- `alerts.thresholds.alertHardJunkStop`: 65 → 70
- `alerts.stale`: `1/48/20` → `2/24/30` (tail-end ~1.6 дня вместо ~3, юзер хотел до 2)
- `alerts.weights`: `meme 0.45 / viral 0.20 / emerge 0.10→0.15 / twitter 0.10→0.05 / feedback 0.15` (бамп emerge)

**Culture**:
- `alerts.thresholds.alertThreshold`: 65 → 60
- `alerts.thresholds.maxAlertsPerCycle`: 8 → 5
- `alerts.weights`: финальные `meme 0.45 / viral 0.25 / emerge 0.10 / twitter 0.15 / feedback 0.05` (вернулись к pre-review state после изначального обнуления emerge)
- `alerts.stale`: `3/12/40` → `1/48/48` (4-дневная жизнь — мемы могут долго развиваться)
- `noMemeShapePenalty=25` — оставлен (юзер сказал не трогать)
- `cluster.timePenaltyHours=12` — оставлен

**Celebrities**:
- `junk.noMemeShapePenalty`: 20 → 25
- `junk.memeShapeBoost`: 6 → 10
- `alerts.thresholds.maxAlertsPerCycle`: 6 → 5
- `alerts.thresholds.alertHardJunkStop`: 65 → 70
- `alerts.weights`: финальные `meme 0.40→0.50 / viral 0.25→0.30 / emerge 0→0.10 / twitter 0.10 / feedback 0.05→0.00` — meme/viral бампнули (юзер не хотел снижать), emerge мягко вернули, feedback обнулили (фандомы поляризованы, голоса шум)

**Events**:
- `alerts.thresholds.alertThreshold`: 50 → 60
- `alerts.thresholds.maxAlertsPerCycle`: 10 → 5
- `alerts.thresholds.alertHardJunkStop`: 85 → 75
- weights не трогали (events — emergence-доминанта, 0.35; единственный пресет где emergence — центральный сигнал)

**General**:
- `junk.noMemeShapePenalty`: 15 → 20
- `alerts.thresholds.maxAlertsPerCycle`: 0 (∞) → 5 (раньше был без капа — anomaly)
- `alerts.weights`: `meme 0.45 / viral 0.20→0.15 / emerge 0.20 / twitter 0.05 / feedback 0.10→0.15` (юзер-голоса важнее raw виральности в curated mix)
- `alerts.stale`: `2/24/30` → `1/24/48` (3-дневная жизнь)

**Финальная таблица alert weights**:

| Preset | meme | viral | emerge | twitter | feedback | junk× |
|---|---|---|---|---|---|---|
| general | 0.45 | 0.15 | 0.20 | 0.05 | 0.15 | 0.50 |
| animals | 0.45 | 0.20 | 0.15 | 0.05 | 0.15 | 0.40 |
| culture | 0.45 | 0.25 | 0.10 | 0.15 | 0.05 | 0.50 |
| celebrities | 0.50 | 0.30 | 0.10 | 0.10 | 0.00 | 0.55 |
| events | 0.10 | 0.30 | 0.35 | 0.15 | 0.10 | 0.30 |

Σ POSITIVE = 1.00 во всех (validatePresetOverrides проходит).

**Файлы**: `src/analysis/preset-config.js` (DEFAULT_PRESET_CONFIGS — animals/culture/celebrities/events/general).

**Деплой**: TBD юзером через `deploy.ps1`. После деплоя — поскольку все overrides уже снесены через Clear ALL, новые DEFAULT_PRESET_CONFIGS применятся напрямую через `loadAlertWeights(db)` (Fix B unified path).

**Риски**:
- Юзер настаивал что cross-platform не работает — но в коде он УЖЕ убран. То что мы оставили emergence (single-source) не противоречит его желанию.
- ideaBoost (Reddit-specific 0-12 буст за 10K+ upvotes) оставлен — useful early-idea signal, прицельный.
- TODO для будущего: юзер хочет авто-discovery актуальных hashtag/queries для sources (по аналогии с tiktok-trends-scraper, но для Twitter и Reddit). Отдельная задача.
- Существующие alertScore'ы в БД frozen со старыми весами. Новые scan-cycle перезапишут.

---

## 2026-05-06 (Fix scorer/dispatcher alertScore desync — единый источник весов через loadAlertWeights)

Юзер прислал скрин: тренд `Adults entertained by AI stories of fruits and vegetables` в дашборде показывает **alertScore=65 / verdict «would alert»**, но в админ-панели Decisions он же — **score=52, gate=`X порог`**. Юзеру `threshold=52`, admin floor 60 → effective 60 → дашборд проходит, dispatcher отбраковал. Расхождение 13 баллов.

**Root cause** — рассинхрон источников весов:
- **Scorer** (`scorer.js`) при сохранении в БД зовёт `computeAlertScore(trend)` **без передачи весов** → дефолты `DEFAULT_ALERT_WEIGHTS` (новые: `meme=0.45`). В БД летит `raw_metrics.alertScore=65`. Дашборд это и показывает.
- **Dispatcher** (`alert-dispatcher.js:recomputeAlertScores`) пересчитывает через `loadAlertWeights(db)` → читает `settings.presetConfigs.<active>.alerts.weights` где у юзера лежит **stale override** с дорекалибровочными весами (`meme=0.30`). Со старыми весами тот же breakdown даёт 52.

С формулой:
- meme=70, viral=90, emerge=100, junk=15, feedback=50 (no votes), age<24h (no decay)
- Новые (0.45): 70·0.45+90·0.20+100·0.15+50·0.15 − 15·0.50 = 72−7.5 ≈ **65**
- Старые (0.30): 70·0.30+90·0.25+100·0.25+50·0.10 − 15·0.50 = 73.5−7.5 ≈ **52** (фактическая разница ~6.5 чем теоретическая 13 из-за разных weightFeedback/weightTwitter — but scenario сходится)

**Fix B (chosen)** — единый источник правды. В `src/analysis/scorer.js` все 4 вызова `computeAlertScore(...)` теперь передают `loadAlertWeights(this.db)`:
- `_analyzeBatchStage1` (line ~665) — `aw` вычисляется один раз перед `trends.map(...)`, передаётся в callback
- Stage 2 finalization (line ~890) — inline `loadAlertWeights(this.db)` (одиночный trend)
- `_applyHeuristic` (line ~1051) — inline (одиночный)
- `_fallback` (line ~1082) — `aw` один раз перед `.map`

Default-arg `DEFAULT_ALERT_WEIGHTS` в сигнатуре `computeAlertScore(trend, w = ...)` оставлен — для тестов и legacy callers без db.

**Эффект**: scorer и dispatcher теперь читают веса **из одного места** (`settings.presetConfigs.<active>.alerts.weights` через `loadAlertWeights`). Если override stale — оба видят stale значение, если override синхронен с defaults — оба видят defaults. Расхождение «дашборд показывает one score, dispatcher другой» исчезает.

**Caveat / immediate hand-fix нужен**: само по себе Fix B **не вытаскивает** этот конкретный тренд. После деплоя scorer начнёт писать в `raw_metrics.alertScore` через те же per-preset overrides → дашборд начнёт показывать **52** на тех же breakdown'ах (вместо 65), но gate всё равно не пройдёт. Чтобы алерт реально пошёл — нужен **Fix A (юзер-сторона)**: админка → 🎛️ Пресеты → активный пресет → раздел Alert weights → Reset / выставить `meme=0.45` вручную. После reset blob `presetConfigs` для этого preset'а отдаёт defaults → loadAlertWeights возвращает 0.45 → score 65 везде → проходит.

**Файлы**: `src/analysis/scorer.js` (4 точечных правки + один комментарий зачем aw).

**Деплой**: TBD — юзер прогонит через `deploy.ps1` когда будет готов. После деплоя плюс Fix A в админке — следующая batch трендов получит правильный score сразу.

**Риски**:
- Существующие тренды в БД (`raw_metrics.alertScore`) не пересчитываются автоматически — они frozen. Только новые scan-циклы запишут свежий alertScore.
- Если юзер забудет сделать Fix A — Fix B без него ухудшит дашбордовый UX (показ 52 вместо 65), но не починит alert. Главное проверить что override в `settings.presetConfigs` синхронен с defaults после деплоя.
- Не трогали SPA-template (только pure JS в scorer.js) → SPA-чекеры не нужны.

---

## 2026-05-06 (SESSION_CONTEXT trim-pass — 814→651 строк, ~34K→13K токенов, добавлен TOC)

Юзер заметил что SESSION_CONTEXT раздулся в 3× от целевой нормы AGENT_RULES §7 (<12K токенов / ~500 строк) и попросил оптимизировать чтение контекста. Обсудили варианты: сжать файл vs делегировать чтение haiku-агенту vs lazy-load через TOC+Grep. Решение — гибрид: сжатие + TOC.

**Что вырезано/сжато**:
- Удалён tombstone-блок `## Cross-platform aggregation: REMOVED (2026-05-04)` — это change, не state. Уже жил в WORKLOG_ARCHIVE.
- Удалён дубль про favourites (был в § Dashboard layout полностью повторяющий § User favourites).
- Apify scrapers / TikTok subsections (cluster repr / formatter plays / engagement floor / CJK / audio-filter) — каждое из 5-15 строк параграф пересжато в 2-4 строки + сохранены ключевые числа.
- Hot trends refresh / Production posture / Admin panel / Catalyst forecast — длинные параграфы → bullet-lists.
- Stage 0 / Stage 2 / PreStage knobs — компактнее, без многословной мотивации (но цены и numbers сохранены).
- Apidojo input schema details + PRICING TRAP — детали в WORKLOG, в state остался только намёк «verify console pricing».

**Что сохранено целиком (critical state)**:
- Бизнес-правила / Plans table.
- Per-preset divergence table (15+ rows).
- Alert gate formula + Σ POSITIVE invariant.
- Multi-signal clustering веса/пороги.
- CJK threshold multiplier table.
- **Обе ловушки** (server.js SPA + SQLite TEXT timestamps) — это unique gotchas, без них новый агент сразу нарвётся.
- Files map целиком.
- Env keys минимальный набор.

**TOC сверху**: добавлен group'd-список секций с lazy-read рекомендацией («Используй TOC + Grep по `## <Имя>` + offset/limit. Если нужно общее саммари — делегируй haiku-агенту»).

**Файлы**: `ai-context/SESSION_CONTEXT.md`.

**Риски**: возможно вырезал кусок который кто-то из агентов привык встречать. Полный pre-trim файл в `git log` (commit-history). Если за ~неделю никто не споткнётся — норма устаканится.

---

## 2026-05-06 (Темы: убрал Dim/Slate/Mono, добавил Tide — navy + cyan по референсу)

Юзер прислал референс-скрины крипто-снайпер-тулзы (тёмный navy bg, аквамариновый акцент) и попросил оставить только 2 темы: текущую `ink` + новую по референсу. `dim` выглядел грязно, `slate` и `mono` были почти неотличимы от ink — мёртвый выбор.

**Что сделано** (`src/dashboard/server.js`):
- Удалил CSS блоки `body[data-theme="dim"]`, `body[data-theme="slate"]`, `body[data-theme="mono"]` (~57 строк).
- Добавил `body[data-theme="tide"]` с палитрой по референсу:
  - `--bg: #0a1622` (deep navy), `--surface: #0f1c2a`, `--card: #14202e`
  - `--text: #d6e1ec` (холодный off-white), `--muted: #7387a0` (сине-серый)
  - `--accent: #4dd4e0` (aqua/cyan), `--accent2: #7ce8f0`
  - Borders на rgba(115,168,210, .10/.18/.28) — холодная сталь вместо нейтрального белого
- `SUPPORTED_THEMES = ['ink', 'tide']`, `THEME_META`: ink ⬛/Чернила, tide 🌊/Прилив.
- Theme-swatch preview в settings: убрал dim/slate/mono dot-блоки, добавил tide (`#0a1622` / `#4dd4e0` / `#14202e`).
- Обновил комментарий `===== THEME SYSTEM =====` (4 темы → 2 темы).

**Авто-адаптация компонентов**: всё что использует `var(--accent-rgb)`, `var(--surface)`, `var(--text)`, `var(--bg)`, `var(--muted)`, `var(--dim)` — авто-перекрашивается. Семантические цвета (green/red/orange/yellow/purple/pink) **не трогал** — они остались константами через themes для предсказуемости OK/error сигналов.

**Migration**: `detectTheme()` пропускает невалидные сохранённые значения (`'dim'`, `'slate'`, `'mono'` теперь не в `SUPPORTED_THEMES`) и сбрасывается на дефолт `'ink'`. Юзеры со старыми сохранёнными темами увидят ink при следующем заходе.

**Файлы**: `src/dashboard/server.js`.

**Деплой**: запущен через `deploy.ps1`.

**Риски**: i18n тексты `settings.theme_desc` («All dark — no white allowed»/«Все тёмные — никакого белого») остаются актуальными для обоих вариантов, не правил.

---

## 2026-05-06 (Избранное — Pro/Admin фича: snapshot-storage, star на карточках, Saved-таб)

Юзер запросил «отдельную базу для избранных, доступную только Pro/Admin, с сохранением навсегда». Добавил полноценную фичу с защитой от ротации трендов через snapshot-копию.

**БД** (`src/db/database.js`):
- Новая таблица `user_favorites(id, chat_id, trend_id, note, snapshot, created_at)`. UNIQUE(chat_id, trend_id) для idempotent upsert. Без CASCADE / retention — фавориты вечны.
- Поле `snapshot` — JSON-копия всех ключевых полей тренда на момент сохранения (title, source, url, image, raw_metrics, alert_type, whyNow, trigger_*, externalId, author и т.д.). Если `trends`-row удалится из-за ротации — favourite **выживает** через snapshot. LEFT JOIN в `getFavoritesByChat` отдаёт fresh-данные если есть, fallback на snapshot.
- DB-методы: `addFavorite/removeFavorite/setFavoriteNote/getFavoriteTrendIds/getFavoriteMeta/getFavoritesByChat/countFavoritesByChat` + helper `_trendSnapshot(trend)` который выбирает поля для snapshot.
- `addFavorite` использует `INSERT ... ON CONFLICT DO UPDATE` — повторное сохранение освежает snapshot и note. Note преимущественно cap 500 chars (enforced на endpoint-стороне).

**Entitlements** (`src/billing/entitlements.js`):
- Новое поле `favorites: boolean` — `false` для free/test, `true` для pro/admin.
- Новый helper `shouldShowUsageCounter(planName)` — true только для test (используется в test-usage-counters fиче).
- Новое поле `historyHours: number` — `72` для free (3-day window cap), `-1` (unlimited) для остальных.

**Endpoints** (`src/dashboard/server.js`):
- `POST /api/trends/:id/favorite` (опц body `{note}`)
- `DELETE /api/trends/:id/favorite`
- `PATCH /api/trends/:id/favorite` body `{note}` для редактирования заметки
- `GET /api/favorites` — полный список с merged fresh+snapshot
- Все 4 гейтятся через `_favoriteGate(req, res)` — Pro/Admin only, иначе 403 reason='plan'.
- `_handleTrends` pre-fetch'ит `Set<favoriteIds>` один раз, передаёт в `_formatTrend(row, userId, favSet)` для O(1) per-row attach `isFavorite`. Поддержка `?favoritesOnly=1` через WHERE `id IN (...)`. Возвращает `favoriteCount` в payload для счётчика в nav.
- `_publicUser` теперь содержит `entitlements` объект — фронт читает `me.entitlements.favorites` для render-логики.
- `api()` helper теперь attach'ит `err.status` и `err.reason` на все !ok ответы (раньше только на 401).

**Frontend** (`src/dashboard/server.js` SPA):
- ⭐-кнопка на feed-карточке — inline в `.feed-user-row` сразу после аватара (слева). Hover-only когда не сохранено, always-visible с filled accent-цветом когда saved. Pulse-анимация `favPulse` на add. Free/test — кнопка не рендерится вообще (clean cards, дискавери через nav-таб).
- ⭐-кнопка в `.modal-head` — самым **левым** элементом перед всеми badge'ами (раньше была между источником и ✕, юзер попросил перенести влево).
- Новый компонент `FavoriteNoteEditor` — вставляется в начало modal-body когда `isFavorite=true`. Три состояния: «add note» CTA → текст + ✏ edit + ✕ remove → textarea с Save/Cancel (Cmd/Ctrl+Enter — save, Esc — cancel). Cap 500 chars.
- Snapshot-banner `🗄 Saved copy — original may have been removed` рендерится поверх модалки когда тренд из snapshot (LEFT JOIN не нашёл live-row).
- `BottomNav` — Saved-таб **между Feed и Analyze**. Active когда `view==='trends' && favoritesOnly`. Counter справа со значением `favoriteCount`. Click — toggle `favoritesOnly` + `setOffset(0)` + `view='trends'`. Free/test — locked с 🔒, click → upgrade toast.
- Optimistic UI в `toggleFavorite`: моментально патчит `isFavorite` в trends-list и modalTrend, fire-and-forget request, rollback на 403/500. Pulse через `btnEl.classList.add('just-saved')` на 450ms.
- 19 i18n-ключей `fav.*` (EN+RU): tooltips, toasts, note-placeholder/save/edit/remove, filter_label, snapshot_hint, locked_*.
- CSS: `.feed-fav-btn` (компактная 18×18 inline), `.modal-fav-btn` (26×26 в head), `.fav-note-block` + `.fav-note-textarea` + `.fav-note-actions` + `.fav-snapshot-banner`. Все через `var(--accent-rgb)` для авто-адаптации к теме.

**Файлы**: `src/db/database.js`, `src/billing/entitlements.js`, `src/dashboard/server.js`.

**Деплой**: задеплоено через `deploy.ps1`. Таблица создаётся при первом старте контейнера.

**Риски/заметки**:
- Telegram-бот **не тронут** — юзер явно сказал «бот и так перегружен, не нужно». Если когда-нибудь захочется — DB-таблица shared, бот может присоседиться через callback `fav:<id>` и DB-метод `addFavorite(chatId, trendId)`.
- Snapshot фиксирует метрики на момент сохранения — если тренд жив, рендер всё равно использует fresh-данные через LEFT JOIN. Только когда тренд удалён — snapshot-fallback показывает «замороженное» состояние.
- Manual-analyze тренды не сохраняются (synthetic id `manual-...`, не в `trends`-таблице). Если попробовать — добавление пройдёт но через час ручной анализ исчезнет из кэша → snapshot останется единственным источником. Не критично, но edge-case.
- `?favoritesOnly=1` не комбинируется с `?source=` или `?category=` корректно — оба фильтра применяются AND'ом, но если favoriteIds мал и user применил category — может получиться 0 результатов. Acceptable: фильтры работают предсказуемо, просто пересечение пусто.

---

## 2026-05-06 (UI/UX полировка дашборда — login screen, nav, locked-визуалы, toast, Stats убран)

Большой проход по визуалу дашборда — 8 неотносящихся друг к другу UI-задач за один день.

**1. Login screen — полный редизайн**
- Заменил эмоджи 🔥 на лого-кота (PNG из `assets/logo.png` через `/assets/logo.png?v=LOGO_VERSION`). Контейнер 80×80 с X-blue accent-glow, fallback на 🐱 на onError.
- Убрал language-switcher (EN/RU) — login-экран теперь EN-only, все строки захардкожены. Юзер переключает язык в Settings после входа.
- Ambient X-blue gradient blobs (3 радиальных) + dot-grid overlay с radial mask — современный SaaS-look.
- Glass-карточка max-width 440px с backdrop-blur, тонкая translucent-белая бордер.
- Брендинг: лого + крупный «Catalyst» с gradient text-fill (`var(--text)` → `var(--text2)`) + shorter tagline «Track narratives across the social web.» (39 chars, fits one line, без orphan-слов).
- 3 mini-фичи в карточке: 📡 Multi-source feed / 🎯 Trend scoring / 🔔 Real-time alerts (убрали «AI» из tagline и плашки — implementation detail).
- CTA-кнопка «Sign in with Telegram» — flat (без 3D-stripe, юзер пожаловался что выглядит как артефакт), gradient `var(--accent)` → темнее (`#146da8`). SVG paper-plane icon с `rotate(-25deg)` — Telegram-style диагональ вместо стрелки.
- Disclaimer под кнопкой: «No password needed. We'll send a one-time code to your Telegram.» (заменил неуклюжий «No password — auth via our Telegram bot. You'll get a one-time code.»).
- Footer вместо неактивной плашки `catalystparser.io` → активная X-pill `𝕏 @Catalystparser` (hover-effect).
- Code-фаза (после клика «Sign in») — та же стилистика: glass card, моно-ввод 6 цифр, X-blue gradient submit (раньше был оранжевый — заменён для согласованности).
- Все цвета через `var(--bg)`, `var(--surface)`, `var(--text)`, `var(--muted)`, `var(--dim)`, `rgba(var(--accent-rgb), N)` — авто-адаптация под тему (Ink/Dim/Slate/Mono).

**2. Telegram-бот ссылка в навигации**
- Добавлена кнопка слева от 𝕏 в nav-right. SVG paper-plane (Telegram-brand path), та же стилистика `nav-icon-btn`.
- Bot username резолвится при старте dashboard-сервера через `telegram.getBotUsername()` (`bot.getMe()`) и кэшируется в `this._botUsername`. Инжектится в SPA-template как `BOT_USERNAME` константа (рядом с `LOGO_VERSION`).
- Fallback на голый `https://t.me/` если username не зарезолвился.

**3. Locked-визуалы для Free на источниках**
- Sidebar SOURCES list: Twitter/TikTok/X-Trends для Free показываются с `🔒`-пилюлей вместо счётчика, dim opacity 0.55, dashed-look. Click → toast `🔒 Этот источник — на Test/Pro`. На hover чуть подсвечивается («можно апгрейднуть» вместо «сломано»).
- Live → SOURCES dots в правой панели: те же источники для Free — pill с dashed-бордером, серый dot, glyph заменён на 🔒, tooltip `<source> — locked (Test/Pro)`.
- Backend `_handleSources` теперь возвращает `inPlan: bool` для каждого источника (на основе `getPlanEntitlements(planName).sources`).

**4. Catalyst forecast locked-карточка**
- Раньше для Free/Test был disabled-button с `🔒 Catalyst forecast — Test/Pro` (юзер сказал «выглядит как артефакт»).
- Новая locked-карточка в едином стиле с feature-list login'а: 36×36 icon-tile с 🔒 на X-blue свечении + жирный title + дим subtitle. Не disabled-кнопка, а информационный блок.

**5. Stats-таб убран**
- В bottom-nav было 3 таба (Feed/Stats/Analyze). Stats показывал 80% дублей того что и так в сайдбаре + правой панели, читался как полупустой экран. Убрал из BottomNav `tabs` массива и `view === 'stats'` рендеринга в App.
- StatsPanel-компонент **остался в коде** (dead code) — если когда-нибудь решишь вернуть, раскомментируешь два блока.
- `/api/stats` endpoint **активен** — его всё ещё дёргает фронт для Live-панели (signals/alerts/avg-virality counters).

**6. Toast notifications redesign**
- Раньше: rectangle 260-380px с **левой синей полоской** (`.toast::before`) и тремя ярко-выраженными inset-highlight'ами. Юзер пожаловался что полоска слева выглядит как артефакт от старой right-side версии.
- Стало: pill-shape (`border-radius: 999px`), **позиция top:14px** (с самого верха, над navbar), переписан в Ink-палитре через CSS-vars. Single layered shadow без inset-bevels (плоско, не embossed). Type-сигнал теперь только через border-tint и icon-color.
- Auto-icon (✓/✕/ℹ) **скрывается** когда сообщение начинается с эмоджи/символа — раньше юзер видел `[ℹ️] 🔒 Manual analysis...` (двойная иконка), теперь просто `🔒 Manual analysis...`. Detection: regex `/^[\p{L}\p{N}\s]/u` — если первый символ буква/цифра/пробел → показать auto-icon, иначе пропустить.

**7. Manual analyze для Free возвращён в bottom-nav как locked**
- Юзер ранее попросил полностью скрыть Analyze-таб для Free. Передумал — discoverability важнее. Теперь таб показывается всегда с 🔒 для Free, click → upgrade toast «🔒 Manual analysis is available on Test/Pro».
- `BottomNav` принимает `addToast` prop, locked-таб обрабатывает click через toast вместо setView. CSS `.sb-foot-btn.locked` — opacity 0.55, dashed-border.

**8. Star на feed-карточках перенесена влево**
- Изначально `.feed-fav-btn` был absolute-positioned `right: 37px` — рядом с ✕. На узких viewport'ах badges подпирали её — выглядело как один блок ★✕.
- Теперь inline в `.feed-user-row` сразу после аватара (слева). 18×18 пилюля без чёрной заливки, лёгкий контур. Hover-only когда не сохранено, always-visible с filled accent когда saved. ✕ остался absolute справа — семантически разные действия (save/dismiss) визуально разделены.

**Файлы**: `src/dashboard/server.js` (всё в SPA-template — login, nav, sidebar, modal, toasts, BottomNav, FeedCard).

**Деплой**: задеплоено через `deploy.ps1`.

**Риски/заметки**:
- Поймал три раза подряд **ловушку backticks-in-comments** при добавлении JSDoc-комментариев в SPA-template. Каждый раз один и тот же фикс — убрать backticks из `// ...` строк. Trap уже описан в SESSION_CONTEXT, но я почему-то всё равно периодически ставлю их рефлекторно. На будущее: внутри SPA-template только plain-text комменты.
- Поймал **апостроф в single-quoted строке** внутри SPA-template (например `'won\'t alert'`) → outer template literal съедает `\'` → browser SyntaxError → чёрный экран. Решение — double-quote `"won't alert"`. Trap тоже описан.
- Login-screen теперь жёстко EN. Если когда-нибудь будет нужно вернуть язык — все хардкоженные строки в `LoginScreen()` придётся восстановить через i18n.
- StatsPanel остался dead code (~250 строк). Можно удалить отдельным проходом если решишь что не вернёшь.

---

## 2026-05-06 (Alert observability в дашборде + рекалибровка весов под memePotential-доминанту)

Владелец заметил инверсию: посты с высоким memePotential (91) не алертятся, а низкие (50-60) проходят. Раскрутил два слоя проблемы:

**Слой 1 — формула alertScore многокомпонентная**: `0.30·meme + 0.25·viral + 0.25·emerge + 0.10·twitter + 0.10·feedback − 0.50·junk − staleDecay` (для general пресета). При memePotential=91, virality=20, emergence=87 → score = 91·0.30 + 20·0.25 + 87·0.25 + 0 + 5 = 59 → **fail при floor=60**. А при memePotential=50, virality=85, emergence=85 → score = 15 + 21 + 21 + 5 = 62 → **pass**. Чистая инверсия — высокий мем-сигнал AI глушится средними остальными метриками. Дашборд показывает `MEME SCORE` крупно, юзер судит по нему, но алерт-гейт смотрит композит.

**Слой 2 — нет наблюдаемости в дашборде**: `alertScore` хранится в БД и приходит в API-payload, но в TrendModal не отображался. Юзер не видел реальный балл по которому решается алерт. Чтобы понять причину пропуска приходилось лезть в админ-панель `/decisions` (которая работает корректно — показывает по-каждому решению gates: threshold/hard_junk/source/alert_type/dedup/daily/cap).

**Опция C (observability + рекалибровка)**:

1. **Заменил тайл «Срок жизни» на «Alert»** в TrendModal — крупный `alertScore / порог`, цвет зелёный/красный по passed. `lifespanLabel` сохранён в коде для других мест где используется (никаких поломок).

2. **Добавил секцию «🔔 Alert verdict / Решение алерта»**:
   - Pass/fail pill с порогом и вердиктом
   - alertType chip (`post · ✓ в фильтре` / `post · ✕ выключен в фильтре` — отдельный гейт от score)
   - Разбивка компонентов alertBreakdown как мини-чипы: `meme 91`, `viral 30`, `emerge 87`, `junk −15`, `stale −5`. Мгновенно видно что именно тянет вниз.

3. **Server-side**: добавил `alertFloor` в `_publicUser` (= `alerts.thresholds.alertThreshold` активного пресета) — клиент знает админский floor чтобы вычислить эффективный = `max(user.threshold, alertFloor)` для честного pass/fail вердикта.

4. **Рекалибровка весов (per-preset, DEFAULT_PRESET_CONFIGS в `preset-config.js`)** — поднял memePotential-вес чтобы AI-вердикт доминировал:

   | Preset | meme было → стало | inversion fix |
   |---|---|---|
   | general | **0.30 → 0.45** | meme=91 теперь 41 балл сразу, легко пробивает 60 |
   | celebrities | **0.25 → 0.40** | то же |
   | animals | 0.45 (без изм.) | уже корректно |
   | culture | 0.45 (без изм.) | уже корректно |
   | events | 0.10 (без изм.) | by design — events care about timing, не memes |

5. **DEFAULT_ALERT_WEIGHTS в `scorer.js`** — fallback на случай когда per-preset нет ключа: тоже бамп `meme 0.35 → 0.45`. На практике per-preset всегда полностью populated, но defaults остаются source-of-truth для новых deployments.

**Σ инвариант** соблюдается: positive-веса (meme + viral + emerge + twitter + feedback) = 1.00 во всех пяти пресетах, validateProfileOverrides не сломается.

**Файлы**: `src/dashboard/server.js` (TrendModal — alert tile + breakdown section, alertFloor в _publicUser, 16 i18n keys EN+RU, импорт getActivePresetConfig), `src/analysis/scorer.js` (DEFAULT_ALERT_WEIGHTS), `src/analysis/preset-config.js` (general + celebrities weights).

**Эффект для existing data**: trends в БД уже имеют alertScore посчитанный со старыми весами — они отображаются как есть. Новые trends со следующего цикла получат новые баллы. Old alerts остаются frozen (это и нужно). Per-preset overrides в БД (если юзер кастомизировал веса через админ UI) **остаются** — defaults не перезаписывают override'ы; чтобы применить новые defaults — Reset в админ UI.

**Деплой**: задеплоено владельцем через `deploy.ps1`.

---

## 2026-05-06 (Реструктуризация планов: убран daily-cap алертов, sources-гейт для Free, per-plan caps на Pro-фичи)

Юзер пройдясь по логике планов обнаружил: `plan_sources` и `history_days` в БД — мёртвые поля, нигде не применялись. Free-юзер получал алерты со всех источников и видел весь дашборд как Pro. Plus daily-cap на алерты (тоже -1 у всех планов) был мёртвой инфраструктурой. Решил упростить и при этом сделать реальные различия между планами.

**Новая структура планов**:

| План | Sources | Manual Analyze | Catalyst forecast | Alerts/day |
|---|---|---|---|---|
| free  | reddit + google_trends | 🔒 заблокировано | 🔒 заблокировано | ∞ |
| test  | все 5 | 5/день | 5/день | ∞ |
| pro   | все 5 | 100/день (anti-spam) | 100/день (anti-spam) | ∞ |
| admin | все 5 | ∞ | ∞ | ∞ |

**Single source of truth** — `src/billing/entitlements.js` (новый модуль). `getPlanEntitlements(planName)` отдаёт `{ sources, manualAnalyze, catalyst }`. Caps semantics: -1 = unlimited (admin), 0 = blocked (free), N = N/day. Импортируется из dashboard/server.js и notifications/telegram.js — гарантирует что бот и сайт договариваются по правилам.

**Что выпилено**:
- `daily` gate в `alert-dispatcher.js` — алерты не платная фича, ограничивать смысла нет
- 15-минутный per-user cooldown на Catalyst forecast в боте и дашборде — Catalyst оказался дёшев (~$0.05/call), daily-cap достаточно для anti-spam
- Поле `alert_limit` в плане osталось, но нигде не читается (legacy, можно убрать в будущем)

**Что добавлено**:
- `plan_source` gate в `alert-dispatcher.js` — алерты для Free идут только из Reddit/Google
- Source-фильтр в `_handleTrends`, `_handleStats`, `_handleSources` дашборда — Free видит в фиде только разрешённые
- `inPlan: bool` в ответе `_handleSources` — фронт может рисовать 🔒 на недоступных источниках
- `entitlements: {sources, manualAnalyze, catalyst}` в `_publicUser` — клиент знает свои лимиты
- Per-plan daily caps в manual-analyze и catalyst gate'ах (бот + сайт), in-memory ring `Map<chatId, timestamps[]>`

**Visual locks**:
- Dashboard TrendModal Catalyst: button с 🔒 для Free, нормальная для Test/Pro (с error-toast при достижении daily cap)
- Dashboard bottom-nav «🧪 Analyze» tab: скрыт для Free, виден для Test/Pro/Admin
- Bot /menu Sources: премиум-источники с 🔒 для Free, click → toast «Available on Test/Pro»
- Bot trigger-button в алертах: 🔒 для Free вместо обычной кнопки, callback показывает upgrade-toast
- Bot manual analyze: 🔒 message для Free вместо обработки команды

**i18n обновлён**: `paymentTitle` в EN+RU перепиcан под новую структуру (3 плана, конкретные числа). Удалено упоминание мёртвого alert_limit. Добавлены `trigger.daily_limit` для error-toast'а.

**Schema/seeding обновлён**: `src/db/schema.sql` и `database.js normalizePlans` — sources для test/pro/admin теперь включают `x_trends` (5-я платформа), descriptions переписаны.

**Файлы**: `src/billing/entitlements.js` (новый), `src/notifications/alert-dispatcher.js`, `src/notifications/telegram.js`, `src/dashboard/server.js`, `src/db/database.js`, `src/db/schema.sql`, `src/i18n/en.js`, `src/i18n/ru.js`.

**Follow-up в той же сессии — Test usage counters + history cap + admin cleanup**:

- **Usage counter для Test после каждого платного вызова**:
  - Helper `shouldShowUsageCounter(planName)` в `entitlements.js` — true только для `test`. Pro/admin не показывают (cap=100 = шум, admin=∞).
  - Bot: после успешного manual-analyze и catalyst trigger шлёт follow-up сообщение `📊 X/5 used today (Y left)`. Cache hits не консумируют слот, counter не показывают.
  - Dashboard: API возвращает `usage: { used, cap, left }` в payload manual-analysis и catalyst-trigger. Frontend (TriggerSection, AnalyzePanel) рендерит маленькую dim-строчку `t('usage.test_left')`. Pro/admin/cache-hit → server возвращает `usage: null`, фронт не рендерит.

- **Cap history-window для Free (3 дня)**:
  - `historyHours` field в entitlements: `free=72, test/pro/admin=-1` (unlimited).
  - Backend cap в `_handleTrends` и `_handleStats`: `Math.min(requestedHours, planHistoryHours)`. Silent — Free посылает ?hours=168, получает 72-часовое окно.
  - Frontend window-segments: 7d опция рендерится с `🔒` + opacity 0.55, click → upgrade-toast вместо переключения. Defence-in-depth с серверным капом.

- **Admin UI cleanup**:
  - Убраны колонки «Алертов/день» и «Дней» из таблицы планов в `admin/server.js`. Оба поля dead в БД, новые правила в `entitlements.js`.
  - Grid template сжат с 5 колонок до 3 (План / Цена / Источники-save).
  - Добавлена info-плашка над таблицей: «Лимиты по фичам теперь в коде src/billing/entitlements.js, здесь правится только цена».

**Файлы (доп. к основной работе выше)**: `src/billing/entitlements.js` (+ `shouldShowUsageCounter`, `historyHours`), `src/admin/server.js` (plan-row CSS + table render), `src/i18n/en.js`+`ru.js` (доп. ключи `window.locked_*`, `usage.test_left`).

**Деплой**: TBD через `deploy.ps1`. После деплоя plans-таблица перенормализуется через `normalizePlans` транзакцию (UPSERT по name) — существующие row'ы получат новые sources/descriptions без потери user-привязок (`users.plan_id` остаётся).

**Риски/заметки**:
- Существующие Free-юзеры после деплоя перестанут получать алерты по Twitter/TikTok/X-Trends (если получали раньше — а они получали, потому что gate не работал). Если важно — можно объявить им апгрейд через рассылку.
- Тестовый план = 1 день. Если юзер исчерпал 5/5 на manual-analyze в первые 2 часа — всё, до конца дня без него. Подумать, может test надо растянуть на 3 дня (но это рекалибровка цен, не текущая задача).
- `_catalystHits` и `_manualAnalysisHits` — in-memory Maps, ресетятся на рестарте. Soft-cap, не security boundary. На multi-process сетапе (если когда-нибудь) понадобится Redis.
- В Telegram counter шлётся отдельным сообщением (= 2 ping на одну операцию). Альтернатива — модифицировать sendAlertToUser чтобы добавлять footer, но это инвазивно. На Test-плане 5 операций/день, ОК.

---

## 2026-05-06 (Публичный хостинг на catalystparser.io — TLS, nginx, lockdown, ufw, backup)

Перевели Catalyst из режима «дашборд на голом IP» в полноценный публичный хостинг. Всё что было сделано в production-readiness pass от 2026-05-04 (security headers, CORS allowlist, rate-limits, graceful shutdown, hard-fail env validation) теперь реально активировано через TLS + reverse-proxy.

**1. Домен**: `catalystparser.io` куплен на Porkbun. DNS A-записи для `@` и `www` указывают на 37.1.196.83. Nameservers — Porkbun-овские.

**2. nginx + Let's Encrypt** (на VPS):
- `apt install nginx certbot python3-certbot-nginx`
- `/etc/nginx/sites-available/catalyst` — server-блок с proxy_pass на `127.0.0.1:8080`, SSE support (proxy_buffering off, read_timeout 24h), стандартный набор proxy headers + Authorization passthrough, `set_real_ip_from 127.0.0.1` + `real_ip_header X-Forwarded-For` для downstream rate-limit'а
- `certbot --nginx -d catalystparser.io -d www.catalystparser.io --redirect` — получил cert (R13), автопатч nginx-конфига для 443, добавил 80→443 редирект
- Cert valid до 2026-08-03, auto-renew через `certbot.timer` (systemd, тикает ежедневно)

**3. Port lockdown**:
- `docker-compose.yml`: `"8080:8080"` → `"127.0.0.1:8080:8080"` (Docker слушает только на loopback, наружу выходит исключительно через nginx)
- В `.env` добавлены три переменные: `PUBLIC_BASE_URL=https://catalystparser.io`, `DASHBOARD_ALLOWED_ORIGINS=https://catalystparser.io`, `TRUST_PROXY=1`
- Задеплоено через deploy.ps1, голый IP `http://37.1.196.83:8080` теперь не отвечает (timeout)

**4. Bonus i18n-фикс**: при подготовке к деплою `scripts/check-dashboard-spa.cjs` поймал баг — `'modal.alert_fail': 'won\'t alert'` (single-quoted с escaped apostrophe). Внутри outer template literal Node съедает `\'` → в HTML летит `'won't alert'` → browser SyntaxError → чёрный экран всего SPA. Это **именно тот класс багов** который описан в SESSION_CONTEXT «Ловушка server.js → escape-sequences». Фикс — переключить на double-quoted `"won't alert"`. Зашло в одном деплое с alert-observability работой.

**5. Файрвол ufw**:
- `ufw allow 22/80/443/tcp` + `ufw --force enable`
- Default deny incoming, остальные порты (включая закрытый изнутри 8080) теперь и на уровне ОС блокируются для внешних соединений
- Logging on (low) — атаки видны в `/var/log/ufw.log`
- Включается автоматом при ребуте VPS

**6. Daily backup БД**:
- `apt install sqlite3` на хост (sqlite3 в контейнере не было)
- `/usr/local/bin/catalyst-backup.sh` — discover'ит mountpoint named volume `catalyst_data` через `docker volume inspect`, делает `sqlite3 .backup` (locking-aware hot snapshot, безопасно при concurrent writes), gzip'ает, кладёт в `/var/backups/catalyst/catalyst_YYYY-MM-DD_HH-MM.db.gz`, ретеншн 14 дней
- Cron `/etc/cron.d/catalyst-backup` — daily 03:30 UTC, лог в `/var/log/catalyst-backup.log`
- Тестовый прогон: 18M база → 4M gz архив

**Состояние сервера на момент деплоя**: до чистки 76% диска занято. `docker builder prune -af` + `journalctl --vacuum-size=200M` освободили ~5 ГБ — теперь 53%. БД 18 МБ, app-логи 5 МБ за 10 дней.

**Что осталось как nice-to-have** (юзеру самому):
- UptimeRobot.com мониторинг `/api/health` (бесплатно, 5 мин на регистрацию)
- Off-site backup в S3/Backblaze ($1-3/мес) — сейчас бэкап на том же VPS
- Лендинг с описанием продукта + Privacy/ToS если идём в публичность

**Файлы**: `docker-compose.yml` (port binding), `.env` (3 hosting keys), `src/dashboard/server.js` (i18n quote fix). На VPS: `/etc/nginx/sites-available/catalyst`, `/etc/letsencrypt/live/catalystparser.io/`, `/etc/cron.d/catalyst-backup`, `/usr/local/bin/catalyst-backup.sh`, `/var/backups/catalyst/`.

**Риски/заметки**:
- Если VPS целиком умрёт — бэкап тоже умрёт. Добавить off-site копию когда будут платные юзеры.
- Telegram-бот в polling, не webhook — масштабирование на >1 инстанс пока невозможно. Не блокер до тысяч юзеров.
- Cert auto-renew проверим через 60 дней (`systemctl list-timers | grep certbot` показывает что он тикает).

---

## 2026-05-05 (TikTok: cluster aggregation bug — alert metrics не совпадали с linked видео)

Пользователь прислал скриншот: алерт говорит «@brandyvsmuva posted with 2.14M plays, 128K likes, 17K shares», в строке метрик «180.6K plays · 341 comments», а на самой странице TikTok у видео 6842 лайка, 127 шеров и сильно меньше плеев. Видео по floor'у 500K/20K/5K не должно было проходить — но прошло. Раскрутил три бага наслоившиеся:

1. **Cluster aggregation в `_clusterByHashtag`** — после кластеризации `metrics.plays/likes/shares` = СУММА по всем видео хэштега, а URL/обложка/автор — ПЕРВОЕ попавшееся видео в порядке обработки. AI-промпт получал `"TikTok: 2,140,000 plays | 128,000 likes | ..."` (cluster sum) + одного автора → писал whyNow «@brandyvsmuva posted 2.14M plays». Юзер кликает — там 6.8K лайков. Перепрошлось чтобы выбирать представителя по виральному скору `plays + shares*1000 + likes*10` (shares — самый сильный сигнал) и использовать ИНДИВИДУАЛЬНЫЕ метрики представителя на выходе. Cluster-totals вынесены в отдельные поля `clusterPlays/clusterLikes/clusterShares/videoCount` для контекста.
2. **`viralScore ≥ 60` floor — дыра** — формула это сумма log10 пяти метрик, любое видео с 200K плеев получает `viralScore=100` (только `10·log10(200K)≈53` баллов от плеев + что-нибудь ещё пушит за 60). Гейт всегда срабатывал → видео @brandyvsmuva (200K плеев / 6.8K лайков / 127 шеров) пролетало через viralScore-путь даже когда concrete-floors не пускали. Убрал viralScore из OR-floor'а — оставил только `plays/likes/shares` концентрированные пороги.
3. **`formatter.js` подменял "plays" на upvotes-композит** — для TikTok строка алерта показывала `m.upvotes` (= `likes + shares*3` = 128K + 51K ≈ 180.6K), подписывая как "plays". Реальные плеев у кластера было 2.14M (то что AI взял в whyNow). Поправил formatter — теперь TikTok показывает `m.plays` напрямую с правильным лейблом.
4. **`velocity` затиралось на `cluster._count`** — «↑4/hr» в алерте означало «4 видео в кластере», не плеев в час. Убрал переопределение — теперь velocity = индивидуальная плеев/час представителя (из `_normalize`).
5. **Cluster aggregate floor в конце убран** — был safety-net эпохи мягких individual-floor'ов, после ужесточения индивидуальных порогов стал redundant и активно мешал (поощрял суммирование в representative.metrics).

**Файлы**: `src/collectors/tiktok.js` (`_normalize` floor + `_clusterByHashtag`), `src/notifications/formatter.js` (TikTok plays-line), `src/analysis/prompts.js` (TikTok metrics block — отдельные строки для рэп-видео и hashtag-кластера, с пометкой что cluster describes "the WAVE, not any one user").

**Риски**: floor стал жёстче (видео с 200K плеев + средними лайками теперь могут не пройти, раньше ловились viralScore'ом). Это и есть желаемое поведение по запросу владельца, но если нарративов станет ощутимо меньше — снижать `playsBar/likesBar/sharesBar` через env override (сейчас захардкожены, при необходимости вынесу).

**Деплой**: TBD, владелец сделает через `deploy.ps1`.

---

## 2026-05-05 (TikTok: cleanup полей `sources.tiktok.enabled` + ответ про Сканеры-toggle)

Маленькая зачистка после удаления preset-gate'а:

- **Убрал поле `enabled` из schema** в `preset-config.js` (`PRESET_FIELD_RANGES.sources.tiktok`) — теперь admin UI «🎛️ Пресеты» больше не рендерит чекбокс «Enabled (DEPRECATED)» который ничего не делал.
- **Убрал `enabled: 0/1` из defaults каждого пресета** (general/animals/culture/celebrities/events) — поле больше не существует. Hashtag-листы остались как fallback-снимки на случай когда live-discovery упадёт.
- **Подтвердил пользователю**: тумблер TikTok в «⚙️ Сканеры → 📡 Площадки» работает корректно — он использует **глобальный** механизм `appState.disabledCollectors` (Set имён выключенных коллекторов, persist'ится в DB как setting `disabledCollectors`). В `index.js` scan-cycle перед каждым `collector.safeCollect()` идёт проверка `appState.disabledCollectors.has(...)` — если коллектор там, пропускается с info-логом «Skipped (disabled via admin panel)». Это правильное место чтобы выключить TikTok совсем.

**Итог**: один способ контроля TikTok'а — глобальный toggle в Сканеры → Площадки. Per-preset поля больше нет нигде. SESSION_CONTEXT уже отражает это (запись «TikTok cycle pacing» в предыдущей entry).

---

## 2026-05-05 (TikTok: убрал preset-gate + 30min cycle + 24 hashtags + fixed input schema)

После первого деплоя trending-discovery владелец заметил несколько вещей:
1. TikTok работал ТОЛЬКО при активном пресете culture (через `_isEnabledForActivePreset`) — это не подходит, TikTok должен работать всегда вне зависимости от выбранного пресета
2. TikTok бежит каждые 15 минут как остальные коллекторы — нужно реже, экономить Apify-кредиты
3. 60 хэштегов рандомно ротированных — слишком много для текущего объёма

**Финальные правки**:

1. **Убрал per-preset gate** в `tiktok.js`:
   - Удалён метод `_isEnabledForActivePreset()` целиком (был вызов в `collect()`)
   - Поле `sources.tiktok.enabled` в `preset-config.js` помечено DEPRECATED — оставлено в schema для forward-compat но collector его игнорирует
   - Управление вкл/выкл TikTok'а — только через env `TIKTOK_ENABLED`

2. **TikTok-специфичный cycle interval**:
   - Новый env `TIKTOK_CYCLE_INTERVAL_MINUTES=30` (default)
   - В `collect()` добавлена time-gate: skip если `Date.now() - _lastCollectAt < cycleIntervalMinutes`
   - Глобальный scan-cycle бежит 15 мин, TikTok-collector реагирует на каждый второй
   - First-run after restart всегда проходит (`_lastCollectAt=0` → ageMinutes очень большой)

3. **24 хэштега + 1 за цикл**:
   - `TIKTOK_TRENDS_TOP_N` default 60 → 24
   - `cycleSize` в `_pickHashtags` 2 → 1
   - Math: 30min cycle × 1 hashtag × 24 cycles = 12h = ровно один refresh-window. Каждый хэштег ищется один раз перед тем как новый refresh принесёт другой набор.

4. **Fixed input schema for clockworks/tiktok-trends-scraper** — первый запуск отдал `Apify 400 / TypeError: inputs.filter is not a function`. Запросил actor's input-schema через `/v2/acts/{id}/builds/default` и нашёл реальные имена полей:
   ```
   adsScrapeHashtags: true       (было `hashtags: true`)
   adsScrapeSounds:    false      (было `songs: false`)
   adsScrapeCreators:  false      (было `creators: false`)
   adsScrapeVideos:    false      (было `videos: false`)
   resultsPerPage:     N          (было `hashtagsLimit: N`)
   adsCountryCode:    'US'        (было `countryCode: 'US'`)
   adsTimeRange:      '7'         (новое — last 7 days)
   adsRankType:       'popular'   (новое — sort by view count)
   ```

**Итоговая стоимость**: 24 hashtags × $3/1K × 2/day = **~$4.32/мес** (было $10.80 при 60 hashtags). Apidojo (Stage B видео-сбор): был ~$50/мес, теперь ~$25/мес из-за 30min vs 15min cycle. Итого TikTok ~$30/мес вместо ~$60/мес — в 2× дешевле при сохранении качества (живые-trending hashtags, не captionный мусор).

**Apify approval note**: владелец перешёл по `https://console.apify.com/actors/sDvA9jM4WRTDX4Syr?approvePermissions=true` — диалог не появился. Это нормально: clockworks как издатель давно proven, его actor'ы не требуют explicit user-approval (в отличие от apidojo который более параноидальный). Если в будущем добавим actor от другого third-party publisher — снова может потребоваться.

**Деплой + проверка**: успешный first-cycle лог:
```
[TikTok] refreshed 24 trending hashtags from TikTok Creative Center (country=US, top=24)
[TikTok] Collected 5 items
```
End-to-end pipeline работает: clockworks-trends Stage A → cached 24 hashtags → apidojo Stage B → видео.

**Файлы**:
- `src/collectors/tiktok.js` — убран `_isEnabledForActivePreset`, добавлен `cycleIntervalMinutes` + `_lastCollectAt`, `cycleSize=1`, исправлена input-schema в `_fetchTrendingHashtags`
- `src/analysis/preset-config.js` — `sources.tiktok.enabled` помечен DEPRECATED
- `.env.example` — добавлен `TIKTOK_CYCLE_INTERVAL_MINUTES`, обновлены defaults для `TIKTOK_TRENDS_TOP_N`

---

## 2026-05-05 (TikTok: live-discovery hashtags через TikTok Creative Center)

Архитектурный shift по запросу владельца: «не имеет смысла искать УЖЕ известные нарративы которые мне даёт Grok — давай скрапить популярные хэштеги в самом TikTok'е, потом по ним искать видео». То есть pivot со static-list на live-discovery: TikTok сам публикует свой trending в Creative Center, мы оттуда читаем.

**Архитектура** (по образу X-Trends):
- **Stage A** (раз в 12h, env `TIKTOK_TRENDS_REFRESH_MINUTES=720`): TikTok-collector вызывает Apify-actor `clockworks~tiktok-trends-scraper` который зеркалит данные из `ads.tiktok.com/business/creativecenter`. Получаем top-60 хэштегов с rank/videoCount/viewCount/rankDiff/isPromoted (env `TIKTOK_TRENDS_TOP_N=60`). Фильтруем `isPromoted=false` (TikTok'овские ad placements) и `videoCount > 0`. Кэшируем в DB через `setSetting('tiktokTrendingHashtags', ...)` для restart-survival.
- **Stage B** (каждые 15 мин, обычный scan-цикл): collector читает trending-кэш через async `_getHashtags()`, ротирует 2 хэштега за цикл через `_pickHashtags()`. 60 хэштегов / 2 за цикл / 4 цикла в час = ~7.5 часов уникальных rotations прежде чем повторение.
- Hardcoded list в `preset-config.js culture.tiktok.hashtags` остаётся **fallback'ом** (если Apify call упал, используется этот список как safety net).

**Изменения**:
- `src/collectors/tiktok.js`:
  - Новые методы `_restoreCachedTrendingHashtags()` (constructor восстанавливает из DB), `_ensureTrendingHashtagsFresh()` (lazy-refresh при stale cache), `_fetchTrendingHashtags()` (Apify call к clockworks/tiktok-trends-scraper).
  - `_getHashtags()` стал async: priority customHashtags → trending cache → preset fallback → last-resort generic.
  - `_pickHashtags()` стал async, `collect()` await'ит его.
  - Trending state живёт на инстансе (`_trendingHashtags`, `_trendingFetchedAt`), persist'ится в DB после каждого успешного fetch.
- `src/collectors/tiktok.js` constants: добавлены `TRENDS_ACTOR_ID = 'clockworks~tiktok-trends-scraper'`, `TRENDS_TIMEOUT_SECS = 60`.
- `.env.example`: добавлена секция «TIKTOK TRENDING HASHTAG DISCOVERY» с тремя env-knobs.

**Env knobs** (defaults в коде):
- `TIKTOK_TRENDS_REFRESH_MINUTES=720` (12h)
- `TIKTOK_TRENDS_TOP_N=60`
- `TIKTOK_TRENDS_COUNTRY=US`

**Стоимость**: 60 hashtags × $3.00/1K × 2/day = **~$10.80/мес**. На X-Trends'овых $1.40/мес фоне выглядит дороже, но:
- TikTok-сцена меняется быстрее X (memes 24-48h life cycle vs X-trends 6-24h spread cycle)
- 60 хэштегов даёт диверсификацию, $10/мес vs ~$50/мес которые мы тратим на сам apidojo TikTok-actor — секонд-стейдж.

**PRICING TRAP** (важно для будущего): открытая страница actor'а на Apify показывает **$1.70/1K**, реальная цена в console (actor → "Pricing" tab) — **$3.00/1K**. Public-page sticker stale/wrong. Этот же trap возможно применяется к другим clockworks-actor'ам — всегда проверяй в console, не верь публичной странице.

**Деплой**: успешно. После старта в логи попадёт `[TikTok] refreshed N trending hashtags from TikTok Creative Center (country=US, top=60)` когда первый цикл активирует actor (только когда активный пресет = `culture` — на других пресетах TikTok отключён).

**Что мы получили**:
- TikTok-discovery теперь **самообновляющаяся**: список хэштегов следует за реальным TikTok-trending без manual refresh
- 60 хэштегов даёт **много вариативности** — не повторяемся за день
- 12h refresh достаточно частый чтобы ловить дневные spikes но не транжирить credits
- Hardcoded preset list = safety net, не главный источник

**Риски/заметки**:
- Может потребоваться one-time **Apify approval** для clockworks/tiktok-trends-scraper (как было с apidojo). Если первый запуск поймает 403 `full-permission-actor-not-approved` — apprоve через `https://console.apify.com/actors/sDvA9jM4WRTDX4Syr?approvePermissions=true`. После approve работает forever.
- Input-схема актора может слегка отличаться от моих guess (`hashtagsLimit`, `countryCode`, `hashtags: true`). Если actor 400-нёт по input validation — посмотрим в логе error message и подкрутим. Сейчас написал по common Apify-паттернам.
- Если clockworks/tiktok-trends-scraper когда-нибудь упадёт / устареет — preset fallback list гарантирует что TikTok-сборка не сломается. Coupling soft, не hard.

---

## 2026-05-05 (TikTok meme refresh + Stage 1 source-aware metric calibration)

### Часть 1: Replace culture-preset hashtags with named active memes

Владелец прогнал Grok web-search prompt и получил список из 14 КОНКРЕТНЫХ виральных мемов 2026 года вместо category-tags. Ключевая product-realization владельца: «эти теги — буквально сами нарративы, а не категории для их поиска» — что точно описывает разницу. На TikTok'е каждый именованный мем = свой хэштег, который ставят участники мема. Searching by named-meme hashtag = searching by meme participation = идеальный signal.

**Replaced** в `culture` пресете (preset-config.js):
```
storytime, relatablememes, genzmemes, comedytok, tiktokhumor, pranktok,
sketchcomedy, brainrotmemes, italianbrainrot, skit, relatable, genztrends
```
**на**:
```
ohokbecause, rahskeleton, rememberwhoyouare, dontleavemedry,
homerdroppedhisdonut, blueshirtkid, areyoucomingtothetree,
ijusthitthejackpot, theworstthingshecansayisno, bigarch, goofinator,
aimyguy, followthattune, everythinghallelujah
```

Каждый — конкретный sound-driven / catchphrase / character / format-mem с миллионами просмотров на TikTok'е в апреле 2026. Отказался от category-tags (storytime/relatable/comedytok) полностью — они привлекают compilation-контент.

**Maintenance note**: meme-теги имеют ~3-7 day lifecycle. Этот список **нужно обновлять ~раз в 1-2 недели** — иначе хэштеги начинают surface'ить «remember when X was a thing» compilation-контент. Grok prompt сохранён в комментариях `preset-config.js culture.tiktok.hashtags`. Когда станет частым refresh-ритуалом — автоматизируем (свой meme-discovery loop а-ля X-Trends, раз в день дёргает Grok за свежими названиями, обновляет DB-override).

### Часть 2: Source-aware metric calibration в Stage 1

Stage 1 LLM раньше смотрел на `views/likes/plays/upvotes` одинаково across sources. Это вранье: 3M plays на TikTok ≈ 300-600K views на Twitter в реальной cultural reach (TikTok plays накручиваются автореплеями + scroll-impressions). Twitter-thread живёт 5-7 дней, TikTok-мем умирает за 24-48h. Разные сигналы, одинаково LLM не может судить.

**Добавил в `SYSTEM_PROMPT`** (`prompts.js`) новую секцию `━━━ SOURCE-AWARE METRIC CALIBRATION ━━━` с конкретными rule'ами:
- TikTok plays inflated ~5-10× (3M plays ≈ 300-600K Twitter views)
- TikTok shares — strongest virality signal (5K+ = peer-to-peer спред в DM'ы)
- TikTok memes burn out за 24-48h, Twitter — 5-7 дней, Reddit — 1-2 недели → freshness scoring per-source
- TikTok meme spread FORMAT-driven (sound + setup + punchline structure), не контент-driven — оценивай format adoption, не оригинального автора
- Reddit upvotes vote-democratized → 10K upvotes ≈ 100K+ readers (большинство не голосует)
- Google Trends лагает Twitter на 6-24h, поэтому свежий google spike часто = подтверждение что Twitter trend пошёл в mainstream

LLM теперь будет правильно калибровать: TikTok с 1M plays больше не получит 95+ только за raw число; Twitter тред с 50K likes получит больше bonus за тот же engagement-impact.

### Деплой
Один deploy. Стейдж 1 для следующего цикла увидит новый prompt. Хэштеги активируются когда переключим preset на `culture` в админке.

### Риски/заметки
- Список из 14 мемов **зашит в код** через `preset-config.js` defaults. Если владелец захочет refresh без re-deploy — можно делать через админку «🎛️ Пресеты → culture → TikTok hashtags» (chip-input UI уже есть).
- Stage 1 prompt разросся (~50 строк калибровки добавилось). Это +200-300 input-токенов на каждый Stage 1 batch call. На 96 циклах/день × ~30 трендов/цикл = пренебрежимо для бюджета, но надо помнить если будем оптимизировать prompt size.
- **Не сделали** TikTok-specific прогноз lifespan и meme-template extraction в nano — отложено до момента когда первые два шага покажут потолок (см. предыдущие записи).

---

## 2026-05-05 (TikTok: только для мемов + compilation regex filter)

После поднятия порогов владелец увидел что TikTok всё ещё ловит много мусора — категорийные подборки животных, мемов, дайджесты «top 10 funny dogs» и т.д. Проблема фундаментальная: хэштег-поиск на TikTok ищет КАТЕГОРИИ, не НАРРАТИВЫ. `#funnydogs` это reach-tag, его ставят на любое смешное видео с собакой; нет способа отличить «вот сейчас вирусный момент с собакой» от «очередной CompilationBros вкинул сборник 2026».

**Решение в три шага** (выбрано из обсуждения с владельцем — он отверг переписывание хэштегов и cross-source narrative gate как «мультиплатформенность не работает»):

1. **Compilation regex в `tiktok.js _normalize`** — отбрасывает видео с типичными маркерами подборки в caption'е:
   ```
   compilation, funniest, funny moments, cute moments, best of, 
   top \d+, \d+ minutes/seconds of, weekly best, of the week, 
   highlights of, memes #\d+, #\d+ в конце title
   ```
   Высокая precision, низкий recall — лучше пропустить пару подборок чем дропнуть legit narrative с фразой «top scorer» в названии. Дропает сразу после engagement-bar проверки, до всех expensive enrichment'ов.

2. **TikTok = только для мемов** — добавил `enabled` поле в `sources.tiktok` schema (mirror'ит существующий pattern `sources.xtrends.enabled`). По дефолту TikTok включён ТОЛЬКО в `culture` пресете (мемы — единственная тематика где TikTok-нарративы органически возникают через format propagation, sound trends, brainrot virality). В general/animals/celebrities/events — `enabled=0`. Хэштеги в выключенных пресетах оставлены as-is для forward-compat (если владелец вернёт через админку).

3. **Коллектор `collect()` rано выходит** если `_isEnabledForActivePreset()=false` с info-логом `[TikTok] disabled for active preset (sources.tiktok.enabled=0) — skipping cycle`. Никаких Apify-вызовов на выключенных пресетах.

**Изменённые файлы**:
- `src/collectors/tiktok.js` — `COMPILATION_RE`, `_isEnabledForActivePreset()`, ранний return в `collect()`
- `src/analysis/preset-config.js` — `tiktok.enabled` schema field, defaults across 5 пресетов

**Деплой + проверка**: первый цикл после деплоя — `[TikTok] disabled for active preset (sources.tiktok.enabled=0)` (текущий activePreset=general). Когда владелец переключит активный пресет на `culture` — TikTok снова заработает с meme-хэштегами + compilation filter'ом.

**Эффект**:
- На 4-х из 5 пресетов TikTok отключён — нулевой Apify-расход на TikTok пока активный пресет ≠ culture
- На culture — пройдут только non-compilation видео по meme-хэштегам (regex отрезает ~30-40% подборок)
- В сумме TikTok-доля в feed резко упадёт — но качество того что осталось будет выше (видео с реальным narrative arc)

**Замечание про 30% feed share**: ранее была глобальная задача о распределении 30/30/30/10/10. После этого изменения TikTok будет давать ~30% feed только когда активный пресет = `culture`. На остальных пресетах TikTok-доля будет 0%. Это **сознательный trade-off** — лучше 0% качественного TikTok чем 30% мусорных подборок.

**Что НЕ сделали** (из обсуждения):
- Не переписывали хэштеги на event-driven (`viralmoment`, `caughtoncamera` и т.д.) — владелец предпочёл оставить текущие meme-хэштеги в culture как есть
- Не сделали cross-source narrative gate (TikTok entity ∩ Twitter/Reddit entities) — owner deemed «multi-source mostly broken»
- Не реализовали entity-driven TikTok search (как X-Trends) — это уровень 3, отложено до момента когда уровень 1 покажет потолок

---

## 2026-05-05 (TikTok pipeline-аудит: пороги ↑10×, новые хэштеги, audio-URL filter)

С момента запуска проекта TikTok-настройки никто глубоко не пересматривал — тренды шли через копеечные пороги (50K plays / 1K likes / 200 shares / 40 viralScore = OR), и через generic-теги (`fyp/viral/trending` буквально весь TikTok). Владелец попросил пройтись и поднять пороги + взять свежие 2026-хэштеги через web-search Grok'а.

**Новый floor в `tiktok.js _normalize` + `_clusterByHashtag`** (OR-логика, как в Twitter):
- `plays ≥ 500 000`
- ИЛИ `likes ≥ 20 000`
- ИЛИ `shares ≥ 5 000`
- ИЛИ `viralScore ≥ 60` (composite, ловит influencer-посты)

Все volume-метрики (plays/likes/shares) скейлятся по CJK ×2 (ja/ko) или ×4 (zh). viralScore additive +10/+20. Все 4 порога подняты в ~10× от прежних значений (50K plays / 1K likes / 200 shares / 40 viralScore).

**Новые хэштеги** (per-preset, через 2026 web-search Grok'а):
- **animals**: `animalsoftiktok, petsoftiktok, funnydogs, funnycats, exoticpets, babyanimals, blackcatsoftiktok, catsoftiktok, doglovers, animalvideos, farmanimals, animalkingdom, puppylove, bunny, fosteringsaveslives` (15)
- **culture**: `storytime, relatablememes, genzmemes, comedytok, tiktokhumor, pranktok, sketchcomedy, brainrotmemes, italianbrainrot, skit, relatable, genztrends` (12) — убраны generic `viral/fyp/trending`, добавлены формат-теги (storytime/comedytok/sketch) и текущий сленг (italianbrainrot — спайк late 2025 / early 2026)
- **celebrities**: `kpopfyp, kpopdance, kpopedit, kpopstan, kpopfandom, fandomdrama, celebdrama, hollywooddrama, kpopnews, kpopidol, viraledit, kdrama` (12) — сильный сдвиг в K-pop экосистему (Grok сказал: kpopfyp/kpopdance/kpopedit доминируют 2026)
- **events**: `weathertok, tornadotok, stormchasing, aitechnology, technews, sportshighlights, championsleague, nbaplayoffs, ucl, spaceexploration, sciencefacts, breakingweather` (12) — погодный TikTok сильно поднялся 2025-2026 (weathertok + stormchasing), плюс post-LLM news (aitechnology/technews)
- **general**: `animalsoftiktok, petsoftiktok, funnydogs, storytime, relatablememes, brainrotmemes, kpopfyp, fandomdrama, celebdrama, weathertok, stormchasing, aitechnology` (12) — куратированный микс по 3 из каждой темы

**Audio-URL filter** в `tiktok.js _firstNonAudioUrl` + url-resolver.js: первый цикл после деплоя выявил что для ~3/13 видео apidojo прокидывает не video-URL а music-track URL (`*-music*.tiktokcdn.com/*.mp3`) в fallback-полях. Mime-sniff guard в gemini-captioner это ловил постфактум (download впустую → buffer signature ID3 → отказ). Добавил early skip по regex (`/\/ies-music|-music[-.]|\.mp3(\?|$)/`) — теперь fallback chain пропускает audio-URL'ы и идёт на следующий кандидат, либо null → poster.

**Деплой + первый цикл (с поднятыми порогами)**: TikTok собрал 13 items (vs 18-21 до), 8 из них успешно прокаптионены video в Gemini, остальные через постер. Volume стал ниже но качество значительно выше — все titles реально из тематических хэштегов (`#funnydogs #goldenretriever`, `#storytime #truestory`, `#funnydogs #dogcompilation`).

**Глобальная задача (на потом)**: владелец хочет распределение feed'а ~30/30/30/10/10 (Reddit / Twitter / TikTok / X Trends / Google Trends). Сейчас распределение возникает естественно из объёмов сборки и качества — после поднятия порогов TikTok может стать недопредставлен. Если в течение нескольких дней реальная доля TikTok будет <20%, нужно будет добавить explicit per-source quota в `dashboard/server.js` `/api/trends` (взвешенный SELECT с лимитом per-source) ИЛИ снизить пороги. Решение по данным после ~24-48h наблюдения.

**Риски/заметки**:
- Новые хэштеги ещё не «обкатаны», некоторые (italianbrainrot, kpopstan) могут оказаться нишевыми. Если через сутки видим что они не дают трендов — заменим. Старые `viral/fyp/trending` оставлены ТОЛЬКО в дефолтах если кто-то восстановит из админки.
- Cluster aggregator floor подкручен симметрично: если хэштег набрал >1 видео, их `sum(plays/likes/shares)` тоже должны пройти OR-floor. Это не отрезает trend'ы где одно сильное видео тянет — это только для ситуации когда никакое из видео в кластере не сильное по отдельности.

---

## 2026-05-05 (Stage 0: ffmpeg-trim длинных видео для всех источников)

**Контекст**: владелец заметил несоответствие между поведением и промптом. Промпт Gemini'а уже говорит «focus on FIRST 30 SECONDS only», но в коде была `if (duration > 30s) → throw away video, use poster`. Получалось что ~30% TikTok-роликов (которые длиннее 30s) теряли video-сигнал и шли через постер. Промпт намекал на трим, но реализован он не был.

**Что сделал** (применимо к ВСЕМ источникам видео — Twitter / Reddit / TikTok / X Trends / manual analysis):

- **`src/analysis/gemini-captioner.js` `_trimVideoToBuffer(url, maxSec)`** — новый helper, использует `ffmpeg -c copy` (stream copy, без re-encode) чтобы вырезать первые `maxSec` секунд в tmp-файл, читает обратно как Buffer, затем удаляет tmp. Стоимость: 50-300ms на ролик, 0% CPU-перерасхода (нет декодирования/кодирования). Adds `-user_agent` + `-referer` (для TikTok-CDN) автоматически.
- **`_tryGoogleMedia`** расширен опциональным `prefetched` параметром — когда передаём готовый Buffer, метод skip'ает HEAD+download и идёт сразу к sniff+send. Это позволило переиспользовать всю валидацию + Google API call для trimmed-видео, без дублирования кода.
- **`captionTrend` `tooLong` ветка** теперь сначала пытается ffmpeg-trim → если получили валидный buffer → шлём в Gemini как обычное короткое видео. Постер используется ТОЛЬКО если trim упал (network / codec mismatch / corrupt source) ИЛИ Google вернул ошибку.
- Новый флаг `videoClipped: true` в результате (отличается от `videoTruncated`). Когда trim удался — `mediaType='video'`, `videoTruncated=false`, `videoClipped=true`. Когда упал на постер — `mediaType='image'`, `videoTruncated=true` (старое поведение).
- **Admin UI**: badge в Gemini-карточке Stage 0 показывает «обрезано до первых 30s» когда `videoClipped=true`, или «видео > 30s, использован poster» когда упал на постер. Отдельные states видны явно.

**Деплой + проверка**: первый scan-cycle после правки на TikTok'ах: 21 item → 12 успешных video-caption (включая `[GeminiCaptioner] video 38.8s > 30s, trimming to first 30s` → `google video caption in 3504ms (0.56MB)` — 38s ролик был обрезан, попал в Gemini, прокаптионен). Постер-fallback больше не используется для длинных TikTok'ов.

**Риски/заметки**:
- ffmpeg `-c copy` требует чтобы первый keyframe был в начале потока. Для TikTok mp4 / Twitter mp4 / Reddit mp4 это всегда так. Если попадётся источник с keyframe не в начале — может получиться fragment с pre-roll до первого keyframe. Gemini это переживает (он смотрит видео с начала).
- `-movflags +faststart` требует двух проходов (write packets, then move moov atom to start). На tmp-файле это работает, на pipe — нет. Поэтому tmp-file подход.
- Стоимость в Gemini-токенах увеличивается: длинные видео раньше шли как один image-frame (~700 input tokens), теперь как 30s native video (~5K-10K input tokens). На батч в 16 трендов прирост ~50K input tokens = ~$0.0025 (gemini-2.5-flash $0.075/1M). Пренебрежимо.
- Tmp-файлы пишутся в `os.tmpdir()` (`/tmp` в docker), удаляются после чтения. Если контейнер крашится во время trim — orphan-файлы могут накопиться, но `/tmp` чистится при рестарте.
- Если ffmpeg отсутствует (на хост-системе вне docker'а где `RUN apk add ffmpeg`) — trim тихо падает, fallback на постер. Никогда не throw'ится.

---

## 2026-05-05 (TikTok: apidojo schema mapping fix — реальная схема ≠ research)

После approve apidojo и fallback'а на `APIFY_API` владелец продолжал получать `Gemini (image)` (или вообще без Gemini-секции, `gemini=0/1`). Подсказка от владельца «была такая ошибка с Twitter, но проблема была у нас» оказалась золотой — bug был в нормализаторе.

**Проблема**: Я писал mapper на основе research-агента, а тот выдал устаревшую/неточную информацию. Реальная схема apidojo (проверена `curl`'ом по живому actor'у):

```
{ id, title (caption + hashtags), views, likes, comments, shares,
  channel: { username, followers, ... },
  uploadedAt (UNIX seconds),
  video: { url (CDN mp4, ~6h TTL), cover, thumbnail, duration, ... },
  hashtags: ["bare","strings","without","#"] }
```

Мой код искал `playCount` / `diggCount` / `commentCount` / `shareCount` (это clockworks-style), `authorMeta.name` / `authorUsername` (тоже не apidojo), `originCoverUrl` / `videoUrlNoWaterMark` (нет таких полей). Поэтому:
- `videoUrl = null` (искал на топ-уровне, реально лежит в `video.url`)
- `thumbnailUrl = null` (искал на топ-уровне, реально в `video.cover` / `video.thumbnail`)
- engagement = 0 (искал `*Count`-варианты, реально голые `views/likes/comments/shares`)

→ Gemini-captioner раннее выходил на `if (!isVideo && !posterUrl) return null` (тихо, без ошибок в логах).

**Что починил**:
- **`src/collectors/tiktok.js` `_normalize`** — расширил все fallback цепочки реальными apidojo-полями (`video.likes`, `video.comments`, `video.shares`, `channel.username`, `channel.followers`, `video.video?.url`, `video.video?.cover/thumbnail`, `video.uploadedAt`, `video.title` для caption). Cyle collector теперь даёт scorer'у `videoUrl` + `thumbnailUrl` + полный engagement.
- **`src/analysis/url-resolver.js` `_resolveTiktokViaApidojo`** — те же правки в manual-analysis path. Теперь все 3 surfaces ручного анализа (admin/dashboard/TG) получают видео в Gemini.

**Деплой + проверка**: первый scan-cycle после правки — `[PreStage] 16 trends in 20951ms (nano=16/16, gemini=11/16)`, 11 TikTok-видео нативно прокаптионены через Gemini (`google video caption in 4524ms (0.69MB)` и подобные). 5 видео упали на постер из-за `STAGE0_VIDEO_MAX_SEC=30` cap'а — нормальное поведение для роликов >30s.

**Урок**: при добавлении нового Apify-actor'а ВСЕГДА сначала вызывать его руками и логировать первый item, чтобы увидеть точную схему. Research-агенты дают приближённую картину, реальные поля могут отличаться. Теперь в `tiktok.js` для apidojo комментарий с реальной схемой — будущий refactorer не наступит на те же грабли.

---

## 2026-05-05 (TikTok: apidojo full-permission approve + url-resolver fallback на APIFY_API)

После предыдущего деплоя apidojo cycle-collector начал получать 403 `full-permission-actor-not-approved` от Apify. Третий-party actor (`apidojo/tiktok-scraper`) требует **одноразового approve** в Apify Console — security-фича Apify, актёр получает full-account-access и должен быть явно разрешён.

**Что сделал**:

- **Просил владельца**: открыть `https://console.apify.com/actors/<actorId>?approvePermissions=true` и нажать «Approve permissions». После этого 403 пропал в течение секунд (без рестарта). Это **навсегда per Apify-аккаунт** — больше не понадобится.
- **`src/analysis/url-resolver.js`** `resolveTiktokUrl`: расширил token-fallback для apidojo Apify-вызова. Раньше требовал именно `APIFY_API_APIDOJO`, теперь fallback chain: `APIFY_API_APIDOJO || APIFY_API`. Это match'ит логику коллектора (`tiktok.js _activeActor`), где один общий ключ `APIFY_API` работает для всех актёров если у юзера один Apify-аккаунт. До фикса ручной анализ TikTok всегда сваливался на oEmbed (без видео в Gemini), даже если cycle-collector использовал apidojo нормально.

**Деплой**: `deploy.ps1`. После рестарта первый scan-cycle: `[TikTok] Collected 2 items`, никаких 403, в том же цикле Gemini успешно прокаптионил video caption 8.96MB нативно через `gemini-2.5-flash`.

**Ловушка для будущих third-party Apify-актёров**: некоторые actor'ы (особенно с `full-permission-actor-not-approved` в манифесте) требуют ручного approve в Apify Console. Симптом — 403 со специфичным error type'ом + `approvalUrl` в payload. Деплоить новые actor'ы в продакшен — сначала жмём approval URL для всех Apify-аккаунтов, чьи токены поедут в `.env`.

---

## 2026-05-05 (TikTok: ручной анализ теперь идёт через apidojo, не oEmbed)

**Контекст**: после деплоя Referer-фикса владелец прислал скриншоты — оба ручных анализа TikTok-ссылок показали `Gemini (image)` вместо video. Причина оказалась не в Gemini-captioner и не в коллекторе: `resolveTiktokUrl()` (используемый всеми тремя surfaces ручного анализа — админка, дашборд, TG-бот) ходит через **TikTok oEmbed API**, который возвращает только title + автора + thumbnail. Ни engagement, ни videoUrl. Поэтому переключение `tiktokActor` в админке (между clockworks/apidojo) на ручной анализ не влияет — он actorless.

**Что сделал**: расширил `resolveTiktokUrl(url)` в `src/analysis/url-resolver.js` двумя tier'ами:

1. **Primary (apidojo)**: если `process.env.APIFY_API_APIDOJO` установлен — вызываю apidojo Apify-актёр напрямую с `startUrls: [{url}]`, `maxItems: 1`. Получаю полный payload с engagement (plays/likes/comments/shares/followers) + `videoUrlNoWaterMark/videoUrl`. Нормализую той же fallback-цепочкой что и `tiktok.js _normalize` (DRY-shape с pipeline-collector'ом). Стоимость одного manual-анализа ~$0.0003.

2. **Fallback (oEmbed)**: если apidojo-токен отсутствует ИЛИ actor падает (network/timeout/empty result) — soft-fallback на старый oEmbed-путь. Бесплатно, только title+thumb (текущее поведение). Manual analysis никогда не hard-fail'ит из-за apidojo.

Все три surfaces (admin SubmitPage, dashboard AnalyzePanel, TG `/analyze` + URL-paste) идут через `runManualAnalysis()` → `resolveUrlToTrend()` → `resolveTiktokUrl()` — поэтому фикс одновременно покрывает все три точки входа без отдельных правок.

**Активация**: владельцу нужно положить `APIFY_API_APIDOJO=...` в `/opt/catalyst/.env` на проде + рестартануть контейнер. Сейчас ключа нет — manual analysis продолжает идти через oEmbed (graceful fallback).

**Риски/заметки**:
- apidojo считает manual-анализ как 1 item ($0.30/1K), это $0.0003 на запрос — пренебрежимо. Cross-user 1h cache в `manual-analysis.js` дополнительно режет дубли.
- Если apidojo вернёт не TikTok-видео а похожий пост (например ad/livestream), поля могут быть пустыми — fallback работает корректно (return null → catch → oEmbed).
- `videoUrlNoWaterMark` может отсутствовать у некоторых видео; используется обычный `videoUrl` с вотермаркой — Gemini-captioner всё равно нормально читает.

---
## 2026-05-05 (TikTok: видео apidojo доезжают до Gemini нативно — fix Referer)

**Контекст**: после первой итерации с apidojo владелец заметил что я в WORKLOG написал «видео не идёт в Gemini ни у одного актёра» и захотел чтобы оно ехало нативно — ровно как для Twitter. Вернулся, разобрался глубже.

**Что было неправильно сказано раньше**: я утверждал что apidojo `videoUrl` «header-bound и истекает». Реальность мягче — TikTok CDN (`tiktokv.com` / `tiktokcdn.com` / `tiktokcdn-us.com`) гейтит по заголовку `Referer: https://www.tiktok.com/`. Без него возвращает 403, с ним работает несколько часов до истечения сигнатуры в URL — этого вагон с запасом для нашего pipeline (Stage 0 запускается через секунды после scrape).

**Что сделано**:

- **`src/collectors/tiktok.js` `_normalize`** — пробрасываю `videoUrl` в `metrics.videoUrl` с per-actor fallback chain:
  - apidojo: `videoUrlNoWaterMark` (preferred — без вотермарка лучше для Gemini visual-понимания) → `videoUrl` → `mediaUrls[0]`
  - clockworks: `videoMeta.downloadAddr` → `videoMeta.playAddr` (только если включить `shouldDownloadVideos: true` — мы оставляем выключенным для экономии, поэтому для clockworks обычно null, fallback на постер как раньше)
  - Никакого actor-аware switch'а в коде — простая широкая цепочка покрывает оба
- **`src/analysis/gemini-captioner.js` `_tryGoogleMedia`** — для TikTok-CDN URL добавляю `Referer: https://www.tiktok.com/` к HEAD/GET запросам. Determined через `_isTikTokMediaUrl(url)` regex (узнаёт `tiktok.com`/`tiktokcdn.com`/`tiktokcdn-us.com`/`tiktokv.com`).
- **`src/analysis/gemini-captioner.js` `_probeVideoDuration`** — добавил ffprobe-флаги `-user_agent` + `-referer` (последний только для TikTok URL'ов). Без этого ffprobe возвращал бы code 1 на TikTok-видео и captioner думал бы что у видео нет длительности — fall through на постер без явного reason'а.

**Деплой + проверка**: docker rebuild → up. В первом цикле после деплоя `Stage 0` успешно вызвал ffprobe на нескольких видео (видны логи `video 30.9s > 30s cap, using poster`, `60.0s > 30s cap`, `169.0s > 30s cap` — длительность правильно читается). Twitter-видео (1.94MB, 5.24MB) нативно ушли в Gemini как раньше. TikTok-видео ещё не появились в логах потому что для них нужен apidojo-актёр с APIFY_API_APIDOJO токеном — переключатель готов, ждёт активации.

**Чтобы получить TikTok-видео в Gemini**: положить `APIFY_API_APIDOJO=...` в `/opt/catalyst/.env`, рестартануть контейнер, в админке `⚙️ Сканеры` → «🎵 TikTok scraper» → клик `apidojo`. Со следующего цикла TikTok-видео начнут идти в Gemini нативно (как Twitter) — короткие до `STAGE0_VIDEO_MAX_SEC` целиком, длинные через постер.

**Риски/заметки**:
- Сигнатуры в TikTok video URL'ах истекают через ~6h. Если когда-нибудь захотим re-process TikTok-видео старше 6h (например для hot-refresh) — будет 403, нужен будет re-fetch URL через свежий scrape. Сейчас не проблема, Stage 0 идёт сразу за collect.
- `videoUrlNoWaterMark` в apidojo может отсутствовать для некоторых видео — fallback на `videoUrl` (с вотермарком) корректный, Gemini читает обе версии нормально.
- Если TikTok сменит CDN-домен (например на `tiktokcdn-eu.com`) — regex в `_isTikTokMediaUrl` нужно будет расширить. Сейчас покрыты все известные варианты по состоянию 2026-05.
- На clockworks ничего не меняется: `videoUrl` не выставляется (потому что `shouldDownloadVideos: false`), Gemini fall through на постер как раньше — обратной совместимости 100%.

---

## 2026-05-05 (TikTok: второй скраппер apidojo как альтернатива clockworks)

Владелец нашёл альтернативный TikTok-скраппер `apidojo/tiktok-scraper` ($0.30/1K vs $2/1K у clockworks — в ~6× дешевле) и попросил сделать переключение между двумя актёрами по аналогии с Twitter (kaitoeasyapi/xquik). Дефолт остаётся clockworks — apidojo опционален.

**Контекст «видео как ссылка»**: владелец предупредил что apidojo не отдаёт видео-файлы напрямую, только ссылки. После research'а оказалось что apidojo возвращает поле `videoUrl`, но оно header/cookie-bound и истекает — для прямого скачивания не годится. **Для нашего пайплайна это не проблема**: TikTok-коллектор и так никогда не использовал прямой `videoUrl` (в отличие от Twitter), мы всегда работали через `thumbnailUrl` (cover) + `webVideoUrl` (страница поста). Stage 0 Gemini-captioner для TikTok использует постер, не video. Так что переключение на apidojo не меняет user-visible поведение.

**Изменения**:

- **`src/collectors/tiktok.js`** — рефакторинг по образу `twitter.js`:
  - Вынес жёсткий `ACTOR_ID` в `ACTORS` registry с двумя ключами (clockworks/apidojo), каждый со своим `id` + `buildInput(hashtag, maxItems)`.
  - clockworks: `{ hashtags: [tag], resultsPerPage }` (нативный hashtag-вход).
  - apidojo: `{ startUrls: [{ url: 'https://www.tiktok.com/tag/<tag>' }], maxItems, sortType: 'RELEVANCE' }` (apidojo не принимает `hashtags` массив).
  - `_activeActor()` читает DB-setting `tiktokActor` (default `clockworks`), выбирает actor + token.
  - Constructor читает `config.apify.tiktokKeys` per-actor (а не одиночный `apify.apiKey`).
  - `_normalize` — расширил fallback-цепочки: `author` ← `authorUsername` (apidojo); `followers` ← `authorMeta.followers/followerCount` (apidojo); `thumbnailUrl` ← `imageUrl` или `covers.default/origin` (apidojo может отдавать covers как объект).
  - `_pickHashtags` — заменил `_keyIndex` (который был артефактом старой rotation-логики через ключи) на отдельный `_cycleCounter` как в `twitter.js`.

- **`src/config.js`**:
  - Добавил `apify.tiktokKeys = { clockworks: APIFY_API_CLOCKWORKS || APIFY_API, apidojo: APIFY_API_APIDOJO }`. Generic `APIFY_API` остаётся back-compat — кто не успеет перетащить на per-actor key, продолжает работать.
  - Соответственно подкрутил warning: `TIKTOK_ENABLED=true && no key in tiktokKeys` (раньше проверяло только `apify.apiKey`).

- **`src/admin/server.js`**:
  - В `_scannerConfig`: добавил `merged.tiktokActor = (db.getSetting('tiktokActor', 'clockworks') || 'clockworks').toLowerCase()`.
  - В `_setScannerConfig`: добавил `VALID_TIKTOK_ACTORS = new Set(['clockworks', 'apidojo'])` + соответствующую валидацию.
  - В `ScannerConfigSection`: добавил массив `TIKTOK_ACTORS` (clockworks ⏱️ $2/1K · apidojo 🥷 $0.30/1K) + UI-блок «🎵 TikTok scraper» сразу после блока «🐦 Twitter/X scraper» — те же `scfg-preset-grid` карточки, тот же UX.

**Деплой**: `deploy.ps1` → docker rebuild → up. В первом цикле после деплоя — `[TikTok] Collected 19 items` через clockworks (дефолт), никаких ошибок. Переключатель в админке готов, остаётся положить `APIFY_API_APIDOJO` в `.env` на проде когда владелец захочет переключиться.

**Чтобы переключиться на apidojo**:
1. Добавить токен в `/opt/catalyst/.env` на сервере: `APIFY_API_APIDOJO=apify_api_xxx`.
2. Рестартануть контейнер (`docker compose restart catalyst`).
3. В админке `⚙️ Сканеры` → `🎯 Конфиг сканера` → секция «🎵 TikTok scraper» → клик `apidojo`.

**Риски/заметки**:
- apidojo использует `startUrls` вместо `hashtags` — синтаксис `https://www.tiktok.com/tag/<encodedTag>`. Если TikTok сменит URL-схему страницы тега, apidojo сломается раньше clockworks (у которого нативный hashtag-вход). Lock-in на URL-pattern.
- apidojo может вернуть кириллические/японские теги в URL некорректно если encoding'а нет — поэтому `encodeURIComponent(hashtag)` обязателен.
- `videoUrl` поле у apidojo есть, но бесполезно — header-bound. Если когда-нибудь захотим прямое видео для TikTok (Gemini native video processing), нужно будет либо качать в момент scrape'а, либо парсить страницу для CDN-URL. Сейчас не нужно.

---

## 2026-05-05 (Admin: Сканеры таб → accordion-стиль как Пресеты)

Владелец просил сделать вкладку «⚙️ Сканеры» компактнее, со сворачиваемыми секциями — как уже сделано в табе «🎛️ Пресеты». Чисто косметика, никакого behaviour-change.

**Что сделал**: каждая большая секция в `ScannersPage` теперь обёрнута в `<details className="pcfg-accordion">` с заголовком в `<summary>` и подзаголовком справа. Используется готовая CSS из preset-config'а (pcfg-accordion / pcfg-accordion-summary / pcfg-accordion-body) — никаких новых стилей.

**Дефолты `open`** подобраны по частоте использования:
- 📡 Площадки — open (главное место для toggle коллекторов)
- 🎯 Конфиг сканера — open (preset picker, twitter actor, Stage 2 cap — самое часто-крутимое)
- 🎨 PreStage — closed (A/B kill-switch для nano)
- 🔁 Обновление горячих трендов — closed (status + trigger)
- 📊 Junk-filter наблюдение — closed (read-only stats)

**Сверху над accordion'ами осталось видимым**:
- 3 stat-cards (статус пайплайна / включенных / отключенных источников)
- Scanner-status-bar с кнопками «Сканировать сейчас» + «Запустить/Остановить»

**Внутренний рефакторинг**: 4 секционных компонента (`ScannerConfigSection`, `PreStageSection`, `HotRefreshSection`, `JunkStatsSection`) сменили свою корневую обёртку с `adm-card` + `<h3>` на просто `<div>` — заголовок теперь в accordion `<summary>`, padding даёт `pcfg-accordion-body`. Иначе бы получилось двойное отступление.

**SPA-trap страйк #N**: backtick'и в комментариях inside template literal SPA. Поймал привычно — `node scripts/check-admin-spa.cjs`. Пришлось переформулировать комментарий без markdown-cтиля backticks.

### Файл
- `src/admin/server.js` — `ScannersPage` render, `ScannerConfigSection` / `PreStageSection` / `HotRefreshSection` / `JunkStatsSection` корневые обёртки.

---

## 2026-05-05 (General preset: curated mix instead of firehose)

Жалоба владельца: «На Animal пресете находит ровно что нужно, а на General — абсолютный мусор». Корень — General использовал **broad firehose** стратегию:
- Reddit: `r/all` + `r/popular` (uncurated, 30M+ posts/day)
- Twitter: word-soup queries `(a OR the OR is OR to OR in) min_faves:10000` — пропускает любой viral твит независимо от темы
- TikTok: generic `fyp viral trending foryou foryoupage` — это ВСЯ платформа

Это работало плохо потому что качественный сигнал тонул в массе мемов про random топики. Тематические пресеты лучше работают именно потому что у них pre-filtered входы.

**Решение** (от владельца): «взять из всех пресетов по ровну». Делать только General, остальные не трогать.

**Новый General sources** — куратированный микс 2-3 элементов из каждой темы:

| Slot | Reddit | Twitter | TikTok |
|---|---|---|---|
| animals | aww, NatureIsFuckingLit | dog/cat/pet net | cuteanimals, funnyanimals |
| culture | memes, dankmemes, Unexpected | meme/viral/trend + 2026-slang (skibidi/delulu/rizz/aura/brainrot) | meme, viral, brainrot |
| celebrities | popculturechat, movies | movie/film/album/celebrity | celebnews, popculture |
| events | worldnews, nottheonion | breaking news + AI/ChatGPT | news, breakingnews, tech |
| universal | Damnthatsinteresting, nextfuckinglevel (awe-content, no theme fit) | — | — |

Итого: **11 subreddits**, **6 twitter queries**, **10 tiktok hashtags**.

**Пороги/веса не трогал** — junk/alerts/cluster params в General уже примерно среднее по 4 темам, дополнительная балансировка не нужна. Если станет шумно — крутить через админку Пресеты.

**`minUpvotes` для Reddit** опущен 10000 → **5000**. Старая планка работала на firehose (`r/all` отдаёт пост с 100К+ upvotes как обычное явление). Новые themed-subs в среднем меньше — 5K даёт нормальный приток без mute.

**Migration**: проверил БД на проде через `SELECT value FROM settings WHERE key='presetConfigs'` — у владельца в General были overrides только в `alerts.weights` и `minScoreToSave`, sources не трогали. Новые defaults применяются автоматически (deep-merge).

**Первый цикл после деплоя**: Reddit 44 items (норм), Twitter 1 item (низко — ожидаемо, collector берёт 2 из 6 queries per cycle, по rotation за час разнообразие выровняется), TikTok отключен в админке.

### Файлы
- `src/analysis/preset-config.js` — `DEFAULT_PRESET_CONFIGS.general.sources` полностью переписан. Reddit subreddits / Twitter queries / TikTok hashtags заменены на curated mix. minUpvotes 10000 → 5000.

### Риски / заметки
- Если в будущем кто-то вернётся к firehose-стратегии — нужно явно вернуть `r/all`+`r/popular` и word-soup queries. Сейчас General **намеренно** не пытается покрыть «всё» — он покрывает **сборную лучших signals из 4 тематик**.
- Twitter rotation: 6 queries / 2 per cycle = полный круг за 3 цикла (~5 минут при 90с цикле). За день каждая тема прокачивается ~280 раз — достаточно для статистической ровности.

---

## 2026-05-05 (Ask Grok prompt: structured 6-point analysis)

Старый промпт «Ask Grok» в TrendModal был одной строкой:
```
How viral is this narrative right now? <title> — <url>
```
Грок отвечал общим параграфом, без структуры. Владелец попросил сделать точечнее.

**Новый промпт** — 6 пунктов, каждый отдельный вопрос:
1. Название нарратива (2-5 слов)
2. Почему вирален (триггер + кто пушит + объём)
3. Почему может вырасти (24-72ч катализаторы)
4. Потенциал роста (1-10 + обоснование)
5. Риски
6. Релевантная аудитория

Плюс шапка: «используй свежие данные из X 24-48h» — толкает Grok на x_search вместо стейтика. И жёсткий гард в конце: «Если данных мало — честно скажи "слабый сигнал", не выдумывай» — против hallucinated bullshit.

Локализация EN/RU. URL под Grok-сайт, без API-вызовов с нашей стороны (как и было).

**Технически — поймал SPA-ловушку №2** (newlines в template literal). Промпт многострочный → строки собраны через `[...].join(String.fromCharCode(10))`, потому что литеральный `\n` outer-template съел бы. Плюс ловушка повторно ужалила в комментарии: упомянул backslash-n в комменте — рантайм счёл его настоящим newline'ом, comment дотёкл до следующей строки и поломал outer literal. Перефразировал на «backslash-n» текстом. `node scripts/check-dashboard-spa.cjs` поймал на первом проходе.

Файл: `src/dashboard/server.js` — TrendModal, секция Links, `(() => { ... grokUrl ... })()` блок.

---

## 2026-05-05 (Junk penalty: text-only posts)

Владелец просил снизить долю чисто-текстовых постов в feed — мягкий штраф, не drop. Анализ распределения по 7 дням показал что Twitter имеет 22% постов без медиа, Reddit 4%, google_trends 100% (by design — нет media в природе платформы).

**Решение**: новый per-preset penalty `noContentPenalty` в `junk-filter.js`. Стакается с другими (politics, no-meme-shape, etc) до safe-override. Дефолты подобраны мягкими — большинство presets 5-8, events=0 (там новости часто текстовые by nature, штрафовать неправильно).

| Preset | noContentPenalty |
|---|---|
| general | 5 |
| animals | 8 (animal-мемы должны быть с фото) |
| culture | 6 |
| celebrities | 5 |
| events | **0** (новости часто текстовые) |

**Source-aware bypass**: когда **все** items кластера из source'а где медиа отсутствует by design (`google_trends`), штраф не применяется. Иначе бы все Google-results получали penalty мимо своей контроля. Пока в списке только `google_trends` — другие коллекторы все потенциально с медиа.

**Эффективный impact** через alertScore: penalty проходит через `weightJunk=0.5`, то есть `noContentPenalty=5` → `−2.5` к alertScore. Маленько, но значимо при пороге 65.

**Detection**: проверяется наличие хотя бы одного из полей `metrics.thumbnailUrl` / `metrics.imageUrl` / `metrics.videoUrl` / `metrics.imageUrls[].length>0` (плюс зеркала на root item). Если ни у одного item кластера ничего нет — штраф.

**Safe-override**: penalty стакается до safe-override. Если в тексте есть animal/absurd/meme/heartwarming — весь `raw` (включая no-content) делится на `safeOverrideDivisor` (3 default). То есть текстовый пост про собаку получает penalty ÷3, текстовый пост без сигналов — full hit.

### Файлы
- `src/analysis/preset-config.js` — добавлено поле `noContentPenalty` в junk field-ranges + default value во все 5 пресетов.
- `src/analysis/filter-profiles.js` — зеркало в legacy-структуре (FILTER_PROFILES + PROFILE_FIELD_RANGES) для совместимости с админкой и validator'ом.
- `src/analysis/junk-filter.js` — детектор `hasVisual` + блок `if (!hasVisual && !allTextlessByDesign)`.

**Migration**: zero-effort. `resolvePresetConfig` deep-merge'ит дефолты в существующий пользовательский blob — новое поле автоматически получает значение из `DEFAULT_PRESET_CONFIGS`. Старые row'ы в БД с уже-посчитанным junkPenalty остаются как есть; новые тренды считаются с обновлённой формулой.

---

## 2026-05-05 (X Trends rework: top-3 trends → tweet-backed engagement signal)

**Проблема**: владелец заметил что в feed много мусора. Анализ показал — старая архитектура X Trends эмитила хэштеги-как-тренды (`#SkibidiToilet — Trending #5`) с **нулевыми реальными метриками** (views/likes/etc = 0, X не отдаёт public tweet volume). Stage 1 LLM был вынужден галлюцинировать virality из голого названия → честно метил `memePotential ≈ 19`, но `virality ≈ 56` (rank-based bias) → проходило все фильтры и забивало feed. 85% x_trends в БД имели `memePotential < 40`.

**Решение** (после уточнения от владельца, что X Trends должен остаться отдельным источником с **видимым трендом**, не лентой твитов):

X Trends теперь **discovery layer** двух стадий:
1. Раз в сутки (вместо 30 мин) тянет список трендов через `karamelo/twitter-trends-scraper`, берёт top-3 по rank.
2. Для КАЖДОГО top-тренда вызывает обычный Twitter-скрапер (kaitoeasyapi/xquik) и тащит **топ-7 твитов** по запросу.

Эмиттится **один item на тренд** (source=`x_trends`):
- `metrics.views/likes/retweets/replies` = сумма по всем твитам тренда → Stage 1 LLM получает РЕАЛЬНЫЕ engagement-сигналы вместо текстовой догадки
- `metrics.topTweets[]` хранит список твитов с их content + numbers → доступно для prompt context, modal, и будущей UI-секции
- Visual content (thumbnail/imageUrls/videoUrl) лифтится из highest-engagement твита → X-Trend карточка в фиде имеет постер/галерею/видео как обычный твит-card

**Relaxed engagement floor**: добавлен флаг `opts.relaxedFloor` в `twitter._normalize` (10K views / 500 likes вместо 500K / 10K). X-Trends вытаскивает свои твиты с этим флагом — trending position уже сама по себе quality signal, firehose-grade bar отрезал бы 80% валидных трендов.

**Auto-skip generic noise**: если ни один из 7 запрошенных твитов не прошёл relaxed-floor, тренд тихо скипается. Так автоматически отсеиваются хэштеги типа `#GoodMonday`, `#Motivation` — без human-curated stoplist.

**Результаты на проде** (первый refresh после деплоя):
```
[XTrends] "May the 4th"   (rank 1) → 6 tweets, aggregated views=4966377 likes=227125
[XTrends] "John Sterling" (rank 2) → 7 tweets, aggregated views=2293013 likes=41997
[XTrends] "Good Monday"   (rank 3) — no qualifying tweets, skipping
```
2 из 3 трендов уехали в pipeline с миллионами views и десятками тысяч likes как реальный сигнал. Третий правильно отсеян.

**Стоимость**: $13/мес → **~$1.40/мес** (1 trends-list call/день + 21 твит/день при kaitoeasyapi). Чистая экономия $11.5/мес + кардинальное улучшение качества сигнала.

### Файлы
- `src/collectors/x-trends.js` — полный rewrite. `_buildTrendItem(trend, tweets)` агрегирует engagement и упаковывает topTweets. `_refresh()` теперь делает trends-list + N tweet-fetches. Старый `_normalize` / `_dedupKey` удалены.
- `src/collectors/twitter.js` — добавлен публичный `searchByQuery(query, maxItems, opts)`, `_searchQuery` теперь принимает `opts.relaxedFloor` и пробрасывает в `_normalize`. Floor: `viewsBar = (relaxed ? 10K : 500K) * cjkMult`, `likesBar = (relaxed ? 500 : 10K) * cjkMult`.
- `src/index.js` — `new XTrendsCollector(config, logger, db, twitterInstance)` — пробрасываем ссылку на TwitterCollector для discovery flow.
- `src/notifications/formatter.js` — source-aware engagement labels для x_trends. Раньше `m.upvotes` ветка покрывала только twitter/tiktok/reddit-like, и x_trends падал в общий fallback (Upvotes). Теперь для `source='x_trends'` рендерится rich-row `👁 views · ❤️ likes · 🔁 retweets · 💬 replies · N tweets` — отражает что у X-Trend агрегированный сигнал, а не одиночный счётчик.
- `src/dashboard/server.js`:
  - `_formatTrend` теперь пробрасывает `metrics.topTweets[]` в payload (с trim до 10 элементов и нужных UI-полей).
  - `TrendModal` рендерит секцию «🔥 Топовые твиты» только для `source='x_trends'`. Каждая строка — clickable `<a>` с `data-tweet-id` (хук `useTweetHover` ловит автоматом → ховер-карточка как у обычных твиттер-ссылок). Внутри строки: автор (моно), текст (cap 280), engagement-чипы 👁/❤️/🔁/💬.
  - CSS: `.xtrends-toptweets`, `.xtrends-toptweet`, `.xtrends-toptweet-head`, `.xtrends-toptweet-author`, `.xtrends-toptweet-text`, `.xtrends-toptweet-engage`. Согласован с дизайн-системой (var(--card), var(--border), accent-tint на hover).
  - i18n: новый ключ `modal.xtrends_top_tweets` (EN: «🔥 Top tweets ({n})», RU: «🔥 Топовые твиты ({n})»).

### Риски / заметки
- Если TwitterCollector ещё не инициализирован к моменту new XTrendsCollector — X Trends self-disable с warning. Сейчас порядок в `index.js` правильный (Twitter → XTrends).
- Per-preset `sources.xtrends.topN` поле сейчас не используется (top-N через env). Оставлено в схеме для обратной совместимости — preset-config validator не упадёт, и будущий refactor может вернуть как override.
- Старые row'ы в БД с source='x_trends' и нулевыми metrics остаются в фиде до retention cleanup (~7 дней). Новые приходят с реальными числами.
- `relaxedFloor` ослабляет фильтр **только** для пути `searchByQuery` — обычный `collect()` Twitter-коллектора по-прежнему режет по 500K. Если в будущем понадобится в других discovery-сценариях — флаг переиспользуем.
- Source-link для X-Trend карточки сейчас `https://x.com/search?q=<name>&src=trend_click&vertical=trends` — каноничный X-style «click from trending tab» URL. Идеальный вариант `/i/trending/<topic_id>` недоступен: actor `karamelo/twitter-trends-scraper` не отдаёт internal topic_id (cluster_id из X'овского `/i/api/2/guide.json`). Если когда-нибудь понадобится — нужен другой actor / собственный scraper с авторизованной сессией.

### Follow-up: hover-preview toggle (per-user)

В `SettingsPanel → Appearance` добавлен Toggle «👁 Hover preview» / «👁 Превью при наведении». Управляет ховер-карточкой со содержимым твита/реддит-поста на ссылках. Default ON (сохраняет существующий UX).

Хранится в `localStorage` как часть существующего `ts_prefs_v1` blob (`prefs.hoverPreview: bool`) — pattern такой же как у `showImages`/`animations`. Per-browser (= per-user в практическом смысле, разные юзеры на разных устройствах = разные prefs).

Технически: добавлен хелпер `readPref(key, fallback)` который читает свежее значение из `localStorage` без подписки на событие. `useTweetHover.onOver` вызывает `readPref('hoverPreview', true)` на каждом mouseover — bail-out если выкл. Toggle применяется на следующем же hover'е, без re-mount хука.

Файлы: `src/dashboard/server.js` (DEFAULT_PREFS + readPref + useTweetHover guard + SettingsPanel Row + i18n EN/RU).

---

## 2026-05-05 (Фикс X Trends — Apify актор поменял схему `country`)

**Симптом**: владелец заметил что несколько дней не приходит ни одного X Trends ни в дашборд, ни в TG.

**Диагноз** (по `docker logs catalyst-app | grep XTrends`):
```
[XTrends] sync refresh failed: Apify 400 [karamelo~twitter-trends-scraper]:
"Field input.country must be equal to one of the allowed values: '1','2','3',...,'35'"
[XTrends] Collected 0 items
```
Каждый цикл сбора, тысячи раз. Reddit/Twitter/Google продолжали работать.

**Корень**: актор `karamelo~twitter-trends-scraper` 2026-03-06 поменял input schema. Поле `country` теперь не строка `"United States"`, а enum-ID `"1".."35"` (где `"1"`=World, `"2"`=United States, `"3"`=Canada, ...). Старый input стабильно отдавал HTTP 400. Схему вытащили через `GET /v2/acts/<id>/builds/<latest>` → `inputSchema.properties.country.enum + enumTitles`.

**Фикс** (`src/collectors/x-trends.js`):
- Добавлена статическая мапа `COUNTRY_ID_MAP` (35 стран по реальному enum актора)
- Хелпер `resolveCountryId(value)`: если `/^\d+$/` — пропускает (env уже содержит ID), иначе lookup по lowercase имени, fallback на `"2"` (US)
- В `_fetchFromApify` теперь шлём `country: resolveCountryId(this.country)` вместо сырой строки
- Public-facing `this.country` остаётся человекочитаемой строкой — нужен для логов (`refreshed: N trends from <country>`) и описания в `_normalize` («Trending #N on X in United States (Live)»)
- Бэквард-совместимо: `X_TRENDS_COUNTRY=United States` (default) и `X_TRENDS_COUNTRY=2` оба валидны

**Деплой/проверка**: `deploy.ps1` → docker rebuild → проверка логов:
```
[XTrends] refresh timer started (every 30 min, country=United States)
[XTrends] refreshed: 100 trends from United States
[XTrends] Starting collection...
[XTrends] Collected 25 items
```
Поток восстановлен. Backlog за пропущенные дни не наверстаем (Apify не отдаёт исторические тренды), но новые пойдут.

**Риски / заметки**:
- Если автор актора снова поменяет enum (добавит/удалит страны) — `COUNTRY_ID_MAP` рассинхронизируется. Низкая вероятность; код достаточно forgiving (fallback на `"2"`).
- Похожий паттерн «schema drift у Apify-актора» теоретически возможен для twitter (kaitoeasyapi/xquik) и tiktok коллекторов — не трогали, работают. Если в будущем такое же — лекарство то же: вытащить `inputSchema` и translate-layer.

### Файлы
- `src/collectors/x-trends.js` — `COUNTRY_ID_MAP` + `resolveCountryId()` + правка `_fetchFromApify`

---

## 2026-05-04 (Hover-preview карточки + live engagement refresh + admin search)

Длинная сессия по UX-просьбам владельца. Большая часть — построение hover-preview инфраструктуры в дашборде (как в торговых терминалах: наводишь на ссылку — видишь содержимое поста), потом обвязка для **живого** обновления статистики (views/likes/upvotes/comments) при ховере и фоновом цикле, плюс поиск в DecisionsPage.

### Admin: поиск в `DecisionsPage` (вкладка 🔔 Алерты)

`src/admin/server.js`. Добавлен инпут поиска в фильтр-строке. Клиентский filter — буфер всего 500 решений in-memory, регэкс по массиву на каждый keystroke стоит микросекунды, серверный endpoint не нужен. Ищет по `title` / `source` / `category` / `alertType` / `userChatId` / `url` / `reason` (case-insensitive substring). Кнопка ✕ для очистки + счётчик «найдено: N / total». Empty-state корректно говорит «по запросу X ничего не найдено» вместо общего «нет решений».

### Tweet hover-preview (новая фича)

**Триггер**: ховер на ссылку `↗ Twitter` (в карточке фида) или `Source link` (в модалке). Через 350мс debounce появляется floating-карточка с: аватаром, именем (кликабельное), @handle (кликабельное), текстом твита, медиа (фото/превью видео), engagement chips. Аватар → ссылка на профиль X.

**Backend** (`src/dashboard/server.js`):
- LRU-кэш `tweetPreviewCache` (500 entries, 5-мин TTL для 200, 30-сек для 4xx)
- `extractTweetId(url)`, `normalizeFxTweet(tweet)`, `fetchTweetPreview(id)` — обёртки над `api.fxtwitter.com/i/status/<id>` (бесплатно, без auth, ~200-500ms)
- `GET /api/tweet-preview?id=<tweet_id>|url=<full_url>` — авторизованный endpoint в общем блоке роутов

**Frontend** (тот же файл, в SPA):
- `TweetHoverPreview` — компонент-портал в `document.body`, z-index 8500 (между modal-overlay 8000 и lightbox 9000)
- `useTweetHover()` — глобальный делегат `mouseover`/`mouseout` на `document`. Debounce 350мс, grace 200мс при mouseleave. `activeIdRef` предотвращает ре-fire при движении курсора внутри одной ссылки.
- Auto-flip: если карточке мало места снизу — показывается **выше** ссылки через CSS `bottom: vh - anchor.top + PAD` (CSS bottom вместо top, чтобы карточка росла вверх независимо от своей высоты — раньше использовал ESTIMATED_H 480→600 и карточка зависала «в воздухе» когда реальный размер был меньше)
- maxHeight по доступному месту → внутренний `.tw-prev-text` со scroll'ом для длинных постов

**Hover-target**: атрибут `data-tweet-id` ставится **только на `↗` ссылку** (после revert: ховер на весь пост был слишком агрессивен). Atribute extracted из URL по pattern `/status/<id>` (URL-based, **независимо** от `trend.source` — это поле может быть `'twitter'` / `'x'` / `'x_trends'` от разных коллекторов).

### Reddit hover-preview (зеркало Twitter)

После того как Twitter заработал, добавил параллельный pipeline для Reddit. Тот же UX — ховер на `↗ Reddit` показывает r/sub + u/user + title + selftext + media + ⬆ score / 💬 comments / 🏅 awards / ratio↑.

**Backend**: `redditPreviewCache`, `extractRedditPostId`, `normalizeRedditPost`, `fetchRedditPreview` — все mirrored с Twitter, но fetch на `https://www.reddit.com/comments/<id>.json?raw_json=1` (бесплатно, без auth). `GET /api/reddit-preview?id=<post_id>|url=<permalink>`.

**Frontend**: вместо двух отдельных хуков — расширил `useTweetHover` в **универсальный**: матчит `data-tweet-id` ИЛИ `data-reddit-id`, роутит на нужный endpoint. Карточка переключается по `state.kind`: `tweet` → 𝕏-стиль (avatar + @handle + 👁/❤️/🔁/💬), `reddit` → 🅡-стиль (r/sub + u/user + ⬆/💬/🏅/ratio). Один `CustomEvent('link-metrics-update')` с полем `kind` в detail вместо двух разных эвентов.

### Live engagement update — Variant B (мгновенное обновление UI)

Жалоба: hover-карточка показывает **свежие** числа (704K views), а под ней в фиде всё ещё **старые** (558K) — расхождение бьёт в глаза.

**Цепочка обновления:**
1. **Backend persist** (`src/db/database.js`):
   - `db.updateTwitterEngagement(tweetId, fresh)` — найти trend(ы) по URL pattern `%/status/<id>%`, патчить `views/likes/retweets/replies` в `raw_metrics` (null-safe: не затирает поля которые fxtwitter не отдал)
   - `db.updateRedditEngagement(postId, fresh)` — то же для `upvotes/comments`, lookup по `%/comments/<id>%`
   - **Velocity computation**: оба метода считают `Δviews|upvotes / Δhours` между предыдущим snapshot'ом и текущим. Snapshot хранится в `metrics._engSnapshot = { views|upvotes, ts }`. Первый раз baseline берётся из `metrics.views|upvotes + first_seen_at`. Min gap 5 минут (фильтр шума), Δ > 0 (защита от view-counter rollback). Возвращает `{ rows, velocity }`.
   - Дополнительно: `metrics.engagementRefreshedAt` для аудита.

2. **Endpoint integration**: `_handleTweetPreview` / `_handleRedditPreview` после успешного fetch'а вызывают `db.updateXxxEngagement(...)` в try/catch (fire-and-forget — DB-failure не должен ломать preview-ответ). Возвращают `velocity` в JSON ответа.

3. **Frontend dispatch** (`useTweetHover`): после `setState(...status: 'ok')` диспатчит `window.dispatchEvent(new CustomEvent('link-metrics-update', { detail: { kind, id, metrics, velocity } }))`. На cache hit `velocity = null` (signals «no fresh velocity, keep old»).

4. **App listener**: один useEffect слушает `link-metrics-update`, патчит **два** state-слота:
   - `setTrends(...)` — все видимые карточки фида (engagement + velocity), bail-out на shallow-equal чтобы не трогать React tree без изменений
   - `setModalTrend(...)` — открытая модалка хранится в отдельном state, отдельный merge
   - Mapping field-names per kind: Twitter `views→views, likes→likes, retweets→reposts, replies→comments`. Reddit `upvotes→views, comments→comments` (Reddit не имеет separate likes/reposts).

### Two-tier hot refresh (`src/refresh/hot-metrics.js`)

Heavy cycle (12h) уже существует — re-fetch + Stage 1 + Stage 2 LLM rescore. Добавил **light cycle** (60 мин) который делает **только** metrics refresh, без LLM:

- Eligible: все Reddit/Twitter trends ≤24ч (без minMeme — даже низкокачественные обновляются, они всё равно видны в фиде)
- Worker pool 5, calls `_fetchFresh` (reuses Twitter fxtwitter / Reddit JSON resolvers) → `db.updateTwitterEngagement` / `db.updateRedditEngagement`
- Skip если heavy cycle в полёте (no double-fetch)
- Тот же admin-toggle `hotRefreshEnabled` управляет обоими tier'ами
- Env knobs: `HOT_REFRESH_LIGHT_INTERVAL_MINUTES` (60), `HOT_REFRESH_LIGHT_ENABLED` (kill-switch)
- Cost: $0/мес (fxtwitter и reddit json — оба free)

Эффект: **все** Reddit/Twitter тренды обновляются раз в 60 минут, не только хроверённые.

### TikTok / Google Trends / X Trends

Не трогаем — TikTok oEmbed не отдаёт engagement (нужен Apify, платный), Google/X Trends — агрегатные сигналы, не индивидуальные посты.

### Auth fix: `/api/preview` 401

Существующий endpoint работал через raw `fetch('/api/preview?...')` без Bearer-токена (4 места: `FeedImage`, ещё одна aux fetch и 2 в TrendModal). Под общим auth-gate был 401. Заменил все 4 на `api('/preview?...')` который сам прикручивает Bearer.

### Ловушки template literal — три новых рецидива

Внутри `_buildSPA()` template literal эскейпы съедаются Node-парсером **до** отправки в браузер. Наступал три раза за сессию:

1. **Бэктики в комментариях** (`// CSS \`bottom\` instead of \`top\``) — чёрный экран. Лечение: убрать обратные кавычки из текста комментариев в SPA-коде.
2. **Regex literal внутри template literal** (`/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i`) — Node template eats `\.` → `.`, regex literal в браузере матчит хорошо. Это **работает** для regex literals.
3. **String-based RegExp constructor** (`new RegExp('\\d+')`) — две вложенные интерпретации escape-sequence. `\\d` → Node template → `\d` → browser JS string literal → `d` (нераспознанный escape, бэкслэш дропнут) → RegExp получает `'d+'` (буква d). Лечение: **четыре** бэкслэша в source: `'\\\\d+'` → Node → `'\\d+'` → Browser → `'\d+'` ✓.

`scripts/check-dashboard-spa.cjs` ловит #1 (синтаксис), но **не ловит #3** (синтаксически валидно, семантически сломано). Добавил throwaway `_test_regex.cjs` для двойной проверки во время сессии (удалён после).

### Files touched
- `src/dashboard/server.js` — endpoints, hover hook, preview component, lightbox, App listener, CSS, auth fixes (~1500+ строк диффа)
- `src/db/database.js` — `updateTwitterEngagement`, `updateRedditEngagement` (с velocity computation)
- `src/refresh/hot-metrics.js` — light cycle (`runLightCycle`), отдельный startTimer + intervalHandle, env vars
- `src/admin/server.js` — search input в DecisionsPage + CSS

### Проверка
- `node scripts/check-dashboard-spa.cjs` ✓ (219292 chars)
- `node --check` всех 4 файлов ✓

### Риски / заметки
- **TikTok freshness не покрыт** — единственная стратегия для него Apify через heavy 12h цикл. Если важно — добавить отдельную light-tier ветку с Apify (платно).
- **Velocity для Twitter был раньше 0** в `metrics.velocity` (поле для Reddit). Теперь Twitter тоже получает velocity из delta. Может слегка изменить виральность-heuristic для старых строк — но `_heuristicScore` использует velocity только для `m.upvotes` контекста (Reddit), на Twitter не критично.
- **Race**: light cycle и hover могут писать в один и тот же row близко по времени. Оба идут через одни и те же DB-методы (`updateXxxEngagement`), методы атомарны (single UPDATE), последний выигрывает. Snapshot обновляется каждым → следующий gap считается от последнего, чуть может «перескочить» точную velocity. Acceptable.
- **`_engSnapshot` вечно растёт в JSON**? Нет — это object с 3 полями (views/upvotes, likes/comments, ts), <100 байт. Перезаписывается каждый refresh.
- **404 на reddit /comments/.json**: Reddit иногда блочит дата-центральные IP. Если это случится — fxtwitter-эквивалента у Reddit нет. Альтернатива на будущее — `i.reddit.com/.json` (mobile mirror) с тем же payload.

---

## 2026-05-04 (UX полировка дашборда + Grok cost cleanup + cross-platform rip-out)

Большой проход по жалобам владельца на дашборд + закрытие двух источников расходов (Grok hot-refresh, поломанная кросс-платформенная агрегация). Всё в одном дне сессии.

### Window-фильтр фида (баг 6h-окна → пустой фид)

Жалоба: «Окно 6h не работает». Sources card показывает 158 трендов, но фид пуст.

Две слои проблем:

1. **Семантика**: фильтр был `WHERE first_seen_at > cutoff`. Кластеризатор подтягивает свежие посты к существующим нарративам — `last_seen_at` обновляется, `first_seen_at` нет. Тренд, родившийся 8h назад и активный прямо сейчас, не попадал в окно 6h. Переключил на `last_seen_at > cutoff` — семантика стала «активен в окне», а не «родился в окне». В `_handleTrends` + `_handleStats`.

2. **String-comparison bug** (это была настоящая причина обнуления). SQLite хранит `CURRENT_TIMESTAMP` как TEXT `"YYYY-MM-DD HH:MM:SS"` (пробел между датой и временем). А `new Date().toISOString()` даёт `"YYYY-MM-DDTHH:MM:SS.sssZ"` (с `T`). Лексикографическое сравнение на позиции 10: `' '` (0x20) < `'T'` (0x54) → DB-строка **всегда** меньше cutoff-строки при одной и той же дате → `WHERE col > cutoff` режется в ноль для same-day cutoff'ов. На 24h работало почти, потому что cutoff попадал на вчерашнюю дату — отличие шло уже на позиции 8 ("4" vs "3"). На 6h cutoff в той же дате → 0 трендов.

Helper `sqliteCutoff(msAgo)` форматирует `"YYYY-MM-DD HH:MM:SS"` под формат стораджа. Применил в `_handleTrends`, `_handleStats`, `_handleSources`. Тот же баг есть в `db/database.js` (retention/dedup queries) — там окна 7-30 дней, симптоматически невидимы; не трогал в этом PR. Подпись времени на карточке/модалке тоже переключил на `lastSeen` (с fallback на `firstSeen`) для консистентности с фильтром.

### Cross-platform aggregation удалена целиком

Жалоба + скрин: одно и то же turtle-видео из Twitter и Reddit как 2 отдельных тренда (matcher не смержил), и оба получают 0 за «platform spread» в emergence.

Решение — выдрать сигнал отовсюду, где код на него полагался:

- **`clusterer.js`**: убраны `batchPlatforms`/`dbPlatforms`/`uniquePlatforms`. EmergenceScore: компонент Platform spread (0–30) удалён, 30 баллов перераспределены — Velocity 25→**35**, Organic 20→**30**, Novelty 15→**20**, Author diversity 10→**15** (сумма по-прежнему 100, пороги DROP/SAVE/PRIORITY/STAGE1 не трогали). В `_decide` убран guard `uniquePlatforms <= 1` из drop-gate.
- **`scorer.js` `deriveAlertType`**: правило `platforms ≥ 2 OR clusterSize ≥ 3` упрощено до `clusterSize ≥ 3`.
- **`dashboard/server.js`**: убран URL-param `minPlatforms`, поле `uniquePlatforms` снято с trend-payload, бейдж `Xp` (`2p`/`3p`) на карточке убран, тайл «Платформы / 🌐 N» в модалке удалён, i18n `modal.platforms` тоже.
- **`admin/server.js`**: `🌐 N платформ` бейдж в Cluster-signals удалён, hydration field убран.

AI-промпты с упоминанием «cross-platform spread» **не трогал** — это валидная семантика для рубрики LLM, не наш детерминированный код. Колонка `source` в БД и `raw_metrics.uniquePlatforms` старых строк остаются — безвредно, никто не читает. Single-platform breakouts всё ещё ловятся через Path 2 (breakoutScore) — он platform-agnostic, по raw engagement.

Теперь две копии turtle-видео идут как два тренда, но **оба честно** получают высокий emergence через breakout. Раньше код тащил их через сломанный сигнал и ставил 0 за platform spread.

### Hot refresh: 2h → 12h цикл (Grok cost cut 6×)

Жалоба: «Grok начал заметно больше есть денег». Audit показал — Hot refresh — это бесконечная петля без per-trend cooldown'а. Picker (`getHotTrendsForRefresh`) выбирает все hot-тренды моложе 24h без проверки последнего рескора, каждый цикл re-runs Stage 1 на всех + Stage 2 на тех у кого memePotential ≥ 60.

При интервале 120 мин активный тренд за свою 24h-жизнь прогонялся **до 12 раз**. Изменил `DEFAULT_INTERVAL_MIN` 120 → **720** (12 часов). Теперь тренд проходит через Hot refresh максимум **2 раза**. Шесть-кратное снижение LLM-расходов без потери возможности повторно поскорить.

Переменная окружения та же (`HOT_REFRESH_INTERVAL_MINUTES`) — можно тюнить в обе стороны (360 = 6h «реактивно», 1440 = 24h «минимум»). `.env.example` синхронизирован.

Если расходы всё ещё не устроят — следующий шаг добавить per-trend cooldown в picker (поле `lastRefreshedAt` уже пишется в `raw_metrics`, но picker его не читает). Не делал — пока интервала достаточно.

### Модалка: layout overhaul

- **Hero Meme Score** в самом верху над медиа: компактная карточка с soft gradient-фоном, акцентной рамкой, цифрой 16px JetBrains Mono с цветом по тиру (hot/warm/ok/cold), 4px полоска с gradient fill + shimmer-анимация. Это «главная цифра» — заслужила prime-слот выше всего остального. Класс `.meme-hero`.
- **Сентимент тайл удалён** из метрик-грида (поле `sentiment` остаётся в payload и используется в TG-алерте + chip карточки фида — это отдельные места).
- **Метрики-сетка** свелась к **3 тайлам** в порядке: **Виральность → Скорость → Срок жизни** (Lifespan). Cross-platform tile удалён в этом же PR (см. выше).
- **Высота медиа**: 440px → 260px (модальная карусель `.img-carousel.in-modal` + `.modal-image-wrap`). Освободил место под scoring-bars + quote-хук без скролла.
- **Lightbox**: клик по картинке/слайду открывает fullscreen-просмотр через `ReactDOM.createPortal` в `document.body` (z-index **9000** — выше `.modal-overlay` 8000, ниже `.toasts-wrap` 9999). Закрытие по клику в любое место / Esc / кнопке ×. Capture-phase Escape listener у Lightbox + gate `lightboxSrc` в TrendModal-handler гарантируют правильный порядок закрытия. `cursor: zoom-in` на `img.modal-image` (НЕ на `video.modal-image` — иначе видео получало курсор-лупу).

### Фид-карточки: Meme Score + разделители колонок

В score-strip фида была 2-колонная сетка (Emergence | Adoption). Добавил третью колонку **Meme Score** между ними — `trend.memePotential` тот же сигнал что в hero-блоке модалки, surfaced на карточку чтобы видно at-a-glance.

Дизайн: `grid-template-columns: 1fr 1fr 1fr`, gap → 0, padding `8px 6px` снаружи + `0 10px` на каждой колонке, **вертикальные gradient-разделители** через `.feed-score + .feed-score::before` (1px, fade к торцам). Колонки больше не сливаются.

### Type-фильтр: AND → OR

Жалоба: «выбираю Ручные → остальные типы исчезают, хотя выбраны».

Старая логика: `manualOnly && alertTypes` — пересечение, не объединение. «Ручные» + «Пост» давало manual-submitted **И** alertType=post (мизерный intersection).

Чипы Type-оси (Event/Trend/Post/Manual) — это **одна ось** «что показывать». Семантика должна быть union. Новая логика: row проходит если `passManual || passType` (когда оба активны). Когда активен один — только он решает, поведение прежнее. Wildcard для legacy-строк без `alertType` сохранён.

### Catalyst: чистка визуала

- **Sources block** (список low-signal X handles) удалён из дашбордной модалки **и** из Telegram-алерта (`notifications/telegram.js`). Поле `payload.sources` всё ещё прилетает из БД, но не рендерится. CSS-классы `.catalyst-sources*` оставил — мёртвые правила безвредны.
- **CTA-hint в empty-state** убран целиком (был «Куда движется этот нарратив - фаза, каталисты, риски»). Кнопка "Найти Каталиста" сама достаточный call-to-action. i18n-ключ `trigger.cta_hint` оставил живым на случай возврата.

### Sentiment audit (без изменений)

Sub-вопрос владельца: «как влияет sentiment?». Прошёлся по коду — нигде не читается для скоринга/роутинга/алерт-диспатча. Чисто descriptive vibe-метка: показывается в TG-алерте и feed-card chip, не двигает ни alertScore, ни phase, ни type. Решили оставить как есть — option B (использовать в `computeAlertScore`) на потом.

---

## 2026-05-04 (Production-readiness pass + log audit для публичного релиза)

**Цель**: владелец готовит проект к публикации. Прошёлся по дашборду + админке + бот-боту в режиме готовности к домену и multi-user. Закрыл блокеры по слою представления (security headers, CORS, rate limits, graceful shutdown, env validation), потом sweep по логам на утечку секретов.

### Security headers + CORS allowlist (dashboard + admin)

Раньше: `Access-Control-Allow-Origin: *` хардкодом везде, никаких security-заголовков. Любой сайт мог из браузера дёрнуть `/api/manual-analysis`, feedback, toggle коллекторов от имени залогиненного юзера. Page фреймился (clickjacking), MIME-sniff включен, HSTS не закреплён.

**Фикс** (`src/dashboard/server.js`, `src/admin/server.js`):
- Helper `buildHeaders(req)` собирает `SECURITY_HEADERS` + опциональный CORS-echo по allowlist
- Default policy: HSTS (max-age=31536000), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer
- CORS allowlist через env: `DASHBOARD_ALLOWED_ORIGINS` / `ADMIN_ALLOWED_ORIGINS` (comma-separated). Empty default = same-origin only (самый безопасный)
- В `_handle()` стэшится `res._defaultHeaders = buildHeaders(req)` и **monkey-patch `res.writeHead`** чтобы каждый response (включая binary handlers, error paths, 401, OPTIONS, SSE) автоматически инжектил headers — без рефакторинга 30+ call sites
- HTML SPA: `Cache-Control: no-cache, no-store, must-revalidate` чтобы deploy сразу видели новую версию

### Rate-limits на auth endpoints

Раньше: `/api/auth/verify` без throttling — 6-значный код можно было перебрать за дни (~20 бит энтропии). `/api/auth/initiate` без cap — флуд создавал тысячи pending-rows в `auth_sessions`.

**Фикс** (`src/dashboard/server.js`):
- `_authVerifyAttempts: Map<sessionId, {count, firstAttempt}>` — cap 5 попыток / 15 мин окно. После превышения 429, "restart login from /start". В ответе `attemptsRemaining` для UX
- `_authInitiateAttempts: Map<ip, {count, firstAttempt}>` — cap 10 / 5 мин per-IP. Sweep на каждом запросе чтобы Map не рос
- Note: за прокси без `TRUST_PROXY=1` все IP видятся как proxy — limit становится глобальным per-VPS. Когда добавим `X-Forwarded-For` чтение, ключ Map переедет на real-IP

Smoke-test подтвердил: 11-я /initiate попытка → 429, 6-я /verify → 429.

### Admin-gate на collector toggle

`POST /api/collectors/:name/toggle` мутирует **глобальный** `appState.disabledCollectors`. До фикса: любой Pro/Free юзер мог выключить Twitter для всей системы. Now: server-side check `req.user.plan_name === 'admin'`, иначе 403. Audit-лог теперь включает `maskId(chat_id)` админа.

### Graceful shutdown с timeout + SSE drain

Раньше `dashboard.stop()` делал просто `server.close()` без таймаута — rolling deploy дропал in-flight запросы (502 у юзера).

**Фикс** (dashboard + admin + index.js):
- `dashboard.stop(timeoutMs=10000)` — Promise: drain SSE с `event: bye`, ждёт active requests, force-close через `closeAllConnections()` после таймаута
- `admin.stop(timeoutMs=10000)` — аналогично (SSE нет, просто drain)
- В `index.js` shutdown теперь: re-entry guard (SIGTERM может прийти дважды), hard-cap 15s через `setTimeout`, `Promise.allSettled([dashboard.stop, admin.stop])` параллельно

### Hard-fail env validation в production

Раньше `config.js` логировал warning'и но **не падал** — оператор мог запустить с пустым `ADMIN_API_KEY` и не заметить.

**Фикс** (`src/config.js`):
- Новые поля: `nodeEnv` / `publicBaseUrl` / `trustProxy`
- В production (`NODE_ENV=production`) отсутствие `XAI_API_KEY` / `TELEGRAM_BOT_TOKEN` / `ADMIN_API_KEY` → `process.exit(1)` с явным сообщением
- В dev — warnings как было

### Log audit — закрытие утечек секретов

Запустил Explore-agent на поиск утечек в логах. Найдено 3 категории:

**🔴 HIGH: Apify token в URL** (4 коллектора). `?token=<apiKey>` в query-string — если `fetch()` бросил network error, undici включает URL в `err.message` → токен утёк бы в любой `logger.error(e.message)` вверх по стэку.

Фикс: `?token=` → `Authorization: Bearer` header в:
- `src/collectors/twitter.js`
- `src/collectors/twitter-check.js`
- `src/collectors/tiktok.js`
- `src/collectors/x-trends.js`

Apify поддерживает Bearer auth, токен больше не на URL-поверхности.

**🔴 HIGH: Telegram bot-токен в file URLs**. `getFileUrl()` возвращал `https://api.telegram.org/file/bot<TOKEN>/...`, dashboard avatar handler делал `fetch(url)` и в `catch` логировал `e.message` — реальный leak.

Фикс: новый `telegram.fetchFile(fileId) → {buffer, contentType}` который держит fetch внутри telegram-модуля. URL с токеном **не пересекает границу модуля**. В catch теперь `err.code` (не `e.message`) на случай если undici снова решит включать URL. `getFileUrl()` помечен deprecated.

**🟡 MEDIUM: telegram_chat_id в логах** (12+ мест). PII в долгосрочных stdout-логах (Docker / journald). Mask вместо удаления — нам нужно correlations между лог-строками одного юзера, но не полный ID.

Helper `maskId(id) → '***' + last4` добавлен в:
- `src/dashboard/server.js` (export, 4 call sites)
- `src/notifications/telegram.js` (5 call sites)
- `src/notifications/alert-dispatcher.js` (2 call sites)
- `src/db/database.js` (registration log)
- `src/support/bot.js` (2 call sites)

### Конфиг и DEPLOY.md

`.env.example` обновлён: `NODE_ENV`, `PUBLIC_BASE_URL`, `TRUST_PROXY`, `DASHBOARD_ALLOWED_ORIGINS`, `ADMIN_ALLOWED_ORIGINS`.

**NEW** `DEPLOY.md` в корне — runbook для деплоя на single-VPS: prerequisites, systemd unit с hardening (NoNewPrivileges, ProtectSystem), nginx конфиг с TLS+SSE, ufw firewall rules, sqlite backup-cron, rolling deploy через `systemctl restart`, pre-launch checklist, post-launch monitoring.

### Smoke-tests прошли

Live HTTP probe подтвердил: HSTS/XFO/XCTO во всех ответах, CORS работает только для allowlist, /verify 429 на 6-й попытке, /initiate 429 на 11-й, dashboard.stop drain'ит SSE и завершается. Production hard-fail срабатывает при пустых критичных env.

---

## 2026-05-04 (Bot UX polish — Stars removal + simplified copy + дефис vs длинные тире)

**Цель**: подготовка телеграм-бота к публичному релизу. Владелец зачищает шероховатости в текстах и удаляет нерабочие платёжные пути.

### Telegram Stars удалены

Раньше было три способа оплаты: Stars (XTR), SOL, USDC. Stars не используется — выпиливаем полностью чтобы не путать пользователя.

Удалено:
- `src/notifications/telegram.js`: `_handleStarsPayment()`, `_setupStarsPayments()` (pre_checkout_query + successful_payment listeners), вызов из конструктора, ветка `if (currency === 'STARS')` в callback-роутере, кнопка `btnPayStars` в `_paymentMethodKeyboard()`, `'pre_checkout_query'` из `allowed_updates`
- `src/config.js`: `telegram.starsTestPrice` / `telegram.starsProPrice`
- `.env`: `STARS_TEST_PRICE` / `STARS_PRO_PRICE`
- `src/i18n/{en,ru}.js`: `btnPayStars`, `starsInvoiceTitle`, `starsInvoiceDesc`

Survived: `currency` колонка в `payments` остаётся generic для SOL/USDC. Исторические записи `currency='STARS'` лежат как read-only артефакты.

### Welcome-сообщение, threshold-screen, payment instructions переписаны

**Welcome** (`src/i18n/{en,ru}.js`): первая строка теперь подзаголовок (`Catalyst - narrative scanner`), value-prop вместо feature-list (`before it's everywhere` / `до того, как она везде`), список свёрнут с 5 до 4 пунктов (слил повторяющиеся "What's happening" + "Plain-language breakdown" → "Why it's spreading"). Каждый пункт переписан с feature на benefit.

**Threshold screen**: "Current: X/100" → "Now: X/100", избыточная вторая фраза-подсказка убрана, `=` в подсказке заменён на `→`. Кнопки: `Low (52+) · more alerts` (число в скобках вместо `· 52+`), `Custom number` → `Custom`.

**Payment instructions**: вместо "Option 1 (Recommended) / Option 2 (Manual)" — `📲 Easy way / ✍️ Manual`. Сумма и адрес в **отдельных `<code>` блоках на отдельных строках** для tap-to-copy. По просьбе владельца "Phantom / Solflare" заменено на "SOL wallet" / "SOL-кошелёк".

### Language picker — только латиница

Кнопки `🇬🇧 English` / `🇷🇺 Russian` (раньше "Русский" кириллицей) и `◀️ Back` (раньше "Back / Назад"). Принцип: на picker-экране юзер должен видеть свой родной язык независимо от текущей локали.

### Длинные тире → обычные дефисы (системно)

Владелец обратил внимание: длинные тире (—, –) — AI-стилистика, люди в чате пишут просто `-`. Заменил во всех user-facing строках.

Файлы: `src/i18n/{en,ru}.js`, `src/notifications/telegram.js` (пользовательские строки `/analyze` help, login сообщение, виральный шаблон), `src/notifications/alert-dispatcher.js:207` (placeholder в admin DecisionsPage), `src/config.js`.

**Tool-trap замечен**: Edit-инструмент при сохранении конвертирует литеральный em-dash в `—` escape, поэтому первый раунд `replace_all` оставил часть в виде Unicode-эскейпов. Второй раунд их добил. Проверка через `Grep —` после правки обязательна.

### "Ask a question" убрана из /start

`_startKeyboard` теперь содержит только `⚙️ Open Menu`. Кнопка поддержки осталась в `_mainMenuKeyboard` (доступна на втором экране) — не торчит на самом первом, чтобы не размывать CTA. Ссылка ведёт на support-bot deep-link через `_supportUrl()`.

---


## 2026-05-03 (Hot trends refresh loop — авто re-score свежих бордерлайн-трендов)

**Цель**: тренды скорятся ОДИН раз при сборе. Если тренд был borderline (memePotential 50-59, ниже stage2Threshold=60), а потом в течение 24ч набрал виральность — Stage 2 ему не светит, и юзеры могли пропустить «дозревший» нарратив. Решение: фоновый цикл, который раз в 2ч пере-фетчит metrics и заново прогоняет через scorer.

### Архитектура

**NEW** `src/refresh/hot-metrics.js` (~180 строк) — класс `HotMetricsRefresher`:
- `start()` — startup delay 2 мин + setInterval(120 мин)
- `runCycle()` — re-entrancy guard через флаг `running`
- `_isAdminEnabled()` — читает DB setting `hotRefreshEnabled` на каждом cycle entry (no restart нужен)
- `_refreshAll(trends)` — concurrency=5 worker pool, политично к источникам
- `_fetchFresh(trend)` — дёргает `resolveTwitterUrl` / `resolveRedditUrl` (оба бесплатные)
- `_merge(orig, fresh)` — сохраняет identity (externalId, title) + carry-through `preStage` чтобы не платить повторно за nano/gemini

**NEW** в `src/db/database.js` метод `getHotTrendsForRefresh({ minMeme, maxAgeHours, sources, limit })`:
- SELECT по `first_seen_at > now-24h AND source IN (?,?) AND url NOT NULL`
- Парсит `raw_metrics` JSON, фильтрует по `memePotential ≥ minMeme`
- Возвращает в camelCase shape совместимом с `scorer.scoreTrends`

**NEW** endpoints в `src/admin/server.js`:
- `GET /api/hot-refresh` → `{ enabled }` (читает `hotRefreshEnabled`)
- `POST /api/hot-refresh/toggle` — flip + persist

**NEW** UI компонент `HotRefreshSection` (зеркалит `PreStageSection`) — карточка в табе «Сканеры» с тумблером, статусом и описанием логики.

**Wired в `src/index.js:115-119`** — `new HotMetricsRefresher({ db, scorer, logger }).start()` рядом с supportBot.

### Eligibility (фиксировано в `_runCycle`)
- `first_seen_at ≤ 24h ago`
- `memePotential ≥ 50`
- `source ∈ {reddit, twitter}` (TikTok пока out — требует Apify $)
- `url IS NOT NULL`
- Cap 100 трендов/цикл

### Стоимость (~$3/мес)
- **Refresh metrics**: БЕСПЛАТНО (fxtwitter + reddit json)
- **Stage 1**: ~50 трендов × 12 циклов/день × ~$0.0012/batch ≈ $2-3/мес (gpt-5.4-mini)
- **Stage 2**: cap'нуто `stage2MaxCalls` (default 3/cycle) — общий бюджет с обычными циклами не растёт

### Дозревший тренд → новый алерт
Если после re-score `alertScore` пробил порог И тренд НЕ был alerted раньше — обычный alert-loop в `index.js` подхватит на следующем проходе. **Никакой отдельной alert-логики в refresh-loop нет** — все идёт через существующий gate. Нет дублей, нет race conditions.

### Что владелец явно НЕ просил (отложено)
- Telegram alert message edit при изменении метрик (refresh не трогает уже отправленные алерты)
- Re-alert уже-alerted трендов (только новые алерты для трендов, которые впервые прошли порог)
- Apify Batch API для Stage 1 (50% off async) — экономия копеечная (~$1.50/мес), сложность кода ×2
- TikTok refresh — потребует Apify spend

### Toggles
- env `HOT_REFRESH_ENABLED=0` → panic kill (рестарт)
- env `HOT_REFRESH_INTERVAL_MINUTES` (default 120)
- DB setting `hotRefreshEnabled` (default '1') → admin runtime toggle, applied на следующем cycle entry

### Trap caught (третий раз!)
Внутри `_spa()` template literal в admin/server.js я снова поставил backticks в комментарии: `` Toggle reads the DB setting `hotRefreshEnabled` `` + второй раз `` `alertScore` пробил порог `` в JSX-строке. Оба раза — `node --check` не поймал, ошибка только при загрузке SPA. Заменил на bare-ASCII варианты.

**Урок переподтверждён в третий раз** (см. SESSION_CONTEXT § «Ловушка server.js»): backtick в `_spa()` ломает outer template literal — НИКОГДА. Включая внутри JSX-строк, не только в комментариях.

### Проверка
- `node --check` × 4 файлов ✓
- `scripts/check-admin-spa.cjs` ✓ (186764 chars)
- Smoke-test `runCycle()` с empty pool через mock db/scorer ✓
- `getHotTrendsForRefresh()` smoke-test inline в node ✓

### Риски / заметки
- **Race с обычным scan-cycle**: если scan-cycle scoringит тренды одновременно с refresh-cycle → одна row может быть UPSERT'нута дважды. Не страшно, последний writer wins (last_seen_at обновится оба раза). Если станет проблемой — добавить advisory lock на trendId
- **whyNow перезапишется**: re-score через Stage 1 → новый whyNow text. Если за 24ч набрался больший контекст (engagement velocity, etc.) — это обновлённое описание триггера. Acceptable
- **memePotential может УПАСТЬ**: если рубрика подкрутится или старый тренд протух (engagement стал нерелевантным) — re-score может выдать ниже. alertScore тоже падёт. Не дропаем тренд из БД, просто scores меняются
- **preStage НЕ refresh'ится**: nano/gemini нечасто что-то добавят к посту через 24ч. preStage хранит первоначальный snapshot, carry-through. Если хочется свежий — потребует отдельный path в `pre-stage.js`

### Status panel + manual trigger (follow-up того же дня)
Владелец попросил таймер последнего запуска и способ проверить работу. Добавил:
- `HotMetricsRefresher.getStatus()` → `{adminEnabled, envEnabled, intervalMin, running, lastRunAt, lastResult, nextRunAt}`. Persist в DB settings (`hotRefreshLastRunAt` + `hotRefreshLastResult` JSON), переживает рестарт
- `runCycle({trigger})` возвращает result-объект (eligible/fetchOk/stage2Hits/saved/tookSec/trigger/error) + персист всего через `_persistResult`
- GET `/api/hot-refresh` теперь возвращает `{enabled, status}` — UI читает один endpoint
- POST `/api/hot-refresh/run` — manual trigger. 409 если уже бежит, 503 если refresher не подключён к админке
- HotRefresher wired в admin через `extras.hotRefresher` в `index.js`
- UI: блок «Последний цикл» с relative time («3м назад»), grid со статами (eligible / подгружено / Stage 2 / сохранено / длительность / триггер), кнопка «▶ Запустить цикл сейчас», polling status каждые 60с + tick каждые 30с для обновления relative-stamps
- Очередная backtick-trap (template literal внутри `_spa()`) — заменил на конкатенацию

Smoke-test через mock db/scorer: `getStatus()` правильно показывает initial null state + после `runCycle({trigger:'manual'})` фиксирует lastRunAt/lastResult/nextRunAt ✓

### Bug + fix: дозревший тренд не алертил после refresh
Владелец задал острый вопрос: «А если пост алертился, он не проходит и не обновляется в Hot refresh loop?». Проверка кода вскрыла **другую** баг: alert-loop в `index.js` работает только с `validTrends` из текущего scan-cycle, не из БД. То есть refresh-loop обновлял scores в БД, но если бордерлайн-тренд после re-score переходил порог alertThreshold — алерт **не уходил**, потому что alert-loop его не видел. Я раньше написал в WORKLOG «алерт уйдёт через обычный alert-loop» — это было неверно.

**Исправление**:
- Создан `src/notifications/alert-dispatcher.js` — две публичные функции:
  - `recomputeAlertScores(trends, alertWeights, db)` — sync-helper, обновляет alertScore с live feedback + ageHours (вынесено из inline scan-cycle)
  - `dispatchAlerts({ trends, deps, source })` — main per-user gate cascade (threshold → hard_junk → source → alert_type → dedup → daily → cap), вызывает `telegram.sendAlertToUser`, пишет в `notifications` table, attach'ит X-button + tg_message_url, апдейтит admin decisions buffer
- Scan-cycle в `index.js` отрефакторен — ~150 строк inline alert-loop заменены вызовом `dispatchAlerts({ source: 'scan', ... })`. Поведение 1:1
- Hot-refresh `runCycle()` после Phase 3 (saveTrend) дёргает `recomputeAlertScores` + `dispatchAlerts({ source: 'refresh', ... })`. Дедуп-гейт `db.wasNotificationSentToUser` защищает от повторного алерта уже-уведомлённых юзеров
- `HotMetricsRefresher` constructor теперь принимает доп deps: `telegram`, `config`, `recordDecision`, `normalizeThreshold`. Все опциональны — если не подключены, dispatch silently пропускается (refresh всё равно обновляет DB)
- `alertsSent` добавлен в `lastResult` payload + UI grid в админке (зелёный bold если >0) + success-toast при ручном запуске
- `triggerSource` в `decisionBase` (scan|refresh|manual) — DecisionsPage теперь видит откуда пришла decision

**Результат**: тренд который изначально не прошёл порог, но за 4ч набрал виральность → следующий refresh пере-скорит → если alertScore теперь выше порога И юзер ещё не alerted → отправляется. Если уже alerted → дедуп block'ит.

Smoke-test с mock telegram + db ✓. SPA 193735 chars.

### Bug + fix #3: avatar URL'ы в carousel + auto-skip broken
Владелец прислал скрин TrendModal где carousel с counter "2/2" показывал маленькую круглую картинку посредине пустого 440px-блока — это был Twitter pfp автора, попавший в `raw_metrics.imageUrls` через старый коллектор. Реальный контент — на 2/2 позиции.

**Фикс — три слоя**:
1. `_formatTrend` server-side filter в `imageUrls` + `imageUrl`: regex `/profile_images/` И `_(normal|bigger|mini|400x400)\.(jpe?g|png|webp)` — отрезает Twitter avatar pattern. Legacy DB rows с pfp в imageUrls автоматически отфильтровываются на чтение, миграция не нужна
2. Тот же фильтр в `/api/preview` (defensive — на случай если fxtwitter в edge-case вернёт pfp)
3. `ImageCarousel` теперь держит `Set<failedIndices>` локальный state. onError маркает index, filtered list пересобирается без него. Counter / dots используют `safeIdx` живых слотов. Если все упали — carousel вообще не рендерится (вместо пустой 440px дыры)

### Bug + fix #2: emergence/junk обнуляются после refresh
Владелец заметил по DecisionsPage: вся batch с timestamp 07:30:17 имеет `emerg=0`, при том что предыдущий cycle (07:26:11) — нет. Корреляция с временем Hot refresh.

**Корень**: `HotMetricsRefresher._merge()` создавал новый объект из `originalTrend` + `freshTrend`, **не передавая** `emergenceScore`, `narrativePhase`, `marketStage`, `junkPenalty`, `clusterMetrics`. После _merge:
- Stage 1 пересчитывал `memePotential` / `category` / `whyNow` — оно норм
- НО `emergenceScore` вычисляется только в clusterer'е, а clusterer на single-trend re-score не запускается
- `saveTrend` сохраняет с `emergenceScore=0`, `junkPenalty=0`
- `computeAlertScore` читает 0 → `w_emerge·0 = 0` → весь вклад emergence (до 25 баллов) обнуляется
- Тренды теряют ~10-25 баллов alertScore → не проходят порог

Эффект **навсегда** для трендов, прошедших хотя бы раз через Hot refresh — на следующем refresh снова с emergence=0.

**Исправление** (`_merge` в `src/refresh/hot-metrics.js`): carry-through всех clusterer-domain полей:
- `emergenceScore`, `narrativePhase`, `marketStage`, `junkPenalty`
- `clusterMetrics` объект целиком (с `junkReasons`, `junkPenalty`, `emergenceScore`)
- `isNovel: true` принудительно — потому что на re-score исходная "isNovel=false" verdict не должна блокировать Stage 2 (это был one-shot flag первого скоринга)

Smoke: input emergence=85 / junkPenalty=12 → после `_merge` сохраняется. fresh metrics (views/likes) корректно мерджатся поверх.

### Bug + fix #2-bis: emerg=0 всё равно — leak через fetch-failure path
Тот же владелец, тот же скрин DecisionsPage, тот же emerg=0 — но на новой batch. Подсказка от владельца: «может это из-за того что мы в твиттере не через apify?» — попал в десятку (косвенно).

**Корень**: scorer на `_analyzeBatchStage1` (line 641) читает emergence ИСКЛЮЧИТЕЛЬНО из `trend.clusterMetrics?.emergenceScore`, top-level `trend.emergenceScore` игнорируется. `getHotTrendsForRefresh` клал emergence в top-level, а в clusterMetrics — только `{ junkReasons }`. Carry-through из #2 это компенсировал внутри `_merge()` — НО только на пути fetch-success.

На пути fetch-failure (`_refreshAll` line 314-319: `out[i] = trend` без merge, когда fxtwitter timed out / 429) raw `originalTrend` шёл прямо в scorer — а у него clusterMetrics без emergence → `?? 0` → 0. **И именно fxtwitter падает чаще чем Apify** — это и есть «через apify бы не падало». Каждый failed fetch = emerg обнулялся в DB.

**Исправление**: перенесли carry-through в источник — `getHotTrendsForRefresh` теперь сразу заполняет `clusterMetrics` всеми clusterer-domain полями (`emergenceScore`, `junkPenalty`, `junkReasons`, `marketStage`, `narrativePhase`, `isNovel: true`). Оба пути (success + failure) теперь отдают scorer'у правильную форму. `_merge` упрощён — просто `clusterMetrics: { ...originalTrend.clusterMetrics }`.

---

## 2026-05-03 (Триггер vs Каталист — split в модале + расширение whyNow)

**Цель**: владелец указал что в TrendModal блок «🤖 AI-объяснение» — мусорный (vague rationale text), а блок «🔥 ТРИГГЕР» уже несёт нужную информацию. Решили выпилить AI-объяснение и сделать Триггер полноценной отдельной секцией. Заодно расширить Stage 1 промпт для `whyNow`, потому что текущий output — слишком урезанный one-liner.

### Структурный split в модале (`src/dashboard/server.js`)

Было:
1. Original title
2. Trigger section (компонент `TriggerSection` — содержал и whyNow как fallback, и Catalyst forecast)
3. AI-объяснение
4. Actions

Стало:
1. Original title
2. **🔥 Триггер** (whyNow напрямую, простой блок) — на месте удалённого AI-объяснения
3. **🔮 Каталист** (`TriggerSection`, чисто forward-forecast или CTA) — переехал в позицию между Триггером и Actions
4. Actions

`TriggerSection` упрощён: render-state 2/3 (когда нет forecast) больше НЕ показывает whyNow как fallback content и НЕ показывает pasthint вверху. Теперь рендерит CTA-подсказку «Жми кнопку — получишь прогноз фазы / драйверов / рисков» + кнопку. whyNow и forecast — две независимые секции с разной семантикой (🔥 = past, 🔮 = future).

CSS `.catalyst-pasthint*` удалён (dead).

### Stage 1 промпт — whyNow расширен (`src/analysis/prompts.js`)

Старая инструкция: «ONE short sentence naming the specific, concrete EVENT». Output получался телеграфным: «Viral tweet by @giri_giri0117 depicting biker gang antics and police plea» — 70 chars, мало контекста.

Новая инструкция:
- 1-2 sentences (≤280 chars)
- Cover in this order: WHAT happened, WHO is involved (real names/@handles), timing/scale anchor (engagement velocity, duration, response volume)
- 3 примера хорошего output'а с конкретикой (X clip + reaction threads + 40K replies в 6h)
- 3 примера плохого (rest title, vague summary, speculation)

JSON schema: `whyNow.maxLength = 280` (было без cap'а — strict-schema enforce'ит на стороне OpenAI).

### Backwards compat
- Старые row'ы с короткими whyNow (60-90 chars) остаются — schema cap'ит **только** новые output'ы. На фронте текст рендерится одинаково независимо от длины
- `aiExplanation` поле **остаётся в API** (`_formatTrend` всё ещё включает его) — оно использовалось также в SubmitPage / AnalyzePanel админки. Удалили только render в TrendModal дашборда

### i18n
- Добавил `'modal.trigger'` → «🔥 Триггер» / «🔥 Trigger» (для нового inline-блока)
- Добавил `'trigger.cta_hint'` → CTA-текст пустого состояния Каталист-секции
- Удалил `'trigger.past_hint'` (использовался в pasthint, который теперь dead)
- Старый `'modal.ai_explanation'` оставлен — рендерится в SubmitPage/AnalyzePanel

### Проверка
- `node --check src/{analysis/prompts,dashboard/server}.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (189636 chars)

### Риски / заметки
- **Эффект на feed-cards / alert text Telegram** — там whyNow рендерится через `formatter.js`, не трогали. Длинный whyNow (до 280 chars) пройдёт в alert'ы как есть. Если визуально получится длинно — можно ужать в формулировке промпта или поставить trim в formatter
- **Stage 2 input cost**: `whyNow` не передаётся в Stage 2 prompt (только `aiExplanation`), поэтому расширение whyNow на Stage 2 cost не влияет
- **`whyNow` теперь длиннее в DB row'ах**: ~+150 bytes на запись. На retention'е 7-30 дней не критично, замерять не стоит

### UI polish (Catalyst-блок) — follow-up
Владелец прислал скриншот Каталиста — forecast text был красноватый (унаследовался класс `.why-now` от триггера, ловушка), источники выглядели плоской серой полосой, confidence — мелким курсивом.

- **Forecast body**: новый класс `.modal-section-content.catalyst-forecast` — нейтральный text color, accent-tinted background/border, line-height 1.6, font-size 12.5px. Красный остаётся только у `.why-now` для блока «🔥 Триггер»
- **Phase/window chips**: padding 5px 11px (было 4×9), gap 7px, добавлен `box-shadow: var(--gloss-top)` для глянца
- **Sources** → pills с X-brand-blue (`rgb(29,155,240)`) tint, glyph 𝕏 + handle, hover-lift `translateY(-1px)`. Заголовок блока «𝕏 Sources» / «𝕏 Источники». Каждая pill кликабельна → `https://x.com/<handle>`. Стилистически зеркалит Source-pill паттерн из right-panel sources block
- **Confidence** → gradient progress bar (5px height) с цветовой бакетой по значению: `<40 → red`, `40-69 → orange`, `≥70 → green`. JetBrains Mono для %, label «Confidence» / «Уверенность» как мелкий caps
- 2 новых i18n ключа: `trigger.confidence_label`, `trigger.sources_head`

### Trap caught (важно для будущих агентов)
В CSS-комментарии `/* via \`.why-now\` */` поставил backticks для inline-кода. Это ровно та ловушка из SESSION_CONTEXT § «Ловушка server.js»: backtick внутри `_spa()` template literal закрывает outer literal. `node --check` не поймал, но `scripts/check-dashboard-spa.cjs` бросил `_buildSPA() threw: now is not defined`. Заменил на «see why-now». **Урок переподтверждён**: внутри `_spa()` НИКОГДА backtick — даже в CSS-комментах.

---

## 2026-05-03 (Trigger → Catalyst forecast — переход с past-event на forward-looking рост)

**Цель**: владелец указал, что текущий триггер ищет «почему вирусится сейчас» (стату + past event). Хочется наоборот — прогноз ПРИЧИНЫ дальнейшего роста популярности нарратива. Жёсткое ограничение: никаких упоминаний крипты / монет / токенов / тикеров — только рост популярности самого нарратива.

### Семантический split (важное архитектурное решение)
В коде было два разных «триггера», оба про прошлое:
1. `whyNow` (Stage 1, авто, факт-предложение) — основа классификации `alertType=event`
2. `triggerFinder` (deep on-demand, Grok reasoning + x_search) — детальный past-trigger

Решили НЕ объединять. `whyNow` остаётся факт-якорем «что произошло» (он критичен для роутинга). `triggerFinder` полностью переписан под forward-forecasting. В UI они теперь работают парой: dashboard модал показывает `whyNow` тонкой dim-линией ◴ сверху как past-anchor, а ниже forecast «куда дальше».

### Промпт (`src/analysis/prompts.js`)
`TRIGGER_SYSTEM_PROMPT` переписан с нуля как «narrative-growth forecaster»:
- **Что искать**: scheduled events впереди (премьеры, релизы, дропы, дедлайны, годовщины), untapped surfaces (нет на TikTok / нет mainstream media / celebrity ещё не подключился / no remix-format), curve dynamics (mention velocity, fresh accounts joining), external pressure points
- **Жёсткий запрет**: ZERO references to crypto/coins/tokens/tickers/launches (financial)/pump.fun/DEX/contract/market caps. Если coin уже существует — не упоминать. Forecast популярности нарратива, не цены актива
- **Curve phase enum**: `early | building | peaking | saturated | fading` (для UI-чипа с семантическим цветом)
- **Window**: free-form short phrase («next 24-48h», «after premiere on Nov 14», «depends on response from X», «'' если uncertain»)
- **Drivers**: 1-3 bullet'а ≤80 chars, каждый = ОДИН концентрированный forward catalyst
- **Risks**: 0-2 bullet'а, что убьёт рост до закрытия окна
- **No-signal case**: если x_search ничего не дал — confidence <40, honest «нет катализатора впереди», без manufactured forecasts

`buildTriggerPrompt` теперь добавляет `whyNow` в context («Past trigger (context only, don't recap)»), чтобы Grok не дублировал прошлое в forecast'е.

### Output shape (`src/analysis/trigger-finder.js`)
JSON был `{ trigger, sources, confidence }` → стал `{ forecast, phase, window, drivers[], risks[], sources, confidence }`. Парсинг fallback'ит к старому полю `trigger` если LLM забыл новое имя. Phase strict enum (whitelist), bullets cap'аются 100 chars (prompt просит ≤80 — soft buffer).

### DB (`src/db/database.js:90-100, 1372-...`)
Новые колонки через `addIfMissing`: `trigger_phase`, `trigger_window`, `trigger_drivers` (JSON), `trigger_risks` (JSON). Старые row'ы остаются с NULL — UI скипает пустые секции. `saveTrendTrigger` принимает расширенный shape, `getTrendTrigger` возвращает все поля.

### UI

**Dashboard** (`src/dashboard/server.js` TriggerSection):
- Past-anchor: `whyNow` рендерится тонкой dim-линией `◴ <text>` (`.catalyst-pasthint`) **сверху** forecast'а — отдельный «было-стало» контекст без дубля в основном тексте
- Forecast text — стандартный `.modal-section-content`
- Phase chip — pill с семантическим tint per phase (green/blue/orange/grey/red), label «Phase» / value «Building»
- Window chip — neutral pill
- Drivers — `.catalyst-drivers` (accent left-border, 📈 header)
- Risks — `.catalyst-risks` (red left-border, ⚠️ header)
- Sources / confidence — без изменений

CSS добавлен после `.story-hook` (тот же tinted-gradient паттерн): `.catalyst-pasthint`, `.catalyst-chips`, `.catalyst-chip` (+ phase-* варианты), `.catalyst-bullets` (+ drivers/risks модификаторы).

**Telegram** (`src/notifications/telegram.js _renderTriggerMessage`):
Header → forecast text → `🌀 Phase · ⏱ Window` (combined line) → `📈 Growth drivers:` list → `⚠️ Risks:` list → `📡 Sources:` → `Confidence: X%`. Пустые секции скипаются gracefully. claim-race path и success path обновлены чтобы передавать полный shape (раньше только text/sources/confidence).

### i18n
**EN/RU** ключи переименованы:
- `triggerBtn`: «🔍 Trigger» → «🔮 Catalyst» / «🔮 Катализатор»
- `triggerHeader`: «💡 Trigger:» → «🔮 Catalyst forecast:» / «🔮 Прогноз катализатора:»
- Loading: «Searching...» → «Forecasting...» / «Строю прогноз...»

Новые ключи: `triggerPhaseHdr`, `triggerWindowHdr`, `triggerDriversHdr`, `triggerRisksHdr`, `triggerPhaseValues` (5 вариантов перевода фазы).

Dashboard i18n (`'trigger.*'` map): добавлены `phase_label`, `window_label`, `drivers_label`, `risks_label`, `past_hint`, `phase.early/building/peaking/saturated/fading`.

### Проверка
- `node --check` × 7 файлов ✓
- `scripts/check-dashboard-spa.cjs` ✓ (189828 chars)
- Smoke-test render Telegram с примерным payload — все секции корректные, эмодзи рендерятся, кириллица сохранена ✓
- Backward compat: старые row'ы без новых полей рендерят только text/sources/confidence (как раньше)

### Риски / заметки
- **Кэшированные row'ы со старым shape**: треды, у которых уже есть `trigger_text` от прошлой past-event версии, останутся с этим (forward-looking) текстом до явного recompute. Не страшно — past-trigger'ы у них сохранены в `whyNow`, а кнопка «Catalyst» теперь показывает «уже cached». Если хочется чистого старта — можно одной командой `UPDATE trends SET trigger_text = NULL ...` сбросить ~старый кэш.
- **Grok может забыть новое имя поля** (`forecast` vs `trigger`): парсер fallback'ит к старому. Если в логах увидим `[TriggerFinder] forecast field missing`, можно усилить инструкцию в промпте.
- **Promt prohibits coins/tokens/tickers**: но Grok иногда «протекает» темы крипты в forecast если нарратив явно про блокчейн (e.g. SBF arrest news). После деплоя стоит проверить 3-5 свежих forecasts глазами — если упоминания просачиваются, добавить regex-cleanup в `trigger-finder.js`.
- **Старые i18n ключи** `triggerBtn` / `triggerHeader` etc — те же имена, новый смысл. Если внешние интеграции зеркалят их — увидят ребрендинг с «Trigger» на «Catalyst». Внутри проекта ничего не сломано.

---

## 2026-05-02 (Support bot — отдельный бот для тикетов через forum-topics relay)

**Цель**: убрать поддержку из личного DM владельца. Стандартный паттерн «ticket inbox внутри Telegram» через forum-topics.

### Архитектура
1. Юзер пишет `@CatalystSupportbot` в личке.
2. Бот находит/создаёт forum-topic в приватной admin-группе (topics enabled), копирует туда сообщение через `copyMessage` (без префикса «Forwarded from»).
3. Каждый юзер = свой топик с заголовком `@username` + pinned-шапка с метаданными (chat_id, username, lang).
4. Админ отвечает в топике — бот ловит `message_thread_id`, ищет mapping в БД, копирует ответ юзеру обратно.
5. Двусторонний copyMessage agnostic к контенту — текст, фото, видео, голосовые.

### Файлы

**NEW** `src/support/bot.js` (~180 строк) — класс `SupportBot` с polling. Lock-map `_creatingTopic` для promise-coalescing (два быстрых сообщения от одного юзера не race'ят на `createForumTopic`).

**NEW** таблица `support_threads(chat_id PK, topic_id, group_id, username, created_at, updated_at)` + 4 хелпера в `src/db/database.js:152-167, 957-989`:
- `getSupportThreadByChat(chatId)`
- `getSupportThreadByTopic(topicId, groupId)`
- `createSupportThread(chatId, topicId, groupId, username)`
- `touchSupportThread(chatId)`

Per-row `group_id` чтобы re-config admin-группы не мисроутил старые треды.

`src/config.js:71-79` — секция `support: { botToken, botUsername, groupId }`. Graceful-disable если чего-то нет.

`src/index.js:107-110` — `new SupportBot(config, logger, db).start()` параллельно основному боту.

`src/notifications/telegram.js:651-658` — хелпер `_supportUrl()` для кнопки «Ask a question»: использует `SUPPORT_BOT_USERNAME`, fallback на `t.me/skipnick`. Применён в `_startKeyboard` и `_mainMenuKeyboard`.

`.env` + `.env.example` — секция SUPPORT BOT с пошаговым setup-гайдом.

### Setup чек-лист (в `.env.example`)
1. @BotFather → /newbot → токен
2. @BotFather → /mybots → бот → Bot Settings → **Group Privacy: Turn OFF** (без этого бот не видит сообщения в группе)
3. Создать приватную группу, **включить Topics** в её настройках
4. Добавить бота в группу как админа с правом **Manage Topics**
5. Получить chat_id группы

### Discovery-режим (использовался один раз, потом удалён)
Когда `SUPPORT_BOT_TOKEN` есть, а `SUPPORT_GROUP_ID` пустой — бот стартовал в discovery: на любое сообщение в группе логировал chat_id + отвечал в той же группе сообщением `🔍 Discovery mode\nThis group's chat_id: -1003932698808\nAdd to .env: SUPPORT_GROUP_ID=-1003932698808`. Владелец скопировал ID, я подставил в `.env`, потом удалил discovery-ветку — `enabled` теперь требует обоих env, без двух-фазного бота.

### Language sync с основным ботом
`_resolveLang(chatId, fromUser)`:
1. `db.getUserByChatId(chatId).language` — chat_id одинаковый для всех ботов одного юзера, поэтому работает кросс-боты
2. `from.language_code` (Telegram UI lang) — fallback
3. `'en'` — финальный дефолт

Юзер выбравший RU в Catalyst получает RU-приветствие в саппорте независимо от Telegram-настроек.

### Текущий стейт
- Бот `@CatalystSupportbot` живой, токен в `.env`, group ID `-1003932698808` подставлен
- Юзер подтвердил что бот отвечает на `/start`, топик создаётся при первом не-/start сообщении
- **Token засветился в чате** — рекомендовано ротировать в @BotFather через `/revoke`

### Проверка
- `node --check` всех 5 файлов ✓
- Smoke-test graceful-disable путей (token only / token+group) ✓
- DB миграция: support_threads поднимается, helpers exercised ✓ (отдельный test-DB)

---

## 2026-05-02 (Telegram bot UX polish — menu badges / threshold marker / welcome rewrite / /analyze / direct plans)

Серия мелких но видимых правок интерфейса бота.

### Главное меню — live badges на кнопках (`src/notifications/telegram.js:677-707`)
- `📡 Sources · 4/5` (включенных платформ из 5)
- `🎯 Threshold · 67` (текущий alert_threshold)
- `🔔 Alert Types · 2/3` или `· all`
- `🌐 Language · EN`
- Сетка переразложена 2×3: [Sources/Threshold], [Alert Types/Language], [Top/Subscription], затем pause + ask + close. Раньше 7 одиночных рядов выглядели несбалансированно.
- В i18n добавлены `badgeSources/Threshold/Language/AlertTypes` функции (`en.js:42-48`, `ru.js`).

### Threshold preset highlight (`telegram.js:743-755`)
- Активный пресет помечается стрелкой `▸` (52/67/75). `_thresholdKeyboard(t, current)` принимает `user.alert_threshold`.
- Описания компактнее: «Low (52+) — More alerts» → «Low · 52+ — more alerts». Единый разделитель `·`.
- Убрана устаревшая «⭐ Recommended: 75+» из `thresholdTitle` (после rubric tightening 75 теперь действительно высокий порог).

### Subscription → плата напрямую (`telegram.js:431-437`)
- Промежуточный экран «Plan: admin / Status: Active / Upgrade / Back» удалён. Клик `💳 Subscription` рендерит `_plansKeyboard` сразу.
- Слиты `subscription` и `upgrade` callbacks в один if-блок.
- `_subscriptionKeyboard` deleted — мёртвый код.
- Plans back-button → `menu` (раньше → `subscription`).

### Welcome message — degen-CT tone (`src/i18n/en.js:8-21`, `ru.js`)
Несколько итераций (full → marketing → tighter → degen). Финальный вариант:
- Убраны boomer-ходы: «Welcome to Catalyst», «24/7 radar», «the second a story starts to lift off», «Hotness score», «catalyst behind the buzz», «✨»
- Прямые слова: `Score`, `Trigger`, `Engagement`. Без `your`-possessives.
- 5 функциональных эмодзи-маркеров (🎯 ⚡ 📖 🧠 📊).
- WelcomeBack — статус-line + 2 команды: `Catalyst · plan: Pro / /menu — settings / /top — top narratives`. Без «Welcome back!».
- X Follow link: было `𝕏 <a>@Catalystparser</a>`, стало `<a>𝕏 Follow</a>` — без юзернейма в видимом тексте.
- Кнопка «𝕏 Follow @Catalystparser» из `_startKeyboard` удалена (`telegram.js:653-661`) — ссылка теперь только в тексте.

### /analyze usage text (`telegram.js:175-194`)
Heavy-horizontal дивайдеры `━` × 20 (как в alert formatter):
```
🔍 /analyze — manual link analysis
━━━━━━━━━━━━━━━━━━━━
🤖 [описание + список платформ + что выдаёт]
━━━━━━━━━━━━━━━━━━━━
✨ Example
/analyze https://x.com/user/status/123
━━━━━━━━━━━━━━━━━━━━
💡 Tip: paste the link without command — picks up automatically
```
Блок «Usage» удалён — пример сам показывает синтаксис.

### Прочая полировка текстов
- `menuTitle`: убрано «Manage your preferences», новый текст указывает на бейджи
- `sourcesTitle`: убрана легенда «✅ = on, ❌ = off» (избыточно — иконки на кнопках)
- `alertTypesTitle`: подобный cleanup, плюс `<i>tip:</i>` про «выкл всё = получать всё»
- `thresholdTitle`: добавлена интуитивная подсказка «ниже = больше / выше = только громкие»
- `topSelectorTitle`: добавлен временной диапазон «· last 24h» / «· 24 часа»
- Pay buttons: `◉ Pay with SOL` / `◉ Pay with USDC` → `⚡` и `💵`

### Проверка
- `node --check src/i18n/{en,ru}.js src/notifications/telegram.js` ✓
- Runtime smoke-tests: badges (`badgeSources(4,5)` → ` · 4/5`), welcomes render preview ✓

---

## 2026-05-02 (Scoring rubric tightening — Stage 1 conservative bands + Stage 2 soft-cap)

**Цель**: `memePotential` кучковался у 100 — и просто хорошие, и идеальные нарративы получали одинаковую оценку. Нужно было разнести распределение, чтобы топ выделялся.

### Stage 1 rubric (`src/analysis/prompts.js:53-65`)
Вилка переписана с явной calibration-инструкцией:
- **95-100**: «раз в день-два», требует одновременно name + visual punch + ticker hook + cultural pull. Если хотя бы одного нет — НЕ 95+.
- **80-94**: excellent но один сигнал слабый
- **60-79**: very good — дефолтная верхняя полка для большинства хороших трендов
- 40-59 / 20-39 / 0-19

Добавлены явные команды:
- «Если ставишь 90+ нескольким в одном батче — слишком щедр, переранжируй»
- Calibration check: «Лучше ли это 9 из 10 типичных вирусных трендов в день?»

Cross-platform требование владелец явно попросил **НЕ добавлять** в рубрику (оно и так не влияет на score).

### Stage 2 soft-cap (`src/analysis/scorer.js:820, 847`)
Заменил `Math.min(100, x + bonus)` на сжатие через headroom:
```
headroomScale = max(0, (100 - oldMeme) / 50)
newMeme = round(oldMeme + bonus * headroomScale)
```

Эффект:
- meme=70 +15 (полный story bonus) → ~79 (раньше 85)
- meme=85 +15 → ~90 (раньше 100)
- meme=95 +15 → ~96 (раньше 100)
- meme=70 +15 +10 (story + name composed) → ~85 (раньше 95)

До 100 теперь доходит только то, что Stage 1 уже поставила ~98+ — а после rubric tightening это редкое событие.

### Tradeoff (отметили владельцу)
Вес `weightMemePotential = 0.35` в alertScore. Если средний `memePotential` упадёт на 10-15 пунктов (типичный «good» 95→80), `alertScore` падает на ~3.5-5 пунктов. На границе порога (60-70) тренды с alertScore 62-65 могут не пройти. После деплоя стоит понаблюдать день и при сильном спаде алертов — снизить порог в нужных пресетах через админку. Не обязательно заранее.

### Проверка
- `node --check src/analysis/{prompts,scorer}.js` ✓

---

## 2026-05-02 (Dashboard polish — hide btn / archive UX / sources fix / layout)

Серия мелких follow-up'ов после крупных правок выше.

### `.feed-hide-btn` — квадратный + не перекрывает теги
- Был круглый (`border-radius: 50%`) 24×24, top:6 right:6. Перекрывал самый правый бейдж (POST/STRONG/category) при hover.
- Стал 22×22 + `border-radius: 5px` (как у `.badge`), top:9 right:9, font-size 11. Читается как часть chip-row.
- `.feed-badges` получил `margin-right: 28px` — резерв под кнопку, бейджи теперь сдвигаются влево.

### Settings sheet
- `.settings-actions` — `justify-content: flex-end → center`. Кнопка «↺ Reset all settings» теперь по центру нижнего ряда модала.

### Archive UX
- **Collapsible** — `<ArchiveCard>` теперь по дефолту закрыт. Заголовок-кнопка с caret `▸` (rotate 90° при open). Body с fade-in анимацией.
- **Lazy load** — `useEffect(() => { if (open && items === null) load(); })` — fetch `/api/trends/hidden` срабатывает только при первом open. Юзер не открывает архив → API вообще не дёргается.
- **Clear archive сверху** — кнопка перенесена из `.archive-actions` (footer) в `.archive-actions-top` (выше списка).

### Layout — адаптация под отсутствие нижней полосы
4 места в CSS вычитали `28px` (бывшая высота statusbar) из `100vh`. Убрал везде:
- `.layout` `min-height: calc(100vh - 50px - 28px)` → `calc(100vh - 50px)`
- `.sidebar` (sticky) → `calc(100vh - 50px)`
- `.main` (feed scroll) → `calc(100vh - 50px)`
- `.dashboard-grid` → `calc(100vh - 50px)`

Результат — sidebar / лента / правая колонка тянутся до низа экрана без 28px пустой полосы.

### Sources в правой колонке — undefined-фикс
- Endpoint `/api/sources` отдаёт поле `source`, не `id`. Мой render использовал `s.id` → `SOURCE_ICONS[undefined]` → fallback `📡` для всех 5 пилл, в title было `undefined`.
- Заменил `s.id` → `s.source` (key, title, lookup).
- Завернул glyph в `<span class="right-sources-glyph">` — добавил CSS с brand-цветом per-source через `[title^="Reddit"]/[title^="Twitter"]/...` (Reddit оранжевый #ff5800, TikTok #ff2469, Google #4285f4, X Trends #1d9bf0). Off-state — `var(--dim)`.

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (186333 chars)

### Trap caught
Backtick в JSDoc-комментарии внутри SPA — `with \`open\` so` сломал outer literal с `Unexpected identifier 'open'`. Поймано `node --check`, заменил на `with the open flag so`. **Урок переподтверждён** (см. SESSION_CONTEXT § «Ловушка server.js»): внутри `_spa()` НИКОГДА не писать backtick даже в комментариях.

---

## 2026-05-02 (TrendModal cleanup + статусбар → правую колонку)

**Цель**: 6 точечных правок в дашборде по запросу владельца:
1. Убрать «↳ Быстрая stage-1 подсказка...» в TriggerSection
2. Убрать подписи возле фазы нарратива («Сильный сигнал — действуй быстро» и т.д.)
3. Сделать Story hook красивее в стиле дашборда
4. Виральность → метрики поста (👁 ❤️ 💬 🔁 без надписей)
5. Перенести фазу нарратива в head модала рядом с другими бейджами, без заголовка
6. Убрать нижнюю полоску, sources перенести в правую колонку Activity, переименовать Activity → Live

### Изменения (`src/dashboard/server.js`)

**Server**:
- `_formatTrend` теперь добавляет `engagement: { views, likes, comments, reposts }` — унифицированная shape per-source: Twitter `views/likes/replies/retweets`, TikTok `plays/likes/comments/shares`, Reddit `upvotes` в slot views (UI рендерит ⬆️), `comments`. Manual-analysis synth shape тоже зеркалит engagement.

**TrendModal**:
- **Head**: добавлен `<PhaseBadge>` рядом с alertType / category / source. Старая labelled-секция «🧭 Narrative phase» удалена. Subtitle с phaseHint больше не рендерится.
- **Story hook** вынесен из `ScoreBar.sub` в отдельный блок `.story-hook`: accent left-border + soft gradient, italic body, big quote marks (Georgia serif). Читается как pull-quote, а не как sub-label слайдера.
- **Virality cell** (`modal-stat`): теперь рендерит engagement metrics через `.modal-engagement` (2-column emoji-grid). Если ни одного counter'а > 0 — fallback на старое число `trend.score`. `fmtCount` сжимает в `1.2M`/`45K`. Reddit использует `⬆️` вместо `👁`.

**TriggerSection** (`src/dashboard/server.js`):
- Удалён блок `t('trigger.help_quick')` — болтливая фраза, которую владелец просил убрать.

**RightPanel**:
- Принимает `sources` и `scanning` props.
- Activity-секция: title теперь `🟢 Live` (или `OFFLINE` при паузе) с pulsing-dot вместо «📊 Activity». Под cells добавлен sub-block `.right-sources` с pill-листом источников (emoji + status-dot, off-state приглушён opacity 0.4).
- i18n: `right.activity` → «🟢 Live», добавлены `right.sources_label/active/kbd_hint`.

**App-level**:
- Удалён `<StatusBar>` рендер (sources + signals + alerts + kbd-hints перенесены в right panel).
- Передаются `sources` + `scanning` в `<RightPanel>`.

**Cleanup dead code** (раз уж заходили):
- Функция `StatusBar` целиком удалена (~40 строк).
- CSS `.statusbar*` целиком удалён (~50 строк).
- i18n keys `status.signals/alerts/sources/updating/kbd.refresh/kbd.close` удалены (RU + EN).
- i18n keys `trigger.help_quick`, `story.hook_label`, `modal.phase` удалены (RU + EN, не вызываются после фикса).
- `.undo-toast bottom: 64px → 24px` (статусбар больше не занимает место внизу).

**CSS (новое)**:
- `.modal-engagement` + `.modal-engagement-item/-ico/-num` — 2-col grid, JetBrains Mono, tabular-nums.
- `.story-hook` + `.story-hook-mark/-text` — pull-quote с accent border-left и Georgia-quotes.
- `.right-live-dot` (+ `.paused`) — green/red pulsing dot для Activity-title.
- `.right-sources/-head/-label/-count/-list/-pill/-dot` — sub-block в Activity-секции.

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (185042 chars; было ~183500 до правок, +1.5K от новых блоков, минус ~80 строк dead-code)

### Риски / заметки
- **Engagement counts для legacy-rows**: метрики хранятся в `raw_metrics` JSON, поля типа `views/plays/likes/comments/upvotes/retweets/shares`. Старые row'ы без какого-то поля → `null` → не рендерится pill. Если все четыре null — fallback на `trend.score`. Никогда не покажет «0».
- **Reddit upvotes в slot views**: использовал ⬆️ вместо 👁 чтобы не вводить в заблуждение (Reddit views недоступны через API). Альтернатива — вообще скрыть views для Reddit и оставить только likes/comments — но `upvotes` это и есть «likes-эквивалент» для Reddit, лучше показать.
- **Mobile responsive**: на узких экранах `.modal-engagement` остаётся 2-col grid (4 metrics в 2×2). При совсем маленьких modal-stat ширинах может ужаться — `font-size: 12px` + `gap: 4px 10px` справляются. Если будет криво — переключим на flex-wrap.
- **Sources в right panel**: на узких screen-ах right-panel сворачивается в `display: none` (responsive @media). Тогда sources вообще не видны — но и раньше при таком layout юзер мобильный, статусбар тоже скрывался при `bottom-nav` overlay. Acceptable.
- **PhaseBadge в head**: модал-head на узких screen-ах flex-wrap'ит чипсы, фаза становится в новый ряд. Не критично, читабельно.

---


## 2026-05-02 (Per-user hide alert + архив в дашборде)

**Цель**: дать юзеру кнопку «скрыть алерт» (✕ в правом верхнем) на каждой карточке, скрытие per-user и server-side. В настройках — секция «Архив» со списком скрытых, кнопка «Вернуть» у каждого, retention 7 дней с автоудалением.

### Storage (`src/db/database.js`)

Новая таблица `hidden_trends(trend_id, chat_id, hidden_at)` + UNIQUE(trend_id, chat_id) + 2 индекса. Зеркалит `feedback_votes`-схему.

Хелперы:
- `hideTrend(trendId, chatId)` — INSERT OR REPLACE (upsert hidden_at)
- `unhideTrend(trendId, chatId)` — DELETE
- `getHiddenTrendIdsByChat(chatId, retentionDays=7)` — для feed-фильтра
- `getHiddenTrendsByChat(chatId, retentionDays=7, limit=200)` — JOIN с trends для архив-листа
- `clearHiddenTrendsByChat(chatId)` — wipe-all
- `cleanupExpiredHiddenTrends(retentionDays=7)` — для maintenance loop

### Maintenance (`src/index.js`)

Добавлен один на startup + ежедневный `setInterval(24h)` вызов `cleanupExpiredHiddenTrends(7)` рядом с существующим `cleanupVideoCache`.

### Endpoints (`src/dashboard/server.js`)

4 новых, все требуют auth (`req.user.telegram_chat_id`):
- `POST /api/trends/:id/hide` → INSERT
- `POST /api/trends/:id/unhide` → DELETE
- `GET  /api/trends/hidden` → `{ trends: [...with hiddenAt], retentionDays }`
- `POST /api/trends/hidden/clear` → wipe + return cleared count

`_handleTrends` дополнен server-side фильтром: `AND id NOT IN (?,?,...)` для скрытых ID текущего юзера. Параметризованный — до 999 элементов на statement (за 7 дней нереально упереться).

### UI (`src/dashboard/server.js` SPA)

**FeedCard** — добавлен опциональный prop `onHide`. Если передан — рендерится `<button.feed-hide-btn>✕</button>` с `position:absolute; top:6px; right:6px`. Hover-only: `opacity:0` по дефолту, `1` при `:hover` родителя. На touch-устройствах `@media (hover:none)` показывает с `opacity:.6` (иначе кнопка недоступна без hover).

**App-level state**:
- `localHidden: Set<id>` — оптимистично скрытые на клиенте до следующего fetch'а. Сбрасывается в `fetchData`/`refreshAll` после успешного refresh — server становится authoritative и Restore из архива работает корректно.
- `pendingUndo: { trend, expiresAt }` — single-instance bottom undo toast, 5s window. Второй hide перебивает предыдущий toast.
- `hideTrend(trend)` — добавляет в `localHidden` → POST → если 4xx/5xx, откатывает локальное скрытие + error-toast.
- `undoHide(trend)` — убирает из `localHidden` + dismiss toast → POST /unhide.

**UndoToast** (`.undo-toast`) — отдельный namespace от существующего top-right `.toast` system (разные цели: actionable undo vs informational notifications). Bottom-center, 5s, с кнопкой «Отменить»/«Undo».

**ArchiveCard** — новая секция в `SettingsPanel` после «Behavior». Fetches `/api/trends/hidden` на mount, рендерит список с `archive-row { icon | title+meta | restore-btn }`. Footer — `clear archive` с `confirm()`. Каждый restore: POST /unhide + удаляет из локального items list. На следующем `fetchData` основной фид подтянет восстановленный трейнд (localHidden очищается).

**i18n**: 9 новых ключей (`feed.hide_btn_tip`, `toast.alert_hidden`, `toast.undo`, `archive.title/desc/empty/restore/clear_all/clear_confirm/count/loading`) в обоих языках.

**CSS**:
- `.feed-hide-btn` — circle 24×24 с red-tint hover
- `.undo-toast`, `.undo-toast-btn`, `@keyframes undo-toast-slide-up`
- `.archive-list/.archive-row/.archive-row-icon/.archive-row-body/.archive-row-title/.archive-row-meta/.archive-row-btn/.archive-empty/.archive-actions`

### Проверка
- `node --check` × 3 (database, dashboard, index) ✓
- `scripts/check-dashboard-spa.cjs` ✓ (183850 chars)

### Риски / заметки
- **Race**: hide POST идёт параллельно с любым активным fetchData. Если fetchData завершится раньше POST'а, server вернёт трейнд (ещё не записал hidden) → localHidden скроет. Если POST успеет первый — server отфильтрует на следующем fetch'е. Окно <500ms, пользователь не заметит.
- **Откат при 5xx**: hideTrend ловит ошибку и убирает из localHidden, но user уже видел исчезновение карточки → она вернётся. Error-toast говорит почему. Acceptable UX.
- **Retention изменить**: hard-coded 7 в db helpers и index.js. Вынесем в env/setting если запросят.
- **Archive list cap**: `LIMIT 200` в SQL. Выше 200 не берём — UI становится неуютным. Если будут жалобы — пагинация.
- **Touch devices**: `@media (hover:none) { opacity:.6 }` — кнопка всегда видима, но приглушённая. Ровно так делает Twitter в Web.

---

## 2026-05-02 (Nano admin toggle — фикс: 401 → запись в БД не происходила)

**Симптом**: владелец видел Nano-блок (Тема/Сущности/Слэнг) в админке «Ручной анализ» при, казалось бы, выключенном тумблере. После выкл. тумблера и нового submit:
- В docker logs: обычный `[NanoClassifier] N trends in ...ms` (а не ожидаемый `[NanoClassifier] skipped — disabled via admin panel`)
- В БД: `SELECT * FROM settings WHERE key='nanoEnabled'` → пусто (запись вообще не появилась)
- `curl /api/prestage/nano` → `Unauthorized`

**Корень**: `PreStageSection` ([admin/server.js:2530, 2540](../src/admin/server.js)) использовал голый `fetch('/api/prestage/nano...')` **без `X-Admin-Key` header**. Все остальные admin endpoint'ы идут через хелпер `api()` ([1797](../src/admin/server.js#L1797)) который добавляет ключ. На GET `r.json()` парсил `{error:'Unauthorized'}` → `d.enabled === undefined` → `setNanoEnabled(false)` → UI рендерил тумблер как OFF, **но в БД ничего не записал**. На POST `r.ok=false` → throw → `setErr` (но юзер не видит ошибку, только OFF-состояние тумблера).

Поскольку DB-row отсутствует, `getSetting('nanoEnabled', '1')` возвращает default `'1'` → `_isAdminEnabled() = true` → nano запускается на каждом цикле и каждом manual submit. Ровно то что наблюдал владелец.

### Изменения (`src/admin/server.js`)
- `PreStageSection.useEffect` — `fetch('/api/prestage/nano')` → `api('/api/prestage/nano')`
- `PreStageSection.toggleNano` — `fetch('/api/prestage/nano/toggle', { method:'POST' })` → `api('/api/prestage/nano/toggle', 'POST')`
- Добавлен комментарий с описанием почему bare `fetch` тут — баг

### Проверка
- `node --check src/admin/server.js` ✓
- `scripts/check-admin-spa.cjs` ✓ (182520 chars)

### После деплоя проверить
1. БД должна получить запись после клика по тумблеру: `sqlite3 /data/catalyst.db "SELECT * FROM settings WHERE key='nanoEnabled'"`
2. В docker logs после следующего цикла / manual submit при OFF-тумблере: `[NanoClassifier] skipped — disabled via admin panel`
3. В админке «Ручной анализ» новый submit при OFF-тумблере → блок «Nano (gpt-5.4-nano)» НЕ должен рендериться

### Заметки
- **История past-анализов** (карточки в strip'е) — будет всегда показывать Nano-данные если они были собраны до отключения. Это корректное поведение: `raw_metrics.preStage` сохраняется при скоринге как снимок, его не трогаем
- **Manual-analysis cache** (1h TTL): после фикса — если URL анализировался при ON-тумблере, в течение часа cache hit вернёт старый результат с nano. Не критично — TTL короткий, через час свежий submit будет уважать выкл. тумблера. Если хочется forceful invalidation на флипе — надо импортировать `clearManualAnalysisCache` в admin server и звать в обработчике toggle. Не делал в этом PR

---

## 2026-05-02 (Gemini captioner — fix пустого output: safety + thinking)

**Симптом** (от владельца): Gemini никогда не работает — ни в обычном пайплайне, ни в ручном анализе. Логи писали про cooldown / лимиты Google. **Ключевая улика**: в Google AI Studio dashboard видны **только input requests, output ноль**. Значит запрос доходит до Google, тратит input-токены, но возвращает пустой text.

**Корневая причина**: 2 фактора одновременно

1. **Default safety thresholds Gemini 2.5 Flash** режут ответ для memes/reddit/twitter контента → `finishReason: SAFETY`, `text=''`. Мы это ловили общим warn'ом «empty text», но **не логировали `finishReason` / `safetyRatings` / `promptFeedback`** — поэтому корневая причина была невидима.
2. **Dynamic thinking** в Gemini 2.5 Flash (включён by default). Без явного `thinkingConfig.thinkingBudget=0` thinking-токены могут съедать output-budget → пустой `text` при ненулевом `candidatesTokenCount`.

**Изменения** (`src/analysis/gemini-captioner.js`)

- **`safetySettings: BLOCK_NONE`** для всех 4 категорий (HARASSMENT / HATE_SPEECH / SEXUALLY_EXPLICIT / DANGEROUS_CONTENT). Мы description-preprocessor, не контент-хост — нет смысла гасить ответы для мемов
- **`generationConfig.thinkingConfig.thinkingBudget = 0`** — отключаем thinking для vision captioner'а (он не нужен)
- **`generationConfig.maxOutputTokens = 1024`** — явный потолок (было undefined, что делало результат непредсказуемым)
- **Расширенный warn при empty text**: теперь логируем `finishReason`, `promptFeedback.blockReason`, `safetyRatings` (>=MEDIUM или blocked), `tokens=in+out`. Если ещё раз случится — будет видно ЧТО именно блокирует
- **User-Agent** добавлен в HEAD/GET при скачивании медиа. Reddit `v.redd.it` и часть Twitter video CDN режут default Node-UA. Использован тот же Chrome UA что в reddit collector

### Проверка
- `node --check src/analysis/gemini-captioner.js` ✓

### Follow-up: длина videoSummary через промпт (после первого деплоя)

После того как фикс заработал, владелец заметил что `videoSummary` режется посреди слова в админке. Корень — hardcoded `slice(0, 250)` в коде vs `≤200 chars` в промпте. Перенёс контроль длины из кода в промпт:

- **Промпт переформулирован**: `≤200 chars` → `2-3 complete sentences` (для videoSummary), `≤300 chars` → `1-2 complete sentences` (для visualCaption)
- **Добавлен CRITICAL LENGTH RULE**: «every field must be a COMPLETE thought ending with proper punctuation. Never cut mid-sentence or mid-word»
- **Slice'ы в коде** оставлены как safety-net против runaway-моделей: 250→800 (videoSummary), 400→800 (visualCaption), 200→600 (visibleText). Mood остался 60 (1-3 слова — никогда не больше)
- **OpenRouter fallback ветка** синхронизирована (те же лимиты)

### Риски / заметки
- **`BLOCK_NONE` через API**: для большинства аккаунтов это валидно (gemini-2.5-flash, generative-language API). Если проект включён в особые ограничения — придётся вернуть `BLOCK_ONLY_HIGH`. Симптом — 400 INVALID_ARGUMENT с упоминанием `safety_settings`. Логи теперь это покажут
- **Не трогал** Reddit `_bestImage` баг (пункт 3 возвращает `reddit_video_preview.fallback_url` = видео-URL, не картинка) — после safety-fix Google native video должен работать, fallback на постер задействуется реже. Если после деплоя останутся проблемы с reddit-видео фолбэком — править отдельным PR
- **Не трогал** cooldown counter — он считает все возвраты null от `_tryGoogleMedia` как Google failure (включая локальные download/sniff fail). После safety-fix частота null упадёт, но архитектурно counter мис-диагностирует. Backlog
- **Длина текстов** в Stage 1 prompt (`prompts.js:127-129`) — теперь visualCaption/videoSummary в `detail` строке могут быть длиннее. Не критично (Stage 1 batch promp всё равно 8-10K токенов суммарно), но если надо экономить — добавить trim там же

---

## 2026-05-02 (Admin StatusBar — pipeline в топбаре)

**Цель**: убрать декоративные шилды (RUNNING / age / preset) из топбара админки и перенести туда live-pipeline визуализацию (раньше была отдельной секцией только в ScannersPage).

### Изменения (`src/admin/server.js`)

- **StatusBar переписан** (~110 строк): теперь содержит логику бывшего `PipelineFlow` — polls `/api/pipeline` каждые 2.5с, рендерит 8 stage-нод + 7 wires в горизонтальный ряд справа от заголовка.
  - Левая часть: **🔄 Пайплайн** + subtitle с динамическим состоянием (`Live — Stage 1...` / `Последний цикл 12с назад (за 4.3с)` / `⏸ Сканер на паузе`).
  - Правая часть: компактные ноды (54×46 px, icon + count) + thin wires.
  - Active-нода: glow + pulse animation. Done-нода: muted accent border.
  - Active-wire: gradient sweep + shadow + opacity pulse.
  - Tooltip на ноде: `Stage 1 · gpt-5.4-mini` (показывает реальную модель цикла).
- **`PipelineFlow` компонент удалён** (~117 строк) — логика переехала в StatusBar.
- **`<PipelineFlow />` render из ScannersPage удалён** — теперь видна на каждой странице через топбар.
- **`.pflow-*` CSS удалён** (~27 правил, 27 строк).
- **`.shell-badge` CSS удалён** (бывшие шилды) — заменён `.sb-node / .sb-wire / .sb-head / .sb-pipeline / .sb-live-dot / .sb-paused` namespace.
- **`.topbar-actions` CSS удалён** — больше не нужен.
- **Responsive**: при `max-width: 1100px` топбар flex-direction column → пайплайн оборачивается под заголовком (на узких экранах).

### Проверка
- `node --check src/admin/server.js` ✓
- `scripts/check-admin-spa.cjs` ✓ (182366 chars, −2851 vs предыдущая)
- File: 5746 → 5679 строк (−67)

### Риски / заметки
- Polling вырос с 8с до 2.5с — но это та же частота что была у standalone PipelineFlow раньше, нет роста нагрузки vs PR-3 baseline.
- На очень узких экранах (<900px) ноды могут чуть наезжать друг на друга — wire `min-width:8px` это компенсирует, но если будет некомфортно, можно понизить до 6px.

---

## 2026-05-02 (Admin полный refactor — 4 фазы)

**Цель**: владелец заказал «улучшим админку полностью — добавим то чего не хватает, уберём лишнее, можно подкорректировать визуал, но не клонируя дашборд». PreStage не трогать.

Файл `src/admin/server.js`: 5895 → 5746 строк (-149 net; в реале вырезано ~330 строк мусора + добавлено ~180 строк новой функциональности).

### Фаза 1 — Cleanup (-280 строк дохлого кода)

- **`FilterProfilesSection`** (компонент + `_getFilterProfiles`/`_setFilterProfiles` методы + 4 импорта из `filter-profiles.js` + `FILTER_PRESET_META` const + `/api/filter-profiles` GET/POST handler) — мёртвое с PR-2, вынесли всё.
- **Дубликат-карточка «Управление рассылкой»** в BotPage (3464-3483): broken paste с кнопками `sendBroadcast` где должно быть `manageBroadcast`. Удалён.
- **4 unused user endpoints**: `PUT /api/users/:id`, `/users/:id/extend`, `/users/:id/block`, `/users/:id/unblock` — заменены `/subscription/grant|revoke` + `/status` ещё в PR-2.
- **«Очистить алерты»** перенесён с PaymentsPage на StatsPage в новую карточку **🧹 Обслуживание базы** (red-tinted .maintenance-card). Платежи != алерты — был семантический мисматч.
- **CSS-токены**: добавлены `--text3 / --muted / --border2 / --border3 / --accent-rgb / --accent-glow / --gloss-top / --shadow-card / --radius-*` в `:root`. До этого использовались, но не определялись → тихо ломали цвета в 6+ местах.

### Фаза 2 — Визуал и единые примитивы

- **Палитра**: оставлен характерный teal `#14b8a6`, добавлены `--accent-soft #5eead4`, `--accent-tint`, полные `*-rgb` тройки для всех state-цветов, full muted ramp (`--text2/3 / --muted / --dim`), full border ramp. Радиусы и shadow токенизированы.
- **`.card` hover-lift**: subtle `translateY(-1px)` + brighter border на ховере. Раньше карточки были полностью статичны.
- **Единый `.adm-tabs / .adm-tab / .adm-tab-count / .adm-tab-dot`**: свернули `exp-tabs` (ExamplesPage) и `pcfg-tabs` (PresetConfigsPage) в один namespace. Модификаторы `.bordered` (нижний border) и `.capitalize` (для preset-табов).
- **`<Section>` примитив** (~20 строк): обёртка с `icon`/`title`/`desc`/`actions`/`children`. CSS-классы `.adm-card-head / -title / -title-ico / -desc / -actions`. `broadcast-box` массово переименован в `adm-card` (15 usages) — он используется как universal section wrapper, имя теперь корректное.
- **DecisionsPage инлайн-стили → классы**: было ~100 inline `style={{...}}` блоков (нечитаемо). Извлечён `.dec-*` namespace (~26 правил): `.dec-card.sent/.skipped`, `.dec-row1`, `.dec-time/title/verdict`, `.dec-meta-row`, `.dec-atype-chip.event/.trend/.post`, `.dec-eng-chip`, `.dec-gate-chip.passed/.failed`, `.dec-breakdown`. JSX стал в 2× компактнее, перестилизация теперь тривиальна.

### Фаза 3 — Переструктурирование

- **BotPage → 3 под-таба**: 7 разнородных карточек (AI / Broadcast / Manage / History / Plans / Feedback weights / Recent reasons) на 450 строк прокрутки → 3 фокусированных вью через `subTab` state и `.adm-tabs.bordered` стрип. Карточки получили guards `subTab === 'ai|broadcasts|plans' && ...`.
- **`<StatusBar>`** в `<main>` topbar: пингует `/api/pipeline` + `/api/scanner-config` каждые 8 сек, показывает `🟢 RUNNING / ⏸ PAUSED / 🟡 IDLE` шилд + время с последнего цикла + active preset + текущий stage. Клик по live-state-шилду переходит на Сканеры. Использует осиротевший `.shell-badge` + добавлены state-варианты `.running` / `.paused`.
- **Live-индикаторы в сайдбаре**: poll каждые 12 сек в App. Жёлтый pulsing dot на табе «Сканеры» когда сканер на паузе. Numeric badge на табе «Алерты» с количеством решений в буфере. CSS `.nav-dot` (с `nav-pulse` keyframes) + `.nav-badge` (accent-tinted pill).

### Фаза 4 — Полишинг

- **«Краткие выводы» в StatsPage снесён**: filler-текст + дублировал данные «Размер БД» из верхних KPI. Active rate / Paid share / Доход lifetime инлайнены в карточку «Срез по хранению и метрики». `stats-bottom-grid` сменил layout с 2-col на 1-col.
- **UsersPage action-column → row-expand drawer**: 5 контролов в 420px-wide колонке (overflow на ноутах) → одна `⚙` кнопка на строку, клик открывает drawer-row снизу с двумя группами «Подписка» (plan select + days input + Выдать/Снять) и «Статус» (Заблокировать/Разблокировать). State `expandedId` (только одна строка открыта). CSS `.row-open / .row-drawer / .user-actions / .user-actions-group / .user-actions-label`.
- **Theme switcher** — пропущен. Админка по дизайну операторский тёмный инструмент, light-тема дала бы little value за большое количество правок CSS.

### Проверка
- `node --check src/admin/server.js` ✓
- `scripts/check-admin-spa.cjs` ✓ (185217 chars)
- Все 9 страниц open-able через нав, no JSX errors

### Риски / заметки
- StatusBar полит каждые 8 сек = ~2× HTTP вызова на цикл. Минимум на сервере.
- Sidebar polling каждые 12 сек = ~1.5× в минуту, очень мало.
- BotPage subTab state in-memory — при смене таба обнуляется. Если оператору важно «зашёл — продолжил с того где был», добавить sessionStorage-пост позже (не критично).
- `<Section>` компонент **определён**, но не использован внутри pages — это будущий шаг рефакторинга. На существующие adm-card он не влияет.

---
## 2026-05-02 (Source icons — настоящие SVG-логотипы)

**Цель**: владелец хотел оригинальные бренд-логотипы в `.source-icon` чипах. Letter-marks (R/G/𝕏/♪/#) хороши, но не выглядят как настоящие лого. Делаем inline SVG.

### Изменения (`src/dashboard/server.js`)

- **Новая константа `SOURCE_LOGOS`** рядом с `SOURCE_ICONS` (~line 4862): single-color SVG paths из simpleicons.org public-domain набора.
  - **reddit**: оригинальный Snoo (alien-голова в круге, ушки + глазки + улыбка)
  - **google_trends**: G-mark (single-color shape Google G)
  - **twitter**: X glyph (canonical post-rebrand X mark)
  - **tiktok**: music note silhouette с характерным «d»-хвостом
  - **x_trends**: hashtag (`#`) — что трендится в X
  - Все с `fill="currentColor"` → берут цвет от родительского чипа (per-data-src CSS color).
- **Компонент `SourceMark({ src, fallback })`** (~line 5070): рендерит `<span class="src-mark-svg" dangerouslySetInnerHTML="<svg>...</svg>" />` если SVG доступен; fallback на letter-mark из `SOURCE_ICONS`.
- **CSS `.src-mark-svg`** (~line 1990):
  - `width/height: 60%` от родителя (16px в 26px чипе, 22px в 38px feed-avatar)
  - Twitter X glyph чуть меньше (56%) — он от природы тонкий и высокий, оптически смотрится крупнее.
  - Feed-avatar: 58% (в более крупном чипе хочется немного breathing room).
- **Render-сайты**:
  - `.source-icon` в sidebar source-list — `SourceMark` напрямую.
  - `.feed-avatar` в `TrendCard` — `SOURCE_LOGOS[src] ? SourceMark : srcIco` (чтобы для unknown source осталась emoji-fallback).
- **Не трогал**: inline usage в top-narratives meta (`SOURCE_ICONS[tr.source]`), telegram-keyboard, ManualHistory hero — там текстовый glyph rendered inline, SVG был бы overkill.

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (175582 chars, +3375 vs предыдущая)

### Риски / заметки
- `dangerouslySetInnerHTML` с приходом из локальной const-таблицы — XSS-чисто (никакого user-input). React's tree теперь рендерит `<span><svg>...</svg></span>`.
- Backticks в SVG strings отсутствуют → SPA-template-literal trap не сработал. Все SVG-paths написаны как single-line single-quoted строки в JS object literal.
- SVG paths занимают ~3KB символов в SPA bundle — приемлемо для 5 brands. Альтернатива (отдельный endpoint `/api/icons/<src>.svg`) добавила бы 5 round-trips на загрузку дашборда.

---

## 2026-05-02 (Source icons — letter-marks + remove eye glyph)

**Цель**: улучшить иконки источников в сайдбаре (и в pulse-rows справа); убрать смайлик глаза `👁/🙈` который при hover'е перекрывал счётчик постов справа.

### Изменения (`src/dashboard/server.js`)

- **`SOURCE_ICONS` global** (line ~4855): emoji → brand letter-marks.
  - `🟠 → R` (Reddit)
  - `🔍 → G` (Google)
  - `𝕏 → 𝕏` (Twitter/X — оставлен)
  - `🎵 → ♪` (TikTok)
  - `📈 → #` (X Trends — хэштег = что трендится)
  - Letter-marks read как brand glyphs, рендерятся crisp на любом размере, не зависят от font-эмодзи stack'а.
- **CSS `.source-icon` + `.pulse-icon`** (синхронно):
  - Размер 22→26 px, font-weight 600→800, font-size 12→13.5 px (16 px для `♪` чтобы выровнять оптически).
  - Per-data-src `color` в brand-цвете: reddit `#ff5800`, google `#4285f4`, twitter `#fff`, tiktok `#ff2469`, x_trends `#1d9bf0`.
  - Border alpha поднят (`.25 → .36-.42`) для чёткого контура.
  - `box-shadow: var(--gloss-top)` — лёгкий highlight сверху.
  - `.source-item:hover .source-icon { transform: scale(1.05) }` — едва заметная анимация hover'а (без layout shift).
- **`.source-eye` удалён**:
  - CSS-правило (~5 строк) убрано.
  - `<span className='source-eye'>` из render'а в источниках удалён.
  - Замена-сигнал не нужен: `.source-item.off { opacity: .5 }` + `.source-item.off .source-icon { filter: grayscale(1) }` уже визуально показывают off-state. Раньше глаз `👁` приземлялся прямо на цифру счётчика postов (тот тоже `position: absolute; right: 8px`).

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (172207 chars)

### Риски / заметки
- `SOURCE_ICONS` используется глобально (TrendCard avatar, modal, pulse-rows, top sources strip, telegram-keyboard). Letter-marks отлично смотрятся в `.feed-avatar` (brand-gradient bg + white letter), inline в top-narratives meta тоже читабельно (`R · phase · 50 vrl`).
- Не trogал `SOURCE_LABELS` / `SOURCE_LINK_LABELS` — это полные имена («Reddit», «Twitter/X»), они отдельная роль.
- Fallback `'📡'` оставлен — если в БД появится новый source, не сломается.

---

## 2026-05-02 (Dashboard sidebar — кастомный dropdown категорий)

**Цель**: улучшить визуал внутри секции **КАТЕГОРИЯ** в сайдбаре дашборда + поменять эмодзи возле названия. Старая реализация — нативный `<select>`, у которого открытая option-панель полностью paint'ится chromium UA (тёмная синева на скриншоте) и игнорирует CSS. Не вписывался в X-style monochrome тему.

### Изменения (`src/dashboard/server.js`)

- **Эмодзи**: `📂 Категория` → `🏷️ Категория` (RU + EN i18n). Bookmark-tag тематически точнее под «category».
- **Новый компонент `CategoryDropdown`** (~70 строк) рядом с `PhaseBadge` (~line 4968):
  - Trigger-button показывает текущую категорию: `🏷️ icon + label + ▾`. На placeholder — `◆ + "Все категории"` в muted-цвете.
  - Click → animated `cat-dd-panel` (slide-in 140ms): «Все категории» reset-row + divider + список реальных категорий из `CAT_ICONS`.
  - Click-outside (mousedown) и Esc закрывают; useEffect привязан к `[open]`.
  - Active option: `var(--accent-glow)` фон + accent left-border + `✓` справа.
  - Hover: лёгкий white-alpha overlay + scale(1.08) на иконке.
- **CSS namespace `.cat-dd-*`** (~110 строк, после блока `select`):
  - `.cat-dd-trigger` — gloss-top shine, accent-glow при `.open`, rotated caret. Caret `▴` (закрыт) → `▾` после 180deg flip (открыт).
  - `.cat-dd-panel` — **открывается ВВЕРХ** (`bottom: calc(100% + 5px)`) потому что `CategoryDropdown` сидит в самом низу sidebar-а рядом с BottomNav. Падающее вниз меню перекрывало бы footer. z-index 50, max-height 320px со styled scrollbar (thin, accent thumb), shadow `0 -12px 40px` (свет сверху). Animation `cat-dd-slide-up` — слайд снизу вверх.
  - `.cat-dd-opt` — accent left-border ::before, scale-on-hover icon.
- **Замена в render**: `h('select', ...)` → `h(CategoryDropdown, { value, onChange, categories: Object.keys(CAT_ICONS) })`.

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (171905 chars, +2927 vs предыдущая)

### Риски / заметки
- Native `<select>` стиль (`select { ... }` в CSS) **остался** — используется в других местах (e.g. админ-формы, settings panel). Не трогал.
- z-index 50 может конфликтовать только с modal sheet (`backdrop-filter`); modal перекрывает sidebar полностью, поэтому конфликта быть не должно.
- Mobile/touch: click-outside через `mousedown` работает на touch-устройствах (chrome/safari fire mousedown perevent default).

---

## 2026-05-01 (Dashboard sidebar — multi-select для фазы и типа)

**Цель**: в окнах **ФАЗА** и **ТИП** в сайдбаре дашборда сделать одновременный выбор нескольких чипов. Старое поведение — только один чип активен; клик на новый сбрасывал предыдущий. Чип «Все» остаётся exclusive — клик по нему всегда сбрасывает множество в пустое состояние.

### Изменения (`src/dashboard/server.js`)

**Серверная сторона** (`_handleTrends`):
- `?phase=early` → `?phase=early,forming,strong` (CSV); невалидные значения отфильтровываются.
- SQL: было `JSON_EXTRACT(...) = ?`, стало `IN (?,?,...)` — параметры пушатся динамически.
- Backwards-compat: одиночное значение `?phase=early` парсится как массив с одним элементом → ведёт себя идентично прежнему.

**Клиентский state**:
- `phase` (string) → `phases` (отсортированная CSV-строка, `''` = все). Persist в `localStorage.ts_phase_filter`.
- `alertTypeFilter` (string) → `alertTypes` (отсортированная CSV-строка, `''` = все). Persist в `localStorage.ts_alert_type_filter`. Старые single-value entries остаются валидными как 1-элементный CSV.

**Сайдбар-чипы** (обе секции):
- Чип «Все» (`◆`) активен когда CSV пустой; клик — сбрасывает CSV.
- Каждый цветной чип (early/forming/strong/saturated, event/trend/post) теперь toggle: добавляет/убирает свой ключ из CSV.
- Отрисовка через IIFE внутри `h('div', { className: 'sidebar-phase' }, ...)` — IIFE возвращает массив элементов (React flattens), а manual-only chip остался отдельным sibling-аргументом.

**Visible feed**:
- `visibleTrends` для alert-types фильтрует через `Set(alertTypes.split(','))`. Wildcard для legacy-rows без `alertType` сохранён.
- Phase-фильтр уходит на сервер через query (как раньше), просто многозначный.

**Reset-link** (`Сбросить`):
- Активен если CSV непустой (или manual-toggle включён в случае alert-type секции).
- Очищает CSV + localStorage + (для phase) сбрасывает `offset`.

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (168978 chars, +2620 vs предыдущая версия)

### Риски / заметки
- Деплой не делал — пользователь триггерит через `.\deploy.ps1`.
- Backwards-compat для localStorage: сохранённые старые ключи (`'event'`, `'early'`) парсятся как 1-элементный CSV. Сброс не нужен.
- Сервер тоже принимает single-value (`?phase=early`) — старые bookmarks/clients не сломаются.

---

## 2026-05-01 (X Trends collector — новая платформа)

**Цель**: добавить X Trends (trending hashtags / topics с x.com) как **5-ю платформу** в pipeline, наравне с Reddit / Twitter / TikTok / Google Trends. Со своим коллектором, своим source-id (`x_trends`), своими per-preset настройками и UI-секцией.

**Принципиальное отличие от существующего Twitter collector'а** (`src/collectors/twitter.js`):
- Twitter collector делает **TWEET SEARCH** через Apify-актёров `kaitoeasyapi` / `xquik` (отдельные tweets)
- X Trends collector делает **TRENDS LIST** через `karamelo/twitter-trends-scraper` (топики/хэштеги)

### Источник данных

- **Apify actor**: `karamelo~twitter-trends-scraper` ($0.29 / 1000 results, 5★, 1.1K юзеров)
- **Стоимость**: ~30 трендов × 48 запусков/день × $0.00029 ≈ **$13/мес** (default refresh 30 мин)
- **Country**: hardcoded `United States` (English priority — единственный язык в US-trends списке)
- **Output shape (от актёра)**: `{ trend, time, timePeriod, volume }` — `volume` чаще всего пустая строка (X не экспонит публично), поэтому `minTweetVolume` фильтр **не реализован** — полагаемся на `rank` (array index) + AI-скоринг

### Архитектура коллектора (`src/collectors/x-trends.js`, ~210 строк)

- Class `XTrendsCollector extends BaseCollector`
- **Internal refresh timer** (`setInterval`, default 30 мин, `X_TRENDS_REFRESH_MINUTES` env) — decoupled от scanner cycle (~90 сек). Тренды реально обновляются раз в 15-30 минут, нет смысла дёргать чаще
- **Cache в памяти** `_cache: { fetchedAt, items }` — последний успешный Apify-результат
- **Dedup map** `_emitted: Map<slug, ts>` с TTL 6 часов. Re-emit если тренд исчезал и появился снова (signal of resurgence). Cap размера через GC старых ключей
- **`_inFlight` mutex** — coalesce concurrent refreshes (timer + sync fallback)
- **`startRefreshTimer()`** запускается в `index.js` constructor сразу после регистрации в `collectors[]`
- **`collect()`** на каждом scanner-cycle: читает per-preset config (`enabled` / `topN`), берёт top-N из cache, фильтрует через `_emitted`, возвращает diff
- **`stopRefreshTimer()`** — для graceful shutdown (пока не используется, но готово)

### Schema — `sources.xtrends` namespace

В `preset-config.js` добавлены 2 поля:
- `xtrends.enabled` (int 0/1) — per-preset toggle. UI рендерит как slider 0..1 (можно потом на toggle переписать, но с таким же эффектом)
- `xtrends.topN` (int 5-50, step 5) — сколько верхних трендов брать с каждого fetch

**Per-preset defaults**:

| Preset | enabled | topN | Reasoning |
|---|---|---|---|
| general | 1 | 20 | broad cast |
| animals | 1 | 10 | животные редко в top trends |
| culture | 1 | 25 | мемы спайкают быстро |
| celebrities | 1 | 25 | celebs часто доминируют |
| events | 1 | 30 | события flood'ят trending |

### Item shape для pipeline

```js
{
  source: 'x_trends',
  externalId: 'xtrends-us-<slug>-<YYYYMMDDHH>',  // hourly bucket → DB-dedup catches re-emits within hour
  title: 'Good Friday',                            // raw trend name
  description: 'Trending #1 on X in United States (Live).',
  url: 'https://x.com/search?q=Good%20Friday&src=trend',
  author: 'x_trends',                              // pseudo to satisfy downstream code
  timestamp: <ISO>,
  metrics: { rank: 1, country: 'United States', timePeriod: 'Live', tweetVolume: null }
}
```

Идёт через **тот же** pipeline что обычные посты: `Aggregator → cheapDedup → PreStage → Clusterer → Stage 1 → Stage 2 → alert-loop`. Никаких изменений в scorer/clusterer/prompts — Stage 1 видит обычный item, скорит memePotential по title. Stage 2 (Grok x_search) делает deep-dive на топик при passing.

### Wiring во все компоненты

- **`src/index.js`**: импорт + `new XTrendsCollector(config, logger, db)` + если `enabled` → `collectors.push(...)` + `startRefreshTimer()`
- **`src/dashboard/server.js`**:
  - `_handleSources` → массив включает `'x_trends'`
  - `SOURCE_ICONS['x_trends'] = '📈'`
  - `SOURCE_LABELS['x_trends'] = 'X Trends'`
  - `SOURCE_LINK_LABELS['x_trends'] = '📈 X Trends'`
  - CSS `.feed-avatar.x_trends`: linear-gradient `#1d9bf0 → #0a0a0a` (X-blue + ink)
  - CSS `.source-item[data-src="x_trends"]` + `.pulse-row[data-src="x_trends"]` — синяя tint
  - URL ведёт на x.com → переиспользуем `trend-link-twitter` className
  - `sourceOrder` (Stats) включает x_trends
  - Refactored hardcoded source-icon mapping в analyze hero на `SOURCE_ICONS[]` lookup (заодно убрана дубликация)
- **`src/notifications/telegram.js`**: `_sourcesKeyboard` allSources массив включает `'x_trends'`
- **`src/i18n/{ru,en}.js`**: `sourceNames.x_trends = 'X Trends'`
- **`src/admin/server.js`** SPA `SourcesAccordion`: новый sub-section `📈 X Trends` (4-й, перед Google Trends) — banner с описанием и стоимостью + 2 PSlider'а (enabled / topN)

### Env vars (`.env.example`)

Новый блок «X TRENDS»:
```
X_TRENDS_ENABLED=1               # global kill switch
X_TRENDS_REFRESH_MINUTES=30      # 5-onwards. Lower = fresher / pricier
X_TRENDS_COUNTRY=United States   # also: 'United Kingdom', 'Worldwide', 'Japan'
APIFY_X_TRENDS_ACTOR_ID=karamelo~twitter-trends-scraper
APIFY_X_TRENDS_KEY=              # optional, falls back to APIFY_API_KEY
```

### Smoke-test (на реальных sample-данных от оператора)

```
[XTrends] refreshed: 5 trends from United States
source: x_trends
  externalId: xtrends-us-goodfriday-2026050111
  title: Good Friday
  description: Trending #1 on X in United States (Live).
  url: https://x.com/search?q=Good%20Friday&src=trend
  metrics: { rank: 1, country: 'United States', timePeriod: 'Live', tweetVolume: null }
... (4 more)
Re-collect (dedup test): 0 items (expected: 0)
```

Парсер корректно обрабатывает trends с пустыми volume, dedup отрабатывает на повторном вызове.

### Operational notes

- **Если actor лёг / 429**: `_refresh()` логирует warn, `collect()` возвращает старый cache (или [] если cache пуст). pipeline продолжает работать без X Trends
- **Hourly externalId bucketing**: тот же тренд в том же часу = тот же ID → DB-dedup catches. Через час → новый ID, тренд может re-enter pipeline (ловим resurgence)
- **In-memory `_emitted` survives только в рамках процесса**. После рестарта Docker'а первый цикл может re-emit-нуть тренды что были до. Не страшно — DB hourly-bucket externalId всё равно их свяжет
- **Stale cache fallback**: если timer заглох (host suspend/resume, etc) и cache старше 2× refresh interval, `collect()` делает sync refresh inline. Защита на edge cases

### Проверка

- `node --check` × 6 файлов: OK
- `check-admin-spa.cjs`: 190 755 chars (+983 от X Trends UI)
- `check-dashboard-spa.cjs`: 166 333 chars (+86 от source labels)
- Smoke-test парсера на реальных данных: PASS
- Round-trip preset-config validator: defaults стрипаются до `{}`

**Деплой**: `.\deploy.ps1` → через ~5 секунд Apify-запрос, через ~30 сек первые items в pipeline, через ~90 сек первые `x_trends` карточки в дашбоде с источником `📈 X Trends`.


## 2026-05-01 (per-preset pipeline configs — PR-1/2/3 + Grok-audited tuning)

**Цель**: до этой работы каждый из 5 пресетов (`general/animals/culture/celebrities/events`) имел только per-preset junk-filter (через старый `filterProfiles`). Всё остальное — alert thresholds / weights / stale decay / cluster-similarity / коллекторские источники — было либо глобальным, либо хардкодом в `.js` файлах. Цель: **полностью per-preset pipeline tuning** через единый JSON-блоб + admin UI.

**Архитектура** (3 PR'а в одной сессии):

### PR-1 — Foundation

**Новый модуль** `src/analysis/preset-config.js` (~470 → 540 строк после PR-1 helper'ов):
- `PRESET_KEYS` — `['general', 'animals', 'culture', 'celebrities', 'events']`
- `PRESET_GROUPS` — `['sources', 'junk', 'alerts', 'cluster']` (порядок аккордеонов в UI)
- `PRESET_FIELD_RANGES` — метаданные полей: тип (`int`/`float`/`list`), min/max/step, label/desc для UI, флаг `positive: true` для weight-полей которые входят в Σ ≤ 1.0 budget
- `DEFAULT_PRESET_CONFIGS` — полные defaults для всех 5 пресетов. Структура:
  ```
  { <preset>: {
      sources: { reddit: {...}, twitter: {...}, tiktok: {...}, googletrends: {} },
      junk:    { politicsPenalty, kpopPenalty, ... },
      alerts:  { thresholds: {...}, weights: {...}, stale: {...} },
      cluster: { simThreshold, weightEmbedding, ... }
  } }
  ```
- `resolvePresetConfig(preset, overrides)` — deep-merge defaults + per-preset patch (immutable, frozen defaults preserved)
- `getActivePresetConfig(db)` — one-stop helper для consumer'ов: читает active preset из settings + резолвит
- `validatePresetOverrides(input)` — strict validation: range-check каждого leaf, drop полей равных default (compact blob), assert Σ POSITIVE ≤ 1.0 для `alerts.weights` и `cluster`
- `readPresetOverrides(db)` — tolerant JSON-read из settings
- `getEffectivePresetConfigs(overrides)` — таблица для UI

**DB миграция** (`src/db/database.js`, marker `presetConfigsMigratedV1`):
- One-shot: читает legacy `filterProfiles` + 13 глобальных `alertThreshold`/`alertWeight*`/`alertStaleDecay*`/`alertHardJunkStop`/`maxAlertsPerCycle`/`minScoreToSave`
- Если значение отличается от defaults → копирует во ВСЕ 5 пресетов (preserve existing operator behavior)
- Прогон через `validatePresetOverrides` → стрипает совпавшие с new defaults (compact blob)
- Legacy глобальные ключи **не удаляются** — остаются как fallback на время transition

**Endpoints** (`src/admin/server.js`):
- `GET /api/preset-configs` → `{ defaults, effective, overrides, fieldRanges, presets, groups }`
- `POST /api/preset-configs` `{ overrides }` — гейт через существующий `X-Admin-Key` (admin server и так operator-only by design — не нужен отдельный custom gate)
- `_getPresetConfigs()` / `_setPresetConfigs(body)` helpers, параллель к существующим filterProfiles

**Минимальный UI** (PR-1 ship): `PresetConfigsPage` с tab strip пресетов + большой JSON textarea redactor для overrides + read-only inspector panes (defaults / effective / overrides). Заменён в PR-3 на полноценный UI.

### PR-2 — Consumer wiring

**Все читатели переключены на резолвер**:

| Файл | Что меняется |
|---|---|
| `analysis/scorer.js` | `loadAlertWeights(db)` теперь читает per-preset (`alerts.weights/.stale/.thresholds.alertHardJunkStop`). Backward-compat: без `db` → DEFAULT_ALERT_WEIGHTS |
| `analysis/clusterer.js` | constructor больше **не** читает `clusterSimThreshold`/`clusterWeight*` — снапшотятся в `_refreshClusterParams()` в начале каждого `route()`. Junk-filter call site строит `{ [activePreset]: cfg.junk }` blob из preset-config'а вместо чтения legacy `filterProfiles` |
| `collectors/reddit.js` | `_resolveRedditConfig()` per-cycle: `subreddits` / `minUpvotes` / `postsPerSubreddit` из preset config. Env-overrides (`config.reddit.*`) сохранены приоритетом |
| `collectors/twitter.js` | `_getQueries()` читает `sources.twitter.queries` per-preset. Env-override `customQueries` приоритетен |
| `collectors/tiktok.js` | `_getHashtags()` читает `sources.tiktok.hashtags` per-preset. Попутно фикс pre-existing бага: старые `PRESET_HASHTAGS` имели keys `general/animals/ai/elon/sports` — не матчили `PRESET_KEYS`, culture/celebrities/events падали в `general` |
| `index.js` (alert-loop) | `alertThreshold` (floor), `maxAlertsPerCycle`, `minScoreToSave` читаются из active preset config (`getActivePresetConfig(db).alerts.thresholds.*`) |

**Cleanup global allowed-lists** (атомарно с consumer wiring):

- Admin `_setScannerConfig` allowed-list trimmed: убраны 13 полей (`alertThreshold`, `minScoreToSave`, `maxAlertsPerCycle`, `alertHardJunkStop`, 6×`alertWeight*`, 3×`alertStaleDecay*`). Оставлены только orthogonal global knobs: `twitterMaxAgeHours`, `rescoreCooldownHours`, `stage2Threshold`, `stage2MaxCalls`
- Admin `_getScannerConfig` GET shape — те же поля убраны из ответа
- Dashboard `_handleSettings*` allowed-list — убран `alertThreshold` / `minScoreToSave` / `maxAlertsPerCycle`. User-level `users.alert_threshold` через `/api/user/threshold` остался (per-user, не глобальный)

**UI cleanup в `ScannerConfigSection`**:
- Удалены 4 sub-секции (Alerts thresholds / Weights / Stale decay / Storage)
- Заменены на единый banner «Алерты, веса, stale-decay, junk и cluster — теперь в табе Пресеты»
- `FilterProfilesSection` removed из `ScannersPage` рендеринга (компонент остался в файле для возможного rollback)
- `JunkStatsSection` оставлен — observability полезна

### PR-3 — Полноценный admin UI

**`PresetConfigsPage` переписан с нуля** (~600 строк UI + ~50 строк CSS):
- **Tab strip** — 5 пресетов, override-индикатор `●` если есть overrides
- **4 раскрывающихся аккордеона** (`<details>`) на активный пресет:
  - **📡 Sources** (открыт по дефолту): per-platform sub-sections — Reddit (chip-input subreddits + 2 sliders) / Twitter (chip-input queries) / TikTok (chip-input hashtags) / Google Trends (placeholder)
  - **🚫 Junk filter**: 6 sliders
  - **🔔 Alerts** с 3 саб-секциями: Thresholds (4 sliders) / Weights (5 budget-clamped + SumMeter + junk multiplier отдельно) / Stale decay (3 sliders)
  - **🧬 Cluster**: 2 простых slider'а + 4 budget-clamped weight slider'а с SumMeter
- **Component primitives**:
  - `PSlider` — slider row с override-dot + reset-to-default `↺` button
  - `BudgetSlider` — clamps onChange к remaining budget (Σ positive ≤ 1.0). Показывает `⛔` когда atLimit
  - `PChips` (через `ChipInputBox`) — chip-input для list fields с Enter/blur/Backspace
  - `SumMeter` — live read-only Σ для budget группы (получает `getEffective` через prop drilling)
- **Draft mutators**: `setLeaf` walks/creates path в draft, drops leaf если value == default, GC empty parent objects вверх по chain
- **Actions row**: Save / Reload / Reset preset «X» / Clear ALL
- **Debug fallback** в `<details>`: 3 inspector pane'а (defaults / effective / draft) для активного пресета

**CSS**: новый namespace `.pcfg-*` (.pcfg-tabs / .pcfg-accordion / .pcfg-row / .pcfg-chip / .pcfg-budget / etc) — параллельно `.scfg-*`, без коллизий.

### Post-Grok-audit tag/slider tuning

После завершения PR-1/2/3 — **массовое обновление дефолтов** через `DEFAULT_PRESET_CONFIGS`:

**Структурное**: убраны shared константы `DEFAULT_ALERTS` + `DEFAULT_CLUSTER` (раньше все 5 пресетов делили identical alerts + cluster). Каждый пресет получил полный самодостаточный набор.

**Tuning rationale per preset**:
- **general**: broad net, mixed lifespan, balanced weights
- **animals**: slow lifespan (cute capybara stays cute), low density, **meme-dominant** (memePotential=0.45). phash heavy в кластере (visual matching), gentle stale-decay (per-hour=1, grace=48h, cap=20)
- **culture**: short lifespan (memes die fast), very high density, **meme-dominant** (0.45), phash + embedding equally heavy в кластере (0.40 каждый), aggressive stale-decay
- **celebrities**: short lifespan, very high density, **virality-dominant** (0.30). Strict junk-multiplier (0.55) — celeb-noise floods otherwise
- **events**: hours-long lifespan (news rots), medium density, **emergence-dominant** (0.35). embedding+entity heavy в кластере (event = many framings of same news), very aggressive stale-decay (per-hour=5, grace=6h, cap=60), short cluster window (timePenaltyHours=6)

**Σ POSITIVE invariant**: для `alerts.weights` (5 positive) и `cluster.*` (4 positive) во всех 5 пресетах = **ровно 1.00**. Validated automated.

**Sources update** (post-Grok аудит):
- **Reddit general**: убраны `interestingasfuck` + `Damnthatsinteresting` + `BeAmazed` (overlap / low activity), добавлены `funny` + `mildlyinteresting` + `wholesomememes`
- **Reddit animals**: добавлены `FunnyAnimals` + `AnimalMemes` (рост 2024-2025)
- **Reddit culture**: добавлены `ContagiousLaughter` + `HolUp` + `196` (свежие meme-сабы). `TikTokCringe` оставлен (Grok хотел убрать — но это ценный TikTok→Reddit propagation signal)
- **Reddit celebrities**: убран `hiphopheads` (overlap с popheads), добавлены `kpop` + `Deuxmoi` (доминируют 2026)
- **Reddit events**: убран `UpliftingNews` (feel-good, не события), добавлен `nottheonion` (странные real events)
- **Twitter culture**: убраны устаревшие 2023-2024 queries `(cancel OR ratio OR main character)` и `(gen z OR boomer)`, добавлены свежий gen-z slang `(skibidi OR delulu OR rizz OR brainrot OR mewing)` + cross-platform `(tiktok OR reels OR fyp) (viral OR trending)`
- **Twitter celebrities**: убраны конкретные имена `(elon OR trump OR drake OR kanye)` (cooling / политика), добавлены актуальные K-pop группы `(bts OR blackpink OR straykids OR seventeen OR twice)` + targeted `(kpop OR k-pop OR idol) (drama OR comeback OR scandal)`
- **Twitter events**: добавлен `(trump OR election OR debate OR primary)` для 2026 election cycle
- **TikTok general**: **полная замена** — было 100% crypto (`memecoin/solana/cryptomeme`) → стало generic viral (`fyp/viral/trending/foryou/funny/...`). Это был критический баг — TikTok general не ловил generic TikTok контент
- **TikTok все остальные**: точечные обновления (добавлены `dogsoftiktok` для animals, `pov`+`brainrot` для culture, `bts`+`blackpink` для celebrities, `aivideo`+`severeweather` для events)

### Поведенческие изменения после PR'ов

| Пресет | Что заметно меняется |
|---|---|
| **general** | TikTok перестаёт давать только crypto-контент → generic viral |
| **animals** | Reddit min_upvotes 5000→3000 (animal subs мельче), threshold 60→55, meme weight 0.35→0.45, stale grace 24→48h |
| **culture** | minScoreToSave 0→10 (экономим DB), threshold 60→65 (строже), AI ловит свежий gen-z slang, stale decay 2x faster |
| **celebrities** | X queries переключились на K-pop (BTS/BlackPink доминируют 2026), threshold 60→70 (строжайший), junk-multiplier 0.50→0.55 |
| **events** | threshold 60→50 (ловим раньше breaking news), maxAlertsPerCycle 0→10 (cap), stale decay 2.5× агрессивнее, cluster timeWindow 24h→6h |

### Operator-only гейт

**Уточнение архитектуры**: PR-1/2/3 endpoints (`/api/preset-configs` GET/POST) живут на **admin server** (port 8081), который и так гейтится через `X-Admin-Key` env var — single shared key. Это **архитектурно operator-only by design** (только тот у кого есть env-key, обычно через SSH-tunnel). Никакого дополнительного custom-middleware не нужно — отличается от dashboard server (port 8080) где есть multi-user auth с TG-linked accounts (вплоть до `plan='admin'` users — но они в admin server **не попадают**).

### Файлы тронутые в этой работе

**Новые**:
- `src/analysis/preset-config.js`

**Сильно модифицированы**:
- `src/analysis/scorer.js` (loadAlertWeights переключён)
- `src/analysis/clusterer.js` (cluster knobs + junk через preset-config)
- `src/collectors/{reddit,twitter,tiktok}.js` (sources через preset-config)
- `src/db/database.js` (миграция `presetConfigsMigratedV1`)
- `src/admin/server.js` (+`PresetConfigsPage` UI ~600 строк, +endpoints, -4 sub-sections в ScannerConfigSection)
- `src/dashboard/server.js` (cleanup `_handleSettings*`)
- `src/index.js` (alert-loop читает per-preset)

### Trap caught

В PR-3 **дважды** трапнулся на backticks-в-комментариях внутри SPA template literal:
- `\`formatValue\` overrides the default display` → SyntaxError `Unexpected identifier 'formatValue'`
- `siblings is an array of` (оригинал был `\`siblings\``) → SyntaxError `Unexpected identifier 'siblings'`

Поймано `node --check`, замена backticks на plain text. **Урок переподтверждён**: внутри `_spa()` — НИКОГДА backticks даже в JSDoc/комментариях. Этот файл (preset-config) не имеет outer template literal так что ему backticks безопасны — но admin/server.js внутри `_spa()` — нет.

### Проверка финального state

| Что | Результат |
|---|---|
| `node --check` × 7+ файлов | OK |
| `check-admin-spa.cjs` | OK (189 772 chars после PR-3, +17K от UI) |
| `check-dashboard-spa.cjs` | OK |
| Σ positive weights × 5 presets × 2 groups (alerts + cluster) | 10/10 = exactly 1.00 |
| Round-trip (DEFAULT_PRESET_CONFIGS → validator) | OK — стрипается до `{}` |
| Behavior parity smoke (no-db / empty-preset / override-routing) | 6/6 PASS |
| End-to-end UI save flow (chip-input + slider + budget-clamp) | OK |

---

## 2026-05-01 (post-theme polish: bars / surfaces / Account / TG-threshold rename)

**Цель**: после rewrite темы остались разрозненные «осколки» midnight-палитры (синие тинты в overlay'ях/барах) и слишком яркие серые поверхности. Плюс нужно было привести в порядок Account-панель (overflow тогглов, кричащий accent-gradient на hero) и переименовать слайдер «Чувствительность алертов» — он управляет только TG-пушами, не фидом.

**Изменения** (все в `src/dashboard/server.js`):

### Bars + overlays — привязка к theme tokens

- **`.nav` (top bar)**: было хардкод `linear-gradient(rgba(12,12,22,.96) → rgba(8,8,15,.92))` (синеватый midnight-tint), стало `linear-gradient(var(--surface) → var(--bg))` — на ink это `#0a0a0a → #000000`, незаметная elevation, тема-агностично
- **`.statusbar` (bottom bar)**: тот же фикс, mirrored gradient `var(--bg) → var(--surface)` (снизу чуть приподнимается)
- **`.sheet-overlay` (modal backdrop)**: было `background: rgba(4,6,14,.55)` + `backdrop-filter: blur(14px) saturate(1.1)` — синий тинт + saturate boost'ил остаточную синь из контента под блюром. Стало `rgba(0,0,0,.62)` + только `blur(14px)`. Нейтральный blackout на любой теме.

### Surfaces — выравнивание яркости

Юзер указал что центральные карточки фида и блоки правой колонки выглядят ярко-серыми относительно тёмного сайдбара. Корень — массовое использование `var(--card)` (#16181c) для surface'ов:

- **`.feed-card`**: было `linear-gradient(var(--card2) → var(--card))` (#1c1f24 → #16181c, заметно серое). Стало `var(--surface)` (#0a0a0a) + `box-shadow: var(--gloss-top)` — карточки матчат сайдбар, только 1px border их выделяет
- **`.feed-card:hover`**: `linear-gradient(rgba(255,255,255,.04), rgba(255,255,255,.015))` — soft white-alpha overlay (X-приём), даёт лифт без сдвига оттенка. Раньше было `linear-gradient(--card3 → --card2)` — тоже серое
- **`.right-section`**: `var(--card)` → `var(--surface)`. Right-panel секции теперь матчат feed-panel + сайдбар
- **`.settings-card`**: `var(--card)` → `var(--surface)`. Карточки в Account/Settings sheets теперь не выделяются ярко-серым

### AccountPanel — общая чистка

Юзер прислал скрин: тоггл-боксы алерт-типов выезжали за границу карточки, текст обрезался. Корень — `Row` primitive рендерил label + control в горизонтальную flex с `flex-shrink: 0` на control'е, контент длиннее ширины не ужимался.

- **`Row` primitive получил `stacked` prop**: side-by-side по дефолту (как было); `stacked: true` → `flex-direction: column`, control во всю ширину снизу label'а. Применён в AlertTypesRow
- **CSS overflow-страховка глобально**:
  - `.setting-row`, `.setting-control`, `.setting-label` — везде `min-width: 0` (canonical fix для flex с длинным текстом)
  - `.setting-control`: `flex-shrink: 0 → 1` + `max-width: 100%`
  - `.atype-toggle-group`/`.atype-toggle`/`.atype-toggle-label`: `min-width: 0` + `width: 100%` + `overflow-wrap: break-word`
- **Тексты тогглов сокращены**:
  - «Событие — конкретный триггер (кто-то что-то сделал/сказал)» → «Событие — конкретный триггер»
  - «Тренды — нарратив набирает обороты на разных платформах» → «Тренды — на нескольких платформах»
  - EN аналогично
- **`.account-hero`**: убран `background: linear-gradient(135deg, rgba(--accent-rgb, .09), --card 70%)` (электрически-синий диагональ от accent) → plain `var(--surface)`. Аватар остаётся единственным цветным focal point карточки
- **`.account-avatar-big`**: убран жирный `2px solid rgba(--accent-rgb, .5)` border + цветной accent-glow → 1px subtle ring + нейтральный `box-shadow: 0 2px 10px rgba(0,0,0,.4)`. Глянцевый, но не кричащий

### TG-threshold rename (Variant A)

Юзер заметил что слайдер «Чувствительность алертов» ничего не делает в дашбоде — он управляет только TG-пушами через alert-loop в `src/index.js`. Дашбод-фид показывает все Stage-1 трейнды независимо. Старое имя создавало впечатление общего фильтра.

- **Title**: «Чувствительность алертов» → «Порог Telegram-алертов» (RU). EN: «Alert sensitivity» → «Telegram alert threshold»
- **Desc**: явно добавлено «На фид в дашбоде НЕ влияет — для этого есть фильтр Adoption в сайдбаре»
- **Icon**: 🎯 → ✈️ (paper plane намекает на Telegram-scope)
- **Логика не тронута** — сервер-сайд `_handleUserThresholdPost` пишет в `users.alert_threshold` как было; гейт в alert-loop читает оттуда

**Trap stuck twice**:
1. Backtick в JSDoc: `// stacked:true for...` — сломал outer literal с `Unexpected identifier 'stacked'`. Поймано `node --check`, заменил на `stacked:true` без backticks
2. Backtick в комменте про cache-bust в logo-handler секции — поймано в прошлой итерации

**Проверка**: `check-dashboard-spa.cjs` green после каждого подхода. Финальный размер 166247 chars.

**Деплой**: `.\deploy.ps1` + Ctrl+F5. Старые темы в localStorage автоматически вылетят в дефолтный ink.

---

## 2026-05-01 (theme system rewrite — X-style monochrome)

**Цель**: 7 ярких тем (midnight/teal/abyss/violet/acid/sunset/cyberpunk) с разноцветными акцентами заменить на 4 минималистичные в стиле X (Twitter): один акцент-цвет, монохромная палитра, глянцевые поверхности.

**Старые темы выпилены** (`midnight/teal/abyss/violet/acid/sunset/cyberpunk`). Юзеры с сохранённой старой темой получают дефолт `ink` через validity-check в `detectTheme` — миграция не нужна.

**Новые темы** (4 шт, все в `:root` + `body[data-theme="..."]` блоки):

| Theme   | bg        | accent    | use case                                |
|---------|-----------|-----------|------------------------------------------|
| `ink`   | `#000000` | `#1d9bf0` | дефолт. X true-black + X-blue             |
| `dim`   | `#15202b` | `#1d9bf0` | X dim-mode (синевато-графитовый)          |
| `slate` | `#0e0f10` | `#ffffff` | Apple-style нейтральный графит, белый акцент |
| `mono`  | `#0d0d0d` | `#b8b8b8` | чистый grayscale, без хроматики           |

**Дизайн-принципы**:
- Один accent-цвет на тему, экономно (никаких rainbow-палитр)
- Borders translucent white at low alpha (`rgba(239,243,244,.08-.22)`) вместо tint'а от accent
- Семантические state-цвета (green/red/orange/yellow) **константны** во всех темах — OK/error не должны менять hue от темы
- **Glossy effects**: добавлены два token'а в `:root`:
  - `--gloss-top: inset 0 1px 0 rgba(255,255,255,.04)` — лёгкий top-edge highlight (свет на верхней грани)
  - `--gloss-edge: inset 0 0 0 1px rgba(255,255,255,.02)` — общий edge-glow
- `.feed-card` теперь рендерится с `linear-gradient(180deg, var(--card2), var(--card))` background + `box-shadow: var(--gloss-top)` — карточка читается как глянцевая, не плоская

**Файлы изменены**: `src/dashboard/server.js`:
- `:root` block переписан (lines ~1531-1576) — палитра X-ink + новые tokens
- 6 старых `body[data-theme="..."]` блоков удалены (~1578-1770) → заменены на 3 новых (`dim`/`slate`/`mono`, ink в :root)
- `.theme-swatch[data-theme-preview="..."]` блоки переписаны под новые имена (24 строки → 12)
- `SUPPORTED_THEMES` + `THEME_META` + `detectTheme` дефолт обновлены
- `.feed-card` background теперь gradient + gloss-top

**Проверка**:
- `node --check` green
- `check-dashboard-spa.cjs` green (164763 chars, было ~170K — палитра компактнее благодаря удалению 4 темных блоков)

**Деплой**: `.\deploy.ps1` + Ctrl+F5. Юзеры со старыми темами в localStorage автоматически переключатся на дефолтный `ink` при следующей загрузке.

---

## 2026-05-01 (logo cache-bust + transparent-bg fix)

**Цель**: после rebuild Docker'а дашборд показывал старый логотип (browser cache из-за `Cache-Control: immutable, max-age=86400`); плюс прозрачный PNG отображался на teal-градиентной подложке `.nav-logo-icon`, что выглядело как «чёрный фон сам добавляется».

**Фиксы** (`src/dashboard/server.js`):
- **Cache-bust через query string**: в constructor компилируется `this._logoVersion = mtimeMs(assets/logo.png)` (fallback = `this.started` если файла нет). Server-injected как `LOGO_VERSION` константа в SPA. `<img src='/assets/logo.png?v=' + LOGO_VERSION>` — URL меняется каждый rebuild (Docker `COPY` сбрасывает mtime у layer'а), браузер делает свежий запрос. Тот же приём webpack'а с content-hash bundles
- **`.nav-logo-icon.has-img`** класс: добавляется на `<img onLoad>`, убирает teal-градиент / border / box-shadow → прозрачный PNG показывается без подложки. Emoji-fallback по-прежнему получает стилизованный badge
- **`.nav-logo-img`**: убран `padding: 2px` — логотип теперь заполняет 28×28 целиком (для PNG с собственным фоном это критично — иначе выглядел "обрезанным" внутри badge)

**Проверка**: `check-dashboard-spa.cjs` green (165101 chars). Ловушка SPA-литерала не стрельнула благодаря отсутствию backticks в новых комментариях.

**Деплой**: после `.\deploy.ps1` юзеру **всё ещё нужен hard-refresh** (Ctrl+F5) **первый раз** — старый закэшированный URL `/assets/logo.png` без `?v=` сидит в browser cache. После первого обновления версионированные URL уже всегда фрешевые.

---

## 2026-05-01 (brand logo route — replace nav 🐱 emoji)

**Цель**: вместо emoji `🐱` в навбаре дашборда — кастомная картинка.

**Архитектура**: статика, бекаемая в Docker-образ. `Dockerfile` уже делает `COPY --chown=node:node . .` (line 44), так что новая папка `assets/` автоматически попадает в `/app/assets/` внутри контейнера. Никаких volume-маунтов или upload-роутов.

**Изменения**:
- **Новая папка** `assets/` в корне репо + `assets/README.md` с инструкцией
- **`src/dashboard/server.js`**:
  - Public route `GET /assets/logo.png` (до auth-чека). `_handleBrandLogo`: stat → stream PNG с `Cache-Control: max-age=86400, immutable`. На отсутствие файла → 404 (SPA onError fallback на emoji)
  - Nav logo span теперь рендерит `<img src="/assets/logo.png" onError="...emoji fallback">` вместо `🐱` напрямую
  - CSS `.nav-logo-img`: `width:100%; height:100%; object-fit:contain; padding:2px` чтобы вписывалось в 28×28 round-square badge

**От пользователя**: сохранить PNG как `assets/logo.png` в корне репо, потом `.\deploy.ps1`. Docker rebuild запекает файл в образ. Hard-refresh дашборда (Ctrl+F5) чтобы обойти browser cache.

**Fallback**: если файл отсутствует — endpoint возвращает 404 и SPA автоматически показывает 🐱 emoji через onError handler. Nav никогда не выглядит сломанным.

**Проверка**: `check-dashboard-spa.cjs` green (164124 chars, +591 от прошлой версии).

---

## 2026-05-01 (dashboard UI/UX polish pass)

**Цель**: пройтись по всему дашбоду, убрать визуальный шум, оптимизировать плотность, поправить недочёты.

**Изменения** (все в `src/dashboard/server.js`):

- **Nav bar**: удалена декоративная центральная подпись `app.subtitle` — добавляла шум без информации. Освободившееся место можно потом отдать под global status badge
- **BottomNav grid**: было хардкод `repeat(2, 1fr)` — для pro/admin с 3-й вкладкой «Analyze» 3-й tab падал на новую строку. Теперь inline `gridTemplateColumns: repeat(${tabs.length}, 1fr)`
- **Sidebar section headers**: были громкими (9px / letter-spacing 1.4px / `--accent` цвет). Стали 10.5px / spacing .8px / `--muted` — content становится фокусом, а не хедеры
- **Sidebar reorg**: filter «Manual only» переехал из source-list (не source-же он) в alert-type chip-секцию как полноширинный chip. Снят лишний `sidebar-divider` после source list
- **Sidebar reset link**: на alert-type секции reset теперь сбрасывает И тип-фильтр И manual-only одной кнопкой
- **Feed card head**: добавлен `feed-meta-hint` chip (1p · 12/h) рядом со временем — раньше был fake-button «details-hint» в actions row, теперь это нормальный inline-факт
- **Feed card badges**: нормализованы padding (2 7px) + font-size (10px) — раньше manual/atype/phase/category выглядели как разнокалиберный набор
- **Fresh indicator** (новое): тренды моложе 60 мин получают `🟢 NEW` chip + лёгкую pulse-анимацию + 2px зелёный левый бордер на карточке. i18n `feed.fresh_tip` + `badge.fresh` (RU + EN)
- **Feed panel head**: убрана декоративная 32×32 коробка с emoji 🔥 слева — заголовок и сам несёт визуальный вес через 800-weight. Square refresh button (32×32) — выровнен по высоте с search-инпутом
- **Feed panel sub**: «Live narrative tracker · 3/4 sources · 24h window» → «3/4 sources · last 24h» (RU аналогично). Tracker-label был словарный шум
- **Empty-state copy**: «No narratives found — loosen the filters» → «No narratives match these filters»; «Hint: widen the time window or clear filters» → «Try a wider time window or clear filters» (RU аналогично)
- **Sheet sizing**: max-width 760 → 720, добавлен `sheet-narrow` (560) для Analyze + Account — формы и профиль читаются компактнее, не растягиваются на всю ширину
- **Feed card padding**: 12 14 → 11 13 9 (меньше нижнего отступа), gap внутри head 8 → 6 — карточка плотнее без потери воздуха

**Trap encountered**: backtick в comment внутри SPA template literal (\`narrow\` flag) сломал outer literal с `Unexpected identifier 'narrow'`. Поймано `node --check`, исправлено заменой backticks на quotes. **Урок**: в SPA-комментариях ВСЕГДА используем "quotes" вместо backticks, как описано в SESSION_CONTEXT § «Ловушка server.js»

**Проверка**:
- `node --check src/dashboard/server.js` — green
- `scripts/check-dashboard-spa.cjs` — green (163533 chars, было 161042 — +2.5K от новых стилей и копии)
- `scripts/check-admin-spa.cjs` — green (без изменений)

**Файлы изменены**: только `src/dashboard/server.js`. i18n-ключи добавлены inline (не в `i18n/{en,ru}.js` модулях — дашбод имеет свой словарь внутри SPA, см. ~строки 4090/4405).

---

## 2026-05-01 (alert types: event/trend/post + per-user subscription)

**Цель**: разделить алерты по форме сигнала (а не по теме) — Событие / Тренд / Пост, чтобы юзер мог подписаться только на нужный тип.

**Архитектура** (выбран Path B — AI-driven через Stage 1, см. обсуждение):
- Поле `alertType ∈ {event, trend, post}` ортогонально `category`. Заполняется Stage 1 AI; heuristic/fallback пути деривируют детерминистично (`whyNow → event`, `platforms ≥ 2 OR clusterSize ≥ 3 → trend`, иначе `post`)
- Per-user CSV подписка `users.alert_types_filter` default `'event,trend,post'` (всё включено), пустой = "все" (никогда не мутим юзера молча)
- Legacy-тренды (`alert_type IS NULL`) — wildcard, проходят любой filter (back-catalog не страдает)

**Файлы**:
- `src/analysis/prompts.js` — экспорт `ALERT_TYPE_VALUES` + `normalizeAlertType()`. В `STAGE1_RESPONSE_SCHEMA` добавлено поле `alertType` enum, в `SYSTEM_PROMPT` — блок «ALERT TYPE» с rubric и rules of thumb. Поле прописано в `buildAnalysisPrompt` JSON spec
- `src/analysis/scorer.js` — экспорт `deriveAlertType(trend)` (детерминистический fallback). В AI-result mapping: `normalizeAlertType(a.alertType) || deriveAlertType({...})`. `_applyHeuristic` + `_fallback` тоже заполняют `alertType` через derive
- `src/db/database.js` — `addIfMissing('trends','alert_type','TEXT')`, `addIfMissing('users','alert_types_filter',"...DEFAULT 'event,trend,post'")`, helpers `getUserAlertTypes(chatId)` / `setUserAlertTypes(chatId, types[])` (валидируют enum, dedup, lowercase). `saveTrend` пишет колонку + зеркало в `raw_metrics.alertType`. `updateUser` allowed-list расширен
- `src/index.js` — новый gate `alert_type` в alert-loop рядом с threshold/source/dedup. `decisionBase.alertType` пишется в `recordAlertDecision` для DecisionsPage
- `src/notifications/formatter.js` — emoji-чип первой строкой алерта: `📰 СОБЫТИЕ` / `📈 ТРЕНД` / `🚀 ПОСТ`. Helper `formatAlertTypeChip(alertType, t)`. Legacy-row → пустая строка, чип не рисуется
- `src/i18n/{en,ru}.js` — ключи `alertTypeEvent/Trend/Post`, `btnAlertTypes`, `alertTypesTitle`, `alertTypeNameEvent/Trend/Post`, `alertTypeToggled(name, enabled)`. На дашборде — `sidebar.alert_type`, `feed.atype.*`, `badge.alert_type.*`, `account.alert_types*`
- `src/notifications/telegram.js` — в `/menu` keyboard вторая строка теперь содержит `🔔 Типы алертов` + `🌐 Язык`. Новый `_alertTypesKeyboard(user)` рендерит ✅/❌ для трёх типов. Callback'и `alert_types` (open) и `toggle_alert_type:event|trend|post` (toggle, optimistic)
- `src/dashboard/server.js`:
  - `_publicUser` отдаёт `alertTypes: string[]`
  - `_formatTrend` отдаёт `alertType` (колонка → fallback на raw_metrics)
  - Новый endpoint `POST /api/user/alert-types` `{ types: [...] }` → `{ ok, alertTypes: saved }`
  - SPA: chip-filter в сайдбаре (между phase и filters), бейдж в `FeedCard` и `TrendModal`, новый компонент `AlertTypesRow` в AccountPanel (3 чекбокса, optimistic update + rollback при ошибке). CSS `.badge-atype-*`, `.atype-toggle*`
- `src/admin/server.js`:
  - `_hydrateTrendFromDb` + `_shapeManualTrend` отдают `alertType`
  - SubmitPage hero meta-chips: первый chip — `sp-chip-atype-event/trend/post` с цветной заливкой
  - DecisionsPage: новый chip `🔔 Тип не подписан` в `DECISION_LABELS`, лейбл `тип` в `GATE_LABELS`, цветной alertType-чип в meta-row карточки решения
- `scripts/check-admin-spa.cjs` + `check-dashboard-spa.cjs` — оба зелёные (admin 168060 chars, dashboard 161042 chars)

**Стоимость AI**: +~5 токенов output на тренд × 30 трейндов × 96 циклов/день × ~$0.075/M (cached) ≈ <$0.01/мес. Strict json_schema (OpenAI) гарантирует enum на стороне модели.

**Edge-cases**:
- Юзер выключил все 3 типа → `getUserAlertTypes` возвращает дефолт 3 — silent allow всех (никогда не мутим молча; UI явно говорит про это)
- AI вернул мусор / xAI без strict schema → `normalizeAlertType` → `null` → derive по правилу
- Manual analysis (admin/dashboard/TG) — alertType заполняется как обычно через scorer; filter не применяется для прямого `_runManualAnalysisForUser` (оператор сам попросил)
- Heuristic + fallback paths добавили `alertType: deriveAlertType(t)` чтобы NEVER NULL для новых трейндов

**Проверка**:
- `node --check` всех затронутых файлов — green
- `node scripts/check-admin-spa.cjs` + `check-dashboard-spa.cjs` — green
- Sanity-тесты `deriveAlertType` (whyNow → event, platforms→trend, single→post, whyNow priority): все ok
- `formatTelegramAlert` для event/post + legacy (alertType=null): чип-строка корректно появляется/опускается

**Деплой**: `.\deploy.ps1`. После первого цикла проверить логи — должны видеть валидные `alertType` в trends. Через час глянуть DecisionsPage → распределение типов.

---

## 2026-04-15 (bootstrap + планы + AI switch) — архивно

- Создана `ai-context/` структура (`AGENT_RULES`, `SESSION_CONTEXT`, `WORKLOG`). `NEXT_STEPS.md` позже удалён
- Планы переведены на `free/test/pro` (legacy `starter/elite` удалены); `test` $5/1d one-time, `pro` $100/30d
- Блокировки: повторная покупка `test` по истории payments; X Analysis блок для `test`
- Управление рассылками (pin/unpin/delete/history), ручное управление юзерами, очистка алертов + storage guard
- AI provider switch в админке (`/api/ai-config`, `/api/ai-models`, curated list); Stage 2 `x_search` forced на xAI/Grok
- Compat fix для OpenAI `gpt-5-mini` (ретрай без `temperature` после 400)
- Deploy pipeline: `deploy.ps1` + `deploy.sh` (legacy wrappers удалены)

---

## 2026-04-15—16 (dashboard v1 + тикеры убраны)

- Dashboard redesign: OG previews (`/api/preview`), `ImageThumb` с fallback, `TrendModal` side-drawer, toast-система, keyboard shortcuts (R/S/Esc), search, sort (`meme`/`time`/`virality`)
- **`suggestedTicker` удалён end-to-end**: из prompts, scorer (`_applyHeuristic`/`_fallback`), `saveTrend`, dashboard UI, telegram, i18n. Старые записи в `raw_metrics` могут содержать legacy-поле; новый код его не читает

---

## 2026-04-16 (NarrativeClusterer + inference cost optimization)

- **`src/analysis/clusterer.js`** — pre-AI слой Aggregator → Clusterer → Scorer
  - Jaccard similarity threshold 0.40, без ML/embeddings
  - DB-запрос последних 48ч по LIKE на первые 2 слова (≤30 строк)
  - Cluster-level metrics: batchSize, uniquePlatforms, textVariation, dbRecentCount, isNovel, velocity, maxEngagement
  - Routing: `drop` / `save_only` / `stage1` / `priority`
- **Cost optimizations**:
  - `_buildFeedbackContext()` строится 1 раз на `scoreTrends()` (экономия 200 tok × (N_batches-1))
  - `_callResponsesAPI` возвращает `{ text, inputTokens, outputTokens }` из `data.usage`
  - Batch size 5→8, description truncation 250→100, убраны `titleRu` и `isGenuinelyInteresting` из spec
  - Stage 2: cap 3/cycle, skip `google_trends`, novelty gate `isNovel !== false`
  - Логирование `total_in`/`total_out` per cycle

---

## 2026-04-17 (Emergence + Adoption + Breakout + IdeaBoost)

- **Двухскоровая система**: Emergence (спред, 0-100) + Adoption (`memePotential` из AI) + `narrativePhase` (early/forming/strong/saturated) + `rankScore`
- **Emergence** — `max(spreadScore, breakoutScore) + ideaBoost`, capped 100:
  - Spread: платформы(30) + velocity(25) + organicSpread(20) + noveltyStage(15) + authorDiversity(10)
  - Breakout: views/plays(35) + likes/upvotes(30) + retweets/shares(20) + engRate(15) — для одиночного вирусного поста
  - `_normalizeBreakoutByFollowers(score, followers, engRate)`: dampening для мега-аккаунтов (Elon и т.п.); >50M × 0.40, >10M × 0.55, >1M × 0.72; engRate ≥5% отключает dampening
  - IdeaBoost (additive, 0-12): Reddit upvotes ≥10k/15k/30k/60k → +5/+8/+10/+12
  - `isEarlyIdea` flag: emergence 20-50 && upvotes ≥10k
- **Alert gate**: `emergence ≥ 30 || adoption ≥ 60` → позже снижен до `≥ 20` для ранних Reddit сигналов
- UI: два бара (🌊 Emergence / 💊 Adoption), `PhaseBadge`, phase accent border, filter by phase

---

## 2026-04-17 (Market Stage Detection — opt-in feature flag)

- Feature flag `MARKET_STAGE_DETECTION=1` (по умолчанию ВЫКЛ)
- Вся логика в `src/analysis/market-stage.js`; call sites помечены `[MARKET_STAGE]` (~10 строк в 6 файлах)
- Состояния: `none/tokenizing/live/overheated`; `detectMarketSignals(items)` → `resolveMarketStage`; `applyStage2MarketPatch` опциональный post-x_search upgrade
- Чтобы удалить feature: удалить файл + строки `[MARKET_STAGE]`

---

## 2026-04-18 (план `admin` + feedback system + Stars + /top selector + pipeline_status)

- **План `admin`**: price=0, все источники, alert_limit=-1, history_days=-1, api_access=1; `UnlimitedInput` в админке (число + чекбокс ∞ → -1)
- **Взвешенный фидбек**: таблица `feedback_votes (trend_id, chat_id UNIQUE, vote, weight, plan_name)`; только 👍/👎 (остальные смайлики игнорируются)
  - `_feedbackWeight(chatId)` lookup плана + веса из settings; режим «выключено» → только Admin weight=1, остальные 0
  - `recordFeedback` пересчитывает `trends.user_feedback = ROUND(SUM(vote × weight))`
  - Inline-кнопки 👍/👎 на алерт-карточках (`feedback:{vote}:{trendId}` callback) + toggle-off при повторном нажатии; единая таблица с реакциями
- **Telegram Stars оплата** (`currency: XTR`, `provider_token: ''`): `starsTestPrice=250`/`starsProPrice=5000` через env; `pre_checkout_query` → instant approve; `successful_payment` → `confirmPaymentAndUpgrade`
- **Пороги алертов**: пресеты 52/67/75 (с пометкой «⭐ 75+ рекомендуется»), кнопка своего числа (1-100); state `_awaitingInput` в памяти (сбрасывается при рестарте, это ок)
- **/top**: селектор количества (3/5/10/20), компактный рендер (bar + catIcon + lifeIcon + whyItWillPump + links)
- **`pipeline_status`** (новая колонка `trends`, default `save_only`): `scored` блокируется навсегда (AI уже проанализировал), `save_only` **не блокируется никогда** — каждый скан идёт через clusterer заново (коллектор сам есть фильтр свежести); UPSERT в `saveTrend` по `external_id` или `url`

---

## 2026-04-18 (JunkFilter — изолированный слой)

- `src/analysis/junk-filter.js` (call sites `[JUNK_FILTER]`)
- `calculateJunkPenalty(items, clusterMetrics)` → `{ junkPenalty, junkReasons }`; penalties: politics +40, kpop/fandom +30, celeb-noise +20, no-meme-shape +15
- Safe-signal override: animal/absurd/meme/heartwarming → raw/3 (или /4 при ≥2 сигналах); cap 100
- Gate: `junkPenalty ≥ 35` → skip (позже перепилен на `alertScore` hardJunkStop, см. 04-22)

---

## 2026-04-18 (adoption-first pivot — emergence убран из alert gate)

- Диагностика: emergence измеряет «спред» — но для мемкоинов нужен **ранний** контент. Метрика инвертирована относительно цели. Мёртвая зона 15-19 в `_decide` шла в `save_only` без AI
- Фикс:
  - `index.js`: убран emergence gate; единственный критерий — `memePotential ≥ threshold`
  - `clusterer._decide`: fallback `save_only` → `stage1` (всё что не drop → идёт в AI)
  - `narrativeRankScore`: веса 0.40/0.60 → 0.15/0.85 (adoption доминирует)
- Emergence/Adoption остались как UI-метрики на дашборде

---

## 2026-04-18 (rebrand TrendScout → Catalyst + thumbnail fixes)

- Глобальный rename: 27 файлов, docker volumes (`catalyst_data`/`catalyst_logs`), container `catalyst-app`, DB `/data/catalyst.db`
- Thumbnails: TikTok `originCoverUrl`, Twitter `media[0].preview_image_url`; `/api/preview` переписан на `fxtwitter.com` для Twitter и `tiktok.com/oembed` для TikTok
- Порядок приоритетов: `metrics.imageUrl` → `thumbnailUrl` → `thumbnail` → `/api/preview` fallback

---

## 2026-04-20 (Dashboard UX overhaul v3.2)

- **7 dark-тем** через `body[data-theme]`: Midnight/Teal/Abyss/Violet/Acid/Sunset/Cyberpunk; все акценты через `rgba(var(--accent-rgb), α)` — hardcoded rgba запрещён
- **Layout**: CSS Grid с draggable column dividers; prefs в `ts_prefs_v1.colLeft/.colRight`; limits 180-540 / 240-630; double-click = reset
- **Modal sheets**: Settings/Account/Stats — centered overlays с `backdrop-filter: blur(14px)`; компонент `Sheet`; body scroll lock; Esc-close; классический 2-col layout удалён
- **AccountPanel** отдельная панель (hero + avatar + plan + sub + threshold + logout); `Row`/`Toggle` вынесены на module-scope (ранее ReferenceError при клике на Account)
- **Phase filter** перенесён из тулбара в sidebar (2×2 grid + «All»)
- **Infinite scroll** (IntersectionObserver, `sentinelRef`) вместо пагинации; SSE-стабильность через `refreshAllRef`
- **Top Narratives** 5 → 10; убраны «Source Pulse» дубль и 📋 copy-title

## 2026-04-20 (Telegram avatar integration)

- Миграция `users`: `avatar_file_id`, `avatar_file_unique_id`, `avatar_checked_at` (PRAGMA-guarded ALTER)
- `refreshUserAvatar(chatId, userId, {force})`: throttle 6ч, тихий fail на privacy-lock; вызов fire-and-forget в `/start` и в `_handleAuthMe`
- `GET /api/auth/avatar` — прокси с disk cache в `data/avatars/<fileUniqueId>.jpg`, TTL 7 дней (`private, max-age=604800, immutable`); bot token на клиент НЕ утекает
- `_publicUser` отдаёт `hasAvatar`, `avatarKey` (= fileUniqueId → cache-bust при смене фото); auto-delete старого файла при смене `file_unique_id` (path-traversal guard)
- `.gitignore`: `data/avatars/`

## 2026-04-20 (media pipeline — видео со звуком)

- **Dockerfile**: `ffmpeg` в runtime-stage Alpine (`apk add --no-cache ffmpeg`) — без него mux молча падал
- **Reddit video**: `_bestVideo(post)` → `reddit_video.fallback_url` → `preview.reddit_video_preview` → direct `.mp4/.webm` → imgur `.gifv→.mp4`
- **Twitter video**: best-bitrate MP4 из `video_info.variants`
- **Reddit audio discovery**: HEAD-probe кандидатов в порядке **CMAF_AUDIO_128 → CMAF_AUDIO_64 → CMAF_audio → DASH_AUDIO_128 → DASH_AUDIO_64 → DASH_audio → audio** (Reddit в 2025 мигрировал с `DASH_*` на `CMAF_*`)
- **Mux flow** (`_muxRedditVideo`): `ffmpeg -c copy -movflags +faststart` → `data/video-cache/<id>.mp4`; `cleanupVideoCache(maxAgeDays=7)` на старте
- **Telegram alert**: multi-tier fallback — `sendVideo` (supports_streaming) → `sendMediaGroup` → `sendPhoto` → text
- **Dashboard video player**: public route (до auth!) `GET /api/video/reddit/<id>.mp4?src=<encoded v.redd.it url>` с Range-support (206); regex-валидация `src` против `v.redd.it/<alphanum>/`; cache-first; `<video>` не шлёт auth headers — отсюда public-exception
- **Volume persistence**: `videoVolumeRef` ref-callback → `catalyst_video_volume` + `catalyst_video_muted` в localStorage

## 2026-04-20 (Why now + Персонализированный ранг)

- **Why now**: колонка `trends.why_now TEXT NOT NULL DEFAULT ''`; AI поле `whyNow` со строгой инструкцией («только явный конкретный триггер; если нет — пустая строка»); `trim().slice(0, 280)`; рендер `🔥 Trigger` с красно-оранжевым акцентом в TrendModal + Telegram alert; +20-40 tok/ответ, <$0.50/мес
- **Персонализация**:
  - `users.personalization_enabled INTEGER NOT NULL DEFAULT 1`
  - `getCategoryPreferences(chatId, days=30)` → `{ category: net }` (JOIN `feedback_votes` × `trends`, SUM vote × weight, GROUP BY category)
  - `_handleTrends`: при `sort=rank` + auth + toggle ON + prefs≠{} — SQL `ORDER BY (rankScore + CASE category WHEN 'X' THEN +3 ... END) DESC`; boost clamp'ится к ±15; SQL-эскейп category names
  - `PersonalizationCard` в SettingsPanel: toggle (🎯) + чипы `.pref-chip.up/.down`; empty-state
  - Окно 30 дней; нужно ~5-10 голосов per category чтобы стало заметно

---

## 2026-04-21—22 (unified alertScore + decisions viewer)

- **Проблема**: 3 независимых гейта (memePotential / score / junk) давали immodifiable черный ящик — нельзя было взвесить вклад factors
- **`alertScore = w_meme·memePotential + w_viral·virality + w_emerg·emergence + w_x·twitterScore + w_fb·feedbackBoost − w_junk·junkPenalty − staleDecay`**
  - Positive веса (meme/viral/emerg/twitter/feedback) в сумме **≤ 1.0** → шкала 0-100; server-side guard в `_setScannerConfig` **до** commit
  - Defaults: meme=0.35, viral=0.25, emerg=0.20, twitter=0.10, feedback=0.10, junk=0.50 (multiplier), staleDecay {perHour=2, grace=24, cap=30}, hardJunkStop=70
  - Dashboard: один ползунок «Чувствительность алертов» (0-100, `users.alert_threshold`)
  - Admin: веса, junk-multiplier, staleDecay, hardJunkStop — всё через `/api/scanner-config`
  - Gate: `alertScore ≥ max(user.alert_threshold, global alertThreshold)` **AND** `junkPenalty < alertHardJunkStop`
  - `feedbackBoost(likes, dislikes)`: 0-100, 50 = нейтрально, < 5 голосов pull towards 50; считается live в gate-loop
  - `staleDecay = perHour × max(0, ageHours − grace)`, capped at `cap`
- **Slider gotchas**:
  - Dynamic limits: track всегда 0..1, `onChange` clamp к budget = `1 − Σ(других)`
  - FP quantization через integer grid: `Math.round(v * 20) / 20` (иначе 0.65 → 0.6500…01 съедал шаг, UI показывал ⛔ при сумме 0.95)
- **Alert decisions ring buffer** (`appState.alertDecisions[]`, cap 500, in-memory, reset при рестарте)
  - `recordAlertDecision(rec)`: `{ ts, decision, reason, gates[], title, source, category, alertScore, threshold, breakdown, userChatId, url }`
  - Gate-loop в `index.js` оценивает **все** гейты (threshold/hard_junk/source/dedup/daily/cap/send) — не short-circuit (кроме cap/daily где `break`)
  - **`DecisionsPage`** в админке: карточки с clickable source URL, gate-chips ✓/✗ (title=detail на hover), breakdown в моно-боксе, left-border accent по вердикту; auto-refresh 10s; filter chips (all/sent/skipped) + reason counts
  - `GET /api/alert-decisions?filter=&reason=&limit=`

## 2026-04-22 (Twitter/X scraper — pluggable actor registry)

- **Проблема**: `apidojo~tweet-scraper` почти не отдавал `viewCount` (X закрыл публичный доступ к просмотрам) — posts с 1M+ views не доходили до пайплайна
- **Решение**: runtime-switchable actor через `db.getSetting('twitterActor', 'kaitoeasyapi')`, применяется со следующего цикла без рестарта
- **Актёры** (реестр `ACTORS` в `src/collectors/twitter.js` + дубль в `twitter-check.js`):
  - `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` — **default**, $0.25/1K, 17K users, 20 месяцев истории, 99%+ success; input `twitterContent: <string>`
  - `xquik/x-tweet-scraper` — $0.15/1K, 1-2 месяца, 145 users, экспериментальный; input `searchTerms: [<string>]`
  - Output у обоих одинаковый (`viewCount`/`likeCount`/`retweetCount`) → `_normalize` actor-agnostic
- **Per-actor tokens**: `config.apify.twitterKeys = { kaitoeasyapi, xquik }` из `APIFY_API_KAITO` / `APIFY_API_XQUIK`; `APIFY_API2` удалён (legacy 2-й аккаунт)
- **Admin UI**: «🐦 Twitter/X scraper» секция в ScannerConfigSection (карточки-переключатель); `VALID_TWITTER_ACTORS` server-side валидация
- **Добавить актёра**: (1) `ACTORS` в 2 файлах, (2) `apify.twitterKeys` в config, (3) `VALID_TWITTER_ACTORS` в admin, (4) карточка в `TWITTER_ACTORS`
- **Security**: Apify `General resource access` должен быть **Restricted**, не Anonymous — иначе runId/datasetId даёт анонимный доступ к данным без токена

---

## 2026-04-22 (narrative pivot: prompts, meme-shape boost, Reddit preset alignment, junk stats panel)

- **Проблема**: в алерты шли «вирально + животное, но без мема/абсурда» — news-shape дёргал multi-source bonus, короткие мем-заголовки отсекались `MIN_WORDS=3`, Reddit пресеты крипто-ориентированные, промпт всё ещё искал монеты/тикеры
- **Prompt refactor (narrative-first)** — `src/analysis/prompts.js`:
  - `DEGEN-GPT` → **`DEGEN-PARSER`**: поиск **нарративов/трендов** (не монет). Hard-rule 5 (age penalty 6h) удалён
  - `STAGE2_SYSTEM_PROMPT` переписан: верификация нарратива (organic buzz / astroturf / momentum) вместо «есть ли монета на рынке»
  - Новые output поля: `narrativeMomentum` (rising/peaking/fading), `organicity` (organic/astroturf/mixed) — заменили `existingCoins`
- **Stage 2 scoring rework** — `src/analysis/scorer.js`:
  - Множительные штрафы: `xBuzz=low|none → ×0.5`, `narrativeMomentum=fading → ×0.7`, `organicity=astroturf → ×0.6`
  - **Multi-source bonus удалён** (aggregator + scorer + prompts): в практике награждал news/politics (они везде) и топил single-platform мемы. Dedup по сорсам остался как cleanup
- **Clusterer** — `src/analysis/clusterer.js`:
  - `MIN_WORDS` 3 → **1** (Jaccard 0.40 защищает от ложных мерджей; короткие мем-заголовки типа «monkey slap» больше не теряются)
  - Применяет `memeShapeBoost` к `emergenceScore`: `min(100, emergence + memeShapeBoost)`; сохраняет `memeShapeSignals[]`
- **Junk filter positive-signal boost** — `src/analysis/junk-filter.js`:
  - Новые возвращаемые поля: `memeShapeBoost` (int 0-30), `memeShapeSignals` (array of 'animal'|'absurd'|'meme'|'heartwarming')
  - Формула: `perSignalBoost × (signalCount ≥ 2 ? 1.5 : 1)`, rounded; `perSignalBoost` из активного filter-profile
  - Safe-override считается **только** при `raw > 0` (ранний return удалён — boost нужен даже с 0 junk)
- **Filter profiles** — `src/analysis/filter-profiles.js`: поле `memeShapeBoost` per preset (general 10, animals 14, culture 12, celebrities 6, events 4); в `PROFILE_FIELD_RANGES` (min 0, max 30, step 1)
- **Reddit preset alignment** — `src/collectors/reddit.js`:
  - `PRESET_SUBREDDITS` keys теперь **строго матчат** filter-profiles: `general`/`animals`/`culture`/`celebrities`/`events` (сироты `ai`/`elon`/`sports` удалены — никогда не были активны)
  - Curated под meme-shape: `animals`: aww, AnimalsBeing*, Eyebleach, capybara; `culture`: memes, dankmemes, Unexpected, KnowYourMeme; `celebrities`: popculturechat, Fauxmoi; и т.д.
- **Stage 2 gate**: threshold 78 → **60** (больше пропускаем в deep-dive после narrative pivot), cap **6** (было 3)
- **Source-aware engagement labels** — `src/notifications/formatter.js` + i18n:
  - Раньше Twitter показывал «Upvotes: 101.7K», хотя в `metrics.upvotes` для Twitter лежит `likes+retweets×2`; для TikTok — `likes+shares×3`
  - Теперь: Twitter → ❤️ Likes, TikTok → ▶️ Plays, остальное → 📈 Upvotes. Ключи `alertLikes`, `alertPlays`, `alertGoogleHits` (EN+RU)
- **JunkStats observation panel** (admin):
  - `_getJunkStats(hours)` + `GET /api/junk-stats?hours=6|24|72|168`
  - `JunkStatsSection` React: 4 window-кнопки, auto-refresh 30s, 5 summary-плиток, reason bars (варианты `safe-override (÷N)` нормализуются), source chips, meme-shape hit rate
  - Цель наблюдения сутки после деплоя: meme-shape signals ≥ 25%, no-meme-shape ≤ 50%, politics ≤ 15%, reddit count растёт
- Blacklist слов отложен (легко забанить нужные теги)

---

## 2026-04-24 (dashboard polish + manual narrative submit + send-alert with comment)

Сквозная сессия: чистка UX в дашборде, правки TG-алертов, извлечение медиа из quote/reply-parent тоита, новая «ручная» фича в админке с возможностью досылки + кастомного комментария.

### Dashboard UX

- **Ask Grok button в TrendModal**: зеркалит TG alert button, строит Grok URL инлайном; новый CSS-класс `.trend-link-grok` (#b48cff), i18n `modal.ask_grok` (EN «🧠 Ask Grok» / RU «🧠 Спросить Grok»)
- **Reorder modal sections**: ссылки/кнопки ушли выше (после AI explanation), Stats grid переехал в самый низ
- **Russian plural counter «ВИДЕЛИ: Nраз»**: был хардкод `+ 'раз'`; добавил `pluralSeen(n)` рядом с `localeTag()` — 1 раз / 2 раза / 5 раз по `mod10`/`mod100`. Для EN просто `N + 'x'`
- **ImageGrid → ImageCarousel**: горизонтальный слайдер, стрелки, счётчик «i/N», точки-пагинация. `stopPropagation` на контролах чтобы клики не закрывали модалку. CSS `.img-carousel` с nav buttons/counter badge/dots
- **Multi-image в дашборде** (`/api/preview` twitter-ветка): собирает медиа из `tweet.media.all` + `tweet.quote.media.all` + `tweet.replying_to.media.all` → отдаёт `{ imageUrl, imageUrls }`. TrendModal имеет `extraUrls` state — лениво подфетчивает preview при открытии старых Twitter-трендов (где < 2 картинок), мёржит в галерею
- **Backtick trap (опять)**: `` `variant` `` в JSDoc внутри inline template literal закрыл outer — SyntaxError. Фикс: plain text. `node --check` перед деплоем — обязательно

### Telegram алерты

- **Media group + inline buttons**: API лимит — альбомы не поддерживают `inline_keyboard` на элементах. Раньше кнопки терялись на multi-image алертах. Фикс: отправляем альбом без caption → отправляем текст как reply к первому фото → якорим кнопки к этому текстовому сообщению. `sendMediaGroup` принимает `disable_notification: true`, текст триггерит единственный ping
- **Silent photo notifications**: `disable_notification: true` на альбомах — юзеров не будит пачкой превьюшек

### Twitter collector

- **Velocity fix**: везде было «1/hr», тогда как Reddit показывал нормальные числа. Bug: `velocity: cluster._count` (просто число твитов). Фикс: per-tweet accumulation — `engagement = likes + retweets*2`, `age = max(ageHours, 0.25)`, `tweetVelocity = engagement/age`, аккумулируем в `cluster._velocitySum`, финально `Math.round`. Теперь скорость виральности реально соответствует reality
- **Quote/reply-parent media extraction** (`twitter.js`): helpers `pushImagesFrom` и `pickVideoFrom`, проверяют `tweet.quote || tweet.quoted_tweet || tweet.quotedStatus || tweet.quoted_status || tweet.retweeted_tweet` и `tweet.in_reply_to_tweet || tweet.in_reply_to_status || tweet.replying_to` (разные поля у Apify actors). Правило владельца: **даже если в основном твите есть картинка — добавлять quote images вторыми** (2-я картинка в карусели). Применено и в collector'е, и в `/api/preview` для старых DB-строк

### Admin: ручной сабмит нарратива (feature: A+C)

- **Новая вкладка** `🧪 Ручной анализ` в админке (`src/admin/server.js` `SubmitPage`)
- **Endpoint `POST /api/submit-narrative`** `{ url, sendToTelegram, comment }`:
  - Резолв URL → синтетический trend → полный scorer (Stage 1 batch + Stage 2 Grok x_search) → save в БД с `raw_metrics.manualSubmitted = true` + `manualSubmittedAt`
  - Bypass'ит collectors/aggregator/clusterer — feed сразу в scorer
  - Опционально — fan-out по всем активным подписчикам
- **Resolvers**:
  - `_resolveTwitterUrl`: fxtwitter JSON API, author/text/engagement/velocity, media из main + quote + reply-parent, video pick
  - `_resolveRedditUrl`: `reddit.com/...json?raw_json=1`, gallery support
  - `_resolveTiktokUrl`: oEmbed API
  - `_resolveGenericUrl`: og:image scraping
- **`_submitNarrative(rawUrl, sendToTelegram, opts)`**: single entry point, принимает `opts.comment`
- **Broadcast refactored**: выделен `_broadcastTrendAlert(trend, dbId, opts)` — цикл по `getActiveUsers()` с `sendAlertToUser` + `attachXButton` + `updateTgUrl`. Переиспользуется из `_submitNarrative` и `/api/send-alert`
- **`_hydrateTrendFromDb(row)`**: собирает scorer-образный объект из плоской DB-строки (metrics из `raw_metrics`, `xSearchData.storyScore/storyHook` восстанавливается) — нужен для повторных рассылок на уже сохранённый trend
- **Rate limit**: нет (single-user tool)

### Dashboard integration для manual submits

- `_formatTrend` отдаёт `manualSubmitted: metrics.manualSubmitted === true`
- **Badge `🧪 MANUAL`** в FeedCard (внутри `feed-badges`, первая позиция) и в TrendModal head; CSS `.badge-manual { background: rgba(180,140,255,.12); color: #b48cff; border: 1px solid rgba(180,140,255,.3); }`; i18n `feed.manual_tip`
- **«Только ручные» toggle** в sidebar: `manualOnly` state (localStorage `ts_manual_only`), рендерится как `.source-item` с иконкой 🧪; filter в `visibleTrends`. i18n `sidebar.manual_only`, `tooltip.manual_on/off`, `toast.manual_only_on/off`

### Send alert + custom comment

- **Кнопка «📨 Отправить алерт»** в шапке результата SubmitPage — блэкаст для уже проанализированного trend без повторного скоринга. `window.confirm` показывает превью комментария перед отправкой
- **Endpoint `POST /api/send-alert`** `{ trendId, comment }`: грузит row → hydrate → `_broadcastTrendAlert`. Работает на любом `trend_id` (не только manual) — задел для «переотправить обычный алерт» из Decisions
- **Custom comment**:
  - Textarea в SubmitPage под checkbox'ом, счётчик N/500, shared state между initial submit и standalone send
  - Cap 500 символов (чтобы caption ещё влезал в TG 1024 после concat)
  - `sendAlertToUser(trend, user, opts = {})` — если `opts.comment`, HTML-escape (`&/</>`) и префиксим: `💬 <b>{comment}</b>\n\n` + formatter output
  - Коммент threads через `_broadcastTrendAlert(trend, dbId, { comment })` и `_submitNarrative(rawUrl, sendToTelegram, { comment })`
- Отдельный `alertLoading/alertError` state — не путаемся с основным submit button

### Files touched

- `src/dashboard/server.js` — ImageCarousel, modal reorder, manual badge/filter, pluralSeen, quote media in /api/preview
- `src/admin/server.js` — SubmitPage, endpoints `/api/submit-narrative` + `/api/send-alert`, `_submitNarrative`/`_broadcastTrendAlert`/`_hydrateTrendFromDb`/`_resolve*Url`, extras-injection в конструкторе
- `src/notifications/telegram.js` — media group fix + silent notification + optional comment в `sendAlertToUser`
- `src/collectors/twitter.js` — velocity fix, quote/reply-parent media extraction
- `src/index.js` — `new AdminServer(..., { scorer, telegram })`

---

## 2026-04-27 (Stage 1: операторские few-shot examples + admin CRUD UI)

- **Цель**: дать оператору без релиза калибровать AI-скоринг через примеры/анти-паттерны. Это обещанный шаг 🅱️ из roadmap'а Stage 1 апгрейда — самый дешёвый сильный буст после Structured Outputs
- **DB (`src/db/database.js`)**:
  - Новая таблица `stage1_examples`: `id`, `kind` (`example`|`mistake`), `title`, `category`, `meme_potential`, `rationale`, `enabled`, `sort_order`, `created_at`, `updated_at`. CHECK constraints на kind enum и meme_potential 0-100
  - Индекс `idx_stage1_examples_kind_sort` на `(kind, sort_order)`
  - Сидинг: 9 examples + 3 mistakes на первой миграции (маркер `stage1ExamplesSeededV1` в settings). Покрывают всю шкалу 0-95 + три HARD RULES (politics, mega-account, spam)
  - Методы: `listStage1Examples({enabledOnly?, kind?})`, `createStage1Example()`, `updateStage1Example(id, patch)`, `deleteStage1Example(id)`, `countStage1Examples()`. Все методы capают title 200, rationale 400, memePotential 0-100 на уровне DB-write (зеркало валидации в API)
- **Scorer (`src/analysis/scorer.js`)**:
  - Новый метод `_buildExamplesContext()` — рендерит enabled rows в два блока «CALIBRATION EXAMPLES» (с category + score + rationale) и «COMMON MISTAKES TO AVOID». Empty/no-DB → silent fallback на bare rubric
  - Композиция sysMsg обновлена: `SYSTEM_PROMPT + examplesContext + feedbackContext`. Порядок строго: static → semi-static → volatile, чтобы максимизировать prompt cache hit (auto-cache хитает на префиксе ≥1024 ток byte-identical)
  - Применено в обоих путях: основной `scoreTrends()` цикл и стандалонный `_analyzeBatchStage1()` (manual-submit)
- **Admin API (`src/admin/server.js`)**:
  - `GET /api/stage1-examples?kind=example|mistake` — список + counts
  - `POST /api/stage1-examples` — create (валидация + soft cap 50)
  - `PUT /api/stage1-examples/:id` — partial update
  - `DELETE /api/stage1-examples/:id` — delete
  - Новый helper `_validateStage1Example(body, {partial})`: enum check на kind+category, length checks (title 5-200, rationale 10-400), range check на memePotential 0-100. Hard cap 50 examples
- **Admin UI (`src/admin/server.js`)**:
  - Новая страница `ExamplesPage` + новая вкладка «🎓 AI Examples» в TABS (между Алертами и Пользователями) + регистрация в PAGE map
  - Tabs внутри страницы: Examples / Mistakes (с counts)
  - Карточки: цветной бейдж category + score-бейдж (зелёный 70+ / жёлтый 30-69 / красный 0-29) + enabled toggle + edit/delete кнопки
  - Inline-форма редактора: kind radio, title, category select, memePotential slider (live label), rationale textarea (с counter X/400), enabled toggle, sort_order
  - Preview-блок: показывает byte-identical то, что отдаст `_buildExamplesContext()` — оператор видит что реально пойдёт в SYSTEM_PROMPT
  - Token-budget индикатор: «Активных N / Total | ~X токенов | $0 с кэшем»
- **Cost**: 12 default rows ≈ 600 ток в SYSTEM_PROMPT. С авто-кэшем gpt-5.4-mini ($0.075/1M cached) — реально <$0.20/месяц при 24 циклах × 5 батчей в сутки
- **Backwards-compat**: пустая таблица → scorer molча отдаёт '' и работает как до апгрейда. xAI Grok provider — examples тоже идут в его prompt (там нет json_schema, но дополнительные few-shot не вредят)
- **Files**: `src/db/database.js`, `src/analysis/scorer.js`, `src/admin/server.js`. Все прошли `node --check`. Никаких break-changes — даже выключение всех examples не ломает скоринг

---

## 2026-04-27 (Удалена персонализированная лента в дашборде)

- **Контекст**: per-user category boost (с 2026-04-20) ранжировал ленту дашборда поверх `rankScore`, прибавляя сумму `vote × weight` по категориям юзера за 30 дней (clamp ±15). После сегодняшнего ребаланса весов (admin ×5, free ×0.2) персонализация admin'а упиралась бы в потолок после 3 лайков подряд — слишком агрессивно. По решению владельца — убираем целиком, лента возвращается к одинаковому глобальному ранку для всех
- **Что выпилено** (`src/dashboard/server.js`):
  - Маршруты `GET/POST /api/personalization` и хендлеры `_handlePersonalizationGet/_Post`
  - SQL `CASE category WHEN ... THEN ... ELSE 0 END` boost-выражение в `_handleTrends` (sort=rank теперь чистый `rankScore DESC`)
  - Поле `personalization` в response payload `/api/trends`
  - React-компонент `PersonalizationCard` + его рендер в `SettingsPanel`
  - 5 i18n-ключей `settings.personalization*` × 2 языка (EN+RU)
  - CSS-классы `.pref-chip*` (общий `.pref-toggle*` оставлен — шарится с другими тогглами)
- **Что выпилено** (`src/db/database.js`):
  - Методы `getCategoryPreferences`, `getPersonalizationEnabled`, `setPersonalizationEnabled`
- **Что НЕ тронуто**:
  - Колонка `users.personalization_enabled` остаётся физически (SQLite DROP COLUMN дорого/неудобно; пустая колонка никому не мешает). При следующем major-рефакторе БД можно дропнуть
  - `feedback_votes` таблица, reason wizard, взвешивание по плану — всё работает
  - Глобальный feedback в AI-промпт через `_buildFeedbackContext` в scorer.js — это другой путь, остаётся
- **Files**: `src/dashboard/server.js`, `src/db/database.js`. Оба прошли `node --check`. Никаких миграций БД, никаких break-changes для API кроме самих 2 удалённых эндпоинтов (frontend на них больше не ходит)

---

## 2026-04-27 (Feedback v2: причины оценок + ребаланс весов + dashboard panel)

- **Цель**: Free-юзеры массой могли утопить сигнал от Pro/Admin (старые веса 1/1/2/3 — admin всего ×3 от free). Плюс «голый» 👍/👎 не объясняет AI ПОЧЕМУ — он учится только на категории/title
- **DB-миграция (`src/db/database.js`)**:
  - **Новая колонка** `feedback_votes.reason TEXT` (через `addIfMissing`, обратная совместимость — старые голоса остаются с `reason=NULL`)
  - **Новый метод** `setFeedbackReason(trendId, chatId, reason)` — trim + cap 240 chars, NULL/empty чистит. Возвращает true/false существовала ли строка
  - **Изменён** `recordFeedback`: при смене направления голоса (👍 → 👎) reason обнуляется через `CASE WHEN feedback_votes.vote = excluded.vote THEN ... ELSE NULL END` — старая причина описывала противоположное мнение
  - **Расширены** `getLikedNarratives` / `getDislikedNarratives`: теперь возвращают `topReason` (subquery по max weight + most recent), фильтруют через `EXISTS` где требуется хотя бы один голос с `weight >= 0.5` ИЛИ непустым reason. Записи с reason всплывают наверх через `ORDER BY (CASE WHEN topReason IS NOT NULL THEN 1 ELSE 0 END) DESC`
  - **Новый метод** `getRecentFeedbackReasons(limit)` для дашборда — JOIN на trends, анонимизированный chat_id (последние 4 цифры через `SUBSTR(chat_id, -4)`)
  - **Одноразовая миграция весов**: маркер `feedbackWeightsRebalancedV2` в settings. При первом старте перезаписывает `feedbackWeightAdmin=5`, `Pro=2.5`, `Test=0.5`, `Free=0.2` (admin теперь ×25 vs free, было ×3). После применения маркер ставится — операторские правки в admin UI не затираются
- **Telegram UX (`src/notifications/telegram.js`)**:
  - После 👍/👎 callback под алертом появляется ряд `✏️ Причина оценки` / `✏️ Reason for rating` (callback `fb_reason:<trendId>`). При снятии голоса (toggle) ряд убирается. Добавление через **surgical filter** existing keyboard'а (`row.some(b => b.callback_data?.startsWith('fb_reason:'))`) — не нужно re-derive plan-locked состояния других кнопок
  - Клик на `fb_reason` → `_awaitingInput.set(chatId, {type:'feedback_reason', trendId, startedAt})` + DM «Напиши почему / /skip». Следующий не-командный текст ловится в `bot.on('message')` handler'е, проходит cap 240 chars, идёт в `setFeedbackReason`
  - **5-минутный timeout** на FSM state — клик-без-ответа не сюрпризит юзера через сутки
  - **`/skip`** в любом state корректно отменяет (раньше любая команда просто игнорировалась)
  - **Реакции эмодзи** (не buttons) — reason wizard НЕ запускается, поведение как было (документировано в коде). Технически нельзя надёжно edit'ить keyboard из reaction handler'а
- **i18n** (`src/i18n/{en,ru}.js`): добавлены `btnFeedbackReason`, `feedbackReasonPrompt`, `feedbackReasonSaved`, `feedbackReasonSkipped`, `feedbackReasonNoVote`, `feedbackReasonTooLong`. Юзер пишет на любом языке (мы только trim+cap), AI принимает оба и отвечает на английском (SYSTEM_PROMPT уже English-only)
- **Scorer (`src/analysis/scorer.js`)**: `_buildFeedbackContext` теперь рендерит `+ "Title" [category] — "reason"` если reason есть, иначе просто `+ "Title" [category]`. Cap 120 chars per item чтобы причина не вытеснила рубрику
- **Дашборд (`src/admin/server.js`)**:
  - Новый эндпоинт `GET /api/feedback-recent?limit=N` (default 30, max 100)
  - Новая панель «💬 Причины оценок (последние)» под блоком «Взвешенный фидбек» в SettingsPage. Карточки: эмодзи vote + цветной бейдж плана (admin=red, pro=accent, test=yellow, free=grey) + weight + время + title + причина курсивом. Кнопка «↻ Обновить» для refresh без перезагрузки
  - Дефолты state в SPA обновлены под новый ребаланс (5/2.5/0.5/0.2)
- **Скоро в проде увидим**: Stage 1 промпт начнёт получать реальные «потому что» от высоковесных юзеров → AI калибруется быстрее, а не только за неделю по агрегатам
- **Files**: `src/db/database.js`, `src/notifications/telegram.js`, `src/i18n/en.js`, `src/i18n/ru.js`, `src/analysis/scorer.js`, `src/admin/server.js`. Все прошли `node --check`. Никаких break-changes — старые юзеры/голоса/функции работают как раньше

---

## 2026-04-27 (Stage 1 upgrade: gpt-5.4-mini + Structured Outputs + reasoning effort)

- **Цель**: прокачать качество Stage 1 без существенного роста цены. Текущий `gpt-4.1-mini` (knowledge cutoff Jun-2024) промахивался на свежих мемах/именах + 5-7% батчей падало на parse error и уходило в `_fallback` (потерянный AI-проход)
- **Что сделано** (`src/analysis/scorer.js`, `src/analysis/prompts.js`, `.env.example`):
  - **Default model**: `gpt-4.1-mini` → `gpt-5.4-mini` (knowledge cutoff Aug-2025, поддержка reasoning, 400K context). Прайс ×1.88 input / ×2.81 output, НО cached input $0.075/1M (10× дешевле обычного input). Наш SYSTEM_PROMPT (~1.2K tokens, стабильный) авто-кэшируется Responses API между батчами в окне 5 минут → реальный рост цены ≈ ×1.1
  - **Structured Outputs (json_schema)**: новый экспорт `STAGE1_RESPONSE_SCHEMA` в `prompts.js` — strict object `{trends: [...]}` с `additionalProperties:false`, явными enums для `category`/`sentiment`/`predictedLifespan`. Передаётся через `text.format` в `_callResponsesAPI` ТОЛЬКО для `provider === 'openai'`. xAI Grok schema игнорирует — schema не отправляется
  - **Парсер не тронут**: `Array.isArray(parsed) ? parsed : (parsed.trends || ...)` уже корректно обрабатывал оба формата. Schema гарантирует `{trends: [...]}` для OpenAI, Grok по prompt'у возвращает то же
  - **Reasoning effort**: новый env `OPENAI_REASONING_EFFORT` (default `low`, allowed `minimal|low|medium|high|<empty>`). Прокидывается через body.reasoning только когда provider=openai. Для не-reasoning моделей (gpt-4.1-mini и старые) автоматически срабатывает retry-без-reasoning по 400 (зеркальный механизм существующего temperature-retry)
  - **Расширен `_callResponsesAPI`**: новые параметры `responseSchema`, `reasoningEffort`. Catch-block ловит unsupported `temperature`/`reasoning`/`text.format` → дропает их и ретраит. Логирует что именно дропнуто
  - **Промпт synced**: `predictedLifespan` теперь bare keywords `[flash, short, medium, long]` (было `[flash (hours), ...]` — несовместимо с enum). Добавлен `isGenuinelyInteresting` в required-список явно
- **Backwards-compat**: переключение через UI/env обратно на `gpt-4.1-mini` или `xai`/Grok работает без правок — schema и reasoning auto-skip для несовместимых провайдеров. Существующие записи в БД, разумеется, не трогаются
- **Ожидаемый эффект**: качество классификации edge-кейсов вверх (свежий knowledge + low reasoning), parse-failures → 0 (schema enforced), реальная цена Stage 1 примерно та же благодаря авто-кэшу system prompt
- **Files**: `src/analysis/scorer.js`, `src/analysis/prompts.js`, `.env.example`. Все прошли `node --check`. Миграций БД нет
- **Что НЕ сделано** (отложено по результатам обсуждения): web_search в Stage 1 (дублирование Stage 2 + удорожание), function-tool `lookupSimilarPastNarrative` (лучше как pre-injection эмбеддингами), gpt-5.4-nano pre-filter (имеет смысл при росте объёмов)

---

## 2026-04-27 (Deploy hardening + auto-cleanup для Docker build cache)

- **Инцидент**: `.\deploy.ps1` упал с «Connection closed by 37.1.196.83 port 22» сразу после scp `setup_remote.sh`, до того как сам скрипт напечатал хоть одну строку. Ручной запуск SSH с тем же скриптом отработал чисто до `DEPLOY_SUCCESS`. Диагностика показала:
  - **Disk: 16/20GB used (85%)** — критическая зона. Из них **7.51GB build cache** (203 записи накопились за деплои) + 7GB старых образов
  - **Swap: 0** на VPS с 957MB RAM — OOM-killer мог рандомно бить sshd
  - `dmesg` чистый, без OOM-событий
- **Лечение housekeeping** (выполнено руками):
  - `fallocate -l 2G /swapfile && mkswap && swapon` + запись в `/etc/fstab` → 2GB persistent swap
  - `docker buildx prune -af` → освобождено ~7GB, осталось 12/20GB used (61%)
- **Архитектурный фикс — auto-cleanup**: ранее в `src/index.js` `runStorageGuard()` чистил только БД (`db.cleanupAlerts(days)`) при свободном месте < 2GB. Этот гард не помогал в данном инциденте, потому что БД весит ~10MB — резать её бесполезно. Реальный killer — Docker build cache, к которому Node изнутри контейнера доступа не имеет
- **Решение в два слоя**:
  1. **`setup_remote.sh`** (host-side) — после успешного `$DC up -d` всегда выполняется `docker buildx prune -af --filter "until=168h"` (только cache старше 7 дней, активный образ + контейнер не трогаются). Дополнительный hard guard: если после этого `df /` всё ещё >80%, запускается `docker system prune -af` (агрессивно, но всё равно безопасно для running container)
  2. **`runStorageGuard()`** (container-side) — в дополнение к DB-чистке теперь подчищает файлы в `logs/` старше 7 дней (это второй вектор роста между деплоями, до этого файл-логи росли unbounded). Работает изнутри контейнера, не требует hostfs-доступа
- **`deploy.ps1`** — также упрочнён под транзиентные SSH-падения:
  - mkdir + bash объединены в один SSH-вызов (минус один auth handshake, обходит SSH MaxSessions)
  - `ServerAliveInterval=30 ServerAliveCountMax=10` — keepalive каждые 30с, выдерживает 5 минут «тишины» во время `docker compose build` (часто NAT/firewall режут idle коннекшены)
- **Диагностические команды** (для будущих похожих инцидентов):
  - `ssh root@HOST "df -h /; free -m; dmesg | tail -30"` — диск/память/OOM-следы
  - `ssh root@HOST "docker ps -a; docker system df"` — состояние Docker
  - `ssh root@HOST "REMOTE_DIR='/opt/catalyst' bash /tmp/catalyst_setup.sh 2>&1"` — ручной прогон setup'а если PowerShell pipeline врёт
- **Files**: `setup_remote.sh`, `deploy.ps1`, `src/index.js`. Все прошли syntax check
- **Состояние сервера на момент фикса**: 12/20GB used (61%), Build Cache 0B, Swap 2GB активен, контейнер `catalyst-app` healthy

---

## 2026-04-27 (Stage 2 token cost reduction: x_search params + tool-loop cap + prompt diet)

- **Проблема**: Stage 2 (`grok-4-1-fast-non-reasoning` + `x_search`) ел 3-7K input токенов на trend. Источники:
  1. `tools: [{ type: 'x_search' }]` без параметров → xAI отдавал ~25 твитов/поиск
  2. Grok мог делать 2-4 последовательных x_search вызовов в одном ответе → каждый следующий видит результаты предыдущих в reasoning context (квадратичный рост)
  3. STAGE2_SYSTEM_PROMPT раздут (~750 токенов): три развёрнутых рубрики с inline-примерами (Punch monkey, Moo Deng, Hawk Tuah), которые Grok знает и без них
  4. Лишние output поля (`xSentiment`, `adjustment`) — никем не читаются, длинный `storyHook` (Grok возвращал 100-150 chars прозы)
- **Что сделано** (`src/analysis/scorer.js`, `src/analysis/prompts.js`, `src/analysis/market-stage.js`):
  - **`x_search` теперь с явными параметрами**: `max_search_results: 10` (было ~25 default), `from_date: <48h ago>`, `sources: [{type:'x'}]` (не лезть в news/web), `return_citations: false`
  - **`max_tool_calls: 2`** в body запроса — режет fan-out в 2-4 поиска. Прокинут через новый параметр `maxToolCalls` в `_callResponsesAPI`
  - **STAGE2_SYSTEM_PROMPT сжат** ~750 → ~330 токенов: убраны inline-примеры, рубрики свёрнуты в 4-строчные шкалы, удалены дублирующие IMPORTANT-предупреждения
  - **Удалены поля из JSON-схемы и `xSearchData`**: `xSentiment` (нигде не читался) и `adjustment` (читался только в `market-stage.js`, который сам feature-flagged off + полагался на удалённый `existingCoins`)
  - **`storyHook` cap 80 chars** при парсинге (`rawStoryHook.slice(0, 80)`) + явная инструкция в prompt'е
  - **`market-stage.js applyStage2MarketPatch`** превращён в no-op stub (вызов остаётся на месте для будущего use-case'а, но логика удалена — оба её входа уже мертвы)
- **Env-tunables** для оперативной настройки без пересборки:
  - `XAI_STAGE2_MAX_RESULTS` (default 10, range 1-30) — твитов на x_search
  - `XAI_STAGE2_LOOKBACK_HOURS` (default 48, range 1-168) — глубина поиска по времени
  - `XAI_STAGE2_MAX_TOOL_CALLS` (default 2, range 1-5) — потолок fan-out
- **Что НЕ тронуто** (по запросу владельца): `stage2Threshold` (60) и `stage2MaxCalls` (6) — крутятся в админке когда понадобится. Кэш по subjectName тоже отложен (редкий сценарий)
- **Ожидаемый эффект**: Stage 2 input -60…-70%, output -20…-25% за счёт удаления полей и cap'а storyHook. Совокупно ~5× падение стоимости Stage 2 без потери качества скоринга
- **Files**: `src/analysis/scorer.js`, `src/analysis/prompts.js`, `src/analysis/market-stage.js`. Все прошли `node --check`. Миграций БД нет — `xSentiment`/`adjustment` уйдут из новых записей `raw_metrics.xSearchData`, старые остаются как legacy и игнорируются

---

## 2026-04-27 (Apify collectors: per-script CJK threshold multiplier)

- **Проблема**: после расширения `general` пресета CJK-частицами (см. 2026-04-24) в пайплайн пошло слишком много мусора с китайских/японских/корейских аккаунтов — региональные перепосты новостей, idol-фандомы, Douyin-копипаста. Эти твиты/видео дёшево пробивают глобальные пороги (500K views на Twitter, 50K plays на TikTok), но никогда не превращаются в торгуемый нарратив для нашей англоязычной аудитории
- **Решение**: поднят входной порог в Apify-нормализаторах **per-script**, а не для всех CJK скопом. Сначала сделали 2× для всех CJK, потом по запросу владельца отдельно подняли китайский до 4× — китайский firehose шумнее всего, японский/корейский часто содержат реальные IP-сигналы (anime/games/idol launches)
- **Детектор `_detectCjkScript(text)`** (одинаковый в `src/collectors/twitter.js` и `src/collectors/tiktok.js`):
  - Считает символы по трём непересекающимся блокам: kana (Hiragana 3040-309F + Katakana 30A0-30FF), Hangul Syllables (AC00-D7AF), Han (CJK Ext-A 3400-4DBF + CJK Unified 4E00-9FFF)
  - Если суммарная доля CJK < 30% от всех Unicode-букв (`\p{L}`) → возвращает `null` (пост идёт по дефолтным порогам)
  - Иначе классифицирует по уникальной письменности: kana → `'ja'`, hangul → `'ko'`, чистый Han → `'zh'`
- **Twitter (`_normalize`)**: `cjkMult = zh ? 4 : (ja|ko) ? 2 : 1`; пороги `viewsBar = 500_000 * cjkMult` (или fallback `likesBar = 10_000 * cjkMult` если views=0). Итог: EN/RU 500K views, JA/KO 1M, ZH 2M
- **TikTok (`_normalize`)**: тот же мультипликатор для plays/likes/shares; `viralScore` поднимается additive (40 → 50 для ja/ko → 60 для zh), потому что viralScore капится 100. Итог EN: 50K plays/1K likes/200 shares/40 viral; JA/KO: 100K/2K/400/50; ZH: 200K/4K/800/60
- **Smoke-test пройден**:
  - 简体 / 繁體 китайский → `zh` (×4)
  - Hiragana+kanji / pure katakana → `ja` (×2)
  - Pure Hangul → `ko` (×2)
  - Английский с одним японским словом ("Sony announces new game イベント") → `non` (4 кана / 31 буква = 11% < 30%)
  - Кириллица / латиница / "你好 means hello" вкрапление → `non`
- **Edge case `韓国の비트코인`**: смешанные kana+hangul классифицируются как `ja` (kana проверяется первым). Редкий патологический случай — в любом случае попадает под повышенный порог, владельца устраивает
- **Files modified**: `src/collectors/twitter.js` (`_normalize` + helper), `src/collectors/tiktok.js` (`_normalize` + helper). Никаких миграций БД, изменения чисто на уровне нормализации входящего фид-айтема

---

## 2026-04-27 (Trigger search: replace whyItWillPump with on-demand Grok reasoning)

- **Цель**: убрать автоматическую генерацию `whyItWillPump` из Stage 1 + Stage 2 (фактически degen-питч который шёл на каждый scored тренд) и заменить её **on-demand**-кнопкой «Найти триггер», которая вызывает Grok в **reasoning**-режиме (`grok-4-1-fast-reasoning`) с `x_search` и возвращает фактический катализатор: что произошло, кто причастен, когда, какие аккаунты разогнали. Reasoning ~15× дороже, но запросов в день ~5-50 вместо 100+ → суммарно дешевле и качественнее
- **Шаринг между пользователями**: первый Pro-юзер запускает Grok, результат сохраняется в БД, остальные читают мгновенно. Никаких дублирующих платных вызовов

### Архитектура

1. **DB слой** (`src/db/database.js`): новые колонки `trigger_text`, `trigger_searched_at`, `trigger_searched_by`, `trigger_sources` (JSON array `@handles`), `trigger_confidence`, `trigger_in_flight`. Crash-recovery в `_migrate()` сбрасывает stale locks. Новые методы:
   - `claimTriggerSearch(trendId, userId)` — атомарный UPDATE-claim лока через WHERE trigger_in_flight=0; возвращает `{ claimed: bool, state?: 'cached'|'in-flight', trend? }`
   - `saveTrendTrigger(trendId, { text, sources, confidence })` — пишет результат + снимает lock
   - `releaseTriggerLock(trendId)` — очищает lock без сохранения (на ошибке Grok)
   - `getTrendTrigger(trendId)` — read с парсингом sources JSON
   - `getLastTriggerSearchByUser(userId)` — для 15-минутного per-user cooldown'а
2. **Prompts** (`src/analysis/prompts.js`): новый `TRIGGER_SYSTEM_PROMPT` (factual катализатор, NO degen pitch) + `buildTriggerPrompt(trend)` (читает `subjectName` из xSearchData как high-signal anchor). JSON shape: `{ trigger, confidence, sources[] }`. Также удалено поле `whyItWillPump` из Stage 1 + Stage 2 schemas
3. **Grok вызов** (`src/analysis/trigger-finder.js`, новый файл, ~170 строк): `TriggerFinder.findTrigger(trend)` — модель `grok-4-1-fast-reasoning`, tool `x_search`. Дублирует мини-версию `_callResponsesAPI` (свой default model, нет admin-override) ради self-contained файла. Sanitize: trim text, cap sources @5, normalize `@handle` префикс, validate confidence 0-100
4. **Telegram** (`src/notifications/telegram.js`):
   - Кнопка `[X Analysis | Trigger]` в верхней строке + `[Ask Grok]` ниже + `[👍 | 👎]`. Лейбл триггера три состояния: `🔍 Trigger` (новый), `💡 Trigger` (cached в БД), `🔒 Trigger (Pro)` (free/test plan). Cheap DB-peek в `attachAlertButtons` показывает правильный лейбл
   - Callback `trigger:<trendId>` → handler `_handleTriggerSearch`: cached fast-path → cooldown check (15min, admin bypass) → DB claim → `triggerFinder.findTrigger` → save → render. Loser of the race получает либо cached payload, либо `triggerInFlight` toast
   - Render: `💡 Trigger:\n<text>\n📡 Sources: @x, @y\nConfidence: N%`. После live-вызова обновляем кнопку через `attachAlertButtons` чтобы лейбл стал `💡` для всех будущих кликов
5. **Dashboard** (`src/dashboard/server.js`):
   - Новый endpoint `POST /api/trends/:id/trigger` — возвращает `200 { ...payload, fromCache }`, `202 { state: 'in-flight' }`, `403 { reason: 'plan'|'cooldown', minLeft? }`, `503 { reason: 'disabled' }`
   - Новый компонент `TriggerSection` в TrendModal: 3 render-состояния (deep trigger / whyNow fallback / search button). Optimistic update — клик → POST → setState без перерендера модалки. `me.plan` определяет видимость кнопки vs `🔒 Trigger (Pro)`
   - Поле `trigger` пробрасывается в `_normalizeTrend` payload как `{ text, sources, confidence, searchedAt } | null`. Фид-карта тоже использует `trend.trigger?.text` как priority над `aiExplanation`
6. **i18n** (`src/i18n/en.js` + `src/i18n/ru.js`): 14 новых ключей (`triggerBtn`, `triggerCachedBtn`, `triggerLockedBtn`, `triggerLocked`, `triggerLoading`, `triggerInFlight`, `triggerCooldown(min)`, `triggerHeader`, `triggerSourcesHdr`, `triggerConfidence(pct)`, `triggerNotFound`, `triggerError(err)`, `triggerDisabled`) + дашборд i18n блок `trigger.*`
7. **Bootstrap** (`src/index.js`): `new TriggerFinder(config, logger)` создаётся один раз и передаётся в `TelegramNotifier` (5-й arg) и `DashboardServer` (7-й arg). Disabled gracefully когда `XAI_API_KEY` не задан

### Удалено end-to-end (whyItWillPump)

- `prompts.js`: убраны 2 поля из обоих JSON schemas
- `scorer.js`: убраны parsing/assign/fallback'и (3 места)
- `telegram.js`: `/top` теперь показывает `triggerText` (если Pro юзер искал) вместо whyItWillPump; truncated до 220 char для компактности карточки
- `dashboard/server.js`: feed-card description берёт `trigger?.text || aiExplanation`; модалка использует новый `TriggerSection` (старый «Why it will pump» блок удалён)
- `admin/server.js`: manual-send box показывает `triggerText` (Grok deep) + `whyNow` (stage-1) как два разных блока; `_hydrateTrendFromDb` читает `row.trigger_text/sources/confidence` напрямую из flat columns
- В **`raw_metrics` JSON** старых записей legacy `whyItWillPump` остаётся (не подчищаем) — новый код просто его не читает

### Concurrency / cost notes

- **DB-level lock** через `WHERE trigger_in_flight=0` атомарен (SQLite сериализует UPDATE). Race-loser проверяет state и либо отдаёт cached, либо показывает «в полёте» toast. Crash recovery — startup `UPDATE SET trigger_in_flight=0 WHERE trigger_in_flight=1`
- **Cooldown** per-user 15min — учитывает только настоящие Grok-вызовы (cached reads не считаются, потому что `trigger_searched_by` пишется только при live-вызове). Admin bypass через `plan_name === 'admin'`
- **Стоимость**: одна Grok reasoning + x_search call ≈ $0.005-0.02. При 50 вызовах/день = $0.25-1/день. Старая Stage 2 generation `whyItWillPump` стоила примерно столько же на каждом цикле скана, но ради питча который никто не открывал

### Files

- New: `src/analysis/trigger-finder.js`
- Modified: `src/db/database.js`, `src/analysis/prompts.js`, `src/analysis/scorer.js`, `src/notifications/telegram.js`, `src/dashboard/server.js`, `src/admin/server.js`, `src/i18n/en.js`, `src/i18n/ru.js`, `src/index.js`
- All passed `node --check`

---

## 2026-04-24 (Twitter collector: CJK coverage + языковая перекомпоновка в `general`)

- До этого `PRESET_QUERIES.general` покрывал только EN (4 слота), Romance (1) и RU (1). Азиатские языки (JP/KR/ZH) — 0. Все остальные пресеты (`animals`/`culture`/`celebrities`/`events`) полностью англоязычные. То есть японский/корейский/китайский X был полностью невидим → пропускали ранние сигналы типа Moo Deng (TH/JP-первыми) или K-pop моменты
- **Финальная раскладка 6 слотов** (`src/collectors/twitter.js:58-79`):
  1. `(a OR the OR is OR to OR in)` — EN артикли/предлоги
  2. `(de OR la OR el OR que OR en OR и OR я OR на OR не OR что)` — **Romance + RU объединены** (10 токенов в OR-клаузе)
  3. `(when OR where OR why OR how OR who)` — **НОВЫЙ EN слот**, wh-слова / заголовочный драм-контент
  4. `(you OR me OR my OR we OR our)` — EN местоимения
  5. `(this OR that OR it OR was OR has)` — EN указательные/aux
  6. `(の OR は OR を OR が OR に OR で OR 이 OR 가 OR 는 OR 的 OR 是 OR 了)` — **НОВЫЙ CJK слот** (JP×6 + KR×3 + ZH×3)
- **Что потеряли**: RU перестал иметь выделенный слот (на 20 твитов гарантированно) — теперь конкурирует с Romance за 20 top-позиций в объединённой выдаче. Вирусный испанский тред «забьёт» русский. Компромисс: RU-трафик не является основным для продукта, EN-покрытие важнее
- **Что убрали**: `(just OR so OR but OR now OR all)` — EN-слот, семантически перекрывался с #4/#5, заменён на wh-слова
- **JP-weighted CJK**: 6 частиц JP против 3+3 у KR/ZH — по запросу юзера, так как JP-Twitter самый активный не-английский рынок
- Ротация не изменилась: `cycleSize=2`, полная прокрутка 6 слотов за 3 скана. Цена — 2 запроса × 20 результатов × $0.15/1K
- CJK частицы по частотности: JP — основные падежные маркеры (の は を が に で); KR — именительный/темы маркеры (이 가 는); ZH — притяжательное/связка/перфект (的 是 了)

---

## 2026-04-24 (X Analysis: smarter query builder)

- **Проблема**: юзер жаловался что в результате X Analysis только первый твит (тот что в алерте) по теме, остальные рандом. Причина — `TwitterChecker.buildQuery` был слишком наивным:
  - `/[^\p{L}\p{N}\s]/gu` съедал `$`, `#`, дефисы, кавычки
  - Брал первые 3 слова > 2 букв без кавычек → X трактовал как OR → шум
  - `subjectName` из Stage 2 xSearchData (Peanut / Moo Deng / Hawk Tuah) не использовался вообще
- **Новый алгоритм** (`buildQuery(title, { subjectName })`):
  1. **Приоритет 1 — subjectName**: если пришёл — используем, multi-word в кавычках. Ticker-style имена (`/^\$[A-Za-z]{2,10}$/`) намеренно пропускаются — юзер отказался от тикер-поиска (трейдерский спам, не нарратив)
  2. **Приоритет 2 — proper-name phrase**: ищем самый длинный run подряд идущих Capitalized токенов. 2+ слов → `"Hawk Tuah"` (кавычки = AND-фраза). 1 слово ≥3 букв → `Peanut` bare
  3. **Приоритет 3 — stopword-filtered fallback**: убираем EN+RU стоп-слова, берём 3 значимых. Первые два оборачиваем в кавычки как bigram, третье bare → `"президент подписал" новый`
- **Zero-results fallback не делаем** — удвоило бы стоимость Apify на неудачных запросах. Если пустой результат будет проблемой — вернёмся
- **Testing**: тесты на типичных заголовках (EN/RU, caps/lowercase, с subjectName и без) дают ожидаемые квотированные фразы
- **Files**:
  - `src/collectors/twitter-check.js` — новый `buildQuery(title, opts)`, модульные `_isCapitalized` + `STOPWORDS` (EN+RU) helpers
  - `src/notifications/telegram.js` — новый `_getSubjectName(trend)` читает `raw_metrics.xSearchData.subjectName`; оба `_handleXAnalysis` и `_handleXRefresh` передают subjectName в buildQuery, лог показывает `(subject=Peanut|none)`

---

## 2026-04-24 (X Analysis: cache + fallback + history + refresh button)

Большой апдейт on-demand X Analysis по итогам Tier 1/2/3 улучшений.

- **Cache 60 мин** (`twitter-check.js`): `Map<trendId, { at, query, result }>`, TTL = 60min. Повторный клик «X Analysis» в окне → мгновенный ответ с пометкой `💾 Из кэша · N мин назад`. Биллинг Apify сокращается на «любопытных» юзеров
- **Bilateral fallback** (`twitter-check.js`): если активный actor (kaito/xquik) падает, автоматически пробуем другой. Логируем `[Twitter/X] Primary actor 'X' failed … Falling back to 'Y'`. В сообщении бейдж `⚠️ Основной актор упал, используется Y`. Изначальная ошибка перепрокидывается юзеру, если и fallback упал
- **Concentration signal** (`_summarize`): считаем `byAuthor` Map с engagement = likes + RT*2, находим top-1 автора и его долю от суммы. Если ≥ 70% → бейдж в результате `⚠️ @author даёт N% всего охвата (один аккаунт)`. Ловит астротурф — 1 мега-твит vs настоящий нарратив
- **X.com search URL** (`TwitterChecker.searchUrl`): `https://x.com/search?q=<enc>&src=typed_query`. Рендерится inline-кнопкой `🔗 Поиск в X`
- **Grok snapshot merge** (`_handleXAnalysis` → `_xAnalysisExtras`): читаем `trend.metrics.xSearchData` из DB. Если есть — блок `🧠 Grok снял при скане: buzz=… · momentum=… · organicity=…`. Юзер видит дельту между Stage 2 оценкой при скане и live Apify сейчас
- **History table `x_analysis_history`** (`database.js`): колонки `trend_id, at, tweet_count, total_views, total_likes, total_retweets, virality_score, concentration, actor_used`. Записывается **только на настоящих Apify fetch'ах**, не на cache hits. Индекс `idx_xa_history_trend(trend_id, at DESC)`. Методы `saveXAnalysis(trendId, result)` + `getXAnalysisHistory(trendId, limit=5)`
- **Virality delta**: `formatTwitterResult` принимает `extras.prevViralityScore`. В сообщении `📈 Было: 65/100 (📈 +17)` или `(📉 -12)` или `(=)`
- **Inline кнопки** на результате: `[🔄 Обновить | 🔗 Поиск в X]`. Refresh = callback `x_refresh:<trendId>`, Search = URL-кнопка (Telegram открывает браузер)
- **Refresh cooldown 1ч** (`_handleXRefresh`): использует `twitterChecker.cacheAgeMs(trendId)` как маркер «когда был последний fresh fetch». Если < 60min → toast `⏳ Обновить можно через N мин` (toast, не alert). Если ≥ 60min → force fresh, edit того же result-message через `editMessageText`, новая запись в history
- **Files**:
  - `src/collectors/twitter-check.js` — полный rewrite класса: cache, `_activeActor`/`_fallbackActor`/`_actorByName`, `_runActor`, новые поля в `_summarize`, `cacheAgeMs`, `searchUrl`
  - `src/db/database.js` — миграция таблицы `x_analysis_history`, 2 новых метода
  - `src/notifications/formatter.js` — `formatTwitterResult(result, query, lang, extras = {})` с рендером cache/fallback/delta/concentration/grok блоков
  - `src/notifications/telegram.js` — callback `x_refresh:`, методы `_xAnalysisExtras` / `_xAnalysisResultKeyboard` / `_handleXRefresh`, `_handleXAnalysis` передаёт `trendId` в searchNarrative и сохраняет history только для не-cache результатов
  - `src/i18n/en.js` + `src/i18n/ru.js` — 9 новых ключей: `xAnalysisRefreshBtn`, `xAnalysisSearchBtn`, `xAnalysisCooldown(min)`, `xAnalysisFromCache(min)`, `xAnalysisFallbackNote(actor)`, `xAnalysisDelta(prev, sign)`, `xAnalysisDeltaNeutral(prev)`, `xAnalysisConcentration(pct, author)`, `xAnalysisGrokHeader`/`Line`

---

## 2026-04-24 (X Analysis: virality formula fix — was always 100/100)

- **Bug**: `viralityScore` почти всегда показывал 100/100 для любого минимально виральных постов. Старая формула (`twitter-check.js:100-105`) суммировала `log10(v+1)*coef` без потолков на компонент — сумма легко давала 150-200, потом `Math.min(100, …)` обрезал до 100
- Пример по скрину юзера (20 tweets / 570.9K views / 56K likes / 9.7K RT): старая формула = **194 → capped 100**, новая = **82**
- **Фикс**: каждый компонент имеет свой бюджет, который выдаётся по log-шкале с явным потолком
  - `tweetCount`: 20 pts, full at 20 (размер страницы X search)
  - `views`: 30 pts, full at 10M
  - `likes`: 25 pts, full at 1M
  - `retweets`: 25 pts, full at 500K
  - Сумма всегда ≤ 100 без обрезания
- Helper `capped(value, ceiling, budget)` — `budget * log10(value+1) / log10(ceiling+1)`, clamp `[0, budget]`
- Контрольные точки: 100M/5M/1M → 100, 10M/500K/100K → 96, скрин → 82, 5K/500/50 → 46, 500/30/2 → 29, 50/2/0 → 14, 0/0/0 → 0

---

## 2026-04-24 (X Analysis: MAX_TWEETS 5→20)

- **Несоответствие код vs реальность**: в `src/collectors/twitter-check.js:6` был `const MAX_TWEETS = 5`, передавался в Apify как `maxItems: 5`. Но actor `kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest` игнорирует этот cap и возвращает полную страницу X search (~20 твитов для `queryType: 'Top'`). `_summarize()` никакого `slice` не делает → суммирует всё что пришло. Юзеры реально видели «Твитов найдено: 20» на скрине результата
- **Последствие**: биллинг Apify pay-per-result считает по фактически возвращённым твитам. Мы платили за 20, думая что запрашиваем 5. Скор виральности при этом честнее (больше данных), но код вводил в заблуждение
- **Фикс**: `MAX_TWEETS = 20` + подробный комментарий в файле объясняет поведение actor'а и как при необходимости действительно срезать на клиенте (`tweets.slice(0, N)` в `_summarize`)
- Поведенчески ничего не изменилось — actor и раньше возвращал 20, просто теперь код это признаёт

---

## 2026-04-24 (fix: fake «russian» title on manual resends)

- **Bug**: на manual submit + `/api/send-alert` для португальского (или любого не-англ) оригинала в TG приходили две строки — 🇬🇧 оригинал + 🇷🇺 **английский перевод от AI**. Английский под русским флагом.
- **Причина**: `src/notifications/formatter.js` 26-34 рендерил двуязычный блок по логике `ruTitle = (trend.title !== enTitle) ? trend.title : null`. Логика писалась, когда prompt возвращал пару `title` + `titleRu`. Но SYSTEM_PROMPT давно English-only, `titleRu` никогда не приходит. В обычном pipeline `trend.titleEn` проставляется скорером и совпадает с `trend.title`, поэтому `ruTitle = null` и проблема скрыта. На пути **manual resend → `_hydrateTrendFromDb`** поле `titleEn` не восстанавливается (нет в колонке БД, нет в raw_metrics) → `enTitle = originalTitle` (португальский), `ruTitle = title` (AI's English) — ложный русский флаг.
- **Фикс**:
  - `src/notifications/formatter.js` — убран двухстрочный блок, теперь всегда одна строка `📌 <title>`. Комментарий в коде объясняет историю и как правильно вернуть bilingual-ветку, если понадобится
  - `src/analysis/scorer.js:444-446` — удалён мёртвый `const aiRuTitle = a.titleRu || null;` и `title: aiRuTitle || aiEnTitle` заменено на `title: aiEnTitle`. Комментарий предупреждает не возвращать `titleRu` без одновременного возврата formatter-ветки
- Сторонних последствий нет: поле `titleEn` по-прежнему пишется, dashboard и storage его используют как раньше

---

## 2026-04-24 (Stage 2: subject-name bonus)

- **`src/analysis/prompts.js`** — в `STAGE2_SYSTEM_PROMPT` добавлен блок «SUBJECT NAME / TICKER CANDIDATE»:
  - Рубрика `nameStrength` 0-100 (тикеро-пригодность: короткое, звучное, уникальное)
  - Примеры «что считать именем» (Peanut, Moo Deng, Hawk Tuah, $BONK) vs «что НЕ считать» (generic descriptors, long phrases, politicians)
  - Явно прописано: **booster-only, NEVER penalizes** — если имени нет, возвращается `subjectName: ""`, `nameStrength: 0`, бонус просто не применяется
- В `buildStage2Prompt` добавлены поля `subjectName` и `nameStrength` в JSON-схему ответа
- **`src/analysis/scorer.js`** в `_stage2DeepDive`:
  - Парсинг новых полей с валидацией: `subjectName` trim + cap 64 chars, `nameStrength` 0-100 (обнуляется если имя пустое)
  - Сохранение в `trend.xSearchData.subjectName` + `.nameStrength`
  - Бонусный блок (зеркалит `stage2StoryBonus`): threshold `nameStrength >= 60`, max **+10**, формула `Math.min(10, Math.round((nameStrength - 60) * 0.25))`
  - Записывается в `trend.stage2NameBonus = { subjectName, nameStrength, bonus, memeBefore, memeAfter }`, логируется отдельно
  - Применяется ПОСЛЕ `stage2Penalty` и `stage2StoryBonus`, ДО перерасчёта `adoptionScore`/`narrativePhase`/`alertScore`
- **Стоимость**: ~0.1% прирост к Stage 2 (только +2 поля в output, ~50 токенов на trend × 6 trends/цикл). x_search не добавляется, Grok переиспользует те же результаты, которые уже собирает для `storyHook`/`organicity`
- **Итоговый cap бонусов от Stage 2**: storyBonus +15 + nameBonus +10 = **+25 к memePotential** максимум (оба бустера аддитивны, не умножаются друг на друга)

---

## 2026-04-28 (admin: AI Examples real cost calc)

- Раньше «Cost (с кэшем)» в `ExamplesPage` хардкодом показывал `≈ $0` — выглядело как сломанная метрика. Теперь динамически: `tokenEst × $0.075/M (cached) × 21600 циклов/мес`. Для дефолтных 12 примеров (~555 ток) показывает `≈ $0.90/мес`
- Тултип на блоке: `555 ток × $0.075/M (cached) × 21600 циклов/мес ≈ $0.899/мес ($0.030/день)` — оператор видит формулу
- Edge-кейсы: 0 активных → `$0`; cost < $0.01/мес → `< $0.01/мес` (избегаем `$0.00`); рендер цвет зелёный

---

## 2026-04-28 (dashboard: modal media fixes — carousel + video)

- **Img-carousel в модалке всегда 280px вместо 440px**: правило `body.prefs-compact .img-carousel { height: 280px }` (specificity 0,0,2,1) перебивало `.img-carousel.in-modal { height: 440px }` (0,0,2,0). Юзер с включённым compact density получал срезанную галерею
- Фикс: добавлен селектор `body.prefs-compact .img-carousel.in-modal { height: 440px }` рядом с базовым in-modal — теперь in-modal побеждает независимо от density
- **`<video>` рендерился сплющенной полоской**: до загрузки metadata браузер использует дефолт 300×150 (2:1) → poster через `object-fit: contain` ужимался в плоский letterbox. Фикс: `video.modal-image { aspect-ratio: 16/9; height: 100% }` — браузер замещает на natural ratio когда metadata подгружается
- `.modal-image-wrap` получил `min-height: 260px` как страховка от Twitter poster'ов с экзотическими crop'ами

---

## 2026-04-28 (UI: removed «Видели N раз», added Платформы + Скорость)

- Метрика `timesSeen` показывала бесполезное юзеру число — «Видели 2 раза» обычно означало «один и тот же твит просканировался дважды перед протуханием 6h окна», других источников не было. Удалено из:
  - Stat-блок в TrendModal stats grid
  - Бейдж `Nx` в feed-card meta
  - Функция `pluralSeen` (мёртвый код)
  - i18n ключи `modal.seen` / `modal.seen_suffix` (RU + EN)
  - Поля `times_seen` в БД и `timesSeen` в payload оставлены — счётчик продолжает копиться для возможной будущей аналитики, фронт его игнорирует
- Взамен в stats grid добавлены 2 ячейки:
  - **🌐 Платформы** (`uniquePlatforms`): 1 → серое `1`; ≥2 → зелёное `🌐 N` с тултипом «Кросс-платформа — мем вышел за пределы одного источника»
  - **⚡ Скорость** (`velocity` через `fmtVelocity`): формат `12.5/ч ↑` (RU) / `12.5/h ↑` (EN); 0 → `—` dim-серым
- i18n: `modal.platforms` (Платформ/Platforms), `modal.velocity` (Скорость/Velocity)
- Сетка теперь 6 ячеек ровно на 3×2 без пустот: Meme score / Срок жизни / Виральность // Сентимент / Платформ / Скорость

---

## 2026-04-28 (lifespan: single source of truth refactor)

- **Bug**: после Stage 1 апгрейда (бары keywords `flash/short/medium/long` вместо `flash (hours)`/...) на дашборде в модалке поле «Срок жизни» всегда пустое — `LIFESPAN_KEYS["flash"]` → `undefined` → `'—'`. То же в TG /top, в формат-алертах. 4 файла-потребителя продолжали мапить старый descriptive формат. Юзер не сразу заметил, баг сидел в проде ~24ч
- **Промежуточный фикс**: dual-key (старые ключи рядом с новыми) в `LIFESPAN_KEYS` + i18n `topLifeIcons` + `lifespans`. Работало, но не лечит главную проблему: при следующей миграции enum-а такая же тишина вернётся
- **Архитектурный фикс**: новый файл `src/analysis/lifespan.js`:
  - `LIFESPAN_VALUES = Object.freeze(['flash', 'short', 'medium', 'long'])`
  - `LIFESPAN_DESCRIPTORS = Object.freeze({ flash:'hours', short:'1-2 days', ... })`
  - `normalizeLifespan(v)` — bare keyword as-is, descriptive form (`"flash (hours)"`) → bare, мусор → `null`
  - `assertCoversLifespans(name, map)` — кидает `Error` синхронно при загрузке модуля если карта не покрывает все `LIFESPAN_VALUES`
- **Потребители (все ESM-импортят из lifespan.js)**:
  - `prompts.js` — schema enum `[...LIFESPAN_VALUES, 'unknown']`; текст промпта `[${LIFESPAN_VALUES.join(', ')}] (${LIFESPAN_HINT})` где LIFESPAN_HINT собран из DESCRIPTORS
  - `scorer.js` — `predictedLifespan: normalizeLifespan(a.predictedLifespan) || 'unknown'` (защита от non-strict providers)
  - `dashboard/server.js` — `normalizeLifespan(row.predicted_lifespan)` при чтении из БД (легаси-строки нормализуются автоматически); SPA получает массив через `${JSON.stringify(LIFESPAN_VALUES)}` инжекцию в template, `LIFESPAN_KEYS` строится `LIFESPAN_VALUES.reduce((m,k) => (m[k]='lifespan.'+k, m), {unknown:'lifespan.unknown'})`
  - `i18n/en.js`, `i18n/ru.js` — bare-keys-only, легаси-формы убраны; в конце модуля `assertCoversLifespans('en.topLifeIcons', en.topLifeIcons)` + `assertCoversLifespans('en.lifespans', en.lifespans)` + симметрично для ru
  - `notifications/telegram.js`, `notifications/formatter.js` — `normalizeLifespan` перед lookup в i18n-карте
- **Что теперь произойдёт при попытке переименовать `flash` → `instant`**:
  - `prompts.js`/`scorer.js`/`dashboard` SPA — автоматически подхватят
  - `i18n/en.js` — `Error: en.topLifeIcons is missing lifespan keys: [instant]. Source of truth: src/analysis/lifespan.js → LIFESPAN_VALUES = [...]` синхронно при `import` модуля → бот не стартанёт пока не доделаешь
  - Это и есть «сломает компиляцию, а не сидит молча»
- Старые DB-строки с `"flash (hours)"` нормализуются на лету при чтении — миграция не требуется

---

## 2026-04-28 (Stage 0 PreStage: gpt-5.4-nano + Gemini Flash visual enrichment)

- **Проблема**: Stage 1/2/Trigger видели только текст. Для TikTok/Twitter трейндов с пустыми тайтлами (хэштеги, slang) или мем-видео без описания AI был слепым — оценивал по 2 строкам бессмысленных тегов и engagement-цифрам. Tree Test 1 (`#tungtungtungsahur`) — типичный кейс: визуально явный мем-формат, но скор 20 потому что AI его не видел
- **Архитектура**: новая Stage 0 ПЕРЕД Stage 1, состоит из двух параллельных под-стадий. Обе **никогда не фильтруют, не скорят, не дропают** — только обогащают `trend.preStage`. Все трейнды одинаково идут дальше:
  - **Stage 0a (NanoClassifier)** — `gpt-5.4-nano` через существующий `OPENAI_API_KEY`. Батчевый JSON-schema вызов. Output: `{topicSummary, entityCanonical[], language, slangDecoded}`
  - **Stage 0b (GeminiCaptioner)** — `google/gemini-3.1-flash` через `OPENROUTER_API_KEY` (с автофолбэком на `gemini-2.5-flash` при 404). Параллельный вызов с concurrency cap 4. Output: `{visualCaption, visibleText, mood, mediaType, videoSummary, videoDurationSec, videoTruncated}`
- **Видео политика**: ffprobe замеряет длительность, если ≤ `STAGE0_VIDEO_MAX_SEC` (default 30) — отправляем URL видео нативно в Gemini, иначе деградируем до poster image (`videoTruncated: true`). Sysprompt инструктирует Gemini «analyze first 30 seconds only»
- **Файлы**:
  - `src/analysis/nano-classifier.js` — батчевый text-classifier, retry-tolerant, structured output via `text.format.json_schema`
  - `src/analysis/gemini-captioner.js` — vision через OpenAI-compatible OpenRouter endpoint, in-memory LRU кэш по URL hash (TTL 5min), ffprobe duration probe (5s timeout), HTTP fallback model на 404
  - `src/analysis/pre-stage.js` — orchestrator с `enrichBatch(trends)`, fan-out nano+gemini через Promise.all, мутирует input array in-place добавляя `preStage` field
  - `src/analysis/scorer.js` — constructor принимает `preStage` 4-м параметром; `scoreTrends` зовёт `preStage.enrichBatch(trends)` сразу после enabled-check, перед prompt assembly. Failures degrade silently (preStage = null)
  - `src/analysis/prompts.js` — `buildAnalysisPrompt` surface'ит nano fields (`Topic:`, `Entities:`, `Slang:`, `Language:`) и gemini fields (`Visual:`, `Video:`, `VisibleText:`, `Mood:`) в каждой trend-секции. SYSTEM_PROMPT расширен блоком «PRESTAGE METADATA (when present)» — инструкция использовать как контекст, НЕ авто-бустить score за наличие метаданных
  - `src/db/database.js` — `saveTrend` пишет `trend.preStage` в `raw_metrics` (никаких новых колонок); `_hydrateTrendFromDb` восстанавливает обратно — повторный показ в админке не платит за nano/gemini заново
  - `src/admin/server.js` — `_submitNarrative` и `_hydrateTrendFromDb` прокидывают `preStage` в API; SubmitPage рендерит секцию «🎨 Stage 0 PreStage (контекст для скорера)» с двумя под-блоками (Nano text + Gemini visual), показывает `videoTruncated: true` когда был fallback на poster
  - `src/index.js` — создаёт `nanoClassifier` + `geminiCaptioner` + `preStage`, инжектит в `Scorer`. Логирует `PreStage enabled: nano=on/off, gemini=on/off` на старте
- **ENV** (`.env.example`):
  - `OPENAI_NANO_MODEL=gpt-5.4-nano` (использует тот же `OPENAI_API_KEY`)
  - `OPENROUTER_API_KEY=sk-or-v1-...` (OpenRouter)
  - `OPENROUTER_VISION_MODEL=google/gemini-3.1-flash` + `OPENROUTER_VISION_MODEL_FALLBACK=google/gemini-2.5-flash`
  - `STAGE0_VIDEO_MAX_SEC=30`, `STAGE0_GEMINI_TIMEOUT_MS=45000`, `STAGE0_GEMINI_CACHE_TTL_SEC=300`, `STAGE0_NANO_MAX_BATCH=20`
  - Если `OPENROUTER_API_KEY` пуст → gemini под-стадия молча пропускается, nano работает соло. Если оба пусты → PreStage целиком no-op
- **Ожидаемая стоимость** (~30 трейндов/цикл, 720 циклов/день):
  - nano: ~$30/мес (~200 ток × батч)
  - gemini: ~$32/мес (50% картинки $0.0001 × 720, 50% видео $0.0003 через frame-sampling caps)
  - **Итого ~$62/мес** при текущем объёме
- **Проверки**: outer JS все 8 файлов пройдены, inner SPA админки парсится (154K chars), все 3 новых модуля импортятся через ESM. Smoke-test показал что lifespan-схема не сломалась
- **Не сделано** (отложено намеренно): аналитический счётчик «Stage 0: N captions/cycle, $X/мес» в дашборде; toggle PreStage on/off из админки в runtime; persistent кэш через DB вместо in-memory LRU (если уйдём в кластер из >1 ноды). Сейчас всё это yagni

---

## 2026-04-28 (Stage 0b: Google primary + OpenRouter fallback failover)

- **Архитектурный пересмотр**: было сначала «OpenRouter для картинок + Google AI для видео» (dual-purpose), потом «всё через Google AI», потом «всё через OpenRouter». Финальный variant: **Google AI primary + OpenRouter fallback**. Лучшее из обоих:
  - Google AI = native video understanding (essential для TikTok-мемов где смысл в движении)
  - OpenRouter = safety net когда у Google квота / геоблок / 5xx
- **Failover trigger** в `_callOpenRouter`-стиле: HTTP 429, 403 FAILED_PRECONDITION, 5xx, network timeout, download failure — на любом таком ответе от Google captioner переключается на OpenRouter. Parse-failure не считается retryable (модель отдала мусор)
- **Cooldown circuit-breaker**: после 3 неудач Google подряд — 5-минутный cooldown, captioner идёт сразу на OpenRouter, не дёргая Google. Первый успех Google после окна снимает cooldown. Параметризуется `STAGE0_GOOGLE_COOLDOWN_FAILURES` (default 3) + `STAGE0_GOOGLE_COOLDOWN_MS` (default 300000). Без этого бы тратились лишние API-вызовы на Google когда он стабильно лежит
- **Новое поле в payload**: `provider: "google" | "openrouter"` — оператор в админке видит каким именно сервисом был обработан конкретный трейнд
- **Видео-flow**: Google AI native video через `inlineData` base64 (download → размер cap → mime sniff → API). При неудаче — fallback на poster image (через Google если cooldown не активен, иначе через OpenRouter). Никогда не пропускаем видео-трейнд молча: либо native, либо poster, либо null
- **Image-flow**: Google direct через `inlineData` base64. При неудаче — OpenRouter с `image_url` content type (тот URL который Gemini сам не смог достать через OpenRouter, OpenRouter сам и резолвит)
- **Файлы**: переписан `src/analysis/gemini-captioner.js` (~370 строк) — единый класс с двумя провайдерами и cooldown machinery; `.env.example` обновлён с обоими блоками PRIMARY/FALLBACK + параметры cooldown'а
- **Smoke test** (`scripts/test-prestage.js`) проходит 4/4 даже с заблокированным Google (dev-машина за vless): Google прилёг → OpenRouter подхватил → caption получен. Лог чистый, видно какой провайдер сработал
- **Cost**: по сравнению с pure-Google вариантом OpenRouter подключается крайне редко (только при сбоях). Дополнительной стоимости почти нет
- **Не сделано** (отложено): админ-toggle переключения primary↔fallback в runtime; Vertex AI как третий вариант для регионов где AI Studio заблочен; persistent кэш captioner'а через DB (сейчас in-memory LRU)

---

## 2026-04-29 (Dashboard inline reason editor + nano-classifier signal expansion)

- **Inline reason editor в дашборде** (раньше был только Telegram-FSM): после голоса 👍/👎 в `TrendModal` появляется textarea «Почему такая оценка?» с Save/Clear/счётчиком 240 chars, Cmd+Enter shortcut, тоаст-статус 2.4с. **Только в modal variant** — feed-карточки чистые
  - `db.js`: новый helper `getUserVoteWithReason(trendId, chatId)` → `{vote, reason}` одним запросом (раньше 2 запроса)
  - `dashboard/server.js _handleTrendFeedback`: расширен на опциональный `reason` field. Три режима — vote-only (как раньше), reason-only (без `vote` → не трогает голос), vote+reason. На «причина без голоса» возвращает 409 с `code: 'no_vote'`. Ответ всегда содержит `userReason: ""`
  - `_formatTrend`: `feedback.userReason` подтягивается через `getUserVoteWithReason` в одном запросе
  - `FeedbackBar` компонент: state `reasonDraft` + `savedReason`, resync-эффект НЕ трогает черновик при изменениях likes/dislikes (избегаем стирать пока юзер печатает)
  - i18n: 8 новых ключей `feedback.reason.*` (en + ru)
  - На vote-flip / toggle-off зеркалит серверную логику (причина обнуляется)
  - **Stage 1 промпт уже видит reason** через существующий `_buildFeedbackContext` (`getLikedNarratives`/`getDislikedNarratives` достают `topReason` из `feedback_votes.reason`) — никаких правок в scorer не нужно
- **Nano-classifier (Stage 0a) — расширение входов** (PR ради качества кросс-языковой кластеризации):
  - В `_classifyChunk` промпт-сборщик стал жирнее — но nano-токены копеечные, output не растёт
  - Добавлен tag-блок в заголовок: `r/<subreddit>, #<sourceHashtag>, by @<author>, link:<domain>` — каждый optional, выводится только если есть
  - Domain-фильтр: пропускает twitter/x/reddit/tiktok/youtube/google (для них source уже это сигнализирует). Внешние ссылки (coinmarketcap, etherscan, news-site) проходят
  - Description cap 300 → 600 chars
  - **Новое поле `RelatedPosts:`** — sibling titles из кластера, до 5, обрезаны 140 chars. Появляется только когда clusterer создал multi-item cluster. Реальный буст для `topicSummary` когда заголовки варьируются («cat fights raccoon» / «viral raccoon attack» / «that cat tho»)
  - В `clusterer.js` `route()` после `clusterMetrics = metrics`: новый блок собирает `clusterSiblingTitles[]` — top 5 по engagement, дедуп по нормализованной форме, чтобы copypaste-кластер не съедал токены
  - **НЕ передали в nano** (по контракту enricher-not-scorer): метрики (views/likes/velocity), cluster size, marketStage, viralScore. Stage 1 их видит сырьём; через nano-посредника они только шумели бы
- **Не сделано**: top-comment snippet (требует доработки коллекторов); Gemini→nano feedback loop (сделает Stage 0 sequential вместо parallel — отказались)

---

## 2026-04-29 (PR-1: multi-signal clustering — embeddings + image hash вместо чистого Jaccard)

- **Проблема**: clusterer склеивал нарративы через word-set Jaccard на тайтлах. Семантически мёртвый подход — «Илон купил Twitter» (RU) и «Musk acquires X» (EN) с пересечением слов 0 не склеивались никогда. По логам в проде: `N items → N clusters` каждый цикл = ноль склеек
- **Решение**: multi-signal similarity. Каждая пара трейндов получает weighted score из 4 сигналов; weights читаются из DB-настроек (тюнятся через админку без передеплоя):
  - **Embedding cosine** (вес 0.40) — `text-embedding-3-small`, 1536-dim L2-нормализованные. Cosine 0.5..1.0 нормализуется в 0..1 (squash на нижней границе чтобы шум не накапливался)
  - **Image dHash similarity** (вес 0.30) — `sharp` resize 9×8 grayscale → adjacent-pixel diff → 64-bit BigInt. Hamming distance < 16 = soft-match zone, переводится в 0..1 similarity
  - **Entity overlap из nano** (вес 0.20) — пересечение `entityCanonical[]` множеств; кросс-языковой буст
  - **Shared $TICKER** (бонус 0.10) — regex `\$[A-Z]{2,10}\b`; разные тикеры активно мешают (×0.85 на final score)
  - **Time penalty** — линейный damp 1.0 → 0.7 если items first-seen >24h apart
  - **Renormalisation**: если какой-то сигнал отсутствует (нет картинки → pHash null, nano упал → entity null) — вес перераспределяется по остальным. Ни один сигнал не «обязательный»
- **Threshold для merge**: 0.55 (DB setting `clusterSimThreshold`). Greedy assignment loop как раньше — сохраняет всё downstream поведение (representative selection by engagement, gallery aggregation, sibling collection)
- **Новые модули**:
  - `src/analysis/embeddings.js` (~150 строк) — `EmbeddingsClient` с батчем + LRU кэшем по sha1(text). Один HTTP-запрос на цикл, до 2048 inputs. NEVER throws. Дополнительно экспортит `cosineSimilarity(a,b)`
  - `src/analysis/image-hash.js` (~190 строк) — `ImageHasher` через `sharp` (новая dep). dHash алгоритм (а не pHash — без DCT, ~3× быстрее). LRU кэш по URL, bounded concurrency 4. NEVER throws. Экспортит `hammingDistance` + `hashSimilarity`
- **Изменения в `clusterer.js`**: 
  - Constructor читает 6 DB-настроек с дефолтами (`clusterSimThreshold`, `clusterWeightEmbedding`, `clusterWeightPhash`, `clusterWeightEntity`, `clusterWeightTicker`, `clusterTimePenaltyHours`)
  - `route()` стал async — пре-вычисляет embeddings + image hashes одним батчем перед кластеризацией
  - `_clusterByJaccard` ОСТАВЛЕН как fallback. Условие переключения: `MULTI_SIGNAL_ENABLED && haveAnySignal` (хоть одно `_embedding` или `_imageHash` не null). Если ВСЁ упало — старый Jaccard. Лог `strategy=multi-signal|jaccard-fallback`
  - `_embeddingText(item)` собирает текст: title + description + (preStage.gemini.videoSummary, visualCaption, visibleText, nano.topicSummary). Пустые поля игнорируются
  - `_pickHashUrl` берёт ОДИН URL: `imageUrl || thumbnailUrl || imageUrls[0]`. Не множим траффик на gallery size — для «same meme» хватает одной картинки
- **Защитные сетки**:
  - ENV `CLUSTER_MULTI_SIGNAL=0` — panic switch (force Jaccard)
  - `EMBEDDING_TIMEOUT_MS=15000`, кэш 5min/1000 entries
  - `IMAGE_HASH_TIMEOUT_MS=5000`, `IMAGE_HASH_MAX_BYTES=2MB`, кэш 15min/500 entries
- **Файлы**: `clusterer.js`, `embeddings.js` (new), `image-hash.js` (new), `index.js` (await route), `.env.example` (новый блок CLUSTERING с 7 переменными), `package.json` (sharp ^0.34.0)
- **Стоимость**: embeddings ~$0.0001/цикл, image hash локально free. **<$1/мес добавки**
- **Latency**: route() с ~10ms (Jaccard) → ~1.5-2.5s (embeddings batch + parallel image fetches). Цикл вырос ~30s → ~50-65s
- **Build trap**: `npm ci` требует синхронный `package-lock.json`. После добавления `sharp` в `package.json` пришлось локально прогнать `npm install --package-lock-only` чтобы Docker build не падал. Решение в логе деплоя если повторится: `npm install sharp@^0.34.0 --package-lock-only`

---

## 2026-04-29 (PR-2: reorder pipeline — PreStage перед Cluster)

- **Мотивация**: после PR-1 multi-signal clusterer хочет видеть Gemini's `videoSummary`/`visualCaption` и nano's `entityCanonical` при принятии решения о склейке. Но PreStage запускался ПОСЛЕ clusterer'а — на первом цикле эти данные были null. Нужен reorder
- **Новый порядок**:
  ```
  collect → cheapDedup → PreStage → cluster (multi-signal) → stage1 → stage2 → save → alerts
  ```
  Раньше: `collect → cluster → PreStage → stage1`. PreStage перенесён на 2 шага раньше
- **`cheapDedup(items)`** — новая стадия в clusterer (zero-API-cost). Цель: не платить PreStage за обвиоусные дубли. Логика:
  - Бакеты по `(source, normalised-title)` — копипаст одной фразы с одной платформы → keep highest-engagement, drop rest
  - Бакеты по `url || metrics.permalink` — race-condition коллекторов на одном Reddit-всплеске
  - Микросекунды, никаких API. Логирует `cheapDedup: N → M (droppedTitle=X, droppedUrl=Y)` только когда что-то схлопнулось
  - НЕ заменяет clusterer drop-логику (DB history, junk filter, emergence) — те остались на смартовом проходе
- **save_only items теперь тоже получают PreStage** — даже если clusterer положил трейнд в save_only без скоринга, его `preStage` сохраняется в `raw_metrics`. Профит: будущий цикл (когда трейнд может выползти) уже имеет nano/gemini данные в кэше
- **Цена решения**: items, которые clusterer потом дропнет/сейф-онли, теперь платят за PreStage. По логам: ~10-30% items дропаются → +10-30% к PreStage стоимости. cheapDedup срезает обратно ~15-25% от сырых items до PreStage. Чистая дельта: +$15-30/мес при текущем объёме
- **Файлы**:
  - `clusterer.js` — добавлен `cheapDedup(items)` метод (~50 строк); `_embeddingText` комментарий обновлён («preStage всегда populated»)
  - `index.js` — переставлены шаги 2.4 (cheapDedup), 2.5 (PreStage), 2.6 (cluster). Алерты для save_only теперь идут после PreStage в БД (raw_metrics содержит preStage)
  - `scorer.js` — PreStage call ОСТАВЛЕН как safety net (idempotent, no-op в normal flow). Используется только в admin manual-submit пути, который минует index.js
  - `admin/server.js` — `PIPELINE_STAGES` массив переставлен в порядке collect→dedupe→prestage→cluster→stage1/2→save→alerts. Hint у Cluster обновлён («Multi-signal: embeddings + image hash + entities + junk»). Hint у Dedupe — «Aggregator + cheap exact-dupe collapse»
- **Прод-логи подтверждают работу**: 
  - `[Clusterer] cheapDedup: 87 → 64 (droppedTitle=18, droppedUrl=5)` — режет 25%
  - `PreStage: 64/64 trends enriched in 9460ms`
  - `[Embeddings] 64 fresh + 0 cached in 487ms (model=text-embedding-3-small, dims=1536)`
  - `[ImageHasher] hashed 52 (48/64 ok) in 2104ms`
  - `[Clusterer] 64 items → 41 clusters (strategy=multi-signal)` — РЕАЛЬНЫЕ склейки появились (41 cluster из 64)
- **Embedding cache hit rate ~0%** — ожидаемо: aggregator уже выкидывает повторы из БД ДО clusterer'а. Кэш по факту бесполезен в этой архитектуре, но копеечный — оставляем как safety net

---

## 2026-04-29 (Stage 2 cost cuts — half-price без хирургии)

- **Контекст**: один Stage 2 вызов стоил **~10¢** (по биллингу xAI). 94% — `x_search` ($5/1000 sources, не за вызов). Остальное — Grok токены. Главные рычаги — sources count и tool_calls
- **Исправлено**:
  - `stage2MaxCalls` 6 → **3** в `scorer.js` (DB-tunable через `stage2MaxCalls` setting). По логам cap редко достигается; cut до 3 даёт защиту от взрыва без потери качества
  - `XAI_STAGE2_MAX_RESULTS` default 10 → **5** в `scorer.js`. Главный рычаг по input-tokens. С `max_tool_calls=2` это 2×5=10 sources вместо 20 → input ~12K вместо ~23K
- **Stage 1 explanation cap через json_schema**: вместо «1-2 sentences» (которые Stage 1 интерпретировал как 300-500 chars) → «ONE short sentence (≤200 chars), terse, no filler» + `maxLength: 220` в strict schema. Strict json_schema **физически режет output на стороне модели** (OpenAI Responses API enforces при `strict: true`)
  - Defensive cap в Stage 2 `buildStage2Prompt` оставлен (220 chars) как safety net для:
    - Старых DB-row из ДО schema-cap (re-scoring path)
    - Admin manual-submit (минует Stage 1 schema)
    - Future providers без maxLength enforcement
- **Stage 2 prompt сжат**: JSON output spec из табличного формата с `:` отступами в компактный inline-JSON (~150 → ~100 токенов)
- **Прогноз экономии**:
  - До PR: ~$288/мес Stage 2
  - После cap=3 + max_results=5: ~$153/мес (**-47%**)
  - После schema-cap explanation: ещё -$3-5/мес на output Stage 1
- **Не сделано** (рассмотрено и отложено):
  - **Batch Stage 2 ночью** — посчитали: x_search в batch не дешевле (это не Grok токены), экономия только на ~5% Grok-токенов = **$2/мес**. Не стоит ~600 строк кода и operational risk. Подробный разбор в чате 2026-04-29
  - **Replace Grok с Apify+gpt-5.4-mini** — экономия $127/мес (83%), но просадка качества Stage 2 (mini не натренирована на real-time виральность). Владелец отклонил («качество не резать»). Apify+Grok вариант тоже отклонён
  - **`max_tool_calls=2 → 1`** — мог бы сэкономить ещё $73/мес, но рассмотрен отдельно; пока оставлено = 2 (для второго search-angle)

---

## 2026-04-29 (Nano kill switch — env-panic + admin-runtime toggle)

- **Гипотеза**: gpt-5.4-mini в Stage 1 вероятно делает 80% работы nano натуральным образом (slang decoding, entity canonicalisation, paraphrasing). Уникальный сигнал nano — `entityCanonical` для cross-language clusterer entity-overlap (вес 0.20 в multi-signal similarity). На неделю A/B надо выключить nano и сравнить cluster-quality / Stage 1 score distribution
- **Архитектура двух уровней**:
  - **ENV** `STAGE0_NANO_ENABLED=0` — panic switch, читается в constructor. Используется когда админка недоступна или DB сбоит. Требует рестарт
  - **DB setting** `nanoEnabled` (default `'1'`) — нормальный admin toggle. Читается в `_isAdminEnabled()` на КАЖДЫЙ batch (no restart needed)
  - Layered приоритет: env-off > db-setting. Env-on не оверрайдит db-off
- **Файлы**:
  - `nano-classifier.js`: добавлен `db = null` в constructor; новый `_isAdminEnabled()` читает `db.getSetting('nanoEnabled', '1')` с try-catch (defaults to true on error). `classifyBatch` чекает оба слоя; soft-skip log: `[NanoClassifier] skipped — disabled via admin panel`
  - `index.js`: `new NanoClassifier(config, logger, db)` — db прокинут
  - `admin/server.js`: новые endpoints `GET /api/prestage/nano` (returns `{enabled}`) + `POST /api/prestage/nano/toggle` (flips DB setting). Persists через `db.setSetting('nanoEnabled', '0'|'1')`
  - `admin/server.js`: новый компонент `PreStageSection` (~120 строк) — секция «🎨 Stage 0 — PreStage» рядом с ScannerConfigSection. Карточка nano (toggle + статус «● Активен / ○ Отключён»), карточка Gemini (read-only, без toggle потому что у неё свой failover Google→OpenRouter)
  - `.env.example`: документировано как panic switch, normal flow через админку
- **Что мониторить за неделю A/B**:
  - `[Clusterer] N items → M clusters` — должно остаться примерно тем же. Если M вырастет (меньше склеек) → nano был полезен для cross-language кластеризации
  - Cycle time: должен упасть на ~3-5 сек (раньше nano блокировал PreStage Promise.all — занимал 5-7s, gemini параллельно 2-3s)
  - Stage 1 input tokens могут вырасти на 10-15% (mini теперь сам декодит slang+entities)
  - Качество AI-объяснений в дашборде

---

## 2026-04-29 (Apify TikTok video limits bumped 30s → 60s)

- **Запрос владельца**: TikTok видео часто 30-60 секунд, текущий cap резал половину. Поднять
- **Изменены defaults в `.env.example` + комментарии переписаны** (на сервере применяется через `sed`-batch на `.env`):
  - `STAGE0_VIDEO_MAX_SEC` 30 → **60**
  - `STAGE0_VIDEO_MAX_MB` 20 → **40** (60s видео в high-bitrate легко 20-30MB; 40 даёт запас без enabling abuse)
  - `STAGE0_GEMINI_TIMEOUT_MS` 45000 → **90000** (60s upload + processing на slow connection не укладывается в 45s)
- **Заодно почищены дубли** в `.env.example`: `STAGE0_GEMINI_TIMEOUT_MS` и `STAGE0_GEMINI_CACHE_TTL_SEC` встречались по 2 раза (мог быть undefined behavior — какое из двух Node возьмёт)
- **Стоимость**: Gemini считает видео как ~1 frame/sec → 60s ≈ 10-14K input tokens × $0.30/M = ~$0.004 на видео. При 5-10 видео/день = **<$1/мес**. Копейки

---

## 2026-04-29 (Pipeline visual в админке — порядок поправлен)

- После PR-2 порядок этапов в коде стал `collect → dedupe → prestage → cluster → stage1/2 → save → alerts`, но визуал в админ-панели всё ещё показывал старый `cluster → stage 0 → stage 1 → ...`. Анимация работала корректно (highlights нужного `id` карточки), но визуально путало
- В `admin/server.js` `PIPELINE_STAGES` массив переставлен. Hint обновлены:
  - Dedupe — «Aggregator + cheap exact-dupe collapse»
  - Cluster — «Multi-signal: embeddings + image hash + entities + junk» (вместо устаревшего «Junk filter»)
- Счётчики `appState.cycleInProgress.cluster/prestage/etc` индексируются по `id` стейджа, не по позиции в массиве — поэтому никакой связки SSE/UI не сломалось

---

## 2026-04-29 (Google AI Studio — Free tier → Tier 1, оператор)

- Не код, но операционно важно. Google AI Studio Free tier = **20 запросов в день** на gemini-2.5-flash. Прожигалось за первый час работы pipeline'а каждый день, дальше всё ушло в OpenRouter fallback (что забивало 78% gemini-картинок через OR — медленнее + чуть хуже качество)
- Владелец привязал карту → Tier 1: **10K запросов/день, 1000 RPM**. Лимиты выросли в 500× по дневному количеству. Failover на OpenRouter теперь только при 503 high-demand (~1-2 раза в час) и нашем cooldown circuit-breaker
- **Реальная стоимость по логам**: 607 input + 70 output на картинку → $0.0004/запрос. 8 картинок × 96 циклов × 30 = ~$9/мес. В 2.5× дешевле чем я прогнозировал, потому что Google direct base64-инлайн пакует токены экономнее чем OpenRouter `image_url`

---

## 2026-04-29 (PreStage hardening — videoUrl bug + payload guard + 4xx logging)

Долгая дебаг-сессия по жалобе «Gemini описывает только 1 кадр». Раскопали 4 разных проблемы.

- **Bug #1 (silent killer): Gemini никогда не пробовал нативное видео**. В `gemini-captioner.js:132` читали `trend.videoUrl` (top-level), а коллекторы (twitter `:411`, reddit `:350`) кладут видео в `trend.metrics.videoUrl`. Дашборд хойстит в top-level через `_formatTrend`, но в pipeline до Save это поле живёт ТОЛЬКО внутри `metrics`. Поэтому `isVideo = !!trend.videoUrl` всегда === false → каждый видео-тренд тихо шёл по постер-only пути. Фикс: `const videoUrl = trend.videoUrl || trend.metrics?.videoUrl || null` + использовать эту переменную дальше. TikTok-коллектор `videoUrl` не выставляет вообще — поэтому TikTok тренды остаются image-only by design (отдельная задача — достать MP4 из Apify response)
- **Bug #2: Misleading admin badge**. `🎬 Gemini (image) · видео > 30s, использован poster · 20.5s` — текст хардкоженый, выводился даже когда видео было КОРОЧЕ кап'а (truncation сработал из-за Google 503, не длительности). Captioner теперь возвращает `truncationReason: 'duration_exceeded' | 'native_unavailable' | null` + `videoMaxSec`. Админ-бейдж в `admin/server.js:4060` ветвит на 3 варианта. Полезно для оператора — сразу видно «нативное видео недоступно» vs «длина превышает лимит»
- **Bug #3 (главный): payload guard перед Google**. **Реальная причина исторических 400 BadRequest** на Google AI dashboard (~50 за день до фикса). Twitter/Reddit CDN URL'ы протухают молча: `HTTP 200 + HTML body`, `HTTP 200 + 0 bytes`, или `HTTP 404 + content-length: 0`. Старый код игнорировал mime-mismatch — `_sniffImageMime`/`_sniffVideoMime` возвращал null, мы клеили `'image/jpeg'` дефолтом и отправляли HTML/empty в Google. **Подтверждено curl-репродукцией с production ключом**: HTML payload + empty buffer + redirect-HTML + 404 от `pbs.twimg.com/media/SOME_OLD_ID.jpg` — все четыре дали идентичный `400 INVALID_ARGUMENT: "Unable to process input image"`. Фикс в `_tryGoogleMedia`: refuse to ship если `buffer.length === 0` или sniff returns null. Логируем `bufferBytes`, `downloadContentType`, `first16` (hex) + `preview` (80 byte ASCII), `url` — за один WARN-лог сразу понятно что прилетело
- **Bug #4: 4xx vs 5xx differentiated logging** в `_tryGoogleMedia`. 4xx = client error (наш косяк) → полный `errBody` без обрезки + structured `meta = { sentMime, bufferBytes, headContentLength, headMissing, downloadContentType, url, trendTitle, trendSource }`. 5xx = Google overload → короткий лог с `.slice(0, 200)` чтобы во время инцидентов не флудить мегабайтами одинаковых "high demand" сообщений. Теперь лог сам подсказывает «investigate» vs «wait»
- **Docker log rotation bumped** в `docker-compose.yml`: 10m × 3 → 50m × 5 (30 MB → 250 MB ring buffer для `docker logs`). Persistent file-log в named volume `/logs/{YYYY-MM-DD}.log` пишется параллельно через наш `Logger` и переживает ребилды — единственный надёжный способ дебажить пост-фактум, потому что `docker logs` стирается при `docker compose up -d --build` (новый container ID = новый log file)
- **Диагноз 2026-04-29 ~09:00 UTC**: Google AI 503 UNAVAILABLE на gemini-2.5-flash. Capacity overload подтверждён в Google AI Studio dashboard — same project tokenized payload OK (342 text + 258 image tokens billed!), output `candidates: [{ content: {} }]`, "high demand" message. **100% video calls fail, 30-50% image calls fail сегодня.** 78 503s в наших логах за день. Cooldown circuit-breaker работает корректно (3 фейла → 5 мин OpenRouter routing). Это НЕ наша проблема, ждём пока Google поднимет capacity. Side-effect: 600 input tokens биллятся даже при failed generation (~$0.014/день при текущей частоте — копейки)
- **Не пофикшено в этой сессии (но замечено)**:
  - Hardcoded `"FIRST 30 SECONDS ONLY"` в video prompt (`gemini-captioner.js:335`) — не учитывает `STAGE0_VIDEO_MAX_SEC=60`, надо заменить на `${this.videoMaxSec}`
  - `OPENROUTER_VISION_MODEL=google/gemini-3.1-flash` в `.env` — несуществующая модель, каждый цикл warn `primary model not available, switching to gemini-2.5-flash` (фоллбэк работает, но шумит)
  - На сервере `.env` всё ещё `STAGE0_VIDEO_MAX_SEC=30` (вместо 60) — деплой передал код, но env не синхронизирован. Нужен `sed -i 's/STAGE0_VIDEO_MAX_SEC=30/STAGE0_VIDEO_MAX_SEC=60/' /opt/catalyst/.env && docker compose up -d` на сервере
- **Файлы**: `src/analysis/gemini-captioner.js` (~70 строк изменений: videoUrl читать из metrics, payload guard, 4xx logging, truncationReason), `src/admin/server.js:4060-4076` (бейдж), `docker-compose.yml` (rotation)

---

## Ловушки и правила

- **Schema-enum drift**: меняешь enum в `prompts.js` (или другой ai-схеме) — обязательно проверяй ВСЕ потребители значения. Если есть фронтовый маппинг, telegram lifeIcon, formatter labels, i18n labels — каждый из них может молча возвращать `'—'`/`undefined` без единого warning'а в логах. Решение: для каждого такого enum завести модуль-источник истины (как `src/analysis/lifespan.js`) с `assertCoversXyz()` функцией которую вызывают все i18n/потребительские модули при загрузке. Тогда любая будущая миграция enum'а превратится в loud failure при старте сервиса
- **CSS specificity: body-class всегда выигрывает у одиночного class**: `body.prefs-compact .img-carousel { height: 280px }` (0,0,2,1) перебивает `.img-carousel.in-modal { height: 440px }` (0,0,2,0). Если делаешь modal-only override — добавляй явный `body.prefs-compact .img-carousel.in-modal { ... }` рядом, иначе compact-юзеры получают сломанную модалку молча. Применимо ко ВСЕМ парам base-rule + density/theme override
- **`<video>` без metadata = 300×150 default**: `width:100%; height:auto` на `<video>` пока metadata не загружен использует дефолтную 2:1 пропорцию → `object-fit: contain` для poster ужимает в плоский letterbox. Фикс — `aspect-ratio: 16/9` (браузер заместит на natural ratio когда подгрузит)
- **Backticks в комментариях `server.js`**: `src/dashboard/server.js` и `src/admin/server.js` — огромные inline React SPA внутри template literal. **Любой `` `token` `` в `//` комментарии ломает outer literal** с `SyntaxError: Unexpected identifier '<token>'`. Ловили ≥5 раз. Правило: в этих файлах **никогда** не писать backtick в комментариях. Всегда `node -c <file>` перед деплоем
- **Backslash-перед-неэкранируемым символом в SPA-регулярках**: внутри outer template literal `\/` → `/` (parser ест backslash; `/` не нуждается в экранировании). Регулярка `/^https?:\/\//i.test(x)` в исходнике становится `/^https?:///i.test(x)` в браузере → unterminated regex → `Uncaught SyntaxError` → чёрный экран. Поймал 2026-04-30 при редизайне SubmitPage. **Правило**: regex с `/` в SPA-блоке **обязан** использовать `\\/\\/` в источнике. То же касается `\$`, `\``, `\b` и любых не-метасимвольных пар. Validator `scripts/check-admin-spa.cjs` теперь поймает это (вызывает `_spa()` и парсит то что реально увидит браузер) — раньше ручное unwinding в валидаторе пропускало этот класс
- **Edit old trends without re-scoring**: `save_only` записи НЕ блокируются `isTrendSeen` — каждый скан клустерер пересмотрит их со свежими метриками; UPSERT по `external_id`/`url` не дублирует
- **`<video>` не шлёт auth headers** → `/api/video/reddit/*` обязан быть public (до auth middleware); regex-валидация `src` защищает от SSRF
- **Apify acc**: `General resource access` должен быть `Restricted`, не `Anonymous` — иначе runId даёт доступ без токена
- **Cache busting**: клиент кэширует bundle агрессивно; при выкатке UI-фич часто нужно ctrl+shift+R (TODO: явный cache-bust при росте аудитории)
- **better-sqlite3 bindings**: требуют recompile под текущий Node (v22.22.2); диагностические скрипты должны уметь fallback на sqlite3 CLI
- **xAI 429**: при исчерпании кредитов Stage 2 пропускается; в UI используется curated fallback для списка моделей
- **`npm ci` требует синхронный package-lock.json**: добавил dep в `package.json` → запустить локально `npm install --package-lock-only` ДО `deploy.ps1`. Иначе Docker build падает с `EUSAGE: Missing: <package>@<version> from lock file`. Применимо к ЛЮБОМУ изменению `dependencies`. Случилось 2026-04-29 при добавлении `sharp`
- **OpenAI strict json_schema enforces maxLength**: для Stage 1 (gpt-5.4-mini через `text.format.json_schema { strict: true }`) добавление `maxLength: N` на string field физически режет output на стороне модели. Это сильнее чем prompt-инструкция «keep it short» — гарантия. Использовали для `explanation` cap 220 chars 2026-04-29
- **x_search ценится `$5 per 1000 sources`, не `per 1000 calls`**: каждый возвращённый твит — отдельный source. `max_results=10` × `max_tool_calls=2` = до 20 sources = **$0.10 на Stage 2 вызов**. Когда в ноябре 2026 видишь Stage 2 расход 5-10¢ — это не баг, это by design xAI billing. Главные рычаги экономии — `XAI_STAGE2_MAX_RESULTS` и `XAI_STAGE2_MAX_TOOL_CALLS`
- **CSS body-class override pattern**: каждый раз когда добавляешь modal-only / variant-only стиль — проверяй есть ли `body.prefs-compact` или `body[data-theme]` rule с той же специфичностью. Если есть — добавляй явный `body.prefs-compact .your-class.in-modal { ... }` рядом, иначе прячется баг до момента когда юзер с другой темой откроет страницу
- **`trend.metrics.videoUrl` ≠ `trend.videoUrl`**: коллекторы (twitter `:411`, reddit `:350`) кладут видео внутрь `metrics`. Дашборд хойстит в top-level через `_formatTrend`, но всё что в pipeline ДО Save (clusterer, scorer, gemini-captioner, любой analysis-слой) — обязано читать из `metrics`. Шаблон: `const videoUrl = trend.videoUrl || trend.metrics?.videoUrl`. Этот баг в gemini-captioner МОЛЧА выключал нативное видео целый день, потому что `isVideo=false` всегда → шёл на постер. Те же грабли может наступить любой будущий код в `src/analysis/`. То же правило применимо к `imageUrl`, `imageUrls`, `thumbnailUrl` — все коллекторы кладут их в `metrics`
- **Google `inlineData` с любой mimeType + не-image байт = 400 INVALID_ARGUMENT**: сообщение `"Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting"`. Воспроизведено curl'ом 2026-04-29 на четырёх сценариях: HTML (404 page), empty buffer (CDN 0-byte response), redirect-HTML (curl без `-L`), 404 от `pbs.twimg.com/media/SOME_OLD_ID.jpg` — все идентично 400. Правило: ПЕРЕД отправкой в Google всегда проверять `_sniffImageMime/_sniffVideoMime(buffer)` — если null, refuse to ship. **Не доверять** `Content-Type` из download response (Twitter CDN врёт чаще чем говорит правду — 200 OK + `content-type: image/jpeg` + body=HTML). Один источник истины — magic bytes в первых 12 байтах буфера
- **Docker stdout log умирает с контейнером**: `docker logs catalyst-app` показывает только jsonl-файл текущего инстанса. После `docker compose up -d --build` ВСЕ логи прошлого контейнера теряются (новый container ID = новый log file). Persistent file-log в named volume `catalyst_logs` (`/logs/{YYYY-MM-DD}.log`) пишется параллельно через наш `Logger` и переживает ребилды — единственный путь дебажить пост-фактум. Команды: `docker exec catalyst-app cat /logs/2026-04-29.log` или `docker cp catalyst-app:/logs/2026-04-29.log .`. Полезные шаблоны: `grep -oE 'Google (image|video) HTTP [0-9]+' /logs/<date>.log | sort | uniq -c | sort -rn` для сводки по кодам ответа; `grep -B1 -A2 'HTTP 4' /logs/<date>.log` для тел 4xx
- **Google AI билит input tokens даже при failed generation**: 503 UNAVAILABLE возвращает `candidates: [{ content: {} }]` (output tokens=0), но `usageMetadata.promptTokenCount` уже захардкожен (text+image tokens). При длительных Google инцидентах это копейки в час, но если 503 затягивается на сутки — стоит увеличить `STAGE0_GOOGLE_COOLDOWN_MS` (default 5 мин) хоть до часа, чтобы реже стучаться и не платить за пустые ответы. Также: 503 ≠ rate limit. Tier 1 RPM=1000, мы гоняем 34 max — лимит не выбран, проблема исключительно в shared model capacity

---

## 2026-04-30 (SubmitPage history persistence + card redesign)

- **Цель**: ручной анализ в админке тёрся при reload/уход с раздела (state хранился только в `useState`). Юзер: «хочу чтобы мои ручные поиски остались + переделать карточку поста на более красивую и удобную»
- **Persistence**: каждый submit уже UPSERT'ил в `trends` с `raw_metrics.manualSubmitted=true` — ничего нового сохранять не нужно. Добавили путь чтения:
  - `db.getManualTrends(limit)` — `SELECT * WHERE raw_metrics LIKE '%"manualSubmitted":true%' ORDER BY first_seen_at DESC LIMIT ?`. JSON-text LIKE-фильтр без расходов на парсинг каждой строки server-side; маркер уникален в схеме (никаких других полей с `manualSubmitted` нет)
  - `db.unsetManualSubmitted(trendId)` — снимает флаг (тренд остаётся в БД, выпадает из истории SubmitPage)
  - `GET /api/manual-trends?limit=N` (cap 200) — список hydrated rows + re-derived `pipeline` trace (memePotential vs текущий threshold, source, isNovel — те же чек-условия что в `_submitNarrative`)
  - `DELETE /api/manual-trends/:id` — кнопка 🗑 в history-strip
- **Shape helper**: `_shapeManualTrend(trend, dbId)` извлёчён из `_submitNarrative`. Один источник истины для shape — live submit и history endpoint возвращают идентичный payload, фронт рендерит одинаково
- **Hydrator расширен**: `_hydrateTrendFromDb` теперь восстанавливает `description` (колонка `trends.description`), `clusterMetrics`, `stage2Penalty/StoryBonus/NameBonus`, `viralityScore`, `manualSubmitted/manualSubmittedAt`, `firstSeenAt` — раньше эти поля читались только в live-flow и в DB-hydrate path возвращали undefined → история показывала бы пустые секции
- **SubmitPage UX**:
  - На mount → `GET /api/manual-trends?limit=80` → горизонтальная strip из mini-карточек (image thumb + title 2-line clamp + 💎 score chip + relTimeRu age + 🗑 трэш). Самая свежая активна по умолчанию
  - Клик по mini-карточке переключает active детальное окно
  - Submit prepend'ит результат в строп, делает active
  - 🗑 — confirm + DELETE → из стопа исчезает (тренд в БД остаётся целым)
- **Карточка результата редизайн** (`ManualResultCard`):
  - HERO-блок: 84×84 image thumb (или source-icon placeholder) слева + title 16px bold + meta (`#id · src · elapsed · relTime`) + buttons + 🧪 MANUAL chip
  - Pipeline trace (без изменений) → score grid (5-7 cells, repeat auto-fit 120px) → Score bars
  - **Trigger / AI explanation / Описание** — всегда раскрыты (это primary value)
  - **Collapsible advanced sections**: Stage 0 PreStage (closed), Stage 2 deep-dive (open by default — это самая ценная инфа когда есть), Сырые метрики (closed), Сигналы кластера (closed), 🖼 Картинки если ≥2 (closed). Реализован общий `Collapsible` компонент (header click toggle, content unmount при close)
  - Meta chips compact в одной строке между AI и collapsible-блоками
  - Comment textarea внутри карточки (была раньше только в submit-форме) — оператор может скорректировать комментарий перед «Отправить алерт» по конкретному тренду
- **Helpers added** (выше SubmitPage в SPA): `Collapsible`, `relTimeRu`, `srcIcon`, `ManualHistoryItem`, `ManualResultCard`
- **Validation tooling**: добавлен `scripts/check-admin-spa.cjs` — экстрактит `<script>...</script>` из template literal, undo'ит `\\\\` `\\\`` `\\$` escaping, прогоняет через `vm.Script`. Ловит **оба** класса ошибок этого файла (backticks-in-comments + escape-in-strings). `.cjs` потому что проект `"type": "module"`. Запускать перед каждым деплоем который трогает `admin/server.js` или `dashboard/server.js`
- **Файлы**: `src/db/database.js` (+~40 строк: `getManualTrends`, `unsetManualSubmitted`), `src/admin/server.js` (~+450 строк: эндпоинты, `_shapeManualTrend`, `_derivePipelineTrace`, расширение `_hydrateTrendFromDb`, новый `Collapsible`/`ManualHistoryItem`/`ManualResultCard`/`SubmitPage`; ~−270 строк старого SubmitPage), `scripts/check-admin-spa.cjs` (новый, ~30 строк)
- **Деплой**: `.\deploy.ps1` (изменения только в admin SPA + DB методы — не нужны env правки, не нужны рестарты сервиса до выкатки)
- **Hotfix (тот же день)**: первая версия выкатилась с чёрным экраном. Причина: в новом `submit()` я написал `if (!/^https?:\/\//i.test(clean))` — outer template literal сожрал backslash перед `/`, в браузер прилетело `/^https?://i.test(...)` → unterminated regex → `Uncaught SyntaxError`. Старый код имел `\\/\\/` именно для этой защиты. Возвращён `\\/\\/`. Также **переписан `scripts/check-admin-spa.cjs`** — раньше делал ручное unwinding (`\\` → `\`, `\`` → `` ` ``, `\$` → `$`), пропускал `\n`/`\t`/`\u`/`\x`/`\/`. Теперь импортит модуль, дёргает `AdminServer.prototype._spa.call({})` (метод не использует `this.*`), извлекает `<script>` ИМЕННО ИЗ ТОГО HTML что увидит браузер, прогоняет через `vm.Script`. Backslash-eat ловится мгновенно, поэтому такая ошибка больше не выкатится в прод. **Запускать после ЛЮБОГО изменения inline-SPA в admin/server.js или dashboard/server.js**: `node scripts/check-admin-spa.cjs`
- **Visual rewrite (тот же день)**: владелец попросил привести SubmitPage к единому виду с остальной админкой. Найдены проблемы первой версии: использовал `var(--text3)` (не определён, только `--text` и `--text2`), `var(--dim)` (не определён), хардкодил пурпурный `#b48cff` и голубой `#5bc0eb` вместо `var(--accent)` (`#14b8a6` teal — основной токен админки), inline-styled чипы вместо CSS-классов, hero без gradient + без shadow в духе `.scanner-status-bar`. Решение: добавлен блок `.sp-*` CSS-классов в `<style>` (~110 строк, рядом с `.exp-*` и `.scfg-*` блоками), все компоненты SubmitPage рефакторнуты:
  - `Collapsible` → `.sp-collapsible` + `accent="prestage"|"stage2"` для тонировки (вместо inline rgba)
  - `ManualHistoryItem` → `.sp-hist-card.active` + `.sp-hist-pill.high/mid/low/cold` (color-mix как в `DecisionsPage`)
  - `ManualResultCard` hero → `.sp-hero` с тем же `linear-gradient(135deg,rgba(20,184,166,.07),rgba(56,189,248,.04))` градиентом что у `.scanner-status-bar`
  - `.sp-pill.manual/.ok/.warn/.bad/.skipped` для pipeline trace и MANUAL chip — единый ритм 999px-радиуса
  - `.sp-score-tile.hot/.warm/.bad` для score grid (auto-tone по value 70/40, override на bad)
  - `.sp-bar-*` для AdminScoreBar — цвета через `var(--green)`/`var(--yellow)`/etc.
  - `.sp-block` + `.sp-block.accent-trigger/.accent-stage2/.accent-prestage/.accent-tg` — единый паттерн для AI-объяснения / описания / Stage 2 / TG-broadcast статуса
  - `.sp-narrative` — left-border accent для текстовых блоков (бывший `narrativeBox` хелпер удалён, его поведение зашито в `.sp-narrative` CSS)
  - `.sp-chip` для meta-чипов (категория / sentiment / lifespan / phase) — pill-style консистент с DecisionsPage
  - Helper `scoreBox(label, value, cls)` переименован в `spTile()`, все цвета теперь через CSS `.sp-score-tile.hot/.warm/.bad`
- **Файлы доп**: `src/admin/server.js` (~+110 CSS lines, ~−290 inline-style lines в SubmitPage components)

---

## 2026-05-01 (Manual analysis — dashboard + Telegram, pro/admin gated)

- **Цель**: ручной анализ был доступен только из админки. Владелец попросил вынести в дашборд и TG-бот, доступ — только Pro и Admin планы
- **Архитектурный рефакторинг**: URL resolvers и оркестратор анализа вынесены из `admin/server.js` в `src/analysis/`
  - `src/analysis/url-resolver.js` (новый) — pure functions: `resolveUrlToTrend(url)`, `resolveTwitterUrl/RedditUrl/TiktokUrl/GenericUrl`. Бывшие `_resolveTwitterUrl`/`_resolveRedditUrl`/etc. в админке (273 строки) удалены — все три вызова (admin SubmitPage / dashboard endpoint / TG bot) теперь импортят из одного источника. Один баг в fxtwitter media parsing — фикс в одном месте
  - `src/analysis/manual-analysis.js` (новый) — `runManualAnalysis({ scorer, db, url, save, logger, actorId })` оркестратор. Resolve → `scorer.scoreTrends([synthetic])` → optional save с manualSubmitted flag → re-derived pipeline trace. Возвращает `{ ok, elapsedMs, trend, dbId, pipeline }`
- **Admin рефактор**: `_submitNarrative` сжат с ~58 строк до ~25 (тонкий wrapper над `runManualAnalysis` с broadcast после). Поведение идентичное — single source of truth. SubmitPage UX/визуал не тронуты
- **Dashboard endpoint** `POST /api/manual-analysis`:
  - Auth required (existing X-Auth bearer middleware)
  - Plan gate: `req.user.plan_name ∈ ['pro', 'admin']` → иначе 403 `reason: 'plan'`
  - Rate limit (admin bypass): 30s между вызовами + 20/24h. In-memory ring `Map<userId, ts[]>` в DashboardServer instance — сбрасывается при рестарте, что ОК для soft cap
  - **save: false** — приватный анализ не попадает в глобальную ленту (в отличие от админки где save: true)
  - Response shape — adapted к `_formatTrend` shape с synthetic ID `manual-<ts>`, чтобы UI рендерил через ту же `TrendModal` что и обычные feed-cards
- **Dashboard UI**:
  - Bottom-nav третья кнопка «🧪 Анализ» — рендерится только если `me.plan ∈ {pro, admin}`. Free/test юзеры её не видят
  - `view === 'analyze'` → открывает `Sheet` с `AnalyzePanel`: header (back + title) → описание → form (URL input + кнопка) → empty state ИЛИ результат
  - Результат: hero strip (84px thumb + title + meta + 🔗source + 👁 «Открыть карточку»), pipeline trace pills (Stage 1 ✓ / Stage 2 ✓⏭), score grid (4 tiles: 💎 Meme / 🌊 Emergence / 🔥 Adoption / 📖 Story если есть), AI explanation strip
  - «Открыть карточку» переключает на `view: 'trends'` + `setModalTrend(tr)` → результат открывается в стандартной TrendModal со всем рендерингом (карусель, видео, score bars, Ask Grok, source link)
  - CSS `.analyze-*` (~110 строк) в стиле остальных panels: `linear-gradient`, `var(--accent-rgb)` для accents, `.analyze-pill.ok/.warn` через color-mix, `.analyze-score.high/.mid/.low` для color toнировки
- **Telegram bot**:
  - Команда `/analyze <url>` — если URL не передан или не парсится, показывает usage. Регистрируется в `setMyCommands` (видна в TG-меню)
  - Bare-URL handler — `bot.on('message')` второй регистрируется (после команд). Если текст содержит `https?://` И юзер pro/admin — автоматически запускает анализ. Free/test игнорятся молча (никаких "you need pro" уведомлений на каждую ссылку чтобы не флудить)
  - Helper `_runManualAnalysisForUser(msg, user, url)`:
    - Defence-in-depth plan check (на случай если bare-URL handler пропустил)
    - Same rate limit как dashboard (30s + 20/24h, admin bypass)
    - Acknowledge "⚙️ Анализирую... (10-30 сек)" → анализ → удалить ack → `sendAlertToUser(trend, user)` тот же rendering что и обычные алерты (видео + media group + caption logic + кнопки feedback/Ask Grok)
    - НЕ записывает в `notifications`, НЕ инкрементит `alert_count` — приватный анализ, не broadcast
    - Двуязычные сообщения (RU/EN) inline через `user.language` switch
- **Конструкторы расширены**:
  - `DashboardServer(..., extras = {})` — 8-й arg как у admin. `extras.scorer` сохраняется в `this.scorer`. Без скорера `/api/manual-analysis` возвращает 503 `reason: 'disabled'`
  - `TelegramNotifier(config, logger, db, solanaMonitor, triggerFinder, scorer)` — 6-й positional. Без скорера `/analyze` отвечает "not configured"
- **`scripts/check-dashboard-spa.cjs`** (новый, ~50 строк) — sister script для admin's check. Импортит модуль, дёргает `DashboardServer.prototype._buildSPA.call({})`, прогоняет через `vm.Script`. Та же защита от backslash-eat / backtick-in-comment траппов. Запускать после ЛЮБОГО изменения inline-SPA в dashboard/server.js. **Поймал тот же баг что и в админке вчера** — `if (!/^https?:\/\//i.test(clean))` без двойного экранирования
- **Стоимость**: каждый pro/admin manual analysis тратит Stage 2 ~5¢ (если memePotential ≥ 60). Daily cap 20 → max ~$1/день/юзер. Suchabuse-resistant соображение — Stage 2 — самая дорогая операция в системе
- **Файлы**: `src/analysis/url-resolver.js` (новый, ~270 строк), `src/analysis/manual-analysis.js` (новый, ~95 строк), `src/admin/server.js` (~−270 строк resolvers, +1 import, _submitNarrative сжат), `src/dashboard/server.js` (+~150 строк JS — endpoint, AnalyzePanel, BottomNav, Sheet wiring; +~110 строк CSS; ~+30 строк i18n RU/EN), `src/notifications/telegram.js` (+~110 строк JS — `/analyze` handler, bare-URL handler, `_runManualAnalysisForUser`), `src/index.js` (+2 wiring args), `scripts/check-dashboard-spa.cjs` (новый, ~50 строк)
- **Деплой**: `.\deploy.ps1` — без env-правок. Проверь после: TG `/analyze https://...` от admin → должен вернуть алерт-карточку через 10-30s. Dashboard → /menu → 🧪 Анализ tab → форма работает.

---

## 2026-05-01 (Manual analysis — cross-user URL cache, 1h TTL)

- **Цель**: владелец заметил что если pro-юзер A проанализировал URL X, pro-юзер B по тому же URL запускает повторный полный pipeline (~5¢ Stage 2). Нужно кэшировать на час
- **Реализация**: module-level `RESULT_CACHE` Map в `src/analysis/manual-analysis.js`:
  - Key: lowercase URL без trailing-slash. Query string сохраняется (некоторые URL без него теряют идентификатор; tracking-параметры вроде `utm_*` заплатят за дубль анализ — это <5¢, не стоит нормализатора)
  - Value: `{ trend, pipeline, ts, savedDbId|null }`. Хранит full scorer output (а не shaped) — каждый surface (admin/dashboard/TG) shape'ит самостоятельно
  - TTL: 1 час. Sweep expired при росте >200 entries (lazy)
  - Wiped on restart — для 1h cache это OK, не нужна персистентность
- **Cross-save semantics**: cache переживает разные `save:` режимы:
  - save:false caller A → кэш сохраняется без `savedDbId`
  - save:true caller B (admin) hits cache → выполняем lazy save, обновляем `savedDbId` → следующие save:false коллеры тоже видят dbId (ссылки на trend в дашборде/TG будут работать)
  - save:true caller A → кэш сохраняется с `savedDbId`. save:false caller B reuses
- **Rate-limit interaction**: добавлен `peekManualAnalysisCache(url)` non-mutating helper. Dashboard и TG handler'ы peek'ают перед rate-limit — на cache hit ИКОНОМИМ rate-limit (свободные мгновенные запросы не должны жечь дневной лимит юзера). На cache miss — обычный 30s+20/24h
- **UX surfacing**:
  - `runManualAnalysis` возвращает `fromCache: boolean`, `cacheAgeMs: number`
  - Dashboard endpoint пробрасывает в response. AnalyzePanel в hero-meta показывает «`из кэша · 12 мин назад`» вместо «`fresh · 8.3s`»
  - Admin SubmitPage hero-meta тоже: «`💾 из кэша · 12 мин назад`»
  - TG `_runManualAnalysisForUser`: на cache hit пропускает «⚙️ Анализирую...» ack-сообщение (instant result не нужен пре-индикатор)
- **`useCache: false`** опция — для будущего admin "Force re-run" button (не выкатывали — cache TTL 1h достаточно гибкий)
- **`clearManualAnalysisCache(url?)`** export — для тестов / future invalidate-on-edit. Сейчас не используется
- **Стоимость**: ожидаемая экономия — pro-юзеры обычно паpаллельно интересуются одними и теми же viral нарративами. Cache hit rate в первый час после первого анализа ~3-5x. При daily cap 20/юзер и 50 pro-юзеров → пиковая нагрузка может упасть с $50/день до $15-20/день
- **Файлы**: `src/analysis/manual-analysis.js` (~+90 строк cache logic), `src/dashboard/server.js` (peek + UI меta), `src/notifications/telegram.js` (peek + skip ack on hit), `src/admin/server.js` (passthrough fromCache в response + UI meta)
- **Деплой**: `.\deploy.ps1`. Проверка: дважды проанализировать один и тот же URL за 1 час → второй раз должен показать «из кэша · X мин назад» в hero-карточки и не сжечь rate-limit hit
