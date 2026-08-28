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

import { TRAIN_NUMBER, trainFromPath, trainFromQuery } from '../../shared/deeplink.ts';
import type { ModalTab } from '../components/TrainModal.ts';

export interface Route {
  train: string | null;
  tab: ModalTab | null;
}

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

    const query = trainFromQuery(loc.search);
    if (query) return { train: query.train, tab: Router.toTab(query.tab) };

    return Router.fromHash(loc.hash);
  }

  private static fromPath(pathname: string): Route {
    const hit = trainFromPath(pathname);
    return hit ? { train: hit.train, tab: Router.toTab(hit.tab) } : { train: null, tab: null };
  }

  private static fromHash(hash: string): Route {
    const raw = hash.replace(/^#\/?/, '');
    if (!raw) return { train: null, tab: null };

    // `#train=8540&tab=carte`, or a path-ish `#/train/8540`.
    if (raw.includes('=')) {
      const hit = trainFromQuery(raw);
      return hit ? { train: hit.train, tab: Router.toTab(hit.tab) } : { train: null, tab: null };
    }
    if (raw.includes('/')) return Router.fromPath('/' + raw);

    // A bare `#8540`.
    return TRAIN_NUMBER.test(raw)
      ? { train: raw.toUpperCase(), tab: null }
      : { train: null, tab: null };
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
