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
import { PLAN_ZOOM, discView, liveryOf, metresPerPixel, trainLengthM } from './TrainIcon.ts';
import { trainCars } from '../core/TrainBody.ts';
import { outsideMiddle } from '../core/Viewport.ts';
import { ensureLivery, iconScale } from '../core/TrainArt.ts';
import { distanceFraction } from '../../shared/motion.ts';
import { Theme } from '../core/Theme.ts';
import type { Api } from '../core/Api.ts';
import type { JourneyGeo, JourneyLine, TrainCarsGeo, TrainDTO } from '../../shared/types.ts';

/** MapLibre is loaded from a script tag; this is the surface we rely on. */
interface MapLike {
  on(ev: string, fn: () => void): void;
  once(ev: string, fn: () => void): void;
  addControl(c: unknown, pos?: string): void;
  addSource(id: string, src: unknown): void;
  addLayer(layer: unknown, before?: string): void;
  setPaintProperty(layer: string, prop: string, value: unknown): void;
  setLayoutProperty(layer: string, prop: string, value: unknown): void;
  hasImage(id: string): boolean;
  addImage(id: string, image: ImageData, options?: { pixelRatio?: number }): void;
  getSource(id: string): { setData(d: unknown): void } | undefined;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  removeSource(id: string): void;
  setStyle(url: string): void;
  easeTo(o: unknown): void;
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
  /** Motion profile per leg, from the server — see shared/motion.ts. */
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
   * Zoom chosen from speed.
   *
   * Zooming out as the train accelerates keeps the likely error inside the
   * viewport instead of implying platform-level precision at 300 km/h — and a
   * stopped train can be shown right down on its station.
   */
  static zoomForSpeed(kmh: number): number {
    if (!kmh) return 13.5;
    const z = 13 - Math.log2(Math.max(25, kmh) / 25) * 0.8;
    return Math.max(9.8, Math.min(13.5, z));
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
    // Crossing the threshold swaps the disc for the body drawn on the ground.
    // Only the shape is redone, at the position the train is currently drawn
    // at: going through drawMarker would snap it back to the last reported
    // position for a frame, which is visible as a stutter while pinching.
    this.map.on('zoom', () => {
      if (this.drawn) this.drawBody(this.drawn, this.drawnKm);
    });
    // A pinch zooms about the fingers, not about the train, so the train can
    // end up off to one side or off the screen entirely. Once the movement
    // settles, bring it back — this also covers a stopped train, which runs
    // no animation loop to notice for itself.
    this.map.on('moveend', () => {
      const at = this.drawnPoint();
      if (at) this.keepInSight(at);
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
        // Inserted under the train, not appended: these layers are created on
        // the first train shown, long after the body layers exist at startup,
        // so left to the default order the route line would be drawn over the
        // train.
        const underTrain = this.map.getLayer('train-cars') ? 'train-cars' : undefined;
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
      this.map.easeTo({
        center: this.drawnPoint() ?? [p.lon, p.lat],
        zoom: auto ? want : cur,
        duration: 900,
      });
      if (auto) this.lastAutoZoom = want;
    }

    this.drawMarker(t);
    this.startDeadReckoning(t);
  }

  /**
   * Begin advancing the marker from the position just received.
   *
   * Stopped, off-track or reduced-motion: nothing to animate, and the marker
   * stays exactly where the server put it.
   */
  private startDeadReckoning(t: TrainDTO): void {
    this.stopAnimation();

    const p = t.position;
    const kmh = p.speedKmh ?? 0;
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.showSpeed(kmh, p.limitKmh);
    this.showAspect(t);
    // Legs with no routed track are animated too, along the straight line the
    // map draws for them. That is the same interpolation the server already
    // uses for the position there, and the marker renders dashed to say so —
    // whereas a train that simply stops moving for half its journey reads as
    // broken.
    if (!this.track || !kmh || reduced || this.stopKm.length < 2) {
      this.reckoner.reset();
      return;
    }

    this.animating = true;

    // Twelve updates a second. A train at 300 km/h covers 7 m between them,
    // which is under a pixel at the zooms this view uses, so the extra frames
    // a 60 Hz loop would draw are repaints nobody can see.
    const MIN_GAP_MS = 80;
    let lastDrawn = 0;

    const step = (): void => {
      if (!this.animating || !this.track || !this.marker) return;

      // Stop when the map is not on screen. The modal keeps its panels in the
      // DOM when you switch tab, so without this the loop would run on for as
      // long as the modal stayed open.
      if (!document.getElementById('mpanel-carte')?.classList.contains('active')) {
        this.stopAnimation();
        return;
      }

      const frameAt = performance.now();
      if (frameAt - lastDrawn >= MIN_GAP_MS) {
        const sinceLast = lastDrawn === 0 ? MIN_GAP_MS : frameAt - lastDrawn;
        lastDrawn = frameAt;
        const km = this.modelledKm(t, Date.now() / 1000);
        if (km !== null) {
          // Corrections are absorbed by adjusting the drawn speed, so the
          // train never jumps and never reverses — it just runs a little fast
          // or a little slow until it agrees with the model again.
          const drawKm = this.reckoner.follow(km, kmh, sinceLast);
          const here = this.track.at(drawKm);
          this.drawBody(t, drawKm);
          if (here) {
            this.marker.setLngLat([here.lon, here.lat]);
            this.keepInSight([here.lon, here.lat]);
            const dir = this.marker.getElement().querySelector<HTMLElement>('.tm-dir');
            if (dir) {
              dir.style.transform = `rotate(${here.bearing}deg) translateY(calc(-1 * var(--tm-orbit)))`;
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
   * Emptied rather than hidden when it is not wanted: below the threshold the
   * marker is the representation, and leaving stale geometry in the source
   * would flash the old position on the next zoom in.
   */
  private drawBody(t: TrainDTO, km: number | null): void {
    const zoom = this.map?.getZoom() ?? 0;
    this.drawnKm = km;
    const wanted = this.track !== null && km !== null && zoom >= PLAN_ZOOM;

    // Swap the representations first, and outside the source guard: if the
    // train cannot be drawn the disc must stay, and if it can the disc must go.
    const el = this.marker?.getElement();
    const src = this.map?.getSource('train-body');
    if (el) el.classList.toggle('is-bodied', wanted && Boolean(src));
    if (!src || !this.map) return;

    if (!wanted) {
      src.setData(EMPTY_BODY);
      return;
    }

    // The artwork has to exist before the layer can name it. Loading is
    // asynchronous, so the first draw of a livery puts nothing on screen and
    // the next one — a moment later, from the animation loop — puts it there.
    const livery = liveryOf(t);
    if (!this.liveries.has(livery)) {
      this.liveries.add(livery);
      void ensureLivery(this.map, livery).then((ok) => {
        if (!ok) this.liveries.delete(livery);
      });
    }

    const here = this.track!.at(km!);
    const mpp = metresPerPixel(zoom, here?.lat ?? 47);
    this.map.setLayoutProperty('train-cars', 'icon-size', iconScale(mpp));
    src.setData(trainCars(this.track!, km!, trainLengthM(t), t.family, livery, 24));
  }

  /**
   * Pan after the train when it is about to leave the view.
   *
   * The rule for when is in core/Viewport. Beyond it, this never acts while
   * the map is already moving, which covers both the user's own gestures and
   * the easing this itself starts.
   */
  private keepInSight(at: [number, number]): void {
    if (!this.following || !this.map || this.map.isMoving()) return;
    const box = this.map.getContainer();
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;

    const p = this.map.project(at);
    if (!outsideMiddle(p.x, p.y, w, h)) return;
    this.map.easeTo({ center: at, duration: 600 });
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
    const lat = onLine?.lat ?? p.lat;
    const lon = onLine?.lon ?? p.lon;

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
