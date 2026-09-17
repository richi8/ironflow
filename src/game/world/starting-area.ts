/**
 * Starting-area validation, and the seed retry it drives. See ironflow.md C19
 * task 5.
 *
 * Procedural generation is a promise that every seed is a *different* run, and
 * the cost of that promise is that some seeds are not runs at all: an island
 * of forty tiles, or a spawn with copper and nothing else. The plan's answer
 * is not to make the generator timid — a timid generator fails pillar 2 — but
 * to check the result and reject it:
 *
 * ```text
 * within 30 tiles of spawn:  >= 1 iron patch of >= 20 tiles
 *                            >= 1 copper patch of >= 15 tiles
 *                            >= 1 coal patch of >= 15 tiles
 *                            >= 1 stone patch of >= 10 tiles
 *                            >= 400 contiguous buildable land tiles
 *                            spawn tile itself buildable and not water-locked
 * ```
 *
 * A failing seed is perturbed by one and retried, up to 64 times. **Never hand
 * the player an unplayable world** — and never hand them a silently different
 * one either, which is why `createStartingWorld` reports the seed it settled
 * on rather than quietly substituting it.
 *
 * ## Why "patch" is measured by flood fill
 *
 * "One iron patch of at least 20 tiles" is not "at least 20 iron tiles". Twenty
 * iron tiles scattered as four five-tile slivers is not a patch a miner can be
 * put on — a miner is 2×2 and wants a contiguous deposit under it. So the
 * check counts **connected regions**, four-neighbour, and asks for one large
 * enough. That is the difference between a start that works and one that
 * technically satisfies an inequality.
 */

import type { TileCoord } from './coordinates.js';
import { ResourceType, resourceName } from './resource.js';
import { isBuildable } from './tile.js';
import { toUint32 } from '../rng.js';
import { createWorldGenerator } from './world-generator.js';
import { World } from './world.js';

/**
 * Where a new game starts. C19 measures its guarantees from here.
 *
 * The origin, and not the (6, 6) C06 used while the world was a hand-placed
 * playground. With a generated map there is no reason to prefer any tile, and
 * one strong reason to prefer this one: the distance-based scaling in
 * `world-generator.ts` measures from the origin, so spawning anywhere else
 * would mean the player starts on ore that is already slightly richer than the
 * generator's own baseline.
 */
export const WORLD_SPAWN: TileCoord = Object.freeze({ x: 0, y: 0 });

/** How far from spawn the guarantees below reach, in tiles. */
export const START_RADIUS = 30;

/** Contiguous buildable land the start must offer, in tiles. */
export const MIN_BUILDABLE_TILES = 400;

/** How many perturbed seeds are tried before the generator gives up. */
export const MAX_SEED_ATTEMPTS = 64;

/** The smallest connected deposit of each resource a start must contain. */
export const REQUIRED_PATCHES: readonly { readonly resource: ResourceType; readonly tiles: number }[] =
  Object.freeze([
    Object.freeze({ resource: ResourceType.Iron, tiles: 20 }),
    Object.freeze({ resource: ResourceType.Copper, tiles: 15 }),
    Object.freeze({ resource: ResourceType.Coal, tiles: 15 }),
    Object.freeze({ resource: ResourceType.Stone, tiles: 10 }),
  ]);

/** What `inspectStartingArea` found. A report, so a failure says what failed. */
export interface StartingAreaReport {
  readonly ok: boolean;
  /** Is the spawn tile itself buildable? */
  readonly spawnBuildable: boolean;
  /** Buildable tiles reachable from spawn without crossing water. */
  readonly buildableTiles: number;
  /** Largest connected deposit of each resource, by resource name. */
  readonly largestPatch: Readonly<Record<string, number>>;
  /** One line per unmet requirement. Empty when `ok`. */
  readonly failures: readonly string[];
}

/** Four-neighbour offsets. The connectivity a belt and a walking player use. */
const NEIGHBOURS: readonly TileCoord[] = Object.freeze([
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: -1, y: 0 }),
  Object.freeze({ x: 0, y: 1 }),
  Object.freeze({ x: 0, y: -1 }),
]);

/** Is a tile inside the disc the guarantees are measured over? */
function inStartArea(x: number, y: number): boolean {
  const dx = x - WORLD_SPAWN.x;
  const dy = y - WORLD_SPAWN.y;
  return dx * dx + dy * dy <= START_RADIUS * START_RADIUS;
}

/**
 * Flood-fill from a tile, counting tiles that satisfy a predicate.
 *
 * An explicit stack rather than recursion: the region can be three thousand
 * tiles, and a recursive fill of that depth is a stack overflow on some
 * engines and not on others — which would make "is this seed playable?" a
 * question with a machine-dependent answer.
 */
function floodFill(
  startX: number,
  startY: number,
  seen: Set<number>,
  accept: (x: number, y: number) => boolean,
): number {
  const key = (x: number, y: number): number => (x + START_RADIUS) * 512 + (y + START_RADIUS);
  if (seen.has(key(startX, startY)) || !accept(startX, startY)) return 0;

  let count = 0;
  const stack: number[] = [startX, startY];
  seen.add(key(startX, startY));

  while (stack.length > 0) {
    const y = stack.pop();
    const x = stack.pop();
    if (x === undefined || y === undefined) break;
    count += 1;

    for (const offset of NEIGHBOURS) {
      const nx = x + offset.x;
      const ny = y + offset.y;
      if (!inStartArea(nx, ny)) continue;
      const k = key(nx, ny);
      if (seen.has(k) || !accept(nx, ny)) continue;
      seen.add(k);
      stack.push(nx, ny);
    }
  }

  return count;
}

/**
 * Measure a world's starting area against C19 task 5.
 *
 * Reads through `World`, which generates the ~nine world chunks the disc
 * touches. That is deliberate: the same `World` is then handed to the game, so
 * validating a seed costs nothing that would have to be paid again.
 */
export function inspectStartingArea(world: World): StartingAreaReport {
  const failures: string[] = [];

  const spawnBuildable = isBuildable(world.getTile(WORLD_SPAWN.x, WORLD_SPAWN.y));
  if (!spawnBuildable) failures.push('spawn tile is not buildable');

  // From spawn, so this answers "buildable and reachable" rather than merely
  // "buildable somewhere in the disc" — the water-locked case task 5 names.
  const buildableTiles = floodFill(WORLD_SPAWN.x, WORLD_SPAWN.y, new Set<number>(), (x, y) =>
    isBuildable(world.getTile(x, y)),
  );
  if (buildableTiles < MIN_BUILDABLE_TILES) {
    failures.push(`only ${buildableTiles} contiguous buildable tiles, needs ${MIN_BUILDABLE_TILES}`);
  }

  const largestPatch: Record<string, number> = {};
  for (const requirement of REQUIRED_PATCHES) {
    const largest = largestDeposit(world, requirement.resource);
    largestPatch[resourceName(requirement.resource)] = largest;
    if (largest < requirement.tiles) {
      failures.push(
        `largest ${resourceName(requirement.resource)} patch is ${largest} tiles, needs ${requirement.tiles}`,
      );
    }
  }

  return {
    ok: failures.length === 0,
    spawnBuildable,
    buildableTiles,
    largestPatch,
    failures,
  };
}

/** The biggest connected deposit of one resource inside the start area. */
function largestDeposit(world: World, resource: ResourceType): number {
  const accept = (x: number, y: number): boolean =>
    world.getResource(x, y) === resource && world.getResourceAmount(x, y) > 0;

  const seen = new Set<number>();
  let largest = 0;

  // A fixed scan order, so the answer does not depend on where the fill
  // happened to start (§6 R4 applies to a validator as much as to a system).
  for (let y = WORLD_SPAWN.y - START_RADIUS; y <= WORLD_SPAWN.y + START_RADIUS; y++) {
    for (let x = WORLD_SPAWN.x - START_RADIUS; x <= WORLD_SPAWN.x + START_RADIUS; x++) {
      if (!inStartArea(x, y)) continue;
      const size = floodFill(x, y, seen, accept);
      if (size > largest) largest = size;
    }
  }

  return largest;
}

/** A world that passed validation, and what it cost to find it. */
export interface StartingWorld {
  readonly world: World;
  /** The seed that was accepted. May differ from the one requested. */
  readonly seed: number;
  /** The seed the caller asked for, before any perturbation. */
  readonly requestedSeed: number;
  /** How many seeds were tried, including the accepted one. `1` on a first hit. */
  readonly attempts: number;
  readonly report: StartingAreaReport;
}

/**
 * A validated world for a seed, perturbing by one until one is playable.
 *
 * `seed + 1` rather than a fresh random seed, exactly as C19 task 5 says: the
 * perturbation has to be deterministic or "seed 7" would mean a different
 * world on two machines, and the whole contract would be void. Each attempt is
 * an independent draw, because one added to the seed changes every hash.
 *
 * Throws when all `MAX_SEED_ATTEMPTS` fail. The plan's instruction is "never
 * hand the player an unplayable world", and the only two ways to honour it are
 * to keep trying forever or to say so. Silently returning attempt 64 would be
 * the third, and it is the one that produces a bug report about a world with
 * no iron in it.
 */
export function createStartingWorld(requestedSeed: number): StartingWorld {
  const base = toUint32(requestedSeed);
  let lastReport: StartingAreaReport | null = null;

  for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt++) {
    const seed = toUint32(base + attempt);
    const world = new World(createWorldGenerator(seed));
    const report = inspectStartingArea(world);
    if (report.ok) {
      return { world, seed, requestedSeed: base, attempts: attempt + 1, report };
    }
    lastReport = report;
  }

  const why = lastReport === null ? 'unknown' : lastReport.failures.join('; ');
  throw new Error(
    `createStartingWorld: no playable starting area within ${MAX_SEED_ATTEMPTS} seeds of ${base} (last: ${why}).`,
  );
}
