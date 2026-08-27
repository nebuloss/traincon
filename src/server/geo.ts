/** Great-circle helpers, shared by the rail graph and the position engine. */

export const EARTH_KM = 6371;

export const rad = (d: number): number => (d * Math.PI) / 180;
export const deg = (r: number): number => (r * 180) / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversine(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export function haversineRaw(aLat: number, aLon: number, bLat: number, bLon: number): number {
  return haversine({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
}

/** Initial bearing a -> b, degrees clockwise from north. */
export function bearing(a: LatLon, b: LatLon): number {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point at fraction f (0..1) along the great circle a -> b. */
export function greatCircle(a: LatLon, b: LatLon, f: number): LatLon {
  const d = haversine(a, b) / EARTH_KM;
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x =
    A * Math.cos(rad(a.lat)) * Math.cos(rad(a.lon)) +
    B * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon));
  const y =
    A * Math.cos(rad(a.lat)) * Math.sin(rad(a.lon)) +
    B * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon));
  const z = A * Math.sin(rad(a.lat)) + B * Math.sin(rad(b.lat));
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) };
}
