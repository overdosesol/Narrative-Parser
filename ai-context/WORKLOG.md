# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 без архивации. Полная история — в git.

---

## 2026-05-08 (Lip-sync hard-skip через Gemini)

Проблема: TikTok-липсинги (креатор беззвучно открывает рот / танцует под чужой sound) проходили в алерты. Это «звуковой формат», а не нарратив — нет персоны для тикера, нет concrete trigger event, sound разлетается по 10K видео без явного героя. Под мемкоин не годится.

**Решение**: использовать существующий Stage 0b (Gemini captioner). Он уже смотрит видео — пусть сразу классифицирует и lip-sync.

**Архитектура**:
- Gemini добавил **+1 булево поле `isLipSync`** в JSON-ответ. Стоимость: ~10 токенов на инструкцию + 1 поле в response. Никаких новых API-вызовов.
- В `alert-dispatcher.js` добавлен **gate `lipsync`** в цепь gates. Если `trend.preStage?.gemini?.isLipSync === true` — **hard skip алерта**. Никакой score не спасает (по аналогии с `hard_junk`).
- Никакого junk-filter regex'а, никакой Stage 1 schema-правки, никакого musicMeta plumbing'а в TikTok collector — отказались от слоистого подхода в пользу одного точного сигнала.

**Файлы**:

- `src/analysis/gemini-captioner.js`:
  - `VISION_SYSTEM_PROMPT` — добавлен пункт `isLipSync` с rubric'ом: TRUE only if creators miming/dancing to audio without narrative arc; FALSE for events/news/dialogue/animals/gameplay/streamer reactions/vlogs with own audio. Tie-breaker: «if you can describe a CONCRETE thing happening, FALSE; if only thing is "person mouths along/dances to music", TRUE».
  - `GOOGLE_RESPONSE_SCHEMA` — поле `isLipSync: { type: 'boolean' }` + в required.
  - `userText` (видео и картинка) — упомянут флаг в JSON-shape, для картинки явно «must be false».
  - Google return path: `isLipSync: parsed.isLipSync === true` (strict-equal: missing/null/undefined → false, никогда случайно не тру).
  - OpenRouter fallback path: `isLipSync: false` всегда (fallback работает только на static poster image, не может быть lip-sync by definition).
  - Doc-comment output shape обновлён.

- `src/notifications/alert-dispatcher.js`:
  - `dispatchAlerts` — после `hardJunkPass` добавлен `lipsyncPass = !(trend.preStage?.gemini?.isLipSync === true)`.
  - Gate `{ name: 'lipsync', passed, detail }` встроен в цепь между `hard_junk` и `plan_source` — порядок отображения в admin DecisionsPage сохраняет семантическую группировку (threshold → quality gates → access gates → cap).
  - В firstFail-handler добавлен debug-log с тегом `[LipSync:${source}]`.

**Покрытие**:
- Только тренды с visual попадают в Gemini → Reddit/text-only тренды НЕ получают флаг (остаются `null`/`undefined`). По дизайну: lip-sync проблема исключительно TikTok'а, на reddit её нет.
- Static-image тренды forced `isLipSync: false` (картинка не может быть lip-sync). Видео-тренды получают честный classification от Gemini.
- Video с failover на poster image (truncationReason='duration_exceeded' / 'native_unavailable') — в этих кейсах OpenRouter работает с poster, форсит `false`. Это компромисс: видео >30s или Google в кулдауне → теряем lip-sync detection. Считается приемлемым, потому что failover уже редкий путь.

**Риски**:
- False positives: Gemini может пометить как lip-sync видео где креатор реально что-то делает (танцует ИЛИ говорит) под фоновую музыку. Промт прямо инструктирует «if you can describe a CONCRETE thing happening, FALSE». Если будет много false positives — смягчим до soft penalty (-30 score) или добавим admin override slider.
- False negatives: lip-sync с приклеенной overlay-надписью «I survived World War 3» может пройти как «event». Это меньшая проблема — overlay-текст обычно даёт concrete narrative и тренд может быть оправданным алертом.
- **Не тестируется юнит-тестами**. Полагаемся на Gemini. Если он начнёт галлюцинировать — увидим в DecisionsPage по причине `lipsync` (отдельный gate, легко фильтруется).

**Деплой**:
- `deploy.ps1` — катит код. Никаких миграций БД, никаких новых env-переменных. После рестарта контейнера следующий cycle Stage 0b начнёт писать `isLipSync` в `preStage.gemini`. Старые тренды без флага → `undefined` → `=== true` ложь → пропускаются нормально.

**Возможные дальнейшие шаги**:
- Если хочется visual-индикатор в дашборде/админке — добавить badge `🎤 lip-sync` на карточке (не делали по запросу пользователя).
- Если хочется admin override (slider для веса штрафа вместо hard skip) — выкатить в admin Alert weights panel рядом с `hardJunkStop` (не делали по запросу пользователя — «хардкод»).

## 2026-05-08 (Таксономия категорий — рефактор «A: minor surgery»)

Старая таксономия (10 ярлыков) была кривой: `elon` как отдельная категория (персона ≠ топик, личный bias автора), `tech_drama` vs `ai_drama` (дублёры, AI = подраздел tech), `sports_degen` / `degenerates` (degen — лишний эмоциональный коннотатор), пересечение `elon`↔`celebrity`. Большие пробелы: politics упомянут в промте как hard-rule (memePotential MUST be 0), но категории не было — модель сама решала, в `boring` или `other` положить. Music/movies/streaming/gaming — размазывались по `meme`/`celebrity`/`other`.

**Финальный список (11 категорий)**:
`meme, celebrity, animals, tech, gambling, sports, politics, entertainment, gaming, boring, other`

| Было | Стало |
|---|---|
| elon | → celebrity |
| tech_drama | → tech (drama убрал) |
| ai_drama | → tech (слил) |
| degenerates | → gambling |
| sports_degen | → sports |
| (новая) | + politics |
| (новая) | + entertainment (music/movies/tv) |
| (новая) | + gaming |

Crypto/finance отдельной категорией **не делали** (явное решение пользователя — мемкоиновые тренды раскидываются по `meme`/`gambling`/`tech`).

**Файлы**:

- `src/analysis/prompts.js` — Stage1 prompt rubric (расширена до per-category описаний на 1 строку каждое, чтобы модель не путала `gambling` с `tech` или `sports` с `entertainment`); JSON schema enum для `category`.
- `src/db/database.js` — `seedExamples` (calibration set для stage1_examples). Добавлены 2 новых примера для `gaming` (70) и `entertainment` (65), `gambling` пример (40), Politicis-пример переехал из `boring` в `politics` (но всё равно memePotential=0 по hard-rule).
- `src/dashboard/server.js` — CSS `.cat-*` (11 классов вместо 10), `CAT_ICONS`, `CAT_CLS`. Цвета новых: politics=#ff7675, entertainment=#ffa502, gaming=#00cec9.
- `src/admin/server.js` — `CATEGORY_ENUM` (валидатор для `stage1_examples` API), `CATEGORIES` array в `ExamplesPage`.
- `src/i18n/{en,ru}.js` — `topCatIcons` + `categories.{...}`. Удалён legacy `categories.news` (не использовался).

**Эмодзи**:
- `meme` 🤣 / 😂 · `celebrity` ⭐ · `animals` 🐾 · `tech` 💻 · `gambling` 🎰 · `sports` 🏆 · `politics` 🏛️ · `entertainment` 🎬 · `gaming` 🎮 · `boring` 😴 · `other` 📌

**Миграция БД**: `scripts/migrate-categories-2026-05-08.sql`. Транзакционный UPDATE на `trends` и `stage1_examples`, плюс sanity-чек (legacy left = 0). Деструктивно: `tech_drama` и `ai_drama` сливаются в `tech` без возможности обратного разделения. Перед запуском — бэкап (или полагаемся на B2 daily backup).

**Деплой план**: `deploy.ps1` → SSH на VPS → запустить `sqlite3 /app/data/trendscout.db < scripts/migrate-categories-2026-05-08.sql` (внутри контейнера или через docker exec). После — рестарт контейнера, чтобы Stage1 prompt с новой рубрикой пошёл в работу.

**Риски**:
- Если миграцию забыли запустить, а код задеплоили — модель сразу начнёт писать новые ярлыки в `category`, старые тренды останутся со старыми, фильтры в дашборде покажут «битые» категории (`elon` отфильтровано, но в БД таких уже нет — пустой результат). Сценарий ловится визуально через Top Categories блок.
- Stage1 model attention: расширили промт на ~10 строк per-category — модель теперь видит описание каждой. Это уменьшает hallucination в `other`, но добавляет ~50 токенов на запрос (×N трендов). Цена незначительная.

**Не тронуто**:
- `src/analysis/scorer.js:1199` — `highSignal = ['elon', 'musk', ...]` остался: это keyword-маркеры в title для бонуса `+10` к скору, не категория. Слово `elon` как маркер для Маска по-прежнему имеет смысл.
- `presetConfigs` / `presetConfigsAuto` в БД — категории там не упоминаются.
- Subreddits с именем `news` (preset-config) — не категория.

## 2026-05-07 (Telegram digest для admin'а после tag auto-refresh)

Юзер выбрал #5 — последний из NICE-TO-HAVE. Цель: после каждого `refreshAll()` отправлять админу в Telegram сводку с diff'ом по каждому пресету. Чтобы не лезть в admin-panel ради проверки «что Grok нагенерил на этой неделе».

**Реализация (`src/refresh/tag-refresher.js`)**:

- **Constructor** — добавлен `telegram = null` параметр (TelegramNotifier instance из `src/notifications/telegram.js`).
- **`_refreshPreset` return** — теперь включает `diff` (added/kept/removed для subs и twitter), чтобы агрегатор-нотификатор мог формировать message без повторного DB-чтения.
- **`refreshAll`** — после circuit-breaker setSettings вызывает `_notifyAdmins({results, totalCost, elapsedSec, anyFailure, isForce, newStreak})` через try-catch (best-effort, ошибка нотификации не валит run).
- **`_notifyAdmins`** — собирает HTML, шлёт каждому admin'у через `telegram.bot.sendMessage(chatId, html, {parse_mode: 'HTML'})`. Skip silently если `telegram=null` или 0 admin'ов.
- **`_getAdminChatIds`** — `db.getActiveUsers().filter(u => u.plan_name === 'admin')`. Используем существующий метод, не добавляем нового в database.js.
- **`_formatAdminDigestHtml`** — Telegram-flavoured HTML (b/i/code), trim до 3800 char (запас под 4096 лимит).

**Формат сообщения** (пример):
```
✅ Tag auto-refresh — Scheduled refresh
5 presets · 124.3s · $0.547

🔄 animals — applied · $0.121
   + subs: AnimalsBeingDerps, FunnyAnimals
   − subs: badanimalsubs2024 (404)
   + tw: furry chaos, pet fails
🔄 culture — applied · $0.108
   + subs: PeoplePerception
   + tw: gen z slang, terminally online
· celebrities — no-op · $0.097
   no changes
✗ events — rejected_validation · $0.099
   error: Empty after sanitization. Raw text head: ...
🔄 general — applied · $0.122
   + subs: BrandNewSentence, OldSchoolCool

Open admin panel → Auto-tags for full diff & history.
```

- `🔄` applied · `·` no-op · `✗` rejected_validation · `⚠️` error
- `+ subs:` — added subreddits (max 6 в строке, остальные через `(+N more)`)
- `− subs:` — removed (auto-cleanup, locked никогда не показываются здесь)
- `+ tw:` / `− tw:` — Twitter keyword groups
- Если streak ≥ 3 — отдельное сообщение `🚨 Circuit breaker tripped`.

**Wiring** — в `src/index.js`:
```js
const tagRefresher = new TagRefresher({ db, logger, config, telegram });
```
`telegram` уже инициализирован выше (line 65), к моменту создания tag-refresher (line 156) instance готов.

**Edge cases** покрыты:
- Нет telegram instance → silent skip
- Нет admin'ов в системе → debug log + skip
- Каждый sendMessage в try/catch (один сломанный chat не валит остальных)
- HTML escape через `esc(s)` для всех динамических полей (предотвращает HTML-injection через preset names или ошибочные диффы)
- Слишком длинное сообщение → trim до 3800 + `... (digest truncated)`

**Что НЕ сделано осознанно**:
- Per-preset notify (одно сообщение на пресет). Решил digest — 5 presets × 1 msg = много спама. Один summary компактнее.
- Inline-кнопки «Open admin» / «Reset breaker». Можно добавить если станет нужно — пока ссылка текстом достаточно.
- Локализация (RU/EN). Сообщение на английском, с английскими статусами — admin читает и так знает термины.

**Файлы**: `src/refresh/tag-refresher.js` (~+115 LOC: constructor + diff in result + _notifyAdmins + _getAdminChatIds + _formatAdminDigestHtml), `src/index.js` (+1 line: telegram в TagRefresher constructor).

**Проверки**: `node --check` чистый по обоим файлам.

**Testing на проде**: следующий scheduled refresh (через ≤ 7 дней) или ручной trigger через admin panel «Force refresh» сразу пришлёт digest. Если ничего не пришло — проверить что у юзера действительно `plan_name === 'admin'` в `users JOIN plans`.

---

## 2026-05-07 (Reddit subreddit reality-check для tag-refresh)

Юзер выбрал #4 из NICE-TO-HAVE. Цель: фильтровать Grok-галлюцинации в auto-tag-refresh для Reddit. Grok routinely генерит plausible-sounding subreddit'ы которые не существуют (r/cuteanimalvideos, r/memesofthe2020s и т.п.). До этой правки они улетали прямо в `presetConfigsAuto` и потом коллектор Reddit'а получал 404 на каждом обращении.

**Реализация (`src/refresh/tag-refresher.js`)**:

- **Constants**:
  - `REDDIT_USER_AGENT` (env-tunable, default `Catalyst:tag-refresher:v1.0`) — Reddit требует осмысленный UA для unauthenticated, иначе rate-limit жёстче.
  - `REDDIT_PROBE_DELAY_MS = 6500` — 6.5 сек между probe'ами (10/min лимит unauthenticated с safe margin).
  - `REDDIT_PROBE_TIMEOUT_MS = 8000` — per-request timeout.
  - `REDDIT_PROBE_NETWORK_ERROR_BAILOUT = 3` — после 3 подряд network error'ов bail out, остальные subs идут pass-through (не дропаем когда Reddit лежит).
  - `sleep(ms)` helper.

- **`_realityCheckSubreddits(proposedSubs, preset)`**:
  - Скипает subs которые уже в effective sources (известно работают, не тратим rate-limit).
  - Для остальных — вызов `_probeSubreddit(name)` через `fetch('https://www.reddit.com/r/<name>/about.json')` с UA + Accept headers.
  - На сетевые ошибки **conservative**: keeps the sub (флак реддита не должен валить весь refresh).
  - На 404/403/451 — drops с логированием reason'а.
  - На 429 (rate-limited) — keeps as fallback (предполагаем существующий, не дропаем).
  - Bailout-логика: 3 consecutive network errors → пропускаем remaining через verified без проверки.

- **`_probeSubreddit(name)`** — отдельная функция:
  - AbortController с 8s timeout.
  - Парсит `{kind: 't5', data: {display_name, subreddit_type, subscribers}}` shape.
  - Возвращает `{exists, reason, subreddit_type?, subscribers?, networkError?}`.

- **`_getCurrentSubreddits(preset)`** helper — manual override > auto > defaults (mirrors merge order).

- **Вписано в pipeline**: между `_sanitizeResponse` (step 3) и `_computeDiff` (step 5). Step 4a — reddit, step 4b — twitter.

**ENV**: добавлен `REDDIT_USER_AGENT=Catalyst:tag-refresher:v1.0` в `.env.example`.

**Стоимость**:
- 5 пресетов × ~5-10 proposed subs / week = ~30-50 probe'ов в неделю.
- 6.5s паузы → max 5 минут на пресет (только если Grok нагенерит 50 новых subs, реально 5-15).
- Бесплатно. Reddit free public API.

**Что НЕ делаем**:
- OAuth — лишний setup, 60/min vs 10/min не нужно для нашего объёма.
- Batch endpoint `api/info?sr_name=...` — требует OAuth.
- Кэш проверенных subs — TTL Reddit's banned list нестабилен, лучше каждый refresh проверять заново.

**Файлы**: `src/refresh/tag-refresher.js` (~+115 LOC), `.env.example` (+3 lines).

**Проверка**: `node --check` чистый.

---

## 2026-05-07 (Copy-math button — экспорт математики из admin Decisions)

Юзер выбрал #3 из NICE-TO-HAVE: кнопка «копировать математику в буфер» в admin DecisionsPage. Скопированный текст можно вставить в Slack/Telegram/issue без скриншотов. DecisionsPage сама по себе админская, дополнительный gate не нужен.

**Что сделано (`src/admin/server.js`)**:

- **Helper `formatMathPanelAsText(d)`** — собирает plain-text вид всей математики:
  - Header: title, verdict, source, type, preset, url
  - Positive section с табличным выравниванием через `pad(s, n)`: `meme       70 x 0.45     = +31.5`
  - Penalty section: junk + stale, `junk triggers: ...` если есть
  - Equation `+54 − 10 = 44 < 60 (✗ fail)`
  - Floor decomposition `Floor 60 = max(user 50, admin 60)`
  - Feedback details если есть `feedbackStats`
  - Newlines через `String.fromCharCode(10)` (SPA trap — literal `\` + `n` в строках ломает outer template literal).

- **Component `CopyMathButton({getText})`**:
  - Local useState `copied` / `error`, lifecycle 2-2.5 сек
  - Primary path: `navigator.clipboard.writeText()`
  - Fallback path для non-secure contexts: `<textarea>` + `document.execCommand('copy')`
  - Кнопка показывает `📋 copy math` / `✓ скопировано` / `⚠ ошибка`

- **Встройка в MathPanel** — первый child в `dec-math` контейнере, абсолютно позиционирован top-right. `getText: () => formatMathPanelAsText(d)` — closure over decision, всегда свежие данные.

- **CSS**: `.dec-math` теперь `position:relative`. `.dec-math-copy-btn` (top:10px, right:10px, z-index:1) + `.copied` (зелёный) и `.error` (красный) состояния.

**SPA-traps по дороге** (third и fourth раз за день):
1. Backtick `\`d\`` в комментарии «closure over `d`» → `Unexpected identifier 'd'`. Заменил на «closure over the decision».
2. `\n` в комментарии «literal `\n` in inline-template strings» — outer template literal съел `\n`, сделал реальный newline, комментарий оборвался, дальнейший текст стал кодом → `Unexpected token 'in'`. Переписал без escape-sequence.

Validator после фикса ✅ OK (227836 chars).

**Пример вывода** (plain-text, монospace-friendly):
```
Trend: "Costco guys fell off..."
Verdict: score=44 / 60 · FAIL · SKIPPED (threshold)
Source: reddit
Type: trend
Preset: general

─ POSITIVE (Σ +54)
   meme       70 x 0.45     = +31.5
   viral      85 x 0.15     = +12.8
   emerge     28 x 0.2      = +5.6
   twitter    0 x 0.05      = +0
   feedback   50 x 0.15     = +7.5

─ PENALTY (Σ −10)
   junk       20 x 0.5      = −10
   stale      0h, grace 24h = −0
   junk triggers: no-meme-shape, text-only

+54 − 10 = 44 < 60 (✗ fail)
Floor 60 = max(user 50, admin 60)
```

**Файлы**: `src/admin/server.js` (~+150 LOC: helper + CopyMathButton + кнопка в MathPanel + 5 строк CSS).

**Проверки**: SPA validator ✅ OK, `node --check` чистый.

---

## 2026-05-07 (Term-help tooltips — admin-only "?" подсказки в дашборде)

Юзер выбрал #2 из NICE-TO-HAVE. Цель: добавить подсказки рядом с терминами в trend-modal — особенно «Emergence» (юзер сам сказал что это слово сбивает). Admin-only сначала, потом откроем всем.

**Что сделано (все правки в `src/dashboard/server.js`)**:

- **CSS-only tooltip** — маленький круглый `?` бэдж рядом с term label'ом. На hover вылезает styled tooltip (240px wide, темный фон, стрелка-уголок снизу). Использует `data-tooltip` + `::before`/`::after` псевдоэлементы — никакого JS, никаких state'ов. `.term-help.right` — модификатор для тултипа в правой части модалки (anchor flip, не клипается).
- **Helper в TrendModal**: `const isAdmin = me?.plan === 'admin' || me?.plan_name === 'admin'` + `termHelp(text, right=false)` который возвращает `<span class="term-help" data-tooltip="...">?</span>` или null если не админ.
- **i18n**: 9 ключей EN+RU в блоках `term.*`:
  - `meme_score`, `virality`, `velocity`, `alert_score`, `lifespan` — top stats
  - `emergence`, `feedback`, `junk`, `stale` — alert breakdown rows

**Где встроены `?`-бэджи**:
- Modal stats grid: рядом с лейблами **Meme Score**, **Virality**, **Velocity**, **Alert** (последний с `right=true` — он у правого края).
- Alert math panel rows: **meme**, **viral**, **emerge**, **feedback** (positive); **junk**, **stale** (penalty). `posRows` теперь содержит поле `tooltip`, мап рендерит `termHelp(r.tooltip)` после label'а.

**Что НЕ затронуто**:
- Twitter `X` row в breakdown — нет tooltip'а, потому что метрика самоочевидна и редко не-нулевая.
- Lifespan tile ушёл из модалки давно (заменён на Alert), но i18n строка `term.lifespan` осталась на будущее.

**Когда откроем всем — одна строчка**:
```js
// строка 8704 в src/dashboard/server.js — заменить:
const isAdmin = me?.plan === 'admin' || me?.plan_name === 'admin';
// на:
const isAdmin = true;
```
Все `?`-бэджи сразу появятся у free/test/pro юзеров. Никакого других правок не нужно.

**SPA-trap, попался дважды**:
1. CSS comment `via the \`isAdmin\` flag` — backticks → SPA сломан, ошибка `Unexpected identifier 'isAdmin'`.
2. JS comment `Pass \`right=true\`` — то же самое, ошибка `Unexpected identifier 'right'`.
Заменил на голый текст без backticks. Validator после фикса ✅ OK (279361 chars).

**Файлы**: `src/dashboard/server.js` (~+190 LOC: CSS + i18n EN/RU + helper + 9 встраиваний).

**Проверки**: SPA validator ✅ OK, `node --check` чистый.

**Дополнение (fix позиционирования tooltip'ов, тот же день)**:
- Юзер прислал скриншоты — tooltip'ы клипались: верхние (Meme Score) уезжали выше viewport'а, левые (Virality) обрезались по левому краю модалки.
- Причина: original CSS позиционировал tooltip **сверху** иконки + **по центру** (`bottom: 100% + 8px; left: 50%; transform: translateX(-50%)`). Иконки-то у верхней/левой границ контейнера → клип.
- Fix: tooltip теперь **ПОД** иконкой (`top: calc(100% + 8px)`) + якорится **по левому краю** (`left: 0`). Стрелка тоже flipped (`border-bottom-color`, `top: calc(100% + 2px)`). Width 240→220 + `max-width: calc(100vw - 40px)` защита на узких экранах.
- `.right` модификатор остался — теперь «anchor right» для Alert tile (была `transform: none` лишняя — убрал).
- Result: для всех 9 встраиваний tooltip уходит вниз-вправо (вниз-влево для Alert с `right=true`). Не клипается по верху; левого клипа нет.

---

## 2026-05-07 (Mini-chart эволюции alertScore — sparkline в дашборде)

Юзер выбрал первый из NICE-TO-HAVE. Цель: показать как `alertScore` меняется со временем (recompute cycles) — sparkline под equation в Alert verdict. Тестируем только на admin'е, потом откроем всем.

**Backend**:
- `src/db/database.js`:
  - Новая таблица `alert_score_history` (trend_id FK, ts DEFAULT CURRENT_TIMESTAMP, score, positive, penalty, floor_at_ts, source) + index `(trend_id, ts)`. ON DELETE CASCADE — если тренд удалён, история чистится автоматом.
  - Методы: `recordAlertScoreHistory({trendId, breakdown, floorAtTs, source})`, `getAlertScoreHistory(trendId, limit=100)`, `pruneAlertScoreHistory(retentionDays=30)`.
- `src/notifications/alert-dispatcher.js — recomputeAlertScores`:
  - Сигнатура расширена: `(trends, alertWeights, db, opts={})` где `opts = {source, floor}`.
  - После каждого `computeAlertScore` пишем точку в `alert_score_history` (если `t._dbId` есть).
  - Try/catch обёрнуто — история «декоративная», падать на write не должна.
- Call sites:
  - `src/index.js:511` (scan cycle) → `source: 'scan', floor: globalAlertThreshold`.
  - `src/refresh/hot-metrics.js:293` (hot refresh) → `source: 'refresh-hot', floor: globalAlertThreshold`.
- Maintenance loop в `src/index.js`: startup prune + daily setInterval, retention 30 дней. Тот же паттерн что у `cleanupExpiredHiddenTrends`.

**API endpoint**:
- `GET /api/trends/:id/alert-history` → `{points: [{ts, score, positive, penalty, floorAtTs, source}], floor}`.
- **Admin-only гейт**: `if (planName !== 'admin') return 403 Forbidden`. Когда откроем — одна строчка.
- Floor подтягивается из `getActivePresetConfig(db).alerts.thresholds.alertThreshold` (как в /api/me).

**Frontend (`src/dashboard/server.js`)**:
- Новый useState в TrendModal: `alertHistory`, `alertHistoryLoading`. Lazy-fetch при открытии math panel (alertDetailsOpen=true) — не дёргаем API на каждое открытие модалки, только когда юзер реально хочет видеть детали.
- Функция `renderAlertSparkline(points, floor, t)` — inline SVG (240×56), без chart-библиотек:
  - Filled area под линией score (зелёный/красный зависит от passed состояния на последней точке).
  - Score line + dot на последней точке.
  - Floor reference line (dashed).
  - X-axis time-scaled (gaps = реальное время, не равномерные шаги).
  - Header: `score evolution · 47 pts · 2.3h · +12` (зелёный delta).
  - Mini-legend под графиком: `MM-DD HH:MM · 65 → MM-DD HH:MM · 78`.
- `fmtSparkTs()` helper для форматирования SQLite TEXT timestamp'ов.
- Render в alert math panel **между equation и floor decomposition**. Только если `points.length >= 2` (одна точка = просто dot, бесполезен).

**Стили**: `.alert-spark` / `.alert-spark-header` / `.alert-spark-svg` / `.alert-spark-floor` (dashed) / `.alert-spark-legend`. Token-aware (`--green`, `--red`, `--text2`, `--muted`).

**i18n**: 4 строки EN+RU — `alert_spark_label` («score evolution» / «эволюция score»), `alert_spark_points` («pts» / «точек»).

**Admin-only сейчас, потому что**:
1. Весь Alert verdict block уже gate'нут к `me.plan === 'admin'` в TrendModal — sparkline просто наследует.
2. API эндпоинт второй уровень защиты.

Когда откроем для всех — убираем `if (planName !== 'admin')` в `_handleAlertHistory` и `me.plan === 'admin'` гейт в TrendModal на блоке Alert verdict.

**Стоимость в продакшене**:
- Scan каждые 15 мин = 96 recompute/день/trend. Hot-refresh раз в 12h. ~100 rows/день/trend.
- При 200 активных трендах в среднем = 20K rows/день, 600K/месяц. SQLite справится без вопросов.
- Если станет шумно — добавим throttle «skip write if score unchanged within 1h».

**Файлы**: `src/db/database.js`, `src/notifications/alert-dispatcher.js`, `src/index.js`, `src/refresh/hot-metrics.js`, `src/dashboard/server.js`.

**Проверки**: SPA validator ✅ OK (275054 chars), `node --check` чистый по всем 5 файлам.

---

## 2026-05-07 (Dashboard Alert verdict — collapsible math panel)

Юзер пожаловался, что блок Alert verdict в trend-modal грузит интерфейс — чипы с **сырыми** значениями `meme 98 · viral 95 · emerge 90 · feedback 50 · junk -15` без weights и без понимания, какой компонент на сколько очков подвинул. И что блок развёрнут по умолчанию, занимает место. Сделал такой же подход, как в admin Decisions — компактный header + collapsible math panel.

**Что сделано (`src/dashboard/server.js`)**:
- `TrendModal` — новый useState `alertDetailsOpen` (default false).
- **Compact header** (всегда виден): pass/fail пилюля (`✓ 73 / 60 · would alert`) + alertType chip (`trend · ✓ in your filter` или muted) + кнопка `▾ show math` справа.
- **Math panel** (раскрывается по клику):
  - 2-колоночный grid: **+ positive signals** (meme/viral/emerge/twitter/feedback) и **− penalties** (junk, stale).
  - Каждая строка: `label · raw × weight · contribution` (color-coded). Когда weights snapshot отсутствует (старые decisions) — calc-колонка падает на голый raw.
  - `junk триггеры:` теги под penalty-таблицей (politics, kpop/fandom, celeb-noise, no-meme-shape, text-only, safe-override). Те же визуально, что в admin'е: красный border, голубой для safe-override.
  - **Equation**: `+positive − penalty = score ≥/< floor (✓ pass / ✗ fail)`.
  - **Floor decomposition**: `Floor 60 = max(your 50, admin 60)`.
- **Empty state**: если breakdown null (старые save-only rows), при клике на details показывается вежливое `No detailed breakdown saved for this trend`.

**Стили** — добавлен self-contained блок `.alert-verdict-header` / `.alert-verdict-pill` / `.alert-type-chip` / `.alert-details-btn` / `.alert-math-panel` / `.alert-math-grid` / `.alert-math-section` / `.alert-math-table` / `.alert-math-reasons` / `.alert-math-eq` / `.alert-math-floor`. Использует существующие токены (`--green-rgb`, `--red-rgb`, `--accent-rgb`, `--text2`, `--dim`). Mobile-friendly: при ≤720px grid становится одноколоночным.

**i18n** — добавлено по 7 строк в EN и RU блоки: `alert_details_show/hide`, `alert_section_positive/penalty`, `alert_floor_explain` (template `{floor}/{user}/{admin}`), `alert_junk_triggers`, `alert_no_breakdown`.

**Файлы**: `src/dashboard/server.js` (~+200 LOC: useState + render + CSS + i18n).

**Проверка**: `check-dashboard-spa.cjs` ✅ OK (268237 chars). `node --check` чистый.

**Не сделано (nice-to-have)**:
- Mobile-tap delight: можно добавить лёгкий expand-анимацию (height transition) для math panel. Сейчас просто скачкообразно появляется.
- Tooltip с пояснением каждого junk-триггера (как в admin'е через `junkReasonHint`). Дашбордный юзер не разработчик, для него «no-meme-shape» — кракозябра. TODO: добавить понятный i18n-словарь.

**Дополнение (admin-only gate)**:
- Юзер уточнил: блок Alert verdict нужен только админам. Free/test/pro и так не разбираются в внутренней механике scoring'а; видеть «-10 stale penalty» это им ничего не даст и только добавит вопросов.
- В условии рендера блока добавлена проверка `me?.plan === 'admin' || me?.plan_name === 'admin'` (паттерн как в существующем коде line 8396, 9436). Other plans теперь не видят ни верхнюю пилюлю, ни кнопку «show math».
- **SPA trap**: первая попытка содержала backticks в комментарии (`` `me.plan === 'admin'` ``) → SPA сразу слетел на «Unexpected identifier». Заменил на `me.plan==="admin"` без backticks. Validator после фикса ✅ OK (268682 chars).

**Дополнение (зачистка упоминаний admin плана из UX)**:

Юзер увидел `🔒 Manual analysis is available on Test/Pro` и вспомнил, что в других местах ещё могут проскакивать `Pro/Admin`, `Pro / Admin`. Попросил пройтись по всему проекту и убрать упоминания admin плана отовсюду, кроме самого админ-интерфейса.

**Стратегия**: трогаем только user-facing строки (i18n, error responses, bot command descriptions, tooltips). НЕ трогаем: серверный guard'ы (`if (plan === 'admin')`), комментарии в коде, SQL-схему, таблицу plans, admin/server.js, ai-context.

**Заменено (10 user-facing строк)**:
- `src/dashboard/server.js`:
  - `1668` API 403 error — `'Favorites is a Pro/Admin feature'` → `'Favorites is a Pro feature'`
  - `1406` API 403 error — `'Admin only'` → `'Forbidden'`
  - `6203` (EN) `analyze.intro` — `'Pro / Admin only.'` → `'Pro only.'`
  - `6214/6215` (EN) `fav.locked_tooltip/toast` — `'Pro/Admin'` → `'Pro'`
  - `6269` (EN) `feed.manual_tip` — `'Manually submitted via admin panel'` → `'Manually submitted'`
  - `6534` (EN) `account.threshold_desc` — `'admin floor'` → `'platform floor'`
  - `6601` (RU) `analyze.intro` — `'Pro/Admin'` → `'Pro'`
  - `6612/6613` (RU) `fav.locked_*` — `'Pro/Admin'` → `'только на Pro'`
  - `6667` (RU) `feed.manual_tip` — `'Ручная отправка через админку'` → `'Добавлено вручную'`
  - `6929` (RU) `account.threshold_desc` — `'floor админа'` → `'floor платформы'`
- `src/notifications/telegram.js:101` — bot command description `'Analyze a URL (Pro / Admin)'` → `'Analyze a URL (Pro)'`
- `src/i18n/en.js:36` + `ru.js:37` — `dashboardPrompt`: `(Pro / Admin)` → `(Pro)`

**Сознательно НЕ удалили**:
- `'plan.admin': 'Admin'` строки в i18n (line 6545/6940) — нужны самому admin-юзеру в его AccountPanel; рендерятся только при `user.plan === 'admin'`, для free/test/pro не fire.
- `'modal.alert_floor_explain'` (line 6435/6831) — содержит слово `admin` в шаблоне, но весь блок Alert verdict уже gate'нут к admin-only viewing (предыдущий step). Не-админу строка в bundle есть, но никогда не рендерится.
- Комментарии `// pro/admin` по всему коду — внутренние доки, в UI не выходят.
- `src/admin/server.js` — там «Test, Pro и Admin» в card-sub label, видит только админ, и так в админке.

**Проверки**: `check-dashboard-spa.cjs` ✅ OK (268639 chars), `node --check` чистый по всем 4 затронутым файлам.

**Файлы**: `src/dashboard/server.js`, `src/notifications/telegram.js`, `src/i18n/en.js`, `src/i18n/ru.js`.

---

## 2026-05-07 (Admin DecisionsPage — расширенная панель математики scoring)

Пользователь заметил, что на дашборде trend с `meme=92 viral=92 emerg=93 junk=20` получил score 55 при пороге 60 — и по умолчанию непонятно, откуда такой штраф. junk×0.50 = -10, не объясняет 16 недостающих очков. Чтобы такие вопросы больше не возникали — добавил подробную панель в admin Decisions.

**Backend snapshot weights в breakdown**:
- `src/analysis/scorer.js` — `computeAlertScore.breakdown` теперь включает `weights: {...}` snapshot (10 полей: weightMemePotential/Virality/Emergence/Twitter/Feedback/Junk + staleDecay knobs + hardJunkStop) и `feedbackStats: {likes, dislikes}`. Снимок гарантирует, что отображаемая математика соответствует МОМЕНТУ принятия решения, даже если активный preset потом отредактировали.
- `src/notifications/alert-dispatcher.js — recomputeAlertScores` — подцепляет `t._feedbackStats` (raw vote counts из getFeedbackStats), чтобы scorer мог их положить в breakdown.
- `dispatchAlerts.decisionBase` — добавлены `userFloor`, `globalFloor`, `preset` (имя активного preset'а в момент решения).

**Frontend — `DecisionsPage` (`src/admin/server.js`)**:
- Добавлено состояние `expanded` (Set keyed by `ts:trendId`) + кнопка `▾ детали` справа от breakdown one-liner.
- Новая функция `MathPanel(d)` рендерит:
  - 2-колоночный grid: **+ Положительные сигналы** (meme/viral/emerg/twitter/feedback) и **− Штрафы** (junk, stale).
  - Каждая строка: `label · raw × weight · contribution` (color-coded: pos зелёный, neg красный, zero мутный).
  - Σ итог в каждой колонке.
  - Equation: `+81.3 − 26 = 55  ≥/< 60 (✓/✗)` с большим color-coded финальным числом.
  - Threshold breakdown: `max(user X, admin Y)`.
  - Meta-pills: feedback votes (👍 N / 👎 M → boost X), hard-junk reference (`junk N / 70 ✓/⚠`), stale cap, trigger source (scan/refresh/manual).
- В meta-row карточки добавлен `🎯 <preset>` chip (понимать какой preset был активен).
- Backward compat: старые decisions без `weights` snapshot получают warning-pill «старая запись — calc неполный» и calc-колонка показывает только raw value.

**Стили** (~50 строк CSS, секция `.dec-math*`): grid 2-col → 1-col на ≤900px, цветные contributions, badge'и в заголовках секций, equation block с большим финальным числом.

**Файлы**: 
- `src/analysis/scorer.js` (+30 LOC, breakdown extras)
- `src/notifications/alert-dispatcher.js` (+5 LOC, feedbackStats hook + decisionBase fields)
- `src/admin/server.js` (+~180 LOC: MathPanel + CSS + state)

**Деплой**: не требует миграций. Старые decisions в ring-buffer покажут warning-pill, новые — полную математику. После рестарта buffer очищается, всё отображается ок.

**Риски**: ring-buffer ~500 решений × ~80 байт extra на decision (weights snapshot) = +40KB heap. Принципиально не страшно. Если станет больно — можно хранить только weights diff от DEFAULT_ALERT_WEIGHTS, но пока преждевременная оптимизация.

**Не сделано (nice-to-have)**:
- Кнопка «копировать математику в буфер» как text — для шаринга в slack/issue.
- Линк на trend page в дашборде (сейчас только URL первоисточника, можно добавить deep-link `/dashboard/trend/<id>`).
- Mini-chart how alertScore evolved across recompute cycles (нужен timeseries, нет в текущем буфере).

**Дополнение того же дня (junk-reasons в panel)**:
- Юзер увидел trend с junk=20 → -10 штрафом и спросил «за что junk?». Math panel показывал результат, но не сами триггеры junk-filter'а.
- `scorer.js` — `breakdown.junkReasons` (array) теперь снимок triggers'ов из `trend.junkReasons` / `trend.clusterMetrics.junkReasons` (politics, kpop/fandom, celeb-noise, no-meme-shape, text-only, safe-override(÷N)).
- `admin/server.js — MathPanel` — под penalty-таблицей появился ряд `junk триггеры: <tag1> <tag2> ...` с tooltip-подсказкой через `junkReasonHint(r)`. safe-override tag'и подсвечены голубым (rescue path), остальные — красным.
- Стили: `.dec-math-reasons` + `.tag` (красный border) + `.tag.safe` (голубой).
- Файлы: `src/analysis/scorer.js` (+8 LOC), `src/admin/server.js` (+~30 LOC: hint helper + render + CSS).

---

## 2026-05-07 (Tag auto-refresh — Phase 3: per-tag pin lock UI в PresetConfigsPage)

Финальная фаза tag-refresh — UI для per-element lock-mask. Юзер может закрепить (🔒) конкретный subreddit или Twitter keyword group, и auto-refresh не сможет его удалить даже если Grok не предложит. Pin-флаг — основа «копилки хороших тегов» (как юзер сказал в Phase 2 обсуждении).

**Архитектурные решения**:
- **Lock-mask shape**: `{<preset>: {reddit: ['aww', 'capybara'], twitter: ['(zoomies)', '(blep OR mlem)']}}`. Per-source-type, не per-tag global. Сравнение case-sensitive для Reddit, case-insensitive для Twitter (toLowerCase в `_computeDiff`).
- **Twitter lock-key — это keyword-PART** запроса (без `min_faves:N` и `-is:retweet`). Это согласуется с tag-refresher.js diff logic — он сравнивает proposed groups (без чисел) с current groups (нормализованные). Если бы хранили full string — match не сработал бы. UI извлекает keyword-part при toggle через regex strip.
- **Save flow**: оба draft'а (overrides + locks) сохраняются одним `POST /api/preset-configs`. Locks-only save (overrides empty, locks non-empty) — нормальный flow, NOT триггерит Clear-ALL panic. Только когда оба пустые — wipes auto-blob тоже.
- **Reset preset «X» button** теперь чистит и manual draft, и lock-mask для этого preset'а.
- **Clear ALL** чистит всё: manual + locks frontend-state, после Save backend wipes manual + auto + locks blobs.
- **Chip removal** автоматически unlock'ает удалённый item — иначе остался бы dangling lock-key несуществующего тега.

**Что в Phase 3 (этот коммит)**:

1. **Validator** (`src/analysis/preset-config.js`):
   - `validatePresetTagsLocked(input)` — sanity-check: преsetы из PRESET_KEYS, sourceType ∈ {'reddit', 'twitter'}, tags coerced to deduplicated string array. Drop unknown silently.

2. **Backend integration** (`src/admin/server.js`):
   - `_getPresetConfigs` теперь возвращает `tagsLocked: readPresetTagsLocked(db)` — frontend читает оттуда.
   - `_setPresetConfigs(body)` принимает `body.tagsLocked` (опц), валидирует через `validatePresetTagsLocked`, persist'ит в `settings.presetTagsLocked`.
   - Clear-ALL panic logic: только если **оба** (manual + locks) пустые → wipe auto-blob тоже. Иначе locks-only save проходит нормально без затирания auto.

3. **Frontend** (`src/admin/server.js — PresetConfigsPage`):
   - State `locked` (отдельно от `draft`) — sparse blob lock-mask.
   - Mutators: `toggleLock(preset, sourceType, lockKey)` — toggle individual entry, GC empty arrays/objects.
   - `clearAll` теперь чистит и draft и locked. `resetPreset(preset)` чистит для конкретного preset'а.
   - `save` отправляет `{overrides: draft, tagsLocked: locked}`.
   - `PChips` компонент: для путей `sources.reddit.subreddits` и `sources.twitter.queries` передаёт `lockSourceType`, `isLocked`, `onToggleLock` callbacks в `ChipInputBox`. Twitter путь использует strip regex для извлечения keyword-part в качестве lock-key.
   - Auto-unlock при удалении chip'а (через onRemove): если удаляемый item был locked — снимаем lock одновременно с удалением.

4. **`ChipInputBox`** (presentation):
   - Принимает 3 новых prop'а: `lockSourceType`, `isLocked`, `onToggleLock`. Если все три — chip получает 🔒/🔓 toggle button слева от текста.
   - Locked chip: дополнительный CSS класс `pcfg-chip-locked` — зелёный border + glow. Visual signal что элемент защищён.
   - `pcfg-chip-lock` button: opacity .7 → 1 + scale на hover, transition .15s.

5. **CSS** (`src/admin/server.js inline styles`):
   - `.pcfg-chip-lock` — стиль toggle-кнопки.
   - `.pcfg-chip-locked` — extra border/bg/glow для locked chip'ов.

**Поведение auto-refresh с Phase 3**:
Когда tag-refresher запускается (force или scheduled):
1. Grok возвращает proposed list.
2. `_computeDiff` читает `presetTagsLocked` через `readPresetTagsLocked(db)`.
3. Locked items добавляются в `kept` set ВСЕГДА — даже если их нет в proposed.
4. `_applyAutoOverride` пишет в auto-blob финальный список = locked + (proposed ∩ current).
5. Юзер видит в админке: locked chips остались (зелёные с 🔒), не-locked могли быть удалены/добавлены.

**Файлы**: `src/analysis/preset-config.js` (+30 строк validator), `src/admin/server.js` (~80 строк frontend + endpoints + CSS).

**Деплой**: TBD юзером. После деплоя — UI готов, юзер может lock'ать в админке. Auto-refresh уже respect'ит locks с Phase 1 (был reader без UI).

**Sanity checks**: `node --check` для preset-config.js + admin/server.js ✓. SPA-template ✓ (211636 chars, +4K с Phase 2).

**Риски**:
- Если юзер lock'ает Twitter keyword group через UI, и потом меняет min_faves в полной строке (например через manual edit), lock-key (keyword-part) останется match'иться правильно — потому что мы lock'аем part, не full string. Но если юзер изменит сам keyword-part (`(zoomies)` → `(zoomies OR sploots)`), старый lock останется на неактуальном ключе. Это acceptable edge case — юзер delete'нет старый item и lock'нет новый.
- Frontend stores lock-key in client state до save. Если юзер lock'нул и закрыл вкладку без Save — lock не persist. Это standard для всего PresetConfigsPage flow (manual overrides тоже теряются без Save).
- Размер lock-mask blob небольшой (~ десятки строк), settings table выдержит.

---

## 2026-05-07 (Tag auto-refresh — Phase 2 sanity-tests + production fixes)

После Phase 2 запустили 2 теста через temp script (потом удалён):

**Тест #1** (промпт без MANDATORY TOOL USAGE, без tool_choice):
- ✅ 200 OK, 69 sec, $0.0312
- ✅ JSON парсится, 8 subs + 5 twitter groups
- ❌ **0 x_search calls** — Grok ответил из training data без real-time проверки

**Тест #2** (после усиления промпта + добавления tool_choice='required'):
- Сначала падал с UND_ERR_HEADERS_TIMEOUT — undici default 5 min недостаточно для Grok+x_search reasoning
- Установил undici@6 (8.x не совместима с Node-bundled fetch — `invalid onRequestStart method`)
- Затем падал с UND_ERR_SOCKET / "other side closed" — **xAI Responses API НЕ поддерживает `tool_choice: 'required'`**, обрывает соединение rude вместо 400
- После удаления tool_choice + custom dispatcher (15-min timeout): ✅ 200 OK, 117 sec, $0.0448, **9 x_search calls**, citations с реальными @usernames + датами May 6 2026

**Найденные проблемы и применённые фиксы в production**:

1. **Удалил `tool_choice: 'required'`** из `_callXaiResponses`. Comment: «xAI Responses API drops the connection (UND_ERR_SOCKET) instead of returning 400». Prompt-mandate отрабатывает (9 calls в тесте), tool_choice не нужен.

2. **Добавил undici long-timeout dispatcher** — `XAI_LONG_AGENT` с 15-min headers/body timeout. Передаётся в fetch как `dispatcher` опция (per-request, не глобально — другие fetch'и в process сохраняют свои дефолтные timeout'ы). Без этого первый production refresh с x_search'ами на 100-300s валился бы по UND_ERR_HEADERS_TIMEOUT.

3. **Установил `undici@6`** в dependencies (1 пакет). Версия 6.x совместима с Node 22.22.2 bundled fetch; v8.x несовместима — выдаёт `invalid onRequestStart method`. Использует только tag-refresher для своего dispatcher; остальной проект на native fetch без изменений.

**Итоговая стоимость и время с production-конфигом**:
- $0.045 / preset × 5 = $0.22/refresh × 4/мес ≈ **~$0.88/мес** (vs прогноз $0.54 без mandate)
- 117s / preset × 5 = ~10 мин на полный refresh. Force-button показывает «5 пресетов обработано за Xс» в success-toast.

**Качество предложений Grok'a с x_search**:
- Subs: `Zoomies` (450K), `blep` (461K), `Chonkers`, `sploots` — реальные mid-size сабы (size verified в его citations)
- Twitter groups: `(zoomies)`, `(chonker OR chonky)`, `(mlem OR blep)`, `(sploots)`, `(loaf OR catloaf)`, `(boop OR snoot)` — все behavior-pattern, без named memes
- Каждое предложение grounded на real @username + date (e.g. `@remalchacha post May 6 2026`)

**Файлы**: `src/refresh/tag-refresher.js` (обновлён: undici dispatcher + удалён tool_choice + усилен SYSTEM_PROMPT), `package.json` (added undici@6 dep), `package-lock.json`.

**Деплой**: TBD юзером. Перед деплоем — `npm install` обязателен, чтобы undici@6 попал в node_modules контейнера.

**Риски**:
- Reddit subs предлагаемые Grok'ом могут не существовать (например `BoopTheSnoot` — может быть hallucination даже с x_search). Phase 3+ может добавить Reddit existence check через `https://www.reddit.com/r/<name>/about.json` (free Reddit API).
- 10-мин refresh time не блочит scan-cycle (фоновый), но force-button в админке должен показывать spinner + не давать spam-clicks (rate-limit 24h на это и рассчитан).
- undici@6 транзитивно зависит от `tr46` который имеет известные мелкие vulnerabilities (`npm audit` может ругаться). Не блокер для server-side use.

---

## 2026-05-07 (Tag auto-refresh — Phase 2: реальный xAI Grok call + Live Search + reality-check)

Phase 1 был infra-skeleton. Phase 2 — настоящая логика. После Phase 2 force-кнопка в админке физически зовёт Grok, парсит JSON, валидирует, проверяет каждый новый Twitter keyword через Apify probe, считает diff vs defaults, пишет в `presetConfigsAuto`.

**Архитектурные решения**:
- **Live Search**: через `tools: [{type: 'x_search', max_search_results: 20, return_citations: false}]` — этот же pattern Stage 2 в scorer.js использует. xAI x_search **physically** ходит в X (Twitter) и возвращает свежие посты, прямо в reasoning context Grok'a. Решает hallucination проблему slang anchor.
- **Не используем `text.format = json_schema`**: scorer.js comment line 933-934 явно говорит «xAI Grok does not currently honour text.format=json_schema reliably». Парсим JSON свободно из text response с поддержкой markdown fences и prose-обёрток.
- **Fallback model**: на 5xx / `model_not_found` / `not_available` падаем с `grok-4.3` на `grok-4.20-0309-reasoning`. Тот же pricing ($1.25/$2.50 per 1M), оба reasoning-capable.
- **Cost tracking**: `cost = (input × 1.25 + output × 2.50) / 1_000_000`. Записывается в `tag_refresh_history.cost_usd`, summary в logs `[TagRefresher] done in Xs ... cost=$0.123`.
- **`max_tool_calls: 5`**: hard cap на consecutive x_search calls — без него Grok делает 4+ search'ей на один запрос, накапливая search results в reasoning context → quadratic input tokens (тот же trap scorer.js Stage 2 ловил).

**Pipeline per-preset refresh**:
1. `_buildPrompt(preset, existing)` — system prompt (моdule-level constant) + user prompt с EXISTING list across **всех 5 пресетов** (anti-duplicate) + per-preset theme description.
2. `_callGrokWithFallback(prompt)` — primary `grok-4.3`, fallback `grok-4.20-0309-reasoning`.
3. `_parseJson(text)` — strips markdown fences, finds first balanced `{...}` block.
4. `_sanitizeResponse(parsed)` — regex-validation: subreddits `^[a-zA-Z0-9_]{2,40}$` без `r/` prefix; twitter groups `^\(.+\)$` БЕЗ цифр / `min_faves` / `-is:retweet`. Дедуп case-insensitive.
5. `_realityCheckTwitter(proposed, preset)` — variant-3: для **новых** keyword groups (skip already-existing) делаем 1 Apify Twitter probe `${group} min_faves:100 -is:retweet`, max 5 results. Если 0 — drop. Если probe error — drop conservatively. Existing groups passes-through (они уже работают).
6. `_computeDiff(preset, sanitized)` — sets из current defaults + locked-mask (`presetTagsLocked`). Locked tags **никогда не удаляются** (даже если Grok их не предложил).
7. `_applyAutoOverride(preset, diff)` — пишет в `settings.presetConfigsAuto`, sparse blob. Восстанавливает `min_faves` для каждой Twitter query (берёт из defaults original, новые получают median min_faves). Если final result == defaults точно — drops slot (no-op pollution prevention).

**Sanitization details**:
- Twitter keyword groups валидируются жёстко: regex `^\(.+\)$` (must be wrapped in parens) И `!/min_faves|-is:retweet|\d+/` (no numbers, no operators). Если Grok добавит `(skibidi OR delulu OR 2026)` — отвергается (потому что цифры в `2026`). Если без скобок — отвергается. Это double-check к промпту.
- Subreddits: `replace(/^\/?r\//i, '')` срезает любые префиксы `r/`, `/r/`. Затем regex matches `/^[a-zA-Z0-9_]{2,40}$/`.
- Если sanitized result полностью пустой (subs=0 AND twitter=0) — `status: 'rejected_validation'`, audit row пишется с raw text head в error_message для debugging. Auto-blob не трогается.

**Reality-check (variant 3) детали**:
- Probe = single Apify Twitter call через `twitter.searchByQuery(query, 5, {relaxedFloor: true})`. Стоимость одного probe ~ $0.001 (5 tweets max). На 5 пресетов × 5-6 keyword groups × 0-3 NEW groups per refresh = ~$0.01-0.03 per refresh, погрешность.
- Skip-logic: existing keyword groups (уже в defaults / auto / manual) не проверяются — они известно работают, лишний расход бюджета.
- Если twitter instance не передан в constructor (early-boot edge case) — pass-through без probe + warn-log.

**Locked tags merge**: `_computeDiff` читает `presetTagsLocked[preset].reddit/twitter` arrays. Locked items добавляются в `kept` set всегда, попадают в final apply без условий. Это даже если Grok их не предложил И их нет в defaults — locked = sticky. Phase 3 добавит UI для записи в этот lock-mask.

**Failure handling**:
- 5xx / model_not_found → fallback model
- JSON parse error → throw, audit `error` status, anyFailure=true, retry next cycle
- Validation reject (empty after sanitization) → audit `rejected_validation` status, NOT counted as failure (no streak bump) — это «Grok дал мусор», не «infra сломалась»
- 3 consecutive `error` runs (only `error`, не rejected_validation) → circuit breaker

**Wire**:
- `index.js`: после `collectors.find('Twitter')` — `if (twitterInstance) tagRefresher.twitter = twitterInstance;` пост-инициализационный attach (TagRefresher constructed BEFORE collectors).
- `_isApiAvailable()` checks `XAI_API_KEY` — `refreshAll` reject'ит refresh с reason `no_api_key` если ключа нет.

**Файлы**: `src/refresh/tag-refresher.js` (полностью переписан, ~430 строк), `src/index.js` (twitter attach + комментарий обновлён).

**Деплой**: TBD юзером. После Phase 2 деплоя — first force-refresh даст реальные предложения. Если выйдут плохие — Clear ALL вернёт всё к code-defaults, потом юзер выключит toggle и решит что дальше.

**Sanity checks пройдены**: `node --check` для tag-refresher.js, index.js, admin/server.js ✓. SPA template ✓ (207K chars).

**Риски**:
- xAI x_search tool input shape может отличаться от моих предположений. Я взял ровно тот pattern что Stage 2 использует (line 725-731 scorer.js). Если что-то пойдёт не так — error будет в audit log с full xAI response text.
- Grok-4.3 — модель вышла недавно (дата релиза < 1 неделя). Может иметь instability на сложных prompt'ах. Fallback на 4.20-reasoning должен спасти.
- `_parseJson` берёт первый `{` до последнего `}` — если Grok даст несколько JSON блоков подряд (например narrative + JSON + narrative + JSON), возьмёт всё включая prose между. Validation на следующем шаге это выкинет.
- Reality-check probe использует `relaxedFloor: true` (10K views / 500 likes). Это лояльный bar — keyword group с одним viral tweet проходит. Это не fail-mode потому что мы хотим сохранить keywords которые catch'ат **редкие** но виральные events.

