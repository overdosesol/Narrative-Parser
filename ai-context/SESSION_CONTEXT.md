# SESSION CONTEXT

State-spec проекта Catalyst — описывает **текущее состояние**, не историю.
Дата-помеченные секции (`### X (YYYY-MM-DD)`) запрещены — это материал
для `WORKLOG.md` (правило `AGENT_RULES.md §7`).

**Lazy-read рекомендация**: в больших задачах не читай файл целиком. Используй TOC ниже + Grep по названию секции (`## <Имя>`) + offset/limit. Если нужно общее саммари по теме — делегируй haiku-агенту через `Agent({model:"haiku"})`.

---

## TOC

- **Бизнес & базовое**: Проект · Бизнес-правила · Pipeline
- **Scoring**: Per-preset pipeline configs · Alert gate · Scoring metadata · JunkFilter · Multi-signal clustering · MarketStage (opt-in)
- **AI stages**: AI provider config · Stage 0 / PreStage · Stage 2 cost knobs
- **Источники**: Apify scrapers · X Trends · TikTok specifics · Source-aware labels · Source icons
- **Фичи**: Feedback · Manual analysis · User favourites · Hot trends refresh · Tag auto-refresh · Catalyst forecast · Alert types · Support bot
- **Dashboard**: Theme system · Dashboard layout · Sidebar filters · Cat mascot
- **Admin panel**
- **Инфра**: Files map · Production posture · Ловушка server.js (SPA) · Ловушка SQLite TEXT timestamps · Env keys · Контекст-файлы

---

## Проект

**Catalyst** — мониторинг трендов + AI-скоринг + алерты в Telegram/Discord.

- Прод: Docker на VPS `136.244.82.53` (Vultr `vhf-1c-1gb`, Ubuntu 24.04, Frankfurt; переезд с `37.1.196.83` 2026-05-30 — см. WORKLOG). Deploy: `deploy.ps1` (Windows) / `deploy.sh` (Linux/macOS).
- Dashboard: **`https://catalystparser.io`** (TLS Let's Encrypt R13, через nginx reverse-proxy на Docker `127.0.0.1:8080`. `www.catalystparser.io` валиден, 80→443 редирект). Auth через `X-API-Key`.
- Admin: `127.0.0.1:8081` (loopback-only, через SSH-tunnel, `X-Admin-Key`). Доступ: `ssh -N -L 18081:127.0.0.1:8081 root@136.244.82.53` → браузер `http://127.0.0.1:18081/`.
- Auth-by-query (`?apiKey=`) отключён, только header.
- Голый IP не отвечает: Docker port биндится на `127.0.0.1:8080`, единственный путь снаружи — TLS через nginx. ufw разрешает только 22/80/443.

## Бизнес-правила

| План | Цена | Длительность | Источники | Manual Analyze | Catalyst forecast | Alerts/day |
|---|---|---|---|---|---|---|
| `free` | $0 | бессрочно | Reddit + Google Trends | 🔒 | 🔒 | ∞ |
| `test` | $5 | 1 день, one-time | все 5 | 5/день | 5/день | ∞ |
| `pro` | $100 | 30 дней | все 5 | 100/день | 100/день | ∞ |
| `admin` | $0 | бессрочно | все 5 | ∞ | ∞ | ∞ |

**Single source of truth для прав плана** — `src/billing/entitlements.js`. `getPlanEntitlements(planName)` → `{sources, manualAnalyze, catalyst, historyHours, favorites}`. Caps semantics: `-1` = unlimited (admin), `0` = blocked (free), `N>0` = N/day soft-cap (in-memory rolling 24h). Импортируется и в dashboard/server.js, и в telegram.js — одинаковые правила на сайте и в боте.

- `historyHours: 72` для free (3-day window cap), `-1` для остальных.
- `favorites: true` для pro/admin.
- Daily cap на алерты убран — алерты не платная фича. Поле `alert_limit` в схеме legacy.
- 15-min cooldown на Catalyst убран. 30-sec anti-dupe cooldown на manual-analyze оставлен.

## Pipeline

```
collect → cheapDedup → PreStage → Cluster → Stage 1 → Stage 2 → Save → Alerts
```

- **collect** — Apify-коллекторы (Reddit, Twitter, TikTok, Google Trends, X Trends).
- **cheapDedup** (`clusterer.cheapDedup`) — zero-API схлопывание exact-text/url дублей.
- **PreStage** (`pre-stage.js`) — nano + Gemini обогащают `trend.preStage`. Никогда не фильтрует. Failures degrade silently.
- **Cluster** (`clusterer.js`) — multi-signal similarity.
- **Stage 1** — AI scoring через Responses API (OpenAI или xAI).
- **Stage 2** — Grok x_search для top-кандидатов (deep narrative verification).
- **Save → Alerts** — запись в БД + alert-loop с per-user gate.

**Scan-cycle cadence**: запускается через self-rescheduling `setTimeout`-loop в `index.js → startScheduler()`. Перед каждым тиком читает DB-setting `scanIntervalMinutes` (admin ползунок «⏱️ Интервалы циклов», range 5-60, default 15). Fallback на `SCAN_INTERVAL_MINUTES` env если DB out-of-range. Слайдер применяется на следующем цикле без рестарта (2026-05-11 — было фиксированное `setInterval`).

## Per-preset pipeline configs

5 пресетов: `general / animals / culture / celebrities / events`.

**3-layer storage** (с 2026-05-07, see Tag auto-refresh):
- `settings.presetConfigs` — manual overrides (юзер через админку)
- `settings.presetConfigsAuto` — Grok auto-overrides (tag-refresher every 2 days)
- `settings.presetTagsLocked` — per-tag pin lock-mask `{<preset>: {reddit: [...], twitter: [...], tiktok: [...]}}`. Locked tags не удаляются при auto-refresh. TikTok добавлен 2026-05-11 (Grok иногда тащит k-pop/fandom-drama теги — оператор пиннит curated-list, чтобы выживали).

**Merge order** в `getActivePresetConfig`: `DEFAULT_PRESET_CONFIGS → presetConfigsAuto → presetConfigs`. Manual ВСЕГДА побеждает на conflict — это инвариант для всех consumers.

**Array semantic в `deepMerge`** (preset-config.js:561): массивы **НЕ мержатся**, top-layer-wins. То есть `manual.sources.reddit.subreddits = []` ПОЛНОСТЬЮ заменяет auto+defaults — production коллекторы получат empty queries. Это значит «удалить все chips в админке» != «вернуть auto layer» — нужен явный ↺ Reset на поле (он пишет default → setLeaf GC дропает leaf → auto оживает) или 🧹 Wipe manual на весь preset. Если оператор удалил все chips → empty array записан в DB → production обнулён.

**Admin UI mirror-инвариант**: `admin/server.js → getEffective(preset, path)` ДОЛЖЕН делать ту же 3-layer прогулку что production (`draft → autoOverrides → defaults`). Если UI walks только `draft → defaults`, оператор не видит auto layer → думает что auto пустой → удаляет chips → ломает production (см. WORKLOG 2026-05-16 «Admin getEffective 3-layer merge»). `_getPresetConfigs` отдаёт `data.autoOverrides` для этой цели.

**Admin UI кнопки для preset-configs** (2026-05-12, заменили старую «🗑 Clear ALL»):
- **🧹 Wipe manual** — стирает manual layer во ВСЕХ пресетах (вызывает Save с `overrides={}`). Auto-overrides и locks остаются нетронутыми. Effective падает на auto+defaults. Используется для нормальной работы Auto-tags после legacy manual-крошки.
- **↩ Restore hardcoded** — пушит `DEFAULT_PRESET_CONFIGS.sources` в manual layer всех пресетов через `POST /api/preset-configs/restore-hardcoded`. Manual перекрывает auto → hardcoded теги становятся effective. Junk / alerts / cluster overrides не задеваются (только sources). Используется как escape hatch если Auto-tags выдаёт мусор. Требует подтверждения через `window.confirm`.

Старая panic-clear semantic в `_setPresetConfigs` убрана (раньше при `manual=={} && locks=={}` побочно стирался `presetConfigsAuto`) — операторские намерения теперь явные через 2 кнопки.

**Single source of truth**: `src/analysis/preset-config.js` — `DEFAULT_PRESET_CONFIGS`, `PRESET_GROUPS`, `PRESET_FIELD_RANGES`, `resolvePresetConfig(preset, overrides)` (deep merge), `getActivePresetConfig(db)` (one-stop reader для всех consumers), `validatePresetOverrides(input)` (range-check + Σ POSITIVE ≤ 1.0), `readPresetAutoOverrides(db)`, `readPresetTagsLocked(db)`, `validatePresetTagsLocked(input)`, `mergeOverrideBlobs(auto, manual)` — explicit 2-layer merge для UI side; manual wins per deepMerge.

**Структура blob**: `sources.{reddit,twitter,tiktok,xtrends,googletrends}` · `junk.{politicsPenalty,kpopPenalty,celebNoisePenalty,noMemeShapePenalty,noContentPenalty,safeOverrideDivisor,memeShapeBoost}` · `alerts.{thresholds,weights,stale}` · `cluster.{simThreshold,timePenaltyHours,weightEmbedding,weightPhash,weightEntity,weightTicker}`.

**General preset philosophy**: General — это **curated mix** из остальных 4 тематик, **НЕ broad-firehose**. Sources = 2-3 элемента из каждой темы (animals/culture/celebrities/events) + 2 universal awe-sub'а (Damnthatsinteresting, nextfuckinglevel). Если кто-то захочет вернуть `r/all`/`r/popular`/word-soup queries — нужно явное возвращение. Цель General — «качественный микс по темам», не «всё подряд».

**General tag-refresh = curator mode** (variant B, 2026-05-11): Auto-tags для general **не генерирует** теги через Grok с нуля (генеративный режим неизбежно тащил `skibidi/delulu/brainrot/mewing/rizz` slang-anchors и broad-firehose tags вопреки prompt'у). Вместо этого: после refresh'а 4 тематических пресетов в том же `refreshAll()`-pass, для general вызывается `_refreshGeneralAsCurator()` — Grok получает pools из 4 темовых пресетов и **выбирает** balanced mix (2-3 пик с каждой темы). Pool-membership filter после parse'а дропает всё, что Grok выдумал не из pools. Без x_search (pools уже verified). Fallback идея (НЕ реализована): variant A — программный compose без LLM, если curator-mode окажется leaky.

**Σ POSITIVE invariant** (server-side в `validatePresetOverrides`):
- `alerts.weights`: meme + viral + emergence + twitter + feedback ≤ 1.0
- `cluster`: weightEmbedding + weightPhash + weightEntity + weightTicker ≤ 1.0

**Per-preset divergence** (выборочно):

| Aspect | general | animals | culture | celebrities | events |
|---|---|---|---|---|---|
| alertThreshold | 60 | 55 | 60 | 70 | 60 |
| maxAlertsPerCycle | 5 | 5 | 5 | 5 | 5 |
| alertHardJunkStop | 70 | 70 | 75 | 70 | 75 |
| weightMemePotential | 0.45 | 0.45 | 0.45 | 0.50 | 0.10 |
| weightVirality | 0.15 | 0.20 | 0.25 | 0.30 | 0.30 |
| weightEmergence | 0.20 | 0.15 | 0.10 | 0.10 | 0.35 |
| weightTwitter | 0.05 | 0.05 | 0.15 | 0.10 | 0.15 |
| weightFeedback | 0.15 | 0.15 | 0.05 | 0.00 | 0.10 |
| weightJunk | 0.50 | 0.40 | 0.50 | 0.55 | 0.30 |
| staleDecayPerHour | 1 | 2 | 1 | 3 | 5 |
| staleDecayGraceHours | 24 | 24 | 48 | 12 | 6 |
| staleDecayCap | 48 | 30 | 48 | 40 | 60 |
| cluster.simThreshold | 0.55 | 0.55 | 0.50 | 0.55 | 0.45 |
| cluster.timePenaltyHours | 24 | 48 | 12 | 24 | 6 |

**Consumers** (все читают через `getActivePresetConfig(db)`):
- `scorer.js` `loadAlertWeights(db)` → alerts.weights/.stale/.thresholds.alertHardJunkStop
- `clusterer.js` `_refreshClusterParams()` → cluster.*; junk через `{ [activePreset]: cfg.junk }`
- `collectors/*.js` → sources.* per platform
- `index.js` alert-loop → alerts.thresholds.* (alertThreshold floor, maxAlertsPerCycle, minScoreToSave)

**Endpoints** (admin only): `GET /api/preset-configs` → `{ defaults, effective, overrides, tagsLocked, fieldRanges, presets, groups }` · `POST /api/preset-configs { overrides, tagsLocked? }`. Save с empty `overrides` + empty `tagsLocked` = panic Clear-ALL (wipes auto-blob тоже). Save с empty overrides + non-empty tagsLocked = locks-only update (auto-blob не трогается).

`presetConfigsMigratedV1` flag — one-shot фолд legacy global settings во все 5 пресетов. Legacy ключи **не удалены** (fallback safety).

## Alert gate

```
alertScore = w_meme·memePotential + w_viral·virality + w_emerg·emergence
           + w_x·twitterScore + w_fb·feedbackBoost − w_junk·junkPenalty − staleDecay
```

- POSITIVE веса в сумме ≤ 1.0 → скор остаётся 0-100.
- Per-preset через `loadAlertWeights(db)`.
- **feedbackBoost** (0-100, 50 = нейтрально) считается из live `feedback_votes` на момент gate-loop. <5 голосов → pull towards 50.
- **staleDecay** = `perHour * max(0, ageHours - grace)`, capped at `cap` (per-preset).
- **memePotential-доминанта**: meme=0.45 (general), AI-вердикт по memePotential — primary signal; virality/emergence — модификаторы.

**Gate condition**: `alertScore >= max(user.alert_threshold, preset.alerts.thresholds.alertThreshold) AND junkPenalty < preset.alerts.thresholds.alertHardJunkStop`.

**AI-score gate** (`alert-dispatcher.js`, 2026-05-12): когда Stage 1 batch fail'нул (LLM провайдер вернул 5xx / timeout / parse error), `scorer._fallback` ставит `aiExplanation='AI unavailable'` (или `'Parse error'`) и флаг `_aiUnavailable: true`. Gate `ai_score` блокирует алерт для таких трендов — иначе юзер видит «🤖 AI: AI unavailable / category=other / sentiment=neutral», что бесполезный шум. Тренд сохраняется с `pipeline_status='save_only'` (вместо `'scored'`) → `isTrendSeen` пропускает через на следующем scan'е → Stage 1 пробует снова → если получилось → UPSERT с реальными скорами + `pipeline_status='scored'` → алерт идёт штатно. Retry-loop работает на сетке scan-интервалов (default 15 мин), без specifically retry-logic в самом scorer'е.


**TikTok quality gate** (`alert-dispatcher.js`, only fires when `source='tiktok'`): hard-skips на основе Gemini PreStage сигналов. 4 sub-проверки (любая → hard skip):
- **`!gemini`** (PreStage failed/skipped/legacy) — fail-closed. Без визуальной верификации не отличаем story от scroll-bait/compilation. Добавлено 2026-05-11 после случая с "Weird Sea Animals sounds trend"-style алертами, прошедшими fail-open на отсутствии preStage.
- `isAmbient=true` (Gemini's own boolean)
- `viralPattern in AMBIENT_PATTERNS` = `{satisfying, asmr, tutorial, process, aesthetic, sound_format, dance_challenge, outfit_transition}`
- `memeShapeStrength < TIKTOK_MEME_SHAPE_FLOOR` (60)

Reddit/Twitter/Google bypass этот gate целиком.

**Lipsync gate**: `gemini.isLipSync === true` → hard skip. Falls through на legacy trends (undefined !== true → pass). Ловится теперь TikTok-quality fail-closed branch выше.

**Decision logging**: ring buffer `appState.alertDecisions[]` (cap 500, in-memory, reset на рестарте). Gate-loop пишет массив `gates[{name, passed, detail}]` для observability в admin DecisionsPage.

**Score history (sparkline)**: каждый `recomputeAlertScores()` вызов (scan каждые 15мин + hot-refresh каждые 12h) пишет точку в `alert_score_history(trend_id, ts, score, positive, penalty, floor_at_ts, source)` с FK CASCADE. Retention 30 дней (daily prune в index.js maintenance loop — startup + 24h interval). Используется sparkline'ом в дашборде trend-modal Alert verdict block (admin-only сейчас) — `/api/trends/:id/alert-history` возвращает последние 200 точек + текущий floor. SVG sparkline 240×56, color-coded по passed-state на последней точке, time-scaled X-axis (gaps = реальное время), mini-legend с first→last timestamps.

**Admin-only сейчас (UX gate, не security)**:
- Dashboard trend-modal **Alert verdict block** целиком — pass/fail pill, alertType chip, math panel с contributions, sparkline, junk triggers, floor decomposition. Гейт: `me.plan === 'admin' || me.plan_name === 'admin'`. Когда откроем для всех — убрать одну строчку в TrendModal + одну в `_handleAlertHistory`.
- Term-help `?` подсказки на стат-лейблах в trend-modal (Meme Score / Virality / Velocity / Alert + breakdown rows). i18n словарь `term.*` на EN+RU. Гейт через `isAdmin` флаг в TrendModal — открывается одной строкой `const isAdmin = true`.

## Scoring metadata

Поля trend object'а после full pipeline:

- **memePotential** (0-100) — AI-driven мемность (alias `adoptionScore`)
- **virality** (0-100) — AI-driven
- **emergenceScore** (0-100) — `max(spread, breakout) + ideaBoost`. **Single-source only** — platform-spread component removed 2026-05-04 (cross-source matcher unreliable). Spread = velocity (0-35) + organicSpread (0-30) + noveltyStage (0-20) + authorDiversity (0-15). Breakout — single-post виральность с damping по followers; ideaBoost — Reddit upvote bonus (≥10k→+5, ≥15k→+8, ≥30k→+10, ≥60k→+12).
- **rankScore** = `e*0.4 + a*0.6` ± feedback bias (default sort в дашборде).
- **narrativePhase** = `early / forming / strong / saturated`. Saturated = adoption≥60 && emergence<25.
- **isEarlyIdea** = `emergence 20-50 && upvotes ≥ 10k`.
- **alertType** ∈ `event / trend / post`.
- **whyNow** — конкретный триггер события **в прошлом**, 1-2 предложения cap 280 chars. Может быть пустой. Используется для классификации `alertType=event` + рендерится «🔥 Триггер» в TrendModal. Фактоид-якорь.
- **trigger.*** — **forward-looking прогноз** (Catalyst forecast, см. отдельную секцию). Заполняется по клику Pro/Admin, шарится через DB-cache.

## JunkFilter

`src/analysis/junk-filter.js`. Изолированный слой + positive-signal boost.

**Penalties** (per-preset):
- politics: +40
- kpop/fandom: +30
- celeb-noise: +20
- no-meme-shape: +15
- no-content (text-only): +5 (general), 0..8 per-preset. Skipped когда **все** items кластера от source'а без медиа by design (`google_trends`).

**Safe-signal override**: animal/absurd/meme/heartwarming → делим raw на 3 (или 4 при ≥2 сигналах). Срабатывает только если `raw > 0`.

**Meme-shape boost** (per-preset additive bonus к `emergenceScore`): general 10, animals 14, culture 12, celebrities 6, events 4. `perSignalBoost * (signalCount >= 2 ? 1.5 : 1)`. Применяется в clusterer до routing.

**Hard stop**: `junkPenalty >= alertHardJunkStop` (per-preset, 70 default для general) → skip alert.

**Observability**: JunkStatsSection в админке + `GET /api/junk-stats?hours=N`.

## Multi-signal clustering

4-signal weighted similarity вместо чистого Jaccard. Веса/пороги в DB (per-preset через `cluster.*`).

**Сигналы** (defaults):
- `clusterWeightEmbedding=0.40` — `text-embedding-3-small` cosine (1536-dim, L2-normalised). 0.5..1.0 squashed в 0..1.
- `clusterWeightPhash=0.30` — dHash thumbnails (sharp resize 9×8 grayscale → 64-bit BigInt). Hamming < 16 = soft match.
- `clusterWeightEntity=0.20` — `entityCanonical[]` overlap (требует nano). Cross-language буст.
- `clusterWeightTicker=0.10` — shared `$TICKER` regex `\$[A-Z]{2,10}\b`. Разные тикеры → ×0.85 на final score.
- `clusterTimePenaltyHours=24` — линейный damp 1.0 → 0.7 если items >24h apart.
- `clusterSimThreshold=0.55`.

**Renormalisation**: если сигнал null (нет картинки / nano выкл / API лёг) — вес перераспределяется по остальным.

**Защитные сетки**: `CLUSTER_MULTI_SIGNAL=0` env → panic switch к Jaccard. Если ВСЕ сигналы null → автоматический fallback. Embeddings + hash оба NEVER throw.

**Стоимость**: <$1/мес добавки.

**Cross-platform aggregation: REMOVED.** Cross-source matcher выпилен 2026-05-04 — embedding similarity между разными стилями (Reddit-пост vs Twitter-thread vs TikTok-описание) работала плохо, давала ложные кластеры. Текущая кластеризация **single-source only** — посты из одного источника собираются в кластер, разные источники остаются параллельными нарративами. Single-post breakouts (один экстремально вирусный пост) ловит Path 2 (`_computeBreakoutScore`) в emergenceScore, platform-agnostic, по raw engagement. Возврат кросс-платформенного merge — отдельная задача (нужен новый matcher: cross-source phash + entity-overlap, не embedding).

## MarketStage (opt-in)

Feature flag `MARKET_STAGE_DETECTION=1`. 4 состояния: `none / tokenizing / live / overheated`. Логика в `src/analysis/market-stage.js`. Call sites помечены `[MARKET_STAGE]`. **По умолчанию выключено.**

## AI provider config

Stage 1 provider/model — runtime-tunable из админки (вкладка «Бот» → AI Pipeline). **Default**: `gpt-5.4-mini` (OpenAI), reasoning_effort=low.

- xAI curated: `grok-4-1-fast-non-reasoning`, `grok-4-fast-non-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-3-mini`.
- OpenAI curated: `gpt-4.1-mini/.1`, `gpt-4o-mini/4o`, `gpt-5-mini/5`, `gpt-5.4-mini/5.4-nano/5.4`.
- **grokcli** (4-й вариант) — Grok Build CLI по подписке SuperGrok, без per-token биллинга. **SHIPS OFF** (default provider не изменён). Admin-switchable через тот же селектор. Ограничения: только 30/60-мин циклы (латенси ~70-90с/батч, bounded-concurrency=4; не для 15-мин цикла). Для работы требует одноразового `grok login --device-auth` на прод-хосте + `/root/.grok` смонтированного в контейнер (см. `docker-compose.yml`). CLI retry×2 → HTTP-fallback на первый доступный HTTP-провайдер → heuristic-fallback. Session expiry → auto-fallback (проверяется через `probeGrokSession` в `grok-cli.js`).

**Stage 1 features (OpenAI only)**: Structured Outputs через `STAGE1_RESPONSE_SCHEMA` гарантирует shape `{trends:[...]}`. xAI fallback: `parsed.trends || parsed.results`. Reasoning effort через `OPENAI_REASONING_EFFORT` env. Не-reasoning модели авто-ретраятся без `reasoning` через 400-error path.

**Stage 2** всегда через Grok (xAI, `grok-4-1-fast-non-reasoning`).

**Stage 1 calibration examples**: таблица `stage1_examples` (kind/title/category/meme_potential/rationale/enabled). Admin UI «🎓 AI Examples» — CRUD + preview промпта + cost-budget. Применяется на следующем цикле без рестарта.

## Stage 0 / PreStage

Обогащает каждый трейнд machine-generated метаданными ПЕРЕД scoring'ом. **Никогда не фильтрует, не скорит, не дропает.** Failures → `trend.preStage = null` (Stage 1 видит то же что без PreStage).

**Sub-stages** (parallel via `Promise.all`):
- **Nano** (`gpt-5.4-nano` через OPENAI_API_KEY) — text-only enrichment. Output: `topicSummary`, `entityCanonical[]`, `language`, `slangDecoded`. Inputs: title + description (cap 600) + r/sub + #hashtag + by @author + RelatedPosts (sibling titles из cluster, top 5 by engagement).
- **Gemini Captioner** — visual enrichment с failover-архитектурой. **Primary**: Google AI Studio (`generativelanguage.googleapis.com`) — native video через `inlineData` base64, гео-restricted. **Fallback**: OpenRouter `gemini-2.5-flash` (image-only; для видео всегда poster). **Cooldown circuit**: 3 неудачи Google подряд → 5 мин принудительно через OpenRouter.

**Видео policy**: `ffprobe` замеряет длительность. ≤ `STAGE0_VIDEO_MAX_SEC` (30 default) → Google native (download → base64). > этого порога → `ffmpeg -c copy -t N` обрезает первые N сек в tmp-mp4, шлём в Gemini как короткое. `videoClipped=true`. Постер используется ТОЛЬКО если trim упал ИЛИ Google вернул ошибку → `videoTruncated=true, truncationReason='duration_exceeded'`. ffmpeg trim универсальный — Twitter/Reddit/TikTok/X Trends/manual. Adds `Referer` header для TikTok-CDN.

**Kill-switches** (nano): `STAGE0_NANO_ENABLED=0` env (constructor) · DB setting `nanoEnabled` (admin runtime, читается на каждый batch).

**Persistence**: `trend.preStage` сохраняется в `raw_metrics.preStage`. Re-просмотр в админке не платит дважды.

**Стоимость**: ~$50-70/мес при ~30 трейндов/цикл, 720 циклов/день. OpenRouter <5% при стабильном Google.

## Stage 2 cost knobs

- `XAI_STAGE2_MAX_RESULTS=5` — max sources per x_search (главный рычаг, $5/1000 sources).
- `XAI_STAGE2_MAX_TOOL_CALLS=2` — Grok max consecutive x_search calls.
- `XAI_STAGE2_LOOKBACK_HOURS=48` — `from_date` window.
- `stage2MaxCalls=3` (DB-tunable) — cap вызовов на цикл.
- `stage2Threshold=60` — gate для входа в Stage 2 (memePotential ≥ X).
- Skip `google_trends` + novelty gate (`clusterMetrics.isNovel !== false`).
- **Escalation path**: deep-dive candidates = высокий meme (≥ threshold) **∪** эскалированные (эвристика `isUnderscored` ИЛИ флаг модели `needsDeeperLook`). Оба пула делят общий `stage2MaxCalls` cap; `escalationReserve` слотов (default 2) зарезервировано под эскалации — остаток отдаётся meme-gate с reflow. `google_trends` не эскалируются (x_search без URL бесполезен). Heuristic thresholds: `escLowMemeCeil=50` / `escHighEmergence=65` / `escHighViral=60` / `escBigCluster=8` / `escJunkFloor=40` — консервативные seed-значения, DB-tunable.
- **Reasoning toggle**: `deepReasoningEnabled` (default `'0'`) — при включении меняет модель Stage 2 на `stage2ReasoningModel` (reasoning-вариант Grok). Shipping OFF; нужно задать `stage2ReasoningModel` + включить toggle.
- Stage 1 `explanation` JSON schema `maxLength: 220` (strict-enforced).

**Текущая стоимость**: ~$153/мес (1 call/cycle × 96 cycles/day × 5.3¢). x_search billing — **$5 per 1000 sources, NOT per call**.

**Subject-name + story bonuses** (Stage 2 output): `subjectName` + `nameStrength` (если ≥60 → +до 10), `storyScore` (если ≥60 → +до 15). С **soft-cap по headroom**: `bonus * (100 - oldMeme) / 50`. Эффект — meme=85+15→90 вместо 100. До 100 теперь доходит только то, что Stage 1 уже поставила ~98+. Штрафы отдельно (multiplicative `penaltyMult` по buzz/momentum/organicity, без soft-cap'а).

**Stage 1 rubric philosophy**: вилка `memePotential` намеренно консервативная — 95-100 зарезервированы для трендов с одновременно name + visual + ticker hook + cultural pull («раз в день-два»). Большинство «good» — 60-79. Calibration в SYSTEM_PROMPT запрещает раздавать 90+ нескольким трендам в одном батче.

**Stage 1 fallback rules (no GeminiScore)**: Когда Stage 0b упал/skipped и в input нет `GeminiScore (TRUST — ECHO into output)` строки, SYSTEM_PROMPT заставляет Stage 1 скорить **консервативно по тексту**:
- Generic group-label titles (Sea Animals sounds, Farm Animal sounds, Herbivore Sounds, [Topic] Compilation, Weird [Group] Sounds) → cap memePotential **≤ 25** (compilation/sound-format participation, не story).
- TikTok без concrete subject в title → cap **≤ 35** (без визуала не отличить scroll-bait).
- Concrete focal subject (named person/animal/event/$TICKER) → нормально, но в band 35-65 если engagement не экстраординарный.
- В fallback explanation должна явно упоминать unavailable visual analysis (audit-trail для оператора).
- `scoreOverride` не применяется (нет Stage 0b score которое можно было бы override).

Backstop в alert-dispatcher: TikTok без preStage → hard-skip (см. Alert gate § «TikTok quality gate»). Fallback Stage 1 rules ловят остальные источники + оставляют чистый scoring trail.

**⚠ Source-bias trap (Stage 0b authoritative)**: trust-contract в `scorer.js` (введён 2026-05-10) — Stage 0b = authoritative scorer, Stage 1 ECHOes. Stage 0b — Gemini **Vision**, требует визуал. Источники по доле «text-only постов»:
- **Reddit / TikTok** — почти всегда визуал есть (картинка-пост / видео) → Stage 0b скорит штатно.
- **Twitter** — на практике (SQL-проверка 2026-05-11): большинство Twitter-постов в скрапе **имеют** prefetched media (cards / inline images), Gemini Stage 0b их скорит штатно. Изначальный страх «Twitter режется этим trap'ом» **опровергнут**. Реальная проблема Twitter throughput — узкий tag-list от Grok'а (collector-side, не scoring).
- **Google Trends** — text-only **полностью**, Stage 0b пуст всегда.
- **X Trends** — частично (aggregated tweets иногда с медиа).

Поэтому Stage 1 **fallback rubric выше — критичный path для Google Trends и X Trends**, не для Twitter. Без неё эти 2 источника почти не дают алертов независимо от actual quality постов. Подробный диагноз 2026-05-11 (см. WORKLOG meta-entry за этот день).

**Escape hatch idea** (не реализован): добавить в `scorer.js` source-aware priority — для `googletrends|xtrends` ВСЕГДА брать Stage 1 score (skip Stage 0b authoritative). Это revert части trust-contract'а для text-only источников. Реализовать если fallback rubric окажется недостаточно агрессивен.

## Apify scrapers

**Twitter actor registry** (runtime-switch через админку, DB setting `twitterActor`):
- `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` — **default** ($0.25/1K, 17K users, 99%+ success).
- `xquik/x-tweet-scraper` — alt ($0.15/1K, экспериментальный).

Per-actor tokens: `APIFY_API_KAITO`, `APIFY_API_XQUIK`. Generic: `APIFY_API`. `buildInput(query, maxItems)` actor-agnostic — Kaito принимает `twitterContent: <string>`, xquik — `searchTerms: [<string>]`. Output идентичный.

**TikTok actor registry** (DB setting `tiktokActor`):
- `clockworks/tiktok-scraper` — **default** ($2.00/1K, нативный hashtag-вход через `hashtags: [tag]`).
- `apidojo/tiktok-scraper` — alt ($0.30/1K, в ~6× дешевле). Не принимает `hashtags`-массив — собирается через `startUrls: [{ url: 'https://www.tiktok.com/tag/<encodedTag>' }]`.

Per-actor tokens: `APIFY_API` (для clockworks), `APIFY_API_APIDOJO`. UI: «⚙️ Сканеры» → «🎯 Конфиг сканера» → «🎵 TikTok scraper».

**Видео-файл**:
- **apidojo** отдаёт работающий `videoUrl` (URL с подписанным токеном, валиден ~6h). `_normalize` пробрасывает в `metrics.videoUrl` с приоритетом `videoUrlNoWaterMark > videoUrl > mediaUrls[0]`. Stage 0 Gemini-captioner качает нативно.
- **clockworks** не выставляет `videoUrl` без `shouldDownloadVideos: true` (выключено для экономии). Поэтому fallback на постер.
- **TikTok CDN gating**: tiktokcdn.com / tiktokv.com гейтят по `Referer: https://www.tiktok.com/`. Без него — 403. `gemini-captioner.js` детектит TikTok-URL через `_isTikTokMediaUrl()` regex и добавляет Referer в HEAD/GET fetch + в `ffprobe -referer ...`.

`_normalize` field-fallback chain покрывает оба актёра — `author` пробегает `authorMeta.name → authorUsername → author.uniqueId`, `thumbnailUrl` — `originCoverUrl → covers[0] → covers.{default,origin} → cover → dynamicCover → shareCover[0] → imageUrl`.

**PRICING TRAP**: Apify actor public-page sticker может быть stale ($1.70/1K) vs реальная цена в console ($3.00/1K). Always verify в console (actor → "Pricing" tab).

**Auth pattern (security)**: все Apify-запросы через `Authorization: Bearer <key>` header вместо `?token=` query-param. Если `fetch()` бросает network-error, undici включает URL в `err.message` — Bearer держит токен вне URL-поверхности. Применено во всех 4 коллекторах.

## X Trends

5-я платформа (source-id `x_trends`) — двухстадийный discovery flow:

- **Stage A** (раз в сутки): Apify actor `karamelo~twitter-trends-scraper` тянет live-список трендов в США, берём top-3 по rank.
- **Stage B**: для КАЖДОГО top-тренда вызываем `TwitterCollector.searchByQuery(trendName, 7, { relaxedFloor: true })`.
- **Aggregation**: один эмитированный item на тренд (source=`x_trends`, не на твит), `metrics.views/likes/retweets/replies` = сумма по top-7 твитам. Stage 1 LLM получает РЕАЛЬНЫЙ engagement сигнал.
- **Visual**: thumbnail/imageUrls/videoUrl лифтятся из highest-engagement твита.
- **`metrics.topTweets[]`**: список из {id, url, author, text, views, likes, retweets, replies, thumbnailUrl, imageUrls, videoUrl} — для prompt context, dashboard modal.
- Daily externalId bucketing (`xtrends-<country>-<slug>-<YYYYMMDD>`) — один item на тренд на день. На следующий день re-enters pipeline.
- **Relaxed engagement floor** в `twitter._normalize` для X-Trends-вытянутых твитов: 10K views / 500 likes (вместо firehose 500K / 10K). Trending position сама по себе — quality signal.
- Ни один топ-твит не прошёл relaxed-floor → тренд тихо скипается (отсев low-quality `#GoodMorning`).

**Стоимость**: ~$1.40/мес.

**Env knobs**: `X_TRENDS_REFRESH_MINUTES` (1440) · `X_TRENDS_TOP_TRENDS` (3) · `X_TRENDS_TWEETS_PER_TREND` (7) · `X_TRENDS_COUNTRY` (`United States` или числовой ID).

## TikTok specifics

**Cycle pacing**: TikTok работает независимо от активного пресета (`sources.tiktok.enabled` в preset-config помечено DEPRECATED). Управление через env `TIKTOK_ENABLED`. Свой интервал — **runtime-tunable** через DB-setting `tiktokCycleIntervalMinutes` (admin ползунок «⏱️ Интервалы циклов», range 10-120 мин, default 30). Env `TIKTOK_CYCLE_INTERVAL_MINUTES` — fallback если DB-setting'а нет / out-of-range. Читается каждый `collect()` через `_getCycleIntervalMinutes()` — слайдер применяется на следующем цикле без рестарта. Time-gate в `collect()` skip'ает если последний run < interval. First-run after restart всегда проходит.

**Live hashtag discovery** (Stage A для TikTok): раз в 12h (`TIKTOK_TRENDS_REFRESH_MINUTES=720`) collector дёргает `clockworks~tiktok-trends-scraper` actor (numeric ID `sDvA9jM4WRTDX4Syr`) — зеркало TikTok Creative Center (официальная публикация trending hashtags). Top-24 (`TIKTOK_TRENDS_TOP_N=24`) с `isPromoted=false`, `videoCount > 0`. Кэш в `settings.tiktokTrendingHashtags` (JSON `{hashtags:[], fetchedAt}`). Live-discovery — primary path в `_getHashtags()`; per-preset hardcoded list — fallback. Стоимость ~$4.32/мес.

**Compilation filter** (`tiktok.js COMPILATION_RE`): regex отбрасывает видео с маркерами подборки в caption: `\b(compilations?|funniest|best of|top \d+|...)\b` и `#\d+\s*$`. High precision / low recall. Дропает до Stage 0.

**Max-age filter** (`tiktok.js _normalize`, 2026-05-14): TikTok-страница `/tag/<x>` ранжируется редакционно, а не хронологически — Apify часто возвращает evergreen-видео 2023-2024 года среди свежих. Они проходят engagement floor (миллионы просмотров накопились за годы) и прилетают как «свежий тренд». Cap: `tiktokMaxAgeDays` DB-setting (admin ползунок «🎵 TikTok — фильтр по возрасту», range 0-60d, default 7d). 0 = выключено. Видео без `createTime`/`uploadedAt` пропускаются без проверки (редко, но не должно ломать firehose). Симметрия с Twitter (`twitterMaxAgeHours`, default 72h).

**Cluster representative semantics**: кластер по хэштегу выбирает **один представитель** (max `plays + shares*1000 + likes*10`) и эмитит ЕГО метрики как `metrics.plays/likes/shares/comments/...`. Cluster-totals — отдельные поля `metrics.clusterPlays/clusterLikes/clusterShares/videoCount`. Раньше код суммировал в `metrics.plays/likes/shares` — рассинхрон между промптом и кликом юзера. `prompts.js` рендерит rep-метрики и cluster-totals на разных строках.

**Formatter plays-line** (`notifications/formatter.js`): для TikTok рендерит `m.plays` напрямую, **не** `m.upvotes` (= synthetic `likes + shares*3`). Для Twitter и других — upvotes-композит остаётся (label-aware).

**Engagement floor** (`tiktok.js _normalize`, OR-логика): `plays ≥ 500K` ИЛИ `likes ≥ 20K` ИЛИ `shares ≥ 5K`. `viralScore` больше **не входит** во floor (формула — сумма логов, любое видео с ~200K плеев получало score=100). Cluster aggregate floor **больше не применяется** — каждое видео уже прошло индивидуальный floor.

**CJK threshold multiplier** (`_normalize` в `twitter.js` + `tiktok.js`):

| Письменность | Twitter views/likes | TikTok plays/likes/shares |
|---|---|---|
| Default | 500K / 10K | 500K / 20K / 5K |
| Japanese (`ja`), Korean (`ko`) | ×2 | ×2 |
| Chinese (`zh`) | ×4 | ×4 |

`_detectCjkScript(text)` — kana → 'ja', hangul → 'ko', Han без них → 'zh'. Требует ≥30% CJK-доли.

**Audio-URL filter** (`_firstNonAudioUrl`): apidojo для некоторых видео в fallback-полях прокидывает не video URL а саундтрек mp3 (на `*-music*.tiktokcdn.com`). Helper отсекает audio-URL'ы по regex `/\/ies-music|-music[-.]|\.mp3(\?|$)/i`. Применяется и в коллекторе и в `url-resolver.js _resolveTiktokViaApidojo`.

## Source-aware engagement labels

В `formatter.js` (Telegram alerts):
- Twitter → ❤️ Likes (с velocity)
- TikTok → ▶️ Plays
- X Trends → rich-row `👁 views · ❤️ likes · 🔁 retweets · 💬 replies · N tweets`
- Reddit/other → 📈 Upvotes

i18n keys: `alertLikes`, `alertPlays`, `alertGoogleHits` (EN + RU).

## Source icons

Brand SVG logos (simpleicons.org public-domain), single-color, `fill="currentColor"`: `reddit` (Snoo), `google_trends` (G-mark), `twitter` (X glyph), `tiktok` (music note silhouette), `x_trends` (hashtag).

`SourceMark({ src, fallback })` рендерит SVG через `dangerouslySetInnerHTML`; fallback — letter-mark из `SOURCE_ICONS` (R/G/𝕏/♪/#) для inline-text usage. CSS `.src-mark-svg { width/height: 60% }` от родительского чипа. Twitter X 56% (тонкий по природе).

## Feedback (взвешенный)

Только 👍/👎 обрабатываются. Остальные реакции игнорируются.

**Storage**: `feedback_votes` таблица — `UNIQUE(trend_id, chat_id)`. Поля: `vote (+1/-1)`, `weight`, `plan_name`, `reason TEXT NULL`.

**Веса по плану** (admin ×25 vs free): admin=5, pro=2.5, test=0.5, free=0.2.

**Toggle**: `feedbackWeightingEnabled` (BotPage). Выключено → учитываются ТОЛЬКО голоса admin (weight=1), остальные weight=0.

**Reason wizard** (Telegram): после голоса в keyboard'е появляется `✏️ Причина оценки`. Клик → ждём текст (cap 240 chars, 5-min timeout). `/skip` отменяет. Reason обнуляется при смене направления голоса.

**AI prompt injection**: `_buildFeedbackContext` рендерит multi-line entry на тренд:
```
  + "Title" [category]
      AI: <ai_explanation, cap 160>
      reason: "<topReason, cap 120>"
```
AI/reason sub-lines пропускаются если поле пусто (старые ряды без `ai_explanation` → формат деградирует к одной строке `+ "Title" [category]`). Цель — дать модели тот же контекст, что юзер видел в TG-карточке на момент голосования. `getLikedNarratives` / `getDislikedNarratives` тянут `ai_explanation` + `why_now` из `trends`. Только голоса с `weight >= 0.5` ИЛИ непустым reason попадают в промпт.

**Recalculation**: `trends.user_feedback = ROUND(SUM(vote * weight))` после каждого голоса.

## Manual analysis

Pro/Admin only. Доступно из 3 surfaces:

1. **Admin** — вкладка «🧪 Ручной анализ»: URL → синтетический trend → полный scorer → опциональная рассылка всем активным TG-юзерам. `save:true` (попадает в feed).
2. **Dashboard** — bottom-nav «🧪 Анализ» (только pro/admin) → Sheet с AnalyzePanel. `save:false` — приватно. Rate limit: 30s между, 20/24h, admin bypass.
3. **Telegram** — `/analyze <url>` + bare-URL auto-detection в `bot.on('message')` (только pro/admin, остальные silent ignore). Same rate limit.

**Архитектура**: `src/analysis/{url-resolver,manual-analysis}.js`. `resolveUrlToTrend(url)` — Twitter/Reddit/TikTok/og:image generic. `runManualAnalysis({ scorer, db, url, save, logger, actorId })` — единый оркестратор.

**TikTok-резолвер two-tier**: если `APIFY_API_APIDOJO` set → apidojo single-URL run (полный engagement + videoUrl, ~$0.0003/анализ), иначе → oEmbed fallback (бесплатно, только title+thumb, без видео). Это **независимо от `tiktokActor` админки** — manual всегда предпочитает apidojo, потому что нужен видео-сигнал для Stage 0.

**Cross-user URL cache**: module-level Map с TTL 1h. Pro-юзер A проанализировал → юзер B по тому же URL получает кэш мгновенно. Cache key — lowercase URL без trailing-slash. Wiped on restart. Lazy save: `save:true` после `save:false` выполняет только DB-запись без re-run scorer.

`peekManualAnalysisCache(url)` — non-mutating helper, dashboard/TG peek перед rate-limit, на cache hit пропускают rate-limit.

## User favourites

Pro/Admin only — постоянное сохранение трендов «на память». Free/Test видят locked-визуал (⭐ с 🔒 → upgrade toast).

**Storage** (`user_favorites` table): `(chat_id, trend_id, note, snapshot, created_at)`, UNIQUE(chat_id, trend_id). Без CASCADE / retention sweep — фавориты вечны. **`snapshot` = JSON-копия** ключевых полей тренда на save-time (title, source, url, image, raw_metrics, alert_type, whyNow, trigger_*, externalId, author). Зачем: trends-таблица ротирует row'ы, но favourite должен пережить. `getFavoritesByChat` — LEFT JOIN: fresh-данные если есть, snapshot fallback. `addFavorite` — `INSERT ... ON CONFLICT DO UPDATE` (повторное сохранение освежает snapshot).

**DB методы** (`src/db/database.js`): `addFavorite/removeFavorite/setFavoriteNote/getFavoriteTrendIds/getFavoriteMeta/getFavoritesByChat/countFavoritesByChat` + `_trendSnapshot(trend)`.

**Endpoints** (`src/dashboard/server.js`):
- `POST /api/trends/:id/favorite` body опц. `{note}`
- `DELETE /api/trends/:id/favorite`
- `PATCH /api/trends/:id/favorite` body `{note}`
- `GET /api/favorites`

Все 4 проходят через `_favoriteGate(req, res)` — `getPlanEntitlements(plan).favorites === true`. Иначе 403 reason='plan'.

**Feed integration**: `_handleTrends` pre-fetch'ит `Set<favoriteIds>` один раз и передаёт в `_formatTrend(row, userId, favSet)` для O(1) per-row attach `isFavorite`. `?favoritesOnly=1` фильтр через `WHERE id IN (...)`. Возвращает `favoriteCount` в payload.

`_publicUser.entitlements.favorites: bool` — фронт читает для render-логики.

**Telegram-бот не интегрирован** (по решению владельца). DB-таблица shared, может присоседиться позже через callback.

## Hot trends refresh loop (two-tier)

`src/refresh/hot-metrics.js` — два независимых фоновых цикла:

1. **Heavy cycle** — раз в 12 часов (`HOT_REFRESH_INTERVAL_MINUTES=720`). Пере-фетчит метрики + Stage 1 LLM + Stage 2 если memePotential ≥ 60 + dispatch alerts на дозревших. Дорогой ($3/мес Grok), редкий.
2. **Light cycle** — раз в 60 минут (`HOT_REFRESH_LIGHT_INTERVAL_MINUTES=60`). **Только** обновляет engagement metrics через `db.updateTwitterEngagement` / `db.updateRedditEngagement`. **Без LLM, без re-score, без alert-dispatch**. Бесплатно (fxtwitter + reddit JSON). Все Reddit/Twitter тренды до 24h всегда максимум на 60 минут устаревшие в DB.

Light skip'ает себя если heavy в полёте. Тот же admin-toggle `hotRefreshEnabled` управляет обоими; отдельный env `HOT_REFRESH_LIGHT_ENABLED=0`. Eligible для light: те же Reddit+Twitter ≤24h, но **без `minMeme`**.

Heavy: **без per-trend cooldown'а**. Возрастной gate `first_seen_at > 24h` — единственная защита. При интервале 12h тренд попадёт в heavy refresh **максимум 2 раза** за свою жизнь.

**Eligibility**: `first_seen_at` ≤ 24h · `memePotential` ≥ 50 · `source ∈ {reddit, twitter}` (TikTok пока out) · `url IS NOT NULL` · cap 100/цикл, sort `first_seen_at DESC`.

**Refresh metrics — БЕСПЛАТНО**: Twitter `resolveTwitterUrl()` через `api.fxtwitter.com/i/status/<id>`; Reddit `resolveRedditUrl()` через `<permalink>.json`. Concurrency=5 worker pool.

**Re-score**: `scorer.scoreTrends(refreshed)` — Stage 1 batch + Stage 2. Stage 2 cap общий с обычными циклами. preStage carry-through из original → не платим повторно за nano/gemini. Identity (externalId, title) сохраняется → `saveTrend` UPSERT'ит ту же row.

**Дозревший тренд → новый алерт**: если после re-score `alertScore` пробил порог, а тренд НЕ был alerted — обычный alert-loop в `index.js` подхватит на следующем проходе.

**Toggles**: `HOT_REFRESH_ENABLED=0` env (рестарт нужен) · DB setting `hotRefreshEnabled` (admin runtime toggle, читается на каждом cycle entry, no restart, default ON).

**Re-entrancy guard**: `running` flag — если предыдущий цикл идёт, новый skip с warning.

**Critical carry-through (двухслойный)**: clusterer-domain поля (`emergenceScore`, `narrativePhase`, `marketStage`, `junkPenalty`, `junkReasons`) НЕ пересчитываются на single-trend re-score. Scorer читает emergence ИСКЛЮЧИТЕЛЬНО из `trend.clusterMetrics?.emergenceScore` — top-level `trend.emergenceScore` игнорируется. Carry-through делается в **источнике**: `db.getHotTrendsForRefresh()` сразу заполняет `clusterMetrics` всеми полями (плюс `isNovel: true` чтобы Stage 2 не auto-skip). Гарантирует корректную форму на ОБОИХ путях `_refreshAll` — и success (`_merge` спредит), и failure (`out[i] = trend` без merge).

**Alert dispatch после refresh**: цикл вызывает `dispatchAlerts({trends, source: 'refresh'})`. Тот же модуль (`src/notifications/alert-dispatcher.js`), что использует scan-cycle. `triggerSource` поле в decisions buffer показывает `scan|refresh|manual` для observability.

## Tag auto-refresh

Background job — Grok `grok-4.3` (fallback `grok-4.20-0309-reasoning`) предлагает свежие subreddits, Twitter keyword groups и TikTok hashtags для каждого из 5 пресетов. Решает проблему «теги устаревают, надо вручную обновлять раз в 1-2 недели» которая стояла после TikTok meme refresh от 2026-05-05.

**Cadence**: дефолт **2 дня** (был 7 до 2026-05-11 — изменено после наблюдаемого drop'а throughput'а на TikTok/Twitter к середине цикла; hashtag trends живут 1-3 дня, 5-7 тегов выгребались досуха). Override через `TAG_REFRESH_COOLDOWN_DAYS` env. Cost ≈$2/мес.

**Output targets per preset** (в `_buildPrompt`): 8-10 subreddits · 8-10 Twitter keyword groups · 8-12 TikTok hashtags. До 2026-05-11 было 8-10 · 5-6 · 5-7 — расширено вместе с cadence change.

**Архитектура** (`src/refresh/tag-refresher.js`):
- Hourly check loop в `index.js` — фоновый, 5 мин после boot, потом каждый час. Проверяет cooldown (default 2 дня через `TAG_REFRESH_COOLDOWN_DAYS`), при истечении — фоновый `refreshAll()`, не блочит scan-cycle.
- Per-preset запросы (granular failure). Real xAI Responses API `/responses` с `tools: [{type: 'x_search', max_search_results: 20}]`. Live Search вызывается ~9 раз за один Grok-запрос — критично для grounding (без mandate prompt'а Grok отвечает из training data → галлюцинирует свежий сленг).
- **undici@6 long-timeout dispatcher** (`XAI_LONG_AGENT`, 15-min headers/body timeout) — обязательно, иначе UND_ERR_HEADERS_TIMEOUT валит запрос (default 5 min недостаточно для x_search reasoning loops).
- **`tool_choice: 'required'` НЕ поддерживается** xAI Responses API — обрывает соединение (UND_ERR_SOCKET). Mandate сидит исключительно в system prompt («You MUST invoke x_search AT LEAST 3 times BEFORE writing JSON»).
- **Reality-check (двойной)**:
  - **Reddit subs**: для каждого PROPOSED subreddit (skip already-existing) `GET https://www.reddit.com/r/<name>/about.json` (free public API, ~10 req/min unauth). 200+`kind:t5` → keep, 404/403/451 → drop с reason'ом. Throttle 6.5s между probe'ами. Bailout при 3+ consecutive network errors → pass-through (защита от случайной отрубки Reddit'а). User-Agent через `REDDIT_USER_AGENT` env.
  - **Twitter keyword groups**: одна Apify probe `${group} min_faves:100 -is:retweet`, max 5 results. Если 0 — drop. Защита от Grok hallucinations на slang-anchor.
  - **TikTok hashtags**: НЕТ Apify reality-check (дорого + slow). Вместо этого — regex post-filter `TIKTOK_HARDSKIP_RE` в `_sanitizeResponse`: ловит `kpop|kpopfyp|kpopstan|kpoptiktok|kpopedits|fandom|fandomdrama|stantwitter|stantiktok|celebgossip|celebtea|hollywoodgossip|gossipgirl` (anchored на word-boundaries, не подстрока — `kdrama` остаётся валидным). Дроп с info-логом. Добавлено 2026-05-11 после случая `kpopfyp` + `fandomdrama` в active TikTok-тегах.
- **Diff respecting locks**: locked tags из `presetTagsLocked` всегда добавляются в `kept` set, даже если Grok их не предложил. Apply пишет в `presetConfigsAuto` sparse blob — auto-overrides поверх defaults, manual поверх auto.
- **Sparse twitter restoration**: при apply Grok возвращает только keyword-parts (без `min_faves`/`-is:retweet`). Refresher восстанавливает оригинальные `min_faves` для kept queries (из defaults), новым groups присваивает median из defaults.
- **Admin Telegram digest**: после каждого `refreshAll()` (success или fail, scheduled или force) шлёт HTML-сводку всем `plan_name='admin'` юзерам. Формат: статус-emoji + per-preset diff (added/removed subs + tw, max 6 в строке + counter), total cost, elapsed, circuit-breaker warning при streak ≥ 3. HTML escape, trim до 3800 char. Best-effort — если telegram lacks instance или sendMessage упал, лог + skip, run не валится.

**Failure modes**:
- 5xx / `model_not_found` → fallback на `grok-4.20-0309-reasoning`
- JSON parse error / xAI fetch error → audit `error` status, бамп `tagAutoRefreshFailureStreak`
- Empty after sanitization → audit `rejected_validation`, **НЕ** бамп streak (плохой Grok output, не infra fail)
- 3 consecutive errors → circuit breaker (auto-disable до manual reset через админ-кнопку)

**Settings keys** (in `settings` table):
- `tagAutoRefreshEnabled` ('0'/'1', default ON)
- `tagAutoRefreshLastRunAt` (ISO timestamp)
- `tagAutoRefreshFailureStreak` (int, 3 → CB open)

**Audit log**: table `tag_refresh_history(id, ts, preset, source_type, status, diff_json, error_message, model, cost_usd)`. UI рендерит последние 50 записей в Auto-tags page с цветами по status.

**Admin UI** (см. Admin panel):
- Tab `🔄 Auto-tags` — toggle, force button (rate-limit 1×/24h), status badge с countdown'ами, history table, reset-breaker
- Per-tag 🔒 toggle на каждом chip в `Пресеты → Sources` (Reddit subreddits и Twitter queries) — locked chip получает зелёный glow border. Twitter lock-key — keyword-PART (без чисел), извлекается через regex strip перед toggle.

**Cost** (verified in 2 sanity-tests 2026-05-07): ~$0.045 / preset × 5 = $0.22 / refresh × 4/мес = ~$0.88/мес. Время refresh: 100-300 sec / preset × 5 ≈ 10 минут на полный прогон.

**Что НЕ автоматизируется** (юзерское решение): TikTok hashtags (live-discovery работает, refresh = waste), junk weights, alert thresholds, stale decay. Только sources.{reddit,twitter} subreddits + keyword groups.

## Catalyst forecast (on-demand trigger)

Forward-looking прогноз: что подтолкнёт **дальнейший рост популярности нарратива**. Запускается по клику Pro/Admin (кнопка «🔮 Catalyst» в Telegram, кнопка в TrendModal). Stage 1 поле `whyNow` — ортогональный past-anchor (что зажгло), оно остаётся фактоидом.

**Архитектура** (`src/analysis/{prompts,trigger-finder}.js`): промпт `TRIGGER_SYSTEM_PROMPT` — forecaster, не recap. Системные ограничения: ZERO references to crypto/coins/tokens/tickers/market caps. Только narrative popularity. Grok `grok-4-1-fast-reasoning` + `x_search` (tool). Per-user 15min cooldown (admin bypass), DB-level claim против race, shared cache в `trends.trigger_*`.

**Output JSON**: `forecast` (2-3 предложения: фаза + forward catalyst + upside window) · `phase` (enum `early|building|peaking|saturated|fading`) · `window` (short-form, "next 24-48h", '' если uncertain) · `drivers[]` (1-3 bullet'а ≤80 chars) · `risks[]` (0-2 bullet'а) · `sources[]` (до 5 X-handles) · `confidence` (0-100).

**DB columns** (`trends`): `trigger_text`, `trigger_phase`, `trigger_window`, `trigger_drivers/risks/sources` (JSON), `trigger_confidence`, `trigger_searched_at/by`, `trigger_in_flight`. Старые row'ы со scored-but-not-triggered трендами имеют пустые поля — UI не рендерит пустые секции.

**UI**: Telegram (`_renderTriggerMessage`) — header → forecast text → phase·window chip-line → drivers/risks → sources → confidence. Dashboard (`TriggerSection`) — чисто forward-блок. `whyNow` — отдельной секцией «🔥 Триггер» выше. Empty state — CTA-подсказка + кнопка «🔮 Найти Каталиста». Заполненное — forecast + chip-row (phase tinted) + `.catalyst-drivers` (accent border) + `.catalyst-risks` (red-tinted).

**Запреты в промпте**: NO crypto/coin/token/ticker/launch/pump/DEX/contract/market-cap. Если для нарратива coin существует — Grok'у запрещено упоминать. Forecaster о популярности нарратива, не о цене.

**No-signal case**: если x_search не нашёл forward driver'а — confidence < 40, drivers `[]` или один cautious bullet, forecast «нет ясного катализатора впереди». Никаких manufactured forecasts.

**Стоимость**: ~5-50 вызовов/день, reasoning ~$0.05-0.10 за вызов.

## Alert types

3 enum (`prompts.js → ALERT_TYPE_VALUES`):
- `event` 📰 — конкретный триггер (whyNow обычно непустой)
- `trend` 📈 — нарратив на нескольких платформах / в нескольких постах
- `post` 🚀 — один вирусный пост

**AI-driven** через Stage 1 schema (`alertType`). xAI/Grok нормализуется через `normalizeAlertType()`.

**Deterministic fallback** `deriveAlertType(trend)`: `whyNow → event` · `clusterSize ≥ 3 → trend` · иначе `post`.

**Persistence**: `trends.alert_type` колонка + `raw_metrics.alertType` зеркало.

**Per-user subscription**: `users.alert_types_filter` CSV default `'event,trend,post'`. Helpers `db.getUserAlertTypes(chatId)` / `setUserAlertTypes(chatId, types[])`. Empty CSV → silent-allow.

**Gate** в alert-loop: `!trendAlertType || userAlertTypes.includes(trendAlertType)`.

**UI**: Telegram `/menu` → «🔔 Типы алертов» submenu. Dashboard sidebar chip-filter (multi-select CSV) + AccountPanel `AlertTypesRow`. Admin SubmitPage hero meta-chip + DecisionsPage gate label.

## Support bot

Отдельный Telegram-бот для тикетов — `@CatalystSupportbot`. Цель — увести поддержку из личного DM. Архитектура: forum-topics relay в приватной admin-группе.

**Flow**: Юзер → `@CatalystSupportbot` (DM) → бот находит/создаёт forum-topic в admin-группе → копирует через `copyMessage` (без `Forwarded from`). Админ отвечает в топике → бот ловит `message_thread_id`, ищет mapping → копирует ответ юзеру. copyMessage agnostic к контенту.

**Storage**: `support_threads(chat_id PK, topic_id, group_id, username, created_at, updated_at)`. Двусторонний lookup. `group_id` per-row — re-config admin-группы не мисроутит.

**Bootstrap-инвариант**: Bot privacy mode **выключен** в @BotFather · группа с включёнными Topics · бот = админ группы с правом `Manage Topics` · `SUPPORT_GROUP_ID` в `.env`.

**Language sync**: `_resolveLang(chatId, fromUser)` читает `users.language` из shared DB. Приоритет: saved language → `from.language_code` → `'en'`.

**Graceful disable**: если `SUPPORT_BOT_TOKEN` или `SUPPORT_GROUP_ID` отсутствует — бот не стартует, основной flow работает. Кнопка «💬 Ask a question» использует `_supportUrl()`: `t.me/${SUPPORT_BOT_USERNAME}` или fallback на `t.me/skipnick`.

**Concurrency**: `_creatingTopic` Map — promise-coalescing per chatId.

## Theme system (dashboard)

3 темы. `pulse` — дефолт, задаётся в `:root` (без `data-theme` атрибута); `ink`/`tide` — оверрайды через `body[data-theme="ink"|"tide"]`. localStorage `ts_theme`.

| Theme | bg | accent | use case |
|---|---|---|---|
| `pulse` | soft graphite | `#4ade80` (green) | **default**, `:root` baseline (без attribute) |
| `ink`  | `#000000` | `#1d9bf0` | pure black + X-blue (`data-theme="ink"`) |
| `tide` | `#0a1622` | `#4dd4e0` | deep navy + cyan/aqua accent (crypto-terminal vibe, `data-theme="tide"`) |

**Дизайн-принципы**:
- Один accent на тему (через `--accent-rgb` для `rgba(var(--accent-rgb), α)` — никаких hardcoded rgba).
- Borders translucent at low alpha — белый в `ink`, холодная сине-стальная `rgba(115,168,210, α)` в `tide`.
- Семантические цвета (`--green/--red/--orange/--yellow/--pink/--purple`) **константны** — OK/error сигналы не должны менять оттенок.
- Glossy: `--gloss-top: inset 0 1px 0 rgba(255,255,255,.04)`, `--gloss-edge: inset 0 0 0 1px rgba(255,255,255,.02)`.
- Surfaces: везде `var(--surface)` — карточки матчат сайдбар, разделяются только 1px бордером.

`SUPPORTED_THEMES = ['pulse','ink','tide']`; `detectTheme()` дефолтит на `pulse`, `applyThemeAttr()` ставит `data-theme` только для не-pulse (pulse = baseline, атрибут снимается). Юзеры с невалидной сохранённой темой откатываются на дефолт через validity-check — миграция не нужна.

## Dashboard layout

CSS Grid с draggable column dividers. Левая колонка (sidebar) 180-540px, правая (rail) 240-630px. Prefs в `ts_prefs_v1.colLeft/.colRight`. Double-click на divider = reset. Высоты грида/панелей через `calc(100vh - 50px)`.

**Modal sheets** (Settings / Account / Analyze): центрированные с `backdrop-filter: blur(14px)` + затемнением. Body scroll lock. Закрываются по Esc / клик на фон / ✕.

**Bottom nav** (3 таба): **Feed** / **Saved** (⭐, Pro/Admin only) / **Analyze** (🧪, Pro/Admin only). Saved активен когда `view==='trends' && favoritesOnly`. Free/Test видят Saved/Analyze с 🔒 + dashed-border, click → upgrade toast. Saved-таб показывает счётчик `favoriteCount` от server.

**Login screen** (EN-only). Лого-кот через `<img src="/assets/logo.png?v=LOGO_VERSION">` с onError-fallback на `"C"` monogram (R4 заменил 🐱-emoji). Glass-карточка max-width 440px с backdrop-blur (ambient blobs + grid убраны в R3). CTA-кнопка solid `var(--accent)` (gradient убран в R3) + SVG paper-plane `rotate(-25deg)`. Footer — X-pill `𝕏 @Catalystparser`. **Cat mascot** (`<CatMascot route="login">`) сидит в правом-нижнем углу карточки — см. секцию «Cat mascot». Все цвета через CSS-vars → авто-адаптация.

**Top nav (post-auth)**: справа три кнопки — Telegram-bot link (paper-plane SVG, URL `https://t.me/<BOT_USERNAME>`, username резолвится при старте через `telegram.getBotUsername()` → `bot.getMe()` cached в `this._botUsername`, инжектится в SPA template как `BOT_USERNAME` константа), X-link `https://x.com/Catalystparser`, account button.

**TrendModal**: head — **⭐ favorite (leftmost)** / alertType / category / 🧪 MANUAL / phase-badge / source / time / ✕. Snapshot-banner `🗄 Saved copy — original may have been removed` если тренд из favourite-snapshot. Body — **FavoriteNoteEditor** (если saved) → media → title → 🔥 Триггер (whyNow) → 🔮 Каталист (forecast / CTA / **locked-card** для free/test) → links (Source / Telegram / 🧠 Ask Grok) → 🔥 Топовые твиты (x_trends only) → feedback → score bars → stats grid.

**ImageCarousel**: tracks `Set<failedIndices>` локально — onError маркает индекс failed, фильтр пересобирает gallery. Если все умерли — carousel не рендерится. `_formatTrend` фильтрует Twitter avatar URL'ы (`/profile_images/`, `_normal/_bigger/_400x400`) из `imageUrls + imageUrl`.

**Right panel (rail)**: Top narratives (top-10 по adoption) → 🟢 Live (signals/alerts/avg-virality stats + sources sub-block с brand-tinted pill'ами).

**Per-trend hide / archive**: ✕-кнопка в `.feed-card` (hover-only, 22×22). Клик → `POST /api/trends/:id/hide` + 5s undo-toast. Архив в `SettingsPanel` — collapsible `<ArchiveCard>` (lazy-load на open), retention 7 дней.

**Favourites**: ⭐ inline в `.feed-user-row` (после avatar, **слева**) и в `.modal-head` (leftmost). Filled когда saved (accent-tint), outline иначе. Hover-only когда не сохранено. Pulse `favPulse` на add. `note` (cap 500 chars) в `FavoriteNoteEditor` (collapsible: «add note» CTA / view + ✏ edit + ✕ remove / textarea + Save/Cancel, Cmd-Enter — save).

**Locked-визуалы для Free** (sidebar + Live-панель): premium-источники (Twitter/TikTok/X-Trends) с 🔒, dim opacity 0.55, dashed-look. Click → upgrade-toast. `/api/sources` возвращает `inPlan: bool` на основе `getPlanEntitlements(planName).sources`.

**Catalyst forecast locked-card**: для free/test в TrendModal вместо disabled-кнопки — **информационная locked-карточка** (36×36 icon-tile с 🔒 на X-blue glow + bold title + dim subtitle «Available on Test and Pro plans»).

**Link hover preview** (Twitter + Reddit): наведение на `↗ Twitter`/`↗ Reddit` ссылки → 350мс debounce → floating-карточка с содержимым поста (avatar/title/text/media/engagement). Кликабельные имена/аватары → ссылка на профиль. Auto-flip вверх если мало места снизу. **Per-user toggle** в SettingsPanel → Appearance → «👁 Hover preview»; `localStorage.ts_prefs_v1.hoverPreview` (default ON). Хук читает pref свежим на каждом mouseover.

- **Backend**: `GET /api/tweet-preview?id=<tweet_id>` (fxtwitter, free) и `GET /api/reddit-preview?id=<post_id>` (reddit JSON, free). LRU-кэш (500 entries, 5-мин TTL для 200, 30-сек для 4xx). После fetch — `db.updateTwitterEngagement` / `db.updateRedditEngagement` пишут свежие views/likes/upvotes/comments + computed velocity в `raw_metrics`.
- **Frontend**: атрибут `data-tweet-id` или `data-reddit-id` на `<a>` ссылке (URL-pattern based, **не** по `trend.source`). Универсальный `useTweetHover` хук матчит оба, унифицированный `<TweetHoverPreview>` со `state.kind` switch.
- **Live update**: после fetch'а frontend диспатчит `CustomEvent('link-metrics-update')`. App listener патчит `setTrends` и `setModalTrend`. Backend параллельно записал в DB → следующий /api/trends pull тоже свежий.

**Velocity computation** (в `db.updateXxxEngagement`): Δviews|upvotes / Δhours от предыдущего snapshot (`metrics._engSnapshot`) ИЛИ от scrape-time baseline (`metrics.views|upvotes + first_seen_at`) на первом refresh. Min gap 5 минут (фильтр шума), Δ > 0 (защита от counter-rollback). Snapshot обновляется на каждом fetch'е. Применяется одинаково для hover-driven и для light-cycle.

**Account panel**: hero card + аватар (TG profile photo через `/api/auth/avatar`, disk cache TTL 7 дней, throttle refresh 6ч) + plan badge + threshold slider + logout.

## Sidebar filters (dashboard)

Phase + alert-type chips поддерживают **multi-select**. Хранятся как sorted CSV-строки в state, persist в localStorage.

- **Phase**: `?phase=early,forming,strong` → server SQL `IN (?,?,...)`. localStorage `ts_phase_filter`.
- **Alert type**: client-side filter через `Set(alertTypes.split(','))`. localStorage `ts_alert_type_filter`.
- «Все» (◆) chip exclusive — клик сбрасывает CSV.
- Reset-link появляется если CSV непустой.

**Category dropdown**: кастомный `CategoryDropdown` (нативный select игнорировал CSS на chromium). Открывается **вверх** (компонент сидит низко в sidebar). Click-outside (mousedown) + Esc закрывают. Без скролла внутри.

## Cat mascot

Декоративный pixel-art кот в стилистике лого. Tier 2.5 hybrid — живёт сам (idle pose pool с walk-cycle), реагирует на 3 события (Forecast Catalyst loading, 60s inactivity, triple-click). Pixel-art контрастирует с flat UI — индийско-крипто-хищник вайб. **Не функциональный — чистый прикол.**

**Sprite assets** (`assets/cats/*.png`, 9 sheets):
- `cat-idle` (15f) / `cat-cute` (15f) / `cat-headup` (16f, играется 13) / `cat-staytall` (17f) / `cat-lying` (17f, skip-ranges 15-27) — sitting/lying poses.
- `cat-lie` (17f, curled) / `cat-observe` (17f) — sleep / forecast-watching reactive.
- `cat-walk` (16f face-right) / `cat-walk-left` (16f mirrored) — walk-cycle.
- Builder: `scripts/build-cat-poses.py` (PIL crop + skip_ranges + horizontal concat). Mirror: `scripts/sprite_mirror_crop.py`.
- Source: `EvilCatPack/` (itch.io) — **исключён из deploy через `deploy.ps1` EXCLUDE**, доезжают только готовые PNG.

**Backend** (`server.js`):
- `_handleCatSprite` — стрим PNG из disk, regex-anchored whitelist `/^\/assets\/cats\/cat-(idle|walk|walk-left|lie|observe|cute|headup|staytall|lying)\.png$/` (path traversal через regex impossible).
- `_catSpritesVersion` — cache-bust token = `max(mtime)` по всем 9 sprite файлам. При замене ЛЮБОГО спрайта все ре-fetch'атся.

**FSM** (`CatMascot` component):

| Group | States | Sticky? | Sprite |
|---|---|---|---|
| Idle (dashboard pool) | idleSitting · idleCute · idleHeadUp · idleStayTall · idleLying | yes | cat-{idle,cute,headup,staytall,lying} |
| Idle (login pool) | idleCute · idleLying | yes | cat-{cute,lying} |
| Sleep | idleSleeping · idleHeadUpAsleep | yes (до activity) | cat-lie / cat-headup frame 1 (static) |
| Walk-cycle | walkingLeft → disappearing → dormant → appearing → walkingHome → next-random-idle | no | cat-walk-left / cat-walk |
| Reactive | forecastWatching | yes (пока loading=true) | cat-observe |

**Pose-cycle через walk** (не через timer): когда кот в конце walk возвращается домой, FSM рандомно выбирает next pose из pool. Timer-based смена пробовалась — выглядела дёргано (mid-idle pose mutation). Walk interval **5-10 мин** (CAT_TIMINGS.WALK_THROUGH_INTERVAL_{MIN,MAX}_MS).

**Random initial pose**: на mount `useState(function() { return pool[random]; })` — при перезагрузке дашборда дефолтная поза разная.

**Reactions** (3 в v1):
- **R2 Walk-through**: random 5-10 мин из idle → walkingLeft (5.6s) → fade-out → dormant (30-60s) → fade-in → walkingHome (5.6s) → next-random-idle. Pacman-respawn — выходит влево, возвращается слева.
- **R3 Forecast watching**: на старте Forecast Catalyst → `forecastWatching` (cat-observe). На `finally` → возврат в `idleSitting`. Реагирует на `catalyst:forecast-loading` event.
- **R6 Inactivity sleep** (60s, `INACTIVITY_TIMEOUT_MS`): любая idle поза → `idleSleeping`, кроме `idleHeadUp` → `idleHeadUpAsleep` (static head-down frame с dim glow). Activity events (mousemove/wheel/touchmove/scroll/keydown/click, passive) → wake to `idleSitting` или `idleHeadUp` соответственно.

**Hidden Easter eggs**:
- **Triple-click на коте** (1500ms окно): 3 клика → `walkingLeft`. Курсор НЕ меняется на pointer — скрытый прикол. Только из idle поз. На login disabled.
- **Triple-click на лого** в Header (1500ms окно): toggle off/on cat-mascot. `localStorage.catMascotOff` + i18n toast (`cat.toggle_on/off`) + dispatch `catalyst:cat-toggle`.

**Route-divergence** (dashboard vs login):
- Dashboard: `position: fixed` в sidebar nav box над Feed/Saved/Analyze. `bottom: 73px; left: 73px` (idleSitting base). Per-pose left/bottom overrides для центрирования: idleCute:103, idleHeadUp/Asleep:108, idleStayTall:109, idleLying:103+bottom 63, idleSleeping:101. Walking states left:97 (HOME_X_PX) — иначе walk-start «прыгает» от центра поз к base.
- Login: `position: absolute; right: 0; bottom: 100%; transform: scale(1.1); transform-origin: bottom right` — кот в углу карточки. Pool [idleCute, idleLying], cycle 60s (`LOGIN_POSE_CYCLE_MS`). lying: `bottom: calc(100% - 10px)` — лапа свисает за край. Свои speed multipliers (cute +30%, lying +10%) через `[data-route="login"]` атрибут селекторы.

**Eye-blink-synced glow**: 6 sprite'ов имеют `@keyframes catXxxGlow` с alpha blink `rgba(255,50,50, 0.2 → 0.1 → 0.2)` синхронно с моментами когда у кота глаза закрыты. `linear` timing + 2% anchor buffer → smooth ~80ms fade. Per-sprite frame-by-frame анализ. `idleHeadUp` glow трек удалён (после редизайна в активной анимации глаза всегда открыты).

**Visibility gate**:
- `localStorage.catMascotOff` → cat unmount.
- `matchMedia('(max-width: 700px)')` → cat unmount (mobile cleanup).
- `document.visibilityState` → `.cat-paused` class freezes animations + transitions (Page Visibility API). Resume on visible.
- Window resize >100px during walk → snap home, return to idleSitting (teleport).

**Edge cases**:
- Forecast triggers mid-walk → cancel walk, immediate forecastWatching at current position. После loading=false → idleSitting (no walk-resume).
- Cat toggle OFF mid-walk → unmount → useEffect cleanups clear all timers/listeners.
- localStorage SecurityError (private mode) → silent no-op.

**i18n keys**: `cat.toggle_on`, `cat.toggle_off` (EN + RU).

## Admin panel

`src/admin/server.js` — inline React SPA. **10 табов**: 📊 Stats / ⚙️ Сканеры / 🎛️ Пресеты / 🔄 Auto-tags / 🧪 Ручной анализ / 🔔 Алерты / 🎓 AI Examples / 👥 Пользователи / 💳 Платежи / 🤖 Бот.

**Топбар (`StatusBar`)**: live-pipeline визуализация. Polls `/api/pipeline` каждые 2.5с, рендерит 8 stage-нод + 7 wires. Subtitle: `Live — Stage 1...` / `Последний цикл 12с назад` / `⏸ Сканер на паузе`. На `max-width: 1100px` оборачивается под заголовком.

**Live nav indicators**: poll каждые 12с в App. Yellow pulsing dot на «Сканеры» при паузе. Accent badge на «Алерты» со счётчиком.

**Bot tab разделён на 3 sub-tabs**: 🧠 AI / 📢 Рассылки / 💰 Планы и фидбек.

**UsersPage**: action-column 420px → ⚙ кнопка + drawer-row снизу с группами Подписка / Статус. State `expandedId` (single-row-open).

**Maintenance** (Stats): карточка «🧹 Обслуживание базы» с 5 кнопками:
  - **🧹 Очистить старые алерты** (btn-danger): удаляет тренды + notifications старше N дней (prompt).
  - **💾 VACUUM** (btn-warning): `POST /api/admin/maintenance/vacuum` — сжимает БД (блокирует ~1с).
  - **🎞 Video cache** (btn-secondary): `POST /api/admin/maintenance/cleanup-video` — удаляет muxed видео старше 3д.
  - **🔑 Auth sessions** (btn-secondary): `POST /api/admin/maintenance/cleanup-auth` — удаляет незавершённые сессии старше 24ч.
  - **📜 Rotate logs** (btn-secondary): `POST /api/admin/maintenance/rotate-logs` — удаляет лог-файлы старше 14д.
  + **Бэкап карточка**: показывает статус последнего бэкапа (зелёная если < 36ч, жёлтая если < 7д, жёлтая else). Также показывает размер бэкапа в bytes или "папка отсутствует".

**Сканеры таб layout**: сверху 3 stat-cards + scanner-status-bar с Pause/Force-Scan. Ниже — 5 collapsible accordion'ов на `pcfg-accordion`: «📡 Площадки» (open) · «🎯 Конфиг сканера» (open) · «🎨 Stage 0 — PreStage» (closed) · «🔁 Обновление горячих трендов» (closed) · «📊 Junk-filter наблюдение» (closed). Внутренние компоненты `ScannerConfigSection / PreStageSection / HotRefreshSection / JunkStatsSection` рендерят bare-div без `adm-card`.

**SubmitPage history**: горизонтальная strip mini-карточек последних manual-submitted трендов. Click → переключает active детальную панель `ManualResultCard`.

**Унифицированные примитивы**:
- `.adm-card` — universal section wrapper (бывш. `.broadcast-box`).
- `.adm-tabs / .adm-tab / .adm-tab-count / .adm-tab-dot` — единый таб-стрип.
- `.dec-*` (DecisionsPage) · `.sb-*` (StatusBar) · `.scfg-*` (ScannerConfigSection) · `.pcfg-*` (PresetConfigsPage) · `.sp-*` (SubmitPage) · `.exp-*` (ExamplesPage).

**Section primitive**: `<Section icon title desc actions>{children}</Section>` определён, готов к использованию для постепенного refactor от `.adm-card` блоков.

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
| `src/analysis/embeddings.js` | text-embedding-3-small cosine для clusterer |
| `src/analysis/image-hash.js` | dHash thumbnail hashing для clusterer |
| `src/analysis/manual-analysis.js` | Manual URL analysis orchestrator |
| `src/analysis/url-resolver.js` | Resolve Twitter/Reddit/TikTok/og:image URL → synthetic trend |
| `src/analysis/prompts.js` | Stage 1/2 prompts + JSON schemas + ALERT_TYPE_VALUES |
| `src/analysis/lifespan.js` | Lifespan keys single source of truth |
| `src/analysis/market-stage.js` | [opt-in] MarketStage detection |
| `src/analysis/filter-profiles.js` | Junk-filter penalty defaults |
| `src/billing/entitlements.js` | Plan entitlements — shared by bot + dashboard |
| `src/collectors/{reddit,twitter,tiktok,google,x-trends}.js` | Apify-based collectors per platform |
| `src/db/database.js` | SQLite wrapper, migrations, settings, feedback_votes, hidden_trends, support_threads, user_favorites |
| `src/admin/server.js` | Admin SPA (inline React в template literal) |
| `src/dashboard/server.js` | Dashboard SPA (inline React в template literal). Включает `CatMascot` FSM + asset handler |
| `docs/audit/INDEX.md` | Master integration backlog 12-stage audit series (2026-05-22..06-02). 291 findings, 19 «one-fix-many-wins» bundles, tiered priority, verdicts dashboard. **Главная точка входа** для brainstorm/fix phase |
| `docs/audit/2026-*.md` | 12 individual audit reports (security / pipeline / billing / cost / db-health / dashboard-ux / admin / tg-bot / production / cat-r7 / code-quality / documentation-spec-drift) |
| `assets/cats/cat-*.png` | 9 pixel-art sprite sheets для cat-mascot (idle/walk/lie/observe + 4 idle pose variants) |
| `scripts/build-cat-poses.py` | Sprite builder: PIL crop + `skip_ranges` + horizontal concat из `EvilCatPack/` |
| `scripts/sprite_mirror_crop.py` | Mirror cat-walk → cat-walk-left (face-left для return-walk) |
| `scripts/build-cat-sprites.py` | R6 base builder (4 первых спрайта) — legacy, новые позы через build-cat-poses |
| `src/notifications/telegram.js` | TG bot, alerts, /menu, /analyze, reason wizard, attachXButton, `fetchFile()` |
| `src/notifications/formatter.js` | Alert message formatter (HTML for TG) |
| `src/notifications/alert-dispatcher.js` | Shared alert dispatcher — used by scan-cycle и hot refresh |
| `src/support/bot.js` | Support bot (forum-topics relay) |
| `src/refresh/hot-metrics.js` | Hot trends refresh — heavy (12h, LLM rescore) + light (60min, metrics-only) |
| `src/refresh/tag-refresher.js` | Weekly Grok-driven tag refresh — subreddits + Twitter keywords per preset, w/ Live Search + Reddit & Apify reality-check + lock-mask + admin Telegram digest |
| `src/i18n/{ru,en}.js` | i18n maps для telegram + dashboard |
| `src/utils/{logger,rate-limiter,url-safety,sqlite-time}.js` | Shared helpers: logger, `UserRateLimiter`, URL safety (`safeHref`/`safeUrl`/`escHtmlAttr`), `sqliteCutoff` (space-format cutoff — см. §Ловушка SQLite TEXT timestamps) |
| `src/notifications/{admin-alert,telegram-retry}.js` | `notifyAdminCrash` (crash→support TG, dedupe) + `withTelegramRetry` (429 retry honoring retry_after) |
| `README.md` | Public-facing project README (pitch + quick start + tech stack + layout) |
| `DEPLOY.md` | Production deployment runbook (setup, backups, restore §6.5, DR §6.7, cert §4.2, secret rotation §10.1, troubleshooting §13) |

## Production posture

Catalyst публично захощен на `https://catalystparser.io` (TLS, port lockdown, ufw, daily backup).

**Edge stack** (на VPS, не в Docker):
- **nginx** (`/etc/nginx/sites-available/catalyst`) — reverse-proxy на `127.0.0.1:8080`. SSE-friendly (`proxy_buffering off`, `proxy_read_timeout 24h`). `Host/X-Real-IP/X-Forwarded-*` headers + Authorization passthrough. `set_real_ip_from 127.0.0.1` + `real_ip_header X-Forwarded-For`.
- **Let's Encrypt cert** (R13) — auto-renew через `certbot.timer` (ежедневно). Покрывает `catalystparser.io` + `www.catalystparser.io`, 80→443 редирект.
- **ufw**: default deny incoming, allow только 22 (SSH), 80, 443.
- **Daily backup**: cron 03:30 UTC (`/etc/cron.d/catalyst-backup`). Source of truth: `scripts/catalyst-backup.sh` в репо, `deploy.{sh,ps1}` копирует его в `/usr/local/bin/catalyst-backup.sh` на VPS при каждом deploy (idempotent). Скрипт: discover'ит mountpoint named volume `catalyst_data` через `docker inspect` (с guard'ами на пустые значения и наличие DB-файла), **PRAGMA integrity_check** на исходной БД (если corrupt — fail без перезаписи вчерашнего хорошего бэкапа), `sqlite3 .backup` (locking-aware), **stat-size sanity** (если backup < 4096 bytes — fail), gzip → `/var/backups/catalyst/`, **gzip -t verify** (если архив битый — удалить + fail). Local retention 14 дней. Off-site: `rclone copy` на Backblaze B2 (`b2:catalystparser-prod-backups`, ~$0.03/мес), лог `/var/log/catalyst-backup-rclone.log`. B2 lifecycle: hide files after 30 days + delete 1 day later (auto-cleanup). rclone config в `/root/.config/rclone/rclone.conf` (root-only, не в git). Скрипт использует `set -euo pipefail`, exit code rclone не глушится `tee`. **Restore procedure**: DEPLOY.md §6.5. **Quarterly drill**: DEPLOY.md §6.6.
- **Deploy gate**: `deploy.{ps1,sh}` обязательно прогоняет `npm run check:spa` (вызывает `scripts/check-dashboard-spa.cjs` + `scripts/check-admin-spa.cjs`) ДО архивации. Validators ловят SPA-trap (backticks в комментариях, escape sequences, double-escape regex) до того как broken SPA достигнет prod. Bundle #16 (2026-06-04) закрыл QUAL-001 + PROD-002/003.
- **nginx config**: source of truth — `scripts/nginx-catalyst.conf` в репо. На изменении: scp → `/etc/nginx/sites-available/catalyst` на VPS + `sudo nginx -t && systemctl reload nginx`. Не правим вручную на сервере (drift unrecoverable). Прод-конфиг: `proxy_pass http://127.0.0.1:8080` (dashboard), admin на `:8081` localhost-only без nginx. Bundle #17 (2026-06-05).
- **Cert monitoring**: `/usr/local/bin/check-cert-expiry.sh` (source: `scripts/check-cert-expiry.sh`) запускается ежедневно через `/etc/cron.daily/catalyst-cert-check`. Warn в `/var/log/catalyst-cert.log` если < 14 дней до expiry. Externally проверяет via `openssl s_client`. Подробности: DEPLOY.md §4.2. Bundle #17.
- **Secret rotation**: schedule + per-key procedure — DEPLOY.md §10.1. 90д для AI keys (xAI/OpenAI/Gemini/OpenRouter) + ADMIN_API_KEY, 180д для Apify/Helius/DASHBOARD_API_KEY/SUPPORT_BOT_TOKEN, only-on-leak для TELEGRAM_BOT_TOKEN. Bundle #17.
- **URL safety helpers** (Bundle #3, 2026-06-07): `src/utils/url-safety.js` exports `escHtmlAttr()` (5-char HTML attr escape), `safeUrl()` (https/http protocol whitelist via `URL()` constructor), `safeHref()` (combined attr-escape + protocol check, returns `'#'` on invalid). Applied in `formatter.js:145` (TG alert href — skip link entirely if URL invalid) and dashboard SPA JSX (4 sites: feed action button, modal source link, X-trends top tweets, AnalyzeResult hero). **Client-side dashboard SPA имеет inline duplicate** этих функций (cannot ESM-import в template literal — established pattern). Hover preview endpoints `/api/tweet-preview` / `/api/reddit-preview` защищены `getPlanEntitlements().sources.includes(...)` gate (403 если plan не включает source). Закрыто: BOT-001, BOT-002, SEC-006, BILL-001.
- **Observability persistence** (Bundle #2): 3 new DB tables — `admin_audit_log` (plan changes + admin actions, forever retention), `alert_decisions` (dispatcher decisions, 14d retention), `feature_usage_log` (rolling cost counters via `getRecentFeatureUsageHits(userId, feature, windowMs)` → epoch-ms array; 7d retention). Replaces previously in-memory state (decisions ring buffer cap 500, `_catalystHits` / `_manualAnalysisHits` Maps) which lost on restart. 6 new methods on `TrendDatabase`: `recordAuditEvent`, `recordAlertDecision`, `recordFeatureUsage`, `getRecentFeatureUsageHits`, `pruneAlertDecisions`, `pruneFeatureUsageLog`. `_setUserPlan` + `upgradePlan` + `confirmPaymentAndUpgrade` now atomic via `db.transaction()` + audit write. Cleanup tasks (14d / 7d) added to housekeeping `setInterval` loop в `src/index.js`. Migration `scripts/migrate-audit-log-2026-06-07.sql` (idempotent, also re-created on boot via schema.sql `_migrate()`). Closes BILL-002, ADM-002, ADM-005, COST-003, PIPE-016.
- **Error visibility** (Bundle #13, 2026-05-28): `<ErrorBanner>` shared React component inline в обоих SPA templates (dashboard + admin), wired into 4 critical fetch sites (dashboard feed, admin StatsPage/DecisionsPage/StatusBar). `src/notifications/admin-alert.js` exports `notifyAdminCrash(error, context)` — posts to `config.support.groupId` via support bot, with 5-min dedupe via in-memory Map. Wired into `uncaughtException` / `unhandledRejection` (src/index.js) + per-user dispatch loop try/catch (src/notifications/alert-dispatcher.js:176) + TG 4096-char truncate (src/notifications/telegram.js `_sendPlainTextChunked` helper covering 10 callsites в sendAlertToUser, sends full payload to admin для post-mortem). NO Sentry / no third-party SaaS — admin TG group is the destination. Closes ADM-001, UX-001, BOT-003, PROD-006, BOT-020.
- **Bundle #15 (Bot resilience)** — `src/notifications/telegram-retry.js` `withTelegramRetry(sendFn)` обёртка: 1 retry на TG 429 с honor `retry_after` (cap 60s). Применена в `sendAlertToUser` (6 sites), broadcast loop в `admin/server.js`, и `notifyAdminCrash`. Закрывает BOT-006. Broadcast loop теперь маркирует `users.status='suspended'` на 403 — закрывает BOT-007. BOT-021 (global token bucket) отложен — низкий риск при текущем масштабе.
- **Bundle #10 (DB constraints + retention)** — `PRAGMA foreign_keys=ON` + `busy_timeout=5000` в `src/db/database.js` constructor. UNIQUE compound index `idx_notifications_dedup ON (trend_id, channel, user_id)` + `recordNotification` теперь `INSERT OR IGNORE`. 4 новых retention loop'a в `index.js`: notifications 30d, feedback_votes 90d, x_analysis_history 90d, tag_refresh_history 365d. Закрывает DB-005/007/008/009. **Индекс `idx_notifications_dedup` создаётся в `_migrate()` ПОСЛЕ дедупа (Bundle #5 hardening, 2026-05-29) — self-healing на каждом boot, ручная миграция перед deploy больше НЕ нужна** (раньше пропуск миграции ронял прод в 502). `scripts/migrate-db-constraints-2026-05-28.sql` остался опциональным FK-orphan-hygiene скриптом.
- **Bundle #6 (Housekeeping + admin UI)** — daily setInterval'ы в `index.js`: video-cache 3d (tightened from 7d), auth_sessions 24h, logs 14d. `src/utils/logger.js` `cleanupOldLogs()` method. `scripts/catalyst-backup.sh` trap-based TG alert на failure (через `SUPPORT_GROUP_ID`). Admin UI Stats tab: 4 новых maintenance buttons (VACUUM / Video / Auth / Logs) + Backup status card с age-based color (зелёный<36ч / жёлтый ≥36ч). Закрывает DB-010/011/014, DB-022/023, PROD-019, ADM-004. Требует `/etc/catalyst.env` на VPS для backup alert'ов.
- **Bundle #8 (Rate-limit + cooldown)** — per-user `UserRateLimiter` (30 req/5min) на `/api/tweet-preview` и `/api/reddit-preview` в `src/dashboard/server.js` (после BILL-001 plan check). 429 на flood. Closes COST-004. **Pre-closed (verified during recon)**: COST-001 + COST-002 (закрыты Bundle #2 — DB-backed `feature_usage_log`), PIPE-002 (закрыто pre-existing `_recordGoogleSuccess` reset в `gemini-captioner.js:1094`).
- **Bundle #7 (/api/scan admin gate + pause persistence)** — `_handleScan` в `src/dashboard/server.js` теперь требует `plan_name === 'admin'` (403 `reason: 'plan'` иначе) + сразу пишет `lastScanStartedAt` в settings. `/api/scanners/{pause,resume}` в `src/admin/server.js` теперь persist'ят `scanner_paused` через `setSetting('1'|'0')`. На boot `src/index.js` восстанавливает `appState.paused` из DB. Закрывает SEC-001 + PIPE-004 + BILL-003 + ADM-018 + SD-16. No schema change — re-uses existing settings table.
- **A11y compliance** (Bundle #11, 2026-05-28): focus trap для 5 modals (Lightbox, TrendModal, AnalyzePanel, SettingsPanel, AccountPanel) через inline `useFocusTrap(ref, isOpen)` hook в SPA template. Semantic landmarks: `<main id="main-content">` (main-feed), `<aside aria-label="Navigation">` (sidebar), `<aside aria-label="Top narratives">` (right-panel-sticky). Skip link `<a href="#main-content" className="skip-link">` first child of dashboard-grid с visible-on-focus CSS. Heading hierarchy: `right-section-title` теперь `<h2>` (2 sites), `modal-section-label` теперь `<h3>` (9 sites). 2 clickable divs (`.top-item` + interactive `.session-chip`) теперь `role="button"` + `tabIndex={0}` + `onKeyDown` (Enter/Space). CatMascot: `aria-hidden="true"` на root div + `prefers-reduced-motion` extended на cat animations. **Admin SPA not touched** (out of audit scope). Closes UX-002, UX-006, UX-012, UX-013, UX-017, CAT-001, CAT-008.
- **Bundle #4 (db.transaction batching, 2026-05-29)** — 2 новых метода на `TrendDatabase`: `saveTrendsBatch(payloads, {skipErrors, onError})` + `recordAlertScoreHistoryBatch(rows)`, оба через `this.db.transaction()` (один fsync на батч вместо N). Применены в 4 save-loop'ах: `index.js` ×2 (main + low-signal save), `hot-metrics.js` (skipErrors=true), `alert-dispatcher.js` (sparkline). Запись идентична — меняется только атомарность/скорость. COST-007 — false positive (Stage-2 кап держит `.slice`, не счётчик `stage2Calls`; поясняющий коммент в `scorer.js`). Closes DB-013, TXN-002/003.
- **Bundle #5 (sqliteCutoff + space/T bugfix, 2026-05-29)** — канонический `sqliteCutoff` в `src/utils/sqlite-time.js` (детали — §Ловушка SQLite TEXT timestamps). Починен реальный баг: 8 мест сравнивали `toISOString()` («T») против space-колонок → запросы тихо возвращали 0 строк. Восстановлены fuzzy-дедуп / кластеризация / getRecentTrends / admin-статы 7-30д. **Эффект**: меньше почти-дублей в ленте/алертах + точные админ-статы. SD-8 (embeddings TTL docstring) поправлен. Closes DB-012/020/027 + SD-8.

**Audit-fix backlog status** (as of 2026-05-29):
- Tier 1: 3/4 closed (#1 Backup integrity, #16 Deploy hardening, #17 Cert/infra visibility). **#18 QA infra bootstrap — deprioritized 2026-05-29** (operator: малоценно для соло, добавляет husky/CI-возню; revisit перед масштабированием на команду). **Единственный незакрытый пункт всего бэклога.**
- Tier 2: 5/5 closed (#2 Observability persistence, #3 URL safety, #11 A11y compliance, #13 Error visibility, #19 Dead code cleanup). **Tier 2 fully done.**
- Tier 3: **4/4 closed** (#15 Bot resilience, #10 DB constraints + retention, #6 Housekeeping + admin UI, #8 Rate-limit + cooldown). **Tier 3 fully done.**
- Tier 4: **6/7 closed** (#7 /api/scan gate, #20 README+DEPLOY docs, #4 db.transaction batching, #9 hover-preview pre-closed by #3/#8, #12 theme sync doc-only, #5 sqliteCutoff — **починен реальный space/T баг**, тихо ломавший fuzzy-дедуп / кластеризацию / getRecentTrends / admin 7-30д статы). **#14 i18n — DROPPED** (operator YAGNI). **Tier 4 полностью разобран.**
- ⚠ **Commits:** оператор коммитит инкрементально по ходу (throwaway-сообщения вроде `7548575`). ai-context (WORKLOG + этот маркер) — source of truth по сделанному; git history — детали.
- ⚠ **Operator action items before/at deploy:**
  - ~~Bundle #10 migration~~ **RESOLVED 2026-05-29**: пропуск этой миграции уронил прод в 502 (boot crash на `CREATE UNIQUE INDEX` из-за дублей notifications). Устранён прямым фиксом на VPS (дедуп+индекс) + `_migrate()` теперь self-heal'ит дедуп+индекс на каждом boot, так что ручная миграция перед deploy больше не требуется.
  - Bundle #6: ensure `/etc/catalyst.env` on VPS contains `TG_BOT_TOKEN` + `SUPPORT_GROUP_ID` so `catalyst-backup.sh` can fire TG alert on backup failure (silent skip if unset — not fatal).
  - Bundle #1 (pre-existing): first manual restore drill (T9) still outstanding.

**Prod paths cheat-sheet** (для quick SQL/diagnostics):
- **Код**: `/opt/catalyst` (host) — туда деплоится через `deploy.ps1`/`deploy.sh`.
- **Контейнер**: `catalyst-app`.
- **БД host-path**: `/var/lib/docker/volumes/catalyst_catalyst_data/_data/catalyst.db`. Можно читать SELECT'ами напрямую с хоста через `sqlite3` (read-only safe). Писать с хоста параллельно с контейнером **нельзя** — sqlite lock-конфликт.
- **БД in-container path**: `/data/catalyst.db` (env `DB_PATH`, см. `docker-compose.yml`). Для `docker exec catalyst-app sqlite3 /data/catalyst.db "..."`.
- **Логи host-path**: `/var/lib/docker/volumes/catalyst_catalyst_logs/_data/{date}.log` (env `LOG_FILE: /logs/catalyst.log` внутри).
- **NB**: `~/Narrative-Parser/` в домашней root — это **zombie** (древний pre-Docker clone от 2026-03-29 .. 2026-04-14), к проду не относится, можно `rm -rf`.

**Security headers (every response)**: HSTS `max-age=31536000`, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer. Через `buildHeaders(req)` + monkey-patch `res.writeHead` в `_handle()` — каждый response (включая binary, error paths, OPTIONS, SSE) автоматически инжектит defaults.

**CORS allowlist**: `DASHBOARD_ALLOWED_ORIGINS` / `ADMIN_ALLOWED_ORIGINS` (comma-separated env). Empty default = same-origin only. Wildcard `*` нигде не используется.

**Auth rate-limits** (in-memory Maps, sweep на каждом запросе):
- `/api/auth/verify`: cap 5 / 15 мин per-sessionId. Brute-force на 6-значный код невозможен. В 401 ответе — `attemptsRemaining`.
- `/api/auth/initiate`: cap 10 / 5 мин per-IP.
- За прокси без `TRUST_PROXY=1` все IP видятся как proxy. С `TRUST_PROXY=1` ключ Map — real-IP через `X-Forwarded-For`.

**Admin gate**: `POST /api/collectors/:name/toggle` мутирует **глобальный** `appState.disabledCollectors` — server-side check `req.user.plan_name === 'admin'`, иначе 403. Audit: `maskId(chat_id)` админа.

**Graceful shutdown**: `dashboard.stop(timeoutMs)`, `admin.stop(timeoutMs)` оба возвращают Promise. Drain SSE → `server.close()` ждёт active requests до timeout (10s) → `closeAllConnections()`. `index.js`: re-entry guard, hard-cap 15s, `Promise.allSettled` параллельно.

**Hard-fail env validation**: `NODE_ENV=production` + отсутствие `XAI_API_KEY` / `TELEGRAM_BOT_TOKEN` / `ADMIN_API_KEY` → `process.exit(1)`. В dev — warnings.

**Logging conventions для PII / секретов**:
- `maskId(id) → '***' + last4` для всех `telegram_chat_id`. Inline'ится в каждый файл который логирует chat_id.
- **Apify token**: `Authorization: Bearer` header (Bearer держит токен вне URL-поверхности на случай undici URL-leak).
- **Telegram bot-токен**: `telegram.fetchFile(fileId) → {buffer, contentType}` — fetch внутри telegram-модуля. URL `https://api.telegram.org/file/bot<TOKEN>/...` не пересекает границу. В catch — `err.code` (не `e.message`). `getFileUrl()` deprecated.

**HTML cache**: SPA — `Cache-Control: no-cache, no-store, must-revalidate`. Логи / иконки / видео имеют свои `immutable` стратегии.

## Ловушка server.js — backticks И escape-sequences в SPA-строках

`src/dashboard/server.js` и `src/admin/server.js` — огромные inline React SPA внутри **template literal**. Три класса ошибок которые `node --check` НЕ ловит:

1. **Backticks в комментариях**. Любой `` `token` `` в `//` комментарии ломает outer literal с `SyntaxError: Unexpected identifier '<token>'`. **Никогда не писать backtick в комментариях**.

2. **Escape-sequences `\n` `\t` `\r` в строках**. `'foo\n'` внутри SPA — outer literal съедает `\n` (превращает в реальный newline) → unterminated string в браузере → `Uncaught SyntaxError: Invalid or unexpected token` → чёрный экран. **Решение**: `String.fromCharCode(10)` для newline, `String.fromCharCode(9)` для tab. Альтернатива — `\\n` (двойное экранирование).

3. **String-based `RegExp` constructor — двойная интерпретация escape**. `new RegExp('\\d+')` инсайд SPA-template-literal: outer литерал (Node) съедает один `\\` → в HTML отдаётся `'\d+'` → browser JS string literal съедает `\d` → RegExp получает `'d+'` (буква d, не цифры). **Решение**: четыре backslash в source — `'\\\\d+'`. Regex **literal** `/\d+/` — НЕ нужно дублировать. Только string-аргумент `RegExp` требует двойного. `node --check` И `check-dashboard-spa.cjs` оба пропускают (синтаксис валиден, семантика сломана).

**Проверка SPA отдельно** (ловит #1 и #2, **не** #3): `scripts/check-{admin,dashboard}-spa.cjs`. Extracts `<script>...</script>`, unescapes, прогоняет через `vm.Script`. **Запускать после ЛЮБОГО изменения** соответствующего server.js.

## Ловушка SQLite TEXT timestamps vs JS ISO

SQLite хранит `CURRENT_TIMESTAMP` как TEXT в формате `"YYYY-MM-DD HH:MM:SS"` (пробел, без `Z`). JS `new Date().toISOString()` даёт `"YYYY-MM-DDTHH:MM:SS.sssZ"` (с `T`). Сравнение в SQLite — **лексикографическое**: на позиции 10 пробел (0x20) < `T` (0x54) → DB-строка **всегда** меньше cutoff-строки при одинаковой дате → `WHERE col > cutoff` режется в ноль для same-day cutoff'ов.

**Симптом**: query «получи всё активное за последние N часов» возвращает пусто, когда `N < 24`. На 24h работает, потому что cutoff попадает на вчерашнюю дату.

**Фикс**: helper `sqliteCutoff(msAgo)` — **канонический в `src/utils/sqlite-time.js`** (`export function`), форматирует под сторадж: `.toISOString().slice(0,19).replace('T',' ')`. **При любых date-сравнениях с CURRENT_TIMESTAMP / `datetime('now')`-колонками используй его, не голый `toISOString()`.**

Bundle #5 (2026-05-29) свёл сюда 2 дубля (были в `dashboard/server.js` + `manual-analysis.js`) и **починил 8 ранее-сломанных мест** с голым `toISOString()`: `isTrendSeenFuzzy`, `clusterer._fetchHistory`, `getRecentTrends`, admin `_getStats` (7/30д), hidden_trends (×3) — fuzzy-дедуп / кластеризация / админ-статы были тихо пусты, теперь работают.

## Env keys (минимальный набор)

- `APIFY_API` — generic Apify token (back-compat, used by clockworks TikTok actor по умолчанию)
- `APIFY_API_KAITO` — kaitoeasyapi Twitter actor
- `APIFY_API_XQUIK` — xquik Twitter actor (опц.)
- `APIFY_API_CLOCKWORKS` — TikTok clockworks (опц.)
- `APIFY_API_APIDOJO` — TikTok apidojo (опц., нужен для `tiktokActor=apidojo`)
- `OPENAI_API_KEY` — Stage 1 (если provider=openai), Stage 0 nano, embeddings
- `XAI_API_KEY` — Stage 1 (если provider=xai), Stage 2 (всегда)
- `GOOGLE_AI_API_KEY` — Stage 0 Gemini primary
- `OPENROUTER_API_KEY` — Stage 0 Gemini fallback
- `STAGE0_NANO_ENABLED` — panic kill-switch
- `CLUSTER_MULTI_SIGNAL` — panic к Jaccard
- `MARKET_STAGE_DETECTION` — opt-in MarketStage
- `X_TRENDS_REFRESH_MINUTES` — X Trends refresh interval (default 1440)
- `SUPPORT_BOT_TOKEN` / `SUPPORT_BOT_USERNAME` / `SUPPORT_GROUP_ID` — support-бот (все 3 нужны)
- `HOT_REFRESH_ENABLED` / `HOT_REFRESH_INTERVAL_MINUTES` (720) / `HOT_REFRESH_LIGHT_ENABLED` / `HOT_REFRESH_LIGHT_INTERVAL_MINUTES` (60)
- `TAG_REFRESH_COOLDOWN_DAYS` (2) / `TAG_REFRESH_FORCE_COOLDOWN_HOURS` (24) / `XAI_TAG_REFRESH_MODEL` (`grok-4.3`) / `XAI_TAG_REFRESH_FALLBACK_MODEL` (`grok-4.20-0309-reasoning`)
- `REDDIT_USER_AGENT` (default `Catalyst:tag-refresher:v1.0`) — для Reddit reality-check probes в tag-refresher. Reddit требует осмысленный UA для unauthenticated requests.
- `DASHBOARD_PORT` (8080) / `ADMIN_PORT` (8081) — выровнены с Dockerfile EXPOSE и nginx upstream. .env.example синхронизирован 2026-05-07.

**DB settings (escalation + reasoning, generic KV)**: `deepReasoningEnabled` (`'0'`) · `stage2ReasoningModel` (`''`) · `escalationReserve` (`'2'`) · `escLowMemeCeil` (`50`) · `escHighEmergence` (`65`) · `escHighViral` (`60`) · `escBigCluster` (`8`) · `escJunkFloor` (`40`).

**Production deployment** (см. `DEPLOY.md`):
- `NODE_ENV=production` — hard-fail без `XAI_API_KEY` / `TELEGRAM_BOT_TOKEN` / `ADMIN_API_KEY`. В dev — warnings.
- `PUBLIC_BASE_URL=https://catalystparser.io` — канонический origin для absolute links / OG-тегов / Telegram deep-links.
- `TRUST_PROXY=1` — app за nginx, rate-limit'ы читают real-IP через `X-Forwarded-For`.
- `DASHBOARD_ALLOWED_ORIGINS=https://catalystparser.io` — CORS allowlist. `ADMIN_ALLOWED_ORIGINS` пуст (same-origin, админка только через SSH-tunnel).

Полный набор + параметры PreStage / video / lookback — в `.env.example`.

## Контекст-файлы

- `ai-context/AGENT_RULES.md` — обязательные правила для агентов (читать первым)
- `ai-context/SESSION_CONTEXT.md` — этот файл (state-spec)
- `ai-context/WORKLOG.md` — последние ~10 entries, append на верх
- `ai-context/WORKLOG_ARCHIVE.md` — старше 10, архив
- `ai-context/IDEAS.md` — бэклог отложенных идей/направлений (не state, не журнал)
