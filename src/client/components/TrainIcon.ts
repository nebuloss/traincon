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
 * The liveries, as the trains are actually painted.
 *
 * Two colours each, which is what the plan view needs: `body` is the roof —
 * the surface you see from directly above — and `band` is the flank, which
 * shows as a border round the roof panel and is the colour people name the
 * train by.
 *
 *   inOui    grey with Carmillon, SNCF's house red, made from carmine and
 *            vermilion
 *   OUIGO    "le train rose et bleu": a blue body with fuchsia doors
 *   Lyria    grey with the Franco-Swiss red
 *   ICE      Deutsche Bahn white with the red waistline
 *   IC       Intercités grey and blue; the night trains darker
 *   TER      regional blue as the default — the real liveries are set by each
 *            région and the feed does not say which one, so this stands in
 *
 * Sources: fr.wikipedia.org/wiki/Livrées_SNCF for Carmillon ("dégradé créé
 * pour la SNCF à partir du rouge carmin et du rouge vermillon") and for the
 * pink-and-blue Ouigo scheme; ouigo.com describes its own trains as "les TGV
 * rose et bleu".
 */
export interface Livery {
  /** The roof, seen from above. */
  body: string;
  /** The flank, and the colour the train is known by. */
  band: string;
}

export const LIVERY = {
  inoui: { body: '#dee3e9', band: '#c1122c' },
  ouigo: { body: '#1b3ea8', band: '#e5007d' },
  lyria: { body: '#e4e8ee', band: '#9b1b30' },
  ice: { body: '#f1f3f6', band: '#e2001a' },
  ic: { body: '#c6cfda', band: '#1d4f91' },
  icn: { body: '#4a5a72', band: '#2e6bb8' },
  ter: { body: '#d6dde6', band: '#1f6fbf' },
  other: { body: '#b9c2cc', band: '#6b7684' },
} as const satisfies Readonly<Record<string, Livery>>;

export type LiveryKey = keyof typeof LIVERY;

/**
 * Which livery a train wears.
 *
 * Taken from the operator the feed names rather than from the family, because
 * that is the distinction that shows: an inOui and a OUIGO are both `tgv` and
 * are painted nothing like each other.
 */
export function liveryOf(t: TrainDTO): LiveryKey {
  // Keyed on the short service code rather than the printed label: the codes
  // are stable and ASCII, where the label is display text that changes with
  // branding and carries accents.
  const byCode: Readonly<Record<string, LiveryKey>> = {
    OGO: 'ouigo',
    OUI: 'inoui',
    LYR: 'lyria',
    ICE: 'ice',
    IC: 'ic',
    ICN: 'icn',
    TER: 'ter',
  };
  const known = byCode[t.service ?? ''];
  if (known) return known;
  // Anything the feed does not name falls back to its family: a TGV with no
  // code is far likelier to be an inOui than anything else.
  return t.family === 'tgv' ? 'inoui' : t.family === 'ter' ? 'ter' : t.family === 'ic' ? 'ic' : 'other';
}

/** The colour this train is known by — its flank. */
export function trainColor(t: TrainDTO): string {
  return LIVERY[liveryOf(t)].band;
}

/** The glyph shown on the disc at low zoom. */
const GLYPH: Readonly<Record<Family, string>> = {
  tgv: '🚄',
  ic: '🚆',
  ter: '🚉',
  other: '🚂',
};

/**
 * Above this zoom the train is drawn to scale rather than as a disc.
 *
 * Set by what the artwork needs to read: at true length a 26 m coach is
 * about 16 px here and doubles every zoom after, and below it there is
 * nothing to see but a smear.
 */
export const PLAN_ZOOM = 15;

/**
 * Metres per pixel at a given zoom and latitude, in MapLibre's terms.
 *
 * The constant is the one people quote least often. The familiar 156543 is
 * for 256-pixel tiles; MapLibre uses 512, so its world is 512·2^zoom pixels
 * across and a pixel covers half as much ground at the same zoom number
 * (`tileSize = 512`, `worldSize = tileSize * scale` in its Transform).
 *
 * Getting this wrong by the factor of two drew every vehicle at half its
 * length, which showed up as a gap between each one and the next.
 */
export function metresPerPixel(zoom: number, lat: number): number {
  return (78271.51696 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
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

/** The colour that stands for this train — kept as the old name's meaning. */
export function familyColor(t: TrainDTO): string {
  return trainColor(t);
}

/** The disc form, for when the train would be too small to draw. */
export function discView(t: TrainDTO): string {
  return `<span class="tm-body">${familyGlyph(t)}</span>`;
}
