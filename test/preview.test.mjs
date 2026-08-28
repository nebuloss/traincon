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

/**
 * One train, enough for the preview card.
 *
 * Times are fixed so the assertions below can name them: Paris at 18:46 and
 * Bordeaux at 16:30 are the real figures from the run that motivated the
 * delay reconciliation.
 */
const AT = (h, m) => Math.floor(Date.UTC(2026, 0, 15, h - 1, m) / 1000); // Paris = UTC+1
const TRAIN = {
  number: '8540',
  serviceLabel: 'TGV INOUI',
  origin: 'Hendaye',
  destination: 'Paris Montparnasse',
  delay: 50 * 60,
  cancelled: false,
  next: { stopId: 'bordeaux', name: 'Bordeaux Saint-Jean', time: AT(16, 30) },
  calls: [
    { stopId: 'hendaye', name: 'Hendaye', time: AT(14, 2) },
    { stopId: 'paris', name: 'Paris Montparnasse', time: AT(18, 46) },
  ],
};

const store = {
  find: (n) => (n === '8540' ? [TRAIN] : []),
};

let server;
let base;

before(async () => {
  server = new ApiServer(store, DIST);
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


// ── per-train cards ──────────────────────────────────────────────────────────

/** Pull one meta tag's content out of the served HTML. */
function meta(html, key) {
  const m = html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`));
  return m ? m[1] : null;
}

test('a link to one train previews that train, not the site', async () => {
  const { body } = await get('/train/8540');
  assert.equal(meta(body, 'og:title'), 'TGV INOUI 8540 · Hendaye → Paris Montparnasse');

  const desc = meta(body, 'og:description');
  assert.match(desc, /Retard 50 min/);
  assert.match(desc, /prochain arrêt Bordeaux Saint-Jean à 16:30/);
  assert.match(desc, /arrivée Paris Montparnasse à 18:46/);

  // og:url names the train, so the preview links back to the same page.
  assert.match(meta(body, 'og:url'), /\/train\/8540$/);
  assert.equal(meta(body, 'twitter:title'), meta(body, 'og:title'));
});

test('the query form gets the same card as the path form', async () => {
  const viaPath = await get('/train/8540');
  const viaQuery = await get('/?train=8540');
  assert.equal(meta(viaQuery.body, 'og:title'), meta(viaPath.body, 'og:title'));
});

test('an unknown train falls back to the site card', async () => {
  const { body } = await get('/train/9999');
  assert.match(meta(body, 'og:title'), /^Traincon/);
});

test('no placeholder ever reaches a crawler', async () => {
  for (const p of ['/', '/train/8540', '/train/9999', '/?train=8540']) {
    const { body } = await get(p);
    for (const ph of ['%OG_TITLE%', '%OG_DESC%', '%OG_URL%', '%ORIGIN%']) {
      assert.ok(!body.includes(ph), `${ph} survived on ${p}`);
    }
  }
});

test('the ETag tracks the card, not just the file', async () => {
  // Same file, different train: a shared ETag would let a crawler be handed a
  // 304 and keep the previous train's card.
  const a = await get('/train/8540');
  const b = await get('/train/9999');
  assert.notEqual(a.res.headers.get('etag'), b.res.headers.get('etag'));

  // A repeat of the same page must still revalidate to 304.
  const again = await fetch(`${base}/train/8540`, {
    headers: { 'if-none-match': a.res.headers.get('etag') },
  });
  assert.equal(again.status, 304);
});

test('train text is escaped into the attribute', async () => {
  // Station names come from the feed, not from us.
  store.find = (n) =>
    n === 'XSS' ? [{ ...TRAIN, number: 'XSS', destination: '"><script>alert(1)</script>' }] : [];
  try {
    const { body } = await get('/train/XSS');
    assert.ok(!body.includes('<script>alert(1)</script>'), 'must not escape the attribute');
    assert.match(meta(body, 'og:title'), /&quot;&gt;/);
  } finally {
    store.find = (n) => (n === '8540' ? [TRAIN] : []);
  }
});


test('times are 24-hour, whatever ICU data the host shipped', async () => {
  // Alpine's Node is built with reduced ICU, so 'fr-FR' falls back to en-US
  // and this read "11:21 AM" in production while passing locally.
  const { body } = await get('/train/8540');
  const desc = meta(body, 'og:description');
  assert.ok(!/[AP]M/.test(desc), `expected 24-hour times, got: ${desc}`);
  assert.match(desc, /18:46/);
});

test('the terminus is not named twice', async () => {
  // On the last leg the next stop is the terminus.
  store.find = () => [
    { ...TRAIN, next: { stopId: 'paris', name: 'Paris Montparnasse', time: AT(18, 46) } },
  ];
  try {
    const desc = meta((await get('/train/8540')).body, 'og:description');
    assert.equal(desc.match(/Paris Montparnasse/g).length, 1, desc);
    assert.ok(!desc.includes('prochain arrêt'), desc);
  } finally {
    store.find = (n) => (n === '8540' ? [TRAIN] : []);
  }
});


test('a delay over the hour reads in hours, as the page writes it', async () => {
  // A real 8081 went out as "Retard 90 min"; the page says 1 h 30.
  const cases = [
    [45 * 60, 'Retard 45 min'],
    [70 * 60, 'Retard 1 h 10'],
    [90 * 60, 'Retard 1 h 30'],
    [120 * 60, 'Retard 2 h'],
  ];
  for (const [delay, expected] of cases) {
    store.find = () => [{ ...TRAIN, delay }];
    const desc = meta((await get('/train/8540')).body, 'og:description');
    assert.ok(desc.startsWith(expected), `${delay / 60} min → ${desc}`);
  }
  store.find = (n) => (n === '8540' ? [TRAIN] : []);
});

test('a cancelled train says so first', async () => {
  store.find = () => [{ ...TRAIN, cancelled: true }];
  try {
    assert.match(meta((await get('/train/8540')).body, 'og:description'), /^Supprimé/);
  } finally {
    store.find = (n) => (n === '8540' ? [TRAIN] : []);
  }
});

test('og:url keeps the tab, so the preview links where it was shared from', async () => {
  const { body } = await get('/train/8540/trajet');
  assert.match(meta(body, 'og:url'), /\/train\/8540\/trajet$/);
  assert.match(meta(body, 'og:title'), /8540/);
});


test('each tab path serves the app shell', async () => {
  // Client routing only works if the server hands back index.html for these.
  for (const p of ['/recherche', '/palmares', '/search', '/worst']) {
    const { res, body } = await get(p);
    assert.equal(res.status, 200, `${p} should serve the shell`);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(body, /<meta property="og:title"/);
  }
});

test('a tab path previews as the site, not as a train', async () => {
  const { body } = await get('/palmares');
  assert.match(meta(body, 'og:title'), /^Traincon/);
  assert.match(meta(body, 'og:url'), /\/palmares$/);
});
