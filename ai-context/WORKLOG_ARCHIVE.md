# WORKLOG ARCHIVE

Архивные записи из `WORKLOG.md`. Активный лог содержит **последние 10 entries**;
всё что старше переезжает сюда автоматически (по правилу `AGENT_RULES.md §6`).

Append-only внутри файла — порядок: новейшие архивированные сверху, старейшие снизу.
Полная история до агрегации — в git.

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
