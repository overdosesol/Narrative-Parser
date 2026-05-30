# WORKLOG

Активный журнал — **последние ~10 entries**. Всё что старше переезжает в
[`WORKLOG_ARCHIVE.md`](./WORKLOG_ARCHIVE.md) (правило `AGENT_RULES.md §6`).

Append на верх — новейшие сверху, старейшие снизу. Порог в 10 — мягкий:
если несколько entries относятся к одному PR/дню, можно временно держать
до 12 безархивации. Полная история — в git.

Если задача мелкая, например передвинуть кнопку в дашборде или изменить немного текст в промпте для llm, можно сразу не записывать в WORKLOG, а подождать пока накопится около 5 мелких правок или 1 большая и записать всё вместе.

---

## 2026-05-31 · Stage 1 deep escalation — under-scored trends → Stage 2 bypass · Claude Opus 4.8 (subagent-driven)

**Цель:** недооценённые / помеченные моделью «тяжёлые» тренды попадают в Stage 2 x_search независимо от meme-gate; reasoning-слой за admin-тогглом.

**Изменения:**
- `src/analysis/scorer.js` — добавлены `isUnderscored`, `escalationSignalStrength`, `selectDeepDiveCandidates` (heuristic pool + reserve+reflow); `scoreTrends` wired-in; reasoning model switch; телеметрия (`stage2HighMeme` / `stage2Escalated` / `deepReasoning`).
- `src/analysis/prompts.js` — `needsDeeperLook` + `escalationReason` добавлены в `STAGE1_RESPONSE_SCHEMA` + инструкция в `SYSTEM_PROMPT`.
- `src/admin/server.js` — admin controls: тоггл `deepReasoningEnabled`, поле `stage2ReasoningModel`, поле `escalationReserve`.
- `docs/superpowers/specs/2026-05-31-stage1-deep-escalation-design.md` + `docs/superpowers/plans/2026-05-31-stage1-deep-escalation-plan.md` — спека + план (committed).

**Деплой / проверка:** ветка `feature/stage1-deep-escalation`; деплой через `deploy.ps1` оператором. Reasoning-слой shipping OFF (нужно задать `stage2ReasoningModel` + включить тоггл).

**Риски:** эвристические пороги (50/65/60/8/40) — консервативные seed-значения, не откалиброванные на проде. Смотреть `escalated=N` в логе Stage-2 cost на первом живом цикле; тюнить через DB settings. Reasoning model id/cost для Grok — не подтверждены (tracked в IDEAS.md).

---

## 2026-05-30 · fix: cleanupAlerts FOREIGN KEY crash (ночной uncaughtException) · opus

**Симптом:** в support-группу прилетел `SqliteError: FOREIGN KEY constraint failed` at `database.js:1845` → `cleanupAlerts` → `uncaughtException`. Прилетало раз в сутки (полночь).

**Root cause:** инцидент 29-го включил `foreign_keys=ON`, но `cleanupAlerts` остался из pre-FK эпохи. Стр.1845 делала `DELETE FROM trends WHERE first_seen_at < cutoff` напрямую, а на старые тренды ещё ссылались дети без `ON DELETE`: `notifications` (в т.ч. со свежим sent_at — time-based delete их не трогал), `feedback_votes`, `hidden_trends`, `x_analysis_history`. FK блокировал удаление → откат транзакции → исключение. Вызов-источник `index.js:808 db.cleanup(30)` в полночь был **без try/catch** → краш процесса. Вреда данным нет (транзакция атомарно откатывалась, Docker поднимал контейнер за секунды), но грязный краш + поехал бы на новый сервер 1:1.

**Связь FK по trends(id):** notifications/feedback_votes/hidden_trends/x_analysis_history — без cascade (блокируют); alert_score_history — `ON DELETE CASCADE` (ок).

**Фикс:**
- `database.js cleanupAlerts` переписан: внутри транзакции вычисляем set старых trend_id → удаляем зависимые строки **дети→родитель** (чанки по 400 под лимит SQLite-переменных), потом сами тренды; alert_score_history уходит каскадом. + legacy-orphan notifications по cutoff. Cutoff переведён на `sqliteCutoff()` (заодно убран space/T баг — был `toISOString()`).
- `index.js` полночный блок: `db.cleanup()` и `db.resetDailyAlertCounts()` каждый в своём try/catch → ошибка чистки больше не валит процесс и не пропускает reset (defense-in-depth).

**Верификация (TDD):** написан repro-тест (старый тренд + свежая notification + все 4 типа детей + контрольный свежий тренд) — на старом коде **FAIL** (`FOREIGN KEY constraint failed`, trends 2→2, ничего не удалено), после фикса **PASS ALL** (старый+дети снесены, свежий тренд и его голос целы, без исключений). `node --check` обоих файлов OK. Тест-файл удалён после прогона.

**Деплой:** не делался. Уедет тем же `deploy.ps1` на катовере (Фаза 3b) — отдельный деплой не нужен.

**Риски:** низкие. Логика чистки строго в транзакции; затрагивает только данные старше 30д (тренды/notifications/votes/hidden/x-history), users/plans/payments не трогает.

---

## 2026-05-30 · миграция на новый VPS (Vultr Frankfurt) — фазы 0-2 · opus

**Цель:** Переезд прода с 37.1.196.83 (общий сервер с другими скриптами) на выделенный Vultr `vhf-1c-1gb` (136.244.82.53, Ubuntu 24.04, NVMe, $6/мес, Frankfurt). Только Catalyst на новом.

**Сделано (новый сервер; прод НЕ тронут — всё read-only):**
- SSH по ключу (тот же ed25519, что для deploy.ps1), пароль сменён оператором, ufw 22/80/443, PasswordAuthentication off. Swap 3 GB (Vultr дефолт).
- Софт: docker-ce 29.5 + compose v5.1 (офиц. репо), nginx 1.24, certbot 2.9, rclone, sqlite3, git.
- Сверка `.env` локальный↔прод по SHA256-хэшам значений: **все 36 ключей совпали** — локальный конфиг актуален, deploy.ps1 зальёт правильный.
- Перенесён `/root/.config/rclone/rclone.conf` (B2-креды) — единственное, чего нет в репо. B2 доступен с нового сервера.
- Репетиция: восстановлен последний B2-бэкап (`catalyst_2026-05-30_03-30.db.gz`), integrity_check ok, **row-counts 1-в-1 с живым продом** (users 2, trends 12746, notif 612, plans 4, 21 таблица). Образ собрался на 1 GB за 49с (пик памяти ~470 MB → 1 GB хватает с запасом). Прогон app: health 200 `{"ok":true,"paused":true}`, дашборд 200 (555 KB), admin 200, миграции на реальной БД без ошибок (FATAL_COUNT=0), контейнер 69-72 MiB. Боты глушились fake-токеном (getUpdates 401, боевой polling не тронут). Стенд снесён; образ/креды/бэкап оставлены тёплыми.

**Находки (важно для катовера):**
- На проде сейчас `scanner_paused=1` (с инцидента 29-го) → **после катовера сканер возобновить вручную** в админке.
- `/etc/catalyst.env` на старом сервере ОТСУТСТВУЕТ (бэкап-алерты в TG молчат; rclone-креды берутся из rclone.conf, не отсюда). На новом создадим правильно.
- config.js hard-fail в production при пустом TELEGRAM_BOT_TOKEN (проверяется наличие, не формат). После правок .env нужен `up -d --force-recreate`, не `restart` (env_file перечитывается только при пересоздании).
- DNS домена — **Porkbun** (ns *.porkbun.com). A-запись @ + www сейчас → 37.1.196.83, TTL **600с**. Понизить TTL до 60с ДО катовера (оператор, в панели Porkbun).
- TLS-сертификат Let's Encrypt на старом валиден до 2026-08-03 (65д). План катовера: **скопировать `/etc/letsencrypt/` старый→новый** (rsync -a, тянет archive+live+renewal) → nginx на новом стартует с TLS сразу, без certbot-challenge и без chicken-and-egg (nginx-конфиг ссылается на cert-файлы, которых иначе нет). certbot.timer на новом уже включён — renewal сам отработает через ~35д, когда DNS уже на новом.

**Файлы:** только инфра (новый VPS) + этот WORKLOG. Код/конфиги репо не менялись → SESSION_CONTEXT не трогал.

**Обвязка нового сервера готова (Фаза 3a, прод не тронут):** TLS-серт `/etc/letsencrypt` скопирован старый→новый (valid до 2026-08-03), nginx-конфиг установлен (sites-enabled, default убран), `nginx -t` ok, nginx слушает 80/443 и отдаёт правильный серт (локальный TLS-хендшейк ok, `/api/health` = 502 — app ещё не поднят, как и ожидается). `/etc/catalyst.env` создан (TG-креды впишутся на катовере). Бэкап-крон 03:30 установлен (скрипты приедут с deploy.ps1).

**КАТОВЕР ВЫПОЛНЕН (Фаза 3b, 2026-05-30 ~13:45 UTC):** старый app погашен (`docker compose stop`, Exited 0) → финальный `sqlite3 .backup` (integrity ok, FK-check 0, sha256 bb0dcd89, users 2/trends 12746/notif 612) → перелит old→ПК→new, sha256 совпал → положен в volume new (chown 1000:1000) → оператор `.\deploy.ps1 -Server root@136.244.82.53` → app поднялся healthy, **боевой бот подключился** (Bot commands registered, без 401), support-бот `@CatalystSupportbot` ожил, admin-alert enabled, FATAL_COUNT=0 → оператор сменил A @+www → 136.244.82.53 (Porkbun) → DNS разъехался <10мин (authoritative + локальный резолвер оба на новый IP), `https://catalystparser.io` HTTP 200 + TLS verify ok → сканер возобновлён через admin API (`scanner_paused=0`, health paused:false). Память 100 MiB/955, Restarts=0, 0 ошибок после resume. **Сервис полностью на новом сервере.**

**Фаза 4 ВЫПОЛНЕНА (2026-05-30):**
1. ✅ deploy.ps1 L2 `$Server` + L115 echo, deploy.sh L4 `SERVER` + L55 echo → новый IP 136.244.82.53 (echo-URL заодно сменён на `https://catalystparser.io`, т.к. голый IP:8080 закрыт ufw). Старый IP в репо остался только в WORKLOG/ARCHIVE + docs/superpowers/plans|specs (история — не трогаю).
2. ✅ `/etc/catalyst.env` заполнен TG-кредами из .env (на старом сервере его НЕ БЫЛО → алерты бэкапа молчали; теперь работают). Бэкап прогнан вручную: `backup OK (9.5M)`, exit 0, новый файл в B2 `catalyst_2026-05-30_14-03.db.gz`. Конвейер hot-backup→gzip→локально→B2 исправен. Крон 03:30 на месте.
3. ✅ SESSION_CONTEXT обновлён (новый IP/сервер + admin SSH-tunnel команда). DEPLOY.md §6.7 — IP не захардкожен, правка не нужна.

**Остаточные хвосты (НЕ срочно):**
- Старый сервер (37.1.196.83): app погашен (`docker compose stop`), БД цела в volume — роллбэк-окно 3-7 дней. Потом снести Catalyst со старого (там др. скрипты оператора — НЕ трогать). Бэкап-крон на старом ещё активен — можно отключить, чтобы не плодил дубли в B2 (оба сервера льют в одну корзину; не критично — имена с разным временем).
- FK-фикс cleanupAlerts уехал этим деплоем — проверить в ближайшую полночь (00:00 локального сервера), что краш-алерт в саппорт больше не прилетает.
- Admin доступ теперь: `ssh -N -L 18081:127.0.0.1:8081 root@136.244.82.53` → `http://127.0.0.1:18081/`.

**Риски:** нет (прод не трогали). Катовер делать в окно: погасить старый app → финальный `sqlite3 .backup` → залить на новый → поднять → переключить DNS → certbot → возобновить сканер.

---

## 2026-05-29 · opus · PROD INCIDENT — 502 after all-at-once deploy (B10 unique-index boot crash) + boot-safe hardening

**Симптом:** после деплоя всего бэклога разом — `502 Bad Gateway` (nginx жив, апп в краш-лупе `Restarting`).

**Root cause:** деплой «всё разом» без прогона B10-миграции. `_migrate()` на boot гонит `schema.sql` → `CREATE UNIQUE INDEX idx_notifications_dedup ON notifications(trend_id,channel,user_id)`; в проде было 3 дубль-группы (5 строк) → `SQLITE_CONSTRAINT_UNIQUE` → необработанное исключение → process exit → Docker рестарт-луп. Подтверждено `docker logs` + эмпирическим in-memory тестом ДО фикса.

**Прод-фикс** (read-only диагностика → operator authorized mutation): `docker stop` → 2 бэкапа (`cp` + `sqlite3 .backup`, integrity ok) → минимальный верный фикс (дедуп notifications −5, создание индекса, транзакционно, `-bail`) → `chown 1000:1000` → `docker start`. Boot чистый, health **200** внутри+снаружи. Бэкапы на VPS: `catalyst.db.{pre-b10,fullbak}-*` (почистить позже).

**Discovered:** сама B10-миграция багнута — `migrate-db-constraints-2026-05-28.sql:19` делала `DELETE FROM user_favorites WHERE user_id ...`, но таблица keyed по `chat_id`, без колонки `user_id` и вообще без FK (favourites by design переживают тренд). Поэтому прогнал только notifications-часть (100% верную), orphan-sweep не трогал.

**Hardening (репо, следующий деплой):**
- `src/db/database.js _migrate()` — индекс перенесён сюда: **дедуп → `CREATE UNIQUE INDEX IF NOT EXISTS`**, guarded `try/catch`, на каждом boot. Устраняет весь класс «деплой без миграции → 502». Self-heal протестирован (in-memory: дубли+нет индекса → boot НЕ падает, дедуп 4→2, индекс создан, dup-insert блокируется).
- `src/db/schema.sql` — убран `CREATE UNIQUE INDEX idx_notifications_dedup` (он и ронял boot) + коммент-указатель на `_migrate`.
- `scripts/migrate-db-constraints-2026-05-28.sql` — убраны обе багнутые `user_favorites` orphan-DELETE; orphan-sweep сверен по реальным FK (schema.sql + `_migrate` DDL — только декларированные FOREIGN KEY); шапка: скрипт теперь опциональный (notifications-часть self-heal'ится в `_migrate`).

**Верификация:** `node --check` OK; SPA не тронут; hardening-тест PASSED (4 чека). **Прод УЖЕ на исправленной БД**; код-hardening уедет следующим `deploy.ps1`. Урок сохранён в memory (`feedback_boot-safe-migrations`).

---

## 2026-05-29 · opus · Bundle #5 — sqliteCutoff consolidation + REAL space/T bug fix (DB-012/020/027 + SD-8)

**Цель:** Свести разбросанный timestamp-cutoff в один shared-хелпер. Recon вскрыл, что это НЕ причёсывание, а **реальный баг**: 8 мест сравнивали `toISOString()` («T»-формат) против `CURRENT_TIMESTAMP`-колонок («пробел»-формат). Пробел (0x20) < «T» (0x54) → `WHERE col > cutoff` молча возвращал ~0 строк для свежих данных. Подтверждено in-memory тестом ДО правки.

**Что было сломано (теперь восстановлено как задумано):**
- `isTrendSeenFuzzy` — fuzzy-дедуп трендов по похожему заголовку (запрос всегда пуст → фича не работала; точные дубли ловились другими слоями, поэтому не замечалось).
- `clusterer._fetchHistory` — окно истории для кластеризации (пусто → влияло на novelty → **скоринг**).
- `getRecentTrends` — выборка свежих трендов.
- admin `_getStats` — новые юзеры/выручка за 7/30д (показывали **0** при наличии данных).
- hidden_trends (feed-фильтр + архив) + retention-чистка.

**Оператор согласовал «чинить всё»** (показал баг + видимый эффект ДО правки, т.к. влияет на ленту/алерты). Ожидаемый эффект после деплоя: меньше почти-дублирующихся трендов/алертов (дедуп ожил) + точные админ-статы 7/30д.

**Файлы:**
- `src/utils/sqlite-time.js` (new) — `export function sqliteCutoff(msAgo)` (space-формат) + JSDoc с объяснением бага. Единый источник.
- `src/db/database.js` — import + 5 мест (3 retention hidden_trends + `isTrendSeenFuzzy` + `getRecentTrends`).
- `src/analysis/clusterer.js` — import + `_fetchHistory`.
- `src/admin/server.js` — import + `_getStats` day7/day30 (SPA gate ✅).
- `src/dashboard/server.js` — import + удалён локальный дубль `sqliteCutoff` (bug-doc коммент оставлен); 4 существующих callsite'а теперь на общем хелпере (SPA gate ✅).
- `src/analysis/manual-analysis.js` — import + удалён 2-й дубль `sqliteCutoff`.
- `src/analysis/embeddings.js` — SD-8: docstring TTL поправлен (убрано неверное «5min = scan_interval × 2»; реальный scan interval = 15min).

**Верификация:** `node --check` 7 файлов OK; `npm run check:spa` зелёный (346231 / 271793); throwaway functional-тест: `isTrendSeenFuzzy` находит свежий near-dup (был FALSE под багом), `getRecentTrends(24)`→строка, unrelated→FALSE. Тест удалён.

**Деплой:** код, no commit. Оператор коммитит + `deploy.ps1`. Без schema/env/migration.

**Closes:** DB-012 (3 hot scoring queries), DB-020 (8 secondary), DB-027, SD-8. **Tier 4 полностью разобран** (6 done + #14 dropped). Весь аудит-бэклог закрыт, кроме Tier 1 #18 (QA-инфра, deprioritized для соло).

---

## 2026-05-29 · opus · Bundle #12 — theme contract sync (SD-12/UX-004/DOC-006; QUAL-005 pre-closed) — doc-only

**Итог:** синк контракта тем — только `ai-context/SESSION_CONTEXT.md`, кода не трогал. Recon (haiku) подтвердил: реальный код = 3 темы (`SUPPORTED_THEMES=['pulse','ink','tide']`, `detectTheme()→'pulse'`, `applyThemeAttr()` снимает attribute для pulse), а CSS-коммент `dashboard/server.js:2686` уже исправлен Bundle #19 (QUAL-005). Stale оставался только state-spec.

**Файлы:**
- `ai-context/SESSION_CONTEXT.md` § Theme system — переписана: «2 dark темы, ink default» → «3 темы, pulse default (`:root` baseline без attribute) + ink/tide (`body[data-theme]`)». Таблица 3 строки, обновлён последний абзац (`detectTheme()→pulse`, `applyThemeAttr`). Дизайн-принципы не тронуты — актуальны.

**Деплой:** не требуется (только ai-context). No code, no SPA.

**Closes:** SD-12 + DOC-006 + UX-004 (все три = один drift: state-spec врал про число тем и дефолт). QUAL-005 — был закрыт Bundle #19. **Tier 4: 5/7** (#7 + #20 + #4 + #9 + #12). Remaining: #5 sqliteCutoff (scoring), #14 i18n.

---

## 2026-05-29 · opus · Bundle #9 — hover-preview plan-check + rate-limit (BILL-001 + COST-004) — verified pre-closed, no code change

**Итог:** оба finding'а #9 уже закрыты предыдущими бандлами — код-правок не потребовалось. Verified по текущему `src/dashboard/server.js`:
- **BILL-001** (plan-gate на hover preview) — закрыт Bundle #3: `_handleTweetPreview` (~1343) и `_handleRedditPreview` (~1415) гейтят по `getPlanEntitlements(plan).sources.includes('twitter'|'reddit')` → 403 `reason:'plan'` до любого fetch.
- **COST-004** (Reddit/Twitter IP-ban через unthrottled preview) — закрыт Bundle #8: module-level `tweetPreviewLimiter`/`redditPreviewLimiter` (30 req/5min, ~420) + guards в обоих хендлерах → 429 `reason:'rate_limit'`.

`node --check src/dashboard/server.js` → OK. INDEX и так помечал #9 «already partially covered by #3». Закрыт документально, SPA не тронут.

**Closes:** BILL-001 (HIGH), COST-004 (HIGH) — обе уже live. **Tier 4: 4/7** (#7 + #20 + #4 + #9).

---

## 2026-05-29 · opus · Bundle #4 — db.transaction batch helpers (DB-013/TXN-002/003; COST-007 false positive)

**Цель:** Закрыть DB-013 (4 unbatched save-loop'а = N fsync вместо 1) через batch-хелперы. COST-007 расследован — false positive.

**Метод:** tightly-coupled refactor (хелпер + 4 потребителя его API) → inline-исполнение (не subagent-driven: по SDD-гайду coupled-задачи делаются вручную). Recon (haiku) → правки → верификация `node --check` (5 файлов) + throwaway in-memory тест (14 чеков: ordered ids, персист, UPSERT-идемпотентность, skipErrors, history-батч) → тест удалён. SPA не тронут → SPA-gate не нужен.

**Файлы:**
- `src/db/database.js` — +2 метода на `TrendDatabase`: `saveTrendsBatch(payloads, {skipErrors, onError})` (возвращает id'шники по порядку payload'ов; внутри — существующий `saveTrend` UPSERT) и `recordAlertScoreHistoryBatch(rows)`. Оба через `this.db.transaction()`.
- `src/index.js` — 2 save-loop'а → `db.saveTrendsBatch()`: main post-AI save (~641, маппит id'шники обратно в `_dbId` для alert-dispatch) + low-signal save (~590). Payload-логика идентична.
- `src/refresh/hot-metrics.js` — hot-refresh save-loop (~263) → `saveTrendsBatch(..., {skipErrors:true, onError:warn})`. Сохранена per-item резильентность + warn-логи + счётчики. **`_dbId` НЕ маппится назад** (намеренно — Phase-4 alert-фильтр опирается на `_dbId` из Phase-1; менять = менять кто получит алерт).
- `src/notifications/alert-dispatcher.js` — `recomputeAlertScores` loop (~91): мутация alertScore/breakdown нетронута, sparkline-инсерты собираются в массив → `recordAlertScoreHistoryBatch()` после цикла (defensive-фолбэк на per-row).
- `src/analysis/scorer.js` — поясняющий коммент к `metrics.stage2Calls++` (~705): COST-007 false positive.

**COST-007 разбор:** аудит решил, что фейлы Stage 2 «съедают» кап. Реально кап = `.slice(0, stage2MaxCalls)` ДО цикла; `metrics.stage2Calls` — только лог-строка `stage2_calls=X/Y` + admin UI, цикл не гейтит. Перенос инкремента поменял бы лишь метрику (attempts→successes) и сделал бы «calls» менее точной (фейл тоже жжёт токены). **Не применяю**, коммент против повторного флага.

**Деплой:** код, no commit. Оператор коммитит + `deploy.ps1`. Никаких schema/env/migration изменений.

**Риски:** низкие. На save-пути index.js loop 1/2 транзакция меняет error-гранулярность (фейл середины batch'а: было partial save + проброс → стало полный rollback + проброс) — улучшение (нет полу-сохранённого скана); на success-пути запись идентична. Транзакции синхронны (saveTrend/recordAlertScoreHistory без await) — требование better-sqlite3 соблюдено.

**Closes:** DB-013 (HIGH), TXN-002/003 (cross-audit синонимы DB-013). COST-007 (MEDIUM) — false positive, documented (не код-фикс). **Tier 4: 3/7** (#7 + #20 + #4).

---

## 2026-05-29 · opus · Bundle #20 — README + DEPLOY runbooks (DOC-001/016/017/018; DOC-002/003/004 pre-closed)

**Цель:** Закрыть документ-находки Tier 4 #20 — создать отсутствующий README.md (DOC-001) + добить incident-response секции DEPLOY.md (DR, troubleshooting, migration note). Подтвердить, что DOC-002/003/004 уже закрыты ранее (#1 restore §6.5/6.6, #17 cert §4.2 + secret rotation §10.1).

**Метод:** docs-бандл, без TDD/SDD-машинерии. Recon деплой-инфры (haiku) → написание → фактчек по коду (haiku — 12/14 точны, 2 расхождения исправлены) → operator review. SPA-gate не нужен (server.js не тронут).

**Файлы:**
- `README.md` (new, ~115 строк, англ.) — pitch, what it does, pipeline-диаграмма, tech stack, quick start (dev) + npm scripts, минимум env, plans-таблица, project layout, ссылка на DEPLOY.md, SPA-trap heads-up, private-license. Факты выверены по package.json / .env.example / структуре `src/` / SESSION_CONTEXT pipeline.
- `DEPLOY.md`:
  - §6 intro переписан под реальный `catalyst-backup.sh` (было: до-#1 inline `sqlite3 ".backup"` cron + «rsync/aws s3 cp»; стало: docker inspect catalyst-app /data → integrity_check → hot .backup → gzip+`gzip -t` → 14d prune → rclone `b2:` → TG fail-trap, креды в `/etc/catalyst.env`). Drift-фикс.
  - +§6.7 Disaster Recovery (рус, ~50 строк) — полный rebuild VPS с нуля: новый VPS+DNS → docker/rclone/nginx/certbot → секреты из password manager → deploy кода → БД из B2 (ref §6.5) → TLS → cron → verify. RTO ~30-60мин, RPO ≤24ч.
  - +§13 Common troubleshooting (рус) — 6 сценариев: бот молчит (401/409), dashboard 502, Apify quota, коллектор в краш-лупе, OOM, SQLITE_BUSY. Старая «Future hardening» → §14.
  - +§7 migration note (англ) — авто-`_migrate()` на boot, ручного шага не нужно.
  - §8 bonus-фикс: admin health пример `8080`→`8081` (пред-существующая опечатка, поймана фактчеком).

**Деплой:** доки, кода нет. Рантайму не нужны; оператор коммитит, попадут в следующий обычный `deploy.ps1` заодно — отдельного шага не требуют. Никаких env/migration/SPA изменений.

**Риски:** нулевые (pure docs). Главный риск — doc-lies — закрыт фактчек-пассом по коду (порты, npm-скрипты, имена зависимостей, структура `src/`, container name, `busy_timeout`, deploy IP — всё подтверждено).

**Closes:** DOC-001 (HIGH, README), DOC-016 (MEDIUM, DR), DOC-017 (LOW, troubleshooting), DOC-018 (LOW, migration note). Pre-closed подтверждено: DOC-002 (#1), DOC-003/004 (#17). **Tier 4: 2/7** (#7 + #20).

---

## 2026-05-28 · sonnet · Bundle #7: /api/scan admin gate + pause persistence — 4 finding'ов + 1 SD одним PR

**Цель:** Закрыть SEC-001 (manual scan privilege) + PIPE-004 (immediate timestamp visibility) + BILL-003 (free user LLM-burn) + ADM-018 (pause lost on restart) + SD-16 (pause persistence drift).

**Файлы:**
- `src/dashboard/server.js` — `_handleScan`: +admin plan check на верху (`req.user?.plan_name !== 'admin'` → 403 `reason: 'plan'`) + immediate `setSetting('lastScanStartedAt', Date.now())` перед scanFn-fire. SPA gate ✅.
- `src/admin/server.js` — `/api/scanners/pause` теперь `setSetting('scanner_paused', '1')`, `/api/scanners/resume` → `'0'`. Best-effort try/catch (in-memory всегда update'ит). SPA gate ✅.
- `src/index.js` — после `const db = ...`: restore `appState.paused = true` если `getSetting('scanner_paused') === '1'`. WARN log при restored pause: «Scanner is PAUSED (persisted from previous session). Resume via admin panel.»

**Деплой:** стандартный `deploy.ps1`. Никаких schema / env / migration изменений.

**Риски:** admin-only гейт может lock'ать test/pro user'ов, но они и так не должны иметь доступ (audit принцип). Persisted pause требует операторской дисциплины — забыл resume → бот навсегда paused. Mitigation: WARN-level boot log с suggested next action.

**Не сделано:** admin UI badge «scan in progress» (using lastScanStartedAt vs lastScanCompletedAt) — deferred, data exposed для будущей UI работы. Schema migration на отдельный `admin_state` table — settings table достаточно для 2-key footprint.


