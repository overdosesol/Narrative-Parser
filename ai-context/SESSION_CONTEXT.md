# SESSION CONTEXT

Обновляется после каждой значимой сессии.

## Проект

- Название: **Catalyst** (единое название проекта, ранее TrendScout / Narrative Parser)
- Назначение: мониторинг трендов + алерты в Telegram/Discord
- Прод: Docker deployment

## Текущий runtime (на момент последнего апдейта)

- Dashboard: `http://37.1.196.83:8080`
- Admin: `127.0.0.1:8081` (через SSH tunnel)
- Основной деплой: `deploy.ps1`
- Linux/macOS deploy entrypoint: `deploy.sh`

## Бизнес-правила (актуально)

- Планы: `free`, `test`, `pro`, **`admin`**
  - `free`: бесплатно, Reddit + Google Trends, history_days=3
  - `test`: $5, 1 день, one-time на аккаунт, все источники включены, X Analysis недоступен
  - `pro`: $100, 30 дней, все источники, X Analysis, api_access=1
  - `admin`: бесплатно, все источники, alert_limit=-1, history_days=-1 (безлимит), api_access=1
- Alerts: безлимит для всех планов (`alert_limit = -1`); history_days = -1 означает безлимит (не применяется в query-логике)
- В меню выбора подписки (Telegram) теперь отображается Free-план с описанием (на RU и EN)
- В поле "Дней" (бывш. "История (дней)") в админке — поддержка чекбокса ∞ (устанавливает -1); то же для Алертов/день

## Важные технические решения

- Единый Docker flow (без параллельного PM2 runtime)
- Деплой-файлы упрощены: `deploy.ps1` (Windows) и `deploy.sh` (Linux/macOS), `DEPLOY_NOW.ps1` удалён
- Admin API закрыт с внешнего доступа (localhost-only bind)
- Dashboard API только по `X-API-Key` header
- Query auth (`?apiKey=`, `?key=`) убран
- В админке добавлено управление AI provider/model (`xAI` / `OpenAI`) через `GET/POST /api/ai-config`
- В админке добавлен список моделей по API (`GET /api/ai-models`) с curated-фильтрацией
- Stage 1 scoring использует выбранный provider/model, Stage 2 `x_search` принудительно через Grok (xAI, `grok-4-1-fast-non-reasoning`)
- Для OpenAI `gpt-5-mini` добавлен авто-ретрай без `temperature` (иначе модель отвечает 400)
- Тикерная логика удалена end-to-end: `suggestedTicker` больше не запрашивается у AI, не сохраняется в `raw_metrics`, не выводится в dashboard/telegram
- **Alert gate переведён на единую метрику `alertScore`** (2026-04-22, заменил 3 независимых гейта):
  - `alertScore = w_meme·memePotential + w_viral·virality + w_emerg·emergence + w_x·twitterScore + w_fb·feedbackBoost − w_junk·junkPenalty − staleDecay`
  - Положительные веса (POSITIVE = meme/viral/emergence/twitter/feedback) в сумме **≤ 1.0** → скор остаётся в шкале 0-100
  - Dashboard: юзер крутит **один** ползунок «Чувствительность алертов» (0-100, stored в `users.alert_threshold`)
  - Admin: крутит веса, junk-multiplier, staleDecay (perHour/grace/cap), hardJunkStop — всё через `/api/scanner-config`
  - Gate: `alertScore >= max(user.alert_threshold, global alertThreshold)` **AND** `junkPenalty < alertHardJunkStop`
  - Формула/дефолты: `src/analysis/scorer.js` → `DEFAULT_ALERT_WEIGHTS`, `loadAlertWeights(db)`, `computeAlertScore(trend, w)`; возвращает `{ alertScore, hardJunk, breakdown }`; применено в Stage1/Stage2/heuristic/fallback путях
  - `feedbackBoost` (0-100, 50 = нейтрально) считается из live `feedback_votes` на момент gate-loop'а в `src/index.js`; < 5 голосов — pull towards 50
  - `staleDecay`: штраф `perHour * max(0, ageHours - grace)`, capped at `cap`
  - Dynamic slider limits в admin: track всегда 0..1, в `onChange` clamp к budget = `1 − Σ(других весов)`; FP quantization через integer grid (`Math.round(v * 20)`)
  - Server-side guard: sum of POSITIVE ≤ 1.0 проверяется в `_setScannerConfig` **до** commit'а любого из весов
  - `viralityThreshold` остаётся как legacy setting (используется в скоринге, не в gate)
- **Alert decisions ring buffer + viewer** (2026-04-22):
  - `appState.alertDecisions[]` (cap 500, in-memory, reset при рестарте); `recordAlertDecision(rec)` в `src/index.js`
  - Каждое решение: `{ ts, decision: 'sent'|'skipped', reason, gates[], title, source, category, alertScore, threshold, breakdown, userChatId, url }`
  - Gate-loop в `src/index.js` оценивает **все** гейты (threshold / hard_junk / source / dedup / daily / cap / send) и пишет массив `gates[{ name, passed, detail }]` — не short-circuit'ит на первом провале (кроме cap/daily — там `break`)
  - Admin page `DecisionsPage` (`src/admin/server.js`): карточки с clickable source URL, gate-chips ✓/✗ (title=detail на ховере), breakdown в моно-боксе, left-border accent по вердикту; auto-refresh 10s; filter chips (all/sent/skipped) + reason counts
  - Endpoint: `GET /api/alert-decisions?filter=&reason=&limit=` → `{ total, counts, items }`
- **NarrativeClusterer** (pre-AI слой): с **2026-04-29** позиция в pipeline = `Aggregator → cheapDedup → PreStage → Clusterer → Scorer` (см. ниже Pipeline order PR-2). Multi-signal similarity (embeddings + image hash + entity overlap + ticker + time penalty), Jaccard оставлен как fallback. Routing: `priority`/`stage1`/`save_only`/`drop` через `emergenceScore`
- **EmergenceScore** (0–100): три пути — `max(spread, breakout) + ideaBoost`, cap 100
  - Spread: платформы(0–30)+velocity(0–25)+organicSpread(0–20)+noveltyStage(0–15)+authorDiversity(0–10)
  - Breakout: для одиночного вирусного поста (views/likes/retweets/engRate) — detects Twitter/TikTok breakout; dampened by `_normalizeBreakoutByFollowers(score, peakFollowers, engRate)` для мега-аккаунтов
  - **IdeaBoost** (additive, 0–12): Reddit upvotes >=10k→+5, >=15k→+8, >=30k→+10, >=60k→+12; метод `_computeIdeaBoost(items)`
  - **isEarlyIdea** flag: `emergence 20–50 && upvotes >= 10k` — добавляется в `clusterMetrics`
- **AdoptionScore** (0–100): alias для `memePotential` из AI (Stage 1); семантика = "насколько нарратив мемный и липкий"
- **narrativePhase**: `early`/`forming`/`strong`/`saturated`; вычисляется после AI из emergence+adoption; `saturated` = adoption>=60 && emergence<25
- **rankScore**: `e*0.4 + a*0.6` (с опциональным feedback bias ±15%); default sort в dashboard
- **Alert gate**: `emergence >= 20 || adoption >= 60` — иначе алерт не отправляется (снижено с 30 → 20 для ранних Reddit сигналов)
- **JunkFilter** (изолированный слой + positive-signal boost): `src/analysis/junk-filter.js`; call sites помечены `[JUNK_FILTER]`
  - `calculateJunkPenalty(items, clusterMetrics, activePreset, overrides)` → `{ junkPenalty, junkReasons, memeShapeBoost, memeShapeSignals }`
  - Penalties конфигурятся через **`src/analysis/filter-profiles.js`** (per-preset), редактируются в админке; defaults: politics +40, kpop/fandom +30, celeb-noise +20, no-meme-shape +15
  - Safe-signal override: animal/absurd/meme/heartwarming → делим raw на 3 (или 4 при ≥2 сигналах). Срабатывает только если `raw > 0`
  - **Meme-shape boost** (2026-04-22): дополнительный additive bonus к `emergenceScore` при наличии meme-shape сигналов. Per-preset `memeShapeBoost` (general 10, animals 14, culture 12, celebrities 6, events 4), формула `perSignalBoost * (signalCount >= 2 ? 1.5 : 1)`; применяется в clusterer до routing
  - Alert gate (hard stop): `junkPenalty >= alertHardJunkStop` (default 70) → skip; мягкий штраф через `alertScore` weights
  - Сохраняется в `raw_metrics` + `_formatTrend` → dashboard API; `memeShapeSignals[]` — для наблюдения
  - Observability: `JunkStatsSection` в админке + `GET /api/junk-stats?hours=…`
  - Отключить: удалить import + `base.junkPenalty`/`memeShapeBoost` блок в `clusterer.js` + hardJunk gate в `index.js`
- **MarketStage** (изолированный optional слой): feature flag `MARKET_STAGE_DETECTION=1`; 4 состояния: `none/tokenizing/live/overheated`; вся логика в `src/analysis/market-stage.js`; call sites помечены `[MARKET_STAGE]` (~10 строк в 6 файлах); по умолчанию ВЫКЛЮЧЕНО
- **Dashboard**: `TrendCard` — два бара (🌊 Emergence, 💊 Adoption) + phase accent border + `PhaseBadge`; sort: rank(default)/meme/emergence/time/virality; filter by phase: early/forming/strong/saturated
- **Inference cost optimizations (v3.1)**:
  - Feedback context строится один раз на цикл в `_buildFeedbackContext()`, не на каждый batch
  - `_callResponsesAPI` возвращает `{ text, inputTokens, outputTokens }` (реальные токены из `data.usage`)
  - Stage 1 batch size: 5 → 8
  - Stage 2 gate: threshold 78 → **60** (2026-04-22, больше пропускаем в deep-dive после narrative pivot), cap **3** на цикл (после 2026-04-29; раньше 6), skip google_trends, novelty gate (`clusterMetrics.isNovel !== false`)
  - Stage 2 output: `narrativeMomentum` + `organicity` (заменили `existingCoins` — coin-search логика убрана целиком). 2026-04-27: убраны `xSentiment` и `adjustment` (никем не читались)
  - Prompt: description truncated 250 → 100; поля `titleRu` и `isGenuinelyInteresting` удалены из output spec
  - Логируется `total_in`/`total_out` (реальные токены) после каждого цикла
- **Stage 2 cost knobs** (2026-04-27, обновлено 2026-04-29):
  - `x_search` теперь вызывается с явными параметрами: `max_search_results: 5` (env `XAI_STAGE2_MAX_RESULTS`, default снижен 10 → **5** в 2026-04-29), `from_date` за 48h (env `XAI_STAGE2_LOOKBACK_HOURS`, default 48), `sources: [{type:'x'}]`, `return_citations: false`
  - `max_tool_calls: 2` в body (env `XAI_STAGE2_MAX_TOOL_CALLS`, default 2) — Grok не может делать >2 последовательных x_search в одном ответе. Без этого fan-out в 3-4 вызова раздувал input квадратично
  - STAGE2_SYSTEM_PROMPT сжат ~750 → ~330 токенов: убраны inline-примеры (Punch monkey/Moo Deng/Hawk Tuah — Grok их знает) и дублирующие IMPORTANT
  - `storyHook` cap 80 chars при парсинге (был 100-150 prose)
  - `market-stage.js applyStage2MarketPatch` теперь no-op stub (читал `adjustment` + `existingCoins`, оба удалены; вызов оставлен для будущего)
  - **2026-04-29**: Stage 1 `explanation` json_schema `maxLength: 220` (strict-enforced на модели). Stage 2 `buildStage2Prompt` сжат + defensive `aiExplanation` cap 220 chars
  - **Текущая стоимость Stage 2**: ~$153/мес (1 call/cycle × 96 cycles/day × 5.3¢). До 2026-04-29 было ~$288/мес. Подробный анализ batch / Apify / mini-replacement вариантов (всё отклонено) — см. WORKLOG 2026-04-29

## AI модели (UI curated)

- xAI: `grok-4-1-fast-non-reasoning`, `grok-4-fast-non-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-3-mini`
- OpenAI: `gpt-4.1-mini`, `gpt-4.1`, `gpt-4o-mini`, `gpt-4o`, `gpt-5-mini`, `gpt-5`, `gpt-5.4-mini` (default), `gpt-5.4-nano`, `gpt-5.4`

### Stage 1 calibration examples (admin-curated)
- Таблица `stage1_examples` (`kind`, `title`, `category`, `meme_potential`, `rationale`, `enabled`, `sort_order`). Сидится 9+3 примерами на первой миграции (маркер `stage1ExamplesSeededV1`)
- Scorer: `_buildExamplesContext()` рендерит enabled rows в 2 блока — «CALIBRATION EXAMPLES» (с category/score/rationale) и «COMMON MISTAKES TO AVOID». Sysmsg композиция: `SYSTEM_PROMPT + examplesContext + feedbackContext` (static → semi-static → volatile для max cache hit)
- Admin: вкладка «🎓 AI Examples» (`ExamplesPage`) — CRUD + tabs Examples/Mistakes + preview byte-identical того что попадёт в промпт + budget bar (Активных / Токенов / Cost). 2026-04-28: Cost теперь динамический — `tokenEst × $0.075/M (cached) × 21600 циклов/мес`; для дефолтных 12 примеров (~555 ток) показывает `≈ $0.90/мес`. Tooltip раскрывает формулу
- API: `GET/POST /api/stage1-examples`, `PUT/DELETE /api/stage1-examples/:id`. Валидация на boundary (`_validateStage1Example`): kind enum, category enum, title 5-200, rationale 10-400, memePotential 0-100. Soft cap 50 records
- Применяется на следующем цикле скоринга (~2 минуты), не требует рестарта. Cache invalidates на каждом edit, но в пределах одного цикла все батчи хитают

### Stage 1 (OpenAI only) — фичи Responses API
- **Default model**: `gpt-5.4-mini` (knowledge cutoff Aug-2025, reasoning-capable). Авто-кэш SYSTEM_PROMPT (~1.2K tokens) даёт реальную цену ≈ ×1.1 vs `gpt-4.1-mini`
- **Structured Outputs (json_schema)**: `STAGE1_RESPONSE_SCHEMA` экспортится из `prompts.js`; передаётся в `text.format` ТОЛЬКО для `provider === 'openai'`. Гарантирует shape `{trends: [...]}` → ноль parse-failures. Для xAI/Grok schema не отправляется, парсер фолбэчит на `parsed.trends || parsed.results || [parsed]`
- **Reasoning effort**: env `OPENAI_REASONING_EFFORT` (`minimal|low|medium|high|<empty>`, default `low`). Только для OpenAI provider. Не-reasoning модели (gpt-4.1-mini и т.п.) автоматически ретраятся без `reasoning` через 400-error path в `_callResponsesAPI` (зеркало existing temperature-retry)

### Stage 0 PreStage — text + visual enrichment (2026-04-28)
- **Purpose**: Stage 1/2 видели только текст → слепы для visual-driven мемов (TikTok с `#tungtungtungsahur` и пустым description). PreStage обогащает каждый трейнд machine-generated метаданными ПЕРЕД scoring'ом
- **Контракт**: НИКОГДА не фильтрует, не скорит, не дропает. Все входные трейнды одинаково проходят дальше. Failures degrade silently (`trend.preStage = null` → Stage 1 видит то же что раньше)
- **Sub-stages** (запускаются параллельно через `Promise.all`):
  - **Nano** (`gpt-5.4-nano` через OPENAI_API_KEY) — text-only enrichment. Batched JSON-schema call. Output: `topicSummary` (1-sentence rephrasing), `entityCanonical[]` (proper nouns), `language` (ISO 639-1), `slangDecoded`. **Kill-switch** (2026-04-29): env `STAGE0_NANO_ENABLED=0` (panic) + DB setting `nanoEnabled` (admin toggle, runtime). Под A/B-тестом — гипотеза что gpt-5.4-mini делает 80% этой работы натуральным образом
  - **Nano inputs** (расширены 2026-04-29): кроме title+description (cap 600 chars) теперь видит `r/<subreddit>`, `#<sourceHashtag>`, `by @<author>`, `link:<domain>` (если домен не из standard feed-list), и `RelatedPosts:` — sibling titles из текущего кластера (top 5 by engagement, dedup нормализацией). Метрики (views/likes/velocity) НЕ передаются — nano enricher, не scorer
  - **Gemini Captioner** — failover-architecture (см. ниже): primary Google AI direct + fallback OpenRouter. Output: `visualCaption`, `visibleText`, `mood`, `mediaType`, `videoSummary`, `videoDurationSec`, `videoTruncated`, `provider`
- **Failover policy для vision**:
  - **Primary**: Direct Google AI Studio (`generativelanguage.googleapis.com`) — поддерживает images и native video через `inlineData` base64. Геоограничение (Germany supported). Дешевле OpenRouter
  - **Fallback**: OpenRouter `gemini-2.5-flash` (image-only — для видео всегда poster). Срабатывает на 429, 403 FAILED_PRECONDITION, 5xx, download failures
  - **Cooldown circuit-breaker**: 3 неудачи Google подряд → 5 мин принудительно через OpenRouter. Первый успех после окна снимает блок. Параметры `STAGE0_GOOGLE_COOLDOWN_*`
- **Видео policy** (обновлено 2026-04-29): `ffprobe` замеряет длительность; если ≤ `STAGE0_VIDEO_MAX_SEC` (default **60**, было 30) — Google native video (download → base64 → inlineData). Если длиннее — poster через failover-цепочку. Sopровождающие лимиты: `STAGE0_VIDEO_MAX_MB=40`, `STAGE0_GEMINI_TIMEOUT_MS=90000`
- **`videoUrl` source of truth**: коллекторы (twitter `:411`, reddit `:350`) кладут URL в `trend.metrics.videoUrl`, не top-level. До 2026-04-29 captioner читал `trend.videoUrl` (top-level) и получал undefined — нативное видео НИКОГДА не пробовалось. Фикс: `videoUrl = trend.videoUrl || trend.metrics?.videoUrl`. TikTok-коллектор `videoUrl` не выставляет вообще (только thumbnail), поэтому TikTok-тренды останутся image-only пока не достанем MP4 из Apify response
- **Persistence**: `trend.preStage` сохраняется в `raw_metrics.preStage` (без новых колонок), восстанавливается через `_hydrateTrendFromDb` — повторный просмотр в админке не платит дважды
- **Stage 1 prompt**: `buildAnalysisPrompt` добавляет к каждой trend-секции строки `Topic:`, `Entities:`, `Slang:`, `Visual:`, `Video:`, `VisibleText:`, `Mood:`. SYSTEM_PROMPT расширен блоком «PRESTAGE METADATA (when present)» с явной инструкцией: trust visual over title когда они противоречат, не авто-бустить score за наличие метаданных
- **Стоимость**: ~$50-70/мес при ~30 трейндов/цикл, 720 циклов/день. OpenRouter активируется только при failover — обычно <5% запросов туда уходит
- **Файлы**: `src/analysis/{nano-classifier,gemini-captioner,pre-stage}.js` (новые); `scorer.js`, `prompts.js`, `db/database.js`, `admin/server.js`, `index.js`, `.env.example` (модифицированы)
- **ENV ключи (минимум один из двух)**:
  - `GOOGLE_AI_API_KEY` (primary, native video) + `GOOGLE_AI_MODEL=gemini-2.5-flash`
  - `OPENROUTER_API_KEY` (fallback) + `OPENROUTER_VISION_MODEL=google/gemini-2.5-flash`
  - Параметры: `STAGE0_VIDEO_MAX_SEC`, `STAGE0_VIDEO_MAX_MB`, `STAGE0_IMAGE_MAX_MB`, `STAGE0_GEMINI_TIMEOUT_MS`, `STAGE0_DOWNLOAD_TIMEOUT_MS`, `STAGE0_GEMINI_CACHE_TTL_SEC`, `STAGE0_GOOGLE_COOLDOWN_FAILURES`, `STAGE0_GOOGLE_COOLDOWN_MS`, `STAGE0_NANO_MAX_BATCH`
- **Kill switch**: оба ключа пустые → vision сабстадия molча skipped, nano работает соло. Если только Google → нет fallback при failure. Если только OpenRouter → нет native video (всегда через poster)
- **Admin SubmitPage**: секция «🎨 Stage 0 PreStage (контекст для скорера)» — фиолетовый блок с двумя под-блоками (Nano text + Gemini visual). Показывает `videoTruncated: true` когда был fallback на poster

### Pipeline order (актуально 2026-04-29 после PR-2)
```
collect → cheapDedup → PreStage → Cluster (multi-signal) → Stage 1 → Stage 2 → Save → Alerts
```
- **PreStage перед Cluster** — clusterer теперь использует Gemini's `videoSummary`/`visualCaption` и nano's `entityCanonical` для multi-signal similarity (см. ниже). На первом цикле уже есть данные, не на втором как было до PR-2
- **cheapDedup** — новая стадия в `clusterer.cheapDedup(items)` (zero-API). Бакеты по `(source, normalised-title)` и по `url` — collapse exact-text/url дубли ДО PreStage чтобы не платить Gemini за copypaste-цепочки. Логирует `cheapDedup: N → M` только когда что-то схлопнулось
- **save_only теперь тоже получают PreStage** — данные сохраняются в `raw_metrics.preStage`, будущие циклы берут из кэша
- **`scorer.preStage.enrichBatch` вызывается только в admin manual-submit** (минует index.js); в нормальном flow это no-op через idempotency guard `'preStage' in t`

### Multi-signal clustering (PR-1, 2026-04-29)
- **Заменили Jaccard на тайтлах** на weighted similarity score из 4 сигналов; пороги/веса в DB-настройках, тюнятся через админку без передеплоя
- **Сигналы и веса (defaults)**:
  - `clusterWeightEmbedding=0.40` — `text-embedding-3-small` cosine (1536-dim, L2-normalised). Cosine 0.5..1.0 squashed в 0..1
  - `clusterWeightPhash=0.30` — dHash thumbnails (sharp resize 9×8 grayscale → adjacent-pixel diff → 64-bit BigInt). Hamming < 16 = soft match
  - `clusterWeightEntity=0.20` — `entityCanonical[]` overlap (требует nano включённого; кросс-языковой буст «Илон Маск» = «Elon Musk»)
  - `clusterWeightTicker=0.10` — shared `$TICKER` regex `\$[A-Z]{2,10}\b`. Разные тикеры → ×0.85 на final score
  - `clusterTimePenaltyHours=24` — линейный damp 1.0 → 0.7 если items >24h apart
- **Threshold**: `clusterSimThreshold=0.55`. Renormalisation: если сигнал `null` (нет картинки / nano выключен / OpenAI лёг) — вес перераспределяется по остальным
- **Защитные сетки**:
  - `CLUSTER_MULTI_SIGNAL=0` env → panic switch к Jaccard
  - Если ВСЕ сигналы null → автоматический fallback на Jaccard. Лог `strategy=multi-signal|jaccard-fallback`
  - Embeddings + hash оба NEVER throw, в худшем случае возвращают null
- **Файлы**: `src/analysis/embeddings.js` (new, ~150 строк), `src/analysis/image-hash.js` (new, ~190 строк), `clusterer.js` (refactor: `route()` async, `_clusterBySimilarity`, `_similarity`, `_embeddingText`, `_pickHashUrl`, `cheapDedup`)
- **Стоимость**: <$1/мес добавки (embeddings $0.0001/цикл, hash локально)
- **Latency**: route() с ~10ms (Jaccard) → ~1.5-2.5s (один OpenAI batch + parallel image fetches с concurrency 4)
- **Sharp как dependency**: `sharp ^0.34.0` в `package.json`. Prebuilt бинарники — Docker rebuild +30-60s, runtime — без apk-зависимостей (libvips bundled в `@img/sharp-libvips-linuxmusl-x64`)
- **Reminder**: `npm ci` требует sync lock-file → после ЛЮБОГО `dependencies` change запускать локально `npm install --package-lock-only` ДО `deploy.ps1` (см. ловушку в WORKLOG)

### Stage 2 cost knobs (2026-04-29 update)
- `stage2MaxCalls` default 6 → **3** (DB-tunable через `stage2MaxCalls` setting в админке)
- `XAI_STAGE2_MAX_RESULTS` default 10 → **5** (env). Главный рычаг — снижает sources × $5/1000 (это 94% стоимости Stage 2)
- `XAI_STAGE2_MAX_TOOL_CALLS=2` (без изменений; ещё $73/мес можно сэкономить понизив до 1, но качество может пострадать)
- Stage 1 `explanation` field: json_schema `maxLength: 220` (strict) → модель физически не возвращает >220 chars output. Раньше «1-2 sentences» → 300-500 chars
- **Текущая стоимость Stage 2**: ~$153/мес при 1 call/cycle × 96 cycles/day. До PR было ~$288/мес
- **x_search billing мнемоника**: `$5 per 1000 sources, NOT per call`. `max_results=5 × max_tool_calls=2 = 10 sources × $0.005 = $0.05` на Stage 2. Plus Grok токены ~$0.003. **Итого ~5.3¢ на Stage 2 вызов**

### Nano kill switch (2026-04-29)
- ENV `STAGE0_NANO_ENABLED=0` — panic switch (force-disable, читается в constructor)
- DB setting `nanoEnabled` (default `'1'`) — admin runtime toggle, читается на КАЖДЫЙ batch (no restart)
- API: `GET/POST /api/prestage/nano[/toggle]`
- UI: «🎨 Stage 0 — PreStage» секция в админке (`PreStageSection`) рядом с ScannerConfigSection. Карточка nano (toggle), карточка Gemini (read-only — у gemini свой failover)
- При выключении: log `[NanoClassifier] skipped — disabled via admin panel`. PreStage работает соло на gemini
- **Hypothesis тестируется в проде**: gpt-5.4-mini в Stage 1 делает 80% работы nano натуральным образом. Уникальный сигнал nano — `entityCanonical` для cross-language clusterer entity-overlap (вес 0.20 в multi-signal). Через неделю A/B решение остаётся ли nano

### Dashboard inline reason editor (2026-04-29)
- В `TrendModal` после голоса 👍/👎 — textarea «Почему такая оценка?» (≤240 chars), Save/Clear, Cmd+Enter
- Только в modal variant; feed-карточки чистые
- Endpoint `POST /api/trends/:id/feedback` поддерживает: vote-only (как раньше), reason-only (без `vote` → не трогает голос), vote+reason
- DB helper `getUserVoteWithReason(trendId, chatId)` → `{vote, reason}` одним запросом
- Stage 1 промпт уже видит reason через `_buildFeedbackContext` (`getLikedNarratives`/`getDislikedNarratives` → `topReason` field) — никаких scorer-правок не нужно

### TikTok video limits (2026-04-29 update)
- `STAGE0_VIDEO_MAX_SEC` 30 → **60**
- `STAGE0_VIDEO_MAX_MB` 20 → **40** (60s видео в high-bitrate легко 25-30MB)
- `STAGE0_GEMINI_TIMEOUT_MS` 45000 → **90000** (60s upload + processing на slow connection)
- Стоимость: Gemini ~1 frame/sec → 60s видео ≈ 10-14K input tokens × $0.30/M = ~$0.004. <$1/мес добавки

### Gemini captioner reliability hardening (2026-04-29)
Долгая дебаг-сессия по жалобе «Gemini описывает только 1 кадр» вскрыла 4 проблемы. Все пофикшены, кроме 3 косметических TODO ниже.
- **Payload guard ПЕРЕД отправкой в Google** (`_tryGoogleMedia`): refuse to ship если `buffer.length === 0` или `_sniffImageMime/_sniffVideoMime(buffer)` returns null. Это спасает от reliable 400 INVALID_ARGUMENT когда CDN отдаёт HTML/0-bytes/redirect (Twitter image URL'ы протухают молча: HTTP 200 + HTML body). Подтверждено curl-репродукцией. Лог при срабатывании содержит `bufferBytes`, `downloadContentType`, `first16` hex, `preview` 80 байт ASCII, `url` — за один WARN сразу видно что прилетело
- **`truncationReason` field** в gemini-captioner output: `'duration_exceeded'` (видео длиннее cap'а) / `'native_unavailable'` (Google video failed/cooldown → fell on poster) / `null`. Плюс `videoMaxSec` для UI. Админ-бейдж в `admin/server.js:4060` ветвит на 3 варианта вместо хардкода «видео > 30s, использован poster»
- **4xx vs 5xx differentiated logging** в `_tryGoogleMedia`: 4xx → полный errBody + structured meta (sentMime, bufferBytes, headContentLength, downloadContentType, url, trendTitle, trendSource); 5xx → `.slice(0, 200)` чтобы во время Google-инцидентов не флудить. Маркер `(CLIENT ERROR — investigate)` в 4xx-логе сразу подсказывает оператору что копать
- **Docker log rotation**: `docker-compose.yml` 10m × 3 → **50m × 5** (30 MB → 250 MB ring buffer для `docker logs`). Persistent file-log в `/logs/{date}.log` (named volume `catalyst_logs`) пишется параллельно и переживает ребилды — единственный надёжный путь дебажить пост-фактум, потому что `docker logs` стирается при `docker compose up -d --build`
- **TODO (мелкие, не сделано)**:
  1. Hardcoded `"FIRST 30 SECONDS ONLY"` в video prompt (`gemini-captioner.js:335`) — заменить на `${this.videoMaxSec}` чтобы синхронизировалось с env-варом
  2. `OPENROUTER_VISION_MODEL=google/gemini-3.1-flash` в `.env.example` — несуществующая модель, фоллбэкает на 2.5-flash с warn'ом каждый цикл. Поменять на `google/gemini-2.5-flash` напрямую
  3. На production-сервере `.env` всё ещё `STAGE0_VIDEO_MAX_SEC=30` — `sed` + `docker compose up -d` синкнут

### Lifespan keywords — single source of truth (2026-04-28)
- Файл `src/analysis/lifespan.js` экспортит `LIFESPAN_VALUES = ['flash','short','medium','long']`, `LIFESPAN_DESCRIPTORS`, `normalizeLifespan(v)`, `assertCoversLifespans(name, map)`
- **Все потребители импортят из этого модуля**: `prompts.js` (schema enum + текст промпта), `scorer.js` (normalize AI-ответа), `dashboard/server.js` (normalize при чтении из БД + инжект массива в SPA через `${JSON.stringify(LIFESPAN_VALUES)}`), `i18n/en.js`+`ru.js` (assert при загрузке модуля), `notifications/telegram.js` + `formatter.js` (normalize перед lookup)
- **Гарантия**: переименование/добавление значения в `LIFESPAN_VALUES` ломает `import` i18n-модулей синхронно с человеко-читаемой ошибкой `<map> is missing lifespan keys: [...]`. Бот не стартанёт пока не дополнишь карты — больше нет тихого `'—'` в UI
- Старые DB-строки с descriptive формой (`"flash (hours)"`) нормализуются на лету в `normalizeLifespan` — миграция БД не нужна

## Контекст-файлы

- Используются: `ai-context/AGENT_RULES.md`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`
- `ai-context/NEXT_STEPS.md` удалён (по решению владельца)

## Feedback (взвешенный фидбек)

- **Реакции**: только 👍 и 👎 обрабатываются; все остальные смайлики игнорируются
- **Хранение**: новая таблица `feedback_votes` — `UNIQUE(trend_id, chat_id)`, один голос на пользователя на тренд; поля: `vote (+1/-1)`, `weight`, `plan_name`
- **Взвешивание**: метод `_feedbackWeight(chatId)` в `telegram.js` — достаёт план пользователя из БД, применяет веса из settings
- **Пересчёт**: `trends.user_feedback` = `ROUND(SUM(vote * weight))` по `feedback_votes` после каждого голоса
- **Настройка в админке** (BotPage): секция "👍 Взвешенный фидбек"
  - Toggle вкл/выкл (`feedbackWeightingEnabled`)
  - 4 числовых поля: `feedbackWeightAdmin` (def=**5**), `feedbackWeightPro` (def=**2.5**), `feedbackWeightTest` (def=**0.5**), `feedbackWeightFree` (def=**0.2**) — ребаланс 2026-04-27, admin теперь ×25 vs free
  - API: `GET/POST /api/feedback-config`
  - Одноразовая миграция: маркер `feedbackWeightsRebalancedV2='1'` в settings гарантирует что переписываем только при первом старте; ручные правки оператора затем не затираются
- **Режим выключено**: учитываются ТОЛЬКО голоса Admin (weight=1); все остальные получают weight=0 → не влияют на `user_feedback`
- **Статистика**: `db.getFeedbackStats(trendId)` → `{ likes, dislikes, weightedScore }`

### Reason-for-rating wizard (Telegram, 2026-04-27)
- После 👍/👎 в callback feedback handler'е keyboard алерта получает доп ряд `✏️ Причина оценки` (callback `fb_reason:<trendId>`); при снятии голоса ряд убирается. Реакции эмодзи (не buttons) wizard НЕ запускают
- Клик `fb_reason:` → `_awaitingInput.set(chatId, {type:'feedback_reason', trendId, startedAt})`. Следующий не-командный текст ловится в `bot.on('message')`, проходит cap **240 chars**, идёт в `db.setFeedbackReason(trendId, chatId, reason)`. `/skip` отменяет. 5-минутный timeout на state
- Колонка `feedback_votes.reason TEXT` (NULL = no reason). При смене направления голоса reason обнуляется автоматически в `recordFeedback`
- AI-promp injection: `_buildFeedbackContext` в scorer.js рендерит `+ "Title" [category] — "reason"` (cap 120 chars per item). `getLikedNarratives`/`getDislikedNarratives` фильтруют через `weight >= 0.5` ИЛИ непустой reason — голые free-голоса без обоснования больше не попадают в промпт. Юзер пишет на любом языке, AI отвечает на английском
- Дашборд: панель «💬 Причины оценок (последние)» в SettingsPage под weights блоком; эндпоинт `GET /api/feedback-recent?limit=N` (default 30, max 100)

## Известные нюансы

- Если Telegram показывает старые кнопки/тексты, нужен повторный вызов меню (`/menu`) или обновление сообщения.
- Коллекторы могут быть отключены через admin settings; проверяй `disabledCollectors`.
- xAI API может отдавать `429` при исчерпании кредитов; в UI используется curated fallback для списка xAI-моделей.
- Если в алерте видно `🤖 AI unavailable`, проверь логи scorer (чаще всего это upstream API error или fallback после 400/429).
- В исторических строках `trends.raw_metrics` может оставаться legacy-поле `suggestedTicker`; для новых записей поле больше не пишется.
- Для быстрого снижения шума рекомендованный порядок: сначала поднять `viralityThreshold` (70 -> 75), затем при необходимости `alertThreshold`.

- Dashboard/Admin UI shell update (2026-04-18):
  - dashboard and admin were pushed toward a darker "ops / terminal / memecoin tool" style in `src/dashboard/server.js` and `src/admin/server.js`
  - dashboard top source strip now always includes all core sources, including `TikTok` at zero count
  - dashboard `����������` button is no longer dead; it switches to a real overview/stats mode
  - dashboard has a right-side intelligence rail (`Session Pulse`, `Hot Now`, `Sources`, `Category Focus`); on narrow screens this rail uses internal scroll to avoid clipping
  - temporary explanatory copy that was briefly added to dashboard/admin was removed after review
  - quick rollback files exist: `.codex-backups/dashboard.server.before-2026-04-18.js`, `.codex-backups/admin.server.before-2026-04-18.js`

## Dashboard v3.2 UX (2026-04-20)

- **Темизация**: 7 dark-тем через `body[data-theme="..."]` (Midnight / Teal / Abyss / Violet / Acid / Sunset / Cyberpunk). Ключ localStorage: `ts_theme`. Все акценты используют CSS var `--accent-rgb` для `rgba(var(--accent-rgb), α)` паттерна — нового hardcoded rgba быть не должно
- **Layout**: CSS Grid с draggable column dividers (`.col-resizer` между sidebar/main/rail); prefs в `ts_prefs_v1.colLeft/.colRight`; limits 180–540 / 240–630px; double-click = reset
- **Навигация**:
  - Top-right: Account button (аватарка + `@username`, открывает Account sheet) + ⚙️ Settings gear
  - Bottom-left nav: Feed + Stats (Settings перенесены наверх, чтобы не дублировались)
  - Phase filter (All/Early/Forming/Strong/Saturated) — в sidebar, не в тулбаре
  - Esc: закрывает модалку / модальный trend / возвращает в Feed из Stats
- **Modal sheets**: Settings / Account / Stats открываются как центрированные модальные окна с `backdrop-filter: blur(14px)` и затемнением; body scroll lock; закрываются по Esc, клику по фону или ✕. Лента (`dashboard-grid`) всегда рендерится под оверлеем. Компонент: `Sheet`. Классический 2-col layout удалён
- **AccountPanel** — отдельная панель (hero card + аватар + plan badge + подписка + threshold + logout). `Row`/`Toggle` на module-scope (ранее были внутри SettingsPanel — приводило к ReferenceError)

### Dashboard modal updates (2026-04-28)
- **Stats grid в TrendModal**: 6 ячеек ровно 3×2 — Meme score / Срок жизни / Виральность // Сентимент / **Платформ** / **Скорость**. Метрика «Видели N раз» удалена (не несла полезного смысла — счётчик повторных скан-detection'ов одного и того же URL). Поле `times_seen` в БД и `timesSeen` в payload оставлены для возможной аналитики, фронт игнорирует
- **Платформы**: `uniquePlatforms` — 1 = серое; ≥2 = зелёное `🌐 N` + tooltip «Кросс-платформа»
- **Скорость**: `velocity` через `fmtVelocity` → `12.5/ч ↑` / `12.5/h ↑`; 0 → dim `—`
- **Modal media фиксы**: `body.prefs-compact .img-carousel.in-modal { height: 440px }` явно перебивает базовый compact-override (CSS specificity wars); `video.modal-image { aspect-ratio: 16/9; height: 100% }` — без этого `<video>` до загрузки metadata схлопывался в плоский 2:1 letterbox; `.modal-image-wrap { min-height: 260px }` — страховка от Twitter poster'ов с экзотическим crop'ом

## Telegram avatar → dashboard (2026-04-20)

- **БД**: `users.avatar_file_id`, `users.avatar_file_unique_id`, `users.avatar_checked_at` (миграция через PRAGMA-guarded ALTER); метод `db.setUserAvatar(userId, fileId, fileUniqueId)`
- **Бот** (`notifications/telegram.js`):
  - `refreshUserAvatar(chatId, userId, {force})` — `getUserProfilePhotos` → max size → save to DB; throttle 6ч; тихий fail на privacy-locked юзерах
  - Auto-delete старого файла в `data/avatars/<old>.jpg` при смене `file_unique_id` (с path-traversal guard)
  - `getFileUrl(fileId)` — `bot.getFile` → `api.telegram.org/file/bot<TOKEN>/...` (токен остаётся на сервере)
  - Hook в `/start` (включая deep-link `auth_<sessionId>`) — fire-and-forget
- **Dashboard**:
  - `GET /api/auth/avatar` — прокси с disk cache в `data/avatars/<fileUniqueId>.jpg`, TTL 7 дней через `Cache-Control: private, max-age=604800, immutable`
  - `_handleAuthMe` запускает фоновый `refreshUserAvatar` (throttled)
  - `_publicUser` отдаёт `hasAvatar: boolean`, `avatarKey: string|null` (= fileUniqueId)
  - UI (hero card + top-right): `<img src="/api/auth/avatar?token=...&k=<avatarKey>">`; onError → fallback на букву / 👤
  - `.gitignore`: `data/avatars/`
- **Смена фото в TG**: `fileUniqueId` меняется → `avatarKey` в ответе `/me` меняется → браузер перекачивает (cache-bust через query param); старый файл автоматически удаляется

## Media pipeline — видео со звуком (2026-04-20)

- **Dockerfile**: `ffmpeg` установлен в runtime-stage Alpine-образа (`apk add --no-cache ffmpeg`). Без него mux молча падал и видео были silent
- **Reddit video collector** (`src/collectors/reddit.js`): `_bestVideo(post)` — резолвит MP4 URL в приоритете `reddit_video.fallback_url` → `preview.reddit_video_preview` → direct `.mp4/.webm` → imgur `.gifv→.mp4`; результат в `metrics.videoUrl`
- **Twitter video collector**: достаёт best-bitrate MP4 из `video_info.variants`
- **Clusterer** (`src/analysis/clusterer.js`): агрегирует `videoUrl` на представителя кластера после image gallery
- **Reddit audio discovery**: `_findRedditAudioUrl(videoUrl)` — HEAD-probe кандидатов в порядке **CMAF_AUDIO_128 → CMAF_AUDIO_64 → CMAF_audio → DASH_AUDIO_128 → DASH_AUDIO_64 → DASH_audio → audio**. Reddit в 2025 мигрировал с `DASH_*` на `CMAF_*` в именовании сегментов
- **Mux flow** (`_muxRedditVideo`): `ffmpeg -c copy -movflags +faststart` (stream-copy, без reencode) → кэш в `data/video-cache/<id>.mp4`; `cleanupVideoCache(maxAgeDays=7)` вызывается при старте из `index.js`
- **Telegram alert**: multi-tier fallback — `sendVideo` (с `supports_streaming`) → `sendMediaGroup` → `sendPhoto` → text; для Reddit — попытка mux'нуть перед отправкой
- **Dashboard video player**:
  - Public route (до auth middleware) `GET /api/video/reddit/<id>.mp4?src=<encoded v.redd.it url>` с Range-support (206 Partial Content); regex-валидация `src` против `v.redd.it/<alphanum>/` шаблона; cache-first; на cache miss → `_muxRedditVideo`; если аудио нет → 302 на оригинал
  - `<video>` элементы не могут слать `Authorization: Bearer` headers — поэтому только этот маршрут public (контент и так публичный на Reddit CDN)
  - HTML5 `<video controls preload="none" poster={imageUrl}>` в `FeedImage` и `TrendModal`
- **Volume persistence**: `videoVolumeRef` ref-callback сохраняет `catalyst_video_volume` + `catalyst_video_muted` в localStorage; общий для всех плееров страницы

## "Why now" — триггер события (2026-04-20)

- **БД**: колонка `trends.why_now TEXT NOT NULL DEFAULT ''` (миграция через `addIfMissing`)
- **AI stage-1 prompt**: поле `"whyNow"` — строгая инструкция «ТОЛЬКО явный конкретный триггер (кто что сделал / что произошло); если нет — пустая строка; не спекулировать, не перефразировать заголовок»
- **Scorer**: `whyNow: (a.whyNow || '').trim().slice(0, 280)` → сохраняется в `saveTrend`
- **Dashboard**: `_formatTrend` отдаёт поле; `TrendModal` рендерит секцию `🔥 Trigger / Триггер` с красно-оранжевым стилем (`.modal-section-content.why-now`); только при непустой строке
- **Telegram alert**: строка `🔥 <b>{whyNow}</b>` над обычным AI-блоком в `formatter.js`
- **Стоимость**: +20-40 токенов на ответ, <$0.50/мес

## Персонализированный ранг — УДАЛЁН (2026-04-27)

Per-user category boost для дашборд-ранжирования был выпилен 2026-04-27 (см. WORKLOG того же дня). Оставшиеся следы:
- Колонка `users.personalization_enabled` физически в БД (SQLite не любит DROP COLUMN); никем не читается, никем не пишется. При следующей крупной миграции БД можно будет дропнуть
- Глобальные голоса по-прежнему влияют на скоринг через `_buildFeedbackContext` в scorer.js — это другой путь, **он остаётся**
- `feedback_votes` таблица + reasons wizard + взвешивание по плану — всё работает как было
- Sort=rank теперь = одинаковый глобальный порядок для всех авторизованных и неавторизованных юзеров

## Dashboard UX polish (2026-04-20)

- Infinite scroll вместо пагинации: `IntersectionObserver` на `sentinelRef`; `refreshAllRef` для стабильности SSE при смене offset
- Multi-image Telegram alerts через `sendMediaGroup` (до 10 фото, caption только на первой из-за TG 1024-char лимита)
- Top Narratives: 5 → 10 (SQL LIMIT + client .slice)
- Удалены: «Source Pulse» дубль в правой колонке, 📋 copy-title button в карточках

## Ловушка server.js — backticks И escape-sequences в SPA-строках

И `src/dashboard/server.js`, и `src/admin/server.js` — огромные inline React SPA внутри template literal. Два класса ошибок которые `node --check` НЕ ловит:

1. **Backticks в комментариях**. Любой `` `token` `` в `//` комментарии ломает outer literal с `SyntaxError: Unexpected identifier '<token>'`. Ловили 5+ раз. Правило: в этих файлах **никогда** не писать backtick в комментариях.
2. **Escape-sequences `\n` `\t` `\r` в строках**. `'foo\n'` внутри SPA — outer literal съедает `\n` (превращает в реальный newline) → unterminated string в браузере → `Uncaught SyntaxError: Invalid or unexpected token` → чёрный экран. Ловили 2026-04-27 в `ExamplesPage.buildPreview`. **Решение**: `String.fromCharCode(10)` для newline, `String.fromCharCode(9)` для tab. Альтернатива — `\\n` (двойное экранирование), но `String.fromCharCode` понятнее в diff.

**Проверка SPA отдельно** (ловит оба класса): extract `<script>...</script>` из template literal, unescape `\\\\` → `\\`, `` \\` `` → `` ` ``, `\\$` → `$`, прогнать через `vm.Script(...)`. `node --check` outer-файла недостаточно — он валидирует только outer JS.

## Twitter/X scraper — pluggable actor registry (2026-04-22)

- **Проблема**: старый `apidojo~tweet-scraper` почти не отдавал `viewCount` (X закрыл публичный доступ к просмотрам) — posts с 1M+ views практически не доходили до пайплайна
- **Решение**: актёр стал runtime-переключаемым из админки. Два варианта:
  - `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` — **default**, $0.25/1K, 17K users, 20 месяцев истории, 99%+ success
  - `xquik/x-tweet-scraper` — $0.15/1K, 1-2 месяца истории, 145 users, экспериментальный (но GitHub/сайт есть, не scam)
- **Реестр**: `ACTORS` объект в `src/collectors/twitter.js` (дубль в `twitter-check.js`) — каждая запись имеет `id` + `buildInput(query, maxItems)`. Kaito принимает `twitterContent: <string>`, xquik — `searchTerms: [<string>]`; output у обоих идентичный (`viewCount`, `likeCount`, `retweetCount`) → `_normalize` actor-agnostic
- **Per-actor tokens**: `config.apify.twitterKeys = { kaitoeasyapi, xquik }` (из `APIFY_API_KAITO` / `APIFY_API_XQUIK` в `.env`); `apiKey2` удалён полностью (был legacy-фоллбэк на второй Apify-аккаунт, больше не нужен)
- **Runtime setting**: `db.getSetting('twitterActor', 'kaitoeasyapi')` — читается в `_activeActor()` collector'а/checker'а на каждом запросе; применяется со следующего цикла без рестарта
- **Admin UI**: секция «🐦 Twitter/X scraper» в ScannerConfigSection, карточки-переключатель (как пресеты поиска); `VALID_TWITTER_ACTORS` server-side валидация
- **Key rotation removed**: старая логика `_nextKey()` / `_keyIndex` вырезана — теперь каждый актёр работает со своим одним ключом, rotation не нужна (для rate-limit'а есть delay между запросами)
- **Как добавить актёр**: (1) записать в `ACTORS` в `twitter.js` + `twitter-check.js`, (2) в `config.js` под `apify.twitterKeys`, (3) в `VALID_TWITTER_ACTORS` в admin `_setScannerConfig`, (4) карточку в `TWITTER_ACTORS` в `ScannerConfigSection`
- **Security**: Apify `General resource access` должен быть **Restricted** (не Anonymous) — иначе runId/datasetId даёт анонимный доступ к твоим данным без токена

## Apify per-script engagement thresholds (2026-04-27)

Чтобы резать low-signal азиатский фуд из Apify firehose, входной порог в `_normalize` обоих коллекторов умножается на CJK-script:

| Письменность | Twitter views (или fallback likes) | TikTok plays / likes / shares / viralScore |
|---|---|---|
| Дефолт (EN/RU/Romance/AR/...) | 500K / 10K | 50K / 1K / 200 / 40 |
| Японский (`ja`), Корейский (`ko`) | 1M / 20K (×2) | 100K / 2K / 400 / 50 |
| Китайский (`zh`) | 2M / 40K (×4) | 200K / 4K / 800 / 60 |

- Хелпер `_detectCjkScript(text)` дублируется в `src/collectors/twitter.js` и `src/collectors/tiktok.js`. Считает доли символов по непересекающимся блокам — kana (Hiragana+Katakana, японский-эксклюзив), Hangul (корейский-эксклюзив), Han (общий). Требует ≥30% CJK-доли от всех `\p{L}` → иначе `null` и дефолтный порог
- Возврат: `'ja'` если есть kana, `'ko'` если есть hangul, `'zh'` если только Han без каны/хангыля. `null` для всех нон-CJK языков
- Применяется до всей остальной фильтрации (clusterer/junk/AI); посты, не пробившие порог, отбрасываются прямо в `_normalize` и в БД не попадают
- Не путать с CJK-расширением запросов в `general` пресете (2026-04-24, добавляет 6-й слот с японскими/корейскими/китайскими частицами для увеличения coverage). Здесь — наоборот, **режем входящий поток** на стороне нормализации; query-расширение подгребает CJK твиты, а порог фильтрует низкосигнальные из них

## Env keys (2026-04-22)

- `APIFY_API` — primary Apify token (TikTok collector использует его)
- `APIFY_API_KAITO` — dedicated token for kaitoeasyapi Twitter actor
- `APIFY_API_XQUIK` — dedicated token for xquik Twitter actor
- `APIFY_API2` — **удалён** (был legacy-фоллбэк на второй аккаунт)

## Manual narrative submit + send-alert with comment (2026-04-24)

- **Новая админская вкладка `🧪 Ручной анализ`** (`src/admin/server.js` → `SubmitPage`)
  - Оператор кидает URL (Twitter/X, Reddit, TikTok, или любой сайт с og:image), проект сам резолвит → синтетический trend → прогоняет полный scorer (Stage 1 batch + Stage 2 Grok x_search) → сохраняет в БД с флагом `raw_metrics.manualSubmitted = true` (+ `manualSubmittedAt`). **Обходит** коллекторы/aggregator/clusterer — кормим scorer напрямую
  - Опциональная галочка «отправить в Telegram всем активным подписчикам» — рассылка сразу после анализа
  - Rate limit'а нет (single-user tool)
- **Endpoint `POST /api/submit-narrative`** `{ url, sendToTelegram, comment }`:
  - Коммент (optional) — до 500 символов, если есть — префиксится жирной строкой `💬 <b>{comment}</b>\n\n` перед основным форматтером
  - Возвращает `{ ok, elapsedMs, trend: {...}, alerts: [{userId, ok, reason?}, ...] }`
- **Endpoint `POST /api/send-alert`** `{ trendId, comment }`:
  - Отправляет алерт для **уже сохранённого** trend'а (любого, не только manual). Кнопка «📨 Отправить алерт» в шапке SubmitPage — после анализа можно посмотреть метрики и досылать руками
  - Грузит строку через `getTrendById` → `_hydrateTrendFromDb(row)` (восстанавливает scorer-образный объект из плоской DB-строки) → `_broadcastTrendAlert(trend, dbId, { comment })`
- **Resolvers** (free APIs only):
  - `_resolveTwitterUrl`: `api.fxtwitter.com/i/status/{id}` — text, author, engagement, `createdAt`, velocity, media из main + `quote.media.all` + `replying_to.media.all`, video pick
  - `_resolveRedditUrl`: `reddit.com/...json?raw_json=1` — title, upvotes, comments, gallery media
  - `_resolveTiktokUrl`: oEmbed API (title + thumbnail)
  - `_resolveGenericUrl`: og:image / og:title scraping
- **Refactor**: `_broadcastTrendAlert(trend, dbId, opts = {})` — единая точка рассылки по `getActiveUsers()` с `sendAlertToUser` + `attachXButton` + `updateTgUrl`. Переиспользуется из начального submit и из «Отправить алерт»
- **`sendAlertToUser(trend, user, opts = {})`** в `src/notifications/telegram.js`:
  - Новый третий параметр. Если `opts.comment` непустой — HTML-escape (`&/</>`) и префикс `💬 <b>{comment}</b>\n\n` + formatter message
  - Cap комментария 500 символов (чтобы caption после concat ещё влезал в TG 1024-лимит)
- **Dashboard integration**:
  - `_formatTrend` отдаёт `manualSubmitted: metrics.manualSubmitted === true`
  - Badge **🧪 MANUAL** в FeedCard (feed-badges row, первая позиция) и в TrendModal head; CSS `.badge-manual` (фиолетовый `#b48cff`); i18n `feed.manual_tip`
  - Sidebar toggle **«Только ручные»** — `manualOnly` state (localStorage `ts_manual_only`), фильтрация в `visibleTrends`; i18n `sidebar.manual_only`, `tooltip.manual_on/off`, `toast.manual_only_on/off`
- **AdminServer wiring**: конструктор принимает `extras = {}` 7-м аргументом, сохраняет `this.scorer` и `this.telegram`. `src/index.js` передаёт `{ scorer, telegram }` при инстансе

## Dashboard polish + TG media fixes (2026-04-24)

- **Ask Grok button** в TrendModal — зеркалит TG alert button, строит Grok URL инлайном через IIFE, CSS `.trend-link-grok` (#b48cff); i18n `modal.ask_grok`
- **Modal reorder**: ссылки/actions ушли выше (после AI explanation), Stats grid в самый низ
- **`pluralSeen(n)`** helper для счётчика «ВИДЕЛИ: N раз(а)» — исправлена русская плюрализация (1 раз / 2 раза / 5 раз через `mod10`/`mod100`); для EN просто `N + 'x'`
- **ImageGrid → ImageCarousel** — горизонтальный слайдер со стрелочками, счётчик `i/N`, точки-пагинация; `stopPropagation` на контролах. CSS `.img-carousel`
- **Multi-image в дашборде**: `/api/preview` twitter-ветка теперь собирает media из **main + quote + reply-parent** (`tweet.media.all`, `tweet.quote.media.all`, `tweet.replying_to.media.all`), отдаёт `{ imageUrl, imageUrls }`. TrendModal имеет `extraUrls` state и **лениво подфетчивает** preview при открытии даже если `trend.imageUrls.length < 2` — для старых DB-строк где quote media не сохранилось при scrape'е
- **Media group + inline buttons fix** (`src/notifications/telegram.js`):
  - Telegram API не даёт крепить `inline_keyboard` к элементам альбома — кнопки терялись на multi-image алертах
  - Фикс: `sendMediaGroup(chatId, media, { disable_notification: true })` → `sendMessage(..., { reply_to_message_id: group[0].message_id })` → якорим `attachXButton`/feedback buttons к текстовому сообщению. Альбом без caption, текст триггерит единственный ping
- **Silent photo notifications**: `disable_notification: true` на альбомах — юзеров больше не будит пачкой превьюшек
- **Twitter velocity fix** (`src/collectors/twitter.js`):
  - Был bug: `velocity: cluster._count` — всегда «1/hr» в дашборде (Reddit показывал нормально потому что там другой путь)
  - Фикс: per-tweet accumulation — `engagement = likes + retweets*2`, `age = max(ageHours, 0.25)`, `tweetVelocity = engagement / age`, аккумулируем в `cluster._velocitySum`; финально `Math.round(cluster._velocitySum || 0)`
- **Quote/reply-parent media extraction** в twitter collector: helpers `pushImagesFrom` и `pickVideoFrom` проверяют `tweet.quote || tweet.quoted_tweet || tweet.quotedStatus || tweet.quoted_status || tweet.retweeted_tweet` и `tweet.in_reply_to_tweet || tweet.in_reply_to_status || tweet.replying_to` (разные поля у Apify actors). **Правило владельца**: даже если в main твите есть картинка — добавляем quote images вторыми (2-я картинка в карусели)

## Stage 2 subject-name bonus (2026-04-24)

- **Задача владельца**: начислять баллы, если в посте есть конкретное имя/название (персонаж, питомец, тикер-кандидат — Peanut, Moo Deng, Hawk Tuah, $BONK)
- **Решение**: расширили JSON-схему Stage 2 двумя полями `subjectName` + `nameStrength`, Grok переиспользует те же x_search результаты — никаких дополнительных поисков, прирост стоимости <0.2%
- **`src/analysis/prompts.js`**: в `STAGE2_SYSTEM_PROMPT` добавлен блок «SUBJECT NAME / TICKER CANDIDATE» с рубрикой `nameStrength` 0-100, примерами «что считать именем» / «что не считать», явной пометкой **booster-only, NEVER penalizes**. В `buildStage2Prompt` добавлены два поля в JSON response
- **`src/analysis/scorer.js`** в `_stage2DeepDive`:
  - Парсинг: `subjectName` trim + cap 64 chars, `nameStrength` обнуляется если имя пустое
  - Сохраняется в `trend.xSearchData.{subjectName, nameStrength}`
  - Бонус (зеркалит `stage2StoryBonus`): threshold `nameStrength >= 60`, max **+10**, формула `Math.min(10, Math.round((nameStrength - 60) * 0.25))`
  - Metadata в `trend.stage2NameBonus = { subjectName, nameStrength, bonus, memeBefore, memeAfter }`, отдельная строка лога
  - Применяется после `stage2Penalty` + `stage2StoryBonus`, до recalculate adoption/phase/alert
- **Штрафов нет**: если `subjectName === ""` или `nameStrength < 60` — бонус просто не начисляется. Аналогично `stage2StoryBonus`
- **Итоговый cap бустеров Stage 2**: +15 (story) + +10 (name) = **+25** к memePotential максимум; штрафы идут отдельной веткой (multiplicative penaltyMult по buzz/momentum/organicity)

## Narrative pivot (2026-04-22)

- **DEGEN-PARSER persona**: `src/analysis/prompts.js` переписан с поиска монет на поиск **нарративов**. Убрана hard-rule 5 (age penalty 6h). Stage 2 теперь верифицирует narrative momentum / organicity (organic / astroturf / mixed), а не «есть ли монета на рынке»
- **Multi-source bonus удалён** (aggregator + scorer + prompts): в практике награждал news/politics (hit везде) и топил single-platform мемы. Dedup по сорсам остался как cleanup
- **Clusterer `MIN_WORDS`**: 3 → 1. Jaccard 0.40 защищает от ложных мерджей, а короткие мем-заголовки больше не теряются
- **Reddit preset alignment**: `PRESET_SUBREDDITS` keys теперь точно матчат filter-profiles (`general`/`animals`/`culture`/`celebrities`/`events`). Старые сироты (`ai`/`elon`/`sports`) удалены. Наборы curated под meme-shape (aww, dankmemes, capybara, popculturechat, etc.) вместо крипто-heavy defaults
- **Source-aware engagement labels** (`src/notifications/formatter.js`): раньше Twitter показывал «Upvotes: 101.7K», хотя в `metrics.upvotes` для Twitter лежит `likes+retweets*2`. Теперь: Twitter → ❤️ Likes, TikTok → ▶️ Plays, остальное → 📈 Upvotes. Новые i18n ключи `alertLikes`, `alertPlays`, `alertGoogleHits` (EN + RU)
- **JunkStats observation panel** (admin): `_getJunkStats(hours)` + `GET /api/junk-stats?hours=6|24|72|168` + `JunkStatsSection` React — top junk reasons, source mix, meme-shape hit rate, avg/max penalty; auto-refresh 30s; цель наблюдения: meme-shape signals ≥ 25%, no-meme-shape ≤ 50%, politics ≤ 15%
- **Blacklist слов**: отложено (легко забанить нужные теги, владелец просил подумать)
