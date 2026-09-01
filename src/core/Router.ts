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

import { TRAIN_NUMBER, trainFromPath, trainFromQuery } from './deeplink.ts';
import type { ModalTab } from '../components/TrainModal.ts';

/** The three top-level tabs. Defined here because the URL is their identity. */
export type ViewName = 'watch' | 'search' | 'worst';

export interface Route {
  /** Which tab the path names, or null when the path names only a train. */
  view: ViewName | null;
  train: string | null;
  tab: ModalTab | null;
}

/**
 * Paths that select a tab.
 *
 * French is canonical, matching the modal's own tab names, with the English
 * spellings accepted so a link shared from the English interface still works.
 */
const VIEWS: Readonly<Record<string, ViewName>> = {
  '': 'watch',
  'mes-trains': 'watch',
  watch: 'watch',
  recherche: 'search',
  search: 'search',
  palmares: 'worst',
  worst: 'worst',
};

const VIEW_PATH: Readonly<Record<ViewName, string>> = {
  watch: '/',
  search: '/recherche',
  worst: '/palmares',
};

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
    if (query) return { view: null, train: query.train, tab: Router.toTab(query.tab) };

    const hash = Router.fromHash(loc.hash);
    if (hash.train) return hash;

    // No train anywhere: the path selects a tab. Exactly one segment, so a
    // deeper path the server happened to serve the shell for does not silently
    // land on a tab it does not name.
    const parts = loc.pathname.split('/').filter(Boolean);
    if (parts.length > 1) return { view: null, train: null, tab: null };
    return { view: VIEWS[(parts[0] ?? '').toLowerCase()] ?? null, train: null, tab: null };
  }

  /** Canonical path for a tab. */
  static viewHref(view: ViewName): string {
    return VIEW_PATH[view];
  }

  /**
   * Point the address bar at a tab.
   *
   * Pushes by default, so Back walks through the tabs the way it walks through
   * pages — which is what the browser and the phone's gesture both expect.
   */
  goView(view: ViewName, mode: 'push' | 'replace' = 'push'): void {
    const url = Router.viewHref(view);
    if (url === window.location.pathname) return;
    history[mode === 'push' ? 'pushState' : 'replaceState']({ view }, '', url);
  }

  private static fromPath(pathname: string): Route {
    const hit = trainFromPath(pathname);
    return hit
      ? { view: null, train: hit.train, tab: Router.toTab(hit.tab) }
      : { view: null, train: null, tab: null };
  }

  private static fromHash(hash: string): Route {
    const empty: Route = { view: null, train: null, tab: null };
    const raw = hash.replace(/^#\/?/, '');
    if (!raw) return empty;

    // `#train=8540&tab=carte`, or a path-ish `#/train/8540`.
    if (raw.includes('=')) {
      const hit = trainFromQuery(raw);
      return hit ? { view: null, train: hit.train, tab: Router.toTab(hit.tab) } : empty;
    }
    if (raw.includes('/')) return Router.fromPath('/' + raw);

    // A bare `#8540`.
    return TRAIN_NUMBER.test(raw) ? { view: null, train: raw.toUpperCase(), tab: null } : empty;
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
