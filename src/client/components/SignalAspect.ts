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
 * Sources: SNCF S 1 A "Signalisation au sol"; the aspect list at
 * modelisme58.fr/outils/feux-sncf-cible; fr.wikipedia.org/wiki/
 * Signalisation_ferroviaire_en_France for the œilleton's meaning.
 */

import { Format } from '../core/Format.ts';
import { tr } from '../core/I18n.ts';
import type { TrainDTO } from '../../shared/types.ts';

type Aspect = NonNullable<TrainDTO['traffic']>['aspect'];
type Kind = NonNullable<TrainDTO['traffic']>['signalKind'];

/** Lens colours, as a signal actually burns rather than as a UI palette. */
const LENS = {
  green: '#22c55e',
  yellow: '#f2c009',
  red: '#ef2f2f',
  white: '#f4f6fa',
  /** An unlit lens: dark, but not the black of the target behind it. */
  out: '#252a33',
};

/**
 * Unique per rendering, because the glow is clipped to the target and a
 * clipPath needs an id. Two of these can be on the page at once — the
 * overview and the map foot — and repeated ids would cross-reference.
 */
let seq = 0;

/** The three lamp positions on the simplified target, top to bottom. */
const ROW = { top: 9, mid: 14.5, bottom: 20 };

/** One lens, with the halo a lit lamp throws. */
function lens(cy: number, colour: string, lit: boolean, r = 4.4): string {
  if (!lit) {
    return `<circle cx="13" cy="${cy}" r="${r}" fill="${LENS.out}" stroke="#0b0d11" stroke-width="1"/>`;
  }
  return (
    `<circle cx="13" cy="${cy}" r="${r * 1.85}" fill="${colour}" opacity=".22"/>` +
    `<circle cx="13" cy="${cy}" r="${r}" fill="${colour}" stroke="#0b0d11" stroke-width=".8"/>` +
    // A brighter spot, so the lens reads as glass with a lamp behind it.
    `<circle cx="${13 - r * 0.3}" cy="${cy - r * 0.3}" r="${r * 0.3}" fill="#fff" opacity=".5"/>`
  );
}

/**
 * The signal head for an aspect.
 *
 * `kind` is the signal the train is actually approaching, where the
 * signalling layer knows it. Without it a stop is drawn as a sémaphore, the
 * commoner signal by far on plain line — but the œilleton is then left out
 * rather than guessed at, since it is the thing that distinguishes them.
 */
export function signalIcon(aspect: Aspect, kind?: Kind): string {
  const carre = aspect === 'semaphore' && kind === 'carre';
  const stop = aspect === 'semaphore';

  const lamps = carre
    ? lens(ROW.top, LENS.red, true) + lens(ROW.mid, LENS.out, false) + lens(ROW.bottom, LENS.red, true)
    : lens(ROW.top, LENS.out, false) +
      lens(
        ROW.mid,
        aspect === 'libre' ? LENS.green : aspect === 'avertissement' ? LENS.yellow : LENS.red,
        aspect !== 'inconnu',
      ) +
      lens(ROW.bottom, LENS.out, false);

  // Lit on a sémaphore, out on a carré, absent when the kind is unknown —
  // which is the honest reading, since it is the mark of permissiveness.
  const oeilleton =
    stop && kind
      ? `<circle cx="20.4" cy="30" r="1.9" fill="${carre ? LENS.out : LENS.white}" stroke="#0b0d11" stroke-width=".7"/>`
      : '';

  // The glow is clipped to the target: a lens throws its light forward, and
  // left unclipped the bottom lamp's halo washes down over the mast.
  const clip = `sig-cible-${++seq}`;

  return `
    <svg class="sig" viewBox="0 0 26 40" width="26" height="40" aria-hidden="true" focusable="false">
      <defs><clipPath id="${clip}"><rect x="3" y="1" width="20" height="25" rx="4"/></clipPath></defs>
      <rect x="9.5" y="33.5" width="7" height="2.6" rx="1" fill="#4a525e"/>
      <rect x="11.4" y="25" width="3.2" height="9" fill="#5b6472"/>
      ${oeilleton}
      <rect x="3" y="1" width="20" height="25" rx="4" fill="#14171d" stroke="#39414d" stroke-width="1.2"/>
      <g clip-path="url(#${clip})">${lamps}</g>
    </svg>`;
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
