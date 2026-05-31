import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callGrokCli } from '../src/analysis/grok-cli.js';

// On Windows, Node's spawn() uses CreateProcess which doesn't honour the
// shebang line — only .exe/.bat/.cmd are directly executable. We create a
// .bat wrapper that calls bash so the same bash body works on both platforms.
const IS_WIN = process.platform === 'win32';

function fakeGrok(body) {
  const dir = mkdtempSync(join(tmpdir(), 'grokfake-'));
  if (IS_WIN) {
    const p = join(dir, 'grok.bat');
    // Use bash.exe (Git Bash / WSL) to run the body inline.
    writeFileSync(p, `@echo off\nbash -c "${body.replace(/"/g, '\\"')}"\n`);
    return p;
  }
  const p = join(dir, 'grok');
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test('returns stdout text on success', async () => {
  const bin = fakeGrok('echo \'{"trends":[]}\'');
  const r = await callGrokCli({ bin, prompt: 'hi', timeoutMs: 5000, cwd: tmpdir() });
  assert.strictEqual(r.text.trim(), '{"trends":[]}');
  assert.strictEqual(r.inputTokens, 0);
});

test('throws on empty stdout', async () => {
  const bin = fakeGrok('exit 0');
  await assert.rejects(
    () => callGrokCli({ bin, prompt: 'hi', timeoutMs: 5000, cwd: tmpdir() }),
    /empty/i
  );
});

test('throws on timeout (and kills child)', async () => {
  const bin = fakeGrok('sleep 10; echo late');
  await assert.rejects(
    () => callGrokCli({ bin, prompt: 'hi', timeoutMs: 500, cwd: tmpdir() }),
    /timeout/i
  );
});
