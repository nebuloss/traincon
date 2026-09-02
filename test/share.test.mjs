// Copying a train's link.
//
// The address bar already holds it: opening a train pushes its URL, which is
// what makes one shareable at all. So the button copies location.href rather
// than assembling a second version of the same link that could drift from it.
//
// The Clipboard API needs a secure context, which the site has but a local
// install over plain HTTP does not — hence a fallback, and a last resort that
// puts the link in front of the reader rather than letting the button appear
// to do nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = await readFile(path.join(ROOT, 'src/App.ts'), 'utf8');
const modal = await readFile(path.join(ROOT, 'src/components/TrainModal.ts'), 'utf8');
const i18n = await readFile(path.join(ROOT, 'src/core/I18n.ts'), 'utf8');
const css = await readFile(path.join(ROOT, 'src/style.css'), 'utf8');

test('the modal offers it, beside the favourite button', () => {
  assert.match(modal, /data-act="share"/, 'a share action');
  assert.match(modal, /tr\('ov\.share'\)/, 'labelled from the translations');

  // Both live in .m-actions, which lays buttons out in a wrapping row — so a
  // second one needs no styling of its own, but the row has to actually wrap.
  const actions = css.slice(css.indexOf('.m-actions {'));
  assert.match(actions.slice(0, 200), /display: flex/);
  assert.match(actions.slice(0, 200), /flex-wrap: wrap/);
});

test('the click is handled', () => {
  assert.match(
    app,
    /act\?\.dataset\['act'\] === 'share'/,
    'the action is dispatched like the others',
  );
  assert.match(app, /private async shareLink\(\): Promise<void>/, 'and it has a handler');
});

test('it copies the URL the reader is actually on', () => {
  // Rebuilding the link risks disagreeing with the address bar — a different
  // tab, a missing prefix — and the reader would have no way to tell.
  const fn = app.slice(app.indexOf('private async shareLink('));
  const body = fn.slice(0, fn.indexOf('\n  private closeTrain'));
  assert.match(body, /const url = location\.href;/, 'the link is the current URL');
  assert.match(body, /navigator\.clipboard\.writeText\(url\)/, 'copied through the modern API');
});

test('a non-secure context still copies', () => {
  // navigator.clipboard is undefined over plain HTTP, which is exactly how
  // someone running their own install on a home network would see it.
  const fn = app.slice(app.indexOf('private async shareLink('));
  const body = fn.slice(0, fn.indexOf('\n  private closeTrain'));
  assert.match(body, /document\.execCommand\('copy'\)/, 'a selection fallback');
  assert.match(body, /position = 'fixed'/, 'off-screen rather than display:none');
  assert.doesNotMatch(body, /display\s*=\s*'none'/, 'a hidden field cannot be selected');
});

test('and if nothing works the reader still gets the link', () => {
  const fn = app.slice(app.indexOf('private async shareLink('));
  const body = fn.slice(0, fn.indexOf('\n  private closeTrain'));
  assert.match(body, /tr\('ov\.shareFailed', \{ url \}\)/, 'the link goes in the message');
  assert.match(body, /tr\('ov\.shareCopied'\)/, 'and success is confirmed');
});

test('every string exists in both languages', () => {
  // There is a general test for locale parity; this names the new keys so a
  // half-translated addition fails here with something readable.
  for (const key of ['ov.share', 'ov.shareCopied', 'ov.shareFailed']) {
    const uses = [...i18n.matchAll(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'))];
    assert.equal(uses.length, 2, `${key} should be defined once per locale`);
  }
});
