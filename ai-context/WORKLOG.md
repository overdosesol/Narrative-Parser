# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 без архивации. Полная история — в git.

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
