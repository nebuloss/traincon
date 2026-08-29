/**
 * One train as a list row — the shape used by search and by the hall of shame.
 *
 * Both lists want the same thing: identify the train, say one useful sentence
 * about it, show the delay, and open the detail modal when tapped. They had
 * drifted into two near-identical copies of the markup, so the difference
 * between them is now just the sentence in the middle.
 *
 * The bookmark list deliberately does *not* use this: it is a card with a
 * progress bar, because there the job is comparing several trains' progress at
 * a glance rather than picking one out of a list. It shares the atoms —
 * `starButton`, `Format.label`, the badge and delay classes — so the two still
 * read as the same family.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import { starButton } from './TrainCard.ts';
import type { Family } from '../../shared/types.ts';

export interface RowTrain {
  number: string;
  serviceLabel: string;
  family: Family;
  origin: string;
  destination: string;
  delay: number;
  cancelled: boolean;
  coupledWith?: string[];
}

export interface RowOptions {
  /** The middle line: why it matched, or why it is late. */
  detail: string;
  isWatched: (n: string) => boolean;
  /** Position in an ordered list, shown as a rank badge. */
  rank?: number;
  /** Marks a train still in the live feed, when the list also holds past ones. */
  live?: boolean;
  /**
   * Whether the row opens the detail modal.
   *
   * The hall of shame keeps trains that have finished, or have not yet entered
   * the feed window, and there is nothing to open for those — the modal would
   * flash up and close itself the moment the lookup came back empty. Such a row
   * is rendered inert instead: its delay and reason are already on it.
   */
  clickable?: boolean;
}

export function trainRow(t: RowTrain, opts: RowOptions): string {
  const tier = Format.delayTier(t.delay, t.cancelled);
  const label = Format.label({ number: t.number, coupledWith: t.coupledWith ?? [] });
  const clickable = opts.clickable ?? true;

  // A div rather than a disabled button: nothing here is actionable, so it
  // should not take focus or be announced as a control either.
  const open = clickable
    ? `<button class="sg" data-open="${Format.esc(t.number)}">`
    : '<div class="sg is-static">';

  return `<li role="option" class="sg-row${clickable ? '' : ' is-static'}">
    ${opts.rank === undefined ? '' : `<span class="rank" aria-hidden="true">${opts.rank}</span>`}
    ${starButton(t.number, opts.isWatched)}
    ${open}
      <div class="sg-main">
        <div class="sg-top">
          <span class="badge ${t.family}">${Format.esc(t.serviceLabel)}</span>
          <span class="sg-num">${Format.esc(label)}</span>
          ${t.coupledWith?.length ? '<span class="um-tag">UM</span>' : ''}
          ${opts.live ? `<span class="live-tag">${Format.esc(tr('worst.live'))}</span>` : ''}
        </div>
        <div class="sg-od">${Format.esc(t.origin)} → ${Format.esc(t.destination)}</div>
        <div class="sg-why">${opts.detail}</div>
      </div>
      <div class="sg-delay ${tier}">${
        t.cancelled ? Format.esc(tr('delay.cancelled')) : Format.delay(t.delay)
      }</div>
    ${clickable ? '</button>' : '</div>'}
  </li>`;
}
