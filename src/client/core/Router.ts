/**
 * Deep links to a single train.
 *
 * The point is that a link can be pasted into a message and land the reader
 * straight on the train, so this reads every shape someone might reasonably
 * type or a chat app might mangle:
 *
 *     /train/8540            canonical
 *     /train/8540/carte      canonical, with the tab
 *     /t/8540                short
 *     ?train=8540&tab=carte  query
 *     #8540                  bare hash
 *     #train=8540
 *
 * and always writes back the canonical path form. Tab names are accepted in
 * English too, so a link shared from the English interface reads naturally.
 */

import type { ModalTab } from '../components/TrainModal.ts';

export interface Route {
  train: string | null;
  tab: ModalTab | null;
}

/** Train numbers are short and alphanumeric; anything else is not a link. */
const NUMBER = /^[A-Za-z0-9]{1,8}$/;

const TABS: Readonly<Record<string, ModalTab>> = {
  apercu: 'apercu',
  overview: 'apercu',
  trajet: 'trajet',
  journey: 'trajet',
  carte: 'carte',
  map: 'carte',
  journal: 'journal',
  log: 'journal',
};

export class Router {
  /** Fired when the URL changes under us — Back, Forward, or a pasted hash. */
  onChange: (route: Route) => void = () => {};

  constructor() {
    window.addEventListener('popstate', () => this.onChange(Router.read()));
    // A bare `#8540` typed into the address bar of an already-open page fires
    // hashchange and nothing else.
    window.addEventListener('hashchange', () => this.onChange(Router.read()));
  }

  /** The route the page was opened on, or navigated to. */
  static read(loc: Location | URL = window.location): Route {
    const path = Router.fromPath(loc.pathname);
    if (path.train) return path;

    const params = new URLSearchParams(loc.search);
    const q = params.get('train') ?? params.get('t');
    if (q && NUMBER.test(q)) {
      return { train: q.toUpperCase(), tab: Router.toTab(params.get('tab')) };
    }

    return Router.fromHash(loc.hash);
  }

  private static fromPath(pathname: string): Route {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length < 2 || (parts[0] !== 'train' && parts[0] !== 't')) {
      return { train: null, tab: null };
    }
    const n = parts[1]!;
    if (!NUMBER.test(n)) return { train: null, tab: null };
    return { train: n.toUpperCase(), tab: Router.toTab(parts[2]) };
  }

  private static fromHash(hash: string): Route {
    const raw = hash.replace(/^#\/?/, '');
    if (!raw) return { train: null, tab: null };

    // `#train=8540&tab=carte`, or a path-ish `#/train/8540`.
    if (raw.includes('=')) {
      const params = new URLSearchParams(raw);
      const n = params.get('train') ?? params.get('t');
      if (n && NUMBER.test(n)) {
        return { train: n.toUpperCase(), tab: Router.toTab(params.get('tab')) };
      }
      return { train: null, tab: null };
    }
    if (raw.includes('/')) return Router.fromPath('/' + raw);

    // A bare `#8540`.
    return NUMBER.test(raw) ? { train: raw.toUpperCase(), tab: null } : { train: null, tab: null };
  }

  private static toTab(value: string | null | undefined): ModalTab | null {
    if (!value) return null;
    return TABS[value.toLowerCase()] ?? null;
  }

  /** Canonical URL for a train, for sharing. */
  static href(train: string, tab: ModalTab | null = null): string {
    return tab && tab !== 'apercu' ? `/train/${train}/${tab}` : `/train/${train}`;
  }

  /**
   * Point the address bar at a train.
   *
   * Opening a train pushes, so Back closes the modal, which is what a phone's
   * back gesture should do. Switching tab replaces, so a browse through all
   * four tabs does not bury the previous page under four history entries.
   */
  go(train: string | null, tab: ModalTab | null, mode: 'push' | 'replace' = 'push'): void {
    const url = train ? Router.href(train, tab) : window.location.pathname.replace(/^\/(train|t)\/.*/, '/');
    if (url === window.location.pathname + window.location.search + window.location.hash) return;
    history[mode === 'push' ? 'pushState' : 'replaceState']({ train, tab }, '', url);
  }
}
