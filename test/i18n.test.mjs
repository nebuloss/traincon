// Translation integrity.
//
// A missing key degrades to French and then to the raw key, so nothing crashes
// — which is exactly why these need checking automatically: a forgotten string
// is invisible until someone reads the page in that language.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'src/client');

const src = await readFile(path.join(CLIENT, 'core/I18n.ts'), 'utf8');
const html = await readFile(path.join(CLIENT, 'index.html'), 'utf8');

/** Every .ts under src/client, concatenated — the interface source. */
async function clientSources(dir = CLIENT) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await clientSources(full)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('I18n.ts')) {
      out.push({ file: path.relative(ROOT, full), text: await readFile(full, 'utf8') });
    }
  }
  return out;
}
const files = await clientSources();
const app = files.map((f) => f.text).join('\n');

const blockOf = (name) => src.match(new RegExp(`const ${name}: Dict = \\{([\\s\\S]*?)\\n\\};`))[1];
const keysOf = (name) =>
  new Set([...blockOf(name).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));

const FR = keysOf('FR');
const EN = keysOf('EN');

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const valueOf = (name, key) => {
  const b = blockOf(name);
  const m = b.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*([\\s\\S]*?)(?=\\n  '|$)`));
  return m ? m[1] : '';
};

test('locales define the same keys', () => {
  assert.deepEqual([...FR].filter((k) => !EN.has(k)), [], 'keys missing from EN');
  assert.deepEqual([...EN].filter((k) => !FR.has(k)), [], 'keys missing from FR');
  assert.ok(FR.size > 100, `${FR.size} keys defined`);
});

test('every key referenced by the interface exists', () => {
  const used = new Set();
  for (const m of app.matchAll(/\btr\('([a-zA-Z][\w.]+)'/g)) used.add(m[1]);
  // Template keys built at runtime, e.g. tr(`conf.${conf}`) and tr(`trend.${k}`).
  for (const m of app.matchAll(/\btr\(`([a-z]+)\.\$\{/g)) {
    for (const k of FR) if (k.startsWith(m[1] + '.')) used.add(k);
  }
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-aria)?="([\w.]+)"/g)) used.add(m[1]);

  assert.deepEqual([...used].filter((k) => !FR.has(k)), [], 'referenced but not defined');
  assert.ok(used.size > 50, `${used.size} keys referenced`);
});

test('placeholders match across locales', () => {
  // A {name} present in one locale and absent in the other means the value
  // silently disappears for readers of that language.
  const mismatched = [...FR]
    .filter((k) => EN.has(k))
    .filter((k) => placeholders(valueOf('FR', k)) !== placeholders(valueOf('EN', k)));
  assert.deepEqual(mismatched, [], 'placeholder sets differ');
});

test('the translator is never called `t`', () => {
  // `t` names a train throughout the interface. Importing the translator under
  // the same name made it resolve to the train inside every function that
  // binds one — a "t is not a function" that no key checking would reveal,
  // because the keys were all perfectly valid.
  const offenders = [];
  for (const f of files) {
    for (const m of f.text.matchAll(/(?<![\w.$])t\('([\w.]+)'/g)) {
      offenders.push(`${f.file}: t('${m[1]}')`);
    }
  }
  assert.deepEqual(offenders, [], 'translate calls must use tr(), not t()');
  assert.ok(/export const tr =/.test(src), 'the translator is exported as tr');
});

test('no stray French left in the interface source', () => {
  // Accented words outside a t() call or a comment suggest a missed string.
  // Comments are English by convention here, so a hit is a real finding.
  const offenders = [];
  for (const f of files) {
    const code = f.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of code.matchAll(/'([^']*[àâçéèêëîïôûùüÿœ][^']*)'/g)) {
      if (m[1].length > 12) offenders.push(`${f.file}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'untranslated literals');
});

test('every locale value is a string', () => {
  // A stray object or function would render as [object Object] rather than
  // failing loudly.
  for (const name of ['FR', 'EN']) {
    const bad = [...blockOf(name).matchAll(/^\s*'([^']+)':\s*([^\n]*)/gm)]
      .filter(([, , v]) => !/^["'`]/.test(v.trim()))
      .map(([, k]) => k);
    assert.deepEqual(bad, [], `${name}: non-string values`);
  }
});
