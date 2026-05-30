# Stage 1 Deep Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Escalate under-scored / model-flagged "hard" trends to the existing Stage 2 deep path (x_search) independent of the meme-potential gate, under a fixed per-cycle cost ceiling, with an opt-in reasoning layer behind an admin toggle (default OFF).

**Architecture:** Pure detection functions (heuristic + signal strength) and a candidate-selection function (common pool + reserve + reflow) added to `scorer.js`; Stage 1 schema/prompt gain a `needsDeeperLook` self-flag; `scoreTrends` swaps its `stage2Candidates` filter for the new selector and switches the Stage 2 model when reasoning is enabled; admin gets a toggle + model/reserve settings. `_stage2DeepDive` is reused unchanged. Spec: `docs/superpowers/specs/2026-05-31-stage1-deep-escalation-design.md`.

**Tech Stack:** Node ESM, better-sqlite3 (generic `getSetting`/`setSetting` KV — no schema change), inline-React admin SPA. No test framework in repo → tests are ephemeral `node:assert` `.mjs` scripts run via `node`, deleted before the task's commit (matches repo convention).

---

## Pre-flight (read once before starting)

- **`src/admin/server.js` is an inline-React SPA inside a template literal.** After ANY edit to it, run `npm run check:spa` — a stray backtick / bad escape = black screen. This is a hard gate (CLAUDE.md).
- **Commits stay on the working branch.** Push + production deploy are done by the operator via `deploy.ps1` — do NOT deploy, and do NOT commit to `main` without an explicit request. Frequent local commits on the feature branch are expected.
- **No DB schema migration** — all new config uses existing `db.getSetting(key, default)` / `db.setSetting(key, val)` (string values).
- Module-level helpers in `scorer.js` (e.g. `computeAlertScore`, `narrativePhase`, `applyTextOnlyMultiplier`) are the pattern to follow for the new exported functions.

**File Structure:**
- Modify: `src/analysis/scorer.js` — detection + selection functions, wiring in `scoreTrends`, model switch, telemetry
- Modify: `src/analysis/prompts.js:270-366` — `STAGE1_RESPONSE_SCHEMA` + `SYSTEM_PROMPT` self-flag
- Modify: `src/admin/server.js` — toggle + settings (UI ~L3286 pattern, backend ~L648 pattern)
- Docs: `ai-context/SESSION_CONTEXT.md`, `ai-context/WORKLOG.md`, `ai-context/IDEAS.md`
- Temp tests: `test-escalation.mjs` (created + deleted within Tasks 1-2)

---

## Task 1: Heuristic detection functions (pure, in `scorer.js`)

**Files:**
- Modify: `src/analysis/scorer.js` (add module-level exports near `computeAlertScore`)
- Test: `test-escalation.mjs` (repo root, temporary)

- [ ] **Step 1: Write the failing test**

Create `test-escalation.mjs`:

```js
import assert from 'node:assert';
import { isUnderscored, escalationSignalStrength, DEFAULT_ESCALATION_THRESHOLDS } from './src/analysis/scorer.js';

// under-scored: model said meh (40) but cluster is surging hard, not junk → escalate
assert.strictEqual(isUnderscored({ memePotential: 40, emergenceScore: 80, junkPenalty: 5 }), true, 'surging + low meme → escalate');
// high meme: model already interested → not under-scored
assert.strictEqual(isUnderscored({ memePotential: 75, emergenceScore: 90 }), false, 'high meme → no escalate');
// junk explains the low score → not under-scored
assert.strictEqual(isUnderscored({ memePotential: 30, emergenceScore: 90, junkPenalty: 60 }), false, 'junk → no escalate');
// low everything → nothing to escalate
assert.strictEqual(isUnderscored({ memePotential: 20, emergenceScore: 10, junkPenalty: 0 }), false, 'quiet → no escalate');
// virality axis alone triggers
assert.strictEqual(isUnderscored({ memePotential: 10, metrics: { twitter: { viralityScore: 70 } } }), true, 'viral axis → escalate');
// big cluster axis alone triggers
assert.strictEqual(isUnderscored({ memePotential: 10, clusterMetrics: { itemCount: 12 } }), true, 'cluster axis → escalate');
// signal strength = max of normalized axes
assert.strictEqual(escalationSignalStrength({ emergenceScore: 80, metrics: { twitter: { viralityScore: 60 } } }), 80, 'strength = max axis');

console.log('PASS: Task 1 — heuristic detection');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-escalation.mjs`
Expected: FAIL — `SyntaxError`/`does not provide an export named 'isUnderscored'`.

- [ ] **Step 3: Implement (add to `src/analysis/scorer.js`, module scope near other helpers)**

```js
// ─── Deep-escalation detection (Stage 1 → Stage 2 second-chance) ───────────
// Conservative seed thresholds. Runtime-overridable via settings in scoreTrends.
export const DEFAULT_ESCALATION_THRESHOLDS = {
  lowMemeCeil:   50,  // model meme >= this → already "interesting", not under-scored
  highEmergence: 65,  // cluster emergenceScore (0-100)
  highViral:     60,  // metrics.twitter.viralityScore (0-100)
  bigCluster:    8,   // clusterMetrics.itemCount (post count in the narrative)
  junkFloor:     40,  // junkPenalty >= this → low score is legitimately explained by junk
};

function _emergence(t) { return Number(t.emergenceScore ?? t.clusterMetrics?.emergenceScore) || 0; }
function _viral(t)     { return Number(t.metrics?.twitter?.viralityScore) || 0; }
function _itemCount(t) { return Number(t.clusterMetrics?.itemCount ?? (Array.isArray(t.items) ? t.items.length : 0)) || 0; }
function _junk(t)      { return Number(t.junkPenalty ?? t.clusterMetrics?.junkPenalty) || 0; }

// Strongest objective-activity axis, normalized to ~0-100 (itemCount * 10, capped).
export function escalationSignalStrength(trend) {
  return Math.max(_emergence(trend), _viral(trend), Math.min(100, _itemCount(trend) * 10));
}

// "Confident under-scoring": objective activity high, model meme low, not junk.
export function isUnderscored(trend, th = DEFAULT_ESCALATION_THRESHOLDS) {
  const meme = Number(trend.memePotential) || 0;
  if (meme >= th.lowMemeCeil) return false;
  if (_junk(trend) >= th.junkFloor) return false;
  return _emergence(trend) >= th.highEmergence ||
         _viral(trend)     >= th.highViral     ||
         _itemCount(trend) >= th.bigCluster;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-escalation.mjs`
Expected: `PASS: Task 1 — heuristic detection`

- [ ] **Step 5: Commit** (keep `test-escalation.mjs` for Task 2)

```bash
git add src/analysis/scorer.js
git commit -m "feat(scorer): add deep-escalation heuristic detection"
```

---

## Task 2: Candidate selection — common pool + reserve + reflow (pure)

**Files:**
- Modify: `src/analysis/scorer.js` (add `selectDeepDiveCandidates` near Task 1 helpers)
- Test: `test-escalation.mjs` (extend)

- [ ] **Step 1: Write the failing test** — append to `test-escalation.mjs` before the final `console.log`:

```js
import { selectDeepDiveCandidates } from './src/analysis/scorer.js';

const hm = (id, meme) => ({ id, memePotential: meme, source: 'twitter', clusterMetrics: { isNovel: true } });
const esc = (id) => ({ id, memePotential: 20, source: 'twitter', emergenceScore: 90 }); // under-scored
const gt = (id) => ({ id, memePotential: 20, source: 'google_trends', emergenceScore: 90 });

// cap respected, reserve guarantees escalation slots
{
  const pool = [hm(1,90),hm(2,85),hm(3,80),hm(4,75),hm(5,70),hm(6,65), esc(7),esc(8)];
  const out = selectDeepDiveCandidates({ stage1Results: pool, stage2Threshold: 60, cap: 6, reserve: 2 });
  assert.strictEqual(out.length, 6, 'never exceeds cap');
  assert.strictEqual(out.filter(t => t._deepDiveReason === 'escalation').length, 2, 'reserve honored');
}
// reflow: no escalations → all slots go to high-meme
{
  const pool = [hm(1,90),hm(2,85),hm(3,80)];
  const out = selectDeepDiveCandidates({ stage1Results: pool, stage2Threshold: 60, cap: 6, reserve: 2 });
  assert.strictEqual(out.length, 3, 'unused reserve reflows to high-meme');
  assert.strictEqual(out.every(t => t._deepDiveReason === 'high_meme'), true);
}
// reflow: no high-meme → escalations may exceed reserve up to cap
{
  const pool = [esc(1),esc(2),esc(3),esc(4)];
  const out = selectDeepDiveCandidates({ stage1Results: pool, stage2Threshold: 60, cap: 6, reserve: 2 });
  assert.strictEqual(out.length, 4, 'escalations reflow into empty high-meme slots');
}
// google_trends excluded from both groups
{
  const out = selectDeepDiveCandidates({ stage1Results: [gt(1), hm(2,90)], stage2Threshold: 60, cap: 6, reserve: 2 });
  assert.strictEqual(out.find(t => t.id === 1), undefined, 'google_trends never deep-dived');
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-escalation.mjs`
Expected: FAIL — `does not provide an export named 'selectDeepDiveCandidates'`.

- [ ] **Step 3: Implement (add to `src/analysis/scorer.js`)**

```js
// Build the Stage 2 deep-dive candidate list: high-meme (existing gate) + escalated
// (under-scored or model-flagged), under a shared `cap` with `reserve` slots held for
// escalations. Unused slots in either group reflow to the other. Tags each pick with
// `_deepDiveReason` for telemetry. google_trends excluded (x_search needs a URL).
export function selectDeepDiveCandidates({ stage1Results, stage2Threshold, cap, reserve, forceStage2 = false, thresholds }) {
  const eligible = stage1Results.filter(t => (t.source || '').toLowerCase() !== 'google_trends');

  const highMeme = eligible.filter(t => forceStage2 ||
    ((Number(t.memePotential) || 0) >= stage2Threshold && t.clusterMetrics?.isNovel !== false));
  const highMemeSet = new Set(highMeme);

  const escalated = eligible
    .filter(t => !highMemeSet.has(t) && (isUnderscored(t, thresholds) || t.needsDeeperLook === true))
    .sort((a, b) => escalationSignalStrength(b) - escalationSignalStrength(a));

  const R       = Math.max(0, Math.min(reserve, cap));
  const escTake = Math.min(escalated.length, R);
  const hmTake  = Math.min(highMeme.length, cap - escTake);
  const escExtra = Math.min(escalated.length - escTake, cap - escTake - hmTake);

  const picks = [
    ...highMeme.slice(0, hmTake).map(t => { t._deepDiveReason = 'high_meme'; return t; }),
    ...escalated.slice(0, escTake + escExtra).map(t => { t._deepDiveReason = 'escalation'; return t; }),
  ];
  return picks; // length <= cap by construction
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-escalation.mjs`
Expected: both `PASS` lines print, exit 0.

- [ ] **Step 5: Delete temp test + commit**

```bash
rm test-escalation.mjs
git add src/analysis/scorer.js
git commit -m "feat(scorer): add deep-dive candidate selection (pool + reserve + reflow)"
```

---

## Task 3: Stage 1 self-flag — schema + prompt (`prompts.js`)

**Files:**
- Modify: `src/analysis/prompts.js:280-366` (`STAGE1_RESPONSE_SCHEMA`) and `:36` (`SYSTEM_PROMPT`)

- [ ] **Step 1: Add fields to the `required` array** (`prompts.js`, the `required: [...]` block ending at `'scoreOverride',`). Append:

```js
          'scoreOverride',
          'needsDeeperLook',
          'escalationReason',
```

- [ ] **Step 2: Add the two properties** — insert after the `scoreOverride: { ... }` property block (before the closing `},` of `properties` at L362):

```js
          needsDeeperLook: { type: 'boolean' },
          escalationReason: { type: 'string', maxLength: 200, description: 'If needsDeeperLook is true, one short reason; else empty string' },
```

- [ ] **Step 3: Add the prompt instruction** — read `SYSTEM_PROMPT` (`prompts.js:36`), locate the block that describes the output fields (where `isGenuinelyInteresting` / `scoreOverride` are explained), and append this paragraph there:

```
- needsDeeperLook: set true when this trend's importance is genuinely AMBIGUOUS — the title may hide the real story, judging it needs context you don't have, or it could be bigger than the surface suggests. Put a short why in escalationReason. Do NOT set it just because a score is high; this flags UNCERTAINTY, not interest. When unsure, false + empty string.
```

- [ ] **Step 4: Verify schema still parses**

Run: `node -e "import('./src/analysis/prompts.js').then(m=>{const r=m.STAGE1_RESPONSE_SCHEMA.properties.trends.items;if(!r.properties.needsDeeperLook||!r.required.includes('escalationReason'))throw new Error('missing fields');console.log('PASS: schema has self-flag fields');})"`
Expected: `PASS: schema has self-flag fields`

- [ ] **Step 5: Commit**

```bash
git add src/analysis/prompts.js
git commit -m "feat(prompts): add needsDeeperLook self-flag to Stage 1 schema + prompt"
```

---

## Task 4: Wire into `scoreTrends` + reasoning model switch (`scorer.js`)

**Files:**
- Modify: `src/analysis/scorer.js` (`scoreTrends`, the `stage2Candidates` block ~L672-680; `stage2Cfg` ~L687-693; telemetry ~L745-752)

- [ ] **Step 1: Replace the `stage2Candidates` filter** (currently `stage1Results.filter(...).slice(0, stage2MaxCalls)` at ~L672-680) with the new selector + settings reads. Right after `stage2MaxCalls` is read (~L662):

```js
    const escalationReserve = readNum('escalationReserve', 2);
    const escThresholds = {
      lowMemeCeil:   readNum('escLowMemeCeil',   DEFAULT_ESCALATION_THRESHOLDS.lowMemeCeil),
      highEmergence: readNum('escHighEmergence', DEFAULT_ESCALATION_THRESHOLDS.highEmergence),
      highViral:     readNum('escHighViral',     DEFAULT_ESCALATION_THRESHOLDS.highViral),
      bigCluster:    readNum('escBigCluster',    DEFAULT_ESCALATION_THRESHOLDS.bigCluster),
      junkFloor:     readNum('escJunkFloor',     DEFAULT_ESCALATION_THRESHOLDS.junkFloor),
    };

    const stage2Candidates = selectDeepDiveCandidates({
      stage1Results,
      stage2Threshold,
      cap: stage2MaxCalls,
      reserve: escalationReserve,
      forceStage2,
      thresholds: escThresholds,
    });
```

(Remove the old `const stage2Candidates = stage1Results.filter(...).slice(...)` block it replaces.)

- [ ] **Step 2: Reasoning model switch** — replace the hardcoded `model: this.stage2Model` in `stage2Cfg` (~L691) with a per-cycle resolved model:

```js
      const reasoningOn    = String(this.db?.getSetting?.('deepReasoningEnabled', '0')) === '1';
      const reasoningModel = (this.db?.getSetting?.('stage2ReasoningModel', '') || '').trim();
      const deepModel      = (reasoningOn && reasoningModel) ? reasoningModel : this.stage2Model;
```

Then in `stage2Cfg` use `model: deepModel`, and update the log line (~L700) to mention `deepModel` + reasoning state.

- [ ] **Step 3: Telemetry** — add escalation counts to `lastMetrics` (~L745) and the cost-log line (~L732):

```js
      stage2HighMeme:    stage2Candidates.filter(t => t._deepDiveReason === 'high_meme').length,
      stage2Escalated:   stage2Candidates.filter(t => t._deepDiveReason === 'escalation').length,
      deepReasoning:     String(this.db?.getSetting?.('deepReasoningEnabled', '0')) === '1',
```

- [ ] **Step 4: Verify syntax + functions intact**

Run: `node --check src/analysis/scorer.js`
Expected: no output, exit 0.
Run: `node -e "import('./src/analysis/scorer.js').then(m=>{if(typeof m.selectDeepDiveCandidates!=='function')throw new Error('export broken');console.log('PASS: scorer exports intact');})"`
Expected: `PASS: scorer exports intact`

> Full pipeline integration (real Stage 1 → escalation → x_search) is verified on the first live cycle after the operator deploys — there is no API harness in-repo. Watch the cost-log line for `stage2Escalated=N`.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/scorer.js
git commit -m "feat(scorer): route escalated trends into Stage 2 + reasoning model toggle"
```

---

## Task 5: Admin toggle + settings (`admin/server.js`)

**Files:**
- Modify: `src/admin/server.js` — backend setSetting block (~L644-649 pattern) + UI toggle (~L3286 `nanoEnabled` pattern, in the AI / Stage 2 settings section ~L3197)

- [ ] **Step 1: Backend persistence** — in the AI-config update handler (next to where `aiStage2Enabled` is saved, ~L645-648), persist the new keys when present in the request body:

```js
    if (body.deepReasoningEnabled !== undefined) {
      const on = body.deepReasoningEnabled === true || body.deepReasoningEnabled === '1' || body.deepReasoningEnabled === 'true';
      this.db.setSetting('deepReasoningEnabled', on ? '1' : '0');
    }
    if (typeof body.stage2ReasoningModel === 'string') {
      this.db.setSetting('stage2ReasoningModel', body.stage2ReasoningModel.trim());
    }
    if (body.escalationReserve !== undefined && body.escalationReserve !== '') {
      this.db.setSetting('escalationReserve', String(parseInt(body.escalationReserve, 10) || 2));
    }
```

(Match the exact body-field source and method shape used by the surrounding `aiStage2Enabled` handler — read ~20 lines around L644 first.)

- [ ] **Step 2: Expose current values on the config GET** — wherever the AI-config read returns settings to the SPA, add `deepReasoningEnabled`, `stage2ReasoningModel`, `escalationReserve` via `getSetting` with defaults `'0' / '' / '2'`.

- [ ] **Step 3: UI** — in the Stage 2 settings section (~L3197), add a toggle by copying the existing `nanoEnabled` toggle structure (~L3286-3291): a `label.toggle` + checkbox bound to `deepReasoningEnabled`, a small text input for `stage2ReasoningModel` (placeholder "grok reasoning model id"), and a number input for `escalationReserve`. Wire their `onChange` into the same save path the other AI settings use. Add a hint line: reasoning is OFF until a model id is set + toggle on.

- [ ] **Step 4: SPA syntax gate (MANDATORY)**

Run: `npm run check:spa`
Expected: both checks pass (`check-dashboard-spa` + `check-admin-spa`). If it fails, fix the template-literal/backtick issue before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/admin/server.js
git commit -m "feat(admin): deep-reasoning toggle + escalation reserve/model settings"
```

---

## Task 6: Docs (state + worklog + backlog)

**Files:**
- Modify: `ai-context/SESSION_CONTEXT.md` (AI stages / Stage 2 section), `ai-context/WORKLOG.md` (new entry on top), `ai-context/IDEAS.md` (mark B shipped)

- [ ] **Step 1: SESSION_CONTEXT** — under the AI-stages / Stage 2 cost-knobs area, add a concise bullet describing the escalation path (state, not history): deep-dive candidates = high-meme gate ∪ escalated (under-scored heuristic OR `needsDeeperLook`), shared `stage2MaxCalls` cap with `escalationReserve` slots; reasoning behind `deepReasoningEnabled` (model swap to `stage2ReasoningModel`, default OFF). List the new setting keys in the Env/settings area.

- [ ] **Step 2: WORKLOG** — add an entry on top (date · model · goal · files · deploy · risks) per `AGENT_RULES §4`. Note: operator deploys via `deploy.ps1`; reasoning ships OFF.

- [ ] **Step 3: IDEAS** — flip the B heading to `[✅ SHIPPED <date>]`, leave A and C as-is.

- [ ] **Step 4: Verify worklog rotation** — if `## 2026-` headings now exceed 12, rotate per `AGENT_RULES §6`. Otherwise skip.

- [ ] **Step 5: Commit**

```bash
git add ai-context/
git commit -m "docs: stage-1 deep escalation — context, worklog, backlog"
```

---

## Self-review checklist (done while writing)

- **Spec coverage:** detection (§3.1→T1), self-flag (§3.2→T3), selection+budget (§3.3→T2,T4), deep path+reasoning (§3.4→T4), admin+telemetry (§3.5→T5), docs (→T6). ✓
- **Types consistent:** `isUnderscored`, `escalationSignalStrength`, `selectDeepDiveCandidates`, `_deepDiveReason`, `DEFAULT_ESCALATION_THRESHOLDS` used identically across T1/T2/T4. ✓
- **No placeholders:** thresholds have concrete seed values; reasoning-model unknown is handled by the `stage2ReasoningModel` empty-string guard (ships OFF), not a TODO. ✓
- **Reflow math:** `escExtra` fills only slots high-meme left empty; `escTake + hmTake + escExtra <= cap`. ✓
```
