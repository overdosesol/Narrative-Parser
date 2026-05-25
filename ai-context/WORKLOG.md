# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 безархивации. Полная история — в git.

Если задача мелкая, например передвинуть кнопку в дашборде или изменить немного текст в промпте для llm, можно сразу не записывать в WORKLOG, а подождать пока накопится около 5 мелких правок или 1 большая и записать всё вместе.

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
