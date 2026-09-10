import { describe, expect, it } from 'vitest';

import {
  DIRECTION_OFFSETS,
  EAST,
  NORTH,
  SOUTH,
  TILE_MAX,
  TILE_MIN,
  WEST,
  manhattan,
  rotateOffset,
  tileKey,
  type Rotation,
  type TileCoord,
} from '../../src/game/world/coordinates.js';
import { createSeededRandom, seededInt } from '../fixtures/seeded-random.js';

const ROTATIONS: readonly Rotation[] = [NORTH, EAST, SOUTH, WEST];

describe('DIRECTION_OFFSETS', () => {
  it('steps one tile in each compass direction, with +Y down', () => {
    expect(DIRECTION_OFFSETS[NORTH]).toEqual({ x: 0, y: -1 });
    expect(DIRECTION_OFFSETS[EAST]).toEqual({ x: 1, y: 0 });
    expect(DIRECTION_OFFSETS[SOUTH]).toEqual({ x: 0, y: 1 });
    expect(DIRECTION_OFFSETS[WEST]).toEqual({ x: -1, y: 0 });
  });

  it('is frozen, so a belt system cannot mutate the shared table', () => {
    expect(Object.isFrozen(DIRECTION_OFFSETS)).toBe(true);
    expect(DIRECTION_OFFSETS.every((o) => Object.isFrozen(o))).toBe(true);
  });

  it('agrees with rotateOffset, which is what stops the two drifting apart', () => {
    for (const r of ROTATIONS) {
      expect(rotateOffset(DIRECTION_OFFSETS[NORTH] as TileCoord, r)).toEqual(DIRECTION_OFFSETS[r]);
    }
  });
});

describe('rotateOffset', () => {
  it('turns clockwise: N -> E -> S -> W', () => {
    expect(rotateOffset({ x: 0, y: -1 }, EAST)).toEqual({ x: 1, y: 0 });
    expect(rotateOffset({ x: 1, y: 0 }, EAST)).toEqual({ x: 0, y: 1 });
    expect(rotateOffset({ x: 0, y: 1 }, EAST)).toEqual({ x: -1, y: 0 });
    expect(rotateOffset({ x: -1, y: 0 }, EAST)).toEqual({ x: 0, y: -1 });
  });

  it('leaves an offset alone at rotation 0', () => {
    expect(rotateOffset({ x: 3, y: -7 }, NORTH)).toEqual({ x: 3, y: -7 });
  });

  it('returns to the original after four quarter-turns', () => {
    const random = createSeededRandom(0x5eed);
    for (let i = 0; i < 500; i++) {
      const start: TileCoord = { x: seededInt(random, -50, 50), y: seededInt(random, -50, 50) };
      let turned = start;
      for (let q = 0; q < 4; q++) turned = rotateOffset(turned, EAST);
      expect(turned).toEqual(start);
    }
  });

  it('composes: one turn twice equals two turns', () => {
    const offset: TileCoord = { x: 2, y: 5 };
    expect(rotateOffset(rotateOffset(offset, EAST), EAST)).toEqual(rotateOffset(offset, SOUTH));
    expect(rotateOffset(rotateOffset(offset, SOUTH), EAST)).toEqual(rotateOffset(offset, WEST));
  });

  it('preserves distance from the origin, so footprints keep their size', () => {
    const origin: TileCoord = { x: 0, y: 0 };
    const offset: TileCoord = { x: 4, y: -2 };
    for (const r of ROTATIONS) {
      expect(manhattan(rotateOffset(offset, r), origin)).toBe(manhattan(offset, origin));
    }
  });

  it('produces exact integers, never a sin/cos remainder', () => {
    for (const r of ROTATIONS) {
      const turned = rotateOffset({ x: 7, y: -9 }, r);
      expect(Number.isInteger(turned.x)).toBe(true);
      expect(Number.isInteger(turned.y)).toBe(true);
    }
  });
});

describe('manhattan', () => {
  it('counts grid steps, with no diagonals', () => {
    expect(manhattan({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7);
    expect(manhattan({ x: -2, y: -3 }, { x: 1, y: 2 })).toBe(8);
    expect(manhattan({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });

  it('is symmetric', () => {
    const random = createSeededRandom(7);
    for (let i = 0; i < 200; i++) {
      const a: TileCoord = { x: seededInt(random, -999, 999), y: seededInt(random, -999, 999) };
      const b: TileCoord = { x: seededInt(random, -999, 999), y: seededInt(random, -999, 999) };
      expect(manhattan(a, b)).toBe(manhattan(b, a));
    }
  });
});

describe('tileKey', () => {
  it('is injective over a dense block spanning the origin', () => {
    const keys = new Set<number>();
    let count = 0;
    for (let x = -64; x <= 64; x++) {
      for (let y = -64; y <= 64; y++) {
        keys.add(tileKey(x, y));
        count++;
      }
    }
    expect(keys.size).toBe(count);
  });

  it('is injective in every corner of the documented range', () => {
    const keys = new Set<number>();
    let count = 0;
    for (const baseX of [TILE_MIN, TILE_MAX - 8]) {
      for (const baseY of [TILE_MIN, TILE_MAX - 8]) {
        for (let dx = 0; dx <= 8; dx++) {
          for (let dy = 0; dy <= 8; dy++) {
            keys.add(tileKey(baseX + dx, baseY + dy));
            count++;
          }
        }
      }
    }
    expect(keys.size).toBe(count);
  });

  it('is injective over 100,000 coordinates drawn from the whole range', () => {
    const random = createSeededRandom(0xc0ffee);
    const seen = new Map<number, string>();
    for (let i = 0; i < 100_000; i++) {
      const x = seededInt(random, TILE_MIN, TILE_MAX);
      const y = seededInt(random, TILE_MIN, TILE_MAX);
      const key = tileKey(x, y);
      const label = `${x},${y}`;
      const previous = seen.get(key);
      if (previous !== undefined && previous !== label) {
        throw new Error(`tileKey collision: ${previous} and ${label} both produced ${key}`);
      }
      seen.set(key, label);
    }
    expect(seen.size).toBeGreaterThan(99_000);
  });

  it('does not confuse a coordinate with its mirror', () => {
    // The classic packing bug: sign handled by a bare shift, so (-1, 0) and
    // (0, -1) — or (1, 2) and (2, 1) — land on the same key.
    const pairs: readonly (readonly [number, number])[] = [
      [-1, 0],
      [0, -1],
      [1, 2],
      [2, 1],
      [-1, -2],
      [-2, -1],
      [32767, -32768],
      [-32768, 32767],
    ];
    const keys = pairs.map(([x, y]) => tileKey(x, y));
    expect(new Set(keys).size).toBe(pairs.length);
  });

  it('stays inside int32, so keys are small integers rather than doubles', () => {
    for (const [x, y] of [
      [TILE_MIN, TILE_MIN],
      [TILE_MAX, TILE_MAX],
      [TILE_MIN, TILE_MAX],
      [0, 0],
    ] as const) {
      const key = tileKey(x, y);
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-2_147_483_648);
      expect(key).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it('is pure', () => {
    expect(tileKey(12, -34)).toBe(tileKey(12, -34));
  });

  it('rejects coordinates outside the documented range', () => {
    expect(() => tileKey(TILE_MIN - 1, 0)).toThrow(RangeError);
    expect(() => tileKey(TILE_MAX + 1, 0)).toThrow(RangeError);
    expect(() => tileKey(0, TILE_MIN - 1)).toThrow(RangeError);
    expect(() => tileKey(0, TILE_MAX + 1)).toThrow(RangeError);
  });

  it('accepts both ends of the documented range', () => {
    expect(() => tileKey(TILE_MIN, TILE_MIN)).not.toThrow();
    expect(() => tileKey(TILE_MAX, TILE_MAX)).not.toThrow();
  });

  it('rejects fractional coordinates instead of silently truncating them', () => {
    expect(() => tileKey(1.5, 2)).toThrow(RangeError);
    expect(() => tileKey(2, -0.5)).toThrow(RangeError);
    expect(() => tileKey(Number.NaN, 0)).toThrow(RangeError);
    expect(() => tileKey(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
