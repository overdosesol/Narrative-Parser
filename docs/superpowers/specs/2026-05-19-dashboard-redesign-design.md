# Dashboard visual redesign — design spec

**Status**: brainstorm-locked, awaiting implementation plan
**Owner**: operator (skipnick2)
**Date**: 2026-05-19
**Skill chain**: brainstorming → writing-plans (next)
**Surface**: `src/dashboard/server.js` (inline-React SPA inside ~290k char template literal)

---

## 1. Goal

Заменить текущий "AI-made / детский" визуал дашборда на более pro/trading-desk style: жёстче углы, дисциплинированная палитра, чище типографика. Цель — чтобы дашборд выглядел как взрослый продукт, не как набросок.

**Не-цели**: фичи не добавляем, бекенд не трогаем, структура DOM остаётся прежней.

## 2. Approach

**Подход: Token swap in place** (выбран из 3 предложенных). CSS переменные в `:root` + точечные правки компонентов где цвета захардкожены или цветовое кодирование не совпадает с новой палитрой. Никакого выноса SPA из template literal, никакой реструктуризации DOM.

Рассмотренные альтернативы:
- *Section-by-section migration* — отдельный PR на каждую секцию. Слишком медленно для чисто-визуальной работы.
- *Full rewrite SPA → standalone build* — это рефакторинг архитектуры под видом редизайна. Outside scope.

## 3. Design tokens

### 3.1 Theme system

3 темы через `body[data-theme="..."]`:

| Key | Background | Primary accent | Default? | Назначение |
|---|---|---|---|---|
| `pulse` | `#000000` | 🟢 green `#4ade80` | **✓ default** | Новый дефолт, "anti-AI" |
| `ink` | `#000000` | 🔵 X-blue `#1d9bf0` | — | Старый дефолт, сохраняется для существующих юзеров |
| `tide` | `#0a1622` navy | 🩵 cyan `#4dd4e0` | — | Существующая альтернативная тема, не трогается |

**Default flip**: текущий `:root` блок (X-blue) переезжает в `body[data-theme="ink"]`. Новый `:root` содержит pulse-tokens (green).

Существующие юзеры с сохранённой темой `ink` в localStorage **остаются на синей** — `setTheme` логика проставит `data-theme="ink"` атрибут. Новые юзеры → дефолт pulse.

### 3.2 Pulse theme tokens (green primary)

```css
:root {
  /* Background scale */
  --bg:           #000000;     /* total black, как у X */
  --surface:      #0a0a0a;     /* cards, sidebars */
  --surface2:     #16181c;     /* NEW — chips, inputs, hover */

  /* Borders — без изменений */
  --border:       rgba(239,243,244,.08);
  --border2:      rgba(239,243,244,.14);
  --border3:     rgba(239,243,244,.22);

  /* Text — без изменений */
  --text:         #e7e9ea;
  --text2:        #c4c8cc;
  --muted:        #71767b;
  --dim:          #4d5258;

  /* PRIMARY accent — главное изменение */
  --accent:       #4ade80;             /* было #1d9bf0 */
  --accent2:      #86efac;             /* было #4cb1ff */
  --accent-rgb:   74,222,128;          /* было 29,155,240 */
  --accent-glow:  rgba(74,222,128,.16);

  /* SECONDARY accent — то что раньше было primary */
  --secondary:       #1d9bf0;          /* NEW */
  --secondary-rgb:   29,155,240;       /* NEW */
  --secondary-glow:  rgba(29,155,240,.16);

  /* TERTIARY — warnings, saturated, decay */
  --warn:         #f59e0b;             /* NEW */
  --warn-rgb:     245,158,11;          /* NEW */
  --warn-glow:    rgba(245,158,11,.12);

  /* Radius scale — sharp */
  --r1: 2px;   /* chips, buttons, inputs */
  --r2: 3px;   /* thumbnails, small surfaces */
  --r3: 4px;   /* cards, panels */
}
```

### 3.3 Ink theme tokens (blue primary — preserves current)

```css
body[data-theme="ink"] {
  /* То же что сейчас в :root, плюс новые --secondary/--warn */
  --bg:            #000000;
  --surface:       #0a0a0a;
  --surface2:      #16181c;     /* NEW */
  /* ... текущие border/text/muted/dim неизменны ... */

  --accent:        #1d9bf0;     /* как было в old :root */
  --accent2:       #4cb1ff;
  --accent-rgb:    29,155,240;
  --accent-glow:   rgba(29,155,240,.16);

  --secondary:     #4ade80;     /* зелёный демотируется в secondary */
  --secondary-rgb: 74,222,128;
  --secondary-glow: rgba(74,222,128,.16);

  --warn:          #f59e0b;     /* tertiary одинаковый во всех темах */
  --warn-rgb:      245,158,11;
  --warn-glow:     rgba(245,158,11,.12);

  --r1: 2px;
  --r2: 3px;
  --r3: 4px;
}
```

### 3.4 Tide theme

Не трогается. Существующий блок `body[data-theme="tide"]` остаётся как есть. Если потом захотим — отдельный round.

### 3.5 Semantic usage rules

- **Primary accent (green)** — catalyst, strong phase, positive numbers, live indicators, primary CTAs (Details, Analyze). **~70% всех акцентов.**
- **Secondary accent (cyan)** — manual analysis, links, selected state, PRO badge, external-service actions (Sign in with Telegram, Ask Grok). **~20%.**
- **Warn (amber)** — saturated phase, decay warnings, budget alerts. Никогда для основных метрик. **~10%.**

В ink теме primary/secondary меняются местами. Семантика "manual = secondary accent" сохраняется в обеих темах.

## 4. Component-level changes

### 4.1 Header
- **Auto** (через токены): bg gradient, search focus border, X/TG/settings icons, profile chip.
- **Targeted**: `PRO`-бейдж — нужно проверить грепом, использует ли он `var(--accent)` или захардкожен. Если hardcoded — переключить на `var(--secondary)` (так в pulse теме останется синим, в ink — станет зелёным). Если уже через `--accent` — оставляем auto (станет зелёным в pulse).

### 4.2 Sidebar (left)
- **Auto**: активный bottom-nav таб, focus borders, scrollbar, slider track/fill — все через `var(--accent)`.
- **Targeted**:
  - **Phase chips** (ALL/EARLY/FORMING/STRONG/SATURATED): убираем разноцветный paint. Новая схема: STRONG = primary, FORMING = white, EARLY = muted, SATURATED = warn. ALL = primary когда активен.
  - **Type chips** (EVENT/TREND/POST/MANUAL): MANUAL → `var(--secondary)`. Остальные — neutral surface chips.
  - **Source-иконки** (𝕏/R/T/G/#): brand-цвета сохраняем (identification, не decoration).

### 4.3 Feed card (spacious layout)
- **Auto**: CATALYST badge, STRONG indicator, score numbers, кнопка Details (primary).
- **Targeted**:
  - **Score "circles"** (E/M/A): убираем светофор (high green / mid yellow / low red). Все на `var(--accent)`. Уровень показываем через bar-fill длину, не цвет.
  - **Velocity arrow** (↑ 3.4/h): зелёный только когда положительный, серый (`--muted`) когда нулевой.
  - **MANUAL chip** — `var(--secondary)`.
  - **Action icons** (star, hide) — `--muted` default, hover → `--text`.

### 4.4 AnalyzePanel
- **Auto**: основные кнопки, link "Source →".
- **Targeted**:
  - **Verdict banner** (high/mid/low): high → primary + glow, mid → white border + muted glow, low → warn.
  - **Score bars** (Emergence/Adoption/Story): fill через `var(--accent)`, не разноцветные.
  - **Stage loader** (4-dot breadcrumb): оставляем как есть, через токены автоадаптится.
  - **Forecast Catalyst** button → primary green.
  - **Ask Grok** button → `var(--secondary)` (external action).

### 4.5 Toasts (top-center)

Полная переделка визуала:

```
[icon] msg                                            [×]
```

- `border-radius: 999px (pill) → 2px (sharp)`
- `border: 1px кругом → 1px + 2px left-stripe` цвет по type
- `backdrop-filter: blur(14px) → удалить`
- Background → solid `#000`
- **Icons**: emoji ✓/✕/ℹ → SVG (feather-style, 14×14)
- **Close button**: 22×22 touch-target, SVG X 12×12, `--dim` default, hover белый + `--surface2` фон
- **Auto-dismiss 3s остаётся** (close-button это shortcut)
- **Optionally**: hover на toast → пауза auto-dismiss таймера
- **Новый type `warn`** (amber) — для budget-alerts, decay, saturated
- **`meta` блок (timer) убран** — не было нужен, упрощаем
- **Эмодзи в `addToast` calls**: прочесать grep'ом, выпилить эмодзи из начала строк. Все toast'ы получают SVG-icon из системы, не текстовый префикс.

Type tinting:
| Type | Left-stripe | Icon SVG |
|---|---|---|
| info | `--secondary` (cyan) | refresh-circle |
| success | `--accent` (green) | check |
| warn | `--warn` (amber) | triangle-bang |
| error | `#ef4444` red | circle-x |

### 4.6 LoginScreen (полный редизайн)

**Что меняется:**
- Border-radius 20px / 18px / 12px → **4px / 3px / 2px**
- `backdrop-filter: blur(12px)` → **удалить**
- Logo: 🐱 emoji fallback → **monogram `C`** в JetBrains Mono, green-glow tile (`border-radius: 3px`, `--accent-glow` background, `--accent` border)
- Title `font-size: 24px font-weight: 800` → **22px font-weight: 600**, `letter-spacing: -0.02em`
- **Subtitle "Sign in via Telegram" удалён**
- **Description**: убираем "No passwords" и em-dash `—`. Новый EN: `"Sign in via our Telegram bot. You'll get a 6-digit code to paste below."` RU: `"Войди через нашего Telegram-бота. Получишь 6-значный код, чтобы ввести его здесь."`
- **Button**:
  - Эмодзи `💬` → **SVG paper-plane** (feather-style, 14×14)
  - Gradient → **solid cyan** (`var(--secondary)` = `#1d9bf0`)
  - Text color → `#000`
  - Border-radius 12px → 2px
  - Hover: cyan glow + 1px cyan outline
  - Семантика: Telegram = external auth service → secondary accent. В обеих темах (pulse/ink) кнопка остаётся cyan, потому что secondary swap в ink сделает её green — но Telegram-button по бренд-смыслу остаётся blue. **Это override**: hardcode `background: #1d9bf0` без токена.
- **Ambient gradient**: opacity 18% → 10%, более рассеянный

**Что удалить:**
- `i18n.login.subtitle` (key + значения для en/ru)
- 💬 эмодзи из `login.idle_btn`
- "No passwords" из `login.idle_desc`
- em-dashes из `login.idle_desc`

### 4.7 Buttons / chips / inputs (atoms)

- **Primary button**: green fill, чёрный текст, 2px radius
- **Secondary button**: transparent + green/cyan border (через токены)
- **Ghost button**: transparent + muted text
- **Chip**: `--surface2` фон + `--border` border, 2px radius
- **Input**: `--surface` фон, focus border → `--accent`, 2px radius

Все через единые `.btn`/`.chip`/`.input` классы — токены подмениваются автоматически.

### 4.8 Empty / loading states / spinners

**Auto** через токены. Никаких targeted правок.

## 5. Out of scope (explicit)

### Backend — zero changes
- `src/index.js`, `src/sources/*`, `src/analysis/*`, `src/storage/database.js` — не трогаются
- API routes, payload shapes, SSE events — без изменений
- Auth flow — поведение идентичное
- DB schema — нет миграций

### Features — не добавляем
- ❌ TOP NARRATIVES sidebar (правый)
- ❌ LIVE metrics panel со sparklines
- ❌ Radar visualization в карточке
- ❌ Connection-stable indicator
- ❌ Любые новые фильтры

### Surfaces — не редизайнятся
- Admin SubmitPage / Decisions panel (`src/admin/server.js`) — отдельная поверхность, отдельный спек
- Telegram alert template (`src/notifications/telegram.js`) — текстовый формат, не визуал
- `body[data-theme="tide"]` — существующая альтернативная тема, остаётся

### Layout structure
- DOM tree остаётся идентичным
- Те же секции в том же порядке
- Никаких новых React components, никаких структурных JSX-правок (кроме LoginScreen где меняется иконка-button и удаляется subtitle, и Toasts где добавляется close-button)

## 6. Risks

### SPA-trap risk matrix

| Зона правок | Риск | Mitigation |
|---|---|---|
| `:root` + `body[data-theme="ink"]` блок | 🟢 низкий | Чистый CSS, никаких backticks/escape'ов. SPA-check после блока. |
| Замена hardcoded `#1d9bf0` / `29,155,240` | 🟡 средний | Grep на hardcoded цвета, аккуратная замена, SPA-check. |
| Targeted JSX fixes (phase chips, verdict, score circles) | 🟡 средний | Каждый Edit → SPA-check сразу. |
| Toasts refactor (новый JSX с close-button) | 🟡 средний | Один Edit на `Toasts` компонент + один на CSS. SPA-check после каждого. |
| LoginScreen refactor (большой JSX + i18n) | 🔴 высокий | 3 захода: (1) CSS tokens swap; (2) JSX (remove subtitle, SVG icon, monogram fallback); (3) i18n удаление 💬, em-dash. SPA-check между каждым. |
| Удаление 💬 в i18n EN строках | 🔴 высокий | EN-строки с апострофами (`you'll`, `it'll`) внутри backtick template + emoji в начале — критическая комбинация. Использовать `"..."` value для всех EN строк с апострофами. SPA-check обязательно. |
| Удаление эмодзи из `addToast(...)` строк | 🟡 средний | Grep по `addToast(`, поиск эмодзи-префиксов, замена. SPA-check. |

### Не-trap риски

- **Существующие юзеры на `ink` (старый default)** — после деплоя дефолт станет pulse, но кто уже залогинен и пользовался — их localStorage `theme=ink` сохраняется, они останутся на синем. Кто не выбирал тему — получит pulse.
- **Theme preview swatches** в settings (`src/dashboard/server.js:4069-4074`) — нужно добавить новый `pulse` preview.
- **`SUPPORTED_THEMES` массив** (`:6548`) — добавить `'pulse'` первым. `CURRENT_THEME` default → `'pulse'`.

## 7. Rollout

5 коммитов внутри Approach 1:

1. **Tokens + theme system** — `:root` swap, ввод `body[data-theme="ink"]`, новые `--secondary`/`--warn` токены, регистрация `pulse` в `SUPPORTED_THEMES`, обновление theme-preview swatches. Один коммит.
2. **Auto-affected components** — всё что было через `var(--accent)` автоматически становится зелёным. Деплой, проверим визуально что ничего не сломалось.
3. **Targeted fixes** — phase chips, score circles, verdict banner, manual chip, PRO badge, "Source/Ask Grok" buttons. Grep на hardcoded цвета.
4. **Toasts refactor** — новый JSX с SVG-icon + close-button, удаление эмодзи из `addToast` calls.
5. **LoginScreen redesign + i18n** — 3 захода внутри: CSS, JSX, i18n. + WORKLOG entry на всё.

**SPA-check ritual после КАЖДОГО блока**:
```bash
node scripts/check-dashboard-spa.cjs
```
Зелёный — едем дальше. Красный — `git revert` блока, разбираемся.

**Deploy**: стандартный `deploy.ps1`. Никаких миграций, никаких env vars.

**Откат**: каждый коммит изолирован, `git revert` чистый.

## 8. Verification checklist

После деплоя оператор проверяет:

1. Дефолтная тема — pulse (зелёный). Все CATALYST badges зелёные.
2. Settings → theme switcher показывает 3 темы (pulse / ink / tide). Переключение работает.
3. Юзер с сохранённой `ink` в localStorage — после деплоя видит синюю тему.
4. Feed card: score numbers зелёные, MANUAL chip cyan, SATURATED phase amber.
5. Login screen: monogram `C` (или PNG логотип), no 💬, cyan button, sharp 4px corners.
6. Toasts: появляются с SVG-icon + left-stripe + крестик справа. Клик на крестик закрывает мгновенно.
7. Auto-dismiss 3s работает.
8. AnalyzePanel: verdict banner высокий — зелёный, средний — белый, низкий — amber.
9. На пресете `tide` — всё работает по-прежнему (navy + cyan, не трогали).
10. Console clean — никаких ошибок React/CSS.

## 9. References

- Brainstorm session HTMLs: `.superpowers/brainstorm/1645-1779140509/content/*.html`
- Существующий dashboard: `src/dashboard/server.js`
- Текущая theme-система: lines 2577-2649, 6540-6580
- LoginScreen: line 11127
- Toasts: lines 4270-4319, 10044-10054
- WORKLOG: последние 3 entries про recent dashboard tweaks (manual analysis, AnalyzePanel, scroll-to-top)
