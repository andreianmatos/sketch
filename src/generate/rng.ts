/** Seeded RNG so a passage seed is stable. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    this.s = (Math.imul(1664525, this.s) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  uniform(a = 0, b = 1): number {
    return a + (b - a) * this.next();
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  gauss(mean = 0, std = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + z * std;
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  choice<T>(arr: T[], weights?: number[]): T {
    if (!weights || weights.length !== arr.length) return this.pick(arr);
    let sum = 0;
    for (const w of weights) sum += Math.max(0, w);
    let x = this.next() * sum;
    for (let i = 0; i < arr.length; i++) {
      x -= Math.max(0, weights[i]!);
      if (x <= 0) return arr[i]!;
    }
    return arr[arr.length - 1]!;
  }
  clip(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
  }
}
