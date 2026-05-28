# /api/scan Admin Gate + Pause Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Operator policy (CLAUDE.md):** Subagents do NOT make git commits — file edits only. Operator commits the entire bundle once all tasks are done.

**Goal:** Add admin-plan gate + immediate timestamp write to `/api/scan` (closes SEC-001 + PIPE-004 + BILL-003); persist scanner pause state across restart (closes ADM-018 + SD-16).

**Architecture:** Three small in-place patches: (1) `_handleScan` gets an admin-plan guard + immediate `setSetting('lastScanStartedAt')`; (2) `/api/scanners/pause` and `/api/scanners/resume` each get a `setSetting('scanner_paused', ...)` call; (3) `src/index.js` reads `scanner_paused` at boot and restores `appState.paused`. No schema changes — re-uses existing `settings` table.

**Tech Stack:** Node.js ESM, better-sqlite3, existing `db.setSetting` / `db.getSetting` on TrendDatabase. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-28-scan-gate-pause-persist-design.md`

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/dashboard/server.js` | MODIFY | `_handleScan`: +admin check, +immediate timestamp write (~7 lines) |
| `src/admin/server.js` | MODIFY | `/api/scanners/pause` + `/api/scanners/resume`: +setSetting (~4 lines) |
| `src/index.js` | MODIFY | Boot: read `scanner_paused`, restore `appState.paused` (~6 lines) |
| `ai-context/SESSION_CONTEXT.md` | MODIFY | +1 bullet |
| `ai-context/WORKLOG.md` | MODIFY | +1 top entry |

Tasks #1 and #2 both edit inline SPAs — both REQUIRE `npm run check:spa` after edits.

---

## Task 1: dashboard/server.js — admin gate + immediate timestamp (+SPA gate)

**Files:**
- Modify: `src/dashboard/server.js` (lines 2153-2166)

Critical: `src/dashboard/server.js` carries a huge inline React SPA template literal. After edit, MUST run `npm run check:spa`.

- [ ] **Step 1: Open file and locate _handleScan**

Open `src/dashboard/server.js`. Find `_handleScan` method around line 2153. Verify current code matches:

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

If the code differs structurally — STOP and report. Don't try to adapt.

- [ ] **Step 2: Replace _handleScan with the new version**

Replace the entire method body (lines 2153-2166) with:

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
- Added 5-line admin guard block at the top (before existing `paused` check).
- Added 2-line `setSetting('lastScanStartedAt', ...)` block inside the existing `scanFn` branch, BEFORE `this.scanFn().catch(...)`.
- Existing `paused` / `scanRunning` / `scanFn` checks UNCHANGED.

- [ ] **Step 3: Verify parse**

Run: `node --check src/dashboard/server.js`
Expected: no output, exit code 0.

- [ ] **Step 4: MANDATORY SPA validator**

Run: `node scripts/check-dashboard-spa.cjs`
Expected: success message, exit code 0.

**If SPA validator fails** — STOP. Revert your edit. Report BLOCKED with exact stderr.

- [ ] **Step 5: Verify changes are in place**

Run:
```bash
grep -A 2 "plan_name !== 'admin'" src/dashboard/server.js
```
Expected: shows the admin check + 403 return inside `_handleScan`.

Run:
```bash
grep -c "lastScanStartedAt" src/dashboard/server.js
```
Expected: `1`.

- [ ] **Step 6: Self-review**

- Admin guard sits FIRST (before paused/scanRunning checks). Important — non-admin requests should not even see "scanner is paused" details.
- `setSetting('lastScanStartedAt')` is wrapped in try/catch (silent skip).
- Method overall structure preserved: 4 early returns → scanFn dispatch → 503 fallback.

- [ ] **Step 7: Report DONE — do not commit**

---

## Task 2: admin/server.js — persist pause state on toggle (+SPA gate)

**Files:**
- Modify: `src/admin/server.js` (lines 1575-1585)

Critical: `src/admin/server.js` carries inline React SPA template literal. After edit, MUST run `node scripts/check-admin-spa.cjs`.

- [ ] **Step 1: Locate pause/resume endpoints**

Open `src/admin/server.js`. Find around line 1575-1585. Verify current code matches:

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

If structure differs — STOP and report.

- [ ] **Step 2: Replace pause endpoint with persisted version**

Replace the `/api/scanners/pause` block:

```js
      if (path === '/api/scanners/pause' && method === 'POST') {
        this.appState.paused = true;
        // Bundle #7 — ADM-018 + SD-16: persist so pause survives deploy/restart.
        try { this.db.setSetting('scanner_paused', '1'); }
        catch (e) { this.logger.warn(`[Admin] Failed to persist pause: ${e.message}`); }
        this.logger.info('[Admin] Scanner paused');
        return json(res, 200, { paused: true });
      }
```

- [ ] **Step 3: Replace resume endpoint with persisted version**

Replace the `/api/scanners/resume` block:

```js
      if (path === '/api/scanners/resume' && method === 'POST') {
        this.appState.paused = false;
        // Bundle #7 — ADM-018 + SD-16: persist so resume survives deploy/restart.
        try { this.db.setSetting('scanner_paused', '0'); }
        catch (e) { this.logger.warn(`[Admin] Failed to persist resume: ${e.message}`); }
        this.logger.info('[Admin] Scanner resumed');
        return json(res, 200, { paused: false });
      }
```

- [ ] **Step 4: Verify parse**

Run: `node --check src/admin/server.js`
Expected: no output, exit code 0.

- [ ] **Step 5: MANDATORY SPA validator**

Run: `node scripts/check-admin-spa.cjs`
Expected: success message, exit code 0.

**If fails** — revert + report BLOCKED.

- [ ] **Step 6: Verify changes**

Run:
```bash
grep -c "scanner_paused" src/admin/server.js
```
Expected: `2` (one in pause endpoint, one in resume).

Run:
```bash
grep "setSetting('scanner_paused', '1')" src/admin/server.js
```
Expected: 1 line.

Run:
```bash
grep "setSetting('scanner_paused', '0')" src/admin/server.js
```
Expected: 1 line.

- [ ] **Step 7: Report DONE — do not commit**

---

## Task 3: index.js — boot restore of pause state

**Files:**
- Modify: `src/index.js` (after `const db = new TrendDatabase(...)` declaration)

- [ ] **Step 1: Locate the db instantiation**

Open `src/index.js`. Search for `new TrendDatabase` — should be around line 37 per session notes. Find the line that instantiates `db`. Look for surrounding code; the immediate next lines may include other top-of-app initialization (logger setup, config, etc.) before the AlertScheduler / dashboard server start.

- [ ] **Step 2: Insert boot-restore block after db declaration**

Right after the `const db = new TrendDatabase(...)` line, insert these 6 lines (with surrounding blank lines for readability):

```js

// Bundle #7 — ADM-018 + SD-16: restore scanner pause state across restart.
try {
  if (db.getSetting('scanner_paused') === '1') {
    appState.paused = true;
    logger.warn('[Boot] Scanner is PAUSED (persisted from previous session). Resume via admin panel.');
  }
} catch (e) { logger.warn(`[Boot] Failed to read scanner_paused setting: ${e.message}`); }
```

Important: this block MUST execute BEFORE:
- `const alertScheduler = new AlertScheduler(...)` (so scheduler sees correct pause state)
- `alertScheduler.start()`
- The dashboard server is started or scanFn defined
- Any `runScanCycle()` invocation

Verify by inspection — after inserting, check that the next non-comment code AFTER your inserted block is either an unrelated init or one of: `solanaMonitor` init, dashboard server class, scheduler class. NOT a scan invocation.

If `appState` or `logger` is declared AFTER your insertion point — find an earlier `appState` declaration and move the block down to after it. The dependency chain is: `db` → your block → `appState.paused` (must be defined by then).

- [ ] **Step 3: Verify parse**

Run: `node --check src/index.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify restoration block in place**

Run:
```bash
grep -n "scanner_paused" src/index.js
```
Expected: 1 line (inside the new block).

Run:
```bash
grep -n "Scanner is PAUSED" src/index.js
```
Expected: 1 line.

- [ ] **Step 5: Self-review**

- The block runs ONCE at boot, not in any loop.
- Uses `logger.warn` (not info or error) — alarming enough to notice, not a crash.
- Wrapped in try/catch — DB hiccup doesn't crash boot.
- Doesn't write to `appState.paused` if setting is missing or false — defaults to whatever `appState.paused` already was (typically false).

- [ ] **Step 6: Report DONE — do not commit**

---

## Task 4: ai-context updates (no commit — operator handles)

**Files:**
- Modify: `ai-context/SESSION_CONTEXT.md`
- Modify: `ai-context/WORKLOG.md`

- [ ] **Step 1: Add Production posture bullet to SESSION_CONTEXT.md**

Open `ai-context/SESSION_CONTEXT.md`. Find the existing **Bundle #8** bullet (search for `Bundle #8`). Insert a new bullet IMMEDIATELY AFTER it:

```markdown
- **Bundle #7 (/api/scan admin gate + pause persistence)** — `_handleScan` в `src/dashboard/server.js` теперь требует `plan_name === 'admin'` (403 `reason: 'plan'` иначе) + сразу пишет `lastScanStartedAt` в settings. `/api/scanners/{pause,resume}` в `src/admin/server.js` теперь persist'ят `scanner_paused` через `setSetting('1'|'0')`. На boot `src/index.js` восстанавливает `appState.paused` из DB. Закрывает SEC-001 + PIPE-004 + BILL-003 + ADM-018 + SD-16. No schema change — re-uses existing settings table.
```

If can't find "Bundle #8" — append at end of Production posture section. Report DONE_WITH_CONCERNS describing placement.

- [ ] **Step 2: Add WORKLOG entry on top**

Open `ai-context/WORKLOG.md`. Insert new entry between header and current top entry:

```markdown
## 2026-05-28 · sonnet · Bundle #7: /api/scan admin gate + pause persistence — 4 finding'ов + 1 SD одним PR

**Цель:** Закрыть SEC-001 (manual scan privilege) + PIPE-004 (immediate timestamp visibility) + BILL-003 (free user LLM-burn) + ADM-018 (pause lost on restart) + SD-16 (pause persistence drift).

**Файлы:**
- `src/dashboard/server.js` — `_handleScan`: +admin plan check на верху (`req.user?.plan_name !== 'admin'` → 403 `reason: 'plan'`) + immediate `setSetting('lastScanStartedAt', Date.now())` перед scanFn-fire. SPA gate ✅.
- `src/admin/server.js` — `/api/scanners/pause` теперь `setSetting('scanner_paused', '1')`, `/api/scanners/resume` → `'0'`. Best-effort try/catch (in-memory всегда update'ит). SPA gate ✅.
- `src/index.js` — после `const db = ...`: restore `appState.paused = true` если `getSetting('scanner_paused') === '1'`. WARN log при restored pause: «Scanner is PAUSED (persisted from previous session). Resume via admin panel.»

**Деплой:** стандартный `deploy.ps1`. Никаких schema / env / migration изменений.

**Риски:** admin-only гейт может lock'ать test/pro user'ов, но они и так не должны иметь доступ (audit принцип). Persisted pause требует операторской дисциплины — забыл resume → бот навсегда paused. Mitigation: WARN-level boot log с suggested next action.

**Не сделано:** admin UI badge «scan in progress» (using lastScanStartedAt vs lastScanCompletedAt) — deferred, data exposed для будущей UI работы. Schema migration на отдельный `admin_state` table — settings table достаточно для 2-key footprint.
```

- [ ] **Step 3: Verify**

Run:
```bash
grep -c "Bundle #7" ai-context/SESSION_CONTEXT.md
grep -c "Bundle #7" ai-context/WORKLOG.md
grep -c "^## 2026" ai-context/WORKLOG.md
```

Expected:
- SESSION_CONTEXT: ≥1
- WORKLOG: ≥1
- WORKLOG entry count: 12 (was 11, +1 — at soft cap)

- [ ] **Step 4: Report DONE — do not commit**

If WORKLOG hit 13 due to other unrelated entries — flag for rotation.

---

## Final verification (after all 4 tasks)

- [ ] **Combined parse**

Run:
```bash
node --check src/dashboard/server.js && \
node --check src/admin/server.js && \
node --check src/index.js
```
Expected: all 3 succeed.

- [ ] **Combined SPA validator**

Run: `npm run check:spa`
Expected: both dashboard + admin SPA validators pass.

- [ ] **Bundle marker check**

Run:
```bash
grep -n "Bundle #7" src/dashboard/server.js src/admin/server.js src/index.js ai-context/*.md
```
Expected: ≥5 lines (3 src files + 2 ai-context).

- [ ] **Settings key sanity**

Run:
```bash
grep -rn "scanner_paused\|lastScanStartedAt" src/
```
Expected: ≥4 lines:
- `dashboard/server.js`: 1 (lastScanStartedAt write)
- `admin/server.js`: 2 (scanner_paused, '1' and '0')
- `index.js`: 1 (scanner_paused read)

- [ ] **Working tree summary**

Run: `git status --short`
Expected: 5 modified files (dashboard/server.js, admin/server.js, index.js, SESSION_CONTEXT.md, WORKLOG.md), plus 2 new docs (spec + plan).

---

## Post-implementation: operator deploy

Standard `deploy.ps1`. No migration, no env changes. Smoke test:

1. **Admin gate**: log into dashboard as non-admin (e.g. free plan). Try POST /api/scan via devtools → expect 403 with `reason: 'plan'`. Log in as admin → POST /api/scan → expect 202.
2. **Immediate timestamp**: as admin, trigger scan. Within 1s, query DB: `sqlite3 catalyst.db "SELECT value FROM settings WHERE key='lastScanStartedAt'"` → expect recent epoch ms.
3. **Pause persist**: admin pause via UI → `sqlite3 catalyst.db "SELECT value FROM settings WHERE key='scanner_paused'"` → `'1'`. Restart bot (`docker compose restart` or equivalent). Check boot log for `[Boot] Scanner is PAUSED...` warning. `/api/config` returns `paused: true`. Resume via UI → setting becomes `'0'`.
