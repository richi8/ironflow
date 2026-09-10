import { describe, expect, it, vi } from 'vitest';

import {
  CHUNK_AREA,
  CHUNK_MAX,
  CHUNK_MIN,
  CHUNK_SIZE,
  NO_RESOURCE,
  chunkKey,
  createChunk,
  localIndex,
  toChunkCoord,
  toLocalCoord,
  type WorldChunk,
} from '../../src/game/world/chunk.js';
import type { TileBounds } from '../../src/game/world/coordinates.js';
import {
  TILE_TYPE_COUNT,
  TileType,
  isBuildable,
  isPassable,
  isTileType,
  tileProperties,
} from '../../src/game/world/tile.js';
import { createCheckerboardGenerator } from '../../src/game/world/world-generator.js';
import { World, type ChunkGenerator } from '../../src/game/world/world.js';

/**
 * C02 — world, world chunks, terrain. See ironflow.md C02.
 *
 * The centre of gravity here is negative coordinates. A chunked world that is
 * only ever tested in the positive quadrant passes everything and is wrong
 * everywhere west and north of the origin, and the symptom — a world mirrored
 * about the origin — reads as a rendering bug for a long time before anyone
 * suspects an integer division.
 */

/** An iron-ish resource id. C08/C09 give resources real ids; C02 needs a byte. */
const ORE = 1;

/** A generator that counts its calls, so lazy creation is observable. */
function countingGenerator(): ChunkGenerator & { calls: () => number } {
  let calls = 0;
  const generate = (cx: number, cy: number): WorldChunk => {
    calls++;
    return createChunk(cx, cy);
  };
  return Object.assign(generate, { calls: () => calls });
}

/** A generator that puts `amount` of `ORE` on every tile of every world chunk. */
function oreGenerator(amount: number): ChunkGenerator {
  return (cx, cy) => {
    const chunk = createChunk(cx, cy);
    chunk.resource.fill(ORE);
    chunk.resourceAmount.fill(amount);
    return chunk;
  };
}

describe('TileType', () => {
  it('numbers grass zero, so a zero-filled world chunk is a valid one', () => {
    expect(TileType.Grass).toBe(0);
    expect(createChunk(0, 0).terrain.every((t) => t === TileType.Grass)).toBe(true);
  });

  it('makes water impassable and unbuildable, which is the point of terrain', () => {
    expect(isPassable(TileType.Water)).toBe(false);
    expect(isBuildable(TileType.Water)).toBe(false);
  });

  it('makes every other terrain walkable and buildable in v1', () => {
    for (const type of [TileType.Grass, TileType.Dirt, TileType.Sand, TileType.Stone]) {
      expect(isPassable(type), `${tileProperties(type).name} should be passable`).toBe(true);
      expect(isBuildable(type), `${tileProperties(type).name} should be buildable`).toBe(true);
    }
  });

  it('describes exactly the types it declares', () => {
    expect(TILE_TYPE_COUNT).toBe(5);
    for (let type = 0; type < TILE_TYPE_COUNT; type++) {
      expect(isTileType(type)).toBe(true);
      expect(tileProperties(type).name.length).toBeGreaterThan(0);
    }
    expect(isTileType(TILE_TYPE_COUNT)).toBe(false);
    expect(isTileType(-1)).toBe(false);
    expect(isTileType(1.5)).toBe(false);
    expect(() => tileProperties(TILE_TYPE_COUNT)).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- *
 * C02 task 4 — the floor-division rule, tested head on.
 * -------------------------------------------------------------------------- */

describe('toChunkCoord', () => {
  it('floors instead of truncating, so the negative half is not mirrored', () => {
    expect(toChunkCoord(0)).toBe(0);
    expect(toChunkCoord(31)).toBe(0);
    expect(toChunkCoord(32)).toBe(1);
    expect(toChunkCoord(-1)).toBe(-1);
    expect(toChunkCoord(-32)).toBe(-1);
    expect(toChunkCoord(-33)).toBe(-2);
  });

  it('disagrees with the `| 0` shortcut exactly where that shortcut is wrong', () => {
    // The bug this file exists to prevent, stated as an assertion.
    const truncating = (t: number): number => (t / CHUNK_SIZE) | 0;
    expect(truncating(-1)).toBe(0); // wrong: tile -1 is not in world chunk 0
    expect(toChunkCoord(-1)).toBe(-1);

    // The two agree on every non-negative tile and on the exact multiples of
    // CHUNK_SIZE, and disagree on all 62 other negative tiles in this range.
    const disagreements: number[] = [];
    for (let t = -64; t < 64; t++) {
      if (toChunkCoord(t) !== truncating(t)) disagreements.push(t);
    }
    expect(disagreements.every((t) => t < 0 && t % CHUNK_SIZE !== 0)).toBe(true);
    expect(disagreements.length).toBe(62);
  });

  it('is monotonic and changes exactly once every CHUNK_SIZE tiles', () => {
    let changes = 0;
    for (let t = -1000; t < 1000; t++) {
      const step = toChunkCoord(t + 1) - toChunkCoord(t);
      expect(step === 0 || step === 1).toBe(true);
      changes += step;
    }
    // Every boundary between world chunk -32 (holding tile -1000) and world
    // chunk 31 (holding tile 1000) is crossed exactly once.
    expect(changes).toBe(toChunkCoord(1000) - toChunkCoord(-1000));
    expect(changes).toBe(63);
  });
});

describe('toLocalCoord', () => {
  it('stays in [0, CHUNK_SIZE) on both sides of the origin', () => {
    for (let t = -1000; t <= 1000; t++) {
      const local = toLocalCoord(t);
      expect(local).toBeGreaterThanOrEqual(0);
      expect(local).toBeLessThan(CHUNK_SIZE);
      expect(Object.is(local, -0)).toBe(false); // §6 R7
    }
  });

  it('wraps the tiles either side of the origin without a seam', () => {
    expect(toLocalCoord(0)).toBe(0);
    expect(toLocalCoord(-1)).toBe(CHUNK_SIZE - 1);
    expect(toLocalCoord(-32)).toBe(0);
    expect(toLocalCoord(-33)).toBe(CHUNK_SIZE - 1);
  });

  it('reconstructs the tile from its world chunk and local coordinate', () => {
    for (let t = -5000; t <= 5000; t += 7) {
      expect(toChunkCoord(t) * CHUNK_SIZE + toLocalCoord(t)).toBe(t);
    }
  });
});

describe('chunkKey', () => {
  it('is injective across the whole packable range', () => {
    const seen = new Set<number>();
    const sample = [CHUNK_MIN, -1000, -33, -1, 0, 1, 33, 1000, CHUNK_MAX];
    for (const cx of sample) {
      for (const cy of sample) {
        const key = chunkKey(cx, cy);
        expect(seen.has(key), `collision at (${cx}, ${cy})`).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(sample.length * sample.length);
  });

  it('covers the tile range that tileKey packs', () => {
    expect(CHUNK_MIN).toBe(toChunkCoord(-32768));
    expect(CHUNK_MAX).toBe(toChunkCoord(32767));
  });

  it('refuses coordinates it cannot pack, rather than aliasing another chunk', () => {
    expect(() => chunkKey(CHUNK_MIN - 1, 0)).toThrow(RangeError);
    expect(() => chunkKey(0, CHUNK_MAX + 1)).toThrow(RangeError);
    expect(() => chunkKey(1.5, 0)).toThrow(RangeError);
    expect(() => chunkKey(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe('createChunk', () => {
  it('allocates CHUNK_AREA entries per array and starts clean', () => {
    const chunk = createChunk(-3, 7);
    expect(chunk.cx).toBe(-3);
    expect(chunk.cy).toBe(7);
    expect(chunk.terrain.length).toBe(CHUNK_AREA);
    expect(chunk.resource.length).toBe(CHUNK_AREA);
    expect(chunk.resourceAmount.length).toBe(CHUNK_AREA);
    expect(chunk.dirty).toBe(false);
  });

  it('indexes row-major with no gaps or overlaps', () => {
    const seen = new Set<number>();
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const index = localIndex(lx, ly);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(CHUNK_AREA);
        seen.add(index);
      }
    }
    expect(seen.size).toBe(CHUNK_AREA);
  });
});

/* -------------------------------------------------------------------------- *
 * World
 * -------------------------------------------------------------------------- */

describe('World lazy creation', () => {
  it('starts with nothing', () => {
    const generate = countingGenerator();
    const world = new World(generate);
    expect(world.chunkCount).toBe(0);
    expect(generate.calls()).toBe(0);
  });

  it('creates exactly one world chunk when one tile is read', () => {
    const generate = countingGenerator();
    const world = new World(generate);

    world.getTile(0, 0);

    expect(world.chunkCount).toBe(1);
    expect(generate.calls()).toBe(1);
  });

  it('reuses a world chunk for every tile inside it', () => {
    const generate = countingGenerator();
    const world = new World(generate);

    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        world.getTile(x, y);
      }
    }

    expect(generate.calls()).toBe(1);
    expect(world.chunkCount).toBe(1);
  });

  it('creates a distinct world chunk on each side of the origin', () => {
    const generate = countingGenerator();
    const world = new World(generate);

    // The four tiles diagonally touching the origin corner sit in four
    // different world chunks. A truncating division would find only two.
    world.getTile(0, 0);
    world.getTile(-1, 0);
    world.getTile(0, -1);
    world.getTile(-1, -1);

    expect(world.chunkCount).toBe(4);
    expect(world.peekChunk(0, 0)?.cx).toBe(0);
    expect(world.peekChunk(-1, -1)?.cx).toBe(-1);
  });

  it('does not create anything when peeking', () => {
    const generate = countingGenerator();
    const world = new World(generate);

    expect(world.peekChunk(4, 4)).toBeUndefined();
    expect(generate.calls()).toBe(0);
    expect(world.chunkCount).toBe(0);
  });

  it('rejects a generator that returns the wrong world chunk', () => {
    const world = new World((cx, cy) => createChunk(cx + 1, cy));
    expect(() => world.getTile(0, 0)).toThrow(/generator returned world chunk/);
  });
});

describe('World tile access', () => {
  it('reads and writes every combination of signs, at magnitude 10,000', () => {
    const world = new World(createChunk);
    const coords = [-10_000, -9_999, -33, -32, -31, -1, 0, 1, 31, 32, 33, 9_999, 10_000];
    const types = [TileType.Grass, TileType.Dirt, TileType.Sand, TileType.Stone, TileType.Water];

    // Write a value derived from the coordinate, then read every tile back.
    // Writing all of them first is what catches aliasing: a coordinate bug
    // makes two tiles share a slot, and the second write clobbers the first.
    const expected = new Map<string, TileType>();
    for (const x of coords) {
      for (const y of coords) {
        const type = types[Math.abs(x + y * 3) % types.length] ?? TileType.Grass;
        world.setTile(x, y, type);
        expected.set(`${x},${y}`, type);
      }
    }

    for (const x of coords) {
      for (const y of coords) {
        expect(world.getTile(x, y), `tile (${x}, ${y})`).toBe(expected.get(`${x},${y}`));
      }
    }
  });

  it('reads and writes every tile from -10,000 to +10,000 along both axes', () => {
    // The C02 acceptance criterion, swept rather than sampled: 20,001 tiles per
    // axis, each given a value derived from its own coordinate, all written
    // before any is read back. Aliasing shows up as a clobbered neighbour.
    const types = [TileType.Grass, TileType.Dirt, TileType.Sand, TileType.Stone, TileType.Water];
    const typeFor = (t: number): TileType => types[toLocalCoord(t) % types.length] ?? TileType.Grass;

    // One world per axis: the origin belongs to both, so sweeping them in a
    // single world would just have the second pass overwrite it.
    const alongX = new World(createChunk);
    const alongY = new World(createChunk);
    for (let t = -10_000; t <= 10_000; t++) {
      alongX.setTile(t, 0, typeFor(t));
      alongY.setTile(0, t, typeFor(t));
    }

    for (let t = -10_000; t <= 10_000; t++) {
      expect(alongX.getTile(t, 0), `tile (${t}, 0)`).toBe(typeFor(t));
      expect(alongY.getTile(0, t), `tile (0, ${t})`).toBe(typeFor(t));
    }

    // Tiles -10,000..10,000 span world chunks -313..312 — 626 of them. An axis
    // that silently folded onto itself would have produced fewer.
    expect(alongX.chunkCount).toBe(626);
    expect(alongY.chunkCount).toBe(626);
  });

  it('keeps neighbouring tiles across a world-chunk boundary independent', () => {
    const world = new World(createChunk);

    world.setTile(-1, -1, TileType.Water);

    expect(world.getTile(-1, -1)).toBe(TileType.Water);
    expect(world.getTile(0, 0)).toBe(TileType.Grass);
    expect(world.getTile(-1, 0)).toBe(TileType.Grass);
    expect(world.getTile(0, -1)).toBe(TileType.Grass);
    expect(world.getTile(-2, -1)).toBe(TileType.Grass);
  });

  it('serves the terrain the generator produced', () => {
    const world = new World((cx, cy) => {
      const chunk = createChunk(cx, cy);
      chunk.terrain.fill(TileType.Sand);
      return chunk;
    });
    expect(world.getTile(-500, 700)).toBe(TileType.Sand);
  });

  it('refuses a terrain value that is not a TileType', () => {
    const world = new World(createChunk);
    expect(() => world.setTile(0, 0, 99 as TileType)).toThrow(RangeError);
    expect(() => world.setTile(0, 0, -1 as TileType)).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- *
 * The dirty flag — §14 depends on every one of these transitions.
 * -------------------------------------------------------------------------- */

describe('World dirty flag', () => {
  it('is false on a freshly generated world chunk', () => {
    const world = new World(oreGenerator(100));
    world.getTile(50, -70);
    expect(world.peekChunk(toChunkCoord(50), toChunkCoord(-70))?.dirty).toBe(false);
  });

  it('is still false after reads, however many', () => {
    const world = new World(oreGenerator(100));
    world.getTile(0, 0);
    world.getResource(0, 0);
    world.getResourceAmount(0, 0);
    world.forEachChunkInBounds({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, () => {});
    expect(world.peekChunk(0, 0)?.dirty).toBe(false);
  });

  it('is set by changing a tile', () => {
    const world = new World(createChunk);
    world.setTile(-40, -40, TileType.Water);
    expect(world.peekChunk(-2, -2)?.dirty).toBe(true);
  });

  it('is not set by writing the terrain that is already there', () => {
    const world = new World(createChunk);
    world.setTile(0, 0, TileType.Grass); // the generated value
    expect(world.peekChunk(0, 0)?.dirty).toBe(false);
  });

  it('is set by consuming a single ore', () => {
    const world = new World(oreGenerator(100));
    expect(world.consumeResource(3, 3, 1)).toBe(1);
    expect(world.peekChunk(0, 0)?.dirty).toBe(true);
  });

  it('is not set by a consume that takes nothing', () => {
    const world = new World(oreGenerator(0));
    expect(world.consumeResource(3, 3, 5)).toBe(0);
    expect(world.peekChunk(0, 0)?.dirty).toBe(false);

    const empty = new World(createChunk); // no resource at all
    expect(empty.consumeResource(3, 3, 5)).toBe(0);
    expect(empty.peekChunk(0, 0)?.dirty).toBe(false);
  });

  it('is per world chunk, not global', () => {
    const world = new World(createChunk);
    world.getTile(100, 0); // world chunk (3, 0)
    world.setTile(0, 0, TileType.Water); // world chunk (0, 0)
    expect(world.peekChunk(0, 0)?.dirty).toBe(true);
    expect(world.peekChunk(3, 0)?.dirty).toBe(false);
  });
});

describe('World resources', () => {
  it('reports the type and remaining amount the generator placed', () => {
    const world = new World(oreGenerator(500));
    expect(world.getResource(-77, 42)).toBe(ORE);
    expect(world.getResourceAmount(-77, 42)).toBe(500);
  });

  it('reports NO_RESOURCE on bare terrain', () => {
    const world = new World(createChunk);
    expect(world.getResource(0, 0)).toBe(NO_RESOURCE);
    expect(world.getResourceAmount(0, 0)).toBe(0);
  });

  it('subtracts what it takes', () => {
    const world = new World(oreGenerator(10));
    expect(world.consumeResource(0, 0, 4)).toBe(4);
    expect(world.getResourceAmount(0, 0)).toBe(6);
  });

  it('clamps to what remains and stops exactly at zero', () => {
    const world = new World(oreGenerator(10));
    expect(world.consumeResource(0, 0, 999)).toBe(10);
    expect(world.getResourceAmount(0, 0)).toBe(0);
    expect(world.consumeResource(0, 0, 1)).toBe(0);
  });

  it('leaves the resource type in place when a tile is exhausted', () => {
    // §14 saves changed amounts as a delta; a restored zero must not need a
    // second field to say what kind of nothing it is.
    const world = new World(oreGenerator(3));
    world.consumeResource(0, 0, 3);
    expect(world.getResource(0, 0)).toBe(ORE);
    expect(world.getResourceAmount(0, 0)).toBe(0);
  });

  it('consumes from one tile only, including across the origin', () => {
    const world = new World(oreGenerator(10));
    world.consumeResource(-1, -1, 10);
    expect(world.getResourceAmount(-1, -1)).toBe(0);
    expect(world.getResourceAmount(0, 0)).toBe(10);
    expect(world.getResourceAmount(-2, -1)).toBe(10);
    expect(world.getResourceAmount(-1, -2)).toBe(10);
  });

  it('refuses a negative or fractional consume', () => {
    const world = new World(oreGenerator(10));
    expect(() => world.consumeResource(0, 0, -1)).toThrow(RangeError);
    expect(() => world.consumeResource(0, 0, 0.5)).toThrow(RangeError);
  });

  it('places a patch and refuses values the arrays cannot hold', () => {
    const world = new World(createChunk);
    world.setResource(-9, -9, ORE, 250);
    expect(world.getResource(-9, -9)).toBe(ORE);
    expect(world.getResourceAmount(-9, -9)).toBe(250);
    expect(world.peekChunk(-1, -1)?.dirty).toBe(true);

    expect(() => world.setResource(0, 0, 256, 1)).toThrow(RangeError);
    expect(() => world.setResource(0, 0, ORE, 65_536)).toThrow(RangeError);
    expect(() => world.setResource(0, 0, ORE, -1)).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- *
 * forEachChunkInBounds — inclusivity is the whole test.
 * -------------------------------------------------------------------------- */

describe('World.forEachChunkInBounds', () => {
  function visited(world: World, bounds: TileBounds): string[] {
    const out: string[] = [];
    world.forEachChunkInBounds(bounds, (chunk) => out.push(`${chunk.cx},${chunk.cy}`));
    return out;
  }

  it('includes the world chunk containing maxX and maxY', () => {
    const world = new World(createChunk);
    // 0..32 spans two world chunks on each axis because 32 is inclusive.
    expect(visited(world, { minX: 0, minY: 0, maxX: 32, maxY: 32 })).toEqual([
      '0,0',
      '1,0',
      '0,1',
      '1,1',
    ]);
  });

  it('visits one world chunk for a rectangle inside one', () => {
    const world = new World(createChunk);
    expect(visited(world, { minX: 1, minY: 1, maxX: 30, maxY: 30 })).toEqual(['0,0']);
    expect(visited(world, { minX: 5, minY: 5, maxX: 5, maxY: 5 })).toEqual(['0,0']);
  });

  it('spans the origin without skipping or repeating a world chunk', () => {
    const world = new World(createChunk);
    expect(visited(world, { minX: -1, minY: -1, maxX: 0, maxY: 0 })).toEqual([
      '-1,-1',
      '0,-1',
      '-1,0',
      '0,0',
    ]);
  });

  it('visits in a fixed row-major order, not in Map insertion order', () => {
    const world = new World(createChunk);
    // Touch the far corner first, so insertion order and coordinate order
    // disagree. §6 R4: a system may not depend on the difference.
    world.getTile(40, 40);
    world.getTile(-40, -40);
    expect(visited(world, { minX: -40, minY: -40, maxX: 40, maxY: 40 })).toEqual([
      '-2,-2',
      '-1,-2',
      '0,-2',
      '1,-2',
      '-2,-1',
      '-1,-1',
      '0,-1',
      '1,-1',
      '-2,0',
      '-1,0',
      '0,0',
      '1,0',
      '-2,1',
      '-1,1',
      '0,1',
      '1,1',
    ]);
  });

  it('visits nothing for the empty bounds the camera reports', () => {
    const world = new World(createChunk);
    const visit = vi.fn();
    // Camera.visibleTileBounds returns this for a zero-size viewport.
    world.forEachChunkInBounds({ minX: 0, minY: 0, maxX: -1, maxY: -1 }, visit);
    expect(visit).not.toHaveBeenCalled();
    expect(world.chunkCount).toBe(0);
  });

  it('generates the world chunks it visits, which is how the map fills in', () => {
    const generate = countingGenerator();
    const world = new World(generate);
    world.forEachChunkInBounds({ minX: -1, minY: -1, maxX: 32, maxY: 32 }, () => {});
    expect(generate.calls()).toBe(9); // 3x3 world chunks: -1, 0, 1 on each axis
    world.forEachChunkInBounds({ minX: -1, minY: -1, maxX: 32, maxY: 32 }, () => {});
    expect(generate.calls()).toBe(9); // and not again
  });
});

/* -------------------------------------------------------------------------- *
 * Memory — C02 acceptance: 1,600 world chunks under 20 MB.
 * -------------------------------------------------------------------------- */

describe('World memory', () => {
  it('holds 1,600 world chunks in well under 20 MB', () => {
    const world = new World(createChunk);
    const side = 40; // 40 x 40 = 1,600 world chunks, the §12 reference factory

    for (let cy = 0; cy < side; cy++) {
      for (let cx = 0; cx < side; cx++) {
        world.getTile(cx * CHUNK_SIZE, cy * CHUNK_SIZE);
      }
    }
    expect(world.chunkCount).toBe(side * side);

    // Measured from the buffers, not from the heap: `process.memoryUsage` moves
    // with GC timing and would make this test flaky for reasons unrelated to
    // the world. The per-world-chunk object holding these arrays is a handful
    // of fields — hundreds of bytes against four kilobytes of payload — so the
    // buffer total is the number that decides whether the budget is met.
    let bytes = 0;
    world.forEachChunkInBounds(
      { minX: 0, minY: 0, maxX: side * CHUNK_SIZE - 1, maxY: side * CHUNK_SIZE - 1 },
      (chunk) => {
        bytes += chunk.terrain.byteLength + chunk.resource.byteLength + chunk.resourceAmount.byteLength;
      },
    );

    expect(bytes).toBe(side * side * CHUNK_AREA * 4); // 1 + 1 + 2 bytes per tile
    expect(bytes).toBeLessThan(20 * 1024 * 1024);
    expect(bytes / (1024 * 1024)).toBeCloseTo(6.25, 2);
  });
});

/* -------------------------------------------------------------------------- *
 * The placeholder generator. C19 replaces it; until then it must at least be
 * positional, because C19's determinism rests on that habit being in place.
 * -------------------------------------------------------------------------- */

describe('createCheckerboardGenerator', () => {
  it('depends only on world-chunk coordinates, not on generation order', () => {
    const first = createCheckerboardGenerator();
    const second = createCheckerboardGenerator();

    // Generate the same world chunk early in one run and late in another.
    const early = first(-3, 5);
    for (let i = 0; i < 20; i++) second(i, i);
    const late = second(-3, 5);

    expect(Array.from(late.terrain)).toEqual(Array.from(early.terrain));
  });

  it('is continuous across the origin rather than mirrored', () => {
    const world = new World(createCheckerboardGenerator());
    // Tiles (-9, 1) and (-1, 1) are in adjacent 8-tile squares, so they differ;
    // a truncating checker would give both the same colour.
    expect(world.getTile(-9, 1)).not.toBe(world.getTile(-1, 1));
    expect(world.getTile(-1, 1)).not.toBe(world.getTile(1, 1));
  });

  it('marks world-chunk boundaries, so a seam is visible on sight', () => {
    const world = new World(createCheckerboardGenerator());
    expect(world.getTile(0, 5)).toBe(TileType.Stone);
    expect(world.getTile(31, 5)).toBe(TileType.Stone);
    expect(world.getTile(-1, 5)).toBe(TileType.Stone);
    expect(world.getTile(5, 5)).not.toBe(TileType.Stone);
  });

  it('produces buildable terrain everywhere, since C02 places no water', () => {
    const chunk = createCheckerboardGenerator()(2, -2);
    expect(chunk.terrain.every((t) => isBuildable(t))).toBe(true);
    expect(chunk.resource.every((r) => r === NO_RESOURCE)).toBe(true);
    expect(chunk.dirty).toBe(false);
  });
});
