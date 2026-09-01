/**
 * How close to sit to a train.
 *
 * Two things pull against each other. A fast train's position is less certain,
 * so a tight view on one implies a precision that is not there; but a view
 * wide enough to be honest about that is also a view in which the train
 * barely appears to move.
 *
 * The old rule only weighed the first, zooming out as the train sped up — and
 * it did so at very nearly the rate the train accelerated, so the two
 * cancelled. Every train, at every speed, crossed the screen at about 1.4
 * pixels a second. A pixel a second reads as stationary: the map looked frozen
 * while the readout said 100 km/h.
 *
 * So the scale is chosen from the apparent speed instead. Fast trains still
 * get a wider view than slow ones — they must, to cover the same screen
 * distance — which keeps the original point, and the train visibly moves at
 * every speed.
 */

/**
 * How fast the train should appear to cross the screen.
 *
 * Fast enough to be obviously moving over a second or two; slow enough that
 * it stays in view for a good while between recentrings.
 */
export const SCREEN_PX_PER_SEC = 8;

/**
 * Metres per pixel at zoom 0, for MapLibre's 512-pixel tiles, at a latitude in
 * the middle of France.
 *
 * The familiar 156543 is for 256-pixel tiles and would be twice this. The
 * exact latitude moves the result by a few per cent, which is far less than
 * the choice of eight pixels a second is worth arguing over.
 */
const AT_ZOOM_0 = 78271.51696 * Math.cos((47 * Math.PI) / 180);

/** Closest and widest the map will go on its own. */
export const MIN_ZOOM = 11.5;
export const MAX_ZOOM = 15;

/** The zoom at which a train doing `kmh` appears to move at a readable rate. */
export function zoomForSpeed(kmh: number): number {
  // A stopped train has no motion to show, so it gets the closest view its
  // position can honestly support.
  if (!kmh) return 14.5;

  const wantMetresPerPixel = kmh / 3.6 / SCREEN_PX_PER_SEC;
  const z = Math.log2(AT_ZOOM_0 / wantMetresPerPixel);
  // Not so close that a small positional error throws the train off screen,
  // nor so far out that the country is the subject rather than the train.
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Metres per pixel at a given zoom, in the middle of France. */
export function metresPerPixelAt(zoom: number): number {
  return AT_ZOOM_0 / 2 ** zoom;
}
