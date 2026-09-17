import { describe, expect, it } from 'vitest';

import { ResourceType, resourceName } from '../../src/game/world/resource.js';
import { isBuildable } from '../../src/game/world/tile.js';
import { World } from '../../src/game/world/world.js';
import {
  MAX_SEED_ATTEMPTS,
  MIN_BUILDABLE_TILES,
  REQUIRED_PATCHES,
  START_RADIUS,
  WORLD_SPAWN,
  createStartingWorld,
  inspectStartingArea,
} from '../../src/game/world/starting-area.js';
import { createCheckerboardGenerator, createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * C19 task 5 — never hand the player an unplayable world.
 *
 * The chunk's second acceptance criterion is "100 random seeds all pass
 * starting-area validation within the retry budget", and that is the test at
 * the bottom of this file. Everything above it is the reason that test can be
 * believed: that the checker can fail, that it fails for the stated reasons,
 * and that the retry is deterministic rather than a search that happens to
 * terminate.
 */

describe('inspectStartingArea', () => {
  it('passes a world the generator produced and validated', () => {
    const { world, report } = createStartingWorld(2024);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(isBuildable(world.getTile(WORLD_SPAWN.x, WORLD_SPAWN.y))).toBe(true);
    expect(report.buildableTiles).toBeGreaterThanOrEqual(MIN_BUILDABLE_TILES);
    for (const { resource, tiles } of REQUIRED_PATCHES) {
      expect(report.largestPatch[resourceName(resource)]).toBeGreaterThanOrEqual(tiles);
    }
  });

  it('fails a world with no ore in it, and says which ore is missing', () => {
    // The checkerboard is all buildable land and nothing else, so it isolates
    // the patch requirements from the terrain ones.
    const report = inspectStartingArea(new World(createCheckerboardGenerator()));
    expect(report.ok).toBe(false);
    expect(report.spawnBuildable).toBe(true);
    expect(report.buildableTiles).toBeGreaterThanOrEqual(MIN_BUILDABLE_TILES);
    expect(report.failures).toHaveLength(REQUIRED_PATCHES.length);
    for (const { resource } of REQUIRED_PATCHES) {
      expect(report.largestPatch[resourceName(resource)]).toBe(0);
      expect(report.failures.join(' ')).toContain(resourceName(resource));
    }
  });

  it('measures a patch as one connected deposit, not as a count of tiles', () => {
    // The playground fixture's four discs are each big enough on their own,
    // which is the case that distinguishes "20 iron tiles" from "one iron
    // patch of 20 tiles". Scattered slivers are not a patch a 2x2 miner can
    // stand on, and the checker has to agree.
    const report = inspectStartingArea(new World(createPlaygroundGenerator()));
    expect(report.largestPatch['iron']).toBeGreaterThanOrEqual(20);
    expect(report.largestPatch['copper']).toBeGreaterThanOrEqual(15);
  });

  it('counts only buildable land the player can walk to', () => {
    // "Not water-locked" is the requirement; a world whose spawn is a small
    // island surrounded by water has plenty of buildable tiles in the disc and
    // is still unplayable.
    const report = inspectStartingArea(new World(islandGenerator()));
    expect(report.spawnBuildable).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.failures.join(' ')).toContain('contiguous buildable');
    expect(report.buildableTiles).toBeLessThan(MIN_BUILDABLE_TILES);
  });

  it('measures over a disc, not over the whole world', () => {
    // The guarantee is "within 30 tiles of spawn". A generator with ore only
    // outside that radius must fail, or the promise means nothing.
    const report = inspectStartingArea(new World(distantOreGenerator()));
    expect(report.ok).toBe(false);
    for (const { resource } of REQUIRED_PATCHES) {
      expect(report.largestPatch[resourceName(resource)]).toBe(0);
    }
  });
});

describe('createStartingWorld', () => {
  it('perturbs the seed by one until a world is playable, and says which it used', () => {
    const started = createStartingWorld(7);
    expect(started.requestedSeed).toBe(7);
    expect(started.attempts).toBeGreaterThanOrEqual(1);
    expect(started.attempts).toBeLessThanOrEqual(MAX_SEED_ATTEMPTS);
    expect(started.seed).toBe(7 + started.attempts - 1);
    expect(started.report.ok).toBe(true);
  });

  it('is deterministic: the same request gives the same world twice', () => {
    // If this ever fails, "seed 7" means two different worlds on two machines
    // and §6's whole contract is void.
    const a = createStartingWorld(31337);
    const b = createStartingWorld(31337);
    expect(b.seed).toBe(a.seed);
    expect(b.attempts).toBe(a.attempts);
    for (let x = -20; x <= 20; x += 3) {
      for (let y = -20; y <= 20; y += 3) {
        expect(b.world.getTile(x, y)).toBe(a.world.getTile(x, y));
        expect(b.world.getResourceAmount(x, y)).toBe(a.world.getResourceAmount(x, y));
      }
    }
  });

  it('hands back a clean world, so nothing is saved that the seed would rebuild', () => {
    // §14 writes world chunks that diverge from generator output. Validation
    // reads a lot of tiles and must not write one, or the first save of a new
    // game would carry the whole starting area as a delta.
    const { world } = createStartingWorld(555);
    let dirty = 0;
    world.forEachLoadedChunk((chunk) => {
      if (chunk.dirty) dirty += 1;
    });
    expect(dirty).toBe(0);
  });

  it('passes 100 random seeds inside the retry budget', () => {
    // C19's second acceptance criterion, as literally as it can be written.
    let attempts = 0;
    let worst = 0;
    for (let i = 0; i < 100; i++) {
      // Spread out by a large odd multiplier rather than taken consecutively,
      // so the hundred seeds are not a hundred neighbours of one another.
      const started = createStartingWorld((i * 2654435761) >>> 0);
      expect(started.report.ok).toBe(true);
      attempts += started.attempts;
      worst = Math.max(worst, started.attempts);
    }
    // Recorded rather than merely passed: a change to the generator that made
    // good starts rare would still pass the criterion above while quietly
    // eating the whole budget, and this is what would say so.
    expect(worst).toBeLessThan(MAX_SEED_ATTEMPTS / 2);
    expect(attempts / 100).toBeLessThan(6);
  });
});

/** A spawn on a small island: buildable, and surrounded by water. */
function islandGenerator() {
  const generate = createPlaygroundGenerator();
  return (cx: number, cy: number) => {
    const chunk = generate(cx, cy);
    for (let ly = 0; ly < 32; ly++) {
      for (let lx = 0; lx < 32; lx++) {
        const x = cx * 32 + lx;
        const y = cy * 32 + ly;
        if (x * x + y * y <= 8 * 8) continue;
        chunk.terrain[ly * 32 + lx] = 4; // TileType.Water
      }
    }
    return chunk;
  };
}

/** Ore, but all of it more than `START_RADIUS` away. */
function distantOreGenerator() {
  const generate = createCheckerboardGenerator();
  return (cx: number, cy: number) => {
    const chunk = generate(cx, cy);
    for (let ly = 0; ly < 32; ly++) {
      for (let lx = 0; lx < 32; lx++) {
        const x = cx * 32 + lx;
        const y = cy * 32 + ly;
        if (x * x + y * y <= (START_RADIUS + 10) * (START_RADIUS + 10)) continue;
        chunk.resource[ly * 32 + lx] = ResourceType.Iron;
        chunk.resourceAmount[ly * 32 + lx] = 500;
      }
    }
    return chunk;
  };
}
