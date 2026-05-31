// Operator parity-check tool — NOT shipped prod code, NOT tested.
// Purpose: score the SAME Stage 1 prompt through both grokcli (Grok Build CLI,
// subscription) and a reference JSON file produced by build-stage1-prompt.mjs,
// then print a side-by-side per-trend comparison + mean absolute diff.
//
// Prerequisites (run on the sandbox where grok CLI is authed):
//   1. node experiments/grok-cli/build-stage1-prompt.mjs <trends.json> out/
//      → writes out/system.txt, out/user.txt, out/combined.txt, out/reference.json
//   2. node experiments/grok-cli/parity-check.mjs out/combined.txt
//      → scores via grokcli, compares against out/reference.json (if present)
//
// Optional flag:
//   --api-cmp   (reserved for future: score via HTTP API provider too; not implemented)
//
// Flags / args:
//   parity-check.mjs <combined.txt>      one-file mode (system + "=== INPUT ===" + user)
//   parity-check.mjs <system.txt> <user.txt>  two-file mode

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

// --- Parse CLI args -----------------------------------------------------------

const rawArgs = process.argv.slice(2).filter(a => a !== '--api-cmp');
if (rawArgs.length === 0 || rawArgs.length > 2) {
  console.error('usage: node parity-check.mjs <combined.txt>');
  console.error('       node parity-check.mjs <system.txt> <user.txt>');
  process.exit(1);
}

let combinedPrompt;
if (rawArgs.length === 1) {
  combinedPrompt = fs.readFileSync(rawArgs[0], 'utf8');
} else {
  const sys  = fs.readFileSync(rawArgs[0], 'utf8');
  const user = fs.readFileSync(rawArgs[1], 'utf8');
  combinedPrompt = sys + '\n\n=== INPUT ===\n\n' + user;
}

// --- Import callGrokCli -------------------------------------------------------

const { callGrokCli } = await import(
  pathToFileURL(path.join(REPO, 'src', 'analysis', 'grok-cli.js')).href
);

// --- Run grokcli --------------------------------------------------------------

// grok-build needs a writable working directory with git present.
// Use the repo root (it's a git repo and is writable on the sandbox).
const cwd = REPO;

console.log('[parity-check] running grok CLI… (may take 70-90s)');
const t0 = Date.now();
let grokRaw;
try {
  const result = await callGrokCli({ prompt: combinedPrompt, cwd, timeoutMs: 240_000 });
  grokRaw = result.text;
} catch (err) {
  console.error('[parity-check] grokcli failed:', err.message);
  process.exit(1);
}
console.log(`[parity-check] grokcli responded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// --- Parse JSON from grokcli output ------------------------------------------

function parseGrokOutput(raw) {
  // Strip ```json ... ``` fence if present
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  const jsonStr = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(jsonStr.trim());
  } catch {
    // Try to extract first {...} block
    const m = jsonStr.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Could not extract JSON from grokcli output');
  }
}

let parsed;
try {
  parsed = parseGrokOutput(grokRaw);
} catch (err) {
  console.error('[parity-check] JSON parse failed:', err.message);
  console.error('--- raw output (first 600 chars) ---');
  console.error(grokRaw.slice(0, 600));
  process.exit(1);
}

const grokTrends = parsed.trends || parsed.results || [];
if (!grokTrends.length) {
  console.error('[parity-check] no trends in grokcli response');
  console.error(JSON.stringify(parsed, null, 2).slice(0, 600));
  process.exit(1);
}

// --- Load reference.json (prod scores) if present ----------------------------

const refPath = path.join(path.dirname(rawArgs[0]), 'reference.json');
let ref = null;
if (fs.existsSync(refPath)) {
  try {
    ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
    console.log(`[parity-check] loaded reference.json (${ref.length} entries)`);
  } catch { /* ignore */ }
}

// --- Print table --------------------------------------------------------------

console.log('\n' + '='.repeat(90));

if (ref) {
  // Build lookup by title (case-insensitive fuzzy: exact first, then includes)
  const refByTitle = new Map(ref.map(r => [r.title.toLowerCase(), r]));
  const lookup = (title) =>
    refByTitle.get(title.toLowerCase()) ||
    ref.find(r => r.title.toLowerCase().includes(title.toLowerCase().slice(0, 20))) ||
    null;

  const header = ' Title'.padEnd(42) + ' Prod_MP  Grok_MP   Diff  Prod_Cat / Grok_Cat';
  console.log(header);
  console.log('-'.repeat(90));

  let totalDiff = 0;
  let matched = 0;

  for (const t of grokTrends) {
    const title = (t.title || '').slice(0, 40).padEnd(40);
    const grokMp = t.memePotential ?? '?';
    const grokCat = t.category || '?';
    const r = lookup(t.title || '');
    if (r && r.prod_memePotential != null) {
      const diff = (grokMp !== '?' ? grokMp - r.prod_memePotential : 0);
      const diffStr = (diff >= 0 ? '+' : '') + diff;
      console.log(
        ` ${title}  ${String(r.prod_memePotential).padStart(5)}    ${String(grokMp).padStart(5)}   ${diffStr.padStart(4)}  ${r.prod_category || '?'} / ${grokCat}`
      );
      if (grokMp !== '?') { totalDiff += Math.abs(diff); matched++; }
    } else {
      console.log(` ${title}      -    ${String(grokMp).padStart(5)}      -  - / ${grokCat}`);
    }
  }

  console.log('='.repeat(90));
  if (matched > 0) {
    console.log(`Mean absolute diff (memePotential): ${(totalDiff / matched).toFixed(1)} over ${matched} matched trends`);
  } else {
    console.log('No matched trends for diff calculation (title mismatch?)');
  }
} else {
  // No reference — just print grokcli scores
  console.log(' Title'.padEnd(42) + ' MemePotential  Category');
  console.log('-'.repeat(90));
  for (const t of grokTrends) {
    const title = (t.title || '').slice(0, 40).padEnd(40);
    const mp = String(t.memePotential ?? '?').padStart(11);
    const cat = t.category || '?';
    console.log(` ${title}  ${mp}  ${cat}`);
  }
  console.log('='.repeat(90));
  console.log(`(no reference.json found — run build-stage1-prompt.mjs first to get prod baseline)`);
}
