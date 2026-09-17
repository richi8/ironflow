import { describe, expect, it } from 'vitest';

import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newInserter } from '../../src/game/entities/inserter-entity.js';
import { newMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { Simulation } from '../../src/game/simulation.js';
import { EAST, NORTH } from '../../src/game/world/coordinates.js';
import { CHUNK_AREA, createChunk } from '../../src/game/world/chunk.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { handSourceOf, outputPortOf } from '../../src/game/items/item-port.js';

/**
 * Stall alerts, and the two things C20 changed about them. Task 5.
 *
 * The vocabulary grew by two — `inserter_no_destination` and
 * `machine_no_recipe` — and the rule for what earns one is in
 * `game/views/alert.ts`: the player has to be able to **do** something, and
 * the condition must not clear on its own. `output_full` fails that test and
 * deliberately gets nothing, which is what the last case here pins.
 */

function world(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let i = 0; i < CHUNK_AREA; i++) {
      chunk.resource[i] = ResourceType.Iron;
      chunk.resourceAmount[i] = 1000;
    }
    return chunk;
  });
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

describe('a machine nobody told what to make (C20)', () => {
  it('says so once, in the panel and in a toast', () => {
    const simulation = new Simulation({ world: world() });
    const assembler = simulation.entities.create<MachineEntity>(
      newMachine(EntityType.Assembler, 0, 0, NORTH),
    );

    run(simulation, 1);
    expect(assembler.status).toBe(MachineStatus.NoRecipe);
    expect(simulation.alerts.take().map((alert) => alert.type)).toEqual(['machine_no_recipe']);

    // On the transition, not once a tick: the condition is true for every tick
    // that follows, and a toast per tick is how a legible game becomes an
    // unreadable one (C11's rule, unchanged).
    run(simulation, 300);
    expect(simulation.alerts.take()).toEqual([]);
  });

  it('stops saying it once the player answers', () => {
    const simulation = new Simulation({ world: world() });
    const assembler = simulation.entities.create<MachineEntity>(
      newMachine(EntityType.Assembler, 0, 0, NORTH),
    );
    run(simulation, 1);
    simulation.alerts.take();

    assembler.recipe = simulation.recipes.get('make_gear').recipeId;
    run(simulation, 1);
    expect(assembler.status).not.toBe(MachineStatus.NoRecipe);
    expect(simulation.alerts.take()).toEqual([]);
  });
});

describe('a full output raises nothing (C20)', () => {
  it('is what a working factory looks like, so it gets no toast', () => {
    const simulation = new Simulation({ world: world() });
    // A furnace with a full output and no inserter taking from it. It stalls,
    // the panel says `output_full`, and the player is told nothing — because
    // a consumer catching up is the ordinary course of events.
    const furnace = simulation.entities.create<MachineEntity>(
      newMachine(EntityType.Furnace, 0, 0, NORTH),
    );
    furnace.recipe = simulation.recipes.get('smelt_iron').recipeId;
    furnace.fuel.push([simulation.items.idOf('coal'), 50]);
    furnace.input.push([simulation.items.idOf('iron_ore'), 50]);
    furnace.output.push([simulation.items.idOf('iron_plate'), 50]);

    // Long enough to finish the craft it was mid-way through and then find
    // there is nowhere for the plate to go.
    run(simulation, 200);
    expect(furnace.status).toBe(MachineStatus.OutputFull);
    expect(simulation.alerts.take()).toEqual([]);
  });
});

describe('the hand may take from an input buffer; an inserter may not (C20)', () => {
  function furnaceWithOre(simulation: Simulation): MachineEntity {
    const furnace = simulation.entities.create<MachineEntity>(
      newMachine(EntityType.Furnace, 4, 4, NORTH),
    );
    furnace.recipe = simulation.recipes.get('smelt_iron').recipeId;
    furnace.input.push([simulation.items.idOf('iron_ore'), 10]);
    return furnace;
  }

  it('hands ingredients back to a player standing next to the machine', () => {
    const simulation = new Simulation({ world: world() });
    const furnace = furnaceWithOre(simulation);
    simulation.player.setTilePosition(4, 6);

    simulation.commands.enqueue({
      type: 'takeItems',
      entityId: furnace.id,
      itemId: 'iron_ore',
      amount: 10,
    });
    run(simulation, 1);

    expect(simulation.commands.takeRejections()).toEqual([]);
    expect(simulation.player.inventory.count(simulation.items.idOf('iron_ore'))).toBe(10);
  });

  it('still refuses an inserter, which is the rule C15 built the port split for', () => {
    const simulation = new Simulation({ world: world() });
    const furnace = furnaceWithOre(simulation);
    const ore = simulation.items.idOf('iron_ore');
    const ports = {
      buildings: simulation.buildings,
      items: simulation.items,
      recipes: simulation.recipes,
    };

    // The port an inserter reads offers nothing; the port the hand reads
    // offers the ore. One machine, two answers, and the difference is who is
    // asking — see `items/item-port.ts`.
    expect(outputPortOf(furnace, ports)?.count(ore)).toBe(0);
    expect(handSourceOf(furnace, ports)?.count(ore)).toBe(10);
  });

  it('does not let an inserter drain a machine it is pointed at', () => {
    const simulation = new Simulation({ world: world() });
    furnaceWithOre(simulation);
    // Pointed at the furnace's south edge, aiming into a chest below it.
    simulation.entities.create(newInserter(4, 6, NORTH));
    const chest = simulation.entities.create<ChestEntity>(newChest(4, 7, NORTH));
    void EAST;

    run(simulation, 300);
    // Whatever else happened, the ore is not in the chest: an inserter reaches
    // into an output buffer and only ever will.
    const inChest = chest.contents.find((entry) => entry[0] === simulation.items.idOf('iron_ore'));
    expect(inChest).toBeUndefined();
  });
});
