// Translation integrity.
//
// A missing key degrades to French and then to the raw key, so nothing crashes
// — which is exactly why these need checking automatically: a forgotten string
// is invisible until someone reads the page in that language.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(path.join(ROOT, 'public/i18n.js'), 'utf8');
const app = await readFile(path.join(ROOT, 'public/app.js'), 'utf8');
const html = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');

const blockOf = (name) => src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`))[1];
const keysOf = (name) =>
  new Set([...blockOf(name).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));

const FR = keysOf('FR');
const EN = keysOf('EN');

/** Placeholder names used in one string, sorted for comparison. */
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const valueOf = (name, key) => {
  const b = blockOf(name);
  const m = b.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*([\\s\\S]*?)(?=\\n  '|$)`));
  return m ? m[1] : '';
};

test('locales define the same keys', () => {
  const missingEn = [...FR].filter((k) => !EN.has(k));
  const missingFr = [...EN].filter((k) => !FR.has(k));
  assert.deepEqual(missingEn, [], 'keys missing from EN');
  assert.deepEqual(missingFr, [], 'keys missing from FR');
  assert.ok(FR.size > 100, `${FR.size} keys defined`);
});

test('every key referenced by the app exists', () => {
  const used = new Set();
  // t('key') and the tr() alias used where a local `t` holds a train
  for (const m of app.matchAll(/\btr?\('([a-zA-Z][\w.]+)'/g)) used.add(m[1]);
  // data-i18n, data-i18n-placeholder, data-i18n-aria in the markup
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-aria)?="([\w.]+)"/g)) used.add(m[1]);

  const undefined_ = [...used].filter((k) => !FR.has(k));
  assert.deepEqual(undefined_, [], 'referenced but not defined');
  assert.ok(used.size > 50, `${used.size} keys referenced`);
});

test('placeholders match across locales', () => {
  const mismatched = [...FR]
    .filter((k) => EN.has(k))
    .filter((k) => placeholders(valueOf('FR', k)) !== placeholders(valueOf('EN', k)));
  // A {name} present in one locale and absent in the other means the value
  // silently disappears for readers of that language.
  assert.deepEqual(mismatched, [], 'placeholder sets differ');
});

test('no stray French left in the interface source', () => {
  // Accented words outside a t() call, a comment or a CSS/DOM literal are a
  // sign a string was missed. Comments are French by convention, so strip them.
  const code = app
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const suspects = [...code.matchAll(/'([^']*[àâçéèêëîïôûùüÿœ][^']*)'/g)]
    .map((m) => m[1])
    .filter((v) => v.length > 12);
  assert.deepEqual(suspects, [], 'untranslated literals');
});
