import { test } from 'node:test';
import assert from 'node:assert';
import { runBounded } from '../src/analysis/scorer.js';
import Scorer from '../src/analysis/scorer.js';

function fakeDb(s = {}) {
  return { getSetting: (k, d) => (k in s ? s[k] : d), setSetting() {} };
}
const logger = { info() {}, warn() {}, error() {}, debug() {} };

test('_scoreBatchWithFallback: cli fails twice → falls back to http provider', async () => {
  const s = new Scorer({}, logger, fakeDb({ aiProvider: 'grokcli' }), null);
  s._grokSessionAlive = true;
  s.providers.xai.apiKey = 'xai-test'; // make http fallback available
  const calls = [];
  s._analyzeBatchStage1 = async (batch, metrics, sys, rt) => {
    calls.push(rt.transport);
    if (rt.transport === 'cli') throw new Error('cli boom');
    return [{ scored: true }]; // http fallback succeeds
  };
  const rt = s._getRuntimeAiConfig(); // transport cli
  const out = await s._scoreBatchWithFallback(['t'], {}, 'sys', rt);
  // cli attempted twice, then http fallback once:
  assert.deepStrictEqual(calls, ['cli', 'cli', 'http']);
  assert.deepStrictEqual(out, [{ scored: true }]);
});

test('_scoreBatchWithFallback: cli + no http key → heuristic _fallback', async () => {
  const s = new Scorer({}, logger, fakeDb({ aiProvider: 'grokcli' }), null);
  s._grokSessionAlive = true;
  // ensure NO http provider has a key
  s.providers.xai.apiKey = '';
  s.providers.openai.apiKey = '';
  s.providers.gemini.apiKey = '';
  s._analyzeBatchStage1 = async () => { throw new Error('cli boom'); };
  let fellBack = false;
  const origFallback = s._fallback.bind(s);
  s._fallback = (batch, reason) => { fellBack = true; return origFallback(batch, reason); };
  const rt = s._getRuntimeAiConfig();
  const out = await s._scoreBatchWithFallback(['t'], {}, 'sys', rt);
  assert.ok(fellBack, '_fallback (heuristic) was invoked');
  assert.ok(Array.isArray(out));
});

test('runBounded preserves input order despite out-of-order completion', async () => {
  const items = [40, 10, 30, 20];
  const work = (ms, idx) => new Promise(r => setTimeout(() => r(idx), ms));
  const out = await runBounded(items, 2, work);
  assert.deepStrictEqual(out, [0, 1, 2, 3]);
});

test('runBounded caps concurrency', async () => {
  let active = 0, peak = 0;
  const work = () => new Promise(r => { active++; peak = Math.max(peak, active); setTimeout(() => { active--; r(1); }, 20); });
  await runBounded([1,2,3,4,5,6], 2, work);
  assert.ok(peak <= 2, `peak concurrency ${peak} must be <= 2`);
});
