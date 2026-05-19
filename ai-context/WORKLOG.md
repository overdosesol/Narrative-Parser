# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 безархивации. Полная история — в git.

Если задача мелкая, например передвинуть кнопку в дашборде или изменить немного текст в промпте для llm, можно сразу не записывать в WORKLOG, а подождать пока накопится около 5 мелких правок или 1 большая и записать всё вместе.

---

## 2026-05-20 · sonnet · Dashboard redesign Round 4 — iconography sweep

**Триггер**: после Round 3 (градиенты + abyss-black) дашборд читался плоско, но ~90 эмодзи (категории, фазы, кнопки, settings rows, source glyphs) тянули его обратно в "AI-made". Round 4 закрывает редизайн: SVG icons (Lucide + Phosphor 2 exceptions + 5 brand glyphs), color-dot + uppercase text для phase/market state, plain text + color для sentiment.

### Что покрыто

8 коммитов в `src/dashboard/server.js`:

1. **`2764a6f` Icon helper foundation** — `makeIcon()` factory + `ICONS` registry + `icon(name, opts)` shim near JS-helpers section. Smoke icons: search, x.
2. **`7b1a69c` Brand SVGs (sources)** — 5 brand glyphs (reddit/twitter/google/tiktok/hash). `SOURCE_ICONS` → icon-key strings, обновил sidebar source rows + feed-card avatar + tw-prev-x + nav X button. Удалил `SOURCE_LOGOS` + `dangerouslySetInnerHTML` path. `SourceMark` теперь использует `icon()`.
3. **`cbd138b` Bottom-nav + sidebar phase chips + filters** — `flame/star/search` для Feed/Saved/Analyze. `PHASE_DOT` emoji glyphs (🔵🟡🟢🔴) → `phaseDot()` helper с CSS-coloured `<span>`. CSS `.phase-dot` + `.phase-dot.glow`. `CAT_ICONS` → Lucide-key strings. Type chips EVENT/TREND/POST → newspaper/trend/circle-dot. Включает `lock` icon для locked tabs.
4. **`df03dfc` Feed card chips/metrics/actions** — heart/message-circle/repeat-2/eye/arrow-up/award metrics, external-link/send/star/x actions, flask-conical для MANUAL badge.
5. **`cddf10a` Settings + Account icons** — 21 settings-area icons (settings (Phosphor) / palette/globe/user/refresh-ccw/archive/radio-tower/bell/sparkles/rows/log-out/activity/gem/bot/clock/bar-chart-3/zap/calendar*/brain/target/droplet/waves). `Row` component accepts icon-NAME strings (legacy emoji fallback оставлен). `Sheet` тоже. Language flags 🇺🇸/🇷🇺 → "EN"/"RU".
6. **`9a8f26c` Analyze panel + TrendModal** — alert-triangle/ban/x-circle/line-chart/thumbs-*/clipboard-check/inbox/search-x/book-open. Market stage: emoji → CSS dot/pulse/spinner (kind field). Sentiment text-only: i18n strings → POSITIVE/NEGATIVE/NEUTRAL без emoji. FeedbackBar thumbs SVG.
7. **R4 Task 7: Empty states + warnings + misc** — empty-feed inbox / search-x, error-bar alert-triangle, lock icons на locked sources + source-lock chip + stats banner, feed-search-icon, sort segments (rank/meme/emergence/time/virality → icon-name keys).
8. **R4 Task 8: i18n sweep + WORKLOG (this commit)** — strip leading emoji from ~50 translation strings (EN + RU). Update remaining JSX render sites to add icon() separately (modal-engagement metrics row, xtrends top tweets, archive snapshot banner, analyze action buttons, source-pulse render, account-hero gem chip, LoginScreen feature list). Nav-account avatar fallback 👤 → icon('user'). Nav logo onError 🐱 → "C" monogram inline. Window-pill locked emoji → icon('lock'). Manual filter chip emoji → icon('flask-conical').

### Архитектура

- `ICONS` registry — ~80 inline-SVG factories (Lucide stroke 2px + 2 Phosphor fill exceptions + 5 brand glyphs).
- `makeIcon(viewBox, stroke, ...children)` returns render function captured with viewBox + stroke/fill style.
- `icon(name, opts)` — use-site shim. `opts.size` default 14; `opts.color` cascades through inline style; `aria-hidden=true` unless `aria-label` set.
- `currentColor` everywhere — theming работает автоматически.
- `phaseDot(p)` helper для PHASE_META — color-circle через `<span>`.
- `MARKET_STAGE_UI.kind` field — `'dot'|'pulse'|'spinner'` — picks indicator type. CSS: `.market-dot` + `.market-spinner` + `@keyframes`.
- Sentiment: i18n POSITIVE/NEGATIVE/NEUTRAL + `.sentiment-chip` CSS (mono uppercase, currentColor border).

### Файлы

- `src/dashboard/server.js` — основной (~295k → 319k chars, +24k = inline SVG paths).
- `ai-context/WORKLOG.md` — этот entry.

### Деплой

Не деплоил — оператор сам через `deploy.ps1`. SPA check зелёный после каждого коммита.

### Риски / regression

- SPA-trap (backticks в comments) поймана 3 раза за работу — каждый раз сразу пофиксил, no commit on red.
- `Row` + `Sheet` components сохранили legacy-emoji-fallback ветку на случай если где-то остался не-мигрированный caller. Чисто defensive — после R4 не должно срабатывать.
- `SOURCE_LINK_LABELS` теперь plain text (`'Reddit'`, `'Twitter'`, etc) — на feed-action-btn открытия источника теперь нет эмодзи префикса. Brand recognition — через `icon(external-link)` slot уже добавлен.
- `MarketStageBadge` поменял shape — `kind` field вместо `icon`. Если где-то ещё читался `MARKET_STAGE_UI[stage].icon` (grep clean — нет), сломается. Final grep подтверждает.

### Оставшиеся эмодзи в файле

Все в comments (документация). Whitelist: `\u{1F300}-\u{1F9FF}` grep возвращает ~20 матчей, все из них — `//`-комментарии описывающие старые трапы или JSX (например `// 🔥 Trigger — concrete past-event`). Render path чистый.

---

## 2026-05-20 · sonnet · Dashboard redesign Round 3 — gradient removal (flat pass)

**Триггер**: после деплоя Round 2 (radius + density) оператор сказал "Может уберем все градиенты?". Цель — убрать оставшиеся декоративные `linear-gradient`/`radial-gradient`, оставив только functional (брендовые avatars, медальные TOP-1/2/3, shimmer-анимации, select-arrow icon-hack).

### Что покрыто

Один файл — `src/dashboard/server.js`. Точечный sweep по 48 gradient-правилам:

- **Heavy (видимые)**: CATALYST badge `.nav-logo-icon` + текст `.nav-logo-text`, `.nav-account-avatar`, `.meme-hero` modal hero, `.analyze-verdict.high/.low`. → solid альфы / `var(--surface2)`.
- **LoginScreen**: убраны 2 ambient `<div>` целиком — radial-blue-blob и grid-overlay (с radial-маской). Monogram h1 → solid `var(--text)`. Verify-кнопка градиент `accent→#146da8` → solid `var(--accent)`.
- **Decoration**: `.nav` bg `surface→bg` → solid `var(--surface)`. `.nav::after` accent-полоска → solid alpha. `.sidebar` bg, `.sidebar-footer` bg, `.sb-foot-btn.active::before`, `.stat-card::after` hover-полоска, `.feed-panel.is-refreshing::before` прогресс-бар — все плоско.
- **Subtle bg overlays**: `.status-pill`, `.analyze-loader`, `.analyze-result`, `.analyze-hero`, `.settings-info`, `.sheet`, `.sheet-head`, `.story-hook`, `.alert-math-panel`, `.feed-panel-head`, `.feed-desc.pump`, `.feed-score::before` divider, `.feed-card:hover` (pillowy hover) — gradient → среднее значение solid.
- **Button/bar fills**: `.range-slider` tracks (webkit + moz), `.feed-action-btn.primary` + `:hover`, `.cat-bar`, `.feed-image-placeholder` — все `accent→accent2` → solid `var(--accent)` / `var(--card2)`.
- **Confidence bars**: `.conf-low/.conf-mid/.conf-high` градиент `.7→1` alpha → solid full-opacity (semantic red/yellow/green сохранен).
- **Dead code**: `memeColor(v)` global function (shadowed внутри TrendCard `const memeColor = barColor(meme)`) — gradients заменены на возврат `var(--accent)`, добавлен комментарий что dead в дашборде.

### Что осталось (functional, не трогали)

- `select` arrow CSS-hack (45deg + 135deg triangles).
- `.meme-hero-fill::after` shimmer animation (loading indicator).
- `.skeleton` shimmer animation.
- `.feed-avatar.reddit/twitter/tiktok/google_trends/x_trends` — брендовые градиенты Reddit оранжевый / TikTok бирюза+малина / Google Material / X-чёрный → semantic.
- `.top-item-rank.top-1/.top-2/.top-3` — gold/silver/bronze медали (рейтинговая семантика).

### Follow-up: surface/card scale "abyss black"

После градиентного pass оператор сказал что cards читаются как "тёмно-серые" на чёрном bg. Crunched surface/card ladder в обеих темах (pulse + ink, tide-navy не трогал):

- `--surface`  `#0a0a0a` → `#050505`
- `--surface2` `#16181c` → `#0a0b0e`
- `--card`     `#16181c` → `#0a0b0e`
- `--card2`    `#1c1f24` → `#101114`
- `--card3`    `#232730` → `#16181c`

Depth-ordering сохранен (bg < surface < surface2/card < card2 < card3), но шкала смещена к `#000`. Borders (rgba) и текст не трогал — контраст с новым background чуть-чуть вырос, читается ОК. theme-swatch preview в settings (там hardcoded `#16181c` для card-чипа) показывает "старое" card-значение, но это превью-плашка размером 14px — переделаю если бросится в глаза.

### Деплой

Не деплоил — оператор сам через `deploy.ps1`. SPA check зелёный после каждой партии (4 партии: heavy → nav/sidebar/stripes → subtle overlays → confidence+hover+dead). Размер inner SPA: 295380 → 295419 chars (~+40 — комментарии добавлены, сами правила короче).

### Риски / regression

- LoginScreen теперь полностью пустой фон — Axiom-style ambient blobs и grid сняты. Может казаться "слишком пусто" — оператор это и просил.
- `.feed-card:hover` теперь solid `rgba(255,255,255,.025)` вместо gradient'а 4%→1.5% — оставил тот же tone, лифт от translateY+shadow остался.
- `memeColor()` function больше не возвращает gradient — все вызовы внутри TrendCard используют локальный const, поэтому изменение виртуальное. На случай если функция в проекте импортируется снаружи — теперь возвращает `var(--accent)` (consistent с barColor).

### Файлы

- `src/dashboard/server.js` — основной файл (одна серия Edit'ов).
- `ai-context/WORKLOG.md` — этот entry.

---

## 2026-05-20 · sonnet+haiku · Dashboard redesign Round 2 — radius + density polish

**Триггер**: после деплоя Round 1 оператор сказал "почти ничего не поменялось" — видны были только цвета. Реальная причина: Round 1 определил `--r1/--r2/--r3` токены, но не подключил их к существующим компонентам (углы остались мягкие 8-12px везде).

### Что покрыто

7 коммитов в `src/dashboard/server.js`:

1. **`556b57c` — sidebar sharp radius** (15 edits): source items, phase/type chips base rules, window/sort buttons, bottom nav, category dropdown — все на `var(--r1)` (2px).
2. **`0162982` — header sharp radius** (5 edits): brand logo, profile chip, icon buttons (X/TG/settings), search input.
3. **`e650a1e` — feed card sharp radius** (11 edits): card wrapper → `var(--r3)` (4px), thumbnails → `var(--r2)` (3px), badges/buttons → `var(--r1)` (2px).
4. **`659c388` — right column sharp radius** (10 edits): TOP NARRATIVES list items, LIVE metric tiles, sources indicator.
5. **`0ea03e0` — final radius sweep** (65 edits): AnalyzePanel, TrendModal, settings, account, hints, login button, archive carousel, alert forecast styles — всё что осталось >= 6px.
6. **`7fe3543` — density tightening** (18 selectors): padding/gap reduced 2-3px across sidebar source items, feed card padding, LIVE tile padding, TOP item padding, stat cards. Toasts, modals, login card оставлены spacious (readability priority).
7. **`ce0212e` — flatten nav/filter hovers** (9 rules): source items, phase/type chips, window/sort buttons, bottom-nav, header icon buttons, category dropdown, TOP NARRATIVES list — hover full-fill background → transparent + border emphasis. Action button hovers (toasts, primary CTAs, modal close, login button) preserved.

### Файлы
- `src/dashboard/server.js` — 7 коммитов (133+ edits total)
- `ai-context/WORKLOG.md` — этот entry

### Сохранены by design
- Toasts (Round 1 уже tight)
- Login card padding (centered surface, spacious read-friendly)
- Modal content padding (readability priority)
- AnalyzePanel verdict banner (emotional emphasis)
- `.toast-close:hover` (uses --surface2 as Round 1 spec)
- All `:hover` для action buttons (primary CTA, modal close, login button)
- Circles 50% (avatars, status dots, pulse indicators) — нетронуты
- Pills 999px на color dots — нетронуты

### Деплой
Стандартный `deploy.ps1`. Существующие юзеры — без сюрпризов (никаких new tokens / new behaviour, просто визуальная компрессия).

### Verification checklist
1. Sidebar source items — sharp углы (2px не 10px)
2. Phase/Type chips — sharp 2px (не pill)
3. Feed cards — 4px corners, тightер spacing
4. TOP NARRATIVES sidebar items — sharp
5. LIVE panel tiles — sharp
6. Header chips — sharp
7. Hover на sidebar item → border emphasis, не full-fill pillow
8. Overall feel — denser, less "AI-made", more trading-desk

### Что осталось как Minor / future polish
- `.analyze-score-value` per-level coloring (#ff7849 hex leak)
- LoginScreen feature list + tagline — hardcoded English orphans
- PHASE_META не theme-adaptive
- TrendModal styling — есть несогласованность с feed card
- Margins не трогали (только padding/gap)

---

## 2026-05-19 · sonnet+haiku · Dashboard visual redesign (token swap in place)

**Триггер**: оператор сказал "выглядит дёшево / by-an-engineer / AI-made", хотел sharper + дисциплинированную палитру. Опирался на собственный мокап в Claude Design (axiom-style trading-desk вайб).

### Brainstorm + spec + plan
- `/superpowers:brainstorming` → 6 визуальных axes locked: corners B-tight (2-4px), palette green primary + cyan secondary + amber tertiary, total black bg, шрифты Inter+JBM текущие, density A-spacious, login + toasts полный рефакш.
- Spec: `docs/superpowers/specs/2026-05-19-dashboard-redesign-design.md`
- Plan: `docs/superpowers/plans/2026-05-19-dashboard-redesign.md` (14 tasks, 5-rollout оригинальный → 17 commits итого)
- Execution: `superpowers:subagent-driven-development` — fresh implementer + 2-stage review (spec compliance + code quality) per task.

### Реализация (17 commits)

**Foundation (Tasks 1-2):**
1. `c304bf8` — pulse :root tokens (green primary, было X-blue)
2. `2adbc30` — fix-up: добавил пропущенные --surface2 + --r1/r2/r3
3. `e7b9324` — doc comment update (2 themes → 3)
4. `23d5cd4` — theme switcher registration (SUPPORTED_THEMES + THEME_META + preview swatch, default flip ink → pulse)

**Targeted fixes (Tasks 4-7):**
5. `535cf4f` — phase chips re-color (STRONG=accent / FORMING=white / EARLY=muted / SATURATED=warn)
6. `0b3e120` — fix-up: PHASE_META на feed-card badges тоже на новой палитре + EARLY active state distinct from hover
7. `b134fae` — MANUAL chip → --secondary (cyan/blue)
8. `7d74fc2` — feed card scores/velocity/actions: tier rainbow убран, all на --accent
9. `881aaef` — fix-up: .feed-fav-btn.saved:hover preserve accent + revert TrendModal scope creep
10. `c9b8ebb` — AnalyzePanel verdict (high/mid/low) + bars unified + Ask Grok → --secondary

**Toasts (Tasks 8-10):**
11. `434fb9a` — Toasts CSS: pill → sharp 2px, no blur, left-stripe by type, new warn type
12. `b6f2e03` — fix-up: .toast.error использует var(--red2) токен вместо bare hex
13. `56cc065` — Toasts JSX: SVG icons (feather) + close button + dismissToast handler
14. `1010e17` — addToast() calls: emoji prefixes stripped + EN/RU i18n cleanup

**LoginScreen (Tasks 11-13):**
15. `be5820d` — CSS overhaul: card radius 20px → 4px, logo tile 80→64, blur removed, ambient gradient слабее
16. `be178f8` — paper-plane SVG button (cyan hardcode #1d9bf0, чёрный текст) + monogram C fallback вместо 🐱
17. `b9503f7` — i18n cleanup: subtitle key DELETED, idle_desc rewritten без em-dash и "No passwords", drop 💬 + arrow emoji. ПЛЮС wire-up missing t() calls (pre-existing bug: LoginScreen JSX был hardcoded English, не вызывал t('login.idle_btn') etc. — теперь RU users реально видят русский).
18. `0a22003` — fix-up: stale LoginScreen header comment + RU "шестизначный" → "6-значный" consistency. (Кстати, первый attempt поймал SPA-trap: backticks в комментарии вокруг `login.*` сломали template literal — урок: даже в комментариях backticks нельзя.)

### Файлы
- `src/dashboard/server.js` — все 17 commits
- `ai-context/WORKLOG.md` — этот entry

### SPA-trap moments
- Task 1 implementer пропустил 4 токена (--surface2 + radius scale) — caught by spec reviewer
- Task 4 implementer не обновил PHASE_META для feed cards — caught by code quality reviewer
- Task 6 implementer создал .feed-fav-btn.saved:hover regression — caught by code quality reviewer
- Task 8 implementer использовал bare #ef4444 вместо var(--red2) токена — caught by code quality reviewer
- Task 13 — самый рискованный, EN apostrophe strings (You'll, It'll). Implementer корректно использовал double-quoted values.
- Я (coordinator) сам словил SPA-trap в Task 13 fix-up: backticks в комментарии вокруг login.* — сразу заметил и переписал в prose form.

### Деплой
- Стандартный `deploy.ps1` (without migrations).
- Существующие юзеры с `localStorage.ts_theme=ink` → остаются на синей теме (зелёный по умолчанию только для новых).
- Никаких миграций в БД, никаких новых env vars, никаких изменений в backend.

### Что НЕ сделано (deliberate, out of scope)
- TrendModal styling — несогласованность с feed card (Verify button code-phase, hero gradient bg) — отдельный future round.
- `.analyze-score-value` числа в AnalyzePanel остались per-level coloring (#ff7849 hex leak) — spec был про bars, не numbers.
- LoginScreen feature list + tagline — hardcoded English orphans, не было в scope.
- Legacy `memeColor()` функция и tier classNames в JSX — dead code, оставлено.
- "Анти-голость" fallbacks из brainstorm (micro-icons, per-source accent line, activity dot) — не trigger'нулись, ждут визуального assessment после деплоя.
- Theme adaptation для PhaseBadge (PHASE_META hex hardcoded) — pulse-only, не theme-swap. Acceptable trade-off.
- stage2Penalty chip typo bug (mult vs multiplier) — отдельная задача, не визуал.

### Риски post-deploy
- Existing users с сохранённой темой `ink` → видят синюю тему. Норм, by design.
- Legacy commits в БД с старой палитрой phase indicator — не пересчитываются, видны как есть до next scan cycle.
- `login.verifying` строка используется и для idle-phase "Please wait..." и code-phase "Verifying..." (раньше были раздельны). Brief loading flash, не critical.
- 64x64 logo tile может выглядеть mushy если PNG оптимизирован под 80x80 — visual judgement after deploy.

### Verification checklist (operator после деплоя)
1. Pulse тема (зелёный) — default для новых юзеров
2. Settings → Theme switcher показывает pulse / ink / tide. Переключение работает.
3. Существующий юзер на ink → видит синюю тему
4. Feed card: score numbers зелёные, MANUAL chip cyan, SATURATED phase amber
5. Login screen: monogram C (or PNG логотип), no 💬, cyan button, sharp 4px corners
6. Toasts: SVG icon + left-stripe + close button работают
7. Auto-dismiss 3s, click on × — instant close
8. AnalyzePanel: verdict high=green / mid=white / low=amber
9. Tide theme — без изменений
10. Console clean

---

## 2026-05-19 · haiku · Fix: добавить недостающие токены в dashboard-redesign

**Контекст**: Task 1 implementation был неполный (commit c304bf8). Spec reviewer обнаружил 4 токена отсутствуют в обоих `:root` и `body[data-theme="ink"]` блоках.

### Что добавил
`src/dashboard/server.js`:
- `:root` (line 2579): `--surface2: #16181c;` после `--surface`
- `:root` (line 2631–2633): `--r1/--r2/--r3` (2px/3px/4px) перед `--radius`
- `body[data-theme="ink"]` (line 2650): `--surface2: #16181c;` после `--surface`
- `body[data-theme="ink"]` (line 2676–2678): `--r1/--r2/--r3` перед `--radius`

Оба блока теперь синхронизированы — spec compliant. SPA check прошёл (295524 chars).

**Коммит**: 2adbc30 (`fix(dashboard): add missing --surface2 and --r1/r2/r3 tokens`)

---

## 2026-05-19 · sonnet · Text-only штраф теперь бьёт по memePotential, не только по alertScore

**Триггер**: оператор показал твит "Mall meet-and-greet chaos" с meme=100 viral=100 emerg=100, junk=2 (text-only + safe-override(÷3)). Junk-пеналти ушёл, но в карточке всё равно 100/100/100 — confusing AF.

### Что было сломано архитектурно
`noContentPenalty` из `junk-filter.js` копился ТОЛЬКО в `junkPenalty` (0–100), который потом × `weightJunk` (0.5) **вычитается из финального `alertScore`**. К `memePotential`/`score`/`emergenceScore` не прикасался вообще. Плюс safe-override делил text-only на 3 если в тексте было слово типа "chaos" (RE_ABSURD) — итоговый пеналти ≈2 punkt'a, чисто косметика.

### Фикс — три слоя

**1. `junk-filter.js` — text-only выносим из-под safe-override**
- Новый exports: `hasVisualContent(items)` (общий хелпер для junk-filter + scorer) и `isTextlessSource(s)` (set с `google_trends`).
- `textOnlyAddition` считается отдельно, не попадает в `raw` до safe-override.
- После division'а добавляется к `raw` напрямую → meme-shape слова больше не размывают сигнал об отсутствии медиа.

**2. `preset-config.js` + `filter-profiles.js` — бамп значений**
| Preset | Было | Стало |
|---|---|---|
| general | 5 | 12 |
| animals | 8 | 15 |
| culture | 6 | 12 |
| celebrities | 5 | 10 |
| events | 0 | 0 (не трогаем — news ОК текстом) |

**3. `scorer.js` — мультипликатор на memePotential/score (главное)**
Новая post-pass `applyTextOnlyMultiplier(trend, logger)` после Stage 2 для ВСЕХ трендов:
- Если `source ∈ {twitter, reddit, tiktok, instagram, threads, bluesky}` AND `!hasVisualContent(trend + items)` AND не textless-by-design → `memePotential *= 0.65`, `score *= 0.65`.
- Сохраняется `trend.textOnlyPenalty = { multiplier, memeBefore, memeAfter, viralBefore, viralAfter }`.
- Логируется: `Text-only penalty "..." × 0.65 meme 100→65 viral 100→65`.

**4. Admin SubmitPage** (`src/admin/server.js`):
- Чип `📝 Text-only ×0.65 — meme 100→65, viral 100→65` рядом с stage2Penalty/Bonus.
- Передаётся в `_hydrateTrendFromDb` + `_shapeManualTrend` чтобы после reload истории chip держался.

### Файлы
- `src/analysis/junk-filter.js` — exports + safe-override refactor
- `src/analysis/preset-config.js` — 4 preset bumps
- `src/analysis/filter-profiles.js` — same bumps в fallback profile
- `src/analysis/scorer.js` — import + applyTextOnlyMultiplier + post-pass call
- `src/admin/server.js` — chip + DB store + history hydrate

### Деплой
- `deploy.ps1` (без миграций — settings.presetConfigs пересохранится с новыми defaults только если override был равен прежнему default'у и `validateProfileOverrides` его дропнет; если оператор не правил руками — defaults применятся автоматически из bootstrap).
- Cache `RESULT_CACHE` в `manual-analysis.js` — in-memory Map, перезапуск процесса сбросит. Кеш-инвалидация не нужна.

### Риски
- **Legacy trends в БД** — `memePotential` уже записан, не пересчитывается. Старые text-only тренды в feed/admin останутся с прежним числом. Новые с этого момента — со штрафом.
- **Threads/Instagram/Bluesky** — добавил в social-sources на будущее, сейчас не активны.
- **Telegram alert text** — использует `trend.memePotential` после мультипликатора, так что в TG алертах число уже будет уменьшенным. Желаемое поведение.
- **stage2Penalty chip bug**: в admin SubmitPage код проверяет `t.stage2Penalty.mult < 1`, но scorer пишет `multiplier`, не `mult`. То есть Stage 2 penalty НИКОГДА не отображался в чипах (давний bug). Не правил — оставил для отдельной задачи.

### Проверка после деплоя
1. Manual analyze тот же text-only твит ("Mall meet-and-greet chaos") → должен вернуть meme≈65, viral≈65, chip `📝 Text-only ×0.65`.
2. Manual analyze твит с картинкой → штраф не должен сработать (no chip).
3. Manual analyze google_trends URL → штраф не должен сработать.
4. Junk math в SubmitPage: text-only пеналти не должен попадать в safe-override(÷3) — теперь должен быть полный (12 для general, не ~4).

---

## 2026-05-17 · sonnet · Manual analysis = full scanner pipeline (Emergence/Story fix)

**Триггер**: оператор пожаловался — manual analysis буквально бесполезен, Emergence и Story вечно 0. Скрин из дашборда: `EMERGENCE 0/100 LOW` для поста с 1M views. Хотим manual ≈ scanner для одинакового URL.

### Корни нулевых скоров
| Метрика | Откуда в scanner | Почему 0 в manual |
|---|---|---|
| Emergence | `clusterer.route()` сравнивает batch + DB row dynamics | Single trend в isolation → нет cluster context |
| Story | Stage 2 (Grok x-search) | Гейты `memePotential ≥ 60` + `isNovel ≠ false` режут слабые посты |
| PreStage | Step 2.5 в `runScanCycle` (явный вызов) | Был только через scorer's idempotency guard — ненадёжно |

### Реализация (4 этапа по плану)

**Этап 1 — PreStage** (`src/analysis/manual-analysis.js`):
Изменений в самом scorer'е не нужно — `scorer.scoreTrends()` уже auto-enrich'ает через idempotency guard на scorer.js:541. Но в manual я теперь вызываю `scorer.preStage.enrichBatch([synthetic])` ЯВНО ПЕРЕД scoring — чтобы `synthetic.preStage.nano.entityCanonical` был доступен для DB lookup'а на этапе 3.

**Этап 2 — Force Stage 2** (`src/analysis/scorer.js:513`):
- `scoreTrends(trends, opts = {})` теперь принимает второй arg
- `forceStage2: true` → bypass двух гейтов: `memePotential >= stage2Threshold` и `clusterMetrics?.isNovel !== false`
- `source !== 'google_trends'` гейт ОСТАВЛЕН — на gtrends entries Grok всё равно не может deep-dive'нуть (bare keywords, не URL)
- `stage2MaxCalls` cap остался — но manual single-trend, упирается в 1, не проблема
- Cost protection: per-user daily cap (`entitlements.manualAnalyze`: Test 5/day, Pro 100/day) уже в месте

**Этап 3 — Lookup-based emergence** (Variant A из плана):
- Добавил public-wrapper `NarrativeClusterer.computeSingleTrendEmergence(trend, {isNovel, dbRecentCount})` в `clusterer.js`. Дёргает существующий `_computeEmergenceScore` с conservative spread inputs (velocity=0, batchSize=1, batchAuthors=1, textVariation=0). Breakout-path и ideaBoost driveн `trend.metrics` напрямую → identical к scanner на single-trend viral постах.
- В `manual-analysis.js` ПЕРЕД scoring:
  1. Берём `synthetic.preStage.nano.entityCanonical` (fallback: longest word ≥5 chars из title)
  2. DB query: `SELECT COUNT(*) FROM trends WHERE last_seen_at > 6h_ago AND (title LIKE %needle% OR raw_metrics LIKE %needle%)`
  3. `isNovel = dbRecentCount <= 3` (тот же threshold что scanner — см. `_computeEmergenceScore` line 783-786 buckets)
  4. `emergenceScore = clusterer.computeSingleTrendEmergence(synthetic, {isNovel, dbRecentCount})`
  5. Set `synthetic.clusterMetrics = {emergenceScore, isNovel, dbRecentCount, ...defaults}` → scorer читает это на scorer.js:808 и пробрасывает на финальный `trend.emergenceScore`
- Эскейп для LIKE: `needle.replace(/[\\%_]/g, c => '\\' + c)` + `ESCAPE '\\'` clause (защита от user-controlled entity с `%`).
- Local `sqliteCutoff()` helper (формат `YYYY-MM-DD HH:MM:SS` без T — SQLite CURRENT_TIMESTAMP shape).

**Этап 4 — Cache TTL** (`manual-analysis.js`):
- `CACHE_TTL_MS`: 1h → 6h. Manual теперь дорогой (~$0.05 Grok + ~$0.005 Gemini + ~$0.001 nano), хочется чаще hit'ать. Оператор может re-open AnalyzePanel в течение рабочего дня без двойной оплаты.

**Этап 5 — UI loader** (`src/dashboard/server.js` AnalyzePanel):
- State `stageIdx` (0..3) + useEffect с `setTimeout` chain: PreStage → 3s → Stage 1, → 12s → Stage 2, → 45s → finalize. Backend не стримит progress, advances client-side по estimate'ам.
- CSS `.analyze-loader` — 36×36 spinner (rotating border), label с animated 3-dot ellipsis, breadcrumb trail (4 dots: done/active/pending).
- i18n: `analyze.stage_fetch/ai/deep/finalize` × EN+RU. EN: "Fetching post metadata / Running AI analysis / Deep search via Grok / Finalizing scores".
- Старый `"Usually takes 10-30 seconds"` hint span убран — заменён лоадером, expectation скрыт (оператор так попросил).

### Wiring `clusterer` → 3 call sites
`runManualAnalysis({clusterer})` опциональный (null fallback = legacy 0-emergence). Прокинуто:
- `src/index.js`: `new TelegramNotifier(..., scorer, clusterer)`; `new DashboardServer(..., { scorer, clusterer })`; `new AdminServer(..., { scorer, clusterer, ... })`
- `src/admin/server.js`: `this.clusterer = extras.clusterer` + `_submitNarrative` передаёт в runManualAnalysis
- `src/dashboard/server.js`: `this.clusterer = extras.clusterer` + `_handleManualAnalysis` передаёт
- `src/notifications/telegram.js`: 7th constructor arg + передаёт в `_runManualAnalysisForUser`

### Файлы
- `src/analysis/scorer.js` — `forceStage2` opt
- `src/analysis/clusterer.js` — `computeSingleTrendEmergence` public wrapper
- `src/analysis/manual-analysis.js` — explicit preStage call, DB-lookup emergence, forceStage2:true, cache TTL 6h, `sqliteCutoff` local helper
- `src/index.js` — wire clusterer
- `src/admin/server.js`, `src/dashboard/server.js`, `src/notifications/telegram.js` — accept clusterer, pass through
- `src/dashboard/server.js` — AnalyzePanel stage-loader (CSS + state + JSX + i18n EN/RU)

**SPA-check**: OK (dashboard 295524 / admin 266247).
**Syntax-check** (`node --check`): ok для всех backend файлов.

### Риски
- **Cost up**: каждый manual теперь = nano + Gemini + Stage 1 + forced Stage 2 = ~$0.06 vs было ~$0.01. Per-user cap (5/100 day) ограничивает; Test users могут хитить cap быстрее.
- **Latency up**: 10-30s → 30-90s. Лоадер с progress mitigate UX-боль; cache 6h съедает повторы.
- **Emergence approximation**: Variant A (LIKE search) пропускает синонимы. На viral постах с high engagement breakout-path даёт основной вклад (≥50 баллов на 1M views + 100K likes), spread-path добавка через `isNovel + dbRecentCount` — небольшой. Точность ±10% от scanner оценки. Если оператор скажет «всё ещё мимо» — мигрируем на Variant B (через embeddings).
- **Forced Stage 2 на бесполезных URL**: пользователь может submit мусор и сжечь свой 5/day cap. Trade-off, который оператор явно выбрал.

### Деплой
Операторский (`deploy.ps1`). После деплоя проверь:
1. Force Refresh / wait 1 cycle чтобы DB наполнилась
2. Analyze известного viral поста (>500K views) — Emergence должен быть ≥30, Story > 0
3. Analyze слабого поста — Emergence ≤20 (low signal), Story > 0 (forced Stage 2 всё равно отработает)

---

## 2026-05-17 · sonnet · AnalyzePanel redesign + dashboard Analyze landed в feed

**Триггер 1**: оператор пожаловался — Analyze из дашборда не появляется в feed, а manual submit из админки появляется.
**Триггер 2**: окно AnalyzePanel слишком технарское для конечного пользователя — Stage 1/2 pills, "memePotential 20 < threshold 70", голые цифры без контекста.

### 1. Bug fix: dashboard Analyze теперь персистится (`src/dashboard/server.js`)

`_handleManualAnalysis` ходил в `runManualAnalysis({ save: false, ... })` с комментом «private to caller, don't pollute global feed». Намерение было — Pro user не должен засорять shared feed. Но **админский путь** (`admin/server.js` `_submitNarrative`) использует тот же `runManualAnalysis` с `save: true` — потому из админки тренд попадал в DB, из дашборда нет.

**Фикс**: `save: true` в дашбордном пути. Тренды сохраняются с `raw_metrics.manualSubmitted=true` → в фиде показываются с бейджем `🧪 MANUAL`. TG-broadcast остался ТОЛЬКО за админкой (`_submitNarrative`) — дашбордный Analyze не спамит Telegram, просто кладёт в фид.

**Бонус**: после non-cache submit'а — `this.broadcast('refresh', ...)` SSE-событие, чтобы все подключённые дашборды автоматом подтянули новый тренд без F5. На cache-hit не бродкастю (новой DB-строки нет).

### 2. AnalyzePanel UI redesign (`src/dashboard/server.js`)

**До**: i18n кричит «Stage 1 + Stage 2 Grok», «POST URL», результат — два pills с техническим текстом + 3-4 серых score-карточки с голыми цифрами + плоский AI-блок.

**После** — структура сверху вниз:

1. **Verdict banner**: цветной (green/yellow/orange-red) хедер с одной строкой ответа: `🔥 Strong viral potential` / `📈 Some traction` / `💤 Unlikely to take off`. Уровень — bucketOf(max(meme, adoption)) ≥70/40/<40. Под заголовком — subtitle одним предложением («Этот пост попадает в паттерны нарративов, которые взрываются»).
2. **Hero**: thumbnail + title + meta (`source · analysed in 12.3s · category`) + actions (`🔗 Open original` + `👁 Open full details`).
3. **Score grid** (4 карточки: Viral potential / Trending now / Reach growth / Story strength): icon + label + `20/100` + **progress bar** (цвет от bucket) + **qualitative tag** «Low/Medium/High». Story показывается только при `> 0` (Stage 2 не всегда run).
4. **Why this score** (был «AI») — relabeled, читается как объяснение, не debug-дамп.
5. **Footer** — одна dim-строка вместо двух pills: `🔬 Deep analysis: completed` или `⏭ Deep analysis: skipped (low signal — saved you a Grok call)`. Сырое `memePotential 20 < threshold 70` ушло — это инфа для разработчика, не юзера.
6. **Usage** (test plan only) — крошечная строка, не конкурирует с контентом.

**Файлы**: `src/dashboard/server.js`:
- CSS добавлен — `.analyze-verdict`, `.analyze-score-bar`, `.analyze-score-tag`, `.analyze-footer`. Старые `.analyze-trace` / `.analyze-pill` оставлены — могут переиспользоваться в других местах (граппнуть через ide → нет, только AnalyzePanel; реально мёртвые, но удалю отдельно).
- i18n EN + RU добавлено ~15 ключей: `verdict_high/mid/low`, `verdict_sub_*`, `score_meme/emerge/adopt/story`, `score_low/mid/high`, `why_label`, `deep_ran/skipped`, `open_link`. Старые ключи `intro` / `title` переписаны (был «Manual analysis (Stage 1 + Stage 2 Grok)» — стал «Analyze a post — paste a link, get viral potential»).
- JSX: верстка через data-driven `scoreSpecs.map()` вместо ручных 4 карточек.

**Gotcha** (поймал): `'today\'s trends'` в EN-строке внутри outer template literal сломал SPA — backslash escape `\'` в template literal evaluate'ится в `'`, и output JS видел `'today's trends'` → SyntaxError 'Unexpected identifier "s"'. Фикс — value на двойные кавычки: `"today's trends"`. Template literal не парсит `"` как спец-символ. Решил так, а не `today\\'s` (двойной escape тоже работал бы, но менее читаемо). Записал в memory: **в i18n EN строках с апострофами всегда юзай `"..."` для value**.

**SPA-check**: OK (293625 chars).
**Деплой**: операторский.
**Риски**:
- save:true в дашборде — Pro users теперь могут засорять feed «мусорными» URL. Видно по бейджу `🧪 MANUAL`. Если шум станет проблемой — можно добавить scoring-threshold (низкие memes не сохранять) или per-user TTL. Сейчас admin-плана достаточно (operator = main user).
- Старые `.analyze-trace` / `.analyze-pill` стили — dead code, удалю отдельным entry.

---

## 2026-05-16 · sonnet · Dashboard UX-пачка + deploy-aware scheduler

Накопилось 5 мелких правок + 1 средняя — пишу одним entry per WORKLOG-rule.

**1. ALL chip ресетит обе оси типа** (`src/dashboard/server.js`)
- Раньше клик на ALL чистил только `alertTypes`. Если `manualOnly=true` сохранён в localStorage от прошлого клика на «🧪 Ручные» — фид оставался залочен на manual-only, чип ALL подсвечивался как «активен» (врал).
- Теперь: ALL → `setAlertTypes('') + setManualOnly(false)`. `activeAll = atypeArr.length === 0 && !manualOnly`. Manual чип остался отдельной UNION-кнопкой (Event+Manual = event OR manual rows).

**2. Toast UX** (`src/dashboard/server.js`)
- `addToast` setTimeout `4000 → 3000` (короче и не мешает).
- `toast.refreshing`: `'Refreshing…' → 'Refreshed'` / `'Обновляю…' → 'Обновлено'`. Toast висит после клика по Refresh, present continuous звучал странно (действие уже завершено к моменту показа). `feed.refreshing` (inline-лоадер внутри ленты) не трогал — там present норм.

**3. Scroll-to-top кнопка** (`src/dashboard/server.js`)
- Floating круглая кнопка `↑` появляется когда `.main-feed.scrollTop > 400px`, по клику `scrollTo({top:0, behavior:'smooth'})`.
- Listener на `.main-feed` (не window), throttle через rAF.
- **Gotcha #1** (auth gate): первый эффект-рендер ставит deps `[mainFeedRef]` — стабильный ref-объект, эффект ни разу не перезапустится. Когда `me === null` LoginScreen рендерится, `.main-feed` ещё не в DOM, `ref.current = null` → effect бейлится навсегда. Фикс — deps `[me, view]`, перезапуск при логине/переключении вкладки.
- **Gotcha #2** (SPA-trap): в первой попытке написал в комменте `` `me` `` / `` `view` `` с бэктиками — закрылся внешний template literal, SPA сломался с `Unexpected identifier 'me'`. Заменил на `"me"` / `"view"`. После каждой правки server.js — `node scripts/check-dashboard-spa.cjs` обязателен.
- Позиция: `top: 60px; left: 50%; transform: translateX(-50%)`, 22×22px кругляш. Hover/active/keyframes сохраняют `translate(-50%, ...)`, иначе кнопка скачет вправо при анимации.
- i18n: `feed.scroll_top` = `'Scroll to top'` / `'Наверх'`.

**4. Velocity убрана из feed-карточек** (`src/dashboard/server.js`)
- `metaParts` больше не пушит `vel` — бейдж `1005.2/h ↑` исчез. Сам `trend.velocity` остался (модалка в Metrics показывает, twitter-engagement update пишет), это чисто визуальное декларирование.

**5. @handle убран из feed header'а** (`src/dashboard/server.js`)
- Span `.feed-handle` (`@twitter_x`, `@google`, `@x_trends`) удалён — был синтетический per-source, не настоящий автор. Теперь хедер: `[avatar] Twitter/X · 21h 57m ago [badges]`.
- `feed-dot` оставил — единственный разделитель источник↔время.

**6. Deploy-aware scheduler** (`src/index.js`) — главная правка
- **До**: `startScheduler` всегда дёргал `runScanCycle()` immediately on boot → каждый деплой сжигал полный collect+scorer цикл сразу.
- **После**: в `finally` блоке `runScanCycle` пишется `db.setSetting('lastScanCompletedAt', String(Date.now()))`. На boot scheduler читает этот ts, считает `sinceLast = now - lastScanAt`:
  - `sinceLast < intervalMs` → wait `intervalMs - sinceLast`, потом scan + `scheduleNext()`. Лог: `"Resuming after restart — last scan Xm ago, next in ~Ym"`.
  - `lastScanAt === 0` → первый boot ever → scan now.
  - `sinceLast >= intervalMs` или отрицательный (clock skew) → stale, scan now. Лог: `"Interval elapsed during downtime (Xm) — scanning now"`.
- Манульные триггеры из dashboard/admin тоже пишут `lastScanCompletedAt` — это правильно, deploy-resume считает их за полноценный scan.
- `appState.paused` НЕ обновляет ts (early-return до try-блока). Если оператор паузил скан перед деплоем → после рестарта таймер не сдвинется, scan не запустится сам, scheduler уйдёт в setTimeout как обычно. Корректное поведение.

**Файлы**: `src/dashboard/server.js` (5 правок), `src/index.js` (deploy-resume).
**SPA-check**: OK (~288k chars).
**Деплой**: операторский (`deploy.ps1`).
**Риски**: deploy-resume — `db.getSetting` валидируется только Number-cast (`|| 0`), corrupted value безопасно деградирует к "scan now". Если оператор хочет принудительно скан после деплоя — `DELETE FROM settings WHERE key='lastScanCompletedAt'` или Force Refresh из админки.

---

## 2026-05-16 · opus · Tag-refresher: empty-array guard + промпт против sparse output

**Триггер**: оператор скинул raw `presetConfigsAuto` после удачного refresh — `animals.twitter.queries: []`, `events.twitter` 2 шт., `culture.twitter` 1 шт., `celebrities.tiktok` 3 шт. (target 8-10), плюс галлюцинация `gumite` (несуществующее слово) в `events.twitter`. Grok ленится и галлюцинирует.

**Диагноз** — два независимых бага:

**Баг 1 (механика)**: `_applyAutoOverride` писал `{ queries: [] }` в auto-blob когда Grok возвращал 0 items. Empty array через `deepMerge` top-layer-wins **полностью ЗАМЕНЯЛ** defaults → production collector видел zero queries → no-op cycle. Та же грабля что мы фиксили в admin UI, но на стороне tag-refresher.

**Баг 2 (промпт)**: текущий промпт говорит «do NOT repeat existing items» + «Honesty over format compliance: empty/short list BETTER than fabricated». Для animals preset весь дефолт уже в existing list → Grok видит «нельзя повторять» + «можно вернуть пусто» → возвращает `[]`. Анти-галлюцинация была размыта → `gumite` проскочил.

**Что сделано** (1 файл, `src/refresh/tag-refresher.js`):

1. **`_applyAutoOverride`** — empty-array guard:
   - Если `finalSubs.length === 0` → `delete auto[preset].sources.reddit` + warn-лог.
   - То же для twitter и tiktok.
   - Если все три source-слота сдохли → `delete auto[preset].sources` → `delete auto[preset]`.
   - Семантика: «Grok вернул 0» теперь = «defaults остаются в силе», а не «production обнуляется».

2. **`_buildPrompt`** — переписан с трёх углов:
   - **Минимум 6 items per source**, target 8-10 (TikTok 8-12). NEVER empty array.
   - **EXISTING list переинтерпретирован**: было «do NOT repeat», стало «verified baseline you can keep — use it to fill the gap». Если Grok не находит 8 свежих → берёт theme-relevant из existing + добавляет сколько может верифицировать.
   - **Anti-hallucination HARD rules**: «NEVER invent English words. Every keyword/hashtag must be real with x_search hits. If x_search returns zero hits → DROP, don't pad with fakes». Конкретно упомянул `gumite` как пример anti-pattern.

3. **TAG_REFRESH_SYSTEM_PROMPT** — поправлена строчка «Honesty over format compliance: empty list BETTER than fabricated» → теперь «Honesty over fabrication: never pad with invented words; BUT don't return short/empty either — fill from existing».

**Деплой**: `deploy.ps1`. Следующий tag-refresh цикл (next `refreshAll()`, every 2 days по `TAG_REFRESH_COOLDOWN_DAYS`, либо «Force refresh now» из админки) использует новый промпт. Empty-array guard работает уже сейчас, до следующего refresh.

**Риски**: новый промпт длиннее на ~300 символов — стоимость Grok input чуть выше (~$0.0005 на refresh). Если Grok всё ещё ленится после изменений → variant A (programmatic composition from defaults) остаётся в комментарии `_refreshGeneralAsCurator` как escape hatch.

**Что НЕ сделано** (опции на будущее):
- `_buildExistingList()` всё ещё читает из `DEFAULT_PRESET_CONFIGS`, не из текущего `presetConfigsAuto`. Грок не видит ПОСЛЕДНИЕ auto-refreshed теги как «verified baseline», только hardcoded дефолты. Стоит расширить если хочется чтобы Grok сохранял auto-state между циклами.
- Twitter reality-check (`_realityCheckTwitter`) пропустил `gumite` — анти-галлюцинация только в промпте. Если повторится — добавить regex-check на dictionary-word в `_sanitizeResponse`.

---

## 2026-05-16 · opus · Admin: `getEffective` теперь делает 3-layer merge как production (фикс «auto-tags работают только для general»)

**Триггер**: оператор: «при авто-тегах будто ищет только по general пресету. Стоял Animals 2 дня, но искало всё». SQL подтвердил `activePreset=animals`, но в админке (Presets → Animals → Sources) все chip-листы пустые (`0/30 items`).

**Диагноз** — **второй слой того же бага что я фиксил 2026-05-12**:
- 12-го числа поправил `_getPresetConfigs` чтобы в response летел `effective` (3-layer merged) и `autoOverrides` отдельно.
- НО UI-компоненты чипов читали через `getEffective(preset, path)` который walks ТОЛЬКО `draft → defaults`, полностью **игнорируя `data.autoOverrides`**.
- Когда оператор открыл Animals tab, увидел пустые поля (auto layer не показан, а manual после Wipe тоже пустой). Подумал «auto не сработал» и **поудалял chips один-за-другим**.
- Каждое удаление chip'а пишет в draft empty-array `[]`. На Save оно попало в `settings.presetConfigs.animals.sources.{reddit,twitter,tiktok}` как explicit empty arrays.
- Production's `getActivePresetConfig` через `deepMerge` — массивы не мержатся, top layer wins. Manual=`[]` ЗАМЕНИЛ auto+defaults → коллекторы Reddit/Twitter/TikTok получили **ноль queries** для Animals.
- Фид при этом продолжал жить за счёт (1) stale данных из прошлых циклов, (2) X Trends + Google Trends — оба коллектора preset вообще игнорируют (firehose).

**Что сделано** (1 файл, `src/admin/server.js`):

`getEffective(preset, path)` теперь делает proper 3-layer merge **точно как production**:
```js
const fromDraft = walk(draft[preset], path);
if (fromDraft !== undefined) return fromDraft;
const fromAuto = walk(data?.autoOverrides?.[preset], path);
if (fromAuto !== undefined) return fromAuto;
return getDefault(preset, path);
```

**Post-deploy инструкция оператору**:
1. Нажать **🧹 Wipe manual** в админке (Preset configs → top buttons).
2. Save → `settings.presetConfigs = {}` → broken empty-array overrides уйдут.
3. Reload админки → Animals tab → должны увидеть **animal-themed chips** (auto layer Grok-refreshed queries).
4. Production коллекторы со следующего цикла начнут пробивать `r/aww`, `(capybara OR otter)`, `#animalsoftiktok` etc.

**Сопутствующая мысль (не реализована)**: empty-array-в-manual ломает 3-layer семантику. Если оператор хочет «вернуться к auto» — единственный текущий путь это нажать ↺ Reset на конкретном поле (это пишет default, GC дропает leaf → auto оживает). Если в будущем будет повторяться — добавить в `setLeaf` GC empty arrays когда auto имеет non-empty (но тогда теряем legitimate use-case «отключить Twitter для preset»). Пока оставил руль на операторе.

**Деплой**: `deploy.ps1`. SPA-check 265535 chars OK.

**Риски**: после deploy + Wipe + Save оператор должен быть ГОТОВ что в Animals tab появятся незнакомые chips из auto-refresh. Если они выглядят не-animal (Grok strayed) — это уже отдельный bug, лечится корректировкой `_buildPrompt` per-preset theme или ужесточением reality-check.

---

## 2026-05-16 · opus · Dashboard: feed search переехал на server-side (фикс «search at 24h not finding things»)

**Триггер**: оператор: «Поиск работает только на 6h, а если на 24h то не ищет один и тот же алерт». Скрины: при 6h `Narrative Feed 1 / 205`, при 24h `Narrative Feed 0 / 577` (один и тот же search query).

**Диагноз**: поиск был полностью client-side — фильтровал массив `trends` уже загруженный в state. SPA грузит первые `LIMIT = 25` строк отсортированных по `rank/meme/...`. При 6h в окне всего ~200 трендов, целевой в top-25 → найден. При 24h 577 трендов, целевой свалился на #100+ по rank → даже не загружен в client state → search его «не видел». То же самое на 3d/7d. Lazy-load подгружал страницы при скролле, но при активном search guard в IntersectionObserver блокировал пагинацию вообще.

**Что сделано** (1 файл, `src/dashboard/server.js`):

1. **Server** (`_handleTrends`): парсит `?q=` (trim, length cap 80). Если непустой — добавляет `AND (title LIKE ? ESCAPE \\ OR original_title LIKE ? ESCAPE \\ OR ai_explanation LIKE ? ESCAPE \\ OR category LIKE ? ESCAPE \\)` к WHERE. User-input wildcards `%`/`_`/`\` экранируются явно. Count query reuses тот же WHERE → `tr.total` сразу отражает количество match'ей.

2. **Client**:
   - Новый state `searchDebounced` + `useEffect` со `setTimeout 250ms` мирорит `search`. Раздельные state'ы: `search` для controlled input + UI affordances (counter, empty-state), `searchDebounced` для fetch trigger.
   - `useEffect(() => setOffset(0), [searchDebounced])` — сбрасывает пагинацию при смене query.
   - Оба query builder'а (`fetchData`, `refreshAll`) теперь шлют `&q=<encodeURIComponent>` и имеют `searchDebounced` в deps.
   - Старый client-side filter `searchFiltered = search ? trends.filter(...) : trends` превращён в pass-through (комментарий-объяснение). Downstream `visibleTrends` логика осталась.
   - В infinite-scroll guard убран `if (search.trim()) return;` — теперь scroll работает и при активном поиске (server paginates filtered set).

**SQLite caveat**: `LIKE` case-insensitive для ASCII, не для Cyrillic. Заголовки трендов в основном английские → ОК на сейчас. Если понадобится — добавить ICU extension или PRAGMA для full case-folding.

**SPA-trap rake** (опять): первый заход добавил три комментария с backtick'ами: `\`search\``, `\`?q=\``, `\`if (search.trim())...\``, `\`searchFiltered\``. Это закрыло outer template-literal → `node -c` упал на `Unexpected identifier 'search'`. Фикс: убрал backtick'и, заменил на `"..."`. Третий случай за неделю — стоит в SESSION_CONTEXT добавить явное правило: **никаких backtick'ов в комментариях внутри SPA**.

**Деплой**: `deploy.ps1`. SPA-check 285703 chars OK.

**Риски**: на больших окнах (7d, 577+ трендов) SQL LIKE без индекса работает sequential scan по `trends`-таблице. Сейчас retention 7d × ~80 трендов/час ≈ 13K строк max — секвенциальный LIKE на 4 колонках это <50ms на SSD. Если retention вырастет — поднимать FTS5 виртуальную таблицу.

---

## 2026-05-14 · opus · Dashboard: Font size setting удалён (был визуально no-op'ом)

**Триггер**: оператор: «Что делает в настройках Font size? При переключении ничего не происходит».

**Диагноз**: настройка существовала, но **ничего не делала**. `applyPrefsToDOM` (`dashboard/server.js` ~10213) писала `body.style.setProperty('--user-font-size', p.fontSize + 'px')` — и **ни одно CSS-правило эту переменную не читало**. Грепнул весь файл, единственное упоминание `--user-font-size` — само присваивание. Все размеры шрифтов в SPA-стилях захардкожены в px (~сотни мест). UI-переключатель S/M/L подсвечивался активным, localStorage обновлялся, но ноль визуального эффекта.

**Что сделано** (1 файл, `src/dashboard/server.js`):

- UI `h(Row, ...)` блок с переключателем S/M/L — удалён, оставлен arch-комментарий.
- `DEFAULT_PREFS.fontSize: 14` — удалён.
- `applyPrefsToDOM`: строка с `setProperty('--user-font-size', ...)` — удалена.
- i18n-ключи `settings.font_size` + `settings.font_size_desc` (RU + EN) — удалены.

**Trap-rake**: первый заход добавил комментарий с backtick'ами вокруг `--user-font-size`. Это закрыло **outer SPA template-literal** — `node -c` упал с `Invalid left-hand side expression in postfix operation` (CSS-переменная `--user-font-size` после закрытой backtick'и парсилась как `-- user-font-size`, постфиксный декремент). Фикс: убрал backtick'и в комментарии. SPA-trap (`CLAUDE.md → «Ловушка server.js»`) reminder.

**Деплой**: `deploy.ps1`. SPA-check 284478 chars OK.

**Риски**: если кто-то хочет реально менять размер шрифта — будет нужен em/rem refactor по всему SPA CSS (~100+ правил), сейчас всё в px. Альтернатива на будущее: `body { zoom: var(--user-zoom, 1) }` — масштабирует всю страницу включая иконки/паддинги.

---

## 2026-05-14 · sonnet · Dashboard: sidebar Adoption filter удалён целиком

**Триггер**: оператор: «Я хочу вообще убрать фильтр Adoption слева в дашборде».

**Что сделано** (1 файл, `src/dashboard/server.js`, серия согласованных правок):

- **UI-блок** sidebar `filter-group` «Adoption threshold (segmented)» — удалён (был segmented control [0, 30, 50, 70, 85]).
- **State**: `useState minMeme/setMinMeme` — удалён.
- **Query-builder**: убран `&minMeme=...` из обоих `?` (refresh + refreshAll).
- **Dep arrays** обоих useCallback'ов — без `minMeme`.
- **resetFilters**: убран `setMinMeme(0)`.
- **Active-filters indicator** (`hours !== 24 || minMeme !== 0 || ...`): убран `minMeme !== 0`.
- **Server**: `parseInt minMeme` + `if (minMeme > 0) WHERE memePotential >= ?` удалены. Комментарий: «param silently ignored if older clients send it» — backward-safe.
- **i18n**: ключи `sidebar.adoption` (RU + EN) удалены — больше не используются.
- **Сопутствующее**: `account.threshold_desc` (RU + EN) и комментарий к нему ссылались на «sidebar Adoption filter» — упоминания убраны.

**Деплой**: `deploy.ps1`. SPA-check прошёл (285039 chars OK).

**Риски**: per-row Adoption-bar в карточках треда остаётся — оператор/юзер всё ещё видит score. Если кто-то хочет фильтровать — есть sort `meme` (топ по adoption). Серверный фильтр не сломан, просто param никто не шлёт.

---

## 2026-05-14 · sonnet · Ask Grok prompt — narrative-name chapter переписан: «найди», а не «придумай» (dashboard + telegram bot)

**Триггер**: оператор: «Нужно в промпте грока (Ask Grok) изменить главу про название нарратива — нужно чтобы он искал названия, а не придумывал их». Follow-up: «Еще в тг боте остался самый первый старый промпт».

**Что было**:
- **Dashboard** (`dashboard/server.js` ~9395-9427): 6-пунктовый промпт, но пункт 1 формулировался как «предложи 2-3 варианта, каждый короткий и ёмкий (2-5 слов)» → Grok галлюцинировал свои.
- **Telegram bot** (`telegram.js:27-38` `buildGrokUrl`): жил легаси-однострочник ещё с MVP — `«How viral is this narrative right now? <title> - <url>»`. Никаких пунктов, никакого структурного ответа.

**Что сделано** (2 файла, оба двуязычных RU+EN):

1. **`src/dashboard/server.js`** → Ask Grok modal-link prompt, пункт «1. Название нарратива»:
   - «**НАЙДИ как его уже называют в постах/тредах X** за последние 24-48 часов: устоявшиеся хэштеги, повторяющиеся фразы из шапок постов, ключевые слова из топ-комментариев.»
   - «**НЕ ПРИДУМЫВАЙ** свои варианты.»
   - «для каждого укажи источник (пример: `#PunchMonkey — 12K постов` или `"Hawk Tuah girl" — фраза из вирального клипа`).»
   - «Если устоявшегося имени нет — честно напиши `устоявшегося названия пока нет, чаще всего описывают как: <короткая фраза>`.»

2. **`src/notifications/telegram.js → buildGrokUrl`**: однострочник заменён полным 6-пунктовым промптом — синхронизирован с dashboard-версией. Пункты: name (find, don't invent) / why viral / why grow / potential / risks / audience. Док-комментарий теперь явно говорит «keep the two in sync» — чтобы в будущем правки шли парой.

**Деплой**: `deploy.ps1`. После — клик «🧠 Ask Grok» под алертом в Telegram или в модалке дашборда → Grok откроется с одинаковым промптом.

**Риски**: длина промпта выросла (~80 → ~2000 символов). `grok.com/?q=` URL-encode не имеет публично задокументированного лимита, но браузеры обычно нормально кушают URL до 8K. Если упрёмся — резать другие пункты, не этот. SPA-trap в dashboard через `String.fromCharCode(10)` сохранён; в telegram.js (не-SPA) можно литералы `'\n'`.

**Update 2026-05-16**: упёрлись — grok.com отвечал HTTP 431 «Request Header Fields Too Large». Кириллица в URL-encode = 6 байт/символ (`%D0%9D`), ~1550 рус. символов = ~8.5KB query → за лимитом сервера grok.com. Сократил пункт 1 до сути: «Название — НАЙДИ как уже называют в X за 24-48ч (хэштеги, повторяющиеся фразы). НЕ ПРИДУМЫВАЙ. 2-3 варианта буллетами с источником…» — сэкономил ~400 символов, URL теперь ~6.2KB, проходит. Правило про геопривязку не-английского вырезано (edge-case). Применено в обоих местах: `dashboard/server.js` Ask-Grok modal + `telegram.js buildGrokUrl`.

---

## 2026-05-14 · sonnet · Fix: TikTok max-age filter (evergreen 2023 videos surfacing as fresh alerts)

**Триггер**: оператор: «В тиктоке приходят алерты для видео из 2023 года».

**Диагноз**: TikTok-страница `/tag/<x>` ранжируется редакционно, а не хронологически. Apify-actor (clockworks/apidojo) возвращает evergreen-видео из 2023-2024 среди свежих. Они проходят engagement floor (миллионы просмотров накопились за годы), PreStage и Stage 1, прилетают как «свежий тренд». В `tiktok.js _normalize` `ageHours` уже считался (`createTime` / `uploadedAt`), но **не использовался для фильтра**. У Twitter симметричная защита (`twitterMaxAgeHours`, default 72h) есть с давних пор — у TikTok была дыра.

**Что сделано** (3 файла):

1. **`src/collectors/tiktok.js _normalize`**: после расчёта `ageHours` добавлен max-age filter — читает DB-setting `tiktokMaxAgeDays` (default 7), `return null` если `createdAt && ageHours > maxAgeDays * 24`. 0 = выключено. Видео без timestamp пропускаются без проверки (редкий edge-case).

2. **`src/admin/server.js`**:
   - В `_getScannerConfig.numDefaults` добавлен `tiktokMaxAgeDays: 7`.
   - В `_setScannerConfig.allowedInt` — `{ min: 0, max: 60 }`.
   - В UI секция «🎵 TikTok — фильтр по возрасту» сразу под Twitter-фильтром (range 0-60d, step 1, label `Nd` / `0 (off)`).

3. **`ai-context/SESSION_CONTEXT.md`** → секция TikTok specifics — новый блок «Max-age filter».

**Деплой**: `deploy.ps1`. После — крутить ползунок без рестарта (читается каждый Apify-call). 7d — рекомендованный default, оператор выбрал.

**Риски**: при `maxAgeDays=7` можно срезать медленные tail-всплески (видео залило неделю назад, начало вируситься сейчас). Если оператор увидит false-negative — крутить ползунок выше (14d/30d) без редеплоя.

---

## 2026-05-12 · sonnet · Fix: admin UI showed only `defaults+manual` без auto-layer (3-layer merge dropped one layer)

**Триггер**: только что разделил Clear ALL на 2 кнопки (Wipe manual / Restore hardcoded). Юзер: «Обе кнопки возвращают старые пресеты». То есть после Wipe manual в UI **все равно** виден legacy skibidi-блок, хотя `presetConfigsAuto` точно содержит свежие Grok queries (проверено SQL).

**Диагноз**: `_getPresetConfigs` (admin endpoint) считает `effective` через `getEffectivePresetConfigs(overrides)` где `overrides` = **только manual layer**. Auto-tags layer в этом merge **полностью игнорировался**. Production-side `getActivePresetConfig` правильно делает 3-layer (`defaults → auto → manual`), но **admin UI лгал**:
- Wipe manual → manual=∅ → admin показывает `defaults` (= hardcoded skibidi) ❌
- Restore hardcoded → manual=defaults.sources → admin показывает то же самое ❌

То есть auto-tags layer работал нормально на проде (collectors шли по свежим queries), но в админке его не было видно никогда. **Bug ≥ 5 дней** (с момента Phase 2 Auto-tags = 2026-05-07).

**Что сделано** (2 файла):

1. **`src/analysis/preset-config.js`** — `mergeOverrideBlobs(auto, manual)` теперь `export` (был internal). Это уже была готовая функция для 2-layer merge, просто не была доступна снаружи.

2. **`src/admin/server.js → _getPresetConfigs`**:
   - Импортирует `readPresetAutoOverrides` + `mergeOverrideBlobs` из preset-config.
   - Перед `getEffectivePresetConfigs` мерджит `mergedForEffective = mergeOverrideBlobs(autoOverrides, overrides)` (auto + manual).
   - Передаёт `mergedForEffective` в `getEffectivePresetConfigs` — теперь UI видит реальную 3-layer картину.
   - В response добавлено новое поле `autoOverrides` — auto layer отдельно (для будущего Debug Inspector pane «Auto · <preset>», сейчас не рендерится, но доступен через `data.autoOverrides[tab]`).

**Файлы**: `src/analysis/preset-config.js`, `src/admin/server.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax + admin SPA check прошёл (264050 chars OK).

**После деплоя поведение кнопок**:
- **🧹 Wipe manual** → manual=∅ → effective = `defaults+auto` → юзер видит свежие Grok queries (ragebait/scandal/tabloid/(tiny OR smol)…). Auto-tags работает.
- **↩ Restore hardcoded** → manual=defaults.sources → effective = `defaults+auto+defaults.sources` где manual перекрывает auto → юзер видит legacy skibidi-блок. Используется как escape hatch.

**Lesson learned**: при разделении layered config (defaults / auto / manual) UI должен **в точности** mirror'ить production merge logic. Иначе оператор делает решения на основе ложной картины. Стоит написать smoke-test «UI effective === production effective» (не сделал — поставлю в backlog).

**Что НЕ сделано (опции для будущего)**:
- Debug Inspector pane «Auto · <preset>» рядом с Defaults / Effective / Draft — `data.autoOverrides` уже передаётся, остался один React-блок добавить. Полезно для визуальной проверки что auto-tags выдал. Если юзер скажет — добавлю.

---

## 2026-05-12 · sonnet · Preset-configs: 2 кнопки вместо Clear ALL — «Wipe manual» + «Restore hardcoded»

**Цель**: операторская ловушка — старая «🗑 Clear ALL» делала **panic-clear** (wipe manual + auto + locks), что в спокойном режиме нежелательно. И не было способа one-click восстановить hardcoded legacy теги в manual layer для блокировки сошедшего с ума Auto-tags. Разделил на 2 явные операторские кнопки с разной семантикой.

**Что сделано** (1 файл):

1. **`src/admin/server.js → _setPresetConfigs`** — убрал panic-clear branch (`isPanicClear` + `setSetting('presetConfigsAuto', '')`). Manual save теперь чисто atomic: empty draft → стираем `presetConfigs`, empty locks → стираем `presetTagsLocked`, auto **никогда** не трогается. Операторские намерения через 2 явные кнопки ниже.

2. **`src/admin/server.js → _restoreHardcodedPresetSources`** — новый метод. Читает existing manual из БД, для каждого preset перезаписывает `manual[preset].sources = deep-clone(DEFAULT_PRESET_CONFIGS[preset].sources)`. Остальные manual поля (junk / alerts / cluster) сохраняются как были. Прогоняет через `validatePresetOverrides` для shape-guard. Записывает обратно.

3. **Backend endpoint** `POST /api/preset-configs/restore-hardcoded` — вызывает helper выше, возвращает обновлённый `_getPresetConfigs()` ответ.

4. **Frontend (`PresetConfigsPage`)**:
   - Удалён `clearAll()`. Заменён на **`wipeManualAll()`** — только `setDraft({})`, locks **не** трогает. Save сохранит empty manual → `setSetting('presetConfigs', '')`. Tooltip объясняет «auto+defaults станут effective».
   - Новый **`restoreHardcoded()`** — `window.confirm` (с описанием что произойдёт) → `POST /api/preset-configs/restore-hardcoded` → обновляет state. Direct backend call (не draft+save), потому что операция destructive и заслуживает explicit confirm dialog. **NB**: confirm-текст использует `String.fromCharCode(10)` для переносов строк, потому что outer dashboard/admin server.js — это template-literal-served SPA, литералы `\\n` в inner strings ломают SPA-парсер (см. CLAUDE.md «Ловушка server.js»). Сделал ошибку при первом коммите — поймал check-admin-spa.cjs.
   - В action-bar заменил одну `🗑 Clear ALL` на две: `🧹 Wipe manual` (зелёная семантика — нормальный режим) + `↩ Restore hardcoded` (красная семантика — escape hatch). Tooltips описывают use-cases.

5. **`ai-context/SESSION_CONTEXT.md`** — § *Per-preset pipeline configs / Merge order* добавлен абзац про 2 кнопки с описанием semantic.

**Use cases (для операторской документации)**:

| Кнопка | Когда нажимать | Что произойдёт |
|---|---|---|
| 🧹 Wipe manual | Старые manual queries застряли и перекрывают свежие auto-tags (типичный legacy случай) | Manual слой стирается во всех пресетах → auto+defaults становятся effective. Auto-tags работает свободно. |
| ↩ Restore hardcoded | Auto-tags производит мусор (галлюцинации Grok'а / битый curator-mode / устаревший сленг) | `DEFAULT_PRESET_CONFIGS.sources` копируется в manual слой всех пресетов. Manual перекрывает auto → legacy теги become effective. Auto refresh больше не сможет их изменить (manual wins). |

**Файлы**: `src/admin/server.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax + admin SPA check прошёл (264050 chars OK после исправления `\\n` ловушки в confirm-тексте).

**Триггер**: юзер только что обнаружил что у него в manual layer для General preset сидят давние legacy queries (`skibidi/dog OR puppy/meme OR memes/...`), поставленные ДО появления Auto-tags. Они тихо перетирали все свежие refresh'и. После обнаружения сам сказал «убери весь мусор», и попросил оформить две кнопки для будущего: одну для очистки, одну для возврата legacy.

**Что НЕ задеваем**:
- `presetConfigsAuto` — никогда не стирается ни одной из новых кнопок. Auto-tags refresh history сохраняется.
- `presetTagsLocked` — Wipe manual не трогает locks. Restore hardcoded не трогает locks. Очистка locks — через `🧹 Reset preset «<name>»` на per-preset уровне (там как раз и locks, и manual сбрасываются для одного пресета).
- Manual non-sources секции — Restore hardcoded трогает **только** `sources` sub-tree. Если у оператора есть manual junk-penalties / alert-weights / cluster — они сохраняются.

---

## 2026-05-12 · sonnet · Variant B (description synthesis) — добавлен и сразу откачен (гипотеза опровергнута)

**Что было**: гипотеза «image-only Twitter с пустым description ломает Stage 1 Gemini → 503». В `prompts.js → buildAnalysisPrompt` добавил synthesis: если description пустая, подставить `[Visual] <preStage.gemini.visualCaption>`. См. предыдущую версию этого entry в git history.

**Что показал прод (до деплоя variant B)**: юзер получил image-only Twitter алерт (kitten + tiger statue) с полностью **штатно отработавшим** Stage 1 — title «Tabby kitten mimics tiger statue expression», explanation «A humorous viral image of a kitten mirroring the open-mouthed expression of a tiger sculpture», category=animals, sentiment=positive. То есть **image-only с visualCaption Stage 1 обрабатывает нормально и без variant B**.

**Вывод**: гипотеза опровергнута. 503 в Hash Brown-инциденте — это **настоящий transient 503** от Google AI, не связанный с sparse input. Variant B не помогал, а только дублировал visualCaption в prompt'е (description + Visual:) что для LLM скорее минус (потенциальная двусмысленность «один контент в двух полях»).

**Что сделано**: revert variant B. `buildAnalysisPrompt` вернулся к простому `if (t.description) detail += '\\n   Description: ...'`. Syntax-check прошёл.

**Что остаётся в коде из этой сессии**: save_only + ai_score gate + retry-on-next-scan (см. entry ниже). Этот механизм покрывает **настоящие** transient 503 — что подтверждено как реальная причина инцидента.

**Lesson learned**: не делать фиксы под единичную гипотезу без верификации на свежих данных. **Любая** транзиентная ошибка LLM-провайдера (5xx / timeout / parse error) приведёт к точно такому же симптому «AI unavailable», независимо от того что было в input'е. Сделанный ранее save_only + retry — правильная reactive защита. Proactive фиксы под конкретный input edge-case требуют statisticals доказательств (не одного скриншота).

**Файлы**: `src/analysis/prompts.js` (revert), `ai-context/SESSION_CONTEXT.md` (убран подраздел «Description synthesis»), `ai-context/WORKLOG.md`.

**Что НЕ сделано (опции для будущего)**:
- Variant A (skip Stage 1 для no-content + no-preStage заранее) — не нужен, save_only + retry покрывает
- Variant C (retry 1-2 раза на 5xx внутри Stage 1) — может быть полезным если 503 у провайдеров станут массовыми. Currently единичные → save_only retry достаточно
- Synthesis для title — если когда-то увидим case где `title=""` ломает schema → можно сделать

---

## 2026-05-12 · sonnet · Suppress «AI unavailable» алерты + auto-retry на следующем scan'е

**Цель**: при transient 5xx / timeout от LLM провайдера Stage 1 batch падает → `scorer._fallback` ставит heuristic-скор + `aiExplanation='AI unavailable'` → alertScore проходит threshold (heuristic тоже даёт нормальные числа) → юзер получает в Telegram алерт с «🤖 AI: AI unavailable / category=other / sentiment=neutral» — бесполезный шум. Юзер: «можем ли мы не алертить такие, а отправлять заново в следующем скане?»

**Архитектурное решение**: использовать **уже существующий** `pipeline_status` механизм в `isTrendSeen` (db/database.js:1310-1331). Если status `save_only` — `isTrendSeen` пропускает через на любом scan'е (re-analyze). Сейчас всё что прошло Stage 1 сохраняется как `'scored'` → блок до cooldown. Для AI-failed трендов ставим `'save_only'` → автоматический retry через 15 мин (`SCAN_INTERVAL_MINUTES`) без отдельной retry-logic в scorer'е. `saveTrend` уже UPSERT'ит по URL/external_id — на повторной попытке тот же row обновится с реальными скорами.

**Что сделано** (3 файла):

1. **`src/analysis/scorer.js → _fallback()`** — добавил флаг `_aiUnavailable: true` в возвращаемые объекты + 7-строчный комментарий объясняющий downstream-семантику. Сам heuristic-скоринг не тронут.

2. **`src/index.js`** (save loop) — определяет pipeline_status динамически: `trend._aiUnavailable ? 'save_only' : 'scored'`. Комментарий с описанием обеих веток `isTrendSeen` behavior.

3. **`src/notifications/alert-dispatcher.js`** — новый gate `ai_score` (вставлен ПЕРЕД `threshold`, чтобы в decisions buffer firstFail был чётко «ai_score», не путать с threshold/junk):
   ```js
   const aiUnavailable = trend.aiExplanation === 'AI unavailable'
                      || trend.aiExplanation === 'Parse error';
   const aiScorePass   = !aiUnavailable;
   ```
   Decision detail: `heuristic fallback (AI unavailable) — will retry next scan`.

**Cycle behavior**:
- Scan #1: Gemini 503 → `_analyzeBatchStage1` throw → catch → `_fallback` → `_aiUnavailable=true` → save с `pipeline_status='save_only'` → alert-dispatcher `ai_score` fail → silent skip алерта (admin decisions buffer видит причину)
- Scan #2 (через 15 мин): collector снова приносит тот же URL → `isTrendSeen` находит row, status='save_only' → **pass through** → Stage 1 пробует снова → если Gemini уже жив → real verdict → save UPSERT с `pipeline_status='scored'` + реальные скоры → alert-dispatcher `ai_score` pass → алерт идёт штатно
- Worst case: provider лежит долго → тренд циклится save_only ↔ AI fail каждые 15 мин до восстановления. Это OK — данные собираются (есть в feed/dashboard), просто алертов нет.

**Файлы**: `src/analysis/scorer.js`, `src/index.js`, `src/notifications/alert-dispatcher.js`, `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`.

**Деплой**: руками юзером. Syntax-check 3 файлов прошёл (`node --check ALL OK`).

**Триггер**: на проде увидено в TG алерт `POST · 62/100 · 🤖 AI: AI unavailable · Other · Neutral · unknown · twitter`, кот в Hash Brown пакете. Stage 1 batch упал с `Gemini chat 503` в `08:26:29`. Один лог-entry за сутки, но юзер «уже 2 раз такое видел» — это observation bias из-за низкого Twitter throughput (1 алерт/сутки → 1 fallback = 100% bad rate).

**Риски / что мониторить**:
- **Тренд может потеряться** если: (a) пост получен только один раз (например X Trends daily refresh), (b) AI лежит всё время до следующего daily-refresh-окна. Маловероятно — daily refresh раз в 24h, Gemini downtime обычно минуты. Можно мониторить через SQL `SELECT COUNT(*) FROM trends WHERE pipeline_status='save_only' AND first_seen_at > -24h`.
- **save_only trends могут не получить alert вообще** если оператор отключит preset / mute source между scan'ами. Это by design — пост в БД, но не алертится. Не баг.
- **`Parse error`** (Stage 2 / Stage 1 JSON parse, line 729 в scorer.js) теперь тоже триггерит save_only + skip алерта. Раньше тоже триггерил heuristic-fallback с алертом — теперь поведение унифицировано.
- **Decision visibility**: admin DecisionsPage увидит skipped-decisions с `reason='ai_score'` — хорошая observability на случай если провайдер лёг надолго.

**Что НЕ сделано (опции для будущего)**:
- **Retry в самом `_analyzeBatchStage1`** (1-2 attempt с backoff на 5xx) — улучшит UX для микро-503'ов (секундное мерцание). Текущая реализация дожидается следующего scan'а — это 15 мин минимум. Можно добавить если 503 у провайдеров станут частыми.
- **Provider fallback на 5xx** (Gemini → OpenAI → xAI при 5xx) — есть auto-fallback в `_getRuntimeAiConfig` но только при missing API key, не при 5xx. Можно расширить когда multi-provider станет нормой.

---
