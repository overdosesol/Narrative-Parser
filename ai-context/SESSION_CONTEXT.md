# SESSION CONTEXT

Обновляется после каждой значимой сессии.

## Проект

- Название: TrendScout (Narrative Parser)
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
