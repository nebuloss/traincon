// Link previews and icons.
//
// WhatsApp, Signal, Slack and the rest read Open Graph out of the served HTML.
// Everything here is invisible in a browser — the page looks perfect while the
// preview silently falls back to a bare link — so it is worth pinning down:
// an absolute og:image, a PNG served as a PNG, and a Host header that cannot
// be turned into markup.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const { ApiServer } = await import(path.join(ROOT, 'dist-server/server/Server.js'));

/** Static serving never touches the store, so a stub is enough. */
let server;
let base;

before(async () => {
  server = new ApiServer({}, DIST);
  await server.listen(0);
  base = `http://127.0.0.1:${server.port}`;
});

after(() => server.close());

/**
 * Fetch a path, spoofing whatever headers a proxy would add.
 *
 * `Host` is a forbidden header for fetch() and is silently replaced with the
 * real one, so the proxy header is what these tests drive — which is also the
 * header that matters in the deployment, behind TLS termination.
 */
async function get(p, headers = {}) {
  const res = await fetch(`${base}${p}`, { headers });
  return { res, body: await res.text() };
}

test('og:image is absolute, and follows the proxied host', async () => {
  const { body } = await get('/', {
    'x-forwarded-host': 'traincon.example.org',
    'x-forwarded-proto': 'https',
  });
  assert.match(body, /<meta property="og:image" content="https:\/\/traincon\.example\.org\/og\.png">/);
  assert.match(body, /<meta property="og:url" content="https:\/\/traincon\.example\.org\/">/);
  assert.ok(!body.includes('%ORIGIN%'), 'no placeholder should survive');
});

test('a hostile Host header cannot inject markup', async () => {
  // If this ever lands unescaped in the page it is stored XSS for anyone who
  // can set Host — so the origin is dropped entirely rather than escaped.
  const { body } = await get('/', {
    'x-forwarded-host': 'evil.test"><script>alert(1)</script>',
  });
  assert.ok(!body.includes('<script>alert(1)</script>'), 'must not echo the payload');
  assert.ok(!body.includes('%ORIGIN%'), 'placeholder is cleared even when rejected');
});

test('PUBLIC_URL overrides the request host', async () => {
  process.env.PUBLIC_URL = 'https://pinned.example/';
  try {
    const { body } = await get('/', { 'x-forwarded-host': 'ignored.example' });
    // Trailing slash trimmed, so the joined URL has exactly one.
    assert.match(body, /content="https:\/\/pinned\.example\/og\.png">/);
  } finally {
    delete process.env.PUBLIC_URL;
  }
});

test('the preview image is served as a real PNG', async () => {
  // An octet-stream here is enough for WhatsApp to drop the image.
  const res = await fetch(`${base}/og.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(buf.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

test('the manifest and its icons are all present and typed', async () => {
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = JSON.parse(await res.text());

  for (const icon of manifest.icons) {
    const r = await fetch(`${base}${icon.src}`);
    assert.equal(r.status, 200, `${icon.src} is referenced but missing`);
    assert.equal(r.headers.get('content-type'), icon.type);
  }
});

test('the HTML references only icons that exist', async () => {
  const html = await readFile(path.join(DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|content)="\/([\w.-]+\.(?:png|svg|webmanifest))"/g)];
  assert.ok(refs.length >= 3, 'expected favicon, touch icon and manifest');
  for (const [, name] of refs) {
    const r = await fetch(`${base}/${name}`);
    assert.equal(r.status, 200, `${name} is linked but not built`);
  }
});


test('a deep link serves the app shell, not a 404', async () => {
  // Client routing only works if the server hands back index.html for a path
  // it has never heard of; /api/ is the one prefix that must still 404.
  for (const p of ['/train/8540', '/train/8540/carte', '/t/8540']) {
    const { res, body } = await get(p);
    assert.equal(res.status, 200, `${p} should serve the shell`);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(body, /<meta property="og:title"/);
  }
  assert.equal((await get('/api/nope')).res.status, 404);
});
