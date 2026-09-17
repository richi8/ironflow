import { describe, expect, it } from 'vitest';

import { asChest } from '../../src/game/entities/chest-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import {
  BUILD_RANGE_TILES,
  MINE_RANGE_TILES,
  PLAYER_STEP_SUBTILES,
  tileCentreSubtile,
} from '../../src/game/player/player-state.js';
import { NORTH, SOUTH, type Rotation } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { createStartingWorld, WORLD_SPAWN } from '../../src/game/world/starting-area.js';
import { isBuildable } from '../../src/game/world/tile.js';
import type { World } from '../../src/game/world/world.js';

/**
 * How long a new game takes to automate something. C20 task 3's acceptance.
 *
 * > Target: first automated plate within **10 minutes** of a new game; first
 * > assembler within **25 minutes**.
 *
 * C20 also says to play for an hour and write down the friction, and no test
 * can do that. What a test *can* do is put a number under the claim: run a
 * real new game — a generated world, the shipped starting kit, the player
 * walking on their own legs and every building placed by a `build` command
 * that the simulation validated — and count the ticks.
 *
 * ## What it found, which is not what C20 expected
 *
 * **Thirty seconds.** Both of C20's targets are met by a factor of twenty, and
 * not because the game is fast: because the player is *given* a miner, two
 * furnaces and an assembler, so the first plate costs a walk and four clicks
 * and the first assembler costs nothing at all. The ten- and twenty-five-minute
 * figures were written for a game whose opening is spent hand-crafting the
 * first miner, and hand-crafting is a system C20 is forbidden to add.
 *
 * So the milestone was re-derived rather than the number nudged, which is
 * §15's own rule. What the opening is actually *about*, now that §15's
 * building recipes exist, is the moment the factory starts making its own
 * parts — and that is what the second measurement below times:
 *
 * ```text
 *   first automated plate      ore -> furnace -> chest, unattended
 *   first self-made building   ore -> furnace -> assembler -> chest,
 *                              with the assembler making chests
 * ```
 *
 * The second one is the pillar-1 moment §15 names — "the factory eventually
 * builds itself" — and it is the first time in twenty chunks that a building
 * has come out of a machine rather than out of the starting kit.
 *
 * ## What the numbers mean, and what they do not
 *
 * This is the **simulated** time a player takes who already knows exactly what
 * to build and walks straight there. A human adds looking, deciding and
 * misclicking, so a first run is some multiple of it. The assertions are
 * therefore ceilings with room in them: they are there to catch a change that
 * makes the opening ten times longer, not to pin it to the second.
 *
 * Run on four seeds, because the thing being measured is partly the *map*:
 * how far spawn is from iron and from coal is a worldgen outcome, and a target
 * that only one seed meets is not a target (C19).
 *
 * ## The bot
 *
 * It routes with a breadth-first search over walkable tiles and follows the
 * route with ordinary `movePlayer` commands, so the walking is the game's own.
 * Everything else it does is a command the simulation validated. It is not
 * allowed to reach into state the player could not.
 */

/** The kit `main.ts` hands a new player. Kept in step by the test below. */
const STARTING_KIT: Readonly<Record<string, number>> = Object.freeze({
  miner: 2,
  belt: 40,
  inserter: 6,
  furnace: 2,
  assembler: 1,
  chest: 4,
});

/** Seeds to run. Four, so one unlucky map cannot carry the result. */
const SEEDS: readonly number[] = [0x1f0f10, 1, 4242, 99_999];

/** C20's target for the first automated plate, in simulated seconds. */
const FIRST_PLATE_BUDGET_SECONDS = 10 * 60;

/**
 * C20's target for the first assembler, re-read as the first building the
 * *factory* made. See the file header on why the milestone moved.
 */
const SELF_BUILT_BUDGET_SECONDS = 25 * 60;

/** How long the bot may spend walking to one destination before giving up. */
const WALK_LIMIT_TICKS = 90 * TPS;

interface Bot {
  readonly simulation: Simulation;
  ticks: number;
}

function newGame(seed: number): Bot {
  const started = createStartingWorld(seed);
  const simulation = new Simulation({ world: started.world, seed: started.seed });
  simulation.player.setTilePosition(WORLD_SPAWN.x, WORLD_SPAWN.y);
  for (const [itemId, count] of Object.entries(STARTING_KIT)) simulation.inventory.add(itemId, count);
  return { simulation, ticks: 0 };
}

function step(bot: Bot, ticks = 1): void {
  for (let i = 0; i < ticks; i++) {
    bot.simulation.tick();
    bot.ticks += 1;
  }
}

/** The sign of a difference, as a `movePlayer` component. */
function unit(delta: number): number {
  return delta === 0 ? 0 : delta > 0 ? 1 : -1;
}

/**
 * A four-neighbour route from the player to a tile, or null.
 *
 * Breadth-first over walkable tiles, which is what a human does when a lake is
 * in the way: they go round it. A greedy walker was tried first and three of
 * the four seeds passed — the fourth had its coal across an inlet, and a test
 * that reported "unreachable" there would be measuring the bot's stupidity
 * rather than the game's pacing (see the file header).
 *
 * Walkable is "buildable terrain with nothing standing on it", which is
 * `PlayerSystem.canStandAt` at tile granularity. It is deliberately *not* the
 * same function: that one works in subtiles and knows the player has width,
 * and a route that threads a one-tile gap is one the follower below will fail
 * to walk. The follower's own give-up is what catches that.
 */
function route(bot: Bot, toX: number, toY: number): { x: number; y: number }[] | null {
  const { world, entities, player } = bot.simulation;
  const walkable = (x: number, y: number): boolean =>
    isBuildable(world.getTile(x, y)) && entities.at(x, y) === undefined;

  const key = (x: number, y: number): number => (x + SEARCH_RADIUS) * (SEARCH_RADIUS * 4) + (y + SEARCH_RADIUS);
  const cameFrom = new Map<number, number>();
  const queue: number[] = [player.tileX, player.tileY];
  cameFrom.set(key(player.tileX, player.tileY), -1);

  for (let head = 0; head < queue.length; head += 2) {
    const x = queue[head] ?? 0;
    const y = queue[head + 1] ?? 0;
    if (x === toX && y === toY) break;

    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (Math.abs(nx) > SEARCH_RADIUS || Math.abs(ny) > SEARCH_RADIUS) continue;
      const k = key(nx, ny);
      if (cameFrom.has(k)) continue;
      // The destination itself may be ore under a miner-to-be or a tile the
      // player only needs to stand *near*, so it is always enterable.
      if (!(nx === toX && ny === toY) && !walkable(nx, ny)) continue;
      cameFrom.set(k, key(x, y));
      queue.push(nx, ny);
    }
  }

  if (!cameFrom.has(key(toX, toY))) return null;

  const path: { x: number; y: number }[] = [];
  for (let k = key(toX, toY); k !== -1; ) {
    const x = Math.floor(k / (SEARCH_RADIUS * 4)) - SEARCH_RADIUS;
    const y = (k % (SEARCH_RADIUS * 4)) - SEARCH_RADIUS;
    path.push({ x, y });
    const parent = cameFrom.get(k);
    if (parent === undefined || parent === -1) break;
    k = parent;
  }
  return path.reverse();
}

const NEIGHBOURS: readonly (readonly [number, number])[] = Object.freeze([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]);

/** How far from spawn the route search and the patch search look, in tiles. */
const SEARCH_RADIUS = 48;

/**
 * Walk until `(x, y)` is within `range` tiles, or give up.
 *
 * Follows the route above one waypoint at a time with ordinary `movePlayer`
 * commands, so what is being timed is the player's real walking speed through
 * the real movement system — §15's four tiles a second, one integer step a
 * tick — and not a teleport dressed up as a walk.
 *
 * ## Why it aims at tile *centres*
 *
 * The first version advanced to the next waypoint as soon as the player's tile
 * matched, and wedged itself on seed 4242: the player is 0.6 tiles wide, so one
 * that has just crossed into a tile still has a third of itself in the
 * previous one — and turning west there asks to enter the tile diagonally
 * behind, which was a chest. The player stood still and the bot gave up two
 * tiles from a coal patch it could see.
 *
 * That is not a bug in the game. It is what a player feels as "I am snagged on
 * the corner of my own chest", and a human resolves it by nudging clear. The
 * bot resolves it by never being off-centre in the first place: a waypoint is
 * reached when the player is within one step of its centre, so the box is only
 * ever astride a boundary in the direction it is travelling.
 *
 * It is worth writing down as a **friction point** rather than only as a test
 * fix — see C20's report.
 */
function walkTo(bot: Bot, x: number, y: number, range: number): boolean {
  const player = bot.simulation.player;
  if (player.isWithinRange(x, y, range)) return true;

  const path = route(bot, x, y);
  if (path === null) return false;

  let blocked = 0;
  let waypoint = 0;
  for (let i = 0; i < WALK_LIMIT_TICKS; i++) {
    if (player.isWithinRange(x, y, range)) {
      bot.simulation.commands.enqueue({ type: 'movePlayer', dx: 0, dy: 0 });
      step(bot);
      return true;
    }

    const target = path[waypoint];
    if (target === undefined) return false;

    const offX = tileCentreSubtile(target.x) - player.subX;
    const offY = tileCentreSubtile(target.y) - player.subY;
    if (Math.abs(offX) <= PLAYER_STEP_SUBTILES && Math.abs(offY) <= PLAYER_STEP_SUBTILES) {
      if (waypoint >= path.length - 1) return false;
      waypoint += 1;
      blocked = 0;
      continue;
    }

    bot.simulation.commands.enqueue({
      type: 'movePlayer',
      dx: Math.abs(offX) <= PLAYER_STEP_SUBTILES ? 0 : unit(offX),
      dy: Math.abs(offY) <= PLAYER_STEP_SUBTILES ? 0 : unit(offY),
    });
    const wasX = player.subX;
    const wasY = player.subY;
    step(bot);
    if (player.subX === wasX && player.subY === wasY) {
      blocked += 1;
      // Genuinely wedged against something the tile-granular route walked
      // through. Aim at the next waypoint rather than pathfinding again.
      if (blocked > 6) {
        if (waypoint >= path.length - 1) return false;
        waypoint += 1;
        blocked = 0;
      }
    } else {
      blocked = 0;
    }
  }
  return false;
}

/** Place a building, walking into range first. Throws with the refusal. */
function build(bot: Bot, buildingId: string, x: number, y: number, rotation: Rotation): void {
  if (!walkTo(bot, x, y, BUILD_RANGE_TILES - 1)) {
    throw new Error(`could not walk to ${buildingId} at ${x},${y}`);
  }
  bot.simulation.commands.enqueue({ type: 'build', buildingId, x, y, rotation });
  step(bot);
  const rejections = bot.simulation.commands.takeRejections();
  if (rejections.length > 0) {
    throw new Error(`${buildingId} at ${x},${y}: ${rejections.map((r) => r.reason).join(', ')}`);
  }
}

/**
 * The nearest 2x2 block of one resource that a miner could stand on.
 *
 * A miner is 2x2 and wants ore under all four tiles — not because the rules
 * require it (one tile is enough) but because a miner on one tile of ore
 * exhausts it four times as fast, and a player picks the solid block. Searched
 * outward from spawn in rings so "nearest" is true rather than approximate.
 */
function nearestPatch(world: World, resource: ResourceType, radius = 40): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;

  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const solid =
        world.getResource(x, y) === resource &&
        world.getResource(x + 1, y) === resource &&
        world.getResource(x, y + 1) === resource &&
        world.getResource(x + 1, y + 1) === resource;
      if (!solid) continue;
      const distance = x * x + y * y;
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = { x, y };
    }
  }
  return best;
}

/** Is every tile of a rectangle free of ore and buildable? Where a chain goes. */
function clearRun(world: World, x: number, y: number, width: number, height: number): boolean {
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (!isBuildable(world.getTile(x + i, y + j))) return false;
    }
  }
  return true;
}

interface Run {
  /** Simulated seconds from a new game to the first plate in the chest. */
  readonly firstPlateSeconds: number;
  /** Simulated seconds to the first *building* the factory made for itself. */
  readonly selfBuiltSeconds: number;
}

/** How much coal the bot mines by hand before lighting the furnace. */
const HAND_MINED_COAL = 20;

/**
 * Play a new game up to both milestones, and report when each was reached.
 *
 * ```text
 *   iron miner 2x2                        (on the nearest solid 2x2 of iron)
 *        | inserter
 *      furnace 2x2                        smelt_iron, hand-fed coal
 *        | inserter
 *      chest                     <-- milestone 1: a plate arrived unattended
 *        | inserter
 *      assembler 3x3                      make_chest: 4 iron_plate -> 1 chest
 *        | inserter
 *      chest                     <-- milestone 2: a *building* arrived
 * ```
 *
 * `make_chest` is the recipe that closes the loop with the one assembler the
 * starting kit contains: every other building recipe wants a gear or a
 * circuit, and making those *and* spending them needs two assemblers. Four
 * iron plates into a chest is the whole of "the factory builds itself", and it
 * is reachable from a single ore patch.
 *
 * No belt is laid, and that is a finding rather than a shortcut: a miner's
 * output tile is adjacent to an inserter's, so the shortest automated chain in
 * the game has no belt in it at all. The forty belts in the starting kit are
 * for the second thing the player builds.
 */
function playOpening(bot: Bot): Run {
  const world = bot.simulation.world;
  const iron = nearestPatch(world, ResourceType.Iron);
  const coal = nearestPatch(world, ResourceType.Coal);
  if (iron === null || coal === null) throw new Error('the start has no solid 2x2 of iron or coal');

  // The chain runs south from the iron: inserter, furnace, inserter, chest,
  // inserter, assembler, inserter, chest. Nine tiles deep and three wide.
  const site = { x: iron.x, y: iron.y + 2 };
  if (!clearRun(world, site.x, site.y, 3, 11)) throw new Error('no room south of the iron');

  build(bot, 'miner', iron.x, iron.y, SOUTH);
  build(bot, 'inserter', site.x, site.y, SOUTH);
  build(bot, 'furnace', site.x, site.y + 1, NORTH);
  build(bot, 'inserter', site.x, site.y + 3, SOUTH);
  build(bot, 'chest', site.x, site.y + 4, NORTH);

  // Coal by hand, which is what a player does before they have a second miner
  // on a coal patch. §15's manual rate is 0.5 items/s, so twenty coal is forty
  // seconds of mining and 160 seconds of furnace.
  if (!walkTo(bot, coal.x, coal.y, MINE_RANGE_TILES - 1)) throw new Error('could not reach coal');
  bot.simulation.commands.enqueue({ type: 'mineTile', x: coal.x, y: coal.y });
  step(bot, HAND_MINED_COAL * 2 * TPS);
  bot.simulation.commands.enqueue({ type: 'stopMining' });
  step(bot);

  const furnace = bot.simulation.entities.at(site.x, site.y + 1);
  if (furnace === undefined) throw new Error('the furnace is not there');
  if (!walkTo(bot, site.x, site.y + 1, MINE_RANGE_TILES - 1)) throw new Error('could not reach the furnace');
  bot.simulation.commands.enqueue({
    type: 'insertItems',
    entityId: furnace.id,
    itemId: 'coal',
    amount: HAND_MINED_COAL,
  });
  step(bot);

  const plateChest = chestAt(bot, site.x, site.y + 4);
  const plate = bot.simulation.items.idOf('iron_plate');
  const firstPlateSeconds = waitFor(bot, () => held(plateChest, plate) > 0, 'a plate never reached the chest');

  // Milestone 2: the assembler, fed from that same chest, making chests.
  build(bot, 'inserter', site.x, site.y + 5, SOUTH);
  build(bot, 'assembler', site.x, site.y + 6, NORTH);
  build(bot, 'inserter', site.x, site.y + 9, SOUTH);
  build(bot, 'chest', site.x, site.y + 10, NORTH);

  const assembler = bot.simulation.entities.at(site.x, site.y + 6);
  if (assembler === undefined) throw new Error('the assembler is not there');
  if (!walkTo(bot, site.x, site.y + 6, MINE_RANGE_TILES - 1)) throw new Error('could not reach the assembler');
  bot.simulation.commands.enqueue({ type: 'setRecipe', entityId: assembler.id, recipeId: 'make_chest' });
  step(bot);
  const rejections = bot.simulation.commands.takeRejections();
  if (rejections.length > 0) throw new Error(`setRecipe: ${rejections.map((r) => r.reason).join(', ')}`);

  const output = chestAt(bot, site.x, site.y + 10);
  const madeChest = bot.simulation.items.idOf('chest');
  const selfBuiltSeconds = waitFor(bot, () => held(output, madeChest) > 0, 'the factory never built anything');

  return { firstPlateSeconds, selfBuiltSeconds };
}

/** The chest standing on a tile. Throws rather than returning null: a missing
 *  chest means the script is wrong, and a null would be found three lines on. */
function chestAt(bot: Bot, x: number, y: number): { contents: [number, number][] } {
  const entity = bot.simulation.entities.at(x, y);
  const chest = entity === undefined ? null : asChest(entity);
  if (chest === null) throw new Error(`no chest at ${x},${y}`);
  return chest;
}

function held(chest: { contents: [number, number][] }, itemId: number): number {
  return chest.contents.find((entry) => entry[0] === itemId)?.[1] ?? 0;
}

/** Tick, doing nothing, until `done`. Returns the elapsed simulated seconds. */
function waitFor(bot: Bot, done: () => boolean, failure: string): number {
  for (let i = 0; i < WAIT_LIMIT_TICKS; i++) {
    if (done()) return bot.ticks / TPS;
    step(bot);
  }
  throw new Error(failure);
}

/** How long the bot waits for a factory to produce, before calling it stalled. */
const WAIT_LIMIT_TICKS = 30 * 60 * TPS;

describe('a new game reaches C20’s milestones inside its budget', () => {
  const runs = new Map<number, Run>();

  it.each(SEEDS.map((seed) => [seed] as const))('seed %i', (seed) => {
    const bot = newGame(seed);
    const run = playOpening(bot);
    runs.set(seed, run);

    expect(
      run.firstPlateSeconds,
      `seed ${seed}: first plate at ${Math.round(run.firstPlateSeconds)}s`,
    ).toBeLessThan(FIRST_PLATE_BUDGET_SECONDS);
    expect(
      run.selfBuiltSeconds,
      `seed ${seed}: first self-made building at ${Math.round(run.selfBuiltSeconds)}s`,
    ).toBeLessThan(SELF_BUILT_BUDGET_SECONDS);
    expect(run.selfBuiltSeconds).toBeGreaterThan(run.firstPlateSeconds);
  });

  /**
   * The opening is *fast*, and the assertion says so on purpose.
   *
   * C20 asks for an early game that is "neither a grind nor trivially fast",
   * and the honest report is that it is closer to the second — the starting
   * kit is a working factory in a bag. The floor below is not a target to
   * reach; it is a tripwire. If a later chunk makes the first plate take five
   * minutes, that is a real change to how the game opens and it should be a
   * decision, not something noticed in a playtest six chunks later.
   */
  it('is fast rather than slow, which is C20’s finding and not its goal', () => {
    expect(runs.size).toBe(SEEDS.length);
    for (const [seed, run] of runs) {
      expect(run.firstPlateSeconds, `seed ${seed}`).toBeLessThan(3 * 60);
      expect(run.firstPlateSeconds, `seed ${seed}`).toBeGreaterThan(10);
    }
  });
});

describe('the starting kit is what the game actually hands out', () => {
  /**
   * The kit above is a copy of `main.ts`'s, and a copy that drifts makes the
   * measurement above a measurement of something nobody plays. There is no
   * seam to import it through — `main.ts` is the composition root and boots a
   * browser — so this asserts the two properties that matter about it rather
   * than the numbers: it is all buildings, and it contains everything the
   * chain above needs.
   */
  it('is buildings only, and enough for the first factory', () => {
    const simulation = new Simulation({ world: createStartingWorld(1).world });
    for (const [itemId, count] of Object.entries(STARTING_KIT)) {
      expect(simulation.buildings.has(itemId), `${itemId} is not a building`).toBe(true);
      expect(count).toBeGreaterThan(0);
    }
    for (const needed of ['miner', 'inserter', 'furnace', 'chest']) {
      expect(STARTING_KIT[needed] ?? 0, `${needed} missing from the kit`).toBeGreaterThan(0);
    }
    // One assembler, and no splitter: the two decisions C20 made about the kit.
    expect(STARTING_KIT['assembler']).toBe(1);
    expect(STARTING_KIT['splitter']).toBeUndefined();
  });
});
