import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/game/data/items.js';
import {
  BUILD_RANGE_TILES,
  MINE_RANGE_TILES,
  MINE_TICKS_PER_ITEM,
  PLAYER_DIAGONAL_SUBTILES,
  PLAYER_RADIUS_SUBTILES,
  PLAYER_SPEED_TILES_PER_SECOND,
  PLAYER_STEP_SUBTILES,
  PlayerState,
  SUBTILES_PER_TILE,
  facingFor,
  stepFor,
  subtileToTile,
  tileCentreSubtile,
} from '../../src/game/player/player-state.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { EAST, NORTH, SOUTH, WEST } from '../../src/game/world/coordinates.js';

/**
 * The player's state and its units. See ironflow.md C10 task 1 and §6 R3.
 *
 * The chunk's fourth acceptance criterion — "movement speed is identical at 30
 * fps and 144 fps" — is really a statement about arithmetic, and this file is
 * where the arithmetic is pinned. A step that is not a whole number of subtiles
 * has to be rounded somewhere, and a rounding inside a per-tick accumulator is
 * exactly the drift §6 R3 exists to forbid; the tests below fail the moment
 * someone picks a speed or a subtile count that makes that true again.
 */

function player(options: { x?: number; y?: number; slots?: number } = {}): PlayerState {
  const items = new ItemRegistry(ITEMS);
  return new PlayerState({ stackSizeOf: items.stackSizeOf, ...options });
}

describe('the subtile grid', () => {
  it('divides evenly by the tick rate, so a step never has to be rounded', () => {
    expect(Number.isInteger(SUBTILES_PER_TILE / TPS)).toBe(true);
  });

  it('makes the walking speed an exact integer number of subtiles per tick', () => {
    expect(Number.isInteger(PLAYER_STEP_SUBTILES)).toBe(true);
    expect((PLAYER_STEP_SUBTILES * TPS) / SUBTILES_PER_TILE).toBe(PLAYER_SPEED_TILES_PER_SECOND);
  });

  it('floors toward negative infinity, so tile -1 is not tile 0', () => {
    expect(subtileToTile(0)).toBe(0);
    expect(subtileToTile(SUBTILES_PER_TILE - 1)).toBe(0);
    expect(subtileToTile(SUBTILES_PER_TILE)).toBe(1);
    expect(subtileToTile(0 - 1)).toBe(-1);
    expect(subtileToTile(0 - SUBTILES_PER_TILE)).toBe(-1);
  });

  it('puts a tile centre in the middle of its tile at every sign', () => {
    for (const tile of [-9, -1, 0, 1, 7]) {
      expect(subtileToTile(tileCentreSubtile(tile))).toBe(tile);
      expect(tileCentreSubtile(tile) - tile * SUBTILES_PER_TILE).toBe(SUBTILES_PER_TILE / 2);
    }
  });

  it('gives the player a body narrower than a tile, so they fit through gaps', () => {
    expect(PLAYER_RADIUS_SUBTILES).toBeGreaterThan(0);
    expect(PLAYER_RADIUS_SUBTILES * 2).toBeLessThan(SUBTILES_PER_TILE);
  });
});

describe('the step table', () => {
  it('walks diagonally at the same speed as it walks straight', () => {
    const cardinal = stepFor({ dx: 1, dy: 0 });
    const diagonal = stepFor({ dx: 1, dy: -1 });

    expect(Math.abs(cardinal.dx)).toBe(PLAYER_STEP_SUBTILES);
    expect(Math.abs(diagonal.dx)).toBe(PLAYER_DIAGONAL_SUBTILES);

    // Within 2% of the cardinal step, which is what rounding a whole number of
    // subtiles to the nearest one costs. Any more and someone has changed the
    // speed without re-deriving the diagonal.
    const length = Math.hypot(diagonal.dx, diagonal.dy);
    expect(Math.abs(length / PLAYER_STEP_SUBTILES - 1)).toBeLessThan(0.02);
  });

  it('produces whole subtiles on every axis, in every direction', () => {
    for (const dx of [-1, 0, 1] as const) {
      for (const dy of [-1, 0, 1] as const) {
        const step = stepFor({ dx, dy });
        expect(Number.isInteger(step.dx), `${dx},${dy}`).toBe(true);
        expect(Number.isInteger(step.dy), `${dx},${dy}`).toBe(true);
        // §6 R7: a negated zero survives a clone and is normalised by JSON.
        expect(Object.is(step.dx, -0)).toBe(false);
        expect(Object.is(step.dy, -0)).toBe(false);
      }
    }
  });

  it('stands still for no direction', () => {
    expect(stepFor({ dx: 0, dy: 0 })).toEqual({ dx: 0, dy: 0 });
  });
});

describe('facing', () => {
  it('follows the dominant axis, and keeps the vertical on a tie', () => {
    expect(facingFor({ dx: 0, dy: -1 }, SOUTH)).toBe(NORTH);
    expect(facingFor({ dx: 0, dy: 1 }, NORTH)).toBe(SOUTH);
    expect(facingFor({ dx: 1, dy: 0 }, NORTH)).toBe(EAST);
    expect(facingFor({ dx: -1, dy: 0 }, NORTH)).toBe(WEST);
    // A diagonal has two answers and picking the same one every time is what
    // stops the sprite flickering between them.
    expect(facingFor({ dx: 1, dy: -1 }, SOUTH)).toBe(NORTH);
    expect(facingFor({ dx: -1, dy: 1 }, NORTH)).toBe(SOUTH);
  });

  it('keeps the last facing when the player stops', () => {
    expect(facingFor({ dx: 0, dy: 0 }, WEST)).toBe(WEST);
  });
});

describe('move intent', () => {
  it('reads only the sign, so a command cannot set the speed', () => {
    const p = player();
    p.setMoveIntent(1000, -0.001);
    expect(p.moveIntent).toEqual({ dx: 1, dy: -1 });
    expect(p.isMoving).toBe(true);
  });

  it('treats a nonsense direction as standing still rather than as an error', () => {
    const p = player();
    p.setMoveIntent(Number.NaN, Number.POSITIVE_INFINITY);
    expect(p.moveIntent).toEqual({ dx: 0, dy: 0 });
    expect(p.isMoving).toBe(false);
  });

  it('never produces a negative zero', () => {
    const p = player();
    p.setMoveIntent(-0, -0);
    expect(Object.is(p.moveIntent.dx, -0)).toBe(false);
    expect(Object.is(p.moveIntent.dy, -0)).toBe(false);
  });
});

describe('reach', () => {
  it('measures to the centre of a tile, in whole subtiles', () => {
    const p = player({ x: 0, y: 0 });
    expect(p.squaredSubtileDistanceTo(0, 0)).toBe(0);
    expect(p.squaredSubtileDistanceTo(3, 4)).toBe((3 * SUBTILES_PER_TILE) ** 2 + (4 * SUBTILES_PER_TILE) ** 2);
  });

  it('includes a tile exactly on the boundary of the range', () => {
    const p = player({ x: 0, y: 0 });
    expect(p.isWithinRange(MINE_RANGE_TILES, 0, MINE_RANGE_TILES)).toBe(true);
    expect(p.isWithinRange(MINE_RANGE_TILES + 1, 0, MINE_RANGE_TILES)).toBe(false);
  });

  it('is a circle, not a square: the diagonal corner is further away', () => {
    const p = player({ x: 0, y: 0 });
    expect(p.isWithinRange(BUILD_RANGE_TILES, 0, BUILD_RANGE_TILES)).toBe(true);
    expect(p.isWithinRange(BUILD_RANGE_TILES, BUILD_RANGE_TILES, BUILD_RANGE_TILES)).toBe(false);
  });

  it('gives the player a longer arm for building than for mining', () => {
    expect(BUILD_RANGE_TILES).toBeGreaterThan(MINE_RANGE_TILES);
  });
});

describe('mining progress', () => {
  it('is a whole number of ticks per item at the rate §15 specifies', () => {
    expect(MINE_TICKS_PER_ITEM).toBe(60);
    expect(Number.isInteger(MINE_TICKS_PER_ITEM)).toBe(true);
  });

  it('resets when the target changes and not when it is re-asserted', () => {
    const p = player();
    p.startMining(2, 2);
    p.miningTicks = 17;

    p.startMining(2, 2);
    expect(p.miningTicks).toBe(17);

    p.startMining(3, 2);
    expect(p.miningTicks).toBe(0);
    expect(p.miningTarget).toEqual({ x: 3, y: 2 });
  });

  it('reports no progress and no target once stopped', () => {
    const p = player();
    p.startMining(2, 2);
    p.miningTicks = 30;
    expect(p.miningProgress).toBeCloseTo(0.5);

    p.stopMining();
    expect(p.miningTarget).toBeNull();
    expect(p.miningProgress).toBe(0);
  });
});

describe('serialization', () => {
  it('is plain data that survives both round trips (§6 R8, C05 task 1)', () => {
    const p = player({ x: 3, y: -4 });
    p.setMoveIntent(-1, 1);
    p.startMining(3, -3);
    p.miningTicks = 12;
    p.inventory.add(1, 7);
    // One container since C20: a building item goes in the same bag as ore.
    p.inventory.add(2, 2);

    const json = p.toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(structuredClone(json)).toEqual(json);
    expect(json.subX).toBe(tileCentreSubtile(3));
    expect(json.subY).toBe(tileCentreSubtile(-4));
  });

  it('holds nothing but finite numbers (§6 R7)', () => {
    const json = player().toJSON();
    for (const value of [json.subX, json.subY, json.facing, json.moveX, json.moveY, json.miningTicks]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
