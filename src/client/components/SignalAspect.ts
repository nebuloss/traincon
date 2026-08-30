/**
 * The signal a train is running towards, drawn as the signal it would be.
 *
 * Deduced, not observed, and the interface has to say so. Nothing publishes
 * live signal aspects: this is what French block working implies given how far
 * ahead the next train is, the real distance to the next signal that could
 * stop it, and whether the track is single. That is a sound inference and it
 * is still an inference, so every rendering carries the word "déduit".
 *
 * It used to be a coloured dot, which said "stop" without saying what kind of
 * stop. French practice distinguishes them, and the distinction is the whole
 * point of the signal:
 *
 *   voie libre        one green                       run on
 *   avertissement     one yellow                      be ready to stop at the next
 *   sémaphore         one red, œilleton lit           stop, then pass at caution
 *   carré             two reds, œilleton out          absolute stop, may not be passed
 *
 * So it is drawn as a real signal head: a black target (cible) on a mast, the
 * lit lens or lenses in place, the unlit ones left dark the way they look on
 * the ground. The carré's two reds are shown vertically, the commoner of the
 * two arrangements. The œilleton is the small white light on the mast that
 * marks a signal as passable — extinguished when a carré is closed, which is
 * exactly the difference the icon needs to carry.
 *
 * The drawings are files, in assets/signal, rather than assembled here. They
 * were generated once and the lamp positions were wrong: spaced closer than
 * their own diameter, so consecutive lenses overlapped and the three
 * positions could not be told apart. Artwork can be looked at.
 *
 * Sources: SNCF S 1 A "Signalisation au sol"; the aspect list at
 * modelisme58.fr/outils/feux-sncf-cible; fr.wikipedia.org/wiki/
 * Signalisation_ferroviaire_en_France for the œilleton's meaning.
 */

import libreArt from '../assets/signal/libre.svg?raw';
import avertissementArt from '../assets/signal/avertissement.svg?raw';
import semaphoreArt from '../assets/signal/semaphore.svg?raw';
import carreArt from '../assets/signal/carre.svg?raw';
import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import { signalKey } from '../core/SignalArt.ts';
import type { SignalKey } from '../core/SignalArt.ts';
import type { TrainDTO } from '../../shared/types.ts';

type Aspect = NonNullable<TrainDTO['traffic']>['aspect'];
type Kind = NonNullable<TrainDTO['traffic']>['signalKind'];

/** The drawings, one per aspect — see assets/signal/README. */
const ART: Readonly<Record<SignalKey, string>> = {
  libre: libreArt,
  avertissement: avertissementArt,
  semaphore: semaphoreArt,
  carre: carreArt,
};

/**
 * The signal head for an aspect.
 *
 * `kind` is the signal the train is actually approaching, where the
 * signalling layer knows it. Without it a stop is drawn as a sémaphore, the
 * commoner signal by far on plain line.
 */
export function signalIcon(aspect: Aspect, kind?: Kind): string {
  const key = signalKey(aspect, kind);
  return key ? ART[key] : '';
}

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

/** What to call it: a carré is not a sémaphore, and the difference matters. */
function aspectName(t: TrainDTO): string {
  const x = t.traffic;
  if (!x) return '';
  if (x.aspect === 'semaphore' && x.signalKind === 'carre') return tr('signal.carre');
  return tr(`signal.${x.aspect}`);
}

/** The signal, its name, and the reason — as one block. */
export function aspectBlock(t: TrainDTO): string {
  const x = t.traffic;
  if (!x || x.aspect === 'inconnu') return '';

  const bits: string[] = [];
  if (x.signalM != null) bits.push(tr('signal.next', { m: String(x.signalM) }));
  if (x.allowedKmh != null) bits.push(tr('signal.allowed', { kmh: String(x.allowedKmh) }));

  return `
    <div class="ov-signal">
      ${signalIcon(x.aspect, x.signalKind)}
      <span class="ov-signal-txt">
        <strong>${Format.esc(aspectName(t))}</strong>
        <span class="ov-sub">${Format.esc(aspectReason(t))}</span>
        ${bits.length ? `<span class="ov-sub">${Format.esc(bits.join(' · '))}</span>` : ''}
      </span>
      <span class="deduced" title="${Format.esc(tr('signal.deducedHelp'))}">${Format.esc(
        tr('signal.deduced'),
      )}</span>
    </div>`;
}

/** Just the signal, for the map foot where there is no room for prose. */
export function aspectLamp(t: TrainDTO): string {
  const x = t.traffic;
  if (!x || x.aspect === 'inconnu') return '';
  const label = `${aspectName(t)} — ${aspectReason(t)} (${tr('signal.deduced')})`;
  return `<span class="sig-wrap" title="${Format.esc(label)}" aria-label="${Format.esc(
    label,
  )}" role="img">${signalIcon(x.aspect, x.signalKind)}</span>`;
}
