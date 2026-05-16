# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 без архивации. Полная история — в git.

Если задача мелкая, например передвинуть кнопку в дашборде или изменить немного текст в промпте для llm, можно сразу не записывать в WORKLOG, а подождать пока накопится около 5 мелких правок или 1 большая и записать всё вместе.

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
