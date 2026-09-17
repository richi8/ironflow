import { describe, expect, it } from 'vitest';

import {
  BELT_MAX_POSITION,
  laneAccept,
  newBelt,
  type BeltEntity,
} from '../../src/game/entities/belt-entity.js';
import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { newSplitter } from '../../src/game/entities/splitter-entity.js';
import {
  InserterState,
  newInserter,
  type InserterEntity,
} from '../../src/game/entities/inserter-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { BUILDINGS } from '../../src/game/data/buildings.js';
import { BuildingRegistry, type InserterConfig } from '../../src/game/registries/building-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, WEST } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';

/**
 * Inserters. See ironflow.md C14 and §8 phase 6.
 *
 * The chunk's four tests, in the order the plan lists them:
 *
 * 1. the **full state-machine cycle in exact ticks**;
 * 2. **contention determinism** — two inserters, one item, lowest id wins;
 * 3. **neighbour-removed-mid-swing safety** — no throw, and no lost item;
 * 4. **rate verification** — 1.0 items/s, measured over a simulated minute.
 *
 * Two of the four are about the exact tick an item moves, which is the part of
 * an inserter a player can see and the part a refactor silently breaks: an
 * inserter that takes one tick longer per cycle is 3% slow, which is invisible
 * on screen and ruins every ratio in §15.
 */

/** Grass everywhere, nothing on it. */
function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/** The standard inserter's timings, read from content rather than written twice. */
const CONFIG: InserterConfig = (() => {
  const registry = new BuildingRegistry(BUILDINGS);
  const config = registry.inserterFor(registry.get('inserter').entityType);
  if (config === null) throw new Error('inserter content is missing a rate');
  return config;
})();

const IRON = (() => new Simulation({ world: flatWorld() }).items.idOf('iron_ore'))();

/** How much iron ore is in a chest. */
function stored(chest: ChestEntity): number {
  return chest.contents.find((entry) => entry[0] === IRON)?.[1] ?? 0;
}

describe('the inserter cycle', () => {
  it('divides the rate into four stages that add up to it exactly', () => {
    // The whole reason the rate is exact: a saturated inserter never rests, so
    // one cycle is one item and one cycle is `ticksPerItem` ticks.
    expect(CONFIG.ticksPerItem).toBe(TPS / 1.0);
    expect(CONFIG.pickupTicks + CONFIG.carryTicks + CONFIG.dropTicks + CONFIG.returnTicks).toBe(
      CONFIG.ticksPerItem,
    );
    for (const stage of [CONFIG.pickupTicks, CONFIG.carryTicks, CONFIG.dropTicks, CONFIG.returnTicks]) {
      expect(stage).toBeGreaterThanOrEqual(1);
    }
  });

  it('walks Idle -> Pickup -> Carrying -> Drop -> Returning on the exact tick', () => {
    const simulation = new Simulation({ world: flatWorld() });
    // Facing south: source is the belt at (1, 0), destination the chest at (1, 2).
    const belt = simulation.entities.create<BeltEntity>(newBelt(1, 0, EAST));
    const inserter = simulation.entities.create<InserterEntity>(newInserter(1, 1, 2));
    const chest = simulation.entities.create<ChestEntity>(newChest(1, 2, NORTH));
    laneAccept(belt.items, IRON, BELT_MAX_POSITION);

    // Tick 1 begins the cycle: the source has an item and the chest has room.
    simulation.tick();
    expect(inserter.state).toBe(InserterState.Pickup);
    expect(inserter.stateTicks).toBe(0);
    // Nothing has left the belt yet — the hand closes at the *end* of Pickup.
    expect(belt.items).toHaveLength(1);

    run(simulation, CONFIG.pickupTicks);
    expect(inserter.state).toBe(InserterState.Carrying);
    expect(inserter.heldItem).toBe(IRON);
    expect(belt.items).toHaveLength(0);

    run(simulation, CONFIG.carryTicks);
    expect(inserter.state).toBe(InserterState.Drop);
    expect(inserter.heldItem).toBe(IRON);
    // Still in hand: the item goes in at the *end* of Drop.
    expect(stored(chest)).toBe(0);

    run(simulation, CONFIG.dropTicks);
    expect(inserter.state).toBe(InserterState.Returning);
    expect(inserter.heldItem).toBe(0);
    expect(stored(chest)).toBe(1);

    run(simulation, CONFIG.returnTicks);
    // Nothing left on the belt, so it parks rather than starting another cycle.
    expect(inserter.state).toBe(InserterState.Idle);
    expect(inserter.status).toBe(MachineStatus.Idle);
  });

  it('never rests in Idle while there is work, so the cycle is the rate', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const belt = simulation.entities.create<BeltEntity>(newBelt(1, 0, EAST));
    simulation.entities.create<InserterEntity>(newInserter(1, 1, 2));
    const chest = simulation.entities.create<ChestEntity>(newChest(1, 2, NORTH));

    // Two items waiting, so the second cycle starts the tick the first ends.
    laneAccept(belt.items, IRON, BELT_MAX_POSITION);
    laneAccept(belt.items, IRON, BELT_MAX_POSITION);

    run(simulation, CONFIG.ticksPerItem);
    expect(stored(chest)).toBe(1);
    run(simulation, CONFIG.ticksPerItem);
    expect(stored(chest)).toBe(2);
  });
});

describe('inserter rate', () => {
  it('moves 1.0 items/s from a saturated source, which is §15s anchor', () => {
    const simulation = new Simulation({ world: flatWorld() });
    // A chest full of ore is a source that never runs dry, which isolates the
    // inserter's own rate from anything a belt or a miner is doing.
    const source = simulation.entities.create<ChestEntity>(newChest(1, 0, NORTH));
    source.contents = [[IRON, 500]];
    simulation.entities.create<InserterEntity>(newInserter(1, 1, 2));
    const sink = simulation.entities.create<ChestEntity>(newChest(1, 2, NORTH));

    run(simulation, 60 * TPS);
    // Sixty seconds at one a second. Exact, not approximate: every stage is a
    // whole number of ticks and they sum to the cycle.
    expect(stored(sink)).toBe(60);
    expect(stored(source)).toBe(440);
  });

  it('takes from a miners buffer and puts onto a belt, both without a chest', () => {
    const simulation = new Simulation({
      world: new World((cx, cy) => {
        const chunk = createChunk(cx, cy);
        chunk.resource.fill(ResourceType.Iron);
        chunk.resourceAmount.fill(1000);
        return chunk;
      }),
    });
    // The miner's 2x2 covers (0,0)..(1,1); it faces west, so the belt in front
    // of the inserter is not also its own output side and nothing but the
    // inserter can put anything on that belt.
    const miner = simulation.entities.create<MinerEntity>(newMiner(0, 0, WEST));
    // Facing east at (2, 0): the source behind it is (1, 0), one of the
    // miner's own tiles, and the destination in front is the belt at (3, 0).
    simulation.entities.create<InserterEntity>(newInserter(2, 0, EAST));
    const belt = simulation.entities.create<BeltEntity>(newBelt(3, 0, EAST));
    // A buffer with ore already in it. The resource is set with it, because a
    // miner's buffer holds whatever `resourceType` says it does (C11) and the
    // mining system only ever adopts one while the buffer is empty.
    miner.resourceType = ResourceType.Iron;
    miner.outputCount = 4;

    run(simulation, CONFIG.ticksPerItem);
    expect(miner.outputCount).toBe(3);
    expect(belt.items).toHaveLength(1);
    expect(belt.items[0]?.itemId).toBe(IRON);
  });
});

describe('an inserter that cannot finish', () => {
  it('waits with empty hands and says output_full when the destination is full', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const belt = simulation.entities.create<BeltEntity>(newBelt(1, 0, EAST));
    const inserter = simulation.entities.create<InserterEntity>(newInserter(1, 1, 2));
    const chest = simulation.entities.create<ChestEntity>(newChest(1, 2, NORTH));

    const slots = simulation.buildings.get('chest').storage?.slots ?? 0;
    chest.contents = [[IRON, slots * simulation.items.get('iron_ore').stackSize]];
    laneAccept(belt.items, IRON, BELT_MAX_POSITION);

    run(simulation, CONFIG.ticksPerItem * 3);

    // C14's second acceptance criterion, exactly: empty hands, and a reason.
    expect(inserter.state).toBe(InserterState.Idle);
    expect(inserter.heldItem).toBe(0);
    expect(inserter.status).toBe(MachineStatus.OutputFull);
    // The item it declined to pick up is still where it was.
    expect(belt.items).toHaveLength(1);
  });

  it('returns to idle empty-handed when the source is removed mid-reach', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const belt = simulation.entities.create<BeltEntity>(newBelt(1, 0, EAST));
    const inserter = simulation.entities.create<InserterEntity>(newInserter(1, 1, 2));
    simulation.entities.create<ChestEntity>(newChest(1, 2, NORTH));
    laneAccept(belt.items, IRON, BELT_MAX_POSITION);

    simulation.tick();
    expect(inserter.state).toBe(InserterState.Pickup);

    // Demolished while the arm is still reaching. C14 acceptance 3.
    simulation.commands.enqueue({ type: 'remove', x: 1, y: 0 });
    expect(() => run(simulation, CONFIG.ticksPerItem * 2)).not.toThrow();

    expect(inserter.state).toBe(InserterState.Idle);
    expect(inserter.heldItem).toBe(0);
  });

  it('holds the item rather than destroying it when the destination is removed mid-swing', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const belt = simulation.entities.create<BeltEntity>(newBelt(1, 0, EAST));
    const inserter = simulation.entities.create<InserterEntity>(newInserter(1, 1, 2));
    simulation.entities.create<ChestEntity>(newChest(1, 2, NORTH));
    laneAccept(belt.items, IRON, BELT_MAX_POSITION);

    // Far enough in that the item is out of the belt and in the hand.
    run(simulation, CONFIG.pickupTicks + 1);
    expect(inserter.heldItem).toBe(IRON);

    simulation.commands.enqueue({ type: 'remove', x: 1, y: 2 });
    expect(() => run(simulation, CONFIG.ticksPerItem * 2)).not.toThrow();

    // Nothing in IronFlow deletes an item the player mined, and there is no
    // ground to drop one on (§2). It waits, and says why.
    //
    // `no_destination` since C20, where this used to read `output_full`. The
    // chest is *gone*: nothing will ever take from this arm again until the
    // player builds something under it, and "output full" named a condition
    // that was going to clear itself and never would.
    expect(inserter.state).toBe(InserterState.Drop);
    expect(inserter.heldItem).toBe(IRON);
    expect(inserter.status).toBe(MachineStatus.NoDestination);

    // A new chest under the arm and the held item goes straight in.
    const replacement = simulation.entities.create<ChestEntity>(newChest(1, 2, NORTH));
    run(simulation, 1);
    expect(inserter.heldItem).toBe(0);
    expect(stored(replacement)).toBe(1);
  });

  it('says it has nowhere to put anything, with nothing behind it and nothing in front', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const inserter = simulation.entities.create<InserterEntity>(newInserter(1, 1, 2));

    expect(() => run(simulation, 100)).not.toThrow();
    expect(inserter.state).toBe(InserterState.Idle);
    // C20: the destination is asked about before the source, because an arm
    // pointed at bare ground is misconfigured whether or not there is
    // anything behind it — and "nothing to do" would send the player to look
    // at the wrong end of it.
    expect(inserter.status).toBe(MachineStatus.NoDestination);
    expect(simulation.alerts.take().map((alert) => alert.type)).toEqual(['inserter_no_destination']);
  });

  it('raises the no-destination alert once, not once a tick', () => {
    const simulation = new Simulation({ world: flatWorld() });
    simulation.entities.create<InserterEntity>(newInserter(1, 1, 2));

    run(simulation, 1);
    expect(simulation.alerts.take()).toHaveLength(1);
    run(simulation, 300);
    expect(simulation.alerts.take()).toHaveLength(0);
  });

  it('refuses a miner as a destination, because a miner has no way in', () => {
    const simulation = new Simulation({
      world: new World((cx, cy) => {
        const chunk = createChunk(cx, cy);
        chunk.resource.fill(ResourceType.Iron);
        chunk.resourceAmount.fill(1000);
        return chunk;
      }),
    });
    const source = simulation.entities.create<ChestEntity>(newChest(0, 5, NORTH));
    source.contents = [[IRON, 10]];
    const inserter = simulation.entities.create<InserterEntity>(newInserter(1, 5, EAST));
    simulation.entities.create<MinerEntity>(newMiner(2, 5, NORTH));

    run(simulation, CONFIG.ticksPerItem * 3);
    expect(inserter.state).toBe(InserterState.Idle);
    // C17's complaint, generalised and answered: a miner has no input port and
    // neither does a splitter, so an arm aimed at one waits for ever. Since
    // C20 it says so, in the one status the player can act on (`no_destination`
    // means "turn it round"), and the ore stays where it is either way.
    expect(inserter.status).toBe(MachineStatus.NoDestination);
    expect(stored(source)).toBe(10);
  });

  it('says the same about a splitter, which is what C17 noticed', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const source = simulation.entities.create<ChestEntity>(newChest(0, 5, NORTH));
    source.contents = [[IRON, 10]];
    const inserter = simulation.entities.create<InserterEntity>(newInserter(1, 5, EAST));
    simulation.entities.create(newSplitter(2, 5, EAST));

    run(simulation, CONFIG.ticksPerItem * 3);
    expect(inserter.status).toBe(MachineStatus.NoDestination);
    expect(stored(source)).toBe(10);
  });
});

describe('contention', () => {
  /**
   * Two inserters facing the same chest from opposite sides, both feeding
   * chests of their own. One item in the middle; both reach for it.
   */
  function contest(build: 'lowFirst' | 'highFirst'): {
    simulation: Simulation;
    west: ChestEntity;
    east: ChestEntity;
    middle: ChestEntity;
  } {
    const simulation = new Simulation({ world: flatWorld() });
    const middle = simulation.entities.create<ChestEntity>(newChest(2, 0, NORTH));
    middle.contents = [[IRON, 1]];

    const west = simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    const east = simulation.entities.create<ChestEntity>(newChest(4, 0, NORTH));

    const makeWest = (): void => {
      // At (1, 0) facing west: source is (2, 0), destination (0, 0).
      simulation.entities.create<InserterEntity>(newInserter(1, 0, WEST));
    };
    const makeEast = (): void => {
      // At (3, 0) facing east: source is (2, 0), destination (4, 0).
      simulation.entities.create<InserterEntity>(newInserter(3, 0, EAST));
    };

    if (build === 'lowFirst') {
      makeWest();
      makeEast();
    } else {
      makeEast();
      makeWest();
    }
    return { simulation, west, east, middle };
  }

  it('gives the one item to the lowest entity id, whichever was built first', () => {
    // Built west-then-east, the west inserter has the lower id and wins.
    const low = contest('lowFirst');
    run(low.simulation, CONFIG.ticksPerItem + 1);
    expect(stored(low.west)).toBe(1);
    expect(stored(low.east)).toBe(0);
    expect(stored(low.middle)).toBe(0);

    // Built the other way round, the *east* inserter now holds the lower id —
    // so the item goes east. §6 R6 is about ids, not about geometry, and the
    // point of the rule is that the answer never depends on anything else.
    const high = contest('highFirst');
    run(high.simulation, CONFIG.ticksPerItem + 1);
    expect(stored(high.east)).toBe(1);
    expect(stored(high.west)).toBe(0);
  });

  it('sends the loser back to idle empty-handed rather than stalling it', () => {
    const { simulation } = contest('lowFirst');
    run(simulation, CONFIG.ticksPerItem * 2);

    for (const entity of simulation.entities.byType<InserterEntity>(3)) {
      expect(entity.heldItem).toBe(0);
      expect(entity.state).toBe(InserterState.Idle);
    }
  });

  it('produces the same answer twice, which is what determinism means here', () => {
    const first = contest('lowFirst');
    const second = contest('lowFirst');
    run(first.simulation, 300);
    run(second.simulation, 300);

    expect(JSON.stringify(first.west.contents)).toBe(JSON.stringify(second.west.contents));
    expect(JSON.stringify(first.east.contents)).toBe(JSON.stringify(second.east.contents));
  });
});
