/**
 * Smoke test for Stage 0 PreStage modules.
 *
 * Runs real API calls with whatever credentials are in .env. Reports clearly:
 *   ✓  module works as expected
 *   ✗  module disabled (key missing) — not a failure, just config
 *   ✗  module errored — shows the actual error so you can debug
 *
 * Usage from project root:
 *   node scripts/test-prestage.js
 */

// dotenv is optional — fall back to manual .env parsing if the package
// isn't installed (e.g. running this on the host outside Docker where
// node_modules doesn't exist). Inside the bot container env vars are
// already injected so neither path is needed.
try { await import('dotenv/config'); }
catch {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const envPath = path.resolve(here, '..', '.env');
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch (e) { /* ignore — env vars may be injected by container */ }
}

import { NanoClassifier } from '../src/analysis/nano-classifier.js';
import { GeminiCaptioner } from '../src/analysis/gemini-captioner.js';
import { PreStage } from '../src/analysis/pre-stage.js';

const logger = {
  info:  (m) => console.log('  [info] ' + m),
  warn:  (m) => console.log('  [warn] ' + m),
  error: (m) => console.log('  [error] ' + m),
  debug: () => {},
};

function bar(label) {
  console.log('\n' + '━'.repeat(70));
  console.log(label);
  console.log('━'.repeat(70));
}

// ── Test fixtures ──────────────────────────────────────────────────────────
// Three trends covering the matrix: text-only, image, video.
const fixtures = [
  {
    title: 'Cat caught stealing fish from market #catstheif',
    description: 'Reddit post with cat meme image',
    source: 'reddit',
    metrics: {
      imageUrls: ['https://i.redd.it/some-cat-image.jpg'],   // doesn't have to exist for nano test
    },
  },
  {
    title: 'Tree Test 1 #comingtothetree #tungtungtungsahur #tungsahur',
    description: '',
    source: 'tiktok',
    // Real public TikTok thumbnail — Gemini should describe it
    metrics: {
      imageUrls: ['https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png'],
    },
  },
  {
    title: 'Wojak crying when SOL dump',
    description: 'Twitter post, no image',
    source: 'twitter',
  },
];

const VIDEO_FIXTURE = {
  title: 'Big Buck Bunny — short open-source video clip',
  source: 'reddit',
  // Public sample MP4 hosted by Google. With STAGE0_VIDEO_NATIVE=1 (default)
  // and GOOGLE_AI_API_KEY set, the captioner downloads the video, base64-
  // encodes it, and sends it to Gemini's native generateContent endpoint.
  // Without those, falls back to poster image via OpenRouter.
  videoUrl: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
  metrics: {
    imageUrls: ['https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png'],
  },
};

// ── Test 1: NanoClassifier ─────────────────────────────────────────────────
async function testNano() {
  bar('TEST 1 — NanoClassifier (gpt-5.4-nano text enrichment)');
  const nano = new NanoClassifier({}, logger);

  if (!nano.enabled) {
    console.log('  ✗  DISABLED — OPENAI_API_KEY missing from .env');
    return false;
  }

  console.log('  Model: ' + nano.model);
  console.log('  Sending 3 fixture trends...');

  const t0 = Date.now();
  const results = await nano.classifyBatch(fixtures);
  const elapsed = Date.now() - t0;

  console.log('  Elapsed: ' + elapsed + 'ms');
  console.log('  Got: ' + results.filter(Boolean).length + '/' + fixtures.length + ' enriched\n');

  results.forEach((r, i) => {
    console.log('  [' + (i + 1) + '] "' + fixtures[i].title.slice(0, 50) + '..."');
    if (!r) { console.log('      → null (failed)\n'); return; }
    console.log('      topicSummary:    ' + r.topicSummary);
    console.log('      entities:        ' + JSON.stringify(r.entityCanonical));
    console.log('      language:        ' + r.language);
    console.log('      slangDecoded:    ' + (r.slangDecoded || '(empty)'));
    console.log('');
  });

  return results.every(Boolean);
}

// ── Test 2: GeminiCaptioner (image) ────────────────────────────────────────
async function testGeminiImage() {
  bar('TEST 2 — GeminiCaptioner (image via OpenRouter → Gemini Flash)');
  const gemini = new GeminiCaptioner({}, logger);

  if (!gemini.enabled) {
    console.log('  ✗  DISABLED — OPENROUTER_API_KEY missing from .env');
    return false;
  }

  console.log('  Primary model:  ' + gemini.primaryModel);
  console.log('  Fallback model: ' + gemini.fallbackModel);
  console.log('  Sending fixture trend with image URL...');

  const t0 = Date.now();
  const result = await gemini.captionTrend(fixtures[1]);   // TikTok fixture has image
  const elapsed = Date.now() - t0;

  console.log('  Elapsed: ' + elapsed + 'ms');
  console.log('  Active model after call: ' + gemini._activeModel);

  if (!result) {
    console.log('  ✗  Got null — check warn log above for reason');
    return false;
  }

  console.log('  ✓  visualCaption:  ' + result.visualCaption);
  console.log('     visibleText:    ' + (result.visibleText || '(empty)'));
  console.log('     mood:           ' + (result.mood || '(empty)'));
  console.log('     mediaType:      ' + result.mediaType);
  console.log('     videoTruncated: ' + result.videoTruncated);

  return true;
}

// ── Test 3: GeminiCaptioner — native video via direct Google AI API ───────
async function testGeminiVideo() {
  bar('TEST 3 — GeminiCaptioner (native video via Direct Google AI)');
  const gemini = new GeminiCaptioner({}, logger);

  if (!gemini.enabled) {
    console.log('  ✗  DISABLED — skipping');
    return false;
  }

  console.log('  STAGE0_VIDEO_NATIVE=' + (gemini.tryNativeVideo ? '1' : '0'));
  console.log('  GOOGLE_AI_API_KEY:   ' + (gemini.googleAiKey ? 'set' : '(missing)'));
  console.log('  canDoNativeVideo:    ' + gemini.canDoNativeVideo);
  console.log('  Video model:         ' + gemini.googleAiVideoModel);
  console.log('  videoMaxSec=' + gemini.videoMaxSec + 's, videoMaxMb=' + gemini.videoMaxMb + 'MB\n');

  if (gemini.canDoNativeVideo) {
    console.log('  Expected: download video → base64 → Gemini direct → caption');
    console.log('  videoTruncated should be FALSE (sent video natively)\n');
  } else {
    console.log('  Expected: fall back to poster image via OpenRouter');
    console.log('  videoTruncated should be TRUE\n');
  }

  const t0 = Date.now();
  const result = await gemini.captionTrend(VIDEO_FIXTURE);
  const elapsed = Date.now() - t0;

  console.log('  Elapsed: ' + elapsed + 'ms');

  if (!result) {
    console.log('  ✗  Got null — check warn log above');
    return false;
  }

  const usedNative = !result.videoTruncated;
  console.log('  ' + (usedNative ? '✓  NATIVE VIDEO PATH' : '⚠  POSTER FALLBACK PATH'));
  console.log('     visualCaption:    ' + result.visualCaption);
  console.log('     videoSummary:     ' + (result.videoSummary || '(empty)'));
  console.log('     videoTruncated:   ' + result.videoTruncated);
  console.log('     videoDurationSec: ' + (result.videoDurationSec === null ? 'null (poster path)' : result.videoDurationSec));
  console.log('     mood:             ' + result.mood);

  return true;
}

// ── Test 4: PreStage orchestrator ──────────────────────────────────────────
async function testOrchestrator() {
  bar('TEST 4 — PreStage orchestrator (parallel nano + gemini)');
  const nano = new NanoClassifier({}, logger);
  const gemini = new GeminiCaptioner({}, logger);
  const preStage = new PreStage(logger, { nanoClassifier: nano, geminiCaptioner: gemini });

  if (!preStage.enabled) {
    console.log('  ✗  DISABLED — both sub-stages missing keys');
    return false;
  }

  // Fresh copies — orchestrator mutates in-place
  const trends = JSON.parse(JSON.stringify(fixtures));

  const t0 = Date.now();
  await preStage.enrichBatch(trends);
  const elapsed = Date.now() - t0;

  console.log('  Elapsed: ' + elapsed + 'ms (nano + gemini run in parallel)');

  trends.forEach((t, i) => {
    console.log('\n  [' + (i + 1) + '] "' + t.title.slice(0, 50) + '..."');
    if (!t.preStage) { console.log('      → preStage: null'); return; }
    console.log('      nano:   ' + (t.preStage.nano ? '✓' : '✗ failed'));
    console.log('      gemini: ' + (t.preStage.gemini ? '✓' : '✗ failed/skipped'));
  });

  // Test idempotency: second call should be a no-op
  const t1 = Date.now();
  await preStage.enrichBatch(trends);
  const elapsed2 = Date.now() - t1;
  console.log('\n  Idempotency check (second call): ' + elapsed2 + 'ms');
  console.log('  ' + (elapsed2 < 100 ? '✓  skipped — already enriched' : '✗  re-ran — idempotency broken'));

  return true;
}

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  Stage 0 PreStage — smoke tests                                      ║');
  console.log('║  Reports each sub-stage independently. Failures show actual errors.  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const results = {
    nano:        await testNano(),
    geminiImage: await testGeminiImage(),
    geminiVideo: await testGeminiVideo(),
    orchestrator: await testOrchestrator(),
  };

  bar('SUMMARY');
  Object.entries(results).forEach(([k, ok]) => {
    console.log('  ' + (ok ? '✓' : '✗') + '  ' + k);
  });

  const allOk = Object.values(results).every(Boolean);
  console.log('\n' + (allOk ? '✅ All sub-stages working.' : '⚠️  Some sub-stages failed — see details above.'));
  process.exit(allOk ? 0 : 1);
})();
