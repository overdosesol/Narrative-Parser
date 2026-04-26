# WORKLOG

Append-only журнал значимых изменений. Мелкий debug и bootstrap-сессии из начала апреля схлопнуты. Полная история — в git.

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

## Ловушки и правила

- **Backticks в комментариях `server.js`**: `src/dashboard/server.js` и `src/admin/server.js` — огромные inline React SPA внутри template literal. **Любой `` `token` `` в `//` комментарии ломает outer literal** с `SyntaxError: Unexpected identifier '<token>'`. Ловили ≥5 раз. Правило: в этих файлах **никогда** не писать backtick в комментариях. Всегда `node -c <file>` перед деплоем
- **Edit old trends without re-scoring**: `save_only` записи НЕ блокируются `isTrendSeen` — каждый скан клустерер пересмотрит их со свежими метриками; UPSERT по `external_id`/`url` не дублирует
- **`<video>` не шлёт auth headers** → `/api/video/reddit/*` обязан быть public (до auth middleware); regex-валидация `src` защищает от SSRF
- **Apify acc**: `General resource access` должен быть `Restricted`, не `Anonymous` — иначе runId даёт доступ без токена
- **Cache busting**: клиент кэширует bundle агрессивно; при выкатке UI-фич часто нужно ctrl+shift+R (TODO: явный cache-bust при росте аудитории)
- **better-sqlite3 bindings**: требуют recompile под текущий Node (v22.22.2); диагностические скрипты должны уметь fallback на sqlite3 CLI
- **xAI 429**: при исчерпании кредитов Stage 2 пропускается; в UI используется curated fallback для списка моделей
