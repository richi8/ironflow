import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE, MAX_RESOURCE_AMOUNT, localIndex } from '../../src/game/world/chunk.js';
import {
  RESOURCE_TYPES,
  ResourceType,
  isResourceType,
  resourceName,
} from '../../src/game/world/resource.js';
import { TILE_TYPE_COUNT, TileType, isTileType } from '../../src/game/world/tile.js';
import { World } from '../../src/game/world/world.js';
import {
  GENERATOR_VERSION,
  createWorldGenerator,
  generatedResources,
} from '../../src/game/world/world-generator.js';
import { createSeededRandom, seededInt } from '../fixtures/seeded-random.js';

/**
 * C19 — procedural world generation. See ironflow.md C19 and pillar 2.
 *
 * The acceptance criteria split into three kinds of claim, and this file is
 * organised by them:
 *
 * ```text
 * it is the same world every time   positional purity, seed stability
 * it is a world worth playing       four resources, varied shapes, no ore
 *                                   under water, richer further out
 * it is a *different* world         two seeds disagree everywhere that matters
 * ```
 *
 * The fourth criterion — "20 seeds inspected by eye produce visibly different
 * resource layouts" — is not here, because no assertion stands in for a
 * person looking at a map. `npm run minimap -- --count=20` is what answers it,
 * and the C19 chunk report records the answer.
 */

/** A rectangle of generated tiles, flattened, for the property tests below. */
interface Region {
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly terrain: Uint8Array;
  readonly resource: Uint8Array;
  readonly amount: Uint16Array;
}

/** Generate `chunks × chunks` world chunks starting at world chunk (cx, cy). */
function region(seed: number, chunks: number, cx = 0, cy = 0): Region {
  const generate = createWorldGenerator(seed);
  const width = chunks * CHUNK_SIZE;
  const terrain = new Uint8Array(width * width);
  const resource = new Uint8Array(width * width);
  const amount = new Uint16Array(width * width);

  for (let gy = 0; gy < chunks; gy++) {
    for (let gx = 0; gx < chunks; gx++) {
      const chunk = generate(cx + gx, cy + gy);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const from = localIndex(lx, ly);
          const to = (gy * CHUNK_SIZE + ly) * width + gx * CHUNK_SIZE + lx;
          terrain[to] = chunk.terrain[from] ?? 0;
          resource[to] = chunk.resource[from] ?? 0;
          amount[to] = chunk.resourceAmount[from] ?? 0;
        }
      }
    }
  }

  return { width, height: width, originX: cx * CHUNK_SIZE, originY: cy * CHUNK_SIZE, terrain, resource, amount };
}

/** One connected deposit: which tiles, and the box that contains them. */
interface Deposit {
  readonly resource: ResourceType;
  readonly tiles: number;
  readonly width: number;
  readonly height: number;
  readonly peak: number;
  readonly centreX: number;
  readonly centreY: number;
}

/** Every connected deposit fully inside the region, four-neighbour. */
function deposits(area: Region): Deposit[] {
  const seen = new Uint8Array(area.width * area.height);
  const found: Deposit[] = [];

  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const start = y * area.width + x;
      const resource = area.resource[start] ?? ResourceType.None;
      if (resource === ResourceType.None || seen[start] === 1) continue;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let tiles = 0;
      let peak = 0;
      let touchesEdge = false;

      seen[start] = 1;
      const stack = [x, y];
      while (stack.length > 0) {
        const cy = stack.pop() as number;
        const cx = stack.pop() as number;
        const index = cy * area.width + cx;
        tiles += 1;
        peak = Math.max(peak, area.amount[index] ?? 0);
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        if (cx === 0 || cy === 0 || cx === area.width - 1 || cy === area.height - 1) touchesEdge = true;

        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= area.width || ny >= area.height) continue;
          const n = ny * area.width + nx;
          if (seen[n] === 1 || area.resource[n] !== resource) continue;
          seen[n] = 1;
          stack.push(nx, ny);
        }
      }

      // A deposit clipped by the region's own edge would report a false size
      // and a false shape, which is the opposite of what these tests measure.
      if (touchesEdge) continue;

      found.push({
        resource: resource as ResourceType,
        tiles,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        peak,
        centreX: area.originX + (minX + maxX) / 2,
        centreY: area.originY + (minY + maxY) / 2,
      });
    }
  }

  return found;
}

describe('the generator version', () => {
  it('is a positive integer, because §14 writes it into every save', () => {
    expect(Number.isInteger(GENERATOR_VERSION)).toBe(true);
    expect(GENERATOR_VERSION).toBeGreaterThan(0);
  });
});

describe('C19 task 1: pure and positional', () => {
  it('produces the same world chunk whether it is the first or the thousandth', () => {
    // The chunk's first acceptance criterion, stated as directly as it can be:
    // one generator walks a thousand world chunks before reaching (5, 5), the
    // other goes straight there, and the bytes must match.
    const eager = createWorldGenerator(4242);
    const lazy = createWorldGenerator(4242);

    for (let i = 0; i < 1000; i++) eager((i % 37) - 18, Math.floor(i / 37) - 13);

    const late = eager(5, 5);
    const direct = lazy(5, 5);
    expect([...late.terrain]).toEqual([...direct.terrain]);
    expect([...late.resource]).toEqual([...direct.resource]);
    expect([...late.resourceAmount]).toEqual([...direct.resourceAmount]);
  });

  it('gives a shuffled exploration the same world as a row-major one', () => {
    const random = createSeededRandom(17);
    const coords: { cx: number; cy: number }[] = [];
    for (let cy = -3; cy <= 3; cy++) for (let cx = -3; cx <= 3; cx++) coords.push({ cx, cy });

    const ordered = createWorldGenerator(0x51ee);
    const expected = new Map<string, string>();
    for (const { cx, cy } of coords) {
      const chunk = ordered(cx, cy);
      expected.set(`${cx},${cy}`, `${[...chunk.terrain].join()}|${[...chunk.resourceAmount].join()}`);
    }

    for (let i = coords.length - 1; i > 0; i--) {
      const j = seededInt(random, 0, i);
      const a = coords[i] as { cx: number; cy: number };
      coords[i] = coords[j] as { cx: number; cy: number };
      coords[j] = a;
    }

    const shuffled = createWorldGenerator(0x51ee);
    for (const { cx, cy } of coords) {
      const chunk = shuffled(cx, cy);
      expect(`${[...chunk.terrain].join()}|${[...chunk.resourceAmount].join()}`).toBe(
        expected.get(`${cx},${cy}`),
      );
    }
  });

  it('gives a world chunk revisited through World the same tiles it had', () => {
    // The same property one layer up, where the bug actually bites: a world
    // walked away from and returned to must not have been rewritten.
    const world = new World(createWorldGenerator(88));
    const before: number[] = [];
    for (let x = -40; x < 40; x++) before.push(world.getTile(x, 7), world.getResourceAmount(x, 7));

    // Touch a hundred other world chunks in between.
    for (let cx = -5; cx <= 5; cx++) for (let cy = -5; cy <= 5; cy++) world.getTile(cx * 32, cy * 32);

    const after: number[] = [];
    for (let x = -40; x < 40; x++) after.push(world.getTile(x, 7), world.getResourceAmount(x, 7));
    expect(after).toEqual(before);
  });

  it('coerces a seed the way rng.ts does, so one world has one seed', () => {
    const canonical = createWorldGenerator(7)(0, 0);
    for (const equivalent of [7.9, 7 + 2 ** 32]) {
      expect([...createWorldGenerator(equivalent)(0, 0).terrain]).toEqual([...canonical.terrain]);
    }
  });
});

describe('C19 task 2: terrain', () => {
  const area = region(0x7e44a1, 8);

  it('writes only bytes the terrain array may hold', () => {
    for (const value of area.terrain) expect(isTileType(value)).toBe(true);
  });

  it('produces every terrain type, so no band is unreachable', () => {
    const present = new Set(area.terrain);
    expect(present.size).toBe(TILE_TYPE_COUNT);
  });

  it('leaves most of the map buildable, and a meaningful minority not', () => {
    // Water is pillar 4's cheapest obstacle. Too little and the map is graph
    // paper; too much and a factory has nowhere to go. Both directions are
    // balance failures worth noticing before a play session does.
    let water = 0;
    for (const value of area.terrain) if (value === TileType.Water) water += 1;
    const fraction = water / area.terrain.length;
    expect(fraction).toBeGreaterThan(0.03);
    expect(fraction).toBeLessThan(0.4);
  });

  it('puts sand at the water line rather than scattering it inland', () => {
    // Sand is a shoreline, not a desert: a sand tile should have water within
    // a few tiles of it. A generator that ordered its thresholds wrongly would
    // still produce the right *amount* of sand and put it in the wrong place —
    // and a shore band left too wide produces inland sand flats, which is what
    // this caught the first time it ran.
    let sand = 0;
    let coastal = 0;
    for (let y = 6; y < area.height - 6; y++) {
      for (let x = 6; x < area.width - 6; x++) {
        if (area.terrain[y * area.width + x] !== TileType.Sand) continue;
        sand += 1;
        let nearWater = false;
        for (let dy = -6; dy <= 6 && !nearWater; dy++) {
          for (let dx = -6; dx <= 6; dx++) {
            if (area.terrain[(y + dy) * area.width + x + dx] === TileType.Water) {
              nearWater = true;
              break;
            }
          }
        }
        if (nearWater) coastal += 1;
      }
    }
    expect(sand).toBeGreaterThan(100);
    expect(coastal / sand).toBeGreaterThan(0.9);
  });
});

describe('C19 task 3: resource patches', () => {
  const area = region(0x2c0de, 10);
  const found = deposits(area);

  it('places every resource the enum knows about', () => {
    expect([...generatedResources()].sort()).toEqual([...RESOURCE_TYPES].sort());
    const present = new Set(found.map((d) => d.resource));
    for (const resource of RESOURCE_TYPES) {
      expect(present.has(resource), `${resourceName(resource)} is never generated`).toBe(true);
    }
  });

  it('writes only valid resource bytes and amounts the array can hold', () => {
    for (let i = 0; i < area.resource.length; i++) {
      const resource = area.resource[i] as number;
      const amount = area.amount[i] as number;
      expect(isResourceType(resource)).toBe(true);
      expect(Number.isInteger(amount)).toBe(true);
      expect(Object.is(amount, -0)).toBe(false);
      expect(amount).toBeGreaterThanOrEqual(0);
      expect(amount).toBeLessThanOrEqual(MAX_RESOURCE_AMOUNT);
      // §6 R7 in its C09 form: an ore tile with nothing on it would draw an
      // outline a miner cannot use.
      if (resource !== ResourceType.None) expect(amount).toBeGreaterThan(0);
      if (resource === ResourceType.None) expect(amount).toBe(0);
    }
  });

  it('puts no ore under water, which nothing could ever mine', () => {
    for (let i = 0; i < area.terrain.length; i++) {
      if (area.terrain[i] === TileType.Water) expect(area.resource[i]).toBe(ResourceType.None);
    }
  });

  it('varies patch shape, so a long thin patch and a round one both occur', () => {
    // C19 task 3's headline: "patch shape variety matters more for
    // replayability than patch count". Measured as the bounding box's aspect
    // ratio, which is what a player laying out miners actually sees.
    const aspects = found
      .filter((d) => d.tiles >= 12)
      .map((d) => Math.max(d.width, d.height) / Math.min(d.width, d.height));
    expect(aspects.length).toBeGreaterThan(100);
    expect(aspects.filter((a) => a < 1.25).length).toBeGreaterThan(5);
    expect(aspects.filter((a) => a > 2).length).toBeGreaterThan(5);
  });

  it('varies patch size by more than a factor of three', () => {
    const sizes = found.map((d) => d.tiles).sort((a, b) => a - b);
    const small = sizes[Math.floor(sizes.length * 0.1)] as number;
    const large = sizes[Math.floor(sizes.length * 0.9)] as number;
    expect(large / small).toBeGreaterThan(3);
  });

  it('thins each patch from its centre to its rim', () => {
    // C09's four fullness buckets are only legible if a patch is not flat.
    const amounts = new Set<number>();
    for (const value of area.amount) if (value > 0) amounts.add(value);
    expect(amounts.size).toBeGreaterThan(50);
  });

  it('gives each resource its own rich and lean country', () => {
    // The low-frequency density field. Without it the map is confetti: every
    // square of ground holds the same ore as every other, and no direction is
    // worth walking in (pillar 4).
    //
    // Measured **per resource**, because the four fields are independent and
    // summing them cancels most of the effect — an iron desert next door to a
    // copper belt is the interesting case, and the total ore under the two is
    // unremarkable. Which is also why the first version of this test passed
    // on a map that had no clustering at all.
    const block = 64;
    for (const resource of RESOURCE_TYPES) {
      const blocks: number[] = [];
      for (let by = 0; by + block <= area.height; by += block) {
        for (let bx = 0; bx + block <= area.width; bx += block) {
          let ore = 0;
          for (let y = by; y < by + block; y++) {
            for (let x = bx; x < bx + block; x++) {
              if (area.resource[y * area.width + x] === resource) ore += 1;
            }
          }
          blocks.push(ore);
        }
      }
      blocks.sort((a, b) => a - b);
      const lean = blocks[Math.floor(blocks.length * 0.15)] as number;
      const rich = blocks[Math.floor(blocks.length * 0.85)] as number;
      expect(rich, `${resourceName(resource)} is spread evenly`).toBeGreaterThan(lean * 2.5);
    }
  });

  it('does not cut patches off at world-chunk boundaries', () => {
    // The seam bug: a deposit centred in one world chunk must be stamped into
    // its neighbours too, or every patch would end on a multiple of 32. Ore
    // continues across a boundary column at the same rate it continues across
    // an interior one.
    let boundaryPairs = 0;
    let boundaryContinues = 0;
    let interiorPairs = 0;
    let interiorContinues = 0;

    for (let y = 0; y < area.height; y++) {
      for (let x = 0; x + 1 < area.width; x++) {
        const here = area.resource[y * area.width + x] as number;
        if (here === ResourceType.None) continue;
        const next = area.resource[y * area.width + x + 1] as number;
        if ((x + 1) % CHUNK_SIZE === 0) {
          boundaryPairs += 1;
          if (next === here) boundaryContinues += 1;
        } else {
          interiorPairs += 1;
          if (next === here) interiorContinues += 1;
        }
      }
    }

    expect(boundaryPairs).toBeGreaterThan(200);
    const boundary = boundaryContinues / boundaryPairs;
    const interior = interiorContinues / interiorPairs;
    expect(Math.abs(boundary - interior)).toBeLessThan(0.05);
  });
});

describe('C19 task 4: distance-based scaling', () => {
  it('makes patches richer and larger further from the origin', () => {
    // Expansion has to pay, or the map is decoration. Measured at the origin
    // and a thousand tiles out, over enough ground that one lucky patch cannot
    // carry the result.
    const near = deposits(region(0x1a2b3c, 6, -3, -3));
    const far = deposits(region(0x1a2b3c, 6, 30, 30));

    expect(near.length).toBeGreaterThan(20);
    expect(far.length).toBeGreaterThan(10);

    const meanTiles = (list: readonly Deposit[]): number =>
      list.reduce((sum, d) => sum + d.tiles, 0) / list.length;
    const meanPeak = (list: readonly Deposit[]): number =>
      list.reduce((sum, d) => sum + d.peak, 0) / list.length;

    expect(meanTiles(far)).toBeGreaterThan(meanTiles(near) * 1.5);
    expect(meanPeak(far)).toBeGreaterThan(meanPeak(near) * 1.5);
  });

  it('keeps the richest tile within twice a nominal one, as C09 asked', () => {
    // C09 fixed the ore-pile fullness buckets to an absolute scale and asked
    // C19 to revisit that if richness varied by more than about 2x. It does
    // not, and this is what keeps that promise from quietly lapsing.
    const far = region(0x1a2b3c, 4, 60, 60);
    let peak = 0;
    for (const value of far.amount) peak = Math.max(peak, value);
    expect(peak).toBeGreaterThan(700);
    expect(peak).toBeLessThanOrEqual(1000);
  });
});

describe('pillar 2: a new seed is a different run', () => {
  it('disagrees with a neighbouring seed on most of the map', () => {
    const a = region(1000, 4);
    const b = region(1001, 4);

    let sameTerrain = 0;
    let sameResource = 0;
    for (let i = 0; i < a.terrain.length; i++) {
      if (a.terrain[i] === b.terrain[i]) sameTerrain += 1;
      if (a.resource[i] === b.resource[i]) sameResource += 1;
    }

    // Terrain has five types and ore is mostly absent, so agreeing by chance
    // is common; what matters is that the maps are not the *same* map.
    expect(sameTerrain / a.terrain.length).toBeLessThan(0.6);
    expect(sameResource / a.resource.length).toBeLessThan(0.95);
  });

  it('gives the same seed the same map twice', () => {
    const a = region(0xd0d0, 3);
    const b = region(0xd0d0, 3);
    expect([...a.terrain]).toEqual([...b.terrain]);
    expect([...a.resource]).toEqual([...b.resource]);
    expect([...a.amount]).toEqual([...b.amount]);
  });
});
