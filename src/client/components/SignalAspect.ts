/**
 * The signal a train is running towards, as a lamp.
 *
 * Deduced, not observed, and the interface has to say so. Nothing publishes
 * live signal aspects: this is what French block working implies given how far
 * ahead the next train is, the real distance to the next signal that could
 * stop it, and whether the track is single. That is a sound inference and it
 * is still an inference, so every rendering carries the word.
 *
 * Drawn as the lamp rather than as a word because that is what the aspect is,
 * and a coloured dot is read faster than a sentence — but it is deliberately
 * small and paired with its name, so it cannot be mistaken for a live feed of
 * the signal itself.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import type { TrainDTO } from '../../shared/types.ts';

type Aspect = NonNullable<TrainDTO['traffic']>['aspect'];

/** Lamp colour for each aspect, following French practice. */
const LAMP: Readonly<Record<Aspect, string>> = {
  libre: 'green',
  avertissement: 'yellow',
  semaphore: 'red',
  inconnu: 'dark',
};

/** Whether this aspect is worth showing at all. */
export function hasAspect(t: TrainDTO): boolean {
  return Boolean(t.traffic && t.traffic.aspect !== 'inconnu');
}

/**
 * One line describing why the signal reads as it does.
 *
 * The reason is the point: "sémaphore" alone tells a reader nothing, whereas
 * "the train 900 m ahead is in the section" explains the whole thing.
 */
export function aspectReason(t: TrainDTO): string {
  const x = t.traffic;
  if (!x) return '';

  if (x.opposing && x.ahead) {
    return tr('signal.opposing', { n: x.ahead, m: String(x.gapM ?? 0) });
  }
  if (x.ahead && x.gapM != null) {
    return tr('signal.following', { n: x.ahead, m: String(x.gapM) });
  }
  return tr('signal.clear');
}

/** The lamp, its name, and the reason — as one block. */
export function aspectBlock(t: TrainDTO): string {
  const x = t.traffic;
  if (!x || x.aspect === 'inconnu') return '';

  const bits: string[] = [];
  if (x.signalM != null) bits.push(tr('signal.next', { m: String(x.signalM) }));
  if (x.allowedKmh != null) bits.push(tr('signal.allowed', { kmh: String(x.allowedKmh) }));

  return `
    <div class="ov-signal">
      <span class="lamp ${LAMP[x.aspect]}" aria-hidden="true"></span>
      <span class="ov-signal-txt">
        <strong>${Format.esc(tr(`signal.${x.aspect}`))}</strong>
        <span class="ov-sub">${Format.esc(aspectReason(t))}</span>
        ${bits.length ? `<span class="ov-sub">${Format.esc(bits.join(' · '))}</span>` : ''}
      </span>
      <span class="deduced" title="${Format.esc(tr('signal.deducedHelp'))}">${Format.esc(
        tr('signal.deduced'),
      )}</span>
    </div>`;
}

/** Just the lamp, for the map foot where there is no room for prose. */
export function aspectLamp(t: TrainDTO): string {
  const x = t.traffic;
  if (!x || x.aspect === 'inconnu') return '';
  const label = `${tr(`signal.${x.aspect}`)} — ${aspectReason(t)} (${tr('signal.deduced')})`;
  return `<span class="lamp ${LAMP[x.aspect]}" title="${Format.esc(label)}" aria-label="${Format.esc(
    label,
  )}"></span>`;
}
