/**
 * The map, showing one train on real track.
 *
 * Built lazily and resized whenever its panel appears — MapLibre measures zero
 * if created in a hidden container. Zoom follows speed, because positional
 * uncertainty scales with it: the estimate comes from a timetable, so a
 * one-minute error is 1.7 km at 100 km/h but 5 km at 300.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import { Reckoner } from '../core/Reckoner.ts';
import { Track } from '../core/Track.ts';
import { aspectLamp } from './SignalAspect.ts';
import { PLAN_ZOOM, discView, liveryOf, metresPerPixel, trainLengthM, unitsOf } from './TrainIcon.ts';
import { trainCars } from '../core/TrainBody.ts';
import { zoomForSpeed } from '../core/Framing.ts';
import { MAX_SNAP_M, snapToLine, snapToTrack } from '../core/TrackSnap.ts';
import type { Line, Point } from '../core/TrackSnap.ts';
import { keepsLeft } from '../core/RunningSide.ts';
import { SAMPLE_M, matchToRails } from '../core/RailMatch.ts';
import type { Sample } from '../core/RailMatch.ts';
import { ensureLivery, iconScale } from '../core/TrainArt.ts';
import { plausibleSpeed } from '../core/stock.ts';
import { distanceFraction } from '../core/motion.ts';
import { Theme } from '../core/Theme.ts';
import type { Api } from '../core/Api.ts';
import type { JourneyGeo, JourneyLine, TrainCarsGeo, TrainDTO } from '../types.ts';

/** MapLibre is loaded from a script tag; this is the surface we rely on. */
interface MapLike {
  on(ev: string, fn: () => void): void;
  once(ev: string, fn: () => void): void;
  addControl(c: unknown, pos?: string): void;
  addSource(id: string, src: unknown): void;
  addLayer(layer: unknown, before?: string): void;
  setPaintProperty(layer: string, prop: string, value: unknown): void;
  setLayoutProperty(layer: string, prop: string, value: unknown): void;
  querySourceFeatures(
    source: string,
    opts: { sourceLayer: string },
  ): Array<{
    id?: string | number;
    properties?: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown };
  }>;
  hasImage(id: string): boolean;
  addImage(id: string, image: ImageData, options?: { pixelRatio?: number }): void;
  getSource(id: string): { setData(d: unknown): void } | undefined;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  removeSource(id: string): void;
  setStyle(url: string): void;
  easeTo(o: unknown): void;
  setCenter(c: [number, number]): void;
  getCenter(): { lng: number; lat: number };
  fitBounds(b: unknown, o: unknown): void;
  getZoom(): number;
  project(lngLat: [number, number]): { x: number; y: number };
  isMoving(): boolean;
  getContainer(): HTMLElement;
  resize(): void;
}
interface MarkerLike {
  setLngLat(c: [number, number]): MarkerLike;
  addTo(m: MapLike): MarkerLike;
  setRotation(d: number): void;
  getElement(): HTMLElement;
  remove(): void;
}
declare const maplibregl: {
  Map: new (o: unknown) => MapLike;
  Marker: new (o: unknown) => MarkerLike;
  NavigationControl: new () => unknown;
};

export type MapMode = 'train' | 'route';

/**
 * The zoom at which the route stops being drawn as a schematic and starts
 * being drawn on the rails.
 *
 * It is where the centreline begins to fade, which is where its disagreement
 * with the track under it first becomes visible: a railway is a single stroke
 * on the map below this, so there is nothing to be beside.
 */
const MATCH_MIN_ZOOM = 14;

/** How often the route may be re-laid onto the rails, at most. */
const MATCH_MS = 500;

/**
 * The zoom from which the vehicles are kept ready in the source.
 *
 * One level below the zoom they are drawn at. Filling the source is
 * asynchronous — it re-tiles in a worker — while hiding the disc is a CSS
 * class and takes effect at once. Doing both at the same zoom left a gap with
 * neither representation on screen, which is what a zoom across the threshold
 * looked like. A level of hysteresis means the data is tiled and waiting by
 * the time the layer switches on.
 */
const KEEP_BODY_ZOOM = PLAN_ZOOM - 1;

/**
 * The far anchor of the icon-size expression: MapLibre's own maximum zoom.
 *
 * Two stops are enough to be exact rather than approximate. Base-2
 * interpolation between values an exact power of two apart reproduces the true
 * scale at every zoom between them, and the scale is exactly that: a vehicle
 * is a fixed length on the ground, so its size in pixels doubles per zoom.
 */
const MAX_PLAN_ZOOM = 22;

/** Nothing to draw — used to create and to clear the train-body source. */
const EMPTY_BODY: TrainCarsGeo = { type: 'FeatureCollection', features: [] };

export class MapView {
  private map: MapLike | null = null;
  private marker: MarkerLike | null = null;
  /** Which train the marker is currently drawn for, so it is only rebuilt on a change. */
  private markerForm: string | null = null;
  /** The train last drawn, so a zoom change can redraw it without a refresh. */
  private drawn: TrainDTO | null = null;
  /** Where along the route it was last drawn — the animated position, not the reported one. */
  private drawnKm: number | null = null;
  /** Liveries whose artwork has been handed to the map already. */
  private readonly liveries = new Set<string>();
  /** Whether the view is meant to keep the train in sight. */
  private following = false;
  /**
   * Whether the reader has asked for less movement.
   *
   * It does not mean "withhold the position". A train's whereabouts is the
   * content of this view, not decoration on it, and freezing it turns the
   * feature off. What the setting is asking for is the absence of gratuitous
   * motion, so the position is still kept up to date — less often, and
   * without gliding — while the easing and the transitions go.
   */
  private reduced = false;
  /**
   * Surveyed track near the train, as individual segments — see core/TrackSnap.
   *
   * Cut down to the train's neighbourhood rather than kept for the whole
   * viewport. A view at this zoom holds a few thousand segments, and snapping
   * every vehicle against all of them twelve times a second is most of a
   * million distance tests per second for no benefit: a train cannot be near
   * track that is a kilometre away.
   */
  private railSegs: Line[] = [];
  /**
   * The track the train is on, and the line itself.
   *
   * Held between frames so it does not change under the train: on a
   * double-track line the two running lines are metres apart and both point
   * the same way, so "whichever is nearest" flips between them. And every
   * vehicle is put on this one line, because a train is on one track.
   */
  private snappedTo: string | null = null;
  private chosenLine: Line | null = null;
  /**
   * True while this is the one moving the map.
   *
   * setCenter fires movestart, move and moveend synchronously, inside the
   * call. The moveend handler centres on the train, so without this it
   * centres, which fires moveend, which centres... until the stack runs out.
   * That is exactly what it did: a RangeError out of MapLibre's handler
   * manager the moment a train was followed.
   */
  private centring = false;
  /** The icon scale last given to the layer, so it is only set when it moves. */
  /** The latitude the icon-size expression was last built for. */
  private iconLat: number | null = null;
  /** Liveries whose artwork is registered with the map and can be drawn. */
  private readonly liveryReady = new Set<string>();
  /** The livery the drawn train wants, so showBody knows what to wait for. */
  private drawnLivery: string | null = null;
  /** Whether the source actually holds vehicles at this moment. */
  private bodyDrawn = false;
  /** Where and when that was gathered, so it is not re-queried per frame. */
  private railSegsAt = 0;
  private railSegsNear: Point | null = null;

  /**
   * Surveyed track across the whole view, as opposed to the box around the
   * train that railSegs holds. Matching the route needs everything on screen;
   * snapping the train needs only what is under it.
   */
  private railView: Line[] = [];
  private railViewAt = 0;
  /** Where the view was when the route was last laid onto the rails. */
  private matchedKey = '';
  private matchedAt = 0;
  private theme: 'light' | 'dark' | null = null;
  private pathFor: string | null = null;
  private geo: JourneyGeo | null = null;
  private lastAutoZoom: number | null = null;

  /**
   * Dead reckoning between server updates.
   *
   * Positions are recomputed once a minute and polled every thirty seconds, so
   * a train watched on the map sat still and then jumped. `track` measures the
   * route already drawn; `moving` records where the train was and how fast,
   * and the animation advances it from there until the next real position
   * replaces the estimate.
   */
  private track: Track | null = null;
  /** Distance along `track` of each call, so a leg's extent is known. */
  private stopKm: number[] = [];
  /** Motion profile per leg, from the server — see core/motion.ts. */
  private legProfiles: number[][] = [];
  private readonly reckoner = new Reckoner();
  private animating = false;
  private raf: number | null = null;

  constructor(
    private readonly api: Api,
    private readonly themeManager: Theme,
    private readonly containerId = 'map',
  ) {}

  /**
   * Zoom chosen from speed, so that the train can be seen to move.
   *
   * The rule, and why it is the apparent speed rather than the true one that
   * decides, is in core/Framing.
   */
  static zoomForSpeed(kmh: number): number {
    return zoomForSpeed(kmh);
  }

  /** Build the map lazily; it measures zero if created while hidden. */
  async ensure(): Promise<void> {
    if (this.map) {
      requestAnimationFrame(() => this.map?.resize());
      return;
    }
    this.map = new maplibregl.Map({
      container: this.containerId,
      style: this.themeManager.mapStyle,
      center: [2.4, 46.6],
      zoom: 4.7,
      attributionControl: true,
    });
    this.theme = this.themeManager.isDark ? 'dark' : 'light';
    this.map.addControl(new maplibregl.NavigationControl(), 'top-right');
    // Crossing the threshold swaps the disc for the body drawn on the ground,
    // and that is all a zoom can change. The vehicles' positions do not depend
    // on it — trainCars is not given one — and their size is an expression the
    // style evaluates for itself, so there is nothing here to rebuild.
    //
    // This used to call drawBody, which meant a setData and an icon-size
    // layout property per zoom event: a source re-tile and a full symbol
    // re-layout, both in a worker, at the display's rate. The animation loop
    // throttles exactly that work to twelve times a second and says why; the
    // zoom path went round the throttle.
    this.map.on('zoom', () => {
      this.showBody();
    });
    // A pinch zooms about the fingers, not about the train, so the train can
    // end up off to one side or off the screen entirely. Once the movement
    // settles, bring it back — this also covers a stopped train, which runs
    // no animation loop to notice for itself.
    // Once a gesture settles, take the train back. A stopped train runs no
    // animation loop, so without this the view would stay where it was left.
    this.map.on('moveend', () => {
      const at = this.drawnPoint();
      if (at) this.centreOnTrain(at);
    });
    // Idle is the first moment the surveyed track is actually available: the
    // camera has stopped and the tiles under it have loaded. A train with no
    // animation loop gets its one chance to snap onto the rails here — before
    // this fires there is nothing to snap to, however many times it is asked.
    this.map.on('idle', () => {
      // Not while the map is off screen. The modal keeps its panels in the DOM
      // when you switch tab, and the animation loop stops itself for the same
      // reason — this would otherwise keep working, and keep taking the view
      // back to a train nobody is looking at.
      if (!document.getElementById('mpanel-carte')?.classList.contains('active')) return;
      // Idle means the tiles are in, which is the whole condition for being
      // able to match the route at all. It is also the only moment a map the
      // reader has panned by hand ever gets, so this runs before the guard
      // below: a still map has no animation loop to do it instead.
      this.matchRoute();
      if (this.animating || !this.drawn) return;
      this.settle(this.drawn);
    });
    await new Promise<void>((r) => this.map!.on('load', () => r()));
    this.addRailLayers();
    this.addStationTracks();
    this.addTrainBody();
    requestAnimationFrame(() => this.map?.resize());
  }

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
  private addStationTracks(): void {
    if (!this.map || this.map.getSource('osmrail')) return;
    try {
      this.map.addSource('osmrail', {
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
      this.map.addLayer({
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
      this.map.addLayer({
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
      this.map.addLayer({
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
      this.map.addLayer({
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
        this.map.addLayer({
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
      this.map.addLayer({
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
   * core/TrainBody for the layout and core/TrainArt for the drawings.
   *
   * Overlap is forced on. Symbols are normally allowed to hide each other to
   * keep labels readable, and a train is precisely a row of symbols touching
   * end to end, so left to itself MapLibre would drop every other vehicle.
   */
  private addTrainBody(): void {
    if (!this.map || this.map.getSource('train-body')) return;
    this.map.addSource('train-body', { type: 'geojson', data: EMPTY_BODY });
    this.map.addLayer({
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
  private addRailLayers(): void {
    if (!this.map || this.map.getSource('rail')) return;
    try {
      this.map.addSource('rail', { type: 'geojson', data: '/api/rail.geojson' });
      this.map.addLayer({
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
      this.map.addLayer({
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
   * Swap the basemap when the theme changes.
   * setStyle() drops every custom source and layer, so they are rebuilt once
   * the new style reports ready.
   */
  restyle(onReady: () => void): void {
    if (!this.map) return;
    const want = this.themeManager.isDark ? 'dark' : 'light';
    if (this.theme === want) return;
    this.theme = want;
    this.pathFor = null;
    this.marker?.remove();
    this.marker = null;
    // setStyle drops the registered images along with the layers, and the set
    // of liveries already asked for is what stops them being asked for again.
    // Left uncleared, the vehicles never got their artwork back after a theme
    // change — and since the disc had already been hidden for them, the train
    // disappeared entirely.
    this.liveries.clear();
    this.liveryReady.clear();
    this.drawnLivery = null;
    this.bodyDrawn = false;
    this.iconLat = null;
    this.map.setStyle(this.themeManager.mapStyle);
    this.map.once('styledata', () => {
      this.addRailLayers();
      this.addStationTracks();
      this.addTrainBody();
      onReady();
    });
  }

  /** Frame the map: close on the train, or the whole journey on request. */
  private frame(t: TrainDTO, mode: MapMode, initial: boolean): void {
    if (!this.map) return;
    if (mode === 'route' && this.geo) {
      const line = this.geo.features.find((f) => f.geometry.type === 'LineString') as
        | JourneyLine
        | undefined;
      if (line?.geometry.coordinates.length) {
        const b = line.geometry.coordinates.reduce(
          (a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[0]), Math.max(a[3], c[1])],
          [180, 90, -180, -90],
        );
        this.map.fitBounds(
          [
            [b[0], b[1]],
            [b[2], b[3]],
          ],
          { padding: 45, duration: initial ? 0 : 700 },
        );
        return;
      }
    }
    const want = MapView.zoomForSpeed(t.position.speedKmh);
    this.lastAutoZoom = want;
    this.map.easeTo({
      center: this.drawnPoint() ?? [t.position.lon, t.position.lat],
      zoom: want,
      duration: initial ? 0 : 700,
    });
  }

  /**
   * Where the train is actually drawn, as [lon, lat].
   *
   * Not the same as the position the server reported, and at these zooms the
   * difference is the whole screen. Two things move it: the reported point is
   * projected onto the drawn route so it sits on its own line, and between
   * refreshes the train is advanced along that route by dead reckoning — at
   * 300 km/h and thirty seconds between updates, two and a half kilometres of
   * it. Centring on the reported point put the train off the edge of the view.
   */
  private drawnPoint(): [number, number] | null {
    if (!this.track || this.drawnKm === null) return null;
    const here = this.track.at(this.drawnKm);
    return here ? [here.lon, here.lat] : null;
  }

  /** Redraw for a train; `reframe` forces the framing rule to reapply. */
  async show(t: TrainDTO, mode: MapMode, follow: boolean, reframe: boolean): Promise<void> {
    if (!this.map) return;
    this.following = follow;
    const p = t.position;

    if (this.pathFor !== t.number) {
      this.geo = await this.api.journey(t.number);
      const src = this.map.getSource('follow');
      if (src) src.setData(this.geo);
      else {
        this.map.addSource('follow', { type: 'geojson', data: this.geo });
        this.map.addSource('follow-real', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // Inserted under the train, not appended: these layers are created on
        // the first train shown, long after the body layers exist at startup,
        // so left to the default order the route line would be drawn over the
        // train.
        const underTrain = this.map.getLayer('train-cars') ? 'train-cars' : undefined;

        // The route as it is really laid: the schematic centreline resampled
        // and put onto the surveyed track — see core/RailMatch.
        //
        // Under the ballast rather than over it, so it reads as a highlight
        // along the track the train uses: the bed, sleepers and rails are
        // drawn on top, and this shows as a coloured edge either side of them.
        // Drawn over, it would hide the very track it is pointing at.
        this.map.addLayer(
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
          this.map.getLayer('osm-track-bed') ? 'osm-track-bed' : underTrain,
        );
        this.map.addLayer(
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
        this.map.addLayer(
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
      this.pathFor = t.number;
      // The matched line belongs to the route that has just been replaced.
      this.matchedKey = '';
      this.map.getSource('follow-real')?.setData({ type: 'FeatureCollection', features: [] });
      this.reckoner.reset();
      const line = this.geo.features.find((f) => f.geometry.type === 'LineString');
      this.track = line
        ? new Track((line.geometry as { coordinates: number[][] }).coordinates)
        : null;
      this.legProfiles =
        (line?.properties as { legProfiles?: number[][] } | undefined)?.legProfiles ?? [];

      // Where each call sits along the drawn route, so the animation knows the
      // extent of the leg it is interpolating within. Linear in the number of
      // vertices per stop, run once when a train's route is loaded.
      this.stopKm = this.track
        ? t.calls.map((c) => this.track!.distanceAt(c.lat, c.lon))
        : [];
      this.frame(t, mode, true);
    } else if (reframe) {
      this.frame(t, mode, false);
    } else if (follow) {
      // Follow the speed-derived zoom only while the view is still close to
      // it; once the user has zoomed themselves, just recentre.
      const want = MapView.zoomForSpeed(p.speedKmh);
      const cur = this.map.getZoom();
      const auto = Math.abs(cur - (this.lastAutoZoom ?? cur)) < 0.35;
      // While the loop is running it is already holding the train in the
      // middle of the view, frame by frame. Easing the centre here as well
      // would drag the map away from where the next frame puts it back, so
      // only the zoom is touched.
      if (this.animating) {
        if (auto && Math.abs(cur - want) > 0.01) this.map.easeTo({ zoom: want, duration: 900 });
      } else {
        this.map.easeTo({
          center: this.drawnPoint() ?? [p.lon, p.lat],
          zoom: auto ? want : cur,
          duration: 900,
        });
      }
      if (auto) this.lastAutoZoom = want;
    }

    this.drawMarker(t);
    this.startDeadReckoning(t);
    // A moving train is placed by the loop, frame by frame. A stopped one has
    // no loop, so it is placed here instead.
    if (!this.animating) this.settle(t);
  }

  /**
   * Begin advancing the marker from the position just received.
   *
   * Stopped or off-track there is nothing to advance, and the marker stays
   * exactly where the server put it.
   *
   * Reduced motion used to stop it here too, which was a mistake: it meant a
   * reader with that setting saw the train jump once a refresh and sit still
   * in between, at every speed, however fast it was really going. The
   * position is information. What that setting asks for is the absence of
   * gratuitous movement, so the loop still runs — slower, and without any
   * gliding — rather than not at all.
   */
  private startDeadReckoning(t: TrainDTO): void {
    this.stopAnimation();

    const p = t.position;
    const kmh = p.speedKmh ?? 0;
    this.reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.showSpeed(kmh, p.limitKmh);
    this.showAspect(t);
    // Legs with no routed track are animated too, along the straight line the
    // map draws for them. That is the same interpolation the server already
    // uses for the position there, and the marker renders dashed to say so —
    // whereas a train that simply stops moving for half its journey reads as
    // broken.
    if (!this.track || !kmh || this.stopKm.length < 2) {
      this.reckoner.reset();
      return;
    }

    this.animating = true;

    // The frame does two quite different amounts of work, so it is split.
    //
    // Cheap, every frame: read the model, move the marker, hold the centre.
    // This is what has to run at the display's own rate — the map pans with
    // the train now, and a pan stepped twelve times a second judders. All of
    // it is arithmetic and two setters.
    //
    // Expensive, a few times a second: rebuilding the vehicles and pushing
    // them through setData, which re-tiles the source in a worker, plus the
    // icon-size layout property and the walk over tile features to find track
    // to snap to. None of that is worth doing per frame — at these speeds the
    // train moves well under a metre between them.
    //
    // Under reduced motion both drop to twice a second: the position stays
    // current, and it steps rather than glides, which is what was asked for.
    const BODY_MS = this.reduced ? 500 : 80;
    const MOVE_MS = this.reduced ? 500 : 0;
    let lastBody = 0;
    let lastMove = 0;

    // Looked up once rather than on every frame.
    const panel = document.getElementById('mpanel-carte');
    const dir = this.marker?.getElement().querySelector<HTMLElement>('.tm-dir') ?? null;
    let lastBearing: number | null = null;

    const step = (): void => {
      if (!this.animating || !this.track || !this.marker) return;

      // Stop when the map is not on screen. The modal keeps its panels in the
      // DOM when you switch tab, so without this the loop would run on for as
      // long as the modal stayed open.
      if (!panel?.classList.contains('active')) {
        this.stopAnimation();
        return;
      }

      const frameAt = performance.now();
      if (frameAt - lastMove >= MOVE_MS) {
        const sinceLast = lastMove === 0 ? 16 : frameAt - lastMove;
        lastMove = frameAt;
        const km = this.modelledKm(t, Date.now() / 1000);
        if (km !== null) {
          // Corrections are absorbed by adjusting the drawn speed, so the
          // train never jumps and never reverses — it just runs a little fast
          // or a little slow until it agrees with the model again.
          // What this train on this line could actually do, so closing a
          // gap cannot draw it faster than that.
          const canDo = plausibleSpeed(Infinity, t.family, p.limitKmh);
          const drawKm = this.reckoner.follow(km, kmh, sinceLast, canDo);
          this.drawnKm = drawKm;
          const here = this.track.at(drawKm);
          if (here) {
            // The line speed comes from the train rather than the drawn point:
            // it is what says whether this is a high-speed line, and neither
            // that nor the region changes over the few hundred metres between
            // the reported position and the drawn one.
            const at = this.onSurveyedTrack(here.lon, here.lat, here.bearing, p.limitKmh);
            this.marker.setLngLat(at);
            this.centreOnTrain(at);
            // After the recentre, so the stretch matched is the one that will
            // be on screen. Throttled inside, and a no-op until the view moves.
            this.matchRoute();

            // The pointer only turns when the train does, which on a straight
            // line is hardly ever. Writing the same transform every frame
            // costs a style recalculation for nothing.
            if (dir && (lastBearing === null || Math.abs(here.bearing - lastBearing) > 0.5)) {
              lastBearing = here.bearing;
              dir.style.transform = `rotate(${here.bearing}deg) translateY(calc(-1 * var(--tm-orbit)))`;
            }

            if (frameAt - lastBody >= BODY_MS) {
              lastBody = frameAt;
              this.drawBody(t, drawKm);
            }
          }
        }
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /**
   * Where the model puts this train right now, in km along the route.
   *
   * The same computation the server performs — find the leg, take the elapsed
   * fraction of its scheduled duration, and read the leg's motion profile — so
   * the map is not approximating the server's answer between updates, it is
   * recomputing it. Returns null when the train is not between two calls.
   */
  private modelledKm(t: TrainDTO, nowSec: number): number | null {
    const calls = t.calls;
    for (let i = 0; i < calls.length - 1; i++) {
      const a = calls[i]!;
      const b = calls[i + 1]!;
      if (nowSec < a.time || nowSec > b.time) continue;

      const span = b.time - a.time;
      if (span <= 0) return this.stopKm[i] ?? null;

      const from = this.stopKm[i];
      const to = this.stopKm[i + 1];
      if (from === undefined || to === undefined) return null;

      const f = distanceFraction(this.legProfiles[i], (nowSec - a.time) / span);
      return from + (to - from) * f;
    }
    return null;
  }

  /** The deduced signal aspect, beside the speed. */
  private showAspect(t: TrainDTO): void {
    const el = document.getElementById('mapAspect');
    if (!el) return;
    const lamp = aspectLamp(t);
    el.innerHTML = lamp;
    el.hidden = !lamp;
  }


  /**
   * Give the marker the glyph for this train's type.
   *
   * Rewritten only when the train changes: this runs on every refresh, and
   * replacing the element's contents each time would restart the direction
   * pointer's transition and make it stutter.
   */
  private shapeMarker(el: HTMLElement, t: TrainDTO): void {
    const key = `${t.family}:${t.number}`;
    if (this.markerForm === key) return;
    this.markerForm = key;
    // No colour is set here: the marker is tinted by delay tier further down,
    // which is the more useful thing to read off a dot. The glyph carries the
    // type at this size; the ground body carries it in colour as well.
    const dir = el.querySelector('.tm-dir')?.outerHTML ?? '<i class="tm-dir"></i>';
    el.innerHTML = dir + discView(t);
  }

  /**
   * Redraw the body for a train whose nose is `km` along the route.
   *
   * The source is kept current from a level below the zoom the vehicles are
   * drawn at, and emptied below that or when there is no position to lay them
   * along. Emptied rather than left stale: the old geometry would otherwise
   * flash at the previous position on the next zoom in.
   */
  private drawBody(t: TrainDTO, km: number | null): void {
    this.drawnKm = km;
    const src = this.map?.getSource('train-body');
    if (!src || !this.map) return;

    // The artwork has to exist before the layer can name it, and loading it is
    // asynchronous. Until it arrives the layer draws nothing, which is why
    // showBody waits for it rather than hiding the disc on the zoom alone.
    const livery = liveryOf(t);
    this.drawnLivery = livery;
    if (!this.liveries.has(livery)) {
      this.liveries.add(livery);
      void ensureLivery(this.map, livery).then((ok) => {
        if (ok) this.liveryReady.add(livery);
        else this.liveries.delete(livery);
        // The swap was waiting on exactly this.
        this.showBody();
      });
    }

    // Whether the vehicles can be worked out at all — a different question
    // from whether they are on screen, which the layer's own minzoom answers
    // without a round trip through a worker.
    if (this.track === null || km === null || this.map.getZoom() < KEEP_BODY_ZOOM) {
      src.setData(EMPTY_BODY);
      this.bodyDrawn = false;
      this.showBody();
      return;
    }

    const here = this.track.at(km);
    this.sizeIcons(here?.lat ?? 47);
    // The unit count as well as the length: a coupled set is drawn as the two
    // whole trains it is, not as one of twice the length.
    const cars = trainCars(this.track, km, trainLengthM(t), t.family, livery, 24, unitsOf(t));
    // Each vehicle onto the rails drawn under it, and turned to match them.
    // Done per vehicle rather than for the train as a whole: that is what lays
    // a long train correctly round a curve the route only chords across.
    // Every vehicle onto the one track the train was put on, chosen at the
    // front by onSurveyedTrack. Letting each choose for itself meant a 200 m
    // set could straddle both running lines of a double-track railway at once.
    const line = this.chosenLine;
    if (line) {
      for (const f of cars.features) {
        const [lon, lat] = f.geometry.coordinates;
        const hit = snapToLine(lon, lat, line);
        if (!hit) continue;
        f.geometry.coordinates = [hit.lon, hit.lat];
        // Undo what the artwork needs — nose-right, and a rear cab turned
        // round — to compare directions, then put it back on.
        const heading = f.properties.bearing + 90 - (f.properties.reversed ? 180 : 0);
        const diff = ((((hit.bearing - heading) % 360) + 540) % 360) - 180;
        const along = Math.abs(diff) > 90 ? hit.bearing + 180 : hit.bearing;
        f.properties.bearing = along - 90 + (f.properties.reversed ? 180 : 0);
      }
    }
    src.setData(cars);
    this.bodyDrawn = cars.features.length > 0;
    this.showBody();
  }

  /**
   * Which of the two representations is showing.
   *
   * The disc and the vehicles are drawn by different machinery — a DOM marker
   * against a symbol layer — so something has to see to it that exactly one is
   * on. The class hides the disc the instant it is set, while the layer needs
   * its data tiled and its artwork registered before it can draw anything, so
   * asking only whether the zoom is high enough leaves a moment with neither.
   * That moment is what a zoom across the threshold looked like, and a slow
   * train is framed at 14.5 to 15 — on the threshold — so it is the case where
   * the gap is crossed most.
   *
   * The disc therefore goes only once the body can actually replace it, and
   * everything that changes that answer calls this again.
   */
  private showBody(): void {
    const el = this.marker?.getElement();
    if (!el) return;
    const ready =
      this.bodyDrawn &&
      this.drawnLivery !== null &&
      this.liveryReady.has(this.drawnLivery) &&
      // The same threshold the train-cars layer carries as its minzoom. If the
      // two ever disagree, a band of zooms shows both or neither.
      (this.map?.getZoom() ?? 0) >= PLAN_ZOOM;
    el.classList.toggle('is-bodied', ready);
  }

  /**
   * Size the vehicles from the zoom, once, rather than on every draw.
   *
   * icon-size used to be set imperatively whenever the zoom moved, and setting
   * a layout property re-lays out every symbol in the layer. During a pinch
   * that is a re-layout per frame, on top of a setData per frame rebuilding
   * geometry that does not depend on the zoom at all — the churn the vehicles
   * flickered under. As an expression the style scales them itself.
   *
   * Only the latitude has to be fed in, and only when the train has moved far
   * enough north or south to matter.
   */
  private sizeIcons(lat: number): void {
    if (!this.map) return;
    // A quarter of a degree is about 28 km, over which the cosine moves by
    // well under half a percent — far less than a pixel on a vehicle.
    if (this.iconLat !== null && Math.abs(lat - this.iconLat) < 0.25) return;
    this.iconLat = lat;
    const at = (zoom: number): number => iconScale(metresPerPixel(zoom, lat));
    this.map.setLayoutProperty('train-cars', 'icon-size', [
      'interpolate',
      ['exponential', 2],
      ['zoom'],
      PLAN_ZOOM,
      at(PLAN_ZOOM),
      MAX_PLAN_ZOOM,
      at(MAX_PLAN_ZOOM),
    ]);
  }

  /**
   * Put the train where it belongs, once.
   *
   * This is the work one frame of the animation loop does: find the rails
   * under the drawn position, move the marker onto them, hold the view on it,
   * and lay the vehicles out along them.
   *
   * A stopped train runs no loop — there is nothing to advance — so it used to
   * get whatever the first draw produced and nothing ever came back. That draw
   * happens before the tiles the snapping reads have loaded and before the
   * framing zoom has taken effect, so both fail quietly: no track is found, no
   * line is chosen, and the vehicles stay on the route line. At a station the
   * route line is the stub joining the platform to the nearest point of the
   * network, which is why the carriages sat beside the rails rather than on
   * them — and why the train sat off centre, the view having been framed on
   * the server's position before the marker was snapped away from it.
   *
   * Calling this again when the map goes idle is what fixes both: idle is the
   * moment the tiles are in and the camera has stopped, which is exactly what
   * the first attempt lacked.
   */
  private settle(t: TrainDTO): void {
    if (!this.map || !this.marker || !this.track || this.drawnKm === null) return;
    const here = this.track.at(this.drawnKm);
    if (!here) return;
    const at = this.onSurveyedTrack(here.lon, here.lat, here.bearing, t.position.limitKmh);
    this.marker.setLngLat(at);
    this.centreOnTrain(at);
    this.drawBody(t, this.drawnKm);
    // The train has just been snapped, so snappedTo now names the track it is
    // on — which is what seeds the route through a station onto the same one.
    this.matchRoute();
  }

  /**
   * Pan after the train when it is about to leave the view.
   *
   * Never while the map is already moving, which is how a gesture keeps hold
   * of it.
   */
  private centreOnTrain(at: [number, number]): void {
    if (!this.following || !this.map) return;
    // Not re-entrantly: see `centring`.
    if (this.centring) return;
    // Not while the reader is moving the map themselves: taking it back from
    // under a finger is the one thing a following map must not do. Their own
    // gesture ends, and the next frame picks the train up again.
    if (this.map.isMoving()) return;

    // Nothing at all when it is already there. Every setCenter fires a round
    // of move events whether the map needed to move or not, and at sixty
    // frames a second that is a great deal of event traffic for a train that
    // has not gone anywhere — a stopped one, most of all.
    const now = this.map.getCenter();
    if (Math.abs(now.lng - at[0]) < 1e-7 && Math.abs(now.lat - at[1]) < 1e-7) return;

    this.centring = true;
    try {
      this.map.setCenter(at);
    } finally {
      this.centring = false;
    }
  }

  /**
   * The drawn track near the train, gathered from the tiles already loaded.
   *
   * Querying the source walks every feature in view, so it is done a few times
   * a minute rather than a few times a second — the surveyed track does not
   * move, and the train covers little ground between refreshes.
   */
  private nearbyTrack(lon: number, lat: number): Line[] {
    const now = performance.now();
    const moved =
      this.railSegsNear === null ||
      Math.abs(lon - this.railSegsNear[0]) > 0.004 ||
      Math.abs(lat - this.railSegsNear[1]) > 0.003;
    if (!moved && now - this.railSegsAt < 4000) return this.railSegs;
    this.railSegsAt = now;
    this.railSegsNear = [lon, lat];

    // A box about 700 m around the train: wide enough to hold any track it
    // could plausibly be on, small enough that what is left is a handful of
    // segments rather than the whole screen.
    const dLat = 0.0063;
    const dLon = dLat / Math.max(0.3, Math.cos((lat * Math.PI) / 180));

    const lines: Line[] = [];
    const inBox = (p: Point): boolean =>
      Math.abs(p[0] - lon) < dLon && Math.abs(p[1] - lat) < dLat;

    /**
     * Keep the run of the line that passes near the train, with a point either
     * side so the segments crossing the edge of the box are not lost.
     *
     * Kept as a line rather than loose segments because it needs an identity:
     * the train stays on the track it is already on, and that is only
     * meaningful if one frame's track can be recognised in the next.
     */
    const take = (key: string, pts: readonly Point[]): void => {
      let from = -1;
      let to = -1;
      for (let i = 0; i < pts.length; i++) {
        if (!inBox(pts[i]!)) continue;
        if (from === -1) from = i;
        to = i;
      }
      if (from === -1) return;
      const run = pts.slice(Math.max(0, from - 1), Math.min(pts.length, to + 2));
      if (run.length > 1) lines.push({ key, points: run });
    };

    try {
      const feats = this.map?.querySourceFeatures('osmrail', { sourceLayer: 'tracks' }) ?? [];
      for (const f of feats) {
        const g = f.geometry;
        // The same way is served once per tile, so the id ties the pieces of
        // one track together across tile boundaries. Where there is none, the
        // track number and a rounded coordinate stand in.
        const ref = String(f.properties?.['railway:track_ref'] ?? '');
        if (g.type === 'LineString') {
          const pts = g.coordinates as Point[];
          take(String(f.id ?? `${ref}@${pts[0]?.[0].toFixed(4)},${pts[0]?.[1].toFixed(4)}`), pts);
        } else if (g.type === 'MultiLineString') {
          for (const [n, l] of (g.coordinates as Point[][]).entries()) {
            take(String(f.id ?? `${ref}@${l[0]?.[0].toFixed(4)},${l[0]?.[1].toFixed(4)}#${n}`), l);
          }
        }
      }
      this.railSegs = lines;
    } catch {
      // The layer may not be added, or the source not loaded yet. The train
      // simply stays on the line the model put it on.
      this.railSegs = [];
    }
    return this.railSegs;
  }

  /**
   * Every surveyed track in view, whole, for matching the route onto.
   *
   * Deliberately not the box that nearbyTrack builds: that one keeps only the
   * run of each line passing within 700 m of the train, which is right for
   * deciding what the train is standing on and useless for drawing a route
   * across the screen. Whole lines also mean the bounding boxes in RailMatch
   * are worth having.
   */
  private viewportRails(): Line[] {
    const now = performance.now();
    // The tiles do not change under a still map, and this is only ever called
    // from a path that already has its own reason not to run continuously.
    // Zero means never gathered, which is not the same as gathered just now:
    // on a page open less than two seconds the difference is the whole cache.
    if (this.railViewAt && now - this.railViewAt < 2000) return this.railView;
    this.railViewAt = now;

    const lines: Line[] = [];
    const take = (key: string, pts: readonly Point[]): void => {
      if (pts.length > 1) lines.push({ key, points: pts });
    };
    try {
      const feats = this.map?.querySourceFeatures('osmrail', { sourceLayer: 'tracks' }) ?? [];
      for (const f of feats) {
        const g = f.geometry;
        const ref = String(f.properties?.['railway:track_ref'] ?? '');
        if (g.type === 'LineString') {
          const pts = g.coordinates as Point[];
          take(String(f.id ?? `${ref}@${pts[0]?.[0].toFixed(4)},${pts[0]?.[1].toFixed(4)}`), pts);
        } else if (g.type === 'MultiLineString') {
          for (const [n, l] of (g.coordinates as Point[][]).entries()) {
            take(String(f.id ?? `${ref}@${l[0]?.[0].toFixed(4)},${l[0]?.[1].toFixed(4)}#${n}`), l);
          }
        }
      }
      this.railView = lines;
    } catch {
      // The source may not be loaded yet; the schematic line stands until it
      // is, and the next call will find it.
      this.railView = [];
    }
    return this.railView;
  }

  /**
   * Lay the visible part of the route onto the track the tiles show.
   *
   * Only the visible part: the tiles hold what is on screen, so that is all
   * there is to match against, and a thousand-kilometre journey would be a
   * pointless thing to walk for a view a few hundred metres across.
   *
   * Cheap to call — it does nothing unless the view has actually moved — so
   * both the animation loop and the idle handler can just call it.
   */
  private matchRoute(): void {
    if (!this.map) return;
    const src = this.map.getSource('follow-real');
    if (!src) return;
    const clear = (): void => {
      if (this.matchedKey === '') return;
      this.matchedKey = '';
      src.setData({ type: 'FeatureCollection', features: [] });
    };

    const zoom = this.map.getZoom();
    // Below this the schematic line is fully opaque and doing the job, the
    // matched one is transparent, and a railway is one stroke wide anyway.
    if (zoom < MATCH_MIN_ZOOM || !this.track) {
      clear();
      return;
    }

    const c = this.map.getCenter();
    // Four decimal places is about eleven metres, which is under the width of
    // the line being drawn; below that there is nothing to see for the work.
    const key = `${this.pathFor}@${c.lng.toFixed(4)},${c.lat.toFixed(4)}/${zoom.toFixed(1)}`;
    const now = performance.now();
    if (key === this.matchedKey || now - this.matchedAt < MATCH_MS) return;
    this.matchedKey = key;
    this.matchedAt = now;

    // How much route could be on screen: half the diagonal of the viewport,
    // and a third again so the drawn line reaches past the edge rather than
    // stopping short of it.
    const el = this.map.getContainer();
    const mPerPx = metresPerPixel(zoom, c.lat);
    const spanKm = (0.5 * Math.hypot(el.clientWidth, el.clientHeight) * mPerPx * 1.3) / 1000;
    const mid = this.track.distanceAt(c.lat, c.lng);
    const to = Math.min(this.track.length, mid + spanKm);

    // A fixed step rather than one scaled to the zoom: at z14, the lowest this
    // runs at, a pixel is about three and a half metres, so any sensible
    // multiple of it is finer than the fixed step anyway. The count is bounded
    // by the viewport regardless — a few hundred samples at the widest.
    const samples: Sample[] = [];
    for (let km = Math.max(0, mid - spanKm); km <= to; km += SAMPLE_M / 1000) {
      const at = this.track.at(km);
      if (at) samples.push({ lon: at.lon, lat: at.lat, bearing: at.bearing });
    }

    const runs = matchToRails(samples, this.viewportRails(), {
      // The same rule the train is placed by, so the route comes out on the
      // track the train is drawn on rather than the one beside it. The line
      // speed is left out because it varies along a journey and is only used
      // to spot a high-speed line, which changes the answer nowhere except
      // inside Alsace-Moselle.
      keepLeft: (lon, lat) => keepsLeft(lon, lat),
      // And through a station, start from the platform road the train itself
      // was put on rather than whichever of six is nearest the first sample.
      seed: this.snappedTo,
    });

    src.setData({
      type: 'FeatureCollection',
      features: runs.map((coordinates) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates },
      })),
    });
  }

  /**
   * Move a drawn position sideways onto the track under it, if there is one.
   *
   * Declines rather than guesses: no nearby track, or none pointing the same
   * way, and the model's own answer stands.
   */
  private onSurveyedTrack(
    lon: number,
    lat: number,
    bearing: number | null,
    limitKmh?: number | null,
  ): [number, number] {
    const zoom = this.map?.getZoom() ?? 0;
    // Only where the rails are actually drawn thickly enough for the train to
    // be visibly beside them. Below that the correction is under a pixel and
    // not worth walking the tile features for — which matters on a phone,
    // where that walk is the most expensive thing this view does.
    if (zoom < 14) {
      this.chosenLine = null;
      return [lon, lat];
    }

    // One choice for the whole train, biased towards the track it is already
    // on. Made here, at the front of the train, and then reused for every
    // vehicle behind it — see drawBody.
    // Which side of the line trains keep to here — left in France, right in
    // Alsace-Moselle, and left again on the LGVs that cross it.
    const hit = snapToTrack(
      lon,
      lat,
      bearing,
      this.nearbyTrack(lon, lat),
      MAX_SNAP_M,
      this.snappedTo,
      keepsLeft(lon, lat, limitKmh),
    );
    if (!hit) {
      this.chosenLine = null;
      this.snappedTo = null;
      return [lon, lat];
    }
    this.snappedTo = hit.key;
    this.chosenLine = this.railSegs.find((l) => l.key === hit.key) ?? null;
    return [hit.lon, hit.lat];
  }

  private stopAnimation(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.animating = false;
  }

  /**
   * Current speed, and what the line permits here.
   *
   * The limit is a property of the track rather than of the train, so it is
   * drawn as the roundel it is on the ground rather than as more text — and
   * hidden entirely where the geometry cannot say, rather than guessed at.
   */
  private showSpeed(kmh: number, limitKmh: number | null | undefined): void {
    const speed = document.getElementById('mapSpeed');
    if (speed) {
      speed.textContent = kmh ? tr('map.speed', { kmh: String(Math.round(kmh)) }) : tr('map.stopped');
      speed.classList.toggle('is-stopped', !kmh);
    }

    const limit = document.getElementById('mapLimit');
    if (!limit) return;
    if (limitKmh == null || limitKmh <= 0) {
      limit.hidden = true;
      return;
    }
    limit.hidden = false;
    limit.textContent = String(Math.round(limitKmh));
    limit.title = tr('map.limit', { kmh: String(Math.round(limitKmh)) });
    // Marked when the train is at or near what the line allows, which is the
    // interesting case: it is going as fast as it is permitted to.
    limit.classList.toggle('at-limit', kmh >= limitKmh * 0.95);
  }

  private drawMarker(t: TrainDTO): void {
    if (!this.map) return;
    const p = t.position;
    const tier = Format.delayTier(t.delay, t.cancelled);

    // Put it on the line, not merely near it.
    //
    // The server's position comes from its own routing of the current leg,
    // while the map draws the whole journey as one line built from those legs
    // and then simplified. The two agree to within a hundred metres or so,
    // which is invisible at low zoom and glaring once you zoom in on the
    // train: it sits beside its own track. Projecting onto the drawn line
    // costs nothing and makes the two agree exactly.
    const onLine = this.track ? this.track.at(this.track.distanceAt(p.lat, p.lon)) : null;
    // And then sideways onto the rails that are drawn there, where the two
    // surveys disagree — see core/TrackSnap.
    const [lon, lat] = this.onSurveyedTrack(
      onLine?.lon ?? p.lon,
      onLine?.lat ?? p.lat,
      onLine?.bearing ?? p.bearing ?? null,
      p.limitKmh,
    );

    if (!this.marker) {
      // The same marker as the journey graph — a ringed disc holding the train
      // — so the train reads as one thing across both views.
      //
      // The disc stays upright while a separate pointer carries the bearing.
      // Rotating the whole marker, as the old arrow did, would tilt the glyph
      // and make it unreadable on any heading but north.
      const el = document.createElement('div');
      el.className = 'train-marker';
      el.innerHTML = '<i class="tm-dir"></i>';
      // A fresh element holds none of what shapeMarker last drew.
      this.markerForm = null;
      this.marker = new maplibregl.Marker({
        element: el,
        // Explicit: the disc must sit on the coordinate, centred on the track.
        anchor: 'center',
        rotationAlignment: 'viewport',
      })
        .setLngLat([lon, lat])
        .addTo(this.map);
    } else {
      this.marker.setLngLat([lon, lat]);
    }

    this.drawn = t;
    const el = this.marker.getElement();
    this.shapeMarker(el, t);
    this.drawBody(t, this.track ? this.track.distanceAt(lat, lon) : null);
    el.classList.toggle('is-stopped', !p.speedKmh);
    el.classList.toggle('is-coarse', p.geometry !== 'rail');
    el.classList.toggle('is-um', t.coupledWith.length > 0);
    const tierColor = Theme.token(
      tier === 'cancelled' ? 'dead' : tier === 'verylate' ? 'verylate' : tier === 'late' ? 'late' : 'ok',
    );
    el.style.color = tierColor;


    // Only the pointer turns. A stopped train has no meaningful heading, so it
    // is hidden rather than left pointing at wherever it last went.
    const dir = el.querySelector<HTMLElement>('.tm-dir');
    if (dir) {
      const bearing = onLine?.bearing ?? p.bearing ?? null;
      dir.style.opacity = bearing === null || !p.speedKmh ? '0' : '1';
      // Rotate about the disc centre first, then push outward, so the wedge
      // orbits the train instead of pivoting where it sits.
      if (bearing !== null) {
        dir.style.transform = `rotate(${bearing}deg) translateY(calc(-1 * var(--tm-orbit)))`;
      }
    }
  }

  dispose(): void {
    this.stopAnimation();
    this.marker?.remove();
    this.marker = null;
    this.pathFor = null;
    this.track = null;
    this.drawn = null;
    this.drawnKm = null;
    this.following = false;
    this.markerForm = null;
    // The body lives in a source, not on the marker, so removing the marker
    // does not take it with it — a stale train would sit there until the next
    // one was drawn.
    this.map?.getSource('train-body')?.setData(EMPTY_BODY);
    this.reckoner.reset();
  }
}
