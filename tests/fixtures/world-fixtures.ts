/**
 * The fixed worlds tests build on. Formerly `src/game/world/world-generator.ts`.
 *
 * C02 and C09 shipped a checkerboard and four hand-placed ore discs as
 * scaffolding, and both chunks said the same thing about them: C19 generates
 * the real map and deletes this. C19 did. They moved here rather than being
 * deleted outright, because a *test* of the build system or the terrain layer
 * wants a world it can state facts about — "the pond is at (14, 3)", "tile
 * (2, 12) is iron" — and a procedurally generated one cannot offer that
 * without pinning a seed and then re-pinning it every time the generator is
 * tuned. A fixture that says what it is is the honest version of what these
 * two functions already were.
 *
 * They remain **pure and positional**, because the systems under test are
 * entitled to the same guarantee `ChunkGenerator` documents. The real
 * generator has its own tests in `tests/unit/world-generator.test.ts`.
 */

import { CHUNK_SIZE, createChunk, localIndex, type WorldChunk } from '../../src/game/world/chunk.js';
import { NOMINAL_RESOURCE_AMOUNT, ResourceType } from '../../src/game/world/resource.js';
import { TileType } from '../../src/game/world/tile.js';
import type { ChunkGenerator } from '../../src/game/world/world.js';

/** Edge of one square of the checkerboard, in tiles. */
const CHECKER_SIZE = 8;

/**
 * A generator producing an 8×8-tile checkerboard of grass and dirt, outlined in
 * stone along every world-chunk boundary. No resources, no water.
 */
export function createCheckerboardGenerator(): ChunkGenerator {
  return function generateCheckerboardChunk(cx: number, cy: number): WorldChunk {
    const chunk = createChunk(cx, cy);
    const originX = cx * CHUNK_SIZE;
    const originY = cy * CHUNK_SIZE;

    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const onBoundary = lx === 0 || ly === 0 || lx === CHUNK_SIZE - 1 || ly === CHUNK_SIZE - 1;
        chunk.terrain[localIndex(lx, ly)] = onBoundary
          ? TileType.Stone
          : checker(originX + lx, originY + ly);
      }
    }

    return chunk;
  };
}

/**
 * Which colour of the checkerboard an absolute tile falls on.
 *
 * `Math.floor` again, and for the same reason as `toChunkCoord`: truncating
 * would make the squares either side of the origin the same colour and hide a
 * whole class of negative-coordinate bug behind a plausible-looking pattern.
 */
function checker(x: number, y: number): TileType {
  const gx = Math.floor(x / CHECKER_SIZE);
  const gy = Math.floor(y / CHECKER_SIZE);
  return (gx + gy) % 2 === 0 ? TileType.Grass : TileType.Dirt;
}

/* -------------------------------------------------------------------------- *
 * The playground
 * -------------------------------------------------------------------------- */

interface Disc {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Somewhere to sail a miner into. */
const POND: Disc = { x: 14, y: 3, radius: 3.2 };

/**
 * The hand-placed patches C09 task 4 asks for: one of each resource, near the
 * origin, close enough together that a starting factory can reach all four.
 *
 * Their arrangement is a **test fixture**, not level design, and always was.
 * What it is arranged for is C09's acceptance criteria: all four resource
 * types on screen at once so the §11 tints can be told apart, and radii large
 * enough that a patch shows every fullness bucket at the same time (see
 * `patchAmount`). Tests name these coordinates, so moving a disc is a change
 * to a fixture and not to the game.
 */
const PATCHES: readonly (Disc & { readonly resource: ResourceType })[] = Object.freeze([
  { x: 3, y: 13, radius: 3.6, resource: ResourceType.Iron },
  { x: 13, y: 15, radius: 3, resource: ResourceType.Copper },
  { x: -6, y: 4, radius: 3, resource: ResourceType.Coal },
  { x: 6, y: -6, radius: 2.6, resource: ResourceType.Stone },
]);

/**
 * How much ore sits on a patch tile: full at the centre, thin at the rim.
 *
 * A flat patch would be one colour until the moment a miner emptied a tile,
 * which makes C09 acceptance 1 — "a patch depletes tile by tile and visibly
 * thins as it does" — impossible to see until it is nearly over. A linear
 * falloff puts all four fullness buckets on screen as concentric rings from the
 * first frame, so a wrong bucket boundary is visible rather than inferred.
 *
 * The rim keeps a tenth of a full tile rather than dropping to zero: a tile
 * inside a patch outline with nothing on it reads as a rendering bug, and it
 * would also make the miner's "needs >=1 resource tile" rule depend on where
 * the disc's edge landed.
 */
function patchAmount(distance: number, radius: number): number {
  const t = radius <= 0 ? 0 : Math.min(1, distance / radius);
  return Math.max(RIM_AMOUNT, Math.round(NOMINAL_RESOURCE_AMOUNT * (1 - t)));
}

/** What a patch tile holds at its outermost ring. A tenth of a full tile. */
const RIM_AMOUNT = Math.round(NOMINAL_RESOURCE_AMOUNT / 10);

function distanceTo(disc: Disc, x: number, y: number): number {
  const dx = x - disc.x;
  const dy = y - disc.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function inside(disc: Disc, x: number, y: number): boolean {
  const dx = x - disc.x;
  const dy = y - disc.y;
  return dx * dx + dy * dy <= disc.radius * disc.radius;
}

/**
 * The checkerboard, plus a pond and one patch of each resource near the origin.
 *
 * It exists because three of C06's acceptance criteria — "placing on water, on
 * an occupied tile, or without resources is rejected with a distinct, visible
 * reason" — cannot be checked in a world with neither water nor ore in it. C19
 * gave the running game a generated map instead; what is left here is the part
 * a build-system test actually needs, which is knowing exactly where the water
 * is.
 *
 * C09 replaced its two placeholder patches with real ones. The sand it used to
 * stamp under them went with the change: sand was standing in for an ore
 * sprite that did not exist yet, and now that the tint and the piles draw, a
 * second cue would only hide whether the first one works.
 *
 * Pure and positional like its base, so a world chunk visited twice is
 * identical both times.
 */
export function createPlaygroundGenerator(): ChunkGenerator {
  const base = createCheckerboardGenerator();

  return function generatePlaygroundChunk(cx: number, cy: number): WorldChunk {
    const chunk = base(cx, cy);
    const originX = cx * CHUNK_SIZE;
    const originY = cy * CHUNK_SIZE;

    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = originX + lx;
        const y = originY + ly;
        const index = localIndex(lx, ly);

        if (inside(POND, x, y)) {
          chunk.terrain[index] = TileType.Water;
          continue;
        }

        for (const patch of PATCHES) {
          const distance = distanceTo(patch, x, y);
          if (distance > patch.radius) continue;
          chunk.resource[index] = patch.resource;
          chunk.resourceAmount[index] = patchAmount(distance, patch.radius);
          break;
        }
      }
    }

    return chunk;
  };
}
