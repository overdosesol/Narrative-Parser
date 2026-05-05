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
           noContentPenalty, safeOverrideDivisor, memeShapeBoost }
alerts:  { thresholds: { alertThreshold, minScoreToSave, maxAlertsPerCycle, alertHardJunkStop },
           weights:    { weightMemePotential, weightVirality, weightEmergence,
                         weightTwitter, weightFeedback, weightJunk },
           stale:      { staleDecayPerHour, staleDecayGraceHours, staleDecayCap } }
cluster: { simThreshold, timePenaltyHours, weightEmbedding, weightPhash,
           weightEntity, weightTicker }
```

**General preset philosophy** (2026-05-05): General — это **curated mix** из остальных 4 тематик, НЕ broad-firehose. Раньше использовал `r/all` + `r/popular` + word-soup queries `(a OR the OR is OR to)` + generic hashtags `fyp/viral/trending` — давало мусор по объёму, потому что любой viral пост проходил независимо от темы. Сейчас sources = **2-3 элемента из каждой темы** (animals/culture/celebrities/events) + 2 universal awe-sub'а (Damnthatsinteresting, nextfuckinglevel). Reddit minUpvotes снижен 10K → 5K (themed subs тише чем r/all). Если станет нужно вернуть firehose — нужно явное возвращение `r/all`/`r/popular`/word-soup, иначе цель General «качественный микс по всем темам», не «всё подряд».

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

**Видео policy**: `ffprobe` замеряет длительность. ≤ `STAGE0_VIDEO_MAX_SEC` (30 default) → Google native video (download → base64). > этого порога → `ffmpeg -c copy -t N` обрезает первые N секунд в tmp-mp4, читаем обратно как Buffer, шлём в Gemini как обычное короткое видео. `videoClipped=true` в выходе. Постер используется ТОЛЬКО если trim упал (network / codec / corrupt source) ИЛИ Google вернул ошибку → тогда `videoTruncated=true, truncationReason='duration_exceeded'`. ffmpeg trim универсальный — работает для Twitter / Reddit / TikTok / X Trends / manual-analysis (любой источник с `metrics.videoUrl`). Adds Referer header для TikTok-CDN автоматически.

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

## Cross-platform aggregation: REMOVED (2026-05-04)

Раньше clusterer пытался мержить посты из разных source'ов (twitter/reddit/tiktok/google_trends/x_trends) в один нарратив через `uniquePlatforms` сигнал, и emergence-формула давала за это до 30 баллов. На практике matcher постоянно фейлил — то же самое turtle-видео из Twitter и Reddit ехало двумя отдельными трендами, оба получали 0 за «platform spread».

**Ripped out целиком**:
- `_computeMetrics` больше не считает `batchPlatforms`/`dbPlatforms`/`uniquePlatforms`
- emergence-формула: компонент Platform spread (0-30) удалён, баллы перераспределены — Velocity 25→35, Organic 20→30, Novelty 15→20, Author 10→15
- `_decide` drop-gate: убрано `uniquePlatforms <= 1` условие
- `deriveAlertType` (scorer.js): `platforms ≥ 2 OR clusterSize ≥ 3` → `clusterSize ≥ 3`
- Dashboard: URL-param `minPlatforms`, поле `uniquePlatforms` в payload, бейдж `Xp` на карточке, тайл «Платформы» в модалке — всё убрано
- Admin: бейдж `🌐 N платформ` в Cluster signals тоже снят

**Что НЕ трогали**:
- Колонка `source` в БД и `i.source` на каждом item — нужна для других фич (фильтр по источнику в фиде, badge источника, dedup внутри одного source'а)
- AI промпты (`prompts.js`) всё ещё описывают «cross-platform spread» как часть рубрики — это валидная семантика для LLM, не наш детерминированный код. **Не реактивируйте через промпты.**
- Старые строки в БД могут содержать `uniquePlatforms` в `raw_metrics` JSON — безвредно, никто не читает

Если когда-нибудь захочется вернуть — нужно сначала **починить cross-source matcher** (embedding similarity между постами разных платформ работает плохо из-за разных стилей/нормализации). До тех пор: single-source breakouts ловит Path 2 (`_computeBreakoutScore`) — он platform-agnostic, по raw engagement.

## Scoring metadata

Поля trend object'а после full pipeline:

- **memePotential** (0-100) — AI-driven, мемность нарратива (alias `adoptionScore`)
- **virality** (0-100) — AI-driven
- **emergenceScore** (0-100) — `max(spread, breakout) + ideaBoost`. Spread = velocity (0-35) + organicSpread (0-30) + noveltyStage (0-20) + authorDiversity (0-15). **Platform spread компонент удалён 2026-05-04** — кросс-платформенный matcher был ненадёжным (см. § Cross-platform: removed); 30 баллов перераспределены по остальным 4 компонентам. Breakout = single-post виральность с damping по followers; ideaBoost = Reddit upvote bonus (>=10k→+5, >=15k→+8, >=30k→+10, >=60k→+12)
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
- no-content (text-only post): +5 (general), 0..8 per-preset. Skipped когда **все** items кластера от source'а без медиа by design (`google_trends`) — иначе бы google-результаты тонули штатно. Идея: пост без картинки/видео — обычно low-effort шум, мягкий штраф (-2..4 points alertScore через `weightJunk=0.5`)

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

**TikTok actor registry** (тот же runtime-switch паттерн):
- `clockworks/tiktok-scraper` — **default** ($2.00/1K, нативный hashtag-вход через `hashtags: [tag]`)
- `apidojo/tiktok-scraper` — alt ($0.30/1K, в ~6× дешевле). Не принимает `hashtags`-массив — собирается через `startUrls: [{ url: 'https://www.tiktok.com/tag/<encodedTag>' }]`.

DB setting `tiktokActor` читается в `_activeActor()` коллектора на каждом запросе. Per-actor tokens: `APIFY_API` (для clockworks, fallback с generic) и `APIFY_API_APIDOJO`. UI в админке: «⚙️ Сканеры» → «🎯 Конфиг сканера» → блок «🎵 TikTok scraper».

**Видео-файл**:
- **apidojo** отдаёт работающий `videoUrl` (URL с подписанным токеном на `tiktokcdn-us.com`/`tiktokv.com`, валиден ~6h). `_normalize` пробрасывает его в `metrics.videoUrl` с приоритетом `videoUrlNoWaterMark > videoUrl > mediaUrls[0]`. Stage 0 Gemini-captioner качает нативно (как Twitter) — короткие ≤ `STAGE0_VIDEO_MAX_SEC` идут целиком, длинные → постер.
- **clockworks** не выставляет `videoUrl` пока не включить `shouldDownloadVideos: true` (мы оставляем выключенным для экономии Apify-кредитов). Поэтому для clockworks fallback на постер — как было до 2026-05-05.
- **TikTok CDN gating**: tiktokcdn.com / tiktokv.com гейтят по `Referer: https://www.tiktok.com/`. Без него — 403. `gemini-captioner.js` детектит TikTok-URL через `_isTikTokMediaUrl()` regex и добавляет Referer в HEAD/GET fetch + в `ffprobe -referer ...`. Это решает «header-bound» проблему apidojo (миф об «истекающих cookie» — на деле просто нужен Referer).

`_normalize` field-fallback chain покрывает оба актёра — `author` пробегает `authorMeta.name → authorUsername → author.uniqueId`, `thumbnailUrl` — `originCoverUrl → covers[0] → covers.{default,origin} → cover → dynamicCover → shareCover[0] → imageUrl`, и т.д.

**Auth pattern (security)**: все Apify-запросы используют `Authorization: Bearer <key>` header вместо `?token=` query-param. Если `fetch()` бросает network/DNS error, undici включает URL в `err.message` — Bearer держит токен вне URL-поверхности, чтобы upstream `logger.error(e.message)` не мог утечь токен. Применено во всех 4 коллекторах (`twitter.js`, `twitter-check.js`, `tiktok.js`, `x-trends.js`).

**X Trends collector** (5-я платформа, source-id `x_trends`) — двухстадийный discovery flow:
- **Stage A** (раз в сутки): Apify actor `karamelo~twitter-trends-scraper` тянет live-список трендов в США, берём top-3 по rank.
- **Stage B**: для КАЖДОГО top-тренда вызываем `TwitterCollector.searchByQuery(trendName, 7, { relaxedFloor: true })` — это тот же актор kaitoeasyapi/xquik что и обычный Twitter, отдаёт 7 топовых твитов по запросу.
- **Aggregation**: один эмитированный item на тренд (source=`x_trends`, не на твит), `metrics.views/likes/retweets/replies` = сумма по всем твитам тренда. Stage 1 LLM получает РЕАЛЬНЫЙ engagement сигнал, не текстовую догадку.
- **Visual content**: thumbnail/imageUrls/videoUrl лифтятся из highest-engagement твита → карточка тренда в фиде имеет постер/галерею/видео как обычный twitter-пост.
- **`metrics.topTweets[]`**: список из {id, url, author, text, views, likes, retweets, replies, thumbnailUrl, imageUrls, videoUrl} — для Stage 1 prompt context, dashboard modal, future UI.
- Daily externalId bucketing (`xtrends-<country>-<slug>-<YYYYMMDD>`) — один item на тренд на день. На следующий день re-enters pipeline (= «trending again» semantics).
- **Relaxed engagement floor** в `twitter._normalize` для X-Trends-вытянутых твитов: 10K views / 500 likes (вместо firehose-grade 500K / 10K). Trending position сама по себе — quality signal.
- Если ни один топ-твит тренда не прошёл relaxed-floor → тренд тихо скипается с info-логом (low-quality generic hashtags типа `#GoodMorning` отсеиваются).

**Стоимость**: ~$1.40/мес (1 trends-list call/день × $0.04 + 21 tweet/день × $0.00025).

Env knobs:
- `X_TRENDS_REFRESH_MINUTES` (default **1440**, был 30 в старой архитектуре)
- `X_TRENDS_TOP_TRENDS` (default **3**)
- `X_TRENDS_TWEETS_PER_TREND` (default **7**)
- `X_TRENDS_COUNTRY` (default `United States` или числовой ID `"1".."35"` — `karamelo` actor сменил схему 2026-03-06)

Per-preset `sources.xtrends` config: `{ enabled, topN }` — поле `topN` сейчас не используется (top-N контролируется через env), оставлено в схеме для обратной совместимости.

**TikTok cycle pacing** — TikTok-collector работает независимо от активного пресета (поле `sources.tiktok.enabled` в preset-config.js помечено DEPRECATED, читается схемой но не влияет на поведение). Управление вкл/выкл — только через env `TIKTOK_ENABLED`. TikTok бежит со СВОИМ интервалом `TIKTOK_CYCLE_INTERVAL_MINUTES=30` (default 30 мин vs глобальные 15 мин для других коллекторов) — реализовано через time-gate в `collect()`: skip если последний run был меньше interval-минут назад. First-run after restart всегда проходит.

**TikTok live hashtag discovery** (Stage A для TikTok pipeline'а, по образу X-Trends): раз в 12h (env `TIKTOK_TRENDS_REFRESH_MINUTES=720`) collector дёргает `clockworks~tiktok-trends-scraper` actor (numeric ID `sDvA9jM4WRTDX4Syr`) который зеркалит данные из TikTok Creative Center (`ads.tiktok.com/business/creativecenter` — официальная публикация TikTok'ом списка trending hashtags). Получаем top-24 (env `TIKTOK_TRENDS_TOP_N=24`) с фильтром `isPromoted=false`, `videoCount > 0`. Кэшируется в `settings.tiktokTrendingHashtags` (JSON-blob `{hashtags:[], fetchedAt}`) для restart-survival. **Live-discovery — primary path в `_getHashtags()`**; per-preset hardcoded list (`culture.tiktok.hashtags`) остаётся fallback'ом если Apify-call упал.

**Math за дефолтами**: 30min cycle × 1 hashtag per cycle × 24 hashtags = 24 cycles per 12h refresh window — каждый хэштег ищется ровно один раз перед тем как новый refresh принесёт другой набор. Стоимость ~$4.32/мес ($3.00/1K × 24 × 2/day).

**Apidojo input schema** для `clockworks~tiktok-trends-scraper`: поля все имеют префикс `ads*` (Creative Center это «ads surface» в TikTok'е). Минимальный рабочий input: `{ adsScrapeHashtags: true, adsScrapeSounds/Creators/Videos: false, resultsPerPage: N, adsCountryCode: 'US', adsTimeRange: '7', adsRankType: 'popular' }`. Полная схема через `GET /v2/acts/{id}/builds/default → actorDefinition.input.properties`.

**PRICING TRAP** (важно для других clockworks-actor'ов): открытая страница actor'а на Apify показывает $1.70/1K, реальная цена в console (actor → "Pricing" tab) — **$3.00/1K**. Public-page sticker stale. Always verify в console.

**TikTok compilation filter** (`tiktok.js COMPILATION_RE`): regex-фильтр сразу после engagement-bar — отбрасывает видео с явными маркерами подборки в caption'е:
```
\b(compilations?|funniest|funny moments?|cute moments?|best of|
   top \d+|\d+ (minute|second|...) of|weekly|monthly|daily best|
   of the (week|month|year)|highlights of|memes? #\d+)\b
| #\d+\s*$
```
High precision / low recall — лучше пропустить пару подборок чем дропнуть narrative с фразой «top scorer». Дропает до Stage 0 enrichment'а.

**TikTok cluster representative semantics** (`tiktok.js _clusterByHashtag`): кластер по хэштегу выбирает **один представитель** (видео с максимальным `plays + shares*1000 + likes*10` — shares домининируют как сильнейший viral-сигнал) и эмитит ЕГО индивидуальные метрики как `metrics.plays/likes/shares/comments/velocity/url/title/author/thumbnailUrl/videoUrl`. Cluster-totals выносятся в **отдельные** поля `metrics.clusterPlays/clusterLikes/clusterShares/videoCount` для контекста. Раньше код суммировал в `metrics.plays/likes/shares` и брал URL первого попавшегося видео — это вызывало рассинхрон: AI получал в промпте сумму кластера, писал whyNow «@user posted 2.14M plays», юзер открывал ссылку — там 6K лайков. Сейчас то что юзер видит по клику ВСЕГДА совпадает с метриками в алерте. `prompts.js` рендерит rep-метрики и cluster-totals на разных строках с пометкой «describes the WAVE, not any one user».

**Formatter TikTok plays-line** (`notifications/formatter.js`): для TikTok рендерит `m.plays` напрямую, **не** `m.upvotes` (= synthetic `likes + shares*3`). Для Twitter и других источников upvotes-композит остаётся (label-aware: Twitter показывает upvotes как «likes», generic — как «upvotes»). TikTok-специфика — потому что он единственный источник где `plays` ортогональны `likes/shares` и подмена композитом давала «180K plays» в строке метрик при реальных 2.14M.

**TikTok engagement floor** (`tiktok.js _normalize`):
Видео проходит если выполняется ХОТЯ БЫ ОДНО (OR-логика):
- `plays ≥ 500 000`
- `likes ≥ 20 000`
- `shares ≥ 5 000`

`viralScore` (= `10·log10(plays) + 12·log10(likes) + 8·log10(comments) + 15·log10(shares) + 5·log10(followers)`) больше **не входит** во floor — формула это сумма логов и любое видео с ~200K плеев получает score=100 независимо от остального engagement, превращая гейт в no-op. `viralScore` всё ещё считается и сохраняется в `metrics.viralScore` для downstream-сигналов (peak finder в clusterer'е), но не гейтит.

Cluster aggregate floor **больше не применяется** — каждое видео уже прошло индивидуальный floor в `_normalize`, так что любой сформированный кластер по определению содержит хотя бы одно по-настоящему виральное видео.

**CJK threshold multiplier** (`_normalize` в `twitter.js` + `tiktok.js`):

| Письменность | Twitter views/likes | TikTok plays / likes / shares |
|---|---|---|
| Default (EN/RU/Romance/AR/...) | 500K / 10K | 500K / 20K / 5K |
| Japanese (`ja`), Korean (`ko`) | 1M / 20K (×2) | 1M / 40K / 10K |
| Chinese (`zh`) | 2M / 40K (×4) | 2M / 80K / 20K |

Все volume-метрики в TikTok скейлятся по CJK симметрично (×2 ja/ko, ×4 zh). `_detectCjkScript(text)` — kana → 'ja', hangul → 'ko', Han без них → 'zh', null иначе. Требует ≥30% CJK-доли.

**Audio-URL filter** (`tiktok.js _firstNonAudioUrl`): apidojo для некоторых видео в fallback-полях прокидывает не video URL а саундтрек mp3 (на `*-music*.tiktokcdn.com`). Helper отсекает audio-URL'ы по regex `/\/ies-music|-music[-.]|\.mp3(\?|$)/i` чтобы не делать впустую download в Gemini-captioner. Применяется и в коллекторе и в `url-resolver.js _resolveTiktokViaApidojo`.

## Source-aware engagement labels

В `formatter.js` (Telegram alerts):
- Twitter → ❤️ Likes (с velocity)
- TikTok → ▶️ Plays
- X Trends → rich-row `👁 views · ❤️ likes · 🔁 retweets · 💬 replies · N tweets` (агрегированный сигнал по top-7 твитам тренда, single-counter был бы вводящим в заблуждение)
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
- **TikTok-резолвер two-tier**: если `APIFY_API_APIDOJO` set → apidojo single-URL run (полный engagement + videoUrl, ~$0.0003/анализ), иначе → oEmbed fallback (бесплатно, только title+thumb, без видео в Gemini). Это **независимо от `tiktokActor` админки** — ручной анализ всегда предпочитает apidojo если ключ есть, потому что нужен видео-сигнал для Stage 0. Without key → graceful soft-fallback на oEmbed.

**Cross-user URL cache**: module-level Map с TTL 1h. Если pro-юзер A проанализировал URL, юзер B по тому же URL получает кэш мгновенно бесплатно. Cache key — lowercase URL без trailing-slash (query сохранён). Wiped on restart. Lazy save: `save:true` после `save:false` выполняет только DB-запись без re-run scorer.

`peekManualAnalysisCache(url)` — non-mutating helper, dashboard и TG handler'ы peek перед rate-limit, на cache hit пропускают rate-limit.

## Hot trends refresh loop (two-tier)

`src/refresh/hot-metrics.js` — два независимых фоновых цикла на одном инстансе:

1. **Heavy cycle** — раз в 12 часов (env `HOT_REFRESH_INTERVAL_MINUTES`, default **720**). Пере-фетчит метрики + **прогоняет Stage 1 LLM** + Stage 2 если memePotential ≥ 60 + dispatch alerts на дозревших. Дорогой ($3/мес Grok), редкий.
2. **Light cycle** — раз в 60 минут (env `HOT_REFRESH_LIGHT_INTERVAL_MINUTES`, default **60**). **Только** обновляет engagement metrics через `db.updateTwitterEngagement` / `db.updateRedditEngagement`. **Без LLM, без re-score, без alert-dispatch**. Бесплатно (fxtwitter + reddit JSON оба free). Эффект — все Reddit/Twitter тренды до 24h всегда максимум на 60 минут устаревшие в DB.

Light cycle skip'ает себя если heavy в полёте (no double-fetch). Тот же admin-toggle `hotRefreshEnabled` управляет обоими; отдельный env `HOT_REFRESH_LIGHT_ENABLED=0` для kill только light. Eligible для light: те же Reddit+Twitter ≤24h, но **без `minMeme`** (даже низкокачественные обновляются — они видны в фиде).

Heavy: **без per-trend cooldown'а**. Возрастной gate `first_seen_at > 24h` — единственная защита. При интервале 12h тренд попадёт в heavy refresh **максимум 2 раза** за свою жизнь.

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

**Стоимость**:
- Heavy: ~$0.5/мес (Stage 1 LLM на ~50 трендах × **2 циклов/день** при 12h, gpt-5.4-mini). Stage 2 cap'ом ограничен — общий бюджет ~$153/мес не растёт.
- Light: $0/мес (fxtwitter и reddit json — оба бесплатные).

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

**TrendModal**: head — alertType / category / 🧪 MANUAL / phase-badge / source / time / ✕. Body — media → title → 🔥 Триггер (whyNow) → 🔮 Каталист (forecast или CTA) → links (Source / Telegram / **🧠 Ask Grok** — последняя ведёт на `grok.com/?q=<encoded>` с **6-пунктовым structured prompt'ом**: 2-3 названия нарратива / почему вирален / почему может вырасти / 1-10 потенциал / риски / релевантная аудитория, плюс «не выдумывай если данных мало») → **🔥 Топовые твиты** (только для `source='x_trends'`, рендерит `topTweets[]` clickable-строками с автором/текстом/engagement-чипами + hover-preview через `data-tweet-id`) → feedback → score bars (emergence / adoption / story — Story всегда рендерится, даже если =0) → story-hook pull-quote → stats grid (Meme / Lifespan / Virality / Sentiment / Platforms / Velocity). Virality cell рендерит per-source engagement через emoji (`👁/⬆️ ❤️ 💬 🔁`) с `fmtCount` (1.2M / 45K). При отсутствии метрик fallback на `trend.score`.

**ImageCarousel**: tracks `Set<failedIndices>` локально — onError на `<img>` маркает индекс failed, фильтр пересобирает gallery без него. Если все умерли — carousel не рендерится вообще. Counter + dots используют `safeIdx` от живой части. `_formatTrend` фильтрует Twitter avatar URL'ы (`/profile_images/`, `_normal/_bigger/_400x400`) из `imageUrls` + `imageUrl` чтобы legacy-row pfp не лезли в carousel.

**Right panel (rail)**: Top narratives (top-10 по adoption) → 🟢 Live (signals/alerts/avg-virality stats + sources sub-block с brand-tinted pill'ами). Раньше тут была отдельная Activity-секция + нижняя полоса с источниками — слиты воедино 2026-05-02.

**Per-trend hide / archive**: ✕-кнопка в правом верхнем углу `.feed-card` (hover-only, 22×22, border-radius 5 — под стиль badges). Клик → `POST /api/trends/:id/hide` + 5s undo-toast снизу. Архив в `SettingsPanel` — collapsible `<ArchiveCard>` (lazy-load на open), retention 7 дней (server cleanup из `index.js`).

**Link hover preview** (Twitter + Reddit, 2026-05-04): наведение на `↗ Twitter` / `↗ Reddit` ссылки (в фиде или модалке) → 350мс debounce → floating-карточка с содержимым поста (avatar/title/text/media/engagement). Кликабельные имена/аватары → ссылка на профиль. Auto-flip вверх если мало места снизу (через CSS `bottom` чтобы карточка росла независимо от своей высоты, а не прыгала на оценочную ESTIMATED_H). **Per-user toggle** в SettingsPanel → Appearance → «👁 Hover preview / Превью при наведении»; состояние в `localStorage.ts_prefs_v1.hoverPreview` (default ON). `useTweetHover.onOver` читает pref свежим через `readPref(...)` на каждом mouseover — toggle применяется сразу, без re-mount хука.

- **Backend** (`src/dashboard/server.js`): `GET /api/tweet-preview?id=<tweet_id>` (fxtwitter, free) и `GET /api/reddit-preview?id=<post_id>` (reddit JSON, free). Каждый со своим LRU-кэшем (500 entries, 5-мин TTL для 200, 30-сек для 4xx). После успешного fetch — `db.updateTwitterEngagement` / `db.updateRedditEngagement` пишут свежие views/likes/upvotes/comments + computed velocity обратно в `raw_metrics`.
- **Frontend**: атрибут `data-tweet-id` или `data-reddit-id` на самой `<a>` ссылке (URL-pattern based, **не** по `trend.source` — поле варьируется между коллекторами). Универсальный `useTweetHover` хук матчит оба, рутит на нужный endpoint. Унифицированный `<TweetHoverPreview>` компонент с `state.kind` switch — Twitter-стиль (𝕏 + @handle + 👁/❤️/🔁/💬) или Reddit-стиль (🅡 + r/sub + u/user + ⬆/💬/🏅).
- **Live update**: после fetch'а frontend диспатчит `CustomEvent('link-metrics-update')` с `kind / id / metrics / velocity`. App listener патчит `setTrends` и `setModalTrend` — feed-карточки и открытая модалка обновляются мгновенно. Backend параллельно записал в DB → следующий /api/trends pull тоже свежий.

**Velocity computation** (в `db.updateXxxEngagement`): Δviews|upvotes / Δhours от предыдущего snapshot (`metrics._engSnapshot = { views|upvotes, ts }`) ИЛИ от scrape-time baseline (`metrics.views|upvotes + first_seen_at`) на первом refresh. Min gap 5 минут (фильтр шума), Δ > 0 (защита от counter-rollback). Snapshot обновляется на каждом fetch'е, даже если velocity не пересчитывалась (сохраняем sliding window). Применяется одинаково для hover-driven и для light-cycle обновлений.

**Account panel**: hero card + аватар (TG profile photo через `/api/auth/avatar`, disk cache TTL 7 дней, throttle refresh 6ч) + plan badge + threshold slider + logout.

## Admin panel

`src/admin/server.js` — inline React SPA. **9 табов**: 📊 Stats / ⚙️ Сканеры / 🎛️ Пресеты / 🧪 Ручной анализ / 🔔 Алерты / 🎓 AI Examples / 👥 Пользователи / 💳 Платежи / 🤖 Бот.

**Топбар (`StatusBar`)**: live-pipeline визуализация, всегда видна. Polls `/api/pipeline` каждые 2.5с, рендерит 8 stage-нод + 7 wires справа от заголовка `🔄 Пайплайн`. Subtitle: `Live — Stage 1...` / `Последний цикл 12с назад` / `⏸ Сканер на паузе`. Клик по заголовку → переход на Сканеры. На `max-width: 1100px` оборачивается под заголовком.

**Live nav indicators**: poll каждые 12с в App. Yellow pulsing dot на «Сканеры» при паузе. Accent badge на «Алерты» со счётчиком решений в буфере.

**Bot tab разделён на 3 sub-tabs**: 🧠 AI / 📢 Рассылки / 💰 Планы и фидбек.

**UsersPage**: action-column 420px → ⚙ кнопка + drawer-row снизу с группами Подписка / Статус. State `expandedId` (single-row-open).

**Maintenance** (Stats): красно-tinted карточка «🧹 Обслуживание базы» с кнопкой «Очистить старые алерты» (prompt N days).

**Сканеры таб layout** (2026-05-05): сверху всегда видны 3 stat-cards + scanner-status-bar с кнопками Pause/Force-Scan. Ниже — 5 collapsible accordion'ов на `pcfg-accordion` стиле (тот же что в Пресетах): «📡 Площадки» (open) · «🎯 Конфиг сканера» (open) · «🎨 Stage 0 — PreStage» (closed) · «🔁 Обновление горячих трендов» (closed) · «📊 Junk-filter наблюдение» (closed). Внутренние компоненты `ScannerConfigSection / PreStageSection / HotRefreshSection / JunkStatsSection` рендерят bare-div без `adm-card` обёртки — заголовок и padding обеспечивает accordion summary/body.

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
| `src/notifications/telegram.js` | TG bot, alerts, /menu, /analyze, reason wizard, attachXButton, `fetchFile()` (token-safe) |
| `src/notifications/formatter.js` | Alert message formatter (HTML for TG) |
| `src/support/bot.js` | Support bot (forum-topics relay, `SupportBot` class) |
| `src/refresh/hot-metrics.js` | Hot trends refresh — heavy (12h, LLM rescore) + light (60min, metrics-only) циклы |
| `src/notifications/alert-dispatcher.js` | Shared alert dispatcher — used by scan-cycle и hot refresh |
| `src/i18n/{ru,en}.js` | i18n maps for telegram + dashboard (Stars удалены, em/en-dashes → дефисы) |
| `DEPLOY.md` | Production deployment runbook (systemd, nginx, ufw, backup, checklist) |

## Production posture (security + ops)

Дашборд и админка готовы к публичному хостингу — все блокеры закрыты в production-readiness pass (2026-05-04). Что выставлено:

**Security headers (every response, dashboard + admin)**: HSTS `max-age=31536000`, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer. Реализовано через `buildHeaders(req)` + monkey-patch `res.writeHead` в `_handle()` — каждый response (включая binary handlers, error paths, OPTIONS, SSE) автоматически инжектит defaults без правки 30+ call sites. Caller's explicit headers перебивают defaults через spread order.

**CORS allowlist**: `DASHBOARD_ALLOWED_ORIGINS` / `ADMIN_ALLOWED_ORIGINS` (comma-separated env). Empty default = same-origin only (самый безопасный). Когда Origin matches allowlist → ACAO=origin, Vary=Origin, Allow-Credentials=true. Иначе никакого ACAO header → браузер блочит. Wildcard `*` нигде больше не используется.

**Auth rate-limits** (in-memory Maps, sweep на каждом запросе):
- `/api/auth/verify`: cap 5 попыток / 15 мин per-sessionId. Brute-force на 6-значный код (~20 бит) теперь невозможен — после 5 неверных юзер `/start`'ит заново. В ответе на 401 поле `attemptsRemaining`
- `/api/auth/initiate`: cap 10 / 5 мин per-IP. Защита от флуда `auth_sessions` строк
- За прокси без `TRUST_PROXY=1` все IP видятся как proxy → limit становится глобальным per-VPS. Когда добавим `X-Forwarded-For` чтение, ключ Map переедет на real-IP

**Admin gate**: `POST /api/collectors/:name/toggle` мутирует **глобальный** `appState.disabledCollectors` — server-side проверка `req.user.plan_name === 'admin'`, иначе 403. Audit-лог пишет `maskId(chat_id)` админа.

**Graceful shutdown** (`dashboard.stop(timeoutMs)`, `admin.stop(timeoutMs)` — оба возвращают Promise):
1. Drain SSE: пишем `event: bye` чтобы SPA увидел нормальное закрытие
2. `server.close()` ждёт active requests до `timeoutMs` (default 10s)
3. После таймаута — `closeAllConnections()` force-close
4. В `index.js` shutdown: re-entry guard, hard-cap 15s через `setTimeout`, `Promise.allSettled([dashboard.stop, admin.stop])` параллельно

**Hard-fail env validation**: `NODE_ENV=production` + отсутствие `XAI_API_KEY` / `TELEGRAM_BOT_TOKEN` / `ADMIN_API_KEY` → `process.exit(1)`. В dev — warnings. Логика в `src/config.js` через `flag(cond, msg, level)` helper.

**Logging conventions для PII / секретов**:
- `maskId(id) → '***' + last4` для всех `telegram_chat_id` в логах. Helper inline'ится в каждый файл который логирует chat_id (dashboard, telegram, alert-dispatcher, database, support)
- **Apify token**: `Authorization: Bearer` header вместо `?token=` query-param. Если fetch() throws network-error, undici включает URL в `err.message` — Bearer держит токен вне URL-поверхности. Фикс в всех 4 коллекторах (twitter, twitter-check, tiktok, x-trends)
- **Telegram bot-токен**: новый `telegram.fetchFile(fileId) → {buffer, contentType}` который держит fetch внутри telegram-модуля. URL `https://api.telegram.org/file/bot<TOKEN>/...` не пересекает границу модуля. В catch — `err.code` (не `e.message`) на случай undici URL-leak. `getFileUrl()` помечен deprecated
- В новых местах с user-данными в логах — **всегда `maskId()`**

**HTML cache**: SPA отдаётся с `Cache-Control: no-cache, no-store, must-revalidate` чтобы deploy сразу видели новую версию. Логи / иконки / видео имеют свои `immutable` стратегии.

**Что осталось как "nice-to-have"** (не блокеры): Telegram polling → webhook (для horizontal scaling), CSP (тяжело пока SPA inline-генерится), Redis для in-memory кэшей при multi-process, log rotation если journald default не хватит. Описано в `DEPLOY.md` секция 13.

**Deploy runbook**: `DEPLOY.md` в корне — systemd unit с hardening, nginx с TLS+SSE+proxy headers, ufw rules, sqlite backup-cron, pre-launch checklist, post-launch monitoring.

## Ловушка server.js — backticks И escape-sequences в SPA-строках

`src/dashboard/server.js` и `src/admin/server.js` — огромные inline React SPA внутри **template literal**. Два класса ошибок которые `node --check` НЕ ловит:

1. **Backticks в комментариях**. Любой `` `token` `` в `//` комментарии ломает outer literal с `SyntaxError: Unexpected identifier '<token>'`. **В этих файлах никогда не писать backtick в комментариях**.

2. **Escape-sequences `\n` `\t` `\r` в строках**. `'foo\n'` внутри SPA — outer literal съедает `\n` (превращает в реальный newline) → unterminated string в браузере → `Uncaught SyntaxError: Invalid or unexpected token` → чёрный экран. **Решение**: `String.fromCharCode(10)` для newline, `String.fromCharCode(9)` для tab. Альтернатива — `\\n` (двойное экранирование).

3. **String-based `RegExp` constructor — двойная интерпретация escape**. `new RegExp('\\d+')` инсайд SPA-template-literal: outer литерал (Node) съедает один `\\` → в HTML отдаётся `'\d+'` → browser JS string literal съедает `\d` (нераспознанный escape) → RegExp получает `'d+'` (буква d, не цифры). **Решение**: четыре backslash в source — `'\\\\d+'` → Node → `'\\d+'` → Browser → `'\d+'` ✓. Regex **literal** `/\d+/` — НЕ нужно дублировать (regex parser сам интерпретирует `\d` корректно после первого уровня). Только string-аргумент `RegExp` требует двойного. `node --check` И `check-dashboard-spa.cjs` оба пропускают этот баг (синтаксис валиден, семантика сломана) — runtime regex просто не матчит.

**Проверка SPA отдельно** (ловит #1 и #2, **не** #3): `scripts/check-{admin,dashboard}-spa.cjs`. Extracts `<script>...</script>` из template literal, unescapes, прогоняет через `vm.Script`. **Запускать после ЛЮБОГО изменения** соответствующего server.js.

## Ловушка SQLite TEXT timestamps vs JS ISO

SQLite хранит `CURRENT_TIMESTAMP` как TEXT в формате `"YYYY-MM-DD HH:MM:SS"` (пробел между датой и временем, без `Z`, без миллисекунд). JS `new Date().toISOString()` даёт `"YYYY-MM-DDTHH:MM:SS.sssZ"` (с `T`). Сравнение в SQLite — **лексикографическое**: на позиции 10 пробел (0x20) < `T` (0x54) → DB-строка **всегда** меньше cutoff-строки при одинаковой дате → `WHERE col > cutoff` режется в ноль для same-day cutoff'ов.

**Симптом** (нашли 2026-05-04 на жалобе «6h окно фида показывает 0 трендов»): query «получи всё активное за последние N часов» возвращает пусто, когда `N < 24`. На 24h работает почти, потому что cutoff попадает на вчерашнюю дату — отличие идёт уже на позиции 8 ("4" vs "3"), до позиции 10 не доходим.

**Фикс**: helper `sqliteCutoff(msAgo)` в `dashboard/server.js` (~строка 113) форматирует cutoff под формат стораджа: `new Date(...).toISOString().slice(0, 19).replace('T', ' ')`. Применён в `_handleTrends`, `_handleStats`, `_handleSources`. **При написании новых date-сравнений с TEXT-колонками используй этот helper, не голый `toISOString()`.**

Тот же баг есть в `db/database.js` (retention/dedup queries), но там окна 7-30 дней — симптоматически невидим, потому что cutoff почти всегда в другой календарной дате. Не трогали в первом проходе; чистка по желанию.

## Env keys (минимальный набор)

- `APIFY_API` — generic Apify token (back-compat, used by clockworks TikTok actor по умолчанию)
- `APIFY_API_KAITO` — kaitoeasyapi Twitter actor
- `APIFY_API_XQUIK` — xquik Twitter actor (опц.)
- `APIFY_API_CLOCKWORKS` — TikTok clockworks actor (опц., если хочется отдельный токен от generic `APIFY_API`)
- `APIFY_API_APIDOJO` — TikTok apidojo actor (опц., нужен только если переключать `tiktokActor=apidojo`)
- `OPENAI_API_KEY` — Stage 1 (если provider=openai), Stage 0 nano, embeddings
- `XAI_API_KEY` — Stage 1 (если provider=xai), Stage 2 (всегда)
- `GOOGLE_AI_API_KEY` — Stage 0 Gemini primary
- `OPENROUTER_API_KEY` — Stage 0 Gemini fallback
- `STAGE0_NANO_ENABLED` — panic kill-switch
- `CLUSTER_MULTI_SIGNAL` — panic к Jaccard
- `MARKET_STAGE_DETECTION` — opt-in MarketStage
- `X_TRENDS_REFRESH_MINUTES` — X Trends refresh interval (default 30)
- `SUPPORT_BOT_TOKEN` / `SUPPORT_BOT_USERNAME` / `SUPPORT_GROUP_ID` — отдельный support-бот для тикетов (forum-topics relay). Все 3 нужны вместе, иначе бот не стартует.
- `HOT_REFRESH_ENABLED` — panic kill-switch для heavy refresh-loop (default on)
- `HOT_REFRESH_INTERVAL_MINUTES` — интервал heavy цикла (default **720** = 12h; 1440 = раз в сутки для минимума расходов)
- `HOT_REFRESH_LIGHT_ENABLED` — panic kill-switch для light metrics-only цикла (default on)
- `HOT_REFRESH_LIGHT_INTERVAL_MINUTES` — интервал light цикла (default **60** = 1h; metrics-only обновление через free fxtwitter/reddit JSON, без LLM)

**Production deployment** (см. `DEPLOY.md` для полного runbook):
- `NODE_ENV=production` — в production app падает на старте если отсутствует `XAI_API_KEY` / `TELEGRAM_BOT_TOKEN` / `ADMIN_API_KEY`. В dev — warnings
- `PUBLIC_BASE_URL` — канонический origin (например `https://catalyst.io`). Сейчас не критично, но нужно для будущих absolute links / OG-тегов
- `TRUST_PROXY=1` — флаг что app за nginx/Cloudflare. Не используется пока (нет IP-based логики), но при добавлении real-IP rate limit понадобится
- `DASHBOARD_ALLOWED_ORIGINS` / `ADMIN_ALLOWED_ORIGINS` — comma-separated CORS allowlist. Empty default = same-origin only

Полный набор + параметры PreStage / video / lookback — в `.env.example`.

## Контекст-файлы

- `ai-context/AGENT_RULES.md` — обязательные правила для агентов (читать первым)
- `ai-context/SESSION_CONTEXT.md` — этот файл (state-spec)
- `ai-context/WORKLOG.md` — последние ~10 entries, append на верх
- `ai-context/WORKLOG_ARCHIVE.md` — старше 10, архив
