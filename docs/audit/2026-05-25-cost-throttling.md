# Cost & throttling audit — 2026-05-25

**Scope**: четвёртый этап. Контроль расходов и throttling на всех уровнях — LLM provider quotas, per-user caps, per-stage budgets, Apify токены, broadcast limits, refresh cycles, observability. **Не покрыто** (другие этапы): security boundaries (1 — done), pipeline correctness (2 — done), plan tiers privilege side (3 — done), DB schema/retention (5), UX (6), admin UI (7), TG message format (8).

**Method**: 10 параллельных агентов (sonnet для cap enforcement / circuit breaker, haiku для остальных) + cap-map самосбор + cross-reference с existing audits (SEC/PIPE/BILL). Ничего в коде не менялось.

---

## Cap map

Полный каталог caps в системе. Persistence column: **mem** = process-global Map (restart wipes), **DB** = persisted в settings/table, **mem+DB** = hydrated на boot но primary in-memory.

| Cap | Where | Scope | Value | Persistence | Enforce point | Reset cadence |
|---|---|---|---|---|---|---|
| `manualAnalyze` hits | `dashboard/server.js:440`, `telegram.js:_manualAnalysisHits` | per-userId | 5/test, 100/pro, -1/admin per day | **mem** | **before** LLM call | rolling 24h + restart |
| `catalyst` hits | `dashboard/server.js:441`, `telegram.js:_catalystHits` | per-userId | 5/test, 100/pro, -1/admin per day | **mem** | **before** Grok call | rolling 24h + restart |
| `xAnalysis` hits | `telegram.js:_xAnalysisHits` | per-chatId | 10/test, -1/pro+admin per day | **mem** | **before** Apify call | rolling 24h + restart |
| `historyHours` | `entitlements.js` + `_handleTrends/Stats` | per-user (plan-derived) | 72h/free, -1/test+pro+admin | code | request param clamp | n/a |
| `stage2MaxCalls` | `scorer.js:662, 705` | per scan-cycle | 3 (DB-tunable via setting) | DB setting | `metrics.stage2Calls++` на **attempt**, slice(0,N) | per-cycle reset |
| `stage2Threshold` | `scorer.js` | per scan-cycle | 60 (memePotential ≥) | DB setting | gate before Stage 2 | n/a |
| `XAI_STAGE2_MAX_RESULTS` | `scorer.js` | per Stage 2 call | 5 sources / x_search | env | passed в API request | n/a |
| `XAI_STAGE2_MAX_TOOL_CALLS` | `scorer.js` | per Stage 2 call | 2 consecutive x_search | env | passed в API request | n/a |
| `XAI_STAGE2_LOOKBACK_HOURS` | `scorer.js` | per Stage 2 call | 48h | env | `from_date` filter | n/a |
| `STAGE0_NANO_MAX_BATCH` | `nano-classifier.js` | per nano call | 20 trends/batch | env | array chunking | n/a |
| `STAGE0_GOOGLE_COOLDOWN_FAILURES` | `gemini-captioner.js:1090-1110` | global counter | 3 consecutive | **mem** | failover trigger | success-after-cooldown OR restart |
| `STAGE0_GOOGLE_COOLDOWN_MS` | `gemini-captioner.js` | global timer | 300_000 (5min) | **mem** | failover window | timer expires |
| `STAGE0_VIDEO_MAX_SEC` / `_MB` | `gemini-captioner.js` | per video | 60s / 40MB | env | ffmpeg trim | n/a |
| `STAGE0_IMAGE_MAX_MB` | `gemini-captioner.js` | per image | 5MB | env | abort fetch | n/a |
| `STAGE0_GEMINI_TIMEOUT_MS` | `gemini-captioner.js` | per call | 90_000 (90s) | env | AbortController | n/a |
| `STAGE0_DOWNLOAD_TIMEOUT_MS` | `gemini-captioner.js` | per fetch | 15_000 (15s) | env | AbortController | n/a |
| `STAGE0_GEMINI_CACHE_TTL_SEC` | `gemini-captioner.js` | URL→caption | 300 (5min) | **mem** | LRU + TTL | TTL + restart |
| `EMBEDDING_CACHE_TTL_MS` | `embeddings.js` | hash→vector | 300_000 (5min, **drift** vs spec 30min) | **mem** | LRU + TTL | TTL + restart |
| `EMBEDDING_CACHE_CAP` | `embeddings.js` | global | 1000 entries | **mem** | LRU eviction | n/a |
| `IMAGE_HASH_CACHE_TTL_MS` | `image-hash.js` | URL→hash | 900_000 (15min) | **mem** | LRU + TTL | TTL + restart |
| `IMAGE_HASH_CACHE_CAP` | `image-hash.js` | global | 500 entries | **mem** | LRU eviction | n/a |
| `IMAGE_HASH_CONCURRENCY` | `image-hash.js` | global | 4 workers | env | semaphore | n/a |
| `IMAGE_HASH_MAX_BYTES` | `image-hash.js` | per image | 2_097_152 (2MB) | env | abort fetch | n/a |
| Tweet preview cache | `dashboard/server.js:152` | URL→preview | 500 entries, 5min TTL (200) / 30s (4xx) | **mem** | LRU+TTL | TTL + restart |
| Reddit preview cache | `dashboard/server.js:218` | URL→preview | 500 entries, 5min/30s | **mem** | LRU+TTL | TTL + restart |
| `RESULT_CACHE` (manual-analysis) | `manual-analysis.js:31-60` | URL→result | 200 entries, 6h TTL (spec drift: spec=1h) | **mem** | LRU+TTL, key=URL only (cross-user) | TTL + restart |
| `_authVerifyAttempts` | `dashboard/server.js:449` | per-sessionId | 5/15min | **mem** | sliding window sweep | sweep + restart |
| `_authInitiateAttempts` | `dashboard/server.js:463` | per-IP (shared per nginx — SEC-003) | 10/5min | **mem** | sliding window sweep | sweep + restart |
| Alert scheduler cooldown | `alert-scheduler.js:41` | per-chatId | 60_000ms (1msg/min/chat) | **mem** | queue throttle | n/a |
| `appState.alertDecisions` | `index.js:241-242` | global ring buffer | 500 entries | **mem** | push at gate-loop end | restart wipes |
| `TAG_REFRESH_COOLDOWN_DAYS` | `tag-refresher.js` | global | 2 days | DB setting | cooldown check | settingsLastRunAt update |
| `TAG_REFRESH_FORCE_COOLDOWN_HOURS` | `tag-refresher.js:163-166` | global force button | 24h | env | `canForceNow()` backend check | timer expires |
| `tagAutoRefreshFailureStreak` | `tag-refresher.js:138, 227-230` | global | 3 consecutive → CB open | **DB** | streak check before refresh | success resets to 0 |
| Hot refresh heavy cap | `hot-metrics.js:220-224` | per heavy cycle | 100 trends max | code | SQL LIMIT | n/a |
| Hot refresh light cap | `hot-metrics.js:477-570` | per light cycle | 200 trends, concurrency=5 | code | semaphore | n/a |
| TG bot scheduler | `alert-scheduler.js` | per-chatId | natural 1msg/min throttle | **mem** | enqueue ordering | n/a |
| `MAX_BODY_BYTES` | `dashboard/server.js:29` | per HTTP request | 16KB | code | abort on stream | n/a |
| `MAX_BODY_BYTES` (admin) | `admin/server.js:78` | per HTTP request | 32KB | code | abort on stream | n/a |

**Persistence buckets**:
- **All cost-relevant caps (manualAnalyze, catalyst, xAnalysis)** — in-memory only → BILL-007 extension в COST-003.
- **All auth rate-limits** — in-memory only → не cost burn, anti-brute-force posture OK (restart admin-only).
- **Only `tagAutoRefreshFailureStreak` и `tagAutoRefreshLastRunAt`** persist в DB settings.

---

## Cost surface map

Где LLM/Apify call'ы происходят, провайдер, rough $$$ per invocation. Числа из SESSION_CONTEXT + WORKLOG estimates.

| Surface | Provider | $/invocation | Frequency | Monthly est | Notes |
|---|---|---|---|---|---|
| **Stage 1 batch** (scan-cycle) | OpenAI gpt-5.4-mini default (или Grok / Gemini selectable) | ~$0.005-0.05/batch | every scan (15min default) → ~96/day | ~$15-50 | runtime-tunable, low-cost path |
| **Stage 0a nano** | OpenAI gpt-5.4-nano | ~$0.001/trend (batch 20) | every scan | ~$3-10 | default OFF since 09.05 (panic kill-switch + admin toggle) |
| **Stage 0b Gemini captioner** | Google AI direct → OpenRouter fallback | ~$0.004/trend (video), ~$0.002 (image) | every scan, ~30 trends/cycle | ~$50-70 | dominates PreStage cost |
| **Stage 2 deep dive** | xAI Grok `grok-4-1-fast-non-reasoning` + x_search | ~$0.053/call (x_search $5/1000 sources × 5 max + Grok reasoning) | **cap=3/cycle** × 96 cycles = 288/day | **~$153** | most expensive, capped |
| **Catalyst forecast** | xAI Grok `grok-4-1-fast-reasoning` + optional x_search | ~$0.05-0.10/call | ~5-50/day on-demand | ~$10-150 | per-user daily cap |
| **Manual analysis** | PreStage + forced Stage 2 (Grok) | ~$0.06/call | bounded by manualAnalyze cap | ~$10-50 | cap=5/100/day per plan |
| **Tag-refresher** | xAI Grok grok-4.3 + x_search × ~9 calls | ~$0.045/preset × 5 = $0.22/refresh | 2-day cooldown → ~15/month | ~$3 | $1.25/M in + $2.50/M out tokens computed |
| **Hot refresh heavy** | Stage 1 (Gemini) + Stage 2 (Grok, capped 3) | ~$0.65/cycle worst-case | 12h cycle → 2/day | ~$39 | uses same Stage 2 cap |
| **Hot refresh light** | fxtwitter + reddit.json (free) | $0 | 60min × 24h | **$0** | metrics only, NO LLM |
| **Reality-check (tag-refresh)** | Apify Twitter probe | ~$0.001/new group × ~5-8 new/preset | ~10/refresh × 15/month = ~150/month | ~$0.15 | additive to Grok spend |
| **Reddit reality-check** | Reddit /about.json public API | $0 | ~30/refresh | $0 | rate-limit 10/min, 6.5s throttle |
| **TikTok trending hashtags** | Apify clockworks trends scraper | $0.004/run | 12h cycle → 2/day | ~$4.32 | live-discovery, fallback to hardcoded |
| **Collectors** (Reddit/Twitter/TikTok/Google/X-Trends) | Apify per-actor | varies ($0.15-3.00 / 1000 results) | per scan | majority of Apify spend | per-actor token isolation |
| **Tweet/Reddit hover preview** | fxtwitter / reddit.json (free) | $0 direct | per-hover (✕500 cache) | **$0 direct**, indirect cost = IP-ban risk → outage |
| **Embeddings** | OpenAI text-embedding-3-small | $0.02/1M tokens | per-cluster call, cached | <$1 | effectively free |
| **Telegram API** | TG sendMessage / sendPhoto / sendVideo | $0 (free) | per alert | $0 | rate-limit 30/sec global, 1/sec per chat |

**Rough total**: ~$280-350/month (без stress).

**Worst-case spike vectors** (если cap fail):
- `/api/scan` triggered loop → ~$0.65/cycle uncapped (covered by **cross-audit triple**).
- Manual-analyze concurrent race × 100 pro users × 100 cap → +20% bypass = ~$1-5/day extra (COST-001).
- Stuck-fallback OpenRouter → unknown pricing delta vs Google (COST-006).
- Hover preview spam by free user → Reddit IP-ban → 24h outage (COST-004).

---

## Summary

**Counts**: 0 critical · 4 high · 8 medium · 3 low · 2 info · **17 findings total** + 0 new spec drift items (one re-confirmation of existing PIPE-007 + BILL SD-5).

База держится: cap enforcement действительно стоит **до** LLM call'а во всех 3 hot paths (manualAnalyze + catalyst + xAnalysis), Stage 2 cap=3 + threshold=60 ограничивают самый дорогой провайдер (~$153/мес правильно calibrated), tag-refresher отслеживает USD per call ($1.25/M in + $2.50/M out), light hot refresh **действительно** ноль-LLM (zero `scorer.` imports), TG broadcast scheduler даёт natural 60-sec per-chat throttle → TG rate-limit не пробивается, force-refresh за 24h backend-cooldown, Reddit reality-check бесплатный с 6.5s throttle.

Слабые места: 4 high — **race condition** на двух cost-critical caps (concurrent parallel manual/catalyst → 20-40% bypass), **catalyst hits restart-reset** (BILL-007 расширение на второй cap), **hover preview без per-user rate-limit** (free user может ban Reddit IP за нас curl-loop'ом, 24h outage). Плюс **observability gap**: cost tracking есть в коде (`scorer.lastMetrics` собирает tokens) но не пробрасывается в admin `/api/pipeline`, нет per-cycle cost log, нет spike alerts → cost drift невидим.

**Top-3 worst**:
1. **COST-001/002** (high) — concurrent race на manual + catalyst caps (20-40% bypass + dashboard/TG key mismatch для catalyst даёт 2× effective cap).
2. **COST-004** (high) — hover preview без per-user rate-limit → free user может ban наш IP в Reddit за минуту curl-loop'ом → 24h outage всего сайта.
3. **COST-003** (high) — catalyst (+manual+xAnalysis) hits Map restart-reset, extends BILL-007 на все 3 cost-critical cap'а (а не только manualAnalyze который BILL-007 cover'ил).

---

## Findings

### [COST-001] Concurrent race на manual-analysis cap — severity: **high**

* **Where**: `src/dashboard/server.js:1961-1970`, `src/notifications/telegram.js:1154-1169`
* **Cap layer**: per-user, daily
* **What**: pattern — `get(...)` → `filter(...)` → `if (length >= cap)` → `push(now)` → `set(...)`. Между check и set нет atomic mutex. Две параллельные `/api/manual-analysis` от одного user'а (dashboard tab + TG bot одновременно, или два tab'а) — оба видят `length=4` (cap=5), оба проходят check, оба `push` → effective count = 6, cap bypass.
* **Exploit cost**: на pro (cap=100) — 100 parallel = ~120 actual = +20% spend = ~$1-2/day. На test (cap=5) — каждое window 5→6 = +20% spend per session × $0.06 = ~$0.10 burn / session. Sustained attack: $1-5/day.
* **Repro**: `Promise.all([fetch('/api/manual-analysis', {url:'A'}), fetch('/api/manual-analysis', {url:'B'})])` с близкими timestamp'ами. С каждым success Map стабилизируется на одной из двух values (last-write-wins).
* **Fix**: per-user async mutex (`p-limit({user})`), или atomic check-and-set helper (locking helper в-памяти), или DB-level counter с `UPDATE ... SET count = count + 1 WHERE count < cap` и `changes === 1` check. Persistence-level: см. COST-003 — лучше совместить с DB-backed persistence сразу.

---

### [COST-002] Concurrent race на catalyst cap + key type mismatch dashboard/TG — severity: **high**

* **Where**: `src/dashboard/server.js:1662-1667` (numeric userId), `src/notifications/telegram.js:1853` (`String(chatId)`)
* **Cap layer**: per-user, daily
* **What**: два сцепленных issue:
  1. Тот же concurrent race pattern что COST-001 на `_catalystHits` Map.
  2. **Ключ Map split** — dashboard использует numeric `userId`, TG bot использует `String(chatId)`. Это **разные Map keys** (`Map.get(123) !== Map.get('123')` для primitives — numbers и strings не равны как keys). User, который триггерит catalyst в dashboard И через TG бот → два independent counters. Effectively **2× cap**.
* **Exploit cost**: pro plan (cap=100) effectively 200 calls/day через cross-surface usage → +$5-10/day per power user. Test plan (cap=5) — effectively 10/day → +$0.25-0.50/user.
* **Repro**: pro user тратит 100 catalyst через dashboard. Открывает TG bot, жмёт «🔮 Catalyst» — counter дёргает `_catalystHits.get('123')` (TG side) — пусто (там был `123` numeric). Пропускает ещё 100 calls.
* **Fix**: 
  1. Стандартизировать key в **обоих** местах на `String(userId)` или `String(chatId)`. Это даёт shared counter cross-surface.
  2. Race — тот же mutex-fix что COST-001.
  3. Persistence — overlaps с COST-003.

---

### [COST-003] Cost-critical caps in-memory only, restart wipes — extends BILL-007 — severity: **high**

* **Where**: `dashboard/server.js:440-441` (`_manualAnalysisHits`, `_catalystHits`), `telegram.js` (those + `_xAnalysisHits`). **BILL-007 уже flag'нул это** для manualAnalyze, расширение здесь — на **все 3 cost-critical caps**.
* **Cap layer**: per-user, daily
* **What**: при restart процесса (deploy.ps1, OOM, manual restart) — Maps очищаются → юзер с уже потраченными 4/5 manualAnalyze + 3/5 catalyst + 8/10 xAnalysis получает обнулённый счётчик в тот же UTC день → может потратить ещё 5+5+10 hits = effectively ×2 cap.
* **Exploit cost**: на test plan (cap=5/5/10) каждый deploy = ×2 spend для активного юзера = ~$0.50-1/user/deploy. WORKLOG показывает ~5-10 deploys/week → multiplied across N test users = ~$5-50/week burn.
* **Repro**: test user тратит 4 manualAnalyze, 3 catalyst, 8 xAnalysis. `deploy.ps1` → новый container → Maps пустые → ещё 5+5+10 hits проходят сразу.
* **Fix**: persist в DB table `feature_usage_log(chat_id, feature, ts)` или `user_daily_counters(chat_id, feature, day_iso, count)`. На boot — hydrate Maps из last 24h (или просто SELECT COUNT WHERE ts > NOW-1day на check). Retention 30 days. Migration минимальная.

---

### [COST-004] Hover preview без per-user rate-limit → Reddit IP-ban risk — severity: **high**

* **Where**: `src/dashboard/server.js:1333-1380` (`_handleTweetPreview`), `:1389-1426` (`_handleRedditPreview`)
* **Cap layer**: per-user (отсутствует) → per-IP (отсутствует) → global Reddit/fxtwitter
* **What**: оба endpoint'а требуют auth (`req.user`), но НЕ per-user / per-IP rate-limit. Free user (BILL-001 — paywall bypass там же) или legit user может через curl loop спамить `/api/tweet-preview?id=X` сотнями раз в секунду. Upstream cache LRU 500 + 5min TTL: trending tweet хитается, но **unique IDs** (атакующий шлёт different IDs из бесконечного pool tweet IDs) каждый bypass'ит cache → real fetch к Reddit.json / fxtwitter.
* **Exploit cost** (worst-case):
  - Reddit unauth rate-limit: 50 req/min per IP. 1 атакующий с curl loop = 100+ req/sec = mountain past 50/min → Reddit IP-ban на 15-60 минут.
  - Когда наш server IP ban'нут в Reddit → ВСЕ user'ы dashboard'а теряют preview + Reddit collector breaks + tag-refresher reality-check breaks → effectively 24h degraded site. Customer impact ~$1000+ revenue.
  - fxtwitter unspecified rate-limit, может ban'нуть.
* **Repro**: `for i in $(seq 1 1000); do curl -H "Authorization: Bearer <free-token>" "https://catalystparser.io/api/reddit-preview?id=random$i" & done`.
* **Fix**:
  - Per-user rate-limit на preview endpoints (например `30 calls / 5 min per user`) через тот же sliding window helper.
  - Parse `Retry-After` header от upstream 429 и кешировать с backoff (не просто 30s blanket).
  - Long-term: shared cache (Redis) чтобы cross-instance hit rate higher.

---

### [COST-005] OpenAI/Grok cost не вычисляется в $ — только tokens — severity: **medium**

* **Where**: `src/analysis/scorer.js:724-732` (tokens logged), `src/analysis/nano-classifier.js:242-247` (tokens logged), `src/refresh/tag-refresher.js:62-64, 515` (**уникально вычисляет USD**)
* **Cap layer**: observability
* **What**: scorer.js логирует raw tokens (`stage1_in/out`, `stage2_in/out`), не считает USD. Tag-refresher делает правильно — `costUsd = (in*$1.25 + out*$2.50)/1M` — почему не везде? Stage 2 / Catalyst forecast / nano-classifier / Stage 0b — все без USD. Невозможно «сколько мы потратили сегодня на Stage 2» через grep логов.
* **Exploit cost**: не direct burn, но slow detection. Если Stage 2 spike до 10× — невидим до конца месяца / billing alert от провайдера.
* **Fix**: вынести pricing-table в `src/billing/pricing.js` (per-model `inputPerM`/`outputPerM`), переиспользовать в scorer.lastMetrics. Логи cycle summary: `[scan] stage1=$X.XX stage2=$Y.YY total=$Z.ZZ`.

---

### [COST-006] Google → OpenRouter stuck-fallback без detection — severity: **medium**

* **Where**: `src/analysis/gemini-captioner.js:1090-1110` (cooldown), `:457-463` (failover)
* **Cap layer**: per-provider routing
* **What**: cooldown circuit правильно failover'ит на OpenRouter после 3 fails Google. Но: после cooldown expires (5min), **natural** next call идёт на Google → если Google forever-down (geo block, key revoked, billing dispute) — counter forever bumps, мы forever на OpenRouter. **Нет proactive Google healthcheck** (ping-only request) и нет alert «OpenRouter > X% of last hour calls». **Связано с PIPE-002** (counter не reset на partial success — там был ровно тот же модуль).
* **Cost angle**: OpenRouter image-only (не video) → video trends теряют audio/motion сигналы → quality loss. Direct $$ delta может быть в любую сторону (OpenRouter pricing разный per-model — может быть **дороже**). Без detection — silent shift.
* **Fix**: 
  - Logger при cooldown trigger («Google cooldown opened, switching to OpenRouter»).
  - Periodic ping (раз в час) на Google `models.list` (cheap call) — если success при cooldown active, reset counter.
  - Alert если `_googleCooldownUntil > now()` дольше 1h.

---

### [COST-007] Stage 2 cap consumed на attempt, не на success — severity: **medium**

* **Where**: `src/analysis/scorer.js:705` (`metrics.stage2Calls++` ДО try)
* **Cap layer**: per scan-cycle
* **What**: цикл по `stage2Candidates`. Counter инкрементится **до** `_stage2DeepDive` try. На 3 failed Stage 2 (Grok 5xx, parse error, network) — cap consumed, оставшиеся valid trends не получат Stage 2 этого цикла. Pipeline audit PIPE уже flag'нул как low — здесь cost angle: failed Stage 2 calls **не платные** (Grok 5xx без billing), но мы лишились retry surface для valid trends.
* **Exploit cost**: indirect — несколько fail'нувших Stage 2 в подряд → top-meme trends ждут до следующего scan (15 мин). Может пропустить hot trends. Не direct $.
* **Fix**: переместить `metrics.stage2Calls++` **внутрь** try-блока, после успешного return. Или вести два counter'а (`stage2Attempts`, `stage2Successes`) для observability.

---

### [COST-008] Gemini permanent-down тратит download bytes / 8s+15s timeouts forever (CB-002) — severity: **medium**

* **Where**: `src/analysis/gemini-captioner.js:1090-1110`, `:717-733`
* **Cap layer**: per-provider
* **What**: scenario где Google permanently unhealthy:
  1. 3 fails → 5min cooldown → OpenRouter.
  2. 5min later → `_canUseGoogle()` true → одна попытка → fail → counter=1.
  3. Через ~14 trends (worker pool 4, cache hits skipped) counter снова 3 → ещё 5min cooldown.
  4. **Forever**: ~3 wasted Google attempts каждые 5 минут.
  Каждый attempt = HEAD probe (8s timeout) + download (15s timeout) + Gemini call (90s timeout). Wasted bandwidth + worker time, не direct $ (Google не billет на error).
* **Cost angle**: minor $$, but signal quality loss — long stuck Google = no video captioning (OpenRouter image-only) = downgraded narrative scoring.
* **Fix**: same as COST-006 — proactive healthcheck. Если cheap probe success, reset counter; иначе extend cooldown exponentially (5min → 30min → 2h → 12h).

---

### [COST-009] No per-cycle cost log в main scan — severity: **medium**

* **Where**: `src/index.js:582` — log line `Cycle complete in {elapsed}s`
* **Cap layer**: observability
* **What**: cycle-end log не содержит cost/token summary. `scorer.lastMetrics` собирает `stage1InputTokens`, `stage2InputTokens`, etc, но **не пробрасывается** в `appState.cycleInProgress` или cycle-end log. Cost drift невидим в логах. Tag-refresher делает правильно (log line с `cost=$X.XX`), main scan нет.
* **Fix**: после `runScanCycle()` → log `[scan] trends=N stage1=X stage2=Y, $stage1=X.XX $stage2=Y.YY total=$Z.ZZ`. Использовать pricing table из COST-005.

---

### [COST-010] Admin `/api/pipeline` без cost/token metrics — severity: **medium**

* **Where**: `src/dashboard/server.js:1441` (`_handlePipeline`), `appState.cycleInProgress` / `lastCycle` payloads
* **Cap layer**: observability
* **What**: endpoint возвращает stage counts (collect, dedupe, cluster, prestage, stage1, stage2, save, alerts), models used (stage1Model, stage2Model), но **не tokens** и **не $**. Admin SPA StatusBar показывает «Live — Stage 1...» с timing, но не «$0.05 spent this cycle». scorer.lastMetrics существует — нужно просто пробросить.
* **Fix**: добавить в `appState.cycleInProgress` поля `stage1Tokens`, `stage2Tokens`, `geminiCalls`, `nanoCalls` — copy из `scorer.lastMetrics` после сycle. UI patch — отдельный finding для этапа 6/7.

---

### [COST-011] Tweet/Reddit preview cache LRU 500 + 5min TTL короткий для trending traffic — severity: **medium**

* **Where**: `src/dashboard/server.js:152-168` (tweet), `:218-233` (reddit)
* **Cap layer**: global cache effectiveness
* **What**: cap 500 entries + 5min TTL — на bursty hover traffic (1 trending tweet × 1000 hovers/час от 50 users) теоретически OK (500 уникальных tweets хватит на 5min window). Но **uniqueness** ID — если user'ы scrolling много feed → каждый tweet hover'ится 1-2 раза → cache thrashing → реальный fetch к upstream каждый раз. Связано с COST-004 — без caching больше upstream rate-limit risk.
* **Fix**: bump cap до 2000-5000 entries (memory cheap), TTL до 15-30 min (engagement данные не критично-свежие для hover). Связать с COST-013 observability — без hit ratio tune'нуть невозможно.

---

### [COST-012] Engagement update side-effect через preview spam — free refresh — severity: **medium**

* **Where**: `src/dashboard/server.js:1368-1372, 1414-1418`, `src/db/database.js:1534-1632` (`updateTwitterEngagement`/`updateRedditEngagement`)
* **Cap layer**: DB write rate
* **What**: каждый успешный preview pull → `db.updateTwitterEngagement` / `updateRedditEngagement` обновляет `raw_metrics.views/likes/...` + recomputes velocity. Free user spam'ит preview → DB обновляется на random trends 100×/час → light hot refresh (раз в 60min) делает ту же работу — но preview spam даёт free user effective «hot refresh on demand».
* **Cost angle**: zero direct $ (upstream APIs free). Но: cap'а на «как часто one trend updated» нет (только 5min min-gap для velocity computation). DB write load увеличивается на bursty preview, не critical.
* **Fix**: чисто optional — `last_engagement_update_at` colonne + skip update если < N min. Низкий приоритет.

---

### [COST-013] No cache hit ratio observability (preview + manual-analysis) — severity: **low**

* **Where**: `dashboard/server.js:152-233` (preview), `manual-analysis.js:140-173` (RESULT_CACHE)
* **Cap layer**: observability
* **What**: preview cache не логирует hits/misses, не exposes в admin panel. Manual-analysis логирует hits через `logger.info` но не misses, не aggregate count. Невозможно tune TTL/cap без data — увеличить TTL может сэкономить cost, но не знаем где boundary.
* **Fix**: counter `cacheHits` / `cacheMisses` в `appState`, ratio в `/api/pipeline`. Простое улучшение.

---

### [COST-014] Tag-refresher per-preset linear cost scaling, no cap — severity: **low**

* **Where**: `src/refresh/tag-refresher.js` (loop по 5 presets)
* **Cap layer**: per-refresh budget
* **What**: сейчас 5 presets × ~$0.045 = $0.22/refresh. Если бизнес добавит 6-й или 10-й preset — cost линейно scale, no hard ceiling. Tag-refresher уже трекает per-call `costUsd` — можно accumulator-cap'нуть.
* **Fix**: optional env `TAG_REFRESH_MAX_COST_USD=0.50` — стоп цикл if `totalCost > cap`. Defensive. Низкий приоритет пока presets 5.

---

### [COST-015] Hot refresh light concurrency hardcoded =5 — severity: **low**

* **Where**: `src/refresh/hot-metrics.js:477-570` (`runLightCycle`)
* **Cap layer**: rate-limit к upstream
* **What**: concurrency 5 workers hardcoded — не env knob. Если Reddit поднимет unauth rate-limit (либо ужесточит), нужно бистро задросселить — сейчас требует redeploy. Также 200 trends × 5 workers ~= 40 sec full sweep (fine), но не явно tunable.
* **Fix**: env `HOT_REFRESH_LIGHT_CONCURRENCY=5` + DB setting если надо runtime. Низкий приоритет.

---

### [COST-016] `notifications` table без cleanup retention — severity: **info**

* **Where**: `src/db/schema.sql:74-86`
* **Cap layer**: DB storage
* **What**: rows аккумулируются (per `trend_id × channel × user_id`). No DELETE WHERE ts < N days. На long-running prod table будет расти. Не cost burn (sqlite storage cheap), но scan performance impact eventually + связано с PIPE-006 (UNIQUE constraint там тоже missing).
* **Fix**: добавить cleanup в `index.js` maintenance loop: `DELETE FROM notifications WHERE created_at < datetime('now', '-30 days')`. Связан с этапом 5 (DB health).

---

### [COST-017] Tag-refresher costUsd теряется при JSON parse fail — severity: **info**

* **Where**: `src/refresh/tag-refresher.js` (audit log)
* **Cap layer**: cost accounting
* **What**: при 200-ответе с invalid JSON Grok'а — `_callXaiResponses` парсит `usage` ok, `_parseJson` падает → costUsd теряется (не в `totalCost`). Минор accounting bug — мы заплатили Grok'у $0.05 но в audit log $0. Не cost burn, observability noise.
* **Fix**: вынести `costUsd` snapshot до `_parseJson` call.

---

## Verified safe

* ✓ **Manual-analysis cap проверяется ДО `runManualAnalysis`/`scorer.scoreTrends`** на обоих surfaces (dashboard + TG bot). Cache-hit через `peekManualAnalysisCache` non-mutating не consumes slot — intentional cost saving.
* ✓ **Catalyst forecast cap проверяется ДО Grok call** + `trigger_in_flight` DB claim защищает от parallel calls на одну trend.
* ✓ **xAnalysis cap проверяется ДО Apify call** в bot.
* ✓ **historyHours backend clamp** `Math.min(requestedHours, planHistoryHours)` — free can't bypass.
* ✓ **stage2MaxCalls slice** `stage1Results.slice(0, 3)` — physical cap на Stage 2 per cycle.
* ✓ **Stage 2 deep dive 1.5s delay между calls** — `setTimeout(r, 1500)` — natural rate-limit к Grok.
* ✓ **Stage 1 batch fallback (PIPE-005)** не делает immediate retry — `_fallback` ставит флаг, retry на след. scan.
* ✓ **Tag-refresher cost computation** через USD formula `(in*$1.25 + out*$2.50)/1M`. Persisted в `tag_refresh_history.cost_usd`.
* ✓ **Tag-refresher force button** backend-cooldown 24h (`canForceNow()`). Admin не может spam force через curl.
* ✓ **Tag-refresher circuit breaker** at 3 consecutive failures → blocks until manual reset. Cost burn capped ~$0.75 (3 attempts × $0.22).
* ✓ **Reality-check Apify probe** только на NEW keyword groups, skip existing (защита от full-refresh full-spend).
* ✓ **Reddit reality-check** через free public API + 6.5s throttle + bailout 3 net errors.
* ✓ **Hot refresh heavy** `LIMIT 100, sorted by first_seen_at DESC, minMeme≥50` — bounded.
* ✓ **Hot refresh light** zero `scorer.` imports, zero `dispatchAlerts` — verified pipe audit + cost audit.
* ✓ **Apify collectors** per-actor token isolation. One actor key leak ≠ full Apify pool.
* ✓ **PreStage `Promise.all` partial fail** — each Gemini trend independent worker (concurrency 4), nano chunk одна HTTP request (all-or-nothing, no waste).
* ✓ **TG bot scheduler** natural 60-sec per-chat throttle → TG rate-limit (1/sec/chat, 30/sec global) не пробивается даже на 100 active users × 10 alerts.
* ✓ **Embeddings/image-hash NEVER throws** + bounded LRU+TTL + caches `null` hash для broken URLs (предотвращает repeated fetch).
* ✓ **Body limits**: 16KB dashboard, 32KB admin — DoS via large body blocked.
* ✓ **MAX_BODY_BYTES** + per-iter try/catch в collectors → no cascade fail.

---

## Spec drift

Накопительный счёт после этапов 1-4 (sync-pass после 12 этапов):

* **SD-1** (PIPE/SEC) — `TRUST_PROXY=1` декларируется в SESSION_CONTEXT, не работает в коде (initiate cap shared per nginx).
* **SD-2** (PIPE) — alert-dispatcher JSDoc упоминает «daily-limit gate», gate'а нет в коде.
* **SD-3** (PIPE/BILL) — Catalyst forecast 15-min per-user cooldown в spec, снят в коде (комментарий `trigger-finder.js`).
* **SD-4** (BILL) — `xAnalysis` поле не упомянуто в SESSION_CONTEXT § Бизнес-правила (есть в entitlements.js + comments).
* **SD-5** (BILL) — `historyHours: 72` для free не упомянут в § Бизнес-правила таблице.
* **SD-6** (BILL) — `favorites: true` pro/admin не явно в § Бизнес-правила (упомянуто в § User favourites).
* **SD-7** (BILL) — Manual analysis cache TTL: spec=1h, code=6h (bumped 17.05).
* **SD-8** (PIPE/COST re-confirm) — Embeddings cache TTL: spec/docstring говорит «5min = scan interval × 2», code = 5min, scan interval default = 15min → docstring sam себе противоречит.

**Cost audit новый spec drift**: ноль (все already flagged ранее). Один re-confirm SD-8.

---

## Cross-audit overlap

Известный triple и накопленные pairs:

* **TRIPLE (locked)**: SEC-001 + PIPE-004 + BILL-003 = `/api/scan` admin gate. **Cost angle уже в BILL-003** — не extend'нул новым звеном. Одна правка закроет 3 finding'а.
* **COST-003 ↔ BILL-007** — extension: BILL-007 говорил про `_manualAnalysisHits` restart-reset, COST-003 расширяет на ALL 3 cost-critical caps (`_catalystHits` + `_xAnalysisHits` тоже). Same fix (DB-backed persistence).
* **COST-004 ↔ BILL-001** — same root cause (hover preview endpoints), разные impacts: BILL-001 = paywall bypass на Twitter content, COST-004 = upstream IP-ban risk. **Одна правка** (plan-check + per-user rate-limit) закроет обе.
* **COST-006 + COST-008 ↔ PIPE-002** — все 3 про Gemini failover. PIPE-002 = counter не reset на partial success → premature failover. COST-006 = stuck-fallback no detection. COST-008 = permanent-down sucks timeouts forever. Все 3 решаются proactive Google healthcheck + better counter management.
* **COST-009 + COST-010 ↔ PIPE-016** — все про in-memory observability state (PIPE-016 = decisions buffer in-memory only). Architectural — нужна общая «metrics persistence» infrastructure.
* **COST-016 ↔ PIPE-006** — обе про `notifications` table issues (PIPE-006 = UNIQUE constraint, COST-016 = retention). One migration covers both.
* **COST-007 ↔ PIPE-009** — Stage 2 cap counter consumed on attempt, не success. PIPE-009 уже flag'нул как low. Re-confirm с cost angle.

---

## Out of scope / followups

* **(этап 5, DB health)** — `feature_usage_log` / `user_daily_counters` table для COST-003 (BILL-007 ext). + `notifications` retention для COST-016. + общий audit-log для plan_change_log (BILL-002). Migration set.
* **(этап 5, DB health)** — pricing table в `src/billing/pricing.js` — это код-level, не DB, но мirror'ит pricing constants которые сейчас в tag-refresher only. Consolidation step.
* **(этап 6, UX)** — admin StatusBar/Stats tab показать tokens + $ per stage (UI patch после backend COST-010).
* **(этап 11, code quality)** — extract pricing logic + cost-tracker helper из tag-refresher → shared util used by scorer / trigger-finder / nano-classifier.
* **(operational, post-12-этапов sync)** — 8 spec drift items накопились. Единый pass по SESSION_CONTEXT синхронизировать с реальным кодом.
* **(observation)** — `XAI_STAGE2_MAX_RESULTS=5` env — single biggest cost knob (Grok x_search $5/1000 sources). Сейчас calibrated на 5, дает $0.025/call. Если оператор поднимет до 10 → 2× Stage 2 spend без change в `stage2MaxCalls`. Документировать в admin UI «cost impact preview» перед change.
* **(observation, не cost)** — `_creatingTopic` Map в `support/bot.js:38` — race-prevention для concurrent topic creation. Не cost cap, но in-memory state, restart wipes. Не impact для cost (race window узкий).
* **(observation)** — При implementing COST-003 (DB-backed counters), стоит сразу заложить admin endpoint «inspect user's daily usage» (для support — «почему юзер X жалуется что cap исчерпан»). Сейчас Map в-памяти невозможно дебажить.

---

**Audit complete.** Жду решения какие finding'и фиксить первыми. Cross-audit overlap accumulates быстро — COST-003 + BILL-007 и COST-004 + BILL-001 — самые attractive «one fix, multiple wins» targets.
