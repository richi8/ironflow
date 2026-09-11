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
import type { ChunkGenerator } from './world.js';
import { TileType } from './tile.js';

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

/**
 * Resource ids for the playground below.
 *
 * C09 owns the real ones and the item registry behind them; a world chunk
 * stores a byte per tile and `NO_RESOURCE` is 0, so any non-zero number works
 * until then. Named rather than inlined so C09 has one place to correct.
 */
const PLAYGROUND_IRON = 1;
const PLAYGROUND_COPPER = 2;

/** Units of ore on every tile of a playground patch. */
const PLAYGROUND_PATCH_AMOUNT = 2000;

interface Disc {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Somewhere to sail a miner into. */
const POND: Disc = { x: 14, y: 3, radius: 3.2 };

const PATCHES: readonly (Disc & { readonly resource: number })[] = Object.freeze([
  { x: 3, y: 13, radius: 3, resource: PLAYGROUND_IRON },
  { x: 13, y: 14, radius: 2.4, resource: PLAYGROUND_COPPER },
]);

function inside(disc: Disc, x: number, y: number): boolean {
  const dx = x - disc.x;
  const dy = y - disc.y;
  return dx * dx + dy * dy <= disc.radius * disc.radius;
}

/**
 * The checkerboard, plus a pond and two ore patches near the origin.
 *
 * **Scaffolding**, in the same spirit as C02's checkerboard and deleted by the
 * same chunks: C09 places real patches and C19 generates the world. It exists
 * because three of C06's acceptance criteria — "placing on water, on an
 * occupied tile, or without resources is rejected with a distinct, visible
 * reason" — cannot be *looked at* in a world with neither water nor ore in it,
 * and §20 asks for every criterion to be verified in the running application
 * and not only in a test.
 *
 * The patches are stamped onto sand because C09 is what draws ore piles: until
 * then the only way to see where a miner may go is for the ground under it to
 * look different. Pure and positional like its base, so a world chunk visited
 * twice is identical both times.
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
          if (!inside(patch, x, y)) continue;
          chunk.terrain[index] = TileType.Sand;
          chunk.resource[index] = patch.resource;
          chunk.resourceAmount[index] = PLAYGROUND_PATCH_AMOUNT;
          break;
        }
      }
    }

    return chunk;
  };
}
