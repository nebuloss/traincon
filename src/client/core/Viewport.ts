/**
 * When to pan after the train.
 *
 * Following it by recentring every frame takes the map away from the user
 * mid-gesture: a pinch zooms about the fingers and so moves the centre, and
 * snapping the centre back makes zooming feel broken. Following it only on
 * each data refresh is not enough either — between refreshes the train is
 * advanced by dead reckoning, and at 300 km/h it crosses a zoomed-in screen
 * in a couple of seconds and then stays off the edge until the next update.
 *
 * So the rule is a box: leave the view alone while the train is somewhere in
 * the middle of it, and recentre once it reaches the edge of that middle.
 */

/**
 * The fraction of the view the train may wander over before it is chased.
 *
 * Wide enough that an ordinary train never triggers a pan, tight enough that
 * a fast one is caught while it is still on screen rather than after.
 */
export const KEEP = 0.55;

/** Whether a point has left the middle `keep` of a `w` × `h` view. */
export function outsideMiddle(
  x: number,
  y: number,
  w: number,
  h: number,
  keep: number = KEEP,
): boolean {
  // A view with no size cannot say anything useful, and treating it as
  // "outside" would pan the map while the panel is still hidden.
  if (!(w > 0) || !(h > 0)) return false;
  const mx = (w * (1 - keep)) / 2;
  const my = (h * (1 - keep)) / 2;
  return x < mx || x > w - mx || y < my || y > h - my;
}
