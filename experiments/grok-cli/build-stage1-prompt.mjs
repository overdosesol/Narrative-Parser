// Replay harness: reconstruct the EXACT production Stage 1 prompt from real
// prod trends, using the project's real prompts.js. Outputs system.txt +
// user.txt so we can feed the identical prompt to both grok-build (sandbox,
// subscription) and grok-4-1-fast (API) and compare apples-to-apples.
//
// Usage: node experiments/grok-cli/build-stage1-prompt.mjs <trends.json> <outdir>
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

// Import the REAL production prompt builders. pathToFileURL handles Windows
// drive-letter paths (F:\...) which the bare ESM loader rejects.
const { SYSTEM_PROMPT, buildAnalysisPrompt } = await import(
  pathToFileURL(path.join(REPO, 'src', 'analysis', 'prompts.js')).href
);

const [, , trendsPath, outDir] = process.argv;
if (!trendsPath || !outDir) {
  console.error('usage: node build-stage1-prompt.mjs <trends.json> <outdir>');
  process.exit(1);
}

// strip a UTF-8 BOM if PowerShell's Out-File added one
const rows = JSON.parse(fs.readFileSync(trendsPath, 'utf8').replace(/^﻿/, ''));

// Reconstruct the runtime trend object shape that buildAnalysisPrompt expects.
// In prod the trend carries `metrics` (live object) + `preStage` + `clusterMetrics`.
// On disk we have `raw_metrics` (JSON string) which holds those fields flattened.
// We map raw_metrics back into the paths buildAnalysisPrompt reads (§3 recipe).
function reconstruct(row) {
  let rm = {};
  try { rm = JSON.parse(row.raw_metrics || '{}'); } catch { /* keep {} */ }

  // metrics: the prompt reads trend.metrics.{ageHours,upvotes,comments,velocity,
  // subreddit,positionScore,views,likes,retweets,plays,...}. raw_metrics stores
  // most of these flat — pass it through as metrics (extra keys are ignored).
  const metrics = {
    ageHours: rm.ageHours,
    upvotes: rm.upvotes,
    comments: rm.comments,
    velocity: rm.velocity,
    subreddit: rm.subreddit,
    positionScore: rm.position,
    views: rm.views, likes: rm.likes, retweets: rm.retweets,
    plays: rm.plays, videoCount: rm.videoCount,
    formattedTraffic: rm.formattedTraffic, geo: rm.geo,
  };

  return {
    title: row.title,
    source: row.source,
    description: row.description || null,
    preStage: rm.preStage || null,          // null for text trends → fallback scoring
    clusterMetrics: { marketStage: rm.marketStage || 'none' },
    metrics,
    _id: row.id,
  };
}

const trends = rows.map(reconstruct);
const userPrompt = buildAnalysisPrompt(trends);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'system.txt'), SYSTEM_PROMPT, 'utf8');
fs.writeFileSync(path.join(outDir, 'user.txt'), userPrompt, 'utf8');
// Combined single-prompt form for the CLI (-p takes one string).
fs.writeFileSync(
  path.join(outDir, 'combined.txt'),
  SYSTEM_PROMPT + '\n\n=== INPUT ===\n\n' + userPrompt,
  'utf8'
);
// Reference table: id/source/title + the score prod currently has.
const ref = rows.map(r => {
  let rm = {}; try { rm = JSON.parse(r.raw_metrics || '{}'); } catch {}
  return { id: r.id, source: r.source, title: r.title,
           prod_memePotential: rm.memePotential, prod_category: r.category,
           prod_score: r.score, has_preStage: !!rm.preStage };
});
fs.writeFileSync(path.join(outDir, 'reference.json'), JSON.stringify(ref, null, 2), 'utf8');

console.log(`trends: ${trends.length}`);
console.log(`system.txt: ${SYSTEM_PROMPT.length} chars`);
console.log(`user.txt: ${userPrompt.length} chars`);
console.log(`with_preStage: ${trends.filter(t => t.preStage).length} / ${trends.length}`);
console.log(`sources: ${[...new Set(trends.map(t => t.source))].join(', ')}`);
console.log('\n--- user.txt first 700 chars ---');
console.log(userPrompt.slice(0, 700));
