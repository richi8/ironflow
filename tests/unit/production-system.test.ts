import { describe, expect, it } from 'vitest';

import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { asMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { NO_RECIPE } from '../../src/game/registries/recipe-registry.js';
import { World } from '../../src/game/world/world.js';

/**
 * The production system. See ironflow.md C15 tasks 2–6 and §8 phase 4.
 *
 * The chunk's four unit tests, in the order the plan lists them:
 *
 * 1. **recipe completion in exact ticks** — 3.2 s is 96 ticks and 96 is what
 *    it takes, for ever, because a rate that is one tick per craft slow is 1%
 *    out and invisible until §15's ratios stop holding;
 * 2. **fuel consumption and pause/resume** — task 4's promise that a supply
 *    gap costs time and never progress;
 * 3. **output blocking** — task 6's "hold the finished item";
 * 4. and the thing tasks 2 and 5 are really about: that none of this knows
 *    what a furnace is.
 */

const FURNACE_TILE = Object.freeze({ x: 4, y: 4 });

/** Grass with nothing on it — a furnace needs no terrain of its own. */
function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

interface Harness {
  readonly simulation: Simulation;
  readonly furnace: MachineEntity;
  readonly coal: number;
  readonly ore: number;
  readonly plate: number;
}

function buildFurnace(): Harness {
  const simulation = new Simulation({ world: flatWorld() });
  simulation.player.setTilePosition(FURNACE_TILE.x, FURNACE_TILE.y + 2);
  simulation.inventory.add('furnace', 1);
  simulation.commands.enqueue({ type: 'build', buildingId: 'furnace', ...FURNACE_TILE, rotation: NORTH });
  simulation.tick();

  const entity = simulation.entities.at(FURNACE_TILE.x, FURNACE_TILE.y);
  const furnace = entity === undefined ? null : asMachine(entity, simulation.buildings);
  if (furnace === null) throw new Error('the furnace did not build');
  return {
    simulation,
    furnace,
    coal: simulation.items.idOf('coal'),
    ore: simulation.items.idOf('iron_ore'),
    plate: simulation.items.idOf('iron_plate'),
  };
}

/** Put items straight in the buffers, the way an inserter would. */
function feed(harness: Harness, ore: number, coal: number): void {
  if (ore > 0) harness.furnace.input.push([harness.ore, ore]);
  if (coal > 0) harness.furnace.fuel.push([harness.coal, coal]);
  harness.furnace.input.sort((a, b) => a[0] - b[0]);
  harness.furnace.fuel.sort((a, b) => a[0] - b[0]);
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

function held(slots: readonly (readonly [number, number])[], itemId: number): number {
  return slots.find((entry) => entry[0] === itemId)?.[1] ?? 0;
}

const SMELT_TICKS = 96; // 3.2 s at 30 TPS — C15 task 5.
const COAL_TICKS = 8 * TPS; // One coal burns for 8 s — C15 task 4.

describe('a furnace with everything it needs', () => {
  it('smelts one plate every 96 ticks, exactly', () => {
    const harness = buildFurnace();
    feed(harness, 10, 10);

    run(harness.simulation, SMELT_TICKS - 1);
    expect(held(harness.furnace.output, harness.plate)).toBe(0);
    expect(harness.furnace.progressTicks).toBe(SMELT_TICKS - 1);

    harness.simulation.tick();
    expect(held(harness.furnace.output, harness.plate)).toBe(1);
    expect(harness.furnace.progressTicks).toBe(0);

    // And the next craft takes the same 96, with no idle tick between them:
    // a saturated machine's rate is the recipe's, not the recipe's plus one.
    run(harness.simulation, SMELT_TICKS);
    expect(held(harness.furnace.output, harness.plate)).toBe(2);
  });

  it('consumes one ore per craft, at the start, and reports running', () => {
    const harness = buildFurnace();
    feed(harness, 3, 10);

    harness.simulation.tick();
    expect(held(harness.furnace.input, harness.ore)).toBe(2);
    expect(harness.furnace.status).toBe(MachineStatus.Running);

    run(harness.simulation, SMELT_TICKS);
    expect(held(harness.furnace.input, harness.ore)).toBe(1);
  });

  it('picks its own recipe from what it is fed, and says so', () => {
    const harness = buildFurnace();
    expect(harness.furnace.recipe).toBe(NO_RECIPE);

    feed(harness, 1, 1);
    harness.simulation.tick();
    expect(harness.simulation.recipes.byId(harness.furnace.recipe).id).toBe('smelt_iron');
  });

  it('smelts copper in the same furnace with no code that knows about copper', () => {
    const harness = buildFurnace();
    const copperOre = harness.simulation.items.idOf('copper_ore');
    harness.furnace.input.push([copperOre, 2]);
    feed(harness, 0, 5);

    run(harness.simulation, SMELT_TICKS);
    expect(held(harness.furnace.output, harness.simulation.items.idOf('copper_plate'))).toBe(1);
  });

  it('makes a multi-ingredient recipe, taking all five plates at once', () => {
    const harness = buildFurnace();
    harness.furnace.input.push([harness.plate, 7]);
    feed(harness, 0, 20);

    harness.simulation.tick();
    expect(held(harness.furnace.input, harness.plate)).toBe(2);
    run(harness.simulation, 5 * SMELT_TICKS - 1);
    expect(held(harness.furnace.output, harness.simulation.items.idOf('steel'))).toBe(1);
    // Two plates left is not five, so the next tick stops rather than starting
    // a craft it cannot pay for.
    harness.simulation.tick();
    expect(harness.furnace.status).toBe(MachineStatus.NoInput);
    expect(held(harness.furnace.input, harness.plate)).toBe(2);
  });
});

describe('a furnace that is short of something', () => {
  it('sits idle with no ore, and burns no fuel while it waits', () => {
    const harness = buildFurnace();
    feed(harness, 0, 5);

    run(harness.simulation, 10 * TPS);
    expect(harness.furnace.status).toBe(MachineStatus.NoInput);
    expect(held(harness.furnace.fuel, harness.coal)).toBe(5);
    expect(harness.furnace.fuelTicksRemaining).toBe(0);
  });

  it('pauses progress when the fuel runs out and resumes exactly where it stopped', () => {
    const harness = buildFurnace();
    // One coal is 240 ticks of burn; a plate needs 96, so the third craft
    // stalls part-way through with 240 - 2*96 = 48 ticks of coal spent on it.
    feed(harness, 10, 1);

    run(harness.simulation, COAL_TICKS);
    expect(held(harness.furnace.output, harness.plate)).toBe(2);
    expect(harness.furnace.progressTicks).toBe(COAL_TICKS - 2 * SMELT_TICKS);
    expect(harness.furnace.fuelTicksRemaining).toBe(0);

    // Ten seconds of nothing: the status says why, and the progress is kept.
    const stalled = harness.furnace.progressTicks;
    run(harness.simulation, 10 * TPS);
    expect(harness.furnace.status).toBe(MachineStatus.NoFuel);
    expect(harness.furnace.progressTicks).toBe(stalled);
    expect(held(harness.furnace.output, harness.plate)).toBe(2);

    // Feed it, and the craft finishes in exactly the ticks it had left.
    feed(harness, 0, 1);
    run(harness.simulation, SMELT_TICKS - stalled - 1);
    expect(held(harness.furnace.output, harness.plate)).toBe(2);
    harness.simulation.tick();
    expect(held(harness.furnace.output, harness.plate)).toBe(3);
  });

  it('raises an alert the first tick it runs dry, and not every tick after', () => {
    const harness = buildFurnace();
    feed(harness, 10, 0);

    run(harness.simulation, 5 * TPS);
    const alerts = harness.simulation.alerts.take();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.type).toBe('machine_no_fuel');
  });

  it('holds the finished item when the output is full, and delivers it the moment there is room', () => {
    const harness = buildFurnace();
    const capacity = harness.simulation.buildings.get('furnace').production?.outputCapacity ?? 0;
    feed(harness, 200, 200);
    harness.furnace.output.push([harness.plate, capacity - 1]);

    // One more craft fills it, and the next one finishes with nowhere to go.
    run(harness.simulation, 2 * SMELT_TICKS);
    expect(held(harness.furnace.output, harness.plate)).toBe(capacity);
    expect(harness.furnace.progressTicks).toBe(SMELT_TICKS);
    expect(harness.furnace.status).toBe(MachineStatus.OutputFull);

    // It stays finished rather than losing the craft or eating another ore.
    const oreLeft = held(harness.furnace.input, harness.ore);
    run(harness.simulation, 5 * TPS);
    expect(harness.furnace.progressTicks).toBe(SMELT_TICKS);
    expect(held(harness.furnace.input, harness.ore)).toBe(oreLeft);

    // Make room, and the held plate lands in the same tick.
    harness.furnace.output.splice(0, harness.furnace.output.length);
    harness.simulation.tick();
    expect(held(harness.furnace.output, harness.plate)).toBe(1);
    expect(harness.furnace.progressTicks).toBe(1);
  });
});

describe('the furnace as the player sees it', () => {
  it('shows its ingredients, its fuel and its plates in the inspector', () => {
    const harness = buildFurnace();
    feed(harness, 4, 2);
    run(harness.simulation, SMELT_TICKS);

    const inputs = harness.simulation.hands.inputsOf(harness.furnace);
    expect(inputs.map((stack) => [stack.itemId, stack.count, stack.capacity])).toEqual([
      [harness.ore, 3, 50],
      [harness.coal, 1, 50],
    ]);
    const outputs = harness.simulation.hands.outputsOf(harness.furnace);
    expect(outputs.map((stack) => [stack.itemId, stack.count])).toEqual([[harness.plate, 1]]);
  });

  it('takes coal from the players hand and refuses what it cannot use', () => {
    const harness = buildFurnace();
    const bag = harness.simulation.player.inventory;
    bag.add(harness.coal, 4);
    bag.add(harness.plate, 2);
    bag.add(harness.simulation.items.idOf('brick'), 1);

    harness.simulation.commands.enqueue({
      type: 'insertItems',
      entityId: harness.furnace.id,
      itemId: 'coal',
      amount: 3,
    });
    // A brick is neither fuel nor any smelting recipe's ingredient.
    harness.simulation.commands.enqueue({
      type: 'insertItems',
      entityId: harness.furnace.id,
      itemId: 'brick',
      amount: 1,
    });
    harness.simulation.tick();

    expect(held(harness.furnace.fuel, harness.coal)).toBe(3);
    expect(bag.count(harness.coal)).toBe(1);
    expect(harness.simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['not_accepted']);
  });

  it('takes ore from the hand too, which is the command C12 had to refuse outright', () => {
    const harness = buildFurnace();
    harness.simulation.player.inventory.add(harness.ore, 1);
    harness.simulation.commands.enqueue({
      type: 'insertItems',
      entityId: harness.furnace.id,
      itemId: 'iron_ore',
      amount: 1,
    });
    harness.simulation.tick();
    // The furnace does take ore — this is the control for the miner case,
    // which `inspector-view.test.ts` owns.
    expect(held(harness.furnace.input, harness.ore)).toBe(1);
  });
});
