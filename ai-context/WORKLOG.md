# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 без архивации. Полная история — в git.

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

