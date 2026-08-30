/**
 * Journey timeline — vertical.
 *
 * Horizontal was the wrong shape: stops sit at even intervals, so French
 * station names ("Saint-Jean-de-Luz - Ciboure") overlap their neighbours at any
 * realistic width. Stacked vertically each name gets a full row and they can
 * never collide, and the same component doubles as the stop list.
 *
 * Rows are a fixed height so the train marker is placed by arithmetic rather
 * than by measuring the DOM: row centre plus the live fraction of the leg,
 * which is what distinguishes "in the station" from "between two".
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import type { Call, TrainDTO } from '../../shared/types.ts';
import { familyColor, familyGlyph } from './TrainIcon.ts';

/** Keep in sync with --row-h in the stylesheet. */
export const ROW_H = 46;

export class Timeline {
  constructor(private readonly train: TrainDTO) {}

  /** Marker position in row units (2.4 = 40 % of the way from stop 2 to 3). */
  private markerRow(): number {
    const { calls, position: p } = this.train;
    if (p.basis === 'arrived') return calls.length - 1;
    if (p.basis === 'at_station' || p.basis === 'not_departed') {
      const at = calls.findIndex((c) => c.name === p.atStation);
      return at >= 0 ? at : 0;
    }
    const from = calls.findIndex((c) => c.name === p.fromStop);
    return (from >= 0 ? from : 0) + (p.legProgress ?? 0);
  }

  private row(c: Call, i: number, n: number, now: number): string {
    const isNext = this.train.next && c.stopId === this.train.next.stopId;
    const past = c.time <= now && !isNext;
    const isFirst = i === 0;
    const isLast = i === n - 1;
    const tier = Format.delayTier(c.delay, this.train.cancelled);

    // SNCF quotes the arrival at an intermediate stop (Bordeaux 16h30), not
    // the departure (16h36). Origin is a departure, terminus an arrival,
    // everything between shows the arrival with the dwell alongside.
    const shown = isFirst ? (c.departure ?? c.time) : (c.arrival ?? c.time);
    const dep = c.departure ?? null;
    const dwell = !isFirst && !isLast && dep && c.arrival && dep > c.arrival ? dep : null;

    const meta = c.skipped
      ? Format.esc(tr('delay.cancelled'))
      : [
          dwell ? tr('stop.departure', { time: Format.hhmm(dwell) }) : '',
          c.delay >= 60
            ? `<b class="${tier}">${Format.delay(c.delay)}</b>`
            : Format.esc(tr('delay.onTime')),
        ]
          .filter(Boolean)
          .join(' · ');

    const cls = [
      past ? 'past' : '',
      isNext ? 'next' : '',
      c.skipped ? 'skipped' : '',
      isLast ? 'terminus' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return `<li class="tl-row ${cls}">
      <span class="tl-rail-cell"><i class="tl-dot"></i></span>
      <span class="tl-name" title="${Format.esc(c.name)}">${Format.esc(c.name)}</span>
      <span class="tl-times">
        <span class="tl-eta ${tier}">${c.skipped ? '—' : Format.hhmm(shown)}</span>
        <span class="tl-meta">${meta}</span>
      </span>
    </li>`;
  }

  render(now = Math.floor(Date.now() / 1000)): string {
    const calls = this.train.calls;
    const n = calls.length;
    if (n < 2) return '';

    const pos = this.markerRow();
    const atStop = this.train.position.basis !== 'between';
    const rows = calls.map((c, i) => this.row(c, i, n, now)).join('');

    const lo = Math.floor(pos);
    const hi = Math.min(n - 1, Math.ceil(pos));
    const frac = hi > lo ? pos - lo : 0;
    const markTop = ROW_H / 2 + (lo + (hi - lo) * frac) * ROW_H;

    // The rail is drawn as two absolute segments with a gap at the marker,
    // rather than as a line behind it. Relying on z-index to put the train on
    // top did not hold in practice — isolation, a higher index and an opaque
    // halo all failed to keep the line off it — so nothing is drawn there at
    // all. `--mark-r` is the marker's radius plus its halo, in CSS, so the gap
    // follows the marker when it scales up on desktop.
    const railStart = ROW_H / 2;
    const railEnd = (n - 1) * ROW_H + ROW_H / 2;
    const travelled = `max(0px, calc(${markTop - railStart}px - var(--mark-r)))`;
    const remaining = `max(0px, calc(${railEnd - markTop}px - var(--mark-r)))`;

    return `<div class="tl">
      <div class="tl-fill" style="top:calc(6px + ${railStart}px); height:${travelled}"></div>
      <div class="tl-rail" style="top:calc(6px + ${markTop}px + var(--mark-r)); height:${remaining}"></div>
      <ul class="tl-list">${rows}</ul>
      <div class="tl-train ${atStop ? 'at-stop' : ''}"
           style="top:${markTop}px; --tl-train: ${familyColor(this.train)}"
           title="${Format.esc(Format.position(this.train.position))}"
           aria-label="${Format.esc(Format.position(this.train.position))}"
           >${familyGlyph(this.train)}</div>
    </div>`;
  }
}
