/**
 * The bookmark list — the view that matters most, because it answers "are my
 * trains still on time" at a glance rather than one train at a time.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import { TrainCard, starButton } from '../components/TrainCard.ts';
import type { Alerts } from '../components/Banner.ts';
import type { Api } from '../core/Api.ts';
import type { Bookmarks } from '../core/Bookmarks.ts';
import type { MissingReason, TrainDTO, TrainNotFound } from '../../shared/types.ts';

export class WatchView {
  constructor(
    private readonly api: Api,
    private readonly bookmarks: Bookmarks,
    private readonly alerts: Alerts,
  ) {}

  async render(feedDown: boolean): Promise<void> {
    const wrap = document.getElementById('watchList')!;
    const empty = document.getElementById('watchEmpty')!;

    if (!this.bookmarks.count) {
      wrap.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    if (feedDown) {
      wrap.innerHTML = `<p class="hint">${Format.esc(
        tr('watch.feedDown', { n: this.bookmarks.count }),
      )}</p>`;
      return;
    }

    const results = await Promise.all(
      this.bookmarks.all.map(async (num) => ({ num, res: await this.api.train(num) })),
    );

    // Bookmark two portions of one coupled set and you should see one card,
    // not two identical ones. Group by coupling and render the group once.
    const found = new Map<string, TrainDTO>();
    const missing: Array<{ num: string; res: TrainNotFound }> = [];
    for (const { num, res } of results) {
      if (res.found && res.trains[0]) found.set(num, res.trains[0]);
      else if (!res.found) missing.push({ num, res });
    }

    const done = new Set<string>();
    wrap.innerHTML = '';
    const isWatched = (n: string): boolean => this.bookmarks.has(n);

    for (const num of this.bookmarks.all) {
      if (done.has(num)) continue;
      const t = found.get(num);
      if (!t) continue;
      const mates = t.coupledWith.filter((n) => this.bookmarks.has(n));
      for (const n of [num, ...mates]) done.add(n);
      this.alerts.check(t);
      wrap.appendChild(new TrainCard(t, isWatched, [num, ...mates]).render());
    }

    for (const { num, res } of missing) {
      if (done.has(num)) continue;
      wrap.appendChild(WatchView.missingCard(num, res, isWatched));
    }
  }

  /**
   * A bookmark with no live train behind it.
   *
   * Two different situations, shown differently on purpose. A dormant train is
   * fine — it runs tomorrow, or outside the forecast window — and comes back on
   * its own. An unknown number never existed: it is a typo, and the card is
   * struck through and offers to remove it, because a bookmark you believe in
   * and that silently does nothing is worse than no bookmark at all.
   */
  private static missingCard(
    num: string,
    res: TrainNotFound,
    isWatched: (n: string) => boolean,
  ): HTMLElement {
    // Older servers predate the field; treat a known schedule as dormant.
    const reason: MissingReason = res.reason ?? (res.knownSchedule ? 'dormant' : 'unknown');
    const unknown = reason === 'unknown';

    const el = document.createElement('article');
    el.className = `card is-missing ${unknown ? 'is-unknown' : 'is-dormant'}`;
    // An unknown number has nothing to open; a dormant one still has a
    // timetable entry worth showing.
    if (!unknown) el.dataset['open'] = num;

    const line = res.knownSchedule?.line;
    el.innerHTML = `
      <div class="cd-top">
        ${starButton(num, isWatched)}
        ${
          res.knownSchedule
            ? `<span class="badge">${Format.esc(res.knownSchedule.service)}</span>`
            : ''
        }
        <span class="cd-num">${Format.esc(num)}</span>
        <span class="cd-delay missing-tag">${Format.esc(
          tr(unknown ? 'watch.unknownTag' : 'watch.dormantTag'),
        )}</span>
      </div>
      ${line ? `<div class="cd-od">${Format.esc(line)}</div>` : ''}
      <div class="cd-foot">
        ${
          unknown
            ? `<span class="cd-where">${Format.esc(tr('watch.unknownBody', { n: num }))}</span>
               <button class="link-btn" data-star="${Format.esc(num)}">${Format.esc(
                 tr('watch.removeBookmark'),
               )}</button>`
            : `<span class="cd-where">${Format.esc(tr('watch.dormantBody'))}</span>`
        }
      </div>`;
    return el;
  }
}
