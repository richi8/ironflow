/**
 * Tile space. See ironflow.md §5 and §6.
 *
 * This file is the simulation's entire vocabulary for "where". It contains no
 * pixels, no screen coordinates and no isometric concepts — those live behind
 * `renderer/projection.ts`, which is the only bridge between the two spaces.
 *
 * Axes: +X right, +Y down. Adjacency is `x±1, y±1`. Nothing here knows or cares
 * that the renderer draws these tiles as diamonds.
 */

/** An integer position in tile space. Fractional positions are not tiles. */
export interface TileCoord {
  readonly x: number;
  readonly y: number;
}

/**
 * A quarter-turn, clockwise from north: 0 = N, 1 = E, 2 = S, 3 = W.
 *
 * Used for belt direction, inserter facing and building orientation. Clockwise
 * on screen and clockwise in tile space are the same rotation, because the
 * projection is a rotation-and-scale — see the linearity test in
 * `tests/unit/projection.test.ts`.
 */
export type Rotation = 0 | 1 | 2 | 3;

/** Is `value` one of the four quarter-turns? */
export function isRotation(value: number): value is Rotation {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

export const NORTH = 0 satisfies Rotation;
export const EAST = 1 satisfies Rotation;
export const SOUTH = 2 satisfies Rotation;
export const WEST = 3 satisfies Rotation;

/**
 * The unit step for each `Rotation`, indexed by it.
 *
 * `DIRECTION_OFFSETS[r]` is always equal to `rotateOffset({x: 0, y: -1}, r)`;
 * a test pins that, so the table and the function can never drift apart.
 */
export const DIRECTION_OFFSETS: readonly TileCoord[] = Object.freeze([
  Object.freeze({ x: 0, y: -1 }), // N
  Object.freeze({ x: 1, y: 0 }), // E
  Object.freeze({ x: 0, y: 1 }), // S
  Object.freeze({ x: -1, y: 0 }), // W
]);

/**
 * The inclusive tile-coordinate range `tileKey` can pack, on both axes.
 *
 * A signed 16-bit field is asymmetric: 32,768 tiles west of the origin but only
 * 32,767 east of it. The plan writes this as "±32,768"; the honest bound is
 * below. The world is 65,536 tiles across either way, which is ~2,000 screens
 * at zoom 1 — far past anything a v1 factory will reach.
 */
export const TILE_MIN = -32768;
export const TILE_MAX = 32767;

/** Bias that maps [TILE_MIN, TILE_MAX] onto [0, 65535]. */
const KEY_BIAS = 32768;

/**
 * Pack a tile coordinate into a single number for use as a `Map` key.
 *
 * The result is a signed 32-bit integer — a bit pattern, not a meaningful
 * number — and is injective over the documented range. Staying inside int32
 * keeps every key a tagged small integer in V8, which matters because this is
 * the key type for the occupancy map that placement, belts and inserters all
 * hit every tick. A `${x},${y}` string would allocate on every lookup.
 *
 * ## Why this validates on every call
 *
 * C01 task 1 says "assert it in dev builds", but `game/` may not import Vite
 * (§4), so there is no build-mode flag here to branch on. The choice is
 * therefore always-check or never-check, and the failure this catches is the
 * worst kind: an out-of-range or fractional coordinate does not throw, it
 * silently collides with a *different* tile and corrupts the world. Four
 * comparisons are noise next to the hash lookup they precede. If C28's
 * profiler ever disagrees, that is the moment to gate it — not before (§16).
 */
export function tileKey(x: number, y: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new RangeError(`tileKey: tile coordinates must be integers, got (${x}, ${y}).`);
  }
  if (x < TILE_MIN || x > TILE_MAX || y < TILE_MIN || y > TILE_MAX) {
    throw new RangeError(
      `tileKey: (${x}, ${y}) is outside the packable range [${TILE_MIN}, ${TILE_MAX}].`,
    );
  }
  return (((x + KEY_BIAS) << 16) | (y + KEY_BIAS)) | 0;
}

/** Grid distance between two tiles. There are no diagonals in tile space. */
export function manhattan(a: TileCoord, b: TileCoord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Rotate an offset clockwise by `r` quarter-turns.
 *
 * With +X right and +Y down, one clockwise turn is `(x, y) -> (-y, x)`. Done
 * as an exact integer switch rather than a sin/cos matrix, so a rotated
 * building footprint is bit-identical on every machine (§6).
 *
 * Negation is written `0 - v` rather than `-v` deliberately: `-0` is what the
 * unary form produces for a zero component, and `-0` is a determinism trap.
 * It compares equal to `0` everywhere except the two places that matter —
 * `Object.is`/`deepEqual`, and `JSON.stringify`, which silently normalises it
 * to `0`. A rotated footprint containing `-0` would therefore survive a save
 * round trip as a *different* value and fail the §6 R8 equality test, months
 * after the code that made it was written.
 */
export function rotateOffset(o: TileCoord, r: Rotation): TileCoord {
  switch (r) {
    case NORTH:
      return { x: o.x, y: o.y };
    case EAST:
      return { x: 0 - o.y, y: o.x };
    case SOUTH:
      return { x: 0 - o.x, y: 0 - o.y };
    case WEST:
      return { x: o.y, y: 0 - o.x };
  }
}

/**
 * An inclusive rectangle in tile space. `maxX < minX` means "nothing".
 *
 * This lives here rather than beside the camera that first needed it (C01)
 * because it is a tile-space value with no screen-space content, and `game/`
 * may not import `renderer/` (§4). `World.forEachChunkInBounds` and
 * `Camera.visibleTileBounds` must agree on inclusivity or the renderer culls a
 * row of tiles the world happily provides — one shared type makes that
 * disagreement impossible rather than merely unlikely.
 */
export interface TileBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}
