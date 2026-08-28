/**
 * Application shell: owns the views, the polling loop and every event binding.
 *
 * Two behaviours here are less obvious than they look. Refreshing on wake is
 * not optional — mobile browsers freeze timers when you switch apps, and iOS
 * restores from the back/forward cache without re-running any script, so a
 * plain interval leaves times frozen at whatever they were when you left. And
 * every interval checks visibility first, so nothing queues up while hidden.
 */

import { Api } from './core/Api.ts';
import { Bookmarks } from './core/Bookmarks.ts';
import { Format } from './core/Format.ts';
import { i18n, I18n, LOCALES, tr } from './core/I18n.ts';
import { Prefs } from './core/Cache.ts';
import { Router, type Route, type ViewName } from './core/Router.ts';
import { Theme, type ThemeMode } from './core/Theme.ts';
import { Alerts, Banner, Toast } from './components/Banner.ts';
import { MapView, type MapMode } from './components/MapView.ts';
import { TrainModal, type ModalTab } from './components/TrainModal.ts';
import { SearchView } from './views/SearchView.ts';
import { WorstView } from './views/WorstView.ts';
import { WatchView } from './views/WatchView.ts';

const REFRESH_MS = 30_000;
/** How stale the data must be before a wake-up bothers refetching. */
const STALE_MS = 8_000;

export class App {
  private readonly api = new Api();
  private readonly bookmarks = new Bookmarks();
  private readonly theme = new Theme();
  private readonly router = new Router();
  /**
   * Whether the open modal has a history entry of its own.
   *
   * It does when the user opened it from the list, and does not when they
   * arrived on a shared link — so closing it means Back in the first case and
   * a plain rewrite to "/" in the second, which would otherwise walk them off
   * the site.
   */
  private modalPushed = false;
  private readonly toast = new Toast(document.getElementById('toast')!);
  private readonly alerts = new Alerts(this.toast);
  private readonly banner = new Banner(document.getElementById('banner')!);
  private readonly map = new MapView(this.api, this.theme);
  private readonly modal: TrainModal;
  private readonly watchView: WatchView;
  private readonly searchView: SearchView;
  private readonly worstView: WorstView;

  private view: ViewName = 'watch';
  private mapMode: MapMode = Prefs.get<MapMode>('mapMode', 'train');
  private feedDown = false;
  private lastRender = 0;
  private rendering = false;

  constructor() {
    this.modal = new TrainModal(
      this.api,
      this.map,
      (n) => this.bookmarks.has(n),
      () => this.mapMode,
    );
    this.watchView = new WatchView(this.api, this.bookmarks, this.alerts);
    this.searchView = new SearchView(this.api, this.bookmarks);
    this.worstView = new WorstView(this.api, this.bookmarks);
  }

  // ── language ───────────────────────────────────────────────────────────────

  /** Fill every element carrying an i18n key. */
  private applyStaticI18n(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      el.textContent = tr(el.dataset['i18n']!);
    }
    for (const el of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
      el.placeholder = tr(el.dataset['i18nPlaceholder']!);
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
      el.setAttribute('aria-label', tr(el.dataset['i18nAria']!));
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
      el.title = tr(el.dataset['i18nTitle']!);
    }
    const d = document.getElementById('mapDisclaimer');
    if (d) d.innerHTML = tr('map.disclaimer'); // this one carries <strong>
    document.title = tr('app.title');
  }

  private applyLang(lang: string): void {
    i18n.setLang(lang);
    Prefs.set('lang', i18n.lang);
    const sel = document.getElementById('langSel') as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = Object.entries(LOCALES)
        .map(([code, l]) => `<option value="${code}">${Format.esc(l.name)}</option>`)
        .join('');
      sel.value = i18n.lang;
    }
    this.applyStaticI18n();
    void this.render();
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private async renderFeedState(): Promise<void> {
    const dot = document.getElementById('feedDot')!;
    const age = document.getElementById('feedAge')!;
    try {
      const s = await this.api.stats();
      const local = this.api.cache.newestServed;
      this.banner.render(s, local);
      this.feedDown = !s.total;
      const live = s.ageSec != null && s.ageSec < 240 && !s.stale;
      dot.className = 'dot ' + (live ? 'live' : s.total ? 'stale' : '');
      age.textContent =
        s.ageSec == null
          ? tr('banner.downTitle')
          : `${s.total} · ${
              s.stale
                ? tr('app.localData')
                : s.ageSec < 90
                  ? tr('app.live')
                  : tr('app.minutesAgo', { n: Math.round(s.ageSec / 60) })
            }`;
    } catch {
      dot.className = 'dot';
      const local = this.api.cache.newestServed;
      age.textContent = local ? tr('app.localData') : tr('app.offline');
      this.banner.render(
        { total: 0, byFamily: {}, delayed: 0, cancelled: 0, feedTs: 0, fetchedAt: 0, ageSec: null, stale: false, replay: false, error: null },
        local,
      );
      this.feedDown = !local;
    }
  }

  async render(): Promise<void> {
    if (this.rendering) return; // a wake must not race the interval
    this.rendering = true;
    try {
      if (this.view === 'watch') await this.watchView.render(this.feedDown);
      else if (this.view === 'worst') await this.worstView.render();
      else await this.searchView.render(this.feedDown);
      if (this.modal.openFor) await this.modal.refresh();
    } catch (e) {
      console.error('render', e);
      this.toast.show(tr('error.generic', { error: (e as Error).message }));
    }
    this.renderNotifyButton();
    await this.renderFeedState();
    this.lastRender = Date.now();
    this.rendering = false;
  }

  private renderNotifyButton(): void {
    const b = document.getElementById('notifyBtn') as HTMLButtonElement | null;
    if (!b) return;
    b.textContent = Alerts.granted ? tr('alerts.enabled') : tr('alerts.enable');
    b.disabled = Alerts.granted;
  }

  /** Open a train and give it a URL, so the page can be shared or reloaded. */
  private openTrain(number: string, tab: ModalTab = 'apercu'): void {
    this.router.go(number, tab === 'apercu' ? null : tab, 'push');
    this.modalPushed = true;
    void this.modal.open(number, tab);
  }

  private closeTrain(): void {
    if (this.modalPushed) {
      // Unwinds our own entry; the popstate that follows closes the modal.
      this.modalPushed = false;
      history.back();
      return;
    }
    this.router.goView(this.view, 'replace');
    this.modal.close();
  }

  /**
   * Bring the modal in line with the URL.
   *
   * Called for Back, Forward and the initial load, so it must never write to
   * history itself — that is what closeTrain and openTrain are for.
   */
  private async applyRoute(route: Route): Promise<void> {
    if (!route.train) {
      this.modalPushed = false;
      if (this.modal.openFor) this.modal.close();
      if (route.view && route.view !== this.view) this.showView(route.view);
      return;
    }
    if (this.modal.openFor === route.train) {
      if (route.tab && route.tab !== this.modal.activeTab) this.modal.setTab(route.tab);
      return;
    }
    await this.modal.open(route.train, route.tab ?? 'apercu');
  }

  /** A tab chosen by the user: update the page and give it its URL. */
  private goto(view: ViewName): void {
    this.router.goView(view, 'push');
    this.showView(view);
  }

  /**
   * Show a tab without touching history.
   *
   * Used by Back/Forward and on first load, where the URL is already right and
   * writing to it again would either loop or bury the entry we came from.
   */
  private showView(view: ViewName): void {
    this.view = view;
    for (const b of document.querySelectorAll<HTMLElement>('.tab')) {
      const on = b.dataset['view'] === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
    document.getElementById('view-' + view)?.classList.add('active');
    window.scrollTo(0, 0);
    void this.render();
    if (view === 'search') {
      setTimeout(() => (document.getElementById('searchInput') as HTMLElement)?.focus(), 60);
    }
  }

  /** Keep bookmarked trains warm in the cache, for offline use. */
  private async primeCache(): Promise<void> {
    await Promise.allSettled(this.bookmarks.all.map((n) => this.api.train(n)));
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    for (const b of document.querySelectorAll<HTMLElement>('.tab')) {
      b.addEventListener('click', () => this.goto(b.dataset['view'] as ViewName));
    }
    for (const b of document.querySelectorAll<HTMLElement>('#themeToggle button')) {
      b.addEventListener('click', () => {
        this.theme.apply(b.dataset['themeSet'] as ThemeMode);
      });
    }
    this.theme.onChange(() => this.map.restyle(() => void this.modal.refresh()));
    this.theme.watchSystem();

    document.getElementById('langSel')?.addEventListener('change', (e) => {
      this.applyLang((e.target as HTMLSelectElement).value);
    });

    const input = document.getElementById('searchInput') as HTMLInputElement;
    input.addEventListener('input', (e) => {
      this.searchView.query = (e.target as HTMLInputElement).value;
      this.searchView.schedule((msg) => {
        document.getElementById('searchHint')!.textContent = msg;
      });
    });
    document.getElementById('searchClear')!.addEventListener('click', () => {
      this.searchView.query = '';
      input.value = '';
      void this.searchView.render(this.feedDown);
      input.focus();
    });
    for (const b of document.querySelectorAll<HTMLElement>('#familyChips button')) {
      b.addEventListener('click', () => {
        this.searchView.family = b.dataset['family']!;
        for (const x of document.querySelectorAll('#familyChips button')) {
          x.setAttribute('aria-pressed', String(x === b));
        }
        void this.render();
      });
    }

    document.getElementById('notifyBtn')!.addEventListener('click', () => {
      void this.alerts.request().then(() => this.renderNotifyButton());
    });

    document.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modal.openFor) this.closeTrain();
      if (e.key === 'Enter' && (e.target as HTMLElement).id === 'searchInput') {
        const first = document.querySelector<HTMLElement>('#suggestList .sg');
        if (first) this.openTrain(first.dataset['open']!);
      }
    });

    this.bindSheetDrag();
    this.bindWake();
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // Star toggles must never fall through to the row's open-detail handler.
    const star = target.closest<HTMLElement>('[data-star]');
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      const r = this.bookmarks.toggle(star.dataset['star']!);
      if (!r) return this.toast.show(tr('fav.invalid'));
      const many = r.numbers.length > 1;
      const key = r.added ? (many ? 'fav.addedMany' : 'fav.added') : many ? 'fav.removedMany' : 'fav.removed';
      this.toast.show(tr(key, { n: many ? r.numbers.join(' + ') : r.numbers[0]! }));
      void this.render();
      return;
    }

    const mtab = target.closest<HTMLElement>('[data-mtab]');
    if (mtab) {
      const tab = mtab.dataset['mtab'] as ModalTab;
      // Replace, not push: four tabs should not bury the previous page under
      // four history entries.
      if (this.modal.openFor) this.router.go(this.modal.openFor, tab, 'replace');
      return this.modal.setTab(tab);
    }

    const mapMode = target.closest<HTMLElement>('[data-mapmode]');
    if (mapMode) {
      this.mapMode = mapMode.dataset['mapmode'] as MapMode;
      Prefs.set('mapMode', this.mapMode);
      for (const x of document.querySelectorAll<HTMLElement>('[data-mapmode]')) {
        const on = x.dataset['mapmode'] === this.mapMode;
        x.classList.toggle('active', on);
        x.setAttribute('aria-pressed', String(on));
      }
      this.modal.requestReframe();
      void this.modal.refresh();
      return;
    }

    if (target.closest('[data-close]')) return this.closeTrain();

    const go = target.closest<HTMLElement>('[data-goto]');
    if (go) return this.goto(go.dataset['goto'] as ViewName);

    const act = target.closest<HTMLElement>('[data-act]');
    if (act?.dataset['act'] === 'togglewatch') {
      const r = this.bookmarks.toggle(act.dataset['num']!);
      if (r) void this.modal.refresh();
      void this.render();
      return;
    }

    if (target.closest('#retryBtn')) {
      const b = target.closest('#retryBtn') as HTMLButtonElement;
      b.disabled = true;
      b.textContent = tr('banner.retrying');
      void this.api
        .refresh()
        .then((s) => this.toast.show(s.total ? tr('banner.restored', { n: s.total }) : tr('banner.stillDown')))
        .catch(() => this.toast.show(tr('banner.stillDown')))
        .finally(() => void this.render());
      return;
    }

    const opener = target.closest<HTMLElement>('[data-open]');
    if (opener) this.openTrain(opener.dataset['open']!);
  }

  /**
   * Drag the sheet down to dismiss.
   *
   * The grip looked draggable but only accepted a tap, which is worse than
   * showing nothing.
   */
  private bindSheetDrag(): void {
    const sheet = (): HTMLElement | null => document.querySelector('#modal .modal-sheet');
    let startY = 0;
    let startT = 0;
    let dy = 0;
    let active = false;
    let dragged = false;

    const fromHandle = (e: PointerEvent): boolean =>
      Boolean(
        (e.target as HTMLElement).closest('.modal-grip, .m-head') &&
          !(e.target as HTMLElement).closest('button, a, select, input'),
      );

    document.addEventListener('pointerdown', (e) => {
      if (document.getElementById('modal')!.hidden || !fromHandle(e)) return;
      active = true;
      dragged = false;
      startY = e.clientY;
      startT = performance.now();
      dy = 0;
      const el = sheet();
      if (el) el.style.transition = 'none';
    });

    document.addEventListener('pointermove', (e) => {
      if (!active) return;
      dy = Math.max(0, e.clientY - startY); // downward only
      if (dy > 4) dragged = true;
      const el = sheet();
      if (el) el.style.transform = `translateY(${dy}px)`;
    });

    const end = (): void => {
      if (!active) return;
      active = false;
      const el = sheet();
      if (!el) return;
      const height = el.getBoundingClientRect().height || 1;
      const velocity = dy / Math.max(1, performance.now() - startT);
      el.style.transition = 'transform .22s cubic-bezier(.2,.8,.3,1)';
      if (dy > height * 0.25 || velocity > 0.6) {
        el.style.transform = 'translateY(100%)';
        setTimeout(() => {
          el.style.transform = '';
          el.style.transition = '';
          this.closeTrain();
        }, 200);
      } else {
        el.style.transform = '';
      }
      dy = 0;
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);

    // A drag that snapped back still emits a click; without this the grip's
    // data-close would shut the sheet the user just decided to keep.
    document.addEventListener(
      'click',
      (e) => {
        if (!dragged) return;
        dragged = false;
        if ((e.target as HTMLElement).closest('.modal-grip, .m-head')) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }

  /** Every signal that the page is being looked at again. */
  private bindWake(): void {
    const wake = (reason: string): void => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - this.lastRender < STALE_MS) return;
      const dot = document.getElementById('feedDot');
      dot?.classList.add('syncing');
      this.render()
        .catch((e: Error) => console.warn('wake', reason, e))
        .finally(() => dot?.classList.remove('syncing'));
    };

    document.addEventListener('visibilitychange', () => wake('visibility'));
    window.addEventListener('focus', () => wake('focus'));
    window.addEventListener('online', () => wake('online'));
    window.addEventListener('offline', () => void this.renderFeedState());
    // bfcache restore: the page comes back intact, scripts never re-run.
    window.addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) wake('bfcache');
    });
  }

  // ── start ──────────────────────────────────────────────────────────────────

  start(): void {
    this.bindEvents();
    this.applyLang(Prefs.get<string | null>('lang', null) ?? I18n.detect());
    this.theme.apply(this.theme.mode);

    for (const x of document.querySelectorAll<HTMLElement>('[data-mapmode]')) {
      const on = x.dataset['mapmode'] === this.mapMode;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', String(on));
    }

    void this.render();
    void this.primeCache();

    // A shared link lands here: open its train straight away, and keep the
    // modal in step with Back and Forward from then on.
    this.router.onChange = (route) => void this.applyRoute(route);

    // A link to a train that is not running — or never existed — must not leave
    // a broken modal on screen. The modal closes itself; say why, and put the
    // address bar back on the tab the reader is actually looking at.
    this.modal.onMissing = (number, reason) => {
      this.modalPushed = false;
      this.router.goView(this.view, 'replace');
      this.toast.show(tr(reason === 'unknown' ? 'modal.unknown' : 'modal.dormant', { n: number }));
    };
    const initial = Router.read();
    if (initial.train) {
      // Normalise whatever shape the link used into the canonical path, so
      // copying the address bar afterwards yields a clean URL.
      this.router.go(initial.train, initial.tab, 'replace');
      void this.applyRoute(initial);
    } else if (initial.view && initial.view !== this.view) {
      this.showView(initial.view);
    }

    // Countdown ticks every second without refetching — but not while hidden.
    setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      for (const el of document.querySelectorAll<HTMLElement>('[data-cd]')) {
        const strong = el.querySelector('strong');
        if (strong) strong.textContent = Format.countdown(Number(el.dataset['cd']));
      }
    }, 1000);

    // Skip polling entirely while hidden rather than queueing work the browser
    // will throttle anyway.
    setInterval(() => {
      if (document.visibilityState === 'visible') void this.render();
    }, REFRESH_MS);
    setInterval(
      () => {
        if (document.visibilityState === 'visible') void this.primeCache();
      },
      5 * 60_000,
    );
  }
}
