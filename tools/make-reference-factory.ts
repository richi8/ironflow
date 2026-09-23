/**
 * Build §12's reference factory and write it out as a save. C28 task 3.
 *
 * ```sh
 * npm run bench:fixture      # writes tests/fixtures/reference-factory.ifsave
 * ```
 *
 * §12 defines the benchmark scenario by its composition, and this is that
 * composition laid out on a real generated world:
 *
 * ```text
 * 20,000 entities       12,000 belt tiles     3,000 inserters
 *                        2,500 machines        2,500 misc
 * ~8,000 items on belts, 40 x 40 world chunks explored
 * ```
 *
 * The output is an ordinary export (`.ifsave`, C26) — the same bytes the save
 * menu writes — so the benchmarks load it through the same door a player's
 * file comes through (migrate, validate, deserialize), and a person can drop
 * it on the game window to look at the factory with F3 open. That second use
 * is the one the benchmarks cannot do for themselves: §12's render budgets
 * are only measurable in a browser.
 *
 * ## The module
 *
 * The factory is 500 copies of one 40-entity module, which is §12's
 * composition divided by 500 exactly:
 *
 * ```text
 *        x 0    2    4    6         11        15    18 19
 *   y-2            [ gen ]                                  generator, or a chest at (6,0)
 *   y-1       [M2]
 *   y 0       [M2]
 *   y 1  [M1] > > > > > > > > > > > > > > > >  C            ore line, 16 belts, into a chest
 *   y 2  [M1]    P  v    P    v                             P = pole, v = inserter (south)
 *   y 3               [F]          [F]                      two burner furnaces, smelting iron
 *   y 4               [F]          [F]
 *   y 5               v            v    [    ]
 *   y 6               > > > > > > > >  > [ A ] >  C         plate line, 8 belts, into an assembler
 *   y 7                                  [    ]             making gears, into a chest
 *
 *   24 belts   6 inserters   5 machines (2 miners, 2 furnaces, 1 assembler)
 *   5 misc (2 chests, 2 poles, and a generator in every fourth module or a third chest)
 * ```
 *
 * Every system that has per-entity work in a tick has it here: miners mine,
 * belts carry, inserters swing, furnaces burn and smelt, an assembler crafts,
 * chests fill, the pole graph resolves. Research and exploration have none —
 * no labs, no radars — because §12's composition has none either.
 *
 * ## Why one module in six is backed up
 *
 * Two miners put 1.0 ore/s on a line and two furnaces can take 0.625 of it,
 * but a furnace with room in its buffer takes everything that passes, so a
 * line that ends in a chest carries about six items in steady state — 2,500
 * across the factory, a third of §12's 8,000. A line that ends in nothing
 * backs up to the miners and holds about sixty. Real factories have both, and
 * the mixture that lands on §12's number is one backed-up line in six, which
 * also puts `output_full` miners in the benchmark: a status that costs a
 * system something different from `running`.
 *
 * A backed-up line is laid **already full**. Left to fill itself it would take
 * the furnaces' buffers first and the belt afterwards — tens of simulated
 * minutes, most of the coal the furnaces start with. A full line is exactly
 * the state it would have reached, and the warm-up that follows settles the
 * rest.
 *
 * ## Why entities are created rather than built
 *
 * The reason `tests/determinism/reference-factory.ts` gives: a build command
 * checks the player's reach and inventory, and building 20,000 entities that
 * way is a test of walking. What a build command would have checked is checked
 * here instead — every tile is buildable ground, every miner stands only on
 * iron, nothing overlaps — so the file is a factory a player could have built.
 *
 * ## Why the modules are out of step
 *
 * Five hundred copies of one module laid on one tick are five hundred
 * machines finishing on the same tick, forever: the factory's cost would
 * pulse every 3.2 seconds with the furnaces, and a p99 measured on it would
 * be a measurement of the pulse. Each module's miners and furnaces start part
 * of the way through a cycle, by an amount that depends on the module's
 * index, which is what a factory built over an afternoon looks like.
 *
 * Nothing reads a clock, so running this twice produces the same bytes, and a
 * regenerated fixture is a diff of one binary file rather than a mystery.
 * Regenerate it when the save schema or the world generator changes — and
 * then re-baseline, because a different factory is a different benchmark.
 */

import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { initialBuildingState } from '../src/game/entities/building-init.js';
import type { EntityInit } from '../src/game/entities/entity.js';
import { BELT_MAX_POSITION, asBelt, laneAccept } from '../src/game/entities/belt-entity.js';
import type { GeneratorEntity } from '../src/game/entities/generator-entity.js';
import type { MachineEntity } from '../src/game/entities/machine-entity.js';
import type { MinerEntity } from '../src/game/entities/miner-entity.js';
import { SAVE_FORMAT, SAVE_VERSION, type SaveFile } from '../src/game/save/save-format.js';
import { serialize } from '../src/game/save/save-serializer.js';
import { Simulation } from '../src/game/simulation.js';
import { CHUNK_SIZE } from '../src/game/world/chunk.js';
import { EAST, SOUTH, type Rotation } from '../src/game/world/coordinates.js';
import { ResourceType } from '../src/game/world/resource.js';
import { tileProperties } from '../src/game/world/tile.js';
import { createWorldGenerator } from '../src/game/world/world-generator.js';
import { World } from '../src/game/world/world.js';
import { encodeSaveFile } from '../src/persistence/export-import.js';

/** The world the factory stands on. Changing it is a new benchmark. */
export const REFERENCE_SEED = 0x12c28;

/** Modules laid, and therefore 500 x 40 = §12's 20,000 entities. */
const MODULES = 500;

/** One module in this many ends its ore line in nothing, and backs up. */
const BACKED_UP_EVERY = 6;

/** One module in this many has a generator where the others have a third chest. */
const GENERATOR_EVERY = 4;

/** §12's explored map: 41 x 41 world chunks around the origin. */
const EXPLORED_RADIUS = 20;

/** Modules keep this far from spawn, so the player is not standing in one. */
const SPAWN_CLEARANCE = 16;

/**
 * Ore each miner must stand on, summed over its four tiles: fifty minutes of
 * mining at 0.5/s. A miner on the fringe of a patch runs dry in a minute and
 * turns its whole line idle, which is a different benchmark every time the
 * file is loaded a little later.
 */
const MINER_ORE = 1000;

/** Coal each furnace starts with: a full buffer, 400 s of burning (§15). */
const FURNACE_COAL = 50;

/** Ore each furnace starts with: a full input buffer (§15). */
const FURNACE_ORE = 50;

/** Coal each generator starts with. It has nothing to supply, so it keeps it. */
const GENERATOR_COAL = 20;

/**
 * Ticks run before the save is taken: long enough for every line to reach
 * steady state, and short enough to leave the furnaces six minutes of coal
 * for whoever loads the file.
 */
const WARM_TICKS = 1_800;

/** A tier-1 miner's cycle, 0.5 items/s, and a furnace's, 3.2 s (§15), in ticks. */
const MINER_CYCLE_TICKS = 60;
const FURNACE_CYCLE_TICKS = 96;

/** The wall clock the file pretends to have been written at (§6 R1). */
const FIXTURE_CREATED_AT = Date.UTC(2026, 0, 1);

/** One thing in a module: a building, where it goes, and how it faces. */
interface Part {
  readonly buildingId: string;
  readonly dx: number;
  readonly dy: number;
  readonly rotation: Rotation;
  /** Which variant it belongs to; absent means every module has it. */
  readonly only?: 'flowing' | 'backedUp' | 'generator' | 'chest';
}

/** The module in the header, as data. `(0, 0)` is its anchor, not its corner. */
const PARTS: readonly Part[] = [
  { buildingId: 'miner', dx: 0, dy: 1, rotation: EAST },
  { buildingId: 'miner', dx: 2, dy: -1, rotation: SOUTH },
  ...Array.from({ length: 16 }, (_, i): Part => ({ buildingId: 'belt', dx: 2 + i, dy: 1, rotation: EAST })),
  // The ore line's end. In a backed-up module the chest moves one row up, off
  // the end of the line, so the count of chests is the same in both.
  { buildingId: 'chest', dx: 18, dy: 1, rotation: EAST, only: 'flowing' },
  { buildingId: 'chest', dx: 18, dy: 0, rotation: EAST, only: 'backedUp' },
  { buildingId: 'power_pole', dx: 4, dy: 2, rotation: EAST },
  { buildingId: 'power_pole', dx: 12, dy: 2, rotation: EAST },
  { buildingId: 'generator', dx: 5, dy: -2, rotation: EAST, only: 'generator' },
  { buildingId: 'chest', dx: 6, dy: 0, rotation: EAST, only: 'chest' },
  { buildingId: 'inserter', dx: 6, dy: 2, rotation: SOUTH },
  { buildingId: 'inserter', dx: 11, dy: 2, rotation: SOUTH },
  { buildingId: 'furnace', dx: 6, dy: 3, rotation: EAST },
  { buildingId: 'furnace', dx: 11, dy: 3, rotation: EAST },
  { buildingId: 'inserter', dx: 6, dy: 5, rotation: SOUTH },
  { buildingId: 'inserter', dx: 11, dy: 5, rotation: SOUTH },
  ...Array.from({ length: 8 }, (_, i): Part => ({ buildingId: 'belt', dx: 6 + i, dy: 6, rotation: EAST })),
  { buildingId: 'inserter', dx: 14, dy: 6, rotation: EAST },
  { buildingId: 'assembler', dx: 15, dy: 5, rotation: EAST },
  { buildingId: 'inserter', dx: 18, dy: 6, rotation: EAST },
  { buildingId: 'chest', dx: 19, dy: 6, rotation: EAST },
];

/**
 * The rectangle a module reserves, one tile of margin included.
 *
 * Reserved whole rather than tile by tile, so that the empty tile a backed-up
 * line ends at stays empty: a neighbour's chest there would quietly turn it
 * back into a flowing line.
 */
const RESERVE = Object.freeze({ x0: -1, y0: -3, x1: 20, y1: 8 });

/** The two miners' footprints, relative to the anchor: they must stand on iron. */
const MINER_TILES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 1], [0, 2], [1, 2],
  [2, -1], [3, -1], [2, 0], [3, 0],
];

type Variant = 'flowing' | 'backedUp';
type Misc = 'generator' | 'chest';

function includes(part: Part, variant: Variant, misc: Misc): boolean {
  return part.only === undefined || part.only === variant || part.only === misc;
}

/** Every tile a module's buildings cover, in either variant. */
function coveredTiles(simulation: Simulation): readonly (readonly [number, number])[] {
  const tiles: [number, number][] = [];
  for (const part of PARTS) {
    const { size } = simulation.buildings.get(part.buildingId);
    for (let dy = 0; dy < size.height; dy++) {
      for (let dx = 0; dx < size.width; dx++) tiles.push([part.dx + dx, part.dy + dy]);
    }
  }
  return tiles;
}

/** A 32-bit mix of a tile position, so candidates can be visited scattered. */
function scatter(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Where the modules go: anchors on iron, visited in a scattered order, taken
 * greedily wherever a whole module fits.
 *
 * Scattered rather than row by row so the factory covers the explored map
 * instead of its top edge: a benchmark whose entities all sit in six world
 * chunks would be a different benchmark for the renderer, if not for the tick.
 */
function planModules(world: World, simulation: Simulation): readonly { x: number; y: number }[] {
  const half = EXPLORED_RADIUS * CHUNK_SIZE;
  const min = -half;
  const size = (EXPLORED_RADIUS * 2 + 1) * CHUNK_SIZE;
  const reserved = new Uint8Array(size * size);
  const covered = coveredTiles(simulation);

  const candidates: { x: number; y: number; order: number }[] = [];
  for (let y = min - RESERVE.y0; y < min + size - RESERVE.y1; y++) {
    for (let x = min - RESERVE.x0; x < min + size - RESERVE.x1; x++) {
      if (world.getResource(x, y) === ResourceType.Iron) candidates.push({ x, y, order: scatter(x, y) });
    }
  }
  candidates.sort((a, b) => a.order - b.order || a.y - b.y || a.x - b.x);

  const fits = (ax: number, ay: number): boolean => {
    if (Math.abs(ax - 0) < SPAWN_CLEARANCE && Math.abs(ay - 0) < SPAWN_CLEARANCE) return false;
    for (let y = ay + RESERVE.y0; y <= ay + RESERVE.y1; y++) {
      for (let x = ax + RESERVE.x0; x <= ax + RESERVE.x1; x++) {
        if (reserved[(y - min) * size + (x - min)] !== 0) return false;
      }
    }
    for (const [dx, dy] of covered) {
      if (!tileProperties(world.getTile(ax + dx, ay + dy)).buildable) return false;
    }
    // Each miner needs iron under it and nothing else: a miner on mixed ore
    // would put copper on a line whose furnaces smelt iron, and an inserter
    // holding copper over an iron furnace is a stall, not a benchmark.
    for (let miner = 0; miner < 2; miner++) {
      let iron = 0;
      for (let i = miner * 4; i < miner * 4 + 4; i++) {
        const [dx, dy] = MINER_TILES[i] ?? [0, 0];
        const resource = world.getResource(ax + dx, ay + dy);
        if (resource === ResourceType.Iron) iron += world.getResourceAmount(ax + dx, ay + dy);
        else if (resource !== ResourceType.None) return false;
      }
      if (iron < MINER_ORE) return false;
    }
    return true;
  };

  const anchors: { x: number; y: number }[] = [];
  for (const candidate of candidates) {
    if (anchors.length === MODULES) break;
    // The candidate is an iron tile; try it under each tile of either miner.
    for (let i = 0; i < MINER_TILES.length; i++) {
      const [dx, dy] = MINER_TILES[i] ?? [0, 0];
      const ax = candidate.x - dx;
      const ay = candidate.y - dy;
      if (!fits(ax, ay)) continue;
      for (let y = ay + RESERVE.y0; y <= ay + RESERVE.y1; y++) {
        for (let x = ax + RESERVE.x0; x <= ax + RESERVE.x1; x++) reserved[(y - min) * size + (x - min)] = 1;
      }
      anchors.push({ x: ax, y: ay });
      break;
    }
  }

  if (anchors.length < MODULES) {
    throw new Error(`only ${anchors.length} of ${MODULES} modules fit on seed ${REFERENCE_SEED}; pick another seed.`);
  }
  // Laid out in reading order, so entity ids run across the map the way a
  // player's would rather than in the scattered order they were found in.
  return anchors.sort((a, b) => a.y - b.y || a.x - b.x);
}

function layModule(simulation: Simulation, index: number, ax: number, ay: number): void {
  const variant: Variant = index % BACKED_UP_EVERY === BACKED_UP_EVERY - 1 ? 'backedUp' : 'flowing';
  const misc: Misc = index % GENERATOR_EVERY === 0 ? 'generator' : 'chest';
  const coal = simulation.items.idOf('coal');
  const smelt = simulation.recipes.get('smelt_iron').recipeId;
  const gear = simulation.recipes.get('make_gear').recipeId;
  const ore = simulation.items.idOf('iron_ore');

  // Out of step with the neighbours: see the header. The multipliers are
  // coprime with 60 and 96, a miner's and a furnace's cycle in ticks, so
  // consecutive modules land far apart in each.
  const minerPhase = (index * 37) % MINER_CYCLE_TICKS;
  const furnacePhase = (index * 41) % FURNACE_CYCLE_TICKS;

  for (const part of PARTS) {
    if (!includes(part, variant, misc)) continue;
    const definition = simulation.buildings.get(part.buildingId);
    const init: EntityInit = initialBuildingState(definition, ax + part.dx, ay + part.dy, part.rotation);
    const entity = simulation.entities.create(init);
    if (part.buildingId === 'furnace') {
      const furnace = entity as MachineEntity;
      furnace.recipe = smelt;
      furnace.progressTicks = furnacePhase;
      furnace.fuel = [[coal, FURNACE_COAL]];
      // A full input buffer too, for the reason a backed-up line is laid full:
      // an empty furnace drinks every item that passes it until it holds
      // fifty, and a benchmark taken while it does is timing the first ten
      // minutes of a factory rather than a factory.
      furnace.input = [[ore, FURNACE_ORE]];
    } else if (part.buildingId === 'assembler') {
      (entity as MachineEntity).recipe = gear;
    } else if (part.buildingId === 'miner') {
      (entity as MinerEntity).progressTicks = minerPhase;
    } else if (part.buildingId === 'generator') {
      (entity as GeneratorEntity).fuel = [[coal, GENERATOR_COAL]];
    } else if (variant === 'backedUp' && part.dy === 1) {
      // The ore line of a backed-up module, laid full: see the header.
      const belt = asBelt(entity);
      while (belt !== null && laneAccept(belt.items, ore, BELT_MAX_POSITION));
    }
  }
}

/** Counts for the summary line, and for the tests to hold the file to. */
function census(simulation: Simulation): Record<string, number> {
  const counts: Record<string, number> = { entities: simulation.entities.size, beltItems: 0 };
  simulation.entities.forEach((entity) => {
    const name = simulation.buildings.forEntityType(entity.type).id;
    counts[name] = (counts[name] ?? 0) + 1;
    counts['beltItems'] = (counts['beltItems'] ?? 0) + (asBelt(entity)?.items.length ?? 0);
  });
  return counts;
}

async function main(): Promise<void> {
  const out = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'reference-factory.ifsave');

  const world = new World(createWorldGenerator(REFERENCE_SEED));
  const simulation = new Simulation({ world, seed: REFERENCE_SEED });
  simulation.player.setTilePosition(0, 0);

  const anchors = planModules(world, simulation);
  anchors.forEach((anchor, index) => layModule(simulation, index, anchor.x, anchor.y));
  world.explored.revealSquare(0, 0, EXPLORED_RADIUS);

  for (let tick = 0; tick < WARM_TICKS; tick++) simulation.tick();

  const file: SaveFile = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    metadata: {
      name: 'Reference factory (§12)',
      createdAt: FIXTURE_CREATED_AT,
      playtimeTicks: simulation.getTick(),
      thumbnail: null,
      hotbar: null,
      quests: null,
    },
    state: serialize(simulation),
  };
  const bytes = await encodeSaveFile(file);
  writeFileSync(out, bytes);

  const counts = census(simulation);
  console.log(
    `${relative(process.cwd(), out)}: ${(bytes.length / 1024).toFixed(0)} kB, seed ${REFERENCE_SEED}, tick ${simulation.getTick()}\n` +
      Object.entries(counts)
        .map(([name, count]) => `  ${name.padEnd(12)} ${count}`)
        .join('\n'),
  );
}

await main();
