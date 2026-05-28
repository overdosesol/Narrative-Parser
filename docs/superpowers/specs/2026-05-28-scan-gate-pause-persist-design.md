# /api/scan Admin Gate + Pause Persistence — Design Spec

**Date**: 2026-05-28
**Bundle**: #7 (Tier 4, polish)
**Audit findings closed**: SEC-001, PIPE-004, BILL-003, ADM-018 + spec drift SD-16
**Estimated effort**: ~1h
**ROI**: 4.0 (5 items closed by ~3 small patches)

---

## 1. Goal

Two coupled small fixes:

1. **`/api/scan` admin gate + immediate timestamp** (closes SEC-001 + PIPE-004 + BILL-003):
   - Only admin-plan users can trigger manual scans (free/test/pro should not be able to burn LLM credits).
   - Write `lastScanStartedAt` to DB synchronously in the handler — gives admin UI immediate visibility into "scan in progress" state.

2. **Pause persistence** (closes ADM-018 + SD-16):
   - Admin pause/resume currently only updates `appState.paused` (in-memory). Restart resets to false → operator who paused for incident silently loses pause across deploy.
   - Persist to `settings` table on pause/resume. Restore from DB on boot.

---

## 2. Architecture overview

```
src/
├── dashboard/server.js     _handleScan: +admin check, +setSetting('lastScanStartedAt')
├── admin/server.js         /api/scanners/pause + /resume: +setSetting('scanner_paused')
└── index.js                boot: appState.paused = db.getSetting('scanner_paused') === '1'

ai-context/                 +bullet + WORKLOG entry
```

Total LOC change: ~15 lines across 3 files. No new methods, no schema changes (settings table already exists from before B7).

---

## 3. Components

### 3.1 `src/dashboard/server.js` — _handleScan (lines 2153-2166)

**Current code:**
```js
  async _handleScan(req, res) {
    if (this.appState?.paused) {
      return json(res, 409, { error: 'Scanner is paused. Resume it first.' });
    }
    if (this.appState?.scanRunning) {
      return json(res, 409, { error: 'Scan is already running. Try again in a moment.' });
    }
    if (typeof this.scanFn === 'function') {
      // Run in background, don't await
      this.scanFn().catch(e => this.logger.error(`Manual scan error: ${e.message}`));
      return json(res, 202, { message: 'Scan triggered — check logs for progress' });
    }
    return json(res, 503, { error: 'Scan function not available' });
  }
```

**New code:**
```js
  async _handleScan(req, res) {
    // Bundle #7 — SEC-001 + BILL-003: admin-only operation. Free/test/pro
    // users could burn LLM credits triggering full collect+score cycles.
    if (req.user?.plan_name !== 'admin') {
      return json(res, 403, { error: 'Manual scan is admin-only', reason: 'plan' });
    }
    if (this.appState?.paused) {
      return json(res, 409, { error: 'Scanner is paused. Resume it first.' });
    }
    if (this.appState?.scanRunning) {
      return json(res, 409, { error: 'Scan is already running. Try again in a moment.' });
    }
    if (typeof this.scanFn === 'function') {
      // Bundle #7 — PIPE-004: record trigger timestamp immediately so admin UI
      // shows "scan in progress" without waiting for the cycle to complete (which
      // can take 30-60s). Existing finally block in runScanCycle still writes
      // lastScanCompletedAt — admin UI compares the two to detect in-flight scans.
      try { this.db.setSetting('lastScanStartedAt', String(Date.now())); } catch {}
      // Run in background, don't await
      this.scanFn().catch(e => this.logger.error(`Manual scan error: ${e.message}`));
      return json(res, 202, { message: 'Scan triggered — check logs for progress' });
    }
    return json(res, 503, { error: 'Scan function not available' });
  }
```

Changes:
- +5 lines admin gate (lines 1-5 of new block, replacing nothing)
- +2 lines immediate timestamp write (inside the existing `if (typeof this.scanFn === 'function')` block, before scanFn call)

`req.user` is populated by the existing auth middleware. The dashboard server uses plan-based gating elsewhere (e.g. BILL-001 in `_handleTweetPreview`), so this pattern is consistent.

### 3.2 `src/admin/server.js` — pause/resume endpoints (lines 1575-1585)

**Current code:**
```js
      if (path === '/api/scanners/pause' && method === 'POST') {
        this.appState.paused = true;
        this.logger.info('[Admin] Scanner paused');
        return json(res, 200, { paused: true });
      }

      if (path === '/api/scanners/resume' && method === 'POST') {
        this.appState.paused = false;
        this.logger.info('[Admin] Scanner resumed');
        return json(res, 200, { paused: false });
      }
```

**New code:**
```js
      if (path === '/api/scanners/pause' && method === 'POST') {
        this.appState.paused = true;
        // Bundle #7 — ADM-018 + SD-16: persist so pause survives deploy/restart.
        try { this.db.setSetting('scanner_paused', '1'); }
        catch (e) { this.logger.warn(`[Admin] Failed to persist pause: ${e.message}`); }
        this.logger.info('[Admin] Scanner paused');
        return json(res, 200, { paused: true });
      }

      if (path === '/api/scanners/resume' && method === 'POST') {
        this.appState.paused = false;
        // Bundle #7 — ADM-018 + SD-16: persist so resume survives deploy/restart.
        try { this.db.setSetting('scanner_paused', '0'); }
        catch (e) { this.logger.warn(`[Admin] Failed to persist resume: ${e.message}`); }
        this.logger.info('[Admin] Scanner resumed');
        return json(res, 200, { paused: false });
      }
```

Changes: +2 lines per endpoint (4 lines total). DB write is best-effort (try/catch) — if DB write fails, in-memory state still updates and we log a warning. Pause/resume should not 500 because of secondary DB hiccup.

### 3.3 `src/index.js` — boot restore (after `const db = new TrendDatabase(...)`)

Locate the `db` initialization (around line 37 per prior session notes). After the `db` is created but before `appState` is used by scheduler / dashboard, add:

```js
// Bundle #7 — ADM-018 + SD-16: restore scanner pause state across restart.
try {
  if (db.getSetting('scanner_paused') === '1') {
    appState.paused = true;
    logger.warn('[Boot] Scanner is PAUSED (persisted from previous session). Resume via admin panel.');
  }
} catch (e) { logger.warn(`[Boot] Failed to read scanner_paused setting: ${e.message}`); }
```

This must execute BEFORE:
- `runScanCycle()` is invoked (so the first scheduler tick respects pause)
- `dashboard` server starts (so it reports the correct `paused` state on `/api/config`)
- `alertScheduler.start()` (so it doesn't immediately dispatch pending alerts)

The exact insertion point is after the line `const db = new TrendDatabase(...)` and before `const alertScheduler = new AlertScheduler(...)`. Implementer should find a logical spot in that range.

Log line is warn-level + suggests next action — operator immediately notices on restart they're still paused.

---

## 4. Data flow

```
Operator clicks "Pause" in admin UI
  → POST /api/scanners/pause
  → appState.paused = true                  (in-memory)
  → db.setSetting('scanner_paused', '1')    (NEW: persist)
  → 200 { paused: true }

App restart / deploy
  → const db = new TrendDatabase(...)
  → if (db.getSetting('scanner_paused') === '1') appState.paused = true  (NEW: restore)
  → logger.warn('Scanner is PAUSED...')

Scheduler tick or manual /api/scan
  → checks appState.paused → respects restored state

Operator clicks "Resume"
  → POST /api/scanners/resume
  → appState.paused = false
  → db.setSetting('scanner_paused', '0')    (NEW: persist clear)
  → 200 { paused: false }

Operator (admin plan) clicks "Manual scan" in dashboard
  → POST /api/scan
  → admin plan check                        (NEW)
  → paused/running checks (existing)
  → db.setSetting('lastScanStartedAt', ...) (NEW: immediate timestamp)
  → scanFn() (async background)
  → 202 response

Non-admin user tries POST /api/scan
  → admin plan check fails → 403 { reason: 'plan' }
```

---

## 5. Error handling

| Path | On error |
|---|---|
| `_handleScan` admin gate | 403 `{ error, reason: 'plan' }` |
| `setSetting('lastScanStartedAt')` | try/catch wrapped, silent skip — timestamp loss isn't fatal |
| `setSetting('scanner_paused')` | try/catch + `logger.warn`. In-memory state still updates. |
| `getSetting('scanner_paused')` at boot | try/catch + warn. Default to false (resume normal operation). |

Conservative bias: if DB write fails on pause persistence, current in-memory pause is preserved AND failure is logged. Operator sees they can't trust restart-survival until DB issue resolved.

---

## 6. Testing strategy

### 6.1 Manual smoke (post-deploy)

- **Admin gate**: log in as `free` plan, try `POST /api/scan` via devtools — expect 403 with `reason: 'plan'`. Log in as admin → expect 202.
- **Immediate timestamp**: trigger scan as admin → immediately query `db.getSetting('lastScanStartedAt')` (via SQL or admin endpoint) → expect ~current ms.
- **Pause persist**: admin pause → check `db.getSetting('scanner_paused')` returns `'1'`. Restart bot. Check `/api/config` returns `paused: true`. Check boot logs for `[Boot] Scanner is PAUSED...` warning.

### 6.2 No unit tests

No test runner yet. Verification = `node --check` + `npm run check:spa` for files with inline SPA (dashboard + admin) + manual.

### 6.3 SPA gate

`src/dashboard/server.js` and `src/admin/server.js` both contain inline React SPA. MANDATORY `npm run check:spa` after edits.

---

## 7. Files changed

| File | Change |
|---|---|
| `src/dashboard/server.js` | +5 admin-gate lines, +2 timestamp lines in `_handleScan` |
| `src/admin/server.js` | +2 setSetting lines in `/api/scanners/pause`, +2 in `/resume` |
| `src/index.js` | +4 boot-restore lines after `const db = ...` |
| `ai-context/SESSION_CONTEXT.md` | +1 bullet |
| `ai-context/WORKLOG.md` | +1 top entry |

No schema changes (settings table already exists). No env vars. No new methods on TrendDatabase (uses existing `setSetting`/`getSetting`).

---

## 8. Risks

- **Admin gate could lock out test/pro users who legitimately wanted to trigger scans**: per audit, `/api/scan` is admin-only by design. Free/test/pro have other ways to interact (their alerts come from the scheduled scan, not on-demand triggers). If an operator is non-admin → they shouldn't have access anyway.
- **Pause persistence interaction with cron deploy**: if operator pauses → forgets → deploys → scanner stays paused indefinitely. Mitigation: boot log line is WARN-level + suggests "Resume via admin panel". Operator notices.
- **DB write failure on pause endpoint**: in-memory still pauses, alert visible via `logger.warn`. Worst case: pause works for current process, restart auto-resumes (matches current behavior — no regression).
- **`req.user?.plan_name` shape assumption**: matches existing BILL-001 pattern in same file (`_handleTweetPreview` checks `getPlanEntitlements(req.user?.plan_name).sources`). Pattern verified.
- **Setting key naming**: `lastScanStartedAt` + `scanner_paused`. Both follow camelCase + snake_case patterns already in use (`lastScanCompletedAt` is camelCase, `disabledCollectors` is camelCase). Slight inconsistency: `scanner_paused` snake_case vs `lastScanStartedAt` camelCase. Acceptable trade-off — `scanner_paused` is human-readable and "scanner" is a clear domain noun.

---

## 9. Acceptance criteria

- `_handleScan` returns 403 with `reason: 'plan'` for non-admin callers.
- `_handleScan` writes `lastScanStartedAt` (epoch ms string) to `settings` table before triggering scanFn.
- `/api/scanners/pause` writes `scanner_paused=1` to settings.
- `/api/scanners/resume` writes `scanner_paused=0` to settings.
- `src/index.js` reads `scanner_paused` at boot and restores `appState.paused` if `'1'`.
- Boot logs `[Boot] Scanner is PAUSED...` at warn level if state restored.
- `node --check` passes on all 3 touched JS files.
- `npm run check:spa` passes (no SPA template damage from minor edits in admin/server.js + dashboard/server.js).
- Existing behavior preserved: in-memory `appState.paused` still works; cron scheduler still checks it; admin UI buttons still toggle it.

---

## 10. Out of scope

- Persistent `lastScanCompletedAt` — already persisted (existing).
- Admin UI changes to show "scan in progress" badge based on `lastScanStartedAt` vs `lastScanCompletedAt` — defer; widget could be in B6's maintenance card extension. Not needed now (data is exposed for future UI work).
- Per-admin tracking (which admin triggered which scan) — out of scope; existing single-admin model preserved.
- Schema migration to add a dedicated `admin_state` table — settings table is fine for now (2-key footprint).
