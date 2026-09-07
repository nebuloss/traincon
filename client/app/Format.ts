/**
 * Presentation of times, delays and positions.
 *
 * Kept apart from the components so the wording rules live in one place: a
 * delay under the hour reads "+45 min", over it "+1 h 10", the way SNCF writes
 * it — and trains run on Paris time wherever the page is read.
 */

import { i18n, tr } from './I18n.ts';
import type { Position, TrainDTO } from '../types.ts';

/** Delay severity. Red is reserved for cancellations. */
export type DelayTier = 'ontime' | 'late' | 'verylate' | 'cancelled';

export class Format {
  /** Always Europe/Paris: the trains run on French time. */
  static hhmm(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString(i18n.intlLocale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris',
    });
  }

  static delayTier(sec: number, cancelled = false): DelayTier {
    if (cancelled) return 'cancelled';
    if (sec >= 1200) return 'verylate';
    if (sec >= 300) return 'late';
    return 'ontime';
  }

  /** "+45 min" under the hour, "+1 h 10" over it. */
  static delay(sec: number): string {
    const m = Math.round(sec / 60);
    if (m === 0) return tr('delay.onTime');
    const sign = m > 0 ? '+' : '−';
    const a = Math.abs(m);
    if (a < 60) return tr('delay.minutes', { sign, n: a });
    const h = Math.floor(a / 60);
    const r = a % 60;
    return r === 0
      ? tr('delay.hours', { sign, h })
      : tr('delay.hoursMinutes', { sign, h, m: String(r).padStart(2, '0') });
  }

  static countdown(ts: number): string {
    const s = ts - Math.floor(Date.now() / 1000);
    if (s < -60) return tr('countdown.gone');
    if (s < 0) return tr('countdown.now');
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0
      ? tr('countdown.hours', { h, m: String(m).padStart(2, '0') })
      : tr('countdown.minutes', { m });
  }

  static trend(kind: string): string {
    return tr(`trend.${kind}`);
  }

  /** Escape for interpolation into markup. */
  static esc(s: unknown): string {
    return String(s ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
    );
  }

  /** "8540 + 8582" for a coupled set. */
  static label(t: Pick<TrainDTO, 'number' | 'coupledWith'>): string {
    return [t.number, ...(t.coupledWith ?? [])].join(' + ');
  }

  /** Short phrase describing where the train is. */
  static position(p: Position | null | undefined): string {
    if (!p) return tr('pos.unknown');
    switch (p.basis) {
      case 'not_departed':
        return tr('pos.notDeparted', { stop: Format.esc(p.atStation) });
      case 'arrived':
        return tr('pos.arrived', { stop: Format.esc(p.atStation) });
      case 'at_station':
        return tr('pos.inStation', { stop: Format.esc(p.atStation) });
      case 'between':
        return tr('pos.between', {
          from: Format.esc(p.fromStop),
          to: Format.esc(p.nextStop),
          pct: Math.round((p.legProgress ?? 0) * 100),
          km: p.legKm ?? 0,
        });
      default:
        return tr('pos.unknown');
    }
  }
}

export interface StatusSentence {
  main: string;
  sub: string;
  icon: string;
}

/**
 * Where the train is, as a sentence.
 *
 * The parameter is `train`, not `t` — `t` was the translator once, and the
 * collision broke every string in this block.
 */
export function statusSentence(train: TrainDTO): StatusSentence {
  const p = train.position;
  if (train.cancelled) {
    return { main: tr('status.cancelled'), sub: tr('status.cancelledSub'), icon: '✕' };
  }
  switch (p.basis) {
    case 'not_departed':
      return {
        main: tr('status.inStation', { stop: p.atStation ?? '' }),
        sub: tr('status.notDeparted', { time: Format.hhmm(train.calls[0]!.time) }),
        icon: '🅿',
      };
    case 'at_station':
      return {
        main: tr('status.inStation', { stop: p.atStation ?? '' }),
        sub: train.next
          ? tr('status.leavesFor', { stop: p.nextStop ?? '', time: Format.hhmm(train.next.time) })
          : tr('status.atPlatform'),
        icon: '🛑',
      };
    case 'arrived':
      return {
        main: tr('status.arrived', { stop: p.atStation ?? '' }),
        sub: tr('status.journeyOver'),
        icon: '🏁',
      };
    case 'between': {
      const bits = [tr('status.legProgress', { pct: Math.round((p.legProgress ?? 0) * 100) })];
      if (p.legKm) bits.push(tr('status.legKm', { km: p.legKm }));
      if (p.speedKmh) bits.push(tr('status.speed', { kmh: p.speedKmh }));
      return {
        main: tr('status.between', { from: p.fromStop ?? '', to: p.nextStop ?? '' }),
        sub: bits.join(' · '),
        icon: '🚆',
      };
    }
    default:
      return { main: tr('status.unknown'), sub: '', icon: '❓' };
  }
}
