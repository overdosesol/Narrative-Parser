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
- В рассылке алертов введён двухступенчатый gate:
  - `memePotential >= max(user.alert_threshold, global alertThreshold)`
  - `score (virality) >= global viralityThreshold`
- `alertThreshold` из dashboard теперь реально применяется как global floor (раньше фактически не участвовал в send-loop)
- Добавлен глобальный setting `viralityThreshold` (default: 70), доступен в dashboard settings API/UI
- **NarrativeClusterer** (pre-AI слой): Aggregator → Clusterer → Scorer; Jaccard threshold=0.40; routing: `priority`/`stage1`/`save_only`/`drop`; routing теперь через `emergenceScore` (не прямые условия)
- **EmergenceScore** (0–100): три пути — `max(spread, breakout) + ideaBoost`, cap 100
  - Spread: платформы(0–30)+velocity(0–25)+organicSpread(0–20)+noveltyStage(0–15)+authorDiversity(0–10)
  - Breakout: для одиночного вирусного поста (views/likes/retweets/engRate) — detects Twitter/TikTok breakout; dampened by `_normalizeBreakoutByFollowers(score, peakFollowers, engRate)` для мега-аккаунтов
  - **IdeaBoost** (additive, 0–12): Reddit upvotes >=10k→+5, >=15k→+8, >=30k→+10, >=60k→+12; метод `_computeIdeaBoost(items)`
  - **isEarlyIdea** flag: `emergence 20–50 && upvotes >= 10k` — добавляется в `clusterMetrics`
- **AdoptionScore** (0–100): alias для `memePotential` из AI (Stage 1); семантика = "насколько нарратив мемный и липкий"
- **narrativePhase**: `early`/`forming`/`strong`/`saturated`; вычисляется после AI из emergence+adoption; `saturated` = adoption>=60 && emergence<25
- **rankScore**: `e*0.4 + a*0.6` (с опциональным feedback bias ±15%); default sort в dashboard
- **Alert gate**: `emergence >= 20 || adoption >= 60` — иначе алерт не отправляется (снижено с 30 → 20 для ранних Reddit сигналов)
- **JunkFilter** (изолированный optional слой): `src/analysis/junk-filter.js`; call sites помечены `[JUNK_FILTER]`
  - `calculateJunkPenalty(items, clusterMetrics)` → `{ junkPenalty: 0–100, junkReasons: string[] }`
  - Penalties: politics +40, kpop/fandom +30, celeb-noise +20, no-meme-shape +15
  - Safe-signal override: animal/absurd/meme/heartwarming → делим raw на 3 (или 4 при ≥2 сигналах)
  - Alert gate: `junkPenalty >= 35` → skip (в `index.js`)
  - Сохраняется в `raw_metrics` + `_formatTrend` → dashboard API
  - Отключить: удалить import + `base.junkPenalty` блок в `clusterer.js` + gate в `index.js`
- **MarketStage** (изолированный optional слой): feature flag `MARKET_STAGE_DETECTION=1`; 4 состояния: `none/tokenizing/live/overheated`; вся логика в `src/analysis/market-stage.js`; call sites помечены `[MARKET_STAGE]` (~10 строк в 6 файлах); по умолчанию ВЫКЛЮЧЕНО
- **Dashboard**: `TrendCard` — два бара (🌊 Emergence, 💊 Adoption) + phase accent border + `PhaseBadge`; sort: rank(default)/meme/emergence/time/virality; filter by phase: early/forming/strong/saturated
- **Inference cost optimizations (v3.1)**:
  - Feedback context строится один раз на цикл в `_buildFeedbackContext()`, не на каждый batch
  - `_callResponsesAPI` возвращает `{ text, inputTokens, outputTokens }` (реальные токены из `data.usage`)
  - Stage 1 batch size: 5 → 8
  - Stage 2 gate: threshold 70 → 78, cap 3 вызова на цикл, skip google_trends, novelty gate (`clusterMetrics.isNovel !== false`)
  - Prompt: description truncated 250 → 100; поля `titleRu` и `isGenuinelyInteresting` удалены из output spec
  - Логируется `total_in`/`total_out` (реальные токены) после каждого цикла

## AI модели (UI curated)

- xAI: `grok-4-1-fast-non-reasoning`, `grok-4-fast-non-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-3-mini`
- OpenAI: `gpt-4.1-mini`, `gpt-4.1`, `gpt-4o-mini`, `gpt-4o`, `gpt-5-mini`, `gpt-5`

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
  - 4 числовых поля: `feedbackWeightAdmin` (def=3), `feedbackWeightPro` (def=2), `feedbackWeightTest` (def=1), `feedbackWeightFree` (def=1)
  - API: `GET/POST /api/feedback-config`
- **Режим выключено**: учитываются ТОЛЬКО голоса Admin (weight=1); все остальные получают weight=0 → не влияют на `user_feedback`
- **Статистика**: `db.getFeedbackStats(trendId)` → `{ likes, dislikes, weightedScore }`

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

## Персонализированный ранг (2026-04-20)

- **Модель данных**:
  - `feedback_votes` — источник правды для голосов (уже существовал): `(trend_id, chat_id, vote±1, weight, plan_name)`
  - `trends.user_feedback` — глобальный агрегат (уже существовал), не используется для ранжирования
  - Новое: `users.personalization_enabled INTEGER NOT NULL DEFAULT 1` — per-user toggle
- **DB helpers** (`database.js`):
  - `getCategoryPreferences(chatId, days=30)` → `{ category: net }` (JOIN feedback_votes × trends, SUM(vote × weight), GROUP BY category)
  - `getPersonalizationEnabled(chatId)` / `setPersonalizationEnabled(chatId, enabled)`
- **Ранжирование** (`_handleTrends`): при `sort=rank` + auth + toggle=ON + prefs≠{} — `ORDER BY (CAST(JSON_EXTRACT(raw_metrics, '$.rankScore') AS INT) + CASE category WHEN 'X' THEN +3 ... ELSE 0 END) DESC`; каждый boost clamp'ится к ±15; SQL-эскейп category names
- **API**: `GET/POST /api/personalization` — управление toggle и чтение prefs map (list, sorted desc)
- **UI**: `PersonalizationCard` в `SettingsPanel` — независимый компонент, фетчит `/api/personalization`; toggle (🎯) + грид чипов `.pref-chip.up` (зелёные `+N`) / `.down` (красные `−N`); empty-state «проголосуй за несколько трендов»
- **Переводы EN+RU**: `settings.personalization*`
- **Важно**: feedback и персонализация — два read-пути на одних и тех же голосах. Глобальный `trends.user_feedback` продолжает отражать общую реакцию; per-user boost — дополнительный слой поверх `rankScore`, работает только для авторизованных и только в дефолтной сортировке `rank`
- **Окно**: последние 30 дней (старые голоса не учитываются, но остаются в глобальном счётчике)

## Dashboard UX polish (2026-04-20)

- Infinite scroll вместо пагинации: `IntersectionObserver` на `sentinelRef`; `refreshAllRef` для стабильности SSE при смене offset
- Multi-image Telegram alerts через `sendMediaGroup` (до 10 фото, caption только на первой из-за TG 1024-char лимита)
- Top Narratives: 5 → 10 (SQL LIMIT + client .slice)
- Удалены: «Source Pulse» дубль в правой колонке, 📋 copy-title button в карточках

## Ловушка server.js — backticks в комментариях

`src/dashboard/server.js` — единый огромный inline React SPA внутри одного template literal. **Любой бэктик в `//` комментарии ломает outer literal** с `SyntaxError: Unexpected identifier '<token>'`. Уже трижды ловили (id, videoUrl, ref). Правило: в этом файле **никогда** не писать `` `token` `` в комментариях. Всегда `node -c src/dashboard/server.js` перед деплоем.
