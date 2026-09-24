/**
 * Deterministic, injectable RNG. xoshiro128** seeded through splitmix32.
 * All stochastic behaviour (bandits, exploration, simulation, Thompson
 * sampling) must receive an Rng instance explicitly — no hidden globals.
 */
export interface Rng {
  /** Uniform [0,1). */
  next(): number;
  int(maxExclusive: number): number;
  /** Standard normal via Box-Muller (cached second value). */
  normal(): number;
  gamma(shape: number, scale?: number): number;
  beta(a: number, b: number): number;
  exponential(rate: number): number;
  pick<T>(values: readonly T[]): T;
  bool(p: number): boolean;
  /** Deterministic fork for parallel deterministic sub-streams. */
  fork(salt: number): Rng;
  readonly seed: number;
}

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function createRng(seed = 0x5eed_1234): Rng {
  const next32 = splitmix32(seed);
  let s0 = next32();
  let s1 = next32();
  let s2 = next32();
  let s3 = next32();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

  const nextUint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7) >>> 0, 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result >>> 0;
  };

  let spareNormal: number | null = null;

  const rng: Rng = {
    seed,
    next(): number {
      return nextUint32() / 4294967296;
    },
    int(maxExclusive: number): number {
      if (maxExclusive <= 1) return 0;
      return Math.min(maxExclusive - 1, Math.floor(rng.next() * maxExclusive));
    },
    normal(): number {
      if (spareNormal !== null) {
        const value = spareNormal;
        spareNormal = null;
        return value;
      }
      let u = 0;
      let v = 0;
      while (u <= 1e-12) u = rng.next();
      v = rng.next();
      const mag = Math.sqrt(-2 * Math.log(u));
      spareNormal = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    },
    exponential(rate: number): number {
      const r = rate <= 0 ? 1 : rate;
      let u = 0;
      while (u <= 1e-12) u = rng.next();
      return -Math.log(u) / r;
    },
    gamma(shape: number, scale = 1): number {
      const a = shape <= 0 ? 1e-3 : shape;
      if (a < 1) {
        // Johnk / boosting: Gamma(a) = Gamma(a+1) * U^(1/a)
        const u = Math.max(rng.next(), 1e-12);
        return rng.gamma(a + 1, scale) * Math.pow(u, 1 / a);
      }
      // Marsaglia-Tsang
      const d = a - 1 / 3;
      const c = 1 / Math.sqrt(9 * d);
      for (let i = 0; i < 10_000; i += 1) {
        const x = rng.normal();
        const vv = 1 + c * x;
        if (vv <= 0) continue;
        const v = vv * vv * vv;
        const u = rng.next();
        if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
      }
      return d * scale;
    },
    beta(a: number, b: number): number {
      const aa = a <= 0 ? 1e-3 : a;
      const bb = b <= 0 ? 1e-3 : b;
      const x = rng.gamma(aa, 1);
      const y = rng.gamma(bb, 1);
      const denom = x + y;
      if (denom <= 0) return 0.5;
      return x / denom;
    },
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) throw new Error('cannot pick from an empty array');
      const index = rng.int(values.length);
      const value = values[index];
      if (value === undefined) throw new Error('pick out of range');
      return value;
    },
    bool(p: number): boolean {
      return rng.next() < p;
    },
    fork(salt: number): Rng {
      return createRng((seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0);
    },
  };
  return rng;
}

export function fisherYates<T>(values: readonly T[], rng: Rng): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
