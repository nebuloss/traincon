/**
 * Every source and layer the map draws, and the order they go on in.
 *
 * The order is the point of keeping them together. MapLibre stacks layers as
 * they are added, and these arrive in two waves: the network, the station
 * track layout and the train's own body at startup, then the route layers on
 * the first train shown. Appending the second wave would draw the route over
 * the train, so those three name a `beforeId` — and the layer each one names
 * is created here, in this file, above it.
 *
 * Nothing here reads the view's state. Each takes the map and adds to it,
 * which is what lets the whole set be read in one place and checked without a
 * browser.
 */

import { Theme } from '../app/Theme.ts';
import { PLAN_ZOOM, metresPerPixel } from '../train/train-icon.ts';
import { iconScale } from '../train/train-art.ts';
import type { MapLike } from './maplibre.ts';
import type { JourneyGeo, TrainCarsGeo } from '../types.ts';

/** Nothing to draw — used to create and to clear the train-body source. */
export const EMPTY_BODY: TrainCarsGeo = { type: 'FeatureCollection', features: [] };

/**
 * The far anchor of the icon-size expression: MapLibre's own maximum zoom.
 *
 * Two stops are enough to be exact rather than approximate. Base-2
 * interpolation between values an exact power of two apart reproduces the true
 * scale at every zoom between them, and the scale is exactly that: a vehicle
 * is a fixed length on the ground, so its size in pixels doubles per zoom.
 */
export const MAX_PLAN_ZOOM = 22;

/**
 * Individual tracks and platforms, from OpenStreetMap, at close zoom.
 *
 * The route the app draws is a centreline — one line for the whole railway,
 * so a station's half-dozen platform roads collapse into a single stroke and
 * two trains standing in it appear on top of each other. OSM maps each track
 * separately where anyone has surveyed it, which in practice means the
 * stations: measured at Paris Montparnasse, 119 ways with 5.2 m between the
 * closest pair, which is real track spacing.
 *
 * Taken as tiles the map fetches itself rather than as a bulk download: only
 * what is on screen is requested, which is both far less data and the polite
 * way to use somebody else's tile server. Attribution is set on the source
 * so MapLibre shows it.
 *
 * Only the layout is drawn. Which platform a train is standing at is not
 * published — GTFS carries no platform field, and Navitia's stop_point is
 * per mode with platform_code empty — so the train stays on its centreline
 * rather than being placed on a track chosen by guesswork.
 */
export function addStationTracks(map: MapLike): void {
  if (map.getSource('osmrail')) return;
  try {
    map.addSource('osmrail', {
      type: 'vector',
      // No .pbf: that form answers 301 to this one, so every tile paid for
      // a redirect. Both hops send CORS, which is why it half-worked.
      tiles: ['https://tiles.tchoo.net/osmrailways/{z}/{x}/{y}'],
      minzoom: 12,
      maxzoom: 14,
      attribution:
        '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> · ' +
        '<a href="https://carto.tchoo.net" target="_blank" rel="noopener">Carto Tchoo</a>',
    });

    // Platforms first, so the track is drawn over them the way it lies.
    // They are polygons in these tiles, not edges: a fill, with its outline
    // drawn separately so a narrow platform still reads at z15.
    map.addLayer({
      id: 'osm-platforms',
      type: 'fill',
      source: 'osmrail',
      'source-layer': 'platforms',
      minzoom: 15,
      paint: {
        'fill-color': Theme.token('muted'),
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.45],
      },
    });
    map.addLayer({
      id: 'osm-platform-edges',
      type: 'line',
      source: 'osmrail',
      'source-layer': 'platforms',
      minzoom: 15,
      paint: {
        'line-color': Theme.token('muted'),
        'line-width': 1.2,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.85],
      },
    });

    // Track, drawn as track: a brown bed of sleepers with two steel rails
    // running over it. Far out that collapses to a single brown line, which
    // is all the width there is for; the sleepers and the rails appear once
    // there are pixels to draw them in.
    //
    // Four layers over one source rather than one line in a compromise
    // colour, because the compromise was the problem: a slate line at this
    // zoom read as one more grey line on a grey basemap.
    map.addLayer({
      id: 'osm-track-bed',
      type: 'line',
      source: 'osmrail',
      'source-layer': 'tracks',
      minzoom: 12.5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': Theme.token('tie'),
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 16, 3, 19, 10],
        // Faded in over a zoom level so it does not appear abruptly. The
        // ramp used to end where the layer began, so the tracks were fully
        // transparent at every zoom they were drawn at.
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, 0.9],
      },
    });

    // The sleepers themselves: the bed again, dashed across. Dash lengths
    // are multiples of the line width, so the ties keep their spacing as
    // the track thickens.
    map.addLayer({
      id: 'osm-track-ties',
      type: 'line',
      source: 'osmrail',
      'source-layer': 'tracks',
      minzoom: 15.5,
      paint: {
        'line-color': Theme.token('tie-dark'),
        // Wider than the ballast it sits on, because a sleeper is: 2.6 m of
        // timber under a 1.435 m gauge, ends proud of the rails.
        'line-width': ['interpolate', ['linear'], ['zoom'], 15.5, 3, 19, 13],
        // Fewer sleepers than there really are, and each one far chunkier.
        // At true size they are 26 cm of timber every 60 cm, which even at
        // z19 is well under a pixel — drawn honestly they are invisible, so
        // roughly every fourth one is drawn and given the room to read.
        'line-dasharray': [0.5, 0.5],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 15.5, 0, 16.5, 0.95],
      },
    });

    // Two rails, offset either side of the centreline — which is what makes
    // it read as track rather than as a brown line.
    for (const side of [-1, 1] as const) {
      map.addLayer({
        id: `osm-track-rail-${side < 0 ? 'l' : 'r'}`,
        type: 'line',
        source: 'osmrail',
        'source-layer': 'tracks',
        minzoom: 16,
        paint: {
          'line-color': Theme.token('steel'),
          'line-width': ['interpolate', ['linear'], ['zoom'], 16, 0.8, 19, 2.2],
          // Half the 1.435 m gauge, in pixels, so the rails sit where they
          // really do — well inside the ends of the sleepers.
          'line-offset': ['interpolate', ['linear'], ['zoom'], 16, 0.9 * side, 19, 3.4 * side],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 16, 0, 17, 0.95],
        },
      });
    }

    // Platform numbers, from OSM's ref. Which platform a train is at is not
    // published by anyone — GTFS has no such field, Navitia's platform_code
    // is empty, and Carto Tchoo's own endpoint for it is called
    // guess_my_platform and returns a confidence percentage — so these label
    // the ground rather than the train. Knowing where platform 3 is still
    // helps when the departure board tells you to go there.
    map.addLayer({
      id: 'osm-platform-refs',
      type: 'symbol',
      source: 'osmrail',
      'source-layer': 'platforms',
      minzoom: 16,
      filter: ['has', 'ref'],
      layout: {
        'text-field': ['get', 'ref'],
        'text-size': 11,
        'text-font': ['Noto Sans Regular'],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': Theme.token('fg'),
        'text-halo-color': Theme.token('panel'),
        'text-halo-width': 1.6,
      },
    });
  } catch {
    // A third-party tile server is a nicety, not a requirement.
  }
}

/**
 * The train drawn on the ground, once the zoom makes it worth drawing.
 *
 * One symbol per vehicle, from the artwork in assets/train, each rotated to
 * its own heading — which is what lets the train bend round a curve. See
 * train/train-body for the layout and train/train-art for the drawings.
 *
 * Overlap is forced on. Symbols are normally allowed to hide each other to
 * keep labels readable, and a train is precisely a row of symbols touching
 * end to end, so left to itself MapLibre would drop every other vehicle.
 */
export function addTrainBody(map: MapLike): void {
  if (map.getSource('train-body')) return;
  map.addSource('train-body', { type: 'geojson', data: EMPTY_BODY });
  map.addLayer({
    id: 'train-cars',
    type: 'symbol',
    source: 'train-body',
    minzoom: PLAN_ZOOM,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-rotate': ['get', 'bearing'],
      // Turn with the map, not with the screen: these are objects lying on
      // the ground, not labels pinned to it.
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-padding': 0,
      // Set from the zoom on every draw, so the train stays at true scale.
      'icon-size': 0.1,
    },
  });
}

/** The in-service network, so a train sits visibly on its track. */
export function addRailLayers(map: MapLike): void {
  if (map.getSource('rail')) return;
  try {
    map.addSource('rail', { type: 'geojson', data: '/api/rail.geojson' });
    map.addLayer({
      id: 'rail-classic',
      type: 'line',
      source: 'rail',
      filter: ['!=', ['get', 'hs'], 1],
      paint: {
        'line-color': Theme.token('rail'),
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 8, 0.9, 12, 1.8],
        'line-opacity': 0.6,
      },
    });
    map.addLayer({
      id: 'rail-hs',
      type: 'line',
      source: 'rail',
      filter: ['==', ['get', 'hs'], 1],
      paint: {
        'line-color': Theme.token('rail-hs'),
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 1.6, 12, 2.8],
        'line-opacity': 0.85,
      },
    });
  } catch (e) {
    console.warn('rail layer unavailable', e);
  }
}

/**
 * The journey: its route, the matched version of it, and its stops.
 *
 * Added on the first train shown rather than at startup, because until then
 * there is no route to add. That is what makes the `beforeId` arguments below
 * necessary: the train's own layers already exist by now, so appending would
 * put the route over the train.
 */
export function addFollowLayers(map: MapLike, geo: JourneyGeo): void {
  const existing = map.getSource('follow');
  if (existing) {
    existing.setData(geo);
    return;
  }

  map.addSource('follow', { type: 'geojson', data: geo });
  map.addSource('follow-real', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  // Inserted under the train, not appended: these layers are created on
  // the first train shown, long after the body layers exist at startup,
  // so left to the default order the route line would be drawn over the
  // train.
  const underTrain = map.getLayer('train-cars') ? 'train-cars' : undefined;

  // The route as it is really laid: the schematic centreline resampled
  // and put onto the surveyed track — see rail/rail-match.
  //
  // Under the ballast rather than over it, so it reads as a highlight
  // along the track the train uses: the bed, sleepers and rails are
  // drawn on top, and this shows as a coloured edge either side of them.
  // Drawn over, it would hide the very track it is pointing at.
  map.addLayer(
    {
      id: 'follow-real',
      type: 'line',
      source: 'follow-real',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': Theme.token('accent'),
        // Wider than the track bed at every zoom by about its own width
        // again, which is what leaves an edge showing either side.
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3, 16, 7, 19, 18],
        // The mirror of the schematic line's fade below: as the
        // centreline gives up, this takes over. Between the two the
        // route is drawn at every zoom, and only the accurate one
        // survives close in, where the difference can be seen.
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.5, 16, 0.85],
      },
    },
    map.getLayer('osm-track-bed') ? 'osm-track-bed' : underTrain,
  );
  map.addLayer(
    {
      id: 'follow-path',
      type: 'line',
      source: 'follow',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: {
        'line-color': Theme.token('accent'),
        // Thins and fades as the surveyed tracks come in: close up the
        // real track layout is the better answer, and a fat centreline
        // drawn across six platform roads is actively misleading. Kept
        // faintly rather than dropped, so the route is still traceable.
        // Gone by the time the drawn track and the train itself are
        // there to look at. It is a schematic centreline: one stroke for
        // the whole railway, so close in it lies across every platform
        // road at once and disagrees with the track under it.
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3.5, 16, 1.2],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.9, 15, 0.45, 16, 0.15],
      },
    },
    underTrain,
  );
  map.addLayer(
    {
      id: 'follow-stops',
      type: 'circle',
      source: 'follow',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'terminus'], 1], 5.5, 4],
        'circle-color': Theme.token('panel'),
        'circle-stroke-color': Theme.token('accent'),
        'circle-stroke-width': 1.5,
      },
    },
    underTrain,
  );
}

/**
 * How big to draw the vehicles, as an expression the style evaluates itself.
 *
 * icon-size used to be set imperatively whenever the zoom moved, and setting
 * a layout property re-lays out every symbol in the layer. During a pinch
 * that is a re-layout per frame, on top of a setData per frame rebuilding
 * geometry that does not depend on the zoom at all — the churn the vehicles
 * flickered under. As an expression the style scales them itself.
 *
 * Only the latitude has to be fed in, because a metre is fewer degrees of
 * longitude the further north you go.
 */
export function iconSizeExpression(lat: number): unknown[] {
  const at = (zoom: number): number => iconScale(metresPerPixel(zoom, lat));
  return [
    'interpolate',
    ['exponential', 2],
    ['zoom'],
    PLAN_ZOOM,
    at(PLAN_ZOOM),
    MAX_PLAN_ZOOM,
    at(MAX_PLAN_ZOOM),
  ];
}
