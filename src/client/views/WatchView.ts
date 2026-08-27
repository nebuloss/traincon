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
import type { TrainDTO } from '../../shared/types.ts';

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
    const missing: Array<{ num: string; message: string }> = [];
    for (const { num, res } of results) {
      if (res.found && res.trains[0]) found.set(num, res.trains[0]);
      else if (!res.found) missing.push({ num, message: res.message });
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

    for (const { num, message } of missing) {
      if (done.has(num)) continue;
      const el = document.createElement('article');
      el.className = 'card';
      el.dataset['open'] = num;
      el.innerHTML = `<div class="cd-top">
          ${starButton(num, isWatched)}
          <span class="cd-num">${Format.esc(num)}</span>
        </div>
        <div class="cd-od">${Format.esc(message)}</div>`;
      wrap.appendChild(el);
    }
  }
}
