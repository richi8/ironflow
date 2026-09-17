import { describe, expect, it } from 'vitest';

import { NoiseField, hash2, hash3, mix32, unitFloat } from '../../src/game/world/noise.js';
import { createSeededRandom, seededInt } from '../fixtures/seeded-random.js';

/**
 * C19's arithmetic floor. See ironflow.md C19 task 2 and §6 R2.
 *
 * Everything the generator does rests on two claims about this file: that a
 * point's value depends only on the seed and the point, and that the values
 * are spread out enough for a threshold to mean something. Both are cheap to
 * check here and expensive to debug two layers up, where a weak hash looks
 * like "the map has diagonal stripes in it" and a leaky cache looks like "the
 * world changed when I walked away".
 */

describe('mix32', () => {
  it('avalanches: one flipped input bit changes about half the output bits', () => {
    // The property the whole file rests on. Neighbouring lattice corners differ
    // by one, so a mixer that passed low bits through would make adjacent
    // tiles correlated — visible as banding rather than as terrain.
    let total = 0;
    let samples = 0;
    for (let value = 0; value < 512; value++) {
      for (let bit = 0; bit < 32; bit++) {
        const changed = popcount(mix32(value) ^ mix32(value ^ (1 << bit)));
        total += changed;
        samples += 1;
      }
    }
    expect(total / samples).toBeGreaterThan(14);
    expect(total / samples).toBeLessThan(18);
  });

  it('returns an unsigned 32-bit integer for any input, negatives included', () => {
    for (const value of [0, 1, -1, 2 ** 31, -(2 ** 31), 0x7fffffff, -123456789]) {
      const hash = mix32(value);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });
});

describe('hash2 and hash3', () => {
  it('depend on every argument, so no two of them can be swapped', () => {
    expect(hash2(1, 2, 3)).not.toBe(hash2(2, 1, 3));
    expect(hash2(1, 2, 3)).not.toBe(hash2(1, 3, 2));
    expect(hash3(1, 2, 3, 4)).not.toBe(hash3(1, 2, 4, 3));
    expect(hash3(5, 0, 0, 1)).not.toBe(hash3(5, 0, 0, 2));
  });

  it('is the same function on every call, which is the whole of §6 R2', () => {
    expect(hash2(7, -3, 11)).toBe(hash2(7, -3, 11));
    expect(hash3(7, -3, 11, 2)).toBe(hash3(7, -3, 11, 2));
  });

  it('spreads a run of adjacent coordinates evenly over the unit interval', () => {
    // Sixteen buckets over 4,096 adjacent lattice points. A hash with visible
    // structure in its low bits fails this before it fails anything visual.
    const buckets = new Array<number>(16).fill(0);
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        const bucket = Math.min(15, Math.floor(unitFloat(hash2(0x1234, x, y)) * 16));
        buckets[bucket] = (buckets[bucket] ?? 0) + 1;
      }
    }
    // 256 expected per bucket; ±35% is loose enough not to be flaky and tight
    // enough to catch a hash that is merely shuffling the input.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(166);
      expect(count).toBeLessThan(346);
    }
  });
});

describe('NoiseField', () => {
  const field = (): NoiseField => new NoiseField(0xbeef, { frequency: 1 / 32, octaves: 3 });

  it('stays inside [0, 1] over a wide sweep', () => {
    const noise = field();
    for (let x = -2000; x <= 2000; x += 7) {
      for (let y = -300; y <= 300; y += 11) {
        const value = noise.sample(x, y);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives the same value however many points were sampled first', () => {
    // The memo is the only state in the file, and this is the claim that makes
    // it legitimate: a hit and a miss must return the same number. Sampling in
    // a shuffled order is what a world explored in an unusual order does.
    const reference = field();
    const shuffled = field();
    const random = createSeededRandom(99);

    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < 400; i++) {
      points.push({ x: seededInt(random, -500, 500), y: seededInt(random, -500, 500) });
    }

    const expected = points.map((p) => reference.sample(p.x, p.y));
    for (let i = points.length - 1; i > 0; i--) {
      const j = seededInt(random, 0, i);
      const a = points[i];
      const b = points[j];
      if (a === undefined || b === undefined) continue;
      points[i] = b;
      points[j] = a;
      const swap = expected[i];
      expected[i] = expected[j] as number;
      expected[j] = swap as number;
    }

    points.forEach((p, i) => {
      expect(shuffled.sample(p.x, p.y)).toBe(expected[i]);
    });
  });

  it('gives two seeds genuinely different fields', () => {
    const a = new NoiseField(1, { frequency: 1 / 32, octaves: 3 });
    const b = new NoiseField(2, { frequency: 1 / 32, octaves: 3 });
    let differences = 0;
    for (let i = 0; i < 200; i++) {
      if (Math.abs(a.sample(i * 3, i) - b.sample(i * 3, i)) > 1e-9) differences += 1;
    }
    expect(differences).toBe(200);
  });

  it('is continuous: neighbouring tiles differ by far less than the range', () => {
    // If this fails the map is static rather than terrain — and the failure is
    // not otherwise visible until a whole chunk is drawn.
    const noise = field();
    let worst = 0;
    for (let x = -200; x < 200; x++) {
      worst = Math.max(worst, Math.abs(noise.sample(x, 0) - noise.sample(x + 1, 0)));
    }
    expect(worst).toBeLessThan(0.25);
  });

  it('does not treat the origin as a special point', () => {
    // Tile (0, 0) sits on a lattice corner of every octave, so an unoffset
    // field returns a raw uninterpolated hash there — uniformly distributed
    // where every other tile is the bell-shaped average of four. That made a
    // third of all seeds spawn the player in water. The distribution of
    // `sample(0, 0)` across seeds must look like the distribution anywhere
    // else, so almost none of it should be in the outer tenths.
    let extremes = 0;
    for (let seed = 0; seed < 400; seed++) {
      const value = new NoiseField(seed, { frequency: 1 / 96, octaves: 3 }).sample(0, 0);
      if (value < 0.1 || value > 0.9) extremes += 1;
    }
    expect(extremes).toBeLessThan(40);
  });

  it('refuses a frequency or an octave count it cannot honour', () => {
    expect(() => new NoiseField(1, { frequency: 1 / 32, octaves: 0 })).toThrow(RangeError);
    expect(() => new NoiseField(1, { frequency: 1 / 32, octaves: 1.5 })).toThrow(RangeError);
    expect(() => new NoiseField(1, { frequency: 0, octaves: 2 })).toThrow(RangeError);
    expect(() => new NoiseField(1, { frequency: Number.NaN, octaves: 2 })).toThrow(RangeError);
  });
});

/** Bits set in a 32-bit word. */
function popcount(value: number): number {
  let v = value >>> 0;
  let count = 0;
  while (v !== 0) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}
