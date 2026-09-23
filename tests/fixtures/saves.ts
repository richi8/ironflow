/**
 * Save files for the storage tests. See C25.
 *
 * Real ones, produced by `serialize` over a real `Simulation`, rather than a
 * hand-written literal: the repositories put whatever they are given through
 * `JSON.stringify` and gzip, and a literal that happened to be simpler than a
 * factory would be a test of a document nobody stores.
 */

import { newBelt, type BeltEntity } from '../../src/game/entities/belt-entity.js';
import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newInserter, type InserterEntity } from '../../src/game/entities/inserter-entity.js';
import { newMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { newSplitter, type SplitterEntity } from '../../src/game/entities/splitter-entity.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { SAVE_FORMAT, SAVE_VERSION, type SaveFile } from '../../src/game/save/save-format.js';
import { serialize } from '../../src/game/save/save-serializer.js';
import { Simulation } from '../../src/game/simulation.js';
import { EAST } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';

import { createPlaygroundGenerator } from './world-fixtures.js';
import { stacked } from './chest.js';

/** A small world with something in the player's bag, so the bytes are not empty. */
export function sampleSimulation(seed = 11): Simulation {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()), seed });
  simulation.player.inventory.add(simulation.items.idOf('iron_ore'), 17);
  simulation.player.setTilePosition(3, 4);
  for (let tick = 0; tick < 5; tick++) simulation.tick();
  return simulation;
}

/**
 * A factory big enough for compression to be worth measuring.
 *
 * A few hundred belts, which is what a save actually looks like: the same
 * handful of field names repeated thousands of times, which is the shape gzip
 * exists for. The twenty-entity sample above compresses to *more* than it
 * started as, because a gzip header is 18 bytes and the file is 900.
 */
export function largeSimulation(belts = 400): Simulation {
  const simulation = sampleSimulation(3);
  for (let index = 0; index < belts; index++) {
    simulation.entities.create<BeltEntity>(newBelt(10 + (index % 20), 10 + Math.floor(index / 20), EAST));
  }
  return simulation;
}

/**
 * A world with one of everything a validator has to understand. C26.
 *
 * `sampleSimulation` has no entities in it at all, which made it the right
 * fixture for C25 — the repositories store bytes and do not care what is in
 * them — and the wrong one for a validator, whose whole job is the contents.
 * This is the smallest world that still exercises each shape the format has:
 * a container with slots, a machine with three buffers and a named recipe, a
 * belt lane, an inserter holding an item outside any container, a multi-tile
 * footprint, a mined world chunk and an explored one.
 */
export function factorySimulation(seed = 5): Simulation {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()), seed });
  const items = simulation.items;

  simulation.player.setTilePosition(2, 2);
  simulation.player.inventory.add(items.idOf('iron_ore'), 40);

  simulation.entities.create<MinerEntity>(newMiner(4, 4, EAST));

  const belt = simulation.entities.create<BeltEntity>(newBelt(8, 4, EAST));
  belt.items.push({ itemId: items.idOf('iron_ore'), pos: 128 });

  simulation.entities.create<SplitterEntity>(newSplitter(10, 4, EAST));

  const chest = simulation.entities.create<ChestEntity>(newChest(13, 4, EAST));
  chest.contents = stacked(simulation, [[items.idOf('iron_plate'), 25]]);

  const inserter = simulation.entities.create<InserterEntity>(newInserter(13, 6, EAST));
  inserter.heldItem = items.idOf('iron_ore');

  const furnace = simulation.entities.create<MachineEntity>(newMachine(EntityType.Furnace, 16, 4, EAST));
  furnace.recipe = simulation.recipes.get('smelt_iron').recipeId;
  furnace.fuel = [[items.idOf('coal'), 5]];
  furnace.input = [[items.idOf('iron_ore'), 3]];

  // One mined tile, so the save carries a world delta, and one world chunk
  // the player has seen, so it carries an explored key.
  simulation.world.setResource(1, 1, ResourceType.Iron, 50);
  simulation.world.explored.reveal(0, 0);

  for (let tick = 0; tick < 3; tick++) simulation.tick();
  return simulation;
}

/** That world, wrapped as the file a repository stores. */
export function sampleSave(name = 'Test factory', simulation = sampleSimulation()): SaveFile {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    metadata: { name, createdAt: 1_700_000_000_000, playtimeTicks: simulation.getTick(), thumbnail: null, hotbar: null, quests: null },
    state: serialize(simulation),
  };
}
