/**
 * How a train is drawn on the map.
 *
 * Two representations, chosen by zoom:
 *
 *   far out   a disc carrying the family's glyph, because at 6 m to the pixel
 *             a to-scale train is four pixels long and unreadable
 *   close in  the vehicle seen from above at its real length — a TGV is 200 m
 *             and looks it, a coupled pair twice that
 *
 * This module owns the disc and the dimensions. The close-in drawing is map
 * geometry rather than an icon, because a train on a curve is not a rectangle;
 * it lives in core/TrainBody.
 */

import type { Family, TrainDTO } from '../../shared/types.ts';

/** Typical length of one unit, metres. */
const LENGTH_M: Readonly<Record<Family, number>> = {
  tgv: 200,
  ic: 190,
  ter: 80,
  other: 120,
};

/** Body width in metres — the real one, before the legibility floor. */
export const WIDTH_M = 2.9;

/**
 * The colour that identifies each type, on the disc, the body and the graph.
 *
 * A legend rather than a livery: loosely after the real branding — inOui's
 * carmine, the orange of the Corail sets Intercités inherited, TER's blue —
 * but picked so the four stay apart under simulated protanopia, deuteranopia
 * and tritanopia as well as normal vision. The first attempt paired a violet
 * TGV with a blue TER, which the simulation put almost on top of each other
 * for red-green deficiencies; carmine separates them. See test/palette.
 *
 * Colour is the secondary cue in any case — the shapes and lengths differ,
 * and that is what carries the distinction when the train is small.
 */
export const FAMILY_COLOR: Readonly<Record<Family, string>> = {
  tgv: '#c81d6b',
  ic: '#ff9e00',
  ter: '#3a86ff',
  other: '#adb5bd',
};

/** The glyph shown on the disc at low zoom. */
const GLYPH: Readonly<Record<Family, string>> = {
  tgv: '🚄',
  ic: '🚆',
  ter: '🚉',
  other: '🚂',
};

/** Above this zoom the train is drawn to scale rather than as a disc. */
export const PLAN_ZOOM = 15.2;

/** Metres per pixel at a given zoom and latitude. */
export function metresPerPixel(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** How long this train is, allowing for a coupled set. */
export function trainLengthM(t: TrainDTO): number {
  const unit = LENGTH_M[t.family] ?? LENGTH_M.other;
  return unit * (1 + (t.coupledWith?.length ?? 0));
}

/** The glyph that stands for this train's type. */
export function familyGlyph(t: TrainDTO): string {
  return GLYPH[t.family] ?? GLYPH.other;
}

/** The colour that stands for this train's type. */
export function familyColor(t: TrainDTO): string {
  return FAMILY_COLOR[t.family] ?? FAMILY_COLOR.other;
}

/** The disc form, for when the train would be too small to draw. */
export function discView(t: TrainDTO): string {
  return `<span class="tm-body">${familyGlyph(t)}</span>`;
}
