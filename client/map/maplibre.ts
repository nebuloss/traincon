/**
 * The part of MapLibre this app relies on.
 *
 * The library is loaded from a script tag rather than bundled — it is 800 kB
 * and only one of four tabs needs it — so there are no types to import. This
 * declares the surface actually used, which is a fraction of it, and means a
 * call that MapLibre does not have still fails to compile.
 */

export interface MapLike {
  on(ev: string, fn: () => void): void;
  once(ev: string, fn: () => void): void;
  addControl(c: unknown, pos?: string): void;
  addSource(id: string, src: unknown): void;
  addLayer(layer: unknown, before?: string): void;
  setPaintProperty(layer: string, prop: string, value: unknown): void;
  setLayoutProperty(layer: string, prop: string, value: unknown): void;
  querySourceFeatures(
    source: string,
    opts: { sourceLayer: string },
  ): Array<{
    id?: string | number;
    properties?: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown };
  }>;
  hasImage(id: string): boolean;
  addImage(id: string, image: ImageData, options?: { pixelRatio?: number }): void;
  getSource(id: string): { setData(d: unknown): void } | undefined;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  removeSource(id: string): void;
  setStyle(url: string): void;
  easeTo(o: unknown): void;
  setCenter(c: [number, number]): void;
  getCenter(): { lng: number; lat: number };
  fitBounds(b: unknown, o: unknown): void;
  getZoom(): number;
  project(lngLat: [number, number]): { x: number; y: number };
  isMoving(): boolean;
  getContainer(): HTMLElement;
  resize(): void;
}

export interface MarkerLike {
  setLngLat(c: [number, number]): MarkerLike;
  addTo(m: MapLike): MarkerLike;
  setRotation(d: number): void;
  getElement(): HTMLElement;
  remove(): void;
}

declare const maplibregl: {
  Map: new (o: unknown) => MapLike;
  Marker: new (o: unknown) => MarkerLike;
  NavigationControl: new () => unknown;
};

export const gl = maplibregl;
