/**
 * A seeded PRNG for tests that need a lot of sample points.
 *
 * Property tests that draw 10,000 random tiles are only useful if a failure is
 * reproducible, so nothing here calls `Math.random`. This is mulberry32, the
 * same algorithm §6 R2 specifies for the simulation — but a private copy: the
 * simulation's stream is authoritative state, and a test must never be able to
 * disturb it.
 */
export function createSeededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded integer in `[min, max]`, inclusive. */
export function seededInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}
