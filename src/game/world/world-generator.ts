/**
 * Placeholder world generation. See ironflow.md C02 ("out of scope") and C19.
 *
 * C02 needs *a* generator so the world has something to be lazy about; it does
 * not need generation content, which is C19's whole chunk. This is the trivial
 * checkerboard the plan sanctions, and it exists mainly to make the two things
 * C02 must get right visible the moment C03 draws anything:
 *
 *   - world-chunk boundaries are marked, so a seam or an off-by-one in the
 *     lazy-creation path is obvious rather than subtle;
 *   - the pattern is anchored to absolute tile coordinates, so the negative
 *     half of the world is visibly continuous with the positive half instead of
 *     mirrored — the failure mode `Math.floor` division exists to prevent.
 *
 * It is already **pure and positional** in C19's sense: the contents of a world
 * chunk depend only on its coordinates, never on generation order. Adopting
 * that discipline in the stub means C19 replaces a function, not a contract.
 */

import { CHUNK_SIZE, createChunk, localIndex, type WorldChunk } from './chunk.js';
import { NOMINAL_RESOURCE_AMOUNT, ResourceType } from './resource.js';
import { TileType } from './tile.js';
import type { ChunkGenerator } from './world.js';

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
 * Their arrangement is a **test fixture**, not level design — C19 generates
 * the real map and deletes this. What it is arranged for is the chunk's
 * acceptance criteria: all four resource types on screen at once so the §11
 * tints can be told apart, and radii large enough that a patch shows every
 * fullness bucket at the same time (see `patchAmount`).
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
 * **Scaffolding**, in the same spirit as C02's checkerboard and deleted by the
 * same chunk: C19 generates the world. It exists because three of C06's
 * acceptance criteria — "placing on water, on an occupied tile, or without
 * resources is rejected with a distinct, visible reason" — cannot be *looked
 * at* in a world with neither water nor ore in it, and §20 asks for every
 * criterion to be verified in the running application and not only in a test.
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
