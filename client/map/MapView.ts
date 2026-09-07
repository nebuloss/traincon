/**
 * The map, showing one train on real track.
 *
 * Built lazily and resized whenever its panel appears — MapLibre measures zero
 * if created in a hidden container. Zoom follows speed, because positional
 * uncertainty scales with it: the estimate comes from a timetable, so a
 * one-minute error is 1.7 km at 100 km/h but 5 km at 300.
 *
 * What it draws sits beside it: the sources and layers in layers.ts, the
 * surveyed track it snaps onto in surveyed.ts, the speed and aspect written
 * over it in readout.ts. What is left here is the part that has to remember
 * something between frames — where the train was last drawn, which track it
 * was put on, and the loop that advances it.
 */

import { Format } from '../app/Format.ts';
import { Reckoner } from '../rail/Reckoner.ts';
import { Track } from '../rail/Track.ts';
import { PLAN_ZOOM, discView, liveryOf, metresPerPixel, trainLengthM, unitsOf } from '../train/train-icon.ts';
import { trainCars } from '../train/train-body.ts';
import { zoomForSpeed } from './framing.ts';
import { MAX_SNAP_M, snapReach, snapToLine, snapToTrack } from '../rail/track-snap.ts';
import type { Line } from '../rail/track-snap.ts';
import { keepsLeft } from '../rail/running-side.ts';
import { SAMPLE_M, matchToRails } from '../rail/rail-match.ts';
import type { Sample } from '../rail/rail-match.ts';
import { ensureLivery } from '../train/train-art.ts';
import { plausibleSpeed } from '../train/stock.ts';
import { distanceFraction } from '../rail/motion.ts';
import { Theme } from '../app/Theme.ts';
import type { Api } from '../app/Api.ts';
import type { JourneyGeo, JourneyLine, TrainDTO } from '../types.ts';
import { gl } from './maplibre.ts';
import type { MapLike, MarkerLike } from './maplibre.ts';
import {
  EMPTY_BODY,
  addFollowLayers,
  addRailLayers,
  addStationTracks,
  addTrainBody,
  iconSizeExpression,
} from './layers.ts';
import { SurveyedTrack } from './surveyed.ts';
import { showAspect, showSpeed } from './readout.ts';

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
  /** The drawn track under the view, cached and cut to size — see surveyed.ts. */
  private readonly surveyed = new SurveyedTrack();
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
  /** Motion profile per leg, from the server — see rail/motion.ts. */
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
   * decides, is in map/framing.
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
    this.map = new gl.Map({
      container: this.containerId,
      style: this.themeManager.mapStyle,
      center: [2.4, 46.6],
      zoom: 4.7,
      attributionControl: true,
    });
    this.theme = this.themeManager.isDark ? 'dark' : 'light';
    this.map.addControl(new gl.NavigationControl(), 'top-right');
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
    this.buildLayers();
    requestAnimationFrame(() => this.map?.resize());
  }

  /**
   * The layers that exist before any train does.
   *
   * Both callers need all three and in this order — the network under the
   * station track layout, and the train's body over both — so they ask for
   * the set rather than for the three separately. The route layers are not
   * here: they need a route, so they go on at the first train shown, and are
   * inserted beneath the layer this creates.
   */
  private buildLayers(): void {
    if (!this.map) return;
    addRailLayers(this.map);
    addStationTracks(this.map);
    addTrainBody(this.map);
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
      this.buildLayers();
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
      addFollowLayers(this.map, this.geo);
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

    showSpeed(kmh, p.limitKmh);
    showAspect(t);
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
            // How far it may be moved depends on the chord it is drawn on: a
            // long one across a curve puts it well outside the plain limit.
            const at = this.onSurveyedTrack(
              here.lon, here.lat, here.bearing, p.limitKmh,
              snapReach(this.track.chordAt(drawKm)),
            );
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
   * Hand the layer a new icon-size expression, but only when it would differ.
   *
   * The expression itself is in layers.ts; what is here is the decision not to
   * set it. Setting a layout property re-lays out every symbol in the layer,
   * so doing it on every draw is the churn the vehicles used to flicker under.
   */
  private sizeIcons(lat: number): void {
    if (!this.map) return;
    // A quarter of a degree is about 28 km, over which the cosine moves by
    // well under half a percent — far less than a pixel on a vehicle.
    if (this.iconLat !== null && Math.abs(lat - this.iconLat) < 0.25) return;
    this.iconLat = lat;
    this.map.setLayoutProperty('train-cars', 'icon-size', iconSizeExpression(lat));
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
    const at = this.onSurveyedTrack(
      here.lon, here.lat, here.bearing, t.position.limitKmh,
      snapReach(this.track.chordAt(this.drawnKm)),
    );
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
      if (at) {
        samples.push({
          lon: at.lon, lat: at.lat, bearing: at.bearing,
          reach: snapReach(this.track.chordAt(km)),
        });
      }
    }

    const runs = matchToRails(samples, this.surveyed.inView(this.map), {
      // The same rule the train is placed by, and given the same line speed,
      // so the route comes out on the track the train is drawn on rather than
      // the one beside it.
      //
      // The speed is not optional here, though it looks it. It is what says
      // whether this is a high-speed line, which is left-hand running whatever
      // the region — and the LGV Est runs through Moselle and Bas-Rhin at
      // 320 km/h. Left out, the whole Baudrecourt to Strasbourg section put
      // the route on the right-hand track and the train on the left.
      keepLeft: (lon, lat) => keepsLeft(lon, lat, this.drawn?.position.limitKmh),
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
    reachM: number = MAX_SNAP_M,
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
      this.surveyed.near(this.map, lon, lat),
      reachM,
      this.snappedTo,
      keepsLeft(lon, lat, limitKmh),
    );
    if (!hit) {
      this.chosenLine = null;
      this.snappedTo = null;
      return [lon, lat];
    }
    this.snappedTo = hit.key;
    this.chosenLine = this.surveyed.segments.find((l) => l.key === hit.key) ?? null;
    return [hit.lon, hit.lat];
  }

  private stopAnimation(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.animating = false;
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
    // surveys disagree — see rail/track-snap.
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
      this.marker = new gl.Marker({
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
