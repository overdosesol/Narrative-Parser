# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 без архивации. Полная история — в git.

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

