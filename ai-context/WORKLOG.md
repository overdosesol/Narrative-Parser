# WORKLOG

## 2026-04-15 (bootstrap)

- Model/session: GPT Codex
- Цель: создать инфраструктуру контекста для мульти-модельной работы
- Изменения:
  - Добавлена папка `ai-context/`
  - Созданы файлы: `AGENT_RULES.md`, `SESSION_CONTEXT.md`, `WORKLOG.md`, `NEXT_STEPS.md`
- Деплой: не требуется
- Примечания:
  - Теперь все агенты должны писать результаты сюда после каждой сессии.

## 2026-04-15 (latest)

- Model/session: GPT Codex
- Цель: финализировать тарифы, UX бота, AI provider switch, и очистить deploy-пайплайн
- Изменения:
  - Планы переведены на `free/test/pro`, удалены legacy-планы `starter/elite`
  - `test` план: $5 на 1 день, one-time, все источники, без X Analysis
  - `pro` план: $100 на 30 дней, все источники
  - Добавлена блокировка повторной покупки `test` по истории confirmed payments
  - Добавлена блокировка `X Analysis` для `test` (callback + уведомление)
  - Обновлены тексты/кнопки в Telegram (`/start` упрощён, `/menu` полный)
  - Добавлено управление рассылками: pin/unpin/delete, история рассылок, управление по конкретному broadcast
  - Добавлено ручное управление пользователями в админке (выдать/снять подписку, бан/разбан)
  - Добавлена очистка алертов через админку + storage guard по свободному месту
  - Добавлено переключение AI provider/model в админке (`/api/ai-config`)
  - Добавлен список моделей по API (`/api/ai-models`) с curated набором
  - Stage 2 `x_search` фиксирован на xAI/Grok даже при выбранном OpenAI для Stage 1
  - Удалены legacy deploy wrappers: `scripts/deploy.sh`, `DEPLOY_NOW.ps1`
- Деплой/проверка:
  - Многократные деплои на `37.1.196.83` через Docker pipeline (`deploy.ps1`)
  - Проверены endpoint'ы: `/api/health`, `/api/ai-config`, `/api/ai-models`, `/api/broadcasts`
  - Проверена изоляция админки: localhost-only bind (`127.0.0.1:8081`)
- Риски/заметки:
  - xAI периодически возвращает `429` (лимит/кредиты), поэтому Stage 2 может пропускаться
  - OpenAI key добавлен в `.env`; рекомендуется ротация секрета после публикации в чате

## 2026-04-15 (handoff update for Claude)

- Model/session: GPT Codex
- Цель: подготовить актуальный handoff-контекст перед переключением на Claude
- Изменения:
  - Обновлён `SESSION_CONTEXT.md` под текущий state runtime и AI pipeline
  - Зафиксировано: Stage 1 = выбранный provider/model, Stage 2 x_search = Grok only
  - Зафиксирован фикс совместимости OpenAI `gpt-5-mini` (ретрай без `temperature`)
  - Зафиксирован актуальный curated список моделей в админке
  - Зафиксировано удаление `ai-context/NEXT_STEPS.md` (по просьбе владельца)
  - Зафиксирован текущий deploy layout: `deploy.ps1` + `deploy.sh`
- Проверка/деплой:
  - Контекстные файлы синхронизированы вручную (без нового деплоя)
- Риски/заметки:
  - xAI кредиты/лимиты могут быть нестабильны (429), что влияет на Stage 2
  - При `AI unavailable` первым делом смотреть `docker logs catalyst-app`

---

## 2026-04-15 (dashboard redesign)

- Model/session: Claude Sonnet 4.6
- Цель: Redisign дашборда — визуал, удобство, функционал не хуже TG-бота. Картинки из источников (OG preview).
- Изменения (файлы):
  - `src/dashboard/server.js`:
    - `_formatTrend()` — добавлено поле `imageUrl` (из `metrics.imageUrl / thumbnailUrl / thumbnail`)
    - `_handlePreview()` — новый endpoint `GET /api/preview?url=` (сервер-сайд fetch og:image)
    - Роутер — добавлен `/api/preview`
    - CSS — добавлены стили: modal/drawer, toast-система, card-image-wrap, search-input, copy-button, kbd shortcuts badge, refresh-badge, shimmer-анимация
    - Новые компоненты: `ImageThumb` (с fallback на `/api/preview`), `TrendModal` (side drawer с картинкой, метриками, ссылками), `Toasts`
    - `TrendCard` — clickable, показывает ImageThumb, copy-кнопка по hover, footer с «↗ открыть детали»
    - `ControlPanel` — принимает `addToast`, health-check через toast вместо `alert()`
    - `App` — добавлены состояния: `modalTrend`, `toasts`, `search`, `refreshAt`; `addToast` helper; `scan` как useCallback; keyboard shortcuts (R/S/Esc); countdown в nav (обновляется каждую секунду); search-фильтр (клиентская сторона); TrendModal и Toasts рендерятся; поиск в toolbar
- Проверка/деплой:
  - Код готов, деплой ждёт запуска `deploy.sh` (или `deploy.ps1`) владельцем
  - Сетевой доступ к серверу из sandbox недоступен
- Риски/заметки:
  - `/api/preview` делает внешний HTTP-запрос с сервера — если og:image нет или сайт блокирует боты, вернётся `{ imageUrl: null }`, карточка покажет emoji-placeholder
  - Keyboard shortcut `S` будет игнорироваться пока input/select в фокусе

---

## 2026-04-15 (sort feature)

- Model/session: Claude Sonnet 4.6
- Цель: добавить сортировку по времени и по топу в дашборд
- Изменения (файлы):
  - `src/dashboard/server.js`:
    - `_handleTrends()` — расширена логика `sort`: теперь поддерживает `meme` (по умолчанию, meme_potential DESC), `time` (first_seen_at DESC), `virality` (score DESC)
    - `App` — добавлен state `sort`, передаётся в API-запрос, select «Сортировка» в toolbar
- Проверка/деплой: ожидает деплоя владельцем
- Риски/заметки: нет

---

## 2026-04-16 (pre-AI signal quality layer)

- Model/session: Claude Sonnet 4.6
- Цель: спроектировать и реализовать pre-AI слой NarrativeClusterer для снижения шума без потери ранних нарративов
- Изменения (файлы):
  - `src/analysis/clusterer.js` (новый файл, ~210 строк):
    - Класс `NarrativeClusterer` с методами: `route()`, `_clusterByJaccard()`, `_fetchHistory()`, `_computeMetrics()`, `_decide()`
    - Кластеризация через Jaccard similarity на word sets (threshold=0.40), без ML/embeddings
    - DB-запрос последних 48ч по LIKE на первые 2 слова нарратива (≤30 строк)
    - Cluster-level метрики: batchSize, uniquePlatforms, batchAuthors, textVariation, dbRecentCount, isNovel, velocity, maxEngagement
    - Routing: `drop` / `save_only` / `stage1` / `priority`
  - `src/index.js`:
    - Добавлен import NarrativeClusterer
    - Добавлен `const clusterer = new NarrativeClusterer(db, logger)`
    - Вставлен Step 2.5 между aggregator и scorer:
      - `clusterer.route(newTrends)` → { priority, toScore, toSave, droppedCount }
      - `toSave` сохраняются напрямую (score=0, без AI)
      - `[...priority, ...toScore]` идут в scorer (priority — первыми в батче)
- Проверка/деплой: ожидает деплоя владельцем
- Риски/заметки:
  - LIKE-запрос по title может давать ложные срабатывания на коротких тайтлах — защита: требуем ≥2 слов для pattern
  - DROP-порог (8 appearances, 1 платформа, velocity<0.15) консервативен — можно снизить до 5 если шума всё ещё много
  - Priority-items идут первыми в батч scorer'а — при xAI 429 они приоритетно обработаются
  - `save_only` items не попадают в алерты (memePotential=0), но видны в дашборде

---

## 2026-04-16 (remove suggestedTicker end-to-end)

- Model/session: GPT Codex
- Цель: полностью удалить тикерную AI-логику (`suggestedTicker`) из пайплайна, хранения и UI
- Изменения (файлы):
  - `src/analysis/prompts.js`: удалено требование поля `suggestedTicker` из Stage 1 prompt; удалена строка `Suggested ticker` из Stage 2 prompt builder
  - `src/analysis/scorer.js`: удалён маппинг `suggestedTicker` из Stage 1 ответа; удалён `suggestedTicker` из `_applyHeuristic()` и `_fallback()`
  - `src/db/database.js`: в `saveTrend()` из `raw_metrics` удалена запись `suggestedTicker`
  - `src/dashboard/server.js`: удалено чтение `metrics.suggestedTicker` в `_formatTrend`; удалены UI-блоки «Тикер» из карточки и modal; удалены CSS-классы `.ticker` и `.ticker-none`
  - `src/notifications/telegram.js`: удалено чтение `suggestedTicker` при формировании top trends
  - `src/i18n/en.js`, `src/i18n/ru.js`: удалён неиспользуемый ключ `alertTickers`
- Проверка/деплой:
  - Выполнен `node --check` для всех изменённых файлов (`prompts.js`, `scorer.js`, `database.js`, `server.js`, `telegram.js`, `en.js`, `ru.js`) — без синтаксических ошибок
  - Выполнен прод-деплой через `deploy.ps1` на `37.1.196.83` (Docker), получен `DEPLOY_SUCCESS`
  - Проверен `GET /api/health` на `http://37.1.196.83:8080/api/health` — `{"ok":true,...}`
  - Проверена запись в БД (`/data/catalyst.db`): в последних строках (`id=419,420`) поле `suggestedTicker` отсутствует; в более старых строках поле остаётся как legacy
- Риски/заметки:
  - Старые записи в БД могут содержать `suggestedTicker` в `raw_metrics`, но новый код это поле не читает и не отображает

---

## 2026-04-16 (inference cost optimization)

- Model/session: Claude Sonnet 4.6
- Цель: снизить inference cost без потери качества скоринга
- Изменения (файлы):
  - `src/analysis/scorer.js`:
    - Добавлен метод `_buildFeedbackContext()` — feedback строится один раз на вызов `scoreTrends()`, не повторяется на каждый batch (экономия ~200 tokens × (N_batches-1))
    - `_callResponsesAPI` теперь возвращает `{ text, inputTokens, outputTokens }` вместо plain string
    - `_extractTextFromResponse` переименован в `_extractResponseData` — парсит `data.usage.input_tokens` / `data.usage.output_tokens`
    - `_analyzeBatchStage1` принимает pre-built `systemPrompt` (третий аргумент), накапливает реальные токены в metrics
    - `_stage2DeepDive` возвращает `{ inputTokens, outputTokens }` для аккумуляции
    - `const batchSize = 5` → `batchSize = 8`
    - Stage 2 threshold: 70 → 78
    - Stage 2 cap: max 3 вызова на цикл (`this.stage2MaxCalls = 3`, `.slice(0, 3)`)
    - Stage 2 gate: пропускаем google_trends (`source !== 'google_trends'`)
    - Stage 2 novelty gate: `clusterMetrics?.isNovel !== false` — не гоняем x_search по заведомо старым нарративам
    - Логируется `total_in`/`total_out` (реальные токены) через `this.logger.info()`
  - `src/analysis/prompts.js`:
    - Description truncation: 250 → 100 символов
    - Поле `titleRu` удалено из output spec (требование JSON) и из HARD RULES (правило №2)
    - Поле `isGenuinelyInteresting` удалено из output spec
    - SYSTEM_PROMPT HARD RULE #2 упрощён: «All output fields must be in ENGLISH.»
  - `src/analysis/clusterer.js`:
    - В `_decide()` добавлен engagement gate перед финальным `save_only`: `if (maxEngagement < 200 && batchSize <= 1 && dbRecentCount < 2) return 'save_only'`
    - (gate логически избыточен сейчас, но явно документирует намерение и упростит будущее расширение)
  - `ai-context/SESSION_CONTEXT.md`: обновлён раздел «Важные технические решения»
- Проверка/деплой:
  - Ожидает деплоя владельцем (`deploy.sh` / `deploy.ps1`)
- Риски/заметки:
  - `titleRu` и `isGenuinelyInteresting` убраны из prompt-spec, но scorer.js всё ещё читает `a.titleRu` и `a.isGenuinelyInteresting` для обратной совместимости — если модель их вернёт (старый промпт кэшируется или тест), ничего не сломается
  - batch_size=8 может увеличить риск parse-ошибок на очень длинных ответах; при первых признаках вернуть к 5 или 6
  - Stage 2 cap=3 — при большом числе высокопотенциальных трендов часть не пройдёт x_search; это приемлемо (лучшие 3 по score идут первыми)

---

## 2026-04-17 (Emergence + Adoption двухскоровая система)

- Model/session: Claude Sonnet 4.6
- Цель: разделить оценку нарративов на два независимых измерения (распространение vs. мемный потенциал); дать трейдеру чёткий сигнал о фазе нарратива
- Изменения (файлы):
  - `src/analysis/clusterer.js`:
    - Добавлен `_computeEmergenceScore(m)`: 5 компонентов, max=100 (платформы 0–30, velocity 0–25, organicSpread 0–20, noveltyStage 0–15, authorDiversity 0–10)
    - `_computeMetrics()` теперь вызывает `_computeEmergenceScore` и сохраняет в `metrics.emergenceScore`
    - `_decide()` переписан: routing по `emergenceScore` вместо набора разрозненных условий; DROP только если emergence И velocity И uniquePlatforms низкие (высокий dbRecentCount один по себе больше не дропает)
    - Добавлены явные константы `DROP_VELOCITY_MAX`, `DROP_EMERGENCE_MAX`, `SAVE_EMERGENCE_MAX`, `SAVE_ENGAGEMENT_MAX`, `PRIORITY_EMERGENCE`, `STAGE1_EMERGENCE`
  - `src/analysis/scorer.js`:
    - Экспортированы `narrativePhase(e, a)` и `narrativeRankScore(e, a, bias)` как named exports (для использования в index.js и server.js в будущем)
    - `_analyzeBatchStage1` вычисляет `adoption`, `emergence`, `phase`, `rankScore` для каждого тренда
    - Поля добавлены: `adoptionScore`, `emergenceScore`, `narrativePhase`, `rankScore`
    - `_stage2DeepDive` пересчитывает `adoptionScore`, `narrativePhase`, `rankScore` после Stage 2 корректировки
    - Heuristic fallback (`_applyHeuristic`, `_fallback`) также заполняет новые поля
  - `src/db/database.js`:
    - `saveTrend()` теперь сохраняет `adoptionScore`, `emergenceScore`, `narrativePhase`, `rankScore` в `raw_metrics`
  - `src/index.js`:
    - Alert candidates сортируются по `rankScore` (fallback: `memePotential`)
    - Добавлен emergence gate в alert loop: `emergence >= 30 || adoption >= 60` — без этого алерт не отправляется
  - `src/dashboard/server.js` (API):
    - `_handleTrends()`: новые фильтры `phase`, `minEmergence`, `minPlatforms`; новые sort варианты `rank` (default) и `emergence`; count query вычисляется правильно из тех же параметров
    - `_formatTrend()`: экспортирует `adoptionScore`, `emergenceScore`, `narrativePhase`, `rankScore`, `velocity`, `uniquePlatforms`
  - `src/dashboard/server.js` (UI):
    - Добавлены константы: `PHASE_META`, `PHASE_DOT`
    - Добавлены helper-функции: `barColor(v)`, `fmtVelocity(v)`
    - Новые компоненты: `ScoreBar`, `PhaseBadge`
    - `TrendCard` переработан: phase accent border, `PhaseBadge` в header, два бара (`🌊 Emergence` + `💊 Adoption`) вместо одного `MemeScore`, compact meta (платформы · velocity · timesSeen)
    - `TrendModal` stats: добавлена секция фазы с `PhaseBadge` + hint + два `ScoreBar`
    - App state: добавлен `phase` useState; default sort изменён на `'rank'`
    - Toolbar: добавлен select фазы (🔵🟡🟢🔴), сортировка обновлена (Rank, Adoption, Emergence, Новые, Виральность)
    - Sidebar: метка `Meme ≥ N` переименована в `Adoption ≥ N`
    - CSS: добавлены `.score-bar-*`, `.card-score-bars`, `.phase-badge`
- Проверка/деплой:
  - Ожидает деплоя владельцем (`deploy.sh` / `deploy.ps1`)
  - Новые поля заполняются `null`/`0` для исторических трендов (backward compat)
- Риски/заметки:
  - `narrativePhase` для старых трендов в DB будет `null` → phase filter вернёт 0 для старых записей, это ок
  - emergence gate в alert loop (`emergence < 30 && adoption < 60 → пропустить`) может первое время блокировать часть алертов, пока накопится история. Если слишком агрессивно — снизить порог emergence до 20 или убрать gate временно
  - `uniquePlatforms` в `_formatTrend` берётся из `raw_metrics` (сохраняется через clusterMetrics) — для старых трендов будет 1 (default), что корректно

---

## 2026-04-17 (EmergenceScore — breakout-based path для вирусных одиночных постов)

- Model/session: Claude Sonnet 4.6
- Цель: поддержать кейс "один пост но 1M+ views" без поломки spread-based логики
- Изменения (файлы):
  - `src/analysis/clusterer.js` — только этот файл:
    - `_computeEmergenceScore(m)` → `_computeEmergenceScore(m, items = [])` — добавлен второй аргумент
    - Внутри: spread-логика вынесена в `spreadScore` (без изменений)
    - Добавлен вызов `this._computeBreakoutScore(items)` → `breakoutScore`
    - Финал: `Math.min(Math.max(spreadScore, breakoutScore), 100)` — лучший из двух путей
    - Добавлен новый метод `_computeBreakoutScore(items)` (изолированный):
      - Компоненты: views/plays (0–35), likes/upvotes (0–30), retweets/shares (0–20), engagementRate (0–15)
      - Reddit upvotes подставляются как likes fallback; TikTok plays — как views fallback
    - `_computeMetrics()`: передаёт `items` → `_computeEmergenceScore(base, items)` (1 строка)
- Примеры поведения после патча:
  - 1 твит, 1.2M views, 45K likes, 8K RT, 4% ER → breakout=28+24+14+8=74; spread≈15 (только novelty) → emergenceScore=74 ✓
  - 5 постов, 2 платформы, velocity=1.2 → spread=16+18+8+10+7=59; breakout=низкий → emergenceScore=59 ✓
  - 1 пост Reddit, 60K upvotes, низкий ER → breakout=0+24+0+0=24; spread≈15 → emergenceScore=24 (сохраняем))
- Как удалить:
  - Удалить метод `_computeBreakoutScore`
  - Откатить `_computeEmergenceScore` сигнатуру к `(m)`, убрать breakoutScore + Math.max
  - Откатить вызов в `_computeMetrics` к `_computeEmergenceScore(base)`

---

## 2026-04-17 (early idea boost — Reddit + alert gate)

- Цель: не дропать ранние Reddit нарративы с высокими upvotes до того, как они попали на другие платформы
- Изменения (файлы):
  - `src/analysis/clusterer.js`:
    - Добавлен метод `_computeIdeaBoost(items)`: Reddit upvotes >= 10k → +5, >= 15k → +8, >= 30k → +10, >= 60k → +12; читает `m.upvotes || m.score`
    - `_computeEmergenceScore(m, items)` обновлён: `Math.min(Math.max(spread, breakout) + ideaBoost, 100)` — ideaBoost аддитивен, не заменяет spread/breakout
    - `_computeMetrics()` добавляет `isEarlyIdea` в `base`: `emergence 20–50 && upvotes >= 10k`; флаг для downstream-логики
  - `src/index.js`:
    - Alert gate: `emergence < 30` → `emergence < 20`; комментарий обновлён
- Проверка:
  - Syntax check clusterer.js через `node --input-type=module` eval → OK
- Риски/заметки:
  - ideaBoost максимум +12 → не делает Reddit доминирующим; одиночный пост 60k upvotes без spread даст emergence≈27 (novelty=15 + ideaBoost=12), что ровно выше нового gate=20
  - Для отключения: удалить `_computeIdeaBoost()` + строки `ideaBoost` в `_computeEmergenceScore` + `isEarlyIdea` в `_computeMetrics`
  - Alert gate 20→30 можно вернуть если уровень шума вырастет

---

## 2026-04-17 (follower-aware breakout dampening)

- Цель: убрать спам от постов крупных аккаунтов (Elon и т.п.), у которых всегда высокое абсолютное engagement
- Изменения (файлы):
  - `src/analysis/clusterer.js`:
    - `_computeBreakoutScore(items)`: теперь отслеживает `peakFollowers` — followers автора с пиковым количеством views/plays/likes; `maxEngagementRate` уже собирался
    - Добавлен метод `_normalizeBreakoutByFollowers(score, followers, engagementRate)`:
      - `followers < 100K` → no dampening (нет данных или маленький аккаунт)
      - `engagementRate >= 5%` → no dampening (genuinely viral regardless of size)
      - `engagementRate >= 2%` → × 0.85
      - `followers > 50M` → × 0.40 (e.g. Elon рутинный пост)
      - `followers > 10M` → × 0.55
      - `followers > 1M`  → × 0.72
      - иначе → × 1.0
    - Dampening применяется ТОЛЬКО к breakout component; spread и ideaBoost не затронуты
  - `src/analysis/prompts.js`:
    - Добавлено правило MEGA-ACCOUNT RULE в ━━━ ENGAGEMENT CONTEXT ━━━: модель должна оценивать контент нарратива, а не абсолютные метрики, если аккаунт крупный и engagement rate низкий
- Проверка:
  - Syntax check clusterer.js → OK
- Практический эффект (примеры):
  - Elon (90M fol.), 1M views, 30K likes, engRate=0.03% → factor=0.40; breakoutScore например 65 → 26 (не dominant)
  - Elon, тот же пост НО engRate=6% → factor=1.0 (реально вирусный контент, не дампим)
  - 500K аккаунт, 500K views, engRate=0.8% → factor=0.72
  - Мелкий аккаунт (50K fol.), 200K views → no dampening (followers < 100K)
- Как отключить: в `_computeBreakoutScore` заменить `return this._normalizeBreakoutByFollowers(raw, ...)` на `return raw;`

---

## 2026-04-17 (Market Stage Detection — опциональный изолированный слой)

- Model/session: Claude Sonnet 4.6
- Цель: детектировать признаки токенизации нарратива без угадывания тикера; изолированный feature flag слой
- Feature flag: `MARKET_STAGE_DETECTION=1` (env var). По умолчанию ВЫКЛЮЧЕНО.
- Изменения (файлы):
  - `src/analysis/market-stage.js` (NEW):
    - Все сигналы и логика в одном файле: `COIN_WORDS`, `INTENT_PHRASES`, `TRADING_DOMAINS`, `LATE_PHRASES`, `RE_PUMP_FUN_WITH_CA`, `RE_CA_WITH_CONTEXT`
    - `detectMarketSignals(items)` → signals object (hasCoinLanguage, hasLaunchIntent, hasCA, hasTradingLink, hasPumpFunLink, hasOverboughtLang, coinLangScore)
    - `resolveMarketStage(signals)` → `'none'|'tokenizing'|'live'|'overheated'`
    - `applyStage2MarketPatch(trend, stage2Result)` → опциональный upgrade/downgrade после x_search
    - `marketStageAlertLine(stage)` / `marketStagePromptHint(stage)` — текстовые хелперы
    - Нет зависимостей от остального проекта; нет ML; нет onchain-вызовов
  - `src/analysis/clusterer.js`:
    - Static import в начале файла (no side effects)
    - Constructor: `this._marketStageEnabled = process.env.MARKET_STAGE_DETECTION === '1'`
    - `route()`: опциональный блок `if (this._marketStageEnabled)` после `_computeMetrics()`, wrapped в try/catch; записывает `metrics.marketStage` и `metrics.marketSignals`
  - `src/analysis/prompts.js`:
    - `buildAnalysisPrompt()`: 3 строки, tagged `[MARKET_STAGE]`, добавляют hint-строку к описанию тренда если marketStage != 'none'
  - `src/analysis/scorer.js`:
    - Import `applyStage2MarketPatch` (tagged `[MARKET_STAGE]`)
    - `_analyzeBatchStage1`: `marketStage: trend.clusterMetrics?.marketStage ?? null` в возвращаемом объекте
    - `_stage2DeepDive`: `applyStage2MarketPatch(trend, result)` после пересчёта phase (1 строка, tagged)
    - `_applyHeuristic`, `_fallback`: `marketStage` прокидывается из clusterMetrics
  - `src/db/database.js`:
    - `saveTrend()`: `marketStage: trend.marketStage ?? null` в JSON (1 строка, tagged)
  - `src/dashboard/server.js`:
    - `_formatTrend()`: `marketStage: metrics.marketStage ?? null` (1 строка, tagged)
    - Новый компонент `MarketStageBadge({ stage })` с `MARKET_STAGE_UI` константами (tokenizing=amber, live=emerald, overheated=red)
    - `TrendCard`: `h(MarketStageBadge, { stage: trend.marketStage })` в header (1 строка, tagged)
    - `TrendModal`: секция `💹 Market Stage` с badge + hint (tagged block)
- Чтобы удалить feature полностью:
  1. Удалить `src/analysis/market-stage.js`
  2. Удалить строки, помеченные `[MARKET_STAGE]` в 6 файлах (~10 строк итого)
- Проверка/деплой:
  - Деплой: `deploy.sh` / `deploy.ps1`
  - Для включения: добавить `MARKET_STAGE_DETECTION=1` в `.env`
  - По умолчанию feature выключена — нулевой impact на production до включения
- Риски/заметки:
  - Ложные срабатывания на "token" / "coin" в бытовом контексте смягчены порогом coinLangScore >= 4 (для hasCoinLanguage) и >= 6 (для tokenizing без hasLaunchIntent)
  - CA detection требует контекстного якоря (ca:, contract:, address:, mint:, token:) — без него base58 не матчится
  - `marketSignals` объект сохраняется только в `clusterMetrics` (in-memory), в DB идёт только `marketStage` строка
  - Stage 2 patch (`applyStage2MarketPatch`) срабатывает только при `existingCoins.length > 0 && xBuzz in ['high','explosive']` или при rug-языке в adjustment — консервативно

---

## 2026-04-18 (план admin + UI планов)

- Цель: добавить план Admin с полным безлимитом; улучшить UI планов в админке
- Изменения:
  - `src/db/schema.sql`: добавлен план `admin` (price=0, все источники, alert_limit=-1, history_days=-1, api_access=1)
  - `src/db/database.js`: добавлен INSERT в normalizePlans транзакцию для плана `admin` с ON CONFLICT DO UPDATE
  - `src/admin/server.js`:
    - CSS: `.badge-admin` — красноватый (rgba 239,68,68)
    - Компонент `UnlimitedInput`: число + чекбокс ∞; value=-1 = безлимит; используется для `alert_limit` и `history_days`
    - Заголовок "История (дней)" → "Дней"
  - `src/i18n/ru.js`, `src/i18n/en.js`: в `paymentTitle` добавлено описание Free-плана (первым блоком, с пометкой "текущий")
- Проверка: `node --check` всех изменённых файлов → OK

---

## 2026-04-18 (взвешенный фидбек + только 👍👎)

- Цель: счётчик лайков/дизлайков, веса по плану, настройка в админке, только палец вверх/вниз
- Изменения:
  - `src/db/database.js`:
    - Новая таблица `feedback_votes` (trend_id, chat_id UNIQUE, vote, weight, plan_name) + индексы
    - `recordFeedback(trendId, chatId, vote, weight, planName)`: upsert/delete + пересчёт `trends.user_feedback` как ROUND(SUM(vote*weight))
    - `getFeedbackStats(trendId)` → `{ likes, dislikes, weightedScore }`
  - `src/notifications/telegram.js`:
    - LIKED = [👍], DISLIKED = [👎] — только эти два, все остальные игнорируются
    - `_feedbackWeight(chatId)` → `{ weight, planName }`: lookup плана пользователя, применяет веса из settings
    - Режим "выключено": Admin weight=1, все остальные weight=0
    - `recordFeedback` теперь принимает (trendId, chatId, vote, weight, planName)
  - `src/admin/server.js`:
    - Методы `_getFeedbackConfig()`, `_setFeedbackConfig()` — читают/пишут 5 settings-ключей
    - Endpoint `GET/POST /api/feedback-config`
    - State: `fbCfg`, `fbSaving`; `saveFbCfg()` async handler
    - UI-секция "👍 Взвешенный фидбек": toggle вкл/выкл + 4 карточки с весами (Admin/Pro/Test/Free)
    - Подсказка динамически меняется: при выключении показывает ⚠️ "учитываются только Admin"
- Проверка: `node --check` всех 3 файлов → OK
- Риски/заметки:
  - `message_reaction` update содержит `user.id` только для не-анонимных реакций; анонимные (group bots) пропускаются
  - Старые вызовы `recordFeedback(id, ±1)` больше не работают — сигнатура изменена; убедись что других caller'ов нет (grep показал только telegram.js)

---

## 2026-04-18 (junkPenalty filter)

- Цель: отсечь вирусный мусор (политика, K-pop, celebrity noise) без изменения emergence/adoption/rankScore
- Новый файл: `src/analysis/junk-filter.js`
  - `calculateJunkPenalty(items, clusterMetrics)` → `{ junkPenalty, junkReasons }`
  - Penalties (аддитивные): politics +40, kpop/fandom +30, celeb-noise +20, no-meme-shape +15
  - Safe-signal override: если есть животное / абсурд / мем-форма / heartwarming → raw / 3 (или /4 при ≥2 сигналах)
  - Cap 100
- Изменения:
  - `src/analysis/clusterer.js`: import `calculateJunkPenalty`; в `_computeMetrics` — вызов в try/catch, `base.junkPenalty` + `base.junkReasons`; помечено `[JUNK_FILTER]`
  - `src/index.js`: gate `junkPenalty >= 35 → continue` с debug-логом; помечено `[JUNK_FILTER]`
  - `src/db/database.js`: `junkPenalty` и `junkReasons` сохраняются в `raw_metrics`
  - `src/dashboard/server.js`: `_formatTrend` возвращает `junkPenalty` и `junkReasons`
- Проверка: `node --check` всех изменённых файлов + eval clusterer.js → OK
- Как отключить: удалить import + `[JUNK_FILTER]` блок в clusterer.js + gate в index.js
- Порог 35 означает: одно сильное совпадение (politics/kpop) или два слабых (celeb + no-meme-shape) → drop
- Safe override предотвращает false positives: "weird bear crashes government meeting" = politics +40, animal → /3 = 13 → проходит

---

## 2026-04-18 (Twitter preview fix — /i/status/ path)

- Цель: починить отсутствие картинок для Twitter-трендов в дашборде
- Причина: `_handlePreview` вызывал `api.fxtwitter.com/{user}/status/{id}`, но `author` в коллекторе часто падал в `'unknown'` → URL вида `twitter.com/unknown/status/123` → fxtwitter API возвращал 404
- Изменения:
  - `src/dashboard/server.js` — `_handlePreview()`:
    - Twitter URL → теперь использует `api.fxtwitter.com/i/status/{tweetId}` (путь `/i/` не требует юзернейма, работает по ID твита)
    - Добавлены `info`-логи: `[Preview] tweet {id} → has image / no media / error` для диагностики
  - `src/collectors/twitter.js`:
    - `author` fallback расширен: добавлен `tweet.author?.username` (lowercase) — некоторые версии Apify актора используют нижний регистр
- Проверка: `node --check` обоих файлов → OK
- Риски/заметки:
  - Большинство вирусных твитов — текстовые, без медиа → X-иконка-плейсхолдер остаётся нормальным поведением
  - Логи позволяют понять: `no media` = твит без фото/видео (ок); `error` = сетевая проблема с fxtwitter

---

## 2026-04-18 (feedback кнопки 👍👎 на алерт-карточках)

- Цель: добавить инлайн-кнопки 👍/👎 к каждому алерту — дублируют реакции, но работают как кнопки прямо в сообщении
- Изменения:
  - `src/db/database.js`:
    - Новый метод `getUserVote(trendId, chatId)` → `+1`, `-1`, или `null` (нет голоса); нужен для тоггла
  - `src/notifications/telegram.js`:
    - Переименован метод `attachXButton` → `attachAlertButtons` (старое имя сохранено как alias для обратной совместимости)
    - `attachAlertButtons` формирует клавиатуру из 2 рядов: `[🔍 X Analysis]` + `[👍] [👎]`
    - В `_setupCallbacks`: добавлен обработчик `feedback:{vote}:{trendId}`:
      - Проверяет prevVote через `db.getUserVote` — повторное нажатие той же кнопки удаляет голос (toggle-off)
      - Вызывает `_feedbackWeight` + `db.recordFeedback` — та же логика, что и у реакций
      - `answerCallbackQuery` с текстом: 👍 Лайк засчитан / 👎 Дизлайк засчитан / ❌ Оценка удалена
- Проверка: `node --check` обоих файлов → OK
- Поведение:
  - Кнопки и реакции используют единую таблицу `feedback_votes` → один пользователь = один голос (кнопки перезаписывают реакции и наоборот)
  - Веса по планам работают одинаково для обоих механизмов
  - Callback_data: `feedback:1:{id}` (лайк), `feedback:-1:{id}` (дизлайк)

---

## 2026-04-18 (Вариант A — Adoption-first, убрать emergence из gate)

- Цель: вернуть качество нарративов после того как Emergence+Adoption система начала давать скучные результаты
- Диагностика:
  - Emergence измеряет "спред нарратива по платформам" — но для мемкоинов нужен РАННИЙ контент, который ещё не распространился → метрика инвертирована относительно цели
  - Мёртвая зона: emergence 15–19 → `_decide` падал в `save_only` (нет ветки) → контент не шёл в AI вообще
  - Alert gate `emergence < 20 && adoption < 60` вырезал одиночный вирусный твит с adoption=55 → молчание
  - RankScore 0.40×emergence + 0.60×adoption занижал свежий контент (низкий emergence = ещё не распространился = ценность)
- Изменения (3 файла):
  - `src/index.js`: убран emergence gate целиком; единственный критерий алерта — `memePotential >= effectiveMemeThreshold`
  - `src/analysis/clusterer.js` — `_decide()`: fallback `return 'save_only'` → `return 'stage1'`; теперь всё что не drop и не save_only → идёт в AI
  - `src/analysis/scorer.js` — `narrativeRankScore()`: веса 0.40/0.60 → 0.15/0.85; adoption доминирует в сортировке
- Что осталось без изменений:
  - Emergence/Adoption как UI-метрики на дашборде — остаются, информативны визуально
  - JunkPenalty gate (35) — остаётся, отсекает политику/kpop
  - `effectiveMemeThreshold` пользователя — остаётся, управляет порогом алертов
  - DROP условие в clusterer — остаётся (убирает реальный стейл-спам)
  - SAVE_ONLY для очень слабого emergence + нулевой engagement — остаётся
- Проверка: `node --check` всех 3 файлов → OK
- Риски/заметки:
  - Количество алертов может вырасти — если слишком шумно, снизить порог `effectiveMemeThreshold` или повысить junkPenalty threshold с 35 до 45
  - Если всё ещё плохо — следующий шаг: поднять порог `SAVE_EMERGENCE_MAX` с 15 до 0 (чтобы ещё больше контента шло в AI)

---

## 2026-04-18 (пороги алертов + кастомный ввод)

- Цель: обновить пресеты порогов (52/67/75), добавить кнопку своего числа, добавить рекомендацию 75+
- Изменения:
  - `src/i18n/ru.js` и `src/i18n/en.js`:
    - `thresholdLow`: 40+ → 52+
    - `thresholdMedium`: 60+ → 67+
    - `thresholdHigh`: 80+ → 75+
    - `thresholdTitle`: добавлена строка "⭐ Рекомендуется: 75+" (на обоих языках)
    - Новые ключи: `thresholdCustomBtn`, `thresholdCustomPrompt`, `thresholdCustomInvalid`
  - `src/notifications/telegram.js`:
    - `_thresholdKeyboard`: обновлены callback_data (52/67/75), добавлена кнопка `threshold_custom`
    - `this._awaitingInput`: новый Map в конструкторе для хранения состояния ввода
    - Обработчик `threshold_custom` в `_setupCallbacks`: устанавливает состояние, отправляет запрос числа
    - `bot.on('message')` в `_setupCommands`: проверяет `_awaitingInput`, парсит число, валидирует 1–100, сохраняет и показывает подтверждение
- Проверка: `node --check` всех 3 файлов → OK
- Риски/заметки:
  - `_awaitingInput` хранится в памяти → при перезапуске контейнера ожидание сбрасывается (ок, пользователь просто нажмёт кнопку снова)
  - Любое текстовое сообщение пользователя пока активен state заменяет его порог — команды (`/start`, `/menu`) начинаются с `/` и пропускаются

---

## 2026-04-18 (Telegram Stars оплата)

- Цель: добавить оплату через Telegram Stars (⭐) — нативный способ без внешних провайдеров
- Как работает:
  - `sendInvoice` с `currency: 'XTR'` и `provider_token: ''` (пустой — Stars не требует провайдера)
  - Telegram сам показывает UI баланса и подтверждения
  - `pre_checkout_query` → бот отвечает в течение 10 сек → `answerPreCheckoutQuery(id, true)`
  - `successful_payment` → приходит как обычное сообщение с `msg.successful_payment`
  - Подтверждение мгновенное — никакого ожидания blockchain
- Изменения:
  - `src/config.js`:
    - `config.telegram.starsTestPrice` (default 250 XTR ≈ $5, env `STARS_TEST_PRICE`)
    - `config.telegram.starsProPrice`  (default 5000 XTR ≈ $100, env `STARS_PRO_PRICE`)
  - `src/i18n/ru.js` и `src/i18n/en.js`:
    - `btnPayStars(amount)`: кнопка "⭐ Telegram Stars (250 ⭐)"
    - `starsInvoiceTitle(plan)`: заголовок инвойса
    - `starsInvoiceDesc(plan)`: описание инвойса
  - `src/notifications/telegram.js`:
    - `allowed_updates`: добавлен `'pre_checkout_query'`
    - `_paymentMethodKeyboard`: Stars стоит первой кнопкой (наиболее удобный способ)
    - `pay:plan:STARS` callback → `_handleStarsPayment()` (не ждёт ответа колбэка — сначала answerCallbackQuery)
    - `_handleStarsPayment(chatId, messageId, user, planName, t)`:
      - Создаёт `payments` запись со status=pending, currency='STARS'
      - Вызывает `bot.sendInvoice()` с пустым provider_token и currency='XTR'
    - `_setupStarsPayments()`:
      - `pre_checkout_query` → мгновенный approve
      - `message` с `successful_payment` → lookup pending payment → `confirmPaymentAndUpgrade(reference, chargeId, durationDays)` → отправляет подтверждение с главным меню
- Проверка: `node --check` всех 4 файлов → OK
- Настройка:
  - Никаких дополнительных ключей не нужно (Stars работает с любым Telegram ботом)
  - Цены можно менять через `STARS_TEST_PRICE` и `STARS_PRO_PRICE` в `.env`
  - Для вывода Stars → TON: через BotFather → Payments → Stars balance
- Риски/заметки:
  - Дублированный `bot.on('message')` — не конфликтует с threshold-input хендлером (у каждого свой guard: `!msg.successful_payment` и `!state`)
  - Если `confirmPaymentAndUpgrade` вернул null (уже подтверждён или истёк) → тихо логируем, не шлём повторное сообщение пользователю

---

## 2026-04-18 (/top — селектор количества + красивый вывод)

- Цель: сделать /top читаемым, добавить выбор количества трендов
- Изменения:
  - `src/i18n/ru.js` и `src/i18n/en.js`:
    - `topSelectorTitle`: заголовок экрана выбора
    - `topBtnCount(n)`: текст кнопки (📊 ТОП-N)
    - `topTitle(n)`: теперь функция с количеством, не строка
    - `topCatIcons`: объект {category → emoji} для компактного отображения категории
    - `topLifeIcons`: объект {lifespan → emoji} для компактного отображения длительности
    - Удалено: `topPotential` (больше не нужен — score показывается как бар)
  - `src/notifications/telegram.js`:
    - `/top` команда → теперь показывает селектор количества (`topSelectorTitle` + `_topSelectorKeyboard`)
    - `data === 'top'` callback → переключается на показ селектора (editMessage)
    - `data.startsWith('top:')` callback → вызывает `_handleTopCommand(chatId, user, limit)`
    - `_topSelectorKeyboard(t)`: 2×2 кнопки (3/5/10/20) + Back
    - `_handleTopCommand(chatId, user, limit = 5)`: полностью переписан
      - Каждый тренд: горизонтальный разделитель + жирный заголовок + score bar (блоки ██████░░░░ N) + catIcon + lifeIcon
      - `whyItWillPump` — дежен-питч курсивом, если есть
      - Ссылки: 🔗 Открыть · 📢 TG (через `·` на одной строке)
- Проверка: `node --check` всех 3 файлов → OK
- Пример вывода карточки:
  ```
  ────────────────────
  1. Funny Cat Falls Off Chair
  ██████████ 92  🐾  ⚡
  💡 $CAT launches in 3h — Elon just liked it
  🔗 Открыть  ·  📢 TG
  ```

---

## 2026-04-18 (pipeline_status + повторный анализ save_only трендов)

- Цель: реализовать повторный анализ постов, которые ранее были сохранены как `save_only` (clusterer не отправил их в AI), на случай если порог фильтров изменился или пост набрал вес со временем
- Диагностика:
  - `isTrendSeen` проверял DB без временного окна — любой пост в таблице `trends` (даже с score=0) блокировался навсегда
  - `save_only` тренды сохранялись без AI-анализа, но попадали в `isTrendSeen=true` → никогда не пересматривались
  - Особенно важно после смены логики фильтров (убран emergence gate, изменены веса rankScore)
- Изменения:
  - `src/db/database.js`:
    - Новый столбец `pipeline_status TEXT NOT NULL DEFAULT 'save_only'` — добавляется миграцией `addIfMissing('trends', 'pipeline_status', ...)`
    - `isTrendSeen()`: теперь учитывает `pipeline_status`:
      - `scored` → блокируется навсегда (AI уже проанализировал, нет смысла повторять)
      - `save_only` → **не блокируется никогда** — проходит на clusterer каждый скан со свежими метриками из коллектора; если engagement вырос → clusterer переводит в `stage1`; коллектор сам является фильтром свежести (если пост выпал из ленты — он не придёт)
    - `saveTrend()`: UPSERT-логика — если тренд уже есть в DB по `external_id` или `url`, делает UPDATE (score, category, ai_explanation, pipeline_status, last_seen_at, times_seen) вместо дублирующего INSERT; принимает `trend.pipelineStatus`
  - `src/index.js`:
    - AI-проанализированные тренды сохраняются с `pipelineStatus: 'scored'`
    - `save_only` тренды остаются с дефолтным `'save_only'`
- Проверка: `node --check src/db/database.js src/index.js` → OK
- Поведение:
  - Пост появился → clusterer: `save_only` → сохранён в DB с `pipeline_status='save_only'`
  - Каждый следующий скан пока пост виден в ленте: `isTrendSeen=false` → clusterer видит свежие метрики → `save_only` снова (UPSERT обновляет metrics/times_seen) или `stage1` (engagement вырос)
  - Если `stage1` → AI анализирует → UPSERT с `pipeline_status='scored'`
  - Пост с `scored`: `isTrendSeen=true` навсегда → больше не входит в pipeline
  - Пост выпал из ленты → коллектор его не вернёт → никакой обработки
- Риски/заметки:
  - `save_only` тренды проходят через clusterer каждый скан — это дёшево (только Jaccard + метрики, без AI)
  - Если clusterer снова вернёт `save_only` → `saveTrend` UPSERT обновит `times_seen` и метрики — никакого дублирования, AI не вызывается
  - Исторические записи в DB (до деплоя) с `pipeline_status='save_only'` — если пост всё ещё появляется в ленте, получит шанс на re-analysis. Желательное поведение.

---

## 2026-04-18 (Dashboard/Admin UI — dark ops style + intelligence rail)

- Model/session: Claude Sonnet 4.6
- Цель: переработать визуал дашборда и админки в более тёмный "ops / terminal / memecoin tool" стиль
- Изменения:
  - `src/dashboard/server.js`:
    - Тёмная тема усилена: более тёмный фон, terminal-шрифты, акцентный неон
    - Верхняя полоса источников всегда показывает все core-источники (Reddit, Google, Twitter, TikTok), даже если count=0
    - Кнопка `⚡` (обзор/stats) стала рабочей — переключает в overview-режим со статистикой
    - Добавлен правый Intelligence Rail: `Session Pulse`, `Hot Now`, `Sources`, `Category Focus`
    - На узких экранах rail использует internal scroll, чтобы не обрезаться
    - Временные объяснительные копии (пояснения к UI) добавлены и затем удалены после ревью
  - `src/admin/server.js`:
    - Синхронные правки стиля под общую dark ops тему
  - Бэкап перед изменениями:
    - `.codex-backups/dashboard.server.before-2026-04-18.js`
    - `.codex-backups/admin.server.before-2026-04-18.js`
- Проверка/деплой: деплой выполнен через `deploy.ps1`
- Риски/заметки:
  - Быстрый откат: скопировать файл из `.codex-backups/` поверх `src/dashboard/server.js` или `src/admin/server.js`

---

## 2026-04-18 (sed truncation → reconstruct dashboard + admin)

- Model/session: Claude Sonnet 4.6
- Цель: восстановить dashboard/server.js и admin/server.js после truncation от `sed -i` (закончилось место на диске под tmp-файл)
- Причина:
  - `sed -i` при глобальном ренейме создаёт временный файл; при нехватке места файл обрезается
  - `dashboard/server.js` — обрезан на строке 2422 (пропало ~370 строк): хвост `SignalRail`, компонент `App`, `ReactDOM.render`, закрывающий HTML
  - `admin/server.js` — обрезан на строке 1713 (оборван посреди строки template literal)
- Восстановление:
  - `dashboard/server.js`: реконструированы по памяти/контексту: хвост `SignalRail` (Hot Now, Sources, Category Focus секции), полный `App` компонент, ReactDOM render, закрывающий HTML
  - `admin/server.js`: строки 1–1712 из текущего файла + хвост взят из `.codex-backups/admin.server.before-2026-04-18.js` (с применением TrendScout→Catalyst замены)
  - `node --check` для обоих файлов → OK
- Ошибки в процессе:
  - Heredoc `\`` в shell создаёт литеральный `\`` вместо закрывающего backtick template literal → Python replace как обходной путь
  - `LIMIT` не был объявлен в реконструированном файле → `ReferenceError` → белый экран

---

## 2026-04-18 (deploy fix — legacy trendscout container + docker cache)

- Model/session: Claude Sonnet 4.6
- Цель: исправить деплой-ошибки после ренейма
- Проблемы и решения:
  1. **Port 8080 already allocated**: старый контейнер `trendscout-app` остался после ренейма в `catalyst-app`
     - Фикс: добавлен явный `docker stop/rm trendscout-app` и `docker stop/rm trendscout` в `setup_remote.sh` перед `$DC down`
  2. **Docker build cache**: все слои кешировались → новый код не попадал в образ
     - Временно добавлен `$DC build --no-cache` в `setup_remote.sh`
     - После устранения проблемы — возвращён обычный `$DC build` для скорости деплоя
- Итог: деплой стабилен, кеш-проблема решена перестройкой без кеша

---

## 2026-04-18 (dashboard white screen — LIMIT + api() double .json())

- Model/session: Claude Sonnet 4.6
- Цель: устранить белый экран дашборда после реконструкции server.js
- Причины (найдено последовательно):
  1. `const LIMIT = 20` отсутствовал в реконструированном файле → `ReferenceError` при первом рендере → React unmount → белый экран
     - Фикс: добавлен `const LIMIT = 20;` после константы `CAT_CLS`
  2. `fetchData` использовал голый `fetch('/api/...')` вместо `api()` хелпера → запросы без `X-API-Key` → 401
     - Фикс: заменены все три вызова на `api('/trends?...')`, `api('/stats?...')`, `api('/sources')`
  3. `api()` хелпер уже делает `.then(r => r.json())` внутри → вызов `.then(r => r.json())` поверх результата → `r.json is not a function`
     - Фикс: убраны дублирующие `.then(r => r.json())` из `fetchData`
- `node --check` → OK; финальная правка задеплоена
- Оставшиеся проблемы починены владельцем в отдельной сессии

---

## TEMPLATE (копировать для новых записей)

### YYYY-MM-DD HH:MM

- Model/session:
- Цель:
- Изменения (файлы):
- Проверка/деплой:
- Риски/заметки:

---

## 2026-04-18 (thumbnail/preview fix для видео-источников)

- Цель: убрать пустые картинки в дашборде для Twitter и TikTok трендов
- Проблема: коллекторы не сохраняли медиа-превью, `_handlePreview` не мог получить og:image с Twitter (блокирует ботов) и TikTok
- Изменения:
  - `src/collectors/tiktok.js`: извлекается `thumbnailUrl` из `video.originCoverUrl || covers[0] || cover || dynamicCover || shareCover[0]`; добавляется в metrics
  - `src/collectors/twitter.js`: извлекается `thumbnailUrl` из `tweet.media[0].preview_image_url` (видео-превью) или `.url` / `.media_url_https` (фото); добавляется в metrics
  - `src/dashboard/server.js` — `_handlePreview()`:
    - Twitter/X URL → переписывается на `fxtwitter.com` (прокси, отдаёт og:image для видео и фото)
    - TikTok URL с `/video/{id}` → запрос к `tiktok.com/oembed` (JSON, поле `thumbnail_url`)
    - Остальные URL → прежняя логика (fetch + regex og:image)
  - `_formatTrend` уже содержал `metrics.imageUrl || metrics.thumbnailUrl || metrics.thumbnail` — новое поле подхватывается автоматически
- Проверка: `node --check` всех 3 файлов → OK
- Порядок приоритетов для картинки тренда:
  1. `metrics.imageUrl` (Reddit thumbnail, прямой URL)
  2. `metrics.thumbnailUrl` (TikTok cover, Twitter media preview) — новое
  3. `metrics.thumbnail` (legacy)
  4. `/api/preview?url=` → fxtwitter/oembed/og:image fallback
- Риски/заметки:
  - fxtwitter.com — публичный сервис, может быть недоступен; при ошибке тихо возвращает null
  - TikTok oEmbed работает без авторизации, но может измениться
  - Старые записи в БД без thumbnailUrl будут использовать /api/preview fallback как раньше

---

## 2026-04-18 (глобальный ребрендинг TrendScout → Catalyst)

- Цель: переименовать проект в Catalyst — единое название вместо TrendScout / Narrative Parser
- Scope: 27 файлов (все .js, .json, .md, .sql, .sh, .ps1, .yml, .bat, .example + Dockerfile без расширения)
- Изменения:
  - `TrendScout` → `Catalyst` (заглавные буквы — user-facing строки)
  - `trendscout` → `catalyst` (строчные — docker, paths, package name, container names)
  - Конкретные замены:
    - `package.json`: `"name": "catalyst"`
    - `docker-compose.yml`: сервис `catalyst`, контейнер `catalyst-app`, volumes `catalyst_data`/`catalyst_logs`, сеть `catalyst`, label `app=catalyst`
    - `Dockerfile`: LABEL maintainer, `DB_PATH=/data/catalyst.db`, `LOG_FILE=/logs/catalyst.log`
    - `deploy.ps1` / `deploy.sh` / `setup_remote.sh`: `RemoteDir=/opt/catalyst`, temp archives `catalyst.zip/env`, PM2 `pm2 delete catalyst`
    - `src/db/schema.sql`: комментарий заголовка
    - `src/i18n/en.js`, `src/i18n/ru.js`: `Welcome to Catalyst!`, invoice titles, invoice descriptions
    - `src/index.js`: startup log `🔥 Catalyst v3.0 — Starting up...`
    - `src/config.js`, `src/dashboard/server.js`, `src/admin/server.js`, `src/billing/solana-pay.js`: все упоминания в комментариях/логах
    - `ai-context/SESSION_CONTEXT.md`: `Название: Catalyst`
    - `scripts/`: status.sh, logs.sh, backup.sh, test-payment.js
    - Прочие: DEPLOYMENT_SUMMARY.txt, .env.example, start.bat, shilling.md, insert_test_plan.sh
  - `.codex-backups/` — не обновлялись (исторические снимки, не активный код)
- Проверка:
  - `node --check` для всех .js файлов → OK
  - `grep -r "TrendScout|trendscout"` по проекту (без node_modules, .codex-backups) → 0 вхождений

---


## 2026-04-18 - Dashboard hero/stats redesign pass

### Context
- The previous dashboard restyle was too subtle visually after deploy, even though CSS had changed.
- Kept the restored working Catalyst dashboard baseline to avoid losing buttons and actions again.

### Completed
- Added a new visible hero section to the dashboard shell in `src/dashboard/server.js`.
- Added a dedicated `Stats overview` screen and wired the `����������` control button to open it.
- Restored fixed top source stat cards for `reddit`, `google_trends`, `twitter`, and `tiktok`, including zero-count rendering.
- Wrapped key dashboard blocks in stronger section shells to make the redesign visually obvious.
- Saved a rollback snapshot before this redesign step: `.codex-backups/dashboard.server.before-hero-stats-redesign-2026-04-18.js`.

### Verification
- `node --check src/dashboard/server.js` passed after the redesign changes.

---

## 2026-04-20 (dashboard UX overhaul — themes, modal settings, layout, column resize)

- Model/session: Claude Sonnet 4.6
- Цель: серия UX-улучшений дашборда — темы, навигация, компоновка, модальные настройки
- Изменения (`src/dashboard/server.js` — единый inline React SPA):
  - **Theme system (7 тем, всё dark)**:
    - `:root` заменён на 7 палитр через `body[data-theme="..."]`: Midnight, Teal (Бирюза), Abyss (Бездна), Violet (Фиолет), Acid (Кислота), Sunset, Cyberpunk
    - Каждая тема определяет `--bg`, `--surface`, `--card*`, `--border*`, `--text*`, `--accent`, `--accent-rgb`, `--accent-glow`, семантические цвета с `-rgb` вариантами
    - `THEME_KEY='ts_theme'`, `setTheme()`, `useTheme()` хук, `SUPPORTED_THEMES` массив, `THEME_META` (icon + EN/RU labels)
    - Sweep hardcoded rgba(98,114,255,α) → rgba(var(--accent-rgb), α) в 58+ местах (через node-скрипт)
  - **Навигация переработана**:
    - `BottomNav`: оставлены Feed + Stats (Settings перенесены наверх)
    - Top-right: убраны Live/clock; добавлены Account button (с аватаркой + `@username`) + ⚙️ Settings gear
    - `.nav-subtitle` центрирован абсолютно (`position:absolute; left:50%; transform:translate(-50%,-50%)`)
    - Phase filter chips (All / Early / Forming / Strong / Saturated) перенесены из тулбара в sidebar (2×2 grid + full-width "All")
    - Логотип 🔥 → 🐱
  - **Modal sheets** (центрированные окна с блюром фона):
    - Новый компонент `Sheet({ title, icon, onClose, children })`: Esc-handler, backdrop-click close, body scroll lock
    - CSS: `.sheet-overlay` с `backdrop-filter: blur(14px) saturate(1.1)` + `rgba(4,6,14,.55)`; `.sheet` — 760px max, градиент surface→bg, анимации `sheetIn` + `sheetPop`
    - App layout: `dashboard-grid` (лента) теперь всегда рендерится, а Settings/Account/Stats открываются поверх как модальные оверлеи (классический 2-col layout удалён)
    - `.settings-header` внутри `.sheet-body` скрыт — модалка сама рисует шапку
  - **AccountPanel** (выделен из SettingsPanel):
    - Hero card с аватаром, ID, planBadge, status pill
    - Подписка (subExpiry) — если есть
    - Threshold (read-only)
    - Logout button
    - `Row` и `Toggle` экстрактованы на module-scope (был bug: `ReferenceError: Row is not defined` → чёрный экран при клике на Account)
  - **Column resizers** (draggable dividers):
    - CSS Grid: `grid-template-columns: var(--col-left) 6px 1fr 6px var(--col-right)`
    - Компонент `ColumnResizer`: прямой DOM update (`documentElement.style.setProperty('--col-left', ...)`) для 60fps drag, persist в `ts_prefs_v1` на release, double-click reset
    - Limits: left 180–540px, right 240–630px (увеличено с изначальных 360/420)
  - **Refresh animation**: `refreshPulse` state + `MIN_PULSE_MS=650` (раньше анимация заканчивалась за ~200мс когда fetchData быстрый); determinate scaleX + opacity fade
- **Telegram avatar integration** (новая фича):
  - `src/db/database.js`:
    - Миграция `users`: колонки `avatar_file_id`, `avatar_file_unique_id`, `avatar_checked_at` (через PRAGMA-guarded `ALTER TABLE`)
    - Метод `setUserAvatar(userId, fileId, fileUniqueId)`
  - `src/notifications/telegram.js`:
    - `refreshUserAvatar(chatId, userId, {force})`: тянет `bot.getUserProfilePhotos(...)`, берёт max size, пишет в БД; throttle 6ч; тихо падает при privacy-lock
    - `getFileUrl(fileId)`: резолвит `bot.getFile(...)` → `https://api.telegram.org/file/bot<TOKEN>/<path>` (токен остаётся на сервере, не утекает клиенту)
    - Hook в `/start` — фоновый (fire-and-forget) refresh на любом логине, включая deep-link `auth_<sessionId>`
  - `src/dashboard/server.js`:
    - Новый endpoint `GET /api/auth/avatar` — прокси: читает `users.avatar_file_id` текущего юзера, кэширует на диск в `data/avatars/<fileUniqueId>.jpg`, отдаёт `image/jpeg` с `Cache-Control: private, max-age=604800, immutable`
    - На cache miss: `getFileUrl` → `fetch` CDN → запись в кэш + response (buffer-based для маленьких файлов < 200KB)
    - `_handleAuthMe` дёргает `refreshUserAvatar` фоновым вызовом (throttled, не спамит)
    - `_publicUser` отдаёт `hasAvatar`, `avatarKey` (= fileUniqueId, стабильный ключ для cache-bust)
    - UI: `AccountPanel` avatar-big и top-right `nav-account-avatar` рендерят `<img src="/api/auth/avatar?token=...&k=<avatarKey>">` если `hasAvatar`, иначе буква username / 👤; `onError` → fallback
    - CSS: `.account-avatar-big`, `.nav-account-avatar` получили `overflow:hidden` + вложенный `img { object-fit:cover }`
  - `.gitignore`: добавлен `data/avatars/`
- Проверка: `node --check` на `database.js`, `telegram.js`, `server.js` → OK
- Риски/заметки:
  - Avatar URL с токеном бота НЕ отдаётся клиенту (прокси через свой сервер). CDN-ссылки от Telegram живут ~1ч, поэтому обязательно кэшировать и не хранить эти URL долго
  - Если у юзера privacy "фото видят только контакты" — `photos.total_count === 0` → записываем null, ре-чек не чаще чем раз в 6ч (avoid API spam)
  - `fileUniqueId` стабилен per-photo: при смене юзером фото в TG → следующий `getUserProfilePhotos` вернёт новый unique id → `avatarKey` в `/me` ответе меняется → браузер перекачивает картинку (HTTP cache busting через query-параметр)
  - Существующие юзеры не получат аватарку пока не пингнут `/start` в боте (или не пройдёт 6ч и дашборд сам триггернёт re-check через `/api/auth/me`)
  - better-sqlite3 bindings требуют recompile под текущий node (`v22.22.2`) — в диагностических скриптах пришлось fallback'ить на sqlite3 CLI

## 2026-04-20 (media pipeline overhaul + UX polish + feedback-driven rank)

- Model/session: Claude Sonnet 4.6 + Opus 4.7
- Цель: сделать медиа в алертах и дашборде живыми (видео+звук), отполировать UX, добавить двухступенчатый product value — «Why now» триггер и персонализация ленты
- Изменения (`src/notifications/telegram.js`, `src/notifications/formatter.js`, `src/dashboard/server.js`, `src/collectors/reddit.js`, `src/collectors/twitter.js`, `src/analysis/clusterer.js`, `src/analysis/scorer.js`, `src/analysis/prompts.js`, `src/db/database.js`, `src/db/schema.sql`, `src/index.js`, `Dockerfile`):
  - **Multi-image Telegram alerts**: `sendMediaGroup` для карусели до 10 изображений; fallback на `sendPhoto` если 1 элемент; в алерте — длинный caption только на первой картинке (TG лимит 1024 char)
  - **Telegram avatar auto-replace**: при изменении `file_unique_id` старый файл в `data/avatars/<old>.jpg` удаляется (path-traversal guard); реализовано в `_deleteAvatarFile()` внутри `refreshUserAvatar`
  - **Видео в алертах вместо первого кадра**:
    - Reddit collector: `_bestVideo(post)` — `reddit_video.fallback_url` → `preview.reddit_video_preview` → direct `.mp4/.webm` → imgur `.gifv → .mp4`
    - Twitter collector: достаёт best-bitrate MP4 из `video_info.variants`
    - Clusterer: агрегирует `videoUrl` на представителя кластера если его ещё нет
    - Telegram: `sendVideo` с `supports_streaming: true`; multi-tier fallback — video → mediaGroup → photo → text
  - **Reddit DASH/CMAF audio muxing** (раньше выдавался silent stream):
    - `_findRedditAudioUrl(videoUrl)`: HEAD-probe кандидатов — **CMAF_AUDIO_128.mp4 → CMAF_AUDIO_64.mp4 → CMAF_audio.mp4 → DASH_AUDIO_128.mp4 → DASH_AUDIO_64.mp4 → DASH_audio.mp4 → audio**
    - `_muxRedditVideo(videoUrl)`: `ffmpeg -c copy -movflags +faststart` → кэш в `data/video-cache/<id>.mp4`; stream-copy, никакого reencode
    - `cleanupVideoCache(maxAgeDays=7)` вызывается из `index.js` на старте
    - Reddit в 2025 переехал с `DASH_*` на `CMAF_*` в video segment names — оба формата поддерживаются для совместимости
    - Лог-уровень: `no audio track` = warn (было debug, не видно в проде); при неудаче — перечисление попытанных URL со статусами
  - **Dockerfile**: в runtime-stage (Alpine) добавлен `ffmpeg` через `apk add --no-cache`; без него mux молча не работал и контейнер отдавал silent stream
  - **Dashboard video player** (вместо статичного первого кадра):
    - `FeedImage`: при наличии `trend.videoUrl` рендерит HTML5 `<video controls preload="none" poster={imgUrl}>`; `onClick` на wrap-элементе — `stopPropagation` чтобы play не открывал модалку
    - `TrendModal`: аналогично в modal-body
    - Публичный route (до auth middleware) `GET /api/video/reddit/<id>.mp4?src=<encoded v.redd.it url>`:
      - Regex-валидация `src`: должен быть `v.redd.it/<alphanumeric>/` (не общий proxy)
      - Cache-first: если `data/video-cache/<id>.mp4` есть — отдаём с Range support (206 Partial Content)
      - Cache miss: `_muxRedditVideo` → если успех, отдаём; если нет аудио — 302 на оригинал
      - `<video>` элементы не могут слать `Authorization: Bearer`, поэтому этот маршрут единственный public (контент и так паблик с Reddit)
  - **Video volume persistence** across videos: `videoVolumeRef` ref-callback, читает/пишет `catalyst_video_volume` + `catalyst_video_muted` в localStorage; `addEventListener('volumechange')`; подключён и в FeedImage, и в TrendModal
  - **Dashboard UX polish**:
    - Убрана секция «Source Pulse» из правой колонки — дублировала сайдбар; удалены `sources`, `allSourceStats`, `hiddenSources`, `onToggleSource` props
    - Top Narratives: 5 → 10 (и SQL LIMIT, и client .slice)
    - Замена пагинации на **infinite scroll**: `IntersectionObserver` + `sentinelRef` в конце ленты; `loadingMore` state; SSE-стабильность через `refreshAllRef` (иначе reconnect на каждой смене offset)
    - Убран 📋 copy-title button у карточек (бесполезный)
- **Feature 1 — «Why now» (триггер события)**:
  - `src/db/database.js`: миграция `trends.why_now TEXT NOT NULL DEFAULT ''` через `addIfMissing`; INSERT/UPDATE в `saveTrend` пишут `trend.whyNow`
  - `src/analysis/prompts.js`: новое поле `"whyNow"` в stage-1 JSON schema с строгой инструкцией — «fill only when data clearly points to a real triggering event; no speculation, no title restatement; empty string otherwise»
  - `src/analysis/scorer.js`: `whyNow: (a.whyNow || '').trim().slice(0, 280)` в результате batch
  - Dashboard: `_formatTrend` отдаёт `whyNow` → TrendModal рендерит `🔥 Trigger / Триггер` секцию с красно-оранжевым акцентом (`.modal-section-content.why-now`), только если не пустая строка
  - Telegram alert (`formatter.js`): над AI-explanation выводится `🔥 <b>{whyNow}</b>` при непустом значении
  - Стоимость: +20-40 токенов на ответ — на текущих объёмах <$0.50/месяц
- **Feature 2 — Персонализированный ранг**:
  - `src/db/database.js`:
    - `users.personalization_enabled INTEGER NOT NULL DEFAULT 1` — миграция
    - `getCategoryPreferences(chatId, days=30)` — JOIN `feedback_votes` × `trends`, GROUP BY category, SUM(vote × weight), возвращает `{ category: net }` map
    - `getPersonalizationEnabled(chatId)` / `setPersonalizationEnabled(chatId, enabled)` — per-user toggle на users row
  - `src/dashboard/server.js`:
    - `_handleTrends`: при `sort=rank` + аутентифицированный юзер + toggle ON + непустая prefs map — строится SQL `ORDER BY (CAST(JSON_EXTRACT(raw_metrics, '$.rankScore') AS INT) + CASE category WHEN 'X' THEN +3 WHEN 'Y' THEN -5 ELSE 0 END) DESC`; каждый boost clamp'ится к ±15 для защиты от перекоса; SQL-эскейп category names
    - Ответ содержит `payload.personalization = { active: true, prefs }` если boost применён
    - Новые endpoints: `GET /api/personalization` (возвращает `{ enabled, prefs: [{ category, net }] }`, sorted desc), `POST /api/personalization` (body `{ enabled: boolean }`)
  - UI: новый компонент `PersonalizationCard` в `SettingsPanel` — независимо фетчит `/api/personalization`, рендерит toggle + грид чипов (`.pref-chip.up` зелёные `+N`, `.down` красные `−N`); empty-state «проголосуй за несколько трендов, чтобы обучить ленту»
  - Переводы: `settings.personalization`, `settings.personalization_desc`, `settings.personalization_toggle`, `settings.personalization_toggle_desc`, `settings.personalization_empty` — EN + RU
  - Взаимодействие с существующим feedback: `feedback_votes` — источник данных и для глобального `trends.user_feedback`, и для персональной карты предпочтений; это два разных read-пути на одних и тех же голосах
- Баг-фиксы / технический долг:
  - **3× SyntaxError «Unexpected identifier 'id' / 'videoUrl' / 'ref'»**: backticks в комментариях внутри огромного template literal в `src/dashboard/server.js` — любой `` `token` `` внутри `//` коммента ломает outer literal. Правило: в этом файле **никогда** не использовать бэктики в комментариях. После каждого исправления — `node -c src/dashboard/server.js` перед деплоем
  - `/api/video/reddit/*` был за auth middleware → `<video>` получал 401; вынесен в public-блок перед auth check
  - `<video>` сначала грузил raw `v.redd.it/...CMAF_720.mp4` из браузерного кэша после обновления кода — hard-refresh (Ctrl+Shift+R) обязателен для тестирования video features
  - `ffmpeg` был установлен на хост, но не в Docker-образе (Alpine) — контейнер собирается из своего Dockerfile, пакеты хоста не попадают; фикс через `apk add ffmpeg`
- Проверка:
  - `node --check` на всех изменённых файлах → OK
  - Вручную проверены: Reddit видео со звуком в дашборде (CMAF), Reddit видео со звуком в Telegram (mux работает), volume persistence при переключении видео, feedback → smaller sample персонализации (требует десятка голосов для видимого эффекта)
  - Миграции `why_now` и `personalization_enabled` накатились без ошибок
- Риски/заметки:
  - Если Reddit снова переименует audio segments — увидим в логах `[Video] no reddit audio found — tried [CMAF_AUDIO_128.mp4=404, ...]`, по списку добавим новый кандидат
  - Кэш `data/video-cache/` растёт при активном использовании; auto-cleanup 7 дней
  - На свежей БД `why_now` пустой у всех старых записей — заполняется постепенно по мере того, как новые тренды проходят AI scoring
  - Клиент кэширует бандл JS агрессивно — при выкатке UI-фич нужно просить ctrl+shift+R или добавить cache-busting (TODO при росте аудитории)
  - Персонализация требует минимум ~5-10 голосов per category чтобы быть заметной; для нового юзера ранжирование идентично глобальному
