/**
 * The projection contract. See ironflow.md §5 and C27A.
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
 *
 * ## Why it is a scale and nothing else (C27A)
 *
 * The transform was a rotation-and-scale until C27A and is now a scale. Tile
 * space and screen space share their axes: `+X` is right on both, `+Y` is down
 * on both, and a tile is a square. Everything that made the old transform
 * interesting — a diagonal depth axis, a screen direction that was between two
 * tile directions, a footprint that was a rotated rectangle on screen — was a
 * property of the projection rather than of the game, and went with it.
 *
 * The two functions remain, rather than collapsing into a constant that every
 * call site multiplies by, because the boundary they draw is the point: one
 * place converts, and a future projection is one file's worth of change. That
 * is not speculation — this file is the proof, since C27A *was* that change.
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

/**
 * Tile width in pixels at zoom 1.
 *
 * 48 rather than the 64 the diamond was wide: a diamond is twice as wide as it
 * is tall, so 64 wide was 32 of vertical progress per tile, and a square tile
 * of 64 would have cut the rows on screen nearly in half. At 48 a 1080p
 * viewport holds about 40x22 tiles at zoom 1, which is the density the genre
 * plays at, and a world chunk's cached bitmap is 1536 square rather than 2048.
 */
export const TILE_W = 48;

/** Tile height in pixels at zoom 1. Equal to `TILE_W`: tiles are square. */
export const TILE_H = 48;

/**
 * Project a tile-space position to world-pixel space.
 *
 * For an integer tile, the returned point is the **north-west corner** of that
 * tile's square; its area corresponds to the unit square `[x, x+1] x [y, y+1]`
 * in tile space, and its centre is half a tile right and down of the returned
 * point. That is what makes `floor(screenToTile(p))` the tile containing `p`.
 *
 * Accepts fractional input: the transform is linear, so it interpolates.
 */
export function tileToScreen(x: number, y: number): ScreenPoint {
  return { x: x * TILE_W, y: y * TILE_H };
}

/**
 * The exact inverse of `tileToScreen`. Returns a fractional tile position;
 * `Math.floor` both components for the tile that contains the point.
 */
export function screenToTile(sx: number, sy: number): WorldPoint {
  return { x: sx / TILE_W, y: sy / TILE_H };
}
