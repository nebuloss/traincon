// The map's own source, for the tests that read it rather than run it.
//
// These assert on source text, which is unusual and deliberate: what they
// protect — which layer is added before which, what order things happen in
// inside one animation frame, whether a paint expression fades in step with
// another — needs a real MapLibre, a real tile server and a real GPU to
// observe. Reading the source is the only check available, so it is the check
// that exists.
//
// The view was one file when these were written and is five now, so each test
// reads the piece that holds what it is about. `src` is all of them joined in
// the order the map is built from, for the assertions that span the split.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (name) => readFile(path.join(ROOT, 'client/map', name), 'utf8');

/** The MapLibre surface the app relies on. */
export const maplibre = await read('maplibre.ts');
/** Every source and layer, in the order they go on. */
export const layers = await read('layers.ts');
/** The surveyed track, read back out of the tiles. */
export const surveyed = await read('surveyed.ts');
/** The speed and the aspect, written over the map. */
export const readout = await read('readout.ts');
/** The view itself: lifecycle, the frame loop, and what it remembers. */
export const view = await read('MapView.ts');

/**
 * All of it, in build order.
 *
 * Layers before the view, because that is the order the two are used in: the
 * layers exist before anything drives them.
 */
export const src = [maplibre, layers, surveyed, readout, view].join('\n');
