import { describe, expect, it } from 'vitest';

import type { Command } from '../../src/game/commands/command.js';
import { assertSerializable } from '../../src/game/entities/entity.js';
import { deserialize, serialize } from '../../src/game/save/save-serializer.js';
import { Simulation } from '../../src/game/simulation.js';
import { CHUNK_SIZE } from '../../src/game/world/chunk.js';
import { EAST } from '../../src/game/world/coordinates.js';

import {
  ENTITIES_PER_CELL,
  MINE_TILE,
  PLAYER_TILE,
  SCRATCH_TILE,
  layReferenceFactory,
  oreEverywhere,
  referenceWorld,
} from './reference-factory.js';
import { canonicalSavedState, forEachNumber, hashSavedState, hashState } from './state-hash.js';

/**
 * §6 R8, which C24 finally makes checkable. The chunk's first acceptance
 * criterion, written the way the rule states it:
 *
 * ```text
 * run N ticks            -> state A
 * run N/2, save, load,
 *   run N/2 more         -> state B
 * assert A == B
 * ```
 *
 * This is the test that catches "we forgot to serialize that" — the entire
 * class of bug that is otherwise found by a player three weeks later, with no
 * reproduction and half a factory missing. Every field a system adds from here
 * on is covered by it for free, provided the field is in the save; a field
 * that is *not* makes this fail on the next run.
 *
 * ## Why the hash is `hashSavedState` and not `hashState`
 *
 * The two differ in exactly one thing that is not state: which **clean** world
 * chunks happen to be resident in memory. A world chunk exists from the moment
 * something reads a tile in it, and a save writes only the dirty ones — a
 * clean one is by construction what the generator produces, so regenerating it
 * is the same as loading it. Run A therefore still holds the ground the player
 * walked across at tick 40; run B regenerates only the ground the factory is
 * standing on. See `state-hash.ts`, which keeps both hashes for that reason.
 *
 * ## Why the factory is 5,005 entities
 *
 * C24's acceptance says 5,000, and the reference factory's cell is 13
 * entities, so 385 cells is the first size at or above it. It is the same
 * layout C18 measures — a miner, four belts, a splitter, two chests, two
 * inserters and a furnace per cell — because a save test over a factory of
 * nothing but belts would pass while a furnace's part-burnt fuel quietly reset
 * to zero.
 */

/** 385 cells x 13 entities: the first size at or above C24's 5,000. */
const CELLS = 385;

/**
 * Long enough for every system to be mid-something at the save point.
 *
 * At tick 400 — the halfway mark — the miners are part-way through a lump, the
 * furnaces are part-way through a plate and part-way through a coal, the belts
 * are carrying items between tiles at fixed-point positions, the splitters
 * have a cursor on one side and the player is part-way through mining a tile.
 * Those are the fields a save is most likely to drop, and the test below
 * asserts that they really are in flight rather than trusting this paragraph:
 * the first three hundred ticks are the ore walking down the belt, and a save
 * point chosen before that would prove nothing about a furnace.
 */
const TICKS = 800;

/** The seed, non-zero so a dropped one cannot pass unnoticed. */
const SEED = 0xc24;

/**
 * The script, in the form C18's is and for the same reason: no command here
 * names an entity id.
 *
 * It straddles the save point deliberately. At tick 400 the player is
 * part-way through mining a tile and has two technologies queued, so the load
 * has to restore a mining target, its progress and the queue — not merely a
 * set of buildings. The walk and the placement come after, so that the
 * commands applied *to a loaded world* are the ones the second half runs.
 */
const SCRIPT: readonly { readonly tick: number; readonly command: Command }[] = Object.freeze([
  { tick: 10, command: { type: 'mineTile', ...MINE_TILE } satisfies Command },
  { tick: 200, command: { type: 'startResearch', technologyId: 'logistics_1' } satisfies Command },
  { tick: 380, command: { type: 'startResearch', technologyId: 'smelting_2' } satisfies Command },
  { tick: 430, command: { type: 'stopMining' } satisfies Command },
  { tick: 440, command: { type: 'movePlayer', dx: 1, dy: 0 } satisfies Command },
  { tick: 480, command: { type: 'movePlayer', dx: 0, dy: 0 } satisfies Command },
  { tick: 600, command: { type: 'build', buildingId: 'chest', ...SCRATCH_TILE, rotation: EAST } satisfies Command },
  { tick: 700, command: { type: 'remove', ...SCRATCH_TILE } satisfies Command },
]);

/** The reference factory, `CELLS` cells of it, with a player standing clear. */
function factory(cells = CELLS): Simulation {
  const simulation = new Simulation({ world: referenceWorld(), seed: SEED });
  simulation.player.setTilePosition(PLAYER_TILE.x, PLAYER_TILE.y);
  // Enough to pay for what the script builds; a refused `build` is a
  // deterministic nothing, which is exactly what a test must not measure.
  simulation.inventory.add('chest', 4);
  simulation.inventory.add('belt', 4);
  layReferenceFactory(simulation, 'forwards', cells);
  return simulation;
}

/**
 * Advance from tick `from` to tick `to`, applying the script as it goes.
 *
 * Commands are enqueued before the tick they are due on, which is where
 * `ScriptedSimulation` puts them — but through the plain `Simulation`, because
 * a loaded world is a plain one and a harness subclass could not be on both
 * sides of the save.
 */
function run(simulation: Simulation, from: number, to: number): void {
  for (let tick = from + 1; tick <= to; tick++) {
    for (const timed of SCRIPT) {
      if (timed.tick === tick) simulation.commands.enqueue(timed.command);
    }
    simulation.tick();
  }
}

/**
 * Load a save back, with the fixture's generator rather than C19's.
 *
 * The reference factory's world is ore on every tile (`oreEverywhere`), which
 * is what makes it a test of saving rather than a second test of the noise
 * fields. `deserialize` defaults to the generator this build ships, so the
 * fixture has to say which one its seed means — the same injection point C27
 * uses to pin an old generator to an old save.
 */
function reload(state: ReturnType<typeof serialize>): Simulation {
  return deserialize(state, { worldGenerator: () => oreEverywhere() });
}

describe('§6 R8: a save round trip is a determinism test', () => {
  it('reaches the same state whether or not the world was saved halfway', () => {
    const uninterrupted = factory();
    run(uninterrupted, 0, TICKS);

    const interrupted = factory();
    run(interrupted, 0, TICKS / 2);
    const loaded = reload(serialize(interrupted));
    run(loaded, TICKS / 2, TICKS);

    expect(loaded.getTick()).toBe(TICKS);
    expect(hashSavedState(loaded)).toBe(hashSavedState(uninterrupted));
  });

  it('is measuring a factory that was mid-everything at the save point', () => {
    // Without this the test above could pass over a world that had settled
    // into doing nothing, which is the shape a round-trip test fails to catch
    // bugs in. Each of these is a field the save has to carry.
    const simulation = factory();
    run(simulation, 0, TICKS / 2);
    const state = serialize(simulation);

    const midProgress = state.entities.filter((entity) => Number(entity['progressTicks'] ?? 0) > 0);
    const onBelts = state.entities.filter((entity) => (entity['items'] as unknown[] | undefined)?.length);
    expect(midProgress.length).toBeGreaterThan(0);
    expect(onBelts.length).toBeGreaterThan(0);
    expect(state.player.miningTicks).toBeGreaterThan(0);
    expect(state.research.queue.length).toBeGreaterThan(0);
    expect(state.chunkDeltas.length).toBeGreaterThan(0);
  });

  it('would notice a single dropped field, so the test above is not vacuous', () => {
    const simulation = factory(2);
    run(simulation, 0, 250);

    const honest = reload(serialize(simulation));
    const state = serialize(simulation);
    // One furnace forgets how far through its coal it was: the exact shape of
    // the bug §6 R8 exists to find.
    const lying = {
      ...state,
      entities: state.entities.map((entity) =>
        entity['fuelTicksRemaining'] === undefined ? entity : { ...entity, fuelTicksRemaining: 0 },
      ),
    };

    expect(hashSavedState(honest)).toBe(hashSavedState(simulation));
    expect(hashSavedState(reload(lying))).not.toBe(hashSavedState(simulation));
  });

  it('carries the counters no sub-object owns: tick, RNG position and next id', () => {
    const simulation = factory(2);
    run(simulation, 0, 250);
    const loaded = reload(serialize(simulation));

    expect(loaded.getTick()).toBe(simulation.getTick());
    expect(loaded.rng.state).toBe(simulation.rng.state);
    expect(loaded.seed).toBe(simulation.seed);
    // §6 R5: a restored world must not hand a new building the id of one that
    // was demolished before the save.
    expect(loaded.entities.nextId).toBe(simulation.entities.nextId);
    expect(loaded.entities.nextId).toBeGreaterThan(simulation.entities.size);
  });

  it('leaves the reloaded world running identically from the load onward', () => {
    // The round trip above compares one point. This compares the *derivative*:
    // a world whose power networks or belt order were rebuilt wrongly would
    // match at the load and diverge a tick later.
    const simulation = factory(8);
    run(simulation, 0, 400);
    const loaded = reload(serialize(simulation));

    for (let i = 0; i < 300; i++) {
      simulation.tick();
      loaded.tick();
      if (hashSavedState(loaded) !== hashSavedState(simulation)) {
        throw new Error(`the reloaded world diverged ${i + 1} tick(s) after the load.`);
      }
    }
    expect(hashSavedState(loaded)).toBe(hashSavedState(simulation));
  });
});

describe('§14: the world is a seed plus deltas', () => {
  it('regenerates untouched terrain rather than storing it', () => {
    const simulation = factory(4);
    run(simulation, 0, 300);
    // A world chunk that exists only because something looked at it — which is
    // most of a played map, and all of what the renderer has drawn.
    simulation.world.getTile(20 * CHUNK_SIZE, 20 * CHUNK_SIZE);

    const state = serialize(simulation);
    // Every world chunk the factory reads is resident; only the ones it has
    // mined are written. If these ever became equal, the save would be
    // carrying regenerable terrain and the 2 MB budget would go with it.
    expect(state.chunkDeltas.length).toBeGreaterThan(0);
    expect(state.chunkDeltas.length).toBeLessThan(simulation.world.chunkCount);
    expect(state.chunkDeltas.some((delta) => delta.cx === 20 && delta.cy === 20)).toBe(false);
  });

  it('produces identical terrain for a world chunk that was never touched', () => {
    const simulation = factory(4);
    run(simulation, 0, 200);
    const loaded = reload(serialize(simulation));

    // A world chunk well away from the factory: absent from both worlds until
    // this line asks, and then generated from the seed on both sides.
    const live = simulation.world.getChunk(20, 20);
    const restored = loaded.world.getChunk(20, 20);
    expect([...restored.terrain]).toEqual([...live.terrain]);
    expect([...restored.resource]).toEqual([...live.resource]);
    expect([...restored.resourceAmount]).toEqual([...live.resourceAmount]);
    expect(restored.dirty).toBe(false);
  });

  it('brings a mined-out patch back mined out, tile for tile', () => {
    const simulation = factory(4);
    run(simulation, 0, 300);
    const loaded = reload(serialize(simulation));

    let compared = 0;
    simulation.world.forEachLoadedChunk((chunk) => {
      if (!chunk.dirty) return;
      const restored = loaded.world.getChunk(chunk.cx, chunk.cy);
      expect([...restored.resourceAmount]).toEqual([...chunk.resourceAmount]);
      expect([...restored.resource]).toEqual([...chunk.resource]);
      expect([...restored.terrain]).toEqual([...chunk.terrain]);
      expect(restored.dirty).toBe(true);
      compared += 1;
    });
    expect(compared).toBeGreaterThan(0);
  });

  it('keeps the explored set, which nothing else could recover', () => {
    const simulation = factory(2);
    simulation.world.explored.revealSquare(3, -4, 2);
    run(simulation, 0, 60);
    const loaded = reload(serialize(simulation));

    expect(loaded.world.explored.keysAscending()).toEqual(simulation.world.explored.keysAscending());
    expect(loaded.world.explored.bounds()).toEqual(simulation.world.explored.bounds());
    // Revealing ground must still not generate it (C23, §14).
    expect(loaded.world.chunkCount).toBeLessThan(loaded.world.explored.size);
  });
});

describe('C24: the serialized state is plain data', () => {
  it('holds no class, Map, Set, undefined, cycle or -0 anywhere in it', () => {
    const simulation = factory(20);
    run(simulation, 0, 300);
    simulation.world.explored.revealSquare(0, 0, 3);

    // The same structural check every entity passes on creation, run over the
    // whole document: C24's fourth acceptance criterion, and the one that
    // keeps `JSON.stringify` from silently altering a save (§14).
    expect(() => assertSerializable(serialize(simulation), 'save')).not.toThrow();
  });

  it('survives JSON unchanged, which is what a save file actually is', () => {
    const simulation = factory(20);
    run(simulation, 0, 300);
    const state = serialize(simulation);

    const throughJson = JSON.parse(JSON.stringify(state)) as typeof state;
    expect(throughJson).toEqual(state);
    expect(hashSavedState(reload(throughJson))).toBe(hashSavedState(simulation));
  });

  it('writes every number finite, and none of them -0 (§6 R7)', () => {
    const simulation = factory(20);
    run(simulation, 0, 300);

    const bad: string[] = [];
    forEachNumber(serialize(simulation), (value, path) => {
      if (!Number.isFinite(value)) bad.push(`${path} = ${String(value)}`);
      if (Object.is(value, -0)) bad.push(`${path} = -0`);
    });
    expect(bad).toEqual([]);
  });

  it('writes entities in id order, so two equal states serialize identically', () => {
    // C24 task 6. The ids themselves come out of the store; what is asserted
    // here is that the serializer does not reorder them, because the §6 R8
    // hash compares the documents and not the worlds behind them.
    const simulation = factory(3);
    run(simulation, 0, 60);
    const ids = serialize(simulation).entities.map((entity) => entity.id);

    expect(ids.length).toBe(3 * ENTITIES_PER_CELL);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('writes the same bytes twice for the same world', () => {
    const simulation = factory(3);
    run(simulation, 0, 60);
    expect(JSON.stringify(serialize(simulation))).toBe(JSON.stringify(serialize(simulation)));
  });

  it('does not alias the live world, so a save taken now can be written later', () => {
    // C25 writes asynchronously while the factory keeps running. A shallow
    // copy would hand the writer the same `items` array the belt system is
    // still pushing onto.
    const simulation = factory(3);
    run(simulation, 0, 120);
    const state = serialize(simulation);
    const before = JSON.stringify(state);

    run(simulation, 120, 240);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('refuses to run inside a tick (§14)', () => {
    // A save taken mid-tick has belts that have moved and inserters that have
    // not. There is no way to load one back into a world a tick could produce.
    const simulation = factory(1);
    let caught: unknown = null;
    const sabotage = { type: 'movePlayer' as const, dx: 1 as const, dy: 0 as const };
    simulation.commands.enqueue(sabotage);
    // The only place inside a tick a test can reach: a lookup the command
    // phase makes. `world.getTile` is called by the player system mid-tick.
    const world = simulation.world;
    const realGetTile = world.getTile.bind(world);
    world.getTile = (x: number, y: number) => {
      try {
        serialize(simulation);
      } catch (error) {
        caught = error;
      }
      return realGetTile(x, y);
    };
    simulation.tick();
    world.getTile = realGetTile;

    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain('between ticks');
  });
});

describe('C24 task 4: rebuildDerived is idempotent', () => {
  it('changes nothing when it is run again on a loaded world', () => {
    const simulation = factory(8);
    run(simulation, 0, 200);
    const loaded = reload(serialize(simulation));

    const before = hashState(loaded);
    loaded.rebuildDerived();
    loaded.rebuildDerived();
    expect(hashState(loaded)).toBe(before);
  });

  it('changes nothing when it is run on a world that never left memory', () => {
    const simulation = factory(8);
    run(simulation, 0, 200);

    const before = hashState(simulation);
    simulation.rebuildDerived();
    expect(hashState(simulation)).toBe(before);
    // And the world keeps running the same way afterwards, which is the part
    // a hash taken at one instant cannot see.
    const control = factory(8);
    run(control, 0, 200);
    run(control, 200, 260);
    run(simulation, 200, 260);
    expect(canonicalSavedState(simulation)).toEqual(canonicalSavedState(control));
  });
});
