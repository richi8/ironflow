/**
 * Freeze a save of the current schema, for C27's migration tests.
 *
 * ```sh
 * npm run save:fixture              # writes tests/fixtures/saves/v<N>.json
 * npm run save:fixture -- --force   # overwrite one that is already there
 * ```
 *
 * C27 task 2: "Generate a fixture at every version bump — a migration without
 * a fixture is untested by definition." This is that generator, and the reason
 * it is a committed artifact rather than something a test builds: a fixture
 * built by today's code is a test of today's code against itself. What a
 * migration has to survive is a file written by a build that no longer exists,
 * and the only way to have one of those is to have written it down at the
 * time.
 *
 * **Run it before a schema change, not after.** The fixture that matters is of
 * the version you are about to leave; `migrations/index.ts` has the four-step
 * recipe.
 *
 * It refuses to overwrite an existing fixture without `--force`, because a
 * regenerated v1 is not the v1 anybody's save was written by — it is this
 * build's idea of one, which is exactly the thing the file exists to not be.
 *
 * ## What is in it
 *
 * A short but real session: the starting world at a fixed seed, the player's
 * kit spent on a line that mines, carries, smelts and banks, some research
 * started and some ore dug by hand. Every branch of §14's document has to be
 * represented — entities with buffers, a belt with items on it, world deltas,
 * explored chunks, a research queue, a craft order — because a migration that
 * forgot one of them would pass against a fixture that did not have it. The
 * whole session goes through `Simulation.commands`, and a rejected command
 * stops the tool: a fixture missing the furnace it was written to contain is
 * the one failure its tests cannot see.
 *
 * Nothing in it reads a clock, so running this twice on one schema version
 * produces byte-identical output and a regeneration is a diff a person can
 * read.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import type { Command } from '../src/game/commands/command.js';
import { asBelt } from '../src/game/entities/belt-entity.js';
import { SAVE_FORMAT, SAVE_VERSION, type SaveFile } from '../src/game/save/save-format.js';
import { serialize } from '../src/game/save/save-serializer.js';
import { Simulation } from '../src/game/simulation.js';
import { EAST, SOUTH, type Rotation } from '../src/game/world/coordinates.js';
import { ResourceType } from '../src/game/world/resource.js';
import { tileProperties } from '../src/game/world/tile.js';
import { createStartingWorld, START_RADIUS, WORLD_SPAWN } from '../src/game/world/starting-area.js';
import type { World } from '../src/game/world/world.js';

/** The seed every fixture is built on. Changing it invalidates them all. */
const FIXTURE_SEED = 20260922;

/** The wall clock a fixture pretends to have been written at (§6 R1). */
const FIXTURE_CREATED_AT = Date.UTC(2026, 0, 1);

/** What the player starts holding, so the script below can spend it. */
const KIT: Readonly<Record<string, number>> = Object.freeze({
  miner: 2,
  belt: 40,
  inserter: 6,
  furnace: 2,
  chest: 4,
});

/** How much room the factory below needs, anchored on the ore tile. */
const SITE = Object.freeze({ width: 8, height: 4 });

/**
 * The nearest ore tile the factory actually fits on, searched from spawn.
 *
 * The factory is laid around whatever the generator put there rather than at
 * fixed coordinates, because a fixture built at coordinates would be a
 * fixture of a *seed*: the first worldgen change would turn a miner on ore
 * into a miner in a lake, and the tool would fail for a reason that has
 * nothing to do with migrations. The site is checked for buildable ground as
 * well as for ore, which is the same question `BuildSystem` will ask a moment
 * later — asking it first turns "the fixture is missing a furnace" into "there
 * was nowhere to put one".
 */
function site(world: World, type: ResourceType): { readonly x: number; readonly y: number } {
  let best: { x: number; y: number; distance: number } | null = null;
  for (let y = WORLD_SPAWN.y - START_RADIUS; y <= WORLD_SPAWN.y + START_RADIUS; y++) {
    for (let x = WORLD_SPAWN.x - START_RADIUS; x <= WORLD_SPAWN.x + START_RADIUS; x++) {
      if (world.getResource(x, y) !== type || world.getResourceAmount(x, y) <= 0) continue;
      if (!buildable(world, x, y)) continue;
      const distance = Math.abs(x - WORLD_SPAWN.x) + Math.abs(y - WORLD_SPAWN.y);
      if (best === null || distance < best.distance) best = { x, y, distance };
    }
  }
  if (best === null) throw new Error(`the starting area has no ${type} with room for a factory beside it.`);
  return { x: best.x, y: best.y };
}

/** Is every tile of the site buildable ground? */
function buildable(world: World, x: number, y: number): boolean {
  for (let dy = 0; dy < SITE.height; dy++) {
    for (let dx = 0; dx < SITE.width; dx++) {
      if (!tileProperties(world.getTile(x + dx, y + dy)).buildable) return false;
    }
  }
  return true;
}

/**
 * Apply one command and insist that it worked.
 *
 * A rejected `build` is a silent hole in the fixture: the file is still a
 * valid save, it just no longer contains the thing it was written to contain.
 * That is exactly the failure a migration test cannot notice, so it is a
 * failure here instead.
 */
function apply(simulation: Simulation, command: Command): void {
  simulation.commands.enqueue(command);
  simulation.tick();
  const rejections = simulation.commands.takeRejections();
  if (rejections.length > 0) {
    const reasons = rejections.map((rejection) => `${rejection.command.type}: ${rejection.reason}`).join(', ');
    throw new Error(`the fixture script was rejected — ${reasons}`);
  }
}

/**
 * Tick until the world is in the state the fixture wants, or give up loudly.
 *
 * A cap and a throw rather than a `while (true)`: a fixture generator that
 * spins for ever on a factory that stalled is a worse failure than one that
 * says the factory stalled.
 */
function runUntil(simulation: Simulation, limit: number, done: () => boolean): void {
  for (let tick = 0; tick < limit; tick++) {
    simulation.tick();
    if (done()) return;
  }
  throw new Error(`the fixture factory never reached the state the tool waits for, in ${limit} ticks.`);
}

/** Put the player beside a tile, so everything below is in reach. */
function stand(simulation: Simulation, x: number, y: number): void {
  simulation.player.setTilePosition(x, y);
}

function main(): void {
  const force = process.argv.includes('--force');
  const out = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'saves', `v${SAVE_VERSION}.json`);

  if (existsSync(out) && !force) {
    console.error(
      `${relative(process.cwd(), out)} already exists.\n` +
        'A fixture is a historical document: regenerating it replaces a save written by an\n' +
        "older build with this one's idea of it. Pass --force only if you mean that.",
    );
    process.exitCode = 1;
    return;
  }

  const start = createStartingWorld(FIXTURE_SEED);
  const simulation = new Simulation({ world: start.world, seed: start.seed });
  for (const [buildingId, count] of Object.entries(KIT)) simulation.inventory.add(buildingId, count);
  // Fuel and feedstock the player is treated as having already mined: the
  // point of the fixture is a factory mid-run, not the ten minutes before one.
  simulation.player.inventory.add(simulation.items.idOf('coal'), 30);

  const iron = site(start.world, ResourceType.Iron);
  const build = (buildingId: string, x: number, y: number, rotation: Rotation): void => {
    stand(simulation, x - 1, y);
    apply(simulation, { type: 'build', buildingId, x, y, rotation });
  };

  // A line that mines, carries, smelts and banks — every shape §14's document
  // has, in the smallest factory that has all of them.
  //
  // The inserter feeds off the **chest** rather than off the belt, and that is
  // not decoration: a belt hands its front item onward the moment the tile
  // ahead has room, so on a line that is not backed up there is rarely
  // anything sitting at the front for an arm to take. An inserter between a
  // full chest and a furnace always has work, which is what makes the fixture
  // a factory that is *running* rather than one that is merely built.
  build('miner', iron.x, iron.y, EAST);
  build('belt', iron.x + 2, iron.y, EAST);
  build('belt', iron.x + 3, iron.y, EAST);
  build('belt', iron.x + 4, iron.y, EAST);
  build('chest', iron.x + 5, iron.y, EAST);
  build('inserter', iron.x + 5, iron.y + 1, SOUTH);
  build('furnace', iron.x + 4, iron.y + 2, EAST);
  build('inserter', iron.x + 6, iron.y + 2, EAST);
  build('chest', iron.x + 7, iron.y + 2, EAST);


  // Coal into the furnace by hand, which is how a player's first one is lit.
  const furnace = simulation.entities.at(iron.x + 4, iron.y + 2);
  if (furnace === undefined) throw new Error('the furnace the script just built is not there.');
  stand(simulation, iron.x + 3, iron.y + 2);
  apply(simulation, { type: 'insertItems', entityId: furnace.id, itemId: 'coal', amount: 20 });
  apply(simulation, { type: 'setRecipe', entityId: furnace.id, recipeId: 'smelt_iron' });

  // Research under way before the factory has produced anything, which is
  // where a real one starts it.
  apply(simulation, { type: 'startResearch', technologyId: 'logistics_1' });

  // Long enough for the miner to fill, the belt to move and the furnace to
  // smelt: a save of an idle factory would not exercise half the format.
  for (let tick = 0; tick < 900; tick++) simulation.tick();

  // Plates out of the output chest and into a craft order, and a tile being
  // dug by hand — three more branches of the document, none of them reachable
  // by building. The craft is left part-finished on purpose: a queue with
  // progress on it is a different shape from an empty one.
  const output = simulation.entities.at(iron.x + 7, iron.y + 2);
  if (output === undefined) throw new Error('the output chest the script just built is not there.');
  stand(simulation, iron.x + 6, iron.y + 3);
  apply(simulation, { type: 'takeItems', entityId: output.id, itemId: 'iron_plate', amount: 8 });
  apply(simulation, { type: 'craftItem', recipeId: 'make_gear', count: 3 });
  stand(simulation, iron.x - 1, iron.y + 1);
  apply(simulation, { type: 'mineTile', x: iron.x, y: iron.y + 1 });
  for (let tick = 0; tick < 20; tick++) simulation.tick();

  // Stop on a tick with ore actually on the line. A miner produces one item
  // every two seconds and a belt tile is crossed in a quarter of one, so an
  // ordinary tick has empty belts — and a fixture with empty belts would not
  // contain §9's `pos` at all, which is the field a belt migration would be
  // about. Deterministic despite the loop: same seed, same tick.
  runUntil(simulation, 600, () => {
    let carrying = false;
    simulation.entities.forEach((entity) => {
      carrying = carrying || (asBelt(entity)?.items.length ?? 0) > 0;
    });
    return carrying;
  });

  const file: SaveFile = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    metadata: {
      name: `Fixture v${SAVE_VERSION}`,
      createdAt: FIXTURE_CREATED_AT,
      playtimeTicks: simulation.getTick(),
      thumbnail: null,
      // A rearranged hotbar rather than the default, so a v2 migration has a
      // layout to carry: the null a v1 save migrates to is the other shape.
      hotbar: ['belt', 'miner', null, 'inserter', 'furnace', null, 'chest', null, null],
    },
    state: serialize(simulation),
  };

  mkdirSync(dirname(out), { recursive: true });
  // Pretty-printed, because the point of a committed fixture is that a human
  // can read the diff when one changes.
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

  console.log(
    `${relative(process.cwd(), out)}: schema v${SAVE_VERSION}, ` +
      `${file.state.entities.length} entities, ${file.state.chunkDeltas.length} world deltas, ` +
      `tick ${file.state.tick}, seed ${file.state.seed}.`,
  );
}

main();
