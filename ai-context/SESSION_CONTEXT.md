# SESSION CONTEXT

State-spec проекта Catalyst — описывает **текущее состояние**, не историю.
Дата-помеченные секции (`### X (YYYY-MM-DD)`) запрещены — это материал
для `WORKLOG.md` (правило `AGENT_RULES.md §7`).

---

## Проект

**Catalyst** — мониторинг трендов + AI-скоринг + алерты в Telegram/Discord.

- Прод: Docker. Deploy: `deploy.ps1` (Windows) / `deploy.sh` (Linux/macOS)
- Dashboard: `http://37.1.196.83:8080` (юзеры через `X-API-Key`)
- Admin: `127.0.0.1:8081` (localhost-only через SSH tunnel, `X-Admin-Key`)
- API auth-by-query (`?apiKey=`, `?key=`) — отключён, только header

## Бизнес-правила

| План | Цена | Длительность | Источники | Особенности |
|---|---|---|---|---|
| `free` | $0 | бессрочно | Reddit + Google Trends | history_days=3 |
| `test` | $5 | 1 день, one-time на аккаунт | все | без X Analysis |
| `pro` | $100 | 30 дней | все | api_access=1, X Analysis |
| `admin` | $0 | бессрочно | все | alert_limit=-1 (∞), api_access=1 |

- `alert_limit = -1` → безлимит. `history_days = -1` → не применяется в query.
- Поля «Дней» и «Алертов/день» в админке поддерживают чекбокс ∞ (= -1).
- В Telegram-меню Free отображается с описанием (RU/EN).

## Pipeline

```
collect → cheapDedup → PreStage → Cluster → Stage 1 → Stage 2 → Save → Alerts
```

- **collect** — Apify-коллекторы (Reddit, Twitter, TikTok, Google Trends, X Trends)
- **cheapDedup** (`clusterer.cheapDedup`) — zero-API схлопывание exact-text/url дублей
- **PreStage** (`pre-stage.js`) — nano + Gemini обогащают `trend.preStage` метаданными. Никогда не фильтрует/скорит. Failures degrade silently.
- **Cluster** (`clusterer.js`) — multi-signal similarity (см. § Multi-signal clustering)
- **Stage 1** — AI scoring через Responses API (OpenAI или xAI)
- **Stage 2** — Grok x_search для top-кандидатов (deep narrative verification)
- **Save → Alerts** — запись в БД + alert-loop с per-user gate

## Per-preset pipeline configs

5 пресетов: `general / animals / culture / celebrities / events`.

**Storage**: `settings.presetConfigs` JSON blob — sparse (только overrides от defaults).

**Single source of truth**: `src/analysis/preset-config.js`
- `DEFAULT_PRESET_CONFIGS`, `PRESET_GROUPS`, `PRESET_FIELD_RANGES`
- `resolvePresetConfig(preset, overrides)` — deep merge defaults + patch
- `getActivePresetConfig(db)` — one-stop reader для всех consumers
- `validatePresetOverrides(input)` — strict range-check + Σ POSITIVE ≤ 1.0

**Структура blob** (per preset):
```
sources: { reddit, twitter, tiktok, xtrends, googletrends }
junk:    { politicsPenalty, kpopPenalty, celebNoisePenalty, noMemeShapePenalty,
           safeOverrideDivisor, memeShapeBoost }
alerts:  { thresholds: { alertThreshold, minScoreToSave, maxAlertsPerCycle, alertHardJunkStop },
           weights:    { weightMemePotential, weightVirality, weightEmergence,
                         weightTwitter, weightFeedback, weightJunk },
           stale:      { staleDecayPerHour, staleDecayGraceHours, staleDecayCap } }
cluster: { simThreshold, timePenaltyHours, weightEmbedding, weightPhash,
           weightEntity, weightTicker }
```

**Σ POSITIVE invariant** (server-side в `validatePresetOverrides`):
- `alerts.weights`: meme + viral + emergence + twitter + feedback ≤ 1.0
- `cluster`: weightEmbedding + weightPhash + weightEntity + weightTicker ≤ 1.0
- Все 5 defaults Σ = 1.00

**Per-preset divergence**:

| Aspect | general | animals | culture | celebrities | events |
|---|---|---|---|---|---|
| alertThreshold | 60 | 55 | 65 | 70 | 50 |
| maxAlertsPerCycle | 0 (∞) | 5 | 8 | 6 | 10 |
| alertHardJunkStop | 70 | 65 | 75 | 65 | 85 |
| weightMemePotential | 0.30 | **0.45** | **0.45** | 0.25 | 0.10 |
| weightEmergence | 0.25 | 0.10 | 0.10 | 0.20 | **0.35** |
| weightVirality | 0.25 | 0.20 | 0.25 | **0.30** | **0.30** |
| weightJunk | 0.50 | 0.40 | 0.50 | **0.55** | **0.30** |
| staleDecayPerHour | 2 | **1** | 3 | 3 | **5** |
| staleDecayGraceHours | 24 | **48** | 12 | 12 | **6** |
| staleDecayCap | 30 | 20 | 40 | 40 | **60** |
| cluster.simThreshold | 0.55 | 0.55 | **0.50** | 0.55 | **0.45** |
| cluster.timePenaltyHours | 24 | **48** | 12 | 24 | **6** |

**Consumers** (все читают через `getActivePresetConfig(db)`):
- `scorer.js` `loadAlertWeights(db)` → alerts.weights / .stale / .thresholds.alertHardJunkStop
- `clusterer.js` `_refreshClusterParams()` → cluster.*; junk через `{ [activePreset]: cfg.junk }`
- `collectors/{reddit,twitter,tiktok,x-trends}.js` → sources.* per platform
- `index.js` alert-loop → alerts.thresholds.* (alertThreshold floor, maxAlertsPerCycle, minScoreToSave)

**Endpoints** (admin only, `X-Admin-Key` gate):
- `GET /api/preset-configs` → `{ defaults, effective, overrides, fieldRanges, presets, groups }`
- `POST /api/preset-configs { overrides }` — валидация + commit

**Migration marker**: `presetConfigsMigratedV1` — one-shot фолд legacy global settings во все 5 пресетов. Legacy ключи **не удалены** (fallback safety).

## Alert gate

Формула:
```
alertScore = w_meme·memePotential
           + w_viral·virality
           + w_emerg·emergence
           + w_x·twitterScore
           + w_fb·feedbackBoost
           − w_junk·junkPenalty
           − staleDecay
```

- POSITIVE веса в сумме ≤ 1.0 → скор остаётся 0-100
- Per-preset через `loadAlertWeights(db)` (читает `getActivePresetConfig(db).alerts`)
- **feedbackBoost** (0-100, 50 = нейтрально) считается из live `feedback_votes` на момент gate-loop. <5 голосов → pull towards 50
- **staleDecay** = `perHour * max(0, ageHours - grace)`, capped at `cap` (per-preset)

**Gate condition**:
```
alertScore >= max(user.alert_threshold, preset.alerts.thresholds.alertThreshold)
AND junkPenalty < preset.alerts.thresholds.alertHardJunkStop
```

**Decision logging**: ring buffer `appState.alertDecisions[]` (cap 500, in-memory, reset на рестарте). Gate-loop пишет массив `gates[{ name, passed, detail }]` для observability в admin DecisionsPage.

## AI provider config

Stage 1 provider/model — runtime-tunable из админки (вкладка «Бот» → AI Pipeline).

**Default**: `gpt-5.4-mini` (OpenAI), reasoning_effort=low.

- xAI curated: `grok-4-1-fast-non-reasoning`, `grok-4-fast-non-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-3-mini`
- OpenAI curated: `gpt-4.1-mini`, `gpt-4.1`, `gpt-4o-mini`, `gpt-4o`, `gpt-5-mini`, `gpt-5`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4`

**Stage 1 features (OpenAI only)**:
- **Structured Outputs** через `STAGE1_RESPONSE_SCHEMA` (`prompts.js`) → гарантирует shape `{trends:[...]}`. xAI fallback: `parsed.trends || parsed.results`.
- **Reasoning effort** через `OPENAI_REASONING_EFFORT` env. Не-reasoning модели авто-ретраятся без `reasoning` через 400-error path (зеркало existing temperature-retry).

**Stage 2** всегда через Grok (xAI, `grok-4-1-fast-non-reasoning`).

**Stage 1 calibration examples**: таблица `stage1_examples` (kind/title/category/meme_potential/rationale/enabled). Admin UI «🎓 AI Examples» — CRUD + preview промпта + cost-budget. Применяется на следующем цикле без рестарта.

## Stage 0 / PreStage

Обогащает каждый трейнд machine-generated метаданными ПЕРЕД scoring'ом. **Никогда не фильтрует, не скорит, не дропает.** Failures → `trend.preStage = null` (Stage 1 видит то же что без PreStage).

**Sub-stages** (parallel via `Promise.all`):
- **Nano** (`gpt-5.4-nano` через OPENAI_API_KEY) — text-only enrichment. Output: `topicSummary`, `entityCanonical[]`, `language`, `slangDecoded`. Inputs: title + description (cap 600) + r/sub + #hashtag + by @author + RelatedPosts (sibling titles из cluster, top 5 by engagement).
- **Gemini Captioner** — visual enrichment с failover-архитектурой:
  - **Primary**: Google AI Studio (`generativelanguage.googleapis.com`) — native video через `inlineData` base64. Гео-restricted.
  - **Fallback**: OpenRouter `gemini-2.5-flash` (image-only; для видео всегда poster).
  - **Cooldown circuit**: 3 неудачи Google подряд → 5 мин принудительно через OpenRouter.

**Видео policy**: `ffprobe` замеряет длительность. ≤ `STAGE0_VIDEO_MAX_SEC` (60 default) → Google native video (download → base64). Длиннее → poster через failover.

**Kill-switches** (nano):
- `STAGE0_NANO_ENABLED=0` env — panic switch (force-disable, читается в constructor)
- DB setting `nanoEnabled` — admin runtime toggle (no restart, читается на каждый batch)

**Persistence**: `trend.preStage` сохраняется в `raw_metrics.preStage`. Re-просмотр в админке не платит дважды.

**Стоимость**: ~$50-70/мес при ~30 трейндов/цикл, 720 циклов/день. OpenRouter <5% при стабильном Google.

## Stage 2 cost knobs

- `XAI_STAGE2_MAX_RESULTS=5` — max sources per x_search (главный рычаг, $5/1000 sources)
- `XAI_STAGE2_MAX_TOOL_CALLS=2` — Grok не может делать >2 последовательных x_search в одном ответе
- `XAI_STAGE2_LOOKBACK_HOURS=48` — `from_date` window
- `stage2MaxCalls=3` (DB-tunable) — cap вызовов на цикл
- `stage2Threshold=60` — gate для входа в Stage 2 (memePotential ≥ X)
- Skip `google_trends` + novelty gate (`clusterMetrics.isNovel !== false`)
- Stage 1 `explanation` JSON schema `maxLength: 220` (strict-enforced)

**Текущая стоимость**: ~$153/мес (1 call/cycle × 96 cycles/day × 5.3¢).

**x_search billing**: `$5 per 1000 sources, NOT per call`. `max_results=5 × max_tool_calls=2 = 10 sources × $0.005 = $0.05` на Stage 2 + Grok токены ~$0.003 = ~5.3¢ на вызов.

**Subject-name + story bonuses** (Stage 2 output): `subjectName` + `nameStrength` (если ≥60 → бонус до +10), `storyScore` (если ≥60 → до +15). Применяются с **soft-cap по headroom**: `bonus * (100 - oldMeme) / 50`. Эффект — meme=85+15→90 вместо 100, meme=95+15→96. До 100 теперь доходит только то, что Stage 1 уже поставила ~98+. Штрафы отдельно (multiplicative `penaltyMult` по buzz/momentum/organicity, без soft-cap'а — чистое умножение).

**Stage 1 rubric philosophy**: вилка `memePotential` намеренно консервативная — 95-100 зарезервированы для трендов с одновременно name + visual + ticker hook + cultural pull (типа «раз в день-два»). Большинство «good» трендов попадают в 60-79. Calibration-инструкция в SYSTEM_PROMPT запрещает раздавать 90+ нескольким трендам в одном батче.

## Multi-signal clustering

4-signal weighted similarity вместо чистого Jaccard. Веса/пороги в DB (per-preset через `cluster.*`).

**Сигналы и веса** (defaults):
- `clusterWeightEmbedding=0.40` — `text-embedding-3-small` cosine (1536-dim, L2-normalised). 0.5..1.0 squashed в 0..1.
- `clusterWeightPhash=0.30` — dHash thumbnails (sharp resize 9×8 grayscale → 64-bit BigInt). Hamming < 16 = soft match.
- `clusterWeightEntity=0.20` — `entityCanonical[]` overlap (требует nano). Cross-language буст «Илон Маск» = «Elon Musk».
- `clusterWeightTicker=0.10` — shared `$TICKER` regex `\$[A-Z]{2,10}\b`. Разные тикеры → ×0.85 на final score.
- `clusterTimePenaltyHours=24` — линейный damp 1.0 → 0.7 если items >24h apart
- `clusterSimThreshold=0.55`

**Renormalisation**: если сигнал null (нет картинки / nano выкл / API лёг) — вес перераспределяется по остальным.

**Защитные сетки**:
- `CLUSTER_MULTI_SIGNAL=0` env → panic switch к Jaccard
- Если ВСЕ сигналы null → автоматический fallback на Jaccard. Лог `strategy=multi-signal|jaccard-fallback`
- Embeddings + hash оба NEVER throw

**Стоимость**: <$1/мес добавки.

## Scoring metadata

Поля trend object'а после full pipeline:

- **memePotential** (0-100) — AI-driven, мемность нарратива (alias `adoptionScore`)
- **virality** (0-100) — AI-driven
- **emergenceScore** (0-100) — `max(spread, breakout) + ideaBoost`. Spread = platforms+velocity+organicSpread+noveltyStage+authorDiversity; breakout = single-post виральность с damping по followers; ideaBoost = Reddit upvote bonus (>=10k→+5, >=15k→+8, >=30k→+10, >=60k→+12)
- **rankScore** = `e*0.4 + a*0.6` ± feedback bias (default sort в дашборде)
- **narrativePhase** = `early / forming / strong / saturated`. Saturated = adoption≥60 && emergence<25.
- **isEarlyIdea** flag = `emergence 20-50 && upvotes >= 10k`
- **alertType** ∈ `event / trend / post` (см. § Alert types)
- **whyNow** — конкретный триггер события **в прошлом** (что зажгло), 1-2 предложения cap 280 chars (расширен с «one short sentence» 2026-05-03 — теперь несёт WHO+WHAT+timing). Может быть пустой. Используется как сигнал для классификации `alertType=event` + рендерится отдельной секцией «🔥 Триггер» в TrendModal дашборда. Фактоид-якорь.
- **trigger.*** (deep, on-demand) — **forward-looking прогноз катализатора роста** (см. § Catalyst forecast). Заполняется по клику Pro/Admin, шарится между юзерами через DB-cache.

## JunkFilter

`src/analysis/junk-filter.js`. Изолированный слой + positive-signal boost.

**Penalties** (per-preset):
- politics: +40
- kpop/fandom: +30
- celeb-noise: +20
- no-meme-shape: +15

**Safe-signal override**: animal/absurd/meme/heartwarming → делим raw на 3 (или 4 при ≥2 сигналах). Срабатывает только если `raw > 0`.

**Meme-shape boost** (per-preset additive bonus к `emergenceScore`):
- general 10, animals 14, culture 12, celebrities 6, events 4
- Формула: `perSignalBoost * (signalCount >= 2 ? 1.5 : 1)`
- Применяется в clusterer до routing

**Hard stop**: `junkPenalty >= alertHardJunkStop` (per-preset, 70 default для general) → skip alert.

**Observability**: JunkStatsSection в админке + `GET /api/junk-stats?hours=N`.

## MarketStage (opt-in)

Feature flag `MARKET_STAGE_DETECTION=1`. 4 состояния: `none / tokenizing / live / overheated`. Вся логика в `src/analysis/market-stage.js`. Call sites помечены `[MARKET_STAGE]`. **По умолчанию выключено.**

## Apify scrapers

**Twitter actor registry** (runtime-switchable через админку):
- `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` — **default** ($0.25/1K, 17K users, 99%+ success)
- `xquik/x-tweet-scraper` — alt ($0.15/1K, экспериментальный)

DB setting `twitterActor` читается в `_activeActor()` collector'а на каждом запросе. Также для `twitter-check.js`.

Per-actor tokens: `APIFY_API_KAITO`, `APIFY_API_XQUIK`. Generic: `APIFY_API`.

`buildInput(query, maxItems)` actor-agnostic — Kaito принимает `twitterContent: <string>`, xquik — `searchTerms: [<string>]`. Output идентичный.

**X Trends collector** (5-я платформа, source-id `x_trends`):
- Apify actor: `karamelo~twitter-trends-scraper` ($0.29/1K)
- Country: hardcoded `United States` (English priority)
- Internal refresh timer (default 30 мин, `X_TRENDS_REFRESH_MINUTES` env) — decoupled от scanner cycle (~90 сек)
- In-memory cache + dedup Map (TTL 6h, re-emit if absent) → `collect()` возвращает diff
- Hourly externalId bucketing (`xtrends-us-<slug>-<YYYYMMDDHH>`) для DB-dedup

Per-preset `sources.xtrends` config: `{ enabled, topN }`. Defaults: general=20, animals=10, culture=25, celebrities=25, events=30.

**CJK threshold multiplier** (`_normalize` в `twitter.js` + `tiktok.js`):

| Письменность | Twitter views/likes | TikTok plays/likes/shares/viralScore |
|---|---|---|
| Default (EN/RU/Romance/AR/...) | 500K / 10K | 50K / 1K / 200 / 40 |
| Japanese (`ja`), Korean (`ko`) | 1M / 20K (×2) | 100K / 2K / 400 / 50 |
| Chinese (`zh`) | 2M / 40K (×4) | 200K / 4K / 800 / 60 |

`_detectCjkScript(text)` — kana → 'ja', hangul → 'ko', Han без них → 'zh', null иначе. Требует ≥30% CJK-доли.

## Source-aware engagement labels

В `formatter.js` (Telegram alerts):
- Twitter → ❤️ Likes
- TikTok → ▶️ Plays
- Reddit/other → 📈 Upvotes

i18n keys: `alertLikes`, `alertPlays`, `alertGoogleHits` (EN + RU).

## Feedback (взвешенный)

Только 👍/👎 обрабатываются. Остальные реакции игнорируются.

**Storage**: `feedback_votes` таблица — `UNIQUE(trend_id, chat_id)`. Поля: `vote (+1/-1)`, `weight`, `plan_name`, `reason TEXT NULL`.

**Веса по плану** (admin ×25 vs free):
- `feedbackWeightAdmin=5`
- `feedbackWeightPro=2.5`
- `feedbackWeightTest=0.5`
- `feedbackWeightFree=0.2`

**Toggle**: `feedbackWeightingEnabled` (BotPage). Выключено → учитываются ТОЛЬКО голоса admin (weight=1), остальные weight=0.

**Reason wizard** (Telegram): после голоса в keyboard'е алерта появляется ряд `✏️ Причина оценки`. Клик → ждём не-командный текст (cap 240 chars, 5-min timeout). `/skip` отменяет. Reason обнуляется при смене направления голоса.

**AI prompt injection**: `_buildFeedbackContext` рендерит `+ "Title" [category] — "reason"` (cap 120/item). Только голоса с `weight >= 0.5` ИЛИ непустым reason попадают в промпт.

**Recalculation**: `trends.user_feedback = ROUND(SUM(vote * weight))` после каждого голоса.

## Manual analysis

Pro/Admin only. Доступно из 3 surfaces:

1. **Admin** — вкладка «🧪 Ручной анализ» (SubmitPage): URL → синтетический trend → полный scorer (Stage 1 batch + Stage 2 Grok x_search) → опциональная рассылка всем активным TG-юзерам. `save:true` (попадает в feed).
2. **Dashboard** — bottom-nav «🧪 Анализ» (только pro/admin) → Sheet с AnalyzePanel. `save:false` — приватно, не пишет в `trends`. Rate limit: 30s между, 20/24h, admin bypass.
3. **Telegram** — `/analyze <url>` команда + bare-URL auto-detection в `bot.on('message')` (только pro/admin, остальные silent ignore). Same rate limit. Не записывает в `notifications`, не инкрементит `alert_count`.

**Архитектура**: `src/analysis/{url-resolver,manual-analysis}.js`.
- `resolveUrlToTrend(url)` — Twitter/Reddit/TikTok/og:image generic
- `runManualAnalysis({ scorer, db, url, save, logger, actorId })` — единый оркестратор для всех 3 surfaces

**Cross-user URL cache**: module-level Map с TTL 1h. Если pro-юзер A проанализировал URL, юзер B по тому же URL получает кэш мгновенно бесплатно. Cache key — lowercase URL без trailing-slash (query сохранён). Wiped on restart. Lazy save: `save:true` после `save:false` выполняет только DB-запись без re-run scorer.

`peekManualAnalysisCache(url)` — non-mutating helper, dashboard и TG handler'ы peek перед rate-limit, на cache hit пропускают rate-limit.

## Hot trends refresh loop

`src/refresh/hot-metrics.js` — фоновый цикл, который **раз в 2 часа** (env `HOT_REFRESH_INTERVAL_MINUTES`, default 120) пере-фетчит свежие метрики живых трендов из источника и заново прогоняет их через скоринг. Цель — дать «дозреть» бордерлайн-трендам, которые на момент первого скоринга были чуть ниже Stage 2 порога, но потом набрали виральность.

**Eligibility**:
- `first_seen_at` ≤ 24h назад
- `memePotential` ≥ 50
- `source ∈ {reddit, twitter}` (TikTok пока out — требует Apify)
- `url IS NOT NULL`
- Cap 100 трендов на цикл, sort по `first_seen_at DESC`

**Refresh metrics — БЕСПЛАТНО**:
- Twitter: `resolveTwitterUrl()` через `api.fxtwitter.com/i/status/<id>`
- Reddit: `resolveRedditUrl()` через `<permalink>.json`
- Concurrency=5 worker pool, политично к источникам

**Re-score**:
- `scorer.scoreTrends(refreshed)` — Stage 1 batch + Stage 2 (с x_search для прошедших порог)
- Stage 2 cap (`stage2MaxCalls`) общий с обычными циклами сбора
- preStage carry-through из original trend → не платим повторно за nano/gemini
- Identity (externalId, title) сохраняется → `saveTrend` UPSERT'ит ту же row

**Дозревший тренд → новый алерт**:
Если после re-score `alertScore` пробил порог, а тренд НЕ был alerted раньше — обычный alert-loop в `index.js` подхватит на следующем проходе. Никаких новых code path для уведомлений в refresh-loop нет.

**Toggles**:
- env `HOT_REFRESH_ENABLED=0` — panic kill (рестарт нужен)
- DB setting `hotRefreshEnabled` — admin runtime toggle (читается на каждом cycle entry, no restart). Default ON
- Admin UI: вкладка «⚙️ Сканеры» → секция «🔁 Обновление горячих трендов»

**Re-entrancy guard**: `running` flag — если предыдущий цикл ещё идёт, новый skip'ается с warning.

**Стоимость**: ~$3/мес (Stage 1 LLM на ~50 трендах × 12 циклов/день при gpt-5.4-mini). Stage 2 cap'ом ограничен — общий бюджет ~$153/мес не растёт.

**Critical carry-through (двухслойный, fix #2 + #2-bis)**: clusterer-domain поля (`emergenceScore`, `narrativePhase`, `marketStage`, `junkPenalty`, `junkReasons`) НЕ пересчитываются на single-trend re-score. Scorer (`_analyzeBatchStage1` line 641) читает emergence ИСКЛЮЧИТЕЛЬНО из `trend.clusterMetrics?.emergenceScore` — top-level `trend.emergenceScore` игнорируется. Поэтому carry-through делается в **источнике**: `db.getHotTrendsForRefresh()` сразу заполняет `clusterMetrics` всеми полями (плюс `isNovel: true` чтобы Stage 2 на re-score не auto-skip'нулся). Это гарантирует корректную форму на ОБОИХ путях `_refreshAll` — и success (`_merge` спредит `originalTrend.clusterMetrics`), и failure (`out[i] = trend` без merge, когда fxtwitter 429-ит). Первый фикс был только в `_merge` — починил success-path, оставил leak на fetch-failure, что особенно больно потому что fxtwitter падает значительно чаще Apify.

**Alert dispatch после refresh**: цикл вызывает `dispatchAlerts({trends, source: 'refresh'})` после `saveTrend`. Тот же модуль (`src/notifications/alert-dispatcher.js`), что использует scan-cycle. Дозревший тренд получит алерт (если порог пробил И юзер ещё не получал — гейт `dedup` защищает от дублей). `triggerSource` поле в decisions buffer показывает `scan|refresh|manual` для observability.

## Catalyst forecast (on-demand trigger)

Forward-looking прогноз: что подтолкнёт **дальнейший рост популярности нарратива**. Запускается по клику Pro/Admin (кнопка «🔮 Catalyst» в Telegram, кнопка в TrendModal дашборда). Заменил собой старый «Trigger search» (который искал прошлый триггер). Stage 1 поле `whyNow` остаётся фактоидом «что зажгло» — это ортогональный past-anchor.

**Архитектура** (`src/analysis/{prompts,trigger-finder}.js`):
- Промпт `TRIGGER_SYSTEM_PROMPT` — forecaster, не recap. Системные ограничения: ZERO references to crypto / coins / tokens / tickers / market caps. Только narrative popularity.
- Grok `grok-4-1-fast-reasoning` + `x_search` (tool). Reasoning премия оправдана: phase estimation требует cross-tweet timestamp correlation.
- Per-user 15min cooldown (admin bypass), DB-level claim против race, shared cache в `trends.trigger_*`.

**Output JSON** (расширен с `{ trigger, sources, confidence }`):
- `forecast` — 2-3 предложения: текущая фаза + главный forward catalyst + upside window
- `phase` — enum `early | building | peaking | saturated | fading`
- `window` — short-form upside horizon ("next 24-48h", "after premiere on Nov 14", '' если uncertain)
- `drivers[]` — 1-3 концентрированных bullet'а ≤80 chars, что подтолкнёт
- `risks[]` — 0-2 bullet'а, что может убить рост до закрытия окна
- `sources[]` — до 5 X-handles
- `confidence` — 0-100

**DB columns** (`trends`): `trigger_text`, `trigger_phase`, `trigger_window`, `trigger_drivers` (JSON), `trigger_risks` (JSON), `trigger_sources` (JSON), `trigger_confidence`, `trigger_searched_at/by`, `trigger_in_flight`. Старые row'ы со scored-but-not-triggered трендами имеют пустые/NULL поля — UI не рендерит пустые секции.

**UI rendering**:
- Telegram (`_renderTriggerMessage`): header → forecast text → phase·window combined chip-line → drivers list → risks list → sources → confidence. Пустые поля скипаются.
- Dashboard (`TriggerSection`): чисто forward-блок. `whyNow` живёт **отдельной секцией** «🔥 Триггер» выше в TrendModal (на месте удалённого «🤖 AI alpha»). В пустом state Catalyst-секция показывает CTA-подсказку + кнопку «🔮 Найти Каталиста». В заполненном — forecast + chip-row (phase tinted по семантике: green/blue/orange/grey/red) + bullet-секции `.catalyst-drivers` (accent border) и `.catalyst-risks` (red-tinted).

**Запреты в промпте**: NO crypto / coin / token / ticker / launch (financial sense) / pump / DEX / contract / market-cap mentions. Если для нарратива coin уже существует — Grok'у запрещено его упоминать. Forecaster о популярности нарратива, не о цене актива.

**No-signal case**: если x_search не нашёл реального forward driver'а — confidence < 40, drivers `[]` или один cautious bullet, forecast честно говорит «нет ясного катализатора впереди». Никаких manufactured forecasts.

**Стоимость**: ~5-50 вызовов/день, reasoning ~$0.05-0.10 за вызов. Cap'ится cooldown'ом и shared cache'ом.

## Support bot

Отдельный Telegram-бот для тикетов поддержки — `@CatalystSupportbot`. Цель — увести поддержку из личного DM владельца. Архитектура: forum-topics relay в приватной admin-группе.

**Flow**:
- Юзер → `@CatalystSupportbot` (DM) → бот находит/создаёт forum-topic в admin-группе → копирует туда сообщение через `copyMessage` (без `Forwarded from`)
- Админ отвечает в нужном топике → бот ловит `message_thread_id`, ищет mapping по `(topic_id, group_id)` → копирует ответ юзеру
- copyMessage agnostic к контенту: текст, фото, видео, голосовые, документы — всё работает в обе стороны

**Storage**: таблица `support_threads(chat_id PK, topic_id, group_id, username, created_at, updated_at)`. Двусторонний lookup через `getSupportThreadByChat(chatId)` и `getSupportThreadByTopic(topicId, groupId)`. `group_id` per-row чтобы re-config admin-группы не мисроутил старые треды.

**Bootstrap-инвариант** (без этого relay не работает):
- Bot privacy mode **выключен** в @BotFather (`/mybots → Bot Settings → Group Privacy → Turn off`)
- Группа с включёнными Topics
- Бот = админ группы с правом `Manage Topics`
- `SUPPORT_GROUP_ID` (negative chat_id) в `.env`

**Language sync с основным ботом** (`_resolveLang(chatId, fromUser)`): chat_id одинаковый для всех ботов одного юзера, поэтому читает `users.language` из shared DB. Приоритет: 1) saved language из основного бота → 2) `from.language_code` → 3) `'en'`. Юзер выбравший RU в `/menu → Language` Catalyst'а получает RU-приветствие в саппорте независимо от Telegram UI lang.

**Graceful disable**: если `SUPPORT_BOT_TOKEN` или `SUPPORT_GROUP_ID` отсутствует — бот не стартует (`enabled = false`), warning в логи, основной flow работает. Кнопка «💬 Ask a question» в основном боте использует хелпер `_supportUrl()`: `t.me/${SUPPORT_BOT_USERNAME}` или fallback на `t.me/skipnick`.

**Concurrency**: `_creatingTopic` Map — promise-coalescing per chatId, чтобы два быстрых сообщения от одного юзера не race'или на `createForumTopic`.

**Pinned-шапка** (создаётся при первом топике, admin-only — юзер её не видит): `🎫 New support thread` + username + first/last name + `chat_id` + `lang_code` + хинт «Reply in this topic — your message will be delivered to the user».

## Alert types

3 enum (`prompts.js → ALERT_TYPE_VALUES`):
- `event` 📰 — конкретный триггер (whyNow обычно непустой)
- `trend` 📈 — нарратив на нескольких платформах / в нескольких постах
- `post` 🚀 — один вирусный пост, не движение

**AI-driven** через Stage 1 schema (`alertType`). xAI/Grok нормализуется через `normalizeAlertType()`.

**Deterministic fallback** `deriveAlertType(trend)`:
- `whyNow → event`
- `platforms ≥ 2 OR clusterSize ≥ 3 → trend`
- иначе `post`

**Persistence**: `trends.alert_type` колонка + `raw_metrics.alertType` зеркало.

**Per-user subscription**: `users.alert_types_filter` CSV default `'event,trend,post'`. Helpers `db.getUserAlertTypes(chatId)` / `setUserAlertTypes(chatId, types[])`. Empty CSV → silent-allow (никогда не мутим).

**Gate** в alert-loop: `!trendAlertType || userAlertTypes.includes(trendAlertType)`.

**UI**:
- Telegram: `/menu` → «🔔 Типы алертов» submenu, 3 ✅/❌-toggle
- Dashboard: sidebar chip-filter (multi-select CSV). AccountPanel `AlertTypesRow`
- Admin: SubmitPage hero meta-chip (color per type). DecisionsPage gate label `alert_type`

## Sidebar filters (dashboard)

Phase + alert-type chips поддерживают **multi-select**. Хранятся как sorted CSV-строки в state, persist в localStorage.

- **Phase**: `?phase=early,forming,strong` → server SQL `IN (?,?,...)`. localStorage `ts_phase_filter`.
- **Alert type**: client-side filter через `Set(alertTypes.split(','))`. localStorage `ts_alert_type_filter`.
- «Все» (◆) chip exclusive — клик сбрасывает CSV.
- Reset-link появляется если CSV непустой (или включён manual-toggle для alert-type секции).

**Category dropdown**: кастомный `CategoryDropdown` (нативный select игнорировал CSS на chromium). Открывается **вверх** (компонент сидит низко в sidebar). Click-outside (mousedown) + Esc закрывают. Без скролла внутри (10 категорий + reset row помещаются ~390px).

## Source icons (dashboard)

Brand SVG logos (simpleicons.org public-domain), single-color, `fill="currentColor"`:
- `reddit` — Snoo
- `google_trends` — G-mark
- `twitter` — X glyph
- `tiktok` — music note silhouette
- `x_trends` — hashtag

`SourceMark({ src, fallback })` рендерит SVG через `dangerouslySetInnerHTML`; fallback — letter-mark из `SOURCE_ICONS` (R/G/𝕏/♪/#) для inline-text usage (top-narratives meta, telegram keyboard).

CSS `.src-mark-svg { width/height: 60% }` от родительского чипа. Twitter X 56% (тонкий по природе). Используется в `.source-icon` (sidebar) и `.feed-avatar` (TrendCard).

## Theme system (dashboard)

4 X-style monochrome темы через `body[data-theme="..."]`. localStorage `ts_theme`.

| Theme | bg | accent | use case |
|---|---|---|---|
| `ink` | `#000000` | `#1d9bf0` | **default**, X true-black |
| `dim` | `#15202b` | `#1d9bf0` | X dim-mode |
| `slate` | `#0e0f10` | `#ffffff` | Apple-style графит, белый акцент |
| `mono` | `#0d0d0d` | `#b8b8b8` | grayscale без хроматики |

**Дизайн-принципы**:
- Один accent на тему (через `--accent-rgb` для `rgba(var(--accent-rgb), α)` паттерна — никаких hardcoded rgba)
- Borders translucent white at low alpha — никогда tint от accent
- Семантические цвета (`--green/--red/--orange/--yellow`) **константны** во всех темах
- Glossy: `--gloss-top: inset 0 1px 0 rgba(255,255,255,.04)`, `--gloss-edge: inset 0 0 0 1px rgba(255,255,255,.02)`
- Surfaces: везде `var(--surface)` (`#0a0a0a` на ink) — карточки матчат сайдбар, разделяются только 1px бордером

`detectTheme()` дефолтит на `ink`. Юзеры со старой темой автоматически переключаются на default через validity-check.

## Dashboard layout

CSS Grid с draggable column dividers. Левая колонка (sidebar) 180-540px, правая (rail) 240-630px. Prefs в `ts_prefs_v1.colLeft/.colRight`. Double-click на divider = reset. Высоты грида/панелей через `calc(100vh - 50px)` (только nav-h, нижней полосы нет).

**Modal sheets** (Settings / Account / Stats / Analyze): центрированные с `backdrop-filter: blur(14px)` + затемнением. Body scroll lock. Закрываются по Esc / клик на фон / ✕.

**Bottom nav**: Feed + Stats + Analyze (pro/admin only). Inline `repeat(${tabs.length}, 1fr)` чтобы tab'ы распределялись равномерно.

**TrendModal**: head — alertType / category / 🧪 MANUAL / phase-badge / source / time / ✕. Body — media → title → 🔥 Триггер (whyNow) → 🔮 Каталист (forecast или CTA) → links → feedback → score bars (emergence / adoption / story — Story всегда рендерится, даже если =0) → story-hook pull-quote → stats grid (Meme / Lifespan / Virality / Sentiment / Platforms / Velocity). Virality cell рендерит per-source engagement через emoji (`👁/⬆️ ❤️ 💬 🔁`) с `fmtCount` (1.2M / 45K). При отсутствии метрик fallback на `trend.score`.

**ImageCarousel**: tracks `Set<failedIndices>` локально — onError на `<img>` маркает индекс failed, фильтр пересобирает gallery без него. Если все умерли — carousel не рендерится вообще. Counter + dots используют `safeIdx` от живой части. `_formatTrend` фильтрует Twitter avatar URL'ы (`/profile_images/`, `_normal/_bigger/_400x400`) из `imageUrls` + `imageUrl` чтобы legacy-row pfp не лезли в carousel.

**Right panel (rail)**: Top narratives (top-10 по adoption) → 🟢 Live (signals/alerts/avg-virality stats + sources sub-block с brand-tinted pill'ами). Раньше тут была отдельная Activity-секция + нижняя полоса с источниками — слиты воедино 2026-05-02.

**Per-trend hide / archive**: ✕-кнопка в правом верхнем углу `.feed-card` (hover-only, 22×22, border-radius 5 — под стиль badges). Клик → `POST /api/trends/:id/hide` + 5s undo-toast снизу. Архив в `SettingsPanel` — collapsible `<ArchiveCard>` (lazy-load на open), retention 7 дней (server cleanup из `index.js`).

**Account panel**: hero card + аватар (TG profile photo через `/api/auth/avatar`, disk cache TTL 7 дней, throttle refresh 6ч) + plan badge + threshold slider + logout.

## Admin panel

`src/admin/server.js` — inline React SPA. **9 табов**: 📊 Stats / ⚙️ Сканеры / 🎛️ Пресеты / 🧪 Ручной анализ / 🔔 Алерты / 🎓 AI Examples / 👥 Пользователи / 💳 Платежи / 🤖 Бот.

**Топбар (`StatusBar`)**: live-pipeline визуализация, всегда видна. Polls `/api/pipeline` каждые 2.5с, рендерит 8 stage-нод + 7 wires справа от заголовка `🔄 Пайплайн`. Subtitle: `Live — Stage 1...` / `Последний цикл 12с назад` / `⏸ Сканер на паузе`. Клик по заголовку → переход на Сканеры. На `max-width: 1100px` оборачивается под заголовком.

**Live nav indicators**: poll каждые 12с в App. Yellow pulsing dot на «Сканеры» при паузе. Accent badge на «Алерты» со счётчиком решений в буфере.

**Bot tab разделён на 3 sub-tabs**: 🧠 AI / 📢 Рассылки / 💰 Планы и фидбек.

**UsersPage**: action-column 420px → ⚙ кнопка + drawer-row снизу с группами Подписка / Статус. State `expandedId` (single-row-open).

**Maintenance** (Stats): красно-tinted карточка «🧹 Обслуживание базы» с кнопкой «Очистить старые алерты» (prompt N days).

**SubmitPage history**: горизонтальная strip mini-карточек последних manual-submitted трендов. Click → переключает active детальную панель `ManualResultCard` (hero + score grid + collapsible PreStage / Stage 2 / cluster signals / images).

**Унифицированные примитивы** (CSS namespaces):
- `.adm-card` — universal section wrapper (бывш. `.broadcast-box`)
- `.adm-tabs / .adm-tab / .adm-tab-count / .adm-tab-dot` — единый таб-стрип (`.bordered`, `.capitalize` модификаторы)
- `.dec-*` — DecisionsPage cards/chips
- `.sb-*` — StatusBar pipeline
- `.scfg-*` — ScannerConfigSection (preset + Twitter actor card grid)
- `.pcfg-*` — PresetConfigsPage (accordions, chip-input, BudgetSlider)
- `.sp-*` — SubmitPage (manual analysis)
- `.exp-*` — ExamplesPage (Stage 1 calibration)

**Section primitive**: `<Section icon title desc actions>{children}</Section>` определён, готов к использованию для новых карточек (постепенный refactor от .adm-card блоков).

## Files map

| Module | Role |
|---|---|
| `src/index.js` | Main loop — scan cycle + alert-loop + DB warmup + cleanupVideoCache |
| `src/analysis/scorer.js` | AI scoring (Stage 1 + Stage 2), alertScore formula, `loadAlertWeights(db)` |
| `src/analysis/clusterer.js` | Multi-signal clustering, cheapDedup, `route()` async |
| `src/analysis/preset-config.js` | Per-preset configs (defaults + resolver + validator) |
| `src/analysis/junk-filter.js` | Junk penalty calculation, meme-shape boost |
| `src/analysis/pre-stage.js` | Stage 0 orchestrator (nano + gemini parallel) |
| `src/analysis/nano-classifier.js` | gpt-5.4-nano text enrichment |
| `src/analysis/gemini-captioner.js` | Visual captioner (Google direct + OpenRouter fallback) |
| `src/analysis/embeddings.js` | text-embedding-3-small cosine for clusterer |
| `src/analysis/image-hash.js` | dHash thumbnail hashing for clusterer |
| `src/analysis/manual-analysis.js` | Manual URL analysis orchestrator (admin/dashboard/TG) |
| `src/analysis/url-resolver.js` | Resolve Twitter/Reddit/TikTok/og:image URL → synthetic trend |
| `src/analysis/prompts.js` | Stage 1/2 prompts + JSON schemas + ALERT_TYPE_VALUES |
| `src/analysis/lifespan.js` | Lifespan keys single source of truth |
| `src/analysis/market-stage.js` | [opt-in] MarketStage detection (feature flag) |
| `src/analysis/filter-profiles.js` | Junk-filter penalty defaults (used via preset-config import) |
| `src/collectors/{reddit,twitter,tiktok,google,x-trends}.js` | Apify-based collectors per platform |
| `src/db/database.js` | SQLite wrapper, migrations, settings, feedback_votes, hidden_trends, support_threads |
| `src/admin/server.js` | Admin SPA (inline React in template literal) |
| `src/dashboard/server.js` | Dashboard SPA (inline React in template literal) |
| `src/notifications/telegram.js` | TG bot, alerts, /menu, /analyze, reason wizard, attachXButton |
| `src/notifications/formatter.js` | Alert message formatter (HTML for TG) |
| `src/support/bot.js` | Support bot (forum-topics relay, `SupportBot` class) |
| `src/refresh/hot-metrics.js` | Hot trends refresh loop (re-fetch + re-score every 2h) |
| `src/notifications/alert-dispatcher.js` | Shared alert dispatcher — used by scan-cycle и hot refresh |
| `src/i18n/{ru,en}.js` | i18n maps for telegram + dashboard |

## Ловушка server.js — backticks И escape-sequences в SPA-строках

`src/dashboard/server.js` и `src/admin/server.js` — огромные inline React SPA внутри **template literal**. Два класса ошибок которые `node --check` НЕ ловит:

1. **Backticks в комментариях**. Любой `` `token` `` в `//` комментарии ломает outer literal с `SyntaxError: Unexpected identifier '<token>'`. **В этих файлах никогда не писать backtick в комментариях**.

2. **Escape-sequences `\n` `\t` `\r` в строках**. `'foo\n'` внутри SPA — outer literal съедает `\n` (превращает в реальный newline) → unterminated string в браузере → `Uncaught SyntaxError: Invalid or unexpected token` → чёрный экран. **Решение**: `String.fromCharCode(10)` для newline, `String.fromCharCode(9)` для tab. Альтернатива — `\\n` (двойное экранирование).

**Проверка SPA отдельно** (ловит оба класса): `scripts/check-{admin,dashboard}-spa.cjs`. Extracts `<script>...</script>` из template literal, unescapes, прогоняет через `vm.Script`. **Запускать после ЛЮБОГО изменения** соответствующего server.js.

## Env keys (минимальный набор)

- `APIFY_API` — primary Apify token (TikTok)
- `APIFY_API_KAITO` — kaitoeasyapi Twitter actor
- `APIFY_API_XQUIK` — xquik Twitter actor (опц.)
- `OPENAI_API_KEY` — Stage 1 (если provider=openai), Stage 0 nano, embeddings
- `XAI_API_KEY` — Stage 1 (если provider=xai), Stage 2 (всегда)
- `GOOGLE_AI_API_KEY` — Stage 0 Gemini primary
- `OPENROUTER_API_KEY` — Stage 0 Gemini fallback
- `STAGE0_NANO_ENABLED` — panic kill-switch
- `CLUSTER_MULTI_SIGNAL` — panic к Jaccard
- `MARKET_STAGE_DETECTION` — opt-in MarketStage
- `X_TRENDS_REFRESH_MINUTES` — X Trends refresh interval (default 30)
- `SUPPORT_BOT_TOKEN` / `SUPPORT_BOT_USERNAME` / `SUPPORT_GROUP_ID` — отдельный support-бот для тикетов (forum-topics relay). Все 3 нужны вместе, иначе бот не стартует.
- `HOT_REFRESH_ENABLED` — panic kill-switch для refresh-loop (default on)
- `HOT_REFRESH_INTERVAL_MINUTES` — интервал refresh-цикла (default 120)

Полный набор + параметры PreStage / video / lookback — в `.env.example`.

## Контекст-файлы

- `ai-context/AGENT_RULES.md` — обязательные правила для агентов (читать первым)
- `ai-context/SESSION_CONTEXT.md` — этот файл (state-spec)
- `ai-context/WORKLOG.md` — последние ~10 entries, append на верх
- `ai-context/WORKLOG_ARCHIVE.md` — старше 10, архив
