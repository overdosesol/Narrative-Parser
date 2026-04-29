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
