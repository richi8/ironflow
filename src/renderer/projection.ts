/**
 * The projection contract. See ironflow.md §5.
 *
 * THIS IS THE ONLY FILE IN THE CODEBASE THAT CONVERTS BETWEEN TILE SPACE AND
 * SCREEN SPACE. If a second file needs to project, it imports this one. A test
 * (`tests/unit/projection-boundary.test.ts`) fails the build if projection
 * arithmetic appears anywhere else.
 *
 * The transform is unzoomed and untranslated: it maps tile space to a fixed
 * "world pixel" space. Camera pan and zoom are a separate affine step applied
 * on top, and live in `camera.ts` — that separation is what keeps the two
 * concerns from being reinvented in the middle of a draw call.
 */

/** A point in screen (or world-pixel) space. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A fractional position in tile space.
 *
 * Distinct from `TileCoord` by intent: a `TileCoord` names a tile, a
 * `WorldPoint` names a location that is usually inside one. TypeScript cannot
 * tell them apart structurally, so the distinction is by name and by which
 * function returned it. Floor a `WorldPoint` to get the tile containing it.
 */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/** Full diamond width in pixels at zoom 1. */
export const TILE_W = 64;

/** Full diamond height in pixels at zoom 1. 2:1, so TILE_W is twice this. */
export const TILE_H = 32;

const HALF_W = TILE_W / 2;
const HALF_H = TILE_H / 2;

/**
 * Project a tile-space position to world-pixel space.
 *
 * For an integer tile, the returned point is the *apex* (top vertex) of that
 * tile's diamond; the diamond's centre is `HALF_H` below it and its area
 * corresponds to the unit square `[x, x+1] x [y, y+1]` in tile space. That is
 * what makes `floor(screenToTile(p))` the tile containing `p`.
 *
 * Accepts fractional input: the transform is linear, so it interpolates.
 *
 * Allocates a point per call. At C01 volumes that is irrelevant, and §16 says
 * profile before optimising; C29 is where per-tile allocation gets measured.
 */
export function tileToScreen(x: number, y: number): ScreenPoint {
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H };
}

/**
 * The exact inverse of `tileToScreen`. Returns a fractional tile position;
 * `Math.floor` both components for the tile that contains the point.
 */
export function screenToTile(sx: number, sy: number): WorldPoint {
  const a = sx / HALF_W;
  const b = sy / HALF_H;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
