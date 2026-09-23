import { describe, expect, it } from 'vitest';

import type { Command } from '../../src/game/commands/command.js';
import { Simulation } from '../../src/game/simulation.js';
import { MAX_STEPS_PER_FRAME } from '../../src/game/simulation-clock.js';
import { EAST } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { createWorldGenerator } from '../../src/game/world/world-generator.js';

import {
  CELL_COUNT,
  ENTITIES_PER_CELL,
  MINE_TILE,
  SCRATCH_TILE,
} from './reference-factory.js';
import { JITTERY, STALLING, STEADY_60, buildScenario, runScenario, type TimedCommand } from './scenario.js';
import { canonicalState, canonicalize, fnv1a, forEachNumber, hashState } from './state-hash.js';

/**
 * §6, made true and kept true. C18 tasks 5–6, and the chunk's four acceptance
 * criteria.
 *
 * ```text
 * same seed + same initial state + same command sequence + same tick count
 *   => byte-identical authoritative state
 * ```
 *
 * The three core tests are the three ways that sentence can be broken by
 * something *outside* it:
 *
 * 1. **identical reruns** — nothing ambient leaks in. A `Math.random`, a
 *    `Date.now`, a `Map` iterated where an array was meant: all of them show
 *    up here as two runs of the same scenario disagreeing.
 * 2. **frame-pattern independence** (§8) — the simulation does not know how
 *    fast the browser is. This is the criterion that makes "production speed
 *    must never depend on FPS" checkable rather than aspirational.
 * 3. **build-order independence** — the order the player happened to build in
 *    is not part of the answer. §8's intra-phase ordering rules exist for this
 *    and this is where they are collectively tested.
 *
 * Plus §6 R7: every number in a serialized state is finite, and none of them
 * is `-0`.
 *
 * ## Why the numbers are what they are
 *
 * 507 entities and 10,000 ticks are C18's acceptance criterion as written.
 * Ten thousand ticks is five and a half simulated minutes, which is long
 * enough for every rate in the factory to have gone round many times — the
 * miner 166 times, the furnace's fuel most of the way through a stack, each
 * splitter's round-robin 160 times — so a drift of one tick in one system
 * cannot hide inside the run.
 */

/**
 * The command script every scenario runs, and the reason it holds no entity ids.
 *
 * §7's union has three members that name an `EntityId` — `rotate`, `setRecipe`
 * and `takeItems`. None of them is here, and that is forced by the
 * build-order test: ids are a function of the order the factory was laid in
 * (§6 R5), so a script that named one would be pointing at a different
 * building in the two runs being compared. Those three commands are covered by
 * C12's and C16's own tests, where the entity is the subject rather than the
 * variable.
 *
 * What is left still touches every other part of the command path: the queue,
 * validation, a placement, a removal, walking, and the world being mined —
 * which is the part a determinism test most wants, because it is the one that
 * writes to a world chunk.
 */
const SCRIPT: readonly TimedCommand[] = Object.freeze([
  { tick: 10, command: { type: 'movePlayer', dx: 1, dy: 0 } satisfies Command },
  { tick: 55, command: { type: 'movePlayer', dx: 0, dy: 0 } satisfies Command },
  { tick: 100, command: { type: 'build', buildingId: 'chest', ...SCRATCH_TILE, rotation: EAST } satisfies Command },
  { tick: 220, command: { type: 'mineTile', ...MINE_TILE } satisfies Command },
  { tick: 640, command: { type: 'stopMining' } satisfies Command },
  { tick: 900, command: { type: 'remove', ...SCRATCH_TILE } satisfies Command },
  { tick: 1200, command: { type: 'movePlayer', dx: 0, dy: -1 } satisfies Command },
  { tick: 1260, command: { type: 'movePlayer', dx: 0, dy: 0 } satisfies Command },
  { tick: 4000, command: { type: 'build', buildingId: 'belt', ...SCRATCH_TILE, rotation: EAST } satisfies Command },
  // C22. The reference factory has no lab, so nothing is *researched* here —
  // what these two put in the hash is the research **queue**, which is
  // authoritative state (§10) that a command writes and a save carries. A
  // queue that reordered itself between two runs would be as much a
  // determinism bug as a belt that did.
  { tick: 5000, command: { type: 'startResearch', technologyId: 'logistics_1' } satisfies Command },
  { tick: 5200, command: { type: 'startResearch', technologyId: 'smelting_2' } satisfies Command },
  { tick: 7000, command: { type: 'cancelResearch', technologyId: 'smelting_2' } satisfies Command },
]);

/** C18's acceptance criterion, as a number. */
const TICKS = 10_000;

/**
 * The seed every scenario below runs on.
 *
 * An arbitrary non-zero number, on purpose: zero is `Simulation`'s default, so
 * a seed that was quietly being dropped somewhere would still produce matching
 * hashes and the tests would pass while carrying no seed at all.
 */
const SEED = 0x51ede5;

describe('the state hash', () => {
  it('sorts object keys, so the same entity written two ways hashes the same', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(fnv1a(canonicalize({ a: 1, b: 2 }))).toBe(fnv1a(canonicalize({ b: 2, a: 1 })));
  });

  it('sees the three numbers JSON hides', () => {
    // §6 R7's whole point: `JSON.stringify` writes 0, null and null for these,
    // so a hash built on it would be blind to exactly the values the rule bans.
    expect(canonicalize(0 - 0)).toBe(canonicalize(0));
    expect(canonicalize(-0)).toBe('-0');
    expect(canonicalize(-0)).not.toBe(canonicalize(0));
    expect(canonicalize(Number.NaN)).toBe('NaN');
    expect(canonicalize(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('notices a single changed field anywhere in the world', () => {
    const a = buildScenario(1, [], 0);
    const b = buildScenario(1, [], 0);
    expect(hashState(b.simulation)).toBe(hashState(a.simulation));

    // One unit of ore, on one tile, out of six world chunks.
    b.simulation.world.consumeResource(0, 0, 1);
    expect(hashState(b.simulation)).not.toBe(hashState(a.simulation));
  });
});

describe('the reference factory', () => {
  it('is the size C18 asks for, and every system is in it', () => {
    const { simulation } = buildScenario(1, [], 0);
    expect(simulation.entities.size).toBe(CELL_COUNT * ENTITIES_PER_CELL);
    expect(simulation.entities.size).toBeGreaterThanOrEqual(500);
  });

  it('actually runs, so the hashes below are of a moving factory', () => {
    const { simulation, game, scheduler } = buildScenario(1, SCRIPT, TICKS);
    game.start();
    for (let i = 0; i < TICKS * 4 && simulation.getTick() < TICKS; i++) scheduler.runFrame(16_667);
    game.stop();

    let inChests = 0;
    simulation.entities.forEach((entity) => {
      // A chest's contents are `[slot, itemId, count]` since chests became grids.
      const contents = (entity as { contents?: readonly (readonly [number, number, number])[] }).contents;
      if (contents !== undefined) for (const stack of contents) inChests += stack[2];
    });
    // A test that hashed a stalled factory ten times would pass and mean
    // nothing, so the run is asserted to have produced something first.
    expect(simulation.getTick()).toBe(TICKS);
    expect(inChests).toBeGreaterThan(1000);
  });
});

describe('§6: same seed, same commands, same ticks', () => {
  it('produces an identical state hash across ten runs', () => {
    const first = runScenario(SEED, SCRIPT, TICKS);
    for (let run = 1; run < 10; run++) {
      expect(runScenario(SEED, SCRIPT, TICKS), `run ${run}`).toBe(first);
    }
  }, 60_000);

  it('produces a different hash for a different command script', () => {
    // The guard on the test above: a hash that ignored the commands would pass
    // it, and would pass it for ever.
    const withScript = runScenario(SEED, SCRIPT, 2_000);
    const without = runScenario(SEED, [], 2_000);
    expect(withScript).not.toBe(without);
  }, 30_000);

  it('produces a different hash for a different tick count', () => {
    expect(runScenario(SEED, SCRIPT, 2_000)).not.toBe(runScenario(SEED, SCRIPT, 2_001));
  }, 30_000);
});

describe('§8: the simulation does not know how fast the browser is', () => {
  it('produces an identical hash under steady, jittery and stalling frames', () => {
    const steady = runScenario(SEED, SCRIPT, TICKS, { pattern: STEADY_60 });
    // 5–120 ms a frame: some frames run no tick at all, some run three.
    expect(runScenario(SEED, SCRIPT, TICKS, { pattern: JITTERY }), 'jittery').toBe(steady);
    // One two-second frame, which §8's clamp cuts to 250 ms and whose debt the
    // step cap then sheds. The ticks lost to it are lost in *wall time*, not
    // in the sequence — the run simply takes more frames to reach ten thousand.
    expect(runScenario(SEED, SCRIPT, TICKS, { pattern: STALLING }), 'stalling').toBe(steady);
  }, 90_000);

  it('drives the three patterns genuinely differently, so the test above is not vacuous', () => {
    const shape = (pattern: (i: number) => number): { frames: number; histogram: number[] } => {
      const { simulation, game, scheduler } = buildScenario(SEED, [], 3_000, { pattern });
      const histogram: number[] = [];
      let frames = 0;
      let last = 0;
      game.start();
      while (simulation.getTick() < 3_000 && frames < 20_000) {
        scheduler.runFrame(pattern(frames));
        const ran = simulation.getTick() - last;
        histogram[ran] = (histogram[ran] ?? 0) + 1;
        last = simulation.getTick();
        frames += 1;
      }
      game.stop();
      return { frames, histogram };
    };

    const steady = shape(STEADY_60);
    const jittery = shape(JITTERY);
    const stalling = shape(STALLING);

    // 60 Hz against 30 TPS is one tick every other frame, and never two.
    expect(steady.histogram.length).toBe(2);
    // Jitter runs anything from no ticks to four in a frame, in a quarter of
    // the frames — if this ever collapsed to the steady shape the comparison
    // above would be three copies of the same run.
    expect(jittery.histogram.length).toBeGreaterThanOrEqual(5);
    expect(jittery.frames).toBeLessThan(steady.frames / 2);
    // And the stall really does hit §8's step cap exactly once.
    expect(stalling.histogram[MAX_STEPS_PER_FRAME]).toBe(1);
  }, 30_000);
});

describe('§8: the order the factory was built in is not part of the answer', () => {
  it('produces an identical layout hash forwards and backwards', () => {
    const forwards = runScenario(SEED, SCRIPT, TICKS, { order: 'forwards', ignoreIds: true });
    const backwards = runScenario(SEED, SCRIPT, TICKS, { order: 'backwards', ignoreIds: true });
    expect(backwards).toBe(forwards);
  }, 60_000);

  it('still gives the two orders different entity ids, so the test above is not vacuous', () => {
    const forwards = buildScenario(SEED, [], 0, { order: 'forwards' });
    const backwards = buildScenario(SEED, [], 0, { order: 'backwards' });
    expect(hashState(backwards.simulation)).not.toBe(hashState(forwards.simulation));
  });
});

describe('§6 R7: no NaN, no Infinity, no -0', () => {
  it('holds for every number in the state after a long run', () => {
    const { simulation, game, scheduler } = buildScenario(SEED, SCRIPT, TICKS);
    game.start();
    for (let i = 0; i < TICKS * 4 && simulation.getTick() < TICKS; i++) scheduler.runFrame(16_667);
    game.stop();

    const bad: string[] = [];
    forEachNumber(canonicalState(simulation), (value, path) => {
      if (!Number.isFinite(value)) bad.push(`${path} = ${String(value)}`);
      if (Object.is(value, -0)) bad.push(`${path} = -0`);
    });
    expect(bad).toEqual([]);
  }, 60_000);

  it('would notice one, so the test above is not vacuous', () => {
    const bad: string[] = [];
    forEachNumber({ a: [1, Number.NaN], b: { c: -0 } }, (value, path) => {
      if (!Number.isFinite(value) || Object.is(value, -0)) bad.push(path);
    });
    expect(bad).toEqual(['$.a[1]', '$.b.c']);
  });
});

/**
 * C19's generator, under §6's contract rather than under its own.
 *
 * `world-generator.test.ts` checks that the generator is positional. This
 * checks the consequence §6 actually cares about: that the *authoritative
 * state* of a world is the same number however the player got there. It is the
 * closest thing to C19's "determinism across the save round-trip" that can be
 * written before C24 exists — and when C24 does exist, the round-trip test
 * compares against this same hash rather than replacing it.
 */
describe('§6: a generated world is the same world however it was explored', () => {
  /** Walk a world's tiles in a given order, generating what that touches. */
  function explore(seed: number, order: readonly { x: number; y: number }[]): Simulation {
    const simulation = new Simulation({ world: new World(createWorldGenerator(seed)), seed });
    for (const { x, y } of order) simulation.world.getTile(x, y);
    return simulation;
  }

  const points: { x: number; y: number }[] = [];
  for (let cy = -2; cy <= 2; cy++) for (let cx = -2; cx <= 2; cx++) points.push({ x: cx * 32, y: cy * 32 });

  it('hashes the same whether the map was walked east-first or west-first', () => {
    const forwards = explore(0xc19, points);
    const backwards = explore(0xc19, [...points].reverse());
    expect(hashState(backwards)).toBe(hashState(forwards));
  });

  it('hashes differently for a different seed, so the test above is not vacuous', () => {
    expect(hashState(explore(0xc19, points))).not.toBe(hashState(explore(0xc1a, points)));
  });

  it('leaves every generated number finite, integral and not -0 (§6 R7)', () => {
    const bad: string[] = [];
    forEachNumber(canonicalState(explore(0xfeed, points)), (value, path) => {
      if (!Number.isFinite(value)) bad.push(`${path} = ${String(value)}`);
      if (Object.is(value, -0)) bad.push(`${path} = -0`);
      if (path.includes('.world') && !Number.isInteger(value)) bad.push(`${path} = ${String(value)}`);
    });
    expect(bad).toEqual([]);
  });
});
