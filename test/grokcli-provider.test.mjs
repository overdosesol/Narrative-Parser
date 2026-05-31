import { test } from 'node:test';
import assert from 'node:assert';
import Scorer from '../src/analysis/scorer.js';

function fakeDb(settings = {}) {
  return { getSetting: (k, d) => (k in settings ? settings[k] : d), setSetting() {} };
}
const logger = { info(){}, warn(){}, error(){}, debug(){} };

test('grokcli provider is registered with transport cli', () => {
  const s = new Scorer({}, logger, fakeDb({ aiProvider: 'grokcli' }), null);
  assert.strictEqual(s.providers.grokcli.transport, 'cli');
});

test('grokcli selected → runtime reports transport cli', () => {
  const s = new Scorer({}, logger, fakeDb({ aiProvider: 'grokcli' }), null);
  s._grokSessionAlive = true;
  const rt = s._getRuntimeAiConfig();
  assert.strictEqual(rt.provider, 'grokcli');
  assert.strictEqual(rt.transport, 'cli');
});

test('grokcli with DEAD session falls back to an http provider', () => {
  const s = new Scorer({}, logger, fakeDb({ aiProvider: 'grokcli' }), null);
  s.providers.xai.apiKey = 'xai-test';
  s._grokSessionAlive = false;
  const rt = s._getRuntimeAiConfig();
  assert.strictEqual(rt.transport, 'http');
  assert.notStrictEqual(rt.provider, 'grokcli');
});
