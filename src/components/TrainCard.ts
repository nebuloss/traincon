/**
 * A bookmarked train, built for scanning a list rather than reading one train
 * in depth — that is what the modal is for.
 *
 * The state is a sentence — "En gare de Bordeaux Saint-Jean", "Entre Dax et
 * Bordeaux" — because that is the thing you actually want to know at a glance.
 * A progress bar looks informative and says less: it cannot name the stations
 * without labels, and with labels it stops being compact.
 */

import { Format, statusSentence } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import type { TrainDTO } from '../types.ts';

/** The star, which may carry several numbers for a coupled set. */
export function starButton(spec: string, isWatched: (n: string) => boolean): string {
  const nums = String(spec).split(',');
  const on = nums.some(isWatched);
  return `<button class="star ${on ? 'on' : ''}" data-star="${Format.esc(spec)}"
    aria-pressed="${on}" title="${Format.esc(tr(on ? 'fav.remove' : 'fav.add'))}"
    aria-label="${Format.esc(tr('fav.aria', { n: nums.join(' + ') }))}">${on ? '★' : '☆'}</button>`;
}

export class TrainCard {
  constructor(
    private readonly train: TrainDTO,
    private readonly isWatched: (n: string) => boolean,
    /** Bookmarked numbers of this physical train, so one star clears them all. */
    private readonly bookmarked: string[] | null = null,
  ) {}

  render(): HTMLElement {
    const t = this.train;
    const el = document.createElement('article');
    el.className = 'card' + (t.cancelled ? ' is-cancelled' : '');
    el.dataset['open'] = t.number;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;

    const tier = Format.delayTier(t.delay, t.cancelled);
    const nx = t.next;
    const terminus = t.calls[t.calls.length - 1]!;
    const st = statusSentence(t);
    // On the final leg the next stop *is* the terminus, so an "Arrivée" line
    // underneath would just repeat the same station and time.
    const lastLeg = !nx || nx.stopId === terminus.stopId;

    el.innerHTML = `
      <div class="cd-top">
        ${starButton(this.bookmarked?.length ? this.bookmarked.join(',') : t.number, this.isWatched)}
        <span class="badge ${t.family}">${Format.esc(t.serviceLabel)}</span>
        <span class="cd-num">${Format.esc(Format.label(t))}</span>
        ${t.coupledWith.length ? '<span class="um-tag">UM</span>' : ''}
        <span class="cd-delay ${tier}">${
          t.cancelled ? Format.esc(tr('delay.cancelled')).toUpperCase() : Format.delay(t.delay)
        }</span>
      </div>
      <div class="cd-od">${Format.esc(t.origin)} → ${Format.esc(t.destination)}</div>
      <div class="cd-foot">
        <span class="cd-where">${Format.esc(st.main)}</span>
        ${
          nx
            ? `<span class="cd-next">
                 <b>${Format.esc(nx.name)}</b> ${Format.hhmm(nx.time)}
                 <i data-cd="${nx.time}"><b>${Format.countdown(nx.time)}</b></i>
               </span>`
            : ''
        }
      </div>
      ${
        lastLeg
          ? ''
          : `<div class="cd-arr">${Format.esc(tr('card.arrival', { stop: terminus.name }))} ·
               <b class="${Format.delayTier(terminus.delay, t.cancelled)}">${Format.hhmm(
                 terminus.arrival ?? terminus.time,
               )}</b></div>`
      }`;
    return el;
  }
}
