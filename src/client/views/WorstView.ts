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
 *
 * That record is the point, but it buries what is happening now: by the
 * evening the worst delays are mostly trains that finished hours ago, and a
 * reader wanting to know what is late *at the moment* had to read past them.
 * Hence the filter — the whole day, or only the trains still running.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import { trainRow } from '../components/TrainRow.ts';
import type { Api } from '../core/Api.ts';
import type { Bookmarks } from '../core/Bookmarks.ts';
import { Prefs } from '../core/Cache.ts';
import { POOL, pickShown } from '../core/WorstBoard.ts';
import type { WorstFilter } from '../core/WorstBoard.ts';
import type { WorstTrainDTO } from '../../shared/types.ts';

export class WorstView {
  private filter: WorstFilter = Prefs.get<WorstFilter>('worstFilter', 'all');

  constructor(
    private readonly api: Api,
    private readonly bookmarks: Bookmarks,
  ) {}

  /** Switch between the whole day and the trains still running. */
  setFilter(filter: WorstFilter): void {
    this.filter = filter;
    Prefs.set('worstFilter', filter);
    for (const b of document.querySelectorAll<HTMLElement>('[data-worstfilter]')) {
      const on = b.dataset['worstfilter'] === filter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  /** Reflect the stored choice in the markup, which starts on "all". */
  restoreFilter(): void {
    this.setFilter(this.filter);
  }

  /** The badge for a row's state, or none when there is nothing to add. */
  private static tag(status: WorstTrainDTO['status']): {
    text: string;
    kind: 'live' | 'past' | 'future';
  } | null {
    switch (status) {
      case 'running':
        return { text: tr('worst.running'), kind: 'live' };
      case 'finished':
        return { text: tr('worst.finished'), kind: 'past' };
      case 'upcoming':
        return { text: tr('worst.upcoming'), kind: 'future' };
      default:
        // Not in the feed and the schedule does not say why; claiming it had
        // arrived would be a guess.
        return { text: tr('worst.gone'), kind: 'past' };
    }
  }

  private row(r: WorstTrainDTO, rank: number): string {
    return trainRow(r, {
      detail: r.reason
        ? Format.esc(r.reason)
        : `<span class="muted">${Format.esc(tr('worst.noReason'))}</span>`,
      isWatched: (n) => this.bookmarks.has(n),
      rank,
      tag: WorstView.tag(r.status),
      // Only a train still in the feed has a detail to show. The rest are
      // records of the day; opening one gave a modal that closed itself.
      clickable: r.live,
    });
  }

  async render(): Promise<void> {
    const list = document.getElementById('worstList');
    const note = document.getElementById('worstNote');
    if (!list) return;

    let board;
    try {
      board = await this.api.worst(POOL);
    } catch (e) {
      list.innerHTML = `<li class="hint">${Format.esc(
        tr('worst.failed', { error: (e as Error).message }),
      )}</li>`;
      return;
    }

    const shown = pickShown(board.trains, this.filter);

    if (!shown.length) {
      // Genuinely good news, and worth saying so rather than showing a blank.
      // Which good news it is depends on what was asked for.
      const empty = this.filter === 'live' ? 'worst.emptyLive' : 'worst.empty';
      list.innerHTML = `<li class="empty-row">${Format.esc(tr(empty))}</li>`;
      if (note) note.textContent = '';
      return;
    }

    // Ranked within what is shown: on the live board, first place is the worst
    // delay running now, which is the question that board answers.
    list.innerHTML = shown.map((r, i) => this.row(r, i + 1)).join('');

    if (note) {
      // Without a key there is no cause anywhere on the page; say why once
      // here rather than repeating "unknown" on every row.
      note.textContent = board.reasonsAvailable
        ? tr('worst.note')
        : tr('worst.noKey');
    }
  }
}
