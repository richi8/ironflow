/**
 * Save files for the storage tests. See C25.
 *
 * Real ones, produced by `serialize` over a real `Simulation`, rather than a
 * hand-written literal: the repositories put whatever they are given through
 * `JSON.stringify` and gzip, and a literal that happened to be simpler than a
 * factory would be a test of a document nobody stores.
 */

import { newBelt, type BeltEntity } from '../../src/game/entities/belt-entity.js';
import { SAVE_FORMAT, SAVE_VERSION, type SaveFile } from '../../src/game/save/save-format.js';
import { serialize } from '../../src/game/save/save-serializer.js';
import { Simulation } from '../../src/game/simulation.js';
import { EAST } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';

import { createPlaygroundGenerator } from './world-fixtures.js';

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

/** That world, wrapped as the file a repository stores. */
export function sampleSave(name = 'Test factory', simulation = sampleSimulation()): SaveFile {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    metadata: { name, createdAt: 1_700_000_000_000, playtimeTicks: simulation.getTick(), thumbnail: null },
    state: serialize(simulation),
  };
}
