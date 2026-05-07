# WORKLOG ARCHIVE

Архивные записи из `WORKLOG.md`. Активный лог содержит **последние 10 entries**;
всё что старше переезжает сюда автоматически (по правилу `AGENT_RULES.md §6`).

Append-only внутри файла — порядок: новейшие архивированные сверху, старейшие снизу.
Полная история до агрегации — в git.



## 2026-05-07 (Tag auto-refresh — Phase 1 infra: storage, admin UI, toggle, history)

Юзер хочет автоматический weekly Grok call чтобы обновлять `subreddits` и Twitter `keywords` по 5 пресетам. Sources не trogatься руками — auto-overrides + manual locks. Cost ~$0.13 / refresh × 4/мес = ~$0.54/мес.

**Грок-промпт после 3 итераций**: source-vs-subject distinction усвоен (Grok даёт horizontal hubs + behavior-pattern keyword groups, не named memes). Slang-anchor (6-я keyword группа) — слабая точка, без Live Search Grok галлюцинирует «свежие 2026 термины». Решено в Phase 2 делать **variant 3** (reality-check каждого slang term через 1 Apify Twitter probe) + Live Search через xAI API.

**Архитектурные решения**:
- **Storage**: 3-layer merge `defaults → presetConfigsAuto → presetConfigs (manual)`. Manual ВСЕГДА побеждает. Auto-blob — separate setting.
- **Lock**: Phase 3 будет per-tag pin (юзер сказал «и базу хороших тегов соберу со временем»). Phase 1 только storage `presetTagsLocked` без UI.
- **Cooldown**: 7 дней scheduled, 1×/24h force (anti-double-click). Both в env, defaults в коде.
- **Failure**: 3 strikes circuit breaker (auto-disable после 3 fails подряд), manual reset через админку.
- **Models**: primary `grok-4.3` ($1.25/$2.50/M), fallback `grok-4.20-0309-reasoning` (то же pricing). Оба через тот же `XAI_API_KEY` / `XAI_BASE_URL`.
- **Clear ALL extension**: panic-button теперь стирает ОБА blob'а (manual + auto), полный возврат к code-defaults.

**Что в Phase 1 (этот коммит)**:

1. **DB** (`src/db/database.js`):
   - Migration: table `tag_refresh_history(id, ts, preset, source_type, status, diff_json, error_message, model, cost_usd)` + index по ts.
   - Методы: `recordTagRefresh`, `getTagRefreshHistory(limit)`.

2. **Reader** (`src/analysis/preset-config.js`):
   - `readPresetAutoOverrides(db)` — читает `settings.presetConfigsAuto` blob.
   - `readPresetTagsLocked(db)` — per-tag lock-mask (Phase 3 reader готов).
   - `getActivePresetConfig` теперь делает 3-layer merge через `mergeOverrideBlobs(auto, manual)` → manual wins. Все consumers (scorer/clusterer/collectors) автоматически получают auto-suggestions поверх defaults и manual поверх auto.

3. **Refresher** (`src/refresh/tag-refresher.js` — новый):
   - Class `TagRefresher` с методами: `isEnabled/setEnabled/getStatus/shouldRefreshNow/canForceNow/refreshAll/resetCircuitBreaker`.
   - `_callGrokForPreset` — Phase 1 stub возвращает `null` (no changes). Phase 2 заменит на real xAI call.
   - Cooldown gates через `tagAutoRefreshLastRunAt` setting.
   - Failure tracking через `tagAutoRefreshFailureStreak` (3 → auto-disable).

4. **Admin endpoints** (`src/admin/server.js`):
   - `GET /api/tag-refresh/status` — full status + history (50 last rows).
   - `POST /api/tag-refresh/toggle` body `{enabled}` — переключатель.
   - `POST /api/tag-refresh/force` — запускает refresh (rate-limited 1×/24h).
   - `POST /api/tag-refresh/reset-breaker` — сброс failure streak.

5. **Admin UI** (`src/admin/server.js`):
   - Новая sidebar tab `🔄 Auto-tags` (между Пресеты и Ручной анализ).
   - Component `TagRefreshPage`: status badge (Enabled/Disabled/Circuit-breaker open), toggle button, Force button (с confirm + cost warning), reset-breaker button (только когда CB open), 3-cell stats grid (Last run / Next scheduled / Force available after), preview auto-overrides JSON, history table со status-цветами + cost.

6. **Wire** (`src/index.js`):
   - Инициализация `tagRefresher` после `hotRefresher`.
   - Hourly check loop через `setInterval` (60 min × 60 sec × 1000 ms), первый чек 5 min после boot. Loop вызывает `shouldRefreshNow()`, если ok — фоновый `refreshAll()`.
   - Передаётся в `AdminServer` через extras.

7. **Clear ALL extension** (`src/admin/server.js`):
   - `_setPresetConfigs` при пустом overrides теперь wipes **оба** slot'а (`presetConfigs` + `presetConfigsAuto`).

8. **`.env.example`**:
   - `TAG_REFRESH_COOLDOWN_DAYS=7`, `TAG_REFRESH_FORCE_COOLDOWN_HOURS=24`, `XAI_TAG_REFRESH_MODEL=grok-4.3`, `XAI_TAG_REFRESH_FALLBACK_MODEL=grok-4.20-0309-reasoning`.

**Phase 2 (следующий коммит)**: реальный xAI Responses API вызов с `search_parameters: {mode: "on"}`, JSON schema response, slang reality-check через Apify Twitter probe. Прайс на refresh: ~$0.13.

**Phase 3 (потом)**: per-tag pin checkboxes в `PresetConfigsPage` source-секциях, lock-mask save через новый endpoint.

**Файлы**: `src/db/database.js`, `src/analysis/preset-config.js`, `src/refresh/tag-refresher.js` (новый), `src/admin/server.js`, `src/index.js`, `.env.example`.

**Деплой**: TBD юзером. На проде после деплоя — admin sidebar получит tab `🔄 Auto-tags`, всё работает кроме реального Grok-вызова (stub пишет `skipped_no_diff` rows в history). Можно тестировать toggle / force / breaker UI прямо на проде, ничего не сломается.

**Sanity checks пройдены**: `node scripts/check-admin-spa.cjs` ✓ (SPA template валиден, 207K chars), `node --check` для всех 4 модифицированных .js файлов ✓.

**Риски**:
- Phase 1 stub в production будет каждые 7 дней писать `skipped_no_diff` row в `tag_refresh_history` и bump'ать `lastRunAt`. Безвредно но шумит в audit-логе. Можно оставить — после Phase 2 это место превратится в реальные refresh records.
- Hourly loop добавляет крошечную нагрузку (1 setting read per hour). Negligible.
- Если юзер забыл `XAI_API_KEY` в .env — Phase 2 будет fail'ить. Need explicit error message в Phase 2.

---

## 2026-05-06 (Per-preset review — все 5 пресетов: thresholds/weights/stale/junk апдейт)

После Fix B (scorer/dispatcher unified weights) юзер сделал Clear ALL в админ-панели — все overrides снесены, defaults применяются напрямую. Затем прошлись подряд по 5 пресетам (animals → culture → celebrities → events → general), обсуждая каждую секцию. Sources не трогали (юзер хочет потом сделать auto-discovery). Cluster секцию не трогали кроме обсуждения emergence-веса в alerts.

**Контекст про emergence**: юзер в начале думал что emergence — это cross-platform сигнал и хотел его «вырезать». Уже на финальном этапе нашёл [clusterer.js:759-763](src/analysis/clusterer.js:759) — *"Removed the 'Platform spread' component (was 0–30) — clusterer's cross-source matching is unreliable"* — cross УЖЕ был выпилен 4 мая. Текущий emergenceScore = `Math.max(spread, breakout) + ideaBoost`, всё single-source: velocity (db-appearances/hour, 0-35), organic spread (text variation × cluster size, 0-30), novelty (0-20), author diversity (0-15), breakout (one-post virality), Reddit ideaBoost (0-12). Раз cross убран — emergence в пресетах оставили / вернули, но с пересмотренными весами.

**Animals**:
- `reddit.minUpvotes`: 3000 → 5000 (чище floor)
- `junk.noMemeShapePenalty`: 10 → 15
- `alerts.thresholds.alertHardJunkStop`: 65 → 70
- `alerts.stale`: `1/48/20` → `2/24/30` (tail-end ~1.6 дня вместо ~3, юзер хотел до 2)
- `alerts.weights`: `meme 0.45 / viral 0.20 / emerge 0.10→0.15 / twitter 0.10→0.05 / feedback 0.15` (бамп emerge)

**Culture**:
- `alerts.thresholds.alertThreshold`: 65 → 60
- `alerts.thresholds.maxAlertsPerCycle`: 8 → 5
- `alerts.weights`: финальные `meme 0.45 / viral 0.25 / emerge 0.10 / twitter 0.15 / feedback 0.05` (вернулись к pre-review state после изначального обнуления emerge)
- `alerts.stale`: `3/12/40` → `1/48/48` (4-дневная жизнь — мемы могут долго развиваться)
- `noMemeShapePenalty=25` — оставлен (юзер сказал не трогать)
- `cluster.timePenaltyHours=12` — оставлен

**Celebrities**:
- `junk.noMemeShapePenalty`: 20 → 25
- `junk.memeShapeBoost`: 6 → 10
- `alerts.thresholds.maxAlertsPerCycle`: 6 → 5
- `alerts.thresholds.alertHardJunkStop`: 65 → 70
- `alerts.weights`: финальные `meme 0.40→0.50 / viral 0.25→0.30 / emerge 0→0.10 / twitter 0.10 / feedback 0.05→0.00` — meme/viral бампнули (юзер не хотел снижать), emerge мягко вернули, feedback обнулили (фандомы поляризованы, голоса шум)

**Events**:
- `alerts.thresholds.alertThreshold`: 50 → 60
- `alerts.thresholds.maxAlertsPerCycle`: 10 → 5
- `alerts.thresholds.alertHardJunkStop`: 85 → 75
- weights не трогали (events — emergence-доминанта, 0.35; единственный пресет где emergence — центральный сигнал)

**General**:
- `junk.noMemeShapePenalty`: 15 → 20
- `alerts.thresholds.maxAlertsPerCycle`: 0 (∞) → 5 (раньше был без капа — anomaly)
- `alerts.weights`: `meme 0.45 / viral 0.20→0.15 / emerge 0.20 / twitter 0.05 / feedback 0.10→0.15` (юзер-голоса важнее raw виральности в curated mix)
- `alerts.stale`: `2/24/30` → `1/24/48` (3-дневная жизнь)

**Финальная таблица alert weights**:

| Preset | meme | viral | emerge | twitter | feedback | junk× |
|---|---|---|---|---|---|---|
| general | 0.45 | 0.15 | 0.20 | 0.05 | 0.15 | 0.50 |
| animals | 0.45 | 0.20 | 0.15 | 0.05 | 0.15 | 0.40 |
| culture | 0.45 | 0.25 | 0.10 | 0.15 | 0.05 | 0.50 |
| celebrities | 0.50 | 0.30 | 0.10 | 0.10 | 0.00 | 0.55 |
| events | 0.10 | 0.30 | 0.35 | 0.15 | 0.10 | 0.30 |

Σ POSITIVE = 1.00 во всех (validatePresetOverrides проходит).

**Файлы**: `src/analysis/preset-config.js` (DEFAULT_PRESET_CONFIGS — animals/culture/celebrities/events/general).

**Деплой**: TBD юзером через `deploy.ps1`. После деплоя — поскольку все overrides уже снесены через Clear ALL, новые DEFAULT_PRESET_CONFIGS применятся напрямую через `loadAlertWeights(db)` (Fix B unified path).

**Риски**:
- Юзер настаивал что cross-platform не работает — но в коде он УЖЕ убран. То что мы оставили emergence (single-source) не противоречит его желанию.
- ideaBoost (Reddit-specific 0-12 буст за 10K+ upvotes) оставлен — useful early-idea signal, прицельный.
- TODO для будущего: юзер хочет авто-discovery актуальных hashtag/queries для sources (по аналогии с tiktok-trends-scraper, но для Twitter и Reddit). Отдельная задача.
- Существующие alertScore'ы в БД frozen со старыми весами. Новые scan-cycle перезапишут.

---

## 2026-05-06 (Fix scorer/dispatcher alertScore desync — единый источник весов через loadAlertWeights)

Юзер прислал скрин: тренд `Adults entertained by AI stories of fruits and vegetables` в дашборде показывает **alertScore=65 / verdict «would alert»**, но в админ-панели Decisions он же — **score=52, gate=`X порог`**. Юзеру `threshold=52`, admin floor 60 → effective 60 → дашборд проходит, dispatcher отбраковал. Расхождение 13 баллов.

**Root cause** — рассинхрон источников весов:
- **Scorer** (`scorer.js`) при сохранении в БД зовёт `computeAlertScore(trend)` **без передачи весов** → дефолты `DEFAULT_ALERT_WEIGHTS` (новые: `meme=0.45`). В БД летит `raw_metrics.alertScore=65`. Дашборд это и показывает.
- **Dispatcher** (`alert-dispatcher.js:recomputeAlertScores`) пересчитывает через `loadAlertWeights(db)` → читает `settings.presetConfigs.<active>.alerts.weights` где у юзера лежит **stale override** с дорекалибровочными весами (`meme=0.30`). Со старыми весами тот же breakdown даёт 52.

С формулой:
- meme=70, viral=90, emerge=100, junk=15, feedback=50 (no votes), age<24h (no decay)
- Новые (0.45): 70·0.45+90·0.20+100·0.15+50·0.15 − 15·0.50 = 72−7.5 ≈ **65**
- Старые (0.30): 70·0.30+90·0.25+100·0.25+50·0.10 − 15·0.50 = 73.5−7.5 ≈ **52** (фактическая разница ~6.5 чем теоретическая 13 из-за разных weightFeedback/weightTwitter — but scenario сходится)

**Fix B (chosen)** — единый источник правды. В `src/analysis/scorer.js` все 4 вызова `computeAlertScore(...)` теперь передают `loadAlertWeights(this.db)`:
- `_analyzeBatchStage1` (line ~665) — `aw` вычисляется один раз перед `trends.map(...)`, передаётся в callback
- Stage 2 finalization (line ~890) — inline `loadAlertWeights(this.db)` (одиночный trend)
- `_applyHeuristic` (line ~1051) — inline (одиночный)
- `_fallback` (line ~1082) — `aw` один раз перед `.map`

Default-arg `DEFAULT_ALERT_WEIGHTS` в сигнатуре `computeAlertScore(trend, w = ...)` оставлен — для тестов и legacy callers без db.

**Эффект**: scorer и dispatcher теперь читают веса **из одного места** (`settings.presetConfigs.<active>.alerts.weights` через `loadAlertWeights`). Если override stale — оба видят stale значение, если override синхронен с defaults — оба видят defaults. Расхождение «дашборд показывает one score, dispatcher другой» исчезает.

**Caveat / immediate hand-fix нужен**: само по себе Fix B **не вытаскивает** этот конкретный тренд. После деплоя scorer начнёт писать в `raw_metrics.alertScore` через те же per-preset overrides → дашборд начнёт показывать **52** на тех же breakdown'ах (вместо 65), но gate всё равно не пройдёт. Чтобы алерт реально пошёл — нужен **Fix A (юзер-сторона)**: админка → 🎛️ Пресеты → активный пресет → раздел Alert weights → Reset / выставить `meme=0.45` вручную. После reset blob `presetConfigs` для этого preset'а отдаёт defaults → loadAlertWeights возвращает 0.45 → score 65 везде → проходит.

**Файлы**: `src/analysis/scorer.js` (4 точечных правки + один комментарий зачем aw).

**Деплой**: TBD — юзер прогонит через `deploy.ps1` когда будет готов. После деплоя плюс Fix A в админке — следующая batch трендов получит правильный score сразу.

**Риски**:
- Существующие тренды в БД (`raw_metrics.alertScore`) не пересчитываются автоматически — они frozen. Только новые scan-циклы запишут свежий alertScore.
- Если юзер забудет сделать Fix A — Fix B без него ухудшит дашбордовый UX (показ 52 вместо 65), но не починит alert. Главное проверить что override в `settings.presetConfigs` синхронен с defaults после деплоя.
- Не трогали SPA-template (только pure JS в scorer.js) → SPA-чекеры не нужны.

---

## 2026-05-06 (SESSION_CONTEXT trim-pass — 814→651 строк, ~34K→13K токенов, добавлен TOC)

Юзер заметил что SESSION_CONTEXT раздулся в 3× от целевой нормы AGENT_RULES §7 (<12K токенов / ~500 строк) и попросил оптимизировать чтение контекста. Обсудили варианты: сжать файл vs делегировать чтение haiku-агенту vs lazy-load через TOC+Grep. Решение — гибрид: сжатие + TOC.

**Что вырезано/сжато**:
- Удалён tombstone-блок `## Cross-platform aggregation: REMOVED (2026-05-04)` — это change, не state. Уже жил в WORKLOG_ARCHIVE.
- Удалён дубль про favourites (был в § Dashboard layout полностью повторяющий § User favourites).
- Apify scrapers / TikTok subsections (cluster repr / formatter plays / engagement floor / CJK / audio-filter) — каждое из 5-15 строк параграф пересжато в 2-4 строки + сохранены ключевые числа.
- Hot trends refresh / Production posture / Admin panel / Catalyst forecast — длинные параграфы → bullet-lists.
- Stage 0 / Stage 2 / PreStage knobs — компактнее, без многословной мотивации (но цены и numbers сохранены).
- Apidojo input schema details + PRICING TRAP — детали в WORKLOG, в state остался только намёк «verify console pricing».

**Что сохранено целиком (critical state)**:
- Бизнес-правила / Plans table.
- Per-preset divergence table (15+ rows).
- Alert gate formula + Σ POSITIVE invariant.
- Multi-signal clustering веса/пороги.
- CJK threshold multiplier table.
- **Обе ловушки** (server.js SPA + SQLite TEXT timestamps) — это unique gotchas, без них новый агент сразу нарвётся.
- Files map целиком.
- Env keys минимальный набор.

**TOC сверху**: добавлен group'd-список секций с lazy-read рекомендацией («Используй TOC + Grep по `## <Имя>` + offset/limit. Если нужно общее саммари — делегируй haiku-агенту»).

**Файлы**: `ai-context/SESSION_CONTEXT.md`.

**Риски**: возможно вырезал кусок который кто-то из агентов привык встречать. Полный pre-trim файл в `git log` (commit-history). Если за ~неделю никто не споткнётся — норма устаканится.

---

## 2026-05-06 (Темы: убрал Dim/Slate/Mono, добавил Tide — navy + cyan по референсу)

Юзер прислал референс-скрины крипто-снайпер-тулзы (тёмный navy bg, аквамариновый акцент) и попросил оставить только 2 темы: текущую `ink` + новую по референсу. `dim` выглядел грязно, `slate` и `mono` были почти неотличимы от ink — мёртвый выбор.

**Что сделано** (`src/dashboard/server.js`):
- Удалил CSS блоки `body[data-theme="dim"]`, `body[data-theme="slate"]`, `body[data-theme="mono"]` (~57 строк).
- Добавил `body[data-theme="tide"]` с палитрой по референсу:
  - `--bg: #0a1622` (deep navy), `--surface: #0f1c2a`, `--card: #14202e`
  - `--text: #d6e1ec` (холодный off-white), `--muted: #7387a0` (сине-серый)
  - `--accent: #4dd4e0` (aqua/cyan), `--accent2: #7ce8f0`
  - Borders на rgba(115,168,210, .10/.18/.28) — холодная сталь вместо нейтрального белого
- `SUPPORTED_THEMES = ['ink', 'tide']`, `THEME_META`: ink ⬛/Чернила, tide 🌊/Прилив.
- Theme-swatch preview в settings: убрал dim/slate/mono dot-блоки, добавил tide (`#0a1622` / `#4dd4e0` / `#14202e`).
- Обновил комментарий `===== THEME SYSTEM =====` (4 темы → 2 темы).

**Авто-адаптация компонентов**: всё что использует `var(--accent-rgb)`, `var(--surface)`, `var(--text)`, `var(--bg)`, `var(--muted)`, `var(--dim)` — авто-перекрашивается. Семантические цвета (green/red/orange/yellow/purple/pink) **не трогал** — они остались константами через themes для предсказуемости OK/error сигналов.

**Migration**: `detectTheme()` пропускает невалидные сохранённые значения (`'dim'`, `'slate'`, `'mono'` теперь не в `SUPPORTED_THEMES`) и сбрасывается на дефолт `'ink'`. Юзеры со старыми сохранёнными темами увидят ink при следующем заходе.

**Файлы**: `src/dashboard/server.js`.

**Деплой**: запущен через `deploy.ps1`.

**Риски**: i18n тексты `settings.theme_desc` («All dark — no white allowed»/«Все тёмные — никакого белого») остаются актуальными для обоих вариантов, не правил.

---

## 2026-05-06 (Избранное — Pro/Admin фича: snapshot-storage, star на карточках, Saved-таб)

Юзер запросил «отдельную базу для избранных, доступную только Pro/Admin, с сохранением навсегда». Добавил полноценную фичу с защитой от ротации трендов через snapshot-копию.

**БД** (`src/db/database.js`):
- Новая таблица `user_favorites(id, chat_id, trend_id, note, snapshot, created_at)`. UNIQUE(chat_id, trend_id) для idempotent upsert. Без CASCADE / retention — фавориты вечны.
- Поле `snapshot` — JSON-копия всех ключевых полей тренда на момент сохранения (title, source, url, image, raw_metrics, alert_type, whyNow, trigger_*, externalId, author и т.д.). Если `trends`-row удалится из-за ротации — favourite **выживает** через snapshot. LEFT JOIN в `getFavoritesByChat` отдаёт fresh-данные если есть, fallback на snapshot.
- DB-методы: `addFavorite/removeFavorite/setFavoriteNote/getFavoriteTrendIds/getFavoriteMeta/getFavoritesByChat/countFavoritesByChat` + helper `_trendSnapshot(trend)` который выбирает поля для snapshot.
- `addFavorite` использует `INSERT ... ON CONFLICT DO UPDATE` — повторное сохранение освежает snapshot и note. Note преимущественно cap 500 chars (enforced на endpoint-стороне).

**Entitlements** (`src/billing/entitlements.js`):
- Новое поле `favorites: boolean` — `false` для free/test, `true` для pro/admin.
- Новый helper `shouldShowUsageCounter(planName)` — true только для test (используется в test-usage-counters fиче).
- Новое поле `historyHours: number` — `72` для free (3-day window cap), `-1` (unlimited) для остальных.

**Endpoints** (`src/dashboard/server.js`):
- `POST /api/trends/:id/favorite` (опц body `{note}`)
- `DELETE /api/trends/:id/favorite`
- `PATCH /api/trends/:id/favorite` body `{note}` для редактирования заметки
- `GET /api/favorites` — полный список с merged fresh+snapshot
- Все 4 гейтятся через `_favoriteGate(req, res)` — Pro/Admin only, иначе 403 reason='plan'.
- `_handleTrends` pre-fetch'ит `Set<favoriteIds>` один раз, передаёт в `_formatTrend(row, userId, favSet)` для O(1) per-row attach `isFavorite`. Поддержка `?favoritesOnly=1` через WHERE `id IN (...)`. Возвращает `favoriteCount` в payload для счётчика в nav.
- `_publicUser` теперь содержит `entitlements` объект — фронт читает `me.entitlements.favorites` для render-логики.
- `api()` helper теперь attach'ит `err.status` и `err.reason` на все !ok ответы (раньше только на 401).

**Frontend** (`src/dashboard/server.js` SPA):
- ⭐-кнопка на feed-карточке — inline в `.feed-user-row` сразу после аватара (слева). Hover-only когда не сохранено, always-visible с filled accent-цветом когда saved. Pulse-анимация `favPulse` на add. Free/test — кнопка не рендерится вообще (clean cards, дискавери через nav-таб).
- ⭐-кнопка в `.modal-head` — самым **левым** элементом перед всеми badge'ами (раньше была между источником и ✕, юзер попросил перенести влево).
- Новый компонент `FavoriteNoteEditor` — вставляется в начало modal-body когда `isFavorite=true`. Три состояния: «add note» CTA → текст + ✏ edit + ✕ remove → textarea с Save/Cancel (Cmd/Ctrl+Enter — save, Esc — cancel). Cap 500 chars.
- Snapshot-banner `🗄 Saved copy — original may have been removed` рендерится поверх модалки когда тренд из snapshot (LEFT JOIN не нашёл live-row).
- `BottomNav` — Saved-таб **между Feed и Analyze**. Active когда `view==='trends' && favoritesOnly`. Counter справа со значением `favoriteCount`. Click — toggle `favoritesOnly` + `setOffset(0)` + `view='trends'`. Free/test — locked с 🔒, click → upgrade toast.
- Optimistic UI в `toggleFavorite`: моментально патчит `isFavorite` в trends-list и modalTrend, fire-and-forget request, rollback на 403/500. Pulse через `btnEl.classList.add('just-saved')` на 450ms.
- 19 i18n-ключей `fav.*` (EN+RU): tooltips, toasts, note-placeholder/save/edit/remove, filter_label, snapshot_hint, locked_*.
- CSS: `.feed-fav-btn` (компактная 18×18 inline), `.modal-fav-btn` (26×26 в head), `.fav-note-block` + `.fav-note-textarea` + `.fav-note-actions` + `.fav-snapshot-banner`. Все через `var(--accent-rgb)` для авто-адаптации к теме.

**Файлы**: `src/db/database.js`, `src/billing/entitlements.js`, `src/dashboard/server.js`.

**Деплой**: задеплоено через `deploy.ps1`. Таблица создаётся при первом старте контейнера.

**Риски/заметки**:
- Telegram-бот **не тронут** — юзер явно сказал «бот и так перегружен, не нужно». Если когда-нибудь захочется — DB-таблица shared, бот может присоседиться через callback `fav:<id>` и DB-метод `addFavorite(chatId, trendId)`.
- Snapshot фиксирует метрики на момент сохранения — если тренд жив, рендер всё равно использует fresh-данные через LEFT JOIN. Только когда тренд удалён — snapshot-fallback показывает «замороженное» состояние.
- Manual-analyze тренды не сохраняются (synthetic id `manual-...`, не в `trends`-таблице). Если попробовать — добавление пройдёт но через час ручной анализ исчезнет из кэша → snapshot останется единственным источником. Не критично, но edge-case.
- `?favoritesOnly=1` не комбинируется с `?source=` или `?category=` корректно — оба фильтра применяются AND'ом, но если favoriteIds мал и user применил category — может получиться 0 результатов. Acceptable: фильтры работают предсказуемо, просто пересечение пусто.

---

## 2026-05-06 (UI/UX полировка дашборда — login screen, nav, locked-визуалы, toast, Stats убран)

Большой проход по визуалу дашборда — 8 неотносящихся друг к другу UI-задач за один день.

**1. Login screen — полный редизайн**
- Заменил эмоджи 🔥 на лого-кота (PNG из `assets/logo.png` через `/assets/logo.png?v=LOGO_VERSION`). Контейнер 80×80 с X-blue accent-glow, fallback на 🐱 на onError.
- Убрал language-switcher (EN/RU) — login-экран теперь EN-only, все строки захардкожены. Юзер переключает язык в Settings после входа.
- Ambient X-blue gradient blobs (3 радиальных) + dot-grid overlay с radial mask — современный SaaS-look.
- Glass-карточка max-width 440px с backdrop-blur, тонкая translucent-белая бордер.
- Брендинг: лого + крупный «Catalyst» с gradient text-fill (`var(--text)` → `var(--text2)`) + shorter tagline «Track narratives across the social web.» (39 chars, fits one line, без orphan-слов).
- 3 mini-фичи в карточке: 📡 Multi-source feed / 🎯 Trend scoring / 🔔 Real-time alerts (убрали «AI» из tagline и плашки — implementation detail).
- CTA-кнопка «Sign in with Telegram» — flat (без 3D-stripe, юзер пожаловался что выглядит как артефакт), gradient `var(--accent)` → темнее (`#146da8`). SVG paper-plane icon с `rotate(-25deg)` — Telegram-style диагональ вместо стрелки.
- Disclaimer под кнопкой: «No password needed. We'll send a one-time code to your Telegram.» (заменил неуклюжий «No password — auth via our Telegram bot. You'll get a one-time code.»).
- Footer вместо неактивной плашки `catalystparser.io` → активная X-pill `𝕏 @Catalystparser` (hover-effect).
- Code-фаза (после клика «Sign in») — та же стилистика: glass card, моно-ввод 6 цифр, X-blue gradient submit (раньше был оранжевый — заменён для согласованности).
- Все цвета через `var(--bg)`, `var(--surface)`, `var(--text)`, `var(--muted)`, `var(--dim)`, `rgba(var(--accent-rgb), N)` — авто-адаптация под тему (Ink/Dim/Slate/Mono).

**2. Telegram-бот ссылка в навигации**
- Добавлена кнопка слева от 𝕏 в nav-right. SVG paper-plane (Telegram-brand path), та же стилистика `nav-icon-btn`.
- Bot username резолвится при старте dashboard-сервера через `telegram.getBotUsername()` (`bot.getMe()`) и кэшируется в `this._botUsername`. Инжектится в SPA-template как `BOT_USERNAME` константа (рядом с `LOGO_VERSION`).
- Fallback на голый `https://t.me/` если username не зарезолвился.

**3. Locked-визуалы для Free на источниках**
- Sidebar SOURCES list: Twitter/TikTok/X-Trends для Free показываются с `🔒`-пилюлей вместо счётчика, dim opacity 0.55, dashed-look. Click → toast `🔒 Этот источник — на Test/Pro`. На hover чуть подсвечивается («можно апгрейднуть» вместо «сломано»).
- Live → SOURCES dots в правой панели: те же источники для Free — pill с dashed-бордером, серый dot, glyph заменён на 🔒, tooltip `<source> — locked (Test/Pro)`.
- Backend `_handleSources` теперь возвращает `inPlan: bool` для каждого источника (на основе `getPlanEntitlements(planName).sources`).

**4. Catalyst forecast locked-карточка**
- Раньше для Free/Test был disabled-button с `🔒 Catalyst forecast — Test/Pro` (юзер сказал «выглядит как артефакт»).
- Новая locked-карточка в едином стиле с feature-list login'а: 36×36 icon-tile с 🔒 на X-blue свечении + жирный title + дим subtitle. Не disabled-кнопка, а информационный блок.

**5. Stats-таб убран**
- В bottom-nav было 3 таба (Feed/Stats/Analyze). Stats показывал 80% дублей того что и так в сайдбаре + правой панели, читался как полупустой экран. Убрал из BottomNav `tabs` массива и `view === 'stats'` рендеринга в App.
- StatsPanel-компонент **остался в коде** (dead code) — если когда-нибудь решишь вернуть, раскомментируешь два блока.
- `/api/stats` endpoint **активен** — его всё ещё дёргает фронт для Live-панели (signals/alerts/avg-virality counters).

**6. Toast notifications redesign**
- Раньше: rectangle 260-380px с **левой синей полоской** (`.toast::before`) и тремя ярко-выраженными inset-highlight'ами. Юзер пожаловался что полоска слева выглядит как артефакт от старой right-side версии.
- Стало: pill-shape (`border-radius: 999px`), **позиция top:14px** (с самого верха, над navbar), переписан в Ink-палитре через CSS-vars. Single layered shadow без inset-bevels (плоско, не embossed). Type-сигнал теперь только через border-tint и icon-color.
- Auto-icon (✓/✕/ℹ) **скрывается** когда сообщение начинается с эмоджи/символа — раньше юзер видел `[ℹ️] 🔒 Manual analysis...` (двойная иконка), теперь просто `🔒 Manual analysis...`. Detection: regex `/^[\p{L}\p{N}\s]/u` — если первый символ буква/цифра/пробел → показать auto-icon, иначе пропустить.

**7. Manual analyze для Free возвращён в bottom-nav как locked**
- Юзер ранее попросил полностью скрыть Analyze-таб для Free. Передумал — discoverability важнее. Теперь таб показывается всегда с 🔒 для Free, click → upgrade toast «🔒 Manual analysis is available on Test/Pro».
- `BottomNav` принимает `addToast` prop, locked-таб обрабатывает click через toast вместо setView. CSS `.sb-foot-btn.locked` — opacity 0.55, dashed-border.

**8. Star на feed-карточках перенесена влево**
- Изначально `.feed-fav-btn` был absolute-positioned `right: 37px` — рядом с ✕. На узких viewport'ах badges подпирали её — выглядело как один блок ★✕.
- Теперь inline в `.feed-user-row` сразу после аватара (слева). 18×18 пилюля без чёрной заливки, лёгкий контур. Hover-only когда не сохранено, always-visible с filled accent когда saved. ✕ остался absolute справа — семантически разные действия (save/dismiss) визуально разделены.

**Файлы**: `src/dashboard/server.js` (всё в SPA-template — login, nav, sidebar, modal, toasts, BottomNav, FeedCard).

**Деплой**: задеплоено через `deploy.ps1`.

**Риски/заметки**:
- Поймал три раза подряд **ловушку backticks-in-comments** при добавлении JSDoc-комментариев в SPA-template. Каждый раз один и тот же фикс — убрать backticks из `// ...` строк. Trap уже описан в SESSION_CONTEXT, но я почему-то всё равно периодически ставлю их рефлекторно. На будущее: внутри SPA-template только plain-text комменты.
- Поймал **апостроф в single-quoted строке** внутри SPA-template (например `'won\'t alert'`) → outer template literal съедает `\'` → browser SyntaxError → чёрный экран. Решение — double-quote `"won't alert"`. Trap тоже описан.
- Login-screen теперь жёстко EN. Если когда-нибудь будет нужно вернуть язык — все хардкоженные строки в `LoginScreen()` придётся восстановить через i18n.
- StatsPanel остался dead code (~250 строк). Можно удалить отдельным проходом если решишь что не вернёшь.

---

## 2026-05-06 (Alert observability в дашборде + рекалибровка весов под memePotential-доминанту)

Владелец заметил инверсию: посты с высоким memePotential (91) не алертятся, а низкие (50-60) проходят. Раскрутил два слоя проблемы:

**Слой 1 — формула alertScore многокомпонентная**: `0.30·meme + 0.25·viral + 0.25·emerge + 0.10·twitter + 0.10·feedback − 0.50·junk − staleDecay` (для general пресета). При memePotential=91, virality=20, emergence=87 → score = 91·0.30 + 20·0.25 + 87·0.25 + 0 + 5 = 59 → **fail при floor=60**. А при memePotential=50, virality=85, emergence=85 → score = 15 + 21 + 21 + 5 = 62 → **pass**. Чистая инверсия — высокий мем-сигнал AI глушится средними остальными метриками. Дашборд показывает `MEME SCORE` крупно, юзер судит по нему, но алерт-гейт смотрит композит.

**Слой 2 — нет наблюдаемости в дашборде**: `alertScore` хранится в БД и приходит в API-payload, но в TrendModal не отображался. Юзер не видел реальный балл по которому решается алерт. Чтобы понять причину пропуска приходилось лезть в админ-панель `/decisions` (которая работает корректно — показывает по-каждому решению gates: threshold/hard_junk/source/alert_type/dedup/daily/cap).

**Опция C (observability + рекалибровка)**:

1. **Заменил тайл «Срок жизни» на «Alert»** в TrendModal — крупный `alertScore / порог`, цвет зелёный/красный по passed. `lifespanLabel` сохранён в коде для других мест где используется (никаких поломок).

2. **Добавил секцию «🔔 Alert verdict / Решение алерта»**:
   - Pass/fail pill с порогом и вердиктом
   - alertType chip (`post · ✓ в фильтре` / `post · ✕ выключен в фильтре` — отдельный гейт от score)
   - Разбивка компонентов alertBreakdown как мини-чипы: `meme 91`, `viral 30`, `emerge 87`, `junk −15`, `stale −5`. Мгновенно видно что именно тянет вниз.

3. **Server-side**: добавил `alertFloor` в `_publicUser` (= `alerts.thresholds.alertThreshold` активного пресета) — клиент знает админский floor чтобы вычислить эффективный = `max(user.threshold, alertFloor)` для честного pass/fail вердикта.

4. **Рекалибровка весов (per-preset, DEFAULT_PRESET_CONFIGS в `preset-config.js`)** — поднял memePotential-вес чтобы AI-вердикт доминировал:

   | Preset | meme было → стало | inversion fix |
   |---|---|---|
   | general | **0.30 → 0.45** | meme=91 теперь 41 балл сразу, легко пробивает 60 |
   | celebrities | **0.25 → 0.40** | то же |
   | animals | 0.45 (без изм.) | уже корректно |
   | culture | 0.45 (без изм.) | уже корректно |
   | events | 0.10 (без изм.) | by design — events care about timing, не memes |

5. **DEFAULT_ALERT_WEIGHTS в `scorer.js`** — fallback на случай когда per-preset нет ключа: тоже бамп `meme 0.35 → 0.45`. На практике per-preset всегда полностью populated, но defaults остаются source-of-truth для новых deployments.

**Σ инвариант** соблюдается: positive-веса (meme + viral + emerge + twitter + feedback) = 1.00 во всех пяти пресетах, validateProfileOverrides не сломается.

**Файлы**: `src/dashboard/server.js` (TrendModal — alert tile + breakdown section, alertFloor в _publicUser, 16 i18n keys EN+RU, импорт getActivePresetConfig), `src/analysis/scorer.js` (DEFAULT_ALERT_WEIGHTS), `src/analysis/preset-config.js` (general + celebrities weights).

**Эффект для existing data**: trends в БД уже имеют alertScore посчитанный со старыми весами — они отображаются как есть. Новые trends со следующего цикла получат новые баллы. Old alerts остаются frozen (это и нужно). Per-preset overrides в БД (если юзер кастомизировал веса через админ UI) **остаются** — defaults не перезаписывают override'ы; чтобы применить новые defaults — Reset в админ UI.

**Деплой**: задеплоено владельцем через `deploy.ps1`.

---

## 2026-05-06 (Реструктуризация планов: убран daily-cap алертов, sources-гейт для Free, per-plan caps на Pro-фичи)

Юзер пройдясь по логике планов обнаружил: `plan_sources` и `history_days` в БД — мёртвые поля, нигде не применялись. Free-юзер получал алерты со всех источников и видел весь дашборд как Pro. Plus daily-cap на алерты (тоже -1 у всех планов) был мёртвой инфраструктурой. Решил упростить и при этом сделать реальные различия между планами.

**Новая структура планов**:

| План | Sources | Manual Analyze | Catalyst forecast | Alerts/day |
|---|---|---|---|---|
| free  | reddit + google_trends | 🔒 заблокировано | 🔒 заблокировано | ∞ |
| test  | все 5 | 5/день | 5/день | ∞ |
| pro   | все 5 | 100/день (anti-spam) | 100/день (anti-spam) | ∞ |
| admin | все 5 | ∞ | ∞ | ∞ |

**Single source of truth** — `src/billing/entitlements.js` (новый модуль). `getPlanEntitlements(planName)` отдаёт `{ sources, manualAnalyze, catalyst }`. Caps semantics: -1 = unlimited (admin), 0 = blocked (free), N = N/day. Импортируется из dashboard/server.js и notifications/telegram.js — гарантирует что бот и сайт договариваются по правилам.

**Что выпилено**:
- `daily` gate в `alert-dispatcher.js` — алерты не платная фича, ограничивать смысла нет
- 15-минутный per-user cooldown на Catalyst forecast в боте и дашборде — Catalyst оказался дёшев (~$0.05/call), daily-cap достаточно для anti-spam
- Поле `alert_limit` в плане osталось, но нигде не читается (legacy, можно убрать в будущем)

**Что добавлено**:
- `plan_source` gate в `alert-dispatcher.js` — алерты для Free идут только из Reddit/Google
- Source-фильтр в `_handleTrends`, `_handleStats`, `_handleSources` дашборда — Free видит в фиде только разрешённые
- `inPlan: bool` в ответе `_handleSources` — фронт может рисовать 🔒 на недоступных источниках
- `entitlements: {sources, manualAnalyze, catalyst}` в `_publicUser` — клиент знает свои лимиты
- Per-plan daily caps в manual-analyze и catalyst gate'ах (бот + сайт), in-memory ring `Map<chatId, timestamps[]>`

**Visual locks**:
- Dashboard TrendModal Catalyst: button с 🔒 для Free, нормальная для Test/Pro (с error-toast при достижении daily cap)
- Dashboard bottom-nav «🧪 Analyze» tab: скрыт для Free, виден для Test/Pro/Admin
- Bot /menu Sources: премиум-источники с 🔒 для Free, click → toast «Available on Test/Pro»
- Bot trigger-button в алертах: 🔒 для Free вместо обычной кнопки, callback показывает upgrade-toast
- Bot manual analyze: 🔒 message для Free вместо обработки команды

**i18n обновлён**: `paymentTitle` в EN+RU перепиcан под новую структуру (3 плана, конкретные числа). Удалено упоминание мёртвого alert_limit. Добавлены `trigger.daily_limit` для error-toast'а.

**Schema/seeding обновлён**: `src/db/schema.sql` и `database.js normalizePlans` — sources для test/pro/admin теперь включают `x_trends` (5-я платформа), descriptions переписаны.

**Файлы**: `src/billing/entitlements.js` (новый), `src/notifications/alert-dispatcher.js`, `src/notifications/telegram.js`, `src/dashboard/server.js`, `src/db/database.js`, `src/db/schema.sql`, `src/i18n/en.js`, `src/i18n/ru.js`.

**Follow-up в той же сессии — Test usage counters + history cap + admin cleanup**:

- **Usage counter для Test после каждого платного вызова**:
  - Helper `shouldShowUsageCounter(planName)` в `entitlements.js` — true только для `test`. Pro/admin не показывают (cap=100 = шум, admin=∞).
  - Bot: после успешного manual-analyze и catalyst trigger шлёт follow-up сообщение `📊 X/5 used today (Y left)`. Cache hits не консумируют слот, counter не показывают.
  - Dashboard: API возвращает `usage: { used, cap, left }` в payload manual-analysis и catalyst-trigger. Frontend (TriggerSection, AnalyzePanel) рендерит маленькую dim-строчку `t('usage.test_left')`. Pro/admin/cache-hit → server возвращает `usage: null`, фронт не рендерит.

- **Cap history-window для Free (3 дня)**:
  - `historyHours` field в entitlements: `free=72, test/pro/admin=-1` (unlimited).
  - Backend cap в `_handleTrends` и `_handleStats`: `Math.min(requestedHours, planHistoryHours)`. Silent — Free посылает ?hours=168, получает 72-часовое окно.
  - Frontend window-segments: 7d опция рендерится с `🔒` + opacity 0.55, click → upgrade-toast вместо переключения. Defence-in-depth с серверным капом.

- **Admin UI cleanup**:
  - Убраны колонки «Алертов/день» и «Дней» из таблицы планов в `admin/server.js`. Оба поля dead в БД, новые правила в `entitlements.js`.
  - Grid template сжат с 5 колонок до 3 (План / Цена / Источники-save).
  - Добавлена info-плашка над таблицей: «Лимиты по фичам теперь в коде src/billing/entitlements.js, здесь правится только цена».

**Файлы (доп. к основной работе выше)**: `src/billing/entitlements.js` (+ `shouldShowUsageCounter`, `historyHours`), `src/admin/server.js` (plan-row CSS + table render), `src/i18n/en.js`+`ru.js` (доп. ключи `window.locked_*`, `usage.test_left`).

**Деплой**: TBD через `deploy.ps1`. После деплоя plans-таблица перенормализуется через `normalizePlans` транзакцию (UPSERT по name) — существующие row'ы получат новые sources/descriptions без потери user-привязок (`users.plan_id` остаётся).

**Риски/заметки**:
- Существующие Free-юзеры после деплоя перестанут получать алерты по Twitter/TikTok/X-Trends (если получали раньше — а они получали, потому что gate не работал). Если важно — можно объявить им апгрейд через рассылку.
- Тестовый план = 1 день. Если юзер исчерпал 5/5 на manual-analyze в первые 2 часа — всё, до конца дня без него. Подумать, может test надо растянуть на 3 дня (но это рекалибровка цен, не текущая задача).
- `_catalystHits` и `_manualAnalysisHits` — in-memory Maps, ресетятся на рестарте. Soft-cap, не security boundary. На multi-process сетапе (если когда-нибудь) понадобится Redis.
- В Telegram counter шлётся отдельным сообщением (= 2 ping на одну операцию). Альтернатива — модифицировать sendAlertToUser чтобы добавлять footer, но это инвазивно. На Test-плане 5 операций/день, ОК.

---

## 2026-05-06 (Публичный хостинг на catalystparser.io — TLS, nginx, lockdown, ufw, backup)

Перевели Catalyst из режима «дашборд на голом IP» в полноценный публичный хостинг. Всё что было сделано в production-readiness pass от 2026-05-04 (security headers, CORS allowlist, rate-limits, graceful shutdown, hard-fail env validation) теперь реально активировано через TLS + reverse-proxy.

**1. Домен**: `catalystparser.io` куплен на Porkbun. DNS A-записи для `@` и `www` указывают на 37.1.196.83. Nameservers — Porkbun-овские.

**2. nginx + Let's Encrypt** (на VPS):
- `apt install nginx certbot python3-certbot-nginx`
- `/etc/nginx/sites-available/catalyst` — server-блок с proxy_pass на `127.0.0.1:8080`, SSE support (proxy_buffering off, read_timeout 24h), стандартный набор proxy headers + Authorization passthrough, `set_real_ip_from 127.0.0.1` + `real_ip_header X-Forwarded-For` для downstream rate-limit'а
- `certbot --nginx -d catalystparser.io -d www.catalystparser.io --redirect` — получил cert (R13), автопатч nginx-конфига для 443, добавил 80→443 редирект
- Cert valid до 2026-08-03, auto-renew через `certbot.timer` (systemd, тикает ежедневно)

**3. Port lockdown**:
- `docker-compose.yml`: `"8080:8080"` → `"127.0.0.1:8080:8080"` (Docker слушает только на loopback, наружу выходит исключительно через nginx)
- В `.env` добавлены три переменные: `PUBLIC_BASE_URL=https://catalystparser.io`, `DASHBOARD_ALLOWED_ORIGINS=https://catalystparser.io`, `TRUST_PROXY=1`
- Задеплоено через deploy.ps1, голый IP `http://37.1.196.83:8080` теперь не отвечает (timeout)

**4. Bonus i18n-фикс**: при подготовке к деплою `scripts/check-dashboard-spa.cjs` поймал баг — `'modal.alert_fail': 'won\'t alert'` (single-quoted с escaped apostrophe). Внутри outer template literal Node съедает `\'` → в HTML летит `'won't alert'` → browser SyntaxError → чёрный экран всего SPA. Это **именно тот класс багов** который описан в SESSION_CONTEXT «Ловушка server.js → escape-sequences». Фикс — переключить на double-quoted `"won't alert"`. Зашло в одном деплое с alert-observability работой.

**5. Файрвол ufw**:
- `ufw allow 22/80/443/tcp` + `ufw --force enable`
- Default deny incoming, остальные порты (включая закрытый изнутри 8080) теперь и на уровне ОС блокируются для внешних соединений
- Logging on (low) — атаки видны в `/var/log/ufw.log`
- Включается автоматом при ребуте VPS

**6. Daily backup БД**:
- `apt install sqlite3` на хост (sqlite3 в контейнере не было)
- `/usr/local/bin/catalyst-backup.sh` — discover'ит mountpoint named volume `catalyst_data` через `docker volume inspect`, делает `sqlite3 .backup` (locking-aware hot snapshot, безопасно при concurrent writes), gzip'ает, кладёт в `/var/backups/catalyst/catalyst_YYYY-MM-DD_HH-MM.db.gz`, ретеншн 14 дней
- Cron `/etc/cron.d/catalyst-backup` — daily 03:30 UTC, лог в `/var/log/catalyst-backup.log`
- Тестовый прогон: 18M база → 4M gz архив

**Состояние сервера на момент деплоя**: до чистки 76% диска занято. `docker builder prune -af` + `journalctl --vacuum-size=200M` освободили ~5 ГБ — теперь 53%. БД 18 МБ, app-логи 5 МБ за 10 дней.

**Что осталось как nice-to-have** (юзеру самому):
- UptimeRobot.com мониторинг `/api/health` (бесплатно, 5 мин на регистрацию)
- Off-site backup в S3/Backblaze ($1-3/мес) — сейчас бэкап на том же VPS
- Лендинг с описанием продукта + Privacy/ToS если идём в публичность

**Файлы**: `docker-compose.yml` (port binding), `.env` (3 hosting keys), `src/dashboard/server.js` (i18n quote fix). На VPS: `/etc/nginx/sites-available/catalyst`, `/etc/letsencrypt/live/catalystparser.io/`, `/etc/cron.d/catalyst-backup`, `/usr/local/bin/catalyst-backup.sh`, `/var/backups/catalyst/`.

**Риски/заметки**:
- Если VPS целиком умрёт — бэкап тоже умрёт. Добавить off-site копию когда будут платные юзеры.
- Telegram-бот в polling, не webhook — масштабирование на >1 инстанс пока невозможно. Не блокер до тысяч юзеров.
- Cert auto-renew проверим через 60 дней (`systemctl list-timers | grep certbot` показывает что он тикает).

---

## 2026-05-05 (TikTok: cluster aggregation bug — alert metrics не совпадали с linked видео)

Пользователь прислал скриншот: алерт говорит «@brandyvsmuva posted with 2.14M plays, 128K likes, 17K shares», в строке метрик «180.6K plays · 341 comments», а на самой странице TikTok у видео 6842 лайка, 127 шеров и сильно меньше плеев. Видео по floor'у 500K/20K/5K не должно было проходить — но прошло. Раскрутил три бага наслоившиеся:

1. **Cluster aggregation в `_clusterByHashtag`** — после кластеризации `metrics.plays/likes/shares` = СУММА по всем видео хэштега, а URL/обложка/автор — ПЕРВОЕ попавшееся видео в порядке обработки. AI-промпт получал `"TikTok: 2,140,000 plays | 128,000 likes | ..."` (cluster sum) + одного автора → писал whyNow «@brandyvsmuva posted 2.14M plays». Юзер кликает — там 6.8K лайков. Перепрошлось чтобы выбирать представителя по виральному скору `plays + shares*1000 + likes*10` (shares — самый сильный сигнал) и использовать ИНДИВИДУАЛЬНЫЕ метрики представителя на выходе. Cluster-totals вынесены в отдельные поля `clusterPlays/clusterLikes/clusterShares/videoCount` для контекста.
2. **`viralScore ≥ 60` floor — дыра** — формула это сумма log10 пяти метрик, любое видео с 200K плеев получает `viralScore=100` (только `10·log10(200K)≈53` баллов от плеев + что-нибудь ещё пушит за 60). Гейт всегда срабатывал → видео @brandyvsmuva (200K плеев / 6.8K лайков / 127 шеров) пролетало через viralScore-путь даже когда concrete-floors не пускали. Убрал viralScore из OR-floor'а — оставил только `plays/likes/shares` концентрированные пороги.
3. **`formatter.js` подменял "plays" на upvotes-композит** — для TikTok строка алерта показывала `m.upvotes` (= `likes + shares*3` = 128K + 51K ≈ 180.6K), подписывая как "plays". Реальные плеев у кластера было 2.14M (то что AI взял в whyNow). Поправил formatter — теперь TikTok показывает `m.plays` напрямую с правильным лейблом.
4. **`velocity` затиралось на `cluster._count`** — «↑4/hr» в алерте означало «4 видео в кластере», не плеев в час. Убрал переопределение — теперь velocity = индивидуальная плеев/час представителя (из `_normalize`).
5. **Cluster aggregate floor в конце убран** — был safety-net эпохи мягких individual-floor'ов, после ужесточения индивидуальных порогов стал redundant и активно мешал (поощрял суммирование в representative.metrics).

**Файлы**: `src/collectors/tiktok.js` (`_normalize` floor + `_clusterByHashtag`), `src/notifications/formatter.js` (TikTok plays-line), `src/analysis/prompts.js` (TikTok metrics block — отдельные строки для рэп-видео и hashtag-кластера, с пометкой что cluster describes "the WAVE, not any one user").

**Риски**: floor стал жёстче (видео с 200K плеев + средними лайками теперь могут не пройти, раньше ловились viralScore'ом). Это и есть желаемое поведение по запросу владельца, но если нарративов станет ощутимо меньше — снижать `playsBar/likesBar/sharesBar` через env override (сейчас захардкожены, при необходимости вынесу).

**Деплой**: TBD, владелец сделает через `deploy.ps1`.

---

## 2026-05-05 (TikTok: cleanup полей `sources.tiktok.enabled` + ответ про Сканеры-toggle)

Маленькая зачистка после удаления preset-gate'а:

- **Убрал поле `enabled` из schema** в `preset-config.js` (`PRESET_FIELD_RANGES.sources.tiktok`) — теперь admin UI «🎛️ Пресеты» больше не рендерит чекбокс «Enabled (DEPRECATED)» который ничего не делал.
- **Убрал `enabled: 0/1` из defaults каждого пресета** (general/animals/culture/celebrities/events) — поле больше не существует. Hashtag-листы остались как fallback-снимки на случай когда live-discovery упадёт.
- **Подтвердил пользователю**: тумблер TikTok в «⚙️ Сканеры → 📡 Площадки» работает корректно — он использует **глобальный** механизм `appState.disabledCollectors` (Set имён выключенных коллекторов, persist'ится в DB как setting `disabledCollectors`). В `index.js` scan-cycle перед каждым `collector.safeCollect()` идёт проверка `appState.disabledCollectors.has(...)` — если коллектор там, пропускается с info-логом «Skipped (disabled via admin panel)». Это правильное место чтобы выключить TikTok совсем.

**Итог**: один способ контроля TikTok'а — глобальный toggle в Сканеры → Площадки. Per-preset поля больше нет нигде. SESSION_CONTEXT уже отражает это (запись «TikTok cycle pacing» в предыдущей entry).

---

## 2026-05-05 (TikTok: убрал preset-gate + 30min cycle + 24 hashtags + fixed input schema)

После первого деплоя trending-discovery владелец заметил несколько вещей:
1. TikTok работал ТОЛЬКО при активном пресете culture (через `_isEnabledForActivePreset`) — это не подходит, TikTok должен работать всегда вне зависимости от выбранного пресета
2. TikTok бежит каждые 15 минут как остальные коллекторы — нужно реже, экономить Apify-кредиты
3. 60 хэштегов рандомно ротированных — слишком много для текущего объёма

**Финальные правки**:

1. **Убрал per-preset gate** в `tiktok.js`:
   - Удалён метод `_isEnabledForActivePreset()` целиком (был вызов в `collect()`)
   - Поле `sources.tiktok.enabled` в `preset-config.js` помечено DEPRECATED — оставлено в schema для forward-compat но collector его игнорирует
   - Управление вкл/выкл TikTok'а — только через env `TIKTOK_ENABLED`

2. **TikTok-специфичный cycle interval**:
   - Новый env `TIKTOK_CYCLE_INTERVAL_MINUTES=30` (default)
   - В `collect()` добавлена time-gate: skip если `Date.now() - _lastCollectAt < cycleIntervalMinutes`
   - Глобальный scan-cycle бежит 15 мин, TikTok-collector реагирует на каждый второй
   - First-run after restart всегда проходит (`_lastCollectAt=0` → ageMinutes очень большой)

3. **24 хэштега + 1 за цикл**:
   - `TIKTOK_TRENDS_TOP_N` default 60 → 24
   - `cycleSize` в `_pickHashtags` 2 → 1
   - Math: 30min cycle × 1 hashtag × 24 cycles = 12h = ровно один refresh-window. Каждый хэштег ищется один раз перед тем как новый refresh принесёт другой набор.

4. **Fixed input schema for clockworks/tiktok-trends-scraper** — первый запуск отдал `Apify 400 / TypeError: inputs.filter is not a function`. Запросил actor's input-schema через `/v2/acts/{id}/builds/default` и нашёл реальные имена полей:
   ```
   adsScrapeHashtags: true       (было `hashtags: true`)
   adsScrapeSounds:    false      (было `songs: false`)
   adsScrapeCreators:  false      (было `creators: false`)
   adsScrapeVideos:    false      (было `videos: false`)
   resultsPerPage:     N          (было `hashtagsLimit: N`)
   adsCountryCode:    'US'        (было `countryCode: 'US'`)
   adsTimeRange:      '7'         (новое — last 7 days)
   adsRankType:       'popular'   (новое — sort by view count)
   ```

**Итоговая стоимость**: 24 hashtags × $3/1K × 2/day = **~$4.32/мес** (было $10.80 при 60 hashtags). Apidojo (Stage B видео-сбор): был ~$50/мес, теперь ~$25/мес из-за 30min vs 15min cycle. Итого TikTok ~$30/мес вместо ~$60/мес — в 2× дешевле при сохранении качества (живые-trending hashtags, не captionный мусор).

**Apify approval note**: владелец перешёл по `https://console.apify.com/actors/sDvA9jM4WRTDX4Syr?approvePermissions=true` — диалог не появился. Это нормально: clockworks как издатель давно proven, его actor'ы не требуют explicit user-approval (в отличие от apidojo который более параноидальный). Если в будущем добавим actor от другого third-party publisher — снова может потребоваться.

**Деплой + проверка**: успешный first-cycle лог:
```
[TikTok] refreshed 24 trending hashtags from TikTok Creative Center (country=US, top=24)
[TikTok] Collected 5 items
```
End-to-end pipeline работает: clockworks-trends Stage A → cached 24 hashtags → apidojo Stage B → видео.

**Файлы**:
- `src/collectors/tiktok.js` — убран `_isEnabledForActivePreset`, добавлен `cycleIntervalMinutes` + `_lastCollectAt`, `cycleSize=1`, исправлена input-schema в `_fetchTrendingHashtags`
- `src/analysis/preset-config.js` — `sources.tiktok.enabled` помечен DEPRECATED
- `.env.example` — добавлен `TIKTOK_CYCLE_INTERVAL_MINUTES`, обновлены defaults для `TIKTOK_TRENDS_TOP_N`

---

## 2026-05-05 (TikTok: live-discovery hashtags через TikTok Creative Center)

Архитектурный shift по запросу владельца: «не имеет смысла искать УЖЕ известные нарративы которые мне даёт Grok — давай скрапить популярные хэштеги в самом TikTok'е, потом по ним искать видео». То есть pivot со static-list на live-discovery: TikTok сам публикует свой trending в Creative Center, мы оттуда читаем.

**Архитектура** (по образу X-Trends):
- **Stage A** (раз в 12h, env `TIKTOK_TRENDS_REFRESH_MINUTES=720`): TikTok-collector вызывает Apify-actor `clockworks~tiktok-trends-scraper` который зеркалит данные из `ads.tiktok.com/business/creativecenter`. Получаем top-60 хэштегов с rank/videoCount/viewCount/rankDiff/isPromoted (env `TIKTOK_TRENDS_TOP_N=60`). Фильтруем `isPromoted=false` (TikTok'овские ad placements) и `videoCount > 0`. Кэшируем в DB через `setSetting('tiktokTrendingHashtags', ...)` для restart-survival.
- **Stage B** (каждые 15 мин, обычный scan-цикл): collector читает trending-кэш через async `_getHashtags()`, ротирует 2 хэштега за цикл через `_pickHashtags()`. 60 хэштегов / 2 за цикл / 4 цикла в час = ~7.5 часов уникальных rotations прежде чем повторение.
- Hardcoded list в `preset-config.js culture.tiktok.hashtags` остаётся **fallback'ом** (если Apify call упал, используется этот список как safety net).

**Изменения**:
- `src/collectors/tiktok.js`:
  - Новые методы `_restoreCachedTrendingHashtags()` (constructor восстанавливает из DB), `_ensureTrendingHashtagsFresh()` (lazy-refresh при stale cache), `_fetchTrendingHashtags()` (Apify call к clockworks/tiktok-trends-scraper).
  - `_getHashtags()` стал async: priority customHashtags → trending cache → preset fallback → last-resort generic.
  - `_pickHashtags()` стал async, `collect()` await'ит его.
  - Trending state живёт на инстансе (`_trendingHashtags`, `_trendingFetchedAt`), persist'ится в DB после каждого успешного fetch.
- `src/collectors/tiktok.js` constants: добавлены `TRENDS_ACTOR_ID = 'clockworks~tiktok-trends-scraper'`, `TRENDS_TIMEOUT_SECS = 60`.
- `.env.example`: добавлена секция «TIKTOK TRENDING HASHTAG DISCOVERY» с тремя env-knobs.

**Env knobs** (defaults в коде):
- `TIKTOK_TRENDS_REFRESH_MINUTES=720` (12h)
- `TIKTOK_TRENDS_TOP_N=60`
- `TIKTOK_TRENDS_COUNTRY=US`

**Стоимость**: 60 hashtags × $3.00/1K × 2/day = **~$10.80/мес**. На X-Trends'овых $1.40/мес фоне выглядит дороже, но:
- TikTok-сцена меняется быстрее X (memes 24-48h life cycle vs X-trends 6-24h spread cycle)
- 60 хэштегов даёт диверсификацию, $10/мес vs ~$50/мес которые мы тратим на сам apidojo TikTok-actor — секонд-стейдж.

**PRICING TRAP** (важно для будущего): открытая страница actor'а на Apify показывает **$1.70/1K**, реальная цена в console (actor → "Pricing" tab) — **$3.00/1K**. Public-page sticker stale/wrong. Этот же trap возможно применяется к другим clockworks-actor'ам — всегда проверяй в console, не верь публичной странице.

**Деплой**: успешно. После старта в логи попадёт `[TikTok] refreshed N trending hashtags from TikTok Creative Center (country=US, top=60)` когда первый цикл активирует actor (только когда активный пресет = `culture` — на других пресетах TikTok отключён).

**Что мы получили**:
- TikTok-discovery теперь **самообновляющаяся**: список хэштегов следует за реальным TikTok-trending без manual refresh
- 60 хэштегов даёт **много вариативности** — не повторяемся за день
- 12h refresh достаточно частый чтобы ловить дневные spikes но не транжирить credits
- Hardcoded preset list = safety net, не главный источник

**Риски/заметки**:
- Может потребоваться one-time **Apify approval** для clockworks/tiktok-trends-scraper (как было с apidojo). Если первый запуск поймает 403 `full-permission-actor-not-approved` — apprоve через `https://console.apify.com/actors/sDvA9jM4WRTDX4Syr?approvePermissions=true`. После approve работает forever.
- Input-схема актора может слегка отличаться от моих guess (`hashtagsLimit`, `countryCode`, `hashtags: true`). Если actor 400-нёт по input validation — посмотрим в логе error message и подкрутим. Сейчас написал по common Apify-паттернам.
- Если clockworks/tiktok-trends-scraper когда-нибудь упадёт / устареет — preset fallback list гарантирует что TikTok-сборка не сломается. Coupling soft, не hard.

---

## 2026-05-05 (TikTok meme refresh + Stage 1 source-aware metric calibration)

### Часть 1: Replace culture-preset hashtags with named active memes

Владелец прогнал Grok web-search prompt и получил список из 14 КОНКРЕТНЫХ виральных мемов 2026 года вместо category-tags. Ключевая product-realization владельца: «эти теги — буквально сами нарративы, а не категории для их поиска» — что точно описывает разницу. На TikTok'е каждый именованный мем = свой хэштег, который ставят участники мема. Searching by named-meme hashtag = searching by meme participation = идеальный signal.

**Replaced** в `culture` пресете (preset-config.js):
```
storytime, relatablememes, genzmemes, comedytok, tiktokhumor, pranktok,
sketchcomedy, brainrotmemes, italianbrainrot, skit, relatable, genztrends
```
**на**:
```
ohokbecause, rahskeleton, rememberwhoyouare, dontleavemedry,
homerdroppedhisdonut, blueshirtkid, areyoucomingtothetree,
ijusthitthejackpot, theworstthingshecansayisno, bigarch, goofinator,
aimyguy, followthattune, everythinghallelujah
```

Каждый — конкретный sound-driven / catchphrase / character / format-mem с миллионами просмотров на TikTok'е в апреле 2026. Отказался от category-tags (storytime/relatable/comedytok) полностью — они привлекают compilation-контент.

**Maintenance note**: meme-теги имеют ~3-7 day lifecycle. Этот список **нужно обновлять ~раз в 1-2 недели** — иначе хэштеги начинают surface'ить «remember when X was a thing» compilation-контент. Grok prompt сохранён в комментариях `preset-config.js culture.tiktok.hashtags`. Когда станет частым refresh-ритуалом — автоматизируем (свой meme-discovery loop а-ля X-Trends, раз в день дёргает Grok за свежими названиями, обновляет DB-override).

### Часть 2: Source-aware metric calibration в Stage 1

Stage 1 LLM раньше смотрел на `views/likes/plays/upvotes` одинаково across sources. Это вранье: 3M plays на TikTok ≈ 300-600K views на Twitter в реальной cultural reach (TikTok plays накручиваются автореплеями + scroll-impressions). Twitter-thread живёт 5-7 дней, TikTok-мем умирает за 24-48h. Разные сигналы, одинаково LLM не может судить.

**Добавил в `SYSTEM_PROMPT`** (`prompts.js`) новую секцию `━━━ SOURCE-AWARE METRIC CALIBRATION ━━━` с конкретными rule'ами:
- TikTok plays inflated ~5-10× (3M plays ≈ 300-600K Twitter views)
- TikTok shares — strongest virality signal (5K+ = peer-to-peer спред в DM'ы)
- TikTok memes burn out за 24-48h, Twitter — 5-7 дней, Reddit — 1-2 недели → freshness scoring per-source
- TikTok meme spread FORMAT-driven (sound + setup + punchline structure), не контент-driven — оценивай format adoption, не оригинального автора
- Reddit upvotes vote-democratized → 10K upvotes ≈ 100K+ readers (большинство не голосует)
- Google Trends лагает Twitter на 6-24h, поэтому свежий google spike часто = подтверждение что Twitter trend пошёл в mainstream

LLM теперь будет правильно калибровать: TikTok с 1M plays больше не получит 95+ только за raw число; Twitter тред с 50K likes получит больше bonus за тот же engagement-impact.

### Деплой
Один deploy. Стейдж 1 для следующего цикла увидит новый prompt. Хэштеги активируются когда переключим preset на `culture` в админке.

### Риски/заметки
- Список из 14 мемов **зашит в код** через `preset-config.js` defaults. Если владелец захочет refresh без re-deploy — можно делать через админку «🎛️ Пресеты → culture → TikTok hashtags» (chip-input UI уже есть).
- Stage 1 prompt разросся (~50 строк калибровки добавилось). Это +200-300 input-токенов на каждый Stage 1 batch call. На 96 циклах/день × ~30 трендов/цикл = пренебрежимо для бюджета, но надо помнить если будем оптимизировать prompt size.
- **Не сделали** TikTok-specific прогноз lifespan и meme-template extraction в nano — отложено до момента когда первые два шага покажут потолок (см. предыдущие записи).

---

## 2026-05-05 (TikTok: только для мемов + compilation regex filter)

После поднятия порогов владелец увидел что TikTok всё ещё ловит много мусора — категорийные подборки животных, мемов, дайджесты «top 10 funny dogs» и т.д. Проблема фундаментальная: хэштег-поиск на TikTok ищет КАТЕГОРИИ, не НАРРАТИВЫ. `#funnydogs` это reach-tag, его ставят на любое смешное видео с собакой; нет способа отличить «вот сейчас вирусный момент с собакой» от «очередной CompilationBros вкинул сборник 2026».

**Решение в три шага** (выбрано из обсуждения с владельцем — он отверг переписывание хэштегов и cross-source narrative gate как «мультиплатформенность не работает»):

1. **Compilation regex в `tiktok.js _normalize`** — отбрасывает видео с типичными маркерами подборки в caption'е:
   ```
   compilation, funniest, funny moments, cute moments, best of, 
   top \d+, \d+ minutes/seconds of, weekly best, of the week, 
   highlights of, memes #\d+, #\d+ в конце title
   ```
   Высокая precision, низкий recall — лучше пропустить пару подборок чем дропнуть legit narrative с фразой «top scorer» в названии. Дропает сразу после engagement-bar проверки, до всех expensive enrichment'ов.

2. **TikTok = только для мемов** — добавил `enabled` поле в `sources.tiktok` schema (mirror'ит существующий pattern `sources.xtrends.enabled`). По дефолту TikTok включён ТОЛЬКО в `culture` пресете (мемы — единственная тематика где TikTok-нарративы органически возникают через format propagation, sound trends, brainrot virality). В general/animals/celebrities/events — `enabled=0`. Хэштеги в выключенных пресетах оставлены as-is для forward-compat (если владелец вернёт через админку).

3. **Коллектор `collect()` rано выходит** если `_isEnabledForActivePreset()=false` с info-логом `[TikTok] disabled for active preset (sources.tiktok.enabled=0) — skipping cycle`. Никаких Apify-вызовов на выключенных пресетах.

**Изменённые файлы**:
- `src/collectors/tiktok.js` — `COMPILATION_RE`, `_isEnabledForActivePreset()`, ранний return в `collect()`
- `src/analysis/preset-config.js` — `tiktok.enabled` schema field, defaults across 5 пресетов

**Деплой + проверка**: первый цикл после деплоя — `[TikTok] disabled for active preset (sources.tiktok.enabled=0)` (текущий activePreset=general). Когда владелец переключит активный пресет на `culture` — TikTok снова заработает с meme-хэштегами + compilation filter'ом.

**Эффект**:
- На 4-х из 5 пресетов TikTok отключён — нулевой Apify-расход на TikTok пока активный пресет ≠ culture
- На culture — пройдут только non-compilation видео по meme-хэштегам (regex отрезает ~30-40% подборок)
- В сумме TikTok-доля в feed резко упадёт — но качество того что осталось будет выше (видео с реальным narrative arc)

**Замечание про 30% feed share**: ранее была глобальная задача о распределении 30/30/30/10/10. После этого изменения TikTok будет давать ~30% feed только когда активный пресет = `culture`. На остальных пресетах TikTok-доля будет 0%. Это **сознательный trade-off** — лучше 0% качественного TikTok чем 30% мусорных подборок.

**Что НЕ сделали** (из обсуждения):
- Не переписывали хэштеги на event-driven (`viralmoment`, `caughtoncamera` и т.д.) — владелец предпочёл оставить текущие meme-хэштеги в culture как есть
- Не сделали cross-source narrative gate (TikTok entity ∩ Twitter/Reddit entities) — owner deemed «multi-source mostly broken»
- Не реализовали entity-driven TikTok search (как X-Trends) — это уровень 3, отложено до момента когда уровень 1 покажет потолок

---

## 2026-05-05 (TikTok pipeline-аудит: пороги ↑10×, новые хэштеги, audio-URL filter)

С момента запуска проекта TikTok-настройки никто глубоко не пересматривал — тренды шли через копеечные пороги (50K plays / 1K likes / 200 shares / 40 viralScore = OR), и через generic-теги (`fyp/viral/trending` буквально весь TikTok). Владелец попросил пройтись и поднять пороги + взять свежие 2026-хэштеги через web-search Grok'а.

**Новый floor в `tiktok.js _normalize` + `_clusterByHashtag`** (OR-логика, как в Twitter):
- `plays ≥ 500 000`
- ИЛИ `likes ≥ 20 000`
- ИЛИ `shares ≥ 5 000`
- ИЛИ `viralScore ≥ 60` (composite, ловит influencer-посты)

Все volume-метрики (plays/likes/shares) скейлятся по CJK ×2 (ja/ko) или ×4 (zh). viralScore additive +10/+20. Все 4 порога подняты в ~10× от прежних значений (50K plays / 1K likes / 200 shares / 40 viralScore).

**Новые хэштеги** (per-preset, через 2026 web-search Grok'а):
- **animals**: `animalsoftiktok, petsoftiktok, funnydogs, funnycats, exoticpets, babyanimals, blackcatsoftiktok, catsoftiktok, doglovers, animalvideos, farmanimals, animalkingdom, puppylove, bunny, fosteringsaveslives` (15)
- **culture**: `storytime, relatablememes, genzmemes, comedytok, tiktokhumor, pranktok, sketchcomedy, brainrotmemes, italianbrainrot, skit, relatable, genztrends` (12) — убраны generic `viral/fyp/trending`, добавлены формат-теги (storytime/comedytok/sketch) и текущий сленг (italianbrainrot — спайк late 2025 / early 2026)
- **celebrities**: `kpopfyp, kpopdance, kpopedit, kpopstan, kpopfandom, fandomdrama, celebdrama, hollywooddrama, kpopnews, kpopidol, viraledit, kdrama` (12) — сильный сдвиг в K-pop экосистему (Grok сказал: kpopfyp/kpopdance/kpopedit доминируют 2026)
- **events**: `weathertok, tornadotok, stormchasing, aitechnology, technews, sportshighlights, championsleague, nbaplayoffs, ucl, spaceexploration, sciencefacts, breakingweather` (12) — погодный TikTok сильно поднялся 2025-2026 (weathertok + stormchasing), плюс post-LLM news (aitechnology/technews)
- **general**: `animalsoftiktok, petsoftiktok, funnydogs, storytime, relatablememes, brainrotmemes, kpopfyp, fandomdrama, celebdrama, weathertok, stormchasing, aitechnology` (12) — куратированный микс по 3 из каждой темы

**Audio-URL filter** в `tiktok.js _firstNonAudioUrl` + url-resolver.js: первый цикл после деплоя выявил что для ~3/13 видео apidojo прокидывает не video-URL а music-track URL (`*-music*.tiktokcdn.com/*.mp3`) в fallback-полях. Mime-sniff guard в gemini-captioner это ловил постфактум (download впустую → buffer signature ID3 → отказ). Добавил early skip по regex (`/\/ies-music|-music[-.]|\.mp3(\?|$)/`) — теперь fallback chain пропускает audio-URL'ы и идёт на следующий кандидат, либо null → poster.

**Деплой + первый цикл (с поднятыми порогами)**: TikTok собрал 13 items (vs 18-21 до), 8 из них успешно прокаптионены video в Gemini, остальные через постер. Volume стал ниже но качество значительно выше — все titles реально из тематических хэштегов (`#funnydogs #goldenretriever`, `#storytime #truestory`, `#funnydogs #dogcompilation`).

**Глобальная задача (на потом)**: владелец хочет распределение feed'а ~30/30/30/10/10 (Reddit / Twitter / TikTok / X Trends / Google Trends). Сейчас распределение возникает естественно из объёмов сборки и качества — после поднятия порогов TikTok может стать недопредставлен. Если в течение нескольких дней реальная доля TikTok будет <20%, нужно будет добавить explicit per-source quota в `dashboard/server.js` `/api/trends` (взвешенный SELECT с лимитом per-source) ИЛИ снизить пороги. Решение по данным после ~24-48h наблюдения.

**Риски/заметки**:
- Новые хэштеги ещё не «обкатаны», некоторые (italianbrainrot, kpopstan) могут оказаться нишевыми. Если через сутки видим что они не дают трендов — заменим. Старые `viral/fyp/trending` оставлены ТОЛЬКО в дефолтах если кто-то восстановит из админки.
- Cluster aggregator floor подкручен симметрично: если хэштег набрал >1 видео, их `sum(plays/likes/shares)` тоже должны пройти OR-floor. Это не отрезает trend'ы где одно сильное видео тянет — это только для ситуации когда никакое из видео в кластере не сильное по отдельности.

---

## 2026-05-05 (Stage 0: ffmpeg-trim длинных видео для всех источников)

**Контекст**: владелец заметил несоответствие между поведением и промптом. Промпт Gemini'а уже говорит «focus on FIRST 30 SECONDS only», но в коде была `if (duration > 30s) → throw away video, use poster`. Получалось что ~30% TikTok-роликов (которые длиннее 30s) теряли video-сигнал и шли через постер. Промпт намекал на трим, но реализован он не был.

**Что сделал** (применимо к ВСЕМ источникам видео — Twitter / Reddit / TikTok / X Trends / manual analysis):

- **`src/analysis/gemini-captioner.js` `_trimVideoToBuffer(url, maxSec)`** — новый helper, использует `ffmpeg -c copy` (stream copy, без re-encode) чтобы вырезать первые `maxSec` секунд в tmp-файл, читает обратно как Buffer, затем удаляет tmp. Стоимость: 50-300ms на ролик, 0% CPU-перерасхода (нет декодирования/кодирования). Adds `-user_agent` + `-referer` (для TikTok-CDN) автоматически.
- **`_tryGoogleMedia`** расширен опциональным `prefetched` параметром — когда передаём готовый Buffer, метод skip'ает HEAD+download и идёт сразу к sniff+send. Это позволило переиспользовать всю валидацию + Google API call для trimmed-видео, без дублирования кода.
- **`captionTrend` `tooLong` ветка** теперь сначала пытается ffmpeg-trim → если получили валидный buffer → шлём в Gemini как обычное короткое видео. Постер используется ТОЛЬКО если trim упал (network / codec mismatch / corrupt source) ИЛИ Google вернул ошибку.
- Новый флаг `videoClipped: true` в результате (отличается от `videoTruncated`). Когда trim удался — `mediaType='video'`, `videoTruncated=false`, `videoClipped=true`. Когда упал на постер — `mediaType='image'`, `videoTruncated=true` (старое поведение).
- **Admin UI**: badge в Gemini-карточке Stage 0 показывает «обрезано до первых 30s» когда `videoClipped=true`, или «видео > 30s, использован poster» когда упал на постер. Отдельные states видны явно.

**Деплой + проверка**: первый scan-cycle после правки на TikTok'ах: 21 item → 12 успешных video-caption (включая `[GeminiCaptioner] video 38.8s > 30s, trimming to first 30s` → `google video caption in 3504ms (0.56MB)` — 38s ролик был обрезан, попал в Gemini, прокаптионен). Постер-fallback больше не используется для длинных TikTok'ов.

**Риски/заметки**:
- ffmpeg `-c copy` требует чтобы первый keyframe был в начале потока. Для TikTok mp4 / Twitter mp4 / Reddit mp4 это всегда так. Если попадётся источник с keyframe не в начале — может получиться fragment с pre-roll до первого keyframe. Gemini это переживает (он смотрит видео с начала).
- `-movflags +faststart` требует двух проходов (write packets, then move moov atom to start). На tmp-файле это работает, на pipe — нет. Поэтому tmp-file подход.
- Стоимость в Gemini-токенах увеличивается: длинные видео раньше шли как один image-frame (~700 input tokens), теперь как 30s native video (~5K-10K input tokens). На батч в 16 трендов прирост ~50K input tokens = ~$0.0025 (gemini-2.5-flash $0.075/1M). Пренебрежимо.
- Tmp-файлы пишутся в `os.tmpdir()` (`/tmp` в docker), удаляются после чтения. Если контейнер крашится во время trim — orphan-файлы могут накопиться, но `/tmp` чистится при рестарте.
- Если ffmpeg отсутствует (на хост-системе вне docker'а где `RUN apk add ffmpeg`) — trim тихо падает, fallback на постер. Никогда не throw'ится.

---

## 2026-05-05 (TikTok: apidojo schema mapping fix — реальная схема ≠ research)

После approve apidojo и fallback'а на `APIFY_API` владелец продолжал получать `Gemini (image)` (или вообще без Gemini-секции, `gemini=0/1`). Подсказка от владельца «была такая ошибка с Twitter, но проблема была у нас» оказалась золотой — bug был в нормализаторе.

**Проблема**: Я писал mapper на основе research-агента, а тот выдал устаревшую/неточную информацию. Реальная схема apidojo (проверена `curl`'ом по живому actor'у):

```
{ id, title (caption + hashtags), views, likes, comments, shares,
  channel: { username, followers, ... },
  uploadedAt (UNIX seconds),
  video: { url (CDN mp4, ~6h TTL), cover, thumbnail, duration, ... },
  hashtags: ["bare","strings","without","#"] }
```

Мой код искал `playCount` / `diggCount` / `commentCount` / `shareCount` (это clockworks-style), `authorMeta.name` / `authorUsername` (тоже не apidojo), `originCoverUrl` / `videoUrlNoWaterMark` (нет таких полей). Поэтому:
- `videoUrl = null` (искал на топ-уровне, реально лежит в `video.url`)
- `thumbnailUrl = null` (искал на топ-уровне, реально в `video.cover` / `video.thumbnail`)
- engagement = 0 (искал `*Count`-варианты, реально голые `views/likes/comments/shares`)

→ Gemini-captioner раннее выходил на `if (!isVideo && !posterUrl) return null` (тихо, без ошибок в логах).

**Что починил**:
- **`src/collectors/tiktok.js` `_normalize`** — расширил все fallback цепочки реальными apidojo-полями (`video.likes`, `video.comments`, `video.shares`, `channel.username`, `channel.followers`, `video.video?.url`, `video.video?.cover/thumbnail`, `video.uploadedAt`, `video.title` для caption). Cyle collector теперь даёт scorer'у `videoUrl` + `thumbnailUrl` + полный engagement.
- **`src/analysis/url-resolver.js` `_resolveTiktokViaApidojo`** — те же правки в manual-analysis path. Теперь все 3 surfaces ручного анализа (admin/dashboard/TG) получают видео в Gemini.

**Деплой + проверка**: первый scan-cycle после правки — `[PreStage] 16 trends in 20951ms (nano=16/16, gemini=11/16)`, 11 TikTok-видео нативно прокаптионены через Gemini (`google video caption in 4524ms (0.69MB)` и подобные). 5 видео упали на постер из-за `STAGE0_VIDEO_MAX_SEC=30` cap'а — нормальное поведение для роликов >30s.

**Урок**: при добавлении нового Apify-actor'а ВСЕГДА сначала вызывать его руками и логировать первый item, чтобы увидеть точную схему. Research-агенты дают приближённую картину, реальные поля могут отличаться. Теперь в `tiktok.js` для apidojo комментарий с реальной схемой — будущий refactorer не наступит на те же грабли.

---

## 2026-05-05 (TikTok: apidojo full-permission approve + url-resolver fallback на APIFY_API)

После предыдущего деплоя apidojo cycle-collector начал получать 403 `full-permission-actor-not-approved` от Apify. Третий-party actor (`apidojo/tiktok-scraper`) требует **одноразового approve** в Apify Console — security-фича Apify, актёр получает full-account-access и должен быть явно разрешён.

**Что сделал**:

- **Просил владельца**: открыть `https://console.apify.com/actors/<actorId>?approvePermissions=true` и нажать «Approve permissions». После этого 403 пропал в течение секунд (без рестарта). Это **навсегда per Apify-аккаунт** — больше не понадобится.
- **`src/analysis/url-resolver.js`** `resolveTiktokUrl`: расширил token-fallback для apidojo Apify-вызова. Раньше требовал именно `APIFY_API_APIDOJO`, теперь fallback chain: `APIFY_API_APIDOJO || APIFY_API`. Это match'ит логику коллектора (`tiktok.js _activeActor`), где один общий ключ `APIFY_API` работает для всех актёров если у юзера один Apify-аккаунт. До фикса ручной анализ TikTok всегда сваливался на oEmbed (без видео в Gemini), даже если cycle-collector использовал apidojo нормально.

**Деплой**: `deploy.ps1`. После рестарта первый scan-cycle: `[TikTok] Collected 2 items`, никаких 403, в том же цикле Gemini успешно прокаптионил video caption 8.96MB нативно через `gemini-2.5-flash`.

**Ловушка для будущих third-party Apify-актёров**: некоторые actor'ы (особенно с `full-permission-actor-not-approved` в манифесте) требуют ручного approve в Apify Console. Симптом — 403 со специфичным error type'ом + `approvalUrl` в payload. Деплоить новые actor'ы в продакшен — сначала жмём approval URL для всех Apify-аккаунтов, чьи токены поедут в `.env`.

---

## 2026-05-05 (TikTok: ручной анализ теперь идёт через apidojo, не oEmbed)

**Контекст**: после деплоя Referer-фикса владелец прислал скриншоты — оба ручных анализа TikTok-ссылок показали `Gemini (image)` вместо video. Причина оказалась не в Gemini-captioner и не в коллекторе: `resolveTiktokUrl()` (используемый всеми тремя surfaces ручного анализа — админка, дашборд, TG-бот) ходит через **TikTok oEmbed API**, который возвращает только title + автора + thumbnail. Ни engagement, ни videoUrl. Поэтому переключение `tiktokActor` в админке (между clockworks/apidojo) на ручной анализ не влияет — он actorless.

**Что сделал**: расширил `resolveTiktokUrl(url)` в `src/analysis/url-resolver.js` двумя tier'ами:

1. **Primary (apidojo)**: если `process.env.APIFY_API_APIDOJO` установлен — вызываю apidojo Apify-актёр напрямую с `startUrls: [{url}]`, `maxItems: 1`. Получаю полный payload с engagement (plays/likes/comments/shares/followers) + `videoUrlNoWaterMark/videoUrl`. Нормализую той же fallback-цепочкой что и `tiktok.js _normalize` (DRY-shape с pipeline-collector'ом). Стоимость одного manual-анализа ~$0.0003.

2. **Fallback (oEmbed)**: если apidojo-токен отсутствует ИЛИ actor падает (network/timeout/empty result) — soft-fallback на старый oEmbed-путь. Бесплатно, только title+thumb (текущее поведение). Manual analysis никогда не hard-fail'ит из-за apidojo.

Все три surfaces (admin SubmitPage, dashboard AnalyzePanel, TG `/analyze` + URL-paste) идут через `runManualAnalysis()` → `resolveUrlToTrend()` → `resolveTiktokUrl()` — поэтому фикс одновременно покрывает все три точки входа без отдельных правок.

**Активация**: владельцу нужно положить `APIFY_API_APIDOJO=...` в `/opt/catalyst/.env` на проде + рестартануть контейнер. Сейчас ключа нет — manual analysis продолжает идти через oEmbed (graceful fallback).

**Риски/заметки**:
- apidojo считает manual-анализ как 1 item ($0.30/1K), это $0.0003 на запрос — пренебрежимо. Cross-user 1h cache в `manual-analysis.js` дополнительно режет дубли.
- Если apidojo вернёт не TikTok-видео а похожий пост (например ad/livestream), поля могут быть пустыми — fallback работает корректно (return null → catch → oEmbed).
- `videoUrlNoWaterMark` может отсутствовать у некоторых видео; используется обычный `videoUrl` с вотермаркой — Gemini-captioner всё равно нормально читает.

---
## 2026-05-05 (TikTok: видео apidojo доезжают до Gemini нативно — fix Referer)

**Контекст**: после первой итерации с apidojo владелец заметил что я в WORKLOG написал «видео не идёт в Gemini ни у одного актёра» и захотел чтобы оно ехало нативно — ровно как для Twitter. Вернулся, разобрался глубже.

**Что было неправильно сказано раньше**: я утверждал что apidojo `videoUrl` «header-bound и истекает». Реальность мягче — TikTok CDN (`tiktokv.com` / `tiktokcdn.com` / `tiktokcdn-us.com`) гейтит по заголовку `Referer: https://www.tiktok.com/`. Без него возвращает 403, с ним работает несколько часов до истечения сигнатуры в URL — этого вагон с запасом для нашего pipeline (Stage 0 запускается через секунды после scrape).

**Что сделано**:

- **`src/collectors/tiktok.js` `_normalize`** — пробрасываю `videoUrl` в `metrics.videoUrl` с per-actor fallback chain:
  - apidojo: `videoUrlNoWaterMark` (preferred — без вотермарка лучше для Gemini visual-понимания) → `videoUrl` → `mediaUrls[0]`
  - clockworks: `videoMeta.downloadAddr` → `videoMeta.playAddr` (только если включить `shouldDownloadVideos: true` — мы оставляем выключенным для экономии, поэтому для clockworks обычно null, fallback на постер как раньше)
  - Никакого actor-аware switch'а в коде — простая широкая цепочка покрывает оба
- **`src/analysis/gemini-captioner.js` `_tryGoogleMedia`** — для TikTok-CDN URL добавляю `Referer: https://www.tiktok.com/` к HEAD/GET запросам. Determined через `_isTikTokMediaUrl(url)` regex (узнаёт `tiktok.com`/`tiktokcdn.com`/`tiktokcdn-us.com`/`tiktokv.com`).
- **`src/analysis/gemini-captioner.js` `_probeVideoDuration`** — добавил ffprobe-флаги `-user_agent` + `-referer` (последний только для TikTok URL'ов). Без этого ffprobe возвращал бы code 1 на TikTok-видео и captioner думал бы что у видео нет длительности — fall through на постер без явного reason'а.

**Деплой + проверка**: docker rebuild → up. В первом цикле после деплоя `Stage 0` успешно вызвал ffprobe на нескольких видео (видны логи `video 30.9s > 30s cap, using poster`, `60.0s > 30s cap`, `169.0s > 30s cap` — длительность правильно читается). Twitter-видео (1.94MB, 5.24MB) нативно ушли в Gemini как раньше. TikTok-видео ещё не появились в логах потому что для них нужен apidojo-актёр с APIFY_API_APIDOJO токеном — переключатель готов, ждёт активации.

**Чтобы получить TikTok-видео в Gemini**: положить `APIFY_API_APIDOJO=...` в `/opt/catalyst/.env`, рестартануть контейнер, в админке `⚙️ Сканеры` → «🎵 TikTok scraper» → клик `apidojo`. Со следующего цикла TikTok-видео начнут идти в Gemini нативно (как Twitter) — короткие до `STAGE0_VIDEO_MAX_SEC` целиком, длинные через постер.

**Риски/заметки**:
- Сигнатуры в TikTok video URL'ах истекают через ~6h. Если когда-нибудь захотим re-process TikTok-видео старше 6h (например для hot-refresh) — будет 403, нужен будет re-fetch URL через свежий scrape. Сейчас не проблема, Stage 0 идёт сразу за collect.
- `videoUrlNoWaterMark` в apidojo может отсутствовать для некоторых видео — fallback на `videoUrl` (с вотермарком) корректный, Gemini читает обе версии нормально.
- Если TikTok сменит CDN-домен (например на `tiktokcdn-eu.com`) — regex в `_isTikTokMediaUrl` нужно будет расширить. Сейчас покрыты все известные варианты по состоянию 2026-05.
- На clockworks ничего не меняется: `videoUrl` не выставляется (потому что `shouldDownloadVideos: false`), Gemini fall through на постер как раньше — обратной совместимости 100%.

---

## 2026-05-05 (TikTok: второй скраппер apidojo как альтернатива clockworks)

Владелец нашёл альтернативный TikTok-скраппер `apidojo/tiktok-scraper` ($0.30/1K vs $2/1K у clockworks — в ~6× дешевле) и попросил сделать переключение между двумя актёрами по аналогии с Twitter (kaitoeasyapi/xquik). Дефолт остаётся clockworks — apidojo опционален.

**Контекст «видео как ссылка»**: владелец предупредил что apidojo не отдаёт видео-файлы напрямую, только ссылки. После research'а оказалось что apidojo возвращает поле `videoUrl`, но оно header/cookie-bound и истекает — для прямого скачивания не годится. **Для нашего пайплайна это не проблема**: TikTok-коллектор и так никогда не использовал прямой `videoUrl` (в отличие от Twitter), мы всегда работали через `thumbnailUrl` (cover) + `webVideoUrl` (страница поста). Stage 0 Gemini-captioner для TikTok использует постер, не video. Так что переключение на apidojo не меняет user-visible поведение.

**Изменения**:

- **`src/collectors/tiktok.js`** — рефакторинг по образу `twitter.js`:
  - Вынес жёсткий `ACTOR_ID` в `ACTORS` registry с двумя ключами (clockworks/apidojo), каждый со своим `id` + `buildInput(hashtag, maxItems)`.
  - clockworks: `{ hashtags: [tag], resultsPerPage }` (нативный hashtag-вход).
  - apidojo: `{ startUrls: [{ url: 'https://www.tiktok.com/tag/<tag>' }], maxItems, sortType: 'RELEVANCE' }` (apidojo не принимает `hashtags` массив).
  - `_activeActor()` читает DB-setting `tiktokActor` (default `clockworks`), выбирает actor + token.
  - Constructor читает `config.apify.tiktokKeys` per-actor (а не одиночный `apify.apiKey`).
  - `_normalize` — расширил fallback-цепочки: `author` ← `authorUsername` (apidojo); `followers` ← `authorMeta.followers/followerCount` (apidojo); `thumbnailUrl` ← `imageUrl` или `covers.default/origin` (apidojo может отдавать covers как объект).
  - `_pickHashtags` — заменил `_keyIndex` (который был артефактом старой rotation-логики через ключи) на отдельный `_cycleCounter` как в `twitter.js`.

- **`src/config.js`**:
  - Добавил `apify.tiktokKeys = { clockworks: APIFY_API_CLOCKWORKS || APIFY_API, apidojo: APIFY_API_APIDOJO }`. Generic `APIFY_API` остаётся back-compat — кто не успеет перетащить на per-actor key, продолжает работать.
  - Соответственно подкрутил warning: `TIKTOK_ENABLED=true && no key in tiktokKeys` (раньше проверяло только `apify.apiKey`).

- **`src/admin/server.js`**:
  - В `_scannerConfig`: добавил `merged.tiktokActor = (db.getSetting('tiktokActor', 'clockworks') || 'clockworks').toLowerCase()`.
  - В `_setScannerConfig`: добавил `VALID_TIKTOK_ACTORS = new Set(['clockworks', 'apidojo'])` + соответствующую валидацию.
  - В `ScannerConfigSection`: добавил массив `TIKTOK_ACTORS` (clockworks ⏱️ $2/1K · apidojo 🥷 $0.30/1K) + UI-блок «🎵 TikTok scraper» сразу после блока «🐦 Twitter/X scraper» — те же `scfg-preset-grid` карточки, тот же UX.

**Деплой**: `deploy.ps1` → docker rebuild → up. В первом цикле после деплоя — `[TikTok] Collected 19 items` через clockworks (дефолт), никаких ошибок. Переключатель в админке готов, остаётся положить `APIFY_API_APIDOJO` в `.env` на проде когда владелец захочет переключиться.

**Чтобы переключиться на apidojo**:
1. Добавить токен в `/opt/catalyst/.env` на сервере: `APIFY_API_APIDOJO=apify_api_xxx`.
2. Рестартануть контейнер (`docker compose restart catalyst`).
3. В админке `⚙️ Сканеры` → `🎯 Конфиг сканера` → секция «🎵 TikTok scraper» → клик `apidojo`.

**Риски/заметки**:
- apidojo использует `startUrls` вместо `hashtags` — синтаксис `https://www.tiktok.com/tag/<encodedTag>`. Если TikTok сменит URL-схему страницы тега, apidojo сломается раньше clockworks (у которого нативный hashtag-вход). Lock-in на URL-pattern.
- apidojo может вернуть кириллические/японские теги в URL некорректно если encoding'а нет — поэтому `encodeURIComponent(hashtag)` обязателен.
- `videoUrl` поле у apidojo есть, но бесполезно — header-bound. Если когда-нибудь захотим прямое видео для TikTok (Gemini native video processing), нужно будет либо качать в момент scrape'а, либо парсить страницу для CDN-URL. Сейчас не нужно.

---

## 2026-05-05 (Admin: Сканеры таб → accordion-стиль как Пресеты)

Владелец просил сделать вкладку «⚙️ Сканеры» компактнее, со сворачиваемыми секциями — как уже сделано в табе «🎛️ Пресеты». Чисто косметика, никакого behaviour-change.

**Что сделал**: каждая большая секция в `ScannersPage` теперь обёрнута в `<details className="pcfg-accordion">` с заголовком в `<summary>` и подзаголовком справа. Используется готовая CSS из preset-config'а (pcfg-accordion / pcfg-accordion-summary / pcfg-accordion-body) — никаких новых стилей.

**Дефолты `open`** подобраны по частоте использования:
- 📡 Площадки — open (главное место для toggle коллекторов)
- 🎯 Конфиг сканера — open (preset picker, twitter actor, Stage 2 cap — самое часто-крутимое)
- 🎨 PreStage — closed (A/B kill-switch для nano)
- 🔁 Обновление горячих трендов — closed (status + trigger)
- 📊 Junk-filter наблюдение — closed (read-only stats)

**Сверху над accordion'ами осталось видимым**:
- 3 stat-cards (статус пайплайна / включенных / отключенных источников)
- Scanner-status-bar с кнопками «Сканировать сейчас» + «Запустить/Остановить»

**Внутренний рефакторинг**: 4 секционных компонента (`ScannerConfigSection`, `PreStageSection`, `HotRefreshSection`, `JunkStatsSection`) сменили свою корневую обёртку с `adm-card` + `<h3>` на просто `<div>` — заголовок теперь в accordion `<summary>`, padding даёт `pcfg-accordion-body`. Иначе бы получилось двойное отступление.

**SPA-trap страйк #N**: backtick'и в комментариях inside template literal SPA. Поймал привычно — `node scripts/check-admin-spa.cjs`. Пришлось переформулировать комментарий без markdown-cтиля backticks.

### Файл
- `src/admin/server.js` — `ScannersPage` render, `ScannerConfigSection` / `PreStageSection` / `HotRefreshSection` / `JunkStatsSection` корневые обёртки.

---

## 2026-05-05 (General preset: curated mix instead of firehose)

Жалоба владельца: «На Animal пресете находит ровно что нужно, а на General — абсолютный мусор». Корень — General использовал **broad firehose** стратегию:
- Reddit: `r/all` + `r/popular` (uncurated, 30M+ posts/day)
- Twitter: word-soup queries `(a OR the OR is OR to OR in) min_faves:10000` — пропускает любой viral твит независимо от темы
- TikTok: generic `fyp viral trending foryou foryoupage` — это ВСЯ платформа

Это работало плохо потому что качественный сигнал тонул в массе мемов про random топики. Тематические пресеты лучше работают именно потому что у них pre-filtered входы.

**Решение** (от владельца): «взять из всех пресетов по ровну». Делать только General, остальные не трогать.

**Новый General sources** — куратированный микс 2-3 элементов из каждой темы:

| Slot | Reddit | Twitter | TikTok |
|---|---|---|---|
| animals | aww, NatureIsFuckingLit | dog/cat/pet net | cuteanimals, funnyanimals |
| culture | memes, dankmemes, Unexpected | meme/viral/trend + 2026-slang (skibidi/delulu/rizz/aura/brainrot) | meme, viral, brainrot |
| celebrities | popculturechat, movies | movie/film/album/celebrity | celebnews, popculture |
| events | worldnews, nottheonion | breaking news + AI/ChatGPT | news, breakingnews, tech |
| universal | Damnthatsinteresting, nextfuckinglevel (awe-content, no theme fit) | — | — |

Итого: **11 subreddits**, **6 twitter queries**, **10 tiktok hashtags**.

**Пороги/веса не трогал** — junk/alerts/cluster params в General уже примерно среднее по 4 темам, дополнительная балансировка не нужна. Если станет шумно — крутить через админку Пресеты.

**`minUpvotes` для Reddit** опущен 10000 → **5000**. Старая планка работала на firehose (`r/all` отдаёт пост с 100К+ upvotes как обычное явление). Новые themed-subs в среднем меньше — 5K даёт нормальный приток без mute.

**Migration**: проверил БД на проде через `SELECT value FROM settings WHERE key='presetConfigs'` — у владельца в General были overrides только в `alerts.weights` и `minScoreToSave`, sources не трогали. Новые defaults применяются автоматически (deep-merge).

**Первый цикл после деплоя**: Reddit 44 items (норм), Twitter 1 item (низко — ожидаемо, collector берёт 2 из 6 queries per cycle, по rotation за час разнообразие выровняется), TikTok отключен в админке.

### Файлы
- `src/analysis/preset-config.js` — `DEFAULT_PRESET_CONFIGS.general.sources` полностью переписан. Reddit subreddits / Twitter queries / TikTok hashtags заменены на curated mix. minUpvotes 10000 → 5000.

### Риски / заметки
- Если в будущем кто-то вернётся к firehose-стратегии — нужно явно вернуть `r/all`+`r/popular` и word-soup queries. Сейчас General **намеренно** не пытается покрыть «всё» — он покрывает **сборную лучших signals из 4 тематик**.
- Twitter rotation: 6 queries / 2 per cycle = полный круг за 3 цикла (~5 минут при 90с цикле). За день каждая тема прокачивается ~280 раз — достаточно для статистической ровности.

---

## 2026-05-05 (Ask Grok prompt: structured 6-point analysis)

Старый промпт «Ask Grok» в TrendModal был одной строкой:
```
How viral is this narrative right now? <title> — <url>
```
Грок отвечал общим параграфом, без структуры. Владелец попросил сделать точечнее.

**Новый промпт** — 6 пунктов, каждый отдельный вопрос:
1. Название нарратива (2-5 слов)
2. Почему вирален (триггер + кто пушит + объём)
3. Почему может вырасти (24-72ч катализаторы)
4. Потенциал роста (1-10 + обоснование)
5. Риски
6. Релевантная аудитория

Плюс шапка: «используй свежие данные из X 24-48h» — толкает Grok на x_search вместо стейтика. И жёсткий гард в конце: «Если данных мало — честно скажи "слабый сигнал", не выдумывай» — против hallucinated bullshit.

Локализация EN/RU. URL под Grok-сайт, без API-вызовов с нашей стороны (как и было).

**Технически — поймал SPA-ловушку №2** (newlines в template literal). Промпт многострочный → строки собраны через `[...].join(String.fromCharCode(10))`, потому что литеральный `\n` outer-template съел бы. Плюс ловушка повторно ужалила в комментарии: упомянул backslash-n в комменте — рантайм счёл его настоящим newline'ом, comment дотёкл до следующей строки и поломал outer literal. Перефразировал на «backslash-n» текстом. `node scripts/check-dashboard-spa.cjs` поймал на первом проходе.

Файл: `src/dashboard/server.js` — TrendModal, секция Links, `(() => { ... grokUrl ... })()` блок.

---

## 2026-05-05 (Junk penalty: text-only posts)

Владелец просил снизить долю чисто-текстовых постов в feed — мягкий штраф, не drop. Анализ распределения по 7 дням показал что Twitter имеет 22% постов без медиа, Reddit 4%, google_trends 100% (by design — нет media в природе платформы).

**Решение**: новый per-preset penalty `noContentPenalty` в `junk-filter.js`. Стакается с другими (politics, no-meme-shape, etc) до safe-override. Дефолты подобраны мягкими — большинство presets 5-8, events=0 (там новости часто текстовые by nature, штрафовать неправильно).

| Preset | noContentPenalty |
|---|---|
| general | 5 |
| animals | 8 (animal-мемы должны быть с фото) |
| culture | 6 |
| celebrities | 5 |
| events | **0** (новости часто текстовые) |

**Source-aware bypass**: когда **все** items кластера из source'а где медиа отсутствует by design (`google_trends`), штраф не применяется. Иначе бы все Google-results получали penalty мимо своей контроля. Пока в списке только `google_trends` — другие коллекторы все потенциально с медиа.

**Эффективный impact** через alertScore: penalty проходит через `weightJunk=0.5`, то есть `noContentPenalty=5` → `−2.5` к alertScore. Маленько, но значимо при пороге 65.

**Detection**: проверяется наличие хотя бы одного из полей `metrics.thumbnailUrl` / `metrics.imageUrl` / `metrics.videoUrl` / `metrics.imageUrls[].length>0` (плюс зеркала на root item). Если ни у одного item кластера ничего нет — штраф.

**Safe-override**: penalty стакается до safe-override. Если в тексте есть animal/absurd/meme/heartwarming — весь `raw` (включая no-content) делится на `safeOverrideDivisor` (3 default). То есть текстовый пост про собаку получает penalty ÷3, текстовый пост без сигналов — full hit.

### Файлы
- `src/analysis/preset-config.js` — добавлено поле `noContentPenalty` в junk field-ranges + default value во все 5 пресетов.
- `src/analysis/filter-profiles.js` — зеркало в legacy-структуре (FILTER_PROFILES + PROFILE_FIELD_RANGES) для совместимости с админкой и validator'ом.
- `src/analysis/junk-filter.js` — детектор `hasVisual` + блок `if (!hasVisual && !allTextlessByDesign)`.

**Migration**: zero-effort. `resolvePresetConfig` deep-merge'ит дефолты в существующий пользовательский blob — новое поле автоматически получает значение из `DEFAULT_PRESET_CONFIGS`. Старые row'ы в БД с уже-посчитанным junkPenalty остаются как есть; новые тренды считаются с обновлённой формулой.

---

## 2026-05-05 (X Trends rework: top-3 trends → tweet-backed engagement signal)

**Проблема**: владелец заметил что в feed много мусора. Анализ показал — старая архитектура X Trends эмитила хэштеги-как-тренды (`#SkibidiToilet — Trending #5`) с **нулевыми реальными метриками** (views/likes/etc = 0, X не отдаёт public tweet volume). Stage 1 LLM был вынужден галлюцинировать virality из голого названия → честно метил `memePotential ≈ 19`, но `virality ≈ 56` (rank-based bias) → проходило все фильтры и забивало feed. 85% x_trends в БД имели `memePotential < 40`.

**Решение** (после уточнения от владельца, что X Trends должен остаться отдельным источником с **видимым трендом**, не лентой твитов):

X Trends теперь **discovery layer** двух стадий:
1. Раз в сутки (вместо 30 мин) тянет список трендов через `karamelo/twitter-trends-scraper`, берёт top-3 по rank.
2. Для КАЖДОГО top-тренда вызывает обычный Twitter-скрапер (kaitoeasyapi/xquik) и тащит **топ-7 твитов** по запросу.

Эмиттится **один item на тренд** (source=`x_trends`):
- `metrics.views/likes/retweets/replies` = сумма по всем твитам тренда → Stage 1 LLM получает РЕАЛЬНЫЕ engagement-сигналы вместо текстовой догадки
- `metrics.topTweets[]` хранит список твитов с их content + numbers → доступно для prompt context, modal, и будущей UI-секции
- Visual content (thumbnail/imageUrls/videoUrl) лифтится из highest-engagement твита → X-Trend карточка в фиде имеет постер/галерею/видео как обычный твит-card

**Relaxed engagement floor**: добавлен флаг `opts.relaxedFloor` в `twitter._normalize` (10K views / 500 likes вместо 500K / 10K). X-Trends вытаскивает свои твиты с этим флагом — trending position уже сама по себе quality signal, firehose-grade bar отрезал бы 80% валидных трендов.

**Auto-skip generic noise**: если ни один из 7 запрошенных твитов не прошёл relaxed-floor, тренд тихо скипается. Так автоматически отсеиваются хэштеги типа `#GoodMonday`, `#Motivation` — без human-curated stoplist.

**Результаты на проде** (первый refresh после деплоя):
```
[XTrends] "May the 4th"   (rank 1) → 6 tweets, aggregated views=4966377 likes=227125
[XTrends] "John Sterling" (rank 2) → 7 tweets, aggregated views=2293013 likes=41997
[XTrends] "Good Monday"   (rank 3) — no qualifying tweets, skipping
```
2 из 3 трендов уехали в pipeline с миллионами views и десятками тысяч likes как реальный сигнал. Третий правильно отсеян.

**Стоимость**: $13/мес → **~$1.40/мес** (1 trends-list call/день + 21 твит/день при kaitoeasyapi). Чистая экономия $11.5/мес + кардинальное улучшение качества сигнала.

### Файлы
- `src/collectors/x-trends.js` — полный rewrite. `_buildTrendItem(trend, tweets)` агрегирует engagement и упаковывает topTweets. `_refresh()` теперь делает trends-list + N tweet-fetches. Старый `_normalize` / `_dedupKey` удалены.
- `src/collectors/twitter.js` — добавлен публичный `searchByQuery(query, maxItems, opts)`, `_searchQuery` теперь принимает `opts.relaxedFloor` и пробрасывает в `_normalize`. Floor: `viewsBar = (relaxed ? 10K : 500K) * cjkMult`, `likesBar = (relaxed ? 500 : 10K) * cjkMult`.
- `src/index.js` — `new XTrendsCollector(config, logger, db, twitterInstance)` — пробрасываем ссылку на TwitterCollector для discovery flow.
- `src/notifications/formatter.js` — source-aware engagement labels для x_trends. Раньше `m.upvotes` ветка покрывала только twitter/tiktok/reddit-like, и x_trends падал в общий fallback (Upvotes). Теперь для `source='x_trends'` рендерится rich-row `👁 views · ❤️ likes · 🔁 retweets · 💬 replies · N tweets` — отражает что у X-Trend агрегированный сигнал, а не одиночный счётчик.
- `src/dashboard/server.js`:
  - `_formatTrend` теперь пробрасывает `metrics.topTweets[]` в payload (с trim до 10 элементов и нужных UI-полей).
  - `TrendModal` рендерит секцию «🔥 Топовые твиты» только для `source='x_trends'`. Каждая строка — clickable `<a>` с `data-tweet-id` (хук `useTweetHover` ловит автоматом → ховер-карточка как у обычных твиттер-ссылок). Внутри строки: автор (моно), текст (cap 280), engagement-чипы 👁/❤️/🔁/💬.
  - CSS: `.xtrends-toptweets`, `.xtrends-toptweet`, `.xtrends-toptweet-head`, `.xtrends-toptweet-author`, `.xtrends-toptweet-text`, `.xtrends-toptweet-engage`. Согласован с дизайн-системой (var(--card), var(--border), accent-tint на hover).
  - i18n: новый ключ `modal.xtrends_top_tweets` (EN: «🔥 Top tweets ({n})», RU: «🔥 Топовые твиты ({n})»).

### Риски / заметки
- Если TwitterCollector ещё не инициализирован к моменту new XTrendsCollector — X Trends self-disable с warning. Сейчас порядок в `index.js` правильный (Twitter → XTrends).
- Per-preset `sources.xtrends.topN` поле сейчас не используется (top-N через env). Оставлено в схеме для обратной совместимости — preset-config validator не упадёт, и будущий refactor может вернуть как override.
- Старые row'ы в БД с source='x_trends' и нулевыми metrics остаются в фиде до retention cleanup (~7 дней). Новые приходят с реальными числами.
- `relaxedFloor` ослабляет фильтр **только** для пути `searchByQuery` — обычный `collect()` Twitter-коллектора по-прежнему режет по 500K. Если в будущем понадобится в других discovery-сценариях — флаг переиспользуем.
- Source-link для X-Trend карточки сейчас `https://x.com/search?q=<name>&src=trend_click&vertical=trends` — каноничный X-style «click from trending tab» URL. Идеальный вариант `/i/trending/<topic_id>` недоступен: actor `karamelo/twitter-trends-scraper` не отдаёт internal topic_id (cluster_id из X'овского `/i/api/2/guide.json`). Если когда-нибудь понадобится — нужен другой actor / собственный scraper с авторизованной сессией.

### Follow-up: hover-preview toggle (per-user)

В `SettingsPanel → Appearance` добавлен Toggle «👁 Hover preview» / «👁 Превью при наведении». Управляет ховер-карточкой со содержимым твита/реддит-поста на ссылках. Default ON (сохраняет существующий UX).

Хранится в `localStorage` как часть существующего `ts_prefs_v1` blob (`prefs.hoverPreview: bool`) — pattern такой же как у `showImages`/`animations`. Per-browser (= per-user в практическом смысле, разные юзеры на разных устройствах = разные prefs).

Технически: добавлен хелпер `readPref(key, fallback)` который читает свежее значение из `localStorage` без подписки на событие. `useTweetHover.onOver` вызывает `readPref('hoverPreview', true)` на каждом mouseover — bail-out если выкл. Toggle применяется на следующем же hover'е, без re-mount хука.

Файлы: `src/dashboard/server.js` (DEFAULT_PREFS + readPref + useTweetHover guard + SettingsPanel Row + i18n EN/RU).

---

## 2026-05-05 (Фикс X Trends — Apify актор поменял схему `country`)

**Симптом**: владелец заметил что несколько дней не приходит ни одного X Trends ни в дашборд, ни в TG.

**Диагноз** (по `docker logs catalyst-app | grep XTrends`):
```
[XTrends] sync refresh failed: Apify 400 [karamelo~twitter-trends-scraper]:
"Field input.country must be equal to one of the allowed values: '1','2','3',...,'35'"
[XTrends] Collected 0 items
```
Каждый цикл сбора, тысячи раз. Reddit/Twitter/Google продолжали работать.

**Корень**: актор `karamelo~twitter-trends-scraper` 2026-03-06 поменял input schema. Поле `country` теперь не строка `"United States"`, а enum-ID `"1".."35"` (где `"1"`=World, `"2"`=United States, `"3"`=Canada, ...). Старый input стабильно отдавал HTTP 400. Схему вытащили через `GET /v2/acts/<id>/builds/<latest>` → `inputSchema.properties.country.enum + enumTitles`.

**Фикс** (`src/collectors/x-trends.js`):
- Добавлена статическая мапа `COUNTRY_ID_MAP` (35 стран по реальному enum актора)
- Хелпер `resolveCountryId(value)`: если `/^\d+$/` — пропускает (env уже содержит ID), иначе lookup по lowercase имени, fallback на `"2"` (US)
- В `_fetchFromApify` теперь шлём `country: resolveCountryId(this.country)` вместо сырой строки
- Public-facing `this.country` остаётся человекочитаемой строкой — нужен для логов (`refreshed: N trends from <country>`) и описания в `_normalize` («Trending #N on X in United States (Live)»)
- Бэквард-совместимо: `X_TRENDS_COUNTRY=United States` (default) и `X_TRENDS_COUNTRY=2` оба валидны

**Деплой/проверка**: `deploy.ps1` → docker rebuild → проверка логов:
```
[XTrends] refresh timer started (every 30 min, country=United States)
[XTrends] refreshed: 100 trends from United States
[XTrends] Starting collection...
[XTrends] Collected 25 items
```
Поток восстановлен. Backlog за пропущенные дни не наверстаем (Apify не отдаёт исторические тренды), но новые пойдут.

**Риски / заметки**:
- Если автор актора снова поменяет enum (добавит/удалит страны) — `COUNTRY_ID_MAP` рассинхронизируется. Низкая вероятность; код достаточно forgiving (fallback на `"2"`).
- Похожий паттерн «schema drift у Apify-актора» теоретически возможен для twitter (kaitoeasyapi/xquik) и tiktok коллекторов — не трогали, работают. Если в будущем такое же — лекарство то же: вытащить `inputSchema` и translate-layer.

### Файлы
- `src/collectors/x-trends.js` — `COUNTRY_ID_MAP` + `resolveCountryId()` + правка `_fetchFromApify`

---

## 2026-05-04 (Hover-preview карточки + live engagement refresh + admin search)

Длинная сессия по UX-просьбам владельца. Большая часть — построение hover-preview инфраструктуры в дашборде (как в торговых терминалах: наводишь на ссылку — видишь содержимое поста), потом обвязка для **живого** обновления статистики (views/likes/upvotes/comments) при ховере и фоновом цикле, плюс поиск в DecisionsPage.

### Admin: поиск в `DecisionsPage` (вкладка 🔔 Алерты)

`src/admin/server.js`. Добавлен инпут поиска в фильтр-строке. Клиентский filter — буфер всего 500 решений in-memory, регэкс по массиву на каждый keystroke стоит микросекунды, серверный endpoint не нужен. Ищет по `title` / `source` / `category` / `alertType` / `userChatId` / `url` / `reason` (case-insensitive substring). Кнопка ✕ для очистки + счётчик «найдено: N / total». Empty-state корректно говорит «по запросу X ничего не найдено» вместо общего «нет решений».

### Tweet hover-preview (новая фича)

**Триггер**: ховер на ссылку `↗ Twitter` (в карточке фида) или `Source link` (в модалке). Через 350мс debounce появляется floating-карточка с: аватаром, именем (кликабельное), @handle (кликабельное), текстом твита, медиа (фото/превью видео), engagement chips. Аватар → ссылка на профиль X.

**Backend** (`src/dashboard/server.js`):
- LRU-кэш `tweetPreviewCache` (500 entries, 5-мин TTL для 200, 30-сек для 4xx)
- `extractTweetId(url)`, `normalizeFxTweet(tweet)`, `fetchTweetPreview(id)` — обёртки над `api.fxtwitter.com/i/status/<id>` (бесплатно, без auth, ~200-500ms)
- `GET /api/tweet-preview?id=<tweet_id>|url=<full_url>` — авторизованный endpoint в общем блоке роутов

**Frontend** (тот же файл, в SPA):
- `TweetHoverPreview` — компонент-портал в `document.body`, z-index 8500 (между modal-overlay 8000 и lightbox 9000)
- `useTweetHover()` — глобальный делегат `mouseover`/`mouseout` на `document`. Debounce 350мс, grace 200мс при mouseleave. `activeIdRef` предотвращает ре-fire при движении курсора внутри одной ссылки.
- Auto-flip: если карточке мало места снизу — показывается **выше** ссылки через CSS `bottom: vh - anchor.top + PAD` (CSS bottom вместо top, чтобы карточка росла вверх независимо от своей высоты — раньше использовал ESTIMATED_H 480→600 и карточка зависала «в воздухе» когда реальный размер был меньше)
- maxHeight по доступному месту → внутренний `.tw-prev-text` со scroll'ом для длинных постов

**Hover-target**: атрибут `data-tweet-id` ставится **только на `↗` ссылку** (после revert: ховер на весь пост был слишком агрессивен). Atribute extracted из URL по pattern `/status/<id>` (URL-based, **независимо** от `trend.source` — это поле может быть `'twitter'` / `'x'` / `'x_trends'` от разных коллекторов).

### Reddit hover-preview (зеркало Twitter)

После того как Twitter заработал, добавил параллельный pipeline для Reddit. Тот же UX — ховер на `↗ Reddit` показывает r/sub + u/user + title + selftext + media + ⬆ score / 💬 comments / 🏅 awards / ratio↑.

**Backend**: `redditPreviewCache`, `extractRedditPostId`, `normalizeRedditPost`, `fetchRedditPreview` — все mirrored с Twitter, но fetch на `https://www.reddit.com/comments/<id>.json?raw_json=1` (бесплатно, без auth). `GET /api/reddit-preview?id=<post_id>|url=<permalink>`.

**Frontend**: вместо двух отдельных хуков — расширил `useTweetHover` в **универсальный**: матчит `data-tweet-id` ИЛИ `data-reddit-id`, роутит на нужный endpoint. Карточка переключается по `state.kind`: `tweet` → 𝕏-стиль (avatar + @handle + 👁/❤️/🔁/💬), `reddit` → 🅡-стиль (r/sub + u/user + ⬆/💬/🏅/ratio). Один `CustomEvent('link-metrics-update')` с полем `kind` в detail вместо двух разных эвентов.

### Live engagement update — Variant B (мгновенное обновление UI)

Жалоба: hover-карточка показывает **свежие** числа (704K views), а под ней в фиде всё ещё **старые** (558K) — расхождение бьёт в глаза.

**Цепочка обновления:**
1. **Backend persist** (`src/db/database.js`):
   - `db.updateTwitterEngagement(tweetId, fresh)` — найти trend(ы) по URL pattern `%/status/<id>%`, патчить `views/likes/retweets/replies` в `raw_metrics` (null-safe: не затирает поля которые fxtwitter не отдал)
   - `db.updateRedditEngagement(postId, fresh)` — то же для `upvotes/comments`, lookup по `%/comments/<id>%`
   - **Velocity computation**: оба метода считают `Δviews|upvotes / Δhours` между предыдущим snapshot'ом и текущим. Snapshot хранится в `metrics._engSnapshot = { views|upvotes, ts }`. Первый раз baseline берётся из `metrics.views|upvotes + first_seen_at`. Min gap 5 минут (фильтр шума), Δ > 0 (защита от view-counter rollback). Возвращает `{ rows, velocity }`.
   - Дополнительно: `metrics.engagementRefreshedAt` для аудита.

2. **Endpoint integration**: `_handleTweetPreview` / `_handleRedditPreview` после успешного fetch'а вызывают `db.updateXxxEngagement(...)` в try/catch (fire-and-forget — DB-failure не должен ломать preview-ответ). Возвращают `velocity` в JSON ответа.

3. **Frontend dispatch** (`useTweetHover`): после `setState(...status: 'ok')` диспатчит `window.dispatchEvent(new CustomEvent('link-metrics-update', { detail: { kind, id, metrics, velocity } }))`. На cache hit `velocity = null` (signals «no fresh velocity, keep old»).

4. **App listener**: один useEffect слушает `link-metrics-update`, патчит **два** state-слота:
   - `setTrends(...)` — все видимые карточки фида (engagement + velocity), bail-out на shallow-equal чтобы не трогать React tree без изменений
   - `setModalTrend(...)` — открытая модалка хранится в отдельном state, отдельный merge
   - Mapping field-names per kind: Twitter `views→views, likes→likes, retweets→reposts, replies→comments`. Reddit `upvotes→views, comments→comments` (Reddit не имеет separate likes/reposts).

### Two-tier hot refresh (`src/refresh/hot-metrics.js`)

Heavy cycle (12h) уже существует — re-fetch + Stage 1 + Stage 2 LLM rescore. Добавил **light cycle** (60 мин) который делает **только** metrics refresh, без LLM:

- Eligible: все Reddit/Twitter trends ≤24ч (без minMeme — даже низкокачественные обновляются, они всё равно видны в фиде)
- Worker pool 5, calls `_fetchFresh` (reuses Twitter fxtwitter / Reddit JSON resolvers) → `db.updateTwitterEngagement` / `db.updateRedditEngagement`
- Skip если heavy cycle в полёте (no double-fetch)
- Тот же admin-toggle `hotRefreshEnabled` управляет обоими tier'ами
- Env knobs: `HOT_REFRESH_LIGHT_INTERVAL_MINUTES` (60), `HOT_REFRESH_LIGHT_ENABLED` (kill-switch)
- Cost: $0/мес (fxtwitter и reddit json — оба free)

Эффект: **все** Reddit/Twitter тренды обновляются раз в 60 минут, не только хроверённые.

### TikTok / Google Trends / X Trends

Не трогаем — TikTok oEmbed не отдаёт engagement (нужен Apify, платный), Google/X Trends — агрегатные сигналы, не индивидуальные посты.

### Auth fix: `/api/preview` 401

Существующий endpoint работал через raw `fetch('/api/preview?...')` без Bearer-токена (4 места: `FeedImage`, ещё одна aux fetch и 2 в TrendModal). Под общим auth-gate был 401. Заменил все 4 на `api('/preview?...')` который сам прикручивает Bearer.

### Ловушки template literal — три новых рецидива

Внутри `_buildSPA()` template literal эскейпы съедаются Node-парсером **до** отправки в браузер. Наступал три раза за сессию:

1. **Бэктики в комментариях** (`// CSS \`bottom\` instead of \`top\``) — чёрный экран. Лечение: убрать обратные кавычки из текста комментариев в SPA-коде.
2. **Regex literal внутри template literal** (`/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i`) — Node template eats `\.` → `.`, regex literal в браузере матчит хорошо. Это **работает** для regex literals.
3. **String-based RegExp constructor** (`new RegExp('\\d+')`) — две вложенные интерпретации escape-sequence. `\\d` → Node template → `\d` → browser JS string literal → `d` (нераспознанный escape, бэкслэш дропнут) → RegExp получает `'d+'` (буква d). Лечение: **четыре** бэкслэша в source: `'\\\\d+'` → Node → `'\\d+'` → Browser → `'\d+'` ✓.

`scripts/check-dashboard-spa.cjs` ловит #1 (синтаксис), но **не ловит #3** (синтаксически валидно, семантически сломано). Добавил throwaway `_test_regex.cjs` для двойной проверки во время сессии (удалён после).

### Files touched
- `src/dashboard/server.js` — endpoints, hover hook, preview component, lightbox, App listener, CSS, auth fixes (~1500+ строк диффа)
- `src/db/database.js` — `updateTwitterEngagement`, `updateRedditEngagement` (с velocity computation)
- `src/refresh/hot-metrics.js` — light cycle (`runLightCycle`), отдельный startTimer + intervalHandle, env vars
- `src/admin/server.js` — search input в DecisionsPage + CSS

### Проверка
- `node scripts/check-dashboard-spa.cjs` ✓ (219292 chars)
- `node --check` всех 4 файлов ✓

### Риски / заметки
- **TikTok freshness не покрыт** — единственная стратегия для него Apify через heavy 12h цикл. Если важно — добавить отдельную light-tier ветку с Apify (платно).
- **Velocity для Twitter был раньше 0** в `metrics.velocity` (поле для Reddit). Теперь Twitter тоже получает velocity из delta. Может слегка изменить виральность-heuristic для старых строк — но `_heuristicScore` использует velocity только для `m.upvotes` контекста (Reddit), на Twitter не критично.
- **Race**: light cycle и hover могут писать в один и тот же row близко по времени. Оба идут через одни и те же DB-методы (`updateXxxEngagement`), методы атомарны (single UPDATE), последний выигрывает. Snapshot обновляется каждым → следующий gap считается от последнего, чуть может «перескочить» точную velocity. Acceptable.
- **`_engSnapshot` вечно растёт в JSON**? Нет — это object с 3 полями (views/upvotes, likes/comments, ts), <100 байт. Перезаписывается каждый refresh.
- **404 на reddit /comments/.json**: Reddit иногда блочит дата-центральные IP. Если это случится — fxtwitter-эквивалента у Reddit нет. Альтернатива на будущее — `i.reddit.com/.json` (mobile mirror) с тем же payload.

---

## 2026-05-04 (UX полировка дашборда + Grok cost cleanup + cross-platform rip-out)

Большой проход по жалобам владельца на дашборд + закрытие двух источников расходов (Grok hot-refresh, поломанная кросс-платформенная агрегация). Всё в одном дне сессии.

### Window-фильтр фида (баг 6h-окна → пустой фид)

Жалоба: «Окно 6h не работает». Sources card показывает 158 трендов, но фид пуст.

Две слои проблем:

1. **Семантика**: фильтр был `WHERE first_seen_at > cutoff`. Кластеризатор подтягивает свежие посты к существующим нарративам — `last_seen_at` обновляется, `first_seen_at` нет. Тренд, родившийся 8h назад и активный прямо сейчас, не попадал в окно 6h. Переключил на `last_seen_at > cutoff` — семантика стала «активен в окне», а не «родился в окне». В `_handleTrends` + `_handleStats`.

2. **String-comparison bug** (это была настоящая причина обнуления). SQLite хранит `CURRENT_TIMESTAMP` как TEXT `"YYYY-MM-DD HH:MM:SS"` (пробел между датой и временем). А `new Date().toISOString()` даёт `"YYYY-MM-DDTHH:MM:SS.sssZ"` (с `T`). Лексикографическое сравнение на позиции 10: `' '` (0x20) < `'T'` (0x54) → DB-строка **всегда** меньше cutoff-строки при одной и той же дате → `WHERE col > cutoff` режется в ноль для same-day cutoff'ов. На 24h работало почти, потому что cutoff попадал на вчерашнюю дату — отличие шло уже на позиции 8 ("4" vs "3"). На 6h cutoff в той же дате → 0 трендов.

Helper `sqliteCutoff(msAgo)` форматирует `"YYYY-MM-DD HH:MM:SS"` под формат стораджа. Применил в `_handleTrends`, `_handleStats`, `_handleSources`. Тот же баг есть в `db/database.js` (retention/dedup queries) — там окна 7-30 дней, симптоматически невидимы; не трогал в этом PR. Подпись времени на карточке/модалке тоже переключил на `lastSeen` (с fallback на `firstSeen`) для консистентности с фильтром.

### Cross-platform aggregation удалена целиком

Жалоба + скрин: одно и то же turtle-видео из Twitter и Reddit как 2 отдельных тренда (matcher не смержил), и оба получают 0 за «platform spread» в emergence.

Решение — выдрать сигнал отовсюду, где код на него полагался:

- **`clusterer.js`**: убраны `batchPlatforms`/`dbPlatforms`/`uniquePlatforms`. EmergenceScore: компонент Platform spread (0–30) удалён, 30 баллов перераспределены — Velocity 25→**35**, Organic 20→**30**, Novelty 15→**20**, Author diversity 10→**15** (сумма по-прежнему 100, пороги DROP/SAVE/PRIORITY/STAGE1 не трогали). В `_decide` убран guard `uniquePlatforms <= 1` из drop-gate.
- **`scorer.js` `deriveAlertType`**: правило `platforms ≥ 2 OR clusterSize ≥ 3` упрощено до `clusterSize ≥ 3`.
- **`dashboard/server.js`**: убран URL-param `minPlatforms`, поле `uniquePlatforms` снято с trend-payload, бейдж `Xp` (`2p`/`3p`) на карточке убран, тайл «Платформы / 🌐 N» в модалке удалён, i18n `modal.platforms` тоже.
- **`admin/server.js`**: `🌐 N платформ` бейдж в Cluster-signals удалён, hydration field убран.

AI-промпты с упоминанием «cross-platform spread» **не трогал** — это валидная семантика для рубрики LLM, не наш детерминированный код. Колонка `source` в БД и `raw_metrics.uniquePlatforms` старых строк остаются — безвредно, никто не читает. Single-platform breakouts всё ещё ловятся через Path 2 (breakoutScore) — он platform-agnostic, по raw engagement.

Теперь две копии turtle-видео идут как два тренда, но **оба честно** получают высокий emergence через breakout. Раньше код тащил их через сломанный сигнал и ставил 0 за platform spread.

### Hot refresh: 2h → 12h цикл (Grok cost cut 6×)

Жалоба: «Grok начал заметно больше есть денег». Audit показал — Hot refresh — это бесконечная петля без per-trend cooldown'а. Picker (`getHotTrendsForRefresh`) выбирает все hot-тренды моложе 24h без проверки последнего рескора, каждый цикл re-runs Stage 1 на всех + Stage 2 на тех у кого memePotential ≥ 60.

При интервале 120 мин активный тренд за свою 24h-жизнь прогонялся **до 12 раз**. Изменил `DEFAULT_INTERVAL_MIN` 120 → **720** (12 часов). Теперь тренд проходит через Hot refresh максимум **2 раза**. Шесть-кратное снижение LLM-расходов без потери возможности повторно поскорить.

Переменная окружения та же (`HOT_REFRESH_INTERVAL_MINUTES`) — можно тюнить в обе стороны (360 = 6h «реактивно», 1440 = 24h «минимум»). `.env.example` синхронизирован.

Если расходы всё ещё не устроят — следующий шаг добавить per-trend cooldown в picker (поле `lastRefreshedAt` уже пишется в `raw_metrics`, но picker его не читает). Не делал — пока интервала достаточно.

### Модалка: layout overhaul

- **Hero Meme Score** в самом верху над медиа: компактная карточка с soft gradient-фоном, акцентной рамкой, цифрой 16px JetBrains Mono с цветом по тиру (hot/warm/ok/cold), 4px полоска с gradient fill + shimmer-анимация. Это «главная цифра» — заслужила prime-слот выше всего остального. Класс `.meme-hero`.
- **Сентимент тайл удалён** из метрик-грида (поле `sentiment` остаётся в payload и используется в TG-алерте + chip карточки фида — это отдельные места).
- **Метрики-сетка** свелась к **3 тайлам** в порядке: **Виральность → Скорость → Срок жизни** (Lifespan). Cross-platform tile удалён в этом же PR (см. выше).
- **Высота медиа**: 440px → 260px (модальная карусель `.img-carousel.in-modal` + `.modal-image-wrap`). Освободил место под scoring-bars + quote-хук без скролла.
- **Lightbox**: клик по картинке/слайду открывает fullscreen-просмотр через `ReactDOM.createPortal` в `document.body` (z-index **9000** — выше `.modal-overlay` 8000, ниже `.toasts-wrap` 9999). Закрытие по клику в любое место / Esc / кнопке ×. Capture-phase Escape listener у Lightbox + gate `lightboxSrc` в TrendModal-handler гарантируют правильный порядок закрытия. `cursor: zoom-in` на `img.modal-image` (НЕ на `video.modal-image` — иначе видео получало курсор-лупу).

### Фид-карточки: Meme Score + разделители колонок

В score-strip фида была 2-колонная сетка (Emergence | Adoption). Добавил третью колонку **Meme Score** между ними — `trend.memePotential` тот же сигнал что в hero-блоке модалки, surfaced на карточку чтобы видно at-a-glance.

Дизайн: `grid-template-columns: 1fr 1fr 1fr`, gap → 0, padding `8px 6px` снаружи + `0 10px` на каждой колонке, **вертикальные gradient-разделители** через `.feed-score + .feed-score::before` (1px, fade к торцам). Колонки больше не сливаются.

### Type-фильтр: AND → OR

Жалоба: «выбираю Ручные → остальные типы исчезают, хотя выбраны».

Старая логика: `manualOnly && alertTypes` — пересечение, не объединение. «Ручные» + «Пост» давало manual-submitted **И** alertType=post (мизерный intersection).

Чипы Type-оси (Event/Trend/Post/Manual) — это **одна ось** «что показывать». Семантика должна быть union. Новая логика: row проходит если `passManual || passType` (когда оба активны). Когда активен один — только он решает, поведение прежнее. Wildcard для legacy-строк без `alertType` сохранён.

### Catalyst: чистка визуала

- **Sources block** (список low-signal X handles) удалён из дашбордной модалки **и** из Telegram-алерта (`notifications/telegram.js`). Поле `payload.sources` всё ещё прилетает из БД, но не рендерится. CSS-классы `.catalyst-sources*` оставил — мёртвые правила безвредны.
- **CTA-hint в empty-state** убран целиком (был «Куда движется этот нарратив - фаза, каталисты, риски»). Кнопка "Найти Каталиста" сама достаточный call-to-action. i18n-ключ `trigger.cta_hint` оставил живым на случай возврата.

### Sentiment audit (без изменений)

Sub-вопрос владельца: «как влияет sentiment?». Прошёлся по коду — нигде не читается для скоринга/роутинга/алерт-диспатча. Чисто descriptive vibe-метка: показывается в TG-алерте и feed-card chip, не двигает ни alertScore, ни phase, ни type. Решили оставить как есть — option B (использовать в `computeAlertScore`) на потом.

---

## 2026-05-04 (Production-readiness pass + log audit для публичного релиза)

**Цель**: владелец готовит проект к публикации. Прошёлся по дашборду + админке + бот-боту в режиме готовности к домену и multi-user. Закрыл блокеры по слою представления (security headers, CORS, rate limits, graceful shutdown, env validation), потом sweep по логам на утечку секретов.

### Security headers + CORS allowlist (dashboard + admin)

Раньше: `Access-Control-Allow-Origin: *` хардкодом везде, никаких security-заголовков. Любой сайт мог из браузера дёрнуть `/api/manual-analysis`, feedback, toggle коллекторов от имени залогиненного юзера. Page фреймился (clickjacking), MIME-sniff включен, HSTS не закреплён.

**Фикс** (`src/dashboard/server.js`, `src/admin/server.js`):
- Helper `buildHeaders(req)` собирает `SECURITY_HEADERS` + опциональный CORS-echo по allowlist
- Default policy: HSTS (max-age=31536000), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer
- CORS allowlist через env: `DASHBOARD_ALLOWED_ORIGINS` / `ADMIN_ALLOWED_ORIGINS` (comma-separated). Empty default = same-origin only (самый безопасный)
- В `_handle()` стэшится `res._defaultHeaders = buildHeaders(req)` и **monkey-patch `res.writeHead`** чтобы каждый response (включая binary handlers, error paths, 401, OPTIONS, SSE) автоматически инжектил headers — без рефакторинга 30+ call sites
- HTML SPA: `Cache-Control: no-cache, no-store, must-revalidate` чтобы deploy сразу видели новую версию

### Rate-limits на auth endpoints

Раньше: `/api/auth/verify` без throttling — 6-значный код можно было перебрать за дни (~20 бит энтропии). `/api/auth/initiate` без cap — флуд создавал тысячи pending-rows в `auth_sessions`.

**Фикс** (`src/dashboard/server.js`):
- `_authVerifyAttempts: Map<sessionId, {count, firstAttempt}>` — cap 5 попыток / 15 мин окно. После превышения 429, "restart login from /start". В ответе `attemptsRemaining` для UX
- `_authInitiateAttempts: Map<ip, {count, firstAttempt}>` — cap 10 / 5 мин per-IP. Sweep на каждом запросе чтобы Map не рос
- Note: за прокси без `TRUST_PROXY=1` все IP видятся как proxy — limit становится глобальным per-VPS. Когда добавим `X-Forwarded-For` чтение, ключ Map переедет на real-IP

Smoke-test подтвердил: 11-я /initiate попытка → 429, 6-я /verify → 429.

### Admin-gate на collector toggle

`POST /api/collectors/:name/toggle` мутирует **глобальный** `appState.disabledCollectors`. До фикса: любой Pro/Free юзер мог выключить Twitter для всей системы. Now: server-side check `req.user.plan_name === 'admin'`, иначе 403. Audit-лог теперь включает `maskId(chat_id)` админа.

### Graceful shutdown с timeout + SSE drain

Раньше `dashboard.stop()` делал просто `server.close()` без таймаута — rolling deploy дропал in-flight запросы (502 у юзера).

**Фикс** (dashboard + admin + index.js):
- `dashboard.stop(timeoutMs=10000)` — Promise: drain SSE с `event: bye`, ждёт active requests, force-close через `closeAllConnections()` после таймаута
- `admin.stop(timeoutMs=10000)` — аналогично (SSE нет, просто drain)
- В `index.js` shutdown теперь: re-entry guard (SIGTERM может прийти дважды), hard-cap 15s через `setTimeout`, `Promise.allSettled([dashboard.stop, admin.stop])` параллельно

### Hard-fail env validation в production

Раньше `config.js` логировал warning'и но **не падал** — оператор мог запустить с пустым `ADMIN_API_KEY` и не заметить.

**Фикс** (`src/config.js`):
- Новые поля: `nodeEnv` / `publicBaseUrl` / `trustProxy`
- В production (`NODE_ENV=production`) отсутствие `XAI_API_KEY` / `TELEGRAM_BOT_TOKEN` / `ADMIN_API_KEY` → `process.exit(1)` с явным сообщением
- В dev — warnings как было

### Log audit — закрытие утечек секретов

Запустил Explore-agent на поиск утечек в логах. Найдено 3 категории:

**🔴 HIGH: Apify token в URL** (4 коллектора). `?token=<apiKey>` в query-string — если `fetch()` бросил network error, undici включает URL в `err.message` → токен утёк бы в любой `logger.error(e.message)` вверх по стэку.

Фикс: `?token=` → `Authorization: Bearer` header в:
- `src/collectors/twitter.js`
- `src/collectors/twitter-check.js`
- `src/collectors/tiktok.js`
- `src/collectors/x-trends.js`

Apify поддерживает Bearer auth, токен больше не на URL-поверхности.

**🔴 HIGH: Telegram bot-токен в file URLs**. `getFileUrl()` возвращал `https://api.telegram.org/file/bot<TOKEN>/...`, dashboard avatar handler делал `fetch(url)` и в `catch` логировал `e.message` — реальный leak.

Фикс: новый `telegram.fetchFile(fileId) → {buffer, contentType}` который держит fetch внутри telegram-модуля. URL с токеном **не пересекает границу модуля**. В catch теперь `err.code` (не `e.message`) на случай если undici снова решит включать URL. `getFileUrl()` помечен deprecated.

**🟡 MEDIUM: telegram_chat_id в логах** (12+ мест). PII в долгосрочных stdout-логах (Docker / journald). Mask вместо удаления — нам нужно correlations между лог-строками одного юзера, но не полный ID.

Helper `maskId(id) → '***' + last4` добавлен в:
- `src/dashboard/server.js` (export, 4 call sites)
- `src/notifications/telegram.js` (5 call sites)
- `src/notifications/alert-dispatcher.js` (2 call sites)
- `src/db/database.js` (registration log)
- `src/support/bot.js` (2 call sites)

### Конфиг и DEPLOY.md

`.env.example` обновлён: `NODE_ENV`, `PUBLIC_BASE_URL`, `TRUST_PROXY`, `DASHBOARD_ALLOWED_ORIGINS`, `ADMIN_ALLOWED_ORIGINS`.

**NEW** `DEPLOY.md` в корне — runbook для деплоя на single-VPS: prerequisites, systemd unit с hardening (NoNewPrivileges, ProtectSystem), nginx конфиг с TLS+SSE, ufw firewall rules, sqlite backup-cron, rolling deploy через `systemctl restart`, pre-launch checklist, post-launch monitoring.

### Smoke-tests прошли

Live HTTP probe подтвердил: HSTS/XFO/XCTO во всех ответах, CORS работает только для allowlist, /verify 429 на 6-й попытке, /initiate 429 на 11-й, dashboard.stop drain'ит SSE и завершается. Production hard-fail срабатывает при пустых критичных env.

---

## 2026-05-04 (Bot UX polish — Stars removal + simplified copy + дефис vs длинные тире)

**Цель**: подготовка телеграм-бота к публичному релизу. Владелец зачищает шероховатости в текстах и удаляет нерабочие платёжные пути.

### Telegram Stars удалены

Раньше было три способа оплаты: Stars (XTR), SOL, USDC. Stars не используется — выпиливаем полностью чтобы не путать пользователя.

Удалено:
- `src/notifications/telegram.js`: `_handleStarsPayment()`, `_setupStarsPayments()` (pre_checkout_query + successful_payment listeners), вызов из конструктора, ветка `if (currency === 'STARS')` в callback-роутере, кнопка `btnPayStars` в `_paymentMethodKeyboard()`, `'pre_checkout_query'` из `allowed_updates`
- `src/config.js`: `telegram.starsTestPrice` / `telegram.starsProPrice`
- `.env`: `STARS_TEST_PRICE` / `STARS_PRO_PRICE`
- `src/i18n/{en,ru}.js`: `btnPayStars`, `starsInvoiceTitle`, `starsInvoiceDesc`

Survived: `currency` колонка в `payments` остаётся generic для SOL/USDC. Исторические записи `currency='STARS'` лежат как read-only артефакты.

### Welcome-сообщение, threshold-screen, payment instructions переписаны

**Welcome** (`src/i18n/{en,ru}.js`): первая строка теперь подзаголовок (`Catalyst - narrative scanner`), value-prop вместо feature-list (`before it's everywhere` / `до того, как она везде`), список свёрнут с 5 до 4 пунктов (слил повторяющиеся "What's happening" + "Plain-language breakdown" → "Why it's spreading"). Каждый пункт переписан с feature на benefit.

**Threshold screen**: "Current: X/100" → "Now: X/100", избыточная вторая фраза-подсказка убрана, `=` в подсказке заменён на `→`. Кнопки: `Low (52+) · more alerts` (число в скобках вместо `· 52+`), `Custom number` → `Custom`.

**Payment instructions**: вместо "Option 1 (Recommended) / Option 2 (Manual)" — `📲 Easy way / ✍️ Manual`. Сумма и адрес в **отдельных `<code>` блоках на отдельных строках** для tap-to-copy. По просьбе владельца "Phantom / Solflare" заменено на "SOL wallet" / "SOL-кошелёк".

### Language picker — только латиница

Кнопки `🇬🇧 English` / `🇷🇺 Russian` (раньше "Русский" кириллицей) и `◀️ Back` (раньше "Back / Назад"). Принцип: на picker-экране юзер должен видеть свой родной язык независимо от текущей локали.

### Длинные тире → обычные дефисы (системно)

Владелец обратил внимание: длинные тире (—, –) — AI-стилистика, люди в чате пишут просто `-`. Заменил во всех user-facing строках.

Файлы: `src/i18n/{en,ru}.js`, `src/notifications/telegram.js` (пользовательские строки `/analyze` help, login сообщение, виральный шаблон), `src/notifications/alert-dispatcher.js:207` (placeholder в admin DecisionsPage), `src/config.js`.

**Tool-trap замечен**: Edit-инструмент при сохранении конвертирует литеральный em-dash в `—` escape, поэтому первый раунд `replace_all` оставил часть в виде Unicode-эскейпов. Второй раунд их добил. Проверка через `Grep —` после правки обязательна.

### "Ask a question" убрана из /start

`_startKeyboard` теперь содержит только `⚙️ Open Menu`. Кнопка поддержки осталась в `_mainMenuKeyboard` (доступна на втором экране) — не торчит на самом первом, чтобы не размывать CTA. Ссылка ведёт на support-bot deep-link через `_supportUrl()`.

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

## 2026-05-02 (Gemini captioner — fix пустого output: safety + thinking)

**Симптом** (от владельца): Gemini никогда не работает — ни в обычном пайплайне, ни в ручном анализе. Логи писали про cooldown / лимиты Google. **Ключевая улика**: в Google AI Studio dashboard видны **только input requests, output ноль**. Значит запрос доходит до Google, тратит input-токены, но возвращает пустой text.

**Корневая причина**: 2 фактора одновременно

1. **Default safety thresholds Gemini 2.5 Flash** режут ответ для memes/reddit/twitter контента → `finishReason: SAFETY`, `text=''`. Мы это ловили общим warn'ом «empty text», но **не логировали `finishReason` / `safetyRatings` / `promptFeedback`** — поэтому корневая причина была невидима.
2. **Dynamic thinking** в Gemini 2.5 Flash (включён by default). Без явного `thinkingConfig.thinkingBudget=0` thinking-токены могут съедать output-budget → пустой `text` при ненулевом `candidatesTokenCount`.

**Изменения** (`src/analysis/gemini-captioner.js`)

- **`safetySettings: BLOCK_NONE`** для всех 4 категорий (HARASSMENT / HATE_SPEECH / SEXUALLY_EXPLICIT / DANGEROUS_CONTENT). Мы description-preprocessor, не контент-хост — нет смысла гасить ответы для мемов
- **`generationConfig.thinkingConfig.thinkingBudget = 0`** — отключаем thinking для vision captioner'а (он не нужен)
- **`generationConfig.maxOutputTokens = 1024`** — явный потолок (было undefined, что делало результат непредсказуемым)
- **Расширенный warn при empty text**: теперь логируем `finishReason`, `promptFeedback.blockReason`, `safetyRatings` (>=MEDIUM или blocked), `tokens=in+out`. Если ещё раз случится — будет видно ЧТО именно блокирует
- **User-Agent** добавлен в HEAD/GET при скачивании медиа. Reddit `v.redd.it` и часть Twitter video CDN режут default Node-UA. Использован тот же Chrome UA что в reddit collector

### Проверка
- `node --check src/analysis/gemini-captioner.js` ✓

### Follow-up: длина videoSummary через промпт (после первого деплоя)

После того как фикс заработал, владелец заметил что `videoSummary` режется посреди слова в админке. Корень — hardcoded `slice(0, 250)` в коде vs `≤200 chars` в промпте. Перенёс контроль длины из кода в промпт:

- **Промпт переформулирован**: `≤200 chars` → `2-3 complete sentences` (для videoSummary), `≤300 chars` → `1-2 complete sentences` (для visualCaption)
- **Добавлен CRITICAL LENGTH RULE**: «every field must be a COMPLETE thought ending with proper punctuation. Never cut mid-sentence or mid-word»
- **Slice'ы в коде** оставлены как safety-net против runaway-моделей: 250→800 (videoSummary), 400→800 (visualCaption), 200→600 (visibleText). Mood остался 60 (1-3 слова — никогда не больше)
- **OpenRouter fallback ветка** синхронизирована (те же лимиты)

### Риски / заметки
- **`BLOCK_NONE` через API**: для большинства аккаунтов это валидно (gemini-2.5-flash, generative-language API). Если проект включён в особые ограничения — придётся вернуть `BLOCK_ONLY_HIGH`. Симптом — 400 INVALID_ARGUMENT с упоминанием `safety_settings`. Логи теперь это покажут
- **Не трогал** Reddit `_bestImage` баг (пункт 3 возвращает `reddit_video_preview.fallback_url` = видео-URL, не картинка) — после safety-fix Google native video должен работать, fallback на постер задействуется реже. Если после деплоя останутся проблемы с reddit-видео фолбэком — править отдельным PR
- **Не трогал** cooldown counter — он считает все возвраты null от `_tryGoogleMedia` как Google failure (включая локальные download/sniff fail). После safety-fix частота null упадёт, но архитектурно counter мис-диагностирует. Backlog
- **Длина текстов** в Stage 1 prompt (`prompts.js:127-129`) — теперь visualCaption/videoSummary в `detail` строке могут быть длиннее. Не критично (Stage 1 batch promp всё равно 8-10K токенов суммарно), но если надо экономить — добавить trim там же

---

## 2026-05-02 (Admin StatusBar — pipeline в топбаре)

**Цель**: убрать декоративные шилды (RUNNING / age / preset) из топбара админки и перенести туда live-pipeline визуализацию (раньше была отдельной секцией только в ScannersPage).

### Изменения (`src/admin/server.js`)

- **StatusBar переписан** (~110 строк): теперь содержит логику бывшего `PipelineFlow` — polls `/api/pipeline` каждые 2.5с, рендерит 8 stage-нод + 7 wires в горизонтальный ряд справа от заголовка.
  - Левая часть: **🔄 Пайплайн** + subtitle с динамическим состоянием (`Live — Stage 1...` / `Последний цикл 12с назад (за 4.3с)` / `⏸ Сканер на паузе`).
  - Правая часть: компактные ноды (54×46 px, icon + count) + thin wires.
  - Active-нода: glow + pulse animation. Done-нода: muted accent border.
  - Active-wire: gradient sweep + shadow + opacity pulse.
  - Tooltip на ноде: `Stage 1 · gpt-5.4-mini` (показывает реальную модель цикла).
- **`PipelineFlow` компонент удалён** (~117 строк) — логика переехала в StatusBar.
- **`<PipelineFlow />` render из ScannersPage удалён** — теперь видна на каждой странице через топбар.
- **`.pflow-*` CSS удалён** (~27 правил, 27 строк).
- **`.shell-badge` CSS удалён** (бывшие шилды) — заменён `.sb-node / .sb-wire / .sb-head / .sb-pipeline / .sb-live-dot / .sb-paused` namespace.
- **`.topbar-actions` CSS удалён** — больше не нужен.
- **Responsive**: при `max-width: 1100px` топбар flex-direction column → пайплайн оборачивается под заголовком (на узких экранах).

### Проверка
- `node --check src/admin/server.js` ✓
- `scripts/check-admin-spa.cjs` ✓ (182366 chars, −2851 vs предыдущая)
- File: 5746 → 5679 строк (−67)

### Риски / заметки
- Polling вырос с 8с до 2.5с — но это та же частота что была у standalone PipelineFlow раньше, нет роста нагрузки vs PR-3 baseline.
- На очень узких экранах (<900px) ноды могут чуть наезжать друг на друга — wire `min-width:8px` это компенсирует, но если будет некомфортно, можно понизить до 6px.

---

## 2026-05-02 (Admin полный refactor — 4 фазы)

**Цель**: владелец заказал «улучшим админку полностью — добавим то чего не хватает, уберём лишнее, можно подкорректировать визуал, но не клонируя дашборд». PreStage не трогать.

Файл `src/admin/server.js`: 5895 → 5746 строк (-149 net; в реале вырезано ~330 строк мусора + добавлено ~180 строк новой функциональности).

### Фаза 1 — Cleanup (-280 строк дохлого кода)

- **`FilterProfilesSection`** (компонент + `_getFilterProfiles`/`_setFilterProfiles` методы + 4 импорта из `filter-profiles.js` + `FILTER_PRESET_META` const + `/api/filter-profiles` GET/POST handler) — мёртвое с PR-2, вынесли всё.
- **Дубликат-карточка «Управление рассылкой»** в BotPage (3464-3483): broken paste с кнопками `sendBroadcast` где должно быть `manageBroadcast`. Удалён.
- **4 unused user endpoints**: `PUT /api/users/:id`, `/users/:id/extend`, `/users/:id/block`, `/users/:id/unblock` — заменены `/subscription/grant|revoke` + `/status` ещё в PR-2.
- **«Очистить алерты»** перенесён с PaymentsPage на StatsPage в новую карточку **🧹 Обслуживание базы** (red-tinted .maintenance-card). Платежи != алерты — был семантический мисматч.
- **CSS-токены**: добавлены `--text3 / --muted / --border2 / --border3 / --accent-rgb / --accent-glow / --gloss-top / --shadow-card / --radius-*` в `:root`. До этого использовались, но не определялись → тихо ломали цвета в 6+ местах.

### Фаза 2 — Визуал и единые примитивы

- **Палитра**: оставлен характерный teal `#14b8a6`, добавлены `--accent-soft #5eead4`, `--accent-tint`, полные `*-rgb` тройки для всех state-цветов, full muted ramp (`--text2/3 / --muted / --dim`), full border ramp. Радиусы и shadow токенизированы.
- **`.card` hover-lift**: subtle `translateY(-1px)` + brighter border на ховере. Раньше карточки были полностью статичны.
- **Единый `.adm-tabs / .adm-tab / .adm-tab-count / .adm-tab-dot`**: свернули `exp-tabs` (ExamplesPage) и `pcfg-tabs` (PresetConfigsPage) в один namespace. Модификаторы `.bordered` (нижний border) и `.capitalize` (для preset-табов).
- **`<Section>` примитив** (~20 строк): обёртка с `icon`/`title`/`desc`/`actions`/`children`. CSS-классы `.adm-card-head / -title / -title-ico / -desc / -actions`. `broadcast-box` массово переименован в `adm-card` (15 usages) — он используется как universal section wrapper, имя теперь корректное.
- **DecisionsPage инлайн-стили → классы**: было ~100 inline `style={{...}}` блоков (нечитаемо). Извлечён `.dec-*` namespace (~26 правил): `.dec-card.sent/.skipped`, `.dec-row1`, `.dec-time/title/verdict`, `.dec-meta-row`, `.dec-atype-chip.event/.trend/.post`, `.dec-eng-chip`, `.dec-gate-chip.passed/.failed`, `.dec-breakdown`. JSX стал в 2× компактнее, перестилизация теперь тривиальна.

### Фаза 3 — Переструктурирование

- **BotPage → 3 под-таба**: 7 разнородных карточек (AI / Broadcast / Manage / History / Plans / Feedback weights / Recent reasons) на 450 строк прокрутки → 3 фокусированных вью через `subTab` state и `.adm-tabs.bordered` стрип. Карточки получили guards `subTab === 'ai|broadcasts|plans' && ...`.
- **`<StatusBar>`** в `<main>` topbar: пингует `/api/pipeline` + `/api/scanner-config` каждые 8 сек, показывает `🟢 RUNNING / ⏸ PAUSED / 🟡 IDLE` шилд + время с последнего цикла + active preset + текущий stage. Клик по live-state-шилду переходит на Сканеры. Использует осиротевший `.shell-badge` + добавлены state-варианты `.running` / `.paused`.
- **Live-индикаторы в сайдбаре**: poll каждые 12 сек в App. Жёлтый pulsing dot на табе «Сканеры» когда сканер на паузе. Numeric badge на табе «Алерты» с количеством решений в буфере. CSS `.nav-dot` (с `nav-pulse` keyframes) + `.nav-badge` (accent-tinted pill).

### Фаза 4 — Полишинг

- **«Краткие выводы» в StatsPage снесён**: filler-текст + дублировал данные «Размер БД» из верхних KPI. Active rate / Paid share / Доход lifetime инлайнены в карточку «Срез по хранению и метрики». `stats-bottom-grid` сменил layout с 2-col на 1-col.
- **UsersPage action-column → row-expand drawer**: 5 контролов в 420px-wide колонке (overflow на ноутах) → одна `⚙` кнопка на строку, клик открывает drawer-row снизу с двумя группами «Подписка» (plan select + days input + Выдать/Снять) и «Статус» (Заблокировать/Разблокировать). State `expandedId` (только одна строка открыта). CSS `.row-open / .row-drawer / .user-actions / .user-actions-group / .user-actions-label`.
- **Theme switcher** — пропущен. Админка по дизайну операторский тёмный инструмент, light-тема дала бы little value за большое количество правок CSS.

### Проверка
- `node --check src/admin/server.js` ✓
- `scripts/check-admin-spa.cjs` ✓ (185217 chars)
- Все 9 страниц open-able через нав, no JSX errors

### Риски / заметки
- StatusBar полит каждые 8 сек = ~2× HTTP вызова на цикл. Минимум на сервере.
- Sidebar polling каждые 12 сек = ~1.5× в минуту, очень мало.
- BotPage subTab state in-memory — при смене таба обнуляется. Если оператору важно «зашёл — продолжил с того где был», добавить sessionStorage-пост позже (не критично).
- `<Section>` компонент **определён**, но не использован внутри pages — это будущий шаг рефакторинга. На существующие adm-card он не влияет.

---
## 2026-05-02 (Source icons — настоящие SVG-логотипы)

**Цель**: владелец хотел оригинальные бренд-логотипы в `.source-icon` чипах. Letter-marks (R/G/𝕏/♪/#) хороши, но не выглядят как настоящие лого. Делаем inline SVG.

### Изменения (`src/dashboard/server.js`)

- **Новая константа `SOURCE_LOGOS`** рядом с `SOURCE_ICONS` (~line 4862): single-color SVG paths из simpleicons.org public-domain набора.
  - **reddit**: оригинальный Snoo (alien-голова в круге, ушки + глазки + улыбка)
  - **google_trends**: G-mark (single-color shape Google G)
  - **twitter**: X glyph (canonical post-rebrand X mark)
  - **tiktok**: music note silhouette с характерным «d»-хвостом
  - **x_trends**: hashtag (`#`) — что трендится в X
  - Все с `fill="currentColor"` → берут цвет от родительского чипа (per-data-src CSS color).
- **Компонент `SourceMark({ src, fallback })`** (~line 5070): рендерит `<span class="src-mark-svg" dangerouslySetInnerHTML="<svg>...</svg>" />` если SVG доступен; fallback на letter-mark из `SOURCE_ICONS`.
- **CSS `.src-mark-svg`** (~line 1990):
  - `width/height: 60%` от родителя (16px в 26px чипе, 22px в 38px feed-avatar)
  - Twitter X glyph чуть меньше (56%) — он от природы тонкий и высокий, оптически смотрится крупнее.
  - Feed-avatar: 58% (в более крупном чипе хочется немного breathing room).
- **Render-сайты**:
  - `.source-icon` в sidebar source-list — `SourceMark` напрямую.
  - `.feed-avatar` в `TrendCard` — `SOURCE_LOGOS[src] ? SourceMark : srcIco` (чтобы для unknown source осталась emoji-fallback).
- **Не трогал**: inline usage в top-narratives meta (`SOURCE_ICONS[tr.source]`), telegram-keyboard, ManualHistory hero — там текстовый glyph rendered inline, SVG был бы overkill.

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (175582 chars, +3375 vs предыдущая)

### Риски / заметки
- `dangerouslySetInnerHTML` с приходом из локальной const-таблицы — XSS-чисто (никакого user-input). React's tree теперь рендерит `<span><svg>...</svg></span>`.
- Backticks в SVG strings отсутствуют → SPA-template-literal trap не сработал. Все SVG-paths написаны как single-line single-quoted строки в JS object literal.
- SVG paths занимают ~3KB символов в SPA bundle — приемлемо для 5 brands. Альтернатива (отдельный endpoint `/api/icons/<src>.svg`) добавила бы 5 round-trips на загрузку дашборда.

---

## 2026-05-02 (Source icons — letter-marks + remove eye glyph)

**Цель**: улучшить иконки источников в сайдбаре (и в pulse-rows справа); убрать смайлик глаза `👁/🙈` который при hover'е перекрывал счётчик постов справа.

### Изменения (`src/dashboard/server.js`)

- **`SOURCE_ICONS` global** (line ~4855): emoji → brand letter-marks.
  - `🟠 → R` (Reddit)
  - `🔍 → G` (Google)
  - `𝕏 → 𝕏` (Twitter/X — оставлен)
  - `🎵 → ♪` (TikTok)
  - `📈 → #` (X Trends — хэштег = что трендится)
  - Letter-marks read как brand glyphs, рендерятся crisp на любом размере, не зависят от font-эмодзи stack'а.
- **CSS `.source-icon` + `.pulse-icon`** (синхронно):
  - Размер 22→26 px, font-weight 600→800, font-size 12→13.5 px (16 px для `♪` чтобы выровнять оптически).
  - Per-data-src `color` в brand-цвете: reddit `#ff5800`, google `#4285f4`, twitter `#fff`, tiktok `#ff2469`, x_trends `#1d9bf0`.
  - Border alpha поднят (`.25 → .36-.42`) для чёткого контура.
  - `box-shadow: var(--gloss-top)` — лёгкий highlight сверху.
  - `.source-item:hover .source-icon { transform: scale(1.05) }` — едва заметная анимация hover'а (без layout shift).
- **`.source-eye` удалён**:
  - CSS-правило (~5 строк) убрано.
  - `<span className='source-eye'>` из render'а в источниках удалён.
  - Замена-сигнал не нужен: `.source-item.off { opacity: .5 }` + `.source-item.off .source-icon { filter: grayscale(1) }` уже визуально показывают off-state. Раньше глаз `👁` приземлялся прямо на цифру счётчика postов (тот тоже `position: absolute; right: 8px`).

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (172207 chars)

### Риски / заметки
- `SOURCE_ICONS` используется глобально (TrendCard avatar, modal, pulse-rows, top sources strip, telegram-keyboard). Letter-marks отлично смотрятся в `.feed-avatar` (brand-gradient bg + white letter), inline в top-narratives meta тоже читабельно (`R · phase · 50 vrl`).
- Не trogал `SOURCE_LABELS` / `SOURCE_LINK_LABELS` — это полные имена («Reddit», «Twitter/X»), они отдельная роль.
- Fallback `'📡'` оставлен — если в БД появится новый source, не сломается.

---

## 2026-05-02 (Dashboard sidebar — кастомный dropdown категорий)

**Цель**: улучшить визуал внутри секции **КАТЕГОРИЯ** в сайдбаре дашборда + поменять эмодзи возле названия. Старая реализация — нативный `<select>`, у которого открытая option-панель полностью paint'ится chromium UA (тёмная синева на скриншоте) и игнорирует CSS. Не вписывался в X-style monochrome тему.

### Изменения (`src/dashboard/server.js`)

- **Эмодзи**: `📂 Категория` → `🏷️ Категория` (RU + EN i18n). Bookmark-tag тематически точнее под «category».
- **Новый компонент `CategoryDropdown`** (~70 строк) рядом с `PhaseBadge` (~line 4968):
  - Trigger-button показывает текущую категорию: `🏷️ icon + label + ▾`. На placeholder — `◆ + "Все категории"` в muted-цвете.
  - Click → animated `cat-dd-panel` (slide-in 140ms): «Все категории» reset-row + divider + список реальных категорий из `CAT_ICONS`.
  - Click-outside (mousedown) и Esc закрывают; useEffect привязан к `[open]`.
  - Active option: `var(--accent-glow)` фон + accent left-border + `✓` справа.
  - Hover: лёгкий white-alpha overlay + scale(1.08) на иконке.
- **CSS namespace `.cat-dd-*`** (~110 строк, после блока `select`):
  - `.cat-dd-trigger` — gloss-top shine, accent-glow при `.open`, rotated caret. Caret `▴` (закрыт) → `▾` после 180deg flip (открыт).
  - `.cat-dd-panel` — **открывается ВВЕРХ** (`bottom: calc(100% + 5px)`) потому что `CategoryDropdown` сидит в самом низу sidebar-а рядом с BottomNav. Падающее вниз меню перекрывало бы footer. z-index 50, max-height 320px со styled scrollbar (thin, accent thumb), shadow `0 -12px 40px` (свет сверху). Animation `cat-dd-slide-up` — слайд снизу вверх.
  - `.cat-dd-opt` — accent left-border ::before, scale-on-hover icon.
- **Замена в render**: `h('select', ...)` → `h(CategoryDropdown, { value, onChange, categories: Object.keys(CAT_ICONS) })`.

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (171905 chars, +2927 vs предыдущая)

### Риски / заметки
- Native `<select>` стиль (`select { ... }` в CSS) **остался** — используется в других местах (e.g. админ-формы, settings panel). Не трогал.
- z-index 50 может конфликтовать только с modal sheet (`backdrop-filter`); modal перекрывает sidebar полностью, поэтому конфликта быть не должно.
- Mobile/touch: click-outside через `mousedown` работает на touch-устройствах (chrome/safari fire mousedown perevent default).

---

## 2026-05-01 (Dashboard sidebar — multi-select для фазы и типа)

**Цель**: в окнах **ФАЗА** и **ТИП** в сайдбаре дашборда сделать одновременный выбор нескольких чипов. Старое поведение — только один чип активен; клик на новый сбрасывал предыдущий. Чип «Все» остаётся exclusive — клик по нему всегда сбрасывает множество в пустое состояние.

### Изменения (`src/dashboard/server.js`)

**Серверная сторона** (`_handleTrends`):
- `?phase=early` → `?phase=early,forming,strong` (CSV); невалидные значения отфильтровываются.
- SQL: было `JSON_EXTRACT(...) = ?`, стало `IN (?,?,...)` — параметры пушатся динамически.
- Backwards-compat: одиночное значение `?phase=early` парсится как массив с одним элементом → ведёт себя идентично прежнему.

**Клиентский state**:
- `phase` (string) → `phases` (отсортированная CSV-строка, `''` = все). Persist в `localStorage.ts_phase_filter`.
- `alertTypeFilter` (string) → `alertTypes` (отсортированная CSV-строка, `''` = все). Persist в `localStorage.ts_alert_type_filter`. Старые single-value entries остаются валидными как 1-элементный CSV.

**Сайдбар-чипы** (обе секции):
- Чип «Все» (`◆`) активен когда CSV пустой; клик — сбрасывает CSV.
- Каждый цветной чип (early/forming/strong/saturated, event/trend/post) теперь toggle: добавляет/убирает свой ключ из CSV.
- Отрисовка через IIFE внутри `h('div', { className: 'sidebar-phase' }, ...)` — IIFE возвращает массив элементов (React flattens), а manual-only chip остался отдельным sibling-аргументом.

**Visible feed**:
- `visibleTrends` для alert-types фильтрует через `Set(alertTypes.split(','))`. Wildcard для legacy-rows без `alertType` сохранён.
- Phase-фильтр уходит на сервер через query (как раньше), просто многозначный.

**Reset-link** (`Сбросить`):
- Активен если CSV непустой (или manual-toggle включён в случае alert-type секции).
- Очищает CSV + localStorage + (для phase) сбрасывает `offset`.

### Проверка
- `node --check src/dashboard/server.js` ✓
- `scripts/check-dashboard-spa.cjs` ✓ (168978 chars, +2620 vs предыдущая версия)

### Риски / заметки
- Деплой не делал — пользователь триггерит через `.\deploy.ps1`.
- Backwards-compat для localStorage: сохранённые старые ключи (`'event'`, `'early'`) парсятся как 1-элементный CSV. Сброс не нужен.
- Сервер тоже принимает single-value (`?phase=early`) — старые bookmarks/clients не сломаются.

---

## 2026-05-01 (X Trends collector — новая платформа)

**Цель**: добавить X Trends (trending hashtags / topics с x.com) как **5-ю платформу** в pipeline, наравне с Reddit / Twitter / TikTok / Google Trends. Со своим коллектором, своим source-id (`x_trends`), своими per-preset настройками и UI-секцией.

**Принципиальное отличие от существующего Twitter collector'а** (`src/collectors/twitter.js`):
- Twitter collector делает **TWEET SEARCH** через Apify-актёров `kaitoeasyapi` / `xquik` (отдельные tweets)
- X Trends collector делает **TRENDS LIST** через `karamelo/twitter-trends-scraper` (топики/хэштеги)

### Источник данных

- **Apify actor**: `karamelo~twitter-trends-scraper` ($0.29 / 1000 results, 5★, 1.1K юзеров)
- **Стоимость**: ~30 трендов × 48 запусков/день × $0.00029 ≈ **$13/мес** (default refresh 30 мин)
- **Country**: hardcoded `United States` (English priority — единственный язык в US-trends списке)
- **Output shape (от актёра)**: `{ trend, time, timePeriod, volume }` — `volume` чаще всего пустая строка (X не экспонит публично), поэтому `minTweetVolume` фильтр **не реализован** — полагаемся на `rank` (array index) + AI-скоринг

### Архитектура коллектора (`src/collectors/x-trends.js`, ~210 строк)

- Class `XTrendsCollector extends BaseCollector`
- **Internal refresh timer** (`setInterval`, default 30 мин, `X_TRENDS_REFRESH_MINUTES` env) — decoupled от scanner cycle (~90 сек). Тренды реально обновляются раз в 15-30 минут, нет смысла дёргать чаще
- **Cache в памяти** `_cache: { fetchedAt, items }` — последний успешный Apify-результат
- **Dedup map** `_emitted: Map<slug, ts>` с TTL 6 часов. Re-emit если тренд исчезал и появился снова (signal of resurgence). Cap размера через GC старых ключей
- **`_inFlight` mutex** — coalesce concurrent refreshes (timer + sync fallback)
- **`startRefreshTimer()`** запускается в `index.js` constructor сразу после регистрации в `collectors[]`
- **`collect()`** на каждом scanner-cycle: читает per-preset config (`enabled` / `topN`), берёт top-N из cache, фильтрует через `_emitted`, возвращает diff
- **`stopRefreshTimer()`** — для graceful shutdown (пока не используется, но готово)

### Schema — `sources.xtrends` namespace

В `preset-config.js` добавлены 2 поля:
- `xtrends.enabled` (int 0/1) — per-preset toggle. UI рендерит как slider 0..1 (можно потом на toggle переписать, но с таким же эффектом)
- `xtrends.topN` (int 5-50, step 5) — сколько верхних трендов брать с каждого fetch

**Per-preset defaults**:

| Preset | enabled | topN | Reasoning |
|---|---|---|---|
| general | 1 | 20 | broad cast |
| animals | 1 | 10 | животные редко в top trends |
| culture | 1 | 25 | мемы спайкают быстро |
| celebrities | 1 | 25 | celebs часто доминируют |
| events | 1 | 30 | события flood'ят trending |

### Item shape для pipeline

```js
{
  source: 'x_trends',
  externalId: 'xtrends-us-<slug>-<YYYYMMDDHH>',  // hourly bucket → DB-dedup catches re-emits within hour
  title: 'Good Friday',                            // raw trend name
  description: 'Trending #1 on X in United States (Live).',
  url: 'https://x.com/search?q=Good%20Friday&src=trend',
  author: 'x_trends',                              // pseudo to satisfy downstream code
  timestamp: <ISO>,
  metrics: { rank: 1, country: 'United States', timePeriod: 'Live', tweetVolume: null }
}
```

Идёт через **тот же** pipeline что обычные посты: `Aggregator → cheapDedup → PreStage → Clusterer → Stage 1 → Stage 2 → alert-loop`. Никаких изменений в scorer/clusterer/prompts — Stage 1 видит обычный item, скорит memePotential по title. Stage 2 (Grok x_search) делает deep-dive на топик при passing.

### Wiring во все компоненты

- **`src/index.js`**: импорт + `new XTrendsCollector(config, logger, db)` + если `enabled` → `collectors.push(...)` + `startRefreshTimer()`
- **`src/dashboard/server.js`**:
  - `_handleSources` → массив включает `'x_trends'`
  - `SOURCE_ICONS['x_trends'] = '📈'`
  - `SOURCE_LABELS['x_trends'] = 'X Trends'`
  - `SOURCE_LINK_LABELS['x_trends'] = '📈 X Trends'`
  - CSS `.feed-avatar.x_trends`: linear-gradient `#1d9bf0 → #0a0a0a` (X-blue + ink)
  - CSS `.source-item[data-src="x_trends"]` + `.pulse-row[data-src="x_trends"]` — синяя tint
  - URL ведёт на x.com → переиспользуем `trend-link-twitter` className
  - `sourceOrder` (Stats) включает x_trends
  - Refactored hardcoded source-icon mapping в analyze hero на `SOURCE_ICONS[]` lookup (заодно убрана дубликация)
- **`src/notifications/telegram.js`**: `_sourcesKeyboard` allSources массив включает `'x_trends'`
- **`src/i18n/{ru,en}.js`**: `sourceNames.x_trends = 'X Trends'`
- **`src/admin/server.js`** SPA `SourcesAccordion`: новый sub-section `📈 X Trends` (4-й, перед Google Trends) — banner с описанием и стоимостью + 2 PSlider'а (enabled / topN)

### Env vars (`.env.example`)

Новый блок «X TRENDS»:
```
X_TRENDS_ENABLED=1               # global kill switch
X_TRENDS_REFRESH_MINUTES=30      # 5-onwards. Lower = fresher / pricier
X_TRENDS_COUNTRY=United States   # also: 'United Kingdom', 'Worldwide', 'Japan'
APIFY_X_TRENDS_ACTOR_ID=karamelo~twitter-trends-scraper
APIFY_X_TRENDS_KEY=              # optional, falls back to APIFY_API_KEY
```

### Smoke-test (на реальных sample-данных от оператора)

```
[XTrends] refreshed: 5 trends from United States
source: x_trends
  externalId: xtrends-us-goodfriday-2026050111
  title: Good Friday
  description: Trending #1 on X in United States (Live).
  url: https://x.com/search?q=Good%20Friday&src=trend
  metrics: { rank: 1, country: 'United States', timePeriod: 'Live', tweetVolume: null }
... (4 more)
Re-collect (dedup test): 0 items (expected: 0)
```

Парсер корректно обрабатывает trends с пустыми volume, dedup отрабатывает на повторном вызове.

### Operational notes

- **Если actor лёг / 429**: `_refresh()` логирует warn, `collect()` возвращает старый cache (или [] если cache пуст). pipeline продолжает работать без X Trends
- **Hourly externalId bucketing**: тот же тренд в том же часу = тот же ID → DB-dedup catches. Через час → новый ID, тренд может re-enter pipeline (ловим resurgence)
- **In-memory `_emitted` survives только в рамках процесса**. После рестарта Docker'а первый цикл может re-emit-нуть тренды что были до. Не страшно — DB hourly-bucket externalId всё равно их свяжет
- **Stale cache fallback**: если timer заглох (host suspend/resume, etc) и cache старше 2× refresh interval, `collect()` делает sync refresh inline. Защита на edge cases

### Проверка

- `node --check` × 6 файлов: OK
- `check-admin-spa.cjs`: 190 755 chars (+983 от X Trends UI)
- `check-dashboard-spa.cjs`: 166 333 chars (+86 от source labels)
- Smoke-test парсера на реальных данных: PASS
- Round-trip preset-config validator: defaults стрипаются до `{}`

**Деплой**: `.\deploy.ps1` → через ~5 секунд Apify-запрос, через ~30 сек первые items в pipeline, через ~90 сек первые `x_trends` карточки в дашбоде с источником `📈 X Trends`.


## 2026-05-01 (per-preset pipeline configs — PR-1/2/3 + Grok-audited tuning)

**Цель**: до этой работы каждый из 5 пресетов (`general/animals/culture/celebrities/events`) имел только per-preset junk-filter (через старый `filterProfiles`). Всё остальное — alert thresholds / weights / stale decay / cluster-similarity / коллекторские источники — было либо глобальным, либо хардкодом в `.js` файлах. Цель: **полностью per-preset pipeline tuning** через единый JSON-блоб + admin UI.

**Архитектура** (3 PR'а в одной сессии):

### PR-1 — Foundation

**Новый модуль** `src/analysis/preset-config.js` (~470 → 540 строк после PR-1 helper'ов):
- `PRESET_KEYS` — `['general', 'animals', 'culture', 'celebrities', 'events']`
- `PRESET_GROUPS` — `['sources', 'junk', 'alerts', 'cluster']` (порядок аккордеонов в UI)
- `PRESET_FIELD_RANGES` — метаданные полей: тип (`int`/`float`/`list`), min/max/step, label/desc для UI, флаг `positive: true` для weight-полей которые входят в Σ ≤ 1.0 budget
- `DEFAULT_PRESET_CONFIGS` — полные defaults для всех 5 пресетов. Структура:
  ```
  { <preset>: {
      sources: { reddit: {...}, twitter: {...}, tiktok: {...}, googletrends: {} },
      junk:    { politicsPenalty, kpopPenalty, ... },
      alerts:  { thresholds: {...}, weights: {...}, stale: {...} },
      cluster: { simThreshold, weightEmbedding, ... }
  } }
  ```
- `resolvePresetConfig(preset, overrides)` — deep-merge defaults + per-preset patch (immutable, frozen defaults preserved)
- `getActivePresetConfig(db)` — one-stop helper для consumer'ов: читает active preset из settings + резолвит
- `validatePresetOverrides(input)` — strict validation: range-check каждого leaf, drop полей равных default (compact blob), assert Σ POSITIVE ≤ 1.0 для `alerts.weights` и `cluster`
- `readPresetOverrides(db)` — tolerant JSON-read из settings
- `getEffectivePresetConfigs(overrides)` — таблица для UI

**DB миграция** (`src/db/database.js`, marker `presetConfigsMigratedV1`):
- One-shot: читает legacy `filterProfiles` + 13 глобальных `alertThreshold`/`alertWeight*`/`alertStaleDecay*`/`alertHardJunkStop`/`maxAlertsPerCycle`/`minScoreToSave`
- Если значение отличается от defaults → копирует во ВСЕ 5 пресетов (preserve existing operator behavior)
- Прогон через `validatePresetOverrides` → стрипает совпавшие с new defaults (compact blob)
- Legacy глобальные ключи **не удаляются** — остаются как fallback на время transition

**Endpoints** (`src/admin/server.js`):
- `GET /api/preset-configs` → `{ defaults, effective, overrides, fieldRanges, presets, groups }`
- `POST /api/preset-configs` `{ overrides }` — гейт через существующий `X-Admin-Key` (admin server и так operator-only by design — не нужен отдельный custom gate)
- `_getPresetConfigs()` / `_setPresetConfigs(body)` helpers, параллель к существующим filterProfiles

**Минимальный UI** (PR-1 ship): `PresetConfigsPage` с tab strip пресетов + большой JSON textarea redactor для overrides + read-only inspector panes (defaults / effective / overrides). Заменён в PR-3 на полноценный UI.

### PR-2 — Consumer wiring

**Все читатели переключены на резолвер**:

| Файл | Что меняется |
|---|---|
| `analysis/scorer.js` | `loadAlertWeights(db)` теперь читает per-preset (`alerts.weights/.stale/.thresholds.alertHardJunkStop`). Backward-compat: без `db` → DEFAULT_ALERT_WEIGHTS |
| `analysis/clusterer.js` | constructor больше **не** читает `clusterSimThreshold`/`clusterWeight*` — снапшотятся в `_refreshClusterParams()` в начале каждого `route()`. Junk-filter call site строит `{ [activePreset]: cfg.junk }` blob из preset-config'а вместо чтения legacy `filterProfiles` |
| `collectors/reddit.js` | `_resolveRedditConfig()` per-cycle: `subreddits` / `minUpvotes` / `postsPerSubreddit` из preset config. Env-overrides (`config.reddit.*`) сохранены приоритетом |
| `collectors/twitter.js` | `_getQueries()` читает `sources.twitter.queries` per-preset. Env-override `customQueries` приоритетен |
| `collectors/tiktok.js` | `_getHashtags()` читает `sources.tiktok.hashtags` per-preset. Попутно фикс pre-existing бага: старые `PRESET_HASHTAGS` имели keys `general/animals/ai/elon/sports` — не матчили `PRESET_KEYS`, culture/celebrities/events падали в `general` |
| `index.js` (alert-loop) | `alertThreshold` (floor), `maxAlertsPerCycle`, `minScoreToSave` читаются из active preset config (`getActivePresetConfig(db).alerts.thresholds.*`) |

**Cleanup global allowed-lists** (атомарно с consumer wiring):

- Admin `_setScannerConfig` allowed-list trimmed: убраны 13 полей (`alertThreshold`, `minScoreToSave`, `maxAlertsPerCycle`, `alertHardJunkStop`, 6×`alertWeight*`, 3×`alertStaleDecay*`). Оставлены только orthogonal global knobs: `twitterMaxAgeHours`, `rescoreCooldownHours`, `stage2Threshold`, `stage2MaxCalls`
- Admin `_getScannerConfig` GET shape — те же поля убраны из ответа
- Dashboard `_handleSettings*` allowed-list — убран `alertThreshold` / `minScoreToSave` / `maxAlertsPerCycle`. User-level `users.alert_threshold` через `/api/user/threshold` остался (per-user, не глобальный)

**UI cleanup в `ScannerConfigSection`**:
- Удалены 4 sub-секции (Alerts thresholds / Weights / Stale decay / Storage)
- Заменены на единый banner «Алерты, веса, stale-decay, junk и cluster — теперь в табе Пресеты»
- `FilterProfilesSection` removed из `ScannersPage` рендеринга (компонент остался в файле для возможного rollback)
- `JunkStatsSection` оставлен — observability полезна

### PR-3 — Полноценный admin UI

**`PresetConfigsPage` переписан с нуля** (~600 строк UI + ~50 строк CSS):
- **Tab strip** — 5 пресетов, override-индикатор `●` если есть overrides
- **4 раскрывающихся аккордеона** (`<details>`) на активный пресет:
  - **📡 Sources** (открыт по дефолту): per-platform sub-sections — Reddit (chip-input subreddits + 2 sliders) / Twitter (chip-input queries) / TikTok (chip-input hashtags) / Google Trends (placeholder)
  - **🚫 Junk filter**: 6 sliders
  - **🔔 Alerts** с 3 саб-секциями: Thresholds (4 sliders) / Weights (5 budget-clamped + SumMeter + junk multiplier отдельно) / Stale decay (3 sliders)
  - **🧬 Cluster**: 2 простых slider'а + 4 budget-clamped weight slider'а с SumMeter
- **Component primitives**:
  - `PSlider` — slider row с override-dot + reset-to-default `↺` button
  - `BudgetSlider` — clamps onChange к remaining budget (Σ positive ≤ 1.0). Показывает `⛔` когда atLimit
  - `PChips` (через `ChipInputBox`) — chip-input для list fields с Enter/blur/Backspace
  - `SumMeter` — live read-only Σ для budget группы (получает `getEffective` через prop drilling)
- **Draft mutators**: `setLeaf` walks/creates path в draft, drops leaf если value == default, GC empty parent objects вверх по chain
- **Actions row**: Save / Reload / Reset preset «X» / Clear ALL
- **Debug fallback** в `<details>`: 3 inspector pane'а (defaults / effective / draft) для активного пресета

**CSS**: новый namespace `.pcfg-*` (.pcfg-tabs / .pcfg-accordion / .pcfg-row / .pcfg-chip / .pcfg-budget / etc) — параллельно `.scfg-*`, без коллизий.

### Post-Grok-audit tag/slider tuning

После завершения PR-1/2/3 — **массовое обновление дефолтов** через `DEFAULT_PRESET_CONFIGS`:

**Структурное**: убраны shared константы `DEFAULT_ALERTS` + `DEFAULT_CLUSTER` (раньше все 5 пресетов делили identical alerts + cluster). Каждый пресет получил полный самодостаточный набор.

**Tuning rationale per preset**:
- **general**: broad net, mixed lifespan, balanced weights
- **animals**: slow lifespan (cute capybara stays cute), low density, **meme-dominant** (memePotential=0.45). phash heavy в кластере (visual matching), gentle stale-decay (per-hour=1, grace=48h, cap=20)
- **culture**: short lifespan (memes die fast), very high density, **meme-dominant** (0.45), phash + embedding equally heavy в кластере (0.40 каждый), aggressive stale-decay
- **celebrities**: short lifespan, very high density, **virality-dominant** (0.30). Strict junk-multiplier (0.55) — celeb-noise floods otherwise
- **events**: hours-long lifespan (news rots), medium density, **emergence-dominant** (0.35). embedding+entity heavy в кластере (event = many framings of same news), very aggressive stale-decay (per-hour=5, grace=6h, cap=60), short cluster window (timePenaltyHours=6)

**Σ POSITIVE invariant**: для `alerts.weights` (5 positive) и `cluster.*` (4 positive) во всех 5 пресетах = **ровно 1.00**. Validated automated.

**Sources update** (post-Grok аудит):
- **Reddit general**: убраны `interestingasfuck` + `Damnthatsinteresting` + `BeAmazed` (overlap / low activity), добавлены `funny` + `mildlyinteresting` + `wholesomememes`
- **Reddit animals**: добавлены `FunnyAnimals` + `AnimalMemes` (рост 2024-2025)
- **Reddit culture**: добавлены `ContagiousLaughter` + `HolUp` + `196` (свежие meme-сабы). `TikTokCringe` оставлен (Grok хотел убрать — но это ценный TikTok→Reddit propagation signal)
- **Reddit celebrities**: убран `hiphopheads` (overlap с popheads), добавлены `kpop` + `Deuxmoi` (доминируют 2026)
- **Reddit events**: убран `UpliftingNews` (feel-good, не события), добавлен `nottheonion` (странные real events)
- **Twitter culture**: убраны устаревшие 2023-2024 queries `(cancel OR ratio OR main character)` и `(gen z OR boomer)`, добавлены свежий gen-z slang `(skibidi OR delulu OR rizz OR brainrot OR mewing)` + cross-platform `(tiktok OR reels OR fyp) (viral OR trending)`
- **Twitter celebrities**: убраны конкретные имена `(elon OR trump OR drake OR kanye)` (cooling / политика), добавлены актуальные K-pop группы `(bts OR blackpink OR straykids OR seventeen OR twice)` + targeted `(kpop OR k-pop OR idol) (drama OR comeback OR scandal)`
- **Twitter events**: добавлен `(trump OR election OR debate OR primary)` для 2026 election cycle
- **TikTok general**: **полная замена** — было 100% crypto (`memecoin/solana/cryptomeme`) → стало generic viral (`fyp/viral/trending/foryou/funny/...`). Это был критический баг — TikTok general не ловил generic TikTok контент
- **TikTok все остальные**: точечные обновления (добавлены `dogsoftiktok` для animals, `pov`+`brainrot` для culture, `bts`+`blackpink` для celebrities, `aivideo`+`severeweather` для events)

### Поведенческие изменения после PR'ов

| Пресет | Что заметно меняется |
|---|---|
| **general** | TikTok перестаёт давать только crypto-контент → generic viral |
| **animals** | Reddit min_upvotes 5000→3000 (animal subs мельче), threshold 60→55, meme weight 0.35→0.45, stale grace 24→48h |
| **culture** | minScoreToSave 0→10 (экономим DB), threshold 60→65 (строже), AI ловит свежий gen-z slang, stale decay 2x faster |
| **celebrities** | X queries переключились на K-pop (BTS/BlackPink доминируют 2026), threshold 60→70 (строжайший), junk-multiplier 0.50→0.55 |
| **events** | threshold 60→50 (ловим раньше breaking news), maxAlertsPerCycle 0→10 (cap), stale decay 2.5× агрессивнее, cluster timeWindow 24h→6h |

### Operator-only гейт

**Уточнение архитектуры**: PR-1/2/3 endpoints (`/api/preset-configs` GET/POST) живут на **admin server** (port 8081), который и так гейтится через `X-Admin-Key` env var — single shared key. Это **архитектурно operator-only by design** (только тот у кого есть env-key, обычно через SSH-tunnel). Никакого дополнительного custom-middleware не нужно — отличается от dashboard server (port 8080) где есть multi-user auth с TG-linked accounts (вплоть до `plan='admin'` users — но они в admin server **не попадают**).

### Файлы тронутые в этой работе

**Новые**:
- `src/analysis/preset-config.js`

**Сильно модифицированы**:
- `src/analysis/scorer.js` (loadAlertWeights переключён)
- `src/analysis/clusterer.js` (cluster knobs + junk через preset-config)
- `src/collectors/{reddit,twitter,tiktok}.js` (sources через preset-config)
- `src/db/database.js` (миграция `presetConfigsMigratedV1`)
- `src/admin/server.js` (+`PresetConfigsPage` UI ~600 строк, +endpoints, -4 sub-sections в ScannerConfigSection)
- `src/dashboard/server.js` (cleanup `_handleSettings*`)
- `src/index.js` (alert-loop читает per-preset)

### Trap caught

В PR-3 **дважды** трапнулся на backticks-в-комментариях внутри SPA template literal:
- `\`formatValue\` overrides the default display` → SyntaxError `Unexpected identifier 'formatValue'`
- `siblings is an array of` (оригинал был `\`siblings\``) → SyntaxError `Unexpected identifier 'siblings'`

Поймано `node --check`, замена backticks на plain text. **Урок переподтверждён**: внутри `_spa()` — НИКОГДА backticks даже в JSDoc/комментариях. Этот файл (preset-config) не имеет outer template literal так что ему backticks безопасны — но admin/server.js внутри `_spa()` — нет.

### Проверка финального state

| Что | Результат |
|---|---|
| `node --check` × 7+ файлов | OK |
| `check-admin-spa.cjs` | OK (189 772 chars после PR-3, +17K от UI) |
| `check-dashboard-spa.cjs` | OK |
| Σ positive weights × 5 presets × 2 groups (alerts + cluster) | 10/10 = exactly 1.00 |
| Round-trip (DEFAULT_PRESET_CONFIGS → validator) | OK — стрипается до `{}` |
| Behavior parity smoke (no-db / empty-preset / override-routing) | 6/6 PASS |
| End-to-end UI save flow (chip-input + slider + budget-clamp) | OK |

---

## 2026-05-01 (post-theme polish: bars / surfaces / Account / TG-threshold rename)

**Цель**: после rewrite темы остались разрозненные «осколки» midnight-палитры (синие тинты в overlay'ях/барах) и слишком яркие серые поверхности. Плюс нужно было привести в порядок Account-панель (overflow тогглов, кричащий accent-gradient на hero) и переименовать слайдер «Чувствительность алертов» — он управляет только TG-пушами, не фидом.

**Изменения** (все в `src/dashboard/server.js`):

### Bars + overlays — привязка к theme tokens

- **`.nav` (top bar)**: было хардкод `linear-gradient(rgba(12,12,22,.96) → rgba(8,8,15,.92))` (синеватый midnight-tint), стало `linear-gradient(var(--surface) → var(--bg))` — на ink это `#0a0a0a → #000000`, незаметная elevation, тема-агностично
- **`.statusbar` (bottom bar)**: тот же фикс, mirrored gradient `var(--bg) → var(--surface)` (снизу чуть приподнимается)
- **`.sheet-overlay` (modal backdrop)**: было `background: rgba(4,6,14,.55)` + `backdrop-filter: blur(14px) saturate(1.1)` — синий тинт + saturate boost'ил остаточную синь из контента под блюром. Стало `rgba(0,0,0,.62)` + только `blur(14px)`. Нейтральный blackout на любой теме.

### Surfaces — выравнивание яркости

Юзер указал что центральные карточки фида и блоки правой колонки выглядят ярко-серыми относительно тёмного сайдбара. Корень — массовое использование `var(--card)` (#16181c) для surface'ов:

- **`.feed-card`**: было `linear-gradient(var(--card2) → var(--card))` (#1c1f24 → #16181c, заметно серое). Стало `var(--surface)` (#0a0a0a) + `box-shadow: var(--gloss-top)` — карточки матчат сайдбар, только 1px border их выделяет
- **`.feed-card:hover`**: `linear-gradient(rgba(255,255,255,.04), rgba(255,255,255,.015))` — soft white-alpha overlay (X-приём), даёт лифт без сдвига оттенка. Раньше было `linear-gradient(--card3 → --card2)` — тоже серое
- **`.right-section`**: `var(--card)` → `var(--surface)`. Right-panel секции теперь матчат feed-panel + сайдбар
- **`.settings-card`**: `var(--card)` → `var(--surface)`. Карточки в Account/Settings sheets теперь не выделяются ярко-серым

### AccountPanel — общая чистка

Юзер прислал скрин: тоггл-боксы алерт-типов выезжали за границу карточки, текст обрезался. Корень — `Row` primitive рендерил label + control в горизонтальную flex с `flex-shrink: 0` на control'е, контент длиннее ширины не ужимался.

- **`Row` primitive получил `stacked` prop**: side-by-side по дефолту (как было); `stacked: true` → `flex-direction: column`, control во всю ширину снизу label'а. Применён в AlertTypesRow
- **CSS overflow-страховка глобально**:
  - `.setting-row`, `.setting-control`, `.setting-label` — везде `min-width: 0` (canonical fix для flex с длинным текстом)
  - `.setting-control`: `flex-shrink: 0 → 1` + `max-width: 100%`
  - `.atype-toggle-group`/`.atype-toggle`/`.atype-toggle-label`: `min-width: 0` + `width: 100%` + `overflow-wrap: break-word`
- **Тексты тогглов сокращены**:
  - «Событие — конкретный триггер (кто-то что-то сделал/сказал)» → «Событие — конкретный триггер»
  - «Тренды — нарратив набирает обороты на разных платформах» → «Тренды — на нескольких платформах»
  - EN аналогично
- **`.account-hero`**: убран `background: linear-gradient(135deg, rgba(--accent-rgb, .09), --card 70%)` (электрически-синий диагональ от accent) → plain `var(--surface)`. Аватар остаётся единственным цветным focal point карточки
- **`.account-avatar-big`**: убран жирный `2px solid rgba(--accent-rgb, .5)` border + цветной accent-glow → 1px subtle ring + нейтральный `box-shadow: 0 2px 10px rgba(0,0,0,.4)`. Глянцевый, но не кричащий

### TG-threshold rename (Variant A)

Юзер заметил что слайдер «Чувствительность алертов» ничего не делает в дашбоде — он управляет только TG-пушами через alert-loop в `src/index.js`. Дашбод-фид показывает все Stage-1 трейнды независимо. Старое имя создавало впечатление общего фильтра.

- **Title**: «Чувствительность алертов» → «Порог Telegram-алертов» (RU). EN: «Alert sensitivity» → «Telegram alert threshold»
- **Desc**: явно добавлено «На фид в дашбоде НЕ влияет — для этого есть фильтр Adoption в сайдбаре»
- **Icon**: 🎯 → ✈️ (paper plane намекает на Telegram-scope)
- **Логика не тронута** — сервер-сайд `_handleUserThresholdPost` пишет в `users.alert_threshold` как было; гейт в alert-loop читает оттуда

**Trap stuck twice**:
1. Backtick в JSDoc: `// stacked:true for...` — сломал outer literal с `Unexpected identifier 'stacked'`. Поймано `node --check`, заменил на `stacked:true` без backticks
2. Backtick в комменте про cache-bust в logo-handler секции — поймано в прошлой итерации

**Проверка**: `check-dashboard-spa.cjs` green после каждого подхода. Финальный размер 166247 chars.

**Деплой**: `.\deploy.ps1` + Ctrl+F5. Старые темы в localStorage автоматически вылетят в дефолтный ink.

---

## 2026-05-01 (theme system rewrite — X-style monochrome)

**Цель**: 7 ярких тем (midnight/teal/abyss/violet/acid/sunset/cyberpunk) с разноцветными акцентами заменить на 4 минималистичные в стиле X (Twitter): один акцент-цвет, монохромная палитра, глянцевые поверхности.

**Старые темы выпилены** (`midnight/teal/abyss/violet/acid/sunset/cyberpunk`). Юзеры с сохранённой старой темой получают дефолт `ink` через validity-check в `detectTheme` — миграция не нужна.

**Новые темы** (4 шт, все в `:root` + `body[data-theme="..."]` блоки):

| Theme   | bg        | accent    | use case                                |
|---------|-----------|-----------|------------------------------------------|
| `ink`   | `#000000` | `#1d9bf0` | дефолт. X true-black + X-blue             |
| `dim`   | `#15202b` | `#1d9bf0` | X dim-mode (синевато-графитовый)          |
| `slate` | `#0e0f10` | `#ffffff` | Apple-style нейтральный графит, белый акцент |
| `mono`  | `#0d0d0d` | `#b8b8b8` | чистый grayscale, без хроматики           |

**Дизайн-принципы**:
- Один accent-цвет на тему, экономно (никаких rainbow-палитр)
- Borders translucent white at low alpha (`rgba(239,243,244,.08-.22)`) вместо tint'а от accent
- Семантические state-цвета (green/red/orange/yellow) **константны** во всех темах — OK/error не должны менять hue от темы
- **Glossy effects**: добавлены два token'а в `:root`:
  - `--gloss-top: inset 0 1px 0 rgba(255,255,255,.04)` — лёгкий top-edge highlight (свет на верхней грани)
  - `--gloss-edge: inset 0 0 0 1px rgba(255,255,255,.02)` — общий edge-glow
- `.feed-card` теперь рендерится с `linear-gradient(180deg, var(--card2), var(--card))` background + `box-shadow: var(--gloss-top)` — карточка читается как глянцевая, не плоская

**Файлы изменены**: `src/dashboard/server.js`:
- `:root` block переписан (lines ~1531-1576) — палитра X-ink + новые tokens
- 6 старых `body[data-theme="..."]` блоков удалены (~1578-1770) → заменены на 3 новых (`dim`/`slate`/`mono`, ink в :root)
- `.theme-swatch[data-theme-preview="..."]` блоки переписаны под новые имена (24 строки → 12)
- `SUPPORTED_THEMES` + `THEME_META` + `detectTheme` дефолт обновлены
- `.feed-card` background теперь gradient + gloss-top

**Проверка**:
- `node --check` green
- `check-dashboard-spa.cjs` green (164763 chars, было ~170K — палитра компактнее благодаря удалению 4 темных блоков)

**Деплой**: `.\deploy.ps1` + Ctrl+F5. Юзеры со старыми темами в localStorage автоматически переключатся на дефолтный `ink` при следующей загрузке.

---

## 2026-05-01 (logo cache-bust + transparent-bg fix)

**Цель**: после rebuild Docker'а дашборд показывал старый логотип (browser cache из-за `Cache-Control: immutable, max-age=86400`); плюс прозрачный PNG отображался на teal-градиентной подложке `.nav-logo-icon`, что выглядело как «чёрный фон сам добавляется».

**Фиксы** (`src/dashboard/server.js`):
- **Cache-bust через query string**: в constructor компилируется `this._logoVersion = mtimeMs(assets/logo.png)` (fallback = `this.started` если файла нет). Server-injected как `LOGO_VERSION` константа в SPA. `<img src='/assets/logo.png?v=' + LOGO_VERSION>` — URL меняется каждый rebuild (Docker `COPY` сбрасывает mtime у layer'а), браузер делает свежий запрос. Тот же приём webpack'а с content-hash bundles
- **`.nav-logo-icon.has-img`** класс: добавляется на `<img onLoad>`, убирает teal-градиент / border / box-shadow → прозрачный PNG показывается без подложки. Emoji-fallback по-прежнему получает стилизованный badge
- **`.nav-logo-img`**: убран `padding: 2px` — логотип теперь заполняет 28×28 целиком (для PNG с собственным фоном это критично — иначе выглядел "обрезанным" внутри badge)

**Проверка**: `check-dashboard-spa.cjs` green (165101 chars). Ловушка SPA-литерала не стрельнула благодаря отсутствию backticks в новых комментариях.

**Деплой**: после `.\deploy.ps1` юзеру **всё ещё нужен hard-refresh** (Ctrl+F5) **первый раз** — старый закэшированный URL `/assets/logo.png` без `?v=` сидит в browser cache. После первого обновления версионированные URL уже всегда фрешевые.

---

## 2026-05-01 (brand logo route — replace nav 🐱 emoji)

**Цель**: вместо emoji `🐱` в навбаре дашборда — кастомная картинка.

**Архитектура**: статика, бекаемая в Docker-образ. `Dockerfile` уже делает `COPY --chown=node:node . .` (line 44), так что новая папка `assets/` автоматически попадает в `/app/assets/` внутри контейнера. Никаких volume-маунтов или upload-роутов.

**Изменения**:
- **Новая папка** `assets/` в корне репо + `assets/README.md` с инструкцией
- **`src/dashboard/server.js`**:
  - Public route `GET /assets/logo.png` (до auth-чека). `_handleBrandLogo`: stat → stream PNG с `Cache-Control: max-age=86400, immutable`. На отсутствие файла → 404 (SPA onError fallback на emoji)
  - Nav logo span теперь рендерит `<img src="/assets/logo.png" onError="...emoji fallback">` вместо `🐱` напрямую
  - CSS `.nav-logo-img`: `width:100%; height:100%; object-fit:contain; padding:2px` чтобы вписывалось в 28×28 round-square badge

**От пользователя**: сохранить PNG как `assets/logo.png` в корне репо, потом `.\deploy.ps1`. Docker rebuild запекает файл в образ. Hard-refresh дашборда (Ctrl+F5) чтобы обойти browser cache.

**Fallback**: если файл отсутствует — endpoint возвращает 404 и SPA автоматически показывает 🐱 emoji через onError handler. Nav никогда не выглядит сломанным.

**Проверка**: `check-dashboard-spa.cjs` green (164124 chars, +591 от прошлой версии).

---

## 2026-05-01 (dashboard UI/UX polish pass)

**Цель**: пройтись по всему дашбоду, убрать визуальный шум, оптимизировать плотность, поправить недочёты.

**Изменения** (все в `src/dashboard/server.js`):

- **Nav bar**: удалена декоративная центральная подпись `app.subtitle` — добавляла шум без информации. Освободившееся место можно потом отдать под global status badge
- **BottomNav grid**: было хардкод `repeat(2, 1fr)` — для pro/admin с 3-й вкладкой «Analyze» 3-й tab падал на новую строку. Теперь inline `gridTemplateColumns: repeat(${tabs.length}, 1fr)`
- **Sidebar section headers**: были громкими (9px / letter-spacing 1.4px / `--accent` цвет). Стали 10.5px / spacing .8px / `--muted` — content становится фокусом, а не хедеры
- **Sidebar reorg**: filter «Manual only» переехал из source-list (не source-же он) в alert-type chip-секцию как полноширинный chip. Снят лишний `sidebar-divider` после source list
- **Sidebar reset link**: на alert-type секции reset теперь сбрасывает И тип-фильтр И manual-only одной кнопкой
- **Feed card head**: добавлен `feed-meta-hint` chip (1p · 12/h) рядом со временем — раньше был fake-button «details-hint» в actions row, теперь это нормальный inline-факт
- **Feed card badges**: нормализованы padding (2 7px) + font-size (10px) — раньше manual/atype/phase/category выглядели как разнокалиберный набор
- **Fresh indicator** (новое): тренды моложе 60 мин получают `🟢 NEW` chip + лёгкую pulse-анимацию + 2px зелёный левый бордер на карточке. i18n `feed.fresh_tip` + `badge.fresh` (RU + EN)
- **Feed panel head**: убрана декоративная 32×32 коробка с emoji 🔥 слева — заголовок и сам несёт визуальный вес через 800-weight. Square refresh button (32×32) — выровнен по высоте с search-инпутом
- **Feed panel sub**: «Live narrative tracker · 3/4 sources · 24h window» → «3/4 sources · last 24h» (RU аналогично). Tracker-label был словарный шум
- **Empty-state copy**: «No narratives found — loosen the filters» → «No narratives match these filters»; «Hint: widen the time window or clear filters» → «Try a wider time window or clear filters» (RU аналогично)
- **Sheet sizing**: max-width 760 → 720, добавлен `sheet-narrow` (560) для Analyze + Account — формы и профиль читаются компактнее, не растягиваются на всю ширину
- **Feed card padding**: 12 14 → 11 13 9 (меньше нижнего отступа), gap внутри head 8 → 6 — карточка плотнее без потери воздуха

**Trap encountered**: backtick в comment внутри SPA template literal (\`narrow\` flag) сломал outer literal с `Unexpected identifier 'narrow'`. Поймано `node --check`, исправлено заменой backticks на quotes. **Урок**: в SPA-комментариях ВСЕГДА используем "quotes" вместо backticks, как описано в SESSION_CONTEXT § «Ловушка server.js»

**Проверка**:
- `node --check src/dashboard/server.js` — green
- `scripts/check-dashboard-spa.cjs` — green (163533 chars, было 161042 — +2.5K от новых стилей и копии)
- `scripts/check-admin-spa.cjs` — green (без изменений)

**Файлы изменены**: только `src/dashboard/server.js`. i18n-ключи добавлены inline (не в `i18n/{en,ru}.js` модулях — дашбод имеет свой словарь внутри SPA, см. ~строки 4090/4405).

---

## 2026-05-01 (alert types: event/trend/post + per-user subscription)

**Цель**: разделить алерты по форме сигнала (а не по теме) — Событие / Тренд / Пост, чтобы юзер мог подписаться только на нужный тип.

**Архитектура** (выбран Path B — AI-driven через Stage 1, см. обсуждение):
- Поле `alertType ∈ {event, trend, post}` ортогонально `category`. Заполняется Stage 1 AI; heuristic/fallback пути деривируют детерминистично (`whyNow → event`, `platforms ≥ 2 OR clusterSize ≥ 3 → trend`, иначе `post`)
- Per-user CSV подписка `users.alert_types_filter` default `'event,trend,post'` (всё включено), пустой = "все" (никогда не мутим юзера молча)
- Legacy-тренды (`alert_type IS NULL`) — wildcard, проходят любой filter (back-catalog не страдает)

**Файлы**:
- `src/analysis/prompts.js` — экспорт `ALERT_TYPE_VALUES` + `normalizeAlertType()`. В `STAGE1_RESPONSE_SCHEMA` добавлено поле `alertType` enum, в `SYSTEM_PROMPT` — блок «ALERT TYPE» с rubric и rules of thumb. Поле прописано в `buildAnalysisPrompt` JSON spec
- `src/analysis/scorer.js` — экспорт `deriveAlertType(trend)` (детерминистический fallback). В AI-result mapping: `normalizeAlertType(a.alertType) || deriveAlertType({...})`. `_applyHeuristic` + `_fallback` тоже заполняют `alertType` через derive
- `src/db/database.js` — `addIfMissing('trends','alert_type','TEXT')`, `addIfMissing('users','alert_types_filter',"...DEFAULT 'event,trend,post'")`, helpers `getUserAlertTypes(chatId)` / `setUserAlertTypes(chatId, types[])` (валидируют enum, dedup, lowercase). `saveTrend` пишет колонку + зеркало в `raw_metrics.alertType`. `updateUser` allowed-list расширен
- `src/index.js` — новый gate `alert_type` в alert-loop рядом с threshold/source/dedup. `decisionBase.alertType` пишется в `recordAlertDecision` для DecisionsPage
- `src/notifications/formatter.js` — emoji-чип первой строкой алерта: `📰 СОБЫТИЕ` / `📈 ТРЕНД` / `🚀 ПОСТ`. Helper `formatAlertTypeChip(alertType, t)`. Legacy-row → пустая строка, чип не рисуется
- `src/i18n/{en,ru}.js` — ключи `alertTypeEvent/Trend/Post`, `btnAlertTypes`, `alertTypesTitle`, `alertTypeNameEvent/Trend/Post`, `alertTypeToggled(name, enabled)`. На дашборде — `sidebar.alert_type`, `feed.atype.*`, `badge.alert_type.*`, `account.alert_types*`
- `src/notifications/telegram.js` — в `/menu` keyboard вторая строка теперь содержит `🔔 Типы алертов` + `🌐 Язык`. Новый `_alertTypesKeyboard(user)` рендерит ✅/❌ для трёх типов. Callback'и `alert_types` (open) и `toggle_alert_type:event|trend|post` (toggle, optimistic)
- `src/dashboard/server.js`:
  - `_publicUser` отдаёт `alertTypes: string[]`
  - `_formatTrend` отдаёт `alertType` (колонка → fallback на raw_metrics)
  - Новый endpoint `POST /api/user/alert-types` `{ types: [...] }` → `{ ok, alertTypes: saved }`
  - SPA: chip-filter в сайдбаре (между phase и filters), бейдж в `FeedCard` и `TrendModal`, новый компонент `AlertTypesRow` в AccountPanel (3 чекбокса, optimistic update + rollback при ошибке). CSS `.badge-atype-*`, `.atype-toggle*`
- `src/admin/server.js`:
  - `_hydrateTrendFromDb` + `_shapeManualTrend` отдают `alertType`
  - SubmitPage hero meta-chips: первый chip — `sp-chip-atype-event/trend/post` с цветной заливкой
  - DecisionsPage: новый chip `🔔 Тип не подписан` в `DECISION_LABELS`, лейбл `тип` в `GATE_LABELS`, цветной alertType-чип в meta-row карточки решения
- `scripts/check-admin-spa.cjs` + `check-dashboard-spa.cjs` — оба зелёные (admin 168060 chars, dashboard 161042 chars)

**Стоимость AI**: +~5 токенов output на тренд × 30 трейндов × 96 циклов/день × ~$0.075/M (cached) ≈ <$0.01/мес. Strict json_schema (OpenAI) гарантирует enum на стороне модели.

**Edge-cases**:
- Юзер выключил все 3 типа → `getUserAlertTypes` возвращает дефолт 3 — silent allow всех (никогда не мутим молча; UI явно говорит про это)
- AI вернул мусор / xAI без strict schema → `normalizeAlertType` → `null` → derive по правилу
- Manual analysis (admin/dashboard/TG) — alertType заполняется как обычно через scorer; filter не применяется для прямого `_runManualAnalysisForUser` (оператор сам попросил)
- Heuristic + fallback paths добавили `alertType: deriveAlertType(t)` чтобы NEVER NULL для новых трейндов

**Проверка**:
- `node --check` всех затронутых файлов — green
- `node scripts/check-admin-spa.cjs` + `check-dashboard-spa.cjs` — green
- Sanity-тесты `deriveAlertType` (whyNow → event, platforms→trend, single→post, whyNow priority): все ok
- `formatTelegramAlert` для event/post + legacy (alertType=null): чип-строка корректно появляется/опускается

**Деплой**: `.\deploy.ps1`. После первого цикла проверить логи — должны видеть валидные `alertType` в trends. Через час глянуть DecisionsPage → распределение типов.

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
- **Backslash-перед-неэкранируемым символом в SPA-регулярках**: внутри outer template literal `\/` → `/` (parser ест backslash; `/` не нуждается в экранировании). Регулярка `/^https?:\/\//i.test(x)` в исходнике становится `/^https?:///i.test(x)` в браузере → unterminated regex → `Uncaught SyntaxError` → чёрный экран. Поймал 2026-04-30 при редизайне SubmitPage. **Правило**: regex с `/` в SPA-блоке **обязан** использовать `\\/\\/` в источнике. То же касается `\$`, `\``, `\b` и любых не-метасимвольных пар. Validator `scripts/check-admin-spa.cjs` теперь поймает это (вызывает `_spa()` и парсит то что реально увидит браузер) — раньше ручное unwinding в валидаторе пропускало этот класс
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

---

## 2026-04-30 (SubmitPage history persistence + card redesign)

- **Цель**: ручной анализ в админке тёрся при reload/уход с раздела (state хранился только в `useState`). Юзер: «хочу чтобы мои ручные поиски остались + переделать карточку поста на более красивую и удобную»
- **Persistence**: каждый submit уже UPSERT'ил в `trends` с `raw_metrics.manualSubmitted=true` — ничего нового сохранять не нужно. Добавили путь чтения:
  - `db.getManualTrends(limit)` — `SELECT * WHERE raw_metrics LIKE '%"manualSubmitted":true%' ORDER BY first_seen_at DESC LIMIT ?`. JSON-text LIKE-фильтр без расходов на парсинг каждой строки server-side; маркер уникален в схеме (никаких других полей с `manualSubmitted` нет)
  - `db.unsetManualSubmitted(trendId)` — снимает флаг (тренд остаётся в БД, выпадает из истории SubmitPage)
  - `GET /api/manual-trends?limit=N` (cap 200) — список hydrated rows + re-derived `pipeline` trace (memePotential vs текущий threshold, source, isNovel — те же чек-условия что в `_submitNarrative`)
  - `DELETE /api/manual-trends/:id` — кнопка 🗑 в history-strip
- **Shape helper**: `_shapeManualTrend(trend, dbId)` извлёчён из `_submitNarrative`. Один источник истины для shape — live submit и history endpoint возвращают идентичный payload, фронт рендерит одинаково
- **Hydrator расширен**: `_hydrateTrendFromDb` теперь восстанавливает `description` (колонка `trends.description`), `clusterMetrics`, `stage2Penalty/StoryBonus/NameBonus`, `viralityScore`, `manualSubmitted/manualSubmittedAt`, `firstSeenAt` — раньше эти поля читались только в live-flow и в DB-hydrate path возвращали undefined → история показывала бы пустые секции
- **SubmitPage UX**:
  - На mount → `GET /api/manual-trends?limit=80` → горизонтальная strip из mini-карточек (image thumb + title 2-line clamp + 💎 score chip + relTimeRu age + 🗑 трэш). Самая свежая активна по умолчанию
  - Клик по mini-карточке переключает active детальное окно
  - Submit prepend'ит результат в строп, делает active
  - 🗑 — confirm + DELETE → из стопа исчезает (тренд в БД остаётся целым)
- **Карточка результата редизайн** (`ManualResultCard`):
  - HERO-блок: 84×84 image thumb (или source-icon placeholder) слева + title 16px bold + meta (`#id · src · elapsed · relTime`) + buttons + 🧪 MANUAL chip
  - Pipeline trace (без изменений) → score grid (5-7 cells, repeat auto-fit 120px) → Score bars
  - **Trigger / AI explanation / Описание** — всегда раскрыты (это primary value)
  - **Collapsible advanced sections**: Stage 0 PreStage (closed), Stage 2 deep-dive (open by default — это самая ценная инфа когда есть), Сырые метрики (closed), Сигналы кластера (closed), 🖼 Картинки если ≥2 (closed). Реализован общий `Collapsible` компонент (header click toggle, content unmount при close)
  - Meta chips compact в одной строке между AI и collapsible-блоками
  - Comment textarea внутри карточки (была раньше только в submit-форме) — оператор может скорректировать комментарий перед «Отправить алерт» по конкретному тренду
- **Helpers added** (выше SubmitPage в SPA): `Collapsible`, `relTimeRu`, `srcIcon`, `ManualHistoryItem`, `ManualResultCard`
- **Validation tooling**: добавлен `scripts/check-admin-spa.cjs` — экстрактит `<script>...</script>` из template literal, undo'ит `\\\\` `\\\`` `\\$` escaping, прогоняет через `vm.Script`. Ловит **оба** класса ошибок этого файла (backticks-in-comments + escape-in-strings). `.cjs` потому что проект `"type": "module"`. Запускать перед каждым деплоем который трогает `admin/server.js` или `dashboard/server.js`
- **Файлы**: `src/db/database.js` (+~40 строк: `getManualTrends`, `unsetManualSubmitted`), `src/admin/server.js` (~+450 строк: эндпоинты, `_shapeManualTrend`, `_derivePipelineTrace`, расширение `_hydrateTrendFromDb`, новый `Collapsible`/`ManualHistoryItem`/`ManualResultCard`/`SubmitPage`; ~−270 строк старого SubmitPage), `scripts/check-admin-spa.cjs` (новый, ~30 строк)
- **Деплой**: `.\deploy.ps1` (изменения только в admin SPA + DB методы — не нужны env правки, не нужны рестарты сервиса до выкатки)
- **Hotfix (тот же день)**: первая версия выкатилась с чёрным экраном. Причина: в новом `submit()` я написал `if (!/^https?:\/\//i.test(clean))` — outer template literal сожрал backslash перед `/`, в браузер прилетело `/^https?://i.test(...)` → unterminated regex → `Uncaught SyntaxError`. Старый код имел `\\/\\/` именно для этой защиты. Возвращён `\\/\\/`. Также **переписан `scripts/check-admin-spa.cjs`** — раньше делал ручное unwinding (`\\` → `\`, `\`` → `` ` ``, `\$` → `$`), пропускал `\n`/`\t`/`\u`/`\x`/`\/`. Теперь импортит модуль, дёргает `AdminServer.prototype._spa.call({})` (метод не использует `this.*`), извлекает `<script>` ИМЕННО ИЗ ТОГО HTML что увидит браузер, прогоняет через `vm.Script`. Backslash-eat ловится мгновенно, поэтому такая ошибка больше не выкатится в прод. **Запускать после ЛЮБОГО изменения inline-SPA в admin/server.js или dashboard/server.js**: `node scripts/check-admin-spa.cjs`
- **Visual rewrite (тот же день)**: владелец попросил привести SubmitPage к единому виду с остальной админкой. Найдены проблемы первой версии: использовал `var(--text3)` (не определён, только `--text` и `--text2`), `var(--dim)` (не определён), хардкодил пурпурный `#b48cff` и голубой `#5bc0eb` вместо `var(--accent)` (`#14b8a6` teal — основной токен админки), inline-styled чипы вместо CSS-классов, hero без gradient + без shadow в духе `.scanner-status-bar`. Решение: добавлен блок `.sp-*` CSS-классов в `<style>` (~110 строк, рядом с `.exp-*` и `.scfg-*` блоками), все компоненты SubmitPage рефакторнуты:
  - `Collapsible` → `.sp-collapsible` + `accent="prestage"|"stage2"` для тонировки (вместо inline rgba)
  - `ManualHistoryItem` → `.sp-hist-card.active` + `.sp-hist-pill.high/mid/low/cold` (color-mix как в `DecisionsPage`)
  - `ManualResultCard` hero → `.sp-hero` с тем же `linear-gradient(135deg,rgba(20,184,166,.07),rgba(56,189,248,.04))` градиентом что у `.scanner-status-bar`
  - `.sp-pill.manual/.ok/.warn/.bad/.skipped` для pipeline trace и MANUAL chip — единый ритм 999px-радиуса
  - `.sp-score-tile.hot/.warm/.bad` для score grid (auto-tone по value 70/40, override на bad)
  - `.sp-bar-*` для AdminScoreBar — цвета через `var(--green)`/`var(--yellow)`/etc.
  - `.sp-block` + `.sp-block.accent-trigger/.accent-stage2/.accent-prestage/.accent-tg` — единый паттерн для AI-объяснения / описания / Stage 2 / TG-broadcast статуса
  - `.sp-narrative` — left-border accent для текстовых блоков (бывший `narrativeBox` хелпер удалён, его поведение зашито в `.sp-narrative` CSS)
  - `.sp-chip` для meta-чипов (категория / sentiment / lifespan / phase) — pill-style консистент с DecisionsPage
  - Helper `scoreBox(label, value, cls)` переименован в `spTile()`, все цвета теперь через CSS `.sp-score-tile.hot/.warm/.bad`
- **Файлы доп**: `src/admin/server.js` (~+110 CSS lines, ~−290 inline-style lines в SubmitPage components)

---

## 2026-05-01 (Manual analysis — dashboard + Telegram, pro/admin gated)

- **Цель**: ручной анализ был доступен только из админки. Владелец попросил вынести в дашборд и TG-бот, доступ — только Pro и Admin планы
- **Архитектурный рефакторинг**: URL resolvers и оркестратор анализа вынесены из `admin/server.js` в `src/analysis/`
  - `src/analysis/url-resolver.js` (новый) — pure functions: `resolveUrlToTrend(url)`, `resolveTwitterUrl/RedditUrl/TiktokUrl/GenericUrl`. Бывшие `_resolveTwitterUrl`/`_resolveRedditUrl`/etc. в админке (273 строки) удалены — все три вызова (admin SubmitPage / dashboard endpoint / TG bot) теперь импортят из одного источника. Один баг в fxtwitter media parsing — фикс в одном месте
  - `src/analysis/manual-analysis.js` (новый) — `runManualAnalysis({ scorer, db, url, save, logger, actorId })` оркестратор. Resolve → `scorer.scoreTrends([synthetic])` → optional save с manualSubmitted flag → re-derived pipeline trace. Возвращает `{ ok, elapsedMs, trend, dbId, pipeline }`
- **Admin рефактор**: `_submitNarrative` сжат с ~58 строк до ~25 (тонкий wrapper над `runManualAnalysis` с broadcast после). Поведение идентичное — single source of truth. SubmitPage UX/визуал не тронуты
- **Dashboard endpoint** `POST /api/manual-analysis`:
  - Auth required (existing X-Auth bearer middleware)
  - Plan gate: `req.user.plan_name ∈ ['pro', 'admin']` → иначе 403 `reason: 'plan'`
  - Rate limit (admin bypass): 30s между вызовами + 20/24h. In-memory ring `Map<userId, ts[]>` в DashboardServer instance — сбрасывается при рестарте, что ОК для soft cap
  - **save: false** — приватный анализ не попадает в глобальную ленту (в отличие от админки где save: true)
  - Response shape — adapted к `_formatTrend` shape с synthetic ID `manual-<ts>`, чтобы UI рендерил через ту же `TrendModal` что и обычные feed-cards
- **Dashboard UI**:
  - Bottom-nav третья кнопка «🧪 Анализ» — рендерится только если `me.plan ∈ {pro, admin}`. Free/test юзеры её не видят
  - `view === 'analyze'` → открывает `Sheet` с `AnalyzePanel`: header (back + title) → описание → form (URL input + кнопка) → empty state ИЛИ результат
  - Результат: hero strip (84px thumb + title + meta + 🔗source + 👁 «Открыть карточку»), pipeline trace pills (Stage 1 ✓ / Stage 2 ✓⏭), score grid (4 tiles: 💎 Meme / 🌊 Emergence / 🔥 Adoption / 📖 Story если есть), AI explanation strip
  - «Открыть карточку» переключает на `view: 'trends'` + `setModalTrend(tr)` → результат открывается в стандартной TrendModal со всем рендерингом (карусель, видео, score bars, Ask Grok, source link)
  - CSS `.analyze-*` (~110 строк) в стиле остальных panels: `linear-gradient`, `var(--accent-rgb)` для accents, `.analyze-pill.ok/.warn` через color-mix, `.analyze-score.high/.mid/.low` для color toнировки
- **Telegram bot**:
  - Команда `/analyze <url>` — если URL не передан или не парсится, показывает usage. Регистрируется в `setMyCommands` (видна в TG-меню)
  - Bare-URL handler — `bot.on('message')` второй регистрируется (после команд). Если текст содержит `https?://` И юзер pro/admin — автоматически запускает анализ. Free/test игнорятся молча (никаких "you need pro" уведомлений на каждую ссылку чтобы не флудить)
  - Helper `_runManualAnalysisForUser(msg, user, url)`:
    - Defence-in-depth plan check (на случай если bare-URL handler пропустил)
    - Same rate limit как dashboard (30s + 20/24h, admin bypass)
    - Acknowledge "⚙️ Анализирую... (10-30 сек)" → анализ → удалить ack → `sendAlertToUser(trend, user)` тот же rendering что и обычные алерты (видео + media group + caption logic + кнопки feedback/Ask Grok)
    - НЕ записывает в `notifications`, НЕ инкрементит `alert_count` — приватный анализ, не broadcast
    - Двуязычные сообщения (RU/EN) inline через `user.language` switch
- **Конструкторы расширены**:
  - `DashboardServer(..., extras = {})` — 8-й arg как у admin. `extras.scorer` сохраняется в `this.scorer`. Без скорера `/api/manual-analysis` возвращает 503 `reason: 'disabled'`
  - `TelegramNotifier(config, logger, db, solanaMonitor, triggerFinder, scorer)` — 6-й positional. Без скорера `/analyze` отвечает "not configured"
- **`scripts/check-dashboard-spa.cjs`** (новый, ~50 строк) — sister script для admin's check. Импортит модуль, дёргает `DashboardServer.prototype._buildSPA.call({})`, прогоняет через `vm.Script`. Та же защита от backslash-eat / backtick-in-comment траппов. Запускать после ЛЮБОГО изменения inline-SPA в dashboard/server.js. **Поймал тот же баг что и в админке вчера** — `if (!/^https?:\/\//i.test(clean))` без двойного экранирования
- **Стоимость**: каждый pro/admin manual analysis тратит Stage 2 ~5¢ (если memePotential ≥ 60). Daily cap 20 → max ~$1/день/юзер. Suchabuse-resistant соображение — Stage 2 — самая дорогая операция в системе
- **Файлы**: `src/analysis/url-resolver.js` (новый, ~270 строк), `src/analysis/manual-analysis.js` (новый, ~95 строк), `src/admin/server.js` (~−270 строк resolvers, +1 import, _submitNarrative сжат), `src/dashboard/server.js` (+~150 строк JS — endpoint, AnalyzePanel, BottomNav, Sheet wiring; +~110 строк CSS; ~+30 строк i18n RU/EN), `src/notifications/telegram.js` (+~110 строк JS — `/analyze` handler, bare-URL handler, `_runManualAnalysisForUser`), `src/index.js` (+2 wiring args), `scripts/check-dashboard-spa.cjs` (новый, ~50 строк)
- **Деплой**: `.\deploy.ps1` — без env-правок. Проверь после: TG `/analyze https://...` от admin → должен вернуть алерт-карточку через 10-30s. Dashboard → /menu → 🧪 Анализ tab → форма работает.

---

## 2026-05-01 (Manual analysis — cross-user URL cache, 1h TTL)

- **Цель**: владелец заметил что если pro-юзер A проанализировал URL X, pro-юзер B по тому же URL запускает повторный полный pipeline (~5¢ Stage 2). Нужно кэшировать на час
- **Реализация**: module-level `RESULT_CACHE` Map в `src/analysis/manual-analysis.js`:
  - Key: lowercase URL без trailing-slash. Query string сохраняется (некоторые URL без него теряют идентификатор; tracking-параметры вроде `utm_*` заплатят за дубль анализ — это <5¢, не стоит нормализатора)
  - Value: `{ trend, pipeline, ts, savedDbId|null }`. Хранит full scorer output (а не shaped) — каждый surface (admin/dashboard/TG) shape'ит самостоятельно
  - TTL: 1 час. Sweep expired при росте >200 entries (lazy)
  - Wiped on restart — для 1h cache это OK, не нужна персистентность
- **Cross-save semantics**: cache переживает разные `save:` режимы:
  - save:false caller A → кэш сохраняется без `savedDbId`
  - save:true caller B (admin) hits cache → выполняем lazy save, обновляем `savedDbId` → следующие save:false коллеры тоже видят dbId (ссылки на trend в дашборде/TG будут работать)
  - save:true caller A → кэш сохраняется с `savedDbId`. save:false caller B reuses
- **Rate-limit interaction**: добавлен `peekManualAnalysisCache(url)` non-mutating helper. Dashboard и TG handler'ы peek'ают перед rate-limit — на cache hit ИКОНОМИМ rate-limit (свободные мгновенные запросы не должны жечь дневной лимит юзера). На cache miss — обычный 30s+20/24h
- **UX surfacing**:
  - `runManualAnalysis` возвращает `fromCache: boolean`, `cacheAgeMs: number`
  - Dashboard endpoint пробрасывает в response. AnalyzePanel в hero-meta показывает «`из кэша · 12 мин назад`» вместо «`fresh · 8.3s`»
  - Admin SubmitPage hero-meta тоже: «`💾 из кэша · 12 мин назад`»
  - TG `_runManualAnalysisForUser`: на cache hit пропускает «⚙️ Анализирую...» ack-сообщение (instant result не нужен пре-индикатор)
- **`useCache: false`** опция — для будущего admin "Force re-run" button (не выкатывали — cache TTL 1h достаточно гибкий)
- **`clearManualAnalysisCache(url?)`** export — для тестов / future invalidate-on-edit. Сейчас не используется
- **Стоимость**: ожидаемая экономия — pro-юзеры обычно паpаллельно интересуются одними и теми же viral нарративами. Cache hit rate в первый час после первого анализа ~3-5x. При daily cap 20/юзер и 50 pro-юзеров → пиковая нагрузка может упасть с $50/день до $15-20/день
- **Файлы**: `src/analysis/manual-analysis.js` (~+90 строк cache logic), `src/dashboard/server.js` (peek + UI меta), `src/notifications/telegram.js` (peek + skip ack on hit), `src/admin/server.js` (passthrough fromCache в response + UI meta)
- **Деплой**: `.\deploy.ps1`. Проверка: дважды проанализировать один и тот же URL за 1 час → второй раз должен показать «из кэша · X мин назад» в hero-карточки и не сжечь rate-limit hit
