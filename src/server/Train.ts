/**
 * A train, and everything derivable from its calls.
 *
 * The class owns the reasoning that used to be loose functions: which leg it is
 * on, how late it still is, how recently SNCF actually saw it, and where to
 * draw it. Positions are always derived — SNCF publishes no GPS — so every one
 * carries a quality note saying so.
 */

import { bearing, greatCircle, haversine, type LatLon } from './geo.ts';
import { RailGraph, type RailPath } from './RailGraph.ts';
import { serviceMeta } from './GtfsStatic.ts';
import type { RawTrain } from './FeedClient.ts';
import type {
  Call,
  Confidence,
  Family,
  Observation,
  Position,
  PositionBasis,
} from '../shared/types.ts';

/** Which leg the train is on, before any geometry is applied. */
export interface Leg {
  basis: PositionBasis;
  a: Call;
  b: Call;
  /** Fraction along the leg, 0..1. */
  f: number;
  /** Index of `a` within calls. */
  i: number;
  /** Leg duration in seconds, when running. */
  span?: number;
}

export class Train {
  readonly id: string;
  readonly number: string;
  readonly service: string | null;
  readonly line: string;
  readonly calls: Call[];
  readonly cancelled: boolean;
  readonly feedTs: number;

  constructor(raw: RawTrain) {
    this.id = raw.id;
    this.number = raw.number;
    this.service = raw.service;
    this.line = raw.line;
    this.calls = raw.calls;
    this.cancelled = raw.cancelled;
    this.feedTs = raw.feedTs;
  }

  get origin(): string {
    return this.calls[0]!.name;
  }
  get destination(): string {
    return this.calls[this.calls.length - 1]!.name;
  }
  get terminus(): Call {
    return this.calls[this.calls.length - 1]!;
  }
  get serviceLabel(): string {
    return serviceMeta(this.service).label;
  }
  get family(): Family {
    return serviceMeta(this.service).family;
  }
  /** Worst delay anywhere on the run, including stops already passed. */
  get worstDelay(): number {
    return Math.max(...this.calls.map((c) => c.delay));
  }

  /** A copy with some calls replaced — used when a coupled twin is fresher. */
  withCalls(calls: Call[]): Train {
    const clone = Object.create(Train.prototype) as Train;
    Object.assign(clone, this, { calls });
    return clone;
  }

  /** The next call the train has yet to make. */
  nextCall(now = Math.floor(Date.now() / 1000)): Call | null {
    return this.calls.find((c) => c.time > now) ?? null;
  }

  /**
   * The delay that actually matters: the one still ahead of you.
   *
   * `worstDelay` is the worst figure anywhere on the journey, including stops
   * already behind the train — so a service that lost 70 min early on and has
   * since clawed back 20 still reads "+70". That is what made this app show
   * +70 for 8582 while SNCF Connect showed +50: by Bordeaux the train really
   * was only 50 late.
   */
  currentDelay(now = Math.floor(Date.now() / 1000)): number {
    return (this.nextCall(now) ?? this.terminus).delay;
  }

  /**
   * Which leg of the journey the train is on.
   * Pure timetable logic, no geometry. Every time used here is SNCF's own
   * live forecast.
   */
  legAt(now = Math.floor(Date.now() / 1000)): Leg {
    const calls = this.calls;
    const first = calls[0]!;
    const last = calls[calls.length - 1]!;

    if (now < first.time) {
      return { basis: 'not_departed', a: first, b: calls[1] ?? first, f: 0, i: 0 };
    }
    if (now >= last.time) {
      return {
        basis: 'arrived',
        a: calls[calls.length - 2] ?? last,
        b: last,
        f: 1,
        i: calls.length - 2,
      };
    }

    for (let i = 0; i < calls.length - 1; i++) {
      const a = calls[i]!;
      const b = calls[i + 1]!;
      const depA = a.departure ?? a.time;
      // Dwelling: arrival passed but departure still ahead. Checked before the
      // between-stations case so a train at a platform is placed on it.
      if (a.arrival && now >= a.arrival && now < depA) {
        return { basis: 'at_station', a, b, f: 0, i };
      }
      const arrB = b.arrival ?? b.time;
      if (now >= depA && now < arrB) {
        const span = arrB - depA;
        return { basis: 'between', a, b, f: span > 0 ? (now - depA) / span : 0, i, span };
      }
    }
    return { basis: 'unknown', a: last, b: last, f: 1, i: calls.length - 2 };
  }

  /**
   * How much ground truth is behind the current estimate.
   *
   * GTFS-RT only revises a train when it is observed, which in practice means
   * when it calls at a stop. On a leg with no intermediate stop the published
   * delay is simply carried forward — so a train that recovers or loses time
   * mid-leg is invisible until it arrives.
   */
  observation(now = Math.floor(Date.now() / 1000)): Observation {
    const passed = this.calls.filter((c) => c.time <= now);
    const last = passed[passed.length - 1];
    const next = this.calls.find((c) => c.time > now);
    if (!last) return { lastStop: null, ageSec: null, legSec: null, confidence: 'scheduled' };

    const ageSec = now - last.time;
    const legSec = next ? next.time - last.time : null;
    // Long unobserved legs are where the published time drifts furthest from
    // reality; short hops re-anchor every few minutes.
    let confidence: Confidence;
    if (ageSec < 120) confidence = 'confirmed';
    else if (ageSec < 20 * 60) confidence = 'good';
    else if (ageSec < 45 * 60) confidence = 'estimated';
    else confidence = 'stale';

    return { lastStop: last.name, lastStopTime: last.time, ageSec, legSec, confidence };
  }

  /**
   * Where the train is.
   *
   * With a RailGraph the point is projected onto real track and the bearing
   * follows the actual curve; without one it falls back to a great circle.
   * `quality` says plainly what the number is worth — never claim more.
   */
  positionAt(now = Math.floor(Date.now() / 1000), graph: RailGraph | null = null): Position {
    const leg = this.legAt(now);
    const { a, b, f, basis } = leg;
    const obs = this.observation(now);
    const progress = (leg.i + (basis === 'between' ? f : 0)) / Math.max(1, this.calls.length - 1);

    const base = {
      basis,
      progress,
      fromStop: basis === 'between' ? a.name : undefined,
      atStation: basis === 'between' ? undefined : basis === 'arrived' ? b.name : a.name,
      nextStop: basis === 'arrived' ? null : b.name,
      legProgress: basis === 'between' ? f : undefined,
      observation: obs,
    };

    const railPath: RailPath | null = graph ? graph.path(a.lat, a.lon, b.lat, b.lon) : null;
    if (railPath) {
      const pt = RailGraph.at(railPath, basis === 'arrived' ? 1 : f);
      const legHours = (leg.span ?? 0) / 3600;

      // The line-speed profile gives the *shape* of the run; the timetable
      // gives its duration. Scaling one onto the other turns a nominal line
      // speed into the speed this train is actually managing.
      let speedKmh = 0;
      if (basis === 'between' && legHours > 0) {
        const nominal = pt.nominalHours;
        speedKmh =
          nominal && nominal > 0 && pt.lineKmh != null
            ? Math.round(pt.lineKmh * (nominal / legHours))
            : Math.round(railPath.total / legHours);
      }

      return {
        ...base,
        lat: pt.lat,
        lon: pt.lon,
        bearing: pt.bearing,
        legKm: Math.round(railPath.total * 10) / 10,
        distKm: Math.round(pt.distKm * 10) / 10,
        speedKmh,
        avgKmh: legHours > 0 ? Math.round(railPath.total / legHours) : 0,
        lineKmh: pt.lineKmh,
        geometry: 'rail',
        quality: {
          method: 'rail_graph_speed_profile',
          confidence: obs.confidence,
          note: 'projected onto the track using the line speed profile; SNCF real-time schedule, position not measured',
        },
      };
    }

    const pt: LatLon =
      basis === 'arrived'
        ? { lat: b.lat, lon: b.lon }
        : basis === 'between'
          ? greatCircle(a, b, f)
          : { lat: a.lat, lon: a.lon };
    const legKm = haversine(a, b);
    const span = leg.span ?? 0;

    return {
      ...base,
      lat: pt.lat,
      lon: pt.lon,
      bearing: bearing(a, b),
      legKm: Math.round(legKm),
      speedKmh: basis === 'between' && span > 0 ? Math.round((legKm / span) * 3600) : 0,
      geometry: 'direct',
      quality: {
        method: 'great_circle',
        confidence: obs.confidence,
        note: 'no track geometry for this section; straight line between stations',
      },
    };
  }
}
