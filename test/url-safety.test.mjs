import test from 'node:test';
import assert from 'node:assert/strict';

import { escHtmlAttr, safeHref, safeUrl } from '../src/utils/url-safety.js';

test('safeUrl accepts only http and https URLs', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('http://localhost:8080/api/health'), 'http://localhost:8080/api/health');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeUrl('/relative/path'), null);
});

test('safeHref escapes valid URLs and falls back for unsafe values', () => {
  assert.equal(
    safeHref('https://example.com/?q="x"&tag=<meme>'),
    'https://example.com/?q=&quot;x&quot;&amp;tag=&lt;meme&gt;',
  );
  assert.equal(safeHref('file:///etc/passwd'), '#');
});

test('escHtmlAttr escapes attribute-sensitive characters', () => {
  assert.equal(escHtmlAttr(`"'><&`), '&quot;&#39;&gt;&lt;&amp;');
});
