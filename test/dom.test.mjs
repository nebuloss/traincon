// Every element the code reaches for must exist somewhere.
//
// The map tab threw on every render — "cannot read innerHTML of null" — because
// #mapTitle and #mapSub were removed from the panel when the map became a tab
// while the code kept writing to them. The non-null assertion made TypeScript
// agree it was fine, so nothing caught it until someone opened the tab.
//
// This walks every literal getElementById in the client and checks the id is
// either in index.html or produced by the code itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'src');

/** Every .ts under src, with its path. */
async function sources(dir = CLIENT) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(full)));
    else if (e.name.endsWith('.ts')) out.push([path.relative(ROOT, full), await readFile(full, 'utf8')]);
  }
  return out;
}

const html = await readFile(path.join(CLIENT, 'index.html'), 'utf8');
const files = await sources();

/**
 * Ids that exist at runtime: those in the shell, plus any the client writes
 * into markup itself — the modal fills its own panels, so several ids never
 * appear in index.html.
 */
const known = new Set();
for (const m of html.matchAll(/\bid="([\w-]+)"/g)) known.add(m[1]);
for (const [, src] of files) {
  for (const m of src.matchAll(/\bid="([\w-]+)"/g)) known.add(m[1]);
  // Template-built ids, e.g. id="${x}" — recorded as dynamic below.
  for (const m of src.matchAll(/getElementById\('mpanel-' \+ (\w+)\)/g)) known.add('mpanel-' + m[1]);
}

// Panels are addressed as `mpanel-${tab}`; the tabs are known from the markup.
for (const m of html.matchAll(/data-mtab="([\w-]+)"/g)) known.add('mpanel-' + m[1]);

test('every element the client asks for by id exists', () => {
  const missing = [];
  for (const [file, src] of files) {
    for (const m of src.matchAll(/getElementById\('([\w-]+)'\)/g)) {
      if (!known.has(m[1])) missing.push(`${file}: #${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `these ids are read but never rendered:\n  ${missing.join('\n  ')}`);
});

test('the ids the map panel needs are all present', () => {
  // The specific regression: the map tab wrote to two elements that had been
  // deleted from the panel.
  for (const id of ['map', 'followLock', 'mapDisclaimer']) {
    assert.ok(known.has(id), `#${id} is missing from index.html`);
  }
  // The lookups themselves must be gone — mentioning the ids in a comment
  // explaining why is fine, and is in fact what the code now does.
  const modal = files.find(([f]) => f.endsWith('TrainModal.ts'))[1];
  for (const id of ['mapTitle', 'mapSub']) {
    assert.ok(
      !modal.includes(`getElementById('${id}')`),
      `${id} no longer exists in the markup, so nothing may look it up`,
    );
  }
});
