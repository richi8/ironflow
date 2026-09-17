import { describe, expect, it } from 'vitest';

import { RECIPES } from '../../src/game/data/recipes.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { asMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import { ITEMS } from '../../src/game/data/items.js';
import { NO_RECIPE, RecipeRegistry, type RecipeDefinition } from '../../src/game/registries/recipe-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';

/**
 * The assembler. See ironflow.md C16.
 *
 * The chunk's three named tests, and the two acceptance criteria that are
 * about the machine rather than about the chain:
 *
 * 1. **multi-input consumption atomicity** — a craft never takes a partial
 *    set, because a machine that ate one of three ingredients and then stopped
 *    would silently destroy items every time a line ran short;
 * 2. **recipe switching** — safe mid-craft, and it loses nothing (task 2);
 * 3. **the no-special-cases property**, checked the way the plan asks: a
 *    synthetic three-ingredient recipe, added at runtime, that nothing in
 *    `production-system.ts` has ever heard of;
 * 4. an assembler crafts only when *every* ingredient is present, and reports
 *    which one is missing;
 * 5. and task 5's arithmetic: a 1.0 s recipe at crafting speed 0.5 is 60
 *    ticks, rounded once and not per tick.
 *
 * Node, no DOM (§17). `production-system.ts` is shared with C15's furnace and
 * `production-system.test.ts` still owns the smelting half of it.
 */

const ASSEMBLER_TILE = Object.freeze({ x: 4, y: 4 });

/** 1.0 s at crafting speed 0.5 — §15's gear in §15's tier-1 assembler. */
const GEAR_TICKS = 60;

function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

interface Harness {
  readonly simulation: Simulation;
  readonly assembler: MachineEntity;
  readonly ironPlate: number;
  readonly copperPlate: number;
  readonly wire: number;
  readonly gear: number;
}

/**
 * An assembler, built by command, with the player standing beside it.
 *
 * `recipes` is a seam rather than a convenience: test 3 hands in a registry
 * with a recipe `data/recipes.ts` has never contained, which is how "adding a
 * recipe requires no changes to `production-system.ts`" gets checked by
 * something other than reading the file.
 */
function buildAssembler(recipes?: RecipeRegistry): Harness {
  const items = new ItemRegistry(ITEMS);
  const simulation = new Simulation({ world: flatWorld(), items, ...(recipes === undefined ? {} : { recipes }) });
  simulation.player.setTilePosition(ASSEMBLER_TILE.x, ASSEMBLER_TILE.y + 3);
  simulation.inventory.add('assembler', 1);
  simulation.commands.enqueue({ type: 'build', buildingId: 'assembler', ...ASSEMBLER_TILE, rotation: NORTH });
  simulation.tick();

  const entity = simulation.entities.at(ASSEMBLER_TILE.x, ASSEMBLER_TILE.y);
  const assembler = entity === undefined ? null : asMachine(entity, simulation.buildings);
  if (assembler === null) throw new Error('the assembler did not build');
  return {
    simulation,
    assembler,
    ironPlate: items.idOf('iron_plate'),
    copperPlate: items.idOf('copper_plate'),
    wire: items.idOf('copper_wire'),
    gear: items.idOf('gear'),
  };
}

/** Put items straight in the input buffer, the way an inserter would. */
function feed(harness: Harness, itemId: number, count: number): void {
  const existing = harness.assembler.input.find((entry) => entry[0] === itemId);
  if (existing === undefined) harness.assembler.input.push([itemId, count]);
  else existing[1] += count;
  harness.assembler.input.sort((a, b) => a[0] - b[0]);
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

function held(slots: readonly (readonly [number, number])[], itemId: number): number {
  return slots.find((entry) => entry[0] === itemId)?.[1] ?? 0;
}

function setRecipe(harness: Harness, recipeId: string | null): void {
  harness.simulation.commands.enqueue({ type: 'setRecipe', entityId: harness.assembler.id, recipeId });
  harness.simulation.tick();
}

describe('an assembler waits to be told', () => {
  it('makes nothing until it has a recipe, and says so rather than "idle"', () => {
    const harness = buildAssembler();
    feed(harness, harness.copperPlate, 10);

    run(harness.simulation, 5 * TPS);
    // A copper plate names exactly one crafting recipe, so a machine that
    // auto-selected would be making wire by now. This one is waiting.
    expect(harness.assembler.recipe).toBe(NO_RECIPE);
    expect(harness.assembler.status).toBe(MachineStatus.NoRecipe);
    expect(harness.assembler.output).toEqual([]);
  });

  it('keeps the recipe it was given through an empty buffer', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_gear');

    // Ten seconds with nothing to make: a furnace would have dropped the
    // recipe, and an assembler fed a copper plate here must not start on wire.
    run(harness.simulation, 10 * TPS);
    feed(harness, harness.copperPlate, 5);
    run(harness.simulation, 10 * TPS);

    expect(harness.simulation.recipes.byId(harness.assembler.recipe).id).toBe('make_gear');
    expect(harness.assembler.status).toBe(MachineStatus.NoInput);
  });

  it('refuses ingredients that are not its recipe’s, rather than silting up', () => {
    const harness = buildAssembler();
    const bag = harness.simulation.player.inventory;
    bag.add(harness.copperPlate, 5);
    bag.add(harness.ironPlate, 5);
    setRecipe(harness, 'make_gear');

    for (const itemId of ['copper_plate', 'iron_plate']) {
      harness.simulation.commands.enqueue({
        type: 'insertItems',
        entityId: harness.assembler.id,
        itemId,
        amount: 5,
      });
    }
    harness.simulation.tick();

    // Five iron plates went in and the craft that started in the same tick
    // (phase 1 inserts, phase 4 crafts) took two of them. The copper never
    // got in at all, which is the point: a gear assembler beside a copper
    // belt is a machine waiting for plates, not one full of the wrong metal.
    expect(held(harness.assembler.input, harness.ironPlate)).toBe(3);
    expect(held(harness.assembler.input, harness.copperPlate)).toBe(0);
    expect(harness.simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['not_accepted']);
  });
});

describe('crafting at the machine’s own speed', () => {
  it('takes 60 ticks for a 1.0 s recipe at speed 0.5, exactly and repeatedly', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_gear');
    feed(harness, harness.ironPlate, 20);

    run(harness.simulation, GEAR_TICKS - 1);
    expect(held(harness.assembler.output, harness.gear)).toBe(0);

    harness.simulation.tick();
    expect(held(harness.assembler.output, harness.gear)).toBe(1);
    // No idle tick between crafts, so the rate is §15's 0.5 gears a second.
    run(harness.simulation, GEAR_TICKS);
    expect(held(harness.assembler.output, harness.gear)).toBe(2);
    expect(TPS / GEAR_TICKS).toBeCloseTo(0.5, 6);
  });

  it('makes two of something when the recipe says two', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_wire');
    feed(harness, harness.copperPlate, 4);

    // 0.5 s at speed 0.5 is 30 ticks, and one copper plate becomes two wires.
    run(harness.simulation, 30);
    expect(held(harness.assembler.output, harness.wire)).toBe(2);
    expect(held(harness.assembler.input, harness.copperPlate)).toBe(3);
  });

  it('runs a recipe unchanged in a machine of a different speed', () => {
    // The same arithmetic from the other side: the *recipe* is 30 ticks and
    // the assembler's 60 is the machine's half speed applied to it, not a
    // number stored anywhere in the content table.
    const harness = buildAssembler();
    expect(harness.simulation.recipes.get('make_gear').durationTicks).toBe(30);
    expect(harness.simulation.crafts.ticksFor(harness.assembler.type, harness.simulation.recipes.get('make_gear').recipeId)).toBe(
      GEAR_TICKS,
    );
  });
});

describe('multi-input recipes', () => {
  it('waits for every ingredient and never consumes a partial set', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_circuit');
    // Three wires and no iron plate: two of the three ingredients present is
    // not "start and see", it is "wait".
    feed(harness, harness.wire, 3);

    run(harness.simulation, 5 * TPS);
    expect(held(harness.assembler.input, harness.wire)).toBe(3);
    expect(harness.assembler.progressTicks).toBe(0);
    expect(harness.assembler.status).toBe(MachineStatus.NoInput);

    feed(harness, harness.ironPlate, 1);
    harness.simulation.tick();
    // Both taken, in the same tick, or neither.
    expect(held(harness.assembler.input, harness.wire)).toBe(0);
    expect(held(harness.assembler.input, harness.ironPlate)).toBe(0);

    run(harness.simulation, GEAR_TICKS - 1);
    expect(held(harness.assembler.output, harness.simulation.items.idOf('circuit'))).toBe(1);
  });

  it('runs a three-ingredient recipe nothing in the codebase has heard of', () => {
    // C16's test instruction, literally: a synthetic recipe added at runtime.
    // It is not in `data/recipes.ts`, no building names it, and the only thing
    // that makes it work is that `production-system.ts` never asks what it is.
    const synthetic: RecipeDefinition = {
      id: 'make_widget',
      inputs: [
        { itemId: 'gear', count: 2 },
        { itemId: 'circuit', count: 1 },
        { itemId: 'copper_wire', count: 4 },
      ],
      outputs: [{ itemId: 'steel', count: 3 }],
      seconds: 2.0,
      category: 'crafting',
    };
    const items = new ItemRegistry(ITEMS);
    const harness = buildAssembler(new RecipeRegistry([...RECIPES, synthetic], items));
    setRecipe(harness, 'make_widget');

    feed(harness, harness.gear, 2);
    feed(harness, harness.simulation.items.idOf('circuit'), 1);
    feed(harness, harness.wire, 4);

    // 2.0 s at speed 0.5 is 120 ticks, by the same division as every other row.
    run(harness.simulation, 120);
    expect(held(harness.assembler.output, harness.simulation.items.idOf('steel'))).toBe(3);
    expect(harness.assembler.input).toEqual([]);
    // And it stops rather than starting a fourth-ingredient-short second one.
    harness.simulation.tick();
    expect(harness.assembler.status).toBe(MachineStatus.NoInput);
  });
});

describe('switching a recipe', () => {
  it('hands the ingredients back to the player and loses nothing', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_gear');
    feed(harness, harness.ironPlate, 10);
    run(harness.simulation, 10);

    setRecipe(harness, 'make_wire');

    const bag = harness.simulation.player.inventory;
    // Eight left in the buffer plus the two already in the fire: all ten come
    // back, which is the difference between "safe" and "usually safe".
    expect(bag.count(harness.ironPlate)).toBe(10);
    expect(harness.assembler.input).toEqual([]);
    expect(harness.assembler.progressTicks).toBe(0);
    expect(harness.simulation.recipes.byId(harness.assembler.recipe).id).toBe('make_wire');
  });

  it('gives back a craft that was already under way', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_circuit');
    feed(harness, harness.wire, 3);
    feed(harness, harness.ironPlate, 1);
    // Far enough in that the ingredients are spent and the circuit is not made.
    run(harness.simulation, 20);
    expect(harness.assembler.input).toEqual([]);
    expect(harness.assembler.progressTicks).toBe(20);

    setRecipe(harness, 'make_gear');

    const bag = harness.simulation.player.inventory;
    expect(bag.count(harness.wire)).toBe(3);
    expect(bag.count(harness.ironPlate)).toBe(1);
    expect(harness.assembler.progressTicks).toBe(0);
  });

  it('leaves the fuel of a machine that burns something alone', () => {
    // A furnace can be told what to smelt too, and its coal is not an
    // ingredient of anything — handing it back would punish the player for
    // changing their mind about the plates.
    const simulation = new Simulation({ world: flatWorld() });
    simulation.player.setTilePosition(6, 8);
    simulation.inventory.add('furnace', 1);
    simulation.commands.enqueue({ type: 'build', buildingId: 'furnace', x: 6, y: 6, rotation: NORTH });
    simulation.tick();
    const entity = simulation.entities.at(6, 6);
    const furnace = entity === undefined ? null : asMachine(entity, simulation.buildings);
    if (furnace === null) throw new Error('the furnace did not build');

    const coal = simulation.items.idOf('coal');
    furnace.fuel.push([coal, 5]);
    furnace.input.push([simulation.items.idOf('iron_ore'), 3]);
    simulation.commands.enqueue({ type: 'setRecipe', entityId: furnace.id, recipeId: 'bake_brick' });
    simulation.tick();

    expect(held(furnace.fuel, coal)).toBe(5);
    expect(simulation.player.inventory.count(simulation.items.idOf('iron_ore'))).toBe(3);
  });

  it('is a no-op when the recipe is the one it is already making', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_gear');
    feed(harness, harness.ironPlate, 10);
    run(harness.simulation, 10);

    setRecipe(harness, 'make_gear');

    // A panel that re-sends the selected recipe must not empty the machine.
    expect(held(harness.assembler.input, harness.ironPlate)).toBe(8);
    expect(harness.assembler.progressTicks).toBe(11);
    expect(harness.simulation.player.inventory.count(harness.ironPlate)).toBe(0);
  });

  it('can be told to make nothing, which empties it', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_gear');
    feed(harness, harness.ironPlate, 6);
    run(harness.simulation, 5);

    setRecipe(harness, null);

    expect(harness.assembler.recipe).toBe(NO_RECIPE);
    expect(harness.simulation.player.inventory.count(harness.ironPlate)).toBe(6);
    expect(harness.assembler.status).toBe(MachineStatus.NoRecipe);
  });
});

describe('refusing a setRecipe', () => {
  it('names the reason, and changes nothing', () => {
    const harness = buildAssembler();
    setRecipe(harness, 'make_gear');
    feed(harness, harness.ironPlate, 4);

    const reasons = (): readonly string[] =>
      harness.simulation.commands.takeRejections().map((rejection) => rejection.reason);
    reasons();

    // A recipe no registry has, and one this machine's category cannot run.
    setRecipe(harness, 'make_antimatter');
    expect(reasons()).toEqual(['unknown_recipe']);
    setRecipe(harness, 'smelt_iron');
    expect(reasons()).toEqual(['not_accepted']);

    // A building that runs no recipes at all.
    harness.simulation.inventory.add('chest', 1);
    harness.simulation.commands.enqueue({ type: 'build', buildingId: 'chest', x: 4, y: 8, rotation: NORTH });
    harness.simulation.tick();
    const chest = harness.simulation.entities.at(4, 8);
    if (chest === undefined) throw new Error('the chest did not build');
    harness.simulation.commands.enqueue({ type: 'setRecipe', entityId: chest.id, recipeId: 'make_gear' });
    harness.simulation.tick();
    expect(reasons()).toEqual(['not_accepted']);

    // Through all of it the assembler kept its recipe and its plates.
    expect(harness.simulation.recipes.byId(harness.assembler.recipe).id).toBe('make_gear');
    expect(held(harness.assembler.input, harness.ironPlate)).toBeGreaterThan(0);
  });

  it('tells the player to walk closer rather than reaching across the map', () => {
    const harness = buildAssembler();
    harness.simulation.player.setTilePosition(ASSEMBLER_TILE.x + 40, ASSEMBLER_TILE.y);
    setRecipe(harness, 'make_gear');

    expect(harness.assembler.recipe).toBe(NO_RECIPE);
    expect(harness.simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['out_of_reach']);
  });

  it('is refused for a machine that is gone', () => {
    const harness = buildAssembler();
    harness.simulation.entities.remove(harness.assembler.id);
    harness.simulation.tick();
    setRecipe(harness, 'make_gear');

    expect(harness.simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['unknown_entity']);
  });
});
