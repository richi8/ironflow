import { newBelt, type BeltEntity } from '../../src/game/entities/belt-entity.js';
import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { newInserter, type InserterEntity } from '../../src/game/entities/inserter-entity.js';
import { newMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { newSplitter, type SplitterEntity } from '../../src/game/entities/splitter-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import type { Simulation } from '../../src/game/simulation.js';
import { CHUNK_AREA, CHUNK_SIZE, createChunk } from '../../src/game/world/chunk.js';
import { EAST, type Rotation } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World, type ChunkGenerator } from '../../src/game/world/world.js';

/**
 * The factory C18's acceptance criterion measures: 500-odd entities, every
 * system running, laid out by a pure function of its cell index.
 *
 * ```text
 * one cell, 13 entities, x 0..12, y 0..2, flowing east
 *
 *   [ miner 2x2 ] [belt][belt][belt][belt] [ splitter ] [belt] [chest]
 *   [  on ore   ]                          [  2 tiles ] [belt] [inserter]
 *                                                             [ furnace 2x2 ] [inserter][chest]
 * ```
 *
 * Every system in the game is exercised by one cell — mining, production,
 * belts, inserters, splitters, containers — which is the point: a determinism
 * test over a factory of nothing but belts would pass while a furnace quietly
 * drifted. §12's reference factory (20,000 entities) is C28's, built as a save
 * fixture and used for benchmarks; this is the same idea at the size a
 * ten-thousand-tick test can afford to run ten times.
 *
 * ## Why it is created rather than built from commands
 *
 * A build command is checked against the player's reach (C10), so a factory
 * this wide would have to be built by walking the player up and down it for
 * thousands of ticks before the measurement could start. That is a test of
 * `movePlayer`, not of the factory. The layout is created directly — which is
 * also the shape a loaded save arrives in — and the scenario's command script
 * exercises the command path separately, near where the player stands.
 *
 * Everything here is a pure function of the cell index, so "the same factory"
 * is a fact rather than a hope, and `order` reverses only the *sequence* of
 * creations, never the result: that is C18's build-order test.
 */

/** Entities in one cell. Counted here so the test can assert the total. */
export const ENTITIES_PER_CELL = 13;

/** Cells laid out, and therefore `13 x 39 = 507` entities. */
export const CELL_COUNT = 39;

/** Cells across before wrapping to the next row. */
const CELLS_PER_ROW = 13;

/** One cell's footprint, with a tile of air around it. */
const CELL_WIDTH = 14;
const CELL_HEIGHT = 4;

/** How much iron a tile of the ore field starts with. */
const ORE_PER_TILE = 4000;

/** Coal loaded into each furnace at the start. One stack, the buffer's size. */
const STARTING_COAL = 50;

/**
 * Iron ore on every tile, in a fixed amount.
 *
 * Pure and positional, as `ChunkGenerator` requires: `generate(5, 5)` gives
 * the same world chunk whether it is the first asked for or the thousandth,
 * so exploring in a different order cannot change the world. C19 replaces this
 * with noise; a determinism test wants the simplest thing that puts ore under
 * thirty-nine miners.
 */
export function oreEverywhere(): ChunkGenerator {
  return (cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let i = 0; i < CHUNK_AREA; i++) {
      chunk.resource[i] = ResourceType.Iron;
      chunk.resourceAmount[i] = ORE_PER_TILE;
    }
    return chunk;
  };
}

/** A world of nothing but ore, for the factory below. */
export function referenceWorld(): World {
  return new World(oreEverywhere());
}

/**
 * Where the player stands: north of the factory, so nothing they do touches it.
 *
 * Deliberately outside the built area and on negative `y`, which also puts the
 * player's own world chunk on the other side of the origin from the factory's
 * — a second world chunk in the hash, and the sign handling in `toChunkCoord`
 * exercised by the run rather than only by C02's unit test.
 */
export const PLAYER_TILE = Object.freeze({ x: 4, y: -6 });

/** Where the scenario's build and remove commands aim. In reach of the player. */
export const SCRATCH_TILE = Object.freeze({ x: 4, y: -4 });

/** The tile the scenario's `mineTile` command digs at. In reach, and on ore. */
export const MINE_TILE = Object.freeze({ x: 2, y: -6 });

/** One thing to create, as a position and a factory for its initial state. */
interface Placement {
  readonly make: () => void;
}

/**
 * Lay the factory into a simulation's store.
 *
 * `order` decides only the sequence the entities are created in, and therefore
 * which ids they get. A correct simulation produces the same *behaviour* under
 * both, which is §8's intra-phase ordering rule holding at factory scale — and
 * it is the only thing that separates C18's build-order test from C13's, which
 * asked the same question of a single belt line.
 */
export function layReferenceFactory(simulation: Simulation, order: 'forwards' | 'backwards' = 'forwards'): void {
  const placements: Placement[] = [];
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const ox = (cell % CELLS_PER_ROW) * CELL_WIDTH;
    const oy = Math.floor(cell / CELLS_PER_ROW) * CELL_HEIGHT;
    addCell(simulation, placements, ox, oy);
  }

  const sequence = order === 'forwards' ? placements : [...placements].reverse();
  for (const placement of sequence) placement.make();
}

function addCell(simulation: Simulation, out: Placement[], ox: number, oy: number): void {
  const belt = (x: number, y: number, rotation: Rotation): void => {
    out.push({ make: () => void simulation.entities.create<BeltEntity>(newBelt(ox + x, oy + y, rotation)) });
  };

  // A miner facing east puts its ore on the two tiles in front of it (C11).
  out.push({ make: () => void simulation.entities.create<MinerEntity>(newMiner(ox, oy, EAST)) });

  belt(2, 0, EAST);
  belt(3, 0, EAST);
  belt(4, 0, EAST);
  belt(5, 0, EAST);

  // The splitter covers (6,0) and (6,1): one branch banks ore in a chest, the
  // other feeds the furnace, so the round-robin runs for the whole ten
  // thousand ticks rather than settling into a pass-through.
  out.push({ make: () => void simulation.entities.create<SplitterEntity>(newSplitter(ox + 6, oy, EAST)) });
  belt(7, 0, EAST);
  belt(7, 1, EAST);

  out.push({ make: () => void simulation.entities.create<ChestEntity>(newChest(ox + 8, oy, EAST)) });
  out.push({ make: () => void simulation.entities.create<InserterEntity>(newInserter(ox + 8, oy + 1, EAST)) });

  out.push({
    make: () => {
      const furnace = simulation.entities.create<MachineEntity>(
        newMachine(EntityType.Furnace, ox + 9, oy + 1, EAST),
      );
      // Enough coal to burn past tick 10,000 (§15: 8 s a coal, so 50 coal is
      // 12,000 ticks). A furnace that ran dry halfway would still be
      // deterministic, but it would stop being a test of production.
      furnace.fuel = [[simulation.items.idOf('coal'), STARTING_COAL]];
    },
  });

  // Behind it is the furnace's own footprint, so this is the arm that takes
  // finished plates out and drops them in the chest (C14, C15).
  out.push({ make: () => void simulation.entities.create<InserterEntity>(newInserter(ox + 11, oy + 1, EAST)) });
  out.push({ make: () => void simulation.entities.create<ChestEntity>(newChest(ox + 12, oy + 1, EAST)) });
}

/** How wide the whole factory is, in tiles. For sanity checks in the tests. */
export const FACTORY_WIDTH = CELLS_PER_ROW * CELL_WIDTH;

/** Every world chunk the factory touches, so a test can say how many to expect. */
export const FACTORY_CHUNKS_WIDE = Math.ceil(FACTORY_WIDTH / CHUNK_SIZE);
