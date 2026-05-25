# Billing & entitlements audit — 2026-05-24

**Scope**: третий этап. Целостность tier'ов подписки (free/test/pro/admin), paywall'ов, plan-based ограничений, privilege boundaries, plan-change lifecycle, audit trail. **Не покрыто** (другие этапы): SQL inj/XSS (1 — done), pipeline correctness (2 — done), cost limits per-API (4), DB schema/retention (5), UX polish (6), admin UI usability (7).

**Method**: 9 параллельных агентов (sonnet для entitlements consistency + plan lifecycle + edge cases, haiku для остальных) против `src/billing/entitlements.js`, `src/dashboard/server.js`, `src/admin/server.js`, `src/notifications/telegram.js`, `src/support/bot.js`, `src/db/database.js`, `src/billing/solana-pay.js`. Ничего в коде не менялось.

---

## Entitlements map

Источник истины — `src/billing/entitlements.js`. Все 4 тира явно перечислены, unknown plan → fallback на free (paranoid default).

| Plan | sources | manualAnalyze | catalyst | xAnalysis | historyHours | favorites |
|---|---|---|---|---|---|---|
| **free** | `reddit, google_trends` | 0 (blocked) | 0 (blocked) | 0 (blocked) | 72h | false |
| **test** | ALL 5 | 5/day | 5/day | 10/day | -1 (unlim) | **false** |
| **pro** | ALL 5 | 100/day | 100/day | -1 (unlim) | -1 (unlim) | true |
| **admin** | ALL 5 | -1 (unlim) | -1 (unlim) | -1 (unlim) | -1 (unlim) | true |

`ALL_SOURCES = ['reddit', 'google_trends', 'twitter', 'tiktok', 'x_trends']`.

`getPlanEntitlements(unknownPlan) → PLAN_ENTITLEMENTS.free` (paranoid).
`shouldShowUsageCounter(plan) → plan === 'test'` — Pro/Admin не видят counter (cap 100/unlim = noise).

**Caps semantics**: `0` = blocked, `-1` = unlimited, `N>0` = N/day soft-cap (in-memory rolling 24h Map). Не security boundary, рестарт сбрасывает.

**`favorites: false` для test** — это не опечатка: Saved tab + ⭐ доступны только Pro/Admin (см. SESSION_CONTEXT § User favourites). Test получает manual-analyze + catalyst, но не favorites.

---

## Summary

**Counts**: 0 critical · 3 high · 5 medium · 3 low · 4 info · **15 findings total**.

База держится: `getPlanEntitlements` действительно single source of truth для всех hot paths (dashboard manual-analyze + catalyst + favorites + sources + historyHours, TG bot menu + analyze + xAnalysis + catalyst), paranoid default `unknownPlan → free` срабатывает корректно, plan читается **fresh из DB каждый request** (нет JWT cache — token = 64-hex Bearer, см. SEC-005), per-plan caps проверяются ДО LLM-call'ов, cache-hit не consume slot (что intended), backend clamp'ит `?source=twitter` для free (`AND source IN (...) AND source = ?` → empty result), `_favoriteGate` стоит на всех 4 favorite endpoint'ах, bot фильтрует keyboard по plan + callback double-checks (defense-in-depth).

Слабые места: один **paywall bypass** через preview endpoints (free может читать live Twitter content через `/api/tweet-preview`), полное **отсутствие audit log** на plan grant/revoke (невозможно расследовать «почему user X на pro»), и cross-audit `/api/scan` billing dimension (free может жечь LLM cycle). Плюс **double SoT для sources** между entitlements.js и `plans.sources` CSV в DB (drift risk).

**Top-3 worst**:
1. **BILL-001** (high) — `/api/tweet-preview` / `/api/reddit-preview` без plan-check → free читает Twitter content (paywall bypass на key feature).
2. **BILL-002** (high) — Plan grant/revoke без audit log → нет ответа на «кто, когда, кому grant'нул pro».
3. **BILL-003** (high) — `/api/scan` без plan-gate (billing dimension; overlap с SEC-001 + PIPE-004) → free triggers expensive Gemini/Grok cycle.

---

## Findings

### [BILL-001] `/api/tweet-preview` и `/api/reddit-preview` без plan-check — severity: **high**

* **Where**: `src/dashboard/server.js:1333-1380` (`_handleTweetPreview`), `src/dashboard/server.js:1389-1426` (`_handleRedditPreview`)
* **Plan boundary**: free vs paid (free=reddit+google_trends, paid=ALL 5)
* **What**: оба endpoint'а не вызывают `getPlanEntitlements(user.plan_name)` для гейта. SESSION_CONTEXT § Dashboard layout «Link hover preview» декларирует hover для Twitter+Reddit ссылок — но контракт подразумевает что **трендов** Twitter free user даже не видит (sources filter). Если free user получает Twitter URL извне (от друга, из старого DM, из cache) и кликает hover-preview через manipulated request — backend возвращает full fxtwitter content (text, author, engagement metrics).
* **Repro**: free user → `curl -H 'Authorization: Bearer <free-token>' 'https://catalystparser.io/api/tweet-preview?id=1234567890'` → 200 OK с tweet JSON.
* **Impact**: paywall bypass на одну из ключевых платных функций. Free user читает Twitter live data без upgrade. Reddit-preview не критично (reddit и так в free entitlement.sources), но Twitter — да.
* **Fix**: добавить `getPlanEntitlements(req.user?.plan_name).sources.includes('twitter')` check на entry `_handleTweetPreview` (return 403 reason='plan' иначе). Reddit-preview можно оставить или для consistency тоже gate'нуть.

---

### [BILL-002] Plan grant/revoke без audit log — severity: **high**

* **Where**: `src/admin/server.js:712-727` (`_setUserPlan`), `src/admin/server.js:939-951` (grant/revoke endpoints), `src/db/database.js:895-904` (`upgradePlan`)
* **Plan boundary**: любой переход через admin (free→pro, pro→free, pro→test, etc.)
* **What**: UPDATE `users.plan_id` происходит напрямую без логирования. Grep по `audit_log`, `plan_change_log`, `admin_log` — пусто. Единственный след — `payments` table, но только для платных через Solana (admin grant'ы не пишут туда). После SET plan_id истории не существует.
* **Repro**: admin grant'ит pro случайному user'у → нет следа. Через месяц — невозможно ответить «кто это сделал», «когда», «по какой причине».
* **Impact**: compliance/operational. Compromised admin token (SEC-005 — Bearer hex, не JWT) → бесконечные тихие grant'ы. Multi-admin команда — конфликты неразрешимы. При downgrade pro→free пользователь теряет оставшиеся дни (см. BILL-010) без возможности undo.
* **Fix**: создать `plan_change_log(user_id, old_plan, new_plan, actor_id, actor_kind ['admin'|'payment'|'system'], reason, created_at)`. В `_setUserPlan`, `upgradePlan`, `confirmPaymentAndUpgrade` (последний уже в транзакции — добавить INSERT в ту же).

---

### [BILL-003] `/api/scan` billing dimension — free может жечь LLM (cross-audit) — severity: **high**

* **Where**: `src/dashboard/server.js:2112-2125` (`_handleScan`)
* **Plan boundary**: free→admin (должен быть admin-only, по факту любой authed)
* **What**: handler не проверяет `req.user?.plan_name === 'admin'` (issue зафиксирован в **SEC-001**) и не проверяет `getPlanEntitlements(...).manualAnalyze > 0` (billing angle). Free user с токеном дёргает `POST /api/scan` → полный collect→Stage1→Stage2 cycle с реальным LLM spend. `manualAnalyze` cap **не** consume'тся — это не paid feature по API design, но реально жжёт paid infrastructure.
* **Repro**: free user → `curl -H 'Authorization: Bearer <free>' -X POST 'https://catalystparser.io/api/scan'` → 202 Accepted, scan запускается, $0.5-$1.5 spend на cycle (зависит от config).
* **Impact**: cost-burn vector. Хуже всего — не учитывается ни как scan_count, ни как manualAnalyze hit; нет per-user throttling.
* **Cross-audit**: одна правка закроет три finding'а:
  1. SEC-001 (admin gate отсутствует — privilege escalation angle).
  2. PIPE-004 (timestamp race — observability angle).
  3. BILL-003 (cost burn — billing angle).
* **Fix**: в начало `_handleScan` добавить `if (req.user?.plan_name !== 'admin') return json(res, 403, { reason: 'plan' })` и `lastScanCompletedAt = now` write **сразу**. Семантически это admin-only operation — у scheduler'а свой scan через `startScheduler`.

---

### [BILL-004] Двойной SoT для sources — entitlements.js vs `plans.sources` CSV — severity: **medium**

* **Where**: `src/db/database.js:469-506` (плата seeded в `plans.sources` CSV) vs `src/billing/entitlements.js:27-33` (ALL_SOURCES + per-plan arrays). `src/notifications/alert-dispatcher.js:194-200` читает `user.plan_sources` из JOIN, **не** через `getPlanEntitlements`.
* **Plan boundary**: free→paid (free=reddit+google_trends, paid=ALL 5)
* **What**: два независимых хранилища истины для «какие источники видит plan X». Dashboard и TG bot читают через `getPlanEntitlements`, alert-dispatcher читает CSV из БД. `normalizePlans()` на boot seed'ит plans.sources из defaults — сейчас они идентичны для всех 4 плановв. Но дрейф возможен: добавил 6-й source в `entitlements.js` → забыл бамп в `normalizePlans` → dashboard показывает source, alerts не отправляются (или наоборот).
* **Repro**: hypothetical refactor — добавить `'mastodon'` в `ALL_SOURCES`. Без согласованного fix `normalizePlans()` → silent inconsistency.
* **Impact**: latent drift. Сейчас работает корректно (проверено), но architectural footgun на будущее.
* **Fix**: alert-dispatcher переписать на `getPlanEntitlements(user.plan_name).sources` и игнорировать `user.plan_sources`. `plans.sources` column становится display-only metadata (или вообще удалить из schema в этапе 5).

---

### [BILL-005] Alert-dispatcher fallback «empty plans.sources → all pass» расходится с paranoid default — severity: **medium**

* **Where**: `src/notifications/alert-dispatcher.js:197-200, 330` — `planAllowedSources.length === 0 || planAllowedSources.includes(sourceLc)`
* **Plan boundary**: любой plan с поврежденной DB-row
* **What**: если `plans.sources` пустая строка/NULL — gate становится «ALL pass» (комментарий объясняет «legacy/admin fallback»). Это **противоположно** `getPlanEntitlements`-семантике, где unknown plan → free (closed by default = только reddit+google_trends).
* **Repro**: `UPDATE plans SET sources = '' WHERE name = 'free'` через ручной SQL (миграционный bug, ручная правка) → free user начнёт получать twitter/tiktok alerts.
* **Impact**: low likelihood (требует SQL tampering), но asymmetric default vs entitlements.js — latent footgun. Dashboard ограничения остаются (там через entitlements), только alerts «leak».
* **Fix**: либо порт alert-dispatcher на `getPlanEntitlements(...).sources` (закроет и BILL-004), либо если оставить CSV — `length === 0` должно значит «no sources allowed», не «all pass».

---

### [BILL-006] `_setUserPlan` / `upgradePlan` не атомарны (multi-step без транзакции) — severity: **medium**

* **Where**: `src/admin/server.js:712-727` (`_setUserPlan`), `src/db/database.js:895-904` (`upgradePlan`)
* **Plan boundary**: любой grant/revoke через admin
* **What**: `_setUserPlan` делает `SELECT id FROM plans WHERE name = ?` затем `UPDATE users SET plan_id = ?, subscription_expires_at = ? WHERE id = ?`. Между ними нет `db.transaction(...)` обёртки. `confirmPaymentAndUpgrade` (line 854-880) — **правильно** в транзакции, для admin grant — нет.
* **Repro**: hypothetical migration script DROP/RECREATE `plans` table в фоне → SELECT возвращает id=2, UPDATE вставит stale plan_id (orphan, FK constraint бы блочил, но при migration FK off).
* **Impact**: на практике plans table статичная, риск низкий. Но симметрии с payment path не хватает.
* **Fix**: обернуть `_setUserPlan` в `db.transaction((id, name, days) => { ... })`. Cosmetic, не блокер.

---

### [BILL-007] In-memory cap counters — restart обнуляет — severity: **medium**

* **Where**: `src/dashboard/server.js:440` (`_manualAnalysisHits = new Map()`), `src/notifications/telegram.js` (`_manualAnalysisHits`, `_catalystHits`, `_xAnalysisHits`)
* **Plan boundary**: test plan (cap=5/day) самый уязвимый
* **What**: счётчики hits хранятся **только** in-memory. Контейнер рестартует (deploy, OOM, manual restart) → counter обнуляется → test user может exploit: «купил test за $5 → потратил 5 manualAnalyze → ждать рестарт → ещё 5». Pro/admin caps большие (100/unlim) — exploit непрактичен. Free — cap=0, не consume в counter (отказ до increment).
* **Repro**: test user тратит 5 manualAnalyze, deploy.ps1 запускается → новый container → счётчик пустой → ещё 5 calls этого же chat_id.
* **Impact**: real exploit на test plan ($5 → ×2 spend через deploy). Pro невыгодно (cap 100). Поверхность — частота deploy'ев (по `WORKLOG.md` ~5-10/неделю последние недели).
* **Fix**: персистить в DB table `manual_analysis_log(chat_id, ts)` с retention 30 дней + `SELECT COUNT WHERE chat_id = ? AND ts > NOW - 1 DAY`. Same для catalyst + xAnalysis (или единая `feature_usage_log(chat_id, feature, ts)`). Сейчас комментарий в коде явно говорит «soft cap, not security boundary» — но business decision давать каждый deploy ×2 spend сомнителен.

---

### [BILL-008] Pro→Pro renewal сжигает оставшиеся дни без warning — severity: **medium**

* **Where**: `src/notifications/telegram.js:561-584` (`buy_plan:pro` callback), `src/billing/solana-pay.js:63-87` + `confirmPaymentAndUpgrade`
* **Plan boundary**: pro→pro renewal (defrauds active subscriber)
* **What**: buy_plan:pro callback не проверяет current plan. User с pro подпиской (expires через 25 дней) кликает /upgrade → создаётся payment intent → платит $100 USDC → `confirmPaymentAndUpgrade` ставит `expires_at = NOW + 30 days`. Оставшиеся 25 дней **обнуляются** (не складываются, не возвращаются). UI не предупреждает «у тебя уже pro до date».
* **Repro**: user с активным pro impulsively жмёт /upgrade → теряет $100 × (25/30) ≈ $83 эквивалента ценности.
* **Impact**: deception by omission. Потеря денег пользователя при renewal до истечения. Возмещение через support → admin → manual fix.
* **Fix**: в `buy_plan:pro` callback (telegram.js:561) добавить check `if user.plan_name === 'pro' && !isSubscriptionExpired(user)` → показать «У тебя уже Pro, истекает: <date>. Продлевать?». На Yes — `confirmPaymentAndUpgrade` делает `expires_at = MAX(current_expires_at, NOW) + 30 days` (extend, не reset).

---

### [BILL-009] TG bot использует `plan === 'free'` literal вместо entitlements check — severity: **low**

* **Where**: `src/notifications/telegram.js:634` (trigger callback gate), `src/notifications/telegram.js:1443` (`catalystEnabled = plan && plan !== 'free'`)
* **Plan boundary**: free vs paid
* **What**: hardcoded `plan === 'free'` для гейта catalyst. Семантически = `entitlements.catalyst === 0`, но couples к «free — единственный с catalyst=0». Если в будущем добавится `trial` plan с `catalyst: 0` — trigger button покажет active label, callback fall through to daily-cap path с 0-cap entitlement, gate `if (ent.catalyst > 0)` skip'ает (0 не > 0), и запрос пройдёт unbounded.
* **Repro**: hypothetical новый plan tier с catalyst=0. Сейчас не воспроизводится.
* **Impact**: latent drift. Defense-in-depth gap. Dashboard mirror (`server.js:1645` использует `ent.catalyst === 0`) — правильно. TG bot — нет.
* **Fix**: заменить `user.plan_name === 'free'` (line 634) и `plan !== 'free'` (line 1443) на `getPlanEntitlements(...).catalyst === 0 / > 0` соответственно.

---

### [BILL-010] Admin revoke сжигает оставшиеся subscription дни без save — severity: **low**

* **Where**: `src/admin/server.js:716-723`
* **Plan boundary**: pro→free через revoke
* **What**: revoke ставит `subscription_expires_at = NULL` без save оставшихся дней. User купил pro за $100, на 5-м дне admin revoke'нул (например по нарушению TOS) → 25 дней пропадают. Если revoke accidental — невозможно undo (без audit log из BILL-002).
* **Repro**: admin случайно кликает revoke в UsersPage drawer.
* **Impact**: если revoke = punitive — OK. Если accidental — потеря денег пользователя + операционная боль.
* **Fix**: сохранить старое `subscription_expires_at` в отдельную колонку `revoked_remaining_until` для возможного refund/restore. Плюс confirmation modal с показом «остаётся X дней».

---

### [BILL-011] Double-activation trial — DB позволяет test поверх pro — severity: **low**

* **Where**: `src/notifications/telegram.js:561-575` + `src/billing/solana-pay.js:64` + `confirmPaymentAndUpgrade`
* **Plan boundary**: pro→test (странный path)
* **What**: `confirmPaymentAndUpgrade` использует транзакцию + `hasConfirmedPlanPayment(user.id, 'test')` блок (one-time для test). Но: если у user'а active pro, он может купить test → expires_at просто перезаписывается, plan_name=test. Pro теряется. Это corner case — никто рационально так не сделает, но DB не блокирует.
* **Repro**: user с pro подпиской выбирает `buy_plan:test` → платит $5 USDC → плата принимается → plan_name='test', remaining pro дни обнуляются.
* **Impact**: user сам себя downgrade'ит за деньги. Low likelihood + low damage, но UX gap.
* **Fix**: в `buy_plan:test` callback проверять `if user.plan_name === 'pro' && !expired` → reject «У тебя уже Pro, test это пробный план».

---

### [BILL-012] `_publicUser` возвращает entitlements object целиком — info

* **Where**: `src/dashboard/server.js:901`
* **What**: `entitlements: getPlanEntitlements(...)` — без field stripping. Сейчас все поля not sensitive (sources, caps, historyHours, favorites). Но если в будущем добавится `internalCostBudget` или `experimentalFeatures: [...]` — auto-leak.
* **Fix**: optional — заменить на explicit literal `{ sources, manualAnalyze, catalyst, xAnalysis, historyHours, favorites }` в call-site.

---

### [BILL-013] Dead code `me?.plan_name === 'admin'` на client — info

* **Where**: `src/dashboard/server.js:10378, 10936`
* **What**: client использует `me.plan === 'admin' || me.plan_name === 'admin'` для admin UI (Alert verdict panel etc). Сервер шлёт только `plan`, не `plan_name`. Branch `me?.plan_name === 'admin'` — dead. Harmless, но noise.
* **Fix**: drop `|| me?.plan_name === 'admin'` на обеих линиях.

---

### [BILL-014] Multi-account factory — N free TG аккаунтов = N×72h history + N×alert subs — info

* **Where**: arch-level. `users` table UNIQUE(chat_id), нет связки между chat_id и реальной личностью (TG-аккаунты дешёвые).
* **What**: один человек создаёт N TG-аккаунтов → каждый получает free + reddit/google_trends alerts + 72h history. Aggregated cost для нас: collectors не зависят от user count, но alerts × N → TG API rate-limit + push delivery cost.
* **Impact**: low-grade DoS на infrastructure, не billing attack (free everywhere). Связано с SEC-003 (TRUST_PROXY shared cap → нельзя per-IP throttle создание аккаунтов).
* **Fix**: long-term — TG bot phone-number verification (если TG API позволяет), или friction в onboarding (CAPTCHA, email confirmation). Не сейчас.

---

### [BILL-015] Catalyst trigger 15-min cooldown упомянут в spec, снят в коде — info

* **Where**: SESSION_CONTEXT § Catalyst forecast («Per-user 15min cooldown (admin bypass)») vs `src/notifications/telegram.js:1847-1848` («Replaces the old 15-min cooldown — Catalyst is cheap (~$0.05/call), so daily caps are enough»).
* **What**: spec drift — overlap с PIPE-018. Уже отмечено в pipeline audit, ре-флагирую с billing angle. Сейчас только daily cap (5/100/unlim).
* **Fix**: обновить SESSION_CONTEXT § Catalyst forecast при final sync pass.

---

## Verified safe

Прошло проверку, **в следующих чекапах не пересматривать**:

### Entitlements consistency
* ✓ `getPlanEntitlements` — единственный gate для всех hot paths: dashboard manualAnalyze (`:1937-1940`), catalyst (`:1640-1646`), favorites (`:1775`), sources feed/stats/sources-endpoint (`:1184, 1242, 1292`), historyHours (`:1094, 1235`), TG bot manualAnalyze (`:304, 1132`), xAnalysis (`:602, 1546, 1660`), catalyst (`:1849`), sources keyboard (`:439, 889`), button builder (`:1436`).
* ✓ `shouldShowUsageCounter` — consistent: только `'test'` показывает counter в dashboard (`:1689, 2049`) и TG bot (`:1213, 1925`).
* ✓ Paranoid default `getPlanEntitlements(unknownPlan) → free` — verified, applies к undefined/null/'super_pro'/typo.
* ✓ `users.plan_id` schema default = 1 (free), INNER JOIN с plans → `plan_name` всегда populated. Null impossible from DB shape.
* ✓ admin/server.js использует plan_name **только** для UI badge + role display (admin route gate через X-Admin-Key, не plan).
* ✓ support/bot.js — plan-agnostic by design (любой user может open ticket).

### Locked sources backend
* ✓ `/api/trends`: free `?source=twitter` запрос — backend добавляет `WHERE source IN ('reddit', 'google_trends') AND source = 'twitter'` → empty intersection. Defense-in-depth works.
* ✓ `/api/stats`: `bySource` aggregation через `planClause` — free видит counts только для allowed.
* ✓ `/api/sources`: возвращает ВСЕ 5 sources с `inPlan: bool` per source (frontend может render 🔒).
* ✓ Alert-dispatcher `plan_source` gate (`alert-dispatcher.js:330`) — free не получает twitter/tiktok/x_trends в TG (с caveat BILL-004/005 про SoT drift).
* ✓ Sidebar source counters берут data из `/api/stats` который plan-filtered.

### Locked features paywall
* ✓ `/api/favorites` (все 4 endpoint'а — GET, POST/DELETE/PATCH на `/api/trends/:id/favorite`): `_favoriteGate` проверяет `entitlements.favorites === true`. Free/Test → 403 reason='plan'.
* ✓ `/api/manual-analysis`: plan-check (cap === 0 → 403) **до** `peekManualAnalysisCache` → free не может получить cached результат через bypass.
* ✓ Catalyst forecast: plan-check (`ent.catalyst > 0`) до Grok call. In-flight claim race protection через `trigger_in_flight`. Cache cross-user через DB `trigger_*` columns — но access gated по plan.
* ✓ Threshold slider — не paywall'ом gated by design (любой plan может выкрутить 0-100). Backend `POST /api/user/threshold` не clamp'ит по plan.
* ✓ `/api/auth/avatar` — auth-only (читает `req.user.avatar_file_id`), не IDOR (нет URL-параметра chat_id).

### Per-plan caps + counter
* ✓ Все 3 cap'а (manualAnalyze / catalyst / xAnalysis) проверяются **до** LLM-call (cost protection).
* ✓ Rolling 24h window — `hits.filter(t => now - t < dayMs)`, fair (не UTC midnight reset с arbitrage at midnight).
* ✓ Cache-hit не consume slot — `peekManualAnalysisCache` non-mutating, slot не decrement'тся.
* ✓ `historyHours` cap enforce'тся backend — `Math.min(requestedHours, planHistoryHours)` в `_handleTrends`/`_handleStats`.
* ✓ Alerts unlimited (нет per-plan broadcast cap) — соответствует SESSION_CONTEXT «alerts не платная фича».

### Plan change lifecycle
* ✓ Plan читается **fresh из DB каждый request** через `getUserByAuthToken` → `getUserByChatId` → JOIN plans. Нет in-memory user-state cache. Admin grant работает мгновенно (для следующего request).
* ✓ In-flight request semantics: `req.user` snapshot'ится в `_resolveUser`, весь полёт на старых правах. Race-condition impact — minimal.
* ✓ Payment confirmation атомарна (`confirmPaymentAndUpgrade` в `db.transaction`).
* ✓ Test plan one-time через `hasConfirmedPlanPayment(user.id, 'test')` — double-claim защищён (см. BILL-011 caveat про cross-plan).
* ✓ Solana Pay tx_signature uniqueness в payments table — двойной credit невозможен.
* ✓ Favorites не cascade'тся при downgrade — re-upgrade восстанавливает данные.
* ✓ Pro→Test downgrade с уже потраченным cap=30 — корректно 403 на следующий call (cap=5, hits.length=30 → reject).

### Admin gate billing-specific
* ✓ Plan grant/revoke endpoints за `_auth(req)` (X-Admin-Key timing-safe check). Verified в SEC audit 2026-05-22.
* ✓ Frontend dropdown plan validation — hardcoded enum `['free','test','pro','admin']`.
* ✓ Backend `_setUserPlan` делает SELECT → throws `Plan not found` если name invalid → 500. DB CHECK не нужен (FK на plans table).
* ✓ Self-revoke admin не ломает admin доступ — auth через X-Admin-Key, не plan_name.
* ✓ `users.plan_id` имеет FK на `plans(id)` — invalid plan_id невозможен через normal API path.

### TG bot
* ✓ Plan читается fresh на каждый message/callback через `getOrCreateUser` SELECT.
* ✓ `/menu` рендерит keyboard plan-aware (locked icon для free на twitter/tiktok/x_trends).
* ✓ Defense-in-depth: keyboard filter + server-side callback double-check (source_locked: callback).
* ✓ `/analyze`: plan check (cap=0 → silent return для free), Test/Pro hit-counter, Admin bypass.
* ✓ `/forecast` (catalyst trigger): plan check + daily cap.
* ✓ xAnalysis button: plan check (xAnalysis=0 → reject), Test cap=10/day, Pro/Admin -1.
* ✓ Нет admin commands в telegram.js (admin functions через dashboard / direct DB).
* ✓ Support bot plan-agnostic by design.

### i18n + UX
* ✓ Все upgrade/paywall ключи в EN+RU (`upgrade.*`, `paywall.*`, `lock.*`, `plan.*`, `analyze.locked*`, `trigger.locked*`, `window.locked*`, `source.locked*`, `fav.locked*`).
* ✓ Lock icon — везде `icon('lock')` SVG (после R4 sweep), не emoji 🔒.
* ✓ Locked-card / upgrade-toast wording consistent через shared i18n keys.
* ✓ Threshold slider не plan-gated (любой может).
* ✓ Account hero plan label через `planLabels` mapping + fallback на `'—'` (защита от raw 'super_pro' typo).
* ✓ Login screen feature list (EN-only по контракту) актуален — не обещает Stats (удалён 06.05), упоминает то что реально работает.

### Edge cases
* ✓ Token не кэширует plan (Bearer hex, не JWT — нет plan claims).
* ✓ Auth rate-limit на `/api/auth/initiate` (10/5min per-IP, в caveat SEC-003) и `/api/auth/verify` (5/15min per-sessionId).
* ✓ `/api/auth/avatar` IDOR-safe — `req.user` из authenticated context, URL param `?k=` только cache-busting.
* ✓ Alerts unlimited (нет per-plan broadcast cap) — SESSION_CONTEXT § Бизнес-правила консистентно.

---

## Spec drift

Места где SESSION_CONTEXT расходится с реальным кодом по billing — для финального sync-pass'а после 12 этапов:

* **SD-1**: SESSION_CONTEXT § Бизнес-правила (line 36-49) — таблица не упоминает поле `xAnalysis` (free=0, test=10, pro/admin=-1). В `entitlements.js` оно есть с подробным комментарием. Добавить колонку в spec таблицу.
* **SD-2**: SESSION_CONTEXT § Бизнес-правила не упоминает `historyHours: 72` для free. Это плановое ограничение, должно быть в spec таблице.
* **SD-3**: SESSION_CONTEXT § Бизнес-правила говорит «admin: бессрочно» но не указывает явно что `favorites: true` для pro/admin (упомянуто в § User favourites § 411, но не в основной table).
* **SD-4**: SESSION_CONTEXT § Catalyst forecast («Per-user 15min cooldown (admin bypass)») — снят в коде, остался в spec. Already flagged как PIPE-018, retain for sync-pass.
* **SD-5**: SESSION_CONTEXT § Manual analysis говорит «cap TTL 1h» (cross-user URL cache). В коде `manual-analysis.js` TTL = 6h (WORKLOG 2026-05-17 bump). Минор drift.

---

## Cross-audit overlap

* **BILL-003** ↔ **SEC-001** ↔ **PIPE-004** — все три про `/api/scan` без admin gate. **Одна правка** (add `req.user?.plan_name === 'admin'` check + immediate `lastScanCompletedAt` write) закроет:
  - SEC-001 (privilege escalation angle)
  - PIPE-004 (timestamp race / scheduler jitter)
  - BILL-003 (cost-burn dimension)
  **Высший приоритет среди cross-audit overlaps.**

* **BILL-002** (no plan_change audit log) ↔ операционные observations в всех 3 этапах — нет audit infrastructure в проекте вообще. Если будут вводить — общая `audit_log(actor, action, target, meta_json, ts)` table покроет grant/revoke + future admin actions.

* **BILL-014** (multi-account factory) ↔ **SEC-003** (`TRUST_PROXY=1` не работает → IP rate-limit shared per nginx) — обе про anti-abuse. SEC-003 fix (real-IP в rate-limit) не достаточно для blocking N free TG аккаунтов от одного человека (он может реально иметь N разных IP/устройств). Требует другого подхода (phone verification / friction в onboarding).

* **BILL-007** (in-memory caps reset on restart) ↔ **PIPE-016** (decisions buffer in-memory reset on restart) — оба паттерна «critical state in-memory». Если будем persist'ить decisions buffer в DB (PIPE-016 fix), общая infrastructure для feature_usage_log + alert_decisions_log была бы экономичной.

---

## Out of scope / followups

* **(этап 4, cost throttling)** — BILL-007 (in-memory cap restart-reset) — это и про state persistence, и про cost-control. Per-feature counter table + retention policy — этап 4/5.
* **(этап 5, DB health)** — таблицы `plan_change_log`, `feature_usage_log`, опционально `alert_decisions_log` — migration + retention strategies + indexes.
* **(этап 7, admin UI)** — UsersPage drawer: confirmation modal на revoke (показать «остаётся X дней — точно revoke?»), grant form: показать «текущий план: pro, истекает через Y дней — заменить?». Сейчас confirm есть только на revoke (`window.confirm`).
* **(operational)** — выйти на полный sync-pass SESSION_CONTEXT после 12 этапов (SD-1 .. SD-5 + предыдущие PIPE-017/018 + SEC-003).
* **(observation, payment flow)** — `confirmPaymentAndUpgrade` использует транзакцию + tx_signature uniqueness — корректно. Но webhook delivery semantics (Helius / direct RPC poll) — отдельная тема для cost/reliability в этапе 4.
* **(observation, UX)** — buy_plan UI поток сейчас не предупреждает о cross-plan downgrade (BILL-011) и pro renewal (BILL-008). Объединить в одну «pre-purchase summary» страницу с текущим планом + остающимся временем + impact preview.

---

**Audit complete.** Жду решения какие finding'и фиксить первыми.
