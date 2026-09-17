import { describe, expect, it } from 'vitest';

import { EntityType } from '../../src/game/entities/entity-types.js';
import { newInserter } from '../../src/game/entities/inserter-entity.js';
import { newMachine } from '../../src/game/entities/machine-entity.js';
import { newMiner } from '../../src/game/entities/miner-entity.js';
import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { CHUNK_AREA, createChunk } from '../../src/game/world/chunk.js';
import { NORTH, SOUTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';

/**
 * **The factory builds itself.** C20 task 1, and §15's pillar-1 moment.
 *
 * > Building items being craftable is what lets the factory eventually build
 * > itself — a strong pillar-1 moment, and the reason `make_miner` is worth
 * > its cost.
 *
 * Twenty chunks in, every building in the game came out of a starting kit that
 * `main.ts` handed the player at boot. C20's building recipes end that, and
 * this is the test that says so: ore goes in one end, a **chest** comes out of
 * the other, the player picks it up and places it, and it is a real chest in
 * the world that other buildings can use.
 *
 * ```text
 *   miner -> inserter -> furnace -> inserter -> assembler -> inserter -> chest
 *    iron                smelt_iron            make_chest              (holds chests)
 * ```
 *
 * `make_chest` is the loop's smallest closure: four iron plates, no gear and
 * no circuit, so one assembler is enough to go from ore to a placeable
 * building. Every other building recipe is the same shape one or two steps
 * further along.
 *
 * Headless: no canvas and no DOM (§17).
 */

const MINER = Object.freeze({ x: 4, y: 0 });
const ORE_INSERTER = Object.freeze({ x: 4, y: 2 });
const FURNACE = Object.freeze({ x: 4, y: 3 });
const PLATE_INSERTER = Object.freeze({ x: 4, y: 5 });
const ASSEMBLER = Object.freeze({ x: 4, y: 6 });
const OUT_INSERTER = Object.freeze({ x: 4, y: 9 });
const CHEST = Object.freeze({ x: 4, y: 10 });

/** Where the player stands: in reach of the chest, clear of everything else. */
const STAND = Object.freeze({ x: 6, y: 10 });

/** Where the crafted chest is put down. Clear ground, inside build range. */
const PLACE = Object.freeze({ x: 8, y: 10 });

function oreWorld(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let i = 0; i < CHUNK_AREA; i++) {
      chunk.resource[i] = ResourceType.Iron;
      chunk.resourceAmount[i] = 100_000;
    }
    return chunk;
  });
}

interface Line {
  readonly simulation: Simulation;
  readonly chest: ChestEntity;
  readonly chestItem: number;
}

function buildLine(): Line {
  const simulation = new Simulation({ world: oreWorld() });
  simulation.player.setTilePosition(STAND.x, STAND.y);

  const coal = simulation.items.idOf('coal');
  simulation.entities.create(newMiner(MINER.x, MINER.y, SOUTH));
  simulation.entities.create(newInserter(ORE_INSERTER.x, ORE_INSERTER.y, SOUTH));

  const furnace = newMachine(EntityType.Furnace, FURNACE.x, FURNACE.y, NORTH);
  furnace.recipe = simulation.recipes.get('smelt_iron').recipeId;
  furnace.fuel.push([coal, 50]);
  simulation.entities.create(furnace);

  simulation.entities.create(newInserter(PLATE_INSERTER.x, PLATE_INSERTER.y, SOUTH));

  const assembler = newMachine(EntityType.Assembler, ASSEMBLER.x, ASSEMBLER.y, NORTH);
  assembler.recipe = simulation.recipes.get('make_chest').recipeId;
  simulation.entities.create(assembler);

  simulation.entities.create(newInserter(OUT_INSERTER.x, OUT_INSERTER.y, SOUTH));
  const chest = simulation.entities.create<ChestEntity>(newChest(CHEST.x, CHEST.y, NORTH));

  return { simulation, chest, chestItem: simulation.items.idOf('chest') };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

function held(chest: ChestEntity, itemId: number): number {
  return chest.contents.find((entry) => entry[0] === itemId)?.[1] ?? 0;
}

describe('the factory builds itself (C20)', () => {
  it('turns ore into a placeable chest, unattended', () => {
    const { simulation, chest, chestItem } = buildLine();

    // Four plates a chest, one plate per 3.2 s from one furnace: the first
    // chest is about fifteen seconds after the first plate. Two minutes is
    // several of them and well inside the coal.
    run(simulation, 2 * 60 * TPS);
    expect(held(chest, chestItem)).toBeGreaterThan(0);
  });

  it('lets the player take one out and place it, and it is a real chest', () => {
    const { simulation, chest, chestItem } = buildLine();
    run(simulation, 2 * 60 * TPS);

    // Out of the chest by hand, into the bag — through the command path, so
    // reach and inventory space are the game's own rules and not the test's.
    simulation.commands.enqueue({ type: 'takeItems', entityId: chest.id, itemId: 'chest', amount: 1 });
    run(simulation, 1);
    expect(simulation.commands.takeRejections()).toEqual([]);
    expect(simulation.inventory.count('chest')).toBeGreaterThan(0);

    const before = simulation.inventory.count('chest');
    simulation.commands.enqueue({ type: 'build', buildingId: 'chest', x: PLACE.x, y: PLACE.y, rotation: NORTH });
    run(simulation, 1);
    expect(simulation.commands.takeRejections()).toEqual([]);

    const placed = simulation.entities.at(PLACE.x, PLACE.y);
    expect(placed?.type).toBe(EntityType.Chest);
    // Paid for out of the same bag the assembler filled, which is the whole
    // claim: a build cost and a recipe's product are now the same item.
    expect(simulation.inventory.count('chest')).toBe(before - 1);
    void chestItem;
  });

  it('pays a build cost out of the player’s one inventory, not a second bag', () => {
    // The C08 deviation C16 deferred and C20 closed: `PlayerState.materials`
    // is gone, and `Simulation.inventory` is a view over the slot inventory
    // every other item lives in. Adding a building item through either name
    // must be the same stock.
    const simulation = new Simulation({ world: oreWorld() });
    simulation.inventory.add('chest', 3);
    expect(simulation.player.inventory.count(simulation.items.idOf('chest'))).toBe(3);

    simulation.player.inventory.add(simulation.items.idOf('chest'), 2);
    expect(simulation.inventory.count('chest')).toBe(5);
  });

  it('refuses to demolish when the refund will not fit, rather than voiding it', () => {
    // A slot inventory can be full, and C06's unbounded bag could not. §7's
    // rule is that nothing is ever silently deleted, so a full bag keeps the
    // building standing.
    const simulation = new Simulation({ world: oreWorld() });
    simulation.player.setTilePosition(STAND.x, STAND.y);
    simulation.inventory.add('chest', 1);
    simulation.commands.enqueue({ type: 'build', buildingId: 'chest', x: PLACE.x, y: PLACE.y, rotation: NORTH });
    run(simulation, 1);
    expect(simulation.entities.at(PLACE.x, PLACE.y)).toBeDefined();

    // Fill every slot with something else, leaving nowhere for a chest.
    const plate = simulation.items.idOf('iron_plate');
    while (simulation.player.inventory.freeSlots > 0) simulation.player.inventory.add(plate, 100);

    simulation.commands.enqueue({ type: 'remove', x: PLACE.x, y: PLACE.y });
    run(simulation, 1);
    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['inventory_full']);
    expect(simulation.entities.at(PLACE.x, PLACE.y)).toBeDefined();
  });
});
