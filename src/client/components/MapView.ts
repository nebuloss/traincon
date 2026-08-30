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
import { distanceFraction } from '../../shared/motion.ts';
import { Theme } from '../core/Theme.ts';
import type { Api } from '../core/Api.ts';
import type { JourneyGeo, JourneyLine, TrainDTO } from '../../shared/types.ts';

/** MapLibre is loaded from a script tag; this is the surface we rely on. */
interface MapLike {
  on(ev: string, fn: () => void): void;
  once(ev: string, fn: () => void): void;
  addControl(c: unknown, pos?: string): void;
  addSource(id: string, src: unknown): void;
  addLayer(layer: unknown): void;
  getSource(id: string): { setData(d: unknown): void } | undefined;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  removeSource(id: string): void;
  setStyle(url: string): void;
  easeTo(o: unknown): void;
  fitBounds(b: unknown, o: unknown): void;
  getZoom(): number;
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

export class MapView {
  private map: MapLike | null = null;
  private marker: MarkerLike | null = null;
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
    await new Promise<void>((r) => this.map!.on('load', () => r()));
    this.addRailLayers();
    requestAnimationFrame(() => this.map?.resize());
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
      center: [t.position.lon, t.position.lat],
      zoom: want,
      duration: initial ? 0 : 700,
    });
  }

  /** Redraw for a train; `reframe` forces the framing rule to reapply. */
  async show(t: TrainDTO, mode: MapMode, follow: boolean, reframe: boolean): Promise<void> {
    if (!this.map) return;
    const p = t.position;

    if (this.pathFor !== t.number) {
      this.geo = await this.api.journey(t.number);
      const src = this.map.getSource('follow');
      if (src) src.setData(this.geo);
      else {
        this.map.addSource('follow', { type: 'geojson', data: this.geo });
        this.map.addLayer({
          id: 'follow-path',
          type: 'line',
          source: 'follow',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': Theme.token('accent'), 'line-width': 3.5, 'line-opacity': 0.9 },
        });
        this.map.addLayer({
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
        });
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
      this.map.easeTo({ center: [p.lon, p.lat], zoom: auto ? want : cur, duration: 900 });
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
    if (!this.track || !kmh || p.geometry !== 'rail' || reduced || this.stopKm.length < 2) {
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
          const here = this.track.at(this.reckoner.follow(km, kmh, sinceLast));
          if (here) {
            this.marker.setLngLat([here.lon, here.lat]);
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

    if (!this.marker) {
      // The same marker as the journey graph — a ringed disc holding the train
      // — so the train reads as one thing across both views.
      //
      // The disc stays upright while a separate pointer carries the bearing.
      // Rotating the whole marker, as the old arrow did, would tilt the glyph
      // and make it unreadable on any heading but north.
      const el = document.createElement('div');
      el.className = 'train-marker';
      el.innerHTML = '<i class="tm-dir"></i><span class="tm-body">🚆</span>';
      this.marker = new maplibregl.Marker({
        element: el,
        // Explicit: the disc must sit on the coordinate, centred on the track.
        anchor: 'center',
        rotationAlignment: 'viewport',
      })
        .setLngLat([p.lon, p.lat])
        .addTo(this.map);
    } else {
      this.marker.setLngLat([p.lon, p.lat]);
    }

    const el = this.marker.getElement();
    el.classList.toggle('is-stopped', !p.speedKmh);
    el.classList.toggle('is-coarse', p.geometry !== 'rail');
    el.classList.toggle('is-um', t.coupledWith.length > 0);
    el.style.color = Theme.token(
      tier === 'cancelled' ? 'dead' : tier === 'verylate' ? 'verylate' : tier === 'late' ? 'late' : 'ok',
    );

    // Only the pointer turns. A stopped train has no meaningful heading, so it
    // is hidden rather than left pointing at wherever it last went.
    const dir = el.querySelector<HTMLElement>('.tm-dir');
    if (dir) {
      const bearing = p.bearing ?? null;
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
    this.reckoner.reset();
  }
}
