/**
 * The contract between server and client.
 *
 * Everything the API emits is described here once, so a rename cannot silently
 * diverge between the two halves. Times are epoch seconds throughout — never
 * Date objects, which do not survive JSON.
 */

/** Commercial family, used for filtering and colour. */
export type Family = 'tgv' | 'ic' | 'ter' | 'other';

/** Where a train is, and how that was arrived at. */
export type PositionBasis =
  | 'not_departed'
  | 'at_station'
  | 'between'
  | 'arrived'
  | 'unknown';

/** How much ground truth backs the current estimate. */
export type Confidence = 'confirmed' | 'good' | 'estimated' | 'stale' | 'scheduled';

export type Trend = 'worsening' | 'recovering' | 'stable';

/** One scheduled call, with SNCF's live forecast applied. */
export interface Call {
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  /** Epoch seconds; null when the feed omits that side of the call. */
  arrival: number | null;
  departure: number | null;
  /** Whichever of the two the feed provides — the sortable instant. */
  time: number;
  /** Seconds behind schedule; negative means early. */
  delay: number;
  skipped: boolean;
}

/**
 * How recently SNCF actually observed the train.
 *
 * GTFS-RT only revises a train when it calls somewhere, so on a long leg the
 * published delay is simply carried forward. This is what lets the interface
 * say so rather than presenting every figure with equal confidence.
 */
export interface Observation {
  lastStop: string | null;
  lastStopTime?: number;
  /** Seconds since that call; null when nothing has been passed yet. */
  ageSec: number | null;
  /** Length of the leg in progress, seconds. */
  legSec: number | null;
  confidence: Confidence;
}

export interface PositionQuality {
  method: 'rail_graph_speed_profile' | 'great_circle';
  confidence: Confidence;
  note: string;
}

/** A derived position — never a measurement, since SNCF publishes no GPS. */
export interface Position {
  basis: PositionBasis;
  lat: number;
  lon: number;
  /** Degrees clockwise from north, tangent to the track. */
  bearing: number;
  /** Fraction of the whole journey completed, 0..1. */
  progress: number;
  /** Fraction of the current leg, 0..1; only when basis is 'between'. */
  legProgress?: number;
  fromStop?: string;
  atStation?: string;
  nextStop: string | null;
  /** Length of the current leg by track, km. */
  legKm?: number;
  /** Distance covered along that leg, km. */
  distKm?: number;
  /** Modelled speed here, scaled from the line limit onto the timetable. */
  speedKmh: number;
  /** Average over the leg, for comparison. */
  avgKmh?: number;
  /** Permitted line speed at this point. */
  /**
   * What the line permits here, km/h — a property of the track, not of this
   * train. Shown on the map beside the train's own speed.
   */
  limitKmh?: number | null;
  geometry: 'rail' | 'direct';
  observation: Observation;
  quality: PositionQuality;
}

/** One number of a coupled set disagreeing with its twin. */
export interface DelayDisagreement {
  number: string;
  delay: number;
}

/**
 * Coupled portions share a physical train but keep separate numbers, and SNCF
 * updates their records independently — so one goes stale.
 */
export interface Reconciliation {
  delay: number;
  /** The number whose record was revised most recently. */
  source: string;
  /** Spread between the numbers, seconds. */
  spread: number;
  disagreement: DelayDisagreement[] | null;
}

/** A point in the delay history, for the log. */
export interface DelaySample {
  t: number;
  delay: number;
}

/** A train as the API serves it. */
export interface TrainDTO {
  id: string;
  number: string;
  service: string | null;
  serviceLabel: string;
  family: Family;
  line: string;
  origin: string;
  destination: string;
  calls: Call[];
  cancelled: boolean;
  /** Headline figure: the delay still ahead, reconciled across a coupled set. */
  delay: number;
  /** This number's own current delay, before reconciliation. */
  ownDelay: number;
  /** Worst delay anywhere on the run, including stops already passed. */
  worstDelay: number;
  position: Position;
  next: Call | null;
  trend: Trend;
  history: DelaySample[];
  coupledWith: string[];
  reconciled: Reconciliation | null;
  /**
   * What the traffic ahead implies for this train — see server/Headway.ts.
   *
   * The aspect is deduced from how far ahead the next train is and how long
   * the blocks are on that line, not read from a signal: neither signal
   * positions nor their states are published.
   */
  traffic: {
    aspect: 'libre' | 'avertissement' | 'semaphore' | 'inconnu';
    ahead?: string;
    gapM?: number;
    pushedM?: number;
    allowedKmh?: number;
    /** Distance to the next signal that could stop it, metres. */
    signalM?: number;
    /** Which kind it is: a carré shows two reds and may not be passed. */
    signalKind?: 'carre' | 'semaphore';
    /** The other train is coming the other way on a single track. */
    opposing?: boolean;
  } | null;
  feedTs: number;
}

/** The lighter payload the map uses. */
export interface TrainLightDTO {
  number: string;
  service: string;
  family: Family;
  origin: string;
  destination: string;
  delay: number;
  cancelled: boolean;
  trend: Trend;
  lat: number;
  lon: number;
  bearing: number;
  basis: PositionBasis;
  speedKmh: number;
  geometry: 'rail' | 'direct';
  quality: PositionQuality;
  observation: Observation;
  legKm?: number;
  fromStop?: string;
  coupledWith: string[];
  next: { name: string; time: number; delay: number } | null;
}

/** One autocomplete row. */
export interface SuggestionDTO {
  number: string;
  serviceLabel: string;
  family: Family;
  origin: string;
  destination: string;
  delay: number;
  cancelled: boolean;
  basis: PositionBasis;
  coupledWith: string[];
  next: { name: string; time: number; delay: number } | null;
  /** Why this matched, for display. */
  why: string;
  score: number;
}

/** Feed health, and which of the fallback layers is in play. */
export interface StatsDTO {
  total: number;
  byFamily: Partial<Record<Family, number>>;
  delayed: number;
  cancelled: number;
  feedTs: number;
  fetchedAt: number;
  /** Null when nothing has ever been decoded. */
  ageSec: number | null;
  /** Serving the on-disk snapshot because upstream failed. */
  stale: boolean;
  /** Serving a captured fixture rather than live data. */
  replay: boolean;
  error: string | null;
  /** Process memory in MB, so a heap approaching its ceiling is visible. */
  memory?: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    /** The --max-old-space-size the installer set, when it set one. */
    limit: number | null;
    /** Sizes of everything that outlives a single refresh. */
    retained?: {
      trains: number;
      history: number;
      historySamples: number;
      lastSeen: number;
      board: number;
      disruptions: number;
      paths: number;
      pathPoints: number;
    };
  };
}

export interface TrainFound {
  found: true;
  feedTs: number;
  trains: TrainDTO[];
}

/**
 * Why a lookup came back empty.
 *
 * The distinction matters to the bookmark list: 'dormant' is a real train that
 * simply is not running inside the forecast window, and will come back on its
 * own; 'unknown' is a number that appears nowhere in the timetable, so the
 * bookmark is junk and saying "not running" about it would be a lie that hides
 * a typo until the day it matters.
 */
export type MissingReason = 'dormant' | 'unknown';

export interface TrainNotFound {
  found: false;
  number: string;
  knownSchedule: { number: string; service: string; line: string } | null;
  reason: MissingReason;
  /** English prose for API consumers; the interface translates `reason`. */
  message: string;
}

export type TrainResponse = TrainFound | TrainNotFound;

/** GeoJSON, narrow enough to be useful without pulling in a dependency. */
export interface Feature<G, P> {
  type: 'Feature';
  geometry: G;
  properties: P;
}
export interface LineStringGeom {
  type: 'LineString';
  coordinates: [number, number][];
}
export interface PolygonGeom {
  type: 'Polygon';
  coordinates: [number, number][][];
}
export interface PointGeom {
  type: 'Point';
  coordinates: [number, number];
}
export interface FeatureCollection<F> {
  type: 'FeatureCollection';
  features: F[];
}

export type JourneyLine = Feature<
  LineStringGeom,
  {
    number: string;
    legsWithGeometry: number;
    legs: number;
    /**
     * One motion profile per leg, in call order — see core/motion.ts.
     *
     * Lets the map compute positions with the same model the server uses,
     * rather than assuming constant speed between updates. Empty for a leg
     * with no routed geometry.
     */
    legProfiles?: number[][];
  }
>;
export type JourneyStop = Feature<
  PointGeom,
  { name: string; time: number; delay: number; index: number; terminus: 0 | 1 }
>;
export type JourneyGeo = FeatureCollection<JourneyLine | JourneyStop>;

export type RailGeo = FeatureCollection<Feature<LineStringGeom, { v: number; hs: 0 | 1 }>>;

/** The kinds of vehicle the drawn train is assembled from. */
export type VehicleRole = 'power' | 'artic' | 'loco' | 'coach' | 'emu-cab' | 'emu-mid';

/**
 * One placed vehicle: where it is, which way it faces, and which drawing to
 * use — see client/core/TrainBody and the artwork in client/assets/train.
 */
export type TrainCarsGeo = FeatureCollection<
  Feature<
    PointGeom,
    { icon: string; role: VehicleRole; bearing: number; lead: 0 | 1; reversed: 0 | 1 }
  >
>;

/** One line of the day's worst-delays board. */
export interface WorstTrainDTO {
  number: string;
  serviceLabel: string;
  family: Family;
  origin: string;
  destination: string;
  /** Worst delay recorded today, in seconds. */
  delay: number;
  /** When that peak was recorded, epoch seconds. */
  at: number;
  cancelled: boolean;
  /** Still in the live feed, so the modal can show it moving. */
  live: boolean;
  /**
   * Why it is or is not live: running now, already arrived, not departed yet,
   * or absent from the feed for a reason the schedule does not explain.
   */
  status: 'running' | 'finished' | 'upcoming' | 'gone';
  /** Cause as SNCF words it, when the disruption feed names one. */
  reason: string | null;
}

export interface WorstBoardDTO {
  /** The Paris day these records belong to, YYYY-MM-DD. */
  day: string;
  trains: WorstTrainDTO[];
  /** False when no API key is configured, so the UI can explain the gap. */
  reasonsAvailable: boolean;
}
