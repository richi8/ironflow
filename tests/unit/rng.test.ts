import { describe, expect, it } from 'vitest';

import { Rng, createRng, toUint32 } from '../../src/game/rng.js';

/**
 * The seeded PRNG. See ironflow.md §6 R2 and C18 task 1.
 *
 * Three things have to be true of it, and only the third is about randomness:
 *
 * 1. **the same seed gives the same stream**, for ever and on every machine;
 * 2. **the stream position round-trips**, because §6 R2 calls it authoritative
 *    state and C24 will write it into a save;
 * 3. it is uniform enough for worldgen, which is a low bar deliberately — see
 *    the file header on why mulberry32 rather than something stronger.
 */

describe('the seeded stream', () => {
  it('gives the same numbers for the same seed, every time', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const first = Array.from({ length: 50 }, () => a.next());
    const second = Array.from({ length: 50 }, () => b.next());
    expect(second).toEqual(first);
  });

  it('gives different numbers for different seeds', () => {
    const a = Array.from({ length: 20 }, ((rng) => () => rng.next())(new Rng(1)));
    const b = Array.from({ length: 20 }, ((rng) => () => rng.next())(new Rng(2)));
    expect(b).not.toEqual(a);
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(0xabcdef);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is roughly uniform, which is all worldgen asks of it', () => {
    const rng = new Rng(7);
    const buckets = new Array<number>(10).fill(0);
    const draws = 100_000;
    for (let i = 0; i < draws; i++) {
      const bucket = Math.floor(rng.next() * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    // Within 5% of a tenth each. A generator that failed this would be
    // producing visibly striped terrain, which is the failure that matters.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(draws * 0.095);
      expect(count).toBeLessThan(draws * 0.105);
    }
  });
});

describe('the stream position is state', () => {
  it('is a whole number that survives JSON and structuredClone', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 17; i++) rng.next();

    const state = rng.state;
    expect(Number.isInteger(state)).toBe(true);
    expect(state).toBeGreaterThanOrEqual(0);
    expect(state).toBeLessThan(2 ** 32);
    expect(JSON.parse(JSON.stringify({ state }))).toEqual({ state });
    expect(structuredClone({ state })).toEqual({ state });
  });

  it('resumes exactly where it was saved', () => {
    const live = new Rng(4242);
    for (let i = 0; i < 100; i++) live.next();

    // What a save writes and a load reads back (§6 R2).
    const resumed = Rng.fromState(live.state);

    const expected = Array.from({ length: 25 }, () => live.next());
    const actual = Array.from({ length: 25 }, () => resumed.next());
    expect(actual).toEqual(expected);
  });

  it('moves on every draw, so a saved position is never stale', () => {
    const rng = new Rng(1);
    const before = rng.state;
    rng.next();
    expect(rng.state).not.toBe(before);
  });
});

describe('seeds and bounds', () => {
  it('normalises a seed to 32 bits rather than producing NaN for ever', () => {
    expect(toUint32(5.9)).toBe(5);
    expect(toUint32(-1)).toBe(0xffffffff);
    expect(toUint32(2 ** 32 + 7)).toBe(7);
    expect(Number.isFinite(new Rng(-3.7).next())).toBe(true);
  });

  it('refuses a seed that is not a number, instead of quietly becoming zero', () => {
    // `>>> 0` turns both of these into 0 without complaint, which is how two
    // different worlds end up sharing a seed (§6 R7).
    expect(() => toUint32(Number.NaN)).toThrow(/finite/);
    expect(() => toUint32(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it('gives whole numbers under a bound, and refuses a bound that is not one', () => {
    const rng = new Rng(11);
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 6_000; i++) {
      const roll = rng.nextInt(6);
      expect(Number.isInteger(roll)).toBe(true);
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(6);
      counts[roll] = (counts[roll] ?? 0) + 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(800);

    expect(() => rng.nextInt(0)).toThrow(/positive integer/);
    expect(() => rng.nextInt(2.5)).toThrow(/positive integer/);
  });

  it('exposes §6s createRng over the same implementation', () => {
    const next = createRng(2024);
    const rng = new Rng(2024);
    expect([next(), next(), next()]).toEqual([rng.next(), rng.next(), rng.next()]);
  });
});
