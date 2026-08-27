/** Binary min-heap keyed on the first tuple element. Used by Dijkstra. */
export class MinHeap<T> {
  private readonly items: Array<[number, T]> = [];

  get size(): number {
    return this.items.length;
  }

  push(priority: number, value: T): void {
    const a = this.items;
    a.push([priority, value]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }

  pop(): [number, T] | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l]![0] < a[s]![0]) s = l;
        if (r < a.length && a[r]![0] < a[s]![0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i]!, a[s]!];
        i = s;
      }
    }
    return top;
  }
}
