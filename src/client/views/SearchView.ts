/**
 * Autocomplete over every train currently running.
 *
 * Matches on number, origin, destination or any station served — so "dax"
 * finds every train calling there, and each row says why it matched. Tapping a
 * row opens the detail; the star is a separate target, so browsing costs
 * nothing.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import { trainRow } from '../components/TrainRow.ts';
import type { Api } from '../core/Api.ts';
import type { Bookmarks } from '../core/Bookmarks.ts';
import type { SuggestionDTO } from '../../shared/types.ts';

export class SearchView {
  query = '';
  family = 'all';
  private timer: number | null = null;

  constructor(
    private readonly api: Api,
    private readonly bookmarks: Bookmarks,
  ) {}

  /** Debounced: typing should not fire a request per keystroke. */
  schedule(onError: (msg: string) => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.render().catch((e: Error) => {
        // A silent catch here looks exactly like "autocomplete is broken".
        onError(tr('search.failed', { error: e.message }));
        console.error('search', e);
      });
    }, 180);
  }

  /** Why a row matched, translated. The server sends "serves:<station>". */
  private static reason(why: string): string {
    if (why.startsWith('serves:')) return tr('why.serves', { stop: why.slice(7) });
    return tr(`why.${why}`);
  }

  private row(r: SuggestionDTO): string {
    const why = Format.esc(SearchView.reason(r.why));
    const next = r.next
      ? ` · ${Format.esc(tr('search.nextStop', { stop: r.next.name, time: Format.hhmm(r.next.time) }))}`
      : '';
    return trainRow(r, {
      detail: why + next,
      isWatched: (n) => this.bookmarks.has(n),
    });
  }

  async render(feedDown = false): Promise<void> {
    const box = document.getElementById('suggestList')!;
    const hint = document.getElementById('searchHint')!;
    const input = document.getElementById('searchInput') as HTMLInputElement;
    const clear = document.getElementById('searchClear') as HTMLElement;

    const q = this.query.trim();
    clear.hidden = !q;
    input.setAttribute('aria-expanded', String(Boolean(q)));

    if (!q) {
      box.innerHTML = '';
      hint.textContent = tr('search.prompt');
      return;
    }

    const { rows, path } = await this.api.suggest(q, this.family);
    if (!rows.length) {
      box.innerHTML = '';
      hint.textContent = feedDown ? tr('search.feedDown') : tr('search.none', { q });
      return;
    }

    const cachedAt = this.api.cache.servedAt(path);
    hint.textContent =
      tr('search.results', { n: rows.length }) +
      (cachedAt
        ? ` · ${tr('search.cachedAt', { time: Format.hhmm(Math.floor(cachedAt / 1000)) })}`
        : '');
    box.innerHTML = rows.map((r) => this.row(r)).join('');
  }
}
