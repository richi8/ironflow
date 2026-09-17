import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/game/data/items.js';
import { MAX_RESOURCE_AMOUNT, createChunk } from '../../src/game/world/chunk.js';
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

/**
 * C09 — resource patches. See ironflow.md C09.
 *
 * The depletion arithmetic itself lives in `world.test.ts`, because it is
 * `World.consumeResource` and C02 built it. What is new here is the vocabulary
 * on top of it: which byte means which ore, what that ore yields, and how full
 * a tile reads. Whether a generated map produces patches a miner can be built
 * on is C19's question, and it is asked in `world-generator.test.ts`.
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
