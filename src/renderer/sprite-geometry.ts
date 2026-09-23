/**
 * The numbers every sprite is drawn to. See ironflow.md §11's asset spec.
 *
 * Split out of `sprite-atlas.ts` by C29, which gave the atlas a second
 * implementation and the drawings a file of their own (`sprite-painter.ts`).
 * Both need the same geometry, and a module each of them imports is the only
 * way to share it without the two importing each other. `sprite-atlas.ts`
 * re-exports everything here, so nothing that imported these from it moved.
 *
 * This file needs to know how big a tile is on screen, which §5 says only
 * `projection.ts` may know. It therefore asks, rather than restating: the
 * projection is linear, so `tileToScreen(1, 0)` and `tileToScreen(0, 1)` *are*
 * its entire geometry, and every measurement below is built from those two
 * vectors.
 */

import { tileToScreen } from './projection.js';

/** Screen displacement of one tile step east, at zoom 1. */
export const EAST_STEP = tileToScreen(1, 0);

/** Screen displacement of one tile step south, at zoom 1. */
export const SOUTH_STEP = tileToScreen(0, 1);

/**
 * Half the width of one tile's ground face, in world pixels at zoom 1.
 *
 * Taken from each axis's own basis vector. Before C27A both came out of
 * `EAST_STEP`, because one step east moved half a tile width right and half a
 * tile height down — true of a 2:1 diamond and false of a square, where a step
 * east has no vertical component at all.
 */
export const TILE_HALF_WIDTH = EAST_STEP.x / 2;

/** Half the height of one tile's ground face, in world pixels at zoom 1. */
export const TILE_HALF_HEIGHT = SOUTH_STEP.y / 2;

/**
 * How far one unit of bulk lifts a sprite up the screen, in world pixels at
 * zoom 1. See C27B and §11's asset spec: 0.45 tiles.
 *
 * The ground is drawn from directly above and entities are drawn from a camera
 * tilted down at them — which is not one consistent projection, and is exactly
 * what the genre does. A tile stays square, so a footprint stays a rectangle
 * and a screen direction stays a tile direction (C27A's whole point); a machine
 * standing on it shows its top and its near face, so it reads as a thing in the
 * world rather than as paint on the floor.
 */
export const RISE_UNIT = TILE_HALF_HEIGHT * 0.9;

/**
 * How far a shadow slides per pixel of lift.
 *
 * The light is high and to the north-west, so a shadow falls south-east and is
 * shorter than the thing casting it. One number for every sprite in the game:
 * two objects of the same height with different shadows read as being lit by
 * different suns, which is the kind of wrongness a player feels without being
 * able to name.
 */
export const SHADOW_SLANT = 0.42;

/** A shadow's opacity over the deep background colour (§11). */
export const SHADOW_ALPHA = 0.28;

/**
 * How many chevron positions one belt animation cycle has. C13 task 8.
 *
 * The animation is a *discrete* phase baked into the sprite id rather than a
 * clock the atlas reads, because `SpriteAtlas.draw` takes no time and giving
 * it one would put a wall clock behind an interface whose whole purpose is
 * that C29 can swap the implementation. That is also what makes a baked image
 * atlas possible at all: a phase is a cell.
 */
export const BELT_CHEVRON_PHASES = 8;

/**
 * How high a belt's tread rides, in bulk units (2026-09-23). Items on a belt
 * sit on it, so the painter lifts them by the same amount.
 */
export const BELT_DECK = 0.12;

/** The top of a belt's side rails, in bulk units. */
export const BELT_RAIL_TOP = 0.4;

/**
 * How many arm positions one inserter swing is quantised to. C14 task 7.
 *
 * Not a cycle but a sweep from one end to the other, so there are
 * `STEPS + 1` positions and the value is clamped rather than wrapped.
 */
export const INSERTER_SWING_STEPS = 16;

/**
 * Frames in a machine's or the player's activity cycle (C29 art task 3).
 *
 * Frame 0 is **at rest** and frames 1 to 3 loop while the thing is working. A
 * machine's picture therefore says whether it is running, which is pillar 3
 * doing the work a status light would: a furnace whose mouth is dark has
 * stopped, and the inspector says why.
 */
export const ACTIVITY_FRAMES = 4;

/**
 * Below this zoom, animation and small details are dropped (C29 art task 4).
 *
 * At a quarter of a tile's full size a rivet is a fraction of a pixel and a
 * moving slat is shimmer. What survives is silhouette, colour and whether a
 * machine is lit — the three things a zoomed-out factory is read by.
 */
export const DETAIL_ZOOM = 0.5;

/**
 * Trace the ground face of a `width` x `height` footprint centred on `(sx, sy)`.
 *
 * Exported because the overlay layer outlines tiles with it: hover, selection
 * and the ghost all need the same shape, and a second copy of these four
 * vertices would be a second thing to get wrong.
 */
export function groundFacePath(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  width: number,
  height: number,
  zoom: number,
): void {
  const ax = EAST_STEP.x * zoom * width * 0.5;
  const ay = EAST_STEP.y * zoom * width * 0.5;
  const bx = SOUTH_STEP.x * zoom * height * 0.5;
  const by = SOUTH_STEP.y * zoom * height * 0.5;

  ctx.beginPath();
  ctx.moveTo(sx - ax - bx, sy - ay - by); // north-west
  ctx.lineTo(sx + ax - bx, sy + ay - by); // north-east
  ctx.lineTo(sx + ax + bx, sy + ay + by); // south-east
  ctx.lineTo(sx - ax + bx, sy - ay + by); // south-west
  ctx.closePath();
}
