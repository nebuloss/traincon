/**
 * The day's worst delays, worst first — with why, where SNCF says why.
 *
 * Rows are deliberately the same shape as the search results, so tapping one
 * opens the same detail modal and the star works the same way. The only
 * addition is the cause line, which is the point of the page.
 *
 * Trains stay on the board after they have finished running and left the feed,
 * so this is a record of the day rather than a second live list; a row still
 * in the feed is marked, because only those have a position to watch.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import { trainRow } from '../components/TrainRow.ts';
import type { Api } from '../core/Api.ts';
import type { Bookmarks } from '../core/Bookmarks.ts';
import type { WorstTrainDTO } from '../../shared/types.ts';

export class WorstView {
  constructor(
    private readonly api: Api,
    private readonly bookmarks: Bookmarks,
  ) {}

  private row(r: WorstTrainDTO, rank: number): string {
    return trainRow(r, {
      detail: r.reason
        ? Format.esc(r.reason)
        : `<span class="muted">${Format.esc(tr('worst.noReason'))}</span>`,
      isWatched: (n) => this.bookmarks.has(n),
      rank,
      live: r.live,
    });
  }

  async render(): Promise<void> {
    const list = document.getElementById('worstList');
    const note = document.getElementById('worstNote');
    if (!list) return;

    let board;
    try {
      board = await this.api.worst(25);
    } catch (e) {
      list.innerHTML = `<li class="hint">${Format.esc(
        tr('worst.failed', { error: (e as Error).message }),
      )}</li>`;
      return;
    }

    if (!board.trains.length) {
      // Genuinely good news, and worth saying so rather than showing a blank.
      list.innerHTML = `<li class="empty-row">${Format.esc(tr('worst.empty'))}</li>`;
      if (note) note.textContent = '';
      return;
    }

    list.innerHTML = board.trains.map((r, i) => this.row(r, i + 1)).join('');

    if (note) {
      // Without a key there is no cause anywhere on the page; say why once
      // here rather than repeating "unknown" on every row.
      note.textContent = board.reasonsAvailable
        ? tr('worst.note')
        : tr('worst.noKey');
    }
  }
}
