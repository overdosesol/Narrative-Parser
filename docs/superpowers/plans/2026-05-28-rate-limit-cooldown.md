# Rate-limit + Cooldown Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Operator policy (CLAUDE.md):** Subagents do NOT make git commits — file edits only. Operator commits the entire bundle once all tasks are done.

**Goal:** Add per-user rate-limit (30 req / 5 min) to `/api/tweet-preview` and `/api/reddit-preview` endpoints — closes audit finding COST-004 (Reddit IP-ban risk from unthrottled hover preview). The other 3 findings originally assigned to Bundle #8 (COST-001, COST-002, PIPE-002) are already closed by prior work.

**Architecture:** Two module-level `UserRateLimiter` instances (one per endpoint) added to `src/dashboard/server.js`, wired into both preview handlers right after the existing BILL-001 plan check. Per-endpoint instances so a flood at one endpoint doesn't lock the user out of the other (Twitter vs Reddit are different upstream services).

**Tech Stack:** Node.js (ESM), existing `src/utils/rate-limiter.js` `UserRateLimiter` class (no new deps).

**Spec:** `docs/superpowers/specs/2026-05-28-rate-limit-cooldown-design.md`

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/dashboard/server.js` | MODIFY | +1 import, +2 module-level limiters, +2 rate-limit guards (one per handler) |
| `ai-context/SESSION_CONTEXT.md` | MODIFY | +1 bullet under Production posture (notes COST-001/002/PIPE-002 pre-closed + COST-004 new fix) |
| `ai-context/WORKLOG.md` | MODIFY | +1 top entry |

No new files. No DB changes. No env vars. SPA gate REQUIRED after dashboard/server.js edits.

---

## Task 1: Wire UserRateLimiter into both preview endpoints (+SPA gate)

**Files:**
- Modify: `src/dashboard/server.js` (top import + module-level + lines ~1336, ~1401)

**Critical**: `src/dashboard/server.js` contains a huge inline React SPA template literal. After editing, MUST run `node scripts/check-dashboard-spa.cjs` or `npm run check:spa`.

- [ ] **Step 1: Add import at top of file**

Open `src/dashboard/server.js`. Find the existing import block at top of file (lines 1-30ish). Add a new import line near the other utility imports (search for `from '../utils/'` to find that import cluster — if there isn't one, just add after the last `import` line):

```js
import { UserRateLimiter } from '../utils/rate-limiter.js';
```

Verify the file isn't already importing UserRateLimiter elsewhere — run `grep -c "UserRateLimiter" src/dashboard/server.js` BEFORE adding. If it returns >0, that import already exists; skip this step's add but keep reference for next steps.

- [ ] **Step 2: Add two module-level limiter constants**

Locate the existing module-level `const`s for preview caches — search for `tweetPreviewCache` or `TWEET_PREVIEW_TTL_MS`. These constants live near the top of the file, OUTSIDE the `class DashboardServer` declaration.

Right BEFORE the `class DashboardServer` line (or after the last existing const in that cluster), insert:

```js

// Bundle #8 — COST-004: per-user rate-limit for hover-preview endpoints.
// 30 requests / 5 minutes per user. Normal hover-skim (~5-10 previews per
// minute) unaffected; automated scraping that could trigger Reddit IP-ban
// gets blocked at 30 / 5min = 1 per 10s sustained.
const PREVIEW_RATE_WINDOW_MS  = 5 * 60 * 1000;
const PREVIEW_RATE_MAX        = 30;
const tweetPreviewLimiter  = new UserRateLimiter({ windowMs: PREVIEW_RATE_WINDOW_MS, maxRequests: PREVIEW_RATE_MAX });
const redditPreviewLimiter = new UserRateLimiter({ windowMs: PREVIEW_RATE_WINDOW_MS, maxRequests: PREVIEW_RATE_MAX });
```

- [ ] **Step 3: Add rate-limit guard to `_handleTweetPreview`**

Find `_handleTweetPreview` method (around line 1330). Locate the BILL-001 plan check block (around lines 1331-1336):

```js
  async _handleTweetPreview(req, res, url) {
    // BILL-001 (Bundle #3): gate hover preview by plan entitlements.
    // Twitter is paid-only (not in free.sources). Reject before any fetch.
    const planSources = getPlanEntitlements(req.user?.plan_name).sources;
    if (!planSources || !planSources.includes('twitter')) {
      return json(res, 403, { error: 'Twitter preview requires a paid plan', reason: 'plan' });
    }
```

Insert the rate-limit guard IMMEDIATELY after the plan check's closing `}` (around line 1336), BEFORE the next existing line (`const idParam = ...`):

```js

    // COST-004 (Bundle #8): per-user rate-limit. Defense against automated
    // scraping that could trigger upstream IP-ban.
    const userKey = req.user?.id || req.user?.chat_id || 'anon';
    if (!tweetPreviewLimiter.allow(userKey)) {
      return json(res, 429, { error: 'Too many preview requests. Please slow down.', reason: 'rate_limit' });
    }
```

- [ ] **Step 4: Add rate-limit guard to `_handleRedditPreview`**

Find `_handleRedditPreview` method (around line 1393). Locate its BILL-001 plan check (around lines 1394-1401):

```js
  async _handleRedditPreview(req, res, url) {
    // BILL-001 (Bundle #3): gate hover preview by plan entitlements.
    // Reddit is in free.sources currently → this gate rarely rejects;
    // added for consistency with tweet-preview and as future-proofing if
    // free plan ever excludes reddit.
    const planSources = getPlanEntitlements(req.user?.plan_name).sources;
    if (!planSources || !planSources.includes('reddit')) {
      return json(res, 403, { error: 'Reddit preview requires a paid plan', reason: 'plan' });
    }
```

Insert IMMEDIATELY after the plan check's closing `}` (around line 1401), BEFORE the next existing line (`const idParam = ...`):

```js

    // COST-004 (Bundle #8): per-user rate-limit. Defense against automated
    // scraping that could trigger Reddit IP-ban on our server's IP.
    const userKey = req.user?.id || req.user?.chat_id || 'anon';
    if (!redditPreviewLimiter.allow(userKey)) {
      return json(res, 429, { error: 'Too many preview requests. Please slow down.', reason: 'rate_limit' });
    }
```

Note: uses `redditPreviewLimiter` (NOT `tweetPreviewLimiter`).

- [ ] **Step 5: Verify parse**

Run: `node --check src/dashboard/server.js`
Expected: no output, exit code 0.

If parse fails — your edit broke template literal or surrounding code. Revert and report BLOCKED.

- [ ] **Step 6: MANDATORY SPA validator**

Run: `node scripts/check-dashboard-spa.cjs`
Expected: success message + char count printed, exit code 0.

**If SPA validator fails** — STOP. Revert ALL T1 edits. Report BLOCKED with exact stderr. Don't try to "fix" SPA inline.

- [ ] **Step 7: Verify the imports + limiters + guards are in place**

Run:
```bash
grep -c "UserRateLimiter" src/dashboard/server.js
```
Expected: ≥3 (1 import + 2 instantiations).

Run:
```bash
grep -c "tweetPreviewLimiter\.allow\|redditPreviewLimiter\.allow" src/dashboard/server.js
```
Expected: 2 (one allow check per handler).

Run:
```bash
grep -c "reason: 'rate_limit'" src/dashboard/server.js
```
Expected: 2 (one per handler 429 response).

- [ ] **Step 8: Self-review**

- `tweetPreviewLimiter` is used in `_handleTweetPreview` only; `redditPreviewLimiter` in `_handleRedditPreview` only. NO cross-wiring.
- Each guard sits BETWEEN the plan check and the `const idParam` line.
- Each guard returns `json(res, 429, ...)` (not 403 or 500).
- `userKey` fallback chain: `req.user?.id || req.user?.chat_id || 'anon'` — handles missing fields without throw.
- The existing cache lookup, fetch call, and other handler logic UNCHANGED.

- [ ] **Step 9: Report DONE — do not commit**

Operator commits the whole bundle later.

---

## Task 2: ai-context updates (no commit — operator handles)

**Files:**
- Modify: `ai-context/SESSION_CONTEXT.md` (Production posture section)
- Modify: `ai-context/WORKLOG.md` (new top entry)

- [ ] **Step 1: Add Production posture bullet to SESSION_CONTEXT.md**

Open `ai-context/SESSION_CONTEXT.md`. Find the existing **Bundle #6** bullet (search for `Bundle #6`). Insert a new bullet IMMEDIATELY AFTER it:

```markdown
- **Bundle #8 (Rate-limit + cooldown)** — per-user `UserRateLimiter` (30 req/5min) на `/api/tweet-preview` и `/api/reddit-preview` в `src/dashboard/server.js` (после BILL-001 plan check). 429 на flood. Closes COST-004. **Pre-closed (verified during recon)**: COST-001 + COST-002 (закрыты Bundle #2 — DB-backed `feature_usage_log`), PIPE-002 (закрыто pre-existing `_recordGoogleSuccess` reset в `gemini-captioner.js:1094`).
```

If you can't find "Bundle #6" — locate Production posture and append at end. Report DONE_WITH_CONCERNS describing placement.

- [ ] **Step 2: Add WORKLOG entry on top**

Open `ai-context/WORKLOG.md`. File header at top, entries newest-first below. Insert new entry directly after the file header and BEFORE the current top entry:

```markdown
## 2026-05-28 · sonnet · Bundle #8: Rate-limit + cooldown — per-user limiter on hover previews

**Цель:** Закрыть COST-004 (Reddit IP-ban risk через unthrottled hover preview). Подтвердить closure COST-001/002/PIPE-002 (уже закрыты pre-existing work).

**Файлы:**
- `src/dashboard/server.js`:
  - +1 import `UserRateLimiter` from `../utils/rate-limiter.js`
  - +2 module-level limiter `const`s (`tweetPreviewLimiter`, `redditPreviewLimiter`, оба 30 req / 5 min) + 2 константы `PREVIEW_RATE_*`
  - +2 rate-limit guard блока в `_handleTweetPreview` и `_handleRedditPreview` после BILL-001 plan check. Возвращают 429 `{ error, reason: 'rate_limit' }` на flood. Per-endpoint instances (Twitter ≠ Reddit upstream).
  - SPA gate ✅.

**Деплой:** стандартный `deploy.ps1`. Никаких env vars / migrations.

**Recon findings (закрыто до бандла):**
- **COST-001** — manual-analysis cap race → закрыто Bundle #2 (2026-06-07), DB-backed `feature_usage_log` table + atomic `getRecentFeatureUsageHits`.
- **COST-002** — catalyst cap race + key type mismatch → закрыто Bundle #2 (тот же fix).
- **PIPE-002** — Gemini cooldown reset на success → закрыто pre-existing `_recordGoogleSuccess()` at `src/analysis/gemini-captioner.js:1094-1100` сбрасывает `_googleFailures = 0` на каждый success.

**Риски:** 30/5min может быть тесно для power users — легко раздвинуть через `PREVIEW_RATE_MAX` const. In-memory state теряется на restart (acceptable — upstream rate windows тоже short-lived). 'anon' fallback shared bucket — defense-in-depth если auth gate когда-нибудь bypass'нется.

**Не сделано:** dashboard SPA toast UX для 429 — current generic 4xx handler достаточен.
```

- [ ] **Step 3: Verify**

Run:
```bash
grep -c "Bundle #8" ai-context/SESSION_CONTEXT.md
grep -c "Bundle #8" ai-context/WORKLOG.md
grep -c "^## 2026" ai-context/WORKLOG.md
```

Expected:
- SESSION_CONTEXT: ≥1
- WORKLOG: ≥1
- WORKLOG entry count: 11 (was 10 — under soft cap, no rotation needed).

- [ ] **Step 4: Report DONE — do not commit**

Operator will commit all 3 files (dashboard/server.js + 2 ai-context) as part of the Bundle #8 commit.

---

## Final verification (run after both tasks)

- [ ] **Parse check**

Run: `node --check src/dashboard/server.js`
Expected: exit code 0.

- [ ] **SPA validator (final pass)**

Run: `npm run check:spa`
Expected: both validators pass.

- [ ] **Bundle marker check**

Run:
```bash
grep -n "Bundle #8" src/dashboard/server.js ai-context/SESSION_CONTEXT.md ai-context/WORKLOG.md
```
Expected: at least 4 lines (multiple in dashboard + 1 SESSION_CONTEXT + 1+ WORKLOG).

- [ ] **Limiter usage sanity**

Run:
```bash
grep -A1 "tweetPreviewLimiter.allow\|redditPreviewLimiter.allow" src/dashboard/server.js
```
Expected: 2 blocks, each followed by `return json(res, 429, ...)`.

- [ ] **Working tree summary**

Run: `git status --short`
Expected: 3 modified files (dashboard/server.js, SESSION_CONTEXT.md, WORKLOG.md), plus 2 new docs (spec + plan).

---

## Post-implementation: operator deploy

Standard `deploy.ps1`. No migration, no env changes. Smoke test:

1. Open dashboard, hover several cards → previews load normally.
2. Devtools: spam 31 GET requests to `/api/tweet-preview?id=12345` from your browser session.
3. 31st should return 429 with `{ reason: 'rate_limit' }`.
4. Wait ~5 min → next request works.

If users complain about 429 during normal usage → raise `PREVIEW_RATE_MAX` from 30 to 60 (single-line change). Re-deploy.
