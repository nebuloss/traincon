// Deep links.
//
// The whole value of these URLs is that someone pastes one into a chat and it
// still works at the other end, so the parser has to accept the shapes people
// actually send — query strings, bare hashes, the short path — and reject
// anything that is not a train number rather than opening a modal on junk.
//
// Router.ts is imported as TypeScript: node strips the types, and the file's
// only import is `import type`, which is erased.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Router } = await import(path.join(ROOT, 'src/client/core/Router.ts'));

/** Router.read accepts a URL, so no DOM is needed. */
const read = (href) => Router.read(new URL(href, 'https://traincon.example'));

test('the canonical path opens a train', () => {
  assert.deepEqual(read('/train/8540'), { view: null, train: '8540', tab: null });
  assert.deepEqual(read('/train/8540/carte'), { view: null, train: '8540', tab: 'carte' });
  assert.deepEqual(read('/t/8540'), { view: null, train: '8540', tab: null });
});

test('query and hash forms are accepted', () => {
  const t = (train, tab) => ({ view: null, train, tab });
  assert.deepEqual(read('/?train=8540'), t('8540', null));
  assert.deepEqual(read('/?t=8540&tab=trajet'), t('8540', 'trajet'));
  assert.deepEqual(read('/#8540'), t('8540', null));
  assert.deepEqual(read('/#train=8540&tab=journal'), t('8540', 'journal'));
  assert.deepEqual(read('/#/train/8540/carte'), t('8540', 'carte'));
});

test('English tab names work, so a link shared from the EN interface reads right', () => {
  assert.equal(read('/train/8540/map').tab, 'carte');
  assert.equal(read('/train/8540/journey').tab, 'trajet');
  assert.equal(read('/train/8540/overview').tab, 'apercu');
  assert.equal(read('/train/8540/log').tab, 'journal');
});

test('train numbers are normalised to upper case', () => {
  assert.equal(read('/train/tgv1').train, 'TGV1');
});

test('nothing that is not a train number opens a modal', () => {
  for (const href of [
    '/',
    '/train/',
    '/train/../../etc/passwd',
    '/train/<script>',
    '/train/123456789', // too long
    '/?train=%3Cscript%3E',
    '/#',
    '/#not a number',
    '/other/8540',
  ]) {
    assert.equal(read(href).train, null, `${href} should not resolve to a train`);
  }
});

test('an unknown tab falls back rather than being passed through', () => {
  assert.equal(read('/train/8540/nope').tab, null);
  assert.equal(read('/?train=8540&tab=nope').tab, null);
});

test('href round-trips through read', () => {
  for (const tab of [null, 'carte', 'trajet', 'journal']) {
    const back = read(Router.href('8540', tab));
    assert.equal(back.train, '8540');
    assert.equal(back.tab, tab);
  }
  // The default tab is left implicit, keeping the shared URL short.
  assert.equal(Router.href('8540', 'apercu'), '/train/8540');
});


// ── writing the URL ──────────────────────────────────────────────────────────

/**
 * A minimal history/location stub.
 *
 * Router only touches pathname/search/hash and pushState/replaceState, so this
 * is enough to assert what lands in the address bar without pulling in a DOM.
 */
function stubWindow(href = 'https://traincon.example/') {
  const entries = [];
  const loc = new URL(href);
  const apply = (url) => {
    const next = new URL(url, loc.origin);
    loc.pathname = next.pathname;
    loc.search = next.search;
    loc.hash = next.hash;
  };
  globalThis.history = {
    pushState: (state, _t, url) => {
      entries.push({ mode: 'push', url, state });
      apply(url);
    },
    replaceState: (state, _t, url) => {
      entries.push({ mode: 'replace', url, state });
      apply(url);
    },
  };
  globalThis.window = { location: loc, addEventListener() {} };
  return entries;
}

test('opening a train from a card pushes its path', () => {
  const entries = stubWindow('https://traincon.example/');
  new Router().go('8540', null, 'push');
  assert.equal(entries.at(-1).mode, 'push');
  assert.equal(entries.at(-1).url, '/train/8540');
  assert.equal(globalThis.window.location.pathname, '/train/8540');
});

test('switching tab replaces instead of piling up history', () => {
  const entries = stubWindow('https://traincon.example/train/8540');
  const r = new Router();
  r.go('8540', 'carte', 'replace');
  r.go('8540', 'trajet', 'replace');
  assert.ok(entries.every((e) => e.mode === 'replace'));
  assert.equal(entries.at(-1).url, '/train/8540/trajet');
});

test('closing returns to the root and drops a query-form link', () => {
  stubWindow('https://traincon.example/train/8540/carte');
  new Router().go(null, null, 'replace');
  assert.equal(globalThis.window.location.pathname, '/');

  stubWindow('https://traincon.example/?train=8540');
  new Router().go(null, null, 'replace');
  assert.equal(globalThis.window.location.search, '');
});

test('navigating to the URL already shown writes no history entry', () => {
  const entries = stubWindow('https://traincon.example/train/8540');
  new Router().go('8540', null, 'push');
  assert.equal(entries.length, 0, 'a redundant push would break the Back button');
});


// ── wiring ───────────────────────────────────────────────────────────────────

/**
 * Every way of opening a train must go through App.openTrain.
 *
 * Bookmarks, search results and the timeline all mark their rows with
 * data-open and share one handler; calling this.modal.open directly from a new
 * one would show the train but leave the address bar on the previous page,
 * which is exactly the bug this whole feature exists to avoid. Checked in the
 * source because driving App itself would mean pulling in a DOM.
 */
test('nothing opens the modal behind the router back', async () => {
  const app = await readFile(path.join(ROOT, 'src/client/App.ts'), 'utf8');

  const body = (name) => {
    const m = app.match(new RegExp(`\\n  private (?:async )?${name}\\([^]*?\\n  \\}`));
    assert.ok(m, `App.${name} not found — was it renamed?`);
    return m[0];
  };

  assert.match(body('openTrain'), /this\.router\.go\(/, 'openTrain must write the URL');
  assert.match(body('openTrain'), /this\.modal\.open\(/);
  assert.match(body('applyRoute'), /this\.modal\.open\(/);

  // Only those two: any third call site is a path that forgets the URL.
  const calls = [...app.matchAll(/this\.modal\.open\(/g)];
  assert.equal(calls.length, 2, 'open the modal via openTrain, not modal.open');

  // And the shared click handler must use it.
  assert.match(app, /\[data-open\][^]{0,200}this\.openTrain\(/);
});


// ── one URL per tab ──────────────────────────────────────────────────────────

test('each top-level tab has its own path', () => {
  assert.equal(read('/').view, 'watch');
  assert.equal(read('/recherche').view, 'search');
  assert.equal(read('/palmares').view, 'worst');
});

test('English tab paths work too', () => {
  assert.equal(read('/search').view, 'search');
  assert.equal(read('/worst').view, 'worst');
  assert.equal(read('/watch').view, 'watch');
});

test('an unrecognised path selects no tab rather than guessing', () => {
  // The server serves the shell for anything extensionless; the app should
  // then stay where it is rather than silently jumping to a tab.
  assert.equal(read('/nope').view, null);
  assert.equal(read('/recherche/extra').view, null);
});

test('a train link does not name a tab, so the modal opens over the current one', () => {
  const r = read('/train/8540');
  assert.equal(r.train, '8540');
  assert.equal(r.view, null);
});

test('tab paths round-trip', () => {
  for (const view of ['watch', 'search', 'worst']) {
    assert.equal(read(Router.viewHref(view)).view, view);
  }
  assert.equal(Router.viewHref('watch'), '/', 'the default tab is the bare root');
});

test('choosing a tab pushes its path', () => {
  const entries = stubWindow('https://traincon.example/');
  const r = new Router();
  r.goView('worst', 'push');
  assert.equal(entries.at(-1).mode, 'push');
  assert.equal(entries.at(-1).url, '/palmares');
  assert.equal(globalThis.window.location.pathname, '/palmares');

  // Back through the tabs should work like back through pages.
  r.goView('search', 'push');
  assert.equal(entries.at(-1).url, '/recherche');
  assert.equal(entries.length, 2);
});

test('re-selecting the tab already shown writes no history entry', () => {
  const entries = stubWindow('https://traincon.example/palmares');
  new Router().goView('worst', 'push');
  assert.equal(entries.length, 0);
});

test('closing a train returns to a tab, not always the root', () => {
  // Opened from the hall of shame, closing should land back there.
  const entries = stubWindow('https://traincon.example/train/8540');
  new Router().goView('worst', 'replace');
  assert.equal(entries.at(-1).mode, 'replace');
  assert.equal(globalThis.window.location.pathname, '/palmares');
});
