// The colours that tell the train types apart.
//
// Colour is the quick cue on the map: a TER and a TGV should be tellable
// apart before you read anything. That only works if the four stay distinct
// for the people who do not see red and green the way the palette's author
// does — roughly one man in twelve. The first palette failed exactly there,
// pairing a violet TGV with a blue TER that a deuteranope sees as nearly the
// same colour, so the check is kept rather than the conclusion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { FAMILY_COLOR } = await import(path.join(ROOT, 'src/client/components/TrainIcon.ts'));

const srgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// Viénot's LMS simulation, applied in linear RGB.
const RGB2LMS = [
  [0.31399, 0.63951, 0.04649],
  [0.15537, 0.75789, 0.0867],
  [0.01775, 0.10944, 0.87247],
];
const LMS2RGB = [
  [5.47221, -4.6419, 0.16963],
  [-1.1252, 2.29317, -0.1678],
  [0.0298, -0.19318, 1.16364],
];
const SIM = {
  protan: [
    [0, 1.05118, -0.05116],
    [0, 1, 0],
    [0, 0, 1],
  ],
  deutan: [
    [1, 0, 0],
    [0.9513, 0, 0.04732],
    [0, 0, 1],
  ],
  tritan: [
    [1, 0, 0],
    [0, 1, 0],
    [-0.86744, 1.86727, 0],
  ],
};

const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const seen = (hex, kind) => {
  const rgb = srgb(hex).map(lin);
  return kind === 'normal' ? rgb : mul(LMS2RGB, mul(SIM[kind], mul(RGB2LMS, rgb)));
};
const apart = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));

const FAMILIES = ['tgv', 'ic', 'ter', 'other'];

test('every type has a colour', () => {
  for (const f of FAMILIES) assert.match(FAMILY_COLOR[f], /^#[0-9a-f]{6}$/, f);
});

test('no two types share a colour', () => {
  assert.equal(new Set(FAMILIES.map((f) => FAMILY_COLOR[f])).size, 4);
});

for (const kind of ['normal', 'protan', 'deutan', 'tritan']) {
  test(`the four stay apart under ${kind} vision`, () => {
    let worst = [99, ''];
    for (let i = 0; i < FAMILIES.length; i++) {
      for (let j = i + 1; j < FAMILIES.length; j++) {
        const d = apart(seen(FAMILY_COLOR[FAMILIES[i]], kind), seen(FAMILY_COLOR[FAMILIES[j]], kind));
        if (d < worst[0]) worst = [d, `${FAMILIES[i]}/${FAMILIES[j]}`];
      }
    }
    // The rejected violet/blue pairing scored 0.19 here; this floor is well
    // clear of it without demanding a palette nobody would want to look at.
    assert.ok(worst[0] > 0.3, `${worst[1]} only ${worst[0].toFixed(3)} apart`);
  });
}

test('brightness alone separates them a little, for when colour is lost', () => {
  // Not a substitute for the shape cue, but a greyscale print or a very dim
  // screen should not collapse all four into one tone.
  const lum = (h) => {
    const [r, g, b] = srgb(h).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const tones = FAMILIES.map((f) => lum(FAMILY_COLOR[f])).sort((a, b) => a - b);
  assert.ok(tones[3] - tones[0] > 0.25, 'some spread from darkest to lightest');
});
