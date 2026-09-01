/**
 * Light / dark, and the map basemap that has to follow it.
 *
 * Three states: an explicit choice stamps data-theme on the root, and 'auto'
 * stamps nothing so prefers-color-scheme decides. The palette is defined
 * light-first in CSS with dark redefined in both a media query and a
 * [data-theme] block, which is what lets an explicit choice win in either
 * direction.
 */

import { Prefs } from './Cache.ts';

export type ThemeMode = 'auto' | 'light' | 'dark';

export const MAP_STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
} as const;

type Listener = (isDark: boolean) => void;

export class Theme {
  private readonly listeners = new Set<Listener>();

  get mode(): ThemeMode {
    const t = Prefs.get<string>('theme', 'auto');
    return t === 'dark' || t === 'light' ? t : 'auto';
  }

  private static prefersDark(): boolean {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }

  /** What is actually on screen once 'auto' is resolved. */
  get isDark(): boolean {
    const m = this.mode;
    return m === 'auto' ? Theme.prefersDark() : m === 'dark';
  }

  get mapStyle(): string {
    return this.isDark ? MAP_STYLES.dark : MAP_STYLES.light;
  }

  /** Read a palette token, so map layers match the CSS exactly. */
  static token(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
  }

  onChange(fn: Listener): void {
    this.listeners.add(fn);
  }

  apply(mode: ThemeMode): void {
    Prefs.set('theme', mode);
    const root = document.documentElement;
    if (mode === 'auto') delete root.dataset['theme'];
    else root.dataset['theme'] = mode;

    for (const b of document.querySelectorAll<HTMLElement>('#themeToggle button')) {
      b.setAttribute('aria-pressed', String(b.dataset['themeSet'] === mode));
    }

    // The static media-query <meta theme-color> pair cannot know about an
    // explicit override, so drive the browser chrome directly.
    requestAnimationFrame(() => {
      const bg = Theme.token('bg');
      for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = bg || (this.isDark ? '#0e1116' : '#ffffff');
      document.head.appendChild(meta);
    });

    for (const fn of this.listeners) fn(this.isDark);
  }

  /** Follow the OS only while the user has not chosen explicitly. */
  watchSystem(): void {
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (this.mode === 'auto') for (const fn of this.listeners) fn(this.isDark);
    });
  }
}
