# Rate-limit + Cooldown Fixes — Design Spec

**Date**: 2026-05-28
**Bundle**: #8 (Tier 3, scaling prep)
**Audit findings closed**: COST-004 (preview per-user rate-limit) — primary scope
**Audit findings already closed before bundle**: COST-001, COST-002 (closed by Bundle #2 feature_usage_log), PIPE-002 (closed by existing `_recordGoogleSuccess` reset logic)
**Estimated effort**: ~30 min

---

## 1. Goal

Add per-user rate-limit to the two hover-preview endpoints (`/api/tweet-preview`, `/api/reddit-preview`) — closes **COST-004**.

Recon found that 3 of 4 findings in Bundle #8 are already closed by prior work:
- **COST-001** (concurrent race on manual-analysis cap) → closed by Bundle #2 (DB-backed `feature_usage_log`).
- **COST-002** (concurrent race on catalyst cap + key type mismatch) → closed by Bundle #2 (same).
- **PIPE-002** (Gemini cooldown not reset on success) → closed by pre-existing `_recordGoogleSuccess()` in `src/analysis/gemini-captioner.js:1094-1100` which sets `_googleFailures = 0`.

So this bundle is narrowly scoped: COST-004 only.

---

## 2. Architecture overview

Reuse the existing `UserRateLimiter` (per-user sliding window) from `src/utils/rate-limiter.js`. Two separate instances — one per endpoint — because each endpoint hits a different external service (Twitter vs Reddit), and an IP-ban from one shouldn't be triggered by spam at the other (or share quota across them).

```
src/dashboard/server.js
├── import { UserRateLimiter } from '../utils/rate-limiter.js';
├── const tweetPreviewLimiter  = new UserRateLimiter({ windowMs: 300_000, maxRequests: 30 })
├── const redditPreviewLimiter = new UserRateLimiter({ windowMs: 300_000, maxRequests: 30 })
├── _handleTweetPreview()   → check tweetPreviewLimiter, 429 on reject
└── _handleRedditPreview()  → check redditPreviewLimiter, 429 on reject
```

No new files. No DB schema changes. No new env vars. ~10 LOC of new code in dashboard/server.js.

---

## 3. Components

### 3.1 Existing `src/utils/rate-limiter.js` (NO CHANGES)

Verified API (read-only context):
```js
export class UserRateLimiter {
  constructor({ windowMs = 60_000, maxRequests = 20 } = {}) { ... }
  allow(chatId) { ... return boolean }
}
```

`allow(key)` is sliding-window: returns `true` if under threshold within `windowMs`, registers the call. Internal `_cleanup()` runs every 5min to remove stale buckets. Stringifies the key.

### 3.2 `src/dashboard/server.js` — 3 edits

#### 3.2.1 Add import at top of file

Locate the existing import block. After the last `import` statement, add:

```js
import { UserRateLimiter } from '../utils/rate-limiter.js';
```

#### 3.2.2 Create two limiter instances (module-level)

Find a sensible spot near the top of the file — after the imports but BEFORE the `class DashboardServer` declaration. There should be other module-level `const`s nearby (the existing `tweetPreviewCache`, `TWEET_PREVIEW_TTL_MS`, etc.). Place these near them:

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

Per-endpoint instances (not shared) so a flood at one endpoint doesn't lock the user out of the other.

#### 3.2.3 Wire into `_handleTweetPreview` (after BILL-001 plan check, line ~1336)

Current code (around line 1330-1336):
```js
  async _handleTweetPreview(req, res, url) {
    // BILL-001 (Bundle #3): gate hover preview by plan entitlements.
    // Twitter is paid-only (not in free.sources). Reject before any fetch.
    const planSources = getPlanEntitlements(req.user?.plan_name).sources;
    if (!planSources || !planSources.includes('twitter')) {
      return json(res, 403, { error: 'Twitter preview requires a paid plan', reason: 'plan' });
    }
```

Insert this block immediately after the plan check, BEFORE the existing `const idParam = ...`:

```js

    // COST-004 (Bundle #8): per-user rate-limit. Defense against automated
    // scraping that could trigger upstream IP-ban.
    const userKey = req.user?.id || req.user?.chat_id || 'anon';
    if (!tweetPreviewLimiter.allow(userKey)) {
      return json(res, 429, { error: 'Too many preview requests. Please slow down.', reason: 'rate_limit' });
    }
```

#### 3.2.4 Wire into `_handleRedditPreview` (after BILL-001 plan check, line ~1401)

Same pattern. Current code:
```js
  async _handleRedditPreview(req, res, url) {
    // BILL-001 (Bundle #3): gate hover preview by plan entitlements.
    const planSources = getPlanEntitlements(req.user?.plan_name).sources;
    if (!planSources || !planSources.includes('reddit')) {
      return json(res, 403, { error: 'Reddit preview requires a paid plan', reason: 'plan' });
    }
```

Insert right after:

```js

    // COST-004 (Bundle #8): per-user rate-limit. Defense against automated
    // scraping that could trigger Reddit IP-ban on our server's IP.
    const userKey = req.user?.id || req.user?.chat_id || 'anon';
    if (!redditPreviewLimiter.allow(userKey)) {
      return json(res, 429, { error: 'Too many preview requests. Please slow down.', reason: 'rate_limit' });
    }
```

---

## 4. Data flow

```
User hovers card → GET /api/tweet-preview?id=...
  ├── Auth gate (existing) → 401 if no session
  ├── Plan check (existing) → 403 if Twitter not in plan
  ├── Rate-limit check (NEW)  → 429 if >30 reqs in last 5min for this user
  ├── Cache hit (existing) → return cached
  └── External fetch → fetchTweetPreview(id) → cache + return
```

Rate-limit check sits between plan check and cache lookup — so the cache still serves repeats freely until the limit is hit (intentional: the per-user limit is about NEW unique fetches into the upstream).

Actually, more precise: the limit counts ALL requests, including cache hits. This is OK because:
- 30/5min is generous for hover usage (~6 per minute).
- Counting cache hits too gives a cleaner upper bound on traffic (defense in depth).
- Saves us from having to thread `cached/uncached` decisions into the limit logic.

---

## 5. Error handling

| Path | Behavior |
|---|---|
| `req.user` missing | falls back to `'anon'` key (shared bucket). Auth gate above SHOULD prevent this — fallback is defense-in-depth |
| Limiter throws | impossible by design (UserRateLimiter doesn't throw); but if it did, request would 500 — caller's existing try/catch handles |
| 429 response | client sees `{ error, reason: 'rate_limit' }`. Dashboard SPA can show user-friendly "slow down" toast if it handles `reason: 'rate_limit'` (out of scope to add toast logic — current SPA already handles 4xx generically) |

---

## 6. Testing strategy

### 6.1 Manual smoke (post-deploy)

- Hover several cards on the dashboard. Verify previews still load.
- Open browser devtools → spam 31 requests to `/api/tweet-preview?id=12345` (random valid-format ID).
- 31st should return 429 with `{ error, reason: 'rate_limit' }`.
- Wait 5 minutes. New requests work again.

### 6.2 No unit tests

No test runner yet (Bundle #18). Verification = `node --check` + `npm run check:spa` + manual.

### 6.3 SPA gate

`src/dashboard/server.js` carries inline React SPA. After edits, run `node scripts/check-dashboard-spa.cjs` (or `npm run check:spa` which covers both dashboard and admin).

---

## 7. Files changed (summary)

| File | Change |
|---|---|
| `src/dashboard/server.js` | +1 import, +2 limiter `const`s, +2 rate-limit guard blocks (in `_handleTweetPreview` and `_handleRedditPreview`) |
| `ai-context/SESSION_CONTEXT.md` | +1 bullet under Production posture (notes COST-001/002/PIPE-002 pre-closed + COST-004 new fix) |
| `ai-context/WORKLOG.md` | +1 top entry |

No backend deps, no DB migrations, no env vars.

---

## 8. Risks

- **30/5min may be too tight** for power users. Mitigation: easy to raise via `PREVIEW_RATE_MAX` constant if logs show legit users hitting 429.
- **In-memory state lost on restart**: acceptable. Reddit/Twitter rate-limit windows are also short-lived. Restart resets bucket → user can spam again momentarily, but auto-cleanup + 5min window catches them fast.
- **No per-IP fallback**: if auth bypassed (shouldn't be possible, but), all anonymous users share the 'anon' bucket. That's actually MORE restrictive (anonymous gets 30/5min total for all anon users), which is fine for defense.
- **Cache-counted-as-call inflation**: a user hammering refresh on the same trend ID hits cache, no upstream call, but still counts toward limit. Acceptable trade-off for code simplicity. If observed in logs as a problem → relax to only count cache misses (5-line change).

---

## 9. Acceptance criteria

- `src/dashboard/server.js` imports `UserRateLimiter` from `../utils/rate-limiter.js`.
- Two module-level limiter `const`s exist with `windowMs=300_000` and `maxRequests=30`.
- `_handleTweetPreview` returns 429 with `{ error, reason: 'rate_limit' }` after 30 requests in 5 min from one user.
- `_handleRedditPreview` mirrors the behavior with its own limiter.
- `node --check src/dashboard/server.js` passes.
- `npm run check:spa` passes (no SPA template damage).
- Existing BILL-001 plan check + cache logic untouched.

---

## 10. Out of scope / deferred

- Dashboard SPA toast UX for 429 — current generic error handling sufficient.
- DB-backed counter (like Bundle #2 caps) — in-memory adequate for ephemeral preview throttle.
- Global token bucket across endpoints (`TokenBucketLimiter` from rate-limiter.js) — not needed; per-endpoint sliding window is the right granularity.
- Adding rate-limit to other dashboard endpoints (e.g., `/api/trends`) — out of scope; only COST-004 covers preview specifically.

---

## 11. Pre-closure audit trail

For posterity (so future audits don't re-flag these as open):

- **COST-001 — manual-analysis cap race**: closed in Bundle #2 (2026-06-07). Implementation: `getRecentFeatureUsageHits` reads from `feature_usage_log` table at `src/dashboard/server.js:1978`. Atomic DB check + counter increment in `recordFeatureUsage()` at `src/db/database.js:2513`.
- **COST-002 — catalyst cap race + key mismatch**: closed in Bundle #2 (same). Same DB-backed counter, key type irrelevant since `user_id` is canonical integer.
- **PIPE-002 — Gemini cooldown reset**: closed by pre-existing logic. `_recordGoogleSuccess()` at `src/analysis/gemini-captioner.js:1094-1100` resets `_googleFailures = 0` on every success during normal op (not only after cooldown expiry).

These three were verified during context recon for Bundle #8.
