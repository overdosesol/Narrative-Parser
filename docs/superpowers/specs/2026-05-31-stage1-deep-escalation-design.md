# Stage 1 Deep Escalation (Two-Speed Scoring) — Design Spec

**Date**: 2026-05-31
**Scope**: Detect under-scored / "hard" narratives after Stage 1 and escalate them to the
existing Stage 2 deep path (`x_search`), independent of the meme-potential gate, with a hard
per-cycle cost ceiling. Optional reasoning layer behind an admin toggle (default OFF).
**Origin**: Brainstorm 2026-05-31 — see `ai-context/IDEAS.md` → "Stage 1 калибровка" option **B**.
Options A (worked examples) and C (rule distillation) are explicitly OUT of scope (parked in backlog).
**Estimated effort**: ~4–6h (firms up in the plan)

---

## 1. Goal / Problem

Stage 1 calibration (`stage1_examples` + feedback) teaches the model a **global scale** by pattern.
It works for easy trends where the pattern reads off the surface, but fails on **hard** narratives —
those needing (1) external context, (2) genuine reasoning about non-obvious potential, or
(3) a look past a misleading title. Two structural reasons:

- **Representation asymmetry.** A scored trend carries ~200–500 tokens (title + description +
  PreStage/Gemini enrichment). Calibration examples are ~30-token labels. Examples teach the
  `input → number` mapping, not *how to reason*. No amount of better calibration fixes a case
  that needs more data or more thought about *that specific trend*.
- **Stage 2 closed loop.** The deep path (`_stage2DeepDive`, `x_search`) is gated on
  `memePotential >= stage2Threshold`. A trend Stage 1 under-scores never crosses the gate, so it
  never gets the deep look that would correct the under-score. The hardest cases fall out of deep
  analysis *because* Stage 1 mishandled them.

**This spec does not try to improve calibration.** It adds a second speed: cheap Stage 1 for the
mass, a targeted deep path for the few trends that look mis-handled — *including under-scored ones* —
under a fixed cost ceiling.

Constraint: hundreds of trends/cycle, Stage 1 batches of 8, `x_search` is expensive
(~12K+ input tokens/call). Escalation must be **capped**.

---

## 2. Architecture overview

```
src/analysis/
├── scorer.js     — escalation detector (heuristic), candidate selection w/ reserve,
│                    reasoning-model switch, reads runtime settings. Core of this change.
├── prompts.js    — STAGE1_RESPONSE_SCHEMA: + needsDeeperLook (bool) + escalationReason (string);
│                    SYSTEM_PROMPT: one instruction block on when to raise the flag.
src/admin/
└── server.js     — deepReasoningEnabled toggle; (optional) cap/reserve/threshold settings;
                    escalation telemetry surfaced in pipeline UI / cost log.
ai-context/
├── SESSION_CONTEXT.md — +1 bullet under "AI stages / Stage 2 cost knobs" (new state).
├── WORKLOG.md         — entry after implementation.
└── IDEAS.md           — mark B in-progress; add Grok-cheapening research note.
```

No DB schema change. New settings use the existing generic `getSetting`/`setSetting` (string KV).
`_stage2DeepDive` itself is **not modified** — it already updates the trend in place.

---

## 3. Components

### 3.1 Heuristic detector (code, free) — `scorer.js`

A pure function over a post-Stage-1 trend. Fires on **confident under-scoring**: objective activity
is high while the model's `memePotential` is low, and the trend is not junk.

```js
// Pseudocode — initial thresholds, TUNE in plan / make runtime-tunable.
function _isUnderscored(trend) {
  const meme      = Number(trend.memePotential) || 0;
  const emergence = Number(trend.emergenceScore ?? trend.clusterMetrics?.emergenceScore) || 0;
  const viral     = Number(trend.metrics?.twitter?.viralityScore) || 0;
  const itemCount = Number(trend.clusterMetrics?.itemCount ?? (trend.items?.length || 0)) || 0;
  const junk      = Number(trend.junkPenalty ?? trend.clusterMetrics?.junkPenalty) || 0;

  if (meme >= LOW_MEME_CEIL) return false;   // model already scored it interesting — not under-scored
  if (junk >= JUNK_FLOOR)    return false;   // junk explains the low score legitimately
  const strongActivity =
        emergence >= HIGH_EMERGENCE ||
        viral     >= HIGH_VIRAL     ||
        itemCount >= BIG_CLUSTER;
  return strongActivity;
}
```

Returns a **signal strength** too (e.g. normalized max of the three activity axes) for prioritization
in §3.3. All input fields confirmed present in `scorer.js` (`computeAlertScore`, `buildAnalysisPrompt`).

### 3.2 Model self-flag — `prompts.js`

`STAGE1_RESPONSE_SCHEMA` gains two fields per trend:
- `needsDeeperLook: boolean`
- `escalationReason: string` (short, why it's uncertain; empty if flag is false)

`SYSTEM_PROMPT` gets one instruction block: raise the flag when the trend's importance is genuinely
ambiguous, when the title may hide the real story, or when judging it needs context not present.
**Note:** the flag complements but does not replace the heuristic — a *confidently* wrong score
(template "politics → 0") will NOT self-flag, which is exactly why §3.1 exists.

### 3.3 Candidate selection + budget (common pool + reserve) — `scorer.js`

Replaces the current single `stage2Candidates` filter. Same `google_trends` skip applies to **both**
groups (x_search needs a post/article URL; gtrends are bare keywords).

```js
// cap = stage2MaxCalls (existing setting, e.g. 6); reserve R = escalationReserve (e.g. 2)
const eligible   = stage1Results.filter(t => t.source?.toLowerCase() !== 'google_trends');

const highMeme   = eligible.filter(t => forceStage2 ||
                     (t.memePotential >= stage2Threshold && t.clusterMetrics?.isNovel !== false));
const highMemeSet = new Set(highMeme);

const escalated  = eligible
  .filter(t => !highMemeSet.has(t) && (_isUnderscored(t) || t.needsDeeperLook === true))
  .sort((a, b) => signalStrength(b) - signalStrength(a));   // strongest first

// Reserve R slots for escalations; any slot a group doesn't use reflows to the other.
const escTake  = Math.min(escalated.length, R);                                 // guaranteed escalation slots
const hmTake   = Math.min(highMeme.length, cap - escTake);                      // high-meme fills the rest
const escExtra = Math.min(escalated.length - escTake, cap - escTake - hmTake);  // reflow leftover to escalations
const candidates = [
  ...highMeme.slice(0, hmTake),
  ...escalated.slice(0, escTake + escExtra),
];   // length <= cap by construction
```

> The reflow math will be written cleanly in the plan with unit tests; intent: **never exceed `cap`,
> always fill `cap` if there are enough candidates, guarantee escalations up to `R`.**

Each escalated trend is tagged (e.g. `trend._escalatedBy = 'heuristic' | 'model' | 'both'`) for
telemetry and so the deep path / logs can distinguish them from normal high-meme candidates.

### 3.4 Deep path + optional reasoning toggle — `scorer.js`

The selection above feeds the **existing** `_stage2DeepDive` loop unchanged (it recomputes score
in place — the "second chance" for under-scored trends).

Reasoning layer, gated by setting `deepReasoningEnabled` (default `'0'`):
- **OFF** → `stage2Cfg.model = this.stage2Model` (`grok-4-1-fast-non-reasoning`) — pure x_search, today's behavior.
- **ON**  → `stage2Cfg.model = <reasoning Grok variant>` — a real model swap, NOT the silently-ignored
  `reasoning` param (xAI ignores it). The trend gets data (x_search) + a thinking verdict.

Read per cycle (no restart), mirroring existing `aiStage2Enabled` / `stage2Threshold` handling.

### 3.5 Admin settings + observability — `admin/server.js`

- Toggle **`deepReasoningEnabled`** (default OFF) — primary new control.
- (Optional, nice-to-have) runtime fields: `escalationReserve`, heuristic thresholds — same
  `getSetting` pattern, editable without restart.
- Telemetry: count of escalated trends/cycle split by `_escalatedBy`, added to the cost-log line and
  the `lastMetrics` object the pipeline UI reads.

---

## 4. Data flow (per cycle, inside `scoreTrends`)

```
trends → Stage 1 (batches of 8, unchanged) → stage1Results (now incl. needsDeeperLook)
        → build candidate pool:
             highMeme  = existing gate (or forceStage2)
             escalated = _isUnderscored(t) OR t.needsDeeperLook   [google_trends excluded]
             merge under cap with reserve R + reflow            (§3.3)
        → _stage2DeepDive loop over pooled candidates (unchanged)
             model = reasoning variant if deepReasoningEnabled else non-reasoning
        → text-only multiplier post-pass (unchanged)
        → return stage1Results
```

---

## 5. Cost analysis

- Worst case extra `x_search` calls/cycle = **0**. The pool shares the existing `cap` (`stage2MaxCalls`);
  escalations consume reserved slots that would otherwise reflow to high-meme. **Total x_search calls
  never exceed `cap`** — escalation re-prioritizes the existing budget, it does not add to it.
- Stage 1 output grows by 2 small fields/trend (`needsDeeperLook`, `escalationReason`) — negligible.
- Reasoning ON is the only real cost increase, and it is opt-in + reversible via the toggle.

---

## 6. Settings (runtime-tunable, generic KV)

| Key | Default | Meaning |
|---|---|---|
| `deepReasoningEnabled` | `'0'` (OFF) | Swap Stage 2 model to reasoning Grok variant on the deep path |
| `escalationReserve` | `'2'` | Slots within `stage2MaxCalls` reserved for escalations |
| `stage2MaxCalls` | (existing) | Shared cap — unchanged semantics |
| heuristic thresholds | (TBD in plan) | `LOW_MEME_CEIL` / `HIGH_EMERGENCE` / `HIGH_VIRAL` / `BIG_CLUSTER` / `JUNK_FLOOR` |

---

## 7. Open questions → resolved in the plan

1. **Exact heuristic thresholds** — derive from real cycle data; start conservative (few escalations),
   widen if it under-fires. Likely seed values written into the plan + made runtime-tunable.
2. **Reasoning Grok variant name + pricing** — tied to the operator's Grok-cheapening research
   (tracked in `IDEAS.md`). Until known, the ON branch ships but stays OFF.
3. **Escalation reason format** for logs/UI (string only vs structured).
4. **Telemetry persistence** — in-memory `lastMetrics` only (MVP) vs a DB counter (later).

---

## 8. Out of scope

- **Option A** (worked examples: labels → reasoned mini-walkthroughs) — backlog; good follow-up as
  "fuel" for the reasoning branch once ON.
- **Option C** (distilling feedback+examples into rules) — backlog; calibration hygiene, unrelated to hard cases.
- Escalating `google_trends` (bare-keyword) trends — x_search can't deep-dive them; a reasoning-only
  path for URL-less trends is a possible future extension.
- Reasoning enabled by default — stays OFF until cost is confirmed.
