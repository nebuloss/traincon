/**
 * The vehicle artwork, tinted and handed to the map.
 *
 * The drawings live in `assets/train` as ordinary SVG files — see the README
 * there — with `{{band}}` and `{{body}}` standing in for the livery. This
 * substitutes the two colours, rasterises the result and registers it with
 * MapLibre under `role|livery`, which is the name the symbol layer asks for.
 *
 * Rasterised rather than used as SVG directly because MapLibre's image
 * registry takes pixels. Done once per role and livery and then kept: a train
 * keeps its livery, and there are only a handful of liveries in service.
 *
 * The artwork is drawn in decimetres — a 26.4 m coach is 264 units long — so
 * a vehicle's true length is its viewBox width over ten, and one CSS pixel of
 * the registered image is one decimetre of real vehicle. That makes the scale
 * factor the same for every vehicle on the map: see `iconScale`.
 */

import powerCar from '../assets/train/power-car.svg?raw';
import coachArtic from '../assets/train/coach-artic.svg?raw';
import loco from '../assets/train/loco.svg?raw';
import coach from '../assets/train/coach.svg?raw';
import emuCab from '../assets/train/emu-cab.svg?raw';
import emuMid from '../assets/train/emu-mid.svg?raw';
import { LIVERY } from '../components/TrainIcon.ts';
import type { LiveryKey } from '../components/TrainIcon.ts';
import type { VehicleRole } from '../../shared/types.ts';

/** The drawing for each kind of vehicle. */
export const ART: Readonly<Record<VehicleRole, string>> = {
  power: powerCar,
  artic: coachArtic,
  loco,
  coach,
  'emu-cab': emuCab,
  'emu-mid': emuMid,
};

/** Drawn at twice the nominal size, so it stays sharp on a dense screen. */
const RASTER = 2;

/**
 * How much wider than life a vehicle is drawn.
 *
 * A rail vehicle is 2.9 m across against a 26 m coach: at true proportions,
 * by the time the coach is long enough to recognise the body is two pixels
 * wide. Length is the dimension that carries meaning here — whether the train
 * reaches the end of the platform, whether two of them fit in a block — so
 * length stays honest and the width is doubled. Roads on this map are drawn
 * far wider than scale for the same reason.
 */
const FATTEN = 2;

/** The map's image registry, as much of it as is needed here. */
interface ImageHost {
  hasImage(id: string): boolean;
  addImage(id: string, image: ImageData, options?: { pixelRatio?: number }): void;
}

/** The viewBox, as [width, height] in the artwork's own units. */
export function artSize(svg: string): [number, number] {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!m) throw new Error('artwork has no viewBox');
  return [Number(m[1]), Number(m[2])];
}

/** A vehicle's real length in metres, read off its drawing. */
export function artLengthM(role: VehicleRole): number {
  return artSize(ART[role])[0] / 10;
}

/**
 * How big to draw the icons at this scale.
 *
 * One artwork unit is a decimetre of real vehicle, and the registered image
 * is one CSS pixel per unit, so the factor is the same for every vehicle —
 * which is why the layer can carry a single icon-size rather than one per
 * feature.
 */
export function iconScale(metresPerPixel: number): number {
  return 1 / (10 * metresPerPixel);
}

/** Paint one drawing in a livery's colours. */
export function tint(svg: string, band: string, body: string): string {
  return svg.replaceAll('{{band}}', band).replaceAll('{{body}}', body);
}

/** Turn an SVG string into pixels at the given size. */
async function rasterise(svg: string, w: number, h: number): Promise<ImageData | null> {
  // Firefox will not rasterise an SVG that carries only a viewBox, so the
  // intrinsic size is written in before it becomes an image.
  const sized = svg.replace('<svg ', `<svg width="${w}" height="${h}" `);
  const img = new Image(w, h);
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** The id a symbol layer uses for one vehicle in one livery. */
export const iconId = (role: VehicleRole, livery: string): string => `${role}|${livery}`;

/**
 * Make sure every vehicle exists in this livery, and say whether it now does.
 *
 * Cheap to call repeatedly: it checks the registry first, so after the first
 * train of a given livery this does nothing.
 */
export async function ensureLivery(map: ImageHost, key: LiveryKey): Promise<boolean> {
  const livery = LIVERY[key] ?? LIVERY.other;
  let ok = true;
  for (const role of Object.keys(ART) as VehicleRole[]) {
    const id = iconId(role, key);
    if (map.hasImage(id)) continue;
    const [w, h] = artSize(ART[role]);
    const pixels = await rasterise(
      tint(ART[role], livery.band, livery.body),
      w * RASTER,
      Math.round(h * RASTER * FATTEN),
    );
    if (!pixels) {
      ok = false;
      continue;
    }
    map.addImage(id, pixels, { pixelRatio: RASTER });
  }
  return ok;
}
