# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 без архивации. Полная история — в git.

---

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

