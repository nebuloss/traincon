/**
 * The two figures shown over the map: how fast, and what is ahead.
 *
 * Both are written straight into elements the page already holds, so neither
 * touches the map itself. Kept out of the view for that reason — they are the
 * only part of it that would work with no map at all.
 */

import { tr } from '../app/I18n.ts';
import { aspectLamp } from '../signals/signal-aspect.ts';
import type { TrainDTO } from '../types.ts';

/**
 * Current speed, and what the line permits here.
 *
 * The limit is a property of the track rather than of the train, so it is
 * drawn as the roundel it is on the ground rather than as more text — and
 * hidden entirely where the geometry cannot say, rather than guessed at.
 */
export function showSpeed(kmh: number, limitKmh: number | null | undefined): void {
  const speed = document.getElementById('mapSpeed');
  if (speed) {
    speed.textContent = kmh ? tr('map.speed', { kmh: String(Math.round(kmh)) }) : tr('map.stopped');
    speed.classList.toggle('is-stopped', !kmh);
  }

  const limit = document.getElementById('mapLimit');
  if (!limit) return;
  if (limitKmh == null || limitKmh <= 0) {
    limit.hidden = true;
    return;
  }
  limit.hidden = false;
  limit.textContent = String(Math.round(limitKmh));
  limit.title = tr('map.limit', { kmh: String(Math.round(limitKmh)) });
  // Marked when the train is at or near what the line allows, which is the
  // interesting case: it is going as fast as it is permitted to.
  limit.classList.toggle('at-limit', kmh >= limitKmh * 0.95);
}

/** The deduced signal aspect, beside the speed. */
export function showAspect(t: TrainDTO): void {
  const el = document.getElementById('mapAspect');
  if (!el) return;
  const lamp = aspectLamp(t);
  el.innerHTML = lamp;
  el.hidden = !lamp;
}
