import { describe, expect, it } from 'vitest';

import { TILE_H, TILE_W, screenToTile, tileToScreen } from '../../src/renderer/projection.js';
import { createSeededRandom, seededInt } from '../fixtures/seeded-random.js';

describe('projection constants', () => {
  it('matches the §5 contract as C27A rewrote it', () => {
    expect(TILE_W).toBe(48);
    expect(TILE_H).toBe(48);
  });

  it('is square, which every piece of placeholder art now depends on', () => {
    // The pre-C27A transform was 2:1, and half the atlas was built out of that
    // ratio. A square tile is the whole of what "top-down" means here: it is
    // what makes a footprint a rectangle, a tile-space circle a circle, and a
    // screen direction a tile direction.
    expect(TILE_W).toBe(TILE_H);
  });
});

describe('tileToScreen', () => {
  it('puts the origin tile at the origin', () => {
    expect(tileToScreen(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('maps the four neighbours of the origin tile', () => {
    expect(tileToScreen(1, 0)).toEqual({ x: 48, y: 0 });
    expect(tileToScreen(0, 1)).toEqual({ x: 0, y: 48 });
    expect(tileToScreen(1, 1)).toEqual({ x: 48, y: 48 });
    expect(tileToScreen(-1, -1)).toEqual({ x: -48, y: -48 });
  });

  it('moves +X right and +Y down, and neither one diagonally', () => {
    // The point of the chunk: a step east is a step east on screen. Anything
    // that has to turn a screen direction into a tile direction — WASD, a
    // drag, the map panel's viewport box — gets that for free from here.
    const origin = tileToScreen(10, 10);
    const east = tileToScreen(11, 10);
    const south = tileToScreen(10, 11);

    expect(east.x).toBeGreaterThan(origin.x);
    expect(east.y).toBe(origin.y);
    expect(south.x).toBe(origin.x);
    expect(south.y).toBeGreaterThan(origin.y);
  });

  it('is linear, which is what lets the camera subtract projected points', () => {
    // camera.worldToScreen relies on P(a) - P(b) === P(a - b). If this ever
    // stopped holding, panning would drift instead of tracking the cursor.
    const random = createSeededRandom(0xa11ce);
    for (let i = 0; i < 1000; i++) {
      const ax = seededInt(random, -500, 500);
      const ay = seededInt(random, -500, 500);
      const bx = seededInt(random, -500, 500);
      const by = seededInt(random, -500, 500);

      const a = tileToScreen(ax, ay);
      const b = tileToScreen(bx, by);
      const difference = tileToScreen(ax - bx, ay - by);

      expect(a.x - b.x).toBe(difference.x);
      expect(a.y - b.y).toBe(difference.y);
    }
  });
});

describe('screenToTile', () => {
  it('inverts tileToScreen exactly for 10,000 random tiles', () => {
    // Exactly, not approximately. `48` is not a power of two, so this is worth
    // a word: `x * 48` is an exact integer at these magnitudes, and IEEE
    // division returns the correctly rounded true quotient — which is `x`,
    // and `x` is representable. So the round trip is bit-for-bit.
    const random = createSeededRandom(0xd15ea5e);
    let checked = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = seededInt(random, -20_000, 20_000);
      const y = seededInt(random, -20_000, 20_000);
      const screen = tileToScreen(x, y);
      const back = screenToTile(screen.x, screen.y);
      expect(back).toEqual({ x, y });
      checked++;
    }
    expect(checked).toBe(10_000);
  });

  it('inverts tileToScreen exactly over a dense block including negatives', () => {
    for (let x = -32; x <= 32; x++) {
      for (let y = -32; y <= 32; y++) {
        expect(screenToTile(tileToScreen(x, y).x, tileToScreen(x, y).y)).toEqual({ x, y });
      }
    }
  });

  it('round-trips fractional positions too', () => {
    const random = createSeededRandom(99);
    for (let i = 0; i < 1000; i++) {
      const x = seededInt(random, -1000, 1000) + random();
      const y = seededInt(random, -1000, 1000) + random();
      const back = screenToTile(tileToScreen(x, y).x, tileToScreen(x, y).y);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it('floors to the tile whose square contains the point', () => {
    // The projected point for an integer tile is that square's north-west
    // corner, so its interior is the TILE_W x TILE_H block right and below it.
    const corner = tileToScreen(3, 5); // { x: 144, y: 240 }
    const centre = screenToTile(corner.x + TILE_W / 2, corner.y + TILE_H / 2);
    expect({ x: Math.floor(centre.x), y: Math.floor(centre.y) }).toEqual({ x: 3, y: 5 });

    const justInside = screenToTile(corner.x + 1, corner.y + 1);
    expect({ x: Math.floor(justInside.x), y: Math.floor(justInside.y) }).toEqual({ x: 3, y: 5 });

    const justAbove = screenToTile(corner.x + 1, corner.y - 1);
    expect({ x: Math.floor(justAbove.x), y: Math.floor(justAbove.y) }).not.toEqual({ x: 3, y: 5 });

    const justLeft = screenToTile(corner.x - 1, corner.y + 1);
    expect({ x: Math.floor(justLeft.x), y: Math.floor(justLeft.y) }).not.toEqual({ x: 3, y: 5 });
  });

  it('gives every point in a tile back to that tile', () => {
    const random = createSeededRandom(0xfeed);
    for (let i = 0; i < 5000; i++) {
      const tx = seededInt(random, -200, 200);
      const ty = seededInt(random, -200, 200);

      // Sample strictly inside the unit square of tile space, which is exactly
      // the interior of that tile's square on screen.
      const insideX = tx + 0.001 + random() * 0.998;
      const insideY = ty + 0.001 + random() * 0.998;

      const screen = tileToScreen(insideX, insideY);
      const back = screenToTile(screen.x, screen.y);
      expect({ x: Math.floor(back.x), y: Math.floor(back.y) }).toEqual({ x: tx, y: ty });
    }
  });

  it('has no seam between neighbouring tiles', () => {
    // Walk a horizontal line of screen pixels across several tiles and require
    // every pixel to belong to some tile, with no gaps or repeats in the
    // sequence of tiles crossed.
    let previous: string | null = null;
    const visited: string[] = [];
    for (let sx = -128; sx <= 128; sx++) {
      const world = screenToTile(sx, 40);
      const label = `${Math.floor(world.x)},${Math.floor(world.y)}`;
      expect(Number.isFinite(world.x)).toBe(true);
      if (label !== previous) {
        expect(visited).not.toContain(label);
        visited.push(label);
        previous = label;
      }
    }
    expect(visited.length).toBeGreaterThan(1);
  });
});
