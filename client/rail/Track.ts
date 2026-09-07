/**
 * A route as a measured line, so the map can move a train along it between
 * server updates.
 *
 * The server recomputes positions once a minute and the page polls every
 * thirty seconds, so a train watched on the map sat still and then jumped.
 * Everything needed to do better is already on the client: the route geometry
 * it has drawn, and the train's speed and bearing. Advancing along the line at
 * the reported speed is honest dead reckoning — the same thing the server does
 * between feed observations, just at a finer interval.
 *
 * Pure geometry, no DOM: the map owns the animation, this owns the maths.
 */

const EARTH_KM = 6371;
const RAD = Math.PI / 180;

function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface TrackPoint {
  lat: number;
  lon: number;
  /** Degrees clockwise from north, along the line at this point. */
  bearing: number;
}

export class Track {
  private readonly lat: Float64Array;
  private readonly lon: Float64Array;
  /** Cumulative km at each vertex. */
  private readonly cum: Float64Array;
  /** Where the last lookup landed, so sequential advances stay O(1). */
  private cursor = 1;

  /** @param coords GeoJSON order: [lon, lat]. */
  constructor(coords: readonly (readonly number[])[]) {
    const n = coords.length;
    this.lat = new Float64Array(n);
    this.lon = new Float64Array(n);
    this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.lon[i] = coords[i]![0]!;
      this.lat[i] = coords[i]![1]!;
      this.cum[i] =
        i === 0
          ? 0
          : this.cum[i - 1]! + haversine(this.lat[i - 1]!, this.lon[i - 1]!, this.lat[i]!, this.lon[i]!);
    }
  }

  get length(): number {
    return this.cum.length ? this.cum[this.cum.length - 1]! : 0;
  }

  get points(): number {
    return this.cum.length;
  }

  /**
   * Distance along the line closest to a point.
   *
   * Linear in the number of vertices, and only run when a fresh server
   * position arrives — twice a minute, not per frame.
   */
  distanceAt(lat: number, lon: number): number {
    const n = this.lat.length;
    if (n === 0) return 0;
    if (n === 1) return 0;

    // Projected onto the nearest *segment*, not snapped to the nearest vertex.
    // Snapping left the answer up to half a segment out — a median 38 m on
    // real rail geometry, and worse where the vertices are sparse — which put
    // the train visibly beside its own line once the map was zoomed in.
    let bestD = Infinity;
    let bestKm = 0;

    // Local metres: the segments are tens of metres, so a flat approximation
    // is exact enough and avoids trigonometry per vertex.
    const latScale = 111.32;
    const lonScale = 111.32 * Math.cos((lat * Math.PI) / 180);

    for (let i = 1; i < n; i++) {
      const ax = (this.lon[i - 1]! - lon) * lonScale;
      const ay = (this.lat[i - 1]! - lat) * latScale;
      const bx = (this.lon[i]! - lon) * lonScale;
      const by = (this.lat[i]! - lat) * latScale;

      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;

      // How far along this segment the perpendicular foot falls, clamped to
      // the segment so the answer stays on the line rather than on its
      // infinite extension.
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + dx * t;
      const py = ay + dy * t;
      const d = px * px + py * py;

      if (d < bestD) {
        bestD = d;
        bestKm = this.cum[i - 1]! + (this.cum[i]! - this.cum[i - 1]!) * t;
      }
    }
    return bestKm;
  }

  /**
   * The point a given distance along, with the local bearing.
   *
   * The cursor walks forward with the train, so successive calls during an
   * animation cost a comparison rather than a search. It rewinds only when
   * asked to go backwards, which happens when a server update corrects the
   * estimate.
   */
  /**
   * The length of the straight the given distance falls on, metres.
   *
   * The route is a polyline, so between two vertices it is a chord: across a
   * curve it cuts the corner, and the drawn train rides the chord rather than
   * the rails. How far it can be out therefore depends on how long that chord
   * is — which is what this is for. Spacing is 39 m on median on the Ligne des
   * Alpes and 415 m at worst, and it is the 415 m ones that put a train sixty
   * metres from its track.
   */
  chordAt(distKm: number): number {
    const n = this.cum.length;
    if (n < 2) return 0;
    const d = Math.max(0, Math.min(distKm, this.length));
    let i = 1;
    while (i < n - 1 && this.cum[i]! < d) i++;
    return (this.cum[i]! - this.cum[i - 1]!) * 1000;
  }

  at(distKm: number): TrackPoint | null {
    const n = this.cum.length;
    if (n < 2) return null;

    const d = Math.max(0, Math.min(distKm, this.length));
    if (this.cum[this.cursor - 1]! > d) this.cursor = 1;
    while (this.cursor < n - 1 && this.cum[this.cursor]! < d) this.cursor++;

    const i = this.cursor;
    const a = this.cum[i - 1]!;
    const span = this.cum[i]! - a;
    const f = span > 0 ? (d - a) / span : 0;

    const lat0 = this.lat[i - 1]!;
    const lon0 = this.lon[i - 1]!;
    const lat1 = this.lat[i]!;
    const lon1 = this.lon[i]!;

    return {
      lat: lat0 + (lat1 - lat0) * f,
      lon: lon0 + (lon1 - lon0) * f,
      bearing: this.bearingAt(d),
    };
  }

  /**
   * Heading over a stretch of the line rather than one segment of it.
   *
   * Rail geometry is dense — a third of the segments on a real journey are
   * under ten metres — and taking the heading of whichever one the train is
   * standing on makes the direction marker twitch as it crosses them. Reading
   * across a fixed distance instead averages that out, and the answer is the
   * same on a straight where it matters.
   */
  private bearingAt(distKm: number): number {
    const WINDOW_KM = 0.12;
    const a = this.pointAt(Math.max(0, distKm - WINDOW_KM / 2));
    const b = this.pointAt(Math.min(this.length, distKm + WINDOW_KM / 2));
    if (!a || !b) return 0;
    // Degenerate window — the whole line is shorter than it — so fall back to
    // the ends, which is the only heading there is.
    if (a.lat === b.lat && a.lon === b.lon) {
      return Track.bearing(this.lat[0]!, this.lon[0]!, this.lat[this.lat.length - 1]!, this.lon[this.lon.length - 1]!);
    }
    return Track.bearing(a.lat, a.lon, b.lat, b.lon);
  }

  /** Plain position lookup, without the bearing — used by bearingAt itself. */
  private pointAt(distKm: number): { lat: number; lon: number } | null {
    const n = this.cum.length;
    if (n < 2) return null;
    const d = Math.max(0, Math.min(distKm, this.length));

    // Binary search, not a scan: this runs twice per frame on lines of several
    // thousand vertices, and it deliberately does not use the animation cursor
    // — looking ahead and behind must not disturb where the train is.
    let lo = 1;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid]! < d) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    const a = this.cum[i - 1]!;
    const span = this.cum[i]! - a;
    const f = span > 0 ? (d - a) / span : 0;
    return {
      lat: this.lat[i - 1]! + (this.lat[i]! - this.lat[i - 1]!) * f,
      lon: this.lon[i - 1]! + (this.lon[i]! - this.lon[i - 1]!) * f,
    };
  }

  static bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const dLon = (bLon - aLon) * RAD;
    const y = Math.sin(dLon) * Math.cos(bLat * RAD);
    const x =
      Math.cos(aLat * RAD) * Math.sin(bLat * RAD) -
      Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos(dLon);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
}
