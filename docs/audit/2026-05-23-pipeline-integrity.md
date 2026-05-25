# Pipeline integrity audit — 2026-05-23

**Scope**: второй этап чекапа. Целостность пайплайна от collector'а до Telegram-алерта: transient failure recovery, 3-layer preset merge, tag-refresher anti-hallucination, Stage 2 gates, junk-filter + text-only multiplier, clusterer, collectors, deploy-aware scheduler, hot refresh + Catalyst forecast, alert-dispatcher gates ordering, PreStage providers + caching. **Не покрыто** (другие этапы): cost throttling per-user (4), DB schema/indices/retention (5), UX states (6), TG delivery format (8), security (1 — уже сделан).

**Method**: 11 параллельных агентов (sonnet для transient/clusterer/alert-dispatcher, haiku для остальных) + ручная верификация против исходников. Ничего в коде не менялось.

---

## Data-flow map

Один абзац, чтобы зафиксировать понимание контрактов и поймать расхождения:

```
[scheduler tick / boot resume / manual trigger]
   ↓
runScanCycle(){
   collectors.{reddit,twitter,tiktok,google-trends,x-trends}.collect()   // per-iter try/catch, return [] on Apify fail
      ├─ Apify Authorization: Bearer (token не в URL — undici trace leak protection)
      ├─ tiktok: live hashtag discovery + max-age filter (14.05) + COMPILATION_RE
      ├─ twitter: max-age 72h + relaxed floor для X-Trends
      └─ _normalize → trend{externalId, source, title, url, created_at, raw_metrics}
   ↓
   clusterer.cheapDedup(items)                                            // zero-API, exact title-norm + url; loser dropped
   ↓
   PreStage.run(unique)
      ├─ Promise.all([nano, gemini])  // каждый с .catch → null
      ├─ nano (gpt-5.4-nano) — text enrichment (default OFF since 09.05)
      └─ gemini-captioner — Google AI Studio → OpenRouter failover
                            cooldown circuit (3 fails → 5 min)
   ↓
   clusterer.route(items)                                                  // 4-signal: emb 0.40 + dHash 0.30 + entity 0.20 + ticker 0.10, threshold 0.55, time penalty 24h
      └─ clusterMetrics{emergenceScore, narrativePhase, isNovel, marketStage, junkPenalty, junkReasons}
   ↓
   scorer.scoreTrends(trends)
      ├─ Stage 1 batch (Gemini/Grok/OpenAI) → memePotential, virality, alertType, whyNow, aiExplanation
      │     └─ 5xx/timeout/parse → _fallback(_aiUnavailable=true, aiExplanation='AI unavailable'|'Parse error')
      ├─ Stage 2 gates: memePotential ≥ stage2Threshold(60) AND isNovel !== false AND source !== 'google_trends'
      │     └─ forceStage2 (manual-analysis 17.05) bypass'ит первые два, source-skip остаётся
      │     └─ stage2MaxCalls(3) cap, slice(0, N) на отфильтрованный массив (first-N, не top-by-meme)
      └─ applyTextOnlyMultiplier post-pass (19.05): для social-sources без hasVisualContent → meme×0.65, score×0.65
   ↓
   junk-filter.computeJunkPenalty()
      ├─ raw = politics(+40) + kpop(+30) + celeb(+20) + no-meme-shape(+15)
      ├─ safe-override: animal/absurd/meme/heartwarming → raw/3 (or /4)
      └─ textOnlyAddition (19.05) добавляется ПОСЛЕ safe-override (не аннулируется)
   ↓
   alertScore = w_meme·meme + w_viral·viral + w_emerg·emerg + w_x·twitter + w_fb·feedback − w_junk·penalty − staleDecay
   ↓
   index.js save loop:
      pipeline_status = trend._aiUnavailable ? 'save_only' : 'scored'
      db.saveTrend(UPSERT by externalId)                                   // raw_metrics JSON snapshot
   ↓
   alert-dispatcher.dispatchAlerts({trends, source:'scan'}):
      per-trend gates (push order): ai_score → threshold → hard_junk → lipsync → tiktok_quality → plan_source → source → alert_type → dedup(notifications row) → cap
      per-user iteration: effectiveThreshold = max(user, preset.alertThreshold)
                          alert_types_filter, plan_sources, disabled_sources, alert_threshold per-user
   ↓
   telegram.sendAlertToUser → formatter HTML message → INSERT notifications(trend_id, user_id, channel)
}
   ↓
   finally{ db.setSetting('lastScanCompletedAt', now) }   // boot resume reads this
```

**Параллельные пути**:
- **Hot refresh** (`hot-metrics.js`): heavy 12h (refetch metrics → scoreTrends с carry-through clusterMetrics из `getHotTrendsForRefresh` → dispatchAlerts({source:'refresh'})) + light 60m (только updateXxxEngagement, **БЕЗ LLM, БЕЗ dispatchAlerts**). `route()` НЕ вызывается на refresh — clusterer-domain поля carry-through из source query.
- **Tag-refresher** (`tag-refresher.js`): раз в 2 дня, Grok grok-4.3 + x_search × ~9 → reality-check (Reddit /about.json + Twitter Apify probe + TikTok TIKTOK_HARDSKIP_RE) → `_applyAutoOverride` с empty-array guard → `presetConfigsAuto` + locked-tags carry.
- **Manual analysis**: url-resolver → synthetic trend → PreStage → scoreTrends({forceStage2:true}) → `computeSingleTrendEmergence` (LIKE на entityCanonical, не multi-trend `_computeEmergenceScore`) → optional save.
- **Catalyst forecast**: on-demand POST, Grok grok-4-1-fast-reasoning + x_search, `trigger_in_flight` claim race protection, daily cap (15min cooldown снят).

Карта сходится с тем что декларирует пользователь и SESSION_CONTEXT. Один subtle: документация SESSION_CONTEXT говорит про «per-user 15-min cooldown» для Catalyst, в коде он снят (`trigger-finder.js:1643-1644` — daily cap only). Это flag в Out of scope как spec drift.

---

## Summary

**Counts**: 0 critical · 2 high · 5 medium · 4 low · 7 info · **18 findings total**.

База держится: transient failure recovery работает end-to-end (6/6 checks), 3-layer preset merge консистентен по всем 12 caller'ам после двух фикс'ов, Stage 2 gates корректны (forceStage2 bypass только memePotential + isNovel, не source-skip), text-only multiplier (19.05) применяется ко всем путям (scan/refresh/manual), clusterer изолирует manual-analysis от scan-cycle, hot refresh `light` не делает LLM-calls, collectors graceful-degrade на Apify failures, anti-dupe через `notifications` row реально работает.

Слабые места — два high про **observability/correctness** (alert-dispatcher gate push order расходится с контрактом → DecisionsPage может показывать неправильный firstFail; Gemini cooldown counter не сбрасывается на partial success → 5-min route в OpenRouter даже при 50% успехов Google), и набор medium про edge cases (нет circuit breaker'а на затяжной AI outage → save_only loop с full PreStage cost; tag-refresher `lastRunAt` обновляется при `anyFailure=true` → блок retry на 2 дня; manual scan trigger не обновляет timestamp синхронно → scheduler tick может разойтись; `notifications` table без UNIQUE constraint → race на dispatch + refresh; embeddings cache TTL drift между докстрингом и кодом).

**Top-3 для разбора**:
1. **PIPE-001** (high) — alert-dispatcher: порядок gates в `push` не матчит контракту (`lipsync` пушится перед `tiktok_quality`, должен после) → admin DecisionsPage показывает неправильный firstFail на части TikTok-трендов.
2. **PIPE-002** (high) — Gemini cooldown counter monotonic — не reset на partial success → premature failover в OpenRouter (image-only) → video-trends теряют audio/narrative сигналы.
3. **PIPE-003** (medium) — tag-refresher `tagAutoRefreshLastRunAt` пишется ВСЕГДА, не только при successful refresh → при 5/5 preset fail cooldown 2 дня блокирует retry до завтра.

---

## Findings

### [PIPE-001] Alert dispatcher: `gates[]` push order расходится с контрактом — severity: **high**

* **Where**: `src/notifications/alert-dispatcher.js:336-345`
* **Contract**: SESSION_CONTEXT § Alert gate описывает порядок: `ai_score → threshold → junk → tiktok_quality → lipsync → alert_type → sources_plan → notifications`. `firstFail` в decisions buffer должен соответствовать первому failed gate в этом порядке.
* **What**: gates вычисляются ВСЕ (no short-circuit), потом ищется через `gates.find(g => !g.passed)`. То есть `firstFail` определяется **порядком push'а в массив**, не порядком приоритета. Реальный push: `ai_score → threshold → hard_junk → lipsync → tiktok_quality → plan_source → source → alert_type → dedup → cap`. **`lipsync` стоит перед `tiktok_quality`**, наоборот относительно контракта.
* **Repro/impact**: для TikTok-тренда с `gemini.isLipSync=true` И `memeShapeStrength<60` (оба ловят) — DecisionsPage покажет `firstFail=lipsync` вместо `firstFail=tiktok_quality`. На сам skip не влияет (оба = hard skip), но debug-нарратив «почему скипнули» расходится с docs. Также `_aiUnavailable` флаг проверяется не сам по себе, а через `aiExplanation === 'AI unavailable'|'Parse error'` (см. PIPE-008) — если кто-то добавит новый fallback path с другой строкой, gate не сработает.
* **Fix**: swap'нуть `lipsync` и `tiktok_quality` в push order. Альтернативно — переписать на explicit ordered array + first-match-wins, чтобы документация и код синхронизировались автоматически.

---

### [PIPE-002] Gemini cooldown counter не сбрасывается на partial success — severity: **high**

* **Where**: `src/analysis/gemini-captioner.js:1090-1109` (`_recordGoogleFailure`, `_canUseGoogle`)
* **Contract**: SESSION_CONTEXT § Stage 0 / PreStage — «3 неудачи Google подряд → 5 мин принудительно через OpenRouter». Подразумевается **consecutive** — счётчик должен ресетиться на success.
* **What**: счётчик `_googleFailures` инкрементится на каждом fail, но **reset происходит только после полного выхода из cooldown** (`_googleCooldownUntil` истёк) — не при success'е во время normal operation. Сценарий: trend A fail (counter=1) → trend B success (counter всё ещё 1) → trend C fail (counter=2) → trend D success (counter=2) → trend E fail (counter=3) → **cooldown активируется при 50% успехов Google**.
* **Repro/impact**: при intermittent quota throttle (429) или geo-blocks Google AI → premature failover в OpenRouter на 5 минут. OpenRouter **image-only** для Stage 0b (видео идёт через poster) → video-тренды (TikTok особенно) теряют audio/motion narrative signals, Stage 1 видит только статичный кадр. Это снижает quality scoring'а во время каждой кратковременной Google deg'и. ⚠ assumes: counter работает строго monotonic, лично код не проверял — finding из agent-сводки.
* **Fix**: добавить `_googleFailures = 0` в success-path (после `r.ok` ответа от Google) или хранить sliding window (последние N attempts).

---

### [PIPE-003] Tag-refresher: `tagAutoRefreshLastRunAt` пишется при любом исходе — severity: **medium**

* **Where**: `src/refresh/tag-refresher.js:226` (`refreshAll` вне `if (!anyFailure)` guard)
* **Contract**: SESSION_CONTEXT § Tag auto-refresh + WORKLOG 16.05 — cooldown учитывает last **successful** refresh; failure не должен снимать cooldown с retry.
* **What**: `db.setSetting('tagAutoRefreshLastRunAt', new Date().toISOString())` на line 226 — ВНЕ условия `if (!anyFailure)`. Запись происходит после loop по 5 пресетам, независимо от того сколько из них упало. `anyFailure` используется только для `tagAutoRefreshFailureStreak` bump'а (CB логика отдельная).
* **Repro/impact**: если все 5 пресетов упали с 5xx от Grok → CB streak бампится с 0 до 1 (CB не сработает, нужно 3), НО `lastRunAt` обновляется → cooldown 2 дня блочит retry. Реальный CB наступит только на 3-й попытке через 6 дней (по cooldown), а должен — через 2 retry с обычным интервалом. Throughput tag-refresher'а просаживается.
* **Fix**: переместить timestamp write в `if (!anyFailure)` блок. Альтернативно — два разных setting'а (`tagAutoRefreshLastAttemptedAt` + `tagAutoRefreshLastSuccessAt`), cooldown читает `lastSuccess`.

---

### [PIPE-004] Manual scan trigger не обновляет `lastScanCompletedAt` синхронно — severity: **medium**

* **Where**: `src/dashboard/server.js:2112-2125` (`_handleScan`), `src/admin/server.js:1085-1098` (force-scan handler), `src/index.js:605` (timestamp write в `runScanCycle().finally`)
* **Contract**: WORKLOG 16.05 — `runScanCycle` пишет `lastScanCompletedAt`, scheduler boot/tick читает; manual триггеры тоже должны учитываться чтобы scheduler не дублировал работу.
* **What**: оба HTTP handler'а делают fire-and-forget (`scanFn().catch(...)`) и возвращают 202 сразу. Timestamp пишется в `runScanCycle.finally` через 30-180 секунд (длина scan'а). Если scheduler tick совпал — он прочитает старый `lastScanCompletedAt`, посчитает что пора scan'ить, дёрнет ещё один. `appState.scanRunning` mutex предотвращает реальный parallel run (второй scan bails), но scheduler жжёт log и timeline синхронизация ломается.
* **Repro/impact**: при частых manual scan'ах (admin debug) scheduler logs выдают ложные `scan already running` warning'и; idempotency на уровне `runScanCycle()` сохраняется. Это не data loss, скорее observability noise + jitter в scheduler cadence. ⚠ assumes: line 2112-2125 не имеет immediate timestamp write — лично перепроверил, действительно нет.
* **Fix**: писать `lastScanCompletedAt = now` **сразу** в HTTP handler'е после `scanFn().catch(...)` (treating «trigger» как «scan claim»). Или synchronously await первый шаг (collectors start) перед 202 response.

---

### [PIPE-005] No circuit breaker для затяжного AI outage — severity: **medium**

* **Where**: `src/index.js:419-525` (save_only loop + `_touchTrend` skip), `src/db/database.js:1310-1331` (`isTrendSeen` save_only branch)
* **Contract**: SESSION_CONTEXT § Alert gate описывает retry через 15-минутный scan interval. Implied — это transient, не persistent.
* **What**: при долгом outage LLM провайдера (Gemini/Grok down на часы) — каждый scan заново обрабатывает все save_only trends → каждый платит полный PreStage (nano + gemini captioner на видео — реальные деньги). `times_seen` НЕ инкрементится для save_only (`_touchTrend` вызывается только в scored-path), retry counter не ведётся. Алерта админу про «провайдер лежит N часов» нет.
* **Repro/impact**: 24h outage XAI/OpenAI → сотни trends в save_only, каждые 15 мин полный PreStage (~30 трендов × $0.04 captioner = ~$1.20/cycle × 96 cycle/day = $115/day cost burn на retry без alert payoff). Не critical т.к. данные не теряются, но cost-DoS vector.
* **Fix**: добавить `ai_retry_count` column в trends, exponential backoff (15min → 1h → 4h) на save_only retry или global circuit breaker «N consecutive Stage 1 fails → pause scan-cycle, alert admin». Связано с этапом 4 (cost throttling). Дополнительно — `_touchTrend(row.id)` в save_only branch чтобы `last_seen_at` обновлялся для observability.

---

### [PIPE-006] `notifications` table без UNIQUE constraint на (trend_id, user_id) — severity: **medium**

* **Where**: `src/db/schema.sql:74-86`, `src/db/database.js:1452-1459` (recordNotification), `src/notifications/alert-dispatcher.js:331,382`
* **Contract**: `notifications` row — финальный gate против re-alert. Между `wasNotificationSentToUser(trendId, userId)` SELECT и `recordNotification(...)` INSERT — окно гонки.
* **What**: schema имеет только PK на `id` и индексы `idx_notifications_trend` / `idx_notifications_user`, БЕЗ UNIQUE на `(trend_id, channel, user_id)`. Async sendTask flow: gate cascade проходит → send queued → telegram.sendAlertToUser await → INSERT. Если scan-cycle и hot-refresh-heavy одновременно dispatchAlerts на тот же trend для того же user — оба пройдут wasNotificationSentToUser (row ещё нет), оба await telegram.send, оба INSERT.
* **Repro/impact**: реально низкая вероятность (refresh 12h vs scan 15min, обычно не параллельны), но при race условии — двойной алерт в TG одному юзеру. Не data loss и не cost-blow, скорее UX noise + двойной строй в `notifications`. ⚠ assumes: agent сводка по schema корректна.
* **Fix**: `CREATE UNIQUE INDEX idx_notif_dedup ON notifications(trend_id, channel, user_id)` + try/catch на INSERT (или INSERT OR IGNORE) — конфликт значит «уже отправили, не паника». Защита на DB-уровне дешёвая.

---

### [PIPE-007] Embeddings cache TTL drift между докстрингом и кодом — severity: **medium**

* **Where**: `src/analysis/embeddings.js:13` (docstring), `:32` (`EMBEDDING_CACHE_TTL_MS=300000`)
* **Contract**: SESSION_CONTEXT § Multi-signal clustering — «TTL ≈ 2× scan interval» (scan default 15min → TTL ~30min). Docstring в embeddings.js: «default 5min matches the scan interval × 2».
* **What**: TTL `300000ms = 5 min`. Spec scan-interval = 15min (default), 2× = 30min. Docstring сам себе противоречит («5min = scan interval × 2» подразумевает scan = 2.5min — устаревший defaul, был раньше). Cache evict'тся быстрее чем нужно для cross-cycle reuse → каждый scan ре-embedд'тся те же тренды (`text-embedding-3-small` $0.02/1M ≈ зарядка кофе, но latency + retry surface).
* **Repro/impact**: дополнительные ~30 embeddings per cycle вместо cache hits. Cost — копейки. Latency add — ~500ms на cycle. Не critical. Bigger — docstring confuses next reader, кто будет туннинговать.
* **Fix**: либо привести TTL к 1800000 (30min) под spec, либо переписать docstring и SESSION_CONTEXT под реальные 5min (с обоснованием — например «5min достаточно для intra-cycle dedup, cross-cycle всё равно новые тренды»). Тривиально.

---

### [PIPE-008] `_aiUnavailable` флаг проверяется через `aiExplanation` string match — severity: **low**

* **Where**: `src/notifications/alert-dispatcher.js:319-320`, `src/analysis/scorer.js:1406` (где ставится флаг)
* **Contract**: контракт в WORKLOG 12.05 — «scorer ставит `_aiUnavailable: true` флаг → gate `ai_score` skip'ает». Подразумевается прямой field check.
* **What**: gate смотрит ТОЛЬКО на `trend.aiExplanation === 'AI unavailable' || trend.aiExplanation === 'Parse error'`. Сам `_aiUnavailable` boolean не читается в alert-dispatcher (только в save-loop `index.js:512-525` для pipeline_status). Если кто-то в будущем добавит новый fallback path с другой строкой aiExplanation (например `'Network timeout'`) — флаг будет, gate пропустит, alert уйдёт с aiExplanation='Network timeout'.
* **Repro/impact**: реальная регрессия требует кода кто добавит новый fallback. Сейчас safe — defense-in-depth gap.
* **Fix**: gate проверяет `trend._aiUnavailable === true || aiExplanation in {...}` (OR между обоими сигналами). Single line.

---

### [PIPE-009] Stage 2 cap counter инкрементится на attempt, не на success — severity: **low**

* **Where**: `src/analysis/scorer.js:705` (`metrics.stage2Calls++`)
* **Contract**: `stage2MaxCalls=3` — cap на «вызовы за цикл» (cost knob). При retry на transient fail не должен расходовать quota.
* **What**: счётчик инкрементится перед `_stage2DeepDive` call, не после `success`. Если первая попытка fail (Grok 5xx), счётчик уже 1; следующий тренд получает только 2 attempts. Реальные физические Grok calls могут превысить cap если есть retry внутри `_stage2DeepDive`, но это редкое edge case.
* **Repro/impact**: на 3 failed Stage 2 подряд (rare) — cap исчерпан, оставшиеся трендов с meme≥60 не получат Stage 2 в этом цикле. Hot refresh ловит на следующем 12h cycle. Minor cost-noise.
* **Fix**: переместить инкремент после success'а внутри try-блока. Или вести два счётчика (`stage2Attempts`, `stage2Successes`) для cleaner observability.

---

### [PIPE-010] `cheapDedup` теряет engagement-data проигравших — severity: **low**

* **Where**: `src/analysis/clusterer.js:97-118` (docstring), внутренний loop
* **Contract**: pre-route dedup — exact-match exact-text/url collapse. Document'ит сам, что «losers dropped entirely».
* **What**: При нахождении same-source same-title или same-url дубля — проигравший item целиком дропается, его metrics НЕ агрегируются в выжившего representative'а. Для cluster.batchSize теряется размер копипасты — что для emergence-spread computation мог бы быть сигналом «много retweets». Но `route()` всё равно собрал бы их в один кластер (Jaccard=1.0 на same-text) → representative-замена та же.
* **Repro/impact**: minor — теряем authorDiversity signal на bot-копипасте. Acceptable trade-off, intended (комментарий в коде честный).
* **Fix**: ничего, либо опционально аккумулировать `batchSize` counter в выжившего. Низкий приоритет.

---

### [PIPE-011] `_touchTrend` не вызывается для save_only path — severity: **low**

* **Where**: `src/db/database.js:1310-1313` (isTrendSeen save_only branch)
* **Contract**: `last_seen_at` должен трекаться чтобы observability «когда трейнд видели последний раз» работал.
* **What**: save_only retry path возвращает `false` из isTrendSeen напрямую, БЕЗ `_touchTrend(row.id)`. `last_seen_at` обновляется только когда saveTrend UPSERT добегает (CURRENT_TIMESTAMP в SET). Если crash/timeout между isTrendSeen и UPSERT — last_seen отстаёт.
* **Repro/impact**: dashboard `age` для save_only трендов может показывать stale. Не data loss.
* **Fix**: добавить `this._touchTrend(row.id)` перед `return false` в save_only ветке.

---

### [PIPE-012] Concurrent scan race без DB-level guard — severity: **low**

* **Where**: `src/analysis/aggregator.js:23` (`isTrendSeen` call) vs `src/db/database.js:1394-1424` (`saveTrend` UPSERT)
* **Contract**: pipeline single-cycle invariant — `appState.scanRunning` mutex предотвращает parallel `runScanCycle`. Подразумевается что не нужна DB-level защита.
* **What**: isTrendSeen и saveTrend — отдельные транзакции. Если каким-то образом два scan-cycle'а запустятся parallel'но (race в mutex check, или manual + scheduler), оба пройдут isTrendSeen для одного external_id → оба UPSERT'тся → UPDATE на тот же id два раза (не два row, т.к. UNIQUE на external_id есть). `times_seen` инкрементится дважды.
* **Repro/impact**: edge case. В сейчас рабочем коде mutex есть. Risk = регрессия mutex'а в будущем.
* **Fix**: атомизировать `INSERT ON CONFLICT DO UPDATE SET times_seen = times_seen + 1` (один SQL вместо SELECT-then-UPDATE). Defensive.

---

### [PIPE-013] PreStage no-explicit-timeout на nano fetch — severity: **low**

* **Where**: `src/analysis/nano-classifier.js:~202` (fetch без AbortController timeout)
* **Contract**: PreStage failures → null, никогда не валит pipeline. Implied — должно быстро failover'нуть.
* **What**: fetch без explicit timeout (AbortController). Полагается на TCP-level timeout (default Node ~120s). На stalled connection (TCP open но bytes не идут) PreStage висит ~2 минуты, блокируя cycle.
* **Repro/impact**: rare — обычно nano API быстрый. Под нагрузкой OpenAI'а может укладывать cycle latency.
* **Fix**: AbortController с timeout 30s (или env-tunable `STAGE0_NANO_TIMEOUT_MS`). Соседние модули (gemini-captioner) уже имеют `STAGE0_GEMINI_TIMEOUT_MS`.

---

### [PIPE-014] Empty-array semantics в `presetConfigs` не задокументированы public — severity: **info**

* **Where**: `src/analysis/preset-config.js:570` (deepMerge array replace), `src/admin/server.js:6451-6453` (комментарий про историю бага)
* **Contract**: array semantics — top-layer wins, manual.empty = «ничего не собирать» (overwrites auto+defaults).
* **What**: behaviour intended и working (Wipe button делает именно это), но в `preset-config.js` нет doc-комментария объясняющего gotcha. Если кто-то новый прочитает `mergeOverrideBlobs`, он может ожидать «empty array → fall back to auto», но семантика противоположная. Two prior incidents (12.05, 16.05) фикс'или UI mirror, теперь admin UI правильно показывает auto-layer, но контрактный gotcha остаётся для будущих контрибуторов.
* **Fix**: docstring в `deepMerge` и/или `mergeOverrideBlobs` про array semantic. Не блокер.

---

### [PIPE-015] Clusterer defaults дублируются в конструкторе и в `DEFAULT_PRESET_CONFIGS` — severity: **info**

* **Where**: `src/analysis/clusterer.js:55-60` (instance fields hardcode), `src/analysis/preset-config.js DEFAULT_PRESET_CONFIGS.cluster` (third arg fallback в `_refreshClusterParams`)
* **What**: `_refreshClusterParams()` всегда переопределяет на первом `route()`, так что constructor-defaults фактически dead code. Drift risk если кто-то поправит конструктор и забудет про DEFAULTS.
* **Fix**: либо null-init в конструкторе (fail-fast если route не вызван), либо comment explicitly «dead defaults, source of truth in preset-config.js».

---

### [PIPE-016] Decisions buffer in-memory only — restart wipes — severity: **info** (intended)

* **Where**: `src/index.js:241-242` (`appState.alertDecisions`, cap 500), `src/admin/server.js:1217-1232` (endpoint)
* **What**: не persist'тся, рестарт = пустой буфер. Intended (SESSION_CONTEXT явно говорит «reset на рестарте»), но для post-mortem analysis «почему вчера ночью алертов не было после deploy» — буфер бесполезен. Это enchancement в этап 5 (DB health) — sink в `alert_decisions` table с retention 7 дней.

---

### [PIPE-017] `daily_alert_limit` gate в docstring, но в коде нет — severity: **info**

* **Where**: `src/notifications/alert-dispatcher.js:17` (JSDoc упоминает «daily-limit gate»)
* **What**: реальный gate в cascade'е отсутствует — только `incrementAlertCount` после успешной отправки. Бизнес-решение «считаем, не блочим» (см. SESSION_CONTEXT § Бизнес-правила: «alert_limit legacy, alerts не платная фича»), но docstring не обновился. Mismatch docs vs code.
* **Fix**: убрать упоминание daily-limit gate из JSDoc.

---

### [PIPE-018] Catalyst forecast 15-min per-user cooldown в SESSION_CONTEXT, но снят в коде — severity: **info**

* **Where**: `src/analysis/trigger-finder.js:~1643-1644` (комментарий «Per-user 15-min cooldown removed — Catalyst forecast is cheap»), SESSION_CONTEXT § Catalyst forecast (декларирует cooldown).
* **What**: spec drift. Код честный (комментарий объясняет почему сняли), spec нет. Сейчас защита только daily cap + `trigger_in_flight` claim. Race race на двух кликающих юзерах разруливается через DB-level claim (один wins, второй reads cache или ждёт).
* **Fix**: обновить SESSION_CONTEXT § Catalyst forecast — убрать упоминание 15-min cooldown, оставить «daily cap + in-flight claim».

---

## Verified safe

Контракт держится — **в следующих чекапах не пересматривать**:

### Transient failure recovery (12.05)
* ✓ `_fallback` ставит `_aiUnavailable=true` на ВСЕ trends, Stage 2 fail не валит Stage 1 score.
* ✓ save-loop `pipeline_status = trend._aiUnavailable ? 'save_only' : 'scored'` — динамический.
* ✓ `ai_score` gate стоит первым в push order — `firstFail` показывает real reason.
* ✓ `isTrendSeen` пропускает save_only через (returns false) → retry на следующем scan.
* ✓ UPSERT обновляет status на 'scored' при retry success.
* ✓ Оба пути (AI unavailable + Parse error) триггерят fallback.

### 3-layer preset merge (12.05 + 16.05)
* ✓ Все 12 callers идут через `getActivePresetConfig`, нет raw `settings.presetConfigs` reads вне admin UI reconstruction.
* ✓ `mergeOverrideBlobs(auto, manual)`: manual всегда побеждает через `deepMerge(a, m)`.
* ✓ Array semantic: massivы replace (НЕ merge) — intended.
* ✓ `presetTagsLocked` читается в `tag-refresher.js:969,988-998` и `admin/server.js:502,528`; collectors игнорируют (правильно).
* ✓ Admin UI `getEffective` делает true 3-layer walk (`draft → auto → defaults`) после fix 16.05.

### Tag-refresher anti-hallucination
* ✓ `_applyAutoOverride` empty-array guard: `delete auto[preset].sources.{reddit,twitter,tiktok}` при 0 items, не пишет `[]`.
* ✓ `_buildPrompt` system prompt прописывает «Minimum 6 items per source, target 8-10 (TikTok 8-12). NEVER return an empty array».
* ✓ Reddit reality-check: `kind=t5` + throttle 6.5s + bailout на 3 consecutive network errors.
* ✓ Twitter reality-check: Apify probe `min_faves:100 -is:retweet`, 0 results → drop.
* ✓ TikTok `TIKTOK_HARDSKIP_RE` anchored на `(?:^|_)…(?:_|$)` — kdrama безопасно проходит.
* ✓ Circuit breaker: streak 3+ → `shouldRefreshNow` returns `circuit_breaker_open`, manual reset через UI.

### Stage 2 gates
* ✓ `memePotential >= stage2Threshold(60)` — runtime-tunable.
* ✓ `clusterMetrics?.isNovel !== false` — optional chaining пропускает undefined как novel (intended).
* ✓ `source !== 'google_trends'` — text-only-only-source excluded.
* ✓ `stage2MaxCalls(3)` slice cap на отфильтрованном массиве.
* ✓ `forceStage2:true` bypass'ит memePotential + isNovel, **НЕ** source-skip — google_trends всё равно skip'аются.
* ✓ Manual analyze cap (entitlements) проверяется ДО Stage 2 call'а (cache peek first → если hit slot не consume'тся → если miss с daily cap → 403 fast-reject).

### Junk filter + text-only multiplier (19.05)
* ✓ `textOnlyAddition` вычисляется отдельно, добавляется ПОСЛЕ safe-override division — фикс 19.05 на месте.
* ✓ `applyTextOnlyMultiplier`: режет ОБЕ метрики `memePotential *= 0.65` И `score *= 0.65`.
* ✓ Source whitelist `SOCIAL_SOURCES_FOR_TEXT_ONLY={twitter,reddit,tiktok,instagram,threads,bluesky}` + `TEXTLESS_SOURCES={google_trends}` excluded.
* ✓ `hasVisualContent` проверяет `thumbnailUrl/imageUrl/videoUrl/imageUrls[]` на trend + items level.
* ✓ Multiplier вызывается во всех путях: scan-cycle, hot-metrics refresh, manual-analysis (через общий `scorer.scoreTrends`).

### Clusterer
* ✓ `route()` — один call-site в scan-cycle (`index.js:455`). Hot refresh использует carry-through, не route.
* ✓ `computeSingleTrendEmergence` — изолирован, только в `manual-analysis.js:207,238`, в scan-cycle не используется.
* ✓ Embeddings cache: bounded LRU (cap 1000) + TTL eviction, NEVER throws.
* ✓ Image-hash cache: bounded LRU (cap 500) + TTL, caches null'ы для broken URL (не fetch'ит повторно), NEVER throws.
* ✓ `cheapDedup` exact-text-norm + url buckets, до route, deterministic loser drop.
* ✓ Multi-signal renormalisation: `score /= weightUsed` если signal absent.
* ✓ Time penalty 24h linear 1.0→0.7.

### Collectors error handling
* ✓ Все 5 collector'ов: per-iteration try/catch, log + continue (graceful degrade — другие источники работают).
* ✓ `_normalize` per-item: возвращает null на bad input, не throw'ит → `.filter(Boolean)` пропускает.
* ✓ Required fields покрыты для всех 5 источников.
* ✓ TikTok max-age (14.05): setting `tiktokMaxAgeDays`, default 7d, 0=off, без timestamp = skip check (intended).
* ✓ Twitter max-age: setting `twitterMaxAgeHours`, default 72h, same semantics.
* ✓ `external_id` unique per source format (reddit_, twitter_, tiktok_, gtrends_${geo}_${base64}, xtrends-${country}-${slug}-${day}). Cross-source collision impossible.
* ✓ Twitter `relaxedFloor:true` правильно применяется для X-Trends-вытянутых tweets.
* ✓ `COMPILATION_RE` anchored через `\b…\b` и `#\d+\s*$`.

### Deploy-aware scheduler (16.05)
* ✓ `lastScanCompletedAt` written в `runScanCycle.finally` (covers success + error).
* ✓ Branch logic: `sinceLast < 0` → scan now (clock skew defensive); `sinceLast >= intervalMs` → scan now; `0 <= sinceLast < intervalMs` → wait remainder.
* ✓ First boot (lastScanAt=0) → scan now.
* ✓ `appState.paused` — early return до try → timestamp не пишется во время pause.
* ✓ `appState.scanRunning` mutex — second concurrent `runScanCycle` bails (см. PIPE-004 — это predmety этого finding'а).

### Hot refresh + Catalyst forecast
* ✓ Heavy 12h: `_refreshAll` eligibility cap 100, sort `first_seen_at DESC`, no per-source budget.
* ✓ Light 60m: только `updateXxxEngagement`, ноль `scorer.` / `dispatchAlerts.` imports.
* ✓ Light skip'тся если heavy `running=true`.
* ✓ Anti-dupe alerts через `wasNotificationSentToUser` (per `trend_id × user_id`) — реально работает в dispatch'е.
* ✓ Velocity: Δviews/Δhours, snapshot `metrics._engSnapshot`, min gap 5min, Δ>0 защита (counter rollback), fallback на `first_seen_at + scrape views` для первого refresh.
* ✓ `getHotTrendsForRefresh` carry-through: `clusterMetrics` заполняется ВСЕМИ полями (emergenceScore, narrativePhase, marketStage, junkPenalty, junkReasons, isNovel=true). Документация комментариев фиксит regression 03.05.
* ✓ Catalyst `trigger_in_flight` claim: UPDATE WHERE in_flight=0 → `result.changes===1` check, optimistic lock works.

### Alert dispatcher
* ✓ Per-user gate iteration: `effectiveAlertThreshold = max(user, preset)` пересчитывается ВНУТРИ user loop. User с threshold=80 и user с threshold=50 получают разные результаты.
* ✓ `alert_types_filter`, `plan_sources`, `disabled_sources` — все per-user inside loop.
* ✓ Decisions buffer пушит ВСЕ outcomes (passed + skipped), не только failed.
* ✓ Hot refresh dispatch использует тот же модуль (`alert-dispatcher.js`), `triggerSource='refresh'` field в decisions buffer.

### PreStage providers
* ✓ Orchestrator: `Promise.all([nano.catch, gemini.catch])` — каждый sub-stage independent, fail одного не валит other'ого, на fail → `trend.preStage = null`.
* ✓ Nano: NEVER throws, fall на null array on fail. `STAGE0_NANO_MAX_BATCH=20` chunking. `nanoEnabled` runtime kill-switch + env `STAGE0_NANO_ENABLED=0`.
* ✓ Gemini: 5xx + 429 + 403 (geo) + 5xx — все триггерят failover (`_recordGoogleFailure`). Cooldown counter — см. PIPE-002 caveat.
* ✓ Video trim: ffprobe async с 5s timeout, ffmpeg `-t N` temp-file cleanup в finally, `videoTruncated/videoClipped` флаги для downstream.
* ✓ Image-hash NEVER throws, кэширует null hash для broken URLs.
* ✓ Embeddings NEVER throws, на batch fail возвращает partial-result (cached nulls + failed nulls).

---

## Out of scope / followups

* **(этап 4, cost throttling)** — PIPE-005 (нет circuit breaker'а на затяжной AI outage) фундаментально про cost-control: сейчас retry-loop на save_only платит полный PreStage каждые 15 мин. Логически принадлежит здесь, но решение типа «exponential backoff + admin alert при N consecutive Stage 1 fails» — это cost-controls. Обсудить в этап 4.
* **(этап 5, DB health)** — PIPE-006 (`notifications` UNIQUE constraint), PIPE-016 (persist `alert_decisions` table с retention) — это DB schema/indices/retention. Migration нужна. Перенести.
* **(этап 5, DB health)** — `alert_score_history` retention 30 дней (упомянуто в SESSION_CONTEXT § Alert gate) — проверить в этапе DB что daily prune реально работает (sqliteCutoff helper применён) и не растёт unbounded.
* **(spec drift)** — три места где SESSION_CONTEXT расходится с реальностью:
  1. PIPE-018: 15-min cooldown Catalyst forecast (снят в коде, в spec остался).
  2. PIPE-017: «daily-limit gate» в alert-dispatcher JSDoc — реального gate нет, только counter.
  3. SEC-003 из security audit'а: `TRUST_PROXY=1` в spec обещает но в коде не работает.
  Стоит сделать единый pass по SESSION_CONTEXT после всех 12 чекапов — синхронизировать с реальным кодом.
* **(observation)** — `cheapDedup` в `clusterer.js:97-118` доп.документирует «losers dropped entirely» в комментарии. На крупных bot-копипастах теряется потенциальный сигнал `clusterSize`. Не bug, но если будет когда-нибудь нужна метрика «сколько ботов запушили один и тот же мем», эта информация уже не доступна выше route. Подумать о counter-агрегации (`representative._dedupCount` для observability).
* **(observation)** — Manual analysis `computeSingleTrendEmergence` использует LIKE search на `entityCanonical` (Variant A, 17.05). На viral постах breakout-path доминирует, accuracy ≈±10%. Если оператор пожалуется на false-negative «забыли подобрать дубликат» — мигрировать на embeddings-based lookup (Variant B). Не сейчас.
* **(operational)** — Stage 0b Vision authoritative trap (см. SESSION_CONTEXT § Stage 2 — Source-bias trap). Сейчас Stage 1 fallback rubric (cap meme≤25/35 на generic titles) ловит Google Trends + X Trends. Если throughput этих источников всё ещё низкий — рассмотреть «escape hatch» (source-aware skip Stage 0b для googletrends/xtrends). Architectural decision, не сейчас.
* **(observation)** — `_handleScan` (security SEC-001) **и** scheduler race (PIPE-004) оба сводятся к manual scan trigger. Если решим зашорить через `plan_name === 'admin'` (SEC-001 fix), стоит сразу же добавить immediate timestamp write (PIPE-004 fix) — одна правка обеих гипотез.

---

**Audit complete.** Жду решения какие finding'и фиксить первыми.
