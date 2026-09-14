import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/game/data/items.js';
import { CHUNK_SIZE, MAX_RESOURCE_AMOUNT, createChunk, localIndex } from '../../src/game/world/chunk.js';
import {
  NOMINAL_RESOURCE_AMOUNT,
  NO_BUCKET,
  RESOURCE_BUCKET_COUNT,
  RESOURCE_TYPES,
  RESOURCE_TYPE_COUNT,
  ResourceType,
  isResourceType,
  resourceBucket,
  resourceItemId,
  resourceName,
  resourceProperties,
} from '../../src/game/world/resource.js';
import { TileType } from '../../src/game/world/tile.js';
import { createPlaygroundGenerator } from '../../src/game/world/world-generator.js';

/**
 * C09 — resource patches. See ironflow.md C09.
 *
 * The depletion arithmetic itself lives in `world.test.ts`, because it is
 * `World.consumeResource` and C02 built it. What is new here is the vocabulary
 * on top of it: which byte means which ore, what that ore yields, how full a
 * tile reads, and whether the stub generator produces patches a miner can
 * actually be built on.
 */

describe('ResourceType', () => {
  it('numbers "nothing" zero, so a zero-filled world chunk holds no ore', () => {
    expect(ResourceType.None).toBe(0);
    expect(createChunk(0, 0).resource.every((r) => r === ResourceType.None)).toBe(true);
  });

  it('lists every real resource and excludes the absence of one', () => {
    expect(RESOURCE_TYPES).toHaveLength(RESOURCE_TYPE_COUNT - 1);
    expect(RESOURCE_TYPES).not.toContain(ResourceType.None);
    expect(RESOURCE_TYPES).toEqual([
      ResourceType.Iron,
      ResourceType.Copper,
      ResourceType.Coal,
      ResourceType.Stone,
    ]);
  });

  it('fits every resource in the byte the world chunk stores it in', () => {
    for (const type of RESOURCE_TYPES) expect(type).toBeLessThanOrEqual(255);
  });

  it('gives every resource a distinct name', () => {
    const names = RESOURCE_TYPES.map(resourceName);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The failure this catches is a resource whose ore has no item behind it:
   * C10 and C11 mine `resourceItemId` straight into an inventory, and an id
   * `data/items.ts` has never heard of throws at the registry on the first
   * lump rather than at the content table where the typo is.
   */
  it('yields an item that actually exists, for every resource', () => {
    const known = new Set(ITEMS.map((item) => item.id));
    for (const type of RESOURCE_TYPES) {
      const itemId = resourceItemId(type);
      expect(itemId, resourceName(type)).not.toBeNull();
      expect(known.has(itemId ?? ''), `${resourceName(type)} yields "${itemId ?? ''}"`).toBe(true);
    }
  });

  it('yields nothing from nothing', () => {
    expect(resourceItemId(ResourceType.None)).toBeNull();
  });

  it('accepts exactly the bytes the resource array may hold', () => {
    expect(isResourceType(ResourceType.None)).toBe(true);
    expect(isResourceType(RESOURCE_TYPE_COUNT - 1)).toBe(true);
    expect(isResourceType(RESOURCE_TYPE_COUNT)).toBe(false);
    expect(isResourceType(-1)).toBe(false);
    expect(isResourceType(1.5)).toBe(false);
    expect(isResourceType(Number.NaN)).toBe(false);
  });

  it('throws rather than inventing properties for a byte nothing defines', () => {
    expect(() => resourceProperties(99 as ResourceType)).toThrow(RangeError);
  });
});

describe('resourceBucket', () => {
  it('puts an exhausted tile in no bucket at all', () => {
    // C09 acceptance 2: a depleted tile stops rendering an ore pile. "Thinnest
    // pile" and "no pile" are different pictures, so they are different answers.
    expect(resourceBucket(0)).toBe(NO_BUCKET);
    expect(resourceBucket(-1)).toBe(NO_BUCKET);
  });

  it('splits a full tile into four, thinnest first', () => {
    const quarter = NOMINAL_RESOURCE_AMOUNT / RESOURCE_BUCKET_COUNT;
    expect(resourceBucket(1)).toBe(0);
    expect(resourceBucket(quarter)).toBe(0);
    expect(resourceBucket(quarter + 1)).toBe(1);
    expect(resourceBucket(quarter * 2)).toBe(1);
    expect(resourceBucket(quarter * 2 + 1)).toBe(2);
    expect(resourceBucket(quarter * 3)).toBe(2);
    expect(resourceBucket(quarter * 3 + 1)).toBe(3);
    expect(resourceBucket(NOMINAL_RESOURCE_AMOUNT)).toBe(3);
  });

  it('never leaves the bucket range, however rich the tile', () => {
    // C19 may generate patches richer than nominal; a bucket off the end of
    // the sprite table draws the magenta marker across a whole ore field.
    for (const amount of [1, 37, NOMINAL_RESOURCE_AMOUNT, MAX_RESOURCE_AMOUNT]) {
      const bucket = resourceBucket(amount);
      expect(bucket, String(amount)).toBeGreaterThanOrEqual(0);
      expect(bucket, String(amount)).toBeLessThan(RESOURCE_BUCKET_COUNT);
    }
  });

  it('never reports a fuller tile as thinner than an emptier one', () => {
    let previous = NO_BUCKET;
    for (let amount = 1; amount <= NOMINAL_RESOURCE_AMOUNT * 2; amount += 7) {
      const bucket = resourceBucket(amount);
      expect(bucket).toBeGreaterThanOrEqual(previous);
      previous = bucket;
    }
  });
});

/**
 * The stub patches of C09 task 4. They are scaffolding C19 deletes, but until
 * then they are the only ore in the game, so "a miner can be built and tested"
 * is a property worth holding them to.
 */
describe('the playground patches', () => {
  const generate = createPlaygroundGenerator();

  /** Every tile of the four world chunks around the origin. */
  function eachTile(visit: (resource: number, amount: number, terrain: number) => void): void {
    for (const cx of [-1, 0]) {
      for (const cy of [-1, 0]) {
        const chunk = generate(cx, cy);
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const index = localIndex(lx, ly);
            visit(chunk.resource[index] ?? 0, chunk.resourceAmount[index] ?? 0, chunk.terrain[index] ?? 0);
          }
        }
      }
    }
  }

  it('places one patch of every resource within reach of the origin', () => {
    const found = new Set<number>();
    eachTile((resource) => {
      if (resource !== ResourceType.None) found.add(resource);
    });
    expect([...found].sort()).toEqual([...RESOURCE_TYPES].sort());
  });

  it('never writes a byte that is not a resource, or an amount the array cannot hold', () => {
    eachTile((resource, amount) => {
      expect(isResourceType(resource)).toBe(true);
      expect(amount).toBeGreaterThanOrEqual(0);
      expect(amount).toBeLessThanOrEqual(MAX_RESOURCE_AMOUNT);
    });
  });

  it('leaves no ore tile empty, so a patch outline is always mineable', () => {
    eachTile((resource, amount) => {
      if (resource !== ResourceType.None) expect(amount).toBeGreaterThan(0);
    });
  });

  it('puts no ore under water, which nothing could ever mine', () => {
    eachTile((resource, _amount, terrain) => {
      if (terrain === TileType.Water) expect(resource).toBe(ResourceType.None);
    });
  });

  it('shows every fullness bucket at once, so depletion is visible before it finishes', () => {
    const buckets = new Set<number>();
    eachTile((resource, amount) => {
      if (resource !== ResourceType.None) buckets.add(resourceBucket(amount));
    });
    expect([...buckets].sort()).toEqual([0, 1, 2, 3]);
  });

  it('is pure and positional, so a world chunk visited twice is identical', () => {
    // C19's contract, adopted by the stub: generation order must never change
    // what a world chunk contains, or walking away and back would rewrite it.
    const first = generate(0, 0);
    const second = generate(0, 0);
    expect([...second.resource]).toEqual([...first.resource]);
    expect([...second.resourceAmount]).toEqual([...first.resourceAmount]);
    expect(second.dirty).toBe(false);
  });
});
