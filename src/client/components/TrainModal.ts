/**
 * One modal per train, with four tabs.
 *
 * Aperçu answers "where is it and when does it arrive"; Journal answers "how
 * much should I trust that, and what changed". Keeping those apart is what
 * stopped the overview turning into a wall of diagnostics.
 */

import { Format, statusSentence } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import { Timeline } from './Timeline.ts';
import { starButton } from './TrainCard.ts';
import { MapView, type MapMode } from './MapView.ts';
import { missingKind } from '../../shared/missing.ts';
import type { Api } from '../core/Api.ts';
import type { Confidence, MissingReason, TrainDTO } from '../../shared/types.ts';

export type ModalTab = 'apercu' | 'trajet' | 'carte' | 'journal';

/**
 * Placeholder for a fragment that must stay as markup.
 *
 * The translated sentence is escaped whole, then this marker is swapped for
 * the markup — so a translation string can never inject tags into the page.
 */
const MARK = '@@SLOT@@';

const CONF_TONE: Record<Confidence, 'ok' | 'warn' | 'bad'> = {
  confirmed: 'ok',
  good: 'ok',
  estimated: 'warn',
  stale: 'bad',
  scheduled: 'warn',
};

/** One row shape for the entire Journal: key, substance, short note. */
function jlRow(key: string, main: string, meta = '', tone = ''): string {
  return `<div class="jl-row${tone ? ' t-' + tone : ''}">
    <span class="jl-key">${key}</span>
    <span class="jl-main">${main}</span>
    <span class="jl-meta">${meta}</span>
  </div>`;
}

export class TrainModal {
  private current: string | null = null;
  /**
   * Whether this train has ever rendered since the modal was opened.
   *
   * A train that leaves the feed while you are watching it — because it has
   * arrived — must not slam the modal shut; only one that was never there
   * should refuse to open.
   */
  private everFound = false;
  /** Called when a train turns out not to exist, so the caller can react. */
  onMissing: (number: string, reason: MissingReason) => void = () => {};
  private tab: ModalTab = 'apercu';
  private mapReframe = false;

  constructor(
    private readonly api: Api,
    private readonly map: MapView,
    private readonly isWatched: (n: string) => boolean,
    private readonly mapMode: () => MapMode,
  ) {}

  get openFor(): string | null {
    return this.current;
  }
  get activeTab(): ModalTab {
    return this.tab;
  }

  async open(number: string, tab: ModalTab = 'apercu'): Promise<void> {
    this.current = number;
    this.everFound = false;
    document.getElementById('modal')!.hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('modalHead')!.innerHTML =
      `<p class="hint">${Format.esc(tr('modal.loading'))}</p>`;
    this.setTab(tab);
    await this.refresh();
  }

  close(): void {
    this.current = null;
    document.getElementById('modal')!.hidden = true;
    document.body.style.overflow = '';
    this.map.dispose();
  }

  setTab(tab: ModalTab): void {
    this.tab = tab;
    for (const b of document.querySelectorAll<HTMLElement>('.m-tabs button')) {
      const on = b.dataset['mtab'] === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const p of document.querySelectorAll('.m-panel')) p.classList.remove('active');
    document.getElementById('mpanel-' + tab)?.classList.add('active');
    if (tab === 'carte') void this.map.ensure().then(() => this.refresh());
  }

  /** A framing button was pressed: reapply the rule on the next draw. */
  requestReframe(): void {
    this.mapReframe = true;
  }

  async refresh(): Promise<void> {
    const num = this.current;
    if (!num) return;
    const d = await this.api.train(num);

    if (!d.found) {
      // Never opened on this train: there is nothing to show but four empty
      // tabs and an error, so hand it back to the caller and close.
      if (!this.everFound) {
        this.close();
        this.onMissing(num, missingKind(d));
        return;
      }
      // It was here a moment ago and has now left the feed — most likely it
      // arrived. Leave the last good render on screen rather than blanking it.
      return;
    }
    this.everFound = true;

    const t = d.trains[0]!;
    this.renderHead(t);
    this.renderOverview(t);
    document.getElementById('mpanel-trajet')!.innerHTML = new Timeline(t).render();
    this.renderJournal(t);

    if (this.tab === 'carte') {
      const follow = (document.getElementById('followLock') as HTMLInputElement | null)?.checked ?? true;
      await this.map.show(t, this.mapMode(), follow, this.mapReframe);
      this.mapReframe = false;
      // No header here: #mapTitle and #mapSub were removed from the panel when
      // the map became a tab, and the identity is already on the modal head
      // above the tabs. Writing to them threw on every map render.
    }
  }

  private renderHead(t: TrainDTO): void {
    const group = [t.number, ...t.coupledWith];
    const tier = Format.delayTier(t.delay, t.cancelled);
    document.getElementById('modalHead')!.innerHTML = `
      <div class="m-title" id="modalTitle">
        ${starButton(group.join(','), this.isWatched)}
        <span class="badge ${t.family}">${Format.esc(t.serviceLabel)}</span>
        <span>${Format.esc(group.join(' + '))}</span>
        ${group.length > 1 ? '<span class="um-tag">UM</span>' : ''}
        <span class="${tier} m-delay">${
          t.cancelled ? Format.esc(tr('delay.cancelled')).toUpperCase() : Format.delay(t.delay)
        }</span>
      </div>
      <div class="m-od">${Format.esc(t.origin)} → ${Format.esc(t.destination)}</div>`;
  }

  /** Next stop with a live countdown; shared by the overview and the journey. */
  static focusBlock(t: TrainDTO): string {
    const target = t.next;
    if (!target) return '';
    const tier = Format.delayTier(target.delay, t.cancelled);
    const gone = target.time < Math.floor(Date.now() / 1000);
    return `<div class="focus">
      <div class="label">${Format.esc(tr('card.nextStop', { stop: target.name }))}</div>
      <div class="time-row">
        <span class="live-time ${tier}">${t.cancelled ? '—' : Format.hhmm(target.time)}</span>
        ${target.delay >= 60 ? `<span class="planned-time">${Format.hhmm(target.time - target.delay)}</span>` : ''}
        <span class="${tier}">${
          t.cancelled ? Format.esc(tr('delay.cancelled')) : Format.delay(target.delay)
        }</span>
      </div>
      <div class="countdown" data-cd="${target.time}">
        ${
          t.cancelled
            ? Format.esc(tr('card.cancelledWarning'))
            : gone
              ? Format.esc(tr('card.alreadyPassed'))
              : `<strong>${Format.countdown(target.time)}</strong>`
        }
      </div>
    </div>`;
  }

  private renderOverview(t: TrainDTO): void {
    const st = statusSentence(t);
    const terminus = t.calls[t.calls.length - 1]!;
    const now = Math.floor(Date.now() / 1000);
    const remaining = t.calls.filter((c) => c.time > now).length;
    const tier = Format.delayTier(t.delay, t.cancelled);
    const group = [t.number, ...t.coupledWith];

    document.getElementById('mpanel-apercu')!.innerHTML = `
      <div class="ov-status${t.cancelled ? ' cancelled' : ''}">
        <span class="ov-ic" aria-hidden="true">${st.icon}</span>
        <span class="ov-txt">
          <strong>${Format.esc(st.main)}</strong>
          ${st.sub ? `<span class="ov-sub">${Format.esc(st.sub)}</span>` : ''}
        </span>
      </div>
      ${TrainModal.focusBlock(t)}
      <div class="ov-grid">
        <div class="ov-cell">
          <span class="ov-k">${Format.esc(tr('ov.terminus'))}</span>
          <span class="ov-v">${Format.esc(terminus.name)}</span>
          <span class="ov-s ${Format.delayTier(terminus.delay, t.cancelled)}">${Format.hhmm(
            terminus.arrival ?? terminus.time,
          )}</span>
        </div>
        <div class="ov-cell">
          <span class="ov-k">${Format.esc(tr('ov.delay'))}</span>
          <span class="ov-v ${tier}">${
            t.cancelled ? Format.esc(tr('delay.cancelled')) : Format.delay(t.delay)
          }</span>
          <span class="ov-s trend ${t.trend}">${Format.trend(t.trend)}</span>
        </div>
        <div class="ov-cell">
          <span class="ov-k">${Format.esc(tr('ov.stopsLeft'))}</span>
          <span class="ov-v">${remaining}</span>
          <span class="ov-s">${Format.esc(tr('ov.outOf', { n: t.calls.length }))}</span>
        </div>
        <div class="ov-cell">
          <span class="ov-k">${Format.esc(tr('ov.speed'))}</span>
          <span class="ov-v">${t.position.speedKmh ? t.position.speedKmh + ' km/h' : '—'}</span>
          <span class="ov-s">${Format.esc(t.serviceLabel)}</span>
        </div>
      </div>
      <div class="m-actions">
        <button data-act="togglewatch" data-num="${Format.esc(group.join(','))}"
                class="${this.isWatched(t.number) ? 'danger' : 'accent'}">
          ${Format.esc(this.isWatched(t.number) ? tr('ov.removeFav') : tr('ov.addFav'))}
        </button>
      </div>`;
  }

  /**
   * Written for a passenger, not for me. Every row explains something they
   * might act on; nothing assumes knowledge of how the app works.
   */
  private renderJournal(t: TrainDTO): void {
    const o = t.position.observation;
    const conf = o.confidence;
    const section = (title: string, body: string): string =>
      body ? `<h3 class="jl-h">${title}</h3><div class="jl">${body}</div>` : '';

    const trust = [
      jlRow(Format.esc(tr(`conf.${conf}`)), Format.esc(tr(`conf.${conf}Txt`)), '', CONF_TONE[conf]),
      o.lastStop
        ? jlRow(
            Format.esc(tr('jl.seenAt')),
            Format.esc(tr('jl.seenAtTxt', { stop: MARK })).replace(
              MARK,
              `<strong>${Format.esc(o.lastStop)}</strong>`,
            ),
            Format.esc(tr('jl.ago', { n: Math.round((o.ageSec ?? 0) / 60) })),
          )
        : '',
      t.reconciled?.disagreement
        ? jlRow(
            Format.esc(tr('jl.twoNumbers')),
            Format.esc(
              tr('jl.twoNumbersTxt', {
                count: t.reconciled.disagreement.length,
                list: MARK,
                shown: '',
              }),
            )
              .replace(
                MARK,
                t.reconciled.disagreement
                  .map((x) => `<strong>${Format.esc(x.number)}</strong> ${Format.delay(x.delay)}`)
                  .join(', '),
              )
              .replace('', `<strong>${Format.esc(t.number)}</strong>`),
            '',
            'warn',
          )
        : '',
    ]
      .filter(Boolean)
      .join('');

    const hist = [...t.history].reverse();
    const changes =
      hist.length > 1
        ? hist
            .map((h, k) => {
              const prev = hist[k + 1];
              if (!prev) {
                return jlRow(
                  Format.hhmm(h.t),
                  Format.esc(tr('jl.firstReading', { delay: Format.delay(h.delay) })),
                );
              }
              const diff = h.delay - prev.delay;
              if (diff === 0) return '';
              const better = diff < 0;
              return jlRow(
                Format.hhmm(h.t),
                Format.esc(
                  tr(better ? 'jl.regained' : 'jl.lost', {
                    n: Math.abs(Math.round(diff / 60)),
                    delay: Format.delay(h.delay),
                  }),
                ),
                '',
                better ? 'ok' : 'bad',
              );
            })
            .filter(Boolean)
            .join('')
        : jlRow('—', Format.esc(tr('jl.noChange')));

    const source = [
      jlRow(Format.esc(tr('jl.schedules')), Format.esc(tr('jl.schedulesTxt'))),
      jlRow(Format.esc(tr('jl.pastStops')), Format.esc(tr('jl.pastStopsTxt')), '', 'warn'),
      jlRow(
        Format.esc(tr('jl.position')),
        Format.esc(
          tr('jl.positionTxt', {
            kmh: t.position.speedKmh || 0,
            km: Math.max(1, Math.round((t.position.speedKmh || 0) / 60)),
          }),
        ),
        '',
        'warn',
      ),
      t.worstDelay - t.delay >= 300
        ? jlRow(
            Format.esc(tr('jl.goodNews')),
            Format.esc(
              tr('jl.goodNewsTxt', {
                worst: Format.delay(t.worstDelay),
                now: Format.delay(t.delay),
              }),
            ),
            '',
            'ok',
          )
        : '',
    ]
      .filter(Boolean)
      .join('');

    document.getElementById('mpanel-journal')!.innerHTML =
      section(Format.esc(tr('jl.trustTitle')), trust) +
      section(Format.esc(tr('jl.changesTitle')), changes) +
      section(Format.esc(tr('jl.sourceTitle')), source);
  }
}
