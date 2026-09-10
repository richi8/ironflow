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
