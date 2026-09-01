/**
 * Says plainly what the data is worth right now.
 *
 * When upstream is down the page must not look like a network with no trains
 * running. Four degraded states, each stated rather than implied: browser
 * cache, replayed fixture, frozen server snapshot, and nothing at all.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import type { StatsDTO } from '../types.ts';

type Kind = 'down' | 'stale' | 'replay';

export class Banner {
  constructor(private readonly el: HTMLElement) {}

  render(s: StatsDTO, localCacheAt: number | null): void {
    let kind: Kind | null = null;
    let icon = '';
    let title = '';
    let sub = '';

    if (localCacheAt) {
      // Nothing reached the server at all: we are running off the browser copy.
      kind = 'stale';
      icon = '📦';
      title = tr('banner.offlineTitle');
      sub = tr('banner.offlineSub', { time: Format.hhmm(Math.floor(localCacheAt / 1000)) });
    } else if (s.replay) {
      kind = 'replay';
      icon = '🧪';
      title = tr('banner.demoTitle');
      sub = tr('banner.demoSub', { n: s.total });
    } else if (!s.total) {
      kind = 'down';
      icon = '⚠';
      title = tr('banner.downTitle');
      sub = tr('banner.downSub');
    } else if (s.stale) {
      kind = 'stale';
      icon = '⏸';
      title = tr('banner.downTitle');
      sub = tr('banner.frozenSub', { time: s.feedTs ? Format.hhmm(s.feedTs) : '—' });
    } else if (s.ageSec != null && s.ageSec > 600) {
      kind = 'stale';
      icon = '⏳';
      title = tr('banner.slowTitle');
      sub = tr('banner.slowSub', {
        n: Math.round(s.ageSec / 60),
        time: s.feedTs ? Format.hhmm(s.feedTs) : '—',
      });
    }

    if (!kind) {
      this.el.hidden = true;
      this.el.innerHTML = '';
      return;
    }
    this.el.hidden = false;
    this.el.className = 'banner ' + kind;
    this.el.innerHTML = `<span class="b-ic" aria-hidden="true">${icon}</span>
      <span class="b-txt"><strong>${Format.esc(title)}</strong><span class="b-sub">${Format.esc(sub)}</span></span>
      ${kind === 'replay' ? '' : `<button id="retryBtn">${Format.esc(tr('banner.retry'))}</button>`}`;
  }
}

/** Transient confirmation, doubling as the visible half of an alert. */
export class Toast {
  private timer: number | null = null;

  constructor(private readonly el: HTMLElement) {}

  show(message: string): void {
    this.el.textContent = message;
    this.el.classList.add('show');
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('show'), 2800);
  }
}

/**
 * Desktop notifications when a followed train's delay moves.
 *
 * The point of the app: you should not have to be looking at the screen to
 * learn your train slipped another twenty minutes.
 */
export class Alerts {
  /** number -> delay at the previous poll. */
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly toast: Toast) {}

  static get granted(): boolean {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted';
  }

  async request(): Promise<string> {
    try {
      if (typeof Notification === 'undefined') {
        this.toast.show(tr('alerts.unsupported'));
        return 'unsupported';
      }
      const p = await Notification.requestPermission();
      this.toast.show(p === 'granted' ? tr('alerts.granted') : tr('alerts.denied'));
      return p;
    } catch {
      this.toast.show(tr('alerts.unavailable'));
      return 'error';
    }
  }

  private notify(title: string, body: string): void {
    this.toast.show(`${title} · ${body}`);
    try {
      if (Alerts.granted) new Notification(title, { body, tag: title });
    } catch {
      /* unsupported */
    }
  }

  check(t: {
    number: string;
    delay: number;
    cancelled: boolean;
    origin: string;
    destination: string;
    next: { name: string; time: number } | null;
  }): void {
    const prev = this.lastSeen.get(t.number);
    this.lastSeen.set(t.number, t.delay);
    if (prev === undefined) return; // first sighting
    if (t.cancelled) {
      this.notify(tr('alerts.cancelled', { n: t.number }), `${t.origin} → ${t.destination}`);
      return;
    }
    const diff = t.delay - prev;
    if (Math.abs(diff) < 120) return; // ignore sub-two-minute jitter
    this.notify(
      tr('alerts.delayChange', {
        n: t.number,
        sign: diff > 0 ? '+' : '−',
        m: Math.abs(Math.round(diff / 60)),
      }),
      tr('alerts.delayBody', {
        stop: t.next?.name ?? '',
        time: t.next ? Format.hhmm(t.next.time) : '',
        delay: Format.delay(t.delay),
      }),
    );
  }
}
