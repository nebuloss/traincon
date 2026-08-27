/**
 * The saved train list.
 *
 * A coupled set is one train to the user, so a single star adds or removes
 * every number it runs under.
 */

import { Prefs } from './Cache.ts';

type Listener = () => void;

export class Bookmarks {
  private numbers: string[];
  private readonly listeners = new Set<Listener>();

  constructor() {
    this.numbers = Bookmarks.migrate(Prefs.get<unknown>('watch', []));
  }

  /** Earlier versions stored [{number, stopId}]; keep those bookmarks. */
  private static migrate(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const nums = v
      .map((x) => (typeof x === 'string' ? x : (x as { number?: string })?.number))
      .filter((x): x is string => Boolean(x));
    return [...new Set(nums.map(String))];
  }

  get all(): readonly string[] {
    return this.numbers;
  }
  get count(): number {
    return this.numbers.length;
  }
  has(n: string): boolean {
    return this.numbers.includes(String(n));
  }

  onChange(fn: Listener): void {
    this.listeners.add(fn);
  }
  private emit(): void {
    Prefs.set('watch', this.numbers);
    for (const fn of this.listeners) fn();
  }

  /**
   * Toggle one or several numbers together.
   * Returns what happened so the caller can word the confirmation.
   */
  toggle(spec: string): { added: boolean; numbers: string[] } | null {
    const nums = String(spec)
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    if (!nums.length || nums.some((n) => !/^\d{1,6}$/.test(n))) return null;

    const on = nums.some((n) => this.has(n));
    if (on) this.numbers = this.numbers.filter((n) => !nums.includes(n));
    else for (const n of nums) if (!this.has(n)) this.numbers.push(n);

    this.emit();
    return { added: !on, numbers: nums };
  }

  remove(n: string): void {
    this.numbers = this.numbers.filter((x) => x !== n);
    this.emit();
  }
}
