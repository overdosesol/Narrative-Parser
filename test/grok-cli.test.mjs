import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callGrokCli, probeGrokSession } from '../src/analysis/grok-cli.js';

// On Windows, Node's spawn() uses CreateProcess which doesn't honour the
// shebang line — only .exe/.bat/.cmd are directly executable. We create a
// .bat wrapper that calls bash so the same bash body works on both platforms.
const IS_WIN = process.platform === 'win32';

function fakeGrok({ win, posix }) {
  const dir = mkdtempSync(join(tmpdir(), 'grokfake-'));

  if (IS_WIN) {
    const p = join(dir, 'grok.bat');
    writeFileSync(p, `@echo off\r\n${win}\r\n`);
    return p;
  }
  const p = join(dir, 'grok');
  writeFileSync(p, `#!/bin/sh\n${posix}\n`);
  chmodSync(p, 0o755);
  return p;
}

test('returns stdout text on success', async () => {
  const bin = fakeGrok({
    win: 'echo {"trends":[]}',
    posix: 'echo \'{"trends":[]}\'',
  });
  const r = await callGrokCli({ bin, prompt: 'hi', timeoutMs: 5000, cwd: tmpdir() });
  assert.strictEqual(r.text.trim(), '{"trends":[]}');
  assert.strictEqual(r.inputTokens, 0);
});

test('throws on empty stdout', async () => {
  const bin = fakeGrok({
    win: 'exit /b 0',
    posix: 'exit 0',
  });
  await assert.rejects(
    () => callGrokCli({ bin, prompt: 'hi', timeoutMs: 5000, cwd: tmpdir() }),
    /empty/i
  );
});

test('throws on timeout (and kills child)', async () => {
  const bin = fakeGrok({
    win: 'ping -n 10 127.0.0.1 >nul\r\necho late',
    posix: 'sleep 10; echo late',
  });
  await assert.rejects(
    () => callGrokCli({ bin, prompt: 'hi', timeoutMs: 500, cwd: tmpdir() }),
    /timeout/i
  );
});

test('probeGrokSession true when models lists grok-build', async () => {
  const bin = fakeGrok({
    win: 'echo You are logged in with grok.com\r\necho Default model: grok-build',
    posix: 'echo "You are logged in with grok.com"; echo "Default model: grok-build"',
  });
  const alive = await probeGrokSession({ bin, timeoutMs: 5000 });
  assert.strictEqual(alive, true);
});

test('probeGrokSession false when not authenticated', async () => {
  const bin = fakeGrok({
    win: 'echo You are not authenticated.',
    posix: 'echo "You are not authenticated."',
  });
  const alive = await probeGrokSession({ bin, timeoutMs: 5000 });
  assert.strictEqual(alive, false);
});
