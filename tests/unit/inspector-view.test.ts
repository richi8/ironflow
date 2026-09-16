import { describe, expect, it } from 'vitest';

import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { MachineStatus, MACHINE_STATUS_COUNT, machineStatusName } from '../../src/game/entities/machine-status.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { RATE_WINDOW_TICKS } from '../../src/game/production.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * The inspector's view models. See ironflow.md C12.
 *
 * The chunk's test list, minus the panel itself:
 *
 * - **view-model construction for each status** — every member of
 *   `MachineStatus` has a `MachineView` that says which it is, so the panel's
 *   text table can never be handed a status it has no sentence for;
 * - **rate-average correctness** over a real miner rather than a hand-driven
 *   window (`production-rate.test.ts` covers the arithmetic);
 * - **frozen view models** — the inspector holds a photograph, not a handle.
 *
 * And the two acceptance criteria the panel cannot carry on its own: a stalled
 * machine always names a reason, and the inspector changes the world only by
 * dispatching a command.
 *
 * Node, no DOM: everything here is `game/`, which must run with `document`
 * deleted (§4, §17).
 */

/** The miner's 2x2 patch, and the tile the player stands on beside it. */
const PATCH = Object.freeze({ x: 4, y: 4 });
const STANDING = Object.freeze({ x: 3, y: 3 });

function testWorld(amountPerTile = 1000): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        if (x < PATCH.x || x > PATCH.x + 1 || y < PATCH.y || y > PATCH.y + 1) continue;
        const index = localIndex(lx, ly);
        chunk.resource[index] = ResourceType.Iron;
        chunk.resourceAmount[index] = amountPerTile;
      }
    }
    return chunk;
  });
}

interface Harness {
  readonly simulation: Simulation;
  readonly controller: GameController;
  readonly cursor: DetachedCursor;
  readonly miner: MinerEntity;
}

/** A miner on the patch, selected, with the player standing within reach. */
function inspecting(world = testWorld()): Harness {
  const simulation = new Simulation({ world });
  simulation.player.setTilePosition(STANDING.x, STANDING.y);
  const miner = simulation.entities.create<MinerEntity>(newMiner(PATCH.x, PATCH.y, NORTH));

  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const cursor = new DetachedCursor();
  const controller = new GameController({ game, cursor });
  cursor.setSelectedEntity(miner.id);
  // Settle the selection before the test looks: `pump()` is what turns a
  // change of cursor into an event, and a harness that has never pumped would
  // make the miner's own selection the first event every test sees.
  controller.pump();

  return { simulation, controller, cursor, miner };
}

/**
 * Put `count` items in the miner's buffer.
 *
 * One tick first, because a miner adopts its resource on its first tick (C11)
 * and a buffer is only ever "full of" whatever `resourceType` says. Filling one
 * that has never run would be filling it with nothing.
 */
function fillBuffer(harness: Harness, count: number): void {
  run(harness, 1);
  harness.miner.outputCount = count;
}

/** Run `ticks` ticks, pumping once a tick as the render loop would. */
function run(harness: Harness, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    harness.simulation.tick();
    harness.controller.pump();
  }
}

function view(harness: Harness) {
  const machine = harness.controller.getInspectorView();
  if (machine === null) throw new Error('nothing is selected');
  return machine;
}

describe('status, for every status there is', () => {
  it('has a view-model answer for each member of the enum', () => {
    const { controller, simulation, miner } = inspecting();

    // Not a list of the four C11 can reach: the panel's text table is keyed by
    // every name the enum can produce, so a status C15 or C21 adds must reach
    // the view intact rather than arriving as `undefined`.
    for (let status = 0; status < MACHINE_STATUS_COUNT; status++) {
      miner.status = status;
      expect(controller.getBuildingView(miner.id)?.status).toBe(machineStatusName(status));
    }
    expect(simulation.entities.size).toBe(1);
  });

  it('never reports a stalled machine as idle', () => {
    const harness = inspecting(testWorld(1));

    // Four tiles with one ore each: four items, then nothing left.
    run(harness, 4 * 60 + 1);
    expect(view(harness).status).toBe('no_resource');

    // And the stall the other direction: a full buffer, which C11 says stops
    // the miner. Both are specific reasons; neither is the word "idle".
    harness.miner.status = MachineStatus.OutputFull;
    expect(view(harness).status).toBe('output_full');
  });

  it('calls a building with nothing to do idle, and gives it no bar or rate', () => {
    const { simulation, controller, cursor } = inspecting();
    const chest = simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    cursor.setSelectedEntity(chest.id);

    const machine = controller.getInspectorView();
    expect(machine?.status).toBe('idle');
    // A chest is not 0% of the way through something at 0 items a minute — it
    // has no progress and no output at all, and the panel draws neither row.
    expect(machine?.progress).toBeNull();
    expect(machine?.ratePerMinute).toBeNull();
    expect(machine?.outputs).toEqual([]);
  });
});

describe('the view model itself', () => {
  it('is frozen all the way down', () => {
    const harness = inspecting();
    run(harness, 61);

    const machine = view(harness);
    expect(Object.isFrozen(machine)).toBe(true);
    expect(Object.isFrozen(machine.outputs)).toBe(true);
    expect(Object.isFrozen(machine.outputs[0])).toBe(true);

    const selection = harness.controller.getSelectionView();
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it('names the item and its buffer capacity, so the panel need not ask', () => {
    const harness = inspecting();
    run(harness, 61);

    expect(view(harness).outputs).toEqual([
      { itemId: 'iron_ore', name: 'Iron Ore', count: 1, capacity: 50 },
    ]);
  });

  it('carries the rotated footprint, so the outline fits the building', () => {
    const harness = inspecting();
    expect(harness.controller.getSelectionView()).toEqual({
      entityId: harness.miner.id,
      x: PATCH.x,
      y: PATCH.y,
      width: 2,
      height: 2,
    });
  });

  it('says whether the player can reach it', () => {
    const harness = inspecting();
    expect(view(harness).inReach).toBe(true);

    harness.simulation.player.setTilePosition(STANDING.x + 40, STANDING.y);
    expect(view(harness).inReach).toBe(false);
  });
});

describe('the measured rate', () => {
  it('reads a steady miner at the rate the content table says', () => {
    const harness = inspecting();
    // A full window of production, sampled once per tick by `pump()`.
    run(harness, RATE_WINDOW_TICKS * 2);

    // §15's tier-1 anchor is 0.5 items/s, which is 30 a minute.
    expect(view(harness).ratePerMinute).toBeCloseTo(30, 6);
  });

  it('is measured for the selected machine and nobody else', () => {
    const harness = inspecting();
    const other = harness.simulation.entities.create<MinerEntity>(newMiner(PATCH.x, PATCH.y + 4, NORTH));
    run(harness, RATE_WINDOW_TICKS);

    expect(view(harness).ratePerMinute).toBeGreaterThan(0);
    // The other miner is running too. Its rate is simply not being measured,
    // and a figure borrowed from the selected one would be a lie about it.
    expect(harness.controller.getBuildingView(other.id)?.ratePerMinute).toBe(0);
  });

  it('starts again when the player selects a different machine', () => {
    const harness = inspecting();
    const other = harness.simulation.entities.create<MinerEntity>(newMiner(PATCH.x, PATCH.y + 4, NORTH));
    run(harness, RATE_WINDOW_TICKS);

    harness.cursor.setSelectedEntity(other.id);
    harness.controller.pump();
    expect(harness.controller.getInspectorView()?.ratePerMinute).toBe(0);
  });

  it('is derived: nothing about it reaches the machine', () => {
    const harness = inspecting();
    run(harness, 120);

    // The counter lives beside the simulation rather than on the entity, so a
    // save written from this world (C24) carries no measurement at all.
    expect(Object.keys(harness.miner).sort()).toEqual(
      ['id', 'outputCount', 'progressTicks', 'resourceType', 'rotation', 'status', 'tileCursor', 'type', 'x', 'y'].sort(),
    );
    expect(harness.simulation.production.totalFor(harness.miner.id)).toBe(2);
  });
});

describe('selection', () => {
  it('drops a selection whose machine has been demolished, and says so once', () => {
    const harness = inspecting();
    const events: (number | null)[] = [];
    harness.controller.subscribe('selectionChanged', (event) => events.push(event.entityId));

    harness.simulation.entities.remove(harness.miner.id);
    run(harness, 1);

    expect(harness.controller.getSelection()).toBeNull();
    expect(harness.controller.getInspectorView()).toBeNull();
    expect(harness.controller.getSelectionView()).toBeNull();
    expect(events).toEqual([null]);

    // And not again on every following frame.
    run(harness, 5);
    expect(events).toEqual([null]);
  });

  it('forgets a demolished machine\'s production counter', () => {
    const harness = inspecting();
    run(harness, 61);
    expect(harness.simulation.production.size).toBe(1);

    harness.simulation.entities.remove(harness.miner.id);
    run(harness, 1);
    expect(harness.simulation.production.size).toBe(0);
  });

  it('announces a change exactly once, whichever way it was made', () => {
    const harness = inspecting();
    const events: (number | null)[] = [];
    harness.controller.subscribe('selectionChanged', (event) => events.push(event.entityId));

    harness.cursor.setSelectedEntity(null);
    harness.controller.pump();
    harness.controller.pump();
    harness.cursor.setSelectedEntity(harness.miner.id);
    harness.controller.pump();

    expect(events).toEqual([null, harness.miner.id]);
  });
});

describe('manual transfer (C12 task 5)', () => {
  it('empties a miner into the player\'s bag, through a command', () => {
    const harness = inspecting();
    const { simulation, controller, miner } = harness;
    const ironOre = simulation.items.idOf('iron_ore');

    run(harness, 3 * 60);
    expect(miner.outputCount).toBe(3);

    // `takeItems` puts a command in the queue and changes nothing yet: §7's
    // whole point, and C12's "cannot mutate simulation state except via
    // commands" stated as an assertion.
    controller.takeItems(miner.id, 'iron_ore', 3);
    expect(miner.outputCount).toBe(3);
    expect(simulation.player.inventory.count(ironOre)).toBe(0);

    run(harness, 1);
    expect(miner.outputCount).toBe(0);
    expect(simulation.player.inventory.count(ironOre)).toBe(3);
  });

  it('lets a full miner start again, which is C11\'s criterion with a way to do it', () => {
    const harness = inspecting();
    const { simulation, controller, miner } = harness;
    const capacity = simulation.buildings.miningFor(miner.type)?.bufferCapacity ?? 0;

    fillBuffer(harness, capacity);
    run(harness, 1);
    expect(view(harness).status).toBe('output_full');

    controller.takeItems(miner.id, 'iron_ore', capacity);
    run(harness, 1);
    expect(miner.outputCount).toBe(0);
    expect(view(harness).status).toBe('running');

    // And it really is producing again, not merely saying so.
    run(harness, 60);
    expect(miner.outputCount).toBeGreaterThan(0);
  });

  it('refuses a take the player has walked away from', () => {
    const harness = inspecting();
    run(harness, 60);

    harness.simulation.player.setTilePosition(STANDING.x + 40, STANDING.y);
    harness.controller.takeItems(harness.miner.id, 'iron_ore', 1);
    harness.simulation.tick();

    expect(harness.simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['out_of_reach']);
  });

  it('gives a reason for every other way a transfer can fail', () => {
    const harness = inspecting();
    const { simulation, controller, miner } = harness;

    controller.takeItems(9999, 'iron_ore', 1);
    controller.takeItems(miner.id, 'iron_ore', 1); // the buffer is empty
    controller.takeItems(miner.id, 'coal', 1); // not what it is holding
    controller.insertItems(miner.id, 'iron_ore', 1); // a miner has no input
    simulation.tick();

    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual([
      'unknown_entity',
      'nothing_to_take',
      'nothing_to_take',
      'not_accepted',
    ]);
  });

  it('takes what fits and leaves the rest in the machine', () => {
    const harness = inspecting();
    const { simulation, controller, miner } = harness;
    const ironOre = simulation.items.idOf('iron_ore');

    fillBuffer(harness, 40);
    // A bag with room for five. The transfer is partial and honest (C08)
    // rather than all-or-nothing: what fits moves and the rest stays put,
    // because ore that vanished between the two would be ore the player has
    // no way to account for.
    const bag = simulation.player.inventory;
    bag.add(ironOre, bag.spaceFor(ironOre) - 5);
    expect(bag.spaceFor(ironOre)).toBe(5);
    const before = bag.count(ironOre);

    controller.takeItems(miner.id, 'iron_ore', 40);
    run(harness, 1);

    expect(bag.count(ironOre)).toBe(before + 5);
    expect(miner.outputCount).toBeGreaterThanOrEqual(35);
  });

  it('refuses when there is nowhere to put the ore', () => {
    const harness = inspecting();
    const { simulation, controller, miner } = harness;
    const ironOre = simulation.items.idOf('iron_ore');

    fillBuffer(harness, 5);
    const bag = simulation.player.inventory;
    bag.add(ironOre, bag.spaceFor(ironOre));

    controller.takeItems(miner.id, 'iron_ore', 1);
    // `tick()` without a `pump()`: pumping is what drains the rejection list
    // into events, and this assertion wants the list itself.
    simulation.tick();

    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['inventory_full']);
    expect(miner.outputCount).toBeGreaterThanOrEqual(5);
  });

  it('counts production where it happens, not where it is stored', () => {
    const harness = inspecting();
    run(harness, 2 * 60);
    expect(harness.simulation.production.totalFor(harness.miner.id)).toBe(2);

    harness.controller.takeItems(harness.miner.id, 'iron_ore', 2);
    run(harness, 1);

    // Emptying the buffer must not read as negative production: the rate is
    // measured from a number that only ever rises.
    expect(harness.miner.outputCount).toBe(0);
    expect(harness.simulation.production.totalFor(harness.miner.id)).toBe(2);
  });
});

describe('the tick rate the whole thing is measured against', () => {
  it('is 30, so 300 ticks is the ten seconds C12 asks for', () => {
    expect(RATE_WINDOW_TICKS).toBe(10 * TPS);
  });
});
