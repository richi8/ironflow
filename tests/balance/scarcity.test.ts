import { describe, expect, it } from 'vitest';

import { TPS } from '../../src/game/simulation-clock.js';
import { RESOURCE_TYPES, ResourceType, resourceName } from '../../src/game/world/resource.js';
import { START_RADIUS, WORLD_SPAWN, createStartingWorld } from '../../src/game/world/starting-area.js';
import type { World } from '../../src/game/world/world.js';

/**
 * How long the starting area lasts. See ironflow.md C23 task 1.
 *
 * > Scarcity: starting-area patches must be exhaustible in roughly 2–4 hours
 * > of play, forcing a second mining outpost.
 *
 * The acceptance criterion under it is the weaker and more useful sentence —
 * "a starting-area-only factory visibly runs out of ore in a bounded time" —
 * and this file is what puts a number under both.
 *
 * ## What is measured, and against what
 *
 * The starting area is C19's disc: `START_RADIUS` tiles around spawn, which is
 * the ground a new game is *guaranteed* to be able to build on. Its budget is
 * the sum of every resource tile in it, and the draw it is measured against is
 * a **reference starting factory**, written down below because §19 rule 18
 * says a balance number is re-derived rather than nudged.
 *
 * ## Iron is the binding resource, and that is the finding
 *
 * Measured across 24 seeds, iron runs out first by a wide margin, because it
 * is the only material every recipe in §15 eventually reaches. Copper lasts
 * twice as long at its own draw and stone and coal sit between. So the "2–4
 * hours" in C23's task is a statement about **iron**, and the other three are
 * asserted only against the weaker bound: exhaustible, and not immediately.
 *
 * That is the right shape for the pillar this is serving. What forces the
 * second outpost is the material the factory cannot do without, and a start
 * that ran out of everything at once would be a start that ended rather than
 * one that moved.
 */

/**
 * The ore a starting-area factory draws, in items per second.
 *
 * **Balance numbers**, derived from §15's chains rather than chosen:
 *
 * ```text
 *   iron    4 miners   2.0/s   every recipe in the game ends at iron
 *   copper  2 miners   1.0/s   wire and circuits only — about a quarter of
 *                              iron's draw by §15's bills, but a player lays
 *                              miners in whole numbers
 *   coal    2 miners   1.0/s   furnaces and the generator
 *   stone   1 miner    0.5/s   brick, whose only consumer is `make_furnace`
 * ```
 *
 * Four iron miners is what §15's ratios make a plausible first factory: one
 * miner feeds 1.6 plate furnaces, so four feed six — which is about the size
 * of the smelting column a player has built by the time they are researching.
 */
const STARTING_DRAW: ReadonlyMap<ResourceType, number> = new Map([
  [ResourceType.Iron, 2.0],
  [ResourceType.Copper, 1.0],
  [ResourceType.Coal, 1.0],
  [ResourceType.Stone, 0.5],
]);

/** Seeds measured. Enough that the median is a median and not an anecdote. */
const SEEDS = 24;

/** C23's target band for the binding resource, in hours. */
const TARGET_MIN_HOURS = 2;
const TARGET_MAX_HOURS = 4;

/**
 * Nothing may be gone before this, or a new game ends before it starts.
 */
const FLOOR_HOURS = 0.5;

/**
 * The ceiling on the **binding** resource, on *every* seed and not only the
 * median: iron is what sends the player out of the starting area, so a seed
 * whose iron lasts a working day is a seed with no expansion in it.
 */
const IRON_CEILING_HOURS = 8;

/**
 * The ceiling on the rest, which is looser on purpose.
 *
 * Stone is consumed by `bake_brick` alone and brick by `make_furnace` alone,
 * so a stone patch that lasts fifteen hours is not a balance failure — it is
 * §15's shortest chain being short. What would be a failure is a patch that
 * outlasts any plausible game, because then the starting area is not a place
 * anyone leaves, and pillar 2's "a new seed must force a different factory"
 * dies with it. A day is that line.
 */
const CEILING_HOURS = 24;

const SECONDS_PER_HOUR = 3600;

/** Every unit of one resource inside the starting disc. */
function budget(world: World, resource: ResourceType): number {
  let total = 0;
  for (let y = WORLD_SPAWN.y - START_RADIUS; y <= WORLD_SPAWN.y + START_RADIUS; y++) {
    for (let x = WORLD_SPAWN.x - START_RADIUS; x <= WORLD_SPAWN.x + START_RADIUS; x++) {
      const dx = x - WORLD_SPAWN.x;
      const dy = y - WORLD_SPAWN.y;
      if (dx * dx + dy * dy > START_RADIUS * START_RADIUS) continue;
      if (world.getResource(x, y) !== resource) continue;
      total += world.getResourceAmount(x, y);
    }
  }
  return total;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Hours per resource per seed, measured once and shared by every case below. */
const HOURS: ReadonlyMap<ResourceType, readonly number[]> = (() => {
  const measured = new Map<ResourceType, number[]>();
  for (const resource of RESOURCE_TYPES) measured.set(resource, []);

  for (let seed = 1; seed <= SEEDS; seed++) {
    const { world } = createStartingWorld(seed);
    for (const resource of RESOURCE_TYPES) {
      const draw = STARTING_DRAW.get(resource) ?? 0;
      const hours = draw > 0 ? budget(world, resource) / draw / SECONDS_PER_HOUR : 0;
      measured.get(resource)?.push(hours);
    }
  }

  return measured;
})();

describe('the starting area', () => {
  it('runs a reference factory out of iron in roughly two to four hours', () => {
    const hours = HOURS.get(ResourceType.Iron) ?? [];
    expect(hours).toHaveLength(SEEDS);
    const middle = median(hours);
    expect(middle).toBeGreaterThanOrEqual(TARGET_MIN_HOURS);
    expect(middle).toBeLessThanOrEqual(TARGET_MAX_HOURS);

    // The band is the median's, because seeds vary by design — C19's density
    // field is what makes one map iron country and the next copper country.
    // What every seed owes is the ceiling: none of them may be a start with
    // no reason to leave it.
    for (const [index, value] of hours.entries()) {
      expect(value, `iron on seed ${index + 1}`).toBeLessThan(IRON_CEILING_HOURS);
    }
  });

  it('never hands out a start that ends before it begins, or one that never ends', () => {
    for (const resource of RESOURCE_TYPES) {
      const hours = HOURS.get(resource) ?? [];
      for (const [index, value] of hours.entries()) {
        const where = `${resourceName(resource)} on seed ${index + 1}`;
        // The floor is C19's guarantee cashed as time: every seed passes
        // `inspectStartingArea`, so every seed has a patch worth mining.
        expect(value, where).toBeGreaterThan(FLOOR_HOURS);
        // The ceiling is C23's whole point. A starting area that outlasts the
        // game is a map the player never has to leave, and pillar 2's "a new
        // seed must force a different factory" dies with it.
        expect(value, where).toBeLessThan(CEILING_HOURS);
      }
    }
  });

  it('runs out of iron first, which is why iron is the number that matters', () => {
    const iron = median(HOURS.get(ResourceType.Iron) ?? []);
    for (const resource of RESOURCE_TYPES) {
      if (resource === ResourceType.Iron) continue;
      // Not asserted per seed: a single seed can be iron country or copper
      // country, which is exactly what C19's density field is for. What must
      // hold is the *tendency*, because that is what decides which resource
      // sends the player out of the starting area.
      expect(median(HOURS.get(resource) ?? []), resourceName(resource)).toBeGreaterThan(iron);
    }
  });

  it('is measured against a draw a starting factory could actually have', () => {
    // A guard on the reference itself: the draw table is in items per second
    // and every entry has to be a whole number of §15's tier-1 miners, or the
    // hours above are measured against a factory nobody could build.
    const minerRate = 0.5;
    for (const [resource, draw] of STARTING_DRAW) {
      const miners = draw / minerRate;
      expect(Number.isInteger(miners), resourceName(resource)).toBe(true);
      expect(miners).toBeGreaterThanOrEqual(1);
      expect(miners).toBeLessThanOrEqual(8);
    }
    // And the arithmetic the hours are built on, stated once: a tier-1 miner
    // is 60 ticks an item, which is the 0.5/s §15 anchors everything to.
    expect(Math.round(TPS / minerRate)).toBe(60);
  });
});
