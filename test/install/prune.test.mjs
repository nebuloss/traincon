// What an update removes, and what it must never remove.
//
// install.sh replaces APP_CONTENTS wholesale and leaves everything else alone,
// which meant the Node server's leftovers — node_modules and eight more —
// survived every update for ever. They were still on the production container
// after the move to a Go binary that reads none of them.
//
// The fix is a second list, and a second list of paths to delete as root is
// exactly the kind of thing that wants a test: APP_DIR also holds data/, which
// is 24 MB of downloaded schedule and geometry, and .env, which holds the API
// key. Losing either to a typo would be silent — data/ is re-downloaded and
// the key is simply gone.
//
// The lists are read out of the real script rather than restated here, so this
// tracks the code instead of a copy of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = await readFile(path.join(ROOT, 'install.sh'), 'utf8');

/** The words of a `NAME="a b c"` assignment in the script. */
function list(name) {
  const m = new RegExp(`^${name}="([^"]*)"`, 'm').exec(src);
  assert.ok(m, `${name} should be a double-quoted list`);
  return m[1].split(/\s+/).filter(Boolean);
}

const APP_CONTENTS = list('APP_CONTENTS');
const STALE_CONTENTS = list('STALE_CONTENTS');

/**
 * Everything an update must leave standing.
 *
 * data/ is the whole reason updating is cheap; .env carries the API key the
 * installer only asks for once; traincon is the running binary, replaced by a
 * copy rather than by deletion.
 */
const MUST_SURVIVE = ['data', '.env', 'traincon', '.rollback'];

test('the update never removes what has to survive it', () => {
  for (const keep of MUST_SURVIVE) {
    assert.ok(!STALE_CONTENTS.includes(keep), `STALE_CONTENTS would delete ${keep}`);
    assert.ok(!APP_CONTENTS.includes(keep), `APP_CONTENTS would delete ${keep}`);
  }
});

test('nothing is in both lists', () => {
  // A name in both would be removed twice, which is harmless, and would mean
  // the two lists disagree about what this release ships, which is not.
  for (const name of STALE_CONTENTS) {
    assert.ok(!APP_CONTENTS.includes(name), `${name} is both shipped and stale`);
  }
});

test('the stale list names no path that could escape APP_DIR', () => {
  // These are interpolated straight into `rm -rf "$APP_DIR/$path"` as root.
  for (const name of STALE_CONTENTS) {
    assert.doesNotMatch(name, /^\/|\.\.|\*|\$|~/, `${name} is not a plain name under APP_DIR`);
  }
});

test('both lists are actually applied, under APP_DIR and nowhere else', () => {
  const fn = src.slice(src.indexOf('install_app()'), src.indexOf('ensure_user()'));
  for (const name of ['APP_CONTENTS', 'STALE_CONTENTS']) {
    assert.match(fn, new RegExp(`for \\w+ in \\$${name}; do`), `${name} is never walked`);
  }
  // The :? is what stops an unset APP_DIR turning these into `rm -rf /dist`.
  const removes = [...fn.matchAll(/rm -rf "([^"]*)"/g)].map((m) => m[1]);
  assert.ok(removes.length >= 2, 'expected a removal per list');
  for (const target of removes) {
    if (target.includes('tmp')) continue;
    assert.match(target, /^\$\{APP_DIR:\?\}\//, `${target} is not guarded by \${APP_DIR:?}`);
  }
});

test('the leftovers actually found on the container are all covered', () => {
  // Named from what was on dmz-tchoutchoutrain after the port: the Go server
  // had been serving from dist/ for four releases while these sat beside it.
  for (const found of [
    'node_modules',
    'dist-server',
    'src',
    'tools',
    'fixtures',
    'public',
    'package.json',
    'package-lock.json',
    'app.tar.gz',
  ]) {
    assert.ok(STALE_CONTENTS.includes(found), `${found} was left behind and is not pruned`);
  }
});
