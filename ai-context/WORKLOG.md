# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 без архивации. Полная история — в git.

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

