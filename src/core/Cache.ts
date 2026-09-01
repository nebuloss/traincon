/**
 * Browser-side response cache.
 *
 * The upstream proxy goes down regularly and the server can only cache what it
 * managed to fetch. Keeping responses here as well means a reload with no
 * connectivity — or a phone that has left the network the server sits on —
 * still shows your trains, stale and labelled as such, instead of an empty app.
 */

const PREFIX = 'sncf.c1:';
const MAX_AGE_MS = 12 * 3600 * 1000;

interface Entry<T> {
  at: number;
  data: T;
}

export class Cache {
  /** path -> timestamp of the cached copy currently being served. */
  private readonly served = new Map<string, number>();

  get<T>(path: string): Entry<T> | null {
    try {
      const raw = localStorage.getItem(PREFIX + path);
      if (!raw) return null;
      const e = JSON.parse(raw) as Entry<T>;
      if (!e || Date.now() - e.at > MAX_AGE_MS) return null;
      return e;
    } catch {
      return null;
    }
  }

  set<T>(path: string, data: T): void {
    try {
      localStorage.setItem(PREFIX + path, JSON.stringify({ at: Date.now(), data }));
    } catch {
      // Quota reached: drop the oldest half, then try once more.
      try {
        const dated = Object.keys(localStorage)
          .filter((k) => k.startsWith(PREFIX))
          .map((k) => {
            let at = 0;
            try {
              at = (JSON.parse(localStorage.getItem(k) ?? '{}') as Entry<unknown>).at ?? 0;
            } catch {
              /* corrupt entry */
            }
            return { k, at };
          })
          .sort((a, b) => a.at - b.at);
        for (const { k } of dated.slice(0, Math.ceil(dated.length / 2))) localStorage.removeItem(k);
        localStorage.setItem(PREFIX + path, JSON.stringify({ at: Date.now(), data }));
      } catch {
        /* the cache is an optimisation, not a requirement */
      }
    }
  }

  markServed(path: string, at: number): void {
    this.served.set(path, at);
  }
  clearServed(path: string): void {
    this.served.delete(path);
  }
  servedAt(path: string): number | undefined {
    return this.served.get(path);
  }

  /** Newest cache timestamp in play, or null when everything is live. */
  get newestServed(): number | null {
    return this.served.size ? Math.max(...this.served.values()) : null;
  }
}

/** Small typed wrapper over localStorage for user preferences. */
export class Prefs {
  static get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem('sncf.' + key);
      return v === null ? fallback : ((JSON.parse(v) as T) ?? fallback);
    } catch {
      return fallback;
    }
  }

  static set<T>(key: string, value: T): void {
    try {
      localStorage.setItem('sncf.' + key, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  }
}
