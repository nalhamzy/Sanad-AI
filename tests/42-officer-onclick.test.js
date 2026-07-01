// Regression: officer.html's main script is an IIFE, so any function referenced
// from an inline onclick="fn(...)" MUST be exposed on window — otherwise the
// click throws "fn is not defined" and the button silently does nothing.
// Prod bug: «⬆ إرسال للمواطن» (uploadIssued) + «🗑» (deleteIssued) were never
// exposed → the attachment never sent, with no feedback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, '..', 'public', 'officer.html'), 'utf8');

// Globals that are legitimately available without a window.* assignment.
const ALLOWED_GLOBALS = new Set(['fetch', 'alert', 'confirm', 'open', 'print']);

test('every inline onclick handler defined in officer.html is exposed on window', () => {
  const onclick = new Set([...html.matchAll(/onclick="([a-zA-Z_][\w]*)\s*\(/g)].map(m => m[1]));
  const exposed = new Set([...html.matchAll(/window\.([a-zA-Z_][\w]*)\s*=/g)].map(m => m[1]));
  const defined = new Set([...html.matchAll(/(?:async\s+)?function\s+([a-zA-Z_][\w]*)\s*\(/g)].map(m => m[1]));

  const broken = [...onclick].filter(fn => defined.has(fn) && !exposed.has(fn) && !ALLOWED_GLOBALS.has(fn));
  assert.deepEqual(broken, [], `these onclick handlers are IIFE-scoped but not exposed on window: ${broken.join(', ')}`);
});

test('the issued-document buttons specifically are wired', () => {
  assert.match(html, /window\.uploadIssued\s*=/, 'uploadIssued must be exposed (⬆ إرسال للمواطن)');
  assert.match(html, /window\.deleteIssued\s*=/, 'deleteIssued must be exposed (🗑)');
});
