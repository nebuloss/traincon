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
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.lat.length; i++) {
      const d = haversine(lat, lon, this.lat[i]!, this.lon[i]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return this.cum[best] ?? 0;
  }

  /**
   * The point a given distance along, with the local bearing.
   *
   * The cursor walks forward with the train, so successive calls during an
   * animation cost a comparison rather than a search. It rewinds only when
   * asked to go backwards, which happens when a server update corrects the
   * estimate.
   */
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
      bearing: Track.bearing(lat0, lon0, lat1, lon1),
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
