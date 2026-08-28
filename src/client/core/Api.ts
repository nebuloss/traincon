/**
 * Typed client for the server API, with the offline cache layered in.
 *
 * Every response type comes from src/shared/types.ts, so a change to what the
 * server emits fails to compile here rather than showing up as `undefined` in
 * the interface.
 */

import { Cache } from './Cache.ts';
import { tr } from './I18n.ts';
import type {
  JourneyGeo,
  StationDTO,
  StatsDTO,
  SuggestionDTO,
  TrainDTO,
  TrainLightDTO,
  TrainResponse,
  WorstBoardDTO,
} from '../../shared/types.ts';

export interface Family {
  family?: string;
}

export class Api {
  constructor(readonly cache = new Cache()) {}

  /**
   * Fetch, caching every good response and falling back to the cached copy
   * when the network or the server fails.
   */
  private async get<T>(path: string, { allowCache = true } = {}): Promise<T> {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as T;
      if (allowCache && r.ok) {
        this.cache.set(path, data);
        this.cache.clearServed(path);
      }
      return data;
    } catch (e) {
      if (allowCache) {
        const hit = this.cache.get<T>(path);
        if (hit) {
          this.cache.markServed(path, hit.at);
          return hit.data;
        }
      }
      throw e;
    }
  }

  /** Feed health. Never cached: a stale "all is well" defeats the banner. */
  stats(): Promise<StatsDTO> {
    return this.get<StatsDTO>('/api/stats', { allowCache: false });
  }

  refresh(): Promise<StatsDTO & { retried: boolean }> {
    return this.get<StatsDTO & { retried: boolean }>('/api/refresh', { allowCache: false });
  }

  train(number: string): Promise<TrainResponse> {
    return this.get<TrainResponse>(`/api/train/${encodeURIComponent(number)}`);
  }

  journey(number: string): Promise<JourneyGeo> {
    return this.get<JourneyGeo>(`/api/train/${encodeURIComponent(number)}/path`);
  }

  async suggest(q: string, family?: string, limit = 25): Promise<{ rows: SuggestionDTO[]; path: string }> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (family && family !== 'all') params.set('family', family);
    const path = `/api/suggest?${params}`;
    const rows = await this.get<SuggestionDTO[]>(path);
    if (!Array.isArray(rows)) throw new Error(tr('error.badResponse'));
    return { rows, path };
  }

  worst(limit = 25): Promise<WorstBoardDTO> {
    return this.get<WorstBoardDTO>(`/api/worst?limit=${limit}`);
  }

  stations(q: string, limit = 12): Promise<StationDTO[]> {
    return this.get<StationDTO[]>(`/api/stations?q=${encodeURIComponent(q)}&limit=${limit}`);
  }

  trainsLight(family?: string, running = false): Promise<{ feedTs: number; trains: TrainLightDTO[] }> {
    const params = new URLSearchParams({ light: '1' });
    if (running) params.set('running', '1');
    if (family && family !== 'all') params.set('family', family);
    return this.get<{ feedTs: number; trains: TrainLightDTO[] }>(`/api/trains?${params}`);
  }

  trains(family?: string): Promise<{ feedTs: number; trains: TrainDTO[] }> {
    const params = new URLSearchParams();
    if (family && family !== 'all') params.set('family', family);
    return this.get<{ feedTs: number; trains: TrainDTO[] }>(`/api/trains?${params}`);
  }
}
